import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the doubles
//
// The same two substitutions `LinkRoomRouterTests` makes, and nothing else: the
// PeerConnection, and the room's seam onto the link. Everything between the
// router and them — the factory, the attempt, the room session, admission — is
// production code, so an accepted prompt really claims, really assembles and
// really replays.

private final class ConsentTransport: LinkRoutableInitialTransport, @unchecked Sendable {
    private let lock = NSLock()
    var onSAS: ((String) -> Void)?
    var onReady: ((LinkIdentity) -> Void)?
    var onFrame: ((LinkLane, [UInt8]) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?
    private var _closed = false

    func start() {}
    func receive(from: String, signal: JSONValue) {}
    func send(_ bytes: [UInt8], on lane: LinkLane) throws {}
    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    var negotiatedMaxMessageBytes: Double { DEFAULT_MAX_FRAME_BYTES }
    var isClosed: Bool { lock.withLock { _closed } }
    func close() { lock.withLock { _closed = true } }
}

/// What the room forwarded to the link it holds, in order.
private final class ConsentControl: LinkSessionRecoveryControl, @unchecked Sendable {
    private let lock = NSLock()
    private var _received: [(from: String, signal: JSONValue)] = []
    var received: [(from: String, signal: JSONValue)] { lock.withLock { _received } }

    func receive(from: String, signal: JSONValue) {
        lock.withLock { _received.append((from, signal)) }
    }
    func receiveResumeOffer(from: String, signal: JSONValue) {}
    func receiveLeave(from: String, to: String, auth: String) {}
    func peerDeparted(_ peerId: String) {}
    func joinRecovery(peerId: String,
                      _ complete: @escaping (Result<LinkIdentity, Error>) -> Void)
    -> LinkRecoveryJoin { .unavailable }
}

/// **The router's half of A23: an unrequested link is held behind a prompt.**
///
/// What is pinned, invariant by invariant:
///  - I1 nothing is claimed, assembled or buffered-then-lost before Accept;
///  - I2 decline, timeout, departure and a socket change leave no lane;
///  - I3 one prompt at a time, a second peer is `busy`;
///  - I4 every answer is fenced by the prompt id and the socket epoch;
///  - G5 a retry of a declined ask inside its window is not asked again.
@MainActor
final class LinkRoomRouterConsentTests: XCTestCase {

    private let selfId = "mmm"
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-consent-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    // ── frames ──────────────────────────────────────────────────────────────

    /// From a SMALLER id than `selfId`, so the peer offers and this side responds.
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

    // ── one room ────────────────────────────────────────────────────────────

    private final class Rig {
        var router: LinkRoomRouter!
        let admission: LinkAdmission
        let channel: FakeWebSocketChannel
        let client: SignalingClient
        let scheduler: FakeLinkScheduler
        var events: [LinkRoomRouter.AskEvent] = []
        var peers: [String] = []
        var roles: [Role] = []
        var initialSignals: [JSONValue?] = []
        var controls: [ConsentControl] = []

        init(admission: LinkAdmission, channel: FakeWebSocketChannel,
             client: SignalingClient, scheduler: FakeLinkScheduler) {
            self.admission = admission
            self.channel = channel
            self.client = client
            self.scheduler = scheduler
        }

        func deliver(from: String, _ data: JSONValue) {
            channel.fire(Envelope(type: SignalType.signal, from: from, data: data))
        }

        private func sent(_ matches: (JSONValue) -> Bool) -> [String] {
            channel.sent.compactMap { text in
                guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                      envelope.type == SignalType.signal,
                      let data = envelope.data, matches(data) else { return nil }
                return envelope.to
            }
        }
        var busied: [String] { sent(isLinkBusy) }
        var requested: [String] { sent(isLinkRequest) }
        var raised: [Int] {
            events.compactMap { if case let .raised(id, _) = $0 { return id }; return nil }
        }
        var withdrawn: [Int] {
            events.compactMap { if case let .withdrawn(id) = $0 { return id }; return nil }
        }
        /// The prompt currently on the router, as the owner would answer it.
        var promptId: Int? { router.pendingAsk()?.promptId }
    }

