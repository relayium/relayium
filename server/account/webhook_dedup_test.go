package account

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

// dedupBiller embeds a real stripeClient (so VerifyWebhook does real signature
// verification + projection) but overrides the two dedup calls so the test
// controls the "live" active subscriptions and records cancellations — no network.
type dedupBiller struct {
	*stripeClient
	active     []SubscriptionInfo
	canceled   []string
	refunded   []bool
	inspectErr error
}

func (d *dedupBiller) ListActiveSubscriptions(ctx context.Context, customerID string) ([]SubscriptionInfo, error) {
	return d.active, nil
}

func (d *dedupBiller) CancelSubscription(ctx context.Context, subID string, refund bool) error {
	d.canceled = append(d.canceled, subID)
	d.refunded = append(d.refunded, refund)
	kept := d.active[:0]
	for _, s := range d.active {
		if s.ID != subID {
			kept = append(kept, s)
		}
	}
	d.active = kept
	return nil
}

func (d *dedupBiller) InspectDuplicateSubscription(_ context.Context, userID, customerID, canonicalID, duplicateID string) (DuplicateRefundPlan, error) {
	if d.inspectErr != nil {
		return DuplicateRefundPlan{}, d.inspectErr
	}
	return DuplicateRefundPlan{UserID: userID, CustomerID: customerID, CanonicalSubscriptionID: canonicalID, DuplicateSubscriptionID: duplicateID}, nil
}

func TestWebhookDuplicateInspectionFailureIsRetryableBeforeCancellation(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_dedup_prepare"
	biller := &dedupBiller{stripeClient: NewStripeClient("sk_test", secret, ""), inspectErr: errors.New("canonical invoice unavailable"), active: []SubscriptionInfo{
		{ID: "sub_A", Created: 100, PriceID: "price_pro_m", Status: "active", CurrentPeriodEnd: 1 << 40},
		{ID: "sub_B", Created: 200, PriceID: "price_pro_m", Status: "active", CurrentPeriodEnd: 1 << 40},
	}}
	svc.biller = biller
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	_ = loginCookie(t, ts, mail, "dedup-prepare@example.com")
	uid := mustUserID(t, store, "dedup-prepare@example.com")
	ctx := context.Background()
	_ = store.SetUserStripeCustomer(ctx, uid, "cus_prepare")
	_ = store.SetUserStripeSubscription(ctx, uid, "sub_A")
	resp := postWebhook(t, ts, secret, webhookEnv("customer.subscription.created", "cus_prepare", "sub_B", "", "active", "price_pro_m", 1<<40))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError || len(biller.canceled) != 0 {
		t.Fatalf("status=%d canceled=%v", resp.StatusCode, biller.canceled)
	}
	var rows int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_duplicate_refunds WHERE duplicate_subscription_id='sub_B'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("rows=%d err=%v", rows, err)
	}
}

func (d *dedupBiller) ReconcileDuplicateSubscription(ctx context.Context, job DuplicateRefundJob) (DuplicateRefundResult, error) {
	if err := d.CancelSubscription(ctx, job.DuplicateSubscriptionID, true); err != nil {
		return DuplicateRefundResult{}, err
	}
	return DuplicateRefundResult{SubscriptionCanceled: true, RefundComplete: true}, nil
}

