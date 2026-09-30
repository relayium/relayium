package account

import (
	"context"
	"net/http"
	"testing"
)

// B-M3 round 5: the retry loop's own interleavings (Codex r3) and the
// deletion path, through the signed handler with the production client.

// withSeam installs stripeWebhookSeam for one account for the test's duration.
// fn runs once (the first time the named point is reached for that account).
func withSeam(t *testing.T, point, userID string, fn func()) {
	t.Helper()
	prev := stripeWebhookSeam
	fired := false
	stripeWebhookSeam = func(p, uid string) {
		if !fired && p == point && uid == userID {
			fired = true
			fn()
		}
	}
	t.Cleanup(func() { stripeWebhookSeam = prev })
}

// Codex r3 finding 1: event B (5000, non-canonical) passes the first stale
// check; a newer event (6000) lands while B holds its evidence, so B's first
// write loses. On the retry B is stale — it must stop BEFORE dedup: no
// canonical re-bind, no duplicate cancellation/refund inspection, and the
// newer entitlement untouched.
func TestBM3RetryStopsBeforeDedupWhenEventBecameStale(t *testing.T) {
	fake, ts, _, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-r5-stale@example.com", "cus_r5s", "sub_a", 4000)
	fake.objects["sub_b"] = bm3Obj("cus_r5s", "active")
	fake.pages["cus_r5s"] = [][]bm3Sub{{
		{ID: "sub_b", Status: "active", Price: "price_plus", Created: 2000},
		{ID: "sub_a", Status: "active", Price: "price_plus", Created: 3000},
	}}
	// The newer event lands while B's dedup holds the live list — after B passed
	// the handler's stale check, before its first write.
	landed := false
	fake.onList["cus_r5s"] = func() {
		if !landed {
			landed = true
			bm3Event(t, store, u.ID, "plus", "active", "sub_a", 1_960_000_000, 6000)
		}
	}
	if code := bm3PostSubEvent(t, ts, "evt_r5s", "customer.subscription.updated", "cus_r5s", "sub_b", "active", "price_plus", 5000); code != http.StatusOK {
		t.Errorf("status %d, want 200 (stale on retry)", code)
	}
	if n := len(fake.requests["cus_r5s"]); n != 1 {
		t.Errorf("list requests = %d, want 1 (the retry must stop before dedup)", n)
	}
	if len(fake.other) != 0 {
		t.Errorf("a stale event reaped a subscription: provider calls %q", fake.other)
	}
	src, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
	if src.EventAt != 6000 || src.ExternalID != "sub_a" || src.PeriodEnd != 1_960_000_000 {
		t.Fatalf("newer entitlement disturbed: %+v", src)
	}
	if users, _ := bm3Binding(t, store, u.ID); users != "sub_a" {
		t.Fatalf("canonical binding moved to %q", users)
	}
}

// Store level: a Bind written together with an event that turns out stale is
// rolled back with it.
func TestBM3ConditionalWriteRollsBackBindWithStaleEvent(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u := bm3PaidUser(t, store, "bm3-r5-rollback@example.com", "cus_rb", "sub_a", 6000)
	obs, ok, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
	bind := "sub_b"
	res, err := store.ApplyStripeSourceIfUnchanged(ctx, StripeSourceWrite{
		UserID: u.ID, Observed: obs, ObservedExists: ok, Bind: &bind,
		Event: &SourceEvent{UserID: u.ID, Provider: ProviderStripe, PlanID: "free", Status: "canceled", EventAt: 5000, Now: bm3LocalNow},
	})
	if err != nil || !res.Unchanged || res.Apply.Applied {
		t.Fatalf("res=%+v err=%v, want unchanged row and a stale (unapplied) event", res, err)
	}
	if users, src := bm3Binding(t, store, u.ID); users != "sub_a" || src != "sub_a" {
		t.Fatalf("stale event left its bind behind: users=%q source=%q", users, src)
	}
}

