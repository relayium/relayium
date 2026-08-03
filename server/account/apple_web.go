package account

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relayium/relayium/authx"
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

// LoadApplePrivateKey parses a .p8 EC private key for main() to fail-fast at boot.
func LoadApplePrivateKey(pemBytes []byte) (*ecdsa.PrivateKey, error) { return loadAppleP8(pemBytes) }

// appleWebConfigured reports whether every piece needed for the browser
// Sign in with Apple flow is present. Web routes stay unregistered otherwise so
// a half-configured deploy never exposes a 500-ing button.
func (s *Service) appleWebConfigured() bool {
	return s.cfg.AppleServicesID != "" && s.cfg.AppleTeamID != "" &&
		s.cfg.AppleKeyID != "" && s.cfg.ApplePrivateKey != nil
}

// oauthNonceCookie carries the Sign in with Apple nonce from the start
// redirect through to the callback, binding the identity token we later
// receive to this specific login attempt.
const oauthNonceCookie = "relayium_oauth_nonce"

const appleAuthURL = "https://appleid.apple.com/auth/authorize"
const appleTokenURL = "https://appleid.apple.com/auth/token"

// handleAppleWebStart begins the browser Sign in with Apple flow: mint a
// state + nonce, stash them in short-lived cookies, and redirect to Apple's
// authorization endpoint. response_mode=form_post is required whenever the
// "name email" scope is requested.
func (s *Service) handleAppleWebStart(w http.ResponseWriter, r *http.Request) {
	state, nonce := authx.RandToken(), authx.RandToken()
	for _, c := range []struct{ name, val string }{
		{oauthStateCookie, state}, {oauthNonceCookie, nonce},
	} {
		http.SetCookie(w, &http.Cookie{
			Name: c.name, Value: c.val, Path: "/", MaxAge: 600,
			// Apple's callback is a cross-site top-level POST (response_mode=form_post
			// from appleid.apple.com) — SameSite=Lax cookies are NOT sent on
			// cross-site POST navigations, so this MUST be None (requires Secure)
			// or the callback never sees the cookie. Do not "fix" this back to Lax.
			HttpOnly: true, Secure: s.CookieSecure(), SameSite: http.SameSiteNoneMode,
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

// handleAppleWebCallback receives Apple's form_post callback, exchanges the
// authorization code for an identity token, verifies it, and resolves it to a
// session exactly like handleGoogleCallback does for Google.
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
	nc, err := r.Cookie(oauthNonceCookie)
	if err != nil || nc.Value == "" {
		// The start handler always sets this cookie; a missing/empty value is
		// anomalous, not a legitimate flow. Reject rather than degrading to a
		// nonce-less verification (which would skip the replay-binding check).
		fail()
		return
	}
	nonce := nc.Value
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
		// Fragment, not query: keeps the reactivate token out of server logs and
		// Referer (see oauth.go's frozen-login redirect).
		http.Redirect(w, r, "/#account=pending_deletion&token="+url.QueryEscape(raw), http.StatusFound)
		return
	}
	if err := s.store.LinkIdentity(r.Context(), "apple", claims.Sub, u.ID); err != nil {
		fail()
		return
	}
	if claims.EmailVerified {
		// Pre-hijack defense: drop any password planted on this email while
		// unverified, before Apple verifies it (see dropUnverifiedPassword).
		// Gate verification on the drop succeeding — verifying while a planted
		// password survives is exactly the takeover we're closing, so on error
		// we must NOT flip the account to verified (mirrors oauth.go).
		if err := s.dropUnverifiedPassword(r.Context(), u.ID); err != nil {
			fail()
			return
		}
		if err := s.store.SetEmailVerified(r.Context(), u.ID); err != nil {
			fail()
			return
		}
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

// realExchangeAppleCode swaps a WEB authorization code for tokens: the Services
// ID as client_id and the registered redirect_uri, exactly as Apple's browser
// flow requires. Unchanged behaviour, expressed through the shared exchange.
func (s *Service) realExchangeAppleCode(ctx context.Context, code string) (string, error) {
	return s.exchangeAppleCodeAs(ctx, s.cfg.AppleServicesID, code, s.cfg.AppleRedirect)
}

// realExchangeAppleNativeCode swaps a NATIVE authorization code for tokens.
//
// Two differences from the web call, both required by Apple: the client_id is
// the app's Bundle ID (here, the audience already verified in the presented
// identity token), and there is no redirect_uri — a native authorization has no
// redirect, and sending the web one would be describing a different client.
func (s *Service) realExchangeAppleNativeCode(ctx context.Context, clientID, code string) (string, error) {
	return s.exchangeAppleCodeAs(ctx, clientID, code, "")
}

// exchangeAppleCodeAs redeems an authorization code at Apple's token endpoint
// as `clientID`, authenticating with a client_secret JWT signed for that same
// client, and returns the id_token for verification.
//
// A 4xx is Apple ANSWERING and refusing (used code, expired code, wrong client)
// and is reported as errAppleCodeRejected; everything else — transport failure,
// 5xx, an unparseable body, a response with no id_token — is an exchange that
// did not happen. Callers that must fail closed treat both as failure; the
// distinction exists only so the caller can say which one truthfully.
func (s *Service) exchangeAppleCodeAs(ctx context.Context, clientID, code, redirectURI string) (string, error) {
	secret, err := s.appleClientSecretFor(clientID)
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {clientID},
		"client_secret": {secret},
	}
	if redirectURI != "" {
		form.Set("redirect_uri", redirectURI)
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
		// Do not log Apple's response body. It is normally a tiny JSON error,
		// but it is still data returned by an external identity provider in a
		// credential exchange; treating it as guaranteed secret-free would turn
		// an upstream behaviour change into a credential log. Status plus our own
		// client id identifies which configuration failed without that risk.
		log.Printf("apple: token exchange failed for %s: status %d",
			clientID, resp.StatusCode)
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			return "", fmt.Errorf("%w: status %d", errAppleCodeRejected, resp.StatusCode)
		}
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

// appleSecret is one cached client_secret JWT and the moment it stops being
// usable. Held per client id (see Service.appleSecrets).
type appleSecret struct {
	token string
	exp   time.Time
}

// appleSecretTTL is how long a minted client_secret is trusted before we resign.
// Apple caps client_secret exp at 6 months; a short window keeps blast radius
// small and resigning is nanoseconds.
const appleSecretTTL = 30 * time.Minute

// appleClientSecret returns the WEB client_secret: an ES256 JWT proving control
// of the Services ID. The browser flow's one client, named once.
func (s *Service) appleClientSecret() (string, error) {
	return s.appleClientSecretFor(s.cfg.AppleServicesID)
}

// appleClientSecretFor returns an ES256 JWT proving control of `clientID`, used
// as the OAuth client_secret in that client's code exchange. Cached per client
// until shortly before expiry.
//
// Parameterized because Apple binds the secret to the client redeeming the
// code: `sub` is the client_id, so the Services ID secret cannot redeem an app
// (Bundle ID) authorization or the reverse. The cache is keyed the same way for
// the same reason — one shared entry would hand whichever client asked second
// a secret minted for the first.
//
// The key space is bounded by configuration: every caller passes either the
// configured Services ID or an `aud` already checked against
// cfg.AppleClientIDs, so a request cannot grow this map.
func (s *Service) appleClientSecretFor(clientID string) (string, error) {
	if clientID == "" {
		return "", errors.New("apple: no client id for client_secret")
	}
	if s.cfg.ApplePrivateKey == nil {
		return "", errors.New("apple: no .p8 private key configured")
	}
	now := s.now()
	s.appleSecMu.Lock()
	defer s.appleSecMu.Unlock()
	if cached, ok := s.appleSecrets[clientID]; ok && now.Before(cached.exp.Add(-2*time.Minute)) {
		return cached.token, nil
	}
	exp := now.Add(appleSecretTTL)
	header := map[string]string{"alg": "ES256", "kid": s.cfg.AppleKeyID}
	claims := map[string]any{
		"iss": s.cfg.AppleTeamID,
		"iat": now.Unix(),
		"exp": exp.Unix(),
		"aud": appleIssuer, // "https://appleid.apple.com"
		"sub": clientID,
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
	if s.appleSecrets == nil {
		s.appleSecrets = map[string]appleSecret{}
	}
	s.appleSecrets[clientID] = appleSecret{token: tok, exp: exp}
	return tok, nil
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
