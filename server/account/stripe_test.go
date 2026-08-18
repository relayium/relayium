package account

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func signStripe(secret, payload string, ts int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.%s", ts, payload)))
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}

func TestVerifyWebhookAcceptsValidRejectsTampered(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "bpc_dedicated")
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
	body := `{"type":"checkout.session.completed","data":{"object":{"id":"cs_1","object":"checkout.session","customer":"cus_1","subscription":"sub_1","client_reference_id":"user_42","metadata":{"billing_attempt_id":"attempt_42"}}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 3000), 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "checkout.session.completed" || ev.CustomerID != "cus_1" || ev.ClientRefUserID != "user_42" || ev.CheckoutSessionID != "cs_1" || ev.MetadataBillingAttemptID != "attempt_42" {
		t.Fatalf("bad projection: %+v", ev)
	}
}

func TestVerifyWebhookProjectsAsyncCheckoutLifecycle(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	for _, eventType := range []string{"checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"} {
		body := fmt.Sprintf(`{"id":"evt_async","type":%q,"data":{"object":{"id":"cs_async","object":"checkout.session","customer":"cus_1","client_reference_id":"user_1","metadata":{"billing_attempt_id":"attempt_1"}}}}`, eventType)
		ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 3000), 3000)
		if err != nil || ev.Type != eventType || ev.CheckoutSessionID != "cs_async" || ev.MetadataBillingAttemptID != "attempt_1" {
			t.Fatalf("%s projection = %+v, %v", eventType, ev, err)
		}
	}
}

func TestCheckoutFailureWebhooksAreObservationsNotDeletionTerminals(t *testing.T) {
	for _, eventType := range []string{"checkout.session.async_payment_failed", "checkout.session.expired"} {
		r := checkoutDeletionObservation(WebhookEvent{Type: eventType, CheckoutSessionID: "cs_observed", MetadataBillingAttemptID: "attempt", CustomerID: "cus_1"})
		if r.Terminal || r.Status != eventType || r.ID != "cs_observed" {
			t.Fatalf("%s observation=%+v", eventType, r)
		}
	}
}

func TestExpiredAndAsyncFailedObservationsRequireCanonicalRecoveryProof(t *testing.T) {
	for _, observed := range []string{"checkout.session.expired", "checkout.session.async_payment_failed"} {
		t.Run(observed, func(t *testing.T) {
			var gets int
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gets++
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"id":"cs_recoverable","status":"expired","payment_status":"unpaid","customer":"cus_1","after_expiration":{"recovery":{"enabled":true,"expires_at":200}}}`)
			}))
			defer ts.Close()
			c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
			c.base, c.http = ts.URL, ts.Client()
			now := int64(100)
			c.now = func() time.Time { return time.Unix(now, 0) }
			p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"checkout_session:cs_recoverable": {Kind: "checkout_session", ID: "cs_recoverable", CustomerID: "cus_1", Status: observed}}}
			got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
			if err == nil || gets != 1 || got.Resources["checkout_session:cs_recoverable"].Terminal {
				t.Fatalf("before expiry gets=%d resource=%+v err=%v", gets, got.Resources["checkout_session:cs_recoverable"], err)
			}
			now = 201
			got, err = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, got)
			if err != nil || gets != 2 || !got.Resources["checkout_session:cs_recoverable"].Terminal || got.Resources["checkout_session:cs_recoverable"].Status != "recovery_window_closed" {
				t.Fatalf("after expiry gets=%d resource=%+v err=%v", gets, got.Resources["checkout_session:cs_recoverable"], err)
			}
		})
	}
}

