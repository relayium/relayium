# Admin-managed Official Relay Nodes + Per-node Limits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin mint official (fleet) relay-node tokens from the `/admin` panel, view/manage those nodes, and set per-node monthly-traffic and disk hard caps that the relay pool and storage placement enforce.

**Architecture:** Mirror the existing user "add node" flow (mint token → run `relayium-node` → node self-registers) but admin-scoped and userless. Store admin-minted fleet tokens in a new `fleet_tokens` table (the existing `node_tokens.user_id` is `NOT NULL REFERENCES users(id)`, so it can't hold a userless token). Add two limit columns to `nodes` and enforce them as hard cutoffs in `handleICE` (monthly traffic) and `StorageNodes` (disk). Surface everything in the existing server-rendered admin dashboard.

**Tech Stack:** Go (stdlib `net/http`, `html/template`), SQLite (`internal/account/sqlite.go`), Svelte only for reference (no frontend change). All work is in `server/internal/account/`.

## Global Constraints

- Package under test: `github.com/relayium/relayium/internal/account`; run tests from the `server/` directory (`cd server && go test ./internal/account/...`).
- SQLite migrations: new tables via `CREATE TABLE IF NOT EXISTS` appended to the `schema` constant; new columns via an idempotent `ALTER TABLE … ADD COLUMN` entry in the loop at `sqlite.go:176`, guarded by `!strings.Contains(err.Error(), "duplicate column name")`. There is **no** migration-version framework.
- `nodeCols` (sqlite.go:1092) is the single SELECT column list shared by every node read path; any column added to `nodes` MUST be appended to `nodeCols`, to the `UpsertNode` INSERT placeholder list/args, and to the `queryNodes` scan (sqlite.go:1217) in the same order.
- Limits are **fleet-node-only** and **hard caps** (over → withheld, never merely flagged). `0` = unlimited. Traffic resets **monthly** using `monthRange(periodOf(now))` (sqlite.go:1014/1018) — the same period helper the user relay quota uses.
- Token plaintext is shown exactly once at mint; only its `sha256` hash (via `hashToken`, service.go:175) is persisted. Mint the raw token with `randToken()` (service.go:167).
- Admin state-changing routes MUST be wrapped in `s.csrfGuard` in `RegisterAdmin` and gated by `s.isAdminReq(r)` inside the handler (mirror `handleAdminSettings`, admin.go:307).
- Central URL for the install command is `s.cfg.BaseURL` (already used by verify/reset links).

---

### Task 1: `fleet_tokens` table + store CRUD

**Files:**
- Modify: `server/internal/account/sqlite.go` (schema const ~line 135 area; new methods near the `node_tokens` methods ~line 1272)
- Modify: `server/internal/account/store.go` (add `FleetToken` struct ~line 165; add interface methods ~line 339)
- Test: `server/internal/account/fleet_tokens_store_test.go` (new)

**Interfaces:**
- Produces:
  - `type FleetToken struct { ID, TokenHash, Name, NodeID string; CreatedAt, LastUsedAt, RevokedAt int64 }`
  - `CreateFleetToken(ctx context.Context, t FleetToken) error`
  - `FleetTokenByHash(ctx context.Context, hash string) (FleetToken, bool, error)` — only non-revoked rows; ok=false for absent or revoked.
  - `BindFleetToken(ctx context.Context, id, nodeID string) error`
  - `TouchFleetTokenUsed(ctx context.Context, id string, at int64) error`
  - `RevokeFleetToken(ctx context.Context, id string, at int64) error` — no owner scoping (admin-global).
  - `ListActiveFleetTokens(ctx context.Context) ([]FleetToken, error)` — non-revoked, newest first.

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/fleet_tokens_store_test.go`:

```go
package account

import (
	"context"
	"testing"
)

func TestFleetTokenLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	tok := FleetToken{ID: "ft1", TokenHash: hashToken("raw-secret"), Name: "sh-1", CreatedAt: 100}
	if err := st.CreateFleetToken(ctx, tok); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Resolvable by hash while active.
	got, ok, err := st.FleetTokenByHash(ctx, hashToken("raw-secret"))
	if err != nil || !ok || got.ID != "ft1" || got.Name != "sh-1" {
		t.Fatalf("byhash active: got=%+v ok=%v err=%v", got, ok, err)
	}

	// Bind to a node, then it shows up in the active list.
	if err := st.BindFleetToken(ctx, "ft1", "node-9"); err != nil {
		t.Fatalf("bind: %v", err)
	}
	active, err := st.ListActiveFleetTokens(ctx)
	if err != nil || len(active) != 1 || active[0].NodeID != "node-9" {
		t.Fatalf("list active: %+v err=%v", active, err)
	}

	// Revoke -> no longer resolvable, no longer listed.
	if err := st.RevokeFleetToken(ctx, "ft1", 200); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok, _ := st.FleetTokenByHash(ctx, hashToken("raw-secret")); ok {
		t.Fatal("revoked token must not resolve")
	}
	if active, _ := st.ListActiveFleetTokens(ctx); len(active) != 0 {
		t.Fatalf("revoked token must not be listed, got %+v", active)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestFleetTokenLifecycle`
Expected: FAIL — compile error `st.CreateFleetToken undefined` / `FleetToken` not defined.

- [ ] **Step 3: Add the `FleetToken` struct and interface methods**

In `store.go`, after the `NodeToken` struct (ends line 165) add:

```go
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
```

In `store.go`, inside the `Store` interface after the `node_tokens` block (after line 339 `TouchNodeTokenUsed`) add:

```go
	// fleet_tokens (admin-minted, userless official-node bearer credentials)
	CreateFleetToken(ctx context.Context, t FleetToken) error
	FleetTokenByHash(ctx context.Context, hash string) (FleetToken, bool, error)
	BindFleetToken(ctx context.Context, id, nodeID string) error
	TouchFleetTokenUsed(ctx context.Context, id string, at int64) error
	RevokeFleetToken(ctx context.Context, id string, at int64) error
	ListActiveFleetTokens(ctx context.Context) ([]FleetToken, error)
```

- [ ] **Step 4: Add the table to the schema constant**

In `sqlite.go`, in the `schema` string constant, immediately after the `node_tokens` table block (the `CREATE INDEX IF NOT EXISTS idx_node_tokens_user …` line at sqlite.go:145), add:

```sql
CREATE TABLE IF NOT EXISTS fleet_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT,
  node_id      TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 5: Implement the store methods**

In `sqlite.go`, after `TouchNodeTokenUsed` (ends line 1338) add:

```go
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestFleetTokenLifecycle`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/fleet_tokens_store_test.go
git commit -m "feat(nodes): fleet_tokens table + store CRUD for admin-minted official tokens"
```

---

### Task 2: `nodes` limit columns + SetNodeLimits + DeleteFleetNode

**Files:**
- Modify: `server/internal/account/store.go` (`Node` struct line 134; interface ~line 325)
- Modify: `server/internal/account/sqlite.go` (ALTER loop line 176; `nodeCols` line 1092; `UpsertNode` line 1104; `queryNodes` scan line 1217; new methods)
- Test: `server/internal/account/node_limits_store_test.go` (new)

**Interfaces:**
- Consumes: `Node` (extended), `nodeCols`, `queryNodes` from Task 0/existing.
- Produces:
  - `Node` gains `TrafficLimitBytes int64` and `DiskLimitBytes int64`.
  - `SetNodeLimits(ctx context.Context, nodeID string, trafficLimit, diskLimit int64) error`
  - `DeleteFleetNode(ctx context.Context, id string) error` — deletes only `owner_type='fleet'`; `ErrNotFound` otherwise; also clears `pending_node_deletes`.

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/node_limits_store_test.go`:

```go
package account

import (
	"context"
	"errors"
	"testing"
)

func TestNodeLimitsRoundTripAndPreserveOnUpsert(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	n, err := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// Defaults are unlimited (0).
	if got, _, _ := st.GetNode(ctx, n.ID); got.TrafficLimitBytes != 0 || got.DiskLimitBytes != 0 {
		t.Fatalf("defaults not zero: %+v", got)
	}
	// Admin sets limits.
	if err := st.SetNodeLimits(ctx, n.ID, 500<<30, 100<<30); err != nil {
		t.Fatalf("setlimits: %v", err)
	}
	got, _, _ := st.GetNode(ctx, n.ID)
	if got.TrafficLimitBytes != 500<<30 || got.DiskLimitBytes != 100<<30 {
		t.Fatalf("limits not stored: %+v", got)
	}
	// A re-register (upsert of same id) must NOT reset admin-set limits.
	if _, err := st.UpsertNode(ctx, Node{ID: n.ID, OwnerType: "fleet", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: 2}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	got, _, _ = st.GetNode(ctx, n.ID)
	if got.TrafficLimitBytes != 500<<30 || got.DiskLimitBytes != 100<<30 {
		t.Fatalf("limits lost on re-register: %+v", got)
	}
}

func TestDeleteFleetNodeScoped(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	fleet, _ := st.UpsertNode(ctx, Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	user, _ := st.UpsertNode(ctx, Node{OwnerType: "user", OwnerUserID: "u1", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})

	// A user node must not be deletable via DeleteFleetNode.
	if err := st.DeleteFleetNode(ctx, user.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("user node via DeleteFleetNode: want ErrNotFound, got %v", err)
	}
	// The fleet node deletes.
	if err := st.DeleteFleetNode(ctx, fleet.ID); err != nil {
		t.Fatalf("delete fleet: %v", err)
	}
	if _, ok, _ := st.GetNode(ctx, fleet.ID); ok {
		t.Fatal("fleet node still present")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'TestNodeLimits|TestDeleteFleetNode'`
Expected: FAIL — `TrafficLimitBytes` / `SetNodeLimits` / `DeleteFleetNode` undefined.

- [ ] **Step 3: Extend the `Node` struct**

In `store.go`, in the `Node` struct after `StorageFree int64` (line 150) add:

```go
	// Admin-set hard caps for official (fleet) nodes; 0 = unlimited. TrafficLimit
	// is a monthly relay-bytes cap enforced in handleICE; DiskLimit caps stored
	// bytes and is enforced in StorageNodes placement.
	TrafficLimitBytes int64
	DiskLimitBytes    int64
```

- [ ] **Step 4: Add the columns via idempotent ALTER**

In `sqlite.go`, append to the ALTER slice in the loop at line 176 (after the `only_own_nodes` entry at line 189):

```go
		// Admin-set per-node hard caps for official nodes (0 = unlimited):
		// monthly relay traffic and disk usage.
		`ALTER TABLE nodes ADD COLUMN traffic_limit_bytes INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE nodes ADD COLUMN disk_limit_bytes INTEGER NOT NULL DEFAULT 0`,
```

- [ ] **Step 5: Add the columns to `nodeCols`, `UpsertNode`, and the scan**

In `sqlite.go`, change `nodeCols` (line 1092) to append the two columns:

```go
const nodeCols = `id, owner_type, owner_user_id, region, urls, turn_secret, version,
  relayed_bytes, stored_bytes, created_at, last_seen_at,
  storage_url, storage_secret, storage_enabled, storage_total, storage_free,
  traffic_limit_bytes, disk_limit_bytes`
```

In `UpsertNode` (line 1104) change the VALUES list from 16 to 18 placeholders and add the two args, **without** listing them in `DO UPDATE SET` (so a re-register preserves admin-set limits):

```go
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO nodes (`+nodeCols+`)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(id) DO UPDATE SET
		   owner_type=excluded.owner_type, owner_user_id=excluded.owner_user_id,
		   region=excluded.region, urls=excluded.urls, turn_secret=excluded.turn_secret,
		   version=excluded.version, last_seen_at=excluded.last_seen_at,
		   storage_url=excluded.storage_url, storage_secret=excluded.storage_secret,
		   storage_enabled=excluded.storage_enabled, storage_total=excluded.storage_total,
		   storage_free=excluded.storage_free`,
		n.ID, n.OwnerType, nullStr(n.OwnerUserID), n.Region, string(urls), n.TURNSecret,
		n.Version, n.RelayedBytes, n.StoredBytes, n.CreatedAt, n.LastSeenAt,
		nullStr(n.StorageURL), nullStr(n.StorageSecret), b2i(n.StorageEnabled), n.StorageTotal, n.StorageFree,
		n.TrafficLimitBytes, n.DiskLimitBytes)
```

In `queryNodes` (line 1217) add the two fields to the `Scan` (at the end, after `&n.StorageFree`):

```go
		if err := rows.Scan(&n.ID, &n.OwnerType, &ownerUser, &n.Region, &urls, &n.TURNSecret,
			&n.Version, &n.RelayedBytes, &n.StoredBytes, &n.CreatedAt, &n.LastSeenAt,
			&storageURL, &storageSecret, &storageEnabled, &n.StorageTotal, &n.StorageFree,
			&n.TrafficLimitBytes, &n.DiskLimitBytes); err != nil {
			return nil, err
		}
```

- [ ] **Step 6: Add `SetNodeLimits` and `DeleteFleetNode`**

In `sqlite.go`, after `DeleteNode` (ends line 1202) add:

```go
// SetNodeLimits sets a node's admin hard caps (bytes; 0 = unlimited).
func (s *SQLiteStore) SetNodeLimits(ctx context.Context, nodeID string, trafficLimit, diskLimit int64) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE nodes SET traffic_limit_bytes = ?, disk_limit_bytes = ? WHERE id = ?`,
		trafficLimit, diskLimit, nodeID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
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
```

In `store.go`, in the `Store` interface after `DeleteNode(...)` (line 325) add:

```go
	// SetNodeLimits sets a node's admin hard caps (bytes; 0 = unlimited).
	SetNodeLimits(ctx context.Context, nodeID string, trafficLimit, diskLimit int64) error
	// DeleteFleetNode removes an official (fleet) node, scoped to owner_type='fleet'.
	DeleteFleetNode(ctx context.Context, id string) error
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'TestNodeLimits|TestDeleteFleetNode'`
Expected: PASS.

- [ ] **Step 8: Run the full package to catch column-count regressions**

Run: `cd server && go test ./internal/account/...`
Expected: PASS (guards against a missed `nodeCols`/scan mismatch breaking existing node tests).

- [ ] **Step 9: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/node_limits_store_test.go
git commit -m "feat(nodes): per-node traffic/disk limit columns + SetNodeLimits + DeleteFleetNode"
```

---

### Task 3: `NodeRelayedSince` — monthly relayed bytes per node

**Files:**
- Modify: `server/internal/account/store.go` (interface ~line 269, near `UserRelayedSince`)
- Modify: `server/internal/account/sqlite.go` (near `UserRelayedSince`, line 591)
- Test: `server/internal/account/node_relayed_since_test.go` (new)

**Interfaces:**
- Produces: `NodeRelayedSince(ctx context.Context, since int64) (map[string]int64, error)` — for every node with usage recorded at/after `since`, the summed `relayed_bytes`, keyed by node id.

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/node_relayed_since_test.go`:

```go
package account

import (
	"context"
	"testing"
)

func TestNodeRelayedSince(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// Two allocs on node A (100 + 250) and one on node B (40), all this period;
	// one older alloc on A (999) that must be excluded by the `since` cutoff.
	st.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "c", UserID: "u", RelayedBytes: 100, RecordedAt: 2000, NodeID: "A", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "a2", Token: "c", UserID: "u", RelayedBytes: 250, RecordedAt: 2500, NodeID: "A", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "b1", Token: "c", UserID: "u", RelayedBytes: 40, RecordedAt: 2100, NodeID: "B", Billable: true})
	st.RecordUsage(ctx, UsageEvent{AllocID: "old", Token: "c", UserID: "u", RelayedBytes: 999, RecordedAt: 100, NodeID: "A", Billable: true})

	m, err := st.NodeRelayedSince(ctx, 1000)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if m["A"] != 350 {
		t.Fatalf("node A = %d, want 350", m["A"])
	}
	if m["B"] != 40 {
		t.Fatalf("node B = %d, want 40", m["B"])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestNodeRelayedSince`
Expected: FAIL — `st.NodeRelayedSince undefined`.

- [ ] **Step 3: Implement the method**

In `sqlite.go`, after `UserRelayedSince` (ends line 596) add:

```go
// NodeRelayedSince sums relayed bytes per node for usage recorded at or after
// `since` (the current month for the per-node traffic cap). Keyed by node id;
// nodes with no usage in the window are absent (treated as 0 by callers).
func (s *SQLiteStore) NodeRelayedSince(ctx context.Context, since int64) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT node_id, COALESCE(SUM(relayed_bytes),0) FROM usage_events
		   WHERE recorded_at >= ? AND node_id IS NOT NULL GROUP BY node_id`, since)
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
```

In `store.go`, in the interface after `UserRelayedSince(...)` (line 269) add:

```go
	// NodeRelayedSince sums relayed bytes per node for usage since `since`
	// (per-node monthly traffic cap), keyed by node id.
	NodeRelayedSince(ctx context.Context, since int64) (map[string]int64, error)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestNodeRelayedSince`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/node_relayed_since_test.go
git commit -m "feat(nodes): NodeRelayedSince — per-node monthly relayed bytes"
```

