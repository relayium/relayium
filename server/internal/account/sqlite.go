package account

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type SQLiteStore struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  canonical_email TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject  TEXT NOT NULL,
  user_id  TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (provider, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS magic_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_events (
  alloc_id      TEXT PRIMARY KEY,
  token         TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  relayed_bytes INTEGER NOT NULL,
  recorded_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id);
CREATE TABLE IF NOT EXISTS stored_files (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  blob_key        TEXT NOT NULL,
  enc_manifest    BLOB NOT NULL,
  size            INTEGER NOT NULL,
  burn_after_read INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  downloaded_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stored_files_user ON stored_files(user_id);
CREATE INDEX IF NOT EXISTS idx_stored_files_expires ON stored_files(expires_at);
CREATE TABLE IF NOT EXISTS upload_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  bytes       INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_events_user ON upload_events(user_id, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_usage_recorded ON usage_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_upload_uploaded ON upload_events(uploaded_at);
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_stats (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  transfers_total INTEGER NOT NULL DEFAULT 0,
  downloads_total INTEGER NOT NULL DEFAULT 0,
  upload_bytes    INTEGER NOT NULL DEFAULT 0,
  download_bytes  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id        TEXT    NOT NULL REFERENCES users(id),
  period         TEXT    NOT NULL,
  upload_bytes   INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, period)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_period ON usage_monthly(period);
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id);
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  owner_type    TEXT NOT NULL,
  owner_user_id TEXT,
  region        TEXT,
  urls          TEXT NOT NULL,
  turn_secret   TEXT NOT NULL,
  version       TEXT,
  relayed_bytes INTEGER NOT NULL DEFAULT 0,
  stored_bytes  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen_at);
CREATE TABLE IF NOT EXISTS pending_node_deletes (
  blob_key    TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (blob_key, node_id)
);
CREATE TABLE IF NOT EXISTS node_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  node_id      TEXT,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_node_tokens_user ON node_tokens(user_id);
CREATE TABLE IF NOT EXISTS fleet_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT,
  node_id      TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER NOT NULL DEFAULT 0
);
`

func OpenSQLite(dsn string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite + :memory: safety; fine for our write volume
	if _, err := db.ExecContext(context.Background(), schema); err != nil {
		db.Close()
		return nil, err
	}
	// password_hash 是初版之后新增的列。新库与老库都靠这一句补齐；
	// 列已存在时 SQLite 报 "duplicate column name"，幂等忽略。
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE users ADD COLUMN password_hash TEXT`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, err
	}
	// download_count is per-file lifetime download tally, added after the initial
	// stored_files schema. Same idempotent-ALTER pattern as password_hash above.
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE stored_files ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, err
	}
	// SP2: node storage fields + stored_files.node_id, added after the initial
	// nodes/stored_files schemas. Same idempotent-ALTER pattern as above.
	for _, alter := range []string{
		`ALTER TABLE nodes ADD COLUMN storage_url TEXT`,
		`ALTER TABLE nodes ADD COLUMN storage_secret TEXT`,
		`ALTER TABLE nodes ADD COLUMN storage_enabled INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE nodes ADD COLUMN storage_total INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE nodes ADD COLUMN storage_free INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE stored_files ADD COLUMN node_id TEXT`,
		// SP3: usage_events gains node_id (which node reported this) + billable
		// (fleet-relay vs. BYO own-node relay, which must not count against quota).
		`ALTER TABLE usage_events ADD COLUMN node_id TEXT`,
		`ALTER TABLE usage_events ADD COLUMN billable INTEGER NOT NULL DEFAULT 1`,
		// SP3: only_own_nodes restricts a user's transfers to their own
		// self-hosted nodes, excluding the shared fleet.
		`ALTER TABLE users ADD COLUMN only_own_nodes INTEGER NOT NULL DEFAULT 0`,
		// Admin-set per-node hard caps for official nodes (0 = unlimited):
		// monthly relay traffic and disk usage.
		`ALTER TABLE nodes ADD COLUMN traffic_limit_bytes INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE nodes ADD COLUMN disk_limit_bytes INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := db.ExecContext(context.Background(), alter); err != nil &&
			!strings.Contains(err.Error(), "duplicate column name") {
			db.Close()
			return nil, err
		}
	}
	// email_verified 是本次新增列。首次成功 ALTER（err==nil）说明刚建列，
	// 此刻把所有存量老用户一次性兜底为已验证（避免现网用户被"必须验证才能登录"锁死）。
	// 之后新注册的行按 DEFAULT 0 走验证流程；列已存在时幂等跳过。
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			db.Close()
			return nil, err
		}
	} else if _, err := db.ExecContext(context.Background(),
		`UPDATE users SET email_verified = 1`); err != nil {
		db.Close()
		return nil, err
	}
	// canonical_email backs the anti-Sybil register dedupe (H2b). Freshly added
	// (err==nil) → backfill every existing row's canonical form once; duplicate
	// column name → already migrated, skip.
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE users ADD COLUMN canonical_email TEXT NOT NULL DEFAULT ''`); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			db.Close()
			return nil, err
		}
	} else if err := backfillCanonicalEmail(context.Background(), db); err != nil {
		db.Close()
		return nil, err
	}
	// Non-unique: two legacy accounts may already share a canonical form (see H2b
	// dedupe rationale), so this can never be UNIQUE without risking a startup-time
	// migration failure on existing data. Created here (after the ALTER above), not
	// in the top-level schema string, because the column doesn't exist yet on a
	// legacy DB until that ALTER runs — creating the index any earlier would fail
	// with "no such column" on every upgrade.
	if _, err := db.ExecContext(context.Background(),
		`CREATE INDEX IF NOT EXISTS idx_users_canonical_email ON users(canonical_email)`); err != nil {
		db.Close()
		return nil, err
	}
	// The transfers table backed the retired share-link mode (one-time
	// rendezvous tokens). Dropping it is idempotent and safe: tokens lived
	// at most one hour, so nothing in an existing deployment still needs it.
	if _, err := db.ExecContext(context.Background(),
		`DROP TABLE IF EXISTS transfers`); err != nil {
		db.Close()
		return nil, err
	}
	return &SQLiteStore{db: db}, nil
}

