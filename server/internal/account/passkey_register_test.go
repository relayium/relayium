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

// adminPasswordLogin logs in through the password path and returns the session cookie.
func adminPasswordLogin(t *testing.T, srv *httptest.Server, s *Service) *http.Cookie {
	t.Helper()
	// The login handler answers with a redirect to /admin; without this the
	// client would follow it and resp.Cookies() would read the dashboard's
	// (cookie-less) response instead of the login one.
	srv.Client().CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	req, _ := http.NewRequest("POST", srv.URL+"/admin/login",
		strings.NewReader("username=admin&password=pw"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("password login: %v", err)
	}
	defer resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			return c
		}
	}
	t.Fatalf("no admin session cookie")
	return nil
}

// registerViaHTTP drives a full register begin+finish through the HTTP endpoints.
func registerViaHTTP(t *testing.T, srv *httptest.Server, s *Service, session *http.Cookie, name string) {
	t.Helper()
	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name="+url.QueryEscape(name)))
	breq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	breq.Header.Set("Origin", s.selfOrigin())
	breq.AddCookie(session)
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("register begin: %v", err)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&opts)
	cookies := bresp.Cookies()
	bresp.Body.Close()

	rp, _ := s.adminRP()
	auth := newTestAuthenticator(t)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/finish",
		strings.NewReader(auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	freq.AddCookie(session)
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("register finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("register finish %q: status=%d", name, fresp.StatusCode)
	}
}

// step-up 是本功能最重要的安全边界：仅凭已登录会话不得注册新 passkey，
// 否则一次会话 cookie 泄露即可升级为永久后门。
func TestPasskeyRegisterRequiresStepUp(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")

	// 先用密码登录拿到管理员会话
	session := adminPasswordLogin(t, srv, s)

	// 有会话但不带密码 → 必须被拒
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("name=Laptop"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	req.AddCookie(session)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("register/begin succeeded with session only — step-up not enforced")
	}

	// 带正确密码 → 放行
	ok, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=Laptop"))
	ok.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	ok.Header.Set("Origin", s.selfOrigin())
	ok.AddCookie(session)
	okResp, err := srv.Client().Do(ok)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer okResp.Body.Close()
	if okResp.StatusCode != http.StatusOK {
		t.Fatalf("register/begin with correct creds: status=%d want 200", okResp.StatusCode)
	}
}

// step-up 是完整的密码+TOTP 复验：开了 TOTP 时，光有密码不够。
func TestPasskeyRegisterStepUpHonorsTOTP(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	s.cfg.AdminTOTPSecret = testSecret

	begin := func(form string) int {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
			strings.NewReader(form))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", s.selfOrigin())
		req.AddCookie(session)
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}

	if code := begin("username=admin&password=pw&name=Laptop"); code == http.StatusOK {
		t.Fatalf("register/begin accepted a missing TOTP code while TOTP is on")
	}
	if code := begin("username=admin&password=pw&totp=000000&name=Laptop"); code == http.StatusOK {
		t.Fatalf("register/begin accepted a wrong TOTP code")
	}
	form := "username=admin&password=pw&name=Laptop&totp=" + codeAt(t, s.now())
	if code := begin(form); code != http.StatusOK {
		t.Fatalf("register/begin with a valid TOTP code: status=%d want 200", code)
	}
	// The step must have been consumed, so the same code cannot be replayed.
	if code := begin(form); code == http.StatusOK {
		t.Fatalf("register/begin replayed an already-used TOTP code")
	}
}

// 未登录会话根本不能碰注册端点。
func TestPasskeyRegisterRequiresSession(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=Laptop"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("register/begin succeeded without an admin session")
	}
}

// 完整注册往返：begin(step-up) → authenticator → finish → 入库。
func TestPasskeyRegisterEndToEnd(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)

	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=MacBook"))
	breq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	breq.Header.Set("Origin", s.selfOrigin())
	breq.AddCookie(session)
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&opts)
	bresp.Body.Close()
	cookies := bresp.Cookies()
	if opts.PublicKey.Challenge == "" {
		t.Fatalf("empty challenge")
	}

	rp, _ := s.adminRP()
	auth := newTestAuthenticator(t)
	body := auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/finish",
		strings.NewReader(body))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	freq.AddCookie(session)
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("finish status=%d want 200", fresp.StatusCode)
	}

	rows, err := s.store.ListAdminCredentials(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("stored %d credentials err=%v, want 1", len(rows), err)
	}
	if rows[0].Name != "MacBook" {
		t.Fatalf("name=%q want MacBook", rows[0].Name)
	}
	if len(rows[0].UserHandle) != 32 {
		t.Fatalf("user handle len=%d want 32", len(rows[0].UserHandle))
	}
}

// 第二枚凭据必须复用同一 user handle。
func TestPasskeyRegisterReusesUserHandle(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "第一台")
	registerViaHTTP(t, srv, s, session, "第二台")

	rows, _ := s.store.ListAdminCredentials(context.Background())
	if len(rows) != 2 {
		t.Fatalf("got %d credentials, want 2", len(rows))
	}
	if string(rows[0].UserHandle) != string(rows[1].UserHandle) {
		t.Fatalf("user handle differs between credentials")
	}
}

// 改掉管理员用户名后，已注册的 passkey 必须仍然可用。
func TestPasskeySurvivesAdminUsernameChange(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")

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

// 删除必须要求已登录会话，且成功后凭据消失。
func TestPasskeyDelete(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")
	rows, _ := s.store.ListAdminCredentials(context.Background())
	id := rows[0].ID

	// 无会话 → 拒绝
	noAuth, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/delete",
		strings.NewReader("id="+url.QueryEscape(id)))
	noAuth.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	noAuth.Header.Set("Origin", s.selfOrigin())
	nresp, _ := srv.Client().Do(noAuth)
	nresp.Body.Close()
	rows, _ = s.store.ListAdminCredentials(context.Background())
	if len(rows) != 1 {
		t.Fatalf("credential deleted without a session")
	}

	// 有会话 → 删除
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/delete",
		strings.NewReader("id="+url.QueryEscape(id)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	req.AddCookie(session)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	resp.Body.Close()
	rows, _ = s.store.ListAdminCredentials(context.Background())
	if len(rows) != 0 {
		t.Fatalf("credential still present after delete: %d", len(rows))
	}
}
