package account

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type duplicateStripeState struct {
	mu                           sync.Mutex
	active, refunded, failRefund bool
	deletes, refundPosts         int
	refunds                      map[string]int64
	refundKeys                   map[string]bool
	identityDrift                bool
	providerRefundFailedOnce     bool
}

func newDuplicateStripe(t *testing.T, state *duplicateStripeState, multi bool) (*stripeClient, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state.mu.Lock()
		defer state.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/subscriptions/sub_dup":
			status := "canceled"
			if state.active {
				status = "active"
			}
			fmt.Fprintf(w, `{"id":"sub_dup","customer":"cus_dup","status":%q,"latest_invoice":"in_dup"}`, status)
		case "DELETE /v1/subscriptions/sub_dup":
			state.deletes++
			state.active = false
			io.WriteString(w, `{"id":"sub_dup","customer":"cus_dup","status":"canceled","latest_invoice":"in_dup"}`)
		case "GET /v1/invoices/in_dup":
			io.WriteString(w, `{"id":"in_dup","status":"paid","customer":"cus_dup","parent":{"subscription_details":{"subscription":"sub_dup"}},"amount_paid":500,"created":90}`)
		case "GET /v1/invoice_payments":
			if multi {
				secondID := "inpay_b"
				if state.identityDrift {
					secondID = "inpay_drifted"
				}
				fmt.Fprintf(w, `{"data":[{"id":"inpay_a","invoice":"in_dup","status":"paid","amount_paid":200,"status_transitions":{"paid_at":100},"payment":{"type":"payment_intent","payment_intent":"pi_a"}},{"id":%q,"invoice":"in_dup","status":"paid","amount_paid":300,"status_transitions":{"paid_at":100},"payment":{"type":"payment_intent","payment_intent":"pi_b"}}],"has_more":false}`, secondID)
			} else {
				io.WriteString(w, `{"data":[{"id":"inpay_dup","invoice":"in_dup","status":"paid","amount_paid":500,"status_transitions":{"paid_at":100},"payment":{"type":"payment_intent","payment_intent":"pi_dup"}}],"has_more":false}`)
			}
		case "GET /v1/payment_intents/pi_dup":
			io.WriteString(w, `{"id":"pi_dup","customer":"cus_dup","status":"succeeded","latest_charge":"ch_dup"}`)
		case "GET /v1/payment_intents/pi_a":
			io.WriteString(w, `{"id":"pi_a","customer":"cus_dup","status":"succeeded","latest_charge":"ch_a"}`)
		case "GET /v1/payment_intents/pi_b":
			io.WriteString(w, `{"id":"pi_b","customer":"cus_dup","status":"succeeded","latest_charge":"ch_b"}`)
		case "GET /v1/charges/ch_dup":
			refunded := 0
			if state.refunded {
				refunded = 500
			}
			fmt.Fprintf(w, `{"id":"ch_dup","customer":"cus_dup","payment_intent":"pi_dup","amount":500,"amount_refunded":%d,"paid":true}`, refunded)
		case "GET /v1/charges/ch_a":
			fmt.Fprintf(w, `{"id":"ch_a","customer":"cus_dup","payment_intent":"pi_a","amount":200,"amount_refunded":%d,"paid":true}`, state.refunds["pi_a"])
		case "GET /v1/charges/ch_b":
			fmt.Fprintf(w, `{"id":"ch_b","customer":"cus_dup","payment_intent":"pi_b","amount":300,"amount_refunded":%d,"paid":true}`, state.refunds["pi_b"])
		case "POST /v1/refunds":
			if state.failRefund {
				state.refundPosts++
				http.Error(w, `{"error":{"message":"temporary"}}`, http.StatusInternalServerError)
				return
			}
			if state.refundKeys == nil {
				state.refundKeys = map[string]bool{}
			}
			key := r.Header.Get("Idempotency-Key")
			if state.refundKeys[key] {
				io.WriteString(w, `{"id":"re_replayed","status":"succeeded"}`)
				return
			}
			state.refundKeys[key] = true
			state.refundPosts++
			if state.providerRefundFailedOnce {
				state.providerRefundFailedOnce = false
				io.WriteString(w, `{"id":"re_failed","status":"failed"}`)
				return
			}
			if err := r.ParseForm(); err == nil && state.refunds != nil {
				var amount int64
				fmt.Sscan(r.Form.Get("amount"), &amount)
				state.refunds[r.Form.Get("payment_intent")] += amount
			} else {
				state.refunded = true
			}
			io.WriteString(w, `{"id":"re_dup","status":"succeeded"}`)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}))
	client := NewStripeClient("sk_test", "whsec", "")
	client.base, client.http = server.URL, server.Client()
	return client, server.Close
}

