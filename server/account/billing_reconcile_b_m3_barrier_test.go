package account

import (
	"context"
	"net/http"
	"testing"
)

// B-M3 round 4. Deterministic interleavings through the signed webhook handler
// (production client, canonical refresh on): the fake Stripe API's ONE-SHOT
// retrieve hook runs after the webhook has observed the account and while it
// holds Stripe's answer, i.e. exactly between its refresh and its write.

func bm3Obj(cus, status string) bm3Object {
	return bm3Object{Customer: cus, Status: status, Price: "price_plus", PeriodEnd: 1_990_000_000}
}

func bm3Binding(t *testing.T, store *SQLiteStore, userID string) (string, string) {
	t.Helper()
	u, err := store.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	src, _, _ := store.GetSubscriptionSource(context.Background(), userID, ProviderStripe)
	return u.StripeSubscriptionID, src.ExternalID
}

// Codex r2 finding 1: the webhook fetched `active`; before it writes, Stripe
// cancels / marks unpaid / pauses the subscription and the sweep commits the
// downgrade (canceled: at ended_at 6000; unpaid/paused: no ended_at, at the
// observed 4000). The webhook's event is created at 6000 / 5000, so the strict
// replay clock alone would let its stale `active` through. The conditional
// write must lose, re-fetch, and grant nothing.
func TestBM3WebhookBarrierSweepCommitsBetweenRefreshAndWrite(t *testing.T) {
	for _, tc := range []struct {
		status           string
		endedAt, eventAt int64
	}{
		{"canceled", 6000, 6000},
		{"unpaid", 0, 5000},
		{"paused", 0, 5000},
	} {
		t.Run(tc.status, func(t *testing.T) {
			fake, ts, svc, store := bm3WebhookEnv(t)
			ctx := context.Background()
			u := bm3PaidUser(t, store, "bm3-barrier@example.com", "cus_bar", "sub_old", 4000)
			fake.objects["sub_old"] = bm3Obj("cus_bar", "active")
			fake.onGet["sub_old"] = func() {
				fake.mu.Lock()
				fake.objects["sub_old"] = bm3Obj("cus_bar", tc.status)
				fake.pages["cus_bar"] = [][]bm3Sub{{{ID: "sub_old", Status: tc.status, Price: "price_plus", Created: 3000, EndedAt: tc.endedAt}}}
				fake.mu.Unlock()
				svc.ReconcileStripeSubscriptions(ctx)
				if plan, _ := bm3Plan(t, store, u.ID); plan != "free" {
					t.Errorf("barrier precondition: the sweep did not commit its downgrade (plan=%q)", plan)
				}
			}

			if code := bm3PostSubEvent(t, ts, "evt_barrier_"+tc.status, "customer.subscription.updated", "cus_bar", "sub_old", "active", "price_plus", tc.eventAt); code != http.StatusOK {
				t.Fatalf("webhook status %d", code)
			}
			bm3AssertFree(t, store, u.ID, "webhook resumed after the sweep committed")
			if users, src := bm3Binding(t, store, u.ID); users != "" || src != "" {
				t.Fatalf("a %s subscription was re-bound as canonical: users=%q source=%q", tc.status, users, src)
			}
			if n := fake.gets["sub_old"]; n != 2 {
				t.Fatalf("want the lost write to re-fetch once (2 retrieves), got %d", n)
			}
		})
	}
}

// Positive: a concurrent sweep that finds the subscription LIVE writes
// nothing, so the webhook's grant proceeds on its first attempt.
func TestBM3WebhookBarrierSweepFindsLiveGrantProceeds(t *testing.T) {
	fake, ts, svc, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-barrier-live@example.com", "cus_bl", "sub_old", 4000)
	fake.objects["sub_old"] = bm3Obj("cus_bl", "active")
	fake.pages["cus_bl"] = [][]bm3Sub{{{ID: "sub_old", Status: "active", Price: "price_plus", Created: 3000}}}
	fake.onGet["sub_old"] = func() { svc.ReconcileStripeSubscriptions(context.Background()) }

	if code := bm3PostSubEvent(t, ts, "evt_bl", "customer.subscription.updated", "cus_bl", "sub_old", "active", "price_plus", 5000); code != http.StatusOK {
		t.Fatalf("webhook status %d", code)
	}
	src, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
	if src.PlanID != "plus" || src.EventAt != 5000 || src.PeriodEnd != 1_990_000_000 || fake.gets["sub_old"] != 1 {
		t.Fatalf("renewal not applied on the first attempt: row=%+v retrieves=%d", src, fake.gets["sub_old"])
	}
}

