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

// fakeBiller is a Biller test double: it records the last CreateCheckoutSession
// input and CreatePortalSession customer id, and returns canned URLs so
// handlers can be exercised without touching the network.
type fakeBiller struct {
	checkoutURL string
	portalURL   string

	lastCheckout       CheckoutInput
	lastPortalCustomer string
}

func (f *fakeBiller) CreateCheckoutSession(ctx context.Context, in CheckoutInput) (string, error) {
	f.lastCheckout = in
	return f.checkoutURL, nil
}

func (f *fakeBiller) CreatePortalSession(ctx context.Context, customerID, returnURL string) (string, error) {
	f.lastPortalCustomer = customerID
	return f.portalURL, nil
}

func (f *fakeBiller) VerifyWebhook(payload []byte, sigHeader string, now int64) (WebhookEvent, error) {
	return WebhookEvent{}, nil
}

// newBillingServer builds an account server (magic-link auth, no billing
// configured by default) for billing endpoint tests. Callers set
// svc.biller directly to simulate Stripe being configured.
func newBillingServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute,
		EnableMagic: true,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, svc, store, mail
}

// mustPlan upserts a plan row, failing the test on error.
func mustPlan(t *testing.T, store *SQLiteStore, p Plan) {
	t.Helper()
	if err := store.UpsertPlan(context.Background(), p); err != nil {
		t.Fatalf("UpsertPlan(%s): %v", p.ID, err)
	}
}

func TestBillingCheckoutUnconfigured404(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_monthly"})
	cookie := loginCookie(t, ts, mail, "checkout-unconfigured@example.com")

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout",
		strings.NewReader(`{"planId":"pro","cycle":"monthly"}`))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404 when biller unconfigured, got %d", resp.StatusCode)
	}
}

func TestBillingCheckoutUnmappedPlan400(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/x"}
	svc.biller = fb
	// "free" plan has no Stripe price ids at all.
	mustPlan(t, store, Plan{ID: "free", Name: "Free", Active: true})
	cookie := loginCookie(t, ts, mail, "checkout-unmapped@example.com")

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout",
		strings.NewReader(`{"planId":"free","cycle":"monthly"}`))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for unpurchasable plan, got %d", resp.StatusCode)
	}
}

func TestBillingCheckoutUnknownPlan404(t *testing.T) {
	ts, svc, _, mail := newBillingServer(t)
	svc.biller = &fakeBiller{checkoutURL: "https://checkout.stripe.com/x"}
	cookie := loginCookie(t, ts, mail, "checkout-unknown@example.com")

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout",
		strings.NewReader(`{"planId":"does-not-exist","cycle":"monthly"}`))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404 for unknown plan, got %d", resp.StatusCode)
	}
}

func TestBillingCheckoutHappyPath(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/session123"}
	svc.biller = fb
	mustPlan(t, store, Plan{
		ID: "pro", Name: "Pro", Active: true,
		StripePriceMonthlyID: "price_monthly_pro",
		StripePriceYearlyID:  "price_yearly_pro",
	})
	email := "checkout-happy@example.com"
	cookie := loginCookie(t, ts, mail, email)

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout",
		strings.NewReader(`{"planId":"pro","cycle":"monthly"}`))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.URL != fb.checkoutURL {
		t.Fatalf("want url %q, got %q", fb.checkoutURL, out.URL)
	}
	if fb.lastCheckout.PriceID != "price_monthly_pro" {
		t.Fatalf("want monthly price id, got %q", fb.lastCheckout.PriceID)
	}
	if fb.lastCheckout.CustomerEmail != email {
		t.Fatalf("want customer email %q, got %q", email, fb.lastCheckout.CustomerEmail)
	}
	if fb.lastCheckout.ClientRefUserID == "" {
		t.Fatal("want non-empty ClientRefUserID")
	}
	if fb.lastCheckout.SuccessURL != "http://example.test/?billing=success" {
		t.Fatalf("unexpected success url %q", fb.lastCheckout.SuccessURL)
	}
	if fb.lastCheckout.CancelURL != "http://example.test/?billing=cancel" {
		t.Fatalf("unexpected cancel url %q", fb.lastCheckout.CancelURL)
	}
}

func TestBillingCheckoutYearlyCycle(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/session456"}
	svc.biller = fb
	mustPlan(t, store, Plan{
		ID: "pro", Name: "Pro", Active: true,
		StripePriceMonthlyID: "price_monthly_pro",
		StripePriceYearlyID:  "price_yearly_pro",
	})
	cookie := loginCookie(t, ts, mail, "checkout-yearly@example.com")

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout",
		strings.NewReader(`{"planId":"pro","cycle":"yearly"}`))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if fb.lastCheckout.PriceID != "price_yearly_pro" {
		t.Fatalf("want yearly price id, got %q", fb.lastCheckout.PriceID)
	}
}

func TestBillingPortalUnconfigured404(t *testing.T) {
	ts, _, _, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "portal-unconfigured@example.com")

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/portal", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404 when biller unconfigured, got %d", resp.StatusCode)
	}
}

func TestBillingPortalNoCustomerID404(t *testing.T) {
	ts, svc, _, mail := newBillingServer(t)
	svc.biller = &fakeBiller{portalURL: "https://billing.stripe.com/p/x"}
	cookie := loginCookie(t, ts, mail, "portal-nocust@example.com")

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/portal", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404 without stripe_customer_id, got %d", resp.StatusCode)
	}
}

