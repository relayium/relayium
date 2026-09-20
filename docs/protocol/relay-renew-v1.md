# Relayium relay renewal v1 (authoritative)

Capability string: **`relay-renew/1`**

Fixture: `apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json`
Fixture authority: `web/src/lib/relay-renew-vectors.test.ts`
Reference implementation: `web/src/lib/relay-renew-wire.ts`, `web/src/lib/relay-renew.ts`

This document extends `relayium-link-v1.md`. Section numbers prefixed `link:`
refer to that document. Nothing here replaces any of it; renewal is an addition
that a conforming `link/1` client may implement, and a client that does not
implement it must be unaffected by a peer that does.

---

## 0. What this is, and the three things it is not

A relayed `link/1` is bounded by the TURN credential the server issued. The
client derives that boundary up front (`relay-deadline.ts`) and ends the link
truthfully just before the credential dies, because a dead TURN allocation is
silent: the PeerConnection stays `connected` and simply stops moving bytes.

Renewal lets a link that is **actually being used** obtain a fresh credential
for the same room and the same two peers, apply it, migrate the media path onto
it, and only then move its deadline. No re-pairing, no new SAS, no key
agreement, no counter reset.

It is **not**:

1. **A TTL extension.** The client never extends a deadline it has. It receives
   a new credential, derives a new deadline from that credential, and publishes
   it only after the new path is proven. Every failure path keeps the OLD
   deadline exactly as it was.
2. **A claim that `setConfiguration` succeeded.** Applying a configuration is
   not a migration. Neither is an open DataChannel, a `connected` state, or an
   HTTP/WS reply. See §6.
3. **A way for an idle link to live forever.** The ten-minute idle close
   (`MIXED_LINK_IDLE_MS`) is untouched, and renewal control traffic is
   explicitly *not* user activity. See §7.

---

## 1. Two counters, and why they are different

| | Owner | Monotonic | Meaning |
|---|---|---|---|
| `round` | the **server** | yes | one issuance of credentials to this room's two peers |
| `epoch` | the **link** | yes | one migration attempt on this PeerConnection |

A round is a thing the server did. An epoch is a thing the two clients tried.
One round may be spent on up to `RENEW_MAX_EPOCHS_PER_ROUND = 3` epochs; past
that the link stops trying and keeps the deadline it has.

Both are unsigned 32-bit integers on the wire, in every message and every frame.
A value that is not an exact `uint32` is a reject, not a coercion: the native
ports carry a real `UInt32`, so anything JavaScript would tolerate here is a
divergence.

`round` starts at 0 for a link's original grant; the first renewal asks for 1.
`epoch` starts at 0 for the link's original transport; the first migration
attempt is epoch 1. Epoch does **not** reset across a `link:§8` transport
rebuild — a rebuilt transport inherits the counter, so an aborted epoch's signed
messages can never be replayed into a later attempt.

---

## 2. The server exchange

Carried on the **existing signalling envelope** (`relayium-signaling-v1.md`), not
on a new HTTP endpoint.

### 2.1 Request

```
C -> S   {"type":"ice-renew","data":{"round":<uint32>,"rid":<uint32>}}
```

`data` carries exactly those two keys. `round` is the round being asked for.
`rid` is a request id, local to the requester, used only to correlate the reply.

### 2.2 Reply

```
S -> C   {"type":"ice-grant","data":{"status":…,"round":…,"rid":…, …}}
```

| `status` | Meaning | Client action |
|---|---|---|
| `granted` | credentials issued for `round` | apply; continue the epoch |
| `denied` | policy refused (quota, unverified, membership, idle, …) | **terminal for this round**; keep the old deadline |
| `unavailable` | the server could not answer right now | bounded retry allowed |
| `stale` | the client asked for the wrong round; `round` is the server's current one | re-ask for the reported round to retrieve the cached result |

A `granted` reply carries `iceServers` and, optionally, `relays` in **exactly**
the `/api/ice` shape. There is no second credential format and no second parser:
the same sanitiser that survives a hostile `/api/ice` body handles this one.

A `denied` reply may carry `relayDenied` with the same `quota`/`unverified`
vocabulary `/api/ice` uses.

`reason` is an optional diagnostic enum — `quota`, `unverified`, `idle`,
`expired`, `membership`, `rate`, `unavailable`. It is **never** routed on and
**never** shown to a user as prose.

### 2.3 Server-side rules (informative for clients, normative for the server)

- The **original room** and the **frozen original two peer ids** are the
  authority. Both original peers must request a round before it is issued.
- One in-flight issuance per round. 30 s collection window, 10 s bounded
  database work. The exact result is cached per round, so a duplicate request
  for the current round replays that cached result (with the requester's own
  `rid`) and costs no reissuance and no rate charge.
