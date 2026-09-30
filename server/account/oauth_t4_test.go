package account

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// expiredCookie reports whether the response expires the named cookie.
func expiredCookie(cookies []*http.Cookie, name string) bool {
	for _, c := range cookies {
		if c.Name == name && c.MaxAge < 0 && c.Value == "" && c.Path == "/" {
			return true
		}
	}
	return false
}

// A-L13: the OAuth state cookie is spent by the callback on every outcome.
func TestGoogleCallbackClearsStateCookie(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, EnableGoogle: true})
	svc.fetchGoogleUser = func(context.Context, string) (string, string, string, bool, error) {
		return "google-sub-t4", "t4@example.com", "T4", true, nil
	}
	for _, state := range []string{"s1", "evil"} {
		req := httptest.NewRequest("GET", "/api/auth/google/callback?code=abc&state="+state, nil)
		req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "s1"})
		rec := httptest.NewRecorder()
		svc.handleGoogleCallback(rec, req)
		if rec.Code != http.StatusFound {
			t.Fatalf("state %s: want 302, got %d", state, rec.Code)
		}
		if !expiredCookie(rec.Result().Cookies(), oauthStateCookie) {
			t.Fatalf("state %s: callback did not expire the state cookie: %v", state, rec.Header().Values("Set-Cookie"))
		}
	}
}

func appleWebT4Service(t *testing.T, claims map[string]any) (*Service, *SQLiteStore) {
	t.Helper()
	svc, store := newAppleWebTestService(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idToken := signAppleJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)
	svc.appleKey = func(context.Context, string) (*rsa.PublicKey, error) { return &key.PublicKey, nil }
	svc.exchangeAppleCode = func(context.Context, string) (string, error) { return idToken, nil }
	return svc, store
}

func appleWebT4Callback(svc *Service) *httptest.ResponseRecorder {
	form := url.Values{"code": {"CODE1"}, "state": {"STATE1"}}
	req := httptest.NewRequest("POST", "/api/auth/apple/web/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "STATE1"})
	req.AddCookie(&http.Cookie{Name: oauthNonceCookie, Value: "NONCE1"})
	rec := httptest.NewRecorder()
	svc.handleAppleWebCallback(rec, req)
	return rec
}

func TestAppleWebCallbackClearsStateAndNonceCookies(t *testing.T) {
	svc, _ := newAppleWebTestService(t)
	claims := validAppleClaims(svc.now())
	claims["aud"], claims["nonce"] = "com.relayium.web", "NONCE1"
	svc, _ = appleWebT4Service(t, claims)
	rec := appleWebT4Callback(svc)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/" {
		t.Fatalf("want 302 -> /, got %d -> %q", rec.Code, rec.Header().Get("Location"))
	}
	for _, name := range []string{oauthStateCookie, oauthNonceCookie} {
		if !expiredCookie(rec.Result().Cookies(), name) {
			t.Fatalf("callback did not expire %s: %v", name, rec.Header().Values("Set-Cookie"))
		}
	}
}

// A-L13: a first Apple sign-in whose email Apple did not verify must not be
// linked to the existing account that holds that address.
func TestAppleWebCallbackRefusesUnverifiedEmailLink(t *testing.T) {
	svc, _ := newAppleWebTestService(t)
	claims := validAppleClaims(svc.now())
	claims["aud"], claims["nonce"] = "com.relayium.web", "NONCE1"
	claims["email"], claims["email_verified"] = "victim@example.com", "false"
	svc, store := appleWebT4Service(t, claims)
	victim, err := store.UpsertUserByEmail(t.Context(), "victim@example.com", "Victim")
	if err != nil {
		t.Fatal(err)
	}
	rec := appleWebT4Callback(svc)
	if loc := rec.Header().Get("Location"); rec.Code != http.StatusFound || loc != "/?login=error" {
		t.Fatalf("want 302 -> /?login=error, got %d -> %q", rec.Code, loc)
	}
	if hasSessionCookie(rec.Result().Cookies()) {
		t.Fatal("unverified Apple email produced a session")
	}
	if u, found, _ := store.GetUserByIdentity(t.Context(), "apple", claims["sub"].(string)); found {
		t.Fatalf("unverified Apple email linked the Apple id to account %s (victim %s)", u.ID, victim.ID)
	}
}

func TestAppleNativeRefusesUnverifiedEmailLink(t *testing.T) {
	f := newAppleNativeFixture(t)
	victim, err := f.store.UpsertUserByEmail(t.Context(), "user@example.com", "Victim")
	if err != nil {
		t.Fatal(err)
	}
	body := f.validBody(t)
	body["idToken"] = f.token(t, map[string]any{"email_verified": "false"})
	rec := f.post(body)
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "email_not_verified" {
		t.Fatalf("want 400 email_not_verified, got %d: %s", rec.Code, rec.Body.String())
	}
	f.assertNoCredentialMinted(t, rec)
	if _, found, _ := f.store.GetUserByIdentity(t.Context(), "apple", nativeSub); found {
		t.Fatalf("unverified Apple email linked the Apple id to %s", victim.ID)
	}
	// Apple private-relay addresses arrive verified and still sign in.
	body["idToken"] = f.token(t, map[string]any{"email": "abc@privaterelay.appleid.com", "is_private_email": "true"})
	if rec := f.post(body); rec.Code != http.StatusOK {
		t.Fatalf("verified relay first sign-in: %d %s", rec.Code, rec.Body.String())
	}
}
