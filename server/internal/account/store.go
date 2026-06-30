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
	ID          string
	Email       string
	DisplayName string
	CreatedAt   int64
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

// Transfer is a one-time cross-network rendezvous room token bound to its
// originating (logged-in) user. Possession of the token is the room capability;
// the server stores it only to gate creation on login and (later) to anchor
// relayed-byte metering. It never holds file content or keys.
type Transfer struct {
	Token     string
	UserID    string
	CreatedAt int64
	ExpiresAt int64
}

// UsageEvent is one coturn allocation's relay accounting, attributed to the
// user who owns the transfer token. Recorded only for billing/metering; the
// server never inspects relayed content.
type UsageEvent struct {
	AllocID      string
	Token        string
	UserID       string
	RelayedBytes int64
	RecordedAt   int64
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
	// sessions
	CreateSession(ctx context.Context, s Session) error
	GetSession(ctx context.Context, id string) (Session, bool, error)
	RevokeSession(ctx context.Context, id string) error
	// magic tokens
	CreateMagicToken(ctx context.Context, t MagicToken) error
	UseMagicToken(ctx context.Context, tokenHash string, now int64) (MagicToken, bool, error)
	// devices
	UpsertDevice(ctx context.Context, d Device) (Device, error)
	ListDevices(ctx context.Context, userID string) ([]Device, error)
	RenameDevice(ctx context.Context, id, userID, name string) error
	DeleteDevice(ctx context.Context, id, userID string) error
	// transfers (cross-network rendezvous)
	CreateTransfer(ctx context.Context, t Transfer) error
	GetTransfer(ctx context.Context, token string) (Transfer, error)
	// usage (cross-network relay metering)
	RecordUsage(ctx context.Context, e UsageEvent) error
	UserUsageTotal(ctx context.Context, userID string) (int64, error)
}
