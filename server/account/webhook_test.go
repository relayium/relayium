package account

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newWebhookFixtureClient is for tests that deliberately exercise projection of
// an already-verified event payload. Canonical convergence has separate tests
// with a fake Stripe API; production clients keep canonical refresh enabled.
func newWebhookFixtureClient(secret string) *stripeClient {
	c := NewStripeClient("sk_test", secret, "")
	c.canonicalWebhookRefresh = false
	return c
}

// webhookEnv builds a minimal Stripe event envelope JSON body matching the
// fields VerifyWebhook parses (see stripe.go's envelope struct).
func webhookEnv(eventType, customer, subscription, clientRefUserID, status, priceID string, currentPeriodEnd int64) string {
	return webhookEnvWithMetadata(eventType, customer, subscription, clientRefUserID, status, priceID, currentPeriodEnd, "")
}

// webhookEnvWithMetadata is webhookEnv plus a data.object.metadata.user_id,
// as CreateCheckoutSession stamps via subscription_data[metadata][user_id]
// (see stripe.go), used to exercise the out-of-order-delivery fallback.
func webhookEnvWithMetadata(eventType, customer, subscription, clientRefUserID, status, priceID string, currentPeriodEnd int64, metadataUserID string) string {
	eventID := fmt.Sprintf("evt_%x", sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%s\x00%d\x00%s", eventType, customer, subscription, status, priceID, currentPeriodEnd, metadataUserID))))
	items := "null"
	if priceID != "" {
		items = fmt.Sprintf(`{"data":[{"price":{"id":%q}}]}`, priceID)
	}
	metadata := "null"
	if metadataUserID != "" {
		metadata = fmt.Sprintf(`{"user_id":%q}`, metadataUserID)
	}
	// Mirror the two real Stripe object shapes so this payload exercises the
	// same parsing branch production does. On customer.subscription.* the object
	// IS the subscription (id at data.object.id, object=="subscription", no
	// "subscription" key); on checkout.session.completed the object is the
	// session, which references its subscription at data.object.subscription.
	if strings.HasPrefix(eventType, "customer.subscription") {
		return fmt.Sprintf(`{"id":%q,"type":%q,"data":{"object":{"id":%q,"object":"subscription","customer":%q,"client_reference_id":%q,"status":%q,"current_period_end":%d,"metadata":%s,"items":%s}}}`,
			eventID, eventType, subscription, customer, clientRefUserID, status, currentPeriodEnd, metadata, items)
	}
	return fmt.Sprintf(`{"id":%q,"type":%q,"data":{"object":{"object":"checkout.session","customer":%q,"subscription":%q,"client_reference_id":%q,"status":%q,"current_period_end":%d,"metadata":%s,"items":%s}}}`,
		eventID, eventType, customer, subscription, clientRefUserID, status, currentPeriodEnd, metadata, items)
}

// postWebhook signs body with secret at the current time and POSTs it to the
// running test server's webhook endpoint, returning the response.
func postWebhook(t *testing.T, ts *httptest.Server, secret, body string) *http.Response {
	t.Helper()
	sig := signStripe(secret, body, time.Now().Unix())
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/stripe/webhook", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Stripe-Signature", sig)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestWebhookUnconfigured404(t *testing.T) {
	ts, _, _, _ := newBillingServer(t)
	body := webhookEnv("checkout.session.completed", "cus_1", "", "u1", "", "", 0)
	resp := postWebhook(t, ts, "whsec_unused", body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404 when biller unconfigured, got %d", resp.StatusCode)
	}
}

func TestWebhookBadSignature400NoStateChange(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = newWebhookFixtureClient("whsec_real")
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	cookie := loginCookie(t, ts, mail, "webhook-badsig@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-badsig@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_badsig"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_badsig", "sub_1", "", "active", "price_pro_m", 999)
	// Sign with the wrong secret.
	sig := signStripe("whsec_wrong", body, time.Now().Unix())
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/stripe/webhook", strings.NewReader(body))
	req.Header.Set("Stripe-Signature", sig)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for bad signature, got %d", resp.StatusCode)
	}
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_badsig")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer: ok=%v err=%v", ok, err)
	}
	if u.PlanID != "" && u.PlanID != "free" {
		t.Fatalf("plan must not change on bad signature, got %q", u.PlanID)
	}
}

// mustUserID logs a user in via magic link (creating them) and returns their id.
func mustUserID(t *testing.T, store *SQLiteStore, email string) string {
	t.Helper()
	u, ok, err := store.GetUserByIdentity(context.Background(), "email", email)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("user %s not found — call loginCookie first", email)
	}
	return u.ID
}

func TestWebhookCheckoutCompletedBindsCustomer(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_checkout"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	cookie := loginCookie(t, ts, mail, "webhook-checkout@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-checkout@example.com")

	body := webhookEnv("checkout.session.completed", "cus_checkout_1", "", uid, "", "", 0)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_checkout_1")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer: ok=%v err=%v", ok, err)
	}
	if u.ID != uid {
		t.Fatalf("want user %s bound to customer, got %s", uid, u.ID)
	}
	// Plan not yet changed by checkout.session.completed alone.
	if u.PlanID != "" && u.PlanID != "free" {
		t.Fatalf("plan must stay unassigned after checkout.session.completed alone, got %q", u.PlanID)
	}
}

