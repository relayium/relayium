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

// SQLiteStore keeps a single writer connection (db) — write-path atomicity
// relies on MaxOpenConns(1) serializing writers — plus, for a file-backed DB, a
// separate read-only pool (rdb) so a slow admin query doesn't block the writer.
// rdb is nil for :memory: (a second connection would see a separate empty DB).
type SQLiteStore struct {
	db  *sql.DB
	rdb *sql.DB
}

// reader returns the read pool for heavy reads, falling back to the writer
// connection when there is no separate pool (:memory:).
func (s *SQLiteStore) reader() *sql.DB {
	if s.rdb != nil {
		return s.rdb
	}
	return s.db
}

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
CREATE TABLE IF NOT EXISTS cli_device_auth (
  user_code        TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL,
  user_id          TEXT NOT NULL DEFAULT '',
  token_hash       TEXT NOT NULL DEFAULT '',
  pending_token    TEXT NOT NULL DEFAULT '', -- raw one-time token, held only between approve and the next poll
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  consumed_at      INTEGER NOT NULL DEFAULT 0,
  client_ip        TEXT NOT NULL DEFAULT '', -- origin of the CLI that started the flow, shown on /device to help spot phishing
  user_agent       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cli_device_auth_expires ON cli_device_auth(expires_at);
CREATE TABLE IF NOT EXISTS cli_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id),
  -- ON DELETE CASCADE makes DELETE /api/devices/{id} (bare DELETE FROM devices)
  -- the CLI-token revocation path: removing a CLI device cascade-deletes its
  -- token row instead of failing the FK, so a leaked rlm_cli_ token can be
  -- invalidated from the web devices page (per spec). user_id stays un-cascaded.
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS usage_archive (
  period         TEXT PRIMARY KEY,
  upload_bytes   INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  storage_bytes  INTEGER NOT NULL,
  traffic_bytes  INTEGER NOT NULL,
  retention_secs INTEGER NOT NULL,
  price_monthly  INTEGER NOT NULL DEFAULT 0,
  price_yearly   INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);
