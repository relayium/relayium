package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Cross-provider safeguards on the billing HTTP surface. Apple cannot yet be
// PURCHASED (no StoreKit in this batch), which is precisely why these must
// land first: the day an Apple entitlement can exist, none of the Stripe paths
// may be reachable by the account that holds it.

// appleSubscriber makes an existing user look like a live Apple subscriber
// with no Stripe relationship whatsoever.
func appleSubscriber(t *testing.T, store *SQLiteStore, uid, planID string) {
	t.Helper()
	if _, err := store.ApplySubscriptionSource(context.Background(), SourceEvent{
		UserID: uid, Provider: ProviderApple, PlanID: planID, Status: "active",
		Cycle: "monthly", PeriodEnd: 1_900_000_000, EventAt: 100, Now: time.Now().Unix(),
	}); err != nil {
		t.Fatalf("ApplySubscriptionSource(apple): %v", err)
	}
}

func postBilling(t *testing.T, ts *httptest.Server, cookie *http.Cookie, path, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+path, strings.NewReader(body))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func decodeErrBody(t *testing.T, resp *http.Response) map[string]string {
	t.Helper()
	var out map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return out
}

func TestCheckoutBlockedByLiveAppleEntitlement(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/x"}
	svc.biller = fb
	seedTiers(t, store)
	email := "apple-live-checkout@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	appleSubscriber(t, store, uid, "pro")

	resp := postBilling(t, ts, cookie, "/api/billing/checkout", `{"planId":"max","cycle":"monthly"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("want 409 for a live Apple entitlement, got %d", resp.StatusCode)
	}
	body := decodeErrBody(t, resp)
	if body["error"] != "already_subscribed" {
		t.Fatalf("want already_subscribed, got %q", body["error"])
	}
	if body["provider"] != ProviderApple {
		t.Fatalf("want apple attribution, got %q", body["provider"])
	}
	if fb.ensureCalls != 0 {
		t.Fatalf("Stripe customer was created for an Apple-only user (%d calls)", fb.ensureCalls)
	}
	if fb.lastCheckout.PriceID != "" {
		t.Fatalf("a Checkout Session was created for an Apple-only user: %+v", fb.lastCheckout)
	}
}

// The pre-existing Stripe 409 keeps its meaning and gains attribution.
func TestCheckoutBlockedByLiveStripeSubscriptionKeepsAttribution(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = &fakeBiller{checkoutURL: "https://checkout.stripe.com/x"}
	seedTiers(t, store)
	email := "stripe-live-checkout@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUser(t, store, mustUserID(t, store, email), "cus_live", "pro")

	resp := postBilling(t, ts, cookie, "/api/billing/checkout", `{"planId":"max","cycle":"monthly"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("want 409, got %d", resp.StatusCode)
	}
	body := decodeErrBody(t, resp)
	if body["error"] != "already_subscribed" || body["provider"] != ProviderStripe {
		t.Fatalf("want already_subscribed/stripe, got %+v", body)
	}
}

// Every Stripe management path must refuse an Apple-only account WITHOUT
// calling Stripe, and without telling the client to go and buy a second
// subscription.
func TestAppleOnlyUserNeverReachesStripeManagementPaths(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/x", portalURL: "https://portal"}
	svc.biller = fb
	seedTiers(t, store)
	email := "apple-only-mgmt@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	appleSubscriber(t, store, uid, "pro")

	for _, tc := range []struct {
		path, body string
		wantStatus int
		wantErr    string
	}{
		{"/api/billing/change-plan", `{"planId":"max","cycle":"monthly"}`, http.StatusConflict, "managed_by_provider"},
		{"/api/billing/preview", `{"planId":"max","cycle":"monthly"}`, http.StatusConflict, "managed_by_provider"},
		{"/api/billing/cancel-scheduled-change", ``, http.StatusConflict, "managed_by_provider"},
	} {
		resp := postBilling(t, ts, cookie, tc.path, tc.body)
		if resp.StatusCode != tc.wantStatus {
			resp.Body.Close()
			t.Fatalf("%s: want %d, got %d", tc.path, tc.wantStatus, resp.StatusCode)
		}
		body := decodeErrBody(t, resp)
		resp.Body.Close()
		if body["error"] != tc.wantErr {
			t.Fatalf("%s: want %q, got %q", tc.path, tc.wantErr, body["error"])
		}
		if body["provider"] != ProviderApple {
			t.Fatalf("%s: want apple attribution, got %q", tc.path, body["provider"])
		}
	}
	// The portal is refused for the same reason and with the same contract as
	// the three above — NOT with the 404 that "no Stripe customer" would
	// otherwise produce, which would make the answer depend on whether a
	// historical customer record happens to linger. See
	// TestPortalRefusedForAppleEntitlementWithHistoricalStripeCustomer.
	resp := postBilling(t, ts, cookie, "/api/billing/portal", ``)
	if resp.StatusCode != http.StatusConflict {
		resp.Body.Close()
		t.Fatalf("portal: want 409 for an Apple-only user, got %d", resp.StatusCode)
	}
	portalBody := decodeErrBody(t, resp)
	resp.Body.Close()
	if portalBody["error"] != "managed_by_provider" || portalBody["provider"] != ProviderApple {
		t.Fatalf("portal: want managed_by_provider/apple, got %+v", portalBody)
	}

	if fb.changeCalls+fb.downgradeCalls+fb.releaseCalls+fb.previewCalls+fb.listSubsCalls+fb.ensureCalls+fb.portalCalls != 0 {
		t.Fatalf("an Apple-only user reached Stripe: %+v", *fb)
	}
	if len(fb.canceledSubs) != 0 {
		t.Fatalf("an Apple-only user triggered a Stripe cancel/refund: %v", fb.canceledSubs)
	}
}

// The Billing Portal is the one Stripe management surface whose own guard
// (`has a Stripe customer`) can be satisfied by an account Stripe no longer
// bills: a user who paid by card once, canceled, and later subscribed on the
// App Store still carries stripe_customer_id forever. Opening the portal for
// them shows another provider's subscriber a Stripe cancel/update surface that
// governs nothing they hold — and, from the "no subscription here" fallback,
// routes them straight into buying a second one.
func TestPortalRefusedForAppleEntitlementWithHistoricalStripeCustomer(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{portalURL: "https://portal"}
	svc.biller = fb
	seedTiers(t, store)
	email := "apple-historical-customer@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	// The residue of a long-dead card subscription: a customer id and nothing
	// else. No live Stripe source row — the entitlement is Apple's alone.
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_historical"); err != nil {
		t.Fatal(err)
	}
	appleSubscriber(t, store, uid, "pro")

	resp := postBilling(t, ts, cookie, "/api/billing/portal", ``)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("want 409, got %d", resp.StatusCode)
	}
	body := decodeErrBody(t, resp)
	if body["error"] != "managed_by_provider" || body["provider"] != ProviderApple {
		t.Fatalf("want managed_by_provider/apple, got %+v", body)
	}
	if fb.portalCalls != 0 {
		t.Fatalf("Stripe was asked for a portal session for an Apple entitlement (%d calls)", fb.portalCalls)
	}
}

