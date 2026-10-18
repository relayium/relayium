package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/relayium/relayium/authx"
)

// Admin authentication is Passkey-only. This file holds the state that makes
// that true at the storage layer, shared by the HTTP handlers (through the
// Store interface on SQLiteStore) and by the local `relayium-server admin`
// command (through AdminAuthStore, which opens ONLY these tables).
//
// Invariants enforced here, not just by callers:
//
//   - A session is valid only if it was established by a passkey (auth =
//     'passkey'), names the credential that established it, that credential is
//     still in admin_credentials, it is younger than adminSessionAbsoluteTTL,
//     and it was last used within adminSessionIdleTTL. Rows written by older
//     binaries (password sessions, no credential_id, no last_seen_at) fail every
//     one of those and are therefore dead the moment this code reads them — no
//     data migration is needed, and none can accidentally revive them.
//   - A browser can never write admin_credentials. The enrollment page writes a
//     PENDING row in admin_enrollments; only ApproveAdminEnrollment, reachable
//     solely from the local command, moves it into admin_credentials, inside one
//     BEGIN IMMEDIATE transaction that re-checks state, expiry, origin, RP ID,
//     the operator-typed fingerprint and the credential-ID exclusivity.
//   - Every bearer secret (session cookie, enrollment grant) is stored as a
//     SHA-256 hash; nothing here ever returns or logs the raw value.

const (
	// adminSessionAbsoluteTTL caps a session's life from the passkey login that
	// created it, no matter how active it is.
	adminSessionAbsoluteTTL = 12 * time.Hour
	// adminSessionIdleTTL ends a session that has not been used for an
	// authenticated admin request for this long. Only isAdminReq refreshes it
	// (TouchAdminSession); audit lookups, the step-up grace check and GC read
	// without refreshing, so nothing but the operator's own requests keeps a
	// session alive.
	adminSessionIdleTTL = 30 * time.Minute

	// adminAuthPasskey is the only auth value a valid session may carry.
	adminAuthPasskey = "passkey"

	// adminEnrollmentPurpose binds a grant to what it may be spent on. It is
	// checked at begin, finish and approval, so a grant row can never be read as
	// authority for anything else this table might one day hold.
	adminEnrollmentPurpose = "admin-passkey"

	// Enrollment states. Expiry is not a state: it is expires_at <= now, checked
	// at every step, so an expired row is dead without any sweep having run.
	enrollIssued    = "issued"    // grant minted by the CLI, no credential yet
	enrollPending   = "pending"   // browser produced a credential; NOT usable
	enrollApproved  = "approved"  // credential moved into admin_credentials
	enrollCancelled = "cancelled" // operator cancel, revoke-all, or too many bad finishes

	// adminEnrollmentDefaultTTL / Max bound how long a grant (and its pending
	// credential) may wait. Short on purpose: the operator is at the terminal.
	adminEnrollmentDefaultTTL = 15 * time.Minute
	adminEnrollmentMaxTTL     = time.Hour
	adminEnrollmentMinTTL     = time.Minute
	// adminEnrollChallengeTTL bounds one WebAuthn creation challenge.
	adminEnrollChallengeTTL = 5 * time.Minute
	// adminEnrollMaxFinishFailures cancels a grant after this many invalid
	// finish attempts. A 256-bit grant cannot be guessed; repeated failures
	// with a VALID grant mean something other than the operator is using it.
	adminEnrollMaxFinishFailures = 5
	// adminEnrollOpenCap bounds how many unexpired, undecided enrollments may
	// exist at once, so a looping script cannot fill the table.
	adminEnrollOpenCap = 16
	// adminEnrollNameMax bounds the operator-supplied label.
	adminEnrollNameMax = 64
)

// Errors the local command reports verbatim. They are deliberately specific:
// the operator is at a privileged terminal and needs to know which check failed.
var (
	ErrAdminEnrollmentNotFound  = errors.New("enrollment not found")
	ErrAdminEnrollmentExpired   = errors.New("enrollment has expired; start a new one")
	ErrAdminEnrollmentState     = errors.New("enrollment is not waiting for approval")
	ErrAdminEnrollmentFP        = errors.New("fingerprint does not match the pending passkey; nothing was approved")
	ErrAdminEnrollmentBinding   = errors.New("enrollment was issued for a different base URL / RP ID; nothing was approved")
	ErrAdminEnrollmentDuplicate = errors.New("this passkey is already registered")
	ErrAdminEnrollmentHandle    = errors.New("enrollment carries a different admin user handle than the registered passkeys; start a new enrollment")
	ErrAdminEnrollmentCap       = errors.New("too many open enrollments; cancel some or wait for them to expire")
	ErrAdminCredentialNotFound  = errors.New("passkey not found")
	ErrAdminLastCredential      = errors.New("refusing to revoke the last registered passkey without --allow-last")
	// ErrAdminSessionRefused is CreateAdminSession refusing to mint: the
	// credential is no longer registered, or a revocation happened after the
	// login ceremony began (the auth generation moved). Nothing was written.
	ErrAdminSessionRefused = errors.New("admin session refused: credential revoked or sessions revoked since sign-in began")
)