`

// connPragmas are applied to every connection via the DSN (not a one-shot
// ExecContext, which would only reach whichever pooled connection ran it):
//   - busy_timeout: wait rather than fail on a locked DB (a node process or a
//     WAL checkpoint holding the file) instead of surfacing SQLITE_BUSY.
//   - foreign_keys: enforce the REFERENCES users(id) constraints, which SQLite
//     leaves off by default. It only checks new operations, so an upgrade can't
//     fail on pre-existing rows; writers skip unattributable (ownerless) usage
//     rows so no path violates it.
var connPragmas = []string{"busy_timeout(5000)", "foreign_keys(1)"}

// withPragmas appends _pragma query params to a modernc sqlite DSN.
func withPragmas(dsn string, pragmas ...string) string {
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	q := make([]string, len(pragmas))
	for i, p := range pragmas {
		q[i] = "_pragma=" + p
	}
	return dsn + sep + strings.Join(q, "&")
}

func OpenSQLite(dsn string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", withPragmas(dsn, connPragmas...))
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
		// Human-set display name / note for a node. Seeded from the node token's
		// name at first register, then editable from the dashboard/admin.
		`ALTER TABLE nodes ADD COLUMN label TEXT NOT NULL DEFAULT ''`,
		// device-code CLI login flow: distinguishes a CLI-registered device
		// ("cli") from the default browser device. Existing rows default to ''.
		`ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT ''`,
		// Account self-deletion lifecycle: deleted_at marks a pending-deletion
		// request, purge_after is the GC hard-delete deadline, purge_reminder_sent
		// tracks the one-time pre-purge reminder email. 0 = active/not scheduled
		// for existing and new rows alike, so no backfill is needed.
		`ALTER TABLE users ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN purge_after INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN purge_reminder_sent INTEGER NOT NULL DEFAULT 0`,
		// device-code CLI login: record the requesting CLI's origin so the
		// browser approval page can show what it's authorizing (anti-phishing).
		`ALTER TABLE cli_device_auth ADD COLUMN client_ip TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE cli_device_auth ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''`,
		// Billing plans phase-1: every user is assigned a plan tier, defaulting
		// to the free plan for existing and new rows alike.
		`ALTER TABLE users ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'free'`,
		// Billing Stripe phase-2: plans carry their Stripe Price ids per billing
		// cycle; users carry their Stripe customer/subscription state. Existing
		// rows default to '' / 0, which reads as "no Stripe state yet".
		`ALTER TABLE plans ADD COLUMN stripe_price_monthly_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE plans ADD COLUMN stripe_price_yearly_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN subscription_end INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN plan_source TEXT NOT NULL DEFAULT ''`,
		// In-app downgrade UX: the tier a pending period-end downgrade will switch
		// to (via a Stripe subscription schedule); '' = no pending change. It's a
		// display hint — set when the endpoint schedules a downgrade, cleared when
		// the downgrade lands (webhook), is canceled, or the subscription ends.
		`ALTER TABLE users ADD COLUMN scheduled_plan_id TEXT NOT NULL DEFAULT ''`,
		// 配额防套利（2026-07）：月中改档不再白送整月流量额度，而是把当月按档位
		// 分段、每段按占比计算。见 accrueQuotaTx 与 Service.monthlyTrafficCap。
		`ALTER TABLE users ADD COLUMN plan_started_at INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN quota_accrued_bytes INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN quota_accrued_period TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := db.ExecContext(context.Background(), alter); err != nil &&
			!strings.Contains(err.Error(), "duplicate column name") {
			db.Close()
			return nil, err
		}
	}
	// max_downloads generalizes burn_after_read into a download-count limit:
	// 0 = unlimited until TTL, N = delete after the Nth download, 1 = burn.
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE stored_files ADD COLUMN max_downloads INTEGER NOT NULL DEFAULT 0`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, err
	}
	// Backfill pre-existing burn rows to max_downloads=1 UNCONDITIONALLY on every
	// boot — NOT gated on the ALTER succeeding. If the process died between a
	// successful ALTER and this UPDATE, gating it on the ALTER would make every
	// later boot see "duplicate column name", skip the backfill forever, and leave
	// pre-existing burn-after-read rows at max_downloads=0 (downloadable
	// indefinitely — defeating burn-after-read). Running it every boot self-heals
	// that crash window. It's idempotent and cheap: the AND max_downloads = 0 guard
	// scopes it to only the rows that still need it (re-asserting 1 where already 1
	// is a no-op; our model guarantees burn_after_read=1 ⟺ max_downloads=1).
	if _, err := db.ExecContext(context.Background(),
		`UPDATE stored_files SET max_downloads = 1 WHERE burn_after_read = 1 AND max_downloads = 0`); err != nil {
		db.Close()
		return nil, err
	}
	// The billing hot paths now read the usage_periods buckets (see below), not
	// usage_events, so the recorded_at composite indexes an earlier version added
	// here are dead weight — and they added write cost to every heartbeat's
	// high-water update. Drop them.
	for _, idx := range []string{
		`DROP INDEX IF EXISTS idx_usage_user_recorded`,
		`DROP INDEX IF EXISTS idx_usage_node_recorded`,
	} {
		if _, err := db.ExecContext(context.Background(), idx); err != nil {
			db.Close()
			return nil, err
		}
	}
	// usage_periods buckets relayed bytes by the month they occurred in, fixing the
	// cross-month drift of usage_events (whose single per-alloc row's recorded_at
	// gets bumped to the latest month, misattributing an allocation's whole
	// cumulative total to whatever month it was last touched). usage_events stays
	// as the per-alloc high-water anchor; usage_periods holds the per-period deltas
	// the billing/cap queries read. Backfill ONCE on first creation, mapping each
	// existing alloc's cumulative to periodOf(recorded_at) so current totals are
	// preserved exactly (no billing jump on upgrade).
	var periodsExisted int
	if err := db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='usage_periods'`).Scan(&periodsExisted); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.ExecContext(context.Background(), `
		CREATE TABLE IF NOT EXISTS usage_periods (
		  alloc_id TEXT NOT NULL,
		  period   TEXT NOT NULL,   -- 'YYYYMM', matches periodOf()
		  user_id  TEXT NOT NULL,
		  node_id  TEXT,
		  billable INTEGER NOT NULL DEFAULT 1,
		  bytes    INTEGER NOT NULL DEFAULT 0,
		  PRIMARY KEY (alloc_id, period)
		);
		CREATE INDEX IF NOT EXISTS idx_usage_periods_user ON usage_periods(user_id, period, billable);
		CREATE INDEX IF NOT EXISTS idx_usage_periods_node ON usage_periods(node_id, period);`); err != nil {
		db.Close()
		return nil, err
	}
	if periodsExisted == 0 {
		if _, err := db.ExecContext(context.Background(), `
			INSERT OR IGNORE INTO usage_periods (alloc_id, period, user_id, node_id, billable, bytes)
			  SELECT alloc_id, strftime('%Y%m', recorded_at, 'unixepoch'), user_id, node_id, billable, relayed_bytes
			  FROM usage_events`); err != nil {
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

	s := &SQLiteStore{db: db}
	// For a file-backed DB, switch to WAL (readers don't block the single writer
	// and vice versa) and open a separate read-only pool so a slow admin query
	// runs off the writer connection instead of stalling uploads/heartbeats.
	// :memory: keeps the single connection (a second one would be a distinct DB).
	if !strings.Contains(dsn, ":memory:") {
		if _, err := db.ExecContext(context.Background(), `PRAGMA journal_mode = WAL`); err != nil {
			db.Close()
			return nil, err
		}
		rdb, err := sql.Open("sqlite", withPragmas(dsn, connPragmas...))
		if err != nil {
			db.Close()
			return nil, err
		}
		rdb.SetMaxOpenConns(4)
		s.rdb = rdb
	}
	return s, nil
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

func (s *SQLiteStore) Close() error {
	if s.rdb != nil {
		s.rdb.Close()
	}
	return s.db.Close()
}

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
		`SELECT id, email, display_name, created_at, email_verified, deleted_at, purge_after, plan_id,
		        stripe_customer_id, subscription_status, subscription_end, plan_source, scheduled_plan_id
		   FROM users WHERE email = ?`, email,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID)
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
		`SELECT id, email, display_name, created_at, email_verified, deleted_at, purge_after, plan_id,
		        stripe_customer_id, subscription_status, subscription_end, plan_source, scheduled_plan_id
		   FROM users WHERE canonical_email = ? LIMIT 1`, canonical,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID)
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
		`SELECT id, email, display_name, created_at, email_verified, only_own_nodes, deleted_at, purge_after, plan_id,
		        stripe_customer_id, subscription_status, subscription_end, plan_source, scheduled_plan_id,
		        plan_started_at, quota_accrued_bytes, quota_accrued_period
		   FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID,
		&u.PlanStartedAt, &u.QuotaAccruedBytes, &u.QuotaAccruedPeriod)
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

// accrueQuotaTx 冻结用户在**当前**档位下已经挣到的那部分流量额度，然后把新段
// 的起点打上时间戳。必须在同一个事务里、并且在覆盖 plan_id **之前**调用——
// 覆盖之后就读不到改档前的档位了。
//
// 当月的流量上限 = Σ(各档位段的 cap × 该段秒数 / 当月秒数)。每次改档都冻结一
// 次，是为了堵住这个套利：31 号从 Plus 升到 Max，Stripe 只按 ~2/31 的比例收
// 几毛钱差价，但按整月发额度的话用户当场白拿一整个 Max 月的流量。
//
// 三条短路：
//  1. 档位没变 → 直接返回。Stripe 的 subscription.updated 会在纯状态变更时
//     反复投递同一个 plan_id；每次切段数学上等价，但整数除法的截断会一点点
//     蚕食用户额度。
//  2. 累计值属于上个月 → 归零。上月冻结的额度不能带进新月份。
//  3. 旧档是无限档（traffic_bytes <= 0）→ 不贡献任何累计。cap<=0 在别处一律
//     表示"无限"，用户离开该档后本月应当回落到新档的普通比例，而不是继承一
//     个无意义的天文数字。（这一条以及 segSecs<=0/monthSecs<=0 的短路由
//     prorate 自己守卫，见其注释。）
func accrueQuotaTx(ctx context.Context, tx *sql.Tx, userID, newPlanID string, now int64) error {
	var curPlan, accruedPeriod string
	var startedAt, accrued int64
	err := tx.QueryRowContext(ctx,
		`SELECT plan_id, plan_started_at, quota_accrued_bytes, quota_accrued_period
		   FROM users WHERE id = ?`, userID).
		Scan(&curPlan, &startedAt, &accrued, &accruedPeriod)
	if err == sql.ErrNoRows {
		return nil // 用户不存在：让后面的 UPDATE 自己去影响 0 行，语义不变
	}
	if err != nil {
		return err
	}
	if curPlan == newPlanID {
		return nil
	}

	period := periodOf(now)
	segStart, monthStart, monthEnd := segmentBounds(period, startedAt)
	if accruedPeriod != period {
		accrued = 0
	}

	var cap sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT traffic_bytes FROM plans WHERE id = ?`, curPlan).Scan(&cap); err != nil && err != sql.ErrNoRows {
		return err
	}

	monthSecs := monthEnd - monthStart
	segSecs := now - segStart
	if cap.Valid {
		accrued += prorate(cap.Int64, segSecs, monthSecs)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE users SET quota_accrued_bytes = ?, quota_accrued_period = ?, plan_started_at = ? WHERE id = ?`,
		accrued, period, now, userID)
	return err
}

// SetUserPlan assigns a user's billing tier (plans.id).
//
// 累计与 plan_id 的写入放在同一事务里：如果两者分开，进程在中间崩溃会留下
// "额度已冻结但档位没变"或反之的脏状态，用户的当月上限就永久算错了。
func (s *SQLiteStore) SetUserPlan(ctx context.Context, userID, planID string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // Commit 成功后是 no-op
	if err := accrueQuotaTx(ctx, tx, userID, planID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET plan_id = ? WHERE id = ?`, planID, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetUserPlanAdmin assigns a user's billing tier from the admin console,
// recording plan_source='admin' so a later Stripe webhook (see
// SetUserSubscription) won't fight the manual comp. It also clears any
// stale subscription_status/subscription_end left over from a prior Stripe
// subscription: a manual admin comp supersedes that subscription record,
// and a later webhook for an admin-source user will re-populate
// status/end while keeping the admin-assigned plan.
//
// 累计与 plan_id 的写入放在同一事务里：如果两者分开，进程在中间崩溃会留下
// "额度已冻结但档位没变"或反之的脏状态，用户的当月上限就永久算错了。
func (s *SQLiteStore) SetUserPlanAdmin(ctx context.Context, userID, planID string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := accrueQuotaTx(ctx, tx, userID, planID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET plan_id = ?, plan_source = 'admin', subscription_status = '', subscription_end = 0 WHERE id = ?`,
		planID, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetUserStripeCustomer binds a user to their Stripe customer id, set once on
// first checkout (or backfilled by the webhook if it observes a new customer).
func (s *SQLiteStore) SetUserStripeCustomer(ctx context.Context, userID, customerID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET stripe_customer_id = ? WHERE id = ?`, customerID, userID)
	return err
}

// GetUserByStripeCustomer looks up a user by Stripe customer id (webhook
// dispatch). An empty customerID intentionally returns not-found: every
// pre-Stripe row defaults stripe_customer_id to ”, so matching "" would
// return an arbitrary user instead of "unknown".
//
// 这条 SELECT 有意不取配额分段三列（plan_started_at / quota_accrued_bytes /
// quota_accrued_period），因此该路径返回的 User 上这三个字段恒为零值。现有
// 调用方（billing.go）只读 PlanSource/PlanID/ScheduledPlanID，所以无害；但
// 任何将来要从这条路径读配额字段的代码，都必须先把这三列加进 SELECT。
func (s *SQLiteStore) GetUserByStripeCustomer(ctx context.Context, customerID string) (User, bool, error) {
	if customerID == "" {
		return User{}, false, nil
	}
	var u User
	var strict int
	err := s.reader().QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, only_own_nodes, deleted_at, purge_after, plan_id,
		        stripe_customer_id, subscription_status, subscription_end, plan_source, scheduled_plan_id
		   FROM users WHERE stripe_customer_id = ?`, customerID,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID)
	if err == sql.ErrNoRows {
		return User{}, false, nil
	}
	if err != nil {
		return User{}, false, err
	}
	u.OnlyOwnNodes = strict != 0
	return u, true, nil
}

// SetUserSubscription updates a user's plan and subscription state together
// (Stripe webhook path): plan_id, subscription_status, subscription_end, and
// plan_source in one UPDATE so a reader never observes a torn intermediate
// state.
//
// 累计与 plan_id 的写入放在同一事务里：如果两者分开，进程在中间崩溃会留下
// "额度已冻结但档位没变"或反之的脏状态，用户的当月上限就永久算错了。
func (s *SQLiteStore) SetUserSubscription(ctx context.Context, userID, planID, status string, end int64, source string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := accrueQuotaTx(ctx, tx, userID, planID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET plan_id = ?, subscription_status = ?, subscription_end = ?, plan_source = ? WHERE id = ?`,
		planID, status, end, source, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLiteStore) SetScheduledPlan(ctx context.Context, userID, planID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET scheduled_plan_id = ? WHERE id = ?`, planID, userID)
	return err
}

// PlanByStripePrice resolves a webhook's Stripe Price id to the plan tier
// mapped to it (either the monthly or the yearly price). An empty priceID
// intentionally returns not-found: every plan defaults both price columns to
// ”, so matching "" would return an arbitrary plan instead of "unmapped".
func (s *SQLiteStore) PlanByStripePrice(ctx context.Context, priceID string) (Plan, bool, error) {
	if priceID == "" {
		return Plan{}, false, nil
	}
	p, err := scanPlan(s.reader().QueryRowContext(ctx,
		`SELECT `+planCols+` FROM plans WHERE stripe_price_monthly_id = ? OR stripe_price_yearly_id = ?`,
		priceID, priceID))
	if err == sql.ErrNoRows {
		return Plan{}, false, nil
	}
	if err != nil {
		return Plan{}, false, err
	}
	return p, true, nil
}

// SetAccountDeletion schedules a user for deletion (deleted_at + purge_after),
// resetting purge_reminder_sent so a cancel-then-re-request re-arms it.
func (s *SQLiteStore) SetAccountDeletion(ctx context.Context, userID string, deletedAt, purgeAfter int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET deleted_at = ?, purge_after = ?, purge_reminder_sent = 0 WHERE id = ?`,
		deletedAt, purgeAfter, userID)
	return err
}

