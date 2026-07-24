# Native macOS R1-D: Cloud module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `Cloud` module to `RelayiumKit` — upload a stored transfer (`POST /api/files`, bearer-authed) and download one (`GET /api/files/{id}/meta` + `/blob`, following the direct-download 302), reusing the R1-B `StoredWire` codec and R1-C bearer token. This is the **first working native transfer**: a native client can produce a `#k=` link that web/CLI can open, and open a `#k=` link web/CLI produced.

**Architecture:** `Cloud` is an async `URLSession` client with no new crypto — it assembles the upload body from `StoredWire` (`encryptManifest` + `encryptChunks`) and decodes downloads through `StoreDecryptor`. Upload authenticates with the R1-C bearer token; download is unauthenticated (zero-knowledge: the `#k=` fragment key is all a recipient needs, the server sees only ciphertext). Interop is pinned by reusing the R1-B `store-wire-vectors.json` fixture end-to-end: the assembled upload body must equal `header || manifest.ctHex || streamHex`, and a download fed that same manifest+stream must recover the original file bytes. Foreground `URLSession` only (background sessions are an iOS-round concern; noted deferred).

**Tech Stack:** Swift 5.9+, `URLSession` (async/await, `bytes(for:)` streamed download), XCTest with the R1-C `StubURLProtocol`. Reuses `StoredWire` + `Account` error/stub patterns. No new dependencies. No server change (verified: upload routes are already `RequireAuth`; download routes are public).

## This plan's place in R1

Cloud-first R1 sequence: R1-A `Crypto` ✓ → R1-B `StoredWire` ✓ → R1-C `Account` ✓ → **R1-D `Cloud` (this plan)** → R1-E `Signaling` → R1-F `Realtime` → R1-G UI+distribution. After R1-D, a native user can upload/download `#k=` stored transfers interoperably with web/CLI. R1-G wires this to the macOS UI (drag-drop to upload, open-link to download).

## Grounding (verified against the server + web client)

Routes (`server/internal/account/files.go`):
- `POST /api/files` — `RequireAuth` (bearer works). Query `?burnAfterRead=0|1&ttl=<secs>`. Body = `uint32BE(len(encManifest)) || encManifest || <StoredWire frame stream>`. Response `{id, expiresAt}`. (413 quota / 429 rate / 401 unauth possible.)
- `GET /api/files/{id}/meta` — public. Response `{encManifest: <base64 STANDARD>, size, burnAfterRead, expiresAt}`.
- `GET /api/files/{id}/blob` — public. Body = the StoredWire **frame stream only** (the server split off the manifest at upload). May `302` to a storage node with a one-shot token; a replayed request can come back `403` from the node — re-request `/blob` once to mint a fresh token (bounded to one extra attempt).
- `POST /api/uploads…` (resumable, 3-phase) exists but is **out of scope** for R1-D (see "Deferred").

Web reference: `web/src/lib/stored-file.ts` — `uploadFile` (body assembly, lines 62-96), `fetchMeta`/`StoredFileMeta` (25-30, 374-378), `downloadBlob` (400-449, incl. the 403-retry and `end(expected)` truncation check), `buildDownloadLink`/`parseDownloadKey` (452-460). The manifest for the truncation check comes from `meta.encManifest` (base64 → `decryptManifest` → summed file sizes).

## Global Constraints

- **Reuse StoredWire + Crypto; no new crypto.** Upload body uses `encryptManifest` (seq 0) + `encryptChunks` (seq 1…) from R1-B. Download uses `StoreDecryptor` + `decryptManifest`. The `#k=` key uses `encodeStoreKey`/`decodeStoreKey`.
- **Upload body layout (byte-exact):** `uint32BE(encManifest.count) || encManifest || frameStream`. Big-endian 4-byte length prefix. Pinned by `store-wire-vectors.json` (`header || manifest.ctHex || streamHex`).
- **`meta.encManifest` is base64 STANDARD** (not base64url) — decode with standard base64.
- **Truncation defense is mandatory:** download MUST compute `expectedBytes` from the manifest's summed file sizes and pass it to `StoreDecryptor.end(expectedBytes:)`. A stream truncated on a frame boundary must fail, never report success.
- **Download 302 → one 403 retry:** follow redirects (URLSession default); if `/blob` returns 403 on the first attempt, re-request once; a second 403 is a real failure.
- **Bearer only on upload.** `POST /api/files` sends `Authorization: Bearer <token>`. Download sends no auth.
- **No secrets in logs**; the `#k=` key never goes in a URL path or query (fragment only, and native builds the link string locally).
- **Min platforms / cadence:** macOS 13, Swift 5.9; commit after every green test cycle; English commit messages.

