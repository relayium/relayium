package account

import (
	"fmt"
	"sort"
	"strings"
	"testing"
)

// byoNodes builds n BYO node snapshots. IDs are zero-padded and distinct at
// any size -- an earlier string(rune('a'+i)) scheme silently produced
// non-letter and duplicate-looking IDs past ~26 nodes, i.e. exactly at the
// population sizes where batching matters.
func byoNodes(n int, ver string, seen int64) []NodeSnapshot {
	out := make([]NodeSnapshot, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, NodeSnapshot{ID: fmt.Sprintf("byo-node-%04d", i), Version: ver, LastSeenAt: seen})
	}
	return out
}

// byoBatchIDs returns the IDs of the first pct% of nodes in the rollout's hash
// ordering: the members decideByo considers commanded at that stage. Tests use
// it to place failures INSIDE the open batch, which is the only way to
// exercise the batch-scoped failure-rate denominator.
func byoBatchIDs(nodes []NodeSnapshot, target string, pct int) []string {
	ordered := append([]NodeSnapshot(nil), nodes...)
	sort.Slice(ordered, func(i, j int) bool {
		return fleetHash(ordered[i].ID, target) < fleetHash(ordered[j].ID, target)
	})
	var ids []string
	for _, n := range ordered[:pctCount(len(ordered), pct)] {
		ids = append(ids, n.ID)
	}
	return ids
}

// markFailed marks the first k members of the pct% batch as having failed an
// update to target (rolled back onto the version they were commanded from, so
// the result unambiguously belongs to THIS rollout). It also stamps
// UpdateFromVersion on the REST of the pct% batch -- as a real caller would
// for every node it actually commands, per decideByo's OUTPUT CONTRACT --
// since a batch member is only in the failure-rate denominator once it has
// genuinely been commanded, not merely by sitting in the batch prefix.
//
// `at` is when the command was issued, and every batch member gets it:
// CommandNodeUpdate writes update_started_at in the same statement as
// update_from_version, and byoCommandedByThisStage reads it to tell a record
// this rollout wrote from one a dead rollout left behind. Callers pass their
// track's StageStartedAt, i.e. "commanded by the stage now open".
func markFailed(t *testing.T, nodes []NodeSnapshot, target string, pct, k int, at int64) {
	t.Helper()
	ids := byoBatchIDs(nodes, target, pct)
	if k > len(ids) {
		t.Fatalf("markFailed: want %d failures inside the %d%% batch, which holds only %d", k, pct, len(ids))
	}
	failing := make(map[string]bool, k)
	for _, id := range ids[:k] {
		failing[id] = true
	}
	inBatch := make(map[string]bool, len(ids))
	for _, id := range ids {
		inBatch[id] = true
	}
	for i := range nodes {
		if !inBatch[nodes[i].ID] {
			continue
		}
		nodes[i].UpdateFromVersion = nodes[i].Version // every batch member was commanded
		nodes[i].UpdateStartedAt = at
		if failing[nodes[i].ID] {
			nodes[i].UpdateResult = "failed"
		}
	}
}

// BYO can be hundreds of machines; strict serial would take days and none of
// them are ours to babysit.
func TestDecideByoFirstBatchIsTenPercent(t *testing.T) {
	tr := RolloutTrack{Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", ByoBatch: 0}
	nodes := byoNodes(20, "v0.8.0", tNow)

	action, eligible, _ := decideByo(tr, nodes, tNow)
	if action != "update" {
		t.Fatalf("action = %q, want update", action)
	}
	if len(eligible) != 2 {
		t.Errorf("eligible = %d nodes, want 2 (10%% of 20)", len(eligible))
	}
}

// A rollout whose StageStartedAt was stamped when the operator started it --
// which RolloutTrack's doc requires on every stage transition, so it is the
// natural thing for a caller to do -- must not sit idle for six hours before
// commanding its first node. The window separates BATCHES; there is no earlier
// batch to observe.
func TestDecideByoFirstBatchOpensImmediately(t *testing.T) {
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 0, StageStartedAt: tNow,
	}
	nodes := byoNodes(20, "v0.8.0", tNow)

	action, eligible, _ := decideByo(tr, nodes, tNow)
	if action != "update" || len(eligible) != 2 {
		t.Fatalf("action=%q eligible=%d on a freshly-stamped track, want update with the 10%% batch", action, len(eligible))
	}
}