// backfillCanonicalEmail populates canonical_email for pre-existing rows the
// one time the column is created. Runs on a freshly-migrated legacy DB only.
func backfillCanonicalEmail(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `SELECT id, email FROM users`)
	if err != nil {
		return err
	}
	type ue struct{ id, email string }
	var all []ue
	for rows.Next() {
		var u ue
		if err := rows.Scan(&u.id, &u.email); err != nil {
			rows.Close()
			return err
		}
		all = append(all, u)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, u := range all {
		if _, err := db.ExecContext(ctx,
			`UPDATE users SET canonical_email = ? WHERE id = ?`,
			canonicalEmail(u.email), u.id); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLiteStore) Close() error { return s.db.Close() }

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("account: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func normEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

func (s *SQLiteStore) UpsertUserByEmail(ctx context.Context, email, displayName string) (User, error) {
	email = normEmail(email)
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified FROM users WHERE email = ?`, email,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified)
	if err == nil {
		return u, nil
	}
	if err != sql.ErrNoRows {
		return User{}, err
	}
	u = User{ID: newID(), Email: email, DisplayName: displayName, CreatedAt: time.Now().Unix()}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO users (id, email, display_name, created_at, canonical_email) VALUES (?, ?, ?, ?, ?)`,
		u.ID, u.Email, u.DisplayName, u.CreatedAt, canonicalEmail(email))
	return u, err
}

// UserByCanonicalEmail finds any existing account whose canonical_email matches
// (H2b register dedupe). Multiple legacy exact-emails may share a canonical form,
// so this returns the first match only — enough to answer "does one exist".
func (s *SQLiteStore) UserByCanonicalEmail(ctx context.Context, canonical string) (User, bool, error) {
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified
		   FROM users WHERE canonical_email = ? LIMIT 1`, canonical,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified)
	if err == sql.ErrNoRows {
		return User{}, false, nil
	}
	if err != nil {
		return User{}, false, err
	}
	return u, true, nil
}

// InsertUserDedupedByCanonical checks canonical_email and inserts the new user
// inside one transaction (H2b anti-Sybil register dedupe). With
// db.SetMaxOpenConns(1) the pool hands out a single physical connection, so a
// second concurrent call's BeginTx blocks until the first Commits/Rollbacks —
// the same serialization ReserveUpload relies on — meaning the SELECT a second
// caller sees always reflects the first caller's already-committed INSERT (or
// its rollback), never a stale pre-insert snapshot.
func (s *SQLiteStore) InsertUserDedupedByCanonical(ctx context.Context, email, displayName, canonical string) (User, bool, error) {
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

	u := User{ID: newID(), Email: email, DisplayName: displayName, CreatedAt: time.Now().Unix()}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO users (id, email, display_name, created_at, canonical_email) VALUES (?, ?, ?, ?, ?)`,
		u.ID, u.Email, u.DisplayName, u.CreatedAt, canonical); err != nil {
		return User{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, false, err
	}
	return u, false, nil
}

func (s *SQLiteStore) GetUserByID(ctx context.Context, id string) (User, error) {
	var u User
	var strict int
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, only_own_nodes FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict)
	if err == sql.ErrNoRows {
		return User{}, ErrNotFound
	}
	u.OnlyOwnNodes = strict != 0
	return u, err
}

func (s *SQLiteStore) SetOnlyOwnNodes(ctx context.Context, userID string, on bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET only_own_nodes = ? WHERE id = ?`, b2i(on), userID)
	return err
}

func (s *SQLiteStore) LinkIdentity(ctx context.Context, provider, subject, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO identities (provider, subject, user_id) VALUES (?, ?, ?)`,
		provider, subject, userID)
	return err
}

func (s *SQLiteStore) GetUserByIdentity(ctx context.Context, provider, subject string) (User, bool, error) {
	var uid string
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id FROM identities WHERE provider = ? AND subject = ?`, provider, subject,
	).Scan(&uid)
	if err == sql.ErrNoRows {
		return User{}, false, nil
	}
	if err != nil {
		return User{}, false, err
	}
	u, err := s.GetUserByID(ctx, uid)
	return u, err == nil, err
}

func (s *SQLiteStore) CreateSession(ctx context.Context, sess Session) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)`,
		sess.ID, sess.UserID, sess.CreatedAt, sess.ExpiresAt)
	return err
}

func (s *SQLiteStore) GetSession(ctx context.Context, id string) (Session, bool, error) {
	var sess Session
	var revoked int
	err := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, created_at, expires_at, revoked FROM sessions WHERE id = ?`, id,
	).Scan(&sess.ID, &sess.UserID, &sess.CreatedAt, &sess.ExpiresAt, &revoked)
	if err == sql.ErrNoRows {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, err
	}
	if revoked != 0 {
		return sess, false, nil
	}
	sess.Revoked = false
	return sess, true, nil
}

func (s *SQLiteStore) RevokeSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET revoked = 1 WHERE id = ?`, id)
	return err
}