// adminAuthSchema is the additive migration for Passkey-only admin auth. It
// touches ONLY admin_* tables and is shared verbatim by OpenSQLite (server
// boot) and OpenAdminAuthStore (the local command), so whichever runs first
// leaves the same shape behind. Every statement is idempotent.
var adminAuthSchemaCreate = []string{
	`CREATE TABLE IF NOT EXISTS admin_enrollments (
  id TEXT PRIMARY KEY,
  grant_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  user_handle BLOB NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  challenge TEXT NOT NULL DEFAULT '',
  challenge_expires_at INTEGER NOT NULL DEFAULT 0,
  cred_id TEXT NOT NULL DEFAULT '',
  cred_json BLOB,
  fingerprint TEXT NOT NULL DEFAULT '',
  finished_at INTEGER NOT NULL DEFAULT 0,
  decided_at INTEGER NOT NULL DEFAULT 0,
  finish_failures INTEGER NOT NULL DEFAULT 0)`,
	`CREATE INDEX IF NOT EXISTS idx_admin_enrollments_state ON admin_enrollments(state, expires_at)`,
	// The revocation fence. generation is bumped, in the same transaction, by
	// every revocation (RevokeAllSessions and RevokeCredential). A passkey
	// ceremony records the generation current when it BEGAN; a session (and a
	// step-up) may only be produced from it while the generation is unchanged.
	// So a login whose assertion was already verified — its ceremony row
	// already consumed — when revoke-all ran can no longer mint a session:
	// deleting ceremony rows alone could not stop it.
	`CREATE TABLE IF NOT EXISTS admin_auth_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL DEFAULT 0)`,
	`INSERT OR IGNORE INTO admin_auth_state (id, generation) VALUES (1, 0)`,
}

var adminAuthSchemaAlter = []string{
	// When the session was created by a passkey login. 0 on every row written
	// by an older binary, which fails the absolute-age check.
	`ALTER TABLE admin_sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`,
	// Last authenticated request. 0 on old rows, which fails the idle check:
	// there is no safe last-seen to assume, so old sessions fail closed.
	`ALTER TABLE admin_sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0`,
	// The passkey that established the session, so revoking a key ends exactly
	// the sessions it opened. '' on old (password) rows, which never validate.
	`ALTER TABLE admin_sessions ADD COLUMN credential_id TEXT NOT NULL DEFAULT ''`,
	// The auth generation a ceremony began under. -1 on rows written by an
	// older binary: generations are never negative, so a pre-fence ceremony can
	// never satisfy the fence and simply fails closed (it expires in 5 minutes).
	`ALTER TABLE admin_passkey_ceremonies ADD COLUMN auth_generation INTEGER NOT NULL DEFAULT -1`,
	// The generation a session was minted under (diagnostic; validity is
	// enforced by deletion in the revoking transaction plus the mint fence).
	`ALTER TABLE admin_sessions ADD COLUMN auth_generation INTEGER NOT NULL DEFAULT -1`,
	// The auth generation the session's last passkey step-up was proved under.
	// The 60-second grace window counts only while this equals the current
	// generation, so any revocation — of the step-up key, of any key, or
	// revoke-all — ends cached step-up authority at once. -1 = never.
	`ALTER TABLE admin_sessions ADD COLUMN step_up_generation INTEGER NOT NULL DEFAULT -1`,
}

func ensureAdminAuthSchema(ctx context.Context, db *sql.DB) error {
	for _, q := range adminAuthSchemaCreate {
		if _, err := db.ExecContext(ctx, q); err != nil {
			return fmt.Errorf("admin auth schema: %w", err)
		}
	}
	for _, q := range adminAuthSchemaAlter {
		if _, err := db.ExecContext(ctx, q); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("admin auth schema: %w", err)
		}
	}
	if _, err := db.ExecContext(ctx,
		`CREATE INDEX IF NOT EXISTS idx_admin_sessions_credential ON admin_sessions(credential_id)`); err != nil {
		return fmt.Errorf("admin auth schema: %w", err)
	}
	return nil
}

// AdminSessionInfo is what a valid admin session row tells its caller. It never
// contains the token.
type AdminSessionInfo struct {
	Auth         string
	CredentialID string
	CreatedAt    int64
	LastSeenAt   int64
	LastStepUpAt int64
	Expires      int64
	// StepUpGeneration is the generation the last step-up was proved under,
	// CurrentGeneration the fence value at the time of this read (same
	// statement). Grace counts only when they are equal.
	StepUpGeneration  int64
	CurrentGeneration int64
}

// adminSessionValidSQL is the one validity predicate. Parameters, in order:
// token hash, now, absolute cutoff (now-12h), idle cutoff (now-30m). Keeping it
// in one place is what lets "read" and "refresh" never disagree about which
// sessions are alive.
const adminSessionValidSQL = `token = ? AND auth = 'passkey' AND credential_id <> ''
  AND expires > ? AND created_at > ? AND last_seen_at > ?
  AND EXISTS (SELECT 1 FROM admin_credentials c WHERE c.id = admin_sessions.credential_id)`

func adminSessionArgs(tokenHash string, now int64) []any {
	return []any{tokenHash, now,
		now - int64(adminSessionAbsoluteTTL/time.Second),
		now - int64(adminSessionIdleTTL/time.Second)}
}

