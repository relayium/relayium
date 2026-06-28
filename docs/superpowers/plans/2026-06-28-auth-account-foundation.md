# Account Foundation (Spec ①) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight account system (Google OAuth + email magic link, revocable sessions, a minimal device registry) to the existing Go server, as a purely additive layer that leaves the LAN transfer path untouched.

**Architecture:** A new self-contained `internal/account` Go package owns all auth/account logic behind a thin `Store` interface (SQLite via the pure-Go `modernc.org/sqlite` driver). HTTP handlers hang off a single `Service` struct and are registered on the existing `http.ServeMux` in `main.go` under `/api/...`. The web SPA gains an `auth.svelte.ts` state module and an account menu; the transfer UI is unchanged. Sessions are server-side rows referenced by an `httpOnly` cookie.

**Tech Stack:** Go 1.26, `modernc.org/sqlite` (pure-Go SQLite), `golang.org/x/oauth2` (Google), Go stdlib `net/smtp` + `net/http`, Svelte 5 runes (existing).

## Global Constraints

- Go module path: `github.com/relayium/relayium` (server packages import from here).
- Go version floor: `go 1.26.3` (per `server/go.mod`).
- SQLite access goes **only** through the `Store` interface — no other package imports the driver. Future Postgres swap must touch only `sqlite.go`.
- Account system must **never** read or store file content, file names, or session keys. Persisted PII is limited to: email, display name, device nickname.
- The LAN transfer path (signaling hub, `/ws`, static serving, all of `web/src/lib/*` transfer/crypto/webrtc code) must keep working unchanged and remain usable **without login**.
- Session cookie attributes: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- Email is normalized to lowercase before any lookup or write.
- Magic-link request endpoint returns an identical response whether or not the email exists (no account enumeration).
- All timestamps are Unix seconds (`int64`). Time is injected via a `now func() time.Time` on `Service` for deterministic tests; never call `time.Now()` directly inside handlers/services.
- New Go deps must be added with `go get` and committed via `go.mod`/`go.sum`.

---

### Task 1: Account package scaffold — `Store` interface, types, SQLite open + migrate, users & identities

**Files:**
- Create: `server/internal/account/store.go`
- Create: `server/internal/account/sqlite.go`
- Create: `server/internal/account/sqlite_test.go`
- Modify: `server/go.mod`, `server/go.sum` (add `modernc.org/sqlite`)

**Interfaces:**
- Produces: package `account` with types `User{ID,Email,DisplayName string; CreatedAt int64}`, `Identity{Provider,Subject,UserID string}`. `Store` interface (grown over later tasks) starting with: `UpsertUserByEmail(ctx, email, displayName string) (User, error)`, `GetUserByID(ctx, id string) (User, error)`, `LinkIdentity(ctx, provider, subject, userID string) error`, `GetUserByIdentity(ctx, provider, subject string) (User, bool, error)`. Constructor `OpenSQLite(dsn string) (*SQLiteStore, error)` returns a `*SQLiteStore` that implements `Store` and runs migrations on open. `(*SQLiteStore).Close() error`.

- [ ] **Step 1: Add the SQLite driver dependency**

Run:
```bash
cd server && go get modernc.org/sqlite@latest
```
Expected: `go.mod` gains `modernc.org/sqlite`, `go.sum` updated.

- [ ] **Step 2: Write `store.go` with types and the initial interface**

```go
package account

import "context"

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

// Store is the only abstraction that touches persistent storage. Implemented by
// SQLiteStore today; a Postgres impl could replace it without changing callers.
type Store interface {
	// users + identities
	UpsertUserByEmail(ctx context.Context, email, displayName string) (User, error)
	GetUserByID(ctx context.Context, id string) (User, error)
	LinkIdentity(ctx context.Context, provider, subject, userID string) error
	GetUserByIdentity(ctx context.Context, provider, subject string) (User, bool, error)
}
```

- [ ] **Step 3: Write the failing test `sqlite_test.go`**

```go
package account

import (
	"context"
	"testing"
)

func newTestStore(t *testing.T) *SQLiteStore {
	t.Helper()
	s, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestUpsertUserByEmailIsIdempotentAndNormalizes(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u1, err := s.UpsertUserByEmail(ctx, "Alice@Example.com", "Alice")
	if err != nil {
		t.Fatalf("upsert1: %v", err)
	}
	if u1.Email != "alice@example.com" {
		t.Fatalf("email not normalized: %q", u1.Email)
	}
	u2, err := s.UpsertUserByEmail(ctx, "alice@example.com", "Alice 2")
	if err != nil {
		t.Fatalf("upsert2: %v", err)
	}
	if u2.ID != u1.ID {
		t.Fatalf("same email produced two users: %s vs %s", u1.ID, u2.ID)
	}
}

func TestIdentityLinkAndLookup(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "bob@example.com", "Bob")
	if err := s.LinkIdentity(ctx, "google", "sub-123", u.ID); err != nil {
		t.Fatalf("link: %v", err)
	}
	got, ok, err := s.GetUserByIdentity(ctx, "google", "sub-123")
	if err != nil || !ok {
		t.Fatalf("lookup failed: ok=%v err=%v", ok, err)
	}
	if got.ID != u.ID {
		t.Fatalf("wrong user: %s", got.ID)
	}
	if _, ok, _ := s.GetUserByIdentity(ctx, "google", "missing"); ok {
		t.Fatalf("expected no user for missing subject")
	}
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestUpsert -v`
Expected: build failure — `OpenSQLite` / `SQLiteStore` undefined.

- [ ] **Step 5: Write `sqlite.go` — open, migrate, users & identities**

```go
package account

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
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
	return &SQLiteStore{db: db}, nil
}

func (s *SQLiteStore) Close() error { return s.db.Close() }

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && go test ./internal/account/ -v`
Expected: PASS for both tests.

- [ ] **Step 7: Commit**

```bash
git add server/go.mod server/go.sum server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go
git commit -m "feat(account): SQLite store scaffold with users + identities"
```

---

### Task 2: Sessions in the Store + session helpers

**Files:**
- Modify: `server/internal/account/store.go` (extend `Store`)
- Modify: `server/internal/account/sqlite.go` (session methods)
- Modify: `server/internal/account/sqlite_test.go` (session tests)

