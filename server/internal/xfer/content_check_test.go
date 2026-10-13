package xfer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncPipe runs one Send against one Receive over net.Pipe. When legacy is set,
// the receiver sees the Hello exactly as a relayium that predates content
// checking decodes it: JSON ignores the unknown fields, so ContentCheck and
// Preflight read false. Everything after the Hello is forwarded byte for byte; fileStarts is 1
// when the sender started any file body at all, 0 when it sent none.
type syncRun struct {
	send       Report
	recv       Report
	sendErr    error
	recvErr    error
	fileStarts int
}

func runSync(t *testing.T, srcRoot, dst string, legacy bool, sopts SendOpts, ropts RecvOpts) syncRun {
	t.Helper()
	m, srcs, err := BuildManifest([]string{srcRoot})
	if err != nil {
		t.Fatal(err)
	}
	return runSyncManifest(t, m, srcs, dst, legacy, sopts, ropts)
}

func runSyncManifest(t *testing.T, m Manifest, srcs []string, dst string, legacy bool, sopts SendOpts, ropts RecvOpts) syncRun {
	t.Helper()
	sendSide, proxyIn := net.Pipe()
	proxyOut, recvSide := net.Pipe()
	var out syncRun
	var mu sync.Mutex
	var wg sync.WaitGroup

	// Sender → receiver: rewrite the Hello for a legacy receiver, then parse
	// every frame so MsgFileStart can be counted, forwarding it unchanged.
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer proxyOut.Close()
		var hello Hello
		if _, err := ReadJSON(proxyIn, &hello); err != nil {
			return
		}
		if legacy {
			// What a receiver that predates these fields decodes: JSON drops
			// every field it does not know.
			hello.ContentCheck = false
			hello.Preflight = false
		}
		if err := WriteJSON(proxyOut, MsgHello, hello); err != nil {
			return
		}
		// The manifest, then the first frame after it: whether any file was
		// started at all is what the refusal tests need. File bodies are raw
		// bytes between frames, so everything after that is copied verbatim.
		for i := 0; i < 2; i++ {
			typ, payload, err := ReadFrame(proxyIn)
			if err != nil {
				return
			}
			if typ == MsgFileStart {
				mu.Lock()
				out.fileStarts++
				mu.Unlock()
			}
			if err := WriteFrame(proxyOut, typ, payload); err != nil {
				return
			}
		}
		_, _ = io.Copy(proxyOut, proxyIn)
	}()
	// Receiver → sender: plain copy.
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(proxyIn, proxyOut)
		proxyIn.Close()
	}()
	wg.Add(1)
	go func() {
		defer wg.Done()
		out.recv, out.recvErr = Receive(recvSide, dst, ropts)
		recvSide.Close()
	}()
	out.send, out.sendErr = Send(sendSide, m, srcs, sopts)
	sendSide.Close()
	wg.Wait()
	return out
}