func TestBillingPortalHappyPath(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{portalURL: "https://billing.stripe.com/p/session789"}
	svc.biller = fb
	email := "portal-happy@example.com"
	cookie := loginCookie(t, ts, mail, email)

	user, ok, err := store.GetUserByIdentity(context.Background(), "email", email)
	if err != nil || !ok {
		t.Fatalf("GetUserByIdentity: ok=%v err=%v", ok, err)
	}
	uid := user.ID
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_123"); err != nil {
		t.Fatalf("SetUserStripeCustomer: %v", err)
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/portal", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.URL != fb.portalURL {
		t.Fatalf("want url %q, got %q", fb.portalURL, out.URL)
	}
	if fb.lastPortalCustomer != "cus_123" {
		t.Fatalf("want customer id cus_123, got %q", fb.lastPortalCustomer)
	}
}

func TestPublicPlansPurchasableFlags(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	mustPlan(t, store, Plan{
		ID: "free", Name: "Free", Active: true, SortOrder: 0,
		StorageBytes: 1 << 30, TrafficBytes: 1 << 30, RetentionSecs: 3600,
	})
	mustPlan(t, store, Plan{
		ID: "pro", Name: "Pro", Active: true, SortOrder: 1,
		StorageBytes: 100 << 30, TrafficBytes: 100 << 30, RetentionSecs: 86400,
		PriceMonthly: 999, PriceYearly: 9990,
		StripePriceMonthlyID: "price_monthly_pro", StripePriceYearlyID: "price_yearly_pro",
	})
	mustPlan(t, store, Plan{ID: "hidden", Name: "Hidden", Active: false})

	// biller nil: nothing purchasable, even for the mapped plan.
	resp, err := ts.Client().Get(ts.URL + "/api/plans")
	if err != nil {
		t.Fatal(err)
	}
	var plans []struct {
		ID                 string `json:"id"`
		Name               string `json:"name"`
		StorageBytes       int64  `json:"storageBytes"`
		TrafficBytes       int64  `json:"trafficBytes"`
		RetentionSecs      int64  `json:"retentionSecs"`
		PriceMonthly       int64  `json:"priceMonthly"`
		PriceYearly        int64  `json:"priceYearly"`
		PurchasableMonthly bool   `json:"purchasableMonthly"`
		PurchasableYearly  bool   `json:"purchasableYearly"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&plans); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if len(plans) != 2 {
		t.Fatalf("want 2 active plans, got %d: %+v", len(plans), plans)
	}
	for _, p := range plans {
		if p.ID == "hidden" {
			t.Fatal("inactive plan must be excluded")
		}
		if p.PurchasableMonthly || p.PurchasableYearly {
			t.Fatalf("plan %s purchasable without a configured biller", p.ID)
		}
	}

	// biller set: only "pro" (has price ids) is purchasable.
	svc.biller = &fakeBiller{}
	resp2, err := ts.Client().Get(ts.URL + "/api/plans")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var plans2 []struct {
		ID                 string `json:"id"`
		PurchasableMonthly bool   `json:"purchasableMonthly"`
		PurchasableYearly  bool   `json:"purchasableYearly"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&plans2); err != nil {
		t.Fatal(err)
	}
	byID := map[string]struct{ M, Y bool }{}
	for _, p := range plans2 {
		byID[p.ID] = struct{ M, Y bool }{p.PurchasableMonthly, p.PurchasableYearly}
	}
	if !byID["pro"].M || !byID["pro"].Y {
		t.Fatalf("pro should be purchasable both cycles once biller is configured: %+v", byID)
	}
	if byID["free"].M || byID["free"].Y {
		t.Fatalf("free has no price ids, must stay unpurchasable: %+v", byID)
	}
}

// No secrets (Stripe price ids) leak in the public plans payload.
func TestPublicPlansNoSecrets(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	svc.biller = &fakeBiller{}
	mustPlan(t, store, Plan{
		ID: "pro", Name: "Pro", Active: true,
		StripePriceMonthlyID: "price_super_secret_monthly",
		StripePriceYearlyID:  "price_super_secret_yearly",
	})
	resp, err := ts.Client().Get(ts.URL + "/api/plans")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	if strings.Contains(body, "price_super_secret") {
		t.Fatalf("stripe price ids leaked in public plans response: %s", body)
	}
}

func TestMeIncludesBillingFields(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true})
	email := "me-billing@example.com"
	cookie := loginCookie(t, ts, mail, email)

	user, ok, err := store.GetUserByIdentity(context.Background(), "email", email)
	if err != nil || !ok {
		t.Fatalf("GetUserByIdentity: ok=%v err=%v", ok, err)
	}
	uid := user.ID
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "active", 1234567890, "stripe"); err != nil {
		t.Fatalf("SetUserSubscription: %v", err)
	}
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_me_123"); err != nil {
		t.Fatalf("SetUserStripeCustomer: %v", err)
	}

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	userJSON, ok := out["user"].(map[string]any)
	if !ok {
		t.Fatalf("no user object in /api/me response: %+v", out)
	}
	if userJSON["planId"] != "pro" {
		t.Fatalf("want planId pro, got %v", userJSON["planId"])
	}
	if userJSON["subscriptionStatus"] != "active" {
		t.Fatalf("want subscriptionStatus active, got %v", userJSON["subscriptionStatus"])
	}
	end, _ := userJSON["subscriptionEnd"].(float64)
	if int64(end) != 1234567890 {
		t.Fatalf("want subscriptionEnd 1234567890, got %v", userJSON["subscriptionEnd"])
	}
	if userJSON["hasBilling"] != true {
		t.Fatalf("want hasBilling true, got %v", userJSON["hasBilling"])
	}
}