**Interfaces:**
- Produces: type `Session{ID, UserID string; CreatedAt, ExpiresAt int64; Revoked bool}`. New `Store` methods: `CreateSession(ctx, Session) error`, `GetSession(ctx, id string) (Session, bool, error)`, `RevokeSession(ctx, id string) error`. `GetSession` returns `ok=false` for missing, revoked, or expired-at-query-time rows is **not** enforced here — expiry is checked by the caller; the store returns the raw row with `ok=true` if it exists and is not revoked, `ok=false` if missing or revoked.

- [ ] **Step 1: Add the `Session` type and extend the interface in `store.go`**

```go
// append to store.go

// Session is a server-side login session referenced by an httpOnly cookie.
type Session struct {
	ID        string
	UserID    string
	CreatedAt int64
	ExpiresAt int64
	Revoked   bool
}
```
Add to the `Store` interface:
```go
	// sessions
	CreateSession(ctx context.Context, s Session) error
	GetSession(ctx context.Context, id string) (Session, bool, error)
	RevokeSession(ctx context.Context, id string) error
```

- [ ] **Step 2: Write the failing test (append to `sqlite_test.go`)**

```go
func TestSessionLifecycle(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "c@example.com", "C")
	sess := Session{ID: "sess1", UserID: u.ID, CreatedAt: 100, ExpiresAt: 200}
	if err := s.CreateSession(ctx, sess); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, ok, err := s.GetSession(ctx, "sess1")
	if err != nil || !ok || got.UserID != u.ID {
		t.Fatalf("get: ok=%v err=%v got=%+v", ok, err, got)
	}
	if err := s.RevokeSession(ctx, "sess1"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok, _ := s.GetSession(ctx, "sess1"); ok {
		t.Fatalf("revoked session must return ok=false")
	}
	if _, ok, _ := s.GetSession(ctx, "missing"); ok {
		t.Fatalf("missing session must return ok=false")
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestSessionLifecycle -v`
Expected: build failure — methods undefined.

- [ ] **Step 4: Implement session methods in `sqlite.go`**

```go
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/
git commit -m "feat(account): session rows in the store"
```

---

### Task 3: Magic tokens in the Store (hashed, one-time, expiring)

**Files:**
- Modify: `server/internal/account/store.go`
- Modify: `server/internal/account/sqlite.go`
- Modify: `server/internal/account/sqlite_test.go`

**Interfaces:**
- Produces: type `MagicToken{TokenHash, Email string; CreatedAt, ExpiresAt, UsedAt int64}`. New `Store` methods: `CreateMagicToken(ctx, MagicToken) error`, `UseMagicToken(ctx, tokenHash string, now int64) (MagicToken, bool, error)` — atomically marks the token used and returns `ok=true` only if it existed, was unused, and `now < expires_at`; otherwise `ok=false`.

- [ ] **Step 1: Add the type and interface methods in `store.go`**

```go
// MagicToken is a one-time email login token. Only its hash is stored.
type MagicToken struct {
	TokenHash string
	Email     string
	CreatedAt int64
	ExpiresAt int64
	UsedAt    int64 // 0 = unused
}
```
Add to `Store`:
```go
	// magic tokens
	CreateMagicToken(ctx context.Context, t MagicToken) error
	UseMagicToken(ctx context.Context, tokenHash string, now int64) (MagicToken, bool, error)
```

- [ ] **Step 2: Write the failing test (append to `sqlite_test.go`)**

```go
func TestMagicTokenOneTimeAndExpiry(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	tok := MagicToken{TokenHash: "h1", Email: "d@example.com", CreatedAt: 10, ExpiresAt: 100}
	if err := s.CreateMagicToken(ctx, tok); err != nil {
		t.Fatalf("create: %v", err)
	}
	// First use within window succeeds.
	got, ok, err := s.UseMagicToken(ctx, "h1", 50)
	if err != nil || !ok || got.Email != "d@example.com" {
		t.Fatalf("first use: ok=%v err=%v", ok, err)
	}
	// Second use of the same token fails (one-time).
	if _, ok, _ := s.UseMagicToken(ctx, "h1", 51); ok {
		t.Fatalf("token must be single-use")
	}
	// Expired token fails.
	exp := MagicToken{TokenHash: "h2", Email: "e@example.com", CreatedAt: 10, ExpiresAt: 100}
	_ = s.CreateMagicToken(ctx, exp)
	if _, ok, _ := s.UseMagicToken(ctx, "h2", 200); ok {
		t.Fatalf("expired token must fail")
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestMagicToken -v`
Expected: build failure — methods undefined.

- [ ] **Step 4: Implement in `sqlite.go`**

```go
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/
git commit -m "feat(account): one-time expiring magic tokens in the store"
```

---

### Task 4: Devices in the Store

**Files:**
- Modify: `server/internal/account/store.go`
- Modify: `server/internal/account/sqlite.go`
- Modify: `server/internal/account/sqlite_test.go`

**Interfaces:**
- Produces: type `Device{ID, UserID, Name string; CreatedAt, LastSeenAt int64}`. New `Store` methods: `UpsertDevice(ctx, Device) (Device, error)` (insert, or update name if `id` already belongs to the same user), `ListDevices(ctx, userID string) ([]Device, error)` (ordered by `created_at`), `RenameDevice(ctx, id, userID, name string) error`, `DeleteDevice(ctx, id, userID string) error`. Rename/Delete are scoped by `userID` so one user can't touch another's devices.

- [ ] **Step 1: Add the type and interface methods in `store.go`**

```go
// Device is a browser (later: a CLI) registered under a user. Static registry only;
// online presence/rendezvous belongs to the cross-network spec, not here.
type Device struct {
	ID         string
	UserID     string
	Name       string
	CreatedAt  int64
	LastSeenAt int64
}
```
Add to `Store`:
```go
	// devices
	UpsertDevice(ctx context.Context, d Device) (Device, error)
	ListDevices(ctx context.Context, userID string) ([]Device, error)
	RenameDevice(ctx context.Context, id, userID, name string) error
	DeleteDevice(ctx context.Context, id, userID string) error
```

- [ ] **Step 2: Write the failing test (append to `sqlite_test.go`)**

