package xfer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// recvHarness drives ReceiveStream over net.Pipe (which has real deadlines)
// as a scripted sender.
type recvHarness struct {
	t   *testing.T
	c   net.Conn
	dir string
	res chan recvResult
}

func startRecv(t *testing.T, dir, leaf string, o StreamRecvOpts) *recvHarness {
	t.Helper()
	a, b := net.Pipe()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	h := &recvHarness{t: t, c: a, dir: dir, res: make(chan recvResult, 1)}
	go func() {
		defer root.Close()
		defer b.Close()
		rep, err := ReceiveStream(b, StreamTarget{Parent: root, Leaf: leaf}, o)
		h.res <- recvResult{rep, err}
	}()
	t.Cleanup(func() { a.Close() })
	return h
}

func (h *recvHarness) send(t MsgType, v any) error {
	var payload []byte
	switch p := v.(type) {
	case []byte:
		payload = p
	default:
		payload, _ = json.Marshal(v)
	}
	_ = h.c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := h.c.Write(appendFrame(nil, t, payload))
	return err
}

func (h *recvHarness) hello() { h.send(MsgHello, Hello{Version: 1, Mode: "push", Stream: true}) }
func (h *recvHarness) manifest(n string) {
	h.send(MsgManifest, Manifest{Files: []FileEntry{{Path: n, Size: -1}}})
}

// readType reads only the first byte of the receiver's next frame. With
// net.Pipe the receiver's single Write of that frame is still in progress
// until the rest is read, so whatever the test observes now happened BEFORE
// the receiver sent the frame.
func (h *recvHarness) readType() (MsgType, error) {
	var b [1]byte
	_ = h.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(h.c, b[:]); err != nil {
		return 0, err
	}
	return MsgType(b[0]), nil
}

// readRest reads the remainder of a frame whose type byte was read.
func (h *recvHarness) readRest() []byte {
	var l [4]byte
	_ = h.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(h.c, l[:]); err != nil {
		h.t.Fatalf("frame length: %v", err)
	}
	p := make([]byte, int(l[0])<<24|int(l[1])<<16|int(l[2])<<8|int(l[3]))
	if _, err := io.ReadFull(h.c, p); err != nil {
		h.t.Fatalf("frame payload: %v", err)
	}
	return p
}

func (h *recvHarness) expect(want MsgType) []byte {
	h.t.Helper()
	typ, err := h.readType()
	if err != nil {
		h.t.Fatalf("reading for type %d: %v", want, err)
	}
	p := h.readRest()
	if typ != want {
		h.t.Fatalf("got type %d (%s), want %d", typ, p, want)
	}
	return p
}

// expectRefusal reads a MsgError, asserting at the moment its first byte
// arrives (the receiver still inside its Write) that no staging exists.
func (h *recvHarness) expectRefusal(code string) WireError {
	h.t.Helper()
	typ, err := h.readType()
	if err != nil {
		h.t.Fatalf("reading the refusal: %v", err)
	}
	if typ != MsgError {
		h.t.Fatalf("got type %d (%s), want MsgError %s", typ, h.readRest(), code)
	}
	assertNoStaging(h.t, h.dir) // cleanup preceded the frame
	var we WireError
	if err := json.Unmarshal(h.readRest(), &we); err != nil || we.Code != code {
		h.t.Fatalf("refusal %+v (%v), want code %s", we, err, code)
	}
	return we
}

func (h *recvHarness) done() recvResult {
	h.t.Helper()
	select {
	case r := <-h.res:
		return r
	case <-time.After(10 * time.Second):
		h.t.Fatal("ReceiveStream did not return")
		return recvResult{}
	}
}

func (h *recvHarness) stagingDirs() []string {
	var s []string
	for _, n := range listDir(h.t, h.dir) {
		if strings.HasPrefix(n, stagePrefix) {
			s = append(s, n)
		}
	}
	return s
}

func endFor(data []byte) StreamEnd {
	return StreamEnd{Size: int64(len(data)), SHA256: sha256Hex(data), Challenge: newStreamChallenge()}
}

