package account

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestStripeDeletionEnumeratesAndNeutralizesEveryChargePath(t *testing.T) {
	var calls []string
	var forms = map[string]url.Values{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		body, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(body))
		forms[r.URL.Path] = form
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/checkout/sessions":
			io.WriteString(w, `{"data":[{"id":"cs_open","status":"open"}],"has_more":false}`)
		case "GET /v1/subscriptions":
			io.WriteString(w, `{"data":[{"id":"sub_active","status":"active"},{"id":"sub_unpaid","status":"unpaid"},{"id":"sub_old","status":"canceled"}],"has_more":false}`)
		case "GET /v1/subscription_schedules":
			io.WriteString(w, `{"data":[{"id":"sched_active","status":"active"},{"id":"sched_old","status":"released"}],"has_more":false}`)
		case "GET /v1/invoiceitems":
			io.WriteString(w, `{"data":[{"id":"ii_pending"}],"has_more":false}`)
		case "GET /v1/invoices":
			io.WriteString(w, `{"data":[{"id":"in_draft","status":"draft"},{"id":"in_open","status":"open"}],"has_more":false}`)
		case "GET /v1/invoices/in_draft":
			io.WriteString(w, `{"id":"in_draft","status":"draft"}`)
		case "GET /v1/invoices/in_open":
			io.WriteString(w, `{"id":"in_open","status":"open"}`)
		case "GET /v1/checkout/sessions/cs_open":
			io.WriteString(w, `{"id":"cs_open","status":"open","payment_status":"unpaid","customer":"cus_1"}`)
		case "GET /v1/subscriptions/sub_active":
			io.WriteString(w, `{"id":"sub_active","status":"active","customer":"cus_1","items":{"data":[{"price":{"recurring":{"usage_type":"licensed"}}}]}}`)
		case "GET /v1/subscriptions/sub_unpaid":
			io.WriteString(w, `{"id":"sub_unpaid","status":"unpaid","customer":"cus_1","items":{"data":[{"price":{"recurring":{"usage_type":"licensed"}}}]}}`)
		case "GET /v1/subscription_schedules/sched_active":
			io.WriteString(w, `{"id":"sched_active","status":"active","customer":"cus_1"}`)
		case "GET /v1/invoiceitems/ii_pending":
			io.WriteString(w, `{"id":"ii_pending","customer":"cus_1"}`)
		case "DELETE /v1/subscriptions/sub_unpaid":
			http.Error(w, `{"error":{"message":"No such subscription"}}`, http.StatusNotFound)
		default:
			io.WriteString(w, `{}`)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base = ts.URL
	c.http = ts.Client()
	p, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "user_1", CustomerID: "cus_1"}, BillingDeletionProgress{})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Resources) != 7 {
		t.Fatalf("inventory=%+v", p)
	}
	// Mutation is only a request; the journal remains pending until a later
	// canonical GET proves each object terminal.
	_, _ = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{IdempotencyKey: "delete-1"}, p)
	for _, path := range []string{"/v1/subscriptions/sub_active", "/v1/subscriptions/sub_unpaid", "/v1/subscription_schedules/sched_active/cancel"} {
		if forms[path].Get("invoice_now") != "false" || forms[path].Get("prorate") != "false" {
			t.Fatalf("unsafe final billing form for %s: %v", path, forms[path])
		}
	}
	for _, want := range []string{"POST /v1/checkout/sessions/cs_open/expire", "DELETE /v1/invoiceitems/ii_pending", "DELETE /v1/invoices/in_draft", "POST /v1/invoices/in_open/void"} {
		if !containsString(calls, want) {
			t.Fatalf("missing %s in %v", want, calls)
		}
	}
}

