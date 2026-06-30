package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func newTestServer(t *testing.T) (*httptest.Server, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute, TransferTTL: time.Hour, EnableMagic: true})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, mail
}

func TestMagicRequestAlwaysOKAndLoginFlow(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()
	// Disable redirect following so we can inspect Set-Cookie on the verify 302.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// Request returns 200 even for a brand-new email (no enumeration).
	resp, err := client.PostForm(ts.URL+"/api/auth/magic/request", url.Values{"email": {"x@example.com"}})
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("request: %v status=%v", err, resp.StatusCode)
	}
	// Pull the token from the captured link and hit verify.
	i := strings.Index(mail.lastLink, "token=")
	token := mail.lastLink[i+len("token="):]
	resp, err = client.Get(ts.URL + "/api/auth/magic/verify?token=" + token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("verify should redirect, got %d", resp.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value == "" {
		t.Fatalf("no session cookie set")
	}

	// /api/me with the cookie returns the user.
	req, _ := http.NewRequest("GET", ts.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/api/me should be 200 with cookie, got %d", resp.StatusCode)
	}

	// Logout revokes; /api/me then 401s.
	req, _ = http.NewRequest("POST", ts.URL+"/api/auth/logout", nil)
	req.AddCookie(cookie)
	_, _ = client.Do(req)
	req, _ = http.NewRequest("GET", ts.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/api/me after logout should be 401, got %d", resp.StatusCode)
	}
}

func TestCookieSecureDerivedFromBaseURL(t *testing.T) {
	cases := []struct {
		baseURL string
		want    bool
	}{
		{"https://relayium.app", true},
		{"https://example.test:8443", true},
		{"http://localhost:8080", false},
		{"http://127.0.0.1:8080", false},
		{"", false},
	}
	for _, c := range cases {
		svc := &Service{cfg: Config{BaseURL: c.baseURL}}
		if got := svc.cookieSecure(); got != c.want {
			t.Errorf("cookieSecure(%q) = %v, want %v", c.baseURL, got, c.want)
		}
	}
}

// placeholder to ensure context import is used if the file is trimmed during edits
var _ = context.Background

func TestDeviceCRUDOverHTTP(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// Log in via magic link to get a cookie.
	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", url.Values{"email": {"dev@example.com"}})
	i := strings.Index(mail.lastLink, "token=")
	resp, _ := client.Get(ts.URL + "/api/auth/magic/verify?token=" + mail.lastLink[i+len("token="):])
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}

	// Register a device.
	body := strings.NewReader(`{"id":"devA","name":"Laptop"}`)
	req, _ := http.NewRequest("POST", ts.URL+"/api/devices", body)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register device: %d", resp.StatusCode)
	}

	// List shows it.
	req, _ = http.NewRequest("GET", ts.URL+"/api/devices", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusOK || !bodyContains(resp, "Laptop") {
		t.Fatalf("list device missing Laptop")
	}

	// Unauthenticated list is 401.
	resp, _ = client.Get(ts.URL + "/api/devices")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth devices should be 401, got %d", resp.StatusCode)
	}

	// Delete it.
	req, _ = http.NewRequest("DELETE", ts.URL+"/api/devices/devA", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete device: %d", resp.StatusCode)
	}
}

