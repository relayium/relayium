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

func newTestServer(t *testing.T) (*httptest.Server, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute})
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

func bodyContains(resp *http.Response, sub string) bool {
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	return strings.Contains(string(buf[:n]), sub)
}
