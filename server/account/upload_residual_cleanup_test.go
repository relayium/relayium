package account

// Residual billing at cleanup: an upload that never became a stored object is
// billed for what its blob physically holds, capped at max_size, before the
// blob is deleted — through every cleanup producer (the orphan claim, the
// set-based purge, a refused finalize), exactly once, and never for an upload
// whose residual the rule does not own (own-node, legacy, persisted).

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strconv"
	"testing"
)

// The original counterexample: a pair-room finalize crashed right after its
// durable terminal claim, holding 4200 bytes on the node against 1200 recorded.
// The room is joined, so no room deadline will ever settle it on the upload's
// behalf; the orphan cleanup is its only owner, and it must bill all 4200.
func TestACrashedFinalizeIsBilledWhatItsBlobHoldsAtCleanup(t *testing.T) {
	h := newPairHarness(t)
	id, node, known, onNode := unreachableAfterCommit(t, h, "858585")
	h.join(t, "858585")
	sess := h.session(t, id)
	claimDone(t, h, id)
	node.heal()
	reapIdle(h)
	if h.sessionExists(t, id) {
		t.Fatal("the orphan pass did not claim the tombstone")
	}
	q := queuedFor(t, h, sess.BlobKey)
	if len(q) != 1 || q[0].BillUserID != h.userID || q[0].BilledThrough != known || q[0].BillMax != sess.MaxSize {
		t.Fatalf("OWNERSHIP: the claim queued %+v, want one obligation for %s at floor %d capped at %d",
			q, h.userID, known, sess.MaxSize)
	}
	gcSweep(h)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("ACCOUNTING: orphan cleanup billed %d, want all %d committed bytes", got, onNode)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("the blob survived the drain")
	}
	gcSweep(h)
	h.svc.ReapPendingUploads(h.now + 60)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("EXACTLY-ONCE: a second reap and sweep moved the meter to %d, want %d", got, onNode)
	}
}

// The same crash on an ordinary upload: hosted is billed all 4200 once; a
// healthy upload (nothing past `received`) exactly what it sent; own-node
// nothing, with a deletion-only queue row.
func TestAnOrphanResidualIsBilledOnceAndOnlyWhenHosted(t *testing.T) {
	t.Run("hosted residual", func(t *testing.T) {
		h := newPairHarness(t)
		id, node, sess := stageResidual(t, h, false)
		claimDone(t, h, id)
		node.heal()
		reapIdle(h)
		if h.sessionExists(t, id) {
			t.Fatal("orphan tombstone not claimed")
		}
		gcSweep(h)
		gcSweep(h)
		if got := h.uploadMetered(t); got != residualOnNode {
			t.Errorf("ACCOUNTING: metered %d, want exactly the %d committed bytes", got, residualOnNode)
		}
		if nodeBlobPresent(t, node.dir, sess.BlobKey) {
			t.Error("blob survived the drain")
		}
		if q := queuedFor(t, h, sess.BlobKey); len(q) != 0 {
			t.Errorf("queue row outlived the drain: %+v", q)
		}
	})
	t.Run("hosted healthy", func(t *testing.T) {
		h := newPairHarness(t)
		node := newCommitThenFailNode(t)
		h.registerStorageNode(t, node.URL)
		blob := bytes.Repeat([]byte("H"), 900)
		id := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), len(blob), 0)
		if code, _ := patchChunk(t, h.ts, h.cookie, id, blob, 0, len(blob), len(blob)); code != 200 {
			t.Fatalf("patch %d", code)
		}
		sess := h.session(t, id)
		claimDone(t, h, id)
		reapIdle(h)
		gcSweep(h)
		gcSweep(h)
		if got := h.uploadMetered(t); got != 900 {
			t.Errorf("ACCOUNTING: healthy orphan metered %d, want exactly 900", got)
		}
		if nodeBlobPresent(t, node.dir, sess.BlobKey) {
			t.Error("blob survived the drain")
		}
	})
	t.Run("own node", func(t *testing.T) {
		h := newPairHarness(t)
		id, node, sess := stageResidual(t, h, true)
		claimDone(t, h, id)
		node.heal()
		reapIdle(h)
		if q := queuedFor(t, h, sess.BlobKey); len(q) != 1 || q[0].BillUserID != "" {
			t.Errorf("OWNERSHIP: own-node claim queued %+v, want one deletion-only row", q)
		}
		gcSweep(h)
		if got := h.uploadMetered(t); got != 0 {
			t.Errorf("ACCOUNTING: own-node upload metered %d, want 0", got)
		}
		if nodeBlobPresent(t, node.dir, sess.BlobKey) {
			t.Error("own-node blob survived the drain")
		}
	})
}