```go
func TestDeviceRegistryScopedToUser(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u1, _ := s.UpsertUserByEmail(ctx, "u1@example.com", "U1")
	u2, _ := s.UpsertUserByEmail(ctx, "u2@example.com", "U2")

	d, err := s.UpsertDevice(ctx, Device{ID: "dev1", UserID: u1.ID, Name: "Laptop", CreatedAt: 1})
	if err != nil || d.Name != "Laptop" {
		t.Fatalf("upsert: %v %+v", err, d)
	}
	// Re-claiming the same device id by the same user updates the name.
	if _, err := s.UpsertDevice(ctx, Device{ID: "dev1", UserID: u1.ID, Name: "Laptop 2", CreatedAt: 1}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	list, _ := s.ListDevices(ctx, u1.ID)
	if len(list) != 1 || list[0].Name != "Laptop 2" {
		t.Fatalf("list after re-upsert: %+v", list)
	}
	// u2 cannot rename or delete u1's device.
	if err := s.RenameDevice(ctx, "dev1", u2.ID, "hacked"); err == nil {
		if l, _ := s.ListDevices(ctx, u1.ID); l[0].Name == "hacked" {
			t.Fatalf("u2 renamed u1's device")
		}
	}
	_ = s.DeleteDevice(ctx, "dev1", u2.ID)
	if l, _ := s.ListDevices(ctx, u1.ID); len(l) != 1 {
		t.Fatalf("u2 deleted u1's device")
	}
	// Owner can delete.
	if err := s.DeleteDevice(ctx, "dev1", u1.ID); err != nil {
		t.Fatalf("owner delete: %v", err)
	}
	if l, _ := s.ListDevices(ctx, u1.ID); len(l) != 0 {
		t.Fatalf("device not deleted: %+v", l)
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestDeviceRegistry -v`
Expected: build failure — methods undefined.

- [ ] **Step 4: Implement in `sqlite.go`**

```go
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
		`SELECT id, user_id, name, created_at, last_seen_at FROM devices WHERE id = ?`, d.ID,
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/
git commit -m "feat(account): per-user device registry in the store"
```

---

### Task 5: Mailer interface + SMTP and log implementations

**Files:**
- Create: `server/internal/account/mailer.go`
- Create: `server/internal/account/mailer_test.go`

**Interfaces:**
- Produces: interface `Mailer{ SendMagicLink(ctx context.Context, email, link string) error }`. `LogMailer` (writes the link to a provided `*log.Logger`, for dev) and `SMTPMailer{Addr, From string; Auth smtp.Auth}` (sends via `net/smtp`). Both satisfy `Mailer`.

- [ ] **Step 1: Write the failing test `mailer_test.go`**

```go
package account

import (
	"bytes"
	"context"
	"log"
	"testing"
)

func TestLogMailerWritesLink(t *testing.T) {
	var buf bytes.Buffer
	m := &LogMailer{Log: log.New(&buf, "", 0)}
	if err := m.SendMagicLink(context.Background(), "f@example.com", "https://relayium.com/api/auth/magic/verify?token=abc"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte("token=abc")) || !bytes.Contains(buf.Bytes(), []byte("f@example.com")) {
		t.Fatalf("log missing link/email: %q", buf.String())
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestLogMailer -v`
Expected: build failure — `LogMailer` undefined.

- [ ] **Step 3: Implement `mailer.go`**

```go
package account

import (
	"context"
	"fmt"
	"log"
	"net/smtp"
	"strings"
)

// Mailer sends the magic-link email. Abstracted so dev uses a log and prod uses SMTP.
type Mailer interface {
	SendMagicLink(ctx context.Context, email, link string) error
}

// LogMailer prints the link instead of sending it. For local development only.
type LogMailer struct{ Log *log.Logger }

func (m *LogMailer) SendMagicLink(_ context.Context, email, link string) error {
	m.Log.Printf("magic link for %s: %s", email, link)
	return nil
}

// SMTPMailer sends via a standard SMTP server.
type SMTPMailer struct {
	Addr string    // host:port
	From string    // From header / envelope sender
	Auth smtp.Auth // nil for unauthenticated relays
}

func (m *SMTPMailer) SendMagicLink(_ context.Context, email, link string) error {
	body := strings.Join([]string{
		"From: " + m.From,
		"To: " + email,
		"Subject: Your Relayium sign-in link",
		"",
		"Click to sign in to Relayium:",
		link,
		"",
		"This link expires shortly and can be used once. If you didn't request it, ignore this email.",
	}, "\r\n")
	if err := smtp.SendMail(m.Addr, m.Auth, m.From, []string{email}, []byte(body)); err != nil {
		return fmt.Errorf("send magic link: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestLogMailer -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/mailer.go server/internal/account/mailer_test.go
git commit -m "feat(account): Mailer interface with log + SMTP impls"
```

---

### Task 6: Service core — config, session issue/validate, magic request/verify

**Files:**
- Create: `server/internal/account/service.go`
- Create: `server/internal/account/service_test.go`

**Interfaces:**
- Consumes: `Store`, `Mailer` from earlier tasks.
- Produces: `Config{BaseURL string; SessionTTL, MagicTTL time.Duration; GoogleClientID, GoogleSecret, GoogleRedirect string}`. `Service{ store Store; mailer Mailer; cfg Config; now func() time.Time }` built by `NewService(store Store, mailer Mailer, cfg Config) *Service` (defaults `now` to `time.Now`). Methods: `IssueSession(ctx, userID string) (Session, error)`; `ValidateSession(ctx, sessionID string) (User, bool, error)` (false if missing/revoked/expired); `RequestMagicLink(ctx, email string) error` (generates token, stores hash, mails link — always nil-on-unknown to avoid enumeration leaking via error); `VerifyMagicLink(ctx, token string) (Session, error)` (claims token, upserts user+identity, issues session). Helper `hashToken(raw string) string` = hex SHA-256.

- [ ] **Step 1: Write the failing test `service_test.go`**

