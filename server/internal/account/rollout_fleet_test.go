package account

import "testing"

const (
	tNow  = int64(1_000_000)
	tHour = int64(3600)
)

func TestDecideFleet(t *testing.T) {
	tests := []struct {
		name  string
		track RolloutTrack
		nodes []NodeSnapshot
		want  RolloutDecision
	}{
		{
			// The first node exposed to a new version should be the one with the
			// least to lose. The IDs are chosen so the hash tie-break ORDERS THEM
			// THE OTHER WAY (fleetHash("busy-a") < fleetHash("idle-b") for this
			// target version): the test therefore only passes if ActiveTransfers
			// genuinely dominates the sort. Verified by deliberately deleting the
			// ActiveTransfers comparison — the test fails.
			name:  "first pick is the node with fewest active transfers",
			track: RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling"},
			nodes: []NodeSnapshot{
				{ID: "busy-a", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 9},
				{ID: "idle-b", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 0},
			},
			want: RolloutDecision{Action: "update", NodeID: "idle-b", IsFirst: true},
		},
		{
			// Strict serial: while one node is mid-update nothing else moves.
			name: "waits while the current node is still updating",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", StageStartedAt: tNow - 60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			// 6h observation for the first node — a version that dies after an
			// hour of real traffic must not reach the rest of the fleet.
			name: "waits out the 6h first-node window even when healthy",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 2*tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 2*tHour},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			name: "advances to the next node after the 6h window",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 7*tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 7*tHour},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "update", NodeID: "n2"},
		},
		{
			// One failure stops the fleet queue dead — 16 nodes are all ours and
			// one breaking is a signal, not noise.
			name: "halts when the current node rolled back",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", StageStartedAt: tNow - tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: "rolled_back", UpdateStartedAt: tNow - tHour},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "halt", Reason: "node n1 rolled back"},
		},
		{
			// A node that went dark after being told to update is the worst case:
			// it may be a brick. Stop and get a human.
			name: "halts when the current node goes silent past the limit",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", StageStartedAt: tNow - 20*60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow - 20*60, UpdateStartedAt: tNow - 20*60},
			},
			want: RolloutDecision{Action: "halt", Reason: "node n1 silent since update started"},
		},
		{
			// A node commanded to update and then MISSING from the snapshot is
			// silent, not gone: any online-filtered listing drops a node the
			// moment it stops heartbeating. Wait it out first...
			name: "waits when the current node has vanished but is within the silence limit",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
			},
			nodes: []NodeSnapshot{
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			// ...then halt. It must NEVER fall through to updating n2: that would
			// hand a second node the build that just took the first one down.
			name: "halts when the vanished current node stays gone past the limit",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 20*60,
			},
			nodes: []NodeSnapshot{
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "halt", Reason: "node n1 vanished since update started"},
		},
		{
			// "skipped" is terminal for that node: it will never report the target
			// version, so waiting for it would wedge the track forever. The canary
			// slot moves with it: n1 never ran the build, so n2 is the first node
			// that actually does and must be reported IsFirst.
			name: "advances past a node that reported skipped",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: "skipped", UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "update", NodeID: "n2", IsFirst: true},
		},
		{
			// FINDING 1: a track that was already rolling when first_node_id
			// shipped reads '' for a node that really is the canary. Guessing
			// "not the canary" would release the second node after 30min. At
			// 40min the canary's 6h window is still open.
			name: "a legacy in-flight track with no recorded canary keeps the 6h window",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "", StageStartedAt: tNow - 40*60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 40*60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			// FINDING 3: commanded, alive, heartbeating, but update_started_at is
			// still 0 — the caller's two writes split. Gating the silence check on
			// UpdateStartedAt alone leaves this waiting forever (probed at 30h).
			name: "halts when a commanded node never started the update",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 30*tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: 0},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "halt", Reason: "node n1 never started the update it was commanded"},
		},
		{
			// ...but only past the silence limit: a node commanded seconds ago has
			// not had time to report update_started_at yet.
			name: "waits when a commanded node has not started yet but is within the silence limit",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: 0},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			// MINOR 4: FirstNodeID left over from the PREVIOUS rollout. Nothing is
			// in flight and n1 is not on the new target, so no node has been picked
			// for this target yet: the canary must still be chosen by fewest active
			// transfers and reported IsFirst, not picked by hash with a 30min
			// window. busy-a/idle-b hash the other way round (see the first case).
			name: "a FirstNodeID left over from a previous rollout is ignored",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "", FirstNodeID: "busy-a", StageStartedAt: tNow - 40*tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "busy-a", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 99},
				{ID: "idle-b", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 0},
			},
			want: RolloutDecision{Action: "update", NodeID: "idle-b", IsFirst: true},
		},
		{
			// MINOR 6: SameVersion("","") is true, so an empty target would read
			// blank-version nodes as on-target and command everyone else to install
			// "". Never update on a target-less track.
			name:  "a rolling track with no target version waits",
			track: RolloutTrack{Track: "fleet", TargetVersion: "", Status: "rolling"},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow},
				{ID: "n2", Version: "", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait", Reason: "rolling track has no target version"},
		},
		{
			// Canary status is positional. A peer that is already on the target
			// version (freshly provisioned, hand-updated, resumed rollout) must
			// not shrink the canary's 6h window to 30min.
			name: "canary keeps its 6h window even when a peer is already on target",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 40*60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 40*60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
				{ID: "n3", Version: "v0.9.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			name: "a node that is not the canary uses the short 30min window",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n2", FirstNodeID: "n1", StageStartedAt: tNow - 10*60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok"},
				{ID: "n2", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 10*60},
				{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			name: "a non-canary node is released after 30min, not 6h",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n2", FirstNodeID: "n1", StageStartedAt: tNow - 40*60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok"},
				{ID: "n2", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 40*60},
				{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "update", NodeID: "n3"},
		},
		{
			// The track row still carries the PREVIOUS stage's start (2h ago)
			// while this node was only commanded 60s ago. The window must be
			// measured from the later of the two, or the canary gets 60 seconds
			// of "observation".
			name: "a stale track StageStartedAt cannot shorten the window",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 2*tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			// Same failure mode with an unset track value: now-0 is older than
			// every window.
			name: "a zero track StageStartedAt cannot shorten the window",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: 0,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			// n1 was the canary and cleared its window; n2 is the last node and
			// only needs the 30min step window. (FirstNodeID must be set: an
			// in-flight node with NO recorded canary is assumed to BE the canary
			// and would still be inside its 6h window an hour in.)
			name: "completes when every fleet node is on target",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n2", FirstNodeID: "n1", StageStartedAt: tNow - tHour,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok"},
				{ID: "n2", Version: "v0.9.0", LastSeenAt: tNow, UpdateResult: "ok", UpdateStartedAt: tNow - tHour},
			},
			want: RolloutDecision{Action: "complete"},
		},
		{
			// An offline node must not stall the queue forever; skip and move on.
			name: "skips a node that is offline when its turn comes",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "", StageStartedAt: 0,
			},
			nodes: []NodeSnapshot{
				{ID: "gone", Version: "v0.8.0", LastSeenAt: tNow - 10*tHour},
				{ID: "here", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "update", NodeID: "here", IsFirst: true},
		},
		{
			// F4: commanded, heartbeating, update_started_at set -- and still not
			// on target an hour later. The node is not SILENT, so the brick check
			// can never fire; update_started_at is set, so the never-started check
			// can never fire; and the 15-minute give-up in updateCheckFleet's
			// resume branch only runs when this very node polls, which a node
			// whose updater has stopped running (timer disabled, unit masked)
			// never does again. Without the backstop the fleet track waits
			// forever on it, showing 发布中 with nothing to show an operator.
			name: "halts a node that keeps heartbeating but never converges",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 30*tHour,
			},
			nodes: []NodeSnapshot{
				// Heartbeating right now, so never silent; commanded 30h ago.
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: tNow - 30*tHour},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "halt", Reason: "node n1 was commanded to update over ... ago"},
		},
		{
			// ...and not one second before the limit: a slow download plus the
			// 60s drain, a restart and the updater's 10-minute health watch are a
			// legitimate install, not a wedge.
			name: "waits on a slow but still plausible install",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - fleetInstallLimit,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateStartedAt: tNow - fleetInstallLimit},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "wait"},
		},
		{
			name:  "does nothing when halted",
			track: RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "halted"},
			nodes: []NodeSnapshot{{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow}},
			want:  RolloutDecision{Action: "wait"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decideFleet(tc.track, tc.nodes, tNow)
			if got.Action != tc.want.Action || got.NodeID != tc.want.NodeID || got.IsFirst != tc.want.IsFirst {
				t.Errorf("decideFleet = %+v, want %+v", got, tc.want)
			}
			if tc.want.Reason != "" && got.Reason == "" {
				t.Errorf("decideFleet gave no halt reason; want one describing %q", tc.want.Reason)
			}
		})
	}
}

