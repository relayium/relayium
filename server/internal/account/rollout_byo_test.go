package account

import (
	"fmt"
	"testing"
)

func byoNodes(n int, ver string, seen int64) []NodeSnapshot {
	out := make([]NodeSnapshot, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, NodeSnapshot{ID: string(rune('a' + i)), Version: ver, LastSeenAt: seen})
	}
	return out
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

// One flaky user machine is normal, not a signal — halting on it would leave
// the BYO track permanently stuck.
func TestDecideByoToleratesASingleFailure(t *testing.T) {
	nodes := byoNodes(20, "v0.9.0", tNow)
	nodes[0].UpdateResult = "rolled_back"
	nodes[0].Version = "v0.8.0"
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - 7*tHour,
	}

	action, _, _ := decideByo(tr, nodes, tNow)
	if action == "halt" {
		t.Error("action = halt on a single BYO failure; want the rollout to continue")
	}
}

func TestDecideByoHaltsAboveFailureRate(t *testing.T) {
	nodes := byoNodes(20, "v0.9.0", tNow)
	for i := 0; i < 5; i++ { // 25% > 20% threshold, and >= 2 absolute
		nodes[i].UpdateResult = "failed"
		nodes[i].Version = "v0.8.0"
	}
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 50, StageStartedAt: tNow - 7*tHour,
	}

	action, _, reason := decideByo(tr, nodes, tNow)
	if action != "halt" {
		t.Fatalf("action = %q with a 25%% failure rate, want halt", action)
	}
	if reason == "" {
		t.Error("halt with no reason; admin needs to know why")
	}
}

func TestDecideByoAdvancesBatchesAfterWindow(t *testing.T) {
	nodes := byoNodes(20, "v0.9.0", tNow)
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - 7*tHour,
	}
	action, eligible, _ := decideByo(tr, nodes, tNow)
	if action != "update" || len(eligible) == 0 {
		t.Fatalf("action=%q eligible=%d, want the 50%% batch to open", action, len(eligible))
	}
}

func TestDecideByoWaitsInsideWindow(t *testing.T) {
	nodes := byoNodes(20, "v0.9.0", tNow)
	tr := RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling",
		ByoBatch: 10, StageStartedAt: tNow - tHour,
	}
	if action, _, _ := decideByo(tr, nodes, tNow); action != "wait" {
		t.Errorf("action = %q one hour into a 6h batch window, want wait", action)
	}
}

// byoNodesWithIDs builds nodes with longer, distinct IDs (unlike byoNodes'
// single letters, which top out well before any realistic BYO fleet size).
func byoNodesWithIDs(n int, ver string, seen int64) []NodeSnapshot {
	out := make([]NodeSnapshot, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, NodeSnapshot{ID: fmt.Sprintf("byo-node-%04d", i), Version: ver, LastSeenAt: seen})
	}
	return out
}

// The whole reason batches are computed off the FIRST N% of one hash
// ordering, rather than three independent samples, is so that 10% ⊆ 50% ⊆
// 100% -- otherwise a node could be told to update twice and the
// failure-rate denominator would be meaningless. This must hold for a
// realistic node count (137, not a round number, so it can't pass by
// accident of exact divisibility), not just the 20-node unit tests above.
func TestDecideByoBatchesNest(t *testing.T) {
	const n = 137
	nodes := byoNodesWithIDs(n, "v0.8.0", tNow)

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
