package account

// A FAILED append that lands after its pairing room's void (W-N36 I9 / W-N41).
//
// The ordering under test: an append is streaming to a real node when the room
// times out. The node commits the bytes and then answers 500, and that answer
// is held in a proxy until the void has run to completion. The void probes the
// blob, sees bytes no append recorded, and — when the database refuses both the
// meter and the journal — correctly keeps the blob as the bill's evidence under
// the delete intent it queued at close. Then the held 500 is released, the
// handler learns the room is over, and settles its own late append.
//
// The rule: that late settlement is NOT a second destroyer. Whatever the append
// itself returned, the blob may be deleted only once what it holds is durably
// billed (metered, or journaled with the intent row's floor advanced); when
// that cannot be done, or the blob cannot even be asked, the blob and its
// intent row stay for GC's drain, which bills before it deletes. Every test
// drives the real handler over real HTTP to a real DiskStore node, the real
// SweepPairRooms and the real GC sweep, and ends with a SECOND sweep to pin
// that the bill lands exactly once.

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	lateAckedBytes   = 1200 // acknowledged, recorded and billed before the void
	lateOnNodeBytes  = 4200 // what the node really holds once the failed append committed
	lateAppendChunks = lateOnNodeBytes - lateAckedBytes
)

// lateAppend is one held, failed, post-void append and everything a test needs
// to finish it.
type lateAppend struct {
	h     *pairHarness
	node  *commitThenFailNode
	flaky *flakyStore
	sess  UploadSessionRow
	done  chan int
	// release lets the node's held 500 go back to central's handler.
	release func()
	// refuseProbes makes the proxy answer the next N zero-byte read-back probes
	// with 500 without forwarding them — a node that flaps between two probes.
	refuseProbes *atomic.Int32
}

// startLateFailedAppend opens a pre-upload on a real node, acknowledges the
// first lateAckedBytes, then sends the rest through a proxy that lets the node
// commit it and answer 500, and holds that answer. It returns with the append
// suspended AFTER the node's commit and BEFORE central has heard anything, and
// with a flakyStore installed (nothing failing yet). prepare runs before the
// failing append is sent, for fixtures that must change the session row the
// handler is about to read.
func startLateFailedAppend(t *testing.T, code string, prepare func(h *pairHarness, uploadID string)) *lateAppend {
	t.Helper()
	h := newPairHarness(t)
	n := newCommitThenFailNode(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var armed atomic.Bool
	refuseProbes := new(atomic.Int32)
	unblock := func() { once.Do(func() { close(release) }) }
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		if r.Method == http.MethodPatch && len(body) == 0 && refuseProbes.Load() > 0 {
			refuseProbes.Add(-1)
			http.Error(w, "probe refused", http.StatusInternalServerError)
			return
		}
		rec := httptest.NewRecorder()
		n.Config.Handler.ServeHTTP(rec, r)
		if armed.Load() && r.Method == http.MethodPatch && len(body) > 0 {
			// The node has ALREADY committed; only its answer is held.
			armed.Store(false)
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		for k, v := range rec.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	}))
	t.Cleanup(proxy.Close)
	t.Cleanup(unblock)

	h.registerStorageNode(t, proxy.URL)
	uploadID := h.initOnNode(t, code)
	payload := bytes.Repeat([]byte("L"), lateOnNodeBytes)
	if got := h.patch(t, uploadID, payload, 0, lateAckedBytes, lateOnNodeBytes); got != 200 {
		t.Fatalf("acknowledged chunk: %d", got)
	}
	if prepare != nil {
		prepare(h, uploadID)
	}
	sess := h.session(t, uploadID)
	flaky := h.withFlakyStore(t)

	n.failAfterCommit.Store(true)
	armed.Store(true)
	done := make(chan int, 1)
	go func() { done <- h.patch(t, uploadID, payload, lateAckedBytes, lateOnNodeBytes, lateOnNodeBytes) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the failing append's response was never held")
	}
	if got := nodeBlobSize(t, n.dir, sess.BlobKey); got != lateOnNodeBytes {
		t.Fatalf("the node holds %d bytes before the void, want %d", got, lateOnNodeBytes)
	}
	return &lateAppend{h: h, node: n, flaky: flaky, sess: sess, done: done, release: unblock, refuseProbes: refuseProbes}
}

