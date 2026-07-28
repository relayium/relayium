# Native macOS R1-G3 — realtime transfer UI — design

Pair with a code, verify a short phrase, send files peer-to-peer over WebRTC.
Nothing touches the cloud. This is the interaction the product is named for, and
it is the largest round of R1.

## What the Kit already has

The wire is done and proven. R1-E and R1-F landed signaling, the handshake, the
frame codec and the WebRTC glue, byte-pinned to `web/src/lib/transfer.ts`
against golden vectors — feeding web-produced frames into `RealtimeReceiver`
round-trips to the same manifest and bytes the web sender started from. **Interop
at the wire level is already established**; what this round has to prove is
interop of the *flow*.

**Signaling** (`Signaling/SignalingClient.swift`):
`connect(wsBase:code:name:)`, callbacks `onSelfId(peerId, observedIP)`,
`onPeers([Peer])`, `onSignal(from, data)`, `onClose`, plus `sendSignal(to:data:)`
and `close()`. **Join only — it cannot mint a code.**

**Handshake** (`Handshake/HandshakeState.swift`): `init(role:)` exposes
`selfCommitBase64`; `recordPeerCommit(_:)`, `reveal()`, `verifyPeerReveal(_:)` →
`HandshakeResult { keys, sas }`. Errors: `.mitm`, `.noCommitRecorded`,
`.badBase64`, `.invalidKey`. The commit-then-reveal ordering is what makes `.mitm`
detectable rather than advisory.

**Connection** (`Realtime/RealtimeConnection.swift`):
`init(signaling:peerId:role:iceServers:)` — **ICE servers are injected, never
fetched here** — then `start()` and `send(files:)`. Callbacks cover the whole UI
surface: `onSAS(String)`, `onOpen`, `onManifest([FileMeta])`,
`onFileChunk([UInt8])`, `onProgress(Int)`, `onDone(Bool)`, `onControl`,
`onClose`, `onError`. `ConnectionError` includes `alreadySending`.

**Wire** (`RealtimeWire/`): `RealtimeSender.batchFrame(_:)` and
`dataFrames(_:)`; `RealtimeReceiver.feed(_:) -> RealtimeEvent` with
`RealtimeError`.

Two shapes matter for the UI and are worth naming now: progress arrives as a
**byte count**, not a fraction (the total comes from the manifest the app already
holds), and the receiver is handed **chunks, not files** — `onFileChunk` has no
file boundaries, exactly as G2's cloud download did, so the manifest's sizes are
again the only thing that splits the stream.

## The three debts, decided

### (a) Sender memory — fix it, in this round, before the UI

`RealtimeConnection.send(files: [(meta: FileMeta, data: [UInt8])])` takes every
byte of every file in memory, and `RealtimeSender.dataFrames(_:)` materialises
**every frame for the whole transfer** into one array before the first one is
transmitted (`RealtimeConnection.swift:402`). Peak is roughly plaintext plus
ciphertext — about twice the transfer size, with no cap at all: realtime has no
`MaxFileSize` equivalent because no server stores anything.

This is the same defect class G2 shipped and then had to fix under acceptance
(`8e73c669`, `9fa2d88e`), one round after review caught it. Doing it again
knowingly would be worse than doing it the first time by accident.

**Decision: fix it here, as the round's first task group, before any UI.** The
shape follows what G2 established and proved: a `PlaintextSource`-style pull
API and an incremental frame producer, so the sender holds one chunk rather than
one transfer. `ChunkEncryptor` already exists in the Kit for the cloud path and
is the model, not the mechanism — the realtime frame format is different (chained
per-file hash, global seq, CHUNK/DONE pairs), so this is a sibling type rather
than a reuse.

**The golden vectors are the safety rail.** The streaming producer must emit the
byte-identical frame stream `dataFrames` emits, asserted against the same
`realtime-wire-vectors.json` — the same equality test that made G2's
`ChunkEncryptor` safe.

### (b) TURN configuration — fetch it, this round

`GET /api/ice` exists (`server/account/handlers.go:140`,
`server/account/turn.go:59`). Unauthenticated, rate-limited to 5/min per IP,
returns `{iceServers: [...]}`. STUN is always included; **TURN credentials come
back only when `?code=` is a live pairing code**, because relayed bytes are
billed to the code's owner.

The Kit does not call it — `iceServers` is a constructor parameter. Today nothing
supplies TURN, so any pair that cannot connect directly simply fails.

**Decision: add a small `ICEClient` to the Kit and pass the pairing code.**
Without it, "cross-network" is a claim the Mac app cannot honour, and the failure
mode is the worst kind: works on the developer's LAN, fails at a user's house.

