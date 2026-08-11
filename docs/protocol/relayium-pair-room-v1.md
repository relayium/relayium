# Relayium pairing-room pre-upload v1 (authoritative)

Code-first pairing lets the sender spend the wait for the other device by
uploading encrypted files against the pairing code instead of sitting idle. This
document is the contract: the server-side lifecycle of that ciphertext, the HTTP
surface, and the end-to-end message that hands the receiver the keys.

Layers on top of the stored-wire codec (`relayium-stored-wire-v1.md`) and the
stored HTTP transport (`relayium-cloud-transport-v1.md`). Nothing about the
ciphertext format changes: a pre-uploaded file is an ordinary stored object with
an ordinary encrypted manifest. What is new is what it is BOUND to, and when it
stops existing.

## The one invariant

**The server never receives a plaintext file, a filename, or a file key.** The
pairing room binds an opaque object to a rendezvous; the key travels only over
the peers' own end-to-end DataChannel (§4). There is no `#k=` fragment, no
server-side key column, and no code path that could accept one. A pairing code
is a rendezvous credential, never a key.

Consequence, accepted deliberately: **"upload and close the tab" is not
supported.** The sender's page holds the only copy of the key until the receiver
arrives.

## 1. Object kind

A pre-uploaded file is a stored object with `purpose = pair_room`, bound to one
pairing ROOM.

- One object per FILE, never per batch. A batch is several objects sharing a
  room. This is what makes "already uploaded files come from storage, files not
  yet started go over the live link" a per-file decision, and it is why **no
  single file is ever split across the two transports**.
- The room is an INSTANCE, not the six digits. Codes are recycled minutes after
  they expire; binding to the digits would let a reissued code reach the previous
  holder's ciphertext.
- Same machinery as a share: placement, daily quota, storage cap, traffic cap,
  max file size, plan retention cap, expiry, GC. Nothing about it is cheaper.
- Not a share: absent from `GET /api/files`, and `DELETE /api/files/{id}` does
  not reach it. Its lifecycle is the room's.

## 2. Lifecycle and timing

Let `open` be when the room was created (the first pre-upload for that code) and
`last` be the last time the server COMMITTED upload bytes for it.

```
joinDeadline = min( max(open, last) + JOIN_WINDOW , open + MAX_JOINABLE )
expiry       = joined ? NEVER : joinDeadline
joinable     = not closed and not joined and now < joinDeadline
readable     = not closed and now < expiry
```

| constant | value | what it is |
|---|---|---|
| `JOIN_WINDOW` | 300 s | the owner's rule: five minutes to join, measured from the last uploaded byte. The same 300 s the pairing code's registry TTL uses from the MINT — which is why the code has to be moved with the room rather than left to that TTL. |
| `MAX_JOINABLE` | 6 h | absolute ceiling from `open`. Without it `JOIN_WINDOW` is an idle bound the CLIENT chooses by trickling. |
| `NEVER` | — | a joined room's ciphertext has no expiry of any kind. Not a long deadline: none. |

Read the first line twice: the deadline is measured from the last accepted byte,
not from the mint and not from the upload's start. That single choice is both
halves of the rule — a ten-minute upload keeps pushing its own deadline out
instead of dying at T+5, and when the upload finishes the last chunk is the last
extension, so the final five minutes begin at completion.

**The CODE follows the room.** `joinDeadline` is the room's, in the database,
and the six digits live somewhere else entirely — in the signaling layer's
in-memory registry, where a minted code is valid for `JOIN_WINDOW` from the
MINT. Those are two clocks for one deadline, and the room's is the rule: opening
a room and every accepted committed append push the code's expiry out to the
room's current `joinDeadline`. Without that the room rule is unobservable — a
ten-minute pre-upload extends its ciphertext's life while the only credential
that can reach it dies at T+5, so nobody can join to collect it.

The synchronization is bounded by the same three things the room is, and by
nothing else:

- **Owner-bound.** Only the account that minted the code may move it. Digits are
  recycled minutes after they expire, so "who owns this room" and "who owns
  these six digits right now" are different questions and only the second one
  may extend a code.
