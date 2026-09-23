package account

// A pairing room's void and the residual: it bills the residual of a session
// that never became an object (as it always has), never the residual of one
// that did (residualPersisted), and keeps its rule for legacy sessions.

import (
	"bytes"
	"context"
	"testing"
)

// A pair-room object PERSISTED and then completed by its receiver while the
// room stays open (a second object keeps it open). A late append left 3000
// bytes past the object's size on its blob — the documented live-finalize
// residual — and the node refused the completion's delete. When the owner
// releases the room, the void re-enumerates the object's finalize tombstone
// (its blob is no longer referenced) and must not bill that residual.
func TestAVoidNeverBillsTheResidualOfACompletedObject(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	node := newCommitThenFailNode(t)
	h.registerStorageNode(t, node.URL)
	h.mintCode("515151", "")
	keyA, keyB := fileKeyN(51), fileKeyN(52)
	idA := h.preUploadCompletable(t, "515151", bytes.Repeat([]byte("A"), 1024), keyA)
	_ = h.preUploadCompletable(t, "515151", bytes.Repeat([]byte("B"), 1024), keyB)
	sfA, err := h.store.GetStoredFile(ctx, idA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := node.ds.Append(ctx, sfA.BlobKey, 1024, bytes.NewReader(make([]byte, 3000))); err != nil {
		t.Fatal(err)
	}
	h.join(t, "515151")
	node.failDelete.Store(true)
	if resp, _ := h.completeWithKey(t, idA, keyA); resp.StatusCode/100 != 2 {
		t.Fatalf("complete A: %d", resp.StatusCode)
	}
	room := h.roomOf(t, h.firstPairRoomObject(t))
	before := h.uploadMetered(t)
	if code, _ := h.release(t, h.cookie, room.ID); code/100 != 2 {
		t.Fatalf("release: %d", code)
	}
	if q := queuedFor(t, h, sfA.BlobKey); len(q) != 1 || q[0].BillUserID != "" {
		t.Errorf("POLICY: the void queued the completed object's blob as %+v, want deletion-only", q)
	}
	node.heal()
	gcSweep(h)
	gcSweep(h)
	if d := h.uploadMetered(t) - before; d != 0 {
		t.Errorf("POLICY: the void billed %d residual bytes of an object that had been persisted and completed; want 0", d)
	}
	if nodeBlobPresent(t, node.dir, sfA.BlobKey) {
		t.Error("CLEANUP: the completed object's blob survived the drain")
	}
}

// The positive control: a pair-room upload whose finalize crashed after its
// terminal claim (never persisted) IS billed its residual by the void.
func TestAVoidStillBillsANeverPersistedPairUpload(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	id, node, _, onNode := unreachableAfterCommit(t, h, "525252")
	sess := h.session(t, id)
	claimDone(t, h, id)
	node.heal()
	if _, err := h.store.ClosePairRoom(ctx, sess.PairRoomID, h.now, h.now); err != nil {
		t.Fatal(err)
	}
	gcSweep(h)
	if got := h.uploadMetered(t); got != onNode {
		t.Errorf("OWNERSHIP: the void of a never-persisted pair upload billed %d, want all %d committed bytes", got, onNode)
	}
}

// A legacy (unknown-provenance) pair upload keeps the void's rule — billed —
// because that is the policy it was created under.
func TestAVoidKeepsItsRuleForALegacyPairUpload(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	id, node, _, onNode := unreachableAfterCommit(t, h, "535353")
	if _, err := h.store.db.Exec(`UPDATE upload_sessions SET residual_provenance = 0 WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	sess := h.session(t, id)
	claimDone(t, h, id)
	node.heal()
	if _, err := h.store.ClosePairRoom(ctx, sess.PairRoomID, h.now, h.now); err != nil {
		t.Fatal(err)
	}
	gcSweep(h)
	if got := h.uploadMetered(t); got != onNode {
		t.Errorf("LEGACY: an unknown-provenance pair upload was billed %d by the void, want %d", got, onNode)
	}
}

// Regression guard: a void under the double fault (meter and outbox both
// refusing) keeps the blob and its obligation, then settles once.
func TestAVoidUnderADoubleFaultKeepsItsEvidenceThenBillsOnce(t *testing.T) {
	ctx := context.Background()
	h := newPairHarness(t)
	id, node, _, onNode := unreachableAfterCommit(t, h, "616161")
	sess := h.session(t, id)
	claimDone(t, h, id)
	node.failProbe.Store(false)
	node.failAfterCommit.Store(false)
	refuseBillingWrites(t, h, true, true)
	// Past every room deadline: GC's pair-room backstop voids the room (the
	// database phase and the physical phase) inside this sweep, under the fault.
	h.advance(7 * 3600)
	gcSweep(h)
	if room, found, err := h.store.GetPairRoom(ctx, sess.PairRoomID); err != nil || !found || room.ClosedAt == 0 {
		t.Fatalf("setup: room not voided (found=%v err=%v closed=%d)", found, err, room.ClosedAt)
	}
	if got := nodeBlobSize(t, node.dir, sess.BlobKey); got != onNode {
		t.Errorf("EVIDENCE: under the fault the blob holds %d, want %d", got, onNode)
	}
	refuseBillingWrites(t, h, false, false)
	gcSweep(h)
	gcSweep(h)
	if got := h.uploadMetered(t); got != onNode {
		t.Errorf("BACKFILL: metered %d after recovery, want exactly %d", got, onNode)
	}
}

// firstPairRoomObject is the oldest pair-room stored object.
func (h *pairHarness) firstPairRoomObject(t *testing.T) string {
	t.Helper()
	var id string
	if err := h.store.db.QueryRow(`SELECT id FROM stored_files WHERE purpose = ? ORDER BY created_at LIMIT 1`,
		StoredPurposePairRoom).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
