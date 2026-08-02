# Relayium ephemeral text v1 (authoritative)

Ephemeral, session-scoped messages. Two independent transports carry them and they
do **not** interoperate: the browser/native realtime path (frame kind 9 on a
DataChannel) and the CLI pairing-code path (`MsgText` over pinned TLS). Both are
defined here because both are "text v1"; neither can pair with the other, for the
same reason their file transfers cannot.

Nothing is stored server-side. Messages exist only in the two peers' memory.

## Realtime path (web, native)

Runs after the commit-reveal handshake (relayium-handshake-v1.md) agrees session
keys, on its own signalling generation.

### Keys

Domain-separated from the file stream's keys:

- domain = ASCII `"relayium-text-v1\0"` (18 bytes incl. trailing NUL).
- `textSend = crypto_generichash(32, domain || sharedTx)`
- `textRecv = crypto_generichash(32, domain || sharedRx)`

Unlike the resume-auth key (relayium-crypto-v1.md) the inputs are **not sorted**,
and must not be: that key is shared and so must be symmetric, while these are per
direction. crypto_kx hands the peers mirrored secrets — one side's tx is the
other's rx — so hashing each locally already lines the directions up with no extra
round trip. Sorting would collapse both directions onto one key and put two
producers on one nonce counter.

Why a separate key at all: the file stream's nonce safety rests on exactly one
producer advancing its `seq`. Messages are a second producer, driven by UI events
and interleaving with a generator that suspends at a `yield` it may never resume.
A derived subkey gives the message stream its own counter from 0 and leaves the
file stream's bytes unchanged.

### Frame

- `[kind: 1 byte = 9][seq: uint32 BE][sealed(textKey, seq, utf8Bytes)]`
- TEXT_FRAME_OVERHEAD = 5 + 16 (header + GCM tag).
- Seal = AES-256-GCM, nonce = nonceFromSeq(seq), identical to every other layer.
- `seq` is **per direction, from 0**, monotonic, never rewound, and independent of
  the file stream's counter. A frame consumes exactly one.

### Payload

The message's **UTF-8 bytes and nothing else** — no JSON envelope, no id, no
timestamp. Ids are the seq; timestamps are local and not the peer's business. A
wrapper would be one more place to mangle content that must be preserved
byte-for-byte, and JSON is specifically where lone surrogates and normalisation go
wrong.

- Decode strictly: invalid UTF-8 is a **hard error**, never U+FFFD. Silent
  corruption reported as success is worse than a refusal.
- Nothing is trimmed, normalised, or parsed. Empty, whitespace-only, multiline and
  embedded-NUL bodies are all valid content.
- TEXT_MAX_BYTES = 64\*1024 = 65 536, measured on the **plaintext in UTF-8 bytes**,
  never characters. One message, one frame, no chunking. The on-wire frame is at
  most 65 557 B, well under the 256 KiB DataChannel message ceiling.

### Ordering

The channel is reliable and ordered, so a receiver enforces `seq == expected` and
treats any deviation — gap, repeat, or tampered tag — as a hard error. A gap is not
a network event on this transport; it is tampering or a bug. `expected` advances
only after the AEAD verifies, so a rejected frame leaves the receiver still
expecting the same seq.

There are no acknowledgements and no resume. A message is at most 64 KiB: sent or
not sent. Acks would also be one step from delivery receipts, which this protocol
deliberately does not have.

### Activation handshake

A message session is activated once, explicitly on the wire, before any content
crosses it. It reuses the file protocol's existing single-byte control frames
unchanged (relayium-realtime-wire-v1.md) — no new vocabulary:

- `0xfe` ACCEPT — recipient → initiator, sent once when the recipient's side is
  ready to receive. The initiator may not send a message frame before receiving it.
- `0xff` REJECT — recipient → initiator, sent once when the session is declined;
  the connection is then closed.
- `0xfd` COMPLETE — belongs to the file protocol and has no meaning here. Ignore it.

