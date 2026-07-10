# SP1 — Self-Reporting Relay Node: Foundation + Relay + Fleet Telemetry

Date: 2026-07-10
Status: Approved (design)
Part of: relay-node fleet system (SP1 → SP2 storage → SP3 BYO). See
`docs/superpowers/specs/2026-07-10-default-on-metering-design.md` for the superseded
coturn+Redis metering stopgap (C1 analysis, kept as background).

## Goal

Ship the thinnest end-to-end slice of the node system: a single-purpose `relayium-node`
binary (pion/turn relay) that self-registers to the central server over authenticated
HTTPS, counts the bytes it relays per allocation, and heartbeats those counts home. The
central server ingests the counts through the **existing** `RecordUsage` accounting, hands
live registered nodes out in `/api/ice`'s TURN pool (augmenting the hand-pasted
`RELAYIUM_TURN_RELAYS`), and surfaces per-node telemetry in the admin dashboard.

Success: `curl …/install-node.sh | sh` on a fresh VPS (with a fleet token) → the node
self-registers → its relayed bytes appear in the admin dashboard within a heartbeat → a
cross-network transfer can be routed through it via `/api/ice`.

**Scope.** Fleet nodes only (a shared bootstrap token). Relay only. Storage is out of scope
here — the node reports `storedBytes: 0` and the schema reserves the column; SP2 fills it.
Per-user routing, account-bound tokens, and quota exclusion are SP3.

## Non-goals (explicitly later)

- Storage on nodes (SP2). Node advertises `capabilities:["relay"]` only.
- BYO / account-bound nodes, per-user routing, billable-vs-free split (SP3).
- Replication / high availability — deliberately deferred; a single node's outage makes
  its routing unavailable. (Recorded as a future VIP-subscription feature.)
- coturn self-registration. coturn stays a legacy **static** `RELAYIUM_TURN_RELAYS` option;
  it does not self-report. New fleet capacity uses `relayium-node`.

## Architecture

```
relayium-node (VPS)                          central relayium server
──────────────────                           ───────────────────────
pion/turn server  ──relays ciphertext──▶      (unchanged E2E; node sees only ciphertext)
  │ per-alloc byte counter
  │   key = TURN username (expiry:owner.code)
  ▼
report agent  ──POST /api/nodes/register──▶   validate fleet token → upsert `nodes` row
              ──POST /api/nodes/heartbeat─▶   last_seen=now; per-alloc → RecordUsage(keep-max)
                                              node aggregate → `nodes` row
/api/ice (client)  ◀──online nodes ∪ static── build `relays[]`, one ephemeral cred per node
/admin (operator)  ◀──per-node telemetry────  Nodes table: region/status/bytes/version
```

The node is the same TURN-REST credential scheme already in use: the client gets an
ephemeral credential (`HMAC-SHA1(expiry:owner.code, node.turn_secret)`) from `/api/ice`;
the node validates it with the same secret. The only change from the coturn path is the
transport for *stats* (authenticated HTTPS heartbeat instead of Redis pub/sub) and that the
relay pool is now dynamic.

## Component 1 — `relayium-node` binary

New package `server/cmd/relayium-node` (module `github.com/relayium/relayium`). Single
purpose: relay + report. Does **not** import the web server or `net/http` server routes.

New dependency: `github.com/pion/turn/v4` (pure Go; keeps CGO off / single static binary).

### Configuration (flags + `RELAYIUM_NODE_*` env, mirroring the server's `envStr` idiom)

- `-central-url` / `RELAYIUM_CENTRAL_URL` — e.g. `https://relayium.com` (required).
- `-node-token` / `RELAYIUM_NODE_TOKEN` — fleet bootstrap token (required).
- `-region` / `RELAYIUM_NODE_REGION` — label only (optional).
- `-public-ip` / `RELAYIUM_NODE_PUBLIC_IP` — override; else auto-detect (ipify/ifconfig.me,
  same as `coturn-setup.sh`).
