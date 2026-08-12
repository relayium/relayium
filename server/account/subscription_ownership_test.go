package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
)

// One external subscription has exactly one owner, and that ownership is
// established in the SAME transaction as the state it justifies. These tests
// exercise the two halves separately: the store, where the binding lives, and
// the webhook, which is the only caller that can currently reach it.

// The canonical external id travels WITH the event that carries it. An adapter
// that had to bind first and grant afterwards would leave a window in which the
// user has the tier but no recorded ownership of the subscription paying for
// it — and a crash inside that window is a granted tier nobody can reconcile,
// refund or cancel.
func TestSourceEventBindsExternalIDInTheSameTransaction(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()
	u := newEntitlementUser(t, store, "bind-with-event@example.com")

	res, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderApple, PlanID: "pro", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_900_000_000, ExternalID: "orig_tx_1",
		EventAt: 100, Now: fixedNow,
	})
	if err != nil || !res.Applied {
		t.Fatalf("first bind: applied=%v err=%v", res.Applied, err)
	}
	row, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderApple)
	if err != nil || !ok {
		t.Fatalf("source row: ok=%v err=%v", ok, err)
	}
	if row.ExternalID != "orig_tx_1" || row.PlanID != "pro" {
		t.Fatalf("grant and binding did not land together: %+v", row)
	}
	if owner, ok, err := store.UserByExternalSubscription(ctx, ProviderApple, "orig_tx_1"); err != nil || !ok || owner != u.ID {
		t.Fatalf("owner lookup: %q ok=%v err=%v", owner, ok, err)
	}

	// A later event carrying a NEW id for the same user replaces it (Apple
	// re-subscribes under a fresh original transaction id after a lapse).
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderApple, PlanID: "max", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_950_000_000, ExternalID: "orig_tx_2",
		EventAt: 200, Now: fixedNow,
	}); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	row, _, _ = store.GetSubscriptionSource(ctx, u.ID, ProviderApple)
	if row.ExternalID != "orig_tx_2" {
		t.Fatalf("new id did not replace the old: %+v", row)
	}

	// An event that carries NO id leaves the recorded one alone. Most events do
	// not carry one, and blanking it would silently drop the ownership record
	// that cancel/refund/reconcile all depend on.
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderApple, PlanID: "max", Status: "past_due",
		PeriodEnd: 1_950_000_000, EventAt: 300, Now: fixedNow,
	}); err != nil {
		t.Fatalf("status-only event: %v", err)
	}
	row, _, _ = store.GetSubscriptionSource(ctx, u.ID, ProviderApple)
	if row.ExternalID != "orig_tx_2" {
		t.Fatalf("a status-only event blanked the canonical id: %+v", row)
	}
	if row.Status != "past_due" {
		t.Fatalf("status-only event did not apply: %+v", row)
	}
}

// The adversarial half: an event whose external id belongs to somebody else is
// refused, and NOTHING it carried is written — not the source row, not the
// users projection. A partial application here is the worst outcome available:
// the claimant would hold a tier granted by a subscription the system knows
// belongs to another account.
func TestSourceEventWithForeignExternalIDRollsBackEverything(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()
	owner := newEntitlementUser(t, store, "sub-owner@example.com")
	claimant := newEntitlementUser(t, store, "sub-claimant@example.com")

	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: owner.ID, Provider: ProviderApple, PlanID: "pro", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_900_000_000, ExternalID: "orig_shared",
		EventAt: 100, Now: fixedNow,
	}); err != nil {
		t.Fatalf("owner bind: %v", err)
	}
	// The claimant already holds a modest, legitimate subscription of their own:
	// the rollback has to leave THAT intact too, not just refuse the upgrade.
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: claimant.ID, Provider: ProviderApple, PlanID: "plus", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_800_000_000, ExternalID: "orig_claimant",
		EventAt: 100, Now: fixedNow,
	}); err != nil {
		t.Fatalf("claimant seed: %v", err)
	}
	before := mustUser(t, store, claimant.ID)
	beforeRow, _, _ := store.GetSubscriptionSource(ctx, claimant.ID, ProviderApple)

	_, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: claimant.ID, Provider: ProviderApple, PlanID: "max", Status: "active",
		Cycle: "yearly", PeriodEnd: 1_950_000_000, ExternalID: "orig_shared",
		EventAt: 200, Now: fixedNow,
	})
	if !errors.Is(err, ErrExternalSubscriptionOwned) {
		t.Fatalf("want ErrExternalSubscriptionOwned, got %v", err)
	}

	afterRow, _, _ := store.GetSubscriptionSource(ctx, claimant.ID, ProviderApple)
	if afterRow != beforeRow {
		t.Fatalf("the refused event mutated the source row: %+v -> %+v", beforeRow, afterRow)
	}
	after := mustUser(t, store, claimant.ID)
	if after.PlanID != before.PlanID || after.SubscriptionEnd != before.SubscriptionEnd ||
		after.BillingCycle != before.BillingCycle || after.PlanStartedAt != before.PlanStartedAt {
		t.Fatalf("the refused event moved the projection: %+v -> %+v", before, after)
	}
	// And the real owner is untouched.
	if got, ok, err := store.UserByExternalSubscription(ctx, ProviderApple, "orig_shared"); err != nil || !ok || got != owner.ID {
		t.Fatalf("ownership moved: %q ok=%v err=%v", got, ok, err)
	}
}

