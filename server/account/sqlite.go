package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/devicelabel"
	"github.com/relayium/relayium/internal/inbox"
)

// SQLiteStore keeps a single writer connection (db) — write-path atomicity
// relies on MaxOpenConns(1) serializing writers — plus, for a file-backed DB, a
// separate read-only pool (rdb) so a slow admin query doesn't block the writer.
// rdb is nil for :memory: (a second connection would see a separate empty DB).
type SQLiteStore struct {
	db  *sql.DB
	rdb *sql.DB
}

// Ping verifies the live writer connection used by account mutations. It is
// intentionally small and side-effect free so /readyz can call it frequently.
func (s *SQLiteStore) Ping(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errors.New("sqlite: store is not open")
	}
	return s.db.PingContext(ctx)
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
CREATE TABLE IF NOT EXISTS apple_renewal_states (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  current_product_id TEXT NOT NULL,
  auto_renew_product_id TEXT NOT NULL,
  auto_renew_enabled INTEGER NOT NULL DEFAULT 0,
  in_billing_retry INTEGER NOT NULL DEFAULT 0,
  grace_until INTEGER NOT NULL DEFAULT 0,
  renewal_at INTEGER NOT NULL DEFAULT 0,
  event_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
  ,expiration_intent INTEGER NOT NULL DEFAULT 0
  ,price_increase_status INTEGER NOT NULL DEFAULT -1
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
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  last_ip      TEXT NOT NULL DEFAULT '',
  -- Client-generated installation lookup hint (43-char RawURLEncoding of 32
  -- random bytes). '' for every browser row, every CLI and every pre-1.1.3 app.
  -- Never a credential and never returned by an API: see Device.InstallID and
  -- the partial unique index created by migrateInstallID.
  install_id   TEXT NOT NULL DEFAULT ''
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
-- unbilled_meter is the OUTBOX for bytes that are owed and could not be metered
-- at the moment they became known.
--
-- Every ordinary bill is written in the same transaction as the state change it
-- belongs to (an append's offset, a finalize's claim, a room's close), so it
-- cannot be half-done. Two callers cannot do that, because what they are billing
-- is not in the database at all: it is the size of a blob they are about to
-- delete, learned from the node a moment earlier. If RecordMeter fails there,
-- logging it destroys the last copy of the number.
--
-- So the number is written HERE first-class instead, and GC settles it — the
-- increment and this row's removal in one transaction, so a crash in between
-- re-settles rather than loses or double-counts. The reason column exists to be
-- read in an incident: a row here is always evidence that something else failed.
CREATE TABLE IF NOT EXISTS unbilled_meter (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind    INTEGER NOT NULL,
  bytes   INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  reason  TEXT NOT NULL DEFAULT ''
);
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
-- idx_nodes_owner_type(owner_type) is dropped by the ALTER loop below on
-- existing databases; not created here any more on a fresh one either — see
-- the DROP INDEX next to idx_nodes_byo_rank for why it's dead weight.
CREATE TABLE IF NOT EXISTS pending_node_deletes (
  blob_key    TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  -- not_before: the instant this row may be RETIRED once a delete succeeds.
  -- 0 = the first success ends it. See PendingNodeDelete.NotBefore.
  not_before  INTEGER NOT NULL DEFAULT 0,
  -- deleted_at: when a delete for this key FIRST succeeded, 0 if none ever has.
  -- It is what separates "this row is a hold on a discharged responsibility"
  -- from "this row is the only thing that will ever clean this blob up", and
  -- age eviction is allowed to touch the first and never the second. See
  -- PendingNodeDelete.DeletedAt.
  deleted_at  INTEGER NOT NULL DEFAULT 0,
  -- Billing obligation carried by the blob itself (pair-room upload blobs).
  -- bill_user_id '' = no obligation, the row is deletion-only. Otherwise any
  -- bytes the blob holds past billed_through (clamped to bill_max) must be
  -- durably billed to bill_user_id BEFORE the bytes are destroyed. Written in
  -- the same transaction that removes the session row, which is what makes the
  -- obligation survive a database that refuses every later write. See
  -- PendingNodeDelete.BillUserID and Store.SettleBlobBilling.
  bill_user_id   TEXT NOT NULL DEFAULT '',
  bill_kind      INTEGER NOT NULL DEFAULT 0,
  bill_max       INTEGER NOT NULL DEFAULT 0,
  billed_through INTEGER NOT NULL DEFAULT 0,
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
  user_agent       TEXT NOT NULL DEFAULT '',
  device_name      TEXT NOT NULL DEFAULT '', -- account-visible label the CLI asked to register; '' = a pre-label CLI
  install_id       TEXT NOT NULL DEFAULT ''  -- validated installation lookup hint; '' = a client that sends none
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
  updated_at     INTEGER NOT NULL,
  -- 0 = fall back to the global daily_quota setting (see dailyQuotaFor).
  daily_quota_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_credentials (
  id           TEXT PRIMARY KEY,
  user_handle  BLOB NOT NULL,
  cred_json    BLOB NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  ip         TEXT NOT NULL,
  auth       TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  changes    TEXT NOT NULL,
  step_up    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC);
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
	// _txlock=immediate makes every read-write transaction on this (write) pool
	// begin with BEGIN IMMEDIATE, taking the write lock up front. A DEFERRED
	// transaction that SELECTs then upgrades to a write can hit
	// SQLITE_BUSY_SNAPSHOT when another PROCESS committed after the read snapshot
	// — a conflict SQLite cannot resolve by waiting, so busy_timeout does NOT
	// apply and the whole tx fails immediately. Multi-instance deployments (N
	// processes sharing one WAL file) rely on this; a single process is
	// unaffected. modernc applies the mode only to non-readonly BeginTx, so the
	// reader pool below (plain reads) keeps DEFERRED locking.
	db, err := sql.Open("sqlite", withPragmas(dsn, connPragmas...)+"&_txlock=immediate")
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
		// Node's public direct-download base URL (e.g. https://node3.relayium.com).
		// When set, central 302s clients straight to the node so download bytes
		// bypass central. '' = proxy as before. See Node.DownloadURL.
		`ALTER TABLE nodes ADD COLUMN download_url TEXT NOT NULL DEFAULT ''`,
		// Central↔node blob TLS pinning: the node's self-signed cert fingerprint
		// (hex SHA-256), reported at registration. '' = legacy http node.
		`ALTER TABLE nodes ADD COLUMN storage_fp TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE nodes ADD COLUMN storage_enabled INTEGER NOT NULL DEFAULT 0`,
		// Central→node blob reachability, which the heartbeat cannot attest: the
		// heartbeat proves node→central works, and blob writes go the other way.
		// Written ONLY by a probe (never by register/heartbeat) so a node cannot
		// clear its own mark. Default 0 = eligible, so the gate fails open: a
		// prober that never runs must not empty the placement pool.
		`ALTER TABLE nodes ADD COLUMN storage_unreachable INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE nodes ADD COLUMN storage_probed_at INTEGER NOT NULL DEFAULT 0`,
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
		// Last server-observed address for account-owner device identification.
		// Empty preserves existing devices; only authenticated CLI/app requests
		// populate it, and callers canonicalize it to an IP without a port.
		`ALTER TABLE devices ADD COLUMN last_ip TEXT NOT NULL DEFAULT ''`,
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
		`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN subscription_end INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN plan_source TEXT NOT NULL DEFAULT ''`,
		// Webhook ordering guard (2026-07): the Stripe `event.created` (unix secs) of
		// the last subscription event we applied. Stripe does not guarantee delivery
		// order and retries any event we 500 on for up to 3 days, so a stale
		// (re)delivered event could otherwise revert a newer state (e.g. restore a
		// past_due/free user to paid). The webhook drops any event older than this.
		// DEFAULT 0 backfills every existing row to "no event applied yet" with no
		// separate UPDATE — so there is no ALTER-vs-backfill crash window here.
		`ALTER TABLE users ADD COLUMN sub_event_at INTEGER NOT NULL DEFAULT 0`,
		// In-app downgrade UX: the tier a pending period-end downgrade will switch
		// to (via a Stripe subscription schedule); '' = no pending change. It's a
		// display hint — set when the endpoint schedules a downgrade, cleared when
		// the downgrade lands (webhook), is canceled, or the subscription ends.
		`ALTER TABLE users ADD COLUMN scheduled_plan_id TEXT NOT NULL DEFAULT ''`,
		// The billing cycle a pending downgrade will switch to ('monthly'|'yearly'),
		// stored ALONGSIDE scheduled_plan_id. Without it, a SAME-TIER cycle downgrade
		// (e.g. yearly→monthly on the same plan) has scheduled_plan_id == the current
		// tier, so the webhook's "landed" check (planID == scheduled_plan_id) matched
		// the intermediate schedule-creation event and cleared the marker seconds
		// after it was set — wedging every later in-app plan change at 500 until
		// period end. The clear now also requires the cycle to match. '' = a legacy
		// pending downgrade from before this column; the clear falls back to
		// tier-only matching there (see billing.go).
		`ALTER TABLE users ADD COLUMN scheduled_cycle TEXT NOT NULL DEFAULT ''`,
		// 计费周期（'monthly' | 'yearly'），和档位正交的第二个维度。webhook 拿
		// 事件里的 price id 跟该档的月/年两个 price id 比对推出来 —— Stripe 的
		// 订阅事件不单独给 interval 字段，这是唯一来源。
		//
		// '' = 未知：迁移之前就存在的订阅行没人记录过周期。换档端点必须把 ''
		// 当作"只按档位判断"，不能当成一次周期变更（否则老用户点一下当前档就
		// 会触发一次无谓的 Stripe 订阅修改）。
		`ALTER TABLE users ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT ''`,
		// 配额防套利（2026-07）：月中改档不再白送整月流量额度，而是把当月按档位
		// 分段、每段按占比计算。见 accrueQuotaTx 与 Service.monthlyTrafficCap。
		`ALTER TABLE users ADD COLUMN plan_started_at INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN quota_accrued_bytes INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN quota_accrued_period TEXT NOT NULL DEFAULT ''`,
		// Per-plan daily upload quota (2026-07): the 24h cap used to be a single
		// global setting, so no paid tier could upload a file larger than it.
		// 0 = fall back to the global daily_quota setting, which is what every
		// pre-existing row gets — the migration is behaviour-neutral until the
		// tiers are seeded or edited. See Service.dailyQuotaFor.
		`ALTER TABLE plans ADD COLUMN daily_quota_bytes INTEGER NOT NULL DEFAULT 0`,
		// 管理员操作审计（2026-07）。新库由 schema 常量建出，老库靠这条补。
		// CREATE TABLE IF NOT EXISTS 是幂等的，两条路径不会打架。
		`CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
  ip TEXT NOT NULL, auth TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  changes TEXT NOT NULL, step_up TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC)`,
		// Direct-download receipt dedup (decentralized downloads P1): each 302's
		// token nonce is recorded once when its node receipt lands, so a re-sent
		// receipt can't double-refund the owner's pre-metered traffic. Rows are
		// disposable (a GC sweep can prune old ones); the nonce is the idempotency key.
		`CREATE TABLE IF NOT EXISTS download_receipts (
  nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_download_receipts_at ON download_receipts(at)`,
		// Admin TOTP replay guard (multi-instance): a single-row monotonic step
		// counter, advanced atomically by ClaimTOTPStep. Persisting it makes admin
		// 2FA "one code, one use" hold across instances and across restarts, instead
		// of a per-process in-memory counter. See the multi-instance-state-migration doc in relayium-ops.
		`CREATE TABLE IF NOT EXISTS admin_totp_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1), last_step INTEGER NOT NULL DEFAULT 0)`,
		`INSERT OR IGNORE INTO admin_totp_guard (id, last_step) VALUES (1, 0)`,
		// Admin sessions (multi-instance): shared so any instance recognizes a
		// login and the step-up grace window, instead of a per-process map.
		// See the multi-instance-state-migration doc in relayium-ops, item #4.
		`CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY, auth TEXT NOT NULL,
  expires INTEGER NOT NULL, last_step_up_at INTEGER NOT NULL DEFAULT 0)`,
		// Pending high-risk actions (multi-instance): the confirm-page token must be
		// claimable exactly once on any instance. See migration item #2.
		`CREATE TABLE IF NOT EXISTS admin_pending_actions (
  token TEXT PRIMARY KEY, session_tok TEXT NOT NULL, action TEXT NOT NULL,
  form TEXT NOT NULL, path_id TEXT NOT NULL DEFAULT '', expires INTEGER NOT NULL)`,
		// In-flight WebAuthn ceremonies (multi-instance): the challenge cookie must
		// be spendable exactly once on any instance. See migration item #3.
		`CREATE TABLE IF NOT EXISTS admin_passkey_ceremonies (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL, session TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', expires INTEGER NOT NULL)`,
		// Resumable chunked-upload sessions (multi-instance): the durable state
		// (committed offset, blob key/node, retention, caps) so any instance can
		// serve the next chunk / finalize, and an instance restart no longer
		// abandons an in-flight upload. The blob handle is reconstructed from
		// node_id per request; the DB replaces the per-session mutex. Item #9.
		`CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, blob_key TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '', billable INTEGER NOT NULL DEFAULT 0,
  enc_manifest BLOB, ttl INTEGER NOT NULL DEFAULT 0, max_dl INTEGER NOT NULL DEFAULT 0,
  max_size INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_upload_sessions_created ON upload_sessions(created_at)`,
		// Automatic node update rollout (Part 2): per-node bookkeeping of central's
		// last commanded self-update, so the rollout state machine can notice a node
		// that never came back (timeout) and see what it last reported. Set only by
		// the state machine, never by register/heartbeat — UpsertNode's ON CONFLICT
		// clause deliberately omits these three so a routine re-register can't
		// clobber them. 0/''/'' on every existing and new row = "no update in flight".
		`ALTER TABLE nodes ADD COLUMN update_started_at INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE nodes ADD COLUMN update_from_version TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE nodes ADD COLUMN update_result TEXT NOT NULL DEFAULT ''`,
		// update_attempts bounds the fleet RESUME path. A node that holds the
		// rollout claim, keeps heartbeating and never reports a result is told
		// "carry on" on every 30s poll, which without a bound is a permanent
		// re-download/reinstall loop that the silence check can never catch
		// (the node is not silent). Counted from 0 on every fresh command and
		// incremented once per resume; past fleetResumeAttemptLimit the track
		// halts instead. 0 on every existing row = "no resumes yet".
		`ALTER TABLE nodes ADD COLUMN update_attempts INTEGER NOT NULL DEFAULT 0`,
		// draining is the first half of a safe node uninstall: an operator sets it
		// to stop new uploads being placed on the node (StorageNodes and
		// UserStorageNodes exclude it) while it keeps serving downloads for the
		// files it already holds, letting them age out before the machine is
		// removed. Set only via SetNodeDraining, never by register/heartbeat —
		// UpsertNode's ON CONFLICT clause deliberately omits it, same as label and
		// the update_* columns above, so a routine re-register can't clear it.
		// 0 on every existing row = not draining, the only safe default.
		`ALTER TABLE nodes ADD COLUMN draining INTEGER NOT NULL DEFAULT 0`,
		// removed_at is the second half: the uninstaller POSTs /api/nodes/deregister
		// on its way out and central stamps the node here. The row is kept (the
		// admin panel and the audit trail still have to explain where a node went)
		// but it is filtered out of StorageNodes/UserStorageNodes/OnlineNodes/
		// UserNodes and never receives a download 302 — the machine is gone, so
		// every one of those would only hand somebody a dead origin. Also omitted
		// from UpsertNode's ON CONFLICT clause, like draining above.
		// 0 on every existing row = still installed.
		`ALTER TABLE nodes ADD COLUMN removed_at INTEGER NOT NULL DEFAULT 0`,
		// active_transfers is the node's live load signal: how many relay
		// allocations it is currently serving, as of its last heartbeat. It exists
		// for exactly one consumer — decideFleet's canary pick, which sends the
		// new build to the machine with the fewest in-flight transfers first,
		// because that is the one with the least to lose if the build is bad.
		//
		// Written ONLY by TouchNode (the heartbeat), unlike every other column
		// added above: this is a live gauge, so it is SET, never kept-max, and it
		// is deliberately NOT in UpsertNode's ON CONFLICT list — a re-register
		// carries no load reading and must not stamp one.
		//
		// -1 on every existing row (and for any node whose binary predates the
		// heartbeat field, or has yet to send its first one) is the honest
		// reading of "we have no load signal for this machine" — deliberately
		// NOT 0, which is a real report (this node genuinely has nothing in
		// flight) and must not be confused with "did not say". canaryRank is
		// where the two are told apart: an unreported node ranks AFTER every
		// real count, not tied with a known-idle one. See Node.ActiveTransfers.
		// NOTE: an earlier commit on this same branch shipped this ALTER with
		// DEFAULT 0 before it was corrected to -1 here. Any database that ran
		// migrations while that commit was live already has 0 stamped onto every
		// row that existed at that moment — see migrateActiveTransfersUnknown
		// below, which cleans that up regardless of which commit an environment
		// happened to migrate through first.
		`ALTER TABLE nodes ADD COLUMN active_transfers INTEGER NOT NULL DEFAULT -1`,
		// node_rollout holds the rollout state machine's per-track bookkeeping: one
		// row for "fleet", one for "byo", each with its own target version and
		// status, so a stalled/halted byo rollout can never block or bleed into the
		// fleet track. See RolloutTrack's doc comment in store.go for why this is
		// deliberately two rows and must stay that way.
		`CREATE TABLE IF NOT EXISTS node_rollout (
  track TEXT PRIMARY KEY, target_version TEXT NOT NULL DEFAULT '',
  current_node_id TEXT NOT NULL DEFAULT '', byo_batch INTEGER NOT NULL DEFAULT 0,
  stage_started_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '',
  halted_reason TEXT NOT NULL DEFAULT '')`,
		// first_node_id records WHICH node was the canary of the current rollout,
		// positionally. The state machine used to infer canary status from "no
		// other node is on target", which silently downgraded the 6h canary
		// window to 30min whenever a peer was already on the new build (a freshly
		// provisioned node, a hand-updated node, a resumed rollout). Added by
		// ALTER rather than folded into the CREATE above so live databases that
		// already have node_rollout migrate instead of keeping the old shape.
		`ALTER TABLE node_rollout ADD COLUMN first_node_id TEXT NOT NULL DEFAULT ''`,
		// Backfill: a rollout already IN FLIGHT when this column ships would read
		// first_node_id='' for a node that really is the canary, and its 6h
		// observation window would collapse to 30min exactly once, on the first
		// deploy carrying the field. Point it at the node in flight. Idempotent —
		// it only touches rolling rows that still have no canary recorded — so it
		// is safe on every startup. decideFleet also assumes "in flight with no
		// recorded canary == canary" for any row this misses.
		`UPDATE node_rollout SET first_node_id = current_node_id
		   WHERE status = 'rolling' AND first_node_id = '' AND current_node_id <> ''`,
		// emergency = the admin pulled the "release the whole track at once"
		// lever: the staged ladder (fleet canary/queue, byo 10/50/100 batches)
		// is bypassed for as long as it is 1. Added by ALTER, like
		// first_node_id above, so live databases migrate. 0 on every existing
		// row = the staged behaviour that shipped before this column, which is
		// the only safe default.
		`ALTER TABLE node_rollout ADD COLUMN emergency INTEGER NOT NULL DEFAULT 0`,
		// previous_version records the target this track held immediately
		// before the current one, so the byo track can be rolled back to it
		// without re-consulting the byo-behind-fleet gate (that version already
		// passed the gate when it was set — see RolloutTrack.PreviousVersion
		// and Service.RollbackByoToPreviousVersion). Added by ALTER, like the
		// two columns above, so live databases migrate. '' on every existing
		// row = "no history recorded", which the rollback action refuses
		// rather than guessing.
		`ALTER TABLE node_rollout ADD COLUMN previous_version TEXT NOT NULL DEFAULT ''`,
		// manual_fast = the operator asked for the fleet ladder to run at speed:
		// the canary's observation window and the soak between nodes are skipped,
		// and NOTHING else is (one node at a time, each node's own install,
		// restart, health watch and rollback, and the halt on any bad or missing
		// result all stay — see RolloutTrack.ManualFast). Added by ALTER, like the
		// three columns above, so live databases migrate. 0 on every existing row
		// = the staged behaviour that shipped before this column, which is the
		// only safe default: a rollout already in flight when this deploys must
		// not silently stop observing its canary.
		`ALTER TABLE node_rollout ADD COLUMN manual_fast INTEGER NOT NULL DEFAULT 0`,
		// fast_after_canary = the SAFE form of the same request: the canary keeps
		// its ENTIRE six-hour observation window and must also report success while
		// running the target, and only the nodes AFTER it skip the 30-minute soak
		// (see RolloutTrack.FastAfterCanary). Added by ALTER, like the four columns
		// above, so live databases migrate. 0 on every existing row = the behaviour
		// that shipped before this column, which is the only safe default: a
		// rollout already in flight when this deploys keeps whatever mode it was
		// started in, and no track silently acquires a new one.
		//
		// Deliberately a SECOND column rather than a widening of manual_fast into
		// an integer mode: the two modes' rows must be distinguishable by a live
		// deployment mid-rollout (an old binary reading a widened manual_fast=2 as
		// truthy would run the canary with no window at all, which is the exact
		// failure this mode exists to prevent), and a boolean per mode makes the
		// mutual exclusion something every writer states explicitly.
		`ALTER TABLE node_rollout ADD COLUMN fast_after_canary INTEGER NOT NULL DEFAULT 0`,
		// One row, enforced by the CHECK, holding what the last successful
		// release check saw and which tag the operator dismissed. The two
		// halves are written by separate statements so neither can clobber the
		// other: a failed check must leave the result alone, and a dismissal
		// must not look like a check.
		`CREATE TABLE IF NOT EXISTS release_check (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  latest_tag TEXT NOT NULL DEFAULT '', checked_at INTEGER NOT NULL DEFAULT 0,
  dismissed_tag TEXT NOT NULL DEFAULT '', dismissed_at INTEGER NOT NULL DEFAULT 0)`,
		// Device Inbox Phase 1A. One enrolment row per receiving device, holding
		// the NEGOTIATED protocol version (never what the client merely asked
		// for), the capability set it announced, its automatic-receive policy and
		// its heartbeat-derived presence.
		//
		// presence_expires_at is the ONLY presence state. There is deliberately no
		// `online` column: a stored boolean outlives the process that set it, so a
		// device killed with SIGKILL — or central restarting — would leave senders
		// looking at a device that is advertised as available and is not. Presence
		// is computed at read time from this timestamp (see inbox.Presence), which
		// makes "went offline" the default rather than something a sweeper has to
		// remember to do.
		//
		// auto_accept DEFAULT 'off' is the PRD §8 product invariant expressed in
		// the schema: no row can come into existence already permitted to write to
		// a user's disk.
		//
		// ON DELETE CASCADE ties the enrolment to the device row, so DELETE
		// /api/devices/{id} — the existing "revoke this credential" control —
		// also removes the inbox enrolment and (below) the key history, with no
		// second code path to keep in sync. The foreign_keys pragma is on (see
		// connPragmas), so this is enforced, not decorative.
		`CREATE TABLE IF NOT EXISTS device_inbox (
  device_id           TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  platform            TEXT NOT NULL DEFAULT '',
  app_version         TEXT NOT NULL DEFAULT '',
  protocol_version    INTEGER NOT NULL DEFAULT 0,
  capabilities        TEXT NOT NULL DEFAULT '',
  receive_capability  TEXT NOT NULL DEFAULT '',
  auto_accept         TEXT NOT NULL DEFAULT 'off',
  receive_dir_ready   INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at   INTEGER NOT NULL DEFAULT 0,
  presence_expires_at INTEGER NOT NULL DEFAULT 0,
  registered_at       INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  revoked_at          INTEGER NOT NULL DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS idx_device_inbox_user ON device_inbox(user_id)`,
		// A device's end-to-end PUBLIC key history. Only public keys are ever
		// stored — there is no column here, and no request field anywhere, that
		// could carry a private key or a content key.
		//
		// History is kept rather than overwritten because a task queued before a
		// rotation was sealed to the OLDER key. superseded_at ("rotated away
		// from", the device still holds the private key and can drain those
		// tasks) is therefore a different state from revoked_at ("never usable
		// again"), and collapsing them would either strand queued tasks or keep
		// trusting a withdrawn key.
		//
		// The UNIQUE (device_id, generation) index is the rotation's ordering
		// guarantee: two concurrent rotations cannot both write generation N, so
		// one of them fails instead of forking the history.
		`CREATE TABLE IF NOT EXISTS device_keys (
  id            TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  algorithm     TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  superseded_at INTEGER NOT NULL DEFAULT 0,
  revoked_at    INTEGER NOT NULL DEFAULT 0)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_keys_generation ON device_keys(device_id, generation)`,
		// Generation uniqueness orders the history; this partial unique index is
		// the stronger invariant that makes two current rows impossible even if a
		// future write path bypasses RotateDeviceKey's CAS.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_keys_active ON device_keys(device_id) WHERE superseded_at = 0`,
		// Serves both hot reads: the per-device history listing and the "which
		// key do I seal to" lookup, which filters on superseded_at.
		`CREATE INDEX IF NOT EXISTS idx_device_keys_device ON device_keys(device_id, superseded_at, generation DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys(user_id, superseded_at)`,
		// Device Inbox Phase 1B: the encrypted asynchronous task queue. One row
		// per delivery to one device.
		//
		// WHAT IS HERE: account and device ids, the ciphertext byte count,
		// timestamps, the state machine, an opaque error token, idempotency and
		// lease metadata, and exactly two opaque blobs — enc_manifest and
		// wrapped_key. WHAT IS NOT, and has no column: plaintext, file or
		// directory names, the target's real path, the content key, a device
		// private key. wrapped_key is the content key sealed to the device's
		// PUBLIC key; central holds no private half and cannot open it.
		//
		// stored_file_id REFERENCES an existing same-account Stored Object rather
		// than duplicating the ciphertext, which is what lets this queue inherit
		// the storage quota, the expiry and the download path that already exist
		// instead of standing up a second object lifecycle. Deliberately NOT a
		// foreign key: the object may legitimately be deleted or expire first.
		// Phase 1B accepts only unlimited-until-TTL objects, and deletion updates
		// unfinished tasks transactionally before removing the object row. This
		// keeps the user's delete control while preserving truthful task history.
		//
		// ON DELETE CASCADE from devices(id) means the existing
		// DELETE /api/devices/{id} control removes the queue with the enrolment,
		// the key history and the bearer, through one path. It cannot orphan a
		// blob: the task never owns one.
		//
		// The three CHECKs are the invariants the application must not be the
		// only guardian of:
		//   - state is the closed PRD §10 server-state set. inbox.TaskStates() is
		//     asserted against this list by a test, so the two cannot drift.
		//   - saved_at is zero unless the row IS saved. No code path can leave a
		//     "saved at" timestamp on a task that was never saved, which is the
		//     one field a UI would use to claim a file landed.
		//   - a lease deadline requires a claimant, so a phantom lease (a deadline
		//     with nobody holding it) cannot exist. The converse is deliberately
		//     allowed: a claimant hash OUTLIVES its lease on a terminal row, as
		//     the record of who finished the task, which is what lets a device
		//     retry its own `saved` report and get the original timestamp back
		//     instead of a stale-claimant rejection.
		`CREATE TABLE IF NOT EXISTS inbox_tasks (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  target_device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  source_device_id      TEXT NOT NULL DEFAULT '',
  idempotency_key       TEXT NOT NULL,
  stored_file_id        TEXT NOT NULL,
  enc_manifest          BLOB NOT NULL,
  wrap_algorithm        TEXT NOT NULL,
  wrapped_key           TEXT NOT NULL,
  target_key_id         TEXT NOT NULL,
  target_key_generation INTEGER NOT NULL,
  ciphertext_bytes      INTEGER NOT NULL,
  state                 TEXT NOT NULL,
  claim_token_hash      TEXT NOT NULL DEFAULT '',
  lease_expires_at      INTEGER NOT NULL DEFAULT 0,
  attempts              INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       INTEGER NOT NULL DEFAULT 0,
  error_code            TEXT NOT NULL DEFAULT '',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  notified_at           INTEGER NOT NULL DEFAULT 0,
  saved_at              INTEGER NOT NULL DEFAULT 0,
  terminal_at           INTEGER NOT NULL DEFAULT 0,
  CHECK (state IN ('queued','notified','downloading','verifying','saved',
                   'attention_required','expired','revoked',
                   'failed_retryable','failed_terminal')),
  CHECK (saved_at = 0 OR state = 'saved'),
  CHECK (lease_expires_at = 0 OR claim_token_hash <> ''),
  CHECK (idempotency_key <> ''),
  CHECK (ciphertext_bytes >= 0))`,
		// The sender's idempotency key, unique per ACCOUNT. Account-scoped rather
		// than device-scoped so one retried "send this file" cannot become two
		// tasks by being retried against a different target; and enforced by the
		// database, so the converge-on-retry behaviour survives a concurrent
		// duplicate create that the application-level read would miss.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_tasks_idem ON inbox_tasks(user_id, idempotency_key)`,
		// The claim hot path: "which of this device's tasks are claimable now".
		`CREATE INDEX IF NOT EXISTS idx_inbox_tasks_claim ON inbox_tasks(target_device_id, state, next_attempt_at)`,
		`CREATE INDEX IF NOT EXISTS idx_inbox_tasks_user ON inbox_tasks(user_id, created_at DESC)`,
		// The two sweep passes: TTL expiry and lease reclaim. The lease index is
		// partial because the overwhelming majority of rows are unleased.
		`CREATE INDEX IF NOT EXISTS idx_inbox_tasks_expires ON inbox_tasks(expires_at)`,
		`CREATE INDEX IF NOT EXISTS idx_inbox_tasks_lease ON inbox_tasks(lease_expires_at) WHERE lease_expires_at > 0`,
		// Key revocation terminates exactly the tasks sealed to the revoked key.
		`CREATE INDEX IF NOT EXISTS idx_inbox_tasks_key ON inbox_tasks(target_device_id, target_key_id)`,
		// Phase 1D-A: what a Stored Object IS, persisted rather than inferred.
		// 'share' is the capability-link object every existing row is; the
		// DEFAULT is what makes this migration safe on a live database, and
		// backfillStoredFilePurpose repairs a crash between the ALTER and the
		// first write. See taskobject.go.
		`ALTER TABLE stored_files ADD COLUMN purpose TEXT NOT NULL DEFAULT 'share'`,
		// The one task a task-purpose object is delivering for. '' = not yet
		// bound. A share is never bound: it may back several tasks, and it
		// belongs to its link, not to a delivery.
		`ALTER TABLE stored_files ADD COLUMN inbox_task_id TEXT NOT NULL DEFAULT ''`,
		// "At most one task per object", enforced by the DATABASE. The
		// application's conditional UPDATE already refuses a second binding;
		// this makes the property survive a future write path that forgets to,
		// and it is partial so the overwhelming majority of rows (unbound
		// shares, all sharing '') do not collide.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_stored_files_binding
		   ON stored_files(inbox_task_id) WHERE inbox_task_id <> ''`,
		// GC's reclaim pass asks "which task objects have no reader left". Only
		// task-purpose rows are candidates, so the index is partial for the same
		// reason: it must not carry every share in the table.
		`CREATE INDEX IF NOT EXISTS idx_stored_files_taskobj
		   ON stored_files(created_at) WHERE purpose = 'device_task'`,
		// A chunked upload declares its purpose at init and must still have it
		// at finalize, which may run on a different instance.
		`ALTER TABLE upload_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'share'`,
		// The account-visible label a `relayium login` asks to register, carried
		// from the start request through approval so the browser approves the
		// same identity that is ultimately persisted. '' is what a pre-label CLI
		// sends and what every existing row gets; approval substitutes the
		// historical "CLI" name there, so no backfill is needed and a mixed-
		// version fleet keeps working. See deviceauth.go.
		`ALTER TABLE cli_device_auth ADD COLUMN device_name TEXT NOT NULL DEFAULT ''`,
		// Code-first pairing, Phase 2: one row per pairing code that someone
		// pre-uploaded into. Its whole content is a deadline and an owner —
		// there is deliberately no column that could hold a key, a filename or a
		// receiver identity, because the server is never told any of them.
		//
		// expires_at is MATERIALIZED rather than derived in SQL: the rule that
		// produces it (pairroom.go, pairRoomExpiry) is the product decision this
		// feature is about, and a second copy of it in a WHERE clause is a second
		// place for it to be wrong. Go computes it and writes it here and onto the
		// room's objects in the same transaction.
		`CREATE TABLE IF NOT EXISTS pair_rooms (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_upload_at INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL DEFAULT 0, closed_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL)`,
		// Resolution is always "the newest OPEN room with these digits" (codes are
		// recycled), and GC's backstop pass asks "which open rooms are past their
		// deadline". Both are covered by this one partial index, which carries only
		// open rooms — closed ones are dead weight for every query there is.
		`CREATE INDEX IF NOT EXISTS idx_pair_rooms_open
		   ON pair_rooms(code, created_at DESC) WHERE closed_at = 0`,
		// ONE open, unjoined room per code, enforced by the database rather than by
		// the care of every future caller. Two such rooms is a stranded file: a join
		// resolves one of them, and whatever was uploaded into the other expires
		// unreachable while its sender is told it was handed over.
		//
		// Unjoined, not merely open, because a joined room now has no deadline at
		// all and so stays open indefinitely — it must not hold these six digits
		// hostage against whoever is issued them next. Nothing can resolve a joined
		// room through its code again, so it is not a collision, only a row.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_pair_rooms_one_open
		   ON pair_rooms(code) WHERE closed_at = 0 AND joined_at = 0`,
		`CREATE INDEX IF NOT EXISTS idx_pair_rooms_deadline
		   ON pair_rooms(expires_at) WHERE closed_at = 0`,
		// The purge pass, and account deletion, both walk closed rows.
		`CREATE INDEX IF NOT EXISTS idx_pair_rooms_closed ON pair_rooms(closed_at)`,
		// The room a pre-uploaded object belongs to. '' for every other purpose,
		// which is every row that predates this column.
		`ALTER TABLE stored_files ADD COLUMN pair_room_id TEXT NOT NULL DEFAULT ''`,
		// "Give me everything in this room" runs on every deadline move and on
		// every void, so it must not be a table scan. Partial for the same reason
		// the task-object index is: shares must not be carried in it.
		`CREATE INDEX IF NOT EXISTS idx_stored_files_pairroom
		   ON stored_files(pair_room_id) WHERE pair_room_id <> ''`,
		// A chunked upload's room binding and its already-billed byte count. Both
		// must survive the instance that started the upload: finalize may run
		// elsewhere and must neither re-derive the ownership decision nor bill the
		// same bytes a second time.
		`ALTER TABLE upload_sessions ADD COLUMN pair_room_id TEXT NOT NULL DEFAULT ''`,
		// ...and the same "everything in this room" query over the uploads that have
		// not finished, which a void runs to reclaim their partial blobs. Partial for
		// the same reason: an ordinary share's session must not be carried in it.
		`CREATE INDEX IF NOT EXISTS idx_upload_sessions_pairroom
		   ON upload_sessions(pair_room_id) WHERE pair_room_id <> ''`,
		// The recovery state: when this session was found abandoned with its blob's
		// node unreachable, so the exact number of bytes it accepted is not known
		// and cannot be invented. Nonzero means the row is unsettled ACCOUNTING
		// EVIDENCE — never purged, its blob never dropped — until a probe answers.
		// See UploadSessionRow.UnresolvedAt and Service.recoverUnresolvedUploads.
		`ALTER TABLE upload_sessions ADD COLUMN unresolved_at INTEGER NOT NULL DEFAULT 0`,
		// How long a queued delete's RESPONSIBILITY outlives the first delete that
		// succeeds. 0 — every row written before this column existed, and every
		// ordinary enqueue since — keeps the old behaviour exactly: one success and
		// the row goes. A pairing room's void is the one caller that sets it, because
		// it is the one caller that removes the row a re-created blob could otherwise
		// be found through. See PendingNodeDelete.NotBefore.
		`ALTER TABLE pending_node_deletes ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0`,
		// Whether a delete for this key has EVER succeeded. 0 on every existing
		// row, which is the conservative reading: the age prune used to run on all
		// of them regardless, and after this it runs on none of them until one is
		// proven discharged. An existing row for a still-registered node therefore
		// keeps its blob's only owner instead of being thrown away on its seventh
		// day. See PendingNodeDelete.DeletedAt.
		`ALTER TABLE pending_node_deletes ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0`,
		// The billing obligation a pair-room session blob carries into the queue:
		// who owes for bytes past billed_through (up to bill_max). '' / 0 on every
		// existing row and every deletion-only enqueue — those rows bill nothing,
		// exactly as before. See the schema comment and PendingNodeDelete.BillUserID.
		`ALTER TABLE pending_node_deletes ADD COLUMN bill_user_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE pending_node_deletes ADD COLUMN bill_kind INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE pending_node_deletes ADD COLUMN bill_max INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE pending_node_deletes ADD COLUMN billed_through INTEGER NOT NULL DEFAULT 0`,
		// SHA-256 of the completion proof a receiver must present to end a
		// pair-room object's life (see pairroom_complete.go). NULLable, and
		// deliberately without a DEFAULT: NULL is a real state that outranks every
		// other — the row predates the column, the object is a share, or the sender
		// never asked for a completion capability — and it is answered with its own
		// status rather than folded into "wrong proof". A DEFAULT of '' would make
		// an absent verifier indistinguishable from a zero-length one and put a
		// length check on the critical path of that distinction.
		`ALTER TABLE stored_files ADD COLUMN completion_verifier BLOB`,
		// Provider-neutral subscription state (2026-08): ONE ROW PER (user,
		// provider), each carrying that provider's own plan/status/cycle/period
		// end, its canonical external subscription id, and — critically — its OWN
		// replay clock. Stripe's webhook and Apple's notifications are independent
		// ordered streams; a single shared users.sub_event_at cannot tell them
		// apart, so one provider's redelivery would rewind the other's state.
		//
		// The users row keeps plan_id/subscription_status/subscription_end/
		// plan_source/billing_cycle as the EFFECTIVE PROJECTION over these rows,
		// so enforcement, the admin console and every existing client are
		// unchanged. See entitlement.go for the resolution rules and
		// backfillSubscriptionSources for how a Stripe-only database is migrated.
		//
		// The users(id) reference is real (foreign_keys is ON), which is what ties
		// these rows into the account deletion lifecycle rather than leaving them
		// as orphans after a hard purge.
		`CREATE TABLE IF NOT EXISTS subscription_sources (
  user_id     TEXT NOT NULL REFERENCES users(id),
  provider    TEXT NOT NULL,
  plan_id     TEXT NOT NULL DEFAULT 'free',
  status      TEXT NOT NULL DEFAULT '',
  cycle       TEXT NOT NULL DEFAULT '',
  period_end  INTEGER NOT NULL DEFAULT 0,
  external_id TEXT NOT NULL DEFAULT '',
  external_scope TEXT NOT NULL DEFAULT '',
  event_at    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, provider))`,
		// Existing databases predate the Apple app-scope binding. Empty means the
		// historical source is unknown and therefore must fail closed in catalog
		// eligibility until a verified event records it.
		`ALTER TABLE subscription_sources ADD COLUMN external_scope TEXT NOT NULL DEFAULT ''`,
		// One external subscription has exactly ONE owner, enforced by the
		// database rather than by the care of every future adapter. Partial
		// because the overwhelming majority of rows carry no id yet ('' would
		// otherwise collide with every other unbound row).
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_sources_external
		   ON subscription_sources(provider, external_id) WHERE external_id <> ''`,
		// The reconcile sweep's candidate query walks the Stripe rows.
		`CREATE INDEX IF NOT EXISTS idx_subscription_sources_provider
		   ON subscription_sources(provider, plan_id)`,
		`CREATE TABLE IF NOT EXISTS stripe_webhook_events (
		 event_id TEXT PRIMARY KEY,
		 event_type TEXT NOT NULL,
		 status TEXT NOT NULL CHECK(status IN ('processing','processed','failed')),
		 attempts INTEGER NOT NULL DEFAULT 1,
		 claimed_at INTEGER NOT NULL,
		 finished_at INTEGER NOT NULL DEFAULT 0,
		 failure TEXT NOT NULL DEFAULT '')`,
		// The stable, opaque UUID an App Store purchase carries as
		// `appAccountToken` so the resulting transaction can be attributed to
		// this account. Server-issued, one per user, never a credential, and on
		// the users row precisely so the hard purge that removes the account
		// removes it too — no second cleanup path to keep in step. '' on every
		// existing row = never minted, which is what every account is until it
		// asks. Deliberately absent from the User struct so nothing that renders
		// or logs a user can pick it up by accident.
		`ALTER TABLE users ADD COLUMN apple_account_token TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE apple_renewal_states ADD COLUMN auto_renew_enabled INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE apple_renewal_states ADD COLUMN expiration_intent INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE apple_renewal_states ADD COLUMN price_increase_status INTEGER NOT NULL DEFAULT -1`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_account_token
		   ON users(apple_account_token) WHERE apple_account_token <> ''`,
		// Which App Store product grants which tier. Keyed by BUNDLE identity as
		// well as product id: Relayium's macOS and iOS apps ship under different
		// bundle ids and Apple namespaces product ids per app, so the same tier is
		// two distinct products and a pair of columns on `plans` could only ever
		// hold one of them. Nothing seeds this table — it is inert until real
		// product records exist, so no purchase can be granted by accident.
		//
		// The plans(id) reference is real (foreign_keys is ON). It guarantees the
		// tier EXISTS; whether it is still on sale is a lifecycle question no
		// constraint can answer, which is why UpsertAppleProduct checks it on the
		// way in and AppleProductPlan re-checks it on the way out. It is the
		// database-level backstop under UpsertAppleProduct's validation, for the
		// same reason the unique index sits under BindExternalSubscription's
		// ownership check: an App Store product wired to a tier that does not
		// exist is a paid purchase with no resolvable entitlement, and that must
		// not depend on every future write path remembering to ask. It is
		// compatible with the admin plan lifecycle because tiers are RETIRED
		// (active=0), never deleted — there is no DeletePlan. A future
		// plan-deletion path would hit this constraint, which is the correct
		// place to be forced to decide what happens to the products pointing at
		// the tier being deleted.
		`CREATE TABLE IF NOT EXISTS apple_products (
  bundle_id  TEXT NOT NULL,
  product_id TEXT NOT NULL,
  plan_id    TEXT NOT NULL REFERENCES plans(id),
  cycle      TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bundle_id, product_id))`,
		// The App Store Server Notifications V2 ledger: one row per
		// `notificationUUID`, holding both the idempotency claim and the verified
		// projection needed to replay the event later. See
		// sqlite_apple_notification.go for why those are deliberately one row.
		//
		// NO foreign key to users. The whole reason the deferred states exist is
		// that a notification can arrive for a subscription this server cannot yet
		// attribute to any account — a constraint requiring an owner would refuse
		// exactly the rows whose preservation is the point. Ownership lives on
		// subscription_sources, which is where it is enforced.
		//
		// Nothing seeds or backfills this table, and no existing deployment has
		// one: an older binary rolled back onto this database simply never reads
		// it, and a database written by an older binary starts empty, which is
		// indistinguishable from "no notification has arrived yet" — the correct
		// state for every deployment that has not configured the endpoint.
		`CREATE TABLE IF NOT EXISTS apple_notifications (
  notification_uuid       TEXT PRIMARY KEY,
  state                   TEXT NOT NULL,
  notification_type       TEXT NOT NULL DEFAULT '',
  received_at             INTEGER NOT NULL DEFAULT 0,
  updated_at              INTEGER NOT NULL DEFAULT 0,
  supported               INTEGER NOT NULL DEFAULT 0,
  bundle_id               TEXT NOT NULL DEFAULT '',
  product_id              TEXT NOT NULL DEFAULT '',
  original_transaction_id TEXT NOT NULL DEFAULT '',
  app_account_token       TEXT NOT NULL DEFAULT '',
  purchase_date_ms        INTEGER NOT NULL DEFAULT 0,
  expires_date_ms         INTEGER NOT NULL DEFAULT 0,
  revocation_date_ms      INTEGER NOT NULL DEFAULT 0,
  is_upgraded             INTEGER NOT NULL DEFAULT 0,
  environment             TEXT NOT NULL DEFAULT '')`,
		// The signed environment the projection came from, added to a table that
		// already existed (2026-08). It is part of the subscription's identity, not
		// a label: `originalTransactionId` is unique only within one App Store, so a
		// deployment that verifies both must know which one a deferred row belongs
		// to before it can replay it.
		//
		// ADDITIVE and defaulted, in both directions. A database this version
		// migrates keeps working under an older binary, whose explicit column lists
		// never name this column and whose INSERTs take the default. A row written
		// by that older binary — or before the migration — carries '', which is an
		// honest UNKNOWN: it is skipped and logged during a replay rather than
		// guessed into either store (see reconcileApplePendingNotifications).
		`ALTER TABLE apple_notifications ADD COLUMN environment TEXT NOT NULL DEFAULT ''`,
		// The drain's query: deferred rows for one external subscription. Partial,
		// because the states that matter are a small minority of a table whose
		// ordinary population is terminal rows nobody queries by subscription.
		//
		// Deliberately NOT re-cut to include `environment`. CREATE INDEX IF NOT
		// EXISTS is a no-op against an index of the same NAME with a different
		// definition, so evolving this one in place would silently leave existing
		// deployments on the old shape while new ones got the new one — two
		// different query plans behind one name. The drain therefore keeps reading
		// every pending row for the id and partitions by environment in Go, where
		// the skip is also the thing that can be logged.
		`CREATE INDEX IF NOT EXISTS idx_apple_notifications_pending
		   ON apple_notifications(original_transaction_id, purchase_date_ms)
		   WHERE state = 'pending'`,
		`CREATE INDEX IF NOT EXISTS idx_apple_notifications_terminal_age
		   ON apple_notifications(updated_at)
		   WHERE state IN ('applied', 'ignored', 'unsupported')`,
	} {
		if _, err := db.ExecContext(context.Background(), alter); err != nil &&
			!strings.Contains(err.Error(), "duplicate column name") {
			db.Close()
			return nil, err
		}
	}
	// The per-session metered ledger, and a ONE-TIME backfill of the rows that
	// predate it.
	//
	// It has to be one-time, which is why it is not in the idempotent list above.
	// Under this version a finalized row with metered < received means "an append
	// committed bytes and crashed before billing them", and the reaper's orphan
	// pass exists to collect exactly that; running the backfill on every boot
	// would quietly write those bills off instead. But rows that predate the
	// column mean the opposite — the previous version billed the whole object at
	// finalize — so leaving them at metered=0 would either double-bill them or,
	// since a row is never purged while its ledger is short, strand them forever.
	// The ALTER succeeding is the proof that every existing row is a pre-migration
	// one, so the backfill runs exactly there.
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE upload_sessions ADD COLUMN metered INTEGER NOT NULL DEFAULT 0`); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			db.Close()
			return nil, err
		}
	} else if _, err := db.ExecContext(context.Background(),
		`UPDATE upload_sessions SET metered = received WHERE done = 1`); err != nil {
		db.Close()
		return nil, err
	}
	// last_activity backs IDLE-based reaping of resumable uploads: a session is
	// abandoned only after no chunk has landed for pendingUploadTTL, not once its
	// absolute age crosses it — otherwise a legit large upload that simply takes
	// longer than the TTL (a >1 h transfer) gets reaped mid-flight, 404ing the next
	// chunk and forcing a restart-from-zero loop. Refreshed on each chunk advance
	// and on the finalize claim; existing rows read 0 and fall back to created_at
	// in the reaper query (max(last_activity, created_at)).
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE upload_sessions ADD COLUMN last_activity INTEGER NOT NULL DEFAULT 0`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, err
	}
	// The recovery pass asks for the least-recently-probed rows in the unresolved
	// state; every other upload-session query wants them excluded. Partial, so it
	// carries only rows in the state — which is normally none at all. It has to
	// come after the two ALTERs it indexes, which is why it is here rather than in
	// the list above.
	if _, err := db.ExecContext(context.Background(),
		`CREATE INDEX IF NOT EXISTS idx_upload_sessions_unresolved
		   ON upload_sessions(last_activity) WHERE unresolved_at > 0`); err != nil {
		db.Close()
		return nil, err
	}
	// cred_fp binds an admin session to a fingerprint of the admin credentials
	// (password + TOTP secret) in force when it was minted. Before the sessions
	// were persisted, rotating the admin password and RESTARTING was the standard
	// way to revoke a leaked cookie (the in-memory map was wiped); with sessions
	// in the DB that no longer worked. validAdmin now also matches cred_fp against
	// the current credentials, so a rotate+restart invalidates every prior session
	// again. Existing rows read '' and won't match the (non-empty) live
	// fingerprint, so they're invalidated on the deploy that adds this — admins
	// simply re-login once.
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE admin_sessions ADD COLUMN cred_fp TEXT NOT NULL DEFAULT ''`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, err
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
	// Same shape, same reason, for the Phase 1D-A purpose column: an empty
	// purpose is a row the ALTER reached but no write ever touched, and it must
	// read as the share it has always been rather than as an unknown kind of
	// object the public endpoints would refuse.
	if err := backfillStoredFilePurpose(context.Background(), db); err != nil {
		db.Close()
		return nil, err
	}
	// Same shape and same reason again, for the per-provider subscription rows:
	// a Stripe-only database written before this model existed must come out of
	// the migration with identical effective plans, identical canonical
	// subscription ownership and identical reconcile-sweep membership. Runs on
	// every boot (insert-only where missing) so a crash between the CREATE and
	// the fill self-heals rather than silently stranding those users.
	if err := backfillSubscriptionSources(context.Background(), db); err != nil {
		db.Close()
		return nil, err
	}
	// The billing hot paths now read the usage_periods buckets (see below), not
	// usage_events, so the recorded_at composite indexes an earlier version added
	// here are dead weight — and they added write cost to every heartbeat's
	// high-water update. Drop them.
	//
	// NOTE ON STARTUP COST: these run BEFORE the HTTP listener binds, so a
	// CREATE INDEX over a large table delays /healthz becoming ok. The deploy
	// health gate polls /healthz for a bounded time and reports a failure if it
	// never answers, so a slow first index build can be misread as a broken
	// deploy. Each statement therefore logs before it runs (a slow start must
	// be diagnosable, not mysterious). To avoid that startup cost on a large
	// table, build these indexes out of band before deploying: run the same
	// CREATE INDEX IF NOT EXISTS statements below directly against the
	// database with sqlite3 ahead of time — the loop here then finds them
	// already present and is a no-op.
	for _, idx := range []string{
		`DROP INDEX IF EXISTS idx_usage_user_recorded`,
		`DROP INDEX IF EXISTS idx_usage_node_recorded`,
		// stored_files.node_id was never indexed, so NodeFileCounts (once per
		// admin-dashboard render, over the largest table here) grouped by an
		// unindexed column: it walked idx_stored_files_expires, fetched the
		// ROW behind every live file to read node_id, and then sorted the lot
		// into a temp b-tree to group it. Composite with expires_at so the
		// whole aggregate is answered from the index alone — no row lookups,
		// no temp b-tree. Created here rather than in the base schema because
		// node_id itself arrives via the SP2 ALTER block above.
		`CREATE INDEX IF NOT EXISTS idx_stored_files_node ON stored_files(node_id, expires_at)`,
		// The admin BYO table's live page: filter on owner_type, split on
		// removed_at, then ORDER BY draining DESC, last_seen_at DESC, id ASC.
		// Column order and per-column direction are chosen so SQLite can supply
		// that order straight from the index and stop after LIMIT rows instead
		// of sorting the whole matching population into a temp b-tree — see
		// ListByoNodes, which explains why the ordering has no cross-table term
		// in it any more.
		`CREATE INDEX IF NOT EXISTS idx_nodes_byo_rank ON nodes(owner_type, removed_at, draining DESC, last_seen_at DESC, id ASC)`,
		// Superseded by idx_nodes_byo_rank (same leading columns, wrong order
		// for the ORDER BY). Only ever existed on machines that ran a pre-merge
		// build of this branch; dropping it is free everywhere else.
		`DROP INDEX IF EXISTS idx_nodes_byo`,
		// PruneNodeAudit's cap is scoped to machine-written rows (auth =
		// 'node-token'); without an index every 10-minute sweep full-scanned
		// admin_audit even when there was nothing over the cap. The equality
		// prefix makes the "how many machine rows are there" pre-check an index
		// seek, and at/id carry the newest-first ordering the cap needs.
		`CREATE INDEX IF NOT EXISTS idx_admin_audit_machine ON admin_audit(auth, at DESC, id DESC)`,
		// idx_nodes_owner_type(owner_type) is now a strict prefix of
		// idx_nodes_byo_rank(owner_type, removed_at, draining DESC,
		// last_seen_at DESC, id ASC): any lookup the single-column index could
		// serve, the wider one already serves just as well, so it is dead
		// write cost on every insert/update to `nodes`. Checked before
		// dropping: nothing in this codebase references it by name, and no
		// query plan captured while writing this branch chose it over
		// idx_nodes_byo_rank.
		`DROP INDEX IF EXISTS idx_nodes_owner_type`,
	} {
		if strings.HasPrefix(idx, "CREATE INDEX") {
			log.Printf("sqlite: ensuring index (may take a while on a large table, and runs before the listener binds): %s", idx)
		}
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
	// email_verified column + one-time grandfather backfill, run crash-safely
	// exactly once via schema_migrations (see migrateEmailVerified). The old
	// ALTER-then-UPDATE form had a crash window: a death between the two left the
	// column added but the backfill un-run, and the restart (ALTER now a dup)
	// skipped the backfill forever — locking every legacy user out as "unverified".
	if err := migrateEmailVerified(db); err != nil {
		db.Close()
		return nil, err
	}
	// See migrateActiveTransfersUnknown: corrects nodes.active_transfers for any
	// database that migrated through this branch's now-superseded DEFAULT 0
	// commit, regardless of migration order.
	if err := migrateActiveTransfersUnknown(db); err != nil {
		db.Close()
		return nil, err
	}
	// canonical_email backs the anti-Sybil register dedupe (H2b). Freshly added
	// (err==nil) → backfill every existing row's canonical form once; duplicate
	// column name → already migrated, skip.
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE users ADD COLUMN canonical_email TEXT NOT NULL DEFAULT ''`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, err
	}
	// Backfill runs UNCONDITIONALLY every boot, NOT gated on the ALTER succeeding.
	// If the process died between a successful ALTER and this backfill, gating it
	// on the ALTER would make every later boot see "duplicate column name", skip
	// the backfill forever, and leave legacy rows with canonical_email='' so the
	// H2b anti-Sybil dedup can never match them. It's scoped to the rows that
	// still need it (canonical_email='') — new rows get it set at INSERT — so it's
	// a no-op once migrated. Same crash-safe pattern as the max_downloads backfill.
	if err := backfillCanonicalEmail(context.Background(), db); err != nil {
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
	// The installation lookup hint plus the partial unique index that makes an
	// approved re-login find exactly one row or none. See migrateInstallID: the
	// index cannot live in the schema literal because the column it covers does
	// not exist on a legacy database until that ALTER has run.
	if err := migrateInstallID(db); err != nil {
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

// backfillCanonicalEmail populates canonical_email for any row that still lacks
// it (when canonical_email is empty). Scoped to those rows so it can run on every boot as a
// crash-safe idempotent no-op once migrated: a new row already has its canonical
// set at INSERT (InsertUserDedupedByCanonical), so only unmigrated legacy rows
// match.
func backfillCanonicalEmail(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `SELECT id, email FROM users WHERE canonical_email = ''`)
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

// ensureSchemaMigrations creates the ledger that records which one-shot data
// migrations have been applied, so they run exactly once and survive a crash
// mid-migration. Idempotent.
func ensureSchemaMigrations(db *sql.DB) error {
	_, err := db.ExecContext(context.Background(),
		`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
	return err
}

// migrateOnce runs fn exactly once across all boots and instances, keyed by id.
// The marker check, fn, and marker insert all happen in ONE write transaction, so
// a crash before commit rolls everything back (the migration re-runs cleanly next
// boot) and a completed migration never re-runs. The write transaction takes an
// IMMEDIATE lock (DSN _txlock=immediate), so two instances starting together
// serialize and the loser re-reads the marker inside its own tx and skips.
func migrateOnce(db *sql.DB, id string, fn func(*sql.Tx) error) error {
	if err := ensureSchemaMigrations(db); err != nil {
		return err
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM schema_migrations WHERE id = ?`, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return tx.Commit() // already applied (possibly by a concurrent instance)
	}
	if err := fn(tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(context.Background(),
		`INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`, id, time.Now().Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// columnExistsTx reports whether table has a column named col. table is always a
// trusted literal here (not user input), so interpolating it into PRAGMA — which
// cannot bind identifiers — is safe.
func columnExistsTx(tx *sql.Tx, table, col string) (bool, error) {
	rows, err := tx.QueryContext(context.Background(), `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid, notnull, pk int
			name, typ        string
			dflt             sql.NullString
		)
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == col {
			return true, nil
		}
	}
	return false, rows.Err()
}

// migrateEmailVerified adds the users.email_verified column and, the first time
// the column ever appears, grandfathers every pre-existing user to verified (so a
// pre-email-verification deployment's users aren't locked out). It runs exactly
// once via schema_migrations, crash-safely:
//
//   - Column absent (fresh DB, or a very old DB predating email verification):
//     ALTER + grandfather backfill happen in one transaction. SQLite DDL is
//     transactional, so a crash rolls back the ALTER too — the restart re-runs
//     cleanly instead of leaving legacy users stranded as unverified.
//   - Column already present but no marker (a DB migrated under the OLD pre-ledger
//     code — i.e. production): ADOPT it. Recording the marker without re-running
//     the backfill is critical — a blanket `SET email_verified = 1` here would
//     wrongly verify every currently-UNVERIFIED account, undoing the verification
//     gate for them.
func migrateEmailVerified(db *sql.DB) error {
	return migrateOnce(db, "grandfather_email_verified", func(tx *sql.Tx) error {
		exists, err := columnExistsTx(tx, "users", "email_verified")
		if err != nil {
			return err
		}
		if exists {
			return nil // adopt: do NOT re-backfill (would verify unverified accounts)
		}
		if _, err := tx.ExecContext(context.Background(),
			`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
		_, err = tx.ExecContext(context.Background(), `UPDATE users SET email_verified = 1`)
		return err
	})
}

// migrateActiveTransfersUnknown corrects nodes.active_transfers on any database
// that ran the ADD COLUMN migration while it still read `DEFAULT 0` (an earlier
// commit on this branch; see the comment on that ALTER above). On such a
// database, every row that existed at the moment the ALTER ran was stamped
// "known idle" (0) by SQLite's own default-fill, instead of the "unknown" (-1)
// the tri-state exists to express — the exact bias canaryRank was built to
// prevent, silently reinstated for every pre-existing node until its next
// heartbeat (which, for a node that never upgrades or never reports again, may
// be never).
//
// It cannot tell "defaulted to 0 by the old migration" apart from "genuinely
// reported 0 via a heartbeat" after the fact — both look identical in the
// column — so it picks the direction with the smaller downside: reclassify
// every row currently at 0 to -1. A row that is genuinely idle self-heals on
// its very next heartbeat (one heartbeat interval later), so a false positive
// here costs at most that long a gap in canary-ranking precision. Leaving a
// never-reported row at 0 costs nothing to notice and nothing to fix — it
// silently wins every canary pick, forever, until it happens to heartbeat.
// That asymmetry is why 0 always loses ties here, not 0 wins.
//
// Runs via migrateOnce, so it fires exactly once per database, ever, no matter
// which commit an environment happened to run first. On a database that never
// saw the old DEFAULT 0 (a fresh install, or one that only ever ran the -1
// default), every existing row is already -1 unless a real heartbeat set it,
// so the UPDATE below matches nothing and is a no-op — a fresh install and a
// clean upgrade end up in the identical state.
func migrateActiveTransfersUnknown(db *sql.DB) error {
	return migrateOnce(db, "backfill_active_transfers_unknown", func(tx *sql.Tx) error {
		_, err := tx.ExecContext(context.Background(),
			`UPDATE nodes SET active_transfers = -1 WHERE active_transfers = 0`)
		return err
	})
}

// migrateInstallID upgrades a live database to carry the installation lookup
// hint, and creates the constraint that makes the lookup answerable.
//
// Both ALTERs default to ”, so every pre-existing device row and every
// in-flight device-code request reads as "no hint" and behaves exactly as it
// did before — which is the whole migration story for legacy data. There is
// deliberately NO backfill: an identifier is something an installation
// generates and presents, and inventing one for a row would associate a machine
// with a credential nobody approved for it.
//
// The unique index is PARTIAL. Every legacy row carries ”, so a total unique
// index would collide with itself on the first upgrade and fail startup;
// excluding ” means any number of un-hinted rows coexist while a real
// identifier can name at most one row per account. It is created here rather
// than in the schema literal because on a legacy database the column does not
// exist until the ALTER above has run.
//
// Idempotent and safe to run on every boot: a duplicate column is ignored, and
// the index uses IF NOT EXISTS. No ledger entry is needed because nothing here
// rewrites data — there is no half-applied state a crash could leave behind
// that the next boot would skip.
func migrateInstallID(db *sql.DB) error {
	for _, alter := range []string{
		`ALTER TABLE devices ADD COLUMN install_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE cli_device_auth ADD COLUMN install_id TEXT NOT NULL DEFAULT ''`,
	} {
		if _, err := db.ExecContext(context.Background(), alter); err != nil &&
			!strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	_, err := db.ExecContext(context.Background(),
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_install_id
		   ON devices(user_id, install_id) WHERE install_id <> ''`)
	return err
}

func (s *SQLiteStore) Close() error {
	if s.rdb != nil {
		s.rdb.Close()
	}
	return s.db.Close()
}

func normEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

func (s *SQLiteStore) UpsertUserByEmail(ctx context.Context, email, displayName string) (User, error) {
	email = normEmail(email)
	var u User
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, deleted_at, purge_after, plan_id,
		        stripe_customer_id, stripe_subscription_id, subscription_status, subscription_end, plan_source, scheduled_plan_id, scheduled_cycle, billing_cycle
		   FROM users WHERE email = ?`, email,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.StripeSubscriptionID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID, &u.ScheduledCycle, &u.BillingCycle)
	if err == nil {
		return u, nil
	}
	if err != sql.ErrNoRows {
		return User{}, err
	}
	u = User{ID: authx.NewID(), Email: email, DisplayName: displayName, CreatedAt: time.Now().Unix()}
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
		        stripe_customer_id, stripe_subscription_id, subscription_status, subscription_end, plan_source, scheduled_plan_id, scheduled_cycle, billing_cycle
		   FROM users WHERE canonical_email = ? LIMIT 1`, canonical,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.StripeSubscriptionID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID, &u.ScheduledCycle, &u.BillingCycle)
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

	u := User{ID: authx.NewID(), Email: email, DisplayName: displayName, CreatedAt: time.Now().Unix()}
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
		        stripe_customer_id, stripe_subscription_id, subscription_status, subscription_end, plan_source, scheduled_plan_id, scheduled_cycle, billing_cycle,
		        plan_started_at, quota_accrued_bytes, quota_accrued_period
		   FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.StripeSubscriptionID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID, &u.ScheduledCycle, &u.BillingCycle,
		&u.PlanStartedAt, &u.QuotaAccruedBytes, &u.QuotaAccruedPeriod)
	if err == sql.ErrNoRows {
		return User{}, ErrNotFound
	}
	u.OnlyOwnNodes = strict != 0
	return u, err
}

// ListStripePaidUsers returns active users whose STRIPE source row is on a paid
// plan and who have a customer id — the reconcile sweep's candidate set.
//
// It is driven by the Stripe source row rather than by the users-row projection
// so that the sweep stays exactly as wide as Stripe itself: a user whose
// EFFECTIVE plan now comes from another provider still has a real Stripe
// subscription that can vanish and must still be reconciled, while a user with
// no Stripe row at all (an Apple-only account) can never be handed to
// ListActiveSubscriptions / CancelSubscription / the refund path. On a
// Stripe-only database the two formulations select exactly the same users:
// plan_source='stripe' holds precisely when the backfilled Stripe row mirrors
// the users row.
//
// plan_source='admin' (comped) stays excluded, as before: those accounts never
// took a webhook and the sweep has never been responsible for them.
func (s *SQLiteStore) ListStripePaidUsers(ctx context.Context) ([]User, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT u.id, u.email, u.display_name, u.created_at, u.email_verified, u.only_own_nodes, u.deleted_at, u.purge_after, u.plan_id,
		        u.stripe_customer_id, u.stripe_subscription_id, u.subscription_status, u.subscription_end, u.plan_source, u.scheduled_plan_id, u.scheduled_cycle, u.billing_cycle,
		        u.plan_started_at, u.quota_accrued_bytes, u.quota_accrued_period
		   FROM users u
		   JOIN subscription_sources s ON s.user_id = u.id AND s.provider = 'stripe'
		  WHERE s.plan_id != 'free' AND s.plan_id != '' AND u.plan_source != 'admin'
		    AND u.stripe_customer_id != '' AND u.deleted_at = 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		var strict int
		if err := rows.Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
			&u.StripeCustomerID, &u.StripeSubscriptionID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID, &u.ScheduledCycle, &u.BillingCycle,
			&u.PlanStartedAt, &u.QuotaAccruedBytes, &u.QuotaAccruedPeriod); err != nil {
			return nil, err
		}
		u.OnlyOwnNodes = strict != 0
		out = append(out, u)
	}
	return out, rows.Err()
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

// SetUserStripeSubscription records the user's canonical subscription id; an
// empty value clears it. Used by the webhook dedup to know which subscription is the one
// that drives the plan.
//
// The id is written to the users column (the compatibility projection the
// webhook dedup reads) and to the Stripe source row's external_id IN ONE
// TRANSACTION, so the two can never disagree. The source row is where
// ownership is ENFORCED: a subscription already bound to a different account is
// refused with ErrExternalSubscriptionOwned and neither write lands, so the
// existing binding stays with its owner rather than being taken over.
//
// A refusal is NOT something callers may shrug off. Both adoption call sites —
// the webhook's first-subscription branch and reconcileSubscriptions' canonical
// pick — stop and 500 on it, because the grant that would follow is justified
// by a subscription this account does not own. The one caller that does merely
// log is clearCanonicalSubscription, which passes ” and therefore cannot hit
// the ownership check at all; see its comment for why that single case is
// proportionate.
func (s *SQLiteStore) SetUserStripeSubscription(ctx context.Context, userID, subID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET stripe_subscription_id = ? WHERE id = ?`, subID, userID); err != nil {
		return err
	}
	if err := bindExternalSubscriptionTx(ctx, tx, userID, ProviderStripe, subID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetUserStripeCustomerIfEmpty binds a customer id only when the user has none
// yet, returning the id now in force (whichever won). Two concurrent first-time
// checkouts thus converge on a single customer even if the idempotency key were
// bypassed: the first write wins, the loser reads and reuses it. current!="" ⇒
// it was already bound and customerID is ignored.
func (s *SQLiteStore) SetUserStripeCustomerIfEmpty(ctx context.Context, userID, customerID string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var current string
	if err := tx.QueryRowContext(ctx, `SELECT stripe_customer_id FROM users WHERE id = ?`, userID).Scan(&current); err != nil {
		return "", err
	}
	if current != "" {
		return current, tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET stripe_customer_id = ? WHERE id = ?`, customerID, userID); err != nil {
		return "", err
	}
	return customerID, tx.Commit()
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
		        stripe_customer_id, stripe_subscription_id, subscription_status, subscription_end, plan_source, scheduled_plan_id, scheduled_cycle, billing_cycle
		   FROM users WHERE stripe_customer_id = ?`, customerID,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.StripeSubscriptionID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID, &u.ScheduledCycle, &u.BillingCycle)
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
// cycle is 'monthly'/'yearly' when the caller could derive it from the event's
// price id, or ” when it could not. An empty cycle LEAVES THE STORED VALUE
// ALONE rather than blanking it: a subscription event that carries no
// resolvable price (a cancellation, an unmapped price) must not erase a cycle
// we already knew, or the next in-app change would misread the direction.
// subEventAt is the Stripe event.created (unix secs) of the event driving this
// write; it is stored monotonically (only ever advanced, via MAX) so the webhook
// ordering guard can drop a later-delivered older event. Pass 0 for non-webhook
// callers (they never race Stripe ordering).
func (s *SQLiteStore) SetUserSubscription(ctx context.Context, userID, planID, status string, end int64, source, cycle string, now, subEventAt int64) error {
	// A real billing provider goes through the provider-neutral path: it owns a
	// source row of its own, with its own replay clock, and the users row below
	// becomes the projection over every such row. For a single provider the two
	// are identical, which is why this remains one call with one signature.
	//
	// SourceAdmin does NOT: a manual comp has no external subscription to
	// replay, cancel or refund, so it stays a direct write to the users row —
	// and it is the projection's top rule, which is what keeps it winning while
	// providers keep updating underneath.
	if knownProvider(source) {
		_, err := s.ApplySubscriptionSource(ctx, SourceEvent{
			UserID: userID, Provider: source, PlanID: planID, Status: status,
			Cycle: cycle, PeriodEnd: end, EventAt: subEventAt, Now: now,
		})
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Atomic out-of-order guard: read the last event clock under the SAME write
	// lock as the write below, so an older event that slipped past the (non-atomic)
	// subEventIsStale pre-check — a concurrent redelivery, two events the same
	// second — cannot overwrite newer plan/status. Before, only sub_event_at was
	// MAX-guarded while plan/status wrote unconditionally, so a stale event left
	// the clock advanced but the plan reverted, permanently. This is the
	// authoritative guard; subEventIsStale is just a fast-path ACK. subEventAt==0
	// (no clock, e.g. an admin-sourced write) skips the guard and never accrues.
	if subEventAt > 0 {
		var cur int64
		if err := tx.QueryRowContext(ctx, `SELECT sub_event_at FROM users WHERE id = ?`, userID).Scan(&cur); err != nil {
			return err
		}
		if subEventAt < cur {
			return tx.Commit() // stale: drop it — no accrual, no plan/status write
		}
	}
	if err := accrueQuotaTx(ctx, tx, userID, planID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET plan_id = ?, subscription_status = ?, subscription_end = ?, plan_source = ?,
		        billing_cycle = CASE WHEN ? = '' THEN billing_cycle ELSE ? END,
		        sub_event_at = CASE WHEN ? > sub_event_at THEN ? ELSE sub_event_at END
		  WHERE id = ?`,
		planID, status, end, source, cycle, cycle, subEventAt, subEventAt, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// LastSubEventAt returns users.sub_event_at (0 if none / user absent).
//
// It is no longer the webhook's ordering authority — that is
// LastSourceEventAt, per provider, because one shared clock cannot order two
// independent event streams. The column and this reader remain so a previous
// binary rolled back onto this database still finds the Stripe clock it
// expects; only Stripe events advance it (see applySourceTx).
func (s *SQLiteStore) LastSubEventAt(ctx context.Context, userID string) (int64, error) {
	var at int64
	err := s.db.QueryRowContext(ctx,
		`SELECT sub_event_at FROM users WHERE id = ?`, userID).Scan(&at)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return at, err
}

func (s *SQLiteStore) SetScheduledPlan(ctx context.Context, userID, planID, cycle string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET scheduled_plan_id = ?, scheduled_cycle = ? WHERE id = ?`, planID, cycle, userID)
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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET deleted_at = 0, purge_after = 0, purge_reminder_sent = 0 WHERE id = ?`, userID); err != nil {
		return err
	}
	// Revoke every still-unused reactivate token for this user in the same
	// transaction. Each frozen-login attempt during the grace window minted its
	// own reactivate token; once the account is recovered a leaked leftover would
	// otherwise stay a passwordless login for the rest of the window. (handle-
	// Reactivate's DeletedAt>0 guard already refuses them post-recovery — this
	// removes them so none can linger or be probed at all.)
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reactivate' AND used_at = 0`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// MarkPurgeReminderSent records when the pre-purge reminder email was sent.
func (s *SQLiteStore) MarkPurgeReminderSent(ctx context.Context, userID string, at int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET purge_reminder_sent = ? WHERE id = ?`, at, userID)
	return err
}

// PurgeTransientUserData wipes a user's transient/live data at
// deletion-confirmation time, keeping the account shell (users row +
// identities + usage_events/usage_monthly/user_stats) intact until the
// 30-day hard-purge (GC). It returns every blob the deleted rows pointed at so
// the caller can reclaim them (see userBlobsToReclaim for what "every" covers,
// and the Store interface for why the recovery state is not exempt).
//
// The blob enumeration runs INSIDE the transaction that deletes the rows: read
// it outside and an upload that starts in between is deleted by the sweep of
// its table while its partial blob is never handed to anyone — a leak nothing
// downstream can find, since the row that named it is gone.
//
// magic_tokens has no user_id column (it's keyed by the login email, not an
// account row — see CreateMagicToken), so it's purged by matching the user's
// current email instead. node_tokens carries its own user_id column (plus a
// nullable, unbound-until-claimed node_id), so it's deleted directly by
// user_id rather than via a nodes subquery, which would miss unbound tokens.
func (s *SQLiteStore) PurgeTransientUserData(ctx context.Context, userID string) ([]BlobRef, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	blobs, err := userBlobsToReclaim(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	stmts := []struct {
		q    string
		args []any
	}{
		{`DELETE FROM sessions WHERE user_id=?`, []any{userID}},
		{`DELETE FROM cli_tokens WHERE user_id=?`, []any{userID}},
		{`DELETE FROM cli_device_auth WHERE user_id=?`, []any{userID}},
		// Before devices. REDUNDANT with target_device_id's ON DELETE CASCADE
		// today, and kept anyway: it is scoped by user_id, so it does not depend
		// on every task having a live device row, and it survives a future schema
		// change that drops the cascade. No blob is orphaned either way — a task
		// references a stored_files row it does not own, and that table is purged
		// below.
		{`DELETE FROM inbox_tasks WHERE user_id=?`, []any{userID}},
		{`DELETE FROM devices WHERE user_id=?`, []any{userID}},
		{`DELETE FROM magic_tokens WHERE email=(SELECT email FROM users WHERE id=?)`, []any{userID}},
		{`DELETE FROM stored_files WHERE user_id=?`, []any{userID}},
		// Every chunked upload the account has open or half-finished, in whatever
		// state — including the recovery state, which every automatic sweep is
		// forbidden to touch. Their partial ciphertext is real ciphertext and their
		// rows carry a user_id, so leaving them would break the immediate-deletion
		// promise for as long as an unreachable node stayed away, which is forever.
		// The blobs went into the reclaim list above.
		{`DELETE FROM upload_sessions WHERE user_id=?`, []any{userID}},
		// The room row a pre-upload created. Its ciphertext is in stored_files and
		// upload_sessions (deleted on the lines above, blobs reclaimed by the
		// caller), so this only clears the deadline bookkeeping — but leaving it
		// would keep a user_id after the account is gone.
		{`DELETE FROM pair_rooms WHERE user_id=?`, []any{userID}},
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
	return blobs, nil
}

// userBlobsToReclaim lists every blob this user's ciphertext-holding rows point
// at: finalized stored_files, and the partial blob of every upload_sessions row
// regardless of state (open, finalized-but-orphaned, or in the recovery state)
// and regardless of placement (central-local, i.e. an empty node_id, or one of
// the user's own nodes).
//
// UNION, not UNION ALL, and that is the whole answer to the double-delete
// question: a finalize that persisted its stored_file but died before dropping
// its session leaves two rows naming ONE blob, and a caller handed it twice
// would delete it, then fail the second delete and queue a retry for a key that
// no longer exists — a permanently un-drainable entry in the node-delete queue.
// One row per (key, node) makes the reclaim exactly-once by construction.
//
// stored_files.node_id is nullable (it was added by a later migration) while
// upload_sessions.node_id defaults to the empty string; COALESCE normalizes so
// the two halves of the UNION agree on what "central" is and can actually
// deduplicate against each other.
func userBlobsToReclaim(ctx context.Context, tx *sql.Tx, userID string) ([]BlobRef, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT blob_key, COALESCE(node_id, '') FROM stored_files     WHERE user_id = ?
		UNION
		SELECT blob_key, COALESCE(node_id, '') FROM upload_sessions  WHERE user_id = ?`,
		userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BlobRef
	for rows.Next() {
		var b BlobRef
		if err := rows.Scan(&b.BlobKey, &b.NodeID); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
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
		// Device Inbox queue rows, before devices — see PurgeTransientUserData.
		{`DELETE FROM inbox_tasks WHERE user_id=?`, []any{userID}},
		{`DELETE FROM devices WHERE user_id=?`, []any{userID}},
		{`DELETE FROM usage_events WHERE user_id=?`, []any{userID}},
		// usage_periods carries a user_id column (per-period relay deltas the
		// billing hot paths read). It must be purged here too — the archive fold
		// above anonymizes usage_monthly, so leaving usage_periods behind would
		// retain user-attributed relay history indefinitely after the hard purge,
		// contradicting the "no user_id retained" privacy model, and leak an
		// unbounded orphan row per deleted account.
		{`DELETE FROM usage_periods WHERE user_id=?`, []any{userID}},
		{`DELETE FROM stored_files WHERE user_id=?`, []any{userID}},
		// Upload sessions, in every state, for the same reason as in
		// PurgeTransientUserData — and repeated here for the reason this whole
		// delete set is repeated: a hard purge must be correct on its own. The
		// confirm-time purge is what reclaims their blobs (it is the only path that
		// can, since SetAccountDeletion — the only thing that ever schedules a
		// purge — is called immediately after it), so what is left for this pass is
		// the row. A session opened between the two would be an account uploading
		// while frozen, which every upload route refuses.
		{`DELETE FROM upload_sessions WHERE user_id=?`, []any{userID}},
		// Deadline bookkeeping only, for the same reason as in
		// PurgeTransientUserData — but it holds a user_id, so it goes too.
		{`DELETE FROM pair_rooms WHERE user_id=?`, []any{userID}},
		{`DELETE FROM upload_events WHERE user_id=?`, []any{userID}},
		{`DELETE FROM user_stats WHERE user_id=?`, []any{userID}},
		{`DELETE FROM usage_monthly WHERE user_id=?`, []any{userID}},
		{`DELETE FROM email_tokens WHERE user_id=?`, []any{userID}},
		{`DELETE FROM node_tokens WHERE user_id=?`, []any{userID}},
		{`DELETE FROM cli_tokens WHERE user_id=?`, []any{userID}},
		// Non-FK but user-owned.
		{`DELETE FROM magic_tokens WHERE email=(SELECT email FROM users WHERE id=?)`, []any{userID}},
		{`DELETE FROM cli_device_auth WHERE user_id=?`, []any{userID}},
		// Per-provider subscription state. It carries user_id and a real
		// REFERENCES users(id), so it must go before the users row — and it must
		// go at all: leaving it would retain a purged account's billing history
		// and orphan a row per deleted account forever. Deliberately NOT part of
		// the confirm-time transient purge: an account inside the grace window
		// can still be reactivated, and it must come back with its subscription.
		// The Apple app account token needs no entry here — it is a column on the
		// users row this transaction deletes. Notification projections are
		// different: they intentionally have no user_id because they may arrive
		// before attribution. Remove every row attributable through either the
		// user's token or an Apple subscription binding before those lookup keys
		// disappear, so a hard-purged account leaves no replayable billing identity.
		// The subscription half of that join compares against the QUALIFIED
		// external id (apple_identity.go), because that is what
		// subscription_sources records: a Sandbox binding is stored as
		// 'sandbox:<id>' while this ledger keeps the raw id Apple signed plus the
		// environment beside it. Matching the raw column against the qualified id
		// would silently stop purging Sandbox rows. Rows written before the
		// environment column existed carry '', and the non-Sandbox branch matches
		// them raw — which is exactly how they were bound.
		{`DELETE FROM apple_notifications
		    WHERE app_account_token=(SELECT apple_account_token FROM users WHERE id=? AND apple_account_token<>'')
		       OR CASE WHEN environment='` + appleEnvSandbox + `'
		               THEN '` + appleSandboxExternalPrefix + `' || original_transaction_id
		               ELSE original_transaction_id END IN (
		            SELECT external_id FROM subscription_sources
		             WHERE user_id=? AND provider='apple')`, []any{userID, userID}},
		{`DELETE FROM subscription_sources WHERE user_id=?`, []any{userID}},
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

// UnlinkIdentityIfSafe removes one provider link only if doing so leaves the
// account with at least one login method (a password, or another linked
// provider). The count-and-delete run in one writer transaction so two
// concurrent unlinks of DIFFERENT providers can't each see "one method left" and
// both delete, leaving the account with zero login methods (a lockout). Returns:
// deleted (a link was removed), wouldOrphan (refused — it was the last method),
// and err. deleted=false && !wouldOrphan means the provider wasn't linked.
func (s *SQLiteStore) UnlinkIdentityIfSafe(ctx context.Context, provider, userID string) (deleted, wouldOrphan bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, false, err
	}
	defer tx.Rollback()

	var hash sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash); err != nil {
		if err == sql.ErrNoRows {
			return false, false, ErrNotFound
		}
		return false, false, err
	}
	// Methods that would remain after removing `provider`: password (if set) plus
	// any linked identity other than `provider` and the "password" pseudo-provider
	// (folded into the password_hash check, never double-counted).
	remaining := 0
	if hash.Valid && hash.String != "" {
		remaining++
	}
	var others int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT provider) FROM identities WHERE user_id = ? AND provider NOT IN (?, 'password')`,
		userID, provider).Scan(&others); err != nil {
		return false, false, err
	}
	remaining += others
	if remaining == 0 {
		return false, true, nil // last method — refuse, nothing deleted
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM identities WHERE provider = ? AND user_id = ?`, provider, userID)
	if err != nil {
		return false, false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, false, tx.Commit()
}

// 会话行以 **sha256(令牌)** 为主键，而不是令牌本身。
//
// 令牌就是 cookie 的值：明文存库意味着任何一次只读的库泄露（备份、快照、卷、一条
// SELECT 的 SQL 注入）都等于把所有在线用户的会话直接交出去，而且 TTL 是 14 天。
// 本项目其余每一种令牌（magic / reset / CLI / node / fleet / admin 会话）本来就都是
// authx.HashToken() 存的，唯独用户会话是例外——这里把它补齐。
//
// 升级不做数据迁移，也不需要：切换之后查询用的是 authx.HashToken(cookie)，旧行里存的是
// 原始令牌，要让它再次命中得对 sha256 求原像。所以旧行既失效又不可利用，
// DeleteExpiredSessions 会在它们到期时收走。代价是所有人被登出一次。
func (s *SQLiteStore) CreateSession(ctx context.Context, sess Session) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)`,
		authx.HashToken(sess.ID), sess.UserID, sess.CreatedAt, sess.ExpiresAt)
	return err
}

func (s *SQLiteStore) GetSession(ctx context.Context, id string) (Session, bool, error) {
	var sess Session
	var revoked int
	// 不 SELECT id：库里存的是哈希，回填给调用方会让它有机会被当成 cookie 值发出去。
	// 直接把调用方传进来的原始令牌放回 sess.ID。
	err := s.db.QueryRowContext(ctx,
		`SELECT user_id, created_at, expires_at, revoked FROM sessions WHERE id = ?`, authx.HashToken(id),
	).Scan(&sess.UserID, &sess.CreatedAt, &sess.ExpiresAt, &revoked)
	if err == sql.ErrNoRows {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, err
	}
	sess.ID = id
	if revoked != 0 {
		return sess, false, nil
	}
	sess.Revoked = false
	return sess, true, nil
}

func (s *SQLiteStore) RevokeSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET revoked = 1 WHERE id = ?`, authx.HashToken(id))
	return err
}

// RevokeUserSessions revokes every session of userID except exceptID (a raw
// token; "" revokes all of them).
func (s *SQLiteStore) RevokeUserSessions(ctx context.Context, userID, exceptID string) error {
	// exceptID 也要哈希后再比，否则"保留当前会话"会退化成"一个都不保留"——
	// 改密码之后连自己都被登出，而这条路径恰恰是改密码在走。
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id <> ?`, userID, authx.HashToken(exceptID))
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

const deviceCols = `id, user_id, name, created_at, last_seen_at, kind, last_ip, install_id`

// scanDevice keeps the column order of deviceCols and its readers in one place;
// adding a column to that list without adding it here is a compile error rather
// than a silently shifted field.
func scanDevice(sc rowScanner, d *Device) error {
	return sc.Scan(&d.ID, &d.UserID, &d.Name, &d.CreatedAt, &d.LastSeenAt, &d.Kind, &d.LastIP, &d.InstallID)
}

func (s *SQLiteStore) UpsertDevice(ctx context.Context, d Device) (Device, error) {
	// install_id is deliberately NOT in the DO UPDATE list. This upsert is the
	// browser self-registration path and the generic one; the installation
	// identifier is bound only by ApproveAndRegisterDeviceAuth, behind a human
	// approval. Letting an ordinary upsert move it would make the identifier
	// assignable by any authenticated caller, which is exactly what it must
	// never be.
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO devices (`+deviceCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
		 last_ip = CASE WHEN excluded.last_ip <> '' THEN excluded.last_ip ELSE devices.last_ip END
		 WHERE devices.user_id = excluded.user_id`,
		d.ID, d.UserID, d.Name, d.CreatedAt, d.LastSeenAt, d.Kind, d.LastIP, d.InstallID)
	if err != nil {
		return Device{}, err
	}
	var out Device
	err = scanDevice(s.db.QueryRowContext(ctx,
		`SELECT `+deviceCols+` FROM devices WHERE id = ? AND user_id = ?`,
		d.ID, d.UserID), &out)
	return out, err
}

// registerApprovedDeviceTx is the one place an installation identifier decides
// which device row a bearer lands on. Its caller owns the approval transaction,
// so row selection, bearer rotation and pending-token visibility share a commit.
//
// The lookup is `user_id = ? AND install_id = ?` with a non-empty identifier,
// which is what makes cross-account reuse and legacy-row adoption impossible
// rather than merely unlikely: a different account's rows are outside the
// predicate, and a legacy row's ” can never equal a valid identifier.
//
// The read-then-write here is safe WITHOUT a retry loop, and the reason is
// worth stating because it is a property of the connection, not of this code:
// every read-write transaction on this pool begins with BEGIN IMMEDIATE
// (`_txlock=immediate`, see OpenSQLite), so it holds the write lock from its
// first statement. Two approvals of the same installation therefore run
// strictly one after the other — the second one's SELECT sees the row the first
// one committed — instead of interleaving into two rows. Racing approvals
// converge on one row with exactly one live bearer, which
// TestTwoConcurrentApprovalsConvergeOnOneRowAndOneLiveBearer asserts directly.
//
// If that locking mode were ever relaxed, the partial unique index turns the
// interleaving into a refused INSERT — a failed approval the user can retry —
// rather than a silently split identity. There is deliberately no code here
// that "handles" that case: it cannot be reached from this process, so any
// handler for it would be untestable insurance that reads as coverage.
func registerApprovedDeviceTx(ctx context.Context, tx *sql.Tx, in ApprovedDeviceRegistration) (Device, error) {
	deviceID := ""
	if in.InstallID != "" {
		err := tx.QueryRowContext(ctx,
			`SELECT id FROM devices WHERE user_id = ? AND install_id = ?`,
			in.UserID, in.InstallID).Scan(&deviceID)
		if err != nil && err != sql.ErrNoRows {
			return Device{}, err
		}
	}

	if deviceID != "" {
		// Reuse. Only the server-observed address moves; the name, the kind and
		// the creation time belong to the owner and to the row's history.
		if in.LastIP != "" {
			if _, err := tx.ExecContext(ctx,
				`UPDATE devices SET last_ip = ? WHERE id = ? AND user_id = ?`,
				in.LastIP, deviceID, in.UserID); err != nil {
				return Device{}, err
			}
		}
	} else {
		deviceID = in.NewDeviceID
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO devices (`+deviceCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			deviceID, in.UserID, in.Name, in.At, 0, in.Kind, in.LastIP, in.InstallID); err != nil {
			return Device{}, err
		}
	}

	// Atomic bearer replacement. Every token previously bound to this row dies
	// in the same transaction that installs the new one, so there is never a
	// moment with two live bearers (a logout that half-revokes) or none (a
	// sign-in that authenticates nowhere). A freshly created row has none to
	// delete, which makes this uniform rather than conditional.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM cli_tokens WHERE device_id = ? AND user_id = ?`, deviceID, in.UserID); err != nil {
		return Device{}, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO cli_tokens (token_hash, user_id, device_id, created_at, last_seen_at)
		 VALUES (?, ?, ?, ?, 0)`,
		in.TokenHash, in.UserID, deviceID, in.At); err != nil {
		return Device{}, err
	}

	var out Device
	if err := scanDevice(tx.QueryRowContext(ctx,
		`SELECT `+deviceCols+` FROM devices WHERE id = ? AND user_id = ?`,
		deviceID, in.UserID), &out); err != nil {
		return Device{}, err
	}
	return out, nil
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
		if err := scanDevice(rows, &d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) RenameDevice(ctx context.Context, id, userID, name string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE devices SET name = ? WHERE id = ? AND user_id = ?`, name, id, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrNotFound
	}
	return nil
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
	// firstReportWindowSecs bounds a brand-new allocation's very first report:
	// with no prior report there is no elapsed-time budget (the exists branch
	// below), so a fixed window of several heartbeat intervals (~30s cadence) at
	// max rate stands in for it. Without this a first report was clamped only by
	// the ~2TiB absolute ceiling, letting a malicious node attribute a huge total
	// to a victim on a single fresh alloc_id.
	firstReportWindowSecs = 120
	// maxFirstReportBytes is that first-report budget: window×rate + slack. Large
	// enough never to under-count a legitimate first heartbeat, far below the
	// absolute ceiling.
	maxFirstReportBytes = int64(maxRelayBytesPerSec)*firstReportWindowSecs + relayReportSlack
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
	} else if newCum > maxFirstReportBytes {
		// First report: no prior timestamp to derive an elapsed-time budget from,
		// so bound it to a few heartbeat windows at max rate + slack. Denies a
		// malicious node a ~2TiB first-report attribution on a fresh alloc_id.
		newCum = maxFirstReportBytes
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

// ClaimTOTPStep atomically advances the admin TOTP replay guard to `step` iff it
// is strictly newer than the last committed step. Single UPDATE on the serialized
// writer, so the decision is atomic across instances sharing the DB file: two
// concurrent logins with the same code race here and exactly one gets
// RowsAffected==1. ok=false ⇒ the step was already spent (replay / stale).
func (s *SQLiteStore) ClaimTOTPStep(ctx context.Context, step int64) (bool, error) {
	// Normal path: claim iff `step` is strictly newer than the last used step.
	// Self-heal path (`last_step - step > totpForwardHealSteps`): the guard is
	// implausibly far in the FUTURE relative to this code's step. `step` always
	// tracks wall-clock (MatchAdminTOTPStep only accepts codes within ±1 step of
	// now), so a last_step many steps ahead can only come from a transient forward
	// clock jump (e.g. an NTP glitch) that committed a future step; once the clock
	// is corrected every real code would be rejected forever without this. Healing
	// resets the guard to the current step, so replay protection is unchanged (a
	// re-presented code is still `step == last_step`, not claimed). The margin is
	// wide enough that legit ±1 skew never triggers it.
	res, err := s.db.ExecContext(ctx,
		`UPDATE admin_totp_guard SET last_step = ?
		 WHERE id = 1 AND (? > last_step OR last_step - ? > ?)`,
		step, step, step, totpForwardHealSteps)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// Admin bearer tokens (session cookie, pending-action token + its bound session
// token, passkey-ceremony token) are stored as SHA-256 hashes, never raw — the
// same discipline the rest of the codebase applies to magic/CLI/fleet/node
// tokens. Callers pass the raw secret; the store hashes it on every write and
// every lookup, so a read of the DB file or a backup yields only hashes, not a
// copy-pasteable live admin credential. Hashing is confined to the store so no
// caller can accidentally persist a raw token.

// CreateAdminSession stores a new admin session (shared across instances). credFP
// pins it to the admin credentials in force at mint time (see cred_fp migration).
func (s *SQLiteStore) CreateAdminSession(ctx context.Context, token, auth, credFP string, expires int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO admin_sessions (token, auth, cred_fp, expires, last_step_up_at) VALUES (?, ?, ?, ?, 0)`,
		authx.HashToken(token), auth, credFP, expires)
	return err
}

// AdminSession returns a live admin session (expires > now) whose cred_fp still
// matches the current credentials. ok=false for missing/expired/credential-
// rotated; err is only a real store failure (caller fails closed).
func (s *SQLiteStore) AdminSession(ctx context.Context, token, credFP string, now int64) (auth string, lastStepUpAt int64, ok bool, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT auth, last_step_up_at FROM admin_sessions WHERE token = ? AND cred_fp = ? AND expires > ?`,
		authx.HashToken(token), credFP, now).Scan(&auth, &lastStepUpAt)
	if err == sql.ErrNoRows {
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, err
	}
	return auth, lastStepUpAt, true, nil
}

// MarkAdminStepUp records the time of a successful step-up (opens the grace window).
func (s *SQLiteStore) MarkAdminStepUp(ctx context.Context, token string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE admin_sessions SET last_step_up_at = ? WHERE token = ?`, at, authx.HashToken(token))
	return err
}

// DeleteAdminSession removes a session (logout).
func (s *SQLiteStore) DeleteAdminSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM admin_sessions WHERE token = ?`, authx.HashToken(token))
	return err
}

// PurgeExpiredAdminSessions drops sessions past their expiry (GC housekeeping).
func (s *SQLiteStore) PurgeExpiredAdminSessions(ctx context.Context, now int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM admin_sessions WHERE expires <= ?`, now)
	return err
}

// PutPendingAction stores a pending high-risk action, purging expired rows and
// enforcing the cap in one transaction. ok=false (nothing stored) when the cap
// is reached — the caller must reject rather than proceed.
func (s *SQLiteStore) PutPendingAction(ctx context.Context, token, sessionTok, action, form, pathID string, now, expires int64, cap int) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM admin_pending_actions WHERE expires <= ?`, now); err != nil {
		return false, err
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin_pending_actions`).Scan(&n); err != nil {
		return false, err
	}
	if n >= cap {
		return false, nil // reject, don't evict (a flood must not push out a real one)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO admin_pending_actions (token, session_tok, action, form, path_id, expires)
		 VALUES (?, ?, ?, ?, ?, ?)`, authx.HashToken(token), authx.HashToken(sessionTok), action, form, pathID, expires); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// TakePendingAction atomically claims (deletes) a pending action by token,
// returning its stored fields. ok=false means no such token. It deletes on the
// token alone — even a session-mismatch attempt burns it (the caller checks the
// session and expiry) — so a stolen token can't be probed repeatedly. The delete
// + return is one statement, so exactly one instance claims a given token.
// The returned sessionTok is the STORED hash of the minting session's cookie
// (hashToken), so the caller compares it against authx.HashToken(current cookie), not
// the raw cookie.
func (s *SQLiteStore) TakePendingAction(ctx context.Context, token string) (sessionTok, action, form, pathID string, expires int64, ok bool, err error) {
	err = s.db.QueryRowContext(ctx,
		`DELETE FROM admin_pending_actions WHERE token = ?
		 RETURNING session_tok, action, form, path_id, expires`, authx.HashToken(token),
	).Scan(&sessionTok, &action, &form, &pathID, &expires)
	if err == sql.ErrNoRows {
		return "", "", "", "", 0, false, nil
	}
	if err != nil {
		return "", "", "", "", 0, false, err
	}
	return sessionTok, action, form, pathID, expires, true, nil
}

// PutPasskeyCeremony stores an in-flight WebAuthn ceremony (session is the
// json-encoded webauthn.SessionData), purging expired rows and enforcing the cap
// in one transaction. ok=false (nothing stored) when the cap is reached.
func (s *SQLiteStore) PutPasskeyCeremony(ctx context.Context, token, kind, session, name string, now, expires int64, cap int) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM admin_passkey_ceremonies WHERE expires <= ?`, now); err != nil {
		return false, err
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin_passkey_ceremonies`).Scan(&n); err != nil {
		return false, err
	}
	if n >= cap {
		return false, nil // reject, don't evict (a flood must not knock out a live login)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO admin_passkey_ceremonies (token, kind, session, name, expires)
		 VALUES (?, ?, ?, ?, ?)`, authx.HashToken(token), kind, session, name, expires); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// TakePasskeyCeremony atomically claims (deletes) a ceremony by token. ok=false
// means no such token. The DELETE ... RETURNING makes it exactly-once across
// instances; a wrong-kind/replayed attempt still burns the challenge (the caller
// checks kind and expiry).
func (s *SQLiteStore) TakePasskeyCeremony(ctx context.Context, token string) (kind, session, name string, expires int64, ok bool, err error) {
	err = s.db.QueryRowContext(ctx,
		`DELETE FROM admin_passkey_ceremonies WHERE token = ?
		 RETURNING kind, session, name, expires`, authx.HashToken(token),
	).Scan(&kind, &session, &name, &expires)
	if err == sql.ErrNoRows {
		return "", "", "", 0, false, nil
	}
	if err != nil {
		return "", "", "", 0, false, err
	}
	return kind, session, name, expires, true, nil
}

const uploadSessionCols = `id, user_id, blob_key, node_id, billable, enc_manifest, ttl, max_dl, max_size, received, created_at, done, purpose, pair_room_id, metered, unresolved_at`

func scanUploadSession(sc rowScanner) (UploadSessionRow, error) {
	var r UploadSessionRow
	var billable, done int64
	var manifest []byte
	err := sc.Scan(&r.ID, &r.UserID, &r.BlobKey, &r.NodeID, &billable, &manifest,
		&r.TTL, &r.MaxDL, &r.MaxSize, &r.Received, &r.CreatedAt, &done, &r.Purpose,
		&r.PairRoomID, &r.Metered, &r.UnresolvedAt)
	if err != nil {
		return UploadSessionRow{}, err
	}
	r.Billable = billable != 0
	r.Done = done != 0
	r.EncManifest = manifest
	// A session opened before the column existed finalizes as the share it was
	// started as — the same normalization scanStoredFile applies.
	r.Purpose = purposeOrShare(r.Purpose)
	return r, nil
}

// CreateUploadSession inserts a session, enforcing the per-user open-session cap
// in one transaction. ok=false (nothing stored) when the user is at the cap.
//
// A session bound to a PAIRING ROOM carries that room's open-ness as a
// precondition, and gets ErrPairRoomClosed when it fails. The caller resolved
// the room in an earlier statement, so the room can end in between — and a
// session inserted after its room closed is the one row a void can never
// enumerate: it would keep the account's open-session slot, and any blob it went
// on to accept, until the generic one-hour reaper. Refusing here is what makes
// "the close saw every session this room will ever have" true.
func (s *SQLiteStore) CreateUploadSession(ctx context.Context, r UploadSessionRow, maxPerUser int) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if r.PairRoomID != "" {
		open, err := pairRoomOpenOn(ctx, tx, r.PairRoomID, r.CreatedAt)
		if err != nil {
			return false, err
		}
		if !open {
			return false, ErrPairRoomClosed
		}
	}
	var open int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM upload_sessions WHERE user_id = ? AND done = 0`, r.UserID).Scan(&open); err != nil {
		return false, err
	}
	if open >= maxPerUser {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO upload_sessions (`+uploadSessionCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.UserID, r.BlobKey, r.NodeID, b2i(r.Billable), r.EncManifest,
		r.TTL, r.MaxDL, r.MaxSize, r.Received, r.CreatedAt, b2i(r.Done),
		purposeOrShare(r.Purpose), r.PairRoomID, r.Metered, r.UnresolvedAt); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// GetUploadSession returns the session for id only if it belongs to userID
// (ownership gate). ok=false for missing / wrong owner.
func (s *SQLiteStore) GetUploadSession(ctx context.Context, id, userID string) (UploadSessionRow, bool, error) {
	// Read pool, not the single writer: this runs on every chunk PATCH and status
	// poll; keeping it off s.db stops a busy upload from serializing behind (and
	// blocking) unrelated writes. WAL gives read-your-writes for the prior
	// committed CommitUploadProgress, so the offset is never stale.
	r, err := scanUploadSession(s.reader().QueryRowContext(ctx,
		`SELECT `+uploadSessionCols+` FROM upload_sessions WHERE id = ? AND user_id = ?`, id, userID))
	if err == sql.ErrNoRows {
		return UploadSessionRow{}, false, nil
	}
	if err != nil {
		return UploadSessionRow{}, false, err
	}
	return r, true, nil
}

// CommitUploadProgress records one committed append: offset, meter, ledger and
// (for a pre-upload) the room's deadline, in one transaction. See the Store
// interface for why they are one.
//
// The delta is derived HERE, from the offset the database holds, not from
// anything the caller measured: two concurrent appends, or one client retrying
// after a failed commit, each compute their delta against the row they actually
// find, so the same byte cannot be billed twice and no byte between two offsets
// can be missed.
//
// The room's liveness is evaluated in the SAME transaction, and its answer is
// returned rather than folded into the byte accounting: bytes that arrived for
// a room that has just closed still crossed the wire and are still billed, but
// they buy no deadline and the request they came on must be refused.
func (s *SQLiteStore) CommitUploadProgress(ctx context.Context, p UploadProgress) (UploadProgressResult, error) {
	out := UploadProgressResult{RoomOpen: true}
	tx, err := s.db.BeginTx(ctx, nil) // IMMEDIATE (DSN): the read below is a write-lock read
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	// answerRoom settles everything the CALLER may say about the room, from the
	// row as it stands at this point in this transaction — whether the offset
	// moved or not, and after any move this call made.
	//
	// RoomOpen is the half a commit that did not move the offset still needs: the
	// session is gone, it is already terminal, or the append committed no new
	// bytes. Nothing was bought, but the REQUEST still has to be answered
	// truthfully, and the two questions have different answers — a session claimed
	// by a finalize or the reaper inside a live room means this append is merely
	// late (200 with the real offset), while a session whose PAIR ROOM has closed
	// means the room's own void has just reclaimed this upload, and 200 there
	// would tell a sender its bytes landed in a transfer whose ciphertext is
	// already deleted.
	//
	// RoomJoinDeadline is the other half, and it is READ here rather than derived
	// by the caller for the reason spelled out on the field: the row may hold a
	// deadline a sibling append bought after this request read the room, and a
	// handler-side reconstruction would report a number the room never had.
	//
	// A READ, never a touch: bytes that were not committed do not buy a deadline,
	// and reporting one the row already holds is not buying it.
	answerRoom := func() error {
		if p.RoomID == "" {
			return nil
		}
		room, found, err := pairRoomRowOn(ctx, tx, p.RoomID)
		if err != nil {
			return err
		}
		if !found {
			out.RoomOpen = false
			return nil
		}
		out.RoomOpen = pairRoomOpenAt(room, p.Now)
		if out.RoomOpen {
			// Only for a room that is still open, so the caller cannot answer 200 with
			// a window for one that is over. A voided room keeps a join deadline in
			// the future — closing it does not rewind last_upload_at — and reporting
			// that is an invitation to a rendezvous whose ciphertext has already been
			// deleted. The refusal path never reads this; the paths that can fall
			// through to a 200 anyway now find nothing to say, which is the same
			// silence the status probe keeps.
			//
			// pairRoomCodeDeadline, not pairRoomJoinDeadline: a room somebody has
			// already joined admits nobody else, so there is no instant to report
			// and none to extend its code to (invariant 5). A batch's later file
			// keeps uploading after the peer arrives — only a new init is refused —
			// so this is an ordinary interleaving, not an exotic one.
			out.RoomJoinDeadline = pairRoomCodeDeadline(room)
		}
		return nil
	}
	var received, maxSize, done int64
	err = tx.QueryRowContext(ctx,
		`SELECT received, max_size, done FROM upload_sessions WHERE id = ?`, p.SessionID).
		Scan(&received, &maxSize, &done)
	if err == sql.ErrNoRows {
		// Reaped, or never existed: nothing to advance.
		if rerr := answerRoom(); rerr != nil {
			return out, rerr
		}
		return out, tx.Commit()
	}
	if err != nil {
		return out, err
	}
	out.Received = received
	if done != 0 {
		// Finalized or reaped while this append was in flight. Its bytes are the
		// documented maxAppendBytes residual: physically present, past a terminal
		// offset nothing may move. Not billed, and bounded by one chunk.
		if rerr := answerRoom(); rerr != nil {
			return out, rerr
		}
		return out, tx.Commit()
	}
	// CLAMPED to the session's write cap rather than refused past it. The size is
	// whatever the blob store reports, and a malicious BYO/fleet node could report
	// far more than we ever sent in order to poison the owner's quota accounting;
	// max_size is the write budget this server itself authorized at init, so a
	// clamp cannot charge anyone for more than they were allowed to send. Refusing
	// outright (as this did before) instead loses the honest overshoot: a chunk
	// that trips the file-size cap commits a few kilobytes past it, and those
	// bytes crossed the wire and must be billed.
	to := min(p.Committed, maxSize)
	if to > received {
		delta := to - received
		if p.Billable {
			if _, err := tx.ExecContext(ctx,
				`UPDATE upload_sessions SET received = ?, last_activity = ?, metered = metered + ?
				 WHERE id = ?`, to, p.Now, delta, p.SessionID); err != nil {
				return out, err
			}
			if err := recordMeterOn(ctx, tx, p.UserID, MeterUpload, delta, p.Now); err != nil {
				return out, err
			}
		} else if _, err := tx.ExecContext(ctx,
			`UPDATE upload_sessions SET received = ?, last_activity = ? WHERE id = ?`,
			to, p.Now, p.SessionID); err != nil {
			return out, err
		}
		out.Received = to
	}
	// The room is ASKED ABOUT even when the offset did not move (a stale or
	// duplicate append, or a refusal that committed nothing): "did anything land"
	// and "is this room still a place bytes may be sent to" are different
	// questions, and answering the second only when the first is yes is how a
	// finalize ends up binding an object to a room that closed.
	//
	// It is MOVED only when the offset did move, and that distinction is
	// load-bearing rather than tidy. A pair room's deadline is defined as running
	// from the last accepted BYTE, and the abuse argument underneath it is that
	// pushing it out costs the account the bytes it is billed for (pairroom.go
	// invariants 3 and 4). An append that commits nothing is free — an empty body
	// at the committed offset is a request anyone can send in a loop — so if it
	// renewed the window, six digits and the room behind them could be held to the
	// six-hour ceiling at no cost, and the rule the window rests on would be
	// untrue.
	//
	// The touch and the answer are separate steps, and in that order, because the
	// answer must include a move this call did NOT make: touchPairRoomOn's UPDATE
	// is monotonic, so a sibling append that already pushed the room further out
	// makes it a silent no-op, and the deadline this request must report back is
	// the sibling's rather than its own. Reading the row afterwards is what makes
	// that automatic — and makes the reported number the row's, not a projection.
	if p.RoomID != "" {
		if out.Received > received {
			if _, err := touchPairRoomOn(ctx, tx, p.RoomID, p.Now, p.RoomExpiry); err != nil {
				return out, err
			}
		}
		if rerr := answerRoom(); rerr != nil {
			return out, rerr
		}
	}
	return out, tx.Commit()
}

// ReconcileUploadMeter bills the committed bytes of a session that no append
// recorded, and moves the session's ledger to match, in one transaction.
//
// `metered = received` rather than `metered + delta` is what makes it
// idempotent: whoever calls it second finds nothing left to bill.
//
// It is for sessions that are ALREADY terminal — the reaper's orphan pass, a
// finalize that crashed after claiming. The ordinary ways an upload ends settle
// inside ClaimUploadDone instead, where the bill cannot fail apart from the
// claim it belongs to.
func (s *SQLiteStore) ReconcileUploadMeter(ctx context.Context, id string, now int64) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var userID string
	var received, metered, billable int64
	err = tx.QueryRowContext(ctx,
		`SELECT user_id, received, metered, billable FROM upload_sessions WHERE id = ?`, id).
		Scan(&userID, &received, &metered, &billable)
	if err == sql.ErrNoRows {
		return 0, tx.Commit()
	}
	if err != nil {
		return 0, err
	}
	// Own-node uploads are never metered against a plan (they spend the user's own
	// disk), so there is nothing to reconcile and metered stays 0 for them.
	if billable == 0 || received <= metered {
		return 0, tx.Commit()
	}
	delta := received - metered
	if _, err := tx.ExecContext(ctx,
		`UPDATE upload_sessions SET metered = received WHERE id = ?`, id); err != nil {
		return 0, err
	}
	if err := recordMeterOn(ctx, tx, userID, MeterUpload, delta, now); err != nil {
		return 0, err
	}
	return delta, tx.Commit()
}

// ClaimUploadDone atomically marks the session terminal AND settles its meter,
// returning the committed offset at that instant and what settling it billed.
// ok=false ⇒ already done (a racing finalize/reaper won).
//
// One transaction, because the alternative was tried: claiming and reconciling
// as two calls made the bill the part that could fail on its own, and its
// caller — already holding a terminal claim — went on to delete the row that
// was the last record of what those bytes were. Here a failure claims nothing,
// so the retry that follows settles them exactly once.
func (s *SQLiteStore) ClaimUploadDone(ctx context.Context, id string, now int64) (received, billed int64, ok bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, false, err
	}
	defer tx.Rollback()
	var userID string
	var metered, billable int64
	// Refresh last_activity as we claim: a finalize on an idle-past-TTL upload
	// would otherwise leave the just-claimed done=1 row "expired", letting the
	// orphan reaper drop its blob in the window before persistStoredFile runs.
	err = tx.QueryRowContext(ctx,
		`UPDATE upload_sessions SET done = 1, last_activity = ? WHERE id = ? AND done = 0
		 RETURNING user_id, received, metered, billable`, now, id,
	).Scan(&userID, &received, &metered, &billable)
	if err == sql.ErrNoRows {
		return 0, 0, false, tx.Commit()
	}
	if err != nil {
		return 0, 0, false, err
	}
	// Own-node uploads spend the user's own disk and are never metered against a
	// plan, so there is nothing to settle for them.
	if billable != 0 && received > metered {
		billed = received - metered
		if _, err := tx.ExecContext(ctx,
			`UPDATE upload_sessions SET metered = received WHERE id = ?`, id); err != nil {
			return 0, 0, false, err
		}
		if err := recordMeterOn(ctx, tx, userID, MeterUpload, billed, now); err != nil {
			return 0, 0, false, err
		}
	}
	return received, billed, true, tx.Commit()
}

func (s *SQLiteStore) DeleteUploadSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM upload_sessions WHERE id = ?`, id)
	return err
}

// ListExpiredOpenUploadSessions returns still-open sessions IDLE since at/before
// `before` (no chunk landed since), for the reaper to claim and drop. Idle time
// is max(last_activity, created_at) so a legit long upload that keeps making
// progress is never reaped mid-flight, and pre-migration rows (last_activity=0)
// fall back to created_at.
//
// Recovery-state rows are done=1 and so cannot appear here; they have their own
// paced pass (ListUnresolvedUploadSessions).
func (s *SQLiteStore) ListExpiredOpenUploadSessions(ctx context.Context, before int64) ([]UploadSessionRow, error) {
	return s.uploadSessionsWhere(ctx,
		`WHERE done = 0 AND max(last_activity, created_at) <= ?`, before)
}

// ListOrphanDoneUploadSessions returns finalized (done=1) sessions idle since
// at/before `before` whose blob is NOT referenced by any stored_files row — a
// finalize that crashed (or whose DeleteUploadSession failed) after claiming
// done but before persisting the file. Their partial blobs would otherwise leak
// forever, since the open-session reaper only ever looks at done=0 rows.
//
// `unresolved_at = 0` keeps the recovery state out of it, and that clause is
// load-bearing rather than tidy: this pass DROPS BLOBS, and an unresolved
// session's blob is the only thing left that can say how many bytes its node
// really accepted. Deleting it would make the exact bill unrecoverable at the
// moment the node comes back — the same underbill the state exists to prevent,
// arrived at from the other side.
func (s *SQLiteStore) ListOrphanDoneUploadSessions(ctx context.Context, before int64) ([]UploadSessionRow, error) {
	return s.uploadSessionsWhere(ctx,
		`WHERE done = 1 AND unresolved_at = 0 AND max(last_activity, created_at) <= ?
		   AND blob_key NOT IN (SELECT blob_key FROM stored_files)`, before)
}

// ListUnresolvedUploadSessions returns recovery-state rows due for another
// re-probe, least-recently-attempted first and capped at `limit`: a fleet-wide
// outage must cost one bounded pass per sweep, not an unbounded one.
func (s *SQLiteStore) ListUnresolvedUploadSessions(ctx context.Context, before int64, limit int) ([]UploadSessionRow, error) {
	return s.uploadSessionsWhere(ctx,
		`WHERE unresolved_at > 0 AND last_activity <= ?
		 ORDER BY last_activity ASC LIMIT ?`, before, limit)
}

// uploadSessionsWhere runs one of the reaper's list queries. Written once so the
// three passes cannot drift on the column list or the scan.
func (s *SQLiteStore) uploadSessionsWhere(ctx context.Context, where string, args ...any) ([]UploadSessionRow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+uploadSessionCols+` FROM upload_sessions `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UploadSessionRow
	for rows.Next() {
		r, err := scanUploadSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// MarkUploadUnresolved moves an abandoned session whose blob could not be
// reached into the recovery state: terminal (done=1, so no client may append
// and it stops occupying one of the account's open-session slots) but NOT
// settled.
//
// done=1 without touching `metered` is exactly the intent: everything committed
// that an append managed to record is already billed, and what is left — the
// bytes the node took but never acknowledged — is an unknown, not a zero.
// unresolved_at is what says so, and what keeps every reclaiming pass off this
// row until a probe answers.
func (s *SQLiteStore) MarkUploadUnresolved(ctx context.Context, id string, now int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE upload_sessions SET done = 1, unresolved_at = ?, last_activity = ?
		 WHERE id = ? AND done = 0`, now, now, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// NoteUnresolvedProbe stamps a failed re-probe so the next one is a whole
// interval away. It is the ONLY write the failure path makes: nothing about a
// node staying away changes what the account owes.
func (s *SQLiteStore) NoteUnresolvedProbe(ctx context.Context, id string, now int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE upload_sessions SET last_activity = ? WHERE id = ? AND unresolved_at > 0`, now, id)
	return err
}

// SettleUnresolvedUpload ends the recovery state with a size a probe actually
// returned: the offset moves to it, every byte of it not yet on the account's
// meter is charged, and unresolved_at is cleared — one transaction, so the row
// can never say "settled" without the bill having landed.
//
// The size is CLAMPED to max_size, for the reason every other blob-reported
// number is: a malicious BYO or fleet node may answer with anything, and
// max_size is the write budget this server itself authorized at init. The
// offset also never moves backwards — a node that answers with LESS than we
// already recorded does not refund bytes that were billed when they crossed.
func (s *SQLiteStore) SettleUnresolvedUpload(ctx context.Context, id string, size, now int64) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var userID string
	var received, metered, maxSize, billable, unresolved int64
	err = tx.QueryRowContext(ctx,
		`SELECT user_id, received, metered, max_size, billable, unresolved_at
		   FROM upload_sessions WHERE id = ?`, id).
		Scan(&userID, &received, &metered, &maxSize, &billable, &unresolved)
	if err == sql.ErrNoRows {
		return 0, tx.Commit()
	}
	if err != nil {
		return 0, err
	}
	if unresolved == 0 {
		return 0, tx.Commit() // another instance's probe already settled it
	}
	to := max(received, min(size, maxSize))
	var billed int64
	if billable != 0 && to > metered {
		billed = to - metered
		metered = to
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE upload_sessions SET received = ?, metered = ?, unresolved_at = 0, last_activity = ?
		 WHERE id = ?`, to, metered, now, id); err != nil {
		return 0, err
	}
	if billed > 0 {
		if err := recordMeterOn(ctx, tx, userID, MeterUpload, billed, now); err != nil {
			return 0, err
		}
	}
	return billed, tx.Commit()
}

// PurgeDoneUploadSessions deletes finalized (done=1) rows idle since at/before
// `before` — housekeeping for rows a finalize left behind. Their blob is either
// a live stored_files entry (kept) or was already dropped by the orphan pass, so
// this only reclaims the tiny session row.
//
// SETTLED rows only. `metered >= received` is the guard, and it is the whole
// reason this is not an unconditional delete: the row is the only place that
// records how many bytes an upload accepted, so purging one whose meter is
// still short throws away a bill nothing else can ever reconstruct. An
// unsettled row simply survives to the next sweep, which reconciles it again.
// Own-node (billable=0) sessions are never metered and are always settled.
//
// A recovery-state row (unresolved_at > 0) is never purged either, and for a
// STRONGER reason: its meter is not merely behind, its true total is unknown.
// `metered >= received` would read as settled there — received is a lower
// bound, and everything up to it is billed — so age alone would quietly delete
// the evidence for the bytes beyond it. Nothing about "the node has been away a
// long time" makes those bytes free.
func (s *SQLiteStore) PurgeDoneUploadSessions(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM upload_sessions
		 WHERE done = 1 AND unresolved_at = 0 AND max(last_activity, created_at) <= ?
		   AND (billable = 0 OR metered >= received)`, before)
	return err
}

// ClearPassword NULLs the password hash so the account has no usable password
// credential (GetCredentials/HasPassword then report none).
func (s *SQLiteStore) ClearPassword(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET password_hash = NULL WHERE id = ?`, userID)
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

// AdminUserEmailsByIDs batch-resolves ids to emails in one IN(...) query, same
// pattern as the provider fan-out above: dedupe first so a query against N
// BYO rows sharing an owner still binds one placeholder per DISTINCT id, not
// per row.
func (s *SQLiteStore) AdminUserEmailsByIDs(ctx context.Context, ids []string) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	seen := map[string]bool{}
	var uniq []string
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			uniq = append(uniq, id)
		}
	}
	if len(uniq) == 0 {
		return out, nil
	}
	args := make([]any, len(uniq))
	ph := make([]string, len(uniq))
	for i, id := range uniq {
		args[i] = id
		ph[i] = "?"
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, email FROM users WHERE id IN (`+strings.Join(ph, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, email string
		if err := rows.Scan(&id, &email); err != nil {
			return nil, err
		}
		out[id] = email
	}
	return out, rows.Err()
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
		&burn, &f.CreatedAt, &f.ExpiresAt, &f.DownloadedAt, &nodeID, &f.MaxDownloads,
		&f.Purpose, &f.InboxTaskID, &f.PairRoomID, &f.CompletionVerifier, &f.DownloadCount)
	f.BurnAfterRead = burn != 0
	f.NodeID = nodeID.String
	// A row the purpose ALTER reached but no write ever touched reads as the
	// share it has always been. backfillStoredFilePurpose repairs the column on
	// every boot; this is the same answer for the window before it runs, so no
	// caller ever has to interpret an empty purpose.
	if f.Purpose == "" {
		f.Purpose = StoredPurposeShare
	}
	return f, err
}

