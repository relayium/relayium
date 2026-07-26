package account

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

// signAppleJWT builds a signed RS256 token from a header + claims map, mirroring
// the shape Apple emits, so tests exercise the real verify path end to end.
func signAppleJWT(t *testing.T, key *rsa.PrivateKey, header, claims map[string]any) string {
	t.Helper()
	enc := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(b)
	}
	signingInput := enc(header) + "." + enc(claims)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// appleTestService returns a Service whose appleKey resolves to `pub` for the
// expected kid, with a fixed clock and a one-entry aud allowlist.
func appleTestService(pub *rsa.PublicKey) *Service {
	svc := NewService(nil, nil, Config{AppleClientIDs: []string{"com.relayium.app"}})
	svc.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	svc.appleKey = func(_ context.Context, kid string) (*rsa.PublicKey, error) {
		return pub, nil
	}
	return svc
}

func validAppleClaims(now time.Time) map[string]any {
	return map[string]any{
		"iss":            appleIssuer,
		"aud":            "com.relayium.app",
		"sub":            "000123.abcdef.0001",
		"exp":            now.Add(time.Hour).Unix(),
		"iat":            now.Unix(),
		"email":          "user@example.com",
		"email_verified": "true", // Apple's string-bool quirk
		"nonce":          "n-abc",
	}
}

func TestVerifyAppleIDToken_Valid(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	svc := appleTestService(&key.PublicKey)
	now := svc.now()
	tok := signAppleJWT(t, key, map[string]any{"alg": "RS256", "kid": "k1"}, validAppleClaims(now))

	c, err := svc.verifyAppleIDToken(context.Background(), tok, "n-abc")
	if err != nil {
		t.Fatalf("valid token rejected: %v", err)
	}
	if c.Sub != "000123.abcdef.0001" {
		t.Errorf("sub = %q", c.Sub)
	}
	if c.Email != "user@example.com" {
		t.Errorf("email = %q", c.Email)
	}
	if !c.EmailVerified {
		t.Errorf("email_verified should parse from the string \"true\"")
	}
}

func TestVerifyAppleIDToken_Rejections(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	svc := appleTestService(&key.PublicKey)
	now := svc.now()
	hdr := map[string]any{"alg": "RS256", "kid": "k1"}

	cases := []struct {
		name  string
		mut   func(c map[string]any)
		sign  *rsa.PrivateKey // key to sign with (nil = correct key)
		nonce string
		alg   string // override header alg
	}{
		{name: "wrong signature", sign: other, nonce: "n-abc"},
		{name: "expired", mut: func(c map[string]any) { c["exp"] = now.Add(-time.Minute).Unix() }, nonce: "n-abc"},
		{name: "wrong aud", mut: func(c map[string]any) { c["aud"] = "com.someone.else" }, nonce: "n-abc"},
		{name: "wrong iss", mut: func(c map[string]any) { c["iss"] = "https://evil.example" }, nonce: "n-abc"},
		{name: "nonce mismatch", nonce: "different"},
		{name: "missing sub", mut: func(c map[string]any) { delete(c, "sub") }, nonce: "n-abc"},
		{name: "wrong alg", alg: "HS256", nonce: "n-abc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims := validAppleClaims(now)
			if tc.mut != nil {
				tc.mut(claims)
			}
			h := map[string]any{"alg": "RS256", "kid": "k1"}
			if tc.alg != "" {
				h["alg"] = tc.alg
			} else {
				h = hdr
			}
			signer := key
			if tc.sign != nil {
				signer = tc.sign
			}
			tok := signAppleJWT(t, signer, h, claims)
			if _, err := svc.verifyAppleIDToken(context.Background(), tok, tc.nonce); err == nil {
				t.Fatalf("%s: expected rejection, got nil error", tc.name)
			}
		})
	}
}

func TestVerifyAppleIDToken_Malformed(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	svc := appleTestService(&key.PublicKey)
	for _, tok := range []string{"", "a.b", "a.b.c.d", "not-a-token"} {
		if _, err := svc.verifyAppleIDToken(context.Background(), tok, ""); err == nil {
			t.Errorf("malformed token %q accepted", tok)
		}
	}
}

func TestRSAPublicKeyFromJWK_RoundTrip(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	nB64 := base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes())
	// e = 65537 = 0x010001
	eB64 := base64.RawURLEncoding.EncodeToString([]byte{0x01, 0x00, 0x01})
	pub, err := rsaPublicKeyFromJWK(nB64, eB64)
	if err != nil {
		t.Fatalf("rsaPublicKeyFromJWK: %v", err)
	}
	if pub.N.Cmp(key.PublicKey.N) != 0 || pub.E != key.PublicKey.E {
		t.Errorf("reconstructed key mismatch: E=%d want %d", pub.E, key.PublicKey.E)
	}
}