- **Forward only, never a resurrection.** An extension can only push a deadline
  out, and a code that has already expired — swept or not — stays expired. A
  late progress report may not bring back digits that are free to be reissued.
- **`MAX_JOINABLE` is the ceiling.** The code is extended to `joinDeadline`,
  which already carries the six-hour bound, so trickling cannot buy the code
  more time than it buys the room. It is extended to the JOIN deadline even
  after a join, never to `NEVER`: a code that never expired would hold six of a
  million digits out of circulation for good, and buy nothing, because the room
  it names is full.

**Void revokes the code.** When a room is voided its code is REMOVED from the
registry, not left to expire on its own. The two happen to coincide today —
synchronization keeps the code's expiry at the room's join deadline — and that
coincidence is exactly what this does not depend on. A code that still validated
after its room was voided would admit a receiver to a rendezvous whose
ciphertext has already been deleted: six digits implying a transfer that no
longer exists. Revocation is owner-bound too, and refuses digits that have been
minted again since the voided room's own deadline, because a void can run long
after the deadline that caused it (the GC sweep is ten minutes behind).

**Joining ends every clock.** A joined transfer is never cut off by one, and
that is meant literally: there is no transfer deadline and no readability
deadline either. Nothing but an explicit completion lifecycle (delivery
confirmed / burn-after-download — NOT built), account deletion, or an operator
removes a joined room's bytes. That is an unbounded storage commitment per
joined room, which is exactly why pre-upload is off unless a deployment opts in.
The join is stamped exactly once — a reconnect does not re-stamp it.

**Void means gone, now.** Every truth-bearing read or write of a pair-room
object re-derives the room's liveness and, if the room is over, deletes the blob
and the row inline before answering. GC is a backstop for a room nobody touches
again; it is never what makes expiry true.

That covers the uploads still ARRIVING as well as the ones that finished. A
void enumerates every artifact bound to the room in one transaction — finalized
objects and upload sessions alike — and reclaims each: the partial blob goes,
the session stops existing, and the account's storage and open-session budgets
are free the moment the room is over rather than at the next generic reaper
pass. An unfinished pre-upload is the same ciphertext as a finished one.

**The join is observed by the server**, from the pairing code's signaling room
reaching two participants — never from a client claiming it. A client-asserted
join would be a free jump from a five-minute deadline to no deadline at all,
handed to the one party the deadline constrains.

The server's own observation is the only witness there is, so a join it cannot
write down is held in memory and retried — for as long as it takes — and while
it is held the room is not voided on a deadline that should already have
stopped. The hold has no expiry of its own: the observation was inside
`joinDeadline` when it was made, and `MAX_JOINABLE` passing afterwards is the
database being late, not the receiver. What bounds it instead is identity — the
retry targets the room INSTANCE, and a room opened after the observation is
refused — so a recycled code can never inherit another transfer's join.

## 3. HTTP

### 3.1 Upload (authenticated, resumable only)

```
POST   /api/uploads?purpose=pair_room&code=<6 digits>&size=<ciphertext bytes>
PATCH  /api/uploads/{uploadId}          Content-Range: bytes <start>-<end>/<total>
POST   /api/uploads/{uploadId}/finalize
GET    /api/uploads/{uploadId}                     → {"received": <int>}
```

- The init body is `uint32BE(len(encManifest)) || encManifest`, exactly as for a
  share.
- `code` must be a live pairing code **minted by the authenticated account**.
  Anything else is `403` — the same status for unknown, expired, malformed and
  someone else's, so the endpoint is not a code-validity oracle.
- Init response `chunkSize` is **1 MiB** for a pre-upload (8 MiB for everything
  else). Smaller on purpose: the deadline moves when a chunk COMMITS, so a single
  chunk that takes longer than `JOIN_WINDOW` to arrive would let the room expire
  underneath its own upload. 1 MiB clears 300 s at ~27 kbit/s.
- Retention parameters are **refused**, not ignored: `burnAfterRead`,
  `maxDownloads` or `ttl` on a pair-room upload is `400`. Retention here is the
  room's, and accepting a value we then override would describe an object the
  caller does not get.
