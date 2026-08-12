package account

import (
	"strings"
	"testing"
)

// Manual fast mode is the operator saying "ship this now, but keep every
// safety property except the waiting". These tests pin exactly which half is
// which: the WINDOWS go (canary observation, inter-node soak), and NOTHING
// else does — one node at a time, each node's own install/restart/health
// result, and an immediate halt on any bad or missing outcome all stay.
//
// They are written against decideFleet directly, the same way the staged
// tests are, because it is a pure function: a six-hour window is an integer
// here, not a wait.

// The whole point of the mode. Same state that makes the staged ladder sit on
// its canary for six hours advances immediately — but ONLY because the node
// reported "ok" (see the next test for what happens when it has not).
func TestDecideFleetManualFastSkipsCanaryWindowAfterOK(t *testing.T) {
	tr := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	got := decideFleet(tr, nodes, tNow)
	if got.Action != "update" || got.NodeID != "n2" {
		t.Fatalf("decideFleet = %+v, want update n2 (fast mode must not wait out the canary window)", got)
	}

	// Control: the identical state WITHOUT fast mode still waits, so the test
	// above is proving the flag and not something else.
	tr.ManualFast = false
	if got := decideFleet(tr, nodes, tNow); got.Action != "wait" {
		t.Fatalf("staged decideFleet = %+v, want wait", got)
	}
}

// The one thing fast mode may never skip. A node reaching the target version
// means its NEW BINARY STARTED — the updater is still watching it for up to
// healthWindow and can still roll it back. Advancing on version alone would
// command a second machine while the first one's rollback is in flight, which
// is the exact "at most one node at a time, and only after it proved itself"
// property this mode is allowed to keep.
func TestDecideFleetManualFastWaitsForTheNodesOwnResult(t *testing.T) {
	tr := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}
	nodes := []NodeSnapshot{
		// On target, heartbeating, but has not reported an outcome yet.
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "", UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	if got := decideFleet(tr, nodes, tNow); got.Action != "wait" {
		t.Fatalf("decideFleet = %+v, want wait: the node is on target but has not reported success yet", got)
	}
}

// ...and that wait is bounded, or a node whose updater died between installing
// and reporting would pin the whole manual rollout in 发布中 forever with no
// halt and nothing on the panel to act on. fleetInstallLimit is the same
// backstop the staged ladder uses for a wedged install, and it is comfortably
// longer than install + the 10-minute health watch + one poll interval.
func TestDecideFleetManualFastHaltsWhenTheResultNeverArrives(t *testing.T) {
	tr := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - fleetInstallLimit - 1,
	}
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "",
			UpdateStartedAt: tNow - fleetInstallLimit - 1},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	got := decideFleet(tr, nodes, tNow)
	if got.Action != "halt" {
		t.Fatalf("decideFleet = %+v, want halt after fleetInstallLimit with no result", got)
	}
	if !strings.Contains(got.Reason, "n1") {
		t.Errorf("halt reason %q does not name the node it is about", got.Reason)
	}
}

// A node claiming success while still running the old version is a
// contradiction: something on that machine is lying, or central's record of it
// is wrong. Either way the ONE thing that must not happen is treating it as a
// node that proved the build and moving on to the next machine.
func TestDecideFleetManualFastHaltsOnOKWithoutTheTargetVersion(t *testing.T) {
	tr := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
	}
	got := decideFleet(tr, nodes, tNow)
	if got.Action != "halt" {
		t.Fatalf("decideFleet = %+v, want halt on a contradictory result", got)
	}
	if !strings.Contains(got.Reason, "v0.9.0") {
		t.Errorf("halt reason %q does not name the target the node claims to have installed", got.Reason)
	}
}

// A PASS-OVER IS NOT A SUCCESS. The staged ladder treats "skipped" and
// "unreachable" as "this node's turn is over, move on" — that is right there,
// because the queue advances on an observation window and a node that never
// installed simply gets left behind for a human.
//
// In manual fast mode the queue advances on the node's own reported "ok", so
// the same values mean the opposite thing: the current node did NOT install,
// restart and prove itself, and the invariant this mode is allowed to keep is
// that no later node is commanded until one has. Falling through to pick the
// next node would command a second machine off the back of a node that ran no
// part of the build.
func TestDecideFleetManualFastHaltsOnAPassOver(t *testing.T) {
	for _, result := range []string{"skipped", "unreachable"} {
		t.Run(result, func(t *testing.T) {
			tr := RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
			}
			nodes := []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: result, UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			}
			got := decideFleet(tr, nodes, tNow)
			if got.Action != "halt" {
				t.Fatalf("decideFleet = %+v, want halt: %q means the current node never proved the build", got, result)
			}
			if !strings.Contains(got.Reason, "n1") {
				t.Errorf("halt reason %q does not name the node", got.Reason)
			}
			if !strings.Contains(got.Reason, result) {
				t.Errorf("halt reason %q does not name the result it halted on", got.Reason)
			}
		})
	}
}

