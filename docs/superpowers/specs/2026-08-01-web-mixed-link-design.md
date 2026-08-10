# Web mixed file and text link — batch 10

Date: 2026-08-01
Status: approved design; implemented. **Superseded on the release-gate question
only** — see below.
Scope owner: Web LAN and realtime/direct transfer between two `link/1` capable
browser clients. CLI, native-client adoption, stored transfer and server-side
persistence are excluded.

> **Superseded (2026-08-04, extended 2026-08-10).** Every statement below that
> `link/1` is absent from `capsSignal()`/`LOCAL_CAPS` in a default build, and
> every reference to the `VITE_RELAYIUM_LINK_E2E` flag and its `dist-link-e2e`
> bundle, described the pre-release gate. That gate is gone. A default build
> implements `link/1` unconditionally (`LINK_BUILD_SUPPORT`) and now advertises
> and routes it in **every** room — LAN and pairing-code alike
> (`linkRoomActive()`). The LAN-only scope of 2026-08-04 is superseded; what
> replaced it for a relayed link is a bounded lifetime rather than a refusal:
> `relay-deadline.ts` derives a clock-skew-safe boundary from the earliest TURN
> REST username expiry in the room's ICE config, and `mixed-session` warns before
> it, reaches a truthful terminal state at it even with no transport event, and
> never attempts a stale-credential recovery. The ten-minute inactive close
> (`MIXED_LINK_IDLE_MS`) is unchanged and still the only bound a LAN link has.
> Losing signalling alone does not close a healthy DataChannel; it marks recovery
> unavailable, and only a LATER transport loss becomes terminal (`link-recovery.ts`).
> That holds symmetrically, which is the ordinary case rather than the exotic one:
> the far side losing only its WebSocket is precisely what makes the server send
> **us** a `left` frame, so `peerLeft` preserves an established healthy link and
> merely records the peer as absent (`peerPresent` → `recoveryBlock`). Only a
> phase with no authenticated link — an in-flight establishment, an outstanding
> request — is cancelled by that frame, and a link already HELD with no transport
> under it ends at once with `signalingLost` rather than re-offering to an id that
> has left the room (`MixedSession.peerDeparted`).
> One more release rule sits on top of the workspace, in `confirm-send.ts`: a
> queued batch that reaches a `link/1` peer BEFORE any link exists (an OS share,
> or files picked before the code was minted) cannot be released by the send
> confirmation, because that confirmation's only stated instruction is to compare
> a verification code the workspace has not produced yet. Opening the workspace
> builds the link without draining the queue; the release becomes available only
> once that link's SAS is actually on screen.
> The downgrade boundary did NOT move: `peerSupportsLink()` is still an exact
> match, so a peer that does not announce this precise version is never sent a
> speculative two-channel offer. `LOCAL_CAPS` is now the function `localCaps()`,
> sampled per connection so a room switch cannot leave the SDP confirmation
> disagreeing with the roster hello. See DECISION-LOG "Promote the unified Web
> workspace to pairing rooms with a bounded relay lifecycle" (2026-08-10), which
> supersedes "Promote the unified Web peer workspace on LAN before pairing-code
> rooms". Everything else in this document — the protocol, lanes, consent,
> recovery and presentation rules — still holds.

## Problem

The Web client currently treats a file transfer and an ephemeral-text session as
two mutually exclusive products. Each opens its own `RTCPeerConnection`, runs its
own commit-reveal handshake and produces its own six-digit SAS. Keeping a text
session open therefore disables file sending, and sending a file prevents either
side from opening text. A normal file → text → file → text exchange repeatedly
tears down and rebuilds trust and transport state.

Simply removing `busy()` is unsafe. The two connections would show unrelated SAS
values; their one-byte ACCEPT/REJECT frames have no scope; and reusing one set of
file keys while constructing a new `Sender` for each batch would restart the
AES-GCM nonce at zero.

## Product rule

**One connected peer workspace has one authenticated link and one SAS. Files and
ephemeral text use independent lanes inside that link, so either control remains
usable while the other lane is active.**

Incoming file batches retain per-batch consent. Incoming text retains explicit
session consent. Consent never crosses lanes and no protected content is
decrypted or rendered before the relevant acceptance.

## Chosen architecture

Use one `RTCPeerConnection`, one unchanged commit-reveal handshake and two
reliable ordered DataChannels:

| Lane | DataChannel label | Existing wire | Keys |
|---|---|---|---|
| file | `relayium` | kinds 1–8 and file control frames | `send` / `recv` |
| text | `relayium-text` | kind 9 and text control frames | `textSend` / `textRecv` |

The offerer opens both channels through DCEP and the responder collects them by
exact label. The link becomes open only after both channels are open. Do not use
hard-coded out-of-band `negotiated` stream IDs: SCTP stream ownership depends on
the DTLS role, while in-band creation lets the browser allocate conforming IDs.
Channel arrival order is irrelevant because the responder waits for the complete
label-keyed set.

This is preferred over one multiplexed DataChannel because a file lane may hold
up to 8 MiB in its flow window. A shared ordered queue would make a human message
wait behind file chunks and would mix failure domains. Separate SCTP streams also
scope the existing one-byte ACCEPT/REJECT vocabulary without changing its bytes.

Separate per-item peer connections are rejected as the final design. Two fresh
handshakes produce two SAS values; hiding either one weakens authentication.
Reusing the first link's resume key for later connections avoids the second SAS
but still repeats ICE/TURN allocation and introduces independent failure and idle
lifecycles.