// ClearAccountDeletion cancels a pending deletion, zeroing all three
// lifecycle columns.
func (s *SQLiteStore) ClearAccountDeletion(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET deleted_at = 0, purge_after = 0, purge_reminder_sent = 0 WHERE id = ?`, userID)
	return err
}

// MarkPurgeReminderSent records when the pre-purge reminder email was sent.
func (s *SQLiteStore) MarkPurgeReminderSent(ctx context.Context, userID string, at int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET purge_reminder_sent = ? WHERE id = ?`, at, userID)
	return err
}

// PurgeTransientUserData wipes a user's transient/live data at
// deletion-confirmation time, keeping the account shell (users row +
// identities + usage_events/usage_monthly/user_stats) intact until the
// 30-day hard-purge (GC). It returns the user's stored_files (selected
// before the delete) so the caller can enqueue blob deletes.
//
// magic_tokens has no user_id column (it's keyed by the login email, not an
// account row — see CreateMagicToken), so it's purged by matching the user's
// current email instead. node_tokens carries its own user_id column (plus a
// nullable, unbound-until-claimed node_id), so it's deleted directly by
// user_id rather than via a nodes subquery, which would miss unbound tokens.
func (s *SQLiteStore) PurgeTransientUserData(ctx context.Context, userID string) ([]StoredFile, error) {
	files, err := s.ListStoredFilesByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	stmts := []struct {
		q    string
		args []any
	}{
		{`DELETE FROM sessions WHERE user_id=?`, []any{userID}},
		{`DELETE FROM cli_tokens WHERE user_id=?`, []any{userID}},
		{`DELETE FROM cli_device_auth WHERE user_id=?`, []any{userID}},
		{`DELETE FROM devices WHERE user_id=?`, []any{userID}},
		{`DELETE FROM magic_tokens WHERE email=(SELECT email FROM users WHERE id=?)`, []any{userID}},
		{`DELETE FROM stored_files WHERE user_id=?`, []any{userID}},
		{`DELETE FROM node_tokens WHERE user_id=?`, []any{userID}},
		{`DELETE FROM nodes WHERE owner_type='user' AND owner_user_id=?`, []any{userID}},
	}
	for _, st := range stmts {
		if _, err := tx.ExecContext(ctx, st.q, st.args...); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return files, nil
}

// ListUsersToPurge returns every user due for GC's hard purge: a pending
// deletion (purge_after>0) whose grace period has fully elapsed (<=now).
func (s *SQLiteStore) ListUsersToPurge(ctx context.Context, now int64) ([]User, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, deleted_at, purge_after
		   FROM users WHERE purge_after > 0 AND purge_after <= ?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &u.DeletedAt, &u.PurgeAfter); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ListUsersToRemind returns every pending-deletion user who hasn't yet
// received the one-time pre-purge reminder and whose purge_after falls
// within [now, now+remindWindow].
func (s *SQLiteStore) ListUsersToRemind(ctx context.Context, now, remindWindow int64) ([]User, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, deleted_at, purge_after
		   FROM users
		  WHERE purge_after > 0 AND purge_reminder_sent = 0 AND purge_after <= ?`, now+remindWindow)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &u.DeletedAt, &u.PurgeAfter); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// ArchiveAndPurgeUser is GC's hard-purge: folds userID's usage_monthly into
// the anonymized usage_archive (period totals only — no user_id retained),
// then deletes every user-linked row before the users row itself, all inside
// one transaction. The delete set is a superset of PurgeTransientUserData's
// (which already ran at confirm time): repeating those deletes here is a
// harmless no-op and keeps this method correct standalone, independent of
// what already ran. Order is children-before-parent so PRAGMA foreign_keys=ON
// never rejects a delete.
//
// The final users delete is guarded on the account still being due
// (purge_after>0 AND purge_after<=now), re-read inside this write transaction
// rather than trusted from GC's earlier ListUsersToPurge snapshot. If a
// concurrent reactivation cleared the schedule between the snapshot and here,
// the guard matches zero rows and the whole purge (archive + child deletes)
// rolls back, so a user who reactivated during the grace window is never
// destroyed. SQLite serializes writers, so the guarded delete and
// ClearAccountDeletion cannot interleave: whichever commits first wins.
func (s *SQLiteStore) ArchiveAndPurgeUser(ctx context.Context, userID string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_archive(period, upload_bytes, download_bytes)
		SELECT period, upload_bytes, download_bytes FROM usage_monthly WHERE user_id=?
		ON CONFLICT(period) DO UPDATE SET
		  upload_bytes = upload_bytes + excluded.upload_bytes,
		  download_bytes = download_bytes + excluded.download_bytes`, userID); err != nil {
		return err
	}

	stmts := []struct {
		q    string
		args []any
	}{
		// FK tables (REFERENCES users(id)) — must precede DELETE FROM users.
		{`DELETE FROM identities WHERE user_id=?`, []any{userID}},
		{`DELETE FROM sessions WHERE user_id=?`, []any{userID}},
		{`DELETE FROM devices WHERE user_id=?`, []any{userID}},
		{`DELETE FROM usage_events WHERE user_id=?`, []any{userID}},
		{`DELETE FROM stored_files WHERE user_id=?`, []any{userID}},
		{`DELETE FROM upload_events WHERE user_id=?`, []any{userID}},
		{`DELETE FROM user_stats WHERE user_id=?`, []any{userID}},
		{`DELETE FROM usage_monthly WHERE user_id=?`, []any{userID}},
		{`DELETE FROM email_tokens WHERE user_id=?`, []any{userID}},
		{`DELETE FROM node_tokens WHERE user_id=?`, []any{userID}},
		{`DELETE FROM cli_tokens WHERE user_id=?`, []any{userID}},
		// Non-FK but user-owned.
		{`DELETE FROM magic_tokens WHERE email=(SELECT email FROM users WHERE id=?)`, []any{userID}},
		{`DELETE FROM cli_device_auth WHERE user_id=?`, []any{userID}},
		{`DELETE FROM nodes WHERE owner_type='user' AND owner_user_id=?`, []any{userID}},
	}
	for _, st := range stmts {
		if _, err := tx.ExecContext(ctx, st.q, st.args...); err != nil {
			return err
		}
	}
	// Finally, the users row itself — but only if the account is still due for
	// purge. A reactivation that committed after GC's snapshot zeroes
	// purge_after; the guard then matches nothing and the deferred Rollback
	// undoes the archive + child deletes, sparing the revived account.
	res, err := tx.ExecContext(ctx,
		`DELETE FROM users WHERE id=? AND purge_after>0 AND purge_after<=?`, userID, now)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return nil // no longer due (reactivated / already purged): abort, rollback
	}
	return tx.Commit()
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

