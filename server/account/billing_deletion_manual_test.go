package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestManualDeletionRefundRequiresCanonicalSuccessAndIsIdempotent(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{
		"invoice:in_paid": {Kind: "invoice", ID: "in_paid", CustomerID: "cus_1", Status: "paid_after_deletion", Manual: true},
		"charge:ch_paid":  {Kind: "charge", ID: "ch_paid", PaymentIntentID: "pi_paid", CustomerID: "cus_1", Status: "succeeded_after_deletion", Manual: true},
	}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_manual','subject','stripe','delete-key','pending',?,1,1,1,1)`, string(raw)); err != nil {
		t.Fatal(err)
	}
	var posts int
	var actionID string
	var refunded bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/invoices/in_paid":
			io.WriteString(w, `{"id":"in_paid","payment_intent":"pi_paid"}`)
		case "GET /v1/refunds":
			io.WriteString(w, `{"data":[]}`)
		case "GET /v1/payment_intents/pi_paid":
			io.WriteString(w, `{"id":"pi_paid","latest_charge":"ch_paid"}`)
		case "GET /v1/charges/ch_paid":
			if refunded {
				io.WriteString(w, `{"id":"ch_paid","payment_intent":"pi_paid","amount":500,"amount_refunded":500,"refunded":true}`)
			} else {
				io.WriteString(w, `{"id":"ch_paid","payment_intent":"pi_paid","amount":500,"amount_refunded":0,"refunded":false}`)
			}
		case "POST /v1/refunds":
			posts++
			refunded = true
			body, _ := io.ReadAll(r.Body)
			form, _ := url.ParseQuery(string(body))
			actionID = form.Get("metadata[relayium_deletion_action_id]")
			if form.Get("payment_intent") != "pi_paid" || form.Get("amount") != "500" || actionID == "" || r.Header.Get("Idempotency-Key") != "acct-delete-refund:"+actionID {
				t.Fatalf("unsafe refund request form=%v key=%q", form, r.Header.Get("Idempotency-Key"))
			}
			io.WriteString(w, `{"id":"re_safe"}`)
		case "GET /v1/refunds/re_safe":
			io.WriteString(w, `{"id":"re_safe","status":"succeeded","payment_intent":"pi_paid","metadata":{"relayium_deletion_action_id":"`+actionID+`"}}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	result, err := ResolveBillingDeletionRefund(context.Background(), store, c, "out_manual", "invoice:in_paid", "operator@example.test", "verified duplicate charge")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.RefundID != "re_safe" || posts != 1 {
		t.Fatalf("result=%+v posts=%d", result, posts)
	}
	var progress, actor, reason, state string
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE id='out_manual'`).Scan(&progress); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT actor,reason,state FROM billing_deletion_manual_actions WHERE id=?`, result.ActionID).Scan(&actor, &reason, &state); err != nil {
		t.Fatal(err)
	}
	if r := decodeDeletionProgress(progress).Resources["invoice:in_paid"]; !r.Terminal || r.Manual || r.Status != "refunded" {
		t.Fatalf("resource=%+v", r)
	}
	if actor != "operator@example.test" || reason != "verified duplicate charge" || state != "succeeded" {
		t.Fatalf("audit actor=%q reason=%q state=%q", actor, reason, state)
	}
	if _, err := ResolveBillingDeletionRefund(context.Background(), store, c, "out_manual", "charge:ch_paid", actor, reason); err != nil {
		t.Fatal(err)
	}
	if posts != 1 {
		t.Fatalf("idempotent retry created %d refunds", posts)
	}
}

func TestFailedRefundReopensHazardAndRotatesProviderAction(t *testing.T) {
	store := newTestStore(t)
	now := int64(100)
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{
		"payment_intent:pi_failed": {Kind: "payment_intent", ID: "pi_failed", PaymentIntentID: "pi_failed", Status: "refund_pending", Manual: true},
	}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES('subject',X'01','stripe',?,?,?,99)`, now, now+1000, now+1000); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,generation,progress_json) VALUES('out','subject','stripe','idem','pending',?,?,1,?)`, now, now, string(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,payment_intent_id,refund_id,state,created_at,updated_at) VALUES('action-old','out','payment_intent:pi_failed','operator','customer deletion','pi_failed','re_failed','prepared',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "re_failed", "action-old", "pending", 105); err != nil {
		t.Fatal(err)
	}
	var providerStatus string
	if err := store.db.QueryRow(`SELECT provider_status FROM billing_deletion_manual_actions WHERE id='action-old'`).Scan(&providerStatus); err != nil || providerStatus != "pending" {
		t.Fatalf("provider status=%q err=%v", providerStatus, err)
	}
	if err := store.RecordStripeDeletionRefundFailure(context.Background(), "re_failed", "action-old", 110); err != nil {
		t.Fatal(err)
	}
	var action, refund string
	var generation, released int64
	if err := store.db.QueryRow(`SELECT id,refund_id,retry_generation FROM billing_deletion_manual_actions WHERE outbox_id='out'`).Scan(&action, &refund, &generation); err != nil {
		t.Fatal(err)
	}
	if action == "action-old" || refund != "" || generation != 1 {
		t.Fatalf("rotated action=%q refund=%q generation=%d", action, refund, generation)
	}
	if err := store.db.QueryRow(`SELECT subject_released_at FROM billing_deletion_holds WHERE billing_subject_id='subject'`).Scan(&released); err != nil || released != 0 {
		t.Fatalf("hold released=%d err=%v", released, err)
	}
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE id='out'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	p, err := decodeDeletionProgressStrict(string(raw))
	if err != nil || !p.Resources["payment_intent:pi_failed"].Manual || p.Resources["payment_intent:pi_failed"].Terminal {
		t.Fatalf("reopened progress=%+v err=%v", p, err)
	}
	if err := store.RecordStripeDeletionRefundFailure(context.Background(), "re_failed", "action-old", 111); err != nil {
		t.Fatal(err)
	}
	var failures int
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_refund_failures WHERE refund_id='re_failed'`).Scan(&failures)
	if failures != 1 {
		t.Fatalf("failure audit rows=%d", failures)
	}
}