// RevokeUserSessions revokes every session of userID except exceptID.
func (s *SQLiteStore) RevokeUserSessions(ctx context.Context, userID, exceptID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id <> ?`, userID, exceptID)
	return err
}

// DeleteExpiredSessions reclaims session rows that can no longer authenticate:
// past their expiry or explicitly revoked. Both are already rejected by
// GetSession, so deleting them changes nothing but bounds table growth.
func (s *SQLiteStore) DeleteExpiredSessions(ctx context.Context, now int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM sessions WHERE expires_at < ? OR revoked <> 0`, now)
	return err
}

func (s *SQLiteStore) CreateMagicToken(ctx context.Context, t MagicToken) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO magic_tokens (token_hash, email, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, 0)`,
		t.TokenHash, normEmail(t.Email), t.CreatedAt, t.ExpiresAt)
	return err
}

func (s *SQLiteStore) UseMagicToken(ctx context.Context, tokenHash string, now int64) (MagicToken, bool, error) {
	// Atomically claim the token: only succeeds if unused and unexpired.
	res, err := s.db.ExecContext(ctx,
		`UPDATE magic_tokens SET used_at = ? WHERE token_hash = ? AND used_at = 0 AND expires_at > ?`,
		now, tokenHash, now)
	if err != nil {
		return MagicToken{}, false, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return MagicToken{}, false, nil
	}
	var t MagicToken
	err = s.db.QueryRowContext(ctx,
		`SELECT token_hash, email, created_at, expires_at, used_at FROM magic_tokens WHERE token_hash = ?`, tokenHash,
	).Scan(&t.TokenHash, &t.Email, &t.CreatedAt, &t.ExpiresAt, &t.UsedAt)
	return t, err == nil, err
}

// DeleteSpentMagicTokens reclaims one-time login tokens that are no longer
// usable: already redeemed (used_at != 0) or expired. UseMagicToken already
// refuses these, so removal is pure garbage collection.
func (s *SQLiteStore) DeleteSpentMagicTokens(ctx context.Context, now int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM magic_tokens WHERE used_at <> 0 OR expires_at < ?`, now)
	return err
}

func (s *SQLiteStore) CreateEmailToken(ctx context.Context, t EmailToken) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO email_tokens (token_hash, user_id, email, purpose, created_at, expires_at, used_at)
		 VALUES (?, ?, ?, ?, ?, ?, 0)`,
		t.TokenHash, t.UserID, normEmail(t.Email), t.Purpose, t.CreatedAt, t.ExpiresAt)
	return err
}

func (s *SQLiteStore) UseEmailToken(ctx context.Context, tokenHash, purpose string, now int64) (EmailToken, bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE email_tokens SET used_at = ?
		 WHERE token_hash = ? AND purpose = ? AND used_at = 0 AND expires_at > ?`,
		now, tokenHash, purpose, now)
	if err != nil {
		return EmailToken{}, false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return EmailToken{}, false, nil
	}
	var t EmailToken
	err = s.db.QueryRowContext(ctx,
		`SELECT token_hash, user_id, email, purpose, created_at, expires_at, used_at
		   FROM email_tokens WHERE token_hash = ?`, tokenHash,
	).Scan(&t.TokenHash, &t.UserID, &t.Email, &t.Purpose, &t.CreatedAt, &t.ExpiresAt, &t.UsedAt)
	return t, err == nil, err
}

func (s *SQLiteStore) DeleteSpentEmailTokens(ctx context.Context, now int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM email_tokens WHERE used_at <> 0 OR expires_at < ?`, now)
	return err
}

func (s *SQLiteStore) UpsertDevice(ctx context.Context, d Device) (Device, error) {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (id, user_id, name, created_at, last_seen_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name
		 WHERE devices.user_id = excluded.user_id`,
		d.ID, d.UserID, d.Name, d.CreatedAt, d.LastSeenAt)
	if err != nil {
		return Device{}, err
	}
	var out Device
	err = s.db.QueryRowContext(ctx,
		`SELECT id, user_id, name, created_at, last_seen_at FROM devices WHERE id = ? AND user_id = ?`,
		d.ID, d.UserID,
	).Scan(&out.ID, &out.UserID, &out.Name, &out.CreatedAt, &out.LastSeenAt)
	return out, err
}

func (s *SQLiteStore) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, name, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.CreatedAt, &d.LastSeenAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) RenameDevice(ctx context.Context, id, userID, name string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE devices SET name = ? WHERE id = ? AND user_id = ?`, name, id, userID)
	return err
}

func (s *SQLiteStore) DeleteDevice(ctx context.Context, id, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM devices WHERE id = ? AND user_id = ?`, id, userID)
	return err
}

func (s *SQLiteStore) RecordUsage(ctx context.Context, e UsageEvent) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO usage_events (alloc_id, token, user_id, relayed_bytes, recorded_at, node_id, billable)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(alloc_id) DO UPDATE SET
		   relayed_bytes = MAX(relayed_bytes, excluded.relayed_bytes),
		   recorded_at = excluded.recorded_at`,
		e.AllocID, e.Token, e.UserID, e.RelayedBytes, e.RecordedAt, nullStr(e.NodeID), b2i(e.Billable))
	return err
}

func (s *SQLiteStore) UserUsageTotal(ctx context.Context, userID string) (int64, error) {
	var total sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT SUM(relayed_bytes) FROM usage_events WHERE user_id = ?`, userID,
	).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total.Int64, nil // SUM over no rows is NULL → 0
}

