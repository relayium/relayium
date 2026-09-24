package main

// Dormant SSH pull engine tests retained for a future reviewed reopening.
// Public CLI retirement is covered by TestSSHTransfersDisabled.

import (
	"bytes"
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

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/xfer"
)

// `pull host:file -` with only the transport replaced. The fake models the
// two ways a real ssh session can end: Close closes stdin and then WAITS for
// the peer to finish (like sshx.Session.Close waiting on the child), Abort
// tears the connection down. A peer that keeps writing after a refusal hangs
// Close and not Abort, exactly as a pre-v0.24.0 `__send` does over ssh.

type fakeSession struct {
	net.Conn
	peerDone chan struct{} // closed when the peer goroutine has returned

	mu      sync.Mutex
	aborted bool
	closed  bool
}

func (s *fakeSession) Close() error {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	if cw, ok := s.Conn.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
	}
	<-s.peerDone // like Wait: returns only once the peer is finished
	return s.Conn.Close()
}

func (s *fakeSession) Abort() error {
	s.mu.Lock()
	s.aborted = true
	s.mu.Unlock()
	err := s.Conn.Close()
	<-s.peerDone
	return err
}

func (s *fakeSession) state() (aborted, closed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.aborted, s.closed
}

type dialRecord struct {
	calls   int
	remote  string
	session *fakeSession
}

// stubPeer installs sshDial returning a session whose far end runs peer.
func stubPeer(t *testing.T, peer func(conn net.Conn)) *dialRecord {
	t.Helper()
	rec := &dialRecord{}
	old := sshDial
	sshDial = func(_ xfer.Endpoint, remoteCmd string, _ sshx.Opts) (io.ReadWriteCloser, error) {
		rec.calls++
		rec.remote = remoteCmd
		far, near := net.Pipe()
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer far.Close()
			peer(far)
		}()
		rec.session = &fakeSession{Conn: near, peerDone: done}
		return rec.session, nil
	}
	t.Cleanup(func() { sshDial = old })
	return rec
}

func stubStdoutTerminal(t *testing.T, tty bool) {
	t.Helper()
	old := pullStdoutIsTerminal
	pullStdoutIsTerminal = func(io.Writer) bool { return tty }
	t.Cleanup(func() { pullStdoutIsTerminal = old })
}

// realSender is the current `__send` for one path.
func realSender(t *testing.T, src string) func(net.Conn) {
	t.Helper()
	m, srcs, err := xfer.BuildManifest([]string{src})
	if err != nil {
		t.Fatal(err)
	}
	return func(c net.Conn) { xfer.Send(c, m, srcs, xfer.SendOpts{}) }
}

// runBoundedPull runs the command in-process and fails if it hangs.
func runBoundedPull(t *testing.T, stdout io.Writer, args ...string) (rc int, stderr string) {
	t.Helper()
	var errb bytes.Buffer
	done := make(chan int, 1)
	go func() { done <- legacyPull(args, stdout, &errb) }()
	select {
	case rc := <-done:
		return rc, errb.String()
	case <-time.After(10 * time.Second):
		t.Fatalf("pull %q did not return within 10s", args)
		return 0, ""
	}
}

func inEmptyDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Chdir(dir)
	return dir
}

func assertDirEmpty(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("stdout mode touched the local filesystem: %v", names)
	}
}

var stdoutPayload = []byte("to stdout\x00\r\n\xff\xfe exact bytes\n")

func TestLegacyPullToStdoutWritesExactlyTheFile(t *testing.T) {
	cwd := inEmptyDir(t)
	stubStdoutTerminal(t, false)
	src := filepath.Join(t.TempDir(), "data.bin")
	writeFile(t, src, string(stdoutPayload), 0o600)
	rec := stubPeer(t, realSender(t, src))

	var out bytes.Buffer
	rc, stderr := runBoundedPull(t, &out, "host:"+src, "-")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%q", rc, stderr)
	}
	if !bytes.Equal(out.Bytes(), stdoutPayload) {
		t.Fatalf("stdout = %q, want exactly the file", out.Bytes())
	}
	if strings.Contains(stderr, "exact bytes") {
		t.Fatalf("payload leaked onto stderr: %q", stderr)
	}
	if want := "relayium __send " + sshx.ShellQuote(src); rec.remote != want {
		t.Fatalf("remote command %q, want the unchanged %q", rec.remote, want)
	}
	if aborted, closed := rec.session.state(); aborted || !closed {
		t.Fatalf("success path: aborted=%v closed=%v, want a normal Close", aborted, closed)
	}
	assertDirEmpty(t, cwd)
}

