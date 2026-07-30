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

// Critical fix: a passed-over result must be scoped to the rollout that
// produced it, not read as a permanent property of the node. Nothing but
// CommandNodeUpdate ever clears nodes.update_result, and an excluded node is
// -- by construction -- never re-commanded, so it can never clear its own
// flag. Without scoping, a node that reported "unreachable" once for an
// earlier, now-superseded target would sit out EVERY rollout this track ever
// runs again, forever, with no admin action able to fix it short of hand-
// editing the database. Here n1 never moved past v1.0.0 and still carries
// "unreachable" from a v2.0.0 attempt; a brand-new rollout to v3.0.0 must
// treat it as a fresh candidate. See passedOverResult.
func TestDecideFleetDoesNotExcludeAResultFromAnEarlierTarget(t *testing.T) {
	tr := fleetTrackAt("v3.0.0", "rolling", "", "")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 100, UpdateResult: "unreachable"},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action != "update" || got.NodeID != "n1" {
		t.Fatalf("a passed-over result from an earlier target excluded n1 from the new rollout: %+v", got)
	}
}

// Due-diligence companion to the test above: scoping must survive MULTIPLE
// stage transitions within the SAME still-active rollout, not just the
// "nobody picked yet" case. tr.StageStartedAt is rewritten on every fleet
// stage transition (a fleet stage is one node's turn, unlike a BYO batch), so
// a scoping check that compares directly against it would un-exclude n1 the
// moment n2's own turn begins -- reintroducing the ping-pong
// TestDecideFleetDoesNotRecommandAPassedOverNode exists to stop, just one hop
// later. FirstNodeID ("n1", the established canary) anchors this rollout's
// epoch instead, and does not move just because a later, non-canary node
// (n2) also passes over.
func TestDecideFleetScopingSurvivesALaterNodesTurn(t *testing.T) {
	tr := RolloutTrack{Track: "fleet", TargetVersion: "v2.0.0", Status: "rolling",
		CurrentNodeID: "n2", FirstNodeID: "n1", StageStartedAt: 2000}
	nodes := []NodeSnapshot{
		// n1 passed over first, in this same rollout, before n2's turn began.
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 3000, UpdateStartedAt: 1000, UpdateResult: "unreachable"},
		// n2 is current and has ALSO just passed over -- tr.StageStartedAt (2000)
		// now postdates n1's UpdateStartedAt (1000).
		{ID: "n2", Version: "v1.0.0", LastSeenAt: 3000, UpdateStartedAt: 2000, UpdateResult: "unreachable"},
	}
	got := decideFleet(tr, nodes, 3000)
	if got.Action == "update" && got.NodeID == "n1" {
		t.Fatalf("n1 was re-picked after a LATER node's turn began, not an earlier target: %+v", got)
	}
	if got.Action != "complete" {
		t.Fatalf("both nodes have passed over within this rollout; want complete, got %+v", got)
	}
}

// Regression guard for the fix above: "failed" must never join
// passedOverResult's exclusion set. Unlike "skipped"/"unreachable", "failed"
// only ever excludes a node by HALTING the track while that node is current
// (see the branch above); if it also excluded by result, a "failed" left
// over from an earlier, superseded rollout would strand the node exactly
// like the bug this task fixes, and -- because a halt always takes the track
// out of "rolling" first -- there is no reachable state where a NON-current
// node's "failed" belongs to the rollout in flight for it to legitimately
// exclude.
func TestDecideFleetDoesNotExcludeAFailedNode(t *testing.T) {
	tr := fleetTrackAt("v2.0.0", "rolling", "", "")
	nodes := []NodeSnapshot{
		{ID: "n1", Version: "v1.0.0", LastSeenAt: 2000, UpdateStartedAt: 1000, UpdateResult: "failed"},
	}
	got := decideFleet(tr, nodes, 2000)
	if got.Action != "update" || got.NodeID != "n1" {
		t.Fatalf("a non-current node's 'failed' result must not exclude it from candidacy: %+v", got)
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