func TestUsageEndpointRequiresSessionAndReturnsTotal(t *testing.T) {
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute, TransferTTL: time.Hour, EnableMagic: true})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// No session → 401.
	resp, err := client.Get(ts.URL + "/api/usage")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no session should be 401, got %d", resp.StatusCode)
	}

	// Log in via magic link → cookie + a known user.
	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", url.Values{"email": {"u@example.com"}})
	i := strings.Index(mail.lastLink, "token=")
	verify, _ := client.Get(ts.URL + "/api/auth/magic/verify?token=" + mail.lastLink[i+len("token="):])
	var cookie *http.Cookie
	for _, c := range verify.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("no session cookie")
	}
	u, _ := store.UpsertUserByEmail(context.Background(), "u@example.com", "")
	_ = store.RecordUsage(context.Background(), UsageEvent{AllocID: "a", Token: "t", UserID: u.ID, RelayedBytes: 500, RecordedAt: 1})

	req, _ := http.NewRequest("GET", ts.URL+"/api/usage", nil)
	req.AddCookie(cookie)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("usage: err=%v status=%v", err, resp.StatusCode)
	}
	var out struct {
		RelayedBytes int64 `json:"relayedBytes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.RelayedBytes != 500 {
		t.Fatalf("relayedBytes = %d, want 500", out.RelayedBytes)
	}
}

func bodyContains(resp *http.Response, sub string) bool {
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	return strings.Contains(string(buf[:n]), sub)
}

func TestPasswordRegisterLoginAndMethods(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		EnableGoogle: false, EnableMagic: false,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// methods 反映开关：password 恒 true，google/magic 关。
	resp, _ := client.Get(ts.URL + "/api/auth/methods")
	var m struct{ Password, Google, Magic bool }
	_ = json.NewDecoder(resp.Body).Decode(&m)
	if !m.Password || m.Google || m.Magic {
		t.Fatalf("methods = %+v, want password-only", m)
	}

	// magic 关闭 => 路由不存在（404）。
	resp, _ = client.Post(ts.URL+"/api/auth/magic/request", "application/x-www-form-urlencoded", strings.NewReader("email=x@example.com"))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("disabled magic should 404, got %d", resp.StatusCode)
	}

	// 注册成功 => 200 + session cookie。
	resp, _ = client.Post(ts.URL+"/api/auth/register", "application/json",
		strings.NewReader(`{"email":"u@example.com","password":"longenough1"}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register: %d", resp.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("register set no session cookie")
	}

	// 重复注册 => 409。
	resp, _ = client.Post(ts.URL+"/api/auth/register", "application/json",
		strings.NewReader(`{"email":"u@example.com","password":"longenough2"}`))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate register: want 409, got %d", resp.StatusCode)
	}

	// 密码过短 => 400。
	resp, _ = client.Post(ts.URL+"/api/auth/register", "application/json",
		strings.NewReader(`{"email":"v@example.com","password":"short"}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("weak password: want 400, got %d", resp.StatusCode)
	}

	// 正确密码登录 => 200；错误密码 => 401。
	resp, _ = client.Post(ts.URL+"/api/auth/password/login", "application/json",
		strings.NewReader(`{"email":"u@example.com","password":"longenough1"}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login: %d", resp.StatusCode)
	}
	resp, _ = client.Post(ts.URL+"/api/auth/password/login", "application/json",
		strings.NewReader(`{"email":"u@example.com","password":"nope"}`))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad login: want 401, got %d", resp.StatusCode)
	}
}

func TestMethodsReflectsEnabledFlags(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{
		BaseURL: "http://example.test", EnableGoogle: true, EnableMagic: true,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	resp, _ := ts.Client().Get(ts.URL + "/api/auth/methods")
	var m struct{ Password, Google, Magic bool }
	_ = json.NewDecoder(resp.Body).Decode(&m)
	if !(m.Password && m.Google && m.Magic) {
		t.Fatalf("all enabled: methods = %+v", m)
	}
}

func TestCreateTransferRequiresSessionAndReturnsToken(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// Without a session cookie → 401.
	resp, err := client.Post(ts.URL+"/api/transfers", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no session should be 401, got %d", resp.StatusCode)
	}

	// Log in via magic link to get a session cookie.
	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", url.Values{"email": {"u@example.com"}})
	i := strings.Index(mail.lastLink, "token=")
	verify, _ := client.Get(ts.URL + "/api/auth/magic/verify?token=" + mail.lastLink[i+len("token="):])
	var cookie *http.Cookie
	for _, c := range verify.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("no session cookie from verify")
	}

	// With the session → 200 + a non-empty token.
	req, _ := http.NewRequest("POST", ts.URL+"/api/transfers", nil)
	req.AddCookie(cookie)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("create: err=%v status=%v", err, resp.StatusCode)
	}
	var out struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Token == "" || out.ExpiresAt == 0 {
		t.Fatalf("expected token+expiresAt, got %+v", out)
	}
}
