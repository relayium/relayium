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
joinedExpiry = max( max(joined, last) + RETENTION , joinDeadline )
expiry       = joined ? joinedExpiry : joinDeadline
joinable     = not closed and not joined and now < joinDeadline
readable     = not closed and now < expiry
```

| constant | value | what it is |
|---|---|---|
| `JOIN_WINDOW` | 300 s | the owner's rule: five minutes to join, measured from the last uploaded byte. The same 300 s the pairing code's registry TTL uses from the MINT — which is why the code has to be moved with the room rather than left to that TTL. |
| `MAX_JOINABLE` | 6 h | absolute ceiling from `open`. Without it `JOIN_WINDOW` is an idle bound the CLIENT chooses by trickling. |
| `RETENTION` | 86400 / 259200 / 604800 / 1209600 s | the ACCOUNT PLAN's retention window — Free, Plus, Pro, Max — **snapshot when the room opened** and never re-read for that room again. |

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
  on whatever it already holds. It is never extended to `joinedExpiry` — a code
  living out a plan retention window would hold six of a million digits out of
  circulation for days —
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

**Joining ends the JOIN clock, and starts the retention one.** *(Changed
2026-08-20 by an explicit owner decision. Earlier revisions of this document said
a joined room's ciphertext had no expiry of any kind — see "What replaced NEVER"
below for why that is retired and what was kept.)*

A joined transfer is still never cut off mid-flight, and that is still meant
literally. What ends a joined room now is one of four things:

1. an explicit COMPLETION the receiver spends (§7);
2. an explicit RELEASE the owning account asks for, one room at a time (§8);
3. the account being deleted;
4. `joinedExpiry` passing — the account plan's retention window, measured from
   the last thing that actually happened to the room.

The first three are unchanged and are still things somebody DOES: a completion
cannot fire on its own and no amount of time performs one, and a release happens
only because the owner named that room, by id, in a request. There is still no
operator endpoint that removes a joined room.

**What replaced `NEVER`, and what survived it.** All stored Relayium ciphertext
follows the account plan's retention, and a pair-room object is stored
ciphertext. The previous rule made it the one exception, and the exception was
not theoretical: production accumulated four current-Free objects sitting at
`math.MaxInt64`, days past the single day their account was entitled to, with
nothing in the system that could ever have reclaimed them.

The half of the rule that mattered is kept, and it is kept by the MEASUREMENT
rather than by the absence of a clock:

- `joinedExpiry` is measured from `last` — the last time the server itself
  COMMITTED bytes for the room. A slow upload that is still landing chunks buys
  itself another full retention window with every one, so it is never cut off
  while it is still moving. Only the server's own committed bytes move it: a
  read, a probe, a reconnect, a duplicate join notification and a refused upload
  init all move nothing, so it is not a deadline a client can extend by asking.
- `joined` is the floor for a room joined before its first chunk commits.
- `joinDeadline` is a second floor, so joining can never move a room's expiry
  BACKWARDS. It cannot with today's numbers — every plan's retention is far
  longer than `MAX_JOINABLE` — and it is stated so that pricing a very short plan
  cannot silently break the projection.

**The snapshot does not follow the plan.** `RETENTION` is read once, when the
room opens, and written onto the room. A later upgrade or downgrade governs the
NEXT room and never reaches backwards into ciphertext already stored: a transfer
uploaded on Pro keeps its seven days even if the account moves to Free an hour
later, and a Free room does not grow into Max's fortnight because the account
upgraded afterwards. A failed plan read at creation falls back to the LONGEST
window any plan sells — bounded, never unbounded.

What that leaves is a storage commitment bounded by a number the account is
already billed under. A room whose receiver cannot complete (§7.6 — every
Firefox, Safari and phone receiver is in that class) is now reclaimed at its plan
deadline instead of sitting until somebody releases it. Pre-upload remains off
unless a deployment opts in; that gate is unchanged by this, and is now a product
decision rather than the price of a rule the server could not hold.
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
join would be a free jump from a five-minute deadline to the account's whole
retention window, handed to the one party the deadline constrains.

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
  is the object's EXPIRY (so it is `joinedExpiry` once somebody has joined),
  unlike the append's and the probe's, which are the room's JOIN deadline.
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
    a retention window measured in days (§2), and a number a client counts down
    must be one the registry actually holds, so this is that one.
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
live-link lane. The bytes are spent either way; the transfer is not. The stored
objects are not deleted by this path: the room is joined by then, so §2 gives it
the account's retention window. That ciphertext is
held until that window runs out, until the owner releases the room (§8), or until
the account is deleted — a
completion is not coming for it, because the peer that would have spent one never
learned the keys.

**That return is one-way, so "has not announced yet" is NOT "cannot take keys".**
The two facts arrive as two different frames and the ROSTER ALWAYS WINS: the frame
that first names a peer is also where a client announces TO it, and that peer's
own hello is produced by its own roster handler and has to travel back across the
relay. A sender that answers the capability question at the instant it drains the
batch therefore answers it a full round trip early, every time — so the ordinary
case (a batch finished uploading before anyone joined, and a current peer joins)
released the keys and re-sent the whole batch over the live link, leaving stored
ciphertext that only a manual release can remove. This is not a rare interleaving;
it is what the ordering produces whenever the drain is not held up by something
else, such as a sender-side verification step.

So an already-uploaded entry has THREE states, not two, and the sender must not
collapse them:

| lane | when | what owns the entry |
|---|---|---|
| keys | the peer announced `preupload/1` | the handoff (§4.1) |
| live | the peer announced without it, or will never announce | the live link; the return above runs |
| wait | no announcement yet, and one is still expected | nobody — hold, release nothing, send nothing |

**A `wait` peer must be treated as capable for the purpose of the return, and as
incapable for the purpose of the frame.** Holding costs a moment; releasing costs
the handoff permanently. The kind-12 gate at the top of this section is unchanged
and stays exact: an undecided peer is never sent a frame it might not parse.

**A batch that holds pre-uploaded entries waits as a batch.** Letting the
never-uploaded half through while the rest is undecided splits one user action
across two transports and two consent prompts, and — because the first half
occupies the peer — can leave the second half with no link to hand keys over and
no control that could reach it. A batch with nothing uploaded is untouched by any
of this and behaves exactly as it did before pre-upload existed.

**What ends `wait` is the announcement.** Every implementation that can join a
room announces at the roster level, on join and on roster change
(`relayium-text-v1.md`), so a real peer resolves one signalling round trip after
the roster names it — on an event, with no clock. A bounded backstop is still
required, because silence and lateness are indistinguishable by any other means:
there is no acknowledgement frame (§4.4 says why one must not exist), and a peer
with no capabilities never opens a link whose establishment could stand in for the
answer. Implementations SHOULD reuse their existing "we signalled this peer and it
never replied" bound rather than introduce a second number; the Web client uses
its link-request timeout. Reaching that bound costs a delayed live fallback.
Never reaching it would cost the batch.

A peer the roster stops naming settles to `live` at once rather than waiting the
bound out: nothing more is coming from it, and a peer that never announced holds
no link either, so no working connection's answer is being discarded. Conversely
an announcement already heard MUST survive the roster pruning that peer away — a
peer's signalling socket can drop while its data channel keeps carrying files, and
re-reading that as "never announced" spends the handoff on a peer that is still
connected and still capable.

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
  that can never try and the objects stay in storage: the room is joined, so §2
  gives it the account's retention window, and nothing but that window running
  out, an explicit completion, the owner's own release (§8) or account deletion
  ever removes them.
  A failure the receiver cannot survive by retrying (the ciphertext is gone; the
  key does not open its object) IS permanent, and must not be re-offered either —
  a retry there is a request with a guaranteed failure behind it.
- **No acknowledgement frame.** An ack would have to carry ids and would either
  leak them to the relay in plaintext or need a second sealed reverse seq space.
  Resending is cheaper and cannot get out of sync.
- **A receiver that never got a handoff MUST NOT claim success.** It reports that
  the sender left before handing over the keys. The objects are not deleted by
  that report — the room is joined, so they are held until its retention window
  runs out, or until the owner releases the room or the account is deleted (§2,
  §7.5, §8) — but nothing is silently half-transferred.
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

### 4.5 Sender authorization (when a confirmation stands in front of the batch)

§4.4's "send it first" is an ORDERING rule about a handoff that is already
allowed to happen. It is not permission, and an implementation that reads it as
permission has a disclosure rather than a bug.

A client MAY put a sender-side confirmation in front of a batch — the Web client
does, in a code room with advanced verification on, because a joiner who guessed
a live code is exactly who the pairing code cannot exclude, and the remedy it
offers is "compare the verification code before you send". **Where such a
confirmation exists, it MUST gate the key handoff too, and it must gate it at the
emission and not at the button.**

The reason it does not gate itself is the shape of the two mechanisms:

- the confirmation holds a BATCH, and the handoff is not in that batch. It is a
  frame on the link, emitted from link establishment;
- a link exists as soon as the workspace is opened — and opening it is the only
  way the code the user is being told to compare gets on screen. So the frame the
  confirmation is supposed to hold rides the very step that makes the
  confirmation answerable;
- an inbound link the peer builds itself goes through no local control at all.

The consequence of missing this is not symmetrical with a live batch. A live
batch still faces the receiver's own accept step; keys face nothing — the
ciphertext is already on a server that will serve it to whoever presents the
object id, so an emission IS the disclosure. Note also that the earlier, broken
form of §4.3 masked this: a sender that released the uploaded entries to the live
lane one round trip early had nothing left for the handoff to name, so a
deterministic §4.3 is what makes this rule load-bearing rather than theoretical.

The rules:

1. **The emission asks, and asks late.** The set MUST be pulled at emission time
   (§4.4's whole-set rule already requires a pull rather than a remembered
   partial), and the authorization MUST be read in that same pull, for the peer
   the frame is addressed to. A decision cached by whoever scheduled the frame is
   a decision about a world that may no longer exist: an emission can sit behind
   another one's seal for as long as that seal takes.
2. **Re-read at the wire boundary, as a SET.** Immediately before a sealed frame
   enters the channel, the pull MUST be repeated and the answer MUST be the very
   set the frame was sealed from — every id, every key, in the frame's order. A
   frame carries the set as it was, so anything weaker is a frame that may
   describe a world that has since moved: an authorization withdrawn mid-seal, an
   entry released to the live lane (§4.3) and a different one finalized in its
   place, an entry removed. A count in particular is NOT sufficient — one item
   sealed, that item released, a different one finalized leaves the count
   unchanged and hands the peer a key to ciphertext the live lane is now
   delivering itself. Dropping a sealed frame spends its sequence number, which
   is the same forward gap a transport dying mid-seal already produces (§4.4), so
   the whole current set is still deliverable by the next pull.
3. **An authorization is about a WORLD, not a flag.** It names the peer, the
   room, the link identity and the confirmation preference in force. Anything
   that moves underneath it — a different target, a reconnect (which renames the
   peer), a new authentication step with a new SAS, a room switch, the link
   ending — makes it stop matching, and the gate fails closed without anything
   having to remember to revoke it. A transport replacement under one compared
   SAS is deliberately NOT such a change.
   The confirmation preference is the one member of that list a comparison cannot
   carry on its own, and it MUST be revoked explicitly when it changes, in either
   direction: on → off → on leaves the recorded preference equal to the current
   one on both sides of the comparison, so a decision made before the user changed
   their mind twice would come back into force. Revoking at the point the
   preference MOVES (rather than in whichever control happens to move it) is what
   makes "switching verification back on asks again" a property of the setting
   instead of a habit of one call site, and it must happen before or with the
   change so no reader can observe the new preference under the old grant.
4. **Confirming releases both halves, once.** The live-lane batch is drained and
   sent if there is one, and the whole current key set is emitted on the link
   whose code was compared. An all-keys batch drains to nothing, and a client
   MUST NOT send that emptiness as a transfer: an empty manifest raises a consent
   prompt on the peer for something that does not exist.
5. **Cancelling releases nothing and loses nothing.** No drain, no return to the
   live lane (§4.3's return is one-way), no authorization — and the batch stays
   reachable, which for a fully pre-uploaded one means a control that counts it.
   Measured with the live lane's own count that batch is 0 entries and gets no
   control at all.
6. **A batch that is all keys still needs a link.** The live lane has nothing to
   send for it, so nothing would ever build one — and with no link there is no
   SAS, so a confirmation in front of it could never be answered. A client SHOULD
   raise link establishment as its own intent there rather than by sending an
   empty batch or by opening a conversation the user did not ask for. Doing so
   releases nothing: the emission that follows attachment asks rule 1's question
   and is told no.
7. **An upload that lands later obeys the same gate.** The protocol lets an
   upload in flight at the join finish (§3), so a new object can appear on an
   already-open link; the resend it triggers is an emission like any other. Still
   authorized, it goes; not authorized, it does not, and the batch is left in a
   state the user can confirm again.

None of this applies where no confirmation is in force — a LAN room, or a code
room with the preference off. There is no code on screen to compare there, so a
gate would be a prompt with nothing behind it, and the handoff rides
establishment exactly as §4.4 describes.

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
a successful save" and which no browser without File System Access can meet. The
two questions in §7.5 are still the owner's to answer, and no other client posts
one yet (the CLI and the native clients receive, and do not complete). Nothing in
this section is reachable on a deployment with pre-upload off; Relayium's
official production deployment is in that state today.

§2 gives a joined room's ciphertext the account's retention window. Completion is
the receiver-controlled way §2 allows one to end EARLY, and it is the only exit
the RECEIVER can reach: the transfer ends because the receiver says it has the
file, rather than because the window ran out.
The owner's release (§8) is the account-controlled exit, and it exists because
§7.6 means a large class of receivers can never honestly say it. Account
deletion remains the final, account-wide exit.

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
rather than finalized — is reachable by ordinary use, and neither of the two
things that would normally close it is prompt: its retention deadline is a plan
window away, and no completion can fire because there is nothing left to
complete. A sweep closes such rooms after a grace period long enough that
"holds nothing" is settled rather than momentary, so the row does not sit out a
full window describing nothing.

### 7.5 What is deliberately NOT decided here

- **A decline is not a completion.** A receiver that refuses the batch has not
  taken delivery, and treating the two the same would delete a sender's
  ciphertext on the strength of a user saying "no thanks".
- **There is no SHORTER fallback expiry.** What becomes of a joined room nobody
  ever completes is answered by §2 and by nothing else: the room is held for its
  plan's retention snapshot and reclaimed when that window runs out. No timer
  shorter than that window stands in for a completion. §8 is not that answer
  either: it is a control the account operates, so a room whose owner never
  looks at it is ended by its deadline rather than by the control.
- Pre-upload still stays off unless a deployment opts in, and that is now a
  rollout decision rather than a missing mechanism. Both halves the flag was
  waiting on exist — the Web receiver posts completions (§7.6) and the owner can
  see and release what is left (§8). What remains is the SIZE of the commitment:
  §7.6 is explicit that a large class of browsers (Firefox, Safari, every phone)
  can never honestly complete at all, so for those senders every transfer is
  stored for a full plan window unless somebody ends it by hand. Whether that is
  an acceptable default for a production deployment is the owner's call.

### 7.6 When a receiver may spend it

A completion deletes the only remaining copy of the ciphertext, and the deletion
is not reversible. So the rule is not "the save succeeded" — it is **"this
device has taken delivery, and nothing between here and the user's disk can
still fail."** The two errors are not symmetric, and every ambiguity below
resolves the same way:

- Not completing costs the SENDER storage for the whole retention window — and
  §2 means it: an object nobody completes is held for its full plan window
  unless the owner releases the room (§8) or the account is deleted.
- Completing early costs the USER the file, permanently.

Only the first is bounded by a clock, which is why the second one decides.
Storage that runs out on its own, and that the owner can see, price, measure and
reclaim by hand sooner (§8), is not the same kind of loss as a file that no
longer exists anywhere.

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
senders' ciphertext is then in the position §2 describes with no completion ever
coming for it: it is held for the whole retention window, and the only things
that end it sooner are the owner releasing that room by hand (§8) or deleting the
account. This is the majority case, not the edge one, and §7.5 turns on it.

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

## 8. Owner release (the account's "let it go")

§7 is the receiver's exit and §7.6 says who can reach it: only a browser that
commits files to disk itself. Everyone else — Firefox, Safari, every phone, the
CLI, the native clients — saves the files and completes nothing, and §2 holds the
room for its whole retention window. Without this section that ciphertext is
billed to an account that cannot see it, cannot name it and cannot release it,
which is the one
combination an account surface may not leave standing. The charge is correct and
stays; the invisibility was the defect.

**This is not the room's expiry and must not be read as one** — §2's retention
deadline is what reclaims a room nobody releases. Nothing in this section fires
on its own: the server never RELEASES a room by itself, and a release happens
only because the account named one room, by id, in one request.

### 8.1 Listing what is held

```
GET /api/pair-rooms        (authenticated)   → {"rooms": [
                                                  {"id": <string>,
                                                   "createdAt": <unix seconds>,
                                                   "joinedAt":  <unix seconds>,
                                                   "objects":   <int>,
                                                   "bytes":     <int>,
                                                   "releasable": <bool>}],
                                                "totals": {"rooms": <int>,
                                                           "objects": <int>,
                                                           "bytes": <int>},
                                                "limit": <int>,
                                                "truncated": <bool>}
