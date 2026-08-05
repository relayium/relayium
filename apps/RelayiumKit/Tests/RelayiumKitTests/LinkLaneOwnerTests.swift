import XCTest
@testable import RelayiumKit

// MARK: - deterministic fakes
//
// Private to this file. The owner's question is a different one from either
// driver's: BOTH lanes on ONE transport, one route between them, and a
// replacement that has to reach both. So this fake observes each lane
// separately, counts how many times its `onFrame` slot was claimed, and can
// replay a captured backlog the way `LinkRecoveryCoordinator` publication does.

/// A transport with a genuine serial queue, exactly like the real ones: `send`,
/// `bufferedAmount`, `isClosed` and `close` all enter it SYNCHRONOUSLY.
///
/// That is what makes "the owner held a lock across a transport call" a real
/// deadlock rather than a style opinion.
private final class LaneTransport: LinkReplacementTransport, LinkLiveTransport, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.relayium.test.lane-owner-transport")
    private let key = DispatchSpecificKey<Bool>()
    private let slots = NSLock()
    private let state = NSLock()

    private var _onReady: ((LinkIdentity) -> Void)?
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    private var _onError: ((Error) -> Void)?
    private var _onClose: (() -> Void)?
    /// How many times a NON-NIL route was installed. The owner's first invariant
    /// in one number: exactly one installation, and it is the file driver's.
    private var _frameSlotClaims = 0

    var onReady: ((LinkIdentity) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onReady }
        set { slots.lock(); defer { slots.unlock() }; _onReady = newValue }
    }
    var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onFrame }
        set {
            slots.lock(); defer { slots.unlock() }
            if newValue != nil { _frameSlotClaims += 1 }
            _onFrame = newValue
        }
    }
    var onError: ((Error) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onError }
        set { slots.lock(); defer { slots.unlock() }; _onError = newValue }
    }
    var onClose: (() -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onClose }
        set { slots.lock(); defer { slots.unlock() }; _onClose = newValue }
    }

    var frameSlotClaims: Int { slots.lock(); defer { slots.unlock() }; return _frameSlotClaims }

    private var _sent: [(lane: LinkLane, bytes: [UInt8])] = []
    private var _closed = false
    private var _closeCount = 0
    private var _buffered: UInt64 = 0
    private var _failWhen: ((LinkLane, [UInt8]) -> Bool)?
    private var _captured: [(LinkLane, [UInt8])] = []
    private var _sentWhenReplayed: [(lane: LinkLane, bytes: [UInt8])]?

    init() { queue.setSpecific(key: key, value: true) }

    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: key) == true { return body() }
        return queue.sync { body() }
    }

    // ── configuration ───────────────────────────────────────────────────────

    func setBuffered(_ value: UInt64) { state.lock(); _buffered = value; state.unlock() }

    /// Fail exactly the sends a test names, so ONE lane can be broken while the
    /// other keeps working — which is the whole shape of a lane-local terminal.
    func failSends(where predicate: ((LinkLane, [UInt8]) -> Bool)?) {
        state.lock(); _failWhen = predicate; state.unlock()
    }

    // ── the live-transport seam ─────────────────────────────────────────────

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        var fail = false
        var closed = false
        onQueue {
            state.lock()
            fail = _failWhen?(lane, bytes) ?? false
            closed = _closed
            if !fail && !closed { _sent.append((lane, bytes)) }
            state.unlock()
        }
        if closed || fail { throw LinkTransportError.closed }
    }

    func bufferedAmount(on lane: LinkLane) -> UInt64 {
        onQueue {
            state.lock(); defer { state.unlock() }
            return _closed ? 0 : _buffered
        }
    }

    var isClosed: Bool { onQueue { state.lock(); defer { state.unlock() }; return _closed } }

    func close() {
        onQueue { state.lock(); _closed = true; _buffered = 0; _closeCount += 1; state.unlock() }
    }

    func start() {}
    func receive(from: String, signal: JSONValue) {}

    // ── delivery ────────────────────────────────────────────────────────────

    /// One frame the way a live transport delivers it.
    func deliver(_ lane: LinkLane, _ bytes: [UInt8]) { onFrame?(lane, bytes) }

    /// The same, on the transport's OWN queue — which is where the real ones
    /// publish from, and the only way a lock held across a transport call shows
    /// up as a deadlock instead of as luck.
    func deliverOnQueue(_ lane: LinkLane, _ bytes: [UInt8]) {
        queue.async { [weak self] in self?.onFrame?(lane, bytes) }
    }

    /// A frame the peer sent before this transport had a consumer.
    func capture(_ lane: LinkLane, _ bytes: [UInt8]) {
        state.lock(); _captured.append((lane, bytes)); state.unlock()
    }

    /// Publish, then replay the captured backlog with NOTHING in between —
    /// which is exactly what makes `onAttach` a synchronous barrier.
    func publish(_ identity: LinkIdentity) {
        onReady?(identity)
        state.lock()
        let backlog = _captured
        _captured = []
        _sentWhenReplayed = _sent
        state.unlock()
        for (lane, bytes) in backlog { onFrame?(lane, bytes) }
    }

    // ── observation ─────────────────────────────────────────────────────────

    func sent(on lane: LinkLane) -> [[UInt8]] {
        state.lock(); defer { state.unlock() }
        return _sent.filter { $0.lane == lane }.map(\.bytes)
    }

    func takeSent(on lane: LinkLane) -> [[UInt8]] {
        state.lock(); defer { state.unlock() }
        let taken = _sent.filter { $0.lane == lane }.map(\.bytes)
        _sent.removeAll { $0.lane == lane }
        return taken
    }

    var sentCount: Int { state.lock(); defer { state.unlock() }; return _sent.count }
    var closeCount: Int { state.lock(); defer { state.unlock() }; return _closeCount }

    /// Exactly what a lane had already put on the wire when the first captured
    /// frame replayed. The attach barrier's whole contract: a frame that is not
    /// in here was written AFTER the backlog, whatever the totals say later.
    func sentWhenReplayed(on lane: LinkLane) -> [[UInt8]]? {
        state.lock(); defer { state.unlock() }
        return _sentWhenReplayed?.filter { $0.lane == lane }.map(\.bytes)
    }
}

/// A replacement that is NOT a `LinkLiveTransport`.
///
/// The cheapest way to make an attach throw at the FIRST lane, which is what
/// proves the owner never publishes half a link.
private final class InertReplacement: LinkReplacementTransport, @unchecked Sendable {
    var onReady: ((LinkIdentity) -> Void)?
    var onFrame: ((LinkLane, [UInt8]) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?
    private let lock = NSLock()
    private var _closeCount = 0
    var closeCount: Int { lock.lock(); defer { lock.unlock() }; return _closeCount }
    func start() {}
    func receive(from: String, signal: JSONValue) {}
    func close() { lock.lock(); _closeCount += 1; lock.unlock() }
}

private final class TextRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [LinkTextDriverEvent] = []
    /// Runs on every event, with no lock of this recorder's held, so a test can
    /// make an owner callback re-enter the owner.
    var hook: ((LinkTextDriverEvent) -> Void)?

