package account

import (
	"strings"
	"testing"
)

// Canary-then-fast (RolloutTrack.FastAfterCanary) is the operator saying "ship
// this now, on a version the fleet has never run". It is the SAFE first-use form
// of the fast ladder, and these tests pin the one line that makes it safe: the
// FIRST node keeps the entire six-hour observation window AND must report
// success while actually running the target, and only the machines after it stop
// waiting for each other.
//
// They are written against decideFleet directly, the same way the staged and
// manual-fast tests are, because it is a pure function: six hours is an integer
// here, not a wait.

// canaryFastTrack is the track under test with the canary in flight. Written as
// one helper because every case below varies only the node's answers and the
// clock, and a hand-copied literal per test is how a "canary" that is not the
// recorded FirstNodeID slips into a case and makes it prove nothing.
func canaryFastTrack(stageAgo int64) RolloutTrack {
	return RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", FastAfterCanary: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - stageAgo,
	}
}

// THE POINT OF THE MODE, first half. The canary reported success and is really
// running the target — the exact state manual fast mode advances on within
// minutes — and this mode still waits, for the whole six hours.
//
// The control at the end is what makes this test about the FLAG: the identical
// state in manual fast mode advances immediately.
func TestDecideFleetCanaryFastWaitsOutTheFullCanaryWindowDespiteOK(t *testing.T) {
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	// A minute in, an hour in, and one second before the window closes: all wait.
	for _, ago := range []int64{60, 3600, fleetFirstWindow - 1} {
		tr := canaryFastTrack(ago)
		nodes[0].UpdateStartedAt = tNow - ago
		if got := decideFleet(tr, nodes, tNow); got.Action != "wait" {
			t.Fatalf("%ds into the canary window: decideFleet = %+v, want wait", ago, got)
		}
	}

	// Control: manual fast mode on the same data ships the second node now. If
	// this ever stops holding, the test above is passing for some other reason.
	fast := canaryFastTrack(60)
	fast.FastAfterCanary, fast.ManualFast = false, true
	nodes[0].UpdateStartedAt = tNow - 60
	if got := decideFleet(fast, nodes, tNow); got.Action != "update" || got.NodeID != "n2" {
		t.Fatalf("manual fast control = %+v, want update n2", got)
	}
}

// THE POINT OF THE MODE, second half. Once the canary has BOTH reported success
// and spent its six hours, the next node is commanded — and the 30-minute soak
// that the staged ladder would then impose between machines is gone.
func TestDecideFleetCanaryFastAdvancesOnceTheWindowCloses(t *testing.T) {
	tr := canaryFastTrack(fleetFirstWindow)
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok",
			UpdateStartedAt: tNow - fleetFirstWindow},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
		{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
	}
	got := decideFleet(tr, nodes, tNow)
	if got.Action != "update" {
		t.Fatalf("decideFleet = %+v, want update once the canary cleared its window", got)
	}
	if got.NodeID == "n1" {
		t.Fatalf("decideFleet re-picked the canary: %+v", got)
	}
	if got.IsFirst {
		t.Errorf("the node after the canary was reported as the canary: %+v", got)
	}

	// ...and the SECOND node is not made to wait fleetStepWindow either: that is
	// the whole speed-up. It reports success at the moment it is on target, and
	// the third node is commanded on the very next evaluation.
	tr.CurrentNodeID = got.NodeID
	tr.StageStartedAt = tNow // its stage starts now, so no soak has elapsed
	for i := range nodes {
		if nodes[i].ID == got.NodeID {
			nodes[i].Version, nodes[i].UpdateResult, nodes[i].UpdateStartedAt = "v0.9.0", "ok", tNow
		}
	}
	next := decideFleet(tr, nodes, tNow)
	if next.Action != "update" || next.NodeID == got.NodeID || next.NodeID == "n1" {
		t.Fatalf("second node = %+v, want the third node commanded with no inter-node soak", next)
	}

	// Control: the staged ladder on that identical state DOES impose the soak.
	staged := tr
	staged.FastAfterCanary = false
	if got := decideFleet(staged, nodes, tNow); got.Action != "wait" {
		t.Fatalf("staged control = %+v, want wait (fleetStepWindow must still apply there)", got)
	}
}