func (s *SQLiteStore) ListIdentityProviders(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT provider FROM identities WHERE user_id = ? ORDER BY provider`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) UnlinkIdentity(ctx context.Context, provider, userID string) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM identities WHERE provider = ? AND user_id = ?`, provider, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
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

const deviceCols = `id, user_id, name, created_at, last_seen_at, kind`

func (s *SQLiteStore) UpsertDevice(ctx context.Context, d Device) (Device, error) {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (`+deviceCols+`)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind
		 WHERE devices.user_id = excluded.user_id`,
		d.ID, d.UserID, d.Name, d.CreatedAt, d.LastSeenAt, d.Kind)
	if err != nil {
		return Device{}, err
	}
	var out Device
	err = s.db.QueryRowContext(ctx,
		`SELECT `+deviceCols+` FROM devices WHERE id = ? AND user_id = ?`,
		d.ID, d.UserID,
	).Scan(&out.ID, &out.UserID, &out.Name, &out.CreatedAt, &out.LastSeenAt, &out.Kind)
	return out, err
}

func (s *SQLiteStore) ListDevices(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+deviceCols+` FROM devices WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Device
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.ID, &d.UserID, &d.Name, &d.CreatedAt, &d.LastSeenAt, &d.Kind); err != nil {
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

// Relay-usage self-report bounds (workstream A). Nodes are the only party that
// sees relayed bytes, so their reports can't be independently verified — but
// they can be bounded to physically-plausible values. Conservative on purpose:
// clamping under-counts a genuine ultra-fast transfer (user-favorable) while
// denying a malicious node the ability to inflate a victim's usage.
const (
	// maxRelayBytesPerSec caps how fast one allocation may be reported to relay
	// (per side). ~210 Mbps.
	maxRelayBytesPerSec = 25 << 20
	// relayReportSlack is added to the bandwidth×elapsed budget between heartbeats
	// to absorb bursts and the first-report window.
	relayReportSlack = 256 << 20
	// maxAllocRelayBytes is the absolute ceiling on any single allocation's
	// reported total (~one day at maxRelayBytesPerSec), so a forged huge value
	// (e.g. 1<<50) can never blow a user's quota or the billing ledger.
	maxAllocRelayBytes = int64(maxRelayBytesPerSec)*86400 + relayReportSlack
)

// RecordUsage records an allocation's relayed bytes. The reported cumulative is
// clamped to physically-plausible bounds — monotonic, capped by (a) an absolute
// per-allocation ceiling and (b) the prior total plus maxRelayBytesPerSec ×
// time-since-last-report + slack (workstream A) — and the resulting increment is
// attributed to the month it occurred in (workstream C), so a long-lived
// allocation that spans a month boundary is billed to each month correctly
// rather than having its whole cumulative reattributed to the latest month.
// usage_events holds the per-alloc high-water mark; usage_periods holds the
// per-month deltas the billing/cap queries read.
func (s *SQLiteStore) RecordUsage(ctx context.Context, e UsageEvent) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var prev, prevRec int64
	exists := true
	switch err := tx.QueryRowContext(ctx,
		`SELECT relayed_bytes, recorded_at FROM usage_events WHERE alloc_id = ?`, e.AllocID).
		Scan(&prev, &prevRec); err {
	case nil:
	case sql.ErrNoRows:
		exists = false
	default:
		return err
	}

	// Clamp the reported cumulative.
	newCum := e.RelayedBytes
	if newCum > maxAllocRelayBytes {
		newCum = maxAllocRelayBytes
	}
	if exists {
		if budget := prev + int64(maxRelayBytesPerSec)*(e.RecordedAt-prevRec) + int64(relayReportSlack); newCum > budget {
			newCum = budget
		}
		if newCum < prev { // monotonic: never lower on a stale/backwards report
			newCum = prev
		}
	}
	delta := newCum - prev

	if exists {
		if _, err := tx.ExecContext(ctx,
			`UPDATE usage_events SET relayed_bytes = ?, recorded_at = ? WHERE alloc_id = ?`,
			newCum, e.RecordedAt, e.AllocID); err != nil {
			return err
		}
	} else {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO usage_events (alloc_id, token, user_id, relayed_bytes, recorded_at, node_id, billable)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			e.AllocID, e.Token, e.UserID, newCum, e.RecordedAt, nullStr(e.NodeID), b2i(e.Billable)); err != nil {
			return err
		}
	}

	// Attribute the increment to the period it occurred in.
	if delta > 0 {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO usage_periods (alloc_id, period, user_id, node_id, billable, bytes)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(alloc_id, period) DO UPDATE SET bytes = bytes + excluded.bytes`,
			e.AllocID, periodOf(e.RecordedAt), e.UserID, nullStr(e.NodeID), b2i(e.Billable), delta); err != nil {
			return err
		}
	}
	return tx.Commit()
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

// UserRelayedSince sums a user's billable relayed bytes in the month(s) at or
// after `since` (a month-start unix; used for the monthly relay cap). Reads the
// per-month usage_periods buckets so a cross-month allocation is counted only in
// the months it actually relayed, not reattributed to its latest heartbeat.
func (s *SQLiteStore) UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error) {
	var total int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(bytes),0) FROM usage_periods WHERE user_id = ? AND period >= ? AND billable = 1`,
		userID, periodOf(since)).Scan(&total)
	return total, err
}

