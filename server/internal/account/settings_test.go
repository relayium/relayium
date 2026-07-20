package account

import (
	"context"
	"testing"
	"time"
)

func newSettingsService(t *testing.T) (*Service, *SQLiteStore) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL:             "http://example.test",
		MaxFileSize:         50 << 20,
		DailyQuota:          200 << 20,
		DefaultTTL:          86400,
		MaxTTL:              604800,
		DefaultRetention:    retentionTTL, // keep this suite's uploads unlimited-until-TTL, not burn
		DefaultMaxDownloads: 5,
		MaxMaxDownloads:     100,
		NodeTrafficDefault:  300 << 30, // distinct nonzero value so seeding is verifiable
	})
	svc.now = func() time.Time { return time.Unix(1000, 0) }
	return svc, store
}

func TestResolveSettingsFallsBackToEnvDefaults(t *testing.T) {
	svc, _ := newSettingsService(t)
	st := svc.resolveSettings(context.Background())
	if st.MaxFileSize != 50<<20 || st.DailyQuota != 200<<20 || st.DefaultTTL != 86400 || st.MaxTTL != 604800 {
		t.Fatalf("env fallback wrong: %+v", st)
	}
}

func TestResolveSettingsDBOverridesEnv(t *testing.T) {
	svc, store := newSettingsService(t)
	if err := store.SetSetting(context.Background(), SettingMaxFileSize, 1234, 1); err != nil {
		t.Fatalf("set: %v", err)
	}
	st := svc.resolveSettings(context.Background())
	if st.MaxFileSize != 1234 {
		t.Fatalf("DB override = %d, want 1234", st.MaxFileSize)
	}
	if st.DailyQuota != 200<<20 { // untouched key still falls back
		t.Fatalf("daily quota = %d, want env default", st.DailyQuota)
	}
}

func TestClampTTL(t *testing.T) {
	st := Settings{DefaultTTL: 86400, MaxTTL: 604800}
	cases := []struct{ in, want int64 }{
		{0, 86400},          // absent → default
		{-5, 86400},         // negative → default
		{30, 60},            // below floor → minTTL
		{100000, 100000},    // within range → unchanged
		{999999999, 604800}, // above max → max
	}
	for _, c := range cases {
		if got := clampTTL(c.in, st); got != c.want {
			t.Errorf("clampTTL(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestSeedSettingsInsertsDefaultsOnceAndKeepsExisting(t *testing.T) {
	svc, store := newSettingsService(t)
	ctx := context.Background()
	_ = store.SetSetting(ctx, SettingDailyQuota, 777, 1) // pre-existing override
	if err := svc.SeedSettings(ctx); err != nil {
		t.Fatalf("seed: %v", err)
	}
	all, _ := store.ListSettings(ctx)
	if len(all) != 12 {
		t.Fatalf("want 12 settings seeded, got %d (%+v)", len(all), all)
	}
	if v, _, _ := store.GetSetting(ctx, SettingDefaultRetention); v != retentionTTL {
		t.Fatalf("seed default_retention = %d, want %d", v, int64(retentionTTL))
	}
	if v, _, _ := store.GetSetting(ctx, SettingDefaultMaxDownloads); v != 5 {
		t.Fatalf("seed default_max_downloads = %d, want 5", v)
	}
	if v, _, _ := store.GetSetting(ctx, SettingMaxMaxDownloads); v != 100 {
		t.Fatalf("seed max_max_downloads = %d, want 100", v)
	}
	if v, _, _ := store.GetSetting(ctx, SettingDailyQuota); v != 777 {
		t.Fatalf("seed overwrote existing daily_quota = %d, want 777", v)
	}
	if v, _, _ := store.GetSetting(ctx, SettingMaxFileSize); v != 50<<20 {
		t.Fatalf("seed max_file_size = %d, want default", v)
	}
}

// TestSeedSettingsIncludesNodeTrafficDefault guards against the regression
// where node_traffic_default was the one setting (of twelve) missing from
// SeedSettings' defaults slice: its flag/env value stayed live forever
// because it never got pinned into the DB on first boot like the others.
func TestSeedSettingsIncludesNodeTrafficDefault(t *testing.T) {
	svc, store := newSettingsService(t)
	ctx := context.Background()
	if err := svc.SeedSettings(ctx); err != nil {
		t.Fatalf("seed: %v", err)
	}
	v, ok, err := store.GetSetting(ctx, SettingNodeTrafficDefault)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !ok {
		t.Fatalf("node_traffic_default not seeded")
	}
	if v != svc.cfg.NodeTrafficDefault {
		t.Fatalf("seed node_traffic_default = %d, want %d", v, svc.cfg.NodeTrafficDefault)
	}
}

// TestSeedSettingsKeepsExistingNodeTrafficDefault asserts node_traffic_default
// obeys the same "existing value wins" semantics as every other seeded key:
// an admin-set value already in the DB must survive a SeedSettings call
// unchanged, not get clobbered back to the Config/env default.
func TestSeedSettingsKeepsExistingNodeTrafficDefault(t *testing.T) {
	svc, store := newSettingsService(t)
	ctx := context.Background()
	_ = store.SetSetting(ctx, SettingNodeTrafficDefault, 999, 1) // pre-existing admin override
	if err := svc.SeedSettings(ctx); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if v, _, _ := store.GetSetting(ctx, SettingNodeTrafficDefault); v != 999 {
		t.Fatalf("seed overwrote existing node_traffic_default = %d, want 999", v)
	}
}
