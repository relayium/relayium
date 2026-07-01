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

func TestValidateAdminTOTP(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)

	if !s.validateAdminTOTP(codeAt(t, base)) {
		t.Fatal("current-step code should pass")
	}
}

func TestValidateAdminTOTPSkew(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)

	// -1 step
	s := newTOTPService(testSecret, base)
	if !s.validateAdminTOTP(codeAt(t, base.Add(-30*time.Second))) {
		t.Fatal("-1 step code should pass (skew=1)")
	}
	// +1 step
	s = newTOTPService(testSecret, base)
	if !s.validateAdminTOTP(codeAt(t, base.Add(30*time.Second))) {
		t.Fatal("+1 step code should pass (skew=1)")
	}
	// +2 steps must fail
	s = newTOTPService(testSecret, base)
	if s.validateAdminTOTP(codeAt(t, base.Add(60*time.Second))) {
		t.Fatal("+2 step code must be rejected")
	}
}

func TestValidateAdminTOTPWrongCode(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)
	if s.validateAdminTOTP("000000") {
		t.Fatal("wrong code must be rejected")
	}
}

func TestValidateAdminTOTPReplay(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)
	code := codeAt(t, base)
	if !s.validateAdminTOTP(code) {
		t.Fatal("first use should pass")
	}
	if s.validateAdminTOTP(code) {
		t.Fatal("replay of same code/step must be rejected")
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
