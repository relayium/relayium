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
  more time than it buys the room.
- **A JOINED room extends nothing.** Once somebody is in the room there is no
  join deadline left to extend a code to, and the code is simply left to lapse
  on whatever it already holds. It is never extended to `NEVER` — a code that
  never expired would hold six of a million digits out of circulation for good —
  and it is no longer extended to the join deadline either, which would keep the
  digits for another `JOIN_WINDOW` while buying nothing, because the room they
  name is full and its two peers are already connected. This is reachable by
  ordinary use, not only by a race: the protocol refuses a new upload INIT once
  someone has joined, but a file already in flight keeps appending and finalizes
  afterwards, and each of those used to extend the code.
  - The rule has one home in the implementation and every authoritative write
    answers with it — the touch (`PairRoomTouch.CodeDeadline`), the append
    (`UploadProgressResult.RoomJoinDeadline`) and the object insert
    (`StoredFileWrite.RoomJoinDeadline`) each report the row's own answer and
    `0` for a joined room, so no caller derives a deadline for itself. The one
    thing a caller may still project from is a room it CREATED an instant
    earlier, where the snapshot cannot be wrong.
  - **The database→registry handoff is two steps and stays that way.** The room
    is a row and the code is in the signaling layer's memory; the extension
    happens after the transaction commits, deliberately, so a credential can
    never claim a window the room does not hold. What that leaves open is the
    other order — a commit followed by a process death before the registry
    moves, i.e. a code SHORTER than its room. That failure is the safe one, it
    needs no distributed transaction to be acceptable, and it is bounded by the
    same fact this whole section already rests on: the registry is per-process,
    so the code dies with the process that would have extended it.

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
deadline either. Nothing but an explicit COMPLETION (§7), account deletion, or an
operator removes a joined room's bytes. A completion is a capability a receiver
spends, not a clock: it cannot fire on its own, no amount of time performs one,
and it therefore adds no deadline of any kind to this rule. Until a client
actually posts completions this remains an unbounded storage commitment per
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

### 3.0 Before the code exists: the pre-mint gate (B3)

Upstream of everything else in this document. A pairing code is only worth
minting if its owner can actually use one, and there is exactly one limit whose
exhaustion means they cannot:

```
POST   /api/pair                                   → 429 {"error": "traffic_exhausted"}
GET    /api/pair/preflight    (authenticated)      → {"allowed": <bool>,
                                                      "reason": <string, omitted when allowed>}
```

- **The question is the MONTHLY COMBINED TRAFFIC allowance, and nothing else.**
  Relayium's meter covers relay AND stored upload/download, so an account with
  none left has both cross-network paths closed to it: the live TURN session is
  refused by the relay's own gate and pre-upload by the stored gates. Six digits
  in that state name a rendezvous that cannot be completed by any route.
  **"None left" means `remaining <= 0`, exactly zero included**, and it means the
  same thing at all three gates — the pre-mint refusal, the TURN credential gate
  and room admission all ask one server-side helper, so the account that cannot
  mint a code also cannot be handed a relay credential or a room for one it
  minted a moment earlier. A gate asking instead whether N more bytes would
  *fit* answers "yes" at exactly zero for N = 0, which is the right answer to a
  different question and would leave this claim false by one byte.
- **Storage capacity and the rolling daily upload quota are deliberately NOT
  asked.** Both refuse an UPLOAD; neither touches the live relay. An account
  whose disk is full can still pair and still transfer in real time, so refusing
  to mint would invent a limit the product does not have. They keep their own
  refusals at the room-admission gates in §3.1 (`413`, `429`), where they are
  true. LAN is unaffected by all three, always.
- **`POST /api/pair` is the authority**, checked immediately before the registry
  mint, so a Web race and a CLI/bearer client are both covered. A refusal
  allocates NOTHING: no code, no registry entry, no room. Its body carries a
  stable machine-readable `error` because the same `429` is also the per-IP rate
  limiter's, and the two mean different things ("upgrade or use LAN" versus
  "slow down").
- **`GET /api/pair/preflight` is advisory**, so a client can stop offering the
  action instead of failing after a click. It mints nothing, reads no registry
  state and writes nothing; an anonymous caller gets `401` and learns nothing
  about anybody's usage. Both routes evaluate the SAME server-side function —
  clients must not re-derive the answer from `/api/me/usage`, which would put a
  second copy of the mid-month proration rule in the client.
- **Both FAIL OPEN.** Any read error admits the mint and answers `allowed`. An
  admitted mint buys no bytes and every byte that follows still passes an
  authoritative fail-closed gate, whereas failing closed would let one database
  blip stop everybody from starting a transfer.
