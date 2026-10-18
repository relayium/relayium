package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// newSessionTestService is an admin-enabled service on a real store with a
// controllable clock.
func newSessionTestService(t *testing.T) (*Service, *SQLiteStore, *time.Time) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, nil, Config{BaseURL: "http://example.test", AdminUser: "admin", AdminEnabled: true})
	now := time.Unix(1_700_000_000, 0)
	clk := &now
	svc.now = func() time.Time { return *clk }
	return svc, store, clk
}

func TestAdminSessionRecordsPasskeyAndCredential(t *testing.T) {
	svc, store, _ := newSessionTestService(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)
	info, ok, err := store.AdminSession(ctx, tok, svc.now().Unix())
	if err != nil || !ok {
		t.Fatalf("session lookup: ok=%v err=%v", ok, err)
	}
	if info.Auth != "passkey" || info.CredentialID != adminTestPasskey(t, svc).credID {
		t.Fatalf("session = %+v, want passkey bound to the test credential", info)
	}
}

func TestCreateAdminSessionRequiresCredential(t *testing.T) {
	_, store, _ := newSessionTestService(t)
	if err := store.CreateAdminSession(context.Background(), "tok", "", 0, 1); err == nil {
		t.Fatal("a session without a credential must not be creatable")
	}
}

// 宽限期：刚验过 → 新鲜；从未验过 → 不新鲜。
func TestStepUpFreshness(t *testing.T) {
	svc, _, _ := newSessionTestService(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)
	if svc.stepUpFresh(ctx, tok) {
		t.Fatal("a brand-new session must NOT be step-up fresh")
	}
	markStepUpForTest(t, svc, tok)
	if !svc.stepUpFresh(ctx, tok) {
		t.Fatal("want fresh right after markStepUp")
	}
}

// 宽限期必须真的会过期，否则一次验证就永久免验，等于没有步进。
func TestStepUpGraceExpires(t *testing.T) {
	svc, _, clk := newSessionTestService(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)
	markStepUpForTest(t, svc, tok)
	*clk = clk.Add(stepUpGraceSecs * time.Second)
	if svc.stepUpFresh(ctx, tok) {
		t.Fatal("a step-up older than the grace window must not count as fresh")
	}
}

// Idle 30 minutes: a session not used for 30 minutes is dead, even though it is
// far from its 12-hour cap. Being used just before the cutoff keeps it alive.
func TestAdminSessionIdleTimeoutAndRefresh(t *testing.T) {
	svc, _, clk := newSessionTestService(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)

	*clk = clk.Add(adminSessionIdleTTL - time.Second)
	if !svc.validAdmin(ctx, tok) {
		t.Fatal("a session used within the idle window must validate")
	}
	// validAdmin refreshed last_seen_at, so another 29m59s is still fine.
	*clk = clk.Add(adminSessionIdleTTL - time.Second)
	if !svc.validAdmin(ctx, tok) {
		t.Fatal("an actively used session must keep validating")
	}
	// Exactly 30 minutes of silence ends it — and a later request cannot revive it.
	*clk = clk.Add(adminSessionIdleTTL)
	if svc.validAdmin(ctx, tok) {
		t.Fatal("a session idle for 30 minutes must not validate")
	}
	// The failed lookup must not have refreshed it: one second later it is
	// still dead, and its stored last_seen_at is unchanged.
	*clk = clk.Add(time.Second)
	if svc.validAdmin(ctx, tok) {
		t.Fatal("an idle-expired session must stay dead (no refresh after expiry)")
	}
}

// Reads that are not the operator's own request must not keep a session alive:
// the audit writer's auth lookup and the step-up grace check are read-only.
func TestAdminSessionReadOnlyLookupsDoNotRefresh(t *testing.T) {
	svc, _, clk := newSessionTestService(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)
	r := httptest.NewRequest("GET", "/admin", nil)
	r.AddCookie(&http.Cookie{Name: adminCookie, Value: tok})
	for i := 0; i < 4; i++ {
		*clk = clk.Add(10 * time.Minute)
		_ = svc.adminAuthMethod(r)
		_ = svc.stepUpFresh(ctx, tok)
		_, _ = svc.adminSessionInfo(ctx, tok)
	}
	if svc.validAdmin(ctx, tok) {
		t.Fatal("40 minutes of read-only lookups kept the session alive")
	}
}