- `POST /api/files` (single-shot) refuses `purpose=pair_room` with `400`. That
  route commits once, at the end, so a single-shot pre-upload big enough to be
  worth doing is big enough to outlive its own room — an explicit refusal beats a
  path that works for small objects and silently fails for large ones.
- Statuses: `403` no live owned code · `409` somebody already joined (send it
  over the live link instead) · `410` the room's deadline passed, its ciphertext
  is gone · `503` pre-upload unavailable on this deployment.
- An upload already in flight when the peer joins **is allowed to finish**. Only
  a NEW init is refused with `409`.
- A `410` can arrive on a PATCH or on finalize, not only on init: the room can
  end while a chunk is in flight, and the server refuses at the moment it finds
  out rather than letting the sender keep filling a blob no receiver can reach.
  The bytes that chunk carried are metered — they crossed the network — and the
  object is never created. Treat it as terminal for that file and fall back to
  the live link. Once the upload itself has been reclaimed (the room's void
  claims the session terminally and drops its blob), a further PATCH is `404`
  rather than `410`: there is no upload left to speak about.
  - The one exception to "metered", stated because it is real rather than
    because it matters much: a chunk that commits AFTER the void has terminally
    claimed the upload lands past an offset nothing may move, so it is not
    billed, and it can leave up to one append's worth of unreferenced bytes on
    the node until GC. Both are bounded by the resumable path's per-append cap;
    closing the window entirely would need a seal operation the node protocol
    does not have.
- Finalize returns `{"id": <string>, "expiresAt": <unix seconds>}`. `expiresAt`
  is the room's deadline, and it moves — treat it as a floor, not a promise.

### 3.2 Download (unauthenticated, zero-knowledge)

`GET /api/files/{id}/meta` and `GET /api/files/{id}/blob`, byte-identical to the
share path in `relayium-cloud-transport-v1.md`, including `Range` resume and the
possible `302` to a storage node.

**The receiver needs no account.** Holding the id (and the key the server never
saw) is the whole capability, which is exactly the share model — the id is a
server-minted random token that only ever travels inside the peers' encrypted
channel. A deadline that has passed is `404`, and asking is what deletes it.

## 4. Key handoff (`STORED_KEYS`, DataChannel kind 10)

The receiver learns which objects to fetch, and with which keys, from the sender
directly. This message is the only thing that carries a key, and it never leaves
the end-to-end channel.

### 4.1 Frame

`[kind = 10][seq: uint32 BE][sealed]`, sealed with the session key at that seq —
the same frame shape, seal and seq space as `BATCH_ENC`/`CHUNK`
(`relayium-realtime-wire-v1.md`). It is a sealed frame and MUST NOT be sent as a
plaintext control frame: the relay would then see the object ids, and an id plus
the ciphertext it already stores is most of a transfer.

**It MUST NOT travel over the signaling channel.** Signaling is relayed by the
server, and this message carries keys.

### 4.2 Payload (before sealing)

Compact JSON, UTF-8, key order as written:

```json
{"v":1,"items":[{"id":"<stored object id>","key":"<base64url key, no padding>"}]}
```

- `v` is `1` and is checked. An unknown `v` is a hard error, never a partial
  parse.
- `id` matches `^[A-Za-z0-9_-]{1,128}$` — the same rule every other client
  applies to a stored-object id, because it becomes a URL path segment.
- `key` is the stored-wire `#k=` encoding: base64url, no padding, decoding to
  exactly 32 bytes. Strict decode (`relayium-stored-wire-v1.md`): reject any
  character outside `[A-Za-z0-9_-]`, reject `length % 4 == 1`.
- `items` is non-empty, at most 256 entries, and ids within one message are
  unique. Filenames and sizes are NOT here — they are in each object's own
  encrypted manifest, fetched with `/meta`.

### 4.3 Capability gate

Announced as `preupload/1` alongside `text/1` and `link/1`, at the roster level
(`relayium-text-v1.md`) and in the SDP `caps` (`relayium-handshake-v1.md`).

