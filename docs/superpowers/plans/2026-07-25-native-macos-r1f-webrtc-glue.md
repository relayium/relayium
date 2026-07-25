# Native macOS R1-F (part 3): WebRTC glue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `Realtime` module to `RelayiumKit` — the WebRTC glue that ties together R1-E `Signaling`, R1-F `Handshake`, and R1-F `RealtimeWire` into a live peer-to-peer transfer over an `RTCDataChannel`, using `stasel/WebRTC`. The interop-critical **flow-control credit-window** (`SendWindow`/`AckPacer`) and the **signal encoding** (`RealtimeSignal`) are pure logic and unit-tested; the `RTCPeerConnection`/`RTCDataChannel` wiring (`RealtimeConnection`) is an integration shell that compiles and links but is verified live (two real peers) in the E2E sub-plan, not by unit tests.

**Architecture:** `RealtimeConnection` owns an `RTCPeerConnection` + one `RTCDataChannel`. It exchanges SDP offer/answer + ICE over `SignalingClient` (encoded/decoded by `RealtimeSignal`), attaches the `HandshakeState` commit to every offer/answer and drives the reveal timing (initiator on answer, responder after verifying), and on a verified reveal derives the session keys + SAS. Once the DataChannel opens **and** the handshake completed, it streams `RealtimeSender` frames paced by `SendWindow` (stay ≤ `FLOW_WINDOW` ahead of the peer's ACK) and feeds inbound frames to `RealtimeReceiver`, ACKing durable bytes every `FLOW_ACK_INTERVAL` via `AckPacer`. Version safety is the RealtimeWire legacy-kind rejection (no separate WireVersion field exists in the wire).

**Tech Stack:** Swift 5.9+, `stasel/WebRTC` (binaryTarget xcframework — verified it resolves/links/compiles on this toolchain: `import WebRTC` + `RTCPeerConnectionFactory` builds and runs), XCTest for the pure pieces. Reuses R1-E/R1-F modules.

## This plan's place in R1

R1-F sub-plans: RealtimeWire ✓ → Handshake ✓ → **WebRTC glue (this plan)** → browser↔native E2E. After this, the realtime path exists end-to-end in Swift; the E2E sub-plan proves it against a live browser peer (needs a running signaling server + browser — the user's infrastructure).

## Grounding (verified against the web)

- Realtime signal `data` shape (`web/src/lib/webrtc-core.ts:35-57` `InboundSignal`): `{sdp?, commit?, reveal?{key,nonce}, ice?, busy?, …}`. Offer/answer carry `{sdp, commit}`; ICE carries `{ice}`; the reveal is `{reveal}`; a busy refusal is `{busy:true}`.
- Handshake timing (`web/src/lib/webrtc.ts` connect() — see the R1-F Handshake doc): commit on every SDP; record peer commit before handling a reveal; initiator reveals on the answer; responder reveals after verifying the initiator's reveal; verifyCommit mismatch → abort (never open).
- Flow control (`web/src/lib/transfer-session.svelte.ts`): receiver — after `written` durable bytes, `if (written - lastAckSent >= FLOW_ACK_INTERVAL) { lastAckSent = written; send(ackFrame(written)); }`. Sender — track `sent`/`acked`; `while (sent - acked > FLOW_WINDOW) { await an advancing ack }`; plus DataChannel `bufferedAmount` SCTP backpressure. `parseAck` updates `acked`.
- No `WireVersion` field exists; version compatibility is enforced by `RealtimeReceiver` throwing on legacy kinds (2/3).
- ICE path classification (`webrtc-core.ts:91` `classifyPath`) → "lan"/"p2p"/"relay" from getStats(); optional, for diagnostics.

## Global Constraints

- **Reuse R1-E `SignalingClient`, R1-F `HandshakeState`, `RealtimeSender`/`RealtimeReceiver`/`ackFrame`/`parseAck`/`FLOW_WINDOW`/`FLOW_ACK_INTERVAL`** — do not reimplement. The DataChannel carries `RealtimeWire` frames; the signaling channel carries SDP/ICE/commit/reveal.
- **Flow-control accounting is pure and tested:** `SendWindow` bounds `sent - acked ≤ FLOW_WINDOW`; `AckPacer` emits an ack when `written - lastAck ≥ FLOW_ACK_INTERVAL`. The `RTCDataChannel.bufferedAmount` backpressure is applied in the integration shell (not unit-testable).
- **`stasel/WebRTC` dependency**: `.package(url: "https://github.com/stasel/WebRTC.git", branch: "latest")`, product `WebRTC`. Package.resolved pins the commit for reproducibility.
- **RealtimeConnection is integration-only:** it compiles and links against WebRTC but its behavior is verified by the live E2E sub-plan (two peers), NOT unit tests — the same status as R1-E's real `URLSessionWebSocketChannel`. Callbacks from WebRTC delegates run off the main thread (R1-E contract note) — the connection must be safe to use from its own callback queue; UI hops to main are the caller's job.
- **Threading/actor:** keep it a callback-based reference type (like the rest of RelayiumKit); do not over-engineer actors. Guard shared mutable state (the handshake/flow counters) touched from the WebRTC delegate queue.
- **Min platforms / cadence:** macOS 13, Swift 5.9; commit after every green test cycle; English commit messages.

---

## File structure (R1-F WebRTC glue)

- Modify: `apps/RelayiumKit/Package.swift` — add the WebRTC dependency + link it into the `RelayiumKit` target.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Realtime/SendWindow.swift` — the sender credit-window accounting.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Realtime/AckPacer.swift` — the receiver ack pacing.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeSignal.swift` — SDP/ICE/commit/reveal/busy ↔ JSONValue.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift` — the RTCPeerConnection/DataChannel integration shell.
- Create tests: `SendWindowTests.swift`, `AckPacerTests.swift`, `RealtimeSignalTests.swift`, `WebRTCLinkTests.swift`.
- Create: `docs/protocol/relayium-realtime-flow-v1.md` — freeze the flow-control contract.

---

## Task 1: Add the WebRTC dependency + link smoke test

**Files:** Modify `apps/RelayiumKit/Package.swift`; Create `apps/RelayiumKit/Tests/RelayiumKitTests/WebRTCLinkTests.swift`

**Interfaces:** Produces: `WebRTC` importable in the `RelayiumKit` target; a thin `func webrtcAvailable() -> Bool` proving the framework links.

- [ ] **Step 1: Add the dependency to Package.swift**

Add to `dependencies`: `.package(url: "https://github.com/stasel/WebRTC.git", branch: "latest")`. Add `.product(name: "WebRTC", package: "WebRTC")` to the `RelayiumKit` target's dependencies (alongside `Sodium`).

- [ ] **Step 2: Write the smoke source + test**

Create `apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift` initially with just:
```swift
import Foundation
import WebRTC

/// True once the WebRTC framework is linked and a peer-connection factory can be
/// constructed. A link-time smoke check; the real connection logic is added below.
public func webrtcAvailable() -> Bool {
    RTCInitializeSSL()
    let factory = RTCPeerConnectionFactory()
    let ok = String(describing: type(of: factory)) == "RTCPeerConnectionFactory"
    RTCCleanupSSL()
    return ok
}
```
Create `apps/RelayiumKit/Tests/RelayiumKitTests/WebRTCLinkTests.swift`:
```swift
import XCTest
@testable import RelayiumKit
final class WebRTCLinkTests: XCTestCase {
    func testWebRTCLinks() { XCTAssertTrue(webrtcAvailable()) }
}
```

- [ ] **Step 3: Build + test**

Run (from `apps/RelayiumKit/`): `swift build` (first run downloads the ~44 MB M150 xcframework — allow time), then `swift test --filter WebRTCLinkTests` → PASS. Full `swift test` → all green (the WebRTC download is one-time; existing tests unaffected).

- [ ] **Step 4: Commit**

```bash
git add apps/RelayiumKit/Package.swift apps/RelayiumKit/Package.resolved apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift apps/RelayiumKit/Tests/RelayiumKitTests/WebRTCLinkTests.swift
git commit -m "feat(native): link stasel/WebRTC into RelayiumKit (link smoke test)"
```

---

## Task 2: `SendWindow` — sender credit-window

**Files:** Create `Realtime/SendWindow.swift` + `SendWindowTests.swift`

**Interfaces:**
- `struct SendWindow { init(window: Int = FLOW_WINDOW); mutating func recordSent(_ n: Int); mutating func recordAck(_ acked: Int); var maySend: Bool { get }; var inFlight: Int { get } }`
  - `maySend` = `sent - acked <= window`. `recordAck` takes the cumulative acked total (monotonic; ignore a smaller/stale ack). `inFlight` = `sent - acked`.

- [ ] **Step 1: failing test** `SendWindowTests.swift`:
```swift
import XCTest
@testable import RelayiumKit
final class SendWindowTests: XCTestCase {
    func testBlocksBeyondWindow() {
        var w = SendWindow(window: 100)
        XCTAssertTrue(w.maySend)
        w.recordSent(80); XCTAssertTrue(w.maySend)   // inFlight 80 <= 100
        w.recordSent(40); XCTAssertFalse(w.maySend)  // inFlight 120 > 100
        w.recordAck(50); XCTAssertTrue(w.maySend)    // inFlight 70 <= 100
    }
    func testAckIsMonotonic() {
        var w = SendWindow(window: 100)
        w.recordSent(120); w.recordAck(60); w.recordAck(30) // stale ack ignored
        XCTAssertEqual(w.inFlight, 60)                        // 120 - 60
    }
    func testDefaultWindowIsFlowWindow() {
        var w = SendWindow(); w.recordSent(FLOW_WINDOW); XCTAssertTrue(w.maySend)
        w.recordSent(1); XCTAssertFalse(w.maySend)
    }
}
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** `SendWindow.swift`:
```swift
public struct SendWindow {
    private let window: Int
    private var sent = 0
    private var acked = 0
    public init(window: Int = FLOW_WINDOW) { self.window = window }
    public mutating func recordSent(_ n: Int) { sent += n }
    public mutating func recordAck(_ ackedTotal: Int) { if ackedTotal > acked { acked = ackedTotal } }
    public var inFlight: Int { sent - acked }
    public var maySend: Bool { inFlight <= window }
}
```
- [ ] **Step 4: run → PASS.** Full `swift test` green.
- [ ] **Step 5: commit** `feat(native): Realtime SendWindow credit-window accounting`

---

## Task 3: `AckPacer` + `RealtimeSignal`

**Files:** Create `Realtime/AckPacer.swift`, `Realtime/RealtimeSignal.swift`, `AckPacerTests.swift`, `RealtimeSignalTests.swift`

**Interfaces:**
- `struct AckPacer { init(interval: Int = FLOW_ACK_INTERVAL); mutating func onWritten(total: Int) -> Int? }` — returns the cumulative total to ACK when `total - lastAck >= interval`, else nil (and records it).
- `RealtimeSignal` — build/parse the realtime signal fields on a `JSONValue`:
  - `func sdpSignal(kind: String, sdp: String, commit: String?) -> JSONValue` (kind = "offer"/"answer"; merges `{sdp:{type,sdp}, commit?}`)
  - `func iceSignal(_ candidate: String, sdpMid: String?, sdpMLineIndex: Int32?) -> JSONValue`
  - `func busySignal() -> JSONValue`  → `.object(["busy": .bool(true)])`
  - parsers: `parseSDP(_:) -> (type: String, sdp: String)?`, `parseICE(_:) -> (candidate: String, sdpMid: String?, sdpMLineIndex: Int32?)?`, `parseBusy(_:) -> Bool`, plus reuse Handshake's `peerCommit`/`peerReveal`.

- [ ] **Step 1: failing tests** — `AckPacerTests.swift`:
```swift
import XCTest
@testable import RelayiumKit
final class AckPacerTests: XCTestCase {
    func testAcksAtInterval() {
        var p = AckPacer(interval: 100)
        XCTAssertNil(p.onWritten(total: 50))     // < interval
        XCTAssertEqual(p.onWritten(total: 100), 100)  // reached interval → ack 100
        XCTAssertNil(p.onWritten(total: 150))    // 150-100 < 100
        XCTAssertEqual(p.onWritten(total: 220), 220)  // 220-100 >= 100 → ack 220
    }
    func testDefaultInterval() {
        var p = AckPacer()
        XCTAssertNil(p.onWritten(total: FLOW_ACK_INTERVAL - 1))
        XCTAssertEqual(p.onWritten(total: FLOW_ACK_INTERVAL), FLOW_ACK_INTERVAL)
    }
}
```
`RealtimeSignalTests.swift`:
```swift
import XCTest
@testable import RelayiumKit
final class RealtimeSignalTests: XCTestCase {
    func testSDPWithCommitRoundTrips() {
        let j = sdpSignal(kind: "offer", sdp: "v=0...", commit: "Q29t")
        XCTAssertEqual(parseSDP(j)?.type, "offer")
        XCTAssertEqual(parseSDP(j)?.sdp, "v=0...")
        XCTAssertEqual(peerCommit(from: j), "Q29t")   // commit rides the SDP signal
    }
    func testICERoundTrips() {
        let j = iceSignal("candidate:1 1 udp ...", sdpMid: "0", sdpMLineIndex: 0)
        let c = parseICE(j)
        XCTAssertEqual(c?.candidate, "candidate:1 1 udp ...")
        XCTAssertEqual(c?.sdpMid, "0"); XCTAssertEqual(c?.sdpMLineIndex, 0)
    }
    func testBusy() { XCTAssertTrue(parseBusy(busySignal())); XCTAssertFalse(parseBusy(sdpSignal(kind:"offer",sdp:"x",commit:nil))) }
}
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** `AckPacer.swift`:
```swift
public struct AckPacer {
    private let interval: Int
    private var lastAck = 0
    public init(interval: Int = FLOW_ACK_INTERVAL) { self.interval = interval }
    /// Returns the cumulative durable total to ACK when it has advanced by at least
    /// `interval` since the last ACK; otherwise nil.
    public mutating func onWritten(total: Int) -> Int? {
        guard total - lastAck >= interval else { return nil }
        lastAck = total
        return total
    }
}
```
`RealtimeSignal.swift` — build the `{sdp:{type,sdp}, commit?}`, `{ice:{candidate,sdpMid,sdpMLineIndex}}`, `{busy}` JSONValue shapes matching `web/src/lib/webrtc-core.ts`'s `InboundSignal` (sdp is `RTCSessionDescriptionInit` = `{type, sdp}`; ice is `RTCIceCandidateInit` = `{candidate, sdpMid, sdpMLineIndex}`), and their parsers. `commit` is merged into the SDP object (matching `sdpExtra`). Reuse Handshake's `peerCommit`/`peerReveal`/`revealField`.
- [ ] **Step 4: run → PASS.** Full `swift test` green.
- [ ] **Step 5: commit** `feat(native): Realtime AckPacer + RealtimeSignal encode/decode`

---

## Task 4: `RealtimeConnection` integration shell

**Files:** Modify `Realtime/RealtimeConnection.swift` (replace the smoke stub with the real class)

**Interfaces:**
- `final class RealtimeConnection: NSObject` wiring `RTCPeerConnection` + one `RTCDataChannel` to `SignalingClient` + `HandshakeState` + `RealtimeSender`/`RealtimeReceiver` + `SendWindow`/`AckPacer`. Public surface (indicative):
  - `init(signaling: SignalingClient, peerId: String, role: Role, iceServers: [RTCIceServer])`
  - callbacks: `onSAS: ((String) -> Void)?`, `onOpen: (() -> Void)?`, `onFile(...)`, `onProgress`, `onClose`, `onError`.
  - `func start()` (initiator creates the offer + DataChannel; responder waits for the offer), `func send(files:)`, `func close()`.

- [ ] **Step 1: Implement the shell (no unit test — integration only)**

Build `RealtimeConnection` using `RTCPeerConnectionFactory`, an `RTCPeerConnection` with the ICE config, and `RTCPeerConnectionDelegate`/`RTCDataChannelDelegate`. Wire, per the grounding:
- **Signaling**: subscribe `signaling.onSignal { from, data in if from == peerId { self.handleSignal(data) } }`. `handleSignal` dispatches on `RealtimeSignal`/Handshake parsers: SDP (set remote desc; if offer, create+send answer; record peer commit via `peerCommit(from:)` BEFORE applying, per the handshake ordering), ICE (add candidate), reveal (`peerReveal` → `handshake.verifyPeerReveal` → derive keys+SAS → `onSAS`; responder reveals now).
- **Handshake**: initiator on start creates the DataChannel + offer, attaches `handshake.selfCommitBase64` via `sdpSignal(commit:)`; on receiving the answer, sends `revealField(handshake.reveal())`. Responder attaches its commit to the answer; reveals after verifying the initiator's reveal.
- **DataChannel**: on open + a completed handshake (keys derived), signal `onOpen`. Inbound `didReceiveMessageWith`: `parseAck` → `sendWindow.recordAck`; `parseControl`; else `receiver.feed(...)` → on chunk, write + `ackPacer.onWritten` → send `ackFrame`; on batch/done surface via callbacks.
- **Send** (`send(files:)`): `sender.batchFrame` then stream `dataFrames`, each frame gated by `sendWindow.maySend` AND `channel.bufferedAmount < threshold` (SCTP backpressure); `sendWindow.recordSent(frame.count)` after each `channel.sendData`.
- **Close/error**: tear down the peer connection; map failures to `onError`; `onClose` once.
- Guard the handshake/flow mutable state for access from the WebRTC delegate queue (a serial `DispatchQueue` the connection funnels delegate callbacks through is the simplest correct choice).

Document at the top of the file that this class is integration-tested (live E2E), not unit-tested, and that the pure pieces (`SendWindow`/`AckPacer`/`RealtimeSignal`/`HandshakeState`/`RealtimeWire`) it composes ARE unit-tested.

- [ ] **Step 2: Build**

Run `swift build` → compiles + links against WebRTC. Full `swift test` → all existing tests still green (this task adds no unit tests; the shell is not exercised without a live peer). Confirm the build is warning-free from our files.

- [ ] **Step 3: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift
git commit -m "feat(native): RealtimeConnection integration shell (RTCPeerConnection + DataChannel, live-E2E-verified)"
```

---

## Task 5: Freeze the flow-control contract doc

**Files:** Create `docs/protocol/relayium-realtime-flow-v1.md`

- [ ] **Step 1: Write the doc** — from `transfer-session.svelte.ts` + `transfer.ts`:

```markdown
# Relayium realtime flow-control v1 (authoritative)

Application-level flow control over the DataChannel (which exposes no receive-side
backpressure to the app). Bounds receiver memory and paces the sender to real
disk speed.

## Sender
- Track `sent` (frame bytes handed to the channel) and `acked` (latest ACK value).
- Do NOT send a frame while `sent - acked > FLOW_WINDOW` (8 MiB) — wait for an ACK
  that advances `acked`.
- Also respect the DataChannel's SCTP backpressure: wait while bufferedAmount is
  above the low threshold.

## Receiver
- After writing `written` cumulative durable bytes, send `ackFrame(written)` (KIND_ACK,
  Float64 BE) whenever `written - lastAckSent >= FLOW_ACK_INTERVAL` (512 KiB).
- ACKs are cumulative and monotonic; the sender ignores a stale (smaller) ACK.

## Constants
- FLOW_WINDOW = 8 MiB. FLOW_ACK_INTERVAL = 512 KiB. (transfer.ts.)

## Version safety
- There is no version field. A peer running an older wire sends a legacy frame
  kind (2/3), which the receiver rejects ("older version"), failing closed rather
  than falling back to a plaintext path.
```

- [ ] **Step 2: Commit** — `git add docs/protocol/relayium-realtime-flow-v1.md && git commit -m "docs(protocol): freeze relayium realtime flow-control v1"`

---

## Self-review (against the spec)

- **Spec coverage:** WebRTC dep + link smoke → Task 1; SendWindow credit-window → Task 2; AckPacer + RealtimeSignal → Task 3; RealtimeConnection integration shell (SDP/ICE/handshake/DataChannel/flow driver) → Task 4; flow-control contract doc → Task 5. No WireVersion field (legacy-kind rejection is the version guard — noted).
- **Testability boundary:** SendWindow/AckPacer/RealtimeSignal are pure and unit-tested; RealtimeConnection is integration-only (compiles + links; live E2E in the next sub-plan), the same status as R1-E's real socket channel. This is stated explicitly, not hidden.
- **Placeholder scan:** Task 4 is intentionally described at the interface/behavior level (not full code) because the RTCPeerConnection wiring is large, WebRTC-API-specific, and unverifiable without live peers — the implementer builds it against the WebRTC API to compile, guided by the grounding. Tasks 1-3 and 5 carry complete code/content.
- **Type consistency:** `SendWindow`, `AckPacer`, `RealtimeSignal` funcs defined once; `RealtimeConnection` composes them + reuses `SignalingClient`/`HandshakeState`/`RealtimeSender`/`RealtimeReceiver`/`ackFrame`/`parseAck`/`parseControl`/`FLOW_WINDOW`/`FLOW_ACK_INTERVAL` with existing signatures.

## Interop / correctness safety

The interop-critical pacing (credit-window, ACK interval) is pure and unit-pinned to the exact `transfer-session.svelte.ts` thresholds; the signal encoding matches `webrtc-core.ts`'s `InboundSignal`. The handshake and wire framing are already interop-proven (R1-F Handshake/RealtimeWire). What remains unverifiable until live E2E is only the RTCPeerConnection/ICE/SDP orchestration — inherent to WebRTC, and the reason the E2E sub-plan (browser↔native) exists.

## Next

R1-F E2E (browser↔native): run a native `RealtimeConnection` against a real browser peer through the live `/ws` signaling hub — confirm the SAS matches, the DataChannel opens, and a file transfers both ways byte-for-byte. Needs a running signaling server + a browser (user infrastructure). Then R1-G wires `RealtimeConnection` + `CloudClient` + `Account` into the macOS SwiftUI app.