// Ordinary Stripe traffic must be unaffected: the canonical id is recorded once
// (at adoption) and every subsequent status event leaves both copies of it —
// the users column the dedup reads and the source row's external_id — alone.
func TestOrdinaryStripeEventsPreserveTheCanonicalSubscriptionID(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()
	u := newEntitlementUser(t, store, "stripe-canonical@example.com")
	if err := store.SetUserStripeCustomer(ctx, u.ID, "cus_keep"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(ctx, u.ID, "sub_keep"); err != nil {
		t.Fatalf("adopt canonical: %v", err)
	}

	for i, st := range []string{"active", "past_due", "active"} {
		if err := store.SetUserSubscription(ctx, u.ID, "pro", st, 1_900_000_000, "stripe", "monthly",
			fixedNow, int64(100+i)); err != nil {
			t.Fatalf("event %d: %v", i, err)
		}
		got := mustUser(t, store, u.ID)
		if got.StripeSubscriptionID != "sub_keep" {
			t.Fatalf("event %d blanked users.stripe_subscription_id: %q", i, got.StripeSubscriptionID)
		}
		row, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
		if err != nil || !ok {
			t.Fatalf("event %d: source row ok=%v err=%v", i, ok, err)
		}
		if row.ExternalID != "sub_keep" {
			t.Fatalf("event %d blanked the source row's external id: %+v", i, row)
		}
	}
}

// ---- the index behind the precheck -------------------------------------------

// The explicit precheck is what normally produces ErrExternalSubscriptionOwned,
// and inside one process it always wins: the write pool is a single connection
// taking an IMMEDIATE lock, so check and claim are one serialized unit. Across
// INSTANCES that is no longer true, and any future write path that reorders the
// two would lose the guarantee as well — in both cases the unique index is what
// refuses the second claimant, and it speaks in raw constraint violations. The
// error every caller switches on must be the same one either way, so the two
// write statements that can violate that index translate it.
//
// The classifier has to be narrow: a UNIQUE-index violation is the ONLY failure
// that means "somebody else owns this". A locked database, a foreign key, a NOT
// NULL, a missing table are all real faults that must keep propagating as
// themselves — reported as "already owned" they would be permanently
// misdiagnosed as a conflict nobody can resolve.
func TestUniqueConstraintClassifierIsNarrow(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()
	owner := newEntitlementUser(t, store, "index-owner@example.com")
	other := newEntitlementUser(t, store, "index-other@example.com")

	// A real binding, so the index has something to collide with.
	if err := store.BindExternalSubscription(ctx, owner.ID, ProviderApple, "orig_indexed"); err != nil {
		t.Fatalf("seed binding: %v", err)
	}

	// Exactly the statement bindExternalSubscriptionTx issues, run WITHOUT the
	// precheck — the interleaving a second instance can produce. It must be
	// recognized, so the caller sees the ownership error rather than a driver
	// string.
	_, err := store.db.ExecContext(ctx,
		`INSERT INTO subscription_sources (user_id, provider, plan_id, status, cycle, period_end, external_id, event_at, updated_at)
		 VALUES (?, ?, 'free', '', '', 0, ?, 0, 0)
		 ON CONFLICT(user_id, provider) DO UPDATE SET external_id = excluded.external_id`,
		other.ID, ProviderApple, "orig_indexed")
	if err == nil {
		t.Fatal("the unique index let a second user claim one external subscription")
	}
	if !isExternalSubscriptionConflict(err) {
		t.Fatalf("the index's own refusal is not recognized as a conflict: %v", err)
	}

	// Everything else is a fault, not a conflict.
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"nil", nil},
		{"no rows", sql.ErrNoRows},
		{"a plain error", errors.New("boom")},
		{"context canceled", context.Canceled},
		{"primary key", execErr(t, store, `INSERT INTO subscription_sources (user_id, provider, plan_id) VALUES (?, ?, 'pro')`, owner.ID, ProviderApple)},
		{"foreign key", execErr(t, store, `INSERT INTO apple_products (bundle_id, product_id, plan_id, cycle, active) VALUES ('b', 'p', 'no-such-tier', 'monthly', 1)`)},
		{"not null", execErr(t, store, `INSERT INTO subscription_sources (user_id, provider, plan_id) VALUES (?, ?, NULL)`, other.ID, ProviderStripe)},
		{"no such table", execErr(t, store, `INSERT INTO not_a_table (x) VALUES (1)`)},
	} {
		if isExternalSubscriptionConflict(tc.err) {
			t.Fatalf("%s was misread as an ownership conflict: %v", tc.name, tc.err)
		}
	}
}