    func append(_ event: LinkTextDriverEvent) {
        lock.lock(); items.append(event); lock.unlock()
        hook?(event)
    }

    var all: [LinkTextDriverEvent] { lock.lock(); defer { lock.unlock() }; return items }
    var statuses: [LinkTextStatus] {
        all.compactMap { if case let .status(s) = $0 { return s } else { return nil } }
    }
    var received: [String] {
        all.compactMap { if case let .received(body) = $0 { return body } else { return nil } }
    }
    var failures: [LinkTextDriverError] {
        all.compactMap { if case let .failed(error) = $0 { return error } else { return nil } }
    }
}

private final class FileRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [LinkFileDriverEvent] = []
    var hook: ((LinkFileDriverEvent) -> Void)?

    func append(_ event: LinkFileDriverEvent) {
        lock.lock(); items.append(event); lock.unlock()
        hook?(event)
    }

    var all: [LinkFileDriverEvent] { lock.lock(); defer { lock.unlock() }; return items }
    var failures: [LinkFileDriverError] {
        all.compactMap { if case let .failed(error) = $0 { return error } else { return nil } }
    }
}

/// One error an escaping callback recorded, without a captured `var` two
/// threads could write.
private final class ErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _error: Error?
    func set(_ error: Error) { lock.lock(); _error = error; lock.unlock() }
    var error: Error? { lock.lock(); defer { lock.unlock() }; return _error }
}

/// The transport a link was on before the gap, for a coordinator that only ever
/// needs to close it.
private final class ClosableHandle: LinkTransportHandle {
    private let lock = NSLock()
    private var _closeCount = 0
    var closeCount: Int { lock.lock(); defer { lock.unlock() }; return _closeCount }
    func close() { lock.lock(); _closeCount += 1; lock.unlock() }
}

// MARK: - tests

/// The disabled combined lane owner: ONE authenticated link, one transport, two
/// drivers, one route between them, and four coordinator hooks installed as one
/// step.
///
/// Everything here is about COMPOSITION. `LinkFileDriverTests`,
/// `LinkFileDriverReviewTests` and `LinkTextDriverTests` already prove each lane
/// on its own; what none of them can prove is that the two together never race
/// for the route, never short-circuit each other's recovery answer, never take
/// each other down, and never leave a coordinator holding half a link.
final class LinkLaneOwnerTests: XCTestCase {

    private let C = CHUNK_SIZE
    private let maxFrame: Double = 65_536
    private let request = LINK_TEXT_REQUEST
    private let ownerSendKey = [UInt8](repeating: 0x11, count: 32)
    private let ownerRecvKey = [UInt8](repeating: 0x22, count: 32)

    private func meta(_ name: String, _ size: Int) -> FileMeta { FileMeta(name: name, size: size) }

    private struct Rig {
        let owner: LinkLaneOwner
        let transport: LaneTransport
        let scheduler: FakeLinkScheduler
        let identity: LinkIdentity
        let codecs: LinkCodecs
        /// Seals FILE frames with the owner's RECEIVE key, so what it produces
        /// really authenticates.
        let peerFiles: RealtimeSender
        let destination: FakeDestination
        let text: TextRecorder
        let files: FileRecorder
    }

    private func rig(destination: FakeDestination = FakeDestination(),
                     producer: FakeProducer? = nil) -> Rig {
        let codecs = LinkCodecs(sendKey: ownerSendKey, recvKey: ownerRecvKey)
        let identity = LinkIdentity(peerId: "peer-b", role: .initiator, sas: "123456",
                                    codecs: codecs)
        let transport = LaneTransport()
        let scheduler = FakeLinkScheduler()
        let text = TextRecorder()
        let files = FileRecorder()
        let owner = LinkLaneOwner(
            identity: identity,
            transport: transport,
            scheduler: scheduler,
            producerFactory: { _ in producer ?? FakeProducer(frames: []) },
            destinationFactory: { _, _ in destination },
            ackInterval: 1,
            maxFrameBytes: maxFrame,
            sendBufferPollInterval: 0.01,
            onTextEvent: { text.append($0) },
            onFileEvent: { files.append($0) })
        return Rig(owner: owner, transport: transport, scheduler: scheduler,
                   identity: identity, codecs: codecs,
                   peerFiles: RealtimeSender(sessionKey: ownerRecvKey),
                   destination: destination, text: text, files: files)
    }

    /// The peer's TEXT lane: mirrored keys, so a frame it seals is one this
    /// owner's link really authenticates. Its own transport is never routed —
    /// the test moves the bytes, which is what keeps the wire visible.
    private struct Peer {
        let driver: LinkTextDriver
        let transport: LaneTransport
        let events: TextRecorder
    }

    private func peer() -> Peer {
        let identity = LinkIdentity(peerId: "peer-a", role: .responder, sas: "123456",
                                    codecs: LinkCodecs(sendKey: ownerRecvKey,
                                                       recvKey: ownerSendKey))
        let transport = LaneTransport()
        let events = TextRecorder()
        let driver = LinkTextDriver(identity: identity, transport: transport,
                                    scheduler: FakeLinkScheduler(), maxFrameBytes: maxFrame,
                                    sendBufferPollInterval: 0.01,
                                    onEvent: { events.append($0) })
        return Peer(driver: driver, transport: transport, events: events)
    }

    /// Everything the owner put on the TEXT lane, into the peer's inbound seam.
    private func pumpToPeer(_ rig: Rig, _ peer: Peer) {
        for frame in rig.transport.takeSent(on: .text) { peer.driver.admitTextFrame(frame) }
    }

    /// Everything the peer produced, back through the owner's REAL route — so
    /// every one of these bytes is demultiplexed by the thing under test.
    private func pumpToOwner(_ peer: Peer, _ rig: Rig) {
        for frame in peer.transport.takeSent(on: .text) { rig.transport.deliver(.text, frame) }
        rig.owner.settle()
    }

    private func openConversation(_ rig: Rig, _ peer: Peer) throws {
        try rig.owner.openTextConversation()
        pumpToPeer(rig, peer)
        try peer.driver.accept()
        pumpToOwner(peer, rig)
    }

    /// An inbound manifest waiting for this user's answer.
    @discardableResult
    private func offerInbound(_ rig: Rig, _ files: [FileMeta]) throws -> Int {
        for frame in try rig.peerFiles.batchFrames(files) { rig.transport.deliver(.file, frame) }
        rig.owner.settle()
        return try XCTUnwrap(rig.owner.activeInboundBatch)
    }

    // ── 1. one transport, one route, two lanes ──────────────────────────────