The rate limit shapes one design point: fetch **once per pairing attempt**, not
per retry, and pass the fetched list to every connection in that attempt.

### (c) Pairing-code mint — call it, this round, and accept what it implies

`POST /api/pair` exists (`server/main.go:449`,
`server/internal/signal/pairhttp.go:88`) and returns `{code, expiresAt}`. It is
IP rate-limited and **requires authentication** — 401 otherwise — accepting the
`rlm_cli_` bearer the app already holds, which the CLI round added for exactly
this reason.

**Decision: the app mints through it, and the round states the consequence
plainly: creating a code requires being signed in; joining one does not.** That
asymmetry is the server's existing policy — the code's owner pays for any relayed
traffic — not something this round introduces. So a signed-out user can receive
from someone who sends them a code, and cannot start a transfer of their own.
The UI must say that where it happens rather than disabling a button with no
explanation.

## Scope

**In:** streaming sender; `ICEClient`; `PairClient`; a realtime session model
covering pair → handshake → SAS → transfer → done; the SAS comparison UI; the
shell rework; QR display; error copy for the realtime error families.

**Out:** see Non-goals.

## Architecture

The layering is G1's, unchanged, and the split is the same one that has held for
three rounds: everything with a decision in it lives in `RelayiumAppKit` and is
driven by tests; the app target renders and owns nothing.

**`RealtimeSessionModel`** (`RelayiumAppKit`) is the round's centre. One
`@MainActor` `ObservableObject` with an explicit state enum, the operation-identity
guard every model here uses, and no knowledge of SwiftUI:

```
idle
 → minting                     (POST /api/pair — sender only)
 → showingCode(code, expiresAt) (sender waits for a peer)
 → joining(code)                (receiver)
 → connecting                   (ICE, offer/answer)
 → verifying(sas: String)       (both sides compare)
 → transferring(sent: Int, total: Int)
 → done(files: [URL])           (receiver) | done(files: [])  (sender)
 → failed(String)
```

`verifying` is a **blocking** state on both sides: nothing transfers until the
local user confirms. That is the whole point of the SAS, and making it a state
rather than a modal keeps it testable.

The receiver writes chunks straight to disk through a `ManifestWriter`-shaped
type. G2 already built one for the cloud path
(`CloudDownloadModel.swift`) with the same problem — chunks without file
boundaries, split by manifest sizes, sanitized names, partials deleted on
failure. **It is extracted and shared rather than copied**: two copies of a
boundary that decides where bytes land on disk will drift, and one of them will
be the one with the bug.

## UI

### Shell

`ContentView`'s `.ready` branch currently stacks `AccountView`, `UploadPane` and
`DownloadPane` in a `ScrollView` — a deliberate placeholder, since G2 said the
layout rework "belongs to G3, when all three transfer modes exist and the shape is
actually knowable". They exist now.

**Proposal: a three-tab shell — Direct, Link, Account** — split by what the user
is doing rather than by transport:

- **Direct** — realtime. Both roles on one pane: a *Send* affordance that mints a
  code, and a *Receive* affordance that takes one. This is the round's new
  surface.
- **Link** — the cloud panes from G2, unchanged in behaviour: leave a file for
  someone who is not here now.
- **Account** — G1's screen.

The distinction users actually make is "is the other person here right now?", and
that is exactly the line between the two transports. Naming the tabs after the
mechanism (WebRTC / cloud) would ask the user to know things they should not have
to.

### Pairing, SAS, progress

**Sender**: press Send → the app mints → the code is shown large, with its expiry
counting down, alongside a **QR code** (below) — then "waiting for the other
device".

**Receiver**: a six-character field. `pair-code.ts`'s alphabet is 24 characters
(`I`, `O`, `1`, `0` excluded), so input is uppercased and filtered as typed
rather than validated after the fact.

**SAS** is the screen that must not be skimmable. Both devices show the same
short phrase and each asks *"Does the other device show this?"* with an explicit
confirm and a **reject that closes the connection**. The reject path is not
decorative: a mismatch is what a man-in-the-middle looks like, and the Kit's
`HandshakeError.mitm` covers only the cryptographic half.

**Progress** is bytes over the manifest total, with the file list visible so a
multi-file transfer shows which one is moving. **Cancel** is available throughout
and closes the connection; a cancelled receive deletes what it wrote, as G2's
download does.

### QR code — reversing G2's deferral

G2 pushed QR to "G3, when it reworks the layout, where desktop → phone is a case
it genuinely serves". Re-evaluated with the code read rather than from memory:

