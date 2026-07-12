package account

import "context"

// Setting keys for the admin-editable stored-transfer limits.
const (
	SettingMaxFileSize      = "max_file_size"
	SettingDailyQuota       = "daily_quota"
	SettingDefaultTTL       = "default_ttl"
	SettingMaxTTL           = "max_ttl"
	SettingRelayMonthlyFree = "relay_monthly_free_bytes"
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
	MaxFileSize      int64
	DailyQuota       int64
	DefaultTTL       int64
	MaxTTL           int64
	RelayMonthlyFree int64
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
		MaxFileSize:         s.settingOr(ctx, SettingMaxFileSize, s.cfg.MaxFileSize),
		DailyQuota:          s.settingOr(ctx, SettingDailyQuota, s.cfg.DailyQuota),
		DefaultTTL:          s.settingOr(ctx, SettingDefaultTTL, s.cfg.DefaultTTL),
		MaxTTL:              s.settingOr(ctx, SettingMaxTTL, s.cfg.MaxTTL),
		RelayMonthlyFree:    s.settingOr(ctx, SettingRelayMonthlyFree, s.cfg.RelayMonthlyFree),
		DefaultRetention:    s.settingOr(ctx, SettingDefaultRetention, s.cfg.DefaultRetention),
		DefaultMaxDownloads: s.settingOr(ctx, SettingDefaultMaxDownloads, s.cfg.DefaultMaxDownloads),
		MaxMaxDownloads:     s.settingOr(ctx, SettingMaxMaxDownloads, s.cfg.MaxMaxDownloads),
		AccountGraceDays:    s.settingOr(ctx, SettingAccountGraceDays, s.cfg.AccountGraceDays),
		AccountReminderDays: s.settingOr(ctx, SettingAccountReminderDays, s.cfg.AccountReminderDays),
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

// SeedSettings writes the Config defaults into the settings table for any of the
// four keys not already present, so the admin form shows live values. Existing
// (admin-set) values are left untouched.
func (s *Service) SeedSettings(ctx context.Context) error {
	defaults := []struct {
		key string
		val int64
	}{
		{SettingMaxFileSize, s.cfg.MaxFileSize},
		{SettingDailyQuota, s.cfg.DailyQuota},
		{SettingDefaultTTL, s.cfg.DefaultTTL},
		{SettingMaxTTL, s.cfg.MaxTTL},
		{SettingRelayMonthlyFree, s.cfg.RelayMonthlyFree},
		{SettingDefaultRetention, s.cfg.DefaultRetention},
		{SettingDefaultMaxDownloads, s.cfg.DefaultMaxDownloads},
		{SettingMaxMaxDownloads, s.cfg.MaxMaxDownloads},
		{SettingAccountGraceDays, s.cfg.AccountGraceDays},
		{SettingAccountReminderDays, s.cfg.AccountReminderDays},
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