// UserRelayedSince sums a user's relayed bytes recorded at or after `since`
// (used for the interim monthly relay cap).
func (s *SQLiteStore) UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error) {
	var total int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE user_id = ? AND recorded_at >= ? AND billable = 1`,
		userID, since).Scan(&total)
	return total, err
}

func (s *SQLiteStore) SetPassword(ctx context.Context, userID, passwordHash string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, userID)
	return err
}

// HasPassword reports whether the user has a usable password hash set.
func (s *SQLiteStore) HasPassword(ctx context.Context, userID string) (bool, error) {
	var hash sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return hash.Valid && hash.String != "", nil
}

func (s *SQLiteStore) EmailVerified(ctx context.Context, userID string) (bool, error) {
	var v bool
	err := s.db.QueryRowContext(ctx,
		`SELECT email_verified FROM users WHERE id = ?`, userID).Scan(&v)
	if err == sql.ErrNoRows {
		return false, ErrNotFound
	}
	return v, err
}

func (s *SQLiteStore) SetEmailVerified(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET email_verified = 1 WHERE id = ?`, userID)
	return err
}

func (s *SQLiteStore) GetCredentials(ctx context.Context, email string) (string, string, bool, error) {
	email = normEmail(email)
	var uid string
	var hash sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, password_hash FROM users WHERE email = ?`, email,
	).Scan(&uid, &hash)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	if !hash.Valid || hash.String == "" {
		return uid, "", false, nil
	}
	return uid, hash.String, true, nil
}

// escapeLike 转义 LIKE 通配符,使搜索文本按字面匹配(配合 ESCAPE '\')。
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

func (s *SQLiteStore) AdminListUsers(ctx context.Context, q AdminUserQuery) ([]AdminUserRow, int64, error) {
	where := ""
	var whereArgs []any
	if q.Search != "" {
		where = ` WHERE (u.email LIKE ? ESCAPE '\' OR u.display_name LIKE ? ESCAPE '\')`
		like := "%" + escapeLike(q.Search) + "%"
		whereArgs = append(whereArgs, like, like)
	}

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users u`+where, whereArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	orderCol := "u.created_at"
	switch q.SortBy {
	case "email":
		orderCol = "u.email"
	case "relayed":
		orderCol = "relayed_bytes"
	case "upload":
		orderCol = "upload_bytes"
	case "download":
		orderCol = "download_bytes"
	case "storage":
		orderCol = "storage_bytes"
	}
	dir := "DESC"
	if strings.EqualFold(q.SortDir, "asc") {
		dir = "ASC"
	}

	mStart, mEnd := monthRange(q.Period)
	listArgs := append([]any{mStart, mEnd, q.Period, q.Period, q.Now}, whereArgs...)
	listArgs = append(listArgs, q.Limit, q.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.email, u.display_name, u.created_at,
		       (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id),
		       (SELECT COALESCE(SUM(e.relayed_bytes),0) FROM usage_events e
		          WHERE e.user_id = u.id AND e.recorded_at >= ? AND e.recorded_at < ?) AS relayed_bytes,
		       (SELECT COALESCE(SUM(um.upload_bytes),0) FROM usage_monthly um
		          WHERE um.user_id = u.id AND um.period = ?) AS upload_bytes,
		       (SELECT COALESCE(SUM(um.download_bytes),0) FROM usage_monthly um
		          WHERE um.user_id = u.id AND um.period = ?) AS download_bytes,
		       (SELECT COALESCE(SUM(sf.size),0) FROM stored_files sf
		          WHERE sf.user_id = u.id AND sf.expires_at > ?) AS storage_bytes
		FROM users u`+where+`
		ORDER BY `+orderCol+` `+dir+`, u.id ASC
		LIMIT ? OFFSET ?`, listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []AdminUserRow
	index := map[string]int{}
	for rows.Next() {
		var row AdminUserRow
		if err := rows.Scan(&row.ID, &row.Email, &row.DisplayName, &row.CreatedAt,
			&row.DeviceCount, &row.RelayedBytes,
			&row.UploadBytes, &row.DownloadBytes, &row.StorageBytes); err != nil {
			return nil, 0, err
		}
		index[row.ID] = len(out)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	// 单独一遍把 provider 摊到本页用户,避免 N+1;查询按本页 user_id 范围限定,避免全表扫描。
	if len(out) > 0 {
		ids := make([]any, len(out))
		ph := make([]string, len(out))
		for i := range out {
			ids[i] = out[i].ID
			ph[i] = "?"
		}
		irows, err := s.db.QueryContext(ctx,
			`SELECT user_id, provider FROM identities WHERE user_id IN (`+strings.Join(ph, ",")+`)`, ids...)
		if err != nil {
			return nil, 0, err
		}
		defer irows.Close()
		seen := map[string]map[string]bool{}
		for irows.Next() {
			var uid, provider string
			if err := irows.Scan(&uid, &provider); err != nil {
				return nil, 0, err
			}
			i, ok := index[uid]
			if !ok {
				continue
			}
			if seen[uid] == nil {
				seen[uid] = map[string]bool{}
			}
			if !seen[uid][provider] {
				seen[uid][provider] = true
				out[i].Methods = append(out[i].Methods, provider)
			}
		}
		if err := irows.Err(); err != nil {
			return nil, 0, err
		}
	}
	for i := range out {
		sort.Strings(out[i].Methods)
	}
	return out, total, nil
}

func (s *SQLiteStore) AdminMetrics(ctx context.Context, period string, now int64) (AdminMetrics, error) {
	start, end := monthRange(period)
	var m AdminMetrics
	err := s.db.QueryRowContext(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM users),
		  (SELECT COUNT(*) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(upload_bytes),0) FROM usage_monthly WHERE period = ?),
		  (SELECT COALESCE(SUM(download_bytes),0) FROM usage_monthly WHERE period = ?),
		  (SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE recorded_at >= ? AND recorded_at < ?)`,
		now, now, period, period, start, end,
	).Scan(&m.TotalUsers, &m.ActiveStoredFiles, &m.ActiveStoredBytes,
		&m.UploadBytes, &m.DownloadBytes, &m.RelayBytes)
	if err != nil {
		return AdminMetrics{}, err
	}
	return m, nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

type rowScanner interface{ Scan(dest ...any) error }

func scanStoredFile(sc rowScanner) (StoredFile, error) {
	var f StoredFile
	var burn int
	var nodeID sql.NullString
	err := sc.Scan(&f.ID, &f.UserID, &f.BlobKey, &f.EncManifest, &f.Size,
		&burn, &f.CreatedAt, &f.ExpiresAt, &f.DownloadedAt, &nodeID, &f.DownloadCount)
	f.BurnAfterRead = burn != 0
	f.NodeID = nodeID.String
	return f, err
}

// storedFileCols is the INSERT column list (CreateStoredFile). storedFileSelectCols
// adds download_count, which defaults to 0 on insert and is only ever read back.
const storedFileCols = `id, user_id, blob_key, enc_manifest, size, burn_after_read, created_at, expires_at, downloaded_at, node_id`
const storedFileSelectCols = storedFileCols + `, download_count`

func (s *SQLiteStore) CreateStoredFile(ctx context.Context, f StoredFile) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO stored_files (`+storedFileCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.UserID, f.BlobKey, f.EncManifest, f.Size,
		b2i(f.BurnAfterRead), f.CreatedAt, f.ExpiresAt, f.DownloadedAt, nullStr(f.NodeID))
	return err
}

