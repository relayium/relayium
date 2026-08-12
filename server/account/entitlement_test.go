package account

import (
	"context"
	"strings"
	"sync"
	"testing"
)

// The provider-neutral subscription core, exercised at the store layer. These
// are the invariants the Apple adapter (a later batch) will be built on, so
// they are asserted here rather than only through the Stripe webhook: the
// webhook is one CALLER of this model, not its definition.
//
// Every test seeds the four factory tiers so plan ranking has real rows to
// order; "the highest live plan" is meaningless without them.

func seedTiers(t *testing.T, store *SQLiteStore) {
	t.Helper()
	ctx := context.Background()
	for _, p := range defaultPlans() {
		if err := store.UpsertPlan(ctx, p); err != nil {
			t.Fatalf("UpsertPlan(%s): %v", p.ID, err)
		}
	}
}

func newEntitlementUser(t *testing.T, store *SQLiteStore, email string) User {
	t.Helper()
	u, err := store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		t.Fatalf("UpsertUserByEmail(%s): %v", email, err)
	}
	return u
}

// fixedNow is the wall clock most of these tests apply their events at. Quota
// segmentation is the one thing that cares, and the tests that DO care pass
// their own clock through applyAt.
const fixedNow = int64(1_700_000_000)

// apply is the terse form used throughout: one provider event at fixedNow.
func apply(t *testing.T, store *SQLiteStore, userID, provider, planID, status, cycle string, end, eventAt int64) SubscriptionApply {
	t.Helper()
	return applyAt(t, store, fixedNow, userID, provider, planID, status, cycle, end, eventAt)
}

func applyAt(t *testing.T, store *SQLiteStore, now int64, userID, provider, planID, status, cycle string, end, eventAt int64) SubscriptionApply {
	t.Helper()
	res, err := store.ApplySubscriptionSource(context.Background(), SourceEvent{
		UserID:    userID,
		Provider:  provider,
		PlanID:    planID,
		Status:    status,
		Cycle:     cycle,
		PeriodEnd: end,
		EventAt:   eventAt,
		Now:       now,
	})
	if err != nil {
		t.Fatalf("ApplySubscriptionSource(%s/%s): %v", provider, status, err)
	}
	return res
}

