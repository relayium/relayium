package account

import (
	"context"
	"strings"
	"testing"
	"time"
)

func newTestService(t *testing.T) (*Service, *captureMailer) {
	t.Helper()
	st := newTestStore(t)
	m := &captureMailer{}
	svc := NewService(st, m, Config{
		BaseURL:    "https://relayium.com",
		SessionTTL: time.Hour, MagicTTL: 15 * time.Minute, VerifyTTL: 24 * time.Hour, ResetTTL: time.Hour,
	})
	return svc, m
}

// tokenFromLink extracts the ?token= value from a captured link.
func tokenFromLink(t *testing.T, link string) string {
	t.Helper()
	i := strings.Index(link, "token=")
	if i < 0 {
		t.Fatalf("no token in link %q", link)
	}
	return link[i+len("token="):]
}

func TestRegisterSendsVerifyAndNoLoginUntilVerified(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, err := svc.Register(ctx, "New@Example.com", "supersecret", "New")
	if err != nil {
		t.Fatal(err)
	}
	if u.EmailVerified {
		t.Fatal("registered user must start unverified")
	}
	if !strings.Contains(m.verify, "/verify-email?token=") {
		t.Fatalf("verify link not sent, got %q", m.verify)
	}
	// login blocked while unverified
	if _, err := svc.Login(ctx, "new@example.com", "supersecret"); err != ErrEmailUnverified {
		t.Fatalf("want ErrEmailUnverified, got %v", err)
	}
	// verify with the emailed token (+ the registration password, confirming it so
	// it's kept) → session, and now verified
	sess, err := svc.VerifyEmail(ctx, tokenFromLink(t, m.verify), "supersecret")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if sess.UserID != u.ID {
		t.Fatal("verify session must belong to the user")
	}
	if v, _ := svc.store.EmailVerified(ctx, u.ID); !v {
		t.Fatal("should be verified after VerifyEmail")
	}
	// login now works
	if _, err := svc.Login(ctx, "new@example.com", "supersecret"); err != nil {
		t.Fatalf("login after verify: %v", err)
	}
}

func TestVerifyBadTokenRejected(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestService(t)
	if _, err := svc.VerifyEmail(ctx, "not-a-real-token", ""); err != ErrInvalidToken {
		t.Fatalf("want ErrInvalidToken, got %v", err)
	}
}

func TestMagicLinkMarksVerified(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	if err := svc.RequestMagicLink(ctx, "magic@example.com"); err != nil {
		t.Fatalf("request magic link: %v", err)
	}
	sess, err := svc.VerifyMagicLink(ctx, tokenFromLink(t, m.magic))
	if err != nil {
		t.Fatalf("verify magic link: %v", err)
	}
	if v, _ := svc.store.EmailVerified(ctx, sess.UserID); !v {
		t.Fatal("magic-link login should mark email verified")
	}
}
