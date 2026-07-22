package main

import (
	"testing"
	"time"
)

func TestLastHealthyIsZeroBeforeAnyHeartbeat(t *testing.T) {
	dir := t.TempDir()
	got, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("lastHealthy on a fresh dir: %v", err)
	}
	if !got.IsZero() {
		t.Errorf("lastHealthy = %v, want zero time before any heartbeat", got)
	}
}

func TestMarkHealthyRecordsATimeAndAdvancesIt(t *testing.T) {
	dir := t.TempDir()
	if err := markHealthy(dir); err != nil {
		t.Fatalf("markHealthy: %v", err)
	}
	first, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("lastHealthy: %v", err)
	}
	if first.IsZero() {
		t.Fatal("lastHealthy is zero right after markHealthy")
	}

	// The updater compares this against the moment it restarted the node, so a
	// second heartbeat must move the timestamp forward, not just recreate it.
	time.Sleep(10 * time.Millisecond)
	if err := markHealthy(dir); err != nil {
		t.Fatalf("second markHealthy: %v", err)
	}
	second, err := lastHealthy(dir)
	if err != nil {
		t.Fatalf("second lastHealthy: %v", err)
	}
	if !second.After(first) {
		t.Errorf("second markHealthy left mtime at %v (first was %v), want it to advance", second, first)
	}
}
