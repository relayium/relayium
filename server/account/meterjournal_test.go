package account

import (
	"bytes"
	"context"
	"io"
	"log"
	"testing"
	"time"
)

// Fifth adversarial suite: what happens to a bill when the database refuses it
// at the ONE moment the number cannot be re-derived.
//
// Every other bill in this package is written in the same transaction as the
// state change it belongs to, so it cannot be half-done. Two are not, and cannot
// be: they charge for the size of a partial blob, learned by asking a node, and
// then delete the blob. Both used to log a RecordMeter failure and carry on to
// the delete — destroying the only remaining copy of the number, in the one code
// path whose entire purpose is to charge for bytes nothing else recorded.
//
// The rule these tests hold: UNKNOWN (nobody could ask) may be written off, but
// KNOWN (somebody answered) stays billed — through a database that is refusing
// writes, and through this process dying afterwards.

// owedBills reads the outbox directly, so a test asserts about durable state
// rather than about a return value.
func owedBills(t *testing.T, h *pairHarness) []UnbilledMeter {
	t.Helper()
	rows, err := h.store.db.Query(`SELECT id, user_id, kind, bytes, at, reason FROM unbilled_meter ORDER BY at`)
	if err != nil {
		t.Fatalf("read owed bills: %v", err)
	}
	defer rows.Close()
	var out []UnbilledMeter
	for rows.Next() {
		var m UnbilledMeter
		var kind int
		if err := rows.Scan(&m.ID, &m.UserID, &kind, &m.Bytes, &m.At, &m.Reason); err != nil {
			t.Fatalf("scan owed bill: %v", err)
		}
		m.Kind = UsageKind(kind)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("owed bills: %v", err)
	}
	return out
}

// bareGC is a GC with nothing wired but the store, for driving the passes that
// need no service (the owed-bill retry, the orphan queue).
func bareGC(h *pairHarness) *GC {
	return &GC{Store: h.store, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
}

// THE PROBE'S ANSWER SURVIVES A DATABASE THAT SAYS NO.
//
// A room times out holding an upload whose node committed more than any append
// recorded. The void probes the blob — this is the last instant anything will
// ever know that number, because the delete on the next line destroys it — and
// the meter write fails. The bytes must not evaporate.
func TestAProbedResidualIsNotLostToAMeterWriteThatFails(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	uploadID, node, known, onNode := unreachableAfterCommit(t, h, "747474")
	sess := h.session(t, uploadID)
	if onNode <= known {
		t.Fatalf("the fixture staged no unrecorded bytes: node %d, known %d", onNode, known)
	}
	// The node is back, so the residual IS knowable at void time. What is broken
	// is the database's ability to record it on the meter.
	node.failProbe.Store(false)
	node.failAfterCommit.Store(false)
	flaky := h.withFlakyStore(t)
	flaky.failNext("SettleBlobBilling", -1) // the meter refuses for the whole void

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)

	// The meter has not moved past what the close transaction billed...
	if got := h.uploadMetered(t); got != known {
		t.Fatalf("metered %d with RecordMeter failing, want the %d the close settled", got, known)
	}
	// ...because the residual is written down instead. This row is the whole
	// point: it survives this process.
	owed := owedBills(t, h)
	if len(owed) != 1 {
		t.Fatalf("owed bills = %+v, want the one residual the probe learned", owed)
	}
	if owed[0].Bytes != onNode-known {
		t.Fatalf("owed %d bytes, want the %d the blob held beyond what was billed", owed[0].Bytes, onNode-known)
	}
	if owed[0].UserID != h.userID || owed[0].Kind != MeterUpload {
		t.Fatalf("owed bill is attributed to %s/%v, want %s/upload", owed[0].UserID, owed[0].Kind, h.userID)
	}

	// And none of the room's other promises were traded for it: the journal made
	// the bill durable, so the row is gone and the blob is gone — a mere meter
	// refusal does not hold ciphertext.
	if h.sessionExists(t, uploadID) {
		t.Fatal("the session survived, so the room's deadline was traded for billing accuracy")
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("the ciphertext survived a void although the journal had already made its bill durable")
	}

	// The database recovers. GC settles the bill exactly once.
	flaky.failNext("SettleBlobBilling", 0)
	g := bareGC(h)
	g.settleOwedBills(ctx)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("metered %d after the retry, want the %d bytes the blob really held", got, onNode)
	}
	if owed := owedBills(t, h); len(owed) != 0 {
		t.Fatalf("owed bills after settling = %+v, want none", owed)
	}
	// Idempotent: a second sweep must not charge again.
	g.settleOwedBills(ctx)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("metered %d after a second sweep, want %d — the outbox double-billed", got, onNode)
	}
}

