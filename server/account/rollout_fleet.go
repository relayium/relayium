package account

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/relayium/relayium/selfupdate"
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
	// machine as canary. It is real: the node counts its live relay allocations
	// and reports them on every heartbeat (heartbeatBody.activeTransfers),
	// central stores them on nodes.active_transfers, and nodeSnapshot copies
	// them here. All three links are needed — remove any one and the field is
	// uniformly -1 again, which fails silently rather than loudly, because
	// decideFleet's fleetHash tie-break then decides the whole branch.
	//
	// TRI-STATE: >= 0 is a REAL reported count (0 included — a node that
	// genuinely has nothing in flight); < 0 (see nodeSnapshot/TouchNode) means
	// "this node did not report a count on its last heartbeat", which is not
	// the same claim as "reports zero load" and must not be ranked as if it
	// were. canaryRank is where that distinction is spent: an unreported node
	// sorts AFTER every real count, not tied with a known-idle (0) one.
	//
	// It used to conflate the two by storing 0 for both. That was safe on
	// average (the fleetHash tie-break is a legitimate order over a genuine
	// tie) but not unbiased: in a PARTIALLY upgraded fleet, every un-upgraded
	// node reads exactly like a known-idle one and can win the tie-break
	// outright, so whichever un-upgraded node the hash favours is picked with
	// probability 1 — a systematic pull toward the machine central has the
	// LEAST information about, not merely a coin flip with the rest of the
	// fleet.
	ActiveTransfers int
	UpdateStartedAt int64
	// UpdateFromVersion mirrors nodes.update_from_version: the version the node
	// was running when central last commanded it to update, written together
	// with UpdateStartedAt. It is what lets a state machine tell a result that
	// belongs to the current rollout from one left over from the previous
	// one -- the update_* columns survive re-register and heartbeat and nothing
	// clears them (see byoResultIsFailure).
	UpdateFromVersion string
	UpdateResult      string // "" | "ok" | "failed" | "rolled_back" | "skipped" | "unreachable"
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
//     c. its last reported UpdateResult is "skipped" or "unreachable" -> its
//     turn is over and it will never reach the target: fall through to
//     step 3/4 so the queue advances, leaving the node behind for a human.
//     If that node was the recorded canary, IsFirst is re-asserted on
//     whoever is picked next, because a node that never installed the
//     build cannot have observed it (see reassertFirst).
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
//     ActiveTransfers is produced by the node's heartbeat and stored on its row
//     (see NodeSnapshot), so this pick really does follow load; nodes with no
//     load signal at all (an older binary) read 0 and fall to the tie-break.
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

	// reassertFirst re-points the canary at whoever is picked next, because the
	// node currently recorded as canary is ending its turn WITHOUT ever having
	// run the build (it reported "skipped" or "unreachable"). FirstNodeID is
	// written when a node is PICKED, not when it INSTALLS, so leaving it in
	// place would burn the 6h slot on a node that observed nothing and give
	// the first node to actually run the new build only 30 minutes.
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
			verb := "failed to verify or install the update"
			if cur.UpdateResult == "rolled_back" {
				verb = "rolled back"
			}
			return RolloutDecision{Action: "halt", Reason: fmt.Sprintf("node %s %s", cur.ID, verb)}
		}
		// "skipped" means the node declined this update (already on a newer
		// build, pinned, whatever) and will NEVER reach the target version.
		// "unreachable" means the node could not even fetch the build -- bytes
		// never arrived, so there is nothing to verify and nothing that could
		// have installed wrong. Neither is a failure of the RELEASE, so neither
		// halts -- but waiting for a version that will never be reported would
		// wedge the whole track forever on one machine's network. Both share
		// the same "this node's turn is over" handling: fall through so the
		// queue advances without it.
		//
		// canary is whether the node in flight holds this rollout's 6h slot.
		// FirstNodeID == "" while a node IS in flight is a track written before
		// the field existed (it migrates in as '' and only the backfill or a
		// fresh pick fills it): assume the node in flight is the canary, since
		// guessing "not the canary" would silently cut a live rollout's 6h
		// observation to 30 minutes. Every defence here must fail LONG.
		canary := cur.ID == tr.FirstNodeID || tr.FirstNodeID == ""
		if passedOverResult(cur, tr, byID) {
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
	// ones not yet on target and not already passed over, so an empty
	// candidate set IS "everyone online is on target (bar any node left
	// behind)" -- the completion condition.
	//
	// Excluding by RESULT rather than by "is this the current node" is the
	// difference between a rollout and an infinite loop: a single skipped-id
	// (an earlier approach) only ever named the most recently current node,
	// so a node that passed over on an earlier turn stopped being excluded
	// the instant some OTHER node took the slot -- n1 passes over, n2 is
	// picked, n2 passes over, n1 is no longer excluded, n1 is picked again,
	// forever. Checking the node's own last-reported result instead excludes
	// every passed-over node from THIS rollout at once -- see passedOverResult
	// for why "at once" must still mean "scoped to this rollout" and not
	// "forever": an unscoped version of this same check is a different,
	// quieter version of the identical bug, permanently stranding a node the
	// moment ANY rollout ever passes over it.
	var candidates []NodeSnapshot
	for _, n := range nodes {
		if online(n) && !onTarget(n) && !passedOverResult(n, tr, byID) {
			candidates = append(candidates, n)
		}
	}
	if len(candidates) == 0 {
		return RolloutDecision{Action: "complete"}
	}

	// sort.Slice is NOT stable, so equal-comparing elements may come out in
	// any order run to run -- hence the fleetHash tie-break, which makes the
	// pick fully deterministic even when transfer counts are identical (an
	// entirely idle fleet, or one whose nodes report no load signal at all).
	// A re-asserted canary (the recorded one passed over -- skipped or
	// unreachable) is picked the same way a first canary is: fewest active
	// transfers, least to lose.
	if firstPick || reassertFirst {
		sort.Slice(candidates, func(i, j int) bool {
			ri, rj := canaryRank(candidates[i].ActiveTransfers), canaryRank(candidates[j].ActiveTransfers)
			if ri != rj {
				return ri < rj
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

// passedOverResult reports whether n's last recorded update result marks it
// as having passed over TR'S CURRENTLY RUNNING rollout without ever reaching
// the target version: "skipped" (declined the update) or "unreachable"
// (could not fetch it). Such a node must be excluded from the candidate set
// for the rest of THIS rollout, not merely while it happens to be the
// current node -- see the candidate-filter comment in decideFleet.
//
// The scoping is the load-bearing half, and its absence was a real bug: an
// excluded node is, by construction, never re-commanded (that is what
// "excluded" means), and nothing but CommandNodeUpdate ever clears
// nodes.update_result -- not re-register, not heartbeat, not
// SetTargetVersion, which repoints TargetVersion without touching a single
// node row. Read n.UpdateResult alone and a node that reported "unreachable"
// once is excluded from EVERY rollout this track ever runs again, forever:
// circular and permanent, with nothing able to break the cycle. Measured
// concretely: a brand-new rollout to v3.0.0 with a node still carrying
// "unreachable" from a completed-or-abandoned v2.0.0 attempt must treat that
// node as a fresh candidate, not a permanent absentee.
//
// byoResultIsFailure scopes the analogous BYO check with
// byoCommandedByThisStage, comparing directly against tr.StageStartedAt.
// That does NOT transfer here: a BYO "stage" is a batch, spanning many nodes
// commanded together, so StageStartedAt is stable for as long as the batch is
// open. A fleet "stage" is a single node's turn (see
// RolloutTrack.StageStartedAt: "rewritten on EVERY stage transition"), so
// comparing against it directly would un-exclude an EARLIER passed-over node
// the instant any LATER node's turn begins -- n1 passes over, n2 becomes
// current and ALSO passes over, and by the time anyone asks again
// tr.StageStartedAt is n2's start, which is after n1's, so n1 reads as
// "belongs to an earlier stage" and is picked again. That is the exact
// ping-pong this predicate exists to stop, just one hop slower.
//
// The anchor that IS stable for "this rollout" is the canary's own pick time,
// byID[tr.FirstNodeID].UpdateStartedAt: FirstNodeID stops moving once a
// canary actually stays up long enough to be judged (only a canary that
// ITSELF passes over reassigns it -- see reassertFirst), so it survives every
// ordinary node's turn for the rest of the rollout. Before any node has been
// picked (FirstNodeID == ""), tr.StageStartedAt IS the right anchor instead:
// SetTargetVersion stamps it fresh with the row in the SAME write that clears
// FirstNodeID, so at that instant it can only be later than anything an
// earlier, superseded rollout wrote. If FirstNodeID names a node absent from
// the snapshot (it was uninstalled mid-rollout), fail toward CONTINUING to
// exclude: an anchor of 0 admits every past result as belonging to this
// rollout, the direction that costs one node sitting out rather than risking
// the ping-pong back.
func passedOverResult(n NodeSnapshot, tr RolloutTrack, byID map[string]NodeSnapshot) bool {
	if n.UpdateResult != "skipped" && n.UpdateResult != "unreachable" {
		return false
	}
	epoch := tr.StageStartedAt
	if tr.FirstNodeID != "" {
		epoch = 0
		if first, ok := byID[tr.FirstNodeID]; ok {
			epoch = first.UpdateStartedAt
		}
	}
	return n.UpdateStartedAt >= epoch
}

// canaryRank orders NodeSnapshot.ActiveTransfers for the canary sort: a real
// reported count (>= 0) ranks by its own value, but a node that reported NO
// count at all on its last heartbeat (< 0) ranks AFTER every real count —
// including a known-idle (0) one — rather than tying with it.
//
// Tying an unreported node with a known-idle one is exactly the bias this
// removes: an un-upgraded node in a mixed-version fleet always reads "no
// signal", so tying it with 0 hands it the tie-break on equal footing with a
// machine central actually KNOWS is idle, and the fleetHash order alone then
// decides which un-upgraded node wins — deterministically, every rollout,
// rather than as a fair coin flip against genuinely idle machines. Ranking it
// last removes the preference entirely: an unreported node is never
// preferred over any node central has real information about, however busy
// that node is.
func canaryRank(activeTransfers int) int {
	if activeTransfers < 0 {
		return math.MaxInt
	}
	return activeTransfers
}

// fleetHash deterministically orders a node for a given rollout target so
// the pick order is reproducible but reshuffles per release. crypto/sha256,
// NOT math/rand: the same node must not always end up the canary.
func fleetHash(nodeID, targetVersion string) uint64 {
	sum := sha256.Sum256([]byte(nodeID + targetVersion))
	return binary.BigEndian.Uint64(sum[:8])
}
