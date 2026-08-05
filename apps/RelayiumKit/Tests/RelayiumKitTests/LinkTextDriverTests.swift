import XCTest
@testable import RelayiumKit

// MARK: - deterministic fakes
//
// Private to this file on purpose. `LinkTextDriver` is a different shape from
// `LinkFileDriver` — it never installs `onFrame`, it reads ONE lane's buffer and
// its whole failure vocabulary is the text lane's — so a shared fake would have
// to grow knobs the file tests do not want and would make a text-lane regression
// visible only as a file-lane test edit.

/// A transport with a genuine serial queue, exactly like the real ones: `send`,
/// `bufferedAmount`, `isClosed` and `close` all enter it SYNCHRONOUSLY.
///
/// That is what makes "the driver held its lock across a transport call" a real
/// deadlock rather than a style opinion — and `close()` zeroing the buffer is
/// what makes "a closed channel reports nothing outstanding" reproducible, which
/// is the exact lie the gap policy must not believe.
private final class TextTransport: LinkReplacementTransport, LinkLiveTransport, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.relayium.test.text-transport")
    private let key = DispatchSpecificKey<Bool>()
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
    private var _closed = false
    private var _closeCount = 0
    private var _buffered: UInt64 = 0
    private var _bufferedCalls = 0
    private var _bufferedScript: ((Int) -> UInt64)?
    private var _failWhen: (([UInt8]) -> Bool)?
    private var _gateWhen: (([UInt8]) -> Bool)?
    private var _beforeProbe: (() -> Void)?

    private let gateOpen = DispatchSemaphore(value: 0)
    private let gateEntered = DispatchSemaphore(value: 0)

    init() { queue.setSpecific(key: key, value: true) }

    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: key) == true { return body() }
        return queue.sync { body() }
    }

    // ── configuration ───────────────────────────────────────────────────────

    func setBuffered(_ value: UInt64) {
        state.lock(); _buffered = value; _bufferedScript = nil; state.unlock()
    }

    /// The buffer as a function of how many times it has been asked, so a test
    /// can put the rise BETWEEN the pre-seal check and the drain — which is the
    /// only place the residual-parking rule is observable.
    func setBufferedScript(_ script: @escaping (Int) -> UInt64) {
        state.lock(); _bufferedScript = script; state.unlock()
    }

    func failSends(where predicate: (([UInt8]) -> Bool)?) {
        state.lock(); _failWhen = predicate; state.unlock()
    }

    /// Hold the NEXT matching send until `releaseGate()`. Deliberately blocks
    /// OUTSIDE the serial queue, so a parked send does not also freeze
    /// `bufferedAmount` — a fake that froze both could only ever deadlock.
    func gateSends(where predicate: @escaping ([UInt8]) -> Bool) {
        state.lock(); _gateWhen = predicate; state.unlock()
    }

    @discardableResult
    func waitUntilGated(timeout: TimeInterval = 5.0) -> Bool {
        gateEntered.wait(timeout: .now() + timeout) == .success
    }
    func releaseGate() { gateOpen.signal() }

    /// Fires ONCE, on the calling thread and BEFORE the serial queue is entered,
    /// at the top of `bufferedAmount`.
    ///
    /// The only way a test can act at the instant a caller is about to need the
    /// transport's queue but has not yet blocked on it. Deliberately outside the
    /// queue: a hook that ran inside it could not observe the very contention it
    /// exists to create.
    func onNextBufferedProbe(_ body: @escaping () -> Void) {
        state.lock(); _beforeProbe = body; state.unlock()
    }

    // ── the live-transport seam ─────────────────────────────────────────────

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        state.lock()
        let gated = _gateWhen?(bytes) ?? false
        if gated { _gateWhen = nil }
        state.unlock()
        if gated {
            gateEntered.signal()
            _ = gateOpen.wait(timeout: .now() + 10.0)
        }
        var fail = false
        var closed = false
        onQueue {
            state.lock()
            fail = _failWhen?(bytes) ?? false
            closed = _closed
            if !fail && !closed { _sent.append((lane, bytes)) }
            state.unlock()
        }
        if closed || fail { throw LinkTransportError.closed }
    }

    func bufferedAmount(on lane: LinkLane) -> UInt64 {
        state.lock()
        let hook = _beforeProbe
        _beforeProbe = nil
        state.unlock()
        hook?()
        return onQueue {
            state.lock(); defer { state.unlock() }
            if _closed { return 0 }
            let index = _bufferedCalls
            _bufferedCalls += 1
            if let script = _bufferedScript { return script(index) }
            return _buffered
        }
    }

    var isClosed: Bool { onQueue { state.lock(); defer { state.unlock() }; return _closed } }

    /// A close that ERASES the buffer, which is what a real closed DataChannel
    /// reports and what makes `bufferedAmount` unusable as gap-time evidence.
    func close() {
        onQueue {
            state.lock(); _closed = true; _buffered = 0; _closeCount += 1; state.unlock()
        }
    }

    func start() {}
    func receive(from: String, signal: JSONValue) {}

    // ── observation ─────────────────────────────────────────────────────────

    var sentText: [[UInt8]] {
        state.lock(); defer { state.unlock() }
        return _sent.filter { $0.lane == .text }.map(\.bytes)
    }
    var sentLanes: [LinkLane] { state.lock(); defer { state.unlock() }; return _sent.map(\.lane) }
    var closeCount: Int { state.lock(); defer { state.unlock() }; return _closeCount }
    var bufferedCallCount: Int { state.lock(); defer { state.unlock() }; return _bufferedCalls }

    func takeSentText() -> [[UInt8]] {
        state.lock(); defer { state.unlock() }
        let taken = _sent.filter { $0.lane == .text }.map(\.bytes)
        _sent.removeAll()
        return taken
    }
}