- Backward compatible in both directions: a client that never calls the
  preflight is unaffected, and a client that calls it against a server without
  it gets `404`, which it must read as "no opinion".

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
    "no expiry" (§2), and a number a client counts down must be one the registry
    actually holds, so this is that one.
  - **Absent once the room is joined**, on both — the committed append, the
    overshoot ack and the probe alike. There is no instant left at which anybody
    may still join, which is the same `0` the code synchronization treats as
    "extend nothing" (§2). A client that had been counting one down simply stops
    hearing about it, which is correct: the peer it was waiting for has arrived.
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
spent either way; the transfer is not. The stored objects are not deleted, and
nothing reclaims them on a clock: the room is joined by then, so §2 leaves it no
deadline and §7.5 no fallback one, and that ciphertext is held until an operator
or account deletion removes it.

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
  that can never try and the objects stay in storage for good: the room is
  joined, so §2 leaves it no deadline and §7.5 no fallback one, and nothing but
  an explicit completion, an operator or account deletion ever removes them.
  A failure the receiver cannot survive by retrying (the ciphertext is gone; the
  key does not open its object) IS permanent, and must not be re-offered either —
  a retry there is a request with a guaranteed failure behind it.
- **No acknowledgement frame.** An ack would have to carry ids and would either
  leak them to the relay in plaintext or need a second sealed reverse seq space.
  Resending is cheaper and cannot get out of sync.
- **A receiver that never got a handoff MUST NOT claim success.** It reports that
  the sender left before handing over the keys. The objects are not deleted by
  that report and no clock deletes them either — the room is joined, so they are
  held until an operator or account deletion removes them (§2, §7.5) — but
  nothing is silently half-transferred.
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

## 7. Completion (the receiver's "I have it")

**Status: the LANE is complete end to end; production is OFF.** The server
accepts and checks completions, the Web sender records the capability, and the
Web receiver spends it — under the rules in §7.6, which are narrower than "after
a successful save". The two questions in §7.5 are still the owner's to answer,
and no other client posts one yet (the CLI and the native clients receive, and
do not complete). Nothing in this section is reachable on a deployment with
pre-upload off, which is every deployment today.

§2 says a joined room's ciphertext has no deadline. Completion is the other half
of that rule rather than a retreat from it: the thing that ends a joined
transfer is the receiver saying it has the file, and nothing else.

### 7.1 The capability

```
proof    = HKDF-SHA256(ikm = fileKey, salt = empty, info = "relayium-preupload-complete-v1", 32 bytes)
verifier = SHA-256(proof)
```

- `fileKey` is the object's own 32-byte stored-wire key — the one that travels
  only inside `STORED_KEYS` (§4) and that the server has never seen.
- The **sender** hands the server the `verifier` at finalize. The **receiver**
  derives the `proof` and posts that. The server hashes what it was sent and
  compares.
- The asymmetry is the point. The verifier is all the server, its database and
  its backups ever hold, and it yields neither the proof (so a stolen database
  cannot complete anybody's transfer) nor the key (so zero-knowledge is exactly
  what it was). HKDF rather than a bare hash of the key, so the value cannot be
  replayed into any other context that hashes the same key; the info string is
  the domain separator and changing it is a wire break.
- The info string is exact ASCII with no trailing NUL, and both implementations
  are pinned to one frozen key/proof/verifier vector
  (`server/account/pairroom_complete_test.go`,
  `web/src/lib/store-crypto.completion.test.ts`). Empty salt: HKDF's salt is
  optional, and Go's nil salt and WebCrypto's zero-length salt derive the
  identical PRK.
- **Neither value may appear in a URL, a query string or a log.** The proof is a
  bearer capability to delete an object, so it travels in a request body only.

### 7.2 Recording it (sender, at finalize)

```
POST /api/uploads/{uploadId}/finalize
{"completionVerifier":"<base64url, no padding, decoding to exactly 32 bytes>"}
```

- **Optional, and additive in both directions.** No body — which is what every
  client before this sent — stores NULL and yields byte-for-byte the object it
  always did. A client that sends one to a server predating this has it ignored.
- **`pair_room` only.** The field on a `share` or `device_task` finalize is
  `400`, refused rather than stored and ignored: neither has anything for a
  receiver to end.
- Strict: standard-base64 characters, padding, whitespace, and any decoded
  length other than 32 are `400`. So are malformed JSON, trailing JSON after the
  object, and a non-string value. Unknown fields are allowed through, so the body
  stays extensible.