// Absolute 12 hours: even a constantly active session ends.
func TestAdminSessionAbsoluteCap(t *testing.T) {
	svc, _, clk := newSessionTestService(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)
	deadline := clk.Add(adminSessionAbsoluteTTL)
	for clk.Before(deadline.Add(-20 * time.Minute)) {
		*clk = clk.Add(20 * time.Minute)
		if !svc.validAdmin(ctx, tok) {
			t.Fatalf("active session died early at %s", clk.Sub(deadline))
		}
	}
	*clk = deadline
	if svc.validAdmin(ctx, tok) {
		t.Fatal("a session must not outlive the 12-hour absolute cap")
	}
}

// Migration: rows written by the previous binary — a password session, or any
// row without credential_id / last_seen_at — never validate, and need no data
// migration to be dead.
func TestLegacyAdminSessionsAreInvalid(t *testing.T) {
	svc, store, _ := newSessionTestService(t)
	ctx := context.Background()
	k := adminTestPasskey(t, svc)
	now := svc.now().Unix()
	legacy := map[string]string{
		// Exactly what the old CreateAdminSession wrote for a password login.
		"old-password": `INSERT INTO admin_sessions (token, auth, cred_fp, expires, last_step_up_at) VALUES (?, 'password', 'fp', ?, 0)`,
		// An old passkey session: right auth, but no credential binding or last-seen.
		"old-passkey": `INSERT INTO admin_sessions (token, auth, cred_fp, expires, last_step_up_at) VALUES (?, 'passkey', 'fp', ?, ?)`,
	}
	for raw, q := range legacy {
		args := []any{authx.HashToken(raw), now + 3600}
		if raw == "old-passkey" {
			args = append(args, now) // fresh step-up mark must not help either
		}
		if _, err := store.db.Exec(q, args...); err != nil {
			t.Fatal(err)
		}
		if svc.validAdmin(ctx, raw) || svc.stepUpFresh(ctx, raw) {
			t.Fatalf("legacy %s session validated", raw)
		}
	}
	// Even a forged row naming a real credential but with password auth fails.
	if _, err := store.db.Exec(`INSERT INTO admin_sessions (token, auth, cred_fp, expires, last_step_up_at, created_at, last_seen_at, credential_id)
		VALUES (?, 'password', '', ?, 0, ?, ?, ?)`, authx.HashToken("forged"), now+3600, now, now, k.credID); err != nil {
		t.Fatal(err)
	}
	if svc.validAdmin(ctx, "forged") {
		t.Fatal("a password-auth row validated just because it names a credential")
	}
	// And GC removes them all.
	if err := store.PurgeExpiredAdminSessions(ctx, now); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM admin_sessions`).Scan(&n)
	if n != 0 {
		t.Fatalf("purge left %d legacy rows", n)
	}
}

// A session is valid only while its own credential is registered: deleting the
// credential row (whatever deletes it) kills the session and its grace window,
// even if nothing deleted the session row.
func TestAdminSessionDiesWithItsCredential(t *testing.T) {
	svc, store, _ := newSessionTestService(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)
	markStepUpForTest(t, svc, tok)
	if _, err := store.db.Exec(`DELETE FROM admin_credentials`); err != nil {
		t.Fatal(err)
	}
	if svc.validAdmin(ctx, tok) {
		t.Fatal("session outlived its credential")
	}
	if svc.stepUpFresh(ctx, tok) {
		t.Fatal("cached step-up grace outlived the removed credential")
	}
}

// Two Service values sharing ONE store: a session created on instance A is
// recognized on instance B (the whole point of externalizing admin sessions).
func TestAdminSessionSharedAcrossInstances(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	mk := func() *Service {
		return NewService(store, nil, Config{BaseURL: "http://example.test", AdminUser: "admin", AdminEnabled: true})
	}
	svcA, svcB := mk(), mk()
	tok := newTestAdminSession(t, svcA)
	if !svcB.validAdmin(ctx, tok) {
		t.Fatal("a session minted on instance A must validate on instance B")
	}
	markStepUpForTest(t, svcA, tok)
	if !svcB.stepUpFresh(ctx, tok) {
		t.Fatal("a step-up on instance A must be visible on instance B")
	}
}

// Logout deletes the session and the confirmations it minted.
func TestAdminLogoutDropsPendingConfirmations(t *testing.T) {
	svc, store, _ := newSessionTestService(t)
	ctx := context.Background()
	tok := newTestAdminSession(t, svc)
	if ok, err := store.PutPendingAction(ctx, "pend", tok, AuditSettings, "", "", svc.now().Unix(), svc.now().Unix()+300, 16); err != nil || !ok {
		t.Fatalf("put pending: %v %v", ok, err)
	}
	if err := store.DeleteAdminSession(ctx, tok); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, _, ok, _ := store.TakePendingAction(ctx, "pend"); ok {
		t.Fatal("pending confirmation survived logout")
	}
}