// NodeRelayedSince sums relayed bytes per node for the month(s) at or after
// `since` (a month-start unix, for the per-node traffic cap). Keyed by node id;
// nodes with no usage in the window are absent (treated as 0 by callers).
func (s *SQLiteStore) NodeRelayedSince(ctx context.Context, since int64) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT node_id, COALESCE(SUM(bytes),0) FROM usage_periods
		   WHERE period >= ? AND node_id IS NOT NULL GROUP BY node_id`, periodOf(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]int64)
	for rows.Next() {
		var id string
		var total int64
		if err := rows.Scan(&id, &total); err != nil {
			return nil, err
		}
		out[id] = total
	}
	return out, rows.Err()
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
	if err := s.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM users u`+where, whereArgs...).Scan(&total); err != nil {
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

	listArgs := append([]any{q.Period, q.Period, q.Period, q.Now}, whereArgs...)
	listArgs = append(listArgs, q.Limit, q.Offset)
	rows, err := s.reader().QueryContext(ctx, `
		SELECT u.id, u.email, u.display_name, u.created_at,
		       (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id),
		       (SELECT COALESCE(SUM(up.bytes),0) FROM usage_periods up
		          WHERE up.user_id = u.id AND up.period = ?) AS relayed_bytes,
		       (SELECT COALESCE(SUM(um.upload_bytes),0) FROM usage_monthly um
		          WHERE um.user_id = u.id AND um.period = ?) AS upload_bytes,
		       (SELECT COALESCE(SUM(um.download_bytes),0) FROM usage_monthly um
		          WHERE um.user_id = u.id AND um.period = ?) AS download_bytes,
		       (SELECT COALESCE(SUM(sf.size),0) FROM stored_files sf
		          WHERE sf.user_id = u.id AND sf.expires_at > ?) AS storage_bytes,
		       u.plan_id, u.subscription_status, u.plan_source
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
			&row.UploadBytes, &row.DownloadBytes, &row.StorageBytes, &row.PlanID,
			&row.SubscriptionStatus, &row.PlanSource); err != nil {
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
	var m AdminMetrics
	err := s.reader().QueryRowContext(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM users),
		  (SELECT COUNT(*) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(upload_bytes),0) FROM usage_monthly WHERE period = ?),
		  (SELECT COALESCE(SUM(download_bytes),0) FROM usage_monthly WHERE period = ?),
		  (SELECT COALESCE(SUM(bytes),0) FROM usage_periods WHERE period = ?)`,
		now, now, period, period, period,
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
		&burn, &f.CreatedAt, &f.ExpiresAt, &f.DownloadedAt, &nodeID, &f.MaxDownloads, &f.DownloadCount)
	f.BurnAfterRead = burn != 0
	f.NodeID = nodeID.String
	return f, err
}

