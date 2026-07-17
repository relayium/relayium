package account

import (
	"context"
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
