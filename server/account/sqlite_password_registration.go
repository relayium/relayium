package account

import (
	"context"
	"database/sql"
	"time"

	"github.com/relayium/relayium/authx"
)

// InsertPasswordUserDedupedByCanonical creates a complete password account in
// one transaction: the canonical-email dedupe check, the users row, the password
// hash and the "password" identity.
//
// Invariant: either all three writes are visible or the address is still free.
// A partial account owns the address while being unusable — it cannot be logged
// into, re-registered, or recovered by password reset, which finds no password.
//
// Serialization is the one InsertUserDedupedByCanonical documents and
// ReserveUpload relies on: db.SetMaxOpenConns(1) means a second concurrent
// BeginTx waits for this transaction, so the SELECT sees the other caller's
// committed insert rather than a stale snapshot. That is what resolves N
// concurrent canonicalization-equivalent registrations to exactly one winner.
//
// The identity insert keeps LinkIdentity's OR IGNORE semantics verbatim, so
// this adds no new way for a registration to fail. A conflicting
// ("password", email) row is unreachable anyway: one is written only alongside
// its own users row, hard purge deletes identities with the user, and no
// email-change flow exists to strand one.
func (s *SQLiteStore) InsertPasswordUserDedupedByCanonical(ctx context.Context, email, displayName, canonical, passwordHash string) (User, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, false, err
	}
	defer tx.Rollback() // no-op after a successful Commit

	var existing string
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM users WHERE canonical_email = ? LIMIT 1`, canonical,
	).Scan(&existing)
	if err != nil && err != sql.ErrNoRows {
		return User{}, false, err
	}
	if err == nil {
		return User{}, true, nil
	}

	u := User{ID: authx.NewID(), Email: email, DisplayName: displayName, CreatedAt: time.Now().Unix()}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO users (id, email, display_name, created_at, canonical_email, billing_hold_hmac) VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, u.Email, u.DisplayName, u.CreatedAt, canonical, s.billingEmailHMAC(email)); err != nil {
		return User{}, false, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, u.ID); err != nil {
		return User{}, false, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)`,
		"password", email, u.ID); err != nil {
		return User{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, false, err
	}
	return u, false, nil
}
