package account

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// B-M3 round 3: what can a delayed webhook do AFTER the reconcile sweep's
// downgrade? These go through the REAL signed webhook handler with the
// production client configuration (NewStripeClient ⇒ canonicalWebhookRefresh
// on), against a fake Stripe API that answers both the sweep's list and the
// handler's canonical GET /v1/subscriptions/{id}.

func bm3WebhookEnv(t *testing.T) (*bm3Stripe, *httptest.Server, *Service, *SQLiteStore) {
	t.Helper()
	fake, client := newBM3Stripe(t)
	if !client.canonicalWebhookRefresh {
		t.Fatal("precondition: the production client must refresh subscription webhooks from Stripe")
	}
	ts, svc, store, _ := newBillingServer(t)
	svc.biller = client
	svc.now = func() time.Time { return time.Unix(bm3LocalNow, 0) }
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true, StripePriceMonthlyID: "price_plus"})
	return fake, ts, svc, store
}

// bm3PostSubEvent signs (with the fake client's secret, at the service clock)
// and posts a customer.subscription.* event whose PAYLOAD claims the given
// status/price, created at `created` on Stripe's clock.
func bm3PostSubEvent(t *testing.T, ts *httptest.Server, eventID, eventType, customer, subID, status, price string, created int64) int {
	t.Helper()
	body := fmt.Sprintf(`{"id":%q,"type":%q,"created":%d,"livemode":false,"data":{"object":{"id":%q,"object":"subscription","customer":%q,"status":%q,"current_period_end":1990000000,"items":{"data":[{"price":{"id":%q}}]}}}}`,
		eventID, eventType, created, subID, customer, status, price)
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/stripe/webhook", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Stripe-Signature", signStripe("whsec_bm3", body, bm3LocalNow))
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

func bm3AssertFree(t *testing.T, store *SQLiteStore, userID, why string) {
	t.Helper()
	u, err := store.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	src, _, _ := store.GetSubscriptionSource(context.Background(), userID, ProviderStripe)
	if u.PlanID != "free" || src.PlanID != "free" || liveSubStatus(src.Status) {
		t.Fatalf("%s: paid access granted: users.plan=%q status=%q stripe row=%+v", why, u.PlanID, u.SubscriptionStatus, src)
	}
}

// (a) Codex blocker 1: after the sweep downgrades a CANCELED subscription
// (ended_at 6000), a replay of that subscription's `active` event created in
// the very second it ended passes the strict replay clock — and, with the
// binding cleared, takes the first-subscription adoption path. The canonical
// refresh re-reads the subscription and applies Stripe's CURRENT status
// (canceled), so nothing is granted.
func TestBM3WebhookCanceledReplayAtEndedSecondGrantsNothing(t *testing.T) {
	fake, ts, svc, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-wh-cancel@example.com", "cus_whc", "sub_old", 4000)
	fake.pages["cus_whc"] = [][]bm3Sub{{{ID: "sub_old", Status: "canceled", Price: "price_plus", Created: 3000, EndedAt: 6000}}}
	fake.objects["sub_old"] = bm3Object{Customer: "cus_whc", Status: "canceled", Price: "price_plus"}

	svc.ReconcileStripeSubscriptions(context.Background())
	bm3AssertFree(t, store, u.ID, "sweep")
	if got, _ := store.GetUserByID(context.Background(), u.ID); got.StripeSubscriptionID != "" {
		t.Fatalf("precondition: sweep must clear the binding so the replay takes the adoption path; got %q", got.StripeSubscriptionID)
	}

	for _, typ := range []string{"customer.subscription.updated", "customer.subscription.created"} {
		if code := bm3PostSubEvent(t, ts, "evt_replay_"+typ, typ, "cus_whc", "sub_old", "active", "price_plus", 6000); code != http.StatusOK {
			t.Fatalf("%s replay: status %d", typ, code)
		}
		bm3AssertFree(t, store, u.ID, typ+" replay of the canceled subscription at created == ended_at")
	}
}

