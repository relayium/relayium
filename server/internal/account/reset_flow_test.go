package account

import (
	"context"
	"testing"
)

// registerAndVerify is a helper that produces a logged-in-capable verified user.
func registerAndVerify(t *testing.T, svc *Service, m *captureMailer, email, pw string) User {
	t.Helper()
	ctx := context.Background()
	u, err := svc.Register(ctx, email, pw, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VerifyEmail(ctx, tokenFromLink(t, m.verify)); err != nil {
		t.Fatal(err)
	}
	return u
}

func TestForgotThenResetThenLogin(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u := registerAndVerify(t, svc, m, "r@example.com", "oldpassword")
	// a live session that must be revoked by reset
	old, _ := svc.IssueSession(ctx, u.ID)

	if err := svc.RequestPasswordReset(ctx, "r@example.com"); err != nil {
		t.Fatal(err)
	}
	if m.reset == "" {
		t.Fatal("reset email not sent")
	}
	sess, err := svc.ResetPassword(ctx, tokenFromLink(t, m.reset), "brandnewpass")
	if err != nil {
		t.Fatalf("reset: %v", err)
	}
	if sess.UserID != u.ID {
		t.Fatal("reset session must belong to user")
	}
	// old password rejected, new password works
	if _, err := svc.Login(ctx, "r@example.com", "oldpassword"); err != ErrBadCredentials {
		t.Fatal("old password must no longer work")
	}
	if _, err := svc.Login(ctx, "r@example.com", "brandnewpass"); err != nil {
		t.Fatalf("new password login: %v", err)
	}
	// prior session revoked
	if _, ok, _ := svc.ValidateSession(ctx, old.ID); ok {
		t.Fatal("reset must revoke prior sessions")
	}
}

func TestForgotUnknownEmailIsSilentNoToken(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	if err := svc.RequestPasswordReset(ctx, "nobody@example.com"); err != nil {
		t.Fatalf("must not error on unknown email: %v", err)
	}
	if m.reset != "" {
		t.Fatal("must not send reset for unknown email")
	}
}
