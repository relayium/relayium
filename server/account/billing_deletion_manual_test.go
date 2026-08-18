package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
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
			if refunded {
				io.WriteString(w, `{"data":[{"id":"re_safe","status":"succeeded","payment_intent":"pi_paid","amount":500}],"has_more":false}`)
			} else {
				io.WriteString(w, `{"data":[],"has_more":false}`)
			}
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
			io.WriteString(w, `{"id":"re_safe","status":"succeeded","payment_intent":"pi_paid","amount":500,"metadata":{"relayium_deletion_action_id":"`+actionID+`"}}`)
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
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-pending", "re_failed", "action-old", "pi_failed", "pending", 105); err != nil {
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
	if err := store.db.QueryRow(`SELECT id,refund_id,retry_generation FROM billing_deletion_manual_actions WHERE outbox_id='out' ORDER BY retry_generation DESC LIMIT 1`).Scan(&action, &refund, &generation); err != nil {
		t.Fatal(err)
	}
	if action == "action-old" || refund != "" || generation != 1 {
		t.Fatalf("rotated action=%q refund=%q generation=%d", action, refund, generation)
	}
	var oldState string
	if err := store.db.QueryRow(`SELECT state FROM billing_deletion_manual_actions WHERE id='action-old'`).Scan(&oldState); err != nil || oldState != "failed" {
		t.Fatalf("old action state=%q err=%v", oldState, err)
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
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-succeeded", "re_failed", "action-old", "pi_failed", "succeeded", 112); err != nil {
		t.Fatal(err)
	}
	var oldProviderStatus string
	if err := store.db.QueryRow(`SELECT state,provider_status FROM billing_deletion_manual_actions WHERE id='action-old'`).Scan(&oldState, &oldProviderStatus); err != nil || oldState != "failed" || oldProviderStatus != "failed" {
		t.Fatalf("late success overwrote failed action: state=%q provider=%q err=%v", oldState, oldProviderStatus, err)
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

func TestMeteredDeletionCanonicalTerminalSkipsSubscriptionDelete(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Customers: []string{"cus_terminal"}, Resources: map[string]BillingDeletionResource{
		"subscription:sub_terminal": {Kind: "subscription", ID: "sub_terminal", CustomerID: "cus_terminal", Status: "metered_usage_requires_operator", Manual: true},
	}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_terminal','subject','stripe','delete-terminal','pending',?,1,1,1,1)`, string(raw)); err != nil {
		t.Fatal(err)
	}
	var deletes int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletes++
		}
		switch r.URL.Path {
		case "/v1/subscriptions/sub_terminal":
			io.WriteString(w, `{"id":"sub_terminal","customer":"cus_terminal","status":"incomplete_expired","items":{"data":[]}}`)
		case "/v1/invoiceitems":
			io.WriteString(w, `{"data":[],"has_more":false}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	if err := ResolveBillingDeletionMetered(context.Background(), store, c, "out_terminal", "subscription:sub_terminal", "operator", "verified terminal metered subscription"); err != nil {
		t.Fatal(err)
	}
	if deletes != 0 {
		t.Fatalf("canonical terminal subscription was deleted again: %d DELETEs", deletes)
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

func TestManualDeletionRefundAdoptsOneCanonicalExternalFullRefund(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Customers: []string{"cus_ext"}, Resources: map[string]BillingDeletionResource{
		"charge:ch_ext": {Kind: "charge", ID: "ch_ext", PaymentIntentID: "pi_ext", CustomerID: "cus_ext", Status: "succeeded_after_deletion", Manual: true},
	}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES('subject',X'08','stripe',1,2,3,99)`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_ext','subject','stripe','delete-ext','pending',?,1,1,1,1)`, string(raw)); err != nil {
		t.Fatal(err)
	}
	var refundPosts int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/payment_intents/pi_ext":
			io.WriteString(w, `{"latest_charge":"ch_ext"}`)
		case "GET /v1/charges/ch_ext":
			io.WriteString(w, `{"id":"ch_ext","payment_intent":"pi_ext","amount":500,"amount_refunded":500,"refunded":true}`)
		case "GET /v1/refunds":
			if r.URL.Query().Get("starting_after") == "re_part_a" {
				io.WriteString(w, `{"data":[{"id":"re_part_b","status":"succeeded","payment_intent":"pi_ext","amount":300}],"has_more":false}`)
			} else {
				io.WriteString(w, `{"data":[{"id":"re_failed_old","status":"failed","payment_intent":"pi_ext","amount":100},{"id":"re_part_a","status":"succeeded","payment_intent":"pi_ext","amount":200}],"has_more":true}`)
			}
		case "GET /v1/refunds/re_part_a":
			io.WriteString(w, `{"id":"re_part_a","status":"succeeded","payment_intent":"pi_ext","amount":200,"metadata":{}}`)
		case "GET /v1/refunds/re_part_b":
			io.WriteString(w, `{"id":"re_part_b","status":"succeeded","payment_intent":"pi_ext","amount":300,"metadata":{}}`)
		case "POST /v1/refunds":
			refundPosts++
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	for i := 0; i < 2; i++ {
		result, err := ResolveBillingDeletionRefund(context.Background(), store, c, "out_ext", "charge:ch_ext", "operator", "adopt verified external refund")
		if err != nil || result.RefundID != "re_part_a" || refundPosts != 0 {
			t.Fatalf("iteration=%d result=%+v posts=%d err=%v", i, result, refundPosts, err)
		}
	}
	var status, proof string
	if err := store.db.QueryRow(`SELECT provider_status,refund_proof FROM billing_deletion_manual_actions WHERE outbox_id='out_ext' ORDER BY retry_generation DESC LIMIT 1`).Scan(&status, &proof); err != nil || status != "adopted_external" || !strings.Contains(proof, "re_part_a") || !strings.Contains(proof, "re_part_b") || !strings.Contains(proof, "re_failed_old") {
		t.Fatalf("provider status=%q proof=%q err=%v", status, proof, err)
	}
	var constituents int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_refund_constituents WHERE outbox_id='out_ext'`).Scan(&constituents); err != nil || constituents != 3 {
		t.Fatalf("constituents=%d err=%v", constituents, err)
	}
	if err := store.RecordStripeDeletionRefundFailure(context.Background(), "re_part_b", "", 200); err != nil {
		t.Fatal(err)
	}
	var generation int
	var actionState string
	if err := store.db.QueryRow(`SELECT retry_generation,state FROM billing_deletion_manual_actions WHERE outbox_id='out_ext' ORDER BY retry_generation DESC LIMIT 1`).Scan(&generation, &actionState); err != nil || generation != 1 || actionState != "prepared" {
		t.Fatalf("late constituent generation=%d state=%s err=%v", generation, actionState, err)
	}
}

func TestManualDeletionRefundRejectsMissingCanonicalRefundAmount(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"charge:ch_missing": {Kind: "charge", ID: "ch_missing", PaymentIntentID: "pi_missing", Status: "succeeded_after_deletion", Manual: true}}}
	raw, _ := json.Marshal(p)
	_, _ = store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_missing','subject','stripe','delete-missing','pending',?,1,1,1,1)`, string(raw))
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/payment_intents/pi_missing":
			io.WriteString(w, `{"latest_charge":"ch_missing"}`)
		case "/v1/charges/ch_missing":
			io.WriteString(w, `{"id":"ch_missing","payment_intent":"pi_missing","amount":500,"amount_refunded":500,"refunded":true}`)
		case "/v1/refunds":
			io.WriteString(w, `{"data":[{"id":"re_missing","status":"succeeded","payment_intent":"pi_missing"}],"has_more":false}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	if _, err := ResolveBillingDeletionRefund(context.Background(), store, c, "out_missing", "charge:ch_missing", "operator", "audit"); err == nil {
		t.Fatal("refund without an amount was accepted")
	}
}

func TestRefundFailureIsDurableBeforeActionBinding(t *testing.T) {
	store := newTestStore(t)
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-orphan", "re_orphan", "", "pi_orphan", "failed", 123); err != nil {
		t.Fatal(err)
	}
	var status, paymentIntent string
	var eventAt int64
	if err := store.db.QueryRow(`SELECT status,payment_intent_id,event_at FROM billing_deletion_refund_inbox WHERE refund_id='re_orphan'`).Scan(&status, &paymentIntent, &eventAt); err != nil || status != "failed" || paymentIntent != "pi_orphan" || eventAt != 123 {
		t.Fatalf("orphan status=%q pi=%q at=%d err=%v", status, paymentIntent, eventAt, err)
	}
}

func TestRefundFailureIsAbsorbingAndAuditsEveryEvent(t *testing.T) {
	store := newTestStore(t)
	for _, event := range []struct {
		id, status string
		at         int64
	}{{"evt-fail", "failed", 100}, {"evt-same", "pending", 100}, {"evt-late", "succeeded", 101}} {
		if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), event.id, "re_absorb", "", "pi_absorb", event.status, event.at); err != nil {
			t.Fatal(err)
		}
	}
	var status string
	var events int
	if err := store.db.QueryRow(`SELECT status FROM billing_deletion_refund_inbox WHERE refund_id='re_absorb'`).Scan(&status); err != nil || status != "failed" {
		t.Fatalf("absorbing status=%q err=%v", status, err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_refund_events WHERE refund_id='re_absorb'`).Scan(&events); err != nil || events != 3 {
		t.Fatalf("events=%d err=%v", events, err)
	}
}

