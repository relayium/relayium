package account

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// An already-subscribed user must NOT be able to open a fresh Checkout Session:
// Stripe would create a SECOND live subscription on the same customer and bill
// them twice. Changing tiers has to go through change-plan instead.
func TestBillingCheckoutBlocksSecondSubscription(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/should-not-happen"}
	svc.biller = fb
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	email := "checkout-already-subbed@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUser(t, store, mustUserID(t, store, email), "cus_dup", "pro") // live active sub

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout",
		strings.NewReader(`{"planId":"pro","cycle":"monthly"}`))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("want 409 for an already-subscribed user, got %d", resp.StatusCode)
	}
	if fb.lastCheckout.PriceID != "" {
		t.Fatalf("SECURITY: a second Checkout Session was created for an already-subscribed user (price=%q)", fb.lastCheckout.PriceID)
	}
}

// A user whose subscription has been canceled (status no longer live) must be
// able to re-subscribe: the guard keys on live status, not on the sticky
// plan_source=stripe that survives cancellation.
func TestBillingCheckoutAllowsResubscribeAfterCancel(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/resub"}
	svc.biller = fb
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	email := "checkout-resub@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	// Canceled: keeps the stripe customer + plan_source, but status is not live.
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_resub"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(context.Background(), uid, "free", "canceled", 1900000000, "stripe", "", time.Now().Unix(), 0); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout",
		strings.NewReader(`{"planId":"pro","cycle":"monthly"}`))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 for a canceled user re-subscribing, got %d", resp.StatusCode)
	}
	if fb.lastCheckout.PriceID != "price_pro_m" {
		t.Fatalf("re-subscribe did not reach checkout: price=%q", fb.lastCheckout.PriceID)
	}
}
