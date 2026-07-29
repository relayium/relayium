# Admin Release Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin panel notices a newer release and offers one click to roll it out, instead of the operator having to know the version and type it.

**Architecture:** Central polls GitHub's `releases/latest` hourly through the `selfupdate.LatestTag` helper that already exists, persists the result and the operator's dismissal in one row, and a pure function turns that row plus the fleet track into what the panel renders. The button is offered only when pressing it cannot destroy a rollout in flight.

**Tech Stack:** Go standard library, the existing `server/selfupdate` package, SQLite.

**Spec:** `docs/superpowers/specs/2026-07-29-admin-release-check-design.md`

## Global Constraints

- **The check only ever makes a positive claim.** It may say a newer version exists; it must never say the deployment is up to date. A failed request degrades to silence, never to a false statement of currency. No copy anywhere in this change may assert currency.
- **The rollout button is offered only when the fleet track is not `rolling`.** `setTargetVersion` (`server/account/rollout_gate.go:79-135`) has no status gate on the fleet path: it rewrites the whole row, resetting `Status` to `rolling`, restamping `StageStartedAt`, and clearing `CurrentNodeID`/`FirstNodeID`. Pressing it mid-rollout silently discards a canary that may be nearly through its six-hour window.
- **Fleet track only.** The BYO track pushes to users' machines; it gets no one-click path.
- **When the check is disabled, no request is made at all** — not a request whose result is discarded. That is the promise made to self-hosters and it has a test.
- Version ordering comes from `server/selfupdate`. Do not write a second comparison in `account`.
- A failed check must leave the stored result untouched; a dismissal must not disturb the stored result; a successful check must not disturb the dismissal.
- All user-facing strings Chinese. Conventional commits, messages in English. No real node IP addresses.

---

### Task 1: version ordering, the table, and the store methods

**Files:**
- Modify: `server/selfupdate/selfupdate.go:168` (export `compareVersions`)
- Modify: `server/account/store.go` (the `ReleaseCheck` type and three interface methods)
- Modify: `server/account/sqlite.go` (migration statement + the three implementations)
- Create: `server/account/releasecheck_store_test.go`

**Interfaces:**
- Produces, all consumed by Tasks 2 and 3:
  - `selfupdate.CompareVersions(a, b string) (int, bool)`
  - `type ReleaseCheck struct { LatestTag string; CheckedAt int64; DismissedTag string; DismissedAt int64 }`
  - `GetReleaseCheck(ctx context.Context) (ReleaseCheck, error)`
  - `SetReleaseCheckResult(ctx context.Context, tag string, at int64) error`
  - `SetReleaseCheckDismissed(ctx context.Context, tag string, at int64) error`

- [ ] **Step 1: Write the failing tests**

Create `server/account/releasecheck_store_test.go`:

```go
package account

import (
	"context"
	"testing"
)

// The row is created on demand: a deployment that has never checked reads a
// zero value rather than an error, because "never checked" is a state the
// panel renders, not a failure.
func TestReleaseCheckStartsEmpty(t *testing.T) {
	st := newTestStore(t)
	got, err := st.GetReleaseCheck(context.Background())
	if err != nil {
		t.Fatalf("GetReleaseCheck: %v", err)
	}
	if got.LatestTag != "" || got.CheckedAt != 0 || got.DismissedTag != "" || got.DismissedAt != 0 {
		t.Fatalf("fresh store returned %+v, want the zero value", got)
	}
}

// The two halves are written independently. A dismissal must not disturb the
// stored result, and a check must not disturb the dismissal -- otherwise a
// successful hourly check would silently un-dismiss a notice the operator
// already dealt with.
func TestReleaseCheckHalvesAreIndependent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	if err := st.SetReleaseCheckResult(ctx, "v1.2.0", 1000); err != nil {
		t.Fatal(err)
	}
	if err := st.SetReleaseCheckDismissed(ctx, "v1.2.0", 1100); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetReleaseCheck(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.LatestTag != "v1.2.0" || got.CheckedAt != 1000 {
		t.Fatalf("dismissal disturbed the result: %+v", got)
	}
	if got.DismissedTag != "v1.2.0" || got.DismissedAt != 1100 {
		t.Fatalf("dismissal not recorded: %+v", got)
	}

	// A later check records a newer tag and must leave the dismissal alone.
	if err := st.SetReleaseCheckResult(ctx, "v1.3.0", 2000); err != nil {
		t.Fatal(err)
	}
	got, err = st.GetReleaseCheck(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.LatestTag != "v1.3.0" || got.CheckedAt != 2000 {
		t.Fatalf("result not updated: %+v", got)
	}
	if got.DismissedTag != "v1.2.0" || got.DismissedAt != 1100 {
		t.Fatalf("check disturbed the dismissal: %+v", got)
	}
}

// Clearing the dismissal is how 撤销 works.
func TestReleaseCheckDismissalCanBeCleared(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if err := st.SetReleaseCheckDismissed(ctx, "v1.2.0", 1100); err != nil {
		t.Fatal(err)
	}
	if err := st.SetReleaseCheckDismissed(ctx, "", 1200); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetReleaseCheck(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.DismissedTag != "" {
		t.Fatalf("dismissal not cleared: %+v", got)
	}
}
```

Create `server/selfupdate/compare_export_test.go`:

