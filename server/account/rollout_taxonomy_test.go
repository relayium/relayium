package account

import (
	"strings"
	"testing"
)

func fleetTrackAt(target, status, current, first string) RolloutTrack {
	return RolloutTrack{Track: "fleet", TargetVersion: target, Status: status,
		CurrentNodeID: current, FirstNodeID: first, StageStartedAt: 1000}
}

// The change: a node that could not fetch does not stop the fleet, and the
// queue moves ON. Asserting only "not halt" would pass against the old code,
// which returned "wait" while the node sat inside its canary window -- the
// distinction this task exists to create is wait-versus-advance, so the
// assertion has to be the positive one.
func TestDecideFleetAdvancesPastUnreachable(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "n1", "n1")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "unreachable"},
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 2000},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action != "update" {
		t.Fatalf("want the queue to move on to the next node, got %+v", got)
	}
	if got.NodeID != "n2" {
		t.Fatalf("want n2 commanded next, got %+v", got)
	}
}

// The exclusion is by RESULT, not by "is the current node". With a single
// skipped-id the queue re-commands a passed-over node as soon as some other
// node takes the slot, which is an endless loop rather than a rollout: n1
// passes over, n2 is picked, n2 passes over, n1 is no longer excluded, n1 is
// picked again. Here n1 already passed over and is NOT current.
func TestDecideFleetDoesNotRecommandAPassedOverNode(t *testing.T) {
	for _, result := range []string{"unreachable", "skipped"} {
		t.Run(result, func(t *testing.T) {
			tr := fleetTrackAt("v2.0.0", "rolling", "", "")
			nodes := []NodeSnapshot{
				{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: result},
				{ID: "n2", Version: "v2.0.0", LastSeenAt: 2000, UpdateResult: "ok"},
			}
			got := decideFleet(tr, nodes, 2000)
			if got.Action == "update" && got.NodeID == "n1" {
				t.Fatalf("re-commanded a node that already passed over: %+v", got)
			}
			if got.Action != "complete" {
				t.Fatalf("everyone left is on target or passed over; want complete, got %+v", got)
			}
		})
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
	if got.Action != "complete" {
		t.Fatalf("a fleet-wide fetch failure must finish the queue, got %+v", got)
	}
	// And it finished having updated nobody, which is what Task 4 renders.
	for _, n := range nodes {
		if n.Version == tr.TargetVersion {
			t.Fatal("test setup wrong: no node should be on target here")
		}
	}
}
