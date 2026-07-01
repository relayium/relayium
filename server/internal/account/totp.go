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

// matchAdminTOTPStep checks a 6-digit code against the configured secret,
// allowing ±1 time-step of clock skew, and returns the time-step it maps to.
// It rejects replays: a step at or before the last committed one is stale.
// It does NOT mutate replay state; call commitAdminTOTPStep after a fully
// successful login to consume the step. ok is false for an empty/invalid/
// already-consumed code.
func (s *Service) matchAdminTOTPStep(code string) (step int64, ok bool) {
	secret := s.cfg.AdminTOTPSecret
	if secret == "" || code == "" {
		return 0, false
	}
	now := s.now()
	s.adminTOTPMu.Lock()
	last := s.adminTOTPLastStep
	s.adminTOTPMu.Unlock()
	for delta := int64(-1); delta <= 1; delta++ {
		t := now.Add(time.Duration(delta) * 30 * time.Second)
		okc, err := totp.ValidateCustom(code, secret, t, totpOpts)
		if err != nil || !okc {
			continue
		}
		st := t.Unix() / 30
		if st <= last {
			return 0, false // replayed / stale step
		}
		return st, true
	}
	return 0, false
}

// commitAdminTOTPStep consumes a matched step after a fully successful login,
// advancing the monotonic replay guard so that step and earlier can't be reused.
func (s *Service) commitAdminTOTPStep(step int64) {
	s.adminTOTPMu.Lock()
	if step > s.adminTOTPLastStep {
		s.adminTOTPLastStep = step
	}
	s.adminTOTPMu.Unlock()
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