// A literal local directory named "-" is still reachable as "./-", through the
// ordinary directory pull.
func TestLegacyPullDotSlashDashIsStillADirectory(t *testing.T) {
	cwd := inEmptyDir(t)
	src := filepath.Join(t.TempDir(), "data.bin")
	writeFile(t, src, string(stdoutPayload), 0o600)
	stubPeer(t, realSender(t, src))

	var out bytes.Buffer
	if rc, stderr := runBoundedPull(t, &out, "host:"+src, "./-"); rc != 0 {
		t.Fatalf("rc=%d stderr=%q", rc, stderr)
	}
	if out.Len() != 0 {
		t.Fatalf("directory pull wrote %q to stdout", out.Bytes())
	}
	assertOnlyFile(t, filepath.Join(cwd, "-"), "data.bin", stdoutPayload)
}

func TestLegacyPullToStdoutRefusesATerminal(t *testing.T) {
	cwd := inEmptyDir(t)
	stubStdoutTerminal(t, true)
	rec := stubPeer(t, func(net.Conn) { t.Error("dialed despite a terminal stdout") })
	var out bytes.Buffer
	rc, stderr := runBoundedPull(t, &out, "host:file.bin", "-")
	if rc != 2 || rec.calls != 0 || out.Len() != 0 {
		t.Fatalf("rc=%d dials=%d stdout=%q", rc, rec.calls, out.Bytes())
	}
	if !strings.Contains(stderr, "terminal") {
		t.Fatalf("stderr %q", stderr)
	}
	assertDirEmpty(t, cwd)
}

// The terminal test is the real one: /dev/null is a character device, and a
// ModeCharDevice heuristic would call it a terminal and refuse
// `pull host:f - > /dev/null`.
func TestLegacyPullToStdoutAcceptsDevNull(t *testing.T) {
	inEmptyDir(t)
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer devnull.Close()
	if pullStdoutIsTerminal(devnull) {
		t.Fatal("/dev/null reported as a terminal")
	}
	src := filepath.Join(t.TempDir(), "data.bin")
	writeFile(t, src, string(stdoutPayload), 0o600)
	stubPeer(t, realSender(t, src))
	if rc, stderr := runBoundedPull(t, devnull, "host:"+src, "-"); rc != 0 {
		t.Fatalf("rc=%d stderr=%q", rc, stderr)
	}
}

func TestLegacyPullToStdoutRefusesDirectoryShapedSourcesBeforeConnecting(t *testing.T) {
	stubStdoutTerminal(t, false)
	for _, src := range []string{"host:", "host:.", "host:/", "host://", "host:dir/", "host:/tmp/.", "host:/tmp/..", "host:a/..", "host:.."} {
		rec := stubPeer(t, func(net.Conn) {})
		var out bytes.Buffer
		rc, stderr := runBoundedPull(t, &out, src, "-")
		if rc != 2 || rec.calls != 0 || out.Len() != 0 {
			t.Fatalf("%s: rc=%d dials=%d stdout=%q stderr=%q", src, rc, rec.calls, out.Bytes(), stderr)
		}
		if !strings.Contains(stderr, "exactly one file") {
			t.Fatalf("%s: stderr %q", src, stderr)
		}
	}
	// Control: an ordinary file name, and names merely containing dots, are
	// not refused by shape.
	for _, p := range []string{"f", "dir/f", "/tmp/f.bin", "..f", "a/.hidden", "~"} {
		if why := stdoutSourceRefusal(p); why != "" {
			t.Fatalf("%q refused: %s", p, why)
		}
	}
}

