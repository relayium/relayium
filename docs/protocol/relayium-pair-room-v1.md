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
                                                   → {"received": <int>,
                                                      "expiresAt": <unix seconds>}
POST   /api/uploads/{uploadId}/finalize
GET    /api/uploads/{uploadId}                     → {"received": <int>,
                                                      "expiresAt": <unix seconds>}
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
  is the room's deadline, and it moves — treat it as a floor, not a promise. It
  is the object's EXPIRY (so it is "no expiry" once somebody has joined), unlike
  the append's and the probe's, which are the room's JOIN deadline.
  - Same read-never-project rule, and it decides more here than a response: the
    deadline the object is STORED with comes from the room's row inside the same
    transaction that inserts it. Finalize records the room's final progress
    first, and a sibling request can move the room between that and the insert;
    an object built from the room as this request last saw it would be the one
    file in the batch that expires early, with nothing left to repair it, and the
    response would under-report the window the code registry is still admitting
    joins for.
- **`expiresAt` on the append and on the status probe.** Both 200s carry the
  room's JOIN deadline — the instant after which nobody may still join, which is
  exactly what the pairing code's own registry entry is extended to. It is an
  ADDITIVE field on the two responses a pre-upload already makes, not a new
  endpoint and not a new request: there is nothing to poll and nothing to ask.
  - Present only for `purpose=pair_room`. An ordinary upload has no room, no
    code and no such instant, and its responses are byte-for-byte what they were.
  - It is the JOIN deadline, never the room's expiry. A joined room's expiry is
    "no expiry" (§2); the code is extended to the join deadline and never to
    never, so this is the number a client may count down.
  - A request that commits NO bytes — a resume overshoot, or the probe, which is
    a plain read — reports the deadline the room already has. It does not buy
    one. Nothing free may move the window (§2).
  - **It is READ, never projected.** The number is whatever the room's row holds
    where the response is produced: for an append, inside the same transaction
    that records the progress; for the overshoot ack and the probe, a store read
    taken as the answer is written. Requests for one room overlap by design — a
    lost answer is retried, and a batch uploads its files at once — so a server
    that instead recomputed the deadline from the room it read on the way in
    would report a window a sibling had already replaced, and a client counting
    that down announces a dead code while the registry is still admitting joins.
    A consequence worth stating: what a client is told may be a deadline it did
    not buy, bought by another of its own requests.
  - **Forward only, per room.** Deadlines only ever move outwards (§2), so an
    answer older than one already held is not news — two overlapping requests can
    land out of order. Clients keep the LATER of the two and must not let a
    response pull a window in.
  - The probe reports nothing at all for a room that is over: a deadline in the
    future computed from a room whose ciphertext has been reclaimed is an
    invitation to a rendezvous the server has emptied. The append's own `410`
    remains the authority on that.
  - **Clients must treat it as optional.** A server that predates it answers
    exactly as before, and a client that sees no field has learned nothing —
    which is not the same as learning that the room is over.

### 3.2 Download (unauthenticated, zero-knowledge)

`GET /api/files/{id}/meta` and `GET /api/files/{id}/blob`, byte-identical to the
share path in `relayium-cloud-transport-v1.md`, including `Range` resume and the
possible `302` to a storage node.

**The receiver needs no account.** Holding the id (and the key the server never
saw) is the whole capability, which is exactly the share model — the id is a
server-minted random token that only ever travels inside the peers' encrypted
channel. A deadline that has passed is `404`, and asking is what deletes it.

## 4. Key handoff (`STORED_KEYS`, DataChannel kind 12)

The receiver learns which objects to fetch, and with which keys, from the sender
directly. This message is the only thing that carries a key, and it never leaves
the end-to-end channel.

### 4.1 Frame

`[kind = 12][seq: uint32 BE][sealed]` — the same frame SHAPE as
`BATCH_ENC`/`CHUNK`, on the same DataChannel, but with its own key and its own
sequence.

**Corrected from kind 10 (and from the session key) while checkpoint 2b wired
it.** Both halves of the original text were wrong, and each would have been a
release blocker:

