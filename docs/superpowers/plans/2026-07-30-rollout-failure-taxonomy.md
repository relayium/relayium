# Rollout Failure Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A node that cannot obtain a release stops being a reason to halt the whole fleet, while a node that obtained it and failed verification becomes something the panel names as such.

**Architecture:** `selfupdate.Update` classifies its failures so the caller can tell "could not fetch" from "fetched, verification failed". The node maps them to distinct exit codes and reports distinct results. `decideFleet` advances past the first and halts loudly on the second. The panel shows a finished-but-incomplete rollout and offers a per-node retry, guarded on both the row and the track.

**Tech Stack:** Go standard library only.

**Spec:** `docs/superpowers/specs/2026-07-30-rollout-failure-taxonomy-design.md`

## Global Constraints

- **Anything that fails while obtaining bytes is a fetch failure, including a definitive 404.** A 404 may simply mean "this mirror does not carry that file". The node still refuses to install — it only reports the refusal differently — so the guarantee that an unsigned or unverified build is never installed is unchanged. A release genuinely published without a signature then fails on *every* node and surfaces as a rollout that updated nobody, which is legible; a mirror that 404s the signature on purpose achieves denial of service, not compromise, and surfaces the same way.
- **This change must not relax verification.** It splits a conflated signal and moves the halves in opposite directions: unreachability stops halting, verification failure becomes explicitly named. Shipping only the first half is worse than shipping nothing.
- **`status` gains no new value.** The finished-but-incomplete state is derived and rendered, never stored as a fourth status. `status` is read as a predicate in a dozen places and eight defects in the past week were a predicate that did not match what it described.
- Retry requires **both** a passed-over row and a `complete` track, checked in the handler as well as the template.
- All user-facing strings Chinese. Conventional commits, messages in English. No real node IP addresses.

---

### Task 1: `selfupdate` classifies its failures

**Files:**
- Modify: `server/selfupdate/selfupdate.go` (sentinel errors; wrap the four call sites in `Update`)
- Create: `server/selfupdate/classify_test.go`

**Interfaces:**
- Produces, consumed by Task 2: `selfupdate.ErrFetch` and `selfupdate.ErrVerify`, both `error` values matchable with `errors.Is`

- [ ] **Step 1: Write the failing tests**

Create `server/selfupdate/classify_test.go`:

```go
package selfupdate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// updateAgainst runs Update against a stand-in release host and returns the
// error. TargetTag is set so LatestTag is never called.
func updateAgainst(t *testing.T, h http.Handler) error {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	target := filepath.Join(dir, "relayium")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, _, _, err := Update(context.Background(), Options{
		Repo: "relayium/relayium", TargetTag: "v9.9.9",
		CurrentVersion: "v0.0.1", TargetPath: target,
		GOOS: "linux", GOARCH: "amd64",
		DownloadBase: srv.URL, APIBase: srv.URL,
		HTTP: srv.Client(),
	}, io.Discard)
	if err == nil {
		t.Fatal("expected Update to fail")
	}
	return err
}

// A host that cannot serve the asset is a FETCH failure, and 404 counts: a
// mirror may simply not carry the file. The node refuses to install either
// way; only the fleet's reaction differs.
func TestUpdateClassifiesMissingAssetAsFetch(t *testing.T) {
	err := updateAgainst(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	if !errors.Is(err, ErrFetch) {
		t.Fatalf("err = %v, want ErrFetch", err)
	}
	if errors.Is(err, ErrVerify) {
		t.Fatalf("a missing asset must not read as a verification failure: %v", err)
	}
}

// The signature file is downloaded too, so a host that cannot serve IT is also
// a fetch failure. Getting this wrong is the whole bug: an unreachable node
// would keep halting the fleet through the signature path.
//
// Exercised against verifyReleaseSignature directly rather than through Update.
// Reaching that step via Update would require serving a real archive AND a
// checksums.txt whose hash matches it, because verifyChecksum runs first —
// setup that tests the harness rather than the classification.
func TestVerifyReleaseSignatureClassifiesAMissingSigAsFetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()
	tmp := t.TempDir()
	sums := filepath.Join(tmp, "checksums.txt")
	if err := os.WriteFile(sums, []byte("whatever\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o := Options{Repo: "relayium/relayium", DownloadBase: srv.URL, HTTP: srv.Client()}
	err := verifyReleaseSignature(context.Background(), o, srv.URL, tmp, sums, io.Discard)
	if err == nil {
		t.Fatal("expected a missing signature to be an error")
	}
	if !errors.Is(err, ErrFetch) {
		t.Fatalf("err = %v, want ErrFetch — an unreachable host must not read as a verification failure", err)
	}
	if errors.Is(err, ErrVerify) {
		t.Fatalf("a signature that could not be downloaded is not a failed verification: %v", err)
	}
}

// Bytes that arrived but do not match checksums.txt are a VERIFY failure --
// the category that must still halt the fleet.
func TestUpdateClassifiesBadChecksumAsVerify(t *testing.T) {
	err := updateAgainst(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if filepath.Base(r.URL.Path) == "checksums.txt" {
			w.Write([]byte("0000000000000000000000000000000000000000000000000000000000000000  relayium_linux_amd64.tar.gz\n"))
			return
		}
		w.Write([]byte("not the archive those bytes hash to"))
	}))
	if !errors.Is(err, ErrVerify) {
		t.Fatalf("err = %v, want ErrVerify", err)
	}
	if errors.Is(err, ErrFetch) {
		t.Fatalf("a checksum mismatch must not read as a fetch failure: %v", err)
	}
}

// The two sentinels must be distinguishable from each other, or every caller's
// switch collapses.
func TestFetchAndVerifyAreDistinct(t *testing.T) {
	if errors.Is(ErrFetch, ErrVerify) || errors.Is(ErrVerify, ErrFetch) {
		t.Fatal("ErrFetch and ErrVerify must not match each other")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./selfupdate/ -run 'TestUpdateClassifies|TestFetchAndVerify' -v`
