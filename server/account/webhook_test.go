package account

import (
	"context"
	"crypto/sha256"
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
	svc.biller = NewStripeClient("sk_test", secret, "")
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
	svc.biller = NewStripeClient("sk_test", secret, "")
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
	svc.biller = NewStripeClient("sk_test", secret, "")
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
	svc.biller = NewStripeClient("sk_test", secret, "")
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
	if err := store.SetUserPlanAdmin(context.Background(), uid, "enterprise", time.Now().Unix()); err != nil {
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

// TestWebhookAdminSourceNotOverriddenViaMetadata closes the seam the
// metadata-fallback fix (TestWebhookSubscriptionBeforeCheckoutUsesMetadata)
// left untested: an admin-comped user whose Stripe customer id is NOT yet
// bound, receiving a subscription event that carries metadata.user_id. The
// admin-source guard in billing.go's customer.subscription.updated branch
// must still win — plan_id must stay the admin-assigned plan — even when the
// user is resolved via the metadata fallback rather than the direct
// GetUserByStripeCustomer lookup.
func TestWebhookAdminSourceNotOverriddenViaMetadata(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_admin_meta"
	svc.biller = NewStripeClient("sk_test", secret, "")
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
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
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
	if u.SubscriptionStatus != "active" {
		t.Fatalf("status should still record, got %q", u.SubscriptionStatus)
	}
	// handleStripeWebhook's metadata-fallback branch calls
	// SetUserStripeCustomer to bind the customer BEFORE the
	// u.PlanSource == "admin" check runs (see billing.go), so the customer id
	// does get bound even though the plan assignment itself is guarded.
	if u.StripeCustomerID != "cus_admin_meta" {
		t.Fatalf("want stripe_customer_id bound to cus_admin_meta via metadata fallback even for an admin-comped user, got %q", u.StripeCustomerID)
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
	svc.biller = NewStripeClient("sk_test", secret, "")
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
	svc.biller = NewStripeClient("sk_test", secret, "")
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
	svc.biller = NewStripeClient("sk_test", secret, "")
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