    private func rig(peers: [String] = ["aaa", "bbb", "zzz"]) -> Rig {
        let capabilities = PeerCapabilityRegistry(linkRoomActive: { true })
        for peer in peers {
            capabilities.record(peerId: peer,
                                signal: .object(["caps": .array([.string(LINK_CAPABILITY)])]))
        }
        let admission = LinkAdmission(
            selfId: { [selfId] in selfId },
            supportsLink: { capabilities.supports($0, LINK_CAPABILITY) },
            canAcceptLink: { _ in true },
            requiresConsent: { _ in true })
        let channel = FakeWebSocketChannel()
        let client = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        channel.fire(Envelope(type: SignalType.welcome, name: selfId))
        let built = Rig(admission: admission, channel: channel, client: client,
                        scheduler: FakeLinkScheduler())
        let dir = self.dir!

        let session = LinkRoomSession(admission: admission) { [weak built] peerId, role, initialSignal in
            let transport = ConsentTransport()
            let assembly = LinkSessionFactory.make(
                signaling: client, peerId: peerId, role: role, iceServers: [],
                iceTransportPolicy: .relay, authenticationGeneration: 5,
                receiveDirectory: dir, admission: admission, deadlines: LinkDeadlines(),
                initialSignal: initialSignal,
                buildInitialTransport: { _, _, _, _, _, _, _ in transport },
                buildReplacementFactory: { _, _, _, _ in { _ in throw LinkTransportError.notReady } })
            let control = ConsentControl()
            built?.peers.append(peerId)
            built?.roles.append(role)
            built?.initialSignals.append(initialSignal)
            built?.controls.append(control)
            return LinkSessionAssembly(attempt: assembly.attempt,
                                       control: LinkSessionRoomControl(runtime: control))
        }
        built.router = LinkRoomRouter(admission: admission, capabilities: capabilities,
                                      session: session, scheduler: built.scheduler,
                                      onAsk: { [weak built] _, event in built?.events.append(event) })
        built.router.attach(to: client)
        return built
    }

    private func settle(_ turns: Int = 12) async {
        for _ in 0..<turns { await Task.yield() }
    }

    // MARK: - I1: one prompt, and nothing claimed for it

    func testAnUnrequestedOfferRaisesOnePromptAndClaimsNothing() async {
        let r = rig()
        r.deliver(from: "aaa", offer())
        r.deliver(from: "aaa", candidate("c1"))
        await settle()

        XCTAssertEqual(r.events, [.raised(promptId: 1, peerId: "aaa")])
        XCTAssertEqual(r.admission.phase, .idle, "a question claimed the room")
        XCTAssertTrue(r.peers.isEmpty, "a link was assembled before anybody accepted")
        XCTAssertTrue(r.busied.isEmpty)
    }

    /// The same peer asking again — a duplicate offer, a retried request — is
    /// the prompt already on screen, not a second one.
    func testADuplicateAskFromTheSamePeerRaisesNoSecondPrompt() async {
        let r = rig()
        r.deliver(from: "aaa", offer())
        r.deliver(from: "aaa", offer("v=0 again"))
        await settle()
        XCTAssertEqual(r.raised, [1])
        XCTAssertTrue(r.busied.isEmpty)

        // The requesting direction: "zzz" is the larger id and retries its ask.
        let q = rig()
        for _ in 0..<3 { q.deliver(from: "zzz", linkRequestSignal()) }
        await settle()
        XCTAssertEqual(q.raised, [1])
        XCTAssertTrue(q.busied.isEmpty)
    }

    // MARK: - I3: one question at a time

    func testASecondPeerIsBusyAndThePromptStays() async {
        let r = rig()
        r.deliver(from: "aaa", offer())
        r.deliver(from: "zzz", linkRequestSignal())
        await settle()

        XCTAssertEqual(r.raised, [1])
        XCTAssertEqual(r.busied, ["zzz"])
        XCTAssertEqual(r.router.pendingAsk()?.peerId, "aaa")
        XCTAssertTrue(r.withdrawn.isEmpty)
    }

    // MARK: - I2: every ending but Accept leaves nothing