// The claim needs no probe, so it proceeds while the node is dark; the drain
// then cannot size the blob, and later the meter AND the outbox refuse writes.
// Through all of it the blob and its obligation are kept. Healed: exactly 4200.
func TestAnOrphanResidualKeepsItsEvidenceUntilTheBillIsDurable(t *testing.T) {
	h := newPairHarness(t)
	id, node, sess := stageResidual(t, h, false)
	claimDone(t, h, id)
	reapIdle(h) // node still cannot be probed
	if h.sessionExists(t, id) {
		t.Fatal("setup: the claim did not run")
	}
	q := queuedFor(t, h, sess.BlobKey)
	if len(q) != 1 || q[0].BillUserID != h.userID || q[0].BilledThrough != residualAcked || q[0].BillMax != sess.MaxSize {
		t.Fatalf("OWNERSHIP: claim queued %+v, want one obligation for %s floor %d max %d", q, h.userID, residualAcked, sess.MaxSize)
	}
	for i := 0; i < 3; i++ {
		h.advance(600)
		gcSweep(h)
	}
	if !nodeBlobPresent(t, node.dir, sess.BlobKey) || len(queuedFor(t, h, sess.BlobKey)) != 1 {
		t.Fatal("EVIDENCE: an unprobeable blob or its obligation was destroyed")
	}
	node.failProbe.Store(false)
	refuseBillingWrites(t, h, true, true)
	h.advance(600)
	gcSweep(h)
	if !nodeBlobPresent(t, node.dir, sess.BlobKey) || len(queuedFor(t, h, sess.BlobKey)) != 1 {
		t.Fatal("EVIDENCE: blob or obligation destroyed while billing was refused")
	}
	if got := h.uploadMetered(t); got != residualAcked {
		t.Fatalf("metered %d while billing was refused, want %d", got, residualAcked)
	}
	refuseBillingWrites(t, h, false, false)
	h.advance(600)
	gcSweep(h)
	h.advance(600)
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualOnNode {
		t.Errorf("ACCOUNTING: after heal metered %d, want exactly %d", got, residualOnNode)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Error("blob survived the healed drain")
	}
}

// A node that holds (or claims to hold) far more than the upload was
// authorized to write cannot charge past max_size.
func TestAnOrphanResidualIsCappedAtItsWriteBudget(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	id, node, sess := stageResidual(t, h, false)
	claimDone(t, h, id)
	node.heal()
	cur := nodeBlobSize(t, node.dir, sess.BlobKey)
	extra := sess.MaxSize - cur + 5000
	if _, err := node.ds.Append(ctx, sess.BlobKey, cur, bytes.NewReader(make([]byte, extra))); err != nil {
		t.Fatalf("setup grow: %v", err)
	}
	reapIdle(h)
	gcSweep(h)
	if got := h.uploadMetered(t); got != sess.MaxSize {
		t.Errorf("ACCOUNTING: a hostile node charged %d, want the cap %d", got, sess.MaxSize)
	}
}

// A finalize held past the idle TTL after its terminal claim; the orphan claim
// takes the tombstone WITH the residual obligation; the finalize then resumes,
// its insert is refused, and its settle-first reclaim may delete the blob only
// once the residual is durably billed. After the drain: exactly 4200.
func TestALateFinalizeRefusalSettlesBeforeItDeletes(t *testing.T) {
	h := newPairHarness(t)
	id, node, sess := stageResidual(t, h, false)
	node.heal()
	st := newCleanupStore(t, h.store)
	h.svc.store = st
	st.persist.armed.Store(true)
	codeCh := finalizeAsync(h, id)
	st.persist.waitEntered(t, "finalize")
	reapIdle(h)
	st.persist.open()
	if code := awaitCode(t, codeCh, "finalize"); code != http.StatusInternalServerError {
		t.Fatalf("setup: late finalize answered %d, want 500", code)
	}
	h.svc.store = h.store
	if !nodeBlobPresent(t, node.dir, sess.BlobKey) && h.uploadMetered(t) != residualOnNode {
		t.Errorf("EVIDENCE: the refused finalize destroyed the obligated blob before a durable settle (metered %d)", h.uploadMetered(t))
	}
	gcSweep(h)
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualOnNode {
		t.Errorf("ACCOUNTING: metered %d, want exactly %d", got, residualOnNode)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Error("blob survived the drain")
	}
}