func (s *SQLiteStore) GetStoredFile(ctx context.Context, id string) (StoredFile, error) {
	f, err := scanStoredFile(s.db.QueryRowContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return StoredFile{}, ErrNotFound
	}
	return f, err
}

func (s *SQLiteStore) ListStoredFilesByUser(ctx context.Context, userID string) ([]StoredFile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files WHERE user_id = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StoredFile
	for rows.Next() {
		f, err := scanStoredFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) MarkDownloaded(ctx context.Context, id string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE stored_files SET downloaded_at = ? WHERE id = ?`, at, id)
	return err
}

// ClaimBurnDownload atomically claims the one download of a burn-after-read file.
// The WHERE clause (burn_after_read=1 AND downloaded_at=0) means only the first
// concurrent UPDATE affects a row; RowsAffected==1 is the single winner.
func (s *SQLiteStore) ClaimBurnDownload(ctx context.Context, id string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE stored_files SET downloaded_at = ? WHERE id = ? AND burn_after_read = 1 AND downloaded_at = 0`,
		at, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

func (s *SQLiteStore) DeleteStoredFile(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM stored_files WHERE id = ?`, id)
	return err
}

// IncDownloadCount bumps a stored file's lifetime download tally by one. Used for
// non-burn files (burn rows are deleted on download); a no-op if the row is gone.
func (s *SQLiteStore) IncDownloadCount(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE stored_files SET download_count = download_count + 1 WHERE id = ?`, id)
	return err
}

// AddUploadStat records one upload against the user's lifetime counters. These
// are monotonic aggregates (never decremented, unaffected by file expiry/GC) and
// hold no per-event metadata — the privacy-minimal form that still supports
// snapshot-diff metering. Upserts the row on first activity.
func (s *SQLiteStore) AddUploadStat(ctx context.Context, userID string, bytes int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO user_stats (user_id, transfers_total, upload_bytes) VALUES (?, 1, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   transfers_total = transfers_total + 1,
		   upload_bytes = upload_bytes + excluded.upload_bytes`,
		userID, bytes)
	return err
}

// AddDownloadStat records one successful download against the file owner's
// lifetime counters (never the downloader — no downloader identity is touched).
func (s *SQLiteStore) AddDownloadStat(ctx context.Context, userID string, bytes int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO user_stats (user_id, downloads_total, download_bytes) VALUES (?, 1, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   downloads_total = downloads_total + 1,
		   download_bytes = download_bytes + excluded.download_bytes`,
		userID, bytes)
	return err
}

// GetUserStats returns the user's lifetime aggregate counters; a user with no
// activity yet has no row and reads back as all-zero.
func (s *SQLiteStore) GetUserStats(ctx context.Context, userID string) (UserStats, error) {
	var st UserStats
	err := s.db.QueryRowContext(ctx,
		`SELECT transfers_total, downloads_total, upload_bytes, download_bytes
		 FROM user_stats WHERE user_id = ?`, userID,
	).Scan(&st.TransfersTotal, &st.DownloadsTotal, &st.UploadBytes, &st.DownloadBytes)
	if err == sql.ErrNoRows {
		return UserStats{}, nil
	}
	return st, err
}

func (s *SQLiteStore) ListExpiredStoredFiles(ctx context.Context, now int64) ([]StoredFile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files WHERE expires_at < ?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StoredFile
	for rows.Next() {
		f, err := scanStoredFile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) RecordUpload(ctx context.Context, e UploadEvent) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO upload_events (id, user_id, bytes, uploaded_at) VALUES (?, ?, ?, ?)`,
		e.ID, e.UserID, e.Bytes, e.UploadedAt)
	return err
}

func (s *SQLiteStore) UserUploadedSince(ctx context.Context, userID string, since int64) (int64, error) {
	var total sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT SUM(bytes) FROM upload_events WHERE user_id = ? AND uploaded_at >= ?`,
		userID, since).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total.Int64, nil // SUM over no rows is NULL → 0
}