```

- **Session cookie OR bearer**, like `/api/me/usage` beside it: a read of the
  caller's own account, so a token with no ambient authority is enough, and a
  native client has the same right to see what it is charged for as the browser.
  Anonymous is `401`.
- **Scoped by ownership in the query itself**, not filtered afterwards. There is
  no shape of this request that reaches another account's room.
- **Only rooms that are JOINED, still open, and hold at least one finalized
  object.** Each exclusion is a promise, not a convenience:
  - an UNJOINED room is on `joinDeadline` (§2) and ends within minutes without
    anybody's help — it is also the state a pre-upload is in WHILE it is
    happening, so listing one would put a destructive control next to a transfer
    that is still uploading;
  - a CLOSED room's ciphertext is already gone; its row lingers only so a late
    request can be answered;
  - a room holding no finalized object is holding no ciphertext and costs
    nothing.
- **Opaque summary only.** A room is named by its instance id — never by its six
  digits, which are recycled — and carries a count, a byte total and two
  timestamps. No object id, no blob key, no completion verifier, no node, and
  nothing about the peer. There are no filenames because there are none to
  return: the one invariant at the top of this document means the server has
  never held one. The listing is a storage figure, not a file manager.
- **Bounded page, unbounded totals.** At most `limit` rooms come back, ordered
  `createdAt DESC, id DESC` (a total order, so the page boundary is the same for
  two identical requests). `totals` is computed over EVERY qualifying room
  regardless of the cap, so an account past it still reads the true byte count it
  is being charged for, and `truncated` says plainly that the LIST is partial
  while the numbers are not.
- `Cache-Control: private, no-store`. Account-scoped storage figures; a cached
  copy would go on describing storage after it was released.

### 8.2 Releasing one room

```
DELETE /api/pair-rooms/{id}    (authenticated, no body)
```

| status | body | meaning |
|---|---|---|
| `200` | `{"status":"ok"}` | released — **and, identically**, there was nothing to release: no such room, another account's, or already released. |
| `409` | `{"error":"pair_room_uploading"}` | an upload session is still bound to the room. Nothing was removed. |
| `409` | `{"error":"pair_room_waiting"}` | the caller's own room, but nobody has joined it. Nothing was removed. |
| `500` | — | the store could not be read or written. Never `200`: a caller told its ciphertext was released has no reason to ask again. |

- **The `200` is deliberately one answer for four situations**, exactly like
  §7.3's `204`: an authenticated caller may not use this route to learn whether a
  room id exists on somebody else's account. It also makes the request
  **idempotent** — a retry of a request whose response was lost is a no-op, not
  an error.
- **The two `409`s are the caller's own rooms only.** Ownership is resolved
  before anything can differ, so a refusal that distinguishes itself is never
  reachable for a room the caller does not own, and the route stays
  non-probing.
- **The unsafe route passes through the service's Origin-based CSRF guard.** A
  request that carries an Origin must use the site's own Origin. Browsers send
  one for a JavaScript `DELETE`, so this protects an ambient session cookie; a
  non-browser bearer request normally has no Origin and is accepted, with the
  token as its explicit authority. Requests without an Origin pass through,
  matching the account routes beside this one.
- **A WHOLE ROOM, never one object.** The account cannot tell its objects apart —
  it is shown a count, because the server holds no name for any of them — so an
  object-level control would ask somebody to choose between things they cannot
  see. The room is the unit that means something: one pairing transfer.
- **`releasable` is the SERVER's verdict**, so a client never reconstructs the
  eligibility rule and cannot put a delete control next to an upload in flight.
  It is advisory: every precondition is re-derived at release time.
- **An upload still in flight refuses the release**, because §3's promise that an
  in-flight upload may finish outranks it, and because those bytes are being
  billed. The refusal is repeatable once the upload lands.

### 8.3 What a release does

Every precondition — ownership, joined, no bound session — is re-derived inside
the same writer transaction as the close, never taken from the listing the client
is acting on, which it may have been holding for an hour. In that one
transaction the absence of any bound upload session is confirmed, the room is
closed, every object row is deleted, and a DURABLE delete intent is queued for
every blob before anything can fail. **Storage and quota are released when that
transaction commits** — not at a later sweep and not when a node answers.
Physical blob deletion is the bounded best-effort half afterwards; an unreachable
node costs only promptness, because GC keeps asking from the intents. This is the
same machinery §2's void uses, and the room's code is revoked under the same
owner-and-deadline bound, so a release can never take back digits that have since
been minted to somebody else.

Two consequences, stated because a user is about to be asked to accept them:

- **It is irreversible.** There is no restore, no undo and no backup. The
  ciphertext is the only copy the server has, and the server cannot re-create it
  because it cannot read it.
- **It can break a download in progress.** A receiver that is still fetching, or
  has not fetched yet, gets a `404` from `/blob` afterwards. Release is the
  owner's decision that the transfer is over; the server has no way to ask the
  receiver whether it agrees.

What it does NOT do: it does not reach the live peer-to-peer link, which the
server does not carry and cannot cancel, and it does not touch shares or Device
Inbox objects, which are not in this query's shape at all.

### 8.4 Mounted whatever the flag says

Neither route consults the pre-upload flag, deliberately. The flag stops rooms
being CREATED; a deployment that turns it off after a room exists must not
thereby strand that room's ciphertext on an account with no control over it. A
kill switch that traps the thing it was meant to contain is not a kill switch.
With the flag off and no room ever created, both routes have nothing to report
and nothing to release.

**Backward compatible in both directions.** A client that never calls either is
unaffected — nothing about the upload, handoff, download or completion path
changes — and a client that calls them against a server predating them gets
`404`, which it must read as "this server has no such view", never as "there is
nothing held".
