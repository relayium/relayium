package account

import (
	"fmt"
	"sort"
	"time"

	"github.com/relayium/relayium/internal/selfupdate"
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
// never on transient online status).
//
// OUTPUT CONTRACT: on "update" the caller MUST persist the newly-opened batch
// percentage into tr.ByoBatch and rewrite tr.StageStartedAt to `now` (that is
// what starts the observation window), then command exactly the returned IDs.
// `eligible` is the subset of the open batch that is online AND not yet on the
// target version, so it SHRINKS as nodes converge: calling decideByo again
// with the same track state is idempotent (already-updated nodes are not
// re-commanded and their nodes.update_started_at is not re-stamped), and a
// node that was offline when its batch opened is picked up on a later call
// instead of being skipped forever. "update" with an EMPTY eligible list is
// meaningful and normal: the batch is open but everyone in it already runs the
// target, so the caller should still advance the stage and command nobody.
//
// Decision order:
//
//  1. Status != "rolling" -> wait. Same rationale as the fleet track: a
//     halted/complete track is inert until an operator restarts it.
//  2. TargetVersion == "" -> wait. SameVersion("", "") is true, so an empty
//     target would otherwise read blank-version nodes as on-target; a
//     rolling track with no target is a caller bug, not a rollout to ship.
//  3. No BYO nodes at all -> complete. There is nothing to roll, and walking
//     the 10/50/100 ladder over an empty population would just report three
//     stages of progress that never touched a machine.
//  4. An unrecognised non-zero ByoBatch -> halt. Anything not in byoBatches
//     (a corrupt row, a legacy value, a hand-edited DB) would otherwise fall
//     back to "open the 10% batch", i.e. silently REGRESS a rollout that had
//     already reached 50% or 100% and potentially loop there.
//  5. Failure check over the nodes this rollout has ACTUALLY COMMANDED --
//     the current batch prefix, ordered[:pctCount(n, tr.ByoBatch)] -- for
//     both numerator and denominator. Because batches nest, a node that
//     failed in an earlier, smaller batch is still inside the current
//     prefix and still counts; only never-commanded nodes are excluded.
//     Dividing by the WHOLE population instead would cap the observable rate
//     at the open percentage (at the 10% stage, even 100% of the canary
//     batch failing reads as 10% < 20%), so the canary batch -- the one
//     stage that exists precisely to catch a bad build -- could never halt.
//     Only results belonging to THIS rollout count (see byoResultIsFailure).
//     If both the rate exceeds byoFailureRate and the absolute count clears
//     byoFailureFloor -> halt with a reason.
//  6. ByoBatch == 0 means no batch has opened for this rollout yet: open the
//     first one IMMEDIATELY, without waiting out a window. The window gates
//     transitions BETWEEN batches; making a fresh track sit through 6h of
//     nothing is not an observation period, it is just a delayed start (and
//     a caller that stamps StageStartedAt when it starts the rollout, as
//     RolloutTrack's doc requires, would hit exactly that).
//  7. If the current batch hasn't been open for byoBatchWindow yet -> wait.
//  8. Otherwise advance: open the next batch in byoBatches after tr.ByoBatch
//     and return its online, not-yet-updated members.
//  9. At the last batch (100%) there is nothing wider left to open, so the
//     rollout ends there -- but only once it has actually LANDED: complete
//     requires that no recently-seen (nodeOnlineWindow) member is still off
//     target. A purely time-based complete would strand every node that was
//     offline when the 100% batch opened, with no stage left to command them
//     and an admin console reporting success. Machines that have been dark
//     for days do not block completion; they are picked up by the next
//     rollout. If stragglers remain online and off-target, they are returned
//     for another sweep (one per byoBatchWindow, since the caller restamps
//     StageStartedAt) rather than being retried in a hot loop.
func decideByo(tr RolloutTrack, nodes []NodeSnapshot, now int64) (action string, eligible []string, reason string) {
	if tr.Status != "rolling" {
		return "wait", nil, ""
	}
	if tr.TargetVersion == "" {
		return "wait", nil, "rolling track has no target version"
	}
	if len(nodes) == 0 {
		return "complete", nil, ""
	}

	// Find the next percentage after tr.ByoBatch. tr.ByoBatch == 0 means no
	// batch has opened yet, so the next one is the first entry in byoBatches.
	// Any other value that is not itself a batch percentage is corrupt state:
	// the fleet track defends against stale persisted fields rather than
	// trusting them, and so does this.
	nextIdx := 0
	if tr.ByoBatch != 0 {
		nextIdx = -1
		for i, pct := range byoBatches {
			if pct == tr.ByoBatch {
				nextIdx = i + 1
				break
			}
		}
		if nextIdx < 0 {
			return "halt", nil, fmt.Sprintf(
				"byo rollout: unrecognised batch percentage %d (expected one of %v)", tr.ByoBatch, byoBatches)
		}
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
	onTarget := func(n NodeSnapshot) bool { return selfupdate.SameVersion(n.Version, tr.TargetVersion) }

	// Failure rate is measured over the nodes this rollout has commanded so
	// far -- the currently open batch prefix -- not the whole population. With
	// tr.ByoBatch == 0 nothing has been commanded yet, so there is nothing to
	// judge and the prefix is empty.
	commanded := ordered[:pctCount(len(ordered), tr.ByoBatch)]
	failed := 0
	for _, n := range commanded {
		if byoResultIsFailure(n, tr.TargetVersion) {
			failed++
		}
	}
	if len(commanded) > 0 && failed >= byoFailureFloor {
		rate := float64(failed) / float64(len(commanded))
		if rate > byoFailureRate {
			return "halt", nil, fmt.Sprintf(
				"byo rollout: %d/%d nodes in the %d%% batch failed or rolled back (%.0f%% > %.0f%% threshold)",
				failed, len(commanded), tr.ByoBatch, rate*100, byoFailureRate*100)
		}
	}

	// A fresh track opens its first batch immediately; every later transition
	// waits out the observation window.
	if tr.ByoBatch != 0 && now-tr.StageStartedAt < byoBatchWindow {
		return "wait", nil, ""
	}

	openPct := 100
	if nextIdx < len(byoBatches) {
		openPct = byoBatches[nextIdx]
	}
	members := ordered[:pctCount(len(ordered), openPct)]

	// Members that still need the update AND can hear us right now. Offline
	// members stay batch members (a later call, or a later batch, commands
	// them); members already on target drop out, which is what makes repeated
	// calls idempotent and convergence observable.
	var ids []string
	for _, node := range members {
		if online(node) && !onTarget(node) {
			ids = append(ids, node.ID)
		}
	}

	// nextIdx past the end: the 100% batch is already open, so there is no
	// wider batch to advance to. The rollout is done only when nobody we can
	// still reach is behind.
	if nextIdx >= len(byoBatches) && len(ids) == 0 {
		return "complete", nil, ""
	}
	return "update", ids, ""
}

// byoResultIsFailure reports whether n's last recorded update result is a
// failure BELONGING TO THIS ROLLOUT.
//
// nodes.update_result is deliberately preserved across re-register and
// heartbeat (UpsertNode's ON CONFLICT excludes the update_* columns, so an
// in-flight rollout's bookkeeping is not clobbered by a node simply calling
// register again) and nothing ever clears it. Left unfiltered, every leftover
// "failed" from the PREVIOUS rollout would be counted against the new one and
// halt it at its very first evaluation -- a rollout that never commanded a
// single node would report a failure rate. The state machine defends itself
// here rather than trusting a caller to reset the column.
//
// update_from_version is the version the node was running when central
// commanded the update, written together with update_started_at, so:
//   - empty -> the node has never been commanded; a result with no command
//     behind it cannot describe an attempt to reach this target.
//   - equal to the target -> the recorded attempt STARTED from the version we
//     are rolling to, so it cannot have been an attempt to reach it.
//   - no longer the node's current version -> the node has moved on since
//     (a later successful update, a manual fix, a reinstall); the row
//     describes a rollout that is over. A failure that belongs to a live
//     rollout leaves the node sitting on the version it was commanded from.
func byoResultIsFailure(n NodeSnapshot, targetVersion string) bool {
	if n.UpdateResult != "failed" && n.UpdateResult != "rolled_back" {
		return false
	}
	if n.UpdateFromVersion == "" || selfupdate.SameVersion(n.UpdateFromVersion, targetVersion) {
		return false
	}
	return selfupdate.SameVersion(n.Version, n.UpdateFromVersion)
}

// pctCount returns how many of total elements make up the first pct percent,
// rounding up so a nonzero percentage of a nonzero total always admits at
// least one member (e.g. 10% of 2 nodes is 1, not 0).
func pctCount(total, pct int) int {
	if total <= 0 || pct <= 0 {
		return 0
	}
	n := (total*pct + 99) / 100
	if n > total {
		n = total
	}
	return n
}
