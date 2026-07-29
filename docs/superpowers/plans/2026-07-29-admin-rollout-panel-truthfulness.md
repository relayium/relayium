# Admin Rollout Panel Truthfulness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin rollout panel distinguish a node that is being observed from one that is stuck, and stop offering controls that can only be refused.

**Architecture:** A new pure file computes, from data the panel already holds, which of three states a fleet node in flight is in and when the current window closes. The panel's view models carry that description; the template renders it and drops controls invalid for the current status. The state machines in `rollout_fleet.go` / `rollout_byo.go` remain the only authority — this describes their state, it never re-decides it.

**Tech Stack:** Go standard library only (`fmt`, `time`), `html/template` for the panel.

**Spec:** `docs/superpowers/specs/2026-07-29-admin-rollout-panel-truthfulness-design.md`

## Global Constraints

- **The panel owns no thresholds.** `fleetFirstWindow`, `fleetStepWindow`, `updateSilenceLimit`, `fleetInstallLimit` (`server/account/rollout_fleet.go:46-51`) and `byoBatchWindow` (`server/account/rollout_byo.go:40`) are read from where they are defined. Never write `6*3600`, `1800`, `900` or `3600` into new code or into a test's expected value — compute from the constant. A panel carrying its own copies starts lying the day someone tunes one.
- **The panel describes; it never decides.** `decideFleet` and `decideByo` stay the only authority. Do not call them from the panel and do not reimplement their branches.
- **The observation window is measured from `max(tr.StageStartedAt, UpdateStartedAt)`** — never from `StageStartedAt` alone. `rollout_fleet.go:285-288` records why: the two stamps are written by different code paths, and a stale or zero `StageStartedAt` collapses a six-hour observation into seconds.
- **The observation window only applies once the node is on target.** Before that the node is installing and the halt backstops apply instead.
- **Times are stated as "not before", never as an exact prediction.** Both state machines are evaluated only when a node polls, and nodes poll roughly every 10 minutes (`web/public/install-node.sh:277`, `OnUnitActiveSec=10min`).
- All new user-facing strings are Chinese, matching the rest of the panel.
- Conventional commits. Commit messages in English regardless of the working language.
- No real node IP addresses or production node ids anywhere in this repo.

---

### Task 1: the pure classifier and the window calculator

**Files:**
- Create: `server/account/rollout_status.go`
- Create: `server/account/rollout_status_test.go`

**Interfaces:**
- Consumes: `fleetFirstWindow`, `fleetStepWindow`, `updateSilenceLimit`, `fleetInstallLimit` from `rollout_fleet.go`; `byoBatchWindow` from `rollout_byo.go`; `nodeOnlineWindow` from `nodes.go` (a `time.Duration`, so seconds are `int64(nodeOnlineWindow / time.Second)`)
- Produces, all consumed by Tasks 2 and 3:
  - `type rolloutNodeStatus struct { Band, Label, Detail string; Overdue bool }`
  - `type fleetNodeInput struct { OnTarget, IsCanary bool; UpdateStartedAt, LastSeenAt, StageStartedAt int64 }`
  - `fleetNodeStatus(in fleetNodeInput, now int64) rolloutNodeStatus`
  - `byoNextStepText(stageStartedAt, now int64) string`
  - `fleetRulesText() string`, `byoRulesText() string`

This task ADDS two files and touches nothing else, so the package keeps building and every existing test keeps passing at this commit.

- [ ] **Step 1: Write the failing tests**

Create `server/account/rollout_status_test.go`:

```go
package account

import (
	"strings"
	"testing"
	"time"
)

// A node already on the target version is being OBSERVED, not installed. This
// is the distinction the old 更新中 label denied, and the reason an operator
// could not tell a healthy canary from a stuck one.
func TestFleetNodeStatusOnTargetIsObserving(t *testing.T) {
	const now = 1_000_000
	got := fleetNodeStatus(fleetNodeInput{
		OnTarget: true, IsCanary: true,
		UpdateStartedAt: now - 60, StageStartedAt: now - 60, LastSeenAt: now,
	}, now)
	if got.Band != "observing" {
		t.Fatalf("band = %q, want observing", got.Band)
	}
	if got.Label != "观察中" {
		t.Fatalf("label = %q, want 观察中", got.Label)
	}
	if got.Overdue {
		t.Fatal("a window that just opened is not overdue")
	}
}

// The canary gets the long window and every later node the short one.
func TestFleetNodeStatusWindowDependsOnCanary(t *testing.T) {
	const now = 1_000_000
	base := fleetNodeInput{OnTarget: true, UpdateStartedAt: now, StageStartedAt: now, LastSeenAt: now}

	canary := base
	canary.IsCanary = true
	// Just before the canary's window closes, it is still observing.
	if got := fleetNodeStatus(canary, now+fleetFirstWindow-1); got.Overdue {
		t.Fatal("canary window closed early")
	}
	if got := fleetNodeStatus(canary, now+fleetFirstWindow); !got.Overdue {
		t.Fatal("canary window did not close on time")
	}
	// A later node uses the short window, so it is already due at that point.
	if got := fleetNodeStatus(base, now+fleetStepWindow); !got.Overdue {
		t.Fatal("step window did not close on time")
	}
	if got := fleetNodeStatus(base, now+fleetStepWindow-1); got.Overdue {
		t.Fatal("step window closed early")
	}
}

// The trap rollout_fleet.go:285-288 records: the two stamps are written by
// different code paths, and taking StageStartedAt alone collapses a six-hour
// observation into seconds. The panel must not reproduce it.
func TestFleetNodeStatusUsesLaterOfTheTwoStamps(t *testing.T) {
	const now = 1_000_000
	// A StageStartedAt left over from the PREVIOUS stage, long past.
	in := fleetNodeInput{
		OnTarget: true, IsCanary: true,
		StageStartedAt:  now - fleetFirstWindow - 3600,
		UpdateStartedAt: now,
		LastSeenAt:      now,
	}
	if got := fleetNodeStatus(in, now); got.Overdue {
		t.Fatal("a stale StageStartedAt collapsed the observation window")
	}
	if got := fleetNodeStatus(in, now+fleetFirstWindow-1); got.Overdue {
		t.Fatal("window measured from the stale stamp rather than the node's own")
	}
}

// Commanded, but the node never recorded a start: a split between central's
// two writes. Its clock is the stage's, not the node's.
func TestFleetNodeStatusNotStarted(t *testing.T) {
	const now = 1_000_000
	in := fleetNodeInput{OnTarget: false, UpdateStartedAt: 0, StageStartedAt: now - 60, LastSeenAt: now}
	got := fleetNodeStatus(in, now)
	if got.Band != "not-started" {
		t.Fatalf("band = %q, want not-started", got.Band)
	}
	if got.Label != "等待节点开始" {
		t.Fatalf("label = %q, want 等待节点开始", got.Label)
	}
	if got.Overdue {
		t.Fatal("60s in is not overdue")
	}
	if late := fleetNodeStatus(fleetNodeInput{
		OnTarget: false, UpdateStartedAt: 0, StageStartedAt: now - updateSilenceLimit - 1, LastSeenAt: now,
	}, now); !late.Overdue {
		t.Fatal("past updateSilenceLimit from the stage start must read overdue")
	}
}

// Installing while still heartbeating: the install limit is the one that will
// decide this node's fate, because the silence clock resets every heartbeat.
func TestFleetNodeStatusInstallingShowsInstallLimit(t *testing.T) {
	const now = 1_000_000
	in := fleetNodeInput{OnTarget: false, UpdateStartedAt: now - 600, StageStartedAt: now - 600, LastSeenAt: now}
	got := fleetNodeStatus(in, now)
	if got.Band != "installing" {
		t.Fatalf("band = %q, want installing", got.Band)
	}
	if got.Label != "安装中" {
		t.Fatalf("label = %q, want 安装中", got.Label)
	}
	if got.Overdue {
		t.Fatal("10 minutes into an install is not overdue")
	}
	if late := fleetNodeStatus(fleetNodeInput{
		OnTarget: false, UpdateStartedAt: now - fleetInstallLimit - 1, StageStartedAt: now - fleetInstallLimit - 1, LastSeenAt: now,
	}, now); !late.Overdue {
		t.Fatal("past fleetInstallLimit must read overdue")
	}
}

// Once the node stops heartbeating, the silence limit is the one about to fire
// and the label has to say so -- otherwise the panel reports a healthy install
// on a machine that has gone dark.
func TestFleetNodeStatusInstallingSwitchesToSilenceWhenQuiet(t *testing.T) {
	const now = 1_000_000
	quiet := int64(nodeOnlineWindow/time.Second) + 1
	in := fleetNodeInput{
		OnTarget: false, UpdateStartedAt: now - 600, StageStartedAt: now - 600,
		LastSeenAt: now - quiet,
	}
	got := fleetNodeStatus(in, now)
	if got.Band != "installing" {
		t.Fatalf("band = %q, want installing", got.Band)
	}
	if !strings.Contains(got.Label, "心跳") {
		t.Fatalf("label = %q, want it to say the node stopped heartbeating", got.Label)
	}
}

// A window that has already closed reports waiting for the next poll, never a
// negative countdown. decideFleet only runs when some node polls.
func TestFleetNodeStatusClosedWindowHasNoNegativeCountdown(t *testing.T) {
	const now = 1_000_000
	in := fleetNodeInput{OnTarget: true, IsCanary: true, UpdateStartedAt: now - fleetFirstWindow - 600,
		StageStartedAt: now - fleetFirstWindow - 600, LastSeenAt: now}
	got := fleetNodeStatus(in, now)
	if !got.Overdue {
		t.Fatal("window should be closed")
	}
	if strings.Contains(got.Detail, "-") {
		t.Fatalf("detail %q contains a negative duration", got.Detail)
	}
	if !strings.Contains(got.Detail, "等待下一次轮询") {
		t.Fatalf("detail = %q, want it to say it is waiting for the next poll", got.Detail)
	}
}

// A node not holding the slot at all has no band.
func TestFleetNodeStatusIdleNodeHasNoBand(t *testing.T) {
	if got := fleetNodeStatus(fleetNodeInput{}, 0); got.Band != "" || got.Label != "" {
		t.Fatalf("want an empty status for a node with no stamps, got %+v", got)
	}
}

// The three labels must stay distinct, so a later refactor that collapses them
// into one generic string fails here rather than silently restoring the
// behaviour this work exists to fix.
func TestFleetNodeStatusLabelsAreDistinct(t *testing.T) {
	const now = 1_000_000
	observing := fleetNodeStatus(fleetNodeInput{OnTarget: true, UpdateStartedAt: now, StageStartedAt: now, LastSeenAt: now}, now)
	installing := fleetNodeStatus(fleetNodeInput{UpdateStartedAt: now - 60, StageStartedAt: now - 60, LastSeenAt: now}, now)
	notStarted := fleetNodeStatus(fleetNodeInput{StageStartedAt: now - 60, LastSeenAt: now}, now)
	seen := map[string]bool{}
	for _, s := range []rolloutNodeStatus{observing, installing, notStarted} {
		if s.Label == "" {
			t.Fatalf("empty label in %+v", s)
		}
		if seen[s.Label] {
			t.Fatalf("duplicate label %q across bands", s.Label)
		}
		seen[s.Label] = true
	}
}

func TestByoNextStepText(t *testing.T) {
	const now = 1_000_000
	open := byoNextStepText(now-60, now)
	if !strings.Contains(open, "不早于") {
		t.Fatalf("byoNextStepText = %q, want the 不早于 phrasing", open)
	}
	closed := byoNextStepText(now-byoBatchWindow-1, now)
	if !strings.Contains(closed, "等待下一次轮询") {
		t.Fatalf("closed window text = %q, want it to wait for the next poll", closed)
	}
	if strings.Contains(closed, "-") {
		t.Fatalf("closed window text %q contains a negative duration", closed)
	}
}

// The rules line is generated from the constants, so tuning one moves the
// state machine and the sentence together.
func TestRulesTextIsGeneratedFromConstants(t *testing.T) {
	fleet := fleetRulesText()
	for _, want := range []string{humanDuration(fleetFirstWindow), humanDuration(fleetStepWindow)} {
		if !strings.Contains(fleet, want) {
			t.Fatalf("fleetRulesText = %q, want it to contain %q", fleet, want)
		}
	}
	if byo := byoRulesText(); !strings.Contains(byo, humanDuration(byoBatchWindow)) {
		t.Fatalf("byoRulesText = %q, want it to contain %q", byo, humanDuration(byoBatchWindow))
	}
}

func TestHumanDuration(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0 分钟"},
		{59, "0 分钟"},
		{60, "1 分钟"},
		{90 * 60, "1 小时 30 分钟"},
		{3600, "1 小时"},
		{6 * 3600, "6 小时"},
	}
	for _, tc := range cases {
		if got := humanDuration(tc.in); got != tc.want {
			t.Fatalf("humanDuration(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./account/ -run 'TestFleetNodeStatus|TestByoNextStep|TestRulesText|TestHumanDuration' -v`
