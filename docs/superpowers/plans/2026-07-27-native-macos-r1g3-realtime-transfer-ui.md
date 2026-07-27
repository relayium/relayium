# Native macOS R1-G3 — realtime transfer UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pair with a code, verify a short phrase, and send files peer-to-peer
over WebRTC from the Mac app — with a sender whose memory does not track the
transfer size.

**Architecture:** Kit first, UI second. A streaming frame producer replaces the
whole-transfer materialisation in `RealtimeSender`; two small clients wire up the
`/api/ice` and `/api/pair` endpoints the Kit never called; one `@MainActor`
session model owns pair → handshake → SAS → transfer; the app target renders it
in a three-tab shell.

**Tech Stack:** Swift 5.9 / SwiftPM, XCTest, SwiftUI, WebRTC (via RelayiumKit),
CoreImage (`CIQRCodeGenerator`).

**Spec:** `docs/superpowers/specs/2026-07-27-native-macos-r1g3-realtime-transfer-ui-design.md`

## Global Constraints

- **The golden vectors are the safety rail.** Anything touching frame production
  must keep `RealtimeSenderTests.testFrameStreamMatchesVector` green, and the
  streaming producer must additionally be asserted **byte-identical to
  `dataFrames`** on inputs the vectors do not cover (multi-chunk files).
- **Wire constants are not redefined**: `CHUNK_SIZE = 192 * 1024`,
  `MANIFEST_MAX_BYTES = 200 * 1024` (`RealtimeWire/RealtimeFrame.swift:16,18`).
- **Seq discipline is global and monotonic** across the whole transfer: the
  manifest consumes seq 0, the first chunk seq 1, and every DONE consumes one
  too. A streaming producer that restarts a counter reuses a GCM nonce — the one
  failure in this round that is a break of the encryption, not a bug in it.
- **Sender peak memory is bounded and asserted**, as `CloudUploaderTests` does
  for the cloud path.
- Pairing codes are 6 characters from `ACDEFHJKMNPRTWXY23456789`
  (`web/src/lib/pair-code.ts:8,11`) — no `I`, `O`, `1`, `0`.
- Minting requires authentication; joining does not. The UI explains this rather
  than disabling a control silently.
- Out of scope, do not add: Bonjour discovery, resume UI, folder recursion,
  Universal Links, the `relays` RTT pool (see Task 3).

## File structure

| File | Responsibility |
|---|---|
| `Sources/RelayiumKit/RealtimeWire/RealtimeFrameProducer.swift` | **new** — streaming CHUNK/DONE production |
| `Sources/RelayiumKit/Realtime/RealtimeConnection.swift` | modify — a streaming `send` |
| `Sources/RelayiumKit/Account/ICEClient.swift` | **new** — `GET /api/ice` |
| `Sources/RelayiumKit/Account/PairClient.swift` | **new** — `POST /api/pair` |
| `Sources/RelayiumAppKit/ManifestWriter.swift` | **new** — extracted from `CloudDownloadModel` |
| `Sources/RelayiumAppKit/RealtimeSessionModel.swift` | **new** — the round's centre |
| `Sources/RelayiumAppKit/ErrorCopy.swift` | modify |
| `apps/mac/Relayium/DirectPane.swift` | **new** — pair, SAS, progress |
| `apps/mac/Relayium/ContentView.swift` | modify — three tabs |
| `apps/mac/Relayium/QRCode.swift` | **new** — `CIQRCodeGenerator` wrapper |

Tasks 1–5 are Kit and are fully testable. Task 6 is the model. Tasks 7–10 are UI.
Task 11 is acceptance.

---

### Task 1: `RealtimeFrameProducer` — frames without the whole transfer