// Positive: another writer (a renewal applied by a concurrent webhook) makes
// the first write lose; the retry re-fetches and the genuine grant lands.
func TestBM3WebhookBarrierConcurrentWriterRetriesThenGrants(t *testing.T) {
	fake, ts, _, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-barrier-retry@example.com", "cus_br", "sub_old", 4000)
	fake.objects["sub_old"] = bm3Obj("cus_br", "active")
	fake.onGet["sub_old"] = func() {
		bm3Event(t, store, u.ID, "plus", "active", "sub_old", 1_950_000_000, 4500)
	}
	if code := bm3PostSubEvent(t, ts, "evt_br", "customer.subscription.updated", "cus_br", "sub_old", "active", "price_plus", 5000); code != http.StatusOK {
		t.Fatalf("webhook status %d", code)
	}
	src, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
	if src.PlanID != "plus" || src.EventAt != 5000 || src.PeriodEnd != 1_990_000_000 || fake.gets["sub_old"] != 2 {
		t.Fatalf("retry did not converge on the genuine state: row=%+v retrieves=%d", src, fake.gets["sub_old"])
	}
}

// The retry is bounded: a row that keeps moving leaves the event to Stripe's
// redelivery (5xx) after maxStripeApplyAttempts fetches, writing nothing.
func TestBM3WebhookBarrierRetriesAreBounded(t *testing.T) {
	fake, ts, _, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-barrier-bound@example.com", "cus_bb", "sub_old", 4000)
	fake.objects["sub_old"] = bm3Obj("cus_bb", "active")
	at := int64(4000)
	var rearm func()
	rearm = func() {
		at += 10
		bm3Event(t, store, u.ID, "plus", "active", "sub_old", 1_900_000_000+at, at)
		fake.mu.Lock()
		fake.onGet["sub_old"] = rearm
		fake.mu.Unlock()
	}
	fake.onGet["sub_old"] = rearm
	code := bm3PostSubEvent(t, ts, "evt_bb", "customer.subscription.updated", "cus_bb", "sub_old", "active", "price_plus", 5000)
	if code < 500 {
		t.Fatalf("status %d, want 5xx after bounded retries", code)
	}
	if n := fake.gets["sub_old"]; n != maxStripeApplyAttempts {
		t.Fatalf("retrieves = %d, want %d", n, maxStripeApplyAttempts)
	}
	if src, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe); src.EventAt != at {
		t.Fatalf("the webhook wrote despite never holding current evidence: row=%+v (last concurrent write at %d)", src, at)
	}
}

