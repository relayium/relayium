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