`dataFrames(_:)` (`RealtimeWire/RealtimeSender.swift:51`) takes every file's bytes
and returns every frame, so a transfer costs roughly twice its size in memory
before the first byte leaves. This adds a streaming producer beside it. **Nothing
existing changes** — `dataFrames` stays exactly as the golden vectors pin it.

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/RealtimeWire/RealtimeFrameProducer.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeFrameProducerTests.swift`

**Interfaces:**
- Consumes: `PlaintextSource`, `DataSource`, `FileURLSource` (from
  `StoredWire/ChunkEncryptor.swift` — the cloud round built these and they are
  transport-agnostic), `chainHash`, `seal`, `realtimeFrame`, `RealtimeKind`,
  `CHUNK_SIZE`.
- Produces:
  - `public final class RealtimeFrameProducer { init(sender: RealtimeSender, sources: [PlaintextSource]); func next() throws -> [UInt8]? }`
  - `RealtimeSender.nextChunkFrame(_:)` / `nextDoneFrame(hash:)` — internal seq-consuming primitives the producer drives

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumKit

final class RealtimeFrameProducerTests: XCTestCase {
    private func drain(_ p: RealtimeFrameProducer) throws -> [UInt8] {
        var out: [UInt8] = []
        while let f = try p.next() { out += f }
        return out
    }

    /// The load-bearing test: streaming must emit exactly what dataFrames emits.
    /// A stream that differs by a byte is a transfer the web cannot decrypt, and
    /// the golden vectors only cover single-chunk files — this covers the rest.
    func testMatchesDataFramesForMultiChunkFiles() throws {
        let key = [UInt8](repeating: 9, count: 32)
        let a = [UInt8](repeating: 0x41, count: CHUNK_SIZE * 2 + 77)
        let b = [UInt8](repeating: 0x42, count: 13)
        let metaA = FileMeta(name: "a.bin", size: a.count)
        let metaB = FileMeta(name: "b.bin", size: b.count)

        let batch = RealtimeSender(sessionKey: key)
        _ = try batch.batchFrame([metaA, metaB])           // consumes seq 0
        var expected: [UInt8] = []
        for f in batch.dataFrames([(metaA, a), (metaB, b)]) { expected += f }

        let streamed = RealtimeSender(sessionKey: key)
        _ = try streamed.batchFrame([metaA, metaB])        // same seq 0
        let p = RealtimeFrameProducer(sender: streamed, sources: [
            DataSource(name: "a.bin", bytes: a), DataSource(name: "b.bin", bytes: b),
        ])
        XCTAssertEqual(try drain(p), expected)
    }

    /// An empty file still gets its DONE frame — it is in the manifest, and a
    /// receiver counting DONEs against the manifest would stall without it.
    func testEmptyFileStillProducesADoneFrame() throws {
        let key = [UInt8](repeating: 3, count: 32)
        let meta = FileMeta(name: "empty", size: 0)

        let batch = RealtimeSender(sessionKey: key)
        _ = try batch.batchFrame([meta])
        var expected: [UInt8] = []
        for f in batch.dataFrames([(meta, [])]) { expected += f }

        let streamed = RealtimeSender(sessionKey: key)
        _ = try streamed.batchFrame([meta])
        let p = RealtimeFrameProducer(sender: streamed,
                                      sources: [DataSource(name: "empty", bytes: [])])
        XCTAssertEqual(try drain(p), expected)
    }

    /// Memory must not track the transfer. Nothing the producer holds may exceed
    /// one chunk plus the frame it is building.
    func testPeakHeldBytesIsBoundedByOneChunk() throws {
        let key = [UInt8](repeating: 5, count: 32)
        let big = [UInt8](repeating: 0x7E, count: CHUNK_SIZE * 20)
        let s = RealtimeSender(sessionKey: key)
        _ = try s.batchFrame([FileMeta(name: "big", size: big.count)])
        let p = RealtimeFrameProducer(sender: s, sources: [DataSource(name: "big", bytes: big)])
        while let f = try p.next() {
            XCTAssertLessThanOrEqual(f.count, CHUNK_SIZE + 4096,
                                     "a frame larger than one chunk means it buffered")
        }
        XCTAssertLessThanOrEqual(p.peakHeldBytes, CHUNK_SIZE + 4096)
    }

    /// A file read short of its declared size must fail rather than send a DONE
    /// whose hash covers fewer bytes than the manifest promised.
    func testShortReadIsRejected() throws {
        let key = [UInt8](repeating: 1, count: 32)
        let s = RealtimeSender(sessionKey: key)
        _ = try s.batchFrame([FileMeta(name: "x", size: 100)])
        let p = RealtimeFrameProducer(sender: s,
                                      sources: [DataSource(name: "x", bytes: [1, 2, 3])],
                                      declaredSizes: [100])
        XCTAssertThrowsError(try drain(p))
    }

    func testDrainsToNilAndStaysNil() throws {
        let s = RealtimeSender(sessionKey: [UInt8](repeating: 2, count: 32))
        let p = RealtimeFrameProducer(sender: s, sources: [DataSource(name: "s", bytes: [1])])
        XCTAssertNotNil(try p.next())      // CHUNK
        XCTAssertNotNil(try p.next())      // DONE
        XCTAssertNil(try p.next())
        XCTAssertNil(try p.next())
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/RelayiumKit && swift test --filter RealtimeFrameProducerTests 2>&1 | grep -E "error:" | head -3
```

