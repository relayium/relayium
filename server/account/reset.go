package account

import (
	"context"
	"fmt"
	"net/mail"
	"net/url"

	"golang.org/x/crypto/bcrypt"

	"github.com/relayium/relayium/authx"
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
	raw := authx.RandToken()
	now := s.now()
	tok := EmailToken{
		TokenHash: authx.HashToken(raw),
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
	// Invariant: a password that cannot be stored never consumes the token.
	// UseEmailToken below spends it irreversibly, so an input the hasher would
	// reject must be rejected here — otherwise one bad submission burns the
	// user's only recovery link and changes nothing.
	//
	// Hashing itself stays below the token check on purpose: this endpoint is
	// unauthenticated and unthrottled, so bcrypt must not be reachable with a
	// bogus token. With the range enforced here, the only remaining hash failure
	// mode is a bad cost, and the cost is a constant.
	if err := validateNewPassword(newPassword); err != nil {
		return Session{}, err
	}
	// The token is only LOOKED AT here. Spending it happens inside the same
	// transaction as the password write and the session revocation below, so an
	// interruption anywhere leaves the link usable and the account untouched
	// instead of a new password with every old session still valid. The peek is
	// what keeps bcrypt out of reach of a bogus, expired or spent token.
	tokenHash := authx.HashToken(rawToken)
	tok, ok, err := s.store.PeekEmailToken(ctx, tokenHash, "reset", s.now().Unix())
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrInvalidToken
	}
	// Frozen-account guard (blocker fix, mirrors Task 4's login-path guards): a
	// pending-deletion account must not get a live session via password reset
	// either, and its password must not be silently changed while frozen — GC
	// still hard-purges it on schedule regardless, and reactivation is the only
	// path meant to bring it back. The link is spent on this path, as before.
	u, err := s.store.GetUserByID(ctx, tok.UserID)
	if err != nil {
		return Session{}, err
	}
	if u.DeletedAt > 0 {
		return s.refuseResetOfFrozenAccount(ctx, tokenHash, u)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return Session{}, err
	}
	outcome, userID, epoch, err := s.store.ResetPasswordWithToken(ctx, tokenHash, s.now().Unix(), string(hash))
	if err != nil {
		return Session{}, err
	}
	switch outcome {
	case ResetApplied:
	case ResetAccountFrozen:
		// Deletion was requested between the check above and the transaction,
		// which rolled back without spending the link.
		frozen, err := s.store.GetUserByID(ctx, userID)
		if err != nil {
			return Session{}, err
		}
		return s.refuseResetOfFrozenAccount(ctx, tokenHash, frozen)
	default:
		// Another request spent the link while this one was hashing.
		return Session{}, ErrInvalidToken
	}
	// Outside the transaction on purpose: if this fails, everything above is
	// committed and the user signs in with the new password. It is inserted at
	// the epoch this reset wrote, so a later reset/change that commits first
	// leaves no session behind it.
	now := s.now()
	sess := Session{
		ID:        authx.RandToken(),
		UserID:    userID,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.SessionTTL).Unix(),
	}
	issued, err := s.store.CreateSessionAtEpoch(ctx, sess, epoch)
	if err != nil {
		return Session{}, err
	}
	if !issued {
		return Session{}, ErrCredentialsChanged
	}
	return sess, nil
}

// refuseResetOfFrozenAccount spends the reset link and answers with the
// reactivation offer, leaving the password alone.
func (s *Service) refuseResetOfFrozenAccount(ctx context.Context, tokenHash string, u User) (Session, error) {
	if _, ok, err := s.store.UseEmailToken(ctx, tokenHash, "reset", s.now().Unix()); err != nil {
		return Session{}, err
	} else if !ok {
		return Session{}, ErrInvalidToken
	}
	raw, err := s.issueReactivateToken(ctx, u.ID, u.Email)
	if err != nil {
		return Session{}, err
	}
	return Session{}, &PendingDeletionError{PurgeAfter: u.PurgeAfter, ReactivateToken: raw}
}