- No grant after all members have left, been replaced, or lapsed. Grant lifetime
  is independent of whether the pairing code is still joinable.
- `unavailable` does not advance issuance. `denied` mints no configuration.
- The next successful issuance is no sooner than half the credential TTL.
  Retrieving a cached result is exempt.
- Quota, verification, email and node policy are evaluated **before**
  authorisation, fail-closed.

### 2.4 Old servers

A server that does not implement `ice-renew` ignores the frame. The client
therefore treats *silence* as `unavailable` and, after its bounded attempts,
falls back to today's behaviour: the link runs out its existing deadline and
ends truthfully. No blind retry past the old deadline.

---

## 3. The link signalling envelope

### 3.1 Exact outer shape

```json
{"link": true, "renew": { … }, "auth": "<44-char base64>"}
```

Exactly three keys. Recognise it by that shape, before anything cryptographic
runs — the same allow-list discipline `link:§4.6` applies to leave signals, and
for the same reason.

**SDP and ICE are nested inside `renew` and MUST NEVER appear at the top level.**
`establish()` filters inbound signals by *generation*, not by kind, so a renewal
message on the `link` generation is also seen by any establishment in flight for
that peer. A top-level `sdp` would be applied by the ordinary handler as a real,
unauthenticated renegotiation against a live PeerConnection; a top-level `ice`
would be added to it. Nesting makes this frame inert everywhere except the
renewal controller.

### 3.2 The five inner types

Each has an **exact** key set. An extra or a missing key is a reject.

| `type` | Keys |
|---|---|
| `prepare` | `type`, `epoch` |
| `ready` | `type`, `epoch`, `round` |
| `sdp` | `type`, `epoch`, `round`, `sdpType`, `sdp` |
| `ice` | `type`, `epoch`, `round`, `candidate`, `sdpMid`, `sdpMLineIndex`, `usernameFragment` |
| `abort` | `type`, `epoch`, `reason` |

- `sdpType` is `offer` or `answer`. Nothing else, including `pranswer`.
- `sdp` and `candidate` are non-empty strings.
- `sdpMid` and `sdpMLineIndex` are **nullable but not omittable**. The key must
  be present with an explicit `null`. An encoder that drops an absent optional
  would render a payload the signer's tag cannot cover, and the three ports
  would silently disagree about exactly the messages that carry a relay
  candidate.
- `usernameFragment` is a **non-empty** string. A candidate whose generation
  cannot be named cannot be bound to an epoch, and an unbindable candidate is
  dropped rather than guessed at.
- `reason` is one of `denied`, `unavailable`, `timeout`, `sdp`, `closed`.

### 3.3 The signed payloads

Hand-serialised, fixed key order, no whitespace. `from` and `to` are the
established peer ids as each side knows them and are **not** carried in the
envelope — they come from the signalling context, so a relay that reflects a
message back at its sender verifies the reversed tuple and fails.

```
{"kind":"link-renew-prepare","from":F,"to":T,"epoch":E}
{"kind":"link-renew-ready","from":F,"to":T,"epoch":E,"round":R}
{"kind":"link-renew-sdp","from":F,"to":T,"epoch":E,"round":R,"sdpType":TYP,"sdp":SDP}
{"kind":"link-renew-ice","from":F,"to":T,"epoch":E,"round":R,"candidate":C,"sdpMid":MID,"sdpMLineIndex":IDX,"usernameFragment":U}
{"kind":"link-renew-abort","from":F,"to":T,"epoch":E,"reason":WHY}
```

**String escaping is exactly `link:§4.4`'s** — JavaScript `JSON.stringify`
semantics, including the part most easily got wrong: U+007F, the C1 range,
U+2028, U+2029 and astral characters are emitted **raw** (as UTF-8), not
escaped. The fixture's `prepare` vectors include a peer id carrying every one of
these cases.

### 3.4 The tag

```
auth = base64(HMAC-SHA-256(resumeAuth, utf8(payload)))
```

The **existing** `resumeAuth` — derivation unchanged (`relayium-crypto-v1.md`).
Renewal introduces no new secret and no new key agreement. Standard RFC 4648
base64 with padding; exactly 44 characters, checked before any decode or HMAC.

An absent or malformed tag is a failure. There is no unauthenticated branch.

### 3.5 Verification order

Every cheap check runs before the HMAC:

1. exact envelope shape and exact inner key set (§3.1, §3.2);
2. the capability was announced and a current link with this sender exists;
3. the epoch is one this side can act on (§4);
4. the per-epoch verification budget is not spent;
5. only then, verify the tag.

Verification is **serialised** — one HMAC at a time, in arrival order — and
pending work is capped (`RENEW_MAX_PENDING_SIGNALS`). A signal that does not
verify is dropped in silence.