    func testTimeoutAnswersBusyAndAssemblesNothing() async {
        let r = rig()
        r.deliver(from: "aaa", offer())
        await settle()
        r.scheduler.fireAll()
        await settle()

        XCTAssertEqual(r.busied, ["aaa"])
        XCTAssertEqual(r.withdrawn, [1])
        XCTAssertNil(r.router.pendingAsk())
        XCTAssertTrue(r.peers.isEmpty)
        XCTAssertEqual(r.admission.phase, .idle)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
    }

    /// G5: the peer's request retries keep arriving for its whole window, and a
    /// retry already in flight when the user declines must not ask again.
    func testDeclineThenARetryInsideTheWindowIsBusyWithNoPrompt() async throws {
        let r = rig()
        r.deliver(from: "zzz", linkRequestSignal())
        await settle()
        let prompt = try XCTUnwrap(r.promptId)

        XCTAssertTrue(r.router.declineAsk(promptId: prompt))
        r.deliver(from: "zzz", linkRequestSignal())
        await settle()

        XCTAssertEqual(r.raised, [prompt], "a declined ask was put to the user twice")
        XCTAssertEqual(r.busied, ["zzz", "zzz"])
        XCTAssertTrue(r.peers.isEmpty)

        // The window closes with the declined prompt's own deadline; a genuinely
        // new ask after it is asked.
        r.scheduler.fireAll()
        r.deliver(from: "zzz", linkRequestSignal())
        await settle()
        XCTAssertEqual(r.raised.count, 2)
    }

    func testTheRosterLosingTheAskingPeerWithdrawsThePromptSilently() async {
        let r = rig()
        r.deliver(from: "aaa", offer())
        await settle()
        r.router.rosterChanged(peerIds: ["zzz"])
        await settle()

        XCTAssertEqual(r.withdrawn, [1])
        XCTAssertNil(r.router.pendingAsk())
        XCTAssertTrue(r.busied.isEmpty, "a peer that left was answered")
        XCTAssertFalse(r.router.acceptAsk(promptId: 1))
        XCTAssertTrue(r.peers.isEmpty)
    }

    func testThePeerLeavingWithdrawsThePromptAndItsDeclineMark() async throws {
        let r = rig()
        r.deliver(from: "aaa", offer())
        await settle()
        r.router.peerLeft("aaa")
        await settle()
        XCTAssertEqual(r.withdrawn, [1])
        XCTAssertTrue(r.busied.isEmpty)

        // A decline mark does not outlive the peer either.
        r.deliver(from: "zzz", linkRequestSignal())
        await settle()
        XCTAssertTrue(r.router.declineAsk(promptId: try XCTUnwrap(r.promptId)))
        r.router.peerLeft("zzz")
        r.deliver(from: "zzz", linkRequestSignal())
        await settle()
        XCTAssertEqual(r.raised.count, 3, "a departed peer's decline mark refused its return")
    }

    func testASocketChangeWithdrawsThePromptAndFencesTheOldId() async throws {
        let r = rig()
        r.deliver(from: "aaa", offer())
        await settle()
        let prompt = try XCTUnwrap(r.promptId)

        r.router.detach()
        await settle()

        XCTAssertEqual(r.withdrawn, [prompt])
        XCTAssertFalse(r.router.acceptAsk(promptId: prompt), "a prompt from a gone socket was accepted")
        XCTAssertTrue(r.peers.isEmpty)
        XCTAssertTrue(r.busied.isEmpty)
    }

    // MARK: - I4: answers are fenced

    func testAStalePromptIdIsRefused() async throws {
        let r = rig()
        r.deliver(from: "aaa", offer())
        await settle()
        let prompt = try XCTUnwrap(r.promptId)

        XCTAssertFalse(r.router.acceptAsk(promptId: prompt + 1))
        XCTAssertFalse(r.router.declineAsk(promptId: prompt + 1))
        XCTAssertEqual(r.router.pendingAsk()?.promptId, prompt, "a wrong id disturbed the prompt")
        XCTAssertTrue(r.peers.isEmpty)
        XCTAssertTrue(r.busied.isEmpty)
    }

    // MARK: - Accept

