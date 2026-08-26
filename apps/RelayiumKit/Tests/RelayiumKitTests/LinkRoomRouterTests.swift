import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the doubles
//
// Two, and each replaces exactly one thing a unit test cannot have.
//
//  - `RouterTransport` is the PeerConnection. Everything between the router and
//    it — the factory, the attempt, the bridge, the runtime, the coordinator —
//    is production code, so the establishment this router hands off really
//    publishes, really fails, and really releases the room it was given.
//  - `RoutedControl` is the room's seam onto that link. It replaces the runtime
//    behind `LinkSessionRoomControl` because the question these tests ask is
//    what the ROUTER forwarded, in what order and how many times, and a forged
//    leave or a rejected candidate is dropped in silence one layer further down.

private final class RouterTransport: LinkRoutableInitialTransport, @unchecked Sendable {
    private let slots = NSLock()
    private let state = NSLock()

    private var _onSAS: ((String) -> Void)?
    private var _onReady: ((LinkIdentity) -> Void)?
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    private var _onError: ((Error) -> Void)?
    private var _onClose: (() -> Void)?

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

    private var _closed = false
    private var _closeCount = 0
    private var _routed: [(from: String, signal: JSONValue)] = []

    /// Everything the ASSEMBLY handed this transport — which is exactly the one
    /// initial signal the router consumed on this link's behalf.
    var routed: [(from: String, signal: JSONValue)] {
        state.lock(); defer { state.unlock() }; return _routed
    }

    func start() {}
    func receive(from: String, signal: JSONValue) {
        state.lock(); _routed.append((from, signal)); state.unlock()
    }
    func send(_ bytes: [UInt8], on lane: LinkLane) throws {}
    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }
    var closeCount: Int { state.lock(); defer { state.unlock() }; return _closeCount }
    func close() {
        state.lock(); _closed = true; _closeCount += 1; state.unlock()
    }

    func publish(_ identity: LinkIdentity) {
        onSAS?("424242")
        onReady?(identity)
    }
    func fail(_ error: Error = LinkTransportError.peerConnectionFailed) {
        onError?(error)
        onClose?()
    }
}

/// What the room forwarded to the link it holds, in order.
private final class RoutedControl: LinkSessionRecoveryControl, @unchecked Sendable {
    private let lock = NSLock()
    private var _received: [(from: String, signal: JSONValue)] = []
    private var _resumeOffers: [(from: String, signal: JSONValue)] = []
    private var _leaves: [(from: String, to: String, auth: String)] = []
    private var _departures: [String] = []

    var received: [(from: String, signal: JSONValue)] { lock.withLock { _received } }
    var resumeOffers: [(from: String, signal: JSONValue)] { lock.withLock { _resumeOffers } }
    var leaves: [(from: String, to: String, auth: String)] { lock.withLock { _leaves } }
    var departures: [String] { lock.withLock { _departures } }

    /// Runs INSIDE one forward, which for a replayed candidate is inside the
    /// buffer's one drain on the main actor. The re-entrancy tests below use it
    /// to change the world underneath a handoff that is already running.
    var duringReceive: (() -> Void)?

    func receive(from: String, signal: JSONValue) {
        lock.withLock { _received.append((from, signal)) }
        duringReceive?()
    }
    func receiveResumeOffer(from: String, signal: JSONValue) {
        lock.withLock { _resumeOffers.append((from, signal)) }
    }
    func receiveLeave(from: String, to: String, auth: String) {
        lock.withLock { _leaves.append((from, to, auth)) }
    }
    func peerDeparted(_ peerId: String) {
        lock.withLock { _departures.append(peerId) }
    }
    func joinRecovery(peerId: String,
                      _ complete: @escaping (Result<LinkIdentity, Error>) -> Void)
    -> LinkRecoveryJoin { .unavailable }
}

/// A re-entrancy hook armed on one thread and fired on another, so the racy
/// handoff is the lock's rather than the test's.
private final class Probe: @unchecked Sendable {
    private let lock = NSLock()
    private var body: (() -> Void)?
    func arm(_ body: @escaping () -> Void) { lock.withLock { self.body = body } }
    func fire() { (lock.withLock { body })?() }
}

/// Suspends exactly ONE routing inside `canAcceptLink`, and lets every later one
/// through.
///
/// The frame a test holds across an epoch change is one specific frame, but the
/// predicate holding it is installed for the router's whole life and consulted on
/// every offer. A gate that suspended every routing would therefore also suspend
/// the delivery that PROVES the new epoch still admits — which arrives on the
/// main thread, in a raw semaphore wait no XCTest timeout can end.
///
/// So: armed once, consumed once, open from then on. Both waits are bounded as
/// well, because that is the difference between a gate that is mis-armed and a
/// suite that never finishes: a routing that never arrives, or one that is never
/// released, fails the test rather than parking a thread forever.
private final class OneShotGate: @unchecked Sendable {
    private let arrived = DispatchSemaphore(value: 0)
    private let released = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var claimed = false
    private var abandoned = false

    /// Whether the held routing was released rather than abandoned at the bound.
    /// Read from the test body, so no assertion ever runs on the routing thread.
    var wasReleased: Bool { lock.withLock { !abandoned } }

    /// Called from inside the predicate, on whatever thread is routing. The first
    /// caller is held; every later one passes straight through.
    func hold(within seconds: Double = 5) {
        let mine: Bool = lock.withLock {
            guard !claimed else { return false }
            claimed = true
            return true
        }
        guard mine else { return }
        arrived.signal()
        if released.wait(timeout: .now() + seconds) == .timedOut {
            lock.withLock { abandoned = true }
        }
    }

    /// Block until the held routing is inside the predicate and undecided.
    /// Answers false if it never got there.
    func awaitArrival(within seconds: Double = 5) -> Bool {
        arrived.wait(timeout: .now() + seconds) == .success
    }

    /// Let the held routing finish deciding.
    func release() { released.signal() }
}

/// Holds every arriving thread until all of them are there.
///
/// `LinkAdmission.route` consults `canAcceptLink` BEFORE it reads the phase, and
/// with its own lock released. Blocking there is what makes "two offers in one
/// burst were both routed against an idle room" a fact rather than a timing
/// accident — which is the only condition under which the atomicity of
/// `admitEstablishment` is exercised at all.
private final class Barrier: @unchecked Sendable {
    private let condition = NSCondition()
    private let expected: Int
    private var arrived = 0

    init(expected: Int) { self.expected = expected }

    func wait() {
        condition.lock()
        arrived += 1
        if arrived >= expected { condition.broadcast() }
        while arrived < expected { condition.wait() }
        condition.unlock()
    }
}

private final class RouterScheduler: LinkRecoveryScheduler, @unchecked Sendable {
    final class Handle: LinkRecoveryTimer, @unchecked Sendable {
        let delay: TimeInterval
        let body: () -> Void
        private let lock = NSLock()
        private var _cancelled = false

        init(delay: TimeInterval, body: @escaping () -> Void) {
            self.delay = delay
            self.body = body
        }

        var cancelled: Bool { lock.withLock { _cancelled } }
        func cancel() { lock.withLock { _cancelled = true } }
    }

    private let lock = NSLock()
    private var _handles: [Handle] = []
    private let firesSynchronously: Bool
    var delays: [TimeInterval] { lock.withLock { _handles.map(\.delay) } }

    init(firesSynchronously: Bool = false) {
        self.firesSynchronously = firesSynchronously
    }

    func schedule(after delay: TimeInterval,
                  _ body: @escaping () -> Void) -> LinkRecoveryTimer {
        let handle = Handle(delay: delay, body: body)
        lock.withLock { _handles.append(handle) }
        if firesSynchronously { body() }
        return handle
    }

    func fire(_ delay: TimeInterval, includingCancelled: Bool = false) {
        let handles = lock.withLock { _handles.filter { $0.delay == delay } }
        for handle in handles where includingCancelled || !handle.cancelled {
            handle.body()
        }
    }
}

private final class RequestOperationCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var operations: [LinkRequestOperation] = []
    func append(_ operation: LinkRequestOperation) { lock.withLock { operations.append(operation) } }
    var snapshot: [LinkRequestOperation] { lock.withLock { operations } }
}

private final class RoutedSignal: @unchecked Sendable {
    let value: JSONValue
    init(_ value: JSONValue) { self.value = value }
}

@MainActor
final class LinkRoomRouterTests: XCTestCase {

    // MARK: - fixtures

    private let selfId = "self-room"
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-router-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private let sendKey = [UInt8](repeating: 0x41, count: 32)
    private let recvKey = [UInt8](repeating: 0x42, count: 32)

    private func identity(peerId: String, role: Role = .responder) -> LinkIdentity {
        LinkIdentity(peerId: peerId, role: role, sas: "424242",
                     codecs: LinkCodecs(sendKey: sendKey, recvKey: recvKey),
                     authenticationGeneration: 5)
    }

