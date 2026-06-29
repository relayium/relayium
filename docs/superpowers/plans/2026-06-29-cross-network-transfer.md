# Cross-Network Transfer (②a: Token-Room + STUN P2P) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user mint a one-time share link so a peer on a different network can join the same signaling room and complete one end-to-end-encrypted transfer over STUN P2P.

**Architecture:** Add a token-room rendezvous mode to `/ws`: when `?room=<token>` is present the server validates the token against a new `transfers` table and places the peer in room `"t:"+token` (capacity 2); otherwise it falls back to the existing public-IP room (LAN mode, unchanged, never touches the DB). The sender mints the token via an authenticated `POST /api/transfers`; the token rides in the URL fragment. The crypto/SAS/transfer pipeline is untouched — only rendezvous changes.

**Tech Stack:** Go 1.26 (`net/http`, `modernc.org/sqlite`, `coder/websocket`), Svelte 5 runes, Vitest, `qrcode` (new web dep).

## Global Constraints

- Module path: `github.com/relayium/relayium`; Go directive `go 1.26.3`.
- SQLite only via the `account.Store` interface; a Postgres swap must touch only `sqlite.go`. Only `account.ErrNotFound` crosses the Store boundary (never `sql.ErrNoRows`).
- The server NEVER stores or touches file content or encryption keys. The transfer layer is auth/rendezvous only.
- LAN path stays login-free and decoupled from the account DB: a request to `/ws` with **no** `room` param must never call the Store. Only `?room=` requests validate against the DB.
- Token = capability: 32-byte random hex (reuse `randToken()`); carried in the URL **fragment** (`#t=`), never a query param on the page, so it stays out of server logs / `Referer`.
- Time is injected via the Service `now func() time.Time` for deterministic tests; never call `time.Now()` directly in service logic.
- Session cookie attributes are unchanged; `POST /api/transfers` is gated by the existing `RequireSession` middleware.
- Frontend strings live in `i18n.svelte.ts` and must be added for all 6 languages (zh/en/ja/ko/de/fr).
- Commit after every task. Run the full package suite once before committing.

**Note on a deliberate scope trim vs. the spec:** the spec listed an optional `DeleteExpiredTransfers` cleanup method. This plan omits it (YAGNI for v1): expiry is enforced lazily in `ValidateTransferToken`, so stale rows simply fail validation. Row cleanup is deferred to ②b, which will `ALTER` this table anyway. This is an intentional plan-level decision, flagged here so it is not read as a silent gap.

---

### Task 1: Transfer storage (type, Store interface, SQLite table + impl)

**Files:**
- Modify: `server/internal/account/store.go` (add `Transfer` type + 2 interface methods)
- Modify: `server/internal/account/sqlite.go` (add table to `schema`, implement 2 methods)
- Test: `server/internal/account/sqlite_test.go` (append tests)

**Interfaces:**
- Produces:
  - `account.Transfer{ Token, UserID string; CreatedAt, ExpiresAt int64 }`
  - `Store.CreateTransfer(ctx context.Context, t Transfer) error`
  - `Store.GetTransfer(ctx context.Context, token string) (Transfer, error)` — returns `ErrNotFound` when absent.

- [ ] **Step 1: Write the failing tests**

Append to `server/internal/account/sqlite_test.go`:

```go
func TestCreateAndGetTransfer(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, err := s.UpsertUserByEmail(ctx, "owner@example.com", "Owner")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	want := Transfer{Token: "tok123", UserID: u.ID, CreatedAt: 1000, ExpiresAt: 4600}
	if err := s.CreateTransfer(ctx, want); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := s.GetTransfer(ctx, "tok123")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got != want {
		t.Fatalf("roundtrip mismatch: got %+v want %+v", got, want)
	}
}

func TestGetTransferMissingReturnsErrNotFound(t *testing.T) {
	s := newTestStore(t)
	_, err := s.GetTransfer(context.Background(), "nope")
	if err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && go test ./internal/account/ -run 'Transfer' -v`
Expected: compile error / FAIL — `Transfer` type and `CreateTransfer`/`GetTransfer` undefined.

- [ ] **Step 3: Add the type and interface methods**

In `server/internal/account/store.go`, add the type after the `Device` struct:

```go
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
```

Add to the `Store` interface, after the devices group:

```go
	// transfers (cross-network rendezvous)
	CreateTransfer(ctx context.Context, t Transfer) error
	GetTransfer(ctx context.Context, token string) (Transfer, error)
```

- [ ] **Step 4: Add the table and implement the methods**

