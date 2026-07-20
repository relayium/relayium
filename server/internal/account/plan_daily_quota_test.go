package account

import (
	"bytes"
	"context"
	"net/http"
	"net/url"
	"testing"
)

// TestDailyQuotaForUsesPlanValue: a tier that carries its own daily quota wins
// over the global SettingDailyQuota.
func TestDailyQuotaForUsesPlanValue(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	if err := st.SetSetting(ctx, SettingDailyQuota, 200<<20, svc.now().Unix()); err != nil {
		t.Fatal(err)
	}
	u, _ := st.UpsertUserByEmail(ctx, "pq@example.com", "")
	_ = st.UpsertPlan(ctx, Plan{ID: "plus", Name: "Plus", StorageBytes: 5 << 30, TrafficBytes: 300 << 30,
		RetentionSecs: 30 * 86400, DailyQuotaBytes: 100 << 30, Active: true, UpdatedAt: svc.now().Unix()})
	_ = st.SetUserPlan(ctx, u.ID, "plus", svc.now().Unix())

	got, err := svc.dailyQuotaFor(ctx, u.ID)
	if err != nil {
		t.Fatalf("dailyQuotaFor: %v", err)
	}
	if got != 100<<30 {
		t.Fatalf("dailyQuotaFor = %d, want the plan's %d", got, int64(100)<<30)
	}
}

// TestDailyQuotaForFallsBackToGlobal: DailyQuotaBytes <= 0 (every pre-migration
// plans row) keeps today's behaviour — the global setting.
func TestDailyQuotaForFallsBackToGlobal(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	if err := st.SetSetting(ctx, SettingDailyQuota, 200<<20, svc.now().Unix()); err != nil {
		t.Fatal(err)
	}
	u, _ := st.UpsertUserByEmail(ctx, "pq0@example.com", "")
	_ = st.UpsertPlan(ctx, Plan{ID: "legacy", Name: "Legacy", StorageBytes: 1 << 30, TrafficBytes: 1 << 30,
		RetentionSecs: 86400, DailyQuotaBytes: 0, Active: true, UpdatedAt: svc.now().Unix()})
	_ = st.SetUserPlan(ctx, u.ID, "legacy", svc.now().Unix())

	got, err := svc.dailyQuotaFor(ctx, u.ID)
	if err != nil {
		t.Fatalf("dailyQuotaFor: %v", err)
	}
	if got != 200<<20 {
		t.Fatalf("dailyQuotaFor = %d, want the global %d", got, int64(200)<<20)
	}
}

