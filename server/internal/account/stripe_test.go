package account

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func signStripe(secret, payload string, ts int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.%s", ts, payload)))
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}

func TestVerifyWebhookAcceptsValidRejectsTampered(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	sig := signStripe("whsec_abc", body, 1000)
	if _, err := c.VerifyWebhook([]byte(body), sig, 1000); err != nil {
		t.Fatalf("valid sig rejected: %v", err)
	}
	// tampered body
	if _, err := c.VerifyWebhook([]byte(body+" "), sig, 1000); err == nil {
		t.Fatal("tampered payload accepted")
	}
	// expired (>300s)
	if _, err := c.VerifyWebhook([]byte(body), sig, 1000+301); err == nil {
		t.Fatal("stale timestamp accepted")
	}
	// wrong secret
	bad := NewStripeClient("sk_test", "whsec_other", "")
	if _, err := bad.VerifyWebhook([]byte(body), sig, 1000); err == nil {
		t.Fatal("wrong-secret sig accepted")
	}
}

func TestVerifyWebhookMultipleV1OneValid(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"customer.subscription.deleted","data":{"object":{"customer":"cus_9","status":"canceled"}}}`
	good := signStripe("whsec_abc", body, 2000) // "t=2000,v1=<good>"
	multi := good + ",v1=deadbeef"
	if _, err := c.VerifyWebhook([]byte(body), multi, 2000); err != nil {
		t.Fatalf("one valid v1 among many should pass: %v", err)
	}
}

func TestVerifyWebhookParsesEventProjection(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1","subscription":"sub_1","client_reference_id":"user_42"}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 3000), 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "checkout.session.completed" || ev.CustomerID != "cus_1" || ev.ClientRefUserID != "user_42" {
		t.Fatalf("bad projection: %+v", ev)
	}
}

func TestVerifyWebhookMissingHeaderRejected(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	if _, err := c.VerifyWebhook([]byte(body), "", 1000); err == nil {
		t.Fatal("missing header accepted")
	}
	if _, err := c.VerifyWebhook([]byte(body), "t=1000", 1000); err == nil {
		t.Fatal("missing v1 accepted")
	}
	if _, err := c.VerifyWebhook([]byte(body), "v1=deadbeef", 1000); err == nil {
		t.Fatal("missing t accepted")
	}
	if _, err := c.VerifyWebhook([]byte(body), "t=notanumber,v1=deadbeef", 1000); err == nil {
		t.Fatal("non-numeric t accepted")
	}
}

func TestVerifyWebhookSubscriptionProjection(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"customer.subscription.updated","data":{"object":{"customer":"cus_5","status":"active","current_period_end":1700000000,"items":{"data":[{"price":{"id":"price_pro_monthly"}}]}}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 4000), 4000)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "customer.subscription.updated" || ev.CustomerID != "cus_5" || ev.Status != "active" ||
		ev.PriceID != "price_pro_monthly" || ev.CurrentPeriodEnd != 1700000000 {
		t.Fatalf("bad subscription projection: %+v", ev)
	}
	// client_reference_id absent on subscription events must not panic and stays zero value.
	if ev.ClientRefUserID != "" {
		t.Fatalf("unexpected ClientRefUserID: %q", ev.ClientRefUserID)
	}
}

func TestVerifyWebhookParsesMetadataUserID(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"customer.subscription.updated","data":{"object":{"customer":"cus_5","status":"active","metadata":{"user_id":"user_77"},"items":{"data":[{"price":{"id":"price_pro_monthly"}}]}}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 4500), 4500)
	if err != nil {
		t.Fatal(err)
	}
	if ev.MetadataUserID != "user_77" {
		t.Fatalf("want MetadataUserID user_77, got %q", ev.MetadataUserID)
	}
}

func TestVerifyWebhookMetadataAbsentNoPanic(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 4600), 4600)
	if err != nil {
		t.Fatal(err)
	}
	if ev.MetadataUserID != "" {
		t.Fatalf("want empty MetadataUserID when metadata absent, got %q", ev.MetadataUserID)
	}
}

func TestVerifyWebhookCurrentPeriodEndFallsBackToItems(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	// Modern Stripe API versions (2025+) moved current_period_end off the
	// subscription object onto each subscription item; top-level field absent.
	body := `{"type":"customer.subscription.updated","data":{"object":{"customer":"cus_5","status":"active","items":{"data":[{"price":{"id":"price_pro_monthly"},"current_period_end":1800000000}]}}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 4700), 4700)
	if err != nil {
		t.Fatal(err)
	}
	if ev.CurrentPeriodEnd != 1800000000 {
		t.Fatalf("want CurrentPeriodEnd fallback to items.data[0].current_period_end, got %d", ev.CurrentPeriodEnd)
	}
}

