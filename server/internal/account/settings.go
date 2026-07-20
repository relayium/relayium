package account

import "context"

// Setting keys for the admin-editable stored-transfer limits.
const (
	SettingMaxFileSize = "max_file_size"
	SettingDailyQuota  = "daily_quota"
	SettingDefaultTTL  = "default_ttl"
	SettingMaxTTL      = "max_ttl"
	// SettingDefaultRetention picks the admin's default retention policy applied
	// when an upload request specifies none of burnAfterRead/ttl/maxDownloads:
	// 0=burn (retentionBurn), 1=ttl (retentionTTL), 2=count (retentionCount).
	SettingDefaultRetention    = "default_retention"
	SettingDefaultMaxDownloads = "default_max_downloads"
	SettingMaxMaxDownloads     = "max_max_downloads"
	// SettingAccountGraceDays is the grace period (days) between a self-deletion
	// request and GC's hard purge; SettingAccountReminderDays is how many days
	// before purge the one-time reminder email is sent.
	SettingAccountGraceDays    = "account_grace_days"
	SettingAccountReminderDays = "account_purge_reminder_days"
	// SettingStorageDiskCap is the global logical storage ceiling: the sum of
	// live staged-file sizes may not exceed it (oversubscription backstop,
	// distinct from the physical blob-volume cap). Bytes.
	SettingStorageDiskCap = "storage_disk_cap"
	// SettingDisableCentralFallback, when set (1), stops uploads from falling
	// back to the app server's own local disk: a transfer with no available
	// storage node fails instead of landing on central. 0 = allow central
	// fallback (the default, current behaviour).
	SettingDisableCentralFallback = "disable_central_fallback"
	// SettingNodeTrafficDefault 是官方节点每月中继流量的**默认**上限（字节）。
	// 节点自己的 traffic_limit_bytes 为 0 时继承它；节点有值则以节点为准。
	// 本身为 0 表示"未单独配置的节点不限流量"，保留整体关掉这套机制的能力。
	SettingNodeTrafficDefault = "node_traffic_default"
)

// minTTL is the floor a requested TTL is clamped up to; well below default_ttl.
const minTTL int64 = 60

// Retention policy enum values for SettingDefaultRetention / Settings.DefaultRetention.
const (
	retentionBurn  = 0
	retentionTTL   = 1
	retentionCount = 2
)

// Settings is the resolved live view of the limits for one request.
type Settings struct {
	MaxFileSize int64
	DailyQuota  int64
	DefaultTTL  int64
	MaxTTL      int64
	// DefaultRetention is the admin's default policy (retentionBurn/TTL/Count)
	// applied when an upload requests none of burn/ttl/maxDownloads explicitly.
	DefaultRetention int64
	// DefaultMaxDownloads is the download count used when DefaultRetention is
	// retentionCount and the request didn't specify maxDownloads, and the floor
	// clampMaxDownloads falls back to for a non-positive explicit request.
	DefaultMaxDownloads int64
	// MaxMaxDownloads bounds any resolved MaxDownloads (explicit or default);
	// 0 = unbounded.
	MaxMaxDownloads int64
	// AccountGraceDays is the grace period between a self-deletion request and
	// GC's hard purge of the account and its data.
	AccountGraceDays int64
	// AccountReminderDays is how many days before purge the one-time reminder
	// email is sent.
	AccountReminderDays int64
	// StorageDiskCap bounds SUM(live stored_files.size) globally.
	StorageDiskCap int64
	// DisableCentralFallback stops uploads landing on the app server's own disk
	// when no storage node is available (they fail instead).
	DisableCentralFallback bool
	// NodeTrafficDefault 是官方节点月度中继流量的默认上限（字节）；0 = 不限。
	NodeTrafficDefault int64
}

// settingOr returns the DB value for key, or def when unset/on error (fail to env).
func (s *Service) settingOr(ctx context.Context, key string, def int64) int64 {
	v, ok, err := s.store.GetSetting(ctx, key)
	if err != nil || !ok {
		return def
	}
	return v
}

