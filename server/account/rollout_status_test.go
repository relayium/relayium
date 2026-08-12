package account

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/selfupdate"
)

// A node already on the target version is being OBSERVED, not installed. This
// is the distinction the old 更新中 label denied, and the reason an operator
// could not tell a healthy canary from a stuck one.
func TestFleetNodeStatusOnTargetIsObserving(t *testing.T) {
	const now = 1_000_000
	got := fleetNodeStatus(fleetNodeInput{
		TrackStatus: "rolling",
		OnTarget:    true, IsCanary: true,
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
		TrackStatus: "rolling",
		OnTarget:    true, IsCanary: isCanary,
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
		TrackStatus: "rolling",
		OnTarget:    true, IsCanary: true,
		UpdateStartedAt: now - 600, StageStartedAt: now - 600, LastSeenAt: now - quiet,
	}, now)
	if !strings.Contains(got.Label, "心跳") {
		t.Fatalf("label = %q, want it to say the node stopped heartbeating", got.Label)
	}
	if strings.Contains(got.Detail, "不早于") {
		t.Fatalf("detail = %q, still reporting the observation window on a silent node", got.Detail)
	}
	late := fleetNodeStatus(fleetNodeInput{
		TrackStatus: "rolling",
		OnTarget:    true, IsCanary: true,
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
			TrackStatus: "rolling",
			OnTarget:    true, IsCanary: true,
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
	in := fleetNodeInput{TrackStatus: "rolling", OnTarget: false, UpdateStartedAt: 0, StageStartedAt: now - 60, LastSeenAt: now}
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
		TrackStatus: "rolling",
		OnTarget:    false, UpdateStartedAt: 0, StageStartedAt: now - updateSilenceLimit - 1, LastSeenAt: now,
	}, now); !late.Overdue {
		t.Fatal("past updateSilenceLimit from the stage start must read overdue")
	}
}