```go
package account

import (
	"context"
	"testing"
	"time"
)

// capturingMailer records the last link so the test can replay it.
type capturingMailer struct{ lastLink string }

func (m *capturingMailer) SendMagicLink(_ context.Context, _, link string) error {
	m.lastLink = link
	return nil
}

func newTestService(t *testing.T) (*Service, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL:    "https://relayium.com",
		SessionTTL: time.Hour,
		MagicTTL:   15 * time.Minute,
	})
	return svc, mail
}

func TestMagicLinkRoundTripIssuesSession(t *testing.T) {
	svc, mail := newTestService(t)
	ctx := context.Background()
	if err := svc.RequestMagicLink(ctx, "G@Example.com"); err != nil {
		t.Fatalf("request: %v", err)
	}
	// Extract token from the captured link.
	const marker = "token="
	i := indexOf(mail.lastLink, marker)
	if i < 0 {
		t.Fatalf("no token in link: %q", mail.lastLink)
	}
	token := mail.lastLink[i+len(marker):]
	sess, err := svc.VerifyMagicLink(ctx, token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	u, ok, err := svc.ValidateSession(ctx, sess.ID)
	if err != nil || !ok {
		t.Fatalf("validate: ok=%v err=%v", ok, err)
	}
	if u.Email != "g@example.com" {
		t.Fatalf("email not normalized through flow: %q", u.Email)
	}
	// Token is single-use.
	if _, err := svc.VerifyMagicLink(ctx, token); err == nil {
		t.Fatalf("token reuse must fail")
	}
}

func TestExpiredSessionInvalid(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	u, _ := svc.store.UpsertUserByEmail(ctx, "h@example.com", "H")
	base := time.Unix(1000, 0)
	svc.now = func() time.Time { return base }
	sess, _ := svc.IssueSession(ctx, u.ID)
	svc.now = func() time.Time { return base.Add(2 * time.Hour) } // past SessionTTL
	if _, ok, _ := svc.ValidateSession(ctx, sess.ID); ok {
		t.Fatalf("expired session must be invalid")
	}
}

// indexOf is a tiny helper to avoid importing strings in the test for one call.
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestMagicLinkRoundTrip -v`
Expected: build failure — `NewService` undefined.

- [ ] **Step 3: Implement `service.go`**

```go
package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"time"
)

type Config struct {
	BaseURL        string
	SessionTTL     time.Duration
	MagicTTL       time.Duration
	GoogleClientID string
	GoogleSecret   string
	GoogleRedirect string
}

type Service struct {
	store  Store
	mailer Mailer
	cfg    Config
	now    func() time.Time
}

func NewService(store Store, mailer Mailer, cfg Config) *Service {
	return &Service{store: store, mailer: mailer, cfg: cfg, now: time.Now}
}

func randToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func (s *Service) IssueSession(ctx context.Context, userID string) (Session, error) {
	now := s.now()
	sess := Session{
		ID:        randToken(),
		UserID:    userID,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.SessionTTL).Unix(),
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return Session{}, err
	}
	return sess, nil
}

func (s *Service) ValidateSession(ctx context.Context, sessionID string) (User, bool, error) {
	sess, ok, err := s.store.GetSession(ctx, sessionID)
	if err != nil || !ok {
		return User{}, false, err
	}
	if s.now().Unix() >= sess.ExpiresAt {
		return User{}, false, nil
	}
	u, err := s.store.GetUserByID(ctx, sess.UserID)
	if err != nil {
		return User{}, false, err
	}
	return u, true, nil
}

func (s *Service) RequestMagicLink(ctx context.Context, email string) error {
	email = normEmail(email)
	raw := randToken()
	now := s.now()
	tok := MagicToken{
		TokenHash: hashToken(raw),
		Email:     email,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.MagicTTL).Unix(),
	}
	if err := s.store.CreateMagicToken(ctx, tok); err != nil {
		return err
	}
	link := fmt.Sprintf("%s/api/auth/magic/verify?token=%s", s.cfg.BaseURL, url.QueryEscape(raw))
	return s.mailer.SendMagicLink(ctx, email, link)
}

func (s *Service) VerifyMagicLink(ctx context.Context, rawToken string) (Session, error) {
	tok, ok, err := s.store.UseMagicToken(ctx, hashToken(rawToken), s.now().Unix())
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, fmt.Errorf("invalid or expired token")
	}
	u, err := s.store.UpsertUserByEmail(ctx, tok.Email, "")
	if err != nil {
		return Session{}, err
	}
	if err := s.store.LinkIdentity(ctx, "email", tok.Email, u.ID); err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, u.ID)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -run 'TestMagicLinkRoundTrip|TestExpiredSession' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/service.go server/internal/account/service_test.go
git commit -m "feat(account): service core — sessions + magic link round trip"
```

---

### Task 7: HTTP handlers — magic request/verify, logout, RequireSession middleware

**Files:**
- Create: `server/internal/account/handlers.go`
- Create: `server/internal/account/handlers_test.go`

**Interfaces:**
- Consumes: `*Service`.
- Produces: `(*Service).Routes() http.Handler` returning an `*http.ServeMux` with all `/api/...` routes mounted. Cookie name constant `sessionCookie = "relayium_session"`. Middleware `(*Service).RequireSession(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc` that 401s without a valid session and otherwise calls `next` with the authenticated `User`. `setSessionCookie(w, sess)` and `clearSessionCookie(w)` helpers. This task wires: `POST /api/auth/magic/request`, `GET /api/auth/magic/verify`, `POST /api/auth/logout`. Google routes and account routes are added in Tasks 8–9 to the same `Routes()` mux.

- [ ] **Step 1: Write the failing test `handlers_test.go`**

```go
package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func newTestServer(t *testing.T) (*httptest.Server, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return ts, mail
}

func TestMagicRequestAlwaysOKAndLoginFlow(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()
	// Disable redirect following so we can inspect Set-Cookie on the verify 302.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// Request returns 200 even for a brand-new email (no enumeration).
	resp, err := client.PostForm(ts.URL+"/api/auth/magic/request", url.Values{"email": {"x@example.com"}})
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("request: %v status=%v", err, resp.StatusCode)
	}
	// Pull the token from the captured link and hit verify.
	i := strings.Index(mail.lastLink, "token=")
	token := mail.lastLink[i+len("token="):]
	resp, err = client.Get(ts.URL + "/api/auth/magic/verify?token=" + token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("verify should redirect, got %d", resp.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value == "" {
		t.Fatalf("no session cookie set")
	}

	// /api/me with the cookie returns the user.
	req, _ := http.NewRequest("GET", ts.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/api/me should be 200 with cookie, got %d", resp.StatusCode)
	}

	// Logout revokes; /api/me then 401s.
	req, _ = http.NewRequest("POST", ts.URL+"/api/auth/logout", nil)
	req.AddCookie(cookie)
	_, _ = client.Do(req)
	req, _ = http.NewRequest("GET", ts.URL+"/api/me", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/api/me after logout should be 401, got %d", resp.StatusCode)
	}
}

// placeholder to ensure context import is used if the file is trimmed during edits
var _ = context.Background
```