// storedFileCols is the INSERT column list (CreateStoredFile). storedFileSelectCols
// adds download_count and max_downloads, which default on insert (0) and are only
// ever read back / mutated in place by ClaimDownloadSlot etc.
const storedFileCols = `id, user_id, blob_key, enc_manifest, size, burn_after_read, created_at, expires_at, downloaded_at, node_id, max_downloads`
const storedFileSelectCols = storedFileCols + `, download_count`

func (s *SQLiteStore) CreateStoredFile(ctx context.Context, f StoredFile) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO stored_files (`+storedFileCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.UserID, f.BlobKey, f.EncManifest, f.Size,
		b2i(f.BurnAfterRead), f.CreatedAt, f.ExpiresAt, f.DownloadedAt, nullStr(f.NodeID), f.MaxDownloads)
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

// ReleaseBurnDownload undoes a claim whose download failed mid-stream. The
// downloaded_at=? guard means it only clears the claim it made, so a concurrent
// re-claim (different timestamp) is left intact.
func (s *SQLiteStore) ReleaseBurnDownload(ctx context.Context, id string, claimedAt int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE stored_files SET downloaded_at = 0 WHERE id = ? AND burn_after_read = 1 AND downloaded_at = ?`,
		id, claimedAt)
	return err
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

// ClaimDownloadSlot atomically takes one of a file's remaining download slots:
// the WHERE clause (max_downloads = 0 OR download_count < max_downloads) means
// only callers that still fit under the cap succeed, so concurrent GETs racing
// on the same near-exhausted file each get an authoritative claimed/not-claimed
// answer instead of over-counting. RETURNING hands back the post-increment
// download_count in the SAME atomic statement as the UPDATE, so slot is this
// request's own 1-based slot number — not a value a concurrent claim (which
// may later fail and release) can inflate out from under a caller that reads
// it back separately. Callers must gate any "was this the last slot" decision
// (e.g. handleFileBlob's delete-when-exhausted) on this returned slot, never
// on a fresh re-read of download_count.
func (s *SQLiteStore) ClaimDownloadSlot(ctx context.Context, id string, at int64) (int64, bool, error) {
	var slot int64
	err := s.db.QueryRowContext(ctx,
		`UPDATE stored_files
		    SET download_count = download_count + 1,
		        downloaded_at = ?
		  WHERE id = ?
		    AND (max_downloads = 0 OR download_count < max_downloads)
		  RETURNING download_count`,
		at, id).Scan(&slot)
	if err != nil {
		if err == sql.ErrNoRows {
			return 0, false, nil
		}
		return 0, false, err
	}
	return slot, true, nil
}

