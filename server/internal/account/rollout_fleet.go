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
// to update may go without a heartbeat before it is treated as bricked --
// and it also bounds the RESUME path in handleUpdateCheck (a node that keeps
// heartbeating but never reports a result is not silent, so this same limit
// is applied to elapsed time since the command was issued instead; see the
// "wait" branch's resume logic there). That reuse deliberately replaced an
// earlier per-poll attempt counter: the poll interval is entirely
// client-side, so a count-based budget could be burned in seconds by a
// crash-restart loop, or exceeded by a genuinely slow download on a healthy
// rollout. Elapsed wall-clock time has neither problem.
//
// fleetInstallLimit is the wall-clock backstop for the OTHER shape of a wedged
// node: commanded, still heartbeating, never converging. Neither of the two
// checks above catches it -- it is not silent, and it did record an update
// start -- and the 15-minute give-up that does catch it lives in
// updateCheckFleet's resume branch, which only runs when the wedged node ITSELF
// polls. A node whose updater has stopped running entirely (timer disabled,
// unit masked, updater crashed at boot) keeps heartbeating and never polls
// update-check again, so that branch never executes and the track waits
// forever. This limit is evaluated by decideFleet against whoever happens to be
// polling, so it does not depend on the wedged node's cooperation at all.
//
// It is deliberately four times updateSilenceLimit rather than a fresh magic
// number, and must stay comfortably longer than a legitimate install: download,
// the node's 60s drain, the restart, and the updater's 10-minute post-update
// health watch. An hour leaves room for a slow link on top of all of that,
// while still bounding the track to an hour rather than to nothing.
const (
	fleetFirstWindow   = 6 * 3600
	fleetStepWindow    = 30 * 60
	updateSilenceLimit = 15 * 60
	fleetInstallLimit  = 4 * updateSilenceLimit
)

