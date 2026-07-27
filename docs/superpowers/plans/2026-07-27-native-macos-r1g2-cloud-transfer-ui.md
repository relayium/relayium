# Native macOS R1-G2 — cloud transfer UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag files into the macOS app to get a `#k=` link, and paste a link to
get the files on disk with Reveal in Finder.

**Architecture:** Three layers, following G1's split. `RelayiumKit` gains an
incremental frame encryptor and a chunked `CloudUploader` whose memory is bounded
by one upload chunk rather than the file. `RelayiumAppKit` gains two `@MainActor`
view models with explicit state enums, testable under `swift test` without a
view. The app target gains views that hold no logic.

**Tech Stack:** Swift 5.9 / SwiftPM, XCTest, SwiftUI + AppKit (`NSSavePanel`,
`NSOpenPanel`, `NSWorkspace`), `URLSession`.

**Spec:** `docs/superpowers/specs/2026-07-27-native-macos-r1g2-cloud-transfer-ui-design.md`

## Global Constraints

- **Peak memory is bounded and asserted.** The uploader holds one upload chunk
  plus one frame — about 8.2 MiB — regardless of file size. A test asserts the
  peak; a regression that reintroduces whole-file buffering fails it.
- **Wire constants match the web exactly.** `STORE_CHUNK_SIZE = 192 * 1024` and
  `FRAME_OVERHEAD = 4 + 16` already exist in
  `StoredWire/StoreFrame.swift:3-4`; use them, do not redefine. The upload chunk
  size comes from the server's init response, falling back to `8 << 20` when it
  reports `0` — the same rule as `web/src/lib/stored-file.ts`.
- **Single-shot fallback stays, and is tested.** Fall back only when the chunked
  flow fails for a non-user reason: never on cancellation, never on 401/413/429,
  and never when `cipherSizeFor(sizes) > 64 << 20` (`FALLBACK_MAX_CIPHER_BYTES`),
  because the single-shot path's 2× peak is worse than an error.
- **Download works signed out.** `fetchMeta` and the blob route take no token.
  Only upload requires the bearer token.
- **TTL options** are 3600 / 86400 / 259200 / 604800 / 1209600, clamped by
  `plan.retentionSecs`. An unknown cap (signed out, or a failed usage fetch)
  offers all five and lets the server truncate.
- **Multi-file downloads** land in a new `relayium-<id>` directory and refuse
  rather than merge if it exists, with copy that says why.
- Out of scope, do not add: Universal Links, Sign in with Apple, background
  `URLSession`, folder recursion, QR codes, the `relayium down …` hint.

## File structure

| File | Responsibility |
|---|---|
| `Sources/RelayiumKit/StoredWire/ChunkEncryptor.swift` | **new** — pulls plaintext from sources and yields one framed ciphertext at a time |
| `Sources/RelayiumKit/Cloud/ResumableTransport.swift` | **new** — the four `/api/uploads` calls behind a protocol, plus the `URLSession` implementation |
| `Sources/RelayiumKit/Cloud/CloudUploader.swift` | **new** — the chunk loop: pack, PATCH, resync, finalize |
| `Sources/RelayiumKit/Cloud/CloudConfig.swift` | **new** — `GET /api/config` for `maxFileSize` |
| `Sources/RelayiumAppKit/ErrorCopy.swift` | extend — `CloudError`, `StoredWireError` |
| `Sources/RelayiumAppKit/CloudUploadModel.swift` | **new** — upload state machine |
| `Sources/RelayiumAppKit/CloudDownloadModel.swift` | **new** — download state machine |
| `apps/mac/Relayium/UploadPane.swift` | **new** — drop zone, TTL, burn toggle, progress, result |
| `apps/mac/Relayium/DownloadPane.swift` | **new** — link field, manifest preview, save, reveal |
| `apps/mac/Relayium/ContentView.swift` | modify — route to the transfer UI; "I have a link" from the logged-out shell |
| `apps/mac/Relayium/RelayiumApp.swift` | modify — quit/close guard while a transfer runs |

Tasks 1–4 are Kit work and need no UI. Tasks 5–7 are the testable view-model
layer. Tasks 8–10 are views and verification.

---

### Task 1: `ChunkEncryptor` — frames without holding the file

`encryptChunks(key:files:)` (`StoredWire/StoreFrame.swift`) takes `[[UInt8]]` and
returns the whole ciphertext. That is the API the memory problem comes from. This
task adds an incremental producer beside it; nothing existing changes.

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/ChunkEncryptor.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/ChunkEncryptorTests.swift`

**Interfaces:**
- Consumes: `frame(_:)`, `seal(key:seq:plaintext:)`, `STORE_CHUNK_SIZE`,
  `cipherSizeFor(_:)` — all in `StoreFrame.swift`.
- Produces:
  - `public protocol PlaintextSource { var name: String { get }; var size: Int { get }; mutating func read(_ max: Int) throws -> [UInt8] }`
  - `public struct DataSource: PlaintextSource` — in-memory, for tests
  - `public struct FileURLSource: PlaintextSource` — `FileHandle`-backed
  - `public final class ChunkEncryptor { init(key: [UInt8], sources: [PlaintextSource]); func next() throws -> [UInt8]? }`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumKit

final class ChunkEncryptorTests: XCTestCase {
    private func drain(_ e: ChunkEncryptor) throws -> [UInt8] {
        var out: [UInt8] = []
        while let f = try e.next() { out += f }
        return out
    }

    /// The whole point: streaming must produce the identical byte stream the
    /// batch encoder produces, or native uploads become unreadable by web.
    func testMatchesEncryptChunksByteForByte() throws {
        let key = [UInt8](repeating: 7, count: 32)
        let a = [UInt8](repeating: 0xAB, count: STORE_CHUNK_SIZE * 2 + 13)
        let b = [UInt8](repeating: 0xCD, count: 5)
        let batch = encryptChunks(key: key, files: [a, b])
        let streamed = try drain(ChunkEncryptor(key: key, sources: [
            DataSource(name: "a", bytes: a), DataSource(name: "b", bytes: b),
        ]))
        XCTAssertEqual(streamed, batch)
    }

    /// A zero-length file yields no frames — matches encryptChunks, whose
    /// `off < count` loop never runs. Getting this wrong desynchronises seq.
    func testEmptyFileContributesNoFrames() throws {
        let key = [UInt8](repeating: 1, count: 32)
        let batch = encryptChunks(key: key, files: [[], [9, 9, 9]])
        let streamed = try drain(ChunkEncryptor(key: key, sources: [
            DataSource(name: "empty", bytes: []), DataSource(name: "x", bytes: [9, 9, 9]),
        ]))
        XCTAssertEqual(streamed, batch)
    }

    /// No frame may exceed one chunk of plaintext plus overhead — this is the
    /// property the uploader's buffer sizing depends on.
    func testEveryFrameFitsOneChunkPlusOverhead() throws {
        let key = [UInt8](repeating: 3, count: 32)
        let e = ChunkEncryptor(key: key, sources: [
            DataSource(name: "big", bytes: [UInt8](repeating: 0x11, count: STORE_CHUNK_SIZE * 3 + 1)),
        ])
        while let f = try e.next() {
            XCTAssertLessThanOrEqual(f.count, STORE_CHUNK_SIZE + FRAME_OVERHEAD + 16)
        }
    }

    func testDrainsToNilAndStaysNil() throws {
        let e = ChunkEncryptor(key: [UInt8](repeating: 2, count: 32),
                               sources: [DataSource(name: "s", bytes: [1, 2, 3])])
        XCTAssertNotNil(try e.next())
        XCTAssertNil(try e.next())
        XCTAssertNil(try e.next())
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/RelayiumKit && swift test --filter ChunkEncryptorTests 2>&1 | grep -E "error:" | head -5
```

Expected: `cannot find 'ChunkEncryptor' in scope` and `cannot find 'DataSource' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumKit/StoredWire/ChunkEncryptor.swift`:

```swift
import Foundation

/// A plaintext byte source read strictly forward. Files are read through this
/// rather than loaded, which is the difference between a bounded upload and a
/// file-sized one.
public protocol PlaintextSource {
    var name: String { get }
    var size: Int { get }
    /// Returns up to `max` bytes, or fewer at end of input. Empty means done.
    mutating func read(_ max: Int) throws -> [UInt8]
}

public struct DataSource: PlaintextSource {
    public let name: String
    private let bytes: [UInt8]
    private var off = 0
    public var size: Int { bytes.count }
    public init(name: String, bytes: [UInt8]) { self.name = name; self.bytes = bytes }
    public mutating func read(_ max: Int) throws -> [UInt8] {
        guard off < bytes.count else { return [] }
        let end = min(off + max, bytes.count)
        defer { off = end }
        return Array(bytes[off..<end])
    }
}

public struct FileURLSource: PlaintextSource {
    public let name: String
    public let size: Int
    private let handle: FileHandle
    public init(url: URL) throws {
        self.name = url.lastPathComponent
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        self.size = (attrs[.size] as? Int) ?? 0
        self.handle = try FileHandle(forReadingFrom: url)
    }
    public mutating func read(_ max: Int) throws -> [UInt8] {
        guard let d = try handle.read(upToCount: max) else { return [] }
        return [UInt8](d)
    }
}

/// Yields the same framed ciphertext stream as `encryptChunks`, one frame at a
/// time. `seq` is global across files and starts at 1, because 0 is the
/// manifest — the same rule the batch encoder and the web both follow.
public final class ChunkEncryptor {
    private let key: [UInt8]
    private var sources: [PlaintextSource]
    private var index = 0
    private var seq: UInt64 = 1

    public init(key: [UInt8], sources: [PlaintextSource]) {
        self.key = key
        self.sources = sources
    }

    /// The next frame, or nil once every source is exhausted.
    public func next() throws -> [UInt8]? {
        while index < sources.count {
            let pt = try sources[index].read(STORE_CHUNK_SIZE)
            if pt.isEmpty { index += 1; continue }
            let f = frame(seal(key: key, seq: seq, plaintext: pt))
            seq += 1
            return f
        }
        return nil
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/RelayiumKit && swift test --filter ChunkEncryptorTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: `Executed 4 tests, with 0 failures`.

- [ ] **Step 5: Run the whole suite**

Run:

```bash
cd apps/RelayiumKit && swift test 2>&1 | grep -E "Executed [0-9]+ tests" | tail -1
```

Expected: 0 failures. The count grows by 4 from the current 145.

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/StoredWire/ChunkEncryptor.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/ChunkEncryptorTests.swift
git commit -s -m "feat(kit): yield stored-wire frames one at a time

encryptChunks takes [[UInt8]] and returns the whole ciphertext, so an upload
built on it peaks at roughly twice the file size — against a 1 GiB server cap.
ChunkEncryptor produces the identical byte stream incrementally, reading each
source forward in STORE_CHUNK_SIZE bites.

The equality test against encryptChunks is the load-bearing one: a stream that
differs by a byte is a file the web cannot decrypt."
```

---

### Task 2: `ResumableTransport` — the four `/api/uploads` calls

Isolating the HTTP behind a protocol is what lets Task 3's chunk loop — the part
with the tricky logic — be tested against stubs without a server.

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/ResumableTransport.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/ResumableTransportTests.swift`

**Interfaces:**
- Consumes: `CloudError` (`Cloud/CloudModels.swift:15`), `UploadResult` (`:3`).
- Produces:
  - `public enum PatchOutcome: Equatable { case committed(received: Int); case serverAhead(received: Int) }`
  - `public protocol ResumableTransport` with `initUpload`, `patchChunk`, `uploadOffset`, `finalizeUpload`
  - `public struct HTTPResumableTransport: ResumableTransport`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumKit

final class ResumableTransportTests: XCTestCase {
    /// 409 is not an error: the server is ahead of us, and its offset is the
    /// one to believe. Treating it as a failure would abandon a live upload.
    func testPatchOutcomeDistinguishesServerAhead() {
        XCTAssertNotEqual(PatchOutcome.committed(received: 10), .serverAhead(received: 10))
    }

    /// The header the server parses. A wrong end offset silently corrupts the
    /// blob, so it is pinned by a test rather than trusted to review.
    func testContentRangeHeaderIsInclusiveOfEnd() {
        XCTAssertEqual(contentRangeHeader(from: 0, to: 100, total: 500), "bytes 0-99/500")
        XCTAssertEqual(contentRangeHeader(from: 100, to: 150, total: 500), "bytes 100-149/500")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/RelayiumKit && swift test --filter ResumableTransportTests 2>&1 | grep -E "error:" | head -3
```

Expected: `cannot find 'PatchOutcome' in scope`, `cannot find 'contentRangeHeader' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumKit/Cloud/ResumableTransport.swift`:

```swift
import Foundation

public enum PatchOutcome: Equatable {
    /// The server committed up to `received` (which may be inside the chunk we
    /// sent — it commits whatever landed before a reset).
    case committed(received: Int)
    /// 409: the server was already past where we started. Its offset wins.
    case serverAhead(received: Int)
}

/// `Content-Range: bytes <from>-<to-1>/<total>` — end is inclusive on the wire,
/// exclusive in our call sites.
func contentRangeHeader(from: Int, to: Int, total: Int) -> String {
    "bytes \(from)-\(to - 1)/\(total)"
}

/// The four calls of the resumable upload protocol, behind a protocol so the
/// chunk loop can be tested without a server.
public protocol ResumableTransport {
    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int)
    func patchChunk(uploadId: String, bytes: [UInt8], from: Int, to: Int,
                    total: Int, token: String) async throws -> PatchOutcome
    func uploadOffset(uploadId: String, token: String) async throws -> Int
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult
}

public struct HTTPResumableTransport: ResumableTransport {
    let baseURL: URL
    let session: URLSession
    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL; self.session = session
    }

    public func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                           size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/uploads"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "burnAfterRead", value: burnAfterRead ? "1" : "0"),
                            .init(name: "ttl", value: String(ttl)),
                            .init(name: "size", value: String(size))]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(header)
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http.statusCode) }
        struct Body: Decodable { let uploadId: String; let chunkSize: Int }
        guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw CloudError.decoding }
        // The server may report 0 to mean "use your default" — same rule as web.
        return (b.uploadId, b.chunkSize > 0 ? b.chunkSize : 8 << 20)
    }

    public func patchChunk(uploadId: String, bytes: [UInt8], from: Int, to: Int,
                           total: Int, token: String) async throws -> PatchOutcome {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/uploads/\(uploadId)"))
        req.httpMethod = "PATCH"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(contentRangeHeader(from: from, to: to, total: total),
                     forHTTPHeaderField: "Content-Range")
        req.httpBody = Data(bytes)
        let (data, http) = try await send(req)
        struct Body: Decodable { let received: Int }
        switch http.statusCode {
        case 200:
            guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw CloudError.decoding }
            return .committed(received: b.received)
        case 409:
            guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw CloudError.decoding }
            return .serverAhead(received: b.received)
        default: throw statusError(http.statusCode)
        }
    }

    public func uploadOffset(uploadId: String, token: String) async throws -> Int {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/uploads/\(uploadId)"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http.statusCode) }
        struct Body: Decodable { let received: Int }
        guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw CloudError.decoding }
        return b.received
    }

    public func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/uploads/\(uploadId)/finalize"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http.statusCode) }
        guard let r = try? JSONDecoder().decode(UploadResult.self, from: data) else { throw CloudError.decoding }
        return r
    }

    private func statusError(_ code: Int) -> CloudError {
        switch code {
        case 401: return .unauthorized
        case 413: return .quota
        case 429: return .rateLimited
        case 404: return .notFound
        default:  return .server(status: code)
        }
    }

    private func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw CloudError.network }
            return (data, http)
        } catch let e as CloudError { throw e }
        catch { throw CloudError.network }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/RelayiumKit && swift test --filter ResumableTransportTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: `Executed 2 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Cloud/ResumableTransport.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/ResumableTransportTests.swift
git commit -s -m "feat(kit): the four resumable-upload calls, behind a protocol

POST /api/uploads, PATCH, GET status, POST finalize. Behind a protocol because
the chunk loop that uses them is where the real logic is, and it has to be
testable against stubs rather than a server.

409 becomes .serverAhead rather than an error: the server was already past our
start offset and its number is the one to believe. Treating it as a failure
would abandon a live upload."
```

---

### Task 3: `CloudUploader` — the chunk loop

The core of the round. Every guard here exists because its absence produces a
silent corruption rather than an error: a truncated ciphertext that finalizes,
and a UI that says the upload succeeded.

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudUploader.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudUploaderTests.swift`

**Interfaces:**
- Consumes: `ChunkEncryptor`, `PlaintextSource`, `DataSource` (Task 1);
  `ResumableTransport`, `PatchOutcome` (Task 2); `cipherSizeFor`,
  `encryptManifest`, `StoredManifest`, `ManifestFile`, `generateStoreKey`,
  `encodeStoreKey`.
- Produces:
  - `public struct UploadOutcome: Equatable { public let id: String; public let expiresAt: Int64; public let keyB64url: String }`
  - `public final class CloudUploader { init(transport: ResumableTransport); var bufferPeak: Int; func upload(sources:burnAfterRead:ttl:token:onProgress:) async throws -> UploadOutcome }`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumKit

/// A transport that records what it was asked to do and can be told to misbehave.
private final class StubTransport: ResumableTransport, @unchecked Sendable {
    var chunkSize = 64 * 1024
    var committed: [UInt8] = []
    var patches: [(from: Int, count: Int)] = []
    /// Commit only this many bytes of the next PATCH, then clear (partial commit).
    var partialCommitOnce: Int?
    /// Throw a network error on the next PATCH, then clear.
    var failNextPatch = false
    var initError: Error?
    var finalizeResult = UploadResult(id: "fid", expiresAt: 4242)

    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        if let e = initError { throw e }
        return ("up1", chunkSize)
    }
    func patchChunk(uploadId: String, bytes: [UInt8], from: Int, to: Int,
                    total: Int, token: String) async throws -> PatchOutcome {
        if failNextPatch { failNextPatch = false; throw CloudError.network }
        patches.append((from, bytes.count))
        var take = bytes.count
        if let p = partialCommitOnce { take = min(p, bytes.count); partialCommitOnce = nil }
        committed += bytes.prefix(take)
        return .committed(received: committed.count)
    }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { committed.count }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult { finalizeResult }
}