// FINDING 2, end to end: FirstNodeID is written when a node is PICKED, not when
// it INSTALLS. A canary that answers "skipped" never runs the build, so if it
// kept the canary slot the first node that ACTUALLY runs the new build would be
// released after 30 minutes with nobody having observed it for 6 hours — a bad
// release reaching a second live node with zero real observation. The slot must
// follow the build.
func TestSkippedCanaryHandsTheSixHourWindowToTheNextNode(t *testing.T) {
	const target = "v0.9.0"
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: "skipped", UpdateStartedAt: tNow - 60},
		{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
		{ID: "n3", Version: "v0.8.0", LastSeenAt: tNow},
	}
	// Step 1: the recorded canary skipped. The queue advances, and the pick is
	// flagged IsFirst so the caller re-points FirstNodeID at it.
	tr := RolloutTrack{
		Track: "fleet", TargetVersion: target, Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
	}
	got := decideFleet(tr, nodes, tNow)
	if got.Action != "update" || got.NodeID == "n1" {
		t.Fatalf("after a skipped canary: got %+v, want an update of some node other than n1", got)
	}
	if !got.IsFirst {
		t.Fatalf("after a skipped canary, the next node got IsFirst=false: the 6h canary slot is stuck on a node that never ran the build")
	}
	next := got.NodeID

	// Step 2: the caller persists that. 40 minutes later the new canary is
	// healthy and on target — past the 30min step window, well inside 6h. It
	// must still be under observation.
	later := tNow + 40*60
	tr = RolloutTrack{
		Track: "fleet", TargetVersion: target, Status: "rolling",
		CurrentNodeID: next, FirstNodeID: next, StageStartedAt: tNow,
	}
	for i := range nodes {
		if nodes[i].ID == next {
			nodes[i].Version = target
			nodes[i].UpdateResult = "ok"
			nodes[i].UpdateStartedAt = tNow
		}
		nodes[i].LastSeenAt = later
	}
	if got := decideFleet(tr, nodes, later); got.Action != "wait" {
		t.Fatalf("40min into the re-asserted canary's window: got %+v, want wait (6h observation)", got)
	}
}
