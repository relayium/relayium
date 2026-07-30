# A message is a transfer whose payload never touches disk

Date: 2026-07-30
Status: designed; not yet implemented. Phase 1 of a multi-phase feature.

## Background

The roadmap has carried this since M3: *"extend `send` to stdin, Docker images, the
clipboard — toward 'TCP between developers'"* (`README.md:197`). What users actually
ask for is smaller and more immediate — paste a snippet, a URL, a token, a stack
trace onto the other device without inventing a filename for it.

Relayium already has everything such a feature needs: an authenticated key
agreement anchored against a malicious signaling relay
(`web/src/lib/webrtc.ts:124-186`), a per-frame AEAD with a global nonce counter
(`web/src/lib/crypto.ts:149-182`), a 6-digit SAS the user compares out of band
(`crypto.ts:219-231`), and three shipped transports. This spec is about *not*
building a second version of any of that.

It is also about one thing the repository does not have, which is the whole
difficulty.

## There is no session for a message to live in

The realtime session is scoped to **one transfer**, not to a peer.

- `sendFiles` closes the peer connection in its `finally`:
  `conn?.close()` (`web/src/lib/transfer-session.svelte.ts:701-704`).
- The receiver closes 1.5 s after sending `COMPLETE`:
  `setTimeout(() => conn!.close(), 1500)` (`:459`).
- `keys`, the `Sender`, the `Receiver`, `expectedSeq` and the sink are all
  `let` bindings inside the `sendFiles` / `beginReceive` closures (`:148-161`,
  `:484-494`). After the call returns they are garbage.
- A second transfer therefore runs a **fresh** `connect()` with a **fresh**
  ephemeral keypair (`:148`, `:484`) and produces a **different SAS**.
- One-at-a-time is enforced twice: `busy()` (`:111`) makes the receiver answer
  `{busy: true}` (`:128`) and makes a local send refuse (`:470`).

The product invariants say messages are *session-scoped*, that *multiple*
messages are supported, and that there is *in-session history*. None of those
words has a referent in the current code. A message sent into a transfer-scoped
connection would have nowhere to be a second message.

**So the first substance of this work is not the text feature. It is promoting
the connection from per-transfer to per-peer.** Everything else in this document
is comparatively mechanical.

### The alternative was two SASes, and it is rejected

The cheap version is a second, independent `RTCPeerConnection` for messages,
isolated from the file connection the way the resume generation already isolates
itself (`webrtc-core.ts:277`, `!!msg.resume !== resume`). It needs no refactor.

It also runs its own commit-reveal, so it derives its own keypair and therefore
its own 6-digit code. Two devices would display **two different SAS values at the
same time**, one per card.

That is not merely untidy. The SAS is the only part of Relayium's security that
delegates to the user, and the entire commit-reveal apparatus
(`crypto.ts:184-193`) exists to make those six digits worth comparing. A UI that
shows a user two codes for one pair of devices teaches them that codes are
decoration. The habituation is the vulnerability, and it would be one we
introduced for implementation convenience.

One session, one handshake, one code.

## Architecture

### `PeerLink` — the connection becomes the session

Extract from `transfer-session.svelte.ts` a unit that owns what is currently
owned by two call closures:

```
PeerLink
  peerId, role
  keypair, keys: SessionKeys, sasCode          ← one handshake, one SAS
  pc, fileChannel ("relayium"), textChannel?   ("relayium-text")
  open() / close() / onclose
```

Lifetime: created on first use of a peer — a file send, an accepted file
receive, or opening the message composer — and closed on peer departure, room
exit, navigation, idle timeout, or explicit end. File transfers become
*users* of a link rather than creators of one.

`sendFiles` and `beginReceive` keep their present shape and their present wire
bytes; they take a link instead of calling `connect()`. `busy()` continues to
gate concurrent **transfers**; it stops gating the session, which is what would
let a message be sent during a file transfer.

This is the largest single change in the feature and it is where the risk lives:
`transfer-session.svelte.ts` is 797 lines holding the nonce discipline, the
resume checkpointing and the flow-control gates, and it has **no unit test** —
`transfer-session.test.ts` is 28 lines covering `wouldExceedDeclared` alone.

### Phasing: the refactor is not in phase 1

`PeerLink` is the end state, and phase 1 does not build it. Rewriting that file
to ship the first message would put the riskiest change in the repository and an
entirely new feature in the same release, with the file's own test coverage
unable to tell them apart if something broke.

**Phase 1** gives messaging its **own** connection: its own `connect()`, its own
commit-reveal, its own keys, its own SAS, and a single DataChannel from an
unmodified `establish()`. Its signals are tagged `text: true` and filtered by
generation, reusing exactly the mechanism that already keeps a dying connection
and its replacement from cross-routing each other's SDP (`webrtc-core.ts:277`).
No second channel, no `ondatachannel` change, no line of the file transfer path
touched.