## Capability and signalling compatibility

Add exact capability `link/1` beside `text/1` in the roster hello and SDP
confirmation. Add signal generation `link` with `{ "link": true }`; generation
precedence is `resume` > `link` > `text` > legacy untagged `file`.

A link offer may be sent only to a peer that announced `link/1` at roster level.
This gate is required because an older listener treats every unknown offer as a
file offer before it can inspect SDP capabilities. Capabilities remain an
unauthenticated hint: a signalling relay can suppress the feature or cause a
failed offer, but cannot expose plaintext or select weaker keys.

Peers without `link/1`, including current native clients, retain the complete
legacy file and `text/1` paths and their mutual exclusion. The UI explains that an
older peer requires files and messages to be used one at a time. No legacy frame,
key derivation, resume tag or crypto vector changes.

## Trust and nonce invariants

One link owns exactly one ephemeral X25519 key pair, one `SessionKeys`, one SAS
and one commit-reveal. A transport resume reuses those values, authenticates all
resume signalling with `resumeAuth`, and never presents a new SAS.

The following four stateful codecs are created exactly once per link and survive
new batches, text-session close/reopen and transport resume:

- outbound file `Sender`;
- inbound file `Receiver`;
- outbound `TextSender`;
- inbound `TextReceiver`.

Each `(content key, direction)` therefore has exactly one monotonically increasing
nonce sequence for the link lifetime. Starting a second file batch or reopening
text must not reconstruct a codec or reset its sequence. File chain integrity
still resets at each file DONE frame; the nonce sequence does not.

`keys.send` is used only by the link's file sender and `keys.textSend` only by the
link's text sender. The existing domain separation and crypto vectors remain
unchanged.

## Lane state and control

### File lane

Each batch retains the existing sequence: encrypted manifest → explicit consent
→ encrypted chunks/DONE → COMPLETE. One file batch may be active globally in a
link. Further local selections queue in order rather than disabling the file
control.

Add file-lane `BUSY` (`0xf9`) so a transient lane collision is distinguishable
from user rejection. If both sides offer a batch concurrently, the peer with the
lexicographically smaller room peer ID keeps its outbound batch. The other side
accepts the winning inbound offer and retains its own batch in the local queue;
the winner answers the losing manifest with BUSY. Each queued intent is replayed
at most once when the lane becomes idle. Bidirectional simultaneous file batches,
which require batch-scoped ACK/COMPLETE frames, are not part of this version.

The legacy file path used closing the whole PeerConnection as its sender-side
batch-abort marker. A reusable link instead adds sender-to-receiver `BATCH_ABORT`
(`0xf8`). It is an ordered barrier after every protected frame the sender emitted
for that batch. A receiver that rejects or cancels after data starts sends REJECT,
continues authenticating and discarding already-admitted frames, and does not
release the lane until BATCH_ABORT arrives. The sender stops producing protected
frames and emits BATCH_ABORT after seeing that REJECT. The drain is bounded by the
remaining declared bytes and a 30-second inactivity deadline refreshed only by
authenticated drain progress; failure poisons only the file lane. An accepted
receive also has a 60-second no-progress watchdog. A sender consent timeout emits
BATCH_ABORT rather than silently abandoning a manifest, and an abort also removes
a glare-parked inbound offer before it can become a stale prompt. After the ordered
abort, the receiver resets the abandoned file's integrity accumulator but keeps
its monotonically advanced nonce sequence. This preserves
the link-owned receiver nonce sequence without writing or displaying rejected
content. A queued glare loser is replayed once; a second BUSY is a visible terminal
busy result, never an unbounded automatic retry.

Receiver-side flow-control ACKs are accepted only when they strictly advance and
do not exceed bytes actually sent in the current batch. Every batch resets its
ACK cursor. This prevents a delayed or forged cumulative ACK from opening the new
batch's entire receive window. The same upper bound applies to the legacy one-shot
file path. A reusable receiver admits at most two flow-control windows of protected
frames into its serialized JavaScript work queue; exceeding that bound fails only
the file lane instead of allowing an uncooperative peer to grow memory without a
bound. `Receiver.resumeAt()` may move the nonce sequence forward over sent-but-lost
frames but must never move it backwards.

An authenticated DONE whose integrity chain does not match is not COMPLETE. The
receiver shows integrity failure, sends REJECT, and retains the lane until the
sender's ordered BATCH_ABORT resets the abandoned file accumulator. This prevents
the sender from reporting success for a file the receiver rejected.

### Text lane

A long-lived link no longer has a new connection offer to imply a text request.
Add text-lane `REQUEST` (`0xfa`) and `END` (`0xfb`):

`REQUEST → ACCEPT | REJECT → kind-9 messages → END`

The recipient enables protected-message delivery only after the user accepts,
and does so before sending ACCEPT. The always-attached lane demultiplexer rejects
or drains protected frames according to conversation state. END closes only the
text conversation, not the DataChannel or link. Reopening sends a new REQUEST but
reuses the link-scoped text codecs, so nonce sequences continue.