func mustUser(t *testing.T, store *SQLiteStore, id string) User {
	t.Helper()
	u, err := store.GetUserByID(context.Background(), id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	return u
}

// A single provider behaves exactly like the Stripe-only model always has:
// the users row IS the effective projection.
func TestSingleProviderProjectsOntoUserRow(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	u := newEntitlementUser(t, store, "single-provider@example.com")

	apply(t, store, u.ID, ProviderStripe, "pro", "active", "monthly", 1_900_000_000, 100)

	got := mustUser(t, store, u.ID)
	if got.PlanID != "pro" || got.SubscriptionStatus != "active" ||
		got.PlanSource != ProviderStripe || got.BillingCycle != "monthly" ||
		got.SubscriptionEnd != 1_900_000_000 {
		t.Fatalf("projection mismatch: plan=%q status=%q source=%q cycle=%q end=%d",
			got.PlanID, got.SubscriptionStatus, got.PlanSource, got.BillingCycle, got.SubscriptionEnd)
	}
}

// Two live providers: the effective plan is the HIGHER tier, and the state is
// explicitly reported as multi-provider rather than silently collapsing to one.
func TestSimultaneousProvidersResolveHighestAndExposeMultiple(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	u := newEntitlementUser(t, store, "both-providers@example.com")

	apply(t, store, u.ID, ProviderStripe, "plus", "active", "monthly", 1_800_000_000, 100)
	res := apply(t, store, u.ID, ProviderApple, "max", "active", "yearly", 1_850_000_000, 10)

	if res.Effective.PlanID != "max" || res.Effective.Source != ProviderApple {
		t.Fatalf("want max via apple, got plan=%q source=%q", res.Effective.PlanID, res.Effective.Source)
	}
	if len(res.Effective.LiveProviders) != 2 {
		t.Fatalf("want two live providers, got %v", res.Effective.LiveProviders)
	}
	got := mustUser(t, store, u.ID)
	if got.PlanID != "max" || got.PlanSource != ProviderApple || got.BillingCycle != "yearly" {
		t.Fatalf("projection: plan=%q source=%q cycle=%q", got.PlanID, got.PlanSource, got.BillingCycle)
	}
	live, err := store.LiveEntitlementProviders(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("LiveEntitlementProviders: %v", err)
	}
	if entitlementProviderWire(got, live) != ProviderMultiple {
		t.Fatalf("want %q wire state, got %q", ProviderMultiple, entitlementProviderWire(got, live))
	}
}

// An event for the LOWER source must not pull the user down to it, and must
// not touch the quota segment either (that is what would silently re-issue or
// truncate the month's traffic allowance).
func TestLowerSourceEventNeitherDowngradesNorAccrues(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	u := newEntitlementUser(t, store, "lower-source@example.com")

	apply(t, store, u.ID, ProviderStripe, "max", "active", "monthly", 1_900_000_000, 100)
	before := mustUser(t, store, u.ID)

	// A live but LOWER Apple subscription arrives.
	apply(t, store, u.ID, ProviderApple, "plus", "active", "monthly", 1_900_000_000, 10)
	after := mustUser(t, store, u.ID)

	if after.PlanID != "max" || after.PlanSource != ProviderStripe {
		t.Fatalf("lower source changed the effective plan: plan=%q source=%q", after.PlanID, after.PlanSource)
	}
	if after.PlanStartedAt != before.PlanStartedAt || after.QuotaAccruedBytes != before.QuotaAccruedBytes ||
		after.QuotaAccruedPeriod != before.QuotaAccruedPeriod {
		t.Fatalf("lower source moved the quota segment: startedAt %d->%d accrued %d->%d period %q->%q",
			before.PlanStartedAt, after.PlanStartedAt,
			before.QuotaAccruedBytes, after.QuotaAccruedBytes,
			before.QuotaAccruedPeriod, after.QuotaAccruedPeriod)
	}
	// ...and the same for that lower source EXPIRING again.
	apply(t, store, u.ID, ProviderApple, "free", "expired", "", 0, 20)
	expired := mustUser(t, store, u.ID)
	if expired.PlanID != "max" || expired.PlanSource != ProviderStripe || expired.SubscriptionStatus != "active" {
		t.Fatalf("lower source expiry reduced access: plan=%q source=%q status=%q",
			expired.PlanID, expired.PlanSource, expired.SubscriptionStatus)
	}
}

// One provider lapsing must fall back to the other live one, not to free.
func TestProviderExpiryFallsBackToTheOtherLiveProvider(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	u := newEntitlementUser(t, store, "fallback@example.com")

	apply(t, store, u.ID, ProviderApple, "pro", "active", "yearly", 1_850_000_000, 10)
	apply(t, store, u.ID, ProviderStripe, "max", "active", "monthly", 1_900_000_000, 100)
	if got := mustUser(t, store, u.ID); got.PlanID != "max" {
		t.Fatalf("setup: want max, got %q", got.PlanID)
	}

	// Stripe cancels. Apple is still live at pro.
	apply(t, store, u.ID, ProviderStripe, "free", "canceled", "", 0, 200)

	got := mustUser(t, store, u.ID)
	if got.PlanID != "pro" || got.PlanSource != ProviderApple || got.SubscriptionStatus != "active" {
		t.Fatalf("want pro via live apple, got plan=%q source=%q status=%q",
			got.PlanID, got.PlanSource, got.SubscriptionStatus)
	}
	if got.SubscriptionEnd != 1_850_000_000 {
		t.Fatalf("want apple period end, got %d", got.SubscriptionEnd)
	}
}

// Interleaving the two providers' events must converge on the same state
// whichever order they arrive in, and neither stream's clock may censor the
// other's.
//
// Both providers hold a row BEFORE the crossing events, which is the only
// arrangement that can catch a shared clock: with just one row present, a
// single-clock implementation looks identical to a per-provider one because
// there is nothing to compare against. The two clocks are also on completely
// unrelated scales, because they are: an App Store notification timestamp has
// no relationship to a Stripe `event.created`.
func TestInterleavedProviderEventsNeverSuppressEachOther(t *testing.T) {
	type step struct {
		provider, plan, status, cycle string
		end, at                       int64
	}
	stripe1 := step{ProviderStripe, "plus", "active", "monthly", 1_800_000_000, 1000}
	apple1 := step{ProviderApple, "plus", "active", "monthly", 1_800_000_000, 9_000_000}
	// The crossing pair: Stripe's SECOND event carries a clock far BELOW the
	// Apple one already applied. Under one shared clock it would be dropped as
	// stale and this user would never reach Max.
	stripe2 := step{ProviderStripe, "max", "active", "monthly", 1_900_000_000, 2000}
	apple2 := step{ProviderApple, "pro", "active", "yearly", 1_850_000_000, 9_000_001}

	orders := map[string][]step{
		"stripe-first": {stripe1, apple1, stripe2, apple2},
		"apple-first":  {apple1, stripe1, apple2, stripe2},
	}
	for name, order := range orders {
		t.Run(name, func(t *testing.T) {
			store := newTestStore(t)
			seedTiers(t, store)
			u := newEntitlementUser(t, store, name+"@example.com")
			for _, s := range order {
				res := apply(t, store, u.ID, s.provider, s.plan, s.status, s.cycle, s.end, s.at)
				if !res.Applied {
					t.Fatalf("%s event at clock %d was dropped by the other provider's clock", s.provider, s.at)
				}
			}

			got := mustUser(t, store, u.ID)
			if got.PlanID != "max" || got.PlanSource != ProviderStripe {
				t.Fatalf("want max via stripe regardless of order, got plan=%q source=%q", got.PlanID, got.PlanSource)
			}
			apple, ok, err := store.GetSubscriptionSource(context.Background(), u.ID, ProviderApple)
			if err != nil || !ok {
				t.Fatalf("apple source row missing: ok=%v err=%v", ok, err)
			}
			if apple.PlanID != "pro" || apple.Status != "active" || apple.EventAt != 9_000_001 {
				t.Fatalf("apple row was overwritten or censored by the stripe stream: %+v", apple)
			}
			stripe, ok, err := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
			if err != nil || !ok {
				t.Fatalf("stripe source row missing: ok=%v err=%v", ok, err)
			}
			if stripe.PlanID != "max" || stripe.EventAt != 2000 {
				t.Fatalf("stripe row carries the apple clock, or lost its own event: %+v", stripe)
			}
		})
	}
}

// A replayed/stale event for one provider changes neither its own row nor the
// projection — the row is not half-updated with the new plan and the old clock.
func TestStaleSourceEventLeavesRowAndProjectionUnchanged(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	u := newEntitlementUser(t, store, "stale@example.com")

	apply(t, store, u.ID, ProviderStripe, "pro", "active", "monthly", 1_900_000_000, 2000)
	res := apply(t, store, u.ID, ProviderStripe, "free", "canceled", "", 0, 1000)
	if res.Applied {
		t.Fatal("stale event reported as applied")
	}

	got := mustUser(t, store, u.ID)
	if got.PlanID != "pro" || got.SubscriptionStatus != "active" {
		t.Fatalf("stale event reverted the projection: plan=%q status=%q", got.PlanID, got.SubscriptionStatus)
	}
	row, _, err := store.GetSubscriptionSource(context.Background(), u.ID, ProviderStripe)
	if err != nil {
		t.Fatalf("GetSubscriptionSource: %v", err)
	}
	if row.PlanID != "pro" || row.Status != "active" || row.EventAt != 2000 {
		t.Fatalf("stale event mutated the source row: %+v", row)
	}
}

// An admin comp outranks every provider, and the provider rows keep tracking
// underneath it so a later fallback is truthful rather than invented.
func TestAdminGrantWinsWhileProviderRowsKeepUpdating(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()
	u := newEntitlementUser(t, store, "admin-comp@example.com")
	if err := store.SetUserPlanAdmin(ctx, u.ID, "max", 1_700_000_000); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}

	apply(t, store, u.ID, ProviderStripe, "plus", "active", "monthly", 1_900_000_000, 100)

	got := mustUser(t, store, u.ID)
	if got.PlanID != "max" || got.PlanSource != SourceAdmin {
		t.Fatalf("admin grant lost: plan=%q source=%q", got.PlanID, got.PlanSource)
	}
	if got.SubscriptionStatus != "active" || got.SubscriptionEnd != 1_900_000_000 {
		t.Fatalf("admin row lost provider visibility: status=%q end=%d", got.SubscriptionStatus, got.SubscriptionEnd)
	}
	row, ok, err := store.GetSubscriptionSource(ctx, u.ID, ProviderStripe)
	if err != nil || !ok {
		t.Fatalf("stripe row not recorded under an admin comp: ok=%v err=%v", ok, err)
	}
	if row.PlanID != "plus" {
		t.Fatalf("stripe row should track its own truth, got %q", row.PlanID)
	}
}

