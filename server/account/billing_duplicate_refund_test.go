package account

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

type duplicateStripeState struct {
	active, refunded, failRefund bool
	deletes, refundPosts         int
}

func newDuplicateStripe(t *testing.T, state *duplicateStripeState, multi bool) (*stripeClient, func()) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
				io.WriteString(w, `{"data":[{"id":"inpay_a","invoice":"in_dup","status":"paid","amount_paid":200,"status_transitions":{"paid_at":100},"payment":{"type":"payment_intent","payment_intent":"pi_a"}},{"id":"inpay_b","invoice":"in_dup","status":"paid","amount_paid":300,"status_transitions":{"paid_at":100},"payment":{"type":"payment_intent","payment_intent":"pi_b"}}],"has_more":false}`)
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
			io.WriteString(w, `{"id":"ch_a","customer":"cus_dup","payment_intent":"pi_a","amount":200,"amount_refunded":0,"paid":true}`)
		case "GET /v1/charges/ch_b":
			io.WriteString(w, `{"id":"ch_b","customer":"cus_dup","payment_intent":"pi_b","amount":300,"amount_refunded":0,"paid":true}`)
		case "POST /v1/refunds":
			state.refundPosts++
			if state.failRefund {
				http.Error(w, `{"error":{"message":"temporary"}}`, http.StatusInternalServerError)
				return
			}
			state.refunded = true
			io.WriteString(w, `{"id":"re_dup","status":"succeeded"}`)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}))
	client := NewStripeClient("sk_test", "whsec", "")
	client.base, client.http = server.URL, server.Client()
	return client, server.Close
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
