package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Blocker 2: a bad rollout blacklists a version on every node it touched, and
// the record is permanent. Without a way to clear it, a version that is fixed
// centrally can never be installed on those nodes short of `rm` over SSH on
// each host.
func TestClearFailedUnblocksAPreviouslyFailedVersion(t *testing.T) {
	dir := t.TempDir()
	var w bytes.Buffer
	recordFailed(dir, "v0.9.0", &w)
	if !failedBefore(dir, "v0.9.0") {
		t.Fatal("setup: v0.9.0 should be recorded as failed")
	}
	if err := clearFailed(dir); err != nil {
		t.Fatalf("clearFailed: %v", err)
	}
	if failedBefore(dir, "v0.9.0") {
		t.Error("v0.9.0 still blocked after clearFailed, want it retryable")
	}
}

// Clearing a node that never failed anything is a no-op, not an error: an
// operator running -clear-failed across a fleet must not get failures from the
// healthy majority.
func TestClearFailedOnAFreshNodeSucceeds(t *testing.T) {
	if err := clearFailed(t.TempDir()); err != nil {
		t.Errorf("clearFailed on a fresh node = %v, want nil", err)
	}
}

// -clear-failed must run standalone (no -to) and must actually clear the file
// through the command path, not just the helper.
func TestRunUpdateWithClearFailedFlagClearsAndExitsOK(t *testing.T) {
	dir := t.TempDir()
	var w bytes.Buffer
	recordFailed(dir, "v0.9.0", &w)

	uc, err := parseUpdateFlags([]string{"-clear-failed", "-state-dir", dir, "-env-file", filepath.Join(dir, "nope")}, &w)
	if err != nil {
		t.Fatalf("parseUpdateFlags with -clear-failed and no -to: %v", err)
	}
	var out, errBuf bytes.Buffer
	svc := &fakeSvc{}
	if code := runUpdateWith(uc, svc, time.Second, 5*time.Millisecond, &out, &errBuf); code != exitOK {
		t.Errorf("code = %d, want %d (stderr=%s)", code, exitOK, errBuf.String())
	}
	if failedBefore(dir, "v0.9.0") {
		t.Error("v0.9.0 still blocked after -clear-failed")
	}
	if svc.restarts != 0 {
		t.Errorf("restarts = %d, want 0: -clear-failed must not touch the service", svc.restarts)
	}
}

// Minor 6: an update killed mid-watchdog leaves a .prev behind. Backing up over
// it would overwrite the last known-good binary with the possibly-broken
// current one, so a later rollback would "restore" the broken binary. Refuse
// instead, and leave both files exactly as they were.
func TestRunUpdateWithRefusesWhenAStalePrevBackupExists(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("MAYBE-BROKEN"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backupPath(bin), []byte("KNOWN-GOOD"), 0o755); err != nil {
		t.Fatal(err)
	}

	uc := updateConfig{StateDir: dir, BinPath: bin, TargetTag: "v9.9.9", Repo: updateRepo}
	svc := &fakeSvc{}
	var out, errBuf bytes.Buffer
	code := runUpdateWith(uc, svc, 50*time.Millisecond, 5*time.Millisecond, &out, &errBuf)

	if code != exitPrecondition {
		t.Errorf("code = %d, want exitPrecondition (%d)", code, exitPrecondition)
	}
	prev, err := os.ReadFile(backupPath(bin))
	if err != nil {
		t.Fatal(err)
	}
	if string(prev) != "KNOWN-GOOD" {
		t.Errorf(".prev = %q, want the untouched %q — the stale backup must never be overwritten", prev, "KNOWN-GOOD")
	}
	if svc.restarts != 0 {
		t.Errorf("restarts = %d, want 0", svc.restarts)
	}
	if !bytes.Contains(errBuf.Bytes(), []byte(backupPath(bin))) {
		t.Errorf("stderr = %q, want it to name the leftover backup so an operator can inspect it", errBuf.String())
	}
}

// Finding 4: central's rollout queue maps exit codes to result states, so the
// distinguishable failures must not collapse onto one code.
func TestUpdateExitCodesAreDistinct(t *testing.T) {
	seen := map[int]string{}
	for name, code := range map[string]int{
		"exitOK":            exitOK,
		"exitUsage":         exitUsage,
		"exitAlreadyFailed": exitAlreadyFailed,
		"exitPrecondition":  exitPrecondition,
		"exitUpdateFailed":  exitUpdateFailed,
		"exitRestartFailed": exitRestartFailed,
		"exitNotHealthy":    exitNotHealthy,
	} {
		if other, dup := seen[code]; dup {
			t.Errorf("%s and %s share exit code %d", name, other, code)
		}
		seen[code] = name
	}
}

// The already-failed refusal and a download failure are different outcomes for
// central (skipped vs failed) and must report different codes.
func TestRunUpdateWithReportsAlreadyFailedAndDownloadFailureDistinctly(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	var w bytes.Buffer
	recordFailed(dir, "v1.2.3", &w)

	var out, errBuf bytes.Buffer
	blocked := runUpdateWith(updateConfig{StateDir: dir, BinPath: bin, TargetTag: "v1.2.3", Repo: updateRepo},
		&fakeSvc{}, 50*time.Millisecond, 5*time.Millisecond, &out, &errBuf)
	if blocked != exitAlreadyFailed {
		t.Errorf("already-failed code = %d, want %d", blocked, exitAlreadyFailed)
	}

	// Port 1 on loopback: nothing listens, so the download fails fast.
	dl := runUpdateWith(updateConfig{
		StateDir: dir, BinPath: bin, TargetTag: "v9.9.9", Repo: updateRepo,
		APIBase: "http://127.0.0.1:1", DownloadBase: "http://127.0.0.1:1",
	}, &fakeSvc{}, 50*time.Millisecond, 5*time.Millisecond, &out, &errBuf)
	if dl != exitUpdateFailed {
		t.Errorf("download-failure code = %d, want %d", dl, exitUpdateFailed)
	}
}