// TIME ALONE IS NOT A PASS. Six quiet hours with no reported outcome must never
// promote the canary — and the wait is bounded, so the track stops rather than
// sitting in 发布中 forever behind a node whose updater died between installing
// and reporting.
//
// The halt lands at fleetInstallLimit, well before the six hours are up, which
// is the safe direction: the canary window is a MINIMUM to observe, never a
// deadline after which a silent node counts as proven.
func TestDecideFleetCanaryFastNeverAdvancesOnTimeWithoutAResult(t *testing.T) {
	// Inside the result limit: waiting, not advancing.
	early := canaryFastTrack(fleetInstallLimit - 1)
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "",
			UpdateStartedAt: tNow - (fleetInstallLimit - 1)},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	if got := decideFleet(early, nodes, tNow); got.Action != "wait" {
		t.Fatalf("decideFleet = %+v, want wait: on target but no reported outcome yet", got)
	}

	// Past it — and at the six-hour mark, the case the operator would most
	// expect to "just go through". It halts, and it certainly never updates.
	for _, ago := range []int64{fleetInstallLimit + 1, fleetFirstWindow, fleetFirstWindow + 1} {
		tr := canaryFastTrack(ago)
		nodes[0].UpdateStartedAt = tNow - ago
		got := decideFleet(tr, nodes, tNow)
		if got.Action != "halt" {
			t.Fatalf("%ds in with no result: decideFleet = %+v, want halt", ago, got)
		}
		if !strings.Contains(got.Reason, "n1") {
			t.Errorf("halt reason %q does not name the node it is about", got.Reason)
		}
	}
}

// A canary claiming success while still running the old version is a
// contradiction, and in this mode "ok" is half of what promotes it — so it must
// halt rather than be waited out for six hours and then acted on.
func TestDecideFleetCanaryFastHaltsOnOKWithoutTheTargetVersion(t *testing.T) {
	// Both inside and outside the window: the contradiction is not a clock.
	for _, ago := range []int64{60, fleetFirstWindow + 1} {
		tr := canaryFastTrack(ago)
		nodes := []NodeSnapshot{
			{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: "ok",
				UpdateStartedAt: tNow - ago},
			{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
		}
		got := decideFleet(tr, nodes, tNow)
		if got.Action != "halt" {
			t.Fatalf("%ds in: decideFleet = %+v, want halt on a contradictory result", ago, got)
		}
		if !strings.Contains(got.Reason, "v0.9.0") {
			t.Errorf("halt reason %q does not name the target the node claims to have installed", got.Reason)
		}
	}
}

// A PASS-OVER IS NOT A SUCCESS, and here it is not an observation either: six
// hours cannot be spent watching a build the machine never installed. The staged
// ladder's "leave it behind and carry on" would mean the rest of the fleet
// moving with nothing having run the release at all.
func TestDecideFleetCanaryFastHaltsOnAPassOver(t *testing.T) {
	for _, result := range []string{"skipped", "unreachable"} {
		t.Run(result, func(t *testing.T) {
			tr := canaryFastTrack(60)
			nodes := []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: result, UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			}
			got := decideFleet(tr, nodes, tNow)
			if got.Action != "halt" {
				t.Fatalf("decideFleet = %+v, want halt: %q means the canary never ran the build", got, result)
			}
			if !strings.Contains(got.Reason, "n1") || !strings.Contains(got.Reason, result) {
				t.Errorf("halt reason %q must name the node and the result", got.Reason)
			}
			// The reason must name THIS mode, not the other one: an incident
			// review reading "manual fast" would conclude the canary window had
			// been skipped when it was kept.
			if !strings.Contains(got.Reason, "canary-then-fast") {
				t.Errorf("halt reason %q does not name the mode that stopped", got.Reason)
			}
		})
	}
}

