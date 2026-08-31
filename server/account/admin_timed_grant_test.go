package account

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Time-bounded administrator membership grants.
//
// The property every test here is ultimately protecting is one sentence: a
// grant may ADD entitlement for a bounded time and must never, by any path,
// change what a payment provider believes it is owed. So the assertions come in
// pairs — "the operator got the entitlement they asked for" and "every
// authority, attempt, source row and projection is byte-identical to before".

// grantTiers seeds a Free/Plus/Max ladder with real sort_order and prices, so
// the precedence rule is exercised against actual plan ranks rather than
// against a single tier where every comparison is trivially true.
func grantTiers(t *testing.T, store *SQLiteStore) {
	t.Helper()
	ctx := context.Background()
	for _, p := range []Plan{
		{ID: freePlanID, Name: "Free", StorageBytes: 1 << 20, TrafficBytes: 1 << 20, RetentionSecs: 3600, SortOrder: 0, PriceMonthly: 0, Active: true, UpdatedAt: 1},
		{ID: "plus", Name: "Plus", StorageBytes: 1 << 30, TrafficBytes: 1 << 30, RetentionSecs: 86400, SortOrder: 1, PriceMonthly: 500, Active: true, UpdatedAt: 1},
		{ID: "max", Name: "Max", StorageBytes: 1 << 34, TrafficBytes: 1 << 34, RetentionSecs: 1209600, SortOrder: 2, PriceMonthly: 1500, Active: true, UpdatedAt: 1},
	} {
		if err := store.UpsertPlan(ctx, p); err != nil {
			t.Fatalf("UpsertPlan(%s): %v", p.ID, err)
		}
	}
}

// grantForm is the console's real field set, in one place so a test that means
// to vary ONE field cannot accidentally vary another.
func grantForm(userID, planID, days, mode string) url.Values {
	return url.Values{
		"user_id": {userID}, "plan_id": {planID},
		"grant_days": {days}, "grant_mode": {mode},
	}
}

// providerSnapshot captures every provider-owned fact about an account, so a
// test can assert that a grant moved none of them. It reads the raw tables
// rather than a projection: the point is that the ROWS are untouched, not that
// some derived view still looks the same.
type providerSnapshot struct {
	plan, source, subStatus string
	subEnd                  int64
	authority               BillingAuthority
	hasAuthority            bool
	sources                 []SubscriptionSource
	attempts                map[string]string // attempt id -> state
	stripeCustomer          string
	stripeSubscription      string
}

func snapshotProvider(t *testing.T, store *SQLiteStore, userID string) providerSnapshot {
	t.Helper()
	ctx := context.Background()
	u, err := store.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	snap := providerSnapshot{
		plan: u.PlanID, source: u.PlanSource, subStatus: u.SubscriptionStatus, subEnd: u.SubscriptionEnd,
		stripeCustomer: u.StripeCustomerID, stripeSubscription: u.StripeSubscriptionID,
		attempts: map[string]string{},
	}
	snap.authority, snap.hasAuthority, err = store.BillingAuthority(ctx, userID)
	if err != nil {
		t.Fatalf("BillingAuthority: %v", err)
	}
	if snap.sources, err = store.ListSubscriptionSources(ctx, userID); err != nil {
		t.Fatalf("ListSubscriptionSources: %v", err)
	}
	rows, err := store.db.QueryContext(ctx, `SELECT id, state FROM billing_purchase_attempts WHERE user_id=?`, userID)
	if err != nil {
		t.Fatalf("read attempts: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, state string
		if err := rows.Scan(&id, &state); err != nil {
			t.Fatalf("scan attempt: %v", err)
		}
		snap.attempts[id] = state
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("attempts: %v", err)
	}
	return snap
}

// assertProviderUntouched is the financial invariant, stated once.
func assertProviderUntouched(t *testing.T, before, after providerSnapshot) {
	t.Helper()
	if before.plan != after.plan || before.source != after.source ||
		before.subStatus != after.subStatus || before.subEnd != after.subEnd {
		t.Fatalf("FINANCIAL: the provider projection moved: %+v -> %+v", before, after)
	}
	if before.hasAuthority != after.hasAuthority || before.authority != after.authority {
		t.Fatalf("FINANCIAL: the billing authority moved: %+v -> %+v", before.authority, after.authority)
	}
	if before.stripeCustomer != after.stripeCustomer || before.stripeSubscription != after.stripeSubscription {
		t.Fatal("FINANCIAL: a Stripe identifier moved")
	}
	if len(before.sources) != len(after.sources) {
		t.Fatalf("FINANCIAL: subscription source count changed: %d -> %d", len(before.sources), len(after.sources))
	}
	for i := range before.sources {
		if before.sources[i] != after.sources[i] {
			t.Fatalf("FINANCIAL: subscription source changed: %+v -> %+v", before.sources[i], after.sources[i])
		}
	}
	if len(before.attempts) != len(after.attempts) {
		t.Fatalf("FINANCIAL: purchase attempt count changed: %d -> %d", len(before.attempts), len(after.attempts))
	}
	for id, state := range before.attempts {
		if after.attempts[id] != state {
			t.Fatalf("FINANCIAL: purchase attempt %s moved %q -> %q", id, state, after.attempts[id])
		}
	}
}

// ---- the arithmetic, in isolation ------------------------------------------

func TestAdminGrantDurationBoundsAreExactAndTotal(t *testing.T) {
	// The two ends of the accepted range must both be ACCEPTED — an off-by-one
	// at either boundary is invisible until an operator hits it — and every
	// shape of "not a whole number of days in range" must be one refusal.
	for _, ok := range []string{"1", "1000", "  30  ", "0001"} {
		n, err := parseAdminGrantDays(ok)
		if err != nil {
			t.Errorf("parseAdminGrantDays(%q) = %v, want accepted", ok, err)
		}
		if n < adminGrantMinDays || n > adminGrantMaxDays {
			t.Errorf("parseAdminGrantDays(%q) = %d, out of range", ok, n)
		}
	}
	for _, bad := range []string{
		"0", "-1", "-1000", "1001", "", " ", "abc", "1.5", "1e3", "0x10",
		"1_000", "٣", "+", "9223372036854775808", // int64 overflow
		"99999999999999999999999999",
	} {
		if _, err := parseAdminGrantDays(bad); !errors.Is(err, ErrAdminGrantDuration) {
			t.Errorf("parseAdminGrantDays(%q) = %v, want ErrAdminGrantDuration", bad, err)
		}
	}
}

func TestAdminGrantExpiryArithmetic(t *testing.T) {
	const now = 1_700_000_000
	live := AdminGrant{PlanID: "max", GrantedAt: now - 100, ExpiresAt: now + 10*adminGrantDaySecs}
	lapsed := AdminGrant{PlanID: "max", GrantedAt: now - 1000, ExpiresAt: now - 1}

	cases := []struct {
		name string
		mode string
		days int64
		cur  AdminGrant
		want int64
	}{
		{"from-now on a clean account", AdminGrantModeFromNow, 30, AdminGrant{}, now + 30*adminGrantDaySecs},
		// from-now REPLACES rather than takes a maximum: it is the operator's only
		// way to shorten a mis-typed grant, so it must be able to move the expiry
		// backwards.
		{"from-now shortens a live grant", AdminGrantModeFromNow, 1, live, now + adminGrantDaySecs},
		// The specified anchor: max(now, current unexpired expiry).
		{"extend stacks on a live grant", AdminGrantModeExtend, 7, live, live.ExpiresAt + 7*adminGrantDaySecs},
		{"extend on a clean account is from-now", AdminGrantModeExtend, 7, AdminGrant{}, now + 7*adminGrantDaySecs},
		// A lapsed grant is NOT resurrected — anchoring on its past expiry would
		// back-date entitlement into a window the account did not have it, and
		// could even produce an expiry already behind us.
		{"extend does not resurrect a lapsed grant", AdminGrantModeExtend, 7, lapsed, now + 7*adminGrantDaySecs},
		{"minimum duration", AdminGrantModeFromNow, adminGrantMinDays, AdminGrant{}, now + adminGrantDaySecs},
		{"maximum duration", AdminGrantModeFromNow, adminGrantMaxDays, AdminGrant{}, now + 1000*adminGrantDaySecs},
	}
	for _, c := range cases {
		got, err := adminGrantExpiry(c.mode, c.days, now, c.cur)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: expiry = %d, want %d", c.name, got, c.want)
		}
		if got <= now {
			t.Errorf("%s: expiry %d is not in the future", c.name, got)
		}
	}

	if _, err := adminGrantExpiry("sideways", 1, now, AdminGrant{}); !errors.Is(err, ErrAdminGrantMode) {
		t.Errorf("unknown mode = %v, want ErrAdminGrantMode", err)
	}
	// A silent wrap would turn the longest grant into a negative instant, which
	// every `expires_at > now` comparison reads as live forever.
	huge := AdminGrant{PlanID: "max", ExpiresAt: 1<<62 + 1<<62 - 1}
	if _, err := adminGrantExpiry(AdminGrantModeExtend, 1000, now, huge); !errors.Is(err, ErrAdminGrantOverflow) {
		t.Errorf("overflowing extend = %v, want ErrAdminGrantOverflow", err)
	}
}

