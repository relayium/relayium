package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// writeState writes a minimal state.json with the given node ID, as loadState
// would produce after this node's first successful register.
func writeState(t *testing.T, dir, nodeID string) {
	t.Helper()
	if err := saveState(dir, nodeState{NodeID: nodeID, TURNSecret: "s", StorageSecret: "s"}); err != nil {
		t.Fatal(err)
	}
}

// centralHandler drives a fake central update-check endpoint with canned
// responses, recording every request body it saw so tests can assert on what
// was reported (in particular the "result" field).
type centralHandler struct {
	status   int
	resp     map[string]any
	token    string
	seenReqs []map[string]any
}

func (h *centralHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.token != "" && r.Header.Get("Authorization") != "Bearer "+h.token {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	h.seenReqs = append(h.seenReqs, body)
	w.WriteHeader(h.status)
	_ = json.NewEncoder(w).Encode(h.resp)
}

// Task 6: with -to omitted, the updater must ask central and fill in
// TargetTag/AllowDowngrade from the answer rather than failing.
func TestResolveTargetFromCentralFillsInTarget(t *testing.T) {
	h := &centralHandler{status: 200, token: "tok",
		resp: map[string]any{"targetVersion": "v0.9.0", "eligible": true, "allowDowngrade": true}}
	srv := httptest.NewServer(h)
	defer srv.Close()

	dir := t.TempDir()
	writeState(t, dir, "node-1")
	uc := updateConfig{StateDir: dir, CentralURL: srv.URL, NodeToken: "tok"}

	var out, errBuf bytes.Buffer
	code, ok := resolveTargetFromCentral(&uc, &out, &errBuf)
	if !ok {
		t.Fatalf("resolveTargetFromCentral not ok, code=%d stderr=%s", code, errBuf.String())
	}
	if uc.TargetTag != "v0.9.0" {
		t.Errorf("TargetTag = %q, want v0.9.0", uc.TargetTag)
	}
	if !uc.AllowDowngrade {
		t.Error("AllowDowngrade = false, want true (central authorised a downgrade)")
	}
}

// A non-semver tag from central must be refused exactly like a hand-typed one
// would be — central can have bugs too.
func TestResolveTargetFromCentralRejectsNonSemverTarget(t *testing.T) {
	h := &centralHandler{status: 200, token: "tok",
		resp: map[string]any{"targetVersion": "latest", "eligible": true}}
	srv := httptest.NewServer(h)
	defer srv.Close()

	dir := t.TempDir()
	writeState(t, dir, "node-1")
	uc := updateConfig{StateDir: dir, CentralURL: srv.URL, NodeToken: "tok"}

	var out, errBuf bytes.Buffer
	code, ok := resolveTargetFromCentral(&uc, &out, &errBuf)
	if ok {
		t.Fatal("resolveTargetFromCentral ok = true for a non-semver target, want refused")
	}
	if code != exitUpdateFailed {
		t.Errorf("code = %d, want exitUpdateFailed (%d)", code, exitUpdateFailed)
	}
}

// "Not eligible" must reuse the existing SKIPPED exit code (exitUsage), not a
// new one, and must not be reported as an error.
func TestResolveTargetFromCentralNotEligible(t *testing.T) {
	h := &centralHandler{status: 200, token: "tok",
		resp: map[string]any{"targetVersion": "v0.9.0", "eligible": false, "reason": "waiting"}}
	srv := httptest.NewServer(h)
	defer srv.Close()

	dir := t.TempDir()
	writeState(t, dir, "node-1")
	uc := updateConfig{StateDir: dir, CentralURL: srv.URL, NodeToken: "tok"}

	var out, errBuf bytes.Buffer
	code, ok := resolveTargetFromCentral(&uc, &out, &errBuf)
	if ok {
		t.Fatal("resolveTargetFromCentral ok = true when central says not eligible")
	}
	if code != exitUsage {
		t.Errorf("code = %d, want the reused SKIPPED code exitUsage (%d)", code, exitUsage)
	}
}

// An unreachable/erroring central must fail loudly (exitUpdateFailed) and
// never be confused with "not my turn".
func TestResolveTargetFromCentralUnreachable(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, "node-1")
	uc := updateConfig{StateDir: dir, CentralURL: "http://127.0.0.1:1", NodeToken: "tok"}

	var out, errBuf bytes.Buffer
	code, ok := resolveTargetFromCentral(&uc, &out, &errBuf)
	if ok {
		t.Fatal("resolveTargetFromCentral ok = true against an unreachable central")
	}
	if code != exitUpdateFailed {
		t.Errorf("code = %d, want exitUpdateFailed (%d)", code, exitUpdateFailed)
	}
}