func writeAt(t *testing.T, path, body string, mtime time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func readStr(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

var allowSync = RecvOpts{AllowSync: true}

// The defect: equal size, the same whole-second mtime, different bytes. A
// size+mtime receiver skips it and keeps the stale copy; a content-checked
// sync sends it.
func TestContentSyncSendsSameSizeSameSecondChange(t *testing.T) {
	sec := time.Unix(1_700_000_000, 0)
	for _, tc := range []struct {
		name          string
		srcMT, dstMT  time.Time
		legacy        bool
		wantDstAfter  string
		wantSkipped   int
		wantConfirmed bool
	}{
		// Same second, different sub-second times (the source was edited within
		// the second the destination was written).
		{"new receiver, same second", sec.Add(700 * time.Millisecond), sec.Add(100 * time.Millisecond), false, "NEW!", 0, true},
		// Exactly the same timestamp (cp -p / rsync -t / archive extraction).
		{"new receiver, identical mtime", sec, sec, false, "NEW!", 0, true},
		// The legacy rule, kept for an older receiver: skipped, stale copy stays.
		{"legacy receiver, identical mtime", sec, sec, true, "old!", 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src, dst := t.TempDir(), t.TempDir()
			writeAt(t, filepath.Join(src, "d", "f.txt"), "NEW!", tc.srcMT)
			writeAt(t, filepath.Join(dst, "d", "f.txt"), "old!", tc.dstMT)
			r := runSync(t, filepath.Join(src, "d"), dst, tc.legacy, SendOpts{Sync: true, ContentCheck: true}, allowSync)
			if r.sendErr != nil || r.recvErr != nil {
				t.Fatalf("send=%v recv=%v", r.sendErr, r.recvErr)
			}
			if got := readStr(t, filepath.Join(dst, "d", "f.txt")); got != tc.wantDstAfter {
				t.Fatalf("destination = %q, want %q", got, tc.wantDstAfter)
			}
			if r.send.Skipped != tc.wantSkipped {
				t.Fatalf("Skipped = %d, want %d", r.send.Skipped, tc.wantSkipped)
			}
			if r.send.ContentChecked != tc.wantConfirmed || r.send.ContentCheckUnconfirmed == tc.wantConfirmed {
				t.Fatalf("ContentChecked=%v Unconfirmed=%v, want confirmed=%v", r.send.ContentChecked, r.send.ContentCheckUnconfirmed, tc.wantConfirmed)
			}
		})
	}
}

// Genuinely identical files are still skipped -- even when their mtimes
// differ -- so the incremental benefit survives.
func TestContentSyncSkipsIdenticalContent(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeAt(t, filepath.Join(src, "d", "same.txt"), "identical", time.Unix(2_000_000_000, 0))
	writeAt(t, filepath.Join(src, "d", "changed.txt"), "AAAA", time.Unix(1_000, 0))
	writeAt(t, filepath.Join(dst, "d", "same.txt"), "identical", time.Unix(1_000, 0))
	writeAt(t, filepath.Join(dst, "d", "changed.txt"), "BBBB", time.Unix(1_000, 0))
	r := runSync(t, filepath.Join(src, "d"), dst, false, SendOpts{Sync: true, ContentCheck: true}, allowSync)
	if r.sendErr != nil || r.recvErr != nil {
		t.Fatalf("send=%v recv=%v", r.sendErr, r.recvErr)
	}
	if r.send.Skipped != 1 || r.send.Files != 1 || r.fileStarts != 1 {
		t.Fatalf("Skipped=%d Files=%d fileStarts=%d, want 1/1/1", r.send.Skipped, r.send.Files, r.fileStarts)
	}
	if got := readStr(t, filepath.Join(dst, "d", "changed.txt")); got != "AAAA" {
		t.Fatalf("changed.txt = %q", got)
	}
}

// --checksum against an older receiver refuses before any file body: no
// MsgFileStart reaches the wire and the destination is untouched.
func TestContentSyncRequiredRefusesLegacyReceiverBeforeAnyFile(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeAt(t, filepath.Join(src, "d", "a.txt"), "aaaa", time.Unix(5_000, 0))
	writeAt(t, filepath.Join(src, "d", "b.txt"), "new content", time.Unix(5_000, 0))
	writeAt(t, filepath.Join(dst, "d", "a.txt"), "zzzz", time.Unix(5_000, 0))
	r := runSync(t, filepath.Join(src, "d"), dst, true, SendOpts{Sync: true, RequireContentCheck: true}, allowSync)
	if !errors.Is(r.sendErr, ErrContentCheckUnsupported) {
		t.Fatalf("send error = %v, want ErrContentCheckUnsupported", r.sendErr)
	}
	if r.fileStarts != 0 {
		t.Fatalf("%d file(s) started before the refusal", r.fileStarts)
	}
	if got := readStr(t, filepath.Join(dst, "d", "a.txt")); got != "zzzz" {
		t.Fatalf("a.txt changed to %q", got)
	}
	if _, err := os.Stat(filepath.Join(dst, "d", "b.txt")); !os.IsNotExist(err) {
		t.Fatalf("b.txt was written: %v", err)
	}
}

// Default (not --checksum) against an older receiver: the transfer completes
// with the legacy rule and the report says content checking was not confirmed.
func TestContentSyncLegacyReceiverIsReportedUnconfirmed(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeAt(t, filepath.Join(src, "d", "a.txt"), "aaaa", time.Unix(5_000, 0))
	r := runSync(t, filepath.Join(src, "d"), dst, true, SendOpts{Sync: true, ContentCheck: true}, allowSync)
	if r.sendErr != nil || r.recvErr != nil {
		t.Fatalf("send=%v recv=%v", r.sendErr, r.recvErr)
	}
	if !r.send.ContentCheckUnconfirmed || r.send.ContentChecked {
		t.Fatalf("report %+v: want unconfirmed", r.send)
	}
}

func digestOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// The receiver installs a body only if it matches the MANIFEST digest. A sender
// whose source changed after the manifest was built streams the new bytes and
// hashes them consistently; the per-file hash alone would accept them.
func TestContentSyncReceiverRejectsBodyThatDiffersFromManifestDigest(t *testing.T) {
	dst := t.TempDir()
	writeAt(t, filepath.Join(dst, "f.txt"), "keep", time.Unix(1, 0))
	c1, c2 := net.Pipe()
	done := make(chan struct{})
	var rep Report
	var rerr error
	go func() {
		defer close(done)
		rep, rerr = Receive(c2, dst, allowSync)
		c2.Close()
	}()
	body := "BBBB"
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(WriteJSON(c1, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ResumeProof: true, ContentCheck: true}))
	must(WriteJSON(c1, MsgManifest, Manifest{Files: []FileEntry{{Path: "f.txt", Size: 4, Mode: 0o644, ModTime: 9, SHA256: digestOf("AAAA")}}}))
	var rs ResumeState
	_, err := ReadJSON(c1, &rs)
	must(err)
	if !rs.ContentCheck || len(rs.Skip) != 0 {
		t.Fatalf("resume state %+v", rs)
	}
	must(WriteJSON(c1, MsgFileStart, FileStart{Index: 0}))
	_, err = c1.Write([]byte(body))
	must(err)
	must(WriteJSON(c1, MsgFileHash, FileHash{Index: 0, SHA256: digestOf(body)}))
	var res Result
	_, err = ReadJSON(c1, &res)
	must(err)
	c1.Close()
	<-done
	if rerr != nil {
		t.Fatalf("receive: %v", rerr)
	}
	if res.OK || len(res.Failed) != 1 || len(rep.Failed) != 1 {
		t.Fatalf("result %+v rep %+v: the mismatching body must fail", res, rep)
	}
	if got := readStr(t, filepath.Join(dst, "f.txt")); got != "keep" {
		t.Fatalf("destination replaced with %q", got)
	}
	if left, _ := filepath.Glob(filepath.Join(dst, ".relayium-recv-*")); len(left) != 0 {
		t.Fatalf("staging left behind: %v", left)
	}
}