func TestVerifyWebhookCurrentPeriodEndPrefersTopLevel(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	// When both are present (older API versions, or Stripe sending both),
	// the top-level field wins over the items fallback.
	body := `{"type":"customer.subscription.updated","data":{"object":{"customer":"cus_5","status":"active","current_period_end":1700000000,"items":{"data":[{"price":{"id":"price_pro_monthly"},"current_period_end":1800000000}]}}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 4800), 4800)
	if err != nil {
		t.Fatal(err)
	}
	if ev.CurrentPeriodEnd != 1700000000 {
		t.Fatalf("want top-level CurrentPeriodEnd preferred, got %d", ev.CurrentPeriodEnd)
	}
}

func TestVerifyWebhookNoItemsNoPanic(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	// checkout.session has no items at all -- must not panic, PriceID stays "".
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 5000), 5000)
	if err != nil {
		t.Fatal(err)
	}
	if ev.PriceID != "" {
		t.Fatalf("expected empty PriceID, got %q", ev.PriceID)
	}
}

func TestCreateCheckoutSessionRequestShape(t *testing.T) {
	const cannedURL = "https://checkout.stripe.test/abc"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.URL.Path != "/v1/checkout/sessions" {
			t.Errorf("path = %q, want /v1/checkout/sessions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk_test" {
			t.Errorf("Authorization = %q, want %q", got, "Bearer sk_test")
		}
		if got := r.Header.Get("Content-Type"); got != "application/x-www-form-urlencoded" {
			t.Errorf("Content-Type = %q, want application/x-www-form-urlencoded", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		if got := r.Form.Get("mode"); got != "subscription" {
			t.Errorf("mode = %q, want subscription", got)
		}
		if got := r.Form.Get("line_items[0][price]"); got != "price_pro_monthly" {
			t.Errorf("line_items[0][price] = %q, want price_pro_monthly", got)
		}
		if got := r.Form.Get("line_items[0][quantity]"); got != "1" {
			t.Errorf("line_items[0][quantity] = %q, want 1", got)
		}
		if got := r.Form.Get("success_url"); got != "https://relayium.test/success" {
			t.Errorf("success_url = %q, want https://relayium.test/success", got)
		}
		if got := r.Form.Get("cancel_url"); got != "https://relayium.test/cancel" {
			t.Errorf("cancel_url = %q, want https://relayium.test/cancel", got)
		}
		if got := r.Form.Get("client_reference_id"); got != "user_42" {
			t.Errorf("client_reference_id = %q, want user_42", got)
		}
		if got := r.Form.Get("subscription_data[metadata][user_id]"); got != "user_42" {
			t.Errorf("subscription_data[metadata][user_id] = %q, want user_42", got)
		}
		// CustomerID left empty in this test, so the client must fall back to
		// the customer_email branch rather than sending an empty "customer".
		if got := r.Form.Get("customer_email"); got != "user@example.com" {
			t.Errorf("customer_email = %q, want user@example.com", got)
		}
		// customer_creation must NOT be sent: it's only valid in payment mode,
		// and subscription-mode Checkout creates the Customer itself. Sending it
		// makes Stripe 400 the first-time subscriber's checkout.
		if got := r.Form.Get("customer_creation"); got != "" {
			t.Errorf("customer_creation = %q, want empty (invalid in subscription mode)", got)
		}
		if got := r.Form.Get("customer"); got != "" {
			t.Errorf("customer = %q, want empty (CustomerID unset)", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"url":%q}`, cannedURL)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	got, err := c.CreateCheckoutSession(context.Background(), CheckoutInput{
		PriceID:         "price_pro_monthly",
		CustomerEmail:   "user@example.com",
		ClientRefUserID: "user_42",
		SuccessURL:      "https://relayium.test/success",
		CancelURL:       "https://relayium.test/cancel",
	})
	if err != nil {
		t.Fatalf("CreateCheckoutSession: %v", err)
	}
	if got != cannedURL {
		t.Fatalf("url = %q, want %q", got, cannedURL)
	}
}