func TestLegacyPullToStdoutRefusesADirectoryAndAborts(t *testing.T) {
	cwd := inEmptyDir(t)
	stubStdoutTerminal(t, false)
	dir := filepath.Join(t.TempDir(), "only")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "inside.txt"), "a single file in a directory", 0o600)
	rec := stubPeer(t, realSender(t, dir))

	var out bytes.Buffer
	rc, stderr := runBoundedPull(t, &out, "host:"+dir, "-")
	if rc != 1 || out.Len() != 0 {
		t.Fatalf("rc=%d stdout=%q", rc, out.Bytes())
	}
	if !strings.Contains(stderr, "exactly one regular file") {
		t.Fatalf("stderr %q", stderr)
	}
	if aborted, closed := rec.session.state(); !aborted || closed {
		t.Fatalf("refusal path: aborted=%v closed=%v, want Abort and never Close", aborted, closed)
	}
	assertDirEmpty(t, cwd)
}

// oldSender plays a `__send` from before v0.24.0: it reads the reply to its
// manifest and ignores it, streaming the whole body regardless.
func oldSender(path string, body []byte) func(net.Conn) {
	return func(c net.Conn) {
		sum := sha256.Sum256(body)
		xfer.WriteJSON(c, xfer.MsgHello, xfer.Hello{Version: 1, Mode: "push"})
		xfer.WriteJSON(c, xfer.MsgManifest, xfer.Manifest{Files: []xfer.FileEntry{{Path: path, Size: int64(len(body))}}})
		xfer.ReadFrame(c) // a refusal or a resume state; either way, carry on
		if xfer.WriteJSON(c, xfer.MsgFileStart, xfer.FileStart{}) != nil {
			return
		}
		if _, err := c.Write(body); err != nil {
			return
		}
		xfer.WriteJSON(c, xfer.MsgFileHash, xfer.FileHash{SHA256: hex.EncodeToString(sum[:])})
		xfer.ReadFrame(c)
	}
}

// Against an old sender that keeps streaming after the refusal, pull must end
// promptly: with Close instead of Abort this hangs until the test times out.
func TestLegacyPullToStdoutAbortsAnOldSenderThatIgnoresTheRefusal(t *testing.T) {
	stubStdoutTerminal(t, false)
	rec := stubPeer(t, oldSender("dir/big.bin", make([]byte, 8<<20)))
	var out bytes.Buffer
	rc, stderr := runBoundedPull(t, &out, "host:dir", "-")
	if rc != 1 || out.Len() != 0 {
		t.Fatalf("rc=%d stdout=%d bytes stderr=%q", rc, out.Len(), stderr)
	}
	if aborted, _ := rec.session.state(); !aborted {
		t.Fatal("did not abort")
	}
}

// An old sender sending a valid single file is accepted: no wire change.
func TestLegacyPullToStdoutAcceptsAnOldSender(t *testing.T) {
	stubStdoutTerminal(t, false)
	body := bytes.Repeat([]byte("old peer "), 50000)
	stubPeer(t, oldSender("f.bin", body))
	var out bytes.Buffer
	if rc, stderr := runBoundedPull(t, &out, "host:f.bin", "-"); rc != 0 {
		t.Fatalf("rc=%d stderr=%q", rc, stderr)
	}
	if !bytes.Equal(out.Bytes(), body) {
		t.Fatalf("stdout %d bytes, want %d", out.Len(), len(body))
	}
}

type brokenStdout struct{ n int }

func (w *brokenStdout) Write(p []byte) (int, error) {
	if w.n <= 0 {
		return 0, errors.New("write |1: broken pipe")
	}
	if len(p) > w.n {
		k := w.n
		w.n = 0
		return k, errors.New("write |1: broken pipe")
	}
	w.n -= len(p)
	return len(p), nil
}

func TestLegacyPullToStdoutBrokenOutputAbortsPromptly(t *testing.T) {
	stubStdoutTerminal(t, false)
	src := filepath.Join(t.TempDir(), "big.bin")
	writeFile(t, src, strings.Repeat("z", 16<<20), 0o600)
	rec := stubPeer(t, realSender(t, src))
	rc, stderr := runBoundedPull(t, &brokenStdout{n: 1}, "host:"+src, "-")
	if rc != 1 {
		t.Fatalf("rc=%d stderr=%q", rc, stderr)
	}
	if !strings.Contains(stderr, "broken pipe") || !strings.Contains(stderr, "incomplete") {
		t.Fatalf("stderr %q", stderr)
	}
	if aborted, closed := rec.session.state(); !aborted || closed {
		t.Fatalf("aborted=%v closed=%v", aborted, closed)
	}
}