// ---- resolution: additive, deterministic, and it expires --------------------

// grantEnv is a service with a movable clock plus a seeded ladder.
func grantEnv(t *testing.T) (*Service, *SQLiteStore, func(int64)) {
	t.Helper()
	_, svc, store, _ := newAdminAuditServer(t)
	grantTiers(t, store)
	at := int64(1_700_000_000)
	svc.SetNow(func() time.Time { return time.Unix(at, 0) })
	return svc, store, func(to int64) { at = to }
}

func TestGrantRaisesTierThenExpiresBackToFree(t *testing.T) {
	svc, store, setNow := grantEnv(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "expiry-free@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	const now = 1_700_000_000
	g, err := store.GrantAdminPlan(ctx, u.ID, "max", AdminGrantModeFromNow, 2, now)
	if err != nil {
		t.Fatalf("GrantAdminPlan: %v", err)
	}

	reload := func() User {
		got, err := store.GetUserByID(ctx, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := svc.effectivePlanID(ctx, reload()); got != "max" {
		t.Fatalf("during grant: effective plan = %q, want max", got)
	}
	// One second before expiry it is still live; AT the expiry instant it is not
	// (the boundary is exclusive, so a grant and its expiry are never both true).
	setNow(g.ExpiresAt - 1)
	if got := svc.effectivePlanID(ctx, reload()); got != "max" {
		t.Fatalf("one second before expiry: effective plan = %q, want max", got)
	}
	setNow(g.ExpiresAt)
	if got := svc.effectivePlanID(ctx, reload()); got != freePlanID {
		t.Fatalf("at expiry: effective plan = %q, want the free fallback", got)
	}
	// And the row itself never claimed to be anything else.
	if after := reload(); after.PlanID != freePlanID || after.PlanSource != "" {
		t.Fatalf("the projection was mutated by a grant: %q/%q", after.PlanID, after.PlanSource)
	}
}

func TestGrantIsStrictlyAdditiveAndNeverLowersAPaidTier(t *testing.T) {
	// The rule that protects a paying customer: an operator handing out a
	// SMALLER tier than the one somebody is being billed for must not downgrade
	// them for the duration.
	svc, store, _ := grantEnv(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "paying-max@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	const now = 1_700_000_000
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderStripe, PlanID: "max", Status: "active",
		Cycle: "monthly", PeriodEnd: now + 30*86400, EventAt: now - 10, Now: now - 10,
	}); err != nil {
		t.Fatalf("seed stripe max: %v", err)
	}
	if _, err := store.GrantAdminPlan(ctx, u.ID, "plus", AdminGrantModeFromNow, 7, now); err != nil {
		t.Fatalf("GrantAdminPlan: %v", err)
	}
	got, err := store.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if eff := svc.effectivePlanID(ctx, got); eff != "max" {
		t.Fatalf("FINANCIAL: a smaller grant downgraded a paying customer to %q", eff)
	}
	// The tie case, stated separately because it is the documented rule rather
	// than a consequence: an equal-rank grant leaves the projection standing.
	if _, err := store.GrantAdminPlan(ctx, u.ID, "max", AdminGrantModeFromNow, 7, now); err != nil {
		t.Fatalf("GrantAdminPlan(tie): %v", err)
	}
	got, _ = store.GetUserByID(ctx, u.ID)
	if eff := svc.effectivePlanID(ctx, got); eff != "max" {
		t.Fatalf("equal-rank grant resolved to %q, want the projection's max", eff)
	}
	if got.PlanSource != ProviderStripe {
		t.Fatalf("plan_source = %q, want stripe left in place", got.PlanSource)
	}
}

func TestGrantIgnoresAnUnresolvableTier(t *testing.T) {
	// A grant naming a tier with no plans row must grant NOTHING, exactly as a
	// source row pointing at a missing plan ranks at zero. Written directly to
	// the column because the console cannot produce this state — but a retired
	// and later deleted tier can.
	svc, store, _ := grantEnv(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "ghost-tier@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE users SET admin_grant_plan_id='vanished', admin_grant_expires_at=? WHERE id=?`,
		int64(1_700_000_000+86400), u.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetUserByID(ctx, u.ID)
	if eff := svc.effectivePlanID(ctx, got); eff != freePlanID {
		t.Fatalf("an unresolvable granted tier resolved to %q, want the projection", eff)
	}
}

// ---- provider coexistence ---------------------------------------------------

// seedCancelledAppleAuthority builds the harder of the two provider fixtures: a
// real Apple billing authority whose subscription has since been CANCELLED. The
// authority row survives a cancellation by design, so this is exactly the state
// where "there is an authority" and "there is a live subscription" diverge.
func seedCancelledAppleAuthority(t *testing.T, store *SQLiteStore, email string) (string, string) {
	t.Helper()
	ctx := context.Background()
	userID, _, attemptID := seedAuthorityBoundUser(t, store, email)
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: userID, Provider: ProviderApple, PlanID: "max", Status: "active",
		Cycle: "monthly", PeriodEnd: 1_699_000_000, ExternalID: "apple-orig-1",
		ExternalScope: testBundleIOS, EventAt: 100, Now: 100,
	}); err != nil {
		t.Fatalf("seed active apple: %v", err)
	}
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: userID, Provider: ProviderApple, PlanID: freePlanID, Status: "canceled",
		PeriodEnd: 1_699_000_000, ExternalID: "apple-orig-1", ExternalScope: testBundleIOS,
		EventAt: 200, Now: 200,
	}); err != nil {
		t.Fatalf("seed cancelled apple: %v", err)
	}
	return userID, attemptID
}

