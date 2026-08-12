package account

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"strings"
)

// beforeImageFor 返回某个高危动作的前后镜像，供确认页展示 diff、供审计记录变更。
//
// 两个镜像都用**存储层原始值**（bytes / secs）。表单提交的是 MB/GB/天，
// 若在这里混用单位，确认页说"改成 1"而库里写的是 1073741824，对不上。
//
// 关键约束：这里的转换必须复用 handleAdminSettings / handleAdminUpsertPlan
// 写库时实际用的那份解析（parseSettingsForm / parsePlanForm）。绝不能另写
// 一份平行解析——两份迟早漂移，确认页显示的就不再是即将写入的值。
// pathID 是原始请求的 {id} 路径通配符（表单里没有的那半个身份）。RequireStepUp
// 从 r.PathValue("id") 拿，HandleAdminConfirm 从 pendingAction 里拿——两边必须
// 传同一个值，否则确认页显示的目标和真正执行的目标就会不是一回事。
func (s *Service) beforeImageFor(ctx context.Context, action, pathID string, form url.Values) (before, after map[string]any, target string, err error) {
	switch action {
	case AuditSettings:
		cur := s.ResolveSettings(ctx)
		return settingsImage(cur), parseSettingsForm(form), "-", nil

	case AuditPlanUpsert:
		id := form.Get("id")
		before = map[string]any{}
		if p, ok, err := s.store.GetPlan(ctx, id); err != nil {
			return nil, nil, "", err
		} else if ok {
			before = planImage(p)
		}
		p, err := parsePlanForm(form)
		if err != nil {
			return nil, nil, "", err
		}
		return before, planImage(p), "plan:" + id, nil

	// These actions have no field-level "before" to diff, but the audit MUST still
	// name WHAT was touched (target) and the operative value — a bare "user.plan"
	// with target "-" can't tell you which user was moved to which plan, and a
	// "passkey.delete" with no target defeats the very forensics that feature
	// exists for. The id lives in the reconstructed form of the original request.
	case AuditUserPlan:
		return map[string]any{}, map[string]any{"plan": form.Get("plan_id")},
			"user:" + form.Get("user_id"), nil

	case AuditTokenMint:
		return map[string]any{}, map[string]any{"name": form.Get("name")},
			"token:" + form.Get("name"), nil

	// The confirmation page for an emergency release must state the three
	// things that make it different from a normal target change: the version it
	// would push, that it bypasses the staged ladder, and WHICH TRACK it hits.
	//
	// The track is the single most consequential fact of the three — "fleet"
	// means our own machines, "byo" means every user's machine — and it used to
	// be the one thing the page never said: the track lives in the path
	// wildcard, this returned target "-", and the template only renders a
	// target when it is not "-". The operator confirmed
	// "rollout.emergency / v2.0.0 / emergency: true" with no idea whose
	// machines were about to be swapped. (The inline onsubmit="confirm(...)" in
	// the panel that does name the track never runs — buildCSP emits
	// script-src 'self' 'nonce-…' with no 'unsafe-inline'/'unsafe-hashes', so
	// inline handlers are blocked. Treat it as dead; it cannot be the 二次确认.)
	//
	// So name it here, twice over: as the audit/page target, and as a diff row
	// the operator has to read past.
	case AuditRolloutEmergency:
		return map[string]any{}, map[string]any{
				"track":          pathID,
				"target_version": form.Get("version"),
				"emergency":      true,
			},
			rolloutAuditTarget(pathID), nil

	// The manual fast push's page must state the same three things, with the
	// third one different: the version, WHICH TRACK (always fleet — the route
	// has no other), and that what is being skipped is the WAITING rather than
	// the staging. "mode" is spelled out as a diff row rather than left to the
	// banner alone, because the banner is prose an operator can skim and the
	// diff table is the part they have to read past.
	case AuditRolloutFast:
		return map[string]any{}, map[string]any{
				"track":          "fleet",
				"target_version": form.Get("version"),
				"mode":           "manual-fast (one node at a time, no canary/soak wait)",
			},
			rolloutAuditTarget("fleet"), nil

	// The safe fast push's page and audit row must differ from the one above in
	// the only place the two actions differ: what happens to the canary. "mode"
	// spells out that the six-hour window is KEPT, because an operator who has
	// used the other control reads this diff table with that one in mind, and a
	// row that merely said "fast" would be read as the mode they already know.
	case AuditRolloutFastCanary:
		return map[string]any{}, map[string]any{
				"track":          "fleet",
				"target_version": form.Get("version"),
				"mode":           "canary-then-fast (canary keeps its full 6h observation window; only later nodes skip the soak)",
			},
			rolloutAuditTarget("fleet"), nil

	case AuditPasskeyDelete:
		return map[string]any{}, map[string]any{}, "passkey:" + form.Get("id"), nil

	// Node delete has its id in the path wildcard, not the form; HandleAdminConfirm
	// fills its target from the stashed pathID after this returns.
	default:
		return map[string]any{}, map[string]any{}, "-", nil
	}
}