// storedFileCols is the INSERT column list (CreateStoredFile). storedFileSelectCols
// adds download_count, which defaults on insert (0) and is only ever read back /
// mutated in place by ClaimDownloadSlot etc.
const storedFileCols = `id, user_id, blob_key, enc_manifest, size, burn_after_read, created_at, expires_at, downloaded_at, node_id, max_downloads, purpose, inbox_task_id, pair_room_id, completion_verifier`
const storedFileSelectCols = storedFileCols + `, download_count`

// CreateStoredFile inserts a stored file with no cap enforcement. An object bound
// to a pairing room is inserted under that room's precondition and takes that
// room's deadline (see insertPairRoomObjectOn); ErrPairRoomClosed if the room
// ended first.
//
// The pair-room case DELEGATES rather than repeating the transaction, with both
// caps disabled — which is exactly what a non-positive cap means. Two entry
// points into one insert is how the object's deadline came to depend on which
// call site an upload arrived through; there is one now, and this is the plain
// door into it.
func (s *SQLiteStore) CreateStoredFile(ctx context.Context, f StoredFile) error {
	if f.PairRoomID == "" {
		return insertStoredFileOn(ctx, s.db, f)
	}
	_, err := s.CreateStoredFileWithinStorageCaps(ctx, f, f.CreatedAt, 0, 0)
	return err
}

