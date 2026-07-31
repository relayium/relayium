# macOS ephemeral realtime text design

## Outcome

Close the macOS ephemeral-text parity gap without weakening the existing file
transfer path. A signed-in user can mint a text-session pairing code; either a
signed-in or signed-out user can deliberately join that code in text mode.
After the existing commit/reveal handshake and SAS comparison, the receiver
explicitly accepts before either endpoint can exchange exact, in-memory-only
text.

A pairing code does not encode a transfer mode. The macOS UI therefore asks the
joining user to choose files or text instead of guessing from the code.

## Non-negotiable invariants

- Text uses a separate WebRTC signalling generation. Every offer, answer, ICE,
  reveal, and busy response carries `text: true`; file handlers ignore it.
- A text offer is sent only after the peer advertised exact capability
  `text/1`. Both sides also repeat capabilities on offer/answer.
- The existing commit/reveal handshake and SAS remain the authentication
  boundary. Capability hints are not cryptographic inputs.
- The receiver does not decrypt/render a text frame before local acceptance.
  Its receive callback is installed before `ACCEPT` is sent.
- The initiator cannot send text before receiving `ACCEPT`.
- Kind-9 frames use derived `textSend`/`textRecv` keys and independent
  per-direction counters. File framing and counters remain unchanged.
- Bodies, keys, and history are never persisted or logged. Notifications never
  contain a body.
- File and text sessions are mutually exclusive while either is active, so the
  user never has to compare two simultaneous SAS values.
- A stale async connection attempt closes itself and cannot repaint a newer
  state.

## Architecture

### Signalling and connection

Add a typed generation helper to `RealtimeSignal`. Untagged remains `file` for
backward compatibility; `resume` wins over `text` if both untrusted tags appear.
Tag every outbound signal through one helper and reject other generations before
parsing SDP, ICE, commit, reveal, or busy.

The factory advertises local capabilities as a bare roster-level signal and
records lenient peer capability signals during its existing pending-signal
window. A text initiator waits for exact `text/1` before constructing or starting
its connection; timeout becomes an explicit unsupported-peer result. The
responder also advertises capability but accepts only text-generation signals.

`RealtimeConnection` gains an explicit mode rather than inferring mode from
frames. File mode retains its current APIs and byte-for-byte signalling when no
new fields are requested. Text mode owns `RealtimeTextSender` and
`RealtimeTextReceiver`, exposes consent controls and an ordered send method, and
never passes kind 9 through `RealtimeReceiver`.

### Testable session model

`RealtimeTextSessionModel` lives in `RelayiumAppKit` and depends on a narrow
connection protocol. Its states are:

`idle → minting/showingCode or joining → connecting → verifying →`
`incomingRequest or waitingAccept → open → ended/failed/refused/unsupported`.

The model owns only in-memory history and enforces:

- 500 inbound messages;
- 4 MiB inbound framed bytes;
- burst 20, refill 5/s;
- 200 rendered history entries;
- 1 MiB DataChannel buffered-send refusal;
- 10-minute inactivity end;
- serialized send/receive callbacks and generation-safe teardown.

Rejecting a request remembers that peer for the model lifetime. Ending clears
keys/connection but may leave visible local history until the user clears it;
starting a new session clears the previous history.

### macOS UI

The Direct tab exposes two explicit intents: Files and Text. Text has separate
mint/join controls, SAS confirmation, incoming Accept/Reject, multiline native
composer, UTF-8 byte counter, Command-Return send, per-message Copy, Clear, and
End. Copy explains that the clipboard may retain content. The UI states that
Relayium stores no body or server-side history while either endpoint can copy or
retain received text.

The signed-out disclosure permits joining a text code as well as a file code.
Minting remains signed-in because the code owner pays relay traffic.

## Acceptance evidence established before implementation

Focused protocol and state tests:

```sh
cd apps/RelayiumKit
swift test --filter RealtimeText
```

Expected: browser vectors match byte-for-byte; negative crypto, generation,
capability, consent, bounds, stale-callback, and lifecycle cases pass.

Complete shared-kit regression:

```sh
cd apps/RelayiumKit
swift test
```

Expected: all non-opt-in tests pass; only the documented real-Keychain test may
skip.

Native compile:

```sh
xcodebuild -project apps/mac/Relayium.xcodeproj \
  -scheme Relayium -configuration Debug -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO build
```

Expected: `** BUILD SUCCEEDED **`.

Final interoperability evidence requires two live endpoints: macOS↔current Web
in both directions, exact multiline/NUL-safe copy comparison, explicit reject,
oversize refusal, stale/old-peer unsupported behavior, and file-transfer
regression on the same build.
