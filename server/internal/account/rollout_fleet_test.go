package account

import "testing"

const (
	tNow  = int64(1_000_000)
	tHour = int64(3600)
)

func node(id, ver string, seen int64) NodeSnapshot {
	return NodeSnapshot{ID: id, Version: ver, LastSeenAt: seen}
}

func TestDecideFleet(t *testing.T) {
	tests := []struct {
		name  string
		track RolloutTrack
		nodes []NodeSnapshot
		want  RolloutDecision
	}{
		{
			// The first node exposed to a new version should be the one with the
			// least to lose.
			name:  "first pick is the node with fewest active transfers",
			track: RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling"},
			nodes: []NodeSnapshot{
				{ID: "busy", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 9},
				{ID: "idle", Version: "v0.8.0", LastSeenAt: tNow, ActiveTransfers: 0},
			},
			want: RolloutDecision{Action: "update", NodeID: "idle"},
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
				CurrentNodeID: "n1", StageStartedAt: tNow - 2*tHour,
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
				CurrentNodeID: "n1", StageStartedAt: tNow - 7*tHour,
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
			want: RolloutDecision{Action: "update", NodeID: "here"},
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
			if got.Action != tc.want.Action || got.NodeID != tc.want.NodeID {
				t.Errorf("decideFleet = %+v, want %+v", got, tc.want)
			}
			if tc.want.Reason != "" && got.Reason == "" {
				t.Errorf("decideFleet gave no halt reason; want one describing %q", tc.want.Reason)
			}
		})
	}
}
