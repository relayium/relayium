package main

import (
	"bytes"
	"testing"
)

func TestFailedBeforeIsFalseOnAFreshNode(t *testing.T) {
	if failedBefore(t.TempDir(), "v0.9.0") {
		t.Error("failedBefore = true on a fresh node, want false")
	}
}

// Without this the node loops forever: install the bad version, roll back, get
// told to install it again on the next tick.
func TestRecordFailedStopsARetryOfTheSameVersion(t *testing.T) {
	dir := t.TempDir()
	var w bytes.Buffer
	recordFailed(dir, "v0.9.0", &w)

	if !failedBefore(dir, "v0.9.0") {
		t.Error("failedBefore = false for a version already recorded as failed, want true")
	}
}

// A later good release must still install — the block is per version, not a
// permanent freeze of the node.
func TestRecordFailedDoesNotBlockOtherVersions(t *testing.T) {
	dir := t.TempDir()
	var w bytes.Buffer
	recordFailed(dir, "v0.9.0", &w)

	if failedBefore(dir, "v0.9.1") {
		t.Error("failedBefore = true for a different version, want false")
	}
}

// A prefix must not be mistaken for a match: v0.9.0 failing must not block
// v0.9.0-hotfix or v0.9.01.
func TestFailedBeforeMatchesWholeVersionsOnly(t *testing.T) {
	dir := t.TempDir()
	var w bytes.Buffer
	recordFailed(dir, "v0.9.0", &w)

	if failedBefore(dir, "v0.9.01") {
		t.Error("failedBefore matched a prefix, want whole-line matching only")
	}
}
