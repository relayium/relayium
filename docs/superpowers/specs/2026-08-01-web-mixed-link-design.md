# Web mixed file and text link — batch 10

Date: 2026-08-01
Status: approved design; implementation in progress.
Scope owner: Web LAN and realtime/direct transfer between two `link/1` capable
browser clients. CLI, native-client adoption, stored transfer and server-side
persistence are excluded.

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

### Text lane

A long-lived link no longer has a new connection offer to imply a text request.
Add text-lane `REQUEST` (`0xfa`) and `END` (`0xfb`):

`REQUEST → ACCEPT | REJECT → kind-9 messages → END`

The recipient attaches the protected-message handler only after the user accepts,
and attaches it before sending ACCEPT. END closes only the text conversation, not
the DataChannel or link. Reopening sends a new REQUEST but reuses the link-scoped
text codecs, so nonce sequences continue.

Files may transfer while the text lane is open, and text may be sent while a file
is transferring. Backpressure and `bufferedAmount` checks are lane-local. A hard
text-frame error ends the text lane but not a valid file transfer; a file integrity
failure ends that batch but not the text lane.

## Link glare, lifetime and recovery

At most one link is active globally. The lexicographically smaller peer ID is the
only side allowed to create the link offer. When the larger-ID side acts first it
sends a content-free `{ "linkRequest": true }` signal; the smaller side then
offers. A simultaneous action therefore converges before SDP exists instead of
creating two PeerConnections in the same generation and trying to untangle their
signals afterward. A pending request reserves the one global link slot for that
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

If transport fails during a file batch, rebuild one peer connection with both
channels through the authenticated resume generation. Existing file checkpoint,
chain, flow-control and nonce state continue unchanged. The current text
conversation ends visibly on transport loss and its local transcript remains;
text messages receive no delivery acknowledgement or replay. After file recovery,
the user may open a new text conversation on the resumed link. Text sequence
resynchronisation is deliberately deferred because it would weaken the current
rule that any sequence gap is a hard error.

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