- `-turn-port` (default 3478), `-min-port`/`-max-port` (default 49152-65535).
- `-state-dir` / `RELAYIUM_NODE_STATE_DIR` — default `/var/lib/relayium-node` (root) or
  `~/.local/state/relayium-node`. Holds `state.json`.

### Local state (`<state-dir>/state.json`)

Generated once, persisted, reused across restarts so registration is idempotent:

```json
{ "nodeID": "<assigned by central, empty until first register>",
  "turnSecret": "<64 hex, generated locally on first boot>" }
```

`turnSecret` never leaves the box except to central over TLS (at register). It is the
node's static-auth-secret.

### pion/turn relay + per-allocation byte counting

Run a `turn.Server` bound to `-turn-port` with a `RelayAddressGenerator` over the
`-min-port..-max-port` range, `Realm` matching the fleet realm, and an `AuthHandler` that
validates the TURN-REST credential against the local `turnSecret`
(`key = MD5(username:realm:password)` per the TURN REST/long-term-credential mechanism;
pion provides `turn.GenerateAuthKey`).

Byte counting: wrap the `net.PacketConn` that the `RelayAddressGenerator` allocates in a
counting wrapper that increments a counter on every relayed read+write. Each allocation is
correlated to the TURN username captured in `AuthHandler` (keyed by the client transport
address). The agent thus holds, per live/recent allocation:
`{ allocID string, username string, relayedBytes int64 }` where `allocID` is a stable
node-local id for the 5-tuple (e.g. `"<clientAddr>-<relayPort>"`).

> Implementation note: the exact pion v4 hook points (whether the relay conn or the
> allocation lifecycle exposes the username directly) must be confirmed during
> implementation. The invariant the tests pin: the counting wrapper counts every byte
> read and written through the relay conn, and each counter is tagged with the
> allocation's TURN username. If pion cannot expose the username at allocation time, fall
> back to parsing it from the credential the client presents (same `expiry:owner.code`).

The counting wrapper is a small, independently unit-tested unit: given a fake underlying
`net.PacketConn`, N bytes read + M written ⇒ counter reads N+M.

### Report agent

On start: load/persist state, then `register`. Then a ticker every `heartbeatInterval`
(returned by register; default 30s) sends `heartbeat`. On transient HTTP failure: log and
retry next tick (never crash — a metering blip must not drop relays). `allocID` counters
are cumulative and monotonic; the node reports current cumulative values (keep-max on the
central side makes redelivery idempotent).

Reachability self-test at startup: best-effort check that the node's own public UDP port is
reachable; on failure log a prominent warning (`this node may be behind NAT / firewalled;
peers will not be able to relay through it`) but continue.

## Component 2 — central registration + heartbeat API

Mounted under the existing `/api/` mux (`acct.Routes()`), authenticated by a new config
value `Config.NodeToken` (wired from `-node-token` / `RELAYIUM_NODE_TOKEN` on the server).
Both endpoints require `Authorization: Bearer <token>`, compared constant-time
(`crypto/subtle.ConstantTimeCompare`) against `NodeToken`; empty `NodeToken` ⇒ the endpoints
return 404 (node system disabled), so a server that hasn't opted in exposes nothing.

### `POST /api/nodes/register`

Request:
```json
{ "nodeID": "<persisted id or empty>", "turnSecret": "<hex>",
  "urls": ["turn:1.2.3.4:3478"], "region": "asia", "version": "0.3.0",
  "capabilities": ["relay"] }
```
Behaviour: validate token. If `nodeID` non-empty and a row exists, update it; else assign a
new id (`crypto/rand` hex, same idiom as other IDs) and insert with `owner_type='fleet'`,
`owner_user_id=NULL`, `created_at=now`, `last_seen_at=now`. Store `urls` as a JSON string,
plus `turn_secret`, `region`, `version`.

Response: `{ "nodeID": "<assigned>", "heartbeatInterval": 30 }`.

### `POST /api/nodes/heartbeat`

