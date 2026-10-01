package account

import (
	"bytes"
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
)

// N-0930-1 step 2 acceptance tests (FINAL.md §9, tests 11-19): placeholder
// responsibilities committed with the Bind, existing-row handling, and the
// inline path that continues past per-duplicate failures.

// n0930Reconcile runs one webhook-style reconciliation for the seeded user
// against a fresh observation, as handleStripeWebhook does.
func n0930Reconcile(t *testing.T, ctx context.Context, svc *Service) (bool, bool, error) {
	t.Helper()
	// t.Error, not t.Fatal: also called from goroutines.
	u, err := svc.Store().GetUserByID(context.Background(), n0930User)
	if err != nil {
		t.Error(err)
		return false, false, err
	}
	obs, err := svc.observeStripeSource(context.Background(), n0930User)
	if err != nil {
		t.Error(err)
		return false, false, err
	}
	return svc.reconcileSubscriptions(ctx, u, 500, obs.row, obs.exists)
}

func newN0930Step2(t *testing.T, cfg Config, binding string) (*n0930Stripe, *stripeClient, *SQLiteStore, *Service) {
	t.Helper()
	f, client, store, svc := newN0930(t, cfg)
	f.live = []string{n0930Canonical, n0930Duplicate}
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	seedDuplicateOwner(t, store, n0930User, n0930Customer, binding)
	return f, client, store, svc
}

