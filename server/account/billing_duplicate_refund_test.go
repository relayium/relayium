package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type duplicateStripeState struct {
	mu                           sync.Mutex
	active, refunded, failRefund bool
	deletes, refundPosts         int
	refunds                      map[string]int64
	refundKeys                   map[string]string
	refundRecords                map[string]duplicateRefundObservation
	identityDrift                bool
	providerRefundFailedOnce     bool
	nextRefundStatus             string
	historicalRenewal            bool
	invoiceListCalls             int
	liabilitiesAtDelete          func() int
	historyEmptyMore             bool
	historyNonadvancing          bool
	refundActionMetadata         bool
}

func newDuplicateStripe(t *testing.T, state *duplicateStripeState, multi bool) (*stripeClient, func()) {
	t.Helper()
	if state.refunds == nil {
		state.refunds = map[string]int64{}
	}
	if state.refundRecords == nil {
		state.refundRecords = map[string]duplicateRefundObservation{}
	}
	for paymentIntent, amount := range state.refunds {
		if amount > 0 {
			id := "re_existing_" + paymentIntent
			state.refundRecords[id] = duplicateRefundObservation{RefundID: id, InvoicePaymentID: "inpay_" + strings.TrimPrefix(paymentIntent, "pi_"), PaymentIntentID: paymentIntent, Status: "succeeded", Amount: amount}
		}
	}
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
			if state.liabilitiesAtDelete != nil && state.liabilitiesAtDelete() < 2 {
				http.Error(w, "liabilities were not durable before cancellation", http.StatusConflict)
				return
			}
			state.deletes++
			state.active = false
			io.WriteString(w, `{"id":"sub_dup","customer":"cus_dup","status":"canceled","latest_invoice":"in_dup"}`)
		case "GET /v1/invoices/in_dup":
			io.WriteString(w, `{"id":"in_dup","status":"paid","customer":"cus_dup","parent":{"subscription_details":{"subscription":"sub_dup"}},"amount_paid":500,"created":90}`)
		case "GET /v1/invoices":
			state.invoiceListCalls++
			if state.historyEmptyMore {
				io.WriteString(w, `{"data":[],"has_more":true}`)
				return
			}
			if state.historyNonadvancing {
				io.WriteString(w, `{"data":[{"id":"in_dup","status":"paid","customer":"cus_dup","amount_paid":500}],"has_more":true}`)
				return
			}
			if state.historicalRenewal {
				if state.invoiceListCalls == 1 {
					io.WriteString(w, `{"data":[{"id":"in_old","status":"paid","customer":"cus_dup","amount_paid":200}],"has_more":false}`)
				} else {
					io.WriteString(w, `{"data":[{"id":"in_old","status":"paid","customer":"cus_dup","amount_paid":200},{"id":"in_new","status":"paid","customer":"cus_dup","amount_paid":300}],"has_more":false}`)
				}
				return
			}
			io.WriteString(w, `{"data":[{"id":"in_dup","status":"paid","customer":"cus_dup","amount_paid":500}],"has_more":false}`)
		case "GET /v1/invoices/in_old":
			io.WriteString(w, `{"id":"in_old","status":"paid","customer":"cus_dup","parent":{"subscription_details":{"subscription":"sub_dup"}},"amount_paid":200,"created":50}`)
		case "GET /v1/invoices/in_new":
			io.WriteString(w, `{"id":"in_new","status":"paid","customer":"cus_dup","parent":{"subscription_details":{"subscription":"sub_dup"}},"amount_paid":300,"created":95}`)
		case "GET /v1/invoice_payments":
			if r.URL.Query().Get("invoice") == "in_old" {
				io.WriteString(w, `{"data":[{"id":"inpay_old","invoice":"in_old","status":"paid","amount_paid":200,"status_transitions":{"paid_at":60},"payment":{"type":"payment_intent","payment_intent":"pi_old"}}],"has_more":false}`)
				return
			}
			if r.URL.Query().Get("invoice") == "in_new" {
				io.WriteString(w, `{"data":[{"id":"inpay_new","invoice":"in_new","status":"paid","amount_paid":300,"status_transitions":{"paid_at":100},"payment":{"type":"payment_intent","payment_intent":"pi_new"}}],"has_more":false}`)
				return
			}
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
		case "GET /v1/payment_intents/pi_old":
			io.WriteString(w, `{"id":"pi_old","customer":"cus_dup","status":"succeeded","latest_charge":"ch_old"}`)
		case "GET /v1/payment_intents/pi_new":
			io.WriteString(w, `{"id":"pi_new","customer":"cus_dup","status":"succeeded","latest_charge":"ch_new"}`)
		case "GET /v1/charges/ch_dup":
			refunded := 0
			if state.refunded {
				refunded = 500
			}
			if state.refunds != nil {
				refunded = int(state.refunds["pi_dup"])
			}
			fmt.Fprintf(w, `{"id":"ch_dup","customer":"cus_dup","payment_intent":"pi_dup","amount":500,"amount_refunded":%d,"paid":true}`, refunded)
		case "GET /v1/charges/ch_a":
			fmt.Fprintf(w, `{"id":"ch_a","customer":"cus_dup","payment_intent":"pi_a","amount":200,"amount_refunded":%d,"paid":true}`, state.refunds["pi_a"])
		case "GET /v1/charges/ch_b":
			fmt.Fprintf(w, `{"id":"ch_b","customer":"cus_dup","payment_intent":"pi_b","amount":300,"amount_refunded":%d,"paid":true}`, state.refunds["pi_b"])
		case "GET /v1/charges/ch_old":
			fmt.Fprintf(w, `{"id":"ch_old","customer":"cus_dup","payment_intent":"pi_old","amount":200,"amount_refunded":%d,"paid":true}`, state.refunds["pi_old"])
		case "GET /v1/charges/ch_new":
			fmt.Fprintf(w, `{"id":"ch_new","customer":"cus_dup","payment_intent":"pi_new","amount":300,"amount_refunded":%d,"paid":true}`, state.refunds["pi_new"])
		case "GET /v1/refunds":
			var records []duplicateRefundObservation
			for _, record := range state.refundRecords {
				if record.PaymentIntentID == r.URL.Query().Get("payment_intent") {
					records = append(records, record)
				}
			}
			sort.Slice(records, func(i, j int) bool { return records[i].RefundID < records[j].RefundID })
			io.WriteString(w, `{"data":[`)
			for i, record := range records {
				if i > 0 {
					io.WriteString(w, ",")
				}
				fmt.Fprintf(w, `{"id":%q,"status":%q,"payment_intent":%q,"amount":%d}`, record.RefundID, record.Status, record.PaymentIntentID, record.Amount)
			}
			io.WriteString(w, `],"has_more":false}`)
		case "POST /v1/refunds":
			if state.failRefund {
				state.refundPosts++
				http.Error(w, `{"error":{"message":"temporary"}}`, http.StatusInternalServerError)
				return
			}
			if state.refundKeys == nil {
				state.refundKeys = map[string]string{}
			}
			key := r.Header.Get("Idempotency-Key")
			if refundID := state.refundKeys[key]; refundID != "" {
				record := state.refundRecords[refundID]
				fmt.Fprintf(w, `{"id":%q,"status":%q,"payment_intent":%q,"amount":%d}`, record.RefundID, record.Status, record.PaymentIntentID, record.Amount)
				return
			}
			state.refundPosts++
			_ = r.ParseForm()
			var amount int64
			fmt.Sscan(r.Form.Get("amount"), &amount)
			paymentIntent := r.Form.Get("payment_intent")
			if r.Form.Get("metadata[relayium_duplicate_refund_action_id]") != "" {
				state.refundActionMetadata = true
			}
			refundID := fmt.Sprintf("re_%s_%d", paymentIntent, state.refundPosts)
			status := state.nextRefundStatus
			if status == "" {
				status = "succeeded"
			}
			if state.providerRefundFailedOnce {
				state.providerRefundFailedOnce = false
				status = "failed"
				refundID = "re_failed"
			}
			record := duplicateRefundObservation{RefundID: refundID, PaymentIntentID: paymentIntent, Status: status, Amount: amount}
			state.refundKeys[key] = refundID
			state.refundRecords[refundID] = record
			if status == "succeeded" && state.refunds != nil {
				state.refunds[paymentIntent] += amount
				state.refunded = true
			} else {
				state.refunded = status == "succeeded"
			}
			fmt.Fprintf(w, `{"id":%q,"status":%q,"payment_intent":%q,"amount":%d}`, refundID, status, paymentIntent, amount)
		default:
			if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/refunds/") {
				id := strings.TrimPrefix(r.URL.Path, "/v1/refunds/")
				record, ok := state.refundRecords[id]
				if !ok {
					http.NotFound(w, r)
					return
				}
				body, _ := json.Marshal(map[string]any{"id": record.RefundID, "status": record.Status, "payment_intent": record.PaymentIntentID, "amount": record.Amount})
				w.Write(body)
				return
			}
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
	if err != nil || !result.SubscriptionCanceled || result.RefundComplete {
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

func TestAutomaticSinglePaymentUsesDurableRefundAction(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	plan, err := client.InspectDuplicateSubscription(context.Background(), "user_dup", "cus_dup", "sub_canonical", "sub_dup")
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.PutDuplicateRefund(context.Background(), plan, 100)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Config{})
	if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
		t.Fatal(err)
	}
	terminal, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if err != nil || terminal.State != "terminal" || !terminal.RefundComplete || evidence.ActionState != "succeeded" || state.refundPosts != 1 || !state.refundActionMetadata {
		t.Fatalf("terminal=%+v evidence=%+v posts=%d actionMetadata=%t err=%v", terminal, evidence, state.refundPosts, state.refundActionMetadata, err)
	}
}

