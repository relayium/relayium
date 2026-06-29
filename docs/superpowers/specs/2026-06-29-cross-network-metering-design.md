# Cross-Network Relayed-Byte Metering — Design (Spec ②b-2)

**Date:** 2026-06-29
**Status:** Approved (brainstorming) → ready for implementation plan
**Depends on:** Spec ②b-1 (TURN connectivity, DONE/merged) and Spec ① (accounts).
**Milestone:** Second slice of ②b. Records the relayed bytes coturn reports for
each cross-network transfer, attributed to the originating user — the billing
foundation. Does NOT bill, enforce quota, or rate-limit.

## Summary

②b-1 made a self-hosted coturn TURN relay available via ephemeral credentials
whose `username` is `"<expiryUnix>:<token>"`. That token is the metering anchor.
This slice ingests coturn's per-allocation relay accounting (published to Redis)
into a durable `usage_events` table keyed to the transfer token → its owning
user, and exposes a logged-in user's running total at `GET /api/usage`.

**Deliverable:** a cross-network transfer that relays through coturn has its
relayed bytes authoritatively recorded (by coturn, not the untrusted browser)
and attributed to the originating user; the user can read their cumulative total.
No billing, quota, or enforcement. **Out of scope (→ later / ②c):** quota
enforcement, billing/invoicing, rate-limiting, persistent device keys, trusted
devices, multi-TURN-node aggregation, time-bucketed/period usage.

## Red line (unchanged)

The server still never touches file content or keys; coturn relays only the
DTLS-encrypted WebRTC stream and sees no plaintext. Metering counts only byte
totals coturn reports — it never inspects relayed content.

## Architecture & data flow

```
coturn relay session ends (allocation closed)
  → coturn publishes to Redis channel
    turn/realm/<realm>/user/<username>/allocation/<allocId>/total_traffic
    payload {rcvb, sentb, ...}   (username = "<expiryUnix>:<token>", the ②b-1 anchor)
  → server metering worker (goroutine) psubscribes the channel pattern
  → parse token from username → GetTransfer(token) → user_id
  → RecordUsage(allocId, token, user_id, rcvb+sentb)   (keep-max upsert)
```

Why Redis: coturn's `--redis-statsdb` publishes structured per-allocation totals
keyed by the credential username in real time — the canonical, server-
authoritative, per-user accounting source. The browser is never trusted to
self-report. (Log-tailing was rejected: brittle format/rotation/parsing and
cross-host log shipping.)

### Package structure

New package `server/internal/metering`, so the Redis dependency stays out of the
`account` package (which remains storage + auth):

