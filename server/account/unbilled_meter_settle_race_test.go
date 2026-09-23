package account

// SettleUnbilledMeter reads its batch OUTSIDE any transaction and settles each
// row in its own. Between the read and a row's transaction a hard purge, a
// second settler or a reactivation can commit. These drive that window
// deterministically: take the batch snapshot the way SettleUnbilledMeter does,
// commit the competitor, then run the per-row transaction on the stale row.

import (
	"context"
	"testing"
)

func owedSnapshot(t *testing.T, h *pairHarness) []UnbilledMeter {
	t.Helper()
	rows, err := h.store.db.Query(`SELECT id, user_id, kind, bytes, at FROM unbilled_meter ORDER BY at`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []UnbilledMeter
	for rows.Next() {
		var m UnbilledMeter
		var k int
		if err := rows.Scan(&m.ID, &m.UserID, &k, &m.Bytes, &m.At); err != nil {
			t.Fatal(err)
		}
		m.Kind = UsageKind(k)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// Snapshot, then the hard purge folds the row into the archive, then the stale
// row transaction runs: a no-op. The archive holds the owed bytes once.
func TestAStaleOwedRowSettleAfterThePurgeCountsOnce(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	at := h.now
	ownedResidual(t, h, true)
	h.confirmDeletion(t)
	snap := owedSnapshot(t, h)
	if len(snap) != 1 {
		t.Fatalf("setup: %d owed rows", len(snap))
	}
	h.advance(31 * 86400)
	if err := h.store.ArchiveAndPurgeUser(ctx, h.userID, h.now); err != nil {
		t.Fatal(err)
	}
	refuseBillingWrites(t, h, false, false)
	done, err := h.store.settleOneUnbilledMeter(ctx, snap[0])
	if err != nil || done {
		t.Errorf("RACE: a stale settle after the purge: done=%v err=%v, want false/nil", done, err)
	}
	if got := archivedUpload(t, h, at); got != residualOnNode {
		t.Errorf("EXACTLY-ONCE: archive %d, want %d", got, residualOnNode)
	}
}

// Two settlers hold the same stale row of a LIVE account: metered once.
func TestTwoSettlersMeterALiveOwedRowOnce(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	at := h.now
	ownedResidual(t, h, true)
	refuseBillingWrites(t, h, false, false)
	snap := owedSnapshot(t, h)
	if len(snap) != 1 {
		t.Fatalf("setup: %d owed rows", len(snap))
	}
	first, err1 := h.store.settleOneUnbilledMeter(ctx, snap[0])
	second, err2 := h.store.settleOneUnbilledMeter(ctx, snap[0])
	if !first || err1 != nil || second || err2 != nil {
		t.Errorf("RACE: first=%v/%v second=%v/%v, want true/nil then false/nil", first, err1, second, err2)
	}
	if got := meteredFor(t, h, h.userID, at); got != residualOnNode {
		t.Errorf("EXACTLY-ONCE: metered %d, want %d", got, residualOnNode)
	}
}

// A reactivation commits between the snapshot and the row transaction: the
// account exists again, so it is metered, not archived.
func TestAStaleOwedRowSettleAfterReactivationMetersTheAccount(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	at := h.now
	ownedResidual(t, h, true)
	h.confirmDeletion(t)
	snap := owedSnapshot(t, h)
	if len(snap) != 1 {
		t.Fatalf("setup: %d owed rows", len(snap))
	}
	if err := h.store.ClearAccountDeletion(ctx, h.userID); err != nil {
		t.Fatal(err)
	}
	refuseBillingWrites(t, h, false, false)
	if done, err := h.store.settleOneUnbilledMeter(ctx, snap[0]); !done || err != nil {
		t.Fatalf("settle: %v %v", done, err)
	}
	if got, arch := meteredFor(t, h, h.userID, at), archivedUpload(t, h, at); got != residualOnNode || arch != 0 {
		t.Errorf("DEBT: metered %d archived %d, want %d/0", got, arch, residualOnNode)
	}
}