func TestAutomaticSinglePaymentFailureStatesStayDurable(t *testing.T) {
	for _, tc := range []struct {
		name, status string
		failed       bool
		generation   int64
	}{{"pending", "pending", false, 1}, {"failed", "", true, 2}, {"canceled", "canceled", false, 2}} {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			state := &duplicateStripeState{active: true, refunds: map[string]int64{}, nextRefundStatus: tc.status, providerRefundFailedOnce: tc.failed}
			client, closeServer := newDuplicateStripe(t, state, false)
			defer closeServer()
			plan, err := client.InspectDuplicateSubscription(context.Background(), "user_dup", "cus_dup", "sub_canonical", "sub_dup")
			if err != nil {
				t.Fatal(err)
			}
			job, err := store.PutDuplicateRefund(context.Background(), plan, 100)
			if err != nil {
				t.Fatal(err)
			}
			svc := NewService(store, nil, Config{})
			if err := svc.runDuplicateRefund(context.Background(), store, client, job); err == nil {
				t.Fatalf("%s refund was accepted", tc.name)
			}
			got, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
			evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
			if err != nil || got.State != "manual" || got.RefundComplete || evidence.ActionGeneration != tc.generation || state.refundPosts != 1 {
				t.Fatalf("job=%+v evidence=%+v posts=%d err=%v", got, evidence, state.refundPosts, err)
			}
		})
	}
}

