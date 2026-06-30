package account

import "context"

// Setting keys for the admin-editable stored-transfer limits.
const (
	SettingMaxFileSize = "max_file_size"
	SettingDailyQuota  = "daily_quota"
	SettingDefaultTTL  = "default_ttl"
	SettingMaxTTL      = "max_ttl"
)

// minTTL is the floor a requested TTL is clamped up to; well below default_ttl.
const minTTL int64 = 60

// Settings is the resolved live view of the four limits for one request.
type Settings struct {
	MaxFileSize int64
	DailyQuota  int64
	DefaultTTL  int64
	MaxTTL      int64
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
		MaxFileSize: s.settingOr(ctx, SettingMaxFileSize, s.cfg.MaxFileSize),
		DailyQuota:  s.settingOr(ctx, SettingDailyQuota, s.cfg.DailyQuota),
		DefaultTTL:  s.settingOr(ctx, SettingDefaultTTL, s.cfg.DefaultTTL),
		MaxTTL:      s.settingOr(ctx, SettingMaxTTL, s.cfg.MaxTTL),
	}
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
