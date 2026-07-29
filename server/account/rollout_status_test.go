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

// observingAt evaluates a heartbeating on-target node at some later instant.
// LastSeenAt has to track that instant: a real node heartbeats every 30s, and
// the silence branch sits above the window branch, so pinning LastSeenAt to
// the start would make every hours-later evaluation report silence instead of
// the window under test.
func observingAt(isCanary bool, start, now int64) rolloutNodeStatus {
	return fleetNodeStatus(fleetNodeInput{
		OnTarget: true, IsCanary: isCanary,
		UpdateStartedAt: start, StageStartedAt: start, LastSeenAt: now,
	}, now)
}

// The canary gets the long window and every later node the short one.
func TestFleetNodeStatusWindowDependsOnCanary(t *testing.T) {
	const start = 1_000_000
	if observingAt(true, start, start+fleetFirstWindow-1).Overdue {
		t.Fatal("canary window closed early")
	}
	if !observingAt(true, start, start+fleetFirstWindow).Overdue {
		t.Fatal("canary window did not close on time")
	}
	// A later node uses the short window, so it is already due at that point.
	if !observingAt(false, start, start+fleetStepWindow).Overdue {
		t.Fatal("step window did not close on time")
	}
	if observingAt(false, start, start+fleetStepWindow-1).Overdue {
		t.Fatal("step window closed early")
	}
}

// decideFleet halts on silence BEFORE it looks at the version
// (rollout_fleet.go:252 sits above the !onTarget branch at :255). A node that
// installed successfully and then went dark is not calmly 观察中 -- the track
// is about to halt on it, and a panel reporting "还有 5 小时" there would be
// lying in the band it presents as the safe one.
func TestFleetNodeStatusOnTargetButQuietReportsSilence(t *testing.T) {
	const now = 1_000_000
	quiet := int64(nodeOnlineWindow/time.Second) + 1
	got := fleetNodeStatus(fleetNodeInput{
		OnTarget: true, IsCanary: true,
		UpdateStartedAt: now - 600, StageStartedAt: now - 600, LastSeenAt: now - quiet,
	}, now)
	if !strings.Contains(got.Label, "心跳") {
		t.Fatalf("label = %q, want it to say the node stopped heartbeating", got.Label)
	}
	if strings.Contains(got.Detail, "不早于") {
		t.Fatalf("detail = %q, still reporting the observation window on a silent node", got.Detail)
	}
	late := fleetNodeStatus(fleetNodeInput{
		OnTarget: true, IsCanary: true,
		UpdateStartedAt: now - 600, StageStartedAt: now - 600,
		LastSeenAt: now - updateSilenceLimit - 1,
	}, now)
	if !late.Overdue {
		t.Fatal("an on-target node silent past updateSilenceLimit must read overdue")
	}
}

// The trap rollout_fleet.go:285-288 records: the two stamps are written by
// different code paths, and taking StageStartedAt alone collapses a six-hour
// observation into seconds. The panel must not reproduce it.
func TestFleetNodeStatusUsesLaterOfTheTwoStamps(t *testing.T) {
	const now = 1_000_000
	// A StageStartedAt left over from the PREVIOUS stage, long past.
	stale := func(at int64) rolloutNodeStatus {
		return fleetNodeStatus(fleetNodeInput{
			OnTarget: true, IsCanary: true,
			StageStartedAt:  now - fleetFirstWindow - 3600,
			UpdateStartedAt: now,
			LastSeenAt:      at, // heartbeating, so the silence branch stays out of it
		}, at)
	}
	if stale(now).Overdue {
		t.Fatal("a stale StageStartedAt collapsed the observation window")
	}
	if stale(now + fleetFirstWindow - 1).Overdue {
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