Expected: `cannot find 'RealtimeFrameProducer' in scope`.

- [ ] **Step 3: Write the implementation**

First expose the seq-consuming primitives in `RealtimeSender` — the producer must
drive **the same sender instance**, because seq is global and a second sender
would restart the nonce counter at 0 under the same key:

```swift
    /// One CHUNK frame for `chunk`, consuming the next seq. Internal: the only
    /// supported callers are `dataFrames` and `RealtimeFrameProducer`, which
    /// must share this instance's counter.
    func nextChunkFrame(_ chunk: [UInt8]) -> [UInt8] {
        let s = seq
        seq += 1
        return realtimeFrame(kind: RealtimeKind.chunk, seq: s,
                             payload: seal(key: sessionKey, seq: UInt64(s), plaintext: chunk))
    }

    /// The DONE frame carrying a completed file's chained SHA-256.
    func nextDoneFrame(hash: [UInt8]) -> [UInt8] {
        let plaintext = Array("{\"sha256\":\"\(hash.hexEncodedString)\"}".utf8)
        let s = seq
        seq += 1
        return realtimeFrame(kind: RealtimeKind.doneEnc, seq: s,
                             payload: seal(key: sessionKey, seq: UInt64(s), plaintext: plaintext))
    }
```

Then rewrite `dataFrames` to call them, so there is **one** implementation of
frame production and the golden vectors cover both paths:

```swift
    public func dataFrames(_ files: [(meta: FileMeta, data: [UInt8])]) -> [[UInt8]] {
        var frames: [[UInt8]] = []
        for (_, data) in files {
            var hash = [UInt8](repeating: 0, count: 32)
            var offset = 0
            while offset < data.count {
                let end = min(offset + CHUNK_SIZE, data.count)
                let chunk = Array(data[offset..<end])
                hash = chainHash(hash, chunk)
                frames.append(nextChunkFrame(chunk))
                offset = end
            }
            frames.append(nextDoneFrame(hash: hash))
        }
        return frames
    }
```

Create `RealtimeFrameProducer.swift`:

```swift
import Foundation

/// Streams the CHUNK/DONE frames `dataFrames` returns all at once.
///
/// It drives the caller's `RealtimeSender` rather than owning one: seq is global
/// and monotonic across the whole transfer, and a producer with its own sender
/// would restart the GCM nonce counter at 0 under the same session key — a break
/// of the encryption, not a bug in it.
public final class RealtimeFrameProducer {
    private let sender: RealtimeSender
    private var sources: [PlaintextSource]
    private let declaredSizes: [Int]
    private var index = 0
    private var hash = [UInt8](repeating: 0, count: 32)
    private var readInCurrent = 0
    private var pendingDone = false

    /// Peak bytes held at once. The guard that stops this becoming dataFrames
    /// again by accident.
    public private(set) var peakHeldBytes = 0

    public init(sender: RealtimeSender, sources: [PlaintextSource], declaredSizes: [Int]? = nil) {
        self.sender = sender
        self.sources = sources
        self.declaredSizes = declaredSizes ?? sources.map(\.size)
    }

    /// The next frame, or nil once every source has been read and closed out.
    public func next() throws -> [UInt8]? {
        while index < sources.count {
            if pendingDone {
                let f = sender.nextDoneFrame(hash: hash)
                peakHeldBytes = max(peakHeldBytes, f.count)
                advance()
                return f
            }
            let chunk = try sources[index].read(CHUNK_SIZE)
            if chunk.isEmpty {
                // End of this file. A source that stopped short of what the
                // manifest declared would otherwise send a DONE whose hash
                // covers fewer bytes than the receiver expects.
                guard readInCurrent == declaredSizes[index] else {
                    throw RealtimeSenderError.manifestTooLarge  // replaced in Step 4
                }
                pendingDone = true
                continue
            }
            readInCurrent += chunk.count
            hash = chainHash(hash, chunk)
            let f = sender.nextChunkFrame(chunk)
            peakHeldBytes = max(peakHeldBytes, chunk.count + f.count)
            return f
        }
        return nil
    }

    private func advance() {
        index += 1
        hash = [UInt8](repeating: 0, count: 32)
        readInCurrent = 0
        pendingDone = false
    }
}
```

- [ ] **Step 4: Give the short read its own error**

`manifestTooLarge` is the wrong name for it. Extend the existing enum rather than
inventing a second one:

```swift
public enum RealtimeSenderError: Error, Equatable {
    case manifestTooLarge
    /// A file was shorter than the manifest declared. Sending anyway would ship
    /// a DONE hash the receiver cannot match, failing at the very end.
    case sourceShorterThanDeclared(name: String)
}
```

and throw `.sourceShorterThanDeclared(name: sources[index].name)`.

- [ ] **Step 5: Run the new tests and the vectors**

```bash
cd apps/RelayiumKit && swift test --filter "RealtimeFrameProducerTests|RealtimeSenderTests" 2>&1 | grep -E "Executed .* tests|failed -" | tail -2
```

Expected: 0 failures. `RealtimeSenderTests.testFrameStreamMatchesVector` passing
after the `dataFrames` rewrite is what proves the refactor was behaviour-preserving.

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/RealtimeWire/RealtimeFrameProducer.swift \
        apps/RelayiumKit/Sources/RelayiumKit/RealtimeWire/RealtimeSender.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeFrameProducerTests.swift
git commit -s -m "feat(kit): produce realtime frames one at a time

dataFrames takes every file's bytes and returns every frame, so a transfer cost
roughly twice its size in memory before the first byte left — and realtime has
no MaxFileSize equivalent to cap it, because nothing is stored server-side.

The producer drives the caller's RealtimeSender rather than owning one. Seq is
global and monotonic across a transfer, so a producer with its own sender would
restart the GCM nonce counter at 0 under the same session key: a break of the
encryption rather than a bug in it.

dataFrames now calls the same two primitives, so there is one implementation of
frame production and the golden vectors cover both paths. The equality test
against dataFrames covers what the vectors do not — multi-chunk files, which is
exactly where a streaming rewrite would drift."
```

---

### Task 2: A streaming send path through `RealtimeConnection`

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift:374-409`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeConnectionSendTests.swift`

**Interfaces:**
- Consumes: `RealtimeFrameProducer` (Task 1).
- Produces: `public func send(sources: [PlaintextSource], metas: [FileMeta])`

- [ ] **Step 1: Read the existing send path first**

`sendOnSendQueue` builds the batch frame, waits for the receiver's accept
(`waitForAccept()`), then loops `sender.dataFrames(files)` through `transmit`.
The streaming version changes **only** the loop — the accept wait, the closed
checks and the error routing stay exactly as they are. Read lines 386-409 before
editing; this task is a substitution inside an existing structure, not a rewrite.

- [ ] **Step 2: Write the failing test**

```swift
    /// The streaming path must transmit the same frames in the same order as
    /// the array path, or the receiver's seq check rejects the transfer.
    func testStreamingSendTransmitsTheSameFrames() throws {
        // Drive RealtimeFrameProducer and dataFrames over identical inputs and
        // compare the concatenated streams, as Task 1 does — but through the
        // connection's own framing helper, so a change to how the connection
        // slices or orders frames is caught here rather than in acceptance.
    }
```

Write it against whatever seam the connection exposes after Step 3; if none is
reachable without a live peer, **say so in the commit** and rely on Task 1's
equality test plus acceptance rather than inventing a fake `RTCDataChannel`.

- [ ] **Step 3: Write the implementation**

```swift
    /// Streaming send: reads each file as it goes rather than taking every byte
    /// up front. `metas` is what the receiver sees; `sources` must be in the
    /// same order.
    public func send(sources: [PlaintextSource], metas: [FileMeta]) {
        let alreadyStarted = queue.sync { () -> Bool in
            if self.sendStarted { return true }
            self.sendStarted = true
            return false
        }
        guard !alreadyStarted else {
            queue.async { [weak self] in self?.onError?(ConnectionError.alreadySending) }
            return
        }
        sendQueue.async { [weak self] in self?.streamOnSendQueue(sources: sources, metas: metas) }
    }

    private func streamOnSendQueue(sources: [PlaintextSource], metas: [FileMeta]) {
        do {
            guard transmit(try sender.batchFrame(metas)) else { return }
            guard waitForAccept() else { return }
            let producer = RealtimeFrameProducer(sender: sender, sources: sources,
                                                 declaredSizes: metas.map(\.size))
            while let frame = try producer.next() {
                if queue.sync(execute: { self.closed }) { return }
                guard transmit(frame) else { return }
            }
        } catch {
            queue.async { [weak self] in self?.onError?(error) }
        }
    }
