import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The signals that chase a consumed offer, and the one turn in which they have
/// nowhere to go.
///
/// Every case below is a way that turn loses something a link needs, or holds
/// something it must not: a candidate dropped because no transport existed yet,
/// a stranger's SDP replayed into an establishment that trusts its room, a flood
/// spending a bound on frames that could never matter, or a truncated prefix
/// replayed as though it were the whole exchange.
final class LinkEstablishmentSignalBufferTests: XCTestCase {

    private let peer = "peer-buffered"

    // MARK: - the frames a peer really sends

    private func candidate(_ id: String = "1") -> JSONValue {
        .object(["link": .bool(true),
                 "ice": .object(["candidate": .string("candidate:\(id) 1 udp 1 10.0.0.1 1 typ host"),
                                 "sdpMid": .string("0"),
                                 "sdpMLineIndex": .number(0)])])
    }

    private func answer(_ sdp: String = "v=0 answer") -> JSONValue {
        linkSDPSignal(kind: "answer", sdp: sdp, commit: String(repeating: "c", count: 44),
                      caps: [LINK_CAPABILITY])
    }

    private func offer(_ sdp: String = "v=0 offer") -> JSONValue {
        linkSDPSignal(kind: "offer", sdp: sdp, commit: String(repeating: "c", count: 44),
                      caps: [LINK_CAPABILITY])
    }

    private func buffer(limit: Int = LINK_PENDING_CANDIDATE_MAX) -> LinkEstablishmentSignalBuffer {
        LinkEstablishmentSignalBuffer(peerId: peer, limit: limit)
    }

    // MARK: - 1. capture before the assembly exists