// A dual subscriber has a live Stripe subscription AND a live Apple one. The
// portal is real for the Stripe half, but opening it presents a cancel button
// that would leave the Apple subscription — and the charges — untouched while
// telling the user they cancelled. The honest answer names both.
func TestPortalRefusedForDualProviderSubscriber(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{portalURL: "https://portal"}
	svc.biller = fb
	seedTiers(t, store)
	email := "dual-portal@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	subscribeUser(t, store, uid, "cus_dual_portal", "plus")
	appleSubscriber(t, store, uid, "pro")

	resp := postBilling(t, ts, cookie, "/api/billing/portal", ``)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("want 409, got %d", resp.StatusCode)
	}
	body := decodeErrBody(t, resp)
	if body["error"] != "managed_by_provider" || body["provider"] != ProviderMultiple {
		t.Fatalf("want managed_by_provider/multiple, got %+v", body)
	}
	if fb.portalCalls != 0 {
		t.Fatalf("Stripe was asked for a portal session for a dual subscriber (%d calls)", fb.portalCalls)
	}
}

// The ordinary Stripe portal is untouched by the guard above: a Stripe-only
// subscriber still gets their session, and an account with no customer at all
// still gets the pre-existing 404 rather than a provider conflict.
func TestPortalStillWorksForStripeOnlySubscriber(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{portalURL: "https://portal.example/session"}
	svc.biller = fb
	seedTiers(t, store)
	email := "stripe-portal-ok@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUser(t, store, mustUserID(t, store, email), "cus_portal_ok", "pro")

	resp := postBilling(t, ts, cookie, "/api/billing/portal", ``)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 for a Stripe-only subscriber, got %d", resp.StatusCode)
	}
	var out map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out["url"] != "https://portal.example/session" {
		t.Fatalf("portal url = %q", out["url"])
	}
	if fb.portalCalls != 1 || fb.lastPortalCustomer != "cus_portal_ok" {
		t.Fatalf("portal calls=%d customer=%q", fb.portalCalls, fb.lastPortalCustomer)
	}

	// No customer at all → the pre-existing 404, not a provider conflict.
	freeCookie := loginCookie(t, ts, mail, "no-customer-portal@example.com")
	fresp := postBilling(t, ts, freeCookie, "/api/billing/portal", ``)
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404 for an account with no Stripe customer, got %d", fresp.StatusCode)
	}
}