// ...and the STAGED ladder must be completely unchanged by that: a pass-over
// there still advances the queue, which is what lets a rollout finish with one
// unreachable machine left behind instead of stopping the fleet for it.
func TestDecideFleetStagedStillPassesOver(t *testing.T) {
	for _, result := range []string{"skipped", "unreachable"} {
		t.Run(result, func(t *testing.T) {
			tr := RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
			}
			nodes := []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: result, UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			}
			got := decideFleet(tr, nodes, tNow)
			if got.Action != "update" || got.NodeID != "n2" {
				t.Fatalf("staged decideFleet = %+v, want update n2 (the queue must still move on)", got)
			}
			// The canary slot is re-asserted on whoever runs the build next: the
			// passed-over node observed nothing.
			if !got.IsFirst {
				t.Error("staged pass-over did not re-assert the canary on the next node")
			}
		})
	}
}

// Every halting outcome the staged ladder has, fast mode keeps — and it must
// halt BEFORE any later node is commanded, which is what asserting on the
// whole decision (never Action=="update") checks.
func TestDecideFleetManualFastHaltsOnEveryBadOutcome(t *testing.T) {
	for _, result := range []string{"failed", "rolled_back"} {
		t.Run(result, func(t *testing.T) {
			tr := RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
			}
			nodes := []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: result, UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			}
			if got := decideFleet(tr, nodes, tNow); got.Action != "halt" {
				t.Fatalf("decideFleet = %+v, want halt on %s", got, result)
			}
		})
	}

	// Silence: commanded, then stopped heartbeating. A bricked machine must
	// stop the manual rollout exactly as it stops the staged one.
	t.Run("silent", func(t *testing.T) {
		tr := RolloutTrack{
			Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
			CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - updateSilenceLimit - 60,
		}
		nodes := []NodeSnapshot{
			{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow - updateSilenceLimit - 1,
				UpdateStartedAt: tNow - updateSilenceLimit - 60},
			{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
		}
		if got := decideFleet(tr, nodes, tNow); got.Action != "halt" {
			t.Fatalf("decideFleet = %+v, want halt on a silent node", got)
		}
	})

	// Vanished entirely from the snapshot: still silence, never "gone, move on".
	t.Run("vanished", func(t *testing.T) {
		tr := RolloutTrack{
			Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
			CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - updateSilenceLimit - 1,
		}
		nodes := []NodeSnapshot{{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow}}
		if got := decideFleet(tr, nodes, tNow); got.Action != "halt" {
			t.Fatalf("decideFleet = %+v, want halt on a vanished node", got)
		}
	})
}

// Strict serialisation survives the mode: while a node is installing, nothing
// else is picked, however fast the operator asked to go.
func TestDecideFleetManualFastStillUpdatesOneNodeAtATime(t *testing.T) {
	tr := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
		{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
	}
	if got := decideFleet(tr, nodes, tNow); got.Action != "wait" {
		t.Fatalf("decideFleet = %+v, want wait while n1 is installing", got)
	}
}

// A manual fast rollout still runs the whole ladder to the end, one node at a
// time, and completes rather than stopping after the canary.
func TestDecideFleetManualFastRunsTheWholeFleetInOrder(t *testing.T) {
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 0},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 1},
		{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 2},
	}
	tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		ManualFast: true, StageStartedAt: tNow}

	seen := map[string]bool{}
	for i := 0; i < len(nodes); i++ {
		d := decideFleet(tr, nodes, tNow)
		if d.Action != "update" {
			t.Fatalf("round %d: decideFleet = %+v, want update", i, d)
		}
		if seen[d.NodeID] {
			t.Fatalf("round %d: node %s picked twice", i, d.NodeID)
		}
		seen[d.NodeID] = true
		// Central's claim, then the node installing and reporting success.
		tr.CurrentNodeID = d.NodeID
		if d.IsFirst {
			tr.FirstNodeID = d.NodeID
		}
		tr.StageStartedAt = tNow
		for j := range nodes {
			if nodes[j].ID == d.NodeID {
				nodes[j].Version = "v0.9.0"
				nodes[j].UpdateResult = "ok"
				nodes[j].UpdateStartedAt = tNow
			}
		}
	}
	if d := decideFleet(tr, nodes, tNow); d.Action != "complete" {
		t.Fatalf("after every node: decideFleet = %+v, want complete", d)
	}
}

// The mode changes WAITING, not WHO. The canary is still the least-loaded
// machine, so the first node exposed to the build is still the one with the
// least in flight to lose.
func TestDecideFleetManualFastStillPicksTheLeastLoadedCanary(t *testing.T) {
	tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		ManualFast: true, StageStartedAt: tNow}
	nodes := []NodeSnapshot{
		{ID: "busy-a", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 9},
		{ID: "idle-b", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 0},
	}
	got := decideFleet(tr, nodes, tNow)
	if got.NodeID != "idle-b" || !got.IsFirst {
		t.Fatalf("decideFleet = %+v, want idle-b as the first pick", got)
	}
}

// Fast mode is not emergency mode. A halted or completed track is inert on
// every path, and the flag must not resurrect either.
func TestDecideFleetManualFastIsInertOnANonRollingTrack(t *testing.T) {
	for _, status := range []string{"halted", "complete", ""} {
		tr := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: status, ManualFast: true}
		nodes := []NodeSnapshot{{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow}}
		if got := decideFleet(tr, nodes, tNow); got.Action != "wait" {
			t.Errorf("status %q: decideFleet = %+v, want wait", status, got)
		}
	}
}
