package account

import (
	"context"
	"fmt"
	"net/url"
)

// SendVerifyEmail issues a one-time verification token for u and emails the link.
func (s *Service) SendVerifyEmail(ctx context.Context, u User) error {
	raw := randToken()
	now := s.now()
	tok := EmailToken{
		TokenHash: hashToken(raw),
		UserID:    u.ID,
		Email:     normEmail(u.Email),
		Purpose:   "verify",
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.VerifyTTL).Unix(),
	}
	if err := s.store.CreateEmailToken(ctx, tok); err != nil {
		return err
	}
	link := fmt.Sprintf("%s/verify-email?token=%s", s.cfg.BaseURL, url.QueryEscape(raw))
	return s.mailer.SendVerifyEmail(ctx, u.Email, link)
}

// VerifyEmail consumes a verify token, marks the user verified, and issues a
// session. password (optional) is the one the user set at registration: it is
// used only to CONFIRM a registration-time password so it can be kept — an
// unconfirmed one is dropped (see reconcileUnverifiedPassword), closing the
// pre-hijack variant where a victim's click would activate an attacker's
// password. Passwordless (magic/OAuth) verifications pass "".
func (s *Service) VerifyEmail(ctx context.Context, rawToken, password string) (Session, error) {
	tok, ok, err := s.store.UseEmailToken(ctx, hashToken(rawToken), "verify", s.now().Unix())
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrInvalidToken
	}
	// Frozen-account guard (blocker fix, mirrors Task 4's login-path guards):
	// effectively unreachable today (a pending-delete account is already
	// email-verified, and resend only targets unverified accounts), but this
	// closes the same one-line gap as ResetPassword/Login/VerifyMagicLink for
	// defense-in-depth, in case a future path lets an unverified account reach
	// pending-deletion.
	u, err := s.store.GetUserByID(ctx, tok.UserID)
	if err != nil {
		return Session{}, err
	}
	if u.DeletedAt > 0 {
		raw, terr := s.issueReactivateToken(ctx, u.ID, u.Email)
		if terr != nil {
			return Session{}, terr
		}
		return Session{}, &PendingDeletionError{PurgeAfter: u.PurgeAfter, ReactivateToken: raw}
	}
	// Keep the registration password only if the verifier proves they set it;
	// otherwise drop it (pre-hijack defense). MUST run before SetEmailVerified.
	if err := s.reconcileUnverifiedPassword(ctx, u, password); err != nil {
		return Session{}, err
	}
	if err := s.store.SetEmailVerified(ctx, tok.UserID); err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, tok.UserID)
}