- **Kind 10 was not free.** `relayium-realtime-wire-v1.md`'s kind list omitted
  the two transport-fragmentation kinds, and 10/11 have been
  `CHUNK_PART`/`BATCH_PART` on the wire since fragmentation shipped, in the Web
  client and in the Swift port alike. A handoff sent as kind 10 would not have
  been a new frame: the file receiver would have authenticated it in sequence as
  a chunk fragment and spliced a JSON list of object ids and keys into the
  middle of somebody's file. The registry now lists 10/11 explicitly.
- **The session key's seq space has exactly one producer, and this is a second
  one.** It is emitted on link establishment, again on every transport rebuild,
  and again whenever another upload lands — none of which is the batch pump.
  Sharing that counter is the shape AES-GCM nonce reuse takes, and it is the
  hazard `text/1` already answered by deriving a separate key. So STORED_KEYS
  seals under `preuploadSend`/`preuploadRecv` (domain `relayium-preupload-v1\0`,
  derived per direction exactly like the text keys) with its own counter from 0.
  That independence is also what makes §4.4's "re-send on every (re)established
  link" implementable: the frame never has to be ordered against a batch in
  flight, a pre-consent guard, or a resume realignment.

**Sequence rule: forward-only, not gap-free.** There is no resume for this
stream, and none is needed — the sender always re-sends the whole set — but the
receiver MUST NOT demand the exact next seq.

- A seq at or below the last one CONSUMED is refused. That is a replay of a key
  list, whether it is an attacker re-injecting a frame or a burned one arriving
  late.
- A seq AHEAD of the expectation is accepted if, and only if, it opens under the
  receiving key. The receiver then sets its expectation to that seq + 1.
- The expectation moves as soon as the frame OPENS, and MUST NOT wait for the
  payload to decode. A frame that authenticated was authored by the peer, and
  its seq is already spent on the sending side whatever this side thinks of the
  bytes inside: the sender takes the number synchronously, before it seals, and
  can never reuse it — the seq is the AEAD nonce. There is therefore no "retry
  at the same seq" to leave room for; a re-send is always a NEW frame at a NEW
  number. Holding the expectation back for a payload that was refused protects
  nothing and leaves that exact authenticated frame replayable for the life of
  the link.
- A frame that FAILS to open moves nothing. It was not authored by the peer, so
  it says nothing about what the peer has sent, and advancing on one would let
  anyone who can put bytes on the channel push the receiver past the number the
  real frame is carrying.

The gap is not hypothetical and it is not attacker-induced: the sender takes its
seq SYNCHRONOUSLY and seals asynchronously, so a transport replacement, a
superseded link generation or a `send()` that throws destroys a frame whose
number is already spent. The counter can never be rolled back to reclaim it —
the seq is the AEAD nonce, and reusing one under the same derived key for a
different payload is the exact failure this stream's separate key exists to
prevent. So the hole is permanent, and the receiver is what absorbs it.

A receiver that insisted on the exact next seq would turn one such event into a
permanently wedged stream: every later whole-set resend refused, the sender
believing it handed the keys over, and the receiver waiting for a prompt that can
never arrive — with §4.4's resend rule, the very thing meant to RESCUE a dropped
handoff, becoming the thing that can never succeed again.

Tolerating a forward gap concedes nothing. The frame still has to open under a
key derived from the peers' own session secret, so a gap admits nothing an
attacker can author; all it costs is that a key list this side never saw is never
seen, which the unconditional resend already covers.

It is a sealed frame and MUST NOT be sent as a plaintext control frame: the relay
would then see the object ids, and an id plus the ciphertext it already stores is
most of a transfer.

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

**Never send kind 12 to a peer that has not announced `preupload/1`.** An unknown
kind is a hard error in every implementation — web, Swift and the Go CLI — so a
speculative send does not degrade, it fails the whole transfer. Exact match:
`preupload/2` is a different wire. A peer that never announced gets the ordinary
live-link path and nothing else.

**And the sender must have somewhere to put the files it already uploaded.**
Pre-upload happens while the room is still waiting, so the sender cannot know who
will join. When the joiner turns out not to announce `preupload/1`, its objects
are unreachable ciphertext: the keys can never be delivered, and an entry left in
the "already uploaded" state is sent over neither transport — the user simply
never sees the file arrive. The sender therefore returns those entries to the
live-link lane at the moment it drains the batch for that peer. The bytes are
spent either way; the transfer is not. The stored objects are not deleted — their
life is the room's, and §2's deadline reclaims them.

