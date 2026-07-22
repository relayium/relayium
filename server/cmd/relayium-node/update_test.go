package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// writeEnvFile writes a systemd-style EnvironmentFile and returns its path.
func writeEnvFile(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "env")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// Finding 3: `sudo relayium-node update` gets a scrubbed environment and there
// is no EnvironmentFile on this invocation, so the updater must read the unit's
// env file itself. Otherwise a node whose state dir was moved is watched at the
// wrong path, never looks healthy, and is rolled back after a full outage
// window — with the good version blacklisted.
func TestParseUpdateFlagsReadsStateDirFromEnvFile(t *testing.T) {
	t.Setenv("RELAYIUM_NODE_STATE_DIR", "")
	envFile := writeEnvFile(t, "# comment\n\nRELAYIUM_NODE_TOKEN=secret\nRELAYIUM_NODE_STATE_DIR=/srv/relayium/state\n")

	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-to", "v0.9.0", "-env-file", envFile}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v", err)
	}
	if uc.StateDir != "/srv/relayium/state" {
		t.Errorf("StateDir = %q, want the env file's %q", uc.StateDir, "/srv/relayium/state")
	}
}

// docs/node-hardening.md runs the binary from /opt/relayium; the updater must
// replace the binary that is actually running, not the installer's default.
func TestParseUpdateFlagsReadsBinPathFromEnvFile(t *testing.T) {
	t.Setenv("RELAYIUM_NODE_BIN", "")
	envFile := writeEnvFile(t, "RELAYIUM_NODE_BIN=\"/opt/relayium/relayium-node\"\n")

	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-to", "v0.9.0", "-env-file", envFile}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v", err)
	}
	if uc.BinPath != "/opt/relayium/relayium-node" {
		t.Errorf("BinPath = %q, want the env file's %q (quotes stripped)", uc.BinPath, "/opt/relayium/relayium-node")
	}
}

func TestParseUpdateFlagsExplicitFlagBeatsEnvFile(t *testing.T) {
	t.Setenv("RELAYIUM_NODE_STATE_DIR", "")
	envFile := writeEnvFile(t, "RELAYIUM_NODE_STATE_DIR=/srv/relayium/state\n")

	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-to", "v0.9.0", "-state-dir", "/tmp/explicit", "-env-file", envFile}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v", err)
	}
	if uc.StateDir != "/tmp/explicit" {
		t.Errorf("StateDir = %q, want the explicit flag to win", uc.StateDir)
	}
}

// A dev machine has no /etc/relayium-node/env; that must be silent, not fatal.
func TestParseUpdateFlagsFallsBackWhenEnvFileMissing(t *testing.T) {
	t.Setenv("RELAYIUM_NODE_STATE_DIR", "")
	t.Setenv("RELAYIUM_NODE_BIN", "")
	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-to", "v0.9.0", "-env-file", filepath.Join(t.TempDir(), "absent")}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v", err)
	}
	if uc.StateDir != "/var/lib/relayium-node" {
		t.Errorf("StateDir = %q, want the built-in default", uc.StateDir)
	}
	if uc.BinPath != defaultBinPath {
		t.Errorf("BinPath = %q, want %q", uc.BinPath, defaultBinPath)
	}
	if errBuf.Len() != 0 {
		t.Errorf("stderr = %q, want silence when the env file is simply absent", errBuf.String())
	}
}

// Finding 5: compareVersions treats a non-semver tag as incomparable, so
// "latest"/"dev" would slip past the downgrade check entirely (and no such
// asset exists to download). Reject it at parse time.
func TestParseUpdateFlagsRejectsNonSemverTarget(t *testing.T) {
	for _, bad := range []string{"latest", "dev", "v1.2", "1.2.3.4", "v1.2.3-rc1", "vX.Y.Z", ""} {
		var errBuf bytes.Buffer
		if _, err := parseUpdateFlags([]string{"-to", bad}, &errBuf); err == nil {
			t.Errorf("parseUpdateFlags -to %q returned nil error, want a rejection", bad)
		}
	}
}

func TestParseUpdateFlagsAcceptsPlainSemverTargets(t *testing.T) {
	for _, good := range []string{"v1.2.3", "1.2.3", "v0.0.1"} {
		var errBuf bytes.Buffer
		if _, err := parseUpdateFlags([]string{"-to", good}, &errBuf); err != nil {
			t.Errorf("parseUpdateFlags -to %q = %v, want it accepted", good, err)
		}
	}
}

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
	// Point -env-file at a path that does not exist so the test sees the
	// built-in default rather than whatever /etc/relayium-node/env says on the
	// machine running the suite.
	t.Setenv("RELAYIUM_NODE_STATE_DIR", "")
	uc, err := parseUpdateFlags([]string{"-to", "v0.9.0", "-env-file", filepath.Join(t.TempDir(), "absent")}, &errBuf)
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