// ReleaseDownloadSlot undoes a ClaimDownloadSlot after a failed delivery
// (download_count-1, floored at 0). Slots are fungible, so it does not guard on
// the claim's timestamp: doing so would leave a slot leaked whenever several
// concurrent downloads of a multi-download file each set downloaded_at in turn.
func (s *SQLiteStore) ReleaseDownloadSlot(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE stored_files SET download_count = MAX(download_count - 1, 0) WHERE id = ?`, id)
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

const planCols = `id, name, storage_bytes, traffic_bytes, retention_secs, price_monthly, price_yearly, sort_order, active, updated_at, stripe_price_monthly_id, stripe_price_yearly_id`

func scanPlan(sc rowScanner) (Plan, error) {
	var p Plan
	var active int64
	err := sc.Scan(&p.ID, &p.Name, &p.StorageBytes, &p.TrafficBytes, &p.RetentionSecs,
		&p.PriceMonthly, &p.PriceYearly, &p.SortOrder, &active, &p.UpdatedAt,
		&p.StripePriceMonthlyID, &p.StripePriceYearlyID)
	p.Active = active != 0
	return p, err
}

func (s *SQLiteStore) ListPlans(ctx context.Context) ([]Plan, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+planCols+` FROM plans ORDER BY sort_order, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Plan
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) GetPlan(ctx context.Context, id string) (Plan, bool, error) {
	p, err := scanPlan(s.reader().QueryRowContext(ctx, `SELECT `+planCols+` FROM plans WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return Plan{}, false, nil
	}
	if err != nil {
		return Plan{}, false, err
	}
	return p, true, nil
}

func (s *SQLiteStore) UpsertPlan(ctx context.Context, p Plan) error {
	active := int64(0)
	if p.Active {
		active = 1
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO plans (`+planCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name=excluded.name, storage_bytes=excluded.storage_bytes,
		   traffic_bytes=excluded.traffic_bytes, retention_secs=excluded.retention_secs,
		   price_monthly=excluded.price_monthly, price_yearly=excluded.price_yearly,
		   sort_order=excluded.sort_order, active=excluded.active, updated_at=excluded.updated_at,
		   stripe_price_monthly_id=excluded.stripe_price_monthly_id,
		   stripe_price_yearly_id=excluded.stripe_price_yearly_id`,
		p.ID, p.Name, p.StorageBytes, p.TrafficBytes, p.RetentionSecs,
		p.PriceMonthly, p.PriceYearly, p.SortOrder, active, p.UpdatedAt,
		p.StripePriceMonthlyID, p.StripePriceYearlyID)
	return err
}

func (s *SQLiteStore) CountActivePlans(ctx context.Context) (int, error) {
	var n int
	err := s.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM plans WHERE active = 1`).Scan(&n)
	return n, err
}

// UserMonthlyUpDown returns a user's upload+download bytes for one period
// ("YYYYMM") from the usage_monthly rollup (0 when no row exists).
func (s *SQLiteStore) UserMonthlyUpDown(ctx context.Context, userID, period string) (int64, error) {
	var up, down sql.NullInt64
	err := s.reader().QueryRowContext(ctx,
		`SELECT upload_bytes, download_bytes FROM usage_monthly WHERE user_id = ? AND period = ?`,
		userID, period).Scan(&up, &down)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return up.Int64 + down.Int64, nil
}

// CurrentStorage sums a user's live staged-file bytes (expires_at > now).
func (s *SQLiteStore) CurrentStorage(ctx context.Context, userID string, now int64) (int64, error) {
	var total sql.NullInt64
	err := s.reader().QueryRowContext(ctx,
		`SELECT COALESCE(SUM(size),0) FROM stored_files WHERE user_id = ? AND expires_at > ?`,
		userID, now).Scan(&total)
	return total.Int64, err
}

// GlobalStorageUsed sums all live staged-file bytes (oversubscription backstop).
func (s *SQLiteStore) GlobalStorageUsed(ctx context.Context, now int64) (int64, error) {
	var total sql.NullInt64
	err := s.reader().QueryRowContext(ctx,
		`SELECT COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > ?`, now).Scan(&total)
	return total.Int64, err
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

// segmentBounds derives the current-month segment boundaries shared by the
// write path (accrueQuotaTx, which freezes the segment that just ended) and
// the read path (monthlyTrafficCap, which projects the segment still in
// progress). Both call this instead of separately re-deriving
// monthRange(period) and clamping planStartedAt into it — prorate's own doc
// comment warns that a divergence between the write and read sides silently
// miscomputes the user's monthly quota, and the segment-boundary derivation
// (not the arithmetic prorate does) is where that drift would actually creep
// in if the two call sites were left free to write it twice.
//
// The clamp (segStart < monthStart → monthStart) matters differently on each
// side that calls this:
//   - Write side: reachable in normal operation whenever a user's plan_id
//     hasn't changed yet this month, so plan_started_at still points into a
//     previous month.
//   - Read side (monthlyTrafficCap): only calls this after confirming
//     QuotaAccruedPeriod == period, which is only ever set by accrueQuotaTx —
//     and accrueQuotaTx sets plan_started_at = now in that same transaction,
//     so planStartedAt is provably >= monthStart already. The clamp is
//     unreachable there under current invariants; it stays as a defense
//     against clock rollback and manual DB edits, not dead code.
func segmentBounds(period string, planStartedAt int64) (segStart, monthStart, monthEnd int64) {
	monthStart, monthEnd = monthRange(period)
	segStart = planStartedAt
	if segStart < monthStart {
		segStart = monthStart // segment that began before this month only counts from month start
	}
	return segStart, monthStart, monthEnd
}

// prorate returns cap scaled to segSecs' share of monthSecs — the amount of a
// tier's monthly traffic allowance earned by holding that tier for segSecs.
//
// 先除后乘是为了避免溢出：5 TiB × 2.6e6 秒 ≈ 1.4e19，超过 int64 上限 9.2e18。
// 拆成商部分和余数部分两段相加，结果与直接乘除的整数除法一致。
//
// 写路径（accrueQuotaTx，冻结已过去的段）与读路径（monthlyTrafficCap，计算当前
// 段）必须用同一个算法：两处一旦漂移，冻结的累计值和算出的上限就对不上，用户的
// 当月配额会静默算错。
//
// 前置条件：调用方必须保证 segSecs <= monthSecs，即 segment 落在当月范围内
// （accrueQuotaTx 靠 monthRange(periodOf(now)) 把 now 夹在月首月末之间来满足
// 这一点）。一旦 segSecs 超出 monthSecs，算出的额度会超过整月上限，函数本身
// 不做这个校验。
func prorate(capBytes, segSecs, monthSecs int64) int64 {
	if capBytes <= 0 || segSecs <= 0 || monthSecs <= 0 {
		return 0
	}
	return capBytes/monthSecs*segSecs + (capBytes%monthSecs)*segSecs/monthSecs
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
  traffic_limit_bytes, disk_limit_bytes, label`

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
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET
		   owner_type=excluded.owner_type, owner_user_id=excluded.owner_user_id,
		   region=excluded.region, urls=excluded.urls, turn_secret=excluded.turn_secret,
		   version=excluded.version, last_seen_at=excluded.last_seen_at,
		   storage_url=excluded.storage_url, storage_secret=excluded.storage_secret,
		   storage_enabled=excluded.storage_enabled, storage_total=excluded.storage_total,
		   storage_free=excluded.storage_free`,
		// label is intentionally set only on INSERT (seeded from the token name) and
		// preserved on re-register, so a user's rename survives the node's heartbeats.
		n.ID, n.OwnerType, nullStr(n.OwnerUserID), n.Region, string(urls), n.TURNSecret,
		n.Version, n.RelayedBytes, n.StoredBytes, n.CreatedAt, n.LastSeenAt,
		nullStr(n.StorageURL), nullStr(n.StorageSecret), b2i(n.StorageEnabled), n.StorageTotal, n.StorageFree,
		n.TrafficLimitBytes, n.DiskLimitBytes, n.Label)
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
	// storage_free*5 >= storage_total keeps the volume at most 80% full: never
	// place a new blob on a node whose disk is already past that reserve, so a
	// node can't be filled to the point of wedging its host.
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes
		   WHERE owner_type='fleet' AND storage_enabled=1 AND last_seen_at >= ? AND storage_free >= ?
		     AND (disk_limit_bytes = 0 OR disk_limit_bytes - stored_bytes >= ?)
		     AND (storage_total = 0 OR storage_free * 5 >= storage_total)
		   ORDER BY last_seen_at DESC`, since, minFree, minFree)
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
	// Same 80%-full reserve as StorageNodes: even the user's own node is skipped
	// once its volume is past 80% used, so a full disk never bricks their host.
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? AND last_seen_at >= ? AND storage_enabled=1 AND storage_free >= ?
		   AND (storage_total = 0 OR storage_free * 5 >= storage_total) ORDER BY last_seen_at DESC`,
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
		`UPDATE nodes SET traffic_limit_bytes = ?, disk_limit_bytes = ? WHERE id = ? AND owner_type = 'fleet'`,
		trafficLimit, diskLimit, nodeID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) SetUserNodeLabel(ctx context.Context, id, ownerUserID, label string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET label = ? WHERE id = ? AND owner_type = 'user' AND owner_user_id = ?`,
		label, id, ownerUserID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) SetNodeLabel(ctx context.Context, id, label string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE nodes SET label = ? WHERE id = ?`, label, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// CentralStoredBytes sums live file sizes held on central-local storage — rows
// whose node_id is unset (NULL or ”), i.e. the app server's own disk fallback.
func (s *SQLiteStore) CentralStoredBytes(ctx context.Context) (int64, error) {
	var total sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(size), 0) FROM stored_files WHERE node_id IS NULL OR node_id = ''`).Scan(&total)
	if err != nil {
		return 0, err
	}
	return total.Int64, nil
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
			&n.TrafficLimitBytes, &n.DiskLimitBytes, &n.Label); err != nil {
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

// deviceAuthCols is shared by CreateDeviceAuth's INSERT and the two lookup
// SELECTs; pending_token is deliberately excluded from the public struct (it
// is a DB-internal handoff field) but still needs its own default on INSERT.
const deviceAuthCols = `user_code, device_code_hash, status, user_id, token_hash, created_at, expires_at, consumed_at, client_ip, user_agent`

func (s *SQLiteStore) CreateDeviceAuth(ctx context.Context, r DeviceAuthRequest) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO cli_device_auth (`+deviceAuthCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.UserCode, r.DeviceCodeHash, r.Status, r.UserID, r.TokenHash, r.CreatedAt, r.ExpiresAt, r.ConsumedAt, r.ClientIP, r.UserAgent)
	return err
}