func TestLateAsyncCheckoutSuccessPersistsExactPaymentChainBeforeACK(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_late_async"
	var canonicalReads int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		canonicalReads++
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/checkout/sessions/cs_late_async":
			io.WriteString(w, `{"id":"cs_late_async","customer":"cus_late_async","payment_status":"paid","payment_intent":"pi_late_async"}`)
		case "/v1/payment_intents/pi_late_async":
			io.WriteString(w, `{"id":"pi_late_async","status":"succeeded","latest_charge":"ch_late_async"}`)
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	defer provider.Close()
	client := newWebhookFixtureClient(secret)
	client.base, client.http = provider.URL, provider.Client()
	svc.biller = client
	loginCookie(t, ts, mail, "late-async@example.test")
	uid := mustUserID(t, store, "late-async@example.test")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_late_async"); err != nil {
		t.Fatal(err)
	}
	p := BillingDeletionProgress{Customers: []string{"cus_late_async"}, Resources: map[string]BillingDeletionResource{
		"payment_intent:pi_late_async": {Kind: "payment_intent", ID: "pi_late_async", PaymentIntentID: "pi_late_async", Terminal: true, Status: "refunded"},
	}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,idempotency_key,state,created_at,updated_at,generation,progress_json,terminal_at,mode,deletion_epoch,cutoff_at) VALUES('late-async-old',?,'stripe','cus_late_async','late-async-old-key','terminal',100,100,1,?,100,'account_deletion','late-async-epoch',100)`, uid, string(raw)); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"id":"evt_late_async","type":"checkout.session.async_payment_succeeded","created":110,"livemode":false,"data":{"object":{"id":"cs_late_async","object":"checkout.session","customer":"cus_late_async","client_reference_id":%q,"payment_status":"paid"}}}`, uid)
	resp := postWebhook(t, ts, secret, body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("late async status=%d", resp.StatusCode)
	}
	var progress string
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE mode='exact_compensation' AND state='pending'`).Scan(&progress); err != nil {
		t.Fatal(err)
	}
	exact := decodeDeletionProgress(progress)
	if _, ok := exact.Resources["payment_intent:pi_late_async"]; !ok {
		t.Fatalf("payment intent missing: %+v", exact.Resources)
	}
	if _, ok := exact.Resources["charge:ch_late_async"]; !ok {
		t.Fatalf("charge missing: %+v", exact.Resources)
	}
	for key := range exact.Resources {
		if strings.HasPrefix(key, "checkout_session:") || strings.HasPrefix(key, "subscription:") || strings.HasPrefix(key, "schedule:") {
			t.Fatalf("non-payment resource in exact compensation: %s", key)
		}
	}
	resp = postWebhook(t, ts, secret, body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || canonicalReads != 2 {
		t.Fatalf("duplicate status=%d canonicalReads=%d", resp.StatusCode, canonicalReads)
	}
	var count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_cancellation_outbox WHERE mode='exact_compensation'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate exact rows=%d err=%v", count, err)
	}
}

func TestAsyncCheckoutSuccessWithoutCanonicalPaymentChainIsRetried(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_async_no_chain"
	var reads int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads++
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/v1/checkout/sessions/cs_no_chain" {
			t.Fatalf("current subscription invoice was read: %s", r.URL.Path)
		}
		io.WriteString(w, `{"id":"cs_no_chain","customer":"cus_no_chain","subscription":"sub_current_renewal","payment_status":"paid"}`)
	}))
	defer provider.Close()
	client := newWebhookFixtureClient(secret)
	client.base, client.http = provider.URL, provider.Client()
	svc.biller = client
	loginCookie(t, ts, mail, "async-no-chain@example.test")
	uid := mustUserID(t, store, "async-no-chain@example.test")
	body := fmt.Sprintf(`{"id":"evt_async_no_chain","type":"checkout.session.async_payment_succeeded","created":110,"livemode":false,"data":{"object":{"id":"cs_no_chain","object":"checkout.session","customer":"cus_no_chain","client_reference_id":%q,"payment_status":"paid"}}}`, uid)
	resp := postWebhook(t, ts, secret, body)
	resp.Body.Close()
	if resp.StatusCode < 500 {
		t.Fatalf("missing canonical chain ACKed with %d", resp.StatusCode)
	}
	if reads != 1 {
		t.Fatalf("canonical reads=%d want session only", reads)
	}
	var status string
	if err := store.db.QueryRow(`SELECT status FROM stripe_webhook_events WHERE event_id='evt_async_no_chain'`).Scan(&status); err != nil || status != "failed" {
		t.Fatalf("missing-chain ledger status=%s err=%v", status, err)
	}
}

func TestDeletingAccountPersistsFailedAndExpiredCheckoutBeforeAuthority(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_deleting_checkout"
	svc.biller = newWebhookFixtureClient(secret)
	loginCookie(t, ts, mail, "deleting-checkout@example.test")
	uid := mustUserID(t, store, "deleting-checkout@example.test")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_deleting_checkout"); err != nil {
		t.Fatal(err)
	}
	p := BillingDeletionProgress{Customers: []string{"cus_deleting_checkout"}, Resources: map[string]BillingDeletionResource{}}
	raw, _ := json.Marshal(p)
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at) VALUES(?,X'05','stripe',1,1000,1000)`, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,idempotency_key,state,created_at,updated_at,generation,progress_json,mode,deletion_epoch,cutoff_at) VALUES('deleting-checkout',?,'stripe','cus_deleting_checkout','deleting-checkout-key','pending',1,1,1,?,'account_deletion','deleting-checkout',1)`, uid, string(raw)); err != nil {
		t.Fatal(err)
	}
	var mapped, pending int
	if err := store.db.QueryRow(`SELECT (SELECT COUNT(*) FROM stripe_customer_history WHERE user_id=? AND customer_id='cus_deleting_checkout'),(SELECT COUNT(*) FROM billing_cancellation_outbox WHERE billing_subject_id=? AND state='pending' AND mode='account_deletion')`, uid, uid).Scan(&mapped, &pending); err != nil || mapped != 1 || pending != 1 {
		t.Fatalf("deletion mapping=%d pending=%d err=%v", mapped, pending, err)
	}
	for i, eventType := range []string{"checkout.session.async_payment_failed", "checkout.session.expired"} {
		body := fmt.Sprintf(`{"id":"evt_deleting_checkout_%d","type":%q,"created":%d,"livemode":false,"data":{"object":{"id":"cs_deleting_%d","object":"checkout.session","customer":"cus_deleting_checkout"}}}`, i, eventType, 10+i, i)
		resp := postWebhook(t, ts, secret, body)
		responseBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", eventType, resp.StatusCode, responseBody)
		}
	}
	var progress string
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE id='deleting-checkout'`).Scan(&progress); err != nil {
		t.Fatal(err)
	}
	got := decodeDeletionProgress(progress)
	if r := got.Resources["checkout_session:cs_deleting_0"]; r.AsyncFailureAt != 10 || r.Status != "checkout.session.async_payment_failed" {
		t.Fatalf("failed observation=%+v", r)
	}
	if r := got.Resources["checkout_session:cs_deleting_1"]; r.Status != "checkout.session.expired" {
		t.Fatalf("expired observation=%+v", r)
	}
}