func TestGrantOnCancelledAppleAuthorityPreservesEveryProviderRow(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	userID, _ := seedCancelledAppleAuthority(t, store, "cancelled-apple@example.test")
	before := snapshotProvider(t, store, userID)
	if !before.hasAuthority {
		t.Fatal("fixture has no billing authority; this test proves nothing")
	}

	// The confirmation page must SAY the authority is there, and must not
	// promote it into a claim that a subscription is active.
	page := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(userID, "max", "30", AdminGrantModeFromNow))
	body := readAll(t, page)
	page.Body.Close()
	if !strings.Contains(body, "billing authority on record: apple") {
		t.Fatalf("confirmation page does not warn about the coexisting authority; body=%.3000s", body)
	}
	if !strings.Contains(body, "no live paid subscription is confirmed") {
		t.Fatalf("confirmation page must not imply a live subscription from an authority; body=%.3000s", body)
	}
	// Non-secret: the bound App Store account token is a user identifier.
	if strings.Contains(body, before.authority.AppleAccountToken) {
		t.Fatal("SECURITY: the confirmation page leaked the bound App Store account token")
	}

	tok := extractConfirmToken(t, body)
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("grant on an authority-bound account = %d, want 302; body=%s", resp.StatusCode, readAll(t, resp))
	}

	// The grant landed...
	g, ok, err := store.AdminPlanGrant(context.Background(), userID)
	if err != nil || !ok {
		t.Fatalf("AdminPlanGrant: ok=%v err=%v", ok, err)
	}
	if g.PlanID != "max" {
		t.Fatalf("granted plan = %q, want max", g.PlanID)
	}
	// ...and nothing a provider owns moved.
	assertProviderUntouched(t, before, snapshotProvider(t, store, userID))

	// The audit has to answer "was there payment authority when this grant was
	// made" without a reader having to reconstruct it from other tables — and it
	// must record the authority WITHOUT its account token.
	entries, err := store.ListAudit(context.Background(), 10, 0, AuditUserPlanGrant)
	if err != nil || len(entries) != 1 {
		t.Fatalf("want one grant audit entry, got %d (err %v)", len(entries), err)
	}
	if !strings.Contains(entries[0].Changes, "provider_state_unchanged") ||
		!strings.Contains(entries[0].Changes, "billing authority on record: apple") {
		t.Fatalf("audit does not record the coexisting authority: %s", entries[0].Changes)
	}
	if strings.Contains(entries[0].Changes, before.authority.AppleAccountToken) {
		t.Fatal("SECURITY: the audit entry carries the bound App Store account token")
	}
}

func TestGrantWithAmbiguousAppleAttemptWarnsAndLeavesItDispatched(t *testing.T) {
	// The exact production shape: an account that PROJECTS free, holds an Apple
	// authority at epoch 1, and has a purchase attempt still in 'dispatched' —
	// nobody knows yet whether Apple charged. A grant is allowed here (it cannot
	// mask the channel), the operator must be warned, and the unresolved attempt
	// must be left exactly as unresolved as it was.
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	userID, _, attemptID := seedAuthorityBoundUser(t, store, "ambiguous-attempt@example.test")
	before := snapshotProvider(t, store, userID)
	if before.attempts[attemptID] != "dispatched" {
		t.Fatalf("fixture attempt state = %q, want dispatched", before.attempts[attemptID])
	}

	page := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(userID, "plus", "1", AdminGrantModeFromNow))
	body := readAll(t, page)
	page.Body.Close()
	if !strings.Contains(body, "billing authority on record: apple") ||
		!strings.Contains(body, "no live paid subscription is confirmed") {
		t.Fatalf("ambiguous-attempt account was not warned about honestly; body=%.3000s", body)
	}
	tok := extractConfirmToken(t, body)
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("grant = %d, want 302; body=%s", resp.StatusCode, readAll(t, resp))
	}
	after := snapshotProvider(t, store, userID)
	if after.attempts[attemptID] != "dispatched" {
		t.Fatalf("FINANCIAL: the unresolved purchase attempt moved to %q", after.attempts[attemptID])
	}
	assertProviderUntouched(t, before, after)
}

func TestGrantNoticeDoesNotClaimAnElapsedSourceIsStillBilling(t *testing.T) {
	// The other half of "an authority is not a subscription": a SOURCE ROW is not
	// a subscription either, once its paid-through instant has passed. A paid tier
	// carrying a still-live status word whose period ended — what a subscription
	// leaves behind when its terminal provider event never arrives — must not be
	// reported to the operator as currently granting paid access, and must still
	// be reported as a row on record so they can go and check it.
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()

	const paidThrough = int64(1_700_000_000)
	u, err := store.UpsertUserByEmail(ctx, "elapsed-source@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderStripe, PlanID: "plus", Status: "active",
		Cycle: "monthly", PeriodEnd: paidThrough, ExternalID: "sub_elapsed",
		EventAt: paidThrough - adminGrantDaySecs, Now: paidThrough - adminGrantDaySecs,
	}); err != nil {
		t.Fatalf("seed elapsed stripe source: %v", err)
	}
	src, err := store.ListSubscriptionSources(ctx, u.ID)
	if err != nil || len(src) != 1 || !src[0].grantsAccess() {
		t.Fatalf("fixture is not a status-live paid row (%+v, err %v); this test would prove nothing", src, err)
	}

	notice := func(at int64) string {
		t.Helper()
		svc.SetNow(func() time.Time { return time.Unix(at, 0) })
		got, err := svc.providerCoexistenceNotice(ctx, u.ID)
		if err != nil {
			t.Fatalf("providerCoexistenceNotice at %d: %v", at, err)
		}
		return got
	}

	// Control: one second BEFORE the paid-through instant the source is asserted,
	// so the assertions below cannot pass merely because the fixture grants
	// nothing at any time.
	if live := notice(paidThrough - 1); !strings.Contains(live, "currently granting paid access: stripe") {
		t.Fatalf("an unelapsed paid source is no longer reported as live: %s", live)
	}
	// From the paid-through instant onwards — inclusive, the boundary being the
	// strictest reading of "period_end <= now" — the live claim is withdrawn,
	// while the row itself stays on record.
	for _, at := range []int64{paidThrough, paidThrough + 1, paidThrough + 365*adminGrantDaySecs} {
		got := notice(at)
		if strings.Contains(got, "currently granting paid access") {
			t.Fatalf("FINANCIAL: at %d the warning still claims an elapsed source is billing: %s", at, got)
		}
		if !strings.Contains(got, "no live paid subscription is confirmed") {
			t.Fatalf("at %d the warning does not state that nothing live is confirmed: %s", at, got)
		}
		if !strings.Contains(got, "subscription source rows: stripe") {
			t.Fatalf("at %d the warning hid the recorded provider row: %s", at, got)
		}
	}

	// The narrowing is one-directional. A row with NO paid-through instant on
	// record (0 = unknown) is not evidence that billing ended, so it stays
	// asserted — under-warning an operator about a channel that may still be
	// charging is the failure this whole notice exists to avoid.
	unknown, err := store.UpsertUserByEmail(ctx, "unknown-period@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: unknown.ID, Provider: ProviderStripe, PlanID: "plus", Status: "active",
		Cycle: "monthly", PeriodEnd: 0, ExternalID: "sub_unknown_period",
		EventAt: paidThrough - adminGrantDaySecs, Now: paidThrough - adminGrantDaySecs,
	}); err != nil {
		t.Fatalf("seed unknown-period stripe source: %v", err)
	}
	svc.SetNow(func() time.Time { return time.Unix(paidThrough+365*adminGrantDaySecs, 0) })
	unknownNotice, err := svc.providerCoexistenceNotice(ctx, unknown.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(unknownNotice, "currently granting paid access: stripe") {
		t.Fatalf("FINANCIAL: an unknown paid-through instant was read as proof that billing ended: %s", unknownNotice)
	}

	// The operator-facing console carries the same honest sentence, and granting
	// on top of the elapsed row moves nothing a provider owns.
	svc.SetNow(func() time.Time { return time.Unix(paidThrough+adminGrantDaySecs, 0) })
	before := snapshotProvider(t, store, u.ID)
	page := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", "7", AdminGrantModeFromNow))
	body := readAll(t, page)
	page.Body.Close()
	if strings.Contains(body, "currently granting paid access") {
		t.Fatalf("the confirmation page overstates an elapsed source; body=%.3000s", body)
	}
	if !strings.Contains(body, "subscription source rows: stripe") ||
		!strings.Contains(body, "no live paid subscription is confirmed") {
		t.Fatalf("the confirmation page does not report the elapsed row honestly; body=%.3000s", body)
	}
	tok := extractConfirmToken(t, body)
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("grant over an elapsed source = %d, want 302; body=%s", resp.StatusCode, readAll(t, resp))
	}
	assertProviderUntouched(t, before, snapshotProvider(t, store, u.ID))

	// The audit inherits both halves: the row is recorded, and it is not promoted
	// into a claim that somebody was being charged when the comp was handed out.
	entries, err := store.ListAudit(ctx, 10, 0, AuditUserPlanGrant)
	if err != nil || len(entries) != 1 {
		t.Fatalf("want one grant audit entry, got %d (err %v)", len(entries), err)
	}
	if !strings.Contains(entries[0].Changes, "subscription source rows: stripe") {
		t.Fatalf("audit does not record the coexisting source row: %s", entries[0].Changes)
	}
	if strings.Contains(entries[0].Changes, "currently granting paid access") {
		t.Fatalf("FINANCIAL: audit claims an elapsed source was billing: %s", entries[0].Changes)
	}
}

