package account

import (
	"context"
	"net/http"
	"net/http/httptest"
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
