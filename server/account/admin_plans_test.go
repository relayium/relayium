package account

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// The plan/user-plan tests below call the handlers directly rather than
// through POST /admin/plans or /admin/users/plan: those routes now sit
// behind RequireStepUp (Task 7), which renders a confirmation page instead
// of applying anything. These tests target the handlers' own
// validation/persistence logic, which is unchanged; the routes' step-up
// gating is covered separately by stepup_test.go.
//
// The route-level confirmation tests at the bottom of this file are the
// deliberate exception: a direct handler call cannot prove what an operator
// actually receives from POST /admin/users/plan → /admin/confirm, and the
// billing-conflict status this file now pins is a fact about that whole path
// (status mapping, audit suppression, grace window), not about the handler
// alone.
func TestAdminUpsertPlanUpdatesValues(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})

	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"200"}, "traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"daily_quota_mb": {"0"},
		"sort_order":     {"0"}, "active": {"1"},
	}
	w := callAdminHandler(svc.handleAdminUpsertPlan, admin, form, nil)
	if w.Code != http.StatusFound {
		t.Fatalf("upsert plan = %d, want 302", w.Code)
	}
	got, _, _ := store.GetPlan(context.Background(), "free")
	if got.StorageBytes != 200<<20 || got.TrafficBytes != 5<<30 || got.RetentionSecs != 7*86400 {
		t.Fatalf("plan not updated: %+v", got)
	}
}

func TestAdminUpsertPlanRefusesDeactivatingLastActivePlan(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})

	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"200"}, "traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"sort_order": {"0"}, // active omitted => false
	}
	w := callAdminHandler(svc.handleAdminUpsertPlan, admin, form, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("deactivate last active plan = %d, want 400", w.Code)
	}
	got, _, _ := store.GetPlan(context.Background(), "free")
	if !got.Active {
		t.Fatalf("plan should remain active: %+v", got)
	}
}

func TestAdminUpsertPlanRejectsOverflowingSize(t *testing.T) {
	ts, svc, _ := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"999999999999999999"}, // *<<20 overflows int64
		"traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"sort_order": {"0"}, "active": {"1"},
	}
	w := callAdminHandler(svc.handleAdminUpsertPlan, admin, form, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("overflowing storage_mb = %d, want 400", w.Code)
	}
}

func TestAdminAssignUserPlanActiveOnly(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	ctx := context.Background()
	_ = store.UpsertPlan(ctx, Plan{ID: "pro", Name: "Pro", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})
	_ = store.UpsertPlan(ctx, Plan{ID: "old", Name: "Old", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: false, UpdatedAt: 1})
	target, _ := store.UpsertUserByEmail(ctx, "target@example.com", "")

	post := func(plan string) int {
		form := url.Values{"user_id": {target.ID}, "plan_id": {plan}}
		return callAdminHandler(svc.handleAdminSetUserPlan, admin, form, nil).Code
	}

	if post("pro") != http.StatusFound {
		t.Fatal("assigning an active plan should 302")
	}
	got, _ := store.GetUserByID(ctx, target.ID)
	if got.PlanID != "pro" {
		t.Fatalf("plan = %q, want pro", got.PlanID)
	}
	// The assign route must go through SetUserPlanAdmin, not SetUserPlan, so
	// a later Stripe webhook for this user won't clobber the manual assignment.
	if got.PlanSource != "admin" {
		t.Fatalf("plan_source = %q, want admin", got.PlanSource)
	}
	if post("old") != http.StatusBadRequest {
		t.Fatal("assigning an inactive plan must 400")
	}
}

// TestAdminUpsertPlanPersistsStripePriceIDs verifies the plan-edit form's
// stripe_price_monthly_id/stripe_price_yearly_id fields round-trip through
// UpsertPlan untouched (free-form Stripe ids, no numeric validation).
func TestAdminUpsertPlanPersistsStripePriceIDs(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	_ = store.UpsertPlan(context.Background(), Plan{ID: "pro", Name: "Pro", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})

	form := url.Values{
		"id": {"pro"}, "name": {"Pro"},
		"storage_mb": {"200"}, "traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"999"}, "price_yearly_cents": {"9999"},
		"daily_quota_mb": {"0"},
		"sort_order":     {"0"}, "active": {"1"},
		"stripe_price_monthly_id": {"price_M"}, "stripe_price_yearly_id": {"price_Y"},
	}
	w := callAdminHandler(svc.handleAdminUpsertPlan, admin, form, nil)
	if w.Code != http.StatusFound {
		t.Fatalf("upsert plan = %d, want 302", w.Code)
	}
	got, ok, err := store.GetPlan(context.Background(), "pro")
	if err != nil || !ok {
		t.Fatalf("GetPlan: ok=%v err=%v", ok, err)
	}
	if got.StripePriceMonthlyID != "price_M" || got.StripePriceYearlyID != "price_Y" {
		t.Fatalf("stripe price ids not persisted: %+v", got)
	}
}

