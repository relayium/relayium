package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/stdinpump"
	"github.com/relayium/relayium/internal/xfer"
)

// TestMain lets the test binary play the roles the real binary plays for
// `push -`, so in-package tests exercise the real dispatch, not a copy of it:
//
//   - `<test binary> __pump-stdin --death-fd N`: the helper xfer.SendStream
//     starts through the default stdinPumpStart (stdinpump.Start re-executes
//     os.Executable, which here is this binary). It goes through Run, so the
//     dispatch in Run is what is tested.
//   - RELAYIUM_TEST_ROLE=cli: the whole CLI (Run) with seams set from the
//     environment — used to run `__recv --stream-file` as a real process.
//   - RELAYIUM_TEST_ROLE=exit: a process that exits RELAYIUM_TEST_EXIT.
//   - a copy named ssh / ssh.exe: the SSH stand-in (e2e_stdin_standin_test.go).
func TestMain(m *testing.M) {
	switch strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe") {
	case "ssh":
		os.Exit(standinSSH(os.Args[1:]))
	}
	switch os.Getenv("RELAYIUM_TEST_ROLE") {
	case "cli":
		if v := os.Getenv("RELAYIUM_TEST_RECV_IDLE"); v != "" {
			d, err := time.ParseDuration(v)
			if err != nil {
				panic(err)
			}
			streamRecvIdle = d
		}
		os.Exit(Run(os.Args[1:], os.Stdout, os.Stderr))
	case "exit":
		code, _ := strconv.Atoi(os.Getenv("RELAYIUM_TEST_EXIT"))
		os.Exit(code)
	}
	if len(os.Args) > 1 && os.Args[1] == stdinpump.HelperArg {
		os.Exit(Run(os.Args[1:], os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

// ── fakes ───────────────────────────────────────────────────────────────────

// nopDeadlinePeer is an in-process receiver's end of a pipe pair: the tests
// that use it bound everything with the sender's Abort.
type nopDeadlinePeer struct {
	io.Reader
	io.Writer
}

func (nopDeadlinePeer) SetReadDeadline(time.Time) error  { return nil }
func (nopDeadlinePeer) SetWriteDeadline(time.Time) error { return nil }

// stdinFakeSession is an in-process SSH session: pipes to a receiver goroutine.
// It counts Abort and Close, which is what the CLI's failure paths are judged
// on (a failed stream must Abort, never Close and wait on the peer).
type stdinFakeSession struct {
	toPeerR   *io.PipeReader
	toPeerW   *io.PipeWriter
	fromPeerR *io.PipeReader
	fromPeerW *io.PipeWriter
	waitErr   error

	aborts, closes atomic.Int32
	peerDone       chan struct{}
}

func (s *stdinFakeSession) Read(p []byte) (int, error)  { return s.fromPeerR.Read(p) }
func (s *stdinFakeSession) Write(p []byte) (int, error) { return s.toPeerW.Write(p) }
func (s *stdinFakeSession) shut() {
	s.toPeerW.CloseWithError(errors.New("aborted"))
	s.fromPeerR.CloseWithError(errors.New("aborted"))
	s.toPeerR.CloseWithError(errors.New("aborted"))
	s.fromPeerW.CloseWithError(errors.New("aborted"))
}
func (s *stdinFakeSession) Abort() error { s.aborts.Add(1); s.shut(); <-s.peerDone; return s.waitErr }
func (s *stdinFakeSession) Close() error {
	s.closes.Add(1)
	s.toPeerW.Close()
	<-s.peerDone
	return s.waitErr
}
func (s *stdinFakeSession) Wait() error { <-s.peerDone; return s.waitErr }

// newStdinFakeSession starts peer on the far end of a fresh pipe pair.
func newStdinFakeSession(peer func(rw io.ReadWriter)) *stdinFakeSession {
	s := &stdinFakeSession{peerDone: make(chan struct{})}
	s.toPeerR, s.toPeerW = io.Pipe()
	s.fromPeerR, s.fromPeerW = io.Pipe()
	go func() {
		defer close(s.peerDone)
		peer(struct {
			io.Reader
			io.Writer
		}{s.toPeerR, s.fromPeerW})
		s.fromPeerW.Close()
	}()
	return s
}

// receiverSession is a fake session whose peer is the real stream receiver
// installing into dir/leaf.
func receiverSession(t *testing.T, dir, leaf string) (*stdinFakeSession, *xfer.StreamRecvReport, *error) {
	t.Helper()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { root.Close() })
	var rep xfer.StreamRecvReport
	var rerr error
	s := newStdinFakeSession(func(rw io.ReadWriter) {
		rep, rerr = xfer.ReceiveStream(nopDeadlinePeer{rw, rw}, xfer.StreamTarget{Parent: root, Leaf: leaf}, xfer.StreamRecvOpts{})
	})
	return s, &rep, &rerr
}

// stdinSeams records every externally visible step `push -` takes. Each
// test starts from "nothing may happen" and enables what it needs.
type stdinSeams struct {
	probes, dials, starts atomic.Int32
	dialCmd               string
}

func installStdinSeams(t *testing.T, terminal bool, has bool, probeErr error, sess stdinSession, start func() (xfer.StreamSource, error)) *stdinSeams {
	t.Helper()
	rec := &stdinSeams{}
	oldTerm, oldProbe, oldDial, oldStart, oldNotify := pushStdinIsTerminal, stdinRemoteHasRelayium, stdinSSHDial, stdinPumpStart, pushStdinNotify
	t.Cleanup(func() {
		pushStdinIsTerminal, stdinRemoteHasRelayium, stdinSSHDial, stdinPumpStart, pushStdinNotify = oldTerm, oldProbe, oldDial, oldStart, oldNotify
	})
	pushStdinIsTerminal = func() bool { return terminal }
	stdinRemoteHasRelayium = func(xfer.Endpoint, sshx.Opts) (bool, error) {
		rec.probes.Add(1)
		return has, probeErr
	}
	stdinSSHDial = func(_ xfer.Endpoint, cmd string, _ sshx.Opts) (stdinSession, error) {
		rec.dials.Add(1)
		rec.dialCmd = cmd
		if sess == nil {
			t.Error("ssh was dialed")
			return nil, errors.New("no session in this test")
		}
		return sess, nil
	}
	stdinPumpStart = func() (xfer.StreamSource, error) {
		rec.starts.Add(1)
		if start == nil {
			t.Error("stdin was started")
			return nil, errors.New("no source in this test")
		}
		return start()
	}
	pushStdinNotify = func(chan<- os.Signal) func() { return func() {} }
	return rec
}

func runCLI(args ...string) (stdout, stderr string, code int) {
	var o, e bytes.Buffer
	code = Run(args, &o, &e)
	return o.String(), e.String(), code
}

// assertDirNames fails unless dir holds exactly names.
func assertDirNames(t *testing.T, dir string, names ...string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if strings.Join(got, "\x00") != strings.Join(names, "\x00") {
		t.Fatalf("%s holds %q, want %q", dir, got, names)
	}
}

// blockedSource is a stdin source whose Read blocks until Stop.
type blockedSource struct {
	stopOnce sync.Once
	stopped  chan struct{}
	reading  chan struct{}
	readOnce sync.Once
}

func newBlockedSource() *blockedSource {
	return &blockedSource{stopped: make(chan struct{}), reading: make(chan struct{})}
}

func (b *blockedSource) Read([]byte) (int, error) {
	b.readOnce.Do(func() { close(b.reading) })
	<-b.stopped
	return 0, stdinpump.ErrStopped
}

func (b *blockedSource) Stop() error { b.stopOnce.Do(func() { close(b.stopped) }); return nil }

// ── tests ───────────────────────────────────────────────────────────────────

// Every refusal the command line alone justifies exits 2 before ssh is
// probed or dialed and before stdin is touched.
func TestPushStdinShapeRefusalsTouchNothing(t *testing.T) {
	for _, argv := range [][]string{
		{"push", "-", "host:"},
		{"push", "-", "host:."},
		{"push", "-", "host:dir/"},
		{"push", "-", "host:a/.."},
		{"push", "-", "host:a/."},
		{"push", "-", "host:/"},
		{"push", "-", "./local-file"},
		{"push", "-", "-"},
		{"push", "-", "relayium://127.0.0.1"},
		{"push", "-", "relayium://127.0.0.1/"},
		{"push", "-", "relayium://127.0.0.1/a/../b"},
		{"push", "-", "relayium:///x"},
		{"push", "a", "-", "host:x"},
		{"push", "-", "-", "host:x"},
		{"push", "-", "--", "-oProxyCommand=id:x"},
	} {
		rec := installStdinSeams(t, false, true, nil, nil, nil)
		stdout, stderr, code := runCLI(argv...)
		if code != 2 || stdout != "" {
			t.Errorf("%q: exit %d, stdout %q, want 2 and nothing\nstderr: %s", argv, code, stdout, stderr)
		}
		if rec.probes.Load()+rec.dials.Load()+rec.starts.Load() != 0 {
			t.Errorf("%q: probes %d dials %d starts %d, want none", argv, rec.probes.Load(), rec.dials.Load(), rec.starts.Load())
		}
	}
}

func TestPushStdinRefusesATerminal(t *testing.T) {
	rec := installStdinSeams(t, true, true, nil, nil, nil)
	stdout, stderr, code := runCLI("push", "-", "host:file")
	if code != 2 || stdout != "" || !strings.Contains(stderr, "refusing to read file bytes from a terminal") {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if rec.probes.Load()+rec.dials.Load()+rec.starts.Load() != 0 {
		t.Fatal("a terminal stdin still reached ssh or the pump")
	}
}

// No relayium on the remote: exit 1 with nothing read. There is no tar form.
func TestPushStdinRefusesZeroDependencyRemote(t *testing.T) {
	rec := installStdinSeams(t, false, false, nil, nil, nil)
	stdout, stderr, code := runCLI("push", "-", "host:file")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "no zero-dependency form for stdin") || !strings.Contains(stderr, "Nothing was read from stdin") {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if rec.probes.Load() != 1 || rec.dials.Load()+rec.starts.Load() != 0 {
		t.Fatalf("probes %d dials %d starts %d", rec.probes.Load(), rec.dials.Load(), rec.starts.Load())
	}
}

// ssh failing to connect (host key refused: RemoteHasRelayium's 255 split).
func TestPushStdinProbeFailureReadsNothing(t *testing.T) {
	rec := installStdinSeams(t, false, false, errors.New("ssh: could not connect to host"), nil, nil)
	_, stderr, code := runCLI("push", "-", "host:file")
	if code != 1 || !strings.Contains(stderr, "could not connect") || !strings.Contains(stderr, "nothing was read from stdin") {
		t.Fatalf("exit %d stderr %q", code, stderr)
	}
	if rec.dials.Load()+rec.starts.Load() != 0 {
		t.Fatal("dialed or started after a failed probe")
	}
}

// exitError returns a real *exec.ExitError with the given code.
func exitError(t *testing.T, code int) error {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "RELAYIUM_TEST_ROLE=exit", "RELAYIUM_TEST_EXIT="+strconv.Itoa(code))
	err := cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != code {
		t.Fatalf("exit role: %v", err)
	}
	return err
}

// An old remote `__recv` exits 2 on --stream-file and closes the channel
// without a frame: "predates", exit 1, stdin never started, Abort not Close.
// Control: the same silent close with any other status is not called "old".
func TestPushStdinOldRemoteIsNamedAndReadsNothing(t *testing.T) {
	for _, tc := range []struct {
		name    string
		waitErr error
		predate bool
	}{
		{"exit2", exitError(t, 2), true},
		{"exit1", exitError(t, 1), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sess := newStdinFakeSession(func(rw io.ReadWriter) {})
			sess.waitErr = tc.waitErr
			rec := installStdinSeams(t, false, true, nil, sess, nil)
			stdout, stderr, code := runCLI("push", "-", "host:dir/file")
			if code != 1 || stdout != "" {
				t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
			}
			if got := strings.Contains(stderr, "predates"); got != tc.predate {
				t.Fatalf("predates in stderr = %v, want %v: %s", got, tc.predate, stderr)
			}
			if !strings.Contains(stderr, "nothing was installed") && !strings.Contains(stderr, "Nothing was read") {
				t.Fatalf("stderr does not say nothing happened: %s", stderr)
			}
			if rec.starts.Load() != 0 || sess.closes.Load() != 0 || sess.aborts.Load() == 0 {
				t.Fatalf("starts %d closes %d aborts %d", rec.starts.Load(), sess.closes.Load(), sess.aborts.Load())
			}
			if want := "relayium __recv --stream-file -- 'dir/file'"; rec.dialCmd != want {
				t.Fatalf("remote command %q, want %q", rec.dialCmd, want)
			}
		})
	}
}

// The real receiver refuses (the destination exists): exit 1, the
// receiver's reason, stdin never started, Abort not Close, original intact.
func TestPushStdinReceiverRefusalAbortsAndReadsNothing(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "f"), "ORIGINAL", 0o600)
	sess, _, rerr := receiverSession(t, dir, "f")
	rec := installStdinSeams(t, false, true, nil, sess, nil)
	stdout, stderr, code := runCLI("push", "-", "host:"+dir+"/f")
	if code != 1 || stdout != "" || !strings.Contains(stderr, "already exists") ||
		!strings.Contains(stderr, "nothing was read from stdin and nothing was installed") {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if rec.starts.Load() != 0 || sess.closes.Load() != 0 || sess.aborts.Load() == 0 {
		t.Fatalf("starts %d closes %d aborts %d", rec.starts.Load(), sess.closes.Load(), sess.aborts.Load())
	}
	if *rerr == nil {
		t.Fatal("receiver reported no refusal")
	}
	assertDirNames(t, dir, "f")
	if b, _ := os.ReadFile(filepath.Join(dir, "f")); string(b) != "ORIGINAL" {
		t.Fatalf("original changed: %q", b)
	}
}

