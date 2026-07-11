# Admin-managed official relay nodes + per-node limits

Date: 2026-07-11
Status: Approved for planning

## Problem

Users can already add their own relay nodes from the personal center: mint a
one-time token (`POST /api/nodes/provision`), run `relayium-node` on their box,
and the node self-registers as `owner_type="user"`. Official (fleet) relay nodes,
by contrast, can only be added by (a) a running `relayium-node` presenting the
single shared env token `RELAYIUM_NODE_TOKEN`, or (b) pasting a coturn JSON blob
into `RELAYIUM_TURN_RELAYS`. There is **no admin UI** to add, view, or manage
official nodes, and **no per-node traffic/disk limits** anywhere — the reported
`relayed_bytes` / `storage_*` fields are telemetry only, never enforced as caps.

This spec adds an admin flow that mirrors the user "add node" experience for
official fleet nodes, plus admin-editable per-node monthly-traffic and disk
hard caps.

## Goals

- From the existing server-rendered admin (`/admin`), mint a one-time fleet node
  token and get a ready-to-run install command — mirroring the user flow.
- List official (fleet) nodes with live status and telemetry in the admin.
- Set a per-node **monthly traffic limit** and **disk limit** from the admin, both
  **hard caps** (over → node is withheld / not used, not merely flagged).
- Revoke a minted fleet token and delete a fleet node from the admin.

## Non-goals (YAGNI)

