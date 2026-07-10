# SP3 — BYO User Self-Hosted Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registered user run the `relayium-node` binary bound to their account, so their transfers relay through / store on their own node (free, not billed) — with per-user routing, quota exclusion, a strict "only my nodes" mode, and a "My Nodes" dashboard.

**Architecture:** A per-user token minted in the dashboard authenticates a node as `owner_type='user', owner_user_id=U` (vs the shared-fleet-token `owner_type='fleet'`). Billable vs non-billable is derived at heartbeat ingestion from the reporting node's `owner_type` — no billability flows through TURN credentials or upload placement. `/api/ice` and `placeUpload` prefer the user's own online node, falling back to fleet/central unless the user is in strict mode.

**Tech Stack:** Go (module root `server/`, `github.com/relayium/relayium`, CGO off), `modernc.org/sqlite`, `net/http`, html/template; Svelte 5 (runes) frontend in `web/src`, Vitest.

## Global Constraints

- Module root is `server/`; import paths `github.com/relayium/relayium/...`. Run Go from `server/`; frontend from `web/`.
- CGO off; pure-Go only. New/changed DB columns use the idempotent-`ALTER` migration idiom (as `download_count`/`node_id` were added), NOT edits to existing `CREATE TABLE` bodies. New tables are `CREATE TABLE IF NOT EXISTS`.
- Token hashing uses the existing `hashToken(raw) string` (sha256 hex, `service.go`). Plaintext tokens are shown to the user exactly once at mint and never stored.
- Billable is derived from the reporting node's `owner_type` (`fleet` → billable, `user` → non-billable). `UserRelayedSince` (the quota gate) sums `billable=1` only. Do NOT thread billability through TURN credentials/placement.
- Session-authenticated user endpoints mount inside `acct.Routes()` (CSRF-guarded via `routeMux`); the bearer node endpoints (`register`/`heartbeat`) stay on the root mux (no CSRF), per SP1.
- `nodeOnlineWindow = 90s` (turn.go, SP1) is the online cutoff — reuse it.
- E2E unchanged: nodes (fleet or user) store/relay ciphertext only.
- Frontend: Svelte 5 runes, `fetch("/api/...", {credentials:"include"})`, mirror the existing `MePage.svelte` sections and i18n (`t.me.*`) conventions.

---

## File Structure

**New files:**
- `server/internal/account/nodetokens_store_test.go` — node_tokens store tests.
- `server/internal/account/usernodes.go` (+ `usernodes_test.go`) — user node API handlers (provision/mine/delete/strict).

**Modified files:**
- `server/internal/account/store.go` — `NodeToken` struct; `UsageEvent`/`User`/`Node`-query additions; new interface methods.
- `server/internal/account/sqlite.go` — schema (node_tokens, ALTERs), token methods, `UserNodes`/`UserStorageNodes`, `RecordUsage` billable, `UserRelayedSince` billable-only, `GetUserByID`/`SetOnlyOwnNodes`, `DeleteNode`, `DeletePendingNodeDeletesOlderThan`.
- `server/internal/account/nodes.go` — `nodeOwner` resolver; register owner_type/owner_user_id + bind; heartbeat billable + cross-user reject + GetNode.
- `server/internal/account/service.go` — `Config.EnableUserNodes`; a per-user provision limiter (optional).
- `server/internal/account/turn.go` — `/api/ice` per-user routing + strict mode.
- `server/internal/account/blobfor.go` — `placeUpload(ctx, userID) (nodeID, bs, billable)`.
- `server/internal/account/files.go` — skip ReserveUpload/quota when non-billable; strict-offline 503.
- `server/internal/account/handlers.go` — mount user node routes; `handleMe` returns `onlyOwnNodes`.
- `server/internal/account/gc.go` — evict aged `pending_node_deletes`.
- `web/src/lib/MePage.svelte` (+ a Vitest spec) — "My Nodes" section + strict toggle.

---

## Task 1: `node_tokens` table + store methods

**Files:**
- Modify: `server/internal/account/store.go` (`NodeToken` struct + interface methods)
- Modify: `server/internal/account/sqlite.go` (schema + implementations)
- Test: `server/internal/account/nodetokens_store_test.go`

**Interfaces:**
- Produces:
  - `type NodeToken struct { ID, TokenHash, UserID, NodeID, Name string; CreatedAt, LastUsedAt, RevokedAt int64 }`
  - `CreateNodeToken(ctx, NodeToken) error` (caller sets `ID`, `TokenHash`, `UserID`, `Name`, `CreatedAt`).
  - `NodeTokenByHash(ctx, hash string) (NodeToken, bool, error)` — returns ok=false if absent OR revoked.
  - `BindNodeToken(ctx, id, nodeID string) error`.
  - `ListNodeTokensByUser(ctx, userID string) ([]NodeToken, error)`.
  - `RevokeNodeToken(ctx, id, userID string) error` (owner-scoped; sets `revoked_at`).
  - `TouchNodeTokenUsed(ctx, id string, at int64) error`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/nodetokens_store_test.go`:
```go
package account

import (
	"context"
	"testing"
)

func TestNodeTokenLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "n@x.com", "n")

	tok := NodeToken{ID: "t1", TokenHash: "hashA", UserID: u.ID, Name: "home", CreatedAt: 100}
	if err := st.CreateNodeToken(ctx, tok); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, ok, err := st.NodeTokenByHash(ctx, "hashA")
	if err != nil || !ok || got.UserID != u.ID || got.ID != "t1" {
		t.Fatalf("byhash: %+v ok=%v err=%v", got, ok, err)
	}
	if err := st.BindNodeToken(ctx, "t1", "node-9"); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if list, _ := st.ListNodeTokensByUser(ctx, u.ID); len(list) != 1 || list[0].NodeID != "node-9" {
		t.Fatalf("list: %+v", list)
	}
	// Owner-scoped revoke: a different user cannot revoke it.
	if err := st.RevokeNodeToken(ctx, "t1", "someone-else"); err != nil {
		t.Fatalf("revoke wrong-owner should be a no-op nil, got %v", err)
	}
	if _, ok, _ := st.NodeTokenByHash(ctx, "hashA"); !ok {
		t.Fatal("token wrongly revoked by non-owner")
	}
	// Correct owner revokes -> lookup now returns ok=false.
	if err := st.RevokeNodeToken(ctx, "t1", u.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok, _ := st.NodeTokenByHash(ctx, "hashA"); ok {
		t.Fatal("revoked token must not resolve")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestNodeTokenLifecycle`
Expected: FAIL — types/methods undefined.

- [ ] **Step 3: Add the `NodeToken` struct + interface methods (`store.go`)**

```go
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
```
Add to the `Store` interface:
```go
	CreateNodeToken(ctx context.Context, t NodeToken) error
	NodeTokenByHash(ctx context.Context, hash string) (NodeToken, bool, error)
	BindNodeToken(ctx context.Context, id, nodeID string) error
	ListNodeTokensByUser(ctx context.Context, userID string) ([]NodeToken, error)
	RevokeNodeToken(ctx context.Context, id, userID string) error
	TouchNodeTokenUsed(ctx context.Context, id string, at int64) error
```

- [ ] **Step 4: Schema + implementations (`sqlite.go`)**

Add to the `CREATE TABLE IF NOT EXISTS` block:
```sql
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
```
Implementations:
```go
func (s *SQLiteStore) CreateNodeToken(ctx context.Context, t NodeToken) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO node_tokens (id, token_hash, user_id, node_id, name, created_at) VALUES (?,?,?,?,?,?)`,
		t.ID, t.TokenHash, t.UserID, nullStr(t.NodeID), t.Name, t.CreatedAt)
	return err
}

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

func (s *SQLiteStore) RevokeNodeToken(ctx context.Context, id, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE node_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at = 0`,
		nowUnixMarker, id, userID)
	return err
}

