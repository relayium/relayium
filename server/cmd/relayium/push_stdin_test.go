package main

import (
	"bytes"

	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

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
	if v := os.Getenv("RELAYIUM_TEST_RECV_IDLE"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			panic(err)
		}
		streamRecvIdle = d
	}
	switch os.Getenv("RELAYIUM_TEST_ROLE") {
	case "recv-engine":
		os.Exit(runRecv(os.Args[2:], os.Stdout, os.Stderr))
	case "cli":

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

// swapStdin makes f this process's os.Stdin for the test.
func swapStdin(t *testing.T, f *os.File) {
	t.Helper()
	old := os.Stdin
	os.Stdin = f
	t.Cleanup(func() { os.Stdin = old })
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

// Active daemon stdin validation, retained across SSH retirement.
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
		{"push", "a", "-", "relayium://127.0.0.1/file"},
		{"push", "-", "-", "relayium://127.0.0.1/file"},
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

// Active daemon stdin validation, retained across SSH retirement.
func TestPushStdinRefusesATerminal(t *testing.T) {
	rec := installStdinSeams(t, true, true, nil, nil, nil)
	stdout, stderr, code := runCLI("push", "-", "relayium://127.0.0.1:1/file")
	if code != 2 || stdout != "" || !strings.Contains(stderr, "refusing to read file bytes from a terminal") {
		t.Fatalf("exit %d stdout %q stderr %q", code, stdout, stderr)
	}
	if rec.probes.Load()+rec.dials.Load()+rec.starts.Load() != 0 {
		t.Fatal("a terminal stdin still reached ssh or the pump")
	}
}