// execErr runs a statement expected to FAIL and returns the driver's error, so
// the classifier is tested against errors SQLite actually produces rather than
// hand-built stand-ins.
func execErr(t *testing.T, store *SQLiteStore, q string, args ...any) error {
	t.Helper()
	_, err := store.db.ExecContext(context.Background(), q, args...)
	if err == nil {
		t.Fatalf("statement unexpectedly succeeded: %s", q)
	}
	return err
}

// The contract every caller relies on, under concurrent claimants: one external
// subscription ends with exactly ONE owner, every loser is told why in the one
// vocabulary the callers switch on, and no claim half-lands. Both write paths
// race together because both must answer identically — the webhook's adoption
// (SetUserStripeSubscription) and a direct bind.
func TestConcurrentClaimsLeaveOneOwnerAndOneError(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()

	const claimants = 8
	users := make([]User, claimants)
	for i := range users {
		users[i] = newEntitlementUser(t, store, fmt.Sprintf("racer-%d@example.com", i))
	}

	var wg sync.WaitGroup
	errs := make([]error, claimants)
	start := make(chan struct{})
	for i := range users {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			if i%2 == 0 {
				errs[i] = store.SetUserStripeSubscription(ctx, users[i].ID, "sub_contested")
			} else {
				errs[i] = store.BindExternalSubscription(ctx, users[i].ID, ProviderStripe, "sub_contested")
			}
		}(i)
	}
	close(start)
	wg.Wait()

	winners := 0
	for i, err := range errs {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, ErrExternalSubscriptionOwned):
		default:
			t.Fatalf("claimant %d got a raw failure instead of the ownership error: %v", i, err)
		}
	}
	if winners != 1 {
		t.Fatalf("one external subscription ended with %d owners", winners)
	}

	owner, ok, err := store.UserByExternalSubscription(ctx, ProviderStripe, "sub_contested")
	if err != nil || !ok {
		t.Fatalf("owner lookup: ok=%v err=%v", ok, err)
	}
	// Every loser is left exactly as it was: no binding, and — for the
	// SetUserStripeSubscription half — no canonical id on the users row either,
	// because that write shares the refused transaction.
	for i, u := range users {
		if u.ID == owner {
			if errs[i] != nil {
				t.Fatalf("the recorded owner is a claimant that failed: %v", errs[i])
			}
			continue
		}
		row, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
		if err != nil {
			t.Fatal(err)
		}
		if ok && row.ExternalID != "" {
			t.Fatalf("loser %d kept a binding: %+v", i, row)
		}
		if got := mustUser(t, store, u.ID); got.StripeSubscriptionID != "" {
			t.Fatalf("loser %d kept a canonical id: %q", i, got.StripeSubscriptionID)
		}
	}
}

// ---- callers -----------------------------------------------------------------

