package account

import (
	"context"
	"testing"
)

func TestStripeWebhookLedgerDeduplicatesAndRetriesFailures(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	claimed, err := store.ClaimStripeWebhookEvent(ctx, "evt_1", "invoice.paid", 100)
	if err != nil || !claimed {
		t.Fatalf("first claim = %v, %v", claimed, err)
	}
	claimed, err = store.ClaimStripeWebhookEvent(ctx, "evt_1", "invoice.paid", 101)
	if err != nil || claimed {
		t.Fatalf("concurrent claim = %v, %v", claimed, err)
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_1", false, "temporary", 102); err != nil {
		t.Fatal(err)
	}
	claimed, err = store.ClaimStripeWebhookEvent(ctx, "evt_1", "invoice.paid", 103)
	if err != nil || !claimed {
		t.Fatalf("failed retry = %v, %v", claimed, err)
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_1", true, "", 104); err != nil {
		t.Fatal(err)
	}
	claimed, err = store.ClaimStripeWebhookEvent(ctx, "evt_1", "invoice.paid", 200)
	if err != nil || claimed {
		t.Fatalf("processed replay = %v, %v", claimed, err)
	}
}

func TestPortalRequiresDedicatedConfiguration(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec", "")
	if _, err := c.CreatePortalSession(context.Background(), "cus_1", "https://relayium.test/me"); err == nil {
		t.Fatal("portal without explicit configuration must fail closed")
	}
}
