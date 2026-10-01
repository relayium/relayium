package account

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// N-0930-1 step 1 acceptance tests (FINAL.md §9, tests 1-10).

// allowDuplicateCancelForTest authorizes a direct provider call in tests that
// exercise the provider's own DELETE/readback mechanics, not authority.
func allowDuplicateCancelForTest(context.Context) (string, error) { return "", nil }

// seedDuplicateOwner creates the local account a duplicate cancellation is
// authorized against: customer bound, canonical subscription bound, not comped,
// not deleting.
func seedDuplicateOwner(t *testing.T, store *SQLiteStore, userID, customerID, canonicalID string) {
	t.Helper()
	if _, err := store.db.Exec(`INSERT INTO users(id,email,created_at,stripe_customer_id,stripe_subscription_id,plan_source) VALUES(?,?,1,?,?,'stripe')`, userID, userID+"@example.com", customerID, canonicalID); err != nil {
		t.Fatal(err)
	}
}

const (
	n0930User      = "user_n"
	n0930Customer  = "cus_n"
	n0930Canonical = "sub_c"
	n0930Duplicate = "sub_d"
)

// n0930Stripe is a minimal Stripe for one customer with a canonical (sub_c)
// and a duplicate (sub_d) subscription.
type n0930Stripe struct {
	mu                sync.Mutex
	dupStatus         string // active | canceled
	canonicalStatus   string // "" means 404
	canonicalCustomer string
	paid              bool // in_d is a paid invoice of the duplicate
	late              bool // in_late (paid) is listed too
	failListCall      int  // 1-based invoice-list call that fails; 0 never
	failLists         map[int]bool
	failReadback      bool // the first GET of sub_d after a DELETE fails once
	dupMissing        bool // every GET of sub_d answers 404
	readbackMissing   bool // GETs of sub_d after a DELETE answer 404
	deleted           bool

	dupGets, deletes, canonicalGets, invoiceLists, refundPosts int
	onDupGet                                                   func(n int)
	onDelete                                                   func()
}

func (f *n0930Stripe) invoiceJSON(id string, amount int) string {
	return fmt.Sprintf(`{"id":%q,"status":"paid","customer":"cus_n","amount_paid":%d}`, id, amount)
}

func newN0930(t *testing.T, cfg Config) (*n0930Stripe, *stripeClient, *SQLiteStore, *Service) {
	t.Helper()
	f := &n0930Stripe{dupStatus: "active", canonicalStatus: "active", canonicalCustomer: n0930Customer, paid: true}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/subscriptions/sub_d":
			f.dupGets++
			if f.failReadback && f.deleted {
				f.failReadback = false
				http.Error(w, `{"error":{"message":"readback unavailable"}}`, http.StatusInternalServerError)
				return
			}
			if f.dupMissing || (f.readbackMissing && f.deleted) {
				http.Error(w, `{"error":{"message":"No such subscription"}}`, http.StatusNotFound)
				return
			}
			if f.onDupGet != nil {
				f.onDupGet(f.dupGets)
			}
			fmt.Fprintf(w, `{"id":"sub_d","customer":"cus_n","status":%q,"latest_invoice":"in_d"}`, f.dupStatus)
		case "DELETE /v1/subscriptions/sub_d":
			f.deletes++
			f.deleted = true
			f.dupStatus = "canceled"
			if f.onDelete != nil {
				f.onDelete()
			}
			io.WriteString(w, `{"id":"sub_d","customer":"cus_n","status":"canceled"}`)
		case "GET /v1/subscriptions/sub_c":
			f.canonicalGets++
			if f.canonicalStatus == "" {
				http.Error(w, `{"error":{"message":"No such subscription"}}`, http.StatusNotFound)
				return
			}
			fmt.Fprintf(w, `{"id":"sub_c","customer":%q,"status":%q}`, f.canonicalCustomer, f.canonicalStatus)
		case "GET /v1/invoices":
			f.invoiceLists++
			if (f.failListCall != 0 && f.invoiceLists == f.failListCall) || f.failLists[f.invoiceLists] {
				http.Error(w, `{"error":{"message":"invoice list unavailable"}}`, http.StatusInternalServerError)
				return
			}
			var items []string
			if f.paid {
				items = append(items, f.invoiceJSON("in_d", 500))
			}
			if f.late {
				items = append(items, f.invoiceJSON("in_late", 300))
			}
			fmt.Fprintf(w, `{"data":[%s],"has_more":false}`, strings.Join(items, ","))
		case "GET /v1/invoices/in_d":
			io.WriteString(w, `{"id":"in_d","status":"paid","customer":"cus_n","parent":{"subscription_details":{"subscription":"sub_d"}},"amount_paid":500,"created":90}`)
		case "GET /v1/invoices/in_late":
			io.WriteString(w, `{"id":"in_late","status":"paid","customer":"cus_n","parent":{"subscription_details":{"subscription":"sub_d"}},"amount_paid":300,"created":95}`)
		case "GET /v1/invoice_payments":
			switch r.URL.Query().Get("invoice") {
			case "in_late":
				io.WriteString(w, `{"data":[{"id":"inpay_late","invoice":"in_late","status":"paid","amount_paid":300,"status_transitions":{"paid_at":110},"payment":{"type":"payment_intent","payment_intent":"pi_late"}}],"has_more":false}`)
			default:
				io.WriteString(w, `{"data":[{"id":"inpay_d","invoice":"in_d","status":"paid","amount_paid":500,"status_transitions":{"paid_at":100},"payment":{"type":"payment_intent","payment_intent":"pi_d"}}],"has_more":false}`)
			}
		case "GET /v1/payment_intents/pi_d":
			io.WriteString(w, `{"id":"pi_d","customer":"cus_n","status":"succeeded","latest_charge":"ch_d"}`)
		case "GET /v1/payment_intents/pi_late":
			io.WriteString(w, `{"id":"pi_late","customer":"cus_n","status":"succeeded","latest_charge":"ch_late"}`)
		case "GET /v1/charges/ch_d":
			io.WriteString(w, `{"id":"ch_d","customer":"cus_n","payment_intent":"pi_d","amount":500,"amount_refunded":0,"paid":true}`)
		case "GET /v1/charges/ch_late":
			io.WriteString(w, `{"id":"ch_late","customer":"cus_n","payment_intent":"pi_late","amount":300,"amount_refunded":0,"paid":true}`)
		case "POST /v1/refunds":
			f.refundPosts++
			http.Error(w, `{"error":{"message":"refunds are operator-only"}}`, http.StatusBadRequest)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}))
	t.Cleanup(server.Close)
	client := NewStripeClient("sk_test", "whsec", "")
	client.base, client.http = server.URL, server.Client()
	store := newTestStore(t)
	svc := NewService(store, nil, cfg)
	svc.biller = client
	return f, client, store, svc
}

func (f *n0930Stripe) counts() (dupGets, deletes, canonicalGets, invoiceLists, refundPosts int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dupGets, f.deletes, f.canonicalGets, f.invoiceLists, f.refundPosts
}

// n0930Job records a fully inspected responsibility, the way the inline path
// does, and returns the worker's snapshot of it.
func n0930Job(t *testing.T, store *SQLiteStore, client *stripeClient) DuplicateRefundJob {
	t.Helper()
	plan, err := client.InspectDuplicateSubscription(context.Background(), n0930User, n0930Customer, n0930Canonical, n0930Duplicate)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.PutDuplicateRefund(context.Background(), plan, true, 100)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func n0930Load(t *testing.T, store *SQLiteStore) DuplicateRefundJob {
	t.Helper()
	job, ok, err := store.DuplicateRefundBySubscription(context.Background(), n0930Duplicate)
	if err != nil || !ok {
		t.Fatalf("load duplicate job ok=%t err=%v", ok, err)
	}
	return job
}

// Test 1: a hold committed after the provider read the duplicate and before the
// DELETE is seen by the final authorization; stale Put/Save cannot clear it.
func TestN0930_1HoldCommittedBeforeDeleteBlocksCancellation(t *testing.T) {
	f, client, store, svc := newN0930(t, Config{})
	seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
	job := n0930Job(t, store, client) // the worker's snapshot: no hold
	stalePlan, err := client.InspectDuplicateSubscription(context.Background(), n0930User, n0930Customer, n0930Canonical, n0930Duplicate)
	if err != nil {
		t.Fatal(err)
	}
	// dup GET #2 (the run's inspection is #1... counting the two above: #1 from
	// n0930Job, #2 from stalePlan, #3 the run's inspection, #4 the provider's
	// pre-DELETE read). Commit the hold on the provider's read.
	f.onDupGet = func(n int) {
		if n == 4 {
			if _, err := store.HoldDuplicateRefundCancellation(context.Background(), job.ID, duplicateHoldEvidence{At: 150, Reason: duplicateHoldCanonicalReplaced, Actor: "test", Path: "concurrent"}); err != nil {
				t.Errorf("commit concurrent hold: %v", err)
			}
		}
	}
	if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
		t.Fatal(err)
	}
	_, deletes, _, _, _ := f.counts()
	held := n0930Load(t, store)
	if deletes != 0 || held.CancelHold != duplicateHoldCanonicalReplaced || held.SubscriptionCanceled || held.State == "terminal" {
		t.Fatalf("hold committed before DELETE must stop it: deletes=%d job=%+v", deletes, held)
	}
	// Stale writers from before the hold cannot erase it.
	if _, err := store.PutDuplicateRefund(context.Background(), stalePlan, true, 300); err != nil {
		t.Fatal(err)
	}
	_ = store.SaveDuplicateRefund(context.Background(), job, DuplicateRefundResult{}, nil, 301)
	_ = store.RecordDuplicateRefundError(context.Background(), job, errors.New("stale failure"), 302)
	if after := n0930Load(t, store); after.CancelHold != duplicateHoldCanonicalReplaced || !strings.Contains(after.HoldEvidence, `"reason":"canonical_replaced"`) {
		t.Fatalf("stale Put/Save/RecordError cleared the hold: %+v", after)
	}
}

