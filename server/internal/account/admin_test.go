package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func newAdminServer(t *testing.T, user, pass string) *httptest.Server {
	t.Helper()
	store := newTestStore(t)
	// 种一个用户，列表里能看到。
	_, _ = store.UpsertUserByEmail(context.Background(), "seen@example.com", "Seen")
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: user, AdminPassword: pass,
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func TestAdminDisabledWhenNoPassword(t *testing.T) {
	ts := newAdminServer(t, "admin", "")
	resp, _ := ts.Client().Get(ts.URL + "/admin")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("admin off => /admin should 404, got %d", resp.StatusCode)
	}
}

func TestAdminUserDefaultsToAdminWhenUnset(t *testing.T) {
	// 不配账号时默认为 "admin"（向后兼容只设密码的部署）。
	ts := newAdminServer(t, "", "s3cret")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, _ := client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"admin"}, "password": {"s3cret"}})
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("default username 'admin' should log in, got %d", resp.StatusCode)
	}
}

func newAdminSettingsServer(t *testing.T) (*httptest.Server, *SQLiteStore) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", AdminUser: "boss", AdminPassword: "s3cret",
		MaxFileSize: 50 << 20, DailyQuota: 200 << 20, DefaultTTL: 86400, MaxTTL: 604800,
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, store
}

func adminLogin(t *testing.T, ts *httptest.Server) *http.Cookie {
	t.Helper()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, _ := client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"boss"}, "password": {"s3cret"}})
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			return c
		}
	}
	t.Fatal("no admin cookie")
	return nil
}

func TestAdminSettingsUpdateValid(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// 10 MiB file, 100 MiB quota, 12h default, 48h max.
	req, _ := http.NewRequest("POST", ts.URL+"/admin/settings", strings.NewReader(
		"max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("valid settings POST: want 302, got %d", resp.StatusCode)
	}
	v, _, _ := store.GetSetting(context.Background(), SettingMaxFileSize)
	if v != 10*1024*1024 {
		t.Fatalf("max_file_size = %d, want 10 MiB", v)
	}
	if d, _, _ := store.GetSetting(context.Background(), SettingDefaultTTL); d != 12*3600 {
		t.Fatalf("default_ttl = %d, want 43200", d)
	}
}

func TestAdminSettingsRejectsInvalid(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	post := func(form string) int {
		req, _ := http.NewRequest("POST", ts.URL+"/admin/settings", strings.NewReader(form))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.AddCookie(cookie)
		resp, _ := client.Do(req)
		return resp.StatusCode
	}
	// default_ttl (48h) > max_ttl (24h) → rejected.
	if code := post("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=48&max_ttl_hours=24"); code != http.StatusBadRequest {
		t.Fatalf("default>max: want 400, got %d", code)
	}
	// Negative value → rejected.
	if code := post("max_file_size_mb=-1&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48"); code != http.StatusBadRequest {
		t.Fatalf("negative: want 400, got %d", code)
	}
	// Nothing persisted by the rejected posts.
	if _, ok, _ := store.GetSetting(context.Background(), SettingMaxFileSize); ok {
		t.Fatalf("invalid POST must not write settings")
	}
}

func TestAdminSettingsRequiresAdmin(t *testing.T) {
	ts, _ := newAdminSettingsServer(t)
	resp, _ := ts.Client().Post(ts.URL+"/admin/settings", "application/x-www-form-urlencoded",
		strings.NewReader("max_file_size_mb=10&daily_quota_mb=100&default_ttl_hours=12&max_ttl_hours=48"))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth settings POST: want 401, got %d", resp.StatusCode)
	}
}

func TestAdminLoginGate(t *testing.T) {
	ts := newAdminServer(t, "boss", "s3cret")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// 未登录 GET /admin => 登录表单（含账号与密码字段）。
	resp, _ := client.Get(ts.URL + "/admin")
	if resp.StatusCode != http.StatusOK || !bodyContains(resp, "username") {
		t.Fatalf("unauth admin should show login form with a username field")
	}

	hasCookie := func(resp *http.Response) bool {
		for _, c := range resp.Cookies() {
			if c.Name == adminCookie {
				return true
			}
		}
		return false
	}

	// 错误密码（账号对）=> 不设 cookie。
	resp, _ = client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"boss"}, "password": {"wrong"}})
	if hasCookie(resp) {
		t.Fatalf("wrong password must not set admin cookie")
	}

	// 错误账号（密码对）=> 不设 cookie。
	resp, _ = client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"nobody"}, "password": {"s3cret"}})
	if hasCookie(resp) {
		t.Fatalf("wrong username must not set admin cookie")
	}

	// 账号+密码都对 => 设 cookie + 重定向。
	resp, _ = client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"boss"}, "password": {"s3cret"}})
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("good login should redirect, got %d", resp.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("good login set no admin cookie")
	}

	// 带 cookie GET /admin => 用户列表含 seeded 邮箱。
	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if !bodyContains(resp, "seen@example.com") {
		t.Fatalf("authed admin should list users")
	}
}

func TestAdminLoginTOTP(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminPassword: "pw", AdminTOTPSecret: testSecret})
	s.now = func() time.Time { return base }

	post := func(user, pass, code string) *httptest.ResponseRecorder {
		form := url.Values{"username": {user}, "password": {pass}, "totp": {code}}
		r := httptest.NewRequest("POST", "/admin/login", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.RemoteAddr = "7.7.7.7:1111"
		w := httptest.NewRecorder()
		s.handleAdminLogin(w, r)
		return w
	}

	// good creds + good code -> 302 redirect with cookie
	w := post("admin", "pw", codeAt(t, base))
	if w.Code != http.StatusFound {
		t.Fatalf("valid login: want 302, got %d", w.Code)
	}
	if len(w.Result().Cookies()) == 0 {
		t.Fatal("valid login should set admin cookie")
	}

	// good creds + wrong code -> 401
	if w := post("admin", "pw", "000000"); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code: want 401, got %d", w.Code)
	}
}

func TestAdminLoginLockout(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	s.now = func() time.Time { return base }

	fail := func() *httptest.ResponseRecorder {
		form := url.Values{"username": {"admin"}, "password": {"wrong"}}
		r := httptest.NewRequest("POST", "/admin/login", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.RemoteAddr = "8.8.8.8:2222"
		w := httptest.NewRecorder()
		s.handleAdminLogin(w, r)
		return w
	}
	for i := 0; i < adminLoginMaxFails; i++ {
		if w := fail(); w.Code != http.StatusUnauthorized {
			t.Fatalf("fail %d: want 401, got %d", i, w.Code)
		}
	}
	if w := fail(); w.Code != http.StatusTooManyRequests {
		t.Fatalf("after threshold: want 429, got %d", w.Code)
	}
}