func TestExternalSubscriptionDerivesCustomerBeforeInventoryOrMutation(t *testing.T) {
	var mutations int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			mutations++
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/subscriptions/sub_external" {
			io.WriteString(w, `{"id":"sub_external","status":"active","customer":"cus_derived","items":{"data":[{"price":{"recurring":{"usage_type":"licensed"}}}]}}`)
			return
		}
		io.WriteString(w, `{"object":"list","data":[],"has_more":false}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{
		"subscription:sub_external": {Kind: "subscription", ID: "sub_external", Status: "external_binding"},
	}}
	row := BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete", CreatedAt: 100}
	if _, err := c.DiscoverDeletionHazards(context.Background(), row, p); err != nil {
		t.Fatalf("attributed customerless discovery rejected: %v", err)
	}
	got, err := c.ReconcileDeletionHazards(context.Background(), row, p)
	if err == nil || mutations != 0 || len(got.Customers) != 1 || got.Customers[0] != "cus_derived" {
		t.Fatalf("derive phase progress=%+v mutations=%d err=%v", got, mutations, err)
	}
	if got.Resources["subscription:sub_external"].CustomerID != "cus_derived" {
		t.Fatalf("derived customer was not journaled: %+v", got.Resources)
	}
}

func TestStripeDeletionMeteredSubscriptionFailsClosedBeforeCancellation(t *testing.T) {
	var mutation bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			mutation = true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"sub_metered","status":"active","customer":"cus_1","items":{"data":[{"price":{"recurring":{"usage_type":"metered"}}}]}}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"subscription:sub_metered": {Kind: "subscription", ID: "sub_metered", CustomerID: "cus_1"}}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	if err == nil || got.Resources["subscription:sub_metered"].Status != "metered_usage_requires_operator" {
		t.Fatalf("metered subscription accepted: err=%v progress=%+v", err, got)
	}
	if mutation {
		t.Fatal("metered subscription was canceled before usage reconciliation")
	}
}

func TestAttemptOnlyTerminalProgressHasDurableIdentity(t *testing.T) {
	now := int64(100000)
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"checkout_session:cs_attempt": {Kind: "checkout_session", ID: "cs_attempt", AttemptID: "attempt", Terminal: true}}, CleanSince: now}
	if !p.terminal(now + 86400) {
		t.Fatal("durably attributed attempt-only deletion never converged")
	}
	p.Resources["checkout_session:cs_attempt"] = BillingDeletionResource{Kind: "checkout_session", ID: "cs_attempt", Terminal: true}
	if p.terminal(now + 86400) {
		t.Fatal("unattributed session was accepted as terminal identity")
	}
}

func TestStripeAuthorityWithoutProviderObjectsHasTerminalNoSideEffectProof(t *testing.T) {
	now := int64(100000)
	row := BillingCancellation{BillingSubjectID: "subject-empty", CreatedAt: now}
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{
		"no_side_effect_proof:subject-empty": {Kind: "no_side_effect_proof", ID: "subject-empty", Status: "verified_local_history_empty", Terminal: true},
	}, CleanSince: now}
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	got, err := c.DiscoverDeletionHazards(context.Background(), row, p)
	if err != nil || !got.hasIdentity() || !got.terminal(now+86400) {
		t.Fatalf("no-side-effect proof=%+v err=%v", got, err)
	}
}

func containsString(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func TestStripeDeletionNeverLosesAsynchronousPayment(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		kind       string
	}{{"checkout paid", `{"id":"cs_late","status":"complete","payment_status":"paid","customer":"cus_1","payment_intent":"pi_late"}`, "checkout_session"}, {"checkout processing", `{"id":"cs_late","status":"complete","payment_status":"unpaid","customer":"cus_1","payment_intent":"pi_late"}`, "checkout_session"}, {"invoice paid race", `{"id":"in_late","status":"paid","customer":"cus_1","payment_intent":"pi_late"}`, "invoice"}} {
		t.Run(tc.name, func(t *testing.T) {
			var mutation bool
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					mutation = true
				}
				w.Header().Set("Content-Type", "application/json")
				if tc.kind == "invoice" {
					serveDahliaInvoicePayment(t, w, r, "in_late", "cus_1", `"parent":{"type":"subscription_details","subscription_details":{"subscription":"sub_late"}},`, "pi_late", "ch_late", 500, 110)
					return
				}
				io.WriteString(w, tc.body)
			}))
			defer ts.Close()
			c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
			c.base = ts.URL
			c.http = ts.Client()
			id := "cs_late"
			if tc.kind == "invoice" {
				id = "in_late"
			}
			p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{tc.kind + ":" + id: {Kind: tc.kind, ID: id, CustomerID: "cus_1"}}}
			got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{IdempotencyKey: "del"}, p)
			if err == nil {
				t.Fatal("async charge incorrectly reached terminal")
			}
			r := got.Resources[tc.kind+":"+id]
			if tc.name == "invoice paid race" && !r.Manual {
				t.Fatalf("paid race not sent to manual reconciliation: %+v", r)
			}
			if r.Terminal && tc.name != "checkout paid" {
				t.Fatalf("async charge disappeared: %+v", r)
			}
			if tc.name == "checkout paid" {
				if _, linked := got.Resources["payment_intent:pi_late"]; !linked || r.Status != "delegated_to_payment_objects" {
					t.Fatalf("paid Checkout did not delegate canonical payment proof: resource=%+v all=%+v", r, got.Resources)
				}
			}
			if mutation {
				t.Fatal("completed async payment was blindly expired/voided")
			}
		})
	}
}

func TestStripeDeletionUsesEveryDurableHistoricalCustomer(t *testing.T) {
	seen := map[string]bool{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/customers/search" {
			t.Fatal("customer search metadata is not an ownership authority")
		}
		customer := r.URL.Query().Get("customer")
		if customer != "" {
			seen[customer] = true
		}
		io.WriteString(w, `{"data":[],"has_more":false}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base = ts.URL
	c.http = ts.Client()
	p, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject"}, BillingDeletionProgress{Customers: []string{"cus_old", "cus_new"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Customers) != 2 || !seen["cus_old"] || !seen["cus_new"] {
		t.Fatalf("customers=%v seen=%v", p.Customers, seen)
	}
}