// A content-checked manifest with a missing or malformed digest is refused as
// a protocol error before anything is written.
func TestContentSyncRejectsMalformedDigest(t *testing.T) {
	for _, bad := range []string{"", "abc", strings.Repeat("A", 64), strings.Repeat("g", 64), strings.Repeat("a", 65)} {
		dst := t.TempDir()
		c1, c2 := net.Pipe()
		done := make(chan error, 1)
		go func() {
			_, err := Receive(c2, dst, allowSync)
			c2.Close()
			done <- err
		}()
		_ = WriteJSON(c1, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ContentCheck: true})
		_ = WriteJSON(c1, MsgManifest, Manifest{Files: []FileEntry{{Path: "f.txt", Size: 1, SHA256: bad}}})
		var we WireError
		typ, _ := ReadJSON(c1, &we)
		c1.Close()
		if err := <-done; err == nil {
			t.Fatalf("digest %q accepted", bad)
		}
		if typ != MsgError || we.Code != ErrCodeProtocol {
			t.Fatalf("digest %q: reply %v %+v, want protocol error", bad, typ, we)
		}
		if entries, _ := os.ReadDir(dst); len(entries) != 0 {
			t.Fatalf("digest %q: wrote %v", bad, entries)
		}
	}
}

// The digest comparison never reads through a symbolic link, so it cannot be
// used to test a file outside the receive directory, and a symlinked
// destination is never "already identical".
func TestContentSyncDoesNotHashThroughSymlinks(t *testing.T) {
	outside := t.TempDir()
	writeAt(t, filepath.Join(outside, "secret.txt"), "SECRET", time.Unix(1, 0))
	writeAt(t, filepath.Join(outside, "dir", "f.txt"), "SECRET", time.Unix(1, 0))
	dst := t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(dst, "f.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "dir"), filepath.Join(dst, "dir")); err != nil {
		t.Fatal(err)
	}
	m := Manifest{Files: []FileEntry{
		{Path: "f.txt", Size: 6, SHA256: digestOf("SECRET")},
		{Path: "dir/f.txt", Size: 6, SHA256: digestOf("SECRET")},
	}}
	rs := contentSyncStateFor(dst, m)
	if len(rs.Skip) != 0 {
		t.Fatalf("a symlinked destination was treated as identical: %+v", rs)
	}
}