// U-R1: every refusal before Accept creates nothing (the directory listing
// is compared, not inferred), and no StreamAccept is sent.
func TestStreamRecvRefusesBeforeAccept(t *testing.T) {
	type setup func(t *testing.T, dir string)
	file := func(t *testing.T, dir string) { os.WriteFile(filepath.Join(dir, "out.bin"), []byte("keep"), 0o600) }
	subdir := func(t *testing.T, dir string) { os.Mkdir(filepath.Join(dir, "out.bin"), 0o700) }
	link := func(target string) setup {
		return func(t *testing.T, dir string) {
			if err := os.Symlink(target, filepath.Join(dir, "out.bin")); err != nil {
				t.Skipf("symlinks unavailable here: %v", err)
			}
		}
	}
	cases := []struct {
		name     string
		setup    setup
		hello    Hello
		manifest Manifest
		code     string
	}{
		{"dest file", file, Hello{}, Manifest{}, ErrCodeDestinationExists},
		{"dest dir", subdir, Hello{}, Manifest{}, ErrCodeDestinationExists},
		{"dest symlink", link("elsewhere-that-exists"), Hello{}, Manifest{}, ErrCodeDestinationExists},
		{"dest dangling symlink", link("missing-target"), Hello{}, Manifest{}, ErrCodeDestinationExists},
		{"name mismatch", nil, Hello{}, Manifest{Files: []FileEntry{{Path: "other.bin", Size: -1}}}, ErrCodeProtocol},
		{"known size", nil, Hello{}, Manifest{Files: []FileEntry{{Path: "out.bin", Size: 5}}}, ErrCodeProtocol},
		{"mode set", nil, Hello{}, Manifest{Files: []FileEntry{{Path: "out.bin", Size: -1, Mode: 0o644}}}, ErrCodeProtocol},
		{"mtime set", nil, Hello{}, Manifest{Files: []FileEntry{{Path: "out.bin", Size: -1, ModTime: 1}}}, ErrCodeProtocol},
		{"two entries", nil, Hello{}, Manifest{Files: []FileEntry{{Path: "out.bin", Size: -1}, {Path: "b", Size: -1}}}, ErrCodeProtocol},
		{"no entries", nil, Hello{}, Manifest{Files: []FileEntry{}}, ErrCodeProtocol},
		{"sync", nil, Hello{Version: 1, Mode: "push", Stream: true, Sync: true}, Manifest{}, ErrCodeStreamNotAccepted},
		{"delete", nil, Hello{Version: 1, Mode: "push", Stream: true, Delete: true}, Manifest{}, ErrCodeStreamNotAccepted},
		{"resume proof", nil, Hello{Version: 1, Mode: "push", Stream: true, ResumeProof: true}, Manifest{}, ErrCodeStreamNotAccepted},
		{"v1 hello", nil, Hello{Version: 1, Mode: "push"}, Manifest{}, ErrCodeStreamNotAccepted},
		{"version 2", nil, Hello{Version: 2, Mode: "push", Stream: true}, Manifest{}, ErrCodeStreamNotAccepted},
		{"pull", nil, Hello{Version: 1, Mode: "pull", Stream: true}, Manifest{}, ErrCodeStreamNotAccepted},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "elsewhere-that-exists"), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			if c.setup != nil {
				c.setup(t, dir)
			}
			before := listDir(t, dir)
			h := startRecv(t, dir, "out.bin", StreamRecvOpts{})
			hello := c.hello
			if hello == (Hello{}) {
				hello = Hello{Version: 1, Mode: "push", Stream: true}
			}
			h.send(MsgHello, hello)
			if c.code != ErrCodeStreamNotAccepted {
				m := c.manifest
				if m.Files == nil {
					m = Manifest{Files: []FileEntry{{Path: "out.bin", Size: -1}}}
				}
				h.send(MsgManifest, m)
			}
			h.expectRefusal(c.code)
			if r := h.done(); r.err == nil || r.rep.Installed {
				t.Fatalf("receiver %+v %v", r.rep, r.err)
			}
			if after := listDir(t, dir); fmt.Sprint(after) != fmt.Sprint(before) {
				t.Fatalf("directory changed: %v -> %v", before, after)
			}
			if c.setup != nil && c.name == "dest file" {
				if b, _ := os.ReadFile(filepath.Join(dir, "out.bin")); string(b) != "keep" {
					t.Fatalf("existing file now %q", b)
				}
			}
		})
	}
	t.Run("no parent", func(t *testing.T) {
		a, b := net.Pipe()
		defer a.Close()
		go func() {
			_ = WriteJSON(a, MsgHello, Hello{Version: 1, Mode: "push", Stream: true})
			_ = WriteJSON(a, MsgManifest, Manifest{Files: []FileEntry{{Path: "x", Size: -1}}})
		}()
		errc := make(chan error, 1)
		go func() { _, err := ReceiveStream(b, StreamTarget{Leaf: "x"}, StreamRecvOpts{}); errc <- err }()
		var we WireError
		if typ, err := ReadJSON(a, &we); err != nil || typ != MsgError || we.Code != ErrCodeInvalidDestination {
			t.Fatalf("%v %+v %v", typ, we, err)
		}
		<-errc
	})
	t.Run("bad leaf", func(t *testing.T) {
		for _, leaf := range []string{"", ".", "..", "a/b", `a\b`, "a\x00b", stagePrefix + "x"} {
			dir := t.TempDir()
			h := startRecv(t, dir, leaf, StreamRecvOpts{})
			h.hello()
			h.manifest(leaf)
			h.expectRefusal(ErrCodeInvalidDestination)
			h.done()
			if l := listDir(t, dir); len(l) != 0 {
				t.Fatalf("leaf %q: created %v", leaf, l)
			}
		}
	})
}

// acceptedRecv returns a harness past StreamAccept.
func acceptedRecv(t *testing.T, dir, leaf string, o StreamRecvOpts) *recvHarness {
	t.Helper()
	h := startRecv(t, dir, leaf, o)
	h.hello()
	h.manifest(leaf)
	var acc StreamAccept
	if err := json.Unmarshal(h.expect(MsgStreamAccept), &acc); err != nil || acc.ChunkMax != StreamChunkMax {
		t.Fatalf("accept %+v %v", acc, err)
	}
	if s := h.stagingDirs(); len(s) != 1 {
		t.Fatalf("after accept: staging %v, want exactly one", s)
	}
	return h
}

