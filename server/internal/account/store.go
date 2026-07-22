package account

import (
	"context"
	"errors"
)

// ErrNotFound is returned by Store methods when a requested row does not exist.
// Callers depend on this sentinel rather than any storage-specific error, so a
// Postgres swap need only touch sqlite.go.
var ErrNotFound = errors.New("account: not found")

// User is an account holder. PII is limited to email + display name.
type User struct {
	ID            string
	Email         string
	DisplayName   string
	CreatedAt     int64
	EmailVerified bool
	// OnlyOwnNodes restricts this user's transfers to their own self-hosted
	// nodes (SP3 BYO nodes), excluding the shared fleet.
	OnlyOwnNodes bool
	// DeletedAt is when the user requested account deletion (unix seconds);
	// 0 = active account, not scheduled for deletion.
	DeletedAt int64
	// PurgeAfter is when GC may hard-delete this account and its data (unix
	// seconds); 0 = not scheduled. Set alongside DeletedAt with a grace period.
	PurgeAfter int64
	// PlanID is the user's billing tier (plans.id); defaults to "free".
	PlanID string
	// StripeCustomerID is this user's Stripe customer id, set on first
	// checkout; '' = no Stripe customer yet.
	StripeCustomerID string
	// StripeSubscriptionID is the CANONICAL subscription id (the earliest one the
	// user holds). The webhook uses it to dedup a double-checkout: an event for a
	// DIFFERENT id triggers a reconcile (keep earliest, cancel+refund the rest);
	// an event matching it takes the normal per-event path with no Stripe call.
	// '' = no subscription recorded yet.
	StripeSubscriptionID string
	// SubscriptionStatus mirrors the Stripe subscription status ('', 'active',
	// 'canceled', 'past_due', ...); '' = no subscription on record.
	SubscriptionStatus string
	// SubscriptionEnd is the current subscription period's end (unix seconds);
	// 0 = no subscription on record.
	SubscriptionEnd int64
	// PlanSource records who last set PlanID: '' (default/free), 'admin'
	// (manual comp — a Stripe webhook must not override it), or 'stripe'.
	PlanSource string
	// ScheduledPlanID is the tier a pending period-end downgrade will switch to;
	// '' = no pending change. Display hint only (see the column comment).
	ScheduledPlanID string
	// ScheduledCycle is the billing cycle ('monthly'|'yearly') that pending
	// downgrade switches to, stored next to ScheduledPlanID so a same-tier cycle
	// downgrade can be told apart from "already landed". '' = legacy (predates the
	// column) → clear falls back to tier-only matching. See handleStripeWebhook.
	ScheduledCycle string
	// BillingCycle is 'monthly' or 'yearly' for a Stripe-sourced subscription;
	// '' means unknown (a row that predates the column). Treat '' as "cannot
	// compare cycles" rather than as a third cycle — see handleBillingChangePlan.
	BillingCycle string
	// PlanStartedAt 是当前档位生效的时刻（unix 秒）；0 表示从未改过档。
	// 与 QuotaAccrued* 一起把当月切成若干"档位段"，用来给月中改档的用户按段
	// 计算流量上限，而不是每次改档都白送一整个月的额度。
	PlanStartedAt int64
	// QuotaAccruedBytes 是本月 PlanStartedAt 之前那些已结束的段累计下来的流量
	// 额度（每段 = 该段档位上限 × 该段占全月的比例）。
	QuotaAccruedBytes int64
	// QuotaAccruedPeriod 是 QuotaAccruedBytes 所属的 'YYYYMM' 桶。与当前月份不
	// 符即视为过期作废，用户直接拿当前档的整月上限——这也让存量用户（三列全为
	// 零值）天然走满额分支，无需回填。
	QuotaAccruedPeriod string
}

// Plan is an admin-configurable billing tier: per-account storage + monthly
// traffic caps and a staged-file retention ceiling. Prices are US cents.
type Plan struct {
	ID            string
	Name          string
	StorageBytes  int64
	TrafficBytes  int64
	RetentionSecs int64
	PriceMonthly  int64
	PriceYearly   int64
	SortOrder     int64
	Active        bool
	UpdatedAt     int64
	// StripePriceMonthlyID/StripePriceYearlyID are the Stripe Price ids for
	// this tier's monthly/yearly billing cycle; '' = that cycle isn't
	// purchasable via Stripe (e.g. the free tier, or an unmapped price).
	StripePriceMonthlyID string
	StripePriceYearlyID  string
	// DailyQuotaBytes 是该档每 24 小时的上传额度；<= 0 表示回落到全局
	// SettingDailyQuota。存量 plans 行的该列默认 0，因此迁移后行为不变。
	DailyQuotaBytes int64
}

// Identity links an external auth subject (google sub, or the email itself) to a user.
type Identity struct {
	Provider string // "google" | "email"
	Subject  string
	UserID   string
}

// Session is a server-side login session referenced by an httpOnly cookie.
type Session struct {
	ID        string
	UserID    string
	CreatedAt int64
	ExpiresAt int64
	Revoked   bool
}

// MagicToken is a one-time email login token. Only its hash is stored.
type MagicToken struct {
	TokenHash string
	Email     string
	CreatedAt int64
	ExpiresAt int64
	UsedAt    int64 // 0 = unused
}

// EmailToken is a one-time verification or password-reset token. Only its hash
// is stored. Purpose is "verify" or "reset".
type EmailToken struct {
	TokenHash string
	UserID    string
	Email     string
	Purpose   string
	CreatedAt int64
	ExpiresAt int64
	UsedAt    int64 // 0 = unused
}

// Device is a browser (later: a CLI) registered under a user. Static registry only;
// online presence/rendezvous belongs to the cross-network spec, not here.
type Device struct {
	ID         string
	UserID     string
	Name       string
	CreatedAt  int64
	LastSeenAt int64
	// Kind distinguishes the device's platform: "" / "browser" (default) or
	// "cli" for a device registered via the device-code CLI login flow.
	Kind string
}

// DeviceAuthRequest is one device-code CLI login flow request (RFC 8628-style).
// Status transitions pending -> approved -> consumed exactly once each; denied
// is a terminal dead end. TokenHash is the hash of the CLI bearer token minted
// on approval; PendingToken (DB-only, not exposed on this struct) transiently
// holds the raw token between approve and the CLI's next poll, then is blanked.
type DeviceAuthRequest struct {
	UserCode       string // short code shown to the user (e.g. "WDJB-MJHT")
	DeviceCodeHash string // hash of the long-lived code the CLI polls with
	Status         string // "pending" | "approved" | "denied"
	UserID         string // set on approval
	TokenHash      string // hash of the minted CLI token, set on approval
	CreatedAt      int64
	ExpiresAt      int64
	ConsumedAt     int64  // 0 = not yet consumed
	ClientIP       string // origin of the CLI that started the flow (for the approval page)
	UserAgent      string // CLI's User-Agent, truncated
}

// CLIToken is a long-lived hashed bearer credential minted at the end of a
// device-code CLI login flow. Only its hash is stored; the raw token is shown
// to the CLI once (via ConsumeDeviceAuth's pending_token handoff).
type CLIToken struct {
	TokenHash  string
	UserID     string
	DeviceID   string
	CreatedAt  int64
	LastSeenAt int64
}

