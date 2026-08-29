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
    /// `FakeWebSocketChannel.sent` is mutated from `start()`'s background Task.
    /// The capture is synchronized, and polling the actual condition avoids a
    /// fixed sleep that would either flake under load or mask a send failure.
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
    /// This does not inspect `ch.sent` until `waitForChoice` has returned
    /// non-nil — which can only happen once `mine` was actually recorded, and
    /// `mine` is never cleared afterwards. The fake capture is synchronized;
    /// this handshake also means there is nothing left to poll.
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

    /// **A peer's measurements leave with it.**
    ///
    /// The room's grace is per peer, and a fresh one is worth nothing if the
    /// arriving peer walks into a choice already settled from the numbers of
    /// somebody who is gone: it would never get to influence the relay its own
    /// link is built on.
    func testAPeersMapLeavesWithIt() async {
        let (n, _) = negotiator(["x", "y"], mine: ["x": 10, "y": 20])
        n.start()
        n.peerJoined("first")
        n.handleSignal(from: "first", data: RelayRttMessage.encode(["x": 5]))
        let withFirst = await n.waitForChoice(deadline: 1.0)
        XCTAssertEqual(withFirst?.id, "x")

        n.peerLeft("first")
        XCTAssertEqual(n.maps().theirs, [:],
                       "nothing is contributing a map any more, so the room holds none")
        let afterDeparture = await n.waitForChoice(deadline: 0.1)
        XCTAssertNil(afterDeparture,
                     "and no choice, so the next peer's grace is a real one")

        n.handleSignal(from: "second", data: RelayRttMessage.encode(["y": 4]))
        let withSecond = await n.waitForChoice(deadline: 1.0)
        XCTAssertEqual(withSecond?.id, "y",
                       "the arriving peer's own measurements decide")
    }

    /// A room that still has another contributor keeps the merged map, which is
    /// the same answer merging has always given. Only the last one out clears it.
    func testAnotherContributorKeepsTheMap() async {
        let (n, _) = negotiator(["x"], mine: ["x": 10])
        n.start()
        n.handleSignal(from: "first", data: RelayRttMessage.encode(["x": 5]))
        n.handleSignal(from: "second", data: RelayRttMessage.encode(["x": 6]))
        n.peerLeft("first")
        XCTAssertEqual(n.maps().theirs, ["x": 6])
        let chosen = await n.waitForChoice(deadline: 1.0)
        XCTAssertEqual(chosen?.id, "x")
    }

    /// **A probe the PEER has already ruled out cannot hold the choice.**
    ///
    /// The timing-free half of `RelayChoice.dominates`, which is the half this
    /// type can use soundly today. `slow` never answers inside the deadline, but
    /// the peer measured it at 900 ms against a pick whose worse leg is 30 — so
    /// whatever our own probe eventually reports, `max` for `slow` is worse and
    /// it cannot become the pick. Waiting for it is waiting for nothing.
    ///
    /// The lower bound is what makes this a test rather than a coincidence: the
    /// old `measurementFinished`-only rule ran the full 0.5 s deadline here.
    func testAPeerLegAlreadyWorseThanThePickRetiresAnUnfinishedProbe() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["fast", "slow"]),
                                measure: { _, publish in
            publish("fast", 30)
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            publish("slow", 1)
        })
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["fast": 20, "slow": 900]))

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 0.5)
        XCTAssertEqual(chosen?.id, "fast")
        XCTAssertLessThan(Date().timeIntervalSince(began), 0.4,
                          "a probe the peer has already ruled out must not cost the deadline")
    }

    /// The other side of the same rule, and the one that keeps it honest: a peer
    /// leg EQUAL to the pick's worse leg is not worse. `slow` at 30 against a
    /// pick of max(30, 20) = 30 ties, and `pick` then goes to the sum — where
    /// `slow` would win — so the wait must run its full deadline.
    ///
    /// This measurement deliberately never fires `allProbesStarted`, which is
    /// what isolates the peer-leg half of the rule: with no anchor there is no
    /// elapsed bound, so the only thing that could retire `slow` is the peer's
    /// leg, and an equal one does not.
    /// `testTheClockRetiresAProbeAnEqualPeerLegCannot` is the same state WITH
    /// the barrier, where the clock does retire it — for a different reason,
    /// which is the point of keeping both.
    func testAnEqualPeerLegDoesNotRetireAnUnfinishedProbe() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["fast", "slow"]),
                                measure: { _, publish in
            publish("fast", 30)
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            publish("slow", 1)
        })
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["fast": 20, "slow": 30]))

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 0.3)
        XCTAssertEqual(chosen?.id, "fast", "the deadline must still yield the best relay so far")
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 0.3,
                                    "an equal peer leg leaves the sum and the id able to turn the choice")
    }

    /// Every relay in the pool has answered, so `mine` cannot grow — and the
    /// room does not need `measure` to return before it knows that. The probe
    /// task here stays alive for five seconds after its last publish; waiting
    /// for it is waiting for machinery, not for evidence.
    func testAFullyAnsweredPoolSettlesWithoutWaitingForMeasureToReturn() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["a", "b"]),
                                measure: { _, publish in
            publish("a", 10)
            publish("b", 90)
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        })
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["a": 15, "b": 400]))

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 2.0)
        XCTAssertEqual(chosen?.id, "a")
        XCTAssertLessThan(Date().timeIntervalSince(began), 1.0,
                          "a pool that has fully answered must not wait for the probe task to unwind")
        XCTAssertNil(n.measuredMs(),
                     "and it is still honest about our own measurement not having finished")
    }

    // MARK: - the elapsed lower bound, and the barrier that makes it sound

    /// **The defect this whole change exists for, at the negotiator.**
    ///
    /// One relay answers in 40 ms, the other is the production shape: advertised,
    /// allocated for, and silent for the whole nine-second probe budget. The
    /// peer has spoken. Nothing further will happen until that silent probe
    /// times out — so without the clock the room sits on an answer it already
    /// has until the five-second deadline gives up on it, which is exactly what
    /// the 2026-08-29 pairing measurements showed.
    ///
    /// The measurement here is `RelayProbe.measureAll`'s own shape — the same
    /// task group, the same `ProbeStartBarrier`, acknowledged from inside each
    /// child — so this also pins that the barrier cannot deadlock the group it
    /// is called from, and that a child which never finishes cannot stop the
    /// edge from firing.
    func testAFastCommonRelayOpensInUnderASecondDespiteANineSecondSilentProbe() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(["fast", "silent"]),
                                measure: { pool, sink in
            let barrier = ProbeStartBarrier(expected: pool.count,
                                            onAllStarted: { sink.allProbesStarted() })
            await withTaskGroup(of: Void.self) { group in
                for (index, entry) in pool.enumerated() {
                    group.addTask {
                        // Stands in for "this probe's clock is running", exactly
                        // where `RelayProbe.measure` acknowledges.
                        barrier.acknowledge(index)
                        if entry.id == "fast" { sink(entry.id, 40) }
                        else { try? await Task.sleep(nanoseconds: 9_000_000_000) }
                    }
                }
            }
        })
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["fast": 55]))

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 5.0)
        let waited = Date().timeIntervalSince(began)
        XCTAssertEqual(chosen?.id, "fast")
        XCTAssertLessThan(waited, 1.0,
                          "a silent advertised relay must not hold a choice the room already has")
        XCTAssertNil(n.measuredMs(),
                     "and it returned while our own measurement was genuinely still running")
    }

    /// **An early publication is buffered, and gets no elapsed bound.**
    ///
    /// Three deadlines, in order, and each one rules out a different wrong
    /// anchor:
    ///
    /// 1. `fast` has answered and the peer has spoken, but the barrier has not
    ///    fired. Five seconds pass on the clock. The room must still wait — a
    ///    result is not a start.
    /// 2. The barrier fires at that five-second mark. The room must STILL wait,
    ///    because elapsed is now zero. If the anchor were `start()`'s instant —
    ///    the tempting one, and the unsound one — elapsed would read 5 000 ms
    ///    and this deadline would return instantly.
    /// 3. One millisecond past the pick's worse leg, and only then, it returns.
    func testAnEarlyPublicationIsBufferedAndTheAnchorIsTheBarrierNotTheStart() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let clock = TestClock()
        let published = Gate(), release = Gate(), anchored = Gate()
        let n = RelayNegotiator(signaling: sig, pool: pool(["fast", "silent"]),
                                now: clock.read,
                                measure: { _, sink in
            sink("fast", 30)
            await published.open()
            await release.wait()
            sink.allProbesStarted()
            await anchored.open()
            try? await Task.sleep(nanoseconds: 9_000_000_000)
        })
        n.start()
        await published.wait()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["fast": 30]))
        XCTAssertEqual(n.maps().mine, ["fast": 30], "the early result must still be recorded")

        clock.advance(ms: 5_000)
        await assertWaitsOutTheDeadline(n, deadline: 0.25, expecting: "fast",
                                        "elapsed dominance must not run before every probe started")

        await release.open()
        await anchored.wait()
        await assertWaitsOutTheDeadline(n, deadline: 0.25, expecting: "fast",
                                        "the anchor is the barrier, not the call to start()")

        clock.advance(ms: 31)
        await assertReturnsImmediately(n, expecting: "fast",
                                        "one millisecond past the worse leg retires the silent probe")
    }

    /// Equality, at the negotiator rather than in the pure rule: elapsed exactly
    /// ON the pick's worse leg is not past it, because `pick` would fall through
    /// to the sum and then the id, either of which can still hand `silent` the
    /// room. One more millisecond is the whole difference.
    func testTheClockRetiresAProbeOnlyStrictlyPastThePicksWorseLeg() async {
        let (n, clock) = await barrierNegotiator(pool: ["fast", "silent"],
                                                 answers: ["fast": 30],
                                                 peer: ["fast": 20])
        // max(30, 20) = 30.
        clock.advance(ms: 30)
        await assertWaitsOutTheDeadline(n, deadline: 0.25, expecting: "fast",
                                        "equality leaves the sum and the id able to turn the choice")
        clock.advance(ms: 1)
        await assertReturnsImmediately(n, expecting: "fast", "31 ms is strictly past 30")
    }

    /// The same state as `testAnEqualPeerLegDoesNotRetireAnUnfinishedProbe`,
    /// but with the barrier fired. There the peer's equal leg could not retire
    /// `silent`; here the CLOCK can, and for an independent reason: our own
    /// probe has been running longer than 30 ms, so whatever it reports is
    /// worse than 30, so `max` for `silent` is worse than the pick's.
    func testTheClockRetiresAProbeAnEqualPeerLegCannot() async {
        let (n, clock) = await barrierNegotiator(pool: ["fast", "silent"],
                                                 answers: ["fast": 30],
                                                 peer: ["fast": 20, "silent": 30])
        clock.advance(ms: 30)
        await assertWaitsOutTheDeadline(n, deadline: 0.25, expecting: "fast",
                                        "an equal peer leg and an equal clock retire nothing")
        clock.advance(ms: 1)
        await assertReturnsImmediately(n, expecting: "fast",
                                        "the clock is an independent route to the same retirement")
    }

    /// A pending relay the peer rates BETTER than the pick's worse leg is the
    /// case the peer-leg test cannot touch — `silent` at 5 could obviously win.
    /// Only the clock retires it, and only because our own unfinished leg is
    /// what would be compared: `max(≥ 31, 5)` is worse than 30.
    func testAPendingRelayThePeerRatesBetterIsRetiredOnlyByTheClock() async {
        let (n, clock) = await barrierNegotiator(pool: ["fast", "silent"],
                                                 answers: ["fast": 20],
                                                 peer: ["fast": 30, "silent": 5])
        clock.advance(ms: 30)
        await assertWaitsOutTheDeadline(n, deadline: 0.25, expecting: "fast",
                                        "a relay the peer rates at 5 ms can still win at 30 ms elapsed")
        clock.advance(ms: 1)
        await assertReturnsImmediately(n, expecting: "fast",
                                        "at 31 ms our own leg for it is already worse than the pick's")
    }

    /// **The wake-up is recomputed when the pick moves.**
    ///
    /// The exit instant is a function of the pick's worse leg, so a peer map
    /// that improves the pick moves it — here from 101 ms to 21 ms, earlier
    /// rather than later. A wake-up armed against the old pick and left alone
    /// would cost the room 80 ms it no longer owes; one that fired on the old
    /// deadline against the new pick would be worse.
    func testMovingThePickRecomputesTheExitInstant() async {
        let (n, clock) = await barrierNegotiator(pool: ["a", "b", "c"],
                                                 answers: ["a": 100, "b": 10],
                                                 peer: ["a": 100])
        // pick a: max(100, 100) = 100, so nothing before 101 ms retires `c`.
        clock.advance(ms: 21)
        await assertWaitsOutTheDeadline(n, deadline: 0.25, expecting: "a",
                                        "21 ms is nowhere near the current pick's worse leg")
        // The peer measures b. pick moves to b: max(10, 20) = 20 — and 21 ms is
        // already past it.
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["a": 100, "b": 20]))
        await assertReturnsImmediately(n, expecting: "b",
                                        "the exit instant follows the pick that is actually held")
    }

    /// A second `allProbesStarted` keeps the FIRST anchor. A later instant would
    /// also be at-or-after every start, so it would be sound — but it would
    /// silently move an exit the room had already earned, and a `Measure` that
    /// fires the edge twice honoured the contract on the first one.
    func testADuplicateAllProbesStartedKeepsTheFirstAnchor() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let clock = TestClock()
        let anchored = Gate(), again = Gate(), reanchored = Gate()
        let n = RelayNegotiator(signaling: sig, pool: pool(["fast", "silent"]),
                                now: clock.read,
                                measure: { _, sink in
            sink("fast", 30)
            sink.allProbesStarted()
            await anchored.open()
            await again.wait()
            sink.allProbesStarted()
            await reanchored.open()
            try? await Task.sleep(nanoseconds: 9_000_000_000)
        })
        n.start()
        await anchored.wait()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["fast": 30]))

        clock.advance(ms: 20)
        await again.open()
        await reanchored.wait()

        // 20 ms have already elapsed against the first anchor. A second anchor
        // taken here would reset that to zero and need 31 more.
        clock.advance(ms: 11)
        await assertReturnsImmediately(n, expecting: "fast",
                                        "a duplicate edge must not restart the elapsed bound")
    }

    /// A departed peer's map cannot be dominated into opening the gate. The
    /// clock has run far past anything the room ever held, but `peerLeft` took
    /// the last contributor's map with it, so there is no pick — and dominance
    /// over nothing is not dominance.
    func testADepartedPeersMapIsNotRetiredIntoAChoice() async {
        let (n, clock) = await barrierNegotiator(pool: ["fast", "silent"],
                                                 answers: ["fast": 30],
                                                 peer: ["fast": 30])
        n.peerLeft("peer")
        clock.advance(ms: 5_000)

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 0.25)
        XCTAssertNil(chosen, "a departed peer's measurements are not a choice")
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 0.25,
                                    "and nothing may release the wait on them")
        XCTAssertFalse(n.hasPeerMaps())
    }

    /// An empty pool has no probe to start, so no `Measure` runs and no edge
    /// ever fires. `waitForChoice` still refuses it outright rather than
    /// dividing by an anchor that does not exist.
    func testAnEmptyPoolNeverMeasuresAndNeverAnchors() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let clock = TestClock()
        let n = RelayNegotiator(signaling: sig, pool: [], now: clock.read,
                                measure: { _, _ in XCTFail("an empty pool must not be measured") })
        n.start()
        clock.advance(ms: 60_000)
        let began = Date()
        let chosen = await n.waitForChoice(deadline: 0.5)
        XCTAssertNil(chosen)
        XCTAssertLessThan(Date().timeIntervalSince(began), 0.2,
                          "an empty pool is answered without waiting")
        XCTAssertNotNil(n.measuredMs(), "and its measurement is finished, honestly, at once")
    }

    /// A one-relay pool that answers has nothing pending, so it settles on the
    /// timing-free half with the clock still at zero — the barrier costs it
    /// nothing and changes nothing.
    func testASingletonPoolThatAnswersSettlesWithNoElapsedAtAll() async {
        let (n, _) = await barrierNegotiator(pool: ["only"],
                                             answers: ["only": 44],
                                             peer: ["only": 51])
        await assertReturnsImmediately(n, expecting: "only",
                                        "a fully answered pool needs no clock")
    }

    /// A one-relay pool that stays silent is the case the clock must NOT rescue:
    /// there is no common relay, so there is nothing to be dominant over, and no
    /// amount of elapsed time invents a pick.
    func testASingletonSilentPoolIsNotRescuedByTheClock() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let clock = TestClock()
        let anchored = Gate()
        let n = RelayNegotiator(signaling: sig, pool: pool(["silent"]), now: clock.read,
                                measure: { _, sink in
            sink.allProbesStarted()
            await anchored.open()
            try? await Task.sleep(nanoseconds: 9_000_000_000)
        })
        n.start()
        await anchored.wait()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["silent": 12]))
        clock.advance(ms: 60_000)

        let began = Date()
        let chosen = await n.waitForChoice(deadline: 0.25)
        XCTAssertNil(chosen, "no common relay is no choice, however long we wait")
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 0.25)
    }

    /// Eight probes acknowledging and publishing from eight concurrent children
    /// while a waiter is parked, and the barrier's callback reaching back into
    /// the negotiator from inside one of them. Nothing here may deadlock, drop a
    /// result, or fire the edge more than once.
    func testConcurrentStartsAndPublicationsNeitherDeadlockNorLoseResults() async {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let ids = (0..<8).map { "r\($0)" }
        let edges = Counter()
        let measured = Gate()
        let n = RelayNegotiator(signaling: sig, pool: pool(ids),
                                measure: { pool, sink in
            let barrier = ProbeStartBarrier(expected: pool.count, onAllStarted: {
                edges.increment()
                sink.allProbesStarted()
            })
            await withTaskGroup(of: Void.self) { group in
                for (index, entry) in pool.enumerated() {
                    group.addTask {
                        barrier.acknowledge(index)
                        // A duplicate from the same child: the barrier must not
                        // count it as another probe having started.
                        barrier.acknowledge(index)
                        sink(entry.id, 10 + index)
                    }
                }
            }
            await measured.open()
        })
        n.start()
        n.handleSignal(from: "peer",
                       data: RelayRttMessage.encode(Dictionary(uniqueKeysWithValues:
                            ids.enumerated().map { ($0.element, 20 + $0.offset) })))

        let chosen = await n.waitForChoice(deadline: 2.0)
        XCTAssertEqual(chosen?.id, "r0", "max(10, 20) = 20 is the best worse leg")

        // Deliberately AFTER the measurement has actually finished rather than
        // after the wait returned. The wait is entitled to return with `mine`
        // still growing — every other relay's peer leg is already worse than
        // the pick's 20, so all seven are retired the moment `r0` and the peer
        // map meet — and asserting on the map before then is asserting that the
        // early exit did not happen.
        await measured.wait()
        XCTAssertEqual(n.maps().mine.count, 8, "every concurrent publication was recorded")
        XCTAssertEqual(edges.value, 1, "the all-started edge fires exactly once")
    }

    // MARK: - ProbeStartBarrier

    func testTheBarrierFiresOnlyWhenEveryEntryHasAcknowledged() {
        let fired = Counter()
        let barrier = ProbeStartBarrier(expected: 3, onAllStarted: { fired.increment() })
        barrier.acknowledge(0)
        XCTAssertEqual(fired.value, 0)
        barrier.acknowledge(2)
        XCTAssertEqual(fired.value, 0)
        barrier.acknowledge(1)
        XCTAssertEqual(fired.value, 1)
    }

    /// The reason the barrier tracks indices instead of counting. Two
    /// acknowledgements from probe 0 and one from probe 1 is three
    /// acknowledgements and two started probes; a counter would fire on a claim
    /// that is false, and the anchor taken there would precede probe 2's start.
    func testDuplicateAcknowledgementsCannotStandInForAProbeThatHasNotStarted() {
        let fired = Counter()
        let barrier = ProbeStartBarrier(expected: 3, onAllStarted: { fired.increment() })
        barrier.acknowledge(0)
        barrier.acknowledge(0)
        barrier.acknowledge(0)
        barrier.acknowledge(1)
        barrier.acknowledge(1)
        XCTAssertEqual(fired.value, 0, "five acknowledgements from two probes are still two probes")
        barrier.acknowledge(2)
        XCTAssertEqual(fired.value, 1)
    }

    func testALateAcknowledgementAfterTheBarrierFiredIsANoOp() {
        let fired = Counter()
        let barrier = ProbeStartBarrier(expected: 2, onAllStarted: { fired.increment() })
        barrier.acknowledge(0)
        barrier.acknowledge(1)
        XCTAssertEqual(fired.value, 1)
        barrier.acknowledge(0)
        barrier.acknowledge(1)
        barrier.acknowledge(7)
        XCTAssertEqual(fired.value, 1, "the edge is one-shot")
    }

    func testAnEmptyBarrierIsAlreadySatisfied() {
        let fired = Counter()
        _ = ProbeStartBarrier(expected: 0, onAllStarted: { fired.increment() })
        XCTAssertEqual(fired.value, 1)
        let negative = Counter()
        _ = ProbeStartBarrier(expected: -3, onAllStarted: { negative.increment() })
        XCTAssertEqual(negative.value, 1, "a nonsense count is satisfied, not a trap")
    }

    func testTheBarrierFiresExactlyOnceUnderConcurrentAcknowledgement() {
        for _ in 0..<50 {
            let fired = Counter()
            let barrier = ProbeStartBarrier(expected: 16, onAllStarted: { fired.increment() })
            DispatchQueue.concurrentPerform(iterations: 16) { index in
                barrier.acknowledge(index)
                barrier.acknowledge(index)
            }
            XCTAssertEqual(fired.value, 1)
        }
    }

    // MARK: - helpers for the bound

    /// A negotiator whose measurement fires the all-started edge, publishes
    /// `answers`, and then stays alive without ever answering for anything else
    /// in `pool` — the production shape. Returns once the anchor is taken and
    /// the peer's map has been applied, so a test can advance the clock and know
    /// exactly what elapsed reading it is producing.
    private func barrierNegotiator(pool ids: [String],
                                   answers: [String: Int],
                                   peer: [String: Int])
        async -> (RelayNegotiator, TestClock) {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let clock = TestClock()
        let anchored = Gate()
        let n = RelayNegotiator(signaling: sig, pool: pool(ids), now: clock.read,
                                measure: { _, sink in
            for (id, ms) in answers.sorted(by: { $0.key < $1.key }) { sink(id, ms) }
            sink.allProbesStarted()
            await anchored.open()
            try? await Task.sleep(nanoseconds: 9_000_000_000)
        })
        n.start()
        await anchored.wait()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(peer))
        return (n, clock)
    }

    /// The wait must run its whole deadline and still hand back the best relay
    /// so far — "not settled" never means "no answer".
    private func assertWaitsOutTheDeadline(_ n: RelayNegotiator,
                                           deadline: TimeInterval,
                                           expecting id: String,
                                           _ message: String,
                                           file: StaticString = #filePath,
                                           line: UInt = #line) async {
        let began = Date()
        let chosen = await n.waitForChoice(deadline: deadline)
        XCTAssertEqual(chosen?.id, id, message, file: file, line: line)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), deadline, message,
                                    file: file, line: line)
    }

    /// Settled: `waitForChoice` answers from `settledChoice` without parking, so
    /// the deadline it is given is irrelevant and a generous one is the stronger
    /// assertion.
    private func assertReturnsImmediately(_ n: RelayNegotiator,
                                          expecting id: String,
                                          _ message: String,
                                          file: StaticString = #filePath,
                                          line: UInt = #line) async {
        let began = Date()
        let chosen = await n.waitForChoice(deadline: 5.0)
        XCTAssertEqual(chosen?.id, id, message, file: file, line: line)
        XCTAssertLessThan(Date().timeIntervalSince(began), 0.5, message, file: file, line: line)
    }
}

/// A hand-driven monotonic clock, in seconds, matching `RelayNegotiator`'s
/// `now`.
///
/// Monotonic by construction: `advance` is the only mutator and it only adds.
/// The starting value is deliberately far from zero — an anchor bug that
/// happened to read a zero-based clock could otherwise pass by coincidence.
private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var seconds: TimeInterval = 9_876.5

    func read() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return seconds }

    func advance(ms: Int) {
        lock.lock()
        seconds += TimeInterval(ms) / 1000
        lock.unlock()
    }
}

/// A one-shot rendezvous, so a test can hand control back and forth with a
/// measurement instead of polling or sleeping for it.
///
/// Every wait in these tests has a `Gate` behind it rather than a duration:
/// what is being pinned is an ORDER — result before barrier, barrier before
/// clock — and a sleep long enough to be reliable is also long enough to hide
/// the ordering it was meant to establish.
private actor Gate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        guard !opened else { return }
        opened = true
        let pending = waiters
        waiters = []
        for w in pending { w.resume() }
    }

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }
}

/// A lock-guarded counter, for assertions made from concurrent probe children.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int { lock.lock(); defer { lock.unlock() }; return count }

    func increment() { lock.lock(); count += 1; lock.unlock() }
}
