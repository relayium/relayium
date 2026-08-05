import XCTest
@testable import RelayiumKit

/// A transport that behaves like the real ones: a private serial queue that
/// `send`/`bufferedAmount` enter SYNCHRONOUSLY, and frames delivered ON that
/// queue. That is what makes a driver holding its own lock across `send` a real
/// deadlock, and what a fake with an independent lock can never show.
final class QueuedFakeTransport: LinkReplacementTransport, LinkLiveTransport, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.relayium.test.transport")
    private let key = DispatchSpecificKey<Bool>()
    private let slots = NSLock()
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    private var sentFrames: [[UInt8]] = []
    private let sentLock = NSLock()

    var onReady: ((LinkIdentity) -> Void)?
    var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onFrame }
        set { slots.lock(); defer { slots.unlock() }; _onFrame = newValue }
    }
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?

    init() { queue.setSpecific(key: key, value: true) }

    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: key) == true { return body() }
        return queue.sync { body() }
    }

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        onQueue {
            sentLock.lock(); sentFrames.append(bytes); sentLock.unlock()
        }
    }
    func bufferedAmount(on lane: LinkLane) -> UInt64 { onQueue { 0 } }
    var isClosed: Bool { onQueue { false } }
    func close() {}
    func start() {}
    func receive(from: String, signal: JSONValue) {}

    var sent: [[UInt8]] { sentLock.lock(); defer { sentLock.unlock() }; return sentFrames }

    /// Deliver a frame the way the real driver does: on the transport's own queue.
    func deliverOnQueue(_ lane: LinkLane, _ bytes: [UInt8]) {
        queue.async { [weak self] in self?.onFrame?(lane, bytes) }
    }
}

/// A destination whose `finalize` a test holds open, so a terminal failure can be
/// made to race a commit that is already succeeding.
///
/// **Every gate here is bounded.** A driver that never reaches finalize, or one
/// that never releases it, is a failure to report — not a test that wedges the
/// whole suite behind an unbounded semaphore.
final class GatedFinalizeDestination: LinkFileDestination, @unchecked Sendable {
    private let entered = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var _finalized = false
    private var _aborted = false
    private var _abandoned = false

    var finalized: Bool { lock.lock(); defer { lock.unlock() }; return _finalized }
    var aborted: Bool { lock.lock(); defer { lock.unlock() }; return _aborted }
    /// The commit was never released inside its bound. The test that produced it
    /// is wrong, and saying so is better than hanging.
    var abandoned: Bool { lock.lock(); defer { lock.unlock() }; return _abandoned }

    @discardableResult
    func waitUntilFinalizing(timeout: TimeInterval = 5.0) -> Bool {
        entered.wait(timeout: .now() + timeout) == .success
    }
    func letFinalizeFinish() { release.signal() }

    func write(_ bytes: [UInt8]) throws {}
    func openNextFile(index: Int) throws {}
    func finalize() throws {
        entered.signal()
        if release.wait(timeout: .now() + 10.0) != .success {
            lock.lock(); _abandoned = true; lock.unlock()
        }
        lock.lock(); _finalized = true; lock.unlock()
    }
    func abort() { lock.lock(); _aborted = true; lock.unlock() }
}

/// A producer that seals its frames LAZILY, from the link's own sender, so a
/// resumed attempt's frames really follow that attempt's announcement in the one
/// shared sequence. Pre-sealing them would number them against a sequence the
/// marker has since moved.
final class ResumeScriptedProducer: LinkFileProducing, @unchecked Sendable {
    private let lock = NSLock()
    private let sender: RealtimeSender
    private var bodies: [[UInt8]]
    private var doneHash: [UInt8]?

    init(sender: RealtimeSender, bodies: [[UInt8]], doneHash: [UInt8]? = nil) {
        self.sender = sender
        self.bodies = bodies
        self.doneHash = doneHash
    }

    func next() throws -> [UInt8]? {
        lock.lock(); defer { lock.unlock() }
        if !bodies.isEmpty { return try sender.nextChunkFrame(bodies.removeFirst()) }
        guard let hash = doneHash else { return nil }
        doneHash = nil
        return try sender.nextDoneFrame(hash: hash)
    }
}

/// A thread-safe counter, so an escaping hook can be observed without a captured
/// `var` that two threads write.
final class HookCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func bump() { lock.lock(); value += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}

/// Codex's independent review of the first `LinkFileDriver` draft. Every test
/// here reproduces one confirmed finding, plus the cases the rewrite owes:
/// an attach whose resume cannot be sent, an early COMPLETE, every source-release
/// path, text on the same transport after a file failure, cumulative progress
/// across a resumed attempt, and the finalize/terminal race.
final class LinkFileDriverReviewTests: XCTestCase {

    private let C = CHUNK_SIZE
    private func meta(_ name: String, _ size: Int) -> FileMeta { FileMeta(name: name, size: size) }