// CreateAdminSession mints a passkey session bound to credentialID, but only
// if — in the same single INSERT ... SELECT statement, so atomically with
// respect to every revoking transaction — the credential is still registered
// AND the auth generation still equals generation, the value captured when the
// login ceremony began. Otherwise nothing is written and ErrAdminSessionRefused
// is returned. There is therefore never an orphan row for a revoked
// credential that could come back to life if the same credential ID were
// later enrolled again, and a login verified before a revocation cannot
// complete after it.
func (s *SQLiteStore) CreateAdminSession(ctx context.Context, token, credentialID string, generation, now int64) error {
	if credentialID == "" || generation < 0 {
		return ErrAdminSessionRefused
	}
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO admin_sessions (token, auth, cred_fp, expires, last_step_up_at, created_at, last_seen_at, credential_id, auth_generation)
		 SELECT ?, 'passkey', '', ?, 0, ?, ?, ?, st.generation
		   FROM admin_auth_state st
		  WHERE st.id = 1 AND st.generation = ?
		    AND EXISTS (SELECT 1 FROM admin_credentials c WHERE c.id = ?)`,
		authx.HashToken(token), now+int64(adminSessionAbsoluteTTL/time.Second), now, now, credentialID,
		generation, credentialID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrAdminSessionRefused
	}
	return nil
}

// AdminAuthGeneration returns the current revocation fence value.
func (s *SQLiteStore) AdminAuthGeneration(ctx context.Context) (int64, error) {
	return adminAuthGeneration(ctx, s.db)
}

func adminAuthGeneration(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (int64, error) {
	var g int64
	err := q.QueryRowContext(ctx, `SELECT generation FROM admin_auth_state WHERE id = 1`).Scan(&g)
	return g, err
}

// bumpAdminAuthGeneration advances the fence inside a revoking transaction.
func bumpAdminAuthGeneration(ctx context.Context, tx *sql.Tx) error {
	res, err := tx.ExecContext(ctx, `UPDATE admin_auth_state SET generation = generation + 1 WHERE id = 1`)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("admin auth state row missing")
	}
	return nil
}

// AdminSession reads a valid session WITHOUT refreshing its idle timer.
func (s *SQLiteStore) AdminSession(ctx context.Context, token string, now int64) (AdminSessionInfo, bool, error) {
	var i AdminSessionInfo
	err := s.db.QueryRowContext(ctx,
		`SELECT auth, credential_id, created_at, last_seen_at, last_step_up_at, expires, step_up_generation,
		        (SELECT generation FROM admin_auth_state WHERE id = 1)
		   FROM admin_sessions WHERE `+adminSessionValidSQL,
		adminSessionArgs(authx.HashToken(token), now)...).
		Scan(&i.Auth, &i.CredentialID, &i.CreatedAt, &i.LastSeenAt, &i.LastStepUpAt, &i.Expires, &i.StepUpGeneration, &i.CurrentGeneration)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminSessionInfo{}, false, nil
	}
	if err != nil {
		return AdminSessionInfo{}, false, err
	}
	return i, true, nil
}

// TouchAdminSession validates and refreshes the idle timer in one statement,
// so a session that has just gone idle can never be refreshed back to life.
func (s *SQLiteStore) TouchAdminSession(ctx context.Context, token string, now int64) (AdminSessionInfo, bool, error) {
	var i AdminSessionInfo
	args := append([]any{now}, adminSessionArgs(authx.HashToken(token), now)...)
	err := s.db.QueryRowContext(ctx,
		`UPDATE admin_sessions SET last_seen_at = ? WHERE `+adminSessionValidSQL+`
		 RETURNING auth, credential_id, created_at, last_seen_at, last_step_up_at, expires, step_up_generation,
		        (SELECT generation FROM admin_auth_state WHERE id = 1)`, args...).
		Scan(&i.Auth, &i.CredentialID, &i.CreatedAt, &i.LastSeenAt, &i.LastStepUpAt, &i.Expires, &i.StepUpGeneration, &i.CurrentGeneration)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminSessionInfo{}, false, nil
	}
	if err != nil {
		return AdminSessionInfo{}, false, err
	}
	return i, true, nil
}

// MarkAdminStepUp records a successful step-up (opens the grace window) on a
// still-valid session, bound to generation — the generation the proof was
// verified under. It writes only if that is STILL the current generation, in
// the same statement, so a revocation that lands between verifying a step-up
// and recording it can never leave behind grace authority from a revoked key.
// ok=false means nothing was recorded.
func (s *SQLiteStore) MarkAdminStepUp(ctx context.Context, token string, at, generation int64) (bool, error) {
	args := append([]any{at, generation}, adminSessionArgs(authx.HashToken(token), at)...)
	args = append(args, generation)
	res, err := s.db.ExecContext(ctx,
		`UPDATE admin_sessions SET last_step_up_at = ?, step_up_generation = ?
		  WHERE `+adminSessionValidSQL+`
		    AND (SELECT generation FROM admin_auth_state WHERE id = 1) = ?`, args...)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// AdminStepUpAuthorized is the final authorization check for a confirmed
// high-risk action, run after the factor was verified (and its credential
// write-back done) and immediately before the action is applied — the
// linearization point of a confirmation. In ONE statement it requires: the
// session is still valid; the auth generation still equals the generation the
// proof was verified under (no revocation of any key, no revoke-all since);
// and, for a passkey proof, the credential that produced it is still
// registered. A revocation committed before this check refuses the action; one
// committed after it is ordered after the action.
func (s *SQLiteStore) AdminStepUpAuthorized(ctx context.Context, token string, generation int64, credentialID string, now int64) (bool, error) {
	if generation < 0 {
		return false, nil
	}
	args := adminSessionArgs(authx.HashToken(token), now)
	args = append(args, generation, credentialID, credentialID)
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM admin_sessions WHERE `+adminSessionValidSQL+`
		    AND (SELECT generation FROM admin_auth_state WHERE id = 1) = ?
		    AND (? = '' OR EXISTS (SELECT 1 FROM admin_credentials c WHERE c.id = ?))`, args...).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// DeleteAdminSession removes a session (logout) and the confirmations it minted.
