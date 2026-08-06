import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the transport under the assembled link
//
// The room session's question is neither the runtime's nor the factory's: ONE
// admitted establishment becomes ONE assembly, and when that attempt ends the
// room is released by whoever has not already released it. So the double here is
// a transport that can be driven through every ending a real one produces —
// publish, fail, close — because the whole decision turns on which of those
// happened and whether a publication came first.

private final class RoomTransport: LinkRoutableInitialTransport, @unchecked Sendable {
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
    private var _startCount = 0

    /// Runs inside `start()`, which is the exact instant a real transport begins
    /// being able to speak — and therefore the instant a room owner has not yet
    /// returned from `begin`.
    var duringStart: (() -> Void)?

    var closeCount: Int { state.lock(); defer { state.unlock() }; return _closeCount }
    var startCount: Int { state.lock(); defer { state.unlock() }; return _startCount }

    func start() {
        state.lock(); _startCount += 1; state.unlock()
        duringStart?()
    }

    func receive(from: String, signal: JSONValue) {}
    func send(_ bytes: [UInt8], on lane: LinkLane) throws {}
    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }

    func close() {
        state.lock(); _closed = true; _closeCount += 1; state.unlock()
    }

    // ── driving the link ────────────────────────────────────────────────────

    func publish(_ identity: LinkIdentity, sas: String = "424242") {
        onSAS?(sas)
        onReady?(identity)
    }

    /// A transport that failed: `onError` then `onClose`, as a real one reports.
    func fail(_ error: Error = LinkTransportError.peerConnectionFailed) {
        onError?(error)
        onClose?()
    }

    /// A transport the peer hung up on: `onClose` alone.
    func hangUp() { onClose?() }
}

@MainActor
final class LinkRoomSessionTests: XCTestCase {

    // MARK: - fixtures

    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-room-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private let sendKey = [UInt8](repeating: 0x41, count: 32)
    private let recvKey = [UInt8](repeating: 0x42, count: 32)

    private func identity(peerId: String, role: Role = .initiator) -> LinkIdentity {
        LinkIdentity(peerId: peerId, role: role, sas: "424242",
                     codecs: LinkCodecs(sendKey: sendKey, recvKey: recvKey),
                     authenticationGeneration: 5)
    }

    private func signalingClient() -> SignalingClient {
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        return signaling
    }

    /// Everything one assembled establishment is made of, recorded so a test can
    /// drive the transport the room's link is really running on.
    private final class Assembled {
        var transports: [RoomTransport] = []
        var peers: [String] = []
        var roles: [Role] = []
        var signals: [JSONValue?] = []
        /// Supplied by a test that needs the transport to speak from inside
        /// `start()` — i.e. before `begin` has returned.
        var duringStart: (() -> Void)?
    }

    /// A class rather than a struct so a re-entrancy test can capture it weakly:
    /// the handlers below stand in for a future router, and one that retained the
    /// room it is driving would be the cycle this batch is checking for.
    private final class Rig {
        let session: LinkRoomSession
        let admission: LinkAdmission
        let assembled: Assembled

        init(session: LinkRoomSession, admission: LinkAdmission, assembled: Assembled) {
            self.session = session
            self.admission = admission
            self.assembled = assembled
        }
    }

    /// A room session over the real factory composition, with only the two things
    /// a unit test cannot have — a live PeerConnection and a live rebuild —
    /// replaced. Everything between the room and the transport is production
    /// code: the factory, the attempt, the bridge, the runtime and the
    /// coordinator.
    private func rig(canAcceptLink: @escaping (String) -> Bool = { _ in true }) -> Rig {
        let signaling = signalingClient()
        let admission = LinkAdmission(selfId: { "self-room" },
                                      supportsLink: { _ in true },
                                      canAcceptLink: canAcceptLink)
        let assembled = Assembled()
        let dir = self.dir!
        let session = LinkRoomSession(admission: admission) { peerId, role, initialSignal in
            let transport = RoomTransport()
            transport.duringStart = assembled.duringStart
            assembled.transports.append(transport)
            assembled.peers.append(peerId)
            assembled.roles.append(role)
            assembled.signals.append(initialSignal)
            return LinkSessionFactory.make(
                signaling: signaling,
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
                buildReplacementFactory: { _, _, _, _ in
                    { _ in throw LinkTransportError.notReady }
                })
        }
        return Rig(session: session, admission: admission, assembled: assembled)
    }