```

Keep the existing `send(files:)` — the tests and any caller that already has
bytes in hand still work, and deleting it would churn the golden-vector tests for
no gain.

- [ ] **Step 4: Verify**

```bash
cd apps/RelayiumKit && swift test 2>&1 | grep -E "Executed [0-9]+ tests" | tail -1
```

Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeConnectionSendTests.swift
git commit -s -m "feat(kit): stream a realtime send instead of materialising it

Only the loop changes: the batch frame, the accept wait, the closed checks and
the error routing are the existing ones, because they are the parts a live peer
exercises and this round has no way to re-prove them in a unit test.

send(files:) stays. Callers that already hold bytes are not wrong, and deleting
it would churn the golden-vector tests to no purpose."
```

---

### Task 3: `ICEClient`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Account/ICEClient.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/ICEClientTests.swift`

**Interfaces:**
- Produces:
  - `public struct ICEServerConfig: Codable, Equatable { public let urls: [String]; public let username: String?; public let credential: String? }`
  - `public protocol ICEConfigClient { func fetch(code: String) async throws -> [ICEServerConfig] }`
  - `public struct HTTPICEClient: ICEConfigClient`

- [ ] **Step 1: Write the failing test**

```swift
    /// The server's field names, and the optional halves that are absent for
    /// STUN-only entries.
    func testParsesMixedStunAndTurnEntries() throws {
        let json = """
        {"iceServers":[{"urls":["stun:stun.example:3478"]},
                       {"urls":["turn:turn.example:3478"],"username":"u","credential":"c"}]}
        """.data(using: .utf8)!
        let s = try parseICEServers(json)
        XCTAssertEqual(s.count, 2)
        XCTAssertNil(s[0].username)
        XCTAssertEqual(s[1].credential, "c")
    }

    /// `relays` and `relayDenied` may be present; ignoring them must not break
    /// decoding, because this round deliberately does not implement the pool.
    func testIgnoresTheRelayPoolFields() throws {
        let json = """
        {"iceServers":[{"urls":["stun:s:3478"]}],"relays":[{"id":"r1"}],"relayDenied":"quota"}
        """.data(using: .utf8)!
        XCTAssertEqual(try parseICEServers(json).count, 1)
    }

    /// A response with no servers is a configuration failure, not an empty
    /// success: connecting with no ICE servers fails later and more obscurely.
    func testEmptyServerListIsRejected() {
        XCTAssertThrowsError(try parseICEServers(#"{"iceServers":[]}"#.data(using: .utf8)!))
    }
```

- [ ] **Step 2: Run to verify it fails, then implement**

`GET /api/ice?code=<code>`; 429 → `AccountError.rateLimited`; other non-200 →
`.server(status:)`. Mirror `HTTPDeviceAuthClient`'s `send`/`statusError` shape
from G2.5 rather than inventing a third one.

**Why `relays` is ignored, in a comment on the type:** the pool exists so both
peers converge on the lowest-RTT common relay. Skipping it costs latency, not
correctness — with TURN, each peer may relay through a different server and ICE
still finds a working pair. Implementing convergence means measuring RTT to each
candidate and agreeing with the peer, which is its own round.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/RelayiumKit && swift test --filter ICEClientTests 2>&1 | grep -E "Executed .* tests" | tail -1
git add apps/RelayiumKit/Sources/RelayiumKit/Account/ICEClient.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/ICEClientTests.swift
git commit -s -m "feat(kit): fetch ICE servers, so cross-network can actually work

RealtimeConnection takes iceServers as a constructor parameter and nothing ever
supplied TURN, so any pair that could not connect directly simply failed — the
worst shape of bug, working on a developer's LAN and failing at a user's house.

TURN credentials come back only for a live pairing code, because relayed bytes
bill to that code's owner. The relay pool is decoded and ignored on purpose:
converging on the lowest-RTT common relay costs latency, not correctness, and
each peer relaying through its own server still finds a working candidate pair."
```

---

### Task 4: `PairClient`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Account/PairClient.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/PairClientTests.swift`

**Interfaces:**
- Produces:
  - `public struct MintedCode: Equatable { public let code: String; public let expiresAt: Int64 }`
  - `public protocol PairCodeClient { func mint(token: String) async throws -> MintedCode }`
  - `public struct HTTPPairClient: PairCodeClient`

- [ ] **Step 1: Write the failing test**