Expected: FAIL — `undefined: ErrFetch`, `undefined: ErrVerify`

- [ ] **Step 3: Add the sentinels and wrap the call sites**

In `server/selfupdate/selfupdate.go`, near the other package-level declarations:

```go
// ErrFetch and ErrVerify classify why an update did not happen, because the
// fleet's reaction to the two is opposite.
//
// ErrFetch means the bytes could not be OBTAINED -- DNS, TLS, a reset, a 404.
// It says nothing about the release: it is a property of this machine's path to
// the host. A 404 is deliberately on this side; a mirror may simply not carry a
// file, and the node refuses to install either way.
//
// ErrVerify means the bytes ARRIVED and did not check out -- a checksum
// mismatch, or a signature that does not verify against the key compiled into
// this binary. That is either a broken release or something serving bytes it
// should not be, and it is the one category here that can be a security event.
var (
	ErrFetch  = errors.New("selfupdate: could not fetch release artifact")
	ErrVerify = errors.New("selfupdate: release artifact failed verification")
)
```

Then wrap, in `Update`:

- the two `download(...)` calls — `fmt.Errorf("download %s: %w: %w", asset, ErrFetch, err)` and the same shape for `checksums`;
- `verifyChecksum(...)` — `fmt.Errorf("%w: %w", ErrVerify, err)`;
- `verifyReleaseSignature(...)` — this one needs care. It performs a download *and* a verification. Read it: the download of `checksums.txt.sig` must produce `ErrFetch`, and a signature that downloads but does not verify must produce `ErrVerify`. Wrap inside that function at the two points, not at the call site, since the call site cannot tell them apart.

`fmt.Errorf` with two `%w` verbs requires Go 1.20+; the module is well past that. Confirm the wrapping preserves the underlying error too — the tests only check the sentinels, but an operator reading the log needs the cause.

- [ ] **Step 4: Run the tests**

Run: `cd server && go test ./selfupdate/ -v`
Expected: PASS, including every pre-existing test in that package.

- [ ] **Step 5: Commit**