func prepareCanceledManualDuplicate(t *testing.T, store *SQLiteStore, client *stripeClient, state *duplicateStripeState) DuplicateRefundJob {
	t.Helper()
	job := prepareDuplicateJob(t, store, client)
	result, err := client.ReconcileDuplicateSubscription(context.Background(), job)
	if err != nil || !result.SubscriptionCanceled || result.ManualReason == "" {
		t.Fatalf("manual reconcile=%+v err=%v", result, err)
	}
	if err := store.SaveDuplicateRefund(context.Background(), job, result, nil, 101); err != nil {
		t.Fatal(err)
	}
	job, _, _ = store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if !job.SubscriptionCanceled || job.State != "manual" || state.deletes != 1 {
		t.Fatalf("job=%+v deletes=%d", job, state.deletes)
	}
	return job
}

func TestDuplicateRefundOperatorRefundsEveryPaymentAndIsIdempotent(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	result, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "verified duplicate partial payments")
	if err != nil || result.State != "succeeded" || state.refundPosts != 2 || state.refunds["pi_a"] != 200 || state.refunds["pi_b"] != 300 {
		t.Fatalf("result=%+v err=%v posts=%d refunds=%v", result, err, state.refundPosts, state.refunds)
	}
	result, err = ResolveDuplicateRefund(context.Background(), store, client, "sub_dup", "operator", "verified duplicate partial payments")
	if err != nil || result.State != "succeeded" || state.refundPosts != 2 {
		t.Fatalf("replay=%+v err=%v posts=%d", result, err, state.refundPosts)
	}
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "different", "verified duplicate partial payments"); err == nil {
		t.Fatal("actor ownership changed")
	}
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if err != nil || evidence.State != "terminal" || evidence.ActionState != "succeeded" || evidence.ActionGeneration != 1 || len(evidence.Payments) != 2 {
		t.Fatalf("evidence=%+v err=%v", evidence, err)
	}
}

func TestDuplicateRefundOperatorPreparedCrashAndPartialSuccessConverge(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{"pi_a": 200}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	action, err := prepareDuplicateRefundAction(context.Background(), store, job, "operator", "resume prepared refund", 102)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := executeDuplicateRefundAction(context.Background(), client, job, action)
	if err != nil || proof == "" || state.refundPosts != 1 {
		t.Fatalf("execute proof=%q err=%v posts=%d", proof, err, state.refundPosts)
	}
	// Crash/local commit failure: action stays prepared although provider is done.
	result, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "resume prepared refund")
	if err != nil || result.State != "succeeded" || state.refundPosts != 1 {
		t.Fatalf("resume=%+v err=%v posts=%d", result, err, state.refundPosts)
	}
}

func TestDuplicateRefundOperatorUsesNewGenerationAfterCanonicalProviderFailure(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}, providerRefundFailedOnce: true}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "provider failure retry"); err == nil {
		t.Fatal("failed provider refund was accepted")
	}
	result, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "provider failure retry")
	if err != nil || result.State != "succeeded" || state.refundPosts != 3 {
		t.Fatalf("result=%+v err=%v posts=%d", result, err, state.refundPosts)
	}
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if err != nil || evidence.ActionGeneration != 2 || evidence.ActionState != "succeeded" {
		t.Fatalf("evidence=%+v err=%v", evidence, err)
	}
}

func TestDuplicateRefundOperatorRejectsIdentityDriftAndMissingInvoice(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	state.identityDrift = true
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "identity audit"); err == nil || state.refundPosts != 0 {
		t.Fatalf("identity drift err=%v posts=%d", err, state.refundPosts)
	}
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "other", "identity audit"); err == nil {
		t.Fatal("blocked action actor changed")
	}

	missing, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: "purged-subject", CustomerID: "cus_missing", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: "sub_missing", ManualReason: "latest_invoice_unavailable"}, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveDuplicateRefund(context.Background(), missing, DuplicateRefundResult{SubscriptionCanceled: true, ManualReason: "latest_invoice_unavailable"}, nil, 101); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, "sub_missing", "operator", "missing invoice audit"); err == nil {
		t.Fatal("missing invoice was falsely resolved")
	}
	missing, _, _ = store.DuplicateRefundBySubscription(context.Background(), "sub_missing")
	if missing.State != "manual" || missing.RefundComplete {
		t.Fatalf("missing invoice job=%+v", missing)
	}
}

func TestDuplicateRefundOperatorConcurrentCommandsDoNotDoubleRefund(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	start := make(chan struct{})
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			_, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "concurrent audit")
			errs <- err
		}()
	}
	close(start)
	for i := 0; i < 2; i++ {
		<-errs // a SQLite/CAS loser may retry; provider safety is the invariant.
	}
	got, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if state.refundPosts != 2 || (got.State != "terminal" && got.State != "manual") {
		t.Fatalf("posts=%d job=%+v", state.refundPosts, got)
	}
	if got.State != "terminal" {
		if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "concurrent audit"); err != nil {
			t.Fatal(err)
		}
	}
	got, _, _ = store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if got.State != "terminal" || state.refundPosts != 2 {
		t.Fatalf("final posts=%d job=%+v", state.refundPosts, got)
	}
}

