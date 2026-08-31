package main

import (
	"bytes"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/trust"
)

const fpA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const fpB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

// The documented systemd workflow is to run `relayium authorize` against a
// listener that is already running. That only works if serve re-reads the file
// on a miss: the in-memory set is otherwise frozen at startup, and the operator
// sees their authorize silently ignored until the service restarts.
func TestAuthorizeReloadsAllowListWithoutRestart(t *testing.T) {
	cfgDir := t.TempDir()
	var stderr bytes.Buffer
	h := &serveHandler{cfgDir: cfgDir, allow: map[string]bool{}, stderr: &stderr}

	if h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("an unknown peer must be rejected before it is authorized")
	}

	// Another process authorizes it against the SAME config dir, mid-run.
	if err := trust.AddAuthorized(cfgDir, fpA); err != nil {
		t.Fatal(err)
	}
	if !h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("a fingerprint added by `relayium authorize` must be honored on the next connection")
	}
	// A different peer is still not authorized by that reload.
	if h.authorize(fpB, "198.51.100.9:5000") {
		t.Fatal("the reload must not authorize anyone the file does not name")
	}
}

// An unreadable allow-list means we do not know who is authorized, so nobody
// is. The operator gets a warning naming the file to fix; the file's contents
// are never echoed.
func TestAuthorizeFailsClosedOnUnreadableAllowList(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read a mode-000 file, so the failure cannot be provoked")
	}
	cfgDir := t.TempDir()
	if err := trust.AddAuthorized(cfgDir, fpB); err != nil {
		t.Fatal(err)
	}
	path := trust.AuthorizedPath(cfgDir)
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(path, 0o600) })

	var stderr bytes.Buffer
	// approve would say yes to anyone — a reload failure must still deny, so
	// a broken file can never widen access.
	h := &serveHandler{
		cfgDir: cfgDir, allow: map[string]bool{}, stderr: &stderr,
		approve: func(remote, fp string) bool { return true },
	}
	if h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("a read failure on the allow-list must fail closed")
	}
	out := stderr.String()
	if !strings.Contains(out, path) {
		t.Fatalf("the warning must name the file to fix, got: %q", out)
	}
	if strings.Contains(out, fpB) {
		t.Fatalf("the warning must not disclose allow-list contents, got: %q", out)
	}
}

// A fingerprint already in the file at startup still passes without any reload,
// and an in-memory approval is not lost when a later reload happens.
func TestAuthorizeReloadOnlyAdds(t *testing.T) {
	cfgDir := t.TempDir()
	h := &serveHandler{cfgDir: cfgDir, allow: map[string]bool{fpA: true}, stderr: &bytes.Buffer{}}
	if !h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("a startup-known fingerprint must pass")
	}
	// fpB forces a reload of a file that names neither peer; fpA must survive it.
	if err := os.WriteFile(trust.AuthorizedPath(cfgDir), []byte("# nobody\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.authorize(fpB, "198.51.100.9:5000")
	if !h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("a reload must not revoke a fingerprint already accepted in memory")
	}
}

// The tests above exercise the reload in isolation. This is the documented
// systemd workflow end to end, over a listener that is never restarted: a real
// push from an unauthorized sender is refused, `relayium authorize` runs against
// the SAME --config-dir, and the very next real push — same live listener, same
// handler, same port — succeeds and lands the file.
func TestAuthorizeTakesEffectOnALiveListener(t *testing.T) {
	pusherDir, serverDir, recvDir := t.TempDir(), t.TempDir(), t.TempDir()
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
	port := ln.Addr().(*net.TCPAddr).Port

	// approve nil: no terminal to say yes on, which is exactly the case the
	// reload exists for. Output is discarded because the loop writes it from its
	// own goroutines, concurrently with this one.
	h := &serveHandler{
		id: id, allow: map[string]bool{}, dir: recvDir, cfgDir: serverDir,
		stdout: io.Discard, stderr: io.Discard,
	}
	done := make(chan int, 1)
	// Not --once: one listener and one handler must survive both pushes.
	go func() { done <- serveLoop(ln, h, false) }()
	t.Cleanup(func() {
		// Accept only fails once the listener is closed, so close, then wait for
		// the loop to actually return rather than leaking it into the next test.
		ln.Close()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("serveLoop did not return after its listener was closed")
		}
	})

	src := writeSrc(t, "payload.txt", "authorized later")
	var o, e bytes.Buffer
	if rc := Run([]string{"push", "--config-dir", pusherDir, src, daemonTarget(port)}, &o, &e); rc == 0 {
		t.Fatal("a push from a sender that is not on the allow-list must fail")
	}
	if _, err := os.Stat(filepath.Join(recvDir, "payload.txt")); !os.IsNotExist(err) {
		t.Fatalf("a rejected push left a file behind (stat err = %v)", err)
	}
	// Nothing restarted: if the loop had exited here, the second push would prove
	// nothing about picking a fingerprint up mid-run.
	select {
	case rc := <-done:
		t.Fatalf("the listener exited (%d) after the rejected push", rc)
	default:
	}

	// The operator authorizes the sender through the real command, against the
	// same config directory this listener was started with.
	var ao, ae bytes.Buffer
	if rc := Run([]string{"authorize", "--config-dir", serverDir, pusher.Fingerprint}, &ao, &ae); rc != 0 {
		t.Fatalf("authorize rc = %d: %s", rc, ae.String())
	}

	var o2, e2 bytes.Buffer
	if rc := Run([]string{"push", "--config-dir", pusherDir, src, daemonTarget(port)}, &o2, &e2); rc != 0 {
		t.Fatalf("the push after authorize exited %d: %s", rc, e2.String())
	}
	got, err := os.ReadFile(filepath.Join(recvDir, "payload.txt"))
	if err != nil || string(got) != "authorized later" {
		t.Fatalf("received = %q err = %v, want the pushed contents", got, err)
	}
}