```swift
    func testParsesTheMintedCode() throws {
        let m = try parseMintedCode(#"{"code":"K7M3X9","expiresAt":1800000000}"#.data(using: .utf8)!)
        XCTAssertEqual(m.code, "K7M3X9")
        XCTAssertEqual(m.expiresAt, 1800000000)
    }

    /// 401 here means "not signed in", which is not what invalidCredentials
    /// says. Reusing that case would put "that email and password don't match
    /// an account" in front of someone who never typed either.
    func testNotSignedInIsItsOwnCase() {
        XCTAssertEqual(pairStatusError(401), .notSignedIn)
        XCTAssertEqual(pairStatusError(429), .rateLimited)
        XCTAssertEqual(pairStatusError(503), .server(status: 503))
    }
```

**`AccountError` has no `.unauthorized`** — checked: it carries
`.invalidCredentials`, `.rateLimited`, `.server`, `.decoding`, `.network`
(`Account/AccountModels.swift:77-83`). This task adds `case notSignedIn` to that
enum rather than letting `PairClient` invent a parallel error type, because
`ErrorCopy` already switches exhaustively over `AccountError` and its coverage
test will then force copy to exist for it.

- [ ] **Step 2: Implement, verify, commit**

`POST /api/pair` with `Authorization: Bearer <token>`. 503 is the "could not mint,
try again" case the handler returns (`pairhttp.go:104`) and is transient.

```bash
git commit -s -m "feat(kit): mint a pairing code

POST /api/pair requires authentication and returns {code, expiresAt}; the CLI
round taught it to accept the rlm_cli_ bearer the app already holds.

401 is its own error rather than a generic failure, because it is the signed-out
case and the UI has to explain why creating a code needs an account when joining
one does not — that asymmetry is the server's billing policy, since relayed
bytes bill to the code's owner."
```

---

### Task 5: Extract `ManifestWriter`

G2 built it inside `CloudDownloadModel.swift:70` as an internal type. The realtime
receiver has the identical problem — chunks with no file boundaries, split by
manifest sizes, names sanitized, partials deleted on failure. **Two copies of the
boundary that decides where bytes land on disk will drift, and one of them will
be the one with the path-traversal bug.**

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/ManifestWriter.swift` (moved)
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/CloudDownloadModel.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudDownloadModelTests.swift` (writer tests move too)

- [ ] **Step 1: Move the type and its tests, unchanged**

Move `ManifestWriter` and `safePathComponent` verbatim into the new file, plus
the four tests that cover them. Generalise only the input: it currently takes
`StoredManifest`; realtime supplies `[FileMeta]`. Take `[(name: String, size: Int)]`
so neither transport's model leaks into the other.

- [ ] **Step 2: Verify nothing changed**

```bash
cd apps/RelayiumKit && swift test 2>&1 | grep -E "Executed [0-9]+ tests" | tail -1
```

Expected: same count as before the move, 0 failures. A move that changes a number
is not a move.

- [ ] **Step 3: Commit**

```bash
git commit -s -m "refactor(native): share the manifest writer between both transports

The realtime receiver has the same problem the cloud download had — chunks with
no file boundaries, split only by the manifest's sizes, names that must be
reduced to a single path component before they touch a path. Copying it would
give the codebase two path-traversal boundaries, and drift would eventually
leave the bug in only one of them.

Pure move: same tests, same count, no behaviour change."
```

---

### Task 6: `RealtimeSessionModel`

The round's centre, and the largest single task. Everything above exists to make
this testable without a peer.

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/RealtimeSessionModel.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeSessionModelTests.swift`

**Interfaces:**
- Consumes: `ICEConfigClient` (Task 3), `PairCodeClient` (Task 4),
  `ManifestWriter` (Task 5), and a **connection seam** — see below.
- Produces:
  - `public enum RealtimeState: Equatable { case idle, minting, showingCode(String, expiresAt: Int64), joining(String), connecting, verifying(sas: String), transferring(done: Int, total: Int), completed([URL]), failed(String) }`
  - `public protocol RealtimePeerConnection` — the seam over `RealtimeConnection`
  - `public final class RealtimeSessionModel: ObservableObject`

- [ ] **Step 1: Define the connection seam first**

`RealtimeConnection` needs WebRTC and a live peer, so the model must not depend
on it directly. Declare a protocol carrying exactly the callbacks the model uses
(`onSAS`, `onOpen`, `onManifest`, `onFileChunk`, `onProgress`, `onDone`,
`onClose`, `onError`) plus `start()`, `send(sources:metas:)`, `close()`, and make
`RealtimeConnection` conform. This is the same move `ResumableTransport` was in
G2 and it is what makes every test below possible.

- [ ] **Step 2: Write the failing tests**

Cover, each against a stubbed connection:

- mint → `showingCode` with the code and expiry
- mint 401 → `failed` with copy that explains sign-in, not a generic error
- join → `connecting` → `onSAS` → **`verifying`, and no bytes move**
- confirm from `verifying` → `transferring`
- **reject from `verifying` → connection closed and state `idle`**
- `onManifest` then chunks → written through `ManifestWriter`, `completed` lists
  the files
- `onDone(false)` → `failed`, and the partial files are deleted
- cancel at every stage → `idle`, connection closed, nothing partial left
- a superseded callback after cancel changes nothing
- ICE fetch failure → `failed` before any connection attempt

- [ ] **Step 3: Implement**

The state machine, with two properties worth stating in code comments because
they are the round's correctness claims:

```swift
    /// `verifying` blocks. Nothing is sent and nothing is written until the
    /// local user confirms, on both sides — that is what the SAS is for, and a
    /// modal that could be dismissed by accident would not be.
