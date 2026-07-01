package account

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
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
  created_at   INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS transfers (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers(user_id);
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
	return &SQLiteStore{db: db}, nil
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
		`SELECT id, email, display_name, created_at FROM users WHERE email = ?`, email,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt)
	if err == nil {
		return u, nil
	}
	if err != sql.ErrNoRows {
		return User{}, err
	}
	u = User{ID: newID(), Email: email, DisplayName: displayName, CreatedAt: time.Now().Unix()}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`,
		u.ID, u.Email, u.DisplayName, u.CreatedAt)
	return u, err
}

func (s *SQLiteStore) GetUserByID(ctx context.Context, id string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return User{}, ErrNotFound
	}
	return u, err
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

func (s *SQLiteStore) CreateTransfer(ctx context.Context, t Transfer) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO transfers (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		t.Token, t.UserID, t.CreatedAt, t.ExpiresAt)
	return err
}

func (s *SQLiteStore) GetTransfer(ctx context.Context, token string) (Transfer, error) {
	var t Transfer
	err := s.db.QueryRowContext(ctx,
		`SELECT token, user_id, created_at, expires_at FROM transfers WHERE token = ?`, token,
	).Scan(&t.Token, &t.UserID, &t.CreatedAt, &t.ExpiresAt)
	if err == sql.ErrNoRows {
		return Transfer{}, ErrNotFound
	}
	return t, err
}

func (s *SQLiteStore) RecordUsage(ctx context.Context, e UsageEvent) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO usage_events (alloc_id, token, user_id, relayed_bytes, recorded_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(alloc_id) DO UPDATE SET
		   relayed_bytes = MAX(relayed_bytes, excluded.relayed_bytes),
		   recorded_at = excluded.recorded_at`,
		e.AllocID, e.Token, e.UserID, e.RelayedBytes, e.RecordedAt)
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

func (s *SQLiteStore) AdminListUsers(ctx context.Context) ([]AdminUserRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.email, u.display_name, u.created_at,
		       (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id),
		       (SELECT COALESCE(SUM(relayed_bytes), 0) FROM usage_events e WHERE e.user_id = u.id)
		FROM users u
		ORDER BY u.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AdminUserRow
	index := map[string]int{}
	for rows.Next() {
		var row AdminUserRow
		if err := rows.Scan(&row.ID, &row.Email, &row.DisplayName, &row.CreatedAt,
			&row.DeviceCount, &row.RelayedBytes); err != nil {
			return nil, err
		}
		index[row.ID] = len(out)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 单独一遍把 provider 摊到对应用户，避免 N+1。
	irows, err := s.db.QueryContext(ctx, `SELECT user_id, provider FROM identities`)
	if err != nil {
		return nil, err
	}
	defer irows.Close()
	seen := map[string]map[string]bool{}
	for irows.Next() {
		var uid, provider string
		if err := irows.Scan(&uid, &provider); err != nil {
			return nil, err
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
		return nil, err
	}
	for i := range out {
		sort.Strings(out[i].Methods)
	}
	return out, nil
}

func (s *SQLiteStore) AdminMetrics(ctx context.Context, now int64) (AdminMetrics, error) {
	var m AdminMetrics
	err := s.db.QueryRowContext(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM users),
		  (SELECT COUNT(*) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE recorded_at >= ?),
		  (SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE recorded_at >= ?),
		  (SELECT COALESCE(SUM(bytes),0) FROM upload_events WHERE uploaded_at >= ?)`,
		now, now, now-86400, now-604800, now-86400,
	).Scan(&m.TotalUsers, &m.ActiveStoredFiles, &m.ActiveStoredBytes,
		&m.RelayedBytes24h, &m.RelayedBytes7d, &m.UploadedBytes24h)
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
	err := sc.Scan(&f.ID, &f.UserID, &f.BlobKey, &f.EncManifest, &f.Size,
		&burn, &f.CreatedAt, &f.ExpiresAt, &f.DownloadedAt)
	f.BurnAfterRead = burn != 0
	return f, err
}

const storedFileCols = `id, user_id, blob_key, enc_manifest, size, burn_after_read, created_at, expires_at, downloaded_at`

func (s *SQLiteStore) CreateStoredFile(ctx context.Context, f StoredFile) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO stored_files (`+storedFileCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.UserID, f.BlobKey, f.EncManifest, f.Size,
		b2i(f.BurnAfterRead), f.CreatedAt, f.ExpiresAt, f.DownloadedAt)
	return err
}

func (s *SQLiteStore) GetStoredFile(ctx context.Context, id string) (StoredFile, error) {
	f, err := scanStoredFile(s.db.QueryRowContext(ctx,
		`SELECT `+storedFileCols+` FROM stored_files WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return StoredFile{}, ErrNotFound
	}
	return f, err
}

func (s *SQLiteStore) ListStoredFilesByUser(ctx context.Context, userID string) ([]StoredFile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+storedFileCols+` FROM stored_files WHERE user_id = ? ORDER BY created_at DESC`, userID)
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

func (s *SQLiteStore) DeleteStoredFile(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM stored_files WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) ListExpiredStoredFiles(ctx context.Context, now int64) ([]StoredFile, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+storedFileCols+` FROM stored_files WHERE expires_at < ?`, now)
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