// insertStoredFileOn is the INSERT itself, written once so the three callers
// that reach it (plain, storage-capped, pair-room) cannot drift on the column
// list.
func insertStoredFileOn(ctx context.Context, ex sqlExecer, f StoredFile) error {
	// The completion verifier rides the SAME statement as the row, which is the
	// whole of its atomicity story: there is no interval in which an object exists
	// without the capability its sender asked for. An object in that state would be
	// unreachable by the only thing that can end it — held for good by the very
	// rule completion exists to close — and no repair pass could invent the value,
	// since the server has never seen the key it comes from.
	_, err := ex.ExecContext(ctx,
		`INSERT INTO stored_files (`+storedFileCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.UserID, f.BlobKey, f.EncManifest, f.Size,
		b2i(f.BurnAfterRead), f.CreatedAt, f.ExpiresAt, f.DownloadedAt, nullStr(f.NodeID), f.MaxDownloads,
		purposeOrShare(f.Purpose), f.InboxTaskID, f.PairRoomID, nullBytes(f.CompletionVerifier))
	return err
}

// insertPairRoomObjectOn inserts an object under its room's open precondition AND
// on its room's deadline, in the caller's transaction, and reports back what the
// row landed with.
//
// The precondition is the last gap in "void means gone, now". A finalize
// re-derives its room's liveness, then does several more writes, and the room can
// end in between: the object lands in a closed room, no later void will ever
// collect it (the void that closed the room took its object list before this row
// existed), and the sender is told 200 for ciphertext no receiver can reach.
// Checking inside the insert's own transaction makes that impossible — SQLite's
// single writer means a room open at this instant cannot close until this
// commits, and a room that closed first refuses the insert outright.
//
// The DEADLINE is here for the same reason and against the same interval, one
// step short of closure rather than one step short of gone. The caller's
// f.ExpiresAt is discarded: an object's expiry belongs to its room, the room
// moves, and a sibling request can move it after the caller computed its number
// and before this row exists. Since the row the precondition already reads is the
// authority, taking the deadline from it costs nothing and leaves no interval —
// where re-reading after the commit would simply move the gap along by one
// statement.
//
// Both returned instants come from that one read: ExpiresAt is what the row now
// carries (pairRoomNoDeadline once somebody has joined), RoomJoinDeadline is what
// the CODE may be extended to, and they are different numbers on purpose.
func insertPairRoomObjectOn(ctx context.Context, tx *sql.Tx, f StoredFile) (StoredFileWrite, error) {
	room, found, err := pairRoomRowOn(ctx, tx, f.PairRoomID)
	if err != nil {
		return StoredFileWrite{}, err
	}
	if !found || !pairRoomOpenAt(room, f.CreatedAt) {
		return StoredFileWrite{}, ErrPairRoomClosed
	}
	f.ExpiresAt = pairRoomExpiry(room)
	if err := insertStoredFileOn(ctx, tx, f); err != nil {
		return StoredFileWrite{}, err
	}
	return StoredFileWrite{ExpiresAt: f.ExpiresAt, RoomJoinDeadline: pairRoomCodeDeadline(room)}, nil
}