In `server/internal/account/sqlite.go`, append to the `schema` constant (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS transfers (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers(user_id);
```

Add the methods at the end of the file:

```go
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'Transfer' -v`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
cd server && go test ./internal/account/ && go vet ./internal/account/
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go
git commit -m "feat(account): add transfers table + Store CRUD for rendezvous tokens"
```

---

### Task 2: Transfer service (TTL config, mint, validate)

**Files:**
- Modify: `server/internal/account/service.go` (add `Config.TransferTTL`, `CreateTransfer`, `ValidateTransferToken`)
- Test: `server/internal/account/service_test.go` (append tests)

**Interfaces:**
- Consumes: `Store.CreateTransfer`, `Store.GetTransfer` (Task 1); existing `randToken()`, `Service.now`.
- Produces:
  - `Config.TransferTTL time.Duration`
  - `(*Service).CreateTransfer(ctx context.Context, userID string) (Transfer, error)`
  - `(*Service).ValidateTransferToken(ctx context.Context, token string) bool` — true only if the token exists and `now < expiresAt`; fails closed on any store error or empty token.

- [ ] **Step 1: Write the failing tests**

Append to `server/internal/account/service_test.go` (it already constructs services; mirror the existing helper style — if a `newTestService`-like helper exists, reuse it; otherwise build inline as below):

```go
func TestCreateAndValidateTransferToken(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{TransferTTL: time.Hour})
	base := time.Unix(1_000_000, 0)
	svc.now = func() time.Time { return base }

	u, err := store.UpsertUserByEmail(context.Background(), "o@example.com", "O")
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	tr, err := svc.CreateTransfer(context.Background(), u.ID)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if tr.Token == "" || tr.UserID != u.ID {
		t.Fatalf("bad transfer: %+v", tr)
	}
	if tr.ExpiresAt != base.Add(time.Hour).Unix() {
		t.Fatalf("expiry not derived from now+TTL: %d", tr.ExpiresAt)
	}
	if !svc.ValidateTransferToken(context.Background(), tr.Token) {
		t.Fatalf("fresh token should validate")
	}
}

func TestValidateTransferTokenRejectsExpiredEmptyAndUnknown(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{TransferTTL: time.Hour})
	base := time.Unix(1_000_000, 0)
	svc.now = func() time.Time { return base }
	u, _ := store.UpsertUserByEmail(context.Background(), "o@example.com", "O")
	tr, _ := svc.CreateTransfer(context.Background(), u.ID)

	if svc.ValidateTransferToken(context.Background(), "") {
		t.Fatalf("empty token must be invalid")
	}
	if svc.ValidateTransferToken(context.Background(), "unknown") {
		t.Fatalf("unknown token must be invalid")
	}
	// Advance past expiry.
	svc.now = func() time.Time { return base.Add(2 * time.Hour) }
	if svc.ValidateTransferToken(context.Background(), tr.Token) {
		t.Fatalf("expired token must be invalid")
	}
}
```

NOTE: `capturingMailer` already exists in the test package (used by `newTestServer`). If `service_test.go` lacks the `context`/`time` imports, add them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && go test ./internal/account/ -run 'TransferToken' -v`
Expected: compile error — `CreateTransfer`/`ValidateTransferToken`/`Config.TransferTTL` undefined.

- [ ] **Step 3: Implement**

In `server/internal/account/service.go`, add to the `Config` struct:

```go
	TransferTTL    time.Duration
```

Add the methods (place near `IssueSession`):

```go
// CreateTransfer mints a one-time rendezvous token bound to userID.
func (s *Service) CreateTransfer(ctx context.Context, userID string) (Transfer, error) {
	now := s.now()
	t := Transfer{
		Token:     randToken(),
		UserID:    userID,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.TransferTTL).Unix(),
	}
	if err := s.store.CreateTransfer(ctx, t); err != nil {
		return Transfer{}, err
	}
	return t, nil
}

// ValidateTransferToken reports whether token names a live (existing, unexpired)
// rendezvous room. Fails closed on empty input or any store error.
func (s *Service) ValidateTransferToken(ctx context.Context, token string) bool {
	if token == "" {
		return false
	}
	t, err := s.store.GetTransfer(ctx, token)
	if err != nil {
		return false
	}
	return s.now().Unix() < t.ExpiresAt
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'TransferToken' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd server && go test ./internal/account/ && go vet ./internal/account/
git add server/internal/account/service.go server/internal/account/service_test.go
git commit -m "feat(account): mint + validate cross-network transfer tokens"
```

---

### Task 3: `POST /api/transfers` endpoint

**Files:**
- Modify: `server/internal/account/handlers.go` (route + handler)
- Test: `server/internal/account/handlers_test.go` (append test)

**Interfaces:**
- Consumes: `(*Service).CreateTransfer` (Task 2), existing `RequireSession`, `writeJSON`.
- Produces: `POST /api/transfers` → `200 {"token": string, "expiresAt": number}`; `401` without a session.

- [ ] **Step 1: Write the failing test**

Append to `server/internal/account/handlers_test.go`:

```go
func TestCreateTransferRequiresSessionAndReturnsToken(t *testing.T) {
	ts, mail := newTestServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// Without a session cookie → 401.
	resp, err := client.Post(ts.URL+"/api/transfers", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no session should be 401, got %d", resp.StatusCode)
	}

	// Log in via magic link to get a session cookie.
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
		t.Fatalf("no session cookie from verify")
	}

	// With the session → 200 + a non-empty token.
	req, _ := http.NewRequest("POST", ts.URL+"/api/transfers", nil)
	req.AddCookie(cookie)
	resp, err = client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("create: err=%v status=%v", err, resp.StatusCode)
	}
	var out struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Token == "" || out.ExpiresAt == 0 {
		t.Fatalf("expected token+expiresAt, got %+v", out)
	}
}
```

NOTE: `newTestServer` builds its Service with `Config{BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute}`. Add `TransferTTL: time.Hour` to that literal so minted tokens don't expire instantly. Ensure `encoding/json` is imported in the test file (add if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'CreateTransferRequiresSession' -v`
Expected: FAIL — route returns 404 (handler not registered).