// (b) Codex blocker 2 + Fable's note: an unpaid or paused subscription has no
// ended_at, so the sweep stamps the downgrade with the observed clock (4000).
// Neither a stale `active` event from between (5000) nor an equal-second resend
// of the last applied `active` event (4000) may grant; a genuine recovery (Stripe
// now reports active) must.
func TestBM3WebhookUnpaidOrPausedStaleGrantThenRecovery(t *testing.T) {
	for _, status := range []string{"unpaid", "paused"} {
		t.Run(status, func(t *testing.T) {
			fake, ts, svc, store := bm3WebhookEnv(t)
			u := bm3PaidUser(t, store, "bm3-wh-"+status+"@example.com", "cus_whu", "sub_old", 4000)
			fake.pages["cus_whu"] = [][]bm3Sub{{{ID: "sub_old", Status: status, Price: "price_plus", Created: 3000}}}
			fake.objects["sub_old"] = bm3Object{Customer: "cus_whu", Status: status, Price: "price_plus"}

			svc.ReconcileStripeSubscriptions(context.Background())
			bm3AssertFree(t, store, u.ID, "sweep")
			if src, _, _ := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe); src.EventAt != 4000 {
				t.Fatalf("precondition: no ended_at ⇒ stamp is the observed clock 4000, got %d", src.EventAt)
			}

			if code := bm3PostSubEvent(t, ts, "evt_stale_5000", "customer.subscription.updated", "cus_whu", "sub_old", "active", "price_plus", 5000); code != http.StatusOK {
				t.Fatalf("stale event: status %d", code)
			}
			bm3AssertFree(t, store, u.ID, "stale active event at 5000 for a now-"+status+" subscription")
			if code := bm3PostSubEvent(t, ts, "evt_resend_4000", "customer.subscription.updated", "cus_whu", "sub_old", "active", "price_plus", 4000); code != http.StatusOK {
				t.Fatalf("equal-second resend: status %d", code)
			}
			bm3AssertFree(t, store, u.ID, "equal-second resend of the last applied active event")

			// Genuine recovery: the customer pays / resumes; Stripe now says active.
			fake.mu.Lock()
			fake.objects["sub_old"] = bm3Object{Customer: "cus_whu", Status: "active", Price: "price_plus"}
			fake.mu.Unlock()
			if code := bm3PostSubEvent(t, ts, "evt_recover_7000", "customer.subscription.updated", "cus_whu", "sub_old", "active", "price_plus", 7000); code != http.StatusOK {
				t.Fatalf("recovery: status %d", code)
			}
			if got, _ := store.GetUserByID(context.Background(), u.ID); got.PlanID != "plus" || got.SubscriptionStatus != "active" {
				t.Fatalf("genuine recovery not granted: plan=%q status=%q", got.PlanID, got.SubscriptionStatus)
			}
		})
	}
}

// (c) Positive: a genuinely NEW subscription whose event is created in the same
// second the old one ended is granted — both straight after the sweep (adoption
// path) and after a canceled replay has re-bound the old id (dedup path, which
// re-lists live subscriptions).
func TestBM3WebhookNewSubscriptionInEndedSecondIsGranted(t *testing.T) {
	for _, afterReplay := range []bool{false, true} {
		t.Run(fmt.Sprintf("after_replay_%v", afterReplay), func(t *testing.T) {
			fake, ts, svc, store := bm3WebhookEnv(t)
			u := bm3PaidUser(t, store, "bm3-wh-new@example.com", "cus_whn", "sub_old", 4000)
			fake.pages["cus_whn"] = [][]bm3Sub{{{ID: "sub_old", Status: "canceled", Price: "price_plus", Created: 3000, EndedAt: 6000}}}
			fake.objects["sub_old"] = bm3Object{Customer: "cus_whn", Status: "canceled", Price: "price_plus"}
			svc.ReconcileStripeSubscriptions(context.Background())
			bm3AssertFree(t, store, u.ID, "sweep")
			if afterReplay {
				bm3PostSubEvent(t, ts, "evt_replay", "customer.subscription.updated", "cus_whn", "sub_old", "active", "price_plus", 6000)
				bm3AssertFree(t, store, u.ID, "replay")
			}

			fake.mu.Lock()
			fake.objects["sub_new"] = bm3Object{Customer: "cus_whn", Status: "active", Price: "price_plus", PeriodEnd: 1_995_000_000}
			fake.pages["cus_whn"] = [][]bm3Sub{{
				{ID: "sub_new", Status: "active", Price: "price_plus", Created: 6000},
				{ID: "sub_old", Status: "canceled", Price: "price_plus", Created: 3000, EndedAt: 6000},
			}}
			fake.mu.Unlock()
			if code := bm3PostSubEvent(t, ts, "evt_new", "customer.subscription.created", "cus_whn", "sub_new", "active", "price_plus", 6000); code != http.StatusOK {
				t.Fatalf("new subscription: status %d", code)
			}
			got, _ := store.GetUserByID(context.Background(), u.ID)
			if got.PlanID != "plus" || got.SubscriptionStatus != "active" || got.StripeSubscriptionID != "sub_new" {
				t.Fatalf("genuine new subscription in the ended second not granted: plan=%q status=%q sub=%q", got.PlanID, got.SubscriptionStatus, got.StripeSubscriptionID)
			}
		})
	}
}