    // ── the frames a peer really sends ──────────────────────────────────────

    private func offer(_ sdp: String = "v=0 offer") -> JSONValue {
        linkSDPSignal(kind: "offer", sdp: sdp,
                      commit: String(repeating: "c", count: 44), caps: [LINK_CAPABILITY])
    }

    private func candidate(_ id: String) -> JSONValue {
        .object(["link": .bool(true),
                 "ice": .object(["candidate": .string("candidate:\(id) 1 udp 1 10.0.0.1 1 typ host"),
                                 "sdpMid": .string("0"),
                                 "sdpMLineIndex": .number(0)])])
    }

    private func leave(_ auth: String = String(repeating: "L", count: LINK_LEAVE_AUTH_LENGTH))
    -> JSONValue {
        linkLeaveSignal(auth: auth)
    }

    private func resumeOffer() -> JSONValue {
        .object(["resume": .bool(true),
                 "auth": .string(String(repeating: "a", count: LINK_AUTH_TAG_LENGTH)),
                 "sdp": .object(["type": .string("offer"), "sdp": .string("v=0 rebuild")])])
    }

    /// A legacy untagged file offer: what every already-deployed peer sends.
    private func fileOffer() -> JSONValue {
        .object(["sdp": .object(["type": .string("offer"), "sdp": .string("v=0 file")])])
    }

    private func textOffer() -> JSONValue {
        .object(["text": .bool(true),
                 "caps": .array([.string(TEXT_CAPABILITY)]),
                 "sdp": .object(["type": .string("offer"), "sdp": .string("v=0 text")])])
    }

    /// The legacy ONE-SHOT file resume: the `resume` generation shared with an
    /// authenticated rebuild, and not an offer.
    private func legacyResume() -> JSONValue {
        .object(["resume": .bool(true),
                 "ice": .object(["candidate": .string("candidate:legacy")])])
    }

    // ── one room, one socket, one router ────────────────────────────────────

    /// Everything one epoch is made of, so a test can drive the socket the
    /// router is really listening to.
    private final class Socket: @unchecked Sendable {
        let channel = FakeWebSocketChannel()
        let client: SignalingClient
        /// What the per-connection slot saw — the stand-in for the establishing
        /// transport, which claims that slot in its own initializer.
        private let lock = NSLock()
        private var _slot: [(from: String, signal: JSONValue)] = []
        var slot: [(from: String, signal: JSONValue)] { lock.withLock { _slot } }

        init(selfId: String) {
            client = SignalingClient(channel: channel, name: "self")
            channel.fireOpen()
            channel.fireText(Socket.encode(Envelope(type: SignalType.welcome, name: selfId)))
            _ = client.installSignalHandler { [weak self] from, data in
                self?.lock.withLock { self?._slot.append((from, data)) }
            }
        }

        static func encode(_ envelope: Envelope) -> String {
            String(data: try! JSONEncoder().encode(envelope), encoding: .utf8)!
        }

        /// One inbound frame, delivered exactly as the hub delivers one.
        func deliver(from: String, _ data: JSONValue) {
            channel.fireText(Socket.encode(Envelope(type: SignalType.signal, from: from, data: data)))
        }

        /// Every `busy` this side answered, by recipient.
        var busied: [String] {
            channel.sent.compactMap { text in
                guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                      envelope.type == SignalType.signal,
                      let data = envelope.data, isLinkBusy(data) else { return nil }
                return envelope.to
            }
        }

        var requested: [String] {
            channel.sent.compactMap { text in
                guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                      envelope.type == SignalType.signal,
                      let data = envelope.data, isLinkRequest(data) else { return nil }
                return envelope.to
            }
        }
    }

    private final class Rig: @unchecked Sendable {
        let router: LinkRoomRouter
        let session: LinkRoomSession
        let admission: LinkAdmission
        let capabilities: PeerCapabilityRegistry
        var socket: Socket
        var transports: [RouterTransport] = []
        var controls: [RoutedControl] = []
        var peers: [String] = []
        var roles: [Role] = []
        var initialSignals: [JSONValue?] = []
        /// Runs as each control is created, so a test can arm a hook that has to
        /// fire during the very first forward of an establishment that does not
        /// exist yet when the test sets it up.
        var onControl: ((RoutedControl) -> Void)?

        init(router: LinkRoomRouter, session: LinkRoomSession, admission: LinkAdmission,
             capabilities: PeerCapabilityRegistry, socket: Socket) {
            self.router = router
            self.session = session
            self.admission = admission
            self.capabilities = capabilities
            self.socket = socket
        }
    }

    /// A router over the real composition below it, and over a real
    /// `SignalingClient` driven by real inbound envelopes.
    ///
    /// - Parameters:
    ///   - realControl: use the assembly's OWN room control — the real runtime —
    ///     rather than the recorder. Only the tests that need a link to really
    ///     publish and really end want this.
    ///   - admissionTrustsEveryPeer: build the admission with a predicate that
    ///     accepts anybody, so the ROUTER's own capability gate is the only thing
    ///     left standing. Production composes both from the same registry; this
    ///     is how the router's half is exercised rather than its caller's.
    private func rig(canAcceptLink: @escaping (String) -> Bool = { _ in true },
                     realControl: Bool = false,
                     admissionTrustsEveryPeer: Bool = false,
                     peers: [String] = ["peer-1", "peer-2"],
                     holdingHandoff: Bool = false,
                     scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler()) -> Rig {
        let capabilities = PeerCapabilityRegistry(linkRoomActive: { true })
        for peer in peers {
            capabilities.record(peerId: peer,
                                signal: .object(["caps": .array([.string(LINK_CAPABILITY)])]))
        }
        let admission = LinkAdmission(
            selfId: { [selfId] in selfId },
            supportsLink: { peerId in
                admissionTrustsEveryPeer || capabilities.supports(peerId, LINK_CAPABILITY)
            },
            canAcceptLink: canAcceptLink)
        let socket = Socket(selfId: selfId)
        let dir = self.dir!

        var built: Rig!
        let session = LinkRoomSession(admission: admission) { peerId, role, initialSignal in
            let transport = RouterTransport()
            let assembly = LinkSessionFactory.make(
                signaling: socket.client,
                peerId: peerId,
                role: role,
                iceServers: [],
                iceTransportPolicy: .relay,
                authenticationGeneration: 5,
                receiveDirectory: dir,
                admission: admission,
                deadlines: LinkDeadlines(),
                initialSignal: initialSignal,
                buildInitialTransport: { _, _, _, _, _, _, _ in transport },
                buildReplacementFactory: { _, _, _, _ in { _ in throw LinkTransportError.notReady } })
            let control = RoutedControl()
            built.transports.append(transport)
            built.controls.append(control)
            built.peers.append(peerId)
            built.roles.append(role)
            built.initialSignals.append(initialSignal)
            built.onControl?(control)
            guard !realControl else { return assembly }
            return LinkSessionAssembly(attempt: assembly.attempt,
                                       control: LinkSessionRoomControl(runtime: control))
        }
        let router = LinkRoomRouter(admission: admission,
                                    capabilities: capabilities,
                                    session: session,
                                    scheduler: scheduler)
        built = Rig(router: router, session: session, admission: admission,
                    capabilities: capabilities, socket: socket)
        router.attach(to: socket.client, holdingHandoff: holdingHandoff)
        return built
    }

    /// Let every main-actor consumer that is already scheduled run.
    private func settle(_ turns: Int = 12) async {
        for _ in 0..<turns { await Task.yield() }
    }

    // MARK: - outbound request timing

    func testRequestSendsImmediatelyRetriesNineTimesAndTimesOutWithoutAThirtiethSecondRetry() {
        let scheduler = RouterScheduler()
        let r = rig(scheduler: scheduler)
        let operation = r.router.ensure(peerId: "peer-1")

        XCTAssertEqual(r.socket.requested, ["peer-1"])
        XCTAssertEqual(scheduler.delays, [3, 6, 9, 12, 15, 18, 21, 24, 27, 30])
        for delay in stride(from: 3.0, through: 27.0, by: 3.0) {
            scheduler.fire(delay)
        }
        XCTAssertEqual(r.socket.requested, Array(repeating: "peer-1", count: 10))
        XCTAssertNil(operation.settledOutcome)

        scheduler.fire(30)
        XCTAssertEqual(r.socket.requested, Array(repeating: "peer-1", count: 10))
        XCTAssertEqual(operation.settledOutcome, .timedOut)
        XCTAssertEqual(r.admission.phase, .failed)
    }

    func testRepeatedIntentForTheSamePendingPeerSharesTheExactOperation() {
        let scheduler = RouterScheduler()
        let r = rig(scheduler: scheduler)

        let first = r.router.ensure(peerId: "peer-1")
        let second = r.router.ensure(peerId: "peer-1")

        XCTAssertTrue(first === second)
        XCTAssertEqual(r.socket.requested, ["peer-1"])
        XCTAssertEqual(scheduler.delays.count, 10)
    }