// UsageEvent is one coturn allocation's relay accounting. Recorded unattributed
// (empty UserID) since pairing codes are anonymous; kept for global relay
// accounting.
type UsageEvent struct {
	AllocID      string
	Token        string
	UserID       string
	RelayedBytes int64
	RecordedAt   int64
	NodeID       string
	Billable     bool
}

// UploadSessionRow is the durable state of one in-progress chunked upload
// (item #9). The live blob handle is NOT stored — it is reconstructed from
// NodeID per request via blobFor; the DB replaces the per-session mutex.
type UploadSessionRow struct {
	ID          string
	UserID      string
	BlobKey     string
	NodeID      string
	Billable    bool
	EncManifest []byte
	TTL         int64
	MaxDL       int64
	MaxSize     int64 // write cap fixed at init (see sessionWriteCap)
	Received    int64 // bytes committed to the blob so far
	CreatedAt   int64
	Done        bool
}

// StoredFile is one zero-knowledge stored-transfer object's lifecycle row. The
// server holds only ciphertext: EncManifest (encrypted filenames/sizes) and the
// blob it points at are opaque. It never sees plaintext content, names, or the key.
type StoredFile struct {
	ID            string
	UserID        string
	BlobKey       string
	EncManifest   []byte
	Size          int64 // ciphertext byte count
	BurnAfterRead bool
	CreatedAt     int64
	ExpiresAt     int64
	DownloadedAt  int64  // 0 = not yet downloaded
	DownloadCount int64  // lifetime successful downloads of this file (non-burn)
	NodeID        string // "" = central-local blob; else the relay node holding the ciphertext
	// MaxDownloads generalizes BurnAfterRead: 0 = unlimited until TTL; N = delete
	// after the Nth successful download; 1 = burn-equivalent. BurnAfterRead is
	// kept for back-compat, but runtime logic is driven off MaxDownloads.
	MaxDownloads int64
}

// UsageKind selects which per-month meter a RecordMeter call increments.
type UsageKind int

const (
	MeterUpload UsageKind = iota
	MeterDownload
)

// UserStats are a user's lifetime aggregate counters for the personal center /
// future metering. Monotonic (never decremented), survive file expiry/GC, and
// carry no per-event metadata (no timestamps, no downloader identity).
type UserStats struct {
	TransfersTotal int64 // stored download-links created (one per upload)
	DownloadsTotal int64 // successful downloads of this user's files (each fetch)
	UploadBytes    int64 // ciphertext bytes uploaded
	DownloadBytes  int64 // ciphertext bytes delivered to downloaders
}

// UploadEvent is an immutable ledger row for the rolling-24h upload quota. It is
// independent of StoredFile lifecycle: a file may be burned/expired and deleted,
// but the day's quota still counts. GC prunes rows older than ~25h.
type UploadEvent struct {
	ID         string
	UserID     string
	Bytes      int64
	UploadedAt int64
}

// Node is one registered relay node (SP1: fleet-owned pion/turn relay). urls are
// the node's turn: URLs; turn_secret is its static-auth-secret (so /api/ice can
// mint ephemeral credentials it will validate). relayed_bytes/stored_bytes are the
// node's own cumulative, keep-max counters fed from heartbeats.
type Node struct {
	ID            string
	OwnerType     string // "fleet" (SP3 adds "user")
	OwnerUserID   string // "" for fleet
	Label         string // human-set display name / note; seeded from the node token's name, editable
	Region        string
	URLs          []string
	TURNSecret    string
	Version       string
	RelayedBytes  int64
	StoredBytes   int64
	CreatedAt     int64
	LastSeenAt    int64
	StorageURL    string
	StorageSecret string
	// StorageFP is the SHA-256 fingerprint (hex) of the node's self-signed TLS
	// cert for its blob endpoint, reported at registration. When set (and the
	// StorageURL is https), central pins it on every blob call so the bearer
	// secret and blob traffic can't be sniffed/tampered on-path. Empty for legacy
	// http nodes not yet redeployed.
	StorageFP      string
	StorageEnabled bool
	StorageTotal   int64
	StorageFree    int64
	// Admin-set hard caps for official (fleet) nodes; 0 = unlimited. TrafficLimit
	// is a monthly relay-bytes cap enforced in handleICE; DiskLimit caps stored
	// bytes and is enforced in StorageNodes placement.
	TrafficLimitBytes int64
	DiskLimitBytes    int64
	// DownloadURL is the node's PUBLIC base URL for direct client downloads (e.g.
	// https://node3.relayium.com), distinct from StorageURL (central's internal,
	// bearer-authed blob API). When set, central can 302 a client straight to
	// <DownloadURL>/dl/{key}?t=<token> so the bytes bypass central. '' = no direct
	// download; central proxies as before. Reported by the node at registration.
	DownloadURL string
	// UpdateStartedAt is when central last commanded this node to self-update
	// (unix seconds); 0 = no update in flight. The Part 2 rollout state machine
	// uses it to notice a node that never came back (timeout past its expected
	// self-update duration signals a stuck/failed update). Set by the rollout
	// state machine, NOT by node register/heartbeat — UpsertNode must never
	// overwrite it on a routine re-register (see the ON CONFLICT clause).
	UpdateStartedAt int64
	// UpdateFromVersion is the version this node was running when the update was
	// commanded, kept so a rollback target is known even after Version has
	// already changed (or the update failed partway through).
	UpdateFromVersion string
	// UpdateResult is the outcome the node last reported for a commanded
	// self-update: "" (none in flight / never asked), "ok", or "failed".
	UpdateResult string
	// UpdateAttempts used to count how many times central had told this node to
	// RESUME the update it already holds the claim for, bounding the fleet
	// resume path in handleUpdateCheck by POLL COUNT. That bound was
	// cadence-dependent (the poll interval is entirely client-side) so it has
	// been replaced by an elapsed-wall-clock check against UpdateStartedAt
	// (see updateSilenceLimit). Nothing writes this column anymore; it is kept
	// rather than dropped, per the package's schema-migration policy, and
	// simply reads 0 forever on both existing and new rows.
	UpdateAttempts int
	// Draining marks a node as being wound down for safe removal: it stays OUT
	// of the placement pool (StorageNodes/UserStorageNodes exclude it) so no new
	// file lands on it, but it keeps serving the files it already holds — those
	// still need to reach their TTL, since a file binds to exactly one node and
	// there are no replicas. Set only by an operator (SetNodeDraining), never by
	// register/heartbeat: UpsertNode's ON CONFLICT clause deliberately omits
	// this column so a node re-registering can't silently clear the flag out
	// from under an operator mid-drain.
	Draining bool
	// RemovedAt is when the node told central it was being uninstalled (unix
	// seconds); 0 = still installed. The row is KEPT rather than deleted so the
	// admin panel and audit trail still explain where a file's node went, but a
	// removed node is out of the placement pool, out of the ICE candidate list
	// and never receives a download redirect — the machine is gone, so pointing
	// anyone at it only produces a dead origin.
	//
	// Deliberately sticky: nothing clears it, not even a later re-register. The
	// uninstaller deregisters BEFORE it stops the service, so a dying node could
	// otherwise race a register and resurrect itself. A genuinely reinstalled
	// machine gets a fresh state.json (the uninstaller removes the state dir)
	// and therefore a new node ID, so it never needs the flag cleared.
	RemovedAt int64
	// ActiveTransfers is how many relay allocations this node was serving as of
	// its last heartbeat — a live gauge, not a total. It is the ONLY load signal
	// central has about a node, and it exists for one consumer: decideFleet's
	// canary pick, which gives the new build to the least-busy machine first
	// because that machine has the least to lose if the build is bad.
	//
	// Reported by the node as heartbeatBody.activeTransfers and written only by
	// TouchNode. It is a COUNT OF LIVE ALLOCATIONS, deliberately not len(usage):
	// the usage array skips allocations that have not yet joined a username and
	// includes ones that closed since the last heartbeat (they are reported one
	// final time so their bytes flush), so it answers "seen since the last
	// heartbeat", which is a different question.
	//
	// 0 means "no load signal", not "idle": a node running a binary older than
	// the field sends nothing and reads 0 forever. That is safe — decideFleet
	// falls back to its deterministic fleetHash order on ties — but it does mean
	// an un-upgraded node looks maximally idle, so during a mixed-version window
	// the canary can land on one. That is the same behaviour the whole fleet had
	// before this field existed.
	ActiveTransfers int
}

