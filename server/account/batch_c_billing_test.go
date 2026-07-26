package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// An out-of-order (older) subscription event must not overwrite newer plan/status
// even if it reaches SetUserSubscription directly (a redelivery that slipped past
// the non-atomic pre-check). The in-tx sub_event_at guard drops it.
func TestSetUserSubscriptionDropsStaleEvent(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "ooo@example.com", "O")

	// Newer event first: active on "pro" at clock 2000.
	if err := store.SetUserSubscription(ctx, u.ID, "pro", "active", 1<<40, "stripe", "monthly", 1000, 2000); err != nil {
		t.Fatal(err)
	}
	// Older event arrives late: canceled/free at clock 1000 — must be dropped.
	if err := store.SetUserSubscription(ctx, u.ID, "free", "canceled", 0, "stripe", "", 1000, 1000); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PlanID != "pro" || got.SubscriptionStatus != "active" {
		t.Fatalf("a stale event reverted the plan: plan=%q status=%q, want pro/active", got.PlanID, got.SubscriptionStatus)
	}
	// A genuinely newer event still applies.
	if err := store.SetUserSubscription(ctx, u.ID, "max", "active", 1<<40, "stripe", "monthly", 1000, 3000); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetUserByID(ctx, u.ID); got.PlanID != "max" {
		t.Fatalf("a newer event must apply, got plan=%q", got.PlanID)
	}
}

// A canceled subscriber (plan_source stays "stripe") must get a clean 409 from
// change-plan, routing them back to checkout, not a 500 from Stripe's "no live
// subscription".
func TestBillingChangePlanCanceledSub409(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	svc.biller = &fakeBiller{}
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	email := "change-canceled@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_x"); err != nil {
		t.Fatal(err)
	}
	// Canceled but plan_source still "stripe" (as after a real cancellation).
	if err := store.SetUserSubscription(context.Background(), uid, "pro", "canceled", 0, "stripe", "", time.Now().Unix(), 100); err != nil {
		t.Fatal(err)
	}
	resp := changePlan(t, ts, cookie, `{"planId":"pro","cycle":"monthly"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("canceled subscriber change-plan: got %d, want 409", resp.StatusCode)
	}
}