// Ranking ties must resolve the same way every time, whichever order the two
// events arrive in.
func TestEqualRankTieIsDeterministic(t *testing.T) {
	run := func(t *testing.T, first, second string) User {
		t.Helper()
		store := newTestStore(t)
		seedTiers(t, store)
		u := newEntitlementUser(t, store, first+"-"+second+"@example.com")
		// Same tier on both providers, apple holding the LATER period end.
		ends := map[string]int64{ProviderStripe: 1_800_000_000, ProviderApple: 1_900_000_000}
		apply(t, store, u.ID, first, "pro", "active", "monthly", ends[first], 100)
		apply(t, store, u.ID, second, "pro", "active", "monthly", ends[second], 100)
		return mustUser(t, store, u.ID)
	}
	a := run(t, ProviderStripe, ProviderApple)
	b := run(t, ProviderApple, ProviderStripe)
	if a.PlanSource != b.PlanSource || a.SubscriptionEnd != b.SubscriptionEnd {
		t.Fatalf("tie is order-dependent: %q/%d vs %q/%d",
			a.PlanSource, a.SubscriptionEnd, b.PlanSource, b.SubscriptionEnd)
	}
	if a.PlanSource != ProviderApple || a.SubscriptionEnd != 1_900_000_000 {
		t.Fatalf("tie must keep the longest access, got %q/%d", a.PlanSource, a.SubscriptionEnd)
	}
}