func TestWebhookSubscriptionUpdatedActiveAssignsPlan(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_sub_active"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	cookie := loginCookie(t, ts, mail, "webhook-active@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-active@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_active_1"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_active_1", "sub_1", "", "active", "price_pro_m", 1700000000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_active_1")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer: ok=%v err=%v", ok, err)
	}
	if u.PlanID != "pro" {
		t.Fatalf("want plan pro, got %q", u.PlanID)
	}
	if u.SubscriptionStatus != "active" {
		t.Fatalf("want status active, got %q", u.SubscriptionStatus)
	}
	if u.SubscriptionEnd != 1700000000 {
		t.Fatalf("want end 1700000000, got %d", u.SubscriptionEnd)
	}
	if u.PlanSource != "stripe" {
		t.Fatalf("want source stripe, got %q", u.PlanSource)
	}
	// P1-1 regression: the subscription id must be adopted as canonical. It lives
	// at data.object.id on a real customer.subscription.* event (NOT
	// data.object.subscription). Parsing only the latter left SubscriptionID empty
	// in production, so this was never written and the double-checkout dedup /
	// duplicate-deletion guard were dead code. An empty value here means that
	// regression is back.
	if u.StripeSubscriptionID != "sub_1" {
		t.Fatalf("canonical subscription id not adopted: got %q, want sub_1 (ev.SubscriptionID must come from data.object.id)", u.StripeSubscriptionID)
	}

	// Idempotent re-delivery of the same event: same final state.
	resp2 := postWebhook(t, ts, secret, body)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("want 200 on redelivery, got %d", resp2.StatusCode)
	}
	u2, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_active_1")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer (redelivery): ok=%v err=%v", ok, err)
	}
	if u2.PlanID != "pro" || u2.SubscriptionStatus != "active" || u2.SubscriptionEnd != 1700000000 || u2.PlanSource != "stripe" {
		t.Fatalf("redelivery produced a different state: %+v", u2)
	}
}

func TestWebhookSubscriptionUpdatedPastDueRetainsEntitlement(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_sub_pastdue"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "free", Name: "Free", Active: true})
	cookie := loginCookie(t, ts, mail, "webhook-pastdue@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-pastdue@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_pastdue_1"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 1700000000, "stripe", "", time.Now().Unix(), 0); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_pastdue_1", "sub_1", "", "past_due", "price_pro_m", 1700000500)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_pastdue_1")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer: ok=%v err=%v", ok, err)
	}
	if u.PlanID != "pro" {
		t.Fatalf("Smart Retry grace must retain pro, got %q", u.PlanID)
	}
	if u.SubscriptionStatus != "past_due" {
		t.Fatalf("want status past_due, got %q", u.SubscriptionStatus)
	}
}

