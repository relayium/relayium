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