func TestLateFailedRefundAfterTerminalCreatesANewDeletionGeneration(t *testing.T) {
	store := newTestStore(t)
	now := int64(200)
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{
		"payment_intent:pi_late": {Kind: "payment_intent", ID: "pi_late", PaymentIntentID: "pi_late", Status: "refunded", Terminal: true},
	}, CleanSince: 100}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES('subject-late',X'02','stripe',?,?,?,150)`, now, now+1000, now+1000); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,generation,progress_json,terminal_at) VALUES('out-old','subject-late','stripe','idem-old','terminal',?,?,1,?,150)`, now, now, string(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,payment_intent_id,refund_id,state,created_at,updated_at) VALUES('action-late','out-old','payment_intent:pi_late','operator','customer deletion','pi_late','re_late','succeeded',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordStripeDeletionRefundFailure(context.Background(), "re_late", "action-late", 210); err != nil {
		t.Fatal(err)
	}
	var generation, released int64
	var state, nextRaw string
	if err := store.db.QueryRow(`SELECT generation,state,progress_json FROM billing_cancellation_outbox WHERE billing_subject_id='subject-late' ORDER BY generation DESC LIMIT 1`).Scan(&generation, &state, &nextRaw); err != nil {
		t.Fatal(err)
	}
	if generation != 2 || state != "pending" {
		t.Fatalf("late generation=%d state=%s", generation, state)
	}
	next, err := decodeDeletionProgressStrict(nextRaw)
	if err != nil || !next.Resources["payment_intent:pi_late"].Manual || next.Resources["payment_intent:pi_late"].Terminal {
		t.Fatalf("late progress=%+v err=%v", next, err)
	}
	if err := store.db.QueryRow(`SELECT subject_released_at FROM billing_deletion_holds WHERE billing_subject_id='subject-late'`).Scan(&released); err != nil || released != 0 {
		t.Fatalf("late hold released=%d err=%v", released, err)
	}
}

