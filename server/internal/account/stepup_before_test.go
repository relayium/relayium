package account

import (
	"context"
	"net/url"
	"strconv"
	"testing"
)

// settingsFormFrom 把当前设置渲染回表单字段（MB/GB/小时），模拟管理员打开
// 设置页时浏览器里已填好的那些值。
//
// 字段名核对自 handleAdminSettings 实际读取的 r.FormValue(...) 调用
// （grep -n 'r.FormValue' internal/account/admin.go，settings 段）：
// max_file_size_mb / daily_quota_mb / default_ttl_hours / max_ttl_hours /
// default_retention / default_max_downloads / max_max_downloads /
// storage_disk_cap_mb / disable_central_fallback / node_traffic_default_gb.
// (disable_central_fallback is a checkbox: omitted = off, matching the
// SeedSettings default of false, so it's left unset here.)
func settingsFormFrom(s Settings) url.Values {
	return url.Values{
		"max_file_size_mb":        {itoa64(s.MaxFileSize / (1024 * 1024))},
		"daily_quota_mb":          {itoa64(s.DailyQuota / (1024 * 1024))},
		"default_ttl_hours":       {itoa64(s.DefaultTTL / 3600)},
		"max_ttl_hours":           {itoa64(s.MaxTTL / 3600)},
		"default_retention":       {itoa64(s.DefaultRetention)},
		"default_max_downloads":   {itoa64(s.DefaultMaxDownloads)},
		"max_max_downloads":       {itoa64(s.MaxMaxDownloads)},
		"storage_disk_cap_mb":     {itoa64(s.StorageDiskCap / (1024 * 1024))},
		"node_traffic_default_gb": {itoa64(s.NodeTrafficDefault / (1024 * 1024 * 1024))},
	}
}

func itoa64(v int64) string { return strconv.FormatInt(v, 10) }

// 设置表单每次提交全部字段，只改一项时 diff 必须只有一行。
func TestBeforeImageSettingsDiffsOnlyChanged(t *testing.T) {
	_, svc, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	if err := svc.SeedSettings(ctx); err != nil {
		t.Fatal(err)
	}
	cur := svc.resolveSettings(ctx)
	form := settingsFormFrom(cur)
	form.Set("daily_quota_mb", "400") // 只动这一项
	before, after, target, err := svc.beforeImageFor(ctx, AuditSettings, form)
	if err != nil {
		t.Fatal(err)
	}
	if target != "-" {
		t.Fatalf("settings target should be '-', got %q", target)
	}
	changes := diffFields(before, after)
	if len(changes) != 1 || changes[0].Field != SettingDailyQuota {
		t.Fatalf("want exactly the daily-quota change, got %+v", changes)
	}
	// 存储层原始值：400 MB = 419430400 字节，不是 400。
	if changes[0].New != int64(419430400) {
		t.Fatalf("want the byte value 419430400, got %v", changes[0].New)
	}
	_ = store
}

func TestBeforeImagePlanCapturesPriorRow(t *testing.T) {
	_, svc, store, _ := newAdminAuditServer(t)
	ctx := context.Background()
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true,
		StorageBytes: 5 << 30, TrafficBytes: 300 << 30, RetentionSecs: 30 * 86400,
		PriceMonthly: 390, PriceYearly: 2900})
	form := url.Values{
		"id": {"plus"}, "name": {"Plus"}, "storage_mb": {"1024"},
		"traffic_gb": {"20"}, "retention_days": {"3"},
		"price_monthly_cents": {"199"}, "price_yearly_cents": {"1999"},
		"sort_order": {"1"}, "active": {"1"}, "daily_quota_mb": {"7168"},
	}
	before, after, target, err := svc.beforeImageFor(ctx, AuditPlanUpsert, form)
	if err != nil {
		t.Fatal(err)
	}
	if target != "plan:plus" {
		t.Fatalf("want target plan:plus, got %q", target)
	}
	if before["storage_bytes"] != int64(5<<30) {
		t.Fatalf("before image missing the prior storage: %v", before["storage_bytes"])
	}
	if after["storage_bytes"] != int64(1<<30) {
		t.Fatalf("after image should be 1 GiB in bytes, got %v", after["storage_bytes"])
	}
}

// 新建套餐（库里没有该 id）时 before 为空 map，不能是 nil —— diffFields 会
// 把所有字段记为 old=nil，这正是"新建"应有的语义。
func TestBeforeImagePlanNewIsEmptyNotNil(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	form := url.Values{
		"id": {"brand-new"}, "name": {"New"}, "storage_mb": {"100"},
		"traffic_gb": {"1"}, "retention_days": {"1"}, "price_monthly_cents": {"0"},
		"price_yearly_cents": {"0"}, "sort_order": {"9"}, "daily_quota_mb": {"0"},
	}
	before, _, _, err := svc.beforeImageFor(context.Background(), AuditPlanUpsert, form)
	if err != nil {
		t.Fatal(err)
	}
	if before == nil {
		t.Fatal("before must be an empty map, never nil")
	}
	if len(before) != 0 {
		t.Fatalf("a brand-new plan has no before image, got %+v", before)
	}
}

// The field-less high-risk actions must still NAME their target in the audit —
// previously all three logged target="-", which can't tell you which user was
// re-planned, which token was minted, or which passkey was deleted.
func TestBeforeImageNamesTargetForFieldlessActions(t *testing.T) {
	_, svc, _, _ := newAdminAuditServer(t)
	ctx := context.Background()
	cases := []struct {
		action, wantTarget string
		form               url.Values
	}{
		{AuditUserPlan, "user:u9", url.Values{"user_id": {"u9"}, "plan_id": {"max"}}},
		{AuditTokenMint, "token:fleet-a", url.Values{"name": {"fleet-a"}}},
		{AuditPasskeyDelete, "passkey:pk3", url.Values{"id": {"pk3"}}},
	}
	for _, c := range cases {
		_, _, target, err := svc.beforeImageFor(ctx, c.action, c.form)
		if err != nil {
			t.Fatalf("%s: %v", c.action, err)
		}
		if target != c.wantTarget {
			t.Fatalf("%s: target=%q, want %q", c.action, target, c.wantTarget)
		}
	}
}
