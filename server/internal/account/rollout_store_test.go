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

// FINDING 2: PutRolloutTrack is a whole-row upsert, so a caller that forgets
// to carry PreviousVersion forward would otherwise blank it — destroying the
// only thing that makes the BYO self-rollback button work. An omitted
// (empty-string) PreviousVersion on a later call must be a no-op, never a
// wipe of history a previous call recorded.
func TestPutRolloutTrackOmittingPreviousVersionPreservesIt(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", PreviousVersion: "v1.0.0",
		Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	// A hypothetical future caller that patches unrelated fields (here:
	// StageStartedAt) without threading PreviousVersion through at all.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.1.0", Status: "rolling", StageStartedAt: 2000,
	}); err != nil {
		t.Fatal(err)
	}
	got, _, err := store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.PreviousVersion != "v1.0.0" {
		t.Fatalf("PreviousVersion = %q, want the preserved v1.0.0 (an omitted field wiped rollback history)", got.PreviousVersion)
	}
	if got.StageStartedAt != 2000 {
		t.Fatalf("the unrelated field did not update: %+v", got)
	}

	// A caller that explicitly WANTS to set it still can: a non-empty value
	// always wins.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.2.0", PreviousVersion: "v1.1.0",
		Status: "rolling", StageStartedAt: 3000,
	}); err != nil {
		t.Fatal(err)
	}
	got, _, err = store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.PreviousVersion != "v1.1.0" {
		t.Fatalf("an explicit non-empty PreviousVersion was not applied: %+v", got)
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
	ok, err := store.ClaimRolloutNode(ctx, "fleet", "v0.9.0", "", "node-a", "node-a", 2000)
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
	ok, err = store.ClaimRolloutNode(ctx, "fleet", "v0.9.0", "", "node-b", "node-b", 3000)
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
	ok, err = store.ClaimRolloutNode(ctx, "fleet", "v0.9.0", "node-a", "node-c", "node-a", 5000)
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

// CompleteRolloutTrack must not resurrect a track a concurrent instance just
// halted: PutRolloutTrack (the whole-row upsert this replaced) would silently
// write {Status:complete, HaltedReason:""} over the halted row, erasing the
// halt and reporting a stopped-bad release as a success.
func TestCompleteRolloutTrackIsConditional(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", CurrentNodeID: "node-a",
		FirstNodeID: "node-a", Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}

	// The ordinary path: still rolling, completes cleanly and clears
	// current_node_id (nothing is in flight once a track is complete).
	ok, err := store.CompleteRolloutTrack(ctx, "fleet", 2000)
	if err != nil || !ok {
		t.Fatalf("complete: ok=%v err=%v, want ok=true", ok, err)
	}
	got, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "complete" || got.CurrentNodeID != "" || got.StageStartedAt != 2000 {
		t.Fatalf("after complete: %+v", got)
	}
	if got.FirstNodeID != "node-a" {
		t.Fatalf("complete must not touch FirstNodeID (diagnosis state): %+v", got)
	}

	// A second instance racing a "complete" decision against a track that has
	// ALREADY moved on (here: already complete) must not report success again
	// or otherwise touch the row.
	ok, err = store.CompleteRolloutTrack(ctx, "fleet", 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("completing an already-complete track must report ok=false")
	}

	// The dangerous case: a decision computed while rolling, raced against a
	// concurrent halt. The complete write must lose, not resurrect the track.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.8.0", Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if ok, err := store.HaltRolloutTrack(ctx, "byo", "too many failures", 2000); err != nil || !ok {
		t.Fatalf("halt: ok=%v err=%v", ok, err)
	}
	ok, err = store.CompleteRolloutTrack(ctx, "byo", 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("complete must not land on a track another instance already halted")
	}
	got, _, err = store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "halted" || got.HaltedReason != "too many failures" {
		t.Fatalf("a halted track was resurrected as complete, or its reason was lost: %+v", got)
	}
}