- [ ] **Step 3: Implement route + handler**

In `server/internal/account/handlers.go`, register the route in `Routes()` (after the devices routes):

```go
	mux.HandleFunc("POST /api/transfers", s.RequireSession(s.handleCreateTransfer))
```

Add the handler:

```go
func (s *Service) handleCreateTransfer(w http.ResponseWriter, r *http.Request, u User) {
	t, err := s.CreateTransfer(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     t.Token,
		"expiresAt": t.ExpiresAt,
	})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run 'CreateTransferRequiresSession' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd server && go test ./internal/account/ && go vet ./internal/account/
git add server/internal/account/handlers.go server/internal/account/handlers_test.go
git commit -m "feat(account): POST /api/transfers endpoint (session-gated)"
```

---

### Task 4: Hub room capacity (`JoinLimited`)

**Files:**
- Modify: `server/internal/signal/hub.go` (add `JoinLimited`, make `Join` delegate)
- Test: `server/internal/signal/hub_test.go` (append test)

**Interfaces:**
- Produces: `(*Hub).JoinLimited(room, id, name string, c Conn, max int) bool` — admits unless the room already has `max` peers (`max <= 0` = unlimited); returns `false` without joining when full. Existing `Join` keeps its 4-arg signature and delegates with `max=0`.

- [ ] **Step 1: Write the failing test**

Append to `server/internal/signal/hub_test.go`:

```go
func TestJoinLimitedEnforcesCapacity(t *testing.T) {
	h := NewHub()
	a, b, c := &fakeConn{}, &fakeConn{}, &fakeConn{}
	if !h.JoinLimited("t:room", "a", "A", a, 2) {
		t.Fatalf("first join should be admitted")
	}
	if !h.JoinLimited("t:room", "b", "B", b, 2) {
		t.Fatalf("second join should be admitted")
	}
	if h.JoinLimited("t:room", "c", "C", c, 2) {
		t.Fatalf("third join must be rejected at capacity 2")
	}
	// The rejected peer received no welcome.
	if len(c.sent) != 0 {
		t.Fatalf("rejected peer must get no messages, got %+v", c.sent)
	}
	// The room still has exactly the two admitted peers in its roster.
	if got := b.last(); got.Type != TypePeers || len(got.Peers) != 2 {
		t.Fatalf("roster should be 2 after rejection: %+v", got)
	}
}

func TestJoinUnlimitedAllowsMany(t *testing.T) {
	h := NewHub()
	for _, id := range []string{"a", "b", "c", "d"} {
		if !h.JoinLimited("ip1", id, id, &fakeConn{}, 0) {
			t.Fatalf("max=0 must allow %s", id)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run 'JoinLimited|JoinUnlimited' -v`
Expected: compile error — `JoinLimited` undefined.

- [ ] **Step 3: Implement**

In `server/internal/signal/hub.go`, replace the existing `Join` method with:

```go
func (h *Hub) Join(room, id, name string, c Conn) {
	h.JoinLimited(room, id, name, c, 0)
}

// JoinLimited admits a peer unless the room already holds max peers (max <= 0
// means unlimited). Returns false without joining when the room is full.
func (h *Hub) JoinLimited(room, id, name string, c Conn, max int) bool {
	h.mu.Lock()
	if h.rooms[room] == nil {
		h.rooms[room] = make(map[string]*peer)
	}
	if max > 0 && len(h.rooms[room]) >= max {
		h.mu.Unlock()
		return false
	}
	h.rooms[room][id] = &peer{id: id, name: name, conn: c}
	h.mu.Unlock()

	c.Send(Envelope{Type: TypeWelcome, Name: id})
	h.broadcastRoster(room)
	return true
}
```