func TestMeteredDeletionOperatorDiscardsPendingBillingAndRequiresCanonicalCancel(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Customers: []string{"cus_metered"}, Resources: map[string]BillingDeletionResource{
		"subscription:sub_metered": {Kind: "subscription", ID: "sub_metered", CustomerID: "cus_metered", Status: "metered_usage_requires_operator", Manual: true},
	}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_metered','subject','stripe','delete-metered','pending',?,1,1,1,1)`, string(raw)); err != nil {
		t.Fatal(err)
	}
	var subReads, itemDeletes, subDeletes int
	var unsafeForm bool
	var observedPrepared bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/subscriptions/sub_metered":
			subReads++
			var prepared int
			_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_metered_actions WHERE outbox_id='out_metered' AND state='prepared'`).Scan(&prepared)
			observedPrepared = prepared == 1
			status := "active"
			if subReads > 1 {
				status = "canceled"
			}
			io.WriteString(w, `{"id":"sub_metered","customer":"cus_metered","status":"`+status+`","items":{"data":[{"price":{"recurring":{"usage_type":"licensed"}}},{"price":{"recurring":{"usage_type":"metered"}}}]}}`)
		case "GET /v1/invoiceitems":
			io.WriteString(w, `{"data":[{"id":"ii_pending"}],"has_more":false}`)
		case "DELETE /v1/invoiceitems/ii_pending":
			itemDeletes++
			io.WriteString(w, `{}`)
		case "DELETE /v1/subscriptions/sub_metered":
			subDeletes++
			body, err := io.ReadAll(r.Body)
			form, parseErr := url.ParseQuery(string(body))
			if err != nil || parseErr != nil || form.Get("invoice_now") != "false" || form.Get("prorate") != "false" {
				unsafeForm = true
			}
			io.WriteString(w, `{"id":"sub_metered","status":"canceled"}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	if err := ResolveBillingDeletionMetered(context.Background(), store, c, "out_metered", "subscription:sub_metered", "operator", "verified legacy metered deletion"); err != nil {
		t.Fatal(err)
	}
	if itemDeletes != 1 || subDeletes != 1 || subReads != 2 || unsafeForm || !observedPrepared {
		t.Fatalf("reads=%d item deletes=%d subscription deletes=%d unsafe form=%t prepared=%t", subReads, itemDeletes, subDeletes, unsafeForm, observedPrepared)
	}
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE id='out_metered'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	p, err := decodeDeletionProgressStrict(string(raw))
	if err != nil || !p.Resources["subscription:sub_metered"].Terminal || p.Resources["subscription:sub_metered"].Manual {
		t.Fatalf("metered progress=%+v err=%v", p, err)
	}
}

func TestMeteredDeletionRerunConvergesAfterProviderCompletedBeforeLocalCommit(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Customers: []string{"cus_crash"}, Resources: map[string]BillingDeletionResource{
		"subscription:sub_crash": {Kind: "subscription", ID: "sub_crash", CustomerID: "cus_crash", Status: "metered_usage_requires_operator", Manual: true},
	}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_crash','subject','stripe','delete-crash','pending',?,1,1,1,1)`, string(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_metered_actions(id,outbox_id,resource_key,actor,reason,state,created_at,updated_at) VALUES('bdm_out_crash_sub_crash','out_crash','subscription:sub_crash','operator','legacy cleanup','prepared',1,1)`); err != nil {
		t.Fatal(err)
	}
	var providerMutations int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			providerMutations++
		}
		if r.URL.Path == "/v1/subscriptions/sub_crash" {
			http.Error(w, `{"error":{"message":"No such subscription"}}`, http.StatusNotFound)
			return
		}
		if r.URL.Path == "/v1/invoiceitems" {
			io.WriteString(w, `{"data":[],"has_more":false}`)
			return
		}
		http.Error(w, "unexpected", http.StatusBadRequest)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	if err := ResolveBillingDeletionMetered(context.Background(), store, c, "out_crash", "subscription:sub_crash", "different", "legacy cleanup"); err == nil {
		t.Fatal("actor conflict accepted")
	}
	if providerMutations != 0 {
		t.Fatal("actor conflict reached provider")
	}
	if err := ResolveBillingDeletionMetered(context.Background(), store, c, "out_crash", "subscription:sub_crash", "operator", "legacy cleanup"); err != nil {
		t.Fatal(err)
	}
	if providerMutations != 0 {
		t.Fatalf("rerun repeated provider mutation %d times", providerMutations)
	}
}