func TestWebhookSubscriptionDeletedRevertsToFreeCanceled(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_sub_deleted"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "free", Name: "Free", Active: true})
	cookie := loginCookie(t, ts, mail, "webhook-deleted@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-deleted@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_deleted_1"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 1700000000, "stripe", "", time.Now().Unix(), 0); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.deleted", "cus_deleted_1", "sub_1", "", "canceled", "", 1700001000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_deleted_1")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer: ok=%v err=%v", ok, err)
	}
	if u.PlanID != "free" {
		t.Fatalf("want plan free, got %q", u.PlanID)
	}
	if u.SubscriptionStatus != "canceled" {
		t.Fatalf("want status canceled, got %q", u.SubscriptionStatus)
	}
}

// signedWebhookRequest builds a Stripe-Signature-signed POST to the webhook
// endpoint using an explicit timestamp, instead of postWebhook's hardcoded
// time.Now(). Needed whenever the test also overrides svc.now to a synthetic
// clock for deterministic proration math: VerifyWebhook checks the signed
// timestamp against svc.now() (see stripe.go's replayWindowSecs tolerance),
// so signing with real wall-clock time while svc.now() points at a synthetic
// month would fail signature verification for an unrelated reason.
func signedWebhookRequest(t *testing.T, ts *httptest.Server, secret, body string, at int64) *http.Response {
	t.Helper()
	sig := signStripe(secret, body, at)
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/stripe/webhook", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Stripe-Signature", sig)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// TestWebhookSubscriptionUpdatedAccruesPreviousSegment proves the C2 monthly
// proration write path (decision 4) is actually wired into the Stripe
// webhook entry point — spec's "测试要点" names three change entry points
// (webhook / in-app upgrade / admin) that must each freeze the previous
// segment; TestAccrueOnAdminPlanChange already covers admin, this covers
// webhook. This drives the real HTTP handler (handleStripeWebhook, via a
// signed POST through the actual mux) rather than calling SetUserSubscription
// directly, so it's an HTTP-layer test, not just a store-layer one.
func TestWebhookSubscriptionUpdatedAccruesPreviousSegment(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_accrue"
	svc.biller = newWebhookFixtureClient(secret)
	plusCap := int64(300) << 30
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true, TrafficBytes: plusCap, StripePriceMonthlyID: "price_plus_m"})
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, TrafficBytes: int64(1) << 40, StripePriceMonthlyID: "price_pro_m"})
	cookie := loginCookie(t, ts, mail, "webhook-accrue@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-accrue@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_accrue"); err != nil {
		t.Fatal(err)
	}

	// Put the user on "plus" starting at a known month's start, then freeze
	// svc.now at that same instant so the login/setup above (which ran on the
	// real wall clock) isn't affected.
	monthStart, _, monthSecs := monthAt(t, "202603")
	t0 := monthStart
	svc.now = func() time.Time { return time.Unix(t0, 0) }
	if err := store.SetUserSubscription(context.Background(), uid, "plus", "active", 0, "stripe", "", t0, 0); err != nil {
		t.Fatal(err)
	}

	// Mid-month: a customer.subscription.updated webhook moves the user to
	// "pro". svc.now advances to the same instant the request is signed with.
	t1 := monthStart + monthSecs/2
	svc.now = func() time.Time { return time.Unix(t1, 0) }
	body := webhookEnv("customer.subscription.updated", "cus_accrue", "sub_1", "", "active", "price_pro_m", 0)
	resp := signedWebhookRequest(t, ts, secret, body, t1)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}

	// GetUserByStripeCustomer's SELECT list doesn't include plan_started_at /
	// quota_accrued_bytes / quota_accrued_period (see its doc comment in
	// sqlite.go) — those three are always zero on the User it returns, which
	// is harmless for production (billing.go never reads them off that
	// particular call) but would silently make this assertion pass against
	// zero values instead of the real ones. Use GetUserByID, like every other
	// quota_proration_test.go assertion, to read the columns for real.
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.PlanID != "pro" {
		t.Fatalf("want plan pro, got %q", u.PlanID)
	}
	seg := t1 - t0
	want := plusCap/monthSecs*seg + (plusCap%monthSecs)*seg/monthSecs
	if u.QuotaAccruedBytes != want {
		t.Fatalf("quota_accrued_bytes = %d, want %d (frozen plus segment via webhook)", u.QuotaAccruedBytes, want)
	}
	if u.QuotaAccruedBytes == 0 {
		t.Fatal("a webhook-driven mid-month plan change must accrue a non-zero previous segment")
	}
	if u.PlanStartedAt != t1 {
		t.Fatalf("plan_started_at = %d, want %d", u.PlanStartedAt, t1)
	}
}

