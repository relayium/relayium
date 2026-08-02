import XCTest
@testable import RelayiumKit

final class PairClientTests: XCTestCase {
    func testParsesTheMintedCode() throws {
        let m = try parseMintedCode(#"{"code":"483920","expiresAt":1800000000}"#.data(using: .utf8)!)
        XCTAssertEqual(m.code, "483920")
        XCTAssertEqual(m.expiresAt, 1800000000)
    }

    func testMalformedMintIsRejected() {
        XCTAssertThrowsError(try parseMintedCode(#"{"code":"483920"}"#.data(using: .utf8)!))
        XCTAssertThrowsError(try parseMintedCode(Data()))
    }

    /// A signed-out user pressing "Create a code" is answerable locally: the
    /// server would only ever say 401. Asking it anyway costs a round trip, and
    /// offline it fails as `.network` — "check your connection" for something
    /// that is not a connection problem.
    func testMintingWithoutATokenNeverReachesTheNetwork() async {
        StubURLProtocol.stub = .init(status: 200,
                                     body: #"{"code":"483920","expiresAt":1}"#.data(using: .utf8)!)
        StubURLProtocol.lastRequest = nil
        let c = HTTPPairClient(baseURL: URL(string: "https://relayium.com")!,
                               session: StubURLProtocol.session())
        do {
            _ = try await c.mint(token: "")
            XCTFail("minting without a token should not succeed")
        } catch {
            XCTAssertEqual(error as? AccountError, .notSignedIn)
        }
        XCTAssertNil(StubURLProtocol.lastRequest, "a request went out for a token we knew was absent")
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