Serialising is a correctness requirement, not tidiness. Verification is
asynchronous, so two signals handed over in the same turn race their HMACs. The
reachable case is a peer whose round was already cached and which therefore
sends `prepare` and `ready` back to back: if the `ready` verifies first it finds
no attempt yet, is dropped as unroutable, and is never resent. Both sides then
wait for each other until the epoch times out, with nothing in either side's
state to show why.

The routability check in step 3 is therefore evaluated when a message REACHES
the front of the queue, not when it is enqueued — the message ahead of it is
exactly what may have made it routable.

---

## 4. Epoch rules

- Either side may send `prepare`. The **offer** is always sent by the link's
  established initiator (`link:§3`), so a migration cannot turn two peers into
  two offerers.
- Epoch is link-level, monotonic, never reused.
- A received `prepare` whose epoch is **higher** than this side's in-flight
  epoch is adopted; a lower one is ignored. Both ends converge on the larger.
  Two peers preparing simultaneously at the *same* epoch coalesce into one
  attempt.
- A failed attempt retries under a **new, higher** epoch. There is deliberately
  no `attempt` field: a fresh epoch is what makes an aborted attempt's signed
  messages unreplayable into the retry.
- **The counter is monotonic across the whole authenticated link, and that is a
  security rule rather than bookkeeping.** With no attempt in flight, a
  `prepare` is acted on only if its epoch is *strictly greater* than the highest
  epoch this link has ever spent. A correctly signed `prepare` for an epoch that
  already failed stays valid forever — replaying it must not start a second
  attempt at that number, because each attempt asks the server for a round.
- The counter therefore survives a `link:§8` transport rebuild, **including one
  that publishes an intermediate "no link" state**. It resets only when a link
  with different session keys begins, which is the only event that genuinely
  ends an authenticated link.
- At most `RENEW_MAX_EPOCHS_PER_ROUND = 3` epochs per server round.
- Any `abort`, any timeout, and any failed check voids the current epoch and
  **preserves the old deadline**.
- `denied` is terminal for that round. `unavailable` permits bounded retry.
  `stale` resynchronises to the round the grant reports.

### 4.1 Suppressing the unauthenticated restart

While an epoch is in flight, the existing unauthenticated `tryIceRestart`
(`webrtc-core.ts`) is **suppressed**. Two offers on one PeerConnection is glare
that neither side can resolve.

Further: once a link has verified **any** renewal signal from its peer, it
**refuses unsigned `link`-generation SDP for the remainder of that
PeerConnection**. That decision is monotonic and authenticated, and it does not
depend on the unauthenticated `caps` hint (`link:§1.6`).

The `link:§8` authenticated transport rebuild is a separate mechanism and is
untouched: its identity, its counters and its own `resume` generation are
preserved.

---

## 5. SDP and candidate binding

### 5.1 Fingerprint pinning

The baseline is taken from the description **actually applied** at epoch 0,
normalised. Every remote description at `epoch ≥ 1` must satisfy all three:

- the `a=fingerprint` **set** is equal (normalised to `<hash-lower> <HEX-UPPER>`,
  sorted and deduplicated — the two ends may list the same set in a different
  order, and RFC 8122 leaves the hex case open);
- the m-line count and the `a=mid` sequence are equal;
- for an **answer**, the `a=setup` role is unchanged. An offer legitimately
  restates `actpass`, so the role is only compared where it is actually chosen.

After a `link:§8` rebuild the baseline is re-pinned from the new description.

**The pin is checked on the RECEIVED bytes, before `setRemoteDescription` is
called.** The tag proves who sent a description; it does not prove the transport
underneath may be replaced. Applying first and objecting afterwards has already
moved the agent onto the description being objected to. A second check against
what the agent actually holds runs after applying, as defence against a stack
that rewrote part of it.

Reading the applied description means `remoteDescription` — **never**
`currentRemoteDescription`. After a responder applies a renewal *offer*, the
offer is the PENDING remote description and `current` is still the previous
generation; a pin taken from `current` would compare the baseline against
itself and pass a check it never ran. The same applies to the ufrag read in
§5.2.

Pinning keeps the existing DTLS peer in place. It is **not** the root of trust —
that remains the E2E key the SAS anchored.

### 5.2 ufrag binding

A candidate belongs to whichever ICE generation **the candidate itself names**,
never to whatever epoch happens to be current when the callback fires.
`onicecandidate` is asynchronous and a restart can land between gathering and
delivery, so labelling by a mutable "current epoch" variable attributes
candidates to the wrong generation.

- **Local ufrag** comes from the `a=ice-ufrag` of the description whose
  `setLocalDescription` succeeded for that epoch.
