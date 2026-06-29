# Cross-Network Relayed-Byte Metering (②b-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest coturn's per-allocation relay accounting from Redis into a durable, idempotent `usage_events` table keyed to the transfer token → its owning user, and surface a user's cumulative relayed bytes at `GET /api/usage`.

**Architecture:** A new `internal/metering` package isolates the Redis dependency: a `StatsSource` (Redis `PSubscribe` impl + a test fake) yields `UsageEvent`s, and a `Worker` parses the token from the coturn credential username (`"<expiry>:<token>"`), resolves the user via `account.Store.GetTransfer`, and records usage (INSERT OR IGNORE on the coturn allocation id, so redeliveries don't double-count). The `account` package gains the `usage_events` storage and a session-gated read endpoint.

**Tech Stack:** Go 1.26 (`github.com/redis/go-redis/v9` — new dep, `database/sql`, `net/http`), self-hosted coturn with `--redis-statsdb`.

## Global Constraints

- Module path: `github.com/relayium/relayium`; Go directive `go 1.26.3`.
- SQLite only via the `account.Store` interface; a Postgres swap touches only `sqlite.go`. Only `account.ErrNotFound` crosses the Store boundary (never `sql.ErrNoRows`).
- The `internal/metering` package is the ONLY place that imports Redis. The `account` package must NOT import Redis.
- Idempotency is correctness-critical: `RecordUsage` is `INSERT OR IGNORE` on `alloc_id`, so a Redis redelivery or worker restart never double-counts.
- Token extraction from a coturn username is the substring after the FIRST `:` (`strings.SplitN(username, ":", 2)`); a username without a `:` is malformed → skip.
- Relayed bytes counted = `rcvb + sentb` (both directions; reflects true relay bandwidth).
- The metering worker is OPTIONAL: it starts only when `-redis-addr` is non-empty AND the account DB is available. Its absence never affects signaling, TURN, or transfers.
- Time in the worker comes from an injected `Now func() int64` (deterministic tests); never call `time.Now()` directly in worker logic.
- `GET /api/usage` is session-gated (`RequireSession`) and READ-ONLY. No quota enforcement, no billing, no rate-limiting.
- The server never touches file content or keys; metering records only byte totals coturn reports.
- Commit after every task. Run the full package suite once before committing.

**Out of scope:** quota/billing/rate-limit, persistent device keys, trusted-device (②c), multi-TURN aggregation, time-bucketed/period usage.

---

### Task 1: `usage_events` storage (Store + SQLite)

**Files:**
- Modify: `server/internal/account/store.go` (add `UsageEvent` type + 2 interface methods)
- Modify: `server/internal/account/sqlite.go` (add table + 2 impls)
- Test: `server/internal/account/sqlite_test.go` (append tests)

**Interfaces:**
- Produces:
  - `account.UsageEvent{ AllocID, Token, UserID string; RelayedBytes, RecordedAt int64 }`.
  - `Store.RecordUsage(ctx context.Context, e UsageEvent) error` — INSERT OR IGNORE on `alloc_id`.
  - `Store.UserUsageTotal(ctx context.Context, userID string) (int64, error)` — SUM, 0 when none.

- [ ] **Step 1: Write the failing tests**

Append to `server/internal/account/sqlite_test.go`:

```go
func TestRecordUsageIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, err := s.UpsertUserByEmail(ctx, "o@example.com", "O")
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	first := UsageEvent{AllocID: "alloc1", Token: "tok", UserID: u.ID, RelayedBytes: 100, RecordedAt: 1000}
	if err := s.RecordUsage(ctx, first); err != nil {
		t.Fatalf("record 1: %v", err)
	}
	// Same alloc_id, different bytes — must be ignored, not overwrite or add.
	dup := UsageEvent{AllocID: "alloc1", Token: "tok", UserID: u.ID, RelayedBytes: 999, RecordedAt: 2000}
	if err := s.RecordUsage(ctx, dup); err != nil {
		t.Fatalf("record dup: %v", err)
	}
	total, err := s.UserUsageTotal(ctx, u.ID)
	if err != nil {
		t.Fatalf("total: %v", err)
	}
	if total != 100 {
		t.Fatalf("idempotent total = %d, want 100", total)
	}
}

func TestUserUsageTotalSumsAndDefaultsZero(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "o@example.com", "O")
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a", Token: "t", UserID: u.ID, RelayedBytes: 100, RecordedAt: 1})
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "b", Token: "t", UserID: u.ID, RelayedBytes: 250, RecordedAt: 2})
	total, err := s.UserUsageTotal(ctx, u.ID)
	if err != nil || total != 350 {
		t.Fatalf("sum total = %d (err %v), want 350", total, err)
	}
	// Unknown user → 0, no error.
	zero, err := s.UserUsageTotal(ctx, "nobody")
	if err != nil || zero != 0 {
		t.Fatalf("unknown user total = %d (err %v), want 0", zero, err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && go test ./internal/account/ -run 'Usage' -v`
Expected: compile error — `UsageEvent`/`RecordUsage`/`UserUsageTotal` undefined.

- [ ] **Step 3: Add the type + interface methods**

In `server/internal/account/store.go`, add after the `Transfer` struct:

```go
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
```

Add to the `Store` interface (after the transfers group):

```go
	// usage (cross-network relay metering)
	RecordUsage(ctx context.Context, e UsageEvent) error
	UserUsageTotal(ctx context.Context, userID string) (int64, error)
```

- [ ] **Step 4: Add the table + implement**

In `server/internal/account/sqlite.go`, append to the `schema` constant (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  alloc_id      TEXT PRIMARY KEY,
  token         TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  relayed_bytes INTEGER NOT NULL,
  recorded_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id);
```

Add the methods at the end of the file:

```go
func (s *SQLiteStore) RecordUsage(ctx context.Context, e UsageEvent) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO usage_events (alloc_id, token, user_id, relayed_bytes, recorded_at)
		 VALUES (?, ?, ?, ?, ?)`,
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'Usage' -v`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
cd server && go test ./internal/account/ && go vet ./internal/account/
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go
git commit -m "feat(account): usage_events storage (idempotent RecordUsage + UserUsageTotal)"
```

---

### Task 2: `GET /api/usage` endpoint

**Files:**
- Modify: `server/internal/account/handlers.go` (route + handler)
- Test: `server/internal/account/handlers_test.go` (append test)

**Interfaces:**
- Consumes: `Store.UserUsageTotal` (Task 1), `RequireSession`, `writeJSON`.
- Produces: `GET /api/usage` → `200 {"relayedBytes": <int>}`; `401` without a session.

- [ ] **Step 1: Write the failing test**

Append to `server/internal/account/handlers_test.go`:

```go
func TestUsageEndpointRequiresSessionAndReturnsTotal(t *testing.T) {
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute, TransferTTL: time.Hour})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// No session → 401.
	resp, err := client.Get(ts.URL + "/api/usage")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no session should be 401, got %d", resp.StatusCode)
	}

	// Log in via magic link → cookie + a known user.
	_, _ = client.PostForm(ts.URL+"/api/auth/magic/request", url.Values{"email": {"u@example.com"}})
	i := strings.Index(mail.lastLink, "token=")
	verify, _ := client.Get(ts.URL + "/api/auth/magic/verify?token=" + mail.lastLink[i+len("token="):])
	var cookie *http.Cookie
	for _, c := range verify.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("no session cookie")
	}
	u, _ := store.UpsertUserByEmail(context.Background(), "u@example.com", "")
	_ = store.RecordUsage(context.Background(), UsageEvent{AllocID: "a", Token: "t", UserID: u.ID, RelayedBytes: 500, RecordedAt: 1})

	req, _ := http.NewRequest("GET", ts.URL+"/api/usage", nil)
	req.AddCookie(cookie)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("usage: err=%v status=%v", err, resp.StatusCode)
	}
	var out struct {
		RelayedBytes int64 `json:"relayedBytes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.RelayedBytes != 500 {
		t.Fatalf("relayedBytes = %d, want 500", out.RelayedBytes)
	}
}
```

NOTE: `handlers_test.go` already imports `context`, `encoding/json`, `net/http`, `net/http/httptest`, `net/url`, `strings`, `testing`, `time` (from earlier tasks). Add any that are missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestUsageEndpoint -v`
Expected: FAIL — route 404 (handler not registered).

- [ ] **Step 3: Implement route + handler**

In `server/internal/account/handlers.go`, register in `Routes()` (after the `/api/ice` route):

```go
	mux.HandleFunc("GET /api/usage", s.RequireSession(s.handleUsage))
```

Add the handler:

```go
func (s *Service) handleUsage(w http.ResponseWriter, r *http.Request, u User) {
	total, err := s.store.UserUsageTotal(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"relayedBytes": total})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestUsageEndpoint -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd server && go test ./internal/account/ && go vet ./internal/account/
git add server/internal/account/handlers.go server/internal/account/handlers_test.go
git commit -m "feat(account): GET /api/usage (session-gated cumulative relayed bytes)"
```

---

### Task 3: `metering` package — interfaces + Worker

**Files:**
- Create: `server/internal/metering/metering.go`
- Test: `server/internal/metering/metering_test.go`

**Interfaces:**
- Consumes: `account.Transfer`, `account.UsageEvent`, `account.ErrNotFound` (Tasks 1 + ②a).
- Produces:
  - `metering.UsageEvent{ AllocID, Username string; RelayedBytes int64 }`.
  - `metering.StatsSource` interface: `Events(ctx context.Context) (<-chan UsageEvent, error)`.
  - `metering.Sink` interface: `GetTransfer(ctx, token) (account.Transfer, error)` + `RecordUsage(ctx, account.UsageEvent) error`.
  - `metering.Worker{ Sink Sink; Now func() int64; Log *log.Logger }` with `Run(ctx, src StatsSource) error`.

- [ ] **Step 1: Write the failing tests**

Create `server/internal/metering/metering_test.go`:

```go
package metering

import (
	"context"
	"io"
	"log"
	"testing"

	"github.com/relayium/relayium/internal/account"
)

type fakeSource struct{ events []UsageEvent }

func (f *fakeSource) Events(ctx context.Context) (<-chan UsageEvent, error) {
	ch := make(chan UsageEvent, len(f.events))
	for _, e := range f.events {
		ch <- e
	}
	close(ch)
	return ch, nil
}

type fakeSink struct {
	transfers map[string]account.Transfer   // token → transfer
	recorded  map[string]account.UsageEvent // alloc_id → event (mimics INSERT OR IGNORE)
}

func (f *fakeSink) GetTransfer(ctx context.Context, token string) (account.Transfer, error) {
	tr, ok := f.transfers[token]
	if !ok {
		return account.Transfer{}, account.ErrNotFound
	}
	return tr, nil
}

func (f *fakeSink) RecordUsage(ctx context.Context, e account.UsageEvent) error {
	if _, exists := f.recorded[e.AllocID]; exists {
		return nil // idempotent, like the real store
	}
	f.recorded[e.AllocID] = e
	return nil
}

func (f *fakeSink) total(userID string) int64 {
	var t int64
	for _, e := range f.recorded {
		if e.UserID == userID {
			t += e.RelayedBytes
		}
	}
	return t
}

func newWorker(sink *fakeSink) *Worker {
	return &Worker{Sink: sink, Now: func() int64 { return 1234 }, Log: log.New(io.Discard, "", 0)}
}

func runWith(t *testing.T, sink *fakeSink, events []UsageEvent) {
	t.Helper()
	if err := newWorker(sink).Run(context.Background(), &fakeSource{events: events}); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestWorkerRecordsAndAttributes(t *testing.T) {
	sink := &fakeSink{
		transfers: map[string]account.Transfer{"tok": {Token: "tok", UserID: "u1"}},
		recorded:  map[string]account.UsageEvent{},
	}
	runWith(t, sink, []UsageEvent{{AllocID: "a1", Username: "1000:tok", RelayedBytes: 1500}})
	if got := sink.total("u1"); got != 1500 {
		t.Fatalf("total = %d, want 1500", got)
	}
	if rec := sink.recorded["a1"]; rec.Token != "tok" || rec.UserID != "u1" || rec.RecordedAt != 1234 {
		t.Fatalf("recorded event wrong: %+v", rec)
	}
}

func TestWorkerSkipsUnknownToken(t *testing.T) {
	sink := &fakeSink{transfers: map[string]account.Transfer{}, recorded: map[string]account.UsageEvent{}}
	runWith(t, sink, []UsageEvent{{AllocID: "a1", Username: "1000:ghost", RelayedBytes: 100}})
	if len(sink.recorded) != 0 {
		t.Fatalf("unknown token must not record, got %+v", sink.recorded)
	}
}

func TestWorkerSkipsMalformedUsername(t *testing.T) {
	sink := &fakeSink{transfers: map[string]account.Transfer{}, recorded: map[string]account.UsageEvent{}}
	runWith(t, sink, []UsageEvent{{AllocID: "a1", Username: "nocolon", RelayedBytes: 100}})
	if len(sink.recorded) != 0 {
		t.Fatalf("malformed username must not record, got %+v", sink.recorded)
	}
}

func TestWorkerIdempotentOnAllocID(t *testing.T) {
	sink := &fakeSink{
		transfers: map[string]account.Transfer{"tok": {Token: "tok", UserID: "u1"}},
		recorded:  map[string]account.UsageEvent{},
	}
	runWith(t, sink, []UsageEvent{
		{AllocID: "a1", Username: "1000:tok", RelayedBytes: 100},
		{AllocID: "a1", Username: "1000:tok", RelayedBytes: 999},
	})
	if got := sink.total("u1"); got != 100 {
		t.Fatalf("idempotent total = %d, want 100", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && go test ./internal/metering/ -v`
Expected: compile error — package/types don't exist yet.

- [ ] **Step 3: Implement the package**

Create `server/internal/metering/metering.go`:

```go
// Package metering ingests coturn's per-allocation relay accounting and records
// it against the user who owns the transfer token. The Redis dependency lives in
// redis.go; this file is Redis-free and unit-testable with fakes.
package metering

import (
	"context"
	"log"
	"strings"

	"github.com/relayium/relayium/internal/account"
)

// UsageEvent is one coturn allocation's relay accounting as ingested from a
// StatsSource (before token→user resolution).
type UsageEvent struct {
	AllocID      string
	Username     string // coturn credential username: "<expiry>:<token>"
	RelayedBytes int64  // rcvb + sentb
}

// StatsSource yields one UsageEvent per closed coturn allocation.
type StatsSource interface {
	Events(ctx context.Context) (<-chan UsageEvent, error)
}

// Sink is the subset of account.Store the worker needs.
type Sink interface {
	GetTransfer(ctx context.Context, token string) (account.Transfer, error)
	RecordUsage(ctx context.Context, e account.UsageEvent) error
}

// Worker consumes usage events and records them. Now is injected for testability.
type Worker struct {
	Sink Sink
	Now  func() int64
	Log  *log.Logger
}

// Run consumes events until the source channel closes or ctx is cancelled.
func (w *Worker) Run(ctx context.Context, src StatsSource) error {
	ch, err := src.Events(ctx)
	if err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			w.handle(ctx, ev)
		}
	}
}

// tokenFromUsername returns the token after the first ':' in "<expiry>:<token>",
// or "" if the username is malformed.
func tokenFromUsername(username string) string {
	parts := strings.SplitN(username, ":", 2)
	if len(parts) != 2 || parts[1] == "" {
		return ""
	}
	return parts[1]
}

func (w *Worker) handle(ctx context.Context, ev UsageEvent) {
	token := tokenFromUsername(ev.Username)
	if token == "" {
		w.Log.Printf("metering: skip alloc %s, malformed username %q", ev.AllocID, ev.Username)
		return
	}
	tr, err := w.Sink.GetTransfer(ctx, token)
	if err != nil {
		w.Log.Printf("metering: skip alloc %s, unknown token: %v", ev.AllocID, err)
		return
	}
	rec := account.UsageEvent{
		AllocID:      ev.AllocID,
		Token:        token,
		UserID:       tr.UserID,
		RelayedBytes: ev.RelayedBytes,
		RecordedAt:   w.Now(),
	}
	if err := w.Sink.RecordUsage(ctx, rec); err != nil {
		w.Log.Printf("metering: record alloc %s failed: %v", ev.AllocID, err)
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/metering/ -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd server && go test ./internal/metering/ && go vet ./internal/metering/
git add server/internal/metering/metering.go server/internal/metering/metering_test.go
git commit -m "feat(metering): worker — ingest usage events, attribute token→user (idempotent)"
```

---

### Task 4: Redis `StatsSource` + parse functions

**Files:**
- Create: `server/internal/metering/redis.go`
- Test: `server/internal/metering/redis_test.go`
- Modify: `server/go.mod`, `server/go.sum` (add `github.com/redis/go-redis/v9`)

**Interfaces:**
- Consumes: `metering.UsageEvent`, `metering.StatsSource` (Task 3).
- Produces: `NewRedisSource(addr string) *RedisSource` implementing `StatsSource`; pure helpers `allocIDFromChannel`, `usernameFromChannel`, `relayedBytesFromPayload`.

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd server && go get github.com/redis/go-redis/v9
```
Expected: `github.com/redis/go-redis/v9` added to `go.mod` require block; `go.sum` updated.

- [ ] **Step 2: Write the failing tests (pure parse functions)**

Create `server/internal/metering/redis_test.go`:

```go
package metering

import "testing"

const sampleChannel = "turn/realm/relayium.app/user/1751200000:abc123def/allocation/alloc-77/total_traffic"

func TestAllocIDFromChannel(t *testing.T) {
	if got := allocIDFromChannel(sampleChannel); got != "alloc-77" {
		t.Fatalf("allocID = %q, want alloc-77", got)
	}
	if got := allocIDFromChannel("garbage"); got != "" {
		t.Fatalf("garbage channel should yield empty allocID, got %q", got)
	}
}

func TestUsernameFromChannel(t *testing.T) {
	if got := usernameFromChannel(sampleChannel); got != "1751200000:abc123def" {
		t.Fatalf("username = %q, want 1751200000:abc123def", got)
	}
}

func TestRelayedBytesFromPayload(t *testing.T) {
	// coturn total_traffic payload (key=value pairs).
	n, err := relayedBytesFromPayload("rcvp=10, rcvb=2000, sentp=8, sentb=1500")
	if err != nil || n != 3500 {
		t.Fatalf("bytes = %d (err %v), want 3500", n, err)
	}
	// Tolerant of ordering/spacing.
	n, err = relayedBytesFromPayload("sentb=1 rcvb=2")
	if err != nil || n != 3 {
		t.Fatalf("bytes = %d (err %v), want 3", n, err)
	}
	// No traffic fields → error.
	if _, err := relayedBytesFromPayload("rcvp=10, sentp=8"); err == nil {
		t.Fatalf("payload without rcvb/sentb should error")
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && go test ./internal/metering/ -run 'Channel|Payload' -v`
Expected: compile error — helpers undefined.

- [ ] **Step 4: Implement redis.go**

Create `server/internal/metering/redis.go`:

```go
package metering

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

// coturn (--redis-statsdb) publishes per-allocation totals to channels like
// turn/realm/<realm>/user/<username>/allocation/<allocId>/total_traffic
const trafficChannelPattern = "turn/realm/*/user/*/allocation/*/total_traffic"

// segAfter returns the path segment immediately following the first occurrence
// of key in a '/'-separated channel string, or "" if not present.
func segAfter(channel, key string) string {
	parts := strings.Split(channel, "/")
	for i, p := range parts {
		if p == key && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return ""
}

func allocIDFromChannel(channel string) string  { return segAfter(channel, "allocation") }
func usernameFromChannel(channel string) string { return segAfter(channel, "user") }

var (
	reRcvb  = regexp.MustCompile(`rcvb=(\d+)`)
	reSentb = regexp.MustCompile(`sentb=(\d+)`)
)

// relayedBytesFromPayload sums rcvb + sentb from a coturn traffic payload.
// Returns an error if neither field is present.
func relayedBytesFromPayload(payload string) (int64, error) {
	r := reRcvb.FindStringSubmatch(payload)
	s := reSentb.FindStringSubmatch(payload)
	if r == nil && s == nil {
		return 0, fmt.Errorf("no rcvb/sentb in payload %q", payload)
	}
	var total int64
	if r != nil {
		n, _ := strconv.ParseInt(r[1], 10, 64)
		total += n
	}
	if s != nil {
		n, _ := strconv.ParseInt(s[1], 10, 64)
		total += n
	}
	return total, nil
}

// RedisSource subscribes to coturn's traffic channel and emits UsageEvents.
type RedisSource struct {
	client *redis.Client
}

func NewRedisSource(addr string) *RedisSource {
	return &RedisSource{client: redis.NewClient(&redis.Options{Addr: addr})}
}

func (r *RedisSource) Events(ctx context.Context) (<-chan UsageEvent, error) {
	pubsub := r.client.PSubscribe(ctx, trafficChannelPattern)
	out := make(chan UsageEvent)
	go func() {
		defer close(out)
		defer pubsub.Close()
		for {
			msg, err := pubsub.ReceiveMessage(ctx)
			if err != nil {
				return // ctx cancelled or connection closed
			}
			bytes, err := relayedBytesFromPayload(msg.Payload)
			if err != nil {
				continue
			}
			ev := UsageEvent{
				AllocID:      allocIDFromChannel(msg.Channel),
				Username:     usernameFromChannel(msg.Channel),
				RelayedBytes: bytes,
			}
			select {
			case out <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out, nil
}
```

- [ ] **Step 5: Run tests + build to verify**

Run: `cd server && go test ./internal/metering/ -v && go build ./... && go vet ./internal/metering/`
Expected: parse tests PASS; the whole module builds (RedisSource compiles against go-redis); vet clean. The RedisSource subscriber itself is verified by the manual acceptance step (Task 6), not a unit test (it needs a live Redis).

- [ ] **Step 6: Commit**

```bash
git add server/internal/metering/redis.go server/internal/metering/redis_test.go server/go.mod server/go.sum
git commit -m "feat(metering): Redis StatsSource + coturn channel/payload parsers"
```

---

### Task 5: Wire the metering worker into main.go

**Files:**
- Modify: `server/main.go`

**Interfaces:**
- Consumes: `metering.Worker`, `metering.NewRedisSource` (Tasks 3-4); `*account.SQLiteStore` (satisfies `metering.Sink` via `GetTransfer` + `RecordUsage`).
- Produces: flag `-redis-addr`; starts the worker goroutine when set + DB available.

This is integration/wiring; verified by build + vet + full suite. No unit test (the worker logic is unit-tested in Task 3; the Redis subscriber needs a live Redis, covered by Task 6 manual acceptance).

- [ ] **Step 1: Add the flag**

In `server/main.go`, add to the flag block (near `-stun-urls`):

```go
	redisAddr := flag.String("redis-addr", "", "Redis host:port for coturn relay-byte metering (empty disables)")
```

Add `"context"` and `"github.com/relayium/relayium/internal/metering"` to the imports if not already present (context was added in ②a; add metering).

- [ ] **Step 2: Start the worker inside the wired branch**

In `server/main.go`, inside the `else` branch where `acct` is built (the `dbErr == nil` path), AFTER `validateRoom = acct.ValidateTransferToken`, add:

```go
		if *redisAddr != "" {
			worker := &metering.Worker{
				Sink: store,
				Now:  func() int64 { return time.Now().Unix() },
				Log:  log.Default(),
			}
			src := metering.NewRedisSource(*redisAddr)
			go func() {
				if err := worker.Run(context.Background(), src); err != nil {
					log.Printf("metering worker stopped: %v", err)
				}
			}()
			log.Printf("metering: ingesting coturn relay stats from redis %s", *redisAddr)
		}
```

(`store` here is the `*account.SQLiteStore` returned by `account.OpenSQLite`; it satisfies `metering.Sink`.)

- [ ] **Step 3: Build, vet, full suite**

Run:
```bash
cd server && go build ./... && go vet ./... && go test ./...
```
Expected: build OK; vet clean; all tests PASS (account + metering + signal).

- [ ] **Step 4: Smoke-check the server starts without Redis (metering off)**

Run:
```bash
cd server && go run . -db ':memory:' -addr ':8092' >/tmp/metering-smoke.log 2>&1 &
sleep 1.5
curl -s -o /dev/null -w "%{http_code}\n" 'http://localhost:8092/healthz'   # expect 200
kill %1 2>/dev/null
```
Expected: `200` and no crash — with no `-redis-addr`, the worker is not started and the server runs normally. (If you cannot background a server here, run it in another terminal or mark this not-run rather than fabricating.)

- [ ] **Step 5: Commit**

```bash
git add server/main.go
git commit -m "feat(server): -redis-addr starts the metering worker (optional)"
```

---

### Task 6: coturn Redis stats config + manual acceptance docs

**Files:**
- Modify: `docs/coturn.md`
- Modify: `docs/TESTING.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the Redis stats line to coturn.md**

In `docs/coturn.md`, in the "Minimal coturn config" block, add after `no-multicast-peers`:

```
# Publish per-allocation relay accounting to Redis for metering (②b-2):
redis-statsdb="ip=127.0.0.1 dbname=0 port=6379"
```

And add a short section after "Run the Go server pointing at it":

```markdown
## Relay-byte metering (②b-2)

With `redis-statsdb` set, coturn publishes per-allocation `total_traffic`
(rcvb/sentb) to Redis on the channel
`turn/realm/<realm>/user/<username>/allocation/<id>/total_traffic`. Run the Go
server with `-redis-addr <host:port>` (the same Redis) to ingest those bytes and
attribute them to the transfer's owning user. If `-redis-addr` is empty, metering
is off and transfers/TURN are unaffected.
```

- [ ] **Step 2: Add the manual acceptance section to TESTING.md**

Append to `docs/TESTING.md`:

```markdown
## Cross-network relay-byte metering (②b-2)

Prerequisites: Redis running; coturn with `redis-statsdb=...` (see `docs/coturn.md`);
the Go server started with `-redis-addr <host:port>` and matching TURN flags.

1. **Metering off (regression):** start the server WITHOUT `-redis-addr`. A
   relayed transfer still works; `/api/usage` for a logged-in user stays at 0
   (no ingestion). The server logs no metering worker.
2. **Ingestion:** with Redis + coturn + `-redis-addr` set, sign in, mint a link,
   and force a relayed transfer (`iceTransportPolicy: "relay"` or symmetric NATs).
   After the transfer completes, `GET /api/usage` returns a non-zero
   `relayedBytes` for the sender, and the value is consistent with coturn's
   reported `rcvb+sentb` for that session (check `redis-cli psubscribe
   'turn/realm/*/user/*/allocation/*/total_traffic'` while transferring).
3. **Idempotency:** restarting the Go server (re-subscribing) does not change an
   already-recorded session's contribution to `/api/usage` (alloc_id dedup).
4. **Unknown token:** a relay session whose credential token no longer maps to a
   transfer row is logged and skipped (no `/api/usage` change, no crash).
```

- [ ] **Step 3: Commit**

```bash
git add docs/coturn.md docs/TESTING.md
git commit -m "docs: coturn redis-statsdb config + metering manual acceptance"
```

---

## Self-Review

**1. Spec coverage:**
- `usage_events` table + idempotent `RecordUsage` + `UserUsageTotal` → Task 1. ✅
- `GET /api/usage` session-gated read-only → Task 2. ✅
- `metering` package isolating Redis; `StatsSource`/`Sink`/`Worker`; token-from-username; unknown-token skip; rcvb+sentb; idempotency → Tasks 3 (logic) + 4 (Redis). ✅
- Redis `--redis-statsdb` pub/sub ingestion; channel/payload parsing → Task 4. ✅
- Worker optional (only with `-redis-addr` + DB); never affects transfer/TURN → Task 5. ✅
- `Now` injected for determinism → Task 3 (`Worker.Now`) + Task 5 (real clock). ✅
- coturn redis config + manual acceptance → Task 6. ✅
- account does NOT import Redis (only `internal/metering` does) → Tasks 1-2 add no Redis import; Task 4 confines it. ✅
- token→user mapping at ingest via `GetTransfer`; transfers cleanup must be ≥ cred TTL → no cleanup is added in this slice (consistent). ✅
- Deferred (quota/billing/enforcement, ②c, multi-TURN, periods) → no task implements them; stated in header. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every command shows expected output. ✅

**3. Type consistency:** `account.UsageEvent{AllocID,Token,UserID,RelayedBytes,RecordedAt}` used identically in Tasks 1-3. `Store.RecordUsage`/`UserUsageTotal` consistent Tasks 1-2 & the metering `Sink`. `metering.UsageEvent{AllocID,Username,RelayedBytes}` consistent Tasks 3-4. `Worker{Sink,Now,Log}.Run(ctx,src)` consistent Tasks 3 & 5. `StatsSource.Events(ctx)(<-chan UsageEvent,error)` consistent Tasks 3-4. Parse helpers `allocIDFromChannel`/`usernameFromChannel`/`relayedBytesFromPayload` consistent Task 4. ✅