func n0930Rows(t *testing.T, store *SQLiteStore) int {
	t.Helper()
	var n int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_duplicate_refunds`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Test 11 (the double-charge path): C was bound first; B (earlier) arrives,
// the reconciliation rebinds B and C's inspection fails. The responsibility for
// C is committed with the Bind, the webhook answers 200, and the worker later
// cancels C. Before step 2, nothing durable remained and C kept charging.
func TestN0930_1InspectionFailureAfterBindLeavesResponsibility(t *testing.T) {
	f, _, store, svc := newN0930Step2(t, Config{}, n0930Duplicate) // C (sub_d) bound first
	f.failListCall = 1                                             // the inline inspection of sub_d fails
	ok, retry, err := n0930Reconcile(t, context.Background(), svc)
	if !ok || retry || err != nil {
		t.Fatalf("reconcile ok=%t retry=%t err=%v (want 200)", ok, retry, err)
	}
	u, _ := store.GetUserByID(context.Background(), n0930User)
	job := n0930Load(t, store)
	if u.StripeSubscriptionID != n0930Canonical || job.CanonicalSubscriptionID != n0930Canonical || job.DiscoveredAt != 0 || job.Attempts == 0 || job.SubscriptionCanceled {
		t.Fatalf("binding=%s placeholder=%+v", u.StripeSubscriptionID, job)
	}
	// Redelivery of the same event (binding already canonical): no-op for the row.
	if ok, _, err := n0930Reconcile(t, context.Background(), svc); !ok || err != nil {
		t.Fatalf("redelivery ok=%t err=%v", ok, err)
	}
	svc.ReconcileDuplicateRefunds(context.Background())
	_, deletes, _, _, refunds := f.counts()
	done := n0930Load(t, store)
	if deletes != 1 || refunds != 0 || !done.SubscriptionCanceled || done.DiscoveredAt == 0 || len(done.Liabilities) != 1 || done.State != "manual" || n0930Rows(t, store) != 1 {
		t.Fatalf("worker must recover the duplicate: deletes=%d job=%+v", deletes, done)
	}
}

// n0930CrashStore lets a test cut the inline phase short right after the Bind
// transaction commits (crash / lost response), or fail persisting inspections.
type n0930CrashStore struct {
	*SQLiteStore
	afterBind func()
	failPut   bool
}

func (s *n0930CrashStore) ApplyStripeSourceIfUnchanged(ctx context.Context, in StripeSourceWrite) (StripeSourceWriteResult, error) {
	res, err := s.SQLiteStore.ApplyStripeSourceIfUnchanged(ctx, in)
	if err == nil && len(in.DuplicateResponsibilities) > 0 && s.afterBind != nil {
		s.afterBind()
	}
	return res, err
}

func (s *n0930CrashStore) PutDuplicateRefundInspection(ctx context.Context, plan DuplicateRefundPlan, start duplicateInspectionStart, now int64) (DuplicateRefundJob, error) {
	if s.failPut {
		return DuplicateRefundJob{}, errors.New("injected inspection persistence failure")
	}
	return s.SQLiteStore.PutDuplicateRefundInspection(ctx, plan, start, now)
}

// Test 12: crash right after the Bind commit, a failed inspection persist, and
// a lost response each leave the responsibility; the worker converges.
func TestN0930_1BindCommitLeavesResponsibilityAcrossFailures(t *testing.T) {
	for _, tc := range []string{"crash_after_bind", "inspection_persist_fails", "response_lost_then_redelivered"} {
		t.Run(tc, func(t *testing.T) {
			f, _, store, svc := newN0930Step2(t, Config{}, n0930Canonical)
			wrapped := &n0930CrashStore{SQLiteStore: store}
			svc.store = wrapped
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch tc {
			case "crash_after_bind":
				wrapped.afterBind = cancel
			case "inspection_persist_fails":
				wrapped.failPut = true
			}
			_, _, err := n0930Reconcile(t, ctx, svc)
			if tc == "crash_after_bind" && err == nil {
				t.Fatal("cancelled context must stop the inline attempt")
			}
			// A lost response means the inline attempt completed; the others stop
			// before any DELETE.
			if n0930Rows(t, store) != 1 || (tc != "response_lost_then_redelivered" && n0930Load(t, store).SubscriptionCanceled) {
				t.Fatalf("responsibility must be committed and nothing canceled yet: rows=%d err=%v", n0930Rows(t, store), err)
			}
			if tc == "response_lost_then_redelivered" {
				if ok, _, err := n0930Reconcile(t, context.Background(), svc); !ok || err != nil {
					t.Fatalf("redelivery ok=%t err=%v", ok, err)
				}
			}
			svc.store = store
			svc.ReconcileDuplicateRefunds(context.Background())
			_, deletes, _, _, _ := f.counts()
			if done := n0930Load(t, store); !done.SubscriptionCanceled || deletes < 1 || done.DiscoveredAt == 0 || n0930Rows(t, store) != 1 {
				t.Fatalf("must converge: deletes=%d job=%+v", deletes, done)
			}
		})
	}
}

// Test 13: CAS loss leaves no placeholder; an ownership conflict aborts the
// whole Bind, leaves the other identity's row untouched and logs outside the
// transaction.
func TestN0930_1BindRollsBackOnCASLossAndOwnershipConflict(t *testing.T) {
	t.Run("cas_loss", func(t *testing.T) {
		_, _, store, svc := newN0930Step2(t, Config{}, n0930Duplicate)
		u, _ := store.GetUserByID(context.Background(), n0930User)
		obs, _ := svc.observeStripeSource(context.Background(), n0930User)
		u.StripeSubscriptionID = "sub_stale_snapshot" // decision taken from an older users snapshot
		ok, retry, err := svc.reconcileSubscriptions(context.Background(), u, 500, obs.row, obs.exists)
		if ok || !retry || err != nil || n0930Rows(t, store) != 0 {
			t.Fatalf("CAS loss must commit nothing: ok=%t retry=%t err=%v rows=%d", ok, retry, err, n0930Rows(t, store))
		}
	})
	t.Run("ownership_conflict", func(t *testing.T) {
		f, _, store, svc := newN0930Step2(t, Config{}, n0930Duplicate)
		f.live = []string{n0930Canonical, n0930Duplicate, "sub_e"}
		f.eStatus = "active"
		other, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: "user_x", CustomerID: "cus_x", CanonicalSubscriptionID: "sub_x", DuplicateSubscriptionID: "sub_e"}, true, 50)
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		log.SetOutput(&buf)
		defer log.SetOutput(os.Stderr)
		ok, _, err := n0930Reconcile(t, context.Background(), svc)
		u, _ := store.GetUserByID(context.Background(), n0930User)
		after := n0930Load2(t, store, "sub_e")
		_, deletes, _, _, _ := f.counts()
		if ok || err == nil || u.StripeSubscriptionID != n0930Duplicate || n0930Rows(t, store) != 1 || deletes != 0 {
			t.Fatalf("ownership conflict must roll the whole Bind back: ok=%t err=%v binding=%s rows=%d deletes=%d", ok, err, u.StripeSubscriptionID, n0930Rows(t, store), deletes)
		}
		if after.Revision != other.Revision || after.CancelHold != "" || after.UserID != "user_x" || after.CanonicalSubscriptionID != "sub_x" {
			t.Fatalf("the other identity's row must be untouched: before=%+v after=%+v", other, after)
		}
		if !strings.Contains(buf.String(), duplicateResponsibilityOwnershipLog+": user=user_n") {
			t.Fatalf("missing diagnostic:\n%s", buf.String())
		}
	})
}

// Test 14: an existing responsibility with the same owner but another
// canonical is held (canonical_conflict, evidence names the new canonical)
// without rewriting its canonical or history; the Bind commits; nothing is
// canceled. The inline existing-row path applies the same comparison.
func TestN0930_1CanonicalConflictHoldsExistingRow(t *testing.T) {
	t.Run("bind", func(t *testing.T) {
		f, _, store, svc := newN0930Step2(t, Config{}, n0930Duplicate)
		if _, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: "sub_old", DuplicateSubscriptionID: n0930Duplicate}, true, 50); err != nil {
			t.Fatal(err)
		}
		ok, _, err := n0930Reconcile(t, context.Background(), svc)
		u, _ := store.GetUserByID(context.Background(), n0930User)
		job := n0930Load(t, store)
		_, deletes, _, _, _ := f.counts()
		if !ok || err != nil || u.StripeSubscriptionID != n0930Canonical || deletes != 0 || job.CancelHold != duplicateHoldCanonicalConflict || job.CanonicalSubscriptionID != "sub_old" ||
			!strings.Contains(job.HoldEvidence, `"path":"bind"`) || !strings.Contains(job.HoldEvidence, `"canonical_seen":"sub_c"`) {
			t.Fatalf("ok=%t err=%v binding=%s deletes=%d job=%+v", ok, err, u.StripeSubscriptionID, deletes, job)
		}
	})
	t.Run("inline_existing_row", func(t *testing.T) {
		f, _, store, svc := newN0930Step2(t, Config{}, n0930Canonical)
		if _, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: "sub_old", DuplicateSubscriptionID: n0930Duplicate}, true, 50); err != nil {
			t.Fatal(err)
		}
		u, _ := store.GetUserByID(context.Background(), n0930User)
		_ = svc.reconcileDuplicateSubscription(context.Background(), u, n0930Canonical, n0930Duplicate)
		job := n0930Load(t, store)
		_, deletes, _, _, _ := f.counts()
		if deletes != 0 || job.CancelHold != duplicateHoldCanonicalConflict || job.CanonicalSubscriptionID != "sub_old" || !strings.Contains(job.HoldEvidence, `"path":"inline"`) {
			t.Fatalf("deletes=%d job=%+v", deletes, job)
		}
	})
}

// Test 15: two duplicates, the first fails inline; the second is still
// attempted, the canonical entitlement is written, and the answer is 200.
func TestN0930_1InlineContinuesPastFailedDuplicate(t *testing.T) {
	f, _, store, svc := newN0930Step2(t, Config{}, n0930Canonical)
	f.live = []string{n0930Canonical, "sub_e", n0930Duplicate}
	f.eStatus, f.failE = "active", true
	ok, retry, err := n0930Reconcile(t, context.Background(), svc)
	u, _ := store.GetUserByID(context.Background(), n0930User)
	failed := n0930Load2(t, store, "sub_e")
	done := n0930Load(t, store)
	_, deletes, _, _, _ := f.counts()
	if !ok || retry || err != nil || u.PlanID != "pro" || failed.Attempts == 0 || failed.LastError == "" || deletes != 1 || !done.SubscriptionCanceled {
		t.Fatalf("ok=%t retry=%t err=%v plan=%s failed=%+v deletes=%d done=%+v", ok, retry, err, u.PlanID, failed, deletes, done)
	}
}

// Test 16: a paid invoice appended to a Bind-born placeholder leaves it unknown.
func TestN0930_1PaidInvoiceOnPlaceholderStaysUnknown(t *testing.T) {
	f, _, store, svc := newN0930Step2(t, Config{}, n0930Canonical)
	f.failListCall = 1
	if ok, _, err := n0930Reconcile(t, context.Background(), svc); !ok || err != nil {
		t.Fatalf("ok=%t err=%v", ok, err)
	}
	if err := store.AppendCanonicalDuplicatePaidInvoice(context.Background(), CanonicalStripePaidInvoice{InvoiceID: "in_d", CustomerID: n0930Customer, SubscriptionID: n0930Duplicate, AmountPaid: 500,
		Payments: []CanonicalStripeInvoicePayment{{InvoicePaymentID: "inpay_d", PaymentType: "payment_intent", PaymentIntentID: "pi_d", ChargeID: "ch_d", AmountPaid: 500, ChargeAmount: 500, PaidAt: 100}}}, 600); err != nil {
		t.Fatal(err)
	}
	if job := n0930Load(t, store); job.DiscoveredAt != 0 || len(job.Liabilities) != 1 {
		t.Fatalf("placeholder must stay unknown: %+v", job)
	}
}

// Test 17: two handlers and the worker overlap (as after a 60 s event-lease
// expiry). They converge: one row, canceled, liabilities recorded, no refund.
// Exactly one HTTP DELETE is NOT required: DELETE is idempotent and covered by
// readback.
func TestN0930_1ConcurrentHandlersAndWorkerConverge(t *testing.T) {
	f, _, store, svc := newN0930Step2(t, Config{}, n0930Duplicate)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for attempt := 0; attempt < 5; attempt++ {
				if ok, _, _ := n0930Reconcile(t, context.Background(), svc); ok {
					return
				}
			}
		}()
	}
	wg.Add(1)
	go func() { defer wg.Done(); svc.ReconcileDuplicateRefunds(context.Background()) }()
	wg.Wait()
	svc.ReconcileDuplicateRefunds(context.Background())
	_, deletes, _, _, refunds := f.counts()
	u, _ := store.GetUserByID(context.Background(), n0930User)
	job := n0930Load(t, store)
	if n0930Rows(t, store) != 1 || deletes < 1 || refunds != 0 || !job.SubscriptionCanceled || job.State != "manual" || len(job.Liabilities) != 1 || u.StripeSubscriptionID != n0930Canonical {
		t.Fatalf("rows=%d deletes=%d binding=%s job=%+v", n0930Rows(t, store), deletes, u.StripeSubscriptionID, job)
	}
}

// Test 18: roles reversed -- an old responsibility treats sub_c as the
// duplicate, but sub_c is now the canonical being bound. It is never canceled.
func TestN0930_1BoundSubscriptionIsNeverCanceledByOldResponsibility(t *testing.T) {
	f, _, store, svc := newN0930Step2(t, Config{}, n0930Duplicate)
	f.paid = false
	// Keep sub_d live through the worker's first job (the old sub_c row, which
	// is older): its inline inspection fails, so it is not canceled inline.
	f.failListCall = 1
	if _, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: n0930Duplicate, DuplicateSubscriptionID: n0930Canonical}, true, 50); err != nil {
		t.Fatal(err)
	}
	if ok, _, err := n0930Reconcile(t, context.Background(), svc); !ok || err != nil {
		t.Fatalf("ok=%t err=%v", ok, err)
	}
	svc.ReconcileDuplicateRefunds(context.Background())
	f.mu.Lock()
	canonDeletes := f.deletesBy[n0930Canonical]
	f.mu.Unlock()
	reversed := n0930Load2(t, store, n0930Canonical)
	if canonDeletes != 0 || reversed.CancelHold != duplicateHoldCanonicalReplaced || reversed.SubscriptionCanceled {
		t.Fatalf("the bound subscription must never be canceled: deletes=%d reversed=%+v", canonDeletes, reversed)
	}
}

// Test 19 (positive control): an ordinary double checkout with a successful
// inspection behaves as before -- canceled inline, liability recorded for the
// operator, plan written, 200.
func TestN0930_1OrdinaryDoubleCheckoutUnchanged(t *testing.T) {
	f, _, store, svc := newN0930Step2(t, Config{}, n0930Canonical)
	ok, retry, err := n0930Reconcile(t, context.Background(), svc)
	u, _ := store.GetUserByID(context.Background(), n0930User)
	job := n0930Load(t, store)
	_, deletes, _, _, refunds := f.counts()
	if !ok || retry || err != nil || u.PlanID != "pro" || deletes != 1 || refunds != 0 || !job.SubscriptionCanceled || job.State != "manual" || job.ManualReason != "refund_operator_required" || !job.PostCancelInspected || job.CancelHold != "" {
		t.Fatalf("ok=%t retry=%t err=%v plan=%s deletes=%d job=%+v", ok, retry, err, u.PlanID, deletes, job)
	}
}