Request:
```json
{ "nodeID": "<id>", "status": "ok",
  "usage": [ { "allocID": "…", "username": "<expiry>:<userID>.<code>", "relayedBytes": 123 } ],
  "relayedTotal": 456, "storedBytes": 0 }
```
Behaviour: validate token; require a known `nodeID` (410 Gone if unknown, signalling the
node to re-register). Set `last_seen_at=now`. For each `usage` entry, parse the username exactly as
the metering worker does and call the existing `RecordUsage` — reusing the same keep-max
attribution path, so per-user quota accrues identically to the coturn path. Update the
node's aggregate `relayed_bytes`/`stored_bytes` on the `nodes` row (keep-max, monotonic).

Response: `{ "ok": true }` (optionally `heartbeatInterval` to allow retuning).

DRY: factor the metering worker's `tokenFromUsername` and `splitAttrib` (currently
unexported in `internal/metering`) into a shared, exported helper both the worker and this
handler call, so username parsing has one source of truth. Proposed home: a small
`internal/relayusage` package (or exported functions in `internal/metering`) imported by
both. No behaviour change to the worker.

## Component 3 — data model

New table (added to the `SQLiteStore` schema block, following the existing `CREATE TABLE IF
NOT EXISTS` idiom):

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  owner_type    TEXT NOT NULL,                 -- 'fleet' (SP3 adds 'user')
  owner_user_id TEXT,                          -- NULL for fleet
  region        TEXT,
  urls          TEXT NOT NULL,                 -- JSON array of turn: URLs
  turn_secret   TEXT NOT NULL,
  version       TEXT,
  relayed_bytes INTEGER NOT NULL DEFAULT 0,    -- node's own cumulative relayed bytes
  stored_bytes  INTEGER NOT NULL DEFAULT 0,    -- 0 until SP2
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen_at);
```

Per-user relay attribution continues to use `usage_events` unchanged in SP1 (SP3 adds
`node_id`/`billable`).

New store methods (on `Store` interface + `SQLiteStore`):

- `UpsertNode(ctx, Node) (Node, error)` — insert-or-update by id; assigns id when empty.
- `TouchNode(ctx, id string, relayedBytes, storedBytes int64, at int64) error` — set
  `last_seen_at`, keep-max the aggregate counters.
- `OnlineNodes(ctx, since int64) ([]Node, error)` — rows with `last_seen_at >= since` and
  `owner_type='fleet'` (SP3 widens the owner filter).
- `ListNodes(ctx) ([]Node, error)` — all nodes, newest `last_seen_at` first, for admin.

`Node` struct mirrors the columns (`URLs []string` marshalled to/from the JSON column).

## Component 4 — `/api/ice` dynamic pool

In `handleICE`, when `validCode` and a relay pool applies, build `relays[]` from the union
of:

1. **Online fleet nodes** — `OnlineNodes(ctx, now-onlineWindow)` where `onlineWindow` is
   3× the heartbeat interval (90s). Each node → `relayEntry{ ID: node.id, Region: node.region,
   ICEServers: []ICEServer{ turnCredentials(node.turn_secret, token, expiry, node.urls) } }`.
2. **Legacy static** — the existing `s.cfg.TURNRelays` loop, unchanged, for migration.

De-dup by id (a static entry and a dynamic node sharing an id ⇒ dynamic wins). The quota /
verified-email gates above are untouched — fleet-node relay counts toward the owner's quota
exactly as today. STUN and the legacy top-level single-TURN entry are unchanged.

On an `OnlineNodes` read error: log and fall back to the static list only (fail-open — never
break `/api/ice`).

## Component 5 — admin dashboard

Add a "Nodes" section to `handleAdminHome` (reusing existing dashboard markup patterns):
a table of `ListNodes` rows — id (short), region, **status** (online if
`last_seen_at >= now-onlineWindow`, else offline), relayed_bytes (humanized),
stored_bytes (humanized; 0 in SP1), version, last_seen (relative). Read-only in SP1.

## Component 6 — distribution / deploy UX

- goreleaser: add a second build `id: relayium-node`, `main: ./cmd/relayium-node`,
  `binary: relayium-node`, `goos: [linux, darwin]` (server-side; skip windows),
  `goarch: [amd64, arm64]`; include it in the archives.
- `web/public/install-node.sh` — `curl -fsSL …/install-node.sh | sh`, mirroring the CLI
  `install.sh` (OS/arch detection, download from the GitHub release, place binary). Then it
  writes a systemd unit `relayium-node.service` (when run as root with systemd present) that
  runs the binary with `RELAYIUM_CENTRAL_URL` / `RELAYIUM_NODE_TOKEN` / `RELAYIUM_NODE_REGION`
  from an `/etc/relayium-node/env` file the installer creates (prompting or reading env),
  and `systemctl enable --now relayium-node`. Prints how to verify (node appears in
  `/admin`). No-systemd path: print the run command.

## Data flow (relay, end to end)

1. Client A calls `/api/ice?code=…`. Central returns STUN + `relays[]` incl. an online node
   with an ephemeral credential minted from that node's `turn_secret`, username
   `expiry:owner.code`.
2. Peers relay ciphertext through the node's pion/turn allocation. The node's counting
   wrapper tallies bytes under that allocation's username.
3. Every 30s the node POSTs `heartbeat` with the per-alloc counts. Central parses the
   username → `RecordUsage` (owner attribution, keep-max) and bumps the node's aggregate.
4. Admin dashboard shows the node online with its relayed byte total; the owner's monthly
   relayed usage (and quota enforcement) reflects the relayed bytes — identical to coturn.

## Error handling & trust

- Node ↔ central over HTTPS (TLS built in); bearer token, constant-time compared; disabled
  (404) when `NodeToken` unset.
- Heartbeat failures are non-fatal on the node (retry next tick); relays keep working blind
  and reconcile on the next successful heartbeat (keep-max ⇒ no double count).
- Self-reported metrics are quota-relevant only for **fleet** nodes, which we operate and
  trust. (BYO nodes in SP3 don't count toward quota, removing the incentive to lie.)
- E2E unchanged: the node relays ciphertext; it never holds keys or plaintext.

## Testing

- **Counting wrapper (node):** fake `net.PacketConn`; N read + M written ⇒ counter = N+M;
  concurrent access is race-free (`go test -race`).
- **Username parsing helper:** table test moved/shared from metering; `expiry:userID.code`
  ⇒ `(userID, code)`; malformed ⇒ skipped; legacy no-dot token ⇒ `("", token)`.
- **register handler:** missing/wrong bearer token ⇒ 401; empty server `NodeToken` ⇒ 404; new
  node ⇒ row inserted, id returned; existing id ⇒ updated not duplicated.
- **heartbeat handler:** unknown nodeID ⇒ 410; valid ⇒ `last_seen` set, `RecordUsage` called
  per usage entry (fake sink), node aggregate keep-max.
- **OnlineNodes / dynamic pool:** an online node appears in `/api/ice` `relays`; an
  offline node (stale `last_seen`) is excluded; union with a static `TURNRelays` entry;
  dynamic wins a shared id; `OnlineNodes` error ⇒ static-only fallback (no 500).
- **admin nodes section:** renders online/offline status from `last_seen`.
- **pion/turn smoke (best-effort):** a loopback allocation relays a datagram and the wrapper
  counts it; skipped in CI if UDP sandboxing blocks it.

## Resolved implementation questions

- **Associating relayed bytes with a username — RESOLVED.** pion/turn v4's
  `EventHandler.OnAllocationCreated(srcAddr, dstAddr, protocol, username, realm, relayAddr,
  requestedPort)` supplies the `relayAddr ↔ username` join. A custom `RelayAddressGenerator`
  wraps each allocated relay `net.PacketConn` in a byte-counter keyed by the returned
  `relayAddr`; the event handler then tags that counter with the `username`. No per-packet
  hook or username inference is needed.
- **Shared username-parsing helper — RESOLVED.** Lives in a new `internal/relayusage`
  package; the metering worker is refactored to call it (one source of truth).
