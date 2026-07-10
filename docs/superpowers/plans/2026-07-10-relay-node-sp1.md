# SP1 — Self-Reporting Relay Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single-purpose `relayium-node` binary (pion/turn relay) that self-registers to the central server over authenticated HTTPS, counts bytes it relays per allocation, and heartbeats those counts home — where the central server ingests them through the existing `RecordUsage` accounting, hands live nodes out in `/api/ice`, and shows per-node telemetry in the admin dashboard.

**Architecture:** The node runs a pion/turn v4 server. A custom `RelayAddressGenerator` wraps each allocated relay `net.PacketConn` in a byte-counter keyed by its relay address; pion's `EventHandler.OnAllocationCreated` supplies the `relayAddr → TURN-username` join so each counter is attributed to `owner.code`. A report agent POSTs cumulative counts to new central endpoints `/api/nodes/register` + `/api/nodes/heartbeat` (bearer-token auth). The central heartbeat handler parses usernames with a shared helper and calls the existing keep-max `RecordUsage`, so per-user quota accrues exactly as with coturn. `/api/ice` unions online registered nodes with the legacy static pool.

**Tech Stack:** Go (module root `server/`, `github.com/relayium/relayium`, CGO off), `github.com/pion/turn/v4`, modernc.org/sqlite, html/template (admin), goreleaser + POSIX `sh` installer.

## Global Constraints

- Module root is `server/`; all Go import paths are `github.com/relayium/relayium/...` (NOT `.../server/...`). Run `go build`/`go test` from `server/`.
- CGO stays off; the node must be a single static binary. Only add pure-Go deps. pin `github.com/pion/turn/v4@v4.1.4`.
- ID generation uses `crypto/rand` → hex (mirror `newID()` in `internal/account/sqlite.go:225`).
- TURN-REST credential = `base64(HMAC-SHA1(secret, username))`, username = `"<expiry>:<owner>.<code>"` — identical to `turnCredentials` in `internal/account/turn.go:130`. Do not invent a new scheme.
- SQLite runs with `SetMaxOpenConns(1)` (existing); no schema change may add a UNIQUE constraint that breaks existing rows.
- Node endpoints are bearer-authenticated (not cookie/CSRF); they mount on the ROOT mux in `main.go` (like `POST /api/pair`), NOT inside `acct.Routes()` (which wraps everything in `csrfGuard`).
- Reply/comment language: match surrounding file (existing admin templates + comments are Chinese; Go comments in `internal/account` are English — follow each file's local convention).

---

## File Structure

**New files:**
- `server/internal/relayusage/parse.go` (+ `parse_test.go`) — shared TURN-username parsing (extracted from `internal/metering`).
- `server/internal/account/nodes.go` (+ `nodes_test.go`) — `Node` HTTP handlers, request/response types, bearer auth, mount helper.
- `server/cmd/relayium-node/main.go` — node entrypoint + config.
- `server/cmd/relayium-node/state.go` (+ `state_test.go`) — `state.json` load/save, secret/id generation.
- `server/cmd/relayium-node/counter.go` (+ `counter_test.go`) — counting `net.PacketConn` wrapper + allocation registry.
- `server/cmd/relayium-node/report.go` (+ `report_test.go`) — register/heartbeat HTTP client (report agent).
- `server/cmd/relayium-node/relay.go` — pion/turn server wiring (counter + auth + events).
- `web/public/install-node.sh` — one-command installer.

**Modified files:**
- `server/internal/metering/metering.go` — delegate `tokenFromUsername`/`splitAttrib` to `relayusage`.
- `server/internal/account/store.go` — `Node` struct + 4 Store-interface methods.
- `server/internal/account/sqlite.go` — `nodes` table + method implementations.
- `server/internal/account/service.go` — `Config.NodeToken` field.
- `server/internal/account/turn.go` — `/api/ice` dynamic pool.
- `server/internal/account/admin.go` + `admin_templates.go` — Nodes section.
- `server/main.go` — flag/env `-node-token`, mount node endpoints on root mux.
- `.goreleaser.yaml` — `relayium-node` build + archive.

---

## Task 1: Shared TURN-username parse helper (`relayusage`)

DRY foundation: the central heartbeat handler must parse `"<expiry>:<owner>.<code>"` exactly as the metering worker does. Extract the two helpers into a shared package and make metering call it — one source of truth.

**Files:**
- Create: `server/internal/relayusage/parse.go`
- Test: `server/internal/relayusage/parse_test.go`
- Modify: `server/internal/metering/metering.go:80-99` (replace the two unexported funcs with calls to the new package)

**Interfaces:**
- Produces: `relayusage.TokenFromUsername(username string) string`; `relayusage.SplitAttrib(token string) (userID, code string)`.

- [ ] **Step 1: Write the failing test**

`server/internal/relayusage/parse_test.go`:
```go
package relayusage

import "testing"

func TestTokenFromUsername(t *testing.T) {
	cases := map[string]string{
		"1730000000:userABC.123456": "userABC.123456",
		"1730000000:123456":         "123456",
		"noselector":                "",
		"1730000000:":               "",
		"":                          "",
	}
	for in, want := range cases {
		if got := TokenFromUsername(in); got != want {
			t.Errorf("TokenFromUsername(%q)=%q want %q", in, got, want)
		}
	}
}

func TestSplitAttrib(t *testing.T) {
	uid, code := SplitAttrib("userABC.123456")
	if uid != "userABC" || code != "123456" {
		t.Fatalf("got (%q,%q)", uid, code)
	}
	uid, code = SplitAttrib("123456") // legacy anonymous, no dot
	if uid != "" || code != "123456" {
		t.Fatalf("legacy got (%q,%q)", uid, code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/relayusage/`
Expected: FAIL — package/functions do not exist.

- [ ] **Step 3: Write the implementation**

`server/internal/relayusage/parse.go`:
```go
// Package relayusage parses coturn/pion TURN-REST usernames into their billing
// attribution parts. Shared by the metering worker (Redis path) and the node
// heartbeat handler (HTTPS path) so username parsing has one source of truth.
package relayusage

import "strings"

// TokenFromUsername returns the token after the first ':' in "<expiry>:<token>",
// or "" if the username is malformed.
func TokenFromUsername(username string) string {
	parts := strings.SplitN(username, ":", 2)
	if len(parts) != 2 || parts[1] == "" {
		return ""
	}
	return parts[1]
}

// SplitAttrib splits a token "<userID>.<code>" into its parts. A token with no
// '.' (legacy anonymous codes) yields ("", token), keeping global relay
// accounting working without attribution.
func SplitAttrib(token string) (userID, code string) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", token
}
```

- [ ] **Step 4: Point metering at the shared helper**

In `server/internal/metering/metering.go`: delete the local `tokenFromUsername` and `splitAttrib` funcs (lines ~80-99) and add the import `"github.com/relayium/relayium/internal/relayusage"`. In `handle`, replace the two call sites:
```go
	token := relayusage.TokenFromUsername(ev.Username)
	if token == "" {
		w.Log.Printf("metering: skip alloc %s, malformed username %q", ev.AllocID, ev.Username)
		return
	}
	userID, code := relayusage.SplitAttrib(token)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./internal/relayusage/ ./internal/metering/`
Expected: PASS (metering tests still green — behaviour unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/internal/relayusage server/internal/metering/metering.go
git commit -m "refactor(metering): extract TURN-username parsing into shared relayusage pkg"
```

---

## Task 2: `nodes` table + `Node` type + store methods

**Files:**
- Modify: `server/internal/account/store.go` (add `Node` struct + 4 interface methods)
- Modify: `server/internal/account/sqlite.go` (schema + implementations; schema block near line 19-104, `newID` at line 225)
- Test: `server/internal/account/nodes_store_test.go`

**Interfaces:**
- Produces:
  - `type Node struct { ID, OwnerType, OwnerUserID, Region string; URLs []string; TURNSecret, Version string; RelayedBytes, StoredBytes, CreatedAt, LastSeenAt int64 }`
  - `UpsertNode(ctx context.Context, n Node) (Node, error)` — insert (assign id via `newID()` when `n.ID==""`, set `CreatedAt`/`LastSeenAt` from `n` if non-zero else caller sets) or update existing id. Returns the stored row.
  - `TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, at int64) error` — set `last_seen_at=at`, keep-max the two counters.
  - `OnlineNodes(ctx context.Context, since int64) ([]Node, error)` — `owner_type='fleet' AND last_seen_at >= since`.
  - `ListNodes(ctx context.Context) ([]Node, error)` — all rows, `ORDER BY last_seen_at DESC`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/nodes_store_test.go`:
```go
package account

import (
	"context"
	"testing"
)

// NOTE: `newTestStore(t) *SQLiteStore` already exists in sqlite_test.go
// (OpenSQLite(":memory:") + cleanup). Reuse it — do NOT redefine it here, or the
// package won't compile.

func TestUpsertAndListNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, err := st.UpsertNode(ctx, Node{
		OwnerType: "fleet", Region: "asia", URLs: []string{"turn:1.2.3.4:3478"},
		TURNSecret: "sek", Version: "0.3.0", CreatedAt: 1000, LastSeenAt: 1000,
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if n.ID == "" {
		t.Fatal("expected assigned id")
	}
	// Update by id: change region, keep row count at 1.
	n.Region = "eu"
	if _, err := st.UpsertNode(ctx, n); err != nil {
		t.Fatalf("upsert update: %v", err)
	}
	all, err := st.ListNodes(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 1 || all[0].Region != "eu" || len(all[0].URLs) != 1 {
		t.Fatalf("got %+v", all)
	}
}

func TestTouchNodeKeepMaxAndOnline(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err := st.TouchNode(ctx, n.ID, 500, 0, 2000); err != nil {
		t.Fatalf("touch: %v", err)
	}
	// keep-max: a lower relayed value must not decrease the stored counter.
	if err := st.TouchNode(ctx, n.ID, 300, 0, 2500); err != nil {
		t.Fatalf("touch2: %v", err)
	}
	online, err := st.OnlineNodes(ctx, 2400) // since 2400 -> last_seen 2500 qualifies
	if err != nil {
		t.Fatalf("online: %v", err)
	}
	if len(online) != 1 || online[0].RelayedBytes != 500 {
		t.Fatalf("got %+v", online)
	}
	if got, _ := st.OnlineNodes(ctx, 3000); len(got) != 0 {
		t.Fatal("node should be offline for since=3000")
	}
}
```
(If `NewSQLiteStore`'s constructor name/signature differs, match the existing one used by other `_test.go` files in this package.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'Node'`
Expected: FAIL — `Node`, `UpsertNode`, etc. undefined.

- [ ] **Step 3: Add the `Node` struct + interface methods**

In `server/internal/account/store.go`, add near the other row structs:
```go
// Node is one registered relay node (SP1: fleet-owned pion/turn relay). urls are
// the node's turn: URLs; turn_secret is its static-auth-secret (so /api/ice can
// mint ephemeral credentials it will validate). relayed_bytes/stored_bytes are the
// node's own cumulative, keep-max counters fed from heartbeats.
type Node struct {
	ID           string
	OwnerType    string // "fleet" (SP3 adds "user")
	OwnerUserID  string // "" for fleet
	Region       string
	URLs         []string
	TURNSecret   string
	Version      string
	RelayedBytes int64
	StoredBytes  int64
	CreatedAt    int64
	LastSeenAt   int64
}
```
In the `Store interface` block, add (near the usage section):
```go
	// relay nodes (self-reporting fleet telemetry)
	UpsertNode(ctx context.Context, n Node) (Node, error)
	TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, at int64) error
	OnlineNodes(ctx context.Context, since int64) ([]Node, error)
	ListNodes(ctx context.Context) ([]Node, error)
```

- [ ] **Step 4: Add the schema + implementations**

In `server/internal/account/sqlite.go`, append to the `CREATE TABLE IF NOT EXISTS` schema string block:
```sql
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
```
Add the methods (encode `URLs` as JSON in the `urls` column):
```go
func (s *SQLiteStore) UpsertNode(ctx context.Context, n Node) (Node, error) {
	if n.ID == "" {
		n.ID = newID()
	}
	urls, err := json.Marshal(n.URLs)
	if err != nil {
		return Node{}, err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO nodes (id, owner_type, owner_user_id, region, urls, turn_secret, version, relayed_bytes, stored_bytes, created_at, last_seen_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET
		   owner_type=excluded.owner_type, owner_user_id=excluded.owner_user_id,
		   region=excluded.region, urls=excluded.urls, turn_secret=excluded.turn_secret,
		   version=excluded.version, last_seen_at=excluded.last_seen_at`,
		n.ID, n.OwnerType, nullStr(n.OwnerUserID), n.Region, string(urls), n.TURNSecret,
		n.Version, n.RelayedBytes, n.StoredBytes, n.CreatedAt, n.LastSeenAt)
	if err != nil {
		return Node{}, err
	}
	return n, nil
}

