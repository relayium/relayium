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
// replaces the password, marks the email verified and revokes EVERY session and
// every app/CLI bearer of the token's user.
//
// ResetTokenInvalid and ResetAccountFrozen both mean nothing was changed and the
// token was NOT spent. The token is spent by the same conditional UPDATE
// UseEmailToken runs, so of two concurrent resets with one link exactly one
// commits. The account-state guard is on the password statement itself: an
// account that entered pending deletion after the service's own check must not
// have its password replaced, and rolling back here hands the token, still
// unspent, to the frozen-account path.
func (s *SQLiteStore) ResetPasswordWithToken(ctx context.Context, tokenHash string, now int64, passwordHash string) (ResetOutcome, string, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	defer tx.Rollback() // no-op after a successful Commit

	res, err := tx.ExecContext(ctx,
		`UPDATE email_tokens SET used_at = ?
		 WHERE token_hash = ? AND purpose = 'reset' AND used_at = 0 AND expires_at > ?`,
		now, tokenHash, now)
	if err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ResetTokenInvalid, "", 0, nil
	}
	var userID string
	if err := tx.QueryRowContext(ctx,
		`SELECT user_id FROM email_tokens WHERE token_hash = ?`, tokenHash,
	).Scan(&userID); err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	res, err = tx.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ? AND deleted_at = 0`, passwordHash, userID)
	if err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ResetAccountFrozen, userID, 0, nil
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET email_verified = 1 WHERE id = ?`, userID); err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE sessions SET revoked = 1 WHERE user_id = ?`, userID); err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	// Every app/CLI bearer goes with the sessions: a reset is how a stolen
	// device recovers, and a bearer is a full account credential. Browser
	// sending identities stay — they authenticate nothing without a session
	// (UserFromAuth refuses rlm_web_), and the sessions are revoked here.
	// Device rows, their Inbox enrolments and tasks stay: signing in again on
	// an installation re-binds its row (install_id). An approved but unclaimed
	// device-code login cannot be claimed any more, because ConsumeDeviceAuth
	// joins the live cli_tokens row this deletes.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM cli_tokens WHERE user_id = ? AND device_id NOT IN
		   (SELECT id FROM devices WHERE user_id = ? AND kind = 'browser')`, userID, userID); err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET credential_epoch = credential_epoch + 1 WHERE id = ?`, userID); err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	// The epoch this reset wrote: the session the service then issues to the
	// person resetting is inserted only while it is still current, so a second
	// reset/change committing in between also revokes that session.
	var epoch int64
	if err := tx.QueryRowContext(ctx,
		`SELECT credential_epoch FROM users WHERE id = ?`, userID).Scan(&epoch); err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	if err := tx.Commit(); err != nil {
		return ResetTokenInvalid, "", 0, err
	}
	return ResetApplied, userID, epoch, nil
}

// ChangePasswordAndRevokeSessions replaces the password, links the "password"
// identity when linkSubject is non-empty (a first password), and revokes every
// session except exceptSessionID and every app/CLI bearer — all or nothing.
//
// exceptSessionID is the raw session token; sessions are keyed by its hash, and
// comparing the raw value would revoke the caller's own session too.
//
// expectEpoch is the credential_epoch the caller read before verifying the
// current password. If a reset/change has committed since, the caller's session
// and old password were revoked by it, and this change must not overwrite that
// reset's password: nothing is written and ErrCredentialsChanged is returned.
func (s *SQLiteStore) ChangePasswordAndRevokeSessions(ctx context.Context, userID, passwordHash, linkSubject, exceptSessionID string, expectEpoch int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after a successful Commit

	res, err := tx.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ? AND credential_epoch = ?`, passwordHash, userID, expectEpoch)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return ErrCredentialsChanged
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
	// Every app/CLI bearer goes with the sessions: a reset is how a stolen
	// device recovers, and a bearer is a full account credential. Browser
	// sending identities stay — they authenticate nothing without a session
	// (UserFromAuth refuses rlm_web_), and the sessions are revoked here.
	// Device rows, their Inbox enrolments and tasks stay: signing in again on
	// an installation re-binds its row (install_id). An approved but unclaimed
	// device-code login cannot be claimed any more, because ConsumeDeviceAuth
	// joins the live cli_tokens row this deletes.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM cli_tokens WHERE user_id = ? AND device_id NOT IN
		   (SELECT id FROM devices WHERE user_id = ? AND kind = 'browser')`, userID, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET credential_epoch = credential_epoch + 1 WHERE id = ?`, userID); err != nil {
		return err
	}
	return tx.Commit()
}