    private func codecPair() -> (LinkCodecs, RealtimeSender) {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x11, count: 32),
                                recvKey: [UInt8](repeating: 0x22, count: 32))
        return (codecs, RealtimeSender(sessionKey: [UInt8](repeating: 0x22, count: 32)))
    }

    private func identity(_ codecs: LinkCodecs) -> LinkIdentity {
        LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: codecs)
    }

    private func driver(codecs: LinkCodecs,
                        transport: LinkLiveTransport,
                        destination: LinkFileDestination = FakeDestination(),
                        scheduler: LinkRecoveryScheduler = FakeLinkScheduler(),
                        producer: LinkFileProducing = FakeProducer(frames: []),
                        onText: @escaping ([UInt8]) -> Void = { _ in },
                        onEvent: @escaping (LinkFileDriverEvent) -> Void = { _ in })
    -> LinkFileDriver {
        LinkFileDriver(identity: identity(codecs), transport: transport,
                       scheduler: scheduler,
                       producerFactory: { _ in producer },
                       destinationFactory: { _, _ in destination },
                       ackInterval: 1,
                       onTextFrame: onText, onEvent: onEvent)
    }

    // ── 1. lock inversion with a real transport queue ───────────────────────

    /// Thread A enters a public call, takes the driver lock and sends — which
    /// enters the transport's queue synchronously. That queue is already inside
    /// `onFrame`, waiting for the driver lock. Neither can proceed.
    func testSendingUnderTheDriverLockDeadlocksAgainstTheTransportQueue() throws {
        let (codecs, peer) = codecPair()
        let transport = QueuedFakeTransport()
        let d = driver(codecs: codecs, transport: transport)

        // Park the transport queue inside a frame delivery that wants the lock.
        let inFrame = DispatchSemaphore(value: 0)
        let holdFrame = DispatchSemaphore(value: 0)
        transport.queue.async {
            inFrame.signal()
            _ = holdFrame.wait(timeout: .now() + 5.0)
            // Whatever the driver installed will now want the driver lock.
            transport.onFrame?(.file, [LINK_FILE_BUSY])
        }
        XCTAssertEqual(inFrame.wait(timeout: .now() + 5.0), .success)

        _ = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        let done = expectation(description: "pump returned")
        DispatchQueue.global().async {
            d.pump()          // sends into the queue the parked delivery holds
            done.fulfill()
        }
        // Let the parked delivery start competing for the lock.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { holdFrame.signal() }

        wait(for: [done], timeout: 2.0)
        _ = peer
    }

    // ── 2. the initial transport cannot be routed in production ─────────────

    /// The real initial transport is a live lane, not a replacement driver. A
    /// driver that only routes replacements can never see its first frame — and
    /// installation has to happen at construction, before any captured replay.
    func testTheInitialTransportIsRoutedWithoutAManualReplacementCall() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        let d = driver(codecs: codecs, transport: transport)
        // Deliberately NO manual routing call: production has nothing to pass.
        for frame in try peer.batchFrames([meta("in.bin", C)]) { transport.deliver(.file, frame) }
        d.settle()
        XCTAssertNotNil(d.activeInboundBatch,
                        "the initial transport's frames must reach the file session")
    }

    /// The seam the initial route needs is satisfied by BOTH concrete transports,
    /// with no adapter. If either stops conforming this stops compiling.
    func testBothConcreteTransportsCarryTheInitialRoute() {
        func accepts<T: LinkLiveTransport>(_ type: T.Type) -> Bool { true }
        XCTAssertTrue(accepts(WebRTCLinkTransport.self))
        XCTAssertTrue(accepts(WebRTCLinkReplacementTransport.self))
    }

    // ── 3. the coordinator is not actually wired ────────────────────────────

    /// The replacement's `onFrame` belongs to `LinkRecoveryCoordinator`: it is what
    /// applies the staleness checks and what the coordinator requires to be
    /// installed before it publishes. A driver that overwrites it takes frames
    /// behind the coordinator's back.
    func testTheCoordinatorRemainsTheReplacementFrameOwner() throws {
        let (codecs, peer) = codecPair()
        let initial = FakeLinkTransport()
        let replacement = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        let d = driver(codecs: codecs, transport: initial, scheduler: scheduler)

        let coordinator = LinkRecoveryCoordinator(
            identity: identity(codecs), current: initial,
            factory: { _ in replacement }, scheduler: scheduler)
        let routed = HookCounter()
        coordinator.installOwnerHooks(
            onTransportLost: { [weak d] id in d?.onTransportLost(id) ?? false },
            onAttach: { [weak d] id, transport in try d?.onAttach(id, transport) },
            onFrame: { [weak d] lane, bytes in
                routed.bump()
                d?.routeCurrentFrame(lane: lane, bytes: bytes)
            },
            onEnded: { [weak d] error in d?.onEnded(error) })

        _ = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        d.pump()
        coordinator.transportTerminated(initial, error: nil)
        replacement.onReady?(identity(codecs))
        d.settle()
        XCTAssertEqual(coordinator.phase, .open, "the rebuild was published")

        replacement.deliver(.file, [LINK_FILE_BUSY])
        XCTAssertGreaterThan(routed.count, 0,
                             "frames must reach the driver THROUGH the coordinator's own route")
        _ = peer
    }

    /// `bind` installs all four hooks in ONE step, and the driver takes the
    /// coordinator's frames from there on.
    func testBindingInstallsEveryHookAndRoutesThroughTheCoordinator() throws {
        let (codecs, peer) = codecPair()
        let initial = FakeLinkTransport()
        let replacement = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        let d = driver(codecs: codecs, transport: initial, scheduler: scheduler)
        let coordinator = LinkRecoveryCoordinator(
            identity: identity(codecs), current: initial,
            factory: { _ in replacement }, scheduler: scheduler)
        try d.bind(to: coordinator, otherLanesNeedRecovery: { _ in false },
                   otherLanesEnded: { _ in })

        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { initial.deliver(.file, frame) }
        d.settle()
        d.acceptInbound()
        d.settle()

        coordinator.transportTerminated(initial, error: nil)
        replacement.onReady?(identity(codecs))
        d.settle()
        XCTAssertEqual(coordinator.phase, .open)
        XCTAssertTrue(replacement.sent.contains { $0.first == RealtimeKind.resumeReq },
                      "the resume request went out inside the attach barrier")

        // A later frame, delivered on the replacement itself, so it passes the
        // coordinator's own staleness checks on its way in.
        replacement.deliver(.file, [LINK_FILE_BATCH_ABORT])
        d.settle()
        XCTAssertNil(d.activeInboundBatch, "the ordered barrier reached the session")
    }

    /// A coordinator holding somebody else's authentication is refused rather
    /// than adopted.
    func testBindingRefusesAForeignCoordinator() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        let d = driver(codecs: codecs, transport: transport)
        let foreign = LinkIdentity(peerId: "someone-else", role: .responder, sas: "999999",
                                   codecs: LinkCodecs(sendKey: [UInt8](repeating: 5, count: 32),
                                                      recvKey: [UInt8](repeating: 6, count: 32)))
        let coordinator = LinkRecoveryCoordinator(identity: foreign, current: transport,
                                                  factory: { _ in FakeLinkTransport() },
                                                  scheduler: FakeLinkScheduler())
        XCTAssertThrowsError(try d.bind(to: coordinator,
                                        otherLanesNeedRecovery: { _ in false },
                                        otherLanesEnded: { _ in })) {
            XCTAssertEqual($0 as? LinkFileDriverError, .foreignCoordinator)
        }
    }

    /// The attach barrier's whole purpose: the resume request is on the wire
    /// BEFORE the replacement replays a single captured frame.
    func testAttachEffectsAreOnTheWireBeforeTheCapturedReplay() throws {
        let (codecs, peer) = codecPair()
        let initial = FakeLinkTransport()
        let replacement = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        let d = driver(codecs: codecs, transport: initial, scheduler: scheduler)
        let coordinator = LinkRecoveryCoordinator(
            identity: identity(codecs), current: initial,
            factory: { _ in replacement }, scheduler: scheduler)
        try d.bind(to: coordinator, otherLanesNeedRecovery: { _ in false },
                   otherLanesEnded: { _ in })

        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { initial.deliver(.file, frame) }
        d.settle()
        d.acceptInbound()
        d.settle()
        coordinator.transportTerminated(initial, error: nil)

        // The peer spoke the instant its lanes opened; the transport captured it.
        replacement.capture(.file, [LINK_FILE_BUSY])
        replacement.publish(identity(codecs))
        d.settle()

        let sentBeforeReplay = try XCTUnwrap(replacement.sentWhenReplayed)
        XCTAssertGreaterThan(sentBeforeReplay, 0,
                             "the backlog replayed into a lane whose request had not gone out")
        XCTAssertTrue(replacement.sent.prefix(sentBeforeReplay)
                        .contains { $0.first == RealtimeKind.resumeReq })
    }

    /// A resume effect that cannot be written means this driver never took the
    /// lanes over. The attach has to fail closed, inside the barrier, before the
    /// coordinator publishes.
    func testAnAttachWhoseResumeCannotBeSentIsRejected() throws {
        let (codecs, peer) = codecPair()
        let initial = FakeLinkTransport()
        let replacement = FakeLinkTransport()
        replacement.failSends(true)
        let scheduler = FakeLinkScheduler()
        let d = driver(codecs: codecs, transport: initial, scheduler: scheduler)
        let coordinator = LinkRecoveryCoordinator(
            identity: identity(codecs), current: initial,
            factory: { _ in replacement }, scheduler: scheduler)
        try d.bind(to: coordinator, otherLanesNeedRecovery: { _ in false },
                   otherLanesEnded: { _ in })

        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { initial.deliver(.file, frame) }
        d.settle()
        d.acceptInbound()
        d.settle()
        coordinator.transportTerminated(initial, error: nil)

        XCTAssertThrowsError(try d.onAttach(identity(codecs), replacement)) {
            XCTAssertEqual($0 as? LinkFileDriverError, .sendFailed)
        }
        XCTAssertTrue(d.isTerminal, "and the lane the nonce was spent on is closed")
    }

    /// The same failure driven only through the coordinator: a throwing attach is
    /// never published, and the held link ends with it rather than becoming
    /// current under an owner that did not take its lanes.
    func testACoordinatorNeverPublishesAnAttachThatThrew() throws {
        let (codecs, peer) = codecPair()
        let initial = FakeLinkTransport()
        let replacement = FakeLinkTransport()
        replacement.failSends(true)
        let scheduler = FakeLinkScheduler()
        let d = driver(codecs: codecs, transport: initial, scheduler: scheduler)
        let coordinator = LinkRecoveryCoordinator(
            identity: identity(codecs), current: initial,
            factory: { _ in replacement }, scheduler: scheduler)
        try d.bind(to: coordinator, otherLanesNeedRecovery: { _ in false },
                   otherLanesEnded: { _ in })

        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { initial.deliver(.file, frame) }
        d.settle()
        d.acceptInbound()
        d.settle()

        coordinator.transportTerminated(initial, error: nil)
        replacement.publish(identity(codecs))
        d.settle()

        XCTAssertEqual(coordinator.phase, .ended,
                       "the rebuild was never published over a failed attach")
        XCTAssertTrue(d.isTerminal)
        XCTAssertTrue(d.isLinkEnded, "and the driver was told the link is over")
    }

    /// A file lane that is ALREADY terminal must not decline a rebuild.
    ///
    /// It has nothing to resume and takes nothing over — but the conversation on
    /// this link is not the file driver's to end, so the replacement still becomes
    /// current and text still reaches its route through it.
    func testATerminalFileLaneStillAttachesSoTheConversationSurvives() throws {
        let (codecs, peer) = codecPair()
        let initial = FakeLinkTransport()
        let replacement = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        var text: [[UInt8]] = []
        let d = driver(codecs: codecs, transport: initial, scheduler: scheduler,
                       onText: { text.append($0) })
        let coordinator = LinkRecoveryCoordinator(
            identity: identity(codecs), current: initial,
            factory: { _ in replacement }, scheduler: scheduler)
        // The text lane says it has something worth recovering; the file lane,
        // which is about to die, does not.
        try d.bind(to: coordinator, otherLanesNeedRecovery: { _ in true },
                   otherLanesEnded: { _ in })

        // Protected content before consent fails the file lane closed.
        for frame in try peer.batchFrames([meta("in.bin", C)]) { initial.deliver(.file, frame) }
        d.settle()
        initial.deliver(.file, try peer.nextChunkFrame([UInt8](repeating: 1, count: 32)))
        d.settle()
        XCTAssertTrue(d.isTerminal)

        coordinator.transportTerminated(initial, error: nil)
        XCTAssertEqual(coordinator.phase, .interrupted,
                       "an idle-or-dead file lane cannot decline a link the text lane needs")
        replacement.publish(identity(codecs))
        d.settle()
        XCTAssertEqual(coordinator.phase, .open)
        XCTAssertFalse(d.isLinkEnded)

        let frame: [UInt8] = [RealtimeKind.text, 0, 0, 0, 1, 7, 7]
        replacement.deliver(.text, frame)
        XCTAssertEqual(text, [frame], "the conversation carried on to the new transport")
    }

    /// A transport the driver has replaced cannot speak for the link again.
    func testAStaleTransportCannotRetakeTheRouteAfterAnAttach() throws {
        let (codecs, peer) = codecPair()
        let initial = FakeLinkTransport()
        let replacement = FakeLinkTransport()
        let d = driver(codecs: codecs, transport: initial, scheduler: FakeLinkScheduler())
        _ = d.onTransportLost(identity(codecs))
        try d.onAttach(identity(codecs), replacement)
        d.settle()

        // The old transport still holds the route the driver installed on it.
        for frame in try peer.batchFrames([meta("in.bin", C)]) { initial.deliver(.file, frame) }
        d.settle()
        XCTAssertNil(d.activeInboundBatch, "a stale transport's frames are dropped")
        XCTAssertFalse(d.isTerminal)
    }

    // ── 4. same-key stale timer ─────────────────────────────────────────────

    /// Re-arming a watchdog cancels the old handle and stores a new one under the
    /// SAME key. A cancelled callback that had already started then finds the key
    /// occupied — by its successor — and fires the live watchdog early.
    func testACancelledReceiveStallCannotFireItsSuccessorsWatchdog() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        let d = driver(codecs: codecs, transport: transport, scheduler: scheduler)

        for frame in try peer.batchFrames([meta("in.bin", 4 * C)]) { transport.deliver(.file, frame) }
        d.settle()
        d.acceptInbound()
        d.settle()
        // Two chunks: the second re-arms the stall watchdog and cancels the first.
        transport.deliver(.file, try peer.nextChunkFrame([UInt8](repeating: 1, count: C)))
        d.settle()
        transport.deliver(.file, try peer.nextChunkFrame([UInt8](repeating: 2, count: C)))
        d.settle()
        XCTAssertEqual(d.activeInboundBatch != nil, true)

        scheduler.fireCancelledOnly()
        d.settle()
        let controls = transport.sent.filter { $0.count == 1 }.map { $0[0] }
        XCTAssertFalse(controls.contains(RealtimeControl.reject.rawValue),
                       "a cancelled generation's wake-up must not stall the live receive")
    }

    // ── 5. finalize racing a terminal abort ─────────────────────────────────

    /// A commit that is already succeeding must not be undone by a failure that
    /// observed it a moment too early. The discard is decided while `committed`
    /// is still false; by the time it could run, the file is the user's.
    func testATerminalFailureDuringFinalizeCannotDeleteTheCommittedFile() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        let sink = GatedFinalizeDestination()
        var events: [LinkFileDriverEvent] = []
        let lock = NSLock()
        let d = driver(codecs: codecs, transport: transport, destination: sink,
                       onEvent: { lock.lock(); events.append($0); lock.unlock() })

        let body = WireVectors.content(40, seed: 61)
        let file = meta("only.bin", body.count)
        for frame in try peer.batchFrames([file]) { transport.deliver(.file, frame) }
        d.settle()
        d.acceptInbound()
        d.settle()
        for frame in try peer.dataFrames([(file, body)]) { transport.deliver(.file, frame) }

        guard sink.waitUntilFinalizing() else {
            sink.letFinalizeFinish()
            return XCTFail("the commit never started: the driver did not reach finalize")
        }
        d.onEnded(LinkRecoveryError.windowExpired)   // the link ends underneath it
        sink.letFinalizeFinish()
        d.settle()

        XCTAssertFalse(sink.abandoned, "the commit was released inside its bound")
        XCTAssertTrue(sink.finalized)
        XCTAssertFalse(sink.aborted, "a committed file is the user's; nothing may discard it")
        lock.lock(); let seen = events; lock.unlock()
        let inbound = seen.compactMap { event -> Bool? in
            if case let .inboundFinished(_, ok) = event { return ok } else { return nil }
        }
        XCTAssertEqual(inbound, [true],
                       "and the commit is reported exactly once, as the commit it was")
    }

    /// The same race in the other direction: a finalisation that FAILED under a
    /// terminal is still a discard, and the destination really is let go.
    func testAFailedFinalisationUnderATerminalStillDiscards() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        let sink = FakeDestination(failure: .finalize)
        let d = driver(codecs: codecs, transport: transport, destination: sink)

        let body = WireVectors.content(40, seed: 62)
        let file = meta("only.bin", body.count)
        for frame in try peer.batchFrames([file]) { transport.deliver(.file, frame) }
        d.settle()
        d.acceptInbound()
        d.settle()
        for frame in try peer.dataFrames([(file, body)]) { transport.deliver(.file, frame) }
        d.settle()

        XCTAssertFalse(sink.finalized)
        XCTAssertTrue(sink.aborted, "nothing committed, so nothing is kept")
    }

    // ── 6. retirement families leak sources and results ─────────────────────

    /// Every way a batch can end has to produce exactly one result and release its
    /// sources. A consent timeout produces neither today.
    func testAConsentTimeoutReportsTheResultAndReleasesSources() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        var events: [LinkFileDriverEvent] = []
        let d = driver(codecs: codecs, transport: transport, scheduler: scheduler,
                       onEvent: { events.append($0) })

        let id = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        d.pump()
        d.settle()
        scheduler.fireAll()          // the shared consent deadline passes
        d.settle()

        XCTAssertNil(d.activeOutboundBatch)
        XCTAssertTrue(events.contains(.outboundFinished(batch: id, ok: false)),
                      "a batch that timed out is a result, not silence")
        XCTAssertEqual(d.retainedSourceBatches, [], "and its sources are released")
    }

    /// A COMPLETE that crossed the producer's last frames is remembered by the
    /// session and acted on when the producer ends. The result that follows is
    /// still a completion, several effects later.
    func testAnEarlyCompleteIsStillReportedAsACompletion() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x81, count: 32),
                                recvKey: [UInt8](repeating: 0x82, count: 32))
        let transport = FakeLinkTransport()
        let body = [UInt8](repeating: 4, count: 40)
        let gate = WholeBatchGatedProducer(sender: codecs.fileSender, body: body)
        var events: [LinkFileDriverEvent] = []
        let lock = NSLock()
        let d = LinkFileDriver(identity: LinkIdentity(peerId: "peer", role: .initiator,
                                                     sas: "123456", codecs: codecs),
                               transport: transport, scheduler: FakeLinkScheduler(),
                               producerFactory: { _ in gate },
                               destinationFactory: { _, _ in FakeDestination() },
                               ackInterval: 1,
                               onTextFrame: { _ in },
                               onEvent: { lock.lock(); events.append($0); lock.unlock() })

        let id = try d.enqueue(files: [meta("a.bin", body.count)], stage: { [] })
        d.pump()
        d.settle()
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        // Every frame of the manifest is out, and the loop has NOT yet reported
        // that it is finished: exactly the window the race lives in.
        XCTAssertTrue(gate.waitUntilAtEnd(), "the producer reached the end of its batch")

        transport.deliver(.file, [RealtimeControl.complete.rawValue])
        gate.finishProducing()
        d.settle()

        lock.lock(); let seen = events; lock.unlock()
        XCTAssertTrue(seen.contains(.outboundFinished(batch: id, ok: true)),
                      "a peer that received everything is a completion, however it raced")
        XCTAssertEqual(seen.filter { if case .outboundFinished = $0 { return true } else { return false } }.count,
                       1, "and exactly one result")
        XCTAssertEqual(d.retainedSourceBatches, [])
    }

    /// Every non-terminal retirement family, one after the other on one lane:
    /// a refusal, a local cancel, and a gap that stranded an unanswered batch.
    /// Each releases its sources and reports exactly one result.
    func testEveryRetirementFamilyReportsOnceAndReleasesItsSources() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        var events: [LinkFileDriverEvent] = []
        let d = driver(codecs: codecs, transport: transport, onEvent: { events.append($0) })

        // Refusal before consent.
        let refused = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        d.pump(); d.settle()
        transport.deliver(.file, [RealtimeControl.reject.rawValue])
        d.settle()

        // A local cancel of a batch still waiting for consent.
        let cancelled = try d.enqueue(files: [meta("b.bin", 64)], stage: { [] })
        d.pump(); d.settle()
        d.cancelOutbound()
        d.settle()

        // A queued batch the user dropped before it ever launched.
        let dropped = try d.enqueue(files: [meta("c.bin", 64)], stage: { [] })
        d.cancelQueued(dropped)

        // A gap while a batch is unanswered: pre-consent there is no byte-level
        // contract to resume from, so it is stranded rather than carried over.
        let stranded = try d.enqueue(files: [meta("d.bin", 64)], stage: { [] })
        d.pump(); d.settle()
        d.transportGap()
        d.settle()

        for id in [refused, cancelled, dropped, stranded] {
            XCTAssertTrue(events.contains(.outboundFinished(batch: id, ok: false)),
                          "batch \(id) reported no result")
        }
        XCTAssertEqual(events.filter { if case .outboundFinished = $0 { return true } else { return false } }.count,
                       4, "one result each, and no more")
        XCTAssertEqual(d.retainedSourceBatches, [])
    }

    /// A peer BUSY is not a retirement: the batch goes back to the head of the
    /// queue and keeps its staged sources, so nothing is reported yet.
    func testABusyPeerRequeuesRatherThanRetiring() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        var events: [LinkFileDriverEvent] = []
        let d = driver(codecs: codecs, transport: transport, onEvent: { events.append($0) })

        let id = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        d.pump(); d.settle()
        transport.deliver(.file, [LINK_FILE_BUSY])
        d.settle()

        XCTAssertNil(d.activeOutboundBatch)
        XCTAssertEqual(d.retainedSourceBatches, [id], "the batch will be sent again")
        XCTAssertFalse(events.contains { if case .outboundFinished = $0 { return true } else { return false } },
                       "and a batch that has not ended has no result")
        d.pump(); d.settle()
        XCTAssertEqual(d.activeOutboundBatch, id)
    }

    /// A terminal lane names the work it took with it — and does NOT also report a
    /// per-batch result for it. One loss is one report.
    func testATerminalLaneNamesItsLostWorkInsteadOfReportingResults() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        var events: [LinkFileDriverEvent] = []
        let d = driver(codecs: codecs, transport: transport, onEvent: { events.append($0) })

        let a = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        let b = try d.enqueue(files: [meta("b.bin", 64)], stage: { [] })
        d.pump(); d.settle()

        // Protected content before consent fails the file lane closed.
        for frame in try peer.batchFrames([meta("in.bin", C)]) { transport.deliver(.file, frame) }
        d.settle()
        transport.deliver(.file, try peer.nextChunkFrame([UInt8](repeating: 1, count: 32)))
        d.settle()

        XCTAssertTrue(d.isTerminal)
        XCTAssertTrue(events.contains(.batchesFailed([a, b])))
        XCTAssertFalse(events.contains { if case .outboundFinished = $0 { return true } else { return false } },
                       "a named loss must not also arrive as a result")
        XCTAssertEqual(d.retainedSourceBatches, [])
    }

    // ── 7. a file failure must not kill the text route ──────────────────────

    /// The text lane is independent. After the FILE lane fails, text frames on the
    /// SAME live transport must still reach their route — not because a separate
    /// lane object survived, but because this driver never touched the transport.
    func testTextStillRoutesAfterAFileLaneFailure() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        var text: [[UInt8]] = []
        let d = driver(codecs: codecs, transport: transport, onText: { text.append($0) })

        for frame in try peer.batchFrames([meta("in.bin", C)]) { transport.deliver(.file, frame) }
        d.settle()
        // Protected content before consent fails the file lane closed.
        transport.deliver(.file, try peer.nextChunkFrame([UInt8](repeating: 1, count: 32)))
        d.settle()
        XCTAssertTrue(d.isTerminal, "the file lane really did fail")
        XCTAssertFalse(d.isLinkEnded, "and the link did not")

        let first: [UInt8] = [RealtimeKind.text, 0, 0, 0, 1, 9, 9]
        let second: [UInt8] = [RealtimeKind.text, 0, 0, 0, 2, 8, 8]
        transport.deliver(.text, first)
        transport.deliver(.text, second)
        XCTAssertEqual(text, [first, second],
                       "a file-lane failure must not silence the conversation")

        // A later file frame is dropped rather than routed: the lane is terminal.
        transport.deliver(.file, [LINK_FILE_BATCH_ABORT])
        d.settle()
        XCTAssertEqual(text.count, 2)
    }

    /// The link ending is the OTHER terminal, and it does stop the conversation.
    func testTheLinkEndingStopsTheTextRouteToo() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        var text: [[UInt8]] = []
        let d = driver(codecs: codecs, transport: transport, onText: { text.append($0) })
        d.onEnded(LinkRecoveryError.windowExpired)
        d.settle()
        transport.deliver(.text, [RealtimeKind.text, 0, 0, 0, 1, 9, 9])
        XCTAssertEqual(text, [], "nothing routes once the link itself is over")
        XCTAssertTrue(d.isLinkEnded)
    }

    // ── 8. identity and the ambiguous gap API ───────────────────────────────

    /// A recovery policy is asked about ONE link. Another link's identity must not
    /// suspend this session.
    func testAForeignIdentityDoesNotSuspendThisSession() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        let d = driver(codecs: codecs, transport: transport)
        _ = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        d.pump()
        d.settle()

        let foreign = LinkIdentity(peerId: "someone-else", role: .responder, sas: "999999",
                                   codecs: LinkCodecs(sendKey: [UInt8](repeating: 5, count: 32),
                                                      recvKey: [UInt8](repeating: 6, count: 32)))
        XCTAssertFalse(d.onTransportLost(foreign), "not this link's question")
        XCTAssertEqual(d.activeOutboundBatch != nil, true,
                       "and it must not have suspended this session")
    }

    /// `transportGap()` says the transport is gone. Anything it produces must not
    /// then be written to that transport.
    func testAGapStopsUsingTheOldTransport() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        let d = driver(codecs: codecs, transport: transport)
        _ = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        d.pump()
        d.settle()
        let before = transport.sentCount

        d.transportGap()
        d.settle()
        XCTAssertEqual(transport.sentCount, before,
                       "nothing may be written to a transport the driver has declared gone")

        // And its frames are no longer this link's, either.
        transport.deliver(.file, [LINK_FILE_BATCH_ABORT])
        d.settle()
        XCTAssertFalse(d.isTerminal)
    }

    /// A frame routed as "current" while there is no current transport is dropped
    /// rather than fed into a sequence with no channel under it.
    func testACoordinatorRoutedFrameInAGapIsDropped() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        let d = driver(codecs: codecs, transport: transport)
        d.transportGap()
        for frame in try peer.batchFrames([meta("in.bin", C)]) {
            d.routeCurrentFrame(lane: .file, bytes: frame)
        }
        d.settle()
        XCTAssertNil(d.activeInboundBatch)
        XCTAssertFalse(d.isTerminal)
    }

    // ── 9. a local driver failure must retire the file session ──────────────

    /// A send that failed spent a nonce the peer will never see. That is a
    /// nonce/order failure, so the file session has to be retired with it — not
    /// left apparently live behind a driver-only flag.
    func testALocalSendFailureRetiresTheFileSession() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        let d = driver(codecs: codecs, transport: transport)
        for frame in try peer.batchFrames([meta("in.bin", C)]) { transport.deliver(.file, frame) }
        d.settle()
        XCTAssertNotNil(d.activeInboundBatch)

        transport.failSends(true)
        d.acceptInbound()            // the ACCEPT cannot be written
        d.settle()

        XCTAssertTrue(d.isTerminal)
        XCTAssertNil(d.activeInboundBatch,
                     "the file session must not stay live after a nonce-order failure")
        XCTAssertThrowsError(try d.enqueue(files: [meta("later.bin", 8)], stage: { [] }),
                             "and a retired session takes no new work")
    }

    // ── 10. progress must be cumulative over the manifest ───────────────────

    /// Inbound progress that resets at every file boundary is not progress.
    func testInboundProgressIsCumulativeAcrossFiles() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        var seen: [Int] = []
        let d = driver(codecs: codecs, transport: transport, onEvent: { event in
            if case let .inboundProgress(_, bytes) = event { seen.append(bytes) }
        })

        let one = WireVectors.content(C, seed: 71)
        let two = WireVectors.content(C, seed: 72)
        let files = [meta("one.bin", one.count), meta("two.bin", two.count)]
        for frame in try peer.batchFrames(files) { transport.deliver(.file, frame) }
        d.settle()
        d.acceptInbound()
        d.settle()
        for frame in try peer.dataFrames([(files[0], one), (files[1], two)]) {
            transport.deliver(.file, frame)
            d.settle()
        }

        XCTAssertEqual(seen, seen.sorted(), "progress only ever moves forward")
        XCTAssertEqual(seen.last, one.count + two.count,
                       "and it counts the whole manifest, not the current file")
    }

    /// Outbound progress across a REAL resume, from a point BEHIND what this side
    /// already produced.
    ///
    /// That is the case that separates the two plausible sources. The lane's send
    /// window is batch-cumulative as well, so on an ordinary resume it agrees — but
    /// a resumed attempt rebases it to whatever the receiver still has, and a
    /// receiver whose durable prefix died with the transport asks from zero. The
    /// manifest position is a high-water mark and does not move with it.
    ///
    /// The check is made against the UNCLAMPED value, because the monotonic clamp
    /// on the events would otherwise hide exactly the rewind this is about.
    func testOutboundProgressIsCumulativeAcrossAResumedAttempt() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x91, count: 32),
                                recvKey: [UInt8](repeating: 0x92, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: codecs)
        let transport = FakeLinkTransport()
        let first = WireVectors.content(C, seed: 81)
        let second = WireVectors.content(C, seed: 82)
        let file = meta("a.bin", 3 * C)
        let resumed = GatedProducer(sender: codecs.fileSender)
        var seen: [Int] = []
        let lock = NSLock()
        let d = LinkFileDriver(
            identity: identity, transport: transport, scheduler: FakeLinkScheduler(),
            producerFactory: { request in
                // A resumed attempt gets PRISTINE sources from its resume point;
                // this one parks on its first frame so the manifest position can
                // be read at the exact moment the window has been rebased.
                guard request.resume == nil else { return resumed }
                return ResumeScriptedProducer(sender: request.sender, bodies: [first, second])
            },
            destinationFactory: { _, _ in FakeDestination() },
            ackInterval: 1,
            onTextFrame: { _ in },
            onEvent: { event in
                guard case let .outboundProgress(_, bytes) = event else { return }
                lock.lock(); seen.append(bytes); lock.unlock()
            })

        _ = try d.enqueue(files: [file], stage: { [] })
        d.pump()
        d.settle()
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        d.settle()
        lock.lock(); let afterFirst = seen; lock.unlock()
        XCTAssertEqual(afterFirst, [C, 2 * C], "two chunks of the manifest are done")
        XCTAssertEqual(d.outboundManifestBytes, 2 * C)

        // The transport dies. The receiver had nothing durable, so its request
        // names the origin — and the resumed attempt's own byte cursor rebases to
        // zero with it.
        let replacement = FakeLinkTransport()
        _ = d.onTransportLost(identity)
        try d.onAttach(identity, replacement)
        d.settle()
        d.routeCurrentFrame(lane: .file, bytes: resumeReqFrame(index: 0, offset: 0))

        XCTAssertTrue(resumed.waitUntilPulling(), "the resumed attempt started")
        XCTAssertTrue(replacement.sent.contains { $0.first == RealtimeKind.resumeStart },
                      "and announced itself before producing anything")
        XCTAssertEqual(d.outboundManifestBytes, 2 * C,
                       "the manifest position is a high-water mark, not the attempt's cursor")

        resumed.releaseOneSealedFrame()
        d.settle()
        lock.lock(); let all = seen; lock.unlock()
        XCTAssertEqual(all, all.sorted(), "and what reaches the owner only moves forward")
        XCTAssertEqual(all.last, 2 * C)
    }

    // ── 11. the one-link-lifetime codecs invariant ──────────────────────────

    /// A session built from different codecs than the identity would run a second
    /// AEAD sequence under the same keys. There is no initializer that can express
    /// it: the session is built HERE, from `identity.codecs`, and a driver's
    /// receiver is therefore always the one its identity authenticated.
    func testTheDriverAlwaysUsesTheIdentitysOwnCodecs() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        let d = driver(codecs: codecs, transport: transport)
        let manifest = try peer.batchFrames([meta("in.bin", C)])
        for frame in manifest { transport.deliver(.file, frame) }
        d.settle()
        XCTAssertNotNil(d.activeInboundBatch,
                        "the driver must decrypt with the identity's own receiver")
        XCTAssertFalse(d.isTerminal)

        // The same frames, against a driver whose IDENTITY is a different
        // authentication: it can only fail closed, because it has no other
        // receiver to reach for.
        let foreign = LinkCodecs(sendKey: [UInt8](repeating: 0x77, count: 32),
                                 recvKey: [UInt8](repeating: 0x88, count: 32))
        let other = FakeLinkTransport()
        let stranger = driver(codecs: foreign, transport: other)
        for frame in manifest { other.deliver(.file, frame) }
        stranger.settle()
        XCTAssertNil(stranger.activeInboundBatch)
        XCTAssertTrue(stranger.isTerminal)
    }

    // ── 12. owner callbacks must not run under the driver lock ──────────────

    /// An owner callback is arbitrary code. Delivering it under the driver's lock
    /// means any thread it touches that re-enters this driver blocks on it — the
    /// first half of an inversion.
    func testOwnerCallbacksAreNotDeliveredUnderTheDriverLock() throws {
        let (codecs, peer) = codecPair()
        let transport = FakeLinkTransport()
        let reentered = expectation(description: "another thread entered the driver")
        var d: LinkFileDriver?
        d = driver(codecs: codecs, transport: transport, onEvent: { _ in
            let probe = DispatchQueue.global()
            let done = DispatchSemaphore(value: 0)
            probe.async {
                _ = d?.isTerminal      // must not block on the callback's own lock
                done.signal()
            }
            if done.wait(timeout: .now() + 1.0) == .success { reentered.fulfill() }
        })
        let driver = try XCTUnwrap(d)

        for frame in try peer.batchFrames([meta("in.bin", C)]) { transport.deliver(.file, frame) }
        driver.settle()
        wait(for: [reentered], timeout: 3.0)
    }

    /// Callback ORDER survives the hand-off.
    ///
    /// Four threads drive the same driver at once. Delivery is single-consumer, so
    /// a notice one thread queued may be delivered by another — but never out of
    /// order and never twice. Each frame carries its producer and its sequence, so
    /// a reordered hand-off is visible rather than hidden behind a total count.
    func testCallbacksKeepTheirOrderAcrossThreads() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        let text = LinkFileDriverTests.Text()
        let d = driver(codecs: codecs, transport: transport, onText: { text.append($0) })

        let threads = 4, each = 50
        let group = DispatchGroup()
        for thread in 0..<threads {
            DispatchQueue.global().async(group: group) {
                for i in 0..<each {
                    transport.deliver(.text, [RealtimeKind.text, UInt8(thread), UInt8(i)])
                }
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 10.0), .success)
        d.settle()

        let all = text.all
        XCTAssertEqual(all.count, threads * each, "every frame reached the route exactly once")
        for thread in 0..<threads {
            let mine = all.filter { $0.count == 3 && $0[1] == UInt8(thread) }.map { Int($0[2]) }
            XCTAssertEqual(mine, Array(0..<each),
                           "thread \(thread)'s frames arrived in its own order, none lost")
        }
    }

    // ── 13. cancelling a queued batch may only touch a QUEUED batch ─────────

    /// `cancelQueued` names the queue, and the session honours that: the ACTIVE
    /// batch stays exactly where it is. A driver that retired it anyway would drop
    /// the staged sources of a live transfer and report a result for a batch the
    /// session is still sending — after which the batch can neither resume nor
    /// report its real outcome.
    func testCancellingTheActiveBatchIsInert() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        let body = [UInt8](repeating: 3, count: 64)
        let producer = ResumeScriptedProducer(
            sender: codecs.fileSender, bodies: [body],
            doneHash: chainHash([UInt8](repeating: 0, count: 32), body))
        let events = LinkFileDriverTests.Events()
        let d = driver(codecs: codecs, transport: transport, producer: producer,
                       onEvent: { events.append($0) })

        let id = try d.enqueue(files: [meta("a.bin", body.count)], stage: { [] })
        d.pump(); d.settle()
        XCTAssertEqual(d.activeOutboundBatch, id, "the batch left the queue for the lane")

        d.cancelQueued(id)
        d.settle()
        XCTAssertEqual(d.activeOutboundBatch, id, "the active batch is not the queue's to drop")
        XCTAssertEqual(d.retainedSourceBatches, [id], "and it still owns its staged sources")
        XCTAssertFalse(events.all.contains { if case .outboundFinished = $0 { return true } else { return false } },
                       "a batch that is still on the lane has no result yet")

        // And it really is still usable: the peer consents and the transfer runs
        // to a genuine completion.
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        d.settle()
        transport.deliver(.file, [RealtimeControl.complete.rawValue])
        d.settle()
        XCTAssertTrue(events.all.contains(.outboundFinished(batch: id, ok: true)),
                      "the live batch completed after the inert cancel")
        XCTAssertEqual(events.all.filter { if case .outboundFinished = $0 { return true } else { return false } }.count,
                       1, "and reported exactly one result")
        XCTAssertEqual(d.retainedSourceBatches, [])
    }

    /// An identifier this driver has never issued names nothing, so it retires
    /// nothing and reports nothing.
    func testCancellingAnUnknownBatchReportsNothing() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        let events = LinkFileDriverTests.Events()
        let d = driver(codecs: codecs, transport: transport, onEvent: { events.append($0) })

        let live = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        d.cancelQueued(live + 9_999)
        d.settle()

        XCTAssertEqual(events.all, [], "an unknown identifier is not a result")
        XCTAssertEqual(d.retainedSourceBatches, [live], "and it took nothing else with it")
    }

    /// The case the call really is for: a batch that is still queued retires once,
    /// as a failure, and a second cancel of the same identifier adds nothing.
    func testCancellingAQueuedBatchReportsExactlyOneFalseResult() throws {
        let (codecs, _) = codecPair()
        let transport = FakeLinkTransport()
        let events = LinkFileDriverTests.Events()
        let d = driver(codecs: codecs, transport: transport, onEvent: { events.append($0) })

        let active = try d.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        d.pump(); d.settle()
        let queued = try d.enqueue(files: [meta("b.bin", 64)], stage: { [] })

        d.cancelQueued(queued)
        d.cancelQueued(queued)
        d.settle()

        XCTAssertEqual(events.all.filter { if case .outboundFinished = $0 { return true } else { return false } },
                       [.outboundFinished(batch: queued, ok: false)],
                       "one cancel, one result, however many times it is asked for")
        XCTAssertEqual(d.retainedSourceBatches, [active],
                       "the queued batch's sources went; the active one's stayed")
        XCTAssertEqual(d.activeOutboundBatch, active)
    }

    // ── 14. a bound driver's lifetime is the coordinator's ──────────────────

    /// The attach barrier only means something if there is an owner behind it.
    ///
    /// Hooks that hold their driver weakly make `try self?.onAttach(…)` SUCCEED
    /// when the driver is gone: the coordinator then passes its non-nil `onFrame`
    /// guard, publishes the replacement, and replays the captured backlog into a
    /// closure whose target is nil. Those frames belong to receiver codecs whose
    /// sequence has to stay continuous, so dropping them silently is precisely the
    /// missing-owner failure the barrier exists to prevent.
    ///
    /// `bind` therefore makes the coordinator the driver's owner. The driver holds
    /// no reference to the coordinator, so this is an owner relationship and not a
    /// cycle — and the last assertion here is what proves it.
    func testABoundDriverSurvivesItsExternalOwnerAndDiesWithTheCoordinator() throws {
        let (codecs, peer) = codecPair()
        let initial = FakeLinkTransport()
        let replacement = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        var coordinator: LinkRecoveryCoordinator? = LinkRecoveryCoordinator(
            identity: identity(codecs), current: initial,
            factory: { _ in replacement }, scheduler: scheduler)
        let events = LinkFileDriverTests.Events()

        weak var bound: LinkFileDriver?
        var inbound = -1
        do {
            let d = driver(codecs: codecs, transport: initial, scheduler: scheduler,
                           onEvent: { events.append($0) })
            // The text lane holds the link open, so a file lane that had vanished
            // would still be asked to attach — the exact hole.
            try d.bind(to: try XCTUnwrap(coordinator),
                       otherLanesNeedRecovery: { _ in true },
                       otherLanesEnded: { _ in })
            for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { initial.deliver(.file, frame) }
            d.settle()
            d.acceptInbound()
            d.settle()
            inbound = try XCTUnwrap(d.activeInboundBatch)
            bound = d
        }
        XCTAssertNotNil(bound, "a coordinator's hooks may not point at a driver nobody owns")

        coordinator?.transportTerminated(initial, error: nil)
        XCTAssertEqual(coordinator?.phase, .interrupted)

        replacement.capture(.file, [LINK_FILE_BUSY])
        replacement.publish(identity(codecs))
        bound?.settle()
        XCTAssertEqual(coordinator?.phase, .open, "the attach really took the lanes over")
        XCTAssertTrue(replacement.sent.contains { $0.first == RealtimeKind.resumeReq },
                      "and it was a live driver's resume request, not a nil hook's success")

        // Routing still reaches the driver after the external reference is gone.
        replacement.deliver(.file, [LINK_FILE_BATCH_ABORT])
        bound?.settle()
        XCTAssertNil(bound?.activeInboundBatch, "the ordered barrier reached the session")
        XCTAssertTrue(events.all.contains(.inboundFinished(batch: inbound, ok: false)),
                      "and its result reached an owner that is still alive")

        // The owner relationship ends with the coordinator, so nothing leaks.
        coordinator = nil
        XCTAssertNil(bound, "and the driver goes when its owner does")
    }
}
