# Cross-Network TURN Connectivity — Design (Spec ②b-1)

**Date:** 2026-06-29
**Status:** Approved (brainstorming) → ready for implementation plan
**Depends on:** Spec ②a (token-room + STUN P2P, DONE/merged) and Spec ① (accounts).
**Milestone:** First slice of ②b. Adds TURN relay fallback so hard-NAT peers can
connect. Relayed-byte metering is the next slice (②b-2).

## Summary

Spec ②a connects cross-network peers P2P over STUN. STUN-only fails for
symmetric-NAT pairs, which need a TURN relay. This slice makes a (self-hosted
coturn) TURN server available to cross-network peers via **ephemeral
credentials**, so WebRTC's ICE automatically falls back to relay when direct
hole-punching fails. No manual fallback logic is needed — TURN simply joins the
`iceServers` list and relay candidates carry the lowest ICE priority, so the
browser only relays when it must.

**Deliverable:** a logged-in sender and a (login-free) receiver on hard NATs can
complete one end-to-end-encrypted transfer relayed through self-hosted coturn.
When no TURN server is configured, behavior degrades gracefully to ②a's
STUN-only path. **Out of scope (→ ②b-2):** counting/ingesting relayed bytes.

## Red line (unchanged)

The server never touches file content or keys. TURN relays only the **DTLS-
encrypted** WebRTC stream — coturn cannot see plaintext. The transfer/account
layer remains auth/rendezvous only.

## Architecture

### TURN fallback is automatic

`web/src/lib/webrtc.ts`'s `connect()` already accepts `config?: RtcConfig` and
passes `iceServers` to `RTCPeerConnection`. Today both `connect()` call sites in
`App.svelte` pass no config, so they use the hardcoded STUN-only `DEFAULT_ICE`.
This slice fetches the ICE server list (STUN + TURN-with-ephemeral-credentials)
and passes it as `config`. ICE then prefers direct candidates and relays only on
failure. No switching code.

### Both peers need TURN credentials — so the endpoint is token-gated, not session-gated

In WebRTC each peer allocates its own relay candidate from its own TURN server,
so **both** the sender and the receiver need TURN credentials. The receiver is
login-free (it joined via a share link), holding only the transfer token. Thus
the credential endpoint authorizes by **possession of a valid transfer token**
(the room capability), exactly like `/ws?room=<token>` in ②a — not by session.

```
GET /api/ice?room=<token>
  ├─ token valid (same ValidateTransferToken as /ws) & TURN configured
  │     → return STUN + TURN (ephemeral credential, username encodes the token)
  ├─ token absent (LAN mode)        → return STUN only (LAN needs no TURN)
  └─ token invalid / expired / no TURN secret → return STUN only (graceful, no leak)
```

The username embeds the token so coturn's per-session accounting can later
attribute relayed bytes to the token → its owning user (the anchor ②b-2 needs).

### Graceful degradation

If the server has no TURN shared secret configured, `/api/ice` returns STUN
only. Cross-network transfer still works for easy-NAT pairs (②a behavior), and
coturn can be deployed incrementally without a code change. Because `/api/ice`
reuses `ValidateTransferToken`, a DB outage silently drops TURN while STUN
continues — same fail-closed/decoupled posture as ②a.

### LAN path unchanged

A LAN peer has no `roomToken`; `/api/ice` returns STUN only (and never issues
TURN). The crypto/SAS/transfer pipeline is untouched.

## Server

### Ephemeral credential generation (new `server/internal/account/turn.go`)