// TestPlanDailyQuotaRoundTrip pins the schema/column-list/scan/write plumbing:
// a value written through UpsertPlan must read back through both GetPlan and
// ListPlans. Dropping daily_quota_bytes from any one of those places makes this
// fail.
func TestPlanDailyQuotaRoundTrip(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	want := int64(1700) << 30
	if err := st.UpsertPlan(ctx, Plan{ID: "max", Name: "Max", StorageBytes: 250 << 30, TrafficBytes: 5 << 40,
		RetentionSecs: 180 * 86400, DailyQuotaBytes: want, Active: true, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.GetPlan(ctx, "max")
	if err != nil || !ok {
		t.Fatalf("GetPlan: %v ok=%v", err, ok)
	}
	if got.DailyQuotaBytes != want {
		t.Fatalf("GetPlan DailyQuotaBytes = %d, want %d", got.DailyQuotaBytes, want)
	}
	plans, err := st.ListPlans(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var seen bool
	for _, p := range plans {
		if p.ID == "max" {
			seen = true
			if p.DailyQuotaBytes != want {
				t.Fatalf("ListPlans DailyQuotaBytes = %d, want %d", p.DailyQuotaBytes, want)
			}
		}
	}
	if !seen {
		t.Fatal("ListPlans did not return the max plan")
	}

	// An update must persist the new value too (the ON CONFLICT branch).
	if err := st.UpsertPlan(ctx, Plan{ID: "max", Name: "Max", StorageBytes: 250 << 30, TrafficBytes: 5 << 40,
		RetentionSecs: 180 * 86400, DailyQuotaBytes: 42, Active: true, UpdatedAt: 2}); err != nil {
		t.Fatal(err)
	}
	got, _, _ = st.GetPlan(ctx, "max")
	if got.DailyQuotaBytes != 42 {
		t.Fatalf("after update DailyQuotaBytes = %d, want 42", got.DailyQuotaBytes)
	}
}

// TestSeededPlansCarryDailyQuota: the factory tiers ship with per-plan quotas,
// free deliberately keeping today's 200 MiB.
func TestSeededPlansCarryDailyQuota(t *testing.T) {
	want := map[string]int64{
		// Free is 0 ON PURPOSE: it inherits the global daily quota so the admin
		// knob keeps working for free users. See defaultPlans() and
		// TestFreePlanFollowsGlobalDailyQuota.
		"free": 0,
		"plus": 7 << 30,
		"pro":  34 << 30,
		"max":  267 << 30,
	}
	for _, p := range defaultPlans() {
		if w, ok := want[p.ID]; ok && p.DailyQuotaBytes != w {
			t.Fatalf("defaultPlans()[%s].DailyQuotaBytes = %d, want %d", p.ID, p.DailyQuotaBytes, w)
		}
		delete(want, p.ID)
	}
	if len(want) != 0 {
		t.Fatalf("defaultPlans() missing tiers: %v", want)
	}
}

// TestFreePlanFollowsGlobalDailyQuota guards the deliberate 0 in defaultPlans()
// for the Free tier: a free user's daily quota must TRACK the global
// "每账号每日额度" setting, not be pinned to whatever the seed happened to say.
// Unlike the fallback-path tests, this one assigns a genuinely seeded free plan
// row, so it fails even if freePlanFallback() were to normalize the field away.
// Pinning free's seed to a literal (e.g. 200 MiB) makes this fail — which is the
// point: that would quietly take free users out from under the admin knob.
func TestFreePlanFollowsGlobalDailyQuota(t *testing.T) {
	svc, st := newPlanService(t) // SeedPlans() ran, so a real "free" row exists
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "freeglobal@example.com", "")
	_ = st.SetUserPlan(ctx, u.ID, "free", svc.now().Unix())

	// Confirm the fixture really is a stored row, not the in-memory fallback.
	if p, ok, err := st.GetPlan(ctx, "free"); err != nil || !ok {
		t.Fatalf("test invariant broken: free plan row must exist (ok=%v err=%v)", ok, err)
	} else if p.DailyQuotaBytes != 0 {
		t.Fatalf("seeded free plan DailyQuotaBytes = %d, want 0 so it inherits the global setting", p.DailyQuotaBytes)
	}

	// Move the global knob twice; the free user must follow it both times.
	for _, want := range []int64{7 << 20, 512 << 20} {
		if err := st.SetSetting(ctx, SettingDailyQuota, want, svc.now().Unix()); err != nil {
			t.Fatal(err)
		}
		got, err := svc.dailyQuotaFor(ctx, u.ID)
		if err != nil {
			t.Fatalf("dailyQuotaFor: %v", err)
		}
		if got != want {
			t.Fatalf("free user's daily quota = %d, want %d (it must track the global setting, not a pinned seed)", got, want)
		}
	}
}

// TestPaidPlanUploadBeatsGlobalDailyQuota is the reason this feature exists: a
// paid user must be able to upload a file bigger than the *global* daily quota,
// because their tier carries a much larger one. Scaled down by 1024x from the
// production numbers (global 200 MiB / file 300 MiB) so the test body stays in
// memory: global quota 200 KiB, upload 300 KiB, plus tier 100 MiB/day.
func TestPaidPlanUploadBeatsGlobalDailyQuota(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 200<<10 /*global daily quota*/, 1<<20 /*max file size*/)
	cookie := loginCookie(t, ts, mail, "paid@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "paid@example.com", "")
	ctx := context.Background()
	_ = store.UpsertPlan(ctx, Plan{ID: "plus", Name: "Plus", StorageBytes: 5 << 30, TrafficBytes: 300 << 30,
		RetentionSecs: 30 * 86400, DailyQuotaBytes: 100 << 20, Active: true, UpdatedAt: 1})
	_ = store.SetUserPlan(ctx, u.ID, "plus", 1)

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 300<<10)))
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("paid-plan 300 KiB upload = %d, want 200 (the plan's own daily quota must win over the 200 KiB global one)", resp.StatusCode)
	}
}