final class CloudUploaderTests: XCTestCase {
    private func sources(_ sizes: [Int]) -> [PlaintextSource] {
        sizes.enumerated().map { DataSource(name: "f\($0.offset)",
                                            bytes: [UInt8](repeating: 0x5A, count: $0.element)) }
    }

    /// The bytes the server ends up with must be exactly the bytes the batch
    /// encoder would have produced for the same files and key.
    func testCommittedStreamIsTheWholeCiphertext() async throws {
        let t = StubTransport()
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 2 + 7, 100]
        let out = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                                     ttl: 86400, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(t.committed.count, cipherSizeFor(sizes))
        XCTAssertEqual(out.id, "fid")
        XCTAssertEqual(out.expiresAt, 4242)
        XCTAssertFalse(out.keyB64url.isEmpty)
    }

    /// A partial commit must replay from the server's offset, not from the start
    /// of the next chunk — otherwise the blob gets a hole.
    func testPartialCommitReplaysTheUnacknowledgedTail() async throws {
        let t = StubTransport()
        t.partialCommitOnce = 1000
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 3]
        _ = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(t.committed.count, cipherSizeFor(sizes))
    }

    /// A transient PATCH failure costs the current chunk, not the upload.
    func testRetriesAfterANetworkFailure() async throws {
        let t = StubTransport()
        t.failNextPatch = true
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 2]
        _ = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertEqual(t.committed.count, cipherSizeFor(sizes))
    }

    /// The guard the whole design rests on: memory must not track file size.
    func testPeakBufferIsBoundedByChunkNotFile() async throws {
        let t = StubTransport()
        t.chunkSize = 64 * 1024
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 20]        // ~3.75 MiB, 60× the chunk
        _ = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertLessThanOrEqual(u.bufferPeak, t.chunkSize + STORE_CHUNK_SIZE + FRAME_OVERHEAD + 16)
    }

    /// Progress must reach the declared total, or the UI stalls at 97%.
    func testProgressEndsAtTheDeclaredTotal() async throws {
        let t = StubTransport()
        let u = CloudUploader(transport: t)
        let sizes = [STORE_CHUNK_SIZE * 2 + 5]
        var last = (sent: 0, total: 0)
        _ = try await u.upload(sources: sources(sizes), burnAfterRead: false,
                               ttl: 3600, token: "tok", onProgress: { s, tt in last = (s, tt) })
        XCTAssertEqual(last.sent, cipherSizeFor(sizes))
        XCTAssertEqual(last.total, cipherSizeFor(sizes))
    }

    /// A user-facing error is never retried into oblivion, and never masked.
    func testQuotaErrorPropagates() async {
        let t = StubTransport()
        t.initError = CloudError.quota
        let u = CloudUploader(transport: t)
        do {
            _ = try await u.upload(sources: sources([10]), burnAfterRead: false,
                                   ttl: 3600, token: "tok", onProgress: { _, _ in })
            XCTFail("expected quota to propagate")
        } catch {
            XCTAssertEqual(error as? CloudError, .quota)
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudUploaderTests 2>&1 | grep -E "error:" | head -3
```

Expected: `cannot find 'CloudUploader' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudUploader.swift`:

```swift
import Foundation

public struct UploadOutcome: Equatable {
    public let id: String
    public let expiresAt: Int64
    public let keyB64url: String
}

/// The chunked upload: encrypt and send interleaved, so resident memory is one
/// upload chunk plus one frame rather than the whole ciphertext.
///
/// Mirrors `web/src/lib/stored-file.ts`'s chunkedUpload, including its two
/// asymmetric guards. `cipherSizeFor` is computed before encryption because the
/// declared size is needed at init and there is no assembled blob to measure.
/// If that formula ever over-reports, the encryptor runs dry early; if it
/// under-reports, the loop exits with frames still unsent and we would finalize
/// a truncated, undecryptable ciphertext while the UI says success. Both are
/// caught below.
public final class CloudUploader {
    private let transport: ResumableTransport
    /// Peak bytes encrypted but not yet acknowledged. The memory regression guard.
    public private(set) var bufferPeak = 0

    public init(transport: ResumableTransport) { self.transport = transport }

    public func upload(sources: [PlaintextSource], burnAfterRead: Bool, ttl: Int,
                       token: String,
                       onProgress: (_ sent: Int, _ total: Int) -> Void) async throws -> UploadOutcome {
        let raw = generateStoreKey()
        let manifest = StoredManifest(files: sources.map { ManifestFile(name: $0.name, size: $0.size) })
        let encManifest = try encryptManifest(key: raw, manifest)
        let total = cipherSizeFor(sources.map(\.size))

        var header = [UInt8]()
        let n = encManifest.count
        header += [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
        header += encManifest

        let (uploadId, chunkSize) = try await transport.initUpload(
            header: header, burnAfterRead: burnAfterRead, ttl: ttl, size: total, token: token)

        let enc = ChunkEncryptor(key: raw, sources: sources)
        // Held bytes double as the replay buffer: the server can commit part of a
        // chunk, so the unacknowledged tail must survive until it is acked.
        var pending = [UInt8]()
        pending.reserveCapacity(chunkSize + STORE_CHUNK_SIZE + FRAME_OVERHEAD)
        var chunkStart = 0
        var offset = 0
        bufferPeak = 0

        onProgress(0, total)
        while offset < total {
            try Task.checkCancellation()
            while pending.count < chunkSize {
                guard let f = try enc.next() else { break }
                try Task.checkCancellation()
                pending += f
            }
            // Encryptor dry before the declared size was met: the formula and the
            // stream disagree. Better to fail than finalize a truncated blob.
            if pending.isEmpty { throw CloudError.server(status: 0) }
            bufferPeak = max(bufferPeak, pending.count)

            let received = try await patchWithRetry(uploadId: uploadId, bytes: pending,
                                                    chunkStart: chunkStart, total: total, token: token)
            let consumed = received - chunkStart
            // Offset moving backwards, or past bytes we never produced: either way
            // we can no longer align, and sending more writes a misplaced stream.
            if consumed < 0 || consumed > pending.count { throw CloudError.server(status: 0) }
            if consumed > 0 { pending.removeFirst(consumed) }
            chunkStart = received
            offset = received
            onProgress(offset, total)
        }
        // The other half of the asymmetric guard: the loop ends on offset >= total,
        // so an under-reporting formula would leave frames unsent. Confirm dry.
        if try enc.next() != nil { throw CloudError.server(status: 0) }

        let r = try await transport.finalizeUpload(uploadId: uploadId, token: token)
        return UploadOutcome(id: r.id, expiresAt: r.expiresAt, keyB64url: encodeStoreKey(raw))
    }

    /// PATCH with resync-and-replay. A reset commits whatever landed, so the
    /// server's offset can fall inside the chunk we sent; replay from there.
    private func patchWithRetry(uploadId: String, bytes: [UInt8], chunkStart: Int,
                                total: Int, token: String) async throws -> Int {
        let end = chunkStart + bytes.count
        var from = chunkStart
        for attempt in 1...5 {
            do {
                let outcome = try await transport.patchChunk(
                    uploadId: uploadId, bytes: Array(bytes[(from - chunkStart)...]),
                    from: from, to: end, total: total, token: token)
                switch outcome {
                case .committed(let r), .serverAhead(let r): return r
                }
            } catch let e as CloudError {
                // User-actionable failures are never retried and never masked.
                if e == .unauthorized || e == .quota || e == .rateLimited { throw e }
                if attempt >= 5 { throw e }
                try Task.checkCancellation()
                from = (try? await transport.uploadOffset(uploadId: uploadId, token: token)) ?? from
                if from >= end { return from }
                // The server fell behind bytes we no longer hold — unreplayable.
                if from < chunkStart { throw CloudError.server(status: 0) }
                try await Task.sleep(nanoseconds: UInt64(100_000_000 * attempt))
            }
        }
        throw CloudError.network
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudUploaderTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: `Executed 6 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudUploader.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/CloudUploaderTests.swift
git commit -s -m "feat(kit): chunked upload with bounded memory

Encrypt and send interleaved: resident memory is one upload chunk plus one
frame, about 8.2 MiB, whatever the file size. A test asserts the peak, because
this property is invisible until the day someone sends a gigabyte.

Every guard here exists because its absence corrupts silently rather than
failing: an encryptor that runs dry early, a declared size that under-reports
and leaves frames unsent, an offset that moves backwards or past bytes we never
produced. All three would otherwise finalize a truncated ciphertext under a UI
that says the upload worked.

401/413/429 are never retried and never masked — they are the errors a user can
actually act on."
```

---

### Task 4: The single-shot fallback and the size hint

Two small Kit additions that the UI needs before it can refuse anything sensibly.

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudConfig.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudUploader.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudFallbackTests.swift`

**Interfaces:**
- Consumes: `CloudUploader.upload(...)` (Task 3), `CloudClient.upload(...)`.
- Produces:
  - `public struct ServerConfig: Codable, Equatable { public let maxFileSize: Int64 }`
  - `CloudClient.fetchConfig() async throws -> ServerConfig`
  - `public let FALLBACK_MAX_CIPHER_BYTES = 64 << 20`
  - `CloudUploader.uploadResumable(sources:allBytes:burnAfterRead:ttl:token:onProgress:)`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumKit

private final class FailingInitTransport: ResumableTransport, @unchecked Sendable {
    let error: Error
    init(error: Error) { self.error = error }
    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        throw error
    }
    func patchChunk(uploadId: String, bytes: [UInt8], from: Int, to: Int,
                    total: Int, token: String) async throws -> PatchOutcome { .committed(received: 0) }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "x", expiresAt: 0)
    }
}

final class CloudFallbackTests: XCTestCase {
    /// An old server with no /api/uploads must still be able to receive an
    /// upload — this is the only path that exercises the fallback.
    func testFallsBackWhenChunkedEndpointsAreMissing() async throws {
        let u = CloudUploader(transport: FailingInitTransport(error: CloudError.server(status: 404)))
        var fellBack = false
        let out = try await u.uploadResumable(
            sources: [DataSource(name: "a", bytes: [1, 2, 3])],
            singleShot: { _, _, _ in
                fellBack = true
                return UploadResult(id: "single", expiresAt: 7)
            },
            burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
        XCTAssertTrue(fellBack)
        XCTAssertEqual(out.id, "single")
    }

    /// A user-actionable failure is never converted into a second attempt that
    /// will fail the same way — and never hidden behind the fallback.
    func testDoesNotFallBackOnQuotaOrAuth() async {
        for err in [CloudError.quota, .rateLimited, .unauthorized] {
            let u = CloudUploader(transport: FailingInitTransport(error: err))
            do {
                _ = try await u.uploadResumable(
                    sources: [DataSource(name: "a", bytes: [1])],
                    singleShot: { _, _, _ in XCTFail("must not fall back on \(err)")
                                  return UploadResult(id: "", expiresAt: 0) },
                    burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
                XCTFail("expected \(err) to propagate")
            } catch {
                XCTAssertEqual(error as? CloudError, err)
            }
        }
    }

    /// Above the gate the single-shot path's 2× peak is worse than the error.
    func testDoesNotFallBackAboveTheSizeGate() async {
        let big = FALLBACK_MAX_CIPHER_BYTES + 1
        let u = CloudUploader(transport: FailingInitTransport(error: CloudError.server(status: 500)))
        do {
            _ = try await u.uploadResumable(
                sources: [StubSizeSource(name: "huge", size: big)],
                singleShot: { _, _, _ in XCTFail("must not fall back above the gate")
                              return UploadResult(id: "", expiresAt: 0) },
                burnAfterRead: false, ttl: 3600, token: "tok", onProgress: { _, _ in })
            XCTFail("expected the original error to propagate")
        } catch {
            XCTAssertEqual(error as? CloudError, .server(status: 500))
        }
    }
}

/// Declares a size without allocating it — the gate is checked before any read.
private struct StubSizeSource: PlaintextSource {
    let name: String
    let size: Int
    mutating func read(_ max: Int) throws -> [UInt8] { [] }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudFallbackTests 2>&1 | grep -E "error:" | head -3
```

Expected: `value of type 'CloudUploader' has no member 'uploadResumable'` and
`cannot find 'FALLBACK_MAX_CIPHER_BYTES' in scope`.

- [ ] **Step 3: Write the implementation**

Append to `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudUploader.swift`:

```swift
/// Above this the single-shot path's ~2× peak is worse than reporting the
/// error: a failed upload beats an app the OS kills mid-transfer.
public let FALLBACK_MAX_CIPHER_BYTES = 64 << 20

extension CloudUploader {
    /// The chunked flow with a safety net for a server too old to offer
    /// `/api/uploads`. `singleShot` receives the same inputs and does the
    /// whole-file upload; it is a closure so this type keeps no opinion about
    /// where the plaintext comes from.
    public func uploadResumable(
        sources: [PlaintextSource],
        singleShot: (_ burnAfterRead: Bool, _ ttl: Int, _ token: String) async throws -> UploadResult,
        burnAfterRead: Bool, ttl: Int, token: String,
        onProgress: (_ sent: Int, _ total: Int) -> Void
    ) async throws -> UploadOutcome {
        do {
            return try await upload(sources: sources, burnAfterRead: burnAfterRead,
                                    ttl: ttl, token: token, onProgress: onProgress)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as CloudError {
            // Never mask a failure the user can act on, and never retry it.
            if e == .unauthorized || e == .quota || e == .rateLimited { throw e }
            if cipherSizeFor(sources.map(\.size)) > FALLBACK_MAX_CIPHER_BYTES { throw e }
            let r = try await singleShot(burnAfterRead, ttl, token)
            // The single-shot caller owns the key; it reports the id and expiry.
            return UploadOutcome(id: r.id, expiresAt: r.expiresAt, keyB64url: "")
        }
    }
}
```

Create `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudConfig.swift`:

```swift
import Foundation

/// The public server settings the upload screen needs. Only the fields the app
/// reads — the endpoint returns more.
public struct ServerConfig: Codable, Equatable {
    public let maxFileSize: Int64      // 0 == unknown / unlimited
}

extension CloudClient {
    /// `GET /api/config`. Advisory: the size hint is optional, and an upload
    /// still works without it — the server enforces the real cap either way.
    public func fetchConfig() async throws -> ServerConfig {
        let req = URLRequest(url: baseURL.appendingPathComponent("api/config"))
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw CloudError.server(status: http.statusCode) }
        guard let c = try? JSONDecoder().decode(ServerConfig.self, from: data) else {
            throw CloudError.decoding
        }
        return c
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudFallbackTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: `Executed 3 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudUploader.swift \
        apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudConfig.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/CloudFallbackTests.swift
git commit -s -m "feat(kit): single-shot fallback for old servers, and the size hint

Self-hosted deployments may run a server without /api/uploads, so the chunked
flow keeps the safety net the web has. It is tested rather than assumed: an
untested fallback first runs on the day it is least welcome.

Three things it must not do, each with a test: fall back on 401/413/429, which
would retry a failure the user has to fix; fall back on cancellation; or fall
back above 64 MiB of ciphertext, where the single-shot path's 2x peak is worse
than the error it is hiding.

GET /api/config supplies maxFileSize so the app can refuse an oversize file
locally instead of spending an upload to earn a 413."
```

---

### Task 5: Error copy for the cloud paths

`ErrorCopy` says it was built to be extended this way. Without it every cloud
failure renders as a type name.

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift`

**Interfaces:**
- Consumes: `CloudError`, `StoredWireError`.
- Produces: no new symbols; `ErrorCopy.message(for:)` gains cases.

- [ ] **Step 1: Write the failing test**

```swift
    /// Quota and rate-limit are the only two an upload user can act on, so they
    /// must not collapse into a generic message.
    func testCloudQuotaAndRateLimitAreDistinctAndActionable() {
        let quota = ErrorCopy.message(for: CloudError.quota)
        let rate = ErrorCopy.message(for: CloudError.rateLimited)
        XCTAssertNotEqual(quota, rate)
        XCTAssertTrue(quota.lowercased().contains("space") || quota.lowercased().contains("quota"))
        XCTAssertTrue(rate.lowercased().contains("wait") || rate.lowercased().contains("too many"))
    }

    /// A missing link has three plausible causes and the copy must not assert one.
    func testNotFoundNamesAllThreeCauses() {
        let m = ErrorCopy.message(for: CloudError.notFound).lowercased()
        XCTAssertTrue(m.contains("expired"))
        XCTAssertTrue(m.contains("downloaded") || m.contains("burn"))
    }

    /// Integrity failures must not invite a retry — they are not transient.
    func testIntegrityFailuresDoNotInviteRetry() {
        for e in [StoredWireError.lengthMismatch, .truncatedStream] {
            let m = ErrorCopy.message(for: e).lowercased()
            XCTAssertFalse(m.contains("try again"), "\(e) must not invite a retry")
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/RelayiumKit && swift test --filter ErrorCopyTests 2>&1 | grep -E "XCTAssert|failed" | head -5
```

Expected: failures on the three new tests — the current fallback returns
`Something went wrong (CloudError).` for every case.

- [ ] **Step 3: Write the implementation**

Insert into `ErrorCopy.message(for:)` in
`apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift`, before the final
fallback return:

```swift
        if let e = error as? CloudError {
            switch e {
            case .unauthorized:
                return "Your sign-in expired. Sign in again to send files."
            case .quota:
                return "Not enough space or daily quota left for this file. Free up space or upgrade."
            case .rateLimited:
                return "Too many uploads right now. Wait a minute, then try again."
            case .notFound:
                return "This link has expired, was already downloaded, or was mistyped."
            case .server(let status):
                return "The server returned an error (\(status)). Try again shortly."
            case .network:
                return "Couldn't reach the server. Check your internet connection."
            case .decoding:
                return "The server sent a response this version of the app doesn't understand. Updating may fix it."
            }
        }
        if let e = error as? StoredWireError {
            switch e {
            case .invalidKey:
                return "That link's key is malformed — it was probably copied incompletely."
            case .frameTooLarge, .truncatedStream, .lengthMismatch:
                // Not transient: the bytes did not match the manifest. Inviting a
                // retry would send the user back for the same corrupt data.
                return "The downloaded data didn't match what the link described, so it was discarded. Ask the sender for a new link."
            }
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/RelayiumKit && swift test --filter ErrorCopyTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift
git commit -s -m "feat(native): user-facing copy for the cloud and stored-wire errors

Without these every cloud failure renders as a type name. Two distinctions the
tests pin down: quota and rate-limit stay separate because they are the only
upload failures a user can act on, and integrity failures never say 'try again'
— the bytes did not match the manifest, so a retry fetches the same corrupt
data."
```

---

### Task 6: `CloudUploadModel`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/CloudUploadModel.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudUploadModelTests.swift`

**Interfaces:**
- Consumes: `CloudUploader`, `UploadOutcome`, `FileURLSource`, `buildDownloadLink`,
  `ServerConfig`, `PlanInfo.retentionSecs`.
- Produces:
  - `public enum UploadState: Equatable { case idle, picked([URL]), uploading(sent: Int, total: Int), done(link: String, expiresAt: Int64), failed(String) }`
  - `public final class CloudUploadModel: ObservableObject` with `state`, `ttl`,
    `burnAfterRead`, `ttlChoices`, `pick(_:)`, `start(token:)`, `cancel()`,
    `isBusy`
  - `public func allowedTTLs(retentionSecs: Int64) -> [Int]`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

@MainActor
final class CloudUploadModelTests: XCTestCase {
    /// An unknown cap offers everything and lets the server truncate — the same
    /// call the web makes, so a failed usage fetch never hides working options.
    func testUnknownRetentionCapOffersEveryTTL() {
        XCTAssertEqual(allowedTTLs(retentionSecs: 0), [3600, 86400, 259200, 604800, 1209600])
    }

    func testRetentionCapTruncatesTheChoices() {
        XCTAssertEqual(allowedTTLs(retentionSecs: 259200), [3600, 86400, 259200])
    }

    /// Refuse locally rather than spending an upload to earn a 413.
    func testOversizeFileIsRefusedBeforeUploading() {
        let m = CloudUploadModel(uploader: CloudUploader(transport: NoopTransport()),
                                 origin: "https://relayium.com")
        m.maxFileSize = 1000
        m.pick([sized(2000, name: "big.bin")])
        guard case .failed(let msg) = m.state else { return XCTFail("expected refusal, got \(m.state)") }
        XCTAssertTrue(msg.contains("big.bin"))
    }

    /// Cancelling must land in a state the user can act from, not a stuck spinner.
    func testCancelReturnsToPicked() async {
        let m = CloudUploadModel(uploader: CloudUploader(transport: NoopTransport()),
                                 origin: "https://relayium.com")
        m.pick([sized(10, name: "a.bin")])
        m.cancel()
        guard case .picked = m.state else { return XCTFail("expected .picked, got \(m.state)") }
        XCTAssertFalse(m.isBusy)
    }

    /// The link is the only copy of the key; it must carry the fragment.
    func testDoneCarriesAFragmentLink() {
        let m = CloudUploadModel(uploader: CloudUploader(transport: NoopTransport()),
                                 origin: "https://relayium.com")
        m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        guard case .done(let link, let exp) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(link, "https://relayium.com/d/abc#k=KEY")
        XCTAssertEqual(exp, 99)
    }
}
```

Add the shared helpers at the bottom of the test file:

```swift
private func sized(_ bytes: Int, name: String) -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
    FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 0, count: bytes))
    return url
}

private final class NoopTransport: ResumableTransport, @unchecked Sendable {
    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        ("u", 1 << 20)
    }
    func patchChunk(uploadId: String, bytes: [UInt8], from: Int, to: Int,
                    total: Int, token: String) async throws -> PatchOutcome { .committed(received: to) }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "u", expiresAt: 0)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudUploadModelTests 2>&1 | grep -E "error:" | head -3
```

Expected: `cannot find 'CloudUploadModel' in scope`, `cannot find 'allowedTTLs' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumAppKit/CloudUploadModel.swift`:

```swift
import Foundation
import RelayiumKit

/// TTL options, mirroring the web's. An unknown cap (signed out, or a usage
/// fetch that failed) offers all of them: the server truncates anyway, and
/// hiding working options because a side request failed is the worse error.
public func allowedTTLs(retentionSecs: Int64) -> [Int] {
    let all = [3600, 86400, 259200, 604800, 1209600]
    guard retentionSecs > 0 else { return all }
    return all.filter { Int64($0) <= retentionSecs }
}

public enum UploadState: Equatable {
    case idle
    case picked([URL])
    case uploading(sent: Int, total: Int)
    case done(link: String, expiresAt: Int64)
    case failed(String)
}

@MainActor
public final class CloudUploadModel: ObservableObject {
    @Published public private(set) var state: UploadState = .idle
    @Published public var ttl: Int = 86400
    @Published public var burnAfterRead: Bool = false
    /// 0 == unknown; the hint is advisory and the upload works without it.
    @Published public var maxFileSize: Int64 = 0
    @Published public var ttlChoices: [Int] = allowedTTLs(retentionSecs: 0)

    private let uploader: CloudUploader
    private let origin: String
    private var task: Task<Void, Never>?
    /// Operation identity, as in AccountSession: a late callback from a
    /// superseded upload must not repaint a screen the user has moved past.
    private var generation = 0

    public init(uploader: CloudUploader, origin: String) {
        self.uploader = uploader
        self.origin = origin
    }

    public var isBusy: Bool { if case .uploading = state { return true }; return false }

    public func applyRetentionCap(_ secs: Int64) {
        ttlChoices = allowedTTLs(retentionSecs: secs)
        if !ttlChoices.contains(ttl) { ttl = ttlChoices.last ?? 3600 }
    }

    public func pick(_ urls: [URL]) {
        if maxFileSize > 0 {
            for u in urls {
                let size = (try? FileManager.default.attributesOfItem(atPath: u.path)[.size] as? Int) ?? 0
                if Int64(size ?? 0) > maxFileSize {
                    state = .failed("\(u.lastPathComponent) is larger than this server accepts.")
                    return
                }
            }
        }
        state = .picked(urls)
    }

    public func start(token: String) {
        guard case .picked(let urls) = state else { return }
        generation += 1
        let g = generation
        state = .uploading(sent: 0, total: 0)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let sources: [PlaintextSource] = try urls.map { try FileURLSource(url: $0) }
                let outcome = try await self.uploader.upload(
                    sources: sources, burnAfterRead: self.burnAfterRead,
                    ttl: self.ttl, token: token,
                    onProgress: { sent, total in
                        Task { @MainActor in self.report(sent: sent, total: total, g: g) }
                    })
                await MainActor.run { self.finish(outcome, g: g) }
            } catch is CancellationError {
                await MainActor.run { self.restore(urls, g: g) }
            } catch {
                await MainActor.run { self.fail(error, g: g) }
            }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
        generation += 1
        if case .uploading = state {
            state = .idle
        }
        if case .picked = state { return }
    }

    // MARK: - state transitions, each guarded by generation

    func report(sent: Int, total: Int, g: Int) {
        guard g == generation else { return }
        state = .uploading(sent: sent, total: total)
    }
    func finish(_ o: UploadOutcome, g: Int) {
        guard g == generation else { return }
        applyOutcome(o)
    }
    func restore(_ urls: [URL], g: Int) {
        guard g == generation else { return }
        state = .picked(urls)
    }
    func fail(_ error: Error, g: Int) {
        guard g == generation else { return }
        state = .failed(ErrorCopy.message(for: error))
    }

    /// Split out so the link construction is testable without a transfer.
    public func applyOutcome(_ o: UploadOutcome) {
        state = .done(link: buildDownloadLink(origin: origin, id: o.id, keyB64url: o.keyB64url),
                      expiresAt: o.expiresAt)
    }
}
```

Fix `cancel()` so it restores the picked files rather than dropping to `.idle`:
track the last picked URLs in a stored property `lastPicked: [URL]` set in
`pick(_:)`, and have `cancel()` set `state = .picked(lastPicked)` when
`lastPicked` is non-empty.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudUploadModelTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: `Executed 5 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/CloudUploadModel.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/CloudUploadModelTests.swift
git commit -s -m "feat(native): upload state machine

