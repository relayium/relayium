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
}