func (s *SQLiteStore) TouchNode(ctx context.Context, id string, relayedBytes, storedBytes, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET last_seen_at=?,
		   relayed_bytes=MAX(relayed_bytes, ?), stored_bytes=MAX(stored_bytes, ?)
		 WHERE id=?`, at, relayedBytes, storedBytes, id)
	return err
}

func (s *SQLiteStore) OnlineNodes(ctx context.Context, since int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT id, owner_type, owner_user_id, region, urls, turn_secret, version, relayed_bytes, stored_bytes, created_at, last_seen_at
		   FROM nodes WHERE owner_type='fleet' AND last_seen_at >= ? ORDER BY last_seen_at DESC`, since)
}

func (s *SQLiteStore) ListNodes(ctx context.Context) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT id, owner_type, owner_user_id, region, urls, turn_secret, version, relayed_bytes, stored_bytes, created_at, last_seen_at
		   FROM nodes ORDER BY last_seen_at DESC`)
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
		if err := rows.Scan(&n.ID, &n.OwnerType, &ownerUser, &n.Region, &urls, &n.TURNSecret,
			&n.Version, &n.RelayedBytes, &n.StoredBytes, &n.CreatedAt, &n.LastSeenAt); err != nil {
			return nil, err
		}
		n.OwnerUserID = ownerUser.String
		if err := json.Unmarshal([]byte(urls), &n.URLs); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
```
If `nullStr` does not already exist in this file, add it (used to store `""` owner as SQL NULL):
```go
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
```
Ensure `encoding/json`, `database/sql` are imported (they are used elsewhere in the package; add to `sqlite.go`'s import block if missing).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'Node'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/nodes_store_test.go
git commit -m "feat(account): nodes table + Upsert/Touch/Online/List store methods"
```

---

## Task 3: Central register + heartbeat handlers

**Files:**
- Create: `server/internal/account/nodes.go`
- Test: `server/internal/account/nodes_test.go`
- Modify: `server/internal/account/service.go` (add `Config.NodeToken string`)
- Modify: `server/main.go` (flag `-node-token`, mount endpoints on root mux)

**Interfaces:**
- Consumes: `relayusage.TokenFromUsername`/`SplitAttrib` (Task 1); `store.UpsertNode`/`TouchNode`, `store.RecordUsage` (existing `UsageEvent{AllocID,Token,UserID,RelayedBytes,RecordedAt}`).
- Produces: `func (s *Service) RegisterNodeRoutes(mux *http.ServeMux)` — mounts `POST /api/nodes/register` and `POST /api/nodes/heartbeat` only when `s.cfg.NodeToken != ""`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/nodes_test.go`:
```go
package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func nodeService(t *testing.T, token string) *Service {
	t.Helper()
	st := newTestStore(t)
	s := &Service{store: st, cfg: Config{NodeToken: token}, now: func() time.Time { return time.Unix(5000, 0) }}
	return s
}

func TestNodeRegisterAuth(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	body, _ := json.Marshal(nodeRegisterReq{TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Region: "asia", Version: "0.3.0", Capabilities: []string{"relay"}})

	// Missing token -> 401.
	r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d", w.Code)
	}

	// Correct token -> 200 + assigned id.
	r = httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("register: got %d", w.Code)
	}
	var resp nodeRegisterResp
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.NodeID == "" || resp.HeartbeatInterval != 30 {
		t.Fatalf("resp %+v", resp)
	}
}

func TestNodeHeartbeatRecordsUsage(t *testing.T) {
	s := nodeService(t, "fleet-secret")
	// register first
	n, _ := s.store.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	hb := nodeHeartbeatReq{
		NodeID: n.ID, Status: "ok", RelayedTotal: 900, StoredBytes: 0,
		Usage: []nodeUsage{{AllocID: "a1", Username: "6000:userX.123456", RelayedBytes: 900}},
	}
	body, _ := json.Marshal(hb)
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat: got %d body=%s", w.Code, w.Body)
	}
	// RecordUsage attributed 900 bytes to userX.
	got, err := s.store.UserRelayedSince(context.Background(), "userX", 0)
	if err != nil {
		t.Fatalf("relayed: %v", err)
	}
	if got != 900 {
		t.Fatalf("attributed %d want 900", got)
	}
	// Unknown node -> 410.
	hb.NodeID = "nope"
	body, _ = json.Marshal(hb)
	r = httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusGone {
		t.Fatalf("unknown node: got %d", w.Code)
	}
}
```
(Add `"time"` to imports. If `Service` struct literal fields differ — e.g. `now` is set another way — construct it the way other tests in this package do; the essential inputs are `store`, `cfg.NodeToken`, and a fixed `now`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'TestNode(Register|Heartbeat)'`
Expected: FAIL — `RegisterNodeRoutes`, request types undefined.

- [ ] **Step 3: Add `Config.NodeToken`**

In `server/internal/account/service.go`, add to the `Config` struct (near `TURNRelays`):
```go
	// NodeToken is the fleet bootstrap bearer token relay nodes present to
	// /api/nodes/*. Empty disables the node API (endpoints return 404).
	NodeToken string
```

- [ ] **Step 4: Implement the handlers**

`server/internal/account/nodes.go`:
```go
package account

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/relayium/relayium/internal/relayusage"
)

// nodeHeartbeatInterval is the seconds a node waits between heartbeats. The
// /api/ice online window is 3x this (see nodeOnlineWindow in turn.go).
const nodeHeartbeatInterval = 30

type nodeRegisterReq struct {
	NodeID       string   `json:"nodeID"`
	TURNSecret   string   `json:"turnSecret"`
	URLs         []string `json:"urls"`
	Region       string   `json:"region"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

type nodeRegisterResp struct {
	NodeID            string `json:"nodeID"`
	HeartbeatInterval int    `json:"heartbeatInterval"`
}

type nodeUsage struct {
	AllocID      string `json:"allocID"`
	Username     string `json:"username"`
	RelayedBytes int64  `json:"relayedBytes"`
}

type nodeHeartbeatReq struct {
	NodeID       string      `json:"nodeID"`
	Status       string      `json:"status"`
	Usage        []nodeUsage `json:"usage"`
	RelayedTotal int64       `json:"relayedTotal"`
	StoredBytes  int64       `json:"storedBytes"`
}

// RegisterNodeRoutes mounts the node register/heartbeat endpoints on mux, but
// only when a fleet NodeToken is configured. They are bearer-authenticated and
// therefore mount on the root mux (bypassing the cookie CSRF guard).
func (s *Service) RegisterNodeRoutes(mux *http.ServeMux) {
	if s.cfg.NodeToken == "" {
		return
	}
	mux.HandleFunc("POST /api/nodes/register", s.handleNodeRegister)
	mux.HandleFunc("POST /api/nodes/heartbeat", s.handleNodeHeartbeat)
}

// nodeAuthorized constant-time-compares the request's bearer token to NodeToken.
func (s *Service) nodeAuthorized(r *http.Request) bool {
	if s.cfg.NodeToken == "" {
		return false
	}
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.NodeToken)) == 1
}

func (s *Service) handleNodeRegister(w http.ResponseWriter, r *http.Request) {
	if !s.nodeAuthorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req nodeRegisterReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.TURNSecret == "" || len(req.URLs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "turnSecret and urls required"})
		return
	}
	now := s.now().Unix()
	n := Node{
		ID: req.NodeID, OwnerType: "fleet", Region: req.Region, URLs: req.URLs,
		TURNSecret: req.TURNSecret, Version: req.Version, CreatedAt: now, LastSeenAt: now,
	}
	saved, err := s.store.UpsertNode(r.Context(), n)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	writeJSON(w, http.StatusOK, nodeRegisterResp{NodeID: saved.ID, HeartbeatInterval: nodeHeartbeatInterval})
}

func (s *Service) handleNodeHeartbeat(w http.ResponseWriter, r *http.Request) {
	if !s.nodeAuthorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	var req nodeHeartbeatReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	if req.NodeID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "nodeID required"})
		return
	}
	// A node unknown to us (DB reset / never registered) is told to re-register
	// with 410 Gone. We check existence via ListNodes (fleet is dozens of rows);
	// swap for a GetNode(id) store method if the fleet ever grows large.
	nodes, err := s.store.ListNodes(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	known := false
	for _, n := range nodes {
		if n.ID == req.NodeID {
			known = true
			break
		}
	}
	if !known {
		writeJSON(w, http.StatusGone, map[string]string{"error": "unknown node, re-register"})
		return
	}
	now := s.now().Unix()
	if err := s.store.TouchNode(r.Context(), req.NodeID, req.RelayedTotal, req.StoredBytes, now); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	// Attribute per-allocation relayed bytes through the existing keep-max path.
	for _, u := range req.Usage {
		token := relayusage.TokenFromUsername(u.Username)
		if token == "" {
			continue
		}
		userID, code := relayusage.SplitAttrib(token)
		if err := s.store.RecordUsage(r.Context(), UsageEvent{
			AllocID: u.AllocID, Token: code, UserID: userID,
			RelayedBytes: u.RelayedBytes, RecordedAt: now,
		}); err != nil {
			// Log-and-continue: one bad alloc must not drop the rest.
			log.Printf("node %s heartbeat: record alloc %s failed: %v", req.NodeID, u.AllocID, err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "heartbeatInterval": nodeHeartbeatInterval})
}
```
Ensure `log` is imported in `nodes.go`.

- [ ] **Step 5: Wire into `main.go`**

In `server/main.go`: add the flag near the other TURN flags (line ~80-84):
```go
	nodeToken := flag.String("node-token", envStr("RELAYIUM_NODE_TOKEN", ""), "fleet bootstrap bearer token for relay-node /api/nodes/* (empty disables the node API)")
```
Add `NodeToken: *nodeToken,` to the `account.Config{...}` literal (near line 216). After `acct` is built and `acct.Routes()` is mounted, mount the node routes on the ROOT mux (mirroring the `POST /api/pair` precedent) — add near the `mux.HandleFunc("POST /api/pair", ...)` block:
```go
	acct.RegisterNodeRoutes(mux)
```

- [ ] **Step 6: Run tests + build to verify**

Run: `cd server && go test ./internal/account/ -run 'TestNode' && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/nodes.go server/internal/account/nodes_test.go server/internal/account/service.go server/main.go
git commit -m "feat(account): node register/heartbeat API reusing RecordUsage; wire NodeToken"
```

---

## Task 4: `/api/ice` dynamic pool (online nodes ∪ static)

**Files:**
- Modify: `server/internal/account/turn.go` (the `validCode && len(s.cfg.TURNRelays) > 0` block, lines 99-117)
- Test: `server/internal/account/turn_nodes_test.go`

**Interfaces:**
- Consumes: `store.OnlineNodes(ctx, since)` (Task 2); existing `turnCredentials`, `relayEntry`.
- Produces: constant `nodeOnlineWindow = 90 * time.Second`; the `relays` response now includes online fleet nodes.

- [ ] **Step 1: Write the failing test**

`server/internal/account/turn_nodes_test.go`:
```go
package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestICEIncludesOnlineNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)

	// handleICE denies relay for an unverified owner or one over the relay quota.
	// Seed a verified user and use its id as the pairing-code owner so those two
	// upstream gates pass and we actually reach the relay-pool builder.
	owner, err := st.UpsertUserByEmail(ctx, "u@example.com", "u")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := st.SetEmailVerified(ctx, owner.ID); err != nil {
		t.Fatalf("verify user: %v", err)
	}

	// One online node (last_seen just now) and one offline (stale).
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "n-online", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "n-stale", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: now.Unix() - 1000})

	// RelayMonthlyFree must be > 0 or the quota gate denies (used 0 >= 0). It is
	// read via resolveSettings, which falls back to cfg when the settings table is
	// empty.
	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"}, RelayMonthlyFree: 1 << 30}}
	s.pairCodeOwner = func(code string) (string, bool) { return owner.ID, true }

	r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
	w := httptest.NewRecorder()
	s.handleICE(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("ice: %d", w.Code)
	}
	var resp struct {
		Relays []relayEntry `json:"relays"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	ids := map[string]bool{}
	for _, e := range resp.Relays {
		ids[e.ID] = true
	}
	if !ids["n-online"] {
		t.Fatalf("expected online node in relays, got %+v", resp.Relays)
	}
	if ids["n-stale"] {
		t.Fatalf("stale node must be excluded, got %+v", resp.Relays)
	}
}
```
(If `handleICE`'s `resolveSettings` needs a seeded settings row rather than falling back to `cfg.RelayMonthlyFree`, call `s.SeedSettings(ctx)` after constructing `s`, or set the relay quota through whatever path the existing settings tests use. The invariant: the owner is verified and under quota so the pool builder runs. `iceLimiter` is nil here, so the H1 rate-limit gate is skipped.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestICEIncludesOnlineNodes`
Expected: FAIL — online node not present (only static relays emitted today).

- [ ] **Step 3: Implement the dynamic pool**

In `server/internal/account/turn.go`, add the constant near the top:
```go
// nodeOnlineWindow bounds how long since its last heartbeat a node is still
// offered in the pool. 3x the node heartbeat interval (nodeHeartbeatInterval).
const nodeOnlineWindow = 90 * time.Second
```
Replace the static-only `relays` block (lines ~99-117) with a union builder:
```go
	// Multi-relay pool: online self-registered fleet nodes ∪ legacy static
	// RELAYIUM_TURN_RELAYS. Each entry carries its own ephemeral credential so the
	// client can measure RTT and pick the fastest. Dynamic nodes win a shared id.
	if validCode {
		relays := make([]relayEntry, 0)
		seen := map[string]bool{}

		since := now.Add(-nodeOnlineWindow).Unix()
		if nodes, err := s.store.OnlineNodes(r.Context(), since); err != nil {
			log.Printf("ice: OnlineNodes read failed: %v (falling back to static pool)", err)
		} else {
			for _, n := range nodes {
				if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 {
					continue
				}
				relays = append(relays, relayEntry{
					ID:         n.ID,
					Region:     n.Region,
					ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)},
				})
				seen[n.ID] = true
			}
		}

		for _, rc := range s.cfg.TURNRelays {
			if rc.ID == "" || rc.Secret == "" || len(rc.URLs) == 0 || seen[rc.ID] {
				continue // skip misconfigured or already-covered-by-a-dynamic-node
			}
			relays = append(relays, relayEntry{
				ID:         rc.ID,
				Region:     rc.Region,
				STUN:       rc.STUN,
				ICEServers: []ICEServer{turnCredentials(rc.Secret, token, expiry, rc.URLs)},
			})
		}
		if len(relays) > 0 {
			resp["relays"] = relays
		}
	}
```
Add `"time"` to the imports if not present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'TestICE'`
Expected: PASS (both the new node test and any existing ICE tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/turn.go server/internal/account/turn_nodes_test.go
git commit -m "feat(ice): dynamic TURN pool from online fleet nodes, union with static relays"
```

---

## Task 5: Admin dashboard Nodes section

**Files:**
- Modify: `server/internal/account/admin.go` (`handleAdminHome` — populate node views)
- Modify: `server/internal/account/admin_templates.go` (`adminHomeData` + template markup)
- Test: `server/internal/account/admin_nodes_test.go`

**Interfaces:**
- Consumes: `store.ListNodes` (Task 2), `nodeOnlineWindow` (Task 4).
- Produces: `adminNodeView` render struct on `adminHomeData.Nodes`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/admin_nodes_test.go`:
```go
package account

import (
	"context"
	"testing"
	"time"
)

func TestNodeViewsOnlineFlag(t *testing.T) {
	now := time.Unix(10000, 0)
	nodes := []Node{
		{ID: "fresh", LastSeenAt: now.Unix() - 10, RelayedBytes: 100},
		{ID: "stale", LastSeenAt: now.Unix() - 1000},
	}
	views := nodeViews(nodes, now)
	if len(views) != 2 {
		t.Fatalf("want 2 views")
	}
	if !views[0].Online {
		t.Fatal("fresh node should be online")
	}
	if views[1].Online {
		t.Fatal("stale node should be offline")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestNodeViewsOnlineFlag`
Expected: FAIL — `nodeViews`/`adminNodeView` undefined.

- [ ] **Step 3: Add the view builder**

In `server/internal/account/admin.go`, add:
```go
// adminNodeView is a Node prepared for the admin template (online flag derived
// from last_seen against nodeOnlineWindow).
type adminNodeView struct {
	ID           string
	Region       string
	Version      string
	Online       bool
	RelayedBytes int64
	StoredBytes  int64
	LastSeenAt   int64
}

func nodeViews(nodes []Node, now time.Time) []adminNodeView {
	cutoff := now.Add(-nodeOnlineWindow).Unix()
	out := make([]adminNodeView, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, adminNodeView{
			ID: n.ID, Region: n.Region, Version: n.Version,
			Online:       n.LastSeenAt >= cutoff,
			RelayedBytes: n.RelayedBytes, StoredBytes: n.StoredBytes, LastSeenAt: n.LastSeenAt,
		})
	}
	return out
}
```

- [ ] **Step 4: Populate + render**

In `handleAdminHome` (`admin.go`), before building `data`, fetch nodes (fail-soft — a node read error must not 500 the whole dashboard):
```go
	var nodeVs []adminNodeView
	if ns, nerr := s.store.ListNodes(r.Context()); nerr != nil {
		log.Printf("admin: ListNodes failed: %v", nerr)
	} else {
		nodeVs = nodeViews(ns, s.now())
	}
```
Add `Nodes []adminNodeView` to `adminHomeData` (in `admin_templates.go`) and set `Nodes: nodeVs,` in the `data := adminHomeData{...}` literal.

In `admin_templates.go`, add a section after the `cards` section (after line ~110), using the existing `bytes` template func:
```html
<section class="nodes">
<h2>中继节点（{{len .Nodes}}）</h2>
<table>
<thead><tr><th>ID</th><th>区域</th><th>状态</th><th>中继字节</th><th>存储字节</th><th>版本</th></tr></thead>
<tbody>
{{range .Nodes}}
<tr>
<td>{{.ID}}</td><td>{{.Region}}</td>
<td>{{if .Online}}在线{{else}}离线{{end}}</td>
<td>{{bytes .RelayedBytes}}</td><td>{{bytes .StoredBytes}}</td><td>{{.Version}}</td>
</tr>
{{end}}
</tbody></table>
</section>
```

- [ ] **Step 5: Run tests + build to verify**

Run: `cd server && go test ./internal/account/ -run 'TestNodeViews' && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/admin_nodes_test.go
git commit -m "feat(admin): read-only relay-nodes telemetry section"
```

---

## Task 6: Node binary — config + `state.json`

Starts the `relayium-node` binary. This task delivers config parsing + persistent local state (nodeID + generated turnSecret).

**Files:**
- Create: `server/cmd/relayium-node/main.go` (config + skeleton `run`; relay wiring lands in Task 9)
- Create: `server/cmd/relayium-node/state.go`
- Test: `server/cmd/relayium-node/state_test.go`

**Interfaces:**
- Produces:
  - `type nodeState struct { NodeID string; TURNSecret string }`
  - `func loadState(dir string) (nodeState, error)` — reads `<dir>/state.json`; if absent, generates a fresh `TURNSecret` (64 hex) and persists a state with empty `NodeID`.
  - `func saveState(dir string, st nodeState) error` — atomic write of `<dir>/state.json` (0600).
  - `type config struct { CentralURL, NodeToken, Region, PublicIP, Realm, StateDir string; TURNPort, MinPort, MaxPort int }`
  - `func parseConfig() (config, error)`

- [ ] **Step 1: Write the failing test**

`server/cmd/relayium-node/state_test.go`:
```go
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateGeneratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	st, err := loadState(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(st.TURNSecret) != 64 {
		t.Fatalf("expected 64-hex secret, got %q", st.TURNSecret)
	}
	if st.NodeID != "" {
		t.Fatalf("fresh state should have empty NodeID")
	}
	if _, err := os.Stat(filepath.Join(dir, "state.json")); err != nil {
		t.Fatalf("state.json not written: %v", err)
	}
	// A second load returns the SAME secret (persistence).
	st2, err := loadState(dir)
	if err != nil {
		t.Fatalf("load2: %v", err)
	}
	if st2.TURNSecret != st.TURNSecret {
		t.Fatalf("secret not stable across loads")
	}
	// saveState round-trips an assigned NodeID.
	st2.NodeID = "assigned-id"
	if err := saveState(dir, st2); err != nil {
		t.Fatalf("save: %v", err)
	}
	st3, _ := loadState(dir)
	if st3.NodeID != "assigned-id" {
		t.Fatalf("NodeID not persisted, got %q", st3.NodeID)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium-node/ -run TestState`
Expected: FAIL — package/funcs undefined.

- [ ] **Step 3: Implement state.go**

`server/cmd/relayium-node/state.go`:
```go
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
)

// nodeState is the node's persistent local identity. TURNSecret is generated
// once and never leaves the box except to central over TLS at registration.
type nodeState struct {
	NodeID     string `json:"nodeID"`
	TURNSecret string `json:"turnSecret"`
}

func statePath(dir string) string { return filepath.Join(dir, "state.json") }

// loadState reads <dir>/state.json, generating and persisting a fresh state
// (new TURNSecret, empty NodeID) on first run.
func loadState(dir string) (nodeState, error) {
	b, err := os.ReadFile(statePath(dir))
	if err == nil {
		var st nodeState
		if jerr := json.Unmarshal(b, &st); jerr != nil {
			return nodeState{}, jerr
		}
		return st, nil
	}
	if !os.IsNotExist(err) {
		return nodeState{}, err
	}
	secret := make([]byte, 32)
	if _, rerr := rand.Read(secret); rerr != nil {
		return nodeState{}, rerr
	}
	st := nodeState{TURNSecret: hex.EncodeToString(secret)}
	if serr := saveState(dir, st); serr != nil {
		return nodeState{}, serr
	}
	return st, nil
}

// saveState atomically writes <dir>/state.json with 0600 perms.
func saveState(dir string, st nodeState) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := statePath(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, statePath(dir))
}
```

- [ ] **Step 4: Implement main.go config skeleton**

`server/cmd/relayium-node/main.go`:
```go
// Command relayium-node is a self-reporting relay node: it runs a pion/turn
// relay, counts the bytes it relays per allocation, and heartbeats those counts
// to the central relayium server, which hands the node out in /api/ice.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
)

type config struct {
	CentralURL string
	NodeToken  string
	Region     string
	PublicIP   string
	Realm      string
	StateDir   string
	TURNPort   int
	MinPort    int
	MaxPort    int
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func parseConfig() (config, error) {
	var c config
	flag.StringVar(&c.CentralURL, "central-url", env("RELAYIUM_CENTRAL_URL", ""), "central relayium server base URL, e.g. https://relayium.com")
	flag.StringVar(&c.NodeToken, "node-token", env("RELAYIUM_NODE_TOKEN", ""), "fleet bootstrap bearer token")
	flag.StringVar(&c.Region, "region", env("RELAYIUM_NODE_REGION", ""), "region label (diagnostics only)")
	flag.StringVar(&c.PublicIP, "public-ip", env("RELAYIUM_NODE_PUBLIC_IP", ""), "public IP for the TURN URL; auto-detected if empty")
	flag.StringVar(&c.Realm, "realm", env("RELAYIUM_NODE_REALM", "relayium.app"), "TURN realm advertised to clients")
	flag.StringVar(&c.StateDir, "state-dir", env("RELAYIUM_NODE_STATE_DIR", "/var/lib/relayium-node"), "directory for state.json")
	flag.IntVar(&c.TURNPort, "turn-port", 3478, "TURN listening UDP port")
	flag.IntVar(&c.MinPort, "min-port", 49152, "relay UDP range low")
	flag.IntVar(&c.MaxPort, "max-port", 65535, "relay UDP range high")
	flag.Parse()

	var missing []string
	if c.CentralURL == "" {
		missing = append(missing, "-central-url / RELAYIUM_CENTRAL_URL")
	}
	if c.NodeToken == "" {
		missing = append(missing, "-node-token / RELAYIUM_NODE_TOKEN")
	}
	if len(missing) > 0 {
		return c, fmt.Errorf("missing required config: %s", strings.Join(missing, ", "))
	}
	c.CentralURL = strings.TrimRight(c.CentralURL, "/")
	return c, nil
}

func main() {
	c, err := parseConfig()
	if err != nil {
		log.Fatalf("relayium-node: %v", err)
	}
	st, err := loadState(c.StateDir)
	if err != nil {
		log.Fatalf("relayium-node: load state: %v", err)
	}
	if err := run(c, st); err != nil { // run is implemented in relay.go (Task 9)
		log.Fatalf("relayium-node: %v", err)
	}
}
```
Add a temporary stub so the package builds until Task 9 replaces it. Put this in `main.go` for now (Task 9 moves `run` to `relay.go`):
```go
func run(c config, st nodeState) error {
	log.Printf("relayium-node: config ok (central=%s region=%s state=%s) — relay wiring pending (Task 9)", c.CentralURL, c.Region, c.StateDir)
	return nil
}
```

- [ ] **Step 5: Run tests + build to verify**

Run: `cd server && go test ./cmd/relayium-node/ && go build ./cmd/relayium-node/`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add server/cmd/relayium-node/main.go server/cmd/relayium-node/state.go server/cmd/relayium-node/state_test.go
git commit -m "feat(node): relayium-node config parsing + persistent state.json"
```

---

## Task 7: Node binary — counting `net.PacketConn` wrapper + allocation registry

**Files:**
- Create: `server/cmd/relayium-node/counter.go`
- Test: `server/cmd/relayium-node/counter_test.go`

**Interfaces:**
- Produces:
  - `type countingPacketConn struct { net.PacketConn; n *int64 }` with `ReadFrom`/`WriteTo` incrementing `*n` (atomic).
  - `type allocRegistry struct { ... }` with:
    - `func newAllocRegistry() *allocRegistry`
    - `wrap(pc net.PacketConn, relayAddr net.Addr) net.PacketConn` — registers a counter keyed by `relayAddr.String()`, returns the wrapping conn.
    - `tag(relayAddr net.Addr, username string)` — associates a username with the counter for that relay addr.
    - `snapshot() []allocSample` where `type allocSample struct { AllocID, Username string; RelayedBytes int64 }` — `AllocID` = relay-addr string.

- [ ] **Step 1: Write the failing test**

`server/cmd/relayium-node/counter_test.go`:
```go
package main

import (
	"net"
	"sync"
	"testing"
)

// fakePC is a no-op PacketConn whose ReadFrom/WriteTo report fixed byte counts.
type fakePC struct{ net.PacketConn }

func (fakePC) ReadFrom(p []byte) (int, net.Addr, error) { return len(p), &net.UDPAddr{}, nil }
func (fakePC) WriteTo(p []byte, _ net.Addr) (int, error) { return len(p), nil }
func (fakePC) Close() error                              { return nil }

func TestCountingConnTallies(t *testing.T) {
	var n int64
	c := &countingPacketConn{PacketConn: fakePC{}, n: &n}
	c.WriteTo(make([]byte, 100), &net.UDPAddr{})
	c.ReadFrom(make([]byte, 40))
	if n != 140 {
		t.Fatalf("tally=%d want 140", n)
	}
}

func TestRegistrySnapshotAttributes(t *testing.T) {
	reg := newAllocRegistry()
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	c := reg.wrap(fakePC{}, relay)
	reg.tag(relay, "6000:userX.123456")
	c.WriteTo(make([]byte, 250), &net.UDPAddr{})

	snap := reg.snapshot()
	if len(snap) != 1 {
		t.Fatalf("want 1 sample, got %d", len(snap))
	}
	if snap[0].Username != "6000:userX.123456" || snap[0].RelayedBytes != 250 {
		t.Fatalf("sample=%+v", snap[0])
	}
	if snap[0].AllocID != relay.String() {
		t.Fatalf("allocID=%q want %q", snap[0].AllocID, relay.String())
	}
}

func TestRegistryConcurrent(t *testing.T) {
	reg := newAllocRegistry()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, byte(i)), Port: 40000 + i}
		c := reg.wrap(fakePC{}, relay)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				c.WriteTo(make([]byte, 10), &net.UDPAddr{})
			}
		}()
	}
	wg.Wait()
	var total int64
	for _, s := range reg.snapshot() {
		total += s.RelayedBytes
	}
	if total != 8*100*10 {
		t.Fatalf("total=%d want %d", total, 8*100*10)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium-node/ -run 'Counting|Registry' -race`
Expected: FAIL — types undefined.

- [ ] **Step 3: Implement counter.go**

`server/cmd/relayium-node/counter.go`:
```go
package main

import (
	"net"
	"sync"
	"sync/atomic"
)

// countingPacketConn wraps a relay PacketConn, tallying every byte read and
// written through it into *n (the allocation's cumulative relayed bytes).
type countingPacketConn struct {
	net.PacketConn
	n *int64
}

func (c *countingPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	nn, addr, err := c.PacketConn.ReadFrom(p)
	atomic.AddInt64(c.n, int64(nn))
	return nn, addr, err
}

func (c *countingPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	nn, err := c.PacketConn.WriteTo(p, addr)
	atomic.AddInt64(c.n, int64(nn))
	return nn, err
}

type allocEntry struct {
	bytes    int64 // atomic
	username string
}

// allocRegistry tracks per-allocation byte counters keyed by relay address, and
// the username each allocation authenticated with (joined via pion's
// OnAllocationCreated event → relayAddr).
type allocRegistry struct {
	mu      sync.Mutex
	entries map[string]*allocEntry
}

func newAllocRegistry() *allocRegistry {
	return &allocRegistry{entries: make(map[string]*allocEntry)}
}

// wrap registers a counter for relayAddr and returns a counting conn over pc.
func (r *allocRegistry) wrap(pc net.PacketConn, relayAddr net.Addr) net.PacketConn {
	r.mu.Lock()
	e := &allocEntry{}
	r.entries[relayAddr.String()] = e
	r.mu.Unlock()
	return &countingPacketConn{PacketConn: pc, n: &e.bytes}
}

// tag associates a TURN username with the counter for relayAddr.
func (r *allocRegistry) tag(relayAddr net.Addr, username string) {
	r.mu.Lock()
	if e := r.entries[relayAddr.String()]; e != nil {
		e.username = username
	}
	r.mu.Unlock()
}

type allocSample struct {
	AllocID      string
	Username     string
	RelayedBytes int64
}

// snapshot returns the current cumulative bytes per allocation. Counters are
// cumulative and monotonic; keep-max on the central side makes redelivery safe.
func (r *allocRegistry) snapshot() []allocSample {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]allocSample, 0, len(r.entries))
	for id, e := range r.entries {
		out = append(out, allocSample{
			AllocID:      id,
			Username:     e.username,
			RelayedBytes: atomic.LoadInt64(&e.bytes),
		})
	}
	return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./cmd/relayium-node/ -run 'Counting|Registry' -race`
Expected: PASS (including `-race`).

- [ ] **Step 5: Commit**

```bash
git add server/cmd/relayium-node/counter.go server/cmd/relayium-node/counter_test.go
git commit -m "feat(node): per-allocation byte-counting PacketConn wrapper + registry"
```

---

## Task 8: Node binary — report agent (register + heartbeat client)

**Files:**
- Create: `server/cmd/relayium-node/report.go`
- Test: `server/cmd/relayium-node/report_test.go`

**Interfaces:**
- Consumes: `allocRegistry.snapshot()` (Task 7); central request/response JSON shapes (must match Task 3's `nodeRegisterReq`/`nodeRegisterResp`/`nodeHeartbeatReq` fields byte-for-byte).
- Produces:
  - `type reporter struct { central, token string; hc *http.Client }`
  - `func newReporter(central, token string) *reporter`
  - `func (rp *reporter) register(req registerBody) (string, int, error)` — returns `(nodeID, heartbeatInterval, error)`.
  - `func (rp *reporter) heartbeat(body heartbeatBody) error`
  - JSON bodies `registerBody`/`heartbeatBody`/`usageItem` with the SAME json tags as Task 3.

- [ ] **Step 1: Write the failing test**

`server/cmd/relayium-node/report_test.go`:
```go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReporterRegisterAndHeartbeat(t *testing.T) {
	var gotAuth string
	var gotHB heartbeatBody
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/api/nodes/register":
			json.NewEncoder(w).Encode(map[string]any{"nodeID": "srv-assigned", "heartbeatInterval": 30})
		case "/api/nodes/heartbeat":
			json.NewDecoder(r.Body).Decode(&gotHB)
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	rp := newReporter(srv.URL, "fleet-secret")
	id, interval, err := rp.register(registerBody{TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}, Region: "asia", Version: "0.3.0", Capabilities: []string{"relay"}})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if id != "srv-assigned" || interval != 30 {
		t.Fatalf("got id=%q interval=%d", id, interval)
	}
	if gotAuth != "Bearer fleet-secret" {
		t.Fatalf("auth header=%q", gotAuth)
	}

	err = rp.heartbeat(heartbeatBody{NodeID: id, Status: "ok", RelayedTotal: 900,
		Usage: []usageItem{{AllocID: "a1", Username: "6000:userX.1", RelayedBytes: 900}}})
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if gotHB.NodeID != "srv-assigned" || len(gotHB.Usage) != 1 || gotHB.Usage[0].RelayedBytes != 900 {
		t.Fatalf("server got %+v", gotHB)
	}
}

func TestReporterHeartbeatGoneError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer srv.Close()
	rp := newReporter(srv.URL, "t")
	if err := rp.heartbeat(heartbeatBody{NodeID: "x"}); err == nil {
		t.Fatal("expected error on 410")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium-node/ -run Reporter`
Expected: FAIL — types/functions undefined.

- [ ] **Step 3: Implement report.go**

`server/cmd/relayium-node/report.go`:
```go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// JSON bodies — tags MUST match the central handlers (internal/account/nodes.go).
type registerBody struct {
	NodeID       string   `json:"nodeID"`
	TURNSecret   string   `json:"turnSecret"`
	URLs         []string `json:"urls"`
	Region       string   `json:"region"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

type registerResp struct {
	NodeID            string `json:"nodeID"`
	HeartbeatInterval int    `json:"heartbeatInterval"`
}

type usageItem struct {
	AllocID      string `json:"allocID"`
	Username     string `json:"username"`
	RelayedBytes int64  `json:"relayedBytes"`
}

type heartbeatBody struct {
	NodeID       string      `json:"nodeID"`
	Status       string      `json:"status"`
	Usage        []usageItem `json:"usage"`
	RelayedTotal int64       `json:"relayedTotal"`
	StoredBytes  int64       `json:"storedBytes"`
}

type reporter struct {
	central string
	token   string
	hc      *http.Client
}

func newReporter(central, token string) *reporter {
	return &reporter{central: central, token: token, hc: &http.Client{Timeout: 15 * time.Second}}
}

func (rp *reporter) post(path string, in any, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", rp.central+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+rp.token)
	resp, err := rp.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s: status %d: %s", path, resp.StatusCode, string(body))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (rp *reporter) register(body registerBody) (nodeID string, heartbeatInterval int, err error) {
	var r registerResp
	if err = rp.post("/api/nodes/register", body, &r); err != nil {
		return "", 0, err
	}
	return r.NodeID, r.HeartbeatInterval, nil
}

func (rp *reporter) heartbeat(body heartbeatBody) error {
	return rp.post("/api/nodes/heartbeat", body, nil)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./cmd/relayium-node/ -run Reporter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/cmd/relayium-node/report.go server/cmd/relayium-node/report_test.go
git commit -m "feat(node): register/heartbeat report agent (HTTPS client)"
```

---

## Task 9: Node binary — pion/turn relay wiring

Ties it together: run pion/turn with the counting generator + auth + event join, and drive the report loop.

**Files:**
- Create: `server/cmd/relayium-node/relay.go` (implements `run`, replacing the stub in `main.go`)
- Modify: `server/cmd/relayium-node/main.go` (remove the temporary `run` stub)
- Modify: `server/go.mod` / `server/go.sum` (add `github.com/pion/turn/v4`)
- Test: `server/cmd/relayium-node/relay_test.go` (auth-key + credential-validation unit test; full UDP relay is a manual smoke check)

**Interfaces:**
- Consumes: `config`, `nodeState` (Task 6); `allocRegistry`, `countingPacketConn` (Task 7); `reporter`, `registerBody`, `heartbeatBody`, `usageItem` (Task 8); `github.com/pion/turn/v4`.

- [ ] **Step 1: Add the pion/turn dependency**

Run: `cd server && go get github.com/pion/turn/v4@v4.1.4`
Expected: `go.mod` gains `github.com/pion/turn/v4 v4.1.4`.

- [ ] **Step 2: Write the failing test (credential validation)**

`server/cmd/relayium-node/relay_test.go`:
```go
package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"testing"
)

// The node's AuthHandler must accept exactly the credential /api/ice mints:
// password = base64(HMAC-SHA1(secret, username)). This test pins that formula.
func TestLongTermPasswordMatchesCentral(t *testing.T) {
	secret := "sek"
	username := "6000:userX.123456"
	// central formula (internal/account/turn.go turnCredentials)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if got := longTermPassword(secret, username); got != want {
		t.Fatalf("longTermPassword=%q want %q", got, want)
	}
}

func TestCredentialExpiry(t *testing.T) {
	// username "<expiry>:token" — expired if expiry < now.
	if !credentialExpired("100:userX.1", 200) {
		t.Fatal("should be expired")
	}
	if credentialExpired("300:userX.1", 200) {
		t.Fatal("should be valid")
	}
	if !credentialExpired("garbage", 200) {
		t.Fatal("malformed username treated as expired")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && go test ./cmd/relayium-node/ -run 'LongTerm|Credential'`
Expected: FAIL — funcs undefined.

- [ ] **Step 4: Implement relay.go**

`server/cmd/relayium-node/relay.go`:
```go
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pion/turn/v4"
)

// longTermPassword computes the TURN-REST password for a username exactly as the
// central /api/ice does: base64(HMAC-SHA1(secret, username)).
func longTermPassword(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// credentialExpired reports whether the "<expiry>:token" username has expired at
// unix time now. A malformed username is treated as expired (reject).
func credentialExpired(username string, now int64) bool {
	i := strings.IndexByte(username, ':')
	if i <= 0 {
		return true
	}
	exp, err := strconv.ParseInt(username[:i], 10, 64)
	if err != nil {
		return true
	}
	return exp < now
}

// countingGenerator wraps RelayAddressGeneratorPortRange, registering each
// allocated relay conn with the registry so its bytes are counted and later
// attributed (by relay address) to the authenticating username.
type countingGenerator struct {
	inner *turn.RelayAddressGeneratorPortRange
	reg   *allocRegistry
}

func (g *countingGenerator) Validate() error { return g.inner.Validate() }

func (g *countingGenerator) AllocatePacketConn(network string, requestedPort int) (net.PacketConn, net.Addr, error) {
	pc, addr, err := g.inner.AllocatePacketConn(network, requestedPort)
	if err != nil {
		return pc, addr, err
	}
	return g.reg.wrap(pc, addr), addr, nil
}

func (g *countingGenerator) AllocateConn(network string, requestedPort int) (net.Conn, net.Addr, error) {
	return g.inner.AllocateConn(network, requestedPort) // TCP relay unused; not counted in SP1
}

func run(c config, st nodeState) error {
	publicIP := c.PublicIP
	if publicIP == "" {
		ip, err := detectPublicIP()
		if err != nil {
			return fmt.Errorf("detect public IP (pass -public-ip): %w", err)
		}
		publicIP = ip
	}

	udpAddr := fmt.Sprintf("0.0.0.0:%d", c.TURNPort)
	udpConn, err := net.ListenPacket("udp4", udpAddr)
	if err != nil {
		return fmt.Errorf("listen udp %s: %w", udpAddr, err)
	}

	reg := newAllocRegistry()
	gen := &countingGenerator{
		reg: reg,
		inner: &turn.RelayAddressGeneratorPortRange{
			RelayAddress: net.ParseIP(publicIP),
			Address:      "0.0.0.0",
			MinPort:      uint16(c.MinPort),
			MaxPort:      uint16(c.MaxPort),
		},
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: c.Realm,
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			if credentialExpired(username, time.Now().Unix()) {
				return nil, false
			}
			password := longTermPassword(st.TURNSecret, username)
			return turn.GenerateAuthKey(username, realm, password), true
		},
		EventHandler: turn.EventHandler{
			OnAllocationCreated: func(srcAddr, dstAddr net.Addr, protocol, username, realm string, relayAddr net.Addr, requestedPort int) {
				reg.tag(relayAddr, username) // relayAddr joins the counter to the username
			},
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            udpConn,
			RelayAddressGenerator: gen,
		}},
	})
	if err != nil {
		return fmt.Errorf("start turn server: %w", err)
	}
	defer server.Close()

	rp := newReporter(c.CentralURL, c.NodeToken)
	urls := []string{fmt.Sprintf("turn:%s:%d", publicIP, c.TURNPort)}

	nodeID, interval, err := rp.register(registerBody{
		NodeID: st.NodeID, TURNSecret: st.TURNSecret, URLs: urls,
		Region: c.Region, Version: version, Capabilities: []string{"relay"},
	})
	if err != nil {
		return fmt.Errorf("register with central: %w", err)
	}
	if nodeID != st.NodeID {
		st.NodeID = nodeID
		if serr := saveState(c.StateDir, st); serr != nil {
			log.Printf("relayium-node: persist nodeID: %v", serr)
		}
	}
	if interval <= 0 {
		interval = 30
	}
	log.Printf("relayium-node: registered as %s, relaying on %s, heartbeat %ds", nodeID, urls[0], interval)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("relayium-node: shutting down")
			return nil
		case <-ticker.C:
			sendHeartbeat(rp, nodeID, reg)
		}
	}
}