func TestAsyncPaymentFailureReconcilesItsCanonicalPaymentChain(t *testing.T) {
	var sessionGets, paymentGets int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/checkout/sessions/cs_failed":
			sessionGets++
			io.WriteString(w, `{"id":"cs_failed","status":"complete","payment_status":"unpaid","customer":"cus_1","payment_intent":"pi_failed"}`)
		case "/v1/payment_intents/pi_failed":
			paymentGets++
			io.WriteString(w, `{"id":"pi_failed","status":"canceled","customer":"cus_1"}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test_x", "whsec_x", "bpc_x")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{
		"checkout_session:cs_failed": {Kind: "checkout_session", ID: "cs_failed", CustomerID: "cus_1", Status: "checkout.session.async_payment_failed", AsyncFailureAt: 10},
	}}
	var err error
	for i := 0; i < 2; i++ {
		p, err = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	}
	if err != nil || sessionGets == 0 || paymentGets == 0 || !p.Resources["checkout_session:cs_failed"].Terminal || !p.Resources["payment_intent:pi_failed"].Terminal {
		t.Fatalf("sessionGets=%d paymentGets=%d progress=%+v err=%v", sessionGets, paymentGets, p.Resources, err)
	}
}

func TestAsyncFailureEvidenceSurvivesDiscoveryAndLaterSuccessWins(t *testing.T) {
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{}}
	p.add(checkoutDeletionObservation(WebhookEvent{Type: "checkout.session.async_payment_failed", CheckoutSessionID: "cs_async", Created: 10}))
	p.add(BillingDeletionResource{Kind: "checkout_session", ID: "cs_async", Status: "discovered"})
	if got := p.Resources["checkout_session:cs_async"]; got.AsyncFailureAt != 10 || got.AsyncSuccessAt != 0 {
		t.Fatalf("discovery erased failure evidence: %+v", got)
	}
	p.add(checkoutDeletionObservation(WebhookEvent{Type: "checkout.session.async_payment_succeeded", CheckoutSessionID: "cs_async", Created: 11}))
	if got := p.Resources["checkout_session:cs_async"]; got.AsyncFailureAt != 10 || got.AsyncSuccessAt != 11 {
		t.Fatalf("success evidence was not monotonic: %+v", got)
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"id":"cs_async","status":"complete","payment_status":"unpaid","customer":"cus_1","payment_intent":"pi_async"}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	p.Customers = []string{"cus_1"}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	if err == nil || got.Resources["checkout_session:cs_async"].Terminal {
		t.Fatalf("late success was misclassified as failed terminal: %+v err=%v", got.Resources, err)
	}
}

func TestLateAsyncSuccessReopensPriorFailureTerminal(t *testing.T) {
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{
		"checkout_session:cs_late": {Kind: "checkout_session", ID: "cs_late", Status: "canonical_async_payment_failed", Terminal: true, AsyncFailureAt: 10},
	}, CleanSince: 10}
	p.add(checkoutDeletionObservation(WebhookEvent{Type: "checkout.session.async_payment_succeeded", CheckoutSessionID: "cs_late", Created: 11}))
	got := p.Resources["checkout_session:cs_late"]
	if got.Terminal || got.AsyncSuccessAt != 11 || p.CleanSince != 0 {
		t.Fatalf("late success did not reopen deletion reconciliation: %+v clean=%d", got, p.CleanSince)
	}
}

func TestHistoricalDeletionAuditListsPaymentsWithoutCutoff(t *testing.T) {
	seen := map[string]bool{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if (r.URL.Path == "/v1/invoices" || r.URL.Path == "/v1/payment_intents" || r.URL.Path == "/v1/charges") && r.URL.Query().Get("status") == "" && r.URL.Query().Get("created[gte]") == "" {
			seen[r.URL.Path] = true
		}
		io.WriteString(w, `{"data":[],"has_more":false}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_old"}, Resources: map[string]BillingDeletionResource{}, HistoricalAuditRequired: true}
	got, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{CustomerID: "cus_old", CreatedAt: 100}, p)
	if err != nil || got.HistoricalAuditRequired || !seen["/v1/invoices"] || !seen["/v1/payment_intents"] || !seen["/v1/charges"] {
		t.Fatalf("historical audit seen=%v progress=%+v err=%v", seen, got, err)
	}
}

