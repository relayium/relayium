package account

import (
	"fmt"
	"sort"
	"time"

	"github.com/relayium/relayium/selfupdate"
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
//
// Corollary: a population at or below the floor can never halt, so a tiny BYO
// population (in the limit, a single node) whose one commanded member fails
// gets re-commanded on every call forever -- decideByo never returns complete
// or halt for it. That is the deliberate price of the floor, not a bug; it
// just means an admin console can show a tiny BYO population stuck at
// "rolling" indefinitely, and that is expected.
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
// Commanding a node carries three further hard requirements, each load-bearing:
//
//   - the caller MUST write nodes.update_from_version (to the node's current
//     version) at command time. Without it byoResultIsFailure has nothing to
//     compare against and stays permanently inert, and the failure-rate
//     denominator -- built from that same predicate -- is always empty: the
//     BYO track can never halt at all, no matter how bad the build is.
//   - the caller MUST clear nodes.update_result when it commands a node.
//     nodes.update_result deliberately survives re-register and heartbeat (see
//     byoResultIsFailure), so a stale "failed"/"rolled_back" left over from
//     that node's previous command would otherwise be misread as a failure of
//     the command being issued right now.
//   - when an operator restarts a HALTED rollout targeting the SAME version,
//     the caller MUST reset tr.ByoBatch to 0 AND restamp tr.StageStartedAt.
//     The failing records that caused the halt are still sitting on those
//     nodes, and the restamp is what puts them behind the current stage so
//     they stop counting (see byoCommandedByThisStage); resuming without it
//     re-evaluates the same batch against the same failures and halts again
//     with a byte-identical reason, forever. ResumeRolloutTrack does both in
//     one statement, and SetTargetVersion's whole-row replace does too.
//
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
//  5. Failure check over the nodes this rollout has ACTUALLY COMMANDED, for
//     both numerator and denominator. This is NOT the current batch prefix,
//     ordered[:pctCount(n, tr.ByoBatch)] -- that prefix is a ceiling on who
//     COULD have been commanded, not who was: members offline when the batch
//     opened are filtered out of `eligible` below and so never get
//     nodes.update_from_version stamped. The denominator is the prefix
//     narrowed to byoCommandedByThisStage(n, tr), the same
//     predicate byoResultIsFailure's numerator uses, so a canary batch where
//     only a handful of members were ever reachable is judged on those few,
//     not diluted by the ones that were never touched (a 20-node batch with
//     only 4 reachable and all 4 failing is 4/20 = 20%, unable to halt, vs.
//     the true 4/4 = 100%). Because batches nest, a node that failed in an
//     earlier, smaller batch is still inside the current prefix -- and since
//     it is also still off target, the wider batch re-commands it, which is
//     what brings its (fresh) failure back into this stage's count rather than
//     carrying the old row forward. Dividing by the WHOLE population instead of the batch prefix
//     would separately cap the observable rate at the open percentage (at
//     the 10% stage, even 100% of the canary batch failing reads as
//     10% < 20%), so the canary batch -- the one stage that exists precisely
//     to catch a bad build -- could never halt. Only records issued by the
//     CURRENT stage count, on both sides of the fraction (see
//     byoCommandedByThisStage). If both the rate exceeds
//     byoFailureRate and the absolute count clears byoFailureFloor -> halt
//     with a reason.
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
//     requires that no member seen within nodeOnlineWindow (90s) is still off
//     target. A purely time-based complete would strand every node that was
//     offline when the 100% batch opened, with no stage left to command them
//     and an admin console reporting success. This window is 90 SECONDS, not
//     days: a node need only fall silent for that long to stop blocking
//     completion. That includes a node that failed, is off-target, and then
//     goes quiet -- plausibly bricked by this very update -- which is counted
//     as "not blocking" the moment it crosses the window; if its failure
//     count is below byoFailureFloor, the rollout can report complete over a
//     broken machine. If stragglers remain online and off-target, they are
//     returned for another sweep (one per byoBatchWindow, since the caller
//     restamps StageStartedAt) rather than being retried in a hot loop.
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

	ordered := byoOrder(nodes, tr.TargetVersion)

	onlineCutoff := now - int64(nodeOnlineWindow/time.Second)
	online := func(n NodeSnapshot) bool { return n.LastSeenAt >= onlineCutoff }
	onTarget := func(n NodeSnapshot) bool { return selfupdate.SameVersion(n.Version, tr.TargetVersion) }

	// Failure rate is measured over the nodes this rollout has ACTUALLY
	// COMMANDED, not the whole batch prefix. The batch prefix is a ceiling on
	// who could have been commanded, not a record of who was: a member that
	// was offline when its batch opened is filtered out of `eligible` below
	// and so never gets nodes.update_from_version stamped. Counting it here
	// anyway dilutes the rate -- e.g. a 20-node canary batch where only 4
	// members were ever reachable and all 4 failed is 4/20 = 20%, at the
	// threshold and unable to halt, when the nodes actually exercised failed
	// 100% of the time. byoCommandedByThisStage is the same predicate
	// byoResultIsFailure uses to decide a result belongs to THIS rollout, so
	// numerator and denominator agree on both what "commanded" means and on
	// WHEN it was commanded -- without that second half, command records left
	// on nodes by a rollout that is long over are counted against this one and
	// two permanently-dead machines can wedge the track forever. With
	// tr.ByoBatch == 0 the prefix is empty and there is nothing to judge.
	batchPrefix := ordered[:pctCount(len(ordered), tr.ByoBatch)]
	var commanded []NodeSnapshot
	for _, n := range batchPrefix {
		if byoCommandedByThisStage(n, tr) {
			commanded = append(commanded, n)
		}
	}
	failed := 0
	for _, n := range commanded {
		if byoResultIsFailure(n, tr) {
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

// byoOrder returns nodes in the stable rollout order the batch percentages are
// taken as a prefix of. Ordering is fixed by (nodeID, targetVersion) alone --
// NOT filtered to online nodes -- so the prefix taken for a given percentage
// never shifts between calls just because who's online changed. That is what
// guarantees the 10% batch stays a subset of the 50% batch, which stays a
// subset of 100%.
func byoOrder(nodes []NodeSnapshot, targetVersion string) []NodeSnapshot {
	ordered := append([]NodeSnapshot(nil), nodes...)
	sort.Slice(ordered, func(i, j int) bool {
		hi, hj := fleetHash(ordered[i].ID, targetVersion), fleetHash(ordered[j].ID, targetVersion)
		if hi != hj {
			return hi < hj
		}
		// sort.Slice is NOT stable, so on a fleetHash collision the two
		// candidates could come out in either order on different calls over
		// the identical input -- exactly the nondeterminism the 10%/50%/100%
		// nesting cannot tolerate. Break the tie on node ID, which is fixed.
		return ordered[i].ID < ordered[j].ID
	})
	return ordered
}

// byoOpenBatchMembers reports which nodes are inside the batch tr currently has
// OPEN -- the first tr.ByoBatch percent of byoOrder. It computes nothing
// decideByo does not already compute internally (same ordering, same prefix);
// it only EXPOSES that membership so a caller can answer "is this node allowed
// to move right now" without re-deriving it, and without changing any decision.
//
// This exists because the alternative the endpoint used to rely on --
// "nodes.update_from_version says it was commanded at some point" -- has no
// notion of WHICH rollout. Starting a new rollout resets the track's ByoBatch
// but never clears the per-node update_* columns, so on rollout N+1 every node
// still carrying rollout N's command record would be told it may update on its
// very first poll, batch ladder and all, i.e. 100% of BYO machines in one poll
// cycle. Membership of the currently-open batch is the only honest test.
// tr.ByoBatch == 0 means no batch is open yet and the set is empty.
func byoOpenBatchMembers(tr RolloutTrack, nodes []NodeSnapshot) map[string]bool {
	ordered := byoOrder(nodes, tr.TargetVersion)
	members := make(map[string]bool)
	for _, n := range ordered[:pctCount(len(ordered), tr.ByoBatch)] {
		members[n.ID] = true
	}
	return members
}

// byoResultIsFailure reports whether n's last recorded update result is a
// failure BELONGING TO THE STAGE THIS TRACK IS CURRENTLY IN.
//
// nodes.update_result is deliberately preserved across re-register and
// heartbeat (UpsertNode's ON CONFLICT excludes the update_* columns, so an
// in-flight rollout's bookkeeping is not clobbered by a node simply calling
// register again) and nothing ever clears it except CommandNodeUpdate. Left
// unfiltered, every leftover "failed" from the PREVIOUS rollout would be
// counted against the new one and halt it at its very first evaluation -- a
// rollout that never commanded a single node would report a failure rate. The
// state machine defends itself here rather than trusting a caller to reset the
// column.
//
// The scoping is byoCommandedByThisStage; see there for why the wall-clock
// term is the load-bearing half of it and the version terms alone are not.
//
// On top of that scoping, the node must still be sitting on the version it was
// commanded FROM. A node that has moved on since (a later successful update, a
// manual fix, a reinstall) is no longer describing a live failure, however
// recent the row is; a failure that really is live leaves the node exactly
// where the update found it.
func byoResultIsFailure(n NodeSnapshot, tr RolloutTrack) bool {
	if n.UpdateResult != "failed" && n.UpdateResult != "rolled_back" {
		return false
	}
	if !byoCommandedByThisStage(n, tr) {
		return false
	}
	return selfupdate.SameVersion(n.Version, n.UpdateFromVersion)
}

// byoCommandedByThisStage reports whether n carries a command record that THIS
// track's CURRENT STAGE issued: it was commanded for this target
// (byoWasCommandedForTarget) AND the command was issued at or after
// tr.StageStartedAt. It is decideByo's failure-rate DENOMINATOR, and via
// byoResultIsFailure its numerator too, so the two can never disagree about
// which nodes this rollout is being judged on.
//
// The wall-clock term is the load-bearing half, and leaving it out was a real
// bug rather than a theoretical one. byoWasCommandedForTarget alone excludes a
// stale record only by its VERSIONS, and a genuinely FAILED update leaves the
// node sitting on exactly the version it was commanded from with
// update_from_version still pointing at it -- so it satisfied every version
// term forever. Two BYO machines that failed a v1->v2 update and then died
// (offline, so never re-commanded, so nothing ever rewrites their update_*
// columns) therefore counted as 2 failures out of a denominator of 2 against
// the NEXT rollout, halting it on its first evaluation. Neither restarting the
// halted rollout nor picking a brand-new target escaped that: both reset
// ByoBatch and re-walk the ladder into the same two dead rows. A track that
// can be wedged permanently by two dead machines is the opposite of the
// fix-forward behaviour the design promises.
//
// StageStartedAt is the right clock, and its being restamped on every batch
// advance (AdvanceByoBatch) does NOT lose earlier-batch failures the way it
// might appear to. A node that failed in the 10% batch is still off target, so
// when the 50% batch opens it is inside the wider prefix, online, not on
// target -- i.e. back in `eligible`, re-commanded with a fresh
// update_started_at and a cleared update_result. Its failure is retried and
// re-counted, not forgotten. The only member that drops out is one that has
// gone offline, which decideByo already declines to hold a rollout on
// anywhere else (see the completion rule). Every other path that (re)starts a
// rollout stamps this field too: SetTargetVersion writes it with the row and
// ResumeRolloutTrack resets it, which is exactly what makes 继续 escape a halt
// instead of replaying it.
//
// A track whose StageStartedAt is 0 (a legacy row written before anything
// stamped it) admits every command record, i.e. the pre-fix behaviour. That is
// the fail-safe direction: it can only make the failure check MORE willing to
// halt, never less.
func byoCommandedByThisStage(n NodeSnapshot, tr RolloutTrack) bool {
	return byoWasCommandedForTarget(n, tr.TargetVersion) && n.UpdateStartedAt >= tr.StageStartedAt
}

// byoWasCommandedForTarget reports whether n carries a command record for a
// rollout to targetVersion: nodes.update_from_version is non-empty and is not
// itself the target (a record whose from-version already equals the target
// started AFTER reaching it, so it cannot describe an attempt to get there).
//
// This is a VERSION test only: it says nothing about WHICH rollout issued the
// record, because a failed update leaves those versions unchanged forever. Any
// caller deciding whether a node's row belongs to the rollout in flight wants
// byoCommandedByThisStage (or emergencyRefusesNode), which adds the wall-clock
// term. The exception is the "carry on with the batch you were given" check in
// updateCheckByo, which is already scoped by open-batch membership.
//
// See the OUTPUT CONTRACT above: without the caller stamping
// update_from_version at command time, this predicate is never true and the
// whole failure check is inert.
func byoWasCommandedForTarget(n NodeSnapshot, targetVersion string) bool {
	return n.UpdateFromVersion != "" && !selfupdate.SameVersion(n.UpdateFromVersion, targetVersion)
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
