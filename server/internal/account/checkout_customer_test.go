package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// postCheckout drives POST /api/billing/checkout and returns the status.
func postCheckout(t *testing.T, ts *httptest.Server, cookie *http.Cookie, body string) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/billing/checkout", strings.NewReader(body))
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

// Phase 1: a first-time checkout must bind ONE Stripe customer to the user and
// pass it explicitly, so a second concurrent/subsequent checkout can't mint a
// second customer (and a second parallel subscription invisible in the Portal).
func TestCheckoutBindsSingleCustomer(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/s"}
	svc.biller = fb
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	email := "single-customer@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)

	// First checkout: EnsureCustomer creates + the id is persisted and passed.
	if code := postCheckout(t, ts, cookie, `{"planId":"pro","cycle":"monthly"}`); code != http.StatusOK {
		t.Fatalf("first checkout: %d", code)
	}
	if fb.ensureCalls != 1 {
		t.Fatalf("EnsureCustomer calls = %d, want 1", fb.ensureCalls)
	}
	want := "cus_" + uid
	if fb.lastCheckout.CustomerID != want {
		t.Fatalf("checkout CustomerID = %q, want %q (bound customer passed explicitly)", fb.lastCheckout.CustomerID, want)
	}
	if got, _ := store.GetUserByID(context.Background(), uid); got.StripeCustomerID != want {
		t.Fatalf("stored customer = %q, want %q", got.StripeCustomerID, want)
	}

	// Second checkout: reuse the already-bound customer, do NOT create another.
	if code := postCheckout(t, ts, cookie, `{"planId":"pro","cycle":"monthly"}`); code != http.StatusOK {
		t.Fatalf("second checkout: %d", code)
	}
	if fb.ensureCalls != 1 {
		t.Fatalf("second checkout must reuse the bound customer, EnsureCustomer calls = %d, want 1", fb.ensureCalls)
	}
	if fb.lastCheckout.CustomerID != want {
		t.Fatalf("second checkout CustomerID = %q, want the same %q", fb.lastCheckout.CustomerID, want)
	}
}

// The CAS store write converges on a single customer even if two writers race
// with different ids (e.g. the idempotency key were somehow bypassed): the first
// wins, the loser reads and reuses it.
func TestSetUserStripeCustomerIfEmptyConverges(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "cas@example.com", "C")

	got1, err := store.SetUserStripeCustomerIfEmpty(ctx, u.ID, "cus_first")
	if err != nil || got1 != "cus_first" {
		t.Fatalf("first bind = %q/%v, want cus_first", got1, err)
	}
	// A second bind with a DIFFERENT id must be ignored; the first stays in force.
	got2, err := store.SetUserStripeCustomerIfEmpty(ctx, u.ID, "cus_second")
	if err != nil || got2 != "cus_first" {
		t.Fatalf("second bind = %q/%v, want the already-bound cus_first", got2, err)
	}
	if final, _ := store.GetUserByID(ctx, u.ID); final.StripeCustomerID != "cus_first" {
		t.Fatalf("stored customer = %q, want cus_first", final.StripeCustomerID)
	}
}