// Codex r3 finding 2 (tier): past_due preserves the tier STRIPE pays for,
// from the protected source row — not users.plan_id, the effective projection.
// Here the effective tier is Apple's (max); the Stripe row must stay plus.
func TestBM3PastDueKeepsStripesOwnTier(t *testing.T) {
	fake, ts, _, store := bm3WebhookEnv(t)
	seedTiers(t, store)
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true, StripePriceMonthlyID: "price_plus"})
	u := bm3PaidUser(t, store, "bm3-r5-pastdue@example.com", "cus_pd", "sub_old", 4000)
	appleSubscriber(t, store, u.ID, "max")
	if got, _ := store.GetUserByID(context.Background(), u.ID); got.PlanID != "max" {
		t.Fatalf("precondition: effective plan %q, want Apple's max", got.PlanID)
	}
	fake.objects["sub_old"] = bm3Obj("cus_pd", "past_due")
	if code := bm3PostSubEvent(t, ts, "evt_pd", "customer.subscription.updated", "cus_pd", "sub_old", "past_due", "price_plus", 5000); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	src, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
	if src.PlanID != "plus" || src.Status != "past_due" {
		t.Fatalf("past_due wrote another provider's tier onto Stripe's row: %+v", src)
	}
}

// Codex r3 finding 2 (tier, between the reads): on a retry, a Stripe tier
// change lands between the observation and the users read. The event must
// end on the newest Stripe tier, never on an older snapshot.
func TestBM3RetryTierChangeBetweenReads(t *testing.T) {
	fake, ts, _, store := bm3WebhookEnv(t)
	seedTiers(t, store)
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true, StripePriceMonthlyID: "price_plus"})
	u := bm3PaidUser(t, store, "bm3-r5-tier@example.com", "cus_tier", "sub_old", 4000)
	fake.objects["sub_old"] = bm3Obj("cus_tier", "past_due")
	fake.onGet["sub_old"] = func() { // force a retry
		bm3Event(t, store, u.ID, "plus", "active", "sub_old", 1_950_000_000, 4500)
	}
	withSeam(t, "observed", u.ID, func() { // upgrade lands between the two reads
		bm3Event(t, store, u.ID, "max", "active", "sub_old", 1_950_000_000, 4600)
	})
	if code := bm3PostSubEvent(t, ts, "evt_tier", "customer.subscription.updated", "cus_tier", "sub_old", "past_due", "price_plus", 5000); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	src, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
	if src.PlanID != "max" || src.Status != "past_due" || src.EventAt != 5000 {
		t.Fatalf("past_due did not preserve the newest Stripe tier: %+v", src)
	}
}

// Codex r3 finding 2 (binding, after the reads): a canonical-binding change
// that lands after this attempt read the users row must void the attempt's
// routing decision (here: adopt without consulting Stripe's list). The retry
// sees the binding and takes the dedup path.
func TestBM3RetryBindingChangeAfterReadsVoidsDecision(t *testing.T) {
	fake, ts, svc, store := bm3WebhookEnv(t)
	ctx := context.Background()
	u := bm3PaidUser(t, store, "bm3-r5-bind@example.com", "cus_bind", "sub_old", 4000)
	fake.pages["cus_bind"] = [][]bm3Sub{{{ID: "sub_old", Status: "canceled", Price: "price_plus", Created: 3000, EndedAt: 6000}}}
	svc.ReconcileStripeSubscriptions(ctx)
	bm3AssertFree(t, store, u.ID, "sweep")

	fake.objects["sub_new"] = bm3Obj("cus_bind", "active")
	fake.onGet["sub_new"] = func() { // attempt 0: force a retry
		bm3Event(t, store, u.ID, "free", "canceled", "", 0, 6500)
		fake.mu.Lock()
		fake.onGet["sub_new"] = func() { // attempt 1: after its reads, a users-only binding change
			if _, err := store.db.Exec(`UPDATE users SET stripe_subscription_id = 'sub_x' WHERE id = ?`, u.ID); err != nil {
				t.Error(err)
			}
		}
		fake.mu.Unlock()
	}
	fake.pages["cus_bind"] = [][]bm3Sub{{{ID: "sub_new", Status: "active", Price: "price_plus", Created: 7000}}}
	if code := bm3PostSubEvent(t, ts, "evt_bind", "customer.subscription.created", "cus_bind", "sub_new", "active", "price_plus", 7000); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if n := len(fake.requests["cus_bind"]); n != 2 { // 1 by the sweep + 1 by the retry's dedup
		t.Fatalf("list requests = %d, want the retry to have consulted Stripe's list (dedup) after the binding changed", n)
	}
	if users, src := bm3Binding(t, store, u.ID); users != "sub_new" || src != "sub_new" {
		t.Fatalf("binding users=%q source=%q, want sub_new", users, src)
	}
	if plan, _ := bm3Plan(t, store, u.ID); plan != "plus" {
		t.Fatalf("plan %q, want plus", plan)
	}
}