func TestRefundFailureRotatesEveryDependentAction(t *testing.T) {
	store := newTestStore(t)
	raw, _ := json.Marshal(BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"payment_intent:pi_shared": {Kind: "payment_intent", ID: "pi_shared", PaymentIntentID: "pi_shared", Status: "refunded", Terminal: true}}})
	for i := 1; i <= 2; i++ {
		out := fmt.Sprintf("out-%d", i)
		subject := fmt.Sprintf("subject-%d", i)
		action := fmt.Sprintf("action-%d", i)
		if _, err := store.db.Exec(`INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES(?,X'09','stripe',1,2,3,99)`, subject); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation) VALUES(?,?, 'stripe',?,'pending',?,1,1,1)`, out, subject, "key-"+out, string(raw)); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec(`INSERT INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,payment_intent_id,refund_id,state,retry_generation,provider_status,refund_proof,created_at,updated_at) VALUES(?,?,'payment_intent:pi_shared','operator','audit','pi_shared','re_primary','succeeded',0,'succeeded','proof',1,1)`, action, out); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec(`INSERT INTO billing_deletion_refund_constituents(action_id,outbox_id,payment_intent_id,proof_generation,refund_id,amount,status) VALUES(?,?, 'pi_shared',0,'re_shared',500,'succeeded')`, action, out); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-shared-fail", "re_shared", "", "pi_shared", "failed", 200); err != nil {
		t.Fatal(err)
	}
	var failed, prepared, released int
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_manual_actions WHERE state='failed'`).Scan(&failed)
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_manual_actions WHERE state='prepared' AND retry_generation=1`).Scan(&prepared)
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_holds WHERE subject_released_at=0`).Scan(&released)
	if failed != 2 || prepared != 2 || released != 2 {
		t.Fatalf("failed=%d prepared=%d reheld=%d", failed, prepared, released)
	}
}