func TestStripeDeletionDiscoveryNeverShrinksTheResourceJournal(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/customers/search" {
			io.WriteString(w, `{"data":[],"has_more":false}`)
			return
		}
		io.WriteString(w, `{"data":[],"has_more":false}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base = ts.URL
	c.http = ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"checkout_session:cs_seen": {Kind: "checkout_session", ID: "cs_seen", CustomerID: "cus_1", Status: "observed"}}}
	got, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CustomerID: "cus_1"}, p)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got.Resources["checkout_session:cs_seen"]; !ok {
		t.Fatal("empty provider listing erased an observed async checkout")
	}
}

func TestStripeDeletionExpiresAttributedCheckoutBeforeCustomerExists(t *testing.T) {
	var expired int
	var reads int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/customers/search":
			io.WriteString(w, `{"data":[],"has_more":false}`)
		case "GET /v1/checkout/sessions/cs_empty":
			reads++
			status := "open"
			if expired > 0 {
				status = "expired"
			}
			fmt.Fprintf(w, `{"id":"cs_empty","status":%q,"payment_status":"unpaid","client_reference_id":"subject","metadata":{"billing_attempt_id":"attempt_1","user_id":"subject"}}`, status)
		case "POST /v1/checkout/sessions/cs_empty/expire":
			expired++
			io.WriteString(w, `{}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"checkout_session:cs_empty": {Kind: "checkout_session", ID: "cs_empty", AttemptID: "attempt_1", Status: "observed"}}}
	p, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject"}, p)
	if err != nil {
		t.Fatal(err)
	}
	p, err = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	if err == nil {
		t.Fatal("an expire request without canonical readback was treated as terminal")
	}
	p, err = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	if err != nil {
		t.Fatal(err)
	}
	if expired != 1 || reads != 2 || !p.Resources["checkout_session:cs_empty"].Terminal {
		t.Fatalf("expire calls=%d reads=%d resource=%+v", expired, reads, p.Resources["checkout_session:cs_empty"])
	}
}