// TestAdminUserListCarriesSubscriptionAndSource verifies the admin user-list
// query surfaces subscription_status + plan_source per row, and that the
// rendered dashboard page reflects them.
func TestAdminUserListCarriesSubscriptionAndSource(t *testing.T) {
	ts, _, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	ctx := context.Background()
	_ = store.UpsertPlan(ctx, Plan{ID: "pro", Name: "Pro", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})
	u, _ := store.UpsertUserByEmail(ctx, "subrow@example.com", "")
	if err := store.SetUserSubscription(ctx, u.ID, "pro", "active", 0, "stripe", "", 1, 0); err != nil {
		t.Fatalf("SetUserSubscription: %v", err)
	}

	rows, _, err := store.AdminListUsers(ctx, AdminUserQuery{SortBy: "created", SortDir: "desc", Period: "202601", Now: 0, Limit: 50})
	if err != nil {
		t.Fatalf("AdminListUsers: %v", err)
	}
	var row *AdminUserRow
	for i := range rows {
		if rows[i].ID == u.ID {
			row = &rows[i]
		}
	}
	if row == nil {
		t.Fatal("target user not found in AdminListUsers rows")
	}
	if row.SubscriptionStatus != "active" || row.PlanSource != "stripe" {
		t.Fatalf("row subscription fields = %+v, want status=active source=stripe", row)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/admin/users", nil)
	req.AddCookie(admin)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "pro · stripe/active") {
		t.Fatalf("rendered dashboard missing subscription source; body head: %.2000s", body)
	}
}

// ---- route-level confirmation: provider-bound accounts ------------------------

// seedAuthorityBoundUser reproduces the production shape behind the 500: an
// account that PROJECTS free with no plan_source, yet already holds an Apple
// billing authority at epoch 1 and one purchase attempt still in 'dispatched'.
// That is precisely the state SetUserPlanAdmin must refuse — the attempt is
// still live at Apple, so a comp here could hide a channel that charges.
// Returns the user id, the authority and the dispatched attempt id.
func seedAuthorityBoundUser(t *testing.T, store *SQLiteStore, email string) (string, BillingAuthority, string) {
	t.Helper()
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, email, "")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	authority, err := store.AcquireBillingAuthority(ctx, BillingAuthorityRequest{
		UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS,
		AppleAccountToken: "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd", Now: 100,
	})
	if err != nil {
		t.Fatalf("AcquireBillingAuthority: %v", err)
	}
	if authority.Epoch != 1 {
		t.Fatalf("fixture epoch = %d, want 1", authority.Epoch)
	}
	attempt, created, err := store.PrepareBillingPurchase(ctx, authority, "com.relayium.app.max.monthly", 100)
	if err != nil || !created {
		t.Fatalf("PrepareBillingPurchase: created=%v err=%v", created, err)
	}
	if ok, err := store.MarkBillingPurchaseDispatched(ctx, u.ID, attempt.ID, authority.Epoch); !ok || err != nil {
		t.Fatalf("MarkBillingPurchaseDispatched: ok=%v err=%v", ok, err)
	}
	// The account must look free to the console, or this fixture would not
	// reproduce the reported case at all.
	got, _ := store.GetUserByID(ctx, u.ID)
	if got.PlanSource != "" {
		t.Fatalf("fixture plan_source = %q, want empty (projects free)", got.PlanSource)
	}
	return u.ID, authority, attempt.ID
}