// resolveSettings reads the four limits live: DB value if present, else the
// env/flag default seeded into Config. "Admin change > env default."
func (s *Service) resolveSettings(ctx context.Context) Settings {
	return Settings{
		MaxFileSize:            s.settingOr(ctx, SettingMaxFileSize, s.cfg.MaxFileSize),
		DailyQuota:             s.settingOr(ctx, SettingDailyQuota, s.cfg.DailyQuota),
		DefaultTTL:             s.settingOr(ctx, SettingDefaultTTL, s.cfg.DefaultTTL),
		MaxTTL:                 s.settingOr(ctx, SettingMaxTTL, s.cfg.MaxTTL),
		DefaultRetention:       s.settingOr(ctx, SettingDefaultRetention, s.cfg.DefaultRetention),
		DefaultMaxDownloads:    s.settingOr(ctx, SettingDefaultMaxDownloads, s.cfg.DefaultMaxDownloads),
		MaxMaxDownloads:        s.settingOr(ctx, SettingMaxMaxDownloads, s.cfg.MaxMaxDownloads),
		AccountGraceDays:       s.settingOr(ctx, SettingAccountGraceDays, s.cfg.AccountGraceDays),
		AccountReminderDays:    s.settingOr(ctx, SettingAccountReminderDays, s.cfg.AccountReminderDays),
		StorageDiskCap:         s.settingOr(ctx, SettingStorageDiskCap, s.cfg.StorageDiskCap),
		DisableCentralFallback: s.settingOr(ctx, SettingDisableCentralFallback, 0) != 0,
		NodeTrafficDefault:     s.settingOr(ctx, SettingNodeTrafficDefault, s.cfg.NodeTrafficDefault),
	}
}

// ReminderWindowSeconds returns the live pre-purge reminder window
// (Settings.AccountReminderDays*86400) for GC's reminder pass (Task 5), read
// fresh so an admin setting change takes effect without a restart.
func (s *Service) ReminderWindowSeconds(ctx context.Context) int64 {
	return s.resolveSettings(ctx).AccountReminderDays * 86400
}

// clampMaxDownloads resolves a requested download-count cap: a non-positive
// request falls back to the admin's DefaultMaxDownloads, is floored at 1, and
// is clamped to MaxMaxDownloads (0 = unbounded).
func clampMaxDownloads(req int64, st Settings) int64 {
	if req <= 0 {
		req = st.DefaultMaxDownloads
	}
	if req < 1 {
		req = 1
	}
	if st.MaxMaxDownloads > 0 && req > st.MaxMaxDownloads {
		req = st.MaxMaxDownloads
	}
	return req
}

// resolveRetention turns request params + admin settings into stored TTL seconds
// and MaxDownloads. Explicit request params always win over the admin default,
// then are clamped to admin bounds.
func resolveRetention(reqBurn bool, reqTTL, reqMaxDL int64, st Settings) (ttl, maxDL int64) {
	switch {
	case reqBurn:
		maxDL = 1
	case reqMaxDL > 0:
		maxDL = clampMaxDownloads(reqMaxDL, st)
	case reqTTL > 0:
		maxDL = 0 // unlimited within the (clamped) TTL
	default: // nothing requested → apply admin default policy
		switch st.DefaultRetention {
		case retentionBurn:
			maxDL = 1
		case retentionCount:
			maxDL = clampMaxDownloads(0, st)
		default: // retentionTTL
			maxDL = 0
		}
	}
	ttl = clampTTL(reqTTL, st)
	return ttl, maxDL
}

// clampTTL maps a requested TTL (seconds) into [minTTL, MaxTTL]; 0/negative
// means "unspecified" and yields DefaultTTL.
func clampTTL(req int64, st Settings) int64 {
	if req <= 0 {
		req = st.DefaultTTL
	}
	if req < minTTL {
		req = minTTL
	}
	if req > st.MaxTTL {
		req = st.MaxTTL
	}
	return req
}