- **Both completion bodies — this one and §7.3's — are bounded at 1 KiB
  INCLUSIVE.** Exactly 1024 bytes is read and judged on its merits; the first
  byte past it is a `400`, whatever it is and whatever preceded it. The bound is
  on the body, not on the prefix the server read: a valid object followed by
  padding that crosses the bound is refused rather than accepted on its first
  kilobyte, because the "nothing may follow the object" rule and the length rule
  are both read off the same end-of-body and a bound that truncated would forge
  it. No client is anywhere near this — one 43-character token in a small object.
- **The refusal is taken BEFORE the terminal claim.** Finalize is once-only, so a
  `400` after the claim would turn one malformed field into an upload that can
  never be finalized at all. A refused finalize is retryable.
- The verifier is written in the SAME statement that inserts the object row, on
  every storage-placement path. There is no window in which an object exists
  without the capability its sender asked for — one would be unreachable by the
  only thing that can end it, and no repair pass could invent the value.

### 7.3 Spending it (receiver)

```
POST /api/files/{id}/complete
{"proof":"<base64url, no padding, decoding to exactly 32 bytes>"}
```

Unauthenticated, like `/meta` and `/blob`, and for the same reason: the receiver
has no account. The proof IS the authorization. `Cache-Control: private,
no-store` on every answer, and the same per-IP download-start budget the blob
route spends.

| status | meaning |
|---|---|
| `204` | the proof was right and the object is gone — **and, identically**, there was nothing to complete: already completed, never existed, or not a pair-room object. |
| `409` | a live pair-room object with no completion capability at all (an older sender). |
| `403` | wrong proof. Nothing was deleted. |
| `400` | malformed body or proof. |
| `429` | the per-IP budget is spent. |

- **The `204` is deliberately one answer for four situations.** Separating them
  would make an unauthenticated endpoint an existence oracle over the whole
  stored-object space. It is also what keeps `share` and `device_task` objects
  out of reach: the purpose test is part of the same statement that finds the
  row, so no completion can touch one, whatever verifier it happens to carry.
- **`409` is not `403`.** A receiver told "wrong proof" will keep deriving proofs
  from the key it holds, and no proof it can produce will ever work on an object
  that has no verifier. The two must be distinguishable for a receiver to report
  anything true.
- The comparison is constant-time and happens INSIDE the transaction, so two
  receivers racing — or one retrying an answer it never saw — cannot both act on
  one verdict. Both get a safe `2xx`; exactly one removal happens.

### 7.4 What a completion does

In one transaction, in this order:

1. the blob's durable delete intent is queued (held past the first success, like
   a void's — see §2), **before** anything is removed;
2. the authoritative `stored_files` row is deleted, which is what releases the
   owner's storage immediately — not a later sweep, and not the node answering;
3. if that was the last object AND no upload session remains AND the room is
   **joined**, the room is closed too.

Physical blob deletion is bounded best-effort AFTER the commit. A node that is
unreachable costs only promptness: the intent is older than the attempt, so GC
keeps asking. Intent-first is the whole crash-safety argument — deleting the row
removes the only other thing pointing at the blob, so the responsibility has to
exist first.

**An UNJOINED room is never closed by a completion**, however empty it becomes.
Nobody has arrived yet, so more files of the batch may still be on their way;
closing would refuse them and strand a sender mid-batch. An unjoined room is
ended by its deadline, exactly as §2 says.

**A room with an upload still in flight is not empty.** §3's promise that an
in-flight upload may finish outranks the tidiness of closing early.

**Reading never completes.** `/meta`, a full `/blob`, a `Range` resume and an
overlapping retry of one all leave the object exactly where it was. Completion is
something a receiver SAYS; it is never inferred from bytes leaving the building,
because a resume that looked like a finish would delete ciphertext mid-transfer.

**GC hygiene.** A joined room that ends up holding nothing — the last object
completed while an upload was still in flight, and that upload then abandoned
rather than finalized — is reachable by ordinary use and can be closed by neither
a deadline (a joined room has none) nor a completion (there is nothing left to
complete). A sweep closes such rooms after a grace period long enough that
"holds nothing" is settled rather than momentary.

### 7.5 What is deliberately NOT decided here

- **A decline is not a completion.** A receiver that refuses the batch has not
  taken delivery, and treating the two the same would delete a sender's
  ciphertext on the strength of a user saying "no thanks".
- **There is no fallback expiry.** What becomes of a joined room nobody ever
  completes is an open owner decision. Inventing a timer to stand in for one
  would be exactly the reinterpretation of §2 that this document already refused
  once: a rule the code reinterprets is not the rule.