// liveProvidersErrStore wraps a real store but fails the ONE lookup that
// decides which provider owns the entitlement, to prove the read endpoints
// refuse rather than answering "no provider".
type liveProvidersErrStore struct {
	Store
}

func (liveProvidersErrStore) LiveEntitlementProviders(ctx context.Context, userID string) ([]string, error) {
	return nil, context.DeadlineExceeded
}

// entitlementProvider drives whether the client offers "Subscribe" / "Manage
// billing" at all. Degrading a failed lookup to "" is not a harmless default:
// it is exactly the value a FREE account sends, so an Apple subscriber would be
// shown a Subscribe call-to-action and could buy a second subscription. A 500
// makes the client retry with no state to act on.
func TestMeFailsClosedWhenProviderLookupFails(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = &fakeBiller{}
	seedTiers(t, store)
	email := "me-provider-error@example.com"
	cookie := loginCookie(t, ts, mail, email)
	appleSubscriber(t, store, mustUserID(t, store, email), "pro")
	svc.store = liveProvidersErrStore{Store: store}

	for _, path := range []string{"/api/me", "/api/me/usage"} {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		req.AddCookie(cookie)
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("%s: want 500 when the provider lookup fails, got %d (%s)", path, resp.StatusCode, raw)
		}
		if strings.Contains(string(raw), "entitlementProvider") {
			t.Fatalf("%s: emitted a billing-management state it could not determine: %s", path, raw)
		}
	}
}