// Quota accrual fires exactly once per REAL effective-plan change, and never
// for a repeated event that resolves to the same plan.
func TestQuotaSegmentMovesOnlyOnEffectivePlanChange(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	u := newEntitlementUser(t, store, "quota-segment@example.com")

	// Each step moves the clock: a segment boundary is only observable against
	// a clock that has actually advanced, so a frozen one would make this test
	// pass no matter what accrual did.
	const hour = int64(3600)
	applyAt(t, store, fixedNow, u.ID, ProviderStripe, "plus", "active", "monthly", 1_900_000_000, 100)
	first := mustUser(t, store, u.ID)
	if first.PlanStartedAt != fixedNow {
		t.Fatalf("first paid plan did not start a quota segment: %d", first.PlanStartedAt)
	}
	// Same plan again (Stripe re-delivers status-only updates constantly).
	applyAt(t, store, fixedNow+hour, u.ID, ProviderStripe, "plus", "active", "monthly", 1_900_000_001, 200)
	same := mustUser(t, store, u.ID)
	if same.PlanStartedAt != first.PlanStartedAt || same.QuotaAccruedBytes != first.QuotaAccruedBytes {
		t.Fatalf("repeat event re-cut the quota segment: %d/%d -> %d/%d",
			first.PlanStartedAt, first.QuotaAccruedBytes, same.PlanStartedAt, same.QuotaAccruedBytes)
	}
	// A LOWER live source arriving is not an effective change either.
	applyAt(t, store, fixedNow+2*hour, u.ID, ProviderApple, "free", "expired", "", 0, 10)
	lower := mustUser(t, store, u.ID)
	if lower.PlanStartedAt != first.PlanStartedAt || lower.QuotaAccruedBytes != first.QuotaAccruedBytes {
		t.Fatalf("non-effective source event re-cut the quota segment: %d/%d",
			lower.PlanStartedAt, lower.QuotaAccruedBytes)
	}
	// A genuine upgrade must cut a new segment, freezing what Plus earned.
	applyAt(t, store, fixedNow+3*hour, u.ID, ProviderApple, "max", "active", "monthly", 1_900_000_000, 20)
	upgraded := mustUser(t, store, u.ID)
	if upgraded.PlanStartedAt != fixedNow+3*hour {
		t.Fatalf("real upgrade did not start a new segment: %d", upgraded.PlanStartedAt)
	}
	if upgraded.QuotaAccruedBytes <= first.QuotaAccruedBytes {
		t.Fatalf("real upgrade did not freeze the outgoing tier's earned quota: %d -> %d",
			first.QuotaAccruedBytes, upgraded.QuotaAccruedBytes)
	}
}