// NodeSnapshot is what the state machine needs to know about one node.
type NodeSnapshot struct {
	ID         string
	Version    string
	LastSeenAt int64
	// ActiveTransfers is HOW BUSY the node is, used to prefer the least-loaded
	// machine as canary. NOTHING POPULATES IT TODAY: there is no such column in
	// the nodes table, the heartbeat does not report it, and nodeSnapshot leaves
	// it at 0 for every node. It is therefore uniformly zero in production and
	// the canary pick degrades to the deterministic fleetHash tie-break. The
	// rule is kept because the intent is sound and the tie-break is a legitimate
	// fallback, but do not describe the pick as load-aware until a producer
	// exists (a heartbeat field and a column would be the way in).
	ActiveTransfers int
	UpdateStartedAt int64
	// UpdateFromVersion mirrors nodes.update_from_version: the version the node
	// was running when central last commanded it to update, written together
	// with UpdateStartedAt. It is what lets a state machine tell a result that
	// belongs to the current rollout from one left over from the previous
	// one -- the update_* columns survive re-register and heartbeat and nothing
	// clears them (see byoResultIsFailure).
	UpdateFromVersion string
	UpdateResult      string // "" | "ok" | "failed" | "rolled_back" | "skipped"
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
//     A "rolling" track with an EMPTY TargetVersion is malformed, not a
//     rollout to the empty version: SameVersion("","") is true, so it would
//     classify blank-version nodes as on-target and command every other node
//     to install "". It waits instead.
//  2. If a node is currently being updated (CurrentNodeID set):
//     a. it is missing from the snapshot entirely -> it is SILENT, not gone:
//     wait until updateSilenceLimit, then halt. Never fall through to
//     picking another node -- see below.
//     b. its last reported UpdateResult is "failed" or "rolled_back" -> halt
//     c. its last reported UpdateResult is "skipped" -> its turn is over and
//     it will never reach the target: fall through to step 3/4 so the
//     queue advances, leaving the node behind for a human. If the SKIPPED
//     node was the recorded canary, IsFirst is re-asserted on whoever is
//     picked next, because a node that never installed the build cannot
//     have observed it (see reassertFirst).
//     d. it has gone silent (no heartbeat) for longer than updateSilenceLimit
//     since it was commanded to update -> halt (possible brick). If it
//     never even recorded an update start, tr.StageStartedAt is the
//     backstop -> halt as "never started".
//     e. it hasn't reached the target version yet -> wait, unless it was
//     commanded more than fleetInstallLimit ago, in which case it is wedged
//     (heartbeating but never converging) -> halt
//     f. it has reached the target version but hasn't cleared its
//     observation window yet (fleetFirstWindow for the canary,
//     fleetStepWindow for every node after) -> wait
//  3. Every fleet node currently online is already on the target version ->
//     complete.
//  4. Otherwise pick the next node to update: the very first node of the
//     rollout (no CurrentNodeID and no usable FirstNodeID yet) is chosen by fewest
//     ActiveTransfers -- least to lose if the new build is bad -- and
//     reported with IsFirst so the caller can persist it as FirstNodeID.
//     CAVEAT: ActiveTransfers has no producer yet (see NodeSnapshot), so it is
//     0 for every node in production and this pick currently degrades to the
//     same deterministic fleetHash order as every later pick. That is a
//     legitimate fallback, not the load-aware behaviour described above --
//     which only becomes true once something populates the field.
//     Every node after that is chosen by sha256(nodeID+targetVersion)
//     ascending, so the order is deterministic and reproducible but
//     reshuffles per release (the same node must not always end up the
//     canary). Offline nodes are skipped either way -> update.
func decideFleet(tr RolloutTrack, nodes []NodeSnapshot, now int64) RolloutDecision {
	if tr.Status != "rolling" {
		return RolloutDecision{Action: "wait"}
	}
	// SameVersion("", "") is true, so an empty target would read every
	// blank-version node as "on target" and command everybody else to install
	// the empty version. A rolling track with no target is a caller bug; the
	// only safe answer is to do nothing.
	if tr.TargetVersion == "" {
		return RolloutDecision{Action: "wait", Reason: "rolling track has no target version"}
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
	//
	// The one exception is a FirstNodeID left over from a PREVIOUS rollout: if
	// nothing is in flight and the recorded canary is not on the current
	// target, no node has been picked for THIS target yet, so the recorded ID
	// is stale. Trusting it would pick the canary by hash instead of by fewest
	// active transfers, hand it the 30min window, and never report IsFirst --
	// i.e. the whole rollout would run with no canary at all. Defend here
	// rather than trusting the caller to clear the field.
	firstPick := tr.CurrentNodeID == "" &&
		(tr.FirstNodeID == "" || !selfupdate.SameVersion(byID[tr.FirstNodeID].Version, tr.TargetVersion))

	// skipped is the current node's ID when it reported "skipped": it stays
	// behind the target version forever, so it must be kept out of the
	// candidate set below or the queue would just re-pick it in a loop.
	var skipped string
	// reassertFirst re-points the canary at whoever is picked next, because the
	// node currently recorded as canary is ending its turn WITHOUT ever having
	// run the build (it reported "skipped"). FirstNodeID is written when a node
	// is PICKED, not when it INSTALLS, so leaving it in place would burn the 6h
	// slot on a node that observed nothing and give the first node to actually
	// run the new build only 30 minutes.
	var reassertFirst bool

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
		//
		// canary is whether the node in flight holds this rollout's 6h slot.
		// FirstNodeID == "" while a node IS in flight is a track written before
		// the field existed (it migrates in as '' and only the backfill or a
		// fresh pick fills it): assume the node in flight is the canary, since
		// guessing "not the canary" would silently cut a live rollout's 6h
		// observation to 30 minutes. Every defence here must fail LONG.
		canary := cur.ID == tr.FirstNodeID || tr.FirstNodeID == ""
		if cur.UpdateResult == "skipped" {
			skipped = cur.ID
			reassertFirst = canary
		} else {
			if cur.UpdateStartedAt != 0 && now-cur.LastSeenAt > updateSilenceLimit {
				return RolloutDecision{Action: "halt", Reason: fmt.Sprintf("node %s silent since update started", cur.ID)}
			}
			if !onTarget(cur) {
				// Commanded, alive, but update_started_at is still 0: the
				// caller's two writes (the track's CurrentNodeID/StageStartedAt
				// and the node's update_started_at) split — a crash between
				// them, or the nodes row being replaced. Without a backstop this
				// waits forever, because the silence check above is gated on
				// UpdateStartedAt. tr.StageStartedAt is that backstop, exactly
				// as on the vanished-node path.
				if cur.UpdateStartedAt == 0 && now-tr.StageStartedAt > updateSilenceLimit {
					return RolloutDecision{Action: "halt",
						Reason: fmt.Sprintf("node %s never started the update it was commanded", cur.ID)}
				}
				// Commanded, heartbeating, update_started_at set -- and still not
				// on target an hour later. Nothing else here catches this: the
				// silence check needs it to stop heartbeating, the check above
				// needs update_started_at to be missing, and the 15-minute resume
				// give-up in updateCheckFleet only fires if this very node polls
				// again, which a node whose updater has stopped running never
				// does. Without this the whole fleet track waits forever on one
				// machine, showing 发布中. See fleetInstallLimit.
				if cur.UpdateStartedAt != 0 && now-cur.UpdateStartedAt > fleetInstallLimit {
					return RolloutDecision{Action: "halt", Reason: fmt.Sprintf(
						"node %s was commanded to update over %d seconds ago and is still not on %s",
						cur.ID, fleetInstallLimit, tr.TargetVersion)}
				}
				return RolloutDecision{Action: "wait"}
			}
			window := int64(fleetStepWindow)
			if canary {
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
	// pick fully deterministic even when transfer counts are identical. Since
	// ActiveTransfers currently has no producer and is 0 everywhere, that
	// tie-break is in fact the ONLY thing deciding this branch today; the
	// transfer comparison is dormant until a producer exists.
	// A re-asserted canary (the recorded one skipped) is picked the same way a
	// first canary is: fewest active transfers, least to lose.
	if firstPick || reassertFirst {
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
	return RolloutDecision{Action: "update", NodeID: candidates[0].ID, IsFirst: firstPick || reassertFirst}
}

// fleetHash deterministically orders a node for a given rollout target so
// the pick order is reproducible but reshuffles per release. crypto/sha256,
// NOT math/rand: the same node must not always end up the canary.
func fleetHash(nodeID, targetVersion string) uint64 {
	sum := sha256.Sum256([]byte(nodeID + targetVersion))
	return binary.BigEndian.Uint64(sum[:8])
}