// One flaky user machine is normal, not a signal — halting on it would leave
// the BYO track permanently stuck. 1 of 2 is a 50% "rate", far above the
// threshold: only the absolute floor stops this from halting, so this test is
// what makes the floor load-bearing.
func TestDecideByoToleratesASingleFailure(t *testing.T) {
	nodes := byoNodes(2, "v0.8.0", tNow)
	markFailed(t, nodes, "v0.9.0", 100, 1, tNow-7*tHour)
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 100, StageStartedAt: tNow - 7*tHour,
	}

	action, _, _ := decideByo(tr, nodes, tNow)
	if action == "halt" {
		t.Error("action = halt on a single BYO failure (1 of 2); want the rollout to continue")
	}
}

// The failure rate must be measured over the nodes actually COMMANDED, not the
// whole population: 3 of the 10-node canary batch is 30% and must halt, while
// the same 3 over all 100 nodes is 3% and would sail on into the 50% batch.
// The population denominator caps the observable rate at the open percentage,
// so the canary stage could never halt — which is the only reason it exists.
func TestDecideByoHaltsAboveFailureRate(t *testing.T) {
	nodes := byoNodes(100, "v0.8.0", tNow)
	markFailed(t, nodes, "v0.9.0", 10, 3, tNow-7*tHour) // 3/10 = 30% of the open batch; 3/100 = 3% of the population
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - 7*tHour,
	}

	action, _, reason := decideByo(tr, nodes, tNow)
	if action != "halt" {
		t.Fatalf("action = %q with 3 of the 10-node canary batch failed, want halt", action)
	}
	if reason == "" {
		t.Error("halt with no reason; admin needs to know why")
	}
}

// The threshold is strictly-greater: exactly 20% is at the line, not over it.
func TestDecideByoFailureRateThresholdIsExclusive(t *testing.T) {
	for _, tc := range []struct {
		failures int
		want     string
	}{
		{20, "update"}, // exactly 20% — at the threshold, not above it
		{21, "halt"},   // 21% — above it
	} {
		nodes := byoNodes(100, "v0.8.0", tNow)
		markFailed(t, nodes, "v0.9.0", 100, tc.failures, tNow-7*tHour)
		tr := RolloutTrack{
			Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
			ByoBatch: 100, StageStartedAt: tNow - 7*tHour,
		}
		if action, _, _ := decideByo(tr, nodes, tNow); action != tc.want {
			t.Errorf("%d/100 failures: action = %q, want %q", tc.failures, action, tc.want)
		}
	}
}

// Probed: 200 BYO nodes, a 20-node canary batch (10%), but only 4 of those 20
// were online and actually commanded (nodes.update_from_version stamped) when
// the batch opened -- the other 16 were offline and untouched. All 4 commanded
// nodes failed. The denominator MUST be the 4 actually-commanded nodes, not
// the 20-node batch prefix: 4/20 = 20%, at the threshold and can never halt,
// while the true rate over who was actually exercised is 4/4 = 100%.
func TestDecideByoHaltsWhenOnlyAFewOfTheBatchWereReachable(t *testing.T) {
	nodes := byoNodes(200, "v0.8.0", tNow)
	batch := byoBatchIDs(nodes, "v0.9.0", 10)
	if len(batch) != 20 {
		t.Fatalf("canary batch = %d nodes, want 20 (10%% of 200)", len(batch))
	}
	reachable := make(map[string]bool, 4)
	for _, id := range batch[:4] {
		reachable[id] = true
	}
	for i := range nodes {
		if reachable[nodes[i].ID] {
			nodes[i].UpdateFromVersion = nodes[i].Version // actually commanded
			nodes[i].UpdateStartedAt = tNow - 7*tHour     // ... by the stage now open
			nodes[i].UpdateResult = "failed"
		}
		// The other 16 batch members are left with no UpdateFromVersion:
		// offline when the batch opened, never commanded.
	}
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - 7*tHour,
	}

	action, _, reason := decideByo(tr, nodes, tNow)
	if action != "halt" {
		t.Fatalf("action = %q with all 4 actually-commanded canary nodes failed (16/20 never reachable), want halt (reason=%q)", action, reason)
	}
}