// ReserveUpload sums the rolling window, checks the quota, and inserts the event
// in one transaction. With MaxOpenConns(1) SQLite serializes writers, so two
// concurrent reservations can never both read a stale (pre-insert) sum and both
// pass the check — the loser sees the winner's committed row.
func (s *SQLiteStore) ReserveUpload(ctx context.Context, e UploadEvent, since, quota int64) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback() // no-op after a successful Commit
	var used sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT SUM(bytes) FROM upload_events WHERE user_id = ? AND uploaded_at >= ?`,
		e.UserID, since).Scan(&used); err != nil {
		return false, err
	}
	if used.Int64+e.Bytes > quota {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO upload_events (id, user_id, bytes, uploaded_at) VALUES (?, ?, ?, ?)`,
		e.ID, e.UserID, e.Bytes, e.UploadedAt); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func (s *SQLiteStore) PruneUploadEvents(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM upload_events WHERE uploaded_at < ?`, before)
	return err
}

func (s *SQLiteStore) GetSetting(ctx context.Context, key string) (int64, bool, error) {
	var v int64
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return v, true, nil
}

func (s *SQLiteStore) SetSetting(ctx context.Context, key string, value, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value, at)
	return err
}

// periodOf maps a unix timestamp to its billing month bucket 'YYYYMM' (UTC).
func periodOf(at int64) string { return time.Unix(at, 0).UTC().Format("200601") }

// monthRange returns [start, end) unix seconds for a 'YYYYMM' period (UTC).
// Returns (0,0) if period is malformed.
func monthRange(period string) (start, end int64) {
	t, err := time.Parse("200601", period)
	if err != nil {
		return 0, 0
	}
	return t.Unix(), t.AddDate(0, 1, 0).Unix()
}

// RecordMeter adds a one-shot upload/download event to the user's current-month
// bucket, creating the row on first use. Relay is NOT metered here (derived from
// usage_events). Callers treat this as best-effort.
func (s *SQLiteStore) RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error {
	var col string
	switch kind {
	case MeterUpload:
		col = "upload_bytes"
	case MeterDownload:
		col = "download_bytes"
	default:
		return fmt.Errorf("account: unknown usage kind %d", kind)
	}
	// col comes from a fixed switch above (never user input), so interpolating it
	// into the statement is safe; bytes/user/period stay parameterized.
	q := `INSERT INTO usage_monthly (user_id, period, ` + col + `, updated_at)
	      VALUES (?, ?, ?, ?)
	      ON CONFLICT(user_id, period) DO UPDATE SET
	        ` + col + ` = ` + col + ` + excluded.` + col + `,
	        updated_at = excluded.updated_at`
	_, err := s.db.ExecContext(ctx, q, userID, periodOf(at), bytes, at)
	return err
}

// MonthlyUsage returns the user's upload/download bytes for a 'YYYYMM' period
// (0,0 when there is no row).
func (s *SQLiteStore) MonthlyUsage(ctx context.Context, userID, period string) (upload, download int64, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT COALESCE(upload_bytes,0), COALESCE(download_bytes,0)
		 FROM usage_monthly WHERE user_id = ? AND period = ?`, userID, period).
		Scan(&upload, &download)
	if err == sql.ErrNoRows {
		return 0, 0, nil
	}
	return upload, download, err
}