Expected: FAIL — `undefined: fleetNodeStatus`, `undefined: fleetNodeInput`, `undefined: byoNextStepText`, `undefined: fleetRulesText`, `undefined: byoRulesText`, `undefined: humanDuration`

- [ ] **Step 3: Write the implementation**

Create `server/account/rollout_status.go`:

```go
package account

import (
	"fmt"
	"time"
)

// This file DESCRIBES rollout state for the admin panel. It never decides
// anything: decideFleet and decideByo remain the only authority, and nothing
// here may reimplement their branches. If the two could disagree, the operator
// would eventually believe the wrong one.
//
// Every threshold below is read from the state machine's own constants
// (rollout_fleet.go, rollout_byo.go). A panel carrying its own copies starts
// lying the day someone tunes a constant, and a panel that lies is worse than
// one that says nothing, because decisions get made from it.

// rolloutNodeStatus is what the panel prints for the node holding the fleet
// rollout slot.
type rolloutNodeStatus struct {
	Band   string // "" | "installing" | "not-started" | "observing"
	Label  string // 安装中 / 等待节点开始 / 观察中
	Detail string // the applicable clock, in words
	// Overdue is true once the limit that applies to this band has passed. It
	// is NOT "the track has halted": both state machines are evaluated only
	// when some node polls, so the consequence lands on the next poll rather
	// than at the instant the limit is crossed.
	Overdue bool
}

// fleetNodeInput is everything the classification needs, in primitives, so
// this stays testable without a database, an HTTP request or a clock.
type fleetNodeInput struct {
	OnTarget        bool
	IsCanary        bool
	UpdateStartedAt int64
	LastSeenAt      int64
	StageStartedAt  int64
}

// fleetNodeStatus places the node in one of three mutually exclusive states.
// They have different deadlines and they call for opposite responses: an
// observing node needs waiting for, the other two need looking at.
func fleetNodeStatus(in fleetNodeInput, now int64) rolloutNodeStatus {
	if in.OnTarget {
		// The observation window only starts once the node actually runs the
		// target. The six hours are spent watching a node that already
		// installed -- which is the whole point of the window.
		window := int64(fleetStepWindow)
		if in.IsCanary {
			window = fleetFirstWindow
		}
		// The LATER of the two stamps. rollout_fleet.go:285-288 records why:
		// they are written by different code paths, and a stale or zero
		// StageStartedAt would collapse a six-hour observation into seconds.
		start := in.StageStartedAt
		if in.UpdateStartedAt > start {
			start = in.UpdateStartedAt
		}
		deadline := start + window
		return rolloutNodeStatus{
			Band: "observing", Label: "观察中",
			Detail: notBeforeText(deadline, now), Overdue: now >= deadline,
		}
	}
	if in.UpdateStartedAt == 0 && in.StageStartedAt == 0 {
		return rolloutNodeStatus{} // not in flight at all
	}
	if in.UpdateStartedAt == 0 {
		// Commanded, but the node never recorded a start: central's two writes
		// split. The stage's clock is the backstop (rollout_fleet.go:263).
		deadline := in.StageStartedAt + updateSilenceLimit
		return rolloutNodeStatus{
			Band: "not-started", Label: "等待节点开始",
			Detail: elapsedText(in.StageStartedAt, deadline, now), Overdue: now > deadline,
		}
	}
	// Installing. Two limits apply, and showing both is noise: a heartbeating
	// node resets its silence clock every 30s, so that limit is irrelevant to
	// it. Show whichever one will actually decide this node's fate.
	if now-in.LastSeenAt > int64(nodeOnlineWindow/time.Second) {
		deadline := in.LastSeenAt + updateSilenceLimit
		return rolloutNodeStatus{
			Band: "installing", Label: "安装中（已停止心跳）",
			Detail: elapsedText(in.LastSeenAt, deadline, now), Overdue: now > deadline,
		}
	}
	deadline := in.UpdateStartedAt + fleetInstallLimit
	return rolloutNodeStatus{
		Band: "installing", Label: "安装中",
		Detail: elapsedText(in.UpdateStartedAt, deadline, now), Overdue: now > deadline,
	}
}

// byoNextStepText is the BYO track's equivalent. It has no per-node bands --
// it commands a whole batch -- so all it needs is when the batch's window
// closes (rollout_byo.go:230).
func byoNextStepText(stageStartedAt, now int64) string {
	return notBeforeText(stageStartedAt+byoBatchWindow, now)
}

// notBeforeText phrases a deadline as the earliest it can matter, never as a
// prediction. Both state machines are evaluated only when some node polls, and
// nodes poll roughly every 10 minutes, so a bare timestamp would read as a
// promise and slip on every rollout. A panel whose predictions visibly miss
// teaches the operator to ignore it.
func notBeforeText(deadline, now int64) string {
	if now >= deadline {
		return "已到时间，等待下一次轮询"
	}
	return fmt.Sprintf("不早于 %s UTC（还有 %s）",
		time.Unix(deadline, 0).UTC().Format("2006-01-02 15:04"), humanDuration(deadline-now))
}

// elapsedText states a fact and a limit rather than a prediction: how long this
// has been going and how long it may go. A slow link taking forty minutes to
// fetch a binary is normal, so this reads plainly at every point below the
// limit.
func elapsedText(since, deadline, now int64) string {
	if now > deadline {
		return fmt.Sprintf("已 %s · 超过 %s 的上限，将在下一次轮询时中止",
			humanDuration(now-since), humanDuration(deadline-since))
	}
	return fmt.Sprintf("已 %s · 上限 %s", humanDuration(now-since), humanDuration(deadline-since))
}

// fleetRulesText and byoRulesText put the timing rules on the page instead of
// in an operator's memory. Both are generated from the constants so that
// tuning one moves the state machine and the sentence together.
func fleetRulesText() string {
	return fmt.Sprintf("canary 观察 %s，之后每台 %s；节点每 ~10 分钟来问一次，所以下发会落在窗口关闭之后的十分钟内。",
		humanDuration(fleetFirstWindow), humanDuration(fleetStepWindow))
}

func byoRulesText() string {
	return fmt.Sprintf("每批观察 %s，之后自动放宽到下一档；节点每 ~10 分钟来问一次。",
		humanDuration(byoBatchWindow))
}

// humanDuration renders a span of seconds the way the panel says it. Sub-minute
// spans read as 0 分钟 rather than in seconds: nothing here is precise to the
// second, and a countdown ticking in seconds invites watching it.
func humanDuration(sec int64) string {
	if sec < 0 {
		sec = 0
	}
	h, m := sec/3600, (sec%3600)/60
	switch {
	case h > 0 && m > 0:
		return fmt.Sprintf("%d 小时 %d 分钟", h, m)
	case h > 0:
		return fmt.Sprintf("%d 小时", h)
	default:
		return fmt.Sprintf("%d 分钟", m)
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && go test ./account/ -run 'TestFleetNodeStatus|TestByoNextStep|TestRulesText|TestHumanDuration' -v`
Expected: PASS, all eleven tests.

