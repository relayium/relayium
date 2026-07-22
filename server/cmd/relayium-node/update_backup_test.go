package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBackupAndRestoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := backupBinary(bin); err != nil {
		t.Fatalf("backupBinary: %v", err)
	}
	if _, err := os.Stat(backupPath(bin)); err != nil {
		t.Fatalf("backup not created: %v", err)
	}

	// Simulate a successful replace that turns out to be broken.
	if err := os.WriteFile(bin, []byte("NEW-BROKEN"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := restoreBinary(bin); err != nil {
		t.Fatalf("restoreBinary: %v", err)
	}

	got, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "OLD" {
		t.Errorf("after restore, binary = %q, want %q", got, "OLD")
	}
}

// The restored binary has to stay executable or the node never comes back —
// which is the exact situation restore exists to fix.
func TestBackupPreservesExecutableBit(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := backupBinary(bin); err != nil {
		t.Fatalf("backupBinary: %v", err)
	}
	fi, err := os.Stat(backupPath(bin))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o111 == 0 {
		t.Errorf("backup mode = %v, want the executable bit set", fi.Mode().Perm())
	}
}

func TestRestoreWithoutBackupFails(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("NEW"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := restoreBinary(bin); err == nil {
		t.Error("restoreBinary with no .prev returned nil, want an error")
	}
}
