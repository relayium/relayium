package account

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestAdminUpsertPlanUpdatesValues(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})

	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"200"}, "traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"sort_order": {"0"}, "active": {"1"},
	}
	req, _ := http.NewRequest("POST", ts.URL+"/admin/plans", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://example.test")
	req.AddCookie(admin)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("upsert plan = %d, want 302", resp.StatusCode)
	}
	got, _, _ := store.GetPlan(context.Background(), "free")
	if got.StorageBytes != 200<<20 || got.TrafficBytes != 5<<30 || got.RetentionSecs != 7*86400 {
		t.Fatalf("plan not updated: %+v", got)
	}
}

func TestAdminUpsertPlanRefusesDeactivatingLastActivePlan(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})

	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"200"}, "traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"sort_order": {"0"}, // active omitted => false
	}
	req, _ := http.NewRequest("POST", ts.URL+"/admin/plans", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://example.test")
	req.AddCookie(admin)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("deactivate last active plan = %d, want 400", resp.StatusCode)
	}
	got, _, _ := store.GetPlan(context.Background(), "free")
	if !got.Active {
		t.Fatalf("plan should remain active: %+v", got)
	}
}

func TestAdminUpsertPlanRejectsOverflowingSize(t *testing.T) {
	ts, _ := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"999999999999999999"}, // *<<20 overflows int64
		"traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"sort_order": {"0"}, "active": {"1"},
	}
	req, _ := http.NewRequest("POST", ts.URL+"/admin/plans", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "http://example.test") // csrfGuard
	req.AddCookie(admin)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("overflowing storage_mb = %d, want 400", resp.StatusCode)
	}
}

func TestAdminAssignUserPlanActiveOnly(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	ctx := context.Background()
	_ = store.UpsertPlan(ctx, Plan{ID: "pro", Name: "Pro", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})
	_ = store.UpsertPlan(ctx, Plan{ID: "old", Name: "Old", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: false, UpdatedAt: 1})
	target, _ := store.UpsertUserByEmail(ctx, "target@example.com", "")

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	post := func(plan string) int {
		form := url.Values{"user_id": {target.ID}, "plan_id": {plan}}
		req, _ := http.NewRequest("POST", ts.URL+"/admin/users/plan", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.AddCookie(admin)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if post("pro") != http.StatusFound {
		t.Fatal("assigning an active plan should 302")
	}
	if got, _ := store.GetUserByID(ctx, target.ID); got.PlanID != "pro" {
		t.Fatalf("plan = %q, want pro", got.PlanID)
	}
	if post("old") != http.StatusBadRequest {
		t.Fatal("assigning an inactive plan must 400")
	}
}
