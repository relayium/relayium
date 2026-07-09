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

// Device is a browser (later: a CLI) registered under a user. Static registry only;
// online presence/rendezvous belongs to the cross-network spec, not here.
type Device struct {
	ID         string
	UserID     string
	Name       string
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
	DownloadedAt  int64 // 0 = not yet downloaded
	DownloadCount int64 // lifetime successful downloads of this file (non-burn)
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
	RelayedBytes  int64 // 选定月的中继流量（来自 usage_events）
	UploadBytes   int64 // 选定月上传（usage_monthly）
	DownloadBytes int64 // 选定月下载（usage_monthly）
	StorageBytes  int64 // 当前存储占用（未过期文件 size 之和，与月份无关）
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

// Store is the only abstraction that touches persistent storage. Implemented by
// SQLiteStore today; a Postgres impl could replace it without changing callers.
type Store interface {
	// users + identities
	UpsertUserByEmail(ctx context.Context, email, displayName string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)
	LinkIdentity(ctx context.Context, provider, subject, userID string) error
	GetUserByIdentity(ctx context.Context, provider, subject string) (User, bool, error)
	SetPassword(ctx context.Context, userID, passwordHash string) error
	GetCredentials(ctx context.Context, email string) (userID, passwordHash string, ok bool, err error)
	HasPassword(ctx context.Context, userID string) (bool, error)
	EmailVerified(ctx context.Context, userID string) (bool, error)
	SetEmailVerified(ctx context.Context, userID string) error
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
	// devices
	UpsertDevice(ctx context.Context, d Device) (Device, error)
	ListDevices(ctx context.Context, userID string) ([]Device, error)
	RenameDevice(ctx context.Context, id, userID, name string) error
	DeleteDevice(ctx context.Context, id, userID string) error
	// usage (cross-network relay metering)
	RecordUsage(ctx context.Context, e UsageEvent) error
	UserUsageTotal(ctx context.Context, userID string) (int64, error)
	UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error)
	// admin (read-only)
	AdminListUsers(ctx context.Context, q AdminUserQuery) (rows []AdminUserRow, total int64, err error)
	AdminMetrics(ctx context.Context, period string, now int64) (AdminMetrics, error)
	// stored files (zero-knowledge stored transfer)
	CreateStoredFile(ctx context.Context, f StoredFile) error
	GetStoredFile(ctx context.Context, id string) (StoredFile, error)
	ListStoredFilesByUser(ctx context.Context, userID string) ([]StoredFile, error)
	MarkDownloaded(ctx context.Context, id string, at int64) error
	// ClaimBurnDownload atomically consumes a burn-after-read file's single
	// download: it sets downloaded_at only if the file is burn and still unclaimed,
	// returning claimed=true exactly once across concurrent callers.
	ClaimBurnDownload(ctx context.Context, id string, at int64) (claimed bool, err error)
	DeleteStoredFile(ctx context.Context, id string) error
	ListExpiredStoredFiles(ctx context.Context, now int64) ([]StoredFile, error)
	IncDownloadCount(ctx context.Context, id string) error
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
	PruneUploadEvents(ctx context.Context, before int64) error
	// settings (admin-editable limits)
	GetSetting(ctx context.Context, key string) (int64, bool, error)
	SetSetting(ctx context.Context, key string, value, at int64) error
	ListSettings(ctx context.Context) ([]Setting, error)
}