func sendHeartbeat(rp *reporter, nodeID string, reg *allocRegistry) {
	samples := reg.snapshot()
	usage := make([]usageItem, 0, len(samples))
	var total int64
	for _, s := range samples {
		if s.Username == "" {
			continue // not yet joined to a username; skip until OnAllocationCreated fires
		}
		usage = append(usage, usageItem{AllocID: s.AllocID, Username: s.Username, RelayedBytes: s.RelayedBytes})
		total += s.RelayedBytes
	}
	if err := rp.heartbeat(heartbeatBody{NodeID: nodeID, Status: "ok", Usage: usage, RelayedTotal: total, StoredBytes: 0}); err != nil {
		log.Printf("relayium-node: heartbeat failed (will retry): %v", err)
	}
}

// detectPublicIP asks a couple of public echo services, mirroring coturn-setup.sh.
func detectPublicIP() (string, error) {
	for _, u := range []string{"https://api.ipify.org", "https://ifconfig.me/ip"} {
		if ip := httpGetTrim(u); ip != "" && net.ParseIP(ip) != nil {
			return ip, nil
		}
	}
	return "", fmt.Errorf("could not auto-detect public IP")
}
```
Add small helpers `version` and `httpGetTrim` (in `main.go` or `relay.go`):
```go
// version is stamped by goreleaser via -ldflags; a dev build reports "dev".
var version = "dev"

