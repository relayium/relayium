# Phase 0 — Default-on Relay Metering (C1 fix)

Date: 2026-07-10
Status: Approved (design)

## Problem (C1)

The hosted relay enforces a per-user monthly relay allowance (`-relay-monthly-free`,
default 2 GiB). That enforcement lives in `handleICE` (`server/internal/account/turn.go`):
it compares the user's accrued `relayed_bytes` against the allowance before minting
TURN credentials.

`relayed_bytes` only ever grows when the metering worker ingests coturn's per-allocation
traffic stats from Redis. The worker is started **only** when `-redis-addr` is non-empty
(`server/main.go`). Therefore:

- TURN enabled + relay quota configured (both true by default) + `-redis-addr` empty
  → the worker never runs → `relayed_bytes` stays 0 for every user → the quota check
  in `handleICE` always passes → **the relay is effectively unlimited and free.**

This is a silent failure: nothing at startup or runtime signals that the quota being
"enforced" is measuring nothing. That is the C1 gap.

## Goal

Make metering a mandatory precondition of enforcing a relay quota, and make the default
deployment configs meter by default — with no user-facing opt-out. Three coordinated
changes: a startup guard (code), the single-host compose profile, and the remote-relay
setup script.

Non-goal: BYO-relay self-host nodes (a later phase). Those nodes carry the *user's own*
bandwidth and are intentionally **not** metered against our quotas — out of scope here.

## A. Startup guard (`server/main.go`)

Refuse to start when the configuration is incoherent: a relay quota is being enforced
but no metering pipe is wired to feed it.

**Rule.** Fatal error at startup when **all** of:

- TURN is enabled — `-turn-secret` non-empty **or** `-turn-relays` non-empty, and
- `-relay-monthly-free > 0` (a per-user relay quota is actually being enforced), and
- `-redis-addr` is empty (no metering ingestion pipe).

**Escape hatch (no new flag).** To run an intentionally unmetered / unlimited relay,
set `-relay-monthly-free 0`. With no quota to enforce, metering is not required and the
guard does not fire. This keeps configuration self-consistent: enforce a quota ⟹ measure
it; measure nothing ⟹ don't claim to enforce a quota.

**Liveness vs. configuration.** The guard checks *configuration presence* (`redisAddr == ""`),
**not** whether Redis is reachable. A transient Redis outage at boot must NOT block the
server: with `-redis-addr` set, the app starts, the worker retries the connection in the
background (existing behaviour), and the M2 Watchdog warns while the pipe is silent. Only a
genuinely missing config is refused.

**Blast radius.** The guard fires only when TURN is enabled. Server-only / LAN-only
deployments (no TURN) are entirely unaffected and start normally.

**Error message** must name the exact resolution, e.g.:

```
fatal: relay quota is enforced (-relay-monthly-free=2147483648) with TURN enabled,
but no metering pipe is configured (-redis-addr is empty). An unmetered relay quota
is never enforced. Set -redis-addr (RELAYIUM_REDIS_ADDR) to the coturn stats Redis,
or set -relay-monthly-free 0 to run an intentionally unlimited relay.
```

Placement: after flags are parsed and before the HTTP server starts serving, alongside
the existing account/metering wiring. Emit via `log.Fatalf` (consistent with existing
fatal paths in `main.go`).

## B. Single-host compose (`docker-compose.yml`)

The `relay` profile already co-locates coturn + redis with the server. Make it meter by
default:

- Uncomment coturn's `--redis-statsdb=ip=127.0.0.1 dbname=0` (host-networked, so the
  stats DB is localhost).
- Uncomment the server's `RELAYIUM_REDIS_ADDR: "redis:6379"`.

Because the server env only sets `RELAYIUM_REDIS_ADDR`, and the guard fires only when TURN
is also enabled, a plain server-only `docker compose up -d` is unaffected (it configures no
TURN, so the guard is inert even though the redis addr is present; the metering worker will
attempt to reach `redis:6379` and retry — acceptable, but see note below).

Note: to avoid the metering worker logging reconnect noise in a server-only run, keep the
`RELAYIUM_REDIS_ADDR` line scoped so it is only meaningful under the relay profile. Since
compose cannot set env per-profile, document the coupling clearly in a comment: relay
profile ⇒ metering redis is part of it. (No behavioural code change; the retry noise is
tolerable and the guard is the real safety net.)

## C. Remote relay setup (`deploy/coturn-setup.sh`)

A relay-pool coturn on a separate VPS must publish its stats to a Redis the app server can
read. The script cannot invent that endpoint, so:

- Add an optional flag `--metering-redis <spec>` where `<spec>` is passed through to
  coturn's `redis-statsdb=` line (e.g. `ip=10.0.0.5 port=6379 dbname=0 password=…`).
  When provided, `emit_turnserver_conf` writes a `redis-statsdb=<spec>` line.
- When omitted, print a prominent warning in the final output:
  `⚠  This relay is NOT metered: its relayed bytes will not count against any user's
  quota. Pass --metering-redis <ip=… [port=… password=…]> pointing at the app server's
  stats Redis to meter it.`

This makes an unmetered remote relay *loud*, matching the "no silent unmetered relay"
principle, while acknowledging the physical constraint that a remote box needs a reachable
Redis endpoint we can't fabricate.

`emit_turnserver_conf` gains a trailing `redis_statsdb` argument (empty ⇒ no line), keeping
it pure and unit-testable via the existing deploy/test harness.

## How the three parts close C1

- **A (hard gate)** eliminates the "forgot `-redis-addr` entirely" case — the app refuses
  to run a quota-enforcing relay blind.
- **C (loud warning)** eliminates the *silent* "remote coturn not publishing" case at setup
  time.
- **M2 Watchdog (existing)** catches the runtime case where `-redis-addr` is set but no
  coturn is actually publishing (events stop / never start).

The residual gap — a remote coturn genuinely misconfigured to publish nowhere — is inherent
to distributed relays and cannot be a refuse-to-start (the app can't verify a remote box at
boot). It is covered by the loud setup warning (C) plus the runtime Watchdog. This is the
physical limit of the fix.

## Testing

- **Guard (unit / table):** extract the guard predicate into a small pure function
  `func relayMeteringMisconfigured(turnEnabled bool, relayMonthlyFree int64, redisAddr string) bool`
  and table-test the matrix: TURN off (never fatal), quota 0 (never fatal), redis set
  (never fatal), and the one fatal combination. Wire `main.go` to call it and `log.Fatalf`.
- **coturn-setup.sh:** extend the existing `emit_turnserver_conf` deploy test to assert
  a `redis-statsdb=<spec>` line appears when the arg is set and is absent when empty.
- **compose:** no automated test; manual `docker compose --profile relay up -d` sanity
  (metering line in coturn logs, `metering: ingesting …` in server logs).

## Out of scope / follow-ups

- BYO-relay self-host nodes (Phase 1+).
- Centralized/authenticated metering Redis for a multi-VPS relay pool over the public
  internet (TLS/tunnel). Today this is the operator's infra responsibility; `--metering-redis`
  just wires whatever endpoint they provide.
