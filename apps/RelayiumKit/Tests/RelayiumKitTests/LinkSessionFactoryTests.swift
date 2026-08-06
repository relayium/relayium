import Combine
import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the recording initial transport
//
// The factory's question is neither the runtime's nor the attempt's: ONE set of
// application ingredients becomes ONE attempt, with the initial transport handed
// over unstarted and every decision below it made by the layer that already owns
// it. So the double here is an ingredient RECORDER that is also a real enough
// transport to publish a link — because the only honest proof that the receive
// directory and the room's admission were forwarded is to drive a batch onto
// disk and to end the link through them.

private final class RecordingTransport: LinkRoutableInitialTransport, @unchecked Sendable {
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

    private var _startCount = 0
    private var _closeCount = 0
    private var _closed = false
    /// Whether all four terminal/publication slots were installed by the time
    /// `start()` ran — the property the runtime's initializer exists to make
    /// structural, read from the transport's own side.
    ///
    /// AND-accumulated across EVERY start rather than overwritten by the last
    /// one. A flag that recorded only the most recent start would be silent
    /// about exactly the bug it exists to catch: an unwired start followed by a
    /// wired one, which is what an assembly that started the transport itself
    /// before handing it on would produce.
    private var _callbacksAtStart = true

    /// Runs INSIDE `start()`, which is the exact instant a real transport begins
    /// being able to speak. A test uses it to state what must already have been
    /// wired above by then.
    var duringStart: (() -> Void)?

    /// Every signal handed in through `receive`, with its claimed sender.
    private var _routed: [(from: String, signal: JSONValue)] = []
    /// `start` and `receive` in the order this transport was told them — the
    /// only place the handover's ordering is observable, because both calls
    /// enter one serial queue on the real transport and neither answers.
    private var _order: [String] = []

    var startCount: Int { state.lock(); defer { state.unlock() }; return _startCount }
    var closeCount: Int { state.lock(); defer { state.unlock() }; return _closeCount }
    var routed: [(from: String, signal: JSONValue)] {
        state.lock(); defer { state.unlock() }; return _routed
    }
    var callOrder: [String] { state.lock(); defer { state.unlock() }; return _order }
    /// True only if EVERY start this transport saw found all four slots
    /// installed — and vacuously true for a transport that was never started,
    /// which is why the tests below assert the start count as well.
    var everyStartFoundEveryCallbackInstalled: Bool {
        state.lock(); defer { state.unlock() }; return _callbacksAtStart
    }

    func start() {
        let wired = onSAS != nil && onReady != nil && onError != nil && onClose != nil
        state.lock()
        _startCount += 1
        _order.append("start")
        _callbacksAtStart = _callbacksAtStart && wired
        state.unlock()
        duringStart?()
    }

    func receive(from: String, signal: JSONValue) {
        state.lock()
        _routed.append((from, signal))
        _order.append("receive")
        state.unlock()
    }

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        state.lock(); defer { state.unlock() }
        guard !_closed else { throw LinkTransportError.closed }
    }

    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }

    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }

    func close() {
        state.lock(); _closed = true; _closeCount += 1; state.unlock()
    }

    // ── driving the link ────────────────────────────────────────────────────

    /// SAS then publication, as a real transport orders them.
    func publish(_ identity: LinkIdentity, sas: String = "424242") {
        onSAS?(sas)
        onReady?(identity)
    }

    func deliver(_ lane: LinkLane, _ bytes: [UInt8]) { onFrame?(lane, bytes) }
}

/// Exactly what the factory handed each builder, so "forwarded verbatim" is an
/// assertion rather than a reading of the source.
private final class InitialTransportIngredients: @unchecked Sendable {
    var signaling: SignalingClient?
    var peerId: String?
    var role: Role?
    var iceServers: [RTCIceServer]?
    var iceTransportPolicy: RTCIceTransportPolicy?
    var authenticationGeneration: Int?
    var deadlines: LinkDeadlines?
    var calls = 0
    /// The transport's own start count at the instant the builder returned it —
    /// the factory must be handed something unstarted.
    var startCountAtHandover: Int?
}

private final class ReplacementIngredients: @unchecked Sendable {
    var signaling: SignalingClient?
    var iceServers: [RTCIceServer]?
    var iceTransportPolicy: RTCIceTransportPolicy?
    var deadlines: LinkDeadlines?
    var calls = 0
}

