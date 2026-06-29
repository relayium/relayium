# Cross-Network Transfer — Design (Spec ②a: Token-Room + STUN P2P)

**Date:** 2026-06-29
**Status:** Approved (brainstorming) → ready for implementation plan
**Depends on:** Spec ① account foundation (DONE, merged to main)
**Milestone:** First slice of the cross-network transfer effort (Spec ②).

## Summary

Today Relayium transfers work only between peers that share a public IP: the
signaling room key *is* the public IP (`signal.RoomKey`), which gives implicit
same-LAN rendezvous with no login. The WebRTC layer (`web/src/lib/webrtc.ts`)
already performs full ICE (offer/answer/candidate exchange) and the
crypto/SAS/transfer pipeline is transport-agnostic — so the only thing blocking
cross-network transfer is **rendezvous**: two peers on different networks land
in different rooms and never see each other.

This slice adds an explicit **token-room** rendezvous mode so two cross-network
peers can share a room and connect P2P over **STUN only** (no TURN yet). A
logged-in sender mints a one-time transfer token via an authenticated endpoint,
shares a link carrying that token, and the receiver opens the link to join the
same room login-free. Everything downstream (roster → signal → SAS → WebRTC
DataChannel → AES-256-GCM) is unchanged.

**Deliverable:** a logged-in user can generate a share link; the other party
opens it and, on a different network, completes one end-to-end-encrypted
transfer via STUN P2P. Works for any NAT combination that hole-punches
successfully. Zero new infrastructure (public STUN is free).

## Red line (unchanged from Spec ①)

The server still only relays opaque signaling and **never touches file content
or encryption keys**. The account/transfer layer is an auth/rendezvous/metering
anchor, nothing more. End-to-end security (X25519 + AES-256-GCM + 6-digit SAS)
is identical regardless of transport.

## Architecture: two rendezvous modes

`/ws` resolves the room from the request:

```
room query param present?
  ├─ no  → RoomKey(r) = public IP        (LAN mode: login-free, never touches DB)
  └─ yes → store.GetTransfer(token)
             ├─ valid & not expired → room = "t:" + token   (token-room mode)
             └─ invalid / expired / DB unavailable → reject handshake (close ws)
```

- The `"t:"` prefix namespaces token-rooms so a token can never collide with an
  IP-keyed room.
- Token validation happens **only** when `?room=` is present, so a DB outage
  affects cross-network only; LAN transfer is unaffected (preserves the Spec ①
  decoupling principle). Cross-network deliberately depends on the account DB
  because it *is* the account-gated feature.

```
Sender (logged in)        Server                       Receiver (login-free)
  │  POST /api/transfers     │                                │
  │ ───────────────────────► │  mint one-time token,          │
  │  ◄─────────────────────  │  store in SQLite (transfers)   │
  │  {token, expiresAt}      │  bound to user_id              │
  │  build share link        │                                │
  │                          │   ┌── link carries #t=<token> ►│ open link
  │  /ws?room=<token>        │   │                             │ /ws?room=<token>
  │ ───────────────────────► │ ◄─┘  GetTransfer validates      │◄────────────
  │     both in room "t:<token>" → existing roster→signal→SAS→WebRTC (STUN)    │
```

The **login gate** is enforced at **token creation** (`POST /api/transfers`
requires a session), not at join. Possession of the token is the room
capability — which is exactly what lets a sender share the link with anyone.

## Server data model & API

### New table (via the Store interface, same pattern as Spec ①)

```sql
CREATE TABLE transfers (
  token       TEXT PRIMARY KEY,   -- one-time room token (32B hex, same randToken as session/magic)
  user_id     TEXT NOT NULL,      -- originator (logged-in user): metering/audit anchor
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL    -- short-lived, default 1 hour
);
CREATE INDEX idx_transfers_user ON transfers(user_id);
```

v1 stores only these columns. The next slice (②b, TURN) adds a `relayed_bytes`
metering column via `ALTER TABLE`.

### Store interface additions (implemented in `sqlite.go`; only `ErrNotFound` crosses the boundary)

- `CreateTransfer(ctx, Transfer) error`
- `GetTransfer(ctx, token) (Transfer, error)` — used by `/ws` join validation
- `DeleteExpiredTransfers(ctx, now int64) error` — cleanup (lazy and/or scheduled)

