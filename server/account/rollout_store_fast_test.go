package account

import (
	"context"
	"testing"
)

// ManualFast arrives by ALTER on live databases and rolloutCols is positional,
// so a drift between the SELECT and the upsert would silently swap it with a
// neighbouring column rather than erroring. Round-trip it explicitly, and
// alongside the other flag it sits next to.
func TestRolloutTrackManualFastRoundTrips(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	want := RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", CurrentNodeID: "node7",
		FirstNodeID: "node7", StageStartedAt: 1000, Status: "rolling", ManualFast: true,
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

	// The two flags are independent: a fast rollout is emphatically not an
	// emergency one, and a row must be able to say so.
	want.ManualFast, want.Emergency = false, true
	if err := store.PutRolloutTrack(ctx, want); err != nil {
		t.Fatal(err)
	}
	got, _, _ = store.GetRolloutTrack(ctx, "fleet")
	if got.ManualFast || !got.Emergency {
		t.Fatalf("after flip: ManualFast=%v Emergency=%v, want false/true", got.ManualFast, got.Emergency)
	}
}

// A database that predates the column must read as "staged", which is the only
// safe default: an existing rolling track must not silently start skipping its
// observation windows the moment this ships.
func TestRolloutTrackManualFastDefaultsOffOnMigratedRows(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	// Simulate a row written by the previous schema: every column the old code
	// knew about, none of the new one.
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO node_rollout (track, target_version, status) VALUES ('fleet', 'v0.9.0', 'rolling')`); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil || !ok {
		t.Fatalf("GetRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got.ManualFast {
		t.Fatal("a row written without the column reads as ManualFast=true; staged is the only safe default")
	}
}

// StartManualFastRollout is a compare-and-swap, not a blind write: it is the
// one thing standing between "start a fast rollout" and "silently abandon the
// rollout that is already in flight".
func TestStartManualFastRolloutRefusesARollingTrack(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling",
		CurrentNodeID: "n1", FirstNodeID: "n1", StageStartedAt: 500,
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.StartManualFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 1000)
	if err != nil {
		t.Fatalf("StartManualFastRollout: %v", err)
	}
	if ok {
		t.Fatal("StartManualFastRollout claimed success against a rolling track")
	}
	got, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if got.TargetVersion != "v0.9.0" || got.Status != "rolling" || got.CurrentNodeID != "n1" {
		t.Fatalf("a refused start rewrote the row: %+v", got)
	}
}

func TestStartManualFastRolloutRefusesAHaltedTrack(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "halted", HaltedReason: "node n1 rolled back",
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.StartManualFastRollout(ctx, "fleet", "halted", "v0.9.0", "v1.0.0", 1000)
	if err != nil {
		t.Fatalf("StartManualFastRollout: %v", err)
	}
	if ok {
		t.Fatal("StartManualFastRollout resurrected a halted track; 继续 is the control for that")
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.HaltedReason == "" {
		t.Fatal("a refused start erased the halt reason")
	}
}

// The state the operator was looking at is part of the swap. A track that
// completed a DIFFERENT version since the confirmation page was rendered is a
// stale form, and acting on it is how an operator ships from a page that no
// longer describes the world.
func TestStartManualFastRolloutRefusesAStaleExpectedVersion(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.1", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.StartManualFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 1000)
	if err != nil {
		t.Fatalf("StartManualFastRollout: %v", err)
	}
	if ok {
		t.Fatal("StartManualFastRollout accepted a stale expected version")
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.TargetVersion != "v0.9.1" {
		t.Fatalf("a refused start rewrote the target: %+v", got)
	}
}

func TestStartManualFastRolloutStartsFromAFinishedTrack(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
		CurrentNodeID: "", FirstNodeID: "n3", StageStartedAt: 500,
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.StartManualFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 1000)
	if err != nil || !ok {
		t.Fatalf("StartManualFastRollout: ok=%v err=%v", ok, err)
	}
	got, _, _ := store.GetRolloutTrack(ctx, "fleet")
	if got.Status != "rolling" || got.TargetVersion != "v1.0.0" || !got.ManualFast {
		t.Fatalf("track = %+v, want rolling v1.0.0 in manual-fast mode", got)
	}
	// The previous rollout's positional state belongs to the rollout being
	// replaced; leaving it behind would hand the new canary the old one's
	// identity and skip the fresh least-loaded pick.
	if got.CurrentNodeID != "" || got.FirstNodeID != "" {
		t.Errorf("track kept positional state from the previous rollout: %+v", got)
	}
	if got.HaltedReason != "" || got.Emergency {
		t.Errorf("track = %+v, want no halt reason and emergency off", got)
	}
	if got.StageStartedAt != 1000 {
		t.Errorf("StageStartedAt = %d, want the start instant 1000", got.StageStartedAt)
	}
}

// A track that has never been started has no row at all. Starting one there is
// legitimate — there is no rollout to abandon.
func TestStartManualFastRolloutStartsFromNoRowAtAll(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	ok, err := store.StartManualFastRollout(ctx, "fleet", "", "", "v1.0.0", 1000)
	if err != nil || !ok {
		t.Fatalf("StartManualFastRollout: ok=%v err=%v", ok, err)
	}
	got, found, _ := store.GetRolloutTrack(ctx, "fleet")
	if !found || got.Status != "rolling" || !got.ManualFast {
		t.Fatalf("track = %+v found=%v, want a rolling manual-fast row", got, found)
	}
}

// ...but "no row expected" must not become a way to overwrite a row that
// appeared in between — that is the same abandonment the CAS exists to stop.
func TestStartManualFastRolloutRefusesNoRowExpectedWhenARowExists(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", CurrentNodeID: "n1",
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.StartManualFastRollout(ctx, "fleet", "", "", "v1.0.0", 1000)
	if err != nil {
		t.Fatalf("StartManualFastRollout: %v", err)
	}
	if ok {
		t.Fatal("StartManualFastRollout overwrote a row it expected not to exist")
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.TargetVersion != "v0.9.0" {
		t.Fatalf("row was rewritten: %+v", got)
	}
}

// Starting a rollout is the fourth way a fleet ladder starts or restarts, and
// every one of them has to hand back the candidacy of nodes an earlier rollout
// passed over — an excluded node is never re-commanded, so it can never clear
// its own marker and would sit out every future rollout permanently.
func TestStartManualFastRolloutClearsPassedOverResults(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	u, err := store.UpsertUserByEmail(ctx, "fast@example.test", "F")
	if err != nil {
		t.Fatal(err)
	}
	seedRolloutNode(t, store, "n1", "fleet", "", "v0.9.0", "", "unreachable")
	seedRolloutNode(t, store, "n2", "fleet", "", "v0.9.0", "", "failed")
	seedRolloutNode(t, store, "u1", "user", u.ID, "v0.9.0", "", "skipped")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "complete",
	}); err != nil {
		t.Fatal(err)
	}

	started, err := store.StartManualFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 1000)
	if err != nil || !started {
		t.Fatalf("StartManualFastRollout: ok=%v err=%v", started, err)
	}
	if n, _, _ := store.GetNode(ctx, "n1"); n.UpdateResult != "" {
		t.Errorf("passed-over fleet node kept update_result %q", n.UpdateResult)
	}
	// A failure is the judgement that stopped a track; starting a new rollout
	// carries on past it, but never forgets it.
	if n, _, _ := store.GetNode(ctx, "n2"); n.UpdateResult != "failed" {
		t.Errorf("failed fleet node lost its result: %q", n.UpdateResult)
	}
	// The two tracks are independent: a fleet start must not re-admit a user
	// node the BYO rollout passed over.
	if n, _, _ := store.GetNode(ctx, "u1"); n.UpdateResult != "skipped" {
		t.Errorf("fleet start cleared a user node's result: %q", n.UpdateResult)
	}
}

// The clear and the row write are one transaction. A refused start must leave
// the passed-over markers alone: the panel's finished-but-incomplete count and
// the per-node retry guard are both derived from them, so erasing them on a
// refusal would destroy the report AND the repair affordance while telling the
// operator nothing happened.
func TestStartManualFastRolloutRefusalDoesNotClearPassedOverResults(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	seedRolloutNode(t, store, "n1", "fleet", "", "v0.9.0", "", "unreachable")
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", CurrentNodeID: "n2",
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.StartManualFastRollout(ctx, "fleet", "complete", "v0.9.0", "v1.0.0", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("StartManualFastRollout succeeded against a rolling track")
	}
	if n, _, _ := store.GetNode(ctx, "n1"); n.UpdateResult != "unreachable" {
		t.Fatalf("a refused start cleared a passed-over marker: %q", n.UpdateResult)
	}
}

// Resuming is the staged, careful path. A manual fast rollout that was halted
// must be re-armed explicitly and re-confirmed, never silently by pressing 继续
// — exactly the rule emergency mode already follows.
func TestResumeRolloutTrackDisarmsManualFast(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "halted",
		HaltedReason: "node n1 rolled back", ManualFast: true,
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.ResumeRolloutTrack(ctx, "fleet", 1000)
	if err != nil || !ok {
		t.Fatalf("ResumeRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.ManualFast {
		t.Fatal("继续 silently re-armed manual fast mode")
	}
}

// A finished track is not "手动快速发布中". Leaving the column set would park a
// badge next to 已完成 forever, the same display bug emergency mode had.
func TestCompleteRolloutTrackDisarmsManualFast(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := store.CompleteRolloutTrack(ctx, "fleet", 1000)
	if err != nil || !ok {
		t.Fatalf("CompleteRolloutTrack: ok=%v err=%v", ok, err)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.ManualFast {
		t.Fatal("a completed track still reports manual fast mode")
	}
}

// A halted one, by contrast, KEEPS it: the operator opening the panel after a
// halt has to be able to see which kind of rollout stopped.
func TestHaltRolloutTrackKeepsManualFast(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.HaltRolloutTrack(ctx, "fleet", "node n1 failed", 1000); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); !got.ManualFast {
		t.Fatal("a halted manual-fast track forgot which mode it was in")
	}
}

// SetTargetVersion is the ordinary staged control. Typing a version into it
// must never inherit a fast mode somebody armed earlier.
func TestSetTargetVersionDisarmsManualFast(t *testing.T) {
	svc, store := newRolloutService(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", ManualFast: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetTargetVersion(ctx, "fleet", "v1.0.0"); err != nil {
		t.Fatalf("SetTargetVersion: %v", err)
	}
	if got, _, _ := store.GetRolloutTrack(ctx, "fleet"); got.ManualFast {
		t.Fatal("the ordinary target box inherited manual fast mode")
	}
}
