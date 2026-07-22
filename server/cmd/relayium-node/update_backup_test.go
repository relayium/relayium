//go:build !windows

// This file's umask test relies on syscall.Umask, which only exists on
// Unix-like platforms. That's fine: relayium-node itself only ships for
// linux/darwin (see .goreleaser.yaml), so this build tag never excludes a
// platform the binary actually targets.

package main

import (
	"os"
	"path/filepath"
	"syscall"
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
// which is the exact situation restore exists to fix. It must match the
// source's mode exactly, not merely have some executable bit set: a mode
// silently narrowed by umask (e.g. 0755 -> 0700) would still pass a bare
// "&0o111 != 0" check while leaving the binary unreadable/unexecutable by
// the non-root service user that actually runs it.
func TestBackupPreservesExecutableBit(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	srcFi, err := os.Stat(bin)
	if err != nil {
		t.Fatal(err)
	}
	if err := backupBinary(bin); err != nil {
		t.Fatalf("backupBinary: %v", err)
	}
	fi, err := os.Stat(backupPath(bin))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != srcFi.Mode().Perm() {
		t.Errorf("backup mode = %v, want exactly %v (source mode)", fi.Mode().Perm(), srcFi.Mode().Perm())
	}
}

// TestBackupSurvivesRestrictiveUmask exercises the actual bug: OpenFile's
// perm argument is ANDed with the process umask at creation time, so under a
// restrictive umask the backup file can come out narrower than the source
// binary unless backupBinary explicitly chmods it afterward. This directly
// reproduces the 0755 -> 0700 corruption a restrictive umask would otherwise
// cause.
//
// umask is process-global state (not per-goroutine), so this test must not
// run in parallel with anything else that depends on the umask, and it must
// restore the previous umask before returning even if an assertion fails.
func TestBackupSurvivesRestrictiveUmask(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	// Create (and force the mode of) the source binary before touching the
	// umask: os.WriteFile's own OpenFile call is just as subject to umask as
	// backupBinary's, so if we set the umask first the source itself would
	// come out narrowed and the test would pass for the wrong reason.
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(bin, 0o755); err != nil {
		t.Fatal(err)
	}

	old := syscall.Umask(0o077)
	defer syscall.Umask(old)

	if err := backupBinary(bin); err != nil {
		t.Fatalf("backupBinary: %v", err)
	}

	fi, err := os.Stat(backupPath(bin))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o755 {
		t.Errorf("backup mode under umask 0077 = %v, want 0755", fi.Mode().Perm())
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