// swapStdin makes f this process's os.Stdin for the test.
func swapStdin(t *testing.T, f *os.File) {
	t.Helper()
	old := os.Stdin
	os.Stdin = f
	t.Cleanup(func() { os.Stdin = old })
}

// The whole sender with the REAL default stdinPumpStart: stdinpump.Start
// re-executes this binary as `__pump-stdin`, which reaches RunHelper only
// through Run's dispatch. Success writes nothing to stdout, one summary line
// to stderr, and closes (not aborts) the session.
func TestPushStdinRealHelperDispatchRoundTrip(t *testing.T) {
	body := make([]byte, 3*xfer.StreamChunkMax+17)
	for i := range body {
		body[i] = byte(i*13 + i/509)
	}
	in := filepath.Join(t.TempDir(), "in")
	writeFile(t, in, string(body), 0o600)
	f, err := os.Open(in)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	swapStdin(t, f)

	dir := t.TempDir()
	sess, rep, rerr := receiverSession(t, dir, "out.bin")
	rec := installStdinSeams(t, false, true, nil, sess, nil)
	stdinPumpStart = func() (xfer.StreamSource, error) { // the default, counted
		rec.starts.Add(1)
		p, err := stdinpump.Start()
		if err != nil {
			return nil, err
		}
		return p, nil
	}
	stdout, stderr, code := runCLI("push", "-", "host:"+dir+"/out.bin")
	if code != 0 || stdout != "" {
		t.Fatalf("exit %d stdout %q stderr %s", code, stdout, stderr)
	}
	sum := sha256.Sum256(body)
	if !strings.Contains(stderr, "out.bin (") || !strings.Contains(stderr, hex.EncodeToString(sum[:])) {
		t.Fatalf("no summary line on stderr: %s", stderr)
	}
	if *rerr != nil || !rep.Installed {
		t.Fatalf("receiver: %v %+v", *rerr, *rep)
	}
	got, err := os.ReadFile(filepath.Join(dir, "out.bin"))
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("installed %d bytes (err %v), want %d", len(got), err, len(body))
	}
	assertDirNames(t, dir, "out.bin")
	if rec.starts.Load() != 1 || sess.closes.Load() != 1 || sess.aborts.Load() != 0 {
		t.Fatalf("starts %d closes %d aborts %d", rec.starts.Load(), sess.closes.Load(), sess.aborts.Load())
	}
}