// The previous update's outcome must be sent on the next poll and only
// cleared once that poll actually succeeds.
func TestPendingResultSentAndClearedOnSuccessfulPoll(t *testing.T) {
	h := &centralHandler{status: 200, token: "tok",
		resp: map[string]any{"targetVersion": "v0.9.0", "eligible": false}}
	srv := httptest.NewServer(h)
	defer srv.Close()

	dir := t.TempDir()
	writeState(t, dir, "node-1")
	recordPendingResult(dir, exitUpdateFailed, &bytes.Buffer{})
	if got := loadPendingResult(dir); got != "failed" {
		t.Fatalf("loadPendingResult = %q, want %q before polling", got, "failed")
	}

	uc := updateConfig{StateDir: dir, CentralURL: srv.URL, NodeToken: "tok"}
	var out, errBuf bytes.Buffer
	resolveTargetFromCentral(&uc, &out, &errBuf)

	if len(h.seenReqs) != 1 {
		t.Fatalf("central saw %d requests, want 1", len(h.seenReqs))
	}
	if got, _ := h.seenReqs[0]["result"].(string); got != "failed" {
		t.Errorf("central saw result=%q, want %q", got, "failed")
	}
	if got := loadPendingResult(dir); got != "" {
		t.Errorf("loadPendingResult after a successful poll = %q, want cleared", got)
	}
}

// If the poll itself fails (central unreachable), the pending result must
// survive so it can be retried — a lost result would leave a real failure
// invisible to the rollout queue forever.
func TestPendingResultSurvivesFailedPoll(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, "node-1")
	recordPendingResult(dir, exitRestartFailed, &bytes.Buffer{})

	uc := updateConfig{StateDir: dir, CentralURL: "http://127.0.0.1:1", NodeToken: "tok"}
	var out, errBuf bytes.Buffer
	resolveTargetFromCentral(&uc, &out, &errBuf)

	if got := loadPendingResult(dir); got != "rolled_back" {
		t.Errorf("loadPendingResult after a failed poll = %q, want it retained as %q", got, "rolled_back")
	}
}

// resultForExitCode: only outcomes of an actually-attempted update are worth
// reporting; a purely local refusal (bad flags, already-failed, precondition)
// has nothing to tell central and must not overwrite an older pending result.
func TestResultForExitCode(t *testing.T) {
	cases := map[int]string{
		exitOK:            "ok",
		exitUpdateFailed:  "failed",
		exitRestartFailed: "rolled_back",
		exitNotHealthy:    "rolled_back",
		exitUsage:         "",
		exitAlreadyFailed: "",
		exitPrecondition:  "",
	}
	for code, want := range cases {
		if got := resultForExitCode(code); got != want {
			t.Errorf("resultForExitCode(%d) = %q, want %q", code, got, want)
		}
	}
}

func TestRecordPendingResultIgnoresNonReportableCodes(t *testing.T) {
	dir := t.TempDir()
	recordPendingResult(dir, exitRestartFailed, &bytes.Buffer{})
	recordPendingResult(dir, exitAlreadyFailed, &bytes.Buffer{}) // must not clobber the above
	if got := loadPendingResult(dir); got != "rolled_back" {
		t.Errorf("loadPendingResult = %q, want the earlier %q preserved", got, "rolled_back")
	}
}

// Config precedence for CentralURL/NodeToken must match StateDir/BinPath:
// flag > process env > env file > default.
func TestParseUpdateFlagsReadsCentralURLAndTokenFromEnvFile(t *testing.T) {
	t.Setenv("RELAYIUM_CENTRAL_URL", "")
	t.Setenv("RELAYIUM_NODE_TOKEN", "")
	envFile := writeEnvFile(t, "RELAYIUM_CENTRAL_URL=https://relayium.example\nRELAYIUM_NODE_TOKEN=filetok\n")

	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-env-file", envFile}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v", err)
	}
	if uc.CentralURL != "https://relayium.example" {
		t.Errorf("CentralURL = %q, want the env file's value", uc.CentralURL)
	}
	if uc.NodeToken != "filetok" {
		t.Errorf("NodeToken = %q, want the env file's value", uc.NodeToken)
	}
}

func TestParseUpdateFlagsExplicitCentralURLBeatsEnvFile(t *testing.T) {
	t.Setenv("RELAYIUM_CENTRAL_URL", "")
	envFile := writeEnvFile(t, "RELAYIUM_CENTRAL_URL=https://from-file.example\n")

	var errBuf bytes.Buffer
	uc, err := parseUpdateFlags([]string{"-central-url", "https://explicit.example", "-env-file", envFile}, &errBuf)
	if err != nil {
		t.Fatalf("parseUpdateFlags: %v", err)
	}
	if uc.CentralURL != "https://explicit.example" {
		t.Errorf("CentralURL = %q, want the explicit flag to win", uc.CentralURL)
	}
}

// Sanity check that we don't accidentally strip a trailing slash incorrectly
// or double it up when building the update-check URL.
func TestFetchTargetPostsToUpdateCheckPath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{"eligible": false})
	}))
	defer srv.Close()

	if _, _, _, err := fetchTarget(srv.URL+"/", "tok", "n1", "0.8.0", "", srv.Client()); err != nil {
		t.Fatalf("fetchTarget: %v", err)
	}
	if gotPath != "/api/nodes/update-check" {
		t.Errorf("path = %q, want /api/nodes/update-check", gotPath)
	}
}
