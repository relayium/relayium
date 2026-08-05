import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - deterministic fakes
//
// Private to this file. The runtime's question is neither driver's and not the
// lane owner's either: ONE initial transport, assembled at the exact moment it
// publishes, into one owner and one coordinator — and then taken apart again on
// demand, once, from any thread. So these fakes model the publication ORDER a
// real transport has (SAS, then ready, then the captured backlog with nothing in
// between), count how many times each callback slot was claimed, and let a test
// drive the two terminal callbacks a dying transport really emits.

/// The initial transport, with a genuine serial queue exactly like
/// `WebRTCLinkTransport`: `send`, `bufferedAmount`, `isClosed` and `close` all
/// enter it SYNCHRONOUSLY.
///
/// That is what makes "the runtime held its lock across a transport call" a real
/// deadlock rather than a style opinion.
private final class InitialTransport: LinkInitialTransport, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.relayium.test.session-runtime-transport")
    private let key = DispatchSpecificKey<Bool>()
    private let slots = NSLock()
    private let state = NSLock()

    private var _onSAS: ((String) -> Void)?
    private var _onReady: ((LinkIdentity) -> Void)?
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    private var _onError: ((Error) -> Void)?
    private var _onClose: (() -> Void)?
    /// How many times a NON-NIL route was installed. The runtime's second
    /// invariant in one number: exactly one installation, and it is the file
    /// driver's — never the runtime's.
    private var _frameSlotClaims = 0

    var onSAS: ((String) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onSAS }
        set { slots.lock(); defer { slots.unlock() }; _onSAS = newValue }
    }
    var onReady: ((LinkIdentity) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onReady }
        set { slots.lock(); defer { slots.unlock() }; _onReady = newValue }
    }
    var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onFrame }
        set {
            slots.lock()
            if newValue != nil { _frameSlotClaims += 1 }
            _onFrame = newValue
            let installed = newValue != nil ? _onRouteInstalled : nil
            slots.unlock()
            // Off the lock, because a test uses this to land a `stop()` from
            // another thread and that thread must not need `slots`.
            installed?()
        }
    }

    /// Runs the instant a route is installed — which the file driver does as the
    /// LAST act of its initializer, so this is a barrier INSIDE publication:
    /// the owner is built but nothing has claimed the runtime's state yet.
    var onRouteInstalled: (() -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onRouteInstalled }
        set { slots.lock(); defer { slots.unlock() }; _onRouteInstalled = newValue }
    }
    private var _onRouteInstalled: (() -> Void)?
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
    private var _startCount = 0
    private var _captured: [(LinkLane, [UInt8])] = []
    /// Whether the four callbacks were all installed by the time `start()` ran.
    private var _callbacksAtStart = false

    init() { queue.setSpecific(key: key, value: true) }

    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: key) == true { return body() }
        return queue.sync { body() }
    }

    // ── the live-transport seam ─────────────────────────────────────────────

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        var closed = false
        onQueue {
            state.lock()
            closed = _closed
            if !closed { _sent.append((lane, bytes)) }
            state.unlock()
        }
        if closed { throw LinkTransportError.closed }
    }

    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }

    var isClosed: Bool { onQueue { state.lock(); defer { state.unlock() }; return _closed } }

    func close() {
        onQueue { state.lock(); _closed = true; _closeCount += 1; state.unlock() }
    }

    /// Enters the queue and refuses once closed, which is `startLocked`'s own
    /// `guard !closed, !started` — see `LinkInitialTransport.start()`. A double
    /// that started a closed transport would let the runtime's start/stop seam
    /// look safe here and be unsafe against the transport it is written for.
    func start() {
        let wired = onSAS != nil && onReady != nil && onError != nil && onClose != nil
        onQueue {
            state.lock()
            if !_closed {
                _startCount += 1
                _callbacksAtStart = wired
            }
            state.unlock()
        }
    }

    func receive(from: String, signal: JSONValue) {}

    // ── delivery ────────────────────────────────────────────────────────────

    func deliver(_ lane: LinkLane, _ bytes: [UInt8]) { onFrame?(lane, bytes) }

    /// The same, on the transport's OWN queue — which is where the real one
    /// publishes from, and the only way a lock held across a transport call
    /// shows up as a deadlock instead of as luck.
    func deliverOnQueue(_ lane: LinkLane, _ bytes: [UInt8]) {
        queue.async { [weak self] in self?.onFrame?(lane, bytes) }
    }

    /// A frame the peer sent before this transport had a consumer.
    func capture(_ lane: LinkLane, _ bytes: [UInt8]) {
        state.lock(); _captured.append((lane, bytes)); state.unlock()
    }

    /// Announce the SAS, publish, and replay the captured backlog with NOTHING
    /// in between — which is exactly what makes `onReady` a synchronous barrier.
    ///
    /// - Parameter beforeReplay: run after `onReady` returned and before the
    ///   first captured frame, so a test can state what had to be true by then.
    func publish(_ identity: LinkIdentity,
                 sas: String = "424242",
                 beforeReplay: (() -> Void)? = nil) {
        onSAS?(sas)
        onReady?(identity)
        beforeReplay?()
        state.lock()
        let backlog = _captured
        _captured = []
        state.unlock()
        for (lane, bytes) in backlog { onFrame?(lane, bytes) }
    }

    /// Publication on the transport's own queue, as the real one does it.
    func publishOnQueue(_ identity: LinkIdentity) {
        queue.async { [weak self] in self?.publish(identity) }
    }

    // ── the two terminal callbacks a dying transport really emits ───────────

    /// `WebRTCLinkTransport` closes itself first, then reports `onError`, then
    /// `onClose` — always last, and always exactly once.
    func die(error: Error?) {
        close()
        if let error { onError?(error) }
        onClose?()
    }

    // ── observation ─────────────────────────────────────────────────────────

    func sent(on lane: LinkLane) -> [[UInt8]] {
        state.lock(); defer { state.unlock() }
        return _sent.filter { $0.lane == lane }.map(\.bytes)
    }

    var closeCount: Int { state.lock(); defer { state.unlock() }; return _closeCount }
    var startCount: Int { state.lock(); defer { state.unlock() }; return _startCount }
    var callbacksInstalledBeforeStart: Bool {
        state.lock(); defer { state.unlock() }; return _callbacksAtStart
    }
}

/// A replacement the coordinator can build, wire and publish.
private final class ReplacementTransport: LinkReplacementTransport, LinkLiveTransport,
                                          @unchecked Sendable {
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

    func start() {}
    func receive(from: String, signal: JSONValue) {}
    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        state.lock(); defer { state.unlock() }
        guard !_closed else { throw LinkTransportError.closed }
        _sent.append((lane, bytes))
    }
    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }
    func close() { state.lock(); _closed = true; state.unlock() }

    func publish(_ identity: LinkIdentity) { onReady?(identity) }
    func deliver(_ lane: LinkLane, _ bytes: [UInt8]) { onFrame?(lane, bytes) }

    func sent(on lane: LinkLane) -> [[UInt8]] {
        state.lock(); defer { state.unlock() }
        return _sent.filter { $0.lane == lane }.map(\.bytes)
    }
}

/// A scheduler that records rather than fires. The recovery window and the retry
/// cadence are decisions; a test that waited ninety seconds for one is a test
/// nobody runs.
private final class ManualScheduler: LinkRecoveryScheduler, @unchecked Sendable {
    private final class Timer: LinkRecoveryTimer {
        private let lock = NSLock()
        private var _cancelled = false
        var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return _cancelled }
        func cancel() { lock.lock(); _cancelled = true; lock.unlock() }
    }

    private let lock = NSLock()
    private var pending: [(delay: TimeInterval, body: () -> Void, timer: Timer)] = []

    func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
        let timer = Timer()
        lock.lock(); pending.append((delay, body, timer)); lock.unlock()
        return timer
    }

    /// Fire every live wake-up whose delay matches, in the order they were made.
    func fire(after delay: TimeInterval) {
        lock.lock()
        let due = pending.filter { $0.delay == delay && !$0.timer.cancelled }
        pending.removeAll { $0.delay == delay }
        lock.unlock()
        for item in due { item.body() }
    }
}