/// A scheduler that records every delay and fires only when a test says so.
private final class RecordingScheduler: LinkRecoveryScheduler, @unchecked Sendable {
    final class Handle: LinkRecoveryTimer, @unchecked Sendable {
        let delay: TimeInterval
        let body: () -> Void
        private let lock = NSLock()
        private var _cancelled = false
        var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return _cancelled }
        init(delay: TimeInterval, body: @escaping () -> Void) {
            self.delay = delay
            self.body = body
        }
        func cancel() { lock.lock(); _cancelled = true; lock.unlock() }
    }

    private let lock = NSLock()
    private var handles: [Handle] = []

    func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
        let handle = Handle(delay: delay, body: body)
        lock.lock(); handles.append(handle); lock.unlock()
        return handle
    }

    /// Every delay ever scheduled, in order. The timer CONSTANTS' unit
    /// conversion is only observable here.
    var allDelays: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return handles.map(\.delay) }
    var liveDelays: [TimeInterval] {
        lock.lock(); defer { lock.unlock() }
        return handles.filter { !$0.cancelled }.map(\.delay)
    }
    var liveCount: Int { lock.lock(); defer { lock.unlock() }; return handles.filter { !$0.cancelled }.count }

    /// Fire every live wake-up once, oldest first. Snapshot-then-fire, so a
    /// callback that re-arms does not spin this loop forever.
    func fireAll() {
        lock.lock()
        let live = handles.filter { !$0.cancelled }
        handles.removeAll { !$0.cancelled }
        lock.unlock()
        for handle in live { handle.body() }
    }

    /// Fire only the driver's INTERNAL polls, never a consent or END-ACK
    /// window. Told apart by their delay, because that is the only thing a
    /// scheduler sees — and firing a 30-second barrier by accident would end the
    /// lane and hide whatever the poll was there to prove.
    func firePolls(under bound: TimeInterval = 1) {
        lock.lock()
        let live = handles.filter { !$0.cancelled && $0.delay < bound }
        handles.removeAll { !$0.cancelled && $0.delay < bound }
        lock.unlock()
        for handle in live { handle.body() }
    }

    /// Fire ONLY the cancelled wake-ups: a real timer that had already started
    /// running when its handle was taken back.
    func fireCancelledOnly() {
        lock.lock()
        let dead = handles.filter { $0.cancelled }
        handles.removeAll { $0.cancelled }
        lock.unlock()
        for handle in dead { handle.body() }
    }
}

private final class TextEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [LinkTextDriverEvent] = []

    func append(_ event: LinkTextDriverEvent) { lock.lock(); items.append(event); lock.unlock() }

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

// MARK: - tests

/// The disabled reusable text-conversation driver: one `LinkTextSession` under
/// one lock, a typed FIFO nothing may reorder, an authoritative unflushed-protected
/// state the transport cannot lie its way out of, and a route it never installs.
final class LinkTextDriverTests: XCTestCase {

    private let request = LINK_TEXT_REQUEST
    private let end = LINK_TEXT_END
    private let accept = RealtimeControl.accept.rawValue
    private let reject = RealtimeControl.reject.rawValue

    /// What a real DataChannel negotiates. 64 KiB of plaintext does NOT fit it
    /// once sealed, which is why the driver passes the CONNECTION's number down.
    private let maxFrame: Double = 65_536

    private struct Rig {
        let driver: LinkTextDriver
        let transport: TextTransport
        let scheduler: RecordingScheduler
        let events: TextEvents
        let identity: LinkIdentity
    }

    private func rig(sendKey: [UInt8], recvKey: [UInt8], role: Role, peerId: String,
                     highWater: UInt64 = LINK_TEXT_SEND_HIGH_WATER) -> Rig {
        let identity = LinkIdentity(peerId: peerId, role: role, sas: "123456",
                                    codecs: LinkCodecs(sendKey: sendKey, recvKey: recvKey))
        let transport = TextTransport()
        let scheduler = RecordingScheduler()
        let events = TextEvents()
        let driver = LinkTextDriver(identity: identity, transport: transport,
                                    scheduler: scheduler, maxFrameBytes: maxFrame,
                                    sendBufferHighWater: highWater,
                                    sendBufferPollInterval: 0.01,
                                    onEvent: { events.append($0) })
        return Rig(driver: driver, transport: transport, scheduler: scheduler,
                   events: events, identity: identity)
    }

    private let keyOne = [UInt8](repeating: 0x11, count: 32)
    private let keyTwo = [UInt8](repeating: 0x22, count: 32)

    private func solo(highWater: UInt64 = LINK_TEXT_SEND_HIGH_WATER) -> Rig {
        rig(sendKey: keyOne, recvKey: keyTwo, role: .initiator, peerId: "peer-b",
            highWater: highWater)
    }

    /// Two drivers that really talk: one side's send key is the other's receive
    /// key, so a frame produced by one is authenticated by the other. Nothing is
    /// stubbed between them except the wire itself.
    private func pair() -> (a: Rig, b: Rig) {
        (rig(sendKey: keyOne, recvKey: keyTwo, role: .initiator, peerId: "peer-b"),
         rig(sendKey: keyTwo, recvKey: keyOne, role: .responder, peerId: "peer-a"))
    }