// Test 2: canonical status matrix; an already-canceled duplicate skips
// authority and keeps inspecting.
func TestN0930_1CanonicalStatusMatrix(t *testing.T) {
	for _, tc := range []struct {
		name, canonical, customer, dup string
		wantDelete                     bool
		wantHold                       string
	}{
		{"active", "active", n0930Customer, "active", true, ""},
		{"trialing", "trialing", n0930Customer, "active", true, ""},
		{"past_due", "past_due", n0930Customer, "active", false, duplicateHoldCanonicalPastDue},
		{"canceled", "canceled", n0930Customer, "active", false, duplicateHoldCanonicalNotLive},
		{"unpaid", "unpaid", n0930Customer, "active", false, duplicateHoldCanonicalNotLive},
		{"missing", "", n0930Customer, "active", false, duplicateHoldCanonicalNotLive},
		{"other_customer", "active", "cus_other", "active", false, duplicateHoldCustomerChanged},
		{"duplicate_already_canceled", "", n0930Customer, "canceled", false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, client, store, svc := newN0930(t, Config{})
			f.canonicalStatus, f.canonicalCustomer, f.dupStatus = tc.canonical, tc.customer, tc.dup
			seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
			job := n0930Job(t, store, client)
			if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
				t.Fatal(err)
			}
			_, deletes, canonicalGets, lists, refunds := f.counts()
			got := n0930Load(t, store)
			if (deletes == 1) != tc.wantDelete || got.CancelHold != tc.wantHold || refunds != 0 {
				t.Fatalf("deletes=%d hold=%q want delete=%t hold=%q job=%+v", deletes, got.CancelHold, tc.wantDelete, tc.wantHold, got)
			}
			if tc.name == "other_customer" && (!strings.Contains(got.HoldEvidence, `"customer_seen":"cus_n"`) || !strings.Contains(got.HoldEvidence, `"canonical_customer_seen":"cus_other"`)) {
				t.Fatalf("evidence must record both the local and the canonical subscription's customer: %s", got.HoldEvidence)
			}
			if tc.wantHold != "" && (got.SubscriptionCanceled || got.State == "terminal" || lists < 2) {
				t.Fatalf("held job must stay open and keep inspecting: lists=%d job=%+v", lists, got)
			}
			if tc.dup == "canceled" {
				if canonicalGets != 0 || !got.SubscriptionCanceled || got.State != "manual" || len(got.Liabilities) != 1 || got.ManualReason != "refund_operator_required" {
					t.Fatalf("already-canceled duplicate: canonicalGets=%d job=%+v", canonicalGets, got)
				}
			}
			if tc.wantDelete && (!got.SubscriptionCanceled || got.State != "manual" || got.ManualReason != "refund_operator_required") {
				t.Fatalf("canceled duplicate with a paid liability must await the operator: %+v", got)
			}
		})
	}
}

// Test 3: local authority changes committed between the worker's load and the
// DELETE each produce a hold and no DELETE.
func TestN0930_1LocalAuthorityChangesBeforeDeleteHold(t *testing.T) {
	for _, tc := range []struct {
		name     string
		mutate   string
		wantHold string
	}{
		{"binding_replaced", `UPDATE users SET stripe_subscription_id='sub_other' WHERE id='user_n'`, duplicateHoldCanonicalReplaced},
		{"customer_changed", `UPDATE users SET stripe_customer_id='cus_other' WHERE id='user_n'`, duplicateHoldCustomerChanged},
		{"admin_comp", `UPDATE users SET plan_source='admin' WHERE id='user_n'`, duplicateHoldAdminComp},
		{"account_deleting", `UPDATE users SET deleted_at=200,purge_after=999 WHERE id='user_n'`, duplicateHoldAccountDeleting},
		{"deletion_saga_pending_after_reactivation", `INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,mode) VALUES('bco_n','user_n','stripe','idem_n','pending',200,200,'account_deletion')`, duplicateHoldAccountDeleting},
		{"account_purged", `DELETE FROM users WHERE id='user_n'`, duplicateHoldAccountMissing},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, client, store, svc := newN0930(t, Config{})
			seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
			job := n0930Job(t, store, client)
			// #1 n0930Job, #2 the run's inspection, #3 the provider's pre-DELETE read.
			f.onDupGet = func(n int) {
				if n == 3 {
					if _, err := store.db.Exec(tc.mutate); err != nil {
						t.Errorf("mutate: %v", err)
					}
				}
			}
			if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
				t.Fatal(err)
			}
			_, deletes, _, _, _ := f.counts()
			got := n0930Load(t, store)
			if deletes != 0 || got.CancelHold != tc.wantHold || got.SubscriptionCanceled {
				t.Fatalf("deletes=%d hold=%q want %q job=%+v", deletes, got.CancelHold, tc.wantHold, got)
			}
		})
	}
}

// n0930FaultStore injects persistence failures into the worker's store.
type n0930FaultStore struct {
	*SQLiteStore
	failInterim, failFinal int
}

func (s *n0930FaultStore) SaveDuplicateRefundBeforeReinspection(ctx context.Context, job DuplicateRefundJob, result DuplicateRefundResult, now int64) error {
	if s.failInterim > 0 {
		s.failInterim--
		return errors.New("injected interim save failure")
	}
	return s.SQLiteStore.SaveDuplicateRefundBeforeReinspection(ctx, job, result, now)
}

func (s *n0930FaultStore) SaveDuplicateRefund(ctx context.Context, job DuplicateRefundJob, result DuplicateRefundResult, providerErr error, now int64) error {
	if s.failFinal > 0 {
		s.failFinal--
		return errors.New("injected final save failure")
	}
	return s.SQLiteStore.SaveDuplicateRefund(ctx, job, result, providerErr, now)
}

// Test 4: after a successful DELETE, a failing readback, Save, or post-cancel
// inspection leaves the job non-terminal; the next run converges. A liability
// that only the post-cancel inspection sees keeps the job manual.
func TestN0930_1FailuresAfterDeleteStayOpenAndConverge(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(f *n0930Stripe, st *n0930FaultStore)
		late  bool
	}{
		{"readback_fails", func(f *n0930Stripe, _ *n0930FaultStore) { f.failReadback = true }, false},
		{"interim_save_fails", func(_ *n0930Stripe, st *n0930FaultStore) { st.failInterim = 1 }, false},
		{"final_save_fails", func(_ *n0930Stripe, st *n0930FaultStore) { st.failFinal = 1 }, false},
		// invoice lists: #1 n0930Job, #2 run inspection, #3 post-cancel inspection.
		{"post_cancel_inspection_fails", func(f *n0930Stripe, _ *n0930FaultStore) { f.failListCall = 3 }, false},
		{"post_cancel_inspection_finds_late_payment", func(f *n0930Stripe, _ *n0930FaultStore) {
			f.onDelete = func() { f.late = true }
		}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, client, store, svc := newN0930(t, Config{})
			f.paid = false // nothing owed before the DELETE: terminal is reachable
			seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
			job := n0930Job(t, store, client)
			faulty := &n0930FaultStore{SQLiteStore: store}
			tc.setup(f, faulty)
			firstErr := svc.runDuplicateRefund(context.Background(), faulty, client, job)
			first := n0930Load(t, store)
			if first.State == "terminal" || first.RefundComplete {
				t.Fatalf("job ended before a successful post-cancel inspection: err=%v job=%+v", firstErr, first)
			}
			if tc.late {
				if firstErr != nil || first.State != "manual" || len(first.Liabilities) != 1 || first.Liabilities[0].InvoiceID != "in_late" {
					t.Fatalf("late liability must be recorded and keep the job manual: err=%v job=%+v", firstErr, first)
				}
				return
			}
			if firstErr == nil || first.Attempts != 1 || first.LastError == "" {
				t.Fatalf("injected failure must be recorded: err=%v job=%+v", firstErr, first)
			}
			if err := svc.runDuplicateRefund(context.Background(), store, client, n0930Load(t, store)); err != nil {
				t.Fatal(err)
			}
			_, deletes, _, _, refunds := f.counts()
			done := n0930Load(t, store)
			if done.State != "terminal" || done.ManualReason != "no_refund_needed" || !done.SubscriptionCanceled || deletes != 1 || refunds != 0 || done.Attempts != 0 {
				t.Fatalf("second run must converge without another DELETE: deletes=%d job=%+v", deletes, done)
			}
		})
	}
}

