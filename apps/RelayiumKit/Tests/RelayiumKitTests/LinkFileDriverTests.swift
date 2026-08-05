import XCTest
@testable import RelayiumKit

// MARK: - deterministic fakes

/// A transport that satisfies BOTH the coordinator's replacement protocol and the
/// driver's live-lane seam, with no WebRTC anywhere.
///
/// The four callback slots are synchronized exactly as `LinkReplacementTransport`
/// requires: the driver installs the initial route from `init` while a test may be
/// reading it from another thread, and the coordinator installs a replacement's
/// from whichever thread reported the rebuild.
final class FakeLinkTransport: LinkReplacementTransport, LinkLiveTransport, @unchecked Sendable {
    private let slots = NSLock()
    private let state = NSLock()

    private var _onReady: ((LinkIdentity) -> Void)?
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    private var _onError: ((Error) -> Void)?
    private var _onClose: (() -> Void)?

    var onReady: ((LinkIdentity) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onReady }
        set { slots.lock(); defer { slots.unlock() }; _onReady = newValue }
    }
    var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onFrame }
        set { slots.lock(); defer { slots.unlock() }; _onFrame = newValue }
    }
    var onError: ((Error) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onError }
        set { slots.lock(); defer { slots.unlock() }; _onError = newValue }
    }
    var onClose: (() -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onClose }
        set { slots.lock(); defer { slots.unlock() }; _onClose = newValue }
    }

    private var _sent: [(lane: LinkLane, bytes: [UInt8])] = []
    private var _buffered: UInt64 = 0
    private var _closed = false
    private var _failSend = false
    private var _captured: [(LinkLane, [UInt8])] = []
    private var _sentWhenReplayed: Int?

    var sent: [[UInt8]] {
        state.lock(); defer { state.unlock() }
        return _sent.filter { $0.lane == .file }.map(\.bytes)
    }
    var sentCount: Int { state.lock(); defer { state.unlock() }; return _sent.count }
    var closedCount: Int { state.lock(); defer { state.unlock() }; return _closed ? 1 : 0 }
    /// How many FILE frames this transport had already sent at the moment it
    /// replayed the first captured frame. The attach barrier's whole contract in
    /// one number.
    var sentWhenReplayed: Int? { state.lock(); defer { state.unlock() }; return _sentWhenReplayed }

    func setBuffered(_ value: UInt64) { state.lock(); _buffered = value; state.unlock() }
    func failSends(_ on: Bool) { state.lock(); _failSend = on; state.unlock() }

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        state.lock()
        let fail = _failSend
        let closed = _closed
        if !fail && !closed { _sent.append((lane, bytes)) }
        state.unlock()
        if closed { throw LinkTransportError.closed }
        if fail { throw LinkTransportError.closed }
    }

    func bufferedAmount(on lane: LinkLane) -> UInt64 {
        state.lock(); defer { state.unlock() }; return _buffered
    }

    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }
    func close() { state.lock(); _closed = true; state.unlock() }
    func start() {}
    func receive(from: String, signal: JSONValue) {}

    /// Deliver one frame the way a live transport would.
    func deliver(_ lane: LinkLane, _ bytes: [UInt8]) { onFrame?(lane, bytes) }

    /// A frame the peer sent before this transport had a consumer. The real one
    /// holds these until publication.
    func capture(_ lane: LinkLane, _ bytes: [UInt8]) {
        state.lock(); _captured.append((lane, bytes)); state.unlock()
    }

    /// Publish, then replay the captured backlog with NOTHING in between — which
    /// is exactly what makes `onAttach` a synchronous barrier rather than a hook.
    func publish(_ identity: LinkIdentity) {
        onReady?(identity)
        state.lock()
        let backlog = _captured
        _captured = []
        _sentWhenReplayed = _sent.filter { $0.lane == .file }.count
        state.unlock()
        for (lane, bytes) in backlog { onFrame?(lane, bytes) }
    }
}

/// A scheduler whose wake-ups only happen when a test says so.
final class FakeLinkScheduler: LinkRecoveryScheduler, @unchecked Sendable {
    final class Handle: LinkRecoveryTimer {
        var cancelled = false
        let body: () -> Void
        init(_ body: @escaping () -> Void) { self.body = body }
        func cancel() { cancelled = true }
    }

    private let lock = NSLock()
    private var handles: [Handle] = []