func (s *SQLiteStore) DeleteAdminSession(ctx context.Context, token string) error {
	h := authx.HashToken(token)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM admin_pending_actions WHERE session_tok = ?`, h); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM admin_sessions WHERE token = ?`, h); err != nil {
		return err
	}
	return tx.Commit()
}

// PurgeExpiredAdminSessions drops every session that can no longer validate:
// expired, too old, idle, or minted by an older binary. Housekeeping only —
// validity never depends on this having run.
func (s *SQLiteStore) PurgeExpiredAdminSessions(ctx context.Context, now int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM admin_sessions WHERE expires <= ? OR created_at <= ? OR last_seen_at <= ?
		   OR credential_id = '' OR auth <> 'passkey'`,
		now, now-int64(adminSessionAbsoluteTTL/time.Second), now-int64(adminSessionIdleTTL/time.Second))
	if err != nil {
		return err
	}
	// Decided or long-expired enrollments carry a public key at most; keep a
	// week of them for the CLI's status view, then let them go.
	_, err = s.db.ExecContext(ctx, `DELETE FROM admin_enrollments WHERE expires_at <= ?`,
		now-int64((7*24*time.Hour)/time.Second))
	return err
}

// ---------------------------------------------------------------------------
// Enrollment: the browser half (SQLiteStore, via the Store interface).

// AdminEnrollment is one enrollment row as the code needs it. It never holds
// the grant itself, only the row the grant's hash selected.
type AdminEnrollment struct {
	ID                 string
	Purpose            string
	Name               string
	Origin             string
	RPID               string
	UserHandle         []byte
	State              string
	CreatedAt          int64
	ExpiresAt          int64
	Challenge          string
	ChallengeExpiresAt int64
	CredID             string
	CredJSON           []byte
	Fingerprint        string
	FinishedAt         int64
	DecidedAt          int64
	FinishFailures     int64
}

const adminEnrollmentCols = `id, purpose, name, origin, rp_id, user_handle, state, created_at, expires_at,
  challenge, challenge_expires_at, cred_id, cred_json, fingerprint, finished_at, decided_at, finish_failures`

func scanAdminEnrollment(row interface{ Scan(...any) error }) (AdminEnrollment, error) {
	var e AdminEnrollment
	err := row.Scan(&e.ID, &e.Purpose, &e.Name, &e.Origin, &e.RPID, &e.UserHandle, &e.State, &e.CreatedAt,
		&e.ExpiresAt, &e.Challenge, &e.ChallengeExpiresAt, &e.CredID, &e.CredJSON, &e.Fingerprint,
		&e.FinishedAt, &e.DecidedAt, &e.FinishFailures)
	return e, err
}

// AdminEnrollmentByGrant returns the issued, unexpired enrollment whose grant
// hashes to grantHash. Anything else (unknown, pending, decided, expired) is
// ok=false: a grant is spendable only while nothing has been done with it yet.
func (s *SQLiteStore) AdminEnrollmentByGrant(ctx context.Context, grant string, now int64) (AdminEnrollment, bool, error) {
	if grant == "" {
		return AdminEnrollment{}, false, nil
	}
	e, err := scanAdminEnrollment(s.db.QueryRowContext(ctx,
		`SELECT `+adminEnrollmentCols+` FROM admin_enrollments
		  WHERE grant_hash = ? AND purpose = ? AND state = ? AND expires_at > ?`,
		authx.HashToken(grant), adminEnrollmentPurpose, enrollIssued, now))
	if errors.Is(err, sql.ErrNoRows) {
		return AdminEnrollment{}, false, nil
	}
	if err != nil {
		return AdminEnrollment{}, false, err
	}
	return e, true, nil
}

// SetAdminEnrollmentChallenge records a new creation challenge for an issued
// enrollment, replacing any earlier one (the operator may retry a cancelled
// platform prompt; only the newest challenge can ever finish).
func (s *SQLiteStore) SetAdminEnrollmentChallenge(ctx context.Context, id, challenge string, now, challengeExpires int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE admin_enrollments SET challenge = ?, challenge_expires_at = ?
		  WHERE id = ? AND purpose = ? AND state = ? AND expires_at > ?`,
		challenge, challengeExpires, id, adminEnrollmentPurpose, enrollIssued, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// FinishAdminEnrollment moves an issued enrollment to pending with the browser's
// verified credential — iff it is still issued, unexpired, and still carries the
// exact challenge the caller verified against. Exactly one of two concurrent
// finishes can win; the loser, and any replay, sees ok=false.
func (s *SQLiteStore) FinishAdminEnrollment(ctx context.Context, id, challenge, credID string, credJSON []byte, fingerprint string, now int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE admin_enrollments
		    SET state = ?, cred_id = ?, cred_json = ?, fingerprint = ?, finished_at = ?, challenge = '', challenge_expires_at = 0
		  WHERE id = ? AND purpose = ? AND state = ? AND expires_at > ? AND challenge = ? AND challenge <> ''
		    AND challenge_expires_at > ?
		    AND NOT EXISTS (SELECT 1 FROM admin_credentials c WHERE c.id = ?)`,
		enrollPending, credID, credJSON, fingerprint, now,
		id, adminEnrollmentPurpose, enrollIssued, now, challenge, now, credID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// FailAdminEnrollmentFinish burns the current challenge after an invalid finish
// and cancels the grant once it has failed adminEnrollMaxFinishFailures times.
func (s *SQLiteStore) FailAdminEnrollmentFinish(ctx context.Context, id string, now int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE admin_enrollments
		    SET challenge = '', challenge_expires_at = 0, finish_failures = finish_failures + 1,
		        state = CASE WHEN finish_failures + 1 >= ? THEN ? ELSE state END,
		        decided_at = CASE WHEN finish_failures + 1 >= ? THEN ? ELSE decided_at END
		  WHERE id = ? AND state = ?`,
		adminEnrollMaxFinishFailures, enrollCancelled, adminEnrollMaxFinishFailures, now, id, enrollIssued)
	return err
}