// NodeFileCount is a node's live-file footprint, as returned by
// CountFilesOnNode / NodeFileCounts: how many stored files still sit on it,
// and the furthest-out ExpiresAt among them — the earliest moment it is safe
// to uninstall. The zero value (both fields 0) is exactly "holds nothing,
// safe now", which is also what a node absent from NodeFileCounts' map means.
type NodeFileCount struct {
	Count        int
	MaxExpiresAt int64
}

// NodeToken is a per-user credential a BYO node presents as its bearer. The
// plaintext is shown once at mint; only its sha256 hash is stored. Binding to a
// node_id links it for per-node revoke/delete.
type NodeToken struct {
	ID         string
	TokenHash  string
	UserID     string
	NodeID     string
	Name       string
	CreatedAt  int64
	LastUsedAt int64
	RevokedAt  int64
}

// FleetToken is an admin-minted, userless bearer credential an official (fleet)
// node presents at register/heartbeat. Unlike NodeToken it has no owning user,
// so it lives in its own table rather than node_tokens (whose user_id is NOT
// NULL). Plaintext is shown once at mint; only its sha256 hash is stored.
type FleetToken struct {
	ID         string
	TokenHash  string
	Name       string
	NodeID     string
	CreatedAt  int64
	LastUsedAt int64
	RevokedAt  int64
}

// PendingNodeDelete is a blob whose owning node was unreachable when its file
// expired/was deleted; GC retries the node DELETE each sweep until it succeeds,
// reclaiming the orphan under the no-replication model.
type PendingNodeDelete struct {
	BlobKey    string
	NodeID     string
	EnqueuedAt int64
}

// RolloutTrack is the persisted state of one automatic node-update rollout
// track ("fleet" or "byo"). This is the ONLY thing Part 1's per-node
// `relayium-node update -to` subcommand doesn't decide for itself: which node
// updates to which version, when.
//
// There are always exactly two independent rows, keyed by Track, and this is
// deliberate: the fleet (our ~16 official nodes) and byo (unbounded
// user-owned nodes) tracks must be able to hold DIFFERENT TargetVersions and
// DIFFERENT Statuses at the same time. A stalled or halted BYO rollout (users'
// nodes are out of our control — one could be offline, pinned to an old
// binary, whatever) must never block shipping the next release to our own
// fleet. Collapsing this into a single row would silently destroy that
// property, so don't "simplify" it that way.
type RolloutTrack struct {
	Track string // "fleet" | "byo"
	// TargetVersion is the version this track is currently rolling out to.
	TargetVersion string
	// PreviousVersion is the target this track held immediately BEFORE
	// TargetVersion, and it is the only version Service.RollbackByoToPreviousVersion
	// will point the byo track at. It is written on the byo track only, by the
	// same chokepoint that changes a target, so its invariant is exact: every
	// value that ever lands here passed the byo-behind-fleet gate at the moment
	// it was set (or is a version this track was already rolled back onto,
	// which passed it earlier for the same reason). That is what makes the
	// rollback path safe to run without re-consulting the gate — it can never
	// name a version the fleet has not vetted. '' means "no history": the
	// track is on its first target and there is nothing to roll back to.
	PreviousVersion string
	// CurrentNodeID is the fleet node presently being updated (fleet track
	// only; fleet nodes are updated one at a time). Unused for byo.
	CurrentNodeID string
	// ByoBatch is the batch size in flight for the byo track (10 | 50 | 100
	// nodes at once). Unused for fleet.
	ByoBatch int
	// FirstNodeID is the node that was picked FIRST in the current rollout —
	// the canary that gets the long (6h) observation window. It is recorded
	// positionally, when the rollout picks its first node (decideFleet reports
	// this via RolloutDecision.IsFirst), and must NOT be re-derived from fleet
	// version state: "no other node is on target" is false for a freshly
	// provisioned node already shipping the new build, a hand-updated node, or
	// a resumed rollout, and every one of those would silently cut the canary
	// window to 30min. Cleared when a new rollout starts. Fleet track only.
	FirstNodeID string
	// StageStartedAt is when the current stage (this node / this batch) began
	// (unix seconds), for the state machine's timeout check. It MUST be
	// rewritten on EVERY stage transition (each time CurrentNodeID / ByoBatch
	// changes): decideFleet measures the observation window from it, so a value
	// left over from the previous stage would expire the next node's window
	// early. decideFleet defends against that by taking the later of this and
	// the node's own UpdateStartedAt, but that defence is a backstop, not a
	// licence to leave the field stale.
	StageStartedAt int64
	Status         string // "rolling" | "halted" | "complete"
	// HaltedReason is a human-readable note on why Status == "halted" (e.g. a
	// heartbeat timeout or an elevated post-update failure rate). '' otherwise.
	HaltedReason string
	// Emergency releases the WHOLE track at once: while it is set, the update
	// check bypasses the staged ladder entirely (the fleet's one-node-at-a-time
	// queue with its 6h canary window, and the byo 10/50/100 batches) and tells
	// every node of the track that is behind the target to update on its next
	// poll. It is set ONLY by the admin emergency-release action, which is
	// step-up confirmed and audited, and it is cleared by every other way a
	// track's state is written — SetTargetVersion's whole-row replace and
	// ResumeRolloutTrack both put the track back on the staged ladder — so a
	// track can never be left in emergency mode by accident.
	//
	// It deliberately gives up the failure gating that goes with staging: an
	// emergency release ships to everyone at once, so there is no canary left
	// whose failure could stop it. The admin's 暂停 (pause) control is the kill
	// switch, since a track that is not 'rolling' is inert on every path.
	Emergency bool
}

// Setting is one admin-editable integer config value (bytes or seconds).
type Setting struct {
	Key       string
	Value     int64
	UpdatedAt int64
}