// userPlanState reads back everything the refusal must leave untouched: the
// user's plan projection, the durable billing authority, and the state of the
// still-live purchase attempt.
func userPlanState(t *testing.T, store *SQLiteStore, userID, attemptID string) (plan, source string, authority BillingAuthority, attemptState string) {
	t.Helper()
	ctx := context.Background()
	u, err := store.GetUserByID(ctx, userID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	a, ok, err := store.BillingAuthority(ctx, userID)
	if err != nil {
		t.Fatalf("BillingAuthority: %v", err)
	}
	if !ok {
		t.Fatal("billing authority disappeared")
	}
	if attemptID != "" {
		if err := store.db.QueryRowContext(ctx,
			`SELECT state FROM billing_purchase_attempts WHERE id=?`, attemptID).Scan(&attemptState); err != nil {
			t.Fatalf("read attempt state: %v", err)
		}
	}
	return u.PlanID, u.PlanSource, a, attemptState
}

// seedAssignablePlan registers one ACTIVE plan the admin console may assign.
func seedAssignablePlan(t *testing.T, store *SQLiteStore, id string) {
	t.Helper()
	if err := store.UpsertPlan(context.Background(), Plan{
		ID: id, Name: strings.ToUpper(id), StorageBytes: 1, TrafficBytes: 1,
		RetentionSecs: 1, Active: true, UpdatedAt: 1,
	}); err != nil {
		t.Fatalf("UpsertPlan(%s): %v", id, err)
	}
}

// The production defect: assigning a provider-bound account to a plan through
// the real route — valid session, valid pending token, valid second factor —
// returned a bare 500 that read as "the admin console is broken". The refusal
// itself is correct and must stay; only its reporting was wrong. It must be a
// 409 that tells the operator why, and nothing about the account may move.
func TestConfirmedUserPlanOnProviderBoundAccountConflicts(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	seedAssignablePlan(t, store, "max")
	userID, wantAuthority, attemptID := seedAuthorityBoundUser(t, store, "authority-bound@example.test")
	beforePlan, beforeSource, _, beforeAttempt := userPlanState(t, store, userID, attemptID)

	resp := confirmAction(t, ts, cookie, "/admin/users/plan",
		url.Values{"user_id": {userID}, "plan_id": {"max"}})
	defer resp.Body.Close()
	body := readAll(t, resp)

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("provider-bound assignment = %d, want 409; body=%s", resp.StatusCode, body)
	}
	// The operator has to be able to act on this without reading server logs.
	for _, want := range []string{"App Store", "Stripe", "deletion"} {
		if !strings.Contains(body, want) {
			t.Fatalf("409 body lacks operator guidance %q; body=%s", want, body)
		}
	}
	// Guidance must stay non-secret: the bound App Store account token is a
	// user identifier and has no business in an error page.
	if strings.Contains(body, wantAuthority.AppleAccountToken) {
		t.Fatal("SECURITY: the 409 body leaked the bound App Store account token")
	}

	plan, source, authority, attemptState := userPlanState(t, store, userID, attemptID)
	if plan != beforePlan || source != beforeSource {
		t.Fatalf("plan projection moved: %q/%q, want %q/%q", plan, source, beforePlan, beforeSource)
	}
	if source == "admin" {
		t.Fatal("FINANCIAL: an admin comp landed on a provider-bound account")
	}
	if authority.Provider != wantAuthority.Provider || authority.Epoch != wantAuthority.Epoch ||
		authority.ExternalScope != wantAuthority.ExternalScope ||
		authority.AppleAccountToken != wantAuthority.AppleAccountToken {
		t.Fatalf("billing authority moved: %+v, want %+v", authority, wantAuthority)
	}
	if attemptState != beforeAttempt || attemptState != "dispatched" {
		t.Fatalf("purchase attempt state = %q, want unchanged %q", attemptState, beforeAttempt)
	}
}