// CreateStoredFileWithinStorageCaps inserts a stored file only if it keeps the
// owner within userCap and the whole store within globalCap, summing live usage
// and inserting in ONE writer transaction. Because the writer pool is capped to
// a single connection, the sum-then-insert is serialized against every other
// upload, closing the check-then-write race that a separate over*-check +
// CreateStoredFile pair leaves open (N concurrent uploads each reading the same
// pre-commit total and all committing). A non-positive cap disables that check.
//
// Returns a StoredFileWrite whose Reason is "storage" (owner cap) or "global"
// (disk cap) when a cap would be exceeded and nothing was written; a real store
// error is returned as err so the caller fails CLOSED. "Live" bytes are
// expires_at > now, matching CurrentStorage / GlobalStorageUsed; the row being
// inserted is added explicitly since it is not yet visible to the pre-insert sums.
//
// For a pair-room object the returned deadlines are the ROOM's, read from its row
// in this same transaction — which is where they have to be decided, not where
// they are merely confirmed (see StoredFileWrite).
func (s *SQLiteStore) CreateStoredFileWithinStorageCaps(ctx context.Context, f StoredFile, now, userCap, globalCap int64) (StoredFileWrite, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return StoredFileWrite{}, err
	}
	defer tx.Rollback() // no-op after a successful Commit
	if userCap > 0 {
		var used sql.NullInt64
		if err := tx.QueryRowContext(ctx,
			`SELECT COALESCE(SUM(size),0) FROM stored_files WHERE user_id = ? AND expires_at > ?`,
			f.UserID, now).Scan(&used); err != nil {
			return StoredFileWrite{}, err
		}
		if used.Int64+f.Size > userCap {
			return StoredFileWrite{Reason: "storage"}, nil
		}
	}
	if globalCap > 0 {
		var used sql.NullInt64
		if err := tx.QueryRowContext(ctx,
			`SELECT COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > ?`, now).Scan(&used); err != nil {
			return StoredFileWrite{}, err
		}
		if used.Int64+f.Size > globalCap {
			return StoredFileWrite{Reason: "global"}, nil
		}
	}
	// Pair-room objects carry their room's open precondition AND their room's
	// deadline into this same transaction (insertPairRoomObjectOn), so a room that
	// ends between the caller's liveness check and this insert refuses the object
	// instead of stranding it, and one that merely MOVES in that window is
	// followed rather than lost.
	if f.PairRoomID != "" {
		out, err := insertPairRoomObjectOn(ctx, tx, f)
		if err != nil {
			return StoredFileWrite{}, err
		}
		return out, tx.Commit()
	}
	if err := insertStoredFileOn(ctx, tx, f); err != nil {
		return StoredFileWrite{}, err
	}
	return StoredFileWrite{ExpiresAt: f.ExpiresAt}, tx.Commit()
}