// nodes.update_result survives re-register and heartbeat (UpsertNode's ON
// CONFLICT deliberately excludes the update_* columns) and nothing clears it,
// so leftovers from the LAST rollout are sitting in the table on the day the
// next one starts. Counting them would halt a rollout that has not commanded
// a single node.
func TestDecideByoIgnoresStaleResultsFromAPreviousRollout(t *testing.T) {
	// The two shapes a leftover row can take, and the second one is the shape a
	// GENUINE failure leaves behind: the update did not land, so the node is
	// still sitting on exactly the version update_from_version names. Only the
	// first shape (the node moved on afterwards) was ever excluded by the
	// version terms alone, which is why this test used to pass while the
	// failing shape wedged the track -- see byoCommandedByThisStage.
	for _, shape := range []struct {
		name       string
		nodeVerNow string
	}{
		{"node moved on to another version after the failure", "v0.8.0"},
		{"node never left the version it was commanded from (a real failure)", "v0.7.0"},
	} {
		// Both before the first batch opens and mid-ladder: the prefix is empty
		// at ByoBatch 0, so only the second value actually exercises the
		// failure-rate check.
		for _, batch := range []int{0, 50} {
			t.Run(fmt.Sprintf("%s/batch=%d", shape.name, batch), func(t *testing.T) {
				nodes := byoNodes(20, "v0.8.0", tNow)
				stale := byoBatchIDs(nodes, "v0.9.0", 50)[:5] // 5 of the open 10-node batch
				staleSet := make(map[string]bool, len(stale))
				for _, id := range stale {
					staleSet[id] = true
				}
				for i := range nodes {
					if !staleSet[nodes[i].ID] {
						continue
					}
					nodes[i].Version = shape.nodeVerNow
					nodes[i].UpdateResult = "failed"
					nodes[i].UpdateFromVersion = "v0.7.0"         // a v0.7.0 -> v0.8.0 rollout, long over
					nodes[i].UpdateStartedAt = tNow - 30*24*tHour // ...commanded a month ago
				}
				tr := RolloutTrack{
					Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
					ByoBatch: batch, StageStartedAt: tNow - tHour,
				}

				action, _, reason := decideByo(tr, nodes, tNow)
				if action == "halt" {
					t.Fatalf("action = halt (%q); this rollout has commanded nobody, so a previous one's records must not count", reason)
				}
			})
		}
	}
}

// Probed against the real decideByo: 10 BYO nodes, 2 of which genuinely failed
// the previous rollout, are still sitting on the version they were commanded
// from, and have been offline ever since. Because a failed update leaves
// update_from_version pointing at the node's current version FOREVER, the
// version-only predicates counted those two dead machines in both the
// numerator and the denominator of the NEXT rollout's failure rate: 2/2, an
// immediate halt on the first evaluation, with the reason naming a batch this
// release had not commanded a single node in.
//
// Nothing escaped it. 继续 resets ByoBatch and re-walks the ladder into the same
// two rows; a brand-new target does the same. Only those machines coming back
// online and being re-commanded cleared it -- and they are dead. Two dead BYO
// nodes could wedge the BYO track permanently, which is the exact opposite of
// the fix-forward behaviour the design promises.
func TestDecideByoDoesNotInheritAPreviousRolloutsRealFailures(t *testing.T) {
	const target = "v1.0.0"
	nodes := byoNodes(10, "v0.9.0", tNow)
	// Put the two dead nodes INSIDE the open batch prefix, which is where they
	// have to be to be counted at all.
	dead := byoBatchIDs(nodes, target, 50)[:2]
	deadSet := map[string]bool{dead[0]: true, dead[1]: true}
	for i := range nodes {
		if !deadSet[nodes[i].ID] {
			continue
		}
		nodes[i].Version = "v0.8.0"                   // never made it off v0.8.0
		nodes[i].UpdateFromVersion = "v0.8.0"         // ...which is what it was commanded from
		nodes[i].UpdateResult = "failed"              // the v0.8.0 -> v0.9.0 rollout's failure
		nodes[i].UpdateStartedAt = tNow - 30*24*tHour // a month ago
		nodes[i].LastSeenAt = tNow - 30*24*tHour      // and offline since, so never re-commanded
	}
	tr := RolloutTrack{
		Track: "byo", TargetVersion: target, Status: "rolling",
		ByoBatch: 50, StageStartedAt: tNow - 7*tHour,
	}

	action, _, reason := decideByo(tr, nodes, tNow)
	if action == "halt" {
		t.Fatalf("action = halt (%q); two nodes that failed a PREVIOUS rollout and are still on the old version must not halt this one", reason)
	}
}