func TestHistoricalAuditWaitsForCanonicalCustomerIdentity(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec", "bpc")
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{
		"checkout_session:cs_attributed": {Kind: "checkout_session", ID: "cs_attributed", AttemptID: "attempt"},
	}, HistoricalAuditRequired: true}
	got, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject"}, p)
	if err != nil || !got.HistoricalAuditRequired {
		t.Fatalf("audit was cleared before customer derivation: %+v err=%v", got, err)
	}
}

func TestHistoricalAuditAcceptsExistingNoSideEffectProof(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec", "bpc")
	p := BillingDeletionProgress{HistoricalAuditRequired: true, Resources: map[string]BillingDeletionResource{"no_side_effect_proof:subject": {Kind: "no_side_effect_proof", ID: "subject", Terminal: true, Status: "verified"}}}
	got, err := c.DiscoverDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject"}, p)
	if err != nil || got.HistoricalAuditRequired {
		t.Fatalf("safe proof did not settle audit: %+v err=%v", got, err)
	}
}

func TestChargeRequiresCanonicalFailedState(t *testing.T) {
	status := "pending"
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, fmt.Sprintf(`{"id":"ch_state","status":%q,"paid":false,"customer":"cus_1"}`, status))
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{"charge:ch_state": {Kind: "charge", ID: "ch_state", CustomerID: "cus_1"}}}
	got, err := c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject"}, p)
	if err == nil || got.Resources["charge:ch_state"].Terminal {
		t.Fatalf("pending charge became terminal: %+v err=%v", got.Resources, err)
	}
	status = "failed"
	got, err = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject"}, got)
	if err != nil || !got.Resources["charge:ch_state"].Terminal || got.Resources["charge:ch_state"].Status != "canonical_failed" {
		t.Fatalf("failed charge did not settle: %+v err=%v", got.Resources, err)
	}
}

func TestDeletionInventoryRejectsNonAdvancingPagination(t *testing.T) {
	for _, response := range []string{`{"data":[],"has_more":true}`, `{"data":[{"id":"same"}],"has_more":true}`} {
		t.Run(response, func(t *testing.T) {
			calls := 0
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; io.WriteString(w, response) }))
			defer ts.Close()
			c := NewStripeClient("sk_test", "whsec", "bpc")
			c.base, c.http = ts.URL, ts.Client()
			_, err := c.deletionList(context.Background(), "/v1/charges", url.Values{"starting_after": {"same"}})
			if err == nil || calls != 1 {
				t.Fatalf("pagination calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestChargeNeedsCanonicalFailureAndLateSuccessReopens(t *testing.T) {
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"charge:ch": {Kind: "charge", ID: "ch", Status: "canonical_failed", Terminal: true}}, CleanSince: 1}
	p.add(BillingDeletionResource{Kind: "charge", ID: "ch", Status: "webhook_success_time", SuccessAt: 10})
	if got := p.Resources["charge:ch"]; got.Terminal || got.SuccessAt != 10 || p.CleanSince != 0 {
		t.Fatalf("late success did not reopen: %+v", got)
	}
}