// AdminAuth returns the local-command view over this store's writer
// connection. Used by tests and by nothing in the request path.
func (s *SQLiteStore) AdminAuth() *AdminAuthStore { return &AdminAuthStore{db: s.db} }

// ---------------------------------------------------------------------------
// The local command's view: AdminAuthStore.

// AdminAuthStore is the privileged, local-only admin credential manager. It is
// never reachable over HTTP. OpenAdminAuthStore opens an EXISTING server
// database touching only admin_* tables: no customer table is read or written,
// no server boot job runs, no network or mail is initialised.
type AdminAuthStore struct {
	db    *sql.DB
	owned bool
}

// OpenAdminAuthStore opens the server's SQLite database for the admin command.
// It refuses anything that is not an existing, server-initialised Relayium
// database file, and (on Unix) a file owned by a different user than the one
// running the command — a root-owned -wal/-shm left behind would lock the
// service out of its own database.
func OpenAdminAuthStore(path string) (*AdminAuthStore, error) {
	if path == "" || strings.Contains(path, ":memory:") || strings.HasPrefix(path, "file:") || strings.Contains(path, "?") {
		return nil, errors.New("admin: --db must be the path of the server's existing SQLite file")
	}
	fi, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("admin: database %s: %w (refusing to create a new one)", path, err)
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("admin: database %s is not a regular file", path)
	}
	if err := checkAdminDBOwner(path, fi); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", withPragmas(path, connPragmas...)+"&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN
		   ('admin_credentials','admin_sessions','admin_audit','admin_pending_actions','admin_passkey_ceremonies','users')`).
		Scan(&n); err != nil {
		db.Close()
		return nil, fmt.Errorf("admin: read database %s: %w", path, err)
	}
	if n != 6 {
		db.Close()
		return nil, fmt.Errorf("admin: %s is not an initialised Relayium database (start the upgraded server once first)", path)
	}
	if err := ensureAdminAuthSchema(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return &AdminAuthStore{db: db, owned: true}, nil
}

// Close closes the database if this store opened it.
func (a *AdminAuthStore) Close() error {
	if a.owned {
		return a.db.Close()
	}
	return nil
}

// AdminEnrollmentGrant is what StartEnrollment returns to the terminal: the
// raw grant exists only in this value and in the operator's browser.
type AdminEnrollmentGrant struct {
	ID        string
	Grant     string
	Name      string
	ExpiresAt int64
}

// StartEnrollment mints a short-lived, single-use grant for one new admin
// passkey, bound to origin/rpID. Only the grant's hash is stored.
func (a *AdminAuthStore) StartEnrollment(ctx context.Context, name, origin, rpID string, ttl time.Duration, now int64, actor string) (AdminEnrollmentGrant, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > adminEnrollNameMax || strings.ContainsAny(name, "\x00\r\n") {
		return AdminEnrollmentGrant{}, fmt.Errorf("--name is required (1-%d characters, single line)", adminEnrollNameMax)
	}
	if ttl == 0 {
		ttl = adminEnrollmentDefaultTTL
	}
	if ttl < adminEnrollmentMinTTL || ttl > adminEnrollmentMaxTTL {
		return AdminEnrollmentGrant{}, fmt.Errorf("--ttl must be between %s and %s", adminEnrollmentMinTTL, adminEnrollmentMaxTTL)
	}
	if origin == "" || rpID == "" {
		return AdminEnrollmentGrant{}, errors.New("--base-url is required")
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return AdminEnrollmentGrant{}, err
	}
	defer tx.Rollback()
	var open int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM admin_enrollments WHERE state IN (?, ?) AND expires_at > ?`,
		enrollIssued, enrollPending, now).Scan(&open); err != nil {
		return AdminEnrollmentGrant{}, err
	}
	if open >= adminEnrollOpenCap {
		return AdminEnrollmentGrant{}, ErrAdminEnrollmentCap
	}
	// The stable admin user handle: reuse the registered passkeys' handle so
	// every credential belongs to one WebAuthn user; mint one only for the
	// first passkey. Approval re-checks this inside its own transaction.
	var handle []byte
	err = tx.QueryRowContext(ctx, `SELECT user_handle FROM admin_credentials ORDER BY created_at, id LIMIT 1`).Scan(&handle)
	if errors.Is(err, sql.ErrNoRows) {
		handle, err = randomBytes(32)
	}
	if err != nil {
		return AdminEnrollmentGrant{}, err
	}
	g := AdminEnrollmentGrant{ID: authx.NewID()[:12], Grant: authx.RandToken(), Name: name,
		ExpiresAt: now + int64(ttl/time.Second)}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO admin_enrollments (id, grant_hash, purpose, name, origin, rp_id, user_handle, state, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		g.ID, authx.HashToken(g.Grant), adminEnrollmentPurpose, name, origin, rpID, handle, enrollIssued, now, g.ExpiresAt); err != nil {
		return AdminEnrollmentGrant{}, err
	}
	if err := insertCLIAudit(ctx, tx, now, actor, AuditPasskeyEnrollStart, "enrollment:"+g.ID,
		[]ChangeField{{Field: "name", Old: "", New: name}, {Field: "origin", Old: "", New: origin}}); err != nil {
		return AdminEnrollmentGrant{}, err
	}
	return g, tx.Commit()
}

