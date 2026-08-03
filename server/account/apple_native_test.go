package account

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The native Sign in with Apple route.
//
// Every test here is about ONE rule: a bearer is minted only when the presented
// identity token AND the one-time authorization code both check out and both
// describe the same authorization. The failure cases therefore assert two
// things each — the status, and that nothing was minted — because a route that
// answered 401 while still creating a device row would pass a status-only test
// and hand out a credential anyway.

const (
	nativeAud  = "com.relayium.app" // the iOS Bundle ID: an APP audience
	webAud     = "com.relayium.web" // the Services ID: the browser flow's audience
	nativeSub  = "000123.abcdef.0001"
	nativeCode = "APPLE-ONE-TIME-CODE"
)

// appleNativeFixture is one configured service plus everything a test needs to
// mint tokens Apple would have minted.
type appleNativeFixture struct {
	svc   *Service
	store *SQLiteStore
	key   *rsa.PrivateKey
	// exchanges counts calls to the injected code exchange, so a test can prove
	// a refusal happened BEFORE the one-time code was spent.
	exchanges int
	mu        sync.Mutex
}

// newAppleNativeFixture builds a service whose aud allowlist holds both the app
// and the web client ids — the shipped shape, and the reason the native route
// has to refuse the web one itself.
func newAppleNativeFixture(t *testing.T) *appleNativeFixture {
	t.Helper()
	store := newTestStore(t)
	pemBytes, _ := genP8(t)
	priv, err := loadAppleP8(pemBytes)
	if err != nil {
		t.Fatalf("loadAppleP8: %v", err)
	}
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "https://relayium.test", SessionTTL: time.Hour,
		EnableApple: true, AppleClientIDs: []string{nativeAud, webAud},
		AppleServicesID: webAud, AppleTeamID: "TEAM123456", AppleKeyID: "KEY1234567",
		ApplePrivateKey: priv,
	})
	svc.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	svc.appleKey = func(_ context.Context, _ string) (*rsa.PublicKey, error) { return &key.PublicKey, nil }
	f := &appleNativeFixture{svc: svc, store: store, key: key}
	// Default: Apple answers the exchange with a token describing the same
	// authorization. Each test overrides what it is about.
	f.setExchange(func(_ context.Context, clientID, code string) (string, error) {
		if code != nativeCode {
			return "", errAppleCodeRejected
		}
		return f.token(t, map[string]any{"aud": clientID}), nil
	})
	return f
}

// setExchange installs the injected native exchange, counting every call.
func (f *appleNativeFixture) setExchange(fn func(ctx context.Context, clientID, code string) (string, error)) {
	f.svc.exchangeAppleNativeCode = func(ctx context.Context, clientID, code string) (string, error) {
		f.mu.Lock()
		f.exchanges++
		f.mu.Unlock()
		return fn(ctx, clientID, code)
	}
}

func (f *appleNativeFixture) exchangeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.exchanges
}

// token signs an Apple-shaped identity token, with `overrides` applied on top
// of a valid native claim set.
func (f *appleNativeFixture) token(t *testing.T, overrides map[string]any) string {
	t.Helper()
	claims := validAppleClaims(f.svc.now())
	claims["aud"] = nativeAud
	claims["sub"] = nativeSub
	claims["nonce"] = "NONCE-NATIVE"
	for k, v := range overrides {
		claims[k] = v
	}
	return signAppleJWT(t, f.key, map[string]any{"alg": "RS256", "kid": "k1"}, claims)
}

// post runs one native login request against the handler.
func (f *appleNativeFixture) post(body map[string]any) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/auth/apple/native", strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	f.svc.handleAppleNative(rec, req)
	return rec
}

// validBody is the request a correctly behaving app sends.
func (f *appleNativeFixture) validBody(t *testing.T) map[string]any {
	return map[string]any{
		"idToken": f.token(t, nil), "authorizationCode": nativeCode,
		"nonce": "NONCE-NATIVE", "name": "Ada Lovelace",
	}
}

