package account

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
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
			if r.URL.Query().Get("status") == "draft" {
				io.WriteString(w, `{"data":[{"id":"in_draft"}],"has_more":false}`)
			} else {
				io.WriteString(w, `{"data":[{"id":"in_open"}],"has_more":false}`)
			}
		case "GET /v1/invoices/in_draft":
			io.WriteString(w, `{"id":"in_draft","status":"draft"}`)
		case "GET /v1/invoices/in_open":
			io.WriteString(w, `{"id":"in_open","status":"open"}`)
		case "GET /v1/checkout/sessions/cs_open":
			io.WriteString(w, `{"id":"cs_open","status":"open","payment_status":"unpaid","customer":"cus_1"}`)
		case "GET /v1/subscriptions/sub_active":
			io.WriteString(w, `{"id":"sub_active","status":"active","customer":"cus_1","items":{"data":[{"price":{"recurring":{"usage_type":"licensed"}}}]}}`)
		case "GET /v1/subscriptions/sub_unpaid":
			io.WriteString(w, `{"id":"sub_unpaid","status":"unpaid","customer":"cus_1","items":{"data":[{"price":{"recurring":{"usage_type":"metered"}}}]}}`)
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
	if _, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{IdempotencyKey: "delete-1"}, p); err != nil {
		t.Fatal(err)
	}
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
			if tc.name != "checkout processing" && !r.Manual {
				t.Fatalf("paid race not sent to manual reconciliation: %+v", r)
			}
			if r.Terminal {
				t.Fatalf("async charge disappeared: %+v", r)
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
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/customers/search":
			io.WriteString(w, `{"data":[],"has_more":false}`)
		case "GET /v1/checkout/sessions/cs_empty":
			io.WriteString(w, `{"id":"cs_empty","status":"open","payment_status":"unpaid","client_reference_id":"subject","metadata":{"billing_attempt_id":"attempt_1","user_id":"subject"}}`)
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
	if _, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p); err != nil {
		t.Fatal(err)
	}
	if expired != 1 {
		t.Fatalf("expire calls=%d", expired)
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

func TestStripeDeletionHistoricalPaidIsNotLabeledAfterDeletion(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/subscriptions/sub_old":
			io.WriteString(w, `{"id":"sub_old","status":"canceled","customer":"cus_1"}`)
		case "/v1/invoices/in_old":
			io.WriteString(w, `{"id":"in_old","status":"void","customer":"cus_1"}`)
		default:
			io.WriteString(w, `{"id":"cs_old","status":"complete","payment_status":"paid","created":90,"customer":"cus_1","subscription":"sub_old","invoice":"in_old"}`)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"checkout_session:cs_old": {Kind: "checkout_session", ID: "cs_old", CustomerID: "cus_1"}}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CreatedAt: 100, IdempotencyKey: "delete"}, p)
	if err != nil {
		t.Fatal(err)
	}
	r := got.Resources["checkout_session:cs_old"]
	if !r.Terminal || r.Manual || r.Status != "paid_before_deletion" || r.ProviderCreatedAt != 90 {
		t.Fatalf("historical payment misclassified: %+v", r)
	}
	if _, ok := got.Resources["subscription:sub_old"]; !ok {
		t.Fatal("historical paid checkout lost linked subscription")
	}
	if _, ok := got.Resources["invoice:in_old"]; !ok {
		t.Fatal("historical paid checkout lost linked invoice")
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
