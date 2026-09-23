package account

// The double persistence fault: the meter AND the owed-bills outbox both refuse
// writes while a known residual is being cleaned up. The evidence — the blob
// and its durable owner row — must survive every sweep of the fault; once the
// database heals, the residual is billed exactly once and the blob deleted.

import (
	"context"
	"net/http"
	"testing"
)

func assertResidualEvidenceKept(t *testing.T, h *pairHarness, node *commitThenFailNode, key, phase string) {
	t.Helper()
	if got := nodeBlobSize(t, node.dir, key); got != residualOnNode {
		t.Errorf("EVIDENCE(%s): the blob holds %d bytes, want all %d kept while nothing durable could be written", phase, got, residualOnNode)
	}
	q := queuedFor(t, h, key)
	if len(q) != 1 || q[0].BillUserID != h.userID || q[0].BilledThrough != residualAcked {
		t.Errorf("OWNER(%s): queue %+v, want one obligation for the sender at floor %d", phase, q, residualAcked)
	}
	if got := h.uploadMetered(t); got != residualAcked {
		t.Errorf("ACCOUNTING(%s): metered %d during the fault, want %d", phase, got, residualAcked)
	}
}

// A finalize crashed after its terminal claim: the orphan pass and the drain
// run under the fault.
func TestAnOrphanResidualUnderADoubleFaultKeepsItsEvidenceThenBillsOnce(t *testing.T) {
	h := newPairHarness(t)
	id, node, sess := stageResidual(t, h, false)
	claimDone(t, h, id)
	node.heal()
	refuseBillingWrites(t, h, true, true)
	reapIdle(h)
	for i := 0; i < 3; i++ {
		gcSweep(h)
	}
	assertResidualEvidenceKept(t, h, node, sess.BlobKey, "orphan, faulted")
	refuseBillingWrites(t, h, false, false)
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualOnNode {
		t.Errorf("BACKFILL: metered %d after recovery, want exactly %d", got, residualOnNode)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Error("CLEANUP: the blob survived the post-recovery drain")
	}
	h.svc.ReapPendingUploads(h.now + 60)
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualOnNode {
		t.Errorf("EXACTLY-ONCE: metered %d after another reap and sweep, want %d", got, residualOnNode)
	}
}

// A non-pair finalize refused (the daily quota) under the fault. The refusal
// must not destroy the blob; its 409 tombstone stays; after recovery the drain
// bills the residual once, and the tombstone's later claim (re-producing the
// obligation) charges nothing more.
func TestARefusedFinalizeUnderADoubleFaultKeepsItsEvidenceThenBillsOnce(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	id, node, sess := stageResidual(t, h, false)
	node.heal()
	if ok, err := h.store.ReserveUpload(ctx,
		UploadEvent{ID: "ev-spend-quota", UserID: h.userID, Bytes: 1 << 30, UploadedAt: h.now},
		h.now-dayWindow, 1<<40); err != nil || !ok {
		t.Fatalf("setup: spend the daily quota ok=%v err=%v", ok, err)
	}
	refuseBillingWrites(t, h, true, true)
	if code, _ := h.finalize(t, id); code != http.StatusTooManyRequests {
		t.Fatalf("setup: finalize %d, want 429", code)
	}
	gcSweep(h)
	gcSweep(h)
	assertResidualEvidenceKept(t, h, node, sess.BlobKey, "refusal, faulted")
	if code, _ := h.finalize(t, id); code != http.StatusConflict {
		t.Errorf("TOMBSTONE: retry %d, want 409", code)
	}
	refuseBillingWrites(t, h, false, false)
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualOnNode {
		t.Errorf("BACKFILL: metered %d after recovery, want exactly %d", got, residualOnNode)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Error("CLEANUP: the blob survived the post-recovery drain")
	}
	reapIdle(h)
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualOnNode {
		t.Errorf("EXACTLY-ONCE: the tombstone's re-production charged again: metered %d, want %d", got, residualOnNode)
	}
}