func TestHistoricalAuditRecoversPreDeletionInvoicePaidAfterDeletion(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/v1/invoices/in_late" {
			io.WriteString(w, `{"id":"in_late","status":"paid","customer":"cus_old","created":90,"payment_intent":"pi_late","charge":"ch_late","status_transitions":{"paid_at":110}}`)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/invoices" && r.URL.Query().Get("status") == "" && r.URL.Query().Get("created[gte]") == "" {
			io.WriteString(w, `{"data":[{"id":"in_late"}],"has_more":false}`)
			return
		}
		io.WriteString(w, `{"data":[],"has_more":false}`)
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	row := BillingCancellation{BillingSubjectID: "subject", CustomerID: "cus_old", CreatedAt: 100, IdempotencyKey: "delete"}
	p := BillingDeletionProgress{Customers: []string{"cus_old"}, Resources: map[string]BillingDeletionResource{}, HistoricalAuditRequired: true}
	p, err := c.DiscoverDeletionHazards(context.Background(), row, p)
	if err != nil {
		t.Fatal(err)
	}
	p, err = c.ReconcileDeletionHazards(context.Background(), row, p)
	invoice := p.Resources["invoice:in_late"]
	if err == nil || !invoice.Manual || invoice.Status != "paid_after_deletion" || invoice.PaymentIntentID != "pi_late" {
		t.Fatalf("late historical payment was lost: invoice=%+v progress=%+v err=%v", invoice, p, err)
	}
}

func TestVerifiedAsyncFailureMakesRequiresPaymentMethodTerminal(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/checkout/sessions/cs_failed_method":
			io.WriteString(w, `{"id":"cs_failed_method","status":"complete","payment_status":"unpaid","customer":"cus_1","payment_intent":"pi_failed_method"}`)
		case "/v1/payment_intents/pi_failed_method":
			io.WriteString(w, `{"id":"pi_failed_method","status":"requires_payment_method","customer":"cus_1"}`)
		default:
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	c := NewStripeClient("sk_test", "whsec", "bpc")
	c.base, c.http = ts.URL, ts.Client()
	p := BillingDeletionProgress{Customers: []string{"cus_1"}, Resources: map[string]BillingDeletionResource{}}
	p.add(checkoutDeletionObservation(WebhookEvent{Type: "checkout.session.async_payment_failed", CheckoutSessionID: "cs_failed_method", CustomerID: "cus_1", Created: 10}))
	raw, _ := json.Marshal(p)
	p, _ = decodeDeletionProgressStrict(string(raw))
	var err error
	for i := 0; i < 2; i++ {
		p, err = c.ReconcileDeletionHazards(context.Background(), BillingCancellation{BillingSubjectID: "subject", IdempotencyKey: "delete"}, p)
	}
	if err != nil || !p.Resources["checkout_session:cs_failed_method"].Terminal || !p.Resources["payment_intent:pi_failed_method"].Terminal {
		t.Fatalf("verified failure did not converge: %+v err=%v", p.Resources, err)
	}
}

func TestVerifyWebhookProjectsRefundFailureIdentity(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"id":"evt_refund","type":"refund.failed","data":{"object":{"id":"re_failed","object":"refund","payment_intent":"pi_1","metadata":{"relayium_deletion_action_id":"bdr_1"}}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 3000), 3000)
	if err != nil || ev.RefundID != "re_failed" || ev.PaymentIntentID != "pi_1" || ev.MetadataDeletionActionID != "bdr_1" {
		t.Fatalf("refund failure projection=%+v err=%v", ev, err)
	}
	if ev.Status != "" || stripeRefundLifecycleStatus(ev) != "failed" {
		t.Fatalf("nullable refund failure status was not forced failed: event=%+v lifecycle=%q", ev, stripeRefundLifecycleStatus(ev))
	}
}

