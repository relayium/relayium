package account

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// genP8 produces a PKCS#8 PEM block like Apple's downloadable .p8 key.
func genP8(t *testing.T) ([]byte, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), key
}

func TestLoadAppleP8(t *testing.T) {
	pemBytes, want := genP8(t)
	got, err := loadAppleP8(pemBytes)
	if err != nil {
		t.Fatalf("loadAppleP8: %v", err)
	}
	if got.D.Cmp(want.D) != 0 {
		t.Fatal("parsed key does not match original")
	}
}

func TestLoadAppleP8_Malformed(t *testing.T) {
	if _, err := loadAppleP8([]byte("not a pem")); err == nil {
		t.Fatal("expected error on malformed .p8")
	}
}

func TestAppleClientSecret(t *testing.T) {
	pemBytes, key := genP8(t)
	priv, _ := loadAppleP8(pemBytes)
	_ = pemBytes
	fixed := time.Unix(1_700_000_000, 0)
	s := &Service{cfg: Config{
		AppleTeamID: "TEAM123456", AppleKeyID: "KEY1234567",
		AppleServicesID: "com.relayium.web", ApplePrivateKey: priv,
	}, now: func() time.Time { return fixed }}

	tok, err := s.appleClientSecret()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("want 3 JWT parts, got %d", len(parts))
	}

	// Header: alg ES256, kid = KeyID.
	hdrJSON, _ := base64.RawURLEncoding.DecodeString(parts[0])
	var hdr struct{ Alg, Kid string }
	_ = json.Unmarshal(hdrJSON, &hdr)
	if hdr.Alg != "ES256" || hdr.Kid != "KEY1234567" {
		t.Fatalf("bad header %+v", hdr)
	}

	// Claims: iss=Team, sub=Services, aud=apple, exp>iat.
	clJSON, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var cl struct {
		Iss string `json:"iss"`
		Sub string `json:"sub"`
		Aud string `json:"aud"`
		Iat int64  `json:"iat"`
		Exp int64  `json:"exp"`
	}
	_ = json.Unmarshal(clJSON, &cl)
	if cl.Iss != "TEAM123456" || cl.Sub != "com.relayium.web" || cl.Aud != "https://appleid.apple.com" {
		t.Fatalf("bad claims %+v", cl)
	}
	if cl.Exp <= cl.Iat {
		t.Fatal("exp must be after iat")
	}

	// Signature: raw r||s (64 bytes), verifiable against the public key.
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if len(sig) != 64 {
		t.Fatalf("want 64-byte P1363 sig, got %d", len(sig))
	}
	digest := sha256Sum([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(sig[:32])
	sv := new(big.Int).SetBytes(sig[32:])
	if !ecdsaVerify(&key.PublicKey, digest, r, sv) {
		t.Fatal("signature does not verify")
	}
}

func sha256Sum(b []byte) []byte { h := sha256.Sum256(b); return h[:] }
func ecdsaVerify(pub *ecdsa.PublicKey, digest []byte, r, s *big.Int) bool {
	return ecdsa.Verify(pub, digest, r, s)
}

// newAppleWebTestService builds a Service backed by a real store, configured
// for the web Sign in with Apple flow, with a fixed clock (matching
// validAppleClaims' expectations from apple_test.go).
func newAppleWebTestService(t *testing.T) (*Service, *SQLiteStore) {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: time.Minute,
		EnableApple: true, AppleClientIDs: []string{"com.relayium.web"}, AppleServicesID: "com.relayium.web",
	})
	svc.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	return svc, store
}

func TestAppleWebCallback_HappyPath(t *testing.T) {
	svc, store := newAppleWebTestService(t)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := svc.now()
	claims := validAppleClaims(now)
	claims["aud"] = "com.relayium.web"
	claims["nonce"] = "NONCE1"
	idToken := signAppleJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)

	svc.appleKey = func(_ context.Context, kid string) (*rsa.PublicKey, error) {
		if kid != "k1" {
			return nil, errors.New("unknown kid")
		}
		return &key.PublicKey, nil
	}
	svc.exchangeAppleCode = func(_ context.Context, code string) (string, error) {
		if code != "CODE1" {
			return "", errors.New("bad code")
		}
		return idToken, nil
	}

	form := url.Values{"code": {"CODE1"}, "state": {"STATE1"},
		"user": {`{"name":{"firstName":"Ada","lastName":"Lovelace"}}`}}
	req := httptest.NewRequest("POST", "/api/auth/apple/web/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "STATE1"})
	req.AddCookie(&http.Cookie{Name: oauthNonceCookie, Value: "NONCE1"})
	rec := httptest.NewRecorder()

	svc.handleAppleWebCallback(rec, req)

	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/" {
		t.Fatalf("want 302 → /, got %d → %q", rec.Code, rec.Header().Get("Location"))
	}
	if !hasSessionCookie(rec.Result().Cookies()) {
		t.Fatal("expected a session cookie")
	}
	u, ok, err := store.GetUserByIdentity(context.Background(), "apple", claims["sub"].(string))
	if err != nil || !ok {
		t.Fatalf("apple identity not linked: ok=%v err=%v", ok, err)
	}
	if u.DisplayName != "Ada Lovelace" {
		t.Fatalf("display name = %q, want %q", u.DisplayName, "Ada Lovelace")
	}
	if v, _ := store.EmailVerified(context.Background(), u.ID); !v {
		t.Fatal("apple login should mark email verified")
	}
}

// clearPwFailStore wraps a Store and makes ClearPassword fail, to exercise the
// error path of dropUnverifiedPassword during an IdP login.
type clearPwFailStore struct {
	Store
}

