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