A message session and a file transfer are therefore **mutually exclusive** in
phase 1, enforced by folding the text session into `busy()`
(`transfer-session.svelte.ts:111`), which already refuses a local send and
answers `{busy: true}` to a peer. The two-SAS objection is fully answered by
that exclusion: only one session exists at a time, so only one code is ever on
screen. What is deferred is only the *concurrency* — sending a message while a
file is in flight — which is a convenience, not one of the invariants.

**Phase 2** extracts `PeerLink`, moves both streams onto one handshake and one
SAS, adds the labelled second DataChannel, and lifts the exclusion. It is a
behaviour-preserving refactor plus a deletion, planned separately and gated on
the existing codec suite, `webrtc.test.ts`'s two-party hub and a full
`e2e/lan-transfer.mjs` run.

Two things in phase 1 exist **only** so phase 2 changes no bytes on the wire:
the derived text subkey (which a dedicated connection does not strictly need,
since no file frames share its key) and frame kind 9 (which a dedicated channel
does not strictly need either). Paying for both now means the wire, the protocol
docs and the Swift fixtures are written once.

### Text is its own stream, not a new kind of file frame

Two decisions, both about staying out of the file path's way.

**A separate AEAD key, derived, not negotiated.** Mirroring the resume-auth key
exactly (`crypto.ts:96-116`):

```
TEXT_KEY_DOMAIN = "relayium-text-v1\0"
textSend = crypto_generichash(32, domain || sharedTx)
textRecv = crypto_generichash(32, domain || sharedRx)
```

No sorting, unlike `deriveResumeAuth`: these are directional, and crypto_kx
already mirrors them, so A's `textSend` is B's `textRecv` by construction.

The reason is nonce discipline. `Sender.seq` is a single global counter whose
safety argument is that exactly one producer ever advances it and it never
rewinds (`transfer.ts:172-176`, `:223-229`). Messages are produced by a *second*
producer — a UI event handler, interleaving with an async generator that
allocates its seq immediately before a `yield` it may never resume. Sharing one
key across two producers is precisely the shape in which AES-GCM nonces get
reused. A domain-separated subkey gives text its own counter from 0, and makes
the interleaving question disappear rather than answering it.

It also keeps the file stream's bytes **identical** to today, which is what makes
the Swift and web file implementations compatible across this change.

**A separate DataChannel — in phase 2.** Label `relayium-text`, alongside the
existing `relayium`. Phase 1's dedicated connection already gives text a channel
of its own; this is what happens when the two streams move onto one connection.

The reason is head-of-line blocking. The sender may hold `FLOW_WINDOW` = 8 MiB
of unacked frames (`transfer.ts:67`) *and* up to `BUFFERED_LOW` = 8 MiB in the
SCTP buffer (`webrtc-core.ts:114`). A message queued behind that on the same
stream waits for ~16 MiB to drain — on a TURN-relayed cross-network path, tens of
seconds. Distinct SCTP streams are independently ordered, so a message overtakes
the file bytes rather than queueing behind them.

Three details about *when* and *by whom* it is created, each of which the current
code gets in the way of:

**It cannot be created during `establish`.** `pc.createDataChannel("relayium")`
runs at `webrtc-core.ts:214`, before `createOffer` at `:316` — so the initiator
reaches that line without yet having seen the peer's answer, and therefore
without knowing the peer's capabilities. The text channel is created **after the
handshake completes**, which is legal and cheap: adding a data channel to an
already-negotiated SCTP association needs no renegotiation.

**Either side may create it, and creating it is the request.** A message session
is initiated by whichever user opens the composer, which is not necessarily the
side that initiated the connection. So the text channel is created by the
*requesting* side whenever it opens, and both roles must be prepared to receive
one.

**`ondatachannel` must therefore learn about labels.** Today it is installed only
on the responder and assigns unconditionally (`webrtc-core.ts:216-223`), so a
second channel arriving at a peer running today's build would **overwrite its
file channel reference** mid-transfer. New code installs it on both roles and
dispatches on `ev.channel.label`: `relayium` keeps exactly its present meaning for
the responder, `relayium-text` routes to the message layer, and anything else is
ignored rather than assigned. Old peers are protected not by that filter but by
never being sent a second channel at all, which is what the capability handshake
below is for.

### Wire format

One new kind, `9`, on the text channel only:

```
[kind: 9][seq: uint32 BE][ sealed(textKey, seq, utf8Bytes) ]
```

- The payload before sealing is **the message's UTF-8 bytes and nothing else** —
  no JSON envelope, no id, no timestamp. Ids are the seq; timestamps are local
  and not the peer's business. A wrapper would be one more place to mangle
  content that the invariants require preserved byte-for-byte, and JSON is
  specifically a place where lone surrogates and normalisation go wrong.
- Decode with `TextDecoder("utf-8", { fatal: true })`. Invalid UTF-8 is a hard
  error, not a replacement character: "opaque valid Unicode" is a contract, and
  silently substituting U+FFFD would corrupt content while reporting success.
- The receiver enforces `seq === expectedTextSeq` and throws otherwise, the same
  discipline as `transfer.ts:290`. The channel is reliable and ordered, so a gap
  is not a network event — it is tampering or a bug, and both fail closed.