func (s *SQLiteStore) TouchNodeTokenUsed(ctx context.Context, id string, at int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE node_tokens SET last_used_at = ? WHERE id = ?`, at, id)
	return err
}
```
`RevokeNodeToken` needs a timestamp; the store has no clock. Change its signature to accept `at int64`: `RevokeNodeToken(ctx, id, userID string, at int64)` and update the interface + test call (`st.RevokeNodeToken(ctx, "t1", u.ID, 200)`) — mirror how other timestamped store methods take `at`. (Remove the `nowUnixMarker` placeholder above; use the `at` parameter.)

- [ ] **Step 5: Run tests + build**

Run: `cd server && go test ./internal/account/ -run TestNodeTokenLifecycle && go build ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/nodetokens_store_test.go
git commit -m "feat(account): node_tokens table + per-user token store methods"
```

---

## Task 2: `nodeOwner` resolver + register sets owner

**Files:**
- Modify: `server/internal/account/nodes.go`
- Modify: `server/internal/account/service.go` (`Config.EnableUserNodes bool`)
- Test: `server/internal/account/nodes_test.go` (extend)

**Interfaces:**
- Consumes: `NodeTokenByHash`, `BindNodeToken`, `TouchNodeTokenUsed` (Task 1); `hashToken` (service.go).
- Produces: `func (s *Service) nodeOwner(r *http.Request) (ownerType, ownerUserID string, ok bool)`; register creates a node with the resolved owner and binds a user token to the node.

- [ ] **Step 1: Write the failing test**

Add to `server/internal/account/nodes_test.go`:
```go
func TestNodeOwnerFleetAndUser(t *testing.T) {
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(context.Background(), "own@x.com", "o")
	// user token "usertok" -> hash stored
	st.CreateNodeToken(context.Background(), NodeToken{ID: "t1", TokenHash: hashToken("usertok"), UserID: u.ID, Name: "n", CreatedAt: 1})
	s := &Service{store: st, cfg: Config{NodeToken: "fleetsecret", EnableUserNodes: true}, now: func() time.Time { return time.Unix(5, 0) }}

	req := func(bearer string) *http.Request {
		r := httptest.NewRequest("POST", "/", nil)
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		return r
	}
	if ot, _, ok := s.nodeOwner(req("fleetsecret")); !ok || ot != "fleet" {
		t.Fatalf("fleet: %q ok=%v", ot, ok)
	}
	ot, uid, ok := s.nodeOwner(req("usertok"))
	if !ok || ot != "user" || uid != u.ID {
		t.Fatalf("user: %q %q ok=%v", ot, uid, ok)
	}
	if _, _, ok := s.nodeOwner(req("garbage")); ok {
		t.Fatal("unknown token must not resolve")
	}
}

func TestRegisterUserNodeSetsOwner(t *testing.T) {
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(context.Background(), "reg@x.com", "r")
	st.CreateNodeToken(context.Background(), NodeToken{ID: "t1", TokenHash: hashToken("usertok"), UserID: u.ID, Name: "n", CreatedAt: 1})
	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(5, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	body, _ := json.Marshal(nodeRegisterReq{TURNSecret: "sek", URLs: []string{"turn:1.2.3.4:3478"}})
	r := httptest.NewRequest("POST", "/api/nodes/register", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer usertok")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("register: %d", w.Code)
	}
	var resp nodeRegisterResp
	json.Unmarshal(w.Body.Bytes(), &resp)
	n, _, _ := st.GetNode(context.Background(), resp.NodeID)
	if n.OwnerType != "user" || n.OwnerUserID != u.ID {
		t.Fatalf("node owner = %q/%q", n.OwnerType, n.OwnerUserID)
	}
	// token bound to the node
	list, _ := st.ListNodeTokensByUser(context.Background(), u.ID)
	if len(list) != 1 || list[0].NodeID != resp.NodeID {
		t.Fatalf("token not bound: %+v", list)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'NodeOwner|RegisterUserNode'`
Expected: FAIL.

- [ ] **Step 3: Add `Config.EnableUserNodes` + resolver + register owner (`service.go`, `nodes.go`)**

In `service.go` `Config`, add:
```go
	// EnableUserNodes serves the per-user node token path (BYO nodes) even when
	// the shared fleet NodeToken is empty.
	EnableUserNodes bool
```
In `nodes.go`, replace `RegisterNodeRoutes`'s mount guard and add the resolver:
```go
func (s *Service) RegisterNodeRoutes(mux *http.ServeMux) {
	if s.cfg.NodeToken == "" && !s.cfg.EnableUserNodes {
		return
	}
	mux.HandleFunc("POST /api/nodes/register", s.handleNodeRegister)
	mux.HandleFunc("POST /api/nodes/heartbeat", s.handleNodeHeartbeat)
}

// nodeOwner resolves the bearer token to a node owner: the shared fleet token,
// or a per-user node token (hashed lookup). ok=false → 401.
func (s *Service) nodeOwner(r *http.Request) (ownerType, ownerUserID string, ok bool) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" {
		return "", "", false
	}
	if s.cfg.NodeToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.NodeToken)) == 1 {
		return "fleet", "", true
	}
	if s.cfg.EnableUserNodes {
		if nt, found, err := s.store.NodeTokenByHash(r.Context(), hashToken(tok)); err == nil && found {
			_ = s.store.TouchNodeTokenUsed(r.Context(), nt.ID, s.now().Unix())
			return "user", nt.UserID, true
		}
	}
	return "", "", false
}
```
Keep `nodeAuthorized` as a thin wrapper for heartbeat's simple auth check, or replace its uses with `nodeOwner`. In `handleNodeRegister`, replace the auth check and the hardcoded owner:
```go
	ownerType, ownerUserID, ok := s.nodeOwner(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	...
	n := Node{
		ID: req.NodeID, OwnerType: ownerType, OwnerUserID: ownerUserID,
		Region: req.Region, URLs: req.URLs, TURNSecret: req.TURNSecret, Version: req.Version,
		CreatedAt: now, LastSeenAt: now,
		StorageURL: req.StorageURL, StorageSecret: req.StorageSecret,
		StorageEnabled: containsCap(req.Capabilities, "storage"),
		StorageTotal:   req.StorageTotal, StorageFree: req.StorageFree,
	}
	saved, err := s.store.UpsertNode(r.Context(), n)
	...
	// Bind a user token to its node for per-node revoke/delete.
	if ownerType == "user" {
		if nt, found, e := s.store.NodeTokenByHash(r.Context(), hashToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))); e == nil && found {
			_ = s.store.BindNodeToken(r.Context(), nt.ID, saved.ID)
		}
	}
```
Ensure `subtle`, `strings` imported. (`UpsertNode`/`ON CONFLICT` already persists `owner_type`/`owner_user_id`? Verify: SP1's UpsertNode SET clause includes `owner_type=excluded.owner_type, owner_user_id=excluded.owner_user_id` — if it does not, add them to the ON CONFLICT SET so a re-register keeps the owner. Check and fix if needed.)

- [ ] **Step 4: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'NodeOwner|RegisterUserNode|TestNode' && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/nodes.go server/internal/account/service.go server/internal/account/nodes_test.go
git commit -m "feat(account): resolve node owner from fleet-or-user token; register user-owned nodes"
```

---

## Task 3: `usage_events` billable + heartbeat derivation + cross-user reject

**Files:**
- Modify: `server/internal/account/store.go` (`UsageEvent` fields)
- Modify: `server/internal/account/sqlite.go` (ALTERs, `RecordUsage`, `UserRelayedSince`)
- Modify: `server/internal/account/nodes.go` (heartbeat: GetNode, billable, cross-user reject)
- Test: `server/internal/account/sp3_usage_test.go` + extend `nodes_test.go`

**Interfaces:**
- Consumes: `GetNode` (SP2).
- Produces: `UsageEvent` gains `NodeID string; Billable bool`; `RecordUsage` persists them; `UserRelayedSince` sums `billable=1` only.

- [ ] **Step 1: Write the failing test**

`server/internal/account/sp3_usage_test.go`:
```go
package account

import (
	"context"
	"testing"
)

func TestUserRelayedSinceBillableOnly(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "b@x.com", "b")
	// billable fleet-relay event
	st.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "c1", UserID: u.ID, RelayedBytes: 1000, RecordedAt: 100, NodeID: "fleet-1", Billable: true})
	// non-billable own-node event
	st.RecordUsage(ctx, UsageEvent{AllocID: "a2", Token: "c2", UserID: u.ID, RelayedBytes: 5000, RecordedAt: 100, NodeID: "user-1", Billable: false})
	got, err := st.UserRelayedSince(ctx, u.ID, 0)
	if err != nil {
		t.Fatalf("relayed: %v", err)
	}
	if got != 1000 {
		t.Fatalf("quota sum = %d, want 1000 (billable only)", got)
	}
}
```
And extend `nodes_test.go` with heartbeat billable/cross-user behavior:
```go
func TestHeartbeatBillableAndCrossUserReject(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	owner, _ := st.UpsertUserByEmail(ctx, "hbo@x.com", "o")
	// a user-owned node
	n, _ := st.UpsertNode(ctx, Node{ID: "un", OwnerType: "user", OwnerUserID: owner.ID, URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	st.CreateNodeToken(ctx, NodeToken{ID: "t1", TokenHash: hashToken("utok"), UserID: owner.ID, NodeID: "un", Name: "n", CreatedAt: 1})
	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(50, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	// own-user usage -> recorded non-billable; a DIFFERENT user's attribution -> dropped
	hb := nodeHeartbeatReq{NodeID: n.ID, Status: "ok", Usage: []nodeUsage{
		{AllocID: "a1", Username: "9999:" + owner.ID + ".code", RelayedBytes: 4000},
		{AllocID: "a2", Username: "9999:victim.code", RelayedBytes: 7000},
	}}
	body, _ := json.Marshal(hb)
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer utok")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d", w.Code)
	}
	// owner's own usage recorded but non-billable -> quota sum stays 0
	if q, _ := st.UserRelayedSince(ctx, owner.ID, 0); q != 0 {
		t.Fatalf("own-node relay must be non-billable, quota=%d", q)
	}
	// victim got nothing (cross-user attribution dropped)
	if q, _ := st.UserRelayedSince(ctx, "victim", 0); q != 0 {
		t.Fatalf("cross-user attribution must be dropped, victim quota=%d", q)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'UserRelayedSinceBillable|HeartbeatBillable'`
Expected: FAIL.

- [ ] **Step 3: `UsageEvent` fields + ALTER + `RecordUsage` + `UserRelayedSince`**

In `store.go`, add to `UsageEvent`:
```go
	NodeID   string
	Billable bool
```
In `sqlite.go` migration section (idempotent ALTER):
```sql
ALTER TABLE usage_events ADD COLUMN node_id TEXT
ALTER TABLE usage_events ADD COLUMN billable INTEGER NOT NULL DEFAULT 1
```
Update `RecordUsage` to persist them (old rows default billable=1):
```go
func (s *SQLiteStore) RecordUsage(ctx context.Context, e UsageEvent) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO usage_events (alloc_id, token, user_id, relayed_bytes, recorded_at, node_id, billable)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(alloc_id) DO UPDATE SET
		   relayed_bytes = MAX(relayed_bytes, excluded.relayed_bytes),
		   recorded_at = excluded.recorded_at`,
		e.AllocID, e.Token, e.UserID, e.RelayedBytes, e.RecordedAt, nullStr(e.NodeID), b2i(e.Billable))
	return err
}
```
Update `UserRelayedSince` to sum billable only:
```go
	`SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE user_id = ? AND recorded_at >= ? AND billable = 1`
```
(`b2i` is the existing bool→int helper used by `CreateStoredFile`.)

- [ ] **Step 4: Heartbeat derives billable + rejects cross-user + uses GetNode**

In `nodes.go` `handleNodeHeartbeat`, replace the SP1 `ListNodes` existence scan with a single `GetNode`, and thread billable + cross-user reject into the usage loop:
```go
	node, known, err := s.store.GetNode(r.Context(), req.NodeID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !known {
		writeJSON(w, http.StatusGone, map[string]string{"error": "unknown node, re-register"})
		return
	}
	billable := node.OwnerType == "fleet"
	...
	for _, u := range req.Usage {
		token := relayusage.TokenFromUsername(u.Username)
		if token == "" {
			continue
		}
		userID, code := relayusage.SplitAttrib(token)
		// A user-owned node may only attribute usage to its own owner.
		if node.OwnerType == "user" && userID != node.OwnerUserID {
			log.Printf("node %s: dropping cross-user attribution to %s", req.NodeID, userID)
			continue
		}
		if err := s.store.RecordUsage(r.Context(), UsageEvent{
			AllocID: u.AllocID, Token: code, UserID: userID, RelayedBytes: u.RelayedBytes,
			RecordedAt: now, NodeID: req.NodeID, Billable: billable,
		}); err != nil {
			log.Printf("node %s heartbeat: record alloc %s failed: %v", req.NodeID, u.AllocID, err)
		}
	}
```
(This also resolves the SP1-noted `ListNodes`-scan inefficiency.)

- [ ] **Step 5: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'UserRelayedSince|Heartbeat|TestNode' && go build ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/nodes.go server/internal/account/sp3_usage_test.go server/internal/account/nodes_test.go
git commit -m "feat(account): usage billable derived from node owner; own-node relay free; cross-user reject"
```

---

## Task 4: user setting `only_own_nodes` + own-node store queries

**Files:**
- Modify: `server/internal/account/store.go` (`User.OnlyOwnNodes`; interface methods)
- Modify: `server/internal/account/sqlite.go` (ALTER, `GetUserByID`, `SetOnlyOwnNodes`, `UserNodes`, `UserStorageNodes`)
- Test: `server/internal/account/sp3_usernodes_store_test.go`

**Interfaces:**
- Produces:
  - `User` gains `OnlyOwnNodes bool` (populated by `GetUserByID`).
  - `SetOnlyOwnNodes(ctx, userID string, on bool) error`.
  - `UserNodes(ctx, userID string, since int64) ([]Node, error)` — `owner_type='user' AND owner_user_id=? AND last_seen_at >= ?`.
  - `UserNodesAll(ctx, userID string) ([]Node, error)` — all of a user's nodes regardless of `last_seen` (for the dashboard list, which shows offline nodes too).
  - `UserStorageNodes(ctx, userID string, since, minFree int64) ([]Node, error)` — `UserNodes` + `storage_enabled=1 AND storage_free >= ?`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/sp3_usernodes_store_test.go`:
```go
package account

import (
	"context"
	"testing"
)

func TestOnlyOwnNodesFlag(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "s@x.com", "s")
	if g, _ := st.GetUserByID(ctx, u.ID); g.OnlyOwnNodes {
		t.Fatal("default must be false")
	}
	if err := st.SetOnlyOwnNodes(ctx, u.ID, true); err != nil {
		t.Fatalf("set: %v", err)
	}
	if g, _ := st.GetUserByID(ctx, u.ID); !g.OnlyOwnNodes {
		t.Fatal("flag not persisted")
	}
}

func TestUserNodesAndStorageNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "un@x.com", "u")
	other, _ := st.UpsertUserByEmail(ctx, "ot@x.com", "o")
	st.UpsertNode(ctx, Node{ID: "mine", OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:a:3478"}, TURNSecret: "s", StorageEnabled: true, StorageFree: 10 << 30, CreatedAt: 1, LastSeenAt: 1000})
	st.UpsertNode(ctx, Node{ID: "theirs", OwnerType: "user", OwnerUserID: other.ID, URLs: []string{"turn:b:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1000})
	st.UpsertNode(ctx, Node{ID: "fleet", OwnerType: "fleet", URLs: []string{"turn:c:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1000})

	mine, _ := st.UserNodes(ctx, u.ID, 500)
	if len(mine) != 1 || mine[0].ID != "mine" {
		t.Fatalf("UserNodes = %+v", mine)
	}
	sn, _ := st.UserStorageNodes(ctx, u.ID, 500, 4<<30)
	if len(sn) != 1 || sn[0].ID != "mine" {
		t.Fatalf("UserStorageNodes = %+v", sn)
	}
	if got, _ := st.UserStorageNodes(ctx, u.ID, 500, 20<<30); len(got) != 0 {
		t.Fatal("node with 10GiB free excluded for minFree=20GiB")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'OnlyOwnNodes|UserNodesAnd'`
Expected: FAIL.

- [ ] **Step 3: Implement**

`User` struct += `OnlyOwnNodes bool`. Interface += `SetOnlyOwnNodes`, `UserNodes`, `UserNodesAll`, `UserStorageNodes` (and `GetUserByID` gains the `only_own_nodes` scan). In `sqlite.go` migration:
```sql
ALTER TABLE users ADD COLUMN only_own_nodes INTEGER NOT NULL DEFAULT 0
```
Update `GetUserByID` to select+scan `only_own_nodes` (int → bool):
```go
	var strict int
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, only_own_nodes FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict)
	u.OnlyOwnNodes = strict != 0
```
Add:
```go
func (s *SQLiteStore) SetOnlyOwnNodes(ctx context.Context, userID string, on bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET only_own_nodes = ? WHERE id = ?`, b2i(on), userID)
	return err
}

func (s *SQLiteStore) UserNodes(ctx context.Context, userID string, since int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? AND last_seen_at >= ? ORDER BY last_seen_at DESC`,
		userID, since)
}

func (s *SQLiteStore) UserNodesAll(ctx context.Context, userID string) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? ORDER BY last_seen_at DESC`,
		userID)
}