(The `if h.rooms[room] == nil` branch only creates an empty map when the room is new, in which case `len == 0 < max`, so no empty map is ever left behind on rejection.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/signal/ -run 'JoinLimited|JoinUnlimited' -v`
Expected: PASS. Then run the whole signal suite to confirm existing tests still pass: `go test ./internal/signal/`.

- [ ] **Step 5: Commit**

```bash
cd server && go test ./internal/signal/ && go vet ./internal/signal/
git add server/internal/signal/hub.go server/internal/signal/hub_test.go
git commit -m "feat(signal): room capacity via Hub.JoinLimited (Join delegates, max=0)"
```

---

### Task 5: `/ws` token-room resolution (ServeWS + main wiring)

**Files:**
- Modify: `server/internal/signal/client.go` (`ServeWS` handler gains `maxPeers`, uses `JoinLimited`)
- Modify: `server/main.go` (`/ws` resolves token-room vs IP-room; validates token; passes capacity)

**Interfaces:**
- Consumes: `(*Hub).JoinLimited` (Task 4), `(*Service).ValidateTransferToken` (Task 2), `signal.RoomKey`.
- Produces: `ServeWS(h *Hub, idgen func() string) func(ctx context.Context, c *websocket.Conn, room string, maxPeers int)` — the returned handler now takes a `maxPeers` argument.

This task is integration/wiring. The capacity logic it relies on is unit-tested in Task 4 and token validation in Task 2; `ServeWS` itself needs a live `*websocket.Conn` and is verified by `go build` + `go vet` + the manual acceptance run (Task 10). There is no `ServeWS` unit test today; do not add one.

- [ ] **Step 1: Update `ServeWS`**

In `server/internal/signal/client.go`, change the returned function signature and the join call:

```go
// ServeWS handles one websocket client for its whole lifetime.
func ServeWS(h *Hub, idgen func() string) func(ctx context.Context, c *websocket.Conn, room string, maxPeers int) {
	return func(ctx context.Context, c *websocket.Conn, room string, maxPeers int) {
		id := idgen()
		conn := &wsConn{ctx: ctx, c: c}
		joined := false
		defer func() {
			if joined {
				h.Leave(room, id)
			}
		}()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			e, err := DecodeEnvelope(data)
			if err != nil {
				continue
			}
			switch e.Type {
			case TypeJoin:
				if !joined {
					if h.JoinLimited(room, id, e.Name, conn, maxPeers) {
						joined = true
					} else {
						return // room full — close the connection
					}
				}
			case TypeSignal:
				e.From = id
				h.Relay(room, e)
			}
		}
	}
}
```

- [ ] **Step 2: Wire room resolution in `main.go`**

In `server/main.go`:

1. Add `"context"` to the import block.
2. Declare a validator before the DB branch and set it only when the account service is wired:

Replace the account-wiring block so it reads:

```go
	store, dbErr := account.OpenSQLite(*dbPath)

	// validateRoom gates token-rooms. Nil (DB unavailable) => token-rooms are
	// rejected, but LAN rooms (no ?room=) are unaffected.
	var validateRoom func(context.Context, string) bool
```

Then inside the existing `else` branch (where `acct` is created), after building `acct` and before/after mounting routes, add:

```go
		validateRoom = acct.ValidateTransferToken
```

and add `TransferTTL: time.Hour,` to the `account.Config{...}` literal.

3. Replace the `/ws` handler with token-aware resolution:

```go
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		var room string
		var maxPeers int
		if token := r.URL.Query().Get("room"); token != "" {
			if validateRoom == nil || !validateRoom(r.Context(), token) {
				http.Error(w, "invalid or expired transfer link", http.StatusForbidden)
				return
			}
			room = "t:" + token
			maxPeers = 2 // sender + receiver
		} else {
			room = signal.RoomKey(r)
			maxPeers = 0 // LAN: unlimited
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		handle(ctx, c, room, maxPeers)
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
```

- [ ] **Step 3: Build + vet + full server suite**

Run:
```bash
cd server && go build ./... && go vet ./... && go test ./...
```
Expected: build OK; vet clean; all tests PASS (account + signal).

- [ ] **Step 4: Smoke-check token rejection manually (no DB row → 403)**

Run the server against an in-memory DB and confirm an unknown token is refused while LAN `/ws` still upgrades:
```bash
cd server && go run . -db ':memory:' -addr ':8099' &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZQ==" \
  'http://localhost:8099/ws?room=bogus'   # expect 403
curl -s -o /dev/null -w "%{http_code}\n" 'http://localhost:8099/healthz'  # expect 200
kill %1
```
Expected: `403` for the bogus token, `200` for healthz. (If the background job control differs in your shell, run the server in one terminal and the curls in another.)

- [ ] **Step 5: Commit**

```bash
git add server/internal/signal/client.go server/main.go
git commit -m "feat(server): token-room resolution on /ws (validate token, cap at 2)"
```

---

### Task 6: Web `transfer-link` module (parse, build, ws URL, create)

**Files:**
- Create: `web/src/lib/transfer-link.ts`
- Test: `web/src/lib/transfer-link.test.ts`

**Interfaces:**
- Produces:
  - `parseTransferToken(hash: string): string` — token from `#t=<token>` or `""`.
  - `buildTransferLink(origin: string, token: string): string` → `"<origin>/#t=<token>"`.
  - `wsURL(loc: { protocol: string; host: string }, token: string): string` — `ws(s)://host/ws[?room=token]`.
  - `createTransfer(): Promise<{ token: string; expiresAt: number }>` — `POST /api/transfers` with credentials.

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/transfer-link.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseTransferToken,
  buildTransferLink,
  wsURL,
  createTransfer,
} from "./transfer-link";