// U-R2: a stream that does not end verified installs nothing and leaves no
// staging.
func TestStreamRecvIncompleteInstallsNothing(t *testing.T) {
	data := []byte("some bytes")
	cases := []struct {
		name string
		play func(h *recvHarness)
		code string // "" means the sender is gone: nothing is sent
	}{
		{"eof before end", func(h *recvHarness) { h.send(MsgStreamData, data); h.c.Close() }, ""},
		{"eof inside chunk", func(h *recvHarness) {
			b := frameBytes(MsgStreamData, data)
			h.c.Write(b[:len(b)-3])
			h.c.Close()
		}, ""},
		{"wrong size", func(h *recvHarness) {
			h.send(MsgStreamData, data)
			e := endFor(data)
			e.Size++
			h.send(MsgStreamEnd, e)
		}, ErrCodeProtocol},
		{"wrong hash", func(h *recvHarness) {
			h.send(MsgStreamData, data)
			e := endFor(data)
			e.SHA256 = sha256Hex([]byte("other"))
			h.send(MsgStreamEnd, e)
		}, ErrCodeProtocol},
		{"oversize chunk", func(h *recvHarness) {
			hdr := frameBytes(MsgStreamData, nil)
			hdr[1], hdr[2], hdr[3], hdr[4] = 0, 0x10, 0, 1 // StreamChunkMax+1
			h.c.Write(hdr)
		}, ErrCodeProtocol},
		{"unknown type", func(h *recvHarness) { h.send(MsgType(99), []byte("{}")) }, ErrCodeProtocol},
		{"v1 file start", func(h *recvHarness) { h.send(MsgFileStart, FileStart{}) }, ErrCodeProtocol},
		{"sender error", func(h *recvHarness) { h.send(MsgError, WireError{Code: "x", Msg: "sender gave up"}) }, ErrCodeProtocol},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{})
			go c.play(h)
			if c.code != "" {
				h.expectRefusal(c.code)
				h.c.Close()
			}
			r := h.done()
			if r.err == nil || r.rep.Installed {
				t.Fatalf("receiver %+v %v", r.rep, r.err)
			}
			if l := listDir(t, dir); len(l) != 0 {
				t.Fatalf("left behind %v", l)
			}
		})
	}
}