// Delete scope and authorization are unchanged by content checking, and a
// content-checking sender learns the delete outcome; an older-protocol report
// path marks it unknown instead of implying success.
func TestContentSyncDeleteScopeAndOutcome(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeAt(t, filepath.Join(src, "site", "keep.txt"), "k", time.Unix(1, 0))
	writeAt(t, filepath.Join(dst, "site", "keep.txt"), "k", time.Unix(1, 0))
	writeAt(t, filepath.Join(dst, "site", "stale.txt"), "s", time.Unix(1, 0))
	writeAt(t, filepath.Join(dst, "sibling.txt"), "x", time.Unix(1, 0))

	// Not authorized: denied, nothing deleted.
	r := runSync(t, filepath.Join(src, "site"), dst, false, SendOpts{Sync: true, Delete: true, ContentCheck: true}, allowSync)
	if r.sendErr != nil || !r.send.DeleteDenied {
		t.Fatalf("unauthorized delete: err=%v rep=%+v", r.sendErr, r.send)
	}
	if _, err := os.Stat(filepath.Join(dst, "site", "stale.txt")); err != nil {
		t.Fatal("stale.txt deleted without --allow-delete")
	}

	// Authorized: stale removed, sibling untouched, outcome confirmed.
	r = runSync(t, filepath.Join(src, "site"), dst, false, SendOpts{Sync: true, Delete: true, ContentCheck: true}, RecvOpts{AllowSync: true, AllowDelete: true})
	if r.sendErr != nil || r.send.DeleteDenied || r.send.DeleteRefused || r.send.DeletePartialRemote || r.send.DeleteOutcomeUnknown {
		t.Fatalf("authorized delete: err=%v rep=%+v", r.sendErr, r.send)
	}
	if _, err := os.Stat(filepath.Join(dst, "site", "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("stale.txt survived an authorized mirror")
	}
	if _, err := os.Stat(filepath.Join(dst, "sibling.txt")); err != nil {
		t.Fatal("a sibling outside the mirrored root was deleted")
	}

	// A legacy receiver cannot report refused/partial deletes: unknown.
	r = runSync(t, filepath.Join(src, "site"), dst, true, SendOpts{Sync: true, Delete: true, ContentCheck: true}, RecvOpts{AllowSync: true, AllowDelete: true})
	if r.sendErr != nil || !r.send.DeleteOutcomeUnknown {
		t.Fatalf("legacy delete outcome: err=%v rep=%+v", r.sendErr, r.send)
	}
}

// A sender without content checking still produces the exact legacy Hello and
// manifest (no new fields), and the new receiver uses the legacy rule for it.
func TestLegacySenderUnchangedOnTheWire(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeAt(t, filepath.Join(src, "d", "f.txt"), "NEW!", time.Unix(7_000, 0))
	writeAt(t, filepath.Join(dst, "d", "f.txt"), "old!", time.Unix(7_000, 0))
	m, srcs, err := BuildManifest([]string{filepath.Join(src, "d")})
	if err != nil {
		t.Fatal(err)
	}
	c1, c2 := net.Pipe()
	var frames [][]byte
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 2; i++ {
			_, payload, err := ReadFrame(c2)
			if err != nil {
				return
			}
			frames = append(frames, payload)
		}
		c2.Close()
	}()
	_, _ = Send(c1, m, srcs, SendOpts{Sync: true})
	c1.Close()
	<-done
	if len(frames) != 2 {
		t.Fatalf("captured %d frames", len(frames))
	}
	for _, f := range frames {
		if strings.Contains(string(f), "ContentCheck") || strings.Contains(string(f), "SHA256") {
			t.Fatalf("a non-content-checked sync put a new field on the wire: %s", f)
		}
	}
	r := runSync(t, filepath.Join(src, "d"), dst, false, SendOpts{Sync: true}, allowSync)
	if r.sendErr != nil || r.send.Skipped != 1 || r.send.ContentChecked || r.send.ContentCheckUnconfirmed {
		t.Fatalf("legacy sender against new receiver: err=%v rep=%+v", r.sendErr, r.send)
	}
}

