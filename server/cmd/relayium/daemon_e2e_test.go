package main

import (
	"bytes"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/trust"
)

// daemonServe spins up serveLoop on an ephemeral loopback port with the given
// allow-set and returns the port plus a channel carrying the loop's exit code.
func daemonServe(t *testing.T, serverDir, recvDir string, allow map[string]bool) (int, <-chan int) {
	t.Helper()
	id, err := secure.LoadOrCreateIdentity(serverDir)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	port := ln.Addr().(*net.TCPAddr).Port
	done := make(chan int, 1)
	go func() {
		done <- serveLoop(ln, id, allow, recvDir, true /*once*/, false, io.Discard, io.Discard)
	}()
	return port, done
}

func writeSrc(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func daemonTarget(port int) string { return "relayium://127.0.0.1:" + strconv.Itoa(port) }

func TestDaemonPushHappyPath(t *testing.T) {
	pusherDir := t.TempDir()
	serverDir := t.TempDir()
	recvDir := t.TempDir()

	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true})

	src := writeSrc(t, "hello.txt", "daemon direct!")
	var o, e bytes.Buffer
	rc := Run([]string{"push", "--config-dir", pusherDir, src, daemonTarget(port)}, &o, &e)
	if rc != 0 {
		t.Fatalf("push exited %d: %s", rc, e.String())
	}
	if got := waitCode(t, done); got != 0 {
		t.Fatalf("serve exited %d", got)
	}
	got, err := os.ReadFile(filepath.Join(recvDir, "hello.txt"))
	if err != nil || string(got) != "daemon direct!" {
		t.Fatalf("received = %q err=%v", got, err)
	}
	// TOFU wrote the listener's fingerprint into the pusher's known_hosts.
	if _, found, _ := trust.LookupHost(pusherDir, "127.0.0.1:"+strconv.Itoa(port)); !found {
		t.Fatal("known_hosts entry not written on first connect")
	}
}

func TestDaemonPushUnauthorizedRejected(t *testing.T) {
	pusherDir := t.TempDir()
	serverDir := t.TempDir()
	recvDir := t.TempDir()

	// Empty allow-set ⇒ pusher not authorized.
	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{})

	src := writeSrc(t, "nope.txt", "should not land")
	var o, e bytes.Buffer
	rc := Run([]string{"push", "--config-dir", pusherDir, src, daemonTarget(port)}, &o, &e)
	if rc == 0 {
		t.Fatal("push to an unauthorized listener should fail")
	}
	if got := waitCode(t, done); got == 0 {
		t.Fatal("serve should report failure for a rejected peer")
	}
	if _, err := os.Stat(filepath.Join(recvDir, "nope.txt")); !os.IsNotExist(err) {
		t.Fatal("no file should have landed from an unauthorized push")
	}
}

func TestDaemonPushKnownHostsMismatch(t *testing.T) {
	pusherDir := t.TempDir()
	serverDir := t.TempDir()
	recvDir := t.TempDir()

	pusher, _ := secure.LoadOrCreateIdentity(pusherDir)
	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true})

	// Pre-pin a WRONG fingerprint for this host:port.
	hostport := "127.0.0.1:" + strconv.Itoa(port)
	if err := trust.AddHost(pusherDir, hostport, "deadbeefwrongfingerprint"); err != nil {
		t.Fatal(err)
	}

	src := writeSrc(t, "x.txt", "mismatch")
	var o, e bytes.Buffer
	rc := Run([]string{"push", "--config-dir", pusherDir, src, daemonTarget(port)}, &o, &e)
	if rc == 0 {
		t.Fatal("push must refuse a fingerprint mismatch")
	}
	if !bytes.Contains(e.Bytes(), []byte("fingerprint mismatch")) {
		t.Fatalf("expected mismatch message, got: %s", e.String())
	}
	// The pinned line must NOT be overwritten.
	got, _, _ := trust.LookupHost(pusherDir, hostport)
	if got != "deadbeefwrongfingerprint" {
		t.Fatalf("known_hosts was overwritten to %q", got)
	}
	// Serve saw no successful transfer; drain its result (handshake succeeded on
	// the server side but the client aborted before sending, so receive errors).
	waitCode(t, done)
	if _, err := os.Stat(filepath.Join(recvDir, "x.txt")); !os.IsNotExist(err) {
		t.Fatal("no file should land on a mismatch")
	}
}

func waitCode(t *testing.T, done <-chan int) int {
	t.Helper()
	select {
	case c := <-done:
		return c
	case <-time.After(15 * time.Second):
		t.Fatal("timeout waiting for serve")
		return -1
	}
}