// AdminUserRow 是后台用户列表的一行聚合视图（只读）。
type AdminUserRow struct {
	ID            string
	Email         string
	DisplayName   string
	CreatedAt     int64
	Methods       []string // identities 表里的 provider 去重升序
	DeviceCount   int
	RelayedBytes  int64  // 选定月的中继流量（来自 usage_events）
	UploadBytes   int64  // 选定月上传（usage_monthly）
	DownloadBytes int64  // 选定月下载（usage_monthly）
	StorageBytes  int64  // 当前存储占用（未过期文件 size 之和，与月份无关）
	PlanID        string // 当前套餐（plans.id）
	// SubscriptionStatus mirrors users.subscription_status ('' when there is
	// no active Stripe subscription). PlanSource mirrors users.plan_source
	// ('' default/free, 'admin' manual comp, 'stripe' webhook-assigned).
	SubscriptionStatus string
	PlanSource         string
}

// AdminUserQuery 参数化后台用户列表查询。
type AdminUserQuery struct {
	Search  string // 空 = 不过滤;非空按 email/display_name 模糊匹配
	SortBy  string // "created"|"email"|"relayed"|"upload"|"download"|"storage";非法回退 "created"
	SortDir string // "asc"|"desc";非法回退 "desc"
	Period  string // 'YYYYMM'，决定上传/下载/中继列的口径
	Now     int64  // 用于存储占用的"未过期"判定
	Limit   int
	Offset  int
}

// AdminMetrics 是后台首页的快照指标。存储/用户/文件为当前快照;上传/下载/中继为选定月合计。
type AdminMetrics struct {
	TotalUsers        int64
	ActiveStoredFiles int64 // 未过期暂存文件数(expires_at > now)
	ActiveStoredBytes int64 // 上述文件 size 之和(近似当前磁盘占用)
	UploadBytes       int64 // 选定月上传合计
	DownloadBytes     int64 // 选定月下载合计
	RelayBytes        int64 // 选定月中继合计
}

// AdminCredential is one registered admin passkey. CredJSON holds the full
// webauthn.Credential record (public key, sign counter, flags, transports,
// attestation) as JSON: the library requires the whole record be preserved and
// written back after each successful login, so it is not split into columns.
// UserHandle is the WebAuthn user ID, identical across all rows and
// deliberately decoupled from RELAYIUM_ADMIN_USER so renaming the admin does
// not silently invalidate every registered passkey.
type AdminCredential struct {
	ID         string
	UserHandle []byte
	CredJSON   []byte
	Name       string
	CreatedAt  int64
	LastUsedAt int64
}

// AuditEntry 是一条管理员操作记录。永久保留，不参与 GC。
//
// Auth 与 StepUp 是两个不同的维度：Auth 是**建立当前会话**时用的登录方式，
// StepUp 是**这一次操作**实际验的第二因子。用 passkey 登录、用 TOTP 步进是
// 完全正常的组合，合并成一列就再也还原不出当时发生了什么。
type AuditEntry struct {
	ID     int64
	At     int64
	Actor  string
	IP     string
	Auth   string // "password" | "passkey"
	Action string
	Target string
	// Changes 是 []ChangeField 的 JSON。存**存储层原始值**（bytes/secs），
	// 不存表单里的 MB/GB/天 —— 单位混用会让日志和库里的实际值对不上。
	Changes string
	// StepUp: "" = 该操作无需步进；"grace" = 落在 60 秒宽限期内跳过了因子校验。
	// grace 必须单独标记而不是记成验过了，否则日志会在最要紧的地方说谎。
	StepUp string
}