// A source shorter than its manifest entry is caught while digests are
// computed, before anything is sent.
func TestContentDigestRefusesShrunkSource(t *testing.T) {
	src := t.TempDir()
	p := filepath.Join(src, "f.txt")
	writeAt(t, p, "12345", time.Unix(1, 0))
	m := Manifest{Files: []FileEntry{{Path: "f.txt", Size: 9}}}
	if _, err := withContentDigests(m, []string{p}); err == nil || !strings.Contains(err.Error(), "changed while preparing") {
		t.Fatalf("err = %v", err)
	}
}

// A permitted delete that the receiver refuses, or that stops part-way, is
// reported to a content-checking sender (no receiver text), and strict delete
// refuses a legacy receiver before any file body.
func TestContentSyncDeleteRefusedPartialAndStrictLegacy(t *testing.T) {
	allowAll := RecvOpts{AllowSync: true, AllowDelete: true}

	// Refused: an empty manifest with --delete (a peer bypassing the CLI's
	// own empty-source guard). Nothing is deleted, and the sender is told.
	dst := t.TempDir()
	writeAt(t, filepath.Join(dst, "keep.txt"), "k", time.Unix(1, 0))
	r := runSyncManifest(t, Manifest{}, nil, dst, false, SendOpts{Sync: true, Delete: true, ContentCheck: true}, allowAll)
	if r.sendErr != nil || !r.send.DeleteRefused || r.send.DeleteOutcomeUnknown {
		t.Fatalf("refused delete: err=%v rep=%+v", r.sendErr, r.send)
	}
	if _, err := os.Stat(filepath.Join(dst, "keep.txt")); err != nil {
		t.Fatal("a refused delete removed a file")
	}

	// Partial: the first stale file goes, the second sits in a directory this
	// user cannot write.
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions; partial-delete fixture needs a non-root user")
	}
	src, dst := t.TempDir(), t.TempDir()
	writeAt(t, filepath.Join(src, "site", "keep.txt"), "k", time.Unix(1, 0))
	writeAt(t, filepath.Join(dst, "site", "keep.txt"), "k", time.Unix(1, 0))
	writeAt(t, filepath.Join(dst, "site", "a-stale.txt"), "s", time.Unix(1, 0))
	writeAt(t, filepath.Join(dst, "site", "zz", "locked.txt"), "s", time.Unix(1, 0))
	if err := os.Chmod(filepath.Join(dst, "site", "zz"), 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(dst, "site", "zz"), 0o700) })
	r = runSync(t, filepath.Join(src, "site"), dst, false, SendOpts{Sync: true, Delete: true, ContentCheck: true}, allowAll)
	if r.sendErr != nil || !r.send.DeletePartialRemote {
		t.Fatalf("partial delete: err=%v rep=%+v recv=%+v", r.sendErr, r.send, r.recv)
	}

	// Strict delete against a legacy receiver: refused before any file body.
	writeAt(t, filepath.Join(src, "site", "new.txt"), "n", time.Unix(1, 0))
	r = runSync(t, filepath.Join(src, "site"), dst, true, SendOpts{Sync: true, Delete: true, ContentCheck: true, RequireDeleteReport: true}, allowAll)
	if !errors.Is(r.sendErr, ErrDeleteReportUnsupported) || r.fileStarts != 0 {
		t.Fatalf("strict legacy: err=%v fileStarts=%d", r.sendErr, r.fileStarts)
	}
	if _, err := os.Stat(filepath.Join(dst, "site", "new.txt")); !os.IsNotExist(err) {
		t.Fatal("a file was installed after the strict-delete refusal")
	}
}

