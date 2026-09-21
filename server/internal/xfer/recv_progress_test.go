package xfer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// RecvOpts.Progress is pinned here against a real Send on a real pipe, because
// the CLI's reporter is only correct for the way Receive actually calls it.

type recvCall struct {
	path            string
	received, total int64
}

func recordRecv(got *[]recvCall) func(string, int64, int64) {
	return func(p string, received, total int64) {
		*got = append(*got, recvCall{p, received, total})
	}
}

// recvStep is the size of one body read in these tests. The contract does not
// promise chunk sizes — they are the transport's. Over net.Pipe (synchronous:
// a Read gets what it asks for while the peer's Write still has bytes) they are
// io.CopyN's 32 KiB buffer, and Send's 192 KiB writes are a whole multiple of
// it, which is what makes an exact sequence assertable at all.
const recvStep = 32 << 10

// steps is the cumulative sequence for one file: from start, in recvStep reads,
// the last one landing exactly on total.
func steps(path string, start, total int64) []recvCall {
	var out []recvCall
	for at := start; at < total; {
		at += recvStep
		if at > total {
			at = total
		}
		out = append(out, recvCall{path, at, total})
	}
	return out
}

func pattern(n int) []byte {
	return bytes.Repeat([]byte("relayium"), n/8+1)[:n]
}