```go
package selfupdate

import "testing"

// CompareVersions is exported because the admin panel decides whether a release
// is newer than what the fleet targets, and it lives in another package. The
// (result, ok) shape is load-bearing: an unparseable version must stay
// distinguishable from "equal", or a typo would read as "nothing new".
func TestCompareVersionsIsExported(t *testing.T) {
	if n, ok := CompareVersions("v1.3.0", "v1.2.9"); !ok || n <= 0 {
		t.Fatalf("CompareVersions(v1.3.0, v1.2.9) = %d, %v; want a positive comparison", n, ok)
	}
	if n, ok := CompareVersions("v1.2.0", "v1.2.0"); !ok || n != 0 {
		t.Fatalf("equal versions compared as %d, %v", n, ok)
	}
	if _, ok := CompareVersions("not-a-version", "v1.2.0"); ok {
		t.Fatal("an unparseable version reported ok; it must be distinguishable from equal")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./account/ -run TestReleaseCheck -v && go test ./selfupdate/ -run TestCompareVersionsIsExported -v`
Expected: FAIL — `st.GetReleaseCheck undefined`, `undefined: CompareVersions`

- [ ] **Step 3: Export the comparison**

In `server/selfupdate/selfupdate.go`, rename `compareVersions` to `CompareVersions` and update its doc comment to say why it is exported: the admin panel decides whether a release is newer than the fleet's target and lives in another package. Update its callers inside the package (grep `compareVersions(` — at the time of writing the only ones are in this file).

- [ ] **Step 4: Add the type, the interface methods and the migration**

In `server/account/store.go`, next to the settings block, add:

```go
// ReleaseCheck is the single row behind the admin panel's "a newer release
// exists" notice: what the last SUCCESSFUL check saw, and which tag the
// operator dismissed.
//
// Both halves are persisted rather than held per-process because central is
// built to run as several instances (see the admin-session and TOTP-guard
// notes on Service). Process-local state would have each instance polling on
// its own schedule and the "last checked" line jumping around depending on
// which one served the page, while the dismissal beside it stayed consistent.
//
// CheckedAt == 0 means no check has ever SUCCEEDED. That is a state the panel
// renders in its own words; it is never rendered as "up to date".
type ReleaseCheck struct {
	LatestTag    string
	CheckedAt    int64
	DismissedTag string
	DismissedAt  int64
}
```

and to the `Store` interface, after the settings methods:

```go
	// release check (admin "a newer release exists" notice)
	GetReleaseCheck(ctx context.Context) (ReleaseCheck, error)
	// SetReleaseCheckResult records a SUCCESSFUL check. A failed check must not
	// call this: leaving the previous values in place is what makes the panel
	// degrade to silence rather than to a false claim.
	SetReleaseCheckResult(ctx context.Context, tag string, at int64) error
	// SetReleaseCheckDismissed records (or, with an empty tag, clears) the
	// dismissal without touching the result.
	SetReleaseCheckDismissed(ctx context.Context, tag string, at int64) error
```

In `server/account/sqlite.go`, append to the migration statement list (the same list holding the `CREATE TABLE IF NOT EXISTS node_rollout` statement around line 524):

```go
		// One row, enforced by the CHECK, holding what the last successful
		// release check saw and which tag the operator dismissed. The two
		// halves are written by separate statements so neither can clobber the
		// other: a failed check must leave the result alone, and a dismissal
		// must not look like a check.
		`CREATE TABLE IF NOT EXISTS release_check (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  latest_tag TEXT NOT NULL DEFAULT '', checked_at INTEGER NOT NULL DEFAULT 0,
  dismissed_tag TEXT NOT NULL DEFAULT '', dismissed_at INTEGER NOT NULL DEFAULT 0)`,
```

- [ ] **Step 5: Implement the three methods**

Add to `server/account/sqlite.go`:

```go
func (s *SQLiteStore) GetReleaseCheck(ctx context.Context) (ReleaseCheck, error) {
	var rc ReleaseCheck
	err := s.reader().QueryRowContext(ctx,
		`SELECT latest_tag, checked_at, dismissed_tag, dismissed_at FROM release_check WHERE id = 1`).
		Scan(&rc.LatestTag, &rc.CheckedAt, &rc.DismissedTag, &rc.DismissedAt)
	if errors.Is(err, sql.ErrNoRows) {
		// Never checked and never dismissed. That is a state, not a failure:
		// the panel has its own wording for it.
		return ReleaseCheck{}, nil
	}
	return rc, err
}

func (s *SQLiteStore) SetReleaseCheckResult(ctx context.Context, tag string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO release_check (id, latest_tag, checked_at) VALUES (1, ?, ?)
		   ON CONFLICT(id) DO UPDATE SET latest_tag = excluded.latest_tag, checked_at = excluded.checked_at`,
		tag, at)
	return err
}

