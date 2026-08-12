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
	// one -- the update_* columns survive re-register and heartbeat, and only
	// CommandNodeUpdate resets THIS one (ClearPassedOverResults: update_result).
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
//     In EITHER FAST mode this HALTS instead: both advance only on a
//     reported success, so a node that never installed the build cannot be
//     allowed to hand the slot to the next machine.
//     d. it has gone silent (no heartbeat) for longer than updateSilenceLimit
//     since it was commanded to update -> halt (possible brick). If it
//     never even recorded an update start, tr.StageStartedAt is the
//     backstop -> halt as "never started".
//     e. it hasn't reached the target version yet -> wait, unless it was
//     commanded more than fleetInstallLimit ago, in which case it is wedged
//     (heartbeating but never converging) -> halt
//     f. it has reached the target version but hasn't cleared its
//     observation window yet (fleetFirstWindow for the canary,
//     fleetStepWindow for every node after) -> wait. In MANUAL FAST mode
//     (tr.ManualFast) both windows are zero and this becomes "reached the
//     target but has not REPORTED 'ok' yet" -> wait, bounded by
//     fleetInstallLimit -> halt. That swap is the entire difference the mode
//     makes here, plus one extra halt in 2e for "ok" while not on target.
//     In SAFE FAST mode (tr.FastAfterCanary) the node must clear BOTH: it
//     must have REPORTED 'ok' (same bound, same halt) AND, if it is the
//     canary, have spent the full fleetFirstWindow on the target. Only
//     fleetStepWindow is dropped, and only for the nodes after the canary.
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
		// have installed wrong. Neither is a failure of the RELEASE.
		//
		// ON THE STAGED LADDER that is why neither halts: waiting for a version
		// that will never be reported would wedge the whole track forever on one
		// machine's network, so both share the same "this node's turn is over"
		// handling -- fall through so the queue advances without it.
		//
		// IN EITHER FAST MODE both HALT instead, and the difference is not
		// inconsistency: neither mode has a window it can advance the QUEUE on
		// (the safe mode's canary window gates the canary, not the machines after
		// it), so the only thing that can carry the queue forward is a reported
		// success. A node that never installed the build has not provided one, and
		// letting it hand the slot to the next machine would mean the fleet moving
		// on with nothing having verified the release. See the branch below.
		//
		// canary is whether the node in flight holds this rollout's 6h slot.
		// FirstNodeID == "" while a node IS in flight is a track written before
		// the field existed (it migrates in as '' and only the backfill or a
		// fresh pick fills it): assume the node in flight is the canary, since
		// guessing "not the canary" would silently cut a live rollout's 6h
		// observation to 30 minutes. Every defence here must fail LONG.
		canary := cur.ID == tr.FirstNodeID || tr.FirstNodeID == ""
		if passedOverResult(cur.UpdateResult) {
			// EITHER FAST MODE: a pass-over is NOT a success, and in these modes
			// the queue advances on nothing else. "skipped" and "unreachable" both
			// mean the node in flight never installed, restarted or proved the
			// build — so falling through to pick the next machine would command a
			// second node off the back of one that ran no part of the release,
			// which is the exact invariant these modes are allowed to keep.
			//
			// The staged ladder keeps its opposite behaviour deliberately: it
			// advances on an observation window, so leaving one unreachable
			// machine behind is better than stopping the fleet for it. Here there
			// is no window the QUEUE advances on, so "left behind" would silently
			// become "the rest of the fleet moved without any node having verified
			// the build". That is as true of the safe mode's canary — whose six
			// hours cannot be spent observing a build it never installed — as it
			// is of a node after it.
			if fastQueueMode(tr) {
				return RolloutDecision{Action: "halt", Reason: fmt.Sprintf(
					"node %s reported %q, so it never installed %s: a %s rollout stops rather than moving on",
					cur.ID, cur.UpdateResult, tr.TargetVersion, fastModeName(tr))}
			}
			reassertFirst = canary
		} else {
			if cur.UpdateStartedAt != 0 && now-cur.LastSeenAt > updateSilenceLimit {
				return RolloutDecision{Action: "halt", Reason: fmt.Sprintf("node %s silent since update started", cur.ID)}
			}
			if !onTarget(cur) {
				// FAST MODES ONLY: "ok" while not on the target is a
				// contradiction, and in these modes "ok" is the very signal the
				// queue advances on — so it must halt rather than be waited out.
				// (The staged path advances on its window instead, so it can
				// safely leave this to the wedge timeout below; leaving that
				// path byte-identical is deliberate.)
				//
				// It cannot fire on a healthy node racing its own heartbeat: a
				// node reports "ok" only on the poll AFTER its updater's health
				// watch passed, and that watch requires a heartbeat from the
				// restarted process, which re-registers its new version first.
				// The version therefore lands strictly before the result.
				if fastQueueMode(tr) && cur.UpdateResult == "ok" {
					return RolloutDecision{Action: "halt", Reason: fmt.Sprintf(
						"node %s reported a successful update but is running %q, not the target %s",
						cur.ID, cur.Version, tr.TargetVersion)}
				}
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
			// Measure from the LATER of the track's stage start and the node's
			// own update start. The two are written by different code paths; a
			// stale StageStartedAt (still the previous stage's) or an unset one
			// (0, which is older than everything) would otherwise collapse a 6h
			// observation into seconds — and, in fast mode, would put the
			// missing-result deadline in the past on the very first evaluation.
			stageStart := tr.StageStartedAt
			if cur.UpdateStartedAt > stageStart {
				stageStart = cur.UpdateStartedAt
			}
			// The SAFE fast mode is checked FIRST, and the order is a defence
			// rather than a preference. The three modes are mutually exclusive at
			// every write, so a row carrying both fast flags is already a bug; if
			// one ever exists, the branch taken must be the one that keeps the
			// canary's six hours, because this package's rule on the fleet ladder
			// is that every defence fails LONG. Testing tr.ManualFast first would
			// resolve that same bug by silently running a never-observed build
			// straight through the fleet.
			if tr.FastAfterCanary {
				// Both of the fast mode's gates, in the order that makes the
				// canary's window unskippable: the node's own reported verdict
				// first (it is what proves the build actually runs, and its
				// absence is bounded by fleetInstallLimit exactly as in manual
				// fast mode), then — for the canary only — the FULL six-hour
				// observation window, unchanged from the staged ladder.
				//
				// The canary therefore cannot pass on time alone (six quiet hours
				// with no result is a halt, not a promotion) and cannot pass on a
				// result alone (an "ok" ten minutes in still owes the window). The
				// nodes after it owe only the result: fleetStepWindow is the one
				// thing this mode drops, and it drops it only once a machine has
				// carried the build through a full observation period.
				if cur.UpdateResult != "ok" {
					if now-stageStart > fleetInstallLimit {
						return RolloutDecision{Action: "halt", Reason: fmt.Sprintf(
							"node %s installed %s over %d seconds ago but never reported the outcome",
							cur.ID, tr.TargetVersion, fleetInstallLimit)}
					}
					return RolloutDecision{Action: "wait"}
				}
				if canary && now-stageStart < fleetFirstWindow {
					return RolloutDecision{Action: "wait"}
				}
				// Canary observed and reported, or a later node reported. Fall
				// through and pick the next node now.
			} else if tr.ManualFast {
				// THE MODE: both observation windows are skipped, and the node's
				// own verdict is NOT. The queue advances only once this node has
				// REPORTED "ok" — never merely because it is seen on the target
				// version, which happens the instant the new binary starts and
				// re-registers, up to healthWindow (10min) before its updater has
				// decided whether to roll it back. Advancing on version alone
				// would command a second machine while the first one's rollback
				// is still in flight, which is exactly the property this mode is
				// allowed to keep. Only "ok" (exitOK: installed, restarted and
				// confirmed healthy — resultForExitCode in the node updater)
				// means done.
				//
				// Every other value was handled above (failed/rolled_back halted,
				// skipped/unreachable took the passed-over branch), so the only
				// value reachable here is "" — not yet reported.
				if cur.UpdateResult != "ok" {
					// Bounded, or an updater that died between installing and
					// reporting pins the rollout in 发布中 forever: on target, so
					// the wedge check cannot fire; heartbeating, so neither can
					// the silence one. fleetInstallLimit comfortably exceeds
					// install + the 10min health watch + one ~10min poll.
					if now-stageStart > fleetInstallLimit {
						return RolloutDecision{Action: "halt", Reason: fmt.Sprintf(
							"node %s installed %s over %d seconds ago but never reported the outcome",
							cur.ID, tr.TargetVersion, fleetInstallLimit)}
					}
					return RolloutDecision{Action: "wait"}
				}
				// Reported ok. Fall through and pick the next node now.
			} else {
				window := int64(fleetStepWindow)
				if canary {
					window = fleetFirstWindow
				}
				if now-stageStart < window {
					return RolloutDecision{Action: "wait"}
				}
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
	// every passed-over node from this rollout at once, so the queue drains
	// monotonically and reaches "complete" even when every node fails to
	// fetch (TestDecideFleetConvergesWhenEveryNodeFailsToFetch drives exactly
	// that sequence). What keeps "at once" from meaning "forever" is not a
	// rule here but a WRITE elsewhere: setTargetVersion clears the tainted
	// results when a track is repointed -- see passedOverResult.
	var candidates []NodeSnapshot
	for _, n := range nodes {
		if online(n) && !onTarget(n) && !passedOverResult(n.UpdateResult) {
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

// fleetFastHintFor reports whether this node should be ASKED to run an update
// check right now, rather than waiting up to a poll interval for its timer.
//
// Without it, removing the observation windows still leaves every node waiting
// out its own ~10-minute timer to discover its turn — on a 16-machine fleet,
// over two hours of pure polling latency.
//
// A HINT, NEVER A COMMAND, and three properties keep it that way:
//
//   - it authorises nothing. All the node does with a true answer is ask its
//     root updater to run; that updater re-queries central and verifies the
//     release signature itself. Every guarantee is downstream of the poll.
//   - it is PURE, and the caller must keep it so: the heartbeat path must not
//     claim, command, halt or complete. That belongs to update-check, where the
//     compare-and-swap lives.
//   - both wrong answers are safe. A false negative means the node waits for its
//     timer (the pre-existing behaviour); a false positive means one extra poll
//     answering "not your turn", because ClaimRolloutNode — not this — is what
//     makes the rollout serial.
//
// It hints exactly the node whose turn it is: the one holding the slot with no
// result yet (its report IS the rollout's pace here), and the one decideFleet
// would pick next. Any other result means the track is about to halt on or move
// past that node, so there is nothing to hurry.
//
// Fast modes only: on the staged ladder the wait is the POINT, and an
// emergency release has no queue to be next in.
//
// The SAFE fast mode hints too, and hinting DURING its canary's six hours costs
// that window nothing. The hint only ever reaches the node decideFleet would act
// on next, and for the whole of the canary's window decideFleet answers "wait"
// for every node — so no later machine can be hurried into the queue by it. What
// it does buy is the two places this mode is genuinely waiting on a poll: the
// canary starting its window promptly rather than up to ten minutes late, and
// the next node being commanded promptly once the window has closed.
func fleetFastHintFor(tr RolloutTrack, snaps []NodeSnapshot, nodeID string, now int64) bool {
	if tr.Status != "rolling" || !fastQueueMode(tr) || tr.Emergency || tr.TargetVersion == "" {
		return false
	}
	if tr.CurrentNodeID == nodeID {
		for _, n := range snaps {
			if n.ID == nodeID {
				return n.UpdateResult == ""
			}
		}
		return false
	}
	d := decideFleet(tr, snaps, now)
	return d.Action == "update" && d.NodeID == nodeID
}

// fastQueueMode reports whether this track's QUEUE advances only on the node in
// flight having REPORTED "ok" — true for both fast modes, false for the staged
// ladder, which advances on an observation window instead.
//
// It is one predicate rather than `tr.ManualFast || tr.FastAfterCanary` spelled
// out at each site because the three places that read it are the three halts
// that make either mode safe (pass-over, contradictory result, missing result),
// and a mode added to two of the three would be a rollout that moves the fleet
// on a machine that never verified the build. This package has shipped that
// class of defect before, from exactly this shape of hand-copied condition.
//
// It deliberately says nothing about WINDOWS: the safe mode keeps the canary's
// six hours and manual fast does not, which is the one thing the two disagree
// about and therefore the one thing that must stay spelled out at the branch
// that implements it (see decideFleet's on-target step).
func fastQueueMode(tr RolloutTrack) bool { return tr.ManualFast || tr.FastAfterCanary }

// fastModeName names the mode in a halt reason, which is operator-facing text on
// the panel and in the audit trail. The two modes stop for the same reasons but
// are different decisions to have made, and an incident review reading "a manual
// fast rollout stopped" about a rollout that kept its canary window would be
// told the wrong thing about what was skipped.
//
// The manual-fast wording is unchanged from before this mode existed, so a halt
// on that path still reads byte-for-byte as it always did.
func fastModeName(tr RolloutTrack) string {
	if tr.FastAfterCanary {
		return "canary-then-fast"
	}
	return "manual fast"
}

// passedOverResult reports whether an update result marks the node that
// reported it as having had its turn without ever reaching the target
// version: "skipped" (declined the update) or "unreachable" (could not fetch
// it). Such a node is excluded from the candidate set for the rest of this
// rollout, not merely while it happens to be the current node -- see the
// candidate-filter comment in decideFleet.
//
// IT TAKES THE RESULT AND NOTHING ELSE, ON PURPOSE. The obvious objection is
// that nodes.update_result outlives the rollout that produced it -- it
// survives re-register and heartbeat, and CommandNodeUpdate is the only thing
// that ever clears it -- so an excluded node can never clear its own flag and
// would sit out every future rollout forever. That objection is real, and it
// is answered at the WRITE, not here. Three writes hand candidacy back, and
// between them a passed-over result can only ever belong to the rollout
// currently running:
//
//   - setTargetVersion, in the same operation that repoints the target, across
//     the track's owner class (see ClearPassedOverResults);
//   - ResumeRolloutTrack, inside its transaction, because 继续 restarts the
//     ladder from the beginning;
//   - RetryRolloutNode, for ONE node on a finished track;
//   - StartManualFastRollout and StartCanaryFastRollout, inside the transaction
//     they share (startFastRollout), because each starts a fresh rollout on a
//     finished track — exactly the case the warning below anticipated, which is
//     why the second of them inherited the clear by construction rather than by
//     someone remembering it.
//
// Adding a further way to start or restart a rollout means adding the clear to
// it as well; without it, that path strands every node this rollout passed
// over.
//
// Do NOT reintroduce a rollout scope as an argument to this predicate. Two
// attempts did, and both shipped an infinite re-command loop, because
// decideFleet can see no clock that is stable across a rollout: a fleet
// "stage" is one node's turn, so tr.StageStartedAt is restamped by every
// ClaimRolloutNode; and the caller writes the newly picked node into
// FirstNodeID whenever IsFirst comes back set (updateCheckFleet in nodes.go),
// which reassertFirst does on exactly the event a pass-over is. Anchoring on
// either one therefore moves under the very event the scope has to survive,
// un-excludes the node that passed over one hop earlier, and picks it again.
// (byoResultIsFailure CAN scope on tr.StageStartedAt only because a BYO stage
// is a whole batch, held open across many nodes.) With the write-side clear in
// place there is nothing left for a read-side scope to do.
//
// This set is duplicated in SQL as passedOverResultsSQL (rollout_store.go),
// which every statement keying on a pass-over builds its IN clause from. A
// value added here must be added there too, or the writes above will not clear
// the value these reads exclude on -- a node stranded out of every future
// rollout, which is the exact failure the write-side scoping exists to avoid.
func passedOverResult(result string) bool {
	return result == "skipped" || result == "unreachable"
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