// Every halting outcome the other two modes have, this one has — for the canary
// AND for a node after it, because the fast half of this mode is exactly as
// exposed as manual fast mode is. Asserting on the whole decision (never
// "update") is what checks that the halt lands BEFORE another machine is
// commanded.
func TestDecideFleetCanaryFastHaltsOnEveryBadOutcome(t *testing.T) {
	// past is a canary that has already cleared its window, so these cases test
	// the fast half of the mode rather than the window holding everything back.
	for _, node := range []struct {
		name    string
		track   func() RolloutTrack
		current string
		first   string
	}{
		{name: "canary", track: func() RolloutTrack { return canaryFastTrack(60) }, current: "n1", first: "n1"},
		{name: "after the canary", current: "n2", first: "n1", track: func() RolloutTrack {
			tr := canaryFastTrack(60)
			tr.CurrentNodeID = "n2"
			return tr
		}},
	} {
		t.Run(node.name, func(t *testing.T) {
			for _, result := range []string{"failed", "rolled_back", "skipped", "unreachable"} {
				t.Run(result, func(t *testing.T) {
					tr := node.track()
					nodes := []NodeSnapshot{
						{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok",
							UpdateStartedAt: tNow - fleetFirstWindow - 60},
						{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: tNow - 60},
						{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
					}
					for i := range nodes {
						if nodes[i].ID == node.current {
							nodes[i].Version, nodes[i].UpdateResult = "v0.8.0", result
						}
					}
					if got := decideFleet(tr, nodes, tNow); got.Action != "halt" {
						t.Fatalf("decideFleet = %+v, want halt on %s", got, result)
					}
				})
			}

			// Silence: commanded, then stopped heartbeating. A bricked machine
			// stops this rollout exactly as it stops the other two.
			t.Run("silent", func(t *testing.T) {
				tr := node.track()
				tr.StageStartedAt = tNow - updateSilenceLimit - 60
				nodes := []NodeSnapshot{
					{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok",
						UpdateStartedAt: tNow - fleetFirstWindow - 60},
					{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: tNow - 60},
					{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
				}
				for i := range nodes {
					if nodes[i].ID == node.current {
						nodes[i].Version = "v0.8.0"
						nodes[i].UpdateResult = ""
						nodes[i].LastSeenAt = tNow - updateSilenceLimit - 1
						nodes[i].UpdateStartedAt = tNow - updateSilenceLimit - 60
					}
				}
				if got := decideFleet(tr, nodes, tNow); got.Action != "halt" {
					t.Fatalf("decideFleet = %+v, want halt on a silent node", got)
				}
			})

			// Vanished from the snapshot entirely: silence, never "gone, move on".
			t.Run("vanished", func(t *testing.T) {
				tr := node.track()
				tr.StageStartedAt = tNow - updateSilenceLimit - 1
				var nodes []NodeSnapshot
				for _, n := range []NodeSnapshot{
					{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok",
						UpdateStartedAt: tNow - fleetFirstWindow - 60},
					{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
					{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
				} {
					if n.ID != node.current {
						nodes = append(nodes, n)
					}
				}
				if got := decideFleet(tr, nodes, tNow); got.Action != "halt" {
					t.Fatalf("decideFleet = %+v, want halt on a vanished node", got)
				}
			})

			// Wedged: heartbeating, commanded, never converging. The one timeout
			// that does not depend on the wedged node polling again.
			t.Run("wedged", func(t *testing.T) {
				tr := node.track()
				tr.StageStartedAt = tNow - fleetInstallLimit - 60
				nodes := []NodeSnapshot{
					{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok",
						UpdateStartedAt: tNow - fleetFirstWindow - 60},
					{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
					{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
				}
				for i := range nodes {
					if nodes[i].ID == node.current {
						nodes[i].Version, nodes[i].UpdateResult = "v0.8.0", ""
						nodes[i].UpdateStartedAt = tNow - fleetInstallLimit - 1
					}
				}
				if got := decideFleet(tr, nodes, tNow); got.Action != "halt" {
					t.Fatalf("decideFleet = %+v, want halt on a wedged node", got)
				}
			})
		})
	}
}

// One at a time, for the WHOLE run: the canary's six hours are not the only
// serialisation, and the nodes after it are still commanded one by one. This
// drives a full three-node rollout and asserts on every intermediate decision,
// which is the property an operator watching 正在更新 is reading off the panel.
func TestDecideFleetCanaryFastRunsOneAtATimeThroughout(t *testing.T) {
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 0},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 1},
		{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 2},
	}
	tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		FastAfterCanary: true, StageStartedAt: tNow}
	now := tNow

	seen := map[string]bool{}
	for i := 0; i < len(nodes); i++ {
		d := decideFleet(tr, nodes, now)
		if d.Action != "update" {
			t.Fatalf("round %d: decideFleet = %+v, want update", i, d)
		}
		if seen[d.NodeID] {
			t.Fatalf("round %d: node %s picked twice", i, d.NodeID)
		}
		seen[d.NodeID] = true
		isCanary := d.IsFirst
		if (i == 0) != isCanary {
			t.Fatalf("round %d: IsFirst = %v", i, isCanary)
		}
		// Central claims the node, then the node installs.
		tr.CurrentNodeID = d.NodeID
		if isCanary {
			tr.FirstNodeID = d.NodeID
		}
		tr.StageStartedAt = now
		for j := range nodes {
			if nodes[j].ID == d.NodeID {
				nodes[j].Version, nodes[j].UpdateStartedAt = "v0.9.0", now
			}
		}
		// Installed but not yet reported: nothing else may be picked.
		if got := decideFleet(tr, nodes, now); got.Action != "wait" {
			t.Fatalf("round %d: decideFleet = %+v while the node in flight has not reported", i, got)
		}
		for j := range nodes {
			if nodes[j].ID == d.NodeID {
				nodes[j].UpdateResult = "ok"
			}
		}
		if isCanary {
			// Reported, window still open: still nothing else may be picked.
			if got := decideFleet(tr, nodes, now); got.Action != "wait" {
				t.Fatalf("canary reported ok but its window is open: decideFleet = %+v, want wait", got)
			}
			now += fleetFirstWindow
			// The fleet keeps heartbeating across those six hours. Leaving the
			// stamps behind would make every node read as silent and halt the
			// track on a condition this test is not about.
			for j := range nodes {
				nodes[j].LastSeenAt = now
			}
		}
	}
	if d := decideFleet(tr, nodes, now); d.Action != "complete" {
		t.Fatalf("after every node: decideFleet = %+v, want complete", d)
	}
}

// The mode changes WAITING, not WHO: the canary is still the least-loaded
// machine, so the node that spends six hours proving the build is still the one
// with the least in flight to lose.
func TestDecideFleetCanaryFastStillPicksTheLeastLoadedCanary(t *testing.T) {
	tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		FastAfterCanary: true, StageStartedAt: tNow}
	nodes := []NodeSnapshot{
		{ID: "busy-a", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 9},
		{ID: "idle-b", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 0},
	}
	if got := decideFleet(tr, nodes, tNow); got.NodeID != "idle-b" || !got.IsFirst {
		t.Fatalf("decideFleet = %+v, want idle-b as the first pick", got)
	}
}

// A track that is not rolling is inert on every path, and this flag must not
// resurrect one — the same property manual fast and emergency have.
func TestDecideFleetCanaryFastIsInertOnANonRollingTrack(t *testing.T) {
	for _, status := range []string{"halted", "complete", ""} {
		tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: status, FastAfterCanary: true}
		nodes := []NodeSnapshot{{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow}}
		if got := decideFleet(tr, nodes, tNow); got.Action != "wait" {
			t.Errorf("status %q: decideFleet = %+v, want wait", status, got)
		}
	}
}