// Same defence mid-rollout: nodes that failed the previous rollout but have
// since moved on to the version it targeted are not this rollout's failures.
func TestDecideByoIgnoresStaleResultsMidRollout(t *testing.T) {
	nodes := byoNodes(20, "v0.8.0", tNow)
	stale := byoBatchIDs(nodes, "v0.9.0", 50)[:5] // 5 of the open 10-node batch
	staleSet := make(map[string]bool, len(stale))
	for _, id := range stale {
		staleSet[id] = true
	}
	for i := range nodes {
		if staleSet[nodes[i].ID] {
			nodes[i].UpdateResult = "failed"
			nodes[i].UpdateFromVersion = "v0.7.0" // failed v0.7.0 -> v0.8.0, then fixed by hand
		}
	}
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 50, StageStartedAt: tNow - 7*tHour,
	}

	if action, _, reason := decideByo(tr, nodes, tNow); action == "halt" {
		t.Fatalf("action = halt (%q); a failure whose from-version the node has left is a previous rollout's", reason)
	}
}

func TestDecideByoAdvancesBatchesAfterWindow(t *testing.T) {
	nodes := byoNodes(20, "v0.8.0", tNow)
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - 7*tHour,
	}
	action, eligible, _ := decideByo(tr, nodes, tNow)
	if action != "update" || len(eligible) != pctCount(20, 50) {
		t.Fatalf("action=%q eligible=%d, want update with the %d-node 50%% batch", action, len(eligible), pctCount(20, 50))
	}
}

// eligible means "these nodes still need the update", not "a batch is open":
// nodes already running the target must drop out, so re-calling decideByo with
// the same track state does not re-command them (and does not re-stamp their
// nodes.update_started_at), and so an empty list is a usable "converged"
// signal.
func TestDecideByoExcludesNodesAlreadyOnTarget(t *testing.T) {
	nodes := byoNodes(20, "v0.8.0", tNow)
	updated := byoBatchIDs(nodes, "v0.9.0", 50)[:8]
	done := make(map[string]bool, len(updated))
	for _, id := range updated {
		done[id] = true
	}
	for i := range nodes {
		if done[nodes[i].ID] {
			nodes[i].Version = "0.9.0" // goreleaser stamps versions WITHOUT the leading v
		}
	}
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - 7*tHour,
	}

	action, eligible, _ := decideByo(tr, nodes, tNow)
	if action != "update" {
		t.Fatalf("action = %q, want update", action)
	}
	want := pctCount(20, 50) - 8
	if len(eligible) != want {
		t.Fatalf("eligible = %d, want %d (the 50%% batch minus the 8 already on target)", len(eligible), want)
	}
	for _, id := range eligible {
		if done[id] {
			t.Errorf("node %s is already on the target version but was returned as eligible", id)
		}
	}
}

func TestDecideByoWaitsInsideWindow(t *testing.T) {
	nodes := byoNodes(20, "v0.8.0", tNow)
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - tHour,
	}
	if action, _, _ := decideByo(tr, nodes, tNow); action != "wait" {
		t.Errorf("action = %q one hour into a 6h batch window, want wait", action)
	}
}