// A refused write must not be logged as one, and must not buy the session a
// fresh step-up grace window. Both are the same rule HandleAdminConfirm applies
// to any >=400 handler result; 409 has to land on that side of it, not sneak
// past as an "applied" action.
func TestConflictedUserPlanIsNotAuditedOrGraced(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	seedAssignablePlan(t, store, "max")
	userID, _, _ := seedAuthorityBoundUser(t, store, "authority-audit@example.test")

	resp := confirmAction(t, ts, cookie, "/admin/users/plan",
		url.Values{"user_id": {userID}, "plan_id": {"max"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("want 409, got %d", resp.StatusCode)
	}

	entries, err := store.ListAudit(context.Background(), 10, 0, AuditUserPlan)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("AUDIT INTEGRITY: a refused plan change was logged as applied: %+v", entries)
	}
	if svc.stepUpFresh(context.Background(), cookie.Value) {
		t.Fatal("a refused plan change refreshed the step-up grace window")
	}
}

// The refusal must be narrow: an account with no provider authority still
// completes a confirmed admin assignment, recorded as plan_source='admin'.
// Without this, a 409 that over-fires would silently break every legitimate
// comp instead of only the unsafe one.
func TestConfirmedUserPlanStillAppliesWithoutProviderAuthority(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()
	seedAssignablePlan(t, store, "max")
	clean, err := store.UpsertUserByEmail(ctx, "authority-free@example.test", "")
	if err != nil {
		t.Fatal(err)
	}

	resp := confirmAction(t, ts, cookie, "/admin/users/plan",
		url.Values{"user_id": {clean.ID}, "plan_id": {"max"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("clean account assignment = %d, want 302; body=%s", resp.StatusCode, readAll(t, resp))
	}
	got, err := store.GetUserByID(ctx, clean.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PlanID != "max" || got.PlanSource != "admin" {
		t.Fatalf("plan/source = %q/%q, want max/admin", got.PlanID, got.PlanSource)
	}
	entries, err := store.ListAudit(ctx, 10, 0, AuditUserPlan)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 user.plan audit entry for the applied change, got %d", len(entries))
	}
}

// ---- the 409 must not become a way AROUND the confirmation gate ---------------

// A held session cookie is not enough. Even for a plan change that would be
// refused anyway, /admin/confirm must reject a missing second factor before it
// reaches the handler — the 401 must come from the factor check, not from the
// billing conflict, or a stolen cookie would learn the account's billing state.
func TestUserPlanConfirmWithoutFactorFailsClosed(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	seedAssignablePlan(t, store, "max")
	clean, err := store.UpsertUserByEmail(context.Background(), "no-factor@example.test", "")
	if err != nil {
		t.Fatal(err)
	}

	resp := postAdminForm(t, ts, cookie, "/admin/users/plan",
		url.Values{"user_id": {clean.ID}, "plan_id": {"max"}})
	body := readAll(t, resp)
	resp.Body.Close()
	tok := extractConfirmToken(t, body)

	// No factor_code at all.
	confirmResp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	defer confirmResp.Body.Close()
	if confirmResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("factor-less confirm = %d, want 401", confirmResp.StatusCode)
	}
	got, _ := store.GetUserByID(context.Background(), clean.ID)
	if got.PlanID == "max" || got.PlanSource == "admin" {
		t.Fatalf("SECURITY: a plan was assigned without factor verification: %q/%q", got.PlanID, got.PlanSource)
	}
}

// A pending plan change belongs to the session that minted it and is spendable
// once. Asserted on the plan route specifically because that is the route whose
// error mapping changed.
func TestUserPlanConfirmTokenIsSessionBoundAndSingleUse(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	sessionA := adminLoginCookie(t, ts)
	sessionB := adminLoginCookie(t, ts)
	if sessionA.Value == sessionB.Value {
		t.Fatal("the two logins share a session token; this test proves nothing")
	}
	seedAssignablePlan(t, store, "max")
	clean, err := store.UpsertUserByEmail(context.Background(), "token-bound@example.test", "")
	if err != nil {
		t.Fatal(err)
	}

	resp := postAdminForm(t, ts, sessionA, "/admin/users/plan",
		url.Values{"user_id": {clean.ID}, "plan_id": {"max"}})
	body := readAll(t, resp)
	resp.Body.Close()
	tok := extractConfirmToken(t, body)

	foreign := postAdminForm(t, ts, sessionB, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	foreign.Body.Close()
	if foreign.StatusCode == http.StatusFound {
		t.Fatal("SECURITY: a pending plan change was redeemed by a different session")
	}
	// The failed attempt burned the token: the minting session gets no retry.
	replay := postAdminForm(t, ts, sessionA, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	replay.Body.Close()
	if replay.StatusCode == http.StatusFound {
		t.Fatal("SECURITY: a pending plan token survived a foreign redemption attempt")
	}
	got, _ := store.GetUserByID(context.Background(), clean.ID)
	if got.PlanID == "max" || got.PlanSource == "admin" {
		t.Fatalf("SECURITY: a foreign/replayed token assigned a plan: %q/%q", got.PlanID, got.PlanSource)
	}
}

// An inactive plan is still a 400, not the new 409: the conflict mapping must
// not swallow the pre-existing validation refusals in front of it.
func TestConfirmedUserPlanInactivePlanStillRejects(t *testing.T) {
	ts, _, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := context.Background()
	if err := store.UpsertPlan(ctx, Plan{ID: "retired", Name: "Retired", StorageBytes: 1,
		TrafficBytes: 1, RetentionSecs: 1, Active: false, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	// Bound to a provider AND asking for an inactive plan: the plan check runs
	// first, so this must still be the 400, never the 409.
	userID, _, _ := seedAuthorityBoundUser(t, store, "inactive-plan@example.test")

	resp := confirmAction(t, ts, cookie, "/admin/users/plan",
		url.Values{"user_id": {userID}, "plan_id": {"retired"}})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("inactive plan = %d, want 400", resp.StatusCode)
	}
	got, _ := store.GetUserByID(ctx, userID)
	if got.PlanID == "retired" {
		t.Fatal("an inactive plan was assigned")
	}
}
