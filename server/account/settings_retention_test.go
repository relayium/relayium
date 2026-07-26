package account

import "testing"

func TestResolveRetention_DefaultBurn(t *testing.T) {
	st := Settings{DefaultRetention: 0, DefaultTTL: 3600, MaxTTL: 86400, DefaultMaxDownloads: 5, MaxMaxDownloads: 100}
	ttl, maxDL := resolveRetention(false, 0, 0, st) // nothing requested → admin default = burn
	if maxDL != 1 {
		t.Fatalf("burn default should yield maxDL=1, got %d", maxDL)
	}
	if ttl != 3600 {
		t.Fatalf("ttl should still default, got %d", ttl)
	}
}

func TestResolveRetention_ExplicitCountClamped(t *testing.T) {
	st := Settings{DefaultRetention: 0, DefaultTTL: 3600, MaxTTL: 86400, DefaultMaxDownloads: 5, MaxMaxDownloads: 10}
	_, maxDL := resolveRetention(false, 0, 999, st) // request 999 downloads → clamp to 10
	if maxDL != 10 {
		t.Fatalf("expected clamp to 10, got %d", maxDL)
	}
}

func TestResolveRetention_ExplicitBurnWins(t *testing.T) {
	st := Settings{DefaultRetention: 2, DefaultTTL: 3600, MaxTTL: 86400, DefaultMaxDownloads: 5, MaxMaxDownloads: 10}
	_, maxDL := resolveRetention(true, 0, 0, st) // --burn overrides count default
	if maxDL != 1 {
		t.Fatalf("explicit burn should yield maxDL=1, got %d", maxDL)
	}
}