**ACCEPT is an activation signal, not evidence that a human approved anything.**
A default client sends it automatically once the commit-reveal-complete,
encrypted link is established (handshake per relayium-handshake-v1.md); the
recipient sees the composer, not a prompt. A client with **advanced
verification** enabled holds ACCEPT until the person approves the session — that
is the same place the SAS comparison lives. Both behaviours are conforming and
indistinguishable on the wire, so an implementation
MUST NOT read a received ACCEPT as "someone looked at this". What consent means
on a given surface is decided above this protocol, not by this byte.

"Commit-reveal-complete" is the precise claim and is deliberately not written as
"authenticated": the handshake proves that the key each side revealed matches the
commitment it made first, and AEAD authenticates every frame after that. Neither
establishes that the peer is the *intended* person — only an out-of-band SAS
comparison does, and a default client never asks for one. See
relayium-handshake-v1.md.

This says nothing about the FILE protocol's own accept step, which is a separate
decision about bytes landing on disk. That step is platform-specific: a browser
recipient approves an incoming batch before anything is written, while the native
macOS client accepts the manifest automatically and writes into its configured
destination — Downloads by default. Neither is a confidentiality control — an
unintended recipient who wants the files simply accepts them.

Single-byte control frames are structurally disjoint from a kind-9 frame, which is
at least 21 bytes, so the two can never be confused.

The recipient MUST NOT attach a frame handler before it is ready to accept, and
MUST attach it **before** sending ACCEPT. This ordering is a wire invariant and
holds identically whether ACCEPT was automatic or human-approved.

Both halves are load-bearing, in opposite directions. A message event dispatched on
a DataChannel with no listener attached is **dropped — there is no replay**, so
sending ACCEPT first loses whatever the peer sends the instant it sees it.
Attaching first is also what makes "no content before activation" structural: a
peer that sends before ACCEPT has its frames dropped undecrypted, which is the safe
direction and is also the peer breaking its own session — its seq is consumed, so
the next frame is rejected as out of order. Ordering the two correctly costs
nothing and is not optional.

A message frame arriving before ACCEPT is therefore a protocol error on the
sender's part, not a case the recipient buffers.

### Signalling generation

Message connections tag every signal `text: true`, the same mechanism the resume
generation uses (`resume: true`). A signal's generation is:

```
resume  if signal.resume
text    if signal.text
file    otherwise            ← what every peer predating this sends
```

`resume` takes precedence when both are present. Each side ignores other
generations' signals, so a message offer never reaches a file-transfer listener
and vice versa. Without that isolation a message offer is, to a file listener, an
offer whose manifest never arrives.

The `busy` refusal must carry the generation tag of the offer it refuses, or the
initiator filters it out and waits out its connect timeout instead of failing fast.

### Capability negotiation

Capability name: `text/1`. Matched **exactly** — `text/2` is a different wire.

Announced in two places, doing two different jobs:

1. **Roster level, and this is the one that matters.** A bare signalling frame
   `{"caps": ["text/1"]}` sent to each peer on joining a room and on roster change.
   A peer that never announces is treated as not supporting messages and is never
   offered a connection. This must be known *before* a connection is attempted:
   caps carried only on a connection's own SDP arrive too late to stop an older
   peer from misreading that connection as a file offer.
2. **On the offer and the answer**, alongside `commit`, as the per-connection
   confirmation, so both sides know before the channel opens.

`caps` is **a hint, never a security input**:

- It is outside the resume-auth signed payload (relayium-crypto-v1.md), so adding
  it cannot change any resume tag. Implementations MUST NOT extend that payload.
- The signalling relay sees every frame and can strip it (messages are disabled —
  denial of service) or forge it (a session is offered to a peer that cannot hold
  one — also denial of service). It can never cause plaintext to be sent: the
  message key is **derived**, not negotiated, so no code path downgrades to
  cleartext.