> Note: `/api/me` is implemented in Task 9. To keep this task independently runnable, add a **minimal** `/api/me` in this task's `Routes()` (full body in Task 9 just extends it). The handler below already includes it.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestMagicRequestAlwaysOK -v`
Expected: build failure — `Routes` undefined.

- [ ] **Step 3: Implement `handlers.go`**

```go
package account

import (
	"encoding/json"
	"net/http"
	"time"
)

const sessionCookie = "relayium_session"

func (s *Service) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/magic/request", s.handleMagicRequest)
	mux.HandleFunc("GET /api/auth/magic/verify", s.handleMagicVerify)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.RequireSession(s.handleMe))
	return mux
}

func (s *Service) setSessionCookie(w http.ResponseWriter, sess Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    sess.ID,
		Path:     "/",
		Expires:  time.Unix(sess.ExpiresAt, 0),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
}

// RequireSession wraps a handler, injecting the authenticated user or 401ing.
func (s *Service) RequireSession(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		u, ok, err := s.ValidateSession(r.Context(), c.Value)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r, u)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Service) handleMagicRequest(w http.ResponseWriter, r *http.Request) {
	email := r.FormValue("email")
	// Always respond 200, regardless of whether sending succeeds or the email is new,
	// to avoid account enumeration. Log errors server-side only.
	if email != "" {
		_ = s.RequestMagicLink(r.Context(), email)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Service) handleMagicVerify(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	sess, err := s.VerifyMagicLink(r.Context(), token)
	if err != nil {
		http.Redirect(w, r, "/?login=expired", http.StatusFound)
		return
	}
	s.setSessionCookie(w, sess)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		_ = s.store.RevokeSession(r.Context(), c.Value)
	}
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request, u User) {
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]string{"id": u.ID, "email": u.Email, "displayName": u.DisplayName},
	})
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestMagicRequestAlwaysOK -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/handlers.go server/internal/account/handlers_test.go
git commit -m "feat(account): auth HTTP handlers + RequireSession middleware"
```

---

### Task 8: Google OAuth handlers

**Files:**
- Create: `server/internal/account/oauth.go`
- Modify: `server/internal/account/handlers.go` (register routes in `Routes()`)
- Modify: `server/go.mod`, `server/go.sum` (add `golang.org/x/oauth2`)
- Create: `server/internal/account/oauth_test.go`

**Interfaces:**
- Consumes: `*Service`, `Config.Google*`.
- Produces: `(*Service).handleGoogleStart` and `(*Service).handleGoogleCallback`. A pluggable `s.fetchGoogleUser func(ctx, code string) (sub, email, name string, err error)` field on `Service` (defaults to the real oauth2 exchange in `NewService`, overridable in tests). A signed/opaque `state` is set as a short-lived cookie `relayium_oauth_state` and verified on callback.

- [ ] **Step 1: Add the oauth2 dependency**

Run:
```bash
cd server && go get golang.org/x/oauth2@latest golang.org/x/oauth2/google@latest
```
Expected: `go.mod`/`go.sum` updated.

- [ ] **Step 2: Write the failing test `oauth_test.go`** (inject a fake fetcher; no network)

```go
package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestGoogleCallbackCreatesSession(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: time.Minute,
		GoogleClientID: "cid", GoogleSecret: "sec", GoogleRedirect: "http://example.test/api/auth/google/callback",
	})
	svc.fetchGoogleUser = func(_ context.Context, code string) (string, string, string, error) {
		return "google-sub-1", "Gmail@Example.com", "Gee", nil
	}
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// Simulate the state cookie the start handler would have set.
	req, _ := http.NewRequest("GET", ts.URL+"/api/auth/google/callback?code=abc&state=s1", nil)
	req.AddCookie(&http.Cookie{Name: "relayium_oauth_state", Value: "s1"})
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected redirect, got %d", resp.StatusCode)
	}
	hasSession := false
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			hasSession = true
		}
	}
	if !hasSession {
		t.Fatalf("no session cookie after google callback")
	}
	// User exists with normalized email.
	u, ok, _ := store.GetUserByIdentity(context.Background(), "google", "google-sub-1")
	if !ok || u.Email != "gmail@example.com" {
		t.Fatalf("identity not linked/normalized: ok=%v u=%+v", ok, u)
	}
}

func TestGoogleCallbackRejectsBadState(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{BaseURL: "http://example.test", SessionTTL: time.Hour})
	svc.fetchGoogleUser = func(context.Context, string) (string, string, string, error) { return "s", "e@x.com", "n", nil }
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, _ := http.NewRequest("GET", ts.URL+"/api/auth/google/callback?code=abc&state=evil", nil)
	req.AddCookie(&http.Cookie{Name: "relayium_oauth_state", Value: "real"})
	resp, _ := client.Do(req)
	if resp.StatusCode == http.StatusFound {
		if hasSessionCookie(resp.Cookies()) {
			t.Fatalf("state mismatch must not create a session")
		}
	}
}

func hasSessionCookie(cs []*http.Cookie) bool {
	for _, c := range cs {
		if c.Name == sessionCookie && c.Value != "" {
			return true
		}
	}
	return false
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestGoogleCallback -v`
Expected: build failure — `fetchGoogleUser` undefined.

- [ ] **Step 4: Implement `oauth.go`**

