import XCTest
@testable import RelayiumKit

/// The server's link-pairing roster hint (relayium-signaling-v1 "Protocol hint").
///
/// The row is `roster.protoHint` in `realtime-wire-vectors.json`, shared with the
/// Go server (which must encode these exact bytes), the Web and Android suites.
/// The Apple clients do not read the hint. What is pinned here is that a welcome
/// echoing `proto` and a roster mixing a hinted and an unhinted entry reach the
/// app exactly as the same frames without the hint would — the decoder's
/// tolerance of the extra key is a tested fact, not an assumption about
/// synthesised `Codable` — and that this client never sends a hint itself.
final class SignalEnvelopeRosterHintTests: XCTestCase {
    private struct Row {
        let welcomeFrame: String
        let peersFrame: String
        let selfId: String
        let ip: String
        let peers: [Peer]
    }

    private func row() throws -> Row {
        let v = try Vectors.load("realtime-wire-vectors")
        let roster = try XCTUnwrap(v.json["roster"] as? [String: Any],
                                   "realtime-wire-vectors.json has no roster block; "
                                   + "run `node scripts/gen-realtime-wire-vectors.mjs` from web/")
        let hint = try XCTUnwrap(roster["protoHint"] as? [String: Any])
        let entries = try XCTUnwrap(hint["peers"] as? [[String: Any]])
        return Row(
            welcomeFrame: try XCTUnwrap(hint["welcomeFrame"] as? String),
            peersFrame: try XCTUnwrap(hint["peersFrame"] as? String),
            selfId: try XCTUnwrap(hint["selfId"] as? String),
            ip: try XCTUnwrap(hint["ip"] as? String),
            peers: try entries.map { Peer(id: try XCTUnwrap($0["id"] as? String),
                                          name: try XCTUnwrap($0["name"] as? String)) })
    }

    func testFixtureRowCarriesTheHint() throws {
        let r = try row()
        XCTAssertTrue(r.welcomeFrame.contains(#""proto":["link/1"]"#))
        XCTAssertEqual(r.peersFrame.components(separatedBy: #""proto":"#).count - 1, 1,
                       "exactly one roster entry is hinted")
        XCTAssertGreaterThan(r.peers.count, 1, "the row must also hold an unhinted entry")
    }

    func testHintedFramesDecodeToTheUnhintedValues() throws {
        let r = try row()
        let welcome = try JSONDecoder().decode(Envelope.self, from: Data(r.welcomeFrame.utf8))
        XCTAssertEqual(welcome.type, SignalType.welcome)
        XCTAssertEqual(welcome.name, r.selfId)
        XCTAssertEqual(welcome.ip, r.ip)
        let roster = try JSONDecoder().decode(Envelope.self, from: Data(r.peersFrame.utf8))
        XCTAssertEqual(roster.peers, r.peers)
    }

    func testSignalingClientDeliversTheHintedFramesUnchanged() throws {
        let r = try row()
        let ch = FakeWebSocketChannel()
        let c = SignalingClient(channel: ch, name: "Mac")
        var selfId = ""; var ip = ""; var peers: [Peer]?
        c.onSelfId = { selfId = $0; ip = $1 }
        c.onPeers = { peers = $0 }
        ch.fireOpen()
        // Inert: this client never announces the hint.
        XCTAssertFalse(try XCTUnwrap(ch.sent.first).contains("proto"))
        ch.fireText(r.welcomeFrame)
        ch.fireText(r.peersFrame)
        XCTAssertEqual(selfId, r.selfId)
        XCTAssertEqual(ip, r.ip)
        XCTAssertEqual(peers, r.peers)
        withExtendedLifetime(c) {}
    }
}