// U-R3: a destination planted between Accept and End is never replaced: the
// install fails with destination_exists, the planted bytes are intact, and the
// staging is gone.
func TestStreamRecvNoClobberRace(t *testing.T) {
	dir := t.TempDir()
	data := []byte("streamed")
	h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{})
	h.send(MsgStreamData, data)
	if err := os.WriteFile(filepath.Join(dir, "out.bin"), []byte("planted"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.send(MsgStreamEnd, endFor(data))
	we := h.expectRefusal(ErrCodeDestinationExists)
	if !strings.Contains(we.Msg, "created on the receiver during the transfer") {
		t.Fatalf("message %q", we.Msg)
	}
	h.c.Close()
	if r := h.done(); r.err == nil || r.rep.Installed {
		t.Fatalf("receiver %+v %v", r.rep, r.err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "out.bin")); string(b) != "planted" {
		t.Fatalf("planted file now %q", b)
	}
	if l := listDir(t, dir); len(l) != 1 {
		t.Fatalf("listing %v", l)
	}
}

// U-R4: staging directory 0700 and installed file 0666 &^ umask, with the
// umask pinned to 027 in a child process. Unix only: on Windows modes are
// advisory (Go maps them to the read-only attribute) and the staging inherits
// the parent's ACL; the Windows lane asserts install and cleanup instead
// (stream_recv_windows_test.go).
func TestStreamRecvModesUnderUmask(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes and umask do not exist on Windows; see TestStreamRecvRootWindows")
	}
	dir := t.TempDir()
	cmd := exec.Command("/bin/sh", "-c", `umask 027; exec "$0"`, os.Args[0])
	cmd.Env = append(os.Environ(), streamChildEnv+"=umask", streamChildDirEnv+"="+dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
	got := strings.TrimSpace(string(out))
	if got != "stage=700 file=640" {
		t.Fatalf("child reported %q, want stage=700 file=640", got)
	}
	assertNoStaging(t, dir)
}

// U-R5: the parent directory swapped after Accept: the install lands in the
// directory that was opened (now moved), and nothing appears at the old path.
func TestStreamRecvParentSwap(t *testing.T) {
	base := t.TempDir()
	parent := filepath.Join(base, "parent")
	moved := filepath.Join(base, "moved")
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	data := []byte("swapped")
	h := acceptedRecv(t, parent, "out.bin", StreamRecvOpts{})
	if err := os.Rename(parent, moved); err != nil {
		if runtime.GOOS == "windows" {
			// Windows refuses to rename a directory another handle holds
			// open, so this swap cannot happen there at all.
			h.c.Close()
			h.done()
			t.Skipf("the swap is impossible on Windows: %v", err)
		}
		t.Fatal(err)
	}
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	h.send(MsgStreamData, data)
	h.send(MsgStreamEnd, endFor(data))
	h.expect(MsgStreamResult)
	if r := h.done(); r.err != nil || !r.rep.Installed {
		t.Fatalf("receiver %+v %v", r.rep, r.err)
	}
	if b, err := os.ReadFile(filepath.Join(moved, "out.bin")); err != nil || string(b) != "swapped" {
		t.Fatalf("moved dir: %q %v", b, err)
	}
	if l := listDir(t, parent); len(l) != 0 {
		t.Fatalf("the new directory at the old path got %v", l)
	}
	assertNoStaging(t, moved)
}

// failAfter injects a local write failure (a full disk) once n bytes were
// written to staging.
func failAfter(t *testing.T, n int64, onFail func()) {
	t.Helper()
	orig := streamStageWrite
	var written int64
	streamStageWrite = func(f *os.File, b []byte) (int, error) {
		if written+int64(len(b)) > n {
			if onFail != nil {
				onFail()
			}
			return 0, syscall.ENOSPC
		}
		written += int64(len(b))
		return f.Write(b)
	}
	t.Cleanup(func() { streamStageWrite = orig })
}

// U-R6: a local write failure removes the staging BEFORE write_failed is sent
// (observed while the receiver is inside that Write), and a real sender
// stops within 5 s with "nothing was installed".
func TestStreamRecvWriteFailure(t *testing.T) {
	t.Run("order", func(t *testing.T) {
		failAfter(t, 4, nil)
		dir := t.TempDir()
		h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{Drain: 200 * time.Millisecond})
		go h.send(MsgStreamData, []byte("more than four"))
		we := h.expectRefusal(ErrCodeWriteFailed)
		if !strings.Contains(we.Msg, "no space left on device") && !strings.Contains(we.Msg, "not enough space") {
			t.Fatalf("message %q", we.Msg)
		}
		h.done()
		if l := listDir(t, dir); len(l) != 0 {
			t.Fatalf("left %v", l)
		}
	})
	t.Run("real sender stops", func(t *testing.T) {
		failAfter(t, 3<<20, nil)
		dir := t.TempDir()
		tr, rc := realPair(t, dir, "out.bin", StreamRecvOpts{})
		src := &zeroSource{stopped: make(chan struct{})}
		start := time.Now()
		_, err := SendStream(context.Background(), tr, "out.bin", startOf(src), StreamSendOpts{})
		d := time.Since(start)
		var re *RemoteError
		if !errors.As(err, &re) || re.Code != ErrCodeWriteFailed || !strings.HasSuffix(err.Error(), "; nothing was installed on the receiver") {
			t.Fatalf("sender error %v", err)
		}
		if d > 5*time.Second {
			t.Fatalf("sender took %v", d)
		}
		<-rc
		if l := listDir(t, dir); len(l) != 0 {
			t.Fatalf("left %v", l)
		}
	})
}

// U-R7 (network form): the sender stops reading; the refusal write and the
// drain are both bounded by real deadlines.
func TestStreamRecvBoundedErrorWrite(t *testing.T) {
	failAfter(t, 4, nil)
	dir := t.TempDir()
	o := StreamRecvOpts{WriteTimeout: 300 * time.Millisecond, Drain: 300 * time.Millisecond}
	h := acceptedRecv(t, dir, "out.bin", o)
	h.send(MsgStreamData, []byte("more than four")) // and never read again
	start := time.Now()
	r := h.done()
	d := time.Since(start)
	t.Logf("returned %v after the failing chunk", d)
	if r.err == nil || d > o.WriteTimeout+o.Drain+time.Second {
		t.Fatalf("returned %v after %v", r.err, d)
	}
	if l := listDir(t, dir); len(l) != 0 {
		t.Fatalf("left %v", l)
	}
}

// U-R8 (network form): no frame within Idle: staging removed, return.
func TestStreamRecvIdle(t *testing.T) {
	dir := t.TempDir()
	h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{Idle: 300 * time.Millisecond})
	h.send(MsgStreamData, []byte("x"))
	start := time.Now()
	r := h.done()
	if d := time.Since(start); r.err == nil || d < 300*time.Millisecond || d > 2*time.Second {
		t.Fatalf("returned %v after %v", r.err, d)
	}
	if l := listDir(t, dir); len(l) != 0 {
		t.Fatalf("left %v", l)
	}
}