// TestWebhookSubscriptionDeletedAccruesPreviousSegment covers the spec's
// scenario table row "取消订阅 | subscription.deleted 降回 free，走同一路径":
// canceling mid-month must freeze the previous (paid) segment exactly like
// any other plan change, not just reset plan_id to free for free. Same
// HTTP-layer approach as the .updated test above.
func TestWebhookSubscriptionDeletedAccruesPreviousSegment(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_cancel_accrue"
	svc.biller = newWebhookFixtureClient(secret)
	proCap := int64(50) << 30
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, TrafficBytes: proCap, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "free", Name: "Free", Active: true, TrafficBytes: 1073741824})
	cookie := loginCookie(t, ts, mail, "webhook-cancel-accrue@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-cancel-accrue@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_cancel_accrue"); err != nil {
		t.Fatal(err)
	}

	monthStart, _, monthSecs := monthAt(t, "202604")
	t0 := monthStart
	svc.now = func() time.Time { return time.Unix(t0, 0) }
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 0, "stripe", "", t0, 0); err != nil {
		t.Fatal(err)
	}

	// Cancel a third of the way through the month.
	t1 := monthStart + monthSecs/3
	svc.now = func() time.Time { return time.Unix(t1, 0) }
	body := webhookEnv("customer.subscription.deleted", "cus_cancel_accrue", "sub_1", "", "canceled", "", 0)
	resp := signedWebhookRequest(t, ts, secret, body, t1)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}

	// See the .updated test above: GetUserByStripeCustomer doesn't select the
	// quota columns, so read them back via GetUserByID instead.
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.PlanID != "free" {
		t.Fatalf("want plan reverted to free after cancellation, got %q", u.PlanID)
	}
	seg := t1 - t0
	want := proCap/monthSecs*seg + (proCap%monthSecs)*seg/monthSecs
	if u.QuotaAccruedBytes != want {
		t.Fatalf("quota_accrued_bytes = %d, want %d (frozen pro segment on cancellation)", u.QuotaAccruedBytes, want)
	}
	if u.QuotaAccruedBytes == 0 {
		t.Fatal("cancelling mid-month must accrue a non-zero previous segment, not just drop plan_id to free for free")
	}
}

func TestWebhookCannotAttachStripeAuthorityToAdminGrant(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_admin"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "enterprise", Name: "Enterprise", Active: true})
	cookie := loginCookie(t, ts, mail, "webhook-admin@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-admin@example.com")
	// Admin comps this user onto "enterprise" — must survive a Stripe webhook
	// for an unrelated "pro" subscription.
	if err := store.SetUserPlanAdmin(context.Background(), uid, "enterprise", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	// Bind the customer only after the comp to model an unsolicited/legacy
	// Stripe event. Existing Stripe history correctly prevents creating an admin
	// comp in the first place, which is covered by the authority store tests.
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_admin_1"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_admin_1", "sub_1", "", "active", "price_pro_m", 1700002000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("want 500 so Stripe keeps the paid conflict visible, got %d", resp.StatusCode)
	}
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_admin_1")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer: ok=%v err=%v", ok, err)
	}
	if u.PlanID != "enterprise" {
		t.Fatalf("admin-comped plan must not be overridden, got %q", u.PlanID)
	}
	if u.PlanSource != "admin" {
		t.Fatalf("plan source must stay admin, got %q", u.PlanSource)
	}
	if u.SubscriptionStatus != "" {
		t.Fatalf("refused Stripe event partially wrote status %q", u.SubscriptionStatus)
	}
	if _, ok, err := store.GetSubscriptionSource(context.Background(), uid, ProviderStripe); err != nil || ok {
		t.Fatalf("refused Stripe event wrote source: ok=%v err=%v", ok, err)
	}
}

// TestWebhookAdminSourceNotOverriddenViaMetadata closes the seam the
// metadata-fallback fix (TestWebhookSubscriptionBeforeCheckoutUsesMetadata)
// left untested: an admin-comped user whose Stripe customer id is NOT yet
// bound, receiving a subscription event that carries metadata.user_id. The
// admin-source guard in billing.go's customer.subscription.updated branch
// must still win — plan_id must stay the admin-assigned plan — even when the
// user is resolved via the metadata fallback rather than the direct
// GetUserByStripeCustomer lookup.
func TestWebhookMetadataCannotHalfBindStripeToAdminGrant(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_admin_meta"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true, StripePriceMonthlyID: "price_plus_m"})
	cookie := loginCookie(t, ts, mail, "webhook-admin-meta@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-admin-meta@example.com")
	// Admin comps this user onto "pro" but the customer id is deliberately
	// left unbound (no checkout.session.completed / SetUserStripeCustomer
	// call), forcing the subscription event below to resolve the user via
	// the metadata.user_id fallback instead of the direct customer lookup.
	if err := store.SetUserPlanAdmin(context.Background(), uid, "pro", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}

	// "cus_admin_meta" is unbound; the price maps to "plus", a DIFFERENT plan
	// than the admin-comped "pro" — if the admin-source guard were skipped on
	// the metadata-fallback path, plan_id would incorrectly flip to "plus".
	body := webhookEnvWithMetadata("customer.subscription.updated", "cus_admin_meta", "sub_1", "", "active", "price_plus_m", 1700007000, uid)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("want 500 so Stripe retries the conflict, got %d", resp.StatusCode)
	}

	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.PlanID != "pro" {
		t.Fatalf("admin-comped plan must not be overridden via metadata fallback, got %q", u.PlanID)
	}
	if u.PlanSource != "admin" {
		t.Fatalf("plan source must stay admin, got %q", u.PlanSource)
	}
	if u.SubscriptionStatus != "" {
		t.Fatalf("refused Stripe event partially wrote status %q", u.SubscriptionStatus)
	}
	if u.StripeCustomerID != "" {
		t.Fatalf("refused Stripe event half-bound customer %q", u.StripeCustomerID)
	}
}

