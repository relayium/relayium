package account

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/storage"
)

func gcMeteredUpload(t *testing.T, st *SQLiteStore, userID string) int64 {
	t.Helper()
	var n int64
	if err := st.db.QueryRow(`SELECT COALESCE(SUM(upload_bytes), 0) FROM usage_monthly WHERE user_id = ?`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func pendingRow(t *testing.T, st *SQLiteStore, key, node string) (PendingNodeDelete, bool) {
	t.Helper()
	all, err := st.ListPendingNodeDeletes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range all {
		if p.BlobKey == key && p.NodeID == node {
			return p, true
		}
	}
	return PendingNodeDelete{}, false
}

// MUST-FIX 1. Many stalled nodes at the head of the queue, healthy blobs and a
// billing obligation behind them, a pass budget that cannot get through the
// stalled ones in one sweep. The GUARANTEE asserted is at most maxSweeps (4)
// consecutive sweeps before every healthy blob is deleted and the obligation
// is settled exactly once; the count actually needed is logged (2 in the runs
// so far) but not asserted, because it depends on wall-clock timeouts under the
// fixture budgets. The budget alone would leave them behind the same stalled
// rows forever.
func TestStalledNodesAtTheHeadDoNotStarveTheQueue(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	shrink(t, &nodeDeleteTimeout, 200*time.Millisecond)
	shrink(t, &gcPassBudget, 700*time.Millisecond)

	// Six stalled nodes, one queued blob each, queued FIRST and with keys that
	// sort first too, so neither enqueue order nor table order puts them last.
	var stalledKeys []string
	for i := 0; i < 6; i++ {
		n := newStalledTLSNode(t)
		id := h.registerStorageNode(t, n.URL())
		k := fmt.Sprintf("0%031d", i)
		stalledKeys = append(stalledKeys, k)
		if err := enqueueNodeDeleteOn(ctx, h.store.db, k, id, h.now-1000+int64(i), 0); err != nil {
			t.Fatal(err)
		}
	}
	healthy := newCleanupNode(t)
	healthyID := h.registerStorageNode(t, healthy.URL)
	var healthyKeys []string
	for i := 0; i < 3; i++ {
		k := fmt.Sprintf("f%031d", i)
		healthyKeys = append(healthyKeys, k)
		putOnNode(t, healthy.dir, k)
		if err := enqueueNodeDeleteOn(ctx, h.store.db, k, healthyID, h.now, 0); err != nil {
			t.Fatal(err)
		}
	}
	// The billing obligation: 3000 bytes on the blob, nothing billed yet.
	billKey := "f" + strings.Repeat("9", 31)
	ds, _ := storage.NewDiskStore(healthy.dir)
	if _, err := ds.Put(ctx, billKey, strings.NewReader(strings.Repeat("B", 3000))); err != nil {
		t.Fatal(err)
	}
	if err := enqueueBilledNodeDeleteOn(ctx, h.store.db, billKey, healthyID, h.now, 0, h.userID, MeterUpload, 10000, 0); err != nil {
		t.Fatal(err)
	}
	before := gcMeteredUpload(t, h.store, h.userID)

	g := &GC{Store: h.store, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	done := func() bool {
		for _, k := range append(append([]string{}, healthyKeys...), billKey) {
			if nodeBlobPresent(t, healthy.dir, k) {
				return false
			}
		}
		return true
	}
	const maxSweeps = 4
	sweeps := 0
	for sweeps < maxSweeps && !done() {
		g.sweep(ctx)
		sweeps++
	}
	if !done() {
		t.Fatalf("after %d sweeps the healthy node's blobs are still there behind the stalled ones", sweeps)
	}
	t.Logf("healthy blobs and the obligation cleared in %d sweep(s)", sweeps)
	if got := gcMeteredUpload(t, h.store, h.userID) - before; got != 3000 {
		t.Fatalf("the obligation billed %d bytes, want exactly 3000", got)
	}
	for _, k := range append(healthyKeys, billKey) {
		if _, ok := pendingRow(t, h.store, k, healthyID); ok {
			t.Fatalf("%s still queued after its delete landed", k)
		}
	}
	for _, k := range stalledKeys {
		if len(queuedFor(t, h, k)) != 1 {
			t.Fatalf("stalled blob %s is no longer queued", k)
		}
	}
	// And the billing is not repeated by further sweeps.
	g.sweep(ctx)
	if got := gcMeteredUpload(t, h.store, h.userID) - before; got != 3000 {
		t.Fatalf("a later sweep changed the bill to %d", got)
	}
}

// tripCtx is a context that cancels itself on the n-th time anything asks it
// whether it is done — a stand-in for a pass deadline landing at an arbitrary
// point inside a transaction. Iterating n moves the cancellation through the
// context checks the call happens to make in that run. That count includes
// database/sql's own checks and is NOT a list of named SQL boundaries, so the
// walk is a broad sample, not an exhaustive proof; the two boundaries that
// matter most are pinned deterministically by the seams in
// gc_settle_seams_test.go.
type tripCtx struct {
	context.Context
	cancel  context.CancelFunc
	left    atomic.Int32
	tripped atomic.Bool
}

func newTripCtx(n int) *tripCtx {
	c, cancel := context.WithCancel(context.Background())
	tc := &tripCtx{Context: c, cancel: cancel}
	tc.left.Store(int32(n))
	return tc
}

func (c *tripCtx) tick() {
	if c.left.Add(-1) == 0 {
		c.tripped.Store(true)
		c.cancel()
	}
}
func (c *tripCtx) Done() <-chan struct{} { c.tick(); return c.Context.Done() }
func (c *tripCtx) Err() error            { c.tick(); return c.Context.Err() }

// MUST-FIX 2(a), the blob obligation. SettleBlobBilling cancelled at each
// observed context check: whatever the cancelled call did is all-or-nothing (the meter moved by
// exactly what the floor moved), and a retry on a live context bills the
// remainder, so the total is exactly the residual — never twice, never short.
func TestSettleBlobBillingCancelledAtObservedPointsBillsExactlyOnce(t *testing.T) {
	const through = 4200
	sawRollback, sawCommit, covered := false, false, false
	for n := 1; n <= 200; n++ {
		st := newTestStore(t)
		ctx := context.Background()
		u, _ := st.UpsertUserByEmail(ctx, fmt.Sprintf("trip%d@example.com", n), "")
		if err := enqueueBilledNodeDeleteOn(ctx, st.db, "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", "", 100, 0, u.ID, MeterUpload, 10000, 1200); err != nil {
			t.Fatal(err)
		}
		tc := newTripCtx(n)
		_, err := st.SettleBlobBilling(tc, "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", "", through, 100)
		p, _ := pendingRow(t, st, "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", "")
		metered := gcMeteredUpload(t, st, u.ID)
		if metered != p.BilledThrough-1200 {
			t.Fatalf("n=%d err=%v: metered %d but the floor moved %d — a half-applied settle", n, err, metered, p.BilledThrough-1200)
		}
		if err != nil {
			sawRollback = true
		} else {
			sawCommit = true
		}
		if _, err := st.SettleBlobBilling(ctx, "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", "", through, 100); err != nil {
			t.Fatalf("n=%d retry: %v", n, err)
		}
		if _, err := st.SettleBlobBilling(ctx, "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", "", through, 100); err != nil {
			t.Fatalf("n=%d second retry: %v", n, err)
		}
		if got := gcMeteredUpload(t, st, u.ID); got != through-1200 {
			t.Fatalf("n=%d: metered %d after retries, want exactly %d", n, got, through-1200)
		}
		if !tc.tripped.Load() {
			t.Logf("cancelled at %d observed context-check points in this run (a sample, not an exhaustive proof)", n-1)
			covered = true
			break // this run made no more context checks than n
		}
	}
	if !covered {
		t.Fatal("the walk never reached a run with no cancellation")
	}
	if !sawRollback || !sawCommit {
		t.Fatalf("the walk never covered both outcomes: rollback=%v commit=%v", sawRollback, sawCommit)
	}
}

// MUST-FIX 2(a), the owed-bills outbox, through GC's own pass: settleOwedBills
// on a context that dies at each observed context check, then a normal pass.
func TestSettleOwedBillsCancelledAtObservedPointsBillsExactlyOnce(t *testing.T) {
	sawRollback, sawCommit, covered := false, false, false
	for n := 1; n <= 200; n++ {
		st := newTestStore(t)
		ctx := context.Background()
		u, _ := st.UpsertUserByEmail(ctx, fmt.Sprintf("owed%d@example.com", n), "")
		for _, b := range []int64{500, 700} {
			if err := st.EnqueueUnbilledMeter(ctx, UnbilledMeter{UserID: u.ID, Kind: MeterUpload, Bytes: b, At: 100, Reason: "test"}); err != nil {
				t.Fatal(err)
			}
		}
		g := &GC{Store: st, Now: func() int64 { return 100 }, Log: log.New(io.Discard, "", 0)}
		tc := newTripCtx(n)
		g.settleOwedBills(tc)
		var left, leftBytes int64
		if err := st.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM unbilled_meter WHERE user_id = ?`, u.ID).Scan(&left, &leftBytes); err != nil {
			t.Fatal(err)
		}
		if got := gcMeteredUpload(t, st, u.ID); got+leftBytes != 1200 {
			t.Fatalf("n=%d: metered %d + still owed %d != 1200 — a bill was lost or doubled", n, got, leftBytes)
		}
		if left != 0 {
			sawRollback = true
		} else {
			sawCommit = true
		}
		g.settleOwedBills(ctx)
		g.settleOwedBills(ctx)
		if got := gcMeteredUpload(t, st, u.ID); got != 1200 {
			t.Fatalf("n=%d: metered %d after retries, want exactly 1200", n, got)
		}
		if !tc.tripped.Load() {
			t.Logf("cancelled at %d observed context-check points in this run (a sample, not an exhaustive proof)", n-1)
			covered = true
			break
		}
	}
	if !covered {
		t.Fatal("the walk never reached a run with no cancellation")
	}
	if !sawRollback || !sawCommit {
		t.Fatalf("the walk never covered both outcomes: rollback=%v commit=%v", sawRollback, sawCommit)
	}
}

// MUST-FIX 2(a), end to end through the drain: probe, settle, delete, clear,
// with the pass context dying at each observed context check. The central blob is billed
// exactly its residual and deleted exactly once the settle is durable.
func TestDrainCancelledAtObservedPointsSettlesThenDeletesExactlyOnce(t *testing.T) {
	sawPartial, sawDone, covered := false, false, false
	for n := 1; n <= 300; n++ {
		st := newTestStore(t)
		ctx := context.Background()
		disk, err := storage.NewDiskStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		u, _ := st.UpsertUserByEmail(ctx, fmt.Sprintf("drain%d@example.com", n), "")
		key := "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1"
		if _, err := disk.Put(ctx, key, strings.NewReader(strings.Repeat("x", 4200))); err != nil {
			t.Fatal(err)
		}
		if err := enqueueBilledNodeDeleteOn(ctx, st.db, key, "", 100, 0, u.ID, MeterUpload, 10000, 1200); err != nil {
			t.Fatal(err)
		}
		g := &GC{Store: st, Blobs: disk, Now: func() int64 { return 100 }, Log: log.New(io.Discard, "", 0)}
		tc := newTripCtx(n)
		g.drainPending(tc)
		p, queued := pendingRow(t, st, key, "")
		metered := gcMeteredUpload(t, st, u.ID)
		_, gerr := disk.Get(ctx, key)
		blobGone := errors.Is(gerr, storage.ErrNotFound)
		if blobGone && metered != 3000 {
			t.Fatalf("n=%d: the blob is gone but only %d of 3000 bytes were billed", n, metered)
		}
		if queued && metered != p.BilledThrough-1200 {
			t.Fatalf("n=%d: metered %d but the floor moved %d", n, metered, p.BilledThrough-1200)
		}
		if queued || !blobGone {
			sawPartial = true
		} else {
			sawDone = true
		}
		g.drainPending(ctx)
		g.drainPending(ctx)
		if got := gcMeteredUpload(t, st, u.ID); got != 3000 {
			t.Fatalf("n=%d: metered %d after retries, want exactly 3000", n, got)
		}
		if _, err := disk.Get(ctx, key); !errors.Is(err, storage.ErrNotFound) {
			t.Fatalf("n=%d: blob still there after retries", n)
		}
		if _, ok := pendingRow(t, st, key, ""); ok {
			t.Fatalf("n=%d: row still queued after retries", n)
		}
		if !tc.tripped.Load() {
			t.Logf("cancelled at %d observed context-check points in this run (a sample, not an exhaustive proof)", n-1)
			covered = true
			break
		}
	}
	if !covered {
		t.Fatal("the walk never reached a run with no cancellation")
	}
	if !sawPartial || !sawDone {
		t.Fatalf("the walk never covered both outcomes: partial=%v done=%v", sawPartial, sawDone)
	}
}

// MUST-FIX 2(b): a successful delete never clears a queue row that carries a
// billing obligation; only the drain, after a durable settle, may.
func TestDischargeKeepsARowWithABillingObligation(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "obligation@example.com", "")
	if err := enqueueBilledNodeDeleteOn(ctx, st.db, "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1", "n1", 100, 0, u.ID, MeterUpload, 5000, 0); err != nil {
		t.Fatal(err)
	}
	if err := enqueueNodeDeleteOn(ctx, st.db, "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", "n1", 100, 0); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1", "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"} {
		if err := st.DischargePendingNodeDelete(ctx, k, "n1", 200); err != nil {
			t.Fatal(err)
		}
	}
	if p, ok := pendingRow(t, st, "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1", "n1"); !ok || p.BillUserID != u.ID || p.BillMax != 5000 {
		t.Fatalf("obligated row after discharge: ok=%v %+v, want kept with its obligation", ok, p)
	}
	if _, ok := pendingRow(t, st, "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", "n1"); ok {
		t.Fatal("the plain row was not discharged")
	}
}

// MUST-FIX 2(c): an intent that cannot be written inside the confirmation
// transaction rolls back the WHOLE deletion — the account, its token, its
// objects, sessions, and the billing hold and cancellation outbox the same
// transaction would have written.
func TestAccountDeletionRollsBackEntirelyWhenAnIntentCannotBeWritten(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	if err := h.store.ConfigureBillingHoldSecret("gc-rollback-test-secret"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.db.Exec(`UPDATE users SET stripe_customer_id = 'cus_rollback' WHERE id = ?`, h.userID); err != nil {
		t.Fatal(err)
	}
	key := "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"
	if _, err := h.disk.Put(ctx, key, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if err := h.store.CreateStoredFile(ctx, StoredFile{ID: "rb-file", UserID: h.userID, BlobKey: key,
		EncManifest: []byte{1}, Size: 1, CreatedAt: h.now, ExpiresAt: h.now + 3600, Purpose: StoredPurposeShare}); err != nil {
		t.Fatal(err)
	}
	if err := h.store.CreateSession(ctx, Session{ID: "rb-session", UserID: h.userID, CreatedAt: h.now, ExpiresAt: h.now + 3600}); err != nil {
		t.Fatal(err)
	}
	u, err := h.store.GetUserByID(ctx, h.userID)
	if err != nil {
		t.Fatal(err)
	}
	tokenHash := authx.HashToken("rb-raw")
	if err := h.store.CreateEmailToken(ctx, EmailToken{TokenHash: tokenHash, UserID: u.ID, Email: u.Email,
		Purpose: "delete", CreatedAt: h.now, ExpiresAt: h.now + 3600}); err != nil {
		t.Fatal(err)
	}
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := h.store.db.QueryRow(q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	snapshot := func() map[string]int {
		return map[string]int{
			"deleted_at":  count(`SELECT deleted_at FROM users WHERE id = ?`, h.userID),
			"token_used":  count(`SELECT used_at FROM email_tokens WHERE token_hash = ?`, tokenHash),
			"reactivate":  count(`SELECT COUNT(*) FROM email_tokens WHERE user_id = ? AND purpose = 'reactivate'`, h.userID),
			"files":       count(`SELECT COUNT(*) FROM stored_files WHERE user_id = ?`, h.userID),
			"sessions":    count(`SELECT COUNT(*) FROM sessions WHERE user_id = ?`, h.userID),
			"outbox":      count(`SELECT COUNT(*) FROM billing_cancellation_outbox WHERE billing_subject_id = ?`, h.userID),
			"holds":       count(`SELECT COUNT(*) FROM billing_deletion_holds WHERE billing_subject_id = ?`, h.userID),
			"upload_epoc": count(`SELECT upload_epoch FROM users WHERE id = ?`, h.userID),
			"queue":       count(`SELECT COUNT(*) FROM pending_node_deletes`),
		}
	}
	before := snapshot()
	heal := failPendingInserts(t, h.store)
	if err := h.svc.ConfirmAccountDeletion(ctx, "rb-raw"); err == nil {
		t.Fatal("confirmation succeeded although its delete intents could not be written")
	}
	after := snapshot()
	for k, v := range before {
		if after[k] != v {
			t.Fatalf("%s changed %d -> %d: the failed confirmation was not rolled back as a whole (before=%v after=%v)", k, v, after[k], before, after)
		}
	}
	if _, err := h.disk.Get(ctx, key); err != nil {
		t.Fatalf("a blob was deleted by a confirmation that rolled back: %v", err)
	}
	// Control: the same confirmation with the queue healthy does write the
	// outbox and hold this test says were rolled back.
	heal()
	react := EmailToken{TokenHash: authx.HashToken("rb-react"), UserID: u.ID, Purpose: "reactivate", CreatedAt: h.now, ExpiresAt: h.now + 86400}
	if _, committed, err := h.store.CommitAccountDeletion(ctx, tokenHash, u, h.now, h.now+86400, react); err != nil || !committed {
		t.Fatalf("control commit: committed=%v err=%v", committed, err)
	}
	ok := snapshot()
	if ok["outbox"] != 1 || ok["holds"] != 1 || ok["deleted_at"] == 0 || ok["queue"] != 1 {
		t.Fatalf("control commit wrote %v; the rollback assertions above would be vacuous", ok)
	}
}

// MUST-FIX 2(d): the pass running out of budget is not the node's fault, so a
// node whose delete was cut short by the PASS deadline is asked again by the
// next pass of the same sweep instead of being marked stalled.
func TestAPassDeadlineDoesNotMarkTheNodeStalled(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	shrink(t, &gcPassBudget, 300*time.Millisecond) // nodeDeleteTimeout stays 20 s
	deletes := countCleanupDeletes(h)
	node := newCleanupNode(t)
	node.deleteMode.Store(2)
	nodeID := h.registerStorageNode(t, node.URL)
	key := "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"
	putOnNode(t, node.dir, key)
	if err := h.store.CreateStoredFile(ctx, StoredFile{ID: "pd-file", UserID: h.userID, BlobKey: key,
		EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: h.now - 10, NodeID: nodeID}); err != nil {
		t.Fatal(err)
	}
	g := &GC{Store: h.store, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	g.sweep(ctx)
	// One DELETE from the expiry pass (cut by its budget), one from the drain.
	if n := deletes.n.Load(); n != 2 {
		t.Fatalf("%d DELETE(s) in one sweep, want 2: the expiry pass's deadline marked a healthy-but-slow node stalled", n)
	}
	// Direct check of the rule, both ways.
	mctx := withStalledNodes(ctx)
	expired, cancel := context.WithTimeout(mctx, 0)
	defer cancel()
	<-expired.Done()
	noteNodeErr(expired, "n-pass", context.DeadlineExceeded)
	noteNodeErr(mctx, "n-node", context.DeadlineExceeded)
	if nodeStalled(mctx, "n-pass") || !nodeStalled(mctx, "n-node") {
		t.Fatalf("memo: pass-deadline node stalled=%v (want false), node-timeout node stalled=%v (want true)",
			nodeStalled(mctx, "n-pass"), nodeStalled(mctx, "n-node"))
	}
}

// MUST-FIX 2(e): the account-deletion cleanup running out of its overall
// budget returns promptly and leaves every blob it did not reach queued.
func TestAccountDeletionCleanupOutOfBudgetLeavesIntentsQueued(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	shrink(t, &accountDeletionReclaimBudget, 400*time.Millisecond) // per delete stays 20 s
	node := newCleanupNode(t)
	node.deleteMode.Store(2)
	nodeID := h.registerStorageNode(t, node.URL)
	var keys []string
	for i := 0; i < 4; i++ {
		k := fmt.Sprintf("c2%030d", i)
		keys = append(keys, k)
		putOnNode(t, node.dir, k)
		if err := h.store.CreateStoredFile(ctx, StoredFile{ID: "bud-" + k[len(k)-2:], UserID: h.userID, BlobKey: k,
			EncManifest: []byte{1}, Size: 1, CreatedAt: h.now, ExpiresAt: h.now + 3600, NodeID: nodeID, Purpose: StoredPurposeShare}); err != nil {
			t.Fatal(err)
		}
	}
	u, err := h.store.GetUserByID(ctx, h.userID)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.CreateEmailToken(ctx, EmailToken{TokenHash: authx.HashToken("bud-raw"), UserID: u.ID, Email: u.Email,
		Purpose: "delete", CreatedAt: h.now, ExpiresAt: h.now + 3600}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	var took time.Duration
	var cerr error
	go func() {
		defer wg.Done()
		start := time.Now()
		cerr = h.svc.ConfirmAccountDeletion(ctx, "bud-raw")
		took = time.Since(start)
	}()
	wg.Wait()
	if cerr != nil {
		t.Fatal(cerr)
	}
	if took > 3*time.Second {
		t.Fatalf("the cleanup held the confirmation for %v against a %v budget", took, accountDeletionReclaimBudget)
	}
	for _, k := range keys {
		if !nodeBlobPresent(t, node.dir, k) || len(queuedFor(t, h, k)) != 1 {
			t.Fatalf("%s: blob=%v queue=%+v, want kept and queued", k, nodeBlobPresent(t, node.dir, k), queuedFor(t, h, k))
		}
	}
}

// Fable minor 1. Fresh rows arriving every sweep — each on its own stalled node,
// more than one pass budget's worth — must not keep a row that was already
// attempted from being revisited. With fresh rows stamped at INSERT the queue
// is a last-touched FIFO and the retried obligation is reached on the next
// sweep; left at 0 they would sort ahead of it for as long as they kept coming.
func TestFreshQueueRowsDoNotStarveARetriedRow(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	shrink(t, &nodeDeleteTimeout, 200*time.Millisecond)
	shrink(t, &gcPassBudget, 450*time.Millisecond)

	node := newCleanupNode(t)
	node.deleteMode.Store(2) // sweep 1: the DELETE hangs
	nodeID := h.registerStorageNode(t, node.URL)
	key := "7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e"
	ds, _ := storage.NewDiskStore(node.dir)
	if _, err := ds.Put(ctx, key, strings.NewReader(strings.Repeat("R", 2500))); err != nil {
		t.Fatal(err)
	}
	if err := enqueueBilledNodeDeleteOn(ctx, h.store.db, key, nodeID, h.now, 0, h.userID, MeterUpload, 10000, 0); err != nil {
		t.Fatal(err)
	}
	before := gcMeteredUpload(t, h.store, h.userID)
	g := &GC{Store: h.store, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	g.sweep(ctx) // attempted: billed, delete timed out, moved back
	if !nodeBlobPresent(t, node.dir, key) || len(queuedFor(t, h, key)) != 1 {
		t.Fatal("setup: the retried row was not left in place after sweep 1")
	}
	node.deleteMode.Store(0)

	const perSweep, maxSweeps = 3, 3
	fresh := 0
	sweeps := 0
	for ; sweeps < maxSweeps && nodeBlobPresent(t, node.dir, key); sweeps++ {
		for i := 0; i < perSweep; i++ { // 3 × 200 ms > the 450 ms budget
			sn := newStalledTLSNode(t)
			id := h.registerStorageNode(t, sn.URL())
			if err := enqueueNodeDeleteOn(ctx, h.store.db, fmt.Sprintf("0%031d", fresh), id, h.now, 0); err != nil {
				t.Fatal(err)
			}
			fresh++
		}
		g.sweep(ctx)
	}
	if nodeBlobPresent(t, node.dir, key) || len(queuedFor(t, h, key)) != 0 {
		t.Fatalf("after %d sweeps with %d fresh stalled rows arriving each, the retried row was never revisited", sweeps, perSweep)
	}
	t.Logf("retried row revisited and cleared in sweep %d after the first", sweeps)
	if got := gcMeteredUpload(t, h.store, h.userID) - before; got != 2500 {
		t.Fatalf("the obligation billed %d, want exactly 2500", got)
	}
}

// Fable minor 2. A drain cut short by its budget still runs the retirement (and
// the retained-row count) afterwards: a stalled node ahead of a discharged row
// must not keep that row from being retired, sweep after sweep.
func TestABudgetCutDrainStillRetiresDischargedRows(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	shrink(t, &gcPassBudget, 300*time.Millisecond) // nodeDeleteTimeout stays 20 s
	node := newCleanupNode(t)
	node.deleteMode.Store(2)
	nodeID := h.registerStorageNode(t, node.URL)
	stuck := "8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a"
	if err := enqueueNodeDeleteOn(ctx, h.store.db, stuck, nodeID, h.now, 0); err != nil {
		t.Fatal(err)
	}
	// Discharged long ago and queued AFTER the stuck row, so the cut drain
	// never reaches it; only the retirement can remove it.
	done := "8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b"
	if err := enqueueNodeDeleteOn(ctx, h.store.db, done, "", h.now, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.db.Exec(`UPDATE pending_node_deletes SET enqueued_at = 1, deleted_at = 2 WHERE blob_key = ?`, done); err != nil {
		t.Fatal(err)
	}
	g := &GC{Store: h.store, Blobs: h.disk, BlobFor: h.svc.blobFor, Now: func() int64 { return h.now }, Log: log.New(io.Discard, "", 0)}
	start := time.Now()
	g.drainPending(withStalledNodes(func() context.Context {
		c, cancel := context.WithTimeout(ctx, gcPassBudget)
		t.Cleanup(cancel)
		return c
	}()))
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the drain was not cut by its budget: %v", took)
	}
	if len(queuedFor(t, h, done)) != 0 {
		t.Fatal("a discharged row survived a drain whose budget a stalled node used up: retirement was skipped")
	}
	if len(queuedFor(t, h, stuck)) != 1 {
		t.Fatal("the stuck row is no longer queued")
	}
}