func TestProviderEventDuringAGrantPersistsAndTakesOverAtExpiry(t *testing.T) {
	// Reconciliation must not pause while a grant is live: a provider event that
	// arrives underneath one has to be recorded, and it has to be what the
	// account falls back to the moment the grant ends.
	svc, store, setNow := grantEnv(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "event-during-grant@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	const now = 1_700_000_000
	g, err := store.GrantAdminPlan(ctx, u.ID, "max", AdminGrantModeFromNow, 3, now)
	if err != nil {
		t.Fatalf("GrantAdminPlan: %v", err)
	}

	res, err := store.ApplySubscriptionSource(ctx, SourceEvent{
		UserID: u.ID, Provider: ProviderStripe, PlanID: "plus", Status: "active",
		Cycle: "monthly", PeriodEnd: now + 90*86400, ExternalID: "sub_during_grant",
		EventAt: now + 5, Now: now + 5,
	})
	if err != nil {
		t.Fatalf("ApplySubscriptionSource during grant: %v", err)
	}
	if !res.Applied {
		t.Fatal("FINANCIAL: a provider event was DROPPED while an admin grant was live")
	}
	sources, err := store.ListSubscriptionSources(ctx, u.ID)
	if err != nil || len(sources) != 1 {
		t.Fatalf("source rows = %d (err %v), want the stripe row persisted", len(sources), err)
	}
	if sources[0].PlanID != "plus" || sources[0].Status != "active" || sources[0].ExternalID != "sub_during_grant" {
		t.Fatalf("provider row not recorded faithfully: %+v", sources[0])
	}
	// The projection followed the provider, NOT the grant: nothing here made the
	// account look admin-comped to the billing machinery.
	got, _ := store.GetUserByID(ctx, u.ID)
	if got.PlanID != "plus" || got.PlanSource != ProviderStripe {
		t.Fatalf("projection = %q/%q, want plus/stripe", got.PlanID, got.PlanSource)
	}
	// While the grant is live the higher tier wins; at expiry the provider's own
	// entitlement is revealed, with no write of any kind in between.
	if eff := svc.effectivePlanID(ctx, got); eff != "max" {
		t.Fatalf("during grant: effective = %q, want max", eff)
	}
	setNow(g.ExpiresAt)
	if eff := svc.effectivePlanID(ctx, got); eff != "plus" {
		t.Fatalf("after expiry: effective = %q, want the provider's plus", eff)
	}
}

func TestGrantLeavesALegacyPermanentCompIntact(t *testing.T) {
	// The pre-existing permanent comp (plan_source='admin') must keep meaning
	// exactly what it meant. A grant does not convert it, shorten it, or expire
	// it: when the grant lapses the account falls back to the comp, not to Free.
	svc, store, setNow := grantEnv(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "legacy-comp@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	const now = 1_700_000_000
	if err := store.SetUserPlanAdmin(ctx, u.ID, "plus", now-1000); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}
	g, err := store.GrantAdminPlan(ctx, u.ID, "max", AdminGrantModeFromNow, 5, now)
	if err != nil {
		t.Fatalf("GrantAdminPlan: %v", err)
	}
	got, _ := store.GetUserByID(ctx, u.ID)
	if got.PlanID != "plus" || got.PlanSource != SourceAdmin {
		t.Fatalf("the permanent comp was reinterpreted: %q/%q, want plus/admin", got.PlanID, got.PlanSource)
	}
	if eff := svc.effectivePlanID(ctx, got); eff != "max" {
		t.Fatalf("during grant: effective = %q, want max", eff)
	}
	setNow(g.ExpiresAt)
	if eff := svc.effectivePlanID(ctx, got); eff != "plus" {
		t.Fatalf("after expiry: effective = %q, want the permanent comp's plus", eff)
	}
}

// ---- the route: binding, validation, audit ----------------------------------

func TestConfirmedGrantPreviewsAndAuditsTheExactExpiry(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	at := int64(1_700_000_000)
	svc.SetNow(func() time.Time { return time.Unix(at, 0) })
	u, err := store.UpsertUserByEmail(ctx, "audit-grant@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	wantExpiry := at + 30*adminGrantDaySecs

	page := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", "30", AdminGrantModeFromNow))
	body := readAll(t, page)
	page.Body.Close()
	// The page has to state the RULE that produces the expiry, not a fixed
	// instant it cannot keep — see TestGrantPreviewPromisesTheRuleNotAStaleInstant
	// for why, and adminGrantExpiryPromise for the wording. Here the clock has not
	// moved between render and confirmation, so this asserts the shape of the
	// promise rather than the drift it protects against.
	if !strings.Contains(body, "30 whole days from successful confirmation") {
		t.Fatalf("confirmation page does not state the from-now rule; body=%.3000s", body)
	}
	if !strings.Contains(body, "replaces any existing grant") {
		t.Fatalf("confirmation page does not spell out what from-now does; body=%.3000s", body)
	}
	tok := extractConfirmToken(t, body)
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed grant = %d, want 302; body=%s", resp.StatusCode, readAll(t, resp))
	}

	g, ok, err := store.AdminPlanGrant(ctx, u.ID)
	if err != nil || !ok {
		t.Fatalf("AdminPlanGrant: ok=%v err=%v", ok, err)
	}
	if g.ExpiresAt != wantExpiry || g.PlanID != "max" || g.GrantedAt != at {
		t.Fatalf("stored grant = %+v, want max expiring at %d granted at %d", g, wantExpiry, at)
	}

	entries, err := store.ListAudit(ctx, 10, 0, AuditUserPlanGrant)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want exactly one %s audit entry, got %d", AuditUserPlanGrant, len(entries))
	}
	e := entries[0]
	if e.Target != "user:"+u.ID {
		t.Fatalf("audit target = %q, want user:%s", e.Target, u.ID)
	}
	if e.Actor == "" || e.StepUp == "" {
		t.Fatalf("audit does not identify the operator or the factor: %+v", e)
	}
	// Plan, mode, duration and the EXACT expiry — the exact one that was stored,
	// which is what confirmNow's frozen instant guarantees.
	for _, want := range []string{
		`"grant_plan"`, `"max"`,
		`"grant_mode"`, "replaces any existing grant",
		`"grant_days"`, ":30",
		`"grant_expires_at"`, adminGrantExpiryLabel(wantExpiry),
	} {
		if !strings.Contains(e.Changes, want) {
			t.Fatalf("audit changes missing %q: %s", want, e.Changes)
		}
	}
	// No secrets, and nothing that identifies a payment account.
	for _, forbidden := range []string{"secret123", cookie.Value, tok} {
		if strings.Contains(e.Changes, forbidden) || strings.Contains(e.Target, forbidden) {
			t.Fatal("SECURITY: the audit entry carries a secret")
		}
	}
}