func TestWebhookUnknownCustomerIgnored200(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	secret := "whsec_unknown"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})

	body := webhookEnv("customer.subscription.updated", "cus_no_such_user", "sub_1", "", "active", "price_pro_m", 1700003000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 (ignore unknown customer), got %d", resp.StatusCode)
	}
}

// TestWebhookSubscriptionBeforeCheckoutUsesMetadata proves the out-of-order
// delivery fix in billing.go: Stripe doesn't guarantee that
// checkout.session.completed (which normally binds customer->user) arrives
// before the accompanying customer.subscription.* event. When the
// subscription event's customer id is not yet bound to any user, the handler
// must fall back to data.object.metadata.user_id (always present, since
// CreateCheckoutSession stamps subscription_data[metadata][user_id]) to bind
// the customer and assign the plan, rather than 200-ignoring and leaving a
// paying user on Free.
func TestWebhookSubscriptionBeforeCheckoutUsesMetadata(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_race"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	cookie := loginCookie(t, ts, mail, "webhook-race@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-race@example.com")
	// Deliberately do NOT bind the customer via checkout.session.completed:
	// "cus_new" is unknown to the store when the subscription event arrives.

	body := webhookEnvWithMetadata("customer.subscription.updated", "cus_new", "sub_1", "", "active", "price_pro_m", 1700006000, uid)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}

	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.PlanID != "pro" {
		t.Fatalf("want plan pro assigned via metadata fallback, got %q", u.PlanID)
	}
	if u.SubscriptionStatus != "active" {
		t.Fatalf("want status active, got %q", u.SubscriptionStatus)
	}
	if u.PlanSource != "stripe" {
		t.Fatalf("want source stripe, got %q", u.PlanSource)
	}
	if u.StripeCustomerID != "cus_new" {
		t.Fatalf("want stripe_customer_id bound to cus_new via metadata fallback, got %q", u.StripeCustomerID)
	}
}

// TestWebhookActiveSubscriptionForgedPriceRevertsToFree is the key
// anti-escalation test: a forged/unmapped Stripe price id combined with
// status="active" must NOT grant a paid plan. billing.go's
// customer.subscription.updated branch only escalates planID away from
// "free" when PlanByStripePrice resolves the event's price id to a known
// plan; an unresolved price leaves planID at its "free" default while still
// recording the reported status/end/source (so the admin console has
// visibility into the anomalous event) — see handleStripeWebhook's planID
// resolution block in billing.go.
func TestWebhookActiveSubscriptionForgedPriceRevertsToFree(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_forged_price"
	svc.biller = newWebhookFixtureClient(secret)
	if err := svc.SeedPlans(context.Background()); err != nil {
		t.Fatal(err)
	}
	cookie := loginCookie(t, ts, mail, "webhook-forged@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-forged@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_forge"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_forge", "sub_1", "", "active", "price_totally_unknown", 1700004000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_forge")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer: ok=%v err=%v", ok, err)
	}
	if u.PlanID != "free" {
		t.Fatalf("forged/unmapped price with active status must not escalate the plan, got %q", u.PlanID)
	}
	// billing.go still records status/end/source even when the price is
	// unresolved, so the anomalous event stays visible instead of being
	// silently dropped.
	if u.SubscriptionStatus != "active" {
		t.Fatalf("want status active recorded even though the price is unresolved, got %q", u.SubscriptionStatus)
	}
	if u.SubscriptionEnd != 1700004000 {
		t.Fatalf("want end 1700004000, got %d", u.SubscriptionEnd)
	}
	if u.PlanSource != "stripe" {
		t.Fatalf("want source stripe, got %q", u.PlanSource)
	}
}

// errWebhookCustomerStore wraps a real Store but forces
// GetUserByStripeCustomer to error, to prove handleStripeWebhook's
// customer.subscription.updated branch returns 500 on a genuine store error
// (rather than silently acking with 200 and dropping the event).
type errWebhookCustomerStore struct {
	Store
}

func (e errWebhookCustomerStore) GetUserByStripeCustomer(ctx context.Context, customerID string) (User, bool, error) {
	return User{}, false, context.DeadlineExceeded
}

func TestWebhookStoreErrorReturns500(t *testing.T) {
	realStore := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(errWebhookCustomerStore{realStore}, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	secret := "whsec_store_error"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, realStore, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})

	body := webhookEnv("customer.subscription.updated", "cus_store_err", "sub_1", "", "active", "price_pro_m", 1700005000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("want 500 on store error, got %d", resp.StatusCode)
	}
}

func TestWebhookUnknownEventTypeIgnored200(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_unknown_type"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	cookie := loginCookie(t, ts, mail, "webhook-unknowntype@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-unknowntype@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_unknown_type"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.trial_will_end", "cus_unknown_type", "sub_1", "", "trialing", "price_pro_m", 0)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 for unknown event type, got %d", resp.StatusCode)
	}
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), "cus_unknown_type")
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer: ok=%v err=%v", ok, err)
	}
	if u.PlanID != "" && u.PlanID != "free" {
		t.Fatalf("unknown event type must not change plan, got %q", u.PlanID)
	}
}

