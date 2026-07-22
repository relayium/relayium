package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// "Not eligible" is the answer on essentially every poll of every node,
// forever (critical 1): it must exit 0 (exitOK), not a non-zero code. Exiting
// non-zero here would mark the systemd unit `failed` on every steady-state
// poll, permanently red across the whole fleet, and the one time an update
// genuinely fails would look identical to that noise.
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
	if code != exitOK {
		t.Errorf("code = %d, want exitOK (%d): not-my-turn must never mark the systemd unit failed", code, exitOK)
	}
}

// End-to-end teeth test for critical 1: the full `relayium-node update`
// invocation (runUpdate, not just the resolve helper) must exit 0 when
// central says it isn't this node's turn.
func TestRunUpdateNotEligibleExitsZero(t *testing.T) {
	h := &centralHandler{status: 200, token: "tok",
		resp: map[string]any{"targetVersion": "", "eligible": false}}
	srv := httptest.NewServer(h)
	defer srv.Close()

	dir := t.TempDir()
	writeState(t, dir, "node-1")
	uc := updateConfig{StateDir: dir, BinPath: filepath.Join(dir, "relayium-node"), CentralURL: srv.URL, NodeToken: "tok"}

	var out, errBuf bytes.Buffer
	if code := runUpdate(uc, &out, &errBuf); code != exitOK {
		t.Errorf("runUpdate code = %d, want exitOK (%d) (stderr=%s)", code, exitOK, errBuf.String())
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

// resultForExitCode must match the exit-code table exactly. exitAlreadyFailed
// and exitPrecondition map to "skipped" (important 3, not ""): decideFleet's
// graceful-skip branch exists specifically to advance the rollout queue past
// a node that will never reach the target, without halting it — a node that
// refuses locally and reports nothing just keeps heartbeating happily until
// the 15-minute silence check halts the ENTIRE fleet rollout for a human.
// Only exitUsage (bad flags; nothing was even attempted) has nothing to tell
// central and maps to "".
func TestResultForExitCode(t *testing.T) {
	cases := map[int]string{
		exitOK:            "ok",
		exitUpdateFailed:  "failed",
		exitRestartFailed: "rolled_back",
		exitNotHealthy:    "rolled_back",
		exitUsage:         "",
		exitAlreadyFailed: "skipped",
		exitPrecondition:  "skipped",
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
	recordPendingResult(dir, exitUsage, &bytes.Buffer{}) // must not clobber the above
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

// Teeth test for important 2: a hand-run -to must never record a pending
// result, no matter its outcome — central's queue can't distinguish an
// uncommanded success from a genuine advance to the target, and on the node
// that currently holds the fleet slot, reporting one anyway would make
// decideFleet return `wait` forever with no halt to explain it. This test
// forces the already-failed refusal so no real network/systemd is needed.
func TestRunUpdateManualToDoesNotRecordPendingResult(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	var w bytes.Buffer
	recordFailed(dir, "v1.2.3", &w)

	// TargetTag set directly (as a hand-typed -to would), TargetFromCentral
	// left false. The already-failed guard returns before any systemctl call,
	// so runUpdate's real systemctlCtl is safe to exercise here.
	uc := updateConfig{StateDir: dir, BinPath: bin, TargetTag: "v1.2.3", Repo: updateRepo}

	var out, errBuf bytes.Buffer
	code := runUpdate(uc, &out, &errBuf)
	if code != exitAlreadyFailed {
		t.Fatalf("code = %d, want exitAlreadyFailed (%d) (stderr=%s)", code, exitAlreadyFailed, errBuf.String())
	}
	if got := loadPendingResult(dir); got != "" {
		t.Errorf("loadPendingResult after a manual -to = %q, want none recorded", got)
	}
}

// Companion positive case: the same outcome reached via central DOES get
// recorded, now that resultForExitCode reports "skipped" for it (important
// 3) — proving TargetFromCentral, not the exit code, is what gates reporting.
func TestRunUpdateCentralDrivenAlreadyFailedRecordsSkipped(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "relayium-node")
	if err := os.WriteFile(bin, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	var w bytes.Buffer
	recordFailed(dir, "v1.2.3", &w)

	uc := updateConfig{StateDir: dir, BinPath: bin, TargetTag: "v1.2.3", Repo: updateRepo, TargetFromCentral: true}
	var out, errBuf bytes.Buffer
	code := runUpdate(uc, &out, &errBuf)
	if code != exitAlreadyFailed {
		t.Fatalf("code = %d, want exitAlreadyFailed (%d) (stderr=%s)", code, exitAlreadyFailed, errBuf.String())
	}
	if got := loadPendingResult(dir); got != "skipped" {
		t.Errorf("loadPendingResult = %q, want %q", got, "skipped")
	}
}

// Teeth test for important 4: the root-run updater must never create
// state.json (or the state directory) on a node that isn't registered yet —
// doing so as root leaves a root-owned file the unprivileged node service can
// never read, turning a benign polling gap into a bricked node.
func TestResolveTargetFromCentralDoesNotCreateStateFile(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "not-yet-created")
	uc := updateConfig{StateDir: dir, CentralURL: "http://127.0.0.1:1", NodeToken: "tok"}

	var out, errBuf bytes.Buffer
	if _, ok := resolveTargetFromCentral(&uc, &out, &errBuf); ok {
		t.Fatal("resolveTargetFromCentral ok = true with no state.json, want refused")
	}
	if _, err := os.Stat(dir); err == nil {
		t.Error("resolveTargetFromCentral created the state directory — the root-run updater must never do this")
	}
}

func TestRecordPendingResultDoesNotCreateStateDir(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "not-yet-created")
	var w bytes.Buffer
	recordPendingResult(dir, exitUpdateFailed, &w)
	if _, err := os.Stat(dir); err == nil {
		t.Error("recordPendingResult created the state directory — it must only ever write into an existing one")
	}
}

// Minor 5: an unconfigured central URL must be a clear, distinct failure —
// not a mysterious http.NewRequest error on a scheme-less URL re-reported as
// an "update failed" every 10 minutes.
func TestResolveTargetFromCentralRequiresCentralURL(t *testing.T) {
	dir := t.TempDir()
	writeState(t, dir, "node-1")
	uc := updateConfig{StateDir: dir, CentralURL: "", NodeToken: "tok"}

	var out, errBuf bytes.Buffer
	code, ok := resolveTargetFromCentral(&uc, &out, &errBuf)
	if ok {
		t.Fatal("resolveTargetFromCentral ok = true with no CentralURL configured")
	}
	if code != exitPrecondition {
		t.Errorf("code = %d, want exitPrecondition (%d)", code, exitPrecondition)
	}
	if !bytes.Contains(errBuf.Bytes(), []byte("RELAYIUM_CENTRAL_URL")) {
		t.Errorf("stderr = %q, want it to name RELAYIUM_CENTRAL_URL so an operator knows what to set", errBuf.String())
	}
}
