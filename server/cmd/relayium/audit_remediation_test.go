package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/sshx"
	"github.com/relayium/relayium/internal/xfer"
)

// Caller-level regressions for AUD-01 and AUD-05. These drive the real
// commands — dispatch, flags, destination handling, exit code — with only the
// transport replaced, because the defect was in how each command composes its
// receive options, not in the option struct.

// peerOnAPipe runs a real sender against the pipe end it returns, so a command
// under test faces the actual protocol rather than a hand-built frame stream.
func peerOnAPipe(t *testing.T, srcBody string, opts xfer.SendOpts) (net.Conn, <-chan error) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "victim.txt")
	if err := os.WriteFile(src, []byte(srcBody), 0o600); err != nil {
		t.Fatal(err)
	}
	m, srcs, err := xfer.BuildManifest([]string{src})
	if err != nil {
		t.Fatal(err)
	}
	peer, local := net.Pipe()
	deadline := time.Now().Add(10 * time.Second)
	peer.SetDeadline(deadline)
	local.SetDeadline(deadline)
	errc := make(chan error, 1)
	go func() {
		_, serr := xfer.Send(peer, m, srcs, opts)
		peer.Close()
		errc <- serr
	}()
	return local, errc
}

func stubCrossnetReceive(t *testing.T, conn net.Conn) {
	t.Helper()
	old := crossnetReceiveDial
	crossnetReceiveDial = func(_ context.Context, _ string, _ crossFlags, _ io.Writer) (io.ReadWriteCloser, error) {
		return conn, nil
	}
	t.Cleanup(func() { crossnetReceiveDial = old })
}

func stubSSHDial(t *testing.T, conn net.Conn) {
	t.Helper()
	old := sshDial
	sshDial = func(_ xfer.Endpoint, _ string, _ sshx.Opts) (io.ReadWriteCloser, error) {
		return conn, nil
	}
	t.Cleanup(func() { sshDial = old })
}

// ── AUD-01: `receive` ───────────────────────────────────────────────────────

func TestReceiveCommandRefusesAPeerThatAsksToReplace(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	victim := filepath.Join(dst, "victim.txt")
	if err := os.WriteFile(victim, []byte("ORIGINAL-PERSONAL-DATA"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(victim)
	if err != nil {
		t.Fatal(err)
	}

	conn, errc := peerOnAPipe(t, "new", xfer.SendOpts{Sync: true})
	stubCrossnetReceive(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"receive", "483920", dst}, &out, &errb); rc == 0 {
		t.Fatalf("`receive` accepted a peer-requested replacement (stderr %q)", errb.String())
	}
	<-errc
	got, err := os.ReadFile(victim)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ORIGINAL-PERSONAL-DATA" {
		t.Fatalf("`receive` let the sender replace the file: %q", got)
	}
	after, err := os.Stat(victim)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("mtime changed (%v → %v)", before.ModTime(), after.ModTime())
	}
	if !strings.Contains(errb.String(), "does not accept sync") {
		t.Errorf("stderr does not explain the refusal: %q", errb.String())
	}
	if left, _ := filepath.Glob(filepath.Join(dst, ".relayium-recv-*")); len(left) != 0 {
		t.Errorf("refused transfer left staging behind: %v", left)
	}
}

func TestReceiveCommandStillAcceptsAnOrdinaryTransfer(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	conn, errc := peerOnAPipe(t, "hello", xfer.SendOpts{})
	stubCrossnetReceive(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"receive", "483920", dst}, &out, &errb); rc != 0 {
		t.Fatalf("`receive` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sender: %v", serr)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "victim.txt")); string(got) != "hello" {
		t.Fatalf("`receive` delivered %q", got)
	}
}

// ── AUD-01: `pull` ──────────────────────────────────────────────────────────