    func testConcurrentIntentForTheSamePeerInstallsOneRequestAndOneOperation() {
        let scheduler = RouterScheduler()
        let r = rig(scheduler: scheduler)
        let collected = RequestOperationCollector()

        DispatchQueue.concurrentPerform(iterations: 16) { _ in
            collected.append(r.router.ensure(peerId: "peer-1"))
        }

        let operations = collected.snapshot
        XCTAssertEqual(operations.count, 16)
        XCTAssertTrue(operations.dropFirst().allSatisfy { $0 === operations[0] })
        XCTAssertEqual(r.socket.requested, ["peer-1"])
        XCTAssertEqual(scheduler.delays.count, 10)
    }

    func testSynchronousSchedulerCallbacksDoNotDeadlockOrAddAThirtySecondRetry() {
        let scheduler = RouterScheduler(firesSynchronously: true)
        let r = rig(scheduler: scheduler)

        let operation = r.router.ensure(peerId: "peer-1")

        XCTAssertEqual(operation.settledOutcome, .timedOut)
        XCTAssertEqual(r.socket.requested, Array(repeating: "peer-1", count: 10))
        XCTAssertEqual(r.admission.phase, .failed)
    }

    func testDetachCancelsTheRequestOnceAndStaleTimersCannotSend() {
        let scheduler = RouterScheduler()
        let r = rig(scheduler: scheduler)
        let operation = r.router.ensure(peerId: "peer-1")
        var outcomes: [LinkRequestOperation.Outcome] = []
        let observation = operation.observe { outcomes.append($0) }

        r.router.detach()
        XCTAssertEqual(operation.settledOutcome, .cancelled)
        XCTAssertEqual(outcomes, [.cancelled])
        XCTAssertEqual(r.admission.phase, .idle)

        for delay in scheduler.delays {
            scheduler.fire(delay, includingCancelled: true)
        }
        XCTAssertEqual(r.socket.requested, ["peer-1"])
        XCTAssertEqual(outcomes, [.cancelled])
        withExtendedLifetime(observation) {}
    }