func (s *SQLiteStore) GetStoredFile(ctx context.Context, id string) (StoredFile, error) {
	f, err := scanStoredFile(s.db.QueryRowContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return StoredFile{}, ErrNotFound
	}
	return f, err
}

// GetStoredFileByBlobKey resolves a blob key (all a node knows) back to its
// stored-file row, so a direct-download receipt can find the owner + size to
// reconcile. Blob keys are unique server-minted tokens.
func (s *SQLiteStore) GetStoredFileByBlobKey(ctx context.Context, blobKey string) (StoredFile, error) {
	f, err := scanStoredFile(s.reader().QueryRowContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files WHERE blob_key = ?`, blobKey))
	if err == sql.ErrNoRows {
		return StoredFile{}, ErrNotFound
	}
	return f, err
}

// ClaimDownloadReceipt records a direct-download receipt nonce, returning true
// only the FIRST time (a duplicate receipt returns false), so reconciliation
// applies its refund exactly once.
func (s *SQLiteStore) ClaimDownloadReceipt(ctx context.Context, nonce string, at int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO download_receipts (nonce, at) VALUES (?, ?)`, nonce, at)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
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

func (s *SQLiteStore) DeleteStoredFile(ctx context.Context, id string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := deleteStoredFileOn(ctx, tx, id, now); err != nil {
		return err
	}
	return tx.Commit()
}

// deleteStoredFileOn is DeleteStoredFile's body, so a caller that must remove an
// object as part of a LARGER transaction — a pair-room completion, which also
// takes durable responsibility for the blob and may close the room — gets the
// same removal rather than a second one written beside it.
//
// The inbox settle is why this has to be shared rather than reduced to a bare
// DELETE at each site: removing an object silently fails any Device Inbox task
// still pointing at it, and a second copy of that rule is a second place for it
// to be forgotten. A pair-room object is never bound to a task, so for the
// completion path the UPDATE matches nothing and costs one statement.
func deleteStoredFileOn(ctx context.Context, tx *sql.Tx, id string, now int64) error {
	if _, err := tx.ExecContext(ctx,
		`UPDATE inbox_tasks
		    SET state = CASE WHEN expires_at <= ? THEN ? ELSE ? END,
		        error_code = CASE WHEN expires_at <= ? THEN '' ELSE ? END,
		        lease_expires_at = 0, terminal_at = ?, updated_at = ?
		  WHERE stored_file_id = ? AND state NOT IN `+terminalStateSQL,
		now, inbox.TaskExpired, inbox.TaskFailedTerminal,
		now, inbox.TaskErrStoredObjectUnavailable, now, now, id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM stored_files WHERE id = ?`, id)
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

// reclaimableTaskObjectSQL is the ONE definition of "no delivery can read this
// task object any more". Both the list and the conditional delete below embed
// it, so the sweep cannot select on one condition and delete on another.
//
// The three disjuncts, and why each is safe:
//
//   - UNBOUND past the bind grace. The sender uploads and then immediately
//     binds; an object still unbound an hour later belongs to a send that never
//     happened. Inside the grace it is kept, because the create that would bind
//     it may be in flight right now.
//   - BOUND to a task that is GONE. Nothing can reach the ciphertext: the task
//     row was the only route to it.
//   - BOUND to a task that is TERMINAL. saved/expired/revoked/failed_terminal
//     can never transition again and can never be claimed again, and the blob
//     endpoint only authorizes a live lease — so no reader remains. The task ROW
//     survives its retention window regardless, which is what keeps the sender's
//     UI able to explain what happened.
//
// The converse is the important half: while a task exists and is non-terminal,
// the ciphertext is kept, even long past the bind grace. A device that is
// offline, retrying, backing off or waiting on a person still has a delivery
// coming, and deleting under it would turn a slow transfer into a lost one.
const reclaimableTaskObjectSQL = `purpose = 'device_task' AND (
	    (inbox_task_id = '' AND created_at <= ?)
	 OR (inbox_task_id <> '' AND NOT EXISTS (
	       SELECT 1 FROM inbox_tasks t
	        WHERE t.id = stored_files.inbox_task_id
	          AND t.state NOT IN ` + terminalStateSQL + `)))`

func (s *SQLiteStore) ListReclaimableTaskObjects(ctx context.Context, now, bindGrace int64) ([]StoredFile, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+storedFileSelectCols+` FROM stored_files WHERE `+reclaimableTaskObjectSQL,
		now-bindGrace)
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

func (s *SQLiteStore) DeleteTaskObjectIfReclaimable(ctx context.Context, id string, now, bindGrace int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM stored_files WHERE id = ? AND `+reclaimableTaskObjectSQL, id, now-bindGrace)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
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

// RefundUpload removes a previously-reserved upload event by id — used when a
// finalize reserves the daily quota but then fails the authoritative storage-cap
// check, so the quota isn't charged for a file that never landed.
func (s *SQLiteStore) RefundUpload(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM upload_events WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) PruneUploadEvents(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM upload_events WHERE uploaded_at < ?`, before)
	return err
}

// PruneDownloadReceipts deletes direct-download receipt dedup rows older than
// `before`. Called with a generous margin (well past any possible in-flight
// download) so a duplicate receipt can never re-appear as "first" and
// double-refund the owner. Keeps the append-only table bounded.
func (s *SQLiteStore) PruneDownloadReceipts(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM download_receipts WHERE at < ?`, before)
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

func (s *SQLiteStore) GetReleaseCheck(ctx context.Context) (ReleaseCheck, error) {
	var rc ReleaseCheck
	err := s.reader().QueryRowContext(ctx,
		`SELECT latest_tag, checked_at, dismissed_tag, dismissed_at FROM release_check WHERE id = 1`).
		Scan(&rc.LatestTag, &rc.CheckedAt, &rc.DismissedTag, &rc.DismissedAt)
	if errors.Is(err, sql.ErrNoRows) {
		// Never checked and never dismissed. That is a state, not a failure:
		// the panel has its own wording for it.
		return ReleaseCheck{}, nil
	}
	return rc, err
}

func (s *SQLiteStore) SetReleaseCheckResult(ctx context.Context, tag string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO release_check (id, latest_tag, checked_at) VALUES (1, ?, ?)
		   ON CONFLICT(id) DO UPDATE SET latest_tag = excluded.latest_tag, checked_at = excluded.checked_at`,
		tag, at)
	return err
}

func (s *SQLiteStore) SetReleaseCheckDismissed(ctx context.Context, tag string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO release_check (id, dismissed_tag, dismissed_at) VALUES (1, ?, ?)
		   ON CONFLICT(id) DO UPDATE SET dismissed_tag = excluded.dismissed_tag, dismissed_at = excluded.dismissed_at`,
		tag, at)
	return err
}

const planCols = `id, name, storage_bytes, traffic_bytes, retention_secs, price_monthly, price_yearly, sort_order, active, updated_at, stripe_price_monthly_id, stripe_price_yearly_id, daily_quota_bytes`

func scanPlan(sc rowScanner) (Plan, error) {
	var p Plan
	var active int64
	err := sc.Scan(&p.ID, &p.Name, &p.StorageBytes, &p.TrafficBytes, &p.RetentionSecs,
		&p.PriceMonthly, &p.PriceYearly, &p.SortOrder, &active, &p.UpdatedAt,
		&p.StripePriceMonthlyID, &p.StripePriceYearlyID, &p.DailyQuotaBytes)
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
		`INSERT INTO plans (`+planCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name=excluded.name, storage_bytes=excluded.storage_bytes,
		   traffic_bytes=excluded.traffic_bytes, retention_secs=excluded.retention_secs,
		   price_monthly=excluded.price_monthly, price_yearly=excluded.price_yearly,
		   sort_order=excluded.sort_order, active=excluded.active, updated_at=excluded.updated_at,
		   stripe_price_monthly_id=excluded.stripe_price_monthly_id,
		   stripe_price_yearly_id=excluded.stripe_price_yearly_id,
		   daily_quota_bytes=excluded.daily_quota_bytes`,
		p.ID, p.Name, p.StorageBytes, p.TrafficBytes, p.RetentionSecs,
		p.PriceMonthly, p.PriceYearly, p.SortOrder, active, p.UpdatedAt,
		p.StripePriceMonthlyID, p.StripePriceYearlyID, p.DailyQuotaBytes)
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
	return recordMeterOn(ctx, s.db, userID, kind, bytes, at)
}

// sqlExecer is *sql.DB or *sql.Tx, so one SQL body can serve both a standalone
// call and a call inside somebody else's transaction instead of being written
// out twice and drifting apart.
type sqlExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// recordMeterOn is RecordMeter's body, usable inside a caller's transaction so
// that billing bytes and recording what they were billed for can be one atomic
// act (CommitUploadProgress, ClaimUploadDone, ReconcileUploadMeter).
func recordMeterOn(ctx context.Context, ex sqlExecer, userID string, kind UsageKind, bytes, at int64) error {
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
	_, err := ex.ExecContext(ctx, q, userID, periodOf(at), bytes, at)
	return err
}

// EnqueueUnbilledMeter durably records bytes that are OWED but could not be
// metered when they became known. See the unbilled_meter schema comment.
func (s *SQLiteStore) EnqueueUnbilledMeter(ctx context.Context, m UnbilledMeter) error {
	if m.ID == "" {
		m.ID = authx.NewID()
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO unbilled_meter (id, user_id, kind, bytes, at, reason) VALUES (?,?,?,?,?,?)`,
		m.ID, m.UserID, int(m.Kind), m.Bytes, m.At, m.Reason)
	return err
}