@MainActor
final class LinkSessionFactoryTests: XCTestCase {

    // MARK: - fixtures

    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-factory-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private let sendKey = [UInt8](repeating: 0x11, count: 32)
    private let recvKey = [UInt8](repeating: 0x22, count: 32)

    private func signalingClient() -> SignalingClient {
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        return signaling
    }

    private func identity(role: Role = .initiator,
                          peerId: String = "peer-factory") -> LinkIdentity {
        LinkIdentity(peerId: peerId, role: role, sas: "424242",
                     codecs: LinkCodecs(sendKey: sendKey, recvKey: recvKey),
                     authenticationGeneration: 7)
    }

    private struct Rig {
        let attempt: LinkSessionAttempt
        /// The room's handle on the same link, from the same assembly.
        let control: LinkSessionRoomControl
        let transport: RecordingTransport
        let signaling: SignalingClient
        let admission: LinkAdmission
        let iceServers: [RTCIceServer]
        let deadlines: LinkDeadlines
        let initial: InitialTransportIngredients
        let replacement: ReplacementIngredients
        /// Seals with the link's RECEIVE key, so its frames really decrypt.
        let peer: RealtimeSender
    }

    /// One attempt built through the factory's own composition, with only the
    /// two things a unit test cannot have — a live PeerConnection and a live
    /// rebuild — replaced by recorders.
    private func rig(peerId: String = "peer-factory",
                     role: Role = .initiator,
                     receiveDirectory: URL? = nil,
                     authenticationGeneration: Int = 7,
                     iceTransportPolicy: RTCIceTransportPolicy = .relay,
                     admission: LinkAdmission? = nil,
                     initialSignal: JSONValue? = nil,
                     transport: RecordingTransport = RecordingTransport()) -> Rig {
        let signaling = signalingClient()
        let servers = [RTCIceServer(urlStrings: ["stun:stun.example:3478"])]
        let deadlines = LinkDeadlines(setupHardCap: 11, noProgress: 12,
                                      keyReveal: 13, maxCandidateProgress: 14)
        let admission = admission ?? LinkAdmission(selfId: { "self-id" },
                                                   supportsLink: { _ in true })
        let initial = InitialTransportIngredients()
        let replacement = ReplacementIngredients()

        let assembly = LinkSessionFactory.make(
            signaling: signaling,
            peerId: peerId,
            role: role,
            iceServers: servers,
            iceTransportPolicy: iceTransportPolicy,
            authenticationGeneration: authenticationGeneration,
            receiveDirectory: receiveDirectory ?? dir,
            admission: admission,
            deadlines: deadlines,
            initialSignal: initialSignal,
            buildInitialTransport: { signaling, peerId, role, servers, policy,
                                     generation, deadlines in
                initial.calls += 1
                initial.signaling = signaling
                initial.peerId = peerId
                initial.role = role
                initial.iceServers = servers
                initial.iceTransportPolicy = policy
                initial.authenticationGeneration = generation
                initial.deadlines = deadlines
                initial.startCountAtHandover = transport.startCount
                return transport
            },
            buildReplacementFactory: { signaling, servers, policy, deadlines in
                replacement.calls += 1
                replacement.signaling = signaling
                replacement.iceServers = servers
                replacement.iceTransportPolicy = policy
                replacement.deadlines = deadlines
                return { _ in throw LinkTransportError.notReady }
            })

        return Rig(attempt: assembly.attempt, control: assembly.control,
                   transport: transport, signaling: signaling,
                   admission: admission, iceServers: servers, deadlines: deadlines,
                   initial: initial, replacement: replacement,
                   peer: RealtimeSender(sessionKey: recvKey))
    }

    /// Let every main-actor consumer that is already scheduled run, for the
    /// checks that assert something does NOT arrive.
    private func settle(_ turns: Int = 4) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// Wait until the projection satisfies `condition`, or fail. The event path
    /// hops to the main actor, so nothing below can assert synchronously.
    private func wait(_ description: String,
                      until condition: @MainActor () -> Bool,
                      rounds: Int = 400) async {
        for _ in 0..<rounds {
            if condition() { return }
            await Task.yield()
        }
        XCTAssertTrue(condition(), description)
    }

    // MARK: - 1. one attempt, from the ingredients it was given