```go
package account

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

func (s *Service) googleConfig() *oauth2.Config {
	return &oauth2.Config{
		ClientID:     s.cfg.GoogleClientID,
		ClientSecret: s.cfg.GoogleSecret,
		RedirectURL:  s.cfg.GoogleRedirect,
		Endpoint:     google.Endpoint,
		Scopes:       []string{"openid", "email", "profile"},
	}
}

// realFetchGoogleUser exchanges the code and reads the userinfo endpoint.
func (s *Service) realFetchGoogleUser(ctx context.Context, code string) (sub, email, name string, err error) {
	tok, err := s.googleConfig().Exchange(ctx, code)
	if err != nil {
		return "", "", "", err
	}
	client := s.googleConfig().Client(ctx, tok)
	resp, err := client.Get("https://openidconnect.googleapis.com/v1/userinfo")
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", "", fmt.Errorf("userinfo status %d", resp.StatusCode)
	}
	var info struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", "", "", err
	}
	return info.Sub, info.Email, info.Name, nil
}

const oauthStateCookie = "relayium_oauth_state"

func (s *Service) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	state := randToken()
	http.SetCookie(w, &http.Cookie{
		Name: oauthStateCookie, Value: state, Path: "/", MaxAge: 600,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, s.googleConfig().AuthCodeURL(state), http.StatusFound)
}

func (s *Service) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	stateCookie, err := r.Cookie(oauthStateCookie)
	if err != nil || stateCookie.Value == "" || stateCookie.Value != r.URL.Query().Get("state") {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	sub, email, name, err := s.fetchGoogleUser(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	u, err := s.store.UpsertUserByEmail(r.Context(), email, name)
	if err == nil {
		err = s.store.LinkIdentity(r.Context(), "google", sub, u.ID)
	}
	if err != nil {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	sess, err := s.IssueSession(r.Context(), u.ID)
	if err != nil {
		http.Redirect(w, r, "/?login=error", http.StatusFound)
		return
	}
	s.setSessionCookie(w, sess)
	http.Redirect(w, r, "/", http.StatusFound)
}
```

- [ ] **Step 5: Add the `fetchGoogleUser` field and default in `service.go`**

In `service.go`, add to the `Service` struct:
```go
	fetchGoogleUser func(ctx context.Context, code string) (sub, email, name string, err error)
```
At the end of `NewService`, before `return`, set the default:
```go
	svc := &Service{store: store, mailer: mailer, cfg: cfg, now: time.Now}
	svc.fetchGoogleUser = svc.realFetchGoogleUser
	return svc
```
(Replace the existing single-line `return &Service{...}` with the three lines above.)

- [ ] **Step 6: Register the Google routes in `handlers.go` `Routes()`**

Add inside `Routes()`:
```go
	mux.HandleFunc("GET /api/auth/google/start", s.handleGoogleStart)
	mux.HandleFunc("GET /api/auth/google/callback", s.handleGoogleCallback)
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestGoogleCallback -v`
Expected: PASS for both Google tests.

- [ ] **Step 8: Commit**

```bash
git add server/go.mod server/go.sum server/internal/account/
git commit -m "feat(account): Google OAuth start + callback with state check"
```

---

### Task 9: Device HTTP handlers (/api/devices CRUD) + full /api/me

**Files:**
- Modify: `server/internal/account/handlers.go`
- Modify: `server/internal/account/handlers_test.go`

**Interfaces:**
- Consumes: `*Service`, device `Store` methods, `RequireSession`.
- Produces: routes `GET /api/devices`, `POST /api/devices`, `PATCH /api/devices/{id}`, `DELETE /api/devices/{id}`. `POST` body JSON `{id?: string, name: string}`; if `id` empty the server generates one. `/api/me` extended to also return the device list count is **not** required — keep `/api/me` returning the user; devices are fetched via `/api/devices`.

- [ ] **Step 1: Write the failing test (append to `handlers_test.go`)**

```go
func TestDeviceCRUDOverHTTP(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// Log in via magic link to get a cookie.
	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", url.Values{"email": {"dev@example.com"}})
	i := strings.Index(mail.lastLink, "token=")
	resp, _ := client.Get(ts.URL + "/api/auth/magic/verify?token=" + mail.lastLink[i+len("token="):])
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}

	// Register a device.
	body := strings.NewReader(`{"id":"devA","name":"Laptop"}`)
	req, _ := http.NewRequest("POST", ts.URL+"/api/devices", body)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register device: %d", resp.StatusCode)
	}

	// List shows it.
	req, _ = http.NewRequest("GET", ts.URL+"/api/devices", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusOK || !bodyContains(resp, "Laptop") {
		t.Fatalf("list device missing Laptop")
	}

	// Unauthenticated list is 401.
	resp, _ = client.Get(ts.URL + "/api/devices")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth devices should be 401, got %d", resp.StatusCode)
	}

	// Delete it.
	req, _ = http.NewRequest("DELETE", ts.URL+"/api/devices/devA", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete device: %d", resp.StatusCode)
	}
}

func bodyContains(resp *http.Response, sub string) bool {
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	return strings.Contains(string(buf[:n]), sub)
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestDeviceCRUDOverHTTP -v`
Expected: FAIL — routes not registered (404, test assertions fail).

- [ ] **Step 3: Register device routes in `Routes()` and implement handlers in `handlers.go`**

Add inside `Routes()`:
```go
	mux.HandleFunc("GET /api/devices", s.RequireSession(s.handleListDevices))
	mux.HandleFunc("POST /api/devices", s.RequireSession(s.handleUpsertDevice))
	mux.HandleFunc("PATCH /api/devices/{id}", s.RequireSession(s.handleRenameDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", s.RequireSession(s.handleDeleteDevice))
```
Add handlers:
```go
func (s *Service) handleListDevices(w http.ResponseWriter, r *http.Request, u User) {
	ds, err := s.store.ListDevices(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": ds})
}

func (s *Service) handleUpsertDevice(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if in.ID == "" {
		in.ID = newID()
	}
	d, err := s.store.UpsertDevice(r.Context(), Device{
		ID: in.ID, UserID: u.ID, Name: in.Name, CreatedAt: s.now().Unix(),
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": d})
}

func (s *Service) handleRenameDevice(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Name == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.store.RenameDevice(r.Context(), r.PathValue("id"), u.ID, in.Name); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Service) handleDeleteDevice(w http.ResponseWriter, r *http.Request, u User) {
	if err := s.store.DeleteDevice(r.Context(), r.PathValue("id"), u.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -v`
