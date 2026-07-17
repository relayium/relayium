# Sign in with Apple (Web + Native Activation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant Sign in with Apple support — ship the new web ("Sign in with Apple" button on relayium.com) flow alongside the already-built native flow, all in one PR, gated by `EnableApple` so it turns on by configuration alone.

**Architecture:** Mirror the existing Google web OAuth flow (`server/internal/account/oauth.go`). The one Apple-specific twist is the OAuth `client_secret`: it is a short-lived ES256 JWT signed with a `.p8` EC key, generated on the server. The returned `id_token` is verified by the existing `verifyAppleIDToken`. Account resolution, frozen-account guard, and session issuance reuse the exact patterns already in `handleGoogleCallback` / `handleAppleNative`.

**Tech Stack:** Go (`crypto/ecdsa`, `crypto/x509`, `crypto/sha256`, `encoding/base64`, `net/http`, `golang.org/x/oauth2`), Svelte 5 (runes), existing i18n system (9 locales).

## Global Constraints

- **No secrets or real identifiers in the repo or in code.** All Apple config is read from env vars / file paths, exactly like `RELAYIUM_APPLE_*` and `RELAYIUM_GOOGLE_*` today. The `.p8` lives only on the production host, referenced by a file-path env var.
- **`client_secret` signature is ES256 in JOSE raw `r||s` (P1363, 64 bytes) — NOT ASN.1 DER.** `crypto/ecdsa.Sign` returns two big.Ints; encode each left-padded to 32 bytes.
- **No new JWT dependency.** Sign the client_secret by hand (~30 lines), consistent with the existing hand-written Apple JWT *verification* in `apple.go`.
- **`response_mode=form_post`** — because we request `scope="name email"`, Apple returns the callback as a POST form. The callback must therefore be exempted from `csrfGuard` (which rejects cross-origin POSTs); the `state` cookie is its CSRF defense.
- **Web routes register only when fully configured** (`EnableApple` AND `AppleServicesID`, `AppleTeamID`, `AppleKeyID`, and a parsed `ApplePrivateKey` all present). Native routes register on `EnableApple` alone (unchanged).
- **Fail-fast:** if `EnableApple` + `AppleServicesID` are set but the `.p8` file is missing/unparseable, `main.go` logs and exits — never boot a broken login button.
- Run `gofmt`, `go test ./...`, `go vet ./...` before every server commit; `npm run check` (svelte-check) + `npm test` before every web commit.
- i18n: any new UI string is added to **all 9** locale files (`en, zh, de, fr, ja, ko, es, pt, ar`) and to `types.ts`. Missing a locale fails `validateLangs`/build.

## File Structure

- `server/internal/account/service.go` — add web Apple config fields to `Config`; add `applePrivateKey`/`exchangeAppleCode` service fields + default wiring (modify).
- `server/main.go` — add `RELAYIUM_APPLE_*` flags/env, load & parse `.p8` fail-fast, derive `AppleRedirect`, register the domain-association well-known route (modify).
- `server/internal/account/apple_web.go` — **new**: `appleClientSecret`, `handleAppleWebStart`, `handleAppleWebCallback`, `realExchangeAppleCode`, `loadAppleP8`.
- `server/internal/account/apple_web_test.go` — **new**: client_secret + callback tests.
- `server/internal/account/handlers.go` — register web routes (gated); exempt the callback path in `csrfGuard` (modify).
- `server/wellknown.go` — add `appleDomainAssociation` handler (modify).
- `web/src/lib/auth.svelte.ts` — add `appleLoginUrl()`, `apple` to `AuthMethods` + default (modify).
- `web/src/lib/Account.svelte` — render the Apple button (modify).
- `web/src/lib/i18n/*.ts` (×9) + `types.ts` — add `continueApple` (modify).
- `docs/deploy/apple-signin.md` — **new**: operator setup (env vars, portal steps, file placement).

---

### Task 1: Apple web config + `.p8` loading (fail-fast)

**Files:**
- Modify: `server/internal/account/service.go` (Config struct + Service fields + NewService defaults)
- Create: `server/internal/account/apple_web.go` (add `loadAppleP8`)
- Create: `server/internal/account/apple_web_test.go`
- Modify: `server/main.go` (flags/env, parse, derive redirect)