// SettleUnbilledMeter charges up to `limit` owed rows and returns how many it
// settled.
//
// ONE TRANSACTION PER ROW, containing the meter increment and the delete of the
// row that owed it. That is the whole reason this is a store method rather than
// a list/record/delete loop in GC: a crash between the increment and the delete
// would either bill twice or lose the bytes, and both are the failure this table
// exists to prevent.
//
// A row that cannot be settled stays and is retried on the next sweep. There is
// deliberately no age eviction: the row IS the evidence, and time does not
// answer what it records.
func (s *SQLiteStore) SettleUnbilledMeter(ctx context.Context, limit int) (int, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, kind, bytes, at FROM unbilled_meter ORDER BY at LIMIT ?`, limit)
	if err != nil {
		return 0, err
	}
	var owed []UnbilledMeter
	for rows.Next() {
		var m UnbilledMeter
		var kind int
		if err := rows.Scan(&m.ID, &m.UserID, &kind, &m.Bytes, &m.At); err != nil {
			rows.Close()
			return 0, err
		}
		m.Kind = UsageKind(kind)
		owed = append(owed, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	var settled int
	for _, m := range owed {
		if err := s.settleOneUnbilledMeter(ctx, m); err != nil {
			return settled, err
		}
		settled++
	}
	return settled, nil
}

func (s *SQLiteStore) settleOneUnbilledMeter(ctx context.Context, m UnbilledMeter) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := recordMeterOn(ctx, tx, m.UserID, m.Kind, m.Bytes, m.At); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM unbilled_meter WHERE id = ?`, m.ID); err != nil {
		return err
	}
	return tx.Commit()
}

