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

/// A channel that stalls inside `send` for the FIRST relay-RTT message it is
/// given, and records it only once the stall is over.
///
/// This is the window the sender-side reordering defect lives in. `record()`
/// used to release the lock, and only then encode and hand the map to the
/// socket — so a probe finishing during another probe's `send` could put a
/// LARGER map on the wire first and leave the smaller one to land behind it.
/// `handleSignal` on the far side replaced its copy wholesale, so the peer's
/// view of our map shrank, permanently if that pair was the last one.
///
/// Stalling before the append rather than after is the whole point: it lets the
/// second, later map get onto the wire ahead of the first if — and only if —
/// nothing is serialising the two.
private final class StallingChannel: WebSocketChannel {
    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    var onClose: (() -> Void)?
    private(set) var isOpen = false

    private let stall: TimeInterval
    private let lock = NSLock()
    private var stalledOnce = false
    private var _sent: [String] = []
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }

    init(stall: TimeInterval) { self.stall = stall }

    func send(_ text: String) {
        guard isOpen else { return }
        var shouldStall = false
        if text.contains("relayRtt") {
            lock.lock()
            if !stalledOnce { stalledOnce = true; shouldStall = true }
            lock.unlock()
        }
        if shouldStall { Thread.sleep(forTimeInterval: stall) }
        lock.lock(); _sent.append(text); lock.unlock()
    }

    func close() { isOpen = false; onClose?() }
    func fireOpen() { isOpen = true; onOpen?() }
}