    /// Move everything one side put on the wire to the other side's inbound seam.
    private func pump(_ from: Rig, _ to: Rig) {
        for frame in from.transport.takeSentText() { to.driver.admitTextFrame(frame) }
    }

    private func sequence(of frame: [UInt8]) -> UInt32 {
        (UInt32(frame[1]) << 24) | (UInt32(frame[2]) << 16)
            | (UInt32(frame[3]) << 8) | UInt32(frame[4])
    }

    private func isProtected(_ frame: [UInt8]) -> Bool { isLinkTextFrame(frame) }

    private func openConversation(_ a: Rig, _ b: Rig) throws {
        try a.driver.open()
        pump(a, b)
        try b.driver.accept()
        pump(b, a)
    }

    // ── 1. the route is never installed ─────────────────────────────────────

    /// The whole reason this driver can exist beside `LinkFileDriver`: it takes
    /// no `onFrame` slot at all. The slot is the file driver's on the initial
    /// transport and the coordinator's on a replacement, and a text driver that
    /// installed one would silently take the file lane's frames with it.
    func testTheDriverInstallsNoFrameRouteAndOnlyAdmittedBytesReachIt() throws {
        let r = solo()
        XCTAssertNil(r.transport.onFrame, "the driver must never claim the route slot")

        // A frame delivered the way a live transport would: nobody is listening.
        r.transport.onFrame?(.text, [request])
        XCTAssertEqual(r.driver.status, .idle)
        XCTAssertTrue(r.events.all.isEmpty)

        // The same bytes through the explicit seam DO reach the session.
        r.driver.admitTextFrame([request])
        XCTAssertEqual(r.driver.status, .incomingRequest)
        XCTAssertEqual(r.events.statuses, [.incomingRequest])
        XCTAssertNil(r.transport.onFrame, "still no route after inbound work")
    }

    // ── 2. a whole conversation across a pair ───────────────────────────────

    func testAConversationOpensSendsReceivesAndEndsOnOneCodecSequence() throws {
        let (a, b) = pair()

        try a.driver.open()
        XCTAssertEqual(a.transport.sentText, [[request]])
        XCTAssertEqual(a.driver.status, .waitingAccept)
        XCTAssertEqual(a.scheduler.liveDelays, [LINK_TEXT_CONSENT_TIMEOUT])

        pump(a, b)
        XCTAssertEqual(b.driver.status, .incomingRequest)
        XCTAssertEqual(b.scheduler.liveDelays, [LINK_TEXT_CONSENT_TIMEOUT])

        try b.driver.accept()
        XCTAssertEqual(b.transport.sentText, [[accept]])
        XCTAssertEqual(b.driver.status, .open)
        XCTAssertEqual(b.scheduler.liveCount, 0, "consent resolved, so its timer is gone")

        pump(b, a)
        XCTAssertEqual(a.driver.status, .open)
        XCTAssertEqual(a.scheduler.liveCount, 0)
        XCTAssertEqual(a.events.statuses, [.waitingAccept, .open])
        XCTAssertEqual(b.events.statuses, [.incomingRequest, .open])

        try a.driver.send("hello")
        let first = a.transport.sentText
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(sequence(of: first[0]), 0)
        pump(a, b)
        XCTAssertEqual(b.events.received, ["hello"])

        try b.driver.send("你好 👋")
        pump(b, a)
        XCTAssertEqual(a.events.received, ["你好 👋"])

        // Two messages one way keep ONE counter.
        try a.driver.send("again")
        XCTAssertEqual(sequence(of: a.transport.sentText[0]), 1)
        pump(a, b)
        XCTAssertEqual(b.events.received, ["hello", "again"])

        try a.driver.end()
        XCTAssertEqual(a.transport.sentText, [[end]])
        XCTAssertEqual(a.driver.status, .ended)
        XCTAssertEqual(a.scheduler.liveDelays, [LINK_TEXT_END_ACK_TIMEOUT])
        pump(a, b)
        XCTAssertEqual(b.driver.status, .ended)
        pump(b, a)
        XCTAssertEqual(a.scheduler.liveCount, 0, "the barrier closed, so its timer is gone")
        XCTAssertEqual(a.driver.status, .ended)
        XCTAssertTrue(a.events.failures.isEmpty)
        XCTAssertTrue(b.events.failures.isEmpty)

        // Reopen on the SAME codecs: the sequence carries on.
        try openConversation(a, b)
        XCTAssertEqual(a.driver.status, .open)
        try a.driver.send("second conversation")
        XCTAssertEqual(sequence(of: a.transport.sentText[0]), 2)
        pump(a, b)
        XCTAssertEqual(b.events.received, ["hello", "again", "second conversation"])
    }

    // ── 3. pre-seal backpressure spends no nonce ────────────────────────────