// CountUnbilledMeter reports how many bills are still owed — the one number an
// operator needs to know whether this table is empty, which it should be.
func (s *SQLiteStore) CountUnbilledMeter(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM unbilled_meter`).Scan(&n)
	return n, err
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

// nullBytes converts an absent byte slice to SQL NULL — the same idea as
// nullStr for an optional BLOB (stored_files.completion_verifier).
//
// It matters more here than the string case does, because "absent" is a state
// the reader ACTS on rather than merely renders: an object with no completion
// verifier is answered differently from one whose verifier did not match. A
// zero-length blob would read back as a non-NULL empty credential and put that
// distinction on a length check instead of on the column.
func nullBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

// nodeCols is the SELECT column list shared by every node read path
// (UpsertNode's return, GetNode, StorageNodes, ListNodes, OnlineNodes), so the
// column order stays in lockstep with queryNodes's scan.
const nodeCols = `id, owner_type, owner_user_id, region, urls, turn_secret, version,
  relayed_bytes, stored_bytes, created_at, last_seen_at,
  storage_url, storage_secret, storage_fp, storage_enabled, storage_total, storage_free,
  traffic_limit_bytes, disk_limit_bytes, label, download_url,
  update_started_at, update_from_version, update_result, update_attempts, draining, removed_at,
  active_transfers, storage_unreachable, storage_probed_at`

func (s *SQLiteStore) UpsertNode(ctx context.Context, n Node) (Node, error) {
	if n.ID == "" {
		n.ID = authx.NewID()
	}
	urls, err := json.Marshal(n.URLs)
	if err != nil {
		return Node{}, err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO nodes (`+nodeCols+`)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET
		   owner_type=excluded.owner_type, owner_user_id=excluded.owner_user_id,
		   region=excluded.region, urls=excluded.urls, turn_secret=excluded.turn_secret,
		   version=excluded.version, last_seen_at=excluded.last_seen_at,
		   storage_url=excluded.storage_url, storage_secret=excluded.storage_secret,
		   storage_fp=excluded.storage_fp,
		   storage_enabled=excluded.storage_enabled, storage_total=excluded.storage_total,
		   storage_free=excluded.storage_free, download_url=excluded.download_url`,
		// label, the update_* columns, draining, removed_at and active_transfers are
		// intentionally set only on INSERT (label seeded from the token name;
		// update_* owned by the rollout state machine; draining owned by the
		// operator via SetNodeDraining; removed_at written once by MarkNodeRemoved;
		// storage_unreachable/storage_probed_at owned by the reachability prober;
		// active_transfers owned by the heartbeat, which is the only call that
		// carries a load reading) and preserved on re-register/heartbeat, so
		// neither a user's rename, an in-flight rollout's bookkeeping, an
		// operator's drain flag nor a completed deregistration is clobbered by a
		// node simply calling register/heartbeat again.
		n.ID, n.OwnerType, nullStr(n.OwnerUserID), n.Region, string(urls), n.TURNSecret,
		n.Version, n.RelayedBytes, n.StoredBytes, n.CreatedAt, n.LastSeenAt,
		nullStr(n.StorageURL), nullStr(n.StorageSecret), n.StorageFP, b2i(n.StorageEnabled), n.StorageTotal, n.StorageFree,
		n.TrafficLimitBytes, n.DiskLimitBytes, n.Label, n.DownloadURL,
		n.UpdateStartedAt, n.UpdateFromVersion, n.UpdateResult, n.UpdateAttempts, b2i(n.Draining), n.RemovedAt,
		n.ActiveTransfers, b2i(n.StorageUnreachable), n.StorageProbedAt)
	if err != nil {
		return Node{}, err
	}
	return n, nil
}

// TouchNode records a heartbeat: relayed_bytes is a cumulative counter
// (keep-MAX, never decrease), while stored_bytes is a live gauge of the bytes
// the node's own blob directory occupies and storage_total/storage_free are
// live snapshots of the node's disk state; none of those three are monotonic,
// so they are SET.
//
// This is central's only definition of stored_bytes, so to be explicit: it is
// NOT the whole volume's used space (total - free). It used to be, and that
// was the bug — a whole-volume reading counts the OS and every unrelated
// program sharing the disk as relayium storage, which inflated the admin
// dashboard and made the placement filter treat healthy nodes as out of quota.
// storage_total/storage_free keep the whole-volume meaning; stored_bytes does
// not. Do not "fix" stored_bytes back toward total - free.
//
// activeTransfers is the fourth live gauge and is SET for the same reason: it
// is how many relay allocations the node is serving RIGHT NOW, not a total, so
// a keep-max would pin every node at its all-time busiest and make decideFleet's
// canary pick meaningless. -1 is a legitimate value here (see
// Node.ActiveTransfers) meaning "this heartbeat carried no load signal"; every
// other value is clamped non-negative by the caller (see handleNodeHeartbeat).
// This is the only writer of the column.
func (s *SQLiteStore) TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, storageTotal, storageFree, at int64, activeTransfers int) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET last_seen_at=?,
		   relayed_bytes=MAX(relayed_bytes, ?), stored_bytes=?,
		   storage_total=?, storage_free=?, active_transfers=? WHERE id=?`,
		at, relayedBytes, storedBytes, storageTotal, storageFree, activeTransfers, id)
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

// storageHeadroomNum/storageHeadroomDen is the fraction of a node's free
// space we're willing to promise during placement — defined exactly once so
// the SQL below and usableBytes (used by the per-request placement check)
// can't drift apart.
const storageHeadroomNum, storageHeadroomDen = 7, 10

// usableBytes is the number of bytes we're willing to promise out of a
// node's free space when placing a new blob: 70% of what's left, leaving a
// 30% cushion so placement never drives a node right up to its disk.
func usableBytes(free int64) int64 {
	return free * storageHeadroomNum / storageHeadroomDen
}

// volumeReserveDen 是整卷保留的分母：剩余空间必须至少占总量的
// 1/volumeReserveDen，否则该节点整台退出放置池，免得 relayium 把宿主机的盘撑
// 爆。与 storageHeadroom* 是两回事——那个限制「一次放多少」（按需求量算的调度
// 余量），这个限制「整块盘能用到多满」（到线即整台排除，与需求量无关）。
//
// 定义一次，StorageNodes 与 UserStorageNodes 两处 SQL 都从这里 Sprintf 进去。
//
// 注意：cmd/relayium-node/relay.go 的 blobGates 里有同口径的**节点本地**绝对写
// 闸（`f*5 < t`）。那是另一个二进制，编译单元不通，共享不了这个常量——改这里
// 的值就必须同时改那边，否则中心端和节点端会静默地按两条不同的线做决定。
const volumeReserveDen = 5 // storage_free * 5 >= storage_total ⇔ 剩余 ≥ 20%

// StorageNodes returns fleet storage nodes that are online since `since` and
// can offer at least minFree bytes — candidates for placing a new
// node-backed blob.
func (s *SQLiteStore) StorageNodes(ctx context.Context, since, minFree int64) ([]Node, error) {
	// storage_free*7/10 >= minFree only ever promises 70% of what's left on the
	// volume, keeping a 30% cushion so placement never drives a node right up to
	// its disk. Note this is a *scheduling* reserve, evaluated per placement —
	// it is not a write gate. A gate defined against free space would be
	// self-referential (writing shrinks free, which shrinks the threshold, which
	// never converges); the node's own absolute floor in relay.go handles that.
	//
	// storage_free*5 >= storage_total keeps the volume at most 80% full: never
	// place a new blob on a node whose disk is already past that reserve, so a
	// node can't be filled to the point of wedging its host.
	//
	// The 7/10 and 1/5 ratios are spliced in via fmt.Sprintf from the constants
	// above — not from any request input, which stays parameterized via `?` —
	// so this SQL, usableBytes and storableBytes can never fall out of sync.
	query := fmt.Sprintf(
		`SELECT `+nodeCols+` FROM nodes
		   WHERE owner_type='fleet' AND storage_enabled=1 AND draining=0 AND removed_at=0
		     AND storage_unreachable=0 AND last_seen_at >= ? AND storage_free * %d / %d >= ?
		     AND (disk_limit_bytes = 0 OR disk_limit_bytes - stored_bytes >= ?)
		     AND (storage_total = 0 OR storage_free * %d >= storage_total)
		   ORDER BY last_seen_at DESC`, storageHeadroomNum, storageHeadroomDen, volumeReserveDen)
	return s.queryNodes(ctx, query, since, minFree, minFree)
}

// OnlineNodes returns the fleet nodes central is currently willing to hand out
// (relay/ICE candidates). Uninstalled nodes (removed_at != 0) are excluded even
// if their last heartbeat is still inside the window: the deregistration
// arrives seconds before the service stops, so for that short overlap the row
// still looks online while the machine is on its way out.
func (s *SQLiteStore) OnlineNodes(ctx context.Context, since int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='fleet' AND removed_at=0 AND last_seen_at >= ? ORDER BY last_seen_at DESC`, since)
}

func (s *SQLiteStore) ListNodes(ctx context.Context) ([]Node, error) {
	return s.queryNodes(ctx, `SELECT `+nodeCols+` FROM nodes ORDER BY last_seen_at DESC`)
}

// adminByoSearchMax bounds the length of a BYO search term.
//
// Not a UX nicety: the term is wrapped in %…% and handed to LIKE, and SQLite
// rejects a pattern past SQLITE_MAX_LIKE_PATTERN_LENGTH with "LIKE or GLOB
// pattern too complex" — an ERROR, which the dashboard would otherwise have to
// render as "no matches", i.e. a confident wrong answer in the one table where
// acting on "there is no such node" is expensive. 200 is far above any real
// term (a node id is 32 chars, an email under 100, a label shorter still), so
// clamping to it cannot hide a match: a truncated substring pattern matches a
// SUPERSET of what the full one would, and the clamped term is echoed back in
// the search box so the operator sees exactly what was searched.
const adminByoSearchMax = 200

// clampByoSearch trims a search term to adminByoSearchMax runes (runes, not
// bytes — cutting a UTF-8 sequence in half would produce a pattern that
// matches nothing).
func clampByoSearch(s string) string {
	r := []rune(s)
	if len(r) <= adminByoSearchMax {
		return s
	}
	return string(r[:adminByoSearchMax])
}

// ListByoNodes returns one page of user-contributed nodes plus the total number
// of matches. See AdminByoNodeQuery for what Search matches and why.
//
// Everything the admin BYO table needs — the owner_type filter, the
// live/removed split, the text search, the ranking and the page window — is
// expressed here in SQL. It used to be ListNodes (every row, fleet and BYO)
// followed by a Go filter + sort.Slice + truncate, which gave an operator no
// way to reach node #21 at all.
//
// WHAT SQLITE ACTUALLY DOES, for the unsearched live page (the one that
// renders on every admin home load) — verified with EXPLAIN QUERY PLAN
// against the REAL statements (real nodeCols, not a hand-written SELECT):
//
//	-- the COUNT(*):
//	SEARCH nodes USING COVERING INDEX idx_nodes_byo_rank (owner_type=? AND removed_at=?)
//	-- the page SELECT (all 28 nodeCols):
//	SEARCH nodes USING INDEX idx_nodes_byo_rank (owner_type=? AND removed_at=?)
//
// Only the COUNT(*) is covering — it only needs the indexed columns. The page
// SELECT reads every one of the 28 nodeCols, which idx_nodes_byo_rank does not
// carry, so SQLite still does a row lookup per matching id; it is NOT a
// covering-index scan, and no comment here should say otherwise. What does
// hold: no temp b-tree for either — idx_nodes_byo_rank supplies the ORDER BY
// directly, so the scan (and its row lookups) stops after LIMIT+OFFSET rows,
// and the rows past the page are genuinely not read. That is only true
// because the ordering is expressible by an index on `nodes` alone. An
// earlier version ranked "still holding unexpired files"
// second, via a correlated EXISTS over stored_files; no index can supply that
// order, so SQLite read EVERY matching BYO row, ran the subquery per row, and
// sorted the lot into a temp b-tree before applying LIMIT — i.e. the page
// limit bounded what was RENDERED, never what was read. The term is gone:
//   - it existed because the old table truncated at 20 rows with no way to see
//     row 21, so the top 20 had to be the "right" 20. Search and pagination
//     removed that constraint — every BYO node is now reachable — which is
//     what makes dropping the tier honest rather than a regression;
//   - the per-row "剩余文件 / 最早可安全卸载" column still shows the same fact
//     on the row itself, which is where an operator reads it before acting.
//
// WHAT IS ACTUALLY LOST, recorded here as a decision rather than left to be
// discovered as an accident: there is no longer any way to answer, FROM THIS
// DASHBOARD, "which BYO nodes are still holding files" as a set. There is no
// sort key and no filter for it, and Search (see AdminByoNodeQuery) matches
// only id/label/region/owner-email — none of which is "has files". An
// operator has to already know which node to look for (or page/search through
// the whole live set and read the per-row column on each one); the old
// ranking tier was the only way to get that answer as a LIST, and dropping it
// removes that capability, not just a display nicety.
//
// What survives is `draining DESC` (an operation is already in progress and
// the operator most likely came back to watch it), then last_seen_at DESC,
// then id ASC — the id tiebreak keeps the order stable across refreshes
// (SQLite, like sort.Slice, guarantees nothing for ties, and "where did that
// row go" is the worst kind of phantom).
//
// A SEARCHED page cannot be covering (the LIKE terms and the users EXISTS are
// outside the index) and the count is an aggregate, but both still scan the
// index range in order rather than sorting: no temp b-tree appears in either.
//
// Removed rows rank by removed_at DESC, id ASC instead: that section is a
// most-recent-mistake-first recovery list, not a history archive. `removed_at
// != 0` is not an index constraint, so that query walks the owner_type='user'
// range in removed_at order and sorts only the LAST term (ties on removed_at,
// which are manual admin actions seconds apart — the partial sort is bounded
// by a tie group, not by the population).
// byoListWhereOrder builds the WHERE-clause fragment (with its bound args)
// and the ORDER BY fragment ListByoNodes assembles into both its COUNT and
// its page SELECT. Factored out to one definition, used by ListByoNodes
// itself, so a test can EXPLAIN QUERY PLAN the REAL fragments the query
// issues instead of a hand-copied literal — a copy would keep passing after
// an ORDER BY change made only here; this can't, because it IS here.
func byoListWhereOrder(q AdminByoNodeQuery) (where string, whereArgs []any, order string) {
	where = ` WHERE owner_type='user' AND removed_at` + map[bool]string{false: `=0`, true: `!=0`}[q.Removed]
	if search := clampByoSearch(q.Search); search != "" {
		// The owner's email lives on users, reached with EXISTS rather than a
		// JOIN so a node whose owner row is gone (deleted account) still lists
		// and still matches on its own columns.
		where += ` AND (id LIKE ? ESCAPE '\' OR label LIKE ? ESCAPE '\' OR region LIKE ? ESCAPE '\'
		   OR EXISTS (SELECT 1 FROM users u WHERE u.id = nodes.owner_user_id AND u.email LIKE ? ESCAPE '\'))`
		like := "%" + escapeLike(search) + "%"
		whereArgs = append(whereArgs, like, like, like, like)
	}
	order = ` ORDER BY removed_at DESC, id ASC`
	if !q.Removed {
		order = ` ORDER BY draining DESC, last_seen_at DESC, id ASC`
	}
	return where, whereArgs, order
}

