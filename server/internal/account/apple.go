package account

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/relayium/relayium/internal/httpx"
)

// appleIssuer is the fixed `iss` claim in every Sign in with Apple identity token.
const appleIssuer = "https://appleid.apple.com"

// appleKeysURL is Apple's public JWKS endpoint (RSA signing keys, rotated).
const appleKeysURL = "https://appleid.apple.com/auth/keys"

// appleClaims is the subset of a verified Apple identity token we consume.
type appleClaims struct {
	Sub            string // stable per-user Apple id — the primary account key
	Email          string // present on first authorization (and while unchanged)
	EmailVerified  bool
	IsPrivateEmail bool // true = Apple private-relay address (…@privaterelay.appleid.com)
}

// flexBool unmarshals a JSON value that Apple emits inconsistently as either a
// bool or a quoted string ("true"/"false") — a well-known SiwA quirk.
type flexBool bool

func (b *flexBool) UnmarshalJSON(data []byte) error {
	s := strings.Trim(string(data), `"`)
	*b = flexBool(s == "true")
	return nil
}

// verifyAppleIDToken validates an Apple identity token end to end: RS256
// signature against Apple's published key for the token's `kid`, then the
// standard claims (iss, aud ∈ configured client ids, exp) plus the caller's
// nonce when one is expected. Returns the trusted claims on success.
func (s *Service) verifyAppleIDToken(ctx context.Context, idToken, expectedNonce string) (appleClaims, error) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return appleClaims{}, errors.New("apple: malformed token")
	}
	headerJSON, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return appleClaims{}, fmt.Errorf("apple: bad header: %w", err)
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(headerJSON, &hdr); err != nil {
		return appleClaims{}, fmt.Errorf("apple: bad header json: %w", err)
	}
	// Pin the algorithm: never let the token pick "none" or an HMAC alg whose
	// "verification" would treat our RSA modulus as a shared secret.
	if hdr.Alg != "RS256" {
		return appleClaims{}, fmt.Errorf("apple: unexpected alg %q", hdr.Alg)
	}
	pub, err := s.appleKey(ctx, hdr.Kid)
	if err != nil {
		return appleClaims{}, fmt.Errorf("apple: key %q: %w", hdr.Kid, err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return appleClaims{}, fmt.Errorf("apple: bad signature: %w", err)
	}
	signingInput := parts[0] + "." + parts[1]
	digest := sha256.Sum256([]byte(signingInput))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sig); err != nil {
		return appleClaims{}, errors.New("apple: signature verification failed")
	}

	payloadJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return appleClaims{}, fmt.Errorf("apple: bad payload: %w", err)
	}
	var c struct {
		Iss            string   `json:"iss"`
		Aud            string   `json:"aud"`
		Sub            string   `json:"sub"`
		Exp            int64    `json:"exp"`
		Email          string   `json:"email"`
		EmailVerified  flexBool `json:"email_verified"`
		IsPrivateEmail flexBool `json:"is_private_email"`
		Nonce          string   `json:"nonce"`
	}
	if err := json.Unmarshal(payloadJSON, &c); err != nil {
		return appleClaims{}, fmt.Errorf("apple: bad payload json: %w", err)
	}
	if c.Iss != appleIssuer {
		return appleClaims{}, fmt.Errorf("apple: unexpected iss %q", c.Iss)
	}
	if !containsStr(s.cfg.AppleClientIDs, c.Aud) {
		return appleClaims{}, fmt.Errorf("apple: aud %q not in allowlist", c.Aud)
	}
	if c.Exp <= s.now().Unix() {
		return appleClaims{}, errors.New("apple: token expired")
	}
	if c.Sub == "" {
		return appleClaims{}, errors.New("apple: missing sub")
	}
	// The nonce (when the caller supplied one) binds the token to this login
	// attempt, defeating replay of a token captured elsewhere.
	if expectedNonce != "" && c.Nonce != expectedNonce {
		return appleClaims{}, errors.New("apple: nonce mismatch")
	}
	return appleClaims{
		Sub: c.Sub, Email: normEmail(c.Email),
		EmailVerified: bool(c.EmailVerified), IsPrivateEmail: bool(c.IsPrivateEmail),
	}, nil
}

func containsStr(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}