// Enrollment returns one enrollment by ID (any state).
func (a *AdminAuthStore) Enrollment(ctx context.Context, id string) (AdminEnrollment, bool, error) {
	e, err := scanAdminEnrollment(a.db.QueryRowContext(ctx,
		`SELECT `+adminEnrollmentCols+` FROM admin_enrollments WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return AdminEnrollment{}, false, nil
	}
	if err != nil {
		return AdminEnrollment{}, false, err
	}
	return e, true, nil
}

// ListEnrollments returns enrollments newest first.
func (a *AdminAuthStore) ListEnrollments(ctx context.Context) ([]AdminEnrollment, error) {
	rows, err := a.db.QueryContext(ctx,
		`SELECT `+adminEnrollmentCols+` FROM admin_enrollments ORDER BY created_at DESC, id LIMIT 50`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminEnrollment
	for rows.Next() {
		e, err := scanAdminEnrollment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ApproveEnrollment is the terminal confirmation. It moves the pending
// credential into admin_credentials only if, inside one write transaction:
// the enrollment exists, is pending, is unexpired, was issued for this exact
// origin/RP ID, its fingerprint equals the one the operator typed, the
// credential ID is not already registered, and its user handle matches the
// registered passkeys. Any failure leaves both tables untouched.
func (a *AdminAuthStore) ApproveEnrollment(ctx context.Context, id, fingerprint, origin, rpID string, now int64, actor string) (AdminCredential, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return AdminCredential{}, err
	}
	defer tx.Rollback()
	e, err := scanAdminEnrollment(tx.QueryRowContext(ctx,
		`SELECT `+adminEnrollmentCols+` FROM admin_enrollments WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return AdminCredential{}, ErrAdminEnrollmentNotFound
	}
	if err != nil {
		return AdminCredential{}, err
	}
	if e.Purpose != adminEnrollmentPurpose || e.State != enrollPending || e.CredID == "" || len(e.CredJSON) == 0 {
		return AdminCredential{}, ErrAdminEnrollmentState
	}
	if e.ExpiresAt <= now {
		return AdminCredential{}, ErrAdminEnrollmentExpired
	}
	if e.Origin != origin || e.RPID != rpID {
		return AdminCredential{}, ErrAdminEnrollmentBinding
	}
	want := normalizeAdminFingerprint(e.Fingerprint)
	got := normalizeAdminFingerprint(fingerprint)
	if want == "" || subtle.ConstantTimeCompare([]byte(want), []byte(got)) != 1 {
		return AdminCredential{}, ErrAdminEnrollmentFP
	}
	// Recompute the fingerprint from the stored credential: the column and the
	// key it describes must not be able to disagree.
	if fp, err := adminCredentialFingerprint(e.CredJSON); err != nil || normalizeAdminFingerprint(fp) != want {
		return AdminCredential{}, ErrAdminEnrollmentFP
	}
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin_credentials WHERE id = ?`, e.CredID).Scan(&exists); err != nil {
		return AdminCredential{}, err
	}
	if exists != 0 {
		return AdminCredential{}, ErrAdminEnrollmentDuplicate
	}
	var handle []byte
	err = tx.QueryRowContext(ctx, `SELECT user_handle FROM admin_credentials ORDER BY created_at, id LIMIT 1`).Scan(&handle)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return AdminCredential{}, err
	}
	if err == nil && subtle.ConstantTimeCompare(handle, e.UserHandle) != 1 {
		return AdminCredential{}, ErrAdminEnrollmentHandle
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE admin_enrollments SET state = ?, decided_at = ? WHERE id = ? AND state = ?`,
		enrollApproved, now, id, enrollPending)
	if err != nil {
		return AdminCredential{}, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return AdminCredential{}, ErrAdminEnrollmentState
	}
	c := AdminCredential{ID: e.CredID, UserHandle: e.UserHandle, CredJSON: e.CredJSON, Name: e.Name, CreatedAt: now}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO admin_credentials (id, user_handle, cred_json, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, 0)`,
		c.ID, c.UserHandle, c.CredJSON, c.Name, c.CreatedAt); err != nil {
		return AdminCredential{}, err
	}
	if err := insertCLIAudit(ctx, tx, now, actor, AuditPasskeyEnrollApprove, "passkey:"+c.ID,
		[]ChangeField{{Field: "enrollment", Old: "", New: id}, {Field: "name", Old: "", New: c.Name},
			{Field: "fingerprint", Old: "", New: want}}); err != nil {
		return AdminCredential{}, err
	}
	return c, tx.Commit()
}

// CancelEnrollment cancels an issued or pending enrollment.
func (a *AdminAuthStore) CancelEnrollment(ctx context.Context, id string, now int64, actor string) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx,
		`UPDATE admin_enrollments SET state = ?, decided_at = ?, challenge = '', challenge_expires_at = 0
		  WHERE id = ? AND state IN (?, ?)`,
		enrollCancelled, now, id, enrollIssued, enrollPending)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin_enrollments WHERE id = ?`, id).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return ErrAdminEnrollmentNotFound
		}
		return ErrAdminEnrollmentState
	}
	if err := insertCLIAudit(ctx, tx, now, actor, AuditPasskeyEnrollCancel, "enrollment:"+id, nil); err != nil {
		return err
	}
	return tx.Commit()
}

