package account

import (
	"context"
	"database/sql"

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
	if err := revokeOutstandingLoginLinks(ctx, tx, userID); err != nil {
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
	if err := revokeOutstandingLoginLinks(ctx, tx, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET credential_epoch = credential_epoch + 1 WHERE id = ?`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetFirstPasswordWithProof atomically consumes a fresh email proof and creates
// the first password. Every guard is inside this transaction so replay,
// cross-account use, expiry, an existing password, or an epoch race changes
// nothing and leaves no partially linked credential.
func (s *SQLiteStore) SetFirstPasswordWithProof(ctx context.Context, tokenHash, userID, passwordHash, linkSubject, exceptSessionID string, expectEpoch, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE email_tokens SET used_at = ?
		WHERE token_hash = ? AND purpose = 'set-password' AND user_id = ?
		AND credential_epoch = ? AND used_at = 0 AND expires_at > ?`,
		now, tokenHash, userID, expectEpoch, now)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return ErrInvalidToken
	}
	res, err = tx.ExecContext(ctx, `UPDATE users SET password_hash = ?
		WHERE id = ? AND password_hash IS NULL AND credential_epoch = ? AND deleted_at = 0`, passwordHash, userID, expectEpoch)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return ErrCredentialsChanged
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES ('password', ?, ?)`, linkSubject, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id <> ?`, userID, authx.HashToken(exceptSessionID)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM cli_tokens WHERE user_id = ? AND device_id NOT IN (SELECT id FROM devices WHERE user_id = ? AND kind = 'browser')`, userID, userID); err != nil {
		return err
	}
	if err := revokeOutstandingLoginLinks(ctx, tx, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET credential_epoch = credential_epoch + 1 WHERE id = ?`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// revokeOutstandingLoginLinks deletes, inside the caller's transaction, every
// unspent emailed link that would sign someone in as userID or set its
// password: other 'reset' links and magic sign-in links. A reset or change is
// how an account is taken back; a second reset link, or a magic link requested
// before it, would otherwise hand the account straight back to whoever else can
// still use one, bypassing the new password entirely.
//
// magic_tokens has no user_id (it is keyed by the login email — see
// PurgeTransientUserData), so it is matched on the user's current email, read
// in this same transaction.
//
// Deliberately NOT deleted:
//   - 'delete' links: they cannot sign anyone in or change a credential. They
//     confirm an account-deletion request made from a signed-in session and are
//     a bearer on their own (ConfirmAccountDeletion needs no session), so one
//     held by someone else could still schedule the account's deletion (undone
//     by the reactivate link mailed to the account). Dropping them here would
//     silently cancel a deletion the owner may have asked for; whether a
//     password change should do that is an open product decision, not a side
//     effect to add quietly. Pinned by TestPasswordChangeKeepsDeleteLink.
//   - 'verify' links: they only mark the address verified, which a reset does
//     anyway.
//   - 'reactivate' links: they exist only for an account in pending deletion,
//     where a reset is refused (ResetAccountFrozen) before reaching here.
func revokeOutstandingLoginLinks(ctx context.Context, tx *sql.Tx, userID string) error {
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset' AND used_at = 0`, userID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx,
		`DELETE FROM magic_tokens WHERE used_at = 0 AND email = (SELECT email FROM users WHERE id = ?)`, userID)
	return err
}
