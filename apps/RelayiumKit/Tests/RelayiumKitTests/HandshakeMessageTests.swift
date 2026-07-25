import XCTest
@testable import RelayiumKit
final class HandshakeMessageTests: XCTestCase {
    func testCommitFieldAndParse() {
        let j = commitField("Q29tbWl0")
        XCTAssertEqual(peerCommit(from: j), "Q29tbWl0")
        XCTAssertNil(peerReveal(from: j))
    }
    func testRevealFieldAndParse() {
        let r = Reveal(key: "S2V5", nonce: "Tm9uY2U")
        let j = revealField(r)
        XCTAssertEqual(peerReveal(from: j), r)
        XCTAssertNil(peerCommit(from: j))
    }
    func testParseIgnoresUnrelated() {
        let sdpOnly = JSONValue.object(["sdp": .string("v=0")])
        XCTAssertNil(peerCommit(from: sdpOnly))
        XCTAssertNil(peerReveal(from: sdpOnly))
    }
    func testParseMalformedReveal() {
        let bad = JSONValue.object(["reveal": .object(["key": .string("k")])])  // no nonce
        XCTAssertNil(peerReveal(from: bad))
    }
}