func TestLegacyPullToStdoutHashMismatchSaysDiscard(t *testing.T) {
	stubStdoutTerminal(t, false)
	body := []byte("tampered in transit")
	rec := stubPeer(t, func(c net.Conn) {
		xfer.WriteJSON(c, xfer.MsgHello, xfer.Hello{Version: 1, Mode: "push"})
		xfer.WriteJSON(c, xfer.MsgManifest, xfer.Manifest{Files: []xfer.FileEntry{{Path: "f", Size: int64(len(body))}}})
		xfer.ReadFrame(c)
		xfer.WriteJSON(c, xfer.MsgFileStart, xfer.FileStart{})
		c.Write(body)
		xfer.WriteJSON(c, xfer.MsgFileHash, xfer.FileHash{SHA256: strings.Repeat("0", 64)})
		xfer.ReadFrame(c)
	})
	var out bytes.Buffer
	rc, stderr := runBoundedPull(t, &out, "host:f", "-")
	if rc != 1 || !strings.Contains(stderr, "did not verify") || !strings.Contains(stderr, "discard") {
		t.Fatalf("rc=%d stderr=%q", rc, stderr)
	}
	if aborted, _ := rec.session.state(); !aborted {
		t.Fatal("did not abort")
	}
}

func TestLegacyPullToStdoutRemoteEndsAtOnce(t *testing.T) {
	stubStdoutTerminal(t, false)
	stubPeer(t, func(net.Conn) {})
	var out bytes.Buffer
	rc, stderr := runBoundedPull(t, &out, "host:missing", "-")
	if rc != 1 || out.Len() != 0 || !strings.Contains(stderr, "before any file data arrived") {
		t.Fatalf("rc=%d stdout=%q stderr=%q", rc, out.Bytes(), stderr)
	}
}

// F1, in-process: an ordinary directory pull that THIS side refuses (the file
// already exists) against a sender that ignores the refusal. Before the abort,
// pull waited on Close forever; reproduced over real ssh against v0.11.1 and
// v0.23.0 (TestE2EPullCollisionOldPeerOverSSH).
func TestLegacyPullCollisionAbortsAnOldSender(t *testing.T) {
	dst := t.TempDir()
	writeFile(t, filepath.Join(dst, "big.bin"), "ORIGINAL", 0o600)
	rec := stubPeer(t, oldSender("big.bin", make([]byte, 8<<20)))
	var out bytes.Buffer
	rc, stderr := runBoundedPull(t, &out, "host:big.bin", dst)
	if rc != 1 || !strings.Contains(stderr, "already exists") {
		t.Fatalf("rc=%d stderr=%q", rc, stderr)
	}
	if aborted, closed := rec.session.state(); !aborted || closed {
		t.Fatalf("aborted=%v closed=%v", aborted, closed)
	}
	assertOnlyFile(t, dst, "big.bin", []byte("ORIGINAL"))
}

// A sender that sends the whole body and then disappears before its hash: the
// bytes are all out but unverified, and the message must say so — not claim
// that nothing arrived.
func TestLegacyPullToStdoutMissingHashIsNotReportedAsNothingSent(t *testing.T) {
	stubStdoutTerminal(t, false)
	body := []byte("complete but never verified")
	stubPeer(t, func(c net.Conn) {
		xfer.WriteJSON(c, xfer.MsgHello, xfer.Hello{Version: 1, Mode: "push"})
		xfer.WriteJSON(c, xfer.MsgManifest, xfer.Manifest{Files: []xfer.FileEntry{{Path: "f", Size: int64(len(body))}}})
		xfer.ReadFrame(c)
		xfer.WriteJSON(c, xfer.MsgFileStart, xfer.FileStart{})
		c.Write(body)
	})
	var out bytes.Buffer
	rc, stderr := runBoundedPull(t, &out, "host:f", "-")
	if rc != 1 || !bytes.Equal(out.Bytes(), body) {
		t.Fatalf("rc=%d stdout=%q", rc, out.Bytes())
	}
	if strings.Contains(stderr, "nothing was written") || !strings.Contains(stderr, "could not be verified") || !strings.Contains(stderr, "discard") {
		t.Fatalf("stderr %q", stderr)
	}
}
