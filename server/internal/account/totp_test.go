package account

import (
	"testing"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const testSecret = "JBSWY3DPEHPK3PXP" // base32, RFC 6238-style test secret

// codeAt generates the valid 6-digit code for the fixed test secret at time t.
func codeAt(t *testing.T, tm time.Time) string {
	t.Helper()
	code, err := totp.GenerateCodeCustom(testSecret, tm, totp.ValidateOpts{
		Period: 30, Skew: 0, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1,
	})
	if err != nil {
		t.Fatalf("GenerateCodeCustom: %v", err)
	}
	return code
}

func newTOTPService(secret string, at time.Time) *Service {
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminPassword: "pw", AdminTOTPSecret: secret})
	s.now = func() time.Time { return at }
	return s
}

func TestAdminTOTPEnabled(t *testing.T) {
	if newTOTPService("", time.Unix(0, 0)).AdminTOTPEnabled() {
		t.Fatal("empty secret should disable 2FA")
	}
	if !newTOTPService(testSecret, time.Unix(0, 0)).AdminTOTPEnabled() {
		t.Fatal("non-empty secret should enable 2FA")
	}
}

func TestMatchAdminTOTPStep(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)

	step, ok := s.matchAdminTOTPStep(codeAt(t, base))
	if !ok {
		t.Fatal("current-step code should match")
	}
	// Matching alone must not mutate replay state: the same code should
	// still match on a second call, since it hasn't been committed.
	if _, ok := s.matchAdminTOTPStep(codeAt(t, base)); !ok {
		t.Fatal("matching must be read-only: repeated match before commit should still succeed")
	}

	s.commitAdminTOTPStep(step)
	if _, ok := s.matchAdminTOTPStep(codeAt(t, base)); ok {
		t.Fatal("code must not match after its step is committed (replay)")
	}
}

func TestMatchAdminTOTPStepSkew(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)

	// -1 step
	s := newTOTPService(testSecret, base)
	if _, ok := s.matchAdminTOTPStep(codeAt(t, base.Add(-30*time.Second))); !ok {
		t.Fatal("-1 step code should pass (skew=1)")
	}
	// +1 step
	s = newTOTPService(testSecret, base)
	if _, ok := s.matchAdminTOTPStep(codeAt(t, base.Add(30*time.Second))); !ok {
		t.Fatal("+1 step code should pass (skew=1)")
	}
	// +2 steps must fail
	s = newTOTPService(testSecret, base)
	if _, ok := s.matchAdminTOTPStep(codeAt(t, base.Add(60*time.Second))); ok {
		t.Fatal("+2 step code must be rejected")
	}
}

func TestMatchAdminTOTPStepWrongCode(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)
	if _, ok := s.matchAdminTOTPStep("000000"); ok {
		t.Fatal("wrong code must be rejected")
	}
}

func TestCommitAdminTOTPStepReplay(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)
	code := codeAt(t, base)

	step, ok := s.matchAdminTOTPStep(code)
	if !ok {
		t.Fatal("first match should pass")
	}
	s.commitAdminTOTPStep(step)
	if _, ok := s.matchAdminTOTPStep(code); ok {
		t.Fatal("replay of same code/step must be rejected after commit")
	}
}

func TestValidateAdminTOTPSecret(t *testing.T) {
	if err := validateAdminTOTPSecret(""); err != nil {
		t.Fatalf("empty secret is allowed (2FA off): %v", err)
	}
	if err := validateAdminTOTPSecret(testSecret); err != nil {
		t.Fatalf("valid base32 secret should pass: %v", err)
	}
	if err := validateAdminTOTPSecret("not base32!!"); err == nil {
		t.Fatal("invalid base32 secret must error")
	}
}