func (s *SQLiteStore) UserStorageNodes(ctx context.Context, userID string, since, minFree int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes WHERE owner_type='user' AND owner_user_id=? AND last_seen_at >= ? AND storage_enabled=1 AND storage_free >= ? ORDER BY last_seen_at DESC`,
		userID, since, minFree)
}
```

- [ ] **Step 4: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'OnlyOwnNodes|UserNodesAnd|User' && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sp3_usernodes_store_test.go
git commit -m "feat(account): only_own_nodes user flag + UserNodes/UserStorageNodes queries"
```

---

## Task 5: `/api/ice` per-user routing + strict mode

**Files:**
- Modify: `server/internal/account/turn.go`
- Test: `server/internal/account/turn_usernodes_test.go`

**Interfaces:**
- Consumes: `UserNodes` (Task 4), `GetUserByID` (Task 4, returns `OnlyOwnNodes`); existing `OnlineNodes`/`turnCredentials`/`relayEntry`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/turn_usernodes_test.go` — owner with an online own node gets it in `relays`; non-strict also gets fleet; strict gets own node only (no fleet, no legacy TURN). Seed a verified user (see the SP1 `TestICEIncludesOnlineNodes` harness for verified-owner + `RelayMonthlyFree` setup), register one user-owned node and one fleet node, and assert:
```go
func TestICEUserNodeRoutingAndStrict(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)
	owner, _ := st.UpsertUserByEmail(ctx, "ice@x.com", "i")
	st.SetEmailVerified(ctx, owner.ID)
	st.UpsertNode(ctx, Node{ID: "own", OwnerType: "user", OwnerUserID: owner.ID, URLs: []string{"turn:own:3478"}, TURNSecret: "so", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{ID: "fleet", OwnerType: "fleet", URLs: []string{"turn:fleet:3478"}, TURNSecret: "sf", CreatedAt: 1, LastSeenAt: now.Unix()})

	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:l:3478"}, RelayMonthlyFree: 1 << 30}}
	s.pairCodeOwner = func(code string) (string, bool) { return owner.ID, true }

	ids := func() map[string]bool {
		r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
		w := httptest.NewRecorder()
		s.handleICE(w, r)
		var resp struct{ Relays []relayEntry `json:"relays"` }
		json.Unmarshal(w.Body.Bytes(), &resp)
		m := map[string]bool{}
		for _, e := range resp.Relays { m[e.ID] = true }
		return m
	}
	// non-strict: own + fleet both present
	m := ids()
	if !m["own"] || !m["fleet"] {
		t.Fatalf("non-strict should include own+fleet, got %v", m)
	}
	// strict: only own
	st.SetOnlyOwnNodes(ctx, owner.ID, true)
	m = ids()
	if !m["own"] || m["fleet"] {
		t.Fatalf("strict should be own-only, got %v", m)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestICEUserNodeRoutingAndStrict`
Expected: FAIL — own node not routed / strict not honored.

- [ ] **Step 3: Implement per-user routing**

In `handleICE`, after resolving `owner`/`validCode` and before/within the relay-pool block, fetch the owner's strict flag and own nodes, and gate the fleet union on non-strict. Replace the SP2 union block:
```go
	if validCode {
		relays := make([]relayEntry, 0)
		seen := map[string]bool{}
		since := now.Add(-nodeOnlineWindow).Unix()

		strict := false
		if u, err := s.store.GetUserByID(r.Context(), owner); err == nil {
			strict = u.OnlyOwnNodes
		} // read error -> non-strict (reliable default)

		// The owner's own nodes (free relay), always included.
		if own, err := s.store.UserNodes(r.Context(), owner, since); err == nil {
			for _, n := range own {
				if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 {
					continue
				}
				relays = append(relays, relayEntry{ID: n.ID, Region: n.Region,
					ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)}})
				seen[n.ID] = true
			}
		}

		if !strict {
			if nodes, err := s.store.OnlineNodes(r.Context(), since); err == nil {
				for _, n := range nodes {
					if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 || seen[n.ID] {
						continue
					}
					relays = append(relays, relayEntry{ID: n.ID, Region: n.Region,
						ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)}})
					seen[n.ID] = true
				}
			} else {
				log.Printf("ice: OnlineNodes read failed: %v (static-only)", err)
			}
			for _, rc := range s.cfg.TURNRelays {
				if rc.ID == "" || rc.Secret == "" || len(rc.URLs) == 0 || seen[rc.ID] {
					continue
				}
				relays = append(relays, relayEntry{ID: rc.ID, Region: rc.Region, STUN: rc.STUN,
					ICEServers: []ICEServer{turnCredentials(rc.Secret, token, expiry, rc.URLs)}})
			}
		}
		if len(relays) > 0 {
			resp["relays"] = relays
		}
	}
```
Also gate the SP1 legacy single top-level TURN entry (`s.cfg.TURNSecret != "" && len(s.cfg.TURNURLs) > 0`) on `!strict` so strict mode truly withholds our TURN. (Find that block above and wrap its condition with a strict check — compute `strict` once and reuse; hoist the `GetUserByID` read above both blocks.)

- [ ] **Step 4: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'TestICE' && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/turn.go server/internal/account/turn_usernodes_test.go
git commit -m "feat(ice): route owner's own nodes; strict mode withholds fleet + our TURN"
```

---

## Task 6: `placeUpload(userID)` prefer own node + skip quota when non-billable

**Files:**
- Modify: `server/internal/account/blobfor.go` (`placeUpload` signature)
- Modify: `server/internal/account/files.go` (`handleUploadFile`)
- Test: `server/internal/account/files_ownnode_test.go`

**Interfaces:**
- Consumes: `UserStorageNodes`, `GetUserByID` (Task 4).
- Produces: `placeUpload(ctx, userID string) (nodeID string, bs storage.BlobStore, billable bool, err error)` — own storage node → `(id, remote, false, nil)`; non-strict fallback → SP2 pick, `billable=true`; strict + no own node → `("", nil, false, errStrictNoNode)`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/files_ownnode_test.go` — reuse `newFileServerWithQuota`, `fakeNode`, `loginCookie`, `postUpload`, `uploadBody`, `decodeJSON`. An upload by a user with an online own storage node lands there, is NON-billable (daily quota NOT debited), and records `NodeID`:
```go
func TestUploadToOwnNodeSkipsQuota(t *testing.T) {
	ts, _, store, mail := newFileServerWithQuota(t, 130*1024, 1<<20)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "own@example.com", "")
	nodeStore := map[string][]byte{}
	fn := fakeNode(t, nodeStore)
	defer fn.Close()
	store.UpsertNode(ctx, Node{ID: "mynode", OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:x:3478"},
		TURNSecret: "t", StorageEnabled: true, StorageURL: fn.URL, StorageSecret: "ss", StorageFree: 100 << 30,
		CreatedAt: 1, LastSeenAt: time.Now().Unix()})

	cookie := loginCookie(t, ts, mail, "own@example.com")
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("ciphertext")))
	if resp.StatusCode != 200 {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct{ ID string `json:"id"` }
	decodeJSON(t, resp, &up)
	sf, _ := store.GetStoredFile(ctx, up.ID)
	if sf.NodeID != "mynode" || string(nodeStore[sf.BlobKey]) != "ciphertext" {
		t.Fatalf("not placed on own node: node=%q blob=%q", sf.NodeID, nodeStore[sf.BlobKey])
	}
	// non-billable: daily upload quota NOT debited
	used, _ := store.UserUploadedSince(ctx, u.ID, 0)
	if used != 0 {
		t.Fatalf("own-node upload must not debit quota, used=%d", used)
	}
}
```
(`loginCookie` must log in the SAME email whose user owns the node — ensure the seeded `u` email matches the login email.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestUploadToOwnNode`
Expected: FAIL — placement ignores the user / quota still debited.

- [ ] **Step 3: `placeUpload(userID)` + handler wiring**

In `blobfor.go`, define the sentinel and rewrite `placeUpload`:
```go
var errStrictNoNode = errors.New("account: strict mode and no online own node")

func (s *Service) placeUpload(ctx context.Context, userID string) (string, storage.BlobStore, bool, error) {
	minFree := s.resolveSettings(ctx).MaxFileSize
	since := s.now().Add(-nodeOnlineWindow).Unix()
	// Prefer the user's own online storage node (free).
	if own, err := s.store.UserStorageNodes(ctx, userID, since, minFree); err == nil && len(own) > 0 {
		n := own[s.pickN(len(own))]
		return n.ID, storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, s.nodeHTTP), false, nil
	}
	// Strict users do not fall back to our infrastructure.
	if u, err := s.store.GetUserByID(ctx, userID); err == nil && u.OnlyOwnNodes {
		return "", nil, false, errStrictNoNode
	}
	// Non-strict fallback: fleet storage node or central (billable).
	nodes, err := s.store.StorageNodes(ctx, since, minFree)
	if err != nil {
		log.Printf("placeUpload: StorageNodes read failed: %v (central)", err)
	}
	if len(nodes) == 0 {
		return "", s.blobs, true, nil
	}
	n := nodes[s.pickN(len(nodes))]
	return n.ID, storage.NewRemoteBlobStore(n.StorageURL, n.StorageSecret, s.nodeHTTP), true, nil
}
```
In `handleUploadFile`, change the placement call and gate the quota logic on `billable`:
```go
	nodeID, bs, billable, perr := s.placeUpload(r.Context(), u.ID)
	if errors.Is(perr, errStrictNoNode) {
		http.Error(w, "your storage node is offline", http.StatusServiceUnavailable)
		return
	}
```
Wrap BOTH the content-length daily-quota pre-check AND the `ReserveUpload` call in `if billable { ... }` (an own-node upload uses the user's own disk — no daily-quota debit). Keep the M3b central-disk gate as `nodeID == ""` (SP2). Everything else (blob write via `bs`, rollback via `bs`, `StoredFile.NodeID = nodeID`, stats) unchanged. NOTE: when `!billable`, `ReserveUpload` is skipped, so do NOT run the rollback branch that refunds a reserve that never happened — structure the code so the `ReserveUpload` block and its `!ok`/error rollback are entirely inside the `if billable` guard.

- [ ] **Step 4: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'Upload|TestICE|MinBillable|DiskCap' && go build ./...`
Expected: PASS (own-node routing + no regression to billable uploads).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/blobfor.go server/internal/account/files.go server/internal/account/files_ownnode_test.go
git commit -m "feat(account): uploads prefer user's own storage node (free, quota-exempt); strict 503"
```

---

## Task 7: user node management API (provision / mine / delete / strict) + DeleteNode

**Files:**
- Create: `server/internal/account/usernodes.go`
- Modify: `server/internal/account/handlers.go` (mount routes; `handleMe` returns `onlyOwnNodes`)
- Modify: `server/internal/account/sqlite.go` (`DeleteNode`)
- Modify: `server/internal/account/store.go` (interface += `DeleteNode`)
- Test: `server/internal/account/usernodes_test.go`

**Interfaces:**
- Consumes: `CreateNodeToken`/`ListNodeTokensByUser`/`RevokeNodeToken` (T1), `UserNodes`/`SetOnlyOwnNodes` (T4), `hashToken`/`newID` (existing), `nodeOnlineWindow`.
- Produces: `DeleteNode(ctx, id, ownerUserID string) error` (owner-scoped; also clears the node's `pending_node_deletes`); handlers `handleProvisionNode`/`handleMyNodes`/`handleDeleteMyNode`/`handleStrictNodes`.

- [ ] **Step 1: Write the failing test**

`server/internal/account/usernodes_test.go` — drive the endpoints through a `NewService(...).Routes()` httptest server with a login cookie (mirror the file tests' `loginCookie`). Assert: provision returns a plaintext token once and persists only its hash; mine lists the user's own nodes; delete is owner-scoped (a user cannot delete another user's node → 404) and revokes the token; strict toggles the flag. (Full code: mirror `usernodes.go`'s response shapes below and the existing `loginCookie`/session test harness; assert `provision` response has a non-empty `token`, `NodeTokenByHash(hashToken(token))` resolves to the user, and after `DELETE` the node row is gone and the token no longer resolves.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestUserNodesAPI`
Expected: FAIL — handlers/`DeleteNode` undefined.

- [ ] **Step 3: `DeleteNode` store method**

`store.go` interface += `DeleteNode(ctx context.Context, id, ownerUserID string) error`. `sqlite.go`:
```go
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
```

- [ ] **Step 4: Implement the handlers (`usernodes.go`)**

```go
package account

import (
	"encoding/json"
	"net/http"
)

const maxNodeTokensPerUser = 10

type provisionReq struct{ Name string `json:"name"` }

func (s *Service) handleProvisionNode(w http.ResponseWriter, r *http.Request, u User) {
	var req provisionReq
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	if req.Name == "" {
		req.Name = "node"
	}
	existing, err := s.store.ListNodeTokensByUser(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if len(existing) >= maxNodeTokensPerUser {
		http.Error(w, "too many nodes", http.StatusTooManyRequests)
		return
	}
	raw := randToken() // unguessable plaintext, shown once
	id := newID()
	if err := s.store.CreateNodeToken(r.Context(), NodeToken{
		ID: id, TokenHash: hashToken(raw), UserID: u.ID, Name: req.Name, CreatedAt: s.now().Unix(),
	}); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "token": raw, "name": req.Name})
}

func (s *Service) handleMyNodes(w http.ResponseWriter, r *http.Request, u User) {
	// Include offline nodes too (list all the user owns), with an online flag.
	since := s.now().Add(-nodeOnlineWindow).Unix()
	nodes, err := s.store.UserNodesAll(r.Context(), u.ID) // owner's nodes regardless of last_seen
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, map[string]any{
			"id": n.ID, "name": "", "region": n.Region,
			"online":       n.LastSeenAt >= since,
			"relayedBytes": n.RelayedBytes, "storedBytes": n.StoredBytes,
			"storageFree": n.StorageFree, "storageTotal": n.StorageTotal, "lastSeen": n.LastSeenAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": out})
}

func (s *Service) handleDeleteMyNode(w http.ResponseWriter, r *http.Request, u User) {
	id := r.PathValue("id")
	if err := s.store.DeleteNode(r.Context(), id, u.ID); err != nil {
		http.Error(w, "not found", http.StatusNotFound) // non-owner and missing are indistinguishable
		return
	}
	// Revoke any token bound to this node (owner-scoped).
	toks, _ := s.store.ListNodeTokensByUser(r.Context(), u.ID)
	for _, t := range toks {
		if t.NodeID == id {
			_ = s.store.RevokeNodeToken(r.Context(), t.ID, u.ID, s.now().Unix())
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type strictReq struct{ OnlyOwnNodes bool `json:"onlyOwnNodes"` }

func (s *Service) handleStrictNodes(w http.ResponseWriter, r *http.Request, u User) {
	var req strictReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := s.store.SetOnlyOwnNodes(r.Context(), u.ID, req.OnlyOwnNodes); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"onlyOwnNodes": req.OnlyOwnNodes})
}
```
`handleMyNodes` uses `UserNodesAll(ctx, userID) ([]Node, error)` — defined in Task 4 (all of a user's nodes regardless of `last_seen`). The `name` field: `nodes` has no name column; v1 omits per-node name (show region + short id). `online` is derived from `LastSeenAt >= now - nodeOnlineWindow`.

- [ ] **Step 5: Mount routes + `handleMe` flag (`handlers.go`)**

In `routeMux`, add (session-authed, CSRF-guarded like the rest):
```go
	mux.HandleFunc("POST /api/nodes/provision", s.RequireSession(s.handleProvisionNode))
	mux.HandleFunc("GET /api/nodes/mine", s.RequireSession(s.handleMyNodes))
	mux.HandleFunc("DELETE /api/nodes/{id}", s.RequireSession(s.handleDeleteMyNode))
	mux.HandleFunc("PUT /api/me/strict-nodes", s.RequireSession(s.handleStrictNodes))
```
(These live under `/api/` → `acct.Routes()` → csrfGuard, distinct from the bearer `POST /api/nodes/register`/`heartbeat` on the root mux — Go's ServeMux routes the exact register/heartbeat patterns on the root mux and everything else `/api/*` into `acct.Routes()`.) In `handleMe`, add `"onlyOwnNodes": u.OnlyOwnNodes` to the returned user map.

- [ ] **Step 6: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'UserNodesAPI|Me' && go build ./...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/usernodes.go server/internal/account/handlers.go server/internal/account/sqlite.go server/internal/account/store.go server/internal/account/usernodes_test.go
git commit -m "feat(account): user node API (provision/mine/delete/strict) + owner-scoped DeleteNode"
```

---

## Task 8: GC evicts aged `pending_node_deletes` (SP2 M6)

**Files:**
- Modify: `server/internal/account/gc.go`
- Modify: `server/internal/account/sqlite.go` + `store.go` (`DeletePendingNodeDeletesOlderThan`)
- Test: `server/internal/account/gc_nodes_test.go` (extend)

**Interfaces:**
- Produces: `DeletePendingNodeDeletesOlderThan(ctx, before int64) error`; GC drops pending rows older than `pendingDeleteMaxAge` (7 days).

- [ ] **Step 1: Write the failing test**

Extend `gc_nodes_test.go`:
```go
func TestGCEvictsAgedPendingDeletes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	st.EnqueueNodeDelete(ctx, "bk-old", "dead-node", 1000) // enqueued long ago
	st.EnqueueNodeDelete(ctx, "bk-new", "dead-node", 9_000_000)
	// before = now - 7d; with now large, bk-old is aged out, bk-new survives.
	before := int64(9_000_000) - int64(7*24*3600)
	if err := st.DeletePendingNodeDeletesOlderThan(ctx, before); err != nil {
		t.Fatalf("evict: %v", err)
	}
	list, _ := st.ListPendingNodeDeletes(ctx)
	if len(list) != 1 || list[0].BlobKey != "bk-new" {
		t.Fatalf("aged eviction wrong: %+v", list)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestGCEvictsAgedPending`
Expected: FAIL — method undefined.

- [ ] **Step 3: Implement**

`store.go` interface += `DeletePendingNodeDeletesOlderThan(ctx context.Context, before int64) error`. `sqlite.go`:
```go
func (s *SQLiteStore) DeletePendingNodeDeletesOlderThan(ctx context.Context, before int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM pending_node_deletes WHERE enqueued_at < ?`, before)
	return err
}
```
In `gc.go`, add the constant and call it in `drainPending` (or `sweep`):
```go
const pendingDeleteMaxAge = int64(7 * 24 * 3600) // 7 days
```
At the end of `drainPending` (after the retry loop):
```go
	if err := g.Store.DeletePendingNodeDeletesOlderThan(ctx, g.Now()-pendingDeleteMaxAge); err != nil {
		g.Log.Printf("gc: evict aged pending deletes: %v", err)
	}
```

- [ ] **Step 4: Run tests + build**

Run: `cd server && go test ./internal/account/ -run 'GC' && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/gc.go server/internal/account/sqlite.go server/internal/account/store.go server/internal/account/gc_nodes_test.go
git commit -m "feat(gc): evict pending_node_deletes older than 7d (SP2 M6)"
```

---

## Task 9: Svelte "My Nodes" section + strict toggle

**Files:**
- Modify: `web/src/lib/MePage.svelte`
- Test: `web/src/lib/MePage.nodes.test.ts` (Vitest) — or extend an existing MePage/auth spec.

**Interfaces:**
- Consumes: `GET /api/nodes/mine`, `POST /api/nodes/provision`, `DELETE /api/nodes/{id}`, `PUT /api/me/strict-nodes`, `GET /api/me` (`onlyOwnNodes`).

- [ ] **Step 1: Write the failing test**

`web/src/lib/MePage.nodes.test.ts` — mirror the existing Vitest patterns (`router.test.ts`/`auth.test.ts`). Test the pure logic pieces (do not require a full DOM mount if the repo's other component tests don't): a small exported helper `runCommandFor(token: string): string` that builds the paste-in run command, and that the provision flow surfaces the token exactly once. If the repo has component-mount tests, add one asserting the "My Nodes" list renders one row per `/api/nodes/mine` entry with an online indicator. Concretely, extract a pure helper in a `.svelte.ts` or inline `<script module>` so it is unit-testable:
```ts
import { describe, it, expect } from "vitest";
import { nodeRunCommand } from "./MePage.svelte"; // export the helper from the module script

describe("nodeRunCommand", () => {
  it("embeds the token and central URL", () => {
    const cmd = nodeRunCommand("TOK123", "https://relayium.com");
    expect(cmd).toContain("RELAYIUM_NODE_TOKEN=TOK123");
    expect(cmd).toContain("RELAYIUM_CENTRAL_URL=https://relayium.com");
  });
});
```
(If exporting from `.svelte` is awkward in this toolchain, put `nodeRunCommand` in a new `web/src/lib/nodes.ts` and import it in both the component and the test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/MePage.nodes.test.ts`
Expected: FAIL — helper undefined.

- [ ] **Step 3: Implement the helper + section**

Create `web/src/lib/nodes.ts`:
```ts
// nodeRunCommand builds the one-line command a user pastes on their box to run
// their BYO relay node bound to their account.
export function nodeRunCommand(token: string, centralURL: string): string {
  return `RELAYIUM_CENTRAL_URL=${centralURL} RELAYIUM_NODE_TOKEN=${token} relayium-node -storage-dir /var/lib/relayium-node/blobs`;
}
```
In `MePage.svelte` (`<script lang="ts">`), following the existing files-section pattern (`fetch(..., {credentials:"include"})`, `$state`, `onMount`), add:
- `let nodes = $state<any[]>([])`, `let newToken = $state<string | null>(null)`, `let strict = $state(false)`.
- `loadNodes()`: `fetch("/api/nodes/mine")` → `nodes`. Call in `onMount`/`load`.
- Read `onlyOwnNodes` from the `/api/me` response into `strict`.
- `addNode()`: `POST /api/nodes/provision` `{name}` → set `newToken = res.token`; refresh list. Render `newToken` once with `nodeRunCommand(newToken, location.origin)` in a copyable block and a "Done" button that clears `newToken`.
- `deleteNode(id)`: `DELETE /api/nodes/${id}` → refresh.
- `toggleStrict()`: `PUT /api/me/strict-nodes` `{onlyOwnNodes: strict}`.
- A `<section class="nodes">` with a heading, the strict-mode checkbox, an "Add node" button, and `{#each nodes as n (n.id)}` rows showing name/region, an online dot, `bytes`-formatted relayed/stored (label them "免费"/free), and a delete button. Match the existing i18n approach (`t.me.*`) — add the needed strings to the locale files the same way other MePage strings are defined; if that is heavyweight, use plain Chinese literals consistent with the surrounding page.

- [ ] **Step 4: Run tests + build**

Run: `cd web && npx vitest run src/lib/MePage.nodes.test.ts && npm run build`
Expected: PASS + the web build succeeds (the Svelte component compiles).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/nodes.ts web/src/lib/MePage.svelte web/src/lib/MePage.nodes.test.ts
git commit -m "feat(web): My Nodes section — add/list/delete BYO nodes + strict-mode toggle"
```

---

## Self-Review Notes

**Spec coverage:** node_tokens + methods → T1; nodeOwner resolver + register owner + bind → T2; usage_events billable + heartbeat derivation + cross-user reject + UserRelayedSince billable-only → T3; only_own_nodes + UserNodes/UserStorageNodes → T4; /api/ice per-user routing + strict → T5; placeUpload(userID) + quota-exempt own-node upload + strict 503 → T6; user API (provision/mine/delete/strict) + DeleteNode → T7; My Nodes Svelte UI → T9; GC pending eviction (SP2 M6) → T8. I2 mitigation is realized across T2 (per-node revocable tokens) + T3 (cross-user reject + non-billable).

**Cross-task type consistency:** `NodeToken` (T1) consumed by T2/T7; `nodeOwner`→owner_type/owner_user_id (T2) consumed by T3/T5/T6; `UsageEvent{NodeID,Billable}` (T3) consumed by heartbeat; `User.OnlyOwnNodes` + `UserNodes`/`UserStorageNodes`/`UserNodesAll` (T4) consumed by T5/T6/T7; `placeUpload(ctx,userID)(id,bs,billable,err)` (T6) consumed by handleUploadFile; `DeleteNode`/`DeletePendingNodeDeletesOlderThan` (T7/T8). `hashToken`/`randToken`/`newID`/`b2i`/`nullStr`/`nodeCols`/`nodeOnlineWindow` are existing helpers.

**Deferred/flagged for reviewers:** T2 must confirm SP1 `UpsertNode`'s `ON CONFLICT` persists `owner_type`/`owner_user_id` (add to the SET clause if missing, else a re-register would blank a user node's owner). T7 adds `UserNodesAll` — keep its store query in T4's file. T9 frontend test strategy adapts to the repo's Vitest/component-test conventions (helper extracted to `nodes.ts` so it is unit-testable regardless).
