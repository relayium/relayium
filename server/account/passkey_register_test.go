package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// The browser can no longer add or remove an admin passkey — not with a
// stolen session cookie, not through the old endpoints, not by calling the old
// handlers directly, and not through a pending confirmation minted by an older
// binary. Credentials change only through AdminAuthStore (the local command).

func adminCredentialIDs(t *testing.T, s *Service) []string {
	t.Helper()
	rows, err := s.store.ListAdminCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, r := range rows {
		ids = append(ids, r.ID)
	}
	return ids
}

func TestBrowserCannotAddOrDeletePasskeysEvenWithASession(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "on")
	stolen := adminSessionCookie(t, s) // a fully valid admin session
	existing := adminTestPasskey(t, s).credID
	before := adminCredentialIDs(t, s)

	// A login challenge any client can mint, to give a register/finish body the
	// best possible chance of being well-formed.
	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	breq.Header.Set("Origin", s.selfOrigin())
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatal(err)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	_ = json.NewDecoder(bresp.Body).Decode(&opts)
	ceremony := bresp.Cookies()
	bresp.Body.Close()

	rp, _ := s.adminRP()
	attacker := newTestAuthenticator(t)
	attempts := []struct {
		path, ctype, body string
	}{
		{"/admin/passkey/register/begin", "application/x-www-form-urlencoded", "name=evil&username=admin&password=pw"},
		{"/admin/passkey/register/finish", "application/json", attacker.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)},
		{"/admin/passkey/delete", "application/x-www-form-urlencoded", "id=" + url.QueryEscape(existing)},
	}
	for _, a := range attempts {
		req, _ := http.NewRequest("POST", srv.URL+a.path, strings.NewReader(a.body))
		req.Header.Set("Content-Type", a.ctype)
		req.Header.Set("Origin", s.selfOrigin())
		req.AddCookie(stolen)
		for _, c := range ceremony {
			req.AddCookie(c)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusGone {
			t.Errorf("POST %s with a valid session: status %d, want 410", a.path, resp.StatusCode)
		}
	}

	// The handlers themselves, called directly with the session (bypassing the
	// mux), are inert too.
	for name, h := range map[string]http.HandlerFunc{
		"register/begin":  s.HandleAdminPasskeyRegisterBegin,
		"register/finish": s.HandleAdminPasskeyRegisterFinish,
		"delete":          s.HandleAdminPasskeyDelete,
	} {
		w := callAdminHandler(h, stolen, url.Values{"id": {existing}, "name": {"evil"}}, nil)
		if w.Code != http.StatusGone {
			t.Errorf("direct %s: status %d, want 410", name, w.Code)
		}
	}

	after := adminCredentialIDs(t, s)
	if len(after) != len(before) || after[0] != existing {
		t.Fatalf("browser changed the credential table: before %v after %v", before, after)
	}
	if !s.validAdmin(context.Background(), stolen.Value) {
		t.Fatal("the session itself should be unaffected by refused attempts")
	}
}

// A pending "passkey.delete" confirmation minted by an older binary (still in
// admin_pending_actions across an upgrade) must not delete anything when
// confirmed: the action has no handler any more and fails closed.
func TestLegacyPasskeyDeleteConfirmationFailsClosed(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "on")
	session := adminSessionCookie(t, s)
	existing := adminTestPasskey(t, s).credID
	markStepUpForTest(t, s, session.Value) // grace: no factor needed
	form := url.Values{"id": {existing}}
	if ok, err := s.store.PutPendingAction(context.Background(), "legacy-tok", session.Value,
		AuditPasskeyDelete, form.Encode(), "", s.now().Unix(), s.now().Unix()+300, 16); err != nil || !ok {
		t.Fatalf("seed pending: %v %v", ok, err)
	}
	resp := postAdminForm(t, srv, session, "/admin/confirm", url.Values{"confirm_token": {"legacy-tok"}})
	resp.Body.Close()
	if resp.StatusCode < 400 {
		t.Fatalf("legacy passkey.delete confirmation: status %d, want a refusal", resp.StatusCode)
	}
	if ids := adminCredentialIDs(t, s); len(ids) != 1 || ids[0] != existing {
		t.Fatalf("legacy confirmation deleted a credential: %v", ids)
	}
}

// 改掉管理员用户名后，已注册的 passkey 必须仍然可用（handle 与用户名解耦）。
func TestPasskeySurvivesAdminUsernameChange(t *testing.T) {
	_, s := newAdminServer(t, "admin", "on")
	adminTestPasskey(t, s)
	before, _, _ := s.store.AdminUserHandle(context.Background())
	s.cfg.AdminUser = "someone-else"
	user, err := s.loadAdminPasskeyUser(context.Background())
	if err != nil {
		t.Fatalf("load after rename: %v", err)
	}
	if string(user.handle) != string(before) {
		t.Fatalf("user handle changed with admin username")
	}
	if len(user.creds) != 1 {
		t.Fatalf("credentials lost after rename: %d", len(user.creds))
	}
}

// The password-login route answers 410 and never issues a cookie, whatever is
// posted — including what used to be the correct legacy password.
func TestLegacyPasswordLoginCannotIssueASession(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "on")
	adminTestPasskey(t, s)
	client := srv.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for _, form := range []url.Values{
		{"username": {"admin"}, "password": {"on"}},
		{"username": {"admin"}, "password": {"pw"}, "totp": {"123456"}},
		{},
	} {
		req, _ := http.NewRequest("POST", srv.URL+"/admin/login", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", s.selfOrigin())
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusGone {
			t.Errorf("POST /admin/login: status %d, want 410", resp.StatusCode)
		}
		for _, c := range resp.Cookies() {
			if c.Name == adminCookie && c.Value != "" {
				t.Fatalf("password POST issued an admin cookie")
			}
		}
	}
	var n int
	_ = s.store.(*SQLiteStore).db.QueryRow(`SELECT COUNT(*) FROM admin_sessions`).Scan(&n)
	if n != 0 {
		t.Fatalf("password POST created %d session rows", n)
	}
	// The handler does not even read the request: a direct call is the same.
	w := httptest.NewRecorder()
	s.handleAdminRemovedEndpoint(w, httptest.NewRequest("POST", "/admin/login", strings.NewReader("password=on")))
	if w.Code != http.StatusGone || len(w.Result().Cookies()) != 0 {
		t.Fatalf("removed endpoint: %d %v", w.Code, w.Result().Cookies())
	}
}