/// How many relays each `relayRtt` message on the wire carried, in wire order.
private func relayRttSizes(_ sent: [String]) -> [Int] {
    sent.compactMap { text in
        guard let d = text.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let data = root["data"] as? [String: Any],
              let rtt = data["relayRtt"] as? [String: Any] else { return nil }
        return rtt.count
    }
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

    /// The choice must be made over our WHOLE map, not over whichever relay
    /// happened to answer first.
    ///
    /// `wake()` used to fire the instant any relay was common to both maps.
    /// Before measurement became incremental that moment necessarily had a
    /// complete `mine`; afterwards it usually has a one-entry prefix, so
    /// "minimise the worse of the two RTTs" was never actually evaluated — the
    /// pair converged on whichever relay answered us first. Worse, with both
    /// peers still probing, each side's local increment beats the peer's
    /// matching broadcast by one network delay, so each latches on its own
    /// nearest relay measured against the peer's older prefix and the two SWAP:
    /// each picks the other's nearest, the worst pair on offer.
    ///
    /// Here `x` answers first and is the peer's favourite (max(100, 1) = 100),
    /// while `y` arrives 300 ms later and is the jointly best (max(10, 10) =
    /// 10). Latching on the first overlap returns `x`.
    func testTheCompleteMapDecidesRatherThanTheFirstOverlap() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["x", "y"]),
                                measure: { _, publish in
            publish("x", 100)
            try? await Task.sleep(nanoseconds: 300_000_000)
            publish("y", 10)
        })
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["x": 1, "y": 10]))

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 3.0)
        XCTAssertEqual(chosen?.id, "y",
                       "the choice must wait for our own measurement rather than latch on the first common relay")
        XCTAssertLessThan(Date().timeIntervalSince(began), 2.0,
                          "waiting for our measurement is not waiting for the deadline")
    }

    /// The other half of the same rule: "wait for our own measurement" must not
    /// become "wait for the slowest probe". A relay that never answers cannot
    /// hold the deadline hostage — which is the entire reason measurement was
    /// made incremental in the first place.
    ///
    /// `slow` never lands inside the 0.3 s deadline, so the wait can only end
    /// on the deadline, and it must end there with a usable answer rather than
    /// nil. The lower bound is the half that goes red against the old
    /// wake-on-first-choice behaviour, which returned at once.
    func testAStragglerCannotHoldTheDeadlineHostage() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["fast", "slow"]),
                                measure: { _, publish in
            publish("fast", 10)
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            publish("slow", 1)
        })
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["fast": 10, "slow": 1]))

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 0.3)
        let elapsed = Date().timeIntervalSince(began)
        XCTAssertEqual(chosen?.id, "fast",
                       "the deadline must yield the best relay so far, not nil")
        XCTAssertGreaterThanOrEqual(elapsed, 0.3,
                                    "an unfinished measurement must not latch the choice early")
        XCTAssertLessThan(elapsed, 2.0,
                          "the deadline must govern, not the slowest probe in the pool")
    }

    /// `measuredMs()` feeds the other half of what `RealtimeConnectionFactory`'s
    /// `waited=` field conflates: time spent on our OWN probes, independent of
    /// whether or when the peer shows up. Nil until `start()`'s measurement
    /// actually finishes, then latched.
    func testMeasuredMsIsNilUntilOurOwnMeasurementFinishesThenLatches() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["slow"]),
                                measure: { _, publish in
            try? await Task.sleep(nanoseconds: 200_000_000)
            publish("slow", 5)
        })
        n.start()
        XCTAssertNil(n.measuredMs(), "our own measurement has not finished yet")
        // A peer map already in hand means `waitForChoice` wakes the instant
        // our own measurement finishes rather than running the full deadline.
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["slow": 8]))
        _ = await n.waitForChoice(deadline: 2.0)
        XCTAssertNotNil(n.measuredMs(), "our own measurement has finished by now")
    }

    /// The case the log line's "unfinished" representation exists for: the
    /// deadline cuts the wait off before our own measurement is done. Same
    /// setup as `testAStragglerCannotHoldTheDeadlineHostage` — `waitForChoice`
    /// still returns the best relay so far, but `measuredMs()` must not report
    /// a number for a probe that has not actually finished.
    func testMeasuredMsIsNilWhenTheDeadlineCutsOffOurOwnMeasurement() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["fast", "slow"]),
                                measure: { _, publish in
            publish("fast", 10)
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            publish("slow", 1)
        })
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["fast": 10, "slow": 1]))
        let chosen = await n.waitForChoice(deadline: 0.3)
        XCTAssertEqual(chosen?.id, "fast")
        XCTAssertNil(n.measuredMs(),
                     "the slow relay's probe had not finished when the deadline cut the wait off")
    }

    /// Sender-side reordering: two probes landing while a send is in flight
    /// must not put the SMALLER map on the wire last.
    ///
    /// `a` is recorded first and its send stalls for 300 ms. `b` lands 100 ms
    /// into that stall. Unless the encode-and-send is serialised with the map
    /// growth, `b`'s two-entry map overtakes `a`'s one-entry map, the peer
    /// applies `{a}` last, and its copy of our map is one relay short from then
    /// on — which on the final increments is permanent.
    ///
    /// The assertion is on sizes rather than contents because that is the
    /// invariant: what we put on the wire only ever grows.
    func testAnEarlierMapNeverOvertakesALaterOneOnTheWire() async {
        let ch = StallingChannel(stall: 0.3)
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["a", "b"]),
                                measure: { _, publish in
            await withTaskGroup(of: Void.self) { group in
                group.addTask { publish("a", 10) }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    publish("b", 20)
                }
            }
        })
        n.peerJoined("peer")   // before start(): mine is empty, so this sends nothing itself
        n.start()

        let sawBoth = await eventually(timeout: 3.0) {
            relayRttSizes(ch.sent).count >= 2
        }
        XCTAssertTrue(sawBoth, "both increments should have reached the socket")
        XCTAssertEqual(relayRttSizes(ch.sent), [1, 2],
                       "the map on the wire must never shrink: {a} then {a,b}, never {a,b} then {a}")
    }

    /// The receiving half of the same defect. A peer whose sends reorder — an
    /// older native build, or any client that broadcasts increments — can hand
    /// us a map shorter than one we already have. Merging keeps what we were
    /// told before; replacing wholesale throws it away.
    ///
    /// Here the stale second message would leave only `x` in the intersection
    /// (max(100, 1) = 100). Merged, `y` survives and wins on max(10, 2) = 10.
    func testAStaleShorterPeerMapDoesNotShrinkOurCopyOfIt() async {
        let (n, _) = negotiator(["x", "y"], mine: ["x": 100, "y": 10])
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["x": 1, "y": 2]))
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["x": 1]))
        let chosen = await n.waitForChoice(deadline: 1.0)
        XCTAssertEqual(chosen?.id, "y",
                       "a short, late map must not drop a relay the peer already told us about")
    }
}