// U-R9: a malformed challenge in End is a protocol error, sent only after the
// staging was removed; nothing is installed.
func TestStreamRecvRejectsMalformedChallenge(t *testing.T) {
	good := newStreamChallenge()
	for _, c := range []struct{ name, challenge string }{
		{"missing", ""}, {"31 chars", good[:31]}, {"33 chars", good + "a"},
		{"uppercase", strings.ToUpper(good[:1]) + strings.Repeat("A", 31)},
		{"non-hex", "g" + good[1:]}, {"space", " " + good[1:]},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			data := []byte("payload")
			h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{})
			h.send(MsgStreamData, data)
			e := endFor(data)
			e.Challenge = c.challenge
			go h.send(MsgStreamEnd, e)
			we := h.expectRefusal(ErrCodeProtocol)
			if !strings.Contains(we.Msg, "stream end is malformed") {
				t.Fatalf("message %q", we.Msg)
			}
			h.c.Close()
			h.done()
			if l := listDir(t, dir); len(l) != 0 {
				t.Fatalf("left %v", l)
			}
		})
	}
	t.Run("missing field in JSON", func(t *testing.T) {
		dir := t.TempDir()
		h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{})
		go h.send(MsgStreamEnd, []byte(`{"Size":0,"SHA256":"`+sha256Hex(nil)+`"}`))
		h.expectRefusal(ErrCodeProtocol)
		h.c.Close()
		h.done()
		if l := listDir(t, dir); len(l) != 0 {
			t.Fatalf("left %v", l)
		}
	})
}

// U-R10: StreamResult echoes End's challenge byte for byte and is sent only
// after the hard link exists (observed while the receiver is inside that
// Write).
func TestStreamRecvResultEchoesAfterInstall(t *testing.T) {
	dir := t.TempDir()
	data := []byte("installed before the echo")
	h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{})
	h.send(MsgStreamData, []byte{}) // a keepalive is accepted
	h.send(MsgStreamData, data)
	e := endFor(data)
	go h.send(MsgStreamEnd, e)
	typ, err := h.readType()
	if err != nil || typ != MsgStreamResult {
		t.Fatalf("type %d %v", typ, err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "out.bin")); err != nil || !bytes.Equal(b, data) {
		t.Fatalf("at the first byte of StreamResult the destination is %q %v", b, err)
	}
	assertNoStaging(t, dir)
	var res StreamResult
	if err := json.Unmarshal(h.readRest(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Challenge != e.Challenge || res.Size != e.Size || res.SHA256 != e.SHA256 {
		t.Fatalf("result %+v for end %+v", res, e)
	}
	r := h.done()
	if r.err != nil || !r.rep.Installed || r.rep.Bytes != int64(len(data)) {
		t.Fatalf("receiver %+v %v", r.rep, r.err)
	}
}

// A guard abandoned (by a signal handler or watchdog) before End: the
// verified stream is not installed, and nothing is left.
func TestStreamRecvAbandonedGuardNeverInstalls(t *testing.T) {
	dir := t.TempDir()
	g := NewStageGuard()
	data := []byte("abandoned")
	h := acceptedRecv(t, dir, "out.bin", StreamRecvOpts{Guard: g})
	h.send(MsgStreamData, data)
	want := StageOutcome{Staged: true}
	if out := g.Abandon(); out != want || out.String() != "nothing was installed and the staging directory was removed" {
		t.Fatalf("Abandon while staging: %+v %q", out, out)
	}
	if out := g.Abandon(); out != want {
		t.Fatalf("second Abandon: %+v, want the same outcome", out)
	}
	go h.send(MsgStreamEnd, endFor(data))
	h.c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var buf [1]byte
	h.c.Read(buf[:]) // whatever the receiver says, it must not be a result
	if MsgType(buf[0]) == MsgStreamResult {
		t.Fatal("abandoned staging was confirmed")
	}
	h.c.Close()
	if r := h.done(); r.err == nil || r.rep.Installed {
		t.Fatalf("receiver %+v %v", r.rep, r.err)
	}
	if l := listDir(t, dir); len(l) != 0 {
		t.Fatalf("left %v", l)
	}
}

// --- The helper form: a real child process whose stdio is the peer. ---

const (
	streamChildEnv    = "XFER_STREAM_TEST_CHILD"
	streamChildDirEnv = "XFER_STREAM_TEST_DIR"
)

// runStreamChild is the body of a child process started by the tests below.
func runStreamChild(role string) int {
	dir := os.Getenv(streamChildDirEnv)
	root, err := os.OpenRoot(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	switch role {
	case "umask":
		return childUmask(dir, root)
	case "watchdog-write", "watchdog-idle", "watchdog-result":
	default:
		return 2
	}
	g := NewStageGuard()
	peer := NewExitWatchdogPeer(os.Stdin, os.Stdout, g)
	o := StreamRecvOpts{Guard: g, WriteTimeout: 300 * time.Millisecond, Drain: 300 * time.Millisecond, Idle: 5 * time.Second}
	switch role {
	case "watchdog-idle":
		o.Idle = 300 * time.Millisecond
		fillForever(os.Stderr) // the diagnostic's stream is full from the start
	case "watchdog-result":
		// The sender stops reading once the body is in: stdout is full
		// before StreamResult is written. stderr stays free for the
		// diagnostic the test reads.
		streamStageWrite = func(f *os.File, b []byte) (int, error) {
			fillForever(os.Stdout)
			time.Sleep(200 * time.Millisecond)
			return f.Write(b)
		}
	default:
		var written int64
		streamStageWrite = func(f *os.File, b []byte) (int, error) {
			if written+int64(len(b)) > 1<<20 {
				// The sender has stopped reading: fill stdout and stderr
				// until both are blocked, then fail the local write.
				fillForever(os.Stdout)
				fillForever(os.Stderr)
				time.Sleep(200 * time.Millisecond)
				return 0, syscall.ENOSPC
			}
			written += int64(len(b))
			return f.Write(b)
		}
	}
	_, _ = ReceiveStream(peer, StreamTarget{Parent: root, Leaf: "out.bin"}, o)
	return 3 // reached only if no watchdog ended the process
}

func fillForever(f *os.File) {
	go func() {
		junk := bytes.Repeat([]byte("x"), 4096)
		for {
			if _, err := f.Write(junk); err != nil {
				return
			}
		}
	}()
}

func childUmask(dir string, root *os.Root) int {
	var stageMode fs.FileMode
	streamStageWrite = func(f *os.File, b []byte) (int, error) {
		for _, n := range mustList(dir) {
			if strings.HasPrefix(n, stagePrefix) {
				if fi, err := os.Stat(filepath.Join(dir, n)); err == nil {
					stageMode = fi.Mode().Perm()
				}
			}
		}
		return f.Write(b)
	}
	a, b := net.Pipe()
	done := make(chan error, 1)
	go func() {
		_, err := ReceiveStream(b, StreamTarget{Parent: root, Leaf: "out.bin"}, StreamRecvOpts{})
		b.Close()
		done <- err
	}()
	_, err := SendStream(context.Background(), &connTransport{Conn: a}, "out.bin", startOf(newSource([]byte("mode"), 4)), StreamSendOpts{})
	if err != nil || <-done != nil {
		fmt.Println("transfer failed:", err)
		return 1
	}
	fi, err := os.Stat(filepath.Join(dir, "out.bin"))
	if err != nil {
		fmt.Println(err)
		return 1
	}
	fmt.Printf("stage=%o file=%o\n", stageMode, fi.Mode().Perm())
	return 0
}

func mustList(dir string) []string {
	es, _ := os.ReadDir(dir)
	var n []string
	for _, e := range es {
		n = append(n, e.Name())
	}
	return n
}

// watchdogChild starts the child with stdin/stdout/stderr as pipes this test
// holds and, after Accept, never reads.
type watchdogChild struct {
	cmd     *exec.Cmd
	in      *os.File // child's stdin (write end)
	out     *os.File // child's stdout (read end)
	errR    *os.File // child's stderr (read end), never read
	exited  chan struct{}
	started time.Time
}

func startWatchdogChild(t *testing.T, role, dir string) *watchdogChild {
	t.Helper()
	inR, inW, _ := os.Pipe()
	outR, outW, _ := os.Pipe()
	errR, errW, _ := os.Pipe()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), streamChildEnv+"="+role, streamChildDirEnv+"="+dir)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	inR.Close()
	outW.Close()
	errW.Close()
	c := &watchdogChild{cmd: cmd, in: inW, out: outR, errR: errR, exited: make(chan struct{}), started: time.Now()}
	go func() { _ = cmd.Wait(); close(c.exited) }()
	t.Cleanup(func() {
		select {
		case <-c.exited:
		default:
			_ = cmd.Process.Kill() // the exact child this test started
			<-c.exited
		}
		inW.Close()
		outR.Close()
		errR.Close()
	})
	// Hello and manifest, then read StreamAccept — the last read of stdout.
	_ = WriteJSON(inW, MsgHello, Hello{Version: 1, Mode: "push", Stream: true})
	_ = WriteJSON(inW, MsgManifest, Manifest{Files: []FileEntry{{Path: "out.bin", Size: -1}}})
	_ = outR.SetReadDeadline(time.Now().Add(10 * time.Second)) // unsupported on some pipes; the test timeout covers it
	if typ, _, err := ReadFrame(outR); err != nil || typ != MsgStreamAccept {
		t.Fatalf("child accept: %v %v", typ, err)
	}
	return c
}