---

## File structure (R1-D)

- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudModels.swift` — `UploadResult`, `StoredFileMeta`, `CloudError`, link helpers.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/UploadBody.swift` — `encodeUploadBody(...)` (pure assembly).
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift` — `upload` + `download` over URLSession.
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudModelsTests.swift`, `UploadBodyTests.swift`, `CloudClientTests.swift`
- Create: `docs/protocol/relayium-cloud-transport-v1.md` — freeze the HTTP transport (endpoints, body layout, meta/blob split, 302/403 retry).
- Reuse: `apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json` (from R1-B) + `Tests/RelayiumKitTests/Support/StubURLProtocol.swift` (from R1-C).

---

## Task 1: Freeze the cloud HTTP transport doc

**Files:**
- Create: `docs/protocol/relayium-cloud-transport-v1.md`

**Interfaces:**
- Produces: the authoritative HTTP-transport description Tasks 2–5 implement against.

- [ ] **Step 1: Write the transport spec**

Create `docs/protocol/relayium-cloud-transport-v1.md`, taken verbatim from `server/internal/account/files.go` + `web/src/lib/stored-file.ts`:

```markdown
# Relayium stored-transfer HTTP transport v1 (authoritative)

Layers on top of the stored-wire codec (relayium-stored-wire-v1.md). The wire
bytes (encrypted manifest, framed ciphertext) are defined there; this doc defines
how they move over HTTP.

## Upload (authenticated)
- `POST /api/files?burnAfterRead=<0|1>&ttl=<seconds>`
- Auth: `Authorization: Bearer <rlm_cli_ token>` (RequireAuth).
- Body: `uint32BE(len(encManifest)) || encManifest || frameStream`
  - `encManifest` = encryptManifest(key, manifest) (AES-GCM seq 0).
  - `frameStream` = concatenated length-prefixed frames (seq 1,2,…).
- Response 200: `{ "id": <string>, "expiresAt": <unix seconds> }`.
- Errors: 401 unauth, 413 over quota / too large, 429 rate-limited, 503 storage down.
- The share link is `<origin>/d/<id>#k=<base64url key>` — key ONLY in the fragment.

## Download (unauthenticated, zero-knowledge)
- `GET /api/files/<id>/meta` → `{ "encManifest": <base64 standard>, "size": <int>,
  "burnAfterRead": <bool>, "expiresAt": <unix> }`. No auth.
- `GET /api/files/<id>/blob` → body is the frameStream ONLY (server split the
  manifest off at upload; it is served base64 in /meta, not in the blob). No auth.
  - May 302 to a storage node with a one-shot token (follow redirects).
  - A replayed request can return 403 from the node; re-request /blob ONCE to mint
    a fresh token. A second 403 is a real failure.
- Recipient flow: fetch /meta → decryptManifest(key, base64decode(encManifest)) →
  expectedBytes = Σ file sizes; then stream /blob through StoreDecryptor, and call
  end(expectedBytes) — a truncated stream MUST fail, not report success.