    /// The composition invariant everything else rests on: the FILE driver's
    /// initializer is the SOLE installation of the initial transport's route,
    /// and the text lane reaches its session through that one route rather than
    /// through a second slot nobody synchronizes.
    func testTheInitialTransportCarriesBothLanesThroughExactlyOneRoute() throws {
        let r = rig()
        XCTAssertEqual(r.transport.frameSlotClaims, 1,
                       "exactly one owner may claim the route slot")
        XCTAssertNotNil(r.transport.onFrame)

        // TEXT, through the file driver's demux.
        r.transport.deliver(.text, [request])
        r.owner.settle()
        XCTAssertEqual(r.owner.textStatus, .incomingRequest)
        XCTAssertEqual(r.text.statuses, [.incomingRequest])

        // FILE, on the same route.
        let batch = try offerInbound(r, [meta("in.bin", C)])
        XCTAssertTrue(r.files.all.contains(.inboundOffer(batch: batch, files: [meta("in.bin", C)])))
        XCTAssertEqual(r.transport.frameSlotClaims, 1, "and still only one")

        // Both lanes can WRITE, on the one transport, without either seeing the
        // other's bytes.
        try r.owner.acceptTextConversation()
        r.owner.acceptInboundBatch()
        r.owner.settle()
        XCTAssertEqual(r.transport.sent(on: .text), [[RealtimeControl.accept.rawValue]])
        XCTAssertEqual(r.transport.sent(on: .file), [[RealtimeControl.accept.rawValue]])
    }

    /// A whole conversation and a whole inbound offer, interleaved on one wire,
    /// in the order the peer sent them.
    func testInterleavedLanesKeepTheirOrderAndNeverCrossOver() throws {
        let r = rig()
        let p = peer()
        try openConversation(r, p)
        XCTAssertEqual(r.owner.textStatus, .open)

        let manifest = try r.peerFiles.batchFrames([meta("in.bin", C)])
        try p.driver.send("first")
        let firstText = p.transport.takeSent(on: .text)
        try p.driver.send("second")
        let secondText = p.transport.takeSent(on: .text)

        // text, file, text — one route, one order.
        for frame in firstText { r.transport.deliver(.text, frame) }
        for frame in manifest { r.transport.deliver(.file, frame) }
        for frame in secondText { r.transport.deliver(.text, frame) }
        r.owner.settle()

        XCTAssertEqual(r.text.received, ["first", "second"])
        XCTAssertNotNil(r.owner.activeInboundBatch)
        XCTAssertTrue(r.text.failures.isEmpty)
        XCTAssertTrue(r.files.failures.isEmpty)
    }

    // ── 2. binding ──────────────────────────────────────────────────────────