// complete is not "the last window elapsed", it is "the rollout landed". A
// time-only completion strands every node that was offline when the 100% batch
// opened: no wider batch is left to command them, and complete is the only
// signal the admin console has.
func TestDecideByoCompletesOnlyWhenNodesAreOnTarget(t *testing.T) {
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 100, StageStartedAt: tNow - 7*tHour,
	}

	t.Run("all on target", func(t *testing.T) {
		nodes := byoNodes(20, "0.9.0", tNow)
		if action, _, _ := decideByo(tr, nodes, tNow); action != "complete" {
			t.Errorf("action = %q with every node on the target version, want complete", action)
		}
	})

	t.Run("stragglers still behind", func(t *testing.T) {
		nodes := byoNodes(20, "0.9.0", tNow)
		nodes[3].Version = "v0.8.0"
		action, eligible, _ := decideByo(tr, nodes, tNow)
		if action != "complete" && action != "update" {
			t.Fatalf("action = %q, want update", action)
		}
		if action == "complete" {
			t.Fatal("action = complete with a node still on v0.8.0; the rollout has not landed")
		}
		if len(eligible) != 1 || eligible[0] != nodes[3].ID {
			t.Errorf("eligible = %v, want just the straggler %s", eligible, nodes[3].ID)
		}
	})

	t.Run("long-offline node does not block forever", func(t *testing.T) {
		nodes := byoNodes(20, "0.9.0", tNow)
		nodes[3].Version = "v0.8.0"
		nodes[3].LastSeenAt = tNow - 7*24*3600 // dark for a week
		if action, _, _ := decideByo(tr, nodes, tNow); action != "complete" {
			t.Errorf("action = %q; a machine offline for a week must not hold a rollout open", action)
		}
	})
}

// Nobody is reachable: there is no node to command and none we can call
// behind, so the stage is done rather than wedged.
func TestDecideByoAllOffline(t *testing.T) {
	nodes := byoNodes(20, "v0.8.0", tNow-7*24*3600)
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 100, StageStartedAt: tNow - 7*tHour,
	}
	action, eligible, _ := decideByo(tr, nodes, tNow)
	if action != "complete" || len(eligible) != 0 {
		t.Errorf("action=%q eligible=%d with every node offline, want complete with none eligible", action, len(eligible))
	}
}

// SameVersion("", "") is true, so an empty target would read blank-version
// nodes as on-target and command everyone else to install nothing. A rolling
// track with no target is a caller bug; the only safe answer is to do nothing.
func TestDecideByoNeverUpdatesWithoutATarget(t *testing.T) {
	nodes := byoNodes(20, "", tNow)
	for _, batch := range []int{0, 10, 50, 100} {
		tr := RolloutTrack{
			Track: "byo", TargetVersion: "", Status: "rolling",
			ByoBatch: batch, StageStartedAt: tNow - 7*tHour,
		}
		action, eligible, _ := decideByo(tr, nodes, tNow)
		if action == "update" || len(eligible) != 0 {
			t.Errorf("ByoBatch=%d: action=%q eligible=%v with an empty target, want no update", batch, action, eligible)
		}
	}
}

// A corrupt or legacy byo_batch must not fall back to "open the 10% batch":
// that would REGRESS a rollout that had already reached 50% or 100%, and could
// loop there.
func TestDecideByoHaltsOnUnrecognisedBatch(t *testing.T) {
	nodes := byoNodes(20, "v0.8.0", tNow)
	for _, bad := range []int{5, 20, 51, 99, 1000, -1} {
		tr := RolloutTrack{
			Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
			ByoBatch: bad, StageStartedAt: tNow - 7*tHour,
		}
		action, _, reason := decideByo(tr, nodes, tNow)
		if action != "halt" {
			t.Errorf("ByoBatch=%d: action = %q, want halt", bad, action)
		}
		if !strings.Contains(reason, fmt.Sprint(bad)) {
			t.Errorf("ByoBatch=%d: reason %q does not name the offending value", bad, reason)
		}
	}
}