---

### Task 4: Resolve admin-minted fleet tokens in `nodeOwner` + bind on register

**Files:**
- Modify: `server/internal/account/nodes.go` (`nodeOwner` line 64; `handleNodeRegister` bind block line 137)
- Test: `server/internal/account/fleet_token_owner_test.go` (new)

**Interfaces:**
- Consumes: `FleetTokenByHash`, `TouchFleetTokenUsed`, `BindFleetToken` (Task 1); `hashToken` (existing).
- Produces: `nodeOwner` now returns `("fleet","")` for a valid admin-minted fleet token; register binds that token to the created node id.

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/fleet_token_owner_test.go`:

```go
package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestNodeOwnerAdminFleetToken(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	// EnableUserNodes true so the hashed-lookup branch runs; no env NodeToken.
	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(5000, 0) }}

	raw := "admin-minted-secret"
	st.CreateFleetToken(ctx, FleetToken{ID: "ft1", TokenHash: hashToken(raw), Name: "sh", CreatedAt: 1})

	r, _ := http.NewRequest("POST", "/", nil)
	r.Header.Set("Authorization", "Bearer "+raw)
	ot, uid, ok := s.nodeOwner(r)
	if !ok || ot != "fleet" || uid != "" {
		t.Fatalf("admin fleet token: got (%q,%q,%v)", ot, uid, ok)
	}

	// A revoked token no longer authenticates.
	st.RevokeFleetToken(ctx, "ft1", 2)
	if _, _, ok := s.nodeOwner(r); ok {
		t.Fatal("revoked fleet token must not authenticate")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestNodeOwnerAdminFleetToken`
Expected: FAIL — a bearer with no matching env token / node_tokens returns `ok=false`.

- [ ] **Step 3: Add the fleet-token branch to `nodeOwner`**

In `nodes.go`, in `nodeOwner` (line 64), insert the admin-fleet lookup **after** the env-token compare (line 71) and **before** the user `node_tokens` lookup (line 72):

```go
	if s.cfg.NodeToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.cfg.NodeToken)) == 1 {
		return "fleet", "", true
	}
	// Admin-minted fleet tokens (userless) — resolved like the env token but
	// per-node and revocable from the admin panel.
	if ft, found, err := s.store.FleetTokenByHash(r.Context(), hashToken(tok)); err == nil && found {
		_ = s.store.TouchFleetTokenUsed(r.Context(), ft.ID, s.now().Unix())
		return "fleet", "", true
	}
	if s.cfg.EnableUserNodes {
```

- [ ] **Step 4: Bind the fleet token to its node on register**

In `nodes.go`, in `handleNodeRegister`, extend the token-binding block (line 136-142). Replace:

```go
	// Bind a user token to its node for per-node revoke/delete.
	if ownerType == "user" {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if nt, found, e := s.store.NodeTokenByHash(r.Context(), hashToken(tok)); e == nil && found {
			_ = s.store.BindNodeToken(r.Context(), nt.ID, saved.ID)
		}
	}
```

with:

```go
	// Bind the presented token to its node for per-node revoke/delete.
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if ownerType == "user" {
		if nt, found, e := s.store.NodeTokenByHash(r.Context(), hashToken(tok)); e == nil && found {
			_ = s.store.BindNodeToken(r.Context(), nt.ID, saved.ID)
		}
	} else if ft, found, e := s.store.FleetTokenByHash(r.Context(), hashToken(tok)); e == nil && found {
		// An admin-minted fleet token (not the shared env token) binds to its node.
		_ = s.store.BindFleetToken(r.Context(), ft.ID, saved.ID)
	}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestNodeOwnerAdminFleetToken`
Expected: PASS.

- [ ] **Step 6: Guard the existing fleet/user resolution still works**

Run: `cd server && go test ./internal/account/ -run 'TestNodeOwner|TestNodeRegister'`
Expected: PASS (env token → fleet, user token → user unchanged).

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/nodes.go server/internal/account/fleet_token_owner_test.go
git commit -m "feat(nodes): resolve + bind admin-minted fleet tokens at register/heartbeat"
```

---

### Task 5: Hard-cap monthly traffic in `handleICE`

**Files:**
- Modify: `server/internal/account/turn.go` (`handleICE`, the `if !strict` fleet-pool block, lines 140-160)
- Test: `server/internal/account/turn_node_traffic_cap_test.go` (new)

**Interfaces:**
- Consumes: `NodeRelayedSince` (Task 3), `Node.TrafficLimitBytes` (Task 2), `monthRange`/`periodOf` (existing).

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/turn_node_traffic_cap_test.go`:

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

func TestICEWithholdsFleetNodeOverTrafficLimit(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0) // some month; NodeRelayedSince uses its month start

	owner, _ := st.UpsertUserByEmail(ctx, "u@example.com", "u")
	st.SetEmailVerified(ctx, owner.ID)

	// capped: limit 1 GiB, already used 2 GiB this period -> withheld.
	// under:  limit 1 GiB, used 0 -> offered.
	// nolimit: limit 0 (unlimited) -> offered.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "capped", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix(), TrafficLimitBytes: 1 << 30})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "under", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix(), TrafficLimitBytes: 1 << 30})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "nolimit", URLs: []string{"turn:3.3.3.3:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix()})

	// 2 GiB of usage attributed to "capped" this period.
	st.RecordUsage(ctx, UsageEvent{AllocID: "x", Token: "c", UserID: owner.ID, RelayedBytes: 2 << 30, RecordedAt: now.Unix(), NodeID: "capped", Billable: true})

	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour, RelayMonthlyFree: 1 << 40}}
	s.pairCodeOwner = func(string) (string, bool) { return owner.ID, true }

	r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
	w := httptest.NewRecorder()
	s.handleICE(w, r)

	var resp struct {
		Relays []relayEntry `json:"relays"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	ids := map[string]bool{}
	for _, e := range resp.Relays {
		ids[e.ID] = true
	}
	if ids["capped"] {
		t.Fatal("over-limit fleet node must be withheld")
	}
	if !ids["under"] || !ids["nolimit"] {
		t.Fatalf("under-limit and unlimited nodes must be offered, got %+v", resp.Relays)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestICEWithholdsFleetNodeOverTrafficLimit`
Expected: FAIL — `capped` is currently offered (no cap logic yet).

- [ ] **Step 3: Add the cap logic to the fleet pool loop**

In `turn.go`, inside `if !strict {` (line 140), compute the per-node monthly usage once before iterating `OnlineNodes`, then skip over-limit nodes. Replace the block:

```go
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
```

with:

```go
		if !strict {
			// Per-node monthly traffic hard cap: skip any fleet node whose
			// relayed bytes this month have reached its admin-set limit. Computed
			// once per request; a read error fails open (no node withheld).
			monthStart, _ := monthRange(periodOf(now.Unix()))
			monthlyUsed, muErr := s.store.NodeRelayedSince(r.Context(), monthStart)
			if muErr != nil {
				log.Printf("ice: NodeRelayedSince read failed: %v (traffic caps not enforced this request)", muErr)
			}
			if nodes, err := s.store.OnlineNodes(r.Context(), since); err == nil {
				for _, n := range nodes {
					if n.ID == "" || n.TURNSecret == "" || len(n.URLs) == 0 || seen[n.ID] {
						continue
					}
					if n.TrafficLimitBytes > 0 && monthlyUsed[n.ID] >= n.TrafficLimitBytes {
						continue // over monthly traffic cap — withhold this node
					}
					relays = append(relays, relayEntry{ID: n.ID, Region: n.Region,
						ICEServers: []ICEServer{turnCredentials(n.TURNSecret, token, expiry, n.URLs)}})
					seen[n.ID] = true
				}
			} else {
				log.Printf("ice: OnlineNodes read failed: %v (static-only)", err)
			}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestICEWithholdsFleetNodeOverTrafficLimit`
Expected: PASS.

- [ ] **Step 5: Guard existing ICE behavior**

Run: `cd server && go test ./internal/account/ -run TestICE`
Expected: PASS (owner-own-nodes and unlimited fleet nodes still included).

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/turn.go server/internal/account/turn_node_traffic_cap_test.go
git commit -m "feat(nodes): hard-cap monthly relay traffic per fleet node in handleICE"
```

---

### Task 6: Hard-cap disk usage in `StorageNodes` placement

**Files:**
- Modify: `server/internal/account/sqlite.go` (`StorageNodes`, line 1151)
- Test: `server/internal/account/node_disk_cap_test.go` (new)

**Interfaces:**
- Consumes: `Node.DiskLimitBytes` (Task 2). `StorageNodes` signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/node_disk_cap_test.go`:

```go
package account

import (
	"context"
	"testing"
)

func TestStorageNodesRespectsDiskLimit(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000
	minFree := int64(1 << 30) // require 1 GiB headroom for a placement

	// physically fine, but disk cap leaves < minFree headroom -> excluded.
	// (disk_limit 5 GiB, stored 4.5 GiB -> 0.5 GiB cap headroom < 1 GiB)
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "capfull", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true, StorageTotal: 100 << 30, StorageFree: 50 << 30,
		StoredBytes: 45 << 29 /*4.5GiB*/, DiskLimitBytes: 5 << 30})
	// disk cap has room ( cap 100 GiB, stored 1 GiB -> 99 GiB headroom ) -> included.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "caproom", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true, StorageTotal: 200 << 30, StorageFree: 150 << 30,
		StoredBytes: 1 << 30, DiskLimitBytes: 100 << 30})
	// unlimited (0) -> included on physical free alone.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "nolimit", URLs: []string{"turn:3.3.3.3:3478"}, TURNSecret: "s",
		CreatedAt: 1, LastSeenAt: now, StorageEnabled: true, StorageTotal: 200 << 30, StorageFree: 150 << 30,
		StoredBytes: 1 << 30})

	nodes, err := st.StorageNodes(ctx, now-1, minFree)
	if err != nil {
		t.Fatalf("StorageNodes: %v", err)
	}
	got := map[string]bool{}
	for _, n := range nodes {
		got[n.ID] = true
	}
	if got["capfull"] {
		t.Fatal("node at/over disk cap must be excluded from placement")
	}
	if !got["caproom"] || !got["nolimit"] {
		t.Fatalf("nodes with cap headroom / unlimited must be included, got %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestStorageNodesRespectsDiskLimit`
Expected: FAIL — `capfull` is currently included (no disk cap in the query).

- [ ] **Step 3: Tighten the `StorageNodes` query**

In `sqlite.go`, change `StorageNodes` (line 1151) to also require disk-cap headroom (the tighter of physical free and admin quota headroom):

```go
func (s *SQLiteStore) StorageNodes(ctx context.Context, since, minFree int64) ([]Node, error) {
	return s.queryNodes(ctx,
		`SELECT `+nodeCols+` FROM nodes
		   WHERE owner_type='fleet' AND storage_enabled=1 AND last_seen_at >= ? AND storage_free >= ?
		     AND (disk_limit_bytes = 0 OR disk_limit_bytes - stored_bytes >= ?)
		   ORDER BY last_seen_at DESC`, since, minFree, minFree)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestStorageNodesRespectsDiskLimit`
Expected: PASS.

- [ ] **Step 5: Guard existing placement tests**

Run: `cd server && go test ./internal/account/ -run 'TestStorage|TestBlobFor|TestSP2'`
Expected: PASS (nodes with `disk_limit_bytes = 0` behave exactly as before).

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/sqlite.go server/internal/account/node_disk_cap_test.go
git commit -m "feat(nodes): hard-cap disk usage per fleet node in StorageNodes placement"
```

---

### Task 7: Admin routes + handlers (mint token, set limits, delete, revoke)

**Files:**
- Modify: `server/internal/account/admin.go` (`RegisterAdmin` line 110; new handlers; `adminNodeView` + `nodeViews` line 22-51; `handleAdminHome` data build line 281-301)
- Modify: `server/internal/account/admin_templates.go` (`adminHomeData` struct line 17; new view structs)
- Test: `server/internal/account/admin_official_nodes_test.go` (new)

**Interfaces:**
- Consumes: `CreateFleetToken`, `ListActiveFleetTokens`, `RevokeFleetToken` (Task 1); `SetNodeLimits`, `DeleteFleetNode`, `Node.TrafficLimitBytes`/`DiskLimitBytes` (Task 2); `NodeRelayedSince` (Task 3); `randToken`, `hashToken`, `newID`, `nodeRunCommandGo` (below).
- Produces:
  - Routes: `POST /admin/nodes/token`, `POST /admin/nodes/{id}/limits`, `POST /admin/nodes/{id}/delete`, `POST /admin/nodes/token/{id}/revoke` (all csrf-guarded).
  - `adminNodeView` gains `OwnerType string`, `TrafficLimitBytes int64`, `DiskLimitBytes int64`, `MonthRelayedBytes int64`.
  - `adminHomeData` gains `FleetTokens []adminFleetTokenView`, `MintedToken string`, `MintedInstallCmd string`.
  - `nodeRunCommandGo(centralURL, token string) string` — server-side twin of `web/src/lib/nodes.ts` `nodeRunCommand`.

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/admin_official_nodes_test.go`:

```go
package account

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// Reuse newAdminSettingsServer + adminLogin from admin_test.go.

func TestAdminMintFleetToken(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/token", strings.NewReader("name=shanghai-1"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("mint token: want 200, got %d", resp.StatusCode)
	}
	toks, _ := store.ListActiveFleetTokens(context.Background())
	if len(toks) != 1 || toks[0].Name != "shanghai-1" {
		t.Fatalf("token not persisted: %+v", toks)
	}
}

func TestAdminSetNodeLimits(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/limits",
		strings.NewReader("traffic_limit_gb=500&disk_limit_gb=100"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("set limits: want 302, got %d", resp.StatusCode)
	}
	got, _, _ := store.GetNode(context.Background(), n.ID)
	if got.TrafficLimitBytes != 500<<30 || got.DiskLimitBytes != 100<<30 {
		t.Fatalf("limits not applied: %+v", got)
	}
}

func TestAdminDeleteFleetNode(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/"+n.ID+"/delete", nil)
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("delete node: want 302, got %d", resp.StatusCode)
	}
	if _, ok, _ := store.GetNode(context.Background(), n.ID); ok {
		t.Fatal("node still present after delete")
	}
}

func TestAdminNodeRoutesRequireAdmin(t *testing.T) {
	ts, _ := newAdminSettingsServer(t)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// No admin cookie and no Origin header (csrfGuard allows Origin-less requests,
	// matching the other admin tests), so the handler's isAdminReq gate rejects.
	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/token", nil)
	resp, _ := client.Do(req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthed mint: want 401, got %d", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestAdmin.*Fleet.*Node\|TestAdminMintFleetToken\|TestAdminSetNodeLimits\|TestAdminNodeRoutesRequireAdmin`
Expected: FAIL — routes 404 / handlers undefined.

- [ ] **Step 3: Add the server-side install-command twin**

In `admin.go`, add near the top-level helpers (after `nodeViews`, ~line 51):

```go
// nodeRunCommandGo is the server-side twin of web/src/lib/nodes.ts
// nodeRunCommand: the one-liner an operator runs on an official box to install
// and start a fleet node bound to this admin-minted token. Kept in sync with
// that TS helper.
func nodeRunCommandGo(centralURL, token string) string {
	return "curl -fsSL " + centralURL + "/install-node.sh | sudo RELAYIUM_CENTRAL_URL=" + centralURL +
		" RELAYIUM_NODE_TOKEN=" + token + " RELAYIUM_NODE_STORAGE_DIR=/var/lib/relayium-node/blobs sh"
}
```

- [ ] **Step 4: Extend the view structs**

In `admin.go`, extend `adminNodeView` (line 22) with:

```go
type adminNodeView struct {
	ID                string
	OwnerType         string
	Region            string
	Version           string
	Online            bool
	RelayedBytes      int64
	MonthRelayedBytes int64
	StoredBytes       int64
	StorageEnabled    bool
	StorageTotal      int64
	StorageFree       int64
	TrafficLimitBytes int64
	DiskLimitBytes    int64
	LastSeenAt        int64
}
```

Change `nodeViews` (line 35) to accept the monthly-usage map and populate the new fields:

```go
func nodeViews(nodes []Node, monthly map[string]int64, now time.Time) []adminNodeView {
	cutoff := now.Add(-nodeOnlineWindow).Unix()
	out := make([]adminNodeView, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, adminNodeView{
			ID: n.ID, OwnerType: n.OwnerType, Region: n.Region, Version: n.Version,
			Online:            n.LastSeenAt >= cutoff,
			RelayedBytes:      n.RelayedBytes,
			MonthRelayedBytes: monthly[n.ID],
			StoredBytes:       n.StoredBytes,
			StorageEnabled:    n.StorageEnabled,
			StorageTotal:      n.StorageTotal,
			StorageFree:       n.StorageFree,
			TrafficLimitBytes: n.TrafficLimitBytes,
			DiskLimitBytes:    n.DiskLimitBytes,
			LastSeenAt:        n.LastSeenAt,
		})
	}
	return out
}
```

Update the existing `nodeViews` call in `handleAdminHome` (line 285) to pass the monthly map — see Step 6. Also update `admin_nodes_test.go`'s two existing `nodeViews(...)` calls to pass `nil` for the new map argument (Step 7).

In `admin_templates.go`, add a fleet-token view struct after `adminSettingsView` (line 15):

```go
type adminFleetTokenView struct {
	ID         string
	Name       string
	NodeID     string
	CreatedAt  int64
	LastUsedAt int64
}
```

Extend `adminHomeData` (line 17) with three fields (after `Settings`):

```go
	FleetTokens      []adminFleetTokenView
	MintedToken      string // set once, right after minting; shown inline then gone
	MintedInstallCmd string // install one-liner for the freshly minted token
```

- [ ] **Step 5: Extract a shared dashboard-data builder**

In `admin.go`, refactor the read section of `handleAdminHome` into a reusable builder so the mint handler can render the same dashboard with the token shown inline. Add:

```go
// buildAdminHomeData assembles the dashboard view model (metrics, users, nodes,
// settings, fleet tokens). Shared by handleAdminHome and handleAdminMintToken.
func (s *Service) buildAdminHomeData(r *http.Request) (adminHomeData, error) {
	q := r.URL.Query()
	search := strings.TrimSpace(q.Get("q"))
	sortBy := q.Get("sort")
	switch sortBy {
	case "email", "relayed", "upload", "download", "storage":
	default:
		sortBy = "created"
	}
	dir := "desc"
	if strings.EqualFold(q.Get("dir"), "asc") {
		dir = "asc"
	}
	page, perr := strconv.Atoi(q.Get("page"))
	if perr != nil || page < 1 {
		page = 1
	}

	now := s.now().Unix()
	months := recentMonths(now, 12)
	period := q.Get("period")
	if !contains(months, period) {
		period = months[0]
	}
	metrics, err := s.store.AdminMetrics(r.Context(), period, now)
	if err != nil {
		return adminHomeData{}, err
	}
	query := AdminUserQuery{Search: search, SortBy: sortBy, SortDir: dir, Period: period, Now: now,
		Limit: adminUsersPerPage, Offset: (page - 1) * adminUsersPerPage}
	rows, total, err := s.store.AdminListUsers(r.Context(), query)
	if err != nil {
		return adminHomeData{}, err
	}
	totalPages := int(math.Ceil(float64(total) / float64(adminUsersPerPage)))
	if totalPages < 1 {
		totalPages = 1
	}
	if page > totalPages {
		page = totalPages
		query.Offset = (page - 1) * adminUsersPerPage
		rows, total, err = s.store.AdminListUsers(r.Context(), query)
		if err != nil {
			return adminHomeData{}, err
		}
	}

	sortHref := map[string]string{}
	for _, col := range []string{"created", "email", "relayed", "upload", "download", "storage"} {
		nd := "desc"
		if sortBy == col && dir == "desc" {
			nd = "asc"
		}
		sortHref[col] = adminListHref(search, col, nd, period, 1)
	}
	prev, next := "", ""
	if page > 1 {
		prev = adminListHref(search, sortBy, dir, period, page-1)
	}
	if page < totalPages {
		next = adminListHref(search, sortBy, dir, period, page+1)
	}

	// Per-node monthly relayed bytes (current month) for the fleet traffic column.
	monthStart, _ := monthRange(periodOf(now))
	monthly, mErr := s.store.NodeRelayedSince(r.Context(), monthStart)
	if mErr != nil {
		log.Printf("admin: NodeRelayedSince failed: %v", mErr)
	}
	var nodeVs []adminNodeView
	if ns, nerr := s.store.ListNodes(r.Context()); nerr != nil {
		log.Printf("admin: ListNodes failed: %v", nerr)
	} else {
		nodeVs = nodeViews(ns, monthly, s.now())
	}
	var tokenVs []adminFleetTokenView
	if fts, ferr := s.store.ListActiveFleetTokens(r.Context()); ferr != nil {
		log.Printf("admin: ListActiveFleetTokens failed: %v", ferr)
	} else {
		for _, ft := range fts {
			tokenVs = append(tokenVs, adminFleetTokenView{ID: ft.ID, Name: ft.Name, NodeID: ft.NodeID, CreatedAt: ft.CreatedAt, LastUsedAt: ft.LastUsedAt})
		}
	}

	st := s.resolveSettings(r.Context())
	return adminHomeData{
		Metrics: metrics, Users: rows, Total: total, Page: page, TotalPages: totalPages,
		Search: search, Sort: sortBy, Dir: dir, Period: period, Months: months,
		PrevHref: prev, NextHref: next, SortHref: sortHref,
		Nodes: nodeVs, FleetTokens: tokenVs,
		Settings: adminSettingsView{
			MaxFileSizeMB:      st.MaxFileSize / (1024 * 1024),
			DailyQuotaMB:       st.DailyQuota / (1024 * 1024),
			DefaultTTLHrs:      st.DefaultTTL / 3600,
			MaxTTLHrs:          st.MaxTTL / 3600,
			RelayMonthlyFreeMB: st.RelayMonthlyFree / (1024 * 1024),
		},
	}, nil
}
```

Then replace the body of `handleAdminHome` (lines 210-304, everything after the `isAdminReq` gate) with:

```go
func (s *Service) handleAdminHome(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		s.renderAdminLogin(w, http.StatusOK, "")
		return
	}
	data, err := s.buildAdminHomeData(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := adminUsersTmpl.Execute(w, data); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}
```

- [ ] **Step 6: Add the four handlers**

In `admin.go`, after `handleAdminSettings` (ends line 343) add:

```go
// handleAdminMintToken mints an admin fleet-node token, stores its hash, and
// re-renders the dashboard with the plaintext token + install command shown
// once inline (never persisted, never shown again).
func (s *Service) handleAdminMintToken(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" {
		name = "official-node"
	}
	raw := randToken()
	if err := s.store.CreateFleetToken(r.Context(), FleetToken{
		ID: newID(), TokenHash: hashToken(raw), Name: name, CreatedAt: s.now().Unix(),
	}); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	data, err := s.buildAdminHomeData(r)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	data.MintedToken = raw
	data.MintedInstallCmd = nodeRunCommandGo(s.cfg.BaseURL, raw)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := adminUsersTmpl.Execute(w, data); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}

// handleAdminNodeLimits sets an official node's traffic/disk hard caps (GB in
// the form, stored as bytes; 0 = unlimited).
func (s *Service) handleAdminNodeLimits(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	id := r.PathValue("id")
	gb := func(k string) (int64, bool) {
		n, err := strconv.ParseInt(strings.TrimSpace(r.FormValue(k)), 10, 64)
		return n, err == nil && n >= 0 // 0 allowed = unlimited
	}
	tGB, ok1 := gb("traffic_limit_gb")
	dGB, ok2 := gb("disk_limit_gb")
	if !ok1 || !ok2 {
		http.Error(w, "invalid limits (non-negative integers, GB)", http.StatusBadRequest)
		return
	}
	if err := s.store.SetNodeLimits(r.Context(), id, tGB<<30, dGB<<30); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminDeleteNode deletes an official (fleet) node.
func (s *Service) handleAdminDeleteNode(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := s.store.DeleteFleetNode(r.Context(), r.PathValue("id")); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}

// handleAdminRevokeToken revokes an admin-minted fleet token so it can no longer
// register/heartbeat a node.
func (s *Service) handleAdminRevokeToken(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if err := s.store.RevokeFleetToken(r.Context(), r.PathValue("id"), s.now().Unix()); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}
```

- [ ] **Step 7: Register the routes and fix the existing `nodeViews` test calls**

In `admin.go` `RegisterAdmin` (after line 121, the settings route) add:

```go
	mux.Handle("POST /admin/nodes/token", s.csrfGuard(http.HandlerFunc(s.handleAdminMintToken)))
	mux.Handle("POST /admin/nodes/token/{id}/revoke", s.csrfGuard(http.HandlerFunc(s.handleAdminRevokeToken)))
	mux.Handle("POST /admin/nodes/{id}/limits", s.csrfGuard(http.HandlerFunc(s.handleAdminNodeLimits)))
	mux.Handle("POST /admin/nodes/{id}/delete", s.csrfGuard(http.HandlerFunc(s.handleAdminDeleteNode)))
```

In `admin_nodes_test.go`, update the two existing `nodeViews(...)` calls to pass the new map argument (`nil`):

```go
	views := nodeViews(nodes, nil, now)
```

```go
	views := nodeViews([]Node{{ID: "n", LastSeenAt: now.Unix(), StorageEnabled: true, StorageTotal: 20 << 30, StorageFree: 5 << 30, StoredBytes: 3 << 30}}, nil, now)
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'TestAdmin'`
Expected: PASS (new official-node tests + existing admin tests, including the updated `nodeViews` calls).

- [ ] **Step 9: Commit**

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/admin_nodes_test.go server/internal/account/admin_official_nodes_test.go
git commit -m "feat(admin): mint/limit/delete/revoke routes for official relay nodes"
```

---

### Task 8: Admin dashboard "Official nodes" section (template)

**Files:**
- Modify: `server/internal/account/admin_templates.go` (`adminUsersTmpl`, the `<section class="nodes">` block line 113-129, plus template funcs line 62)
- Test: `server/internal/account/admin_official_nodes_ui_test.go` (new)

**Interfaces:**
- Consumes: `adminHomeData.Nodes` (now with `OwnerType`, `MonthRelayedBytes`, `TrafficLimitBytes`, `DiskLimitBytes`), `adminHomeData.FleetTokens`, `adminHomeData.MintedToken`, `adminHomeData.MintedInstallCmd` (Task 7).

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/admin_official_nodes_ui_test.go`:

```go
package account

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAdminDashboardShowsOfficialNodesSection(t *testing.T) {
	ts, store := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	// A fleet node with limits set, plus an active token.
	n, _ := store.UpsertNode(context.Background(), Node{OwnerType: "fleet", Region: "cn-sh", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1, TrafficLimitBytes: 500 << 30, DiskLimitBytes: 100 << 30})
	store.CreateFleetToken(context.Background(), FleetToken{ID: "ft1", TokenHash: hashToken("x"), Name: "cn-sh-1", CreatedAt: 1})

	client := ts.Client()
	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	body, _ := io.ReadAll(resp.Body)
	html := string(body)

	for _, want := range []string{
		"官方节点",                    // section heading
		"生成节点 Token",              // mint button
		"/admin/nodes/" + n.ID + "/limits", // edit-limits form action
		"/admin/nodes/" + n.ID + "/delete", // delete form action
		"cn-sh-1",                    // token name in the tokens list
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("dashboard missing %q", want)
		}
	}
}

func TestAdminMintShowsTokenOnce(t *testing.T) {
	ts, _ := newAdminSettingsServer(t)
	cookie := adminLogin(t, ts)
	client := ts.Client()

	req, _ := http.NewRequest("POST", ts.URL+"/admin/nodes/token", strings.NewReader("name=n1"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	resp, _ := client.Do(req)
	body, _ := io.ReadAll(resp.Body)
	html := string(body)
	if !strings.Contains(html, "install-node.sh") || !strings.Contains(html, "RELAYIUM_NODE_TOKEN=") {
		t.Fatalf("mint response should show the install command once, got:\n%s", html)
	}
}
```

(Go 1.21+ builtin `min`/`max` are available; do not define a local `min` — it would collide with the builtin and any other test-file helper.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'TestAdminDashboardShowsOfficialNodesSection|TestAdminMintShowsTokenOnce'`
Expected: FAIL — section markup absent.

- [ ] **Step 3: Replace the node section markup**

In `admin_templates.go`, replace the entire existing `<section class="nodes">…</section>` block (lines 113-129) with the official-node management section below. It reuses the existing `bytes` and `ts` template funcs; the `gib` func is added in Step 4.

```html
<section class="nodes">
<h2>官方节点（{{len .Nodes}}）</h2>

{{if .MintedToken}}
<div class="minted">
<p>新节点 Token（仅显示一次，请立即复制）：</p>
<pre>{{.MintedToken}}</pre>
<p>在官方服务器上执行以下命令安装并启动节点：</p>
<pre>{{.MintedInstallCmd}}</pre>
</div>
{{end}}

<form method="post" action="/admin/nodes/token" class="mint">
<input type="text" name="name" placeholder="节点备注名（如 cn-shanghai-1）">
<button type="submit">生成节点 Token</button>
</form>

<table>
<thead><tr><th>ID</th><th>区域</th><th>状态</th><th>本月中继 / 流量上限</th><th>存储 / 硬盘上限</th><th>盘 剩余/总量</th><th>版本</th><th>限额(GB)</th><th></th></tr></thead>
<tbody>
{{range .Nodes}}{{if eq .OwnerType "fleet"}}
<tr>
<td>{{.ID}}</td><td>{{.Region}}</td>
<td>{{if .Online}}在线{{else}}离线{{end}}</td>
<td>{{bytes .MonthRelayedBytes}} / {{if .TrafficLimitBytes}}{{bytes .TrafficLimitBytes}}{{else}}∞{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .StoredBytes}}{{else}}—{{end}} / {{if .DiskLimitBytes}}{{bytes .DiskLimitBytes}}{{else}}∞{{end}}</td>
<td>{{if .StorageEnabled}}{{bytes .StorageFree}} / {{bytes .StorageTotal}}{{else}}—{{end}}</td>
<td>{{.Version}}</td>
<td>
<form method="post" action="/admin/nodes/{{.ID}}/limits" class="lim">
<input type="number" name="traffic_limit_gb" min="0" value="{{gib .TrafficLimitBytes}}" title="流量上限 GB/月，0=无限">
<input type="number" name="disk_limit_gb" min="0" value="{{gib .DiskLimitBytes}}" title="硬盘上限 GB，0=无限">
<button type="submit">保存</button>
</form>
</td>
<td><form method="post" action="/admin/nodes/{{.ID}}/delete" onsubmit="return confirm('删除该官方节点？')"><button type="submit" class="danger">删除</button></form></td>
</tr>
{{end}}{{end}}
</tbody></table>

{{if .FleetTokens}}
<h2>活跃节点 Token（{{len .FleetTokens}}）</h2>
<table>
<thead><tr><th>备注名</th><th>创建时间(UTC)</th><th>最后使用</th><th>绑定节点</th><th></th></tr></thead>
<tbody>
{{range .FleetTokens}}
<tr>
<td>{{.Name}}</td><td>{{ts .CreatedAt}}</td>
<td>{{if .LastUsedAt}}{{ts .LastUsedAt}}{{else}}—{{end}}</td>
<td>{{if .NodeID}}{{.NodeID}}{{else}}—{{end}}</td>
<td><form method="post" action="/admin/nodes/token/{{.ID}}/revoke" onsubmit="return confirm('撤销该 Token？')"><button type="submit" class="danger">撤销</button></form></td>
</tr>
{{end}}
</tbody></table>
{{end}}
</section>
```

- [ ] **Step 4: Add the `gib` template func and minimal styles**

In `admin_templates.go`, in the `adminUsersTmpl` `Funcs(template.FuncMap{…})` map (line 62), add a `gib` entry that renders bytes as whole GB for the prefilled inputs:

```go
	"gib": func(b int64) int64 { return b / (1 << 30) },
```

In the `<style>` block of `adminUsersTmpl` (before `</style>` at line 99), add:

```css
.mint{display:flex;gap:8px;margin:12px 0}
.mint input{font:inherit;padding:7px 9px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--fg)}
.minted{background:var(--soft);border:1px solid var(--bd);border-radius:10px;padding:12px 14px;margin:12px 0}
.minted pre{white-space:pre-wrap;word-break:break-all;background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:8px}
.lim{display:flex;gap:6px;align-items:center}
.lim input{width:70px;font:inherit;padding:5px 7px;border:1px solid var(--bd);border-radius:6px;background:var(--card);color:var(--fg)}
.lim button,td .danger{padding:5px 10px;font-size:12px}
.danger{background:#e5484d}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'TestAdminDashboardShowsOfficialNodesSection|TestAdminMintShowsTokenOnce'`
Expected: PASS.

- [ ] **Step 6: Run the whole package**

Run: `cd server && go test ./internal/account/...`
Expected: PASS.

- [ ] **Step 7: Build and vet**

Run: `cd server && go vet ./internal/account/... && go build ./...`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/internal/account/admin_templates.go server/internal/account/admin_official_nodes_ui_test.go
git commit -m "feat(admin): official-nodes dashboard section — mint, limits, delete, revoke"
```

---

## Self-Review

**Spec coverage:**
- Registration = mint token + run binary → Tasks 1 (token storage), 4 (resolution/bind), 7 (mint route), 8 (install command shown once). ✓
- `fleet_tokens` table (userless) → Task 1. ✓
- Limit columns on `nodes` → Task 2. ✓
- Traffic hard cap, monthly, `handleICE` → Tasks 3 (per-node monthly sum) + 5 (skip over-limit). ✓
- Disk hard cap, `StorageNodes` (tighter of physical free / quota headroom) → Task 6. ✓
- Fleet-only scope → Task 6 (`owner_type='fleet'` in query), Task 5 (only the `!strict` fleet loop), Task 2 (`DeleteFleetNode` scoped), Task 8 (`{{if eq .OwnerType "fleet"}}` rows). ✓
- Admin UI: list, edit limits, delete, mint, revoke, all csrf-guarded → Tasks 7 + 8. ✓
- Backward compat: env `RELAYIUM_NODE_TOKEN` kept (Task 4 keeps the constant-time compare first); existing nodes show 0/unlimited (Task 2 defaults). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:**
- `FleetToken` fields identical across Task 1 (definition) and Task 7 (`ListActiveFleetTokens` → `adminFleetTokenView`). ✓
- `nodeViews(nodes, monthly, now)` new 3-arg signature defined in Task 7 and its two existing test call-sites updated in the same task (Step 7). ✓
- `SetNodeLimits(ctx, nodeID, trafficLimit, diskLimit)` and `NodeRelayedSince(ctx, since) map[string]int64` used with matching signatures in Tasks 5/6/7. ✓
- Form field names `traffic_limit_gb`/`disk_limit_gb` match between the Task 7 handler parse and the Task 8 template inputs. ✓
- `nodeCols` (18 cols) ↔ `UpsertNode` 18 placeholders/args ↔ `queryNodes` 18-field scan all updated together in Task 2. ✓

## Notes for the executor

- After Task 2 changes `nodeCols`, running the full `internal/account` package (Task 2 Step 8) is the fastest way to catch a placeholder/scan count mismatch — every node read path exercises it.
- Traffic-cap enforcement adds one grouped query per `/api/ice` call. `/api/ice` is already rate-limited 5/min/IP. A short-TTL cache is a possible later optimization but is explicitly out of scope here.
- No frontend (Svelte) changes: the user MePage flow is untouched; `nodeRunCommandGo` is a deliberate server-side twin of `web/src/lib/nodes.ts` — if that TS helper's env/flags change, update both.