func TestStripeSubscriptionObservationWithoutDeletionIsANoOp(t *testing.T) {
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(context.Background(), "ordinary-webhook@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AppendStripeDeletionHazard(context.Background(), u.ID, BillingDeletionResource{
		Kind: "subscription", ID: "sub_ordinary", CustomerID: "cus_ordinary", Status: "active",
	}); err != nil {
		t.Fatalf("ordinary subscription observation: %v", err)
	}
	var outboxes int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_cancellation_outbox WHERE billing_subject_id=?`, u.ID).Scan(&outboxes); err != nil {
		t.Fatal(err)
	}
	if outboxes != 0 {
		t.Fatalf("ordinary subscription observation created %d deletion outboxes", outboxes)
	}
}

func TestStripeDeletionCompleteCheckoutBindsCustomerAndLinkedHazards(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"cs_race","status":"complete","payment_status":"unpaid","customer":"cus_new","subscription":"sub_new","payment_intent":"pi_new","client_reference_id":"subject","metadata":{"billing_attempt_id":"attempt_1","user_id":"subject"}}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"checkout_session:cs_race": {Kind: "checkout_session", ID: "cs_race", AttemptID: "attempt_1", Status: "observed"}}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	if err == nil {
		t.Fatal("complete unpaid race incorrectly reached terminal")
	}
	if len(got.Customers) != 1 || got.Customers[0] != "cus_new" {
		t.Fatalf("customers=%v", got.Customers)
	}
	if got.Resources["subscription:sub_new"].CustomerID != "cus_new" || got.Resources["payment_intent:pi_new"].CustomerID != "cus_new" {
		t.Fatalf("linked hazards not durably attributed: %+v", got.Resources)
	}
}

func TestStripeDeletionRejectsForgedCheckoutAttribution(t *testing.T) {
	var mutation bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			mutation = true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"cs_forged","status":"open","client_reference_id":"other","metadata":{"billing_attempt_id":"attempt_1","user_id":"other"}}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"checkout_session:cs_forged": {Kind: "checkout_session", ID: "cs_forged", AttemptID: "attempt_1"}}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	if err == nil || !got.Resources["checkout_session:cs_forged"].Manual {
		t.Fatalf("forged checkout accepted: err=%v progress=%+v", err, got)
	}
	if mutation {
		t.Fatal("forged checkout triggered provider mutation")
	}
}

func TestStripeDeletionUsesInvoicePaidAtNotObjectCreated(t *testing.T) {
	for _, tc := range []struct {
		name       string
		paidAt     int64
		wantManual bool
		wantStatus string
	}{{"paid before deletion", 95, false, "paid_before_deletion"}, {"paid in deletion second", 100, true, "paid_at_deletion_time_unknown"}, {"created before but paid after deletion", 110, true, "paid_after_deletion"}} {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				serveDahliaInvoicePayment(t, w, r, "in_paid", "cus_1", `"parent":{"type":"subscription_details","subscription_details":{"subscription":"sub_paid"}},`, "pi_paid", "ch_paid", 500, tc.paidAt)
			}))
			defer ts.Close()
			c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
			c.base, c.http = ts.URL, ts.Client()
			p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"invoice:in_paid": {Kind: "invoice", ID: "in_paid", CustomerID: "cus_1"}}}
			got, err := p, error(nil)
			for i := 0; i < 3; i++ {
				got, err = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CreatedAt: 100, IdempotencyKey: "delete"}, got)
			}
			if tc.wantManual && err == nil {
				t.Fatal("post-deletion payment was accepted")
			}
			if !tc.wantManual && err != nil {
				t.Fatal(err)
			}
			r := got.Resources["invoice:in_paid"]
			if r.Manual != tc.wantManual || r.Status != tc.wantStatus || (!tc.wantManual && !r.Terminal) {
				t.Fatalf("payment timing misclassified: %+v", r)
			}
		})
	}
}

func TestStripeDeletionPaymentIntentUsesLatestChargeSuccessTime(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/payment_intents/pi_old" {
			io.WriteString(w, `{"id":"pi_old","status":"succeeded","created":90,"customer":"cus_1","latest_charge":"ch_late"}`)
			return
		}
		io.WriteString(w, `{"id":"ch_late","paid":true,"created":110,"customer":"cus_1","payment_intent":"pi_old"}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"payment_intent:pi_old": {Kind: "payment_intent", ID: "pi_old", CustomerID: "cus_1"}}}
	row := BillingCancellation{BillingSubjectID: "subject", CreatedAt: 200, CutoffAt: 100, Mode: billingCancellationExactCompensation, IdempotencyKey: "delete"}
	got, err := c.ReconcileDeletionHazards(context.Background(), row, p)
	if err == nil {
		t.Fatal("charge succeeding after deletion was accepted")
	}
	got.add(BillingDeletionResource{Kind: "charge", ID: "ch_late", CustomerID: "cus_1", Status: "webhook", SuccessAt: 110})
	got, err = c.ReconcileDeletionHazards(context.Background(), row, got)
	if err == nil {
		t.Fatal("late charge reconciliation reached terminal")
	}
	if r := got.Resources["charge:ch_late"]; !r.Manual || r.Status != "succeeded_after_deletion" {
		t.Fatalf("late charge=%+v all=%+v", r, got.Resources)
	}
}