- Parse leniently: absent is not an error, a non-array is ignored, non-string
  entries are dropped rather than trusted.

### Session bounds

Receiver-enforced, and advisory in the sense that they bound resource use rather
than defining the wire. Current values:

| Bound | Value | Purpose |
|---|---|---|
| session messages | 500 | stops a session being used as bulk transport |
| session bytes | 4 MiB | same |
| inbound rate | 20 burst, 5/s | flood guard, shaped after the server's signalling limiter |
| send buffer | 1 MiB | refuse to send above this much already buffered |
| idle | 10 min | no traffic either way ends the session |

There is no credit/window scheme. Messages are human-paced and never touch disk,
so there is no slow consumer to pace against, and a credit loop would mean
acknowledgements.

## CLI path (pairing code)

The CLI shares no transfer code and no crypto with the browser. Confidentiality is
TLS 1.3 with both certificates pinned through the commit-reveal that produces the
SAS (relayium-handshake-v1.md is the browser's variant; the CLI commits to a
certificate fingerprint instead of a crypto_kx public key, and the two SAS
constructions are not interoperable). There is therefore **no application-layer
AEAD on this path** — adding one would duplicate a guarantee the stream already
has.

The pinning and the commit-reveal are unconditional. **Stopping to compare the
SAS is not**: `relayium text` runs without a prompt unless `--verify` is passed,
matching `send`. `--verify` needs a terminal to answer and refuses rather than
proceeding as if it had been confirmed; `--yes` is still accepted, means "never
prompt", and overrides `--verify`. None of that changes a byte on the wire — it
is which value the local user is asked to look at.

### Mode negotiation

The rendezvous commit message gains an optional field:

- `mode` ∈ { absent, `"file"`, `"text"` }, sent on the **commit** — the first
  message either side sends, so intent is known before the reveal, before any TCP
  connection, and before TLS.
- `"file"` is sent as an **absent field**, so a file handshake's commit JSON is
  byte-identical to what peers predating this exchange. JSON decoders ignore
  unknown fields, so such a peer drops `"text"` silently and reports absent.
- Absent normalises to `"file"`.
- Compatible iff both normalise to the same known value. Anything outside the
  known set is incompatible with everything, **including an identical copy of
  itself**: two ends agreeing on a mode neither implements is not agreement.
  Matched exactly — no trimming, no case folding.
- A mismatch is refused before anything is dialed.

### Frame

`[type: 1 byte = 8 (MsgText)][len: uint32 BE][utf8 bytes]` — the existing
`[type][len][payload]` control-frame layout.

- TextMaxBytes = 64\*1024 = 65 536, matching the realtime path.
- A decoder MUST check the length prefix against that cap **before allocating**:
  the prefix is peer-controlled, and the package-wide 8 MiB frame cap is far too
  permissive for a message.
- Invalid UTF-8 is a hard error. Truncation is an error. A clean stream end is
  reported distinguishably from a malformed frame.
- Bodies are exact bytes; empty, whitespace-only, multiline and embedded-NUL
  bodies are valid.

### Session shape

Symmetric: both ends run the same command with the same code. One side may finish
speaking first and half-close; the peer may still be receiving, so **inbound end
of stream does not mean the peer cannot receive** and must not truncate the
sender's remaining input. A bounded wait after half-closing is required so a peer
that never hangs up cannot hang the session forever; the bound is the whole
session's ceiling, not a short additive window, or a reply typed a little later
would be discarded.

Interactive (a terminal) is one line per message; the pipe form sends stdin as one
message, byte for byte. That is a difference in how stdin is **read**, not in the
wire: a terminal cannot distinguish "a newline inside this message" from "send"
without a terminator or a modifier key. Multiline and exact-byte content goes
through the pipe form.

## Not in this protocol

Read receipts, delivery receipts, typing indicators, offline delivery, contacts,
synchronised history, group messaging, message resume, and any server-side
storage. Each would need either durable state or an identity Relayium does not
have.