// The canonical refresh is only a guard if a malformed 200 from the retrieve
// endpoint cannot fall back to the (possibly stale) event payload.
func TestBM3WebhookMalformedCanonicalRefreshGrantsNothing(t *testing.T) {
	fake, ts, svc, store := bm3WebhookEnv(t)
	u := bm3PaidUser(t, store, "bm3-wh-badref@example.com", "cus_whb", "sub_old", 4000)
	fake.pages["cus_whb"] = [][]bm3Sub{{{ID: "sub_old", Status: "canceled", Price: "price_plus", Created: 3000, EndedAt: 6000}}}
	svc.ReconcileStripeSubscriptions(context.Background())
	bm3AssertFree(t, store, u.ID, "sweep")

	// The retrieve endpoint answers 200 with an object that is not this
	// subscription (no id at all).
	fake.rawObj["sub_old"] = `{}`

	code := bm3PostSubEvent(t, ts, "evt_badref", "customer.subscription.updated", "cus_whb", "sub_old", "active", "price_plus", 6500)
	if code < 500 {
		t.Errorf("malformed canonical refresh was ACKed with %d; want 5xx so Stripe retries", code)
	}
	bm3AssertFree(t, store, u.ID, "event applied on its own stale payload after a malformed refresh")
}

// Malformed list evidence (Codex blocker 3): every body below is a 200 that
// parses as JSON but is not a complete list, so it is unknown evidence — no
// downgrade, no binding change, row untouched.
func TestBM3SweepRejectsMalformedListEvidence(t *testing.T) {
	for name, body := range map[string]string{
		"empty object":         `{}`,
		"null":                 `null`,
		"item without id":      `{"data":[{}],"has_more":false}`,
		"list item without id": `{"object":"list","data":[{}],"has_more":false}`,
		"missing has_more":     `{"object":"list","data":[]}`,
		"null has_more":        `{"object":"list","data":[],"has_more":null}`,
		"null data":            `{"object":"list","data":null,"has_more":false}`,
		"missing data":         `{"object":"list","has_more":false}`,
		"missing object":       `{"data":[],"has_more":false}`,
		"wrong object":         `{"object":"subscription","data":[],"has_more":false}`,
		"unknown status":       `{"object":"list","data":[{"id":"sub_x","status":"ended"}],"has_more":false}`,
		"missing status":       `{"object":"list","data":[{"id":"sub_x"}],"has_more":false}`,
	} {
		t.Run(name, func(t *testing.T) {
			fake, client := newBM3Stripe(t)
			svc, store := bm3Service(t, client)
			ctx := context.Background()
			u := bm3PaidUser(t, store, "bm3-malformed@example.com", "cus_bad", "sub_old", 4000)
			before, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
			fake.raw["cus_bad"] = body

			svc.ReconcileStripeSubscriptions(ctx)

			if n := len(fake.requests["cus_bad"]); n != 1 {
				t.Fatalf("want exactly one list request, got %d", n)
			}
			if after, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe); after != before {
				t.Fatalf("malformed evidence %s moved the Stripe row:\n before %+v\n after  %+v", body, before, after)
			}
			if got, _ := store.GetUserByID(ctx, u.ID); got.PlanID != "plus" || got.StripeSubscriptionID != "sub_old" {
				t.Fatalf("malformed evidence %s downgraded or unbound: plan=%q sub=%q", body, got.PlanID, got.StripeSubscriptionID)
			}
		})
	}
}

// Positive control for the validator: a well-formed empty list is still
// complete evidence of "nothing live".
func TestBM3SweepAcceptsWellFormedEmptyList(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	u := bm3PaidUser(t, store, "bm3-emptyok@example.com", "cus_empty", "sub_old", 4000)
	fake.raw["cus_empty"] = `{"object":"list","data":[],"has_more":false,"url":"/v1/subscriptions"}`
	svc.ReconcileStripeSubscriptions(context.Background())
	bm3AssertFree(t, store, u.ID, "well-formed empty list")
}
