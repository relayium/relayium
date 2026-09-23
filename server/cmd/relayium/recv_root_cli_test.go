package main

import (
	"bytes"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/secure"
)

// W-N26 at the command level: the three receivers whose destination is the
// local user's own argument create it when it is missing, and `serve`, whose
// --dir was checked at startup, still never recreates one that vanished.

func assertReceivedTree(t *testing.T, root string, big []byte) {
	t.Helper()
	if fi, err := os.Lstat(root); err != nil || !fi.IsDir() {
		t.Fatalf("destination %s is not a real directory: %v", root, err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "tree", "a.txt")); string(got) != "hello" {
		t.Fatalf("tree/a.txt = %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "tree", "big.bin")); !bytes.Equal(got, big) {
		t.Fatalf("tree/big.bin: %d bytes, want %d", len(got), len(big))
	}
	if info, err := os.Stat(filepath.Join(root, "tree", "empty")); err != nil || info.Size() != 0 {
		t.Fatalf("tree/empty did not land: %v", err)
	}
}

func stubHelperStdio(t *testing.T, conn net.Conn) {
	t.Helper()
	old := helperStdio
	helperStdio = func() io.ReadWriter { return conn }
	t.Cleanup(func() { helperStdio = old })
}

// `__recv` is the far end of native `push host:path` and `sync` over SSH.
func TestRecvHelperCreatesAMissingDestination(t *testing.T) {
	isolatedEnv(t)
	dst := filepath.Join(t.TempDir(), "new", "nested")
	conn, errc, big := treeSenderOnAPipe(t)
	stubHelperStdio(t, conn)

	var out, errb bytes.Buffer
	rc := Run([]string{"__recv", "--", dst}, &out, &errb)
	conn.Close()
	if rc != 0 {
		t.Fatalf("`__recv` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sender: %v", serr)
	}
	assertReceivedTree(t, dst, big)
	if errb.Len() != 0 || out.Len() != 0 {
		t.Errorf("`__recv` wrote stdout %q stderr %q, want both empty", out.String(), errb.String())
	}
}

func TestPullCreatesAMissingDestination(t *testing.T) {
	isolatedEnv(t)
	dst := filepath.Join(t.TempDir(), "new", "nested")
	conn, errc, big := treeSenderOnAPipe(t)
	stubSSHDial(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"pull", "example.com:/srv/tree", dst}, &out, &errb); rc != 0 {
		t.Fatalf("`pull` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sender: %v", serr)
	}
	assertReceivedTree(t, dst, big)
}

func TestReceiveCreatesAMissingDestination(t *testing.T) {
	isolatedEnv(t)
	dst := filepath.Join(t.TempDir(), "new", "nested")
	conn, errc, big := treeSenderOnAPipe(t)
	stubCrossnetReceive(t, conn)

	var out, errb bytes.Buffer
	if rc := Run([]string{"receive", "483920", dst}, &out, &errb); rc != 0 {
		t.Fatalf("`receive` rc=%d: %s", rc, errb.String())
	}
	if serr := <-errc; serr != nil {
		t.Fatalf("sender: %v", serr)
	}
	assertReceivedTree(t, dst, big)
}

// A destination that cannot be created fails the command with the cause on
// the local stderr — which, for `__recv`, ssh relays to the pusher who named
// it — and not as a per-file "integrity" verdict. The link's target is not
// created on the way.
func TestRecvHelperReportsAnUncreatableDestination(t *testing.T) {
	isolatedEnv(t)
	base := t.TempDir()
	target := filepath.Join(base, "target")
	dst := filepath.Join(base, "dangling")
	if err := os.Symlink(target, dst); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	conn, errc, _ := treeSenderOnAPipe(t)
	stubHelperStdio(t, conn)

	var out, errb bytes.Buffer
	rc := Run([]string{"__recv", "--", dst}, &out, &errb)
	conn.Close()
	if rc != 1 {
		t.Fatalf("`__recv` rc=%d, want 1: %s", rc, errb.String())
	}
	if serr := <-errc; serr == nil {
		t.Fatal("the sender believed the transfer succeeded")
	}
	if !strings.Contains(errb.String(), "create destination directory") || strings.Contains(errb.String(), "integrity") {
		t.Fatalf("stderr = %q, want the creation failure and no integrity verdict", errb.String())
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Fatalf("the dangling link's target was created (lstat err=%v)", err)
	}
}

// `serve` composition, unchanged: --dir existed when it started, then went
// away (an unmounted volume looks exactly like this). A push must not recreate
// it; the transfer fails instead.
func TestServeNeverRecreatesAVanishedReceiveDirectory(t *testing.T) {
	pusherDir, serverDir := t.TempDir(), t.TempDir()
	recvParent := t.TempDir()
	recvDir := filepath.Join(recvParent, "inbox")
	if err := os.Mkdir(recvDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := checkReceiveDir(recvDir); err != nil {
		t.Fatalf("startup check: %v", err)
	}
	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	id, err := secure.LoadOrCreateIdentity(serverDir)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var sout, serr bytes.Buffer // read only after serveLoop has returned
	h := &serveHandler{
		id: id, allow: map[string]bool{pusher.Fingerprint: true}, dir: recvDir, cfgDir: serverDir,
		stdout: &sout, stderr: &serr,
	}
	done := make(chan int, 1)
	go func() { done <- serveLoop(ln, h, true /*once*/) }()

	if err := os.Remove(recvDir); err != nil {
		t.Fatal(err)
	}
	root, _ := sendTree(t)
	var o, e bytes.Buffer
	if rc := Run([]string{"push", "--config-dir", pusherDir, root, daemonTarget(ln.Addr().(*net.TCPAddr).Port)}, &o, &e); rc == 0 {
		t.Fatalf("push into a vanished --dir succeeded: %s", o.String())
	}
	if code := waitCode(t, done); code == 0 {
		t.Fatalf("serve reported success: %s", sout.String())
	}
	entries, err := os.ReadDir(recvParent)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("serve recreated the vanished receive directory (parent holds %d entries)", len(entries))
	}
}
