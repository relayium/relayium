package account

import (
	"context"
	"testing"
)

func TestRolloutTrackRoundTrips(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if _, ok, err := store.GetRolloutTrack(ctx, "fleet"); err != nil || ok {
		t.Fatalf("fresh DB: got ok=%v err=%v, want ok=false err=nil", ok, err)
	}

	want := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", CurrentNodeID: "node7",
		StageStartedAt: 1000, Status: "rolling",
	}
	if err := store.PutRolloutTrack(ctx, want); err != nil {
		t.Fatalf("PutRolloutTrack: %v", err)
	}
	got, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got != want {
		t.Errorf("round trip = %+v, want %+v", got, want)
	}
}

// FirstNodeID is the canary marker the 6h observation window hangs off, and it
// arrives by ALTER on live databases. rolloutCols is positional, so a drift
// between the SELECT and the upsert would silently swap it with a neighbouring
// column instead of erroring — round-trip it explicitly, alone and alongside
// the other string fields.
func TestRolloutTrackFirstNodeIDRoundTrips(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	want := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", CurrentNodeID: "node7",
		FirstNodeID: "canary-node", ByoBatch: 0, StageStartedAt: 1000, Status: "rolling",
	}
	if err := store.PutRolloutTrack(ctx, want); err != nil {
		t.Fatalf("PutRolloutTrack: %v", err)
	}
	got, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got != want {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}

	// And it must be clearable: a new rollout resets the canary.
	want.FirstNodeID = ""
	want.TargetVersion = "v1.0.0"
	if err := store.PutRolloutTrack(ctx, want); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.FirstNodeID != "" {
		t.Errorf("FirstNodeID = %q after being cleared, want empty", got.FirstNodeID)
	}
}

// The two tracks are independent state: a halted BYO track must never be
// readable as, or writable through, the fleet track.
func TestRolloutTracksAreIndependent(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.8.0", Status: "halted", HaltedReason: "failure rate 30%",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
	}); err != nil {
		t.Fatal(err)
	}

	fleet, _, _ := store.GetRolloutTrack(ctx, "fleet")
	byo, _, _ := store.GetRolloutTrack(ctx, "byo")
	if fleet.Status != "rolling" {
		t.Errorf("fleet status = %q, want rolling — a halted BYO track must not affect it", fleet.Status)
	}
	if byo.Status != "halted" {
		t.Errorf("byo status = %q, want halted", byo.Status)
	}
	if fleet.TargetVersion == byo.TargetVersion {
		t.Error("tracks share a target version; they must hold separate ones")
	}
}

// PutRolloutTrack must be a true upsert: calling it twice for the same track
// updates the row in place rather than erroring or leaving stale fields behind.
func TestPutRolloutTrackOverwritesPriorState(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", CurrentNodeID: "node1",
		StageStartedAt: 1000, Status: "rolling",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.1", CurrentNodeID: "node2",
		StageStartedAt: 2000, Status: "halted", HaltedReason: "heartbeat timeout",
	}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: ok=%v err=%v", ok, err)
	}
	want := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.1", CurrentNodeID: "node2",
		StageStartedAt: 2000, Status: "halted", HaltedReason: "heartbeat timeout",
	}
	if got != want {
		t.Errorf("after overwrite = %+v, want %+v", got, want)
	}
}

// The claim is a COMPARE-AND-SWAP, and every part of its WHERE clause is
// load-bearing. Strict "one fleet node at a time" does not follow from
// decideFleet being deterministic: two app instances read the track a moment
// apart and can see different candidate sets (online() is last_seen_at >=
// now-90s and update-check never refreshes last_seen_at), so they legitimately
// pick different nodes. This is the only thing that makes exactly one of those
// picks win.
func TestClaimRolloutNodeIsConditional(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	base := RolloutTrack{Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: 1000}
	if err := store.PutRolloutTrack(ctx, base); err != nil {
		t.Fatal(err)
	}

	// A claim computed from the row as it actually is: lands.
	ok, err := store.ClaimRolloutNode(ctx, "fleet", "", "node-a", "node-a", 2000)
	if err != nil || !ok {
		t.Fatalf("first claim: ok=%v err=%v, want ok=true", ok, err)
	}
	got, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.CurrentNodeID != "node-a" || got.FirstNodeID != "node-a" || got.StageStartedAt != 2000 {
		t.Fatalf("after claim: %+v", got)
	}

	// A second instance whose decision was computed from the PRE-claim row
	// (current_node_id == "") must lose, and must not clobber node-a's claim —
	// which is exactly what a whole-row upsert would do, leaving two nodes both
	// told to install and only one of them recorded.
	ok, err = store.ClaimRolloutNode(ctx, "fleet", "", "node-b", "node-b", 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("a claim computed from stale state must not win")
	}
	got, _, err = store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.CurrentNodeID != "node-a" || got.StageStartedAt != 2000 {
		t.Fatalf("the losing claim overwrote the winner: %+v", got)
	}

	// And a claim must never resurrect a track another instance has halted.
	if ok, err := store.HaltRolloutTrack(ctx, "fleet", "boom", 4000); err != nil || !ok {
		t.Fatalf("halt: ok=%v err=%v", ok, err)
	}
	ok, err = store.ClaimRolloutNode(ctx, "fleet", "node-a", "node-c", "node-a", 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("a claim must not land on a halted track")
	}
	got, _, err = store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "halted" || got.CurrentNodeID != "node-a" {
		t.Fatalf("halted track was resurrected by a claim: %+v", got)
	}
}

// A halt is the one write that must never be lost, so it is conditional too:
// it only fires on a rolling track, and it touches nothing else on the row.
func TestHaltRolloutTrackOnlyHaltsRollingTracks(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", ByoBatch: 50, StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.HaltRolloutTrack(ctx, "byo", "too many failures", 2000)
	if err != nil || !ok {
		t.Fatalf("halt: ok=%v err=%v, want ok=true", ok, err)
	}
	got, _, err := store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "halted" || got.HaltedReason != "too many failures" || got.StageStartedAt != 2000 {
		t.Fatalf("halt did not land: %+v", got)
	}
	// Diagnosis state survives untouched.
	if got.ByoBatch != 50 || got.TargetVersion != "v0.9.0" {
		t.Fatalf("halt clobbered unrelated columns: %+v", got)
	}
	// A second halt (e.g. another instance racing) is a no-op, not a rewrite of
	// the first reason.
	ok, err = store.HaltRolloutTrack(ctx, "byo", "some other reason", 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("halting an already-halted track must report ok=false")
	}
	got, _, err = store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.HaltedReason != "too many failures" {
		t.Fatalf("the original halt reason was overwritten: %+v", got)
	}
}