// Codex r2 finding 2 (retrieve): partial canonical objects are unknown — 5xx,
// nothing applied. Before, a missing price resolved the tier to free and
// downgraded the payer with a 200.
func TestBM3WebhookPartialRetrieveEvidenceIsUnknown(t *testing.T) {
	for name, body := range map[string]string{
		"no customer, no items": `{"id":"sub_old","status":"active"}`,
		"no items":              `{"id":"sub_old","customer":"cus_part","status":"active"}`,
		"item without price":    `{"id":"sub_old","customer":"cus_part","status":"active","items":{"data":[{"price":{}}]}}`,
		"other customer":        `{"id":"sub_old","customer":"cus_other","status":"active","items":{"data":[{"price":{"id":"price_plus"}}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			fake, ts, _, store := bm3WebhookEnv(t)
			u := bm3PaidUser(t, store, "bm3-partial@example.com", "cus_part", "sub_old", 4000)
			before, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
			fake.rawObj["sub_old"] = body
			if code := bm3PostSubEvent(t, ts, "evt_partial", "customer.subscription.updated", "cus_part", "sub_old", "active", "price_plus", 5000); code < 500 {
				t.Fatalf("partial canonical object %s answered %d, want 5xx", body, code)
			}
			if after, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe); after != before {
				t.Fatalf("partial canonical object %s changed the row:\n before %+v\n after  %+v", body, before, after)
			}
			if users, _ := bm3Binding(t, store, u.ID); users != "sub_old" {
				t.Fatalf("binding changed to %q", users)
			}
		})
	}
}

// Codex r2 finding 2 (dedup): a live list item without a price used to become
// the canonical and write free. It is now unknown list evidence; the webhook
// falls back to its own refreshed event, which grants the real tier.
func TestBM3WebhookDedupIgnoresLiveListItemWithoutPrice(t *testing.T) {
	fake, ts, _, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-dedup-price@example.com", "cus_dp", "sub_old", 4000)
	fake.objects["sub_new"] = bm3Obj("cus_dp", "active")
	fake.raw["cus_dp"] = `{"object":"list","has_more":false,"data":[{"id":"sub_new","customer":"cus_dp","status":"active","created":5000,"items":{"data":[{"price":{}}]}}]}`
	if code := bm3PostSubEvent(t, ts, "evt_dp", "customer.subscription.updated", "cus_dp", "sub_new", "active", "price_plus", 5000); code != http.StatusOK {
		t.Fatalf("webhook status %d", code)
	}
	if plan, status := bm3Plan(t, store, u.ID); plan != "plus" || status != "active" {
		t.Fatalf("a live list item without a price downgraded the payer: plan=%q status=%q", plan, status)
	}
	if n := len(fake.requests["cus_dp"]); n != 1 {
		t.Fatalf("precondition: the dedup path must have listed once, got %d", n)
	}
}

// Codex r2 finding 2 (list parsing): every field a decision consumes.
func TestBM3EvidenceRejectsPartialItems(t *testing.T) {
	for name, tc := range map[string]struct {
		body string
		ok   bool
	}{
		"live without created":  {`{"object":"list","has_more":false,"data":[{"id":"s","customer":"cus_e","status":"active","items":{"data":[{"price":{"id":"p"}}]}}]}`, false},
		"live without items":    {`{"object":"list","has_more":false,"data":[{"id":"s","customer":"cus_e","status":"trialing","created":5}]}`, false},
		"live without price id": {`{"object":"list","has_more":false,"data":[{"id":"s","customer":"cus_e","status":"past_due","created":5,"items":{"data":[{"price":{}}]}}]}`, false},
		"missing customer":      {`{"object":"list","has_more":false,"data":[{"id":"s","status":"canceled"}]}`, false},
		"other customer":        {`{"object":"list","has_more":false,"data":[{"id":"s","customer":"cus_x","status":"canceled"}]}`, false},
		"ended, null ended_at":  {`{"object":"list","has_more":false,"data":[{"id":"s","customer":"cus_e","status":"canceled","ended_at":null}]}`, true},
		"live, item period end": {`{"object":"list","has_more":false,"data":[{"id":"s","customer":"cus_e","status":"active","created":5,"current_period_end":null,"items":{"data":[{"price":{"id":"p"},"current_period_end":777}]}}]}`, true},
	} {
		t.Run(name, func(t *testing.T) {
			fake, client := newBM3Stripe(t)
			fake.raw["cus_e"] = tc.body
			ev, err := client.ListSubscriptionEvidence(context.Background(), "cus_e")
			if (err == nil) != tc.ok {
				t.Fatalf("evidence=%+v err=%v, want ok=%v", ev, err, tc.ok)
			}
			if name == "live, item period end" && (len(ev.Live) != 1 || ev.Live[0].CurrentPeriodEnd != 777 || ev.Live[0].PriceID != "p") {
				t.Fatalf("item-level period end / price not used: %+v", ev.Live)
			}
		})
	}
}

// Fable minor: a subscription event naming no subscription carries no
// canonical evidence; it is ACKed and ignored, never applied from its payload.
func TestBM3WebhookEventWithoutSubscriptionIDIsIgnored(t *testing.T) {
	fake, ts, svc, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-noid@example.com", "cus_noid", "sub_old", 4000)
	fake.pages["cus_noid"] = [][]bm3Sub{{{ID: "sub_old", Status: "canceled", Price: "price_plus", Created: 3000, EndedAt: 6000}}}
	svc.ReconcileStripeSubscriptions(context.Background())
	bm3AssertFree(t, store, u.ID, "sweep")
	before, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)

	if code := bm3PostSubEvent(t, ts, "evt_noid", "customer.subscription.updated", "cus_noid", "", "active", "price_plus", 7000); code != http.StatusOK {
		t.Fatalf("status %d, want 200 (ignored)", code)
	}
	if after, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe); after != before {
		t.Fatalf("an event with no subscription id was applied:\n before %+v\n after  %+v", before, after)
	}
	bm3AssertFree(t, store, u.ID, "event without subscription id")
}
