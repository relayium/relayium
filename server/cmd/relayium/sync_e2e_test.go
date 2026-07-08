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
	port, done := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil)

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
	port2, done2 := daemonServe(t, serverDir, recvDir, map[string]bool{pusher.Fingerprint: true}, nil)
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