- `seq` never rewinds, including across the link's lifetime. There is no resume
  for text (see *Reconnect*), so the counter has no restart case at all.

`MANIFEST_MAX_BYTES`, `CHUNK_SIZE`, the control bytes and every existing kind are
untouched. `parseAck` requires exactly 13 bytes and `controlKind` exactly 1
(`transfer.ts:81-104`), so a 5-byte-header text frame cannot be mistaken for
either — and it arrives on a different channel regardless.

### Capability negotiation, and what it is not

Capabilities have to be known **before a connection is attempted**, not during
its handshake. `listenForIncoming` acts on *any* inbound offer
(`transfer-session.svelte.ts:121`) and immediately begins a file receive, so a
connection opened for messaging is, to an older peer, a file offer whose manifest
never arrives — it waits, and its 45 s stall watchdog fails it (`:283-285`).
Caps carried on that connection's own SDP arrive too late to prevent the thing
they exist to prevent.

So there are two announcements, and they do different jobs.

**A roster-level hello, which is the one that protects old peers.** A bare
`signal` frame carrying `{caps: ["text/1"]}` is sent to each peer on joining a
room and on roster change. This is the established pattern, not a new one: relay
RTT maps travel exactly this way (`App.svelte:142-168`), and `rename` rides the
same envelope as a field the WebRTC handlers ignore. A peer that never announces
is treated as not supporting text, and no messaging connection is ever opened
toward it. The cost is a few dozen bytes against the per-connection
`maxSignalBytes` budget of 1 MiB (`internal/signal/connlimit.go:12`), which the
RTT broadcast already draws on.

**The SDP-carried copy, which is the authoritative per-connection one.**
`InboundSignal` gains `caps?: string[]`, attached by `sdpExtra` next to the
commit:

```ts
sdpExtra: () => ({ commit: selfCommit, caps: ["text/1"] })
```

Three properties make this the right slot, all of them already true of the code:

1. **The offer and the answer both carry it.** `send({ sdp: offer, ...sdpExtra?.() })`
   (`webrtc-core.ts:318`) and the answer at `:245`. Both sides therefore know the
   other's capabilities before the channel opens, in the exchange that already
   exists.
2. **Old peers ignore it.** Handlers read named fields only; `caps` joins
   `rename`, `busy` and `relayRtt` as an opaque piggyback the WebRTC layer never
   looks at.
3. **It does not change any signature.** `authPayload` enumerates its fields
   explicitly, and its doc comment says why: *"so what is bound can't drift when a
   new field is added to InboundSignal"* (`webrtc-core.ts:143-157`). Old and new
   clients compute identical resume MACs. Rolling deployment is safe in both
   directions with no version gate.

**`caps` is a hint, never a security input.** The signaling relay sees every
signal in the clear and can strip or forge the field. The threat model:

- **Stripped** → text is disabled and the UI says the peer's app does not support
  it. Denial of service only.
- **Forged onto an old peer** → we open a second DataChannel at a client whose
  `ondatachannel` clobbers its file channel, breaking its transfer. Also denial
  of service, and no new capability: an attacker who can rewrite signals can
  already drop the connection outright.

What `caps` can never do is cause plaintext to be sent. The text key is
*derived*, not negotiated — there is no code path in which a downgrade produces
an unencrypted message, which is the same reason the legacy plaintext kinds are
rejected rather than parsed (`transfer.ts:305-310`).

The one thing `caps` gates is whether a text channel is ever created. Absent
`text/1` from the peer, the composer is unavailable and says the peer's app is
older; no channel is opened, no frame of kind 9 is ever sent, and the peer's
`feed` never reaches its `unknown frame kind` throw (`transfer.ts:311`). **That
throw is the reason this negotiation is not optional**: on today's build it is
routed to `failRecv("recvFail")` (`transfer-session.svelte.ts:301`), so one
optimistic text frame sent to an older peer would kill its file transfer.

### Consent: the first message is a request

The receiving side must accept a message session from a peer before any content
is rendered, exactly as it accepts a file batch today.

This is not symmetry for its own sake. The LAN room is keyed on the **exact
observed public IP** — `RoomKey(r) { return x.IP(r) }`
(`internal/signal/roomkey.go:107-109`) — with a cap of 50
(`server/main.go:29`) and no authentication of any kind on `/ws`. Behind
carrier-grade NAT or a venue's shared address, "the LAN room" contains strangers.
Files are safe there because content only lands after an explicit accept
(`transfer-session.svelte.ts:243-286`). Unsolicited text would arrive and
*render* — a harassment surface with no equivalent today.

So: the **arrival of a text-tagged connection** surfaces as a request naming the
peer and showing **no content** — in phase 2, the arrival of a `relayium-text`
channel. The receiver does not attach `onmessage` until the user accepts; frames
the peer sends immediately queue in the channel and are delivered when the
handler is attached, so nothing is lost and nothing is rendered early. On accept,
the session is open and messages flow freely in both directions with no further
prompting. On reject, the connection is closed and further text-tagged offers
from that peer are refused on arrival for the life of the page. Accepting is
per-session and is not remembered anywhere.