```bash
git add server/selfupdate/selfupdate.go server/selfupdate/classify_test.go
git commit -m "feat(update): distinguish could-not-fetch from failed-verification

exitUpdateFailed's comment already said it covered 'download/checksum/signature
failed' -- three events under one name, and the fleet halts on all of them. A
node that cannot reach the release host tells you nothing about the release,
while bytes that arrive and fail their signature are the one thing here that can
be a security event.

A 404 counts as fetch, deliberately: a mirror may not carry a file, and the node
refuses to install either way, so only the fleet's reaction differs. A release
truly published without a signature then fails on every node and surfaces as a
rollout that updated nobody.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: the node reports the two apart

**Files:**
- Modify: `server/cmd/relayium-node/update.go` (new exit code, the exit-code table comment, `resultForExitCode`, the `Update` call site)
- Modify: `server/account/nodes.go:290` (`updateResults` gains the new value)
- Create: `server/cmd/relayium-node/classify_test.go`

**Interfaces:**
- Consumes: `selfupdate.ErrFetch`, `selfupdate.ErrVerify` from Task 1
- Produces, consumed by Tasks 3-5: the result string `"unreachable"`, and `exitFetchFailed` in the node's exit-code vocabulary

Read the exit-code table comment at the top of `update.go` before editing — it is the file's index of this vocabulary and must stay accurate.

- [ ] **Step 1: Write the failing test**

Create `server/cmd/relayium-node/classify_test.go`:

```go
package main

import (
	"errors"
	"fmt"
	"testing"

	"github.com/relayium/relayium/selfupdate"
)

// The mapping is the whole point of the change, so it is asserted directly
// rather than through a message. A test that keys on error text goes red when
// someone rewords a message and green when someone breaks the classification.
func TestExitCodeForUpdateError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"fetch", fmt.Errorf("download x: %w: %w", selfupdate.ErrFetch, errors.New("no route to host")), exitFetchFailed},
		{"verify", fmt.Errorf("%w: %w", selfupdate.ErrVerify, errors.New("sha256 mismatch")), exitUpdateFailed},
		{"anything else", errors.New("disk full"), exitUpdateFailed},
	}
	for _, tc := range cases {
		if got := exitCodeForUpdateError(tc.err); got != tc.want {
			t.Fatalf("%s: exitCodeForUpdateError = %d, want %d", tc.name, got, tc.want)
		}
	}
}

// A node that could not obtain the artifact must report something central can
// advance past. Reporting "failed" is what halts the fleet for one machine's
// network.
func TestResultForFetchFailureIsNotFailed(t *testing.T) {
	got := resultForExitCode(exitFetchFailed)
	if got == "failed" || got == "rolled_back" {
		t.Fatalf("resultForExitCode(exitFetchFailed) = %q, which halts the track", got)
	}
	if got != "unreachable" {
		t.Fatalf("resultForExitCode(exitFetchFailed) = %q, want unreachable", got)
	}
}