func (c *clearPwFailStore) ClearPassword(ctx context.Context, userID string) error {
	return errors.New("injected ClearPassword failure")
}

// If dropUnverifiedPassword fails during an Apple web login, the account must NOT
// be flipped to verified — flipping it while an attacker's planted password
// survives is exactly the pre-hijack takeover. Verification is gated on the drop
// succeeding (mirrors the Google/oauth.go path).
func TestAppleWebCallback_VerifyGatedOnPasswordDrop(t *testing.T) {
	ctx := context.Background()

	// Seed a victim account with an attacker-planted, still-unverified password.
	seed, _ := newTestService(t)
	victim, err := seed.Register(ctx, "user@example.com", "attacker-planted-1", "V")
	if err != nil {
		t.Fatalf("seed register: %v", err)
	}

	// Service under test shares the seed's store but with ClearPassword failing.
	svc := NewService(&clearPwFailStore{Store: seed.store}, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: time.Minute,
		EnableApple: true, AppleClientIDs: []string{"com.relayium.web"}, AppleServicesID: "com.relayium.web",
	})
	svc.now = func() time.Time { return time.Unix(1_700_000_000, 0) }

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	claims := validAppleClaims(svc.now())
	claims["aud"] = "com.relayium.web"
	claims["nonce"] = "NONCE1"
	idToken := signAppleJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)
	svc.appleKey = func(_ context.Context, _ string) (*rsa.PublicKey, error) { return &key.PublicKey, nil }
	svc.exchangeAppleCode = func(_ context.Context, _ string) (string, error) { return idToken, nil }

	form := url.Values{"code": {"CODE1"}, "state": {"STATE1"}}
	req := httptest.NewRequest("POST", "/api/auth/apple/web/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "STATE1"})
	req.AddCookie(&http.Cookie{Name: oauthNonceCookie, Value: "NONCE1"})
	rec := httptest.NewRecorder()

	svc.handleAppleWebCallback(rec, req)

	// The login must fail (no session) rather than verify-and-admit.
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/?login=error" {
		t.Fatalf("want redirect to /?login=error, got %d → %q", rec.Code, rec.Header().Get("Location"))
	}
	if hasSessionCookie(rec.Result().Cookies()) {
		t.Fatal("failed password drop must not create a session")
	}
	// Critically: the account must remain UNverified so the planted password
	// cannot become a live login credential.
	if v, _ := seed.store.EmailVerified(ctx, victim.ID); v {
		t.Fatal("SECURITY: account marked verified despite failed password drop")
	}
}

func TestAppleWebStart_CookiesSameSiteNone(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "https://example.test", EnableApple: true,
		AppleServicesID: "com.relayium.web", AppleClientIDs: []string{"com.relayium.web"},
	})

	req := httptest.NewRequest("GET", "/api/auth/apple/web/start", nil)
	rec := httptest.NewRecorder()
	svc.handleAppleWebStart(rec, req)

	seen := map[string]*http.Cookie{}
	for _, c := range rec.Result().Cookies() {
		seen[c.Name] = c
	}
	for _, name := range []string{oauthStateCookie, oauthNonceCookie} {
		c, ok := seen[name]
		if !ok {
			t.Fatalf("missing %s cookie", name)
		}
		if c.SameSite != http.SameSiteNoneMode {
			t.Errorf("%s: SameSite = %v, want SameSiteNoneMode", name, c.SameSite)
		}
		if !c.Secure {
			t.Errorf("%s: Secure = false, want true (BaseURL is https)", name)
		}
		if !c.HttpOnly {
			t.Errorf("%s: HttpOnly = false, want true", name)
		}
	}
}

func TestAppleWebCallback_MissingNonceRejected(t *testing.T) {
	svc, _ := newAppleWebTestService(t)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := svc.now()
	claims := validAppleClaims(now)
	claims["aud"] = "com.relayium.web"
	claims["nonce"] = "NONCE1"
	idToken := signAppleJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)

	svc.appleKey = func(_ context.Context, kid string) (*rsa.PublicKey, error) {
		if kid != "k1" {
			return nil, errors.New("unknown kid")
		}
		return &key.PublicKey, nil
	}
	svc.exchangeAppleCode = func(_ context.Context, code string) (string, error) {
		if code != "CODE1" {
			return "", errors.New("bad code")
		}
		return idToken, nil
	}

	form := url.Values{"code": {"CODE1"}, "state": {"STATE1"}}
	req := httptest.NewRequest("POST", "/api/auth/apple/web/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "STATE1"})
	// Deliberately no oauthNonceCookie.
	rec := httptest.NewRecorder()

	svc.handleAppleWebCallback(rec, req)

	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/?login=error" {
		t.Fatalf("want redirect to /?login=error, got %d → %q", rec.Code, rec.Header().Get("Location"))
	}
	if hasSessionCookie(rec.Result().Cookies()) {
		t.Fatal("missing nonce cookie must not create a session")
	}
}

func TestAppleWebCallback_StateMismatch(t *testing.T) {
	svc, _ := newAppleWebTestService(t)
	form := url.Values{"code": {"CODE1"}, "state": {"WRONG"}}
	req := httptest.NewRequest("POST", "/api/auth/apple/web/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "STATE1"})
	rec := httptest.NewRecorder()
	svc.handleAppleWebCallback(rec, req)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/?login=error" {
		t.Fatalf("want redirect to /?login=error, got %d → %q", rec.Code, rec.Header().Get("Location"))
	}
	if hasSessionCookie(rec.Result().Cookies()) {
		t.Fatal("state mismatch must not create a session")
	}
}