- `StatsSource` interface — yields `UsageEvent`s; a Redis implementation plus a
  fake for tests (mirrors the project's `Store`/`Mailer` interface-driven style).
- `Worker` (`Run`) — consumes events, parses the token, resolves the user via
  `account.Store`, records usage. Unit-testable without a real Redis.
- The Redis client (`github.com/redis/go-redis/v9`) is referenced only here.

### Storage (new `usage_events` table via the `account.Store` interface)

```sql
CREATE TABLE usage_events (
  alloc_id      TEXT PRIMARY KEY,   -- coturn allocation id; the idempotency key
  token         TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  relayed_bytes INTEGER NOT NULL,
  recorded_at   INTEGER NOT NULL
);
CREATE INDEX idx_usage_user ON usage_events(user_id);
```

- `RecordUsage` uses a **keep-max upsert on `alloc_id`**: coturn reports a
  cumulative total (possibly periodically during a session); `RecordUsage` keeps
  the largest `relayed_bytes` seen per `alloc_id`, which is redelivery-safe,
  periodic-safe, and stale-report-safe. **Idempotency is the correctness core.**
- `UserUsageTotal(userID)` = `SUM(relayed_bytes) WHERE user_id = ?`.
- Append-only and independent of the `transfers` lifecycle, so billing history
  survives transfer-row cleanup. **Constraint:** the token→user mapping is read
  at ingest time via `GetTransfer`, so any future `transfers` cleanup period must
  be ≥ the TURN credential TTL (today both are 1h), or late-closing sessions
  would lose attribution.

### What is counted

`relayed_bytes = rcvb + sentb` summed across every allocation reported for the
token. A relay consumes bandwidth in both directions; when both peers relay,
each allocation's traffic is counted — reflecting true bandwidth cost.

## Server

### `account` additions

- `account.UsageEvent{ AllocID, Token, UserID string; RelayedBytes, RecordedAt int64 }`.
- `Store.RecordUsage(ctx, UsageEvent) error` — keep-max upsert on `alloc_id`.
- `Store.UserUsageTotal(ctx, userID string) (int64, error)`.
- `GET /api/usage` (session-gated via `RequireSession`) → `{"relayedBytes": <total>}`.

### `metering` package

```go
type UsageEvent struct {
    AllocID      string
    Username     string // "<expiry>:<token>"
    RelayedBytes int64  // rcvb + sentb
}

type StatsSource interface {
    Events(ctx context.Context) (<-chan UsageEvent, error)
}

// Sink is the subset of account.Store the worker needs.
type Sink interface {
    GetTransfer(ctx context.Context, token string) (account.Transfer, error)
    RecordUsage(ctx context.Context, e account.UsageEvent) error
}

// Run consumes events until ctx is cancelled: parse the token from the username,
// resolve the user, record usage (idempotent). Unknown/expired tokens are
// logged and skipped.
func Run(ctx context.Context, src StatsSource, sink Sink, log *log.Logger) error
```

- Token extraction: the substring after the first `:` in `Username`
  (`strings.SplitN(username, ":", 2)`).
- Unknown token (transfers row gone / forged username) → log and skip; never
  insert, never crash.
- The Redis implementation `psubscribe`s `turn/realm/*/user/*/allocation/*/total_traffic`,
  extracts `allocId` from the channel path and `rcvb`/`sentb` from the payload,
  and emits `UsageEvent`s. Channel-parsing and payload-parsing are pure
  functions, unit-tested without Redis.

### Configuration & wiring (`main.go`)

- New flag `-redis-addr` (e.g. `localhost:6379`; empty ⇒ metering ingestion off).
- The worker starts (`go metering.Run(...)`) only when `-redis-addr` is set AND
  the account DB is available. Metering is an optional layer: its absence never
  affects transfer or TURN connectivity.
- `docs/coturn.md` gains the `--redis-statsdb` line.

## Error handling

- Worker errors (Redis disconnect, malformed message) are logged and the worker
  keeps running / reconnects; they never affect signaling, TURN, or transfers.
- Unknown/expired token at ingest → logged, skipped.
- DB unavailable ⇒ account features (incl. `/api/usage`) are already skipped by
  the existing ②a wiring; the worker is simply not started.

## Testing

- **metering:** `Run` driven by a fake `StatsSource` + a fake/real `Sink`:
  verifies token extraction, user resolution, `rcvb+sentb` summing, unknown-token
  skip, and **keep-max** (feeding the same `AllocID` twice keeps the larger total).
  Redis channel-path → `allocId` and payload → bytes are pure-function unit tests,
  no real Redis.
- **account:** `RecordUsage` keep-max upsert + `UserUsageTotal` sum
  (`sqlite_test`); `GET /api/usage` session-gated + returns the total
  (`handlers_test`).
- **Manual** (`docs/TESTING.md`): run Redis + coturn (`--redis-statsdb`), force a
  relayed transfer, confirm `/api/usage` grows and matches coturn's reported
  bytes.

## Scope boundary — NOT in this slice

- ❌ Quota enforcement / rate-limiting / billing / invoicing (record + read only).
- ❌ Persistent device keys, trusted-device addressing (→ ②c).
- ❌ Multi-TURN-node aggregation / sharding (single coturn + single Redis to start).
- ❌ Time-bucketed / per-period usage (cumulative total only; periods arrive with
  real billing).

**Deliverable:** relayed bytes for cross-network TURN transfers are coturn-
authoritative, ingested via Redis, idempotently attributed token→user, and
readable at `GET /api/usage` — the billing foundation, without charging or
enforcing.
