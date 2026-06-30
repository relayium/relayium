package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newAdminServer(t *testing.T, pass string) *httptest.Server {
	t.Helper()
	store := newTestStore(t)
	// 种一个用户，列表里能看到。
	_, _ = store.UpsertUserByEmail(context.Background(), "seen@example.com", "Seen")
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, AdminPassword: pass,
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func TestAdminDisabledWhenNoPassword(t *testing.T) {
	ts := newAdminServer(t, "")
	resp, _ := ts.Client().Get(ts.URL + "/admin")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("admin off => /admin should 404, got %d", resp.StatusCode)
	}
}

func TestAdminLoginGate(t *testing.T) {
	ts := newAdminServer(t, "s3cret")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// 未登录 GET /admin => 登录表单，不含用户邮箱。
	resp, _ := client.Get(ts.URL + "/admin")
	if resp.StatusCode != http.StatusOK || !bodyContains(resp, "password") {
		t.Fatalf("unauth admin should show login form")
	}

	// 错误密码 => 不设 cookie。
	resp, _ = client.PostForm(ts.URL+"/admin/login", map[string][]string{"password": {"wrong"}})
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			t.Fatalf("wrong password must not set admin cookie")
		}
	}

	// 正确密码 => 设 cookie + 重定向。
	resp, _ = client.PostForm(ts.URL+"/admin/login", map[string][]string{"password": {"s3cret"}})
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
