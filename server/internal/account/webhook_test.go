package account

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// webhookEnv builds a minimal Stripe event envelope JSON body matching the
// fields VerifyWebhook parses (see stripe.go's envelope struct).
func webhookEnv(eventType, customer, subscription, clientRefUserID, status, priceID string, currentPeriodEnd int64) string {
	items := "null"
	if priceID != "" {
		items = fmt.Sprintf(`{"data":[{"price":{"id":%q}}]}`, priceID)
	}
	return fmt.Sprintf(`{"type":%q,"data":{"object":{"customer":%q,"subscription":%q,"client_reference_id":%q,"status":%q,"current_period_end":%d,"items":%s}}}`,
		eventType, customer, subscription, clientRefUserID, status, currentPeriodEnd, items)
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
	svc.biller = NewStripeClient("sk_test", "whsec_real", "")
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
	svc.biller = NewStripeClient("sk_test", secret, "")
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

func TestWebhookSubscriptionUpdatedActiveAssignsPlan(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_sub_active"
	svc.biller = NewStripeClient("sk_test", secret, "")
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

func TestWebhookSubscriptionUpdatedPastDueRevertsToFree(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_sub_pastdue"
	svc.biller = NewStripeClient("sk_test", secret, "")
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "free", Name: "Free", Active: true})
	cookie := loginCookie(t, ts, mail, "webhook-pastdue@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-pastdue@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_pastdue_1"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 1700000000, "stripe"); err != nil {
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
	if u.PlanID != "free" {
		t.Fatalf("want plan reverted to free, got %q", u.PlanID)
	}
	if u.SubscriptionStatus != "past_due" {
		t.Fatalf("want status past_due, got %q", u.SubscriptionStatus)
	}
}

func TestWebhookSubscriptionDeletedRevertsToFreeCanceled(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_sub_deleted"
	svc.biller = NewStripeClient("sk_test", secret, "")
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "free", Name: "Free", Active: true})
	cookie := loginCookie(t, ts, mail, "webhook-deleted@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-deleted@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_deleted_1"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 1700000000, "stripe"); err != nil {
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

func TestWebhookAdminSourceNotOverridden(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_admin"
	svc.biller = NewStripeClient("sk_test", secret, "")
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "enterprise", Name: "Enterprise", Active: true})
	cookie := loginCookie(t, ts, mail, "webhook-admin@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-admin@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_admin_1"); err != nil {
		t.Fatal(err)
	}
	// Admin comps this user onto "enterprise" — must survive a Stripe webhook
	// for an unrelated "pro" subscription.
	if err := store.SetUserPlanAdmin(context.Background(), uid, "enterprise"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_admin_1", "sub_1", "", "active", "price_pro_m", 1700002000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
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
	if u.SubscriptionStatus != "active" {
		t.Fatalf("status should still record, got %q", u.SubscriptionStatus)
	}
}

func TestWebhookUnknownCustomerIgnored200(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	secret := "whsec_unknown"
	svc.biller = NewStripeClient("sk_test", secret, "")
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})

	body := webhookEnv("customer.subscription.updated", "cus_no_such_user", "sub_1", "", "active", "price_pro_m", 1700003000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 (ignore unknown customer), got %d", resp.StatusCode)
	}
}

func TestWebhookUnknownEventTypeIgnored200(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_unknown_type"
	svc.biller = NewStripeClient("sk_test", secret, "")
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