describe("parseTransferToken", () => {
  it("extracts the token from #t=", () => {
    expect(parseTransferToken("#t=abc123")).toBe("abc123");
  });
  it("returns empty for no hash or other hashes", () => {
    expect(parseTransferToken("")).toBe("");
    expect(parseTransferToken("#")).toBe("");
    expect(parseTransferToken("#other=1")).toBe("");
    expect(parseTransferToken("#t=")).toBe("");
  });
});

describe("buildTransferLink", () => {
  it("puts the token in the fragment", () => {
    expect(buildTransferLink("https://relayium.app", "tok")).toBe(
      "https://relayium.app/#t=tok",
    );
  });
});

describe("wsURL", () => {
  it("uses wss on https and appends room when token present", () => {
    expect(wsURL({ protocol: "https:", host: "relayium.app" }, "tok")).toBe(
      "wss://relayium.app/ws?room=tok",
    );
  });
  it("uses ws on http and omits room when no token", () => {
    expect(wsURL({ protocol: "http:", host: "localhost:8080" }, "")).toBe(
      "ws://localhost:8080/ws",
    );
  });
});

describe("createTransfer", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("POSTs with credentials and returns the parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "tok", expiresAt: 123 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await createTransfer();
    expect(out).toEqual({ token: "tok", expiresAt: 123 });
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers", {
      method: "POST",
      credentials: "include",
    });
  });
  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(createTransfer()).rejects.toThrow("401");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/transfer-link.test.ts`
Expected: FAIL — module `./transfer-link` not found.

- [ ] **Step 3: Implement the module**

Create `web/src/lib/transfer-link.ts`:

```ts
// One-time cross-network transfer link: a rendezvous room token carried in the
// URL fragment (#t=<token>) so it never reaches server logs or the Referer
// header. The token is minted by the (authenticated) sender via POST
// /api/transfers; anyone holding the link can join the room (capability model).

/** Extract the transfer token from a location hash like "#t=abc". "" if none. */
export function parseTransferToken(hash: string): string {
  const m = /^#t=([A-Za-z0-9]+)$/.exec(hash);
  return m ? m[1] : "";
}

/** Build the shareable link for a token against the given origin. */
export function buildTransferLink(origin: string, token: string): string {
  return `${origin}/#t=${token}`;
}

/** Construct the signaling websocket URL, appending ?room= for a token-room. */
export function wsURL(
  loc: { protocol: string; host: string },
  token: string,
): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${loc.host}/ws`;
  return token ? `${base}?room=${encodeURIComponent(token)}` : base;
}

/** Mint a rendezvous token. Requires an authenticated session (cookie). */
export async function createTransfer(): Promise<{
  token: string;
  expiresAt: number;
}> {
  const res = await fetch("/api/transfers", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`createTransfer failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/transfer-link.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
cd web && npm run check
git add web/src/lib/transfer-link.ts web/src/lib/transfer-link.test.ts
git commit -m "feat(web): transfer-link module (parse/build/wsURL/createTransfer)"
```

---

### Task 7: SignalingClient close callback + i18n + App token-room wiring

**Files:**
- Modify: `web/src/lib/signaling.ts` (add `onClose`)
- Test: `web/src/lib/signaling.test.ts` (append test)
- Modify: `web/src/lib/i18n.svelte.ts` (add `crossnet` block to interface + all 6 languages)
- Modify: `web/src/App.svelte` (build ws URL via `wsURL`, detect token, surface close-before-join as an error)

**Interfaces:**
- Consumes: `wsURL`, `parseTransferToken` (Task 6).
- Produces: `(SignalingClient).onClose(cb: () => void): void` — invoked when the socket closes; the `crossnet` i18n block (consumed by Task 8's component).

**Ordering note:** i18n is added here, before any consumer, so both the App dead-link banner (this task) and the CrossNetwork component (Task 8) can reference `t.crossnet.*` and keep `npm run check` green.

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/signaling.test.ts` (mirror the existing `WebSocketLike` fake in that file — it exposes `onopen/onmessage/onclose` and lets the test trigger them):