- **The link form exists.** `web/src/lib/transfer-link.ts` builds a join link
  carrying the code in the fragment (`#c=<code>`), deliberately so it never
  reaches server logs or a Referer header. A phone that opens it lands in the web
  app and joins the room — **no native app and no Universal Links required**.
- **The renderer is free.** `CIQRCodeGenerator` ships with the OS. No dependency,
  no build change.

Desktop → phone is the archetypal realtime transfer, and typing six characters
across devices is the friction QR removes. **Decision: include it**, as a small
task that may be cut if the round runs long — the code itself remains the primary
affordance, and QR is an accelerator beside it.

## Interop acceptance

Wire-level interop is already covered by golden vectors. What is unproven is the
flow: pairing, handshake ordering, SAS agreement, and cancellation.

**Mac ↔ browser, both directions, on one machine.** This is the primary gate and
needs no second device:

1. *Mac sends.* Mint in the app, open `relayium.com/cross-network` in Safari,
   join with the code. Confirm the SAS **strings match on both screens** before
   confirming. Transfer two files, one at least 50 MB. `shasum -a 256` both
   against the originals.
2. *Browser sends.* Mint in the browser, join from the app, same comparison, same
   hash check.

A SAS mismatch here is a stop-everything result, not a retry: it means the two
implementations derive the phrase differently, and every transfer either
implementation has ever accepted was accepted on a phrase nobody could compare.

**Mac ↔ Mac.** Two instances of a `.app` on one machine is not reliable — macOS
treats a second launch of the same bundle as an activation. Verified instead
between **two machines on the same LAN** if a second Mac is available; if not,
the round states that Mac ↔ Mac was not exercised rather than implying it was.
Both peers running the same code makes this the least likely direction to break
and the least informative to test, which is why it is second.

**TURN.** Both directions above run on a LAN and will connect directly, proving
nothing about relay. A separate check forces it: connect the Mac through a
network where direct connection fails (a phone hotspot with the browser peer on
home Wi-Fi), and confirm the transfer still completes. Without this, `/api/ice`
is wired but unproven.

## Testing

**Unit** (`swift test`): every state transition of `RealtimeSessionModel` against
a stubbed connection, including SAS reject, cancel at each stage, and a
superseded callback; the streaming sender's frame stream asserted **byte-identical
to `dataFrames`** and to the golden vectors; the sender's peak buffer asserted
bounded, as `CloudUploaderTests` does; pairing-code input filtering; `ICEClient`
and `PairClient` response decoding including the 401 and 429 paths; the shared
manifest writer's chunk-splitting, already covered and inherited by the
extraction.

**Not unit-testable, and named so it is not mistaken for covered**: WebRTC
connectivity, ICE negotiation, and anything involving a real peer. Those are the
acceptance items above.

## Done when

- `swift test` passes with 0 failures, including the byte-identical frame test.
- Sender peak memory stays bounded for a transfer at least 20× the chunk size,
  measured on `phys_footprint` rather than RSS (G2's lesson).
- Both Mac ↔ browser directions complete with matching SAS and identical hashes.
- The TURN path completes a transfer that cannot connect directly.
- A SAS reject closes the connection on both sides.
- Cancel mid-transfer leaves no partial file and no stuck UI.
- A signed-out user can join a code and receive; the mint path explains why it
  needs an account rather than silently disabling.

## Non-goals

- **Bonjour / LAN peer discovery.** The R1-G decomposition lists it under G3, and
  it is a second pairing mechanism on top of an already-large round. Codes work
  on a LAN today. Deferred, explicitly, rather than dropped.
- **Resume.** `RealtimeEvent` carries a `resume` case and the wire supports it;
  the UI for interrupted transfers is its own design problem.
- **Folder transfers.** `FileMeta.path` exists for files inside a dropped folder,
  and the manifest supports it — but folder recursion, collisions and symlinks
  are the same questions G2 deferred, and the answer has not changed.
- **Universal Links / notifications** — G4. **Notarization** — G5.
- **iOS** — R3.

## Open questions

1. **Tab names.** *Direct* and *Link* describe intent; *Realtime* and *Cloud*
   describe mechanism and match the docs. The first is better for users, the
   second is better for anyone reading the codebase and the marketing copy
   together. This spec proposes the first.
2. **Whether the streaming sender is its own round.** It is a Kit change with
   golden-vector risk, sitting in front of a large UI round. Splitting it would
   give it a clean review; keeping it here avoids a round whose only deliverable
   is a refactor with no user-visible result — the shape G1.5 took, which worked.
3. **Mac ↔ Mac.** Whether a second machine is available decides whether that
   acceptance item is performed or explicitly recorded as not exercised.