```

```swift
    /// Reject closes the connection rather than returning to a picker. A
    /// mismatched SAS is what a man-in-the-middle looks like; offering "try
    /// again" on the same connection would invite the user to accept it.
```

- [ ] **Step 4: Verify and commit**

```bash
cd apps/RelayiumKit && swift test --filter RealtimeSessionModelTests 2>&1 | grep -E "Executed .* tests" | tail -1
git commit -s -m "feat(native): the realtime session state machine

Pair, handshake, SAS, transfer, done — one model, no SwiftUI, every transition
driven by a test against a stubbed connection.

Two states carry the round's correctness claims. verifying blocks: nothing is
sent and nothing is written until the local user confirms on both sides, which
is the entire purpose of a short authentication string. And rejecting closes the
connection rather than returning to a picker — a mismatched SAS is what a
man-in-the-middle looks like, and offering 'try again' on the same connection
would invite the user to accept it the second time."
```

---

### Task 7: Error copy

**Files:** modify `ErrorCopy.swift`; extend `ErrorCopyTests`.

Four families reach the UI and none has copy today: `HandshakeError`
(`.mitm`, `.noCommitRecorded`, `.badBase64`, `.invalidKey`), `RealtimeError`,
`RealtimeSenderError` (including Task 1's `.sourceShorterThanDeclared`), and
`ConnectionError`.

- [ ] **Step 1: Write the failing test**

`.mitm` must not read as a network problem — it is the one error in this codebase
that means someone may be attacking the user, and the copy says to stop and
retry pairing rather than offering a reconnect. Assert every case of all four
enums produces copy and none reaches the type-name fallback, the way
`testEveryCloudErrorHasCopy` does.

- [ ] **Step 2: Implement, verify, commit**

```bash
git commit -s -m "feat(native): copy for the realtime failure families

Four enums reach this UI and none had copy, so every realtime failure rendered
as a type name.

HandshakeError.mitm gets the sharpest wording in the app. It is the only error
here that means someone may be attacking the user, and it must not read as a
network hiccup with a retry button — the instruction is to stop and pair again,
not to reconnect to whoever that was."
```

---

### Task 8: The three-tab shell

**Files:** modify `apps/mac/Relayium/ContentView.swift`.

- [ ] **Step 1: Replace the stacked `.ready` branch**

`TabView` with **Direct**, **Link**, **Account**. `Link` holds the existing
`UploadPane` and `DownloadPane` unchanged; `Account` holds `AccountView`;
`Direct` gets Task 9's pane.

The logged-out branch keeps its structure exactly — one switch branch, the
`DisclosureGroup` for "I have a link" (G2) and the Apple button (G2.5) both stay,
and `LoginView`'s `@State` must survive as it has for three rounds.

- [ ] **Step 2: Verify it compiles, then commit**

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E '\*\* BUILD|error:' | tail -2
git commit -s -m "feat(mac): three tabs, split by intent rather than transport

Direct, Link, Account. The distinction a user actually makes is whether the
other person is there right now, and that is exactly the line between the two
transports — naming the tabs after WebRTC and the cloud would ask them to know
something they should not have to.

G2 stacked the panes in a ScrollView and said the layout belonged to the round
where all three modes existed. They exist now."
```

---

### Task 9: `DirectPane`

**Files:** create `apps/mac/Relayium/DirectPane.swift`.

Renders `RealtimeSessionModel`'s states and nothing else. Two details the model
cannot carry:

- The code field **filters as you type** to the 24-character alphabet, uppercased.
  Rejecting after the fact teaches nothing; filtering shows the rule.