```ts
it("invokes onClose when the socket closes", () => {
  const sock = makeFakeSock(); // existing helper/fake in this file
  const c = new SignalingClient("ws://x", "Alice", () => sock);
  let closed = false;
  c.onClose(() => (closed = true));
  sock.onclose?.();
  expect(closed).toBe(true);
});
```

NOTE: reuse whatever fake-socket construction the existing tests use (they call `new SignalingClient("ws://x", "Alice", () => sock)`). If there is no `makeFakeSock` helper, build the `sock` object inline with `onopen/onmessage/onclose` fields exactly as the existing tests do.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/signaling.test.ts`
Expected: FAIL — `onClose` is not a function.

- [ ] **Step 3: Implement `onClose`**

In `web/src/lib/signaling.ts`, add a field and wire the socket:

```ts
  private closeCb: (() => void) | null = null;
```

In the constructor, after `this.sock.onmessage = ...`, add:

```ts
    this.sock.onclose = () => this.closeCb?.();
```

Add the method (near `onSelfId`):

```ts
  onClose(cb: () => void) { this.closeCb = cb; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/signaling.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Add crossnet i18n strings**

In `web/src/lib/i18n.svelte.ts`, add to the `Messages` interface (after the `account` block):

```ts
  crossnet: {
    sendAcross: string;
    loginFirst: string;
    shareHint: string;
    copy: string;
    copied: string;
    connecting: string;
    linkDead: string;
  };
```

Add a matching `crossnet` object to EACH of `zh`, `en`, `ja`, `ko`, `de`, `fr` (place it next to each `account` block). Use these translations:

```ts
// zh
  crossnet: {
    sendAcross: "发送到其他网络的人",
    loginFirst: "请先登录后再发起跨网络传输",
    shareHint: "把下面的链接发给对方；对方打开后，在下方核对 6 位校验码即可传输",
    copy: "复制链接",
    copied: "已复制",
    connecting: "正在通过跨网络链接连接…",
    linkDead: "链接已失效或正在被使用，请向发送方索要新链接",
  },
// en
  crossnet: {
    sendAcross: "Send to someone on another network",
    loginFirst: "Please sign in before starting a cross-network transfer",
    shareHint: "Send this link to the other person; once they open it, verify the 6-digit code below to transfer",
    copy: "Copy link",
    copied: "Copied",
    connecting: "Connecting over the cross-network link…",
    linkDead: "This link is invalid or already in use — ask the sender for a new one",
  },
// ja
  crossnet: {
    sendAcross: "別のネットワークの相手に送る",
    loginFirst: "ネットワーク間転送を始める前にサインインしてください",
    shareHint: "このリンクを相手に送ってください。相手が開いたら、下の6桁コードを確認して転送します",
    copy: "リンクをコピー",
    copied: "コピーしました",
    connecting: "ネットワーク間リンクで接続中…",
    linkDead: "リンクが無効か使用中です。送信者に新しいリンクを依頼してください",
  },
// ko
  crossnet: {
    sendAcross: "다른 네트워크의 상대에게 보내기",
    loginFirst: "네트워크 간 전송을 시작하려면 먼저 로그인하세요",
    shareHint: "이 링크를 상대에게 보내세요. 상대가 열면 아래 6자리 코드를 확인하여 전송합니다",
    copy: "링크 복사",
    copied: "복사됨",
    connecting: "네트워크 간 링크로 연결 중…",
    linkDead: "링크가 유효하지 않거나 사용 중입니다. 보낸 사람에게 새 링크를 요청하세요",
  },
// de
  crossnet: {
    sendAcross: "An jemanden in einem anderen Netzwerk senden",
    loginFirst: "Bitte melde dich an, bevor du eine netzwerkübergreifende Übertragung startest",
    shareHint: "Sende diesen Link an die andere Person; sobald sie ihn öffnet, bestätige den 6-stelligen Code unten zur Übertragung",
    copy: "Link kopieren",
    copied: "Kopiert",
    connecting: "Verbindung über den netzwerkübergreifenden Link…",
    linkDead: "Dieser Link ist ungültig oder bereits in Gebrauch — bitte den Absender um einen neuen",
  },
// fr
  crossnet: {
    sendAcross: "Envoyer à quelqu'un sur un autre réseau",
    loginFirst: "Veuillez vous connecter avant de lancer un transfert inter-réseaux",
    shareHint: "Envoyez ce lien à l'autre personne ; une fois ouvert, vérifiez le code à 6 chiffres ci-dessous pour transférer",
    copy: "Copier le lien",
    copied: "Copié",
    connecting: "Connexion via le lien inter-réseaux…",
    linkDead: "Ce lien est invalide ou déjà utilisé — demandez-en un nouveau à l'expéditeur",
  },
```

- [ ] **Step 6: Wire token-room into App.svelte**

In `web/src/App.svelte`:

Add imports near the top script:

```ts
  import { parseTransferToken, wsURL } from "./lib/transfer-link";
```

Add a reactive token + connection-failure state with the other `let` declarations:

```ts
  let roomToken = $state("");
  let joinedRoom = $state(false);
  let linkDead = $state(false);
```

In `onMount`, replace the two ws-URL lines:

```ts
    roomToken = parseTransferToken(location.hash);
    signaling = new SignalingClient(wsURL(location, roomToken), selfName);
    signaling.onSelfId((id) => { selfId = id; joinedRoom = true; });
    signaling.onPeers((p) => (peers = p));
    signaling.onClose(() => {
      // In a token-room, a close before we ever joined means the link was
      // invalid/expired or the room was full.
      if (roomToken && !joinedRoom) linkDead = true;
    });
    listenForIncoming();
    connState = "ready";
```

Add a `linkDead` banner near the top of the template (above the main UI). The `t.crossnet.linkDead` string exists from Step 5:

```svelte
  {#if linkDead}
    <p class="notice error">{t.crossnet.linkDead}</p>
  {/if}
```

- [ ] **Step 7: Verify check + tests**

Run: `cd web && npx vitest run && npm run check`
Expected: tests PASS; check reports 0 errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/signaling.ts web/src/lib/signaling.test.ts web/src/lib/i18n.svelte.ts web/src/App.svelte
git commit -m "feat(web): token-room wiring, crossnet i18n, dead-link banner"
```

---

### Task 8: CrossNetwork component (share-link UI)

**Files:**
- Create: `web/src/lib/CrossNetwork.svelte`
- Modify: `web/src/App.svelte` (render `<CrossNetwork {roomToken} />`)

**Interfaces:**
- Consumes: `session()` from `auth.svelte.ts`, `createTransfer`/`buildTransferLink` from `transfer-link.ts`, `t.crossnet.*` strings (added in Task 7), `roomToken` state (Task 7).
- Produces: a self-contained UI unit; no exports consumed by other tasks.

- [ ] **Step 1: Create the CrossNetwork component**

Create `web/src/lib/CrossNetwork.svelte`. It marks the originator via `sessionStorage` keyed by the token, then reloads into token-room mode so all the existing mount wiring is reused:

```svelte
<script lang="ts">
  import { session } from "./auth.svelte";
  import { createTransfer, buildTransferLink } from "./transfer-link";
  import { messages, lang, type Messages } from "./i18n.svelte";

  let { roomToken = "" }: { roomToken?: string } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const ORIGIN_KEY = "relayium_xfer_token";
  const isOriginator = $derived(
    !!roomToken && sessionStorage.getItem(ORIGIN_KEY) === roomToken,
  );
  const shareLink = $derived(
    roomToken ? buildTransferLink(location.origin, roomToken) : "",
  );

  let busy = $state(false);
  let copied = $state(false);
  let err = $state("");

  async function start() {
    err = "";
    if (!session()) {
      err = t.crossnet.loginFirst;
      return;
    }
    busy = true;
    try {
      const { token } = await createTransfer();
      sessionStorage.setItem(ORIGIN_KEY, token);
      location.hash = `t=${token}`;
      location.reload();
    } catch {
      busy = false;
      err = t.crossnet.linkDead;
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(shareLink);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<section class="crossnet">
  {#if isOriginator}
    <p>{t.crossnet.shareHint}</p>
    <div class="row">
      <input readonly value={shareLink} />
      <button onclick={copy}>{copied ? t.crossnet.copied : t.crossnet.copy}</button>
    </div>
  {:else if roomToken}
    <p>{t.crossnet.connecting}</p>
  {:else}
    <button onclick={start} disabled={busy}>{t.crossnet.sendAcross}</button>
    {#if err}<p class="error">{err}</p>{/if}
  {/if}
</section>
```

- [ ] **Step 2: Render it in App.svelte**

In `web/src/App.svelte`, add the import:

```ts
  import CrossNetwork from "./lib/CrossNetwork.svelte";
```

Render it just after `<Account />` (or near the main panel), passing the token:

```svelte
  <CrossNetwork {roomToken} />
```

- [ ] **Step 3: Verify check, tests, build**

Run: `cd web && npm run check && npx vitest run && npm run build`
Expected: check 0 errors; tests PASS; build OK.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/CrossNetwork.svelte web/src/App.svelte
git commit -m "feat(web): cross-network send share-link UI component"
```

---

### Task 9: QR code in the share panel

**Files:**
- Modify: `web/package.json` / `web/package-lock.json` (add `qrcode` + `@types/qrcode`)
- Modify: `web/src/lib/CrossNetwork.svelte` (render a QR image of the share link, lazily)

**Interfaces:**
- Consumes: the `shareLink` derived value (Task 8).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd web && npm install qrcode && npm install -D @types/qrcode
```
Expected: `qrcode` added to `dependencies`, `@types/qrcode` to `devDependencies`; lock file updated.

- [ ] **Step 2: Render the QR lazily**

In `web/src/lib/CrossNetwork.svelte`, add inside `<script>`:

```ts
  let qrDataUrl = $state("");
  $effect(() => {
    if (isOriginator && shareLink) {
      // Lazy-load qrcode so it stays out of the main bundle path.
      import("qrcode").then((m) =>
        m.toDataURL(shareLink, { margin: 1, width: 192 }).then((u) => (qrDataUrl = u)),
      );
    } else {
      qrDataUrl = "";
    }
  });
```

In the `{#if isOriginator}` block, after the link row, add:

```svelte
    {#if qrDataUrl}
      <img class="qr" src={qrDataUrl} alt="QR" width="192" height="192" />
    {/if}
```

- [ ] **Step 3: Verify check + build**

Run: `cd web && npm run check && npm run build`
Expected: check 0 errors; build OK (the `qrcode` import becomes its own lazy chunk).

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/CrossNetwork.svelte
git commit -m "feat(web): QR code for the cross-network share link (lazy-loaded)"
```

---

### Task 10: Manual acceptance documentation

**Files:**
- Modify: `docs/TESTING.md` (add a cross-network acceptance section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the cross-network acceptance flow**

Append a section to `docs/TESTING.md`:

```markdown
## Cross-network transfer (②a: token-room + STUN P2P)

Prerequisites: server running with a working DB and a logged-in sender. For a
real cross-network test, the two machines must be on different networks (e.g.
laptop on Wi-Fi, phone on cellular). STUN-only means symmetric-NAT pairs may
fail to connect — that fallback is ②b (TURN), out of scope here.

1. **Mint a link (sender, logged in):** open the app, sign in, click
   "Send to someone on another network". A share link (and QR) appears; the page
   reloads into token-room mode.
2. **Open the link (receiver, different network):** open the link (or scan the
   QR). The receiver connects to the same room.
3. **Verify SAS:** both sides see the 6-digit code; confirm they match.
4. **Transfer:** sender picks files and sends; receiver accepts and downloads.
   Confirm the per-file SHA-256 integrity check passes.
5. **Dead-link check:** open `https://<host>/#t=deadbeef` (a bogus token). Expect
   the "link invalid or in use" banner and no connection.
6. **Capacity check:** with a sender + receiver already in a room, open the same
   link in a third tab. Expect it to be refused (room full).
7. **LAN regression:** open the app on two devices on the SAME network with NO
   `#t=` in the URL. Confirm they still discover each other and transfer
   (login-free), proving the LAN path is unaffected.
```

- [ ] **Step 2: Commit**

```bash
git add docs/TESTING.md
git commit -m "docs(testing): cross-network transfer manual acceptance steps"
```

---

## Self-Review

**1. Spec coverage:**
- Two rendezvous modes + `/ws` resolution → Task 5. ✅
- `transfers` table + Store methods → Task 1. ✅
- `POST /api/transfers` (session-gated) → Task 3. ✅
- Token mint/validate with `now` injection + TTL → Task 2. ✅
- Room capacity 2 → Tasks 4 (logic+test) & 5 (wiring). ✅
- Token in URL fragment + share link + QR → Tasks 6, 8, 9. ✅
- Receiver auto-join from `#t=` + dead-link UX → Tasks 6, 7, 8. ✅
- LAN path untouched & DB-decoupled → enforced in Task 5 (no `?room=` ⇒ no Store call) + Task 10 regression step. ✅
- SAS/crypto/transfer unchanged → no task touches `crypto.ts`/`transfer.ts`; confirmed by omission. ✅
- i18n 6 languages → Task 7 (added before any consumer). ✅
- Testing (Go store/service/handler/hub; web unit; manual acceptance) → Tasks 1–4, 6, 7, 10. ✅
- Deferred (TURN/metering ②b, trusted-device ②c, billing) → out of scope, stated in plan header + Task 10 note. ✅
- `DeleteExpiredTransfers` intentionally trimmed → flagged in Global Constraints note. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every command shows expected output. ✅

**3. Type consistency:** `Transfer{Token,UserID,CreatedAt,ExpiresAt}` used identically in Tasks 1–3. `JoinLimited(room,id,name,c,max) bool` consistent across Tasks 4–5. `ValidateTransferToken(ctx,token) bool` consistent Tasks 2 & 5. `wsURL`/`parseTransferToken`/`createTransfer`/`buildTransferLink` signatures consistent across Tasks 6–9. `crossnet` i18n keys used in Tasks 7–9 all defined in Task 7. ✅
```