// The same failure on the other path: an append that is still streaming when its
// room is voided underneath it. Its bytes crossed the wire, they buy no
// deadline, and the blob they landed on is deleted by the request itself — so a
// meter write that fails there has exactly one chance to be remembered.
func TestBytesAppendedIntoAVoidedRoomAreNotLostToAMeterWriteThatFails(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	node := newHeldPatchNode(t)
	h.registerStorageNode(t, node.URL)
	uploadID := h.initOnNode(t, "757575")
	sess := h.session(t, uploadID)
	billedBefore := h.uploadMetered(t)

	blob := bytes.Repeat([]byte("V"), 4096)
	node.hold = make(chan struct{})
	node.started = make(chan struct{})
	done := make(chan int, 1)
	go func() { done <- h.patch(t, uploadID, blob, 0, len(blob), len(blob)) }()
	select {
	case <-node.started:
	case <-time.After(10 * time.Second):
		t.Fatal("the append never reached the node")
	}

	// The void runs to completion while the append is suspended mid-write, and
	// only THEN does the database start refusing meter writes — so the close's own
	// settlement is untouched and the failure lands exactly on the append's
	// self-settlement.
	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)
	flaky := h.withFlakyStore(t)
	flaky.failNext("SettleBlobBilling", -1)

	close(node.hold)
	var status int
	select {
	case status = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the released append never returned")
	}
	if status != 410 {
		t.Fatalf("an append into a voided room: %d, want 410", status)
	}

	if got := h.uploadMetered(t); got != billedBefore {
		t.Fatalf("metered %d with RecordMeter failing, want %d", got, billedBefore)
	}
	owed := owedBills(t, h)
	if len(owed) != 1 || owed[0].Bytes != int64(len(blob)) {
		t.Fatalf("owed bills = %+v, want one row for the %d bytes that landed after the void", owed, len(blob))
	}
	// The cleanup the 410 is claiming happened anyway.
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("the released append's bytes are still on the node because the meter write failed")
	}
	assertQueuedForDeletion(t, h, sess.BlobKey)

	// GC settles it, through the ordinary sweep rather than a hand-called pass —
	// so this also pins the outbox being WIRED IN, not merely present.
	flaky.failNext("SettleBlobBilling", 0)
	bareGC(h).sweep(ctx)
	if got := h.uploadMetered(t); got != billedBefore+int64(len(blob)) {
		t.Fatalf("metered %d after GC settled the outbox, want %d", got, billedBefore+int64(len(blob)))
	}
	if owed := owedBills(t, h); len(owed) != 0 {
		t.Fatalf("owed bills after the sweep = %+v, want none", owed)
	}
}