// SeedSettings writes the Config (flag/env) defaults into the settings table
// for any admin-editable key not already present, so the admin form shows
// live values and so the flag/env value only ever governs the *first* boot.
// Existing (admin-set) values are left untouched — once a key has a DB row,
// settingOr prefers it forever and the corresponding flag/env var stops
// having any effect.
//
// The rule is one rule with no exceptions: command-line flag / env var =
// the initial value at first deploy; after that, the admin backend always
// wins. Every key in this package's Settings struct MUST have an entry
// below, seeded from its Config counterpart — a key missing from this slice
// silently breaks the rule for that one setting only, leaving its flag live
// forever while all its siblings are pinned by their seeded DB row (see
// SettingNodeTrafficDefault's bug history and
// TestSeedSettingsIncludesNodeTrafficDefault). When you add setting #13,
// add its row here too, and add both a "seeds to Config default" test and a
// "existing value survives SeedSettings" test for it.
func (s *Service) SeedSettings(ctx context.Context) error {
	defaults := []struct {
		key string
		val int64
	}{
		{SettingMaxFileSize, s.cfg.MaxFileSize},
		{SettingDailyQuota, s.cfg.DailyQuota},
		{SettingDefaultTTL, s.cfg.DefaultTTL},
		{SettingMaxTTL, s.cfg.MaxTTL},
		{SettingDefaultRetention, s.cfg.DefaultRetention},
		{SettingDefaultMaxDownloads, s.cfg.DefaultMaxDownloads},
		{SettingMaxMaxDownloads, s.cfg.MaxMaxDownloads},
		{SettingAccountGraceDays, s.cfg.AccountGraceDays},
		{SettingAccountReminderDays, s.cfg.AccountReminderDays},
		{SettingStorageDiskCap, s.cfg.StorageDiskCap},
		{SettingDisableCentralFallback, 0}, // default off: central fallback allowed
		{SettingNodeTrafficDefault, s.cfg.NodeTrafficDefault},
	}
	now := s.now().Unix()
	for _, d := range defaults {
		_, ok, err := s.store.GetSetting(ctx, d.key)
		if err != nil {
			return err
		}
		if ok {
			continue
		}
		if err := s.store.SetSetting(ctx, d.key, d.val, now); err != nil {
			return err
		}
	}
	return nil
}

// defaultPlans is the factory tier table; SeedPlans writes any id not already
// present, leaving admin edits untouched (same semantics as SeedSettings).
func defaultPlans() []Plan {
	const mb, gb, tb, day = int64(1) << 20, int64(1) << 30, int64(1) << 40, int64(86400)
	return []Plan{
		// DailyQuotaBytes 的付费档按"月流量 ÷ 3"定。0 = 回落到全局 SettingDailyQuota。
		//
		// Free 的 0 是**有意为之，不是漏填**——别看到 plus/pro/max 都有值就顺手补上。
		// 需求写的是"Free 200 MiB（维持现值）"，但那句话的意图是"别让现有免费用户
		// 觉得变严"。全局默认本来就是 200 MiB，所以填 0 继承全局达到完全相同的效果，
		// 同时保住后台「每账号每日额度」这个旋钮对免费用户（绝大多数用户）仍然有效。
		// 反过来填死 200 MiB，全新部署的免费档从此就不受那个旋钮控制了——这不该是
		// 种子数据顺手做掉的决定。见 TestFreePlanFollowsGlobalDailyQuota。
		{ID: "free", Name: "Free", StorageBytes: 100 * mb, TrafficBytes: 1 * gb, RetentionSecs: 1 * day, PriceMonthly: 0, PriceYearly: 0, SortOrder: 0, Active: true, DailyQuotaBytes: 0},
		{ID: "plus", Name: "Plus", StorageBytes: 1 * gb, TrafficBytes: 20 * gb, RetentionSecs: 3 * day, PriceMonthly: 199, PriceYearly: 1999, SortOrder: 1, Active: true, DailyQuotaBytes: 7 * gb},
		{ID: "pro", Name: "Pro", StorageBytes: 5 * gb, TrafficBytes: 100 * gb, RetentionSecs: 7 * day, PriceMonthly: 499, PriceYearly: 4999, SortOrder: 2, Active: true, DailyQuotaBytes: 34 * gb},
		{ID: "max", Name: "Max", StorageBytes: 10 * gb, TrafficBytes: 800 * gb, RetentionSecs: 14 * day, PriceMonthly: 999, PriceYearly: 9999, SortOrder: 3, Active: true, DailyQuotaBytes: 267 * gb},
	}
}