// settingsImage / planImage 把结构体摊平成字段名 -> 存储层值。
// 字段名直接用数据库列名/设置键名，这样审计日志里的 field 能直接对到库里。
func planImage(p Plan) map[string]any {
	return map[string]any{
		"name":                    p.Name,
		"storage_bytes":           p.StorageBytes,
		"traffic_bytes":           p.TrafficBytes,
		"retention_secs":          p.RetentionSecs,
		"price_monthly":           p.PriceMonthly,
		"price_yearly":            p.PriceYearly,
		"sort_order":              p.SortOrder,
		"active":                  p.Active,
		"daily_quota_bytes":       p.DailyQuotaBytes,
		"stripe_price_monthly_id": p.StripePriceMonthlyID,
		"stripe_price_yearly_id":  p.StripePriceYearlyID,
	}
}

func settingsImage(s Settings) map[string]any {
	return map[string]any{
		SettingMaxFileSize:            s.MaxFileSize,
		SettingDailyQuota:             s.DailyQuota,
		SettingDefaultTTL:             s.DefaultTTL,
		SettingMaxTTL:                 s.MaxTTL,
		SettingDefaultRetention:       s.DefaultRetention,
		SettingDefaultMaxDownloads:    s.DefaultMaxDownloads,
		SettingMaxMaxDownloads:        s.MaxMaxDownloads,
		SettingStorageDiskCap:         s.StorageDiskCap,
		SettingDisableCentralFallback: s.DisableCentralFallback,
		SettingNodeTrafficDefault:     s.NodeTrafficDefault,
	}
}

// parseSettingsForm converts a settings-edit form (MB/GB/hours, as the admin
// UI submits and as settingsFormFrom in the test file renders back) into the
// storage-layer values (bytes/seconds) that get written to the settings
// table, keyed by the Setting* constants used everywhere else.
//
// This is the SAME arithmetic (mb*1024*1024, hours*3600, ...) that used to
// live inline in handleAdminSettings' `updates` slice — moved here so there
// is exactly one place that turns form units into storage units.
// handleAdminSettings calls this AFTER validating the raw form (bounds,
// default<=max, etc. — validation stays in the handler since it needs to
// produce a specific 400 message); beforeImageFor calls it directly to
// compute the after-image for the confirmation-page diff and audit log.
// Malformed numeric strings parse as 0 (ParseInt's zero value on error);
// callers that need to reject bad input validate the raw form first.
func parseSettingsForm(form url.Values) map[string]any {
	atoi := func(k string) int64 {
		n, _ := strconv.ParseInt(strings.TrimSpace(form.Get(k)), 10, 64)
		return n
	}
	// Unchecked checkboxes submit no value; present (any value) = on.
	disableCentral := strings.TrimSpace(form.Get("disable_central_fallback")) != ""
	return map[string]any{
		SettingMaxFileSize:            atoi("max_file_size_mb") * 1024 * 1024,
		SettingDailyQuota:             atoi("daily_quota_mb") * 1024 * 1024,
		SettingDefaultTTL:             atoi("default_ttl_hours") * 3600,
		SettingMaxTTL:                 atoi("max_ttl_hours") * 3600,
		SettingDefaultRetention:       atoi("default_retention"),
		SettingDefaultMaxDownloads:    atoi("default_max_downloads"),
		SettingMaxMaxDownloads:        atoi("max_max_downloads"),
		SettingStorageDiskCap:         atoi("storage_disk_cap_mb") * 1024 * 1024,
		SettingDisableCentralFallback: disableCentral,
		SettingNodeTrafficDefault:     atoi("node_traffic_default_gb") * 1024 * 1024 * 1024,
	}
}

