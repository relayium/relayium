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
			// version, so waiting for it would wedge the track forever.
			name: "advances past a node that reported skipped",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: tNow - 60,
			},
			nodes: []NodeSnapshot{
				{ID: "n1", Version: "v0.8.0", LastSeenAt: tNow, UpdateResult: "skipped", UpdateStartedAt: tNow - 60},
				{ID: "n2", Version: "v0.8.0", LastSeenAt: tNow},
			},
			want: RolloutDecision{Action: "update", NodeID: "n2"},
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
			name: "completes when every fleet node is on target",
			track: RolloutTrack{
				Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
				CurrentNodeID: "n2", StageStartedAt: tNow - tHour,
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