func (s *SQLiteStore) SetReleaseCheckDismissed(ctx context.Context, tag string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO release_check (id, dismissed_tag, dismissed_at) VALUES (1, ?, ?)
		   ON CONFLICT(id) DO UPDATE SET dismissed_tag = excluded.dismissed_tag, dismissed_at = excluded.dismissed_at`,
		tag, at)
	return err
}
```

Each `ON CONFLICT` updates only its own columns, which is what keeps the two halves independent. Check the imports at the top of the file already include `database/sql` and `errors`; add whichever is missing.

If the package has another `Store` implementation or a test double that must satisfy the interface, the compiler will say so — add the three methods there too rather than narrowing the interface.

- [ ] **Step 6: Run the tests**

Run: `cd server && go build ./... && go vet ./account/ ./selfupdate/ && go test ./account/ -run TestReleaseCheck -v && go test ./selfupdate/`
Expected: PASS.

Then the whole package: `cd server && go test ./account/`
Expected: PASS — this task adds a table and methods and renames one unexported function; nothing that passed before may fail.

- [ ] **Step 7: Commit**

```bash
git add server/selfupdate/selfupdate.go server/selfupdate/compare_export_test.go \
        server/account/store.go server/account/sqlite.go server/account/releasecheck_store_test.go
git commit -m "feat(admin): persist what the last release check saw

One row holding the last SUCCESSFUL check and the operator's dismissal, written
by two statements that update only their own columns. A failed check must leave
the result alone -- that is what lets the panel degrade to silence instead of to
a false claim of being current -- and a dismissal must not look like a check.

Persisted rather than held per-process because central is built to run as
several instances: process-local state would have each polling separately and
the last-checked line jumping around depending on which one served the page.

compareVersions is exported for the panel, which lives in another package. Its
(result, ok) shape is kept so an unparseable version stays distinguishable from
equal, rather than reading as nothing-new.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: the notice decision and the poller

**Files:**
- Create: `server/account/releasecheck.go`
- Create: `server/account/releasecheck_test.go`

**Interfaces:**
- Consumes: `ReleaseCheck`, `GetReleaseCheck`, `SetReleaseCheckResult` from Task 1; `selfupdate.CompareVersions` from Task 1; `RolloutTrack` from `store.go`
- Produces, consumed by Task 3:
  - `type releaseNoticeView struct { Show, OfferButton, Rolling bool; LatestTag, TargetTag, DismissedTag string; CheckedAt int64 }`
  - `releaseNotice(rc ReleaseCheck, fleet RolloutTrack, fleetFound bool) releaseNoticeView`
  - `type ReleaseChecker struct { Store ReleaseCheckStore; Now func() time.Time; Latest func(context.Context) (string, error); Log *log.Logger }` with `Run(ctx context.Context, interval time.Duration)`
  - `type ReleaseCheckStore interface { SetReleaseCheckResult(context.Context, string, int64) error }`

- [ ] **Step 1: Write the failing tests**

Create `server/account/releasecheck_test.go`:

```go
package account

import (
	"context"
	"errors"
	"io"
	"log"
	"testing"
	"time"
)

func TestReleaseNoticeOffersTheButtonWhenTheFleetIsIdle(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if !got.Show || !got.OfferButton {
		t.Fatalf("want a notice with a button, got %+v", got)
	}
	if got.LatestTag != "v1.3.0" || got.TargetTag != "v1.2.0" {
		t.Fatalf("versions wrong: %+v", got)
	}
}

// The constraint the whole design hangs off. setTargetVersion has no status
// gate: it rewrites the fleet row, resetting Status, restamping StageStartedAt
// and clearing CurrentNodeID/FirstNodeID. One click from a notice must not be
// able to discard a canary most of the way through its six-hour window.
func TestReleaseNoticeWithholdsTheButtonWhileRolling(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "rolling"}, true)
	if !got.Show {
		t.Fatal("the notice should still inform while a rollout is running")
	}
	if got.OfferButton {
		t.Fatal("pressing the button here would silently abandon the rollout in flight")
	}
	if !got.Rolling {
		t.Fatal("the notice must be able to say what is currently rolling")
	}
}

func TestReleaseNoticeHiddenWhenDismissed(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000, DismissedTag: "v1.3.0", DismissedAt: 1100},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if got.Show {
		t.Fatal("a dismissed version must not keep prompting")
	}
	if got.DismissedTag != "v1.3.0" {
		t.Fatal("the dismissal must stay visible so it can be undone")
	}
}

// Dismissal is per-version, so a newer release brings the notice back without
// the operator having to remember to re-enable anything.
func TestReleaseNoticeReturnsForANewerRelease(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.4.0", CheckedAt: 1000, DismissedTag: "v1.3.0", DismissedAt: 1100},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if !got.Show || !got.OfferButton {
		t.Fatalf("a newer release than the dismissed one must prompt again: %+v", got)
	}
}

func TestReleaseNoticeSilentWhenNothingIsNewer(t *testing.T) {
	for _, latest := range []string{"v1.2.0", "v1.1.9"} {
		got := releaseNotice(
			ReleaseCheck{LatestTag: latest, CheckedAt: 1000},
			RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
		if got.Show {
			t.Fatalf("latest=%s is not newer than the target; got %+v", latest, got)
		}
	}
}

// The whole point of the "positive claims only" rule: a deployment that has
// never checked successfully says nothing about being current.
// A deployment that switched the check off must not be told 尚未成功检查过
// forever: true, useless, and it implies something is broken when the operator
// turned it off deliberately. admin.go leaves the zero value in that case.
func TestReleaseNoticeZeroValueIsNotEnabled(t *testing.T) {
	var v releaseNoticeView
	if v.Enabled || v.Show || v.OfferButton {
		t.Fatalf("the zero view must render nothing at all: %+v", v)
	}
	if got := releaseNotice(ReleaseCheck{}, RolloutTrack{}, false); !got.Enabled {
		t.Fatal("releaseNotice is only called when the feature is on, so its result is Enabled")
	}
}

func TestReleaseNoticeSaysNothingWhenNeverChecked(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if got.Show {
		t.Fatalf("nothing has been checked; there is nothing to claim: %+v", got)
	}
	if got.CheckedAt != 0 {
		t.Fatal("CheckedAt must stay 0 so the panel can say 尚未成功检查过")
	}
}

// A track that was never configured still gets the notice — there is nothing
// to compare against, and offering the rollout is exactly what is wanted.
func TestReleaseNoticeWithNoTargetConfigured(t *testing.T) {
	got := releaseNotice(ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000}, RolloutTrack{}, false)
	if !got.Show || !got.OfferButton {
		t.Fatalf("want a notice with a button: %+v", got)
	}
	if got.TargetTag != "" {
		t.Fatalf("TargetTag should be empty so the panel can say so: %+v", got)
	}
}