Using the *connection's* arrival as the request — rather than the first frame —
is what makes "no content before consent" structural instead of a rule the
rendering code has to keep remembering. It also means the SAS is on screen before
any message is, which is the order the user needs it in.

### Limits

| Constant | Value | Why |
|---|---|---|
| `TEXT_MAX_BYTES` | `64 * 1024` | One message, one frame, no chunking. 64 KiB of UTF-8 covers any realistic paste of code or logs; the on-wire frame is 65 557 B, far under the 256 KiB DataChannel message ceiling that `CHUNK_SIZE` is also sized against (`transfer.ts:9-13`). Above this it is a file, and the UI says so. |
| `TEXT_SESSION_MAX_MESSAGES` | `500` | Receiver-enforced session bound. |
| `TEXT_SESSION_MAX_BYTES` | `4 << 20` | Receiver-enforced session bound; stops the text channel being used as a bulk transport that skips the file path's accounting. |
| `TEXT_HISTORY_MAX` | `200` | Retained in the UI; older entries drop. Memory bound, not a policy. |
| `TEXT_BURST` / `TEXT_PER_SEC` | `20` / `5` | Receiver-side token bucket, shaped after `signalBurst` / `signalRefillPerSec` (`internal/signal/connlimit.go:13-14`). Exceeding it closes the text channel and reports a flooding peer; the file transfer, on its own channel, is unaffected. |

**All limits are measured in UTF-8 bytes**, never characters, and are enforced on
the plaintext before sealing. The composer's counter shows the same number the
limit uses — a character count would let a Chinese or emoji message be refused
after the user was told it fit.

### Flow control

The file stream needs its elaborate credit scheme because it paces a sender
against a receiver's disk (`transfer.ts:59-66`). Messages need none of it: they
are at most 64 KiB, produced at human speed, and never written to disk, so there
is no slow consumer to pace against and nothing to ACK. Adding a credit loop
would also mean adding acknowledgements, which are one small step from delivery
receipts — excluded by the invariants.

What is still required is the SCTP-level guard the file path also respects. The
sender checks `bufferedAmount` before handing over a frame and, above
`TEXT_SEND_BUFFER_MAX` (1 MiB — sixteen maximum-size messages), refuses the send
and reports it rather than queueing without bound. A peer that has stopped
draining is a peer whose session is over, and the alternative is a growing buffer
of plaintext the user believes was delivered.

The receiver's protection is the rate bucket in the limits table, not a window.
It bounds how fast a hostile peer can drive rendering and history growth, which
is the actual threat on this stream.

### Ordering, duplication, reconnect

The text channel is reliable and ordered, so within a session messages arrive
once, in order, and the strict seq check turns any deviation into a hard failure.

**There is no resume for text, deliberately.** File resume exists because a
half-written 4 GB file is worth saving, and it costs a plaintext `RESUME_REQ`
carrying attacker-injectable integers, guarded by shape checks and an HMAC over
signaling (`transfer.ts:106-146`, `webrtc.ts:200-218`). A message is at most
64 KiB, sent or not sent. Adding a resume path would add unauthenticated
plaintext to the wire in exchange for nothing.

**In phase 1 a dropped connection ends the message session outright.** The text
connection does not use `connectResume`. Locally-held history stays visible,
marked ended; the composer is disabled; a new session can be started, and it will
show a new SAS because it is a new handshake. Messages queued but unsent are
reported unsent — never silently dropped, and never silently resent, because a
resend the user did not ask for is a message delivered twice.

In phase 2 the message session inherits the link's resume for free, and should.
That path re-establishes a connection without re-running the handshake, reusing
the keys the user SAS-verified and authenticating the new signalling with an HMAC
derived from them (`webrtc.ts:200-218`, `transfer-session.svelte.ts:336`, `:344`).
Because the text subkeys derive from those same session keys and the text counters
are monotonic and owned by the link, an authenticated resume can carry the session
forward with its counters unbroken — no rewind, no nonce reuse, and the SAS the
user checked still describes the peer. This is the second reason the subkey and
the frame kind are paid for in phase 1: the resumed session must not need a
different wire.

Server-side reality reinforces this: a peer that loses its **signaling** socket
gets a **new peer id** on reconnect (`internal/signal/client.go:97`,
`server/main.go:44-48`), the room map is destroyed when it empties
(`hub.go:88-93`), and its slot in a 2-peer code room is not freed until the dead
socket's read loop returns — up to `pingInterval + pingTimeout` = 35 s
(`client.go:16-18`). There is no server-side session to resume into.

**Cross-network has a hard ceiling worth stating.** That path forces
`iceTransportPolicy: "relay"` whenever a TURN server is present
(`web/src/App.svelte:117-127`), and TURN credentials are issued with
`TURNCredTTL = time.Hour` (`main.go:410`). A message session held open past that
will lose its allocation. Combined with the relay cost of an idle-but-allocated
session, the link takes an **idle timeout of 10 minutes** with no traffic on
either channel in either direction — a file transfer in progress is traffic, so
this can never interrupt one. It closes as an ordinary session end, unresumed.
This is a cost control, not a security control, and it produces the same state as
any other unresumed drop.