func TestRefundConstituentInsertVerifiesExactMembership(t *testing.T) {
	store := newTestStore(t)
	tx, err := store.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := bindRefundConstituentTx(context.Background(), tx, "action", "out", "pi", 0, "re", 500, "succeeded"); err != nil {
		t.Fatal(err)
	}
	if err := bindRefundConstituentTx(context.Background(), tx, "action", "different", "pi", 0, "re", 400, "succeeded"); err == nil {
		t.Fatal("conflicting constituent membership accepted")
	}
}

func TestOrphanFailureBindingCommitsRotationBeforeReturning(t *testing.T) {
	store := newTestStore(t)
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"charge:ch_orphan": {Kind: "charge", ID: "ch_orphan", PaymentIntentID: "pi_orphan", Status: "succeeded_after_deletion", Manual: true}}}
	raw, _ := json.Marshal(p)
	_, _ = store.db.Exec(`INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES('subject-orphan',X'0A','stripe',1,2,3,99)`)
	_, _ = store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation) VALUES('out-orphan','subject-orphan','stripe','key-orphan','pending',?,1,1,1)`, string(raw))
	if err := store.RecordStripeDeletionRefundLifecycle(context.Background(), "evt-before-bind", "re_orphan_first", "", "pi_orphan", "failed", 100); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/payment_intents/pi_orphan":
			io.WriteString(w, `{"latest_charge":"ch_orphan"}`)
		case "/v1/charges/ch_orphan":
			io.WriteString(w, `{"id":"ch_orphan","payment_intent":"pi_orphan","amount":500,"amount_refunded":500,"refunded":true}`)
		case "/v1/refunds":
			io.WriteString(w, `{"data":[{"id":"re_orphan_first","status":"succeeded","payment_intent":"pi_orphan","amount":500}],"has_more":false}`)
		case "/v1/refunds/re_orphan_first":
			io.WriteString(w, `{"id":"re_orphan_first","status":"succeeded","payment_intent":"pi_orphan","amount":500,"metadata":{}}`)
		default:
			http.Error(w, "unexpected", 400)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	_, err := ResolveBillingDeletionRefund(context.Background(), store, c, "out-orphan", "charge:ch_orphan", "operator", "audit")
	if !errors.Is(err, ErrBillingDeletionRefundReconciliationRequired) {
		t.Fatalf("err=%v", err)
	}
	var failed, prepared, revision, released int
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_manual_actions WHERE outbox_id='out-orphan' AND state='failed'`).Scan(&failed)
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM billing_deletion_manual_actions WHERE outbox_id='out-orphan' AND state='prepared' AND retry_generation=1`).Scan(&prepared)
	_ = store.db.QueryRow(`SELECT revision FROM billing_cancellation_outbox WHERE id='out-orphan'`).Scan(&revision)
	_ = store.db.QueryRow(`SELECT subject_released_at FROM billing_deletion_holds WHERE billing_subject_id='subject-orphan'`).Scan(&released)
	if failed != 1 || prepared != 1 || revision == 0 || released != 0 {
		t.Fatalf("failed=%d prepared=%d revision=%d hold=%d", failed, prepared, revision, released)
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
			if refunded {
				io.WriteString(w, `{"data":[{"id":"re_checkout","status":"succeeded","payment_intent":"pi_paid","amount":500}],"has_more":false}`)
			} else {
				io.WriteString(w, `{"data":[],"has_more":false}`)
			}
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
			io.WriteString(w, `{"id":"re_checkout","status":"succeeded","payment_intent":"pi_paid","amount":500,"metadata":{"relayium_deletion_action_id":"`+actionID+`"}}`)
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