func TestPullCommandRefusesARemoteThatAsksToReplace(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	victim := filepath.Join(dst, "victim.txt")
	if err := os.WriteFile(victim, []byte("ORIGINAL-PERSONAL-DATA"), 0o600); err != nil {
		t.Fatal(err)
	}

	conn, errc := peerOnAPipe(t, "new", xfer.SendOpts{Sync: true})
	stubSSHDial(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"pull", "example.com:/srv/data", dst}, &out, &errb); rc == 0 {
		t.Fatalf("`pull` accepted a replacement requested by the remote host (stderr %q)", errb.String())
	}
	<-errc
	if got, _ := os.ReadFile(victim); string(got) != "ORIGINAL-PERSONAL-DATA" {
		t.Fatalf("a compromised remote replaced a local file through `pull`: %q", got)
	}
	if left, _ := filepath.Glob(filepath.Join(dst, ".relayium-recv-*")); len(left) != 0 {
		t.Errorf("refused transfer left staging behind: %v", left)
	}
}

func TestPullCommandStillAcceptsAnOrdinaryRemoteSend(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	conn, errc := peerOnAPipe(t, "hello", xfer.SendOpts{})
	stubSSHDial(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"pull", "example.com:/srv/data", dst}, &out, &errb); rc != 0 {
		t.Fatalf("`pull` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sender: %v", serr)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "victim.txt")); string(got) != "hello" {
		t.Fatalf("`pull` delivered %q", got)
	}
}

// ── AUD-01: the SSH receive half keeps its authorized sync ──────────────────

// `sync` over SSH runs `relayium __recv` on the remote as the user themself.
// That is the legitimate replacement path and must keep working, replacement
// and mirror-delete included.
func TestRecvHelperStillPerformsAnAuthorizedSync(t *testing.T) {
	isolatedEnv(t)
	dst := t.TempDir()
	if err := os.WriteFile(filepath.Join(dst, "victim.txt"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	conn, errc := peerOnAPipe(t, "NEW-CONTENT", xfer.SendOpts{Sync: true})
	old := helperStdio
	helperStdio = func() io.ReadWriter { return conn }
	t.Cleanup(func() { helperStdio = old })

	var out, errb bytes.Buffer
	rc := Run([]string{"__recv", "--", dst}, &out, &errb)
	conn.Close()
	if rc != 0 {
		t.Fatalf("`__recv` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sync sender: %v", serr)
	}
	if got, _ := os.ReadFile(filepath.Join(dst, "victim.txt")); string(got) != "NEW-CONTENT" {
		t.Fatalf("an authorized sync over SSH did not replace the file: %q", got)
	}
}

// ── AUD-05 through the real `sync` → `serve` path ───────────────────────────

// The listener, the TLS transport, the sync client and the new prefix
// negotiation, all real: a destination file that is shorter than the source but
// not a prefix of it used to fail verification on every run and leave the stale
// copy in place.
func TestSyncOverServeReplacesAChangedLongerFile(t *testing.T) {
	pusherDir := t.TempDir()
	serverDir := t.TempDir()
	recvDir := t.TempDir()
	srcDir := t.TempDir()

	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "notes.txt"), []byte("NEW-CONTENT"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Shorter, and not a prefix: exactly what an ordinary edit leaves behind.
	if err := os.WriteFile(filepath.Join(recvDir, "notes.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil, false)
	var o, e bytes.Buffer
	rc := Run([]string{"sync", "--config-dir", pusherDir, filepath.Join(srcDir, "notes.txt"), daemonTarget(port)}, &o, &e)
	if rc != 0 {
		t.Fatalf("sync rc=%d: %s", rc, e.String())
	}
	waitCode(t, done)

	got, err := os.ReadFile(filepath.Join(recvDir, "notes.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEW-CONTENT" {
		t.Fatalf("the listener still holds %q; a changed, longer file must sync", got)
	}
	if left, _ := filepath.Glob(filepath.Join(recvDir, ".relayium-recv-*")); len(left) != 0 {
		t.Errorf("sync left staging behind: %v", left)
	}
}
