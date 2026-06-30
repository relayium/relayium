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
		BaseURL:     "http://example.test",
		MaxFileSize: 50 << 20,
		DailyQuota:  200 << 20,
		DefaultTTL:  86400,
		MaxTTL:      604800,
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
	if len(all) != 4 {
		t.Fatalf("want 4 settings seeded, got %d (%+v)", len(all), all)
	}
	if v, _, _ := store.GetSetting(ctx, SettingDailyQuota); v != 777 {
		t.Fatalf("seed overwrote existing daily_quota = %d, want 777", v)
	}
	if v, _, _ := store.GetSetting(ctx, SettingMaxFileSize); v != 50<<20 {
		t.Fatalf("seed max_file_size = %d, want default", v)
	}
}