The lane control demultiplexer is always attached, but it never decrypts or stores
protected content before consent. A kind-9 frame received while the conversation
is not open is a hard text-lane protocol failure: the text DataChannel closes and
cannot reopen on that link, while the file lane remains usable. In particular,
content sent after REJECT can never be carried into a later acceptance. Because
END is directional, a side that sends END continues authenticating and accounting
for the prior conversation's already-in-flight frames, but discards their plaintext
until the peer's symmetric END acknowledgement. The acknowledgement is emitted
once per remote END and therefore cannot loop; its ordered arrival closes the drain
window. An ordered REJECT also closes a pending local-END window; because that
REJECT was already sent before a crossing peer END, the refusing side does not
emit a redundant acknowledgement that could collide with a newly reopened
conversation. The drain window has a 30-second timeout that starts only after END
enters the ordered channel; expiry hard-fails only the text lane because safely
reusing its codec sequence can no longer be proven. An incoming prompt ended
before ACCEPT sends REJECT as its complete ordered barrier, needs no drain window,
and may reopen immediately without a stale END acknowledgement cancelling the new
REQUEST. Those frames are never rendered or carried into a later acceptance. A
remote END cancels queued messages before they consume a nonce; encryption already
in flight is sent only to preserve sequence continuity and is shown locally as
failed. An unanswered outbound REQUEST expires after ten minutes by sending END;
an unanswered inbound prompt expires with REJECT. Neither closes the peer link. A
later REQUEST is a new consent decision even when the same user rejected an earlier
conversation. Lifecycle frames are rate-limited independently from protected
messages; protected message count and byte ceilings are prepared for a new
conversation at REQUEST time and become usable only after that conversation is
accepted.

Because lifecycle frames do not yet carry conversation IDs, an END from the
peer's immediately preceding attempt can cross a newly emitted REQUEST. If a
subsequent ACCEPT arrives after that END, the receiver authenticates and discards
the crossing attempt's protected frames until its following ordered END instead
of displaying them or poisoning the reusable codec. This is a fail-closed bridge
for the one-RTT ambiguity; adding authenticated conversation IDs remains the
cleaner future wire revision.

Files may transfer while the text lane is open, and text may be sent while a file
is transferring. Backpressure and `bufferedAmount` checks are lane-local. A hard
text-frame error ends the text lane but not a valid file transfer; a file integrity
failure ends that batch but not the text lane.

## Link glare, lifetime and recovery

At most one link is active globally. The lexicographically smaller peer ID is the
only side allowed to create the link offer. When the larger-ID side acts first it
sends a content-free `{ "link": true, "linkRequest": true }` signal; the smaller
side then offers. A simultaneous action therefore converges before SDP exists
instead of creating two PeerConnections in the same generation and trying to
untangle their signals afterward. A pending request reserves the one global link
slot for that
peer; a link request or offer from another peer receives a generation-matched
busy response and cannot displace the first intent. The request is retried while
waiting because signalling sends during a socket reconnect are best-effort, and
ends with a typed timeout. The first late offer from a timed-out request is
refused with a generation-matched busy response and consumes the stale marker;
a later explicit offer may retry, so a failed UI action cannot unexpectedly open
a link while the peer also cannot be black-holed for the rest of the page session.
The request is capability-gated and is not a security input: forging it can at
most trigger or suppress a connection attempt. Resource admission is checked
before accepting it; file and text consent remain separate. Each side queues its
initiating user intent and replays it exactly once after the link opens.

The 10-minute idle timer moves to link scope. Any lane traffic, active transfer or
pending consent refreshes it; the timer cannot interrupt a file transfer. Room
change, peer departure and explicit disconnect close both lanes and erase keys.
Disconnecting while ICE or commit-reveal is still in progress aborts that attempt
immediately, removes its signal listener and prevents a late connection from
competing with a retry. If SCTP opens but the peer-key reveal never arrives, a
separate bounded authentication timeout closes the transport and makes the link
retryable rather than leaving the workspace permanently in `connecting`.

Closing a text-channel generation after lifecycle flooding does not poison its
codecs. The stage-3 coordinator must request and attach a replacement text
channel before offering another conversation; the lane module deliberately does
not create transports on its own. Before advertising `link/1`, stage 3 must also
provide `canAcceptLink`, choose a mobile-background policy for the conservative
30-second END barrier, and validate how target browsers report `bufferedAmount`
when a DataChannel closes so an unsent protected frame cannot escape codec poison.

If transport fails during a file batch, rebuild one peer connection with both
channels through the authenticated resume generation. Existing file checkpoint,
chain, flow-control and nonce state continue unchanged. The current text
conversation ends visibly on transport loss and its local transcript remains;
text messages receive no delivery acknowledgement or replay. After file recovery,
the user may open a new text conversation on the resumed link. Text sequence
resynchronisation is deliberately deferred because it would weaken the current
rule that any sequence gap is a hard error. A transport-only close maps an active
conversation to a visible ended state and retains the link SAS. Protocol poison
survives every transport generation that reuses the same link-owned codecs. If an
outbound crypto operation consumes a nonce while its transport generation is
being replaced, or an already-admitted inbound frame cannot reach the receiver
codec, that codec is also poisoned: silently dropping either sequence would make
a later conversation fail out of order. Failure state is generation-scoped: a
stale async operation may poison and close its own old codec, but cannot erase a
replacement link's queue, consent prompt, sink or UI state. Attaching or detaching
a replacement while a file batch is active explicitly retires and closes that old
file lane. Because `DataChannel.send()` only queues
bytes, a transport close with protected bytes still buffered poisons the sender
codec as well; lifecycle-only buffered bytes do not.