func TestCanonicalSuccessWithoutVerifiedSuccessTimeCannotBeClassifiedBeforeDeletion(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/payment_intents/pi_missing_time":
			io.WriteString(w, `{"id":"pi_missing_time","status":"succeeded","created":90,"customer":"cus_1","latest_charge":"ch_missing_time"}`)
		case "/v1/charges/ch_missing_time":
			io.WriteString(w, `{"id":"ch_missing_time","paid":true,"created":90,"customer":"cus_1","payment_intent":"pi_missing_time"}`)
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{
		"payment_intent:pi_missing_time": {Kind: "payment_intent", ID: "pi_missing_time", CustomerID: "cus_1", Status: "checkout.session.async_payment_failed"},
	}}
	row := BillingCancellation{BillingSubjectID: "subject", CutoffAt: 100, CreatedAt: 100, IdempotencyKey: "delete"}
	var err error
	for i := 0; i < 2; i++ {
		p, err = c.ReconcileDeletionHazards(context.Background(), row, p)
		if p.Resources["charge:ch_missing_time"].Manual {
			break
		}
	}
	if err == nil {
		t.Fatal("canonical success without verified success time reached terminal")
	}
	if r := p.Resources["charge:ch_missing_time"]; !r.Manual || r.Status != "succeeded_time_unknown" || r.SuccessAt != 0 {
		t.Fatalf("missing success evidence charge=%+v", r)
	}
}

func TestStripeDeletionChargeCreatedBeforeSucceededAfterUsesWebhookSuccessAt(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ch_async","paid":true,"created":90,"customer":"cus_1"}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"charge:ch_async": {Kind: "charge", ID: "ch_async", CustomerID: "cus_1", SuccessAt: 110, Status: "webhook"}}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CreatedAt: 100, IdempotencyKey: "delete"}, p)
	if err == nil {
		t.Fatal("asynchronously succeeded charge reached terminal")
	}
	if r := got.Resources["charge:ch_async"]; !r.Manual || r.Status != "succeeded_after_deletion" || r.ProviderCreatedAt != 90 || r.SuccessAt != 110 {
		t.Fatalf("charge=%+v", r)
	}
}

func TestStripeDeletionChargeSucceededInDeletionSecondRequiresRefundReview(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"ch_same_second","paid":true,"created":90,"customer":"cus_1"}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"charge:ch_same_second": {Kind: "charge", ID: "ch_same_second", CustomerID: "cus_1", SuccessAt: 100, Status: "webhook"}}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CreatedAt: 100, CutoffAt: 100, IdempotencyKey: "delete"}, p)
	if err == nil {
		t.Fatal("same-second charge was classified before deletion")
	}
	if r := got.Resources["charge:ch_same_second"]; !r.Manual || r.Status != "succeeded_at_deletion_time_unknown" {
		t.Fatalf("same-second charge=%+v", r)
	}
}