type orphanListFails struct{ Store }

func (orphanListFails) ListOrphanDoneUploadSessions(context.Context, int64) ([]UploadSessionRow, error) {
	return nil, errors.New("injected orphan-list failure")
}

// The orphan list fails, so the set-based purge is the claim: it must hand
// over the same obligation the single claim would.
func TestThePurgeCarriesTheResidualObligationWhenTheOrphanListFails(t *testing.T) {
	h := newPairHarness(t)
	id, node, sess := stageResidual(t, h, false)
	claimDone(t, h, id)
	node.heal()
	h.svc.store = orphanListFails{h.store}
	reapIdle(h)
	h.svc.store = h.store
	if h.sessionExists(t, id) {
		t.Fatal("setup: the purge did not take the orphan")
	}
	q := queuedFor(t, h, sess.BlobKey)
	if len(q) != 1 || q[0].BillUserID != h.userID || q[0].BilledThrough != residualAcked || q[0].BillMax != sess.MaxSize {
		t.Errorf("OWNERSHIP: purge queued %+v, want the single claim's obligation", q)
	}
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualOnNode {
		t.Errorf("ACCOUNTING: metered %d, want exactly %d", got, residualOnNode)
	}
}

// The queue refuses writes: the claim rolls back, and the row keeps owning the
// blob. Healed: exactly 4200.
func TestAResidualClaimThatCannotQueueKeepsTheRow(t *testing.T) {
	h := newPairHarness(t)
	id, node, sess := stageResidual(t, h, false)
	claimDone(t, h, id)
	node.heal()
	heal := failQueueWrites(t, h)
	reapIdle(h)
	if !h.sessionExists(t, id) || !nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("EVIDENCE: a refused queue write still retired the row or lost the blob")
	}
	heal()
	h.advance(600)
	h.svc.ReapPendingUploads(h.now)
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualOnNode {
		t.Errorf("ACCOUNTING: metered %d, want exactly %d", got, residualOnNode)
	}
}

// The documented live-finalize residual is never billed: a finalize persisted
// its object, a late append left bytes past the object's size, then the object
// was deleted with its blob delete failing. Cleanup of the tombstone stays
// deletion-only (the session is residualPersisted).
func TestAPersistedObjectsResidualIsNeverBilled(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	blob := bytes.Repeat([]byte("P"), 700)
	id := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), len(blob), 0)
	if code, _ := patchChunk(t, h.ts, h.cookie, id, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("patch %d", code)
	}
	sess := h.session(t, id)
	code, fid := h.finalize(t, id)
	if code != 200 || fid == "" {
		t.Fatalf("finalize %d", code)
	}
	if got := h.provenanceOf(t, id); got != residualPersisted {
		t.Fatalf("PROVENANCE: a finalized session reads %d, want persisted", got)
	}
	// An append that read done=0 lands after the finalize's claim.
	if _, err := node.ds.Append(ctx, sess.BlobKey, 700, bytes.NewReader(make([]byte, 3000))); err != nil {
		t.Fatalf("setup late bytes: %v", err)
	}
	if err := h.store.DeleteStoredFile(ctx, fid, h.now); err != nil {
		t.Fatal(err)
	}
	if err := h.store.EnqueueNodeDelete(ctx, sess.BlobKey, sess.NodeID, h.now); err != nil {
		t.Fatal(err)
	}
	reapIdle(h)
	if q := queuedFor(t, h, sess.BlobKey); len(q) != 1 || q[0].BillUserID != "" {
		t.Errorf("POLICY: the persisted tombstone was queued %+v, want deletion-only", q)
	}
	gcSweep(h)
	if got := h.uploadMetered(t); got != 700 {
		t.Errorf("POLICY: a persisted object's late residual was charged: metered %d, want 700", got)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Error("blob survived the drain")
	}
}