/// Everything the runtime told its owner, without a captured `var` two threads
/// could write.
private final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [LinkSessionRuntimeEvent] = []
    /// Runs on every event, with no lock of this recorder's held, so a test can
    /// make a client callback re-enter the runtime.
    var hook: ((LinkSessionRuntimeEvent) -> Void)?
    /// Runs BEFORE the event is recorded, so a test can hold one delivery open
    /// and then state what the recorded ORDER had to be.
    ///
    /// The distinction is the whole point: recording first would make every
    /// ordering assertion below true of a runtime that merely STARTED the two
    /// deliveries in the right order, which is exactly the bug.
    var beforeRecording: ((LinkSessionRuntimeEvent) -> Void)?

    func append(_ event: LinkSessionRuntimeEvent) {
        beforeRecording?(event)
        lock.lock(); items.append(event); lock.unlock()
        hook?(event)
    }

    var all: [LinkSessionRuntimeEvent] { lock.lock(); defer { lock.unlock() }; return items }

    var ends: [LinkSessionRuntimeEnd] {
        all.compactMap { if case let .ended(reason) = $0 { return reason } else { return nil } }
    }
    var received: [LinkReceivedBatch] {
        all.compactMap { if case let .received(batch) = $0 { return batch } else { return nil } }
    }
    var textEvents: [LinkTextDriverEvent] {
        all.compactMap { if case let .text(event) = $0 { return event } else { return nil } }
    }
    var fileEvents: [LinkFileDriverEvent] {
        all.compactMap { if case let .file(event) = $0 { return event } else { return nil } }
    }
    var sasDigits: [String] {
        all.compactMap { if case let .sas(digits) = $0 { return digits } else { return nil } }
    }
    var opened: [String] {
        all.compactMap { if case let .opened(peerId, _) = $0 { return peerId } else { return nil } }
    }
}

/// Every replacement the coordinator asked for, readable from a driver's queue
/// as well as the test's.
private final class BuiltReplacements: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ReplacementTransport] = []
    func append(_ transport: ReplacementTransport) {
        lock.lock(); items.append(transport); lock.unlock()
    }
    var all: [ReplacementTransport] { lock.lock(); defer { lock.unlock() }; return items }
    var count: Int { lock.lock(); defer { lock.unlock() }; return items.count }
}

final class LinkSessionRuntimeTests: XCTestCase {

    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-runtime-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // MARK: - harness

    private let sendKey = [UInt8](repeating: 0x11, count: 32)
    private let recvKey = [UInt8](repeating: 0x22, count: 32)

    private struct Harness {
        let runtime: LinkSessionRuntime
        let transport: InitialTransport
        let identity: LinkIdentity
        let codecs: LinkCodecs
        /// Seals with the runtime's RECEIVE key, so its frames really decrypt.
        let peer: RealtimeSender
        let events: EventRecorder
        let scheduler: ManualScheduler
        let replacements: BuiltReplacements
    }

    /// A runtime, the initial transport under it, and the peer that talks to it.
    ///
    /// `role` decides who drives a rebuild, exactly as the first connection
    /// settled it: the gap tests below use `.initiator` because that is the side
    /// that allocates an attempt without waiting for an offer.
    private func harness(role: Role = .initiator,
                         receiveDirectory: URL? = nil,
                         factoryFails: Bool = false) -> Harness {
        let codecs = LinkCodecs(sendKey: sendKey, recvKey: recvKey)
        let identity = LinkIdentity(peerId: "peer-b", role: role, sas: "424242",
                                    codecs: codecs, authenticationGeneration: 2)
        let transport = InitialTransport()
        let events = EventRecorder()
        let scheduler = ManualScheduler()
        let replacements = BuiltReplacements()
        let runtime = LinkSessionRuntime(
            transport: transport,
            receiveDirectory: receiveDirectory ?? dir,
            scheduler: scheduler,
            replacementFactory: { _ in
                if factoryFails { throw LinkTransportError.notReady }
                let replacement = ReplacementTransport()
                replacements.append(replacement)
                return replacement
            },
            onEvent: { events.append($0) })
        return Harness(runtime: runtime, transport: transport, identity: identity,
                       codecs: codecs, peer: RealtimeSender(sessionKey: recvKey),
                       events: events, scheduler: scheduler, replacements: replacements)
    }

    /// Started and published: the ordinary state every operation below assumes.
    private func opened(_ h: Harness) {
        h.runtime.start()
        h.transport.publish(h.identity)
        h.runtime.settle()
    }

    /// Give the link work worth holding: a consented inbound batch, so both
    /// lanes' recovery policy answers "hold" and a lost transport becomes a GAP.
    ///
    /// An idle link is declined and ended instead — correctly, and
    /// `testAnIdleLinkIsNotHeldAcrossAGap` states that — so every test below that
    /// is about a gap has to say what the gap is for.
    private func holdingAReceive(_ h: Harness) throws {
        for frame in try h.peer.batchFrames([meta("held.bin", 2 * CHUNK_SIZE)]) {
            h.transport.deliver(.file, frame)
        }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()
    }

    private func meta(_ name: String, _ size: Int, path: String? = nil) -> FileMeta {
        FileMeta(name: name, size: size, path: path)
    }

    private func relative(_ url: URL) -> String {
        String(url.standardized.path.dropFirst(dir.standardized.path.count + 1))
    }