func TestConfirmedGrantExtensionStacksOnTheLiveGrant(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	at := int64(1_700_000_000)
	svc.SetNow(func() time.Time { return time.Unix(at, 0) })
	u, err := store.UpsertUserByEmail(ctx, "extend-grant@example.test", "")
	if err != nil {
		t.Fatal(err)
	}

	first := confirmAction(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", "10", AdminGrantModeFromNow))
	first.Body.Close()
	if first.StatusCode != http.StatusFound {
		t.Fatalf("first grant = %d, want 302", first.StatusCode)
	}
	g1, _, _ := store.AdminPlanGrant(ctx, u.ID)

	// Time passes, but less than the grant's remaining life.
	at += 3 * adminGrantDaySecs
	second := confirmAction(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", "7", AdminGrantModeExtend))
	second.Body.Close()
	if second.StatusCode != http.StatusFound {
		t.Fatalf("extend = %d, want 302", second.StatusCode)
	}
	g2, _, _ := store.AdminPlanGrant(ctx, u.ID)
	if want := g1.ExpiresAt + 7*adminGrantDaySecs; g2.ExpiresAt != want {
		t.Fatalf("extended expiry = %d, want %d (the live grant's expiry plus 7 days)", g2.ExpiresAt, want)
	}
	// The remaining 7 days of the first grant were not thrown away.
	if g2.ExpiresAt <= at+7*adminGrantDaySecs {
		t.Fatalf("extend lost the time already granted: %d", g2.ExpiresAt)
	}
}

// The confirmation page is rendered when the operator submits the form; the
// write happens when they clear the second factor, an unbounded number of
// seconds later. So the page must not print an exact expiry instant — it would
// be a promise the write contradicts by exactly that delay.
//
// The defect this pins down: the page computed the expiry from ITS OWN clock and
// printed "expires 2026-…-… 12:00:00 UTC", the operator went to fetch their
// phone, and the account was written with an expiry four minutes later. Neither
// number was wrong on its own; the PAGE was, for claiming to know one.
//
// The two repairs that look obvious are both worse, and this test is what keeps
// them out. Freezing the page's instant and writing it at confirmation would
// hand over less than the whole days requested. Shortening the promise to
// "about 30 days" would give up the arithmetic the operator needs. What is
// asserted instead is all three properties at once: the page promises only the
// RULE, the account receives the FULL duration measured from confirmation, and
// the audit's expiry is the stored expiry to the second.
func TestGrantPreviewPromisesTheRuleNotAStaleInstant(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	at := int64(1_700_000_000)
	svc.SetNow(func() time.Time { return time.Unix(at, 0) })
	u, err := store.UpsertUserByEmail(ctx, "grant-drift@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	before := snapshotProvider(t, store, u.ID)

	renderedAt := at
	page := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", "30", AdminGrantModeFromNow))
	body := readAll(t, page)
	page.Body.Close()

	// 1. The page states the rule.
	if !strings.Contains(body, "30 whole days from successful confirmation") {
		t.Fatalf("confirmation page does not state the from-now rule; body=%.3000s", body)
	}
	// 2. And it states NO fixed instant. Not the one its own clock would have
	//    produced, and not one for any instant inside the delay that follows: the
	//    account has no grant, so adminGrantExpiryLabel's format has no legitimate
	//    reason to appear anywhere on this page at all.
	if strings.Contains(body, " UTC (") {
		t.Fatalf("confirmation page promises a fixed expiry timestamp it cannot keep; body=%.3000s", body)
	}
	if strings.Contains(body, adminGrantExpiryLabel(renderedAt+30*adminGrantDaySecs)) {
		t.Fatalf("confirmation page promises the PAGE-RENDER expiry; body=%.3000s", body)
	}

	// The operator reads the page, finds their second factor, and submits. Well
	// inside pendingActionTTL, and well past stepUpGraceSecs, so the factor is
	// genuinely re-checked at the later instant.
	at = renderedAt + 240
	tok := extractConfirmToken(t, body)
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed grant = %d, want 302; body=%s", resp.StatusCode, readAll(t, resp))
	}

	// 3. Thirty WHOLE days measured from the confirmation, not from the render.
	//    The delay cost the operator nothing.
	wantExpiry := at + 30*adminGrantDaySecs
	g, ok, err := store.AdminPlanGrant(ctx, u.ID)
	if err != nil || !ok {
		t.Fatalf("AdminPlanGrant: ok=%v err=%v", ok, err)
	}
	if g.ExpiresAt != wantExpiry {
		t.Fatalf("stored expiry = %d, want %d (30 days from CONFIRMATION at %d, not from the page render at %d)",
			g.ExpiresAt, wantExpiry, at, renderedAt)
	}
	if g.GrantedAt != at {
		t.Fatalf("granted_at = %d, want the confirmation instant %d", g.GrantedAt, at)
	}
	if g.ExpiresAt-g.GrantedAt != 30*adminGrantDaySecs {
		t.Fatalf("the account received %d seconds, want exactly 30 whole days", g.ExpiresAt-g.GrantedAt)
	}

	// 4. Audit == storage, to the second, and the stale page instant is nowhere
	//    in the record.
	entries, err := store.ListAudit(ctx, 10, 0, AuditUserPlanGrant)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want exactly one %s audit entry, got %d", AuditUserPlanGrant, len(entries))
	}
	if !strings.Contains(entries[0].Changes, adminGrantExpiryLabel(g.ExpiresAt)) {
		t.Fatalf("audit expiry does not equal the stored expiry %d: %s", g.ExpiresAt, entries[0].Changes)
	}
	if strings.Contains(entries[0].Changes, adminGrantExpiryLabel(renderedAt+30*adminGrantDaySecs)) {
		t.Fatalf("audit recorded the PAGE-RENDER expiry rather than the written one: %s", entries[0].Changes)
	}
	assertProviderUntouched(t, before, snapshotProvider(t, store, u.ID))
}

// The same drift, in the mode where it changes the answer rather than just the
// number: an extend whose base grant LAPSES between the page and the
// confirmation. At render time there is an unexpired grant to extend; by the
// time the operator confirms there is not, so the write correctly falls back to
// a plain from-now grant.
//
// A page that had printed "old expiry + 5 days" would be describing an outcome
// the write must not produce — resurrecting a lapsed grant back-dates
// entitlement into a window the account did not have it. Which is precisely why
// the extend promise has to name its fallback out loud.
func TestGrantExtendPreviewNamesTheFallbackWhenTheBaseGrantLapses(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	at := int64(1_700_000_000)
	svc.SetNow(func() time.Time { return time.Unix(at, 0) })
	u, err := store.UpsertUserByEmail(ctx, "grant-lapse@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	base, err := store.GrantAdminPlan(ctx, u.ID, "max", AdminGrantModeFromNow, 1, at)
	if err != nil {
		t.Fatalf("GrantAdminPlan: %v", err)
	}

	// Render two minutes before the base grant lapses: it is still live, so the
	// old code would have previewed base.ExpiresAt + 5 days.
	at = base.ExpiresAt - 120
	page := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", "5", AdminGrantModeExtend))
	body := readAll(t, page)
	page.Body.Close()
	for _, want := range []string{
		"5 days added to the unexpired grant expiry on this account as it exists when the confirmation applies",
		"if no grant is unexpired at that moment, 5 whole days from successful confirmation",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("extend preview does not state %q; body=%.3000s", want, body)
		}
	}
	if strings.Contains(body, adminGrantExpiryLabel(base.ExpiresAt+5*adminGrantDaySecs)) {
		t.Fatalf("extend preview promises the lapsing base grant's expiry + 5 days; body=%.3000s", body)
	}

	// Two minutes past it, the base grant is gone.
	at = base.ExpiresAt + 120
	tok := extractConfirmToken(t, body)
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirmed extend = %d, want 302; body=%s", resp.StatusCode, readAll(t, resp))
	}

	g, ok, err := store.AdminPlanGrant(ctx, u.ID)
	if err != nil || !ok {
		t.Fatalf("AdminPlanGrant: ok=%v err=%v", ok, err)
	}
	if want := at + 5*adminGrantDaySecs; g.ExpiresAt != want {
		t.Fatalf("lapsed extend expiry = %d, want %d (5 days from confirmation)", g.ExpiresAt, want)
	}
	// Stated the other way round, because these two answers are only 120 seconds
	// apart and an equality check alone reads as an arbitrary constant: the value
	// that must NOT have been written is the one the page would have printed had
	// it printed anything — the lapsed base expiry plus five days.
	if stale := base.ExpiresAt + 5*adminGrantDaySecs; g.ExpiresAt == stale {
		t.Fatalf("extend anchored on the base grant that had already lapsed by confirmation "+
			"(%d — the page-render answer), instead of granting from confirmation", stale)
	}
	entries, err := store.ListAudit(ctx, 10, 0, AuditUserPlanGrant)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want exactly one %s audit entry, got %d", AuditUserPlanGrant, len(entries))
	}
	if !strings.Contains(entries[0].Changes, adminGrantExpiryLabel(g.ExpiresAt)) {
		t.Fatalf("audit expiry does not equal the stored expiry %d: %s", g.ExpiresAt, entries[0].Changes)
	}
}

