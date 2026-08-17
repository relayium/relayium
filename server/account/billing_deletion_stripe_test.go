package account

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
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
	p, err := c.DiscoverDeletionHazards(context.Background(), "cus_1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(p.Subscriptions, ",") != "sub_active,sub_unpaid" || strings.Join(p.Schedules, ",") != "sched_active" || len(p.CheckoutSessions) != 1 || len(p.InvoiceItems) != 1 || len(p.Invoices) != 2 {
		t.Fatalf("inventory=%+v", p)
	}
	if err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{IdempotencyKey: "delete-1"}, p); err != nil {
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
