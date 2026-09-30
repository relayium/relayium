package account

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// B-M3: the reconcile sweep may downgrade a Stripe-paid user only on complete,
// current evidence, and its write must never outrank a genuine Stripe event.
// These tests drive the REAL stripeClient against a fake Stripe HTTP server, so
// the pagination and error handling under test are the production ones.

const bm3LocalNow = 10_000 // the sweep's local clock, deliberately ahead of every Stripe event clock below

type bm3Sub struct {
	ID, Status, Price string
	Created, EndedAt  int64
}

// bm3Stripe is a fake GET /v1/subscriptions: per-customer pages, optional
// per-customer failure, and a hook that runs while the list request is being
// served (i.e. after the sweep observed the user, before it writes).
type bm3Stripe struct {
	mu       sync.Mutex
	pages    map[string][][]bm3Sub // customer -> pages
	hasMore  map[string]bool       // customer -> force has_more on the LAST page (cursorless/endless history)
	fail     map[string]int        // customer -> HTTP status to fail with
	onList   map[string]func()     // customer -> hook run inside the list request
	endless  map[string]bool       // customer -> every page has one ended sub and has_more=true
	requests map[string][]string   // customer -> starting_after values seen
}

func newBM3Stripe(t *testing.T) (*bm3Stripe, *stripeClient) {
	t.Helper()
	f := &bm3Stripe{pages: map[string][][]bm3Sub{}, hasMore: map[string]bool{}, fail: map[string]int{}, onList: map[string]func(){}, endless: map[string]bool{}, requests: map[string][]string{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/subscriptions" {
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
			return
		}
		q := r.URL.Query()
		cus, after := q.Get("customer"), q.Get("starting_after")
		f.mu.Lock()
		f.requests[cus] = append(f.requests[cus], after)
		hook := f.onList[cus]
		status := f.fail[cus]
		pages := f.pages[cus]
		forceMore := f.hasMore[cus]
		endless := f.endless[cus]
		n := len(f.requests[cus])
		f.mu.Unlock()
		if hook != nil {
			hook()
		}
		if status != 0 {
			http.Error(w, `{"error":{"message":"boom"}}`, status)
			return
		}
		if endless && status == 0 {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"data":[{"id":"sub_e_%d","status":"canceled","created":1}],"has_more":true}`, n)
			return
		}
		idx := 0
		if after != "" {
			idx = -1
			for i, p := range pages {
				if len(p) > 0 && p[len(p)-1].ID == after {
					idx = i + 1
				}
			}
			if idx < 0 {
				http.Error(w, "unknown cursor", http.StatusBadRequest)
				return
			}
		}
		type item struct {
			Price struct {
				ID string `json:"id"`
			} `json:"price"`
		}
		type sub struct {
			ID      string `json:"id"`
			Status  string `json:"status"`
			Created int64  `json:"created"`
			EndedAt int64  `json:"ended_at,omitempty"`
			Items   struct {
				Data []item `json:"data"`
			} `json:"items"`
		}
		out := struct {
			Data    []sub `json:"data"`
			HasMore bool  `json:"has_more"`
		}{Data: []sub{}}
		if idx < len(pages) {
			for _, s := range pages[idx] {
				v := sub{ID: s.ID, Status: s.Status, Created: s.Created, EndedAt: s.EndedAt}
				var it item
				it.Price.ID = s.Price
				v.Items.Data = []item{it}
				out.Data = append(out.Data, v)
			}
			out.HasMore = idx < len(pages)-1
		}
		if forceMore && idx >= len(pages)-1 {
			out.HasMore = true
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(server.Close)
	client := NewStripeClient("sk_test_bm3", "whsec_bm3", "")
	client.base, client.http = server.URL, server.Client()
	return f, client
}

// bm3PaidUser creates a user on plus via a Stripe event applied at eventAt,
// bound to subscription subID on customer cus.
func bm3PaidUser(t *testing.T, store *SQLiteStore, email, cus, subID string, eventAt int64) User {
	t.Helper()
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, email, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeCustomer(ctx, u.ID, cus); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(ctx, u.ID, subID); err != nil {
		t.Fatal(err)
	}
	bm3Event(t, store, u.ID, "plus", "active", subID, 1_900_000_000, eventAt)
	return u
}

// bm3Event applies a Stripe subscription event exactly the way the webhook's
// applyStripeLifecycle does, and returns whether it was applied (false = stale).
func bm3Event(t *testing.T, store *SQLiteStore, userID, plan, status, subID string, periodEnd, eventAt int64) bool {
	t.Helper()
	res, err := store.ApplyAuthorizedStripeLifecycle(context.Background(), SourceEvent{
		UserID: userID, Provider: ProviderStripe, PlanID: plan, Status: status, Cycle: "monthly",
		PeriodEnd: periodEnd, ExternalID: subID, EventAt: eventAt, Now: bm3LocalNow,
	})
	if err != nil {
		t.Fatalf("apply Stripe event at %d: %v", eventAt, err)
	}
	return res.Applied
}

func bm3Service(t *testing.T, client *stripeClient) (*Service, *SQLiteStore) {
	t.Helper()
	_, svc, store, _ := newBillingServer(t)
	svc.biller = client
	svc.now = func() time.Time { return time.Unix(bm3LocalNow, 0) }
	return svc, store
}

func bm3Plan(t *testing.T, store *SQLiteStore, userID string) (string, string) {
	t.Helper()
	u, err := store.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	return u.PlanID, u.SubscriptionStatus
}

// (a) A webhook that grants a new subscription AFTER the sweep observed the
// user but BEFORE it writes must win: the user stays paid, and a later genuine
// event — still older than the sweep's local clock — is not dropped as stale.
func TestBM3SweepYieldsToWebhookBetweenObservationAndWrite(t *testing.T) {
	// webhookAt is the concurrent webhook's Stripe event.created. A later second
	// is refused by the replay clock AND the compare-and-set; the SAME second as
	// the observed event (Stripe stamps whole seconds) passes the replay clock,
	// so only the compare-and-set stops the downgrade there.
	for _, webhookAt := range []int64{4500, 4000} {
		t.Run(fmt.Sprintf("webhook_at_%d", webhookAt), func(t *testing.T) {
			fake, client := newBM3Stripe(t)
			svc, store := bm3Service(t, client)
			ctx := context.Background()
			u := bm3PaidUser(t, store, "bm3-race@example.com", "cus_race", "sub_old", 4000)

			// Stripe's list, as answered, shows nothing live (the old
			// subscription ended); while the request is in flight the webhook for
			// the customer's new subscription is applied.
			fake.pages["cus_race"] = [][]bm3Sub{{{ID: "sub_old", Status: "canceled", Created: 3000}}}
			fake.onList["cus_race"] = func() {
				if !bm3Event(t, store, u.ID, "plus", "active", "sub_new", 1_950_000_000, webhookAt) {
					t.Error("the concurrent grant webhook was refused")
				}
			}

			svc.ReconcileStripeSubscriptions(ctx)

			if plan, status := bm3Plan(t, store, u.ID); plan != "plus" || status != "active" {
				t.Fatalf("sweep overwrote a webhook applied while it was deciding: plan=%q status=%q, want plus/active", plan, status)
			}
			// The refused downgrade must not have cleared any binding either.
			if got, _ := store.GetUserByID(ctx, u.ID); got.StripeSubscriptionID != "sub_old" {
				t.Fatalf("sweep touched the canonical subscription id: %q, want it left as sub_old", got.StripeSubscriptionID)
			}
			if src, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe); src.ExternalID != "sub_new" {
				t.Fatalf("sweep cleared the webhook's subscription binding: %q", src.ExternalID)
			}
			// The next genuine event (a renewal at Stripe time 4700 < local 10000).
			if !bm3Event(t, store, u.ID, "plus", "active", "sub_new", 1_960_000_000, 4700) {
				t.Fatal("a genuine Stripe event after the sweep was dropped as stale")
			}
			src, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
			if src.EventAt != 4700 || src.PeriodEnd != 1_960_000_000 {
				t.Fatalf("stripe row after renewal: %+v", src)
			}
		})
	}
}

// (a') A downgrade that DOES apply is stamped with the Stripe clock it observed,
// not the local clock: a re-subscription whose event was created before the
// local "now" (but after the sweep's evidence) still applies.
func TestBM3SweepDowngradeDoesNotOutrankLaterGenuineEvent(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	ctx := context.Background()
	u := bm3PaidUser(t, store, "bm3-stamp@example.com", "cus_stamp", "sub_gone", 4000)
	fake.pages["cus_stamp"] = [][]bm3Sub{{{ID: "sub_gone", Status: "canceled", Created: 3000}}}

	svc.ReconcileStripeSubscriptions(ctx)
	if plan, _ := bm3Plan(t, store, u.ID); plan != "free" {
		t.Fatalf("genuinely canceled user not downgraded: plan=%q", plan)
	}
	src, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
	if src.EventAt != 4000 {
		t.Errorf("downgrade stamped with event_at=%d, want the observed Stripe clock 4000 (never the local clock %d)", src.EventAt, bm3LocalNow)
	}
	// Re-subscription webhook, Stripe time 5000: newer than any evidence the
	// sweep had, older than the local clock.
	if !bm3Event(t, store, u.ID, "plus", "active", "sub_again", 1_990_000_000, 5000) {
		t.Fatal("re-subscription event after the sweep's downgrade was dropped as stale")
	}
	if plan, status := bm3Plan(t, store, u.ID); plan != "plus" || status != "active" {
		t.Fatalf("re-subscribed user left on plan=%q status=%q", plan, status)
	}
}

// (e) Residual early-grant path: the last event we applied is an `active` at
// 4000; the subscription was canceled and ENDED at 6000 but that deletion
// webhook was lost. A stale `active` update created at 5000 (between the two)
// is delivered late — a retry or a dashboard resend — AFTER the sweep. It must
// not re-grant the tier; a genuine re-subscription created after the end must.
func TestBM3SweepStampMakesLateStaleGrantStale(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	ctx := context.Background()
	u := bm3PaidUser(t, store, "bm3-stalegrant@example.com", "cus_stale", "sub_old", 4000)
	fake.pages["cus_stale"] = [][]bm3Sub{{
		{ID: "sub_older", Status: "canceled", Created: 1000, EndedAt: 2000},
		{ID: "sub_old", Status: "canceled", Created: 3000, EndedAt: 6000},
		{ID: "sub_abandoned", Status: "incomplete", Created: 3500},
	}}

	svc.ReconcileStripeSubscriptions(ctx)
	if plan, _ := bm3Plan(t, store, u.ID); plan != "free" {
		t.Fatalf("genuinely ended subscription not downgraded: plan=%q", plan)
	}
	src, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
	if src.EventAt != 6000 {
		t.Errorf("downgrade stamped with event_at=%d, want the latest ended_at 6000", src.EventAt)
	}

	if bm3Event(t, store, u.ID, "plus", "active", "sub_old", 1_900_000_000, 5000) {
		t.Error("a late stale grant from before the cancellation was applied after the sweep")
	}
	if plan, _ := bm3Plan(t, store, u.ID); plan != "free" {
		t.Fatalf("late stale grant re-granted a paid tier nobody pays for: plan=%q", plan)
	}

	// A genuine re-subscription created after the end (7000 < local 10000).
	if !bm3Event(t, store, u.ID, "plus", "active", "sub_again", 1_990_000_000, 7000) {
		t.Fatal("genuine re-subscription after the cancellation was dropped as stale")
	}
	if plan, status := bm3Plan(t, store, u.ID); plan != "plus" || status != "active" {
		t.Fatalf("re-subscribed user left on plan=%q status=%q", plan, status)
	}
}

// (e') A re-subscription created in the SAME Stripe second the old one ended
// is still applied (the replay guard is strictly-older).
func TestBM3SweepStampAdmitsSameSecondResubscription(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	u := bm3PaidUser(t, store, "bm3-samesec@example.com", "cus_same", "sub_old", 4000)
	fake.pages["cus_same"] = [][]bm3Sub{{{ID: "sub_old", Status: "canceled", Created: 3000, EndedAt: 6000}}}

	svc.ReconcileStripeSubscriptions(context.Background())
	if !bm3Event(t, store, u.ID, "plus", "active", "sub_again", 1_990_000_000, 6000) {
		t.Fatal("re-subscription in the same second as the end was dropped as stale")
	}
}

// (e”) An ended_at in the future is implausible evidence: the sweep falls back
// to the observed clock rather than let it censor genuine events.
func TestBM3SweepIgnoresImplausibleEndedAt(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	ctx := context.Background()
	u := bm3PaidUser(t, store, "bm3-future@example.com", "cus_future", "sub_old", 4000)
	fake.pages["cus_future"] = [][]bm3Sub{{{ID: "sub_old", Status: "canceled", Created: 3000, EndedAt: bm3LocalNow + maxReconcileEndedAtSkew + 1}}}

	svc.ReconcileStripeSubscriptions(ctx)
	src, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
	if src.PlanID != "free" || src.EventAt != 4000 {
		t.Fatalf("want free stamped at the observed clock 4000, got %+v", src)
	}
	if !bm3Event(t, store, u.ID, "plus", "active", "sub_again", 1_990_000_000, 8000) {
		t.Fatal("a genuine event was censored by an implausible future ended_at")
	}
}

// (b) The customer's live subscription is on page 2 behind 100 ended ones: the
// sweep must walk has_more/starting_after and leave the user paid.
func TestBM3SweepFollowsPaginationToLiveSubscription(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	u := bm3PaidUser(t, store, "bm3-pages@example.com", "cus_pages", "sub_live", 4000)
	page1 := make([]bm3Sub, 100)
	for i := range page1 {
		page1[i] = bm3Sub{ID: fmt.Sprintf("sub_dead_%03d", i), Status: "incomplete_expired", Created: int64(3900 - i)}
	}
	fake.pages["cus_pages"] = [][]bm3Sub{page1, {{ID: "sub_live", Status: "active", Price: "price_plus", Created: 100}}}

	svc.ReconcileStripeSubscriptions(context.Background())

	if plan, status := bm3Plan(t, store, u.ID); plan != "plus" || status != "active" {
		t.Fatalf("user whose live subscription is on page 2 was downgraded: plan=%q status=%q", plan, status)
	}
	if got := fake.requests["cus_pages"]; len(got) != 2 || got[0] != "" || got[1] != "sub_dead_099" {
		t.Fatalf("pagination requests = %q, want [\"\" \"sub_dead_099\"]", got)
	}
}

// (b') has_more that cannot be continued, or a history that never ends, is
// unknown evidence: no downgrade.
func TestBM3SweepTreatsUnwalkableHistoryAsUnknown(t *testing.T) {
	for _, tc := range []struct {
		name  string
		pages [][]bm3Sub
	}{
		{"has_more with empty page", [][]bm3Sub{{}}},
		{"has_more past the last page", [][]bm3Sub{{{ID: "sub_x", Status: "canceled"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake, client := newBM3Stripe(t)
			svc, store := bm3Service(t, client)
			u := bm3PaidUser(t, store, "bm3-unwalkable@example.com", "cus_more", "sub_x", 4000)
			fake.pages["cus_more"] = tc.pages
			fake.hasMore["cus_more"] = true

			svc.ReconcileStripeSubscriptions(context.Background())

			if plan, _ := bm3Plan(t, store, u.ID); plan != "plus" {
				t.Fatalf("truncated subscription history was taken as 'no live subscription': plan=%q", plan)
			}
		})
	}
}

// (b”) A history longer than the page cap is unknown, not an endless walk and
// not "none".
func TestBM3SweepBoundsEndlessHistory(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	u := bm3PaidUser(t, store, "bm3-endless@example.com", "cus_endless", "sub_e", 4000)
	fake.endless["cus_endless"] = true

	svc.ReconcileStripeSubscriptions(context.Background())

	if n := len(fake.requests["cus_endless"]); n != maxSubscriptionListPages {
		t.Fatalf("walked %d pages, want the cap %d", n, maxSubscriptionListPages)
	}
	if plan, _ := bm3Plan(t, store, u.ID); plan != "plus" {
		t.Fatalf("a history over the page cap was taken as 'no live subscription': plan=%q", plan)
	}
}

// (c) A Stripe API error for one customer skips THAT user; the sweep carries on
// and still downgrades a genuinely canceled user after it.
func TestBM3SweepAPIErrorSkipsOnlyThatUser(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	errUser := bm3PaidUser(t, store, "bm3-err@example.com", "cus_err", "sub_err", 4000)
	gone := bm3PaidUser(t, store, "bm3-gone@example.com", "cus_gone", "sub_gone", 4000)
	fake.fail["cus_err"] = http.StatusServiceUnavailable
	fake.pages["cus_gone"] = [][]bm3Sub{{{ID: "sub_gone", Status: "canceled"}}}

	svc.ReconcileStripeSubscriptions(context.Background())

	if plan, _ := bm3Plan(t, store, errUser.ID); plan != "plus" {
		t.Fatalf("a Stripe API error downgraded the user: plan=%q", plan)
	}
	if plan, _ := bm3Plan(t, store, gone.ID); plan != "free" {
		t.Fatalf("sweep stopped after an API error; canceled user left on %q", plan)
	}
}

// (c') An error on a LATER page must not leave the first page's (empty) answer
// standing as "none".
func TestBM3SweepErrorOnLaterPageIsUnknown(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	u := bm3PaidUser(t, store, "bm3-page2err@example.com", "cus_p2", "sub_p2", 4000)
	fake.pages["cus_p2"] = [][]bm3Sub{{{ID: "sub_dead", Status: "canceled"}}, {{ID: "sub_p2", Status: "active"}}}
	// The hook runs after this request's outcome is fixed, so page 1's hook
	// arms the failure for page 2.
	fake.onList["cus_p2"] = func() {
		fake.mu.Lock()
		fake.fail["cus_p2"] = http.StatusBadGateway
		fake.mu.Unlock()
	}

	svc.ReconcileStripeSubscriptions(context.Background())

	if n := len(fake.requests["cus_p2"]); n != 2 {
		t.Fatalf("want the sweep to request page 2 (2 requests), got %d", n)
	}
	if plan, _ := bm3Plan(t, store, u.ID); plan != "plus" {
		t.Fatalf("an error on page 2 downgraded the user: plan=%q", plan)
	}
}

// (d) Positive control: a genuinely canceled subscription is downgraded exactly
// once — the first sweep downgrades and clears the binding, a second sweep does
// not touch Stripe or the row again.
func TestBM3SweepDowngradesGenuineCancellationExactlyOnce(t *testing.T) {
	fake, client := newBM3Stripe(t)
	svc, store := bm3Service(t, client)
	ctx := context.Background()
	u := bm3PaidUser(t, store, "bm3-once@example.com", "cus_once", "sub_once", 4000)
	if err := store.SetScheduledPlan(ctx, u.ID, "lite", "monthly"); err != nil {
		t.Fatal(err)
	}
	fake.pages["cus_once"] = [][]bm3Sub{{{ID: "sub_once", Status: "canceled", Created: 3000}}}

	svc.ReconcileStripeSubscriptions(ctx)
	got, _ := store.GetUserByID(ctx, u.ID)
	if got.PlanID != "free" || got.SubscriptionStatus != "canceled" || got.StripeSubscriptionID != "" || got.ScheduledPlanID != "" {
		t.Fatalf("after first sweep: plan=%q status=%q sub=%q scheduled=%q", got.PlanID, got.SubscriptionStatus, got.StripeSubscriptionID, got.ScheduledPlanID)
	}
	src, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
	if src.PlanID != "free" || src.Status != "canceled" || src.ExternalID != "" {
		t.Fatalf("stripe row after first sweep: %+v", src)
	}

	svc.ReconcileStripeSubscriptions(ctx)
	if n := len(fake.requests["cus_once"]); n != 1 {
		t.Fatalf("second sweep re-listed an already-downgraded user (%d list requests)", n)
	}
	if again, _, _ := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe); again != src {
		t.Fatalf("second sweep rewrote the row:\n before %+v\n after  %+v", src, again)
	}
}

// The store-level compare-and-set itself: a changed row refuses the downgrade
// and leaves both the row and the binding alone; a missing row is a no-op.
func TestBM3StoreDowngradeIsConditionalOnObservedRow(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u := bm3PaidUser(t, store, "bm3-cas@example.com", "cus_cas", "sub_a", 4000)
	observed, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
	if err != nil || !ok {
		t.Fatalf("observe: ok=%v err=%v", ok, err)
	}
	// Same plan, same status, same clock — only the period end moved (a renewal
	// applied with an equal-second event). Still a change; must not be overwritten.
	bm3Event(t, store, u.ID, "plus", "active", "sub_a", 1_950_000_000, 4000)
	applied, err := store.ApplyStripeReconcileDowngrade(ctx, observed, 0, bm3LocalNow)
	if err != nil || applied {
		t.Fatalf("downgrade on a moved row: applied=%v err=%v", applied, err)
	}
	if got, _ := store.GetUserByID(ctx, u.ID); got.PlanID != "plus" || got.StripeSubscriptionID != "sub_a" {
		t.Fatalf("refused downgrade still changed the user: plan=%q sub=%q", got.PlanID, got.StripeSubscriptionID)
	}
	bare, err := store.UpsertUserByEmail(ctx, "bm3-norow@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if applied, err := store.ApplyStripeReconcileDowngrade(ctx, SubscriptionSource{UserID: bare.ID, Provider: ProviderStripe}, 0, bm3LocalNow); err != nil || applied {
		t.Fatalf("downgrade for a user with no Stripe row: applied=%v err=%v", applied, err)
	}
	if _, ok, _ := store.GetSubscriptionSource(ctx, bare.ID, ProviderStripe); ok {
		t.Fatal("a refused downgrade created a Stripe row")
	}
}

// The evidence walk takes the latest ended_at across EVERY page, ignores the
// live subscriptions' fields for it, and reports the live set unchanged.
func TestBM3EvidenceLatestEndedAtSpansPages(t *testing.T) {
	fake, client := newBM3Stripe(t)
	fake.pages["cus_ev"] = [][]bm3Sub{
		{{ID: "sub_a", Status: "canceled", Created: 50, EndedAt: 300}},
		{{ID: "sub_live", Status: "active", Created: 10, EndedAt: 999999}, {ID: "sub_b", Status: "incomplete_expired", Created: 5, EndedAt: 700}},
	}
	ev, err := client.ListSubscriptionEvidence(context.Background(), "cus_ev")
	if err != nil {
		t.Fatal(err)
	}
	if ev.LatestEndedAt != 700 || len(ev.Live) != 1 || ev.Live[0].ID != "sub_live" {
		t.Fatalf("evidence = %+v, want LatestEndedAt 700 and live [sub_live]", ev)
	}
	live, err := client.ListActiveSubscriptions(context.Background(), "cus_ev")
	if err != nil || len(live) != 1 || live[0].ID != "sub_live" {
		t.Fatalf("ListActiveSubscriptions = %+v, %v", live, err)
	}
}
