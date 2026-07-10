# SP3 — BYO User Self-Hosted Nodes (account-bound relay + storage)

Date: 2026-07-10
Status: Approved (design)
Part of: relay-node fleet system. SP1 (foundation + relay + telemetry, merge f29b440) and
SP2 (node storage, central-proxy, merge 9b87dda) are shipped on main. This is SP3 — the last
planned slice: user-owned nodes.
Prior specs: `docs/superpowers/specs/2026-07-10-relay-node-sp1-design.md`,
`docs/superpowers/specs/2026-07-10-relay-node-sp2-design.md`.

## Goal

A registered relayium.com user runs the SAME `relayium-node` binary on their own box, bound to
their account, so THEIR transfers relay through and store on their own node — data on their box,
at no cost to them (their bandwidth/disk, excluded from our free-tier quota). The node binary is
essentially unchanged: it already presents a bearer token; the central server distinguishes a
fleet token from a per-user node token and routes/attributes accordingly.

Success: a logged-in user adds a node in the web dashboard (gets a token), runs the node with
that token, and thereafter their cross-network transfers relay through their node and their
uploads land on their node's disk — none of it counting against their free-tier quota — with a
"My Nodes" dashboard showing each node online with its (free) relay/storage usage. A user can
enable a strict "only my own nodes" mode, and can delete a node (revoking its token).

## Decided

- **Routing: prefer-own-node + fallback**, plus a per-user **strict "only my own nodes" toggle**
  (default off). Non-strict: own node when online (free), else our fleet/central (billable).
  Strict: only the user's own nodes (their transfer fails when their node is offline).
- **Scope includes the Svelte "My Nodes" UI** (not API-only).
- Token flow: **dashboard-minted paste token** (no device-code polling).

## Non-goals

- Migrating FLEET nodes off the shared `RELAYIUM_NODE_TOKEN` to per-node tokens (the `node_tokens`
  mechanism supports it; doing it for fleet is an operational follow-up, noted under I2 below).
- Replication / HA (VIP future).
- Direct browser↔node transfer (still central-proxy, per SP2).

## Architecture

Two node ownerships share one binary and one registration path:
- **fleet** (SP1/SP2): shared `RELAYIUM_NODE_TOKEN`, `owner_type='fleet'`, relay/storage billable.
- **user** (SP3): a per-user token minted in the dashboard, `owner_type='user'`,
  `owner_user_id=U`, relay/storage NON-billable and routed preferentially to U's own transfers.

The billable/non-billable split is derived **at heartbeat ingestion from the reporting node's
`owner_type`** — no billability is threaded through TURN credentials or upload placement. This
keeps routing (which node) and billing (does it count) cleanly separated.

## Component 1 — per-node account tokens (`node_tokens`)

New table:
```sql
CREATE TABLE IF NOT EXISTS node_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,   -- sha256 of the presented bearer token
  user_id      TEXT NOT NULL REFERENCES users(id),
  node_id      TEXT,                   -- bound on first register; NULL until then
  name         TEXT,                   -- user-facing label
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_node_tokens_user ON node_tokens(user_id);
```
Token hashing mirrors the existing `magic_tokens`/`email_tokens` idiom (store `sha256`, never the
plaintext; show plaintext to the user exactly once at mint). Store methods: `CreateNodeToken`,
`NodeTokenByHash(hash) (NodeToken, bool, error)` (must be non-revoked), `BindNodeToken(id, nodeID)`,
`ListNodeTokensByUser`, `RevokeNodeToken(id, userID)` (owner-scoped), `TouchNodeTokenUsed(id, at)`.

## Component 2 — node auth resolves owner (register/heartbeat)

`nodeAuthorized` becomes an owner resolver: `func (s *Service) nodeOwner(r) (ownerType, ownerUserID string, ok bool)`.
- If the bearer equals the fleet `NodeToken` (constant-time) → `("fleet", "", true)`.
- Else `sha256` the bearer, `NodeTokenByHash` → non-revoked match → `("user", tok.UserID, true)`, and
  `TouchNodeTokenUsed`.
- Else `(_, _, false)` → 401.