Then the whole package, since this task only adds files and nothing that passed before may fail now:
`cd server && go build ./... && go vet ./account/ && go test ./account/`
Expected: build clean, vet silent, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/account/rollout_status.go server/account/rollout_status_test.go
git commit -m "feat(admin): describe what a fleet node in flight is actually doing

A node in flight is in one of three states with different deadlines and
opposite correct responses: installing, commanded but never started, or on
target and being observed. The panel showed all three identically, so a canary
soaking for six hours looked exactly like a node that never converged.

Every threshold is read from rollout_fleet.go and rollout_byo.go rather than
copied, and the rules sentence is generated from the same constants: a panel
with its own copies starts lying the day someone tunes one, and a panel that
lies is worse than one that says nothing.

Pure, so a six-hour window is an integer in a test rather than a wait.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: show the band on the node row

**Files:**
- Modify: `server/account/admin_rollout.go` (add fields to `rolloutPanelView` and `rolloutNodeView`; populate them in `rolloutPanel`)
- Modify: `server/account/admin_templates.go:267` (the `更新中` tag)
- Create: `server/account/admin_rollout_panel_test.go`

**Interfaces:**
- Consumes: `rolloutNodeStatus`, `fleetNodeInput`, `fleetNodeStatus` from Task 1
- Produces: `rolloutNodeView.Status rolloutNodeStatus` and `rolloutPanelView.FirstNodeID string`, both read by Task 3's template work