// No BYO nodes at all: there is nothing to roll, so walking the 10/50/100
// ladder would report three stages of progress that never touched a machine.
func TestDecideByoEmptyPopulationCompletes(t *testing.T) {
	tr := RolloutTrack{Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", ByoBatch: 0}
	action, eligible, _ := decideByo(tr, nil, tNow)
	if action != "complete" || len(eligible) != 0 {
		t.Errorf("action=%q eligible=%d with no BYO nodes, want complete with none eligible", action, len(eligible))
	}
}

func TestDecideByoNonRollingTracksAreInert(t *testing.T) {
	nodes := byoNodes(20, "v0.8.0", tNow)
	for _, status := range []string{"halted", "complete", ""} {
		tr := RolloutTrack{Track: "byo", TargetVersion: "v0.9.0", Status: status, ByoBatch: 10}
		if action, _, _ := decideByo(tr, nodes, tNow); action != "wait" {
			t.Errorf("status %q: action = %q, want wait", status, action)
		}
	}
}

// Rounding is up, so no batch of a nonzero population can round to zero nodes
// and stall the ladder — a 1-node BYO population must still get its canary.
func TestPctCountRoundsUp(t *testing.T) {
	for _, tc := range []struct{ total, pct, want int }{
		{0, 10, 0}, {1, 10, 1}, {1, 50, 1}, {1, 100, 1},
		{2, 10, 1}, {2, 50, 1}, {2, 100, 2},
		{3, 10, 1}, {3, 50, 2}, {3, 100, 3},
		{20, 10, 2}, {100, 10, 10}, {137, 10, 14}, {137, 50, 69},
		{5, 0, 0}, {5, -1, 0},
	} {
		if got := pctCount(tc.total, tc.pct); got != tc.want {
			t.Errorf("pctCount(%d, %d) = %d, want %d", tc.total, tc.pct, got, tc.want)
		}
	}
}

// Tiny populations must still walk the whole ladder rather than stalling on a
// batch that rounds to nobody.
func TestDecideByoTinyPopulations(t *testing.T) {
	for _, total := range []int{1, 2, 3} {
		nodes := byoNodes(total, "v0.8.0", tNow)
		tr := RolloutTrack{Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", ByoBatch: 0}
		action, eligible, _ := decideByo(tr, nodes, tNow)
		if action != "update" || len(eligible) == 0 {
			t.Errorf("%d node(s): action=%q eligible=%d, want update with at least one node", total, action, len(eligible))
		}
	}
}

// The whole reason batches are computed off the FIRST N% of one hash
// ordering, rather than three independent samples, is so that 10% ⊆ 50% ⊆
// 100% -- otherwise a node could be told to update twice and the
// failure-rate denominator would be meaningless. This must hold for a
// realistic node count (137, not a round number, so it can't pass by
// accident of exact divisibility), not just the 20-node unit tests above.
func TestDecideByoBatchesNest(t *testing.T) {
	const n = 137
	nodes := byoNodes(n, "v0.8.0", tNow)

	batchSince := func(byoBatch int) map[string]bool {
		tr := RolloutTrack{
			Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
			ByoBatch: byoBatch, StageStartedAt: tNow - 7*tHour, // window always elapsed
		}
		action, eligible, _ := decideByo(tr, nodes, tNow)
		if action != "update" {
			t.Fatalf("batchSince(%d): action = %q, want update", byoBatch, action)
		}
		set := make(map[string]bool, len(eligible))
		for _, id := range eligible {
			set[id] = true
		}
		return set
	}

	batch10 := batchSince(0)   // opens the 10% batch
	batch50 := batchSince(10)  // opens the 50% batch
	batch100 := batchSince(50) // opens the 100% batch

	wantLens := map[string]int{"10%": pctCount(n, 10), "50%": pctCount(n, 50), "100%": pctCount(n, 100)}
	if len(batch10) != wantLens["10%"] {
		t.Errorf("10%% batch = %d nodes, want %d", len(batch10), wantLens["10%"])
	}
	if len(batch50) != wantLens["50%"] {
		t.Errorf("50%% batch = %d nodes, want %d", len(batch50), wantLens["50%"])
	}
	if len(batch100) != n {
		t.Errorf("100%% batch = %d nodes, want all %d", len(batch100), n)
	}

	for id := range batch10 {
		if !batch50[id] {
			t.Fatalf("node %s is in the 10%% batch but not the 50%% batch: batches are not nested", id)
		}
	}
	for id := range batch50 {
		if !batch100[id] {
			t.Fatalf("node %s is in the 50%% batch but not the 100%% batch: batches are not nested", id)
		}
	}
	if len(batch10) >= len(batch50) || len(batch50) >= len(batch100) {
		t.Fatalf("batches did not strictly grow: 10%%=%d 50%%=%d 100%%=%d", len(batch10), len(batch50), len(batch100))
	}
}