    /// Let every main-actor consumer that is already scheduled run. The bridge
    /// delivers on the next turn, so nothing below can assert synchronously.
    private func settle(_ turns: Int = 8) async {
        for _ in 0..<turns { await Task.yield() }
    }

    // MARK: - 1. one establishment, announced and assembled

    /// The room is told an establishment began, for the peer and in the role
    /// admission decided, and exactly one link is assembled from it.
    func testBeginningAnEstablishmentAnnouncesItAndAssemblesOneLink() {
        let r = rig()

        XCTAssertTrue(r.session.begin(peerId: "peer-1", role: .responder))

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))
        XCTAssertEqual(r.assembled.transports.count, 1, "exactly one link")
        XCTAssertEqual(r.assembled.peers, ["peer-1"])
        XCTAssertEqual(r.assembled.roles, [.responder], "admission's role, not a preference")
        XCTAssertEqual(r.session.peerId, "peer-1")
        XCTAssertFalse(r.session.isPublished)
        XCTAssertNotNil(r.session.attempt)
    }

    /// The signal the router already consumed travels through to the assembly,
    /// which is what hands it to the transport. Nothing here reads it.
    func testTheRoutedSignalTravelsThroughToTheAssembly() {
        let r = rig()
        let offer = JSONValue.object(["link": .bool(true),
                                      "sdp": .object(["type": .string("offer"),
                                                      "sdp": .string("v=0 routed")])])

        r.session.begin(peerId: "peer-1", role: .responder, initialSignal: offer)

        XCTAssertEqual(r.assembled.signals, [offer])
    }

    /// A second establishment while one is held is refused whole: no admission
    /// call, no assembly, and the first link untouched. The one-link rule is
    /// admission's; this is the backstop that stops a router's mistake from
    /// becoming two live attempts.
    func testASecondEstablishmentIsRefusedWithoutTouchingTheFirst() {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        let first = r.session.attempt

        XCTAssertFalse(r.session.begin(peerId: "peer-2", role: .initiator))

        XCTAssertEqual(r.assembled.transports.count, 1, "nothing was assembled")
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"),
                       "and the room still names the first peer")
        XCTAssertTrue(r.session.attempt === first)
    }

    /// Admission is announced BEFORE anything is assembled. A transport can
    /// publish — and therefore claim `didOpen` — from inside `start()`, which
    /// runs before `begin` returns; announcing afterwards would overwrite that
    /// open with a connecting and leave the room lying about a live link.
    func testAPublicationFromInsideTheAssemblyIsNotOverwrittenByTheAnnouncement() async {
        let r = rig()
        r.assembled.duringStart = { [weak r] in
            guard let r else { return }
            r.assembled.transports.last?.publish(self.identity(peerId: "peer-eager"))
        }

        r.session.begin(peerId: "peer-eager", role: .initiator)

        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-eager"),
                       "the open the runtime claimed survived the announcement")
        await settle()
        XCTAssertTrue(r.session.isPublished,
                      "and the room heard about it, though the hook was installed after")
    }

    // MARK: - 1b. beginning an establishment the caller already claimed

    /// A valid authenticated rebuild offer, as the interrupted link's peer sends
    /// one. What it routes to is decided by the role the establishment settled,
    /// which is the whole point of the two tests below.
    private func resumeOffer() -> JSONValue {
        .object(["resume": .bool(true),
                 "auth": .string(String(repeating: "a", count: LINK_AUTH_TAG_LENGTH)),
                 "sdp": .object(["type": .string("offer"), "sdp": .string("v=0 rebuild")])])
    }

    /// `beginAdmitted` assembles, and does NOT announce — proved through a whole
    /// lifecycle rather than by reading the source.
    ///
    /// The role argument here is deliberately WRONG. A caller that reserved the
    /// room atomically has already settled the role, and this call passes the
    /// opposite one: if `beginAdmitted` announced through `didBeginEstablishing`,
    /// that announcement would overwrite `establishedRole` with `.responder` and
    /// nothing at this point would look amiss. The damage would surface much
    /// later, during recovery — only a responder consumes an inbound
    /// authenticated resume offer, because the initiator drives its own — so this
    /// asserts through an interruption, where the two answers differ.
    ///
    /// Admission is driven to `open` and `interrupted` directly, because the
    /// question is what `beginAdmitted` did or did not announce, not what the
    /// runtime under it would have reported.
    func testBeginningAnAdmittedEstablishmentDoesNotReAnnounceTheRole() {
        let r = rig()
        XCTAssertTrue(r.admission.admitEstablishment(peerId: "peer-1", role: .initiator),
                      "the caller claimed the room atomically, as a router does")

        XCTAssertTrue(r.session.beginAdmitted(peerId: "peer-1", role: .responder))

        XCTAssertEqual(r.assembled.transports.count, 1, "exactly one assembly")
        XCTAssertEqual(r.assembled.peers, ["peer-1"])
        XCTAssertEqual(r.session.peerId, "peer-1")
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"),
                       "and the phase the claim set is simply still true")

        r.admission.didOpen(peerId: "peer-1")
        r.admission.didInterrupt()

        XCTAssertEqual(r.admission.route(from: "peer-1", signal: resumeOffer()), .ignore,
                       "the claim's initiator role survived: this side drives its own rebuild")
    }

    /// The positive control. `begin` — the path for a caller that did NOT claim
    /// the room — announces, and its announcement is what settles the role. Both
    /// halves are needed: without this one the assertion above would hold just as
    /// well against a resume offer that could never be consumed by anybody.
    func testBeginningAnUnclaimedEstablishmentIsWhatSettlesTheRole() {
        let r = rig()

        XCTAssertTrue(r.session.begin(peerId: "peer-1", role: .responder))

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-1"))
        r.admission.didOpen(peerId: "peer-1")
        r.admission.didInterrupt()

        XCTAssertEqual(r.admission.route(from: "peer-1", signal: resumeOffer()), .resumeOffer,
                       "announced as responder, so an inbound rebuild offer is this side's")
    }

    // MARK: - 2. the room is released when nobody else will

    /// The gap this object exists to close. A transport that fails before it ever
    /// publishes leaves no coordinator behind, so without this the room would sit
    /// at `.connecting` for the rest of the session, refusing every later peer on
    /// behalf of a link that never existed.
    func testAnEstablishmentThatFailsBeforePublicationFailsTheRoom() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)

        r.assembled.transports[0].fail()
        await settle()

        XCTAssertEqual(r.admission.phase, .failed)
        XCTAssertNil(r.session.peerId, "and the establishment is given up")
        XCTAssertNil(r.session.attempt)
    }

    /// A peer that hangs up during establishment closes cleanly. That is not a
    /// fault, so the room goes back to idle and is immediately usable — the same
    /// reading `LinkRecoveryCoordinator` gives a transport that closed with no
    /// error.
    func testAnEstablishmentThePeerClosesFreesTheRoom() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)

        r.assembled.transports[0].hangUp()
        await settle()

        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertNil(r.session.peerId)
    }

    /// After the room is released, the next establishment can be announced and
    /// assembled — which is the whole point of releasing it.
    func testTheRoomIsUsableAgainAfterAFailedEstablishment() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.assembled.transports[0].fail()
        await settle()

        XCTAssertTrue(r.session.begin(peerId: "peer-2", role: .initiator))

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-2"))
        XCTAssertEqual(r.assembled.transports.count, 2)
    }

    // MARK: - 3. and never when somebody else already has

    /// A link that published and then ended has gone through the coordinator,
    /// which released the room with the reason its gap actually had. This object
    /// adds nothing: the assertion is that the room is idle because the
    /// coordinator made it idle, and that a second transition did not move it on
    /// to something else.
    func testAPublishedLinkEndingIsReleasedByTheCoordinatorAlone() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.assembled.transports[0].publish(identity(peerId: "peer-1"))
        await settle()
        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-1"))
        XCTAssertTrue(r.session.isPublished)

        // An idle link is declined rather than held, so this ends the link.
        r.assembled.transports[0].fail()
        await settle()

        XCTAssertEqual(r.admission.phase, .failed,
                       "the coordinator's reading of a transport that died with an error")
        XCTAssertNil(r.session.peerId, "and the room gave up the establishment")
    }

    /// The same, for a clean close after publication: the coordinator frees the
    /// room, and this object does not turn that into a failure.
    func testAPublishedLinkClosingCleanlyLeavesTheRoomFree() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.assembled.transports[0].publish(identity(peerId: "peer-1"))
        await settle()

        r.assembled.transports[0].hangUp()
        await settle()

        XCTAssertEqual(r.admission.phase, .idle)
    }

    /// The duplicate-release hazard, stated directly.
    ///
    /// A terminal report whose reason does not itself prove the coordinator ran
    /// — `.stopped` is the one such reason — must still change nothing once the
    /// link has published, because a coordinator exists and the release is its
    /// call to make. A room that released here would leave admission IDLE under a
    /// live link: the next peer would be admitted into a room that already has
    /// one, and both would then be answered for the same lanes.
    ///
    /// It is driven through the attempt's own lifecycle seam rather than by
    /// stopping the runtime, because every path that really stops a published
    /// runtime goes through `retire()`, which silences the bridge first — so this
    /// is the only way to make the report the rule is about actually arrive.
    func testAStopReportedByAPublishedLinkDoesNotReleaseTheRoom() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.assembled.transports[0].publish(identity(peerId: "peer-1"))
        await settle()
        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-1"))

        let report = r.session.attempt?.onLifecycle
        XCTAssertNotNil(report)
        report?(.ended(.stopped))
        await settle()

        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-1"),
                       "the room did not release a link its coordinator still holds")
    }

    /// The same rule for the ending the coordinator really does produce: a held
    /// link that ends reports `.linkEnded`, and the room adds nothing to whatever
    /// the coordinator already decided — not even when that decision was
    /// `.failed` rather than `.idle`.
    func testTheHeldLinkEndingIsNotSecondGuessedByTheRoom() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.assembled.transports[0].publish(identity(peerId: "peer-1"))
        await settle()
        let report = r.session.attempt?.onLifecycle

        report?(.ended(.linkEnded))
        await settle()

        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-1"),
                       "only the coordinator moves a published link's room")
    }

    // MARK: - 4. ending it from above

    /// Retiring silences the attempt's bridge before it stops the runtime, so no
    /// terminal callback ever arrives. An unpublished establishment therefore has
    /// nothing left that could release the room — `end()` is what does it.
    func testEndingAnUnpublishedEstablishmentReleasesTheRoom() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)

        r.session.end()
        await settle()

        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertEqual(r.assembled.transports[0].closeCount, 1, "the link is really closed")
        XCTAssertNil(r.session.peerId)
        XCTAssertNil(r.session.attempt)
    }

    /// A published one is released by the coordinator from inside the same
    /// `retire()`, so `end()` must not make a second transition of its own.
    func testEndingAPublishedLinkLeavesTheReleaseToTheCoordinator() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.assembled.transports[0].publish(identity(peerId: "peer-1"))
        await settle()

        r.session.end()
        await settle()

        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertEqual(r.assembled.transports[0].closeCount, 1)
        XCTAssertNil(r.session.peerId)
    }

    /// Idempotent, and inert with nothing held: a second `end()` must not close a
    /// room that a LATER establishment has already begun using.
    func testEndingTwiceChangesNothingTheSecondTime() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.session.end()
        await settle()
        r.session.begin(peerId: "peer-2", role: .initiator)

        r.session.end()
        r.session.end()
        await settle()

        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertEqual(r.assembled.transports.count, 2, "no third link was built")
    }

    // MARK: - 5. superseded callbacks change nothing

    /// A terminal callback from an establishment this object no longer holds is
    /// dropped whole. Without the generation, the ending of a link that was given
    /// up would release a room the NEXT establishment is already using — and that
    /// next peer would then be refused for the rest of the session.
    func testATerminalReportFromASupersededEstablishmentIsDropped() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        // The very closure `begin` installed on the first attempt, carrying that
        // establishment's generation. Retiring silences the bridge, so this is
        // the only way to make the delivery the guard exists for actually happen
        // — and a stale delivery IS reachable: an attempt whose ending crosses
        // the room giving it up hands its report to exactly this closure.
        let stale = r.session.attempt?.onLifecycle
        XCTAssertNotNil(stale, "the room installed a handler on the attempt it owns")
        r.session.end()
        r.session.begin(peerId: "peer-2", role: .initiator)
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-2"))

        stale?(.ended(.establishmentFailed))
        stale?(.opened(peerId: "peer-1"))
        await settle()

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-2"),
                       "the room the second establishment is using is untouched")
        XCTAssertEqual(r.session.peerId, "peer-2")
        XCTAssertFalse(r.session.isPublished,
                       "and a superseded publication does not mark the live one open")
        XCTAssertEqual(r.assembled.transports.count, 2)
    }

    /// A room handler that begins the NEXT establishment from inside the terminal
    /// callback finds this object already empty, and the announcement it makes is
    /// the last word — the release for the establishment that just ended cannot
    /// land on top of it.
    func testBeginningTheNextEstablishmentFromInsideTheTerminalCallbackIsSafe() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        let attempt = r.session.attempt
        // Re-entrancy on the room's own seam: the attempt tells its owner, and
        // this observer — standing in for a future router — reacts by starting
        // the next establishment inside that same delivery.
        let previous = attempt?.onLifecycle
        attempt?.onLifecycle = { [weak r] event in
            previous?(event)
            guard case .ended = event, let r else { return }
            r.session.begin(peerId: "peer-next", role: .initiator)
        }

        r.assembled.transports[0].fail()
        await settle()

        XCTAssertEqual(r.admission.phase, .connecting(peerId: "peer-next"),
                       "the new establishment's announcement stands")
        XCTAssertEqual(r.session.peerId, "peer-next")
        XCTAssertEqual(r.assembled.transports.count, 2)
    }

    /// Ending the session from inside its own terminal callback is inert rather
    /// than a second teardown: the slot is already clear by the time anything
    /// reacts.
    func testEndingFromInsideTheTerminalCallbackIsInert() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        let attempt = r.session.attempt
        let previous = attempt?.onLifecycle
        attempt?.onLifecycle = { [weak r] event in
            previous?(event)
            r?.session.end()
        }

        r.assembled.transports[0].fail()
        await settle()

        XCTAssertEqual(r.admission.phase, .failed, "the one release stands")
        XCTAssertNil(r.session.peerId)
        XCTAssertEqual(r.assembled.transports[0].closeCount, 1, "closed once")
    }

    // MARK: - 6. lifetime

    /// The room session is the only owner of what it assembles. Ending an
    /// establishment releases the attempt, the control and the transport with it
    /// — a room that leaked one would hold a PeerConnection and a TURN allocation
    /// for the life of the process.
    func testTheRoomReleasesEverythingItAssembledWhenTheEstablishmentEnds() async {
        let r = rig()
        weak var observed: RoomTransport?
        r.session.begin(peerId: "peer-1", role: .initiator)
        observed = r.assembled.transports[0]
        XCTAssertNotNil(observed, "assembled, and held by the room")

        r.session.end()
        // The recorder is the only strong reference the TEST holds; dropping it
        // leaves the room as the last owner, which is what is being measured.
        r.assembled.transports.removeAll()
        await settle()

        XCTAssertNil(observed, "the room was the transport's last owner")
    }

    /// The attempt does not keep its room alive. A cycle here would outlive both
    /// the room and the socket epoch it belongs to.
    func testTheAttemptDoesNotKeepTheRoomAlive() async {
        weak var observed: LinkRoomSession?
        var attempt: LinkSessionAttempt?
        do {
            let r = rig()
            observed = r.session
            r.session.begin(peerId: "peer-1", role: .initiator)
            attempt = r.session.attempt
            XCTAssertNotNil(observed)
        }
        await settle()

        XCTAssertNil(observed, "the room went away with its owner")
        XCTAssertNotNil(attempt, "even while its attempt is still held elsewhere")
        attempt?.retire()
    }

    // MARK: - 7. the seam onto the held link

    /// A departure reaches the held link, through the control the assembly
    /// produced. The link decides whether it is its peer's; this object does not.
    func testADepartureReachesTheHeldLink() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.assembled.transports[0].publish(identity(peerId: "peer-1"))
        await settle()

        r.session.peerDeparted("peer-1")
        await settle()

        XCTAssertEqual(r.admission.phase, .idle, "the link ended through its coordinator")
        XCTAssertNil(r.session.peerId)
    }

    /// A departure for somebody else is not this link's business, and this object
    /// adds no comparison of its own.
    func testADepartureForAnotherPeerLeavesTheLinkAlone() async {
        let r = rig()
        r.session.begin(peerId: "peer-1", role: .initiator)
        r.assembled.transports[0].publish(identity(peerId: "peer-1"))
        await settle()

        r.session.peerDeparted("peer-other")
        await settle()

        XCTAssertEqual(r.admission.phase, .open(peerId: "peer-1"))
        XCTAssertEqual(r.session.peerId, "peer-1")
    }

    /// Both seams are inert with nothing held. A signal that arrives between
    /// establishments must not crash, must not be buffered, and must not open
    /// anything.
    func testTheSeamsAreInertWithNoEstablishmentHeld() async {
        let r = rig()

        r.session.peerDeparted("peer-1")
        r.session.receiveResumeOffer(from: "peer-1", signal: .object(["resume": .bool(true)]))
        await settle()

        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertNil(r.session.peerId)
        XCTAssertTrue(r.assembled.transports.isEmpty, "nothing was assembled by a signal")
    }

    // MARK: - 8. the boundaries hold

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

    private func appSource(_ name: String) throws -> String {
        let url = appsRoot.appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/\(name)")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "\(name) must be readable")
        return source
    }

    /// Owning a lifecycle is not being reachable. Nothing outside the tests
    /// constructs a room session, neither app target names it, and neither flag
    /// has moved.
    func testTheRoomSessionStaysUnreachableFromProduction() throws {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        for source in try appSources() where source.name != "LinkRoomSession.swift" {
            XCTAssertFalse(source.code.contains("LinkRoomSession("),
                           "\(source.name) constructs a link room session")
        }
    }

    /// ONE admission transition belongs to this layer, and it is the
    /// announcement. Everything else it may make is a RELEASE of a room nobody
    /// else can release — `didFail` and `didClose` — and the two verbs that would
    /// duplicate another layer's ownership must not appear at all: `didOpen` is
    /// the runtime's, and a second one would refill the peer's leave budget on a
    /// link that did not just authenticate; the gap's transitions are the
    /// coordinator's.
    func testTheRoomSessionMakesOnlyTheTransitionsNobodyElseOwns() throws {
        let source = try appSource("LinkRoomSession.swift")

        XCTAssertEqual(source.components(separatedBy: "admission.didBeginEstablishing(").count - 1, 1,
                       "one announcement, in `begin`")
        // Exactly five calls, and they are enumerable: the announcement, the
        // release in `end()`, and the three the terminal switch can make —
        // `didFail` for an establishment that failed, `didClose` for one the peer
        // closed, `didClose` for a local stop. The count is the guard on the two
        // branches no behavioural test can reach: `.wiringFailed` has already
        // been released by the coordinator it built and `.linkEnded` cannot occur
        // unpublished, so both must stay silent, and a sixth call is the only way
        // that changes.
        XCTAssertEqual(source.components(separatedBy: "admission.did").count - 1, 5,
                       "one announcement and four releases, all of them accounted for")
        XCTAssertEqual(source.components(separatedBy: "admission.didFail()").count - 1, 1,
                       "a failure is the only thing that fails the room")
        // BOTH release paths defer to the coordinator once the link has
        // published: the terminal report, and `end()`.
        //
        // Pinned as source because one of them is not observable today. Every
        // way a published link can reach `end()` has the coordinator releasing
        // it as `.closed` inside the same `retire()`, so a second `didClose`
        // lands on an admission that is already idle and nothing downstream can
        // tell. It is still the difference between this object making a
        // transition it owns and one it does not, and it stops being invisible
        // the first time a published link's teardown releases the room as
        // anything other than idle — at which point a duplicate would overwrite
        // the coordinator's own reading.
        XCTAssertEqual(source.components(separatedBy: "published else { return }").count - 1, 2,
                       "the terminal report and `end()` both defer once published")
        for forbidden in ["didOpen", "didInterrupt", "didReplaceTransport",
                          "didBeginReplacingTransport", "didEndReplacingTransport",
                          "didBeginRequesting", "didRequestTimeOut"] {
            XCTAssertFalse(source.contains(forbidden),
                           "\(forbidden) belongs to the runtime or the coordinator")
        }
    }

    /// It routes nothing, and it resolves no ingredient. A room that read a
    /// signal, answered a peer or picked an ICE server would be the next slice
    /// written early — and the ingredients in particular would become a second
    /// place the application's decisions are made.
    func testTheRoomSessionRoutesNothingAndResolvesNothing() throws {
        let source = try appSource("LinkRoomSession.swift")

        for forbidden in ["admission.route", "admission.ensure", "isLinkRequest",
                          "isLinkOffer", "linkBusySignal", "linkRequestSignal",
                          "sendSignal", "addSignalListener", "addSignalInterceptor",
                          "SignalingClient", "RTCIceServer", "LinkSessionFactory",
                          "PeerCapabilityRegistry", "createDirectory", "deinit"] {
            XCTAssertFalse(source.contains(forbidden),
                           "the room session must not name \(forbidden)")
        }
    }

    /// The attempt tells its room two facts and hands it no stream. A room that
    /// received `text`, `file` or `received` would be a third projection, and the
    /// lane state it would then hold could disagree with the two that already own
    /// it.
    func testTheRoomHearsTwoFactsAndNotTheStream() throws {
        let attempt = try appSource("LinkSessionAttempt.swift")

        XCTAssertEqual(attempt.components(separatedBy: "onLifecycle?(").count - 1, 2,
                       "exactly two facts are announced")
        XCTAssertTrue(attempt.contains("onLifecycle?(.opened(peerId: peerId))"))
        XCTAssertTrue(attempt.contains("onLifecycle?(.ended(reason))"))
        // The room is told AFTER both projections, so a handler that ends the
        // session sees screens that already show what the link reported.
        let model = try XCTUnwrap(attempt.range(of: "model.apply(event)"))
        let file = try XCTUnwrap(attempt.range(of: "fileModel.apply(event)"))
        let room = try XCTUnwrap(attempt.range(of: "announce(event)"))
        XCTAssertTrue(model.upperBound < file.lowerBound)
        XCTAssertTrue(file.upperBound < room.lowerBound)
    }
}