    func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
        let handle = Handle(body)
        lock.lock(); handles.append(handle); lock.unlock()
        return handle
    }

    /// Fire every wake-up that is still live, oldest first.
    func fireAll() {
        lock.lock()
        let live = handles.filter { !$0.cancelled }
        handles.removeAll { !$0.cancelled }
        lock.unlock()
        for handle in live { handle.body() }
    }

    /// Fire ONLY the cancelled wake-ups: a real timer that had already started
    /// running when its handle was cancelled. Firing the live ones too would
    /// retire the later batch legitimately and prove nothing about staleness.
    func fireCancelledOnly() {
        lock.lock()
        let dead = handles.filter { $0.cancelled }
        handles.removeAll { $0.cancelled }
        lock.unlock()
        for handle in dead { handle.body() }
    }

    var liveCount: Int { lock.lock(); defer { lock.unlock() }; return handles.filter { !$0.cancelled }.count }
}

final class FakeProducer: LinkFileProducing, @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [[UInt8]]
    private var failAfter: Int?
    private var delivered = 0

    init(frames: [[UInt8]], failAfter: Int? = nil) {
        self.frames = frames
        self.failAfter = failAfter
    }

    func next() throws -> [UInt8]? {
        lock.lock(); defer { lock.unlock() }
        if let failAfter, delivered >= failAfter { throw LinkFileSessionError.laneFailed }
        guard delivered < frames.count else { return nil }
        defer { delivered += 1 }
        return frames[delivered]
    }
}

final class FakeDestination: LinkFileDestination, @unchecked Sendable {
    enum Failure { case none, write, openNext, finalize }

    private let lock = NSLock()
    private var _written: [UInt8] = []
    private var _opened: [Int] = []
    private var _finalized = false
    private var _aborted = false
    let failure: Failure

    init(failure: Failure = .none) { self.failure = failure }

    var written: [UInt8] { lock.lock(); defer { lock.unlock() }; return _written }
    var opened: [Int] { lock.lock(); defer { lock.unlock() }; return _opened }
    var finalized: Bool { lock.lock(); defer { lock.unlock() }; return _finalized }
    var aborted: Bool { lock.lock(); defer { lock.unlock() }; return _aborted }

    func write(_ bytes: [UInt8]) throws {
        if failure == .write { throw LinkFileSessionError.laneFailed }
        lock.lock(); _written += bytes; lock.unlock()
    }
    func openNextFile(index: Int) throws {
        if failure == .openNext { throw LinkFileSessionError.laneFailed }
        lock.lock(); _opened.append(index); lock.unlock()
    }
    func finalize() throws {
        if failure == .finalize { throw LinkFileSessionError.laneFailed }
        lock.lock(); _finalized = true; lock.unlock()
    }
    func abort() { lock.lock(); _aborted = true; lock.unlock() }
}

// MARK: - tests

/// The disabled reusable file-session driver: one lock that nothing blocking runs
/// under, ordered emissions, two independent executors, and every asynchronous
/// completion correlated.
final class LinkFileDriverTests: XCTestCase {

    private let C = CHUNK_SIZE

    private func meta(_ name: String, _ size: Int) -> FileMeta { FileMeta(name: name, size: size) }

