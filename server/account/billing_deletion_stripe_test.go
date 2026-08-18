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

func TestStripeDeletionSearchesEveryHistoricalCustomer(t *testing.T) {
	seen := map[string]bool{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/customers/search" {
			io.WriteString(w, `{"data":[{"id":"cus_old"},{"id":"cus_new"}],"has_more":false}`)
			return
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
	p, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", CustomerID: ""}, BillingDeletionProgress{})
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
