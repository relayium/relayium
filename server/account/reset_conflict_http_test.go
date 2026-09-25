package account

// W-N48: the HTTP answers when a password reset or a browser password login is
// overtaken by another credential change. ResetPassword returns
// ErrCredentialsChanged when a later reset/change commits after its own
// transaction and before its session insert; the handler used to report that
// as a generic 500. It now answers 409 credentials_changed with no cookie,
// while a real store failure stays 500 and a raced browser login keeps its
// 401 invalid credentials. Every interleaving runs the real handlers on the
// real SQLite store; only the moment the second writer commits is chosen.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// afterResetCommits is the real store; right after the first reset's
// transaction commits (and before that reset issues its session) it runs
// `then` once. A plain flag, not sync.Once: `then` may run a reset through
// this same wrapper, and a re-entrant Once.Do would wait on itself.
type afterResetCommits struct {
	*SQLiteStore
	fired bool
	then  func()
}

func (w *afterResetCommits) ResetPasswordWithToken(ctx context.Context, tokenHash string, now int64, passwordHash string) (ResetOutcome, string, int64, error) {
	outcome, uid, epoch, err := w.SQLiteStore.ResetPasswordWithToken(ctx, tokenHash, now, passwordHash)
	if !w.fired && err == nil && outcome == ResetApplied {
		w.fired = true
		w.then()
	}
	return outcome, uid, epoch, err
}

func postReset(svc *Service, token, password string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	svc.handleResetPassword(rec, httptest.NewRequest(http.MethodPost, "/api/auth/password/reset",
		strings.NewReader(`{"token":"`+token+`","newPassword":"`+password+`"}`)))
	return rec
}

func postPasswordLogin(svc *Service, password string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	svc.handlePasswordLogin(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login",
		strings.NewReader(`{"email":"victim@example.com","password":"`+password+`"}`)))
	return rec
}

func setsSessionCookie(rec *httptest.ResponseRecorder) bool {
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			return true
		}
	}
	return false
}

func assertAnswer(t *testing.T, rec *httptest.ResponseRecorder, code int, body string) {
	t.Helper()
	if rec.Code != code || strings.TrimSpace(rec.Body.String()) != body {
		t.Fatalf("answered %d %q, want %d %q", rec.Code, rec.Body.String(), code, body)
	}
}

func TestResetOverHTTPOvertakenByAnotherResetAnswersConflict(t *testing.T) {
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	st := sqliteOf(t, svc)
	first := resetLink(t, svc, m)
	second := resetLink(t, svc, m)
	var winner *httptest.ResponseRecorder
	hook := &afterResetCommits{SQLiteStore: st, then: func() {
		winner = postReset(svc, second, "second-password-4")
	}}
	svc.store = hook

	rec := postReset(svc, first, "first-password-3")
	if !hook.fired {
		t.Fatalf("the second reset never ran between the first reset's commit and its session: %d %s", rec.Code, rec.Body.String())
	}
	assertAnswer(t, rec, http.StatusConflict, `{"error":"credentials_changed"}`)
	if setsSessionCookie(rec) {
		t.Fatalf("the overtaken reset set a session cookie: %q", rec.Header().Get("Set-Cookie"))
	}
	if winner.Code != http.StatusOK || !setsSessionCookie(winner) {
		t.Fatalf("the winning reset: %d %s", winner.Code, winner.Body.String())
	}
	var winnerSess Session
	for _, c := range winner.Result().Cookies() {
		if c.Name == sessionCookie {
			winnerSess = Session{ID: c.Value}
		}
	}
	if n := liveSessions(t, st, u.ID); n != 1 || !live(t, svc, winnerSess) {
		t.Fatalf("%d live sessions, want only the winning reset's", n)
	}
	if canLogin(svc, "first-password-3") || !canLogin(svc, "second-password-4") {
		t.Fatal("the password in effect is not the later reset's")
	}
	// The overtaken reset did spend its link: it cannot be retried as if unspent.
	assertAnswer(t, postReset(svc, first, "first-password-3"), http.StatusBadRequest, `{"error":"invalid_token"}`)
}