- [ ] **Step 1: Write the failing test**

Create `server/account/admin_rollout_panel_test.go`:

These tests go through the real admin server, exactly as the existing
`TestAdminDashboardShowsBothRolloutPanels` in `server/account/admin_rollout_test.go`
does: `newAdminSettingsServer(t)` (returns `*httptest.Server, *Service, *SQLiteStore`),
`adminLogin(t, ts)` for the cookie, and `readAll(t, resp)` for the body. There is
no injectable clock on that path, so **every timestamp is set relative to
`time.Now()`** — the windows are hours wide, so a stage that started an hour ago
is unambiguously mid-window whenever the test runs.

Store method names that matter here: the track is written with
`PutRolloutTrack`, and a node's heartbeat with
`TouchNode(ctx, id, relayedBytes, storedBytes, storageTotal, storageFree, at, activeTransfers)`
— eight arguments, `at` seventh.

```go
package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// adminDashboardHTML logs in and returns the admin dashboard's HTML. The
// rollout panels are part of that page, which is where these assertions look.
func adminDashboardHTML(t *testing.T, ts *httptest.Server, cookie *http.Cookie) string {
	t.Helper()
	req, err := http.NewRequest("GET", ts.URL+"/admin", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("dashboard: %d", resp.StatusCode)
	}
	return readAll(t, resp)
}

// A canary that installed successfully is being OBSERVED. The old panel called
// it 更新中 for the whole six-hour window, which is what made a healthy rollout
// indistinguishable from a stuck one.
func TestPanelCallsAnInstalledCanaryObserving(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	seedRolloutNode(t, store, "n-canary", "fleet", "", "v1.1.0", "v1.0.0", "ok")
	if err := store.TouchNode(ctx, "n-canary", 0, 0, 0, 0, now, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling",
		CurrentNodeID: "n-canary", FirstNodeID: "n-canary",
		StageStartedAt: now - 3600,
	}); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "观察中") {
		t.Fatal("panel does not say 观察中 for an installed canary")
	}
	if strings.Contains(body, "更新中") {
		t.Fatal("panel still uses the ambiguous 更新中 label")
	}
	if !strings.Contains(body, "不早于") {
		t.Fatal("panel does not say when the next node can be commanded")
	}
}

// A node commanded but not yet on target is INSTALLING, and the panel shows
// the limit that will actually decide its fate.
func TestPanelCallsANodeStillBehindInstalling(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()
	now := time.Now().Unix()

	// seedRolloutNode leaves LastSeenAt at 1 (1970), which would read as a node
	// that stopped heartbeating. Refresh it so the "still heartbeating" branch
	// is the one under test.
	seedRolloutNode(t, store, "n-installing", "fleet", "", "v1.0.0", "v1.0.0", "")
	if err := store.TouchNode(ctx, "n-installing", 0, 0, 0, 0, now, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling",
		CurrentNodeID: "n-installing", FirstNodeID: "n-installing",
		StageStartedAt: now - 600,
	}); err != nil {
		t.Fatal(err)
	}

	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, "安装中") {
		t.Fatal("panel does not say 安装中 for a node still behind the target")
	}
	if strings.Contains(body, "观察中") {
		t.Fatal("a node not yet on target must not read as 观察中")
	}
}
```