// assertNoCredentialMinted is the assertion every failure case owes: no bearer
// in the body, and no device row anywhere in the store. The device is the
// stronger half — `issueBearer` writes one before the token, so a route that
// failed after minting would leave it behind even with an error body.
func (f *appleNativeFixture) assertNoCredentialMinted(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	var body struct {
		Token string `json:"token"`
	}
	// Decoded rather than substring-matched: the error codes themselves contain
	// "token" ("invalid_token", "token_mismatch"), so a text search would pass
	// for the wrong reason and keep passing if a bearer ever appeared beside one.
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Token != "" {
		t.Fatalf("a failed native login returned a bearer: %s", rec.Body.String())
	}
	ctx := context.Background()
	u, found, err := f.store.GetUserByIdentity(ctx, "apple", nativeSub)
	if err != nil {
		t.Fatalf("GetUserByIdentity: %v", err)
	}
	if !found {
		return // no account at all — nothing could have been minted for it
	}
	devices, err := f.store.ListDevices(ctx, u.ID)
	if err != nil {
		t.Fatalf("ListDevices: %v", err)
	}
	if len(devices) != 0 {
		t.Fatalf("a failed native login minted %d device(s)", len(devices))
	}
}

func TestAppleNative_HappyPath(t *testing.T) {
	f := newAppleNativeFixture(t)
	rec := f.post(f.validBody(t))

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Token string `json:"token"`
		User  struct {
			Email         string `json:"email"`
			DisplayName   string `json:"displayName"`
			EmailVerified bool   `json:"emailVerified"`
		} `json:"user"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.HasPrefix(out.Token, "rlm_cli_") {
		t.Fatalf("token = %q, want an rlm_cli_ bearer", out.Token)
	}
	if out.User.Email != "user@example.com" || out.User.DisplayName != "Ada Lovelace" {
		t.Fatalf("user = %+v", out.User)
	}
	if !out.User.EmailVerified {
		t.Error("Apple asserted a verified email; the account should be verified")
	}
	if f.exchangeCount() != 1 {
		t.Errorf("exchanges = %d, want exactly one redemption of the one-time code", f.exchangeCount())
	}
	u, found, err := f.store.GetUserByIdentity(context.Background(), "apple", nativeSub)
	if err != nil || !found {
		t.Fatalf("apple identity not linked: found=%v err=%v", found, err)
	}
	devices, err := f.store.ListDevices(context.Background(), u.ID)
	if err != nil || len(devices) != 1 {
		t.Fatalf("want exactly one device row, got %d (err=%v)", len(devices), err)
	}
	if devices[0].Name != "App (Apple)" {
		t.Errorf("device name = %q", devices[0].Name)
	}
}

// The whole point of the slice: no code, no bearer. The old route accepted a
// body without one and minted a bearer on the identity token alone.
func TestAppleNative_MissingAuthorizationCodeFailsClosed(t *testing.T) {
	f := newAppleNativeFixture(t)
	body := f.validBody(t)
	delete(body, "authorizationCode")

	rec := f.post(body)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body.String())
	}
	if f.exchangeCount() != 0 {
		t.Errorf("nothing should have been exchanged, got %d calls", f.exchangeCount())
	}
	f.assertNoCredentialMinted(t, rec)
}

// The other two required fields, for the same reason: an absent nonce would
// mean verifying a token bound to no attempt at all.
func TestAppleNative_MissingRequiredFieldsFailClosed(t *testing.T) {
	for _, field := range []string{"idToken", "nonce"} {
		t.Run(field, func(t *testing.T) {
			f := newAppleNativeFixture(t)
			body := f.validBody(t)
			body[field] = ""

			rec := f.post(body)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("want 400, got %d: %s", rec.Code, rec.Body.String())
			}
			if f.exchangeCount() != 0 {
				t.Errorf("nothing should have been exchanged, got %d calls", f.exchangeCount())
			}
			f.assertNoCredentialMinted(t, rec)
		})
	}
}

// A used, expired or forged code is Apple ANSWERING and refusing. 401, and no
// credential — this is the replay the exchange exists to stop.
func TestAppleNative_RejectedCodeMintsNothing(t *testing.T) {
	f := newAppleNativeFixture(t)
	f.setExchange(func(context.Context, string, string) (string, error) {
		return "", errAppleCodeRejected
	})

	rec := f.post(f.validBody(t))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := errorCode(t, rec); got != "invalid_code" {
		t.Errorf("error = %q, want invalid_code", got)
	}
	f.assertNoCredentialMinted(t, rec)
}

// An exchange that could not be COMPLETED is a different fact: the user's Apple
// ID is fine and a retry may work, so it must not be reported as a rejection —
// and it still mints nothing.
func TestAppleNative_UnreachableAppleIsNotARejection(t *testing.T) {
	f := newAppleNativeFixture(t)
	f.setExchange(func(context.Context, string, string) (string, error) {
		return "", errors.New("apple token status 503")
	})

	rec := f.post(f.validBody(t))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := errorCode(t, rec); got != "apple_unavailable" {
		t.Errorf("error = %q, want apple_unavailable", got)
	}
	f.assertNoCredentialMinted(t, rec)
}

// A WEB identity token verifies perfectly here — same issuer, same signing key,
// and the Services ID is in the same allowlist. Exchanging it through the
// native route would turn a browser authorization into a long-lived native
// bearer, so it is refused, and refused BEFORE the code is spent.
func TestAppleNative_WebAudienceIsRefusedBeforeTheExchange(t *testing.T) {
	f := newAppleNativeFixture(t)
	body := f.validBody(t)
	body["idToken"] = f.token(t, map[string]any{"aud": webAud})

	rec := f.post(body)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := errorCode(t, rec); got != "invalid_audience" {
		t.Errorf("error = %q, want invalid_audience", got)
	}
	if f.exchangeCount() != 0 {
		t.Errorf("the web audience must be refused before any code is redeemed, got %d calls",
			f.exchangeCount())
	}
	f.assertNoCredentialMinted(t, rec)
}

// The returned token must describe the SAME authorization. Each of these is a
// valid, correctly signed, unexpired Apple token — which is exactly why the
// comparison exists: signature verification alone cannot tell them apart from
// the right one.
func TestAppleNative_ExchangedTokenMustMatchThePresentedOne(t *testing.T) {
	cases := []struct {
		name      string
		overrides map[string]any
	}{
		{"different sub", map[string]any{"sub": "000999.somebody.else"}},
		{"different aud", map[string]any{"aud": webAud}},
		{"different nonce", map[string]any{"nonce": "SOMEBODY-ELSES-ATTEMPT"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppleNativeFixture(t)
			f.setExchange(func(context.Context, string, string) (string, error) {
				return f.token(t, tc.overrides), nil
			})

			rec := f.post(f.validBody(t))

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("want 401, got %d: %s", rec.Code, rec.Body.String())
			}
			if got := errorCode(t, rec); got != "token_mismatch" {
				t.Errorf("error = %q, want token_mismatch", got)
			}
			f.assertNoCredentialMinted(t, rec)
		})
	}
}

// A token whose nonce does not match the one this attempt generated is a token
// from somewhere else. Refused at the first verification, before the code.
func TestAppleNative_PresentedNonceMismatchIsRefused(t *testing.T) {
	f := newAppleNativeFixture(t)
	body := f.validBody(t)
	body["nonce"] = "A-DIFFERENT-ATTEMPT"

	rec := f.post(body)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := errorCode(t, rec); got != "invalid_token" {
		t.Errorf("error = %q, want invalid_token", got)
	}
	if f.exchangeCount() != 0 {
		t.Errorf("an unverified token must not spend a code, got %d calls", f.exchangeCount())
	}
	f.assertNoCredentialMinted(t, rec)
}

// A deployment with EnableApple but no .p8 cannot redeem a code at all. It says
// so, rather than examining a credential it could never finish checking.
func TestAppleNative_UnconfiguredDeploymentSaysSo(t *testing.T) {
	f := newAppleNativeFixture(t)
	f.svc.cfg.ApplePrivateKey = nil

	rec := f.post(f.validBody(t))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := errorCode(t, rec); got != "apple_not_configured" {
		t.Errorf("error = %q, want apple_not_configured", got)
	}
	f.assertNoCredentialMinted(t, rec)
}

// A pending-deletion account never gets a bearer, on this route as on every
// other. The code is spent by then, which is fine: the exchange proved the
// authorization, and it is the ACCOUNT that is frozen.
func TestAppleNative_PendingDeletionMintsNoBearer(t *testing.T) {
	f := newAppleNativeFixture(t)
	ctx := context.Background()
	u, err := f.store.UpsertUserByEmail(ctx, "user@example.com", "Ada")
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.LinkIdentity(ctx, "apple", nativeSub, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.store.SetAccountDeletion(ctx, u.ID, f.svc.now().Unix(),
		f.svc.now().Add(30*24*time.Hour).Unix()); err != nil {
		t.Fatalf("SetAccountDeletion: %v", err)
	}

	rec := f.post(f.validBody(t))

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 pending_deletion, got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Status          string `json:"status"`
		Token           string `json:"token"`
		ReactivateToken string `json:"reactivateToken"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Status != "pending_deletion" || out.Token != "" || out.ReactivateToken == "" {
		t.Fatalf("frozen account response = %+v", out)
	}
	devices, err := f.store.ListDevices(ctx, u.ID)
	if err != nil || len(devices) != 0 {
		t.Fatalf("a frozen account must gain no device, got %d (err=%v)", len(devices), err)
	}
}

