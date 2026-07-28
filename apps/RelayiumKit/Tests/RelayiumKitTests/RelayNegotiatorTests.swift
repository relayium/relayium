import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private func pool(_ ids: [String]) -> [RelayEntry] {
    ids.map { RelayEntry(id: $0, iceServers: [ICEServerConfig(urls: ["turn:\($0):3478"])]) }
}

/// A measurement that publishes every entry of `map` immediately — the stand-in
/// for a pool where every relay answers at once. `RelayNegotiator.Measure`
/// streams results rather than returning a map, so tests hand it one of these
/// instead of a plain closure returning a dictionary.
private func measuring(_ map: [String: Int]) -> RelayNegotiator.Measure {
    { _, publish in for (id, ms) in map { publish(id, ms) } }
}

final class RelayNegotiatorTests: XCTestCase {
    private func negotiator(_ ids: [String],
                            mine: [String: Int]) -> (RelayNegotiator, FakeWebSocketChannel) {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(ids), measure: measuring(mine))
        return (n, ch)
    }

    /// Polls `predicate` with a bounded wait instead of a fixed sleep.
    /// `FakeWebSocketChannel.sent` is mutated from `start()`'s background
    /// Task without synchronisation, so a flat `Task.sleep` before reading it
    /// would either flake under load or mask a genuine failure to send —
    /// polling for the condition itself does neither.
    private func eventually(timeout: TimeInterval = 2.0, _ predicate: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)   // 10ms
        }
        return predicate()
    }

    func testConvergesOnTheRelayBothPeersLike() async {
        let (n, _) = negotiator(["n1", "n3"], mine: ["n1": 200, "n3": 40])
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 30, "n3": 50]))
        let chosen = await n.waitForChoice(deadline: 1.0)
        // n1: max(200,30)=200; n3: max(40,50)=50 → n3.
        XCTAssertEqual(chosen?.id, "n3")
    }

    /// The fallback that keeps this feature from ever being the reason a
    /// transfer fails: a peer on an older build never sends a map.
    func testAPeerThatNeverAnswersLeavesNoChoice() async {
        let (n, _) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        let chosen = await n.waitForChoice(deadline: 0.2)
        XCTAssertNil(chosen)
    }

    func testAnEmptyPoolIsSkippedEntirely() async {
        let (n, ch) = negotiator([], mine: [:])
        n.start()
        let chosen = await n.waitForChoice(deadline: 0.2)
        XCTAssertNil(chosen)
        XCTAssertTrue(ch.sent.filter { $0.contains("relayRtt") }.isEmpty,
                      "nothing to advertise, so nothing should be sent")
    }

    /// Broadcast on measure-done and on peer-join, never in reply — that is
    /// what stops two peers echoing maps at each other forever.
    func testNeverRepliesToAReceivedMap() async {
        let (n, ch) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        _ = await n.waitForChoice(deadline: 0.3)   // let the measurement land
        let afterMeasure = ch.sent.filter { $0.contains("relayRtt") }.count
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        XCTAssertEqual(ch.sent.filter { $0.contains("relayRtt") }.count, afterMeasure,
                       "receiving a map must not send one back")
    }

    /// An unrelated signal must not be mistaken for an empty measurement.
    func testAnUnrelatedSignalDoesNotClobberTheMap() async {
        let (n, _) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        n.handleSignal(from: "peer", data: .object(["rename": .string("Phone")]))
        let chosen = await n.waitForChoice(deadline: 0.5)
        XCTAssertEqual(chosen?.id, "n1")
    }

    /// Regression test for the `waitForChoice` rewrite: a signal arriving
    /// mid-wait must resume the parked call itself, not merely get picked up
    /// because the deadline eventually elapsed and the maps got rechecked.
    /// Deleting `wake()` entirely still leaves every other test in this file
    /// green (their deadlines are generous enough to mask it), so only
    /// measuring elapsed time distinguishes "woken early" from "timed out and
    /// recomputed". The deadline (5s) and the assertion (well under 2s) are
    /// both loose on purpose: this measures whether a wake-up happened at
    /// all, not how fast the machine is.
    func testWakingDuringTheWaitReturnsWellBeforeTheDeadline() async {
        let (n, _) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        let began = Date()
        async let chosen: RelayEntry? = n.waitForChoice(deadline: 5.0)
        // Give the wait a moment to actually park (register a waiter) before
        // signalling, so this exercises the wake()-while-parked path rather
        // than the current()-already-chosen fast path at entry. The 2s
        // assertion below has enough slack that imprecision here can't turn
        // this into a false pass.
        try? await Task.sleep(nanoseconds: 50_000_000)
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        let result = await chosen
        XCTAssertEqual(result?.id, "n1")
        XCTAssertLessThan(Date().timeIntervalSince(began), 2.0,
                           "a mid-wait signal should wake waitForChoice long before its 5s deadline")
    }

    /// peerJoined's own broadcast path: the peer arrives once measuring has
    /// already finished, so `peerJoined` itself must be the one to send.
    ///
    /// `ch.sent` is an unsynchronised array mutated from `start()`'s
    /// background Task, so this does not read it until `waitForChoice` has
    /// returned non-nil — which can only happen once `mine` was actually
    /// recorded, and `mine` is never cleared afterwards. That handshake is
    /// the synchronisation, so there is nothing left to poll or race.
    func testBroadcastsToAPeerThatJoinsAfterMeasuringCompletes() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["n1"]), measure: measuring(["n1": 10]))
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        let chosen = await n.waitForChoice(deadline: 5.0)
        XCTAssertEqual(chosen?.id, "n1", "sanity: measuring must have actually landed")

        n.peerJoined("newPeer")   // joins now that `mine` is guaranteed populated
        XCTAssertEqual(ch.sent.filter { $0.contains("relayRtt") }.count, 1,
                       "peerJoined's own send is the only path that should have fired")
    }

    /// start()'s completion broadcast path: the peer is already registered
    /// before measuring finishes, so peerJoined's own send is skipped
    /// (nothing to say yet) and start()'s completion loop must be the one
    /// to send instead.
    ///
    /// Unlike the test above, `waitForChoice` resolving here does NOT prove
    /// the send has landed: `mine` becomes visible (and so `chosenIDLocked()`
    /// non-nil, unblocking `current()`'s fast path and any `wake()` call) as
    /// soon as `start()`'s Task releases the lock, which is *before* that same
    /// Task's `for p in targets { send(to: p) }` loop actually runs — traced
    /// with monotonic timestamps while first writing this test, where
    /// `waitForChoice` returned non-nil measurably earlier than the matching
    /// `FakeWebSocketChannel.send` call. So this polls for the actual send
    /// with a bounded wait instead of trusting the resolution order.
    func testBroadcastsToAPeerAlreadyJoinedWhenMeasuringCompletes() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["n1"]), measure: measuring(["n1": 10]))
        n.peerJoined("peer")   // before start(): mine is empty, so this alone sends nothing
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        _ = await n.waitForChoice(deadline: 5.0)   // let the measurement land

        let sawIt = await eventually {
            ch.sent.filter { $0.contains("relayRtt") }.count >= 1
        }
        XCTAssertTrue(sawIt, "start()'s completion loop should have sent to the already-joined peer")
        XCTAssertEqual(ch.sent.filter { $0.contains("relayRtt") }.count, 1,
                       "exactly one relayRtt message — not zero, not a duplicate from both paths")
    }

    /// The defect this branch shipped with. `RelayProbe.measureAll` drained its
    /// entire TaskGroup before returning anything, so the map became visible
    /// only at the MAX over all six probes — and one silent relay pins that at
    /// the full 4 s probe timeout while `relayChoiceDeadline` upstream is
    /// 800 ms. A single unreachable relay in the pool therefore made
    /// `waitForChoice` time out on BOTH peers on EVERY transfer: the feature
    /// charged its full cost and delivered none of its benefit.
    ///
    /// Here "slow" answers after 3 s, far past the 0.4 s deadline, and would
    /// win outright if it arrived (RTT 1 against 10) — so the assertion cannot
    /// pass by accident. Against publish-on-completion this returns nil.
    func testASlowRelayDoesNotHoldUpAFastOne() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["fast", "slow"]),
                                measure: { _, publish in
            publish("fast", 10)
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            publish("slow", 1)
        })
        n.start()
        // The peer measured both and would rather have "slow".
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["fast": 10, "slow": 1]))

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 0.4)
        XCTAssertEqual(chosen?.id, "fast",
                       "a 3s straggler must not stop the relay that already answered from being chosen")
        XCTAssertLessThan(Date().timeIntervalSince(began), 2.0,
                          "the deadline must govern, not the slowest probe in the pool")
    }
}