// An unparseable stored tag must not read as "nothing new". Both cases matter,
// and the second is the one an earlier draft got wrong: the comparison against
// the fleet target only runs when there IS a target, so on a never-configured
// track an unreadable tag sailed past it and produced a button that
// setTargetVersion is guaranteed to reject.
func TestReleaseNoticeIgnoresAnUnparseableTag(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "not-a-version", CheckedAt: 1000},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if got.Show {
		t.Fatalf("an unparseable tag must not produce a prompt: %+v", got)
	}
	noTarget := releaseNotice(
		ReleaseCheck{LatestTag: "not-a-version", CheckedAt: 1000}, RolloutTrack{}, false)
	if noTarget.Show || noTarget.OfferButton {
		t.Fatalf("an unparseable tag on a never-configured track must stay silent: %+v", noTarget)
	}
}

// A DismissedTag that cannot be parsed must not silence everything forever.
// This is the guard on the `ok &&` in the dismissal comparison, which reads as
// redundant and is not: without it the unparseable tag compares as 0 and
// suppresses every future notice, with nothing on screen to say why.
func TestReleaseNoticeIgnoresAnUnparseableDismissal(t *testing.T) {
	got := releaseNotice(
		ReleaseCheck{LatestTag: "v1.3.0", CheckedAt: 1000, DismissedTag: "not-a-version", DismissedAt: 1100},
		RolloutTrack{Track: "fleet", TargetVersion: "v1.2.0", Status: "complete"}, true)
	if !got.Show || !got.OfferButton {
		t.Fatalf("an unreadable dismissal must not suppress a real release: %+v", got)
	}
}

// The property, in the shape the rollout panel's sweep established: per-case
// assertions are written from the same understanding as the code and drift with
// it. Offering the button must imply the fleet track is not rolling, in EVERY
// state, not just the one case above.
func TestReleaseNoticeButtonImpliesNotRolling(t *testing.T) {
	statuses := []string{"", "rolling", "halted", "complete"}
	tags := []string{"", "v1.1.0", "v1.2.0", "v1.3.0", "not-a-version"}
	times := []int64{0, 1000}
	for _, status := range statuses {
		for _, latest := range tags {
			for _, target := range tags {
				for _, dismissed := range tags {
					for _, at := range times {
						for _, found := range []bool{true, false} {
							rc := ReleaseCheck{LatestTag: latest, CheckedAt: at, DismissedTag: dismissed}
							tr := RolloutTrack{Track: "fleet", TargetVersion: target, Status: status}
							got := releaseNotice(rc, tr, found)
							if got.OfferButton && found && tr.Status == "rolling" {
								t.Fatalf("button offered on a rolling track: rc=%+v tr=%+v -> %+v", rc, tr, got)
							}
							if got.OfferButton && !got.Show {
								t.Fatalf("button offered without a notice: rc=%+v tr=%+v -> %+v", rc, tr, got)
							}
						}
					}
				}
			}
		}
	}
}

type fakeReleaseStore struct {
	tag string
	at  int64
	n   int
}

func (f *fakeReleaseStore) SetReleaseCheckResult(_ context.Context, tag string, at int64) error {
	f.tag, f.at, f.n = tag, at, f.n+1
	return nil
}

// A failed check must not write. Overwriting with "" would erase the last good
// answer and turn a network blip into an amnesiac panel.
func TestReleaseCheckerFailureDoesNotWrite(t *testing.T) {
	store := &fakeReleaseStore{}
	c := &ReleaseChecker{
		Store: store,
		Now:   func() time.Time { return time.Unix(2000, 0) },
		Latest: func(context.Context) (string, error) {
			return "", errors.New("network is unreachable")
		},
		Log: log.New(io.Discard, "", 0),
	}
	c.CheckOnce(context.Background())
	if store.n != 0 {
		t.Fatalf("a failed check wrote to the store %d time(s)", store.n)
	}
}