## Metering and cost

There is no per-message or per-byte accounting anywhere on the DataChannel or on
`/ws`. Metering is derived entirely from coturn allocation totals
(`internal/metering/metering.go:81-113`) and node heartbeats
(`account/nodes.go:1210-1346`).

The consequences fall out of the ICE policy rather than out of anything this
feature does: LAN and direct-P2P message bytes are never metered because no TURN
allocation exists; cross-network message bytes traverse coturn and land in
`usage_events` as `Billable: true`, like every other cross-network byte. At
64 KiB a message, this is noise against the file traffic the quota was sized for.
**No new metering, no new quota, no new plan gate.** The room creator remains
the authenticated party exactly as today — minting requires a session
(`internal/signal/pairhttp.go:95-99`), joining is anonymous
(`server/main.go:273-281`) — and text changes nothing about that capability
model.

## Threat model for the new plaintext surfaces

Messages introduce plaintext into places file transfers never put it. Each item
is a decision, not a caveat.

**Rendering.** The app has no HTML injection sink today: zero `{@html}`, zero
`innerHTML` writes in production code, zero `contenteditable`. Message bodies are
rendered as **escaped text nodes through ordinary Svelte interpolation**, with
`white-space: pre-wrap` and `overflow-wrap: anywhere` for layout. No linkifying,
no Markdown, no preview, no syntax highlighting, no auto-detection of anything —
each of those is a parser applied to hostile input, and one of them (autolinking)
would also turn a message into a click target the sender chose. `dir="auto"` per
message body so right-to-left content renders correctly under a left-to-right UI.

**Filenames were already sanitised; messages must not be.** `safeDisplayName`
strips bidi controls and C0/C1 from filenames at the single decode entry
(`transfer.ts:276`, `docs/protocol/relayium-stored-wire-v1.md`). Message content
gets **none** of that: the invariants require exact preservation, and a bidi
override inside a message body is content, not a spoofed filename. The protection
that filenames need — that the string is a *label the user makes a trust decision
against* — does not apply to a message rendered inside a bubble attributed to a
peer. The peer *name*, which is such a label, keeps its existing 64-character
clamp (`App.svelte:603-609`).

**Clipboard.** Copy is an explicit per-message action using the existing
`copyFeedback()` helper (`web/src/lib/clipboard.svelte.ts`), which already has
the right failure rule: on rejection, return false and do not show the ✓, because
a checkmark over a clipboard still holding the previous content is a lie. Two
things follow. Nothing ever calls `navigator.clipboard.readText()` — the app has
never read the clipboard and must not start; paste is handled as a **paste
event**, which delivers only what the user deliberately pasted and triggers no
permission prompt. And the UI states plainly that copying puts plaintext in the
OS clipboard, which other applications can read and which macOS Universal
Clipboard and Windows cloud clipboard synchronise off the device.

**Notifications.** `notifyTransfer` already raises OS notifications
(`App.svelte:269`). Message notifications carry the sender's name and **never a
body** — a notification renders on a lock screen, on a shared display, in a
screen recording.

**Persistence.** History lives in `$state` only. The existing recent-transfers
log is `localStorage`-backed (`App.svelte:87-91`); messages must not enter it, or
anything else durable. `autocomplete="off"` on the composer so form restoration
does not resurrect a draft after a reload. History clears on room exit,
navigation, session end and reload, plus an explicit clear control. The rendered
DOM remains subject to the ordinary browser-level exposures — memory, swap,
screenshots — which no application-level choice can address and which the UI's
ephemerality copy should not overclaim about.

**Observability.** The server cannot observe message content because it never has
it: `Envelope.Data` is `json.RawMessage`, never dereferenced
(`internal/signal/message.go:20`, `hub.go:98-108`), and the signaling package
contains zero `log.` calls. **No server-side observability is added.** Client-side,
the existing `?debug=1` panel may show message counts and byte totals, both of
which it already derives from local `getStats()`; it must never show a body, and
no `console.log`, error message, or thrown `Error` may include message content —
including the failure paths, which is where content most often leaks. Errors
report a byte length and a kind.

## Surface 1 & 2 — web (cross-network room and LAN)

These are one implementation. LAN and cross-network differ only in ICE policy,
room key, peer cap and the sender-side confirm gate; the signaling loop, the
WebRTC establishment, the commit-reveal and the SAS are identical code.

Both routes already render the **same snippet**: `transferSurface`
(`App.svelte:707-808`) is passed as a prop into `CrossPage.svelte` and rendered
at `CrossPage.svelte:57`, and rendered inline for LAN at `App.svelte:873`. The
message panel goes inside that snippet, and both surfaces get it from one
implementation.

**Entry points.**

- A per-peer **Send text** control on the peer card, beside the existing hidden
  file input and its label (`App.svelte:691-702`).
