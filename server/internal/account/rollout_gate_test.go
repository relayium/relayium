package account

import (
	"context"
	"errors"
	"testing"
	"time"
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
	got, ok, err := store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || got.TargetVersion != "v0.9.0" || got.Status != "rolling" {
		t.Errorf("byo row = %+v (ok=%v), want TargetVersion v0.9.0, Status rolling", got, ok)
	}
}

// The version half of the gate must be exercised on its own: fleet complete
// at a DIFFERENT version must still be rejected. Without this, dropping the
// SameVersion term from the guard (leaving only the Status check) would pass
// every existing test.
func TestByoCannotTargetADifferentVersionThanTheFleetCompleted(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}

	err := svc.SetTargetVersion(ctx, "byo", "v0.10.0")
	if !errors.Is(err, ErrByoAheadOfFleet) {
		t.Errorf("err = %v, want ErrByoAheadOfFleet — fleet completed v0.9.0, not v0.10.0", err)
	}
}

// Unknown/differently-cased track names must be rejected, not silently
// written as a brand-new row that bypasses the gate.
func TestSetTargetVersionRejectsUnknownTrackNames(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	for _, track := range []string{"nonsense", "BYO", "Fleet", "FLEET", ""} {
		if err := svc.SetTargetVersion(ctx, track, "v0.9.0"); err == nil {
			t.Errorf("SetTargetVersion(%q, v0.9.0) = nil, want an error", track)
		}
		if _, ok, err := store.GetRolloutTrack(ctx, track); err != nil {
			t.Fatal(err)
		} else if ok {
			t.Errorf("SetTargetVersion(%q, ...) wrote a row for track %q, want no row", track, track)
		}
	}
}

// An empty version must be rejected, not persisted: decideFleet/decideByo's
// empty-target guards would otherwise wedge the track in "wait" forever with
// no halt and no error — silent and permanent.
func TestSetTargetVersionRejectsEmptyVersion(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	for _, track := range []string{"fleet", "byo"} {
		if err := svc.SetTargetVersion(ctx, track, ""); err == nil {
			t.Errorf("SetTargetVersion(%q, \"\") = nil, want an error", track)
		}
		if _, ok, err := store.GetRolloutTrack(ctx, track); err != nil {
			t.Fatal(err)
		} else if ok {
			t.Errorf("SetTargetVersion(%q, \"\") wrote a row, want none", track)
		}
	}
}

// Non-empty junk (not a plain vMAJOR.MINOR.PATCH tag) must also be rejected
// up front rather than reaching the store, where it would burn a canary node
// before the node updater's own flag-parse check eventually halts the track.
func TestSetTargetVersionRejectsNonPlainVersion(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	for _, v := range []string{"latest", "dev", "v0.9", "v0.9.0-rc1"} {
		if err := svc.SetTargetVersion(ctx, "fleet", v); err == nil {
			t.Errorf("SetTargetVersion(fleet, %q) = nil, want an error", v)
		}
	}
	if _, ok, err := store.GetRolloutTrack(ctx, "fleet"); err != nil {
		t.Fatal(err)
	} else if ok {
		t.Error("a rejected junk version was written to the fleet row, want none")
	}
}

// SetTargetVersion replaces the WHOLE row, so a new target must reset every
// field that carries state from the previous rollout — a future refactor to
// a read-modify-write patch would keep every other test in this file green
// while silently resurrecting three bugs (see the doc comment above
// SetTargetVersion): a surviving ByoBatch re-halts a restarted BYO rollout
// forever, a surviving FirstNodeID cuts the fleet's 6h canary window to
// 30min, and a stale StageStartedAt collapses the observation window.
func TestSetTargetVersionResetsAllPositionalState(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	base := time.Unix(1_700_000_000, 0)
	svc.now = func() time.Time { return base }

	dirty := RolloutTrack{
		Track:          "fleet",
		TargetVersion:  "v0.8.0",
		Status:         "halted",
		HaltedReason:   "failure rate 30%",
		ByoBatch:       50,
		CurrentNodeID:  "node-old-current",
		FirstNodeID:    "node-old-first",
		StageStartedAt: 1, // deliberately stale
	}
	if err := store.PutRolloutTrack(ctx, dirty); err != nil {
		t.Fatal(err)
	}

	if err := svc.SetTargetVersion(ctx, "fleet", "v0.9.0"); err != nil {
		t.Fatalf("SetTargetVersion(fleet, v0.9.0): %v", err)
	}

	got, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("no fleet row after SetTargetVersion")
	}
	want := RolloutTrack{
		Track:          "fleet",
		TargetVersion:  "v0.9.0",
		Status:         "rolling",
		HaltedReason:   "",
		ByoBatch:       0,
		CurrentNodeID:  "",
		FirstNodeID:    "",
		StageStartedAt: base.Unix(),
	}
	if got != want {
		t.Errorf("fleet row = %+v, want %+v", got, want)
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
