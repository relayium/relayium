package main

import (
	"bytes"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// nowForTest is a fixed instant for seeding a request; the rate limiter only
// ever compares it against itself here.
func nowForTest() time.Time { return time.Unix(1_700_000_000, 0) }

// The root updater consumes the request that woke it, on EVERY exit path.
// systemd re-arms a PathExists trigger as soon as the unit it started
// deactivates, so a request left behind restarts the updater immediately and
// keeps doing so — and the overwhelmingly common outcome of a run is "not this
// node's turn", which is exactly the path that would loop.
func TestRunUpdateConsumesTheRequestWhenItIsNotThisNodesTurn(t *testing.T) {
	h := &centralHandler{status: 200, token: "tok",
		resp: map[string]any{"targetVersion": "v0.9.0", "eligible": false}}
	srv := httptest.NewServer(h)
	defer srv.Close()

	stateDir := t.TempDir()
	runtimeDir := t.TempDir()
	writeState(t, stateDir, "node-1")
	if wrote, err := (&updateRequester{dir: runtimeDir}).request(nowForTest()); !wrote || err != nil {
		t.Fatalf("seeding the request: wrote=%v err=%v", wrote, err)
	}

	var out, errBuf bytes.Buffer
	code := runUpdate(updateConfig{
		StateDir: stateDir, RuntimeDir: runtimeDir,
		CentralURL: srv.URL, NodeToken: "tok",
	}, &out, &errBuf)
	if code != exitOK {
		t.Fatalf("runUpdate = %d, want exitOK; stderr=%s", code, errBuf.String())
	}
	if _, err := os.Stat(updateRequestPath(runtimeDir)); !os.IsNotExist(err) {
		t.Fatalf("the request survived a not-my-turn run: %v — the path unit would restart the updater forever", err)
	}
}

// ...including when the run fails before it ever reaches central. A host with a
// misconfigured central URL must not spin the updater either.
func TestRunUpdateConsumesTheRequestOnAnEarlyFailure(t *testing.T) {
	stateDir := t.TempDir()
	runtimeDir := t.TempDir()
	writeState(t, stateDir, "node-1")
	if wrote, err := (&updateRequester{dir: runtimeDir}).request(nowForTest()); !wrote || err != nil {
		t.Fatalf("seeding the request: wrote=%v err=%v", wrote, err)
	}

	var out, errBuf bytes.Buffer
	code := runUpdate(updateConfig{StateDir: stateDir, RuntimeDir: runtimeDir}, &out, &errBuf)
	if code == exitOK {
		t.Fatalf("runUpdate with no central URL = exitOK, want a failure; stderr=%s", errBuf.String())
	}
	if _, err := os.Stat(updateRequestPath(runtimeDir)); !os.IsNotExist(err) {
		t.Fatalf("the request survived a failed run: %v", err)
	}
}

// A run with no runtime directory configured at all — every host installed
// before this shipped — must behave exactly as it did before.
func TestRunUpdateWithoutARuntimeDirIsUnchanged(t *testing.T) {
	h := &centralHandler{status: 200, token: "tok",
		resp: map[string]any{"targetVersion": "v0.9.0", "eligible": false}}
	srv := httptest.NewServer(h)
	defer srv.Close()

	stateDir := t.TempDir()
	writeState(t, stateDir, "node-1")
	var out, errBuf bytes.Buffer
	if code := runUpdate(updateConfig{
		StateDir: stateDir, CentralURL: srv.URL, NodeToken: "tok",
	}, &out, &errBuf); code != exitOK {
		t.Fatalf("runUpdate = %d, want exitOK; stderr=%s", code, errBuf.String())
	}
}

// The runtime dir follows the same precedence chain as every other path the
// updater resolves: flag > process env > env file > built-in default. The
// updater runs as a SEPARATE unit from the node service, so it does not inherit
// systemd's RUNTIME_DIRECTORY and has to resolve the path itself.
func TestParseUpdateFlagsResolvesTheRuntimeDir(t *testing.T) {
	var errBuf bytes.Buffer

	uc, err := parseUpdateFlags([]string{"-to", "v0.9.0"}, &errBuf)
	if err != nil {
		t.Fatal(err)
	}
	if uc.RuntimeDir != defaultRuntimeDir {
		t.Errorf("RuntimeDir = %q, want the built-in default %q", uc.RuntimeDir, defaultRuntimeDir)
	}

	envFile := t.TempDir() + "/env"
	if err := os.WriteFile(envFile,
		[]byte("RELAYIUM_NODE_RUNTIME_DIR=/run/from-env-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	uc, err = parseUpdateFlags([]string{"-to", "v0.9.0", "-env-file", envFile}, &errBuf)
	if err != nil {
		t.Fatal(err)
	}
	if uc.RuntimeDir != "/run/from-env-file" {
		t.Errorf("RuntimeDir = %q, want the env file's value", uc.RuntimeDir)
	}

	uc, err = parseUpdateFlags([]string{"-to", "v0.9.0", "-env-file", envFile,
		"-runtime-dir", "/run/from-flag"}, &errBuf)
	if err != nil {
		t.Fatal(err)
	}
	if uc.RuntimeDir != "/run/from-flag" {
		t.Errorf("RuntimeDir = %q, want the flag to win", uc.RuntimeDir)
	}
}
