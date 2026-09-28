package account

import (
	"context"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// A reset or change is how an account is taken back. Any OTHER emailed link
// still outstanding at that moment — an earlier reset link, a magic sign-in
// link — must stop working, or it hands the account back to whoever holds it.

func magicLink(t *testing.T, svc *Service, m *captureMailer) string {
	t.Helper()
	if err := svc.RequestMagicLink(context.Background(), "victim@example.com"); err != nil {
		t.Fatal(err)
	}
	return tokenFromLink(t, m.magic)
}

// deleteLinkFor plants an unspent account-deletion link for u directly in the
// store, as RequestAccountDeletion would.
func deleteLinkFor(t *testing.T, svc *Service, u User) string {
	t.Helper()
	raw := authx.RandToken()
	now := svc.now()
	if err := svc.store.CreateEmailToken(context.Background(), EmailToken{
		TokenHash: authx.HashToken(raw), UserID: u.ID, Email: u.Email, Purpose: "delete",
		CreatedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestResetPasswordRevokesOtherResetAndMagicLinks(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	victim(t, svc, m)
	earlier := resetLink(t, svc, m)
	magic := magicLink(t, svc, m)
	used := resetLink(t, svc, m)
	if earlier == used {
		t.Fatal("expected two distinct reset links")
	}

	if _, err := svc.ResetPassword(ctx, used, "new-password-2"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if _, err := svc.ResetPassword(ctx, earlier, "attacker-password-3"); err == nil {
		t.Fatal("SECURITY: an earlier reset link still worked after a completed reset")
	}
	if !canLogin(svc, "new-password-2") || canLogin(svc, "attacker-password-3") {
		t.Fatal("the completed reset's password must be the only one")
	}
	if _, err := svc.VerifyMagicLink(ctx, magic); err == nil {
		t.Fatal("SECURITY: a magic link requested before the reset still signed in")
	}
}

func TestChangePasswordRevokesOutstandingResetAndMagicLinks(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, mine, _ := victim(t, svc, m)
	reset := resetLink(t, svc, m)
	magic := magicLink(t, svc, m)

	u, err := svc.store.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.ChangePassword(ctx, u, mine.ID, "old-password-1", "new-password-2"); err != nil {
		t.Fatalf("change: %v", err)
	}
	if _, err := svc.VerifyMagicLink(ctx, magic); err == nil {
		t.Fatal("SECURITY: a magic link outstanding at the password change still signed in")
	}
	if _, err := svc.ResetPassword(ctx, reset, "attacker-password-3"); err == nil {
		t.Fatal("SECURITY: a reset link outstanding at the password change still worked")
	}
	if !canLogin(svc, "new-password-2") || !live(t, svc, mine) {
		t.Fatal("the change itself must stand, with the caller's session kept")
	}
	// A link requested AFTER the change works as usual.
	if _, err := svc.VerifyMagicLink(ctx, magicLink(t, svc, m)); err != nil {
		t.Fatalf("a magic link requested after the change must work: %v", err)
	}
}

// Deletion links are deliberately left alone (see revokeOutstandingLoginLinks):
// dropping one would silently cancel a deletion the owner requested. This pins
// the current behaviour so a change to it is a visible decision.
func TestPasswordChangeKeepsDeleteLink(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	del := deleteLinkFor(t, svc, u)
	if _, err := svc.ResetPassword(ctx, resetLink(t, svc, m), "new-password-2"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if _, ok, err := svc.store.PeekEmailToken(ctx, authx.HashToken(del), "delete", svc.now().Unix()); err != nil || !ok {
		t.Fatalf("delete link after reset: ok=%v err=%v (want kept)", ok, err)
	}
}
