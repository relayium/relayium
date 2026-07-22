package account

import (
	"fmt"
	"sort"
	"time"
)

// BYO rollout tuning. Unlike the fleet track (strictly serial, one node at a
// time -- see rollout_fleet.go) BYO nodes are unbounded and out of our
// control: there is no bound on how many exist, and 200 machines at 30min
// each would take days. They roll in proportional batches instead.
//
// byoBatches lists the CUMULATIVE percentage open at each stage. Batch
// membership is computed by taking the first N% of a stable hash ordering
// (see fleetHash, reused from the fleet track), so the 10% batch is always a
// strict subset of the 50% batch, which is a subset of 100%: no node is ever
// told to update twice, and the failure-rate denominator stays meaningful.
//
// byoBatchWindow is how long a batch is observed before the next, wider one
// opens.
//
// byoFailureRate and byoFailureFloor gate the halt decision, and BOTH must
// hold: the failure RATE must exceed the threshold AND the absolute COUNT
// must clear the floor. One flaky user machine is normal, not a signal --
// halting on a single failure (e.g. 1 of 2 nodes, a 50% "rate") would wedge
// the BYO track permanently.
var byoBatches = []int{10, 50, 100}

const (
	byoBatchWindow  = 6 * 3600
	byoFailureRate  = 0.20
	byoFailureFloor = 2
)

// decideByo is the byo-track rollout state machine: a pure function of
// (track, node snapshots, now), mirroring decideFleet's contract -- no
// clock, no RNG, so a 6h batch window is just an integer in tests.
//
// Unlike decideFleet, which names one node, decideByo returns a SET of node
// IDs that may update now: BYO rolls proportional batches, not one machine
// at a time.
//
// INPUT CONTRACT: `nodes` should be every BYO node this track governs,
// including offline ones -- the percentage ordering is computed over the
// whole population so batch membership does not shift under the batch
// boundaries as nodes flap online/offline between calls (a node's inclusion
// in the 10%/50%/100% prefix depends only on its ID and the target version,
// never on transient online status). Online status only gates the returned
// `eligible` list: a currently offline node stays a batch member (it will be
// commanded next time it is seen) but is not reported as actionable right
// now.
//
// Decision order:
//
//  1. Status != "rolling" -> wait. Same rationale as the fleet track: a
//     halted/complete track is inert until an operator restarts it.
//  2. TargetVersion == "" -> wait. SameVersion("", "") is true, so an empty
//     target would otherwise read blank-version nodes as on-target; a
//     rolling track with no target is a caller bug, not a rollout to ship.
//  3. Failure check, across the WHOLE node population (not just the
//     currently open batch: batches only grow, so a node that failed in an
//     earlier, smaller batch is still a failure when a later batch's window
//     is being evaluated). If both the rate exceeds byoFailureRate and the
//     absolute count clears byoFailureFloor -> halt with a reason.
//  4. If the current batch hasn't been open for byoBatchWindow yet -> wait.
//     tr.ByoBatch == 0 means no batch has opened for this rollout yet, and
//     is gated by the same window (via tr.StageStartedAt) so a fresh track
//     cannot skip straight to 100%.
//  5. Otherwise advance: open the next batch in byoBatches after
//     tr.ByoBatch (or the first one, if none has opened yet). If tr.ByoBatch
//     is already the last (100%), there is nothing left to open -> complete.
//     Return "update" with the newly-opened batch's currently-online member
//     IDs.
func decideByo(tr RolloutTrack, nodes []NodeSnapshot, now int64) (action string, eligible []string, reason string) {
	if tr.Status != "rolling" {
		return "wait", nil, ""
	}
	if tr.TargetVersion == "" {
		return "wait", nil, "rolling track has no target version"
	}

	// Ordering is fixed by (nodeID, targetVersion) alone -- NOT filtered to
	// online nodes here -- so the prefix taken for a given percentage never
	// shifts between calls just because who's online changed. That is what
	// guarantees the 10% batch stays a subset of the 50% batch.
	ordered := append([]NodeSnapshot(nil), nodes...)
	sort.Slice(ordered, func(i, j int) bool {
		return fleetHash(ordered[i].ID, tr.TargetVersion) < fleetHash(ordered[j].ID, tr.TargetVersion)
	})

	onlineCutoff := now - int64(nodeOnlineWindow/time.Second)
	online := func(n NodeSnapshot) bool { return n.LastSeenAt >= onlineCutoff }

	// Failure rate is measured over every node this track governs, not just
	// the batch currently open: a batch's membership only ever grows, so a
	// failure recorded during an earlier, smaller batch must still count
	// against a later, wider one's threshold check.
	failed := 0
	for _, n := range nodes {
		if n.UpdateResult == "failed" || n.UpdateResult == "rolled_back" {
			failed++
		}
	}
	if len(nodes) > 0 && failed >= byoFailureFloor {
		rate := float64(failed) / float64(len(nodes))
		if rate > byoFailureRate {
			return "halt", nil, fmt.Sprintf(
				"byo rollout: %d/%d nodes failed or rolled back (%.0f%% > %.0f%% threshold)",
				failed, len(nodes), rate*100, byoFailureRate*100)
		}
	}

	if now-tr.StageStartedAt < byoBatchWindow {
		return "wait", nil, ""
	}

	// Find the next percentage after tr.ByoBatch. tr.ByoBatch == 0 (no batch
	// opened yet) falls through with nextIdx left at 0, i.e. the first entry
	// in byoBatches.
	nextIdx := 0
	for i, pct := range byoBatches {
		if pct == tr.ByoBatch {
			nextIdx = i + 1
			break
		}
	}
	if nextIdx >= len(byoBatches) {
		return "complete", nil, ""
	}

	n := pctCount(len(ordered), byoBatches[nextIdx])
	var ids []string
	for _, node := range ordered[:n] {
		if online(node) {
			ids = append(ids, node.ID)
		}
	}
	return "update", ids, ""
}

// pctCount returns how many of total elements make up the first pct percent,
// rounding up so a nonzero percentage of a nonzero total always admits at
// least one member (e.g. 10% of 2 nodes is 1, not 0).
func pctCount(total, pct int) int {
	if total == 0 {
		return 0
	}
	n := (total*pct + 99) / 100
	if n > total {
		n = total
	}
	return n
}