// The reconcile sweep is a Stripe-only mechanism: it lists, cancels and refunds
// Stripe subscriptions. An Apple entitlement must never be one of its inputs.
func TestReconcileSweepIgnoresAppleEntitlements(t *testing.T) {
	_, svc, store, _ := newBillingServer(t)
	fb := &fakeBiller{}
	svc.biller = fb
	seedTiers(t, store)
	ctx := context.Background()

	appleOnly, err := store.UpsertUserByEmail(ctx, "sweep-apple@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	appleSubscriber(t, store, appleOnly.ID, "max")

	svc.ReconcileStripeSubscriptions(ctx)
	if fb.listSubsCalls != 0 {
		t.Fatalf("the sweep queried Stripe for an Apple-only user (%d calls)", fb.listSubsCalls)
	}
	got, err := store.GetUserByID(ctx, appleOnly.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PlanID != "max" || got.PlanSource != ProviderApple {
		t.Fatalf("the sweep downgraded an Apple entitlement: plan=%q source=%q", got.PlanID, got.PlanSource)
	}
}

// A user who holds BOTH a live Stripe subscription and a live Apple one is
// still swept for Stripe (their Stripe subscription is real and may vanish),
// but the sweep must not reduce the effective entitlement below Apple's.
func TestReconcileSweepStillCoversStripeSideOfADualSubscriber(t *testing.T) {
	_, svc, store, _ := newBillingServer(t)
	fb := &fakeBiller{} // no active subs → the sweep treats Stripe as gone
	svc.biller = fb
	seedTiers(t, store)
	ctx := context.Background()

	dual, err := store.UpsertUserByEmail(ctx, "sweep-dual@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeCustomer(ctx, dual.ID, "cus_dual"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(ctx, dual.ID, "plus", "active", 1_900_000_000, "stripe", "monthly", 1_700_000_000, 100); err != nil {
		t.Fatal(err)
	}
	appleSubscriber(t, store, dual.ID, "pro")

	svc.ReconcileStripeSubscriptions(ctx)
	if fb.listSubsCalls != 1 {
		t.Fatalf("want exactly one Stripe list for the dual subscriber, got %d", fb.listSubsCalls)
	}
	got, err := store.GetUserByID(ctx, dual.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PlanID != "pro" || got.PlanSource != ProviderApple {
		t.Fatalf("Stripe's disappearance dropped the live Apple entitlement: plan=%q source=%q", got.PlanID, got.PlanSource)
	}
	stripeRow, ok, err := store.GetSubscriptionSource(ctx, dual.ID, ProviderStripe)
	if err != nil || !ok {
		t.Fatalf("stripe row: ok=%v err=%v", ok, err)
	}
	if stripeRow.PlanID != "free" || stripeRow.Status != "canceled" {
		t.Fatalf("the sweep did not record Stripe's own end state: %+v", stripeRow)
	}
}

// /api/me and /api/me/usage report which provider the entitlement comes from,
// without changing what hasBilling has always meant (a Stripe customer, i.e.
// whether the Billing Portal is reachable).
func TestMeReportsEntitlementProvider(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = &fakeBiller{}
	seedTiers(t, store)
	email := "me-provider@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	appleSubscriber(t, store, uid, "pro")

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var me struct {
		User map[string]any `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	if me.User["entitlementProvider"] != ProviderApple {
		t.Fatalf("want apple, got %v", me.User["entitlementProvider"])
	}
	if me.User["hasBilling"] != false {
		t.Fatalf("hasBilling must stay Stripe-customer-only, got %v", me.User["hasBilling"])
	}
	if me.User["planId"] != "pro" {
		t.Fatalf("want the effective plan on /api/me, got %v", me.User["planId"])
	}

	ureq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/me/usage", nil)
	ureq.AddCookie(cookie)
	uresp, err := ts.Client().Do(ureq)
	if err != nil {
		t.Fatal(err)
	}
	defer uresp.Body.Close()
	var usage struct {
		Plan map[string]any `json:"plan"`
	}
	if err := json.NewDecoder(uresp.Body).Decode(&usage); err != nil {
		t.Fatal(err)
	}
	if usage.Plan["entitlementProvider"] != ProviderApple {
		t.Fatalf("usage: want apple, got %v", usage.Plan["entitlementProvider"])
	}
}

func TestMeReportsMultipleProviderState(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = &fakeBiller{}
	seedTiers(t, store)
	email := "me-multi@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	subscribeUser(t, store, uid, "cus_multi", "plus")
	appleSubscriber(t, store, uid, "pro")

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var me struct {
		User map[string]any `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	if me.User["entitlementProvider"] != ProviderMultiple {
		t.Fatalf("want multiple, got %v", me.User["entitlementProvider"])
	}
	if me.User["hasBilling"] != true {
		t.Fatalf("a dual subscriber still has a Stripe customer: %v", me.User["hasBilling"])
	}
}

// A free account reports no provider at all, and the field must be absent-safe
// (empty string) rather than a made-up default.
func TestMeReportsNoProviderForFreeAccount(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = &fakeBiller{}
	seedTiers(t, store)
	cookie := loginCookie(t, ts, mail, "me-free@example.com")

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var me struct {
		User map[string]any `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		t.Fatal(err)
	}
	if me.User["entitlementProvider"] != "" {
		t.Fatalf("want empty provider for a free account, got %v", me.User["entitlementProvider"])
	}
}