// A double-checkout opens a second subscription on the (single) customer. When an
// event for that different subscription id arrives, the webhook keeps the
// EARLIEST subscription, cancels + FULLY REFUNDS the newer duplicate, and keeps
// the user's plan driven by the canonical one.
func TestWebhookDedupKeepsEarliestCancelsRefundsDuplicate(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_dedup"
	biller := &dedupBiller{stripeClient: NewStripeClient("sk_test", secret, ""), active: []SubscriptionInfo{
		{ID: "sub_A", Created: 100, PriceID: "price_pro_m", Status: "active", CurrentPeriodEnd: 1 << 40},
		{ID: "sub_B", Created: 200, PriceID: "price_pro_m", Status: "active", CurrentPeriodEnd: 1 << 40},
	}}
	svc.biller = biller
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	_ = loginCookie(t, ts, mail, "dedup@example.com")
	uid := mustUserID(t, store, "dedup@example.com")
	ctx := context.Background()
	if err := store.SetUserStripeCustomer(ctx, uid, "cus_dd"); err != nil {
		t.Fatal(err)
	}
	// Canonical is the earliest (sub_A), already on pro.
	if err := store.SetUserStripeSubscription(ctx, uid, "sub_A"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(ctx, uid, "pro", "active", 1<<40, "stripe", "monthly", 1, 150); err != nil {
		t.Fatal(err)
	}

	// An event for the DUPLICATE (sub_B) arrives → reconcile.
	body := webhookEnv("customer.subscription.created", "cus_dd", "sub_B", "", "active", "price_pro_m", 1<<40)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("webhook status = %d, want 200", resp.StatusCode)
	}

	if len(biller.canceled) != 1 || biller.canceled[0] != "sub_B" {
		t.Fatalf("canceled = %v, want [sub_B] (the newer duplicate)", biller.canceled)
	}
	if len(biller.refunded) != 1 || !biller.refunded[0] {
		t.Fatalf("duplicate must be canceled WITH a refund, got refunded=%v", biller.refunded)
	}
	u, _ := store.GetUserByID(ctx, uid)
	if u.StripeSubscriptionID != "sub_A" {
		t.Fatalf("canonical = %q, want sub_A (earliest kept)", u.StripeSubscriptionID)
	}
	if u.PlanID != "pro" || u.SubscriptionStatus != "active" {
		t.Fatalf("plan = %q/%q, want pro/active (driven by the kept subscription)", u.PlanID, u.SubscriptionStatus)
	}
}

// The deleted event fired by canceling a duplicate must NOT drop a still-
// subscribed user: it isn't the canonical subscription, so it's a no-op.
func TestWebhookDuplicateDeletionIsNoOp(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_dupdel"
	biller := &dedupBiller{stripeClient: NewStripeClient("sk_test", secret, "")}
	svc.biller = biller
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	_ = loginCookie(t, ts, mail, "dupdel@example.com")
	uid := mustUserID(t, store, "dupdel@example.com")
	ctx := context.Background()
	_ = store.SetUserStripeCustomer(ctx, uid, "cus_del")
	_ = store.SetUserStripeSubscription(ctx, uid, "sub_A")
	_ = store.SetUserSubscription(ctx, uid, "pro", "active", 1<<40, "stripe", "monthly", 1, 150)

	// The DUPLICATE (sub_B) is deleted — not our canonical, so ignore.
	body := webhookEnv("customer.subscription.deleted", "cus_del", "sub_B", "", "canceled", "", 1<<40)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	u, _ := store.GetUserByID(ctx, uid)
	if u.PlanID != "pro" || u.SubscriptionStatus != "active" || u.StripeSubscriptionID != "sub_A" {
		t.Fatalf("a duplicate's deletion must not touch the user: plan=%q status=%q canonical=%q",
			u.PlanID, u.SubscriptionStatus, u.StripeSubscriptionID)
	}
}

// Deleting the canonical subscription (a real cancellation) drops the user to
// free and clears the canonical id.
func TestWebhookCanonicalDeletionGoesFree(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_candel"
	biller := &dedupBiller{stripeClient: NewStripeClient("sk_test", secret, "")}
	svc.biller = biller
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	_ = loginCookie(t, ts, mail, "candel@example.com")
	uid := mustUserID(t, store, "candel@example.com")
	ctx := context.Background()
	_ = store.SetUserStripeCustomer(ctx, uid, "cus_can")
	_ = store.SetUserStripeSubscription(ctx, uid, "sub_A")
	_ = store.SetUserSubscription(ctx, uid, "pro", "active", 1<<40, "stripe", "monthly", 1, 150)

	body := webhookEnv("customer.subscription.deleted", "cus_can", "sub_A", "", "canceled", "", 1<<40)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	u, _ := store.GetUserByID(ctx, uid)
	if u.PlanID != "free" || u.StripeSubscriptionID != "" {
		t.Fatalf("canonical deletion must go free + clear canonical: plan=%q canonical=%q", u.PlanID, u.StripeSubscriptionID)
	}
}