- Limits apply to **fleet nodes only**. User BYO nodes remain unmanaged (their
  resources are the user's own).
- No soft/warn-only mode. Over-limit = hard cutoff.
- No changes to the user-facing MePage flow.
- No replica/redundancy features.
- Traffic resets **monthly**, reusing the existing user-quota period helpers.

## Design

### 1. Registration model — mint token + run binary

Mirror the user flow, but admin-scoped and for fleet nodes:

1. Admin clicks **[Generate node token]** in the "Official nodes" section →
   `POST /admin/nodes/token`. Server mints a random bearer token, stores only its
   sha256 hash, and returns the plaintext **once** together with a copy-ready
   install command (`relayium-node --token=… --central-url=…`), reusing the same
   command shape as the user flow (`web/src/lib/nodes.ts` logic, rendered here
   server-side).
2. Operator runs the command on the official server. The node calls
   `POST /api/nodes/register` with the token → row upserted with
   `owner_type="fleet"`.

**Token storage.** `node_tokens.user_id` is `NOT NULL REFERENCES users(id)`, so a
userless fleet token cannot be stored there, and SQLite cannot drop a NOT NULL/FK
via `ALTER`. Introduce a dedicated table instead:

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

Added to the base schema constant (all `CREATE TABLE IF NOT EXISTS`, so existing
DBs pick it up on next startup — no migration framework needed).

**Token resolution.** Extend `nodeOwner` (nodes.go:64) resolution order:

1. env `RELAYIUM_NODE_TOKEN` (constant-time compare) → `("fleet", "")` — kept for
   backward compatibility.
2. `fleet_tokens` hash lookup (not revoked) → `("fleet", "")`; touch `last_used_at`.
3. `node_tokens` hash lookup → `("user", user_id)` — unchanged.

Bind the fleet token to its node on first register (mirror the `BindNodeToken`
call for user tokens) so per-token revoke maps to a node.

### 2. Data model — limit columns

Add two columns to `nodes` via the existing idempotent `ALTER TABLE … ADD COLUMN`
loop (sqlite.go ~176), and add them to the shared `nodeCols` SELECT list
(sqlite.go:1092) and the `queryNodes` scan (sqlite.go:1217):

- `traffic_limit_bytes INTEGER NOT NULL DEFAULT 0` — monthly cap; `0` = unlimited.
- `disk_limit_bytes    INTEGER NOT NULL DEFAULT 0` — storage cap; `0` = unlimited.

Add the two fields to the `Node` struct (store.go:134) and to `UpsertNode` so a
re-register preserves admin-set limits (register must **not** reset limits: on
upsert, keep existing limit columns rather than overwriting them from the
register payload, which never carries limits).

New store methods:

- `SetNodeLimits(ctx, nodeID string, trafficLimit, diskLimit int64) error` — admin edit.
- `NodeRelayedSince(ctx, since int64) (map[string]int64, error)` — grouped sum of
  billable relayed bytes per node for the current period:
  `SELECT node_id, COALESCE(SUM(relayed_bytes),0) FROM usage_events
   WHERE recorded_at >= ? AND node_id IS NOT NULL GROUP BY node_id`.

### 3. Hard-cap enforcement

**Traffic (monthly).** In `handleICE` (turn.go), before building the fleet pool
(the `!strict` branch, turn.go:140-160), compute the per-node monthly total once
via `NodeRelayedSince(monthStart)` where `monthStart = firstReturnOf
monthRange(periodOf(now.Unix()))` — the same helpers user-quota already uses
(turn.go:82). When iterating `OnlineNodes`, skip any node whose
`traffic_limit_bytes > 0` and `monthlyUsed[node.ID] >= traffic_limit_bytes`. This
is one extra grouped query per ICE call; ICE is already rate-limited 5/min/IP.
(Static `RELAYIUM_TURN_RELAYS` entries and the owner's own user nodes are
unaffected — limits are fleet-node-only.) A short-TTL in-memory cache of the
grouped result is a later optimization, not part of this spec.

**Disk.** In the fleet storage-placement query (`StorageNodes`, sqlite.go ~1151),
tighten the free-space filter to the smaller of physical free and admin quota
headroom:

```sql
AND (disk_limit_bytes = 0 OR disk_limit_bytes - stored_bytes >= ?)  -- ? = minFree
```

alongside the existing `storage_free >= minFree`. A node at/over its disk cap is
excluded from placement. `UserStorageNodes` (user BYO) is left unchanged.

### 4. Admin UI (`admin.go` + `admin_templates.go`)

New "Official nodes" section on the dashboard, styled like the existing settings
form (plain HTML `<form method="post">`, no JS/JSON). All state-changing POSTs go
through the existing `s.csrfGuard` and admin-session auth; register in
`RegisterAdmin` (admin.go:118).

Routes:

- `POST /admin/nodes/token` → mint a fleet token; re-render dashboard with the
  plaintext token + install command shown once (flash-style, not persisted).
- `POST /admin/nodes/{id}/limits` → parse traffic/disk in GB from the form,
  convert to bytes, `SetNodeLimits`.
- `POST /admin/nodes/{id}/delete` → `DeleteNode` (fleet-scoped: reject if the row
  is not `owner_type="fleet"`).
- `POST /admin/nodes/token/{id}/revoke` → set `revoked_at` on a `fleet_tokens` row.

Dashboard additions (read paths):

- Fleet node table from `ListNodes` filtered to `owner_type="fleet"`, showing:
  online dot, region, `#id` (short), **this-month relayed / traffic limit**,
  **stored / disk limit**, storage free/total, last-seen. Reuse `NodeRelayedSince`
  for the monthly column. Each row carries an inline edit-limits form (traffic GB,
  disk GB, prefilled) and a delete button.
- Active fleet tokens list (unrevoked, from `fleet_tokens`) with name, created,
  last-used, bound node, and a revoke button.

### Route-mounting note

`RegisterNodeRoutes` already mounts `/api/nodes/register|heartbeat` when
`EnableUserNodes` is true (default) or `NodeToken` is set, so admin-minted fleet
tokens work without changing that gate.

## Files touched

- `server/internal/account/sqlite.go` — `fleet_tokens` table in base schema;
  `nodes` ALTERs for the two limit columns; `nodeCols` + `queryNodes` scan;
  `SetNodeLimits`, `NodeRelayedSince`, and `fleet_tokens` CRUD (insert, hash
  lookup, bind, touch-used, revoke, list-active); tighten `StorageNodes` disk
  filter.
- `server/internal/account/store.go` — `Node` struct limit fields; new `Store`
  interface methods; a `FleetToken` struct.
- `server/internal/account/nodes.go` — `nodeOwner` fleet-token branch; bind fleet
  token to node on register; preserve limits on upsert.
- `server/internal/account/turn.go` — monthly per-node traffic skip in the fleet
  pool loop.
- `server/internal/account/admin.go` — 4 new routes + handlers; fleet node/token
  view prep.
- `server/internal/account/admin_templates.go` — "Official nodes" section markup.

## Testing

- `nodeOwner` resolves an admin-minted fleet token to `("fleet","")`; a revoked
  one → 401; env token still resolves to fleet.
- Register with a fleet token creates `owner_type="fleet"`; re-register preserves
  admin-set limits (does not zero them).
- `handleICE` withholds a fleet node whose monthly relayed ≥ traffic limit; still
  offers it when limit is 0 (unlimited) or usage below limit; user own-nodes and
  static relays unaffected by fleet limits.
- `StorageNodes` excludes a fleet node at/over its disk limit; includes it when
  under; `UserStorageNodes` unaffected.
- Admin routes are CSRF-guarded and session-gated; `/admin/nodes/{id}/delete`
  refuses a non-fleet node id.
- `SetNodeLimits` round-trips GB→bytes correctly.

## Migration / compatibility

- New table + columns via `IF NOT EXISTS` / idempotent `ALTER`; no data migration.
- `RELAYIUM_NODE_TOKEN` and `RELAYIUM_TURN_RELAYS` continue to work unchanged.
- Existing fleet nodes (registered via env token) appear in the admin list with
  `0` (unlimited) limits until edited.
