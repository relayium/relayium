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
// behind requireStepUp (Task 7), which renders a confirmation page instead
// of applying anything. These tests target the handlers' own
// validation/persistence logic, which is unchanged; the routes' step-up
// gating is covered separately by stepup_test.go.
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
	if err := store.SetUserSubscription(ctx, u.ID, "pro", "active", 0, "stripe", "", 1); err != nil {
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

	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
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
