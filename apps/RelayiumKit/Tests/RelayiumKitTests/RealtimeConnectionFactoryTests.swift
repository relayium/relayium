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

    /// The timeout has to actually surface. It used to be a `Task.sleep` child
    /// racing a `withCheckedThrowingContinuation` child inside a
    /// `withThrowingTaskGroup`: the sleeper threw, the group cancelled the
    /// other child and then awaited it anyway, and cancellation cannot resume a
    /// raw continuation — so `firstPeer` hung until `signaling.onClose`
    /// happened to fire, which for a peer that simply never joins is never.
    ///
    /// Driven through an expectation rather than a bare `await`: against the
    /// old code this call does not return at all, and a test that awaited it
    /// directly would hang the whole suite instead of failing it.
    func testTheTimeoutSurfacesAsNoPeerAppeared() async {
        let ch = FakeWebSocketChannel()
        let client = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        // A welcome, but nobody else ever joins and the socket never closes —
        // the one path the timeout exists for.
        ch.fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"}]}"#)

        let returned = expectation(description: "firstPeer returned")
        let caught = ErrorBox()
        Task {
            do { _ = try await RealtimeConnectionFactory.firstPeer(on: client, timeout: 0.2) }
            catch { caught.value = error }
            returned.fulfill()
        }
        await fulfillment(of: [returned], timeout: 5)
        XCTAssertEqual(caught.value as? RealtimeConnectionFactory.FactoryError, .noPeerAppeared)
    }

    /// The buffer stays installed for the whole firstPeer wait — up to two
    /// minutes — and anyone holding the pairing code can push signals into it
    /// for all of that. Unbounded, that is memory spent from the far end of a
    /// WebSocket. The cap has to hold, and it has to keep the EARLIEST signals:
    /// the offer arrives first and a flood behind it must not evict it.
    func testPendingSignalsCapsAndKeepsTheEarliestSignals() {
        let pending = PendingSignals()
        for i in 0..<(PendingSignals.capacity + 500) {
            pending.append(("peer", .object(["n": .number(Double(i))])))
        }
        let drained = pending.drain()
        XCTAssertEqual(drained.count, PendingSignals.capacity)
        XCTAssertEqual(drained.first?.1, .object(["n": .number(0)]), "the offer must survive the flood")
        XCTAssertEqual(drained.last?.1, .object(["n": .number(Double(PendingSignals.capacity - 1))]))
        XCTAssertTrue(pending.drain().isEmpty, "draining empties the buffer")
    }
}

/// Carries the thrown error out of a detached `Task` without an unstructured
/// capture the compiler has to take on trust.
private final class ErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Error?
    var value: Error? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