func TestAutomaticSinglePaymentLateFailureReopensAndConverges(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	plan, err := client.InspectDuplicateSubscription(context.Background(), "user_dup", "cus_dup", "sub_canonical", "sub_dup")
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.PutDuplicateRefund(context.Background(), plan, 100)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Config{})
	svc.biller = client
	if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
		t.Fatal(err)
	}
	var refundID string
	for id, record := range state.refundRecords {
		refundID = id
		record.Status = "failed"
		state.refundRecords[id] = record
		state.refunds[record.PaymentIntentID] = 0
	}
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-auto-late", refundID, "", "pi_dup", "failed", 200); err != nil {
		t.Fatal(err)
	}
	svc.ReconcileDuplicateRefunds(context.Background())
	terminal, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if err != nil || terminal.State != "terminal" || evidence.ActionGeneration != 2 || state.refundPosts != 2 {
		t.Fatalf("terminal=%+v evidence=%+v posts=%d err=%v", terminal, evidence, state.refundPosts, err)
	}
}

func TestDuplicateRefundPersistsEveryHistoricalInvoiceBeforeCancellation(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}, historicalRenewal: true}
	state.liabilitiesAtDelete = func() int {
		var count int
		_ = store.reader().QueryRow(`SELECT COUNT(*) FROM billing_duplicate_refund_liabilities`).Scan(&count)
		return count
	}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	plan, err := client.InspectDuplicateSubscription(context.Background(), "user_dup", "cus_dup", "sub_canonical", "sub_dup")
	if err != nil || len(plan.Liabilities) != 1 {
		t.Fatalf("initial plan=%+v err=%v", plan, err)
	}
	job, err := store.PutDuplicateRefund(context.Background(), plan, 100)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Config{})
	if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
		t.Fatal(err)
	}
	terminal, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if terminal.State != "terminal" || len(terminal.Liabilities) != 2 || state.refunds["pi_old"] != 200 || state.refunds["pi_new"] != 300 || state.deletes != 1 {
		t.Fatalf("terminal=%+v refunds=%v deletes=%d", terminal, state.refunds, state.deletes)
	}
}