func TestStripeDeletionInvoicePaidAtPropagatesThroughPaymentChain(t *testing.T) {
	for _, tc := range []struct {
		name       string
		paidAt     int64
		wantManual bool
	}{{"paid before deletion", 95, false}, {"paid after deletion", 110, true}} {
		t.Run(tc.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				serveDahliaInvoicePayment(t, w, r, "in_chain", "cus_1", `"parent":{"type":"subscription_details","subscription_details":{"subscription":"sub_chain"}},`, "pi_chain", "ch_chain", 500, tc.paidAt)
			}))
			defer ts.Close()
			c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
			c.base, c.http = ts.URL, ts.Client()
			p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"invoice:in_chain": {Kind: "invoice", ID: "in_chain", CustomerID: "cus_1"}}}
			var err error
			for i := 0; i < 3; i++ {
				p, err = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CreatedAt: 100, IdempotencyKey: "delete"}, p)
			}
			charge := p.Resources["charge:ch_chain"]
			if charge.SuccessAt != tc.paidAt || charge.Manual != tc.wantManual || (!tc.wantManual && !charge.Terminal) {
				t.Fatalf("charge=%+v all=%+v err=%v", charge, p.Resources, err)
			}
			if tc.wantManual && err == nil {
				t.Fatal("post-deletion invoice chain reached terminal")
			}
		})
	}
}

func TestStripeDeletionRecoveryLineageNeverExpiresBlindly(t *testing.T) {
	var mutation bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			mutation = true
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"cs_recovery","status":"open","customer":"cus_1","after_expiration":{"recovery":{"enabled":true}}}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"checkout_session:cs_recovery": {Kind: "checkout_session", ID: "cs_recovery", CustomerID: "cus_1"}}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	if err == nil || got.Resources["checkout_session:cs_recovery"].Status != "recovery_lineage_pending" {
		t.Fatalf("recovery lineage accepted: err=%v progress=%+v", err, got)
	}
	if mutation {
		t.Fatal("recovery-enabled session was blindly expired")
	}
}

func TestStripeDeletionRecoveryWindowAndChildLineageAreDurable(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/checkout/sessions/cs_parent":
			io.WriteString(w, `{"id":"cs_parent","status":"expired","customer":"cus_1","expires_at":100,"after_expiration":{"recovery":{"enabled":true,"expires_at":2592100}}}`)
		case "/v1/checkout/sessions/cs_child":
			io.WriteString(w, `{"id":"cs_child","status":"expired","customer":"cus_1","recovered_from":"cs_parent"}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	c.now = func() time.Time { return time.Unix(100+30*86400, 0) }
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{
		"checkout_session:cs_parent": {Kind: "checkout_session", ID: "cs_parent", CustomerID: "cus_1"},
		"checkout_session:cs_child":  {Kind: "checkout_session", ID: "cs_child", CustomerID: "cus_1"},
	}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	if err != nil {
		t.Fatal(err)
	}
	parent, child := got.Resources["checkout_session:cs_parent"], got.Resources["checkout_session:cs_child"]
	if !parent.Terminal || parent.Status != "recovery_descendants_terminal" || parent.RecoveryExpiresAt != 100+30*86400 {
		t.Fatalf("parent=%+v", parent)
	}
	if !child.Terminal || child.RecoveredFrom != "cs_parent" {
		t.Fatalf("child=%+v", child)
	}
}

func TestStripeDeletionDiscoversCompleteCheckoutAndAllPostCutoffInvoices(t *testing.T) {
	seen := map[string]url.Values{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		seen[r.URL.Path+"?"+r.URL.Query().Get("status")] = r.URL.Query()
		if r.URL.Path == "/v1/checkout/sessions" && r.URL.Query().Get("status") == "complete" {
			io.WriteString(w, `{"data":[{"id":"cs_complete","status":"complete"}],"has_more":false}`)
			return
		}
		if r.URL.Path == "/v1/invoices" {
			io.WriteString(w, `{"data":[{"id":"in_paid","status":"paid"}],"has_more":false}`)
			return
		}
		io.WriteString(w, `{"data":[],"has_more":false}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CustomerID: "cus_1", CreatedAt: 123}, BillingDeletionProgress{})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := p.Resources["checkout_session:cs_complete"]; !ok {
		t.Fatal("complete Checkout was not discovered")
	}
	if _, ok := p.Resources["invoice:in_paid"]; !ok {
		t.Fatal("paid invoice was not discovered")
	}
	if got := seen["/v1/invoices?"].Get("created[gte]"); got != "123" {
		t.Fatalf("invoice cutoff=%q", got)
	}
}