// Verification failure keeps halting. This is the regression guard on the half
// of the change that must NOT loosen.
func TestResultForVerificationFailureStillHalts(t *testing.T) {
	if got := resultForExitCode(exitUpdateFailed); got != "failed" {
		t.Fatalf("resultForExitCode(exitUpdateFailed) = %q, want failed", got)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./cmd/relayium-node/ -run 'TestExitCodeForUpdateError|TestResultFor' -v`
Expected: FAIL — `undefined: exitFetchFailed`, `undefined: exitCodeForUpdateError`

- [ ] **Step 3: Implement**

In `server/cmd/relayium-node/update.go`:

```go
	// exitFetchFailed: the artifact could not be OBTAINED (DNS, TLS, a reset,
	// a 404). Distinct from exitUpdateFailed because it says nothing about the
	// release -- central advances the rollout queue past this node instead of
	// halting the fleet for one machine's network. See selfupdate.ErrFetch.
	exitFetchFailed = 8
```

```go
// exitCodeForUpdateError classifies a selfupdate.Update failure. Only the fetch
// case is special: everything else, including a verification failure, keeps the
// existing exitUpdateFailed so the track still halts.
func exitCodeForUpdateError(err error) int {
	if errors.Is(err, selfupdate.ErrFetch) {
		return exitFetchFailed
	}
	return exitUpdateFailed
}
```

Add `case exitFetchFailed: return "unreachable"` to `resultForExitCode`, and use `exitCodeForUpdateError` at the `selfupdate.Update` call site in place of the bare `exitUpdateFailed`. Update the exit-code table comment at the top of the file to include 8, matching the style of the existing rows.

In `server/account/nodes.go:290`, add `"unreachable": true` to `updateResults`, with a comment: central must accept it before any node can send it, which the deployment order already guarantees — central deploys on every push to `main`, nodes only when a rollout reaches them.

- [ ] **Step 4: Run the tests**

Run: `cd server && go build ./... && go vet ./cmd/relayium-node/ ./account/ && go test ./cmd/relayium-node/ ./account/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cmd/relayium-node/update.go server/cmd/relayium-node/classify_test.go server/account/nodes.go
git commit -m "feat(node): report could-not-fetch as its own result

A node that never obtained the artifact now exits 8 and reports 'unreachable'
instead of 'failed'. Verification failures keep exitUpdateFailed and keep
halting -- that half must not loosen, and it has its own regression test.

Central accepts the new value before any node can send it: central deploys on
every push to main, nodes only when a rollout reaches them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `decideFleet` advances past it, and names a verification failure

**Files:**
- Modify: `server/account/rollout_fleet.go:228-250`
- Create: `server/account/rollout_taxonomy_test.go`

**Interfaces:**
- Consumes: the `"unreachable"` result from Task 2
- Produces, consumed by Tasks 4-5: `decideFleet` treats `"unreachable"` like `"skipped"` for queue advancement

- [ ] **Step 1: Write the failing tests**

Create `server/account/rollout_taxonomy_test.go`:

```go
package account

import (
	"strings"
	"testing"
)

func fleetTrackAt(target, status, current, first string) RolloutTrack {
	return RolloutTrack{Track: "fleet", TargetVersion: target, Status: status,
		CurrentNodeID: current, FirstNodeID: first, StageStartedAt: 1000}
}

// The change: a node that could not fetch does not stop the fleet.
func TestDecideFleetAdvancesPastUnreachable(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "unreachable"},
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 2000},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action == "halt" {
		t.Fatalf("a node that could not fetch halted the fleet: %+v", got)
	}
}

// The half that must not loosen.
func TestDecideFleetStillHaltsOnVerificationFailure(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "failed"},
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 2000},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action != "halt" {
		t.Fatalf("a verification failure must still halt: %+v", got)
	}
	if !strings.Contains(got.Reason, "n1") {
		t.Fatalf("the halt reason must name the node: %q", got.Reason)
	}
}

// Regression guard: splitting a signal most easily damages the value that was
// already correct.
func TestDecideFleetOkIsUnchanged(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v2.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "ok"},
	}
	if got := decideFleet(tr, nodes, 2000); got.Action == "halt" {
		t.Fatalf("a successful node halted the track: %+v", got)
	}
}

// The no-op rollout. Every node fails to fetch, the queue reaches the end, and
// the track must not look like a clean success. This only appears when ALL
// nodes fail and no ordinary test reaches it.
func TestDecideFleetEveryNodeUnreachable(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "unreachable"},
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "unreachable"},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action == "halt" {
		t.Fatalf("a fleet-wide fetch failure should finish the queue, not halt: %+v", got)
	}
	// Whatever it returns, no node is on target -- Task 4 renders that.
	for _, n := range nodes {
		if n.Version == tr.TargetVersion {
			t.Fatal("test setup wrong: no node should be on target here")
		}
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./account/ -run TestDecideFleet -v`
Expected: `TestDecideFleetAdvancesPastUnreachable` and `TestDecideFleetEveryNodeUnreachable` FAIL (the track halts); the other two PASS — they pin behaviour that must not change.

- [ ] **Step 3: Implement**

In `server/account/rollout_fleet.go`, the branch at :228 currently halts on `failed` or `rolled_back`. Extend the neighbouring `skipped` branch (:248) to also cover `"unreachable"`, so the queue advances, and leave the halt branch alone. Read both branches before editing: the `skipped` path sets a variable the pick step consults, and `"unreachable"` must join it there rather than being handled separately.

Make the halt reason for `failed` name it as a verification-or-install failure rather than a bare "failed to update", so the panel can distinguish it from a node that never got the bytes. Keep the node ID in the message — a test pins it.

- [ ] **Step 4: Run the tests**

Run: `cd server && go build ./... && go vet ./account/ && go test ./account/`
Expected: PASS, including every pre-existing rollout test.

- [ ] **Step 5: Commit**

```bash
git add server/account/rollout_fleet.go server/account/rollout_taxonomy_test.go
git commit -m "feat(rollout): advance past a node that could not fetch

One machine's network stops being a reason to stop the fleet. Verification
failures keep halting and now say so in the reason, so the panel can tell a node
that never got the bytes from one that got them and rejected them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: the panel shows a finished-but-incomplete rollout

**Files:**
- Modify: `server/account/admin_rollout.go` (view fields, populated in `rolloutPanel`)
- Modify: `server/account/admin_templates.go` (the status line)
- Modify: `server/account/rollout_status.go` (a band for the two passed-over results)
- Create: `server/account/admin_rollout_incomplete_test.go`

**Interfaces:**
- Consumes: the `"unreachable"` result
- Produces, consumed by Task 5: `rolloutNodeView.PassedOver bool` — true when the row's result is `"unreachable"` or `"skipped"`

**The passed-over list is derived, not stored.** `rolloutPanel` already has every node and computes `onTarget`, so "not on target and passed over" is a render-time fact. Storing it on the track row would be a second copy that goes stale the moment a node updates; deriving it is self-healing and adds no schema.

- [ ] **Step 1: Write the failing test**

Create `server/account/admin_rollout_incomplete_test.go`, using this package's existing admin-server helpers (`newAdminSettingsServer(t)`, `adminLogin(t, ts)`, `adminDashboardHTML(t, ts, cookie)`, `seedRolloutNode`):

```go
package account

import (
	"context"
	"strings"
	"testing"
	"time"
)

// A completed track that left nodes behind must not read as a clean success.
func TestPanelShowsCompletedWithNodesLeftBehind(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-done", "fleet", "", "v2.0.0", "v1.0.0", "ok")
	seedRolloutNode(t, store, "n-stuck", "fleet", "", "v1.0.0", "v1.0.0", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "complete", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "未更新") {
		t.Fatal("a completion that left a node behind must say so")
	}
	if !strings.Contains(body, "拿不到产物") {
		t.Fatal("the row must say why the node was passed over")
	}
}

// A clean completion must NOT acquire the new copy.
func TestPanelCleanCompletionSaysNothingExtra(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-done", "fleet", "", "v2.0.0", "v1.0.0", "ok")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "complete", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(adminDashboardHTML(t, ts, cookie), "未更新") {
		t.Fatal("a clean completion must not claim nodes were left behind")
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./account/ -run TestPanel -v`
Expected: `TestPanelShowsCompletedWithNodesLeftBehind` FAILS; `TestPanelCleanCompletionSaysNothingExtra` already passes and must keep passing.

- [ ] **Step 3: Implement**

Add to `rolloutNodeView`:

```go
	// PassedOver is true when the queue moved on without this node -- it could
	// not obtain the artifact, or it declined locally. Distinct from a failure:
	// a passed-over node made no judgement about the build.
	PassedOver bool
	// PassedOverReason is the Chinese label for WHY, because the operator's next
	// move differs: 拿不到产物 means fix the network and retry, 本地前置条件
	// usually means the node had its own reason and will decline again.
	PassedOverReason string
```

Add to `rolloutPanelView` a count of nodes not on target that are passed over, and populate both in `rolloutPanel`'s row loop from `n.UpdateResult`.

In `admin_templates.go`, extend the status line so a `complete` track with a non-zero count renders `完成，但 N 台未更新` instead of the plain completion text, and render `PassedOverReason` on the row.

In `rollout_status.go`, give the two passed-over results a band so the row reads consistently with the bands added earlier; do not set `Alarm` — a passed-over node is not an alarm, it is a fact.

- [ ] **Step 4: Run the tests**

Run: `cd server && go build ./... && go vet ./account/ && go test ./account/ -run 'TestPanel|TestRollout|TestAdmin|TestRelease' -v 2>&1 | tail -20` then `go test ./account/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/account/admin_rollout.go server/account/admin_templates.go \
        server/account/rollout_status.go server/account/admin_rollout_incomplete_test.go
git commit -m "feat(admin): a completion that left nodes behind says so

A release published with a broken asset fails on every node, the queue reaches
the end, and a plain 完成 there would be a green panel over a rollout that
updated nobody. The count is derived from the node rows rather than stored:
a stored list goes stale the moment a node updates, and status gains no fourth
value.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: retry, guarded on the row and on the track

**Files:**
- Modify: `server/account/store.go` (one interface method)
- Modify: `server/account/rollout_store.go` (its implementation)
- Modify: `server/account/admin.go` (one route)
- Modify: `server/account/admin_rollout.go` (the handler)
- Modify: `server/account/admin_templates.go` (the button)
- Modify: `server/account/audit.go` (an action)
- Create: `server/account/admin_rollout_retry_test.go`

**Interfaces:**
- Consumes: `rolloutNodeView.PassedOver` from Task 4
- Produces: `RetryRolloutNode(ctx context.Context, track, nodeID string, at int64) (bool, error)`

**The primitive this needs does not exist — do not try to reuse `ResumeRolloutTrack`.** It is `WHERE track = ? AND status = 'halted'`, so it does nothing on a `complete` track, and it clears `current_node_id` and `first_node_id`, which a retry must not do. Reaching for it would either no-op silently or destroy the finished rollout's identity.

`RetryRolloutNode` is two statements: clear that node's `update_result`, and

```sql
UPDATE node_rollout SET status = 'rolling', stage_started_at = ?
  WHERE track = ? AND status = 'complete'
```

**The `status = 'complete'` condition lives in the SQL, not only in the handler.** That makes the track guard a compare-and-swap rather than a read-then-write: a halt landing between the handler's read and its write cannot be clobbered. `rollout_store.go` documents that exact hazard for its other statements — a lost halt is the one write that must never be lost — and this follows the same discipline. It returns `false` when the row was not in `complete`, which the handler surfaces as a refusal.

It touches neither `target_version` nor `first_node_id`.

- [ ] **Step 1: Write the failing tests**

Create `server/account/admin_rollout_retry_test.go`. Use `postAdminForm(t, ts, cookie, path, url.Values)`, the existing helper that satisfies `CSRFGuard`.

```go
package account

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func seedRetryCase(t *testing.T, store *SQLiteStore, nodeResult, trackStatus string) {
	t.Helper()
	ctx := context.Background()
	seedRolloutNode(t, store, "n-x", "fleet", "", "v1.0.0", "v1.0.0", nodeResult)
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: trackStatus,
		HaltedReason: "node n-other failed verification", StageStartedAt: time.Now().Unix() - 3600,
	}); err != nil {
		t.Fatal(err)
	}
}

// Positive path. Without one, a handler that refuses everything passes.
func TestRetryRecommandsAPassedOverNode(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	seedRetryCase(t, store, "unreachable", "complete")

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-x"}}).Body.Close()

	n, ok, err := store.GetNode(context.Background(), "n-x")
	if err != nil || !ok {
		t.Fatalf("GetNode: %v/%v", ok, err)
	}
	if n.UpdateResult != "" {
		t.Fatalf("retry did not clear the node's result: %q", n.UpdateResult)
	}
	tr, _, err := store.GetRolloutTrack(context.Background(), "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "rolling" {
		t.Fatalf("retry left the track at %q", tr.Status)
	}
	if tr.TargetVersion != "v2.0.0" {
		t.Fatalf("retry changed the target version to %q", tr.TargetVersion)
	}
}

// The track guard belongs in the SQL, so assert it there too: RetryRolloutNode
// must report false rather than silently doing nothing, and must leave a halted
// track alone even when called directly.
func TestRetryRolloutNodeRefusesANonCompleteTrack(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedRetryCase(t, store, "unreachable", "halted")

	ok, err := store.RetryRolloutNode(ctx, "fleet", "n-x", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("RetryRolloutNode reported success against a halted track")
	}
	tr, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "halted" || tr.HaltedReason == "" {
		t.Fatalf("the halt did not survive: %+v", tr)
	}
}

// The row guard: a node that judged the build is not one click from a re-run.
func TestRetryRefusesAFailedNode(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	seedRetryCase(t, store, "failed", "complete")

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-x"}}).Body.Close()

	n, _, _ := store.GetNode(context.Background(), "n-x")
	if n.UpdateResult != "failed" {
		t.Fatalf("retry cleared a verification failure: %q", n.UpdateResult)
	}
}

// The track guard -- the sideways route. A passed-over row on a track halted
// for ANOTHER node's failure must not restart the rollout.
func TestRetryRefusesOnAHaltedTrack(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	seedRetryCase(t, store, "unreachable", "halted")

	postAdminForm(t, ts, cookie, "/admin/rollout/fleet/retry", url.Values{"node": {"n-x"}}).Body.Close()

	tr, _, err := store.GetRolloutTrack(context.Background(), "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if tr.Status != "halted" {
		t.Fatalf("retry cleared a halt sideways: status is now %q", tr.Status)
	}
	if tr.HaltedReason == "" {
		t.Fatal("retry erased the halt reason")
	}
}

// The button follows the same two rules.
func TestRetryButtonRenderingFollowsBothGuards(t *testing.T) {
	for _, tc := range []struct {
		name, result, status string
		want                 bool
	}{
		{"passed over, complete", "unreachable", "complete", true},
		{"failed, complete", "failed", "complete", false},
		{"passed over, halted", "unreachable", "halted", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, _, store := newAdminSettingsServer(t)
			cookie := adminLogin(t, ts)
			seedRetryCase(t, store, tc.result, tc.status)
			body := adminDashboardHTML(t, ts, cookie)
			if got := strings.Contains(body, "/admin/rollout/fleet/retry"); got != tc.want {
				t.Fatalf("retry button rendered=%v, want %v", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && go test ./account/ -run TestRetry -v`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Implement**

Register `POST /admin/rollout/fleet/retry` beside the other rollout routes, CSRF-guarded, following their registration style.

The handler reads `node`, then:

1. reads the node and **refuses unless its result is `"unreachable"` or `"skipped"`**;
2. reads the fleet track and **refuses unless its status is `complete`**;
3. clears the node's update result and sets the track to `rolling`, touching neither `TargetVersion` nor `FirstNodeID`.

Both refusals return a legible message via `renderAdminRolloutError`, in the style the neighbouring rollout handlers use. Give it its own audit action, following the precedent that entry point matters to an incident review.

Add the button to the node row, rendered only when `PassedOver` **and** the panel's track status is `complete`.

- [ ] **Step 4: Run everything**

Run: `cd server && go build ./... && go vet ./account/ && go test ./account/` then `go test -race ./account/`
Expected: PASS both. **The race run on this package takes about five minutes; that is normal.**

Then `./scripts/check-production-identifiers.sh`
Expected: PASSED.

- [ ] **Step 5: Commit**

```bash
git add server/account/admin.go server/account/admin_rollout.go \
        server/account/admin_templates.go server/account/audit.go \
        server/account/admin_rollout_retry_test.go
git commit -m "feat(admin): retry a passed-over node without SSH

Clearing the node's result makes it a candidate again; the track goes back to
rolling without touching the target or the canary.

Two guards, and both are needed. A failed or rolled-back node judged the build,
so retrying it is a shortest path around a verification failure -- that stays the
whole-track 继续, which shows the reason and confirms. And retry requires a
complete track: on a halted one, retrying an innocent passed-over row would
restart a rollout that stopped for a reason nobody addressed, reaching the same
place sideways.

The button's absence is not the guard; the handler re-reads both.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the reviewer

Four things here are the shape that produced eight defects in the past week — a guard or predicate that does not match what it claims to describe:

- **`decideFleet`'s halt branch must still fire for `failed` and `rolled_back`.** The change adds a value to the *advance* branch; if it also lands in the halt branch's condition, or removes one, the half that must not loosen has loosened. Task 3's `TestDecideFleetStillHaltsOnVerificationFailure` is the guard.
- **The signature download is a fetch, not a verification.** If it classifies as `ErrVerify`, an unreachable node still halts the fleet through that path and the whole change is inert for its motivating case.
- **Retry's two guards are independent.** Check both are enforced in the handler, not only rendered on the button, and that neither is expressed as the other.
- **This plan asserts things about `decideFleet`'s skipped branch, `updateResults`, the admin route style and the panel helpers.** Check each against the file. The most expensive error of the week was a design built on an unverified claim about existing code.