    func testBackpressureBeforeSealingRefusesWithoutSpendingANonce() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        a.transport.setBuffered(2 << 20)
        XCTAssertThrowsError(try a.driver.send("too soon")) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .backpressured)
        }
        XCTAssertTrue(a.transport.sentText.isEmpty)
        XCTAssertFalse(a.driver.isTerminal, "backpressure is retryable, not terminal")
        XCTAssertTrue(a.events.failures.isEmpty)

        a.transport.setBuffered(0)
        try a.driver.send("first real message")
        let frames = a.transport.sentText
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(sequence(of: frames[0]), 0, "the refused message consumed no nonce")
        pump(a, b)
        XCTAssertEqual(b.events.received, ["first real message"])
    }

    // ── 4. residual parking keeps protected ahead of END ────────────────────

    /// The buffer can rise between the pre-seal check and the drain. The sealed
    /// frame must PARK, not be dropped, resealed or overtaken: its nonce is
    /// already spent, and an END that jumped it would close the conversation on
    /// the peer before the message it was ordered after.
    func testAProtectedFrameParkedByBackpressureIsNotOvertakenByEnd() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        // Call 0 is the pre-seal check; call 1 is the drain's.
        a.transport.setBufferedScript { index in index == 0 ? 0 : (2 << 20) }
        try a.driver.send("ordered first")
        XCTAssertTrue(a.transport.sentText.isEmpty, "parked, not sent")
        XCTAssertEqual(a.driver.queuedProtectedCount, 1)

        try a.driver.end()
        XCTAssertTrue(a.transport.sentText.isEmpty, "END may not overtake the parked frame")
        XCTAssertEqual(a.driver.queuedFrameCount, 2)

        a.transport.setBuffered(0)
        a.scheduler.firePolls()
        a.driver.settle()

        let wire = a.transport.sentText
        XCTAssertEqual(wire.count, 2)
        guard wire.count == 2 else { return }
        XCTAssertTrue(isProtected(wire[0]))
        XCTAssertEqual(wire[1], [end])
        pump(a, b)
        XCTAssertEqual(b.events.received, ["ordered first"])
        XCTAssertEqual(b.driver.status, .ended)
    }

    // ── 5. a gap with a protected frame still local ─────────────────────────

    func testAGapWithAProtectedFrameStillInTheOutboxFailsTextClosed() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        a.transport.setBufferedScript { index in index == 0 ? 0 : (2 << 20) }
        try a.driver.send("never left")
        XCTAssertEqual(a.driver.queuedProtectedCount, 1)

        XCTAssertFalse(a.driver.onTransportLost(a.identity),
                       "a lane that cannot prove its sequence has nothing to recover")
        XCTAssertTrue(a.driver.isTerminal)
        XCTAssertEqual(a.driver.status, .failed)
        XCTAssertEqual(a.events.failures, [.protectedSendFailed])
        XCTAssertEqual(a.transport.closeCount, 0, "a text failure never closes the transport")
        _ = b
    }

    // ── 6. a closed channel reporting zero is not evidence ──────────────────

    /// The recovery coordinator closes and removes the channels BEFORE the
    /// policy runs, so a gap-time `bufferedAmount` of zero says nothing at all.
    /// The driver's own unflushed state is what has to answer.
    func testAGapAfterACloseThatZeroesTheBufferStillFailsTextClosed() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        // Pre-seal 0, then a non-zero post-send observation: the frame reached
        // the transport and has NOT been proven to have left it.
        a.transport.setBufferedScript { index in index == 0 ? 0 : (64 << 10) }
        try a.driver.send("handed over, not flushed")
        XCTAssertEqual(a.transport.sentText.count, 1)
        XCTAssertEqual(a.driver.queuedProtectedCount, 0)
        XCTAssertTrue(a.driver.hasUnflushedProtected)

        // Exactly what the coordinator does first.
        a.transport.close()
        XCTAssertEqual(a.transport.bufferedAmount(on: .text), 0)

        XCTAssertFalse(a.driver.onTransportLost(a.identity))
        XCTAssertTrue(a.driver.isTerminal)
        XCTAssertEqual(a.events.failures, [.protectedSendFailed])
        _ = b
    }

    // ── 7. an observed flush makes the same gap recoverable ─────────────────

    func testAZeroBufferObservationMakesTheGapRecoverableAndAttachPreservesCodecs() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        a.transport.setBuffered(0)
        try a.driver.send("flushed")
        XCTAssertFalse(a.driver.hasUnflushedProtected)
        pump(a, b)
        XCTAssertEqual(b.events.received, ["flushed"])

        XCTAssertTrue(a.driver.onTransportLost(a.identity),
                      "an open conversation is worth holding the link for")
        XCTAssertFalse(a.driver.isTerminal)
        XCTAssertEqual(a.driver.status, .ended)

        let codecsBefore = a.identity.codecs
        let replacement = TextTransport()
        try a.driver.onAttach(a.identity.replacingTransport(), replacement)
        XCTAssertNil(replacement.onFrame, "attach must not claim the route slot either")
        XCTAssertTrue(replacement.sentText.isEmpty, "consent is never replayed")
        XCTAssertTrue(a.identity.codecs === codecsBefore)

        // The peer's own gap, so both sides are `ended` and can reopen.
        XCTAssertTrue(b.driver.onTransportLost(b.identity))
        let peerReplacement = TextTransport()
        try b.driver.onAttach(b.identity.replacingTransport(), peerReplacement)

        try a.driver.open()
        for frame in replacement.takeSentText() { b.driver.admitTextFrame(frame) }
        try b.driver.accept()
        for frame in peerReplacement.takeSentText() { a.driver.admitTextFrame(frame) }
        XCTAssertEqual(a.driver.status, .open)

        try a.driver.send("after the rebuild")
        let frames = replacement.sentText.filter { isProtected($0) }
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(sequence(of: frames[0]), 1, "the link's ONE sender carried on")
        for frame in replacement.takeSentText() { b.driver.admitTextFrame(frame) }
        XCTAssertEqual(b.events.received, ["flushed", "after the rebuild"])
    }

    // ── 8. a protected refusal ends the lane and nothing else ───────────────

    func testAProtectedSendRefusalFailsOnlyTextAndReportsOnce() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        a.transport.setBuffered(0)
        a.transport.failSends(where: { $0.count > 1 })
        try a.driver.send("refused on the wire")

        XCTAssertTrue(a.driver.isTerminal)
        XCTAssertEqual(a.driver.status, .failed)
        XCTAssertEqual(a.events.failures, [.protectedSendFailed])
        XCTAssertEqual(a.transport.closeCount, 0,
                       "a refused frame poisons the text codecs, not the transport")
        XCTAssertFalse(a.driver.isLinkEnded)

        // Repeated terminal inputs report nothing more.
        a.driver.admitTextFrame([request])
        XCTAssertFalse(a.driver.onTransportLost(a.identity))
        XCTAssertEqual(a.events.failures, [.protectedSendFailed])
        _ = b
    }

    // ── 9. a control refusal does not poison ────────────────────────────────

    func testAControlSendRefusalClosesTheTransportWithoutPoisoningOrGapping() throws {
        let r = solo()
        r.transport.failSends(where: { $0.count == 1 })

        try r.driver.open()
        XCTAssertFalse(r.driver.isTerminal, "a control consumes no nonce")
        XCTAssertEqual(r.events.failures, [])
        XCTAssertEqual(r.driver.status, .waitingAccept,
                       "the gap is the coordinator's one policy call, not this")
        XCTAssertEqual(r.transport.closeCount, 1)

        // The coordinator's single policy call, afterwards.
        XCTAssertTrue(r.driver.onTransportLost(r.identity),
                      "the interrupted request is still worth recovering")
        XCTAssertEqual(r.driver.status, .ended)
        XCTAssertFalse(r.driver.isTerminal)
        XCTAssertEqual(r.transport.closeCount, 1, "one close, however many reports")
    }

    // ── 10. a protected queued behind a failed control survives ─────────────

    func testAProtectedQueuedBehindAFailedControlIsNotClearedBeforeTheGap() throws {
        let (a, b) = pair()
        try openConversation(a, b)
        a.transport.setBuffered(0)

        // A duplicate inbound REQUEST while open makes the lane emit REJECT.
        a.transport.gateSends(where: { $0 == [self.reject] })
        a.transport.failSends(where: { $0 == [self.reject] })

        let admitted = expectation(description: "inbound request routed")
        DispatchQueue.global().async {
            a.driver.admitTextFrame([self.request])
            admitted.fulfill()
        }
        XCTAssertTrue(a.transport.waitUntilGated(), "the REJECT never reached the transport")

        // Queued BEHIND the control that is about to fail.
        try a.driver.send("behind the control")
        XCTAssertEqual(a.driver.queuedProtectedCount, 1)

        a.transport.releaseGate()
        wait(for: [admitted], timeout: 5.0)
        a.driver.settle()

        XCTAssertFalse(a.driver.isTerminal, "a control refusal poisons nothing")
        XCTAssertEqual(a.driver.queuedProtectedCount, 1,
                       "the sealed frame is not silently dropped")
        XCTAssertEqual(a.transport.closeCount, 1)

        XCTAssertFalse(a.driver.onTransportLost(a.identity))
        XCTAssertTrue(a.driver.isTerminal)
        XCTAssertEqual(a.events.failures, [.protectedSendFailed])
        _ = b
    }

    // ── 11. the timer constants, and stale callbacks ────────────────────────

    func testConsentAndEndAckTimersUseTheDerivedSecondConstants() throws {
        XCTAssertEqual(LINK_TEXT_CONSENT_TIMEOUT, 600)
        XCTAssertEqual(LINK_TEXT_END_ACK_TIMEOUT, 30)
        XCTAssertEqual(LINK_TEXT_CONSENT_TIMEOUT, Double(LINK_TEXT_CONSENT_TIMEOUT_MS) / 1000)
        XCTAssertEqual(LINK_TEXT_END_ACK_TIMEOUT, Double(LINK_TEXT_END_ACK_TIMEOUT_MS) / 1000)

        let (a, b) = pair()
        try a.driver.open()
        XCTAssertEqual(a.scheduler.allDelays, [LINK_TEXT_CONSENT_TIMEOUT])
        pump(a, b)
        try b.driver.accept()
        pump(b, a)
        try a.driver.end()
        XCTAssertEqual(a.scheduler.allDelays, [LINK_TEXT_CONSENT_TIMEOUT, LINK_TEXT_END_ACK_TIMEOUT])
    }

    func testACancelledConsentCallbackThatAlreadyStartedRunningIsInert() throws {
        let (a, b) = pair()
        try a.driver.open()
        pump(a, b)
        try b.driver.accept()
        pump(b, a)
        XCTAssertEqual(a.driver.status, .open)

        // The consent handle was cancelled when ACCEPT landed; a real timer that
        // had already begun running arrives anyway.
        a.scheduler.fireCancelledOnly()
        XCTAssertEqual(a.driver.status, .open, "a cancelled wake-up may not end the conversation")
        XCTAssertTrue(a.events.failures.isEmpty)
    }

    func testAConsentTimeoutThatReallyFiresEndsTheAttempt() throws {
        let r = solo()
        try r.driver.open()
        XCTAssertEqual(r.driver.status, .waitingAccept)
        r.scheduler.fireAll()
        XCTAssertEqual(r.driver.status, .ended)
        XCTAssertEqual(r.transport.sentText, [[request], [end]])
    }

    func testAFlushPollForAReplacedEpochIsInert() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        a.transport.setBufferedScript { index in index == 0 ? 0 : (64 << 10) }
        try a.driver.send("outstanding")
        XCTAssertTrue(a.driver.hasUnflushedProtected)
        XCTAssertGreaterThan(a.scheduler.liveCount, 0, "a flush poll is armed")

        XCTAssertFalse(a.driver.onTransportLost(a.identity))
        // The poll belongs to an epoch that no longer exists.
        a.transport.setBuffered(0)
        a.scheduler.fireAll()
        a.driver.settle()
        XCTAssertEqual(a.events.failures, [.protectedSendFailed], "still exactly one")
        _ = b
    }

    // ── 12. a foreign identity moves nothing ────────────────────────────────

    func testAForeignIdentityIsRefusedWithoutMovingState() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        let foreign = LinkIdentity(peerId: "someone-else", role: .initiator, sas: "654321",
                                   codecs: LinkCodecs(sendKey: keyTwo, recvKey: keyOne))
        XCTAssertFalse(a.driver.onTransportLost(foreign))
        XCTAssertEqual(a.driver.status, .open, "another link's gap is not this link's")

        XCTAssertThrowsError(try a.driver.onAttach(foreign, TextTransport())) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .identityMismatch)
        }
        XCTAssertEqual(a.driver.status, .open)

        // Same peer and SAS, a DIFFERENT codec object: the catastrophe case.
        let sameLooking = LinkIdentity(peerId: a.identity.peerId, role: a.identity.role,
                                       sas: a.identity.sas,
                                       codecs: LinkCodecs(sendKey: keyOne, recvKey: keyTwo))
        XCTAssertThrowsError(try a.driver.onAttach(sameLooking, TextTransport())) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .identityMismatch)
        }
        XCTAssertEqual(a.driver.status, .open)
        _ = b
    }

    func testAReplacementThatCannotCarryALaneIsRefused() throws {
        let r = solo()
        XCTAssertThrowsError(try r.driver.onAttach(r.identity.replacingTransport(),
                                                   DeadReplacement())) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .replacementNotLive)
        }
    }

    func testStaleWorkCannotSendOnAReplacement() throws {
        let (a, b) = pair()
        try openConversation(a, b)
        a.transport.setBuffered(0)
        try a.driver.send("before the gap")
        _ = a.transport.takeSentText()

        XCTAssertTrue(a.driver.onTransportLost(a.identity))
        let replacement = TextTransport()
        try a.driver.onAttach(a.identity.replacingTransport(), replacement)

        // Every wake-up armed for the dead generation, all at once.
        a.scheduler.fireAll()
        a.driver.settle()
        XCTAssertTrue(replacement.sentText.isEmpty, "no stale frame reached the replacement")
        _ = b
    }

    // ── 13. reentrancy and a genuine serial queue ───────────────────────────

    /// An owner callback that calls straight back into the driver, while the
    /// transport's own queue is parked inside a delivery that wants the driver
    /// lock. A driver that sent, polled or closed under its lock wedges here.
    func testOwnerReentrancyAndTheTransportQueueDoNotDeadlock() throws {
        let (a, b) = pair()
        try openConversation(a, b)
        a.transport.setBuffered(0)

        // Park the transport queue behind an inbound frame that wants the driver
        // lock. Any transport call the driver makes under its own lock now has
        // to wait for a queue that is waiting for it.
        let inQueue = DispatchSemaphore(value: 0)
        let hold = DispatchSemaphore(value: 0)
        a.transport.queue.async {
            inQueue.signal()
            _ = hold.wait(timeout: .now() + 5.0)
            a.driver.admitTextFrame([self.request])
        }
        XCTAssertEqual(inQueue.wait(timeout: .now() + 5.0), .success)

        let done = expectation(description: "send returned")
        DispatchQueue.global().async {
            try? a.driver.send("through a parked queue")
            done.fulfill()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { hold.signal() }
        wait(for: [done], timeout: 5.0)

        // A duplicate REQUEST while open makes the lane emit REJECT, so the
        // parked delivery really did reach the session.
        a.driver.settle()
        XCTAssertTrue(a.transport.sentText.contains([reject]))
        _ = b
    }

    /// The owner replies from INSIDE the arrival callback. The reply must be
    /// sealed after the message it answers, on the driver whose event it is —
    /// and the delivery it re-entered must not restart underneath itself.
    func testAnOwnerCallbackMaySendFromInsideAnEventWithoutReordering() throws {
        let identityA = LinkIdentity(peerId: "peer-b", role: .initiator, sas: "123456",
                                     codecs: LinkCodecs(sendKey: keyOne, recvKey: keyTwo))
        let identityB = LinkIdentity(peerId: "peer-a", role: .responder, sas: "123456",
                                     codecs: LinkCodecs(sendKey: keyTwo, recvKey: keyOne))
        let transportA = TextTransport()
        let transportB = TextTransport()
        transportA.setBuffered(0)
        transportB.setBuffered(0)
        let eventsA = TextEvents()
        let eventsB = TextEvents()

        let driverA = LinkTextDriver(identity: identityA, transport: transportA,
                                     scheduler: RecordingScheduler(), maxFrameBytes: maxFrame,
                                     sendBufferHighWater: LINK_TEXT_SEND_HIGH_WATER,
                                     sendBufferPollInterval: 0.01,
                                     onEvent: { eventsA.append($0) })
        // Built after A, so the reply closure can name A's driver.
        var driverB: LinkTextDriver!
        let replies = HookCounter()
        driverB = LinkTextDriver(identity: identityB, transport: transportB,
                                 scheduler: RecordingScheduler(), maxFrameBytes: maxFrame,
                                 sendBufferHighWater: LINK_TEXT_SEND_HIGH_WATER,
                                 sendBufferPollInterval: 0.01,
                                 onEvent: { event in
            eventsB.append(event)
            guard case let .received(body) = event, body == "one" else { return }
            replies.bump()
            // Straight back into the driver whose callback this is.
            try? driverB.send("reply from inside the callback")
        })

        try driverA.open()
        for frame in transportA.takeSentText() { driverB.admitTextFrame(frame) }
        try driverB.accept()
        for frame in transportB.takeSentText() { driverA.admitTextFrame(frame) }
        XCTAssertEqual(driverA.status, .open)
        XCTAssertEqual(driverB.status, .open)

        try driverA.send("one")
        try driverA.send("two")
        let wire = transportA.sentText
        XCTAssertEqual(wire.count, 2)
        guard wire.count == 2 else { return }
        XCTAssertEqual(sequence(of: wire[0]), 0)
        XCTAssertEqual(sequence(of: wire[1]), 1)

        for frame in transportA.takeSentText() { driverB.admitTextFrame(frame) }
        XCTAssertEqual(eventsB.received, ["one", "two"], "wire order, never the callback's")
        XCTAssertEqual(replies.count, 1, "the re-entered delivery did not restart itself")

        let back = transportB.sentText.filter { isProtected($0) }
        XCTAssertEqual(back.count, 1)
        for frame in transportB.takeSentText() { driverA.admitTextFrame(frame) }
        XCTAssertEqual(eventsA.received, ["reply from inside the callback"])
        XCTAssertTrue(eventsA.failures.isEmpty)
        XCTAssertTrue(eventsB.failures.isEmpty)
    }

    /// The overlap neither reentrancy test above creates: a local send that has
    /// ALREADY taken the seal gate and now needs the transport's serial queue,
    /// while that queue is inside the delivery of an inbound message whose owner
    /// callback replies on the same driver.
    ///
    /// Both halves are real. The pre-seal backpressure probe enters the
    /// transport's queue synchronously, and that queue is exactly where inbound
    /// frames are delivered from — so a sender holding the gate across that probe
    /// waits for a queue whose current work is a callback waiting for the gate.
    /// Neither can advance, and no timer, epoch or terminal check can break it.
    ///
    /// Bounded on purpose: the delivery is released at the precise instant the
    /// sender asks for the buffer, and every wait has a deadline, so the wedge
    /// shows up as a failed expectation rather than a suite that never finishes.
    func testASealingSendAndAReplyFromInsideDeliveryDoNotDeadlock() throws {
        let identityA = LinkIdentity(peerId: "peer-b", role: .initiator, sas: "123456",
                                     codecs: LinkCodecs(sendKey: keyOne, recvKey: keyTwo))
        let identityB = LinkIdentity(peerId: "peer-a", role: .responder, sas: "123456",
                                     codecs: LinkCodecs(sendKey: keyTwo, recvKey: keyOne))
        let transportA = TextTransport()
        let transportB = TextTransport()
        transportA.setBuffered(0)
        transportB.setBuffered(0)
        let eventsA = TextEvents()
        let eventsB = TextEvents()

        let driverA = LinkTextDriver(identity: identityA, transport: transportA,
                                     scheduler: RecordingScheduler(), maxFrameBytes: maxFrame,
                                     sendBufferHighWater: LINK_TEXT_SEND_HIGH_WATER,
                                     sendBufferPollInterval: 0.01,
                                     onEvent: { eventsA.append($0) })
        var driverB: LinkTextDriver!
        driverB = LinkTextDriver(identity: identityB, transport: transportB,
                                 scheduler: RecordingScheduler(), maxFrameBytes: maxFrame,
                                 sendBufferHighWater: LINK_TEXT_SEND_HIGH_WATER,
                                 sendBufferPollInterval: 0.01,
                                 onEvent: { event in
            eventsB.append(event)
            guard case let .received(body) = event, body == "ping" else { return }
            try? driverB.send("reply from inside delivery")
        })

        try driverA.open()
        for frame in transportA.takeSentText() { driverB.admitTextFrame(frame) }
        try driverB.accept()
        for frame in transportB.takeSentText() { driverA.admitTextFrame(frame) }
        XCTAssertEqual(driverA.status, .open)
        XCTAssertEqual(driverB.status, .open)

        try driverA.send("ping")
        let inbound = transportA.takeSentText().filter { isProtected($0) }
        XCTAssertEqual(inbound.count, 1)
        guard let ping = inbound.first else { return }

        // The transport's queue is occupied by the inbound delivery, parked until
        // the local sender is about to need that same queue.
        let queueOccupied = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let delivered = expectation(description: "inbound delivery finished")
        transportB.queue.async {
            queueOccupied.signal()
            _ = release.wait(timeout: .now() + 5.0)
            driverB.admitTextFrame(ping)
            delivered.fulfill()
        }
        XCTAssertEqual(queueOccupied.wait(timeout: .now() + 5.0), .success,
                       "the transport queue never took the parked delivery")

        // Released exactly when the local sender asks the transport for its
        // buffer — the one interleaving that makes the two halves overlap.
        transportB.onNextBufferedProbe { release.signal() }

        let returned = expectation(description: "local send returned")
        DispatchQueue.global().async {
            try? driverB.send("local and concurrent")
            returned.fulfill()
        }
        wait(for: [delivered, returned], timeout: 5.0)

        driverB.settle()
        XCTAssertEqual(eventsB.received, ["ping"])

        // The gate still owns the nonces: seal order is wire order, so the peer
        // authenticates both without a gap.
        let wire = transportB.sentText.filter { isProtected($0) }
        XCTAssertEqual(wire.count, 2, "both sealed frames reached the wire")
        guard wire.count == 2 else { return }
        XCTAssertEqual([sequence(of: wire[0]), sequence(of: wire[1])], [0, 1],
                       "FIFO: the sequence a frame was sealed with is the one it left in")

        for frame in transportB.takeSentText() { driverA.admitTextFrame(frame) }
        XCTAssertEqual(Set(eventsA.received),
                       ["reply from inside delivery", "local and concurrent"])
        XCTAssertTrue(eventsA.failures.isEmpty)
        XCTAssertTrue(eventsB.failures.isEmpty)
        XCTAssertFalse(driverB.isTerminal)
    }

    /// Local intent with no channel under it. The lane would happily move — it
    /// has no notion of a transport — and the user would be shown a consent
    /// window for a REQUEST no peer ever received.
    func testLocalIntentIsRefusedWhileThereIsNoUsableTransport() throws {
        let r = solo()
        XCTAssertTrue(r.driver.onTransportLost(r.identity) == false,
                      "an idle lane has nothing to recover")
        XCTAssertThrowsError(try r.driver.open()) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .transportUnavailable)
        }
        XCTAssertEqual(r.driver.status, .idle, "nothing moved")
        XCTAssertEqual(r.scheduler.liveCount, 0, "and no consent window was armed")
        XCTAssertThrowsError(try r.driver.send("nowhere")) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .transportUnavailable)
        }

        // A replacement makes the same call work.
        let replacement = TextTransport()
        try r.driver.onAttach(r.identity.replacingTransport(), replacement)
        try r.driver.open()
        XCTAssertEqual(replacement.sentText, [[request]])
    }

    func testLocalIntentIsRefusedAfterAControlCouldNotBeWritten() throws {
        let r = solo()
        r.transport.failSends(where: { $0.count == 1 })
        try r.driver.open()
        XCTAssertEqual(r.transport.closeCount, 1)
        XCTAssertThrowsError(try r.driver.end()) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .transportUnavailable)
        }
        XCTAssertEqual(r.driver.status, .waitingAccept, "still the coordinator's call to make")
    }

    // ── 14. one terminal, whatever arrives afterwards ───────────────────────

    func testLinkEndEmitsExactlyOneTerminalAndLaterInputIsInert() throws {
        let (a, b) = pair()
        try openConversation(a, b)

        a.driver.onEnded(LinkRecoveryError.windowExpired)
        XCTAssertTrue(a.driver.isLinkEnded)
        XCTAssertTrue(a.driver.isTerminal)
        XCTAssertEqual(a.events.failures, [.linkEnded])

        a.driver.onEnded(LinkRecoveryError.cancelled)
        a.driver.admitTextFrame([request])
        XCTAssertFalse(a.driver.onTransportLost(a.identity))
        XCTAssertThrowsError(try a.driver.open()) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .linkEnded)
        }
        XCTAssertThrowsError(try a.driver.send("nowhere")) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .linkEnded)
        }
        a.scheduler.fireAll()
        a.driver.settle()
        XCTAssertEqual(a.events.failures, [.linkEnded], "at most one terminal, ever")
        _ = b
    }

    func testATerminalTextLaneRemainsTerminalAcrossAnAttach() throws {
        let (a, b) = pair()
        try openConversation(a, b)
        a.transport.setBuffered(0)
        a.transport.failSends(where: { $0.count > 1 })
        try a.driver.send("refused")
        XCTAssertTrue(a.driver.isTerminal)

        let replacement = TextTransport()
        try a.driver.onAttach(a.identity.replacingTransport(), replacement)
        XCTAssertTrue(a.driver.isTerminal)
        XCTAssertEqual(a.driver.status, .failed)
        XCTAssertThrowsError(try a.driver.open()) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .laneTerminal)
        }
        XCTAssertEqual(a.events.failures.count, 1)
        _ = b
    }

    // ── 15. still unreachable ───────────────────────────────────────────────

    func testTheFeatureFlagsRemainFalse() {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
    }
}

/// A replacement that satisfies the coordinator's protocol and nothing else, so
/// the driver's own composition boundary is the thing being tested.
private final class DeadReplacement: LinkReplacementTransport, @unchecked Sendable {
    var onReady: ((LinkIdentity) -> Void)?
    var onFrame: ((LinkLane, [UInt8]) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?
    func start() {}
    func receive(from: String, signal: JSONValue) {}
    func close() {}
}