// Installing while still heartbeating: the install limit is the one that will
// decide this node's fate, because the silence clock resets every heartbeat.
func TestFleetNodeStatusInstallingShowsInstallLimit(t *testing.T) {
	const now = 1_000_000
	in := fleetNodeInput{TrackStatus: "rolling", OnTarget: false, UpdateStartedAt: now - 600, StageStartedAt: now - 600, LastSeenAt: now}
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
		TrackStatus: "rolling",
		OnTarget:    false, UpdateStartedAt: now - fleetInstallLimit - 1, StageStartedAt: now - fleetInstallLimit - 1, LastSeenAt: now,
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
		TrackStatus: "rolling", OnTarget: false, UpdateStartedAt: now - 600, StageStartedAt: now - 600,
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
	in := fleetNodeInput{TrackStatus: "rolling", OnTarget: true, IsCanary: true, UpdateStartedAt: now - fleetFirstWindow - 600,
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
	observing := fleetNodeStatus(fleetNodeInput{TrackStatus: "rolling", OnTarget: true, UpdateStartedAt: now, StageStartedAt: now, LastSeenAt: now}, now)
	installing := fleetNodeStatus(fleetNodeInput{TrackStatus: "rolling", UpdateStartedAt: now - 60, StageStartedAt: now - 60, LastSeenAt: now}, now)
	notStarted := fleetNodeStatus(fleetNodeInput{TrackStatus: "rolling", StageStartedAt: now - 60, LastSeenAt: now}, now)
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

// A track that is not 'rolling' is INERT: decideFleet's step 1 returns wait for
// every node at every clock. Nothing is being timed, so there is nothing to
// print -- and printing something is not harmless, because HaltRolloutTrack
// leaves current_node_id in place and RESTAMPS stage_started_at. A panel that
// ignores the status therefore reports a six-hour observation window that the
// PAUSE created, and later that the node "将在下一次轮询时中止", which no poll
// can do to an already-halted track.
func TestFleetNodeStatusPrintsNothingOnAnInertTrack(t *testing.T) {
	const now = 1_000_000
	base := fleetNodeInput{
		OnTarget: true, IsCanary: true,
		UpdateStartedAt: now - 60, StageStartedAt: now - 60, LastSeenAt: now,
	}
	// The same node on a rolling track does produce a band, so the cases below
	// are testing the status gate and not an unrelated empty input.
	rolling := base
	rolling.TrackStatus = "rolling"
	if fleetNodeStatus(rolling, now).Band == "" {
		t.Fatal("a rolling track must still produce a band")
	}
	for _, tc := range []struct {
		name      string
		status    string
		emergency bool
	}{
		{"halted", "halted", false},
		{"complete", "complete", false},
		{"never started", "", false},
		// Symmetry with the BYO path only: an emergency short-circuits both
		// state machines before the per-track dispatch, so decideFleet is not
		// reached at all and no fleet track can currently be armed while a node
		// holds the slot. Pinned here so the next emergency path inherits it.
		{"emergency", "rolling", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := base
			in.TrackStatus, in.Emergency = tc.status, tc.emergency
			if got := fleetNodeStatus(in, now); got != (rolloutNodeStatus{}) {
				t.Fatalf("nothing is being timed here, but the panel says %+v", got)
			}
		})
	}
}

// decideFleet:228 halts the whole track on a node that reported failed or
// rolled_back, ABOVE every clock it runs. Without a model of UpdateResult the
// panel answers "you still have 55 minutes of headroom" about the node that is
// stopping the release.
func TestFleetNodeStatusFailedResultIsTerminal(t *testing.T) {
	const now = 1_000_000
	for _, result := range []string{"failed", "rolled_back"} {
		t.Run(result, func(t *testing.T) {
			got := fleetNodeStatus(fleetNodeInput{
				TrackStatus: "rolling", UpdateResult: result,
				// Freshly commanded and heartbeating: every clock in every band
				// has plenty of room, so only the result can produce this.
				UpdateStartedAt: now - 300, StageStartedAt: now - 300, LastSeenAt: now,
			}, now)
			if got.Band != "failed" {
				t.Fatalf("band = %q, want failed", got.Band)
			}
			if !got.Alarm {
				t.Fatalf("%+v: the node that halts the track must escalate", got)
			}
			if strings.Contains(got.Detail, "上限") {
				t.Fatalf("detail = %q, still offering a deadline to a node with no clock left", got.Detail)
			}
			if !strings.Contains(got.Detail, "中止") {
				t.Fatalf("detail = %q, want it to say the track stops because of this node", got.Detail)
			}
		})
	}
}

// decideFleet:248: "skipped" is not a failure. The node declined the update and
// will never reach the target, so its stage is over and the queue advances
// without it -- which is neither "still installing" nor a halt, and the panel
// must not read as either.
func TestFleetNodeStatusSkippedIsNotAFailureAndIsNotTimed(t *testing.T) {
	const now = 1_000_000
	got := fleetNodeStatus(fleetNodeInput{
		TrackStatus: "rolling", UpdateResult: "skipped",
		UpdateStartedAt: now - 300, StageStartedAt: now - 300, LastSeenAt: now,
	}, now)
	if got.Band != "skipped" {
		t.Fatalf("band = %q, want skipped", got.Band)
	}
	if !strings.Contains(got.Label, "不是失败") {
		t.Fatalf("label = %q, want it to say this is not a failure", got.Label)
	}
	if strings.Contains(got.Detail, "上限") || strings.Contains(got.Detail, "中止") {
		t.Fatalf("detail = %q: a skipped node is neither being timed nor halting the track", got.Detail)
	}
}

// "unreachable" is the same queue outcome as "skipped" and a different fact
// about the world, so it gets its own band rather than borrowing that one: the
// operator's next move is to fix the source and retry, not to open up the node.
// Like skipped it is not timed and does not halt.
func TestFleetNodeStatusUnreachableIsItsOwnBandAndIsNotTimed(t *testing.T) {
	const now = 1_000_000
	got := fleetNodeStatus(fleetNodeInput{
		TrackStatus: "rolling", UpdateResult: "unreachable",
		UpdateStartedAt: now - 300, StageStartedAt: now - 300, LastSeenAt: now,
	}, now)
	if got.Band != "unreachable" {
		t.Fatalf("band = %q, want unreachable", got.Band)
	}
	skipped := fleetNodeStatus(fleetNodeInput{
		TrackStatus: "rolling", UpdateResult: "skipped",
		UpdateStartedAt: now - 300, StageStartedAt: now - 300, LastSeenAt: now,
	}, now)
	if got.Label == skipped.Label {
		t.Fatalf("unreachable and skipped render the same label %q, so the panel cannot tell an operator which one it is", got.Label)
	}
	if !strings.Contains(got.Label, "不是失败") {
		t.Fatalf("label = %q: a node that never got the bytes made no judgement about the build", got.Label)
	}
	if strings.Contains(got.Detail, "上限") || strings.Contains(got.Detail, "中止") {
		t.Fatalf("detail = %q: an unreachable node is neither being timed nor halting the track", got.Detail)
	}
	if got.Overdue {
		t.Fatalf("no clock is running on this node, so no limit can have passed: %+v", got)
	}
}

// In the observing band a crossed limit is the window's SUCCESSFUL end: the
// canary did its six hours and is waiting up to ten minutes for a poll. Painting
// that the same red as a node about to be aborted is how an operator learns to
// ignore the colour, so Alarm -- which is what the template escalates on -- is
// never set there, while the bands where a crossed limit is trouble do set it.
func TestFleetNodeStatusObservingNeverAlarms(t *testing.T) {
	const now = 1_000_000
	done := observingAt(true, now-fleetFirstWindow-1, now)
	if !done.Overdue {
		t.Fatal("a canary past its window should read overdue")
	}
	if done.Alarm {
		t.Fatalf("%+v: a finished observation window is a success, not an alarm", done)
	}
	stuck := fleetNodeStatus(fleetNodeInput{
		TrackStatus: "rolling", OnTarget: false,
		UpdateStartedAt: now - fleetInstallLimit - 1, StageStartedAt: now - fleetInstallLimit - 1,
		LastSeenAt: now,
	}, now)
	if !stuck.Overdue || !stuck.Alarm {
		t.Fatalf("%+v: a node past the install limit is about to halt the track and must escalate", stuck)
	}
}

// A node that goes dark does not pause the clock it was already running:
// decideFleet reads the same stamps whether or not the node heartbeats. Showing
// only the silence clock presented a stage that had already ENDED as one with
// fourteen minutes left.
func TestFleetNodeStatusSilenceDoesNotHideAnExpiredBandClock(t *testing.T) {
	const now = 1_000_000
	quiet := int64(nodeOnlineWindow/time.Second) + 1
	got := fleetNodeStatus(fleetNodeInput{
		TrackStatus: "rolling", OnTarget: false,
		UpdateStartedAt: now - fleetInstallLimit - 1, StageStartedAt: now - fleetInstallLimit - 1,
		LastSeenAt: now - quiet,
	}, now)
	if !strings.Contains(got.Label, "心跳") {
		t.Fatalf("label = %q, want it to say the node has gone quiet", got.Label)
	}
	if !got.Overdue || !got.Alarm {
		t.Fatalf("%+v: the install limit passed while the node was dark; decideFleet halts on it", got)
	}
	if !strings.Contains(got.Detail, humanDuration(fleetInstallLimit)) {
		t.Fatalf("detail = %q, want the limit that actually expired (%s)", got.Detail, humanDuration(fleetInstallLimit))
	}
}

func TestByoNextStepText(t *testing.T) {
	const now = 1_000_000
	open := byoNextStepText(10, now-60, now)
	if !strings.Contains(open, "不早于") {
		t.Fatalf("byoNextStepText = %q, want the 不早于 phrasing", open)
	}
	closed := byoNextStepText(10, now-byoBatchWindow-1, now)
	if !strings.Contains(closed, "等待下一次轮询") {
		t.Fatalf("closed window text = %q, want it to wait for the next poll", closed)
	}
	if strings.Contains(closed, "-") {
		t.Fatalf("closed window text %q contains a negative duration", closed)
	}
	// A fresh track has no window to wait out: decideByo opens its first batch
	// immediately. Inventing a six-hour wait here would be the panel claiming a
	// delay the state machine does not have.
	fresh := byoNextStepText(0, now, now)
	if strings.Contains(fresh, "不早于") {
		t.Fatalf("fresh track text = %q, want no waiting period", fresh)
	}
	if !strings.Contains(fresh, "下一次轮询") {
		t.Fatalf("fresh track text = %q, want it to say the first batch goes out on the next poll", fresh)
	}
}

// At the widest batch there is no wider batch: decideByo's ladder is exhausted
// and the window's close brings either completion or a re-sweep of whoever is
// still behind. The TIME is right; the noun 下一批 names something that does not
// exist.
func TestByoNextStepLabel(t *testing.T) {
	widest := byoBatches[len(byoBatches)-1]
	if got := byoNextStepLabel(byoBatches[0]); got != "下一批" {
		t.Fatalf("byoNextStepLabel(%d) = %q, want 下一批", byoBatches[0], got)
	}
	got := byoNextStepLabel(widest)
	if strings.Contains(got, "下一批") {
		t.Fatalf("byoNextStepLabel(%d) = %q: there is no batch after the widest one", widest, got)
	}
	if got == "" {
		t.Fatal("the widest batch still needs a label for the time it prints")
	}
}

// The rules line is generated from the constants, so tuning one moves the
// state machine and the sentence together.
func TestRulesTextIsGeneratedFromConstants(t *testing.T) {
	fleet := fleetRulesText(false)
	for _, want := range []string{humanDuration(fleetFirstWindow), humanDuration(fleetStepWindow)} {
		if !strings.Contains(fleet, want) {
			t.Fatalf("fleetRulesText = %q, want it to contain %q", fleet, want)
		}
	}
	// The fast form states its own limit, and it must be the state machine's
	// too: in that mode running out of patience is a HALT, so a hand-typed
	// duration here would be the panel promising a deadline nothing enforces.
	fast := fleetRulesText(true)
	if !strings.Contains(fast, humanDuration(fleetInstallLimit)) {
		t.Fatalf("fleetRulesText(fast) = %q, want it to contain %q", fast, humanDuration(fleetInstallLimit))
	}
	// It must also state the trigger latency HONESTLY, and that is two different
	// numbers on two kinds of node: a node that supports the immediate-check
	// hint is asked on its next heartbeat, and one that does not still waits out
	// its ~10-minute timer. Reporting only the fast number would promise a pace
	// most of the fleet cannot deliver until it has been re-provisioned; the
	// heartbeat figure comes from nodeHeartbeatInterval so it moves with the
	// wire, not from a literal.
	if !strings.Contains(fast, fmt.Sprintf("%d 秒", nodeHeartbeatInterval)) {
		t.Errorf("fleetRulesText(fast) = %q, want the heartbeat interval (%d 秒)", fast, nodeHeartbeatInterval)
	}
	if !strings.Contains(fast, "10 分钟") {
		t.Errorf("fleetRulesText(fast) = %q, want the old-client timer fallback stated", fast)
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

// ---------------------------------------------------------------------------
// The panel, tied to the state machine.
//
// Five defects on this work were the same defect: a predicate here that had
// been hand-copied out of decideFleet and then drifted from it. NONE was caught
// by a test, because every test was written from the same wrong understanding
// as the code it was testing -- assert that 观察中 appears, and it appears,
// including on a track that was paused six hours ago and is timing nothing.
//
// The tests above still do that, one band at a time. The sweep below does the
// one thing they cannot: it runs decideFleet and fleetNodeStatus over the SAME
// track, the SAME node and the SAME clock, across the state space, and asserts
// properties that relate one to the other. A drift now has to survive a
// comparison against the authority rather than against a second copy of the
// misunderstanding.
//
// This is the only place in the package that calls decideFleet from panel code
// -- and it is a TEST. admin_rollout.go and rollout_status.go must never call
// it: the panel describes, it never decides, because two authorities means an
// operator eventually believes the wrong one.
// ---------------------------------------------------------------------------

// fleetSweepAge is one clock offset, named after the threshold it straddles so
// a failure says which boundary broke. Every value is derived from a constant;
// none is a literal, so tuning fleetFirstWindow (or any of the others) moves the
// state machine, the panel and this sweep together.
type fleetSweepAge struct {
	name string
	ago  int64 // seconds before `now`; negative means "no stamp at all"
}

func fleetSweepAges() []fleetSweepAge {
	online := int64(nodeOnlineWindow / time.Second)
	return []fleetSweepAge{
		{"just now", 0},
		{"just inside the online window", online - 1},
		{"just past the online window", online + 1},
		{"just inside the silence limit", updateSilenceLimit - 1},
		{"just past the silence limit", updateSilenceLimit + 1},
		{"just inside the step window", fleetStepWindow - 1},
		{"just past the step window", fleetStepWindow + 1},
		{"just inside the install limit", fleetInstallLimit - 1},
		{"just past the install limit", fleetInstallLimit + 1},
		{"just inside the canary window", fleetFirstWindow - 1},
		{"just past the canary window", fleetFirstWindow + 1},
	}
}

// TestPanelStatusAgreesWithDecideFleet is the regression guard for the whole
// class. Three properties, each one a thing an operator reads off the panel:
//
//  1. When decideFleet is about to DO something to the node holding the slot --
//     anything other than wait -- the panel must not be calm about it. "Calm" is
//     a non-empty band with neither Alarm nor Overdue set: a clock that is
//     running and has time left. That is the sentence "come back later", and it
//     is a lie about a track that is halting, or advancing past this node.
//
//  2. When decideFleet waits at `now` AND still waits arbitrarily far in the
//     future on the very same data, nothing is being timed at all -- the track
//     is inert (halted, complete, never started). The panel must print no band.
//     This is the property a paused rollout breaks: HaltRolloutTrack keeps
//     current_node_id and restamps stage_started_at, so a panel that does not
//     check the track's status reports a fresh six-hour observation window that
//     the PAUSE created.
//
//  3. When decideFleet is still waiting, the panel must not claim a limit has
//     passed. This is the mirror of (1) and it is what a wrong window looks
//     like: the panel marking a healthy canary overdue at 31 minutes because it
//     guessed the 30-minute window where the state machine gave it six hours.
func TestPanelStatusAgreesWithDecideFleet(t *testing.T) {
	const (
		nodeID = "n-slot"
		target = "v1.1.0"
		behind = "v1.0.0"
	)
	now := int64(1_700_000_000)
	// Far enough that every clock decideFleet runs has expired, whatever the
	// stamps were: the longest of them, plus the other two for good measure.
	// Nothing here is a literal duration.
	far := now + fleetFirstWindow + fleetInstallLimit + updateSilenceLimit

	ages := fleetSweepAges()
	// LastSeenAt only ever meets two thresholds -- the online window and the
	// silence limit -- so the first five offsets exercise everything it can do.
	seenAges := ages[:5]

	checked := 0
	// manualFast is swept alongside emergency because it is the second flag
	// that changes what decideFleet does with the node holding the slot -- it
	// replaces both observation windows with "has this node REPORTED ok yet",
	// bounded by fleetInstallLimit. A panel that kept printing window clocks in
	// that mode would be calm about a node the state machine is about to halt
	// the track on, which is exactly property 1 below.
	for _, status := range []string{"rolling", "halted", "complete"} {
		for _, manualFast := range []bool{false, true} {
			for _, emergency := range []bool{false, true} {
				for _, result := range []string{"", "ok", "failed", "rolled_back", "skipped", "unreachable"} {
					for _, onTarget := range []bool{false, true} {
						// The canary is positional: the node itself, somebody else,
						// or a track written before the field existed (both
						// decideFleet and the panel must read "" as "the node in
						// flight IS the canary").
						for _, firstNodeID := range []string{nodeID, "n-someone-else", ""} { //nolint:revive // depth is the point: this is an exhaustive sweep
							for _, stage := range ages {
								for _, started := range ages {
									for _, seen := range seenAges {
										tr := RolloutTrack{
											Track: "fleet", TargetVersion: target, Status: status,
											Emergency: emergency, ManualFast: manualFast,
											CurrentNodeID: nodeID, FirstNodeID: firstNodeID,
											StageStartedAt: now - stage.ago,
										}
										n := NodeSnapshot{
											ID: nodeID, Version: behind,
											LastSeenAt:        now - seen.ago,
											UpdateStartedAt:   now - started.ago,
											UpdateFromVersion: behind,
											UpdateResult:      result,
										}
										if onTarget {
											n.Version = target
										}
										desc := fmt.Sprintf(
											"status=%s manualFast=%v emergency=%v result=%q onTarget=%v firstNodeID=%q stage=%s update=%s lastSeen=%s",
											status, manualFast, emergency, result, onTarget, firstNodeID, stage.name, started.name, seen.name)
										assertPanelAgreesWithDecideFleet(t, desc, tr, n, now, far)
										checked++

										// The same tuple with the node's own update
										// stamp missing entirely: central's two
										// writes split, which is a state both
										// functions have a dedicated backstop for.
										n.UpdateStartedAt = 0
										assertPanelAgreesWithDecideFleet(t,
											desc+" update=never recorded", tr, n, now, far)
										checked++
									}
								}
							}
						}
					}
				}
			}
		}
	}
	// A sweep that silently stopped generating cases would pass forever.
	if checked < len(ages)*len(ages)*len(seenAges) {
		t.Fatalf("swept only %d combinations; the table stopped generating", checked)
	}
	t.Logf("swept %d (track, node, clock) combinations", checked)
}

// assertPanelAgreesWithDecideFleet runs both functions over one tuple and checks
// the three properties. It builds the classifier's input through
// newFleetNodeInput -- the same constructor admin_rollout.go uses -- so the
// panel under test here is the panel that ships, not a second transcription of
// it.
func assertPanelAgreesWithDecideFleet(t *testing.T, desc string, tr RolloutTrack, n NodeSnapshot, now, far int64) {
	t.Helper()
	nodes := []NodeSnapshot{n}
	onTarget := selfupdate.SameVersion(n.Version, tr.TargetVersion)
	st := fleetNodeStatus(newFleetNodeInput(tr, n, onTarget), now)
	d := decideFleet(tr, nodes, now)

	calm := st.Band != "" && !st.Alarm && !st.Overdue
	if d.Action != "wait" && calm {
		t.Fatalf("%s\ndecideFleet = %+v (it is about to act on this node), but the panel is calm about it: %+v",
			desc, d, st)
	}
	if d.Action == "wait" && st.Overdue {
		t.Fatalf("%s\ndecideFleet is still waiting, but the panel says a limit has already passed: %+v",
			desc, st)
	}
	if d.Action == "wait" && decideFleet(tr, nodes, far).Action == "wait" && st.Band != "" {
		t.Fatalf("%s\ndecideFleet waits on this node now AND %d seconds later on identical data, "+
			"so no clock is running on it -- but the panel prints one: %+v", desc, far-now, st)
	}
}