// parsePlanForm parses and validates a plan-edit form into the Plan values
// that would be written (bytes/seconds, not the form's MB/GB/days). Shared
// by handleAdminUpsertPlan (which then does the "stay active" store check
// with the real ctx/store, and stamps UpdatedAt) and beforeImageFor (which
// needs the same after-image for the confirmation-page diff/audit, without
// writing anything). This is the exact validation/conversion that used to
// live inline in handleAdminUpsertPlan.
func parsePlanForm(form url.Values) (Plan, error) {
	id := strings.TrimSpace(form.Get("id"))
	name := strings.TrimSpace(form.Get("name"))
	nn := func(k string) (int64, bool) { // non-negative int
		n, err := strconv.ParseInt(strings.TrimSpace(form.Get(k)), 10, 64)
		return n, err == nil && n >= 0
	}
	// nnMax additionally rejects values above maxVal, so storage_mb/traffic_gb
	// can't overflow int64 once shifted (<<20/<<30) into bytes and wrap
	// negative, which would silently read back as an unlimited (<=0) cap.
	nnMax := func(k string, maxVal int64) (int64, bool) {
		n, ok := nn(k)
		return n, ok && n <= maxVal
	}
	storageMB, ok1 := nnMax("storage_mb", maxConfigMB)
	trafficGB, ok2 := nnMax("traffic_gb", maxConfigMB)
	retDays, ok3 := nnMax("retention_days", maxRetentionDays)
	pm, ok4 := nn("price_monthly_cents")
	py, ok5 := nn("price_yearly_cents")
	sort, ok6 := nn("sort_order")
	// daily_quota_mb: 0 是有意义的取值（= 回落到全局「每账号每日额度」设置），
	// 所以这里必须用 nnMax/nn 这类接受 0 的解析，绝不能换成要求 > 0 的那种。
	dailyQuotaMB, ok7 := nnMax("daily_quota_mb", maxConfigMB)
	active := form.Get("active") == "1"
	// Stripe price ids are free-form strings (e.g. "price_1AbCDe...") assigned
	// by the operator after creating Prices in the Stripe dashboard — no
	// numeric validation, just trim.
	stripePriceMonthlyID := strings.TrimSpace(form.Get("stripe_price_monthly_id"))
	stripePriceYearlyID := strings.TrimSpace(form.Get("stripe_price_yearly_id"))
	if id == "" || name == "" || !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7) {
		return Plan{}, errors.New("invalid plan (non-negative integers; id/name required; " +
			"storage_mb/traffic_gb/daily_quota_mb <= 1073741824; retention_days <= 36500)")
	}
	return Plan{
		ID: id, Name: name,
		StorageBytes: storageMB << 20, TrafficBytes: trafficGB << 30,
		RetentionSecs: retDays * 86400, PriceMonthly: pm, PriceYearly: py,
		SortOrder: sort, Active: active,
		StripePriceMonthlyID: stripePriceMonthlyID,
		StripePriceYearlyID:  stripePriceYearlyID,
		DailyQuotaBytes:      dailyQuotaMB << 20,
	}, nil
}
