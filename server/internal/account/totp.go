package account

import (
	"fmt"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// totpOpts are the fixed TOTP parameters (Google Authenticator / 1Password
// compatible). Validation iterates steps manually for exact replay tracking,
// so per-call Skew stays 0 here.
var totpOpts = totp.ValidateOpts{
	Period:    30,
	Skew:      0,
	Digits:    otp.DigitsSix,
	Algorithm: otp.AlgorithmSHA1,
}

// AdminTOTPEnabled reports whether admin login requires a TOTP code: the
// dashboard must be enabled (password set) AND a secret configured.
func (s *Service) AdminTOTPEnabled() bool {
	return s.AdminEnabled() && s.cfg.AdminTOTPSecret != ""
}

// validateAdminTOTP checks a 6-digit code against the configured secret,
// allowing ±1 time-step of clock skew. It rejects replays: once a code from
// a given time-step succeeds, that step and any earlier one are permanently
// dead (monotonic adminTOTPLastStep).
func (s *Service) validateAdminTOTP(code string) bool {
	secret := s.cfg.AdminTOTPSecret
	if secret == "" || code == "" {
		return false
	}
	now := s.now()
	for delta := int64(-1); delta <= 1; delta++ {
		t := now.Add(time.Duration(delta) * 30 * time.Second)
		ok, err := totp.ValidateCustom(code, secret, t, totpOpts)
		if err != nil || !ok {
			continue
		}
		step := t.Unix() / 30
		s.adminTOTPMu.Lock()
		defer s.adminTOTPMu.Unlock()
		if step <= s.adminTOTPLastStep {
			return false // replay or stale step
		}
		s.adminTOTPLastStep = step
		return true
	}
	return false
}

// validateAdminTOTPSecret returns an error if secret is non-empty but not a
// usable base32 TOTP secret. Empty is valid and means 2FA is off.
func validateAdminTOTPSecret(secret string) error {
	if secret == "" {
		return nil
	}
	if _, err := totp.GenerateCode(secret, time.Unix(0, 0)); err != nil {
		return fmt.Errorf("invalid RELAYIUM_ADMIN_TOTP_SECRET (must be base32): %w", err)
	}
	return nil
}

// ValidateAdminTOTPSecret is the exported startup-check wrapper.
func ValidateAdminTOTPSecret(secret string) error { return validateAdminTOTPSecret(secret) }
