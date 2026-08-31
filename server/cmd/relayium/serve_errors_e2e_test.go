package main

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
	"github.com/relayium/relayium/internal/xfer"
)

// A push that collides with an existing file must tell the operator what
// actually happened. It must NOT also print the generic "maybe you aren't
// authorized" hint: the peer plainly was authorized, and that guess sends
// people to fix trust when the problem is a filename.
func TestDaemonPushCollisionIsActionableAndNotMislabeled(t *testing.T) {
	pusherDir, serverDir, recvDir := t.TempDir(), t.TempDir(), t.TempDir()
	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	src := writeSrc(t, "report.txt", "new")
	// The same name already exists on the receiver.
	if err := os.WriteFile(filepath.Join(recvDir, "report.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}

	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil, false)
	var o, e bytes.Buffer
	rc := Run([]string{"push", "--config-dir", pusherDir, src, daemonTarget(port)}, &o, &e)
	if rc == 0 {
		t.Fatal("a colliding push must fail")
	}
	waitCode(t, done)

	out := e.String()
	if !strings.Contains(out, "destination already exists") || !strings.Contains(out, "report.txt") {
		t.Fatalf("stderr = %q, want the collision explained by name", out)
	}
	if strings.Contains(out, "may not have authorized this host") {
		t.Fatalf("stderr = %q, must not blame authorization for an explicit refusal", out)
	}
	if strings.Contains(out, recvDir) {
		t.Fatalf("stderr = %q leaks the receiver's absolute path", out)
	}
	// The receiver's own file is untouched.
	got, _ := os.ReadFile(filepath.Join(recvDir, "report.txt"))
	if string(got) != "mine" {
		t.Fatalf("receiver's file changed: %q", got)
	}
}

// The authorization hint is still printed when the failure really is silent —
// which is the whole reason it exists.
func TestDaemonPushUnauthorizedStillGetsTheHint(t *testing.T) {
	pusherDir, serverDir, recvDir := t.TempDir(), t.TempDir(), t.TempDir()
	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{}, nil, false)

	src := writeSrc(t, "nope.txt", "x")
	var o, e bytes.Buffer
	if rc := Run([]string{"push", "--config-dir", pusherDir, src, daemonTarget(port)}, &o, &e); rc == 0 {
		t.Fatal("an unauthorized push must fail")
	}
	waitCode(t, done)
	if !strings.Contains(e.String(), "may not have authorized this host") {
		t.Fatalf("stderr = %q, want the authorization hint for a silent refusal", e.String())
	}
}

// An unauthorized peer learns nothing: no structured error frame, no reason,
// nothing about this host's files or trust state. It is closed on.
func TestUnauthorizedPeerGetsNoErrorFrame(t *testing.T) {
	pusherDir, serverDir, recvDir := t.TempDir(), t.TempDir(), t.TempDir()
	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	// A file exists that WOULD produce a "destination already exists" refusal —
	// if the peer ever got far enough to be told.
	if err := os.WriteFile(filepath.Join(recvDir, "report.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{}, nil, false) // empty allow-set

	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	tconn, _, err := secure.ClientAny(conn, pusher)
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}
	defer tconn.Close()
	_ = tconn.SetDeadline(time.Now().Add(5 * time.Second))

	// Speak the protocol as far as a real sender would.
	_ = xfer.WriteJSON(tconn, xfer.MsgHello, xfer.Hello{Version: xfer.WireVersion, Mode: "push"})
	_ = xfer.WriteJSON(tconn, xfer.MsgManifest, xfer.Manifest{
		Files: []xfer.FileEntry{{Path: "report.txt", Size: 3, Mode: 0o644}},
	})

	typ, payload, rerr := xfer.ReadFrame(tconn)
	if rerr == nil {
		t.Fatalf("an unauthorized peer received a frame (type %d, payload %q); it must get nothing", typ, payload)
	}
	waitCode(t, done)
	if got, _ := os.ReadFile(filepath.Join(recvDir, "report.txt")); string(got) != "mine" {
		t.Fatalf("receiver's file changed: %q", got)
	}
}

// A manifest over the cap is refused with an actionable message, from an
// authorized peer, without the misleading authorization hint.
func TestDaemonPushManifestCapIsActionable(t *testing.T) {
	pusherDir, serverDir, recvDir := t.TempDir(), t.TempDir(), t.TempDir()
	pusher, err := secure.LoadOrCreateIdentity(pusherDir)
	if err != nil {
		t.Fatal(err)
	}
	// 1001 files in one directory: one over the receiver's per-transfer cap.
	srcDir := t.TempDir()
	big := filepath.Join(srcDir, "many")
	if err := os.MkdirAll(big, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 1001; i++ {
		if err := os.WriteFile(filepath.Join(big, "f"+strconv.Itoa(i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil, false)
	var o, e bytes.Buffer
	if rc := Run([]string{"push", "--config-dir", pusherDir, big, daemonTarget(port)}, &o, &e); rc == 0 {
		t.Fatal("an over-cap push must fail")
	}
	waitCode(t, done)

	out := e.String()
	if !strings.Contains(out, "too many files") || !strings.Contains(out, "1000") {
		t.Fatalf("stderr = %q, want the cap explained with its limit", out)
	}
	if strings.Contains(out, "may not have authorized this host") {
		t.Fatalf("stderr = %q, must not blame authorization for an explicit refusal", out)
	}
	if strings.Contains(out, recvDir) {
		t.Fatalf("stderr = %q leaks the receiver's absolute path", out)
	}
}