    /// A driver, the transport under it, and the peer that talks to it. The peer
    /// seals with the driver's RECEIVE key, so its frames really decrypt.
    private func harness(destination: FakeDestination = FakeDestination(),
                         producer: FakeProducer? = nil)
    -> (driver: LinkFileDriver, transport: FakeLinkTransport, peer: RealtimeSender,
        codecs: LinkCodecs, scheduler: FakeLinkScheduler, destination: FakeDestination,
        events: Events, text: Text) {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x11, count: 32),
                                recvKey: [UInt8](repeating: 0x22, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: codecs)
        let transport = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        let events = Events()
        let text = Text()
        let driver = LinkFileDriver(
            identity: identity,
            transport: transport,
            scheduler: scheduler,
            producerFactory: { _ in producer ?? FakeProducer(frames: []) },
            destinationFactory: { _, _ in destination },
            ackInterval: 1,
            onTextFrame: { text.append($0) },
            onEvent: { events.append($0) })
        return (driver, transport, RealtimeSender(sessionKey: [UInt8](repeating: 0x22, count: 32)),
                codecs, scheduler, destination, events, text)
    }

    final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [LinkFileDriverEvent] = []
        func append(_ event: LinkFileDriverEvent) { lock.lock(); items.append(event); lock.unlock() }
        var all: [LinkFileDriverEvent] { lock.lock(); defer { lock.unlock() }; return items }
        var failures: [LinkFileDriverError] {
            all.compactMap { if case let .failed(e) = $0 { return e } else { return nil } }
        }
    }

    final class Text: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [[UInt8]] = []
        func append(_ frame: [UInt8]) { lock.lock(); items.append(frame); lock.unlock() }
        var all: [[UInt8]] { lock.lock(); defer { lock.unlock() }; return items }
    }

    // ── routing ─────────────────────────────────────────────────────────────

    /// File frames reach the file session; text frames reach the independent text
    /// route and are never interpreted, counted or dropped by the file owner.
    func testFileAndTextFramesTakeIndependentRoutes() throws {
        let h = harness()
        let files = [meta("in.bin", C)]
        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.driver.settle()

        let batch = try XCTUnwrap(h.driver.activeInboundBatch, "the manifest reached the file session")
        XCTAssertTrue(h.events.all.contains(.inboundOffer(batch: batch, files: files)),
                      "and a consent prompt is surfaced with the manifest as sent")

        let textFrame: [UInt8] = [RealtimeKind.text, 0, 0, 0, 1, 2, 3]
        h.transport.deliver(.text, textFrame)
        XCTAssertEqual(h.text.all, [textFrame], "text goes out whole, to its own route")
        XCTAssertFalse(h.driver.isTerminal, "and the file owner never saw it")
    }

    // ── replacement attachment ──────────────────────────────────────────────

    /// `onAttach` is a synchronous publication barrier: the resume request has to
    /// be on the wire before it returns, because the replacement replays its
    /// captured backlog the instant it does.
    ///
    /// And the replacement's own route is NOT the driver's to install: that slot
    /// belongs to `LinkRecoveryCoordinator`, which is what drops a stale
    /// transport's frames.
    func testAttachAsksToResumeBeforeItReturnsAndLeavesTheRouteAlone() throws {
        let h = harness()
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: h.codecs)
        // A consented inbound batch, so the replacement owes a RESUME_REQ.
        for frame in try h.peer.batchFrames([meta("in.bin", 2 * C)]) { h.transport.deliver(.file, frame) }
        h.driver.settle()
        h.driver.acceptInbound()
        h.driver.settle()
        _ = h.driver.onTransportLost(identity)

        let replacement = FakeLinkTransport()
        try h.driver.onAttach(identity, replacement)

        XCTAssertTrue(replacement.sent.contains { $0.first == RealtimeKind.resumeReq },
                      "the request is already on the wire")
        XCTAssertNil(replacement.onFrame,
                     "and the frame slot is the coordinator's, untouched by the driver")
    }

    func testAttachRefusesAnIdentityThatIsNotThisLinks() throws {
        let h = harness()
        let other = LinkCodecs(sendKey: [UInt8](repeating: 9, count: 32),
                               recvKey: [UInt8](repeating: 8, count: 32))
        _ = h.driver.onTransportLost(LinkIdentity(peerId: "peer", role: .initiator,
                                                  sas: "123456", codecs: h.codecs))
        XCTAssertThrowsError(try h.driver.onAttach(
            LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: other),
            FakeLinkTransport())) {
            XCTAssertEqual($0 as? LinkFileDriverError, .identityMismatch)
        }
    }

    /// The coordinator's own protocol deliberately cannot send. A replacement that
    /// is only that is refused at the driver's boundary rather than adopted.
    func testAttachRefusesATransportThatCannotCarryALane() throws {
        final class HandleOnly: LinkReplacementTransport, @unchecked Sendable {
            var onReady: ((LinkIdentity) -> Void)?
            var onFrame: ((LinkLane, [UInt8]) -> Void)?
            var onError: ((Error) -> Void)?
            var onClose: (() -> Void)?
            func start() {}
            func receive(from: String, signal: JSONValue) {}
            func close() {}
        }
        let h = harness()
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: h.codecs)
        _ = h.driver.onTransportLost(identity)
        XCTAssertThrowsError(try h.driver.onAttach(identity, HandleOnly())) {
            XCTAssertEqual($0 as? LinkFileDriverError, .replacementNotLive)
        }
    }

    /// Recovery across an OUTSTANDING write: the request may not name a prefix the
    /// disk has not confirmed, so it waits for the write and goes out with it.
    func testRecoveryWhileAWriteIsOutstandingAsksOnlyAfterItLands() throws {
        let h = harness()
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: h.codecs)
        for frame in try h.peer.batchFrames([meta("in.bin", 2 * C)]) { h.transport.deliver(.file, frame) }
        h.driver.settle()
        h.driver.acceptInbound()
        h.driver.settle()
        h.transport.deliver(.file, try h.peer.nextChunkFrame([UInt8](repeating: 5, count: C)))
        h.driver.settle()

        _ = h.driver.onTransportLost(identity)
        let replacement = FakeLinkTransport()
        try h.driver.onAttach(identity, replacement)
        h.driver.settle()

        let request = replacement.sent.first { $0.first == RealtimeKind.resumeReq }
        XCTAssertEqual(request.flatMap(parseResumeReq), ResumePoint(index: 0, offset: C),
                       "it names exactly what reached the disk")
        XCTAssertEqual(h.destination.written.count, C)
    }

    // ── the effect executor ─────────────────────────────────────────────────

    /// A frame the session produced that cannot be put on the wire has spent a
    /// nonce the peer will never see.
    func testASendFailureIsNotSilent() throws {
        let h = harness()
        h.transport.failSends(true)
        _ = try h.driver.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        h.driver.pump()
        h.driver.settle()

        XCTAssertTrue(h.driver.isTerminal)
        XCTAssertEqual(h.events.failures, [.sendFailed])
    }

    /// While a destination operation is outstanding nothing further is admitted —
    /// and what waits is bounded, because the peer chooses how fast it sends.
    func testTheInboundBufferIsBoundedWhileAWriteIsOutstanding() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x11, count: 32),
                                recvKey: [UInt8](repeating: 0x22, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: codecs)
        let transport = FakeLinkTransport()
        let events = Events()
        // The FACTORY blocks, which is what makes the outstanding-operation window
        // deterministic: the slot's operation is set before the dispatch and
        // cannot clear until this returns, whatever the scheduler does. Bounded,
        // so a driver that never reaches it fails rather than wedging the suite.
        let opened = DispatchSemaphore(value: 0)
        let created = FakeDestination()
        let driver = LinkFileDriver(identity: identity, transport: transport,
                                    scheduler: FakeLinkScheduler(),
                                    producerFactory: { _ in FakeProducer(frames: []) },
                                    destinationFactory: { _, _ in
                                        _ = opened.wait(timeout: .now() + 10.0)
                                        return created
                                    },
                                    ackInterval: 1,
                                    maxBufferedInboundFrames: 2,
                                    onTextFrame: { _ in },
                                    onEvent: { events.append($0) })
        let peer = RealtimeSender(sessionKey: [UInt8](repeating: 0x22, count: 32))

        for frame in try peer.batchFrames([meta("in.bin", 4 * C)]) { transport.deliver(.file, frame) }
        driver.settle()
        driver.acceptInbound()   // the create is now outstanding and stays that way

        for _ in 0..<4 { transport.deliver(.file, [LINK_FILE_BUSY]) }
        XCTAssertTrue(driver.isTerminal, "more than the bound was held while the write was out")
        XCTAssertEqual(events.failures, [.inboundBufferOverflow])
        opened.signal()
        driver.settle()
        XCTAssertTrue(created.aborted,
                      "and the destination that landed for a batch that is gone is let go")
    }

    /// The FIFO itself: protected frames reach the destination in wire order, one
    /// outstanding write at a time.
    func testProtectedFramesArePersistedInWireOrder() throws {
        let h = harness()
        let first = WireVectors.content(C, seed: 41)
        let second = WireVectors.content(C, seed: 42)
        let file = meta("in.bin", 2 * C)
        for frame in try h.peer.batchFrames([file]) { h.transport.deliver(.file, frame) }
        h.driver.settle()
        h.driver.acceptInbound()
        h.driver.settle()

        h.transport.deliver(.file, try h.peer.nextChunkFrame(first))
        h.transport.deliver(.file, try h.peer.nextChunkFrame(second))
        h.driver.settle()

        XCTAssertEqual(h.destination.written, first + second, "byte-exact, in order")
        XCTAssertEqual(h.driver.bufferedInboundFrames, 0, "and the buffer drained")
    }

    // ── stale asynchronous callbacks ────────────────────────────────────────

    /// A timer that fires for work that has moved on must not touch what replaced
    /// it. The handle's TOKEN is its identity, so a stale wake-up finds nothing.
    func testAStaleTimerCallbackCannotRetireALaterBatch() throws {
        let h = harness()
        _ = try h.driver.enqueue(files: [meta("a", 8)], stage: { [] })
        let second = try h.driver.enqueue(files: [meta("b", 8)], stage: { [] })
        h.driver.pump()
        h.driver.settle()
        // The peer refuses the first batch; its consent timer is cancelled.
        h.transport.deliver(.file, [RealtimeControl.reject.rawValue])
        h.driver.settle()
        h.driver.pump()
        h.driver.settle()
        XCTAssertEqual(h.driver.activeOutboundBatch, second)

        // The cancelled timer fires anyway, as a real one that had already started
        // would.
        h.scheduler.fireCancelledOnly()
        h.driver.settle()
        XCTAssertEqual(h.driver.activeOutboundBatch, second, "the later batch is untouched")
        XCTAssertFalse(h.driver.isTerminal)
    }

    // ── producers ───────────────────────────────────────────────────────────

    /// A cancellation crossing a sealed frame: the frame goes out first, and only
    /// then the ordered barrier that retires the batch.
    func testCancellationLetsACrossedSealedFrameOutBeforeTheBarrier() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x31, count: 32),
                                recvKey: [UInt8](repeating: 0x32, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "1", codecs: codecs)
        let transport = FakeLinkTransport()
        let gate = GatedProducer(sender: codecs.fileSender)
        let driver = LinkFileDriver(identity: identity, transport: transport,
                                    scheduler: FakeLinkScheduler(),
                                    producerFactory: { _ in gate },
                                    destinationFactory: { _, _ in FakeDestination() },
                                    ackInterval: 1,
                                    onTextFrame: { _ in }, onEvent: { _ in })

        _ = try driver.enqueue(files: [meta("a.bin", 4 * C)], stage: { [] })
        driver.pump()
        driver.settle()
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        XCTAssertTrue(gate.waitUntilPulling(), "the producer started")

        driver.cancelOutbound()          // stop requested while a frame is sealed
        gate.releaseOneSealedFrame()
        driver.settle()

        let controls = transport.sent.filter { $0.count == 1 }.map { $0[0] }
        XCTAssertEqual(controls.last, LINK_FILE_BATCH_ABORT, "the barrier is last")
        XCTAssertTrue(transport.sent.contains { $0.first == RealtimeKind.chunk },
                      "and the frame that crossed the stop still went out")
        XCTAssertNil(driver.activeOutboundBatch)
    }

    /// A producer that cannot read its source ends the batch, not the lane.
    func testAProducerFailureEndsTheBatchAndLeavesTheLaneUsable() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x41, count: 32),
                                recvKey: [UInt8](repeating: 0x42, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "1", codecs: codecs)
        let transport = FakeLinkTransport()
        let events = Events()
        let driver = LinkFileDriver(identity: identity, transport: transport,
                                    scheduler: FakeLinkScheduler(),
                                    producerFactory: { _ in FakeProducer(frames: [], failAfter: 0) },
                                    destinationFactory: { _, _ in FakeDestination() },
                                    ackInterval: 1,
                                    onTextFrame: { _ in }, onEvent: { events.append($0) })

        let id = try driver.enqueue(files: [meta("a.bin", 64)], stage: { [] })
        driver.pump()
        driver.settle()
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        driver.settle()

        let controls = transport.sent.filter { $0.count == 1 }.map { $0[0] }
        XCTAssertEqual(controls.last, LINK_FILE_BATCH_ABORT)
        XCTAssertNil(driver.activeOutboundBatch)
        XCTAssertFalse(driver.isTerminal, "a source that broke says nothing about the codecs")
        XCTAssertEqual(events.failures, [])
        XCTAssertTrue(events.all.contains(.outboundFinished(batch: id, ok: false)),
                      "and it is still a result")
        XCTAssertEqual(driver.retainedSourceBatches, [])
    }

    /// A staging call that throws is the same family: the attempt never exists,
    /// the batch ends, the lane survives.
    func testAStagingFailureEndsTheBatchAndReleasesItsSources() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x43, count: 32),
                                recvKey: [UInt8](repeating: 0x44, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "1", codecs: codecs)
        let transport = FakeLinkTransport()
        let events = Events()
        let driver = LinkFileDriver(identity: identity, transport: transport,
                                    scheduler: FakeLinkScheduler(),
                                    producerFactory: { _ in FakeProducer(frames: []) },
                                    destinationFactory: { _, _ in FakeDestination() },
                                    ackInterval: 1,
                                    onTextFrame: { _ in }, onEvent: { events.append($0) })

        let id = try driver.enqueue(files: [meta("a.bin", 64)],
                                    stage: { throw LinkFileSessionError.invalidManifest })
        driver.pump()
        driver.settle()
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        driver.settle()

        XCTAssertNil(driver.activeOutboundBatch)
        XCTAssertFalse(driver.isTerminal)
        XCTAssertTrue(events.all.contains(.outboundFinished(batch: id, ok: false)))
        XCTAssertEqual(driver.retainedSourceBatches, [])
    }

    /// Backpressure: a transport whose own buffer is above the high-water mark
    /// parks the pump, and the scheduled wake-up is what resumes it. No spinning,
    /// and no whole transfer materialised.
    func testTheProducerParksOnBufferedAmountAndResumesOnItsWakeUp() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x51, count: 32),
                                recvKey: [UInt8](repeating: 0x52, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "1", codecs: codecs)
        let transport = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        let frames = try (0..<3).map { _ in
            try codecs.fileSender.nextChunkFrame([UInt8](repeating: 1, count: 64))
        }
        let driver = LinkFileDriver(identity: identity, transport: transport,
                                    scheduler: scheduler,
                                    producerFactory: { _ in FakeProducer(frames: frames) },
                                    destinationFactory: { _, _ in FakeDestination() },
                                    ackInterval: 1,
                                    sendBufferHighWater: 10,
                                    onTextFrame: { _ in }, onEvent: { _ in })

        transport.setBuffered(1_000)   // far above the mark
        _ = try driver.enqueue(files: [meta("a.bin", 4 * C)], stage: { [] })
        driver.pump()
        driver.settle()
        let beforeAccept = transport.sent.count
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        driver.settle()
        XCTAssertEqual(transport.sent.count, beforeAccept, "the pump parked instead of sending")
        XCTAssertGreaterThan(scheduler.liveCount, 0, "on a scheduled wake-up, not a spin")

        transport.setBuffered(0)
        scheduler.fireAll()
        driver.settle()
        XCTAssertGreaterThan(transport.sent.count, beforeAccept, "credit restarted it")
    }

    /// A poll wake-up for a producer this driver has already released must not
    /// start a second pump or revive a stopped attempt.
    func testAStalePollWakeUpCannotReviveAReleasedProducer() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x53, count: 32),
                                recvKey: [UInt8](repeating: 0x54, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "1", codecs: codecs)
        let transport = FakeLinkTransport()
        let scheduler = FakeLinkScheduler()
        let frames = try (0..<3).map { _ in
            try codecs.fileSender.nextChunkFrame([UInt8](repeating: 1, count: 64))
        }
        let driver = LinkFileDriver(identity: identity, transport: transport,
                                    scheduler: scheduler,
                                    producerFactory: { _ in FakeProducer(frames: frames) },
                                    destinationFactory: { _, _ in FakeDestination() },
                                    ackInterval: 1,
                                    sendBufferHighWater: 10,
                                    onTextFrame: { _ in }, onEvent: { _ in })

        transport.setBuffered(1_000)
        _ = try driver.enqueue(files: [meta("a.bin", 4 * C)], stage: { [] })
        driver.pump()
        driver.settle()
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        driver.settle()

        // The batch is cancelled while the pump is parked on its poll.
        driver.cancelOutbound()
        driver.settle()
        XCTAssertNil(driver.activeOutboundBatch)
        let after = transport.sent.count

        transport.setBuffered(0)
        scheduler.fireCancelledOnly()   // the released poll fires anyway
        driver.settle()
        XCTAssertEqual(transport.sent.count, after,
                       "a released producer's wake-up produces nothing")
        XCTAssertFalse(driver.isTerminal)
    }

    // ── destinations ────────────────────────────────────────────────────────

    func testADestinationThatCannotBeCreatedRefusesTheBatch() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x61, count: 32),
                                recvKey: [UInt8](repeating: 0x62, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "1", codecs: codecs)
        let transport = FakeLinkTransport()
        let driver = LinkFileDriver(identity: identity, transport: transport,
                                    scheduler: FakeLinkScheduler(),
                                    producerFactory: { _ in FakeProducer(frames: []) },
                                    destinationFactory: { _, _ in throw LinkFileSessionError.laneFailed },
                                    ackInterval: 1,
                                    onTextFrame: { _ in }, onEvent: { _ in })
        let peer = RealtimeSender(sessionKey: [UInt8](repeating: 0x62, count: 32))

        for frame in try peer.batchFrames([meta("in.bin", C)]) { transport.deliver(.file, frame) }
        driver.settle()
        driver.acceptInbound()
        driver.settle()

        let controls = transport.sent.filter { $0.count == 1 }.map { $0[0] }
        XCTAssertEqual(controls, [RealtimeControl.reject.rawValue])
        XCTAssertFalse(driver.isTerminal)
    }

    func testAWriteFailureRefusesTheBatchAndKeepsTheLane() throws {
        let h = harness(destination: FakeDestination(failure: .write))
        for frame in try h.peer.batchFrames([meta("in.bin", 4 * C)]) { h.transport.deliver(.file, frame) }
        h.driver.settle()
        h.driver.acceptInbound()
        h.driver.settle()
        h.transport.deliver(.file, try h.peer.nextChunkFrame([UInt8](repeating: 1, count: C)))
        h.driver.settle()

        let controls = h.transport.sent.filter { $0.count == 1 }.map { $0[0] }
        XCTAssertTrue(controls.contains(RealtimeControl.reject.rawValue))
        XCTAssertFalse(h.driver.isTerminal, "a disk that failed is not a codec that failed")
    }

    func testAFinalisationFailureRefusesTheBatch() throws {
        let h = harness(destination: FakeDestination(failure: .finalize))
        let body = WireVectors.content(40, seed: 51)
        let file = meta("only.bin", body.count)
        for frame in try h.peer.batchFrames([file]) { h.transport.deliver(.file, frame) }
        h.driver.settle()
        h.driver.acceptInbound()
        h.driver.settle()
        for frame in try h.peer.dataFrames([(file, body)]) { h.transport.deliver(.file, frame) }
        h.driver.settle()

        let controls = h.transport.sent.filter { $0.count == 1 }.map { $0[0] }
        XCTAssertTrue(controls.contains(RealtimeControl.reject.rawValue))
        XCTAssertFalse(controls.contains(RealtimeControl.complete.rawValue),
                       "the sender must not be told a batch arrived that was not committed")
        XCTAssertFalse(h.destination.finalized)
        let batch = h.events.all.compactMap { event -> Bool? in
            if case let .inboundFinished(_, ok) = event { return ok } else { return nil }
        }
        XCTAssertEqual(batch, [false], "and it is reported once, as the failure it was")
    }

    /// A finalised destination is the user's file. The barrier that closes a replay
    /// window must never remove it.
    func testAFinalisedDestinationSurvivesALateAbort() throws {
        let h = harness()
        let body = WireVectors.content(40, seed: 52)
        let file = meta("only.bin", body.count)
        for frame in try h.peer.batchFrames([file]) { h.transport.deliver(.file, frame) }
        h.driver.settle()
        h.driver.acceptInbound()
        h.driver.settle()
        for frame in try h.peer.dataFrames([(file, body)]) { h.transport.deliver(.file, frame) }
        h.driver.settle()
        XCTAssertTrue(h.destination.finalized)
        XCTAssertEqual(h.destination.written, body)

        h.transport.deliver(.file, [LINK_FILE_BATCH_ABORT])
        h.driver.settle()
        XCTAssertFalse(h.destination.aborted, "the file is the user's; the barrier only ends the batch")
        XCTAssertTrue(h.events.all.contains(.inboundFinished(batch: 1, ok: true)))
    }

    // ── terminal ────────────────────────────────────────────────────────────

    /// Terminal recovery: the driver releases everything it holds, names the work
    /// that dies with it, and reports once.
    func testTerminalRecoveryCleansUpAndNamesTheLostWork() throws {
        let h = harness()
        let a = try h.driver.enqueue(files: [meta("a", 8)], stage: { [] })
        let b = try h.driver.enqueue(files: [meta("b", 8)], stage: { [] })
        XCTAssertEqual(h.driver.retainedSourceBatches, [a, b])

        h.driver.onEnded(LinkRecoveryError.windowExpired)
        h.driver.settle()

        XCTAssertTrue(h.driver.isTerminal)
        XCTAssertTrue(h.driver.isLinkEnded)
        XCTAssertEqual(h.events.failures, [.linkEnded])
        XCTAssertTrue(h.events.all.contains(.batchesFailed([a, b])),
                      "a UI can retire exactly the work it showed the user")
        XCTAssertEqual(h.driver.retainedSourceBatches, [], "and the sources are released")
        XCTAssertEqual(h.scheduler.liveCount, 0, "with no timer left running")
    }

    /// A batch the peer completed is reported as finished, and its sources are
    /// released with it; one the peer refused is reported as not finished.
    func testOutboundCompletionAndRefusalAreDistinguishedAndReleaseSources() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x71, count: 32),
                                recvKey: [UInt8](repeating: 0x72, count: 32))
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "1", codecs: codecs)
        let transport = FakeLinkTransport()
        let events = Events()
        let body = [UInt8](repeating: 4, count: 40)
        let frames = try [codecs.fileSender.nextChunkFrame(body),
                          codecs.fileSender.nextDoneFrame(
                            hash: chainHash([UInt8](repeating: 0, count: 32), body))]
        let driver = LinkFileDriver(identity: identity, transport: transport,
                                    scheduler: FakeLinkScheduler(),
                                    producerFactory: { _ in FakeProducer(frames: frames) },
                                    destinationFactory: { _, _ in FakeDestination() },
                                    ackInterval: 1,
                                    onTextFrame: { _ in }, onEvent: { events.append($0) })

        let done = try driver.enqueue(files: [meta("a.bin", body.count)], stage: { [] })
        driver.pump()
        driver.settle()
        transport.deliver(.file, [RealtimeControl.accept.rawValue])
        driver.settle()
        transport.deliver(.file, [RealtimeControl.complete.rawValue])
        driver.settle()
        XCTAssertTrue(events.all.contains(.outboundFinished(batch: done, ok: true)))
        XCTAssertEqual(driver.retainedSourceBatches, [], "a finished batch releases its sources")

        let refused = try driver.enqueue(files: [meta("b.bin", 8)], stage: { [] })
        driver.pump()
        driver.settle()
        transport.deliver(.file, [RealtimeControl.reject.rawValue])
        driver.settle()
        XCTAssertTrue(events.all.contains(.outboundFinished(batch: refused, ok: false)),
                      "a refusal is a retirement, not a completion")
    }

    /// Sources are held only while their batch could still be sent.
    func testSourcesAreReleasedWhenTheirBatchIsCancelled() throws {
        let h = harness()
        let id = try h.driver.enqueue(files: [meta("a", 8)], stage: { [] })
        XCTAssertEqual(h.driver.retainedSourceBatches, [id])
        h.driver.cancelQueued(id)
        XCTAssertEqual(h.driver.retainedSourceBatches, [])
        XCTAssertTrue(h.events.all.contains(.outboundFinished(batch: id, ok: false)))
    }

    // ── production wiring ───────────────────────────────────────────────────

    func testBothNativeSupportConstantsStayFalse() {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
    }
}

