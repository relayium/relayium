package account

import (
	"context"

	"github.com/relayium/relayium/authx"
)

// Password reset and password change, each as ONE transaction.
//
// Both used to be a run of independent statements issued by the service: spend
// the token, write the hash, mark the email verified, revoke the sessions. A
// failure between two of them — a database error, a request context cancelled by
// a disconnecting client, a restart — left the new password live and every older
// session valid, including the one an attacker holds, while the caller was told
// the operation had failed. Signing in with the new password revokes nothing, so
// the state did not heal on its own.
//
// Here every statement commits together or not at all, and a reset that does not
// commit leaves the link unspent, so the retry the user is invited to make works.

// ResetPasswordWithToken spends a reset token and, in the same transaction,
// replaces the password, marks the email verified and revokes EVERY session of
// the token's user.
//
// ResetTokenInvalid and ResetAccountFrozen both mean nothing was changed and the
// token was NOT spent. The token is spent by the same conditional UPDATE
// UseEmailToken runs, so of two concurrent resets with one link exactly one
// commits. The account-state guard is on the password statement itself: an
// account that entered pending deletion after the service's own check must not
// have its password replaced, and rolling back here hands the token, still
// unspent, to the frozen-account path.
func (s *SQLiteStore) ResetPasswordWithToken(ctx context.Context, tokenHash string, now int64, passwordHash string) (ResetOutcome, string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ResetTokenInvalid, "", err
	}
	defer tx.Rollback() // no-op after a successful Commit

	res, err := tx.ExecContext(ctx,
		`UPDATE email_tokens SET used_at = ?
		 WHERE token_hash = ? AND purpose = 'reset' AND used_at = 0 AND expires_at > ?`,
		now, tokenHash, now)
	if err != nil {
		return ResetTokenInvalid, "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ResetTokenInvalid, "", nil
	}
	var userID string
	if err := tx.QueryRowContext(ctx,
		`SELECT user_id FROM email_tokens WHERE token_hash = ?`, tokenHash,
	).Scan(&userID); err != nil {
		return ResetTokenInvalid, "", err
	}
	res, err = tx.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ? AND deleted_at = 0`, passwordHash, userID)
	if err != nil {
		return ResetTokenInvalid, "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ResetAccountFrozen, userID, nil
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET email_verified = 1 WHERE id = ?`, userID); err != nil {
		return ResetTokenInvalid, "", err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE sessions SET revoked = 1 WHERE user_id = ?`, userID); err != nil {
		return ResetTokenInvalid, "", err
	}
	if err := tx.Commit(); err != nil {
		return ResetTokenInvalid, "", err
	}
	return ResetApplied, userID, nil
}

// ChangePasswordAndRevokeSessions replaces the password, links the "password"
// identity when linkSubject is non-empty (a first password), and revokes every
// session except exceptSessionID — all or nothing.
//
// exceptSessionID is the raw session token; sessions are keyed by its hash, and
// comparing the raw value would revoke the caller's own session too.
func (s *SQLiteStore) ChangePasswordAndRevokeSessions(ctx context.Context, userID, passwordHash, linkSubject, exceptSessionID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after a successful Commit

	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, userID); err != nil {
		return err
	}
	if linkSubject != "" {
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)`,
			"password", linkSubject, userID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id <> ?`,
		userID, authx.HashToken(exceptSessionID)); err != nil {
		return err
	}
	return tx.Commit()
}
