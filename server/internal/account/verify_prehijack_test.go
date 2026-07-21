package account

import (
	"context"
	"testing"
)

// Pre-hijack variant via the direct email-verify path: an attacker registers the
// victim's address with a password they know; the victim, by clicking the
// verification link, must NOT activate the attacker's password. Verifying WITHOUT
// proving knowledge of it drops the password — the account becomes verified but
// passwordless, so the attacker's password no longer logs in.
func TestVerifyDropsUnconfirmedRegistrationPassword(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)

	// Attacker registers victim@x with a password only the attacker knows.
	if _, err := svc.Register(ctx, "victim@example.com", "attacker-known-pw", "Victim"); err != nil {
		t.Fatal(err)
	}
	// Victim clicks the verification link but does NOT know (can't confirm) the
	// password → verify with an empty/blank confirmation.
	sess, err := svc.VerifyEmail(ctx, tokenFromLink(t, m.verify), "")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if sess.UserID == "" {
		t.Fatal("verify should still issue the victim a session")
	}

	// The email is verified, but the attacker's password was dropped.
	if v, _ := svc.store.EmailVerified(ctx, sess.UserID); !v {
		t.Fatal("email should be verified")
	}
	if has, _ := svc.store.HasPassword(ctx, sess.UserID); has {
		t.Fatal("SECURITY: the unconfirmed registration password must be dropped on verify")
	}
	// The attacker can no longer log in with the password they set.
	if _, err := svc.Login(ctx, "victim@example.com", "attacker-known-pw"); err != ErrBadCredentials {
		t.Fatalf("attacker login must fail with bad credentials, got %v", err)
	}
}

// The legitimate registrant DOES know their password, so confirming it at verify
// keeps it and login works — the normal signup path is unbroken.
func TestVerifyKeepsConfirmedRegistrationPassword(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	if _, err := svc.Register(ctx, "owner@example.com", "my-own-password", "Owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VerifyEmail(ctx, tokenFromLink(t, m.verify), "my-own-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Login(ctx, "owner@example.com", "my-own-password"); err != nil {
		t.Fatalf("confirmed password must keep working after verify: %v", err)
	}
}
