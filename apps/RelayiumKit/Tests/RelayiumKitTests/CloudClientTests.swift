import XCTest
@testable import RelayiumKit

final class CloudClientTests: XCTestCase {
    private func client() -> CloudClient {
        CloudClient(baseURL: URL(string: "https://relayium.test")!, session: StubURLProtocol.session())
    }
    override func tearDown() {
        StubURLProtocol.stub = nil; StubURLProtocol.router = nil
        StubURLProtocol.lastRequest = nil; StubURLProtocol.lastBodyBytes = []
    }

    func testUploadPostsBodyWithBearerAndQuery() async throws {
        let v = try Vectors.load("store-wire-vectors")
        let manifest = StoredManifest(files: v.manifestFiles())
        let files = v.fileDatas()
        let expectedBody = try encodeUploadBody(key: v.hex("keyHex"), manifest: manifest, files: files)
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"id":"abc","expiresAt":1790000000}"#.utf8), check: { req in
            XCTAssertEqual(req.url?.path, "/api/files")
            XCTAssertEqual(req.url?.query, "burnAfterRead=1&ttl=3600")
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_T")
            XCTAssertEqual(StubURLProtocol.bodyBytes(req), expectedBody)
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
        let manifest = try await client().download(id: "abc", key: v.hex("keyHex")) { got += $0 }
        // recovered plaintext == the two files concatenated in order
        XCTAssertEqual(got, v.fileDatas().flatMap { $0 })
        XCTAssertEqual(manifest.files.map(\.name), ["hello.txt", "ab.txt"])
    }
    func testDownloadHandlesMultipleDataChunks() async throws {
        let v = try Vectors.load("store-wire-vectors")
        let encManifestB64 = Data(v.hex("manifest.ctHex")).base64EncodedString()
        let streamBytes = Data(v.hex("streamHex"))
        // Split the blob across several didLoad deliveries (uneven sizes, including a 1-byte
        // chunk) to prove decryption is correct regardless of chunk boundaries.
        var chunks = [Data]()
        var idx = streamBytes.startIndex
        let sizes = [1, 3, 7, Int.max]
        var i = 0
        while idx < streamBytes.endIndex {
            let n = min(sizes[min(i, sizes.count - 1)], streamBytes.distance(from: idx, to: streamBytes.endIndex))
            let end = streamBytes.index(idx, offsetBy: n)
            chunks.append(streamBytes[idx..<end])
            idx = end; i += 1
        }
        XCTAssertGreaterThan(chunks.count, 1)
        StubURLProtocol.router = { req in
            if req.url?.path.hasSuffix("/meta") == true {
                let meta = #"{"encManifest":"\#(encManifestB64)","size":54,"burnAfterRead":false,"expiresAt":1790000000}"#
                return .init(status: 200, body: Data(meta.utf8), check: nil)
            }
            return .init(status: 200, bodyChunks: chunks, check: nil)
        }
        var got = [UInt8]()
        let manifest = try await client().download(id: "abc", key: v.hex("keyHex")) { got += $0 }
        XCTAssertEqual(got, v.fileDatas().flatMap { $0 })
        XCTAssertEqual(manifest.files.map(\.name), ["hello.txt", "ab.txt"])
    }

    // MARK: - download limiting and the bounded 403 replay

    /// Requests that reached the transport for the blob, which is the only
    /// counter that can tell a replay from a single attempt. `observed` is
    /// shared static state, so every test below resets it first.
    private func blobRequestCount() -> Int {
        StubURLProtocol.observed.filter { $0.url?.path.hasSuffix("/blob") == true }.count
    }

    /// A meta stub whose manifest the vectors' key decrypts, so a test about the
    /// blob response reaches the blob request at all.
    private func metaStub(_ v: Vectors) -> StubURLProtocol.Stub {
        let encManifestB64 = Data(v.hex("manifest.ctHex")).base64EncodedString()
        let meta = #"{"encManifest":"\#(encManifestB64)","size":54,"burnAfterRead":false,"expiresAt":1790000000}"#
        return .init(status: 200, body: Data(meta.utf8), check: nil)
    }

    /// 429 on the metadata request is the download path's own limit, not "the
    /// server returned an error (429)" — that generic copy invites the immediate
    /// retry a 429 exists to prevent.
    func testMetaTooManyRequestsMapsToDownloadLimited() async {
        // Deliberately opaque: classification is by status, never server prose.
        StubURLProtocol.stub = .init(status: 429, body: Data("edge-copy-may-change".utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().fetchMeta(id: "abc")) {
            XCTAssertEqual($0 as? CloudError, .downloadLimited)
        }
    }

    /// Other statuses on metadata are untouched by that mapping.
    func testMetaKeepsNotFoundAndOtherStatuses() async {
        StubURLProtocol.stub = .init(status: 404, body: Data(), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().fetchMeta(id: "abc")) {
            XCTAssertEqual($0 as? CloudError, .notFound)
        }
        StubURLProtocol.stub = .init(status: 503, body: Data(), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().fetchMeta(id: "abc")) {
            XCTAssertEqual($0 as? CloudError, .server(status: 503))
        }
    }

    /// The blob's two 429 gates — the per-IP download-start limiter and the
    /// sender account's monthly traffic gate — reach the user as one dedicated
    /// outcome, and neither may be replayed: a hidden second request against a
    /// limiter is the one thing that makes a limit worse.
    func testBlobTooManyRequestsMapsToDownloadLimitedWithoutReplay() async throws {
        let v = try Vectors.load("store-wire-vectors")
        StubURLProtocol.reset()
        StubURLProtocol.router = { [self] req in
            if req.url?.path.hasSuffix("/meta") == true { return metaStub(v) }
            // Deliberately opaque: classification is by status, never server prose.
            return .init(status: 429, body: Data("edge-copy-may-change".utf8), check: nil)
        }
        await XCTAssertThrowsErrorAsync(try await self.client().download(id: "abc", key: v.hex("keyHex")) { _ in }) {
            XCTAssertEqual($0 as? CloudError, .downloadLimited)
        }
        XCTAssertEqual(blobRequestCount(), 1, "a 429 must not be replayed")
    }

    /// The 403 replay is exactly one attempt, and it is a real one: a redirect
    /// target that refuses the first request and serves the second finishes the
    /// download.
    func testBlobRetriesOnceAfterAnInitialForbidden() async throws {
        let v = try Vectors.load("store-wire-vectors")
        StubURLProtocol.reset()
        StubURLProtocol.router = { [self] req in
            if req.url?.path.hasSuffix("/meta") == true { return metaStub(v) }
            // `observed` already holds this request, so the first blob call sees 1.
            if blobRequestCount() == 1 { return .init(status: 403, body: Data(), check: nil) }
            return .init(status: 200, body: Data(v.hex("streamHex")), check: nil)
        }
        var got = [UInt8]()
        let manifest = try await client().download(id: "abc", key: v.hex("keyHex")) { got += $0 }
        XCTAssertEqual(got, v.fileDatas().flatMap { $0 })
        XCTAssertEqual(manifest.files.map(\.name), ["hello.txt", "ab.txt"])
        XCTAssertEqual(blobRequestCount(), 2, "exactly one replay")
    }

    /// And it is bounded: a second 403 is the answer, not a third request.
    func testBlobStopsAfterASecondForbidden() async throws {
        let v = try Vectors.load("store-wire-vectors")
        StubURLProtocol.reset()
        StubURLProtocol.router = { [self] req in
            if req.url?.path.hasSuffix("/meta") == true { return metaStub(v) }
            return .init(status: 403, body: Data(), check: nil)
        }
        await XCTAssertThrowsErrorAsync(try await self.client().download(id: "abc", key: v.hex("keyHex")) { _ in }) {
            XCTAssertEqual($0 as? CloudError, .server(status: 403))
        }
        XCTAssertEqual(blobRequestCount(), 2, "one replay, then the refusal stands")
    }

    /// 404 on the blob still means the link is gone, not a limit.
    func testBlobKeepsNotFound() async throws {
        let v = try Vectors.load("store-wire-vectors")
        StubURLProtocol.reset()
        StubURLProtocol.router = { [self] req in
            if req.url?.path.hasSuffix("/meta") == true { return metaStub(v) }
            return .init(status: 404, body: Data(), check: nil)
        }
        await XCTAssertThrowsErrorAsync(try await self.client().download(id: "abc", key: v.hex("keyHex")) { _ in }) {
            XCTAssertEqual($0 as? CloudError, .notFound)
        }
        XCTAssertEqual(blobRequestCount(), 1)
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
}
