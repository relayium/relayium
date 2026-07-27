import XCTest
@testable import RelayiumKit

final class ResumableTransportTests: XCTestCase {
    /// 409 is not an error: the server is ahead of us, and its offset is the
    /// one to believe. Treating it as a failure would abandon a live upload.
    func testPatchOutcomeDistinguishesServerAhead() {
        XCTAssertNotEqual(PatchOutcome.committed(received: 10), .serverAhead(received: 10))
        XCTAssertEqual(PatchOutcome.committed(received: 10), .committed(received: 10))
    }

    /// The header the server parses. A wrong end offset silently corrupts the
    /// blob, so it is pinned by a test rather than trusted to review.
    func testContentRangeHeaderIsInclusiveOfEnd() {
        XCTAssertEqual(contentRangeHeader(from: 0, to: 100, total: 500), "bytes 0-99/500")
        XCTAssertEqual(contentRangeHeader(from: 100, to: 150, total: 500), "bytes 100-149/500")
    }
}