// One external subscription belongs to exactly one Relayium user.
func TestExternalSubscriptionOwnershipIsExclusive(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()
	a := newEntitlementUser(t, store, "owner-a@example.com")
	b := newEntitlementUser(t, store, "owner-b@example.com")

	if err := store.BindExternalSubscription(ctx, a.ID, ProviderStripe, "sub_shared"); err != nil {
		t.Fatalf("first bind: %v", err)
	}
	if err := store.BindExternalSubscription(ctx, b.ID, ProviderStripe, "sub_shared"); err == nil {
		t.Fatal("second user bound the same external subscription")
	}
	// Rebinding by the SAME owner is idempotent, not a conflict.
	if err := store.BindExternalSubscription(ctx, a.ID, ProviderStripe, "sub_shared"); err != nil {
		t.Fatalf("idempotent rebind: %v", err)
	}
	// The same id under a DIFFERENT provider is a different subscription.
	if err := store.BindExternalSubscription(ctx, b.ID, ProviderApple, "sub_shared"); err != nil {
		t.Fatalf("cross-provider bind: %v", err)
	}
}

// ---- Apple app-account token -------------------------------------------------

func TestAppleAccountTokenIsStableRandomUUIDv4(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u := newEntitlementUser(t, store, "token-stable@example.com")

	first, err := store.EnsureAppleAccountToken(ctx, u.ID, mustNewAppAccountToken(t))
	if err != nil {
		t.Fatalf("EnsureAppleAccountToken: %v", err)
	}
	if !validAppAccountToken(first) {
		t.Fatalf("not an RFC 4122 v4 UUID: %q", first)
	}
	second, err := store.EnsureAppleAccountToken(ctx, u.ID, mustNewAppAccountToken(t))
	if err != nil {
		t.Fatalf("EnsureAppleAccountToken (again): %v", err)
	}
	if second != first {
		t.Fatalf("token is not stable: %q then %q", first, second)
	}
	// Opaque: it must not be derived from anything about the account.
	if strings.Contains(first, u.ID) || strings.Contains(first, "token-stable") {
		t.Fatalf("token leaks account identity: %q", first)
	}
}

func TestAppleAccountTokenConcurrentMintConverges(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u := newEntitlementUser(t, store, "token-race@example.com")

	// Candidates are minted on the TEST goroutine: mustNewAppAccountToken calls
	// t.Fatalf, which is only valid there. From a spawned goroutine it exits
	// that goroutine alone and the test proceeds on partial data (see the note
	// in apple_account_token_test.go), so the mint failure it was reporting
	// would be re-reported as whatever the leftover zero values happen to say.
	const n = 8
	candidates := make([]string, n)
	for i := range candidates {
		candidates[i] = mustNewAppAccountToken(t)
	}
	out := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			out[i], errs[i] = store.EnsureAppleAccountToken(ctx, u.ID, candidates[i])
		}(i)
	}
	wg.Wait()
	for i, got := range out {
		if errs[i] != nil {
			t.Fatalf("concurrent mint %d: %v", i, errs[i])
		}
		if got == "" || got != out[0] {
			t.Fatalf("concurrent mints diverged: [%d]=%q want %q", i, got, out[0])
		}
	}
}

func TestAppleAccountTokenIsUniqueAcrossUsersAndFailsClosed(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	a := newEntitlementUser(t, store, "token-a@example.com")
	b := newEntitlementUser(t, store, "token-b@example.com")

	tok, err := store.EnsureAppleAccountToken(ctx, a.ID, mustNewAppAccountToken(t))
	if err != nil {
		t.Fatalf("mint a: %v", err)
	}
	// B tries to claim A's token: it must not become a second owner.
	if _, err := store.EnsureAppleAccountToken(ctx, b.ID, tok); err == nil {
		t.Fatal("a second user claimed an existing token")
	}
	owner, ok, err := store.UserByAppleAccountToken(ctx, tok)
	if err != nil || !ok {
		t.Fatalf("lookup: ok=%v err=%v", ok, err)
	}
	if owner.ID != a.ID {
		t.Fatalf("token bound to the wrong user: %q want %q", owner.ID, a.ID)
	}
	// Empty lookup must fail closed rather than matching every unbound row.
	if _, ok, err := store.UserByAppleAccountToken(ctx, ""); err != nil || ok {
		t.Fatalf("empty token lookup: ok=%v err=%v", ok, err)
	}
	// B is still unbound and can mint its own.
	btok, err := store.EnsureAppleAccountToken(ctx, b.ID, mustNewAppAccountToken(t))
	if err != nil {
		t.Fatalf("mint b: %v", err)
	}
	if btok == tok {
		t.Fatal("two users share one token")
	}
}

