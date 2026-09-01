package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runWithDeadline runs the CLI in a goroutine so a --watch bug that parks the
// process shows up as a test failure instead of a hung suite.
func runWithDeadline(t *testing.T, args []string) (int, string, string) {
	t.Helper()
	type result struct {
		rc     int
		out    string
		errOut string
	}
	done := make(chan result, 1)
	go func() {
		var o, e bytes.Buffer
		rc := Run(args, &o, &e)
		done <- result{rc, o.String(), e.String()}
	}()
	select {
	case r := <-done:
		return r.rc, r.out, r.errOut
	case <-time.After(20 * time.Second):
		t.Fatalf("relayium %s never returned", strings.Join(args, " "))
		return 0, "", ""
	}
}

// A --watch whose source cannot be watched must fail now, with an actionable
// message. The failure this guards against is the opposite: a process that
// looks alive, has no watchers, and silently never syncs anything.
func TestSyncWatchRejectsUnwatchableSourceBeforeWaiting(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "not-there")

	rc, _, errOut := runWithDeadline(t, []string{"sync", "--watch", missing, "relayium://127.0.0.1:1"})
	if rc != 1 {
		t.Fatalf("rc = %d, want 1; stderr: %s", rc, errOut)
	}
	if !strings.Contains(errOut, "--watch") || !strings.Contains(errOut, "not-there") {
		t.Fatalf("stderr does not name the unwatchable source:\n%s", errOut)
	}
}

// sync skips symlinks and special files, so watching one could only ever send
// nothing. Refuse rather than watch a source that can never produce work.
func TestSyncWatchRejectsSymlinkSource(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	rc, _, errOut := runWithDeadline(t, []string{"sync", "--watch", link, "relayium://127.0.0.1:1"})
	if rc != 1 {
		t.Fatalf("rc = %d, want 1; stderr: %s", rc, errOut)
	}
	if !strings.Contains(errOut, "symlinks") {
		t.Fatalf("stderr does not explain the symlink refusal:\n%s", errOut)
	}
}

// Validation must happen before the first sync, not after it: a bad source must
// not produce a transfer attempt or a "synced:" report first.
func TestSyncWatchValidatesBeforeTheFirstSync(t *testing.T) {
	dir := t.TempDir()
	rc, out, errOut := runWithDeadline(t, []string{"sync", "--watch", filepath.Join(dir, "nope"), "relayium://127.0.0.1:1"})
	if rc != 1 {
		t.Fatalf("rc = %d, want 1", rc)
	}
	if strings.Contains(errOut, "synced:") || strings.Contains(out, "synced:") {
		t.Fatalf("a sync ran before the sources were validated:\n%s%s", out, errOut)
	}
}

// Without --watch, sync is still one shot: it must not start watching or retry.
func TestSyncWithoutWatchDoesNotRetry(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	rc, _, errOut := runWithDeadline(t, []string{"sync", dir, "relayium://127.0.0.1:1"})
	if rc == 0 {
		t.Fatal("syncing to a dead port should fail")
	}
	if strings.Contains(errOut, "retrying in") {
		t.Fatalf("a one-shot sync scheduled a retry:\n%s", errOut)
	}
}

// The help must describe the retry as recovery from a transient failure, and
// must not read as a promise that the sync eventually succeeds.
func TestSyncHelpDescribesWatchRetryTruthfully(t *testing.T) {
	var o, e bytes.Buffer
	if rc := Run([]string{"sync", "-h"}, &o, &e); rc != 0 {
		t.Fatalf("rc = %d", rc)
	}
	got := o.String()
	for _, want := range []string{
		"retries on its own",
		"exponential backoff",
		"capped at 30s",
		"not a promise",
		"runs never overlap",
		"fails immediately instead of",
		"watched together with the directory holding it",
		// The watch set repairs itself, so the help must not leave a reader
		// thinking a deleted-and-recreated folder keeps syncing silently.
		"deleted and recreated",
		"before the next sync counts",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("sync help omits %q:\n%s", want, got)
		}
	}
	// Nothing may claim the retry keeps going after the command exits, or that
	// it will always get there in the end.
	for _, forbidden := range []string{"until it succeeds", "guarantees", "never fails", "in the background"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("sync help overpromises with %q:\n%s", forbidden, got)
		}
	}
}

// The sync callback is not context-aware: Ctrl-C cannot interrupt a transfer
// that is already running. The help has to say where the boundary is instead of
// implying the command stops the moment it is pressed.
func TestSyncHelpDescribesCtrlCBoundary(t *testing.T) {
	var o, e bytes.Buffer
	if rc := Run([]string{"sync", "-h"}, &o, &e); rc != 0 {
		t.Fatalf("rc = %d", rc)
	}
	got := o.String()

	idx := strings.Index(got, "Ctrl-C")
	if idx < 0 {
		t.Fatalf("sync help never mentions Ctrl-C:\n%s", got)
	}
	// The claim has to sit with the Ctrl-C sentence, not somewhere else.
	claim := got[idx:min(idx+400, len(got))]
	for _, want := range []string{
		"no further attempt",                       // what it does stop
		"once the attempt already running returns", // and what it waits for
		"not cut off mid-transfer",                 // stated plainly
	} {
		if !strings.Contains(claim, want) {
			t.Errorf("the Ctrl-C paragraph omits %q:\n%s", want, claim)
		}
	}
	// "Ctrl-C stops it." on its own is the wording this replaces: it reads as
	// an immediate stop for a command that can be mid-transfer.
	if strings.Contains(got, "Ctrl-C stops it.\n") {
		t.Errorf("sync help still promises an unqualified immediate stop:\n%s", got)
	}
}