**Interfaces:**
- Produces: `Config.AppleServicesID string`, `Config.AppleTeamID string`, `Config.AppleKeyID string`, `Config.AppleRedirect string`, `Config.ApplePrivateKey *ecdsa.PrivateKey`, `Config.AppleDomainAssocFile string`.
- Produces: `loadAppleP8(pemBytes []byte) (*ecdsa.PrivateKey, error)` — parses a PKCS#8 EC private key from `.p8` PEM.
- Produces: service field `appleWebConfigured() bool` (true when Services ID + Team ID + Key ID + ApplePrivateKey all set).

- [ ] **Step 1: Write the failing test for `.p8` parsing**

Create `server/internal/account/apple_web_test.go`:

```go
package account

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestLoadAppleP8 -v`
Expected: FAIL — `undefined: loadAppleP8`.

- [ ] **Step 3: Implement `loadAppleP8` in a new `apple_web.go`**

Create `server/internal/account/apple_web.go`:

```go
package account

import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
)

// loadAppleP8 parses Apple's downloadable Sign in with Apple key (.p8), a
// PKCS#8-wrapped EC P-256 private key, into an *ecdsa.PrivateKey used to sign
// the OAuth client_secret JWT.
func loadAppleP8(pemBytes []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("apple: .p8 is not valid PEM")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	ec, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("apple: .p8 is not an EC private key")
	}
	return ec, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run TestLoadAppleP8 -v`
Expected: PASS (both cases).

- [ ] **Step 5: Add config fields + service helper**

In `server/internal/account/service.go`, add to the `Config` struct near the existing Apple fields:

```go
	// Web Sign in with Apple. Distinct from the native flow: the browser button
	// runs the OAuth code flow, so the server needs the Services ID (web
	// client_id / aud) plus the .p8 signing key to mint the client_secret JWT.
	AppleServicesID      string           // web client_id; also belongs in AppleClientIDs
	AppleTeamID          string           // client_secret `iss`
	AppleKeyID           string           // .p8 Key ID; client_secret JWT header `kid`
	AppleRedirect        string           // derived: BaseURL + /api/auth/apple/web/callback
	ApplePrivateKey      *ecdsa.PrivateKey // parsed .p8; nil when web SiwA is off
	AppleDomainAssocFile string           // path to apple-developer-domain-association.txt
```

Add the `ecdsa` import to `service.go`. Add a service field near `fetchGoogleUser`:

```go
	exchangeAppleCode func(ctx context.Context, code string) (idToken string, err error)
```

In `NewService`, after `svc.fetchGoogleUser = svc.realFetchGoogleUser`:

```go
	svc.exchangeAppleCode = svc.realExchangeAppleCode
```

Add the helper method in `apple_web.go`:

```go
// appleWebConfigured reports whether every piece needed for the browser
// Sign in with Apple flow is present. Web routes stay unregistered otherwise so
// a half-configured deploy never exposes a 500-ing button.
func (s *Service) appleWebConfigured() bool {
	return s.cfg.AppleServicesID != "" && s.cfg.AppleTeamID != "" &&
		s.cfg.AppleKeyID != "" && s.cfg.ApplePrivateKey != nil
}
```

(`realExchangeAppleCode` is implemented in Task 3; add a temporary stub now so the package compiles:)

```go
func (s *Service) realExchangeAppleCode(ctx context.Context, code string) (string, error) {
	return "", errors.New("not implemented")
}
```

- [ ] **Step 6: Wire flags/env + fail-fast parse in `main.go`**

In `server/main.go`, next to the existing `apple-client-ids` flag, add:

```go
	appleServicesID := flag.String("apple-services-id", envStr("RELAYIUM_APPLE_SERVICES_ID", ""), "Apple Services ID (web Sign in with Apple client_id)")
	appleTeamID := flag.String("apple-team-id", envStr("RELAYIUM_APPLE_TEAM_ID", ""), "Apple Team ID (client_secret issuer)")
	appleKeyID := flag.String("apple-key-id", envStr("RELAYIUM_APPLE_KEY_ID", ""), "Apple .p8 Key ID (client_secret JWT kid)")
	applePrivKeyFile := flag.String("apple-private-key-file", envStr("RELAYIUM_APPLE_PRIVATE_KEY_FILE", ""), "path to the Apple Sign in with Apple .p8 private key")
	appleDomainAssoc := flag.String("apple-domain-assoc-file", envStr("RELAYIUM_APPLE_DOMAIN_ASSOC_FILE", ""), "path to apple-developer-domain-association.txt")
```

