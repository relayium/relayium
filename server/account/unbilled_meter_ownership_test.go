package account

// Who owns a bill once its account is deleted, and the owed-bills outbox
// (unbilled_meter). A residual byte owed by an account exists in one form at a
// time — a queued blob OBLIGATION (unmeasured; its evidence is the account's
// ciphertext), an OWED ROW (a known number), or the meter — and:
//   - an obligation never outlives the account's entry into deletion;
//   - an owed row stays the account's until the hard purge folds it into the
//     anonymized archive, as the purge folds the meter;
//   - a row naming an account that no longer exists is archived, not failed;
//   - one row that cannot settle never blocks another account's bill.
//
// Every bill here comes from real paths: a real pair upload over HTTP, the
// real ClosePairRoom obligation, the real Service.settleBlobBillingDurably
// (direct settle, then the journal fallback), ConfirmAccountDeletion,
// ArchiveAndPurgeUser and SettleUnbilledMeter. The only fault is a private
// trigger that makes the meter refuse writes.

import (
	"bytes"
	"context"
	"testing"
)

// ownedResidual stages a real residual obligation: a pair upload acknowledged
// at 1200 whose node committed 4200, the room close that carries the
// obligation, and the real fallback settling it. journal=true makes the meter
// refuse, so the 3000-byte residual is JOURNALED (one owed row); otherwise it
// is metered directly.
func ownedResidual(t *testing.T, h *pairHarness, journal bool) UploadSessionRow {
	t.Helper()
	ctx := context.Background()
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	h.mintCode("393939", "")
	code, id, _ := h.initPairUpload(t, "393939", 0, "")
	if code != 200 {
		t.Fatalf("init %d", code)
	}
	sess := h.session(t, id)
	blob := bytes.Repeat([]byte("D"), residualOnNode)
	if code := h.patch(t, id, blob, 0, residualAcked, residualOnNode); code != 200 {
		t.Fatalf("patch %d", code)
	}
	node.failAfterCommit.Store(true)
	node.failProbe.Store(true)
	if code := h.patch(t, id, blob, residualAcked, residualOnNode, residualOnNode); code != 500 {
		t.Fatalf("failed append %d", code)
	}
	if _, err := h.store.ClosePairRoom(ctx, sess.PairRoomID, h.now, h.now); err != nil {
		t.Fatal(err)
	}
	refuseBillingWrites(t, h, journal, false)
	if !h.svc.settleBlobBillingDurably(ctx, sess.BlobKey, sess.NodeID, residualOnNode, h.now, "test obligation") {
		t.Fatal("setup: the settle was not durable")
	}
	if n, b := owedFor(t, h, h.userID); journal && (n != 1 || b != residualUnacked) {
		t.Fatalf("setup: owed rows=%d bytes=%d, want 1/%d", n, b, residualUnacked)
	}
	return sess
}

// liveBill queues an independent owed bill for a second, live account.
func liveBill(t *testing.T, h *pairHarness) User {
	t.Helper()
	ctx := context.Background()
	live, err := h.store.UpsertUserByEmail(ctx, "live@example.com", "Live")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.EnqueueUnbilledMeter(ctx, UnbilledMeter{UserID: live.ID, Kind: MeterUpload, Bytes: 20, At: h.now, Reason: "live"}); err != nil {
		t.Fatal(err)
	}
	return live
}

// The root finding: a real journaled residual, then the account is confirmed
// for deletion and hard-purged while the meter still refuses. The deleted
// account's owed row must neither survive the purge nor block a live
// account's bill once the meter heals.
func TestADeletedAccountsOwedBillNeitherSurvivesNorBlocksLiveBills(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	ownedResidual(t, h, true)
	h.confirmDeletion(t)
	h.advance(31 * 86400)
	if _, err := h.store.SettleUnbilledMeter(ctx, 256); err == nil {
		t.Fatal("setup: the meter fault did not refuse the settle")
	}
	if err := h.store.ArchiveAndPurgeUser(ctx, h.userID, h.now); err != nil {
		t.Fatal(err)
	}
	refuseBillingWrites(t, h, false, false)
	live := liveBill(t, h)
	n, err := h.store.SettleUnbilledMeter(ctx, 256)
	if rows, _ := owedFor(t, h, h.userID); rows != 0 || err != nil || n != 1 {
		t.Errorf("the deleted account's owed row survives or blocks: rows=%d settled=%d err=%v", rows, n, err)
	}
	if got := meteredFor(t, h, live.ID, h.now); got != 20 {
		t.Errorf("LIVE: metered %d, want 20", got)
	}
}

