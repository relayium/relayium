import XCTest
@testable import RelayiumKit

final class PairClientTests: XCTestCase {
    func testParsesTheMintedCode() throws {
        let m = try parseMintedCode(#"{"code":"K7M3X9","expiresAt":1800000000}"#.data(using: .utf8)!)
        XCTAssertEqual(m.code, "K7M3X9")
        XCTAssertEqual(m.expiresAt, 1800000000)
    }

    func testMalformedMintIsRejected() {
        XCTAssertThrowsError(try parseMintedCode(#"{"code":"K7M3X9"}"#.data(using: .utf8)!))
        XCTAssertThrowsError(try parseMintedCode(Data()))
    }

    /// 401 here means "not signed in", which is not what invalidCredentials
    /// says. Reusing that case would put "that email and password don't match
    /// an account" in front of someone who never typed either.
    func testNotSignedInIsItsOwnCase() {
        XCTAssertEqual(pairStatusError(401), .notSignedIn)
        XCTAssertEqual(pairStatusError(429), .rateLimited)
        // 503 is the handler's "could not mint, try again" — transient.
        XCTAssertEqual(pairStatusError(503), .server(status: 503))
    }
}
