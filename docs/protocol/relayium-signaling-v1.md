# Relayium signaling protocol v1 (authoritative)

The WebSocket rendezvous that pairs two peers in a code room and relays their
opaque WebRTC/crypto payloads. Transport only — the SDP/ICE and commit-reveal SAS
handshake ride inside `data` and are defined by the realtime layer, not here.

## Connection
- `GET <wsBase>/ws?code=<urlencoded code>` upgraded to a WebSocket.
- Empty code → the LAN room; non-empty code → that code room. A pairing-code room
  holds exactly two peers; the LAN room holds up to a server cap (currently 50),
  so the `peers` roster there may list more than one other peer.

## Pairing code (authoritative: `signal.CodeAlphabet` / `CodeLen` / `CodeTTLSeconds`)
- Exactly **6 decimal digits**, `0`-`9`. Leading zeros are ordinary: `004291` and
  `000000` are valid codes and are NOT the integers 4291 and 0. A client that
  parses a code as a number destroys a tenth of the code space.
- Case has no meaning; there is nothing to normalize but "discard non-digits".
- **Not** the same six digits as the SAS (relayium-handshake-v1.md), which is
  derived from the two endpoint public keys. Two different values, same width.
- **TTL 300 s**, checked once, at this join. Nothing re-checks it afterwards, so
  a code expiring mid-session never interrupts an established transfer.
  - 300 s from the MINT is the floor, not always the value. Where pre-upload is
    enabled (`relayium-pair-room-v1.md`), a code with staged ciphertext is
    extended to its room's join deadline on every accepted committed append —
    up to six hours from when the room opened — and is REVOKED outright when
    that room is voided. Both are owner-bound and forward-only; an expired code
    is never revived. A client still treats the code as opaque and short-lived:
    the only observable difference is that a code can outlive the `expiresAt`
    it was minted with, so that value is a floor to display, never a promise.