// Account deletion forgives the account's unmeasured residuals in its own
// transaction: no queue row names the account after the confirm, and after the
// hard purge its ciphertext goes as soon as the node takes deletes — without
// recreating a meter row for it.
func TestAccountDeletionForgivesQueuedObligations(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	h.mintCode("393939", "")
	status, id, _ := h.initPairUpload(t, "393939", 0, "")
	if status != 200 {
		t.Fatalf("init %d", status)
	}
	sess := h.session(t, id)
	blob := bytes.Repeat([]byte("D"), residualOnNode)
	if got := h.patch(t, id, blob, 0, residualAcked, residualOnNode); got != 200 {
		t.Fatalf("patch %d", got)
	}
	node.failAfterCommit.Store(true)
	node.failProbe.Store(true)
	if got := h.patch(t, id, blob, residualAcked, residualOnNode, residualOnNode); got != 500 {
		t.Fatalf("failed append %d", got)
	}
	if _, err := h.store.ClosePairRoom(ctx, sess.PairRoomID, h.now, h.now); err != nil {
		t.Fatal(err)
	}
	if q := queuedFor(t, h, sess.BlobKey); len(q) != 1 || q[0].BillUserID != h.userID {
		t.Fatalf("setup: obligation %+v", q)
	}
	node.failDelete.Store(true)
	h.confirmDeletion(t)
	var attributed int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM pending_node_deletes WHERE bill_user_id = ?`, h.userID).Scan(&attributed); err != nil {
		t.Fatal(err)
	}
	if attributed != 0 {
		t.Errorf("PRIVACY: %d queued obligation row(s) still name the deleted account after the confirm", attributed)
	}
	h.advance(31 * 86400)
	if err := h.store.ArchiveAndPurgeUser(ctx, h.userID, h.now); err != nil {
		t.Fatalf("hard purge: %v", err)
	}
	node.heal()
	gcSweep(h)
	gcSweep(h)
	var left, monthly int
	_ = h.store.db.QueryRow(`SELECT COUNT(*) FROM pending_node_deletes WHERE blob_key = ?`, sess.BlobKey).Scan(&left)
	_ = h.store.db.QueryRow(`SELECT COUNT(*) FROM usage_monthly WHERE user_id = ?`, h.userID).Scan(&monthly)
	if nodeBlobPresent(t, node.dir, sess.BlobKey) || left != 0 {
		t.Errorf("PRIVACY: the deleted account's ciphertext was kept after the hard purge (queue rows=%d)", left)
	}
	if monthly != 0 {
		t.Error("PRIVACY: usage_monthly was recreated for a purged account")
	}
}

// The hard purge's result does not depend on whether the meter was healthy: a
// healthy meter bills 1200+3000 and the purge archives 4200; a meter that
// refused the residual leaves it owed, and the purge must archive the SAME
// 4200, remove the owed row, and leave nothing that blocks a later live bill.
func TestThePurgeFoldsAnOwedBillLikeAHealthyMeter(t *testing.T) {
	for _, journal := range []bool{false, true} {
		name := "healthy meter"
		if journal {
			name = "meter refused until after the purge"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			h := newPairHarness(t)
			at := h.now
			ownedResidual(t, h, journal)
			h.confirmDeletion(t)
			h.advance(31 * 86400)
			if err := h.store.ArchiveAndPurgeUser(ctx, h.userID, h.now); err != nil {
				t.Fatalf("purge: %v", err)
			}
			refuseBillingWrites(t, h, false, false)
			if got := archivedUpload(t, h, at); got != residualOnNode {
				t.Errorf("ARCHIVE: the purged account's period total is %d, want %d (the healthy-meter outcome, once)", got, residualOnNode)
			}
			if n, _ := owedFor(t, h, h.userID); n != 0 {
				t.Errorf("PRIVACY: %d owed row(s) still name the purged account", n)
			}
			live := liveBill(t, h)
			n, err := h.store.SettleUnbilledMeter(ctx, 256)
			if err != nil || n != 1 || meteredFor(t, h, live.ID, h.now) != 20 {
				t.Errorf("LIVE: settled=%d err=%v live metered=%d, want 1/nil/20", n, err, meteredFor(t, h, live.ID, h.now))
			}
			if n, err := h.store.SettleUnbilledMeter(ctx, 256); n != 0 || err != nil {
				t.Errorf("IDEMPOTENT: a second settle %d %v", n, err)
			}
			if got := archivedUpload(t, h, at); got != residualOnNode {
				t.Errorf("ARCHIVE after the settles: %d, want %d", got, residualOnNode)
			}
		})
	}
}

// An owed bill is a debt of an account that can come back: it survives the
// confirm, survives a hard purge that loses the race to reactivation, and is
// metered to the reactivated account.
func TestAReactivatedAccountKeepsItsOwedBill(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	at := h.now
	ownedResidual(t, h, true)
	h.confirmDeletion(t)
	if n, b := owedFor(t, h, h.userID); n != 1 || b != residualUnacked {
		t.Fatalf("CONFIRM: owed rows=%d bytes=%d after the confirm, want 1/%d (the grace window keeps debts)", n, b, residualUnacked)
	}
	if err := h.store.ClearAccountDeletion(ctx, h.userID); err != nil {
		t.Fatal(err)
	}
	h.advance(31 * 86400)
	// GC's purge snapshot was taken before the reactivation committed.
	if err := h.store.ArchiveAndPurgeUser(ctx, h.userID, h.now); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if got := archivedUpload(t, h, at); got != 0 {
		t.Errorf("RACE: a purge that lost to reactivation archived %d", got)
	}
	if n, b := owedFor(t, h, h.userID); n != 1 || b != residualUnacked {
		t.Fatalf("DEBT: the reactivated account's owed rows=%d bytes=%d, want 1/%d", n, b, residualUnacked)
	}
	refuseBillingWrites(t, h, false, false)
	if n, err := h.store.SettleUnbilledMeter(ctx, 256); n != 1 || err != nil {
		t.Fatalf("settle: %d %v", n, err)
	}
	if got := meteredFor(t, h, h.userID, at); got != residualOnNode {
		t.Errorf("DEBT: the reactivated account was metered %d, want %d once", got, residualOnNode)
	}
}

// Inside the grace window the account still exists: a meter that heals before
// the purge settles the owed bill to the account, and the purge archives it
// once.
func TestAnOwedBillSettledInTheGraceWindowIsArchivedOnce(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	at := h.now
	ownedResidual(t, h, true)
	h.confirmDeletion(t)
	refuseBillingWrites(t, h, false, false)
	if n, err := h.store.SettleUnbilledMeter(ctx, 256); n != 1 || err != nil {
		t.Fatalf("GRACE: settle %d %v, want 1/nil", n, err)
	}
	if got := meteredFor(t, h, h.userID, at); got != residualOnNode {
		t.Errorf("GRACE: metered %d, want %d", got, residualOnNode)
	}
	h.advance(31 * 86400)
	if err := h.store.ArchiveAndPurgeUser(ctx, h.userID, h.now); err != nil {
		t.Fatal(err)
	}
	if got := archivedUpload(t, h, at); got != residualOnNode {
		t.Errorf("ARCHIVE: %d, want %d exactly once", got, residualOnNode)
	}
}

// A blob obligation that outlived its account's liveness — the shape an older
// binary or a racing producer can leave, written here by the real producer
// after the deletion — is settled by the real fallback while the meter
// refuses. For a purged account or one in its grace window it bills nothing
// and writes no owed row (the obligation is forgiven); a live account is
// billed in full.
func TestALateObligationForADeletedAccountWritesNoBill(t *testing.T) {
	for _, state := range []string{"purged", "grace window", "live"} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			h := newPairHarness(t)
			at := h.now
			u, err := h.store.UpsertUserByEmail(ctx, "other@example.com", "Other")
			if err != nil {
				t.Fatal(err)
			}
			switch state {
			case "purged":
				if err := h.store.SetAccountDeletion(ctx, u.ID, h.now, h.now); err != nil {
					t.Fatal(err)
				}
				if err := h.store.ArchiveAndPurgeUser(ctx, u.ID, h.now); err != nil {
					t.Fatal(err)
				}
			case "grace window":
				if err := h.store.SetAccountDeletion(ctx, u.ID, h.now, h.now+30*86400); err != nil {
					t.Fatal(err)
				}
			}
			key := "late-obligation"
			if err := enqueueBilledNodeDeleteOn(ctx, h.store.db, key, "", h.now, 0, u.ID, MeterUpload, residualOnNode, residualAcked); err != nil {
				t.Fatal(err)
			}
			refuseBillingWrites(t, h, true, false)
			ok := h.svc.settleBlobBillingDurably(ctx, key, "", residualOnNode, h.now, "late obligation")
			refuseBillingWrites(t, h, false, false)
			n, b := owedFor(t, h, u.ID)
			if state == "live" {
				if !ok || n != 1 || b != residualUnacked {
					t.Errorf("LIVE: durable=%v owed rows=%d bytes=%d, want true/1/%d (a live debt is never forgiven)", ok, n, b, residualUnacked)
				}
			} else {
				if !ok {
					t.Errorf("%s: the settle was not durable", state)
				}
				if n != 0 {
					t.Errorf("POISON: the late fallback wrote %d owed row(s) (%d bytes) for a %s account", n, b, state)
				}
				if q := queuedFor(t, h, key); len(q) != 1 || q[0].BillUserID != "" {
					t.Errorf("FORGIVE: the obligation still names the %s account: %+v", state, q)
				}
				if got := meteredFor(t, h, u.ID, at); got != 0 {
					t.Errorf("%s: metered %d", state, got)
				}
			}
			if _, err := h.store.SettleUnbilledMeter(ctx, 256); err != nil {
				t.Errorf("BLOCKED: the settle after the late fallback failed: %v", err)
			}
		})
	}
}

// The shape an older binary leaves: an owed row naming an account it purged
// without folding the row (the INSERT is the journal's own). Queued AHEAD of a
// live bill, one settle pass archives it, meters the live bill and leaves
// nothing behind.
func TestALegacyOwedRowOfAPurgedAccountIsArchivedNotBlocking(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	at := h.now
	gone, err := h.store.UpsertUserByEmail(ctx, "gone@example.com", "Gone")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.SetAccountDeletion(ctx, gone.ID, h.now, h.now); err != nil {
		t.Fatal(err)
	}
	if err := h.store.ArchiveAndPurgeUser(ctx, gone.ID, h.now); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.db.Exec(
		`INSERT INTO unbilled_meter (id, user_id, kind, bytes, at, reason) VALUES (?,?,?,?,?,?)`,
		"legacy-row", gone.ID, int(MeterUpload), residualUnacked, h.now-1, "legacy journaled residual"); err != nil {
		t.Fatal(err)
	}
	if err := h.store.EnqueueUnbilledMeter(ctx, UnbilledMeter{UserID: h.userID, Kind: MeterUpload, Bytes: 20, At: h.now, Reason: "live"}); err != nil {
		t.Fatal(err)
	}
	n, err := h.store.SettleUnbilledMeter(ctx, 256)
	if err != nil || n != 2 {
		t.Errorf("HEAL: settled=%d err=%v, want 2/nil", n, err)
	}
	if got := archivedUpload(t, h, at); got != residualUnacked {
		t.Errorf("ARCHIVE: %d, want %d", got, residualUnacked)
	}
	if got := meteredFor(t, h, h.userID, at); got != 20 {
		t.Errorf("LIVE: %d, want 20", got)
	}
	if c, _ := owedFor(t, h, gone.ID); c != 0 {
		t.Errorf("PRIVACY: %d legacy row(s) remain", c)
	}
}

// A row that cannot be metered (an unknown kind) queued AHEAD of a live bill:
// one pass still meters the live bill, keeps the unsettleable row (it is
// evidence) and reports its error.
func TestAnOwedRowThatCannotSettleDoesNotBlockLiveBills(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	if _, err := h.store.db.Exec(
		`INSERT INTO unbilled_meter (id, user_id, kind, bytes, at, reason) VALUES (?,?,?,?,?,?)`,
		"poison", h.userID, 99, 5, h.now-10, "unknown kind"); err != nil {
		t.Fatal(err)
	}
	if err := h.store.EnqueueUnbilledMeter(ctx, UnbilledMeter{UserID: h.userID, Kind: MeterUpload, Bytes: 20, At: h.now, Reason: "live"}); err != nil {
		t.Fatal(err)
	}
	n, err := h.store.SettleUnbilledMeter(ctx, 256)
	if got := h.uploadMetered(t); got != 20 || n != 1 {
		t.Errorf("BLOCKED: the live bill metered %d (settled=%d), want 20/1", got, n)
	}
	if err == nil {
		t.Error("the unsettleable row's error was swallowed")
	}
	var left int
	_ = h.store.db.QueryRow(`SELECT COUNT(*) FROM unbilled_meter WHERE id = 'poison'`).Scan(&left)
	if left != 1 {
		t.Errorf("EVIDENCE: the unsettleable row was dropped (%d left)", left)
	}
}
