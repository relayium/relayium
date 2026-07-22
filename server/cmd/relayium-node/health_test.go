package main

import (
	"os"
	"testing"
	"time"
)

func TestLastHealthyIsZeroBeforeAnyHeartbeat(t *testing.T) {
	dir := t.TempDir()
	got, ver, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("lastHealthy on a fresh dir: %v", err)
	}
	if !got.IsZero() {
		t.Errorf("lastHealthy = %v, want zero time before any heartbeat", got)
	}
	if ver != "" {
		t.Errorf("lastHealthy version = %q, want empty before any heartbeat", ver)
	}
}

func TestMarkHealthyRecordsATimeAndAdvancesIt(t *testing.T) {
	dir := t.TempDir()
	if err := markHealthy(dir, "0.9.0"); err != nil {
		t.Fatalf("markHealthy: %v", err)
	}
	first, ver, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("lastHealthy: %v", err)
	}
	if first.IsZero() {
		t.Fatal("lastHealthy is zero right after markHealthy")
	}
	if ver != "0.9.0" {
		t.Errorf("lastHealthy version = %q, want the version markHealthy was given", ver)
	}

	// The updater compares this against the moment it restarted the node, so a
	// second heartbeat must move the timestamp forward, not just recreate it.
	time.Sleep(10 * time.Millisecond)
	if err := markHealthy(dir, "0.9.1"); err != nil {
		t.Fatalf("second markHealthy: %v", err)
	}
	second, ver, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("second lastHealthy: %v", err)
	}
	if !second.After(first) {
		t.Errorf("second markHealthy left mtime at %v (first was %v), want it to advance", second, first)
	}
	if ver != "0.9.1" {
		t.Errorf("lastHealthy version = %q after the second heartbeat, want %q", ver, "0.9.1")
	}
}

// A marker written by a node older than the versioned format is an empty file.
// It must read back as "unknown version": not an error, and not a match.
func TestLastHealthyReadsLegacyMarkerAsUnknownVersion(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(healthFilePath(dir), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ts, ver, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("lastHealthy on a legacy marker: %v", err)
	}
	if ts.IsZero() {
		t.Error("lastHealthy timestamp is zero for a legacy marker, want its mtime")
	}
	if ver != "" {
		t.Errorf("lastHealthy version = %q for a legacy marker, want empty (unknown)", ver)
	}
}

// markHealthy must not leave its temp files behind: the state dir would collect
// one per heartbeat, forever.
func TestMarkHealthyLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 3; i++ {
		if err := markHealthy(dir, "0.9.0"); err != nil {
			t.Fatal(err)
		}
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 1 || ents[0].Name() != healthFile {
		names := make([]string, 0, len(ents))
		for _, e := range ents {
			names = append(names, e.Name())
		}
		t.Errorf("state dir = %v, want only %q", names, healthFile)
	}
}