// TestFreePlanUploadStillHitsGlobalDailyQuota is the control for the test
// above: with DailyQuotaBytes = 0 the global quota still applies, so the
// migration is a no-op for existing rows.
func TestFreePlanUploadStillHitsGlobalDailyQuota(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 200<<10, 1<<20)
	cookie := loginCookie(t, ts, mail, "freeq@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "freeq@example.com", "")
	ctx := context.Background()
	_ = store.UpsertPlan(ctx, Plan{ID: "legacy", Name: "Legacy", StorageBytes: 5 << 30, TrafficBytes: 300 << 30,
		RetentionSecs: 30 * 86400, DailyQuotaBytes: 0, Active: true, UpdatedAt: 1})
	_ = store.SetUserPlan(ctx, u.ID, "legacy", 1)

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 300<<10)))
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("unconfigured-plan 300 KiB upload = %d, want 429 (global 200 KiB quota still applies)", resp.StatusCode)
	}
}

// postPlanForm calls handleAdminUpsertPlan directly and returns the status
// code. It used to POST through the real /admin/plans route, but that route
// now sits behind requireStepUp (Task 7), which renders a confirmation page
// instead of applying anything — these tests target
// handleAdminUpsertPlan's own persistence logic, which is unchanged; the
// route's step-up gating is covered separately by stepup_test.go.
func postPlanForm(t *testing.T, svc *Service, admin *http.Cookie, form url.Values) int {
	t.Helper()
	return callAdminHandler(svc.handleAdminUpsertPlan, admin, form, nil).Code
}

// TestAdminUpsertPlanAcceptsDailyQuota: the admin editor round-trips the new
// column.
func TestAdminUpsertPlanAcceptsDailyQuota(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})

	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"200"}, "traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"daily_quota_mb": {"500"},
		"sort_order":     {"0"}, "active": {"1"},
	}
	if code := postPlanForm(t, svc, admin, form); code != http.StatusFound {
		t.Fatalf("upsert plan = %d, want 302", code)
	}
	got, _, _ := store.GetPlan(context.Background(), "free")
	if got.DailyQuotaBytes != 500<<20 {
		t.Fatalf("DailyQuotaBytes = %d, want %d", got.DailyQuotaBytes, int64(500)<<20)
	}
}

// TestAdminUpsertPlanAcceptsZeroDailyQuota: 0 is a *meaningful* value here — it
// means "use the global setting" — so the form must accept it and store it,
// not reject it as invalid. A previous field on this branch regressed exactly
// this way (a >0 parser swapped in) with every test still green, so this case
// exists to catch that swap.
func TestAdminUpsertPlanAcceptsZeroDailyQuota(t *testing.T) {
	ts, svc, store := newAdminSettingsServer(t)
	admin := adminLogin(t, ts)
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1, TrafficBytes: 1,
		RetentionSecs: 1, DailyQuotaBytes: 999 << 20, Active: true, UpdatedAt: 1})

	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"200"}, "traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"daily_quota_mb": {"0"},
		"sort_order":     {"0"}, "active": {"1"},
	}
	if code := postPlanForm(t, svc, admin, form); code != http.StatusFound {
		t.Fatalf("daily_quota_mb=0 rejected with %d, want 302 — 0 means \"fall back to the global setting\"", code)
	}
	got, _, _ := store.GetPlan(context.Background(), "free")
	if got.DailyQuotaBytes != 0 {
		t.Fatalf("DailyQuotaBytes = %d, want 0 (the submitted zero must be stored, not ignored)", got.DailyQuotaBytes)
	}
}