func mustNewAppAccountToken(t *testing.T) string {
	t.Helper()
	tok, err := newAppAccountToken()
	if err != nil {
		t.Fatalf("newAppAccountToken: %v", err)
	}
	return tok
}

// ---- Apple product catalog ---------------------------------------------------

// The macOS and iOS apps ship under DIFFERENT bundle ids, so the same tier is
// two distinct App Store products. The catalog must key on both.
func TestAppleProductCatalogDistinguishesBundleIdentity(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()

	mac := AppleProduct{BundleID: "com.relayium.mac", ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true}
	ios := AppleProduct{BundleID: "com.relayium.app", ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true}
	for _, p := range []AppleProduct{mac, ios} {
		if err := store.UpsertAppleProduct(ctx, p); err != nil {
			t.Fatalf("UpsertAppleProduct(%s): %v", p.BundleID, err)
		}
	}
	// Same product id under both bundles: two rows, not one clobbered row.
	for _, want := range []AppleProduct{mac, ios} {
		got, ok, err := store.AppleProductPlan(ctx, want.BundleID, want.ProductID)
		if err != nil || !ok {
			t.Fatalf("AppleProductPlan(%s): ok=%v err=%v", want.BundleID, ok, err)
		}
		if got.PlanID != want.PlanID || got.Cycle != want.Cycle || got.BundleID != want.BundleID {
			t.Fatalf("wrong mapping for %s: %+v", want.BundleID, got)
		}
	}
	// A product id that belongs to the other app must not resolve here.
	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: "com.relayium.mac", ProductID: "max.yearly", PlanID: "max", Cycle: "yearly", Active: true,
	}); err != nil {
		t.Fatalf("UpsertAppleProduct(mac max): %v", err)
	}
	if _, ok, err := store.AppleProductPlan(ctx, "com.relayium.app", "max.yearly"); err != nil || ok {
		t.Fatalf("cross-bundle leak: ok=%v err=%v", ok, err)
	}
	// Unknown lookups, and empty keys, resolve to nothing rather than a guess.
	for _, k := range [][2]string{{"com.relayium.mac", "nope"}, {"", "pro.monthly"}, {"com.relayium.mac", ""}} {
		if _, ok, err := store.AppleProductPlan(ctx, k[0], k[1]); err != nil || ok {
			t.Fatalf("AppleProductPlan(%q,%q): ok=%v err=%v", k[0], k[1], ok, err)
		}
	}
	// An inactive row is retired, not a live mapping.
	retired := mac
	retired.Active = false
	if err := store.UpsertAppleProduct(ctx, retired); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if _, ok, err := store.AppleProductPlan(ctx, retired.BundleID, retired.ProductID); err != nil || ok {
		t.Fatalf("retired mapping still resolves: ok=%v err=%v", ok, err)
	}
}

// The catalog is the ONLY thing standing between a signed App Store
// transaction and a granted tier, so it must fail closed on the way IN. A row
// that names a plan nobody offers, or a cycle that is neither of the two the
// projection understands, is a grant waiting to resolve to something no part of
// the system has rules for — and by the time an adapter reads it, the
// transaction is already signed and paid.
func TestAppleProductUpsertRejectsMalformedRecords(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()
	// A retired tier: present, but not on sale.
	retiredPlan := Plan{ID: "legacy", Name: "Legacy", Active: false}
	if err := store.UpsertPlan(ctx, retiredPlan); err != nil {
		t.Fatalf("UpsertPlan(legacy): %v", err)
	}

	ok := AppleProduct{BundleID: "com.relayium.mac", ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true}
	with := func(mut func(*AppleProduct)) AppleProduct {
		p := ok
		mut(&p)
		return p
	}
	for _, tc := range []struct {
		name string
		p    AppleProduct
	}{
		{"nonexistent plan", with(func(p *AppleProduct) { p.PlanID = "no-such-tier" })},
		{"inactive plan", with(func(p *AppleProduct) { p.PlanID = "legacy" })},
		{"empty bundle", with(func(p *AppleProduct) { p.BundleID = "" })},
		{"whitespace bundle", with(func(p *AppleProduct) { p.BundleID = "   " })},
		{"empty product", with(func(p *AppleProduct) { p.ProductID = "" })},
		{"whitespace product", with(func(p *AppleProduct) { p.ProductID = "\t\n" })},
		{"empty plan", with(func(p *AppleProduct) { p.PlanID = "" })},
		{"whitespace plan", with(func(p *AppleProduct) { p.PlanID = "  " })},
		{"empty cycle", with(func(p *AppleProduct) { p.Cycle = "" })},
		{"unknown cycle", with(func(p *AppleProduct) { p.Cycle = "weekly" })},
		{"cycle case mismatch", with(func(p *AppleProduct) { p.Cycle = "Monthly" })},
	} {
		if err := store.UpsertAppleProduct(ctx, tc.p); err == nil {
			t.Fatalf("%s: accepted a malformed catalog row: %+v", tc.name, tc.p)
		}
		// ...and nothing was written on the way to the refusal.
		if got, found, err := store.AppleProductPlan(ctx, tc.p.BundleID, tc.p.ProductID); err != nil || found {
			t.Fatalf("%s: a rejected row landed anyway: %+v (found=%v err=%v)", tc.name, got, found, err)
		}
	}
}