    /// The factory builds each half of the link exactly once and answers with a
    /// live attempt. Two initial transports would be two establishments into one
    /// pair of lanes; two replacement factories would be two rebuild policies.
    func testTheFactoryAssemblesOneAttemptFromOneOfEachIngredient() {
        let r = rig()

        XCTAssertEqual(r.initial.calls, 1, "exactly one initial transport")
        XCTAssertEqual(r.replacement.calls, 1, "exactly one replacement factory")
        XCTAssertFalse(r.attempt.isRetired, "the attempt it answers with is live")
        XCTAssertTrue(r.attempt.model.textMessages.isEmpty, "and has said nothing yet")
        XCTAssertTrue(r.attempt.fileModel.batches.isEmpty)
    }

    /// Every ingredient reaches the initial transport exactly as the application
    /// resolved it. This layer re-decides none of them: the peer and the role are
    /// admission's, the ICE configuration is the room's, and the generation is
    /// the owner's identity for this authentication step.
    func testEveryIngredientReachesTheInitialTransportVerbatim() {
        let r = rig(peerId: "peer-verbatim", role: .responder,
                    authenticationGeneration: 9, iceTransportPolicy: .relay)

        XCTAssertTrue(r.initial.signaling === r.signaling, "one socket, not a new one")
        XCTAssertEqual(r.initial.peerId, "peer-verbatim")
        XCTAssertEqual(r.initial.role, .responder, "admission's role, never a preference")
        XCTAssertEqual(r.initial.iceServers?.count, 1)
        XCTAssertTrue(r.initial.iceServers?.first === r.iceServers.first,
                      "the exact servers the room was issued")
        XCTAssertEqual(r.initial.iceTransportPolicy, .relay)
        XCTAssertEqual(r.initial.authenticationGeneration, 9)
        XCTAssertEqual(r.initial.deadlines, r.deadlines)
    }

    /// ONE signalling and ICE configuration, shared. A rebuild that reached a
    /// different socket would never be routed an answer, and one issued
    /// different servers or a different policy would be a second, silently
    /// divergent ICE decision for the same link.
    func testTheRebuildIsGivenTheSameSocketAndIceConfigurationAsTheFirstTransport() {
        let r = rig(iceTransportPolicy: .relay)

        XCTAssertTrue(r.replacement.signaling === r.initial.signaling,
                      "the rebuild speaks on the link's own socket")
        XCTAssertTrue(r.replacement.iceServers?.first === r.initial.iceServers?.first,
                      "and is issued the same servers")
        XCTAssertEqual(r.replacement.iceTransportPolicy, r.initial.iceTransportPolicy)
        XCTAssertEqual(r.replacement.deadlines, r.initial.deadlines)
    }

    // MARK: - 2. assembled before started

    /// The transport arrives unstarted. A builder that started it would be
    /// racing its own establishment against the wiring above it.
    func testTheInitialTransportIsHandedOverUnstarted() {
        let r = rig()

        XCTAssertEqual(r.initial.startCountAtHandover, 0,
                       "the builder must answer with a transport that is not running")
        XCTAssertEqual(r.transport.startCount, 1,
                       "and the assembly is what starts it, once")
    }

    /// By the time the transport can speak, everything that listens exists: all
    /// four of its callback slots, and the projections behind them.
    func testNothingStartsUntilEveryCallbackAndBothProjectionsAreWired() async {
        let transport = RecordingTransport()
        let published = identity()
        transport.duringStart = { transport.publish(published) }

        let r = rig(transport: transport)

        XCTAssertEqual(r.transport.startCount, 1, "started once, by the assembly")
        XCTAssertTrue(r.transport.everyStartFoundEveryCallbackInstalled,
                      "all four slots are written before the transport ever runs")
        await wait("a link published from inside start() still paints the screen",
                   until: { r.attempt.model.isOpen })
        XCTAssertEqual(r.attempt.model.sas, "424242")
        XCTAssertEqual(r.attempt.model.peerId, "peer-factory")
    }

    // MARK: - 3. one owner, one lifetime

    /// The attempt is the only thing left holding what was assembled. The
    /// factory is a function: it keeps no registry, no cache and no static
    /// reference, so a released attempt releases the whole link with it.
    func testTheFactoryKeepsNothingOfWhatItBuilt() async {
        weak var observed: RecordingTransport?
        do {
            let transport = RecordingTransport()
            observed = transport
            let attempt = rig(transport: transport).attempt
            XCTAssertNotNil(observed)
            attempt.retire()
        }
        await settle()

        XCTAssertNil(observed, "the attempt was the transport's only surviving owner")
    }

