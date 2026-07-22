package account

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// A correctly-signed event whose livemode does NOT match the configured key
// (here: a livemode:true event against an sk_test client) must be ACKed 200 but
// take no action — a test-mode event can never assign a real plan and vice versa.
// The same event with a matching livemode does assign the plan, proving the
// rejection is specifically the livemode guard and not some other parse failure.
func TestWebhookRejectsWrongLivemode(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	secret := "whsec_livemode"
	svc.biller = NewStripeClient("sk_test", secret, "") // wantLive=false
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true, TrafficBytes: 1 << 40, StripePriceMonthlyID: "price_plus_m"})

	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "livemode@example.com", "L")
	if err := store.SetUserStripeCustomer(ctx, u.ID, "cus_live"); err != nil {
		t.Fatal(err)
	}

	body := func(live bool) string {
		return fmt.Sprintf(`{"type":"customer.subscription.updated","livemode":%t,"data":{"object":{"id":"sub_x","object":"subscription","customer":"cus_live","status":"active","current_period_end":0,"metadata":null,"items":{"data":[{"price":{"id":"price_plus_m"}}]}}}}`, live)
	}

	// livemode:true against a test key → rejected (ACK 200, no plan change).
	resp := signedWebhookRequest(t, ts, secret, body(true), time.Now().Unix())
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("wrong-mode event: want 200 ACK, got %d", resp.StatusCode)
	}
	got, _ := store.GetUserByID(ctx, u.ID)
	if got.PlanID != "free" {
		t.Fatalf("SECURITY: wrong-livemode event assigned plan %q (want unchanged free)", got.PlanID)
	}

	// The identical event with a matching livemode:false IS processed → plus.
	resp2 := signedWebhookRequest(t, ts, secret, body(false), time.Now().Unix())
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("matching-mode event: want 200, got %d", resp2.StatusCode)
	}
	got2, _ := store.GetUserByID(ctx, u.ID)
	if got2.PlanID != "plus" {
		t.Fatalf("matching-livemode event should assign plus, got %q", got2.PlanID)
	}
}

// The webhook's customer binding is a CAS (SetUserStripeCustomerIfEmpty): a
// second customer's event must not flip a user's already-bound customer id, or a
// duplicate-customer could take over the column.
func TestWebhookCustomerBindDoesNotFlip(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	secret := "whsec_bind"
	svc.biller = NewStripeClient("sk_test", secret, "")

	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "bind@example.com", "B")
	if err := store.SetUserStripeCustomer(ctx, u.ID, "cus_A"); err != nil {
		t.Fatal(err)
	}

	// A checkout.session.completed naming a DIFFERENT customer for the same user.
	body := webhookEnv("checkout.session.completed", "cus_B", "", u.ID, "", "", 0)
	resp := signedWebhookRequest(t, ts, secret, body, time.Now().Unix())
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	got, _ := store.GetUserByID(ctx, u.ID)
	if got.StripeCustomerID != "cus_A" {
		t.Fatalf("customer binding flipped to %q; a second customer's event must not overwrite cus_A", got.StripeCustomerID)
	}
}

// The periodic reconcile sweep downgrades a Stripe-paid user whose subscription
// no longer exists on Stripe (a cancellation whose deletion webhook was missed).
func TestReconcileStripeSubscriptionsDowngradesMissedCancellation(t *testing.T) {
	_, svc, store, _ := newBillingServer(t)
	svc.biller = &fakeBiller{} // activeSubs nil → ListActiveSubscriptions returns none
	ctx := context.Background()

	// A user left on plus via Stripe, but Stripe now shows no active subscription.
	paid, _ := store.UpsertUserByEmail(ctx, "stale-paid@example.com", "P")
	store.SetUserStripeCustomer(ctx, paid.ID, "cus_R")
	if err := store.SetUserSubscription(ctx, paid.ID, "plus", "active", 0, "stripe", "", 1000, 0); err != nil {
		t.Fatal(err)
	}
	// A control user with no Stripe binding must be untouched by the sweep.
	free, _ := store.UpsertUserByEmail(ctx, "free@example.com", "F")

	svc.ReconcileStripeSubscriptions(ctx)

	got, _ := store.GetUserByID(ctx, paid.ID)
	if got.PlanID != "free" || got.SubscriptionStatus != "canceled" {
		t.Fatalf("stale paid user not downgraded: plan=%q status=%q, want free/canceled", got.PlanID, got.SubscriptionStatus)
	}
	if got.StripeSubscriptionID != "" {
		t.Fatalf("canonical subscription id not cleared: %q", got.StripeSubscriptionID)
	}
	if fc, _ := store.GetUserByID(ctx, free.ID); fc.PlanID != "free" {
		t.Fatalf("control free user changed to %q", fc.PlanID)
	}
}