func TestManualDeletionRefundDoesNotAcceptPendingCanonicalRefund(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"payment_intent:pi_pending": {Kind: "payment_intent", ID: "pi_pending", Manual: true, Status: "processing"}}}
	raw, _ := json.Marshal(p)
	_, _ = store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_pending','subject','stripe','pending-key','pending',?,1,1,1,1)`, string(raw))
	var actionID string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/v1/refunds" {
			io.WriteString(w, `{"data":[]}`)
			return
		}
		if r.URL.Path == "/v1/payment_intents/pi_pending" {
			io.WriteString(w, `{"id":"pi_pending","latest_charge":"ch_pending"}`)
			return
		}
		if r.URL.Path == "/v1/charges/ch_pending" {
			io.WriteString(w, `{"id":"ch_pending","payment_intent":"pi_pending","amount":500,"amount_refunded":0,"refunded":false}`)
			return
		}
		if r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			form, _ := url.ParseQuery(string(body))
			actionID = form.Get("metadata[relayium_deletion_action_id]")
			io.WriteString(w, `{"id":"re_pending"}`)
			return
		}
		io.WriteString(w, `{"id":"re_pending","status":"pending","payment_intent":"pi_pending","metadata":{"relayium_deletion_action_id":"`+actionID+`"}}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	if _, err := ResolveBillingDeletionRefund(context.Background(), store, c, "out_pending", "payment_intent:pi_pending", "operator", "customer approved"); err == nil {
		t.Fatal("pending refund incorrectly closed manual hazard")
	}
	var progress string
	_ = store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE id='out_pending'`).Scan(&progress)
	if r := decodeDeletionProgress(progress).Resources["payment_intent:pi_pending"]; !r.Manual || r.Terminal {
		t.Fatalf("pending refund mutated hazard: %+v", r)
	}
}

func TestManualCheckoutRefundFollowsSubscriptionLatestInvoice(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"checkout_session:cs_paid": {Kind: "checkout_session", ID: "cs_paid", Manual: true, Status: "paid_time_unknown"}}}
	raw, _ := json.Marshal(p)
	_, _ = store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_checkout','subject','stripe','checkout-key','pending',?,1,1,1,1)`, string(raw))
	var actionID string
	var refunded bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/checkout/sessions/cs_paid":
			io.WriteString(w, `{"id":"cs_paid","subscription":"sub_paid"}`)
		case "GET /v1/subscriptions/sub_paid":
			io.WriteString(w, `{"id":"sub_paid","latest_invoice":"in_paid"}`)
		case "GET /v1/invoices/in_paid":
			io.WriteString(w, `{"id":"in_paid","payment_intent":"pi_paid"}`)
		case "GET /v1/refunds":
			io.WriteString(w, `{"data":[]}`)
		case "GET /v1/payment_intents/pi_paid":
			io.WriteString(w, `{"id":"pi_paid","latest_charge":"ch_paid"}`)
		case "GET /v1/charges/ch_paid":
			if refunded {
				io.WriteString(w, `{"id":"ch_paid","payment_intent":"pi_paid","amount":500,"amount_refunded":500,"refunded":true}`)
			} else {
				io.WriteString(w, `{"id":"ch_paid","payment_intent":"pi_paid","amount":500,"amount_refunded":0,"refunded":false}`)
			}
		case "POST /v1/refunds":
			refunded = true
			body, _ := io.ReadAll(r.Body)
			form, _ := url.ParseQuery(string(body))
			actionID = form.Get("metadata[relayium_deletion_action_id]")
			io.WriteString(w, `{"id":"re_checkout"}`)
		case "GET /v1/refunds/re_checkout":
			io.WriteString(w, `{"id":"re_checkout","status":"succeeded","payment_intent":"pi_paid","metadata":{"relayium_deletion_action_id":"`+actionID+`"}}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	if _, err := ResolveBillingDeletionRefund(context.Background(), store, c, "out_checkout", "checkout_session:cs_paid", "operator", "verified late subscription payment"); err != nil {
		t.Fatal(err)
	}
}