// Test 5: discovered_at=0 (liabilities unknown) cannot become terminal or
// refund_complete, cannot be refunded, and shows as unknown. A single-invoice
// append keeps it unknown.
func TestN0930_1UnknownLiabilitiesCannotTerminateOrRefund(t *testing.T) {
	f, client, store, _ := newN0930(t, Config{})
	ctx := context.Background()
	identity := DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: n0930Canonical, DuplicateSubscriptionID: n0930Duplicate}
	job, err := store.PutDuplicateRefund(ctx, identity, false, 100)
	if err != nil || job.DiscoveredAt != 0 {
		t.Fatalf("placeholder job=%+v err=%v", job, err)
	}
	if err := store.SaveDuplicateRefund(ctx, job, DuplicateRefundResult{SubscriptionCanceled: true, RefundComplete: true}, nil, 101); err != nil {
		t.Fatal(err)
	}
	unknown := n0930Load(t, store)
	if unknown.State != "manual" || unknown.ManualReason != "liabilities_unknown" || unknown.RefundComplete || !unknown.SubscriptionCanceled {
		t.Fatalf("unknown liabilities reached a conclusion: %+v", unknown)
	}
	evidence, err := ListDuplicateRefundEvidence(ctx, store, unknown.ID)
	if err != nil || !evidence.LiabilitiesUnknown || evidence.Resolution != "liabilities_unknown" || evidence.DiscoveredAt != 0 {
		t.Fatalf("operator view must say unknown, not zero: %+v err=%v", evidence, err)
	}
	if _, err := ResolveDuplicateRefund(ctx, store, client, unknown.ID, "operator", "unknown", evidence.LiabilityRevision, evidence.LiabilityDigest); err == nil || !strings.Contains(err.Error(), "liabilities are unknown") {
		t.Fatalf("operator refund of unknown liabilities must be refused, err=%v", err)
	}
	if err := store.AppendCanonicalDuplicatePaidInvoice(ctx, CanonicalStripePaidInvoice{InvoiceID: "in_d", CustomerID: n0930Customer, SubscriptionID: n0930Duplicate, AmountPaid: 500,
		Payments: []CanonicalStripeInvoicePayment{{InvoicePaymentID: "inpay_d", PaymentType: "payment_intent", PaymentIntentID: "pi_d", ChargeID: "ch_d", AmountPaid: 500, ChargeAmount: 500, PaidAt: 100}}}, 102); err != nil {
		t.Fatal(err)
	}
	if appended := n0930Load(t, store); appended.DiscoveredAt != 0 || len(appended.Liabilities) != 1 {
		t.Fatalf("a single invoice append must leave discovery unknown: %+v", appended)
	}
	_, _, _, _, refunds := f.counts()
	if refunds != 0 {
		t.Fatalf("refund posts=%d", refunds)
	}
	// One complete inspection makes it known; the canceled, fully known empty
	// case can now end.
	f.paid = false
	empty, err := store.PutDuplicateRefund(ctx, DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: n0930Canonical, DuplicateSubscriptionID: "sub_empty"}, true, 103)
	if err != nil || empty.DiscoveredAt != 103 {
		t.Fatalf("full inspection must record discovery: %+v err=%v", empty, err)
	}
	if err := store.SaveDuplicateRefund(ctx, empty, DuplicateRefundResult{SubscriptionCanceled: true, RefundComplete: true}, nil, 104); err != nil {
		t.Fatal(err)
	}
	if pending, _, _ := store.DuplicateRefundBySubscription(ctx, "sub_empty"); pending.State != "pending" || pending.RefundComplete || !pending.SubscriptionCanceled {
		t.Fatalf("canceled without a post-cancel inspection must stay open: %+v", pending)
	}
	empty, err = store.PutDuplicateRefundInspection(ctx, DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: n0930Canonical, DuplicateSubscriptionID: "sub_empty"}, duplicateInspectionStart{Canceled: true}, 105)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveDuplicateRefund(ctx, empty, DuplicateRefundResult{SubscriptionCanceled: true, RefundComplete: true}, nil, 106); err != nil {
		t.Fatal(err)
	}
	if done, _, _ := store.DuplicateRefundBySubscription(ctx, "sub_empty"); done.State != "terminal" || !done.RefundComplete {
		t.Fatalf("known empty liabilities must still terminate: %+v", done)
	}
}

// Test 6: a paid invoice arriving before terminal, during cancellation, and
// after terminal only ever appends; stale empty results cannot shrink it.
func TestN0930_1PaidInvoiceAtEveryStageOnlyAppends(t *testing.T) {
	late := CanonicalStripePaidInvoice{InvoiceID: "in_late", CustomerID: n0930Customer, SubscriptionID: n0930Duplicate, AmountPaid: 300,
		Payments: []CanonicalStripeInvoicePayment{{InvoicePaymentID: "inpay_late", PaymentType: "payment_intent", PaymentIntentID: "pi_late", ChargeID: "ch_late", AmountPaid: 300, ChargeAmount: 300, PaidAt: 110}}}
	t.Run("during_cancellation", func(t *testing.T) {
		f, client, store, svc := newN0930(t, Config{})
		f.paid = false
		seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
		job := n0930Job(t, store, client)
		f.onDelete = func() {
			if err := store.AppendCanonicalDuplicatePaidInvoice(context.Background(), late, 150); err != nil {
				t.Errorf("append during cancellation: %v", err)
			}
		}
		_ = svc.runDuplicateRefund(context.Background(), store, client, job) // stale snapshot may be rejected
		_ = svc.runDuplicateRefund(context.Background(), store, client, n0930Load(t, store))
		got := n0930Load(t, store)
		if got.State != "manual" || got.RefundComplete || !got.SubscriptionCanceled || len(got.Liabilities) != 1 || got.Liabilities[0].InvoiceID != "in_late" {
			t.Fatalf("payment during cancellation must survive the stale empty inspection: %+v", got)
		}
	})
	t.Run("before_and_after_terminal", func(t *testing.T) {
		f, client, store, svc := newN0930(t, Config{})
		f.paid = false
		seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
		job := n0930Job(t, store, client)
		if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
			t.Fatal(err)
		}
		terminal := n0930Load(t, store)
		if terminal.State != "terminal" {
			t.Fatalf("setup: %+v", terminal)
		}
		if err := store.AppendCanonicalDuplicatePaidInvoice(context.Background(), late, 200); err != nil {
			t.Fatal(err)
		}
		if err := store.SaveDuplicateRefund(context.Background(), terminal, DuplicateRefundResult{SubscriptionCanceled: true, RefundComplete: true}, nil, 201); err == nil {
			t.Fatal("stale terminal snapshot must not save over the expanded liability")
		}
		// The worker's stale empty inspection (Stripe still lists nothing).
		if _, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: n0930Canonical, DuplicateSubscriptionID: n0930Duplicate}, true, 202); err != nil {
			t.Fatal(err)
		}
		got := n0930Load(t, store)
		if got.State != "manual" || got.RefundComplete || len(got.Liabilities) != 1 {
			t.Fatalf("late liability after terminal must reopen and persist: %+v", got)
		}
	})
}

// n0930StubProvider records which jobs the worker attempted.
type n0930StubProvider struct {
	*fakeBiller
	mu        sync.Mutex
	attempted []string
	failing   func(dup string) bool
	manual    func(dup string) bool
}