func TestStripeCatalogStartupGateRejectsMeteredPrice(t *testing.T) {
	tests := []struct {
		name, response string
		wantOK         bool
	}{
		{"matching licensed price", `{"id":"price_paid","active":true,"livemode":false,"type":"recurring","currency":"usd","unit_amount":990,"recurring":{"usage_type":"licensed","interval":"month","interval_count":1}}`, true},
		{"metered", `{"id":"price_paid","active":true,"livemode":false,"type":"recurring","currency":"usd","unit_amount":990,"recurring":{"usage_type":"metered","interval":"month","interval_count":1}}`, false},
		{"wrong amount", `{"id":"price_paid","active":true,"livemode":false,"type":"recurring","currency":"usd","unit_amount":991,"recurring":{"usage_type":"licensed","interval":"month","interval_count":1}}`, false},
		{"wrong currency", `{"id":"price_paid","active":true,"livemode":false,"type":"recurring","currency":"eur","unit_amount":990,"recurring":{"usage_type":"licensed","interval":"month","interval_count":1}}`, false},
		{"wrong interval", `{"id":"price_paid","active":true,"livemode":false,"type":"recurring","currency":"usd","unit_amount":990,"recurring":{"usage_type":"licensed","interval":"year","interval_count":1}}`, false},
		{"inactive", `{"id":"price_paid","active":false,"livemode":false,"type":"recurring","currency":"usd","unit_amount":990,"recurring":{"usage_type":"licensed","interval":"month","interval_count":1}}`, false},
		{"wrong mode", `{"id":"price_paid","active":true,"livemode":true,"type":"recurring","currency":"usd","unit_amount":990,"recurring":{"usage_type":"licensed","interval":"month","interval_count":1}}`, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			if err := store.UpsertPlan(context.Background(), Plan{ID: "paid", Name: "Paid", Active: true, PriceMonthly: 990, StripePriceMonthlyID: "price_paid"}); err != nil {
				t.Fatal(err)
			}
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, tc.response)
			}))
			defer ts.Close()
			c := NewStripeClient("sk_test", "whsec", "bpc")
			c.base, c.http = ts.URL, ts.Client()
			svc := NewService(store, nil, Config{})
			svc.biller = c
			err := svc.ValidateStripeCatalog(context.Background())
			if tc.wantOK != (err == nil) {
				t.Fatalf("wantOK=%t err=%v", tc.wantOK, err)
			}
		})
	}
}