    private func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent(path).path)
    }

    // MARK: - assembly

    /// The runtime composes; it never derives. Both lanes run on the EXACT
    /// `LinkCodecs` object the publication carried, because two objects would be
    /// two AEAD sequences counting from zero under one pair of session keys.
    func testTheRuntimeReusesTheExactIdentityAndCodecsThePublicationCarried() throws {
        let h = harness()
        opened(h)

        let owner = try XCTUnwrap(h.runtime.owner, "publication assembles the lane owner")
        XCTAssertTrue(owner.identity.codecs === h.codecs,
                      "the one codec object, by identity — equal contents would be the catastrophe")
        XCTAssertEqual(owner.identity.peerId, h.identity.peerId)
        XCTAssertEqual(owner.identity.role, h.identity.role)
        XCTAssertEqual(owner.identity.sas, h.identity.sas)
        XCTAssertEqual(owner.identity.authenticationGeneration,
                       h.identity.authenticationGeneration)

        let coordinator = try XCTUnwrap(h.runtime.coordinator,
                                        "and the coordinator that holds it across a gap")
        XCTAssertTrue(coordinator.identity.codecs === h.codecs,
                      "the coordinator holds that same one, never a rebuilt one")
    }

    /// The route goes in INSIDE `onReady`, before a single captured frame
    /// replays. A route installed one step later is a backlog already delivered
    /// to nobody — and those frames belong to receiver codecs whose sequence has
    /// to stay continuous.
    func testTheOwnerRouteIsInstalledInsideOnReadyBeforeCapturedFramesReplay() throws {
        let h = harness()
        let files = [meta("in.bin", CHUNK_SIZE)]
        for frame in try h.peer.batchFrames(files) { h.transport.capture(.file, frame) }

        h.runtime.start()
        h.transport.publish(h.identity)
        h.runtime.settle()

        XCTAssertTrue(h.events.fileEvents.contains(.inboundOffer(batch: 1, files: files)),
                      "the backlog reached the file lane, so the route existed when it replayed")
        XCTAssertEqual(h.transport.frameSlotClaims, 1,
                       "and exactly one owner claimed the one route slot")
    }

    /// The owner is bound to the coordinator before publication is complete: a
    /// captured frame that replays finds an owner that can already answer for a
    /// rebuild, not one that is still being wired.
    func testTheOwnerIsBoundToTheCoordinatorBeforeTheBacklogReplays() throws {
        let h = harness()
        h.transport.capture(.file, try h.peer.batchFrames([meta("in.bin", 8)])[0])

        let boundAtReplay = NSLock()
        var bound: Bool?
        h.runtime.start()
        h.transport.publish(h.identity) { [weak runtime = h.runtime] in
            boundAtReplay.lock()
            bound = runtime?.coordinator?.onAttach != nil && runtime?.coordinator?.onFrame != nil
            boundAtReplay.unlock()
        }
        h.runtime.settle()

        boundAtReplay.lock(); defer { boundAtReplay.unlock() }
        XCTAssertEqual(bound, true,
                       "all four owner hooks are on the coordinator before the replay")
    }

    /// One transport, one route, BOTH lanes. The file driver demultiplexes and
    /// hands text straight out; nothing here re-demuxes.
    func testBothLanesWorkOverTheOneRoute() throws {
        let h = harness()
        opened(h)

        let files = [meta("in.bin", CHUNK_SIZE)]
        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        h.transport.deliver(.text, [LINK_TEXT_REQUEST])
        h.runtime.settle()

        XCTAssertTrue(h.events.fileEvents.contains(.inboundOffer(batch: 1, files: files)),
                      "the file lane read its manifest")
        XCTAssertTrue(h.events.textEvents.contains(.status(.incomingRequest)),
                      "and the text lane read its request over the same route")
        XCTAssertEqual(h.transport.frameSlotClaims, 1, "still one installation")
    }

    /// The production transport IS this seam's type.
    ///
    /// The same property `LinkRecoveryWiringTests` exists for, one layer up: a
    /// conformance that had to be adapted by a shim would mean the seam had been
    /// written against a transport that does not exist, and every behavioural
    /// test above would stay green while the runtime remained unbuildable.
    func testTheProductionTransportIsTheInitialTransportSeam() {
        // The annotation is what is load-bearing: this line only builds while
        // `WebRTCLinkTransport` satisfies the seam with no adapter. Written as a
        // compile-time pin rather than an `is` check because the compiler already
        // proves the conformance statically — which is the point, and which makes
        // a runtime test of it a warning rather than evidence.
        let seam: LinkInitialTransport.Type = WebRTCLinkTransport.self
        XCTAssertTrue(ObjectIdentifier(seam) == ObjectIdentifier(WebRTCLinkTransport.self))
    }

    /// The SAS is announced before the lanes finish opening, exactly as the
    /// transport produces it, and publication is reported once.
    func testPublicationReportsTheSASAndThenTheOpenLink() {
        let h = harness()
        opened(h)

        XCTAssertEqual(h.events.sasDigits, ["424242"])
        XCTAssertEqual(h.events.opened, ["peer-b"])
        guard let sasIndex = h.events.all.firstIndex(where: {
            if case .sas = $0 { return true } else { return false } }),
              let openIndex = h.events.all.firstIndex(where: {
                  if case .opened = $0 { return true } else { return false } }) else {
            return XCTFail("both lifecycle events are reported")
        }
        XCTAssertLessThan(sasIndex, openIndex, "the digits come first, as the transport emits them")
    }

    // MARK: - start and stop

    /// Every callback is installed BEFORE the transport is started: the real one
    /// stores its slots unsynchronised and replays nothing, so a slot written
    /// after `start()` is both a data race and an event already delivered to
    /// nobody.
    func testStartInstallsEveryCallbackBeforeItStartsTheTransport() {
        let h = harness()
        h.runtime.start()

        XCTAssertTrue(h.transport.callbacksInstalledBeforeStart,
                      "SAS, ready, error and close were all wired before start()")
        XCTAssertEqual(h.transport.startCount, 1)
        XCTAssertEqual(h.transport.frameSlotClaims, 0,
                       "and the runtime installs no route of its own")
    }

    /// The four callbacks go in when this runtime is CONSTRUCTED, not when it is
    /// started.
    ///
    /// That is what makes "installed before start" structural rather than merely
    /// ordered. Installing them in `start()` would leave a window in which a
    /// concurrent `stop()` closes a transport that is still being wired — and
    /// closing that window by holding a lock across the four slot writes would
    /// mean holding a lock across a call to the transport, which is the one thing
    /// this runtime's synchronization rule forbids. Doing it in `init` removes
    /// the race rather than guarding it: no other thread can hold this object yet.
    func testTheCallbacksAreInstalledByConstruction() {
        let h = harness()   // built, never started

        XCTAssertNotNil(h.transport.onSAS)
        XCTAssertNotNil(h.transport.onReady, "a publication has somewhere to go")
        XCTAssertNotNil(h.transport.onError)
        XCTAssertNotNil(h.transport.onClose)
        XCTAssertEqual(h.transport.startCount, 0, "and nothing has been started")
        XCTAssertEqual(h.transport.frameSlotClaims, 0,
                       "and no route is ever this runtime's to install")
    }

    /// `start()` is the contract. A transport that publishes before it — or that
    /// dies before it — reaches a runtime that assembles nothing and says nothing.
    func testATransportThatSpeaksBeforeStartIsIgnored() {
        let h = harness()

        h.transport.publish(h.identity)
        h.transport.die(error: LinkTransportError.closed)

        XCTAssertTrue(h.events.all.isEmpty, "not a SAS, not an open link, not an end")
        XCTAssertNil(h.runtime.owner, "and nothing was assembled")
    }

    func testStartIsIdempotent() {
        let h = harness()
        h.runtime.start()
        h.runtime.start()
        h.runtime.start()

        XCTAssertEqual(h.transport.startCount, 1, "a second start opens no second connection")
    }

    func testStopIsIdempotentAndEndsExactlyOnce() {
        let h = harness()
        opened(h)
        h.runtime.stop()
        h.runtime.stop()

        XCTAssertEqual(h.events.ends, [.stopped], "one terminal report, whatever the caller does")
    }

    /// Stop while still establishing: nothing was assembled, so the transport
    /// itself is what has to be closed.
    func testStopWhileEstablishingClosesTheTransportAndEndsOnce() {
        let h = harness()
        h.runtime.start()
        h.runtime.stop()

        XCTAssertEqual(h.events.ends, [.stopped])
        XCTAssertGreaterThanOrEqual(h.transport.closeCount, 1, "the transport does not linger")
        XCTAssertNil(h.runtime.owner, "and nothing was assembled")
    }

    /// A publication that arrives after `stop()` is not a link: it must assemble
    /// nothing, report nothing, and leave the terminal state alone.
    func testAPublicationAfterStopIsIgnored() {
        let h = harness()
        h.runtime.start()
        h.runtime.stop()
        h.transport.publish(h.identity)

        XCTAssertEqual(h.events.ends, [.stopped])
        XCTAssertTrue(h.events.opened.isEmpty, "no link was opened after the runtime ended")
        XCTAssertNil(h.runtime.owner)
    }

    /// Stop while open ends BOTH lanes through the coordinator — which is what
    /// discards an uncommitted destination — and closes the transport.
    func testStopWhileOpenEndsBothLanesAndClosesTheTransport() throws {
        let h = harness()
        opened(h)
        // Held before the stop: a runtime that has ended releases both of the
        // objects it assembled, which is the point — so the aftermath is only
        // inspectable through a reference the caller kept.
        let coordinator = try XCTUnwrap(h.runtime.coordinator)
        let owner = try XCTUnwrap(h.runtime.owner)

        h.runtime.stop()
        owner.settle()

        XCTAssertTrue(h.events.fileEvents.contains(.failed(.linkEnded)),
                      "the file lane was told the link ended")
        XCTAssertEqual(coordinator.phase, .ended)
        XCTAssertTrue(owner.isLinkEnded, "and so was the whole owner")
        XCTAssertNil(h.runtime.owner, "which this runtime no longer holds")
        XCTAssertGreaterThanOrEqual(h.transport.closeCount, 1)
        XCTAssertEqual(h.events.ends, [.stopped],
                       "and the lanes' own terminal reports do not become a second end")
    }

    /// Stop during a gap. The held link has no transport under it, and ending it
    /// must still settle the coordinator rather than leave a window running.
    func testStopWhileInterruptedEndsTheHeldLink() throws {
        let h = harness()
        opened(h)
        try holdingAReceive(h)
        h.transport.die(error: LinkTransportError.closed)
        h.runtime.settle()
        let coordinator = try XCTUnwrap(h.runtime.coordinator)
        XCTAssertEqual(coordinator.phase, .interrupted, "the gap is open")

        h.runtime.stop()

        XCTAssertEqual(coordinator.phase, .ended, "no window is left running")
        XCTAssertEqual(h.events.ends, [.stopped])
    }

    /// The terminal callbacks of a transport that already died must not repaint
    /// a runtime that has already finished.
    func testTerminalCallbacksAfterStopAreInert() {
        let h = harness()
        opened(h)
        h.runtime.stop()
        let after = h.events.all.count

        h.transport.die(error: LinkTransportError.closed)
        h.runtime.settle()

        XCTAssertEqual(h.events.ends, [.stopped])
        XCTAssertEqual(h.events.all.count, after,
                       "a dead transport's callbacks produce nothing at all")
    }

    // MARK: - the initial transport's two terminal callbacks

    /// Before readiness there is no coordinator to own the dedupe, so the
    /// runtime owns it: `onError` then `onClose` is ONE visible end.
    func testAFailureBeforeReadinessEndsTheRuntimeExactlyOnce() {
        let h = harness()
        h.runtime.start()
        h.transport.die(error: LinkTransportError.notReady)

        XCTAssertEqual(h.events.ends, [.establishmentFailed])
        XCTAssertNil(h.runtime.owner, "nothing was ever assembled")
    }

    /// A transport that closes without failing is not a failure, and it is still
    /// exactly one end.
    func testACloseBeforeReadinessEndsTheRuntimeExactlyOnce() {
        let h = harness()
        h.runtime.start()
        h.transport.die(error: nil)

        XCTAssertEqual(h.events.ends, [.establishmentClosed])
    }

    /// After readiness the coordinator owns the dedupe, structurally: the dying
    /// transport stops being current in the same step that handles its first
    /// terminal event, so `onError` + `onClose` buy exactly ONE gap.
    func testAfterReadinessErrorAndCloseProduceOneGap() throws {
        let h = harness()
        opened(h)
        try holdingAReceive(h)

        h.transport.die(error: LinkTransportError.closed)
        h.runtime.settle()

        XCTAssertEqual(h.replacements.count, 1,
                       "one recovery attempt, not one per terminal callback")
        XCTAssertEqual(h.runtime.coordinator?.phase, .interrupted)
        XCTAssertTrue(h.events.ends.isEmpty, "a gap is not an end")
    }

    /// A link with nothing worth recovering is not held: the owner's policy
    /// declines, and the coordinator ends it rather than spending a ninety-second
    /// window and the initiator's ICE allocations on an idle conversation.
    func testAnIdleLinkIsNotHeldAcrossAGap() {
        let h = harness()
        opened(h)

        h.transport.die(error: nil)
        h.runtime.settle()

        XCTAssertEqual(h.replacements.count, 0, "no rebuild is attempted")
        XCTAssertEqual(h.events.ends, [.linkEnded], "and it is one ordinary end of session")
    }

    /// A close with no preceding failure still has to reach the coordinator: it
    /// is the only terminal callback a cleanly-closed transport emits.
    func testACloseWithoutAFailureAfterReadinessStillReportsTheGap() throws {
        let h = harness()
        opened(h)
        try holdingAReceive(h)

        h.transport.onClose?()
        h.runtime.settle()

        XCTAssertEqual(h.runtime.coordinator?.phase, .interrupted)
        XCTAssertEqual(h.replacements.count, 1)
    }

    /// The whole point of holding the link: a rebuild published under the same
    /// authentication reaches BOTH lanes, and the file lane asks to resume
    /// before the coordinator makes it current.
    func testARebuildPublishedThroughTheCoordinatorReachesBothLanes() throws {
        let h = harness()
        opened(h)
        // A consented inbound batch, so the file lane owes a RESUME_REQ.
        for frame in try h.peer.batchFrames([meta("in.bin", 2 * CHUNK_SIZE)]) {
            h.transport.deliver(.file, frame)
        }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()

        h.transport.die(error: LinkTransportError.closed)
        h.runtime.settle()
        let replacement = try XCTUnwrap(h.replacements.all.first)
        replacement.publish(h.identity.replacingTransport())
        h.runtime.settle()

        XCTAssertEqual(h.runtime.coordinator?.phase, .open, "the link is republished")
        XCTAssertTrue(replacement.sent(on: .file).contains { $0.first == RealtimeKind.resumeReq },
                      "the file lane attached and asked to resume")
        XCTAssertNotNil(replacement.onFrame,
                        "and the replacement's route is the coordinator's, installed by it")
    }

    /// The link ending underneath the runtime is reported once, from the lanes'
    /// own terminal reports — the coordinator's `onEnded` belongs to the lane
    /// owner and taking it would leave both lanes unended.
    func testTheHeldLinkEndingIsReportedExactlyOnce() throws {
        let h = harness()
        opened(h)
        let coordinator = try XCTUnwrap(h.runtime.coordinator)

        h.runtime.peerDeparted("peer-b")

        XCTAssertEqual(h.events.ends, [.linkEnded],
                       "both lanes reported; the runtime ends once")
        XCTAssertEqual(coordinator.phase, .ended)
        XCTAssertTrue(h.runtime.isEnded)
    }

    // MARK: - inbound files

    /// A committed batch surfaces its URLs and its container, once, and only
    /// after the commit. `FileMeta.path` is carried through, so a received tree
    /// keeps its shape rather than landing in one flat heap.
    func testACommittedReceiveSurfacesItsFilesAndContainerExactlyOnce() throws {
        let h = harness()
        opened(h)
        let body = WireVectors.content(40, seed: 71)
        let files = [meta("a.txt", body.count, path: "trip/day1/a.txt")]

        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()
        for frame in try h.peer.dataFrames([(files[0], body)]) { h.transport.deliver(.file, frame) }
        h.runtime.settle()

        XCTAssertEqual(h.events.received.count, 1, "reported once, after the commit")
        let result = try XCTUnwrap(h.events.received.first)
        XCTAssertEqual(result.batch, 1, "and correlated to the batch it belongs to")
        XCTAssertEqual(result.files.map { relative($0) }, ["trip/day1/a.txt"],
                       "the manifest path is preserved")
        XCTAssertEqual(result.container.map { relative($0) }, "trip")
        XCTAssertTrue(h.events.fileEvents.contains(.inboundFinished(batch: 1, ok: true)))
    }

    /// A flat batch lands in the directory the application chose and has no
    /// container of its own.
    func testAFlatReceiveReportsNoContainer() throws {
        let h = harness()
        opened(h)
        let body = WireVectors.content(24, seed: 72)
        let files = [meta("flat.bin", body.count)]

        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()
        for frame in try h.peer.dataFrames([(files[0], body)]) { h.transport.deliver(.file, frame) }
        h.runtime.settle()

        let result = try XCTUnwrap(h.events.received.first)
        XCTAssertNil(result.container)
        XCTAssertEqual(result.files.map { relative($0) }, ["flat.bin"])
        XCTAssertEqual(try Data(contentsOf: result.files[0]), Data(body))
    }

    /// A batch the peer abandoned never becomes a result, and leaves nothing on
    /// disk for a user to find.
    func testAnAbortedReceiveNeverSurfacesFiles() throws {
        let h = harness()
        opened(h)
        let files = [meta("half.bin", 4 * CHUNK_SIZE)]

        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()
        h.transport.deliver(.file, try h.peer.nextChunkFrame([UInt8](repeating: 7, count: CHUNK_SIZE)))
        h.runtime.settle()
        h.transport.deliver(.file, [LINK_FILE_BATCH_ABORT])
        h.runtime.settle()

        XCTAssertTrue(h.events.received.isEmpty, "an aborted receive is not a result")
        XCTAssertFalse(exists("half.bin"), "and its partial bytes are discarded")
        XCTAssertTrue(h.events.fileEvents.contains(.inboundFinished(batch: 1, ok: false)))
    }

    /// Stop is where an uncommitted receive is discarded — not `deinit`, which
    /// would be deleting a user's directory tree from an arbitrary thread.
    func testStopDiscardsAnUncommittedReceiveAndSurfacesNothing() throws {
        let h = harness()
        opened(h)
        let files = [meta("half.bin", 4 * CHUNK_SIZE)]

        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()
        h.transport.deliver(.file, try h.peer.nextChunkFrame([UInt8](repeating: 7, count: CHUNK_SIZE)))
        h.runtime.settle()
        XCTAssertTrue(exists("half.bin"), "the partial file is really on disk to begin with")
        // Held across the stop: the discard runs on the file driver's own
        // destination queue, and the runtime has released the owner by the time
        // it returns — so the barrier has to be taken through a kept reference.
        let owner = try XCTUnwrap(h.runtime.owner)

        h.runtime.stop()
        owner.settle()

        XCTAssertTrue(h.events.received.isEmpty)
        XCTAssertFalse(exists("half.bin"), "stop discarded what was never committed")
    }

    /// A committed batch is the user's file. The barrier that closes a replay
    /// window must never remove it, however late the abort arrives.
    func testALateAbortDoesNotDeleteACommittedResult() throws {
        let h = harness()
        opened(h)
        let body = WireVectors.content(30, seed: 73)
        let files = [meta("kept.bin", body.count)]

        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()
        for frame in try h.peer.dataFrames([(files[0], body)]) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        XCTAssertEqual(h.events.received.count, 1)

        h.transport.deliver(.file, [LINK_FILE_BATCH_ABORT])
        h.runtime.settle()
        h.runtime.stop()
        h.runtime.settle()

        XCTAssertTrue(exists("kept.bin"), "the file is the user's; nothing later removes it")
        XCTAssertEqual(h.events.received.count, 1, "and it is still reported exactly once")
    }

    /// A manifest the writer refuses opens no destination at all — and refusing
    /// a batch is not a lane that failed.
    func testAReceiveTheWriterRefusesSurfacesNothingAndKeepsTheLane() throws {
        let h = harness()
        opened(h)
        // An absolute path is exactly what `openReceiveWriter` refuses.
        let files = [meta("bad.bin", 8, path: "/etc/bad.bin")]

        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()

        XCTAssertTrue(h.events.received.isEmpty)
        XCTAssertFalse(h.events.fileEvents.contains(.failed(.laneFailed)),
                       "a disk that refused is not a codec that failed")
        XCTAssertEqual(h.runtime.coordinator?.phase, .open)
    }

    /// The receive directory is a SNAPSHOT the application supplied: every batch
    /// lands under the one this runtime was built with.
    func testEveryBatchLandsUnderTheDirectoryTheRuntimeWasBuiltWith() throws {
        let other = dir.appendingPathComponent("chosen", isDirectory: true)
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let h = harness(receiveDirectory: other)
        opened(h)
        let body = WireVectors.content(12, seed: 74)
        let files = [meta("pinned.bin", body.count)]

        for frame in try h.peer.batchFrames(files) { h.transport.deliver(.file, frame) }
        h.runtime.settle()
        h.runtime.acceptInboundBatch()
        h.runtime.settle()
        for frame in try h.peer.dataFrames([(files[0], body)]) { h.transport.deliver(.file, frame) }
        h.runtime.settle()

        let result = try XCTUnwrap(h.events.received.first)
        XCTAssertEqual(result.files.map { relative($0) }, ["chosen/pinned.bin"])
    }

    // MARK: - the composer's operations

    func testOperationsBeforeReadinessAreRefusedAsNotReady() {
        let h = harness()
        h.runtime.start()

        XCTAssertThrowsError(try h.runtime.openTextConversation()) {
            XCTAssertEqual($0 as? LinkSessionRuntimeError, .notReady)
        }
        XCTAssertThrowsError(try h.runtime.sendText("hello")) {
            XCTAssertEqual($0 as? LinkSessionRuntimeError, .notReady)
        }
        XCTAssertThrowsError(try h.runtime.enqueueFiles(files: [meta("a", 1)], stage: { [] })) {
            XCTAssertEqual($0 as? LinkSessionRuntimeError, .notReady)
        }
        // The five that cannot report are simply inert.
        h.runtime.pumpFiles()
        h.runtime.acceptInboundBatch()
        h.runtime.rejectInboundBatch()
        h.runtime.cancelOutboundBatch()
        h.runtime.cancelQueuedBatch(1)
        XCTAssertTrue(h.events.all.isEmpty,
                      "an inert action moves nothing and reports nothing")
    }

    func testOperationsAfterTheEndAreRefusedTerminally() {
        let h = harness()
        opened(h)
        h.runtime.stop()

        XCTAssertThrowsError(try h.runtime.sendText("hello")) {
            XCTAssertEqual($0 as? LinkSessionRuntimeError, .ended)
        }
        XCTAssertThrowsError(try h.runtime.acceptTextConversation()) {
            XCTAssertEqual($0 as? LinkSessionRuntimeError, .ended)
        }
    }

    /// The conversation reaches the text lane through this facade, and the lane's
    /// own refusal is the one that comes back — never re-wrapped.
    func testTextOperationsReachTheLaneAndReturnItsOwnRefusal() throws {
        let h = harness()
        opened(h)

        try h.runtime.openTextConversation()
        h.runtime.settle()
        XCTAssertTrue(h.events.textEvents.contains(.status(.waitingAccept)))
        XCTAssertEqual(h.transport.sent(on: .text).first, [LINK_TEXT_REQUEST])

        // A body the session refuses: the lane answers, not this runtime.
        XCTAssertThrowsError(try h.runtime.sendText("")) {
            XCTAssertTrue($0 is LinkTextDriverError, "the lane's own error, unwrapped: \($0)")
        }
    }

    /// A queued batch is the file lane's, and the id it returns is the one the
    /// events are correlated by.
    func testEnqueueReachesTheFileLaneAndNamesTheBatch() throws {
        let h = harness()
        opened(h)

        let batch = try h.runtime.enqueueFiles(files: [meta("out.bin", 4)], stage: { [] })
        h.runtime.settle()
        h.runtime.cancelQueuedBatch(batch)
        h.runtime.settle()

        XCTAssertTrue(h.events.fileEvents.contains(.outboundFinished(batch: batch, ok: false)),
                      "the batch this runtime named is the batch that was retired")
    }

    // MARK: - the recovery seams

    /// A resume offer from anybody but the held peer buys nothing — not a
    /// verification, not an allocation, not an answer.
    func testAForeignResumeOfferIsIgnored() throws {
        let h = harness(role: .responder)
        opened(h)
        try holdingAReceive(h)
        h.transport.die(error: LinkTransportError.closed)
        h.runtime.settle()
        XCTAssertEqual(h.replacements.count, 0, "a responder starts nothing of its own")

        h.runtime.receiveResumeOffer(from: "someone-else", signal: .object([:]))

        XCTAssertEqual(h.replacements.count, 0, "and a stranger's offer allocates nothing")
        XCTAssertEqual(h.runtime.coordinator?.phase, .interrupted)
    }

    func testAForeignPeerDepartureLeavesTheLinkAlone() {
        let h = harness()
        opened(h)

        h.runtime.peerDeparted("somebody-else")
        h.runtime.settle()

        XCTAssertEqual(h.runtime.coordinator?.phase, .open)
        XCTAssertTrue(h.events.ends.isEmpty)
    }

    /// Intent raised mid-gap lands on the ONE recovery outcome, and is told
    /// about it exactly once.
    func testJoiningAHeldRecoveryReportsTheOutcomeOnce() throws {
        let h = harness()
        opened(h)
        try holdingAReceive(h)
        h.transport.die(error: LinkTransportError.closed)
        h.runtime.settle()

        let outcomes = EventCounter()
        XCTAssertEqual(h.runtime.joinRecovery(peerId: "peer-b") { _ in outcomes.bump() }, .joined)
        XCTAssertEqual(h.runtime.joinRecovery(peerId: "other") { _ in outcomes.bump() }, .busy)

        h.runtime.peerDeparted("peer-b")
        h.runtime.settle()

        XCTAssertEqual(outcomes.value, 1, "the one waiter is finished exactly once")
    }

    func testJoiningBeforeThereIsALinkIsUnavailable() {
        let h = harness()
        h.runtime.start()

        XCTAssertEqual(h.runtime.joinRecovery(peerId: "peer-b") { _ in }, .unavailable)
    }

    // MARK: - re-entrancy and concurrency

    /// A client callback may call straight back into this runtime on the
    /// delivering thread. It must settle on one outcome — no deadlock, no second
    /// end, no lost route.
    func testAClientCallbackMayStopTheRuntimeFromInsideAnEvent() throws {
        let h = harness()
        h.events.hook = { [weak runtime = h.runtime] (event: LinkSessionRuntimeEvent) in
            if case .text(.status(.incomingRequest)) = event { runtime?.stop() }
        }
        opened(h)
        let coordinator = try XCTUnwrap(h.runtime.coordinator)

        h.transport.deliver(.text, [LINK_TEXT_REQUEST])

        XCTAssertEqual(h.events.ends, [.stopped], "one end, from inside the delivery that caused it")
        XCTAssertEqual(coordinator.phase, .ended)
    }

    /// The same for a file event, and from a callback that also sends: the
    /// facade's refusal has to be an answer rather than a hang.
    func testAClientCallbackMaySendFromInsideAFileEvent() throws {
        let h = harness()
        let sends = EventCounter()
        h.events.hook = { [weak runtime = h.runtime] (event: LinkSessionRuntimeEvent) in
            guard case .file(.inboundOffer) = event else { return }
            if (try? runtime?.openTextConversation()) != nil { sends.bump() }
        }
        opened(h)

        for frame in try h.peer.batchFrames([meta("in.bin", 8)]) { h.transport.deliver(.file, frame) }
        h.runtime.settle()

        XCTAssertEqual(sends.value, 1, "the re-entrant call was answered, not blocked")
        XCTAssertTrue(h.events.textEvents.contains(.status(.waitingAccept)))
    }

    /// Publication on the transport's own queue against a `stop()` from another
    /// thread. Whichever wins, there is exactly one end and no `.opened` after
    /// it — and nothing deadlocks.
    func testConcurrentPublicationAndStopSettleOnOneOutcome() {
        for _ in 0..<40 {
            let h = harness()
            h.runtime.start()

            let ready = DispatchGroup()
            ready.enter(); ready.enter()
            DispatchQueue.global().async {
                h.transport.publishOnQueue(h.identity)
                ready.leave()
            }
            DispatchQueue.global().async {
                h.runtime.stop()
                ready.leave()
            }
            XCTAssertEqual(ready.wait(timeout: .now() + 5), .success, "no thread is blocked")
            h.transport.queue.sync {}
            h.runtime.settle()

            XCTAssertEqual(h.events.ends.count, 1, "exactly one terminal report")
            let events = h.events.all
            if let openIndex = events.firstIndex(where: {
                if case .opened = $0 { return true } else { return false } }),
               let endIndex = events.firstIndex(where: {
                   if case .ended = $0 { return true } else { return false } }) {
                XCTAssertLessThan(openIndex, endIndex, "nothing opens after the end")
            }
        }
    }

    /// The dying transport's terminal callbacks against a `stop()` from another
    /// thread: one end, no double gap, no hang.
    func testConcurrentTerminalCallbacksAndStopSettleOnOneOutcome() throws {
        for _ in 0..<40 {
            let h = harness()
            opened(h)
            // Worth holding, so the terminal callback really opens a gap and the
            // race is stop-versus-recovery rather than stop-versus-decline.
            try holdingAReceive(h)
            let coordinator = try XCTUnwrap(h.runtime.coordinator)

            let ready = DispatchGroup()
            ready.enter(); ready.enter()
            DispatchQueue.global().async {
                h.transport.die(error: LinkTransportError.closed)
                ready.leave()
            }
            DispatchQueue.global().async {
                h.runtime.stop()
                ready.leave()
            }
            XCTAssertEqual(ready.wait(timeout: .now() + 5), .success, "no thread is blocked")

            XCTAssertEqual(h.events.ends.count, 1)
            XCTAssertEqual(coordinator.phase, .ended,
                           "the held link settles terminally either way")
        }
    }

    /// Two threads racing to end the same runtime.
    func testConcurrentStopsEndExactlyOnce() {
        for _ in 0..<40 {
            let h = harness()
            opened(h)

            DispatchQueue.concurrentPerform(iterations: 4) { _ in h.runtime.stop() }
            h.runtime.settle()

            XCTAssertEqual(h.events.ends, [.stopped])
        }
    }

    // MARK: - the end really is the end
    //
    // Every test here is about ONE rule: `ended` is the last thing an owner ever
    // sees. The three below it race a `stop()` against a delivery that is already
    // in flight, and they are deterministic — a barrier inside the exact window,
    // never an iteration count — because the window is a handful of instructions
    // wide and a loop that happens not to hit it reads exactly like a pass.

    /// A `stop()` that starts while `.opened` is being DELIVERED still lands
    /// after it.
    ///
    /// The window this pins is the one an iteration count cannot: publication has
    /// claimed the state, so the link really did open and the owner must be told
    /// — but the delivery has not finished, and the stopping thread finds a
    /// runtime it may legitimately end. Reporting straight from the publishing
    /// thread would let the two deliveries interleave, and the owner would see
    /// its session end before it began.
    func testAStopBegunWhileOpenedIsBeingDeliveredIsReportedAfterIt() throws {
        let h = harness()
        let openedIsInFlight = DispatchSemaphore(value: 0)
        let stopReturned = DispatchSemaphore(value: 0)
        h.events.beforeRecording = { event in
            guard case .opened = event else { return }
            openedIsInFlight.signal()
            XCTAssertEqual(stopReturned.wait(timeout: .now() + 5), .success,
                           "the stopping thread is not blocked by a delivery in flight")
        }

        h.runtime.start()
        DispatchQueue.global().async {
            XCTAssertEqual(openedIsInFlight.wait(timeout: .now() + 5), .success)
            h.runtime.stop()
            stopReturned.signal()
        }
        h.transport.publish(h.identity)

        let events = h.events.all
        let openIndex = try XCTUnwrap(events.firstIndex {
            if case .opened = $0 { return true } else { return false } },
                                      "the link opened, so the owner is told it did")
        let endIndex = try XCTUnwrap(events.firstIndex {
            if case .ended = $0 { return true } else { return false } })
        XCTAssertLessThan(openIndex, endIndex, "and never in the other order")
        XCTAssertEqual(h.events.ends, [.stopped])
        XCTAssertEqual(events.last, .ended(.stopped), "the end is the LAST event")
    }

    /// The other side of that race: a `stop()` that lands before publication
    /// claims the state opens nothing at all.
    ///
    /// The barrier is the route installation, which the file driver performs as
    /// the last act of its initializer — so this stop arrives with the owner
    /// fully built and the runtime still `establishing`, which is the only moment
    /// that can produce a half-published link. Nothing that owner then reports as
    /// it is taken apart may reach the owner above either: it is a lane of a link
    /// that was never opened.
    func testAStopThatWinsBeforePublicationIsClaimedOpensNothing() {
        let h = harness()
        h.runtime.start()

        let stopReturned = DispatchSemaphore(value: 0)
        h.transport.onRouteInstalled = { [weak runtime = h.runtime] in
            DispatchQueue.global().async {
                runtime?.stop()
                stopReturned.signal()
            }
            XCTAssertEqual(stopReturned.wait(timeout: .now() + 5), .success,
                           "the stopping thread reaches the end while publication waits")
        }

        h.transport.publish(h.identity)
        h.runtime.settle()

        XCTAssertEqual(h.events.all, [.sas("424242"), .ended(.stopped)],
                       "the digits this runtime had already shown, then the end, and nothing else")
        XCTAssertNil(h.runtime.owner, "the owner that lost the race is discarded, not published")
    }

    /// The UNCONTENDED teardown: nothing else is delivering, so each driver's
    /// notice consumer is free and its terminal report runs inline inside
    /// `coordinator.stop()`. Those reports are the owner's LAST look at the
    /// session, so they are queued before the one end rather than dropped by it —
    /// which is what the runtime's ending phase exists for.
    ///
    /// This is the ordinary case and the only one it states. It does NOT say a
    /// lane's terminal report always precedes the end: a driver whose consumer
    /// was already in flight hands its `.failed(.linkEnded)` over late, and
    /// `testALateLaneTerminalNoticeIsDroppedRatherThanFollowingTheEnd` pins what
    /// happens then.
    func testTheLanesOwnTerminalReportsPrecedeTheOneEndWhenNoDriverIsBusy() throws {
        let h = harness()
        opened(h)
        let owner = try XCTUnwrap(h.runtime.owner)

        h.runtime.stop()
        owner.settle()

        let events = h.events.all
        let textIndex = try XCTUnwrap(events.firstIndex(of: .text(.failed(.linkEnded))),
                                      "the text lane was told the link ended")
        let fileIndex = try XCTUnwrap(events.firstIndex(of: .file(.failed(.linkEnded))),
                                      "the file lane was told the link ended")
        let endIndex = try XCTUnwrap(events.firstIndex(of: .ended(.stopped)))
        XCTAssertLessThan(textIndex, endIndex, "each lane's own end comes first")
        XCTAssertLessThan(fileIndex, endIndex)
        XCTAssertEqual(events.last, .ended(.stopped), "and the runtime's end is last")
    }

    /// The CONTENDED teardown, which is the case the one above cannot state: a
    /// driver callback is already in flight when `stop()` reaches the coordinator,
    /// so that driver's `.failed(.linkEnded)` is left for the consumer already
    /// running and only surfaces after the runtime has queued its own end.
    ///
    /// Two rules meet here and only one can win:
    ///
    ///  - `stop()` must not block behind a client callback it did not write, and
    ///  - `ended` is TERMINAL — nothing follows it.
    ///
    /// So the late lane report is DROPPED. This pins that, and pins that dropping
    /// it is all that is dropped: the lane really ended, the runtime really ended
    /// exactly once, and the other lane's report — whose driver was free — is
    /// still delivered ahead of the end.
    ///
    /// ## Why this cannot pass without entering the window
    ///
    /// The park is inside `EventRecorder.beforeRecording` for a FILE event, which
    /// runs while the file driver's single notice consumer is mid-batch on this
    /// thread. `LinkLaneOwner.onEnded` then tells the TEXT lane first and the FILE
    /// lane second — so if the park had not happened, or had not held the file
    /// driver's consumer, the file lane's report would be delivered too and the
    /// assertion that it is absent would fail, exactly as
    /// `testTheLanesOwnTerminalReportsPrecedeTheOneEndWhenNoDriverIsBusy` shows
    /// it delivered. The absence is only reachable through the contention. And it
    /// is an absence of the EVENT, not of the notice: `owner.isFileTerminal`
    /// below says the lane ended, and a `report` that admitted after `.ended`
    /// would surface that same notice behind the end.
    ///
    /// Every wait is a semaphore with a timeout, in one direction: the stopping
    /// thread waits for the park, the parked thread waits for the stop. Neither
    /// holds a runtime, owner, coordinator or driver lock while it waits — which
    /// is the property that makes this a barrier rather than a deadlock.
    func testALateLaneTerminalNoticeIsDroppedRatherThanFollowingTheEnd() throws {
        let h = harness()
        opened(h)
        let owner = try XCTUnwrap(h.runtime.owner)

        let fileNoticeInFlight = DispatchSemaphore(value: 0)
        let stopReturned = DispatchSemaphore(value: 0)
        // What the owner above had actually been told at the instant `stop()`
        // came back, read on the stopping thread while the parked one cannot
        // record anything.
        let atStop = EventSnapshot()
        let parked = EventCounter()

        h.events.beforeRecording = { event in
            guard case .file(.inboundOffer) = event else { return }
            guard parked.value == 0 else { return }
            parked.bump()
            fileNoticeInFlight.signal()
            XCTAssertEqual(stopReturned.wait(timeout: .now() + 5), .success,
                           "stop() is not blocked behind this driver's notice consumer")
        }

        DispatchQueue.global().async {
            XCTAssertEqual(fileNoticeInFlight.wait(timeout: .now() + 5), .success,
                           "the file driver's consumer really is in flight")
            h.runtime.stop()
            atStop.record(h.events.all)
            stopReturned.signal()
        }

        // Parks THIS thread inside the file driver's notice drain: the manifest
        // is read under that driver's lock and `.inboundOffer` is delivered from
        // the drain that follows it, with `noticing` held for the whole batch.
        for frame in try h.peer.batchFrames([meta("in.bin", CHUNK_SIZE)]) {
            h.transport.deliver(.file, frame)
        }
        owner.settle()

        // ── what the stopping thread saw ────────────────────────────────────
        let seenAtStop = try XCTUnwrap(atStop.value, "the stopping thread ran")
        XCTAssertEqual(seenAtStop, [.sas("424242"), .opened(peerId: "peer-b", sas: "424242")],
                       "stop() returned with the offer still mid-delivery and its own end queued")

        // ── and what the owner above ended up with ──────────────────────────
        let events = h.events.all
        XCTAssertFalse(events.contains(.file(.failed(.linkEnded))),
                       "the busy driver's late terminal notice is dropped, not delivered after the end")
        let textIndex = try XCTUnwrap(events.firstIndex(of: .text(.failed(.linkEnded))),
                                      "the lane whose driver was free still reports")
        let endIndex = try XCTUnwrap(events.firstIndex(of: .ended(.stopped)))
        XCTAssertLessThan(textIndex, endIndex, "and it is queued ahead of the end")
        XCTAssertEqual(h.events.ends, [.stopped], "exactly one end, and it is the stop's own reason")
        XCTAssertEqual(events.last, .ended(.stopped), "nothing whatever follows it")
        XCTAssertEqual(events.filter { if case .ended = $0 { return true } else { return false } }.count,
                       1)

        // The report was suppressed; the lane was not. What the owner above lost
        // is one redundant event about a session it has already been told is over.
        XCTAssertTrue(owner.isFileTerminal, "the file lane really did end")
        XCTAssertTrue(owner.isLinkEnded)
        XCTAssertTrue(h.runtime.isEnded)
    }

    /// Nothing repaints a runtime that has ended: not a SAS from a transport that
    /// has not noticed, not a frame down a route this runtime no longer owns, and
    /// not a destination that commits afterwards.
    ///
    /// The commit is the one that has to be decided rather than merely allowed to
    /// fall out: those bytes ARE the user's file by the time the callback runs, so
    /// the rule is that the file stays and the event is dropped. A `received` for
    /// a session the owner has already been told is over would arrive with nothing
    /// left to render it.
    func testAStoppedRuntimeReportsNoLateSASNoLateFrameAndNoLateCommit() throws {
        let h = harness()
        opened(h)
        let owner = try XCTUnwrap(h.runtime.owner)
        h.runtime.stop()
        owner.settle()
        let settled = h.events.all.count

        h.transport.onSAS?("999999")
        h.transport.deliver(.text, [LINK_TEXT_REQUEST])
        owner.settle()

        let body = WireVectors.content(18, seed: 75)
        let destination = try h.runtime.makeReceiveDestination(
            batch: 9, files: [meta("late.bin", body.count)])
        try destination.write(body)
        try destination.finalize()

        XCTAssertTrue(h.events.received.isEmpty, "a commit that landed after the end is not reported")
        XCTAssertTrue(exists("late.bin"), "and the user's committed file is not taken back")
        XCTAssertTrue(h.events.sasDigits.allSatisfy { $0 == "424242" }, "no late digits")
        XCTAssertEqual(h.events.all.count, settled, "nothing at all follows the end")
        XCTAssertEqual(h.events.all.last, .ended(.stopped))
    }

    /// The re-entrant case, which is the one a serialized delivery has to survive:
    /// the callback that stops the runtime is itself the `.opened` delivery, so
    /// the end is produced from INSIDE the consumer that would deliver it.
    func testAStopFromInsideTheOpenedEventEndsOnceAndAfterIt() throws {
        let h = harness()
        h.events.hook = { [weak runtime = h.runtime] (event: LinkSessionRuntimeEvent) in
            if case .opened = event { runtime?.stop() }
        }

        h.runtime.start()
        h.transport.publish(h.identity)

        XCTAssertEqual(h.events.opened, ["peer-b"], "opened exactly once")
        XCTAssertEqual(h.events.ends, [.stopped], "and ended exactly once")
        let events = h.events.all
        let openIndex = try XCTUnwrap(events.firstIndex {
            if case .opened = $0 { return true } else { return false } })
        XCTAssertLessThan(openIndex, try XCTUnwrap(events.firstIndex(of: .ended(.stopped))))
        XCTAssertEqual(events.last, .ended(.stopped))
    }

    // MARK: - the start/stop seam

    /// `close()` is terminal for `start()`, on the double that models
    /// `WebRTCLinkTransport` — see `LinkInitialTransport.start()`, and
    /// `startLocked`'s `guard !closed` for the production half.
    ///
    /// This is what makes the runtime's own start/stop window safe without a
    /// second lifecycle: `start()` sets the state and calls the transport with
    /// the lock released, so a `stop()` can close the transport in between — and
    /// the start that follows it must do nothing rather than open a connection
    /// for a runtime that has already reported its end.
    func testAStartIssuedAfterACloseNeverStartsTheTransport() {
        let transport = InitialTransport()

        transport.close()
        transport.start()

        XCTAssertEqual(transport.startCount, 0, "a closed transport does not start")
        XCTAssertTrue(transport.isClosed)
    }

    /// And the runtime does not issue that start in the first place: an ended
    /// runtime is terminal, so `start()` finds a state it cannot leave.
    func testAStartAfterStopStartsNothing() {
        let h = harness()
        h.runtime.stop()
        h.runtime.start()

        XCTAssertEqual(h.transport.startCount, 0, "nothing restarts a stopped runtime")
        XCTAssertEqual(h.events.ends, [.stopped])
        XCTAssertTrue(h.transport.isClosed)
    }

    // MARK: - the runtime stays disabled

    /// Comments stripped, so a rule about code is not satisfied — or broken — by
    /// prose.
    private func code(_ source: String) -> String {
        source
            .components(separatedBy: "\n")
            .map { line -> String in
                guard let marker = line.range(of: "//") else { return line }
                return String(line[line.startIndex..<marker.lowerBound])
            }
            .joined(separator: "\n")
    }

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var runtimeSource: String {
        let url = appsRoot
            .appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/LinkSessionRuntime.swift")
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    /// The runtime composes; it never derives. A `LinkCodecs` built here would be
    /// a second AEAD sequence under one pair of session keys, and a second
    /// `LinkIdentity` is how the two lanes end up on different ones.
    func testTheRuntimeConstructsNoCryptographyAndNoSecondIdentity() {
        let source = code(runtimeSource)
        XCTAssertFalse(source.isEmpty, "the runtime source must be readable")
        for forbidden in ["HandshakeState", "LinkCodecs(", "generateKeyPair(", "deriveSession(",
                          "deriveResumeAuth(", "deriveTextKey(", "LinkIdentity("] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) has no place in a session runtime")
        }
    }

    /// The one route belongs to the file driver, installed inside `onReady`.
    /// Pinned as source as well as behaviour, because an overwrite AFTER
    /// readiness is a lost lane that only a live peer would reveal.
    func testTheRuntimeNeverInstallsAFrameRoute() {
        let source = code(runtimeSource)
        XCTAssertFalse(source.isEmpty, "the runtime source must be readable")
        XCTAssertFalse(source.contains("onFrame ="),
                       "the frame route is the file driver's and the coordinator's, never this one's")
        for piecemeal in ["coordinator.onTransportLost =", "coordinator.onAttach =",
                          "coordinator.onFrame =", "coordinator.onEnded ="] {
            XCTAssertFalse(source.contains(piecemeal),
                           "\(piecemeal) would take a hook the lane owner installed atomically")
        }
    }

    /// Every event leaves through the ONE consumer.
    ///
    /// Pinned as source as well as behaviour, for the same reason the route is:
    /// a later edit that handed an event straight to the owner's callback would
    /// restore exactly the inversion this batch removed — and it would restore it
    /// in a window a few instructions wide, which a behavioural test can only
    /// catch if it happens to hold a barrier open in the right place.
    func testEveryEventLeavesThroughTheOneConsumer() {
        let source = code(runtimeSource)
        XCTAssertFalse(source.isEmpty, "the runtime source must be readable")
        XCTAssertEqual(source.components(separatedBy: "onEvent(").count - 1, 1,
                       "`onEvent` is called from `deliver` and from nowhere else")
    }

    /// Still unreachable from production: nothing outside the tests constructs
    /// one, and neither feature flag has moved.
    func testTheRuntimeStaysUnreachableFromProduction() throws {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        let roots = [appsRoot.appendingPathComponent("RelayiumKit/Sources"),
                     appsRoot.appendingPathComponent("ios"),
                     appsRoot.appendingPathComponent("mac")]
        var scanned = 0
        for root in roots {
            guard FileManager.default.fileExists(atPath: root.path) else { continue }
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .filter { $0.pathExtension == "swift"
                    && $0.lastPathComponent != "LinkSessionRuntime.swift" }
            for file in try XCTUnwrap(files) {
                scanned += 1
                let text = code((try? String(contentsOf: file, encoding: .utf8)) ?? "")
                XCTAssertFalse(text.contains("LinkSessionRuntime("),
                               "\(file.lastPathComponent) constructs a session runtime")
            }
        }
        XCTAssertGreaterThan(scanned, 50, "the scan really reached the app sources")
    }
}

private extension LinkSessionRuntime {
    /// Barrier: returns once every step both lanes dispatched off their own locks
    /// has run.
    ///
    /// It lives here rather than on the runtime because it is `LinkLaneOwner`'s
    /// own test barrier, reached through the runtime so a test does not have to
    /// hold the owner. Production has no use for it, and putting it on the
    /// production type would be test-only surface on a shipping object.
    func settle() { owner?.settle() }
}

/// One write-once snapshot of an event list, taken on one thread and read on
/// another.
private final class EventSnapshot: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: [LinkSessionRuntimeEvent]?
    func record(_ events: [LinkSessionRuntimeEvent]) {
        lock.lock(); if _value == nil { _value = events }; lock.unlock()
    }
    var value: [LinkSessionRuntimeEvent]? { lock.lock(); defer { lock.unlock() }; return _value }
}

/// One counter an escaping callback can bump from any thread.
private final class EventCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = 0
    func bump() { lock.lock(); _value += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return _value }
}