func TestCreateCheckoutSessionWithCustomerID(t *testing.T) {
	const cannedURL = "https://checkout.stripe.test/xyz"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		// CustomerID set, so the client must send "customer" and must NOT
		// fall back to the customer_email branch.
		if got := r.Form.Get("customer"); got != "cus_existing" {
			t.Errorf("customer = %q, want cus_existing", got)
		}
		if got := r.Form.Get("customer_email"); got != "" {
			t.Errorf("customer_email = %q, want empty (CustomerID set)", got)
		}
		if got := r.Form.Get("customer_creation"); got != "" {
			t.Errorf("customer_creation = %q, want empty (CustomerID set)", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"url":%q}`, cannedURL)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	got, err := c.CreateCheckoutSession(context.Background(), CheckoutInput{
		PriceID:         "price_pro_monthly",
		CustomerID:      "cus_existing",
		ClientRefUserID: "user_42",
		SuccessURL:      "https://relayium.test/success",
		CancelURL:       "https://relayium.test/cancel",
	})
	if err != nil {
		t.Fatalf("CreateCheckoutSession: %v", err)
	}
	if got != cannedURL {
		t.Fatalf("url = %q, want %q", got, cannedURL)
	}
}

func TestCreatePortalSessionRequestShape(t *testing.T) {
	const cannedURL = "https://portal.stripe.test/xyz"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.URL.Path != "/v1/billing_portal/sessions" {
			t.Errorf("path = %q, want /v1/billing_portal/sessions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk_test" {
			t.Errorf("Authorization = %q, want %q", got, "Bearer sk_test")
		}
		if got := r.Header.Get("Content-Type"); got != "application/x-www-form-urlencoded" {
			t.Errorf("Content-Type = %q, want application/x-www-form-urlencoded", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		if got := r.Form.Get("customer"); got != "cus_1" {
			t.Errorf("customer = %q, want cus_1", got)
		}
		if got := r.Form.Get("return_url"); got != "https://relayium.test/account" {
			t.Errorf("return_url = %q, want https://relayium.test/account", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"url":%q}`, cannedURL)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	got, err := c.CreatePortalSession(context.Background(), "cus_1", "https://relayium.test/account")
	if err != nil {
		t.Fatalf("CreatePortalSession: %v", err)
	}
	if got != cannedURL {
		t.Fatalf("url = %q, want %q", got, cannedURL)
	}
}

func TestCreatePortalSessionWithConfig(t *testing.T) {
	const cannedURL = "https://portal.stripe.test/cfg"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		if got := r.Form.Get("configuration"); got != "bpc_123" {
			t.Errorf("configuration = %q, want bpc_123", got)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"url":%q}`, cannedURL)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "bpc_123")
	c.base = srv.URL

	got, err := c.CreatePortalSession(context.Background(), "cus_1", "https://relayium.test/account")
	if err != nil {
		t.Fatalf("CreatePortalSession: %v", err)
	}
	if got != cannedURL {
		t.Fatalf("url = %q, want %q", got, cannedURL)
	}
}

func TestCreateCheckoutSessionNon2xxError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"bad"}}`)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	got, err := c.CreateCheckoutSession(context.Background(), CheckoutInput{
		PriceID:         "price_pro_monthly",
		CustomerEmail:   "user@example.com",
		ClientRefUserID: "user_42",
		SuccessURL:      "https://relayium.test/success",
		CancelURL:       "https://relayium.test/cancel",
	})
	if err == nil {
		t.Fatal("expected error on non-2xx response, got nil")
	}
	if got != "" {
		t.Fatalf("url = %q, want empty on error (no silent success)", got)
	}
}