func TestVerifyWebhookProjectsFinancialHazardIDs(t *testing.T) {
	c := NewStripeClient("sk_test_x", "whsec_abc", "bpc_x")
	body := `{"id":"evt_invoice","type":"invoice.paid","created":3000,"livemode":false,"data":{"object":{"id":"in_1","object":"invoice","customer":"cus_1","subscription":"sub_1","payment_intent":"pi_1","charge":"ch_1"}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 3000), 3000)
	if err != nil {
		t.Fatal(err)
	}
	if ev.InvoiceID != "in_1" || ev.PaymentIntentID != "pi_1" || ev.ChargeID != "ch_1" {
		t.Fatalf("financial projection=%+v", ev)
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
		if got := r.Header.Get("Idempotency-Key"); got != "checkout:attempt_42" {
			t.Errorf("Idempotency-Key = %q, want checkout:attempt_42", got)
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
		if got := r.Form.Get("metadata[billing_attempt_id]"); got != "attempt_42" {
			t.Errorf("metadata[billing_attempt_id] = %q, want attempt_42", got)
		}
		if got := r.Form.Get("metadata[user_id]"); got != "user_42" {
			t.Errorf("metadata[user_id] = %q, want user_42", got)
		}
		if got := r.Form.Get("subscription_data[metadata][billing_attempt_id]"); got != "attempt_42" {
			t.Errorf("subscription_data metadata attempt = %q, want attempt_42", got)
		}
		for key := range r.Form {
			if strings.HasPrefix(key, "after_expiration[") || strings.HasPrefix(key, "recovery[") {
				t.Errorf("Checkout recovery must remain disabled, sent %q", key)
			}
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
		fmt.Fprintf(w, `{"id":"cs_test_abc","url":%q}`, cannedURL)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	got, err := c.CreateCheckoutSession(context.Background(), CheckoutInput{
		PriceID:          "price_pro_monthly",
		CustomerEmail:    "user@example.com",
		ClientRefUserID:  "user_42",
		BillingAttemptID: "attempt_42",
		SuccessURL:       "https://relayium.test/success",
		CancelURL:        "https://relayium.test/cancel",
		IdempotencyKey:   "checkout:attempt_42",
	})
	if err != nil {
		t.Fatalf("CreateCheckoutSession: %v", err)
	}
	if got.ID != "cs_test_abc" || got.URL != cannedURL {
		t.Fatalf("session = %+v", got)
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
		fmt.Fprintf(w, `{"id":"cs_test_xyz","url":%q}`, cannedURL)
	}))
	defer srv.Close()

	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL

	got, err := c.CreateCheckoutSession(context.Background(), CheckoutInput{
		PriceID:          "price_pro_monthly",
		CustomerID:       "cus_existing",
		ClientRefUserID:  "user_42",
		BillingAttemptID: "attempt_existing",
		SuccessURL:       "https://relayium.test/success",
		CancelURL:        "https://relayium.test/cancel",
	})
	if err != nil {
		t.Fatalf("CreateCheckoutSession: %v", err)
	}
	if got.ID != "cs_test_xyz" || got.URL != cannedURL {
		t.Fatalf("session = %+v", got)
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

	c := NewStripeClient("sk_test", "whsec_abc", "bpc_dedicated")
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
		PriceID:          "price_pro_monthly",
		CustomerEmail:    "user@example.com",
		ClientRefUserID:  "user_42",
		BillingAttemptID: "attempt_error",
		SuccessURL:       "https://relayium.test/success",
		CancelURL:        "https://relayium.test/cancel",
	})
	if err == nil {
		t.Fatal("expected error on non-2xx response, got nil")
	}
	if got != (CheckoutSession{}) {
		t.Fatalf("session = %+v, want empty on error (no silent success)", got)
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
			if got := r.URL.Query().Get("status"); got != "all" {
				t.Errorf("list status = %q, want all", got)
			}
			w.Header().Set("Content-Type", "application/json")
			// One active subscription with one item on the OLD price.
			fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`)
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
			if got := r.Form.Get("proration_behavior"); got != "always_invoice" {
				t.Errorf("proration_behavior = %q, want always_invoice", got)
			}
			if got := r.Form.Get("payment_behavior"); got != "pending_if_incomplete" {
				t.Errorf("payment_behavior = %q, want pending_if_incomplete", got)
			}
			// always_invoice makes this request charge money, so the header is
			// part of its shape: without a deterministic Idempotency-Key a
			// double-submit prorates twice. Pinned to planChangeIdemKey's value
			// for the state the list call above reported, so dropping or
			// re-scoping the key fails here and not only in the dedicated
			// idempotency tests. That fixture carries no latest_invoice, which
			// also pins the degraded (no generation token) scope.
			wantKey := planChangeIdemKey(liveSub{ID: "sub_1", ItemID: "si_1", PriceID: "price_old"}, "price_new")
			if got := r.Header.Get("Idempotency-Key"); got != wantKey {
				t.Errorf("Idempotency-Key = %q, want %q", got, wantKey)
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
		fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","items":{"data":[{"id":"si_1","price":{"id":"price_same"}}]}}]}`)
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

func TestChangeSubscriptionPlanFindsTrialingSubscription(t *testing.T) {
	var listQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/subscriptions") {
			listQuery = r.URL.RawQuery
			// A trialing subscription — the old status=active query would miss it.
			w.Write([]byte(`{"data":[{"id":"sub_t","status":"trialing","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`))
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/v1/subscriptions/sub_t" {
			w.Write([]byte(`{"id":"sub_t"}`))
			return
		}
		t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatalf("trialing subscription should be changeable: %v", err)
	}
	if strings.Contains(listQuery, "status=active") || !strings.Contains(listQuery, "status=all") {
		t.Fatalf("subscription list must query status=all, got %q", listQuery)
	}
}

