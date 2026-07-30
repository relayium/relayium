package account

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// seedByoGateCase sets the fleet track complete at target and returns the
// service. Nodes are seeded by the caller, because what varies between these
// cases is exactly which fleet machines actually ran the build.
func seedByoGateCase(t *testing.T, target string) (*Service, *SQLiteStore) {
	t.Helper()
	svc, store := newRolloutService(t)
	if err := store.PutRolloutTrack(context.Background(), RolloutTrack{
		Track: "fleet", TargetVersion: target, Status: "complete", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	return svc, store
}

// The gate this task exists to close. "complete" means the QUEUE ran out of
// candidates, not that anything installed: with passing-over fixed, a release
// published with a broken asset is a fetch failure on every fleet node, all are
// passed over, and the track completes on a version no machine we own ever ran a
// byte of. The gate's own doc calls the fleet-first ordering "the entire
// justification for auto-updating machines we don't own", so admitting that
// version onto user machines is the exact failure it is there to prevent.
func TestByoGateRefusesAVersionNoFleetNodeRan(t *testing.T) {
	svc, store := seedByoGateCase(t, "v2.0.0")
	ctx := context.Background()

	seedRolloutNode(t, store, "f1", "fleet", "", "v1.0.0", "v1.0.0", "unreachable")
	seedRolloutNode(t, store, "f2", "fleet", "", "v1.0.0", "v1.0.0", "unreachable")

	err := svc.SetTargetVersion(ctx, "byo", "v2.0.0")
	if !errors.Is(err, ErrByoAheadOfFleet) {
		t.Fatalf("err = %v, want ErrByoAheadOfFleet — the fleet track completed without installing anything", err)
	}
	// And the byo track must be untouched, not half-written.
	if _, ok, err := store.GetRolloutTrack(ctx, "byo"); err != nil {
		t.Fatal(err)
	} else if ok {
		t.Fatal("a refused byo retarget wrote the byo track row anyway")
	}
}

// The positive case, which matters just as much: a suite of refusals passes
// against a gate that refuses everything. One fleet machine actually running the
// build is what the ordering property means, so the same call must succeed.
func TestByoGateAdmitsAVersionAFleetNodeActuallyRan(t *testing.T) {
	svc, store := seedByoGateCase(t, "v2.0.0")
	ctx := context.Background()

	seedRolloutNode(t, store, "f1", "fleet", "", "v2.0.0", "v1.0.0", "ok")
	seedRolloutNode(t, store, "f2", "fleet", "", "v1.0.0", "v1.0.0", "unreachable")

	if err := svc.SetTargetVersion(ctx, "byo", "v2.0.0"); err != nil {
		t.Fatalf("SetTargetVersion(byo, v2.0.0) with a fleet node on v2.0.0: %v", err)
	}
	tr, ok, err := store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || tr.TargetVersion != "v2.0.0" || tr.Status != "rolling" {
		t.Fatalf("byo track = %+v (ok=%v), want v2.0.0 rolling", tr, ok)
	}
}

// One node is the bar, not a proportion. The question the gate asks is "did a
// machine we own actually run this build", which is a yes/no; a percentage would
// be a threshold to tune with no principled value on a six-machine fleet.
func TestByoGateNeedsOnlyOneFleetNodeOnTheVersion(t *testing.T) {
	svc, store := seedByoGateCase(t, "v2.0.0")
	ctx := context.Background()

	seedRolloutNode(t, store, "f1", "fleet", "", "v2.0.0", "v1.0.0", "ok")
	for _, id := range []string{"f2", "f3", "f4", "f5"} {
		seedRolloutNode(t, store, id, "fleet", "", "v1.0.0", "v1.0.0", "unreachable")
	}

	if err := svc.SetTargetVersion(ctx, "byo", "v2.0.0"); err != nil {
		t.Fatalf("one fleet node on the target is the bar and it was met: %v", err)
	}
}

// An empty fleet has certified nothing. Without this case the check could be
// written as "no node contradicts the version" and still pass everything above.
func TestByoGateRefusesAnEmptyFleet(t *testing.T) {
	svc, _ := seedByoGateCase(t, "v2.0.0")

	err := svc.SetTargetVersion(context.Background(), "byo", "v2.0.0")
	if !errors.Is(err, ErrByoAheadOfFleet) {
		t.Fatalf("err = %v, want ErrByoAheadOfFleet — an empty fleet has certified nothing", err)
	}
}

// A USER node running the version certifies nothing: the gate is about machines
// we own. Without this, counting over the wrong owner class would let the byo
// track bootstrap itself off its own nodes.
func TestByoGateIgnoresUserNodesOnTheVersion(t *testing.T) {
	svc, store := seedByoGateCase(t, "v2.0.0")
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "gate@example.test", "G")
	if err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, store, "u1", "user", u.ID, "v2.0.0", "v1.0.0", "ok")

	if err := svc.SetTargetVersion(ctx, "byo", "v2.0.0"); !errors.Is(err, ErrByoAheadOfFleet) {
		t.Fatalf("err = %v, want ErrByoAheadOfFleet — a user node cannot certify a build for user nodes", err)
	}
}

// The two refusals send an operator to different places -- "the fleet has not
// finished" means wait, "nothing actually ran it" means go look at why every
// machine passed over -- so the message must say which condition failed.
func TestByoGateMessagesDistinguishTheTwoRefusals(t *testing.T) {
	ctx := context.Background()

	svcRolling, storeRolling := newRolloutService(t)
	if err := storeRolling.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v2.0.0", Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, storeRolling, "f1", "fleet", "", "v2.0.0", "v1.0.0", "ok")
	notComplete := svcRolling.SetTargetVersion(ctx, "byo", "v2.0.0")

	svcNoRun, storeNoRun := seedByoGateCase(t, "v2.0.0")
	seedRolloutNode(t, storeNoRun, "f1", "fleet", "", "v1.0.0", "v1.0.0", "unreachable")
	nothingRan := svcNoRun.SetTargetVersion(ctx, "byo", "v2.0.0")

	if notComplete == nil || nothingRan == nil {
		t.Fatalf("both cases must be refused: notComplete=%v nothingRan=%v", notComplete, nothingRan)
	}
	if notComplete.Error() == nothingRan.Error() {
		t.Fatalf("both refusals read identically (%q), so the operator cannot tell which condition failed",
			notComplete.Error())
	}
	if !strings.Contains(nothingRan.Error(), "no fleet node") {
		t.Errorf("the nothing-ran refusal does not say so: %q", nothingRan.Error())
	}
}