// A track written before this field existed, with a node in flight and no
// recorded canary, must be treated as "the node in flight IS the canary" — the
// same fail-long rule the staged ladder and the panel use. Guessing the other
// way would cut a live canary's six hours to nothing on the deploy that ships
// this column.
func TestDecideFleetCanaryFastTreatsAnUnrecordedCanaryAsTheCanary(t *testing.T) {
	tr := canaryFastTrack(60)
	tr.FirstNodeID = "" // migrated row
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	if got := decideFleet(tr, nodes, tNow); got.Action != "wait" {
		t.Fatalf("decideFleet = %+v, want wait: an unrecorded canary must still get its window", got)
	}
}

// The three modes are mutually exclusive at every write. If a row ever carried
// two of them anyway, the branch taken must be the one that KEEPS the canary's
// window: every defence on this ladder fails long.
func TestDecideFleetPrefersTheSaferModeIfBothFlagsAreSet(t *testing.T) {
	tr := canaryFastTrack(60)
	tr.ManualFast = true // impossible by construction; a writer bug if it happens
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	if got := decideFleet(tr, nodes, tNow); got.Action != "wait" {
		t.Fatalf("decideFleet = %+v, want wait: with both flags set the canary window must win", got)
	}
}

// The immediate-check hint follows this mode too — it is a hint and authorises
// nothing, and both wrong answers are safe — but it must never hurry a LATER
// node into the queue while the canary's window is still open, because the
// answer it gives is derived from decideFleet, which waits.
func TestFleetFastHintForCanaryFast(t *testing.T) {
	tr := canaryFastTrack(60)
	snaps := []NodeSnapshot{
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "", UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	// The node in flight with no result yet: its report is the rollout's pace.
	if !fleetFastHintFor(tr, snaps, "n1", tNow) {
		t.Error("the node holding the slot was not hinted")
	}
	// Another node while the canary is still being observed: not its turn.
	snaps[0].UpdateResult = "ok"
	if fleetFastHintFor(tr, snaps, "n2", tNow) {
		t.Error("a later node was hinted while the canary window was still open")
	}
	// Once the window closes it IS its turn. The whole fleet has gone on
	// heartbeating across those six hours; leaving the stamps at tNow would make
	// every node read as silent and halt the track instead.
	later := tNow + fleetFirstWindow
	for i := range snaps {
		snaps[i].LastSeenAt = later
	}
	if !fleetFastHintFor(tr, snaps, "n2", later) {
		t.Error("the next node was not hinted after the canary window closed")
	}
	// The staged ladder still hints nobody: there the wait is the point.
	staged := tr
	staged.FastAfterCanary = false
	if fleetFastHintFor(staged, snaps, "n2", later) {
		t.Error("the staged ladder hinted a node")
	}
}