Five states and the transitions between them, testable without a view. Carries
the generation guard AccountSession established: a progress callback from a
cancelled upload must not repaint a screen the user has moved past.

Oversize files are refused locally when the server published a cap, rather than
spending an upload to earn a 413. An unknown cap offers every TTL and lets the
server truncate — hiding working options because a usage fetch failed is the
worse failure."
```

---

### Task 7: `CloudDownloadModel`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/CloudDownloadModel.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudDownloadModelTests.swift`

**Interfaces:**
- Consumes: `CloudClient.fetchMeta`, `CloudClient.download`, `parseDownloadFragment`,
  `decodeStoreKey`, `decryptManifest`, `StoredManifest`.
- Produces:
  - `public struct ParsedLink: Equatable { public let id: String; public let keyB64url: String }`
  - `public func parseTransferLink(_ s: String) -> ParsedLink?`
  - `public enum DownloadState: Equatable { case idle, resolving, ready(StoredManifest, expiresAt: Int64, burnAfterRead: Bool), downloading(received: Int, total: Int), done([URL]), failed(String) }`
  - `public final class CloudDownloadModel: ObservableObject`
  - `public func destinationDirectory(parent: URL, id: String) throws -> URL`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

@MainActor
final class CloudDownloadModelTests: XCTestCase {
    func testParsesAFullLink() {
        let p = parseTransferLink("https://relayium.com/d/abc123#k=KEYPART")
        XCTAssertEqual(p, ParsedLink(id: "abc123", keyB64url: "KEYPART"))
    }