func scanDeviceAuth(sc rowScanner) (DeviceAuthRequest, error) {
	var r DeviceAuthRequest
	err := sc.Scan(&r.UserCode, &r.DeviceCodeHash, &r.Status, &r.UserID, &r.TokenHash,
		&r.CreatedAt, &r.ExpiresAt, &r.ConsumedAt, &r.ClientIP, &r.UserAgent)
	return r, err
}

func (s *SQLiteStore) GetDeviceAuthByUserCode(ctx context.Context, userCode string) (DeviceAuthRequest, bool, error) {
	r, err := scanDeviceAuth(s.db.QueryRowContext(ctx,
		`SELECT `+deviceAuthCols+` FROM cli_device_auth WHERE user_code = ?`, userCode))
	if err == sql.ErrNoRows {
		return DeviceAuthRequest{}, false, nil
	}
	if err != nil {
		return DeviceAuthRequest{}, false, err
	}
	return r, true, nil
}

func (s *SQLiteStore) GetDeviceAuthByCodeHash(ctx context.Context, hash string) (DeviceAuthRequest, bool, error) {
	r, err := scanDeviceAuth(s.db.QueryRowContext(ctx,
		`SELECT `+deviceAuthCols+` FROM cli_device_auth WHERE device_code_hash = ?`, hash))
	if err == sql.ErrNoRows {
		return DeviceAuthRequest{}, false, nil
	}
	if err != nil {
		return DeviceAuthRequest{}, false, err
	}
	return r, true, nil
}

// ApproveDeviceAuth atomically transitions a request from pending to approved,
// conditioned on both the request still being pending AND unexpired — the
// WHERE clause means only the request whose user_code exactly matches a
// pending, live row is touched, so RowsAffected()==1 is the sole signal of
// success (stale/expired/already-approved/denied/unknown codes all report
// ok=false, nothing written). The raw one-time token is stashed in
// pending_token for ConsumeDeviceAuth to hand back on the CLI's next poll.
func (s *SQLiteStore) ApproveDeviceAuth(ctx context.Context, userCode, userID, tokenHash, rawToken string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE cli_device_auth SET status='approved', user_id=?, token_hash=?, pending_token=?
		  WHERE user_code=? AND status='pending' AND expires_at > ?`,
		userID, tokenHash, rawToken, userCode, at)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// ConsumeDeviceAuth marks an approved request consumed exactly once and returns
// the raw one-time token, blanking pending_token so it never lingers at rest.
// The SELECT and UPDATE run in one transaction so a second concurrent caller
// racing the same codeHash either sees the row still approved/unconsumed (and
// wins) or already consumed (sql.ErrNoRows, ok=false) — never a torn read of a
// pending_token that's about to be blanked out from under it.
func (s *SQLiteStore) ConsumeDeviceAuth(ctx context.Context, codeHash string, at int64) (string, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	var raw string
	err = tx.QueryRowContext(ctx,
		`SELECT pending_token FROM cli_device_auth
		  WHERE device_code_hash=? AND status='approved' AND consumed_at=0`, codeHash).Scan(&raw)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE cli_device_auth SET consumed_at=?, pending_token='' WHERE device_code_hash=?`,
		at, codeHash); err != nil {
		return "", false, err
	}
	if err := tx.Commit(); err != nil {
		return "", false, err
	}
	return raw, true, nil
}

// DeleteExpiredDeviceAuth reclaims device-auth rows past their expiry —
// pending or approved-but-never-consumed alike; a consumed row is already
// harmless (pending_token blanked) but gets swept too once past expiry.
func (s *SQLiteStore) DeleteExpiredDeviceAuth(ctx context.Context, now int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM cli_device_auth WHERE expires_at < ?`, now)
	return err
}

func (s *SQLiteStore) CreateCLIToken(ctx context.Context, t CLIToken) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO cli_tokens (token_hash, user_id, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
		t.TokenHash, t.UserID, t.DeviceID, t.CreatedAt, t.LastSeenAt)
	return err
}

func (s *SQLiteStore) GetCLITokenUser(ctx context.Context, tokenHash string) (string, string, bool, error) {
	var userID, deviceID string
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id, device_id FROM cli_tokens WHERE token_hash = ?`, tokenHash).
		Scan(&userID, &deviceID)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return userID, deviceID, true, nil
}

func (s *SQLiteStore) TouchCLIToken(ctx context.Context, tokenHash string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE cli_tokens SET last_seen_at = ? WHERE token_hash = ?`, at, tokenHash)
	return err
}