- The server refuses a wrong-shaped code with 403 before any registry lookup.
- Admission limits, per `main.go`, in two distinct kinds:
  - **Distinct codes tried: 5 per minute per IP, shared with `/api/ice`**
    (`signal.CodeGuessLimiter`, one object injected into both). The two
    endpoints are two halves of one validity oracle — a live code gets you into
    the room here and a `turn:` entry there — so the budget counts candidate
    CODES, not requests, and splitting guesses across the two endpoints buys
    nothing. Presenting the same code to both, which is what a real receiver
    does, spends one of the five.
  - **Requests: 5 per minute per IP on this endpoint** (`wsJoinPerIPPerMinute`,
    deliberately equal to `/api/ice`'s own request cap). Repeating one code
    costs no guess budget, so this is what keeps that from being free load.
  - Plus a process-wide breaker on INVALID attempts (200/min, 30 s cooldown).
    The breaker is fed only by refused codes, so it can never deny a valid join
    — and for the same reason it sheds load and flags floods rather than
    bounding how many codes a distributed attacker may try.
  All three are per-process counters. Behind a round-robin load balancer each
  instance enforces its own (`account.PerInstanceThreshold` divides them for
  that case); none of them is a global or cross-instance ceiling. The
  distinct-code budget and the TTL are the bound on guessing one live code from
  one address.
- **This format is not backward compatible.** Codes over the previous
  24-character alphabet (`ACDEFHJKMNPRTWXY23456789`) are rejected as malformed by
  every current client and by the server.

## Envelope (every frame, both directions), JSON:
{ "type": string, "from"?: string, "to"?: string, "name"?: string,
  "ip"?: string, "peers"?: [{"id":string,"name":string}], "data"?: <any JSON>,
  "peer"?: string, "deviceId"?: string, "active"?: boolean }
- `type` ∈ { "join", "welcome", "peers", "left", "signal", "activate" }.
- Fields other than `type` are message-specific. The current server always
  includes `peers` on a `peers` frame, including `[]`.
- `deviceId` / `active` are **client→server only**, and only on `join`. The
  server never echoes either to anyone: the roster stays `{id,name}`, so no
  client can read or confirm another client's `deviceId`.
- `peer` is **server→client only** and appears only on `left`.

## LAN installation presence (optional, LAN room only)
One browser's tabs are one device, not several. Without this, every tab of a
phone appeared as its own identically named entry, so the other device could
pick one and have its request land on a page nobody was looking at.

- `deviceId` is an **opaque, rotating, client-derived** value: a digest of a
  random seed held only in that browser's local storage and a 24-hour epoch. The
  seed never leaves the device. It is NOT derived from an account, an IP address,
  a device name or any hardware/browser fingerprint, and two clients that merely
  share a name or an address are never merged.
- Shape: exactly **32 lower-case hex characters** (`signal.ValidDeviceID`).
  Anything else is rejected outright and treated as absent — an attacker-chosen
  string can never become a grouping key.
- **LAN room only.** In a pairing-code room the server ignores both fields, so
  two tabs of one browser pairing with each other remain two participants. This
  is enforced server-side, not merely by client convention.
- Omitting `deviceId` is legal and is what an older client, the CLI and the
  native clients do; such a peer stays a distinct device and keeps the roster
  shape below.
- `{"type":"activate"}` says "this connection is now the current/focused page".
  It carries no target and can only ever affect the connection it arrives on. It
  is charged to the same per-connection frame budget as a `signal` frame.
- `active:true` on `join` is the same statement for a page that is already
  current when it joins.

## Sequence
1. On open, the client sends `{"type":"join","name":<device nickname>}`, plus
   `"deviceId"` (and `"active"` when this page is the current one) in the LAN room.
2. Server replies `{"type":"welcome","name":<this client's peer id>,"ip":<server-observed public IP or "">}`.
   (The self peer id is carried in `name` on welcome.)
3. Server sends `{"type":"peers","peers":[{id,name},…]}` — this recipient's view
   of the room, and again whenever it changes.
4. To signal a peer: `{"type":"signal","to":<peer id>,"data":<opaque JSON>}`.
   The server relays it to that peer and stamps `from` = the sender's peer id.
   The client never sets `from`.
5. When a physical signaling connection closes, the server immediately sends
   `{"type":"left","peer":<departed peer id>}` to other devices in the room,
   followed by the updated roster. This event is distinct from a roster
   representative changing because the user focused another page: clients end
   sessions bound to `peer`, but preserve them across a roster-only handoff.

## Roster semantics
- The roster is **per recipient**: two peers in one room legitimately receive
  different lists.
- Connections sharing a `deviceId` are advertised as **one** entry, represented
  by the most recently activated page; with none activated, by the most recently
  joined one. When the representative leaves, the roster names a surviving
  sibling instead. Peers without a `deviceId` are each their own entry.
- Sibling tabs do not receive each other's `left` events. Other devices can
  receive a `left` for a peer id that is no longer (or is not currently) the
  advertised representative, because an established session may still be bound
  to that physical page after a focus handoff.
- A recipient that sent a `deviceId` is **not** shown its own installation's
  connections. A recipient without one receives the pre-existing shape, which
  includes itself; it filters its own id using the welcome.
- Entries are sorted by (name, id), so a roster never reshuffles between two
  broadcasts of the same membership.
- A current server always sends the `peers` array, including `[]` for an empty
  roster. For compatibility with older servers, clients MUST also treat an
  absent array on a `peers` frame as empty, never as "no change"; otherwise a
  departed peer can remain on screen.
- Broadcasts are debounced per room (200 ms, leading + trailing).

## Robustness
- Inbound frames are untrusted: a malformed / non-object / non-JSON frame is
  dropped, never crashes the receive loop.
- Sending on a socket that is not OPEN is a no-op (best-effort); a lost frame is
  re-aligned by the join/welcome/peers exchange after reconnect.
- `data` is never interpreted by the signaling layer.
