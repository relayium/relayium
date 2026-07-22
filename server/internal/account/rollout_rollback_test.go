package account

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// THE case this exists for. Today's rollback control routes through
// SetTargetVersion, so during a ~14h fleet rollout to a DIFFERENT version the
// gate refuses every byo retarget — including getting BYO off a bad build. The
// recorded previous version already passed the gate when it was set, so rolling
// back to it is admissible no matter what the fleet is doing right now.
func TestByoRollbackToPreviousVersionWhileFleetIsMidRollout(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	// Fleet completed v1.0.0; byo follows it (no previous recorded yet).
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetTargetVersion(ctx, "byo", "v1.0.0"); err != nil {
		t.Fatal(err)
	}
	// Fleet completes v1.1.0; byo follows, recording v1.0.0 as its previous.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.1.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetTargetVersion(ctx, "byo", "v1.1.0"); err != nil {
		t.Fatal(err)
	}
	// Now the fleet is mid-rollout to a THIRD version. A plain retarget of byo
	// to v1.0.0 is refused by the gate...
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.2.0", Status: "rolling",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetTargetVersion(ctx, "byo", "v1.0.0"); !errors.Is(err, ErrByoAheadOfFleet) {
		t.Fatalf("precondition: plain retarget should be gated, got %v", err)
	}

	// ...but the rollback to the RECORDED previous version must succeed.
	got, err := svc.RollbackByoToPreviousVersion(ctx)
	if err != nil {
		t.Fatalf("RollbackByoToPreviousVersion while the fleet is mid-rollout: %v", err)
	}
	if got != "v1.0.0" {
		t.Fatalf("rolled back to %q, want v1.0.0", got)
	}
	byo, ok, err := store.GetRolloutTrack(ctx, "byo")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack(byo) = %v/%v", ok, err)
	}
	if byo.TargetVersion != "v1.0.0" || byo.Status != "rolling" {
		t.Fatalf("byo row = %+v, want v1.0.0 rolling", byo)
	}
	// The version we came off becomes the new previous — it too passed the gate
	// when it was set, so the invariant still holds.
	if byo.PreviousVersion != "v1.1.0" {
		t.Fatalf("byo.PreviousVersion = %q, want v1.1.0", byo.PreviousVersion)
	}
}

// No history recorded -> refuse legibly, do not 500 and do not silently no-op.
func TestByoRollbackRefusedWithoutARecordedPreviousVersion(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	// Track has never been started at all.
	if _, err := svc.RollbackByoToPreviousVersion(ctx); !errors.Is(err, ErrNoPreviousByoVersion) {
		t.Fatalf("err = %v, want ErrNoPreviousByoVersion", err)
	}

	// Track exists but is on its FIRST target, so there is nothing behind it.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetTargetVersion(ctx, "byo", "v1.0.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RollbackByoToPreviousVersion(ctx); !errors.Is(err, ErrNoPreviousByoVersion) {
		t.Fatalf("err = %v, want ErrNoPreviousByoVersion", err)
	}
	byo, _, _ := store.GetRolloutTrack(ctx, "byo")
	if byo.TargetVersion != "v1.0.0" || byo.Status != "rolling" {
		t.Fatalf("a refused rollback mutated the track: %+v", byo)
	}
}

// A rollback resets exactly the positional/staging state a normal retarget
// resets. Skipping any of these resurrects bugs earlier reviews found: a
// surviving ByoBatch re-halts the rollout permanently, a stale StageStartedAt
// collapses the observation window, and an inherited Emergency ships the
// rollback to every user machine at once.
func TestByoRollbackResetsEveryFieldARetargetResets(t *testing.T) {
	svc, store := newRolloutService(t)
	svc.now = func() time.Time { return time.Unix(99000, 0) }
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", PreviousVersion: "v1.0.0",
		Status: "halted", HaltedReason: "byo rollout: 4/5 nodes failed",
		ByoBatch: 50, CurrentNodeID: "byo-a", FirstNodeID: "byo-a",
		StageStartedAt: 1000, Emergency: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RollbackByoToPreviousVersion(ctx); err != nil {
		t.Fatal(err)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "byo")
	want := RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", PreviousVersion: "v1.1.0",
		Status: "rolling", StageStartedAt: 99000,
	}
	if got != want {
		t.Fatalf("rollback left stale state:\n got %+v\nwant %+v", got, want)
	}
}

// The rollback action must be a fixed destination, never an operator-supplied
// one: a version box on it would be a general gate bypass.
func TestByoRollbackCannotReachAnArbitraryVersion(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", PreviousVersion: "v1.0.0",
		Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	_ = svc

	// A version field on the request is ignored; the recorded previous wins.
	resp := postAdminForm(t, ts, cookie, "/admin/rollout/byo/rollback-previous",
		url.Values{"version": {"v9.9.9"}})
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("want 302, got %d\n%s", resp.StatusCode, body)
	}
	byo, _, _ := store.GetRolloutTrack(ctx, "byo")
	if byo.TargetVersion != "v1.0.0" {
		t.Fatalf("byo target = %q, want the recorded v1.0.0 (arbitrary version accepted!)", byo.TargetVersion)
	}

	// And it is a BYO-only route: the fleet has no such action.
	resp = postAdminForm(t, ts, cookie, "/admin/rollout/fleet/rollback-previous", url.Values{})
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("fleet rollback-previous: want 404, got %d", resp.StatusCode)
	}
}

// Refusal must reach the operator as readable text, and the button must not be
// rendered at all when there is nothing to roll back to.
func TestByoRollbackButtonAndRefusalInAdminUI(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	body := getAdminHome(t, ts, cookie)
	if strings.Contains(body, `action="/admin/rollout/byo/rollback-previous"`) {
		t.Fatal("the rollback-to-previous button is rendered with no previous version recorded")
	}
	resp := postAdminForm(t, ts, cookie, "/admin/rollout/byo/rollback-previous", url.Values{})
	body = readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d\n%s", resp.StatusCode, body)
	}
	if !strings.Contains(body, "回滚到上一版本失败") {
		t.Fatalf("refusal not legible on the page:\n%s", body)
	}

	// With a previous version recorded, the control appears and names it.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", PreviousVersion: "v1.0.0",
		Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	body = getAdminHome(t, ts, cookie)
	if !strings.Contains(body, `action="/admin/rollout/byo/rollback-previous"`) {
		t.Fatalf("rollback-to-previous button missing:\n%s", body)
	}
	if !strings.Contains(body, "回滚到上一版本（v1.0.0）") {
		t.Fatal("the rollback button does not name the version it would go to")
	}
}