// Store is the only abstraction that touches persistent storage. Implemented by
// SQLiteStore today; a Postgres impl could replace it without changing callers.
type Store interface {
	// users + identities
	UpsertUserByEmail(ctx context.Context, email, displayName string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)
	LinkIdentity(ctx context.Context, provider, subject, userID string) error
	GetUserByIdentity(ctx context.Context, provider, subject string) (User, bool, error)
	// ListIdentityProviders returns the distinct OAuth providers linked to a
	// user ("google"/"apple"/…), sorted, for surfacing + the unlink guard.
	ListIdentityProviders(ctx context.Context, userID string) ([]string, error)
	// UnlinkIdentity removes a user's link to one provider (owner-scoped).
	// Returns ErrNotFound when no such link exists.
	UnlinkIdentity(ctx context.Context, provider, userID string) error
	// UnlinkIdentityIfSafe atomically removes a provider link only if the account
	// keeps at least one login method afterward, closing the concurrent-unlink
	// lockout race. Returns deleted, wouldOrphan (refused — last method), and err.
	UnlinkIdentityIfSafe(ctx context.Context, provider, userID string) (deleted, wouldOrphan bool, err error)
	SetPassword(ctx context.Context, userID, passwordHash string) error
	// ClearPassword removes a user's password credential (NULLs password_hash),
	// so GetCredentials/HasPassword no longer report a usable password. Used to
	// drop a password that was planted on an unverified account before an
	// external identity provider proves ownership of the email.
	ClearPassword(ctx context.Context, userID string) error
	GetCredentials(ctx context.Context, email string) (userID, passwordHash string, ok bool, err error)
	// UserByCanonicalEmail looks up an account by its folded canonical email form
	// (H2b anti-Sybil register dedupe: strips +tag for all domains, dot-folds
	// gmail.com/googlemail.com). Distinct from normEmail, which stays exact for
	// login/identity.
	UserByCanonicalEmail(ctx context.Context, canonical string) (User, bool, error)
	// InsertUserDedupedByCanonical atomically checks-then-inserts a new user by
	// canonical email form in a single transaction, closing the TOCTOU race a
	// separate UserByCanonicalEmail-then-UpsertUserByEmail pair leaves open:
	// concurrent Register calls for canonicalization-equivalent addresses (e.g.
	// a+x@gmail.com / a+y@gmail.com / a.b@gmail.com) can otherwise all read "not
	// taken" before any of them inserts. taken=true means some existing row
	// (any exact email) already owns this canonical form; nothing was written and
	// the returned User is the zero value.
	InsertUserDedupedByCanonical(ctx context.Context, email, displayName, canonical string) (u User, taken bool, err error)
	HasPassword(ctx context.Context, userID string) (bool, error)
	// ClaimTOTPStep atomically advances the admin TOTP replay guard to `step` iff
	// step is strictly newer than the last committed one, in a single writer
	// statement. ok=false means the step was already spent on ANY instance
	// (replay / stale) — this is what makes admin 2FA "one code, one use" hold
	// across instances and across process restarts. Call it after the credential
	// check passes; a false result must fail the login / step-up.
	ClaimTOTPStep(ctx context.Context, step int64) (ok bool, err error)
	// Admin sessions live in the store (shared across instances), not a
	// per-process map. See docs/multi-instance-state-migration.md item #4.
	CreateAdminSession(ctx context.Context, token, auth, credFP string, expires int64) error
	AdminSession(ctx context.Context, token, credFP string, now int64) (auth string, lastStepUpAt int64, ok bool, err error)
	MarkAdminStepUp(ctx context.Context, token string, at int64) error
	DeleteAdminSession(ctx context.Context, token string) error
	PurgeExpiredAdminSessions(ctx context.Context, now int64) error
	// Pending high-risk actions live in the store (claimable exactly once on any
	// instance). See docs/multi-instance-state-migration.md item #2.
	PutPendingAction(ctx context.Context, token, sessionTok, action, form, pathID string, now, expires int64, cap int) (ok bool, err error)
	TakePendingAction(ctx context.Context, token string) (sessionTok, action, form, pathID string, expires int64, ok bool, err error)
	// In-flight WebAuthn ceremonies live in the store (spendable exactly once on
	// any instance). session is the json-encoded webauthn.SessionData. Item #3.
	PutPasskeyCeremony(ctx context.Context, token, kind, session, name string, now, expires int64, cap int) (ok bool, err error)
	TakePasskeyCeremony(ctx context.Context, token string) (kind, session, name string, expires int64, ok bool, err error)
	// Resumable upload sessions live in the store (multi-instance + restart-safe).
	// See docs/multi-instance-state-migration.md item #9.
	CreateUploadSession(ctx context.Context, row UploadSessionRow, maxPerUser int) (ok bool, err error)
	GetUploadSession(ctx context.Context, id, userID string) (UploadSessionRow, bool, error)
	// AdvanceUploadReceived monotonically advances the committed offset (only ever
	// forward, only while the session is open, never past max_size), mirroring the
	// authoritative blob size, and stamps last_activity=now (idle-reaper input).
	AdvanceUploadReceived(ctx context.Context, id string, to, now int64) error
	// ClaimUploadDone atomically marks the session terminal and returns the offset
	// at that instant, stamping last_activity=now. ok=false ⇒ already claimed (a
	// racing finalize/reaper won).
	ClaimUploadDone(ctx context.Context, id string, now int64) (received int64, ok bool, err error)
	DeleteUploadSession(ctx context.Context, id string) error
	// ListExpiredOpenUploadSessions returns open sessions idle since ≤ before.
	ListExpiredOpenUploadSessions(ctx context.Context, before int64) ([]UploadSessionRow, error)
	// ListOrphanDoneUploadSessions returns finalized rows idle since ≤ before whose
	// blob no stored_files row references (a finalize that crashed before persist).
	ListOrphanDoneUploadSessions(ctx context.Context, before int64) ([]UploadSessionRow, error)
	// PurgeDoneUploadSessions deletes finalized rows idle since ≤ before (their
	// blob is either a live file or already dropped by the orphan pass).
	PurgeDoneUploadSessions(ctx context.Context, before int64) error
	EmailVerified(ctx context.Context, userID string) (bool, error)
	SetEmailVerified(ctx context.Context, userID string) error
	// SetOnlyOwnNodes toggles the BYO-nodes-only restriction (SP3) for a user.
	SetOnlyOwnNodes(ctx context.Context, userID string, on bool) error
	// SetUserPlan assigns a user's billing tier (plans.id). now is the change
	// timestamp, used to freeze the outgoing tier's earned quota segment.
	SetUserPlan(ctx context.Context, userID, planID string, now int64) error
	// SetUserPlanAdmin assigns a user's billing tier from the admin console,
	// recording plan_source='admin' so a later Stripe webhook won't override it.
	SetUserPlanAdmin(ctx context.Context, userID, planID string, now int64) error
	// SetUserStripeCustomer binds a user to their Stripe customer id.
	SetUserStripeCustomer(ctx context.Context, userID, customerID string) error
	// SetUserStripeCustomerIfEmpty binds a customer id only if the user has none
	// yet, returning the id now in force (the existing one if already bound).
	SetUserStripeCustomerIfEmpty(ctx context.Context, userID, customerID string) (string, error)
	// SetUserStripeSubscription records the canonical subscription id ('' clears).
	SetUserStripeSubscription(ctx context.Context, userID, subID string) error
	// GetUserByStripeCustomer looks up a user by Stripe customer id (webhook
	// dispatch). An empty customerID returns not-found.
	GetUserByStripeCustomer(ctx context.Context, customerID string) (User, bool, error)
	// ListStripePaidUsers returns active users on a Stripe-sourced paid plan with
	// a customer id — candidates for the periodic reconcile sweep that downgrades
	// anyone whose subscription was canceled but whose deletion webhook was missed.
	ListStripePaidUsers(ctx context.Context) ([]User, error)
	// SetUserSubscription updates plan_id, subscription_status, subscription_end,
	// and plan_source together (Stripe webhook path). now is the change timestamp,
	// used to freeze the outgoing tier's earned quota segment. subEventAt is the
	// Stripe event.created (0 for non-webhook callers), stored monotonically for
	// the ordering guard.
	SetUserSubscription(ctx context.Context, userID, planID, status string, end int64, source, cycle string, now, subEventAt int64) error
	// LastSubEventAt returns the event.created of the last subscription event
	// applied to a user (0 if none), so the webhook can drop stale re-deliveries.
	LastSubEventAt(ctx context.Context, userID string) (int64, error)
	// SetScheduledPlan records (or clears, with planID="" and cycle="") the tier
	// AND cycle a pending period-end downgrade will switch to — a display hint for
	// the pricing UI and the key the webhook uses to detect when the change lands.
	SetScheduledPlan(ctx context.Context, userID, planID, cycle string) error
	// PlanByStripePrice resolves a webhook's Stripe Price id (monthly or yearly)
	// to the plan tier mapped to it. An empty priceID returns not-found.
	PlanByStripePrice(ctx context.Context, priceID string) (Plan, bool, error)
	// SetAccountDeletion schedules a user for deletion: sets deleted_at and
	// purge_after (the GC hard-delete deadline), resetting purge_reminder_sent
	// so a re-request re-arms the reminder.
	SetAccountDeletion(ctx context.Context, userID string, deletedAt, purgeAfter int64) error
	// ClearAccountDeletion cancels a pending deletion, zeroing all three
	// lifecycle columns (deleted_at, purge_after, purge_reminder_sent) and
	// revoking the user's remaining unused "reactivate" tokens, in one
	// transaction — so no leftover token stays a passwordless login post-recovery.
	ClearAccountDeletion(ctx context.Context, userID string) error
	// MarkPurgeReminderSent records when the pre-purge reminder email was sent,
	// so GC sends it at most once per deletion request.
	MarkPurgeReminderSent(ctx context.Context, userID string, at int64) error
	// PurgeTransientUserData wipes a user's transient/live data immediately at
	// deletion-confirmation time (sessions, cli_tokens, cli_device_auth,
	// devices, magic_tokens, stored_files, node_tokens, and their own
	// owner_type='user' nodes), keeping the account shell (users row +
	// identities + usage_events/usage_monthly/user_stats) intact until the
	// 30-day hard-purge. Returns the deleted stored_files so the caller can
	// enqueue blob deletes. Runs in one transaction.
	PurgeTransientUserData(ctx context.Context, userID string) (blobs []StoredFile, err error)
	// ListUsersToPurge returns every user whose grace period has fully
	// elapsed (purge_after>0 AND purge_after<=now): GC's hard-purge worklist.
	ListUsersToPurge(ctx context.Context, now int64) ([]User, error)
	// ListUsersToRemind returns every pending-deletion user who hasn't yet
	// received the one-time pre-purge reminder and whose purge_after falls
	// within the reminder window (now..now+remindWindow).
	ListUsersToRemind(ctx context.Context, now, remindWindow int64) ([]User, error)
	// ArchiveAndPurgeUser is the GC hard-purge: in one transaction it folds
	// userID's usage_monthly rows into the anonymized usage_archive (summed by
	// period, no user identity retained), then deletes every user-linked row
	// (identities, sessions, magic_tokens, devices, cli_tokens,
	// cli_device_auth, usage_events, stored_files, upload_events, user_stats,
	// usage_monthly, email_tokens, node_tokens, the user's own nodes) before
	// finally deleting the users row itself. FK-safe delete order (children
	// before the users parent, PRAGMA foreign_keys=ON). The final users delete
	// is guarded on purge_after>0 AND purge_after<=now; if a concurrent
	// reactivation cleared the schedule, the guard matches nothing and the whole
	// purge rolls back, so a revived account is never destroyed.
	ArchiveAndPurgeUser(ctx context.Context, userID string, now int64) error
	// sessions
	CreateSession(ctx context.Context, s Session) error
	GetSession(ctx context.Context, id string) (Session, bool, error)
	RevokeSession(ctx context.Context, id string) error
	RevokeUserSessions(ctx context.Context, userID, exceptID string) error
	DeleteExpiredSessions(ctx context.Context, now int64) error
	// magic tokens
	CreateMagicToken(ctx context.Context, t MagicToken) error
	UseMagicToken(ctx context.Context, tokenHash string, now int64) (MagicToken, bool, error)
	DeleteSpentMagicTokens(ctx context.Context, now int64) error
	// email tokens (verify + reset)
	CreateEmailToken(ctx context.Context, t EmailToken) error
	UseEmailToken(ctx context.Context, tokenHash, purpose string, now int64) (EmailToken, bool, error)
	DeleteSpentEmailTokens(ctx context.Context, now int64) error
	// devices
	UpsertDevice(ctx context.Context, d Device) (Device, error)
	ListDevices(ctx context.Context, userID string) ([]Device, error)
	RenameDevice(ctx context.Context, id, userID, name string) error
	DeleteDevice(ctx context.Context, id, userID string) error
	// usage (cross-network relay metering)
	RecordUsage(ctx context.Context, e UsageEvent) error
	UserUsageTotal(ctx context.Context, userID string) (int64, error)
	UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error)
	// NodeRelayedSince sums relayed bytes per node for usage since `since`
	// (per-node monthly traffic cap), keyed by node id.
	NodeRelayedSince(ctx context.Context, since int64) (map[string]int64, error)
	// admin (read-only)
	AdminListUsers(ctx context.Context, q AdminUserQuery) (rows []AdminUserRow, total int64, err error)
	AdminMetrics(ctx context.Context, period string, now int64) (AdminMetrics, error)
	// stored files (zero-knowledge stored transfer)
	CreateStoredFile(ctx context.Context, f StoredFile) error
	// CreateStoredFileWithinStorageCaps atomically enforces the owner (userCap)
	// and global (globalCap) live-storage caps and inserts the row in one writer
	// transaction, so concurrent uploads cannot collectively bust a cap. A
	// non-positive cap disables that check. ok=false + reason ("storage"|"global")
	// names the cap hit; a real error is returned as err (caller fails closed).
	CreateStoredFileWithinStorageCaps(ctx context.Context, f StoredFile, now, userCap, globalCap int64) (ok bool, reason string, err error)
	GetStoredFile(ctx context.Context, id string) (StoredFile, error)
	// GetStoredFileByBlobKey resolves a blob key back to its stored-file row (a
	// direct-download receipt only carries the blob key). ErrNotFound if absent.
	GetStoredFileByBlobKey(ctx context.Context, blobKey string) (StoredFile, error)
	// ClaimDownloadReceipt records a direct-download receipt nonce, returning true
	// only the first time so reconciliation refunds exactly once (idempotent).
	ClaimDownloadReceipt(ctx context.Context, nonce string, at int64) (bool, error)
	ListStoredFilesByUser(ctx context.Context, userID string) ([]StoredFile, error)
	MarkDownloaded(ctx context.Context, id string, at int64) error
	// ClaimBurnDownload atomically consumes a burn-after-read file's single
	// download: it sets downloaded_at only if the file is burn and still unclaimed,
	// returning claimed=true exactly once across concurrent callers.
	ClaimBurnDownload(ctx context.Context, id string, at int64) (claimed bool, err error)
	// ReleaseBurnDownload reverses a ClaimBurnDownload when the download failed
	// mid-stream, restoring downloaded_at=0 only if it still matches the claim's
	// timestamp (so a concurrent re-claim is never clobbered).
	ReleaseBurnDownload(ctx context.Context, id string, claimedAt int64) error
	DeleteStoredFile(ctx context.Context, id string) error
	ListExpiredStoredFiles(ctx context.Context, now int64) ([]StoredFile, error)
	IncDownloadCount(ctx context.Context, id string) error
	// ClaimDownloadSlot atomically takes one of a file's remaining download
	// slots: increments download_count only while download_count < max_downloads
	// (max_downloads = 0 means unlimited). Returns claimed=true exactly for the
	// callers that fit under the cap across concurrent requests, and slot = the
	// post-increment download_count (1-based) THIS call took — the caller's own
	// slot number, not a value a concurrent claim can later inflate out from
	// under it. slot==0 when claimed==false.
	ClaimDownloadSlot(ctx context.Context, id string, at int64) (slot int64, claimed bool, err error)
	// ReleaseDownloadSlot undoes a ClaimDownloadSlot after a failed delivery
	// (download_count-1, floored at 0). Slots are fungible — any failed claim
	// returns one — so this takes no claim timestamp: a downloaded_at guard would
	// wrongly leak slots when several downloads of a multi-download file race.
	ReleaseDownloadSlot(ctx context.Context, id string) error
	// user_stats (lifetime aggregate counters; privacy-minimal, no per-event rows)
	AddUploadStat(ctx context.Context, userID string, bytes int64) error
	AddDownloadStat(ctx context.Context, userID string, bytes int64) error
	GetUserStats(ctx context.Context, userID string) (UserStats, error)
	// usage_monthly (per-month billing ledger: upload/download bytes; relay is
	// derived from usage_events, not stored here)
	RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error
	MonthlyUsage(ctx context.Context, userID, period string) (upload, download int64, err error)
	// upload events (rolling-24h quota ledger)
	RecordUpload(ctx context.Context, e UploadEvent) error
	UserUploadedSince(ctx context.Context, userID string, since int64) (int64, error)
	// ReserveUpload atomically records an upload event only if the user's rolling
	// usage since `since` plus e.Bytes stays within quota, in one transaction, so
	// concurrent uploads cannot collectively exceed the quota. ok=false means the
	// reservation was refused (over quota) and nothing was written.
	ReserveUpload(ctx context.Context, e UploadEvent, since, quota int64) (ok bool, err error)
	// RefundUpload removes a reserved upload event (by id) when a later gate fails,
	// so the daily quota isn't charged for a file that never landed.
	RefundUpload(ctx context.Context, id string) error
	PruneUploadEvents(ctx context.Context, before int64) error
	// PruneDownloadReceipts deletes direct-download dedup rows older than `before`
	// (a generous margin past any in-flight download) to keep the table bounded.
	PruneDownloadReceipts(ctx context.Context, before int64) error
	// settings (admin-editable limits)
	GetSetting(ctx context.Context, key string) (int64, bool, error)
	SetSetting(ctx context.Context, key string, value, at int64) error
	ListSettings(ctx context.Context) ([]Setting, error)
	// relay nodes (self-reporting fleet telemetry)
	UpsertNode(ctx context.Context, n Node) (Node, error)
	// TouchNode records a heartbeat. activeTransfers is the node's live
	// in-flight allocation count (see Node.ActiveTransfers) and, like the three
	// storage gauges, is SET rather than kept-max.
	TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, storageTotal, storageFree, at int64, activeTransfers int) error
	GetNode(ctx context.Context, id string) (Node, bool, error)
	StorageNodes(ctx context.Context, since, minFree int64) ([]Node, error)
	OnlineNodes(ctx context.Context, since int64) ([]Node, error)
	ListNodes(ctx context.Context) ([]Node, error)
	// UserNodes returns a user's own (owner_type='user') nodes seen since `since`.
	UserNodes(ctx context.Context, userID string, since int64) ([]Node, error)
	// UserNodesAll returns all of a user's own nodes regardless of last_seen,
	// for the dashboard list (which shows offline nodes too).
	UserNodesAll(ctx context.Context, userID string) ([]Node, error)
	// UserStorageNodes is UserNodes filtered to storage-enabled nodes with at
	// least minFree bytes free.
	UserStorageNodes(ctx context.Context, userID string, since, minFree int64) ([]Node, error)
	// DeleteNode removes a user-owned node, scoped to its owner: only a node
	// with owner_user_id == ownerUserID is deleted, so a non-owner's call and a
	// missing id are indistinguishable (both ErrNotFound). Also clears the
	// node's pending_node_deletes entries.
	DeleteNode(ctx context.Context, id, ownerUserID string) error
	// SetNodeLimits sets a node's admin hard caps (bytes; 0 = unlimited).
	SetNodeLimits(ctx context.Context, nodeID string, trafficLimit, diskLimit int64) error
	// SetUserNodeLabel renames a user-owned node, scoped to its owner so a user
	// can only rename their own nodes.
	SetUserNodeLabel(ctx context.Context, id, ownerUserID, label string) error
	// SetNodeLabel renames any node (admin, unscoped) — used for fleet nodes.
	SetNodeLabel(ctx context.Context, id, label string) error
	// SetNodeDraining sets/clears a node's drain flag (admin, unscoped): a
	// draining node is excluded from new-upload placement but keeps serving its
	// existing files. See Node.Draining.
	SetNodeDraining(ctx context.Context, id string, on bool) error
	// MarkNodeRemoved records that a node has been uninstalled: the row stays for
	// audit, but the node leaves the placement pool, the ICE candidate list and
	// the direct-download path. Idempotent — re-marking an already-removed node
	// keeps the FIRST timestamp, so a retried deregistration cannot rewrite
	// history. Returns ErrNotFound for an unknown id. See Node.RemovedAt.
	MarkNodeRemoved(ctx context.Context, id string, at int64) error
	// ClearNodeRemoved undoes MarkNodeRemoved (removed_at back to 0), putting
	// the node back into placement, ICE and the direct-download path. It exists
	// so deregistration is a door that opens both ways: the node token does not
	// bind to a node id, so one mistaken (or malicious) POST can empty the whole
	// pool, and the only other way back used to be deleting the row — which
	// destroys its history and its file bookkeeping with it. Admin-only.
	// Idempotent: clearing an already-live node is a no-op success. Returns
	// ErrNotFound for an unknown id.
	ClearNodeRemoved(ctx context.Context, id string) error
	// CountFilesOnNode reports how many LIVE stored files (expires_at > now)
	// still sit on nodeID, plus the largest ExpiresAt among them — the earliest
	// moment the node is safe to uninstall, since a file binds to exactly one
	// node and there are no replicas. An expired-but-not-yet-GC'd row does not
	// count and cannot push the safe-from time out further; a deleted file is
	// never in the table at all (stored_files rows are hard-deleted, not
	// soft-deleted), so it is excluded automatically. A node holding nothing
	// live reports (0, 0, nil).
	CountFilesOnNode(ctx context.Context, nodeID string, now int64) (count int, maxExpiresAt int64, err error)
	// NodeFileCounts is CountFilesOnNode for every node at once, in a single
	// grouped query — the admin nodes listing renders every row from one read
	// instead of one query per node. Nodes with no live files are simply absent
	// from the map (read as the zero NodeFileCount).
	NodeFileCounts(ctx context.Context, now int64) (map[string]NodeFileCount, error)
	// CentralStoredBytes sums the live sizes of files held on central-local
	// storage (node_id unset) — the app server's own disk fallback.
	CentralStoredBytes(ctx context.Context) (int64, error)
	// DeleteFleetNode removes an official (fleet) node, scoped to owner_type='fleet'.
	DeleteFleetNode(ctx context.Context, id string) error
	// node_rollout (Part 2: automatic node update rollout state machine).
	// GetRolloutTrack returns ok=false if the track has no persisted state yet
	// (a fresh DB, or a track that has never had a rollout started).
	GetRolloutTrack(ctx context.Context, track string) (RolloutTrack, bool, error)
	// PutRolloutTrack upserts a track's full state in one row. The fleet and
	// byo rows are independent — see RolloutTrack's doc comment.
	PutRolloutTrack(ctx context.Context, t RolloutTrack) error
	// ClaimRolloutNode is the compare-and-swap that hands the fleet slot to one
	// node: it only writes if the row still holds the current_node_id AND the
	// target_version the caller read, and is still 'rolling'. ok=false means the
	// track moved first (another instance's claim or halt, or an admin retarget)
	// and the caller must NOT tell its node to update — it would be installing
	// the version the decision was computed from, not the one now targeted.
	ClaimRolloutNode(ctx context.Context, track, expectTargetVersion, expectCurrentNodeID, nodeID, firstNodeID string, at int64) (bool, error)
	// HaltRolloutTrack stops a track, conditional on it still being 'rolling',
	// so a halt can never be clobbered by (nor clobber) a concurrent writer.
	HaltRolloutTrack(ctx context.Context, track, reason string, at int64) (bool, error)
	// CompleteRolloutTrack marks a track finished, conditional on it still
	// being 'rolling' — same rationale as HaltRolloutTrack: a whole-row write
	// here could erase a concurrent halt and its reason.
	CompleteRolloutTrack(ctx context.Context, track string, at int64) (bool, error)
	// AdvanceByoBatch opens the next byo batch, conditional on the row still
	// being 'rolling', still at the batch percentage (fromBatch) AND still on
	// the target_version this decision was computed from — otherwise a stale
	// write can resurrect a halted track, jump the ladder forward, or land
	// against a rollout to a different version whose canary window it has just
	// skipped. See its doc comment in rollout_store.go.
	AdvanceByoBatch(ctx context.Context, track, expectTargetVersion string, fromBatch, toBatch int, at int64) (bool, error)
	// ResumeRolloutTrack restarts a HALTED track on the version it already
	// targets, resetting the staging fields (batch, in-flight/canary node,
	// emergency) that would otherwise make it re-halt immediately. It touches
	// one track's row and reads nothing else — resuming one track must never
	// be able to fail because of the other. ok=false means the track was not
	// halted (already rolling, or complete).
	ResumeRolloutTrack(ctx context.Context, track string, at int64) (bool, error)
	// SetRolloutEmergency arms emergency mode (release the whole track at
	// once, skipping the staged ladder) on a track that is rolling to
	// expectVersion — a compare-and-swap against exactly what the admin
	// confirmed. ok=false means the track moved in between and nothing was
	// released.
	SetRolloutEmergency(ctx context.Context, track, expectVersion string, at int64) (bool, error)
	// NodesByOwnerType returns every node of one ownership class ("fleet" |
	// "user") INCLUDING offline ones. The rollout state machines require the
	// offline rows (see the method's doc comment) — do not substitute
	// OnlineNodes here.
	NodesByOwnerType(ctx context.Context, ownerType string) ([]Node, error)
	// CommandNodeUpdate stamps update_started_at/update_from_version and clears
	// update_result when central commands a node to self-update.
	CommandNodeUpdate(ctx context.Context, nodeID, fromVersion string, at int64) error
	// SetNodeUpdateResult records the outcome a node reported for the update it
	// was last commanded.
	SetNodeUpdateResult(ctx context.Context, nodeID, result string) error
	// BumpNodeUpdateAttempts increments nodes.update_attempts. No longer called
	// by the rollout path (see Node.UpdateAttempts) — kept on the interface and
	// the schema rather than removed, in case a future caller needs it.
	BumpNodeUpdateAttempts(ctx context.Context, nodeID string) error
	// pending_node_deletes (orphan-retry queue for GC when a node's DELETE fails)
	EnqueueNodeDelete(ctx context.Context, blobKey, nodeID string, at int64) error
	ListPendingNodeDeletes(ctx context.Context) ([]PendingNodeDelete, error)
	DeletePendingNodeDelete(ctx context.Context, blobKey, nodeID string) error
	// DeletePendingNodeDeletesOlderThan evicts orphan-retry rows enqueued
	// before `before`: a permanently-dead node would otherwise retry forever.
	DeletePendingNodeDeletesOlderThan(ctx context.Context, before int64) error
	// node_tokens (per-user BYO-node bearer credentials; SP3)
	CreateNodeToken(ctx context.Context, t NodeToken) error
	NodeTokenByHash(ctx context.Context, hash string) (NodeToken, bool, error)
	BindNodeToken(ctx context.Context, id, nodeID string) error
	ListNodeTokensByUser(ctx context.Context, userID string) ([]NodeToken, error)
	RevokeNodeToken(ctx context.Context, id, userID string, at int64) error
	TouchNodeTokenUsed(ctx context.Context, id string, at int64) error
	// fleet_tokens (admin-minted, userless official-node bearer credentials)
	CreateFleetToken(ctx context.Context, t FleetToken) error
	FleetTokenByHash(ctx context.Context, hash string) (FleetToken, bool, error)
	BindFleetToken(ctx context.Context, id, nodeID string) error
	TouchFleetTokenUsed(ctx context.Context, id string, at int64) error
	RevokeFleetToken(ctx context.Context, id string, at int64) error
	ListActiveFleetTokens(ctx context.Context) ([]FleetToken, error)
	// cli_device_auth (device-code CLI login flow)
	CreateDeviceAuth(ctx context.Context, r DeviceAuthRequest) error
	GetDeviceAuthByUserCode(ctx context.Context, userCode string) (DeviceAuthRequest, bool, error)
	GetDeviceAuthByCodeHash(ctx context.Context, hash string) (DeviceAuthRequest, bool, error)
	// ApproveDeviceAuth atomically transitions a request from pending to
	// approved (WHERE status='pending' AND unexpired), stashing the raw
	// one-time CLI token in pending_token for the next poll to collect.
	// ok=false if the request wasn't pending/unexpired (already approved,
	// denied, expired, or unknown code) — nothing is written.
	ApproveDeviceAuth(ctx context.Context, userCode, userID, tokenHash, rawToken string, at int64) (ok bool, err error)
	// ConsumeDeviceAuth atomically transitions an approved request to
	// consumed exactly once, returning the raw one-time token stashed by
	// ApproveDeviceAuth and blanking pending_token so it never lingers at
	// rest. ok=false on any second call or if the request isn't approved.
	ConsumeDeviceAuth(ctx context.Context, codeHash string, at int64) (rawToken string, ok bool, err error)
	// DeleteExpiredDeviceAuth reclaims device-auth rows past their expiry.
	DeleteExpiredDeviceAuth(ctx context.Context, now int64) error
	// cli_tokens (long-lived hashed CLI bearer tokens; prefix "rlm_cli_")
	CreateCLIToken(ctx context.Context, t CLIToken) error
	GetCLITokenUser(ctx context.Context, tokenHash string) (userID, deviceID string, ok bool, err error)
	TouchCLIToken(ctx context.Context, tokenHash string, at int64) error
	// plans (billing phase-1)
	ListPlans(ctx context.Context) ([]Plan, error)
	GetPlan(ctx context.Context, id string) (Plan, bool, error)
	UpsertPlan(ctx context.Context, p Plan) error
	CountActivePlans(ctx context.Context) (int, error)
	// usage read queries (billing phase-1 enforcement inputs)
	UserMonthlyUpDown(ctx context.Context, userID, period string) (int64, error)
	CurrentStorage(ctx context.Context, userID string, now int64) (int64, error)
	GlobalStorageUsed(ctx context.Context, now int64) (int64, error)
	// admin passkeys
	ListAdminCredentials(ctx context.Context) ([]AdminCredential, error)
	// CountAdminCredentials reports how many passkeys are registered without
	// reading any credential material. The unauthenticated login page asks this
	// on every render, so it must not pull cred_json blobs into memory.
	CountAdminCredentials(ctx context.Context) (int, error)
	GetAdminCredential(ctx context.Context, id string) (AdminCredential, bool, error)
	InsertAdminCredential(ctx context.Context, c AdminCredential) error
	// TouchAdminCredential writes back the updated credential record and the
	// last-used timestamp after a successful login.
	TouchAdminCredential(ctx context.Context, id string, credJSON []byte, lastUsedAt int64) error
	DeleteAdminCredential(ctx context.Context, id string) error
	// AdminUserHandle returns the shared WebAuthn user handle, ok=false when no
	// credential is registered yet (the first registration mints one).
	AdminUserHandle(ctx context.Context) ([]byte, bool, error)
	// InsertAudit 追加一条管理员操作记录。审计写入失败绝不能让业务操作回滚：
	// 调用方记录错误后继续（见 writeAudit）。
	InsertAudit(ctx context.Context, e AuditEntry) error
	// ListAudit 按时间倒序返回审计记录。action 非空时按动作过滤。
	ListAudit(ctx context.Context, limit, offset int, action string) ([]AuditEntry, error)
}