- **Candidate ufrag** is parsed from the candidate string's own ` ufrag <x>`
  extension. Apple's `RTCIceCandidate` and Android's `org.webrtc.IceCandidate`
  expose no `usernameFragment` property, so this parse is the portable source
  and the native ports use it too.
- A local candidate whose ufrag cannot be parsed is **dropped, not sent**.
- Android also signals an SDK-selected local peer-reflexive candidate through
  the same authenticated `ice` envelope when both descriptions are applied and
  its own ufrag matches the epoch. This lets the peer check the discovered
  address from its new allocation, as permitted by RFC 8445 §7.2.5.3.1.
  Publication is deduplicated and capped at 64 selected addresses per epoch,
  and requires the pinned single data-channel mid. A mixed new-local/old-remote
  pair may supply this address, but still cannot start the migration proof or
  extend the deadline.
- An inbound candidate must name the epoch's remote ufrag. Where both the
  `usernameFragment` field and the string extension are present they must
  agree; where only one is present it is used; if they contradict, or neither
  states one, the candidate is dropped.
- Held inbound candidates are keyed by ufrag and bounded at
  `RENEW_MAX_HELD_CANDIDATES = 64`.
- An implementation that keeps its own candidate→generation mapping (§6.3) keys
  it on the transport address. That key is **not unique across generations** —
  TCP-active candidates are published on port 9 by every generation — so a key
  that is ever seen with two different ufrags must be poisoned, not overwritten.
  Reading a poisoned key answers "unknown", which makes observation fail.
- Closing the link cancels every queue, timer and pending verification.

### 5.3 Transport policy

`iceTransportPolicy` stays whatever the link was built with. A migration that
lands on a **direct** path is a legitimate success and is classified by the
existing rule; renewal does not force relay where the original policy allowed
direct, and makes no LAN or backend call of its own.

---

## 6. Proving the migration

This is the section the whole feature rests on.

### 6.1 The control frame

A fixed **59-byte** binary frame on the **existing text DataChannel**, with a
newly registered first byte.

```
[0x0d][ver=1][type][epoch u32BE][round u32BE][nonce 16B][tag 32B]

type: 1 = probe, 2 = ack
tag  = HMAC-SHA-256(resumeAuth, utf8(payload))
payload = {"kind":"link-renew-probe"|"link-renew-ack","from":F,"to":T,"epoch":E,"round":R,"nonce":"<std base64>"}
```

`0x0d` is outside every kind already in use (file lane 1–8, text 9, pre-upload
12, and the lifecycle bytes), and `link:§7.3` already requires a text-lane frame
whose first byte is not `0x09` to be **silently ignored**. That is what makes
this frame safe to send to a peer that has never heard of renewal.

**Why a dedicated frame and not the text codec.** Routing a handshake through
ordinary kind-9 content would be a hard failure on all three clients whenever
the conversation is not `open` (Web `mixed-text-session.onData`'s `markFailed`,
Android `TextLaneSession` `CONTENT_BEFORE_ACTIVATION`, Apple
`LinkTextSession.admitFrame`), and it would consume the strictly increasing AEAD
`seq`. This frame consumes no sequence and changes no file or text semantics.

**Why HMAC is enough.** The probe carries no secret — an epoch, a round, a
random nonce. The adversary that matters is a signalling-side DTLS
man-in-the-middle, and it cannot produce `resumeAuth`. Replay and reflection are
closed by `from`/`to`, `epoch`, `round`, the per-attempt random nonce, and the
domain-separating `kind` that makes a probe and its ack different strings.

### 6.2 Routing

The frame is **intercepted and consumed ahead of the text session**, by a true
front demux — not an additive `addEventListener` observer, which cannot stop a
frame from also reaching the session. On the Web the lane's `onmessage` is a
single-slot property, so the demux owns that slot and forwards what is not ours.

The demux's lifetime is the **transport's**, not the conversation's. It is
installed at the same atomic attach point as the two lanes, and frames replayed
from `link:§2.2` pre-attachment capture (including across a `link:§8` rebuild)
go through the same routing. With nobody listening, a frame is dropped and never
replayed.

**A renewal control frame MUST NOT reach:**

- the text session's `onActivity` (Web `mixed-text-session.svelte.ts` calls it on
  the first line of `onData`) — it would reset the ten-minute idle timer;
- the inbound rate budget (Android `TextLaneSession` takes a token before
  classifying) — a burst would fail the lane on `BOUNDS`;
- the AEAD receiver, under any circumstances.

A control-only buffer must not poison the text codec on close or recovery. The
case to test: a transport gap where the send buffer holds only control frames
and no pending protected frame.

### 6.3 What counts as proof

Three things must hold, and the wording matters:

1. **Local observation.** This side observes that the **selected local
   candidate belongs to this epoch's ufrag generation**. Not "the port changed".

   The selected pair MUST be read from the ICE transport's own
   `selectedCandidatePairId`, never by scanning for the first candidate-pair row
   flagged `selected` or `nominated`+`succeeded`. **After an ICE restart Chrome
   keeps the previous generation's pair in the report, still flagged, ahead of
   the new one in iteration order** — a client that scans reads the generation
   it is migrating away from. Where no authoritative row exists, a scan may be
   used only if it is unambiguous (exactly one qualifying pair); two qualifying
   pairs is precisely the post-restart shape and the honest answer there is
   "cannot tell".

   Web selected-pair notifications wake a bounded stats poll. Native selected-
   pair callbacks carry the selected candidate strings; when those strings
   include their own ufrag extension, it is authoritative generation evidence.
   A native event received before both descriptions are applied is retained and
   re-evaluated after application. No callback is labelled from a mutable
   “current epoch” value.

   Where the stats API does not expose a ufrag, the implementation records its
   own candidate-to-generation mapping (§5.2). A local candidate of type
   `prflx`, whose generation cannot be determined, means observation has **not**
   held.

   **Both of this epoch's descriptions must be applied before observation may
   begin.** The offerer that has restarted ICE but has no answer yet can form a
   pair whose far end is still on the previous generation entirely, which would
   satisfy the local clause against a half-migrated transport.
2. **The peer's own observation**, which is the only thing that makes it send an
   `ack`.
3. **The ack arrives after this side's observation held**, and matches this
   side's own fresh nonce.

**HMAC authenticates key possession and freshness. It does not authenticate the
path.** The path evidence is the conjunction above. No implementation and no
document may state that the tag proves the route.

### 6.4 Probe mechanics

- Both peers send a probe.
- A local probe may start, and a remote probe may be acked, **only after** local
  observation holds.
- A verified probe arriving before local observation holds is retained in a
  **single slot** (latest nonce wins) and acked once observation holds.
- Retransmit the same nonce every `RENEW_PROBE_RETRY_MS = 2000`, at most
  `RENEW_PROBE_MAX_SENDS = 5` times. A duplicate probe gets the same ack,
  idempotently.
- **"Already verified" is identified by nonce AND tag together.** Matching on
  the nonce alone would let a frame that merely reuses a seen nonce with a
  forged tag collect a free ack without ever holding the key.
- Verification order: length, kind byte, version, type → epoch and round match
  the in-flight attempt → budget → HMAC. At most
  `RENEW_MAX_PROBE_VERIFICATIONS = 8` new HMACs per epoch, serialised.
- **That eight is the epoch's total, before AND after commit**, and it is
  PARTITIONED rather than first-come-first-served: four reserved for inbound
  ACKs and four for inbound probes. Unpartitioned, a flood of junk probe frames
  spends all eight before the peer's genuine ACK arrives — and that ACK is the
  only thing that can complete a migration, so the flood costs the renewal
  without forging anything.
- An eligible ACK that arrives while a verification is already running is held
  in a **single slot** and drained when that verification finishes, rather than
  dropped. ACKs are not retransmitted on their own — the peer re-sends its
  PROBE — so a dropped ACK costs this side the commit while the peer goes on
  believing the migration is shared.
- An exact duplicate of an already-verified frame may reuse the cached result.
  "Already verified" means the nonce **and** the tag: matching on the nonce
  alone lets a frame that merely reuses one collect a free ACK without ever
  holding the key.
- Probes never travel through the text send queue.

### 6.5 Commit

Only on commit — local observation **plus** a matching fresh ack for this side's
own nonce, arriving after observation held — does the client:

- re-run the existing path classification and `armDeadline`;
- derive the new deadline from the **received configuration** for round `R`, and
  publish it;
- release the credential the link was previously bounded by.

If the path classified as direct, the existing rule releases the deadline
entirely, exactly as it does today.

Nothing else commits. Not a WS reply, not `setConfiguration`, not an open
DataChannel, not a `connected` state, not an old selected candidate.

### 6.6 After commit: the two peers do not commit together

This side commits when the peer's ack for ITS nonce arrives; the peer commits
when this side's ack reaches it. Between those two instants the peer is still
retransmitting.

