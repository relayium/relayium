package account

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

func mkUploadRow(id, user string) UploadSessionRow {
	return UploadSessionRow{
		ID: id, UserID: user, BlobKey: "blob-" + id, NodeID: "",
		Billable: true, EncManifest: []byte("m"), TTL: 3600, MaxDL: 0,
		MaxSize: 1 << 20, Received: 0, CreatedAt: 1000,
	}
}

// The session is durable, shared state: create it, read it back with all fields,
// advance the offset MONOTONICALLY (a stale/lower write is a no-op), and claim
// `done` exactly once.
func TestUploadSessionStoreLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "up@example.com", "U")
	row := mkUploadRow("up1", u.ID)

	if ok, err := st.CreateUploadSession(ctx, row, maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("create: ok=%v err=%v", ok, err)
	}
	got, ok, err := st.GetUploadSession(ctx, "up1", u.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.BlobKey != "blob-up1" || !got.Billable || got.MaxSize != 1<<20 || string(got.EncManifest) != "m" {
		t.Fatalf("row did not round-trip: %+v", got)
	}
	// Ownership gate: another user can't see it.
	if _, ok, _ := st.GetUploadSession(ctx, "up1", "someone-else"); ok {
		t.Fatal("a session must not be visible to a non-owner")
	}

	// Monotonic advance, and the meter follows it byte for byte.
	advance := func(to int64) {
		t.Helper()
		if _, err := st.CommitUploadProgress(ctx, UploadProgress{
			SessionID: "up1", UserID: u.ID, Committed: to, Billable: true, Now: 2000,
		}); err != nil {
			t.Fatalf("commit progress to %d: %v", to, err)
		}
	}
	advance(100)
	advance(50) // stale — must not lower, and must not bill
	got, _, _ = st.GetUploadSession(ctx, "up1", u.ID)
	if got.Received != 100 {
		t.Fatalf("received: want 100 (monotonic), got %d", got.Received)
	}
	advance(200)
	got, _, _ = st.GetUploadSession(ctx, "up1", u.ID)
	if got.Received != 200 {
		t.Fatalf("received: want 200, got %d", got.Received)
	}
	// Billed exactly the bytes the offset moved by, not once per call: the delta
	// is derived from the row inside the transaction, so a stale or duplicated
	// commit is free.
	if got.Metered != 200 {
		t.Fatalf("metered: want 200 (the bytes the offset actually moved), got %d", got.Metered)
	}
	if up, _, _ := st.MonthlyUsage(ctx, u.ID, periodOf(2000)); up != 200 {
		t.Fatalf("monthly upload traffic: want 200, got %d", up)
	}

	// Claim done returns the offset at claim time, and is one-shot. It bills
	// nothing here because every append already did.
	rec, billed, ok, err := st.ClaimUploadDone(ctx, "up1", 2000)
	if err != nil || !ok || rec != 200 || billed != 0 {
		t.Fatalf("claim: rec=%d billed=%d ok=%v err=%v", rec, billed, ok, err)
	}
	if _, _, ok, _ := st.ClaimUploadDone(ctx, "up1", 2000); ok {
		t.Fatal("a second finalize/reap must not re-claim the session")
	}
	// A finalized session no longer advances (append after finalize is a no-op),
	// and bills nothing more.
	advance(999)
	got, _, _ = st.GetUploadSession(ctx, "up1", u.ID)
	if got.Received != 200 {
		t.Fatalf("a done session must not advance: got %d", got.Received)
	}
	if up, _, _ := st.MonthlyUsage(ctx, u.ID, periodOf(2000)); up != 200 {
		t.Fatalf("a done session billed more traffic: %d, want 200", up)
	}
}

// Every accepted byte is billed exactly once no matter how many appends raced to
// commit it. The delta lives inside the transaction precisely so that two
// requests reporting the same authoritative size cannot each bill it.
func TestCommitUploadProgressBillsEachByteOnceUnderConcurrency(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "concurrent@example.com", "C")
	_, _ = st.CreateUploadSession(ctx, mkUploadRow("cc1", u.ID), maxSessionsPerUser)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Every caller reports the SAME blob size, as duplicated PATCHes of one
			// chunk do: the first advances the offset, the rest must be free.
			_, _ = st.CommitUploadProgress(ctx, UploadProgress{
				SessionID: "cc1", UserID: u.ID, Committed: 4096, Billable: true, Now: 2000,
			})
		}()
	}
	wg.Wait()
	if up, _, _ := st.MonthlyUsage(ctx, u.ID, periodOf(2000)); up != 4096 {
		t.Fatalf("16 commits of the same 4096-byte offset billed %d bytes, want 4096", up)
	}
}