func TestReleaseCheckerSuccessWrites(t *testing.T) {
	store := &fakeReleaseStore{}
	c := &ReleaseChecker{
		Store:  store,
		Now:    func() time.Time { return time.Unix(2000, 0) },
		Latest: func(context.Context) (string, error) { return "v1.3.0", nil },
		Log:    log.New(io.Discard, "", 0),
	}
	c.CheckOnce(context.Background())
	if store.n != 1 || store.tag != "v1.3.0" || store.at != 2000 {
		t.Fatalf("store got tag=%q at=%d n=%d", store.tag, store.at, store.n)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./account/ -run 'TestReleaseNotice|TestReleaseChecker' -v`
Expected: FAIL — `undefined: releaseNotice`, `undefined: ReleaseChecker`

- [ ] **Step 3: Write the implementation**

Create `server/account/releasecheck.go`:

```go
package account

import (
	"context"
	"log"
	"time"

	"github.com/relayium/relayium/selfupdate"
)

// This file answers one question for the admin panel: is there a release newer
// than what the fleet is pointed at, and may the operator start it from here?
//
// It only ever makes a POSITIVE claim. It can say a newer version exists; it
// never says the deployment is current. A failed request, a rate limit or a
// GitHub outage therefore degrades to silence rather than to a false statement
// -- the panel prints when the last SUCCESSFUL check was, so silence stays
// legible.

// releaseNoticeView is what the panel renders. Zero value = render nothing.
type releaseNoticeView struct {
	// Enabled gates the whole block, including the freshness line. Without it
	// a deployment that deliberately set RELAYIUM_RELEASE_CHECK=false would be
	// told 尚未成功检查过 forever -- true, useless, and implying something is
	// wrong when the operator switched it off on purpose.
	Enabled     bool
	Show        bool
	OfferButton bool
	// Rolling is true when the fleet track is mid-rollout: the notice informs
	// but offers no button. See releaseNotice.
	Rolling      bool
	LatestTag    string
	TargetTag    string // "" when the fleet track was never configured
	DismissedTag string // non-empty: render the muted 已忽略 line
	CheckedAt    int64  // 0 = never checked successfully
}

// releaseNotice decides what the panel shows, from the stored check and the
// fleet track. Pure: no clock, no database, no HTTP.
//
// The button is withheld while the track is rolling, and that is the constraint
// this whole feature is built around. setTargetVersion (rollout_gate.go) has no
// status gate on the fleet path: it rewrites the whole row, resetting Status to
// rolling, restamping StageStartedAt, and clearing CurrentNodeID/FirstNodeID.
// Pressing it during a live rollout silently abandons it -- discarding, say, a
// canary five hours and fifty minutes into a six-hour observation window, with
// nothing shown to say so. That is defensible behind a form someone typed a
// version into. It is not defensible one click from a notification.
//
// The panel already refuses to render a control whose only possible outcome is
// a refusal. This is the case that is worse, because it succeeds.
func releaseNotice(rc ReleaseCheck, fleet RolloutTrack, fleetFound bool) releaseNoticeView {
	v := releaseNoticeView{
		Enabled:   true,
		LatestTag: rc.LatestTag, CheckedAt: rc.CheckedAt, DismissedTag: rc.DismissedTag,
	}
	if fleetFound {
		v.TargetTag = fleet.TargetVersion
	}
	// Never checked successfully: there is nothing to claim, in either
	// direction. The panel says 尚未成功检查过 from CheckedAt == 0.
	if rc.CheckedAt == 0 || rc.LatestTag == "" {
		return v
	}
	// A tag we cannot read is not a release we can offer. This guard is here,
	// above every other branch, rather than folded into the comparison below --
	// the comparison only runs when the fleet track HAS a target, so an
	// unreadable tag on a never-configured track would sail past it and produce
	// a button that setTargetVersion is guaranteed to reject. That is a control
	// whose only possible outcome is a refusal, which is exactly what this
	// panel refuses to render, and it would appear on the deployment where the
	// notice matters most.
	if !selfupdate.IsPlainVersion(rc.LatestTag) {
		return v
	}
	// Newer than what the fleet targets? An unconfigured track has nothing to
	// compare against, and offering the rollout is the point.
	if fleetFound && fleet.TargetVersion != "" {
		n, ok := selfupdate.CompareVersions(rc.LatestTag, fleet.TargetVersion)
		// ok == false means one of them does not parse. Saying nothing is the
		// only honest answer: claiming "nothing new" would be an assertion
		// about currency built on a value we could not read.
		if !ok || n <= 0 {
			return v
		}
	}
	// Dismissed this tag or a newer one: stay quiet, but leave the dismissal
	// visible so it can be undone. A tag newer than the dismissed one falls
	// through and prompts again.
	//
	// The `ok &&` is load-bearing and easy to drop as redundant. Without it, a
	// DismissedTag that cannot be parsed -- a hand-edited row, a tag from before
	// a naming change -- compares as 0 and silences EVERY future notice
	// permanently, with nothing on screen to say why.
	if rc.DismissedTag != "" {
		if n, ok := selfupdate.CompareVersions(rc.LatestTag, rc.DismissedTag); ok && n <= 0 {
			return v
		}
	}
	v.Show = true
	v.Rolling = fleetFound && fleet.Status == "rolling"
	v.OfferButton = !v.Rolling
	return v
}

// ReleaseCheckStore is the slice of the store this poller needs. Narrow on
// purpose: it writes one thing, and it must be obvious from the type that a
// failed check cannot touch anything else.
type ReleaseCheckStore interface {
	SetReleaseCheckResult(ctx context.Context, tag string, at int64) error
}

// ReleaseChecker polls for the newest release. Latest is injectable for the
// same reason fetchGoogleUser and appleKey are on Service: tests must not reach
// the network.
type ReleaseChecker struct {
	Store  ReleaseCheckStore
	Now    func() time.Time
	Latest func(ctx context.Context) (string, error)
	Log    *log.Logger
	// failing tracks whether the last attempt failed, so an outage costs one
	// log line rather than one per hour. Same shape as the storage prober's
	// reachability logging. Only Run/CheckOnce touch it, from one goroutine.
	failing bool
}

// CheckOnce performs one check. A failure writes NOTHING: leaving the previous
// values in place is what makes the panel degrade to silence rather than to a
// false claim, and overwriting with an empty tag would turn a network blip into
// an amnesiac panel.
func (c *ReleaseChecker) CheckOnce(ctx context.Context) {
	tag, err := c.Latest(ctx)
	if err != nil {
		if !c.failing {
			c.Log.Printf("release-check: %v (keeping the last known release; the panel will not claim to be current)", err)
			c.failing = true
		}
		return
	}
	if c.failing {
		c.Log.Printf("release-check: recovered, latest release is %s", tag)
		c.failing = false
	}
	if err := c.Store.SetReleaseCheckResult(ctx, tag, c.Now().Unix()); err != nil {
		c.Log.Printf("release-check: record %s: %v", tag, err)
	}
}

// Run checks once immediately, then every interval until ctx is cancelled --
// the same shape as StorageProber.Run.
func (c *ReleaseChecker) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	c.CheckOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			c.CheckOnce(ctx)
		}
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && go build ./... && go vet ./account/ && go test ./account/ -run 'TestReleaseNotice|TestReleaseChecker' -v`
Expected: PASS, all eleven tests.

Then the whole package: `cd server && go test ./account/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/account/releasecheck.go server/account/releasecheck_test.go
git commit -m "feat(admin): decide whether to offer a release, and poll for one

releaseNotice is pure and makes only positive claims: it can say a newer version
exists, never that the deployment is current, so a failed check degrades to
silence rather than to a false statement.

It withholds the rollout button while the fleet track is rolling. setTargetVersion
has no status gate on that path -- it rewrites the whole row, resetting Status,
restamping StageStartedAt and clearing CurrentNodeID/FirstNodeID -- so one click
from a notice could silently discard a canary nearly through its six-hour window.
The panel already refuses to render a control whose only outcome is a refusal;
this is the case that is worse, because it succeeds.

A property test asserts that across every combination of status, tags and
timestamps, offering the button implies the track is not rolling. Per-case
assertions drift with the understanding that wrote them; this one does not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: wiring, the panel, and the disclosure

**Files:**
- Modify: `server/main.go` (the `RELAYIUM_RELEASE_CHECK` flag, starting the poller, the startup log line)
- Modify: `server/account/admin.go` (view field, two routes)
- Modify: `server/account/admin_templates.go` (the notice, above the rollout panels)
- Modify: `server/account/service.go` (`Config` gains the flag)
- Modify: `docs/self-hosting.md` (the disclosure section)
- Create: `server/account/admin_release_test.go`

**Interfaces:**
- Consumes: `releaseNotice`, `releaseNoticeView`, `ReleaseChecker` from Task 2; `GetReleaseCheck`, `SetReleaseCheckDismissed` from Task 1

- [ ] **Step 1: Write the failing tests**

Create `server/account/admin_release_test.go`. These go through the real admin server, as `TestAdminDashboardShowsBothRolloutPanels` in `admin_rollout_test.go` does: `newAdminSettingsServer(t)` returns `(*httptest.Server, *Service, *SQLiteStore)`, `adminLogin(t, ts)` gives the cookie, `readAll(t, resp)` the body. Reuse the `adminDashboardHTML(t, ts, cookie)` helper already in `admin_rollout_panel_test.go`.

```go
package account

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestAdminNoticeOffersRolloutWhenIdle(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "complete", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "v1.3.0") {
		t.Fatal("the notice does not name the new release")
	}
	if !strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("the rollout button is missing on an idle fleet track")
	}
}

// The constraint, at the level a user feels it.
func TestAdminNoticeHasNoButtonWhileRolling(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "rolling", StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "v1.3.0") {
		t.Fatal("the notice should still inform while a rollout is running")
	}
	if strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("pressing that button would silently abandon the rollout in flight")
	}
}

// Never checked successfully: the panel says so, and never implies currency.
func TestAdminNoticeSaysItHasNotCheckedYet(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "尚未成功检查过") {
		t.Fatal("a deployment that has never checked must say so, not stay silent")
	}
	if strings.Contains(body, "已是最新") {
		t.Fatal("the panel must never claim to be up to date")
	}
}

func TestAdminDismissHidesTheNoticeAndCanBeUndone(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	postAdminForm(t, ts, cookie, "/admin/release/dismiss", url.Values{"version": {"v1.3.0"}}).Body.Close()
	body := adminDashboardHTML(t, ts, cookie)
	if strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("a dismissed release must stop prompting")
	}
	if !strings.Contains(body, "已忽略") {
		t.Fatal("the dismissal must stay visible so it can be undone")
	}

	postAdminForm(t, ts, cookie, "/admin/release/dismiss", url.Values{"version": {""}}).Body.Close()
	body = adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "/admin/release/rollout") {
		t.Fatal("undoing the dismissal must bring the notice back")
	}
}

// A page left open showing an old release must not be able to repoint the fleet
// backwards. nodes.go:445 sets AllowDowngrade automatically for a downgrade, so
// this is not inert -- the nodes would install the older build.
func TestAdminRolloutRefusesAStaleVersion(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.5.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.5.0", now); err != nil {
		t.Fatal(err)
	}

	// The stale page still holds v1.3.0.
	resp := postAdminForm(t, ts, cookie, "/admin/release/rollout", url.Values{"version": {"v1.3.0"}})
	resp.Body.Close()

	after, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: %v/%v", ok, err)
	}
	if after.TargetVersion != "v1.5.0" || after.Status != "complete" {
		t.Fatalf("a stale version repointed the fleet: %+v", after)
	}
}

// The rolling guard, at the handler rather than at the button.
func TestAdminRolloutRefusesWhileRolling(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	before := RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "rolling",
		CurrentNodeID: "n-canary", FirstNodeID: "n-canary", StageStartedAt: now - 3600,
	}
	if err := store.PutRolloutTrack(ctx, before); err != nil {
		t.Fatal(err)
	}
	if err := store.SetReleaseCheckResult(ctx, "v1.3.0", now); err != nil {
		t.Fatal(err)
	}

	resp := postAdminForm(t, ts, cookie, "/admin/release/rollout", url.Values{"version": {"v1.3.0"}})
	resp.Body.Close()

	after, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: %v/%v", ok, err)
	}
	if after.TargetVersion != before.TargetVersion || after.Status != before.Status ||
		after.CurrentNodeID != before.CurrentNodeID || after.StageStartedAt != before.StageStartedAt {
		t.Fatalf("a direct POST abandoned the rollout in flight: before=%+v after=%+v", before, after)
	}
}
```

`postAdminForm(t, ts, cookie, path, url.Values) *http.Response` already exists in this package's tests — `admin_rollout_test.go` uses it for the rollout target POSTs — and it is what satisfies `CSRFGuard`. Use it rather than hand-rolling a request. Drop the `net/http` and `strings.NewReader` imports if nothing else in the file needs them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./account/ -run TestAdminNotice -v && go test ./account/ -run TestAdminDismiss -v`
Expected: FAIL — the notice is not rendered and the routes do not exist.

- [ ] **Step 3: Add the config flag**

In `server/account/service.go`, add to `Config`:

```go
	// ReleaseCheck enables the hourly poll for a newer upstream release and the
	// admin notice built on it. On by default; RELAYIUM_RELEASE_CHECK=false
	// turns it off, and when off no request is made at all.
	ReleaseCheck bool
```

In `server/main.go`, alongside the other boolean flags (around line 96-98, where `-enable-user-nodes` and `-direct-download` are declared), add:

```go
	releaseCheck := flag.Bool("release-check", envBool("RELAYIUM_RELEASE_CHECK", true), "ask GitHub hourly for the newest release and offer it in /admin (default on; sends no instance data)")
```

`envBool(key string, def bool) bool` already exists in that file and is the house pattern. Pass `ReleaseCheck: *releaseCheck` into the `account.Config` literal.

- [ ] **Step 4: Start the poller and disclose it**

In `server/main.go`, next to where `StorageProber` is started (around line 499), add:

```go
	if cfg.ReleaseCheck {
		// Printed unconditionally, because this ships to self-hosters and it
		// changes what their server does on the network. It reads a public API
		// and uploads nothing about the instance; what GitHub can observe is
		// this machine's egress IP asking on a timer.
		log.Printf("release check enabled: asking github.com hourly for the newest %s release, to offer it in /admin. "+
			"No instance data is sent. Set RELAYIUM_RELEASE_CHECK=false to turn it off.", releaseRepo)
		checker := &account.ReleaseChecker{
			Store: store,
			Now:   time.Now,
			Latest: func(ctx context.Context) (string, error) {
				return selfupdate.LatestTag(ctx, selfupdate.Options{Repo: releaseRepo})
			},
			Log: log.Default(),
		}
		go checker.Run(context.Background(), time.Hour)
	}
```

with `const releaseRepo = "relayium/relayium"` near the top of the file — the same value `server/cmd/relayium-node/update.go:23` uses for `updateRepo`. Add the `selfupdate` import if the file does not already have it.

- [ ] **Step 5: Wire the notice into the dashboard**

In `server/account/admin.go`, in the function that builds `adminHomeData` (around line 948, where `RolloutFleet`/`HaltedTracks` are set), read the stored check and the fleet track and build the view. The fleet track is already read by `rolloutPanel`, but do not thread it out of there — read it directly, so a change to the panel cannot silently change the notice:

```go
	var notice releaseNoticeView
	if s.cfg.ReleaseCheck {
		rc, rcErr := s.Store().GetReleaseCheck(r.Context())
		if rcErr != nil {
			log.Printf("admin: GetReleaseCheck failed: %v", rcErr)
		} else {
			fleetTrack, found, ftErr := s.Store().GetRolloutTrack(r.Context(), "fleet")
			if ftErr != nil {
				log.Printf("admin: GetRolloutTrack(fleet) for the release notice failed: %v", ftErr)
			} else {
				notice = releaseNotice(rc, fleetTrack, found)
			}
		}
	}
```

and add `ReleaseNotice: notice,` to the returned `adminHomeData`, with the field declared on that struct in `admin_templates.go` next to `HaltedTracks`:

```go
	// ReleaseNotice is the "a newer release exists" banner. Its zero value
	// renders nothing, which is also what a failed check produces — this
	// banner only ever makes a positive claim.
	ReleaseNotice releaseNoticeView
```

Register the two routes in `RegisterAdmin` beside the rollout ones:

```go
	mux.Handle("POST /admin/release/rollout", s.CSRFGuard(http.HandlerFunc(s.handleAdminReleaseRollout)))
	mux.Handle("POST /admin/release/dismiss", s.CSRFGuard(http.HandlerFunc(s.handleAdminReleaseDismiss)))
```

Add both handlers to `server/account/admin_rollout.go`, following `rolloutSetVersion`'s existing shape for parsing, auditing and redirecting:

- `handleAdminReleaseRollout` reads `version` from the form and calls the same path the typed fleet form uses (`SetTargetVersion(ctx, "fleet", version)`), so there is exactly one way a target is ever set. It has **two** guards, and both exist for the same reason — a stale page or a direct POST must not be able to do what the UI declines to offer:

  1. **Re-read the fleet track and refuse if its status is `rolling`.** The button is hidden in that state; the handler is what makes it a rule.
  2. **Re-read `GetReleaseCheck` and refuse unless the posted `version` equals the stored `LatestTag`.** Without this the handler trusts a client-supplied version: an admin leaves `/admin` open showing v1.3.0, the fleet completes a rollout to v1.5.0, and the stale button posts v1.3.0 — which passes the rolling guard and **repoints the fleet backwards**. That is not inert: `nodes.go:445` sets `AllowDowngrade` automatically for a downgrade, so nodes install the older build. Guarding one axis and not the other is how this hole got here in the first place.

  Give it **its own audit action** — `AuditReleaseRollout` — rather than reusing `AuditRolloutTarget`. The house rule is the opposite of "identical writes share an action": `handleAdminRolloutTarget` and `handleAdminRolloutRollback` funnel into the identical `SetTargetVersion` write and are deliberately given different actions, documented at `admin_rollout.go:388-392` as being "purely so the audit trail (and the UI) can tell 'shipping v1.3.0' from 'getting off v1.3.0', which is the fact an incident review actually needs". Entry point is exactly what an incident review wants here too.

- **The inline `onsubmit="return confirm(...)"` on this form is decorative and must be annotated as such**, the way `admin_templates.go:211-218` already annotates the others: the admin CSP has no `'unsafe-inline'`, so inline handlers never run and a `confirm()` must never be treated as a confirmation step. Do not build a step-up flow for it. With both guards above in place the button can only set the target to the version the server itself currently reports as newest, and only while no rollout is running — so what is left is a misclick, not a stale-state hazard, and `stepup.go`'s machinery would be answering a question the guards already answer.

- `handleAdminReleaseDismiss` reads `version` and calls `SetReleaseCheckDismissed(ctx, version, now)`. An empty value is the undo.

- [ ] **Step 6: Render it**

In `server/account/admin_templates.go`, immediately before the `{{if .HaltedTracks}}` block (around line 628), add:

```
{{with .ReleaseNotice}}
{{if .Enabled}}
{{if .Show}}
<section class="halts">
<div class="halt">
<b>有新版本：{{.LatestTag}}</b>{{if .TargetTag}} · 当前目标 {{.TargetTag}}{{else}} · 尚未配置发布目标{{end}}
{{if .OfferButton}}
<form method="post" action="/admin/release/rollout" class="lim"
  onsubmit="return confirm('把机队轨的目标版本设为 {{.LatestTag}} 并开始发布？')">
<input type="hidden" name="version" value="{{.LatestTag}}">
<button type="submit">发布 {{.LatestTag}} 到机队</button></form>
{{else}}
<div class="halt-why">机队轨正在发布 {{.TargetTag}}，此处不提供一键发布：那会中止正在进行的发布并从头开始。要改目标请到下方机队面板手动设定。</div>
{{end}}
<form method="post" action="/admin/release/dismiss" class="lim">
<input type="hidden" name="version" value="{{.LatestTag}}">
<button type="submit">忽略此版本</button></form>
</div>
</section>
{{else if .DismissedTag}}
<div style="color:var(--muted);font-size:12px">已忽略 {{.DismissedTag}} ·
<form method="post" action="/admin/release/dismiss" class="lim" style="display:inline">
<input type="hidden" name="version" value="">
<button type="submit">撤销</button></form></div>
{{end}}
{{if .CheckedAt}}<div style="color:var(--muted);font-size:12px">上次成功检查：{{ts .CheckedAt}} UTC</div>
{{else}}<div style="color:var(--muted);font-size:12px">尚未成功检查过</div>{{end}}
{{end}}
{{end}}
```

`div` rather than `p` for the two muted lines: a `p` cannot contain a `form`, and
the browser would auto-close it, putting the undo button outside the element that
styles it.

`ts` is the template's existing unix-to-UTC helper (`admin_templates.go:541`), the same one the rollout panel's `本阶段开始` uses. Do not add a second one.

- [ ] **Step 7: Document it for self-hosters**

Add a section to `docs/self-hosting.md` stating: the check is on by default; it asks GitHub hourly for the newest release tag of `relayium/relayium`; it sends nothing about the instance; what GitHub can observe is the instance's egress IP asking on a timer; and `RELAYIUM_RELEASE_CHECK=false` disables it, after which no request is made at all. Match the file's existing voice and language.

- [ ] **Step 8: Run everything**

Run: `cd server && go build ./... && go vet ./account/ && go test ./account/ -run 'TestAdmin|TestRelease|TestRollout|TestPanel|TestEmergency' -v 2>&1 | tail -30`
Expected: PASS, including every pre-existing admin and rollout test.

Then the whole package and the race detector:
`cd server && go test ./account/` then `go test -race ./account/`
Expected: PASS both. **The race run on this package takes about five minutes; that is normal, not a hang.**

Then: `./scripts/check-production-identifiers.sh`
Expected: PASSED.

- [ ] **Step 9: Commit**

```bash
git add server/main.go server/account/service.go server/account/admin.go \
        server/account/admin_rollout.go server/account/admin_templates.go \
        server/account/admin_release_test.go docs/self-hosting.md
git commit -m "feat(admin): offer the newest release from the panel

The operator had to know the version number and type it in. Central now asks
GitHub hourly and the panel offers it, with the button withheld while a rollout
is in flight -- pressing it there would silently abandon the rollout, because
setTargetVersion rewrites the whole track row.

The POST re-checks that the track is not rolling rather than trusting the
button's absence: a stale page must not be able to do what the UI declines to
offer.

On by default, which changes what a self-hosted server does on the network, so
it says so in a startup log line naming the endpoint, the frequency and the
variable that turns it off -- and again in docs/self-hosting.md. Disabled means
no request is made at all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the reviewer

Four things here are easy to get wrong in a way tests written from the same understanding would not catch:

- **The button's absence is not the guard.** `handleAdminReleaseRollout` must re-read the track and refuse while rolling. A hidden button is a UI affordance; the handler is the rule.
- **`releaseNotice` must never produce copy asserting currency**, in any state. The absence of the notice is the only "nothing new" signal, and it is deliberately indistinguishable from "the check has been failing" *except* through the last-checked line.
- **A failed check must not write.** Overwriting the stored tag with `""` would turn a network blip into an amnesiac panel, and would silently un-hide a dismissed notice.
- **This plan asserts several things about `setTargetVersion`, `CSRFGuard`, the UTC template helper and `main.go`'s boolean-flag style.** Five defects on the previous round of this work came from a plan describing existing code without matching it. Check each against the file rather than against this plan.