// dispatchedStripeCheckout logs a user in and leaves them holding exactly one
// dispatched Stripe attempt bound to sessionID — the state a real user is in
// while the Stripe-hosted Checkout page is open and nothing has been charged.
func dispatchedStripeCheckout(t *testing.T, ts *httptest.Server, store *SQLiteStore, mail *capturingMailer, email, sessionID string) (string, BillingPurchaseAttempt) {
	t.Helper()
	ctx := context.Background()
	loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{UserID: uid, Provider: ProviderStripe, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	attempt, _, err := store.DispatchBillingPurchase(ctx, authority, "price_pro_m", 101)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetBillingPurchaseProviderSession(ctx, uid, attempt.ID, sessionID, "https://checkout.stripe.test/"+sessionID); err != nil {
		t.Fatal(err)
	}
	return uid, attempt
}

// A Checkout that expires unpaid, or whose async payment fails, is delivered
// with this product's client_reference_id and billing_attempt_id metadata but,
// in these fixtures, no subscription on the event. With nothing to bind yet,
// the handler must acknowledge the observation and leave the attempt, plan and
// authority generation exactly as they were. The previous unconditional bind
// turned this into ErrBillingPurchaseAmbiguous → 500, and Stripe retried an
// event it could never satisfy until it gave up. A later event on the same
// session that does carry a subscription (an async payment succeeding after an
// earlier failure) still reaches the bind path through this same handler.
func TestAbandonedCheckoutObservationAcknowledgedWithoutBinding(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_abandoned_observation"
	svc.biller = newWebhookFixtureClient(secret)
	ctx := context.Background()
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	uid, attempt := dispatchedStripeCheckout(t, ts, store, mail, "abandoned-observation@example.test", "cs_abandoned")

	beforeAttempt := mustStripeAttemptRow(t, store, attempt.ID)
	beforeUser, err := store.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	beforeAuthority, ok, err := store.BillingAuthority(ctx, uid)
	if err != nil || !ok {
		t.Fatalf("authority ok=%v err=%v", ok, err)
	}

	for i, eventType := range []string{"checkout.session.expired", "checkout.session.async_payment_failed"} {
		body := fmt.Sprintf(`{"id":"evt_abandoned_%d","type":%q,"created":%d,"livemode":false,"data":{"object":{"id":"cs_abandoned","object":"checkout.session","customer":"cus_abandoned","client_reference_id":%q,"metadata":{"user_id":%q,"billing_attempt_id":%q}}}}`,
			i, eventType, 200+i, uid, uid, attempt.ID)
		resp := postWebhook(t, ts, secret, body)
		responseBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status=%d body=%s, want 200", eventType, resp.StatusCode, responseBody)
		}
		if got := mustStripeAttemptRow(t, store, attempt.ID); got != beforeAttempt {
			t.Fatalf("%s moved the attempt: %+v, want %+v", eventType, got, beforeAttempt)
		}
		u, err := store.GetUserByID(ctx, uid)
		if err != nil {
			t.Fatal(err)
		}
		if u.PlanID != beforeUser.PlanID || u.PlanSource != beforeUser.PlanSource ||
			u.SubscriptionStatus != beforeUser.SubscriptionStatus || u.StripeSubscriptionID != beforeUser.StripeSubscriptionID {
			t.Fatalf("%s changed entitlement: plan=%q source=%q status=%q sub=%q", eventType, u.PlanID, u.PlanSource, u.SubscriptionStatus, u.StripeSubscriptionID)
		}
		after, ok, err := store.BillingAuthority(ctx, uid)
		if err != nil || !ok || after.Epoch != beforeAuthority.Epoch || after.IntentID != beforeAuthority.IntentID {
			t.Fatalf("%s advanced the authority generation: %+v want %+v (ok=%v err=%v)", eventType, after, beforeAuthority, ok, err)
		}
	}
}