func (s *SQLiteStore) ListSettings(ctx context.Context) ([]Setting, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value, updated_at FROM settings ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Setting
	for rows.Next() {
		var st Setting
		if err := rows.Scan(&st.Key, &st.Value, &st.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// nullStr converts an empty string to SQL NULL (used for optional TEXT columns
// like nodes.owner_user_id, which is "" for fleet-owned nodes).
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// nodeCols is the SELECT column list shared by every node read path
// (UpsertNode's return, GetNode, StorageNodes, ListNodes, OnlineNodes), so the
// column order stays in lockstep with queryNodes's scan.
const nodeCols = `id, owner_type, owner_user_id, region, urls, turn_secret, version,
  relayed_bytes, stored_bytes, created_at, last_seen_at,
  storage_url, storage_secret, storage_enabled, storage_total, storage_free,
  traffic_limit_bytes, disk_limit_bytes`

func (s *SQLiteStore) UpsertNode(ctx context.Context, n Node) (Node, error) {
	if n.ID == "" {
		n.ID = newID()
	}
	urls, err := json.Marshal(n.URLs)
	if err != nil {
		return Node{}, err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO nodes (`+nodeCols+`)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET
		   owner_type=excluded.owner_type, owner_user_id=excluded.owner_user_id,
		   region=excluded.region, urls=excluded.urls, turn_secret=excluded.turn_secret,
		   version=excluded.version, last_seen_at=excluded.last_seen_at,
		   storage_url=excluded.storage_url, storage_secret=excluded.storage_secret,
		   storage_enabled=excluded.storage_enabled, storage_total=excluded.storage_total,
		   storage_free=excluded.storage_free`,
		n.ID, n.OwnerType, nullStr(n.OwnerUserID), n.Region, string(urls), n.TURNSecret,
		n.Version, n.RelayedBytes, n.StoredBytes, n.CreatedAt, n.LastSeenAt,
		nullStr(n.StorageURL), nullStr(n.StorageSecret), b2i(n.StorageEnabled), n.StorageTotal, n.StorageFree,
		n.TrafficLimitBytes, n.DiskLimitBytes)
	if err != nil {
		return Node{}, err
	}
	return n, nil
}

// TouchNode records a heartbeat: relayed_bytes is a cumulative counter
// (keep-MAX, never decrease), while stored_bytes is a live gauge of the
// node's current whole-volume usage and storage_total/storage_free are live
// snapshots of the node's disk state; none of those three are monotonic, so
// they are SET.
func (s *SQLiteStore) TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, storageTotal, storageFree, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET last_seen_at=?,
		   relayed_bytes=MAX(relayed_bytes, ?), stored_bytes=?,
		   storage_total=?, storage_free=? WHERE id=?`,
		at, relayedBytes, storedBytes, storageTotal, storageFree, id)
	return err
}

func (s *SQLiteStore) GetNode(ctx context.Context, id string) (Node, bool, error) {
	nodes, err := s.queryNodes(ctx, `SELECT `+nodeCols+` FROM nodes WHERE id = ?`, id)
	if err != nil {
		return Node{}, false, err
	}
	if len(nodes) == 0 {
		return Node{}, false, nil
	}
	return nodes[0], true, nil
}

// StorageNodes returns fleet storage nodes that are online since `since` and
// have at least minFree bytes free — candidates for placing a new node-backed
// blob.
func (s *SQLiteStore) StorageNodes(ctx context.Context, since, minFree int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes
		   WHERE owner_type='fleet' AND storage_enabled=1 AND last_seen_at >= ? AND storage_free >= ?
		   ORDER BY last_seen_at DESC`, since, minFree)
}

func (s *SQLiteStore) OnlineNodes(ctx context.Context, since int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='fleet' AND last_seen_at >= ? ORDER BY last_seen_at DESC`, since)
}

func (s *SQLiteStore) ListNodes(ctx context.Context) ([]Node, error) {
	return s.queryNodes(ctx, `SELECT `+nodeCols+` FROM nodes ORDER BY last_seen_at DESC`)
}

// UserNodes returns a user's own (owner_type='user') nodes online since `since`.
func (s *SQLiteStore) UserNodes(ctx context.Context, userID string, since int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? AND last_seen_at >= ? ORDER BY last_seen_at DESC`,
		userID, since)
}

// UserNodesAll returns all of a user's own nodes regardless of last_seen, for
// the dashboard list (which shows offline nodes too).
func (s *SQLiteStore) UserNodesAll(ctx context.Context, userID string) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? ORDER BY last_seen_at DESC`,
		userID)
}

// UserStorageNodes is UserNodes filtered to storage-enabled nodes with at
// least minFree bytes free.
func (s *SQLiteStore) UserStorageNodes(ctx context.Context, userID string, since, minFree int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? AND last_seen_at >= ? AND storage_enabled=1 AND storage_free >= ? ORDER BY last_seen_at DESC`,
		userID, since, minFree)
}

// DeleteNode removes a user-owned node, owner-scoped.
func (s *SQLiteStore) DeleteNode(ctx context.Context, id, ownerUserID string) error {
	// Owner-scoped: only delete a node this user owns.
	res, err := s.db.ExecContext(ctx, `DELETE FROM nodes WHERE id = ? AND owner_user_id = ?`, id, ownerUserID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, _ = s.db.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE node_id = ?`, id)
	return nil
}

// SetNodeLimits sets a node's admin hard caps (bytes; 0 = unlimited).
func (s *SQLiteStore) SetNodeLimits(ctx context.Context, nodeID string, trafficLimit, diskLimit int64) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET traffic_limit_bytes = ?, disk_limit_bytes = ? WHERE id = ?`,
		trafficLimit, diskLimit, nodeID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteFleetNode removes an official (fleet) node, scoped to owner_type='fleet'
// so a user node id cannot be deleted through the admin path. Also clears the
// node's pending_node_deletes entries (mirrors DeleteNode).
func (s *SQLiteStore) DeleteFleetNode(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM nodes WHERE id = ? AND owner_type = 'fleet'`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, _ = s.db.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE node_id = ?`, id)
	return nil
}

func (s *SQLiteStore) queryNodes(ctx context.Context, q string, args ...any) ([]Node, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Node
	for rows.Next() {
		var n Node
		var ownerUser sql.NullString
		var urls string
		var storageURL, storageSecret sql.NullString
		var storageEnabled int
		if err := rows.Scan(&n.ID, &n.OwnerType, &ownerUser, &n.Region, &urls, &n.TURNSecret,
			&n.Version, &n.RelayedBytes, &n.StoredBytes, &n.CreatedAt, &n.LastSeenAt,
			&storageURL, &storageSecret, &storageEnabled, &n.StorageTotal, &n.StorageFree,
			&n.TrafficLimitBytes, &n.DiskLimitBytes); err != nil {
			return nil, err
		}
		n.OwnerUserID = ownerUser.String
		n.StorageURL = storageURL.String
		n.StorageSecret = storageSecret.String
		n.StorageEnabled = storageEnabled != 0
		if err := json.Unmarshal([]byte(urls), &n.URLs); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// EnqueueNodeDelete records an orphaned blob-on-node delete for GC to retry.
// DO NOTHING on conflict: the pair may already be queued from a prior sweep.
func (s *SQLiteStore) EnqueueNodeDelete(ctx context.Context, blobKey, nodeID string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO pending_node_deletes (blob_key, node_id, enqueued_at) VALUES (?,?,?)
		 ON CONFLICT(blob_key, node_id) DO NOTHING`, blobKey, nodeID, at)
	return err
}