// voidRoom times the room out and runs the real void to completion.
func (l *lateAppend) voidRoom() {
	l.h.advance(pairRoomJoinWindow + 1)
	l.h.svc.SweepPairRooms(context.Background(), l.h.now)
}

// failBilling makes every durable billing rung refuse (meter and journal), or
// heals both.
func (l *lateAppend) failBilling(fail bool) {
	times := 0
	if fail {
		times = -1
	}
	l.flaky.failNext("SettleBlobBilling", times)
	l.flaky.failNext("JournalBlobBilling", times)
}

// finish releases the held 500 and waits for central's answer, which must be
// the room's 410.
func (l *lateAppend) finish(t *testing.T) {
	t.Helper()
	l.release()
	select {
	case code := <-l.done:
		if code != 410 {
			t.Fatalf("the late append answered %d, want 410", code)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the released append never returned")
	}
}

// sweep runs the whole real GC pass — drainPending AND the owed-bill outbox —
// through the (possibly still flaky) service store and the service's own node
// resolution.
func (l *lateAppend) sweep() {
	(&GC{Store: l.flaky, Now: func() int64 { return l.h.now }, Log: log.New(io.Discard, "", 0),
		BlobFor: l.h.svc.blobFor}).sweep(context.Background())
}

func (l *lateAppend) blobPresent(t *testing.T) bool {
	t.Helper()
	return nodeBlobPresent(t, l.node.dir, l.sess.BlobKey)
}

// assertEvidenceKept is the state a late append must leave when it could not
// make the bill durable: the bytes on the node, the obligation still on its
// intent row at the floor the close recorded, and nothing extra billed.
func (l *lateAppend) assertEvidenceKept(t *testing.T, why string) {
	t.Helper()
	if !l.blobPresent(t) {
		t.Fatalf("%s: the late append deleted the only evidence of %d unbilled bytes", why, lateAppendChunks)
	}
	p := pendingRowFor(t, l.h, l.sess.BlobKey)
	if p.BillUserID == "" || p.BilledThrough != lateAckedBytes {
		t.Fatalf("%s: intent row = %+v, want the close's obligation still at floor %d", why, p, lateAckedBytes)
	}
	if got := l.h.uploadMetered(t); got != lateAckedBytes {
		t.Fatalf("%s: metered %d, want the %d the close billed", why, got, lateAckedBytes)
	}
	if owed := owedBills(t, l.h); len(owed) != 0 {
		t.Fatalf("%s: owed bills = %+v, want none", why, owed)
	}
}

// assertBilledOnceAndGone sweeps twice and requires the whole blob billed
// exactly once, nothing owed, and the ciphertext gone.
func (l *lateAppend) assertBilledOnceAndGone(t *testing.T, want int64) {
	t.Helper()
	for i := 1; i <= 2; i++ {
		l.sweep()
		if got := l.h.uploadMetered(t); got != want {
			t.Fatalf("sweep %d: metered %d, want %d exactly once", i, got, want)
		}
		if owed := owedBills(t, l.h); len(owed) != 0 {
			t.Fatalf("sweep %d: owed bills = %+v, want none", i, owed)
		}
		if l.blobPresent(t) {
			t.Fatalf("sweep %d: the blob is still on the node after its bill is durable", i)
		}
	}
}

// THE FINDING. The void kept the blob because nothing durable could be written;
// the database is still refusing when the late append's 500 is released. The
// late append must leave the blob and the obligation for GC, and GC, once the
// database heals, bills all 4200 bytes — once.
func TestAFailedLateAppendKeepsTheVoidsUnsettledEvidence(t *testing.T) {
	l := startLateFailedAppend(t, "838301", nil)
	l.failBilling(true)
	l.voidRoom()
	l.assertEvidenceKept(t, "after the void")

	l.finish(t)
	l.assertEvidenceKept(t, "after the failed late append")

	l.failBilling(false)
	l.assertBilledOnceAndGone(t, lateOnNodeBytes)
}

// The database heals between the void and the late append's release. The late
// append is then the first thing able to settle the residual: it bills it
// directly, deletes the blob, and GC finds nothing left to charge.
func TestAFailedLateAppendSettlesTheResidualWhenItCan(t *testing.T) {
	l := startLateFailedAppend(t, "838302", nil)
	l.failBilling(true)
	l.voidRoom()
	l.assertEvidenceKept(t, "after the void")

	l.failBilling(false)
	l.finish(t)
	if got := l.h.uploadMetered(t); got != lateOnNodeBytes {
		t.Fatalf("metered %d after the late append settled, want %d", got, lateOnNodeBytes)
	}
	if l.blobPresent(t) {
		t.Fatal("the late append made the bill durable but left the blob")
	}
	if p := pendingRowFor(t, l.h, l.sess.BlobKey); p.BilledThrough != lateOnNodeBytes {
		t.Fatalf("intent floor = %d, want %d — the bill is not recorded against the obligation", p.BilledThrough, lateOnNodeBytes)
	}
	l.assertBilledOnceAndGone(t, lateOnNodeBytes)
}

// Only the meter refuses. The late append's settlement falls to the journal
// rung — floor advanced with the outbox row — so the blob may go, and GC moves
// the owed bill onto the meter exactly once.
func TestAFailedLateAppendJournalsTheResidualWhenTheMeterRefuses(t *testing.T) {
	l := startLateFailedAppend(t, "838303", nil)
	l.failBilling(true)
	l.voidRoom()

	l.flaky.failNext("JournalBlobBilling", 0)
	l.finish(t)
	if got := l.h.uploadMetered(t); got != lateAckedBytes {
		t.Fatalf("metered %d with the meter refusing, want %d", got, lateAckedBytes)
	}
	owed := owedBills(t, l.h)
	if len(owed) != 1 || owed[0].Bytes != lateAppendChunks {
		t.Fatalf("owed bills = %+v, want one row for the %d-byte residual", owed, lateAppendChunks)
	}
	if l.blobPresent(t) {
		t.Fatal("the residual is journaled but the blob was kept")
	}
	l.flaky.failNext("SettleBlobBilling", 0)
	l.assertBilledOnceAndGone(t, lateOnNodeBytes)
}

// UNKNOWN is not ZERO. Billing is healthy by the time the late append returns,
// but the node now refuses the read-back probe: nothing can learn what the blob
// holds, so nothing may delete it. When the node answers again, GC bills and
// then deletes.
func TestAFailedLateAppendThatCannotAskTheBlobKeepsIt(t *testing.T) {
	l := startLateFailedAppend(t, "838304", nil)
	l.failBilling(true)
	l.voidRoom()

	l.failBilling(false)
	l.node.failProbe.Store(true)
	l.finish(t)
	l.assertEvidenceKept(t, "after a late append that could not probe")

	l.sweep()
	if !l.blobPresent(t) || l.h.uploadMetered(t) != lateAckedBytes {
		t.Fatal("GC deleted or billed a blob it could not ask")
	}
	l.node.failProbe.Store(false)
	l.assertBilledOnceAndGone(t, lateOnNodeBytes)
}

// CONTROL: nothing fails but the append's own response. The void bills the
// residual and deletes the blob before the 500 is released; the late append
// must not charge it a second time.
func TestAFailedLateAppendAfterAHealthyVoidDoesNotBillTwice(t *testing.T) {
	l := startLateFailedAppend(t, "838305", nil)
	l.voidRoom()
	if got := l.h.uploadMetered(t); got != lateOnNodeBytes {
		t.Fatalf("metered %d after a healthy void, want %d", got, lateOnNodeBytes)
	}
	if l.blobPresent(t) {
		t.Fatal("a healthy void left the blob")
	}
	l.finish(t)
	if got := l.h.uploadMetered(t); got != lateOnNodeBytes {
		t.Fatalf("metered %d after the late append, want %d — billed twice", got, lateOnNodeBytes)
	}
	if l.blobPresent(t) {
		t.Fatal("the late append left a blob behind")
	}
	l.assertBilledOnceAndGone(t, lateOnNodeBytes)
}

// CLAMP. The bill for a blob-reported size never exceeds the write budget the
// close recorded on the obligation (bill_max = the session's max_size). The
// handler read its session before max_size was lowered, so this pins that the
// DURABLE row's cap — not the request's stale copy — is what bounds the charge.
func TestAFailedLateAppendIsBilledNoFurtherThanTheObligationsCap(t *testing.T) {
	const capBytes = 3000
	l := startLateFailedAppend(t, "838306", nil)
	if _, err := l.h.store.db.Exec(`UPDATE upload_sessions SET max_size = ? WHERE id = ?`, capBytes, l.sess.ID); err != nil {
		t.Fatalf("lower max_size: %v", err)
	}
	l.failBilling(true)
	l.voidRoom()
	if p := pendingRowFor(t, l.h, l.sess.BlobKey); p.BillMax != capBytes {
		t.Fatalf("obligation cap = %d, want %d", p.BillMax, capBytes)
	}
	l.failBilling(false)
	l.finish(t)
	if got := l.h.uploadMetered(t); got != capBytes {
		t.Fatalf("metered %d, want the %d-byte cap", got, capBytes)
	}
	l.assertBilledOnceAndGone(t, capBytes)
}

// OWN NODE. A non-billable upload spends the user's own disk: nothing is ever
// metered or journaled for it, and nothing about billing may keep its blob.
func TestAFailedLateAppendOnANonBillableUploadChargesNothingAndDeletes(t *testing.T) {
	l := startLateFailedAppend(t, "838307", func(h *pairHarness, uploadID string) {
		if _, err := h.store.db.Exec(`UPDATE upload_sessions SET billable = 0 WHERE id = ?`, uploadID); err != nil {
			t.Fatalf("mark own-node: %v", err)
		}
	})
	l.failBilling(true)
	l.voidRoom()
	if p := pendingRowFor(t, l.h, l.sess.BlobKey); p.BillUserID != "" {
		t.Fatalf("own-node intent row carries an obligation: %+v", p)
	}
	l.finish(t)
	if l.blobPresent(t) {
		t.Fatal("an own-node blob was kept for a bill that can never exist")
	}
	if got := l.h.uploadMetered(t); got != lateAckedBytes {
		t.Fatalf("metered %d, want %d (only what the billable prefix was charged before the flip)", got, lateAckedBytes)
	}
	if owed := owedBills(t, l.h); len(owed) != 0 {
		t.Fatalf("own-node owed bills = %+v", owed)
	}
	l.failBilling(false)
	l.assertBilledOnceAndGone(t, lateAckedBytes)
}

// THE VOID THAT DID NOT HAPPEN. The late append finds the room past its deadline
// and tries to void it itself, and the close transaction fails — so the session
// row still exists, still owns the blob, and no intent row carries an
// obligation. The request still answers 410 (fail closed), but it must delete
// nothing: its first read-back probe could not size the blob, a second one
// can, and a settle against a missing obligation "succeeds" by charging
// nothing. Deleting on that answer would leave the session at 1200 bytes with
// its evidence gone. The retried void bills all 4200 and then deletes.
func TestAFailedLateAppendLeavesTheBlobToASessionTheVoidCouldNotClose(t *testing.T) {
	l := startLateFailedAppend(t, "838308", nil)
	l.h.advance(pairRoomJoinWindow + 1) // over, but nothing has voided it yet
	l.flaky.failNext("ClosePairRoom", -1)
	l.refuseProbes.Store(1) // the handler's own probe fails; the next one answers
	l.finish(t)

	if !l.blobPresent(t) {
		t.Fatal("a late append deleted a blob its still-open session owns")
	}
	if got := l.h.session(t, l.sess.ID).Received; got != lateAckedBytes {
		t.Fatalf("session offset = %d, want %d (nothing sized the blob for it)", got, lateAckedBytes)
	}
	if got := l.h.uploadMetered(t); got != lateAckedBytes {
		t.Fatalf("metered %d, want %d", got, lateAckedBytes)
	}

	l.flaky.failNext("ClosePairRoom", 0)
	l.h.svc.SweepPairRooms(context.Background(), l.h.now)
	if l.h.sessionExists(t, l.sess.ID) {
		t.Fatal("the retried void did not end the session")
	}
	if got := l.h.uploadMetered(t); got != lateOnNodeBytes {
		t.Fatalf("metered %d after the retried void, want %d", got, lateOnNodeBytes)
	}
	l.assertBilledOnceAndGone(t, lateOnNodeBytes)
}