// A CRASH between the two is what makes the outbox worth having. The row is
// written, the process dies before GC ever runs, a new one starts against the
// same database — and the bill is still owed and still settles.
func TestAnOwedBillSurvivesTheProcessThatOwedIt(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	if err := h.store.EnqueueUnbilledMeter(ctx, UnbilledMeter{
		UserID: h.userID, Kind: MeterUpload, Bytes: 4321, At: h.now, Reason: "crash test",
	}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	// Nothing in memory carries this: a fresh service over the same file settles
	// it, which is exactly the restart case.
	if got := h.uploadMetered(t); got != 0 {
		t.Fatalf("metered %d before the retry, want 0", got)
	}
	bareGC(h).settleOwedBills(ctx)
	if got := h.uploadMetered(t); got != 4321 {
		t.Fatalf("metered %d, want the 4321 bytes the dead process owed", got)
	}
}

// pendingRowFor fetches the durable delete-intent row for one blob key.
func pendingRowFor(t *testing.T, h *pairHarness, blobKey string) PendingNodeDelete {
	t.Helper()
	rows, err := h.store.ListPendingNodeDeletes(context.Background())
	if err != nil {
		t.Fatalf("list pending deletes: %v", err)
	}
	for _, p := range rows {
		if p.BlobKey == blobKey {
			return p
		}
	}
	t.Fatalf("no pending delete row for blob %q", blobKey)
	return PendingNodeDelete{}
}

// The floor, and it is not a write-off. When the database refuses the meter AND
// the journal, nothing durable can be written about the residual — so the BLOB
// is the bill now, and destroying it would destroy the only copy of the number.
// The session is still gone (the close's transaction landed long before), but
// the ciphertext stays, owned by the delete-intent row the close queued, and GC
// is not allowed to delete it either until it has first made the bill durable.
// When the database recovers, the next sweep settles the residual — exactly
// once, however many sweeps follow — and only then removes the blob.
func TestADoubleBillingFailureKeepsTheBlobUntilItsBillIsDurable(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	uploadID, node, known, onNode := unreachableAfterCommit(t, h, "767676")
	sess := h.session(t, uploadID)
	node.failProbe.Store(false)
	node.failAfterCommit.Store(false)
	flaky := h.withFlakyStore(t)
	flaky.failNext("SettleBlobBilling", -1)
	flaky.failNext("JournalBlobBilling", -1)

	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(ctx, h.now)

	if got := h.uploadMetered(t); got != known {
		t.Fatalf("metered %d, want the %d the close settled before anything failed", got, known)
	}
	if flaky.callCount("JournalBlobBilling") == 0 {
		t.Fatal("the residual was never even attempted as a durable note")
	}
	if h.sessionExists(t, uploadID) {
		t.Fatal("the session survived a failure the room's deadline outranks")
	}
	// THE BLOB SURVIVES. It is the residual's only remaining evidence, and its
	// durable owner — the intent row the close wrote — survives with it, still
	// carrying the obligation at the floor the close made durable.
	if !nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatalf("a double billing failure deleted the only evidence of a %d-byte residual", onNode-known)
	}
	assertQueuedForDeletion(t, h, sess.BlobKey)
	p := pendingRowFor(t, h, sess.BlobKey)
	if p.BillUserID != h.userID || p.BilledThrough != known {
		t.Fatalf("obligation on the intent row = %q through %d, want %q through %d",
			p.BillUserID, p.BilledThrough, h.userID, known)
	}

	// GC runs while the database is STILL refusing: it must not delete the blob
	// out from under a bill that is not durable yet.
	g := &GC{Store: flaky, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0),
		BlobFor: h.svc.blobFor}
	g.sweep(ctx)
	if !nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("GC deleted the blob while its bill was still not durable")
	}
	if got := h.uploadMetered(t); got != known {
		t.Fatalf("metered %d while every billing write was failing, want %d", got, known)
	}

	// The database recovers. The next sweep FIRST makes the bill durable — by
	// asking the blob, the evidence that was kept for exactly this — and only
	// THEN deletes it.
	flaky.failNext("SettleBlobBilling", 0)
	flaky.failNext("JournalBlobBilling", 0)
	g.sweep(ctx)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("metered %d after recovery, want the %d bytes the blob really held", got, onNode)
	}
	if nodeBlobPresent(t, node.dir, sess.BlobKey) {
		t.Fatal("the blob survived the sweep that settled its bill")
	}

	// Idempotent: a later sweep bills nothing more — the floor moved with the
	// meter in one transaction, so the residual cannot be charged twice.
	g.sweep(ctx)
	if got := h.uploadMetered(t); got != onNode {
		t.Fatalf("metered %d after a second sweep, want %d — the retry double-billed", got, onNode)
	}
}