func (s *SQLiteStore) ListByoNodes(ctx context.Context, q AdminByoNodeQuery) ([]Node, int64, error) {
	where, whereArgs, order := byoListWhereOrder(q)

	var total int64
	if err := s.reader().QueryRowContext(ctx,
		`SELECT COUNT(*) FROM nodes`+where, whereArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	limit := q.Limit
	if limit <= 0 {
		limit = 1
	}
	listArgs := append(append([]any{}, whereArgs...), limit, q.Offset)
	nodes, err := s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes`+where+order+` LIMIT ? OFFSET ?`, listArgs...)
	if err != nil {
		return nil, 0, err
	}
	return nodes, total, nil
}

// UserNodes returns a user's own (owner_type='user') nodes online since
// `since`. Uninstalled nodes are excluded, same as OnlineNodes — this feeds ICE
// and the strict-mode "do you have a node at all" check, and neither should
// ever answer with a machine that has been removed. UserNodesAll below is
// deliberately NOT filtered: the dashboard list still shows it (offline), which
// is how a user sees what became of their node.
func (s *SQLiteStore) UserNodes(ctx context.Context, userID string, since int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? AND removed_at=0 AND last_seen_at >= ? ORDER BY last_seen_at DESC`,
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
	// Same volume reserve as StorageNodes: even the user's own node is skipped
	// once its volume is past 80% used, so a full disk never bricks their host.
	// Spliced from volumeReserveDen (not a literal) so the two SQL sites and
	// storableBytes stay one definition; the request input stays on `?`.
	query := fmt.Sprintf(
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? AND last_seen_at >= ? AND storage_enabled=1 AND draining=0 AND removed_at=0 AND storage_free >= ?
		   AND storage_unreachable=0
		   AND (storage_total = 0 OR storage_free * %d >= storage_total) ORDER BY last_seen_at DESC`, volumeReserveDen)
	return s.queryNodes(ctx, query, userID, since, minFree)
}

// DeleteNode removes a user-owned node, owner-scoped.
func (s *SQLiteStore) DeleteNode(ctx context.Context, id, ownerUserID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after a successful Commit

	// Owner-scoped: only delete a node this user owns.
	res, err := tx.ExecContext(ctx, `DELETE FROM nodes WHERE id = ? AND owner_user_id = ?`, id, ownerUserID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE node_id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
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

// SetNodeDraining sets/clears a node's drain flag, unscoped like SetNodeLabel
// (an admin action, works on any node regardless of owner type). Does not touch
// any other column: it takes the node out of (or back into) placement without
// affecting its existing files or download path.
func (s *SQLiteStore) SetNodeDraining(ctx context.Context, id string, on bool) error {
	res, err := s.db.ExecContext(ctx, `UPDATE nodes SET draining = ? WHERE id = ?`, b2i(on), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetNodeStorageReachable records a central→node blob-endpoint probe result.
// Unscoped like SetNodeDraining: it is infrastructure state, not user state.
//
// Deliberately NOT part of UpsertNode's ON CONFLICT set. The node re-registers
// every few seconds, so letting a heartbeat write this column would let a node
// whose blob port is shut clear its own mark and be handed the next upload
// anyway — which is the exact failure this column exists to stop.
func (s *SQLiteStore) SetNodeStorageReachable(ctx context.Context, id string, reachable bool, at int64) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET storage_unreachable = ?, storage_probed_at = ? WHERE id = ?`,
		b2i(!reachable), at, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// MarkNodeRemoved stamps a node as uninstalled. Conditional on removed_at=0 so
// the FIRST deregistration wins: the uninstaller retries nothing, but a
// re-issued curl (or a second uninstall attempt after a failed one) must not
// move the timestamp and rewrite when the machine actually went away. Nothing
// else on the row is touched — its files, limits and history stay readable for
// the admin panel.
func (s *SQLiteStore) MarkNodeRemoved(ctx context.Context, id string, at int64) error {
	res, err := s.db.ExecContext(ctx, `UPDATE nodes SET removed_at = ? WHERE id = ? AND removed_at = 0`, at, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// Either unknown, or already removed. Already-removed is a success (the
		// caller's goal is met), so distinguish the two with a read.
		if _, found, gerr := s.GetNode(ctx, id); gerr != nil {
			return gerr
		} else if !found {
			return ErrNotFound
		}
	}
	return nil
}

// ClearNodeRemoved puts a deregistered node back into service. Unconditional on
// the current value (unlike MarkNodeRemoved, which is first-write-wins) so that
// clearing an already-live node is a plain no-op success rather than an error
// the admin panel would have to explain. Touches nothing else: the node's
// files, limits, label and update history are exactly as it left them, which is
// the whole point of this existing instead of "delete the row and reinstall".
func (s *SQLiteStore) ClearNodeRemoved(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE nodes SET removed_at = 0 WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// CountFilesOnNode reports how many LIVE stored files (expires_at > now) sit
// on nodeID, plus the largest expires_at among them. "Live" mirrors
// CurrentStorage/GlobalStorageUsed: an expired-but-not-yet-collected row is
// excluded from both the count and the max (it would otherwise overstate how
// long an operator must wait), and a deleted file is never a concern here
// since stored_files rows are hard-deleted, not soft-deleted — DeleteStoredFile
// and the expiry-GC sweep both remove the row outright, so "already deleted"
// and "excluded by expires_at > now" cannot both apply to the same live row.
// COALESCE(MAX(...), 0) makes a node with nothing live report (0, 0), not NULL.
func (s *SQLiteStore) CountFilesOnNode(ctx context.Context, nodeID string, now int64) (count int, maxExpiresAt int64, err error) {
	err = s.reader().QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(MAX(expires_at), 0) FROM stored_files
		   WHERE node_id = ? AND expires_at > ?`, nodeID, now).Scan(&count, &maxExpiresAt)
	return count, maxExpiresAt, err
}

// NodeFileCounts is CountFilesOnNode for every node in one grouped query, so
// the admin nodes listing can render every row from a single read instead of
// one query per node. Same "live" definition as CountFilesOnNode. Nodes with
// no live files (or no files at all) are simply absent from the map.
func (s *SQLiteStore) NodeFileCounts(ctx context.Context, now int64) (map[string]NodeFileCount, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT node_id, COUNT(*), MAX(expires_at) FROM stored_files
		   WHERE expires_at > ? AND node_id IS NOT NULL AND node_id != ''
		   GROUP BY node_id`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]NodeFileCount)
	for rows.Next() {
		var id string
		var c NodeFileCount
		if err := rows.Scan(&id, &c.Count, &c.MaxExpiresAt); err != nil {
			return nil, err
		}
		out[id] = c
	}
	return out, rows.Err()
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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after a successful Commit

	res, err := tx.ExecContext(ctx, `DELETE FROM nodes WHERE id = ? AND owner_type = 'fleet'`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE node_id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
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
		var storageEnabled, draining, storageUnreachable int
		if err := rows.Scan(&n.ID, &n.OwnerType, &ownerUser, &n.Region, &urls, &n.TURNSecret,
			&n.Version, &n.RelayedBytes, &n.StoredBytes, &n.CreatedAt, &n.LastSeenAt,
			&storageURL, &storageSecret, &n.StorageFP, &storageEnabled, &n.StorageTotal, &n.StorageFree,
			&n.TrafficLimitBytes, &n.DiskLimitBytes, &n.Label, &n.DownloadURL,
			&n.UpdateStartedAt, &n.UpdateFromVersion, &n.UpdateResult, &n.UpdateAttempts, &draining,
			&n.RemovedAt, &n.ActiveTransfers, &storageUnreachable, &n.StorageProbedAt); err != nil {
			return nil, err
		}
		n.OwnerUserID = ownerUser.String
		n.StorageURL = storageURL.String
		n.StorageSecret = storageSecret.String
		n.StorageEnabled = storageEnabled != 0
		n.Draining = draining != 0
		n.StorageUnreachable = storageUnreachable != 0
		if err := json.Unmarshal([]byte(urls), &n.URLs); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// EnqueueNodeDelete records an orphaned blob-on-node delete for GC to retry,
// retirable as soon as one succeeds (not_before = 0).
func (s *SQLiteStore) EnqueueNodeDelete(ctx context.Context, blobKey, nodeID string, at int64) error {
	return enqueueNodeDeleteOn(ctx, s.db, blobKey, nodeID, at, 0)
}

// enqueueNodeDeleteOn is EnqueueNodeDelete's body against any executor, so a
// caller that must queue the responsibility INSIDE its own transaction — a pair
// room's close, which deletes the rows that would otherwise point at these blobs
// — cannot end up with the rows gone and the responsibility not written.
//
// The conflict clause keeps the STRONGER of the two holds and the EARLIER
// enqueue. Stronger, because a plain enqueue arriving after a void's held one
// must not shorten it into "retire on the first success" — that is exactly the
// window the hold exists for. Earlier, because enqueued_at is what the age
// eviction counts from, and re-queuing a key must not keep a permanently dead
// node's row alive forever by refreshing it.
func enqueueNodeDeleteOn(ctx context.Context, ex sqlExecer, blobKey, nodeID string, at, notBefore int64) error {
	_, err := ex.ExecContext(ctx,
		`INSERT INTO pending_node_deletes (blob_key, node_id, enqueued_at, not_before) VALUES (?,?,?,?)
		 ON CONFLICT(blob_key, node_id) DO UPDATE SET
		   not_before = max(pending_node_deletes.not_before, excluded.not_before)`,
		blobKey, nodeID, at, notBefore)
	return err
}

func (s *SQLiteStore) ListPendingNodeDeletes(ctx context.Context) ([]PendingNodeDelete, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT blob_key, node_id, enqueued_at, not_before, deleted_at,
		        bill_user_id, bill_kind, bill_max, billed_through
		   FROM pending_node_deletes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PendingNodeDelete
	for rows.Next() {
		var p PendingNodeDelete
		var kind int
		if err := rows.Scan(&p.BlobKey, &p.NodeID, &p.EnqueuedAt, &p.NotBefore, &p.DeletedAt,
			&p.BillUserID, &kind, &p.BillMax, &p.BilledThrough); err != nil {
			return nil, err
		}
		p.BillKind = UsageKind(kind)
		out = append(out, p)
	}
	return out, rows.Err()
}

// MarkPendingNodeDeleteDone stamps the FIRST delete that succeeded for a row
// that is still inside its hold.
//
// The stamp is what the age prune reads. Without it a row that is doing its job
// perfectly — blob gone, row held open only in case an in-flight append puts it
// back — is indistinguishable from a row whose node has never once answered, and
// evicting on age treats them the same. `deleted_at = 0` in the WHERE keeps the
// FIRST success, so a row cannot have its clock refreshed by every later sweep.
func (s *SQLiteStore) MarkPendingNodeDeleteDone(ctx context.Context, blobKey, nodeID string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE pending_node_deletes SET deleted_at = ?
		 WHERE blob_key = ? AND node_id = ? AND deleted_at = 0`, at, blobKey, nodeID)
	return err
}

func (s *SQLiteStore) DeletePendingNodeDelete(ctx context.Context, blobKey, nodeID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE blob_key=? AND node_id=?`, blobKey, nodeID)
	return err
}

// enqueueBilledNodeDeleteOn is enqueueNodeDeleteOn plus a billing obligation:
// the row records who must be billed for any bytes the blob turns out to hold
// past `billedThrough` (clamped to `billMax`) before those bytes may be
// destroyed. Only a pairing room's close calls it, inside the transaction that
// deletes the session rows — the obligation has to be durable BEFORE the
// session stops existing, or a database that starts refusing writes a moment
// later leaves the residual with no owner at all.
//
// The conflict clause keeps enqueueNodeDeleteOn's rules for the hold and the
// enqueue time, overwrites the obligation identity (the latest session close is
// the one that knows the user and the cap), and keeps the HIGHER billing floor —
// a floor is a record of money already durably accounted for, and re-queuing a
// key must never un-account it.
func enqueueBilledNodeDeleteOn(ctx context.Context, ex sqlExecer, blobKey, nodeID string, at, notBefore int64,
	billUserID string, billKind UsageKind, billMax, billedThrough int64) error {
	_, err := ex.ExecContext(ctx,
		`INSERT INTO pending_node_deletes
		   (blob_key, node_id, enqueued_at, not_before, bill_user_id, bill_kind, bill_max, billed_through)
		 VALUES (?,?,?,?,?,?,?,?)
		 ON CONFLICT(blob_key, node_id) DO UPDATE SET
		   not_before     = max(pending_node_deletes.not_before, excluded.not_before),
		   bill_user_id   = excluded.bill_user_id,
		   bill_kind      = excluded.bill_kind,
		   bill_max       = excluded.bill_max,
		   billed_through = max(pending_node_deletes.billed_through, excluded.billed_through)`,
		blobKey, nodeID, at, notBefore, billUserID, int(billKind), billMax, billedThrough)
	return err
}

// SettleBlobBilling atomically discharges the billing obligation a pending blob
// carries, up to `through` — the size the blob was just observed to hold,
// clamped again to the row's own bill_max because the observation came from a
// node that is free to lie. ONE TRANSACTION holds the meter increment and the
// floor advance: a crash between "billed" and "recorded as billed" is the exact
// double-charge this method exists to make impossible, and the monotonic floor
// (`through - billed_through`, never lowered) is what makes every retry — GC's,
// a void's, a late append's — idempotent against every other.
//
// (0, nil) when there is nothing to do: no row, no obligation, or a floor
// already at or past `through`.
func (s *SQLiteStore) SettleBlobBilling(ctx context.Context, blobKey, nodeID string, through, at int64) (int64, error) {
	return s.settleBlobBilling(ctx, blobKey, nodeID, through, at, "")
}

// JournalBlobBilling is the same discharge routed to the owed-bills outbox: for
// the moment the meter tables refuse writes but the plain unbilled_meter INSERT
// does not (see UnbilledMeter for why that asymmetry is real). The floor
// advances in the same transaction as the outbox INSERT, so exactly one durable
// record of the residual exists — the outbox row — and GC's SettleUnbilledMeter
// moves it onto the meter later without this row's floor ever re-owing it.
func (s *SQLiteStore) JournalBlobBilling(ctx context.Context, blobKey, nodeID string, through, at int64, reason string) (int64, error) {
	if reason == "" {
		reason = "journaled residual for blob " + blobKey
	}
	return s.settleBlobBilling(ctx, blobKey, nodeID, through, at, reason)
}

// settleBlobBilling is both discharges' shared body: journalReason == "" bills
// the meter directly, anything else writes the outbox row instead.
func (s *SQLiteStore) settleBlobBilling(ctx context.Context, blobKey, nodeID string, through, at int64, journalReason string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var userID string
	var kind int
	var billMax, floor int64
	err = tx.QueryRowContext(ctx,
		`SELECT bill_user_id, bill_kind, bill_max, billed_through
		   FROM pending_node_deletes WHERE blob_key = ? AND node_id = ?`,
		blobKey, nodeID).Scan(&userID, &kind, &billMax, &floor)
	if err == sql.ErrNoRows {
		return 0, nil // the responsibility (and so the obligation) no longer exists
	}
	if err != nil {
		return 0, err
	}
	if userID == "" {
		return 0, nil // deletion-only row
	}
	if billMax > 0 && through > billMax {
		through = billMax
	}
	owe := through - floor
	if owe <= 0 {
		return 0, nil
	}
	if journalReason == "" {
		if err := recordMeterOn(ctx, tx, userID, UsageKind(kind), owe, at); err != nil {
			return 0, err
		}
	} else {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO unbilled_meter (id, user_id, kind, bytes, at, reason) VALUES (?,?,?,?,?,?)`,
			authx.NewID(), userID, kind, owe, at, journalReason); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE pending_node_deletes SET billed_through = ? WHERE blob_key = ? AND node_id = ?`,
		through, blobKey, nodeID); err != nil {
		return 0, err
	}
	return owe, tx.Commit()
}

// RetirePendingNodeDeletes drops the orphan-retry rows that own nothing any
// more, and reports how many it dropped and how many OLD rows it deliberately
// kept.
//
// ONE REASON TO RETIRE, and age alone is never it: the delete has SUCCEEDED
// (deleted_at > 0) and the row is older than `before`. Such a row is a hold,
// not a responsibility — the bytes are gone and it stays only to catch a blob
// an in-flight append might put back (PendingNodeDelete.NotBefore).
// drainPending normally retires it the moment its hold passes; this is the
// backstop for the sweep where that DELETE itself failed.
//
// WHAT IT WILL NOT DO, because this is the bug it was written for: evict a row
// whose delete has NEVER succeeded — not for being old, not because the node it
// names has no row in `nodes`, and not because removed_at is set. That row is
// the only thing in the system that knows the blob exists — the stored_files
// row or session row it was created from is already deleted, which is why it
// was created — so dropping it does not clean anything up, it makes ciphertext
// permanently invisible AND permanently present. A node offline for a week is a
// node coming back on the eighth day.
//
// The node row being ABSENT is not read as terminal either. The one legitimate
// end of an undischarged row is the irreversible operator action — DeleteNode /
// DeleteFleetNode — and that transaction removes its own pending rows
// explicitly, in the same statement batch that drops the node. GC never infers
// that state: a row naming an id that is not in `nodes` may be a note written
// moments before the node's first registration lands, a restore in progress, or
// a delete transaction that half-applied — and in every one of those readings
// the safe answer is the same, keep the row. removed_at is likewise not read:
// deregistration is reversible (ClearNodeRemoved puts the machine back with its
// files intact), so a deregistered node's blobs are suspended, not orphaned.
//
// Every old row whose delete has never succeeded is counted in `retained`,
// whatever its node's registration state, so a queue that is not draining is
// visible rather than silent — the fix for a growing count is an operator
// bringing a node back or explicitly deleting it, never a timer.
func (s *SQLiteStore) RetirePendingNodeDeletes(ctx context.Context, before int64) (retired, retained int, err error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM pending_node_deletes WHERE deleted_at > 0 AND enqueued_at < ?`, before)
	if err != nil {
		return 0, 0, err
	}
	n, _ := res.RowsAffected()
	retired = int(n)
	err = s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pending_node_deletes WHERE deleted_at = 0 AND enqueued_at < ?`,
		before).Scan(&retained)
	return retired, retained, err
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
const deviceAuthCols = `user_code, device_code_hash, status, user_id, token_hash, created_at, expires_at, consumed_at, client_ip, user_agent, device_name, install_id`

func (s *SQLiteStore) CreateDeviceAuth(ctx context.Context, r DeviceAuthRequest) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO cli_device_auth (`+deviceAuthCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.UserCode, r.DeviceCodeHash, r.Status, r.UserID, r.TokenHash, r.CreatedAt, r.ExpiresAt, r.ConsumedAt, r.ClientIP, r.UserAgent, r.DeviceName, r.InstallID)
	return err
}

func scanDeviceAuth(sc rowScanner) (DeviceAuthRequest, error) {
	var r DeviceAuthRequest
	err := sc.Scan(&r.UserCode, &r.DeviceCodeHash, &r.Status, &r.UserID, &r.TokenHash,
		&r.CreatedAt, &r.ExpiresAt, &r.ConsumedAt, &r.ClientIP, &r.UserAgent, &r.DeviceName, &r.InstallID)
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

// ApproveAndRegisterDeviceAuth keeps the approval state, device identity and
// bearer rotation behind one commit. In particular, status='approved' and its
// pending_token cannot become visible to a poll before the matching cli_tokens
// row exists: SQLite readers see either the state before this transaction or
// all of it after commit.
func (s *SQLiteStore) ApproveAndRegisterDeviceAuth(ctx context.Context, userCode, userID, rawToken, newDeviceID string, at int64) (ApprovedDeviceAuth, Device, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ApprovedDeviceAuth{}, Device{}, false, err
	}
	defer tx.Rollback()

	var approved ApprovedDeviceAuth
	err = tx.QueryRowContext(ctx,
		`SELECT device_name, client_ip, install_id FROM cli_device_auth
		  WHERE user_code=? AND status='pending' AND expires_at > ?`, userCode, at).
		Scan(&approved.DeviceName, &approved.ClientIP, &approved.InstallID)
	if err == sql.ErrNoRows {
		return ApprovedDeviceAuth{}, Device{}, false, nil
	}
	if err != nil {
		return ApprovedDeviceAuth{}, Device{}, false, err
	}

	name := devicelabel.Sanitize(approved.DeviceName)
	if name == "" {
		name = devicelabel.Fallback
	}
	kind := "cli"
	if approved.InstallID != "" {
		// Only the native app owns an installation identity. Bodyless and legacy
		// device-code clients remain CLI; a current Mac must not be presented to
		// its owner as "Command line" merely because login is browser-delegated.
		kind = "app"
	}
	tokenHash := authx.HashToken(rawToken)
	device, err := registerApprovedDeviceTx(ctx, tx, ApprovedDeviceRegistration{
		UserID: userID, NewDeviceID: newDeviceID, Name: name, Kind: kind,
		InstallID: approved.InstallID, LastIP: canonicalDeviceIP(approved.ClientIP),
		TokenHash: tokenHash, At: at,
	})
	if err != nil {
		return ApprovedDeviceAuth{}, Device{}, false, err
	}

	res, err := tx.ExecContext(ctx,
		`UPDATE cli_device_auth SET status='approved', user_id=?, token_hash=?, pending_token=?
		  WHERE user_code=? AND status='pending' AND expires_at > ?`,
		userID, tokenHash, rawToken, userCode, at)
	if err != nil {
		return ApprovedDeviceAuth{}, Device{}, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return ApprovedDeviceAuth{}, Device{}, false, err
	}
	if n != 1 {
		return ApprovedDeviceAuth{}, Device{}, false, nil
	}
	if err := tx.Commit(); err != nil {
		return ApprovedDeviceAuth{}, Device{}, false, err
	}
	return approved, device, true, nil
}

// ConsumeDeviceAuth marks an approved request consumed exactly once and returns
// the raw one-time token, blanking pending_token so it never lingers at rest.
// The SELECT and UPDATE run in one transaction so a second concurrent caller
// racing the same codeHash either sees the row still approved/unconsumed (and
// wins) or already consumed (sql.ErrNoRows, ok=false) — never a torn read of a
// pending_token that's about to be blanked out from under it. The join to the
// live cli_tokens row also prevents an older, concurrently superseded approval
// from handing the client a bearer that a newer approval already revoked.
func (s *SQLiteStore) ConsumeDeviceAuth(ctx context.Context, codeHash string, at int64) (string, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	var raw string
	err = tx.QueryRowContext(ctx,
		`SELECT a.pending_token FROM cli_device_auth a
		  JOIN cli_tokens t ON t.token_hash = a.token_hash AND t.user_id = a.user_id
		  WHERE a.device_code_hash=? AND a.status='approved' AND a.consumed_at=0`, codeHash).Scan(&raw)
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

func (s *SQLiteStore) TouchCLIToken(ctx context.Context, tokenHash string, at int64, clientIP string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`UPDATE cli_tokens SET last_seen_at = ? WHERE token_hash = ?`, at, tokenHash); err != nil {
		return err
	}
	// Keep the account-facing device row useful too. Previously only the token
	// row was touched, so My Devices truthfully but unhelpfully said “Never
	// used” forever. A blank/invalid IP must not erase the last good hint.
	if _, err := tx.ExecContext(ctx, `UPDATE devices
		SET last_seen_at = ?, last_ip = CASE WHEN ? <> '' THEN ? ELSE last_ip END
		WHERE id = (SELECT device_id FROM cli_tokens WHERE token_hash = ?)`,
		at, clientIP, clientIP, tokenHash); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteCLIToken revokes exactly one bearer credential. Logout uses the hash
// of the presented token, so signing out one CLI/native device does not revoke
// the user's other devices.
func (s *SQLiteStore) DeleteCLIToken(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM cli_tokens WHERE token_hash = ?`, tokenHash)
	return err
}

func (s *SQLiteStore) ListAdminCredentials(ctx context.Context) ([]AdminCredential, error) {
	rows, err := s.db.QueryContext(ctx, `
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

// CountAdminCredentials counts rows without touching cred_json. The login page
// renders this on every unauthenticated GET /admin, so reading credential
// material just to take its length would let anyone drive repeated full reads
// of it into memory.
func (s *SQLiteStore) CountAdminCredentials(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM admin_credentials`).Scan(&n)
	return n, err
}

func (s *SQLiteStore) GetAdminCredential(ctx context.Context, id string) (AdminCredential, bool, error) {
	var c AdminCredential
	err := s.db.QueryRowContext(ctx, `
SELECT id, user_handle, cred_json, name, created_at, last_used_at
FROM admin_credentials WHERE id = ?`, id).
		Scan(&c.ID, &c.UserHandle, &c.CredJSON, &c.Name, &c.CreatedAt, &c.LastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminCredential{}, false, nil
	}
	if err != nil {
		return AdminCredential{}, false, err
	}
	return c, true, nil
}

func (s *SQLiteStore) InsertAdminCredential(ctx context.Context, c AdminCredential) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO admin_credentials (id, user_handle, cred_json, name, created_at, last_used_at)
VALUES (?, ?, ?, ?, ?, ?)`,
		c.ID, c.UserHandle, c.CredJSON, c.Name, c.CreatedAt, c.LastUsedAt)
	return err
}

func (s *SQLiteStore) TouchAdminCredential(ctx context.Context, id string, credJSON []byte, lastUsedAt int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE admin_credentials SET cred_json = ?, last_used_at = ? WHERE id = ?`,
		credJSON, lastUsedAt, id)
	return err
}

func (s *SQLiteStore) DeleteAdminCredential(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM admin_credentials WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) AdminUserHandle(ctx context.Context) ([]byte, bool, error) {
	var h []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT user_handle FROM admin_credentials ORDER BY created_at, id LIMIT 1`).Scan(&h)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return h, true, nil
}

func (s *SQLiteStore) InsertAudit(ctx context.Context, e AuditEntry) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO admin_audit (at, actor, ip, auth, action, target, changes, step_up)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		e.At, e.Actor, e.IP, e.Auth, e.Action, e.Target, e.Changes, e.StepUp)
	return err
}

func (s *SQLiteStore) ListAudit(ctx context.Context, limit, offset int, action string) ([]AuditEntry, error) {
	q := `SELECT id, at, actor, ip, auth, action, target, changes, step_up
	        FROM admin_audit`
	args := []any{}
	if action != "" {
		q += ` WHERE action = ?`
		args = append(args, action)
	}
	// id 作为次级排序键：同一秒内写入的多条记录（一次表单提交可能连着写）
	// 否则顺序不确定，分页会重复或漏行。
	q += ` ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.At, &e.Actor, &e.IP, &e.Auth,
			&e.Action, &e.Target, &e.Changes, &e.StepUp); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// PruneAudit deletes audit rows older than `before`. Age-based, exactly like
// PruneUploadEvents / PruneDownloadReceipts; the retention window itself lives
// in gc.go (auditRetentionDefault) because that is where every other retention
// knob is defined.
func (s *SQLiteStore) PruneAudit(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM admin_audit WHERE at < ?`, before)
	return err
}

// PruneNodeAudit keeps only the newest `keep` MACHINE-written audit rows and
// deletes the rest.
//
// This is the burst bound that an age-based prune cannot provide: a node-token
// holder looping register→deregister writes one node.deregister row per
// iteration — each one a genuine state transition, so the "only audit a real
// change" guard in handleNodeDeregister does not stop it — and
// /api/nodes/register has no rate limit. Age retention alone therefore leaves
// the table unbounded WITHIN the window.
//
// Machine rows are identified by auth = nodeAuditAuth ('node-token'), the
// actual authentication that produced the row, not by `actor LIKE 'node:%'`.
// The actor string is a formatted display value and an operator could in
// principle create an admin username that matches the pattern; `auth` is set
// by writeNodeAudit alone and is not operator-influenced, so it cannot be made
// to point the eviction at human rows.
//
// Scoped to machine rows on purpose. Evicting rows is destroying evidence, so
// the ceiling is applied only to the writer bounded ELSEWHERE ONLY BY AGE, and
// never to admin/human rows: no flood of machine traffic can push a single
// "who changed this setting" entry out of the trail.
//
// There are in fact two writers an unauthenticated party can drive at will,
// not one, and they are bounded differently:
//   - node-token registrations (this cap): no rate limit on
//     /api/nodes/register, one row per register/deregister call, unbounded
//     within the two-year age window without this cap.
//   - failed admin logins (handleAdminLogin's AuditLoginFail, auth=""): every
//     wrong password writes a row too, and that row is NOT auth=nodeAuditAuth
//     so this cap does not touch it. It is bounded only by (a) the
//     Service.adminLogins per-IP lockout (loginThrottle), which throttles the
//     RATE from one source but does not cap the total from many source IPs,
//     and (b) the two-year age prune
//     (PruneAudit), the same blunt bound every other row in the table has.
//     A distributed flood of login attempts is therefore still only
//     age-bounded, not row-capped, same as it was before this branch.
//
// The cost of the machine-row bound is that under a real flood the OLDEST
// machine rows are lost while the flood's own rows are kept — accepted
// because the alternative (keep oldest) would silently stop recording
// legitimate deregistrations forever once the ceiling was reached.
//
// COST IN THE STEADY STATE, which is the case that runs forever: an earlier
// version ran one unconditional statement that materialised up to `keep` ids
// into a NOT IN list and full-scanned admin_audit inside a write transaction —
//
//	SCAN admin_audit
//	LIST SUBQUERY 1
//	  SCAN admin_audit USING INDEX idx_admin_audit_at
//	  USE TEMP B-TREE FOR LAST TERM OF ORDER BY
//
// — every 10 minutes, whether or not anything was over the cap. It now starts
// with a count over idx_admin_audit_machine (an equality seek on auth, then a
// covering walk of only the machine rows) and returns immediately when the cap
// is not exceeded, which is every sweep of a healthy deployment. Only when it
// IS exceeded does it read the boundary row and delete by (at, id) range —
// still index-driven, and with no 100k-element IN list.
//
// keep <= 0 is treated as "no cap" rather than "delete everything": a
// misconfigured knob must not wipe the audit trail.
//
// pruneNodeAuditPrecheckQuery is the exact statement the pre-check below
// issues, factored out to one definition so a test can EXPLAIN QUERY PLAN the
// literal PruneNodeAudit actually runs instead of a hand-copied duplicate that
// could silently drift from it.
const pruneNodeAuditPrecheckQuery = `SELECT COUNT(*) FROM admin_audit WHERE auth = ?`

// pruneNodeAuditBoundaryRuns counts how many times PruneNodeAudit has gone
// past the pre-check to run the boundary-row query. It exists ONLY so a test
// can prove the pre-check actually short-circuits an under-cap sweep: the row
// OUTCOME of an under-cap sweep is identical whether the pre-check runs or is
// deleted entirely (the boundary query's OFFSET keep-1 also finds no row on a
// table shorter than keep, so it also returns nil) — a row-count assertion
// alone cannot tell "the pre-check ran and skipped the expensive path" from
// "there is no pre-check, and the expensive path happened to be a no-op
// anyway". This counter is the only thing that tells the two apart. Never
// read in production; incremented unconditionally (a plain int64, not behind
// a build tag) because the package's tests are not run with t.Parallel, so a
// package-level counter needs no synchronization beyond atomicity against a
// future parallel test.
var pruneNodeAuditBoundaryRuns int64

func (s *SQLiteStore) PruneNodeAudit(ctx context.Context, keep int) error {
	if keep <= 0 {
		return nil
	}
	// Cheap pre-check: the no-op case must not pay for the delete.
	var n int64
	if err := s.reader().QueryRowContext(ctx,
		pruneNodeAuditPrecheckQuery, nodeAuditAuth).Scan(&n); err != nil {
		return err
	}
	if n <= int64(keep) {
		return nil
	}
	atomic.AddInt64(&pruneNodeAuditBoundaryRuns, 1)
	// The keep-th newest machine row is the boundary; everything strictly
	// older than it goes. Ordering matches the index's own (at DESC, id DESC),
	// so this is a seek + skip, not a sort.
	var bAt, bID int64
	if err := s.reader().QueryRowContext(ctx,
		`SELECT at, id FROM admin_audit WHERE auth = ?
		  ORDER BY at DESC, id DESC LIMIT 1 OFFSET ?`, nodeAuditAuth, keep-1).Scan(&bAt, &bID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil // raced with another deleter; nothing to do
		}
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM admin_audit
		   WHERE auth = ? AND (at < ? OR (at = ? AND id < ?))`, nodeAuditAuth, bAt, bAt, bID)
	return err
}