- The SAS screen puts both devices' phrases side by side in the copy — *"the
  other device should show this too"* — with **Confirm** and **They don't match**
  as equally weighted buttons. A visually secondary reject is a reject nobody
  presses.

- [ ] **Steps:** build, then commit.

```bash
git commit -s -m "feat(mac): the Direct pane

Renders the session model and holds no decisions. Two things the model cannot
carry: the code field filters to the 24-character alphabet as you type, because
rejecting after the fact teaches nothing; and the SAS screen weights Confirm and
'They don't match' equally, because a visually secondary reject is a reject
nobody presses — on the one screen where pressing it is the whole point."
```

---

### Task 10: QR code (cuttable)

**Files:** create `apps/mac/Relayium/QRCode.swift`; modify `DirectPane`.

`CIQRCodeGenerator`, no dependency. Encodes the join link
`https://relayium.com/cross-network#c=<code>` — the form
`web/src/lib/transfer-link.ts` already builds, with the code in the fragment so
it never reaches a log or a Referer.

**Cut this task, not another, if the round runs long.** The code stays the
primary affordance; QR is an accelerator beside it.

```bash
git commit -s -m "feat(mac): show the pairing code as a QR too

Desktop to phone is the archetypal realtime transfer, and six characters typed
across devices is exactly the friction a QR removes. The join link form already
exists and carries the code in the fragment, so a phone that scans it lands in
the web app and joins — no native app and no Universal Links needed.
CIQRCodeGenerator ships with the OS, so this costs no dependency."
```

---

### Task 11: Acceptance

**Blocked on Tasks 1–10.** Needs a signed Debug build (`CODE_SIGNING_ALLOWED=NO`
skips entitlements, and this flow writes to the keychain and to disk).

- [ ] **Mac → browser.** Mint in the app, join at `relayium.com/cross-network`.
  **Compare the SAS strings on both screens before confirming.** Send two files,
  one ≥ 50 MB. `shasum -a 256` both against the originals.
- [ ] **Browser → Mac.** Mint in the browser, join from the app, same comparison,
  same hashes, and confirm the files land where the save panel said.
- [ ] **SAS reject** closes the connection on both sides.
- [ ] **Cancel mid-transfer** leaves no partial file and no stuck UI.
- [ ] **Signed out**, joining a code still works; pressing Send explains why it
  needs an account instead of doing nothing.
- [ ] **Sender memory**: a ≥ 500 MB send holds `phys_footprint` near baseline.
  Measure with `footprint -p`, never RSS — G2's false alarm came from RSS.
- [ ] **Mac ↔ Mac**: **record as not exercised.** One machine available; two
  instances of one bundle is not a valid substitute, since macOS treats a second
  launch as an activation.
- [ ] **TURN forced relay**: left to a human — it needs the Mac on a different
  network from the browser peer (a phone hotspot). Until it runs, `/api/ice` is
  wired but unproven, and the round says so rather than implying coverage.

A SAS mismatch in items 1 or 2 is a **stop-everything** result, not a retry: it
would mean the two implementations derive the phrase differently, and every
transfer either has ever accepted was accepted on a phrase nobody could compare.

---

## Self-review

**Spec coverage.** Streaming sender → Tasks 1–2. TURN → Task 3. Mint → Task 4.
Shared writer → Task 5. Session model, SAS blocking and reject → Task 6. Error
copy → Task 7. Shell → Task 8. Pairing/SAS/progress UI → Task 9. QR → Task 10.
Every acceptance item in the spec → Task 11, including the two the spec marks as
human-only or not-exercised.

**Placeholder scan.** Two steps deliberately defer to reading code rather than
quoting it: Task 2 Step 1 (the existing send path's structure) and Task 4 Step 1
(whether `AccountError` already has `.unauthorized`). Both name exactly what to
look for and why guessing would be worse.

**Known gap, stated rather than hidden.** Task 2's test is written as a sketch
because the connection's transmit path may not be reachable without a live
`RTCDataChannel`. The instruction is explicit: if no seam exists, say so in the
commit and lean on Task 1's equality test plus acceptance — do **not** fabricate
a fake data channel to manufacture a green test.

**Type consistency.** `PlaintextSource`/`DataSource`/`FileURLSource` (G2's cloud
round) feed Tasks 1 and 2. `RealtimeFrameProducer` (Task 1) is consumed by
Task 2. `ICEConfigClient`, `PairCodeClient` (Tasks 3–4) and `ManifestWriter`
(Task 5) are consumed by Task 6. `RealtimePeerConnection` is introduced in Task 6
Step 1 and is what makes that task testable at all.