// The webhook adopts the first subscription id it sees as canonical. If that id
// already belongs to another account, adopting it is refused — and the grant
// that followed it must not happen either. Discarding the refusal would leave
// the claimant holding a paid tier justified by somebody else's subscription,
// which is both a free tier and an unrefundable one.
func TestWebhookWillNotGrantOnAnotherUsersSubscription(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_owned"
	svc.biller = &dedupBiller{stripeClient: NewStripeClient("sk_test", secret, "")}
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	ctx := context.Background()

	_ = loginCookie(t, ts, mail, "owner-webhook@example.com")
	ownerID := mustUserID(t, store, "owner-webhook@example.com")
	if err := store.SetUserStripeCustomer(ctx, ownerID, "cus_owner"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(ctx, ownerID, "sub_owned"); err != nil {
		t.Fatal(err)
	}

	_ = loginCookie(t, ts, mail, "claimant-webhook@example.com")
	claimantID := mustUserID(t, store, "claimant-webhook@example.com")
	if err := store.SetUserStripeCustomer(ctx, claimantID, "cus_claimant"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_claimant", "sub_owned", "", "active", "price_pro_m", 1<<40)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("the webhook ACKed an event it could not apply — the conflict is now invisible")
	}

	claimant, err := store.GetUserByID(ctx, claimantID)
	if err != nil {
		t.Fatal(err)
	}
	if claimant.PlanID != "free" || claimant.StripeSubscriptionID != "" {
		t.Fatalf("another user's subscription granted a plan: plan=%q canonical=%q",
			claimant.PlanID, claimant.StripeSubscriptionID)
	}
	if got, ok, err := store.UserByExternalSubscription(ctx, ProviderStripe, "sub_owned"); err != nil || !ok || got != ownerID {
		t.Fatalf("ownership moved to the claimant: %q ok=%v err=%v", got, ok, err)
	}
}

// The reconcile path picks a canonical from LIVE Stripe state and then cancels
// and refunds everything else on the customer. If the chosen canonical cannot
// be bound, the whole reconciliation is wrong — so it must stop BEFORE the
// destructive half, not merely skip the binding and carry on refunding.
func TestReconcileWillNotAdoptAnotherUsersCanonicalSubscription(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_reconcile_owned"
	biller := &dedupBiller{stripeClient: NewStripeClient("sk_test", secret, ""), active: []SubscriptionInfo{
		{ID: "sub_foreign", Created: 100, PriceID: "price_pro_m", Status: "active", CurrentPeriodEnd: 1 << 40},
		{ID: "sub_mine", Created: 200, PriceID: "price_pro_m", Status: "active", CurrentPeriodEnd: 1 << 40},
	}}
	svc.biller = biller
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true, StripePriceMonthlyID: "price_plus_m"})
	ctx := context.Background()

	_ = loginCookie(t, ts, mail, "owner-reconcile@example.com")
	ownerID := mustUserID(t, store, "owner-reconcile@example.com")
	if err := store.SetUserStripeCustomer(ctx, ownerID, "cus_r_owner"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(ctx, ownerID, "sub_foreign"); err != nil {
		t.Fatal(err)
	}

	_ = loginCookie(t, ts, mail, "claimant-reconcile@example.com")
	claimantID := mustUserID(t, store, "claimant-reconcile@example.com")
	if err := store.SetUserStripeCustomer(ctx, claimantID, "cus_r_claimant"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(ctx, claimantID, "sub_mine"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(ctx, claimantID, "plus", "active", 1<<40, "stripe", "monthly", fixedNow, 100); err != nil {
		t.Fatal(err)
	}

	// An event for a THIRD subscription id triggers reconciliation, which reads
	// live Stripe state and picks the earliest — a subscription owned by
	// somebody else.
	body := webhookEnv("customer.subscription.created", "cus_r_claimant", "sub_third", "", "active", "price_pro_m", 1<<40)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("reconcile ACKed a reconciliation it could not carry out")
	}
	if len(biller.canceled) != 0 {
		t.Fatalf("subscriptions were canceled/refunded on a reconciliation that could not bind its canonical: %v", biller.canceled)
	}
	claimant, err := store.GetUserByID(ctx, claimantID)
	if err != nil {
		t.Fatal(err)
	}
	if claimant.PlanID != "plus" || claimant.StripeSubscriptionID != "sub_mine" {
		t.Fatalf("the failed reconciliation rewrote the user: plan=%q canonical=%q",
			claimant.PlanID, claimant.StripeSubscriptionID)
	}
	if got, ok, err := store.UserByExternalSubscription(ctx, ProviderStripe, "sub_foreign"); err != nil || !ok || got != ownerID {
		t.Fatalf("ownership moved: %q ok=%v err=%v", got, ok, err)
	}
}