// Surrounding keys are trimmed rather than silently stored, so a copy-pasted
// bundle id with a trailing newline addresses the same product as the clean one
// instead of creating a second row that nothing will ever match.
func TestAppleProductUpsertTrimsKeys(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()

	if err := store.UpsertAppleProduct(ctx, AppleProduct{
		BundleID: "  com.relayium.mac\n", ProductID: " pro.monthly ", PlanID: " pro ", Cycle: " monthly ", Active: true,
	}); err != nil {
		t.Fatalf("UpsertAppleProduct: %v", err)
	}
	got, found, err := store.AppleProductPlan(ctx, "com.relayium.mac", "pro.monthly")
	if err != nil || !found {
		t.Fatalf("trimmed keys do not resolve: found=%v err=%v", found, err)
	}
	if got.PlanID != "pro" || got.Cycle != "monthly" {
		t.Fatalf("stored untrimmed values: %+v", got)
	}
}

// Both apps' real mappings are accepted, and each resolves to its own tier and
// cycle — the catalog's actual job, which the validation above must not break.
func TestAppleProductUpsertAcceptsDistinctPlatformMappings(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()

	want := []AppleProduct{
		{BundleID: "com.relayium.mac", ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true},
		{BundleID: "com.relayium.mac", ProductID: "max.yearly", PlanID: "max", Cycle: "yearly", Active: true},
		{BundleID: "com.relayium.app", ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true},
		{BundleID: "com.relayium.app", ProductID: "max.yearly", PlanID: "max", Cycle: "yearly", Active: true},
	}
	for _, p := range want {
		if err := store.UpsertAppleProduct(ctx, p); err != nil {
			t.Fatalf("UpsertAppleProduct(%s/%s): %v", p.BundleID, p.ProductID, err)
		}
	}
	for _, p := range want {
		got, found, err := store.AppleProductPlan(ctx, p.BundleID, p.ProductID)
		if err != nil || !found {
			t.Fatalf("%s/%s: found=%v err=%v", p.BundleID, p.ProductID, found, err)
		}
		if got.PlanID != p.PlanID || got.Cycle != p.Cycle {
			t.Fatalf("%s/%s resolved to %+v", p.BundleID, p.ProductID, got)
		}
	}
}

// Retirement must stay possible for the row that most needs retiring: the
// mapping to a tier that has since been taken off sale. Validation that
// refused it would leave a live App Store product pointing at a dead tier with
// no way to switch it off short of hand-editing the database.
func TestAppleProductRetirementSurvivesPlanDeactivation(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()

	live := AppleProduct{BundleID: "com.relayium.mac", ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true}
	if err := store.UpsertAppleProduct(ctx, live); err != nil {
		t.Fatalf("seed mapping: %v", err)
	}
	// The tier is taken off sale.
	pro := Plan{ID: "pro", Name: "Pro", Active: false}
	if err := store.UpsertPlan(ctx, pro); err != nil {
		t.Fatalf("deactivate pro: %v", err)
	}
	// Re-activating the MAPPING to a dead tier is refused...
	if err := store.UpsertAppleProduct(ctx, live); err == nil {
		t.Fatal("a live mapping to an inactive tier was accepted")
	}
	// ...but retiring it is exactly what an operator must be able to do.
	retired := live
	retired.Active = false
	if err := store.UpsertAppleProduct(ctx, retired); err != nil {
		t.Fatalf("retiring a mapping to a deactivated tier: %v", err)
	}
	if _, found, err := store.AppleProductPlan(ctx, live.BundleID, live.ProductID); err != nil || found {
		t.Fatalf("retired mapping still resolves: found=%v err=%v", found, err)
	}
}

