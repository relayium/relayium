package account

import (
	"context"
	"errors"
	"testing"
)

// newRolloutService builds the plainest *Service that has a real SQLite store
// behind it, following the simplest existing pattern in this package (see
// config_test.go / admin_test.go's nil-mailer constructions) rather than the
// heavier HTTP-server helpers used by files_test.go.
func newRolloutService(t *testing.T) (*Service, *SQLiteStore) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, nil, Config{})
	return svc, store
}

// The whole point of the two-track split: user nodes stuck on a bad version
// must never stop us shipping the next fleet release.
func TestHaltedByoTrackDoesNotBlockFleetTarget(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.8.0", Status: "halted", HaltedReason: "failure rate 30%",
	}); err != nil {
		t.Fatal(err)
	}

	if err := svc.SetTargetVersion(ctx, "fleet", "v0.9.0"); err != nil {
		t.Fatalf("setting a fleet target while BYO is halted: %v — BYO must never block the fleet", err)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if got.TargetVersion != "v0.9.0" || got.Status != "rolling" {
		t.Errorf("fleet track = %+v, want v0.9.0 rolling", got)
	}
}

// Our own fleet is the canary for user machines.
func TestByoCannotTargetAVersionTheFleetHasNotFinished(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
	}); err != nil {
		t.Fatal(err)
	}

	err := svc.SetTargetVersion(ctx, "byo", "v0.9.0")
	if !errors.Is(err, ErrByoAheadOfFleet) {
		t.Errorf("err = %v, want ErrByoAheadOfFleet — user machines must not lead our own fleet", err)
	}
}

func TestByoMayTargetAVersionTheFleetCompleted(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetTargetVersion(ctx, "byo", "v0.9.0"); err != nil {
		t.Errorf("SetTargetVersion(byo, v0.9.0) after the fleet completed it: %v", err)
	}
}

// Fix-forward: a stuck BYO track jumps straight to the newest fleet-completed
// version rather than being made to replay the bad one.
func TestHaltedByoTrackMayJumpToANewerCompletedVersion(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.8.0", Status: "halted",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}

	if err := svc.SetTargetVersion(ctx, "byo", "v0.9.0"); err != nil {
		t.Fatalf("halted BYO track jumping to v0.9.0: %v", err)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "byo")
	if got.Status != "rolling" {
		t.Errorf("byo status = %q after a new target, want rolling (the halt is cleared)", got.Status)
	}
}