func (p *n0930StubProvider) InspectDuplicateSubscription(_ context.Context, userID, customerID, canonicalID, duplicateID string) (DuplicateRefundPlan, error) {
	p.mu.Lock()
	p.attempted = append(p.attempted, duplicateID)
	p.mu.Unlock()
	if p.failing != nil && p.failing(duplicateID) {
		return DuplicateRefundPlan{}, errors.New("permanent inspection failure")
	}
	plan := DuplicateRefundPlan{UserID: userID, CustomerID: customerID, CanonicalSubscriptionID: canonicalID, DuplicateSubscriptionID: duplicateID}
	if p.manual != nil && p.manual(duplicateID) {
		plan.ManualReason = "shared_or_unsupported_invoice_payment"
	}
	return plan, nil
}

func (p *n0930StubProvider) ReconcileDuplicateSubscription(_ context.Context, job DuplicateRefundJob, _ func(context.Context) (string, error)) (DuplicateRefundResult, error) {
	return DuplicateRefundResult{ManualReason: job.ManualReason, HoldReason: duplicateHoldCanonicalPastDue}, nil
}

func (p *n0930StubProvider) round(svc *Service, now int64) map[string]bool {
	p.mu.Lock()
	p.attempted = nil
	p.mu.Unlock()
	svc.now = func() time.Time { return time.Unix(now, 0) }
	svc.ReconcileDuplicateRefunds(context.Background())
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]bool{}
	for _, id := range p.attempted {
		out[id] = true
	}
	return out
}

func n0930Seed(t *testing.T, store *SQLiteStore, prefix string, count int, terminal bool) []string {
	t.Helper()
	var ids []string
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("%s_%03d", prefix, i)
		job, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: "u_" + id, CustomerID: "cus_" + id, CanonicalSubscriptionID: "keep_" + id, DuplicateSubscriptionID: id}, true, int64(1000+i))
		if err != nil {
			t.Fatal(err)
		}
		if terminal {
			if _, err := store.db.Exec(`UPDATE billing_duplicate_refunds SET state='terminal',manual_reason='no_refund_needed',subscription_canceled=1,refund_complete=1,next_audit_at=? WHERE id=?`, 1000+i, job.ID); err != nil {
				t.Fatal(err)
			}
		}
		ids = append(ids, id)
	}
	return ids
}

func n0930CountIn(ids []string, set map[string]bool) int {
	n := 0
	for _, id := range ids {
		if set[id] {
			n++
		}
	}
	return n
}

// Test 7: quotas keep both classes moving, and every outcome rotates.
func TestN0930_1WorkerQuotasRotateBothClasses(t *testing.T) {
	t.Run("permanent_failures", func(t *testing.T) {
		store := newTestStore(t)
		stub := &n0930StubProvider{fakeBiller: &fakeBiller{}, failing: func(string) bool { return true }}
		svc := NewService(store, nil, Config{})
		svc.biller = stub
		open := n0930Seed(t, store, "open", 110, false)
		audits := n0930Seed(t, store, "audit", 30, true)
		const t0 = int64(2_000_000)
		r1 := stub.round(svc, t0)
		if n0930CountIn(open, r1) != 75 || n0930CountIn(audits, r1) != 25 {
			t.Fatalf("round 1 quotas: open=%d audits=%d, want 75/25", n0930CountIn(open, r1), n0930CountIn(audits, r1))
		}
		for _, id := range open[:75] {
			if !r1[id] {
				t.Fatalf("round 1 must take the oldest open jobs; missing %s", id)
			}
		}
		r2 := stub.round(svc, t0+6*60*60)
		for _, id := range append(append([]string(nil), open[75:]...), audits[25:]...) {
			if !r2[id] {
				t.Fatalf("round 2 must rotate to the jobs round 1 skipped; missing %s (open=%d audits=%d)", id, n0930CountIn(open, r2), n0930CountIn(audits, r2))
			}
		}
		failed, _, _ := store.DuplicateRefundBySubscription(context.Background(), audits[0])
		if failed.State != "terminal" || failed.NextAuditAt <= t0 || failed.Attempts == 0 {
			t.Fatalf("failed terminal audit must stay terminal and move its audit time: %+v", failed)
		}
	})
	t.Run("quota_lending", func(t *testing.T) {
		store := newTestStore(t)
		n0930Seed(t, store, "open", 10, false)
		n0930Seed(t, store, "audit", 120, true)
		jobs, err := store.ListDuplicateRefunds(context.Background(), 100, 5000)
		if err != nil {
			t.Fatal(err)
		}
		var open, due int
		for _, job := range jobs {
			if job.State == "terminal" {
				due++
			} else {
				open++
			}
		}
		if open != 10 || due != 90 {
			t.Fatalf("unused open quota must be lent to audits: open=%d due=%d", open, due)
		}
	})
	t.Run("held_and_manual_successes_rotate", func(t *testing.T) {
		store := newTestStore(t)
		stub := &n0930StubProvider{fakeBiller: &fakeBiller{}, manual: func(id string) bool { return strings.HasSuffix(id, "1") }}
		svc := NewService(store, nil, Config{})
		svc.biller = stub
		open := n0930Seed(t, store, "open", 101, false)
		const t0 = int64(3_000_000)
		r1 := stub.round(svc, t0)
		if len(r1) != 100 || r1[open[100]] {
			t.Fatalf("round 1 selected %d (newest selected=%t)", len(r1), r1[open[100]])
		}
		r2 := stub.round(svc, t0+6*60*60)
		if !r2[open[100]] {
			t.Fatal("successful held/manual outcomes must rotate so the skipped job is reached")
		}
		manual, _, _ := store.DuplicateRefundBySubscription(context.Background(), open[1])
		held, _, _ := store.DuplicateRefundBySubscription(context.Background(), open[0])
		if manual.State != "manual" || held.State != "pending" || manual.Attempts != 0 || held.SubscriptionCanceled {
			t.Fatalf("manual=%+v held=%+v", manual, held)
		}
	})
}

// Test 8: -billing-duplicate-auto-cancel=false blocks DELETE on the inline and
// worker paths while inspection continues.
func TestN0930_1AutoCancelDisabledBlocksInlineAndWorkerDelete(t *testing.T) {
	f, _, store, svc := newN0930(t, Config{DisableBillingDuplicateAutoCancel: true})
	seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
	user := User{ID: n0930User, StripeCustomerID: n0930Customer}
	if err := svc.reconcileDuplicateSubscription(context.Background(), user, n0930Canonical, n0930Duplicate); err != nil {
		t.Fatal(err)
	}
	_, deletes, _, inlineLists, _ := f.counts()
	inline := n0930Load(t, store)
	if deletes != 0 || inlineLists == 0 || inline.DiscoveredAt == 0 || len(inline.Liabilities) != 1 || inline.SubscriptionCanceled || inline.CancelHold != "" {
		t.Fatalf("inline path: deletes=%d lists=%d job=%+v", deletes, inlineLists, inline)
	}
	svc.ReconcileDuplicateRefunds(context.Background())
	_, deletes, _, workerLists, refunds := f.counts()
	worker := n0930Load(t, store)
	if deletes != 0 || workerLists <= inlineLists || worker.SubscriptionCanceled || worker.CancelHold != "" || refunds != 0 {
		t.Fatalf("worker path: deletes=%d lists=%d->%d job=%+v", deletes, inlineLists, workerLists, worker)
	}
	// Positive control: the same setup with auto-cancel on does DELETE.
	f2, _, store2, svc2 := newN0930(t, Config{})
	seedDuplicateOwner(t, store2, n0930User, n0930Customer, n0930Canonical)
	if err := svc2.reconcileDuplicateSubscription(context.Background(), user, n0930Canonical, n0930Duplicate); err != nil {
		t.Fatal(err)
	}
	if _, deletes, _, _, _ := f2.counts(); deletes != 1 {
		t.Fatalf("auto-cancel on must cancel, deletes=%d", deletes)
	}
}