// The upper bound, through the WHOLE route rather than through the arithmetic
// alone. adminGrantMaxDays is checked in three places — the parser, the handler
// and the store's transaction — and TestAdminGrantDurationBoundsAreExactAndTotal
// only proves the first accepts it. A ceiling that parses and is then refused by
// the store, or that overflows somewhere on the way down, is the same defect as
// an off-by-one in the parser: the console offers a duration it cannot deliver.
//
// So this confirms an actual 1000-day grant end to end and then walks the clock
// across the far edge, because the number that matters at this bound is not the
// one the page prints but whether entitlement really lasts until it and really
// stops there.
func TestConfirmedGrantAtTheThousandDayUpperBoundary(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	at := int64(1_700_000_000)
	svc.SetNow(func() time.Time { return time.Unix(at, 0) })
	u, err := store.UpsertUserByEmail(ctx, "grant-ceiling@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	before := snapshotProvider(t, store, u.ID)

	days := strconv.FormatInt(adminGrantMaxDays, 10)
	resp := confirmAction(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", days, AdminGrantModeFromNow))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("grant at the %s-day ceiling = %d, want 302; body=%.1000s", days, resp.StatusCode, body)
	}

	wantExpiry := at + adminGrantMaxDays*adminGrantDaySecs
	g, ok, err := store.AdminPlanGrant(ctx, u.ID)
	if err != nil || !ok {
		t.Fatalf("AdminPlanGrant: ok=%v err=%v", ok, err)
	}
	if g.PlanID != "max" || g.GrantedAt != at || g.ExpiresAt != wantExpiry {
		t.Fatalf("stored grant = %+v, want max granted at %d expiring at %d", g, at, wantExpiry)
	}

	// Entitlement is real for the whole 1000 days, and gone the instant they end.
	reload := func() User {
		got, err := store.GetUserByID(ctx, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	for _, step := range []struct {
		name string
		when int64
		want string
	}{
		{"at the grant", at, "max"},
		{"one second before expiry", wantExpiry - 1, "max"},
		{"at expiry (exclusive)", wantExpiry, freePlanID},
		{"after expiry", wantExpiry + adminGrantDaySecs, freePlanID},
	} {
		at = step.when
		if got := svc.effectivePlanID(ctx, reload()); got != step.want {
			t.Fatalf("%s: effective plan = %q, want %q", step.name, got, step.want)
		}
	}
	at = wantExpiry - 1

	// The audit records the ceiling and the exact instant it produced.
	entries, err := store.ListAudit(ctx, 10, 0, AuditUserPlanGrant)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want exactly one %s audit entry, got %d", AuditUserPlanGrant, len(entries))
	}
	for _, want := range []string{`"grant_days"`, ":" + days, adminGrantExpiryLabel(wantExpiry)} {
		if !strings.Contains(entries[0].Changes, want) {
			t.Fatalf("audit changes missing %q: %s", want, entries[0].Changes)
		}
	}
	assertProviderUntouched(t, before, snapshotProvider(t, store, u.ID))
}

func TestGrantRefusesOutOfRangeDurationsWithoutMutating(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "bad-duration@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	// Give the account a real grant first, so a refusal that "resets" the column
	// would be caught rather than looking like the untouched zero value.
	base, err := store.GrantAdminPlan(ctx, u.ID, "plus", AdminGrantModeFromNow, 5, 1_700_000_000)
	if err != nil {
		t.Fatal(err)
	}

	for _, bad := range []string{"0", "-1", "1001", "1.5", "abc", "", "9223372036854775808"} {
		// The refusal must happen at the CONFIRMATION PAGE, before an operator
		// can be shown a page for a grant that could never apply.
		resp := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", bad, AdminGrantModeFromNow))
		body := readAll(t, resp)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("grant_days=%q = %d, want 400 (not a confirmation page, and not a 500); body=%.500s",
				bad, resp.StatusCode, body)
		}
		if strings.Contains(body, "confirm_token") {
			t.Fatalf("grant_days=%q rendered a confirmation page", bad)
		}
		got, _, _ := store.AdminPlanGrant(ctx, u.ID)
		if got != base {
			t.Fatalf("grant_days=%q MUTATED the grant: %+v, want %+v", bad, got, base)
		}
	}
	// The same for an unknown mode.
	resp := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", "5", "sideways"))
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown mode = %d, want 400", resp.StatusCode)
	}
	if got, _, _ := store.AdminPlanGrant(ctx, u.ID); got != base {
		t.Fatalf("an unknown mode mutated the grant: %+v", got)
	}
	entries, err := store.ListAudit(ctx, 10, 0, AuditUserPlanGrant)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("AUDIT INTEGRITY: a refused grant was logged: %+v", entries)
	}
}