func TestChangeSubscriptionPlanRequestShape(t *testing.T) {
	var sawList, sawUpdate bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			sawList = true
			if got := r.URL.Query().Get("customer"); got != "cus_x" {
				t.Errorf("list customer = %q, want cus_x", got)
			}
			if got := r.URL.Query().Get("status"); got != "active" {
				t.Errorf("list status = %q, want active", got)
			}
			w.Header().Set("Content-Type", "application/json")
			// One active subscription with one item on the OLD price.
			fmt.Fprint(w, `{"data":[{"id":"sub_1","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscriptions/sub_1":
			sawUpdate = true
			if err := r.ParseForm(); err != nil {
				t.Fatalf("ParseForm: %v", err)
			}
			if got := r.Form.Get("items[0][id]"); got != "si_1" {
				t.Errorf("items[0][id] = %q, want si_1", got)
			}
			if got := r.Form.Get("items[0][price]"); got != "price_new" {
				t.Errorf("items[0][price] = %q, want price_new", got)
			}
			if got := r.Form.Get("proration_behavior"); got != "create_prorations" {
				t.Errorf("proration_behavior = %q, want create_prorations", got)
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"sub_1"}`)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_x", "price_new"); err != nil {
		t.Fatalf("ChangeSubscriptionPlan: %v", err)
	}
	if !sawList || !sawUpdate {
		t.Fatalf("expected both list+update calls; sawList=%v sawUpdate=%v", sawList, sawUpdate)
	}
}

func TestChangeSubscriptionPlanNoopWhenSamePrice(t *testing.T) {
	var updates int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			updates++
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"sub_1","items":{"data":[{"id":"si_1","price":{"id":"price_same"}}]}}]}`)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_x", "price_same"); err != nil {
		t.Fatalf("ChangeSubscriptionPlan: %v", err)
	}
	if updates != 0 {
		t.Fatalf("expected no update POST when already on the target price, got %d", updates)
	}
}

func TestScheduleDowngradeRequestShape(t *testing.T) {
	var sawList, sawCreate, sawUpdate bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			sawList = true
			w.Header().Set("Content-Type", "application/json")
			// Active sub on the OLD (higher) price, not schedule-managed yet.
			fmt.Fprint(w, `{"data":[{"id":"sub_9","schedule":"","items":{"data":[{"price":{"id":"price_pro"}}]}}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules":
			sawCreate = true
			if err := r.ParseForm(); err != nil {
				t.Fatalf("ParseForm: %v", err)
			}
			if got := r.Form.Get("from_subscription"); got != "sub_9" {
				t.Errorf("from_subscription = %q, want sub_9", got)
			}
			w.Header().Set("Content-Type", "application/json")
			// Seed schedule: one phase spanning the current period on price_pro.
			fmt.Fprint(w, `{"id":"sub_sched_1","phases":[{"start_date":1000,"end_date":2000,"items":[{"price":"price_pro"}]}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sub_sched_1":
			sawUpdate = true
			if err := r.ParseForm(); err != nil {
				t.Fatalf("ParseForm: %v", err)
			}
			if got := r.Form.Get("end_behavior"); got != "release" {
				t.Errorf("end_behavior = %q, want release", got)
			}
			if got := r.Form.Get("phases[0][items][0][price]"); got != "price_pro" {
				t.Errorf("phase0 price = %q, want price_pro (unchanged until period end)", got)
			}
			if got := r.Form.Get("phases[0][end_date]"); got != "2000" {
				t.Errorf("phase0 end_date = %q, want 2000 (period end)", got)
			}
			if got := r.Form.Get("phases[1][items][0][price]"); got != "price_plus" {
				t.Errorf("phase1 price = %q, want price_plus (the downgrade)", got)
			}
			// The trailing phase must be open-ended: real Stripe rejects an
			// iterations param on it ("unknown parameter: phases[iterations]").
			if got := r.Form.Get("phases[1][iterations]"); got != "" {
				t.Errorf("phases[1][iterations] = %q, want empty (Stripe rejects it on a released trailing phase)", got)
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"sub_sched_1"}`)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	if err := c.ScheduleDowngrade(context.Background(), "cus_x", "price_plus"); err != nil {
		t.Fatalf("ScheduleDowngrade: %v", err)
	}
	if !sawList || !sawCreate || !sawUpdate {
		t.Fatalf("expected list+create+update; list=%v create=%v update=%v", sawList, sawCreate, sawUpdate)
	}
}

func TestScheduleDowngradeNoopWhenSamePrice(t *testing.T) {
	var creates int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			creates++
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"sub_9","schedule":"","items":{"data":[{"price":{"id":"price_same"}}]}}]}`)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	if err := c.ScheduleDowngrade(context.Background(), "cus_x", "price_same"); err != nil {
		t.Fatalf("ScheduleDowngrade: %v", err)
	}
	if creates != 0 {
		t.Fatalf("expected no schedule creation when already on the target price, got %d POSTs", creates)
	}
}
