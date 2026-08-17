package account

import (
	"context"
	"fmt"
	"testing"
)

// webhookEnvCreated is webhookEnv with an explicit top-level event `created`
// (unix secs), the field the ordering guard keys on.
func webhookEnvCreated(eventType, customer, status, priceID string, created int64) string {
	items := "null"
	if priceID != "" {
		items = fmt.Sprintf(`{"data":[{"price":{"id":%q}}]}`, priceID)
	}
	// Real customer.subscription.* shape: the object IS the subscription, id at
	// data.object.id with object=="subscription" (see webhookEnvWithMetadata).
	return fmt.Sprintf(`{"id":"evt_%d_%s","type":%q,"created":%d,"data":{"object":{"id":"sub_x","object":"subscription","customer":%q,"status":%q,"current_period_end":0,"metadata":null,"items":%s}}}`,
		created, status, eventType, created, customer, status, items)
}

// A stale (out-of-order / re-delivered) subscription event must not revert newer
// state. Regression: the webhook applied whatever payload arrived last, so a
// retried older `active` event could restore a since-lapsed user to paid (or a
// late `past_due` could strip a recovered one).
func TestWebhookDropsStaleOutOfOrderEvent(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_order"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	cookie := loginCookie(t, ts, mail, "webhook-order@example.com")
	_ = cookie
	uid := mustUserID(t, store, "webhook-order@example.com")
	const customer = "cus_order"
	if err := store.SetUserStripeCustomer(context.Background(), uid, customer); err != nil {
		t.Fatal(err)
	}

	// Newer event (created=2000): active on pro. User becomes pro.
	resp := postWebhook(t, ts, secret, webhookEnvCreated("customer.subscription.updated", customer, "active", "price_pro_m", 2000))
	resp.Body.Close()
	if u, _, _ := store.GetUserByStripeCustomer(context.Background(), customer); u.PlanID != "pro" {
		t.Fatalf("after newer active event: want plan pro, got %q", u.PlanID)
	}

	// Older event (created=1000): past_due (would drop to free). Must be DROPPED.
	resp = postWebhook(t, ts, secret, webhookEnvCreated("customer.subscription.updated", customer, "past_due", "", 1000))
	code := resp.StatusCode
	resp.Body.Close()
	if code != 200 {
		t.Fatalf("stale event should be ACKed 200, got %d", code)
	}
	u, _, _ := store.GetUserByStripeCustomer(context.Background(), customer)
	if u.PlanID != "pro" {
		t.Fatalf("SECURITY: a stale older event reverted the plan: want pro, got %q", u.PlanID)
	}
	if u.SubscriptionStatus != "active" {
		t.Fatalf("stale event overwrote status: want active, got %q", u.SubscriptionStatus)
	}

	// A genuinely newer event (created=3000) still applies: cancel to free.
	resp = postWebhook(t, ts, secret, webhookEnvCreated("customer.subscription.deleted", customer, "canceled", "", 3000))
	resp.Body.Close()
	u, _, _ = store.GetUserByStripeCustomer(context.Background(), customer)
	if u.PlanID != "free" {
		t.Fatalf("a newer cancel event must apply: want free, got %q", u.PlanID)
	}
}
