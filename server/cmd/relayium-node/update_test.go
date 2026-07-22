package main

import (
	"bytes"
	"testing"
)

func TestParseUpdateFlagsRequiresTargetTag(t *testing.T) {
	var errBuf bytes.Buffer
	// Part 1 drives updates by hand; part 2 supplies -to from central. Either
	// way an update without an explicit target is a bug, never "just take
	// latest" — that is how a fleet scatters across versions.
	if _, err := parseUpdateFlags(nil, &errBuf); err == nil {
		t.Error("parseUpdateFlags with no -to returned nil error, want a failure")
	}
}

func TestParseUpdateFlagsReadsTargetAndDowngrade(t *testing.T) {
	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-to", "v0.7.0", "-allow-downgrade"}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v (stderr=%s)", err, errBuf.String())
	}
	if uc.TargetTag != "v0.7.0" {
		t.Errorf("TargetTag = %q, want %q", uc.TargetTag, "v0.7.0")
	}
	if !uc.AllowDowngrade {
		t.Error("AllowDowngrade = false, want true")
	}
}

func TestParseUpdateFlagsDefaultsStateDir(t *testing.T) {
	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-to", "v0.9.0"}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v", err)
	}
	if uc.StateDir != "/var/lib/relayium-node" {
		t.Errorf("StateDir = %q, want the same default run() uses", uc.StateDir)
	}
	if uc.AllowDowngrade {
		t.Error("AllowDowngrade defaults to true, want false — downgrades must be opt-in")
	}
}