- Until those are answered, pre-upload stays off. The Web receiver now posts
  completions (§7.6), so the lane no longer has a *missing* half — but a room
  nobody completes still has no end, and §7.6 is explicit that a large class of
  browsers (Firefox, Safari, every phone) can never honestly complete at all.
  Both are reasons the flag is still a rollout decision rather than a switch.

### 7.6 When a receiver may spend it

A completion deletes the only remaining copy of the ciphertext, and the deletion
is not reversible. So the rule is not "the save succeeded" — it is **"this
device has taken delivery, and nothing between here and the user's disk can
still fail."** The two errors are not symmetric, and every ambiguity below
resolves the same way:

- Not completing costs the SENDER storage — and §2 means it: a joined room has
  no deadline and §7.5 has not given it a fallback one, so an object nobody
  completes is held until an operator or account deletion removes it.
- Completing early costs the USER the file, permanently.

Both sides are unbounded, which is why the second one decides. Storage the owner
can price, measure and reclaim by hand is not the same kind of loss as a file
that no longer exists anywhere.

**A save destination MUST declare which of two things its commit means.** The
Web models this as `SaveTarget.delivery` (`web/src/lib/filesink.ts`), and the
distinction is about the destination, not about how well the transfer went:

| destination | commit means | may complete |
|---|---|---|
| File System Access writable ("Save As"), or a chosen directory | the bytes are in the file the user picked; nothing further can fail | **yes** |
| in-memory Blob downloaded per file, bundled ZIP, service-worker stream | the bytes were handed to the BROWSER — an `<a download>` click or a stream | **no** |

A browser handoff can still fail out of the client's sight: a full disk, a
download the user cancels from the download shelf, a tab the system reclaims, a
service worker replaced mid-stream. The receiver never learns, so it must not
speak for it. **The default for a destination that does not say is the weak
one** — silence must not be read as a promise.

That table also says plainly who this feature reaches: today only desktop
Chromium-family browsers have the File System Access API, so a Firefox, Safari
or phone receiver saves its files perfectly and completes nothing. Their
senders' ciphertext is then in exactly the position every joined room is in
today: §2's unbounded commitment, with no completion ever coming for it.

**The boundary is the whole batch, then the object.**

- A **bundled** destination (one ZIP for the batch) delivers nothing until its
  finalise step. No proof of any object in it may be spent before that step
  succeeds, and if the batch fails, none may be spent at all.
- A **per-file** destination commits as each file closes. An object's proof may
  be spent once **every file of that object** is committed — and not before,
  because the object is one ciphertext stream and a completion mid-stream would
  delete what the transfer is still reading.
- A batch that fails partway on a per-file destination MAY complete the objects
  that finished, and MUST NOT complete the one that did not: the receiver is
  about to ask for that ciphertext again.
- **A decline never completes**, and neither does a cancelled save picker. See
  §7.5.

**A failed completion is not a failed transfer.** Once the files are on the
disk, the completion is bookkeeping the user is not waiting for. A receiver
therefore holds it as SEPARATE state from the transfer, and:

- MUST NOT re-fetch or re-write anything because a completion failed. The bytes
  are already on the disk; a second attempt would put a second copy beside them.
- MUST NOT report it to the user as a transfer failure. Nothing failed.
- SHOULD retry `retry`-class answers (network, 5xx, 429) **boundedly** — the Web
  makes three attempts over about nine seconds — and MUST NOT retry `204`,
  `409`, `403` or any other terminal answer. Retrying is safe because `204` is
  idempotent by construction (§7.3): an attempt whose answer was never seen can
  be repeated without consequence.
- MUST abandon everything pending when the room ends. A proof posted after the
  user has left is spent from a pairing they are no longer in, and possibly
  while a different one is on screen. Ending ONE batch — a decline, a dismissal
  — is not that event, and must not cancel a completion belonging to a batch
  that was already delivered.

**Neither the key nor the proof may be persisted.** Both live only as long as
the room, in memory, and neither may reach a URL, a log or a bug report. The
pending-completion state in particular should hold the derived PROOF and not the
file key — that state outlives the batch's own card on purpose, and it must not
be the reason something that can still decrypt an object is kept alive. A proof
can only end that object's life.

**No UI state is added for any of this.** The user's card says what it said —
the files were saved — because that is what happened. A "finishing up" state
would invite the reading that the save is not final yet, which is the opposite
of the truth, and a failure notice would report a problem the user has neither
suffered nor any way to act on.