Follows the coturn TURN REST mechanism ("A REST API For Access To TURN
Services"): a shared `static-auth-secret` lets the server mint time-limited
credentials coturn validates without any per-credential state.

```go
type ICEServer struct {
    URLs       []string `json:"urls"`
    Username   string   `json:"username,omitempty"`
    Credential string   `json:"credential,omitempty"`
}

// username = "<expiryUnix>:<token>"; credential = base64(HMAC-SHA1(secret, username))
func turnCredentials(secret, token string, expiry int64, urls []string) ICEServer {
    username := fmt.Sprintf("%d:%s", expiry, token)
    mac := hmac.New(sha1.New, []byte(secret))
    mac.Write([]byte(username))
    cred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
    return ICEServer{URLs: urls, Username: username, Credential: cred}
}
```

SHA-1 here is the coturn protocol's HMAC construction (HMAC-SHA1), not a
security-sensitive hash of secret data; it is the required interop format.

### Configuration (new `Config` fields + `main.go` flags)

- `-turn-secret` — shared `static-auth-secret`; empty ⇒ TURN disabled.
- `-turn-urls` — comma-separated TURN URLs, e.g.
  `turn:turn.relayium.app:3478,turns:turn.relayium.app:5349`.
- `-stun-urls` — comma-separated STUN URLs; default
  `stun:stun.l.google.com:19302` (operators may point at their own coturn).
- `Config.TURNCredTTL` — credential lifetime, default 1h.

The Service holds the STUN list, TURN URLs, TURN secret, and `TURNCredTTL`.

### Endpoint (mounted on the existing `/api/` mux; NOT `RequireSession`)

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `GET` | `/api/ice` | token-bearer (optional) | Return ICE servers (STUN always; TURN when a valid `?room=` token + configured secret) |

```
handleICE:
  token := r.URL.Query().Get("room")
  servers := stunServers()                       // always
  if token != "" && turnSecret != "" && ValidateTransferToken(ctx, token):
      expiry := now().Add(TURNCredTTL).Unix()
      servers = append(servers, turnCredentials(turnSecret, token, expiry, turnURLs))
  writeJSON(200, {"iceServers": servers})
```

## Client

### New module `web/src/lib/ice.ts`

```ts
export async function fetchIceServers(token: string): Promise<RTCIceServer[]> {
  const q = token ? `?room=${encodeURIComponent(token)}` : "";
  const res = await fetch(`/api/ice${q}`, { credentials: "include" });
  if (!res.ok) return [{ urls: "stun:stun.l.google.com:19302" }]; // fallback
  return (await res.json()).iceServers as RTCIceServer[];
}
```

### App.svelte wiring

In `onMount` (or before the first `connect()`), fetch the ICE server list once
using `roomToken` and store it; pass `config: { iceServers }` to both existing
`connect({...})` call sites.

- With `roomToken` (cross-network) → STUN + TURN.
- Without `roomToken` (LAN) → `/api/ice` returns STUN only → unchanged behavior.
- `webrtc.ts` `connect()` is unchanged — it already accepts `config`; it simply
  now receives a real one.

## coturn deployment (operations note, `docs/`)

A docs note (not CI, not code): run coturn with `use-auth-secret` and
`static-auth-secret <same value as -turn-secret>`; listen on 3478 (UDP/TCP) and
5349 (TLS, `turns:`); set `realm`; open the relay port range in the firewall.
TURN-over-TLS on 5349 helps clients behind restrictive egress filtering.

## Security

- Credentials are short-lived (1h), HMAC-signed, and unforgeable; coturn
  validates expiry from the username with the shared secret — no per-credential
  state.
- The token segment of the username lets coturn accounting attribute relayed
  bytes to the token → user (used in ②b-2). The token is already a 256-bit
  non-enumerable capability.
- `/api/ice` never errors on a bad/absent token — it just omits TURN — so it
  leaks nothing about token validity.
- TURN relays only the DTLS-encrypted WebRTC stream; coturn sees no plaintext
  (Spec ① red line continues).

## Error handling

- `/api/ice` always returns 200 with at least STUN; the client falls back to a
  default STUN entry if the fetch itself fails (non-2xx/network).
- A misconfigured/down coturn manifests as ICE failing to find a relay path; the
  existing connect-failure UX (from ②a/M0) surfaces it. No new error state.

## Testing

- **Go:**
  - `turnCredentials` — exact `username` format and `credential ==
    base64(HMAC-SHA1(secret, username))`, with an injected clock for the expiry.
  - `/api/ice` four branches: no token → STUN only; valid token + secret → TURN
    present with a well-formed credential; invalid/expired token → STUN only;
    TURN disabled (no secret) → STUN only. `now` injected for determinism.
- **Web:** `fetchIceServers` — builds `?room=` only when a token is present,
  parses `iceServers`, and falls back to a STUN entry on a non-ok response;
  App passes `config` to `connect()` when a `roomToken` is set.
- **Manual acceptance** (`docs/TESTING.md`): two peers on hard NATs (or forced
  via `RTCConfiguration.iceTransportPolicy = "relay"`) complete a transfer
  relayed through coturn; verify the relay path and that SAS + per-file SHA-256
  still pass. Confirm the no-TURN-configured path still does STUN-only ②a.

## Scope boundary — NOT in this slice

- ❌ Counting / ingesting relayed bytes (coturn → server → usage table) → **②b-2**
- ❌ Quota enforcement, billing, rate limiting
- ❌ Trusted-device addressing → **②c**
- ❌ A getStats() "relayed" indicator (deferred to ②b-2 / telemetry)

**Deliverable:** cross-network transfer succeeds on hard NATs via self-hosted
coturn TURN relay; absent a configured TURN secret, it degrades to ②a STUN-only.
