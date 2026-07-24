import XCTest
@testable import RelayiumKit

final class CloudClientTests: XCTestCase {
    private func client() -> CloudClient {
        CloudClient(baseURL: URL(string: "https://relayium.test")!, session: StubURLProtocol.session())
    }
    override func tearDown() { StubURLProtocol.stub = nil; StubURLProtocol.lastRequest = nil; StubURLProtocol.lastBodyBytes = [] }

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
}
