package account

import (
	"context"
	"errors"
	"testing"
)

// An attacker who plants a password on an email they do not own must NOT retain
// a usable credential once the real owner proves ownership through an external
// channel (here: a magic link). Verifying the account through that channel drops
// the untrusted password — otherwise the planted password becomes live the
// moment the owner first signs in, a full account takeover.
func TestMagicLinkVerifyDropsPlantedPassword(t *testing.T) {
	svc, mail := newTestService(t)
	ctx := context.Background()

	const email = "victim@example.com"
	const plantedPw = "attacker-chosen-1"
	u, err := svc.Register(ctx, email, plantedPw, "V")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	// Unverified: the planted password cannot log in yet, but the credential exists.
	if _, err := svc.Login(ctx, email, plantedPw); !errors.Is(err, ErrEmailUnverified) {
		t.Fatalf("pre-verify login: want ErrEmailUnverified, got %v", err)
	}

	// The real owner signs in via a magic link, verifying the account.
	if err := svc.RequestMagicLink(ctx, email); err != nil {
		t.Fatalf("request magic link: %v", err)
	}
	if _, err := svc.VerifyMagicLink(ctx, tokenFromLink(t, mail.magic)); err != nil {
		t.Fatalf("verify magic link: %v", err)
	}

	// The planted password must be gone now that the email is verified.
	if has, err := svc.store.HasPassword(ctx, u.ID); err != nil || has {
		t.Fatalf("planted password still present after verify (has=%v err=%v)", has, err)
	}
	if _, err := svc.Login(ctx, email, plantedPw); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("SECURITY: planted password still logs in after IdP verify: got %v", err)
	}
}

// The drop must be scoped to accounts verified via an external channel: a user
// who set a password AND verified it through the normal email-verification flow
// keeps that password even if they later also use a magic link.
func TestMagicLinkVerifyKeepsAlreadyVerifiedPassword(t *testing.T) {
	svc, mail := newTestService(t)
	ctx := context.Background()

	const email = "owner@example.com"
	const pw = "legit-password-1"
	u, err := svc.Register(ctx, email, pw, "O")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	// Owner proves the email themselves through the password flow's verification.
	if err := svc.store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatalf("verify: %v", err)
	}

	// Later they also request a magic link and use it.
	if err := svc.RequestMagicLink(ctx, email); err != nil {
		t.Fatalf("request magic link: %v", err)
	}
	if _, err := svc.VerifyMagicLink(ctx, tokenFromLink(t, mail.magic)); err != nil {
		t.Fatalf("verify magic link: %v", err)
	}

	// Their trusted password must survive.
	if has, err := svc.store.HasPassword(ctx, u.ID); err != nil || !has {
		t.Fatalf("verified user's password was wrongly dropped (has=%v err=%v)", has, err)
	}
	if _, err := svc.Login(ctx, email, pw); err != nil {
		t.Fatalf("verified user can no longer log in with their password: %v", err)
	}
}