- A **window paste handler**. There is no `onpaste` anywhere in the application
  today — not one — so this is a clean seam. A paste whose `clipboardData`
  carries text, when the event target is not itself an input or textarea, opens
  the composer pre-filled with the pasted text. It does **not** send: pasting is
  not consent to transmit, and a paste is often a mistake.
- The composer itself: the app's **first `<textarea>`** (there are currently
  zero, and zero `contenteditable`).

**Composer behaviour.** Multiline, `white-space: pre-wrap`, no trimming at any
point — not on input, not on send, not on render. A message consisting only of
whitespace is a valid message. A live byte counter reads *bytes used / 64 KiB*
and turns into a blocking state above the limit, with copy naming a file transfer
as the alternative. **Enter inserts a newline; Cmd/Ctrl+Enter sends.** Enter-to-send
is wrong for a feature whose entire point is preserving multiline content.

**History.** Newest-last list, each entry showing direction, a locally-formatted
time, the body, and a copy control. Sent entries show sent/failed. Nothing shows
delivered or read — there are no receipts and the wire carries no acks to build
them from.

**Session state.** The panel shows the peer name, the single `sasCode` with the
existing compare copy, the connection path badge reusing `pathLabel`
(`App.svelte:640`, `.path-{lan|p2p|relay}`), and a session state of
connecting / awaiting the peer's acceptance / open / ended.

**Errors and reconnect.** Failures follow the established pattern exactly:
nothing throws to the UI, every failure becomes a terminal state with an i18n
`StatusKey`, raw errors go to `console.error` only
(`transfer-session.svelte.ts:195-204`, `:682-700`). Signaling reconnect is
untouched; `connState` continues to render in `Hero.svelte:37-63`. Note that the
`flash` toast is rendered **only in the LAN branch** (`App.svelte:866-868`) and
is therefore not available on the cross page — message errors must surface in the
panel, not through `flash`.

**Accessibility.** A `role="log" aria-live="polite"` region announcing arrivals
as sender-plus-body; the composer labelled, with the byte counter wired via
`aria-describedby`; 44 px minimum touch targets per the established
`@media (pointer: coarse)` rule (`App.svelte:1018-1021`); `:focus-visible`
inherited from `app.css:169-174`; the hidden-input-plus-label focus-ring pattern
(`app.css:318-333`) reused for any visually hidden control; every animation
paired with a `prefers-reduced-motion` opt-out, as all six existing animations
are. `DownloadPage.svelte:207-208` records the anti-pattern to respect: do not
put `aria-live` on a value that updates continuously. Discrete message arrivals
are exactly what a polite live region is for; per-keystroke byte counts are not.

**Responsive and RTL.** Logical properties throughout (`text-align: start`,
`margin-inline-*`, `padding-inline-*`) as the rest of the app does; the panel
collapses to full width at the established `max-width: 1024px` breakpoint; the
message list scrolls within its own bounds so the page never scrolls
horizontally. The UI direction follows `dir(lang())`; message bodies use
`dir="auto"` independently.

**Localization.** `Messages` is a hard interface every language must satisfy
(`web/src/lib/i18n/types.ts:28-599`), so a new `text` namespace means editing
`types.ts` **and all nine** of `zh, en, ja, ko, de, fr, ar, es, pt` — the build
fails otherwise. Runtime parity in `i18n.test.ts` is asserted per feature group by
hand, so the new namespace needs its own assertion block or it is unguarded.

**Onboarding.** One line of copy in the panel on first use, saying what
ephemeral means here: not stored on any server, not kept after the session, and
visible on the other device's screen. No tour, no modal, no dismissable banner
to persist.

## Surface 3 — the CLI pairing-code transport

The CLI shares no transfer code and no crypto with the browser. It is
rendezvous over `/ws` (`internal/rzvous/rzvous.go:30-82`), commit-reveal over
**certificate fingerprints** (`internal/rzvous/handshake.go:53-100`,
`internal/secure/crypto.go:60-88`), a direct TCP race
(`internal/connect/direct.go:94-182`), and pinned TLS 1.3
(`internal/secure/channel.go:15-42`). Its SAS hashes hex fingerprints with
SHA-256; the browser's hashes crypto_kx public keys with BLAKE2b. **The two SAS
constructions are not interoperable, and the two transports cannot pair** — a
boundary the pairing-code spec already established and defended
(`docs/superpowers/specs/2026-07-26-cli-pairing-code-design.md:49-62`).

So CLI messaging is **CLI↔CLI**, and browser↔CLI messaging is out of scope for
the same reason browser↔CLI file transfer is.

**No new encryption layer.** The CLI's confidentiality comes from TLS 1.3 with
both certificates pinned through the same commit-reveal that produces the SAS.
Adding an application-layer AEAD would duplicate a guarantee the stream already
has. The web needs its app-layer AEAD because its DTLS fingerprint travels
through a rewritable signaling relay; the CLI pins the fingerprint it committed
to. This asymmetry is the existing design, applied consistently.