### HTTP API (mounted on the existing `/api/` mux, reuses `RequireSession`)

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `POST` | `/api/transfers` | session required | Mint a token bound to the current user; return `{token, expiresAt}` |

The receiver needs no account API — it just connects `/ws?room=<token>`.

### Room capacity

Token-rooms are capped at **2 peers**. The first joiner is the intended sender,
the second the receiver; a third join is rejected at the handshake so a
link-snooper cannot crowd in. SAS remains the final human-verified defense.

## Client flow

### Sender (logged in)

A new explicit action — "Send to someone on another network":

```
click → not logged in? → prompt login (reuse Account.svelte login entry)
        logged in → POST /api/transfers → receive token
                  → show share link https://relayium.app/#t=<token> + QR + copy button
                  → connect /ws?room=<token> as initiator, wait for receiver
                  → receiver joins → existing roster→signal→SAS→WebRTC, pick files, send
```

### Receiver (login-free)

On app start, detect `location.hash` for `#t=<token>`:

```
has #t= → connect /ws?room=<token> as responder
        → see the peer in the room → existing SAS check → receive files
no #t=  → existing LAN mode, unchanged
```

### Client changes (focused)

- `signaling.ts` / `webrtc.ts`: the `/ws` URL gains an optional `?room=` query
  param (currently a hardcoded path); all other signaling logic is unchanged.
- A small new module (e.g. `transfer-link.svelte.ts`): create link / parse hash
  / QR.
- A "cross-network send" entry point in the main UI + i18n strings (6 languages,
  same set as Spec ①).
- **The crypto/SAS/transfer pipeline (`crypto.ts` / `transfer.ts`) is untouched**
  — it is transport-agnostic.
- QR via a lightweight library (e.g. `qrcode`), loaded on demand only when the
  cross-network panel opens.

## Security

- **Token = capability:** 32 random bytes (256-bit, non-enumerable); carried in
  the URL fragment so it never reaches server logs or the `Referer` header;
  short expiry (1h). Validation in ②a is existence + non-expiry only, so the
  link is a TTL-bounded bearer capability — it stays usable (by the holder, for
  one logically-single transfer session) until it expires, rather than being
  consumed on first use. Strict consume-on-completion is deferred to ②b, which
  already rewrites this table for relayed-byte metering. The 2-peer cap + SAS
  (below) are what bound exposure regardless of reuse.
- **2-peer cap + SAS:** even if a third party intercepts the link and joins
  first, the sender aborts on SAS mismatch and no file content leaks.
- **Login gate** only at token creation; DB outage → cross-network refused, LAN
  unaffected.
- **No new server trust:** the server still relays only opaque signaling and
  never touches file content or keys (Spec ① red line continues).

## Error handling

- Invalid/expired token → `/ws` closes the handshake; client shows "this link
  has expired, please request a new one from the sender".
- Room full (3rd joiner) → handshake rejected; same class of user-facing message.
- `POST /api/transfers` without a session → 401 (via `RequireSession`).

## Testing

- **Go:**
  - `transfers` CRUD + expiry + `ErrNotFound` translation (`sqlite_test`).
  - `POST /api/transfers` requires a session and returns a token
    (`handlers_test`).
  - `/ws` room resolution — three branches: no param → IP room; valid token →
    `t:` room; invalid/expired/full → rejected (signal/main-layer test, `now`
    injected for determinism).
  - 2-peer capacity enforcement.
- **Web:** `signaling.ts` builds the `?room=` URL; hash parsing of `#t=token`;
  link-builder module unit tests. Vitest as in Spec ①.
- **Manual acceptance:** run the link → SAS → transfer flow across two real
  machines on two networks; add to `docs/TESTING.md`.

## Scope boundary — explicitly NOT in this slice

Deferred to later sub-specs (queued in project memory):

- ❌ TURN relay fallback + relayed-byte metering → **Spec ②b**
- ❌ Trusted-device, same-account device-to-device addressing → **Spec ②c**
- ❌ Billing, quota enforcement, persistent device keys / skip-SAS
- ❌ Any P2P hole-punch-failure fallback beyond "switch network / retry"
  (that is precisely what ②b's TURN provides)
