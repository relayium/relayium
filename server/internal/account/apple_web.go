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
	"time"
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

// realExchangeAppleCode is a temporary stub; Task 3 replaces it with the real
// OAuth authorization-code exchange (POST to Apple's token endpoint using a
// client_secret JWT signed with ApplePrivateKey).
func (s *Service) realExchangeAppleCode(ctx context.Context, code string) (string, error) {
	return "", errors.New("not implemented")
}

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