func TestGrantConfirmationIsBoundToPlanDaysAndMode(t *testing.T) {
	// The confirmation POST carries only a token. Every value the operator was
	// shown comes from the pending action, so a tampered confirm — different
	// tier, different duration, different mode — must apply what the PAGE said,
	// not what the second request asked for.
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	at := int64(1_700_000_000)
	svc.SetNow(func() time.Time { return time.Unix(at, 0) })
	u, err := store.UpsertUserByEmail(ctx, "bound-confirm@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	victim, err := store.UpsertUserByEmail(ctx, "bound-victim@example.test", "")
	if err != nil {
		t.Fatal(err)
	}

	page := postAdminForm(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "plus", "1", AdminGrantModeFromNow))
	body := readAll(t, page)
	page.Body.Close()
	tok := extractConfirmToken(t, body)

	resp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{
		"confirm_token": {tok}, "factor_code": {"secret123"},
		// Every field the attacker would want to change.
		"user_id": {victim.ID}, "plan_id": {"max"},
		"grant_days": {"1000"}, "grant_mode": {AdminGrantModeExtend},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("confirm = %d, want 302; body=%s", resp.StatusCode, readAll(t, resp))
	}
	g, ok, err := store.AdminPlanGrant(ctx, u.ID)
	if err != nil || !ok {
		t.Fatalf("AdminPlanGrant: ok=%v err=%v", ok, err)
	}
	if g.PlanID != "plus" {
		t.Fatalf("SECURITY: the confirm POST changed the granted tier to %q", g.PlanID)
	}
	if want := at + adminGrantDaySecs; g.ExpiresAt != want {
		t.Fatalf("SECURITY: the confirm POST changed the duration: expiry %d, want %d", g.ExpiresAt, want)
	}
	if _, ok, _ := store.AdminPlanGrant(ctx, victim.ID); ok {
		t.Fatal("SECURITY: the confirm POST redirected the grant to a different account")
	}
}

func TestGrantConfirmFailsClosedWithoutFactorForeignSessionOrReplay(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	sessionA := adminLoginCookie(t, ts)
	sessionB := adminLoginCookie(t, ts)
	if sessionA.Value == sessionB.Value {
		t.Fatal("the two logins share a session token; this test proves nothing")
	}
	grantTiers(t, store)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "grant-failclosed@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	mint := func(session *http.Cookie) string {
		resp := postAdminForm(t, ts, session, "/admin/users/grant", grantForm(u.ID, "max", "30", AdminGrantModeFromNow))
		body := readAll(t, resp)
		resp.Body.Close()
		return extractConfirmToken(t, body)
	}
	assertNoGrant := func(what string) {
		t.Helper()
		if _, ok, _ := store.AdminPlanGrant(ctx, u.ID); ok {
			t.Fatalf("SECURITY: %s produced a grant", what)
		}
	}

	// No second factor at all.
	noFactor := postAdminForm(t, ts, sessionA, "/admin/confirm", url.Values{"confirm_token": {mint(sessionA)}})
	noFactor.Body.Close()
	if noFactor.StatusCode != http.StatusUnauthorized {
		t.Fatalf("factor-less confirm = %d, want 401", noFactor.StatusCode)
	}
	assertNoGrant("a factor-less confirm")

	// Wrong second factor.
	wrongFactor := postAdminForm(t, ts, sessionA, "/admin/confirm",
		url.Values{"confirm_token": {mint(sessionA)}, "factor_code": {"not-the-password"}})
	wrongFactor.Body.Close()
	if wrongFactor.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong-factor confirm = %d, want 401", wrongFactor.StatusCode)
	}
	assertNoGrant("a wrong-factor confirm")

	// A token minted by one session, spent by another — and then the burned
	// token replayed by the session that DID mint it.
	tok := mint(sessionA)
	foreign := postAdminForm(t, ts, sessionB, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	foreign.Body.Close()
	if foreign.StatusCode == http.StatusFound {
		t.Fatal("SECURITY: a pending grant was redeemed by a different session")
	}
	replay := postAdminForm(t, ts, sessionA, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	replay.Body.Close()
	if replay.StatusCode == http.StatusFound {
		t.Fatal("SECURITY: a pending grant token survived a foreign redemption attempt")
	}
	assertNoGrant("a foreign or replayed token")

	// CSRF: no session cookie at all cannot reach the route.
	anon, err := http.NewRequest(http.MethodPost, ts.URL+"/admin/users/grant",
		strings.NewReader(grantForm(u.ID, "max", "30", AdminGrantModeFromNow).Encode()))
	if err != nil {
		t.Fatal(err)
	}
	anon.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	anonResp, err := client.Do(anon)
	if err != nil {
		t.Fatal(err)
	}
	anonResp.Body.Close()
	if anonResp.StatusCode == http.StatusOK {
		t.Fatalf("an unauthenticated grant request rendered a page (%d)", anonResp.StatusCode)
	}
	assertNoGrant("an unauthenticated request")
}

func TestGrantRejectsInactiveAndFreeTiers(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	if err := store.UpsertPlan(ctx, Plan{ID: "retired", Name: "Retired", SortOrder: 3,
		PriceMonthly: 9999, Active: false, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	u, err := store.UpsertUserByEmail(ctx, "bad-tier@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, plan := range []string{"retired", freePlanID, "no-such-plan"} {
		resp := confirmAction(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, plan, "30", AdminGrantModeFromNow))
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("grant of %q = %d, want 400", plan, resp.StatusCode)
		}
		if _, ok, _ := store.AdminPlanGrant(ctx, u.ID); ok {
			t.Fatalf("grant of %q was recorded", plan)
		}
	}
}

func TestGrantRefusedOnAnAccountBeingDeleted(t *testing.T) {
	// An account whose billing is being torn down must not be handed paid
	// capacity — the grant would either be erased by the purge or outlive the
	// deletion hold it is meant to respect.
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "deleting@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx,
		`UPDATE users SET deleted_at=?, purge_after=? WHERE id=?`,
		int64(1_700_000_000), int64(1_700_000_000+30*86400), u.ID); err != nil {
		t.Fatal(err)
	}

	resp := confirmAction(t, ts, cookie, "/admin/users/grant", grantForm(u.ID, "max", "30", AdminGrantModeFromNow))
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("grant on a pending-deletion account = %d, want 409; body=%s", resp.StatusCode, body)
	}
	if !strings.Contains(body, "deletion") {
		t.Fatalf("the 409 does not tell the operator what to do; body=%s", body)
	}
	if _, ok, _ := store.AdminPlanGrant(ctx, u.ID); ok {
		t.Fatal("FINANCIAL: entitlement was granted to an account being deleted")
	}
	entries, _ := store.ListAudit(ctx, 10, 0, AuditUserPlanGrant)
	if len(entries) != 0 {
		t.Fatalf("AUDIT INTEGRITY: a refused grant was logged: %+v", entries)
	}
}