    /// Accept claims the room in the deterministic role and replays the held
    /// offer and every candidate that chased it, in wire order — including one
    /// that arrives after the accept but before the handoff drains.
    func testAcceptReplaysTheOfferAndItsCandidatesInOrder() async throws {
        let r = rig()
        r.deliver(from: "aaa", offer())
        r.deliver(from: "aaa", candidate("c1"))
        r.deliver(from: "aaa", candidate("c2"))
        await settle()

        XCTAssertTrue(r.router.acceptAsk(promptId: try XCTUnwrap(r.promptId)))
        r.deliver(from: "aaa", candidate("c3"))
        await settle()

        XCTAssertEqual(r.peers, ["aaa"])
        XCTAssertEqual(r.roles, [.responder])
        XCTAssertEqual(parseSDP(r.initialSignals.first.flatMap { $0 } ?? .null)?.type, "offer")
        let replayed = try XCTUnwrap(r.controls.first).received.compactMap {
            parseICE($0.signal)?.candidate
        }
        XCTAssertEqual(replayed.map { String($0.prefix(12)) },
                       ["candidate:c1", "candidate:c2", "candidate:c3"])
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "aaa"))
        XCTAssertTrue(r.busied.isEmpty)
    }

    /// An accepted REQUEST makes this side the offerer, exactly as an automatic
    /// admission would have.
    func testAnAcceptedRequestEstablishesAsInitiator() async throws {
        let r = rig()
        r.deliver(from: "zzz", linkRequestSignal())
        await settle()
        XCTAssertTrue(r.router.acceptAsk(promptId: try XCTUnwrap(r.promptId)))
        await settle()
        XCTAssertEqual(r.peers, ["zzz"])
        XCTAssertEqual(r.roles, [.initiator])
    }

    /// I6: a room taken since the prompt was raised is not preempted by
    /// accepting it; the asking peer is told `busy`.
    func testAcceptIntoARoomTakenMeanwhileIsRefusedAndPreemptsNothing() async throws {
        let r = rig()
        r.deliver(from: "aaa", offer())
        await settle()
        r.admission.didBeginEstablishing(peerId: "bbb", role: .responder)

        XCTAssertFalse(r.router.acceptAsk(promptId: try XCTUnwrap(r.promptId)))
        await settle()
        XCTAssertEqual(r.admission.phase, .connecting(peerId: "bbb"))
        XCTAssertEqual(r.busied, ["aaa"])
        XCTAssertTrue(r.peers.isEmpty)
    }

    /// A peer that floods the held buffer before anybody has said yes is
    /// refused rather than truncated.
    func testOverflowingTheHeldBufferRejectsTheAsk() async {
        let r = rig()
        r.deliver(from: "aaa", offer())
        for index in 0...LINK_PENDING_CANDIDATE_MAX {
            r.deliver(from: "aaa", candidate("f\(index)"))
        }
        await settle()

        XCTAssertEqual(r.busied, ["aaa"])
        XCTAssertEqual(r.withdrawn, [1])
        XCTAssertNil(r.router.pendingAsk())
        XCTAssertTrue(r.peers.isEmpty)
    }

    // MARK: - local Connect while a prompt is up

    /// Connecting to the device that is asking is Accept: its held offer is
    /// adopted, and this side does not ask it back.
    func testEnsuringTheAskingPeerAcceptsInsteadOfAskingBack() async {
        let r = rig()
        r.deliver(from: "aaa", offer())
        await settle()

        let operation = r.router.ensure(peerId: "aaa")
        await settle()

        XCTAssertEqual(operation.settledOutcome, .establishing)
        XCTAssertEqual(r.peers, ["aaa"])
        XCTAssertTrue(r.requested.isEmpty, "this side asked a peer that had already offered")
        XCTAssertTrue(r.busied.isEmpty)
    }

    /// Connecting to anybody else declines the prompt first: the asking peer
    /// hears `busy` now, and the link goes to the device the user chose.
    func testEnsuringAnotherPeerDeclinesThePromptFirst() async {
        let r = rig()
        r.deliver(from: "aaa", offer())
        await settle()

        _ = r.router.ensure(peerId: "zzz")
        await settle()

        XCTAssertEqual(r.busied, ["aaa"])
        XCTAssertEqual(r.withdrawn, [1])
        XCTAssertEqual(r.peers, ["zzz"], "a link was built for a device the user did not choose")
    }
}