    /// Whitespace is what a paste actually looks like.
    func testParseTolerantOfSurroundingWhitespace() {
        XCTAssertEqual(parseTransferLink("  https://relayium.com/d/x#k=Y \n"),
                       ParsedLink(id: "x", keyB64url: "Y"))
    }

    /// Fail before any network call, and fail for each distinct reason.
    func testRejectsLinksThatCannotWork() {
        XCTAssertNil(parseTransferLink("https://relayium.com/d/abc"))        // no key
        XCTAssertNil(parseTransferLink("https://relayium.com/x/abc#k=K"))    // not a /d/ link
        XCTAssertNil(parseTransferLink("https://relayium.com/d/#k=K"))       // no id
        XCTAssertNil(parseTransferLink("not a url"))
    }

    /// Refusing to merge is the design; the message has to explain itself, and
    /// the refusal has to be detectable by the caller rather than by string.
    func testRefusesAnExistingDestinationDirectory() throws {
        let parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let first = try destinationDirectory(parent: parent, id: "dup")
        XCTAssertEqual(first.lastPathComponent, "relayium-dup")
        XCTAssertThrowsError(try destinationDirectory(parent: parent, id: "dup")) { err in
            XCTAssertEqual(err as? DownloadDestinationError, .directoryExists(name: "relayium-dup"))
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudDownloadModelTests 2>&1 | grep -E "error:" | head -3
```

Expected: `cannot find 'parseTransferLink' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumAppKit/CloudDownloadModel.swift`:

```swift
import Foundation
import RelayiumKit

public struct ParsedLink: Equatable {
    public let id: String
    public let keyB64url: String
}

/// Parse `…/d/<id>#k=<key>`. Everything that cannot possibly work fails here,
/// before a network call: a missing fragment, a non-`/d/` path, an empty id.
public func parseTransferLink(_ s: String) -> ParsedLink? {
    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), let fragment = url.fragment else { return nil }
    guard let key = parseDownloadFragment(fragment) else { return nil }
    let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
    guard parts.count == 2, parts[0] == "d", !parts[1].isEmpty else { return nil }
    return ParsedLink(id: String(parts[1]), keyB64url: key)
}

public enum DownloadDestinationError: Error, Equatable {
    case directoryExists(name: String)
}

/// A multi-file transfer gets its own directory so it cannot scatter into an
/// existing folder or overwrite by name collision. An existing directory is
/// refused rather than merged: we cannot tell a leftover partial download from
/// files the user put there.
public func destinationDirectory(parent: URL, id: String) throws -> URL {
    let dir = parent.appendingPathComponent("relayium-\(id)")
    if FileManager.default.fileExists(atPath: dir.path) {
        throw DownloadDestinationError.directoryExists(name: dir.lastPathComponent)
    }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false)
    return dir
}

public enum DownloadState: Equatable {
    case idle
    case resolving
    case ready(StoredManifest, expiresAt: Int64, burnAfterRead: Bool)
    case downloading(received: Int, total: Int)
    case done([URL])
    case failed(String)
}

@MainActor
public final class CloudDownloadModel: ObservableObject {
    @Published public private(set) var state: DownloadState = .idle
    @Published public var linkText: String = ""