    /// Retiring the attempt reaches all the way down to the transport this
    /// factory built. One assembly, one teardown.
    func testRetiringTheAttemptClosesTheTransportItWasBuiltOn() {
        let r = rig()
        XCTAssertEqual(r.transport.closeCount, 0)

        r.attempt.retire()

        XCTAssertEqual(r.transport.closeCount, 1, "the link this factory built is closed")
        XCTAssertTrue(r.attempt.isRetired)
    }

    // MARK: - 4. admission is forwarded, never driven

    /// Assembling a link is not a lifecycle event. The room owner routed the
    /// signal and already told admission an establishment began; a second
    /// announcement from inside the assembly would be admission policy in the
    /// layer that must not have any.
    func testAssemblingAnAttemptMovesNoAdmissionPhase() {
        let admission = LinkAdmission(selfId: { "self-id" }, supportsLink: { _ in true })
        admission.didBeginEstablishing(peerId: "peer-factory", role: .initiator)

        let r = rig(admission: admission)

        XCTAssertEqual(admission.phase, .connecting(peerId: "peer-factory"),
                       "the assembly announced nothing of its own")
        XCTAssertFalse(r.attempt.isRetired)
    }

    /// The admission the room owns is the one the link's own end reaches. That
    /// is the whole reason it is threaded through: an admission that stayed
    /// `open` after its link ended would answer every later peer `busy` for a
    /// link that no longer exists.
    func testTheRoomsAdmissionIsTheOneTheLinkEndsThrough() {
        let admission = LinkAdmission(selfId: { "self-id" }, supportsLink: { _ in true })
        admission.didOpen(peerId: "peer-factory")
        let r = rig(admission: admission)
        r.transport.publish(identity())
        XCTAssertEqual(admission.phase, .open(peerId: "peer-factory"),
                       "publication alone announces nothing here either")

        r.attempt.retire()

        XCTAssertEqual(admission.phase, .idle,
                       "the room is free again, through the admission it was given")
    }

    // MARK: - 5. the receive directory the application resolved

    /// Drive one inbound batch all the way to disk through the assembled link.
    private func receive(_ r: Rig,
                         name: String = "flat.bin",
                         path: String? = nil) async throws {
        r.transport.publish(identity())
        let body = WireVectors.content(40, seed: 71)
        let files = [FileMeta(name: name, size: body.count, path: path)]

        for frame in try r.peer.batchFrames(files) { r.transport.deliver(.file, frame) }
        await wait("the peer's manifest reaches the projection",
                   until: { r.attempt.fileModel.offers.count == 1 })
        r.attempt.acceptInboundBatch()
        for frame in try r.peer.dataFrames([(files[0], body)]) {
            r.transport.deliver(.file, frame)
        }
        await wait("the batch reaches a terminal state",
                   until: { r.attempt.fileModel.batch(1)?.isTerminal == true })
    }