// ListCredentials returns the registered admin passkeys.
func (a *AdminAuthStore) ListCredentials(ctx context.Context) ([]AdminCredential, error) {
	return listAdminCredentials(ctx, a.db)
}

// RevokeCredential deletes one passkey and, in the same transaction, every
// session it established and every confirmation those sessions minted.
// Revoking the last passkey needs allowLast: it is not dangerous (the command
// can always enroll again) but it does sign the browser out for good.
func (a *AdminAuthStore) RevokeCredential(ctx context.Context, id string, allowLast bool, now int64, actor string) (sessions int64, err error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var exists, total int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin_credentials WHERE id = ?`, id).Scan(&exists); err != nil {
		return 0, err
	}
	if exists == 0 {
		return 0, ErrAdminCredentialNotFound
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin_credentials`).Scan(&total); err != nil {
		return 0, err
	}
	if total == 1 && !allowLast {
		return 0, ErrAdminLastCredential
	}
	// Fence first: any login or step-up ceremony begun before this revocation
	// can no longer produce a session or a confirmation, even one whose
	// assertion is already verified.
	if err := bumpAdminAuthGeneration(ctx, tx); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM admin_pending_actions WHERE session_tok IN (SELECT token FROM admin_sessions WHERE credential_id = ?)`, id); err != nil {
		return 0, err
	}
	// Cached step-up authority is dropped on EVERY remaining session, not only
	// the revoked key's own: a session signed in with key A may have stepped
	// up with the key being revoked. (The generation bump above already makes
	// such grace dead; clearing it states that in the data too.)
	if _, err := tx.ExecContext(ctx,
		`UPDATE admin_sessions SET last_step_up_at = 0, step_up_generation = -1 WHERE credential_id <> ?`, id); err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM admin_sessions WHERE credential_id = ?`, id)
	if err != nil {
		return 0, err
	}
	sessions, _ = res.RowsAffected()
	if _, err := tx.ExecContext(ctx, `DELETE FROM admin_credentials WHERE id = ?`, id); err != nil {
		return 0, err
	}
	if err := insertCLIAudit(ctx, tx, now, actor, AuditPasskeyRevoke, "passkey:"+id,
		[]ChangeField{{Field: "sessions_revoked", Old: int64(0), New: sessions}}); err != nil {
		return 0, err
	}
	return sessions, tx.Commit()
}

// AdminRevokeAllResult counts what RevokeAllSessions removed.
type AdminRevokeAllResult struct {
	Sessions, PendingActions, Ceremonies, Enrollments int64
}