// handleAppleNative logs a native (iOS/macOS) app in with a Sign in with Apple
// identity token and returns a bearer token. Dormant until EnableApple is set.
// Resolution order: by the stable Apple `sub` first (Apple only returns the
// email on the FIRST authorization), falling back to email-based account
// creation/linking on that first sign-in.
func (s *Service) handleAppleNative(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDToken string `json:"idToken"`
		Nonce   string `json:"nonce"`
		Name    string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	claims, err := s.verifyAppleIDToken(r.Context(), in.IDToken, in.Nonce)
	if err != nil {
		httpx.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_token"})
		return
	}
	u, found, err := s.store.GetUserByIdentity(r.Context(), "apple", claims.Sub)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !found {
		// First sign-in for this Apple id. Apple only gives us the email now, so
		// this is our one chance to create/link the account by it.
		if claims.Email == "" {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "no_email_first_signin"})
			return
		}
		u, err = s.store.UpsertUserByEmail(r.Context(), claims.Email, in.Name)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if s.frozenBlocked(w, u) {
			return
		}
		if err := s.store.LinkIdentity(r.Context(), "apple", claims.Sub, u.ID); err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if claims.EmailVerified {
			// Pre-hijack defense: drop any password planted on this email while
			// unverified, before Apple verifies it (see dropUnverifiedPassword).
			// Gate verification on the drop succeeding — verifying while a planted
			// password survives is exactly the takeover we're closing, so on error
			// we must NOT flip the account to verified (mirrors oauth.go).
			if err := s.dropUnverifiedPassword(r.Context(), u.ID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if err := s.store.SetEmailVerified(r.Context(), u.ID); err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
		}
	} else if s.frozenBlocked(w, u) {
		return
	}
	s.finishNativeLogin(w, r, u.ID, "App (Apple)")
}

// frozenBlocked writes the pending-deletion response and reports true when the
// account is scheduled for deletion, so a frozen account never gets a token.
func (s *Service) frozenBlocked(w http.ResponseWriter, u User) bool {
	if u.DeletedAt == 0 {
		return false
	}
	raw, err := s.issueReactivateToken(context.Background(), u.ID, u.Email)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return true
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"status": "pending_deletion", "purgeAfter": u.PurgeAfter, "reactivateToken": raw,
	})
	return true
}

// ── Apple public-key (JWKS) store ────────────────────────────────────────────

// appleKeyStore fetches and caches Apple's JWKS, exposing key(ctx, kid). Keys
// rotate rarely; a short TTL plus a miss-triggered refetch keeps it current.
type appleKeyStore struct {
	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
	ttl     time.Duration
	url     string
	client  *http.Client
}

func newAppleKeyStore() *appleKeyStore {
	return &appleKeyStore{
		ttl:    time.Hour,
		url:    appleKeysURL,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (a *appleKeyStore) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if k, ok := a.keys[kid]; ok && time.Since(a.fetched) < a.ttl {
		return k, nil
	}
	// Cache miss or stale: (re)fetch. An unknown kid on a fresh cache also lands
	// here, covering a key rotation between the TTL window.
	if err := a.refresh(ctx); err != nil {
		// Fall back to a cached key if we have one, rather than failing a login on
		// a transient JWKS fetch error.
		if k, ok := a.keys[kid]; ok {
			return k, nil
		}
		return nil, err
	}
	if k, ok := a.keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("no key for kid %q", kid)
}

func (a *appleKeyStore) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.url, nil)
	if err != nil {
		return err
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("apple jwks status %d", resp.StatusCode)
	}
	var jwks struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return err
	}
	next := make(map[string]*rsa.PublicKey, len(jwks.Keys))
	for _, k := range jwks.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pub, err := rsaPublicKeyFromJWK(k.N, k.E)
		if err != nil {
			continue
		}
		next[k.Kid] = pub
	}
	a.keys = next
	a.fetched = time.Now()
	return nil
}

// rsaPublicKeyFromJWK builds an *rsa.PublicKey from the base64url modulus (n)
// and exponent (e) of a JWK.
func rsaPublicKeyFromJWK(nB64, eB64 string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eB64)
	if err != nil {
		return nil, err
	}
	// Left-pad the exponent to 8 bytes so BigEndian.Uint64 reads it correctly.
	padded := make([]byte, 8)
	copy(padded[8-len(eBytes):], eBytes)
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(binary.BigEndian.Uint64(padded)),
	}, nil
}
