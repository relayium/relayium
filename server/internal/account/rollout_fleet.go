package account

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sort"
	"time"

	"github.com/relayium/relayium/internal/selfupdate"
)

// Fleet rollout timing constants, all in seconds. fleetFirstWindow is the
// observation period for the very first (canary) node in a rollout -- long
// enough that a release which only breaks under several hours of real
// traffic gets caught before it reaches a second node. fleetStepWindow is
// the shorter window used for every node after the canary has already
// proven the release safe. updateSilenceLimit is how long a node commanded
// to update may go without a heartbeat before it is treated as bricked.
const (
	fleetFirstWindow   = 6 * 3600
	fleetStepWindow    = 30 * 60
	updateSilenceLimit = 15 * 60
)

// NodeSnapshot is what the state machine needs to know about one node.
type NodeSnapshot struct {
	ID              string
	Version         string
	LastSeenAt      int64
	ActiveTransfers int
	UpdateStartedAt int64
	UpdateResult    string // "" | "ok" | "failed" | "rolled_back" | "skipped"
}

// RolloutDecision is what decideFleet says to do next.
type RolloutDecision struct {
	Action string // "wait" | "update" | "halt" | "complete"
	NodeID string // set when Action == "update"
	Reason string // set when Action == "halt"
	// IsFirst is true when Action == "update" and NodeID is the FIRST node of
	// this rollout, i.e. the canary that gets the long observation window. The
	// caller MUST persist it as RolloutTrack.FirstNodeID; canary status is
	// positional and cannot be re-derived from fleet version state later (see
	// RolloutTrack.FirstNodeID).
	IsFirst bool
}