Note `seedRolloutNode`'s own `CommandNodeUpdate` call stamps `update_started_at`
at `1000`, so a node seeded with a `fromVersion` reads as commanded long ago. In
`TestPanelCallsANodeStillBehindInstalling` that is deliberate — it puts the node
past `fleetInstallLimit`, so the row renders `安装中` with the limit crossed. If
you want a node freshly commanded instead, re-stamp it with
`store.CommandNodeUpdate(ctx, id, fromVersion, now-600)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./account/ -run TestPanelCalls -v`
Expected: FAIL — the body still contains `更新中` and contains neither `观察中` nor `不早于`.

- [ ] **Step 3: Carry the canary id and the per-node status into the view**

In `server/account/admin_rollout.go`, add to `rolloutPanelView` (next to `CurrentNodeID`, around line 44):

```go
	// FirstNodeID is the canary of this rollout. It is positional and cannot be
	// re-derived from fleet version state later (see RolloutTrack.FirstNodeID),
	// and it is what decides whether the node in flight gets the long
	// observation window or the short one.
	FirstNodeID string
```

Add to `rolloutNodeView` (after `InBatch`, around line 90):

```go
	// Status describes what this node is doing, for the node holding the fleet
	// rollout slot. Zero for every other row. See rollout_status.go: it
	// DESCRIBES decideFleet's state and never re-decides it.
	Status rolloutNodeStatus
```

In `rolloutPanel`, populate `FirstNodeID` alongside the other track fields (the line that currently sets `StageStartedAt, CurrentNodeID, ByoBatch`):

```go
	p.StageStartedAt, p.CurrentNodeID, p.ByoBatch = tr.StageStartedAt, tr.CurrentNodeID, tr.ByoBatch
	p.FirstNodeID = tr.FirstNodeID
```

Then in the row-building loop, compute the status for the node in flight. Replace the `rows = append(...)` call with:

```go
		current := track == "fleet" && n.ID == tr.CurrentNodeID && tr.CurrentNodeID != ""
		var status rolloutNodeStatus
		if current {
			status = fleetNodeStatus(fleetNodeInput{
				OnTarget:        onTarget,
				IsCanary:        n.ID == tr.FirstNodeID,
				UpdateStartedAt: n.UpdateStartedAt,
				LastSeenAt:      n.LastSeenAt,
				StageStartedAt:  tr.StageStartedAt,
			}, now.Unix())
		}
		rows = append(rows, rolloutNodeView{
			ID: n.ID, Label: n.Label, Version: n.Version,
			Online: n.LastSeenAt >= cutoff, OnTarget: onTarget,
			UpdateFromVersion: n.UpdateFromVersion, UpdateStartedAt: n.UpdateStartedAt,
			Result: n.UpdateResult, ResultText: rolloutResultText(n.UpdateResult),
			Current: current,
			Status:  status,
			InBatch: inBatch[n.ID],
		})
```

- [ ] **Step 4: Render the band instead of `更新中`**

In `server/account/admin_templates.go`, replace the node-row tag at line 267:

```
{{if .Current}}<span class="ro-tag">更新中</span>{{end}}{{if .InBatch}}<span class="ro-tag">本批次</span>{{end}}</td>
```

with:

```
{{if .Current}}<span class="ro-tag{{if .Status.Overdue}} never{{end}}">{{if .Status.Label}}{{.Status.Label}}{{else}}更新中{{end}}</span>{{if .Status.Detail}}<div style="color:var(--muted);font-size:12px">{{.Status.Detail}}</div>{{end}}{{end}}{{if .InBatch}}<span class="ro-tag">本批次</span>{{end}}</td>
```

The `更新中` fallback covers a row that holds the slot but has no stamps at all, so the tag never renders empty. The `never` class (already used on this page for failure text) is applied only when a limit has actually been crossed — a slow link taking forty minutes is normal, and colouring it trains the operator to ignore the colour.

Also update the truncation note at line 278, which still says `更新中`, to read `发布中` so it does not reintroduce the word this task removes:

```
{{if .Hidden}}<p style="color:var(--muted);font-size:12px">共 {{.Total}} 台，仅列出最需要关注的 {{len .Nodes}} 台（失败 / 发布中 / 落后版本优先），其余 {{.Hidden}} 台未显示。</p>{{end}}
```

- [ ] **Step 5: Run the tests**

Run: `cd server && go build ./... && go vet ./account/ && go test ./account/ -run 'TestPanelCalls|TestAdmin|TestRollout|TestEmergency' -v 2>&1 | tail -30`
Expected: PASS, including the pre-existing admin and rollout tests.

Then the whole package: `cd server && go test ./account/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/account/admin_rollout.go server/account/admin_templates.go server/account/admin_rollout_panel_test.go
git commit -m "feat(admin): the node in flight says which of three things it is doing

更新中 was applied to the track's CurrentNodeID for the whole observation
window, so a canary that installed successfully kept reading as 'updating' for
six hours. That single word is the most direct cause of not being able to tell
a healthy rollout from a stuck one.

The row now shows the band and the clock that applies to it, and escalates
visually only once a limit is actually crossed -- a slow link taking forty
minutes to fetch a binary is normal, and colouring it would train the operator
to ignore the colour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: the rules line, the next step, and controls that follow status

**Files:**
- Modify: `server/account/admin_rollout.go` (two more `rolloutPanelView` fields, populated in `rolloutPanel`)
- Modify: `server/account/admin_templates.go` (status line ~229, rules line, control forms ~121-137)
- Modify: `server/account/admin_rollout_panel_test.go` (add the control-set tests)

**Interfaces:**
- Consumes: `byoNextStepText`, `fleetRulesText`, `byoRulesText` from Task 1; `rolloutPanelView.FirstNodeID` from Task 2
- Produces: `rolloutPanelView.RulesText string` and `rolloutPanelView.NextStepText string`

- [ ] **Step 1: Write the failing tests**

Append to `server/account/admin_rollout_panel_test.go`:

```go
// The bug that prompted this work: pressing 继续 on a rolling track returns
// "该轨道当前不是已中止状态". The refusal is correct; offering the button is
// not. This panel's own view model already names the principle -- a button
// whose only possible outcome is a refusal is worse than no button -- and
// already applies it to 回滚到上一版本.
func TestPanelHidesControlsThatCanOnlyBeRefused(t *testing.T) {
	const (
		pauseAction  = "/admin/rollout/fleet/pause"
		resumeAction = "/admin/rollout/fleet/resume"
	)
	cases := []struct {
		name       string
		status     string // "" means the track row exists but was never started
		configured bool
		wantShown  []string
		wantHidden []string
	}{
		{"rolling", "rolling", true, []string{pauseAction}, []string{resumeAction}},
		{"halted", "halted", true, []string{resumeAction}, []string{pauseAction}},
		{"complete", "complete", true, nil, []string{pauseAction, resumeAction}},
		{"never configured", "", false, nil, []string{pauseAction, resumeAction}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ts, _, store := newAdminSettingsServer(t)
			cookie := adminLogin(t, ts)
			now := time.Now().Unix()
			seedRolloutNode(t, store, "n-1", "fleet", "", "v1.0.0", "", "")
			if tc.configured {
				if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
					Track: "fleet", TargetVersion: "v1.1.0", Status: tc.status,
					StageStartedAt: now - 60,
				}); err != nil {
					t.Fatal(err)
				}
			}
			body := adminDashboardHTML(t, ts, cookie)
			for _, want := range tc.wantShown {
				if !strings.Contains(body, want) {
					t.Fatalf("status %q: %s should be offered here but is missing", tc.status, want)
				}
			}
			for _, unwanted := range tc.wantHidden {
				if strings.Contains(body, unwanted) {
					t.Fatalf("status %q: %s is rendered, but pressing it can only be refused",
						tc.status, unwanted)
				}
			}
		})
	}
}