// Test 9: the migration backfills legacy rows exactly once; a row that is
// genuinely unknown after migration stays unknown across reopen.
func TestN0930_1MigrationBackfillsLegacyRowsOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	store.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		`ALTER TABLE billing_duplicate_refunds DROP COLUMN discovered_at`,
		`ALTER TABLE billing_duplicate_refunds DROP COLUMN cancel_hold`,
		`ALTER TABLE billing_duplicate_refunds DROP COLUMN hold_evidence`,
		`DELETE FROM schema_migrations WHERE id='billing_duplicate_refund_responsibility_v1'`,
		`ALTER TABLE billing_duplicate_refunds DROP COLUMN post_cancel_inspected`,
		`DELETE FROM schema_migrations WHERE id='billing_duplicate_refund_post_cancel_inspection_v1'`,
		`ALTER TABLE billing_duplicate_refunds DROP COLUMN cancel_contradictions`,
		`ALTER TABLE billing_duplicate_refunds DROP COLUMN cancel_reconfirmed`,
		`DELETE FROM schema_migrations WHERE id='billing_duplicate_refund_cancel_contradiction_v1'`,
		`INSERT INTO billing_duplicate_refunds(id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,state,created_at,updated_at) VALUES('bdup_legacy_open','u','cus','sub_keep','sub_legacy_open','pending',500,500)`,
		`INSERT INTO billing_duplicate_refunds(id,user_id,customer_id,canonical_subscription_id,duplicate_subscription_id,state,subscription_canceled,refund_complete,created_at,updated_at) VALUES('bdup_legacy_done','u','cus','sub_keep','sub_legacy_done','terminal',1,1,700,700)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	db.Close()
	store, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	for sub, want := range map[string]int64{"sub_legacy_open": 500, "sub_legacy_done": 700} {
		job, ok, err := store.DuplicateRefundBySubscription(context.Background(), sub)
		if err != nil || !ok || job.DiscoveredAt != want || job.CancelHold != "" || job.HoldEvidence != "[]" || job.PostCancelInspected || job.CancelContradictions != 0 || job.CancelReconfirmed != 0 {
			t.Fatalf("%s backfill: job=%+v ok=%t err=%v", sub, job, ok, err)
		}
	}
	if _, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: "u", CustomerID: "cus", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: "sub_unknown"}, false, 900); err != nil {
		t.Fatal(err)
	}
	store.Close()
	store, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if job, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_unknown"); job.DiscoveredAt != 0 {
		t.Fatalf("a genuinely unknown row must not be backfilled on a later boot: %+v", job)
	}
	// Adopt case: the columns already exist but the marker does not (e.g. a
	// schema created with them). The migration must adopt, never backfill.
	if _, err := store.db.Exec(`DELETE FROM schema_migrations WHERE id='billing_duplicate_refund_responsibility_v1'`); err != nil {
		t.Fatal(err)
	}
	store.Close()
	store, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if job, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_unknown"); job.DiscoveredAt != 0 {
		t.Fatalf("adopting existing columns must not backfill an unknown row: %+v", job)
	}
}

// Test 9 (documenting): the pre-N-0930-1 binary's SQL, run against a migrated
// row, ignores cancel_hold and terminalizes an unknown liability set; its
// worker selection still picks held rows for cancellation. This is WHY the
// rollout forbids running an older binary alongside (or after) this one:
// rollback below step 1 is forward-fix only, and an emergency downgrade must
// first stop every older-binary cancellation entry point (inline webhook AND
// worker).
func TestN0930_1LegacyBinarySQLIgnoresHoldAndDiscovery(t *testing.T) {
	store := newTestStore(t)
	job, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: "u", CustomerID: "cus", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: "sub_legacy"}, false, 100)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.HoldDuplicateRefundCancellation(context.Background(), job.ID, duplicateHoldEvidence{At: 100, Reason: duplicateHoldAdminComp}); err != nil {
		t.Fatal(err)
	}
	var selected string
	if err := store.db.QueryRow(`SELECT duplicate_subscription_id FROM billing_duplicate_refunds WHERE state<>'terminal' OR next_audit_at<=? ORDER BY CASE WHEN state='terminal' THEN 1 ELSE 0 END,next_audit_at,updated_at,id LIMIT 100`, time.Now().Unix()).Scan(&selected); err != nil || selected != "sub_legacy" {
		t.Fatalf("legacy selection selected=%q err=%v", selected, err)
	}
	if _, err := store.db.Exec(`UPDATE billing_duplicate_refunds SET state=?,manual_reason=?,subscription_canceled=?,refund_complete=?,attempts=attempts+1,revision=revision+1,last_error=?,updated_at=? WHERE id=? AND state<>'terminal' AND liability_revision=?`, "terminal", "no_refund_needed", 1, 1, "", 101, job.ID, job.LiabilityRevision); err != nil {
		t.Fatal(err)
	}
	got := n0930Load2(t, store, "sub_legacy")
	if got.State != "terminal" || !got.RefundComplete || got.DiscoveredAt != 0 || got.CancelHold != duplicateHoldAdminComp {
		t.Fatalf("documented legacy behavior changed; re-evaluate the rollout note: %+v", got)
	}
}

func n0930Load2(t *testing.T, store *SQLiteStore, sub string) DuplicateRefundJob {
	t.Helper()
	job, ok, err := store.DuplicateRefundBySubscription(context.Background(), sub)
	if err != nil || !ok {
		t.Fatalf("load %s ok=%t err=%v", sub, ok, err)
	}
	return job
}

// Test 10: background paths (inline and worker) never issue a refund, whatever
// the job state: held, manual with a paid liability, or unknown.
func TestN0930_1BackgroundPathsNeverRefund(t *testing.T) {
	f, _, store, svc := newN0930(t, Config{})
	seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
	user := User{ID: n0930User, StripeCustomerID: n0930Customer}
	if err := svc.reconcileDuplicateSubscription(context.Background(), user, n0930Canonical, n0930Duplicate); err != nil {
		t.Fatal(err)
	}
	for _, sub := range []string{"sub_held", "sub_unknown"} {
		job, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: n0930Canonical, DuplicateSubscriptionID: sub,
			Liabilities: []DuplicateRefundLiability{{InvoiceID: "in_" + sub, Status: "paid", AmountPaid: 100}}}, sub == "sub_held", 100)
		if err != nil {
			t.Fatal(err)
		}
		if sub == "sub_held" {
			if _, err := store.HoldDuplicateRefundCancellation(context.Background(), job.ID, duplicateHoldEvidence{At: 100, Reason: duplicateHoldCanonicalPastDue}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for i := 0; i < 3; i++ {
		svc.ReconcileDuplicateRefunds(context.Background())
	}
	_, deletes, _, _, refunds := f.counts()
	if refunds != 0 || deletes != 1 {
		t.Fatalf("background refund posts=%d deletes=%d", refunds, deletes)
	}
	if got := n0930Load(t, store); got.State != "manual" || got.ManualReason != "refund_operator_required" {
		t.Fatalf("paid liability must wait for the operator: %+v", got)
	}
}

// Alerts: the fixed prefix fires for repeated failures, unknown liabilities
// older than a day and holds older than three days.
func TestN0930_1WorkerAlertsNeedAttention(t *testing.T) {
	store := newTestStore(t)
	stub := &n0930StubProvider{fakeBiller: &fakeBiller{}, failing: func(id string) bool { return id == "sub_failing" }}
	svc := NewService(store, nil, Config{})
	svc.biller = stub
	ctx := context.Background()
	plan := func(sub string) DuplicateRefundPlan {
		return DuplicateRefundPlan{UserID: "u", CustomerID: "cus", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: sub}
	}
	failing, _ := store.PutDuplicateRefund(ctx, plan("sub_failing"), true, 1000)
	_, _ = store.db.Exec(`UPDATE billing_duplicate_refunds SET attempts=3 WHERE id=?`, failing.ID)
	held, _ := store.PutDuplicateRefund(ctx, plan("sub_held"), true, 1000)
	if _, err := store.HoldDuplicateRefundCancellation(ctx, held.ID, duplicateHoldEvidence{At: 1000, Reason: duplicateHoldAdminComp}); err != nil {
		t.Fatal(err)
	}
	fresh, _ := store.PutDuplicateRefund(ctx, plan("sub_fresh"), true, 1000)
	_ = fresh
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	svc.now = func() time.Time { return time.Unix(1000+73*60*60, 0) }
	svc.ReconcileDuplicateRefunds(ctx)
	out := buf.String()
	for _, want := range []string{"reason=repeated_failures", "reason=cancel_hold"} {
		if !strings.Contains(out, duplicateResponsibilityAlert) || !strings.Contains(out, want) {
			t.Fatalf("missing alert %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "duplicate=sub_fresh reason=") {
		t.Fatalf("healthy job must not alert:\n%s", out)
	}
	if reasons := duplicateResponsibilityAttention(DuplicateRefundJob{CreatedAt: 0}, 25*60*60); len(reasons) != 1 || reasons[0] != "liabilities_unknown" {
		t.Fatalf("unknown liabilities older than a day must alert: %v", reasons)
	}
}

// postCancelInspectForTest records the complete inspection that, in
// production, follows a durably recorded cancellation (post_cancel_inspected).
// Fixtures that cancel through the provider directly need it before any
// completion or operator refund is allowed.
func postCancelInspectForTest(t *testing.T, store *SQLiteStore, client *stripeClient, userID, customerID, canonicalID, duplicateID string) DuplicateRefundJob {
	t.Helper()
	plan, err := client.InspectDuplicateSubscription(context.Background(), userID, customerID, canonicalID, duplicateID)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.PutDuplicateRefundInspection(context.Background(), plan, duplicateInspectionStart{Canceled: true}, 102)
	if err != nil || !job.PostCancelInspected {
		t.Fatalf("post-cancel inspection job=%+v err=%v", job, err)
	}
	return job
}

// n0930BarrierStore pauses one run just before it records its first
// inspection, so another run can interleave.
type n0930BarrierStore struct {
	*SQLiteStore
	reached, release chan struct{}
	pauseOn, calls   int // pause on the pauseOn-th call (0 means the first)
}

func (b *n0930BarrierStore) PutDuplicateRefundInspection(ctx context.Context, plan DuplicateRefundPlan, start duplicateInspectionStart, now int64) (DuplicateRefundJob, error) {
	b.calls++
	if b.calls == b.pauseOn || (b.pauseOn == 0 && b.calls == 1) {
		close(b.reached)
		<-b.release
	}
	return b.SQLiteStore.PutDuplicateRefundInspection(ctx, plan, start, now)
}

// Run A inspects (nothing owed yet) and pauses before
// recording it; run B cancels, records the cancellation and fails its
// post-cancel inspection; A resumes. A's inspection started BEFORE the
// cancellation, so it must not be what ends the job. In the late_invoice case
// the duplicate's last invoice only appears after the DELETE: completing on A's
// pre-cancel inspection would lose that liability.
func TestN0930_1OverlappingRunsCannotCompleteOnPreCancelInspection(t *testing.T) {
	for _, tc := range []struct {
		name string
		late bool
	}{{"post_cancel_inspections_fail", false}, {"late_invoice_after_delete", true}} {
		t.Run(tc.name, func(t *testing.T) {
			f, client, store, svc := newN0930(t, Config{})
			f.paid = false
			seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
			snapshot := n0930Job(t, store, client) // invoice list #1; canceled=0
			// #2 A's inspection, #3 B's inspection, #4 B's post-cancel inspection,
			// #5 A's post-cancel inspection (if it makes one).
			f.failLists = map[int]bool{4: true}
			if !tc.late {
				f.failLists[5] = true
			} else {
				f.onDelete = func() { f.late = true }
			}
			barrier := &n0930BarrierStore{SQLiteStore: store, reached: make(chan struct{}), release: make(chan struct{})}
			aDone := make(chan error, 1)
			go func() { aDone <- svc.runDuplicateRefund(context.Background(), barrier, client, snapshot) }()
			<-barrier.reached
			if err := svc.runDuplicateRefund(context.Background(), store, client, snapshot); err == nil {
				t.Fatal("run B's post-cancel inspection was meant to fail")
			}
			if b := n0930Load(t, store); !b.SubscriptionCanceled || b.PostCancelInspected || b.State == "terminal" {
				t.Fatalf("after B: %+v", b)
			}
			close(barrier.release)
			aErr := <-aDone
			a := n0930Load(t, store)
			if a.State == "terminal" || a.RefundComplete {
				t.Fatalf("job completed on an inspection that started before the cancellation: aErr=%v job=%+v", aErr, a)
			}
			if tc.late {
				if len(a.Liabilities) != 1 || a.Liabilities[0].InvoiceID != "in_late" || a.State != "manual" {
					t.Fatalf("A's post-cancel inspection must record the late liability: %+v", a)
				}
			}
			// A later, sequential run converges.
			_ = svc.runDuplicateRefund(context.Background(), store, client, n0930Load(t, store))
			final := n0930Load(t, store)
			_, deletes, _, _, refunds := f.counts()
			if deletes != 1 || refunds != 0 || !final.PostCancelInspected {
				t.Fatalf("deletes=%d refunds=%d job=%+v", deletes, refunds, final)
			}
			if tc.late {
				if final.State != "manual" || final.ManualReason == "no_refund_needed" || len(final.Liabilities) != 1 {
					t.Fatalf("late liability lost: %+v", final)
				}
			} else if final.State != "terminal" || final.ManualReason != "no_refund_needed" {
				t.Fatalf("empty, post-cancel-inspected job must converge to terminal: %+v", final)
			}
		})
	}
}

// The operator refund path is fenced the same way: a canceled job with no
// inspection after the cancellation cannot be refunded or finished.
func TestN0930_1OperatorRefundRequiresPostCancelInspection(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	job := prepareDuplicateJob(t, store, client)
	result, err := client.ReconcileDuplicateSubscription(context.Background(), job, allowDuplicateCancelForTest)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveDuplicateRefund(context.Background(), job, result, nil, 101); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveDuplicateRefundCurrent(context.Background(), store, client, job.ID, "operator", "verified"); err == nil || !strings.Contains(err.Error(), "inspection after cancellation") {
		t.Fatalf("refund before a post-cancel inspection must be refused: err=%v", err)
	}
	if state.refundPosts != 0 {
		t.Fatalf("refund posts=%d", state.refundPosts)
	}
	postCancelInspectForTest(t, store, client, "user_dup", "cus_dup", "sub_canonical", "sub_dup")
	if res, err := resolveDuplicateRefundCurrent(context.Background(), store, client, job.ID, "operator", "verified"); err != nil || res.State != "succeeded" || state.refundPosts != 1 {
		t.Fatalf("after post-cancel inspection: res=%+v err=%v posts=%d", res, err, state.refundPosts)
	}
}

// A successful terminal audit ends a run of consecutive
// failures, and the repeated_failures alert stops.
func TestN0930_1TerminalAuditRecoveryClearsFailureBookkeeping(t *testing.T) {
	f, client, store, svc := newN0930(t, Config{})
	f.paid = false
	seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
	if err := svc.runDuplicateRefund(context.Background(), store, client, n0930Job(t, store, client)); err != nil {
		t.Fatal(err)
	}
	done := n0930Load(t, store)
	if done.State != "terminal" {
		t.Fatalf("setup: %+v", done)
	}
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	clock := int64(4_000_000)
	audit := func() string {
		buf.Reset()
		clock += 7 * 60 * 60
		svc.now = func() time.Time { return time.Unix(clock, 0) }
		svc.ReconcileDuplicateRefunds(context.Background())
		return buf.String()
	}
	f.mu.Lock()
	f.failLists = map[int]bool{}
	for n := f.invoiceLists + 1; n <= f.invoiceLists+4; n++ {
		f.failLists[n] = true
	}
	f.mu.Unlock()
	var out string
	for i := 0; i < 4; i++ {
		out = audit()
	}
	failed := n0930Load(t, store)
	if failed.State != "terminal" || failed.Attempts != 4 || failed.LastError == "" || !strings.Contains(out, "reason=repeated_failures") {
		t.Fatalf("setup failures: job=%+v log=%s", failed, out)
	}
	out = audit()
	recovered := n0930Load(t, store)
	if recovered.State != "terminal" || recovered.Attempts != 0 || recovered.LastError != "" || strings.Contains(out, "repeated_failures") {
		t.Fatalf("successful audit must clear failure bookkeeping: job=%+v log=%s", recovered, out)
	}
	if recovered.LiabilityRevision != failed.LiabilityRevision || !recovered.SubscriptionCanceled || !recovered.RefundComplete || recovered.DiscoveredAt == 0 || recovered.CancelHold != failed.CancelHold || recovered.ManualReason != "no_refund_needed" {
		t.Fatalf("recovery must preserve state, liabilities, discovery, cancellation and holds: before=%+v after=%+v", failed, recovered)
	}
}

// Cancellation is a monotonic fact: a stale Save carrying an older
// not-canceled snapshot (same liability revision) cannot clear it.
func TestN0930_1StaleSaveCannotUncancel(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	job, err := store.PutDuplicateRefund(ctx, DuplicateRefundPlan{UserID: "u", CustomerID: "cus", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: "sub_dup",
		Liabilities: []DuplicateRefundLiability{{InvoiceID: "in_1", Status: "paid", AmountPaid: 100}}}, true, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveDuplicateRefund(ctx, job, DuplicateRefundResult{SubscriptionCanceled: true}, nil, 101); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveDuplicateRefund(ctx, job, DuplicateRefundResult{HoldReason: duplicateHoldCanonicalPastDue}, nil, 102); err != nil {
		t.Fatal(err)
	}
	if got := n0930Load2(t, store, "sub_dup"); !got.SubscriptionCanceled {
		t.Fatalf("stale not-canceled Save cleared the recorded cancellation: %+v", got)
	}
}

// A cancellation recorded while an operator refund
// is in flight (it does not move liability_revision) without a following
// inspection must stop the refund POST itself, not only the finish.
func TestN0930_1RefundMutationRechecksPostCancelGate(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	job := prepareDuplicateJob(t, store, client)
	// A discovered, NOT canceled manual job with a supported payment (reachable
	// e.g. when a processing invoice settles while auto-cancel is disabled).
	if _, err := store.db.Exec(`UPDATE billing_duplicate_refunds SET state='manual',manual_reason='invoice_payment_pending' WHERE id=?`, job.ID); err != nil {
		t.Fatal(err)
	}
	job = n0930Load2(t, store, "sub_dup")
	var once sync.Once
	// The operator command reads the invoice after preparing its action and
	// before taking the mutation lock; the worker cancels in that gap and its
	// post-cancel inspection fails (nothing more is recorded).
	state.onInvoiceGet = func() {
		once.Do(func() {
			state.active = false
			if err := store.SaveDuplicateRefundBeforeReinspection(context.Background(), job, DuplicateRefundResult{SubscriptionCanceled: true}, 150); err != nil {
				t.Errorf("worker cancellation: %v", err)
			}
		})
	}
	_, err := resolveDuplicateRefundCurrent(context.Background(), store, client, job.ID, "operator", "verified")
	state.mu.Lock()
	posts := state.refundAttempts
	state.mu.Unlock()
	got := n0930Load2(t, store, "sub_dup")
	if err == nil || posts != 0 || !got.SubscriptionCanceled || got.PostCancelInspected || got.State == "terminal" {
		t.Fatalf("refund must not be posted without a post-cancel inspection: err=%v posts=%d job=%+v", err, posts, got)
	}
}

// The row records the duplicate canceled (run B), B's
// post-cancel inspection failed, and Stripe now reports it live. Run A, which
// inspected before B's cancellation, must not finish on any branch that does
// not DELETE (hold, auto-cancel disabled); the contradiction is durable until a
// FRESH confirmation is followed by a new inspection.
func TestN0930_1CanceledThenLiveFailsClosed(t *testing.T) {
	for _, branch := range []string{"hold", "auto_cancel_disabled"} {
		t.Run(branch, func(t *testing.T) {
			f, client, store, svc := newN0930(t, Config{})
			f.paid = false
			seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
			snapshot := n0930Job(t, store, client) // invoice list #1
			runA := svc
			if branch == "auto_cancel_disabled" {
				runA = NewService(store, nil, Config{DisableBillingDuplicateAutoCancel: true})
				runA.biller = client
			}
			f.failLists = map[int]bool{4: true} // #2 A, #3 B, #4 B's post-cancel inspection
			barrier := &n0930BarrierStore{SQLiteStore: store, reached: make(chan struct{}), release: make(chan struct{})}
			aDone := make(chan error, 1)
			go func() { aDone <- runA.runDuplicateRefund(context.Background(), barrier, client, snapshot) }()
			<-barrier.reached
			if err := svc.runDuplicateRefund(context.Background(), store, client, snapshot); err == nil {
				t.Fatal("B's post-cancel inspection was meant to fail")
			}
			f.mu.Lock()
			f.dupStatus = "active" // Stripe now contradicts the recorded cancellation
			if branch == "hold" {
				f.canonicalStatus = "past_due"
			}
			f.mu.Unlock()
			close(barrier.release)
			aErr := <-aDone
			a := n0930Load(t, store)
			_, deletes, _, _, _ := f.counts()
			if aErr == nil || a.State == "terminal" || a.RefundComplete || a.PostCancelInspected || a.CancelContradictions != 1 || a.CancelReconfirmed != 0 || !a.SubscriptionCanceled || deletes != 1 {
				t.Fatalf("contradiction must fail closed: aErr=%v deletes=%d job=%+v", aErr, deletes, a)
			}
			// Stripe reports it canceled again. The next run's first inspection
			// started while the contradiction was open, so it cannot count; an
			// invoice that appears before that run's provider read must be found
			// by the re-inspection that follows the fresh confirmation.
			f.mu.Lock()
			f.dupStatus = "canceled"
			reads := f.dupGets
			f.onDupGet = func(n int) {
				if n == reads+2 { // #1 this run's inspection, #2 the provider read
					f.late = true
				}
			}
			f.mu.Unlock()
			if err := runA.runDuplicateRefund(context.Background(), store, client, n0930Load(t, store)); err != nil {
				t.Fatal(err)
			}
			d := n0930Load(t, store)
			if d.State != "manual" || d.RefundComplete || len(d.Liabilities) != 1 || d.Liabilities[0].InvoiceID != "in_late" || d.CancelReconfirmed != 1 || !d.PostCancelInspected {
				t.Fatalf("fresh confirmation must be followed by a new inspection: %+v", d)
			}
		})
	}
}

// A contradiction recorded after a run read the row but before its fresh
// confirmation is saved must not be closed by that run's (older) evidence.
func TestN0930_1ReconfirmationFencedOnContradictionCount(t *testing.T) {
	f, client, store, svc := newN0930(t, Config{})
	f.paid, f.dupStatus = false, "canceled"
	seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
	job := n0930Job(t, store, client)
	// Left by earlier runs: recorded canceled, one open contradiction.
	if _, err := store.db.Exec(`UPDATE billing_duplicate_refunds SET subscription_canceled=1,cancel_contradictions=1,cancel_reconfirmed=0 WHERE id=?`, job.ID); err != nil {
		t.Fatal(err)
	}
	snapshot := n0930Load(t, store)
	reads := f.dupGets
	f.onDupGet = func(n int) {
		if n == reads+2 { // this run's provider read: another run records a contradiction
			if err := store.RecordDuplicateCancelContradiction(context.Background(), snapshot, errors.New("concurrent live observation"), 200); err != nil {
				t.Errorf("record contradiction: %v", err)
			}
		}
	}
	_ = svc.runDuplicateRefund(context.Background(), store, client, snapshot)
	got := n0930Load(t, store)
	if got.State == "terminal" || got.RefundComplete || got.PostCancelInspected || got.CancelContradictions != 2 || got.CancelReconfirmed != 0 {
		t.Fatalf("a newer contradiction must stay open: %+v", got)
	}
}

// The stale-snapshot merge must not reopen a terminal
// (already refunded) job.
func TestN0930_1StaleSaveCannotReopenTerminal(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	stale, err := store.PutDuplicateRefund(ctx, DuplicateRefundPlan{UserID: "u", CustomerID: "cus", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: "sub_dup",
		Liabilities: []DuplicateRefundLiability{{InvoiceID: "in_1", Status: "paid", AmountPaid: 100}}}, true, 100)
	if err != nil {
		t.Fatal(err)
	}
	// Later: more liability, cancellation, operator refund -> terminal at a
	// higher liability revision.
	if _, err := store.db.Exec(`UPDATE billing_duplicate_refunds SET state='terminal',manual_reason='',refund_complete=1,subscription_canceled=1,post_cancel_inspected=1,liability_revision=liability_revision+1 WHERE id=?`, stale.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveDuplicateRefund(ctx, stale, DuplicateRefundResult{SubscriptionCanceled: true}, nil, 200); err == nil {
		t.Fatal("stale save must report staleness")
	}
	if got := n0930Load2(t, store, "sub_dup"); got.State != "terminal" || !got.RefundComplete {
		t.Fatalf("stale merge reopened a terminal job: %+v", got)
	}
}

// A 404 for the duplicate is not evidence of
// cancellation, before or after the DELETE. Inspection still records
// liabilities; nothing completes.
func TestN0930_1DuplicateNotFoundIsNotCancellation(t *testing.T) {
	for _, tc := range []struct {
		name        string
		set         func(f *n0930Stripe)
		wantDeletes int
	}{
		{"before_delete", func(f *n0930Stripe) { f.dupMissing = true }, 0},
		{"after_delete", func(f *n0930Stripe) { f.readbackMissing = true }, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, client, store, svc := newN0930(t, Config{})
			f.paid = false
			seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
			tc.set(f)
			job := n0930Job(t, store, client)
			err := svc.runDuplicateRefund(context.Background(), store, client, job)
			_, deletes, _, _, _ := f.counts()
			got := n0930Load(t, store)
			if err == nil || !strings.Contains(err.Error(), "not found") || deletes != tc.wantDeletes || got.SubscriptionCanceled || got.State == "terminal" || got.Attempts != 1 || got.DiscoveredAt == 0 {
				t.Fatalf("404 must be a retryable unknown: err=%v deletes=%d job=%+v", err, deletes, got)
			}
		})
	}
}

// A TERMINAL job that saw Stripe report the duplicate live must
// be able to recover once Stripe freshly confirms the cancellation, and an
// open contradiction must stay visible rather than pass as a clean audit.
func TestN0930_1TerminalContradictionRecovers(t *testing.T) {
	for _, tc := range []struct {
		name          string
		newerDuringIt bool
	}{{"fresh_confirmation_recovers", false}, {"newer_contradiction_stays_open", true}} {
		t.Run(tc.name, func(t *testing.T) {
			f, client, store, svc := newN0930(t, Config{})
			f.paid = false
			seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
			if err := svc.runDuplicateRefund(context.Background(), store, client, n0930Job(t, store, client)); err != nil {
				t.Fatal(err)
			}
			done := n0930Load(t, store)
			if done.State != "terminal" || !done.PostCancelInspected || !done.RefundComplete {
				t.Fatalf("setup: %+v", done)
			}
			// Audit: Stripe reports the duplicate live.
			f.mu.Lock()
			f.dupStatus = "active"
			f.mu.Unlock()
			if err := svc.runDuplicateRefund(context.Background(), store, client, n0930Load(t, store)); err == nil {
				t.Fatal("contradiction must fail the audit")
			}
			open := n0930Load(t, store)
			if open.State != "terminal" || open.PostCancelInspected || open.CancelContradictions != 1 || open.CancelReconfirmed != 0 || !open.RefundComplete || len(duplicateResponsibilityAttention(open, 0)) == 0 {
				t.Fatalf("terminal contradiction must be recorded and visible: %+v", open)
			}
			// Later audit: Stripe freshly reports canceled.
			f.mu.Lock()
			f.dupStatus = "canceled"
			if tc.newerDuringIt {
				reads := f.dupGets
				f.onDupGet = func(n int) {
					if n == reads+2 { // the provider read: another run records a newer contradiction
						if err := store.RecordDuplicateCancelContradiction(context.Background(), open, errors.New("concurrent live observation"), 300); err != nil {
							t.Errorf("record: %v", err)
						}
					}
				}
			}
			f.mu.Unlock()
			err := svc.runDuplicateRefund(context.Background(), store, client, n0930Load(t, store))
			got := n0930Load(t, store)
			if tc.newerDuringIt {
				if err == nil || got.CancelContradictions != 2 || got.CancelReconfirmed != 0 || got.PostCancelInspected || got.Attempts == 0 || got.LastError == "" || !strings.Contains(strings.Join(duplicateResponsibilityAttention(got, 0), ","), "cancel_contradiction") {
					t.Fatalf("a newer contradiction must stay open and visible: err=%v job=%+v", err, got)
				}
				return
			}
			if err != nil || got.State != "terminal" || got.CancelReconfirmed != 1 || !got.PostCancelInspected || got.Attempts != 0 || got.LastError != "" || !got.RefundComplete || len(duplicateResponsibilityAttention(got, 0)) != 0 {
				t.Fatalf("fresh confirmation must close the contradiction and restore post-cancel evidence: err=%v job=%+v", err, got)
			}
		})
	}
}

// The post_cancel_inspected write in Put is
// fenced on the pre-inspection contradiction count and on no open
// contradiction, independently of the caller's claim.
func TestN0930_1PostCancelFlagFencedOnContradictionCount(t *testing.T) {
	for _, tc := range []struct {
		name   string
		cc, cr int64
		start  int64
		want   bool
	}{
		{"contradiction_recorded_and_closed_since_read", 1, 1, 0, false},
		{"contradiction_open", 1, 0, 1, false},
		{"positive_control", 1, 1, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			plan := DuplicateRefundPlan{UserID: "u", CustomerID: "cus", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: "sub_dup"}
			job, err := store.PutDuplicateRefund(context.Background(), plan, true, 100)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.db.Exec(`UPDATE billing_duplicate_refunds SET subscription_canceled=1,cancel_contradictions=?,cancel_reconfirmed=? WHERE id=?`, tc.cc, tc.cr, job.ID); err != nil {
				t.Fatal(err)
			}
			got, err := store.PutDuplicateRefundInspection(context.Background(), plan, duplicateInspectionStart{Canceled: true, Contradictions: tc.start}, 101)
			if err != nil || got.PostCancelInspected != tc.want {
				t.Fatalf("post_cancel_inspected=%t want %t err=%v", got.PostCancelInspected, tc.want, err)
			}
		})
	}
}

// A contradiction recorded while the
// re-inspection's Put is paused must keep that Put from setting the flag.
func TestN0930_1ContradictionDuringReinspectionPutKeepsFlagClear(t *testing.T) {
	f, client, store, svc := newN0930(t, Config{})
	f.paid = false
	seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
	job := n0930Job(t, store, client)
	barrier := &n0930BarrierStore{SQLiteStore: store, reached: make(chan struct{}), release: make(chan struct{}), pauseOn: 2}
	done := make(chan error, 1)
	go func() { done <- svc.runDuplicateRefund(context.Background(), barrier, client, job) }()
	<-barrier.reached // after DELETE, interim save and re-inspection; before its Put
	if err := store.RecordDuplicateCancelContradiction(context.Background(), n0930Load(t, store), errors.New("concurrent live observation"), 200); err != nil {
		t.Fatal(err)
	}
	close(barrier.release)
	err := <-done
	got := n0930Load(t, store)
	if err == nil || got.PostCancelInspected || got.State == "terminal" || got.CancelContradictions != 1 || got.CancelReconfirmed != 0 {
		t.Fatalf("contradiction recorded during the Put must win: err=%v job=%+v", err, got)
	}
}

// The provider's result never inherits the stored
// cancellation; a live read that ends in a hold or a disabled auto-cancel
// reports SubscriptionCanceled=false, ObservedLive=true.
func TestN0930_1ProviderResultIsThisReadOnly(t *testing.T) {
	_, client, _, _ := newN0930(t, Config{})
	stored := DuplicateRefundJob{DuplicateRefundPlan: DuplicateRefundPlan{UserID: n0930User, CustomerID: n0930Customer, CanonicalSubscriptionID: n0930Canonical, DuplicateSubscriptionID: n0930Duplicate}, SubscriptionCanceled: true, RefundComplete: true}
	for name, authorize := range map[string]func(context.Context) (string, error){
		"hold":     func(context.Context) (string, error) { return duplicateHoldCanonicalPastDue, nil },
		"disabled": func(context.Context) (string, error) { return "", errDuplicateAutoCancelDisabled },
	} {
		result, err := client.ReconcileDuplicateSubscription(context.Background(), stored, authorize)
		if err != nil || result.SubscriptionCanceled || result.RefundComplete || !result.ObservedLive {
			t.Fatalf("%s: result=%+v err=%v", name, result, err)
		}
	}
}

// n0930ContradictBeforeFinalSave records a contradiction immediately before
// the run's final Save, as a concurrent run would.
type n0930ContradictBeforeFinalSave struct{ *SQLiteStore }

func (s n0930ContradictBeforeFinalSave) SaveDuplicateRefund(ctx context.Context, job DuplicateRefundJob, result DuplicateRefundResult, providerErr error, now int64) error {
	if err := s.SQLiteStore.RecordDuplicateCancelContradiction(ctx, job, errors.New("concurrent live observation"), now); err != nil {
		return err
	}
	return s.SQLiteStore.SaveDuplicateRefund(ctx, job, result, providerErr, now)
}

// A contradiction recorded after the run's snapshot but before its final Save
// must not be erased as a clean outcome: the failure bookkeeping survives.
func TestN0930_1FinalSaveCannotClearNewerContradiction(t *testing.T) {
	f, client, store, svc := newN0930(t, Config{})
	f.paid = false
	seedDuplicateOwner(t, store, n0930User, n0930Customer, n0930Canonical)
	job := n0930Job(t, store, client)
	err := svc.runDuplicateRefund(context.Background(), n0930ContradictBeforeFinalSave{store}, client, job)
	got := n0930Load(t, store)
	if err == nil || got.Attempts == 0 || !strings.Contains(got.LastError, "contradiction") || got.State == "terminal" || got.CancelContradictions != 1 || got.CancelReconfirmed != 0 {
		t.Fatalf("newer contradiction must stay recorded as a failure: err=%v job=%+v", err, got)
	}
}

// A terminal, canceled job without post-cancel evidence is reported for
// attention (visibility only).
func TestN0930_1TerminalWithoutPostCancelEvidenceNeedsAttention(t *testing.T) {
	job := DuplicateRefundJob{State: "terminal", SubscriptionCanceled: true, DiscoveredAt: 1}
	if reasons := duplicateResponsibilityAttention(job, 2); strings.Join(reasons, ",") != "post_cancel_evidence_missing" {
		t.Fatalf("reasons=%v", reasons)
	}
	job.PostCancelInspected = true
	if reasons := duplicateResponsibilityAttention(job, 2); len(reasons) != 0 {
		t.Fatalf("evidence present: reasons=%v", reasons)
	}
}
