package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/relayium/relayium/internal/secure"
)

func TestSyncIncrementalOverDaemon(t *testing.T) {
	pusherDir := t.TempDir()
	serverDir := t.TempDir()
	recvDir := t.TempDir()
	srcDir := t.TempDir()

	pusher, _ := secure.LoadOrCreateIdentity(pusherDir)
	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil, false)

	// Two source files.
	os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("aaa"), 0o644)
	os.WriteFile(filepath.Join(srcDir, "b.txt"), []byte("bbb"), 0o644)

	// First sync: both files transfer.
	var o, e bytes.Buffer
	rc := Run([]string{"sync", "--config-dir", pusherDir, filepath.Join(srcDir, "a.txt"), filepath.Join(srcDir, "b.txt"), daemonTarget(port)}, &o, &e)
	if rc != 0 {
		t.Fatalf("first sync rc=%d: %s", rc, e.String())
	}
	waitCode(t, done)
	if b, _ := os.ReadFile(filepath.Join(recvDir, "a.txt")); string(b) != "aaa" {
		t.Fatalf("a.txt not synced: %q", b)
	}

	// Second sync (serve again): a.txt unchanged is skipped; change b.txt → only b transfers.
	os.WriteFile(filepath.Join(srcDir, "b.txt"), []byte("bbbCHANGED"), 0o644)
	port2, done2 := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil, false)
	var o2, e2 bytes.Buffer
	rc = Run([]string{"sync", "--config-dir", pusherDir, filepath.Join(srcDir, "a.txt"), filepath.Join(srcDir, "b.txt"), daemonTarget(port2)}, &o2, &e2)
	if rc != 0 {
		t.Fatalf("second sync rc=%d: %s", rc, e2.String())
	}
	waitCode(t, done2)
	if !bytes.Contains(e2.Bytes(), []byte("1 sent, 1 unchanged")) {
		t.Fatalf("expected 1 sent / 1 unchanged, got: %s", e2.String())
	}
	if b, _ := os.ReadFile(filepath.Join(recvDir, "b.txt")); string(b) != "bbbCHANGED" {
		t.Fatalf("b.txt not updated: %q", b)
	}
}

func TestSyncDeleteGatedByAllowDelete(t *testing.T) {
	pusherDir := t.TempDir()
	pusher, _ := secure.LoadOrCreateIdentity(pusherDir)

	// --- allowDelete=true: the extra file on the receiver is removed. ---
	serverDir := t.TempDir()
	recvDir := t.TempDir()
	srcDir := t.TempDir()
	os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("aaa"), 0o644)
	// Extra file on the receiver, not present in the source.
	os.WriteFile(filepath.Join(recvDir, "extra.txt"), []byte("stale"), 0o644)

	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil, true)
	var o, e bytes.Buffer
	rc := Run([]string{"sync", "--delete", "--config-dir", pusherDir, filepath.Join(srcDir, "a.txt"), daemonTarget(port)}, &o, &e)
	if rc != 0 {
		t.Fatalf("sync --delete rc=%d: %s", rc, e.String())
	}
	waitCode(t, done)
	if _, err := os.Stat(filepath.Join(recvDir, "extra.txt")); !os.IsNotExist(err) {
		t.Fatal("extra.txt should have been deleted (allow-delete=true)")
	}

	// --- allowDelete=false: the extra file on the receiver remains, and a warning is printed. ---
	serverDir2 := t.TempDir()
	recvDir2 := t.TempDir()
	os.WriteFile(filepath.Join(recvDir2, "extra.txt"), []byte("stale"), 0o644)

	port2, done2 := daemonServe(t, serverDir2, recvDir2, map[string]bool{pusher.Fingerprint: true}, nil, false)
	var o2, e2 bytes.Buffer
	rc = Run([]string{"sync", "--delete", "--config-dir", pusherDir, filepath.Join(srcDir, "a.txt"), daemonTarget(port2)}, &o2, &e2)
	if rc != 0 {
		t.Fatalf("sync --delete (denied) rc=%d: %s", rc, e2.String())
	}
	waitCode(t, done2)
	if _, err := os.Stat(filepath.Join(recvDir2, "extra.txt")); err != nil {
		t.Fatal("extra.txt must remain (allow-delete=false)")
	}
	// The DeleteDenied warning is printed on the listener's stderr, which
	// daemonServe discards in tests; see TestReceiveDeleteDeniedWhenNotAllowed
	// in internal/xfer for direct coverage of that signal.
}