func TestScheduleDowngradeRequestShape(t *testing.T) {
	var sawList, sawCreate, sawUpdate bool
	target := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			sawList = true
			w.Header().Set("Content-Type", "application/json")
			// Active sub on the OLD (higher) price, not schedule-managed yet.
			fmt.Fprint(w, `{"data":[{"id":"sub_9","status":"active","schedule":"","items":{"data":[{"price":{"id":"price_pro"}}]}}]}`)
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
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sub_sched_1":
			phase1 := ""
			if target != "" {
				phase1 = fmt.Sprintf(`,{"start_date":2000,"items":[{"price":%q}]}`, target)
			}
			fmt.Fprintf(w, `{"id":"sub_sched_1","status":"active","phases":[{"start_date":1000,"end_date":2000,"items":[{"price":"price_pro"}]}%s]}`, phase1)
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
			target = r.Form.Get("phases[1][items][0][price]")
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
		fmt.Fprint(w, `{"data":[{"id":"sub_9","status":"active","schedule":"","items":{"data":[{"price":{"id":"price_same"}}]}}]}`)
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

func TestScheduleDowngradeFindsTrialingSubscription(t *testing.T) {
	var listQuery string
	target := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/subscriptions"):
			listQuery = r.URL.RawQuery
			// A trialing subscription on the OLD price — the old status=active
			// query would miss it and 500 with "no live subscription".
			w.Write([]byte(`{"data":[{"id":"sub_t","status":"trialing","schedule":"","items":{"data":[{"price":{"id":"price_pro"}}]}}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules":
			if err := r.ParseForm(); err != nil {
				t.Fatalf("ParseForm: %v", err)
			}
			if got := r.Form.Get("from_subscription"); got != "sub_t" {
				t.Errorf("from_subscription = %q, want sub_t", got)
			}
			w.Write([]byte(`{"id":"sub_sched_1","phases":[{"start_date":1000,"end_date":2000,"items":[{"price":"price_pro"}]}]}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sub_sched_1":
			phase1 := ""
			if target != "" {
				phase1 = fmt.Sprintf(`,{"start_date":2000,"items":[{"price":%q}]}`, target)
			}
			fmt.Fprintf(w, `{"id":"sub_sched_1","status":"active","phases":[{"start_date":1000,"end_date":2000,"items":[{"price":"price_pro"}]}%s]}`, phase1)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sub_sched_1":
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			target = r.Form.Get("phases[1][items][0][price]")
			w.Write([]byte(`{"id":"sub_sched_1"}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	if err := c.ScheduleDowngrade(context.Background(), "cus_1", "price_plus"); err != nil {
		t.Fatalf("trialing subscription should be schedulable: %v", err)
	}
	if strings.Contains(listQuery, "status=active") || !strings.Contains(listQuery, "status=all") {
		t.Fatalf("subscription list must query status=all, got %q", listQuery)
	}
}

func TestReleaseScheduleFindsTrialingSubscription(t *testing.T) {
	var listQuery string
	var sawRelease bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/subscriptions"):
			listQuery = r.URL.RawQuery
			// A trialing subscription with a pending schedule — the old
			// status=active query would miss it and treat it as "nothing to
			// release" instead of actually releasing the schedule.
			w.Write([]byte(`{"data":[{"id":"sub_t","status":"trialing","schedule":"sub_sched_1"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sub_sched_1/release":
			sawRelease = true
			w.Write([]byte(`{"id":"sub_sched_1","status":"released"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sub_sched_1":
			status := "active"
			if sawRelease {
				status = "released"
			}
			fmt.Fprintf(w, `{"id":"sub_sched_1","status":%q}`, status)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	if err := c.ReleaseSchedule(context.Background(), "cus_1"); err != nil {
		t.Fatalf("trialing subscription's schedule should be releasable: %v", err)
	}
	if strings.Contains(listQuery, "status=active") || !strings.Contains(listQuery, "status=all") {
		t.Fatalf("subscription list must query status=all, got %q", listQuery)
	}
	if !sawRelease {
		t.Fatal("expected a release POST")
	}
}

func TestReleaseScheduleRequestShape(t *testing.T) {
	var sawRelease bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","schedule":"sub_sched_7"}]}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/subscription_schedules/sub_sched_7/release":
			sawRelease = true
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"sub_sched_7","status":"released"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscription_schedules/sub_sched_7":
			status := "active"
			if sawRelease {
				status = "released"
			}
			fmt.Fprintf(w, `{"id":"sub_sched_7","status":%q}`, status)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL
	if err := c.ReleaseSchedule(context.Background(), "cus_x"); err != nil {
		t.Fatalf("ReleaseSchedule: %v", err)
	}
	if !sawRelease {
		t.Fatal("expected a release POST")
	}
}

func TestReleaseScheduleNoopWhenNoSchedule(t *testing.T) {
	var posts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts++
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"sub_1","status":"active","schedule":""}]}`)
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec_abc", "")
	c.base = srv.URL
	if err := c.ReleaseSchedule(context.Background(), "cus_x"); err != nil {
		t.Fatalf("ReleaseSchedule: %v", err)
	}
	if posts != 0 {
		t.Fatalf("want no POST when there is no schedule, got %d", posts)
	}
}

func TestChangeSubscriptionPlanChargesProrationNow(t *testing.T) {
	var prorationBehavior string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Write([]byte(`{"data":[{"id":"sub_1","status":"active","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`))
			return
		}
		r.ParseForm()
		prorationBehavior = r.FormValue("proration_behavior")
		w.Write([]byte(`{"id":"sub_1"}`))
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatal(err)
	}
	if prorationBehavior != "always_invoice" {
		t.Fatalf("upgrade must invoice the proration now, got %q", prorationBehavior)
	}
}

func TestPreviewChangeReturnsImmediateCharge(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/subscriptions"):
			w.Write([]byte(`{"data":[{"id":"sub_1","status":"active","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`))
		case r.URL.Path == "/v1/invoices/create_preview":
			_ = r.ParseForm()
			if got := r.PostForm.Get("subscription_details[proration_behavior]"); got != "always_invoice" {
				t.Errorf("preview must use always_invoice, got %q", got)
			}
			if got := r.PostForm.Get("subscription_details[items][0][price]"); got != "price_new" {
				t.Errorf("preview must target the new price, got %q", got)
			}
			w.Write([]byte(`{"amount_due":734}`))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	pv, err := c.PreviewChange(context.Background(), "cus_1", "price_new")
	if err != nil {
		t.Fatal(err)
	}
	if pv.AmountDueCents != 734 {
		t.Fatalf("want 734, got %d", pv.AmountDueCents)
	}
}

// On an older API version where create_preview does not exist (404), PreviewChange
// falls back to the legacy /v1/invoices/upcoming endpoint. This is the exact bug
// that broke the change-plan preview: Basil API versions removed `upcoming`, so we
// try create_preview first, but older accounts must keep working too.
func TestPreviewChangeFallsBackToUpcoming(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/subscriptions"):
			w.Write([]byte(`{"data":[{"id":"sub_1","status":"active","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`))
		case r.URL.Path == "/v1/invoices/create_preview":
			http.Error(w, `{"error":{"message":"Unrecognized request URL"}}`, http.StatusNotFound)
		case strings.HasPrefix(r.URL.Path, "/v1/invoices/upcoming"):
			if got := r.URL.Query().Get("subscription_proration_behavior"); got != "always_invoice" {
				t.Errorf("upcoming fallback must use always_invoice, got %q", got)
			}
			w.Write([]byte(`{"amount_due":521}`))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	pv, err := c.PreviewChange(context.Background(), "cus_1", "price_new")
	if err != nil {
		t.Fatalf("fallback should succeed: %v", err)
	}
	if pv.AmountDueCents != 521 {
		t.Fatalf("want 521 from upcoming fallback, got %d", pv.AmountDueCents)
	}
}
