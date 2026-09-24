package account

import (
	"context"
	"errors"
	"fmt"
	"net/url"

	"github.com/relayium/relayium/authx"
)

// SendVerifyEmail issues a one-time verification token for u and emails the link.
func (s *Service) SendVerifyEmail(ctx context.Context, u User) error {
	raw := authx.RandToken()
	now := s.now()
	tok := EmailToken{
		TokenHash: authx.HashToken(raw),
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

// VerifyOutcome is what VerifyEmailWithToken did. Only VerifyApplied changed
// anything; the other two left the account and the token exactly as they were.
type VerifyOutcome int

const (
	// VerifyTokenInvalid: no unspent, unexpired verify token has this hash — or
	// another request spent it first.
	VerifyTokenInvalid VerifyOutcome = iota
	// VerifyApplied: token spent, unconfirmed password dropped (if asked),
	// email verified and the session inserted — committed together.
	VerifyApplied
	// VerifyAccountFrozen: the account is pending deletion; nothing changed.
	VerifyAccountFrozen
)

// verifyMismatchKey namespaces the per-link mismatch counter inside pwLogins.
// The "|" separated email+IP login keys never start with this prefix.
func verifyMismatchKey(tokenHash string) string { return "verify-link|" + tokenHash }

// VerifyEmail verifies the address behind a verify link, marks the user
// verified, and issues a session. password is the one the user set at
// registration: the matching one keeps it, "" is the explicit "continue without
// a password" choice and drops it (pre-hijack defense), and any other non-empty
// value is ErrVerifyPasswordMismatch with nothing changed (see
// verifyDropsPassword). Passwordless (magic/OAuth) verifications pass "".
//
// Invariants (A29 R1/R1b):
//   - Spending the link, dropping the password, setting email_verified and
//     inserting the session commit together in VerifyEmailWithToken, or none of
//     them does. Any failure — a database error, SQLITE_BUSY, a cancelled
//     request — leaves the link unspent and the account unchanged, so the
//     retry the user is invited to make works. In particular the account can
//     no longer end up unverified + passwordless + link spent, nor verified
//     and passwordless without the session that was its only way in.
//   - The token is only PEEKED before the transaction, which keeps bcrypt out
//     of reach of a bogus, expired or spent token; the transaction's
//     conditional UPDATE is what spends it, so two concurrent submissions of
//     one link yield exactly one success.
//   - A mismatched password spends nothing. After a few mismatches on one link
//     (the pwLogins threshold) the link is spent so it cannot serve as an
//     unlimited guessing oracle for the registration password; the password
//     is left intact, so resend and reset keep working.
func (s *Service) VerifyEmail(ctx context.Context, rawToken, password string) (Session, error) {
	tokenHash := authx.HashToken(rawToken)
	tok, ok, err := s.store.PeekEmailToken(ctx, tokenHash, "verify", s.now().Unix())
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
		return s.refuseVerifyOfFrozenAccount(ctx, tokenHash, u)
	}
	dropPassword, err := s.verifyDropsPassword(ctx, u, password)
	if errors.Is(err, ErrVerifyPasswordMismatch) {
		return Session{}, s.recordVerifyMismatch(ctx, tokenHash)
	}
	if err != nil {
		return Session{}, err
	}
	now := s.now()
	sess := Session{
		ID:        authx.RandToken(),
		UserID:    tok.UserID,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.SessionTTL).Unix(),
	}
	outcome, userID, err := s.store.VerifyEmailWithToken(ctx, tokenHash, now.Unix(), dropPassword, sess)
	if err != nil {
		return Session{}, err
	}
	switch outcome {
	case VerifyApplied:
		s.pwLogins.reset(verifyMismatchKey(tokenHash))
		return sess, nil
	case VerifyAccountFrozen:
		// Deletion was requested between the check above and the transaction,
		// which rolled back without spending the link.
		frozen, err := s.store.GetUserByID(ctx, userID)
		if err != nil {
			return Session{}, err
		}
		return s.refuseVerifyOfFrozenAccount(ctx, tokenHash, frozen)
	default:
		// Another request spent the link first.
		return Session{}, ErrInvalidToken
	}
}

// recordVerifyMismatch counts a mismatched password against one verify link.
// Below the threshold nothing changes and ErrVerifyPasswordMismatch is
// returned; at the threshold the link is spent (the account, its password
// included, is left as it was) and ErrInvalidToken is returned.
func (s *Service) recordVerifyMismatch(ctx context.Context, tokenHash string) error {
	key := verifyMismatchKey(tokenHash)
	now := s.now()
	s.pwLogins.recordFail(key, now)
	if !s.pwLogins.locked(key, now) {
		return ErrVerifyPasswordMismatch
	}
	if _, _, err := s.store.UseEmailToken(ctx, tokenHash, "verify", now.Unix()); err != nil {
		return err
	}
	s.pwLogins.reset(key)
	return ErrInvalidToken
}

// refuseVerifyOfFrozenAccount spends the verify link and answers with the
// reactivation offer, leaving the account alone.
func (s *Service) refuseVerifyOfFrozenAccount(ctx context.Context, tokenHash string, u User) (Session, error) {
	if _, ok, err := s.store.UseEmailToken(ctx, tokenHash, "verify", s.now().Unix()); err != nil {
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