func (s *SQLiteStore) ListPendingNodeDeletes(ctx context.Context) ([]PendingNodeDelete, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT blob_key, node_id, enqueued_at FROM pending_node_deletes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingNodeDelete
	for rows.Next() {
		var p PendingNodeDelete
		if err := rows.Scan(&p.BlobKey, &p.NodeID, &p.EnqueuedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) DeletePendingNodeDelete(ctx context.Context, blobKey, nodeID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE blob_key=? AND node_id=?`, blobKey, nodeID)
	return err
}

// DeletePendingNodeDeletesOlderThan evicts orphan-retry rows enqueued before
// `before`, so a permanently-dead node's rows don't accumulate forever.
func (s *SQLiteStore) DeletePendingNodeDeletesOlderThan(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE enqueued_at < ?`, before)
	return err
}

func (s *SQLiteStore) CreateNodeToken(ctx context.Context, t NodeToken) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO node_tokens (id, token_hash, user_id, node_id, name, created_at) VALUES (?,?,?,?,?,?)`,
		t.ID, t.TokenHash, t.UserID, nullStr(t.NodeID), t.Name, t.CreatedAt)
	return err
}

// NodeTokenByHash resolves a node's bearer token by its hash. ok=false for
// both an absent hash and a revoked one — callers cannot distinguish the two,
// which is intentional (no oracle for "does this hash exist").
func (s *SQLiteStore) NodeTokenByHash(ctx context.Context, hash string) (NodeToken, bool, error) {
	var t NodeToken
	var nodeID sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, token_hash, user_id, node_id, name, created_at, last_used_at, revoked_at
		   FROM node_tokens WHERE token_hash = ? AND revoked_at = 0`, hash).
		Scan(&t.ID, &t.TokenHash, &t.UserID, &nodeID, &t.Name, &t.CreatedAt, &t.LastUsedAt, &t.RevokedAt)
	if err == sql.ErrNoRows {
		return NodeToken{}, false, nil
	}
	if err != nil {
		return NodeToken{}, false, err
	}
	t.NodeID = nodeID.String
	return t, true, nil
}

func (s *SQLiteStore) BindNodeToken(ctx context.Context, id, nodeID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE node_tokens SET node_id = ? WHERE id = ?`, nodeID, id)
	return err
}

func (s *SQLiteStore) ListNodeTokensByUser(ctx context.Context, userID string) ([]NodeToken, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, token_hash, user_id, node_id, name, created_at, last_used_at, revoked_at
		   FROM node_tokens WHERE user_id = ? AND revoked_at = 0 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NodeToken
	for rows.Next() {
		var t NodeToken
		var nodeID sql.NullString
		if err := rows.Scan(&t.ID, &t.TokenHash, &t.UserID, &nodeID, &t.Name, &t.CreatedAt, &t.LastUsedAt, &t.RevokedAt); err != nil {
			return nil, err
		}
		t.NodeID = nodeID.String
		out = append(out, t)
	}
	return out, rows.Err()
}

// RevokeNodeToken is owner-scoped: it only revokes when user_id matches and
// the token is not already revoked, so a non-owner's call is a silent no-op
// (nil error, zero rows affected) rather than an error.
func (s *SQLiteStore) RevokeNodeToken(ctx context.Context, id, userID string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE node_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at = 0`,
		at, id, userID)
	return err
}

func (s *SQLiteStore) TouchNodeTokenUsed(ctx context.Context, id string, at int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE node_tokens SET last_used_at = ? WHERE id = ?`, at, id)
	return err
}

func (s *SQLiteStore) CreateFleetToken(ctx context.Context, t FleetToken) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO fleet_tokens (id, token_hash, name, node_id, created_at) VALUES (?,?,?,?,?)`,
		t.ID, t.TokenHash, t.Name, nullStr(t.NodeID), t.CreatedAt)
	return err
}

// FleetTokenByHash resolves an admin-minted fleet token by hash; ok=false for
// both an absent and a revoked hash (no existence oracle), matching NodeTokenByHash.
func (s *SQLiteStore) FleetTokenByHash(ctx context.Context, hash string) (FleetToken, bool, error) {
	var t FleetToken
	var nodeID sql.NullString
	var name sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, token_hash, name, node_id, created_at, last_used_at, revoked_at
		   FROM fleet_tokens WHERE token_hash = ? AND revoked_at = 0`, hash).
		Scan(&t.ID, &t.TokenHash, &name, &nodeID, &t.CreatedAt, &t.LastUsedAt, &t.RevokedAt)
	if err == sql.ErrNoRows {
		return FleetToken{}, false, nil
	}
	if err != nil {
		return FleetToken{}, false, err
	}
	t.Name, t.NodeID = name.String, nodeID.String
	return t, true, nil
}

func (s *SQLiteStore) BindFleetToken(ctx context.Context, id, nodeID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE fleet_tokens SET node_id = ? WHERE id = ?`, nodeID, id)
	return err
}

func (s *SQLiteStore) TouchFleetTokenUsed(ctx context.Context, id string, at int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE fleet_tokens SET last_used_at = ? WHERE id = ?`, at, id)
	return err
}

func (s *SQLiteStore) RevokeFleetToken(ctx context.Context, id string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE fleet_tokens SET revoked_at = ? WHERE id = ? AND revoked_at = 0`, at, id)
	return err
}

func (s *SQLiteStore) ListActiveFleetTokens(ctx context.Context) ([]FleetToken, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, token_hash, name, node_id, created_at, last_used_at, revoked_at
		   FROM fleet_tokens WHERE revoked_at = 0 ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FleetToken
	for rows.Next() {
		var t FleetToken
		var name, nodeID sql.NullString
		if err := rows.Scan(&t.ID, &t.TokenHash, &name, &nodeID, &t.CreatedAt, &t.LastUsedAt, &t.RevokedAt); err != nil {
			return nil, err
		}
		t.Name, t.NodeID = name.String, nodeID.String
		out = append(out, t)
	}
	return out, rows.Err()
}