// The write cap is a clamp, not a refusal. A chunk that overshoots the file-size
// cap still committed bytes to the blob, and refusing to advance at all (as this
// once did) left them unbilled — while a node lying about the size still cannot
// charge the account past the budget the server itself authorized.
func TestCommitUploadProgressClampsToMaxSizeAndBillsTheClampedBytes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "clamp2@example.com", "C")
	row := mkUploadRow("clamp2", u.ID)
	row.MaxSize = 1000
	_, _ = st.CreateUploadSession(ctx, row, maxSessionsPerUser)

	if _, err := st.CommitUploadProgress(ctx, UploadProgress{
		SessionID: "clamp2", UserID: u.ID, Committed: 5_000_000, Billable: true, Now: 2000,
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	got, _, _ := st.GetUploadSession(ctx, "clamp2", u.ID)
	if got.Received != 1000 {
		t.Fatalf("received = %d, want the max_size clamp 1000", got.Received)
	}
	if up, _, _ := st.MonthlyUsage(ctx, u.ID, periodOf(2000)); up != 1000 {
		t.Fatalf("billed %d, want the 1000 clamped bytes — no more (a lying node) and no less (an overshoot)", up)
	}
}

// An own-node upload spends the user's own disk and is never metered against a
// plan; it must still track its offset.
func TestCommitUploadProgressDoesNotMeterOwnNodeUploads(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "byo@example.com", "B")
	row := mkUploadRow("byo1", u.ID)
	row.Billable = false
	_, _ = st.CreateUploadSession(ctx, row, maxSessionsPerUser)

	if _, err := st.CommitUploadProgress(ctx, UploadProgress{
		SessionID: "byo1", UserID: u.ID, Committed: 700, Billable: false, Now: 2000,
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	got, _, _ := st.GetUploadSession(ctx, "byo1", u.ID)
	if got.Received != 700 {
		t.Fatalf("received = %d, want 700", got.Received)
	}
	if up, _, _ := st.MonthlyUsage(ctx, u.ID, periodOf(2000)); up != 0 {
		t.Fatalf("an own-node upload was metered: %d", up)
	}
	// ...and reconciling one bills nothing either.
	if billed, err := st.ReconcileUploadMeter(ctx, "byo1", 2000); err != nil || billed != 0 {
		t.Fatalf("reconcile of an own-node session billed %d (err %v)", billed, err)
	}
}

// ReconcileUploadMeter is the last-chance bill for committed bytes no append
// recorded, and it is idempotent — every way a session can end calls it, so a
// second call must be free.
func TestReconcileUploadMeterIsExactlyOnce(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "recon@example.com", "R")
	row := mkUploadRow("recon1", u.ID)
	row.Received = 3000 // bytes committed by an append that crashed before billing
	_, _ = st.CreateUploadSession(ctx, row, maxSessionsPerUser)

	billed, err := st.ReconcileUploadMeter(ctx, "recon1", 2000)
	if err != nil || billed != 3000 {
		t.Fatalf("reconcile billed %d (err %v), want the 3000 unmetered bytes", billed, err)
	}
	billed, err = st.ReconcileUploadMeter(ctx, "recon1", 2000)
	if err != nil || billed != 0 {
		t.Fatalf("a second reconcile billed %d again (err %v)", billed, err)
	}
	if up, _, _ := st.MonthlyUsage(ctx, u.ID, periodOf(2000)); up != 3000 {
		t.Fatalf("monthly upload traffic = %d, want 3000 charged exactly once", up)
	}
}

// Concurrent ClaimUploadDone (a finalize racing the reaper, or two instances)
// lets exactly one caller win.
func TestUploadSessionClaimDoneConcurrent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "race@example.com", "R")
	_, _ = st.CreateUploadSession(ctx, mkUploadRow("race1", u.ID), maxSessionsPerUser)

	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, ok, err := st.ClaimUploadDone(ctx, "race1", 2000); err == nil && ok {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if won != 1 {
		t.Fatalf("exactly one concurrent finalize/reap may win, got %d", won)
	}
}

// The per-user open-session cap is enforced at the store, and a finalized
// (deleted) session frees a slot.
func TestUploadSessionCapAtStore(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "cap@example.com", "C")
	for i := 0; i < maxSessionsPerUser; i++ {
		if ok, err := st.CreateUploadSession(ctx, mkUploadRow(fmt.Sprintf("s%d", i), u.ID), maxSessionsPerUser); err != nil || !ok {
			t.Fatalf("create %d: ok=%v err=%v", i, ok, err)
		}
	}
	if ok, _ := st.CreateUploadSession(ctx, mkUploadRow("over", u.ID), maxSessionsPerUser); ok {
		t.Fatal("must reject once the per-user cap is reached")
	}
	// Finalize (claim + delete) one → a slot frees up.
	_, _, _, _ = st.ClaimUploadDone(ctx, "s0", 2000)
	_ = st.DeleteUploadSession(ctx, "s0")
	if ok, err := st.CreateUploadSession(ctx, mkUploadRow("after", u.ID), maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("a freed slot must accept a new session: ok=%v err=%v", ok, err)
	}
}

