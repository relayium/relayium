package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestOperationalVersionPolicyDefaultsAndCAS(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	policy, err := store.GetOperationalVersionPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Revision != 6 || policy.FleetMinimumVersion != "v0.22.0" ||
		policy.MacMinimumVersion != "1.2.11" || policy.MacMinimumBuild != 17 {
		t.Fatalf("unexpected initial policy: %+v", policy)
	}
	next := policy
	next.FleetMinimumVersion = "v0.22.1"
	next.MacMinimumVersion, next.MacMinimumBuild = "1.3.0", 18
	ok, err := store.UpdateOperationalVersionPolicy(ctx, policy.Revision, next)
	if err != nil || !ok {
		t.Fatalf("first update = %v, %v", ok, err)
	}
	ok, err = store.UpdateOperationalVersionPolicy(ctx, policy.Revision, next)
	if err != nil || ok {
		t.Fatalf("stale update = %v, %v", ok, err)
	}
	after, err := store.GetOperationalVersionPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != 7 || after.FleetMinimumVersion != "v0.22.1" ||
		after.MacMinimumVersion != "1.3.0" || after.MacMinimumBuild != 18 {
		t.Fatalf("unexpected updated policy: %+v", after)
	}
}

func TestOperationalPolicyOnlyAcceptsVerifiedMacReleasePairs(t *testing.T) {
	current := OperationalVersionPolicy{Revision: 6, MacRecommendedVersion: "1.3.0",
		MacLatestVersion: "1.3.2"}
	form := url.Values{"fleet_min_version": {"v0.22.0"}, "mac_min_release": {"1.3.0:999"},
		"mac_recommended_version": {"1.3.0"}, "mac_latest_version": {"1.3.2"}}
	if _, err := parseOperationalVersionPolicyForm(form, current); err == nil {
		t.Fatal("an unverified version/build pair was accepted")
	}
	form.Set("mac_min_release", "1.3.0:18")
	next, err := parseOperationalVersionPolicyForm(form, current)
	if err != nil {
		t.Fatal(err)
	}
	if next.MacMinimumVersion != "1.3.0" || next.MacMinimumBuild != 18 {
		t.Fatalf("verified pair changed shape: %+v", next)
	}
	form.Set("mac_recommended_version", "1.2.11")
	if _, err := parseOperationalVersionPolicyForm(form, current); err == nil {
		t.Fatal("minimum newer than recommended was accepted")
	}
	form.Set("mac_recommended_version", "1.3.1")
	form.Set("mac_latest_version", "9.9.9")
	if _, err := parseOperationalVersionPolicyForm(form, current); err == nil {
		t.Fatal("an unverified latest version was accepted")
	}
}

func TestPublicMacPolicyComesFromRevisionedStore(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{})
	req := httptest.NewRequest(http.MethodGet, "/api/client-policy/macos", nil)
	rec := httptest.NewRecorder()
	svc.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body struct {
		Schema int `json:"schema"`
		MacOS  struct {
			Revision int64  `json:"policyRevision"`
			Minimum  string `json:"minimumSupportedVersion"`
			Build    int    `json:"minimumSupportedBuild"`
		} `json:"macos"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Schema != 1 || body.MacOS.Revision != 6 || body.MacOS.Minimum != "1.2.11" ||
		body.MacOS.Build != 17 {
		t.Fatalf("unexpected document: %+v", body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache control = %q", got)
	}
}

func TestFleetRolloutCannotTargetBelowOperationalMinimum(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{})
	err := svc.SetTargetVersion(context.Background(), "fleet", "v0.21.9")
	if err == nil {
		t.Fatal("a target below the operational floor was accepted")
	}
	if _, found, getErr := store.GetRolloutTrack(context.Background(), "fleet"); getErr != nil || found {
		t.Fatalf("refused target changed rollout state: found=%v err=%v", found, getErr)
	}
}

func TestLocalMacPolicyRefreshPreservesFloorsAndAuditsAtomically(t *testing.T) {
	releases, err := verifiedMacReleases()
	if err != nil || len(releases) == 0 {
		t.Fatalf("expected a verified release to refresh to: %v", err)
	}
	wantLatest := releases[len(releases)-1].Version

	st := newTestStore(t)
	ctx := context.Background()
	now := int64(1800000000)
	_, err = st.db.Exec(`UPDATE operational_version_policy SET revision=16,fleet_min_version='v0.25.0',mac_min_version='1.4.10',mac_min_build=47,mac_recommended_version='1.5.0',mac_latest_version='1.5.0' WHERE id=1`)
	if err != nil {
		t.Fatal(err)
	}
	before, err := st.GetOperationalVersionPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.AdminAuth().RefreshMacVersionPolicy(ctx, 15, now, "test"); err == nil {
		t.Fatal("stale revision accepted")
	}
	// An audit-write failure must roll back the policy change, not leave an
	// unaudited successful refresh.
	if _, err = st.db.Exec(`CREATE TRIGGER refuse_refresh_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AdminAuth().RefreshMacVersionPolicy(ctx, 16, now, "test"); err == nil {
		t.Fatal("audit failure ignored")
	}
	after, err := st.GetOperationalVersionPolicy(ctx)
	if err != nil || after != before {
		t.Fatal("partial refresh survived failed audit", after, err)
	}
	if _, err = st.db.Exec(`DROP TRIGGER refuse_refresh_audit`); err != nil {
		t.Fatal(err)
	}
	updated, err := st.AdminAuth().RefreshMacVersionPolicy(ctx, 16, now, "test")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 17 || updated.FleetMinimumVersion != "v0.25.0" || updated.MacMinimumVersion != "1.4.10" || updated.MacMinimumBuild != 47 || updated.MacRecommendedVersion != wantLatest || updated.MacLatestVersion != wantLatest {
		t.Fatal("wrong refresh", updated)
	}
	var count int
	if err = st.db.QueryRow(`SELECT count(*) FROM admin_audit WHERE auth='cli' AND action=?`, AuditVersionPolicy).Scan(&count); err != nil || count != 1 {
		t.Fatal("missing/duplicate audit", count, err)
	}
	repeated, err := st.AdminAuth().RefreshMacVersionPolicy(ctx, 17, now+1, "test")
	if err != nil || repeated != updated {
		t.Fatal("no-op refresh changed policy", repeated, err)
	}
	if _, err = st.db.Exec(`UPDATE operational_version_policy SET mac_latest_version='9.0.0' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if _, err = st.AdminAuth().RefreshMacVersionPolicy(ctx, 17, now, "test"); err == nil {
		t.Fatal("downgrade accepted")
	}
}