    /// All four hooks in ONE step, and the coordinator's route reaches both
    /// lanes from there on.
    func testBindingInstallsEveryHookAtomicallyAndRoutesBothLanes() throws {
        let r = rig()
        let replacement = LaneTransport()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in replacement },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)

        XCTAssertNotNil(coordinator.onTransportLost)
        XCTAssertNotNil(coordinator.onAttach)
        XCTAssertNotNil(coordinator.onFrame)
        XCTAssertNotNil(coordinator.onEnded)

        // A frame the COORDINATOR routed reaches both lanes.
        coordinator.onFrame?(.text, [request])
        r.owner.settle()
        XCTAssertEqual(r.owner.textStatus, .incomingRequest)
        for frame in try r.peerFiles.batchFrames([meta("in.bin", C)]) {
            coordinator.onFrame?(.file, frame)
        }
        r.owner.settle()
        XCTAssertNotNil(r.owner.activeInboundBatch)
    }

    /// A coordinator holding somebody else's authentication is refused rather
    /// than adopted — the same rule the file driver already enforces, applied
    /// once for the whole link.
    func testBindingRefusesAForeignCoordinator() throws {
        let r = rig()
        let foreign = LinkIdentity(peerId: "someone-else", role: .responder, sas: "999999",
                                   codecs: LinkCodecs(sendKey: [UInt8](repeating: 5, count: 32),
                                                      recvKey: [UInt8](repeating: 6, count: 32)))
        let coordinator = LinkRecoveryCoordinator(identity: foreign, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        XCTAssertThrowsError(try r.owner.bind(to: coordinator)) {
            XCTAssertEqual($0 as? LinkLaneOwnerError, .foreignCoordinator)
        }
        XCTAssertNil(coordinator.onAttach, "a refused bind wires nothing")
    }

    /// The coordinator OWNS the bound owner, and the owner holds no coordinator.
    ///
    /// Both halves matter. A weakly-held owner makes `try self?.onAttach(…)`
    /// succeed once it is gone — a publication with nobody home. An owner that
    /// retained the coordinator would keep both alive forever.
    func testABoundOwnerSurvivesItsCallerAndDiesWithTheCoordinator() throws {
        let replacement = LaneTransport()
        let scheduler = FakeLinkScheduler()
        let initial = LaneTransport()
        let codecs = LinkCodecs(sendKey: ownerSendKey, recvKey: ownerRecvKey)
        let identity = LinkIdentity(peerId: "peer-b", role: .initiator, sas: "123456",
                                    codecs: codecs)
        var coordinator: LinkRecoveryCoordinator? = LinkRecoveryCoordinator(
            identity: identity, current: initial,
            factory: { _ in replacement }, scheduler: scheduler)
        weak var held = coordinator

        weak var bound: LinkLaneOwner?
        do {
            let owner = LinkLaneOwner(identity: identity, transport: initial,
                                      scheduler: scheduler,
                                      destinationFactory: { _, _ in FakeDestination() },
                                      maxFrameBytes: maxFrame,
                                      onTextEvent: { _ in }, onFileEvent: { _ in })
            try owner.bind(to: try XCTUnwrap(coordinator))
            owner.transport(deliverText: [request])
            bound = owner
        }
        XCTAssertNotNil(bound, "a coordinator's hooks may not point at an owner nobody owns")
        XCTAssertEqual(bound?.textStatus, .incomingRequest)

        coordinator = nil
        XCTAssertNil(held, "an owner that retained its coordinator would keep it alive")
        XCTAssertNil(bound, "and the owner goes when its coordinator does")
    }

    // ── 3. the gap policy asks BOTH lanes ───────────────────────────────────

    /// Text has work, files do not. The answer is true — and the FILE lane must
    /// still have been suspended, which a short-circuiting `||` would skip.
    func testAGapSuspendsTheFileLaneEvenWhenTextAlreadyAnsweredTrue() throws {
        let r = rig()
        let p = peer()
        try openConversation(r, p)
        XCTAssertNil(r.owner.activeOutboundBatch, "the file lane is idle on purpose")

        XCTAssertTrue(r.owner.onTransportLost(r.identity))
        r.owner.settle()
        XCTAssertEqual(r.owner.textStatus, .ended, "the text lane really was suspended")

        // If the file lane had never been told, this manifest would go out on a
        // transport the owner has already declared gone.
        let before = r.transport.sent(on: .file).count
        _ = try r.owner.enqueueFiles(files: [meta("a.bin", 64)], stage: { [] })
        r.owner.pumpFiles()
        r.owner.settle()
        XCTAssertEqual(r.transport.sent(on: .file).count, before,
                       "the file lane must have been suspended too")
    }

    /// The mirror image: files have work, text does not. Both hooks still run.
    func testAGapSuspendsTheTextLaneEvenWhenFilesAlreadyAnsweredTrue() throws {
        let r = rig()
        try offerInbound(r, [meta("in.bin", C)])
        XCTAssertEqual(r.owner.textStatus, .idle, "the text lane is idle on purpose")

        XCTAssertTrue(r.owner.onTransportLost(r.identity))
        r.owner.settle()

        // A text lane that had never been told would happily arm a ten-minute
        // consent window for a REQUEST that reaches nobody.
        XCTAssertThrowsError(try r.owner.openTextConversation()) {
            XCTAssertEqual($0 as? LinkTextDriverError, .transportUnavailable)
        }
        XCTAssertTrue(r.transport.sent(on: .text).isEmpty)
    }

    /// Two idle lanes hold nothing open, and both are still asked.
    func testAnIdleLinkDeclinesRecoveryAndStillSuspendsBothLanes() throws {
        let r = rig()
        XCTAssertFalse(r.owner.onTransportLost(r.identity))
        r.owner.settle()

        XCTAssertThrowsError(try r.owner.openTextConversation())
        _ = try r.owner.enqueueFiles(files: [meta("a.bin", 64)], stage: { [] })
        r.owner.pumpFiles()
        r.owner.settle()
        XCTAssertTrue(r.transport.sent(on: .file).isEmpty)
    }

    /// A second report of the same failure suspends nothing new, and must not be
    /// read as "nothing to recover": each lane's intent is STICKY.
    func testARepeatedGapPreservesEachLanesStickyRecoveryIntent() throws {
        let r = rig()
        let p = peer()
        try openConversation(r, p)
        try offerInbound(r, [meta("in.bin", C)])

        XCTAssertTrue(r.owner.onTransportLost(r.identity))
        XCTAssertTrue(r.owner.onTransportLost(r.identity), "the intent is sticky, not one-shot")
        XCTAssertTrue(r.owner.onTransportLost(r.identity))
    }

    /// The TEXT lane is suspended BEFORE the file lane, and the order is
    /// load-bearing rather than tidy.
    ///
    /// Suspending a lane delivers owner callbacks, and an owner that answers one
    /// by sending is the realistic re-entry. A text send into a transport that
    /// is gone, made before the text lane has been told, SEALS a frame: the
    /// nonce is spent, the peer will never see it, and the conversation fails
    /// closed. The file lane has a whole resume protocol for the same window,
    /// so the lane with no way back goes first.
    /// Driven through the COORDINATOR, because that is the path where the harm
    /// is real: it closes the dying transport before it asks the policy, so a
    /// send made in this window reaches a channel that can no longer take it.
    func testAFileEventDuringTheGapCannotStillSealATextFrame() throws {
        let r = rig()
        let p = peer()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try openConversation(r, p)
        // A batch waiting for consent, so the gap really does retire it and emit
        // a file event while the gap is being reported.
        _ = try r.owner.enqueueFiles(files: [meta("a.bin", 64)], stage: { [] })
        r.owner.pumpFiles()
        r.owner.settle()
        XCTAssertNotNil(r.owner.activeOutboundBatch)

        let attempted = HookCounter()
        let refused = ErrorBox()
        r.files.hook = { [weak owner = r.owner] event in
            guard case .outboundFinished = event, let owner else { return }
            attempted.bump()
            do { try owner.sendText("mid-gap") } catch { refused.set(error) }
        }

        coordinator.transportTerminated(r.transport, error: nil)
        r.owner.settle()

        XCTAssertEqual(coordinator.phase, .interrupted)
        XCTAssertEqual(attempted.count, 1, "the file lane really did report during the gap")
        XCTAssertEqual(refused.error as? LinkLaneOwnerError, .transportUnavailable,
                       "the owner's own gate refuses first, and says it is retryable")
        XCTAssertEqual(r.owner.textStatus, .ended,
                       "and the text lane underneath it really had been suspended")
        XCTAssertFalse(r.owner.isTextTerminal,
                       "a refusal costs no nonce; sealing into a closed channel does")
        XCTAssertTrue(r.text.failures.isEmpty)
        XCTAssertTrue(r.transport.sent(on: .text).isEmpty)
    }

    /// A recovery policy is asked about ONE link. Another link's identity must
    /// suspend neither lane.
    func testAForeignIdentitySuspendsNeitherLane() throws {
        let r = rig()
        let p = peer()
        try openConversation(r, p)
        try offerInbound(r, [meta("in.bin", C)])

        let foreign = LinkIdentity(peerId: "someone-else", role: .responder, sas: "999999",
                                   codecs: LinkCodecs(sendKey: [UInt8](repeating: 5, count: 32),
                                                      recvKey: [UInt8](repeating: 6, count: 32)))
        XCTAssertFalse(r.owner.onTransportLost(foreign))
        XCTAssertEqual(r.owner.textStatus, .open)
        XCTAssertNotNil(r.owner.activeInboundBatch)
    }

    // ── 4. attaching a replacement ──────────────────────────────────────────

    /// Both lanes are on the replacement BEFORE a single captured frame
    /// replays, and both replayed frames land.
    func testAReplacementCarriesBothLanesAndAttachesBeforeTheReplay() throws {
        let r = rig()
        let p = peer()
        let replacement = LaneTransport()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in replacement },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try openConversation(r, p)
        let inbound = try offerInbound(r, [meta("in.bin", 2 * C)])
        r.owner.acceptInboundBatch()
        r.owner.settle()

        coordinator.transportTerminated(r.transport, error: nil)
        XCTAssertEqual(coordinator.phase, .interrupted)

        // A candidate is not current. Anything it delivers before publication
        // belongs to a transport the link has not taken over.
        replacement.deliver(.text, [request])
        r.owner.settle()
        XCTAssertNotEqual(r.owner.textStatus, .incomingRequest,
                          "an unpublished candidate's frames reach neither lane")

        // A frame per lane, captured before publication.
        replacement.capture(.text, [request])
        replacement.capture(.file, [LINK_FILE_BATCH_ABORT])
        replacement.publish(r.identity)
        r.owner.settle()

        XCTAssertEqual(coordinator.phase, .open, "the attach really took the lanes over")
        // FILE attached inside the barrier: its resume request was ALREADY on the
        // wire at the instant the backlog replayed, not merely at the end.
        let beforeReplay = try XCTUnwrap(replacement.sentWhenReplayed(on: .file))
        XCTAssertTrue(beforeReplay.contains { $0.first == RealtimeKind.resumeReq },
                      "the resume request went out inside the attach barrier")
        // TEXT attached too: a text driver still in its gap DROPS an admitted
        // frame, so a status change here is proof it had a transport again.
        XCTAssertEqual(r.owner.textStatus, .incomingRequest,
                       "the replayed REQUEST reached a text lane that had attached")
        XCTAssertNil(r.owner.activeInboundBatch, "and the replayed abort reached the file lane")
        _ = inbound
    }

    /// The first lane's attach throws. Nothing publishes, no backlog replays,
    /// and BOTH lanes end — including the one that never attached.
    func testAnAttachThatThrowsAtTheFirstLaneEndsBothLanesWithoutPublishing() throws {
        let r = rig()
        let inert = InertReplacement()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in inert },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try offerInbound(r, [meta("in.bin", C)])

        coordinator.transportTerminated(r.transport, error: nil)
        XCTAssertEqual(coordinator.phase, .interrupted)

        inert.onReady?(r.identity)
        // The real transport would replay here; the coordinator must drop it.
        inert.onFrame?(.text, [request])
        r.owner.settle()

        XCTAssertEqual(coordinator.phase, .ended, "publication must fail closed")
        XCTAssertTrue(r.owner.isLinkEnded)
        XCTAssertTrue(r.owner.isTextTerminal)
        XCTAssertTrue(r.owner.isFileTerminal)
        XCTAssertEqual(r.text.failures, [.linkEnded])
        XCTAssertEqual(r.files.failures, [.linkEnded])
        XCTAssertEqual(r.owner.textStatus, .failed,
                       "and the replayed REQUEST reached nothing")
    }

    /// The SECOND lane's attach throws, after the first one already swapped.
    /// There is no rollback — the link ends, both lanes with it.
    func testAnAttachThatThrowsAtTheSecondLaneEndsBothLanes() throws {
        let r = rig()
        let replacement = LaneTransport()
        // The file lane's resume request cannot be written, which is what makes
        // its attach throw AFTER the text lane has already taken the new wire.
        replacement.failSends(where: { lane, _ in lane == .file })
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in replacement },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try offerInbound(r, [meta("in.bin", 2 * C)])
        r.owner.acceptInboundBatch()
        r.owner.settle()

        coordinator.transportTerminated(r.transport, error: nil)
        replacement.capture(.text, [request])
        replacement.publish(r.identity)
        r.owner.settle()

        XCTAssertEqual(coordinator.phase, .ended)
        XCTAssertTrue(r.owner.isLinkEnded)
        XCTAssertTrue(r.owner.isTextTerminal, "the lane that DID attach ends too")
        XCTAssertTrue(r.owner.isFileTerminal)
    }

    // ── 5. stale frames ─────────────────────────────────────────────────────

    /// A gap makes the old transport's frames nobody's, in both lanes.
    func testFramesFromTheOldTransportAreDroppedInBothLanesAfterAGap() throws {
        let r = rig()
        XCTAssertTrue(r.owner.onTransportLost(r.identity) == false)
        r.owner.settle()

        r.transport.deliver(.text, [request])
        for frame in try r.peerFiles.batchFrames([meta("in.bin", C)]) {
            r.transport.deliver(.file, frame)
        }
        r.owner.settle()

        XCTAssertEqual(r.owner.textStatus, .idle, "a stale text frame reaches nothing")
        XCTAssertNil(r.owner.activeInboundBatch, "and neither does a stale manifest")
        XCTAssertFalse(r.owner.isTextTerminal)
        XCTAssertFalse(r.owner.isFileTerminal)
    }

    /// And after a replacement is current, the transport it replaced can no
    /// longer retake the route.
    func testTheReplacedTransportCannotRetakeEitherLane() throws {
        let r = rig()
        let replacement = LaneTransport()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in replacement },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        let p = peer()
        try openConversation(r, p)

        coordinator.transportTerminated(r.transport, error: nil)
        replacement.publish(r.identity)
        r.owner.settle()
        XCTAssertEqual(coordinator.phase, .open)

        // The OLD transport still holds the route the file driver installed on it.
        r.transport.deliver(.text, [request])
        for frame in try r.peerFiles.batchFrames([meta("in.bin", C)]) {
            r.transport.deliver(.file, frame)
        }
        r.owner.settle()
        XCTAssertNil(r.owner.activeInboundBatch)
        XCTAssertNotEqual(r.owner.textStatus, .incomingRequest)

        // The replacement's own route still works.
        replacement.deliver(.text, [request])
        r.owner.settle()
        XCTAssertEqual(r.owner.textStatus, .incomingRequest)
    }

    // ── 6. one lane's terminal is not the other's ───────────────────────────

    /// A file lane that failed closed leaves a live conversation on the same
    /// transport — including one opened AFTER the failure.
    func testAFileLaneFailureLeavesTheTextLaneUsable() throws {
        let r = rig()
        let p = peer()
        try offerInbound(r, [meta("in.bin", C)])
        // Protected content before consent fails the file lane closed.
        r.transport.deliver(.file, try r.peerFiles.nextChunkFrame([UInt8](repeating: 1, count: 32)))
        r.owner.settle()
        XCTAssertTrue(r.owner.isFileTerminal)
        XCTAssertFalse(r.owner.isLinkEnded)
        XCTAssertFalse(r.owner.isTextTerminal)

        try openConversation(r, p)
        XCTAssertEqual(r.owner.textStatus, .open)
        try r.owner.sendText("still here")
        pumpToPeer(r, p)
        XCTAssertEqual(p.events.received, ["still here"])

        try p.driver.send("and back")
        pumpToOwner(p, r)
        XCTAssertEqual(r.text.received, ["and back"])
    }

    /// A dead file lane must not cost the conversation its RECOVERY either.
    ///
    /// The file lane has nothing a replacement could restore and answers the gap
    /// policy false; if that answer were the link's, a live conversation would
    /// be ended by a transfer that had already failed. And the terminal file
    /// driver still has to attach, because the route the text lane reaches its
    /// session through is the file driver's.
    func testATerminalFileLaneStillLetsTheConversationSurviveARebuild() throws {
        let r = rig()
        let p = peer()
        let replacement = LaneTransport()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in replacement },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try offerInbound(r, [meta("in.bin", C)])
        r.transport.deliver(.file, try r.peerFiles.nextChunkFrame([UInt8](repeating: 1, count: 32)))
        r.owner.settle()
        XCTAssertTrue(r.owner.isFileTerminal)
        try openConversation(r, p)

        coordinator.transportTerminated(r.transport, error: nil)
        XCTAssertEqual(coordinator.phase, .interrupted,
                       "the conversation's answer held the link open")

        replacement.publish(r.identity)
        r.owner.settle()
        XCTAssertEqual(coordinator.phase, .open)
        XCTAssertFalse(r.owner.isLinkEnded)

        // And the route on the replacement still reaches the text lane.
        replacement.deliver(.text, [request])
        r.owner.settle()
        XCTAssertEqual(r.owner.textStatus, .incomingRequest)
        try r.owner.acceptTextConversation()
        r.owner.settle()
        XCTAssertEqual(replacement.sent(on: .text), [[RealtimeControl.accept.rawValue]])
    }

    /// And the other way round: a text lane whose codecs are spent leaves the
    /// file lane transferring.
    func testATextLaneFailureLeavesTheFileLaneUsable() throws {
        let r = rig()
        let p = peer()
        try openConversation(r, p)

        // A sealed frame that cannot be written spends a nonce the peer will
        // never see. Only the TEXT lane may die of it.
        r.transport.failSends(where: { lane, _ in lane == .text })
        try r.owner.sendText("lost")
        r.owner.settle()
        XCTAssertTrue(r.owner.isTextTerminal)
        XCTAssertEqual(r.text.failures, [.protectedSendFailed])
        XCTAssertFalse(r.owner.isFileTerminal)
        XCTAssertFalse(r.owner.isLinkEnded)

        r.transport.failSends(where: nil)
        let batch = try offerInbound(r, [meta("in.bin", C)])
        r.owner.acceptInboundBatch()
        r.owner.settle()
        XCTAssertEqual(r.transport.sent(on: .file), [[RealtimeControl.accept.rawValue]])
        XCTAssertEqual(r.owner.activeInboundBatch, batch)
    }

    // ── 7. the link ending ──────────────────────────────────────────────────

    /// Both lanes, every time, exactly once from outside — and an uncommitted
    /// destination is discarded rather than left on disk.
    func testEndingRunsBothLanesOnceAndDiscardsAnUncommittedDestination() throws {
        let destination = FakeDestination()
        let r = rig(destination: destination)
        let p = peer()
        try openConversation(r, p)
        // Declared LONGER than what arrives, so the destination is created and
        // written to and never commits: the exact state a discard is about.
        try offerInbound(r, [meta("in.bin", 2 * C)])
        r.owner.acceptInboundBatch()
        r.owner.settle()
        r.transport.deliver(.file, try r.peerFiles.nextChunkFrame([UInt8](repeating: 7, count: C)))
        r.owner.settle()
        XCTAssertFalse(destination.finalized)
        XCTAssertTrue(r.files.failures.isEmpty, "the transfer is mid-flight, not broken")

        r.owner.onEnded(LinkRecoveryError.windowExpired)
        r.owner.settle()

        XCTAssertTrue(r.owner.isLinkEnded)
        XCTAssertEqual(r.text.failures, [.linkEnded])
        XCTAssertEqual(r.files.failures, [.linkEnded])
        XCTAssertTrue(destination.aborted, "an uncommitted destination is not the user's file")
        XCTAssertFalse(destination.finalized)

        // Idempotent: a second report is not a second loss.
        r.owner.onEnded(LinkRecoveryError.cancelled)
        r.owner.settle()
        XCTAssertEqual(r.text.failures, [.linkEnded])
        XCTAssertEqual(r.files.failures, [.linkEnded])

        // And nothing routes any more, in either lane.
        r.transport.deliver(.text, [request])
        r.owner.settle()
        XCTAssertEqual(r.text.received, [])
    }

    /// The same through the coordinator's own terminal path, twice.
    func testAStoppedCoordinatorEndsBothLanesExactlyOnce() throws {
        let r = rig()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)

        coordinator.stop()
        coordinator.stop()
        r.owner.settle()

        XCTAssertTrue(r.owner.isLinkEnded)
        XCTAssertEqual(r.text.failures, [.linkEnded])
        XCTAssertEqual(r.files.failures, [.linkEnded])
    }

    // ── 8. cross-lane lifecycle re-entry ────────────────────────────────────
    //
    // Suspending or ending ONE lane delivers that lane's owner callbacks before
    // the other lane has been told anything. Everything in this section is about
    // what the other lane's facade must already answer inside that window, and
    // every one of them is driven through the COORDINATOR: it closes the dying
    // transport BEFORE it asks the policy, so work started in the window reaches
    // a channel that can no longer take it.

    /// The mirror of `testAFileEventDuringTheGapCannotStillSealATextFrame`, and
    /// the one that was open: TEXT is suspended first, so a text callback runs
    /// while the FILE lane still points at the transport the coordinator has
    /// already closed.
    ///
    /// A file batch launched there writes its manifest into that closed channel,
    /// the write fails, and the file lane goes TERMINAL — the exact opposite of
    /// the harmless suspend-and-resume the gap exists to give it.
    func testATextEventDuringTheGapCannotStillSpendTheFileLane() throws {
        let r = rig()
        let p = peer()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        // An open conversation, so the gap really does end it and report the
        // status change while the gap is being reported.
        try openConversation(r, p)

        let staged = [meta("a.bin", 64)]
        let attempted = HookCounter()
        let refused = ErrorBox()
        r.text.hook = { [weak owner = r.owner] event in
            guard case .status(.ended) = event, let owner else { return }
            attempted.bump()
            do { _ = try owner.enqueueFiles(files: staged, stage: { [] }) }
            catch { refused.set(error) }
            owner.pumpFiles()
        }

        coordinator.transportTerminated(r.transport, error: nil)
        r.owner.settle()

        XCTAssertEqual(coordinator.phase, .interrupted)
        XCTAssertEqual(attempted.count, 1, "the text lane really did report during the gap")
        XCTAssertEqual(refused.error as? LinkLaneOwnerError, .transportUnavailable,
                       "the file lane must already have been unavailable")
        XCTAssertFalse(r.owner.isFileTerminal,
                       "a gap SUSPENDS the file lane; it must never spend it")
        XCTAssertTrue(r.files.failures.isEmpty)
        XCTAssertTrue(r.transport.sent(on: .file).isEmpty,
                      "nothing may be written to the transport the coordinator closed")
    }

    /// And the refusal above is a suspension rather than a loss: the very same
    /// batch is accepted the moment the transition is over, and still writes
    /// nothing to the transport that is gone.
    func testAFileLaneRefusedInsideTheGapWindowIsSuspendedRatherThanSpent() throws {
        let r = rig()
        let p = peer()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try openConversation(r, p)

        let staged = [meta("a.bin", 64)]
        r.text.hook = { [weak owner = r.owner] event in
            guard case .status(.ended) = event, let owner else { return }
            _ = try? owner.enqueueFiles(files: staged, stage: { [] })
            owner.pumpFiles()
        }
        coordinator.transportTerminated(r.transport, error: nil)
        r.owner.settle()
        r.text.hook = nil

        // The window is closed and both lanes know. This is the state
        // `testAGapSuspendsTheFileLaneEvenWhenTextAlreadyAnsweredTrue` proves for
        // a gap nobody re-entered, and a re-entered one must reach the same
        // place.
        _ = try r.owner.enqueueFiles(files: staged, stage: { [] })
        r.owner.pumpFiles()
        r.owner.settle()

        XCTAssertFalse(r.owner.isFileTerminal, "the lane is between transports, not over")
        XCTAssertTrue(r.files.failures.isEmpty)
        XCTAssertTrue(r.transport.sent(on: .file).isEmpty)
    }

    /// A VOID owner action is refused in the same window, and INERTLY: an owner
    /// action returns nothing, so "refused" has to mean "did not happen" rather
    /// than "happened somewhere else".
    ///
    /// Cancelling the batch on the lane is the one to prove it with, because its
    /// abort goes out SYNCHRONOUSLY — no destination, no queue hop — so a cancel
    /// made in the window really does reach the closed channel and really does
    /// fail the lane closed.
    func testAVoidFileActionDuringTheGapIsInertRatherThanFatal() throws {
        let r = rig()
        let p = peer()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try openConversation(r, p)
        let batch = try r.owner.enqueueFiles(files: [meta("a.bin", 64)], stage: { [] })
        r.owner.pumpFiles()
        r.owner.settle()
        XCTAssertEqual(r.owner.activeOutboundBatch, batch)
        _ = r.transport.takeSent(on: .file)

        let attempted = HookCounter()
        r.text.hook = { [weak owner = r.owner] event in
            guard case .status(.ended) = event, let owner else { return }
            attempted.bump()
            owner.cancelOutboundBatch()
        }

        coordinator.transportTerminated(r.transport, error: nil)
        r.owner.settle()

        XCTAssertEqual(attempted.count, 1)
        XCTAssertTrue(r.transport.sent(on: .file).isEmpty,
                      "no abort may reach the transport the coordinator closed")
        XCTAssertFalse(r.owner.isFileTerminal,
                       "an inert action costs the lane nothing")
        XCTAssertTrue(r.files.failures.isEmpty)
    }

    /// The terminal path, TEXT callback first: the text lane's ONE `failed`
    /// report runs before the file lane has been told the link ended, and work
    /// started from it would spend the file lane on a closed transport — turning
    /// one loss into two reports for the same lane.
    func testATextEventWhileTheLinkEndsCannotStillSpendTheFileLane() throws {
        let r = rig()
        let p = peer()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try openConversation(r, p)

        let staged = [meta("a.bin", 64)]
        let attempted = HookCounter()
        let refused = ErrorBox()
        r.text.hook = { [weak owner = r.owner] event in
            guard case .failed = event, let owner else { return }
            attempted.bump()
            do { _ = try owner.enqueueFiles(files: staged, stage: { [] }) }
            catch { refused.set(error) }
            owner.pumpFiles()
        }

        coordinator.stop()
        r.owner.settle()

        XCTAssertEqual(attempted.count, 1, "the text lane really did report while ending")
        XCTAssertEqual(refused.error as? LinkLaneOwnerError, .linkEnded,
                       "the file lane must already observe the link ending, terminally")
        XCTAssertTrue(r.owner.isLinkEnded)
        XCTAssertEqual(r.files.failures, [.linkEnded], "one loss, one report")
        XCTAssertTrue(r.transport.sent(on: .file).isEmpty)
    }

    /// And the other terminal direction. The FILE lane is ended second, so its
    /// callback already finds a text lane that was told — but the answer the
    /// owner gives has to be the OWNER's terminal refusal, made before either
    /// lane could report, rather than one lane happening to be ahead.
    func testAFileEventWhileTheLinkEndsCannotStillUseTheTextLane() throws {
        let r = rig()
        let p = peer()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try openConversation(r, p)

        let attempted = HookCounter()
        let refused = ErrorBox()
        r.files.hook = { [weak owner = r.owner] event in
            guard case .failed = event, let owner else { return }
            attempted.bump()
            do { try owner.sendText("mid-end") } catch { refused.set(error) }
        }

        coordinator.stop()
        r.owner.settle()

        XCTAssertEqual(attempted.count, 1, "the file lane really did report while ending")
        XCTAssertEqual(refused.error as? LinkLaneOwnerError, .linkEnded)
        XCTAssertTrue(r.owner.isLinkEnded)
        XCTAssertEqual(r.text.failures, [.linkEnded], "one loss, one report")
        XCTAssertTrue(r.transport.sent(on: .text).isEmpty)
    }

    /// A report about ANOTHER link leaves this one's facade exactly as it found
    /// it: both lanes still work afterwards.
    ///
    /// What this can see is a transition the owner OPENED AND NEVER CLOSED —
    /// a gate whose two halves got out of step, which refuses every later call
    /// on a link that never lost anything. It deliberately does not claim more:
    /// a gate that closed and reopened within the call leaves no residue for a
    /// test to find, because a foreign report emits no callback to observe it
    /// from. The mutation that WOULD be visible is each lane's, and
    /// `testAForeignIdentitySuspendsNeitherLane` is where that is proven.
    func testAForeignGapLeavesTheOwnersFacadeOpen() throws {
        let r = rig()
        let p = peer()
        try openConversation(r, p)

        let foreign = LinkIdentity(peerId: "someone-else", role: .responder, sas: "999999",
                                   codecs: LinkCodecs(sendKey: [UInt8](repeating: 5, count: 32),
                                                      recvKey: [UInt8](repeating: 6, count: 32)))
        XCTAssertFalse(r.owner.onTransportLost(foreign))

        try r.owner.sendText("still mine")
        r.owner.settle()
        pumpToPeer(r, p)
        XCTAssertEqual(p.events.received, ["still mine"])

        _ = try r.owner.enqueueFiles(files: [meta("a.bin", 64)], stage: { [] })
        r.owner.pumpFiles()
        r.owner.settle()
        XCTAssertNotNil(r.owner.activeOutboundBatch, "and the file lane launched normally")
    }

    // ── 9. re-entrancy and concurrency ──────────────────────────────────────

    /// An owner callback that re-enters the owner, on the delivering thread,
    /// while the other lane is being driven from another one. No lock the owner
    /// holds may be on that path — ideally because it holds none.
    func testReentrantCallbacksAndConcurrentDeliveryNeitherDeadlockNorLoseFrames() throws {
        let r = rig()
        let p = peer()
        try openConversation(r, p)

        // Every inbound message answers on the same thread that delivered it,
        // from inside the event callback.
        let echoed = HookCounter()
        r.text.hook = { [weak owner = r.owner] event in
            guard case .received = event, let owner else { return }
            _ = try? owner.sendText("echo")
            echoed.bump()
            _ = owner.textStatus
            _ = owner.activeInboundBatch
        }

        // Under `LINK_TEXT_BURST`. The lane's flood defence is a real rule and
        // exceeding it would poison the codecs — which is a text-lane test, not
        // this one.
        let messages = 15
        var frames: [[UInt8]] = []
        for index in 0..<messages {
            try p.driver.send("m\(index)")
            frames += p.transport.takeSent(on: .text)
        }
        XCTAssertEqual(frames.count, messages)

        let done = expectation(description: "delivery finished")
        DispatchQueue.global().async {
            // In order, on ONE thread, the way a transport publishes.
            for frame in frames { r.transport.deliverOnQueue(.text, frame) }
            r.transport.queue.sync {}
            done.fulfill()
        }
        // ...while another thread drives the file lane through the same owner.
        let hammering = expectation(description: "file lane driven")
        DispatchQueue.global().async {
            for _ in 0..<200 {
                r.owner.pumpFiles()
                _ = r.owner.isFileTerminal
                _ = r.owner.textStatus
            }
            hammering.fulfill()
        }
        wait(for: [done, hammering], timeout: 20)
        r.owner.settle()

        XCTAssertEqual(r.text.received, (0..<messages).map { "m\($0)" },
                       "every message, exactly once, in the order it was sent")
        XCTAssertEqual(echoed.count, messages)
        XCTAssertTrue(r.text.failures.isEmpty)
        XCTAssertTrue(r.files.failures.isEmpty)
    }

    /// Both lanes delivered concurrently on the transport's own queue, while the
    /// owner is being read from the test's thread. This is the Thread-Sanitizer
    /// case: two drivers, one route, no owner state.
    func testConcurrentTwoLaneDeliveryIsSafe() throws {
        let r = rig()
        let p = peer()
        try openConversation(r, p)

        var textFrames: [[UInt8]] = []
        for index in 0..<20 {
            try p.driver.send("c\(index)")
            textFrames += p.transport.takeSent(on: .text)
        }
        let manifest = try r.peerFiles.batchFrames([meta("in.bin", C)])

        let done = expectation(description: "both lanes delivered")
        DispatchQueue.global().async {
            for frame in textFrames { r.transport.deliverOnQueue(.text, frame) }
            for frame in manifest { r.transport.deliverOnQueue(.file, frame) }
            r.transport.queue.sync {}
            done.fulfill()
        }
        for _ in 0..<500 {
            _ = r.owner.textStatus
            _ = r.owner.isLinkEnded
            _ = r.owner.activeInboundBatch
        }
        wait(for: [done], timeout: 20)
        r.owner.settle()

        XCTAssertEqual(r.text.received, (0..<20).map { "c\($0)" })
        XCTAssertNotNil(r.owner.activeInboundBatch)
    }

    /// A lifecycle transition running on one thread while the facade is hammered
    /// from two others.
    ///
    /// The owner's lifecycle gate is the only mutable state it has, so this is
    /// the Thread-Sanitizer case for it — and the deadlock case too: the gate is
    /// taken and released around a decision and is never held across a driver,
    /// transport or callback call, so a facade call that arrives mid-transition
    /// is refused rather than blocked.
    func testConcurrentFacadeCallsDuringALifecycleTransitionAreSafe() throws {
        let r = rig()
        let p = peer()
        let coordinator = LinkRecoveryCoordinator(identity: r.identity, current: r.transport,
                                                  factory: { _ in LaneTransport() },
                                                  scheduler: r.scheduler)
        try r.owner.bind(to: coordinator)
        try openConversation(r, p)

        let hammering = expectation(description: "facade hammered")
        hammering.expectedFulfillmentCount = 2
        for _ in 0..<2 {
            DispatchQueue.global().async {
                for _ in 0..<500 {
                    _ = try? r.owner.sendText("x")
                    r.owner.pumpFiles()
                    r.owner.acceptInboundBatch()
                    r.owner.cancelOutboundBatch()
                    _ = r.owner.isLinkEnded
                    _ = r.owner.textStatus
                }
                hammering.fulfill()
            }
        }
        let ending = expectation(description: "link ended")
        DispatchQueue.global().async {
            coordinator.transportTerminated(r.transport, error: nil)
            coordinator.stop()
            ending.fulfill()
        }
        wait(for: [hammering, ending], timeout: 30)
        r.owner.settle()

        XCTAssertTrue(r.owner.isLinkEnded)
        XCTAssertTrue(r.owner.isTextTerminal)
        XCTAssertTrue(r.owner.isFileTerminal)
    }

    // ── 10. source guards ───────────────────────────────────────────────────

    private var ownerSource: String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
        let file = packageRoot.appendingPathComponent(
            "Sources/RelayiumKit/Realtime/LinkLaneOwner.swift")
        return (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    }

    private func code(_ source: String) -> String {
        source
            .components(separatedBy: "\n")
            .map { line -> String in
                guard let marker = line.range(of: "//") else { return line }
                return String(line[line.startIndex..<marker.lowerBound])
            }
            .joined(separator: "\n")
    }

    /// The four hooks go in as ONE step.
    ///
    /// Pinned as source, because the failure is a WINDOW rather than a state: a
    /// transport that terminates between two property writes finds a half-wired
    /// owner, and every behavioural test here would still pass.
    func testTheOwnerInstallsItsHooksAtomically() {
        let source = code(ownerSource)
        XCTAssertFalse(source.isEmpty, "the owner source must be readable")
        XCTAssertTrue(source.contains("installOwnerHooks("),
                      "the four hooks must be installed as one step")
        for piecemeal in ["coordinator.onTransportLost =", "coordinator.onAttach =",
                          "coordinator.onFrame =", "coordinator.onEnded ="] {
            XCTAssertFalse(source.contains(piecemeal),
                           "\(piecemeal) reopens the half-wired window")
        }
    }

    /// The owner composes; it never derives. A `LinkCodecs` built here would be
    /// a second AEAD sequence under one pair of session keys, and a second
    /// `LinkIdentity` is how the two lanes end up on different ones.
    func testTheOwnerConstructsNoCryptographyAndNoSecondIdentity() {
        let source = code(ownerSource)
        XCTAssertFalse(source.isEmpty, "the owner source must be readable")
        for forbidden in ["HandshakeState", "LinkCodecs(", "generateKeyPair(", "deriveSession(",
                          "deriveResumeAuth(", "deriveTextKey(", "LinkIdentity("] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) has no place in a lane owner")
        }
    }

    /// Still unreachable from production, and neither feature flag has moved.
    ///
    /// Exactly ONE object may construct a lane owner — `LinkSessionRuntime`,
    /// which assembles it at the only moment it may be built, inside the initial
    /// transport's publication. That is not a hole in this rule: the runtime is
    /// itself unreachable, and `LinkSessionRuntimeTests` pins that with the same
    /// scan over the same sources plus the iOS and macOS targets. So the chain
    /// from a UI to a lane owner is still broken, one link further along.
    func testTheOwnerStaysUnreachableFromProduction() throws {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        let entitled: Set<String> = ["LinkLaneOwner.swift", "LinkSessionRuntime.swift"]
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources")
        let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" && !entitled.contains($0.lastPathComponent) }
        for file in try XCTUnwrap(files) {
            let text = code((try? String(contentsOf: file, encoding: .utf8)) ?? "")
            XCTAssertFalse(text.contains("LinkLaneOwner("),
                           "\(file.lastPathComponent) constructs a lane owner")
        }
    }
}

// MARK: - a test-only convenience

private extension LinkLaneOwner {
    /// Deliver a text frame the way the initial transport does, without the test
    /// having to hold the transport.
    func transport(deliverText bytes: [UInt8]) {
        routeCurrentFrame(lane: .text, bytes: bytes)
        settle()
    }
}