// RevokeAllSessions is the incident button: every admin session, every pending
// high-risk confirmation, every in-flight WebAuthn challenge, and every
// undecided enrollment (a grant someone else may be holding) is ended.
// Registered passkeys are untouched; revoke those individually.
func (a *AdminAuthStore) RevokeAllSessions(ctx context.Context, now int64, actor string) (AdminRevokeAllResult, error) {
	var r AdminRevokeAllResult
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return r, err
	}
	defer tx.Rollback()
	// The fence is what makes this complete: deleting rows removes what
	// exists now, bumping the generation refuses what is still in flight
	// (a login that already consumed its ceremony, a verified step-up).
	if err := bumpAdminAuthGeneration(ctx, tx); err != nil {
		return AdminRevokeAllResult{}, err
	}
	steps := []struct {
		n    *int64
		q    string
		args []any
	}{
		{&r.PendingActions, `DELETE FROM admin_pending_actions`, nil},
		{&r.Sessions, `DELETE FROM admin_sessions`, nil},
		{&r.Ceremonies, `DELETE FROM admin_passkey_ceremonies`, nil},
		{&r.Enrollments, `UPDATE admin_enrollments SET state = ?, decided_at = ?, challenge = '', challenge_expires_at = 0
		    WHERE state IN (?, ?)`, []any{enrollCancelled, now, enrollIssued, enrollPending}},
	}
	for _, st := range steps {
		res, err := tx.ExecContext(ctx, st.q, st.args...)
		if err != nil {
			return AdminRevokeAllResult{}, err
		}
		*st.n, _ = res.RowsAffected()
	}
	if err := insertCLIAudit(ctx, tx, now, actor, AuditAdminSessionsRevokeAll, "-",
		[]ChangeField{{Field: "sessions", Old: r.Sessions, New: int64(0)},
			{Field: "pending_actions", Old: r.PendingActions, New: int64(0)},
			{Field: "enrollments_cancelled", Old: int64(0), New: r.Enrollments}}); err != nil {
		return AdminRevokeAllResult{}, err
	}
	return r, tx.Commit()
}

// AdminSessionSummary describes one live session for the status view. It holds
// no token.
type AdminSessionSummary struct {
	CredentialID string
	CreatedAt    int64
	LastSeenAt   int64
}

// ListLiveSessions returns the sessions that would currently validate.
func (a *AdminAuthStore) ListLiveSessions(ctx context.Context, now int64) ([]AdminSessionSummary, error) {
	rows, err := a.db.QueryContext(ctx,
		`SELECT credential_id, created_at, last_seen_at FROM admin_sessions
		  WHERE auth = 'passkey' AND credential_id <> '' AND expires > ? AND created_at > ? AND last_seen_at > ?
		    AND EXISTS (SELECT 1 FROM admin_credentials c WHERE c.id = admin_sessions.credential_id)
		  ORDER BY last_seen_at DESC`,
		now, now-int64(adminSessionAbsoluteTTL/time.Second), now-int64(adminSessionIdleTTL/time.Second))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminSessionSummary
	for rows.Next() {
		var s AdminSessionSummary
		if err := rows.Scan(&s.CredentialID, &s.CreatedAt, &s.LastSeenAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// insertCLIAudit records a local-command action in the same admin_audit trail
// the console shows. auth is "cli" and ip "local": the command is reachable
// only from a shell on the server.
func insertCLIAudit(ctx context.Context, tx *sql.Tx, now int64, actor, action, target string, fields []ChangeField) error {
	if actor == "" {
		actor = "cli"
	}
	_, err := tx.ExecContext(ctx,
		`INSERT INTO admin_audit (at, actor, ip, auth, action, target, changes, step_up) VALUES (?, ?, 'local', 'cli', ?, ?, ?, '')`,
		now, actor, action, target, encodeChanges(fields))
	return err
}

func listAdminCredentials(ctx context.Context, db *sql.DB) ([]AdminCredential, error) {
	rows, err := db.QueryContext(ctx, `
SELECT id, user_handle, cred_json, name, created_at, last_used_at
FROM admin_credentials ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminCredential
	for rows.Next() {
		var c AdminCredential
		if err := rows.Scan(&c.ID, &c.UserHandle, &c.CredJSON, &c.Name, &c.CreatedAt, &c.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// adminCredentialFingerprint is the short code the enrollment page shows and
// the operator types at the terminal: the first 80 bits of SHA-256 over the
// credential ID and its public key, in five groups of four hex digits. It is a
// comparison code, not a secret.
func adminCredentialFingerprint(credJSON []byte) (string, error) {
	var c webauthn.Credential
	if err := json.Unmarshal(credJSON, &c); err != nil {
		return "", err
	}
	if len(c.ID) == 0 || len(c.PublicKey) == 0 {
		return "", errors.New("credential has no id or public key")
	}
	return adminFingerprintOf(c.ID, c.PublicKey), nil
}

func adminFingerprintOf(id, publicKey []byte) string {
	h := sha256.New()
	h.Write([]byte("relayium-admin-passkey-v1\x00"))
	h.Write(id)
	h.Write([]byte{0})
	h.Write(publicKey)
	s := strings.ToUpper(hex.EncodeToString(h.Sum(nil)[:10]))
	return s[0:4] + "-" + s[4:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20]
}

// AdminCredentialFingerprint is the exported form for the local command.
func AdminCredentialFingerprint(c AdminCredential) string {
	fp, err := adminCredentialFingerprint(c.CredJSON)
	if err != nil {
		return "unreadable"
	}
	return fp
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

func normalizeAdminFingerprint(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	return strings.NewReplacer("-", "", " ", "").Replace(s)
}