// decideFleet is the fleet-track rollout state machine: a pure function of
// (track, node snapshots, now) so the caller can persist RolloutTrack and
// command nodes without this function ever touching a clock or a database.
// A 6h observation window is therefore just an integer in tests, not a wait.
//
// INPUT CONTRACT: `nodes` must be EVERY fleet node, INCLUDING ones that are
// currently offline. decideFleet does its own online filtering (against
// nodeOnlineWindow) and relies on seeing offline nodes to notice that the node
// it is presently updating has gone dark. Passing a pre-filtered
// online-only listing (e.g. SQLiteStore.OnlineNodes) would make a bricked node
// simply disappear from the snapshot, which is exactly the case this function
// must halt on. `tr.StageStartedAt` must be rewritten on EVERY stage
// transition; a value left over from the previous stage otherwise shortens the
// next node's observation window (defended against below, but only partly).
//
// Decision order (THIS ORDER IS THE SPEC -- do not reorder without re-reading
// why; e.g. checking "everyone is on target" before "the current node
// failed" would let a halt condition be silently missed):
//
//  1. Status != "rolling" -> wait. Halted/complete tracks are inert; a fresh
//     rollout is started by an operator flipping Status back to "rolling".
//  2. If a node is currently being updated (CurrentNodeID set):
//     a. it is missing from the snapshot entirely -> it is SILENT, not gone:
//     wait until updateSilenceLimit, then halt. Never fall through to
//     picking another node -- see below.
//     b. its last reported UpdateResult is "failed" or "rolled_back" -> halt
//     c. its last reported UpdateResult is "skipped" -> its turn is over and
//     it will never reach the target: fall through to step 3/4 so the
//     queue advances, leaving the node behind for a human.
//     d. it has gone silent (no heartbeat) for longer than updateSilenceLimit
//     since it was commanded to update -> halt (possible brick)
//     e. it hasn't reached the target version yet -> wait
//     f. it has reached the target version but hasn't cleared its
//     observation window yet (fleetFirstWindow for the canary,
//     fleetStepWindow for every node after) -> wait
//  3. Every fleet node currently online is already on the target version ->
//     complete.
//  4. Otherwise pick the next node to update: the very first node of the
//     rollout (no CurrentNodeID and no FirstNodeID yet) is chosen by fewest
//     ActiveTransfers -- least to lose if the new build is bad -- and
//     reported with IsFirst so the caller can persist it as FirstNodeID.
//     Every node after that is chosen by sha256(nodeID+targetVersion)
//     ascending, so the order is deterministic and reproducible but
//     reshuffles per release (the same node must not always end up the
//     canary). Offline nodes are skipped either way -> update.
func decideFleet(tr RolloutTrack, nodes []NodeSnapshot, now int64) RolloutDecision {
	if tr.Status != "rolling" {
		return RolloutDecision{Action: "wait"}
	}

	byID := make(map[string]NodeSnapshot, len(nodes))
	for _, n := range nodes {
		byID[n.ID] = n
	}

	onlineCutoff := now - int64(nodeOnlineWindow/time.Second)
	online := func(n NodeSnapshot) bool { return n.LastSeenAt >= onlineCutoff }
	onTarget := func(n NodeSnapshot) bool { return selfupdate.SameVersion(n.Version, tr.TargetVersion) }

	// firstPick is true only before this rollout has committed to a canary at
	// all: no node in flight AND none recorded. Canary status is positional
	// (FirstNodeID), never inferred from who happens to be on the target
	// version -- see RolloutTrack.FirstNodeID for why inference is unsafe.
	firstPick := tr.CurrentNodeID == "" && tr.FirstNodeID == ""

	// skipped is the current node's ID when it reported "skipped": it stays
	// behind the target version forever, so it must be kept out of the
	// candidate set below or the queue would just re-pick it in a loop.
	var skipped string

	if tr.CurrentNodeID != "" {
		cur, present := byID[tr.CurrentNodeID]
		if !present {
			// The node we are updating is missing from the snapshot. That is
			// SILENCE, not absence: a node that dies mid-update stops
			// heartbeating and drops out of any listing filtered on
			// last_seen_at. Treating it as "gone, move on" would command a
			// SECOND node to install the very build that just took one down,
			// so this must never reach the pick-next step below.
			if now-tr.StageStartedAt <= updateSilenceLimit {
				return RolloutDecision{Action: "wait"}
			}
			return RolloutDecision{Action: "halt",
				Reason: fmt.Sprintf("node %s vanished since update started", tr.CurrentNodeID)}
		}
		if cur.UpdateResult == "failed" || cur.UpdateResult == "rolled_back" {
			verb := "failed to update"
			if cur.UpdateResult == "rolled_back" {
				verb = "rolled back"
			}
			return RolloutDecision{Action: "halt", Reason: fmt.Sprintf("node %s %s", cur.ID, verb)}
		}
		// "skipped" means the node declined this update (already on a newer
		// build, pinned, whatever) and will NEVER reach the target version. It
		// is not a failure, so we must not halt -- but waiting for a version
		// it will never report would wedge the whole track forever. Its stage
		// is over: fall through so the queue advances without it.
		if cur.UpdateResult == "skipped" {
			skipped = cur.ID
		} else {
			if cur.UpdateStartedAt != 0 && now-cur.LastSeenAt > updateSilenceLimit {
				return RolloutDecision{Action: "halt", Reason: fmt.Sprintf("node %s silent since update started", cur.ID)}
			}
			if !onTarget(cur) {
				return RolloutDecision{Action: "wait"}
			}
			window := int64(fleetStepWindow)
			if cur.ID == tr.FirstNodeID {
				window = fleetFirstWindow
			}
			// Measure the window from the LATER of the track's stage start and
			// the node's own update start. The two are written by different
			// code paths; a stale StageStartedAt (still the previous stage's)
			// or an unset one (0, which is older than everything) would
			// otherwise collapse a 6h observation into seconds.
			stageStart := tr.StageStartedAt
			if cur.UpdateStartedAt > stageStart {
				stageStart = cur.UpdateStartedAt
			}
			if now-stageStart < window {
				return RolloutDecision{Action: "wait"}
			}
		}
	}

	// One pass: the nodes eligible to be updated next are exactly the online
	// ones not yet on target, so an empty candidate set IS "everyone online is
	// on target (bar any node left behind)" -- the completion condition.
	var candidates []NodeSnapshot
	for _, n := range nodes {
		if online(n) && !onTarget(n) && n.ID != skipped {
			candidates = append(candidates, n)
		}
	}
	if len(candidates) == 0 {
		return RolloutDecision{Action: "complete"}
	}

	// sort.Slice is NOT stable, so equal-comparing elements may come out in
	// any order run to run -- hence the fleetHash tie-break, which makes the
	// pick fully deterministic even when transfer counts are identical.
	if firstPick {
		sort.Slice(candidates, func(i, j int) bool {
			if candidates[i].ActiveTransfers != candidates[j].ActiveTransfers {
				return candidates[i].ActiveTransfers < candidates[j].ActiveTransfers
			}
			return fleetHash(candidates[i].ID, tr.TargetVersion) < fleetHash(candidates[j].ID, tr.TargetVersion)
		})
	} else {
		sort.Slice(candidates, func(i, j int) bool {
			return fleetHash(candidates[i].ID, tr.TargetVersion) < fleetHash(candidates[j].ID, tr.TargetVersion)
		})
	}
	return RolloutDecision{Action: "update", NodeID: candidates[0].ID, IsFirst: firstPick}
}

// fleetHash deterministically orders a node for a given rollout target so
// the pick order is reproducible but reshuffles per release. crypto/sha256,
// NOT math/rand: the same node must not always end up the canary.
func fleetHash(nodeID, targetVersion string) uint64 {
	sum := sha256.Sum256([]byte(nodeID + targetVersion))
	return binary.BigEndian.Uint64(sum[:8])
}