A client that tore its epoch down on its own commit would drop those
retransmits, and the peer would time out and keep an expiring deadline while
this side believed the migration was shared — a split neither end reports. So a
committed epoch is **retained for `RENEW_POST_COMMIT_ACK_MS`** (equal to
`RENEW_ICE_PROBE_MS`, because the peer's own window cannot outlive it) and keeps
exactly three abilities:

- answer a probe it has already verified, from cache, spending no new HMAC;
- verify probe nonces it has not seen — legitimate, because this side commits on
  the peer acknowledging ITS nonce, which says nothing about whether the peer's
  own probe was ever verified here — **out of what the epoch's budget has left**,
  from the probe reservation. The committed state does not receive a fresh
  allowance; the total for the epoch stays eight;
- keep emitting its own trickle candidates under the **committed** epoch and
  round, since after a migration every later local candidate still belongs to
  that generation and must keep travelling signed.

It MUST NOT be able to start negotiation, move a deadline again, or be promoted
back into an attempt.

### 6.7 Repairing an asymmetric commit

The two peers do not commit together, and sometimes one never does: its ACK was
lost, its post-commit window closed, its epoch timed out. The committed side
then holds round R while its peer still holds R−1 and is asking the server for
R+1 — and the two can never meet. R+1 will not be issued until the issuance
floor allows it, and the side that already has R has nothing to gain from a new
credential anyway.

So a client MAY migrate onto a round it has **already installed**:

- On a valid signed `ready(E, R)` where `R` is exactly the round this side has
  installed, and this side has no configuration for the epoch in flight, it
  adopts its OWN stored configuration for `R` and answers `ready(E, R)`.
- Nothing is taken on the peer's word. The configuration used is the one this
  side already fetched and verified; the `ready` that triggered it is signed
  under the link's key; and the epoch is the ordinary monotonic one.
- **No new issuance is needed**, which is the point: the credential exists.

A request for R+1 that is refused with `unavailable` or `rate` therefore does
NOT end the epoch when a repair is still possible. The epoch stays alive with no
configuration, bounded by the timers it already has, so that a `ready(E, R)` can
still arrive. `denied` is different: a policy refusal is terminal for the round
and unrelated to what is already in hand.

Refuse to adopt: a round older than the one installed; a round this side never
fetched; a configuration whose credential has lapsed; an arbitrary unsolicited
configuration; and any case where this side already holds a different round for
the epoch in flight.

**A same-round commit buys no time.** The path really moved and was really
proven, but the credential is the one the current deadline was already derived
from, so the boundary and its anchor are left exactly as they are and
`RENEW_MAX_EPOCHS_PER_ROUND` is NOT refunded. Re-arming would hand one
credential an unbounded series of extensions. The peer that had not committed R
does advance onto it, because for that peer it is genuinely new.

An in-flight R+1 request must be **fenced** at the moment a repair is adopted.
A server reply is asynchronous and arrives long after the decision that made it
irrelevant: a late `denied` would abort a migration already under way, and a
late `granted` would install a configuration the peer never agreed to.

The **server does not observe commit.** Billing follows actual usage and is
unrelated to it.

---

## 7. Activity, consent and timing

### 7.1 What counts as activity

A client requests renewal — and treats its user as consenting to it — only on
**recent authenticated user-lane activity**: actual file bytes or ACK progress,
or user text, within the last 10 minutes, on the established E2E link.

These are explicitly **not** activity:

- a UI "active" flag;
- a pending-consent flag;
- queued but unsent work;
- keepalives;
- renewal control frames, including probes and acks.

The existing ten-minute idle policy is preserved unchanged. A link nobody is
using still dies on schedule.

There is **no minimum transfer speed or volume.** A fixed floor would exclude a
sparse legitimate conversation and a slow or stalled-but-recovering file, while
a hostile pair can pad arbitrary bytes past any floor — the meter cannot
distinguish E2E content from padding by design. The server's own requirement is
authoritative metered progress in the trailing window, not a chosen volume, and
it is stated honestly: **the server verifies recently metered relay traffic, not
application meaning.**

### 7.2 Timing

Attempt renewal **ahead of** the old deadline — a 10-minute margin for a normal
one-hour grant, scaled safely for an accelerated test TTL without going negative
or busy-looping.

**The margin is a fraction of the grant's LIFETIME, so it must be measured from
a fixed anchor: the instant the boundary was installed.** Measured from the
current time it becomes a fraction of the shrinking *remainder*, and since
`remaining ≤ remaining / 3` is false for every positive remaining, the trigger
never fires until the deadline has already passed. That is not a hypothetical:
an executable reproduction against the shipped controller recorded zero requests
at 50 and 55 minutes of a 60-minute grant, and the first request only at the
deadline itself. The concrete rule, for a grant armed at `T` with a boundary at
`T + L`:

```
margin    = min(10 min, floor(L / 3))
attempt when now >= (T + L) - margin
```

so a one-hour grant is renewed from 50 minutes in, and a 60-second accelerated
test credential from 40 seconds in. A grant whose boundary has already passed is
never renewed — there is nothing left to renew, and the link is about to reach
its truthful terminal state.

A failed epoch waits `RENEW_RETRY_BACKOFF_MS = 60000` before another is spent.
Without it the trigger's own polling cadence would burn all three of a round's
epochs inside fifteen seconds, spending the link's whole budget before the
renewal window had really begun.

**Two budgets, both keyed by the credential round they are spent on.**

`RENEW_MAX_EPOCHS_PER_ROUND = 3` counts epochs that actually OBTAINED a granted
configuration — a real migration attempt on a real credential — and a §6.7
repair is one of them. An epoch that never got a configuration restarted no ICE
and changed nothing; charging it the same way meant a three-minute database
wobble, or a few seconds of clock skew, spent the link's entire renewal
allowance while most of the margin was still unspent. Those get their own count,
`RENEW_MAX_PREGRANT_ATTEMPTS`.

Three properties make the accounting correct, and each corrects a defect a
product negative found — one peer starting **seven** distinct granted epochs
against the same credential in eighty seconds:

1. **Charged at acceptance, not at the end.** The moment a configuration is
   applied to the transport, the round has paid for that epoch. Charging on the
   way out left two exits free — an authenticated `abort` from the peer, and
   supersession by a higher `prepare` — and a peer may send either as often as
   it likes.
2. **Never refunded.** A commit does not clear the round's count. A credential
   that cost two failed migrations before one succeeded has ONE epoch left, not
   three: failure, success and repair all spend the same credential.
3. **Keyed by round, so a spent round blocks only itself.** Round 2 is a
   different credential and carries its own right; a global counter let repairs
   aimed at a committed round 1 exhaust the link's ability to ever ask for
   round 2. The pre-grant count is keyed the same way and for the same reason.

A fourth attempt on a round is refused **before** any RTC configuration or SDP
is produced — including when the server replays a cached grant, and including
when a reply names a round the client did not gate its request on.

An authenticated `abort` from the peer applies the same backoff a local failure
does. A supersession does not (its replacement starts immediately) but is still
charged, or signed prepares would be an unbounded source of requests.

The real bound on all of it is the old deadline: **nothing is ever retried past
it.**

A grant that would move the boundary **earlier**, or not at all, is refused: it
would retire a live allocation in favour of a shorter-lived one.

The existing truthful warning and expiry behaviour is the fallback whenever a
renewal has not committed. The two peers' initial expiries may legitimately
differ; either side's trigger works.

Deadlines within one epoch:

| Phase | Bound |
|---|---|
| `prepare` → `ready` | 15 s |
| `ready` → answer | 15 s |
| ICE + probe | 30 s |
| whole epoch | 60 s (hard) |

Retries are bounded and must complete **before** the old deadline. Negative
outcomes preserve it.

---

## 8. Compatibility

- `relay-renew/1` is advertised **only** by a build with the whole path wired on
  that platform. It is an unsigned hint (`link:§1.6`); only authenticated
  messages confer peer proof.
- An older peer receiving a renewal envelope must do **nothing at all**. The
  existing parsers already produce that outcome, and each platform pins it with
  a fixture rather than an argument.
- An older peer receiving a `0x0d` text-lane frame silently ignores it
  (`link:§7.3`).
- Two `prepare` signals about 10 s apart with no reply
  (`RENEW_PREPARE_SILENCE_MS`) means the peer does not implement renewal, for
  the remainder of that link. The UI must not claim a renewal happened.
- A peer that failed or was denied migration **cannot be hidden** by the other
  side's successful timer update. Mixed-version links retain truthful bounded
  behaviour.

---

## 9. Bounded resources

| Bound | Value | What it limits |
|---|---|---|
| `RENEW_MAX_EPOCHS_PER_ROUND` | 3 | granted migration epochs per server round, never refunded |
| `RENEW_MAX_PROBE_VERIFICATIONS` | 8 | HMACs spent on inbound probes, per epoch |
| `RENEW_MAX_HELD_CANDIDATES` | 64 | inbound candidates held per epoch |
| `RENEW_PROBE_MAX_SENDS` | 5 | retransmits of one probe nonce |
| `RENEW_PROBE_RETRY_MS` | 2000 | retransmit cadence |
| `RENEW_PREPARE_TO_READY_MS` | 15000 | phase bound |
| `RENEW_READY_TO_ANSWER_MS` | 15000 | phase bound |
| `RENEW_ICE_PROBE_MS` | 30000 | phase bound |
| `RENEW_EPOCH_HARD_CAP_MS` | 60000 | whole epoch, never re-armed |
| `RENEW_PREPARE_SILENCE_MS` | 10000 | before concluding the peer is unsupported |
| `RENEW_RETRY_BACKOFF_MS` | 60000 | between a failed epoch and the next |
| `RENEW_MAX_PREGRANT_ATTEMPTS` | 6 | attempts that failed before a grant, per round |
| ACK verification reserve | 4 | of the epoch's 8, reserved for inbound ACKs |
| probe verification reserve | 4 | of the epoch's 8, reserved for inbound probes |
| `RENEW_MAX_PENDING_SIGNALS` | 32 | inbound signals queued for verification |
| `RENEW_POST_COMMIT_ACK_MS` | 30000 | how long a committed epoch answers probes |
| `RENEW_AUTH_LENGTH` | 44 | tag length, checked before decode or HMAC |
| `RENEW_PROBE_FRAME_BYTES` | 59 | exact control-frame length |

Every timer, promise, request, listener and retry is disposed on link or room
replacement and on close.

---

## 10. Refusals

A conforming `relay-renew/1` client MUST refuse, fail-closed:

- any renewal envelope that is not exactly `{link, renew, auth}`;
- SDP or ICE at the envelope's top level;
- an inner object with an extra or missing key for its type;
- any integer that is not an exact `uint32`;
- an `sdpMid`/`sdpMLineIndex` that is omitted rather than explicitly `null`;
- an empty `usernameFragment`, or a candidate whose two ufrag sources disagree;
- a remote description at `epoch ≥ 1` that fails the pin;
- a candidate belonging to any generation but the epoch's;
- a probe frame of any length but 59, any first byte but `0x0d`, or any version
  but 1;
- an ack that does not match this side's own current nonce;
- a `prepare` at an epoch at or below the in-flight one, or — with no attempt in
  flight — at or below the highest epoch this link has ever spent;
- a fourth epoch on one round;
- a candidate-pair selection read by scanning when two pairs qualify and no
  authoritative `selectedCandidatePairId` says which;
- a probe that reuses a verified nonce with a different tag;
- a selected pair whose REMOTE candidate names a different generation, where
  the stats report states one at all;
- adoption of a round older than the one installed, never fetched, already
  lapsed, or arriving while a different round is in hand for that epoch.

And it MUST NOT:

- extend a deadline on anything short of §6.5 commit;
- derive a deadline from anything but the configuration actually received;
- measure the renewal margin from the current time rather than the grant's
  arming instant;
- read `currentRemoteDescription` where `remoteDescription` is meant;
- begin observation before both of an epoch's descriptions are applied;
- give a committed epoch a fresh verification allowance;
- refund a round's migration budget on commit, or key it globally;
- let a peer's abort or a supersession end an attempt without charging it;
- advance or re-arm a deadline on a same-round repair;
- let a late round reply overwrite or abort an adopted configuration;
- verify inbound signals concurrently, or decide routability at enqueue time;
- rotate, reset or re-derive any key, nonce or sequence;
- reset or re-grant paid entitlement;
- count renewal traffic as user activity;
- treat the capability hint as a security input;
- claim renewal to the user before commit.

---

## 11. Evidence and remaining limits

1. **Controlled product interoperability is exercised separately from engine
   tests.** The actual server, real TURN allocations, built Web UI and native
   composition have been run across accelerated credential lifetimes. Web
   positive and failed-migration cases, Apple senders transferring a single
   large file through three renewals in both connection roles, Android–Web
   transfers with reachable and unreachable STUN, and Pion quota exhaustion
   have executable evidence. The Apple long-file runs continued after forced
   retirement of the initial allocations and reconciled per-allocation usage;
   this is not a claim that old allocations always retire promptly on their own.
   These local slow-transfer runs
   verify continuity, integrity and accounting; they are not WAN throughput
   benchmarks or proof of every NAT, proxy or mobile-network topology.
2. **Native candidate generation must come from the SDK's candidate itself.**
   The linked SDKs expose the ufrag extension on observed paths. A build or
   selected candidate that omits it cannot be attributed by guessing from the
   current description, and keeps the old deadline unless another authoritative
   mapping is available.
3. **Peer-reflexive candidates can be selected on real relayed paths.** A
   prflx candidate with an explicit, matching own-generation ufrag is usable
   evidence. A missing or stale ufrag is not. An Android test exposed a second
   renewal that retained the old Web allocation while new checks failed. The
   bounded address publication in §5.2 supplies missing discovery information;
   it does not turn an old selected path into proof. Final reachable-STUN and
   unreachable-STUN emulator runs each passed three committed renewals with
   exact files. This does not cover every NAT or physical device.
4. **The candidate-to-generation fallback map is keyed on transport address.**
   TCP-active candidates can share that address across generations (§5.2).
   Ambiguous keys remain “unknown”, so they cannot prove renewal without an
   explicit generation from the platform.
5. **Capability is not a blanket compatibility claim.** Web, Windows, Apple
   and Android implement and announce relay-renew/1; shared vectors pin wire
   compatibility. Actual mixed-client, device and network coverage must still
   be stated separately. Existing clients without the capability retain the
   original bounded lifetime.
