//go:build !windows

package main

import (
	"bytes"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/trust"
	"github.com/relayium/relayium/internal/xfer"
)

// signalTestCLI runs this test binary as the relayium CLI (TestMain's "cli" role)
// in its own process, so a real signal reaches a real process.
func signalTestCLI(t *testing.T, env []string, args ...string) (*exec.Cmd, *lockedBuf) {
	t.Helper()
	cmd := exec.Command(os.Args[0], args...)
	cmd.Env = append(append(os.Environ(), "RELAYIUM_TEST_ROLE=cli"), env...)
	errBuf := &lockedBuf{}
	cmd.Stdout = errBuf
	cmd.Stderr = errBuf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	return cmd, errBuf
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return p
}

// waitListening watches serve's own startup line rather than probing the
// port: a probe connection would be the one connection a --once serve takes.
func waitListening(t *testing.T, out *lockedBuf) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(out.String(), "listening on") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("serve never started listening\n%s", out.String())
}

// waitExit waits up to d for cmd and returns its exit code; it fails the test
// when the process is still running.
func waitExit(t *testing.T, cmd *exec.Cmd, d time.Duration, out *lockedBuf) int {
	t.Helper()
	ch := make(chan error, 1)
	go func() { ch <- cmd.Wait() }()
	select {
	case <-ch:
		return cmd.ProcessState.ExitCode()
	case <-time.After(d):
		t.Fatalf("process still running %s after the signal\n%s", d, out.String())
		return -1
	}
}

type serveFixture struct {
	port      int
	recv      string
	clientCfg string
	cmd       *exec.Cmd
	out       *lockedBuf
}

func startServe(t *testing.T, once bool) *serveFixture {
	t.Helper()
	serverCfg, clientCfg, recv := t.TempDir(), t.TempDir(), t.TempDir()
	cid, err := secure.LoadOrCreateIdentity(clientCfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := trust.AddAuthorized(serverCfg, cid.Fingerprint); err != nil {
		t.Fatal(err)
	}
	port := freePort(t)
	args := []string{"serve", "--dir", recv, "--bind", "127.0.0.1", "--port", strconv.Itoa(port), "--config-dir", serverCfg}
	if once {
		args = append(args, "--once")
	}
	cmd, out := signalTestCLI(t, []string{"RELAYIUM_TEST_SERVE_DRAIN=400ms"}, args...)
	waitListening(t, out)
	return &serveFixture{port: port, recv: recv, clientCfg: clientCfg, cmd: cmd, out: out}
}

// beginTransfer opens a sync to the fixture and sends half of one file's body,
// leaving that transfer in flight.
func (f *serveFixture) beginTransfer(t *testing.T) net.Conn {
	t.Helper()
	tconn, err := dialDaemon("relayium://127.0.0.1:"+strconv.Itoa(f.port), f.clientCfg, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	const size = 1 << 20
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(xfer.WriteJSON(tconn, xfer.MsgHello, xfer.Hello{Version: xfer.WireVersion, Mode: "push", Sync: true}))
	must(xfer.WriteJSON(tconn, xfer.MsgManifest, xfer.Manifest{Files: []xfer.FileEntry{{Path: "half.bin", Size: size, Mode: 0o644}}}))
	var rs xfer.ResumeState
	_, err = xfer.ReadJSON(tconn, &rs)
	must(err)
	must(xfer.WriteJSON(tconn, xfer.MsgFileStart, xfer.FileStart{Index: 0}))
	_, err = tconn.Write(make([]byte, size/2))
	must(err)
	// Wait until the listener has created its staging file for the body.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if m, _ := filepath.Glob(filepath.Join(f.recv, ".relayium-recv-*")); len(m) > 0 {
			return tconn
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the transfer never reached the listener")
	return nil
}

func assertNoHalfFile(t *testing.T, dir string) {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		t.Errorf("left in the receive directory after shutdown: %s", e.Name())
	}
}

// An idle serve stops cleanly on SIGTERM, exit 0.
func TestServeSIGTERMIdleExitsCleanly(t *testing.T) {
	f := startServe(t, false)
	if err := f.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if code := waitExit(t, f.cmd, 5*time.Second, f.out); code != 0 {
		t.Fatalf("exit %d, want 0\n%s", code, f.out.String())
	}
}

// A transfer in flight past the drain budget is aborted: bounded exit 1, and
// no half file or staging left in the receive directory.
func TestServeSIGTERMAbortsInFlightTransferBounded(t *testing.T) {
	f := startServe(t, false)
	conn := f.beginTransfer(t)
	defer conn.Close()
	start := time.Now()
	if err := f.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	code := waitExit(t, f.cmd, 10*time.Second, f.out)
	if code != 1 {
		t.Fatalf("exit %d, want 1 (a transfer was cut off)\n%s", code, f.out.String())
	}
	if el := time.Since(start); el < 400*time.Millisecond {
		t.Fatalf("exited after %s, before the drain budget", el)
	}
	if !strings.Contains(f.out.String(), "aborted 1 transfer") {
		t.Fatalf("output does not report the abort:\n%s", f.out.String())
	}
	assertNoHalfFile(t, f.recv)
}

// --once: a signal during its one transfer exits 1 within the bound, nothing
// installed; a signal before any connection exits 1 at once.
func TestServeOnceSIGTERM(t *testing.T) {
	f := startServe(t, true)
	conn := f.beginTransfer(t)
	defer conn.Close()
	_ = f.cmd.Process.Signal(syscall.SIGTERM)
	if code := waitExit(t, f.cmd, 10*time.Second, f.out); code != 1 {
		t.Fatalf("once in flight: exit %d\n%s", code, f.out.String())
	}
	assertNoHalfFile(t, f.recv)

	g := startServe(t, true)
	_ = g.cmd.Process.Signal(syscall.SIGINT)
	if code := waitExit(t, g.cmd, 5*time.Second, g.out); code != 1 || !strings.Contains(g.out.String(), "stopped before a transfer arrived") {
		t.Fatalf("once idle: exit %d\n%s", code, g.out.String())
	}
}

// sync --watch: a SIGTERM during an attempt whose receiver has gone silent
// starts no new attempt and aborts the one in flight after the drain budget.
func TestSyncWatchSIGTERMIsBounded(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	target := tlsListener(t, func(c net.Conn) {
		defer c.Close()
		<-release
	})
	src := filepath.Join(t.TempDir(), "d")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd, out := signalTestCLI(t, []string{"RELAYIUM_TEST_SYNC_DRAIN=300ms"},
		"sync", "--watch", "--config-dir", t.TempDir(), src, target)
	// Wait until the attempt is connected and waiting on the silent receiver.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(out.String(), "learned") {
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	start := time.Now()
	_ = cmd.Process.Signal(syscall.SIGTERM)
	waitExit(t, cmd, 8*time.Second, out)
	if el := time.Since(start); el < 300*time.Millisecond {
		t.Fatalf("exited after %s, before the drain budget\n%s", el, out.String())
	}
	if !strings.Contains(out.String(), "interrupted") {
		t.Fatalf("output does not report the interruption:\n%s", out.String())
	}
}
