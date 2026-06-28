package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestGoogleCallbackCreatesSession(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: time.Minute,
		GoogleClientID: "cid", GoogleSecret: "sec", GoogleRedirect: "http://example.test/api/auth/google/callback",
	})
	svc.fetchGoogleUser = func(_ context.Context, code string) (string, string, string, bool, error) {
		return "google-sub-1", "Gmail@Example.com", "Gee", true, nil
	}
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// Simulate the state cookie the start handler would have set.
	req, _ := http.NewRequest("GET", ts.URL+"/api/auth/google/callback?code=abc&state=s1", nil)
	req.AddCookie(&http.Cookie{Name: "relayium_oauth_state", Value: "s1"})
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected redirect, got %d", resp.StatusCode)
	}
	hasSession := false
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			hasSession = true
		}
	}
	if !hasSession {
		t.Fatalf("no session cookie after google callback")
	}
	// User exists with normalized email.
	u, ok, _ := store.GetUserByIdentity(context.Background(), "google", "google-sub-1")
	if !ok || u.Email != "gmail@example.com" {
		t.Fatalf("identity not linked/normalized: ok=%v u=%+v", ok, u)
	}
}

func TestGoogleCallbackRejectsBadState(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{BaseURL: "http://example.test", SessionTTL: time.Hour})
	svc.fetchGoogleUser = func(context.Context, string) (string, string, string, bool, error) {
		return "s", "e@x.com", "n", true, nil
	}
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, _ := http.NewRequest("GET", ts.URL+"/api/auth/google/callback?code=abc&state=evil", nil)
	req.AddCookie(&http.Cookie{Name: "relayium_oauth_state", Value: "real"})
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected redirect, got %d", resp.StatusCode)
	}
	if hasSessionCookie(resp.Cookies()) {
		t.Fatalf("state mismatch must not create a session")
	}
}

func TestGoogleCallbackRejectsUnverifiedEmail(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{BaseURL: "http://example.test", SessionTTL: time.Hour})
	const unverifiedSub = "google-sub-unverified"
	svc.fetchGoogleUser = func(context.Context, string) (string, string, string, bool, error) {
		return unverifiedSub, "unverified@example.com", "Unverified User", false, nil
	}
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	req, _ := http.NewRequest("GET", ts.URL+"/api/auth/google/callback?code=abc&state=s2", nil)
	req.AddCookie(&http.Cookie{Name: "relayium_oauth_state", Value: "s2"})
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected redirect, got %d", resp.StatusCode)
	}
	if hasSessionCookie(resp.Cookies()) {
		t.Fatalf("unverified email must not create a session")
	}
	// No user or identity must have been created.
	_, ok, _ := store.GetUserByIdentity(context.Background(), "google", unverifiedSub)
	if ok {
		t.Fatalf("unverified email must not create an identity")
	}
}

func hasSessionCookie(cs []*http.Cookie) bool {
	for _, c := range cs {
		if c.Name == sessionCookie && c.Value != "" {
			return true
		}
	}
	return false
}