// MARK: - fakes that need to block
//
// Every gate below is BOUNDED. A driver that never reaches one is a test failure
// to report, not a whole suite parked on a semaphore nobody will signal.

/// A producer a test can hold at the moment it is asked for a frame, so a stop
/// can be made to cross exactly one sealed frame.
final class GatedProducer: LinkFileProducing, @unchecked Sendable {
    private let sender: RealtimeSender
    private let pulling = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var announced = false

    init(sender: RealtimeSender) { self.sender = sender }

    @discardableResult
    func waitUntilPulling(timeout: TimeInterval = 5.0) -> Bool {
        pulling.wait(timeout: .now() + timeout) == .success
    }
    func releaseOneSealedFrame() { release.signal() }

    func next() throws -> [UInt8]? {
        lock.lock()
        let first = !announced
        announced = true
        lock.unlock()
        guard first else { return nil }
        pulling.signal()
        _ = release.wait(timeout: .now() + 10.0)
        // Sealed AFTER the stop was requested: its nonce is spent either way.
        return try sender.nextChunkFrame([UInt8](repeating: 7, count: 64))
    }
}

/// Produces a whole one-file batch and then PARKS at its end, so a peer's
/// COMPLETE can be made to arrive while the producer loop is still unwinding —
/// the exact race `LinkFileSession`'s remembered completion exists for.
final class WholeBatchGatedProducer: LinkFileProducing, @unchecked Sendable {
    private let sender: RealtimeSender
    private let body: [UInt8]
    private let atEnd = DispatchSemaphore(value: 0)
    private let finish = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var step = 0

    init(sender: RealtimeSender, body: [UInt8]) {
        self.sender = sender
        self.body = body
    }

    @discardableResult
    func waitUntilAtEnd(timeout: TimeInterval = 5.0) -> Bool {
        atEnd.wait(timeout: .now() + timeout) == .success
    }
    func finishProducing() { finish.signal() }

    func next() throws -> [UInt8]? {
        lock.lock()
        let n = step
        step += 1
        lock.unlock()
        switch n {
        case 0:
            return try sender.nextChunkFrame(body)
        case 1:
            return try sender.nextDoneFrame(hash: chainHash([UInt8](repeating: 0, count: 32), body))
        default:
            atEnd.signal()
            _ = finish.wait(timeout: .now() + 10.0)
            return nil
        }
    }
}