// Codex r3 finding 3 (+ Fable minor 2): an old canonical deletion, paused
// before its write while a newer subscription commits (new binding + paid
// plan), must not clear the new binding or the plan.
func TestBM3DeletionYieldsToNewerSubscription(t *testing.T) {
	_, ts, _, store := bm3WebhookEnv(t)
	ctx := context.Background()
	u := bm3PaidUser(t, store, "bm3-r5-del@example.com", "cus_del", "sub_old", 4000)
	withSeam(t, "observed", u.ID, func() {
		if err := store.SetUserStripeSubscription(ctx, u.ID, "sub_new"); err != nil {
			t.Error(err)
		}
		bm3Event(t, store, u.ID, "plus", "active", "sub_new", 1_990_000_000, 7000)
	})
	if code := bm3PostSubEvent(t, ts, "evt_del", "customer.subscription.deleted", "cus_del", "sub_old", "canceled", "price_plus", 6000); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if users, src := bm3Binding(t, store, u.ID); users != "sub_new" || src != "sub_new" {
		t.Fatalf("stale deletion erased the newer binding: users=%q source=%q", users, src)
	}
	if plan, status := bm3Plan(t, store, u.ID); plan != "plus" || status != "active" {
		t.Fatalf("stale deletion changed the plan: %q/%q", plan, status)
	}
}

// Same, when the newer write is a renewal of the SAME subscription: the
// deletion (6000) became stale (7000); binding and plan stay.
func TestBM3DeletionThatBecameStaleClearsNothing(t *testing.T) {
	_, ts, _, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-r5-del2@example.com", "cus_del2", "sub_old", 4000)
	withSeam(t, "observed", u.ID, func() {
		bm3Event(t, store, u.ID, "plus", "active", "sub_old", 1_990_000_000, 7000)
	})
	if code := bm3PostSubEvent(t, ts, "evt_del2", "customer.subscription.deleted", "cus_del2", "sub_old", "canceled", "price_plus", 6000); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if users, src := bm3Binding(t, store, u.ID); users != "sub_old" || src != "sub_old" {
		t.Fatalf("stale deletion cleared the binding: users=%q source=%q", users, src)
	}
	if plan, _ := bm3Plan(t, store, u.ID); plan != "plus" {
		t.Fatalf("stale deletion downgraded: %q", plan)
	}
}

// Positive: an ordinary canonical deletion still downgrades and clears.
func TestBM3DeletionOfCanonicalStillDowngrades(t *testing.T) {
	_, ts, _, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-r5-del3@example.com", "cus_del3", "sub_old", 4000)
	if code := bm3PostSubEvent(t, ts, "evt_del3", "customer.subscription.deleted", "cus_del3", "sub_old", "canceled", "price_plus", 6000); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	bm3AssertFree(t, store, u.ID, "canonical deletion")
	if users, _ := bm3Binding(t, store, u.ID); users != "" {
		t.Fatalf("binding not cleared: %q", users)
	}
}

// Fable minor 1: a non-canonical event whose dedup list FAILS is unknown —
// 5xx, nothing applied (it used to fall through to the per-event write).
func TestBM3NonCanonicalEventWithFailedListIsUnknown(t *testing.T) {
	fake, ts, _, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-r5-listfail@example.com", "cus_lf", "sub_a", 4000)
	before, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
	fake.objects["sub_b"] = bm3Obj("cus_lf", "active")
	fake.fail["cus_lf"] = http.StatusInternalServerError
	if code := bm3PostSubEvent(t, ts, "evt_lf", "customer.subscription.updated", "cus_lf", "sub_b", "active", "price_plus", 5000); code < 500 {
		t.Fatalf("status %d, want 5xx", code)
	}
	if after, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe); after != before {
		t.Fatalf("applied without list evidence:\n before %+v\n after  %+v", before, after)
	}
}
