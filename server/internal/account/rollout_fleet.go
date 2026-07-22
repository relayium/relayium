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
}

// decideFleet is the fleet-track rollout state machine: a pure function of
// (track, node snapshots, now) so the caller can persist RolloutTrack and
// command nodes without this function ever touching a clock or a database.
// A 6h observation window is therefore just an integer in tests, not a wait.
//
// Decision order (THIS ORDER IS THE SPEC -- do not reorder without re-reading
// why; e.g. checking "everyone is on target" before "the current node
// failed" would let a halt condition be silently missed):
//
//  1. Status != "rolling" -> wait. Halted/complete tracks are inert; a fresh
//     rollout is started by an operator flipping Status back to "rolling".
//  2. If a node is currently being updated (CurrentNodeID set):
//     a. its last reported UpdateResult is "failed" or "rolled_back" -> halt
//     b. it has gone silent (no heartbeat) for longer than updateSilenceLimit
//     since it was commanded to update -> halt (possible brick)
//     c. it hasn't reached the target version yet -> wait
//     d. it has reached the target version but hasn't cleared its
//     observation window yet (fleetFirstWindow for the canary,
//     fleetStepWindow for every node after) -> wait
//  3. Every fleet node currently online is already on the target version ->
//     complete.
//  4. Otherwise pick the next node to update: the very first node of the
//     rollout (no CurrentNodeID yet) is chosen by fewest ActiveTransfers --
//     least to lose if the new build is bad. Every node after that is
//     chosen by sha256(nodeID+targetVersion) ascending, so the order is
//     deterministic and reproducible but reshuffles per release (the same
//     node must not always end up the canary). Offline nodes are skipped
//     either way -> update.
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

	// isFirstNode reports whether id is the rollout's canary: true as long as
	// no OTHER node has reached the target version yet. Because the fleet
	// track is strictly serial (one node at a time), this can only be true
	// for the very first node -- by the time a second node starts updating,
	// the first must already be confirmed "ok" and past its own window.
	isFirstNode := func(id string) bool {
		for _, n := range nodes {
			if n.ID != id && onTarget(n) {
				return false
			}
		}
		return true
	}

	if tr.CurrentNodeID != "" {
		if cur, ok := byID[tr.CurrentNodeID]; ok {
			if cur.UpdateResult == "failed" || cur.UpdateResult == "rolled_back" {
				verb := "failed to update"
				if cur.UpdateResult == "rolled_back" {
					verb = "rolled back"
				}
				return RolloutDecision{Action: "halt", Reason: fmt.Sprintf("node %s %s", cur.ID, verb)}
			}
			if cur.UpdateStartedAt != 0 && now-cur.LastSeenAt > updateSilenceLimit {
				return RolloutDecision{Action: "halt", Reason: fmt.Sprintf("node %s silent since update started", cur.ID)}
			}
			if !onTarget(cur) {
				return RolloutDecision{Action: "wait"}
			}
			window := int64(fleetStepWindow)
			if isFirstNode(cur.ID) {
				window = fleetFirstWindow
			}
			if now-tr.StageStartedAt < window {
				return RolloutDecision{Action: "wait"}
			}
		}
		// If the current node has vanished from the snapshot entirely, fall
		// through to picking the next one rather than waiting forever on a
		// node central no longer even hears about.
	}

	allOnlineOnTarget := true
	for _, n := range nodes {
		if online(n) && !onTarget(n) {
			allOnlineOnTarget = false
			break
		}
	}
	if allOnlineOnTarget {
		return RolloutDecision{Action: "complete"}
	}

	var candidates []NodeSnapshot
	for _, n := range nodes {
		if online(n) && !onTarget(n) {
			candidates = append(candidates, n)
		}
	}
	if len(candidates) == 0 {
		// Every node still behind the target is offline; nothing to do
		// until one of them comes back.
		return RolloutDecision{Action: "wait"}
	}

	if tr.CurrentNodeID == "" {
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
	return RolloutDecision{Action: "update", NodeID: candidates[0].ID}
}

// fleetHash deterministically orders a node for a given rollout target so
// the pick order is reproducible but reshuffles per release. crypto/sha256,
// NOT math/rand: the same node must not always end up the canary.
func fleetHash(nodeID, targetVersion string) uint64 {
	sum := sha256.Sum256([]byte(nodeID + targetVersion))
	return binary.BigEndian.Uint64(sum[:8])
}