// Reachable when whoever holds the first reset's new password signs in with it
// and changes it in the window between that reset's commit and its session.
func TestResetOverHTTPOvertakenByAPasswordChangeAnswersConflict(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	st := sqliteOf(t, svc)
	first := resetLink(t, svc, m)
	var changer Session
	hook := &afterResetCommits{SQLiteStore: st, then: func() {
		var err error
		if changer, err = svc.Login(ctx, "victim@example.com", "first-password-3"); err != nil {
			t.Errorf("login with the reset's password: %v", err)
			return
		}
		if err := svc.ChangePassword(ctx, u, changer.ID, "first-password-3", "changed-password-5"); err != nil {
			t.Errorf("change: %v", err)
		}
	}}
	svc.store = hook

	rec := postReset(svc, first, "first-password-3")
	if !hook.fired {
		t.Fatalf("the change never ran between the reset's commit and its session: %d %s", rec.Code, rec.Body.String())
	}
	assertAnswer(t, rec, http.StatusConflict, `{"error":"credentials_changed"}`)
	if setsSessionCookie(rec) {
		t.Fatalf("the overtaken reset set a session cookie: %q", rec.Header().Get("Set-Cookie"))
	}
	if n := liveSessions(t, st, u.ID); n != 1 || !live(t, svc, changer) {
		t.Fatalf("%d live sessions, want only the changer's own", n)
	}
	if canLogin(svc, "first-password-3") || !canLogin(svc, "changed-password-5") {
		t.Fatal("the password in effect is not the change's")
	}
	assertAnswer(t, postReset(svc, first, "first-password-3"), http.StatusBadRequest, `{"error":"invalid_token"}`)
}

// A store failure at the same point is not a conflict: it stays a 500 (the
// page's generic copy says the new password may already be set).
func TestResetOverHTTPSessionStoreFailureStaysServerError(t *testing.T) {
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	st := sqliteOf(t, svc)
	first := resetLink(t, svc, m)
	armFault(t, svc, `CREATE TRIGGER inject_fault BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected fault'); END`)

	rec := postReset(svc, first, "first-password-3")
	assertAnswer(t, rec, http.StatusInternalServerError, "server error")
	if setsSessionCookie(rec) {
		t.Fatal("a failed reset set a session cookie")
	}
	disarmFault(t, svc)
	if n := liveSessions(t, st, u.ID); n != 0 {
		t.Fatalf("%d live sessions after the failed session insert, want 0", n)
	}
}

func TestResetOverHTTPControls(t *testing.T) {
	t.Run("success issues the cookie", func(t *testing.T) {
		svc, m := newTestService(t)
		u, _, _ := victim(t, svc, m)
		rec := postReset(svc, resetLink(t, svc, m), "first-password-3")
		if rec.Code != http.StatusOK || !setsSessionCookie(rec) || !strings.Contains(rec.Body.String(), `"user"`) {
			t.Fatalf("plain reset: %d %s", rec.Code, rec.Body.String())
		}
		if n := liveSessions(t, sqliteOf(t, svc), u.ID); n != 1 {
			t.Fatalf("%d live sessions, want the resetter's", n)
		}
	})
	t.Run("unknown token stays invalid_token", func(t *testing.T) {
		svc, m := newTestService(t)
		victim(t, svc, m)
		rec := postReset(svc, "not-a-real-token", "first-password-3")
		assertAnswer(t, rec, http.StatusBadRequest, `{"error":"invalid_token"}`)
		if setsSessionCookie(rec) {
			t.Fatal("an invalid token set a session cookie")
		}
	})
}

// A browser password login that read the old password just before a reset
// committed keeps answering 401 invalid credentials over HTTP — it does not
// disclose the race — and leaves no session or cookie behind.
func TestBrowserLoginOverHTTPOvertakenByAResetStaysUnauthorized(t *testing.T) {
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	st := sqliteOf(t, svc)
	raw := resetLink(t, svc, m)
	fired := false
	var resetter Session
	svc.store = &resetRightAfterPasswordRead{SQLiteStore: st, reset: func() {
		fired = true
		var err error
		if resetter, err = svc.ResetPassword(context.Background(), raw, "new-password-2"); err != nil {
			t.Errorf("racing reset: %v", err)
		}
	}}

	rec := postPasswordLogin(svc, "old-password-1")
	if !fired {
		t.Fatalf("the reset never ran inside the login: %d %s", rec.Code, rec.Body.String())
	}
	assertAnswer(t, rec, http.StatusUnauthorized, `{"error":"invalid credentials"}`)
	if setsSessionCookie(rec) {
		t.Fatalf("the overtaken login set a session cookie: %q", rec.Header().Get("Set-Cookie"))
	}
	if n := liveSessions(t, st, u.ID); n != 1 || !live(t, svc, resetter) {
		t.Fatalf("%d live sessions, want only the resetter's", n)
	}
}