func TestGrantSurvivesAPurgeOnlyByDisappearingWithTheAccount(t *testing.T) {
	// The overlay lives on the users row, so a hard delete takes it with the
	// account. Asserted rather than assumed: an orphaned grant would attach paid
	// entitlement to a recycled id.
	store := newTestStore(t)
	grantTiers(t, store)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "purge-me@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	const now = 1_700_000_000
	if _, err := store.GrantAdminPlan(ctx, u.ID, "max", AdminGrantModeFromNow, 30, now); err != nil {
		t.Fatal(err)
	}
	// The REAL purge path, not a stand-in DELETE: whether the overlay is carried
	// away with the account is a property of ArchiveAndPurgeUser, so that is what
	// has to be exercised.
	if _, err := store.db.ExecContext(ctx,
		`UPDATE users SET deleted_at=?, purge_after=? WHERE id=?`, now, now, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.ArchiveAndPurgeUser(ctx, u.ID, now); err != nil {
		t.Fatalf("ArchiveAndPurgeUser: %v", err)
	}
	if _, err := store.GetUserByID(ctx, u.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the account survived its own purge: %v", err)
	}
	if _, ok, err := store.AdminPlanGrant(ctx, u.ID); ok || err != nil {
		t.Fatalf("the grant outlived the purged account: ok=%v err=%v", ok, err)
	}
}

// ---- the migration, in both directions --------------------------------------

func TestGrantColumnsAreRollbackSafe(t *testing.T) {
	// scripts/test/db-rollback-harness.sh is the authoritative gate for a real
	// two-binary rollback. This is the narrow, in-package half of the same
	// question, aimed at the only thing THIS change adds to that risk: three new
	// users columns. The claim in the migration comment is that an older binary
	// keeps working against a migrated database, and it rests on two properties
	// that are checkable right here.
	store := newTestStore(t)
	grantTiers(t, store)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "rollback@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.GrantAdminPlan(ctx, u.ID, "max", AdminGrantModeFromNow, 30, 1_700_000_000); err != nil {
		t.Fatal(err)
	}

	// 1. An older binary's INSERT never names the new columns, so they have to
	//    take their defaults rather than fail a NOT NULL constraint.
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO users (id, email, display_name, created_at, canonical_email, billing_hold_hmac)
		 VALUES ('legacy-insert', 'legacy@example.test', '', 1, 'legacy@example.test', X'')`); err != nil {
		t.Fatalf("an older binary's INSERT no longer works against the migrated schema: %v", err)
	}
	var plan string
	var expires int64
	if err := store.db.QueryRowContext(ctx,
		`SELECT admin_grant_plan_id, admin_grant_expires_at FROM users WHERE id='legacy-insert'`).
		Scan(&plan, &expires); err != nil {
		t.Fatal(err)
	}
	if plan != "" || expires != 0 {
		t.Fatalf("defaults are not the never-granted zero value: %q/%d", plan, expires)
	}

	// 2. An older binary's SELECT — the exact pre-change column list — must still
	//    resolve, and the account it reads back must be the PROVIDER's view: free,
	//    with no source. That is the whole rollback safety argument. The old
	//    binary cannot see the grant, so it withdraws granted entitlement rather
	//    than stranding an overlay it has no code to expire.
	var oldPlan, oldSource string
	if err := store.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, only_own_nodes, deleted_at, purge_after, plan_id,
		        stripe_customer_id, stripe_subscription_id, subscription_status, subscription_end, plan_source,
		        scheduled_plan_id, scheduled_cycle, billing_cycle,
		        plan_started_at, quota_accrued_bytes, quota_accrued_period
		   FROM users WHERE id = ?`, u.ID).
		Scan(new(string), new(string), new(any), new(int64), new(int64), new(int64), new(int64), new(int64), &oldPlan,
			new(string), new(string), new(string), new(int64), &oldSource,
			new(string), new(string), new(string),
			new(int64), new(int64), new(string)); err != nil {
		t.Fatalf("an older binary's SELECT no longer works against the migrated schema: %v", err)
	}
	if oldPlan != freePlanID || oldSource != "" {
		t.Fatalf("a rolled-back binary would see %q/%q, want the untouched free projection", oldPlan, oldSource)
	}

	// 3. The forward migration is idempotent: OpenSQLite re-runs the ALTER list
	//    on every start, and a duplicate-column error must stay tolerated.
	if _, err := store.db.ExecContext(ctx,
		`ALTER TABLE users ADD COLUMN admin_grant_plan_id TEXT NOT NULL DEFAULT ''`); err == nil ||
		!strings.Contains(err.Error(), "duplicate column name") {
		t.Fatalf("re-running the migration produced %v, want the tolerated duplicate-column error", err)
	}
}

// ---- the console list -------------------------------------------------------

func TestAdminUsersPageShowsTheGrantAndWarnsAboutAuthority(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	grantTiers(t, store)
	ctx := context.Background()
	at := int64(1_700_000_000)
	svc.SetNow(func() time.Time { return time.Unix(at, 0) })
	userID, _ := seedCancelledAppleAuthority(t, store, "listed@example.test")
	if _, err := store.GrantAdminPlan(ctx, userID, "max", AdminGrantModeFromNow, 30, at); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/admin/users", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body := readAll(t, resp)

	if !strings.Contains(body, `action="/admin/users/grant"`) {
		t.Fatal("the users page offers no grant control")
	}
	// The warning is present, names the provider, and does NOT claim a
	// subscription — the whole point of separating authority from projection.
	if !strings.Contains(body, "apple") || !strings.Contains(body, "不代表当前有生效订阅") {
		t.Fatalf("the users page does not warn honestly about the coexisting authority; body=%.4000s", body)
	}
	// The live grant is shown with its expiry.
	if !strings.Contains(body, fmt.Sprintf("%s UTC", time.Unix(at+30*adminGrantDaySecs, 0).UTC().Format("2006-01-02 15:04"))) {
		t.Fatalf("the users page does not show the grant's expiry; body=%.4000s", body)
	}
	grantSection := body[strings.Index(body, `action="/admin/users/grant"`):]
	end := strings.Index(grantSection, "</form>")
	if end <= 0 {
		t.Fatal("the grant form is not closed")
	}
	form := grantSection[:end]
	// The free tier is never offered as a grantable membership.
	if strings.Contains(form, `value="`+freePlanID+`"`) {
		t.Fatal("the grant dropdown offers the free tier")
	}
	// The form's wire values and bounds come from the constants the server
	// enforces, so the control cannot drift into offering something the write
	// would then refuse.
	for _, want := range []string{
		`value="` + AdminGrantModeFromNow + `"`,
		`value="` + AdminGrantModeExtend + `"`,
		fmt.Sprintf(`min="%d"`, adminGrantMinDays),
		fmt.Sprintf(`max="%d"`, adminGrantMaxDays),
	} {
		if !strings.Contains(form, want) {
			t.Fatalf("grant form missing %q; form=%s", want, form)
		}
	}
}

// ---- enforcement actually follows the overlay --------------------------------

func TestEnforcementFollowsTheGrantAndReleasesItAtExpiry(t *testing.T) {
	// The overlay is worth nothing if the caps an account actually runs into do
	// not move with it, and dangerous if they do not move back.
	svc, store, setNow := grantEnv(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "enforced@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	const now = 1_700_000_000
	g, err := store.GrantAdminPlan(ctx, u.ID, "max", AdminGrantModeFromNow, 4, now)
	if err != nil {
		t.Fatal(err)
	}

	plan, err := svc.planForUser(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if plan.ID != "max" {
		t.Fatalf("planForUser during grant = %q, want max", plan.ID)
	}
	cap, err := svc.monthlyTrafficCap(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cap != int64(1)<<34 {
		t.Fatalf("monthly traffic cap during grant = %d, want the max tier's", cap)
	}
	setNow(g.ExpiresAt)
	if plan, err = svc.planForUser(ctx, u.ID); err != nil || plan.ID != freePlanID {
		t.Fatalf("planForUser after expiry = %q (err %v), want free", plan.ID, err)
	}
	if cap, err = svc.monthlyTrafficCap(ctx, u.ID); err != nil || cap != int64(1)<<20 {
		t.Fatalf("monthly traffic cap after expiry = %d (err %v), want the free tier's", cap, err)
	}
}