// A cancelled context stops digesting before the next file and within the
// current one, returning the context's error and no manifest.
func TestContentDigestsHonourCancellation(t *testing.T) {
	src := t.TempDir()
	big := filepath.Join(src, "big.bin")
	if err := os.WriteFile(big, make([]byte, 4<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := BuildManifest([]string{big})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := WithContentDigestsContext(ctx, m, srcs); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if _, err := WithContentDigestsContext(context.Background(), m, srcs); err != nil {
		t.Fatalf("uncancelled: %v", err)
	}
}

// B2 (Root R2 probe): an older receiver that needs NO file runs its delete step
// without waiting for the sender. A strict request therefore asks first with a
// preflight that deletes nothing; the old receiver's stale file must survive.
func TestStrictPreflightLegacyAllSkippedDeletesNothing(t *testing.T) {
	for _, opts := range []SendOpts{
		{Sync: true, Delete: true, ContentCheck: true, RequireDeleteReport: true},
		{Sync: true, Delete: true, ContentCheck: true, RequireContentCheck: true},
	} {
		src, dst := t.TempDir(), t.TempDir()
		tm := time.Unix(1_700_000_000, 0)
		writeAt(t, filepath.Join(src, "tree", "keep.txt"), "same", tm)
		writeAt(t, filepath.Join(dst, "tree", "keep.txt"), "same", tm)
		writeAt(t, filepath.Join(dst, "tree", "stale.txt"), "keep until capability confirmed", tm)
		r := runSync(t, filepath.Join(src, "tree"), dst, true, opts, RecvOpts{AllowSync: true, AllowDelete: true})
		if !errors.Is(r.sendErr, ErrDeleteReportUnsupported) && !errors.Is(r.sendErr, ErrContentCheckUnsupported) {
			t.Fatalf("opts %+v: err = %v, want an unsupported refusal", opts, r.sendErr)
		}
		if got := readStr(t, filepath.Join(dst, "tree", "stale.txt")); got != "keep until capability confirmed" {
			t.Fatalf("the legacy receiver lost the stale file: %q", got)
		}
		if r.fileStarts != 0 {
			t.Fatalf("a file started after the refusal")
		}
	}
}

// A current receiver answers the preflight and runs the real strict request
// on the same connection: the intended stale file goes, the sibling outside
// the mirrored root stays, and content checking is confirmed.
func TestStrictPreflightCurrentReceiverMirrors(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	tm := time.Unix(1_700_000_000, 0)
	writeAt(t, filepath.Join(src, "tree", "keep.txt"), "same", tm)
	writeAt(t, filepath.Join(src, "tree", "new.txt"), "fresh", tm)
	writeAt(t, filepath.Join(dst, "tree", "keep.txt"), "same", tm)
	writeAt(t, filepath.Join(dst, "tree", "stale.txt"), "s", tm)
	writeAt(t, filepath.Join(dst, "sibling.txt"), "x", tm)
	r := runSync(t, filepath.Join(src, "tree"), dst, false,
		SendOpts{Sync: true, Delete: true, ContentCheck: true, RequireContentCheck: true, RequireDeleteReport: true},
		RecvOpts{AllowSync: true, AllowDelete: true})
	if r.sendErr != nil || r.recvErr != nil {
		t.Fatalf("send=%v recv=%v", r.sendErr, r.recvErr)
	}
	if !r.send.ContentChecked || r.send.DeleteRefused || r.send.DeletePartialRemote || r.send.DeleteOutcomeUnknown || r.send.Skipped != 1 || r.send.Files != 1 {
		t.Fatalf("report %+v", r.send)
	}
	if _, err := os.Stat(filepath.Join(dst, "tree", "stale.txt")); !os.IsNotExist(err) {
		t.Fatal("stale.txt survived the strict mirror")
	}
	if readStr(t, filepath.Join(dst, "sibling.txt")) != "x" || readStr(t, filepath.Join(dst, "tree", "new.txt")) != "fresh" {
		t.Fatal("sibling lost or new file missing")
	}
	// Strict sync still respects the receiver's own authorization.
	writeAt(t, filepath.Join(dst, "tree", "stale2.txt"), "s", tm)
	r = runSync(t, filepath.Join(src, "tree"), dst, false,
		SendOpts{Sync: true, Delete: true, ContentCheck: true, RequireDeleteReport: true}, RecvOpts{AllowSync: true})
	if r.sendErr != nil || !r.send.DeleteDenied {
		t.Fatalf("unauthorized strict delete: err=%v rep=%+v", r.sendErr, r.send)
	}
	if _, err := os.Stat(filepath.Join(dst, "tree", "stale2.txt")); err != nil {
		t.Fatal("deleted without --allow-delete")
	}
}

// A preflight must ask nothing: one that carries Delete or files, or that is
// followed by another preflight or a stream, is refused with nothing written
// or deleted.
func TestStrictPreflightMalformedIsRefused(t *testing.T) {
	tm := time.Unix(1_700_000_000, 0)
	digest := digestOf("x")
	cases := map[string]func(c net.Conn){
		"delete in preflight": func(c net.Conn) {
			_ = WriteJSON(c, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ContentCheck: true, Preflight: true, Delete: true})
			_ = WriteJSON(c, MsgManifest, Manifest{})
		},
		"files in preflight": func(c net.Conn) {
			_ = WriteJSON(c, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ContentCheck: true, Preflight: true})
			_ = WriteJSON(c, MsgManifest, Manifest{Files: []FileEntry{{Path: "f.txt", Size: 1, SHA256: digest}}})
		},
		"no content check": func(c net.Conn) {
			_ = WriteJSON(c, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, Preflight: true})
			_ = WriteJSON(c, MsgManifest, Manifest{})
		},
		"nested preflight": func(c net.Conn) {
			_ = WriteJSON(c, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ContentCheck: true, Preflight: true})
			_ = WriteJSON(c, MsgManifest, Manifest{})
			var rs ResumeState
			_, _ = ReadJSON(c, &rs)
			_ = WriteJSON(c, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ContentCheck: true, Preflight: true, Delete: true})
		},
		"stream after preflight": func(c net.Conn) {
			_ = WriteJSON(c, MsgHello, Hello{Version: WireVersion, Mode: "push", Sync: true, ContentCheck: true, Preflight: true})
			_ = WriteJSON(c, MsgManifest, Manifest{})
			var rs ResumeState
			_, _ = ReadJSON(c, &rs)
			_ = WriteJSON(c, MsgHello, Hello{Version: WireVersion, Mode: "push", Stream: true})
		},
	}
	for name, script := range cases {
		t.Run(name, func(t *testing.T) {
			dst := t.TempDir()
			writeAt(t, filepath.Join(dst, "stale.txt"), "s", tm)
			c1, c2 := net.Pipe()
			done := make(chan error, 1)
			go func() {
				_, err := Receive(c2, dst, RecvOpts{AllowSync: true, AllowDelete: true})
				c2.Close()
				done <- err
			}()
			go func() {
				script(c1)
				// Drain whatever the receiver says until it closes.
				_, _ = io.Copy(io.Discard, c1)
			}()
			err := <-done
			c1.Close()
			if err == nil || !strings.Contains(err.Error(), "preflight") {
				t.Fatalf("err = %v, want a preflight protocol refusal", err)
			}
			entries, _ := os.ReadDir(dst)
			if len(entries) != 1 || readStr(t, filepath.Join(dst, "stale.txt")) != "s" {
				t.Fatalf("the receive directory changed: %v", entries)
			}
		})
	}
}

// Non-strict syncs never send a preflight: their frames are unchanged.
func TestNonStrictSyncSendsNoPreflight(t *testing.T) {
	src := t.TempDir()
	writeAt(t, filepath.Join(src, "d", "f.txt"), "x", time.Unix(1, 0))
	m, srcs, err := BuildManifest([]string{filepath.Join(src, "d")})
	if err != nil {
		t.Fatal(err)
	}
	for _, opts := range []SendOpts{{Sync: true}, {Sync: true, ContentCheck: true}, {Sync: true, Delete: true, ContentCheck: true}} {
		c1, c2 := net.Pipe()
		var first []byte
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, first, _ = ReadFrame(c2)
			c2.Close()
		}()
		_, _ = Send(c1, m, srcs, opts)
		c1.Close()
		<-done
		if strings.Contains(string(first), "Preflight") {
			t.Fatalf("opts %+v sent a preflight: %s", opts, first)
		}
	}
}