**Command.** `relayium text [CODE]` — a new subcommand in the `switch` at
`server/cmd/relayium/run.go:57-98`, with its own flag set registered through
`parseArgs` (`flagperm.go:91-98`, and added to the parser enumeration in
`flagperm_test.go:151`). No code mints one the way `send` does
(`sendpair.go:90-128`); a code joins. Flags mirror `parseCrossFlags`
(`--server`, `--advertise`), plus `--yes` in place of `--verify` — see *SAS*
below, where the polarity is deliberately inverted.

Interactive on a TTY: lines from stdin are messages, received messages print to
stdout, EOF ends the session. Non-interactive: stdin is read to EOF and sent as
one message, which is the `send`-to-stdin shape the roadmap named and the form a
script or a CI job wants.

**The interactive reader is line-oriented, and that is a limitation of the
reader, not of the wire.** A terminal has no way to distinguish "newline inside
this message" from "send this message" without inventing a terminator or a
modifier key, and inventing either would make the common case worse to serve the
rare one. So a multiline block goes through the pipe form —
`pbpaste | relayium text CODE`, a heredoc, `cat snippet.py | relayium text CODE`
— which preserves it byte for byte, exactly as the web composer does. The frame
format is identical either way; only the reader differs. This is written down
because the alternative reading — that the CLI cannot carry multiline content —
is wrong and would otherwise be inferred.

**Capability negotiation belongs in the handshake.** `hsMsg`
(`internal/rzvous/handshake.go:20-26`) gains an optional `mode` field on the
commit. Go's `encoding/json` ignores unknown fields, and `recvHS` validates only
`kind` (`handshake.go:45-47`), so an old binary ignores it. `DoHandshake` returns
the peer's mode; `text` requires `"text"` on both sides and aborts **before the
TLS connection and before any bytes** otherwise, with copy naming the version
mismatch. A new `send`/`receive` seeing `"text"` aborts the same way.

This is the earliest possible detection point and the only compatible one.
The alternatives were both worse and are recorded so they are not revisited:

- **Bumping `WireVersion`** (`internal/xfer/wire.go:10-11`) — checked with strict
  equality and a hard failure (`recv.go:28-30`). It breaks every deployed CLI
  unconditionally.
- **A flag on `Hello`** — `Hello` already carries `Sync` and `Delete` feature
  bits, so it looks like the natural slot. But `xfer`'s protocol is **positional**
  and no call site validates the frame type it reads (`ReadFrame` returns
  `MsgType(hdr[0])` unchecked, `wire.go:99`; every caller discards it —
  `send.go:36`, `recv.go:25`, `:52`, `:69`). An old receiver handed a text frame
  where it expects a manifest would `json.Unmarshal` it into an empty `Manifest`
  and **complete successfully having transferred nothing**. Silent success is the
  worst available failure mode, and the handshake-level check makes it
  unreachable.

**Framing.** Reuse `WriteFrame`/`ReadFrame` with a new `MsgText MsgType = 8`, so
a message is `[8][len uint32 BE][utf8 bytes]`. The existing `maxFramePayload` of
8 MiB (`wire.go:26`) is far too permissive for a message: the text reader caps
the length prefix at `TEXT_MAX_BYTES` **before allocating**, because the prefix is
peer-controlled — the same rule `MAX_FRAME_CT` states for the stored wire.
Invalid UTF-8 is a hard error, matching the web.

**SAS.** Today `crossnetConn` prints the SAS and proceeds; confirmation happens
only under `--verify` (`crossnet.go:57-62`). A file transfer at least presents a
manifest the user can inspect before accepting. A message session has no such
beat, so `relayium text` **requires SAS confirmation by default on a TTY**, with
`--yes` to opt out for scripted use. Non-interactive without `--yes` refuses
rather than proceeding unverified, which is the same "fail fast, do not block a
job on a human" principle the pairing-code spec applied to device login
(`2026-07-26-cli-pairing-code-design.md:131-139`).

**Documentation.** `/cli` (`web/src/lib/CliPage.svelte`) is a static page whose
command strings are hard-coded consts rendered through `CommandBlock.svelte`; the
new command is documented there, in `README.md`, and in a new
`docs/protocol/relayium-text-v1.md`.

## macOS and iOS

`apps/RelayiumKit` already carries a complete second implementation of the
realtime stack — `RealtimeFrame`, `RealtimeSender`, `RealtimeReceiver`,
`HandshakeMessage`, `KeyAgreement`, `Sas`, `RealtimeConnection` — and
`RealtimeReceiver.feed` throws `RealtimeError.unknownKind` on anything it does not
recognise (`RealtimeReceiver.swift:98`). Native implementation is a later phase;
this design constrains it now so the wire does not have to change when it lands:

- `RealtimeKind` gains `text: UInt8 = 9`; the parity table in
  `RealtimeWire/RealtimeFrame.swift:4-14` stays a mirror of `transfer.ts:33-48`.