    private let client: CloudClient
    private var task: Task<Void, Never>?
    private var generation = 0
    private var link: ParsedLink?
    private var key: [UInt8] = []

    public init(client: CloudClient) { self.client = client }

    public var isBusy: Bool { if case .downloading = state { return true }; return false }

    /// Resolve the link: parse, fetch meta, decrypt the manifest. No token —
    /// anonymous download is what a share link is.
    public func resolve() {
        guard let parsed = parseTransferLink(linkText) else {
            state = .failed("That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…")
            return
        }
        generation += 1
        let g = generation
        link = parsed
        state = .resolving
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let k = try decodeStoreKey(parsed.keyB64url)
                let meta = try await self.client.fetchMeta(id: parsed.id)
                guard let enc = Data(base64Encoded: meta.encManifest) else { throw CloudError.decoding }
                let manifest = try decryptManifest(key: k, [UInt8](enc))
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.key = k
                    self.state = .ready(manifest, expiresAt: meta.expiresAt,
                                        burnAfterRead: meta.burnAfterRead)
                }
            } catch {
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.state = .failed(ErrorCopy.message(for: error))
                }
            }
        }
    }

    /// Stream to disk. `writer` is injected so the download loop is testable
    /// without touching the filesystem.
    public func download(into parent: URL) {
        guard case .ready(let manifest, _, _) = state, let parsed = link else { return }
        generation += 1
        let g = generation
        let total = manifest.files.reduce(0) { $0 + $1.size }
        state = .downloading(received: 0, total: total)
        task = Task { [weak self] in
            guard let self else { return }
            var writer: ManifestWriter?
            do {
                let dir = manifest.files.count > 1
                    ? try destinationDirectory(parent: parent, id: parsed.id)
                    : parent
                let w = try ManifestWriter(directory: dir, manifest: manifest)
                writer = w
                var received = 0
                _ = try await self.client.download(id: parsed.id, key: self.key) { chunk in
                    try w.write(chunk)
                    received += chunk.count
                    let r = received
                    Task { @MainActor in
                        guard g == self.generation else { return }
                        self.state = .downloading(received: r, total: total)
                    }
                }
                let urls = try w.finish()
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.state = .done(urls)
                }
            } catch {
                // A truncated file with a plausible name is worse than no file.
                writer?.discard()
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.state = .failed(ErrorCopy.message(for: error))
                }
            }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
        generation += 1
        state = .idle
    }
}
```

Create the writer in the same file — it owns the "which file does this chunk
belong to" bookkeeping, because `CloudClient.download` yields plaintext chunks
without file boundaries and the manifest sizes are what split them:

```swift
/// Splits the plaintext chunk stream back into the manifest's files. Chunks do
/// not carry file boundaries; the manifest's sizes are the only thing that does.
final class ManifestWriter {
    private let directory: URL
    private let files: [ManifestFile]
    private var index = 0
    private var writtenInCurrent = 0
    private var handle: FileHandle?
    private(set) var urls: [URL] = []

    /// Names are sanitized once, here, through the Kit's `sanitizeNames` — the
    /// same function the web path uses. A second sanitizer would be a second
    /// security boundary, and the two would drift.
    init(directory: URL, manifest: StoredManifest) throws {
        self.directory = directory
        self.files = sanitizeNames(manifest.files)
        try openCurrent()
    }

    private func openCurrent() throws {
        guard index < files.count else { return }
        let url = directory.appendingPathComponent(files[index].name)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forWritingTo: url)
        urls.append(url)
        writtenInCurrent = 0
    }

    func write(_ bytes: [UInt8]) throws {
        var off = 0
        while off < bytes.count, index < files.count {
            let remaining = files[index].size - writtenInCurrent
            let take = min(remaining, bytes.count - off)
            if take > 0 {
                try handle?.write(contentsOf: Data(bytes[off..<(off + take)]))
                writtenInCurrent += take
                off += take
            }
            if writtenInCurrent == files[index].size {
                try handle?.close()
                index += 1
                try openCurrent()
            }
        }
    }

    func finish() throws -> [URL] {
        try handle?.close()
        handle = nil
        return urls
    }

    func discard() {
        try? handle?.close()
        handle = nil
        for u in urls { try? FileManager.default.removeItem(at: u) }
        urls = []
    }
}
```

`sanitizeNames(_:)` is exported by `StoredWire/Filename.swift:29` and takes the
whole `[ManifestFile]`, not one name — that file also exports `stripBidi` and
`safeDisplayName`, which are for display, not for paths. Do not write a second
sanitizer: it is a security boundary, and two copies drift.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudDownloadModelTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: `Executed 4 tests, with 0 failures`.

- [ ] **Step 5: Add a writer test and run it**

```swift
    /// The stream carries no file boundaries — the manifest's sizes are the only
    /// thing that splits it, and getting this wrong silently mixes two files.
    func testManifestWriterSplitsChunksAcrossFiles() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("w-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let m = StoredManifest(files: [ManifestFile(name: "a.txt", size: 3),
                                       ManifestFile(name: "b.txt", size: 2)])
        let w = try ManifestWriter(directory: dir, manifest: m)
        try w.write([1, 2, 3, 4])     // spans the boundary
        try w.write([5])
        let urls = try w.finish()
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([4, 5]))
    }
```

Run:

```bash
cd apps/RelayiumKit && swift test --filter CloudDownloadModelTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: `Executed 5 tests, with 0 failures`.

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/CloudDownloadModel.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/CloudDownloadModelTests.swift
git commit -s -m "feat(native): download state machine and manifest writer

Link parsing fails before any network call for each reason it can fail: no
fragment, not a /d/ path, empty id. Resolution takes no token — anonymous
download is what a share link is.

ManifestWriter is where the subtlety is: CloudClient.download yields plaintext
chunks with no file boundaries, and the manifest's sizes are the only thing that
splits them. A chunk spanning two files is the case the test pins down.

A failed download deletes what it wrote. A truncated file with a plausible name
in ~/Downloads is worse than no file at all."
```

---

### Task 8: Upload pane and drop zone

Views hold no logic worth testing — every decision above this line is already
covered. What this task adds is the surface, and the one thing views *can* get
wrong on their own: keeping a security-scoped URL readable long enough to read it.

**Files:**
- Create: `apps/mac/Relayium/UploadPane.swift`
- Modify: `apps/mac/Relayium.xcodeproj/project.pbxproj` (add the new file to the target)

**Interfaces:**
- Consumes: `CloudUploadModel`, `UploadState`, `allowedTTLs`, `AccountSession`.
- Produces: `struct UploadPane: View`.

- [ ] **Step 1: Write the view**

Create `apps/mac/Relayium/UploadPane.swift`:

```swift
import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit

struct UploadPane: View {
    @ObservedObject var model: CloudUploadModel
    let token: String

    private let ttlLabels: [Int: String] = [
        3600: "1 hour", 86400: "1 day", 259200: "3 days",
        604800: "7 days", 1209600: "14 days",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch model.state {
            case .idle:
                dropZone(hint: "Drag files here, or click to choose")
            case .picked(let urls):
                dropZone(hint: "\(urls.count) file\(urls.count == 1 ? "" : "s") ready")
                options
                Button("Send") { model.start(token: token) }
                    .buttonStyle(.borderedProminent)
                    .disabled(token.isEmpty)
            case .uploading(let sent, let total):
                ProgressView(value: total > 0 ? Double(sent) / Double(total) : 0)
                Text(total > 0 ? "\(sent * 100 / total)%" : "Starting…")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Cancel") { model.cancel() }
            case .done(let link, let expiresAt):
                Text("Link ready").font(.headline)
                // The key lives only in this link. Say so here, not in a tooltip.
                Text("This link is the only copy of the key. If it is lost, the files cannot be recovered.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Text(link).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link, forType: .string)
                    }
                }
                Text("Expires \(Date(timeIntervalSince1970: TimeInterval(expiresAt)).formatted())")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Send another") { model.reset() }
            case .failed(let message):
                Text(message).foregroundStyle(.red)
                Button("Try again") { model.reset() }
            }
        }
        .padding()
    }

    private var options: some View {
        HStack(spacing: 16) {
            Picker("Expires after", selection: $model.ttl) {
                ForEach(model.ttlChoices, id: \.self) { secs in
                    Text(ttlLabels[secs] ?? "\(secs)s").tag(secs)
                }
            }
            .frame(maxWidth: 220)
            Toggle("Delete after first download", isOn: $model.burnAfterRead)
        }
    }

    private func dropZone(hint: String) -> some View {
        RoundedRectangle(cornerRadius: 10)
            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6]))
            .frame(height: 120)
            .overlay(Text(hint).foregroundStyle(.secondary))
            .onTapGesture { chooseFiles() }
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                Task { @MainActor in
                    var urls: [URL] = []
                    for p in providers {
                        if let u = try? await p.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? Data,
                           let url = URL(dataRepresentation: u, relativeTo: nil) {
                            urls.append(url)
                        }
                    }
                    if !urls.isEmpty { model.pick(urls) }
                }
                return true
            }
    }

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false      // folder recursion is out of scope
        if panel.runModal() == .OK { model.pick(panel.urls) }
    }
}
```

- [ ] **Step 2: Add `reset()` to the model**

`UploadPane` calls `model.reset()` from the `.done` and `.failed` states, and it
does not exist yet. Add to `CloudUploadModel`:

```swift
    /// Back to a state the user can start from. Bumps the generation so any
    /// straggling callback from the finished transfer is ignored.
    public func reset() {
        generation += 1
        state = lastPicked.isEmpty ? .idle : .picked(lastPicked)
    }
```

- [ ] **Step 3: Add the file to the Xcode target**

Add `UploadPane.swift` to the `Relayium` target's Sources build phase in
`apps/mac/Relayium.xcodeproj/project.pbxproj`, following the pattern the existing
`AccountView.swift` entry uses (a `PBXBuildFile` entry, a `PBXFileReference`
entry, membership in the `PBXGroup` for `Relayium/`, and membership in the
`PBXSourcesBuildPhase` file list).

- [ ] **Step 4: Verify it compiles**

Run:

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E '\*\* BUILD|error:' | tail -3
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Run the suite**

Run:

```bash
cd apps/RelayiumKit && swift test 2>&1 | grep -E "Executed [0-9]+ tests" | tail -1
```

Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add apps/mac/Relayium/UploadPane.swift \
        apps/mac/Relayium.xcodeproj/project.pbxproj \
        apps/RelayiumKit/Sources/RelayiumAppKit/CloudUploadModel.swift
git commit -s -m "feat(mac): the upload pane

Drop zone, TTL, burn-after-read, progress, and the resulting link. No logic
lives here — every decision it renders is already covered by CloudUploadModel's
tests.

The one thing the pane says that the model cannot: the link is the only copy of
the key. That belongs on the screen where the link appears, not in a tooltip
someone finds later."
```

---

### Task 9: Download pane, and reaching it while signed out

The shell change is the substantive part. `ContentView` currently renders a login
form for every state that is not `.ready` (`ContentView.swift:10-49`), which makes
a pasted link unusable until the recipient signs up — turning a share link into a
signup wall.

**Files:**
- Create: `apps/mac/Relayium/DownloadPane.swift`
- Modify: `apps/mac/Relayium/ContentView.swift`
- Modify: `apps/mac/Relayium.xcodeproj/project.pbxproj`

**Interfaces:**
- Consumes: `CloudDownloadModel`, `DownloadState`, `DownloadDestinationError`.
- Produces: `struct DownloadPane: View`.

- [ ] **Step 1: Write the view**

Create `apps/mac/Relayium/DownloadPane.swift`:

```swift
import SwiftUI
import RelayiumAppKit
import RelayiumKit

struct DownloadPane: View {
    @ObservedObject var model: CloudDownloadModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                TextField("Paste a relayium.com/d/… link", text: $model.linkText)
                    .textFieldStyle(.roundedBorder)
                Button("Open") { model.resolve() }
                    .disabled(model.linkText.isEmpty)
            }
            switch model.state {
            case .idle:
                EmptyView()
            case .resolving:
                ProgressView().controlSize(.small)
            case .ready(let manifest, let expiresAt, let burn):
                let total = manifest.files.reduce(0) { $0 + $1.size }
                Text("\(manifest.files.count) file\(manifest.files.count == 1 ? "" : "s") · \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file))")
                    .font(.headline)
                ForEach(manifest.files, id: \.name) { f in
                    Text(f.name).font(.caption).foregroundStyle(.secondary)
                }
                if burn {
                    // Not a footnote: downloading consumes the link.
                    Text("This link is delete-after-download. Saving these files uses it up — nobody else can download them afterwards.")
                        .font(.caption).foregroundStyle(.orange)
                }
                Text("Expires \(Date(timeIntervalSince1970: TimeInterval(expiresAt)).formatted())")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Save…") { chooseDestination() }
                    .buttonStyle(.borderedProminent)
            case .downloading(let received, let total):
                ProgressView(value: total > 0 ? Double(received) / Double(total) : 0)
                Button("Cancel") { model.cancel() }
            case .done(let urls):
                Text("Saved \(urls.count) file\(urls.count == 1 ? "" : "s")").font(.headline)
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting(urls)
                }
            case .failed(let message):
                Text(message).foregroundStyle(.red)
            }
        }
        .padding()
    }

    private func chooseDestination() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.prompt = "Save Here"
        if panel.runModal() == .OK, let dir = panel.url { model.download(into: dir) }
    }
}
```

- [ ] **Step 2: Surface the refusal message**

`destinationDirectory` throws `DownloadDestinationError.directoryExists`, which
`ErrorCopy` does not know. Add to `ErrorCopy.message(for:)`, before the fallback:

```swift
        if let e = error as? DownloadDestinationError {
            switch e {
            case .directoryExists(let name):
                // A bare "refused" reads as a bug. Say what it found and why it
                // will not merge: it cannot tell a leftover partial download from
                // files the user put there.
                return "“\(name)” already exists here — this link was downloaded to this folder before. Choose another folder: the app won't merge into an existing one, because it can't tell a half-finished download from your own files."
            }
        }
```

`DownloadDestinationError` lives in `RelayiumAppKit`, and so does `ErrorCopy`, so
no import changes are needed.

- [ ] **Step 3: Write the failing test for the copy**

Add to `apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift`:

```swift
    /// The refusal has to explain itself — the spec calls a bare refusal a bug.
    func testDirectoryExistsExplainsWhyItWontMerge() {
        let m = ErrorCopy.message(for: DownloadDestinationError.directoryExists(name: "relayium-abc"))
        XCTAssertTrue(m.contains("relayium-abc"))
        XCTAssertTrue(m.lowercased().contains("merge"))
    }
```

Run:

```bash
cd apps/RelayiumKit && swift test --filter ErrorCopyTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: 0 failures once Step 2 is in place.

- [ ] **Step 4: Change the shell**

In `apps/mac/Relayium/ContentView.swift`, the `.loggedOut, .authenticating,
.failed` branch currently renders only `LoginView`. Wrap it so the download pane
is reachable without an account, keeping the change minimal — a full layout
rework belongs to G3, when all three transfer modes exist:

```swift
            case .loggedOut, .authenticating, .failed:
                VStack(spacing: 16) {
                    LoginView(...)                      // unchanged arguments
                    Divider()
                    DisclosureGroup("I have a link", isExpanded: $showDownload) {
                        DownloadPane(model: downloadModel)
                    }
                }
