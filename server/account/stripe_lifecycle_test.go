package account

import (
	"context"
	"testing"
)

func TestStripeWebhookLedgerDeduplicatesAndRetriesFailures(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	claimed, err := store.ClaimStripeWebhookEvent(ctx, "evt_1", "invoice.paid", 100)
	if err != nil || claimed.State != StripeWebhookClaimed || claimed.Generation != 1 {
		t.Fatalf("first claim = %v, %v", claimed, err)
	}
	firstGeneration := claimed.Generation
	claimed, err = store.ClaimStripeWebhookEvent(ctx, "evt_1", "invoice.paid", 101)
	if err != nil || claimed.State != StripeWebhookInFlight {
		t.Fatalf("concurrent claim = %v, %v", claimed, err)
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_1", firstGeneration, false, "temporary", 102); err != nil {
		t.Fatal(err)
	}
	claimed, err = store.ClaimStripeWebhookEvent(ctx, "evt_1", "invoice.paid", 103)
	if err != nil || claimed.State != StripeWebhookClaimed || claimed.Generation != 2 {
		t.Fatalf("failed retry = %v, %v", claimed, err)
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_1", claimed.Generation, true, "", 104); err != nil {
		t.Fatal(err)
	}
	claimed, err = store.ClaimStripeWebhookEvent(ctx, "evt_1", "invoice.paid", 200)
	if err != nil || claimed.State != StripeWebhookProcessed {
		t.Fatalf("processed replay = %v, %v", claimed, err)
	}
}

func TestExpiredWebhookWorkerCannotFinishReplacementLease(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	first, err := store.ClaimStripeWebhookEvent(ctx, "evt_lease", "invoice.paid", 100)
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := store.ClaimStripeWebhookEvent(ctx, "evt_lease", "invoice.paid", 161)
	if err != nil || replacement.State != StripeWebhookClaimed {
		t.Fatalf("replacement claim = %v, %v", replacement, err)
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_lease", first.Generation, true, "", 162); err == nil {
		t.Fatal("expired worker completed the replacement lease")
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_lease", replacement.Generation, true, "", 163); err != nil {
		t.Fatal(err)
	}
}

func TestFailedWebhookReclaimInSameSecondHasANewGeneration(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	first, err := store.ClaimStripeWebhookEvent(ctx, "evt_aba", "invoice.paid", 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_aba", first.Generation, false, "temporary", 100); err != nil {
		t.Fatal(err)
	}
	replacement, err := store.ClaimStripeWebhookEvent(ctx, "evt_aba", "invoice.paid", 100)
	if err != nil || replacement.State != StripeWebhookClaimed || replacement.Generation == first.Generation {
		t.Fatalf("same-second replacement = %v, %v", replacement, err)
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_aba", first.Generation, true, "", 100); err == nil {
		t.Fatal("stale worker completed a same-second replacement claim")
	}
	if err := store.FinishStripeWebhookEvent(ctx, "evt_aba", replacement.Generation, true, "", 100); err != nil {
		t.Fatal(err)
	}
}

func TestPortalRequiresDedicatedConfiguration(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec", "")
	if _, err := c.CreatePortalSession(context.Background(), "cus_1", "https://relayium.test/me"); err == nil {
		t.Fatal("portal without explicit configuration must fail closed")
	}
}