## Unified workspace UI

For a `link/1` peer, replace separate active file and message surfaces with one
peer workspace:

- a persistent header containing peer name, path, link state, disconnect and the
  one SAS;
- a chronological activity area containing file progress/consent cards, message
  bubbles and system events;
- a persistent composer with text input plus attachment/file-picker and drag/drop
  affordances.

The SAS and the currently required consent remain together in the visible task
area, inheriting batch 9's activity-first document order, one-shot reveal and
polite announcement rules. A long transcript must not scroll the sole SAS out of
the verification context. File selection during a transfer produces an explicit
queued state. Neither lane's content is announced before consent.

Legacy peers keep the existing surfaces and receive a concise compatibility note;
the fallback must be explicit rather than appearing as a random disabled control.

### Entry point and lane availability (2026-08-04)

Wiring the above into App resolved two questions this section had left open.

**One action, not three.** Before a workspace exists, a `link/1` peer in the
code-less LAN room offers exactly ONE primary action (`.open-workspace`, and the
card's pointer shortcut does the same) instead of the file / folder / message
fork. On such a peer that fork asked the user to choose between three things that
all live in the same place; it only decided which surface happened to build the
link first. A queued OS share still outranks it: choosing the peer sends that
explicit outbox rather than discarding it, and never sends a typed draft. Every
pairing-code room and every peer that cannot route `link/1` — older browsers, the
native clients, the CLI — keeps the three controls and their selectors exactly.

While the workspace is active/connecting/interrupted it owns the screen: the
chooser, those per-peer controls and the message-availability hint are hidden,
and Disconnect brings all of them straight back.

**The text lane opens itself once per link.** A link built by the file lane has
no conversation on it, and with the peer card hidden there is nothing left to
click to start one — on either side. So both sides open the text lane
automatically, exactly once per authenticated `linkGeneration`, only when a real
link exists and that lane is idle, and never sending anything. The rule lives in
`web/src/lib/unified-text-open.ts` so its lifecycle cases are testable directly:
an authenticated transport replacement keeps the same generation and must not
retrigger; an ended, refused or failed conversation must not reopen on that same
generation; a new link may open once more. A stale resolution after Disconnect or
a room switch is left to the lane's own `attempt`/`generation` guards, which is
why the orchestration writes no state after the call. Simultaneous opens converge
through the existing `link.role` glare rule into one conversation and one consent
prompt — on whichever side the roles select.

A terminal text lane offers MessagePanel's explicit `onRestart`, scoped to the
current link peer and refused when the link is gone. Clear still clears the
transcript only; Disconnect belongs to the header, and clears App's own draft and
launcher state synchronously as it tears both lanes down.

## Delivery stages

1. Add link protocol documentation, capability/generation routing and a reusable
   dual-channel connection primitive behind tests, with no user-visible routing.
2. Add a link owner/coordinator with link-scoped codecs and nonce-continuity tests;
   adapt file and text state machines while retaining the legacy paths.
3. Enable alternating lanes, queue/glare handling, link-level idle and dual-lane
   file resume for `link/1` peers.
4. Deliver the unified workspace UI, accessibility behavior and explicit legacy
   fallback, then production-validate LAN and relay paths.

Each stage must leave legacy file, resume, text and old-peer E2E scenarios green.
Capability advertisement must not ship until the receiver, both lanes and
recovery behavior are complete enough to honor `link/1`.

### Implementation checkpoint: coordinator wired, capability still off

The capability-off coordinator and App routing boundary are now implemented.
The transport captures a combined, bounded 256 KiB from the instant each mixed
DataChannel is collected, atomically hands those frames to the link owner, and
fails the whole link on overflow or incomplete dual-lane attachment. This closes
the cross-stream DCEP ordering window where one lane may receive data before its
sibling opens. One workspace now owns exact-capability routing, mixed/legacy
resource exclusion, one SAS/path source, link-level idle, explicit disconnect
suppression, peer/room teardown, and independent same-peer file/text controls.
The existing legacy file, resume, text and old-peer browser scenarios remain the
production path and pass unchanged.

In every default and release build `link/1` is absent from both roster and SDP
capability advertisements. Dual-lane file resume, mobile-background text barrier
policy, replacement of a poisoned text channel, the polished unified workspace
and target-browser close semantics remain advertisement gates rather than being
implied by this wiring.

### Implementation checkpoint: unified workspace presentation, capability still off

The `workspace.usingMixed` branch now renders one persistent trust header holding
the peer name, link state, the single path label, the single SAS and an explicit
disconnect. No file or text lane card repeats any of them: the progress card drops
its inline code and path badge, the incoming-consent card keeps only a reveal
anchor, and `MessagePanel` gains a `showSas` prop that defaults to the unchanged
legacy behavior. The polite live region announces a mixed link's SAS on the first
consent edge only, instead of once for the file lane and again for text. Queued
outbound batches are rendered with per-batch cancel controls, so picking files
during a transfer produces a visible queue rather than a disabled control. Files
and text remain independently usable for the linked peer while every other peer
stays blocked.

In every default and release build `link/1` is absent from `capsSignal()` and
`LOCAL_CAPS` — the checkpoint below adds an opt-in, build-time-only seam that
turns it on for the dedicated E2E bundle and nothing else — so the legacy file,
resume, text and old-peer surfaces remain the production path and are unchanged.
Dual-lane file resume, the mobile-background text barrier policy and replacement
of a poisoned text channel remain advertisement gates.

### Implementation checkpoint: announcement lifetime, and a browser path to the unified workspace

The once-per-link announcement rule moved out of `App.svelte` into
`activity-announcement.ts`, and its memory is now keyed on link identity rather
than on the six digits. `MixedSession` publishes a `linkGeneration` that changes
on every establishment and teardown; `PeerWorkspace` re-exports it. A second link
whose SAS collides with the first is therefore a new authentication step and is
read out again, which the previous digit-keyed dedupe would have swallowed —
silently, and only for the screen-reader user who most needs to hear it.

That memory is now spent by *rendering*, not by composing. `announce()` returns a
sentence plus a `confirm()`, and `App` calls `confirm()` only after the flush that
puts the sentence in the live region and only if no newer edge has taken the
region since. The reason is a real race rather than tidiness: an announcement is
a pending state write, so an edge arriving before the next flush replaces it and
the two writes coalesce, leaving the earlier sentence never rendered at all.
Committing at compose time let that unheard sentence spend the once-per-link
allowance, and the edge that actually landed then dropped the code. The trigger
is ordinary: both tabs auto-open the text lane, and the loser of that glare goes
`waitingAccept` → `incomingRequest` inside one flush, so `"Waiting for the other
device to accept…. Verification code NNNNNN"` was composed, coalesced away, and
replaced by a bare `"X wants to send you a message"` — an authenticated link
whose code was never announced. Erring toward repeating a code that was on screen
for one frame is the deliberate trade; losing its only announcement is not.

For the same reason, every product side effect of a unified workspace —
auto-accept, the reveal/announcement edge, and the new-message notification —
reads `surfaceText` (the link's own lane while the workspace owns the screen)
rather than `workspace.text`. That getter deliberately retains a non-idle legacy
transcript so it stays rendered, which is right for the legacy card and wrong for
anything that acts: a retained session must not be able to auto-accept a request
the user was never shown, name the wrong peer in a lock-screen notification, or
read another connection's code out under the linked peer's name. `workspace.text`
is now consulted for one question only — whether legacy history remains to render
outside a mixed workspace.

Both capability announcements now come from one source, `advertisedCaps()`, whose
only enabling input is the build-time constant `VITE_RELAYIUM_LINK_E2E`. Vite
folds it to `false` in every default build, so nothing shipped exposes a runtime
switch; `npm run build:link-e2e` emits a separate `dist-link-e2e` (deliberately
not `dist/`) for `e2e/mixed-link.mjs`. That opt-in browser suite drives two real
tabs through establishment, the one-SAS presentation rule, the 390 px consent
geometry, the sticky header over a long manifest, a visible cancellable queue, a
rejected file batch, an accepted text conversation with byte-identical content,
320 px / RTL / dark layout, and explicit disconnect on both sides. The default
browser suite gained the matching negative assertion: a shipped build advertises
only `text/1` and renders no unified-workspace node.

One scenario there exists purely to guard an ordering hazard. The reveal dedupe
key is peer+lane and carries no link generation, so a second link to the same
peer computes an identical key; if that key survived the teardown it would
suppress the new link's authentication edge before the announcer was ever
consulted. It cannot, because a link is never replaced in place — `establish()`
refuses while one is current — and every SAS-bearing reveal candidate is gated on
a SAS that comes from the link, so the gap always yields a null candidate that
clears the key. The suite pins this by leaving a file consent *unanswered*,
killing its link, and relinking to the same peer: the fresh code must be read out
again. Deleting the one-line reset makes exactly that assertion fail.

Advertisement itself is unchanged: still off, still gated on the remaining items
above.

### Implementation checkpoint: an authenticated dual-lane transport rebuild, still untriggered and capability still off

The link can now be moved onto a new transport without becoming a new link.
`connectResumeLink()` is `connectResume()`'s dual-lane sibling: the same
transport-only `resume` signalling generation, the same mandatory `resumeAuth`
tag on every SDP and ICE message, but it establishes the exact labels `relayium`
and `relayium-text` and is not usable until both are open. Both lanes capture
from the instant each channel is collected, under the same combined
`LINK_CAPTURE_MAX_BYTES` bound the first connection uses, because the peer may
speak on a rebuilt file lane while this side's text lane is still completing
DCEP — and on a rebuild those frames belong to codecs that already exist. The
legacy `connectResume()` is untouched: still one lane, still no capture, so a
resumed one-shot file transfer never waits for a channel an older peer will
never open.

`PeerLinkManager.replaceTransport(peerId, offer?)` is the bounded operation on
top of it. The link it publishes reuses the *same objects* — one `SessionKeys`,
one SAS, one `Sender`, `Receiver`, `TextSender` and `TextReceiver` — and
replaces only the `Conn` and the two channels, so no `(content key, direction)`
sequence restarts and no second SAS can exist. It rebuilds under the role the
link was established with, so the deterministic offerer/responder split survives
a rebuild. It refuses a call for any peer other than the current link's, refuses
when no link is current, and serialises a duplicate call onto the rebuild
already in flight rather than racing a second PeerConnection into the same
lanes.

It fails closed. A transport missing either lane, a cancellation, a completion
that arrives after its link stopped being current, and a transport that reached
a terminal state before it could be attached all close the rebuilt transport and
publish nothing, leaving the caller's link exactly as it was. Capture overflow
additionally fails the whole link, because a dropped admitted frame is the one
thing the reused receiver codecs cannot survive.

The replacement is published atomically through the existing `onLinkChange`
boundary, so both lanes attach to it — retiring whatever the old transport was
carrying — before a single captured frame replays and before the old `Conn` is
closed. Closing that old transport therefore cannot publish null over the link
that is already live: a terminal callback only acts when it still owns
`current.conn`. The same rule makes a stale rebuild inert against a newer one.

Nothing triggers any of this yet, and mixed file lane state is unchanged. The
coordinator that decides *when* to resume — and that must therefore keep a
dropped link current long enough to rebuild it, rather than tearing it down on
the first terminal transport callback as it does today — is stage 3. So
**recovery of an active file batch across a transport drop is still a gate, not
a delivered capability**: checkpoint, chain, flow-control and nonce continuation
across the gap remain unwritten and untested end to end. `link/1` stays absent
from `capsSignal()` and `LOCAL_CAPS` in every default and release build; the
opt-in `VITE_RELAYIUM_LINK_E2E` bundle is unchanged. The remaining advertisement
gates are unchanged too: dual-lane file resume actually driven by a coordinator,
the mobile-background text barrier policy, replacement of a poisoned text
channel, and target-browser `bufferedAmount`-at-close semantics.

### Implementation checkpoint: a transport drop no longer destroys the link, capability still off

The rebuild primitive now has a trigger. `PeerLinkManager` gained one status,
`interrupted`, and one policy hook, `onTransportLost(link)`, asked exactly once
per dead `Conn` while the link is still current. Returning true holds the link:
it stays current with the same `SessionKeys`, the same SAS and the same four
codecs while a replacement transport is built underneath it. Returning false, or
omitting the hook, reproduces the previous unconditional teardown byte for byte.
Only the link's establishment role offers a rebuild; the responder waits, so
there is no rebuild glare and no new signal type. The gap is bounded by
`LINK_RECOVERY_WINDOW_MS` (90 s) with `LINK_RECOVERY_RETRY_MS` (1.5 s) between
initiator attempts, and `close()`, `stop()`, peer departure and window expiry all
cancel the driver and publish exactly one teardown. `ensure()` called during the
gap returns the recovery promise, so an intent raised mid-gap resolves onto the
rebuilt link instead of attaching to a dead one. `establish()` and
`replaceTransport()` no longer share a staleness counter.

An inbound resume offer is verified **in the manager**, against that link's own
`resumeAuth` and over the shared `authPayload`, before it may consume the single
rebuild slot — strictly tighter than letting the connection primitive discover a
bad tag after it has already allocated a PeerConnection. An offer with no tag, a
non-string tag, a tag from another session's keys, a tag over different bytes, an
offer from a peer that is not the link's, or one for a link that is not
interrupted is dropped in silence; answering would tell a signalling relay which
peer holds a link. Two offers in one burst produce one rebuild. Because a mixed
resume offer and a legacy one-shot file resume share the `resume` generation, the
tag — not the tag vocabulary — is what separates them; `blocksLegacyInbound`
stays true across the gap, so the two still cannot coexist for one peer.

**The coordinator's recovery decision is recorded, not sampled.** Both lanes are
suspended first, unconditionally and idempotently, and only then asked whether
they needed recovery. Each lane records that answer at the instant it first
enters the gap, whichever call gets there first. This is not a refinement:
`RTCDataChannel.onclose` may run a lane's own suspend before the
`RTCPeerConnection` reaches a terminal state, and after that suspend the lane's
public `active()` already reads terminal — so a coordinator that inspected
`active()` at policy time would tear down a link that was mid-transfer, on
exactly the browsers that report the channel first. An idle drop still tears down
as before; active file or text work, and a merely queued file batch, all hold.
The held link is not bumped to a new `linkGeneration` and does not re-announce
its SAS, because it is the same authentication step. The idle timer cannot close
an interrupted link.

Recorded is not the same as permanent. A lane that afterwards proves it has
nothing a replacement transport could restore — poisoned codecs, which make
`attach()` refuse a replacement outright, or an idempotent re-attach that finds
its own channel closed — **withdraws** its claim, exactly as the file lane has
since `markLaneFailed`. Only that withdrawal may unrecord the marker: an ordinary
gap, including the `onclose`-before-terminal one this section exists for, keeps
it. Each lane withdraws only its own claim, so a link with a dead text lane and a
live file batch is still held for the file lane. Without this, a text lane whose
gap poisoned it would keep asking for a 90 s window — and, on the initiator, real
ICE/TURN allocations — for a conversation that can never come back.

**The file lane is now explicitly not poisoned by a transport close (I4).** The
rule that "a transport close with protected bytes still buffered poisons the
sender codec" is narrowed to the **text** lane only. The file protocol has a
forward-only nonce *and* a sender-announced resume point; text has neither. In
its place the file lane carries one new protocol rule, using the existing
`KIND_RESUME_START` frame and `Receiver.resumeAt()` — no wire vocabulary changes:

> **I2.** For every file-lane transport generation after the first, each
> direction emits exactly one `RESUME_START` before its first protected frame in
> that generation, and the peer requires exactly one before it will accept a
> protected frame.

The announced point in this slice is always the batch-free origin
`{index: 0, offset: 0, seq}`. That single announcement repairs every gap
condition this slice can produce: an outbound nonce consumed for a frame that
never left the buffer, a frame buffered at close, an inbound frame admitted to
the receive chain but never fed, and the missing `BATCH_ABORT` for the
interrupted batch — the generation boundary *is* that ordered barrier, because no
frame from a retired transport can arrive on the next one. A missing, duplicate,
non-origin or backwards announcement fails the lane, and `resumeAt()` still
refuses to move the receive nonce backwards, so a forged plaintext announcement
can only push a receiver forward into frames it cannot decrypt — denial of
service, never nonce reuse and never an integrity bypass. This removes the
target-browser `bufferedAmount`-at-close advertisement gate **for the file lane**;
text still needs it.

Two ordering hazards were found while pinning this and are worth stating, because
neither is visible from the state machine alone. First, a retired outbound run is
not inert: its `dataFrames` generator reserves its nonce inside async work, so it
can still advance the sender sequence *after* a gap failed its batch — and if the
next generation had already announced its resume point, that announcement would be
one seq short and the peer would reject the first chunk after it. No batch now
starts, and therefore no announcement is emitted, until every earlier outbound run
has returned and can burn nothing more. Second, a receive task retired mid-flight
by the gap fails simply because the gap cleared the state it was about to touch;
poisoning on that path would poison the codecs the replacement is still using.
Poison on a stale path is now keyed on codec identity, which is the only thing
that distinguishes "an old transport generation of the live lane" from "a dead
link's codecs".

The text lane's gap behaviour is unchanged and now reachable without a link
teardown: the conversation ends visibly, the transcript is kept, nothing is
replayed, the SAS is kept, and protected bytes buffered at the close or admitted
but never fed still poison the text codecs only — a later conversation is
permitted exactly when neither fired, while the file lane keeps working.

What this slice deliberately does **not** do: resume bytes. The interrupted batch
fails visibly on both sides and the user re-sends; the retry then runs on the same
link with continuous sequences. Receiver checkpoints, `RESUME_REQ`, sink
continuity across the gap and ACK/window rebase are the next slice, and they plug
into I2's branch.

### Implementation checkpoint: byte-exact file continuation, capability still off

The next slice is now implemented. Once file consent has been granted, a transport
gap pauses the batch instead of retiring it. The receiver keeps the same selected
`SaveTarget` and open `FileSink`, and checkpoints `{index, offset, chain}` only
after `sink.write()` resolves. A write already authenticated by the old generation
is allowed to finish in the shared receive FIFO and advances that checkpoint;
frames admitted behind it but not yet fed are generation-gated away. The
replacement therefore cannot either omit a durable byte or append one twice.

After that old FIFO settles, the receiver sends `RESUME_REQ(index, offset)`. The
sender accepts it only when the point is inside the original manifest, is an
honest fixed-chunk boundary or exact file end, and does not exceed the furthest
logical point actually admitted to an authenticated transport. It then sends the
generation's single `RESUME_START` with the same point and the next forward-only
nonce. The receiver requires an exact match with its own durable checkpoint,
restores the saved chain through `resumeAt()`, and only then accepts protected
chunks. A forged earlier point cannot duplicate an append-only sink; a forged
later point cannot make the sender skip unsent source bytes; a backwards nonce is
still rejected.

Flow control rebases both cumulative cursors to the checkpoint: the sender opens
one new `FLOW_WINDOW` from the durable batch offset, while the receiver's next ACK
is measured from that same offset. Delayed or forged ACKs remain clamped to bytes
emitted by the current attempt. Multi-file boundaries resume at the next file's
zero offset, finalisation remains one-shot, and a lost final `COMPLETE` can replay
the last encrypted DONE without reopening the picker or finalising the target
twice. The sender waits for every retired async run to stop reserving nonces before
it answers the request.

The opt-in real-browser suite now forces both live PeerConnections through a full
terminal event during a 5,242,953-byte file. It proves a replacement transport on
both peers, one save-picker invocation, no second consent, exact byte content, one
unchanged SAS and continued use of the text lane. That run exposed a presentation
bug as well: transport replacement used to advance `linkGeneration`, which made
the next lane edge re-announce the unchanged SAS. Authentication identity now
advances only on establishment/teardown, never when the same keys, codecs and SAS
move to new channels.

One consequence needs a product answer rather than more code: an explicitly
disconnecting peer is indistinguishable from a network drop, so the other side
holds its workspace for up to the full 90 s window and answers a fresh link offer
from that peer with `busy` for its duration. Holding symmetrically is required —
if one side tore down while the other rebuilt, the rebuild offer would arrive at a
peer with no link and both sides would end up with nothing — so the fix is an
explicit "leaving" signal or a visible cancel during recovery, both stage-4 work.
The opt-in browser suite now waits that window out deliberately.

`link/1` remains absent from `capsSignal()` and `LOCAL_CAPS` in every default and
release build, and the default browser suite's negative assertion is unchanged.
The remaining advertisement gates are: the mobile-background policy for both the
90 s recovery window and the 30 s text END
barrier, replacement of a poisoned text channel, target-browser
`bufferedAmount`-at-close semantics for the **text** lane, and a product answer to
the explicit-disconnect window above.

### Implementation checkpoint: an authenticated departure, capability still off

The explicit-disconnect window above now has its answer. A peer that leaves on
purpose says so, with one content-free signal on the existing `link` generation:

```
{ "link": true, "leave": true, "auth": "<base64 HMAC>" }
```

Those three keys are the whole message, and the receiver enforces that by exact
shape before anything else runs. The strictness is not tidiness. This generation
is shared with link establishment, whose signal filter selects on generation
alone, so a `commit` would be recorded by `connectLink`'s `beforeSdp`, a `caps`
array would reach `onPeerCaps`, a `busy` would fail a connecting link, and
`sdp`/`ice` would be handled outright. An allow-listed shape is what makes the
signal provably inert everywhere except in the one handler that owns it.

The tag is keyed by the link's own `resumeAuth` — the same key that authenticates
a transport rebuild, and the only proof a signalling relay cannot forge — but it
covers a **separate** canonical payload, `linkLeavePayload(from, to)`:

```
{"kind":"link-leave","from":"<sender>","to":"<recipient>"}
```

Deliberately not `authPayload`. A message with no SDP and no ICE renders one
constant `authPayload` string for the entire life of a link: a tag with no
direction, replayable either way once seen. The `kind` field also makes the two
payload spaces disjoint, so a signature over one can never be honoured as a
signature over the other; `from`/`to` make a reflected leave verify the reversed
tuple and fail. Cross-link replay needs no nonce, because a later link never
shares `resumeAuth`. `authPayload`'s bytes are unchanged, exactly as its explicit
field list promises, so a rolling deploy computes identical resume tags.

**Only the user's own disconnect announces.** An idle close, a room reset, a peer
that left the roster and page teardown all tear down in silence: none of them is
the user saying "I am done with this peer", and an idle drop is not held by the
peer anyway. Local teardown stays fully synchronous — the signing and the send
are fired inside the same call and never awaited — so Web Crypto or a
reconnecting socket can neither delay nor block a disconnect.

The receiver runs every cheap check before it will spend an HMAC: exact shape, the
fixed 44-character padded-base64 length of a SHA-256 tag, a link is current, the
sender is that link's peer, the status is `open` or
`interrupted`, and the per-link attempt budget is not exhausted. One verification
may be in flight at a time, so a burst costs one HMAC rather than one per
message, and `LINK_LEAVE_MAX_ATTEMPTS` (8) bounds the whole authenticated link's
lifetime. Anything that does not verify is dropped in **silence**, for the reason
a bad resume offer is: a reply would tell a signalling relay which peer holds a
live link. On success the manager runs its ordinary close, which cancels the
recovery window, the retry driver and any rebuild in flight, and publishes
exactly one teardown — no echo, no second event.

Identity across the await is the subtle part, and it is **not** the link object.
`replaceTransport` publishes a different object carrying the same `SessionKeys`,
SAS and four codecs; that is one authentication step, and a leave verified
against those keys is still about that link. Acceptance is therefore gated on the
authenticated-link token plus peer plus `SessionKeys` identity plus an allowed
status — never on the captured object, which a replacement landing mid-HMAC would
have invalidated. A fresh link, even to the same peer with a colliding SAS,
derives new keys and advances the token, so a stale result cannot touch it.

The whole control is **best effort and fails open to the status quo**. A leave
that is lost, suppressed by a relay, or arrives after the budget is spent simply
does not arrive, and the peer falls back to the bounded 90 s recovery window
exactly as before. Nothing depends on it for correctness; it only removes a wait.
The opt-in browser suite's pending-consent disconnect now expects a prompt remote
teardown instead of deliberately waiting that window out, while the window's own
boundedness — expiry, cancellation and the absence of a second teardown — stays
pinned by the manager's fake-timer unit tests.

`link/1` is still absent from `capsSignal()` and `LOCAL_CAPS` in every default
and release build. The remaining advertisement gates are unchanged except that
the explicit-disconnect product answer is now delivered: the mobile-background
policy for the 90 s recovery window and the 30 s text END barrier, replacement of
a poisoned text channel, and target-browser `bufferedAmount`-at-close semantics
for the **text** lane.

## Acceptance matrix

- One link sends file → text → files → text → file with one PeerConnection, one
  SAS and byte-exact content.
- A message sent during a large file transfer is not gated by file-lane buffered
  amount and arrives without waiting behind the file window.
- Two sequential file batches and two reopened text conversations prove strictly
  continuous sequences; any duplicate `(key, seq)` fails the test.
- File consent never grants text consent and text consent never grants file
  consent; no protected body is decrypted or rendered before its own acceptance.
- A malformed text frame does not interrupt an active file batch, and a failed
  file batch does not erase a valid text conversation.
- Simultaneous link requests and simultaneous file offers converge
  deterministically without duplicate intent replay.
- File transfer drop/resume preserves SAS, exact bytes and nonce/checkpoint state;
  the text conversation ends explicitly and can be reopened afterward.
- Missing or malformed `link/1` capability uses the untouched legacy behavior.
- Phone widths, dark mode, Arabic RTL, keyboard order and screen-reader status
  announcements retain visible SAS and consent actions with no horizontal
  overflow or focus movement.
- Relay-only alternating use holds one TURN allocation for the link and the idle
  timer never closes an active or pending lane.

## Explicit non-goals

- CLI `text` or file command unification.
- Native-client `link/1` implementation in this batch.
- Concurrent bidirectional file batches or batch IDs.
- Text acknowledgements, delivery receipts, replay or sequence resync.
- Multiple simultaneous authenticated peer links.
- Stored/offline transfer, server persistence or identity/contact features.