func TestCheckReceiveDir(t *testing.T) {
	base := t.TempDir()

	t.Run("missing", func(t *testing.T) {
		err := checkReceiveDir(filepath.Join(base, "nope"))
		if err == nil || !strings.Contains(err.Error(), "does not exist") {
			t.Fatalf("err = %v, want an actionable does-not-exist error", err)
		}
		if !strings.Contains(err.Error(), "mkdir -p") {
			t.Fatalf("err = %v, want the fix spelled out", err)
		}
	})

	t.Run("not a directory", func(t *testing.T) {
		file := filepath.Join(base, "a-file")
		if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		err := checkReceiveDir(file)
		if err == nil || !strings.Contains(err.Error(), "is not a directory") {
			t.Fatalf("err = %v, want a not-a-directory error", err)
		}
	})

	t.Run("unwritable", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root writes into a mode-0500 directory, so the failure cannot be provoked")
		}
		dir := filepath.Join(base, "readonly")
		if err := os.Mkdir(dir, 0o500); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(dir, 0o700) })
		err := checkReceiveDir(dir)
		if err == nil || !strings.Contains(err.Error(), "not writable") {
			t.Fatalf("err = %v, want a not-writable error", err)
		}
	})

	// A symlink passes os.Stat as a directory, and then every received file is
	// written wherever the link points — which whoever can rewrite the link
	// chooses, after the operator approved the path they typed. serve must refuse
	// the link itself and say what to pass instead.
	t.Run("symlink to a directory", func(t *testing.T) {
		real := filepath.Join(base, "real-target")
		if err := os.Mkdir(real, 0o755); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(base, "link-to-real")
		if err := os.Symlink(real, link); err != nil {
			t.Skipf("this filesystem cannot make a symlink: %v", err)
		}
		err := checkReceiveDir(link)
		if err == nil {
			t.Fatal("a symlink to a directory must not be accepted as --dir")
		}
		if !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("err = %v, want the symlink named as the problem", err)
		}
		if !strings.Contains(err.Error(), "real directory") {
			t.Fatalf("err = %v, want the fix spelled out", err)
		}
		// The refusal happens before the probe: nothing may be written through
		// the link into the target either.
		entries, err := os.ReadDir(real)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("the check wrote %d entries through the symlink", len(entries))
		}
	})

	// A dangling symlink is a mistyped or moved target, not a missing directory:
	// either way it must fail, and never be silently created or followed.
	t.Run("dangling symlink", func(t *testing.T) {
		link := filepath.Join(base, "link-to-nowhere")
		if err := os.Symlink(filepath.Join(base, "gone"), link); err != nil {
			t.Skipf("this filesystem cannot make a symlink: %v", err)
		}
		if err := checkReceiveDir(link); err == nil {
			t.Fatal("a dangling symlink must not be accepted as --dir")
		}
	})

	// The probe must be cleaned up by this check, not left for the next one to
	// trip over — and a directory that cannot be cleaned up is not usable.
	t.Run("probe cleanup is required", func(t *testing.T) {
		dir := filepath.Join(base, "repeatable")
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 3; i++ {
			if err := checkReceiveDir(dir); err != nil {
				t.Fatalf("run %d: %v", i, err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("run %d left %d probe files behind", i, len(entries))
			}
		}
	})

	t.Run("usable", func(t *testing.T) {
		if err := checkReceiveDir(base); err != nil {
			t.Fatalf("an existing writable directory must pass: %v", err)
		}
		// The probe file must not be left behind.
		entries, err := os.ReadDir(base)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".relayium-serve-check-") {
				t.Fatalf("the writability probe left %s behind", e.Name())
			}
		}
	})
}

// serve must fail before it binds, so an operator never sees a "running"
// listener that cannot write, and the port stays free.
func TestServeRefusesUnusableDirBeforeListening(t *testing.T) {
	var stdout, stderr bytes.Buffer
	missing := filepath.Join(t.TempDir(), "nope")
	// Port 1 would need privileges to bind: reaching net.Listen at all fails the
	// test with a different error than the directory check we expect.
	rc := runServe([]string{"--dir", missing, "--port", "1", "--config-dir", t.TempDir()}, &stdout, &stderr)
	if rc != 1 {
		t.Fatalf("rc = %d, want 1", rc)
	}
	if !strings.Contains(stderr.String(), "does not exist") {
		t.Fatalf("stderr = %q, want the directory error", stderr.String())
	}

	// Same gate for a symlinked --dir: refused, and refused before the listener
	// exists, so no sender can ever push through the link.
	base := t.TempDir()
	real := filepath.Join(base, "target")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("this filesystem cannot make a symlink: %v", err)
	}
	stdout.Reset()
	stderr.Reset()
	if rc := runServe([]string{"--dir", link, "--port", "1", "--config-dir", t.TempDir()}, &stdout, &stderr); rc != 1 {
		t.Fatalf("rc = %d, want 1 for a symlinked --dir", rc)
	}
	if !strings.Contains(stderr.String(), "symlink") {
		t.Fatalf("stderr = %q, want the symlink error", stderr.String())
	}
}
