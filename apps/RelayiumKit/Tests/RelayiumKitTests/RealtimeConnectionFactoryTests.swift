import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

final class RealtimeConnectionFactoryTests: XCTestCase {
    /// The hub broadcasts the WHOLE room roster to every member, including the
    /// recipient (signal/hub.go's broadcastRoster). So the moment a sender joins
    /// the code it just minted, it is handed a roster containing itself — and
    /// taking the first entry means dialling its own peer id, which fails in
    /// WebRTC with a bare NSError and no useful copy.
    func testIgnoresItselfInTheRoster() async throws {
        let ch = FakeWebSocketChannel()
        let client = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()

        let waiting = Task { try await RealtimeConnectionFactory.firstPeer(on: client, timeout: 5) }
        await Task.yield()

        // The welcome names us. Then a roster with nobody but us in it.
        ch.fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"}]}"#)
        await Task.yield()
        XCTAssertFalse(waiting.isCancelled)

        // Only once someone else actually joins may it resolve — to them.
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"},{"id":"other-2","name":"Phone"}]}"#)
        let peer = try await waiting.value
        XCTAssertEqual(peer, "other-2", "resolved to the wrong member of the room")
    }

    /// A roster that arrives before the welcome cannot be trusted to exclude us,
    /// because we do not yet know which id is ours.
    func testDoesNotGuessBeforeItKnowsItsOwnID() async throws {
        let ch = FakeWebSocketChannel()
        let client = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()

        let waiting = Task { try await RealtimeConnectionFactory.firstPeer(on: client, timeout: 5) }
        await Task.yield()

        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"}]}"#)
        await Task.yield()
        XCTAssertFalse(waiting.isCancelled)

        ch.fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"},{"id":"other-2","name":"Phone"}]}"#)
        let peer = try await waiting.value
        XCTAssertEqual(peer, "other-2")
    }
}