    func testPeerOfferSettlesRequestAsEstablishingAndRetiresTimers() async {
        let scheduler = RouterScheduler()
        let r = rig(scheduler: scheduler)
        let operation = r.router.ensure(peerId: "peer-1")

        r.socket.deliver(from: "peer-1", offer())
        XCTAssertEqual(operation.settledOutcome, .establishing)
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))
        XCTAssertTrue(r.socket.busied.isEmpty)

        for delay in scheduler.delays {
            scheduler.fire(delay, includingCancelled: true)
        }
        XCTAssertEqual(r.socket.requested, ["peer-1"])
        await settle()
        XCTAssertEqual(r.peers, ["peer-1"])
    }

    /// The same convergence with the surface ALREADY CLAIMED, which is the state
    /// a tapped Connect is really in.
    ///
    /// `NearbyView.connectLink` claims the presentation surface one line before
    /// it dials, and `observeAvailability` mirrors that into `canAcceptLink` as
    /// false. This side is the larger id, so it can only ask — and the offer that
    /// comes back is the answer to its own ask. Routed through the whole
    /// composition here rather than against `LinkAdmission` alone, because the
    /// defect was only ever visible as "Connect does nothing": the request has to
    /// settle, the claim has to be made, the handoff has to reach an assembly,
    /// and NO `busy` may go out on the wire — a single one is what
    /// `LinkSignalPolicy` turns into an immediate `.peerBusy` failure at the peer.
    func testAClaimedSurfaceStillAdoptsTheOfferItAskedFor() async {
        let scheduler = RouterScheduler()
        let r = rig(canAcceptLink: { _ in false }, scheduler: scheduler)
        let operation = r.router.ensure(peerId: "peer-1")
        XCTAssertEqual(r.socket.requested, ["peer-1"], "the ask really went out")

        r.socket.deliver(from: "peer-1", offer())

        XCTAssertEqual(operation.settledOutcome, .establishing)
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))
        XCTAssertTrue(r.socket.busied.isEmpty, """
            this side refused the offer it had just asked for; the peer reads that \
            as `.peerBusy` and fails its establishment in the same instant
            """)
        await settle()
        XCTAssertEqual(r.peers, ["peer-1"], "and the establishment was assembled")
        XCTAssertEqual(r.roles, [.responder])
        XCTAssertEqual(r.session.peerId, "peer-1")
    }

    /// The other half, unmoved: with no ask outstanding, a claimed surface still
    /// refuses an unsolicited offer and tells that peer so exactly once.
    func testAClaimedSurfaceStillRefusesAnOfferItDidNotAskFor() async {
        let r = rig(canAcceptLink: { _ in false })

        r.socket.deliver(from: "peer-1", offer())
        await settle()

        XCTAssertEqual(r.socket.busied, ["peer-1"])
        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertTrue(r.peers.isEmpty, "nothing may be assembled for a refused offer")
    }

    func testPeerBusySettlesRequestAsRefusedAndRetiresTimers() {
        let scheduler = RouterScheduler()
        let r = rig(scheduler: scheduler)
        let operation = r.router.ensure(peerId: "peer-1")

        r.socket.deliver(from: "peer-1", linkBusySignal())
        XCTAssertEqual(operation.settledOutcome, .refused)
        XCTAssertEqual(r.admission.phase, .failed)

        for delay in scheduler.delays {
            scheduler.fire(delay, includingCancelled: true)
        }
        XCTAssertEqual(r.socket.requested, ["peer-1"])
    }

    func testTimeoutWinnerConsumesOneLateOfferAndAnswersBusy() async {
        let scheduler = RouterScheduler()
        let gate = OneShotGate()
        let r = rig(canAcceptLink: { _ in gate.hold(); return true }, scheduler: scheduler)
        let operation = r.router.ensure(peerId: "peer-1")
        let delivered = expectation(description: "offer routing completed")
        let lateOffer = RoutedSignal(offer())

        DispatchQueue.global().async {
            r.socket.deliver(from: "peer-1", lateOffer.value)
            delivered.fulfill()
        }
        XCTAssertTrue(gate.awaitArrival())
        scheduler.fire(30)
        gate.release()
        await fulfillment(of: [delivered], timeout: 5)

        XCTAssertEqual(operation.settledOutcome, .timedOut)
        XCTAssertEqual(r.socket.busied, ["peer-1"])
        XCTAssertEqual(r.admission.phase, .failed)
        await settle()
        XCTAssertTrue(r.peers.isEmpty)
    }

    func testInitiatorIntentClaimsAndHandsOffWithoutAnInitialSignal() async {
        let r = rig(peers: ["z-peer"])

        let operation = r.router.ensure(peerId: "z-peer")
        XCTAssertEqual(operation.settledOutcome, .establishing)
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "z-peer"))
        await settle()

        XCTAssertEqual(r.peers, ["z-peer"])
        XCTAssertEqual(r.roles, [.initiator])
        XCTAssertEqual(r.initialSignals.count, 1)
        XCTAssertNil(r.initialSignals[0])
    }

    /// **The mirror image of `testAClaimedSurfaceStillAdoptsTheOfferItAskedFor`,
    /// on the role assignment where THIS side offers.**
    ///
    /// The owner reproduced it in a built App: macOS and Web paired by Direct
    /// code, macOS was the smaller id and so claimed the room as initiator, and
    /// the Web client's crossing `link request` — both sides announce, both act
    /// on the caps listener — arrived after the pairing had already closed this
    /// module's surface gate. `LinkAdmission.route` consulted `canAcceptLink`
    /// ahead of the phase, so the peer this side was at that moment offering to
    /// was answered `busy`; the counterpart settled `.refused` and macOS drew
    /// "Another transfer is open" about that same counterpart.
    ///
    /// Driven through the whole composition, because the only observable that
    /// matters is what went out on the wire: ONE `busy` is what
    /// `LinkSignalPolicy` turns into an immediate refusal at the peer.
    func testAClaimedSurfaceStillAbsorbsTheCrossingRequestForTheLinkItStarted() async {
        let r = rig(canAcceptLink: { _ in false }, peers: ["z-peer"])

        let operation = r.router.ensure(peerId: "z-peer")
        XCTAssertEqual(operation.settledOutcome, .establishing)
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "z-peer"))

        r.socket.deliver(from: "z-peer", linkRequestSignal())

        XCTAssertTrue(r.socket.busied.isEmpty, """
            this side refused the peer it had just started offering to; the peer \
            reads that as `.peerBusy` and settles refused while this side waits
            """)
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "z-peer"))
        await settle()
        XCTAssertEqual(r.peers, ["z-peer"], "and exactly one establishment exists")
        XCTAssertEqual(r.roles, [.initiator])
    }

    /// The half that must not move, through the same composition: a SECOND
    /// peer's request is still refused, and told so exactly once.
    func testASecondPeersRequestIsRefusedWhileTheRoomIsBoundThroughTheRouter() async {
        let r = rig(peers: ["z-peer", "z-other"])

        _ = r.router.ensure(peerId: "z-peer")
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "z-peer"))

        r.socket.deliver(from: "z-other", linkRequestSignal())
        await settle()

        XCTAssertEqual(r.socket.busied, ["z-other"])
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "z-peer"))
        XCTAssertEqual(r.peers, ["z-peer"], "a second peer was built into the room")
    }

    func testRosterAbsenceCancelsOnlyThePendingRequest() {
        let scheduler = RouterScheduler()
        let r = rig(scheduler: scheduler)
        let operation = r.router.ensure(peerId: "peer-1")

        r.router.rosterChanged(peerIds: ["peer-2"])

        XCTAssertEqual(operation.settledOutcome, .cancelled)
        XCTAssertEqual(r.admission.phase, .idle)
        for delay in scheduler.delays {
            scheduler.fire(delay, includingCancelled: true)
        }
        XCTAssertEqual(r.socket.requested, ["peer-1"])
    }

    func testRosterPresenceKeepsPendingRequestAlive() {
        let r = rig()
        let operation = r.router.ensure(peerId: "peer-1")

        r.router.rosterChanged(peerIds: ["peer-1", "peer-2"])

        XCTAssertNil(operation.settledOutcome)
        XCTAssertEqual(r.admission.phase, .requesting(peerId: "peer-1"))
    }

    func testRosterAbsenceForgetsTimeoutDebtBeforePeerReturns() async {
        let scheduler = RouterScheduler()
        let r = rig(scheduler: scheduler)
        let operation = r.router.ensure(peerId: "peer-1")
        scheduler.fire(30)
        XCTAssertEqual(operation.settledOutcome, .timedOut)

        r.router.rosterChanged(peerIds: ["peer-2"])
        r.socket.deliver(from: "peer-1", offer())
        await settle()

        XCTAssertTrue(r.socket.busied.isEmpty)
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))
        XCTAssertEqual(r.peers, ["peer-1"])
    }

    func testRosterAbsenceNeverEndsAnEstablishedHandoff() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        await settle()

        r.router.rosterChanged(peerIds: [])

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))
        XCTAssertEqual(r.session.peerId, "peer-1")
    }

    func testPhysicalLeftCancelsPendingRequestButUnrelatedPeerIsInert() {
        let r = rig()
        let operation = r.router.ensure(peerId: "peer-1")

        r.router.peerLeft("peer-2")
        XCTAssertNil(operation.settledOutcome)
        r.router.peerLeft("peer-1")

        XCTAssertEqual(operation.settledOutcome, .cancelled)
        XCTAssertEqual(r.admission.phase, .idle)
    }

    func testPhysicalLeftBeforeHandoffReleasesConnectingClaim() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))

        r.router.peerLeft("peer-1")
        await settle()

        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertNil(r.session.peerId)
        XCTAssertTrue(r.peers.isEmpty)
    }

    func testPhysicalLeftEndsTheExactOpenLink() async {
        let r = rig(realControl: true)
        r.socket.deliver(from: "peer-1", offer())
        await settle()
        r.transports[0].publish(identity(peerId: "peer-1"))
        await settle()
        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-1"))

        r.router.peerLeft("peer-2")
        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-1"))
        r.router.peerLeft("peer-1")
        await settle()

        XCTAssertEqual(r.admission.boundPeerId, "")
        XCTAssertNil(r.session.peerId)
    }

    func testDuplicatePhysicalLeftEndsThePublishedLinkOnce() async {
        let r = rig(realControl: true)
        r.socket.deliver(from: "peer-1", offer())
        await settle()
        r.transports[0].publish(identity(peerId: "peer-1"))
        await settle()

        r.router.peerLeft("peer-1")
        r.router.peerLeft("peer-1")
        await settle()

        XCTAssertEqual(r.transports[0].closeCount, 1)
        XCTAssertNil(r.session.peerId)
    }

    // MARK: - 1. one burst, one admission, one busy

    /// The window `admitEstablishment` exists for, driven through the router.
    ///
    /// Two peers offer in ONE socket burst — both frames are routed before
    /// anything reaches the main actor. Exactly one is admitted, and the loser
    /// is TOLD, once. Without the atomic claim both would be told `establish`
    /// and the second would either build a second PeerConnection into the same
    /// pair of lanes or be dropped in silence.
    func testTwoOffersInOneBurstAdmitOnceAndAnswerOneBusy() async {
        let r = rig()

        r.socket.deliver(from: "peer-1", offer("v=0 first"))
        r.socket.deliver(from: "peer-2", offer("v=0 second"))

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"),
                       "the claim is made on the socket queue, before any hop")
        XCTAssertEqual(r.socket.busied, ["peer-2"], "exactly one loser, told exactly once")
        await settle()
        XCTAssertEqual(r.peers, ["peer-1"], "one establishment was assembled")
        XCTAssertEqual(r.roles, [.responder])
        XCTAssertEqual(r.session.peerId, "peer-1")
    }

    /// The same burst, with both frames really routed at once.
    ///
    /// The test above is delivered serially, so `route` itself refuses the second
    /// peer and the claim is never contested. This one holds both routings inside
    /// `canAcceptLink` until each has been admitted's answer against an IDLE room,
    /// which is the only state in which `admitEstablishment` decides anything: two
    /// `establish` answers, one room. Exactly one link is built and exactly one
    /// peer is told, and which peer wins is deliberately not asserted — the point
    /// is that the two outcomes partition the room's two candidates.
    func testTwoConcurrentlyRoutedOffersStillAdmitOnceAndAnswerOneBusy() async {
        let barrier = Barrier(expected: 2)
        let r = rig(canAcceptLink: { _ in barrier.wait(); return true })
        let socket = r.socket
        let first = Socket.encode(Envelope(type: SignalType.signal,
                                           from: "peer-1", data: offer("v=0 one")))
        let second = Socket.encode(Envelope(type: SignalType.signal,
                                            from: "peer-2", data: offer("v=0 two")))

        let done = expectation(description: "both frames were routed")
        done.expectedFulfillmentCount = 2
        DispatchQueue.global().async { socket.channel.fireText(first); done.fulfill() }
        DispatchQueue.global().async { socket.channel.fireText(second); done.fulfill() }
        await fulfillment(of: [done], timeout: 5)
        await settle()

        XCTAssertEqual(r.peers.count, 1, "one room, one establishment")
        XCTAssertEqual(r.socket.busied.count, 1, "and the loser was told, once")
        XCTAssertEqual(Set(r.peers).union(r.socket.busied), ["peer-1", "peer-2"],
                       "the winner and the refused peer are the two that offered")
        XCTAssertEqual(r.admission.boundPeerId, r.peers[0])
        XCTAssertEqual(r.session.peerId, r.peers[0])
    }

    /// **A peer we are already claiming must never be answered `busy`, even when
    /// its request loses the race to our own claim.**
    ///
    /// The owner's caps listener runs on the main actor and calls
    /// `beginLinkAttempt`, which claims admission as initiator; the peer's
    /// request arrives on the signalling queue. When the claim lands first, the
    /// request's route had already read an idle phase and `admitEstablishment`
    /// then fails — and that branch used to answer `busy` to the peer this side
    /// was at that very moment offering to.
    ///
    /// Measured in a built-App pairing run: the app claimed, refused the
    /// counterpart, and then sent its offer to a peer that had already settled
    /// the link as `refused` and stopped listening. Both ends waited. It happens
    /// only on the role assignment that makes this side the offerer, so the
    /// shipped symptom is a pairing that fails about half the time.
    ///
    /// `z-peer` is deliberately larger than `self-room`, which is what makes
    /// THIS side the initiator and the peer the one that has to ask.
    func testARequestFromThePeerWeAreAlreadyClaimingIsNeverAnsweredBusy() async {
        let r = rig(peers: ["z-peer"])

        // Our own claim first — the main-actor half of the race.
        _ = r.router.ensure(peerId: "z-peer")
        XCTAssertEqual(r.admission.boundPeerId, "z-peer",
                       "this side did not claim the peer it must offer to")

        // …and now the peer's request, which lost.
        r.socket.deliver(from: "z-peer", linkRequestSignal())
        await settle()

        XCTAssertTrue(r.socket.busied.isEmpty,
                      "the peer this side is establishing with was told the room is "
                      + "busy, so it settles the link as refused and stops listening "
                      + "for the offer already on its way")
        XCTAssertEqual(r.admission.boundPeerId, "z-peer",
                       "the losing request disturbed the claim it raced")
    }

    /// And the refusal that branch exists for is UNCHANGED: a request from a
    /// peer that is not the one we hold is still told the room is taken.
    func testARequestFromADifferentPeerIsStillAnsweredBusy() async {
        let r = rig(peers: ["peer-1", "z-peer"])

        r.socket.deliver(from: "peer-1", offer())
        await settle()
        XCTAssertEqual(r.admission.boundPeerId, "peer-1")

        r.socket.deliver(from: "z-peer", linkRequestSignal())
        await settle()

        XCTAssertEqual(r.socket.busied, ["z-peer"],
                       "a second peer was not told the room is taken")
    }

    /// Two offers from the SAME peer in one burst are one establishment and no
    /// busy: `admitEstablishment` is idempotent for the peer it already admitted,
    /// and telling that peer it is busy would refuse the link this side is
    /// building for it.
    func testTwoOffersFromOnePeerAdmitOnceAndAnswerNoBusy() async {
        let r = rig()

        r.socket.deliver(from: "peer-1", offer("v=0 first"))
        r.socket.deliver(from: "peer-1", offer("v=0 second"))
        await settle()

        XCTAssertEqual(r.peers, ["peer-1"], "one establishment")
        XCTAssertTrue(r.socket.busied.isEmpty, "and the peer we are building for is not refused")
    }

    // MARK: - 2. nothing is lost in the turn before the assembly exists

    /// The whole reason the buffer is installed in the same critical section as
    /// the claim: a peer that already has its host candidates sends all of them
    /// in the turn after its offer, and the assembly does not exist yet.
    ///
    /// Every one arrives, in the order the peer sent them, exactly once, and
    /// AFTER the offer the assembly was handed — an answer or a candidate applied
    /// before the offer it belongs to is not the same establishment.
    func testCandidatesArrivingBeforeTheHopReplayInOrderExactlyOnce() async {
        let r = rig()

        r.socket.deliver(from: "peer-1", offer())
        r.socket.deliver(from: "peer-1", candidate("1"))
        r.socket.deliver(from: "peer-1", candidate("2"))
        r.socket.deliver(from: "peer-1", candidate("3"))
        XCTAssertTrue(r.transports.isEmpty, "nothing is assembled until the hop")
        await settle()

        XCTAssertEqual(r.initialSignals, [offer()], "the offer travelled as the initial signal")
        XCTAssertEqual(r.transports[0].routed.map(\.signal), [offer()],
                       "and reached the transport once")
        XCTAssertEqual(r.controls[0].received.map(\.signal),
                       [candidate("1"), candidate("2"), candidate("3")],
                       "the chase replayed in arrival order, exactly once")
        XCTAssertEqual(Set(r.controls[0].received.map(\.from)), ["peer-1"])
        XCTAssertTrue(r.socket.slot.isEmpty, "and none of it also reached the connection slot")
    }

    /// Once the buffer has drained there is a link to deliver to, so a candidate
    /// that arrives afterwards still reaches it — behind everything that was
    /// replayed ahead of it, and still only once.
    func testCandidatesArrivingAfterTheDrainStayBehindTheReplay() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        r.socket.deliver(from: "peer-1", candidate("1"))
        await settle()

        r.socket.deliver(from: "peer-1", candidate("2"))
        await settle()

        XCTAssertEqual(r.controls[0].received.map(\.signal), [candidate("1"), candidate("2")])
        XCTAssertTrue(r.socket.slot.isEmpty)
    }

    /// A burst that lands entirely AFTER the buffer opened is still one order.
    ///
    /// These do not travel through the buffer — it holds nothing once it has
    /// drained — so their order is the queue's alone. Nothing in Swift orders two
    /// `Task { @MainActor in … }` against each other, so a router that hopped per
    /// frame would deliver this burst in whatever order the executor happened to
    /// pick, and a peer's candidates would reach the transport shuffled.
    func testABurstArrivingAfterTheDrainKeepsItsArrivalOrder() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        await settle()

        for index in 1...4 { r.socket.deliver(from: "peer-1", candidate("late-\(index)")) }
        await settle()

        XCTAssertEqual(r.controls[0].received.map(\.signal),
                       (1...4).map { candidate("late-\($0)") })
    }

    /// A duplicate offer is not a signal to replay. `LinkAdmission` answers
    /// `alreadyInFlight` for the peer it is already establishing with, so the
    /// frame never reaches the buffer — holding it would spend a slot on an SDP
    /// the establishment has already been handed and then replay it behind the
    /// candidates that chase the first one.
    func testADuplicateOfferIsNeitherCapturedNorReplayed() async {
        let r = rig()

        r.socket.deliver(from: "peer-1", offer("v=0 first"))
        r.socket.deliver(from: "peer-1", offer("v=0 duplicate"))
        r.socket.deliver(from: "peer-1", candidate("1"))
        await settle()

        XCTAssertEqual(r.transports[0].routed.map(\.signal), [offer("v=0 first")],
                       "one offer reached the transport")
        XCTAssertEqual(r.controls[0].received.map(\.signal), [candidate("1")],
                       "and the duplicate was not held, replayed or reordered ahead of the chase")
        XCTAssertTrue(r.socket.slot.isEmpty, "nor handed to the connection slot")
    }

    // MARK: - 3. the bound, and what it costs

    /// Past `LINK_PENDING_CANDIDATE_MAX` this establishment is failed closed
    /// rather than silently truncated — and the room it claimed is FREED on the
    /// socket queue, so the very next peer is admitted instead of being refused
    /// on behalf of a link that will never exist.
    func testOverflowBeforeTheHopFreesTheRoomForTheNextPeer() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        for index in 0..<LINK_PENDING_CANDIDATE_MAX {
            r.socket.deliver(from: "peer-1", candidate("\(index)"))
        }
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"), "still within the bound")

        r.socket.deliver(from: "peer-1", candidate("overflow"))

        XCTAssertEqual(r.admission.phase, .idle, "the claim was released, synchronously")
        r.socket.deliver(from: "peer-2", offer())
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-2"),
                       "and the next peer is admitted rather than refused")
        await settle()
        XCTAssertEqual(r.peers, ["peer-2"], "the doomed establishment was never assembled")
        XCTAssertEqual(r.session.peerId, "peer-2")
        XCTAssertEqual(r.socket.busied, [], "and nobody was told busy on its behalf")
    }

    // MARK: - 4. the socket epoch

    /// A socket replaced before the handoff runs: the claim belongs to an epoch
    /// that no longer exists, so it is released by the router itself — nothing
    /// else can, because nothing was ever assembled.
    func testAnEpochReplacedBeforeTheHopReleasesTheClaimAndAssemblesNothing() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))

        let next = Socket(selfId: selfId)
        r.router.attach(to: next.client)

        XCTAssertEqual(r.admission.phase, .idle, "released directly, before any hop")
        await settle()
        XCTAssertTrue(r.transports.isEmpty, "the stale handoff assembled nothing")
        XCTAssertNil(r.session.peerId)
    }

    /// The old socket is not listened to any more. A frame that arrives on it
    /// after the epoch changed must not claim the room the new epoch owns.
    func testTheReplacedEpochsSocketIsNoLongerRouted() async {
        let r = rig()
        let old = r.socket
        let next = Socket(selfId: selfId)
        r.router.attach(to: next.client)

        old.deliver(from: "peer-1", offer())
        await settle()

        XCTAssertEqual(r.admission.phase, .idle, "the retired socket routes nothing")
        XCTAssertTrue(r.transports.isEmpty)
        XCTAssertTrue(old.busied.isEmpty)
    }

    /// A frame that was ALREADY being routed when the socket was replaced must
    /// not claim the room the new epoch owns.
    ///
    /// Cancelling the interceptor stops the next frame; it cannot stop this one,
    /// which is inside the closure with its decision half made. It is held there
    /// by `canAcceptLink` — the one point `LinkAdmission` calls owner code with
    /// nothing locked — while the epoch turns over underneath it.
    func testAFrameRoutedAcrossAnEpochChangeClaimsNothing() async {
        // One routing is held, and only one: the predicate stays installed for
        // the rest of this test, and the delivery below that proves the new
        // epoch admits is routed through it on the MAIN thread.
        let gate = OneShotGate()
        let r = rig(canAcceptLink: { _ in gate.hold(); return true })
        let socket = r.socket
        let inbound = Socket.encode(Envelope(type: SignalType.signal,
                                             from: "peer-1", data: offer()))
        let next = Socket(selfId: selfId)

        let routed = expectation(description: "the in-flight frame finished routing")
        DispatchQueue.global().async { socket.channel.fireText(inbound); routed.fulfill() }
        XCTAssertTrue(gate.awaitArrival(),   // the frame is inside `route`, undecided
                      "the in-flight frame reached the accept predicate")
        r.router.attach(to: next.client)     // and the socket it came from is retired
        gate.release()                       // now let it finish deciding
        await fulfillment(of: [routed], timeout: 5)
        await settle()

        XCTAssertTrue(gate.wasReleased, "the held routing was released, not abandoned")
        XCTAssertEqual(r.admission.phase, .idle,
                       "the retired epoch's frame did not take the new epoch's room")
        XCTAssertTrue(r.transports.isEmpty)
        next.deliver(from: "peer-2", offer())
        await settle()
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-2"))
    }

    /// The new epoch works, which is what makes the assertion above meaningful.
    func testTheNewEpochRoutesAndAdmits() async {
        let r = rig()
        let next = Socket(selfId: selfId)
        r.router.attach(to: next.client)

        next.deliver(from: "peer-1", offer())
        await settle()

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))
        XCTAssertEqual(r.peers, ["peer-1"])
    }

    /// The nastiest ordering in this object: the epoch is replaced from INSIDE
    /// the buffer's one drain, between two replayed candidates.
    ///
    /// The establishment that is mid-handoff must be ended — it was assembled, so
    /// only the room session can end it — and the room must come back free. A
    /// stale drain must not leave a live link nobody routes to, and must not
    /// release an admission the next epoch has already claimed.
    func testAnEpochReplacedDuringTheDrainEndsThatEstablishmentAndFreesTheRoom() async {
        let r = rig()
        let next = Socket(selfId: selfId)
        // Armed BEFORE the establishment exists: the recorder is created inside
        // the handoff, so this is the only way to be inside the drain when the
        // epoch changes.
        var replaced = false
        r.onControl = { [weak r] control in
            control.duringReceive = {
                guard !replaced, let r else { return }
                replaced = true
                r.router.attach(to: next.client)
            }
        }

        r.socket.deliver(from: "peer-1", offer())
        r.socket.deliver(from: "peer-1", candidate("1"))
        r.socket.deliver(from: "peer-1", candidate("2"))
        r.socket.deliver(from: "peer-1", candidate("3"))
        await settle()

        XCTAssertTrue(replaced, "the epoch really changed mid-drain")
        XCTAssertEqual(r.controls[0].received.count, 3,
                       "the batch already taken was still handed over in one order")
        XCTAssertEqual(r.admission.phase, .idle, "the mid-handoff establishment was ended")
        XCTAssertNil(r.session.peerId, "and the room holds nothing")

        next.deliver(from: "peer-2", offer())
        await settle()
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-2"),
                       "the new epoch can admit")
        XCTAssertEqual(r.peers, ["peer-1", "peer-2"])
    }

    /// Detaching is the same transition with no successor: the room comes back
    /// free and the socket stops being routed.
    func testDetachingReleasesTheRoomAndStopsRouting() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())

        r.router.detach()

        XCTAssertEqual(r.admission.phase, .idle)
        r.socket.deliver(from: "peer-2", offer())
        await settle()
        XCTAssertEqual(r.admission.phase, .idle, "nothing is routed after a detach")
        XCTAssertTrue(r.transports.isEmpty)
    }

    // MARK: - 5. what the router does NOT claim

    /// A `busy` that arrives while this side is CONNECTING is the peer refusing
    /// the link being built. Admission ignores it — it only cancels an
    /// outstanding request — so it must reach the per-connection slot, where the
    /// establishing transport turns it into a truthful failure instead of a
    /// deadline.
    func testAConnectingTimeBusyReachesTheConnectionSlot() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        await settle()
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))

        r.socket.deliver(from: "peer-1", linkBusySignal())
        await settle()

        XCTAssertEqual(r.socket.slot.count, 1, "the transport was told")
        XCTAssertTrue(isLinkBusy(r.socket.slot[0].signal))
        XCTAssertTrue(r.controls[0].received.isEmpty, "and the room did not swallow it")
    }

    /// Every legacy generation passes through untouched, whatever the peer's
    /// link capability says. Swallowing one would break a feature that ships
    /// today: a file transfer, a text conversation, or a one-shot file resume.
    func testLegacyGenerationsPassThroughUntouched() async {
        let r = rig()
        let legacy = [fileOffer(), textOffer(), legacyResume()]

        for signal in legacy { r.socket.deliver(from: "peer-1", signal) }
        await settle()

        XCTAssertEqual(r.socket.slot.map(\.signal), legacy, "in order, verbatim")
        XCTAssertEqual(r.admission.phase, .idle, "and none of them admitted anything")
        XCTAssertTrue(r.transports.isEmpty)
        XCTAssertTrue(r.socket.busied.isEmpty)
    }

    /// A peer that has not announced EXACT `link/1` is not this router's
    /// business at all — its frames reach the slot, and its offer admits
    /// nothing. This is the predicate that carries the room scope, so it is also
    /// what keeps a relay from activating link mode where the room forbids it.
    ///
    /// Admission is deliberately built to trust every peer here, so the answer
    /// comes from the router's own gate rather than from the predicate its caller
    /// happened to supply. Production composes both from this registry; a router
    /// that leaned on its caller for this would activate link mode the moment one
    /// caller was assembled differently.
    func testAPeerWithoutTheExactCapabilityIsNotRoutedAtAll() async {
        let r = rig(admissionTrustsEveryPeer: true, peers: ["peer-1"])
        r.capabilities.record(peerId: "peer-2",
                              signal: .object(["caps": .array([.string("link/2")])]))

        r.socket.deliver(from: "peer-2", offer())
        await settle()

        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertEqual(r.socket.slot.count, 1, "it passed, untouched")
        XCTAssertTrue(r.socket.busied.isEmpty, "and was not even answered")
    }

    // MARK: - 6. the leave budget is real

    /// Nine well-shaped forged departures buy at most eight verifications.
    ///
    /// Every leave traverses `LinkAdmission.route` FIRST, which is where the
    /// budget lives. A router that forwarded a leave without routing it would
    /// make `LINK_LEAVE_MAX_ATTEMPTS` decorative: a flood would buy one HMAC per
    /// message for as long as it kept sending.
    func testNineForgedLeavesBuyAtMostEightVerifications() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        await settle()
        r.transports[0].publish(identity(peerId: "peer-1"))
        await settle()
        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-1"))

        for index in 0..<9 {
            r.socket.deliver(from: "peer-1", leave(String(repeating: "\(index)",
                                                          count: LINK_LEAVE_AUTH_LENGTH)))
        }
        await settle()

        XCTAssertEqual(r.controls[0].leaves.count, LINK_LEAVE_MAX_ATTEMPTS,
                       "eight verifications bought, and the ninth refused")
        XCTAssertLessThanOrEqual(r.controls[0].leaves.count, LINK_LEAVE_MAX_ATTEMPTS)
    }

    /// The envelope's local recipient id travels unchanged, because it is part of
    /// the bytes the tag covers: a leave verified against the wrong `to` is a
    /// leave a relay could reflect back at its sender.
    func testALeaveCarriesThisSidesOwnIdUnchanged() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        await settle()
        r.transports[0].publish(identity(peerId: "peer-1"))
        await settle()

        r.socket.deliver(from: "peer-1", leave())
        await settle()

        XCTAssertEqual(r.controls[0].leaves.map(\.to), [selfId])
        XCTAssertEqual(r.controls[0].leaves.map(\.from), ["peer-1"])
        XCTAssertEqual(r.controls[0].leaves.map(\.auth),
                       [String(repeating: "L", count: LINK_LEAVE_AUTH_LENGTH)])
    }

    /// With no `welcome` yet there is no local id, and an empty one would make
    /// the tag cover the wrong bytes. Nothing is forwarded rather than something
    /// wrong being verified.
    func testALeaveIsNotForwardedWithoutALocalId() async throws {
        let r = rig()
        // A socket that never received `welcome`: `selfId` is nil on it.
        let anonymous = FakeWebSocketChannel()
        let client = SignalingClient(channel: anonymous, name: "self")
        anonymous.fireOpen()
        r.router.attach(to: client)

        // The establishment is built on THIS epoch, deliberately: the router must
        // really be holding one when the leave arrives. Established on the
        // previous epoch instead, the forward would be refused for having no live
        // establishment and this test would pass whether or not the local id was
        // ever looked at.
        anonymous.fireText(Socket.encode(Envelope(type: SignalType.signal,
                                                  from: "peer-1", data: offer())))
        await settle()
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"),
                       "the anonymous epoch really holds an establishment")
        r.admission.didOpen(peerId: "peer-1")
        let control = try XCTUnwrap(r.controls.last)

        anonymous.fireText(Socket.encode(Envelope(type: SignalType.signal,
                                                  from: "peer-1", data: leave())))
        await settle()

        XCTAssertTrue(control.leaves.isEmpty, "no local id, no directional payload")

        // And the instant this side HAS a local id the SAME leave is forwarded,
        // which is what proves the missing id was the only thing that stopped it.
        anonymous.fireText(Socket.encode(Envelope(type: SignalType.welcome, name: "late-id")))
        anonymous.fireText(Socket.encode(Envelope(type: SignalType.signal,
                                                  from: "peer-1", data: leave())))
        await settle()

        XCTAssertEqual(control.leaves.map(\.to), ["late-id"],
                       "the id the envelope really carried, unchanged")
    }

    // MARK: - 7. a rebuild offer routes only after admission

    /// An authenticated rebuild offer is forwarded ONLY when admission says it is
    /// one: the `resume` generation is shared with a legacy one-shot file resume,
    /// and this side's own role decides who drives a rebuild.
    func testARebuildOfferIsForwardedOnlyOnceAdmissionSaysItIsOne() async {
        let r = rig()
        r.socket.deliver(from: "peer-1", offer())
        await settle()
        r.transports[0].publish(identity(peerId: "peer-1"))
        await settle()

        // Still connected: a rebuild offer is not this link's business yet.
        r.socket.deliver(from: "peer-1", resumeOffer())
        await settle()
        XCTAssertTrue(r.controls[0].resumeOffers.isEmpty,
                      "an open link has no gap for a rebuild to fill")

        r.admission.didInterrupt()
        r.socket.deliver(from: "peer-1", resumeOffer())
        await settle()

        XCTAssertEqual(r.controls[0].resumeOffers.count, 1)
        XCTAssertEqual(r.controls[0].resumeOffers[0].from, "peer-1")
    }

    // MARK: - 8. re-entrancy

    /// `canAcceptLink` is owner code. `LinkAdmission` calls it with its own lock
    /// released precisely so it can read the room back — and the router must do
    /// the same with ITS lock, or the two orders deadlock the signalling delivery
    /// queue the moment a session model implements the obvious predicate.
    ///
    /// Run off the main thread with a bounded wait, so a deadlock FAILS instead
    /// of hanging the suite.
    func testAReentrantAcceptPredicateDoesNotDeadlockTheRouter() async {
        let probe = Probe()
        let r = rig(canAcceptLink: { _ in
            probe.fire()
            return true
        })
        probe.arm { [admission = r.admission, router = r.router] in
            _ = admission.phase
            _ = admission.boundPeerId
            admission.didRequestTimeOut(peerId: "peer-9")
            router.detach()
        }

        let done = expectation(description: "the burst was routed")
        let socket = r.socket
        let inbound = Socket.encode(Envelope(type: SignalType.signal,
                                             from: "peer-1", data: offer()))
        DispatchQueue.global().async {
            socket.channel.fireText(inbound)
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 5)
        await settle()

        XCTAssertNil(r.session.peerId, "the detach won, and left nothing half-built")
        XCTAssertEqual(r.admission.phase, .idle, "and nothing is stuck connecting")
    }

    /// The next establishment can begin from INSIDE the terminal callback of the
    /// one that just ended — the shape a room owner really has, because the
    /// signal that starts the next link can arrive in the same turn the last one
    /// dies. It must produce one link, not two, and must not strand the room.
    func testTheNextEstablishmentCanStartFromInsideTheTerminalCallback() async {
        let r = rig(realControl: true)
        r.socket.deliver(from: "peer-1", offer())
        await settle()
        let attempt = r.session.attempt
        let previous = attempt?.onLifecycle
        attempt?.onLifecycle = { [weak r] event in
            previous?(event)
            guard case .ended = event, let r else { return }
            r.socket.deliver(from: "peer-2", self.offer("v=0 next"))
        }

        r.transports[0].fail()
        await settle()

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-2"))
        XCTAssertEqual(r.session.peerId, "peer-2")
        XCTAssertEqual(r.transports.count, 2, "exactly two links, ever")
        XCTAssertTrue(r.socket.busied.isEmpty, "and the second peer was not refused")
    }

    /// A peer that comes back after its own establishment failed is admitted
    /// again rather than answered on behalf of a link that is gone.
    func testAPeerIsAdmittedAgainAfterItsEstablishmentFailed() async {
        let r = rig(realControl: true)
        r.socket.deliver(from: "peer-1", offer())
        await settle()
        r.transports[0].fail()
        await settle()
        XCTAssertEqual(r.admission.phase, .failed)

        r.socket.deliver(from: "peer-1", offer("v=0 retry"))
        await settle()

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))
        XCTAssertEqual(r.transports.count, 2)
        XCTAssertEqual(r.session.peerId, "peer-1")
    }

    // MARK: - 9. the boundaries hold

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

    /// `apps/`, discovered rather than counted, and checked for existing.
    private var appsRoot: URL {
        get throws { try RepoRoot.apps() }
    }

    private func appSources() throws -> [(name: String, code: String)] {
        // Each root must exist. `RepoRoot.directory` throws with the path it
        // wanted, where a missing root used to be skipped one line below and the
        // scan then reported clean over nothing.
        let roots = try ["apps/RelayiumKit/Sources", "apps/ios", "apps/mac"]
            .map { try RepoRoot.directory($0) }
        var sources: [(String, String)] = []
        for root in roots {
            for file in try RepoRoot.swiftFiles(in: root) {
                sources.append((file.lastPathComponent, code(try RepoRoot.text(of: file))))
            }
        }
        XCTAssertGreaterThan(sources.count, 50, "the scan really reached the app sources")
        return sources
    }

    private func appSource(_ name: String) throws -> String {
        let url = try appsRoot.appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/\(name)")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "\(name) must be readable")
        return source
    }

    /// ONE production owner, and it is named.
    ///
    /// The property this used to assert — "nothing constructs a router" —
    /// became false when the Workspace was wired, and pretending otherwise
    /// would be the weakest kind of green. What has to stay true is that
    /// exactly one thing does, so a second room owner cannot appear and route
    /// the same socket twice.
    func testTheRouterHasExactlyOneProductionOwner() throws {
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        // ONE production owner, and it is named. The property this used to
        // assert — "nothing constructs one" — became false when the Workspace
        // was wired; what has to stay true is that exactly one thing does, so a
        // second room owner cannot appear and route the same socket twice.
        var owners: [String] = []
        for source in try appSources() where source.name != "LinkRoomRouter.swift" {
            if source.code.contains("LinkRoomRouter(") { owners.append(source.name) }
        }
        XCTAssertEqual(owners, ["LinkWorkspaceModel.swift"],
                       "exactly one production owner may construct a link room router")
    }

    /// Internal, like everything else below this line. A `public` router would be
    /// reachable from an app target whatever the flags say.
    func testTheRouterIsInternal() throws {
        let source = try appSource("LinkRoomRouter.swift")
        XCTAssertTrue(source.contains("final class LinkRoomRouter"))
        XCTAssertFalse(source.contains("public "), "nothing here is public API")
    }

    /// Cut B owns request, roster and physical-departure policy. App callback
    /// composition and authenticated outbound leave remain separate cuts.
    func testTheRouterContainsCutBButNoAppWiringOrOutboundSigningScope() throws {
        let source = try appSource("LinkRoomRouter.swift")

        XCTAssertTrue(source.contains("admitRequest"))
        XCTAssertTrue(source.contains("linkRequestSignal"))
        XCTAssertTrue(source.contains("LinkRecoveryScheduler"))
        XCTAssertTrue(source.contains("func rosterChanged"))
        XCTAssertTrue(source.contains("func peerLeft"))

        for forbidden in ["didBeginRequesting", "didRequestTimeOut",
                          "linkLeaveSignal", "signResume",
                          "resumeAuth", "onPeers", "onPeerLeft", "retain(", "reset()",
                          "DispatchQueue.main.asyncAfter", "Deadline"] {
            XCTAssertFalse(source.contains(forbidden),
                           "the router must not name \(forbidden)")
        }
    }

    /// The one-link rule is admission's, and the router reads it through
    /// `route`/`admitEstablishment` alone. A router that re-derived a decision
    /// from the signal — a second `isLinkOffer` clause, its own role rule —
    /// would be a second policy that can silently disagree with the
    /// authoritative one.
    func testTheRouterDerivesNoDecisionOfItsOwn() throws {
        let source = try appSource("LinkRoomRouter.swift")

        for forbidden in ["isLinkOffer", "isLinkRequest", "isLinkBusy",
                          "parsedLinkLeaveAuth", "parseSDP", "parseICE",
                          "linkRole", "signalGeneration", "peerCaps("] {
            XCTAssertFalse(source.contains(forbidden),
                           "the router must not decide \(forbidden) for itself")
        }
        XCTAssertTrue(source.contains("admission.route("))
        XCTAssertTrue(source.contains("admission.admitEstablishment("))
        XCTAssertTrue(source.contains("LINK_CAPABILITY"))
    }

    /// The two admission transitions this layer may make, and no third.
    /// `didBeginEstablishing` is `LinkRoomSession.begin`'s, `didOpen` is the
    /// runtime's, and every gap transition is the coordinator's; the only release
    /// the router owns is the claim that never reached `beginAdmitted`.
    func testTheRouterMakesOnlyTheOneReleaseItOwns() throws {
        let source = try appSource("LinkRoomRouter.swift")

        XCTAssertEqual(source.components(separatedBy: "admission.didClose()").count - 1, 1,
                       "one release, for a claim nothing else can free")
        for forbidden in ["didBeginEstablishing", "didOpen", "didFail", "didInterrupt",
                          "didReplaceTransport", "didBeginReplacingTransport",
                          "didEndReplacingTransport"] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) belongs to another layer")
        }
        XCTAssertTrue(source.contains("beginAdmitted("),
                      "the claim is handed over, never re-announced")
    }
    // MARK: - the relay gate: a handoff the room asked to hold

    /// **Nothing is built while the gate is held.**
    ///
    /// The gate exists because the ICE configuration is read exactly once, when
    /// the assembly is created, and the room's relay choice may not have settled
    /// yet. So the claim, the busy answers and the buffering all still happen on
    /// the delivery queue — only the step that reads the configuration waits.
    func testAHeldGateAssemblesNothingUntilItIsReleased() async {
        let rig = rig(holdingHandoff: true)
        rig.socket.deliver(from: "peer-1", offer())
        await settle()

        XCTAssertTrue(rig.transports.isEmpty, "the assembly reads the ICE config; it must wait")
        XCTAssertEqual(rig.socket.slot.count, 0, "the offer was still CONSUMED, not passed on")

        rig.router.releaseHandoff()
        await settle()

        XCTAssertEqual(rig.peers, ["peer-1"])
        XCTAssertEqual(rig.initialSignals.count, 1)
        XCTAssertEqual(rig.initialSignals.first ?? nil, offer(),
                       "the offer that opened the establishment must survive the hold")
    }

    /// The candidates that chase a held offer are exactly what the hold could
    /// lose, and they are the ones a relayed link cannot connect without.
    /// `LinkEstablishmentSignalBuffer` already holds them for the one-turn
    /// handoff; holding that handoff for longer must not change what it holds,
    /// how many, or in what order.
    func testCandidatesChasingAHeldOfferAreReplayedInArrivalOrder() async {
        let rig = rig(holdingHandoff: true)
        rig.socket.deliver(from: "peer-1", offer())
        for i in 0..<5 { rig.socket.deliver(from: "peer-1", candidate("c\(i)")) }
        await settle()

        XCTAssertTrue(rig.transports.isEmpty)
        XCTAssertEqual(rig.socket.slot.count, 0, "held frames are consumed, not left to the slot")

        rig.router.releaseHandoff()
        await settle()

        XCTAssertEqual(rig.controls.first?.received.map(\.signal),
                       (0..<5).map { candidate("c\($0)") },
                       "arrival order is the contract, and the hold does not change it")
    }

    /// The bound is the bound, and it fails CLOSED rather than truncating.
    /// A longer hold is a longer window for a peer to flood, so this is the one
    /// property the change could weaken.
    func testAFloodDuringTheHoldFailsTheEstablishmentClosedAndFreesTheRoom() async {
        let rig = rig(holdingHandoff: true)
        rig.socket.deliver(from: "peer-1", offer())
        for i in 0...LINK_PENDING_CANDIDATE_MAX {
            rig.socket.deliver(from: "peer-1", candidate("c\(i)"))
        }
        await settle()

        XCTAssertTrue(rig.transports.isEmpty, "still nothing assembled")
        XCTAssertEqual(rig.admission.boundPeerId, "",
                       "the room a doomed establishment took must be given back")

        // And the room really is free: a second peer is admitted once the gate
        // opens, rather than answered busy on behalf of a link that never was.
        rig.router.releaseHandoff()
        rig.socket.deliver(from: "peer-2", offer())
        await settle()

        XCTAssertEqual(rig.peers, ["peer-2"])
    }

    /// An outbound ask is the room's own, not this object's, so the gate does
    /// not hold `ensure` — but a request whose offer crosses the gate must not
    /// assemble early either. The request itself still goes out immediately when
    /// the caller asks for it; `LinkWorkspaceModel` is what holds that decision.
    func testTheGateHoldsTheInboundOfferOfAnOutboundRequest() async {
        let rig = rig(peers: ["peer-1"], holdingHandoff: true)
        _ = rig.router.ensure(peerId: "aaa-smaller")
        await settle()

        let hello: JSONValue = .object(["caps": .array([.string(LINK_CAPABILITY)])])
        _ = rig.capabilities.record(peerId: "aaa-smaller", signal: hello)
        rig.socket.deliver(from: "aaa-smaller", offer())
        await settle()
        XCTAssertTrue(rig.transports.isEmpty)

        rig.router.releaseHandoff()
        await settle()
        XCTAssertEqual(rig.peers, ["aaa-smaller"])
    }

    /// **A new socket is a new room, and its gate is its own.**
    ///
    /// Carrying a hold across the epoch would strand the new room behind a gate
    /// only the old room's relay wait could open; carrying an OPEN gate across
    /// would let the new room build on a decision made about different
    /// credentials. Both are the same bug in opposite directions.
    func testANewEpochReplacesTheHoldRatherThanInheritingIt() async {
        let rig = rig(holdingHandoff: true)
        rig.socket.deliver(from: "peer-1", offer())
        await settle()
        XCTAssertTrue(rig.transports.isEmpty)

        let next = Socket(selfId: selfId)
        rig.socket = next
        rig.router.attach(to: next.client)
        next.deliver(from: "peer-2", offer())
        await settle()

        XCTAssertEqual(rig.peers, ["peer-2"],
                       "the new room is not held, and the old room's offer is not assembled")
    }

    /// Releasing a gate nobody held, twice, changes nothing. `applyRelayChoice`
    /// can reach a room whose socket has already been replaced, and the epoch
    /// has cleared the hold by then.
    func testReleasingAnUnheldGateIsInert() async {
        let rig = rig()
        rig.router.releaseHandoff()
        rig.router.releaseHandoff()
        rig.socket.deliver(from: "peer-1", offer())
        await settle()

        XCTAssertEqual(rig.peers, ["peer-1"])
    }

    /// **A hold on the NEXT room must not keep the last room's link alive.**
    ///
    /// `attach` retires the previous epoch and installs the new room's hold in
    /// the same breath, so the `.endSession` queued for the departing link sits
    /// behind the new gate. Parked, the old link would stay published for the
    /// whole of the new room's relay wait — which is why teardown is exempt.
    func testTheHoldDoesNotDelayTheDepartingRoomsTeardown() async {
        let rig = rig(realControl: true)
        rig.socket.deliver(from: "peer-1", offer())
        await settle()
        rig.transports.first?.publish(identity(peerId: "peer-1"))
        await settle()
        XCTAssertEqual(rig.admission.boundPeerId, "peer-1")

        let next = Socket(selfId: selfId)
        rig.socket = next
        rig.router.attach(to: next.client, holdingHandoff: true)
        await settle()

        XCTAssertEqual(rig.admission.boundPeerId, "",
                       "the departing link ends with its epoch, not with the next room's gate")
    }

    /// **A room whose precondition became undecided again holds the gate again.**
    ///
    /// The peer whose relay map opened the gate can leave before anything was
    /// built with it, and the next peer must not inherit that permission. The
    /// re-armed hold has to park a handoff exactly as the hold `attach` installs
    /// does — and release exactly as it does.
    func testAReleasedGateCanBeHeldAgainAndHoldsTheNextOffer() async {
        let rig = rig()
        XCTAssertTrue(rig.router.holdHandoff(), "an idle router has nothing to protect")

        rig.socket.deliver(from: "peer-1", offer())
        await settle()
        XCTAssertTrue(rig.transports.isEmpty, "the re-armed hold parks the handoff too")

        rig.router.releaseHandoff()
        await settle()
        XCTAssertEqual(rig.peers, ["peer-1"])
        XCTAssertEqual(rig.initialSignals.first ?? nil, offer(),
                       "and the offer survived the second hold as it survives the first")
    }

    /// **The gate may not be re-armed over an establishment this router holds.**
    ///
    /// A claimed or assembling link owns the queue: its own inbound frames are
    /// ordered behind the handoff, so parking the head again would stall the
    /// signals the connection is being built from — a gate reaching a transport
    /// that already exists, which is the one thing it must never do. The refusal
    /// is answered rather than silent, because the room reads it to decide
    /// whether to shut its outbound half as well.
    func testTheGateCannotBeHeldAgainOverAnEstablishmentTheRouterHolds() async {
        let rig = rig()
        rig.socket.deliver(from: "peer-1", offer())
        await settle()
        XCTAssertEqual(rig.peers, ["peer-1"])

        XCTAssertFalse(rig.router.holdHandoff(),
                       "a claimed establishment is not something a gate may park")

        rig.socket.deliver(from: "peer-1", candidate("c0"))
        await settle()
        XCTAssertEqual(rig.controls[0].received.map(\.signal), [candidate("c0")],
                       "the live establishment's own frames must keep reaching it")
    }

    /// A router with no socket has no epoch to hold. The next `attach` takes its
    /// own hold, and answering true here would claim a room this object does not
    /// have.
    func testADetachedRouterCannotBeHeld() async {
        let rig = rig()
        rig.router.detach()
        XCTAssertFalse(rig.router.holdHandoff())
    }
}