## burn-after-read / ttl
- burnAfterRead: the transfer is destroyed after the first successful blob read.
- ttl: seconds until expiry (server clamps to the uploader's plan retention).
```

- [ ] **Step 2: Commit**

```bash
git add docs/protocol/relayium-cloud-transport-v1.md
git commit -m "docs(protocol): freeze relayium stored-transfer HTTP transport v1"
```

---

## Task 2: Cloud models + link helpers

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudModels.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudModelsTests.swift`

**Interfaces:**
- Produces:
  - `struct UploadResult: Codable, Equatable { let id: String; let expiresAt: Int64 }`
  - `struct StoredFileMeta: Codable, Equatable { let encManifest: String; let size: Int64; let burnAfterRead: Bool; let expiresAt: Int64 }`
  - `enum CloudError: Error, Equatable { case unauthorized, quota, rateLimited, notFound, server(status: Int), network, decoding }`
  - `func buildDownloadLink(origin: String, id: String, keyB64url: String) -> String`
  - `func parseDownloadFragment(_ hash: String) -> String?` — extracts the key from a `#k=…` fragment (nil if it doesn't match `^#?k=[A-Za-z0-9_-]+$`)

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/CloudModelsTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class CloudModelsTests: XCTestCase {
    func testDecodeUploadResult() throws {
        let r = try JSONDecoder().decode(UploadResult.self, from: Data(#"{"id":"abc","expiresAt":1790000000}"#.utf8))
        XCTAssertEqual(r.id, "abc"); XCTAssertEqual(r.expiresAt, 1_790_000_000)
    }
    func testDecodeMeta() throws {
        let m = try JSONDecoder().decode(StoredFileMeta.self, from:
            Data(#"{"encManifest":"AAAA","size":34,"burnAfterRead":true,"expiresAt":1790000000}"#.utf8))
        XCTAssertEqual(m.encManifest, "AAAA"); XCTAssertEqual(m.size, 34); XCTAssertTrue(m.burnAfterRead)
    }
    func testBuildAndParseLink() {
        let link = buildDownloadLink(origin: "https://relayium.com", id: "abc", keyB64url: "K3y_-")
        XCTAssertEqual(link, "https://relayium.com/d/abc#k=K3y_-")
        XCTAssertEqual(parseDownloadFragment("#k=K3y_-"), "K3y_-")
        XCTAssertEqual(parseDownloadFragment("k=K3y_-"), "K3y_-")   // no leading '#'
        XCTAssertNil(parseDownloadFragment("#x=nope"))
        XCTAssertNil(parseDownloadFragment("#k=has space"))
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter CloudModelsTests`
Expected: FAIL — symbols undefined.

- [ ] **Step 3: Implement the models**

Create `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudModels.swift`:

```swift
import Foundation

public struct UploadResult: Codable, Equatable {
    public let id: String
    public let expiresAt: Int64
}

public struct StoredFileMeta: Codable, Equatable {
    public let encManifest: String       // base64 STANDARD
    public let size: Int64
    public let burnAfterRead: Bool
    public let expiresAt: Int64
}

public enum CloudError: Error, Equatable {
    case unauthorized          // 401
    case quota                 // 413
    case rateLimited           // 429
    case notFound              // 404
    case server(status: Int)   // other non-2xx
    case network               // transport failure
    case decoding              // unparseable body
}

/// The shareable link; the key lives ONLY in the fragment. `/d/<id>` is the
/// recipient route the server AASA also hands off to the native app (Universal Links).
public func buildDownloadLink(origin: String, id: String, keyB64url: String) -> String {
    "\(origin)/d/\(id)#k=\(keyB64url)"
}

/// Extract the base64url key from a `#k=…` (or `k=…`) fragment; nil if malformed.
public func parseDownloadFragment(_ hash: String) -> String? {
    let s = hash.hasPrefix("#") ? String(hash.dropFirst()) : hash
    guard s.hasPrefix("k=") else { return nil }
    let key = String(s.dropFirst(2))
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    guard !key.isEmpty, key.allSatisfy({ allowed.contains($0) }) else { return nil }
    return key
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter CloudModelsTests` → PASS. Full `swift test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudModels.swift apps/RelayiumKit/Tests/RelayiumKitTests/CloudModelsTests.swift
git commit -m "feat(native): Cloud models (UploadResult/StoredFileMeta/CloudError) + link helpers"
```

---

## Task 3: Upload body assembly (interop-pinned)

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/UploadBody.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/UploadBodyTests.swift`

**Interfaces:**
- Consumes: `encryptManifest`, `encryptChunks` (R1-B), `store-wire-vectors.json`.
- Produces:
  - `func encodeUploadBody(key: [UInt8], manifest: StoredManifest, files: [[UInt8]]) -> [UInt8]` — assembles `uint32BE(len(encManifest)) || encManifest || frameStream`.

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/UploadBodyTests.swift`. The assembled body must equal `header || manifest.ctHex || streamHex` from the R1-B fixture (deterministic with that key + files):

```swift
import XCTest
@testable import RelayiumKit

final class UploadBodyTests: XCTestCase {
    func testUploadBodyMatchesStoredWireVectors() throws {
        let v = try Vectors.load("store-wire-vectors")
        let manifest = StoredManifest(files: v.manifestFiles())    // helper from R1-B (name,size)
        let files = v.fileDatas()                                  // [[UInt8]] from files[].dataHex
        let body = encodeUploadBody(key: v.hex("keyHex"), manifest: manifest, files: files)

        let encManifest = v.hex("manifest.ctHex")
        let stream = v.hex("streamHex")
        var expected = [UInt8]()
        let n = UInt32(encManifest.count)
        expected += [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
        expected += encManifest
        expected += stream
        XCTAssertEqual(body, expected)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter UploadBodyTests`
Expected: FAIL — `encodeUploadBody` undefined.

- [ ] **Step 3: Implement the assembly**

Create `apps/RelayiumKit/Sources/RelayiumKit/Cloud/UploadBody.swift`:

```swift
import Foundation

/// Assemble the `POST /api/files` body: uint32BE(len(encManifest)) || encManifest
/// || frameStream. Mirrors web/src/lib/stored-file.ts uploadFile's part assembly.
public func encodeUploadBody(key: [UInt8], manifest: StoredManifest, files: [[UInt8]]) -> [UInt8] {
    let encManifest = encryptManifest(key: key, manifest)   // seq 0
    let frameStream = encryptChunks(key: key, files: files) // seq 1,2,…
    let n = encManifest.count
    var out = [UInt8]()
    out.reserveCapacity(4 + encManifest.count + frameStream.count)
    out += [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
    out += encManifest
    out += frameStream
    return out
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter UploadBodyTests` → PASS (proves the native upload body is byte-identical to what the web produces for the same key+files — the upload interop guarantee). Full `swift test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Cloud/UploadBody.swift apps/RelayiumKit/Tests/RelayiumKitTests/UploadBodyTests.swift
git commit -m "feat(native): Cloud upload body assembly, byte-pinned to stored-wire vectors"
```

---

## Task 4: `CloudClient.upload`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudClientTests.swift`

**Interfaces:**
- Consumes: models (Task 2), `encodeUploadBody` (Task 3), `StubURLProtocol` (R1-C).
- Produces:
  - `struct CloudClient { init(baseURL: URL, session: URLSession = .shared) }`
  - `func upload(key: [UInt8], manifest: StoredManifest, files: [[UInt8]], burnAfterRead: Bool, ttl: Int, token: String) async throws -> UploadResult`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/CloudClientTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class CloudClientTests: XCTestCase {
    private func client() -> CloudClient {
        CloudClient(baseURL: URL(string: "https://relayium.test")!, session: StubURLProtocol.session())
    }
    override func tearDown() { StubURLProtocol.stub = nil; StubURLProtocol.lastRequest = nil }

    func testUploadPostsBodyWithBearerAndQuery() async throws {
        let v = try Vectors.load("store-wire-vectors")
        let manifest = StoredManifest(files: v.manifestFiles())
        let files = v.fileDatas()
        let expectedBody = encodeUploadBody(key: v.hex("keyHex"), manifest: manifest, files: files)
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"id":"abc","expiresAt":1790000000}"#.utf8), check: { req in
            XCTAssertEqual(req.url?.path, "/api/files")
            XCTAssertEqual(req.url?.query, "burnAfterRead=1&ttl=3600")
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_T")
            XCTAssertEqual(StubURLProtocol.bodyBytes(req), expectedBody)   // see stub note below
        })
        let r = try await client().upload(key: v.hex("keyHex"), manifest: manifest, files: files,
                                          burnAfterRead: true, ttl: 3600, token: "rlm_cli_T")
        XCTAssertEqual(r, UploadResult(id: "abc", expiresAt: 1_790_000_000))
    }
    func testUploadQuotaMapsTo413() async {
        StubURLProtocol.stub = .init(status: 413, body: Data("too big".utf8), check: nil)
        let v = try! Vectors.load("store-wire-vectors")
        await XCTAssertThrowsErrorAsync(try await self.client().upload(
            key: v.hex("keyHex"), manifest: StoredManifest(files: v.manifestFiles()), files: v.fileDatas(),
            burnAfterRead: false, ttl: 3600, token: "t")) {
            XCTAssertEqual($0 as? CloudError, .quota)
        }
    }
}
```

> **Stub note:** `URLProtocol` does not expose `httpBody` for a body set via `URLRequest.httpBody` when the request is uploaded — it may arrive as an `httpBodyStream`. Add a helper to `StubURLProtocol` (Support file) that captures the body in `startLoading()` by reading `request.httpBody ?? request.httpBodyStream`-drained bytes into `static var lastBodyBytes`, and expose `static func bodyBytes(_:) -> [UInt8]`. Implement this in Task 4 Step 1b before the test can pass. (Keep it minimal; it's test-support.)

- [ ] **Step 1b: Extend StubURLProtocol to capture the request body**

In `apps/RelayiumKit/Tests/RelayiumKitTests/Support/StubURLProtocol.swift`, add body capture in `startLoading()`:

```swift
    nonisolated(unsafe) static var lastBodyBytes: [UInt8] = []
    static func bodyBytes(_ req: URLRequest) -> [UInt8] { lastBodyBytes }
```
and at the top of `startLoading()`:
```swift
        if let b = request.httpBody { Self.lastBodyBytes = [UInt8](b) }
        else if let s = request.httpBodyStream {
            s.open(); defer { s.close() }
            var buf = [UInt8](repeating: 0, count: 64 * 1024); var out = [UInt8]()
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; out += buf[0..<n] }
            Self.lastBodyBytes = out
        } else { Self.lastBodyBytes = [] }
```
Reset it in the tests' `tearDown` (`StubURLProtocol.lastBodyBytes = []`).

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter CloudClientTests/testUploadPostsBodyWithBearerAndQuery`
Expected: FAIL — `CloudClient` undefined.

- [ ] **Step 3: Implement upload**

Create `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift`:

```swift
import Foundation

public struct CloudClient {
    let baseURL: URL
    let session: URLSession
    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL; self.session = session
    }

    public func upload(key: [UInt8], manifest: StoredManifest, files: [[UInt8]],
                       burnAfterRead: Bool, ttl: Int, token: String) async throws -> UploadResult {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/files"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "burnAfterRead", value: burnAfterRead ? "1" : "0"),
                            .init(name: "ttl", value: String(ttl))]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(encodeUploadBody(key: key, manifest: manifest, files: files))

        let (data, http) = try await send(req)
        switch http.statusCode {
        case 200:
            guard let r = try? JSONDecoder().decode(UploadResult.self, from: data) else { throw CloudError.decoding }
            return r
        case 401: throw CloudError.unauthorized
        case 413: throw CloudError.quota
        case 429: throw CloudError.rateLimited
        default:  throw CloudError.server(status: http.statusCode)
        }
    }

    func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw CloudError.network }
            return (data, http)
        } catch let e as CloudError { throw e }
        catch { throw CloudError.network }
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter CloudClientTests` → PASS. Full `swift test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift apps/RelayiumKit/Tests/RelayiumKitTests/CloudClientTests.swift apps/RelayiumKit/Tests/RelayiumKitTests/Support/StubURLProtocol.swift
git commit -m "feat(native): CloudClient.upload (POST /api/files, bearer, body-verified)"
```

---

## Task 5: `CloudClient.download` (meta + blob + StoreDecryptor + retry)

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift`
- Modify: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudClientTests.swift`

**Interfaces:**
- Consumes: `StoreDecryptor`, `decryptManifest` (R1-B); `StoredFileMeta` (Task 2).
- Produces:
  - `func fetchMeta(id: String) async throws -> StoredFileMeta`
  - `func download(id: String, key: [UInt8], onChunk: ([UInt8]) throws -> Void) async throws` — fetch meta → expectedBytes → stream blob → decrypt → `end(expectedBytes)`; follows 302 (URLSession default) and retries once on a first-attempt 403.

- [ ] **Step 1: Write the failing test**

Add to `CloudClientTests.swift`. This is the **round-trip interop proof**: feed a web-produced transfer (manifest + frame stream from `store-wire-vectors.json`) and recover the original file bytes.

```swift
    func testDownloadRoundTripsWebProducedTransfer() async throws {
        let v = try Vectors.load("store-wire-vectors")
        let encManifestB64 = Data(v.hex("manifest.ctHex")).base64EncodedString()   // base64 STANDARD
        // 1st stub: /meta. 2nd stub: /blob. Use a path-routing stub.
        StubURLProtocol.router = { req in
            if req.url?.path.hasSuffix("/meta") == true {
                let meta = #"{"encManifest":"\#(encManifestB64)","size":54,"burnAfterRead":false,"expiresAt":1790000000}"#
                return .init(status: 200, body: Data(meta.utf8), check: nil)
            }
            return .init(status: 200, body: Data(v.hex("streamHex")), check: nil)   // /blob = frame stream
        }
        var got = [UInt8]()
        try await client().download(id: "abc", key: v.hex("keyHex")) { got += $0 }
        // recovered plaintext == the two files concatenated in order
        XCTAssertEqual(got, v.fileDatas().flatMap { $0 })
    }
    func testDownloadTruncatedStreamThrows() async throws {
        let v = try Vectors.load("store-wire-vectors")
        let encManifestB64 = Data(v.hex("manifest.ctHex")).base64EncodedString()
        StubURLProtocol.router = { req in
            if req.url?.path.hasSuffix("/meta") == true {
                return .init(status: 200, body: Data(#"{"encManifest":"\#(encManifestB64)","size":54,"burnAfterRead":false,"expiresAt":1}"#.utf8), check: nil)
            }
            return .init(status: 200, body: Data(v.hex("streamHex").dropLast(5)), check: nil)  // truncated
        }
        await XCTAssertThrowsErrorAsync(try await self.client().download(id: "abc", key: v.hex("keyHex")) { _ in }) { _ in }
    }
```

> **Stub note:** add a `router: ((URLRequest) -> Stub)?` to `StubURLProtocol` (checked before the single `stub`) so a test can return different responses per path (needed because download hits two endpoints). Reset it in `tearDown`.

- [ ] **Step 1b: Add path routing to StubURLProtocol**

In `StubURLProtocol.swift`: add `nonisolated(unsafe) static var router: ((URLRequest) -> Stub)?` and in `startLoading()` resolve `let s = Self.router?(request) ?? Self.stub ?? Stub(status: 500, …)`. Reset `router = nil` in tests' `tearDown`.

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter CloudClientTests/testDownloadRoundTripsWebProducedTransfer`
Expected: FAIL — `download`/`fetchMeta` undefined.

- [ ] **Step 3: Implement download**

Append to `CloudClient.swift`:

```swift
extension CloudClient {
    public func fetchMeta(id: String) async throws -> StoredFileMeta {
        let req = URLRequest(url: baseURL.appendingPathComponent("api/files/\(id)/meta"))
        let (data, http) = try await send(req)
        switch http.statusCode {
        case 200:
            guard let m = try? JSONDecoder().decode(StoredFileMeta.self, from: data) else { throw CloudError.decoding }
            return m
        case 404: throw CloudError.notFound
        default:  throw CloudError.server(status: http.statusCode)
        }
    }

    public func download(id: String, key: [UInt8], onChunk: ([UInt8]) throws -> Void) async throws {
        // 1) manifest → expected plaintext total (truncation defense).
        let meta = try await fetchMeta(id: id)
        guard let encManifest = Data(base64Encoded: meta.encManifest) else { throw CloudError.decoding }
        let manifest = try decryptManifest(key: key, [UInt8](encManifest))
        let expected = manifest.files.reduce(0) { $0 + Int($1.size) }

        // 2) stream the blob (follow 302; retry once on a first-attempt 403).
        let blobURL = baseURL.appendingPathComponent("api/files/\(id)/blob")
        var bytes: URLSession.AsyncBytes
        var attempt = 0
        while true {
            let (s, resp) = try await streamed(URLRequest(url: blobURL))
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 403 && attempt == 0 { attempt += 1; continue }
            if code == 404 { throw CloudError.notFound }
            guard code == 200 else { throw CloudError.server(status: code) }
            bytes = s; break
        }

        // 3) decrypt frame-by-frame; end() enforces the expected total.
        let dec = StoreDecryptor(key: key)
        var buf = [UInt8](); buf.reserveCapacity(64 * 1024)
        for try await b in bytes {
            buf.append(b)
            if buf.count >= 64 * 1024 { for pt in try dec.push(buf) { try onChunk(pt) }; buf.removeAll(keepingCapacity: true) }
        }
        if !buf.isEmpty { for pt in try dec.push(buf) { try onChunk(pt) } }
        try dec.end(expectedBytes: expected)
    }

    private func streamed(_ req: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        do { return try await session.bytes(for: req) }
        catch { throw CloudError.network }
    }
}
```

> Note: `session.bytes` yields one `UInt8` at a time; the 64 KiB buffering above just batches pushes to `StoreDecryptor` (which is boundary-independent — proven in R1-B — so batching is purely an efficiency choice, not a correctness one). The stub delivers the whole body, which drains through this loop identically.

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter CloudClientTests` → PASS (round-trip proves native downloads a web-produced transfer byte-for-byte; truncation throws). Full `swift test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift apps/RelayiumKit/Tests/RelayiumKitTests/CloudClientTests.swift apps/RelayiumKit/Tests/RelayiumKitTests/Support/StubURLProtocol.swift
git commit -m "feat(native): CloudClient.download (meta+blob, StoreDecryptor, 302/403 retry, truncation-checked)"
```

---

## Self-review (against the spec)

- **Spec coverage:** transport doc → Task 1; models + link helpers → Task 2; interop-pinned upload body (`header||encManifest||frames`) → Task 3; `upload` (POST /api/files, bearer, query, status mapping) → Task 4; `download` (meta→expected, blob stream, StoreDecryptor, 302-follow + one 403-retry, `end(expected)` truncation defense) → Task 5. Reuse of StoredWire + StubURLProtocol throughout.
- **Interop proof:** Task 3 pins the upload body to the R1-B `store-wire-vectors.json` (`header||manifest.ctHex||streamHex`); Task 5 round-trips a web-produced transfer (same fixture, delivered over stubbed meta+blob) back to the original file bytes. Together these prove native↔web `#k=` interop in both directions without a live server.
- **Placeholder scan:** none — every code step has complete code. The two `StubURLProtocol` extensions (body capture, path router) are specified inline as test-support in Tasks 4/5.
- **Type consistency:** `UploadResult`, `StoredFileMeta`, `CloudError` defined once (Task 2), reused (Tasks 4–5). `encodeUploadBody` (Task 3) reused by `upload` (Task 4). `CloudClient` (Task 4) extended in Task 5. Reuses `StoredManifest`/`encryptManifest`/`encryptChunks`/`StoreDecryptor`/`decryptManifest` from R1-B and `Vectors.manifestFiles()`/`fileDatas()`/`hex()` helpers with the same signatures.

## Deferred (not in R1-D)

- **Resumable upload** (`POST /api/uploads` 3-phase init/PATCH/finalize) + its memory-bounded streaming — a follow-up; the single-shot `POST /api/files` is the R1-D deliverable (matches the web's `uploadFile` fallback path and is sufficient for a working transfer).
- **Background `URLSession`** (survives app suspension) — an iOS-round (R3) concern; macOS transfers run fine in the foreground. R1-D uses foreground async `URLSession`.
- **Upload/download progress callbacks** — the interfaces can grow an `onProgress` later; R1-D proves correctness first.

## Next

R1-E (`Signaling`): the WS client for the `/signal` hub (code rooms, pairing, commit/reveal handshake, ICE/SDP envelopes) — the first piece of the realtime path, which R1-F's `Realtime` (native WebRTC) builds on.
