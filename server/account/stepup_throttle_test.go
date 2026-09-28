package account

import (
	"context"
	"net/http"
	"net/url"
	"testing"
)

// Five wrong factors on one session: the fifth answers 429 and the session is
// revoked, so it can no longer reach the admin at all.
func TestStepUpFactorFailuresLockAndRevokeSession(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	before := svc.ResolveSettings(t.Context())

	var codes []int
	for i := 0; i < adminLoginMaxFails; i++ {
		tok := pendingSettingsConfirm(t, ts, svc, cookie, "321")
		resp := postAdminForm(t, ts, cookie, "/admin/confirm",
			url.Values{"confirm_token": {tok}, "factor_code": {"wrong-password"}})
		resp.Body.Close()
		codes = append(codes, resp.StatusCode)
	}
	for i, c := range codes[:adminLoginMaxFails-1] {
		if c != http.StatusUnauthorized {
			t.Fatalf("attempt %d: want 401 before the threshold, got %d (all: %v)", i+1, c, codes)
		}
	}
	if last := codes[adminLoginMaxFails-1]; last != http.StatusTooManyRequests {
		t.Fatalf("attempt %d: want 429 at the threshold, got %d (all: %v)", adminLoginMaxFails, last, codes)
	}
	if _, _, ok, err := store.AdminSession(context.Background(), cookie.Value, svc.adminCredFP(), svc.Now().Unix()); err != nil || ok {
		t.Fatalf("session must be revoked after the lockout: ok=%v err=%v", ok, err)
	}
	// The dead session cannot even reach the confirmation handler again, let
	// alone apply a change with the right password.
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {"x"}, "factor_code": {"secret123"}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/admin" {
		t.Fatalf("revoked session got %d -> %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if svc.ResolveSettings(t.Context()).DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: a setting was applied during the guessing run")
	}
}

// A correct factor after a couple of mistakes still works, and clears the count.
func TestStepUpCorrectFactorAfterFailuresStillApplies(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	for i := 0; i < 2; i++ {
		tok := pendingSettingsConfirm(t, ts, svc, cookie, "321")
		resp := postAdminForm(t, ts, cookie, "/admin/confirm",
			url.Values{"confirm_token": {tok}, "factor_code": {"wrong-password"}})
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("wrong factor %d: want 401, got %d", i+1, resp.StatusCode)
		}
	}
	tok := pendingSettingsConfirm(t, ts, svc, cookie, "555")
	resp := postAdminForm(t, ts, cookie, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"secret123"}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("correct factor after 2 failures should apply (302), got %d", resp.StatusCode)
	}
	if got := svc.ResolveSettings(t.Context()).DailyQuota; got != 555*1024*1024 {
		t.Fatalf("setting not applied; daily_quota=%d", got)
	}
	if svc.adminLogins.locked(stepUpThrottleKey(cookie.Value), svc.Now()) {
		t.Fatal("success must not leave the session locked")
	}
	svc.adminLogins.mu.Lock()
	_, stillCounted := svc.adminLogins.entries[stepUpThrottleKey(cookie.Value)]
	svc.adminLogins.mu.Unlock()
	if stillCounted {
		t.Fatal("a successful factor must reset the failure count")
	}
}

// The counter belongs to one session: another admin session's failures do not
// count against this one, and neither lockout touches admin login's per-IP key.
func TestStepUpThrottleIsPerSession(t *testing.T) {
	ts, svc, _, _ := newAdminAuditServer(t)
	a := adminLoginCookie(t, ts)
	b := adminLoginCookie(t, ts)
	if a.Value == b.Value {
		t.Fatal("expected two distinct sessions")
	}
	for i := 0; i < adminLoginMaxFails; i++ {
		tok := pendingSettingsConfirm(t, ts, svc, a, "321")
		resp := postAdminForm(t, ts, a, "/admin/confirm",
			url.Values{"confirm_token": {tok}, "factor_code": {"wrong-password"}})
		resp.Body.Close()
	}
	tok := pendingSettingsConfirm(t, ts, svc, b, "444")
	resp := postAdminForm(t, ts, b, "/admin/confirm",
		url.Values{"confirm_token": {tok}, "factor_code": {"wrong-password"}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("session b's first failure must be a plain 401, got %d", resp.StatusCode)
	}
	if svc.AdminLoginLocked("127.0.0.1") {
		t.Fatal("step-up failures must not lock admin login for the IP")
	}
	// And admin login from the same IP still works after session a's lockout.
	_ = adminLoginCookie(t, ts)
}