// AdvanceByoBatch is the CAS that closes the worst finding in this package: a
// decision computed from a pre-halt read must not both resurrect a halted
// track AND move the batch ladder forward in the same write.
func TestAdvanceByoBatchIsConditional(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", ByoBatch: 10, StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}

	// The ordinary path: still rolling, still at the batch this decision was
	// computed from -- advances cleanly.
	ok, err := store.AdvanceByoBatch(ctx, "byo", "v0.9.0", 10, 50, 2000)
	if err != nil || !ok {
		t.Fatalf("advance: ok=%v err=%v, want ok=true", ok, err)
	}
	got, _, err := store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.ByoBatch != 50 || got.StageStartedAt != 2000 {
		t.Fatalf("after advance: %+v", got)
	}

	// A second instance whose decision was computed from the STALE batch (10)
	// must lose -- the row has already moved to 50.
	ok, err = store.AdvanceByoBatch(ctx, "byo", "v0.9.0", 10, 50, 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("an advance computed from a stale batch must not land")
	}
	got, _, err = store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.ByoBatch != 50 {
		t.Fatalf("the stale advance clobbered the real one: %+v", got)
	}

	// THE reproduction from the review: a batch-advance decision computed
	// while rolling at ByoBatch=50, raced against a concurrent halt, must not
	// resurrect the track NOR move the ladder from 50 to 100.
	if ok, err := store.HaltRolloutTrack(ctx, "byo", "byo rollout: 4/17 nodes in the 50% batch failed", 4000); err != nil || !ok {
		t.Fatalf("halt: ok=%v err=%v", ok, err)
	}
	ok, err = store.AdvanceByoBatch(ctx, "byo", "v0.9.0", 50, 100, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("an advance must not land on a track another instance already halted")
	}
	got, _, err = store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "halted" || got.ByoBatch != 50 {
		t.Fatalf("a halted track was resurrected AND its ladder advanced: %+v", got)
	}
	if got.HaltedReason == "" {
		t.Fatalf("the halt reason was lost: %+v", got)
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

// F3, fleet half: an admin RETARGET is the one row change that leaves
// status='rolling' and an empty current_node_id — i.e. it satisfies every OTHER
// condition of the claim CAS. Without the target_version term, a claim computed
// from the old target still lands: the polling node is answered with the STALE
// target (the response was built from the same read) and installs the old
// version, while the row records it as the NEW rollout's current node. From
// there decideFleet sees a node that is alive, has update_started_at set,
// reported "ok", and is not on target — the plain "wait" branch, with no halt
// and no timeout. The fleet track wedges at 发布中 forever.
func TestClaimRolloutNodeIsScopedToTheTargetItWasComputedFrom(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v0.9.0", Status: "rolling", StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	// The admin retargets between the instance's read and its claim. Still
	// rolling, still no node in flight — only the version moved.
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "fleet", TargetVersion: "v1.0.0", Status: "rolling", StageStartedAt: 1500,
	}); err != nil {
		t.Fatal(err)
	}

	ok, err := store.ClaimRolloutNode(ctx, "fleet", "v0.9.0", "", "node-a", "node-a", 2000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("a claim computed from the previous target must not land on the new rollout")
	}
	got, _, err := store.GetRolloutTrack(ctx, "fleet")
	if err != nil {
		t.Fatal(err)
	}
	if got.CurrentNodeID != "" || got.TargetVersion != "v1.0.0" || got.StageStartedAt != 1500 {
		t.Fatalf("stale claim touched the retargeted row: %+v", got)
	}
	// The same claim recomputed against the current target is fine — the guard
	// is about staleness, not about forbidding claims after a retarget.
	if ok, err := store.ClaimRolloutNode(ctx, "fleet", "v1.0.0", "", "node-a", "node-a", 2000); err != nil || !ok {
		t.Fatalf("claim on the current target: ok=%v err=%v, want ok=true", ok, err)
	}
}

// F3, byo half: the same retarget window, one stroke further along. A stale
// 10->50 advance that lands against the new rollout skips the 10% canary's
// entire observation window AND commands its batch with the version the
// decision was computed from, not the one now targeted. byo_batch is held at 10
// across the retarget here deliberately, so the ONLY thing that can reject the
// write is the target_version term.
func TestAdvanceByoBatchIsScopedToTheTargetItWasComputedFrom(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v0.9.0", Status: "rolling", ByoBatch: 10, StageStartedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRolloutTrack(ctx, RolloutTrack{
		Track: "byo", TargetVersion: "v1.0.0", Status: "rolling", ByoBatch: 10, StageStartedAt: 1500,
	}); err != nil {
		t.Fatal(err)
	}

	ok, err := store.AdvanceByoBatch(ctx, "byo", "v0.9.0", 10, 50, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("an advance computed from the previous target must not open a batch on the new rollout")
	}
	got, _, err := store.GetRolloutTrack(ctx, "byo")
	if err != nil {
		t.Fatal(err)
	}
	if got.ByoBatch != 10 || got.StageStartedAt != 1500 {
		t.Fatalf("stale advance skipped the new rollout's canary window: %+v", got)
	}
	if ok, err := store.AdvanceByoBatch(ctx, "byo", "v1.0.0", 10, 50, 2000); err != nil || !ok {
		t.Fatalf("advance on the current target: ok=%v err=%v, want ok=true", ok, err)
	}
}