func TestDuplicateRefundInvoiceHistoryPaginationFailsBeforeCancellation(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}, historyEmptyMore: true}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	if _, err := client.InspectDuplicateSubscription(context.Background(), "user_dup", "cus_dup", "sub_canonical", "sub_dup"); err == nil || state.deletes != 0 {
		t.Fatalf("history pagination err=%v deletes=%d", err, state.deletes)
	}
	var count int
	if err := store.reader().QueryRow(`SELECT COUNT(*) FROM billing_duplicate_refunds`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("responsibilities=%d err=%v", count, err)
	}
}

func TestDuplicateRefundInvoiceHistoryNonadvancingCursorFailsClosed(t *testing.T) {
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}, historyNonadvancing: true}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	if _, err := client.InspectDuplicateSubscription(context.Background(), "user_dup", "cus_dup", "sub_canonical", "sub_dup"); err == nil || state.deletes != 0 || state.invoiceListCalls < 2 {
		t.Fatalf("history cursor err=%v deletes=%d calls=%d", err, state.deletes, state.invoiceListCalls)
	}
}

func TestAccountPurgePreservesDuplicateRefundLiabilities(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	defer ts.Close()
	_ = loginCookie(t, ts, mail, "duplicate-liability-purge@example.com")
	userID := mustUserID(t, store, "duplicate-liability-purge@example.com")
	plan := DuplicateRefundPlan{
		UserID: userID, CustomerID: "cus_purge", CanonicalSubscriptionID: "sub_keep", DuplicateSubscriptionID: "sub_purge",
		Liabilities: []DuplicateRefundLiability{{InvoiceID: "in_purge", Payments: []CanonicalStripeInvoicePayment{{InvoicePaymentID: "inpay_purge", PaymentType: "payment_intent", PaymentIntentID: "pi_purge", ChargeID: "ch_purge", AmountPaid: 100, ChargeAmount: 100}}}},
	}
	job, err := store.PutDuplicateRefund(context.Background(), plan, 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ArchiveAndPurgeUser(context.Background(), userID, 200); err != nil {
		t.Fatal(err)
	}
	preserved, ok, err := store.DuplicateRefundBySubscription(context.Background(), "sub_purge")
	if err != nil || !ok || preserved.ID != job.ID || len(preserved.Liabilities) != 1 || preserved.Liabilities[0].InvoiceID != "in_purge" {
		t.Fatalf("preserved=%+v ok=%t err=%v", preserved, ok, err)
	}
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
	var proofRaw string
	if err := store.reader().QueryRow(`SELECT proof_json FROM billing_duplicate_refund_actions WHERE id=?`, result.ActionID).Scan(&proofRaw); err != nil {
		t.Fatal(err)
	}
	proof, err := decodeDuplicateRefundProof(proofRaw)
	if err != nil || len(proof.Refunds) != 2 || proof.Refunds[0].RefundID >= proof.Refunds[1].RefundID {
		t.Fatalf("proof=%+v err=%v", proof, err)
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
	proof, err := executeDuplicateRefundAction(context.Background(), store, client, job, action)
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

func TestDuplicateRefundCanceledResponseIsAbsorbingFailure(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}, nextRefundStatus: "canceled"}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "canceled refund audit"); !errors.Is(err, errDuplicateRefundReopened) {
		t.Fatalf("canceled refund err=%v", err)
	}
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	var inboxStatus string
	if scanErr := store.reader().QueryRow(`SELECT status FROM billing_deletion_refund_inbox LIMIT 1`).Scan(&inboxStatus); scanErr != nil {
		t.Fatal(scanErr)
	}
	if err != nil || evidence.ActionGeneration != 2 || evidence.ActionState != "prepared" || inboxStatus != "failed" {
		t.Fatalf("evidence=%+v inbox=%q err=%v", evidence, inboxStatus, err)
	}
}