**That fallback is only real if the gate in front of it is peer-specific.** The
condition every send decision tests MUST be "how many entries does the live link
owe THIS peer" — the entries that were never uploaded, PLUS the uploaded ones
when the peer cannot be handed keys. Testing the peer-independent question
("what would a drain return right now") reintroduces the whole failure in two
places, and both are the ordinary case rather than an edge:

- a batch that finished uploading before anyone joined has NO entries in the
  never-uploaded state, so the gate never opens, the drain is never reached, and
  the fallback inside it is dead code for exactly the situation it exists for;
- an upload that was still in flight when the peer joined is allowed to finish
  (§3), and completing it moves an entry OUT of the never-uploaded state — so a
  gate on that count sees the number go down and stays shut while the peer is
  already present and already known not to speak `preupload/1`.

An entry whose bytes are still moving is in neither answer: it belongs to the
upload that is still allowed to finish, and counting it would open the gate onto
a batch with no files in it.

### 4.4 Failure, retry, idempotency

The link can drop after the peer joined and before the handoff arrived, which
without a rule reads as "the receiver joined and then nothing happened".

- **Send it first.** The sender emits `STORED_KEYS` before any live-lane content
  on that link, so ordering can never strand it behind a long transfer.
- **Resend on every (re)established link.** Reconnect, ICE restart or a fresh
  session each re-send the full current set. There is no partial or incremental
  form.
- **The receiver dedupes by `id`, on the OUTCOME and not on the offer.** An id it
  has DELIVERED, and an id the user has DECLINED, are permanent no-ops — not an
  error, not a second prompt, not a second download. An id that merely FAILED in
  a way a second attempt could survive is NOT in that category, and must be
  accepted again from the next resend. Claiming an id the moment it is offered
  looks like the same rule and is not: it makes one transient failure — a single
  5xx, one dropped socket — permanently disable the retry the sender is
  faithfully performing on every reconnect, so the receiver shows a "try again"
  that can never try and the objects sit in storage until the room deletes them.
  A failure the receiver cannot survive by retrying (the ciphertext is gone; the
  key does not open its object) IS permanent, and must not be re-offered either —
  a retry there is a request with a guaranteed failure behind it.
- **No acknowledgement frame.** An ack would have to carry ids and would either
  leak them to the relay in plaintext or need a second sealed reverse seq space.
  Resending is cheaper and cannot get out of sync.
- **A receiver that never got a handoff MUST NOT claim success.** It reports that
  the sender left before handing over the keys. The objects then expire on the
  room's own deadline and are deleted; nothing is silently half-transferred.
- **A partial failure is reported as partial.** "All or nothing" is the rule for
  what the receiver CLAIMS, not a description of what a disk contains: on a save
  target that flushes each file as it closes (a chosen folder, per-file browser
  downloads), a batch that stopped on its third object really did leave the first
  two behind. Reporting "nothing was saved" there tells the user they have none
  of it while they have half a folder — so they neither clean it up nor expect
  the retry to land beside it. A target that only delivers on finalisation (the
  ZIP branch assembles the archive at the end) is the opposite case and saved
  nothing at all, however many entries it accepted. The receiver states which of
  the two happened, and it never re-downloads an object it has already written.
- **A key that fails to decrypt its object is a hard error** for that item —
  never a fallback to an unencrypted path, which does not exist.
- **Leaving the room cancels everything already in flight.** A manifest fetch, an
  open save picker and a running download are each a window in which the user can
  leave, decline, or be handed a different room, and every one of those
  continuations still holds live keys and a save target. A receiver MUST make
  them inert rather than let them resume: otherwise a previous pairing's files
  are written after the user left it, a declined batch is written because the
  picker was already open when the answer came, or a stale resolve publishes its
  file list over the batch a NEW room is showing — so the user accepts one set of
  names and receives another.

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
  `preupload/1`, is never sent kind 12, never sends `purpose=pair_room`, and gets
  the live-link behaviour it always had — including the files a pre-uploading
  peer had already put in storage before it joined (§4.3).