// A signal while the stream is running (stdin silent) ends it in bounded
// time with 128+N, stops the source, aborts the session, installs nothing.
func TestPushStdinSignalExitCodes(t *testing.T) {
	for _, tc := range []struct {
		sig  os.Signal
		code int
	}{
		{os.Interrupt, 130},
		{syscall.SIGTERM, 143},
	} {
		t.Run(tc.sig.String(), func(t *testing.T) {
			dir := t.TempDir()
			sess, _, _ := receiverSession(t, dir, "x")
			src := newBlockedSource()
			installStdinSeams(t, false, true, nil, sess, func() (xfer.StreamSource, error) { return src, nil })
			pushStdinNotify = func(c chan<- os.Signal) func() {
				go func() {
					<-src.reading // the stream is running and stdin is blocked
					c <- tc.sig
				}()
				return func() {}
			}
			began := time.Now()
			stdout, stderr, code := runCLI("push", "-", "host:"+dir+"/x")
			if code != tc.code || stdout != "" {
				t.Fatalf("exit %d, want %d; stdout %q stderr %s", code, tc.code, stdout, stderr)
			}
			if el := time.Since(began); el > 5*time.Second {
				t.Fatalf("took %v", el)
			}
			if !strings.Contains(stderr, "interrupted") || !strings.Contains(stderr, "nothing was installed") {
				t.Fatalf("stderr: %s", stderr)
			}
			select {
			case <-src.stopped:
			default:
				t.Fatal("source not stopped")
			}
			if sess.aborts.Load() == 0 || sess.closes.Load() != 0 {
				t.Fatalf("aborts %d closes %d", sess.aborts.Load(), sess.closes.Load())
			}
			assertDirNames(t, dir) // no destination, no staging
		})
	}
}

// __recv's argv: --stream-file takes exactly one path and no --no-resume.
func TestRecvStreamFileArgv(t *testing.T) {
	for _, argv := range [][]string{
		{"__recv", "--stream-file"},
		{"__recv", "--stream-file", "--", "a", "b"},
		{"__recv", "--stream-file", "--no-resume", "--", "a"},
	} {
		if _, _, code := runCLI(argv...); code != 2 {
			t.Errorf("%q: exit %d, want 2", argv, code)
		}
	}
}