`handleNodeRegister` sets `owner_type`/`owner_user_id` from the resolver (instead of hardcoding
`fleet`) and, for a user token, `BindNodeToken(tokenID, nodeID)` so the token and node are linked
(enables per-node revoke/delete). `RegisterNodeRoutes` mounts when EITHER the fleet token is set
OR the node-token feature is enabled (a new `Config.EnableUserNodes bool`, default on when the
account system runs) — so a server with no fleet token still serves user nodes.

**I2 mitigation:** a `user`-owned node's heartbeat `usage[]` is accepted ONLY for its own
`owner_user_id` — central drops (logs) any usage entry whose parsed `userID` ≠ the node's owner.
Combined with non-billable (below), a compromised user node cannot forge billable attribution for
anyone. Fleet nodes still self-report arbitrary attribution (they relay anonymous pairing codes);
that residual trust is unchanged, but per-node tokens make any single node individually revocable.

## Component 3 — attribution: `usage_events` billable + non-billable

`usage_events` gains `node_id TEXT` and `billable INTEGER NOT NULL DEFAULT 1` (idempotent ALTER;
old rows default billable=1). `RecordUsage`/`UsageEvent` carry `NodeID` and `Billable`. The
heartbeat handler sets, per usage entry: `NodeID = req.NodeID`, `Billable = (node.owner_type ==
"fleet")`. `UserRelayedSince` (the quota gate in `handleICE`) sums `WHERE billable = 1` only, so a
user's own-node relay never consumes their monthly free allowance. A separate
`UserRelayedSinceAll`/dashboard query can sum all (billable + free) for display.

## Component 4 — relay routing (`/api/ice`)

In `handleICE`, when `validCode` with owner U, build `relays[]` as:
1. **U's own online nodes** — `store.UserNodes(ctx, U, since)` (owner_type='user', owner_user_id=U,
   online). Each is a relay entry, labeled so the client can prefer it; relay through them is
   non-billable (enforced at heartbeat by owner_type, Component 3).
2. **Fleet nodes ∪ legacy static** — the SP1 union — ONLY when U is not in strict mode.
The quota/verified gates already above stay. In **strict mode** (`user.only_own_nodes`), skip the
legacy single-TURN entry and the fleet pool entirely: the response carries STUN + U's own nodes
only. If U is strict and has no online node, `relays` is empty (transfer degrades to STUN/direct
or fails — the accepted strict tradeoff).

## Component 5 — storage routing (`placeUpload`) + quota exclusion

`placeUpload` gains the uploading user: `placeUpload(ctx, userID) (nodeID string, bs BlobStore, billable bool)`.
- If U has an online storage node with headroom (`store.UserStorageNodes(ctx, U, since, minFree)`)
  → place there, `billable=false`.
- Else if U not strict → SP2 fleet/central placement, `billable=true`.
- Else (strict, no own node) → return a sentinel so `handleUploadFile` responds 503 "your storage
  node is offline".
`handleUploadFile`: when `billable == false`, SKIP the daily-quota pre-check AND `ReserveUpload`
(own disk, own quota) — but still create the `StoredFile` row (with `node_id`) and record
best-effort stats marked non-billable. When `billable == true`, the SP2 path is unchanged.
`StoredFile` grows no new column for billability — it is derivable from the node's owner_type,
and stored-usage-quota enforcement (if any later) can join `nodes`.

## Component 6 — user node management API + "My Nodes" UI

New session-authenticated endpoints (under `acct.Routes()`, CSRF-guarded like other user APIs):
- `POST /api/nodes/provision` — body `{name}` → mint a token (`CreateNodeToken`), return
  `{id, token, name}` with the plaintext token ONCE. Rate-limited per user (reuse existing limiter
  pattern) and capped (e.g. ≤ 10 active tokens/user).