Expected: PASS (all account tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/
git commit -m "feat(account): device registry HTTP CRUD"
```

---

### Task 10: Wire the account service into `main.go`

**Files:**
- Modify: `server/main.go`

**Interfaces:**
- Consumes: `account.OpenSQLite`, `account.NewService`, `account.Config`, `account.LogMailer`, `(*account.Service).Routes()`.
- Produces: the running server mounts `/api/...` routes alongside `/ws`, `/healthz`, and static serving. New flags configure DB path, base URL, Google creds, SMTP.

- [ ] **Step 1: Add flags, build the service, and mount routes in `main.go`**

Replace the body of `main()` to add account wiring (keep all existing signaling/static code). The new lines:

```go
	// after existing flags:
	dbPath := flag.String("db", "relayium.db", "SQLite database path (':memory:' for ephemeral)")
	baseURL := flag.String("base-url", "http://localhost:8080", "public base URL for links/redirects")
	googleID := flag.String("google-id", "", "Google OAuth client ID")
	googleSecret := flag.String("google-secret", "", "Google OAuth client secret")
	smtpAddr := flag.String("smtp-addr", "", "SMTP host:port (empty = log magic links instead of emailing)")
	smtpFrom := flag.String("smtp-from", "no-reply@relayium.com", "magic link From address")
	// flag.Parse() already called below in existing code
```

After `flag.Parse()` and after `hub := signal.NewHub()`, add:

```go
	store, err := account.OpenSQLite(*dbPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	var mailer account.Mailer = &account.LogMailer{Log: log.Default()}
	if *smtpAddr != "" {
		mailer = &account.SMTPMailer{Addr: *smtpAddr, From: *smtpFrom}
	}
	acct := account.NewService(store, mailer, account.Config{
		BaseURL:        *baseURL,
		SessionTTL:     720 * time.Hour, // 30 days
		MagicTTL:       15 * time.Minute,
		GoogleClientID: *googleID,
		GoogleSecret:   *googleSecret,
		GoogleRedirect: *baseURL + "/api/auth/google/callback",
	})
```

Mount the account routes BEFORE the catch-all static handler so `/api/...` wins:
```go
	mux.Handle("/api/", acct.Routes())
	// existing: mux.Handle("/", http.FileServer(...))
```

Add imports: `"time"` and `"github.com/relayium/relayium/internal/account"`.

- [ ] **Step 2: Verify it builds and existing tests pass**

Run:
```bash
cd server && go build ./... && go test ./...
```
Expected: build OK; all packages (signal + account) PASS.

- [ ] **Step 3: Smoke-test the running server manually**

Run:
```bash
cd server && go run . -db :memory: -base-url http://localhost:8080 &
sleep 1
curl -s -X POST http://localhost:8080/api/auth/magic/request -d 'email=test@example.com'
# Expect: {"status":"sent"} and the server log prints a "magic link for test@example.com: http://..." line
curl -s http://localhost:8080/api/me
# Expect: "unauthorized" (401)
kill %1
```
Expected: the JSON `{"status":"sent"}`, a logged magic link, and a 401 from `/api/me`.

- [ ] **Step 4: Add `relayium.db` to gitignore**

Add to `server/.gitignore` (create if absent):
```
relayium.db
*.db
```

- [ ] **Step 5: Commit**

```bash
git add server/main.go server/.gitignore
git commit -m "feat(server): mount account routes + SQLite store in main"
```

---

### Task 11: Frontend session state module (`auth.svelte.ts`)

**Files:**
- Create: `web/src/lib/auth.svelte.ts`
- Create: `web/src/lib/auth.test.ts`

**Interfaces:**
- Produces: a runes-based module exporting `session()` (returns `{user: {id,email,displayName} | null}`), `refreshSession(): Promise<void>` (GETs `/api/me`, sets user or null on 401), `requestMagicLink(email: string): Promise<void>` (POSTs form to `/api/auth/magic/request`), `logout(): Promise<void>` (POSTs `/api/auth/logout` then clears), `googleLoginUrl(): string` (returns `/api/auth/google/start`), and `localDeviceId(): string` (reads/creates a stable id in `localStorage`). All fetches use `credentials: "include"`.

- [ ] **Step 1: Write the failing test `auth.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { session, refreshSession, localDeviceId } from "./auth.svelte";

beforeEach(() => {
  localStorage.clear();
});

describe("auth", () => {
  it("sets user from /api/me on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: "u1", email: "a@b.com", displayName: "A" } }),
    })) as unknown as typeof fetch);
    await refreshSession();
    expect(session().user?.email).toBe("a@b.com");
  });

  it("clears user on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch);
    await refreshSession();
    expect(session().user).toBeNull();
  });

  it("localDeviceId is stable across calls", () => {
    const a = localDeviceId();
    const b = localDeviceId();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/lib/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth.svelte.ts`**

```ts
// Session + account state for Relayium, driven by Svelte 5 runes. The LAN transfer
// flow does not depend on this; login only gates future cross-network features.

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

let user = $state<SessionUser | null>(null);

export function session(): { user: SessionUser | null } {
  return { user };
}

export async function refreshSession(): Promise<void> {
  const res = await fetch("/api/me", { credentials: "include" });
  if (res.ok) {
    const body = (await res.json()) as { user: SessionUser };
    user = body.user;
  } else {
    user = null;
  }
}

export async function requestMagicLink(email: string): Promise<void> {
  const form = new URLSearchParams({ email });
  await fetch("/api/auth/magic/request", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  user = null;
}

export function googleLoginUrl(): string {
  return "/api/auth/google/start";
}

const DEVICE_KEY = "relayium_device_id";

export function localDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/lib/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/auth.svelte.ts web/src/lib/auth.test.ts
git commit -m "feat(web): auth session state module"
```

---

### Task 12: Account UI — login entry, account menu, device claim, i18n

**Files:**
- Create: `web/src/lib/Account.svelte`
- Modify: `web/src/App.svelte` (render `<Account />`, trigger device claim on login)
- Modify: `web/src/lib/i18n.svelte.ts` (add account strings to all 6 languages)

**Interfaces:**
- Consumes: `auth.svelte.ts` (`session`, `refreshSession`, `requestMagicLink`, `logout`, `googleLoginUrl`, `localDeviceId`), existing i18n `messages`/`lang`.
- Produces: an `<Account />` Svelte component rendering the login entry (when logged out) or the account menu (when logged in). On login it POSTs `/api/devices` once with `{id: localDeviceId(), name: <device name>}`.

- [ ] **Step 1: Add account i18n keys (English + Chinese shown; mirror for ja/ko/de/fr)**

In `i18n.svelte.ts`, extend the `Messages` interface:
```ts
  account: {
    signIn: string;
    signOut: string;
    email: string;
    sendLink: string;
    linkSent: string;
    continueGoogle: string;
    or: string;
    signedInAs: (email: string) => string;
  };
```
Add to the `en` object:
```ts
  account: {
    signIn: "Sign in",
    signOut: "Sign out",
    email: "Email address",
    sendLink: "Email me a sign-in link",
    linkSent: "Check your email for a sign-in link.",
    continueGoogle: "Continue with Google",
    or: "or",
    signedInAs: (e) => `Signed in as ${e}`,
  },
```
Add to the `zh` object:
```ts
  account: {
    signIn: "登录",
    signOut: "退出登录",
    email: "邮箱地址",
    sendLink: "给我发送登录链接",
    linkSent: "登录链接已发送，请查收邮箱。",
    continueGoogle: "用 Google 继续",
    or: "或",
    signedInAs: (e) => `已登录：${e}`,
  },
```
> Repeat an `account: {...}` block for `ja`, `ko`, `de`, `fr` with translated strings (keep the same keys and the `signedInAs` function signature). Use natural translations; the build's type-check will fail if any language is missing the block.

- [ ] **Step 2: Implement `Account.svelte`**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import {
    session, refreshSession, requestMagicLink, logout,
    googleLoginUrl, localDeviceId,
  } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let open = $state(false);
  let email = $state("");
  let sent = $state(false);

  // Register this browser as a device, once, after we know who the user is.
  async function claimDevice() {
    try {
      await fetch("/api/devices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: localDeviceId(), name: navigator.platform || "device" }),
      });
    } catch { /* non-fatal */ }
  }

  onMount(async () => {
    await refreshSession();
    if (session().user) claimDevice();
  });

  async function onSendLink() {
    if (!email) return;
    await requestMagicLink(email);
    sent = true;
  }

  async function onLogout() {
    await logout();
    open = false;
  }
</script>

<div class="account">
  {#if session().user}
    <button class="acct-btn" onclick={() => (open = !open)}>
      {session().user!.email}
    </button>
    {#if open}
      <div class="menu">
        <div class="who">{t.account.signedInAs(session().user!.email)}</div>
        <button class="ghost" onclick={onLogout}>{t.account.signOut}</button>
      </div>
    {/if}
  {:else}
    <button class="acct-btn" onclick={() => (open = !open)}>{t.account.signIn}</button>
    {#if open}
      <div class="menu">
        <a class="google" href={googleLoginUrl()}>{t.account.continueGoogle}</a>
        <div class="sep">{t.account.or}</div>
        {#if sent}
          <p class="hint">{t.account.linkSent}</p>
        {:else}
          <input type="email" bind:value={email} placeholder={t.account.email} />
          <button class="primary" onclick={onSendLink}>{t.account.sendLink}</button>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .account { position: absolute; top: 16px; right: 110px; font-size: 13px; }
  .acct-btn {
    padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--social-bg); color: var(--text-h); cursor: pointer; font: inherit; font-size: 13px;
  }
  .menu {
    position: absolute; right: 0; margin-top: 6px; width: 240px; z-index: 10;
    display: flex; flex-direction: column; gap: 8px;
    padding: 14px; border-radius: 12px; border: 1px solid var(--border);
    background: var(--bg); box-shadow: var(--shadow);
  }
  .menu input { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); font: inherit; background: var(--social-bg); color: var(--text-h); }
  .menu .google { text-align: center; padding: 8px; border-radius: 8px; border: 1px solid var(--border); text-decoration: none; color: var(--text-h); }
  .menu .sep { text-align: center; color: var(--text); font-size: 12px; }
  .menu .who { color: var(--text); }
  .menu .hint { color: var(--text); font-size: 13px; margin: 0; }
  @media (max-width: 1024px) { .account { right: 96px; top: 10px; } }
</style>
```

- [ ] **Step 3: Render `<Account />` in `App.svelte`**

In `App.svelte`, add the import near the other imports:
```ts
  import Account from "./lib/Account.svelte";
```
Inside `<main>`, immediately after the opening `<main>` tag (before the `<select class="lang">`), add:
```svelte
  <Account />
```

- [ ] **Step 4: Type-check and run the web test suite**

Run:
```bash
cd web && npm run check && npx vitest run
```
Expected: type-check passes (all 6 languages have the `account` block), all tests pass.

- [ ] **Step 5: Build to confirm the bundle is healthy**

Run: `cd web && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/Account.svelte web/src/lib/i18n.svelte.ts web/src/App.svelte
git commit -m "feat(web): account login UI, device claim, i18n"
```

---

## Final Verification

- [ ] **Run the full server test suite:** `cd server && go test ./...` → all PASS.
- [ ] **Run the full web test suite + type-check:** `cd web && npx vitest run && npm run check` → all PASS.
- [ ] **Build both:** `cd web && npm run build` and `cd server && go build ./...` → both succeed.
- [ ] **Manual end-to-end (LAN path unaffected):** start the server, open two browser tabs, confirm a LAN transfer still works **without logging in**.
- [ ] **Manual login (magic link):** request a link, copy it from the server log (LogMailer), open it, confirm the account menu shows the email and `/api/devices` lists the claimed browser.

## Self-Review Notes (coverage vs spec)

- Spec §2 sel(Go binary, SQLite behind Store, Google+magic, httpOnly cookie, Mailer): Tasks 1–10.
- Spec §4 data model (users/identities/sessions/magic_tokens/devices): Task 1 schema + Tasks 1–4 methods.
- Spec §5 API table: magic request/verify + logout (T7), google start/callback (T8), /me (T7), devices CRUD (T9).
- Spec §6 frontend (auth module, account menu, device claim, i18n, LAN untouched): Tasks 11–12.
- Spec §7 security (cookie attrs, OAuth state, hashed one-time magic tokens, enumeration-safe, email normalization, rate limiting): cookie attrs T7; state T8; hashed/one-time/expiry T3+T6; enumeration-safe T7; normalization T1/T6. **Rate limiting is noted in the spec but intentionally deferred** — add a follow-up note: implement per-IP/email limiting on `/api/auth/magic/request` and the OAuth callback before public launch (not blocking for this milestone's functional completion).
- Spec §8 error handling: 401 (T7 middleware), magic expired redirect (T7), oauth error redirect (T8), DB-down isolation from LAN (T10 mounts account separately from hub).
- Spec §9 testing: store CRUD (T1–4), magic lifecycle (T3/T6), session lifecycle (T2/T6), handlers (T7–9), frontend (T11), regression (Final Verification).