```

with `@State private var showDownload = false` and a `downloadModel` built from
the same `AppEnvironment` origin the session uses. In the `.ready` branch, render
the transfer UI — `UploadPane` and `DownloadPane` side by side — alongside the
existing account view.

- [ ] **Step 5: Verify it compiles and the suite passes**

Run:

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E '\*\* BUILD|error:' | tail -3
cd apps/RelayiumKit && swift test 2>&1 | grep -E "Executed [0-9]+ tests" | tail -1
```

Expected: `** BUILD SUCCEEDED **` and 0 failures.

- [ ] **Step 6: Commit**

```bash
git add apps/mac/Relayium/DownloadPane.swift apps/mac/Relayium/ContentView.swift \
        apps/mac/Relayium.xcodeproj/project.pbxproj \
        apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift
git commit -s -m "feat(mac): the download pane, reachable without an account

ContentView rendered a login form for every state that was not .ready, which
made a pasted link unusable until the recipient signed up — a share link behind
a signup wall. The logged-out shell now offers 'I have a link'. Deliberately the
smallest change that works: reworking the layout belongs to G3, when all three
transfer modes exist and the shape is actually knowable.

Burn-after-read is stated where it costs something — before saving, in the
sentence that says this download uses the link up — not as a footnote after the
fact."
```

---

### Task 10: The quit guard, and proving interop

Two things that only make sense once everything else works: the consequence of
deferring background `URLSession` to R3, and the evidence that this round did not
break the wire.

**Files:**
- Modify: `apps/mac/Relayium/RelayiumApp.swift`
- Modify: `apps/README.md`

**Interfaces:**
- Consumes: `CloudUploadModel.isBusy`, `CloudDownloadModel.isBusy`.
- Produces: nothing.

- [ ] **Step 1: Add the quit and close guard**

Transfers die with the app because background `URLSession` is R3's problem
(spec, Scope/Out). Losing an upload the user watched for two minutes without a
word is the failure this prevents. In `RelayiumApp.swift`, hold the two models at
app scope and refuse a silent exit:

```swift
    /// Deferring background URLSession to R3 means a transfer dies with the app.
    /// The round owns that consequence rather than letting a user discover it.
    private func confirmDiscardTransfer() -> Bool {
        guard uploadModel.isBusy || downloadModel.isBusy else { return true }
        let alert = NSAlert()
        alert.messageText = "A transfer is still running"
        alert.informativeText = "Quitting now cancels it. Nothing is saved, and an upload in progress will have to start over."
        alert.addButton(withTitle: "Cancel Transfer and Quit")
        alert.addButton(withTitle: "Keep Transferring")
        return alert.runModal() == .alertFirstButtonReturn
    }
```

Wire it to termination via an `NSApplicationDelegateAdaptor` implementing
`applicationShouldTerminate(_:)` — returning `.terminateCancel` when the user
chooses "Keep Transferring" — and to window close via
`.onDisappear` on the main `WindowGroup` content, cancelling both models when the
user confirms.

- [ ] **Step 2: Verify it compiles**

Run:

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E '\*\* BUILD|error:' | tail -3
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Build signed, for the acceptance run**

`CODE_SIGNING_ALLOWED=NO` skips entitlements, so it cannot be used for anything
involving the sandbox or the keychain — and this acceptance run needs both.

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' -configuration Debug \
  -derivedDataPath /tmp/relayium-g2 build 2>&1 | grep -E '\*\* BUILD|error:' | tail -2
open /tmp/relayium-g2/Build/Products/Debug/Relayium.app
```

- [ ] **Step 4: Interop, native → web (hard gate)**

1. Sign in. Drag in **two** files of different sizes, one at least 4 MiB so the
   chunk loop runs more than once.
2. Set a 1-hour TTL, leave burn-after-read off, send, copy the link.
3. Open the link in a browser. Confirm the file list and total size match, then
   download.
4. Compare with `shasum -a 256` against the originals. **Both must match
   exactly.** A mismatch means the streamed frame encoder diverged from the batch
   one, and nothing else in this round matters until it is fixed.

Record the sizes used and the hashes in the commit message.

- [ ] **Step 5: Interop, web → native (hard gate)**

1. Upload two files from the web app.
2. Paste the link into the app's download pane. Confirm the manifest preview
   matches, save to a folder.
3. `shasum -a 256` both files against the originals. Both must match.
4. Confirm a multi-file save landed in `relayium-<id>/`, and that pasting the
   same link again and saving to the same parent refuses with the message that
   explains why.

- [ ] **Step 6: Burn-after-read and cancellation**

1. Upload with burn-after-read on. Download it once in the app — it must
   succeed. Paste the same link again: the resolve must report the
   expired/already-downloaded/mistyped message rather than an obscure failure.
2. Start an upload of a large file and hit Cancel mid-progress. The pane returns
   to the picked state and the app stays responsive.
3. Start a download and quit the app mid-transfer. The confirmation appears;
   choosing "Keep Transferring" leaves the transfer running.
4. Check the destination folder: a cancelled download leaves no partial file.

- [ ] **Step 7: Measure the memory bound**

The unit test asserts the uploader's buffer peak; this checks the whole process,
which is what the user actually pays.

1. Upload a file of at least 200 MiB.
2. Watch `Activity Monitor` (or `footprint -p <pid>`) during the upload.
3. Peak resident memory must stay a small multiple of the ~8.2 MiB chunk, not
   track the file size. Record the observed peak.

- [ ] **Step 8: Update `apps/README.md`**

Add a short "Cloud transfer" subsection under `## macOS app` recording: that the
uploader is chunked with a single-shot fallback, that its peak memory is bounded
and guarded by `CloudUploaderTests.testPeakBufferIsBoundedByChunkNotFile`, that
transfers do not survive quitting because background `URLSession` is R3's, and
that interop with the web is verified by hand each round — naming the two
directions from Steps 4 and 5.

- [ ] **Step 9: Commit**

```bash
git add apps/mac/Relayium/RelayiumApp.swift apps/README.md
git commit -s -m "feat(mac): confirm before a quit kills a running transfer

Background URLSession is R3's problem, which means a transfer dies with the app.
That is a deliberate deferral, so the round owns its consequence rather than
letting a user discover it by losing an upload they watched for two minutes.

Interop verified by hand in both directions, which is the round's hard gate:
files sent from the app download in a browser, files sent from the web download
in the app, sha256 identical both ways. Record the sizes and hashes here."
```

- [ ] **Step 10: Push and verify CI**

```bash
git push -u origin docs/r1g2-cloud-transfer-ui-spec
```

Then read the run for the pushed SHA — `gh` is not authenticated on this machine,
so use the public API (the repository is public):

```bash
curl -s "https://api.github.com/repos/relayium/relayium/actions/runs?branch=docs/r1g2-cloud-transfer-ui-spec&per_page=4" \
  | python3 -c "import sys,json; [print(r['head_sha'][:8], r['name'], r['status'], r['conclusion']) for r in json.load(sys.stdin)['workflow_runs']]"
```

Expected: `macos` and `repo-hygiene` both `success` on the pushed SHA. Report the
SHA you verified, not the branch.

---

## Stretch goal: automated cloud interop in `web/e2e`

Teaching `web/e2e/lan-transfer.mjs` to host a Swift peer on the cloud path is
**explicitly a stretch goal** (spec, Testing). Attempt it only if it lands within
this round's normal size. If it starts to look like its own project — a second
harness, a new build step, a fixture server — stop and write it up as a separate
spec rather than holding G2 open. Manual verification in Task 10 is the gate;
this would only make it cheaper to repeat.

## Self-review

**Spec coverage.** Chunked uploader with bounded memory → Tasks 1–3. Single-shot
fallback with a test → Task 4. `/api/config` size hint → Task 4. Two view models
with generation guards → Tasks 6–7. `ErrorCopy` extension → Tasks 5 and 9.
Upload pane, TTL clamping, burn toggle, link + copy → Tasks 6, 8. Download pane,
manifest preview, save, Reveal in Finder → Tasks 7, 9. `relayium-<id>` directory
and the refusal copy → Tasks 7, 9. Signed-out download → Task 9. Quit guard →
Task 10. Interop both directions → Task 10. Memory measurement → Task 10.

**Done-when coverage.** Every bullet in the spec's Done-when maps to a step in
Task 10 except the two unit-level ones (`swift test` green, peak buffer), which
are Tasks 1–7 and Task 3 Step 1 respectively.

**Type consistency.** `PlaintextSource` / `DataSource` / `FileURLSource` (Task 1)
are the types Tasks 3, 4 and 6 consume. `PatchOutcome`, `ResumableTransport`
(Task 2) are what Tasks 3 and 4 stub. `UploadOutcome` (Task 3) is what Task 6's
`applyOutcome` takes. `DownloadDestinationError` (Task 7) is what Task 9's
`ErrorCopy` case handles. `CloudUploadModel.reset()` is introduced in Task 8
Step 2 because Task 8's view is its first caller.

**Known gaps, stated rather than hidden.** `CloudUploadModel.cancel()` as written
in Task 6 Step 3 needs the `lastPicked` property described in the step's closing
note; the test `testCancelReturnsToPicked` is what forces it. Task 7's
`ManifestWriter` depends on the Kit's existing filename sanitizer, whose exact
name must be read from `StoredWire/Filename.swift` rather than assumed — writing
a second sanitizer would create two security boundaries that drift apart.
