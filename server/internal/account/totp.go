package account

import (
	"fmt"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// totpForwardHealSteps is how many 30-second steps the persisted replay guard
// may sit AHEAD of a presented code's step before ClaimTOTPStep treats it as a
// clock-poisoned value and self-heals (resets to the current step). Legit skew
// is at most ±1 step (matchAdminTOTPStep's window), so 2 leaves a safe margin;
// any real forward clock jump that would lock out 2FA is far larger.
const totpForwardHealSteps = 2

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
//
// It is CRYPTO-ONLY and side-effect-free: it does NOT enforce replay. Replay is
// the store's atomic ClaimTOTPStep(step) — called after the full credential
// check passes — which is what makes "one code, one use" hold ACROSS instances
// and across restarts (a process-local counter never could). Keeping this
// function pure also preserves verifyAdminCreds' constant-time property: user,
// password, and code-validity are checked together with no state mutation, so a
// failed attempt leaks nothing via timing; the claim is a separate axis that
// only matters once the creds are valid.
func (s *Service) matchAdminTOTPStep(code string) (step int64, ok bool) {
	secret := s.cfg.AdminTOTPSecret
	if secret == "" || code == "" {
		return 0, false
	}
	now := s.now()
	for delta := int64(-1); delta <= 1; delta++ {
		t := now.Add(time.Duration(delta) * 30 * time.Second)
		okc, err := totp.ValidateCustom(code, secret, t, totpOpts)
		if err != nil || !okc {
			continue
		}
		return t.Unix() / 30, true
	}
	return 0, false
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