    /// Inbound files land under the directory the application resolved, and
    /// nowhere else. This is the only assertion that proves the snapshot really
    /// reached the layer that writes bytes.
    func testInboundBatchesLandUnderTheDirectoryTheApplicationResolved() async throws {
        let r = rig()

        try await receive(r)

        let batch = try XCTUnwrap(r.attempt.fileModel.batch(1))
        let files = try XCTUnwrap(batch.receivedFiles)
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0].standardized.path,
                       dir.appendingPathComponent("flat.bin").standardized.path)
        XCTAssertNil(batch.receivedContainer, "a flat batch creates no container")
    }

    /// The directory is a SNAPSHOT taken at assembly. A caller that later points
    /// its own variable somewhere else does not move a transfer that is already
    /// running — which is exactly what a preference re-read per batch would do to
    /// the second half of a folder.
    func testTheReceiveDirectoryIsTheSnapshotTakenAtAssembly() async throws {
        var chosen = dir!
        let r = rig(receiveDirectory: chosen)
        let elsewhere = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-factory-moved-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: elsewhere) }
        chosen = elsewhere

        try await receive(r)

        let files = try XCTUnwrap(r.attempt.fileModel.batch(1)?.receivedFiles)
        XCTAssertEqual(files[0].standardized.path,
                       dir.appendingPathComponent("flat.bin").standardized.path,
                       "the batch landed where the attempt was assembled to write")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: elsewhere.appendingPathComponent("flat.bin").path))
    }

    /// An unreachable directory is refused by the batch that needs it, not by
    /// the assembly. Pre-validating here would be a check that cannot stay true:
    /// a directory can be renamed, unmounted or have its access revoked between
    /// the assembly and the first inbound byte, so the honest place to fail is
    /// where the bytes are actually written.
    func testAnUnreachableReceiveDirectoryRefusesTheBatchRatherThanTheAssembly() async throws {
        let missing = dir.appendingPathComponent("never-created", isDirectory: true)
        let r = rig(receiveDirectory: missing)

        XCTAssertFalse(r.attempt.isRetired, "the assembly itself succeeded")

        r.transport.publish(identity())
        let files = [FileMeta(name: "flat.bin", size: 40, path: nil)]
        for frame in try r.peer.batchFrames(files) { r.transport.deliver(.file, frame) }
        await wait("the peer's manifest reaches the projection",
                   until: { r.attempt.fileModel.offers.count == 1 })
        r.attempt.acceptInboundBatch()

        await wait("the batch is what fails",
                   until: { r.attempt.fileModel.batch(1)?.state == .failed })
        XCTAssertTrue(r.attempt.model.isOpen, "and the link itself is still open")
    }

    // MARK: - 6. the one signal the room already consumed

    private func offer(_ sdp: String = "v=0 admitted") -> JSONValue {
        .object(["link": .bool(true),
                 "caps": .array([.string(LINK_CAPABILITY)]),
                 "commit": .string(String(repeating: "c", count: 44)),
                 "sdp": .object(["type": .string("offer"), "sdp": .string(sdp)])])
    }

    /// The offer that made admission decide this establishment should exist is
    /// handed to the transport by the ASSEMBLY, exactly once and byte for byte.
    /// The room's router consumed it so the live connection could not also act on
    /// it, and nothing sends it again — a caller left to pass it on separately
    /// fails invisibly, as an establishment that simply times out.
    func testTheRoutedOfferReachesTheTransportOnceAndVerbatim() {
        let signal = offer()

        let r = rig(peerId: "peer-routed", role: .responder, initialSignal: signal)

        XCTAssertEqual(r.transport.routed.count, 1, "handed over exactly once")
        XCTAssertEqual(r.transport.routed.first?.signal, signal,
                       "and unaltered — no re-tagging, no re-wrapping")
    }

    /// It is attributed to the peer admission admitted, and cannot be attributed
    /// to anybody else: a routing decision about a peer is made from that peer's
    /// signal, and `LinkSignalPolicy` drops everything from any other sender.
    func testTheRoutedOfferIsAttributedToTheAdmittedPeer() {
        let r = rig(peerId: "peer-attributed", role: .responder, initialSignal: offer())

        XCTAssertEqual(r.transport.routed.first?.from, "peer-attributed")
        XCTAssertEqual(r.transport.routed.first?.from, r.initial.peerId,
                       "the sender is the peer the transport was built for")
    }

    /// The handover comes AFTER the transport starts. Both calls enter the real
    /// transport's one serial queue in issue order, so this is the order in which
    /// the establishment deadlines are armed by the call that owns arming them —
    /// `WebRTCLinkTransport` is bounded either way, because `handleLocked` arms
    /// the watchdog defensively for exactly the reverse case, and this is the
    /// order that does not rely on that defence. Pinned here because a later edit
    /// could reverse it without any behavioural test noticing.
    func testTheRoutedOfferIsHandedOverOnlyAfterTheTransportStarts() {
        let r = rig(role: .responder, initialSignal: offer())

        XCTAssertEqual(r.transport.callOrder, ["start", "receive"],
                       "armed first, then fed")
    }

    /// An establishment with nothing to hand over hands over nothing. An
    /// initiator's link exists because of a content-free `linkRequest`, or
    /// because the user asked; feeding either to a transport would be inventing
    /// a signal the peer never sent.
    func testAnEstablishmentWithNoRoutedSignalIsHandedNothing() {
        let r = rig(role: .initiator)

        XCTAssertTrue(r.transport.routed.isEmpty, "nothing was invented")
        XCTAssertEqual(r.transport.callOrder, ["start"])
    }

    // MARK: - 7. two handles, one owner

    /// The assembly answers with a control for the SAME link the attempt owns:
    /// a departure routed through it ends the link the attempt is projecting.
    /// This is the only assertion that proves the two halves were not built for
    /// two different runtimes.
    func testTheControlReachesTheSameLinkTheAttemptOwns() async {
        let r = rig(peerId: "peer-same")
        r.transport.publish(identity(peerId: "peer-same"))
        await wait("the link opens", until: { r.attempt.model.isOpen })

        r.control.peerDeparted("peer-same")

        await wait("the departure ended the attempt's own link",
                   until: { r.attempt.model.isEnded })
        XCTAssertEqual(r.transport.closeCount, 1, "and closed the transport it was built on")
    }

    /// A departure for somebody else is not this link's business, and the
    /// control adds no opinion of its own about which peer that is — the
    /// coordinator it forwards to already owns that comparison.
    func testADepartureForAnotherPeerLeavesTheLinkAlone() async {
        let r = rig(peerId: "peer-same")
        r.transport.publish(identity(peerId: "peer-same"))
        await wait("the link opens", until: { r.attempt.model.isOpen })

        r.control.peerDeparted("peer-else")
        await settle()

        XCTAssertTrue(r.attempt.model.isOpen, "somebody else leaving is not this link ending")
        XCTAssertFalse(r.attempt.model.isEnded)
    }

    /// Before publication there is no gap to join, and the control says exactly
    /// that rather than inventing an answer — `.unavailable` is the runtime's own
    /// word for it.
    func testJoiningRecoveryBeforePublicationIsUnavailable() {
        let r = rig()

        XCTAssertEqual(r.control.joinRecovery(peerId: "peer-factory") { _ in }, .unavailable)
        XCTAssertTrue(r.control.isLive, "the link exists; it just has no gap")
    }

    /// The control is not an owner. Holding one after the attempt is gone keeps
    /// a handle alive, never a link — no PeerConnection, no TURN allocation, no
    /// receive directory held open.
    func testTheControlDoesNotKeepTheSessionAlive() async {
        weak var observed: RecordingTransport?
        var control: LinkSessionRoomControl?
        do {
            let transport = RecordingTransport()
            observed = transport
            let r = rig(transport: transport)
            control = r.control
            XCTAssertEqual(control?.isLive, true)
            r.attempt.retire()
        }
        await settle()

        XCTAssertNil(observed, "the attempt was the only owner")
        XCTAssertEqual(control?.isLive, false, "and the control knows its link is gone")
        control?.peerDeparted("peer-factory")
        XCTAssertEqual(control?.joinRecovery(peerId: "peer-factory") { _ in }, .unavailable)
    }

    // MARK: - 8. nothing here is reachable from production

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

    /// Every Swift source under the app targets, as code with comments removed.
    private func appSources() throws -> [(name: String, code: String)] {
        let roots = [appsRoot.appendingPathComponent("RelayiumKit/Sources"),
                     appsRoot.appendingPathComponent("ios"),
                     appsRoot.appendingPathComponent("mac")]
        var sources: [(String, String)] = []
        for root in roots {
            guard FileManager.default.fileExists(atPath: root.path) else { continue }
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .filter { $0.pathExtension == "swift" }
            for file in try XCTUnwrap(files) {
                sources.append((file.lastPathComponent,
                                code((try? String(contentsOf: file, encoding: .utf8)) ?? "")))
            }
        }
        XCTAssertGreaterThan(sources.count, 50, "the scan really reached the app sources")
        return sources
    }

    private func factorySource() throws -> String {
        let url = appsRoot
            .appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/LinkSessionFactory.swift")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "the factory source must be readable")
        return source
    }

    /// Both flags are still false and nothing calls the factory: no view, no
    /// app target, no environment. Assembly existing is not assembly being
    /// reachable, and this slice is deliberately only the first.
    func testTheFactoryStaysUnreachableFromProduction() throws {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        for source in try appSources() where source.name != "LinkSessionFactory.swift" {
            XCTAssertFalse(source.code.contains("LinkSessionFactory"),
                           "\(source.name) reaches for the link session factory")
        }
    }

    /// ONE assembly, structurally. The factory is the only app source that
    /// builds an attempt, a runtime, an initial transport or a rebuild factory —
    /// a second one would be a second set of ingredients for one link, and the
    /// two could disagree about the socket, the ICE configuration or the
    /// directory without anything failing until a user's transfer did.
    func testTheFactoryIsTheOnlyPlaceThatBuildsALinkOrItsIngredients() throws {
        // The symbol, and the ONE other file that is allowed to contain it
        // because it declares the thing.
        let owned: [(symbol: String, declaredIn: String)] = [
            ("LinkSessionAttempt(", "LinkSessionAttempt.swift"),
            ("LinkSessionRuntime(", "LinkSessionRuntime.swift"),
            ("WebRTCLinkTransport(", "WebRTCLinkTransport.swift"),
            ("webRTCLinkReplacementFactory(", "WebRTCLinkRecovery.swift"),
        ]

        for source in try appSources() where source.name != "LinkSessionFactory.swift" {
            for entry in owned where source.name != entry.declaredIn {
                XCTAssertFalse(source.code.contains(entry.symbol),
                               "\(source.name) builds \(entry.symbol), which is the factory's")
            }
        }
    }

    /// The factory composes; it decides nothing. No identity, no codec, no peer
    /// connection, no socket of its own, no directory creation, no security
    /// scope, no admission call and no lane owner — every one of those belongs
    /// to a layer that already owns it, and a copy here would be a second policy
    /// that can silently diverge from the authoritative one.
    func testTheFactoryDecidesNothingItWasNotGiven() throws {
        let source = try factorySource()

        for forbidden in ["LinkIdentity", "LinkCodecs", "RTCPeerConnection", "LinkLaneOwner",
                         "LinkRecoveryCoordinator", "LinkAdmission(", "SignalingClient(",
                         "installSignalHandler", "createDirectory",
                         "startAccessingSecurityScopedResource",
                         "didBeginEstablishing", "didOpen", "didFail", "didClose",
                         "deinit"] {
            XCTAssertFalse(source.contains(forbidden),
                           "the factory must not name \(forbidden)")
        }
    }

    /// One attempt, one runtime, and one event path. The runtime is built INSIDE
    /// the attempt's factory closure and handed that attempt's own sink verbatim:
    /// a wrapped, observed or duplicated sink would be a second order over one
    /// link, and two independent hops can deliver a batch's progress before the
    /// offer it belongs to.
    func testTheFactoryBuildsOneRuntimeOnTheAttemptsOwnSink() throws {
        let source = try factorySource()

        XCTAssertEqual(source.components(separatedBy: "LinkSessionAttempt(").count - 1, 1,
                       "exactly one attempt is built")
        XCTAssertEqual(source.components(separatedBy: "LinkSessionRuntime(").count - 1, 1,
                       "exactly one runtime is built")
        XCTAssertEqual(source.components(separatedBy: "onEvent:").count - 1, 1,
                       "and it reports through exactly one sink")
        XCTAssertTrue(source.contains("onEvent: sink"),
                      "the attempt's own sink, unwrapped")
    }

    /// ONE handover, in the one place, after the attempt exists. The behavioural
    /// checks above prove the order for a double; this proves the source cannot
    /// grow a second call — a transport told twice would apply one offer and
    /// silently drop the other, and the drop is the one that would be a real
    /// signal in a burst.
    func testTheFactoryHandsTheRoutedSignalOverExactlyOnceAfterTheAttempt() throws {
        let source = try factorySource()

        XCTAssertEqual(source.components(separatedBy: "transport.receive(").count - 1, 1,
                       "exactly one handover")
        let handover = try XCTUnwrap(source.range(of: "transport.receive("))
        let attempt = try XCTUnwrap(source.range(of: "LinkSessionAttempt("))
        XCTAssertTrue(attempt.upperBound < handover.lowerBound,
                      "the attempt — and therefore start() — comes first")
    }

    /// The assembly hands back one attempt and one control, and the control is
    /// the only thing besides the attempt that names the runtime. Two controls,
    /// or a control built anywhere else, would be a second handle on one link
    /// made by something that cannot know whether an attempt owns it.
    func testTheFactoryBuildsOneAttemptAndOneControlForOneLink() throws {
        let source = try factorySource()

        XCTAssertEqual(source.components(separatedBy: "LinkSessionRoomControl(").count - 1, 1,
                       "exactly one room control")
        XCTAssertEqual(source.components(separatedBy: "LinkSessionAssembly(").count - 1, 1,
                       "handed back as one assembly")
    }
}