func (c *watchdogChild) waitExit(t *testing.T, bound time.Duration) (int, time.Duration) {
	t.Helper()
	select {
	case <-c.exited:
		return c.cmd.ProcessState.ExitCode(), time.Since(c.started)
	case <-time.After(bound):
		t.Fatalf("the child did not exit within %v with stdout and stderr held full", bound)
		return 0, 0
	}
}

// U-R7 (helper form, X2): the local write fails; stdout and stderr are both
// full and never read. The watchdog removes the staging, gives the diagnostic
// its bounded budget, and the process exits 1 — nothing waits for the sender.
func TestStreamRecvWatchdogExitsWithFullStdoutAndStderr(t *testing.T) {
	dir := t.TempDir()
	c := startWatchdogChild(t, "watchdog-write", dir)
	if s := stagingIn(t, dir); len(s) != 1 {
		t.Fatalf("staging %v after accept", s)
	}
	go func() {
		chunk := make([]byte, 256<<10)
		for i := 0; i < 5; i++ { // 1.25 MiB: the local write fails after 1 MiB
			if WriteFrame(c.in, MsgStreamData, chunk) != nil {
				return
			}
		}
	}()
	code, d := c.waitExit(t, 10*time.Second)
	t.Logf("child exited %d after %v", code, d)
	if code != 1 {
		t.Fatalf("exit code %d, want 1 (the watchdog)", code)
	}
	if l := listDir(t, dir); len(l) != 0 {
		t.Fatalf("left %v", l)
	}
}