After flags are parsed and before `account.NewService`, parse the key fail-fast:

```go
	var applePrivKey *ecdsa.PrivateKey
	if *applePrivKeyFile != "" {
		raw, err := os.ReadFile(*applePrivKeyFile)
		if err != nil {
			log.Fatalf("apple: reading private key file %q: %v", *applePrivKeyFile, err)
		}
		applePrivKey, err = account.LoadApplePrivateKey(raw)
		if err != nil {
			log.Fatalf("apple: parsing private key %q: %v", *applePrivKeyFile, err)
		}
	}
	if *enableApple && *appleServicesID != "" && applePrivKey == nil {
		log.Fatal("apple: web Sign in with Apple requires RELAYIUM_APPLE_PRIVATE_KEY_FILE")
	}
```

Export a thin wrapper so `main` can call the parser (add to `apple_web.go`):

```go
// LoadApplePrivateKey parses a .p8 EC private key for main() to fail-fast at boot.
func LoadApplePrivateKey(pemBytes []byte) (*ecdsa.PrivateKey, error) { return loadAppleP8(pemBytes) }
```

Add the fields to the `account.Config{…}` literal:

```go
			AppleServicesID:      *appleServicesID,
			AppleTeamID:          *appleTeamID,
			AppleKeyID:           *appleKeyID,
			AppleRedirect:        *baseURL + "/api/auth/apple/web/callback",
			ApplePrivateKey:      applePrivKey,
			AppleDomainAssocFile: *appleDomainAssoc,
```

Add `crypto/ecdsa` and confirm `os`/`log` are imported in `main.go`.

- [ ] **Step 7: Verify build + tests**

Run: `go build ./... && go test ./internal/account/ -run TestLoadAppleP8 -v`
Expected: build OK, tests PASS.

- [ ] **Step 8: Commit**

```bash
git add server/internal/account/service.go server/internal/account/apple_web.go server/internal/account/apple_web_test.go server/main.go
git commit -m "feat(auth): apple web config + .p8 loading (fail-fast)"
```

---

### Task 2: `appleClientSecret()` — ES256 client_secret JWT

**Files:**
- Modify: `server/internal/account/apple_web.go`
- Modify: `server/internal/account/apple_web_test.go`

**Interfaces:**
- Consumes: `Config.ApplePrivateKey`, `AppleTeamID`, `AppleKeyID`, `AppleServicesID`; `s.now()`.
- Produces: `func (s *Service) appleClientSecret() (string, error)` — a signed ES256 JWT, cached and regenerated near expiry.

- [ ] **Step 1: Write the failing test**

Add to `apple_web_test.go`:

```go
import (
	"crypto"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"time"
)

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
```

Add the two tiny test helpers at the bottom of the test file:

```go
func sha256Sum(b []byte) []byte { h := sha256.Sum256(b); return h[:] }
func ecdsaVerify(pub *ecdsa.PublicKey, digest []byte, r, s *big.Int) bool {
	return ecdsa.Verify(pub, digest, r, s)
}
```

Add imports `crypto/sha256` to the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestAppleClientSecret -v`
Expected: FAIL — `s.appleClientSecret undefined`.

- [ ] **Step 3: Implement `appleClientSecret` with caching**

In `apple_web.go` add imports (`crypto/ecdsa`, `crypto/rand`, `crypto/sha256`, `encoding/base64`, `encoding/json`, `sync`, `time`) and:

```go
// appleSecretTTL is how long a minted client_secret is trusted before we resign.
// Apple caps client_secret exp at 6 months; a short window keeps blast radius
// small and resigning is nanoseconds.
const appleSecretTTL = 30 * time.Minute