// A refused finalize (the daily quota, the common refusal) on an upload with a
// residual bills the residual and deletes the blob NOW, keeps its 409
// tombstone, and when that tombstone is claimed later (re-producing the
// obligation) nothing is charged twice — including when the refusal's own
// delete failed and the drain probes the blob again.
func TestARefusedFinalizeBillsItsResidualNowAndNeverTwice(t *testing.T) {
	for _, deleteFails := range []bool{false, true} {
		t.Run("deleteFails="+strconv.FormatBool(deleteFails), func(t *testing.T) {
			h := newPairHarness(t)
			id, node, sess := stageResidual(t, h, false)
			node.heal()
			node.failDelete.Store(deleteFails)
			h.spendDailyQuota(t, 1<<40)
			if code, _ := h.finalize(t, id); code != http.StatusTooManyRequests {
				t.Fatalf("setup: finalize %d, want 429", code)
			}
			if got := h.uploadMetered(t); got != residualOnNode {
				t.Errorf("ACCOUNTING: refused finalize metered %d, want %d at once", got, residualOnNode)
			}
			if present := nodeBlobPresent(t, node.dir, sess.BlobKey); present != deleteFails {
				t.Errorf("blob present=%v after the refusal, want %v", present, deleteFails)
			}
			if retry, _ := h.finalize(t, id); retry != http.StatusConflict {
				t.Errorf("TOMBSTONE: retry answered %d, want 409", retry)
			}
			reapIdle(h)
			if h.sessionExists(t, id) {
				t.Fatal("setup: tombstone not claimed")
			}
			node.failDelete.Store(false)
			gcSweep(h)
			gcSweep(h)
			if got := h.uploadMetered(t); got != residualOnNode {
				t.Errorf("DOUBLE-CHARGE: metered %d after re-production and drain, want exactly %d", got, residualOnNode)
			}
			if nodeBlobPresent(t, node.dir, sess.BlobKey) {
				t.Error("blob survived the drain")
			}
		})
	}
}

// A refused finalize of a LEGACY (unknown-provenance) upload keeps the rule it
// was created under: its blob is still reclaimed at once, but its residual is
// not billed.
func TestARefusedLegacyFinalizeDoesNotBillItsResidual(t *testing.T) {
	h := newPairHarness(t)
	id, node, sess := stageResidual(t, h, false)
	node.heal()
	if _, err := h.store.db.Exec(`UPDATE upload_sessions SET residual_provenance = 0 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	h.spendDailyQuota(t, 1<<40)
	if code, _ := h.finalize(t, id); code != http.StatusTooManyRequests {
		t.Fatalf("setup: finalize %d, want 429", code)
	}
	if got := h.uploadMetered(t); got != residualAcked {
		t.Errorf("POLICY: a legacy refusal billed its residual: metered %d, want %d", got, residualAcked)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Error("the refusal no longer reclaims a legacy upload's blob at once")
	}
	if retry, _ := h.finalize(t, id); retry != http.StatusConflict {
		t.Errorf("TOMBSTONE: retry answered %d, want 409", retry)
	}
	reapIdle(h)
	gcSweep(h)
	if got := h.uploadMetered(t); got != residualAcked {
		t.Errorf("POLICY: metered %d after the tombstone's cleanup, want %d", got, residualAcked)
	}
}

// An empty fresh upload whose finalize crashed after its claim: the drain's
// probe finds nothing (0 bytes is an answer, never an inference about past
// bytes), nothing is charged, and nothing is left behind.
func TestAnEmptyFreshOrphanChargesNothingAndLeavesNothing(t *testing.T) {
	h := newPairHarness(t)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	id := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), 0, 0)
	sess := h.session(t, id)
	claimDone(t, h, id)
	reapIdle(h)
	gcSweep(h)
	if got := h.uploadMetered(t); got != 0 {
		t.Errorf("EMPTY: metered %d, want 0", got)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Error("EMPTY: the probe's empty file survived the drain")
	}
	if q := queuedFor(t, h, sess.BlobKey); len(q) != 0 {
		t.Errorf("EMPTY: queue row left: %+v", q)
	}
}

// A queue row whose cap is 0 means nothing may be written, never "uncapped":
// whatever size a node reports, settling it charges nothing.
func TestAnObligationCappedAtZeroChargesNothing(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "cap0@example.com", "C")
	if err := enqueueBilledNodeDeleteOn(ctx, st.db, "blob-cap0", "", 100, 0, u.ID, MeterUpload, 0, 0); err != nil {
		t.Fatal(err)
	}
	charged, err := st.SettleBlobBilling(ctx, "blob-cap0", "", 5000, 100)
	if err != nil {
		t.Fatal(err)
	}
	if charged != 0 {
		t.Fatalf("CLAMP: a zero-capped obligation charged %d, want 0", charged)
	}
}
