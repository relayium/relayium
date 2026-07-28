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
        let s = try parseICEConfig(json).iceServers
        XCTAssertEqual(s.count, 2)
        XCTAssertEqual(s[0].urls, ["stun:stun.example:3478"])
        XCTAssertNil(s[0].username)
        XCTAssertEqual(s[1].username, "u")
        XCTAssertEqual(s[1].credential, "c")
    }

    /// `relayDenied` may be present; an unrecognized field must not break
    /// decoding.
    func testIgnoresUnknownFields() throws {
        let json = """
        {"iceServers":[{"urls":["stun:s:3478"]}],
         "relays":[{"id":"r1","iceServers":[{"urls":["turn:r1:3478"]}]}],
         "relayDenied":"quota"}
        """.data(using: .utf8)!
        let cfg = try parseICEConfig(json)
        XCTAssertEqual(cfg.iceServers.count, 1)
        XCTAssertEqual(cfg.relays.count, 1)
    }

    /// A response with no servers is a configuration failure, not an empty
    /// success: connecting with no ICE servers fails later and more obscurely.
    func testEmptyServerListIsRejected() {
        XCTAssertThrowsError(try parseICEConfig(#"{"iceServers":[]}"#.data(using: .utf8)!))
        XCTAssertThrowsError(try parseICEConfig(#"{}"#.data(using: .utf8)!))
    }

    /// 429 is this endpoint's most likely failure — it is rate-limited to 5/min
    /// per IP because guessing a live code steals someone's TURN credentials.
    func testRateLimitIsItsOwnError() {
        XCTAssertEqual(iceStatusError(429), .rateLimited)
        XCTAssertEqual(iceStatusError(503), .server(status: 503))
    }
}

extension ICEClientTests {
    func testDecodesTheRelayPool() throws {
        let json = """
        {"iceServers":[{"urls":["stun:relayium.com:3478"]}],
         "relays":[
           {"id":"n1","iceServers":[{"urls":["turn:1.1.1.1:3478"],"username":"u","credential":"c"}]},
           {"id":"n3","region":"cn","iceServers":[{"urls":["turn:2.2.2.2:3478"],"username":"u","credential":"c"}]}
         ]}
        """.data(using: .utf8)!
        let cfg = try parseICEConfig(json)
        XCTAssertEqual(cfg.iceServers.count, 1)
        XCTAssertEqual(cfg.relays.map(\.id), ["n1", "n3"])
        XCTAssertEqual(cfg.relays[1].region, "cn")
        XCTAssertEqual(cfg.relays[0].iceServers[0].urls, ["turn:1.1.1.1:3478"])
    }

    /// A response with no pool is the LAN case and is completely normal.
    func testAbsentPoolIsAnEmptyPoolNotAFailure() throws {
        let json = #"{"iceServers":[{"urls":["stun:relayium.com:3478"]}]}"#.data(using: .utf8)!
        let cfg = try parseICEConfig(json)
        XCTAssertTrue(cfg.relays.isEmpty)
        XCTAssertEqual(cfg.iceServers.count, 1)
    }

    /// Unchanged from before: no iceServers at all is a configuration failure,
    /// because a peer connection with none fails later and far more obscurely.
    func testEmptyIceServersStillThrows() {
        XCTAssertThrowsError(try parseICEConfig(#"{"iceServers":[]}"#.data(using: .utf8)!))
    }
}