// SeedPlans inserts the factory tiers for any plan id not already present.
func (s *Service) SeedPlans(ctx context.Context) error {
	now := s.now().Unix()
	for _, p := range defaultPlans() {
		if _, ok, err := s.store.GetPlan(ctx, p.ID); err != nil {
			return err
		} else if ok {
			continue
		}
		p.UpdatedAt = now
		if err := s.store.UpsertPlan(ctx, p); err != nil {
			return err
		}
	}
	return nil
}

// settingFreeTrafficMigrated is the one-shot marker for MigrateFreeTrafficCap.
// freeTrafficCapOld/New are the Free plan's traffic_bytes before/after the
// 2026-07 pricing change (2 GiB / 1 GiB), named so the migration's intent
// reads at the call site instead of as bare byte counts.
const (
	settingFreeTrafficMigrated = "migration.free_traffic_1gib"
	freeTrafficCapOld          = 2 * 1024 * 1024 * 1024 // 2 GiB
	freeTrafficCapNew          = 1024 * 1024 * 1024     // 1 GiB
)

// MigrateFreeTrafficCap is the one-shot 2026-07 pricing migration: it lowers
// the Free plan's monthly traffic cap from 2 GiB to 1 GiB for installs that
// were seeded before the change. SeedPlans only writes a plan id that's
// absent (protecting admin edits), so changing defaultPlans() alone never
// touches an already-seeded Free row — this explicit pass is what moves it.
//
// It runs at most once, guarded by a settings-table marker, and NOT purely by
// value comparison: if we only checked "is Free still 2 GiB", an admin who
// deliberately dials Free back to 2 GiB (recreating the old sentinel value)
// would see it silently flipped back to 1 GiB on the next restart. The marker
// makes "already migrated" durable independent of the current value.
//
// Caller contract: this must run after SeedPlans, never before. On a brand
// new install the plans table is empty until SeedPlans runs; if this ran
// first, the Free row wouldn't exist yet, there'd be nothing to migrate, and
// — if the marker were written anyway — the migration would be marked "done"
// before it ever had a chance to run. Writing the marker unconditionally here
// is only safe because SeedPlans has already guaranteed the Free row exists.
// Moving this call ahead of SeedPlans reopens exactly the admin-override race
// this function exists to close (see the code-review finding on Task 1).
func (s *Service) MigrateFreeTrafficCap(ctx context.Context) error {
	if _, done, err := s.store.GetSetting(ctx, settingFreeTrafficMigrated); err != nil {
		return err
	} else if done {
		return nil
	}
	if p, ok, err := s.store.GetPlan(ctx, "free"); err != nil {
		return err
	} else if ok && p.TrafficBytes == freeTrafficCapOld {
		p.TrafficBytes = freeTrafficCapNew
		p.UpdatedAt = s.now().Unix()
		if err := s.store.UpsertPlan(ctx, p); err != nil {
			return err
		}
	}
	// Unconditional: whether or not a row needed changing (already-1GiB,
	// admin-customized to something else, or migrated just above), this
	// install has now had its one shot — never revisit it.
	return s.store.SetSetting(ctx, settingFreeTrafficMigrated, 1, s.now().Unix())
}