func httpGetTrim(u string) string {
	hc := &http.Client{Timeout: 10 * time.Second}
	resp, err := hc.Get(u)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	return strings.TrimSpace(string(b))
}
```
(Requires `net/http`, `io`, `strings`, `time` imports in the file that hosts `httpGetTrim`. Also remove the temporary `run` stub from `main.go` — `run` now lives in `relay.go`. `os` import in `relay.go` is used by `signal.NotifyContext`'s siblings; drop unused imports to satisfy the compiler.)

- [ ] **Step 5: Run tests + build to verify**

Run: `cd server && go test ./cmd/relayium-node/ && CGO_ENABLED=0 go build ./cmd/relayium-node/`
Expected: PASS + a static binary builds (CGO off).

- [ ] **Step 6: Manual smoke check (documented, not CI)**

Document in the commit body: on a host with a public IP,
`RELAYIUM_CENTRAL_URL=https://<host> RELAYIUM_NODE_TOKEN=<t> ./relayium-node -public-ip <ip>` →
node logs `registered as …`; it appears online in `/admin`; a cross-network transfer routed
through it increments its relayed bytes on the next heartbeat.

- [ ] **Step 7: Commit**

```bash
git add server/cmd/relayium-node/relay.go server/cmd/relayium-node/main.go server/cmd/relayium-node/relay_test.go server/go.mod server/go.sum
git commit -m "feat(node): pion/turn relay wiring with per-alloc attribution + report loop"
```