// The client_secret is bound to the client redeeming the code: Apple checks
// `sub` against the client_id, so the Services ID secret cannot redeem an app
// authorization. One cached secret for both would do exactly that.
func TestAppleClientSecretIsPerClientID(t *testing.T) {
	pemBytes, _ := genP8(t)
	priv, err := loadAppleP8(pemBytes)
	if err != nil {
		t.Fatal(err)
	}
	fixed := time.Unix(1_700_000_000, 0)
	s := &Service{cfg: Config{
		AppleTeamID: "TEAM123456", AppleKeyID: "KEY1234567",
		AppleServicesID: webAud, ApplePrivateKey: priv,
	}, now: func() time.Time { return fixed }}

	web, err := s.appleClientSecret()
	if err != nil {
		t.Fatal(err)
	}
	app, err := s.appleClientSecretFor(nativeAud)
	if err != nil {
		t.Fatal(err)
	}
	if sub := jwtSubject(t, web); sub != webAud {
		t.Errorf("web client_secret sub = %q, want %q", sub, webAud)
	}
	if sub := jwtSubject(t, app); sub != nativeAud {
		t.Errorf("native client_secret sub = %q, want %q", sub, nativeAud)
	}
	// And each is cached under its own key rather than evicting the other.
	if again, _ := s.appleClientSecret(); again != web {
		t.Error("the web secret was not served from its own cache entry")
	}
	if again, _ := s.appleClientSecretFor(nativeAud); again != app {
		t.Error("the native secret was not served from its own cache entry")
	}
}

func TestAppleClientSecretRefusesAnUnconfiguredKey(t *testing.T) {
	s := &Service{cfg: Config{AppleTeamID: "T", AppleKeyID: "K"}, now: time.Now}
	if _, err := s.appleClientSecretFor(nativeAud); err == nil {
		t.Fatal("a nil .p8 key must be an error, not a signed secret")
	}
}

// errorCode reads the `error` field of a JSON error body.
func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not JSON: %s", rec.Body.String())
	}
	return body.Error
}

// jwtSubject decodes the `sub` claim of an unverified JWT — enough for a test
// that is about which client a secret was minted for.
func jwtSubject(t *testing.T, token string) string {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("want 3 JWT parts, got %d", len(parts))
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode claims: %v", err)
	}
	var claims struct {
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatalf("claims json: %v", err)
	}
	return claims.Sub
}