// appleClientSecret returns an ES256 JWT proving control of the Services ID,
// used as the OAuth client_secret in the code exchange. Cached until shortly
// before expiry.
func (s *Service) appleClientSecret() (string, error) {
	now := s.now()
	s.appleSecMu.Lock()
	defer s.appleSecMu.Unlock()
	if s.appleSecTok != "" && now.Before(s.appleSecExp.Add(-2*time.Minute)) {
		return s.appleSecTok, nil
	}
	exp := now.Add(appleSecretTTL)
	header := map[string]string{"alg": "ES256", "kid": s.cfg.AppleKeyID}
	claims := map[string]any{
		"iss": s.cfg.AppleTeamID,
		"iat": now.Unix(),
		"exp": exp.Unix(),
		"aud": appleIssuer, // "https://appleid.apple.com"
		"sub": s.cfg.AppleServicesID,
	}
	hb, _ := json.Marshal(header)
	cb, _ := json.Marshal(claims)
	signingInput := b64url(hb) + "." + b64url(cb)
	digest := sha256.Sum256([]byte(signingInput))
	r, ss, err := ecdsa.Sign(rand.Reader, s.cfg.ApplePrivateKey, digest[:])
	if err != nil {
		return "", err
	}
	// JOSE ES256 wants the fixed-width r||s concatenation, not ASN.1 DER.
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	ss.FillBytes(sig[32:])
	tok := signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
	s.appleSecTok, s.appleSecExp = tok, exp
	return tok, nil
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
```

Add the cache fields to the `Service` struct in `service.go`:

```go
	appleSecMu  sync.Mutex
	appleSecTok string
	appleSecExp time.Time
```

(`appleIssuer` already exists in `apple.go`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run TestAppleClientSecret -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/apple_web.go server/internal/account/apple_web_test.go server/internal/account/service.go
git commit -m "feat(auth): ES256 apple client_secret JWT with caching"
```

---

### Task 3: Web start + callback handlers + code exchange

**Files:**
- Modify: `server/internal/account/apple_web.go`
- Modify: `server/internal/account/apple_web_test.go`
- Modify: `server/internal/account/handlers.go` (route registration + csrf exemption)

**Interfaces:**
- Consumes: `appleClientSecret`, `verifyAppleIDToken`, `s.store.GetUserByIdentity/UpsertUserByEmail/LinkIdentity/SetEmailVerified`, `s.IssueSession`, `s.setSessionCookie`, `s.issueReactivateToken`, `oauthStateCookie`, `randToken()`.
- Produces: `handleAppleWebStart(w, r)`, `handleAppleWebCallback(w, r)`, `realExchangeAppleCode(ctx, code) (idToken string, err error)`. New cookie const `oauthNonceCookie = "relayium_oauth_nonce"`.

- [ ] **Step 1: Write the failing callback test (state guard + happy path + frozen)**

Add to `apple_web_test.go`. This injects `exchangeAppleCode` (no network) and `appleKey` (so `verifyAppleIDToken` accepts our test token), mirroring how Google tests inject `fetchGoogleUser`.

```go
import (
	"net/http"
	"net/http/httptest"
	"net/url"
)

// signTestIDToken builds an RS256 Apple-style id_token our verifier will accept.
// (Reuse the existing test helper from apple_test.go if present; otherwise this
// mirrors it.) It returns the compact token and installs the matching public key
// via s.appleKey.
func TestAppleWebCallback_HappyPath(t *testing.T) {
	s, store := newTestService(t) // existing helper used across account tests
	s.cfg.EnableApple = true
	s.cfg.AppleClientIDs = []string{"com.relayium.web"}
	s.cfg.AppleServicesID = "com.relayium.web"

	idToken, kid, pub := makeAppleIDToken(t, appleTokClaims{
		Aud: "com.relayium.web", Sub: "apple-sub-1",
		Email: "user@example.com", EmailVerified: true, Nonce: "NONCE1",
		Exp: s.now().Add(time.Hour).Unix(),
	})
	s.appleKey = func(_ context.Context, k string) (*rsa.PublicKey, error) {
		if k != kid {
			return nil, errors.New("unknown kid")
		}
		return pub, nil
	}
	s.exchangeAppleCode = func(_ context.Context, code string) (string, error) {
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

	s.handleAppleWebCallback(rec, req)

	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/" {
		t.Fatalf("want 302 → /, got %d → %q", rec.Code, rec.Header().Get("Location"))
	}
	if !hasSessionCookie(rec) { // existing test helper
		t.Fatal("expected a session cookie")
	}
	if _, ok, _ := store.GetUserByIdentity(context.Background(), "apple", "apple-sub-1"); !ok {
		t.Fatal("apple identity not linked")
	}
}

func TestAppleWebCallback_StateMismatch(t *testing.T) {
	s, _ := newTestService(t)
	form := url.Values{"code": {"CODE1"}, "state": {"WRONG"}}
	req := httptest.NewRequest("POST", "/api/auth/apple/web/callback", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "STATE1"})
	rec := httptest.NewRecorder()
	s.handleAppleWebCallback(rec, req)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/?login=error" {
		t.Fatalf("want redirect to /?login=error, got %d → %q", rec.Code, rec.Header().Get("Location"))
	}
}
```

> Note: `newTestService`, `hasSessionCookie`, and an Apple-token builder already exist in the account test suite (`apple_test.go` / `handlers_test.go`). Reuse them; do not duplicate. If the token builder is named differently, adapt `makeAppleIDToken`/`appleTokClaims` to the existing helper's signature rather than adding a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestAppleWebCallback -v`
Expected: FAIL — `s.handleAppleWebCallback undefined` (and/or `oauthNonceCookie undefined`).

- [ ] **Step 3: Implement start, callback, and real exchange**

Replace the stub `realExchangeAppleCode` in `apple_web.go` and add the handlers:

```go
const oauthNonceCookie = "relayium_oauth_nonce"

const appleAuthURL = "https://appleid.apple.com/auth/authorize"
const appleTokenURL = "https://appleid.apple.com/auth/token"

func (s *Service) handleAppleWebStart(w http.ResponseWriter, r *http.Request) {
	state, nonce := randToken(), randToken()
	for _, c := range []struct{ name, val string }{
		{oauthStateCookie, state}, {oauthNonceCookie, nonce},
	} {
		http.SetCookie(w, &http.Cookie{
			Name: c.name, Value: c.val, Path: "/", MaxAge: 600,
			HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		})
	}
	q := url.Values{
		"response_type": {"code"},
		"response_mode": {"form_post"}, // required with name/email scope
		"client_id":     {s.cfg.AppleServicesID},
		"redirect_uri":  {s.cfg.AppleRedirect},
		"scope":         {"name email"},
		"state":         {state},
		"nonce":         {nonce},
	}
	http.Redirect(w, r, appleAuthURL+"?"+q.Encode(), http.StatusFound)
}

func (s *Service) handleAppleWebCallback(w http.ResponseWriter, r *http.Request) {
	fail := func() { http.Redirect(w, r, "/?login=error", http.StatusFound) }
	if err := r.ParseForm(); err != nil {
		fail()
		return
	}
	sc, err := r.Cookie(oauthStateCookie)
	if err != nil || sc.Value == "" || sc.Value != r.FormValue("state") {
		fail()
		return
	}
	nonce := ""
	if nc, err := r.Cookie(oauthNonceCookie); err == nil {
		nonce = nc.Value
	}
	idToken, err := s.exchangeAppleCode(r.Context(), r.FormValue("code"))
	if err != nil {
		fail()
		return
	}
	claims, err := s.verifyAppleIDToken(r.Context(), idToken, nonce)
	if err != nil {
		fail()
		return
	}

	u, found, err := s.store.GetUserByIdentity(r.Context(), "apple", claims.Sub)
	if err != nil {
		fail()
		return
	}
	if !found {
		if claims.Email == "" {
			fail()
			return
		}
		u, err = s.store.UpsertUserByEmail(r.Context(), claims.Email, appleNameFromForm(r.FormValue("user")))
		if err != nil {
			fail()
			return
		}
	}
	// Frozen-account guard: pending-deletion accounts never get a live session.
	if u.DeletedAt > 0 {
		raw, terr := s.issueReactivateToken(r.Context(), u.ID, u.Email)
		if terr != nil {
			fail()
			return
		}
		http.Redirect(w, r, "/?account=pending_deletion&token="+url.QueryEscape(raw), http.StatusFound)
		return
	}
	if err := s.store.LinkIdentity(r.Context(), "apple", claims.Sub, u.ID); err != nil {
		fail()
		return
	}
	if claims.EmailVerified {
		_ = s.store.SetEmailVerified(r.Context(), u.ID)
	}
	sess, err := s.IssueSession(r.Context(), u.ID)
	if err != nil {
		fail()
		return
	}
	s.setSessionCookie(w, sess)
	http.Redirect(w, r, "/", http.StatusFound)
}

// appleNameFromForm pulls a display name out of Apple's first-authorization
// `user` field (JSON), which carries the name Apple only ever sends once.
func appleNameFromForm(raw string) string {
	if raw == "" {
		return ""
	}
	var u struct {
		Name struct {
			FirstName string `json:"firstName"`
			LastName  string `json:"lastName"`
		} `json:"name"`
	}
	if json.Unmarshal([]byte(raw), &u) != nil {
		return ""
	}
	return strings.TrimSpace(u.Name.FirstName + " " + u.Name.LastName)
}

// realExchangeAppleCode swaps the authorization code for tokens at Apple's token
// endpoint, authenticating with a freshly minted client_secret, and returns the
// id_token for verification.
func (s *Service) realExchangeAppleCode(ctx context.Context, code string) (string, error) {
	secret, err := s.appleClientSecret()
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {s.cfg.AppleRedirect},
		"client_id":     {s.cfg.AppleServicesID},
		"client_secret": {secret},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, appleTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("apple token status %d", resp.StatusCode)
	}
	var out struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.IDToken == "" {
		return "", errors.New("apple: no id_token in token response")
	}
	return out.IDToken, nil
}
```

Add imports to `apple_web.go`: `context`, `fmt`, `net/http`, `net/url`, `strings`. Remove the temporary `errors`-only stub body.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run TestAppleWebCallback -v`
Expected: PASS (happy path + state mismatch).

- [ ] **Step 5: Register web routes (gated) + exempt callback from csrfGuard**

In `handlers.go` `routeMux`, inside the existing `if s.cfg.EnableApple {` block, after the native route:

```go
		if s.appleWebConfigured() {
			mux.HandleFunc("GET /api/auth/apple/web/start", s.handleAppleWebStart)
			mux.HandleFunc("POST /api/auth/apple/web/callback", s.handleAppleWebCallback)
		}
```

In `csrfGuard`, exempt the Apple callback before the Origin check (it is a legitimate cross-site form_post; `state` is its CSRF defense):

```go
		if r.Method == http.MethodPost && r.URL.Path == "/api/auth/apple/web/callback" {
			next.ServeHTTP(w, r)
			return
		}
```

- [ ] **Step 6: Verify whole package + vet**

Run: `go test ./internal/account/ && go vet ./...`
Expected: PASS, no vet complaints.

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/apple_web.go server/internal/account/apple_web_test.go server/internal/account/handlers.go
git commit -m "feat(auth): apple web start/callback + code exchange, csrf-exempt callback"
```

---

### Task 4: Domain-association well-known handler

**Files:**
- Modify: `server/wellknown.go`
- Modify: `server/main.go` (register route)

**Interfaces:**
- Produces: `appleDomainAssociation(path string) http.HandlerFunc` — serves the file at `path` as `text/plain`; 404 when `path` is empty or unreadable.

- [ ] **Step 1: Write the failing test**

Create `server/wellknown_test.go` (or add if it exists):

```go
package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestAppleDomainAssociation(t *testing.T) {
	// Unset → 404.
	rec := httptest.NewRecorder()
	appleDomainAssociation("")(rec, httptest.NewRequest("GET", "/.well-known/apple-developer-domain-association.txt", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unset: want 404, got %d", rec.Code)
	}

	// Set → serves file bytes as text/plain.
	dir := t.TempDir()
	p := filepath.Join(dir, "assoc.txt")
	if err := os.WriteFile(p, []byte("apple-domain-proof"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	appleDomainAssociation(p)(rec, httptest.NewRequest("GET", "/.well-known/apple-developer-domain-association.txt", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("set: want 200, got %d", rec.Code)
	}
	if rec.Body.String() != "apple-domain-proof" {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("content-type = %q", ct)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test . -run TestAppleDomainAssociation -v` (from `server/`)
Expected: FAIL — `undefined: appleDomainAssociation`.

- [ ] **Step 3: Implement the handler**

In `server/wellknown.go`, add:

```go
import "os" // add alongside existing imports

// appleDomainAssociation serves /.well-known/apple-developer-domain-association.txt,
// the proof Apple fetches to verify this domain owns the Services ID's return
// URLs. Read from a file on the host (never committed). Dormant → 404 when
// unconfigured or unreadable, matching the AASA handler.
func appleDomainAssociation(path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if path == "" {
			http.NotFound(w, r)
			return
		}
		body, err := os.ReadFile(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write(body)
	}
}
```

- [ ] **Step 4: Register the route in `main.go`**

Next to the existing AASA registration:

```go
	mux.HandleFunc("GET /.well-known/apple-developer-domain-association.txt", appleDomainAssociation(*appleDomainAssoc))
```

- [ ] **Step 5: Run test + build**

Run: `go test . -run TestAppleDomainAssociation -v && go build ./...`
Expected: PASS, build OK.

- [ ] **Step 6: Commit**

```bash
git add server/wellknown.go server/wellknown_test.go server/main.go
git commit -m "feat(auth): serve apple-developer-domain-association from a file path"
```

---

### Task 5: Web UI — "Sign in with Apple" button

**Files:**
- Modify: `web/src/lib/auth.svelte.ts`
- Modify: `web/src/lib/Account.svelte`
- Modify: `web/src/lib/i18n/{en,zh,de,fr,ja,ko,es,pt,ar}.ts` + `web/src/lib/i18n/types.ts`

**Interfaces:**
- Consumes: `/api/auth/methods` now returns `apple: bool` (already present in `handleAuthMethods`).
- Produces: `appleLoginUrl(): string`; `AuthMethods.apple: boolean`; `t.account.continueApple`.

- [ ] **Step 1: Write the failing test**

In `web/src/lib/auth.test.ts`, add:

```ts
import { appleLoginUrl, fetchAuthMethods } from "./auth.svelte";

test("appleLoginUrl points at the web start route", () => {
  expect(appleLoginUrl()).toBe("/api/auth/apple/web/start");
});

test("fetchAuthMethods default includes apple:false", async () => {
  // With fetch unavailable/erroring, the safe default must carry apple:false.
  const orig = globalThis.fetch;
  // @ts-expect-error force the catch path
  globalThis.fetch = () => Promise.reject(new Error("no net"));
  const m = await fetchAuthMethods();
  expect(m.apple).toBe(false);
  globalThis.fetch = orig;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/auth.test.ts`
Expected: FAIL — `appleLoginUrl` is not exported / `apple` missing on default.

- [ ] **Step 3: Implement in `auth.svelte.ts`**

Add the helper next to `googleLoginUrl`:

```ts
export function appleLoginUrl(): string {
  return "/api/auth/apple/web/start";
}
```

Add `apple` to the interface and default:

```ts
export interface AuthMethods {
  password: boolean;
  google: boolean;
  apple: boolean;
  magic: boolean;
}
```

```ts
  return { password: true, google: false, apple: false, magic: false };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the button in `Account.svelte`**

Import `appleLoginUrl` alongside `googleLoginUrl` (line ~5). Update the local default `methods` state to include `apple: false` (line ~21). Extend the separator condition and add the Apple button after the Google one:

```svelte
          {#if methods.google || methods.apple || methods.magic}
            <div class="sep">{t.account.or}</div>
          {/if}
          {#if methods.google}
            <a class="btn btn-ghost" href={googleLoginUrl()}>{t.account.continueGoogle}</a>
          {/if}
          {#if methods.apple}
            <a class="btn btn-ghost btn-apple" href={appleLoginUrl()}>{t.account.continueApple}</a>
          {/if}
```

Add an Apple-styled rule in the component's `<style>` (black button per Apple's brand guidance; the logo can be an inline SVG or the Apple glyph  as a prefix — keep it simple and legible in light/dark):

```css
  .btn-apple { background: #000; color: #fff; border-color: #000; }
  :global(:root[data-theme="light"]) .btn-apple { background: #000; color: #fff; }
```

- [ ] **Step 6: Add `continueApple` to all 9 locales + types**

In `web/src/lib/i18n/types.ts`, add `continueApple: string;` next to `continueGoogle`. Then add to each locale's `account` block (translate the label; keep the product-neutral Apple wording):

- `en.ts`: `continueApple: "Continue with Apple",`
- `zh.ts`: `continueApple: "使用 Apple 继续",`
- `de.ts`: `continueApple: "Mit Apple fortfahren",`
- `fr.ts`: `continueApple: "Continuer avec Apple",`
- `ja.ts`: `continueApple: "Appleで続ける",`
- `ko.ts`: `continueApple: "Apple로 계속하기",`
- `es.ts`: `continueApple: "Continuar con Apple",`
- `pt.ts`: `continueApple: "Continuar com a Apple",`
- `ar.ts`: `continueApple: "المتابعة باستخدام Apple",`

- [ ] **Step 7: Verify svelte-check + tests**

Run: `cd web && npm run check && npm test`
Expected: no type errors; all tests pass (missing-locale guard green).

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/auth.svelte.ts web/src/lib/auth.test.ts web/src/lib/Account.svelte web/src/lib/i18n/
git commit -m "feat(auth): Sign in with Apple button (9 locales)"
```

---

### Task 6: Operator setup doc

**Files:**
- Create: `docs/deploy/apple-signin.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the doc**

Create `docs/deploy/apple-signin.md` covering, concretely:

- **Apple portal steps:** create an App ID (native Bundle ID), a Services ID (web `client_id`), enable Sign in with Apple on both; register the return URL `https://relayium.com/api/auth/apple/web/callback`; create a Sign in with Apple **Key** and download the `.p8` once (note the Key ID and Team ID).
- **Domain verification:** download `apple-developer-domain-association.txt` from the Services ID's domain config, place it on the host, point `RELAYIUM_APPLE_DOMAIN_ASSOC_FILE` at it, deploy, then click "Verify" in the portal.
- **Host placement:** `install -m 600 -o relayium apple_signin.p8 /etc/relayium/apple_signin.p8` (or the deploy user); never commit it.
- **Env vars** (systemd `EnvironmentFile`), with placeholder values only:

  ```
  RELAYIUM_ENABLE_APPLE=true
  RELAYIUM_APPLE_CLIENT_IDS=com.relayium.app,com.relayium.web   # Bundle ID, Services ID
  RELAYIUM_APPLE_SERVICES_ID=com.relayium.web
  RELAYIUM_APPLE_TEAM_ID=XXXXXXXXXX
  RELAYIUM_APPLE_KEY_ID=YYYYYYYYYY
  RELAYIUM_APPLE_PRIVATE_KEY_FILE=/etc/relayium/apple_signin.p8
  RELAYIUM_APPLE_DOMAIN_ASSOC_FILE=/etc/relayium/apple-developer-domain-association.txt
  ```

- **Verification:** `curl -sI https://relayium.com/.well-known/apple-developer-domain-association.txt` → 200; `curl -s https://relayium.com/api/auth/methods` → `"apple":true`; then click the button and complete a real sign-in.
- **Rollback:** unset `RELAYIUM_ENABLE_APPLE` (or the web material) → routes 404, button hidden.

- [ ] **Step 2: Commit**

```bash
git add docs/deploy/apple-signin.md
git commit -m "docs(deploy): Sign in with Apple operator setup"
```

---

## Self-Review

**Spec coverage:**
- Secret-handling principle → Global Constraints + Task 1 (file path, fail-fast) + Task 6 (host placement). ✓
- New config table → Task 1. ✓
- client_secret ES256 → Task 2. ✓
- Web start/callback/exchange, name from first-auth `user`, frozen guard, nonce → Task 3. ✓
- CSRF exemption → Task 3 Step 5. ✓
- Domain-association well-known → Task 4. ✓
- Web UI button (9 locales, methods.apple gate) → Task 5. ✓
- Native activation → no code; documented in Task 6 env vars + already-shipped routes. ✓
- Testing (client_secret, callback, .p8 parse, domain flip, route gating) → Tasks 1–5 tests. ✓
- Out of scope (S2S webhook, APNs, refresh tokens) → not planned. ✓

**Placeholder scan:** No TBD/TODO; every code step carries real code. The only "adapt to existing helper" note (Task 3 Step 1) is deliberate — the account test suite already has an Apple-token builder and `newTestService`/`hasSessionCookie`; the implementer must reuse them rather than invent new names. If those helper names differ, that is a reconciliation the implementer does against real files, not a plan gap.

**Type consistency:** `loadAppleP8`/`LoadApplePrivateKey`, `appleClientSecret`, `handleAppleWebStart`/`handleAppleWebCallback`, `realExchangeAppleCode`, `appleWebConfigured`, `appleNameFromForm`, `appleDomainAssociation`, `appleLoginUrl`, `AuthMethods.apple`, `continueApple`, cookies `oauthStateCookie`/`oauthNonceCookie` — names used consistently across tasks. `Config` fields (`AppleServicesID/TeamID/KeyID/Redirect/PrivateKey/DomainAssocFile`) match between Task 1 definition and Tasks 2–4 use.
