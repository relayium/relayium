import XCTest
@testable import RelayiumKit

final class ICEClientTests: XCTestCase {
    /// The server's field names, and the optional halves that are absent for
    /// STUN-only entries (`server/account/turn.go:21-25`).
    func testParsesMixedStunAndTurnEntries() throws {
        let json = """
        {"iceServers":[{"urls":["stun:stun.example:3478"]},
                       {"urls":["turn:turn.example:3478"],"username":"u","credential":"c"}]}
        """.data(using: .utf8)!
        let s = try parseICEServers(json)
        XCTAssertEqual(s.count, 2)
        XCTAssertEqual(s[0].urls, ["stun:stun.example:3478"])
        XCTAssertNil(s[0].username)
        XCTAssertEqual(s[1].username, "u")
        XCTAssertEqual(s[1].credential, "c")
    }

    /// `relays` and `relayDenied` may be present; ignoring them must not break
    /// decoding, because this round deliberately does not implement the pool.
    func testIgnoresTheRelayPoolFields() throws {
        let json = """
        {"iceServers":[{"urls":["stun:s:3478"]}],
         "relays":[{"id":"r1","iceServers":[{"urls":["turn:r1:3478"]}]}],
         "relayDenied":"quota"}
        """.data(using: .utf8)!
        XCTAssertEqual(try parseICEServers(json).count, 1)
    }

    /// A response with no servers is a configuration failure, not an empty
    /// success: connecting with no ICE servers fails later and more obscurely.
    func testEmptyServerListIsRejected() {
        XCTAssertThrowsError(try parseICEServers(#"{"iceServers":[]}"#.data(using: .utf8)!))
        XCTAssertThrowsError(try parseICEServers(#"{}"#.data(using: .utf8)!))
    }

    /// 429 is this endpoint's most likely failure — it is rate-limited to 5/min
    /// per IP because guessing a live code steals someone's TURN credentials.
    func testRateLimitIsItsOwnError() {
        XCTAssertEqual(iceStatusError(429), .rateLimited)
        XCTAssertEqual(iceStatusError(503), .server(status: 503))
    }
}