func TestReceiveReportsProgressPerChunkAndNeverForAnEmptyFile(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tree")
	big := pattern(500000) // three 192 KiB sender chunks, sixteen receiver reads
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string][]byte{"a.txt": []byte("hello"), "big.bin": big, "empty": nil} {
		if err := os.WriteFile(filepath.Join(root, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m, srcs, err := BuildManifest([]string{root}) // lexical: a.txt, big.bin, empty
	if err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()

	var got []recvCall
	rep, _, serr, rerr := pipeTransfer(t, m, srcs, dst, SendOpts{}, RecvOpts{Progress: recordRecv(&got)})
	if serr != nil || rerr != nil {
		t.Fatalf("send: %v, receive: %v", serr, rerr)
	}
	if rep.Files != 3 || rep.Bytes != 500005 || len(rep.Failed) != 0 {
		t.Fatalf("report = %+v", rep)
	}

	want := []recvCall{{"tree/a.txt", 5, 5}}
	want = append(want, steps("tree/big.bin", 0, 500000)...)
	// "tree/empty" is received and installed, and never reported.
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Progress calls = %v\nwant %v", got, want)
	}
	if n := len(steps("tree/big.bin", 0, 500000)); n != 16 {
		t.Fatalf("fixture drifted: big.bin is %d reads, want 16", n)
	}
	if body, _ := os.ReadFile(filepath.Join(dst, "tree", "big.bin")); !bytes.Equal(body, big) {
		t.Fatalf("big.bin arrived as %d bytes, want %d", len(body), len(big))
	}
	if info, err := os.Stat(filepath.Join(dst, "tree", "empty")); err != nil || info.Size() != 0 {
		t.Fatalf("the empty file did not land: %v", err)
	}
}

// Sync mode is where the receive loop stops being "every file from 0": one file
// is skipped, one resumes from a genuine prefix, one has a same-length head that
// is NOT a prefix and is taken whole.
func TestReceiveProgressStartsAtTheOffsetActuallyUsed(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tree")
	resumed := pattern(300000)
	restarted := pattern(300000)
	writeFileMtime(t, filepath.Join(root, "1-same.txt"), "unchanged", 1000)
	for name, body := range map[string][]byte{"2-resumed.bin": resumed, "3-restarted.bin": restarted} {
		if err := os.WriteFile(filepath.Join(root, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m, srcs, err := BuildManifest([]string{root})
	if err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	writeFileMtime(t, filepath.Join(dst, "tree", "1-same.txt"), "unchanged", 1000)
	if err := os.WriteFile(filepath.Join(dst, "tree", "2-resumed.bin"), resumed[:100000], 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, "tree", "3-restarted.bin"), bytes.Repeat([]byte{'X'}, 100000), 0o600); err != nil {
		t.Fatal(err)
	}

	var got []recvCall
	rep, sent, serr, rerr := pipeTransfer(t, m, srcs, dst, SendOpts{Sync: true}, RecvOpts{AllowSync: true, Progress: recordRecv(&got)})
	if serr != nil || rerr != nil {
		t.Fatalf("send: %v, receive: %v", serr, rerr)
	}
	if rep.Files != 2 || len(rep.Failed) != 0 {
		t.Fatalf("report = %+v", rep)
	}
	// The premise, proven on the wire: 200000 resumed + 300000 restarted body
	// bytes, not 600000.
	if sent < 500000 || sent >= 600000 {
		t.Fatalf("sender put %d bytes on the wire; the resume this test depends on did not happen", sent)
	}

	var want []recvCall
	want = append(want, steps("tree/2-resumed.bin", 100000, 300000)...)
	want = append(want, steps("tree/3-restarted.bin", 0, 300000)...)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Progress calls = %v\nwant %v", got, want)
	}
	if got[0] != (recvCall{"tree/2-resumed.bin", 100000 + recvStep, 300000}) {
		t.Fatalf("first call = %v, want the first read counted from the offset", got[0])
	}
	for name, body := range map[string][]byte{"2-resumed.bin": resumed, "3-restarted.bin": restarted} {
		if onDisk, _ := os.ReadFile(filepath.Join(dst, "tree", name)); !bytes.Equal(onDisk, body) {
			t.Fatalf("%s is wrong on disk after the transfer", name)
		}
	}
}

// scriptedTransfer is a complete, fixed sender byte stream for the given files.
// hashOf lets a case lie about one file's digest.
func scriptedTransfer(t *testing.T, files []FileEntry, bodies [][]byte, hashOf func(i int, body []byte) string) []byte {
	t.Helper()
	var raw bytes.Buffer
	mustWrite(t, &raw, MsgHello, Hello{Version: WireVersion, Mode: "push"})
	mustWrite(t, &raw, MsgManifest, Manifest{Files: files})
	for i, body := range bodies {
		mustWrite(t, &raw, MsgFileStart, FileStart{Index: i})
		raw.Write(body)
		mustWrite(t, &raw, MsgFileHash, FileHash{Index: i, SHA256: hashOf(i, body)})
	}
	return raw.Bytes()
}

func trueHash(_ int, body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// snapshot is everything a receive leaves under dir: path → mode and content.
func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		if rel == "." {
			return nil
		}
		if info.IsDir() {
			out[rel] = info.Mode().String()
			return nil
		}
		body, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[rel] = info.Mode().String() + " " + string(body)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// The hook observes; it must not be able to change anything. Feed the identical
// sender byte stream to a receiver with and without it: every byte the receiver
// puts back on the wire, its Report and everything it leaves on disk must match.
func TestReceiveProgressChangesNothingTheReceiverDoes(t *testing.T) {
	files := []FileEntry{
		{Path: "a.txt", Size: 5, Mode: 0o640},
		{Path: "dir/big.bin", Size: 100000, Mode: 0o600},
		{Path: "empty", Size: 0, Mode: 0o644},
	}
	bodies := [][]byte{[]byte("hello"), pattern(100000), nil}
	stream := scriptedTransfer(t, files, bodies, trueHash)

	run := func(opts RecvOpts) (Report, []byte, map[string]string) {
		dir := t.TempDir()
		peer := &scriptedPeer{Reader: bytes.NewReader(stream)}
		rep, err := Receive(peer, dir, opts)
		if err != nil {
			t.Fatalf("receive: %v", err)
		}
		if left := stagingFiles(t, dir); len(left) != 0 {
			t.Fatalf("staging left behind: %v", left)
		}
		return rep, peer.out.Bytes(), snapshot(t, dir)
	}

	var calls []recvCall
	plainRep, plainWire, plainDisk := run(RecvOpts{})
	hookRep, hookWire, hookDisk := run(RecvOpts{Progress: recordRecv(&calls)})

	if len(calls) == 0 {
		t.Fatal("the hook was never called, so this compared nothing")
	}
	if !reflect.DeepEqual(plainRep, hookRep) {
		t.Errorf("Report differs: %+v vs %+v", plainRep, hookRep)
	}
	if !bytes.Equal(plainWire, hookWire) {
		t.Errorf("the receiver's own wire output differs:\n%q\n%q", plainWire, hookWire)
	}
	if !reflect.DeepEqual(plainDisk, hookDisk) {
		t.Errorf("what landed on disk differs:\n%v\n%v", plainDisk, hookDisk)
	}
	if plainRep.Files != 3 || len(plainDisk) != 4 { // three files and "dir"
		t.Errorf("fixture did not land as expected: %+v, %d entries", plainRep, len(plainDisk))
	}
}

// received == total is reported when the last body byte is accepted, which is
// BEFORE verification. A reporter must not read it as "installed": the file
// below fails its hash, is reported in full, and is not on disk.
func TestReceiveProgressCompletesBeforeVerificationNotAfter(t *testing.T) {
	files := []FileEntry{{Path: "bad.bin", Size: 6, Mode: 0o644}, {Path: "good.bin", Size: 4, Mode: 0o644}}
	bodies := [][]byte{[]byte("secret"), []byte("fine")}
	stream := scriptedTransfer(t, files, bodies, func(i int, body []byte) string {
		if i == 0 {
			return strings.Repeat("0", 64)
		}
		return trueHash(i, body)
	})

	dir := t.TempDir()
	var got []recvCall
	rep, err := Receive(&scriptedPeer{Reader: bytes.NewReader(stream)}, dir, RecvOpts{Progress: recordRecv(&got)})
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if want := []recvCall{{"bad.bin", 6, 6}, {"good.bin", 4, 4}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Progress calls = %v\nwant %v", got, want)
	}
	if !reflect.DeepEqual(rep.Failed, []string{"bad.bin"}) || rep.Files != 1 {
		t.Fatalf("report = %+v, want bad.bin failed and good.bin received", rep)
	}
	if _, err := os.Lstat(filepath.Join(dir, "bad.bin")); !os.IsNotExist(err) {
		t.Fatalf("a file that failed verification is on disk (err=%v)", err)
	}
	if left := stagingFiles(t, dir); len(left) != 0 {
		t.Fatalf("staging left behind: %v", left)
	}
}

// A body cut short reports only what arrived and never claims the file.
func TestReceiveProgressStopsWhereTheBodyStops(t *testing.T) {
	var raw bytes.Buffer
	mustWrite(t, &raw, MsgHello, Hello{Version: WireVersion, Mode: "push"})
	mustWrite(t, &raw, MsgManifest, Manifest{Files: []FileEntry{{Path: "cut.bin", Size: 100000, Mode: 0o644}}})
	mustWrite(t, &raw, MsgFileStart, FileStart{})
	raw.Write(pattern(40000))

	dir := t.TempDir()
	var got []recvCall
	_, err := Receive(&scriptedPeer{Reader: bytes.NewReader(raw.Bytes())}, dir, RecvOpts{Progress: recordRecv(&got)})
	if err == nil {
		t.Fatal("expected the truncated body to fail the transfer")
	}
	if want := []recvCall{{"cut.bin", recvStep, 100000}, {"cut.bin", 40000, 100000}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Progress calls = %v\nwant %v", got, want)
	}
	if left := stagingFiles(t, dir); len(left) != 0 {
		t.Fatalf("staging left behind: %v", left)
	}
}