func prepareDuplicateJob(t *testing.T, store *SQLiteStore, client *stripeClient) DuplicateRefundJob {
	t.Helper()
	plan, err := client.InspectDuplicateSubscription(context.Background(), "user_dup", "cus_dup", "sub_canonical", "sub_dup")
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.PutDuplicateRefund(context.Background(), plan, 100)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func TestDuplicateRefundInspectionFailureNeverCancels(t *testing.T) {
	deletes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletes++
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions/sub_dup" {
			io.WriteString(w, `{"id":"sub_dup","customer":"cus","status":"active","latest_invoice":"in_unavailable"}`)
			return
		}
		http.Error(w, "invoice unavailable", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	client := NewStripeClient("sk_test", "whsec", "")
	client.base, client.http = server.URL, server.Client()
	if _, err := client.InspectDuplicateSubscription(context.Background(), "user", "cus", "sub_keep", "sub_dup"); err == nil || deletes != 0 {
		t.Fatalf("err=%v deletes=%d", err, deletes)
	}
}

func TestDuplicateRefundSagaSurvivesCancelThenRefundFailure(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, failRefund: true}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	job := prepareDuplicateJob(t, store, client)
	result, providerErr := client.ReconcileDuplicateSubscription(context.Background(), job)
	if providerErr == nil || !result.SubscriptionCanceled || result.RefundComplete {
		t.Fatalf("result=%+v err=%v", result, providerErr)
	}
	if err := store.SaveDuplicateRefund(context.Background(), job, result, providerErr, 101); err != nil {
		t.Fatal(err)
	}
	job, ok, err := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if err != nil || !ok || !job.SubscriptionCanceled || job.State != "pending" {
		t.Fatalf("job=%+v ok=%v err=%v", job, ok, err)
	}
	state.failRefund = false
	result, providerErr = client.ReconcileDuplicateSubscription(context.Background(), job)
	if providerErr != nil || !result.RefundComplete {
		t.Fatalf("retry result=%+v err=%v", result, providerErr)
	}
	if err := store.SaveDuplicateRefund(context.Background(), job, result, nil, 102); err != nil {
		t.Fatal(err)
	}
	if state.deletes != 1 || state.refundPosts != 2 {
		t.Fatalf("deletes=%d refunds=%d", state.deletes, state.refundPosts)
	}
	terminal, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if terminal.State != "terminal" {
		t.Fatalf("terminal=%+v", terminal)
	}
}

func TestDuplicateRefundMultiPaymentIsDurableManual(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareDuplicateJob(t, store, client)
	if job.State != "manual" || len(job.Payments) != 2 {
		t.Fatalf("prepared=%+v", job)
	}
	result, err := client.ReconcileDuplicateSubscription(context.Background(), job)
	if err != nil || !result.SubscriptionCanceled || result.RefundComplete || result.ManualReason == "" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if err := store.SaveDuplicateRefund(context.Background(), job, result, nil, 101); err != nil {
		t.Fatal(err)
	}
	got, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if got.State != "manual" || !got.SubscriptionCanceled || state.refundPosts != 0 {
		t.Fatalf("job=%+v refunds=%d", got, state.refundPosts)
	}
}

func TestDuplicateRefundCrashBeforeLocalSaveReplaysWithoutDoubleRefund(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	job := prepareDuplicateJob(t, store, client)
	result, err := client.ReconcileDuplicateSubscription(context.Background(), job)
	if err != nil || !result.RefundComplete {
		t.Fatalf("first=%+v err=%v", result, err)
	}
	// Simulate a crash/DB failure: provider changed, but no local Save occurred.
	job, _, _ = store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	result, err = client.ReconcileDuplicateSubscription(context.Background(), job)
	if err != nil || !result.RefundComplete {
		t.Fatalf("replay=%+v err=%v", result, err)
	}
	if err := store.SaveDuplicateRefund(context.Background(), job, result, nil, 102); err != nil {
		t.Fatal(err)
	}
	if state.deletes != 1 || state.refundPosts != 1 {
		t.Fatalf("provider mutation replayed: deletes=%d refunds=%d", state.deletes, state.refundPosts)
	}
}

func TestDuplicateRefundWorkerConvergesAfterDuplicateLeavesActiveList(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	defer ts.Close()
	state := &duplicateStripeState{active: true, failRefund: true}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	svc.biller = client
	job := prepareDuplicateJob(t, store, client)
	result, providerErr := client.ReconcileDuplicateSubscription(context.Background(), job)
	if providerErr == nil || !result.SubscriptionCanceled {
		t.Fatalf("first=%+v err=%v", result, providerErr)
	}
	if err := store.SaveDuplicateRefund(context.Background(), job, result, providerErr, 101); err != nil {
		t.Fatal(err)
	}
	state.failRefund = false
	svc.ReconcileDuplicateRefunds(context.Background())
	got, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if got.State != "terminal" || state.refundPosts != 2 {
		t.Fatalf("job=%+v refunds=%d", got, state.refundPosts)
	}
}