    /// The window this object exists for: the peer trickles its candidates before
    /// anything has been assembled, and every one of them is held.
    func testCandidatesArrivingBeforeTheAssemblyAreHeld() {
        let buffer = buffer()

        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("1")), .captured)
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("2")), .captured)

        XCTAssertEqual(buffer.count, 2)
        XCTAssertFalse(buffer.isOverflowed)
    }

    /// Arrival order IS the contract. An answer applied after the candidates that
    /// chase it is not the same establishment as one applied before them, so the
    /// replay hands them over in exactly the order the peer sent them — no
    /// reordering, no coalescing, no de-duplication.
    func testTheReplayPreservesArrivalOrderExactly() {
        let buffer = buffer()
        let sent = [answer(), candidate("1"), candidate("2"), candidate("1")]
        for signal in sent { XCTAssertEqual(buffer.accept(from: peer, signal: signal), .captured) }
        var replayed: [(from: String, signal: JSONValue)] = []

        XCTAssertTrue(buffer.drain { replayed.append(($0, $1)) })

        XCTAssertEqual(replayed.map(\.signal), sent,
                       "in order, including the duplicate the peer really repeated")
        XCTAssertEqual(Set(replayed.map(\.from)), [peer])
    }

    /// An establishment whose peer simply had not spoken yet replays nothing, and
    /// that is an ordinary answer rather than a failure.
    func testAnEstablishmentWithNothingHeldReplaysNothing() {
        let buffer = buffer()
        var delivered = 0

        XCTAssertTrue(buffer.drain { _, _ in delivered += 1 })

        XCTAssertEqual(delivered, 0)
        XCTAssertFalse(buffer.isOverflowed)
    }

    // MARK: - 2. direct delivery once it exists

    /// Once the replay has really finished there is a transport to reach, so
    /// nothing is held again — holding would mean a candidate sitting in a buffer
    /// while the link it belongs to is waiting for it.
    ///
    /// "Really finished" is the whole subtlety: while a replay is in progress the
    /// buffer keeps CAPTURING, because the caller is still handing signals over
    /// and anything arriving now has to queue behind them. Direct delivery begins
    /// only when a round of the replay finds the queue empty, which is where
    /// `drain`'s loop ends.
    func testSignalsArrivingAfterTheReplayFinishesAreReadyForDirectDelivery() {
        let buffer = buffer()
        _ = buffer.accept(from: peer, signal: candidate("1"))
        var delivered = 0

        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("mid")), .captured,
                       "still capturing until a replay has drained it")
        buffer.drain { _, _ in delivered += 1 }

        XCTAssertEqual(delivered, 2)
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("2")), .ready)
        XCTAssertEqual(buffer.accept(from: peer, signal: answer()), .ready)
        XCTAssertEqual(buffer.count, 0, "and nothing accumulates behind the link")
    }

    /// Draining twice hands nothing over a second time. A replay that repeated
    /// itself would apply one remote description twice and re-add every
    /// candidate.
    func testDrainingTwiceHandsNothingOverAgain() {
        let buffer = buffer()
        _ = buffer.accept(from: peer, signal: candidate("1"))
        var first = 0
        var second = 0

        XCTAssertTrue(buffer.drain { _, _ in first += 1 })
        XCTAssertTrue(buffer.drain { _, _ in second += 1 })

        XCTAssertEqual(first, 1)
        XCTAssertEqual(second, 0)
    }

    /// **One drain owner.** A second replay running at the same time as the first
    /// would observe an empty queue and flip the buffer open while the first is
    /// still handing over its batch — and the very next signal would then be
    /// answered `ready` and delivered ahead of signals that arrived before it.
    /// So a concurrent call delivers nothing: the owner already running loops
    /// until the queue is empty, and everything ends up in that one order.
    func testASecondDrainRunningConcurrentlyDeliversNothing() {
        let buffer = buffer()
        _ = buffer.accept(from: peer, signal: candidate("1"))
        let secondFinished = expectation(description: "the second drain returns")
        let secondDelivered = LockedBox<Int>(0)
        let secondAnswer = LockedBox<Bool>(false)
        var firstDelivered: [JSONValue] = []

        buffer.drain { _, signal in
            firstDelivered.append(signal)
            guard firstDelivered.count == 1 else { return }
            // A second owner tries to start while this one is mid-delivery.
            DispatchQueue.global().async {
                secondAnswer.value = buffer.drain { _, _ in
                    secondDelivered.mutate { $0 += 1 }
                }
                secondFinished.fulfill()
            }
            wait(for: [secondFinished], timeout: 5)
            // Whatever the second call did, it must not have opened the buffer:
            // a signal arriving now still queues behind this delivery.
            XCTAssertEqual(buffer.accept(from: self.peer, signal: self.candidate("2")),
                           .captured)
        }

        XCTAssertEqual(secondDelivered.value, 0, "the second owner delivered nothing")
        XCTAssertTrue(secondAnswer.value, "and it is not an error, just a no-op")
        XCTAssertEqual(firstDelivered, [candidate("1"), candidate("2")],
                       "the one owner delivered everything, in one order")
    }

    /// A re-entrant drain — the same thread, from inside `deliver` — is the same
    /// rule and the same answer. Nesting a second replay inside the first is
    /// precisely how a batch gets interleaved with itself.
    func testAReentrantDrainDeliversNothingAndDoesNotNest() {
        let buffer = buffer()
        _ = buffer.accept(from: peer, signal: candidate("1"))
        var delivered: [JSONValue] = []
        var nested = 0

        buffer.drain { _, signal in
            delivered.append(signal)
            if delivered.count == 1 {
                _ = buffer.accept(from: self.peer, signal: self.candidate("2"))
                XCTAssertTrue(buffer.drain { _, _ in nested += 1 })
            }
        }

        XCTAssertEqual(nested, 0, "the nested call delivered nothing")
        XCTAssertEqual(delivered, [candidate("1"), candidate("2")],
                       "and the outer loop picked its signal up, in order")
    }

    /// Overflow can happen PART-WAY through a replay, when a signal arriving
    /// mid-delivery pushes past the bound. `drain` then answers false with a
    /// prefix already delivered — which is not a loose end, because a caller that
    /// gets false is failing the establishment, but it is why false must not be
    /// read as "nothing happened".
    func testOverflowDuringAReplayAnswersFalseWithAPrefixDelivered() {
        let buffer = buffer(limit: 2)
        _ = buffer.accept(from: peer, signal: candidate("1"))
        var delivered: [JSONValue] = []

        let ok = buffer.drain { _, signal in
            delivered.append(signal)
            guard delivered.count == 1 else { return }
            // Two more arrive while the first is being handed over; the second
            // exceeds the bound.
            XCTAssertEqual(buffer.accept(from: self.peer, signal: self.candidate("2")),
                           .captured)
            XCTAssertEqual(buffer.accept(from: self.peer, signal: self.candidate("3")),
                           .captured)
            XCTAssertEqual(buffer.accept(from: self.peer, signal: self.candidate("4")),
                           .overflowed)
        }

        XCTAssertFalse(ok, "the caller must fail the establishment")
        XCTAssertEqual(delivered, [candidate("1")],
                       "and a prefix really was delivered before the bound broke")
        XCTAssertTrue(buffer.isOverflowed)
    }

    /// **The barrier.** A signal that arrives while an earlier batch is still
    /// being replayed must queue BEHIND it, not overtake it.
    ///
    /// The replay is blocked inside `drain` — which is exactly where a real
    /// caller is while it hands signals to a transport — and a second signal is
    /// accepted from another thread at that moment. If the buffer had already
    /// flipped to `open`, that signal would be answered `ready` and its caller
    /// would deliver it to the link ahead of the batch being replayed, reordering
    /// the peer's own SDP and ICE. It must be `captured`, and it must come out
    /// after everything that preceded it.
    func testASignalArrivingMidReplayCannotOvertakeTheBatchBeingReplayed() {
        let buffer = buffer()
        let first = candidate("first")
        let late = candidate("late")
        _ = buffer.accept(from: peer, signal: first)

        let inReplay = DispatchSemaphore(value: 0)
        let released = DispatchSemaphore(value: 0)
        let answer = LockedBox<LinkSignalCapture>(.rejected)
        var delivered: [JSONValue] = []

        let accepting = DispatchQueue(label: "accepting")
        buffer.drain { _, signal in
            delivered.append(signal)
            guard delivered.count == 1 else { return }
            // The caller is mid-replay. Anything arriving now is the case this
            // test exists for.
            accepting.async {
                answer.value = buffer.accept(from: self.peer, signal: late)
                inReplay.signal()
            }
            XCTAssertEqual(inReplay.wait(timeout: .now() + 5), .success)
            released.signal()
        }
        XCTAssertEqual(released.wait(timeout: .now() + 5), .success)

        XCTAssertEqual(answer.value, .captured,
                       "mid-replay is not ready: the earlier batch has not finished")
        XCTAssertEqual(delivered, [first, late],
                       "and it was delivered after the batch it arrived behind")
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("after")), .ready,
                       "only once the replay really drained does direct delivery begin")
    }

    /// One owner, one loop: `drain` keeps going until the queue is empty, so
    /// signals captured DURING the replay are delivered by the same call rather
    /// than stranded behind a caller that handed over one batch and stopped.
    func testDrainDeliversEverythingIncludingWhatArrivesDuringIt() {
        let buffer = buffer()
        _ = buffer.accept(from: peer, signal: candidate("1"))
        var delivered: [JSONValue] = []

        let ok = buffer.drain { _, signal in
            delivered.append(signal)
            if delivered.count == 1 {
                _ = buffer.accept(from: self.peer, signal: self.candidate("2"))
            }
        }

        XCTAssertTrue(ok)
        XCTAssertEqual(delivered, [candidate("1"), candidate("2")])
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("3")), .ready)
    }

    /// An overflowed buffer delivers nothing at all through `drain`, and says so
    /// — the caller must fail the establishment rather than replay a prefix.
    func testDrainRefusesAnOverflowedBufferWithoutDeliveringAnything() {
        let buffer = buffer(limit: 1)
        _ = buffer.accept(from: peer, signal: candidate("1"))
        _ = buffer.accept(from: peer, signal: candidate("2"))
        var delivered = 0

        XCTAssertFalse(buffer.drain { _, _ in delivered += 1 })

        XCTAssertEqual(delivered, 0)
    }

    // MARK: - 3. what is not this establishment's

    /// Another peer's frames are not this establishment's, whatever they contain.
    /// Replaying a stranger's SDP into a transport that trusts its room to have
    /// filtered by sender is the whole hazard.
    func testAnotherPeersSignalsAreRejected() {
        let buffer = buffer()

        XCTAssertEqual(buffer.accept(from: "peer-other", signal: candidate()), .rejected)
        XCTAssertEqual(buffer.accept(from: "peer-other", signal: answer()), .rejected)
        XCTAssertEqual(buffer.count, 0)
    }

    /// Another generation belongs to the legacy file and text connections, or to
    /// a rebuild whose coordinator this establishment does not have yet.
    /// Swallowing one would break a feature that already ships.
    func testOtherGenerationsAreRejected() {
        let buffer = buffer()
        let legacyOffer = sdpSignal(kind: "offer", sdp: "v=0", commit: nil)
        let textOffer = sdpSignal(kind: "offer", sdp: "v=0", commit: nil,
                                  generation: .text, caps: [TEXT_CAPABILITY])
        let rebuild = sdpSignal(kind: "offer", sdp: "v=0", commit: nil, generation: .resume)

        for signal in [legacyOffer, textOffer, rebuild] {
            XCTAssertEqual(buffer.accept(from: peer, signal: signal), .rejected)
        }
        XCTAssertEqual(buffer.count, 0)
    }

    /// Link CONTROL is `LinkAdmission`'s vocabulary, not a transport's. A
    /// transport ignores all three anyway, so holding them would spend the bound
    /// on frames that could never matter — the cheapest way for a flood to deny a
    /// real candidate its place.
    func testLinkControlIsRejectedRatherThanHeld() {
        let buffer = buffer()
        let leave = linkLeaveSignal(auth: String(repeating: "a", count: LINK_LEAVE_AUTH_LENGTH))

        XCTAssertEqual(buffer.accept(from: peer, signal: linkRequestSignal()), .rejected)
        XCTAssertEqual(buffer.accept(from: peer, signal: linkBusySignal()), .rejected)
        XCTAssertEqual(buffer.accept(from: peer, signal: leave), .rejected)
        XCTAssertEqual(buffer.count, 0, "the bound is for signalling, not for control")
    }

    /// Malformed and empty frames are not establishment signalling either.
    func testMalformedSignalsAreRejected() {
        let buffer = buffer()

        for signal: JSONValue in [.null, .array([]), .string("link"), .number(1), .object([:]),
                                  .object(["link": .bool(true)]),
                                  .object(["link": .bool(true), "caps": .array([])])] {
            XCTAssertEqual(buffer.accept(from: peer, signal: signal), .rejected)
        }
        XCTAssertEqual(buffer.count, 0)
    }

    // MARK: - 4. the bound

    /// Up to the bound is held; past it the buffer refuses and says so. It never
    /// drops the earliest — those are the host candidates a same-network link
    /// depends on — and never drops the latest, which would hide the flood.
    func testTheBoundIsExactAndOverflowIsReported() {
        let buffer = buffer(limit: 3)

        for index in 0..<3 {
            XCTAssertEqual(buffer.accept(from: peer, signal: candidate("\(index)")), .captured)
        }
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("overflow")), .overflowed)

        XCTAssertTrue(buffer.isOverflowed)
    }

    /// Overflow is terminal, and the drain refuses rather than handing back a
    /// prefix. A caller that replayed a truncated exchange would be presenting it
    /// as the whole one.
    func testAnOverflowedBufferReplaysNothingAtAll() {
        let buffer = buffer(limit: 2)
        _ = buffer.accept(from: peer, signal: candidate("1"))
        _ = buffer.accept(from: peer, signal: candidate("2"))
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("3")), .overflowed)

        XCTAssertFalse(buffer.drain { _, _ in XCTFail("nothing may be replayed") },
                       "the caller must fail the establishment closed")
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("4")), .overflowed,
                       "and it keeps saying so rather than quietly recovering")
        XCTAssertEqual(buffer.count, 0)
    }

    /// The default bound is the candidate gate's, because it is the same window
    /// shape one layer down and the two must not disagree about what a flood is.
    func testTheDefaultBoundIsTheCandidateGates() {
        let buffer = buffer()

        XCTAssertEqual(buffer.limit, LINK_PENDING_CANDIDATE_MAX)
        for index in 0..<LINK_PENDING_CANDIDATE_MAX {
            XCTAssertEqual(buffer.accept(from: peer, signal: candidate("\(index)")), .captured)
        }
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("one-too-many")), .overflowed)
    }

    // MARK: - 5. retirement

    /// A retired establishment holds nothing and claims nothing. Distinct from
    /// overflow on purpose: the room gave this attempt up, so there is no failure
    /// to answer for and a later frame is simply not this buffer's.
    func testARetiredBufferHoldsNothingAndClaimsNothing() {
        let buffer = buffer()
        _ = buffer.accept(from: peer, signal: candidate("1"))

        buffer.retire()

        XCTAssertEqual(buffer.count, 0, "what it was holding is dropped with the attempt")
        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("2")), .rejected,
                       "and it is not overflow: nothing failed")
        XCTAssertFalse(buffer.isOverflowed)
        var delivered = 0
        XCTAssertTrue(buffer.drain { _, _ in delivered += 1 })
        XCTAssertEqual(delivered, 0)
    }

    /// Retiring is idempotent and safe after a drain — the ordinary shape when a
    /// link is assembled and then given up.
    func testRetiringAfterTheDrainIsIdempotent() {
        let buffer = buffer()
        _ = buffer.accept(from: peer, signal: candidate("1"))
        buffer.drain { _, _ in }

        buffer.retire()
        buffer.retire()

        XCTAssertEqual(buffer.accept(from: peer, signal: candidate("2")), .rejected,
                       "a retired attempt takes nothing, not even for direct delivery")
    }

    // MARK: - 6. concurrency

    /// Capture happens on the socket's delivery queue while the drain happens on
    /// the main actor, so the two really do race. Whatever the interleaving:
    /// nothing is lost and nothing is duplicated — every captured signal is
    /// either replayed by the drain or answered `ready` for direct delivery, and
    /// the total is exactly what was offered.
    func testConcurrentCaptureAndDrainLoseNothingAndDuplicateNothing() {
        let buffer = buffer(limit: 512)
        let total = 256
        let lock = NSLock()
        var ready = 0

        let drained = DispatchQueue(label: "drain")
        let replayed = LockedBox<Int>(0)
        drained.async {
            usleep(200)
            // `drain` loops until the queue is empty, so it also picks up
            // whatever was captured while it was running: there is no leftover
            // for the test to sweep up afterwards.
            _ = buffer.drain { _, _ in replayed.mutate { $0 += 1 } }
        }

        DispatchQueue.concurrentPerform(iterations: total) { index in
            switch buffer.accept(from: peer, signal: candidate("\(index)")) {
            case .captured: break
            case .ready: lock.lock(); ready += 1; lock.unlock()
            case .rejected, .overflowed: XCTFail("nothing here is refusable")
            }
        }
        drained.sync {}
        // Nothing may be left holding: `drain` flips to `open` only in the same
        // critical section that observed the queue empty, so a signal is either
        // replayed by it or answered `ready` to its own caller — never stranded.
        XCTAssertEqual(buffer.count, 0, "nothing was left holding")
        XCTAssertEqual(replayed.value + ready, total,
                       "every signal was accounted for exactly once")
    }

    // MARK: - 7. one construction path

    /// Holding a peer's signalling is not a second ownership boundary. Only the
    /// link establishment path may construct this buffer, including in the
    /// macOS production Workspace.
    func testTheBufferKeepsOneConstructionPath() throws {
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        // Each root must exist. `RepoRoot.directory` throws with the path it
        // wanted, where a missing root used to be skipped one line below and the
        // scan then reported clean over nothing.
        let roots = try ["apps/RelayiumKit/Sources", "apps/ios", "apps/mac"]
            .map { try RepoRoot.directory($0) }
        var scanned = 0
        for root in roots {
            for file in try RepoRoot.swiftFiles(in: root) {
                scanned += 1
                // The buffer's own file, and the one object accepted as its
                // owner. `LinkRoomRouter` installs a buffer in the same critical
                // section as the claim it belongs to — that indivisibility is
                // what this cut exists for — so it necessarily names one. The
                // guarantee is unchanged rather than relaxed: the router is
                // itself unreachable, which
                // `LinkRoomRouterTests.testTheRouterStaysUnreachableFromProduction`
                // asserts, so no app composition still reaches a buffer.
                let owners = ["LinkEstablishmentSignalBuffer.swift", "LinkRoomRouter.swift"]
                guard !owners.contains(file.lastPathComponent) else { continue }
                let source = try RepoRoot.text(of: file)
                XCTAssertFalse(source.contains("LinkEstablishmentSignalBuffer("),
                               "\(file.lastPathComponent) constructs a pre-assembly buffer")
            }
        }
        XCTAssertGreaterThan(scanned, 50, "the scan really reached the app sources")
    }

    /// Concurrent overflow: many threads push past a small bound at once, and the
    /// buffer settles on exactly the bound's worth held, one terminal answer for
    /// the rest, and a drain that refuses.
    func testConcurrentOverflowSettlesOnOneTerminalAnswer() {
        let buffer = buffer(limit: 8)
        let lock = NSLock()
        var captured = 0

        DispatchQueue.concurrentPerform(iterations: 128) { index in
            if buffer.accept(from: peer, signal: candidate("\(index)")) == .captured {
                lock.lock(); captured += 1; lock.unlock()
            }
        }

        XCTAssertLessThanOrEqual(captured, 8, "never more than the bound was held")
        XCTAssertTrue(buffer.isOverflowed)
        XCTAssertFalse(buffer.drain { _, _ in XCTFail("nothing may be replayed") })
    }
}

/// A value two threads hand between them, guarded by its own lock.
///
/// Deliberately NOT an unsynchronised `var` behind `@unchecked Sendable`: the
/// semaphores in this file order when each access happens, but ordering is not
/// synchronisation — an unguarded field written on one thread and read on
/// another is a data race whatever the surrounding barriers do, and it is
/// exactly the kind Thread Sanitizer is run to catch.
final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) { stored = value }

    var value: Value {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }

    /// Read-modify-write under one acquisition, for a counter two threads bump.
    func mutate(_ body: (inout Value) -> Void) {
        lock.lock(); body(&stored); lock.unlock()
    }
}