**Never send kind 10 to a peer that has not announced `preupload/1`.** An unknown
kind is a hard error in every implementation — web, Swift and the Go CLI — so a
speculative send does not degrade, it fails the whole transfer. Exact match:
`preupload/2` is a different wire. A peer that never announced gets the ordinary
live-link path and nothing else.

### 4.4 Failure, retry, idempotency

The link can drop after the peer joined and before the handoff arrived, which
without a rule reads as "the receiver joined and then nothing happened".

- **Send it first.** The sender emits `STORED_KEYS` before any live-lane content
  on that link, so ordering can never strand it behind a long transfer.
- **Resend on every (re)established link.** Reconnect, ICE restart or a fresh
  session each re-send the full current set. There is no partial or incremental
  form.
- **The receiver dedupes by `id`.** Re-delivery of an id it already holds is a
  no-op — not an error, not a second download. Repeated delivery is therefore
  always safe, which is what makes blind resending correct.
- **No acknowledgement frame.** An ack would have to carry ids and would either
  leak them to the relay in plaintext or need a second sealed reverse seq space.
  Resending is cheaper and cannot get out of sync.
- **A receiver that never got a handoff MUST NOT claim success.** It reports that
  the sender left before handing over the keys. The objects then expire on the
  room's own deadline and are deleted; nothing is silently half-transferred.
- **A key that fails to decrypt its object is a hard error** for that item —
  never a fallback to an unencrypted path, which does not exist.

## 5. Metering

- **Every accepted byte is billed, from the first one**, against the uploading
  account's own plan: per committed append, not at finalize. A cancelled, failed
  or never-joined pre-upload is billed for exactly what moved.
- Finalize bills only the remainder that no append recorded, so a completed
  upload is charged exactly once.
- **A void bills what the blob really holds, then deletes it.** The database's
  offset is only as good as the last append that survived to record itself, so
  the reclaim asks the blob for its size before dropping it — that is the last
  moment anything can ask.
- **One case, and only this one, is written off: a timed-out room whose blob is
  on a node nobody can reach.** Elsewhere an unreadable blob is kept forever as
  accounting evidence, because `received` is a lower bound and settling against
  it underbills bytes the node really took. A room whose deadline passed cannot
  hold that position: the promise attached to that deadline is deletion, and
  "your encrypted file is still on a machine of ours because that machine is
  offline" is not a deletion. So the precedence inverts — known bytes stay
  billed, the blob is queued for deletion and retried, the session and its
  binding to the room stop existing, and the unknown residual (bounded by one
  append) is written off and logged. The rationale is account deletion's: an
  owner-required deletion outranks durable billing evidence, and the residual
  could never have been charged afterwards anyway.
- Download egress is billed to the SENDER (the object's owner), never to the
  anonymous receiver, whose identity is never read.
- Storage effectively never accrues: the object's whole life is bounded by the
  join deadline plus the transfer.
- This rule is load-bearing for §2's abuse argument. The only way to hold a code
  open past `JOIN_WINDOW` is to keep uploading, and uploading is billed —
  weakening the metering rule weakens the deadline rule with it.
  - Which is why `last` is the last COMMITTED BYTE and not the last request. A
    PATCH that commits nothing — an empty body at the committed offset, which
    costs the sender nothing and can be sent in a loop — is accepted, bills
    nothing, and renews nothing: it is answered from the room's current state
    without moving the deadline. Only bytes move it.
  - Finalize is the one renewal that carries no new bytes, because the owner's
    rule places the final five minutes at COMPLETION. It cannot be looped on one
    upload (the session is claimed terminally), and repeating it across fresh
    uploads is bounded by the thing that makes the argument work: every finalize
    reserves daily quota (at least `minBillableBytes`) and leaves a real object
    in the room.

## 6. What this does not change

- LAN transfer never uploads anything, in any mode.
- An ordinary share upload, its chunk size, its retention resolution and its
  public endpoints are untouched.
- A Device Inbox (`device_task`) object remains invisible on the public
  endpoints and is never handed to a node as a direct-download URL.
- A client that knows nothing about pre-upload keeps working: it never announces
  `preupload/1`, is never sent kind 10, never sends `purpose=pair_room`, and gets
  the live-link behaviour it always had.