// U-R8 (helper form): the sender goes silent after Accept with stderr full;
// the idle watchdog removes the staging it finds and exits 1.
func TestStreamRecvWatchdogIdleRemovesStaging(t *testing.T) {
	dir := t.TempDir()
	c := startWatchdogChild(t, "watchdog-idle", dir)
	if s := stagingIn(t, dir); len(s) != 1 {
		t.Fatalf("staging %v after accept", s)
	}
	code, d := c.waitExit(t, 10*time.Second)
	t.Logf("child exited %d after %v", code, d)
	if code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	if l := listDir(t, dir); len(l) != 0 {
		t.Fatalf("the watchdog left %v", l)
	}
}

func stagingIn(t *testing.T, dir string) []string {
	var s []string
	for _, n := range listDir(t, dir) {
		if strings.HasPrefix(n, stagePrefix) {
			s = append(s, n)
		}
	}
	return s
}

// ExitWatchdogPeer in process: an expired deadline abandons the guard, and
// Exit(1) is called within the diagnostic budget even when the diagnostic
// writer blocks forever; a cleared deadline never fires.
func TestExitWatchdogPeerBounds(t *testing.T) {
	block := make(chan struct{})
	defer close(block)
	exited := make(chan int, 1)
	g := NewStageGuard()
	w := &ExitWatchdogPeer{In: bytes.NewReader(nil), Out: io.Discard, Guard: g,
		Diag: blockingWriter{block}, Exit: func(c int) { exited <- c }, DiagBudget: 100 * time.Millisecond}

	w.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	w.SetReadDeadline(time.Time{}) // cleared before it fires
	select {
	case <-exited:
		t.Fatal("a cleared deadline fired")
	case <-time.After(200 * time.Millisecond):
	}
	start := time.Now()
	w.SetWriteDeadline(time.Now().Add(50 * time.Millisecond))
	select {
	case c := <-exited:
		d := time.Since(start)
		if c != 1 || d < 150*time.Millisecond || d > time.Second {
			t.Fatalf("exit %d after %v; want 1 after deadline+budget", c, d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watchdog did not exit with a blocked diagnostic")
	}
	if g.state != stageAbandoned {
		t.Fatal("guard not abandoned before exit")
	}
}

type blockingWriter struct{ c chan struct{} }

func (b blockingWriter) Write(p []byte) (int, error) { <-b.c; return len(p), nil }

// --- What the watchdog says is what the guard recorded (root F1/F2). ---

// lockedBuffer is a diagnostic sink safe to read while the watchdog's
// goroutine may still write it.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// watchdogRecv is ReceiveStream over an ExitWatchdogPeer on net.Pipe, in
// this process: Exit is captured and closes the receiver's end, as the
// process's exit would.
type watchdogRecv struct {
	h      *recvHarness
	g      *StageGuard
	diag   *lockedBuffer
	exited chan int
}

func startWatchdogRecv(t *testing.T, dir string, o StreamRecvOpts) *watchdogRecv {
	t.Helper()
	a, b := net.Pipe()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	g := NewStageGuard()
	o.Guard = g
	w := &watchdogRecv{h: &recvHarness{t: t, c: a, dir: dir, res: make(chan recvResult, 1)}, g: g, diag: &lockedBuffer{}, exited: make(chan int, 1)}
	p := NewExitWatchdogPeer(b, b, g)
	p.Diag, p.DiagBudget = w.diag, time.Second // this sink never blocks
	p.Exit = func(code int) {
		_ = b.Close()
		select {
		case w.exited <- code:
		default:
		}
	}
	go func() {
		defer root.Close()
		rep, err := ReceiveStream(p, StreamTarget{Parent: root, Leaf: "out.bin"}, o)
		w.h.res <- recvResult{rep, err}
	}()
	t.Cleanup(func() { a.Close(); b.Close() })
	return w
}

func (w *watchdogRecv) accept() {
	w.h.hello()
	w.h.manifest("out.bin")
	w.h.expect(MsgStreamAccept)
}

func (w *watchdogRecv) waitExit(t *testing.T) {
	t.Helper()
	select {
	case code := <-w.exited:
		if code != 1 {
			t.Fatalf("watchdog exit code %d, want 1", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the watchdog did not exit")
	}
}

// Root F1: the verified stream was installed; then the sender stops reading
// and StreamResult cannot be written. The watchdog keeps the installed file
// and says so; it never says "nothing was installed". The two controls are
// the pre-install outcomes: staging existed and was removed, and nothing was
// ever staged.
func TestStreamRecvWatchdogReportsWhatWasStaged(t *testing.T) {
	t.Run("installed, confirmation blocked", func(t *testing.T) {
		dir := t.TempDir()
		w := startWatchdogRecv(t, dir, StreamRecvOpts{Idle: 5 * time.Second, WriteTimeout: 100 * time.Millisecond})
		w.accept()
		data := []byte("installed before the confirmation is blocked")
		w.h.send(MsgStreamData, data)
		w.h.send(MsgStreamEnd, endFor(data))
		// StreamResult is deliberately never read.
		w.waitExit(t)
		r := w.h.done()
		if b, err := os.ReadFile(filepath.Join(dir, "out.bin")); err != nil || !bytes.Equal(b, data) {
			t.Fatalf("destination after the watchdog: %q %v", b, err)
		}
		assertNoStaging(t, dir)
		want := "relayium: the sender stopped reading; out.bin was installed with the verified bytes and is kept; the sender may not have received the confirmation\n"
		if got := w.diag.String(); got != want {
			t.Fatalf("diagnostic %q, want %q", got, want)
		}
		if !r.rep.Installed || r.err != nil {
			t.Fatalf("receiver %+v %v", r.rep, r.err)
		}
		if out := w.g.Abandon(); !out.Installed || out.Leaf != "out.bin" || out.Residual != "" {
			t.Fatalf("guard outcome %+v", out)
		}
	})
	t.Run("staged, sender silent", func(t *testing.T) {
		dir := t.TempDir()
		w := startWatchdogRecv(t, dir, StreamRecvOpts{Idle: 200 * time.Millisecond})
		w.accept()
		w.h.send(MsgStreamData, []byte("x"))
		w.waitExit(t)
		w.h.done()
		if l := listDir(t, dir); len(l) != 0 {
			t.Fatalf("left %v", l)
		}
		want := "relayium: no data from the sender within the idle limit; nothing was installed and the staging directory was removed\n"
		if got := w.diag.String(); got != want {
			t.Fatalf("diagnostic %q, want %q", got, want)
		}
	})
	t.Run("nothing staged", func(t *testing.T) {
		dir := t.TempDir()
		w := startWatchdogRecv(t, dir, StreamRecvOpts{Idle: 200 * time.Millisecond})
		// No hello: the watchdog fires while the receiver waits for it.
		w.waitExit(t)
		w.h.done()
		if l := listDir(t, dir); len(l) != 0 {
			t.Fatalf("left %v", l)
		}
		if got, want := w.diag.String(), "relayium: no data from the sender within the idle limit; nothing was installed\n"; got != want {
			t.Fatalf("diagnostic %q, want %q", got, want)
		}
	})
}

// Root F1, helper form: a real child receives and installs the stream, then
// its stdout is full (the sender stopped reading) when StreamResult is
// written. The child exits 1 by the watchdog, the destination is kept, and
// its stderr says the file was installed.
func TestStreamRecvWatchdogHelperKeepsInstalledFile(t *testing.T) {
	dir := t.TempDir()
	c := startWatchdogChild(t, "watchdog-result", dir)
	data := bytes.Repeat([]byte("k"), 4096)
	if err := WriteFrame(c.in, MsgStreamData, data); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(c.in, MsgStreamEnd, endFor(data)); err != nil {
		t.Fatal(err)
	}
	code, d := c.waitExit(t, 10*time.Second)
	t.Logf("child exited %d after %v", code, d)
	if code != 1 {
		t.Fatalf("exit code %d, want 1 (the watchdog)", code)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "out.bin")); err != nil || !bytes.Equal(b, data) {
		t.Fatalf("destination after the watchdog: %d bytes %v", len(b), err)
	}
	assertNoStaging(t, dir)
	diag, _ := io.ReadAll(c.errR)
	want := "relayium: the sender stopped reading; out.bin was installed with the verified bytes and is kept; the sender may not have received the confirmation\n"
	if string(diag) != want {
		t.Fatalf("child stderr %q, want %q", diag, want)
	}
}

// The guard's outcome after an install: Abandon removes only what is left of
// the staging (the destination is another link to the same file and stays),
// reports the install, and says the same on every later call.
func TestStreamRecvGuardKeepsInstalledDestination(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	g := NewStageGuard()
	if err := g.begin(root); err != nil {
		t.Fatal(err)
	}
	if err := g.write([]byte("kept")); err != nil {
		t.Fatal(err)
	}
	if err := g.finishFile(); err != nil {
		t.Fatal(err)
	}
	if err := g.install("out.bin"); err != nil {
		t.Fatal(err)
	}
	// Abandoned between the install and removeStagingAfterInstall (a signal).
	want := StageOutcome{Installed: true, Leaf: "out.bin", Staged: true}
	for i := 0; i < 2; i++ {
		if out := g.Abandon(); out != want {
			t.Fatalf("Abandon #%d after install: %+v, want %+v", i+1, out, want)
		}
	}
	if out := g.removeStagingAfterInstall(); out != want {
		t.Fatalf("removeStagingAfterInstall after Abandon: %+v", out)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "out.bin")); err != nil || string(b) != "kept" {
		t.Fatalf("destination %q %v", b, err)
	}
	if l := listDir(t, dir); len(l) != 1 {
		t.Fatalf("listing %v, want only out.bin", l)
	}
	if got := want.String(); got != "out.bin was installed with the verified bytes and is kept; the sender may not have received the confirmation" {
		t.Fatalf("String %q", got)
	}
}