// Validation on the way IN is not enough on its own. A mapping written while
// its tier was on sale keeps its own active=1 forever, and the ordinary admin
// lifecycle — retiring a tier with UpsertPlan — never revisits it. The product
// stays purchasable in App Store Connect meanwhile, so the next signed
// transaction for it would resolve to a tier the site no longer sells. Live
// resolution therefore has to re-check the plan, not trust the row's own flag.
func TestAppleProductPlanFollowsThePlanLifecycle(t *testing.T) {
	store := newTestStore(t)
	seedTiers(t, store)
	ctx := context.Background()

	live := AppleProduct{BundleID: "com.relayium.mac", ProductID: "pro.monthly", PlanID: "pro", Cycle: "monthly", Active: true}
	if err := store.UpsertAppleProduct(ctx, live); err != nil {
		t.Fatalf("seed mapping: %v", err)
	}
	// The ordinary case is unchanged: an active mapping to a tier on sale.
	got, found, err := store.AppleProductPlan(ctx, live.BundleID, live.ProductID)
	if err != nil || !found {
		t.Fatalf("a valid mapping does not resolve: found=%v err=%v", found, err)
	}
	if got.PlanID != "pro" || got.Cycle != "monthly" || !got.Active {
		t.Fatalf("wrong mapping: %+v", got)
	}

	// The tier is taken off sale through the normal admin path. Nothing touches
	// the apple_products row.
	if err := store.UpsertPlan(ctx, Plan{ID: "pro", Name: "Pro", Active: false}); err != nil {
		t.Fatalf("retire pro: %v", err)
	}
	if _, found, err := store.AppleProductPlan(ctx, live.BundleID, live.ProductID); err != nil || found {
		t.Fatalf("a mapping to a retired tier still resolves: found=%v err=%v", found, err)
	}
	// The refusal is a READ-TIME check, not a rewrite: the mapping row is still
	// there, still flagged active, and still the operator's to retire.
	var stillActive int64
	if err := store.db.QueryRowContext(ctx,
		`SELECT active FROM apple_products WHERE bundle_id = ? AND product_id = ?`,
		live.BundleID, live.ProductID).Scan(&stillActive); err != nil {
		t.Fatalf("mapping row disappeared: %v", err)
	}
	if stillActive != 1 {
		t.Fatalf("resolution rewrote the mapping row: active=%d", stillActive)
	}

	// Putting the tier back on sale makes the same mapping live again — the gate
	// tracks the plan rather than latching.
	if err := store.UpsertPlan(ctx, Plan{ID: "pro", Name: "Pro", Active: true}); err != nil {
		t.Fatalf("reinstate pro: %v", err)
	}
	if _, found, err := store.AppleProductPlan(ctx, live.BundleID, live.ProductID); err != nil || !found {
		t.Fatalf("mapping did not come back with its tier: found=%v err=%v", found, err)
	}

	// And a retired MAPPING to a live tier stays retired: the two conditions are
	// independent, and either one alone is enough to refuse.
	retired := live
	retired.Active = false
	if err := store.UpsertAppleProduct(ctx, retired); err != nil {
		t.Fatalf("retire mapping: %v", err)
	}
	if _, found, err := store.AppleProductPlan(ctx, live.BundleID, live.ProductID); err != nil || found {
		t.Fatalf("retired mapping still resolves: found=%v err=%v", found, err)
	}
}

// A fresh database has no Apple products at all: the catalog is inert until it
// is deliberately populated, so nothing can be granted by an accidental match.
func TestAppleProductCatalogStartsEmpty(t *testing.T) {
	store := newTestStore(t)
	if _, ok, err := store.AppleProductPlan(context.Background(), "com.relayium.mac", "pro.monthly"); err != nil || ok {
		t.Fatalf("fresh catalog is not empty: ok=%v err=%v", ok, err)
	}
}