// The exemption above is keyed on the event TYPE together with an empty
// subscription, not on a generic "no subscription" check.
// checkout.session.completed and
// checkout.session.async_payment_succeeded assert a purchase: a missing
// subscription there is a real inconsistency between Stripe and this product,
// so the delivery must still fail loudly and stay visible in Stripe's retry
// queue rather than being silently acknowledged.
func TestPaidCheckoutWithoutSubscriptionStillFailsLoudly(t *testing.T) {
	t.Run("completed", func(t *testing.T) {
		ts, svc, store, mail := newBillingServer(t)
		secret := "whsec_completed_no_sub"
		svc.biller = newWebhookFixtureClient(secret)
		mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
		uid, attempt := dispatchedStripeCheckout(t, ts, store, mail, "completed-no-sub@example.test", "cs_completed_no_sub")
		body := fmt.Sprintf(`{"id":"evt_completed_no_sub","type":"checkout.session.completed","created":200,"livemode":false,"data":{"object":{"id":"cs_completed_no_sub","object":"checkout.session","customer":"cus_completed_no_sub","client_reference_id":%q,"metadata":{"billing_attempt_id":%q}}}}`, uid, attempt.ID)
		resp := postWebhook(t, ts, secret, body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("completed without subscription = %d, want 500", resp.StatusCode)
		}
	})

	t.Run("async_payment_succeeded", func(t *testing.T) {
		ts, svc, store, mail := newBillingServer(t)
		secret := "whsec_async_success_no_sub"
		mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
		uid, attempt := dispatchedStripeCheckout(t, ts, store, mail, "async-success-no-sub@example.test", "cs_async_no_sub")
		// A canonical payment chain that really did charge, yet names no
		// subscription: the money moved and the attempt cannot be bound.
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/v1/checkout/sessions/cs_async_no_sub":
				fmt.Fprintf(w, `{"id":"cs_async_no_sub","customer":"cus_async_no_sub","client_reference_id":%q,"payment_intent":"pi_async_no_sub","payment_status":"paid"}`, uid)
			case "/v1/payment_intents/pi_async_no_sub":
				io.WriteString(w, `{"id":"pi_async_no_sub","latest_charge":"ch_async_no_sub"}`)
			default:
				t.Errorf("unexpected canonical read: %s", r.URL.Path)
			}
		}))
		defer provider.Close()
		client := newWebhookFixtureClient(secret)
		client.base, client.http = provider.URL, provider.Client()
		svc.biller = client

		body := fmt.Sprintf(`{"id":"evt_async_success_no_sub","type":"checkout.session.async_payment_succeeded","created":200,"livemode":false,"data":{"object":{"id":"cs_async_no_sub","object":"checkout.session","customer":"cus_async_no_sub","client_reference_id":%q,"payment_status":"paid","metadata":{"billing_attempt_id":%q}}}}`, uid, attempt.ID)
		resp := postWebhook(t, ts, secret, body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("async success without subscription = %d, want 500", resp.StatusCode)
		}
	})
}

// Stripe does not order webhook deliveries. When customer.subscription.* wins
// the race, ApplyAuthorizedStripeLifecycle already moves this exact attempt to
// 'resolved' with this exact subscription; the checkout.session.completed that
// follows then finds nothing in 'dispatched'. That is the same purchase
// arriving twice, not an ambiguous one, so the later delivery — and any
// redelivery of it — must be idempotent success rather than a permanent 500.
func TestCompletedCheckoutAfterSubscriptionResolvedAttemptIsIdempotent(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_sub_first"
	svc.biller = newWebhookFixtureClient(secret)
	ctx := context.Background()
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	uid, attempt := dispatchedStripeCheckout(t, ts, store, mail, "sub-first@example.test", "cs_sub_first")
	beforeAuthority, _, err := store.BillingAuthority(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}

	subscriptionBody := fmt.Sprintf(`{"id":"evt_sub_first","type":"customer.subscription.updated","created":200,"livemode":false,"data":{"object":{"id":"sub_first","object":"subscription","customer":"cus_sub_first","status":"active","current_period_end":9999,"metadata":{"user_id":%q,"billing_attempt_id":%q},"items":{"data":[{"price":{"id":"price_pro_m"}}]}}}}`, uid, attempt.ID)
	resp := postWebhook(t, ts, secret, subscriptionBody)
	responseBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("subscription-first status=%d body=%s", resp.StatusCode, responseBody)
	}
	resolved := mustStripeAttemptRow(t, store, attempt.ID)
	if resolved.State != "resolved" || resolved.ProviderSubscriptionID != "sub_first" {
		t.Fatalf("subscription-first did not resolve the attempt: %+v", resolved)
	}

	// Two deliveries with distinct event ids: the first is the out-of-order
	// completed event, the second a redelivery of the same fact. Distinct ids
	// keep both from being short-circuited by the webhook ledger, so each one
	// actually reaches the binder.
	for i := 0; i < 2; i++ {
		body := fmt.Sprintf(`{"id":"evt_completed_after_sub_%d","type":"checkout.session.completed","created":%d,"livemode":false,"data":{"object":{"id":"cs_sub_first","object":"checkout.session","customer":"cus_sub_first","subscription":"sub_first","client_reference_id":%q,"metadata":{"billing_attempt_id":%q}}}}`,
			i, 201+i, uid, attempt.ID)
		resp := postWebhook(t, ts, secret, body)
		responseBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("completed delivery %d status=%d body=%s, want 200", i, resp.StatusCode, responseBody)
		}
		if got := mustStripeAttemptRow(t, store, attempt.ID); got != resolved {
			t.Fatalf("completed delivery %d moved the resolved attempt: %+v want %+v", i, got, resolved)
		}
	}

	u, err := store.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.PlanID != "pro" || u.StripeSubscriptionID != "sub_first" {
		t.Fatalf("purchase did not land: plan=%q subscription=%q", u.PlanID, u.StripeSubscriptionID)
	}
	after, _, err := store.BillingAuthority(ctx, uid)
	if err != nil || after.Epoch != beforeAuthority.Epoch {
		t.Fatalf("idempotent replay advanced the authority generation: %+v want epoch %d (err=%v)", after, beforeAuthority.Epoch, err)
	}
}