- `GET /api/nodes/mine` — the user's nodes joined with token status: `{nodes:[{id, name, region,
  online, relayedBytes, storedBytes, storageFree, storageTotal, lastSeen, tokenRevoked}]}`.
- `DELETE /api/nodes/{id}` — owner-scoped: `RevokeNodeToken` + `DeleteNode` (Component 7).
- `PUT /api/me/strict-nodes` — set the `only_own_nodes` flag on the user.

**Svelte "My Nodes"** section in `web/src/lib/MePage.svelte` (mirroring the existing devices
section): list own nodes (online dot + free relay/storage figures), an "Add node" button that
calls `provision` and shows the one-time token + the exact `relayium-node` run command to paste,
a delete button, and the strict-mode toggle. Uses the existing `/api` fetch + auth pattern
(`auth.svelte.ts`). A Vitest unit test covers the token-display-once and list rendering logic.

## Component 7 — DeleteNode + orphan-queue eviction (folds in SP2 M6)

- `DeleteNode(ctx, id, ownerUserID)` (owner-scoped; admin variant unrestricted): delete the `nodes`
  row and its `pending_node_deletes` entries. A deleted node's stored files become unreachable
  (no replica) — the same offline semantics; their rows GC-expire normally, and their now-orphaned
  blobs are on a box we no longer route to (the user's own disk — their cleanup).
- **GC eviction (SP2 M6):** `pending_node_deletes` older than `pendingDeleteMaxAge` (7 days) are
  dropped each sweep — bounds the queue for a permanently-dead node that will never drain.
  `DeletePendingNodeDeletesOlderThan(ctx, before)`.

## User-facing account setting

`users` gains `only_own_nodes INTEGER NOT NULL DEFAULT 0` (idempotent ALTER). The `User` struct
gains `OnlyOwnNodes bool`, populated by `GetUserByID` — so `handleICE` reads it via
`GetUserByID(owner)` (owner is the pairing-code owner's userID), and `handleUploadFile`/`placeUpload`
read it from the session `User`. `PUT /api/me/strict-nodes` sets it (`SetOnlyOwnNodes(userID, bool)`);
`GET /api/me` returns it. On a `GetUserByID` read error in `handleICE`, treat as non-strict
(fail-open to the reliable default).

## Error handling & security

- Per-user token: `sha256`-hashed at rest; owner-scoped revoke/delete; capped count; provision
  rate-limited. A revoked token → `NodeTokenByHash` returns not-found → node 401s on next
  register/heartbeat (it stops being routed once offline-expired from the pool).
- Cross-user attribution from a user node is rejected (Component 2). Non-billable own-node usage
  removes the incentive to forge.
- Strict mode failing closed (empty relays / 503 upload) is intentional, surfaced clearly to the
  user in the UI copy.
- E2E unchanged; the user's own node still stores only ciphertext (the user holds the keys
  separately as always — the node seeing ciphertext at rest is the same zero-knowledge property).
- Central→user-node transport is the SP2 central-proxy HTTP hop (E2E ciphertext); TLS-pinning
  remains the noted hardening follow-up.

## Testing

- `node_tokens` store: create/hash-lookup/bind/revoke/list/owner-scope; revoked token not found.
- `nodeOwner` resolver: fleet token → fleet; user token → (user, U); revoked/unknown → not ok.
- register: user token → node row owner_type='user'+owner_user_id, token bound to node.
- heartbeat billable derivation: fleet node usage → billable=1; user node usage → billable=0;
  a user node reporting a DIFFERENT user's attribution → dropped.
- `UserRelayedSince` sums billable only; a non-billable own-node event doesn't move the quota.
- `handleICE`: owner with an online own node → own node in relays; non-strict also gets fleet;
  strict → own node only (no fleet/legacy TURN); strict + no own node → empty relays.
- `placeUpload`: own storage node → (node, non-billable); non-strict fallback → fleet, billable;
  strict + offline own node → sentinel → 503; non-billable upload skips ReserveUpload (quota not
  debited) yet creates the StoredFile row.
- user API: provision returns token once + persists hash; mine lists own nodes; delete is
  owner-scoped (can't delete another user's node) and revokes the token; strict-nodes toggles.
- GC: `pending_node_deletes` older than 7 days evicted.
- Svelte: token-shown-once + list render (Vitest).

## Out of scope / follow-ups

- Per-node fleet tokens (operational I2 close for fleet).
- Storage-quota enforcement for billable fleet/central storage (a stored-bytes cap) — SP2/SP3
  track usage but the free-tier storage cap policy is a billing-phase decision.
- TLS-pinning on the central↔node hop.
- Device-code provisioning UX (paste token is v1).