- `KeyAgreement` gains the `relayium-text-v1\0` derivation.
- `RealtimeSignal` / `HandshakeMessage` gain the optional `caps` array.
- Both fixture sets are regenerated and committed with the web change, because
  both protocol docs require it: `crypto-vectors.json`
  (`docs/protocol/relayium-crypto-v1.md:3-4`) and `realtime-wire-vectors.json`.
  The text key derivation and a sealed text frame become vectors, so the Swift
  port is verified against the web implementation rather than against a reading of
  this document.
- A Swift client with no text support simply omits `text/1` from `caps` and is
  never sent a text channel. Nothing has to ship in lockstep.

The mac app's realtime UI (`apps/mac/Relayium/DirectPane.swift`) is unchanged in
this phase.

## Protocol documentation

`docs/protocol/` is the authoritative, CC BY 4.0 source of truth for ports. This
feature adds `relayium-text-v1.md` and amends three existing docs — the wire doc
for kind 9 and the text channel, the crypto doc for the key derivation, and the
handshake doc for `caps`. The flow-control doc's *Version safety* section, which
currently says there is no version field, becomes accurate rather than obsolete:
there still is none on the file stream, and capabilities are negotiated in the
handshake.

## Testing

**The codec, against the real crypto, the way `transfer.test.ts` already does.**
It uses two real `generateKeyPair()`s and mirrored `deriveSession` calls
(`transfer.test.ts:86-92`) with real `crypto.subtle` — no doubles. The text cases
belong in the same style: round-trip an exact multiline payload with leading and
trailing whitespace, tabs, blank lines, CJK and emoji, and assert **byte
equality**, not string equality after some normalisation. Assert the wire is
opaque, reusing the existing technique of decoding the frame body with a
non-fatal `TextDecoder` and asserting the plaintext is absent
(`transfer.test.ts:344-426`) — and, as that suite already does, include one
positive control so the negative assertions cannot pass vacuously.

**The fail-closed cases are the point, so they get named tests each**: a seq gap;
a tampered tag; invalid UTF-8; a message one byte over `TEXT_MAX_BYTES`; a frame
whose length prefix claims more than the cap, rejected before allocating.

**Key separation, asserted directly.** The text key must not equal either session
key, and a text frame sealed at seq *n* must fail to open under the file key at
seq *n*. This is the property the whole nonce argument rests on, and it is
cheap to pin.

**Compatibility, asserted as a refusal.** A peer whose `caps` omit `text/1`
must produce no text channel and no kind-9 frame. Separately, and this is the one
that matters: `authPayload` output must be **unchanged** by the presence of
`caps`, so an old and a new client compute the same resume MAC. That is the
single assertion standing between this change and broken resumes across a rolling
deploy.

**The file path, proven untouched.** Phase 1 changes no byte of it, so the
guarantee is available as an assertion rather than as a claim: the existing codec
suite and `webrtc.test.ts`'s two-party hub (`webrtc.test.ts:50-102`, which uses
the real HMAC derivation) must pass unmodified, and a full `e2e/lan-transfer.mjs`
run must still complete its byte-exact transfer and its mid-transfer resume. Any
diff to `transfer.ts` or to `transfer-session.svelte.ts` beyond folding the text
session into `busy()` is a signal that the phase boundary was crossed.

**Generation isolation, the way resume already tests it.** `webrtc.test.ts:297-349`
pins that a resume generation and the original cannot cross-route SDP. The
`text: true` generation gets the equivalent: a text-tagged offer must not reach
`listenForIncoming`, and a file offer must not reach the message listener.

**The Go handshake, against the real hub.** `startHub`
(`internal/rzvous/rzvous_test.go:19-39`) runs the real `signal.ServeWS`;
`TestDoHandshakeAbortsOnCommitMismatch` (`handshake_test.go:67-133`) shows how to
drive one side maliciously through the unexported `sendHS`/`recvHS`. Mode
negotiation is tested there: text↔text agrees, text↔absent aborts **before any
TLS connection**, and a `send` facing a text peer aborts too.

**Manual, because WebRTC cannot be fully verified headlessly.** `docs/TESTING.md`
is the existing acceptance script and gains message cases. The e2e script selects
by CSS class and by a nine-language regex over button text, so any class it
touches is now part of the contract.

## Out of scope

- **Browser↔CLI messaging.** The transports cannot pair. Unchanged from files.
- **Message resume.** Argued above: unauthenticated plaintext on the wire for no
  benefit at 64 KiB.
- **Read receipts, delivery receipts, typing indicators, offline delivery,
  contacts, synchronised history.** Excluded by the product invariants, and each
  would require either server-side storage or a durable identity Relayium does
  not have.
- **Files over the text channel, text over the file channel.** Two streams, two
  purposes.
- **Native macOS/iOS text UI.** Constrained here, built later.
- **Server-side observability of messaging.** There is nothing to observe, and
  adding a counter that could distinguish a messaging session from a transfer
  would be the first server-side fact about message activity to exist.
- **Group messaging.** The LAN room holds up to 50 peers, but a link is
  point-to-point and its SAS authenticates exactly two parties. Anything else is
  a different design with a different security model.
