package account

import (
	"context"
	"sync"
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
	if !ok || step == 0 {
		t.Fatalf("current-step code should match, got step=%d ok=%v", step, ok)
	}
	// Crypto-only + side-effect-free: repeated matching still succeeds. Replay is
	// enforced separately by the store's atomic ClaimTOTPStep, NOT here.
	if _, ok := s.matchAdminTOTPStep(codeAt(t, base)); !ok {
		t.Fatal("matching must be side-effect-free: a repeated match should still succeed")
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

// ClaimTOTPStep is the atomic, persistent replay guard: a step is claimable
// once; the same or an older step is refused; a newer step advances the guard.
func TestClaimTOTPStepMonotonicAtomic(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if ok, err := st.ClaimTOTPStep(ctx, 100); err != nil || !ok {
		t.Fatalf("first claim of step 100: ok=%v err=%v", ok, err)
	}
	if ok, _ := st.ClaimTOTPStep(ctx, 100); ok {
		t.Fatal("replay of the same step must be refused")
	}
	if ok, _ := st.ClaimTOTPStep(ctx, 99); ok {
		t.Fatal("an older step must be refused")
	}
	if ok, err := st.ClaimTOTPStep(ctx, 101); err != nil || !ok {
		t.Fatalf("a newer step must advance the guard: ok=%v err=%v", ok, err)
	}
}

// Concurrent claims of the SAME step (N instances racing one code) let exactly
// one through — the writer serializes the compare-and-set.
func TestClaimTOTPStepConcurrent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, err := st.ClaimTOTPStep(ctx, 500); err == nil && ok {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if won != 1 {
		t.Fatalf("exactly one concurrent claim of a step may win, got %d", won)
	}
}

// Two Service values sharing ONE store (two processes on one DB file): a code
// spent via instance A cannot be replayed via instance B — the guard is shared,
// not per-process. This is the whole point of the migration.
func TestTOTPReplayAcrossInstances(t *testing.T) {
	st := newTestStore(t)
	base := time.Unix(1_700_000_000, 0)
	mk := func() *Service {
		s := NewService(st, nil, Config{AdminUser: "admin", AdminPassword: "pw", AdminTOTPSecret: testSecret})
		s.now = func() time.Time { return base }
		return s
	}
	svcA, svcB := mk(), mk()
	ctx := context.Background()
	code := codeAt(t, base)

	stepA, ok := svcA.matchAdminTOTPStep(code)
	if !ok {
		t.Fatal("A: code should validate")
	}
	if claimed, err := st.ClaimTOTPStep(ctx, stepA); err != nil || !claimed {
		t.Fatalf("A: first claim should win: claimed=%v err=%v", claimed, err)
	}
	// B still sees the code as cryptographically valid in-window...
	stepB, ok := svcB.matchAdminTOTPStep(code)
	if !ok {
		t.Fatal("B: code is still cryptographically valid in the window")
	}
	// ...but the SHARED guard refuses to spend it a second time.
	if claimed, _ := st.ClaimTOTPStep(ctx, stepB); claimed {
		t.Fatal("SECURITY: a TOTP code spent on instance A was replayable on instance B")
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