func TestDuplicateRefundOperatorPendingRefundCannotBecomeTerminal(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}, nextRefundStatus: "pending"}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "pending refund audit"); !errors.Is(err, errDuplicateRefundPending) {
		t.Fatalf("pending resolve err=%v", err)
	}
	got, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if got.State != "manual" || got.RefundComplete {
		t.Fatalf("pending refund became terminal: %+v", got)
	}
	var actionState, constituentState string
	if err := store.reader().QueryRow(`SELECT state FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, job.ID).Scan(&actionState); err != nil {
		t.Fatal(err)
	}
	if err := store.reader().QueryRow(`SELECT status FROM billing_duplicate_refund_constituents WHERE job_id=? LIMIT 1`, job.ID).Scan(&constituentState); err != nil {
		t.Fatal(err)
	}
	if actionState != "prepared" || constituentState != "pending" {
		t.Fatalf("action=%q constituent=%q", actionState, constituentState)
	}
}

func TestDuplicateRefundLateFailureReopensTerminalAndNextGenerationRefundsRemaining(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "late failure audit"); err != nil {
		t.Fatal(err)
	}
	var refundID string
	for id := range state.refundRecords {
		refundID = id
	}
	if refundID == "" {
		t.Fatal("refund identity was not captured")
	}
	state.mu.Lock()
	record := state.refundRecords[refundID]
	record.Status = "failed"
	state.refundRecords[refundID] = record
	state.refunds[record.PaymentIntentID] -= record.Amount
	state.mu.Unlock()
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-late-failed", refundID, "", record.PaymentIntentID, "failed", 200); err != nil {
		t.Fatal(err)
	}
	reopened, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if err != nil || reopened.State != "manual" || reopened.RefundComplete || evidence.ActionGeneration != 2 || evidence.ActionState != "prepared" {
		t.Fatalf("reopened=%+v evidence=%+v err=%v", reopened, evidence, err)
	}
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "late failure audit"); err != nil {
		t.Fatal(err)
	}
	terminal, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	evidence, _ = ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if terminal.State != "terminal" || !terminal.RefundComplete || evidence.ActionGeneration != 2 || state.refundPosts != 3 {
		t.Fatalf("terminal=%+v evidence=%+v posts=%d", terminal, evidence, state.refundPosts)
	}
}

func TestDuplicateRefundFailureBeforeBindingIsAbsorbingAndIdempotent(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	// The deterministic first provider response uses this identity. The signed
	// webhook can arrive before the provider response is durably bound locally.
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-before-binding", "re_pi_a_1", "", "pi_a", "failed", 200); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "orphan failure audit"); !errors.Is(err, errDuplicateRefundReopened) {
		t.Fatalf("orphan failure err=%v", err)
	}
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if err != nil || evidence.ActionGeneration != 2 || evidence.ActionState != "prepared" {
		t.Fatalf("evidence=%+v err=%v", evidence, err)
	}
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-before-binding-repeat", "re_pi_a_1", "", "pi_a", "succeeded", 201); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-before-binding-failed-repeat", "re_pi_a_1", "", "pi_a", "failed", 202); err != nil {
		t.Fatal(err)
	}
	evidence, err = ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if err != nil || evidence.ActionGeneration != 2 {
		t.Fatalf("duplicate/out-of-order failure rotated again: evidence=%+v err=%v", evidence, err)
	}
	var inboxStatus string
	if err := store.reader().QueryRow(`SELECT status FROM billing_deletion_refund_inbox WHERE refund_id='re_pi_a_1'`).Scan(&inboxStatus); err != nil || inboxStatus != "failed" {
		t.Fatalf("absorbing inbox status=%q err=%v", inboxStatus, err)
	}
}

func TestWebhookRefundFailedReopensEveryBoundDuplicateAction(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	defer ts.Close()
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	svc.biller = client
	job := prepareCanceledManualDuplicate(t, store, client, state)
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "signed webhook audit"); err != nil {
		t.Fatal(err)
	}
	var refundID, paymentIntentID string
	for id, record := range state.refundRecords {
		refundID, paymentIntentID = id, record.PaymentIntentID
		break
	}
	created := time.Now().Unix()
	body := fmt.Sprintf(`{"id":"evt_duplicate_refund_failed","type":"refund.failed","created":%d,"data":{"object":{"id":%q,"object":"refund","payment_intent":%q}}}`, created, refundID, paymentIntentID)
	resp := postWebhook(t, ts, "whsec", body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("signed refund.failed status=%d", resp.StatusCode)
	}
	reopened, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if err != nil || reopened.State != "manual" || reopened.RefundComplete || evidence.ActionGeneration != 2 || evidence.ActionState != "prepared" {
		t.Fatalf("reopened=%+v evidence=%+v err=%v", reopened, evidence, err)
	}
	resp = postWebhook(t, ts, "whsec", body)
	defer resp.Body.Close()
	evidence, err = ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if resp.StatusCode != http.StatusOK || err != nil || evidence.ActionGeneration != 2 {
		t.Fatalf("duplicate webhook status=%d evidence=%+v err=%v", resp.StatusCode, evidence, err)
	}
}

func TestWebhookRefundUpdatedCanceledForcesAbsorbingFailure(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	defer ts.Close()
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	svc.biller = client
	job := prepareCanceledManualDuplicate(t, store, client, state)
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "canceled webhook audit"); err != nil {
		t.Fatal(err)
	}
	var refundID, paymentIntentID string
	for id, record := range state.refundRecords {
		refundID, paymentIntentID = id, record.PaymentIntentID
		break
	}
	body := fmt.Sprintf(`{"id":"evt_duplicate_refund_canceled","type":"refund.updated","created":%d,"data":{"object":{"id":%q,"object":"refund","payment_intent":%q,"status":"canceled"}}}`, time.Now().Unix(), refundID, paymentIntentID)
	resp := postWebhook(t, ts, "whsec", body)
	defer resp.Body.Close()
	evidence, err := ListDuplicateRefundEvidence(context.Background(), store, job.ID)
	if resp.StatusCode != http.StatusOK || err != nil || evidence.ActionGeneration != 2 || evidence.ActionState != "prepared" {
		t.Fatalf("status=%d evidence=%+v err=%v", resp.StatusCode, evidence, err)
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

func TestDuplicateRefundWorkerAndOperatorConcurrentOwnershipConverges(t *testing.T) {
	store := newTestStore(t)
	state := &duplicateStripeState{active: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, true)
	defer closeServer()
	job := prepareCanceledManualDuplicate(t, store, client, state)
	svc := NewService(store, nil, Config{})
	start := make(chan struct{})
	errs := make(chan error, 2)
	go func() {
		<-start
		errs <- svc.runDuplicateRefund(context.Background(), store, client, job)
	}()
	go func() {
		<-start
		_, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "operator", "concurrent worker audit")
		errs <- err
	}()
	close(start)
	<-errs
	<-errs
	got, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if got.State != "terminal" {
		var actor, reason string
		if err := store.reader().QueryRow(`SELECT actor,reason FROM billing_duplicate_refund_actions WHERE job_id=? ORDER BY generation DESC LIMIT 1`, job.ID).Scan(&actor, &reason); err != nil {
			t.Fatal(err)
		}
		if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, actor, reason); err != nil {
			t.Fatal(err)
		}
	}
	got, _, _ = store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if got.State != "terminal" || state.refundPosts != 2 {
		t.Fatalf("job=%+v refundPosts=%d", got, state.refundPosts)
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
	state := &duplicateStripeState{active: true, failRefund: true, refunds: map[string]int64{}}
	client, closeServer := newDuplicateStripe(t, state, false)
	defer closeServer()
	job := prepareDuplicateJob(t, store, client)
	svc := NewService(store, nil, Config{})
	if err := svc.runDuplicateRefund(context.Background(), store, client, job); err == nil {
		t.Fatal("provider failure was accepted")
	}
	job, ok, err := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if err != nil || !ok || !job.SubscriptionCanceled || job.State != "manual" {
		t.Fatalf("job=%+v ok=%v err=%v", job, ok, err)
	}
	state.failRefund = false
	if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
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
	if job.State != "pending" || len(job.Payments) != 2 {
		t.Fatalf("prepared=%+v", job)
	}
	svc := NewService(store, nil, Config{})
	if err := svc.runDuplicateRefund(context.Background(), store, client, job); err != nil {
		t.Fatal(err)
	}
	got, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if got.State != "terminal" || !got.SubscriptionCanceled || !got.RefundComplete || state.refundPosts != 2 {
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
	if err != nil || !result.SubscriptionCanceled || result.RefundComplete {
		t.Fatalf("cancel=%+v err=%v", result, err)
	}
	if err := store.SaveDuplicateRefund(context.Background(), job, result, nil, 101); err != nil {
		t.Fatal(err)
	}
	job, _, _ = store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	action, err := prepareDuplicateRefundAction(context.Background(), store, job, "relayium-worker", "automatic duplicate subscription refund", 102)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := executeDuplicateRefundAction(context.Background(), store, client, job, action); err != nil {
		t.Fatal(err)
	}
	// Crash before finish: provider and constituent binding succeeded, action did not.
	if _, err := ResolveDuplicateRefund(context.Background(), store, client, job.ID, "relayium-worker", "automatic duplicate subscription refund"); err != nil {
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
	if err := svc.runDuplicateRefund(context.Background(), store, client, job); err == nil {
		t.Fatal("first provider failure was accepted")
	}
	state.failRefund = false
	svc.ReconcileDuplicateRefunds(context.Background())
	got, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_dup")
	if got.State != "terminal" || state.refundPosts != 2 {
		t.Fatalf("job=%+v refunds=%d", got, state.refundPosts)
	}
}
