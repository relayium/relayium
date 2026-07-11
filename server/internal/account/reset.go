package account

import (
	"context"
	"fmt"
	"net/mail"
	"net/url"

	"golang.org/x/crypto/bcrypt"
)

// RequestPasswordReset emails a reset link when the address has a password
// account. Unknown emails and passwordless accounts are a silent no-op so the
// endpoint never reveals whether an account exists.
func (s *Service) RequestPasswordReset(ctx context.Context, email string) error {
	email = normEmail(email)
	// Reject malformed addresses (e.g. embedded CRLF) before the mailer — defense
	// in depth against SMTP header injection. Silent, per the no-op contract above.
	if _, err := mail.ParseAddress(email); err != nil {
		return nil
	}
	uid, _, ok, err := s.store.GetCredentials(ctx, email)
	if err != nil {
		return err
	}
	if !ok {
		return nil // no password account: silent
	}
	raw := randToken()
	now := s.now()
	tok := EmailToken{
		TokenHash: hashToken(raw),
		UserID:    uid,
		Email:     email,
		Purpose:   "reset",
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.ResetTTL).Unix(),
	}
	if err := s.store.CreateEmailToken(ctx, tok); err != nil {
		return err
	}
	link := fmt.Sprintf("%s/reset-password?token=%s", s.cfg.BaseURL, url.QueryEscape(raw))
	return s.mailer.SendPasswordReset(ctx, email, link)
}

// ResetPassword consumes a reset token, sets the new password, revokes all of
// the user's sessions, marks the email verified (receiving the mail proves
// ownership), and issues a fresh session.
func (s *Service) ResetPassword(ctx context.Context, rawToken, newPassword string) (Session, error) {
	if len(newPassword) < minPasswordLen {
		return Session{}, ErrWeakPassword
	}
	tok, ok, err := s.store.UseEmailToken(ctx, hashToken(rawToken), "reset", s.now().Unix())
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrInvalidToken
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return Session{}, err
	}
	if err := s.store.SetPassword(ctx, tok.UserID, string(hash)); err != nil {
		return Session{}, err
	}
	if err := s.store.SetEmailVerified(ctx, tok.UserID); err != nil {
		return Session{}, err
	}
	if err := s.store.RevokeUserSessions(ctx, tok.UserID, ""); err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, tok.UserID)
}