// The timing rules belong on the page, not in an operator's memory.
func TestPanelPrintsTheTimingRules(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	now := time.Now().Unix()
	seedRolloutNode(t, store, "n-1", "fleet", "", "v1.0.0", "", "")
	if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "rolling", StageStartedAt: now - 60,
	}); err != nil {
		t.Fatal(err)
	}
	body := adminDashboardHTML(t, ts, cookie)
	if !strings.Contains(body, humanDuration(fleetFirstWindow)) {
		t.Fatal("panel does not state the canary observation window")
	}
	if !strings.Contains(body, humanDuration(fleetStepWindow)) {
		t.Fatal("panel does not state the per-node window")
	}
	if !strings.Contains(body, humanDuration(byoBatchWindow)) {
		t.Fatal("panel does not state the BYO batch window")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && go test ./account/ -run 'TestPanelHidesControls|TestPanelPrintsTheTimingRules' -v`
Expected: FAIL — both pause and resume render at every status, and the windows are not printed anywhere.

- [ ] **Step 3: Add the two panel fields**

In `server/account/admin_rollout.go`, add to `rolloutPanelView`:

```go
	// RulesText states this track's timing rules on the page, generated from
	// the state machine's constants (see rollout_status.go) so it cannot drift
	// away from them.
	RulesText string
	// NextStepText is set on the BYO panel only: the fleet track's next step is
	// a property of the node in flight and is rendered on that node's row
	// instead. Empty means there is nothing pending to time.
	NextStepText string
```

In `rolloutPanel`, right after `p.StatusText = rolloutStatusText(tr.Status, found)`:

```go
	if track == "fleet" {
		p.RulesText = fleetRulesText()
	} else {
		p.RulesText = byoRulesText()
		if found && tr.Status == "rolling" {
			p.NextStepText = byoNextStepText(tr.StageStartedAt, now.Unix())
		}
	}
```

- [ ] **Step 4: Render them, and make the controls follow status**

In `server/account/admin_templates.go`, after the status line at ~229 (the one containing `正在更新：`), add the rules line and the BYO next step:

```
{{if .NextStepText}}<div style="color:var(--muted);font-size:12px">下一批：{{.NextStepText}}</div>{{end}}
{{if .RulesText}}<div style="color:var(--muted);font-size:12px">{{.RulesText}}</div>{{end}}
```

Then wrap the pause and resume forms (currently at ~125-128) so each renders only where it can succeed:

```
{{if eq .Status "rolling"}}
<form method="post" action="/admin/rollout/{{.Track}}/pause" class="lim"
  onsubmit="return confirm('暂停 {{.Track}} 轨的发布？')"><button type="submit">暂停</button></form>
{{end}}
{{if eq .Status "halted"}}
<form method="post" action="/admin/rollout/{{.Track}}/resume" class="lim"
  onsubmit="return confirm('继续 {{.Track}} 轨的发布？将从头重新分批。')"><button type="submit">继续</button></form>
{{end}}
```

Leave every other control exactly as it is. `设定目标版本`, `回滚` and `紧急发布` are valid in more than one status and are out of scope here.

- [ ] **Step 5: Run the tests**

Run: `cd server && go build ./... && go vet ./account/ && go test ./account/ -run 'TestPanel|TestAdmin|TestRollout|TestEmergency' -v 2>&1 | tail -30`
Expected: PASS, including every pre-existing admin and rollout test.

Then the whole package and the race detector, which CI runs as a separate job:
`cd server && go test ./account/` then `go test -race ./account/`
Expected: PASS both. **The race run on this package takes about five minutes; that is normal, not a hang.**

- [ ] **Step 6: Commit**

```bash
git add server/account/admin_rollout.go server/account/admin_templates.go server/account/admin_rollout_panel_test.go
git commit -m "feat(admin): print the rollout timing rules and hide impossible controls

Pressing 继续 on a rolling track returned '该轨道当前不是已中止状态'. The
refusal was correct and the button should not have been there: this file's own
view model already says a button whose only possible outcome is a refusal is
worse than no button, and already applies that to 回滚到上一版本.

The timing rules now sit under the status instead of in an operator's memory,
generated from the state machine's constants so they cannot drift from it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the reviewer

Three things here are easy to 'tidy' into defects:

- **`fleetNodeStatus` must keep using `max(StageStartedAt, UpdateStartedAt)`.** Simplifying it to `StageStartedAt` looks harmless and collapses a six-hour observation into seconds whenever the stage stamp is stale. `TestFleetNodeStatusUsesLaterOfTheTwoStamps` is the guard.
- **The thresholds must stay references to the state machine's constants**, in the code and in the tests' expected values. A literal `6*3600` anywhere in this change is a defect even when it currently produces the right number.
- **`Overdue` is not "halted".** Both state machines only run when a node polls, so crossing a limit means the consequence lands on the next poll. The copy says so; do not shorten it to a claim about what has already happened.
