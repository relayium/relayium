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
	}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation,next_attempt_at) VALUES('out_manual','subject','stripe','delete-key','pending',?,1,1,1,1)`, string(raw)); err != nil {
		t.Fatal(err)
	}
	var posts int
	var actionID string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/invoices/in_paid":
			io.WriteString(w, `{"id":"in_paid","payment_intent":"pi_paid"}`)
		case "GET /v1/refunds":
			io.WriteString(w, `{"data":[]}`)
		case "POST /v1/refunds":
			posts++
			body, _ := io.ReadAll(r.Body)
			form, _ := url.ParseQuery(string(body))
			actionID = form.Get("metadata[relayium_deletion_action_id]")
			if form.Get("payment_intent") != "pi_paid" || actionID == "" || r.Header.Get("Idempotency-Key") != "acct-delete-refund:"+actionID {
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
	if _, err := ResolveBillingDeletionRefund(context.Background(), store, c, "out_manual", "invoice:in_paid", actor, reason); err != nil {
		t.Fatal(err)
	}
	if posts != 1 {
		t.Fatalf("idempotent retry created %d refunds", posts)
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