// The reaper lists only still-open, sufficiently-old sessions.
func TestListExpiredOpenUploadSessions(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "reap@example.com", "R")
	old := mkUploadRow("old", u.ID)
	old.CreatedAt = 100
	fresh := mkUploadRow("fresh", u.ID)
	fresh.CreatedAt = 10000
	_, _ = st.CreateUploadSession(ctx, old, maxSessionsPerUser)
	_, _ = st.CreateUploadSession(ctx, fresh, maxSessionsPerUser)

	rows, err := st.ListExpiredOpenUploadSessions(ctx, 5000) // before=5000
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != "old" {
		t.Fatalf("want only the old open session, got %+v", rows)
	}
	// A done session is never reaped (it was finalized; its blob is kept).
	_, _, _, _ = st.ClaimUploadDone(ctx, "old", 2000)
	rows, _ = st.ListExpiredOpenUploadSessions(ctx, 5000)
	if len(rows) != 0 {
		t.Fatalf("a done session must not be reaped, got %+v", rows)
	}
}

// ---------------------------------------------------------------------------
// The recovery state: a session whose blob nothing could reach is durable
// accounting evidence, not a settled bill.
// ---------------------------------------------------------------------------

// mkUnresolved creates a session that committed `received` bytes (all billed)
// and then landed in the recovery state, and returns the store and its user.
func mkUnresolved(t *testing.T, id string, received int64) (*SQLiteStore, string) {
	t.Helper()
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "unresolved@example.com", "U")
	row := mkUploadRow(id, u.ID)
	row.CreatedAt = 1000
	if ok, err := st.CreateUploadSession(ctx, row, maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("create: ok=%v err=%v", ok, err)
	}
	if _, err := st.CommitUploadProgress(ctx, UploadProgress{
		SessionID: id, UserID: u.ID, Committed: received, Billable: true, Now: 1100,
	}); err != nil {
		t.Fatalf("commit progress: %v", err)
	}
	ok, err := st.MarkUploadUnresolved(ctx, id, 1200)
	if err != nil || !ok {
		t.Fatalf("mark unresolved: ok=%v err=%v", ok, err)
	}
	return st, u.ID
}

// Nothing that reclaims may touch a row in the recovery state. Both passes below
// are how the evidence would be destroyed WITHOUT anyone deciding to write the
// bytes off: the purge deletes the row that records the lower bound, and the
// orphan pass deletes the blob that is the only thing which can ever produce
// the exact number.
func TestUnresolvedUploadEvidenceSurvivesEveryReclaimingPass(t *testing.T) {
	ctx := context.Background()
	st, userID := mkUnresolved(t, "unres1", 4000)

	// Ten years later. `metered >= received` is true — everything the database
	// knows about IS billed — so an age-plus-settled rule would delete this.
	const farFuture = 1000 + 3650*86400
	if err := st.PurgeDoneUploadSessions(ctx, farFuture); err != nil {
		t.Fatalf("purge: %v", err)
	}
	got, ok, err := st.GetUploadSession(ctx, "unres1", userID)
	if err != nil || !ok {
		t.Fatalf("the purge treated unresolved evidence as a settled row: ok=%v err=%v", ok, err)
	}
	if got.UnresolvedAt == 0 {
		t.Fatalf("the row no longer says its bill is unresolved: %+v", got)
	}
	if got.Received != 4000 || got.Metered != 4000 {
		t.Fatalf("the lower bound was rewritten: received=%d metered=%d", got.Received, got.Metered)
	}

	// The orphan pass drops blobs. This blob is the only remaining witness to
	// what the node really accepted, so the pass must not see the row at all.
	orphans, err := st.ListOrphanDoneUploadSessions(ctx, farFuture)
	if err != nil {
		t.Fatalf("list orphans: %v", err)
	}
	for _, o := range orphans {
		if o.ID == "unres1" {
			t.Fatal("the orphan pass would drop the blob that is the only record of the exact committed size")
		}
	}
}