---

## Task 10: Distribution — goreleaser build + `install-node.sh`

**Files:**
- Modify: `.goreleaser.yaml` (add `relayium-node` build + include in archives)
- Create: `web/public/install-node.sh`

**Interfaces:**
- Consumes: the `relayium-node` binary (Task 6-9).

- [ ] **Step 1: Add the goreleaser build**

In `.goreleaser.yaml`, add a second entry to `builds:` (mirroring the existing `relayium` build's `dir: server`, `env`, `ldflags` style; server-side ⇒ linux+darwin only). Set the version ldflag to stamp `main.version`:
```yaml
  - id: relayium-node
    dir: server
    main: ./cmd/relayium-node
    binary: relayium-node
    env:
      - CGO_ENABLED=0
    goos: [linux, darwin]
    goarch: [amd64, arm64]
    ldflags:
      - -s -w -X main.version={{.Version}}
```
Ensure the `archives:` section includes both binaries (if archives filter by build ids, add `relayium-node`; if it archives all builds by default, no change needed — verify against the current archives block).

- [ ] **Step 2: Validate the goreleaser config**

Run: `goreleaser check`
Expected: `config is valid` (if `goreleaser` isn't installed, skip with a note; the build id/main path mirror the working `relayium` entry).

- [ ] **Step 3: Write `install-node.sh`**

`web/public/install-node.sh` (mirror `web/public/install.sh`'s OS/arch detection + download; then systemd unit):
```sh
#!/bin/sh
# Relayium relay-node installer.
#   curl -fsSL https://relayium.com/install-node.sh | sh
# Required env: RELAYIUM_CENTRAL_URL, RELAYIUM_NODE_TOKEN. Optional: RELAYIUM_NODE_REGION.
set -eu

REPO="relayium/relayium"
BASE_URL="${RELAYIUM_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
INSTALL_DIR="${RELAYIUM_INSTALL_DIR:-/usr/local/bin}"

err() { echo "relayium-node-install: $*" >&2; exit 1; }

[ -n "${RELAYIUM_CENTRAL_URL:-}" ] || err "set RELAYIUM_CENTRAL_URL (e.g. https://relayium.com)"
[ -n "${RELAYIUM_NODE_TOKEN:-}" ]  || err "set RELAYIUM_NODE_TOKEN (fleet bootstrap token)"

os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS '$os'" ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) err "unsupported arch '$arch'" ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Archive name mirrors goreleaser's default template (verify against install.sh).
asset="relayium_${os}_${arch}.tar.gz"
echo "downloading ${asset} ..."
curl -fsSL "${BASE_URL}/${asset}" -o "$tmp/a.tar.gz" || err "download failed"
tar -xzf "$tmp/a.tar.gz" -C "$tmp"
[ -f "$tmp/relayium-node" ] || err "relayium-node not found in archive"
install -m 0755 "$tmp/relayium-node" "${INSTALL_DIR}/relayium-node"
echo "installed ${INSTALL_DIR}/relayium-node"

# Set up a systemd service when running as root with systemd present.
if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1; then
  mkdir -p /etc/relayium-node
  cat > /etc/relayium-node/env <<EOF
RELAYIUM_CENTRAL_URL=${RELAYIUM_CENTRAL_URL}
RELAYIUM_NODE_TOKEN=${RELAYIUM_NODE_TOKEN}
RELAYIUM_NODE_REGION=${RELAYIUM_NODE_REGION:-}
EOF
  chmod 0600 /etc/relayium-node/env
  cat > /etc/systemd/system/relayium-node.service <<EOF
[Unit]
Description=Relayium relay node
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/relayium-node/env
ExecStart=${INSTALL_DIR}/relayium-node
Restart=always
RestartSec=5
StateDirectory=relayium-node

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now relayium-node
  echo "relayium-node.service enabled and started — check: systemctl status relayium-node"
  echo "it should appear online in ${RELAYIUM_CENTRAL_URL}/admin within ~30s"
else
  echo "not root or no systemd — run it yourself:"
  echo "  RELAYIUM_CENTRAL_URL=${RELAYIUM_CENTRAL_URL} RELAYIUM_NODE_TOKEN=*** ${INSTALL_DIR}/relayium-node"
fi
```
Note: `StateDirectory=relayium-node` makes systemd create `/var/lib/relayium-node` (matches the node's default `-state-dir`). Verify the archive asset-name template against the existing `install.sh` and align if goreleaser uses a different `name_template`.

- [ ] **Step 4: Lint the installer**

Run: `sh -n web/public/install-node.sh` (syntax check) and, if available, `shellcheck web/public/install-node.sh`.
Expected: no syntax errors.

- [ ] **Step 5: Commit**

```bash
git add .goreleaser.yaml web/public/install-node.sh
git commit -m "feat(dist): relayium-node goreleaser build + one-command install-node.sh"
```

---

## Self-Review Notes

**Spec coverage:** Component 1 (node binary) → Tasks 6-9; Component 2 (register/heartbeat API) → Task 3; Component 3 (nodes table + store) → Task 2; Component 4 (/api/ice dynamic pool) → Task 4; Component 5 (admin) → Task 5; Component 6 (distribution) → Task 10; shared username parsing (DRY) → Task 1; byte-counting via `OnAllocationCreated` relayAddr↔username join (resolved open question) → Tasks 7+9.

**Cross-task type consistency:** central JSON (`nodeRegisterReq`/`nodeHeartbeatReq`/`nodeUsage`, Task 3) and node JSON (`registerBody`/`heartbeatBody`/`usageItem`, Task 8) share identical json tags (`nodeID`,`turnSecret`,`urls`,`region`,`version`,`capabilities`,`status`,`usage`,`allocID`,`username`,`relayedBytes`,`relayedTotal`,`storedBytes`). `nodeHeartbeatInterval=30` (Task 3) ↔ `nodeOnlineWindow=90s` (Task 4) ↔ ticker default (Task 9). `Node` fields (Task 2) consumed unchanged by Tasks 3/4/5.

**Deferred to implementer (non-blocking):** exact goreleaser archive `name_template` (align `install-node.sh` asset name to it in Task 10); whether `NewSQLiteStore` constructor name matches the test helper (Task 2 note).