// Settling happens only against a size a probe returned, and then exactly once.
func TestSettleUnresolvedUploadBillsTheExactRecoveredSize(t *testing.T) {
	ctx := context.Background()
	st, userID := mkUnresolved(t, "unres2", 4000)

	// The node came back holding 7000 — 3000 more than any append recorded.
	billed, err := st.SettleUnresolvedUpload(ctx, "unres2", 7000, 2000)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if billed != 3000 {
		t.Fatalf("billed %d, want the 3000 bytes the node committed but never acknowledged", billed)
	}
	got, _, _ := st.GetUploadSession(ctx, "unres2", userID)
	if got.Received != 7000 || got.Metered != 7000 || got.UnresolvedAt != 0 {
		t.Fatalf("after settling: %+v", got)
	}
	if up, _, err := st.MonthlyUsage(ctx, userID, periodOf(2000)); err != nil || up != 7000 {
		t.Fatalf("the account's meter reads %d upload bytes (err %v), want 7000", up, err)
	}
	// Exactly once: the state is gone, so a second attempt bills nothing.
	if again, err := st.SettleUnresolvedUpload(ctx, "unres2", 7000, 2100); err != nil || again != 0 {
		t.Fatalf("a second settle billed %d again (err %v)", again, err)
	}
}

// A node's answer is not trusted beyond the write budget this server itself
// authorized, and it can never take bytes back off the meter either.
func TestSettleUnresolvedUploadDoesNotTrustAnAbsurdSize(t *testing.T) {
	ctx := context.Background()

	t.Run("a lying node is clamped to max_size", func(t *testing.T) {
		st, userID := mkUnresolved(t, "unres3", 4000)
		billed, err := st.SettleUnresolvedUpload(ctx, "unres3", 1<<40, 2000)
		if err != nil {
			t.Fatalf("settle: %v", err)
		}
		if billed != (1<<20)-4000 {
			t.Fatalf("billed %d, want the clamp to the session's %d-byte budget", billed, 1<<20)
		}
		if got, _, _ := st.GetUploadSession(ctx, "unres3", userID); got.Received != 1<<20 {
			t.Fatalf("received = %d, past max_size", got.Received)
		}
	})

	t.Run("a node holding less does not refund what already crossed", func(t *testing.T) {
		st, userID := mkUnresolved(t, "unres4", 4000)
		billed, err := st.SettleUnresolvedUpload(ctx, "unres4", 10, 2000)
		if err != nil {
			t.Fatalf("settle: %v", err)
		}
		if billed != 0 {
			t.Fatalf("billed %d for a blob that shrank", billed)
		}
		got, _, _ := st.GetUploadSession(ctx, "unres4", userID)
		if got.Received != 4000 || got.Metered != 4000 {
			t.Fatalf("a shrinking blob rewrote the ledger: %+v", got)
		}
	})
}

// The state is only ever entered from an OPEN session: a finalize that already
// claimed the row owns its bill, and must not have it reopened underneath.
func TestMarkUploadUnresolvedLosesToAClaim(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "claimed@example.com", "C")
	row := mkUploadRow("claimed", u.ID)
	if ok, err := st.CreateUploadSession(ctx, row, maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("create: ok=%v err=%v", ok, err)
	}
	if _, _, ok, err := st.ClaimUploadDone(ctx, "claimed", 1500); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	if ok, err := st.MarkUploadUnresolved(ctx, "claimed", 1600); err != nil || ok {
		t.Fatalf("marking a claimed session unresolved: ok=%v err=%v", ok, err)
	}
	if got, _, _ := st.GetUploadSession(ctx, "claimed", u.ID); got.UnresolvedAt != 0 {
		t.Fatalf("a finalized session was pulled back into the recovery state: %+v", got)
	}
}

// Settling is only ever for a row in the recovery state. A live session's offset
// is owned by its appends and its finalize; letting a node-reported size be
// written straight onto one would bypass every path that bills and bounds it.
func TestSettleUnresolvedUploadOnlyTouchesRowsInTheRecoveryState(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "live@example.com", "L")
	if ok, err := st.CreateUploadSession(ctx, mkUploadRow("live", u.ID), maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("create: ok=%v err=%v", ok, err)
	}
	if _, err := st.CommitUploadProgress(ctx, UploadProgress{
		SessionID: "live", UserID: u.ID, Committed: 1000, Billable: true, Now: 1100,
	}); err != nil {
		t.Fatalf("commit progress: %v", err)
	}

	if billed, err := st.SettleUnresolvedUpload(ctx, "live", 9000, 1200); err != nil || billed != 0 {
		t.Fatalf("settling a live session billed %d (err %v)", billed, err)
	}
	got, _, _ := st.GetUploadSession(ctx, "live", u.ID)
	if got.Received != 1000 || got.Metered != 1000 || got.Done {
		t.Fatalf("a live session was rewritten by a settle: %+v", got)
	}
}
