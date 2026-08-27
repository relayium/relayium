import Combine
import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the transport under the Workspace's link
//
// The Workspace's question is not the runtime's, the factory's or the room
// session's. It is: what may the USER do, when, and what is held back until they
// have compared the digits. So the double here is a transport that can be driven
// through every ending a real one produces, while everything between it and the
// screen — the router, the room session, the factory, the attempt, the runtime
// and both projections — is production code.

private final class WorkspaceTransport: LinkRoutableInitialTransport, @unchecked Sendable {
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
    private var _sent: [LinkLane: [[UInt8]]] = [:]
    private var _routed: [(from: String, signal: JSONValue)] = []

    var sent: [LinkLane: [[UInt8]]] { state.lock(); defer { state.unlock() }; return _sent }
    var routed: [(from: String, signal: JSONValue)] {
        state.lock(); defer { state.unlock() }; return _routed
    }

    func start() {}
    func receive(from: String, signal: JSONValue) {
        state.lock(); _routed.append((from, signal)); state.unlock()
    }
    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        state.lock(); _sent[lane, default: []].append(bytes); state.unlock()
    }
    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }
    func close() { state.lock(); _closed = true; state.unlock() }

    func publish(_ identity: LinkIdentity, sas: String = "424242") {
        onSAS?(sas)
        onReady?(identity)
    }

    func fail(_ error: Error = LinkTransportError.peerConnectionFailed) {
        onError?(error)
        onClose?()
    }

    func hangUp() { onClose?() }
}

@MainActor
final class LinkWorkspaceModelTests: XCTestCase {

    // MARK: - fixtures

    private var dir: URL!
    private var observers: Set<AnyCancellable> = []

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-workspace-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        observers.removeAll()
        try? FileManager.default.removeItem(at: dir)
    }

    private func identity(peerId: String, role: Role = .initiator) -> LinkIdentity {
        LinkIdentity(peerId: peerId, role: role, sas: "424242",
                     codecs: LinkCodecs(sendKey: [UInt8](repeating: 0x41, count: 32),
                                        recvKey: [UInt8](repeating: 0x42, count: 32)),
                     authenticationGeneration: 1)
    }

    private func meta(_ name: String, _ size: Int) -> FileMeta {
        FileMeta(name: name, size: size, path: nil)
    }

    /// A source the driver can read, with no filesystem behind it.
    private func source(_ name: String, _ bytes: Int) -> PlaintextSource {
        DataSource(name: name, bytes: [UInt8](repeating: 0x7a, count: bytes))
    }

    /// The Workspace's own room, with the roster socket faked and the transport
    /// injected. `selfId` is "aaa" so this side is the smaller id and therefore
    /// the initiator for "zzz" — the deterministic role rule, not a preference.
    private final class Rig {
        let model: LinkWorkspaceModel
        let capabilities: PeerCapabilityRegistry
        let channel: FakeWebSocketChannel
        let signaling: SignalingClient
        var transports: [WorkspaceTransport] = []
        var peers: [String] = []
        var receiveDirectories: [URL] = []

        init(model: LinkWorkspaceModel,
             capabilities: PeerCapabilityRegistry,
             channel: FakeWebSocketChannel,
             signaling: SignalingClient) {
            self.model = model
            self.capabilities = capabilities
            self.channel = channel
            self.signaling = signaling
        }
    }

    private func rig(requiresVerification: Bool = false,
                     selfId: String = "aaa",
                     roomActive: Bool = true,
                     // Defaulted to the SHARED default, so every test written
                     // before this seam still drives the behaviour it was
                     // written for — and a flipped default fails rather than
                     // quietly re-scoping the whole file.
                     pendingMessages: LinkPendingMessagePolicy = .replaceWaiting) -> Rig {
        let capabilities = PeerCapabilityRegistry(linkRoomActive: { roomActive })
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        channel.fire(Envelope(type: SignalType.welcome, name: selfId))

        let dir = self.dir!
        var box: Rig?
        let model = LinkWorkspaceModel(
            capabilities: capabilities,
            receiveDirectory: { dir },
            requiresVerification: { requiresVerification },
            iceClient: nil,
            pendingMessages: pendingMessages,
            assemble: { signaling, peerId, role, iceServers, relayOnly, generation,
                        receiveDirectory, admission, initialSignal in
                let transport = WorkspaceTransport()
                box?.transports.append(transport)
                box?.peers.append(peerId)
                box?.receiveDirectories.append(receiveDirectory)
                return LinkSessionFactory.make(
                    signaling: signaling,
                    peerId: peerId,
                    role: role,
                    iceServers: iceServers,
                    iceTransportPolicy: relayOnly ? .relay : .all,
                    authenticationGeneration: generation,
                    receiveDirectory: receiveDirectory,
                    admission: admission,
                    deadlines: LinkDeadlines(),
                    initialSignal: initialSignal,
                    buildInitialTransport: { _, _, _, _, _, _, _ in transport },
                    buildReplacementFactory: { _, _, _, _ in
                        { _ in throw LinkTransportError.notReady }
                    })
            })
        let rig = Rig(model: model, capabilities: capabilities,
                      channel: channel, signaling: signaling)
        box = rig
        model.roomDidConnect(signaling)
        return rig
    }

    /// The peer announced exact `link/1`, which is the only thing that makes it
    /// part of this feature.
    private func announceLink(_ rig: Rig, _ peerId: String) {
        rig.capabilities.record(peerId: peerId,
                                signal: .object(["caps": .array([.string(TEXT_CAPABILITY),
                                                                 .string(LINK_CAPABILITY)])]))
    }

    /// The peer announced only `text/1` — every older Web build, every native
    /// client on the shipped wire, and the CLI.
    private func announceLegacy(_ rig: Rig, _ peerId: String) {
        rig.capabilities.record(peerId: peerId,
                                signal: .object(["caps": .array([.string(TEXT_CAPABILITY)])]))
    }

    private func settle(_ turns: Int = 12) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// Connect, publish, and settle: the state every "what may the user do now"
    /// test starts from.
    @discardableResult
    private func openLink(_ rig: Rig,
                          peerId: String = "zzz",
                          files: [FileMeta] = [],
                          sources: [PlaintextSource] = []) async -> WorkspaceTransport {
        announceLink(rig, peerId)
        XCTAssertTrue(rig.model.connect(peerId: peerId, peerLabel: "Studio Mac",
                                        files: files, sources: sources))
        await settle()
        let transport = rig.transports[0]
        transport.publish(identity(peerId: peerId))
        await settle()
        return transport
    }

    // MARK: - 1. the downgrade boundary

    /// A peer that never announced exact `link/1` is not part of this feature at
    /// all: `canLink` is false, `connect` refuses, and nothing is assembled. The
    /// Workspace's legacy text/file paths own that device, untouched.
    func testAPeerThatNeverAnnouncedLinkIsNeverOfferedOne() async {
        let rig = rig()

        XCTAssertFalse(rig.model.canLink(peerId: "zzz"))
        XCTAssertFalse(rig.model.connect(peerId: "zzz", peerLabel: "Old Mac"))
        await settle()

        XCTAssertTrue(rig.transports.isEmpty, "no link may be assembled for a legacy peer")
        XCTAssertEqual(rig.model.connection, .idle)
        XCTAssertFalse(rig.model.hasSession, "the Workspace stays on its legacy paths")
    }

    /// A peer that announced only `text/1` is the same answer, and this is the
    /// case that actually ships: every older Web build and the CLI.
    func testATextOnlyPeerFallsBackToTheLegacyPaths() async {
        let rig = rig()
        announceLegacy(rig, "zzz")

        XCTAssertFalse(rig.model.canLink(peerId: "zzz"))
        XCTAssertFalse(rig.model.connect(peerId: "zzz", peerLabel: "Old Mac"))
        await settle()
        XCTAssertTrue(rig.transports.isEmpty)
    }

    /// A relay that STRIPS the announcement denies the feature; it must never
    /// produce a link the peer cannot answer. The registry is the one predicate
    /// every decision reads, so revoking through a later empty snapshot revokes
    /// everywhere at once.
    func testAStrippedAnnouncementRevokesTheFeatureRatherThanDegradingIt() async {
        let rig = rig()
        announceLink(rig, "zzz")
        XCTAssertTrue(rig.model.canLink(peerId: "zzz"))

        // A peer that reloaded into a room where link mode is not allowed
        // announces exactly this.
        rig.capabilities.record(peerId: "zzz", signal: .object(["caps": .array([])]))

        XCTAssertFalse(rig.model.canLink(peerId: "zzz"))
        XCTAssertFalse(rig.model.connect(peerId: "zzz", peerLabel: "Studio Mac"))
        await settle()
        XCTAssertTrue(rig.transports.isEmpty)
    }

    /// A relay that FORGES one cannot activate link mode where the room forbids
    /// it. This is the pairing-code scope, enforced at the routing predicate
    /// rather than only at the announcement.
    func testAForgedAnnouncementCannotActivateLinkModeOutsideItsRoom() async {
        let rig = rig(roomActive: false)
        announceLink(rig, "zzz")

        XCTAssertFalse(rig.model.canLink(peerId: "zzz"))
        XCTAssertFalse(rig.model.connect(peerId: "zzz", peerLabel: "Studio Mac"))
        await settle()
        XCTAssertTrue(rig.transports.isEmpty)
    }

    // MARK: - 2. one link, one verification, repeated batches

    /// The property the whole batch exists for: ONE authenticated link, ONE set
    /// of digits, and as many batches and messages afterwards as the user wants.
    func testOneVerificationCoversEveryLaterBatchAndMessage() async throws {
        let rig = rig(requiresVerification: true)
        let transport = await openLink(rig)

        // The digits are asked ONCE, and everything is held behind them.
        XCTAssertEqual(rig.model.verification, .pending(sas: "424242"))
        XCTAssertFalse(rig.model.acceptsWork)
        rig.model.confirmSAS()
        XCTAssertEqual(rig.model.verification, .confirmed)
        XCTAssertTrue(rig.model.acceptsWork)

        // Three batches on the SAME link, and one conversation.
        rig.model.send(files: [meta("a.bin", 8)], sources: [source("a.bin", 8)])
        rig.model.send(files: [meta("b.bin", 8)], sources: [source("b.bin", 8)])
        rig.model.send(files: [meta("c.bin", 8)], sources: [source("c.bin", 8)])
        rig.model.send(message: "hello")
        await settle()

        let batches = try XCTUnwrap(rig.model.fileModel).outbound
        XCTAssertEqual(batches.count, 3, "three batches, one link, no new digits")
        XCTAssertEqual(Set(batches.map(\.id)).count, 3, "each batch has its own lane id")
        XCTAssertEqual(rig.model.verification, .confirmed,
                       "no batch re-arms the verification boundary")
        XCTAssertEqual(rig.transports.count, 1, "no second connection was built")
        XCTAssertFalse(transport.isClosed)

        // And the conversation was OPENED rather than the message being dropped:
        // the lane's own consent step is preserved.
        XCTAssertEqual(rig.model.textModel?.textStatus, .waitingAccept)
        XCTAssertEqual(transport.sent[.text]?.first, [LINK_TEXT_REQUEST],
                       "pressing Send asks the peer for a conversation")
    }

    /// A batch the user chose BEFORE connecting is armed, not sent, and the
    /// digits are what release it. This is the preselected-file gate, and it is
    /// the one that would silently leak files if it were wrong.
    func testPreselectedFilesAreNotReleasedBeforeVerification() async throws {
        let rig = rig(requiresVerification: true)
        let transport = await openLink(rig,
                                       files: [meta("secret.pdf", 32)],
                                       sources: [source("secret.pdf", 32)])

        XCTAssertEqual(rig.model.armedFiles.map(\.name), ["secret.pdf"])
        XCTAssertTrue(try XCTUnwrap(rig.model.fileModel).batches.isEmpty,
                      "an armed batch has not reached the lane")
        XCTAssertNil(transport.sent[.file], "not one byte may leave before the digits are compared")

        rig.model.confirmSAS()
        await settle()

        XCTAssertTrue(rig.model.armedFiles.isEmpty, "confirming releases it exactly once")
        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.count, 1)
    }

    /// Saying the digits do not match ends the link and sends nothing. It is its
    /// own ending, because it is the one that means something may be wrong.
    func testRejectingTheDigitsEndsTheLinkWithoutSendingAnything() async throws {
        let rig = rig(requiresVerification: true)
        let transport = await openLink(rig,
                                       files: [meta("secret.pdf", 32)],
                                       sources: [source("secret.pdf", 32)])

        rig.model.rejectSAS()
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.verificationRejected))
        XCTAssertNil(transport.sent[.file])
        XCTAssertTrue(transport.isClosed)
        XCTAssertTrue(rig.model.armedFiles.isEmpty)
    }

    /// With the preference off there is no gate at all, and the armed batch goes
    /// as soon as the link opens.
    func testWithVerificationOffTheArmedBatchGoesOnOpen() async throws {
        let rig = rig(requiresVerification: false)
        _ = await openLink(rig, files: [meta("a.bin", 8)], sources: [source("a.bin", 8)])

        XCTAssertEqual(rig.model.verification, .notRequired)
        XCTAssertTrue(rig.model.armedFiles.isEmpty)
        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.count, 1)
    }

    /// The preference is read ONCE, at the first digits. Flipping it afterwards
    /// must not decide the gate — that would make verification depend on timing.
    func testTheVerificationPreferenceIsReadOnceAtTheFirstDigits() async {
        var required = false
        let capabilities = PeerCapabilityRegistry(linkRoomActive: { true })
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        channel.fire(Envelope(type: SignalType.welcome, name: "aaa"))
        let dir = self.dir!
        var transports: [WorkspaceTransport] = []
        let model = LinkWorkspaceModel(
            capabilities: capabilities, receiveDirectory: { dir },
            requiresVerification: { required }, iceClient: nil,
            assemble: { signaling, peerId, role, ice, relayOnly, generation,
                        directory, admission, signal in
                let transport = WorkspaceTransport()
                transports.append(transport)
                return LinkSessionFactory.make(
                    signaling: signaling, peerId: peerId, role: role, iceServers: ice,
                    iceTransportPolicy: relayOnly ? .relay : .all,
                    authenticationGeneration: generation,
                    receiveDirectory: directory, admission: admission,
                    deadlines: LinkDeadlines(), initialSignal: signal,
                    buildInitialTransport: { _, _, _, _, _, _, _ in transport },
                    buildReplacementFactory: { _, _, _, _ in { _ in throw LinkTransportError.notReady } })
            })
        model.roomDidConnect(signaling)
        capabilities.record(peerId: "zzz",
                            signal: .object(["caps": .array([.string(TEXT_CAPABILITY),
                                                             .string(LINK_CAPABILITY)])]))
        XCTAssertTrue(model.connect(peerId: "zzz", peerLabel: "Studio Mac"))
        await settle()
        transports[0].publish(identity(peerId: "zzz"))
        await settle()

        // Flipped AFTER the digits arrived.
        required = true
        XCTAssertEqual(model.verification, .notRequired,
                       "a preference flipped mid-handshake must not arm the gate")
        XCTAssertTrue(model.acceptsWork)
    }

    // MARK: - 3. inbound consent, held behind the same boundary

    /// Accepting a peer's manifest is releasing a write to this user's disk, so
    /// it is behind the same one boundary as everything outbound.
    func testAnInboundOfferCannotBeAcceptedBeforeVerification() async throws {
        let rig = rig(requiresVerification: true)
        let transport = await openLink(rig)

        rig.model.acceptInboundBatch()
        await settle()

        // The lane never saw an accept: nothing was written to the file channel
        // beyond whatever the link's own opening produced.
        XCTAssertFalse((transport.sent[.file] ?? []).contains([RealtimeControl.accept.rawValue]),
                       "consent may not be given before the digits are compared")
        XCTAssertFalse(rig.model.acceptsWork)
    }

    /// A conversation the peer asks for is consent too, and the composer refuses
    /// to accept typing at all while the digits are unanswered.
    func testTheComposerIsClosedWhileTheDigitsAreUnanswered() async {
        let rig = rig(requiresVerification: true)
        let transport = await openLink(rig)

        XCTAssertFalse(rig.model.canCompose)
        rig.model.send(message: "hello")
        await settle()

        XCTAssertNil(transport.sent[.text], "no conversation may be opened before verification")
        XCTAssertNotNil(rig.model.actionError)
    }

    /// A draft the lane never took is handed back rather than lost. It is the
    /// one thing a user cannot recover, so it must not be a log line.
    func testADeclinedConversationHandsTheDraftBack() async {
        let rig = rig()
        _ = await openLink(rig)

        rig.model.send(message: "please take this")
        await settle()
        XCTAssertEqual(rig.model.textModel?.textStatus, .waitingAccept)
        XCTAssertNil(rig.model.returnedDraft, "nothing is handed back while it may still send")

        // The peer refuses the conversation.
        rig.transports[0].onFrame?(.text, [RealtimeControl.reject.rawValue])
        await settle()

        XCTAssertEqual(rig.model.returnedDraft, "please take this")
        XCTAssertTrue(rig.model.restoreReturnedDraft(), "the refusal handed nothing back")
        XCTAssertEqual(rig.model.draft, "please take this")
        XCTAssertNil(rig.model.returnedDraft, "handed back exactly once")
        XCTAssertNotNil(rig.model.actionError)
    }

    // MARK: - 3b. the conversation is admitted, not asked about

    /// **A request on a verified link is taken, and it is taken by the model.**
    ///
    /// Entering a link is the consent: one side minted a code and passed it on,
    /// or picked a named device off a roster, and both sides then compared six
    /// digits. A second two-button prompt asked the user to consent to talking
    /// to the person they had just verified they were talking to, and its only
    /// reliable effect was to leave the peer's spinner running.
    ///
    /// It is a state rule rather than something a view does on appear, which is
    /// what makes it hold when this window is closed, when the pane is being
    /// rebuilt by the very change that produced the request, and in a headless
    /// test with no view at all.
    func testAConversationRequestOnAVerifiedLinkIsAdmittedWithoutAsking() async {
        let rig = rig()
        let transport = await openLink(rig)

        transport.onFrame?(.text, [LINK_TEXT_REQUEST])
        await settle()

        XCTAssertEqual(rig.model.textModel?.textStatus, .open,
                       "the peer is still waiting for an answer nobody can give")
        XCTAssertTrue((transport.sent[.text] ?? []).contains([RealtimeControl.accept.rawValue]),
                      "the conversation was never accepted on the wire")
        XCTAssertNil(rig.model.actionError)
    }

    /// **Nothing is admitted before the digits are compared.**
    ///
    /// The adversarial case: a peer that asks for a conversation the instant the
    /// transport publishes, while the SAS is still on screen. Admission is
    /// `acceptsWork`, which is false for the whole of that window, so the
    /// request waits exactly as an armed batch does.
    func testNoConversationIsAdmittedWhileTheDigitsAreUnanswered() async {
        let rig = rig(requiresVerification: true)
        let transport = await openLink(rig)

        transport.onFrame?(.text, [LINK_TEXT_REQUEST])
        await settle()

        XCTAssertFalse(rig.model.acceptsWork)
        XCTAssertEqual(rig.model.textModel?.textStatus, .incomingRequest,
                       "the request was answered before it was allowed to be")
        XCTAssertFalse((transport.sent[.text] ?? []).contains([RealtimeControl.accept.rawValue]),
                       "consent was given before the digits were compared")

        // And confirming is what releases it — the same boundary, the same turn,
        // as the armed batch beside it.
        rig.model.confirmSAS()
        await settle()

        XCTAssertEqual(rig.model.textModel?.textStatus, .open)
        XCTAssertTrue((transport.sent[.text] ?? []).contains([RealtimeControl.accept.rawValue]))
    }

    /// And rejecting the digits admits nothing at all. The link is torn down
    /// with the request still unanswered, which is the only honest outcome: the
    /// user has just said they do not believe this is the right peer.
    func testRejectingTheDigitsAdmitsNoHeldConversation() async {
        let rig = rig(requiresVerification: true)
        let transport = await openLink(rig)

        transport.onFrame?(.text, [LINK_TEXT_REQUEST])
        await settle()
        rig.model.rejectSAS()
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.verificationRejected))
        XCTAssertFalse((transport.sent[.text] ?? []).contains([RealtimeControl.accept.rawValue]),
                       "a rejected link admitted a conversation on its way out")
    }

    /// **And nothing is admitted after the session ends.**
    ///
    /// A request can settle on a later turn than the teardown that raced it —
    /// the projection's own status change is delivered a hop behind the runtime
    /// — so admission re-reads the link rather than trusting the caller.
    /// `attemptBinding` is nil the instant `finish` runs, and `connection.isOpen`
    /// is false, so both halves of the guard hold independently.
    func testNoConversationIsAdmittedAfterTheLinkHasEnded() async {
        let rig = rig()
        let transport = await openLink(rig)

        rig.model.leave()
        await settle()
        XCTAssertFalse(rig.model.acceptsWork)
        let before = (transport.sent[.text] ?? []).count

        transport.onFrame?(.text, [LINK_TEXT_REQUEST])
        await settle()

        XCTAssertEqual((transport.sent[.text] ?? []).count, before,
                       "an ended link answered a conversation request")
    }

    /// The same rule when the link itself ends with a message still held.
    func testALinkThatEndsHandsBackAnUndeliveredDraft() async {
        let rig = rig()
        _ = await openLink(rig)
        rig.model.send(message: "unsent")
        await settle()

        rig.model.leave()
        await settle()

        XCTAssertEqual(rig.model.returnedDraft, "unsent")
        XCTAssertTrue(rig.model.restoreReturnedDraft())
        XCTAssertEqual(rig.model.draft, "unsent",
                       "a message the lane never took did not reach the composer")
    }

    // MARK: - 4. signalling loss

    /// **The property the batch's invariant names.** A healthy data channel does
    /// not need the room, so losing the room does not end it — and new work still
    /// goes over it afterwards.
    func testAHealthyLinkSurvivesSignalingLossAndKeepsTakingWork() async throws {
        let rig = rig()
        let transport = await openLink(rig)

        rig.model.roomDidDisconnect()
        await settle()

        XCTAssertTrue(rig.model.connection.isOpen, "the lanes do not need the room")
        XCTAssertTrue(rig.model.signalingLost, "and the screen is told the room is gone")
        XCTAssertFalse(transport.isClosed)

        // New work, after the loss, on the same link.
        rig.model.send(message: "still here")
        rig.model.send(files: [meta("after.bin", 8)], sources: [source("after.bin", 8)])
        await settle()

        XCTAssertEqual(transport.sent[.text]?.first, [LINK_TEXT_REQUEST])
        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.count, 1,
                       "a batch queued after signalling loss still reaches the lane")
    }

    /// Before publication the establishment cannot finish — its answer and its
    /// candidates have nowhere to go — so it fails closed and says why.
    func testSignalingLossBeforePublicationFailsClosed() async {
        let rig = rig()
        announceLink(rig, "zzz")
        XCTAssertTrue(rig.model.connect(peerId: "zzz", peerLabel: "Studio Mac"))
        await settle()
        XCTAssertTrue(rig.model.connection.isActive)

        rig.model.roomDidDisconnect()
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.roomLost))
    }

    /// A new socket must NOT be attached under an open link: doing so would
    /// replace the epoch that link was admitted under and end it. It is taken
    /// when the link is over instead.
    func testANewRoomIsTakenOnlyOnceTheOpenLinkHasEnded() async {
        let rig = rig()
        let transport = await openLink(rig)
        rig.model.roomDidDisconnect()
        await settle()

        let secondChannel = FakeWebSocketChannel()
        let second = SignalingClient(channel: secondChannel, name: "self")
        secondChannel.fireOpen()
        secondChannel.fire(Envelope(type: SignalType.welcome, name: "aaa"))
        rig.model.roomDidConnect(second)
        await settle()

        XCTAssertTrue(rig.model.connection.isOpen, "the live link was not ended by the new room")
        XCTAssertFalse(transport.isClosed)

        rig.model.leave()
        await settle()
        rig.model.dismiss()
        await settle()

        // The pending room is taken now, and a new link can be built on it.
        announceLink(rig, "yyy")
        XCTAssertTrue(rig.model.connect(peerId: "yyy", peerLabel: "Other Mac"))
        await settle()
        XCTAssertEqual(rig.transports.count, 2)
    }

    /// Dismissing a finished session does not un-say that the room is gone.
    /// Clearing it there would let the next connect send a request into a dead
    /// socket and wait out its thirty-second timeout instead of refusing.
    func testDismissingASessionDoesNotClearAGoneRoom() async {
        let rig = rig()
        _ = await openLink(rig)
        rig.model.roomDidDisconnect()
        await settle()
        rig.model.leave()
        rig.model.dismiss()
        await settle()

        XCTAssertTrue(rig.model.signalingLost)
        announceLink(rig, "yyy")
        XCTAssertFalse(rig.model.connect(peerId: "yyy", peerLabel: "Other Mac"),
                       "a room that is gone refuses at once rather than timing out")
        XCTAssertEqual(rig.model.connection, .ended(.roomLost))
        XCTAssertEqual(rig.transports.count, 1)
    }

    // MARK: - 5. terminal truthfulness

    /// Without transport replacement a link that dies is over. The model says
    /// exactly that; nothing implies a recovery that no code performs.
    func testATransportFailureAfterPublicationIsTerminalAndTruthful() async {
        let rig = rig()
        let transport = await openLink(rig)

        transport.fail()
        await settle()

        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
        guard case let .ended(reason) = rig.model.connection else {
            return XCTFail("a dead transport must be terminal, was \(rig.model.connection)")
        }
        XCTAssertTrue(reason == .failed || reason == .closed)
        XCTAssertFalse(rig.model.connection.isActive)
        XCTAssertFalse(rig.model.acceptsWork, "nothing further may be queued on a dead link")
    }

    /// A terminal link keeps what the user still needs — its transcript and its
    /// batch results — until they dismiss it.
    func testATerminalLinkKeepsItsResultsUntilDismissed() async throws {
        let rig = rig()
        _ = await openLink(rig)
        rig.model.send(files: [meta("a.bin", 8)], sources: [source("a.bin", 8)])
        await settle()

        // The user's own exit, which is the one ending with no clock in it.
        rig.model.leave()
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.closed))
        XCTAssertTrue(rig.model.hasSession, "the result outlives the transport")
        XCTAssertFalse(try XCTUnwrap(rig.model.fileModel).batches.isEmpty,
                       "a batch row survives for the user to read")
        rig.model.dismiss()
        XCTAssertEqual(rig.model.connection, .idle)
        XCTAssertNil(rig.model.fileModel)
        XCTAssertFalse(rig.model.hasSession)
    }

    /// A peer that hangs up an IDLE link ends it at once, and the Workspace says
    /// so rather than leaving a dead connection on screen.
    func testACleanHangupOnAnIdleLinkIsTerminalAtOnce() async {
        let rig = rig()
        let transport = await openLink(rig)

        transport.hangUp()
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.closed))
        XCTAssertFalse(rig.model.acceptsWork)
    }

    /// **A transport lost while a batch is in flight is terminal at once, and
    /// the surface never says otherwise.**
    ///
    /// This is the case that used to be wrong. `LinkLaneOwner` answers "yes,
    /// there is work a replacement could resume" whenever a batch is on the
    /// lane, and the coordinator read that as permission to open
    /// `LINK_RECOVERY_WINDOW`. With no shipped replacement that window could
    /// only expire, so for ninety seconds the Workspace said `open`, the
    /// composer accepted typing, and the batches the user queued in between went
    /// nowhere. `LinkSessionRuntime.narrowRecoveryWindow` declines the window
    /// this build cannot use, and the truthful terminal state arrives instead.
    func testATransportLostMidBatchIsTerminalWithNoIntervalOfFalseOpen() async {
        let rig = rig()
        let transport = await openLink(rig)
        rig.model.send(files: [meta("a.bin", 8)], sources: [source("a.bin", 8)])
        await settle()

        transport.fail()
        await settle()

        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
        XCTAssertFalse(rig.model.connection.isOpen,
                       "no interval in which a dead link is reported open")
        guard case let .ended(reason) = rig.model.connection else {
            return XCTFail("a dead transport must be terminal, was \(rig.model.connection)")
        }
        XCTAssertEqual(reason, .failed)
        XCTAssertFalse(rig.model.acceptsWork, "and nothing further may be queued on it")
    }

    /// The same for a clean hangup mid-batch: no error, still terminal, still no
    /// window. `LINK_RECOVERY_WINDOW` is never entered, so its ninety seconds
    /// never elapse on screen.
    func testACleanHangupMidBatchIsTerminalToo() async {
        let rig = rig()
        let transport = await openLink(rig)
        rig.model.send(files: [meta("a.bin", 8)], sources: [source("a.bin", 8)])
        await settle()

        transport.hangUp()
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.closed))
        XCTAssertFalse(rig.model.acceptsWork)
    }

    // MARK: - 6. stale state

    /// **A Finder drag accepted on one link may not stage onto the next one.**
    ///
    /// The pane is the thing that outlives the attempt: `hasSession` is true for
    /// `.ended`, so `TransferLinkPane` stays on screen with its `@StateObject`
    /// selection store intact, and `connect` is admitted from `.ended` without a
    /// `dismiss` — which is the whole substitution, performed here rather than
    /// described. AppKit accepts a drop before its payload exists; by the time
    /// the item providers resolve, the model is serving somebody else.
    ///
    /// What makes this worth a model-level test rather than only a value-level
    /// one is the middle assertion: `acceptsWork` really is true again on the
    /// replacement, from the real state machine. Every gate the drop target had
    /// before `attemptGeneration` says yes here.
    func testADropAcceptedOnOneLinkIsRefusedByTheLinkThatReplacedIt() async throws {
        let rig = rig()
        _ = await openLink(rig, peerId: "zzz")
        XCTAssertTrue(rig.model.acceptsWork)

        // AppKit takes the drag HERE, and the pane records which attempt for.
        let droppedInto = FileDropContext("attempt \(rig.model.attemptGeneration)")

        // …and while the providers resolve, this link ends and the user opens a
        // different one. No `dismiss`: the pane is still up, which is why its
        // store is still there for a stale batch to land in.
        rig.model.leave()
        await settle()
        XCTAssertTrue(rig.model.hasSession, "the pane was torn down, so nothing survives to race")
        announceLink(rig, "yyy")
        XCTAssertTrue(rig.model.connect(peerId: "yyy", peerLabel: "Other Mac"))
        await settle()
        rig.transports[1].publish(identity(peerId: "yyy"))
        await settle()

        // The state the old gate read, on the NEW peer: open, digits answered,
        // not busy, and willing to take a batch.
        XCTAssertTrue(rig.model.acceptsWork,
                      "the replacement link is not open, so this test proves nothing")
        XCTAssertEqual(rig.model.peerLabel, "Other Mac")
        let nowServing = FileDropContext("attempt \(rig.model.attemptGeneration)")
        XCTAssertNotEqual(droppedInto, nowServing,
                          "a new attempt reused the previous attempt's identity")

        let url = dir.appendingPathComponent("dragged.bin")
        try Data([1, 2, 3]).write(to: url)
        let paneStore = SelectionStore()

        XCTAssertEqual(admitFileDrop([url], isBusy: !rig.model.acceptsWork,
                                     droppedInto: droppedInto, nowServing: nowServing),
                       .refusedStaleContext,
                       "a drag begun on the link to zzz was staged for the link to yyy")
        XCTAssertTrue(paneStore.isEmpty)

        // Non-vacuous: the same batch, the same live model, the same non-busy
        // read — and the only change is that the attempt is the one dropped on.
        guard case let .accepted(urls) = admitFileDrop([url],
                                                       isBusy: !rig.model.acceptsWork,
                                                       droppedInto: nowServing,
                                                       nowServing: nowServing) else {
            return XCTFail("the token refused a drag that never left its own attempt")
        }
        paneStore.add(urls)
        XCTAssertEqual(paneStore.files.map(\.name), ["dragged.bin"])
    }

    /// The generation is only worth comparing if it actually moves, and moves
    /// exactly once per attempt. An `attemptGeneration` that were constant would
    /// make every stale-drop assertion above pass for the wrong reason.
    func testTheAttemptGenerationChangesOncePerAttemptAndNeverGoesBack() async {
        let rig = rig()
        var seen: [Int] = [rig.model.attemptGeneration]

        _ = await openLink(rig, peerId: "zzz")
        seen.append(rig.model.attemptGeneration)
        // Neither the digits being answered nor the link merely running is a new
        // attempt: a drag staged on this link must still be staged on this link.
        rig.model.send(message: "hello")
        await settle()
        XCTAssertEqual(rig.model.attemptGeneration, seen.last)

        rig.model.leave()
        await settle()
        XCTAssertEqual(rig.model.attemptGeneration, seen.last,
                       "an ending is not a new attempt; the pane is still about the old peer")

        announceLink(rig, "yyy")
        XCTAssertTrue(rig.model.connect(peerId: "yyy", peerLabel: "Other Mac"))
        await settle()
        seen.append(rig.model.attemptGeneration)

        XCTAssertEqual(seen, seen.sorted(), "an attempt reused an earlier identity")
        XCTAssertEqual(Set(seen).count, seen.count, "two different attempts share one identity")
    }

    /// A projection belonging to an attempt that has been replaced may not
    /// repaint the current one. The generation guard is what makes that true
    /// rather than merely unlikely.
    func testAStaleAttemptCannotRepaintALaterOne() async {
        let rig = rig()
        let first = await openLink(rig)
        rig.model.leave()
        rig.model.dismiss()
        await settle()

        announceLink(rig, "yyy")
        XCTAssertTrue(rig.model.connect(peerId: "yyy", peerLabel: "Other Mac"))
        await settle()

        // The retired attempt's transport speaks again. Its bridge was silenced
        // by `retire()`, and the generation guard is the backstop underneath.
        first.publish(identity(peerId: "zzz"))
        first.fail()
        await settle()

        XCTAssertEqual(rig.model.peerLabel, "Other Mac")
        XCTAssertTrue(rig.model.connection.isActive,
                      "a dead attempt must not end the one that replaced it")
    }

    /// A request outcome that arrives after a link has been assembled is an echo,
    /// and it must not overwrite the better reason the link itself will give.
    func testALateRequestOutcomeDoesNotOverwriteAnEstablishedLink() async {
        // "zzz" is larger than this side's "aaa", so this side offers directly
        // and the operation settles `.establishing` — the shape that used to be
        // able to end an attempt that had already become a link.
        let rig = rig()
        _ = await openLink(rig)
        await settle()
        XCTAssertTrue(rig.model.connection.isOpen)
    }

    // MARK: - 7. cancel and re-arm

    /// A batch the user armed and then changed their mind about is dropped
    /// without touching the lane — the lane never saw it — and a new one can be
    /// armed in its place.
    func testAnArmedBatchCanBeCancelledAndReArmed() async throws {
        let rig = rig(requiresVerification: true)
        let transport = await openLink(rig,
                                       files: [meta("wrong.bin", 8)],
                                       sources: [source("wrong.bin", 8)])
        XCTAssertEqual(rig.model.armedFiles.map(\.name), ["wrong.bin"])

        rig.model.cancelArmedBatch()
        XCTAssertTrue(rig.model.armedFiles.isEmpty)

        rig.model.send(files: [meta("right.bin", 8)], sources: [source("right.bin", 8)])
        XCTAssertEqual(rig.model.armedFiles.map(\.name), ["right.bin"],
                       "a send before verification arms rather than leaks")
        XCTAssertNil(transport.sent[.file])

        rig.model.confirmSAS()
        await settle()
        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.map(\.files.first?.name),
                       ["right.bin"])
    }

    /// A SECOND batch armed behind the boundary is a second batch, not a
    /// replacement. Both are released, in the order the user chose them.
    func testTwoBatchesArmedBehindTheBoundaryAreBothReleasedInOrder() async throws {
        let rig = rig(requiresVerification: true)
        _ = await openLink(rig, files: [meta("first.bin", 8)], sources: [source("first.bin", 8)])
        rig.model.send(files: [meta("second.bin", 8)], sources: [source("second.bin", 8)])

        XCTAssertEqual(rig.model.armedFiles.map(\.name), ["first.bin", "second.bin"],
                       "a second armed batch must not silently replace the first")

        rig.model.confirmSAS()
        await settle()

        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.map(\.files.first?.name),
                       ["first.bin", "second.bin"])
        XCTAssertTrue(rig.model.armedFiles.isEmpty)
    }

    /// A queued outbound batch can be cancelled on the lane, and the link
    /// survives it: cancelling a batch is not hanging up.
    func testCancellingAQueuedBatchLeavesTheLinkOpen() async throws {
        let rig = rig()
        let transport = await openLink(rig)
        rig.model.send(files: [meta("a.bin", 8)], sources: [source("a.bin", 8)])
        rig.model.send(files: [meta("b.bin", 8)], sources: [source("b.bin", 8)])
        await settle()

        let queued = try XCTUnwrap(try XCTUnwrap(rig.model.fileModel).outbound.last)
        rig.model.cancelQueuedBatch(queued.id)
        await settle()

        XCTAssertTrue(rig.model.connection.isOpen)
        XCTAssertFalse(transport.isClosed)
        rig.model.send(files: [meta("c.bin", 8)], sources: [source("c.bin", 8)])
        await settle()
        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.count, 3,
                       "the lane still takes work after a cancel")
    }

    // MARK: - 8. one link at a time

    /// One link, and the surface says no rather than building a second.
    func testASecondConnectIsRefusedWhileALinkIsLive() async {
        let rig = rig()
        _ = await openLink(rig)

        announceLink(rig, "yyy")
        XCTAssertFalse(rig.model.connect(peerId: "yyy", peerLabel: "Other Mac"))
        await settle()
        XCTAssertEqual(rig.transports.count, 1)
    }

    /// The app is the authority on whether an unsolicited link may take the
    /// Workspace, and a refusal ends it at once rather than leaving the room
    /// connecting to a link nothing will render.
    func testAnUnsolicitedLinkTheAppRefusesIsEndedImmediately() async {
        // This side is "zzz" and the peer is "aaa", so the peer is the smaller
        // id and therefore the one allowed to offer. The role rule is not a
        // preference: two offers into one pair of lanes is what it removes.
        let rig = rig(selfId: "zzz")
        rig.model.shouldAcceptLink = { _ in false }
        announceLink(rig, "aaa")

        // An offer the room routes: exactly what `LinkRoomRouter` consumes and
        // `handOff` hands to the assembly.
        let offer = linkSDPSignal(kind: "offer", sdp: "v=0", commit: nil,
                                  caps: [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa", data: offer))
        await settle()

        XCTAssertEqual(rig.transports.count, 1, "the offer really was routed and assembled")
        XCTAssertEqual(rig.model.connection, .ended(.unavailable))
        XCTAssertTrue(rig.transports.allSatisfy { $0.isClosed },
                      "a refused link must not be left running")
    }

    /// The mirror image, and the one that has to keep working: an unsolicited
    /// link the app ACCEPTS becomes the Workspace's session, labelled from the
    /// same roster the user was looking at.
    func testAnUnsolicitedLinkTheAppAcceptsBecomesTheSession() async {
        let rig = rig(selfId: "zzz")
        rig.model.resolvePeerLabel { _ in "Studio Mac" }
        rig.model.shouldAcceptLink = { _ in true }
        announceLink(rig, "aaa")

        let offer = linkSDPSignal(kind: "offer", sdp: "v=0", commit: nil,
                                  caps: [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa", data: offer))
        await settle()

        XCTAssertEqual(rig.transports.count, 1)
        XCTAssertTrue(rig.model.connection.isActive)
        XCTAssertEqual(rig.model.peerLabel, "Studio Mac")

        rig.transports[0].publish(identity(peerId: "aaa", role: .responder))
        await settle()
        XCTAssertTrue(rig.model.connection.isOpen)
    }

    /// Connect from the side that can only ASK, with the surface already claimed
    /// — and the offer that comes back becomes the link.
    ///
    /// This is the shipped defect the T2b built-App runs exposed, driven through
    /// the whole composition. `linkRole` gives the SMALLER id the offer, so this
    /// side ("zzz") cannot offer to "aaa": tapping Connect sends a request and
    /// waits for the peer to offer. `NearbyView.connectLink` claims the
    /// presentation surface one line BEFORE it dials, and `observeAvailability`
    /// mirrors that claim into the room's `canAcceptLink` as false — so the
    /// answering offer used to be routed `busy`, which `LinkSignalPolicy` turns
    /// into an immediate `.peerBusy` failure at the peer. The user saw Connect do
    /// nothing for thirty seconds; the counterpart's log showed ten
    /// establishments dying in the same second each, one per request retry.
    ///
    /// Which of the two ids is smaller is decided per socket, which is why the
    /// same build connected on one launch and could not connect at all on the
    /// next — and why this has to be a deterministic test rather than a rerun.
    func testConnectFromTheAskingSideSucceedsWithTheSurfaceAlreadyClaimed() async {
        let rig = rig(requiresVerification: true, selfId: "zzz")
        announceLink(rig, "aaa")
        // Exactly what the app writes when it claims the surface for the session
        // it is about to start. `shouldAcceptLink` is set to refuse as well: the
        // authoritative main-actor gate is for links this side did NOT ask for,
        // and a solicited one must never reach it.
        rig.model.setAvailableForInboundLink(false)
        rig.model.shouldAcceptLink = { _ in false }

        XCTAssertTrue(rig.model.connect(peerId: "aaa", peerLabel: "Studio Mac",
                                        files: [meta("brief.txt", 1536)],
                                        sources: [source("brief.txt", 1536)]))
        XCTAssertEqual(rig.model.connection, .requesting)

        // The peer answers the ask.
        let offer = linkSDPSignal(kind: "offer", sdp: "v=0", commit: nil,
                                  caps: [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa", data: offer))
        await settle()

        XCTAssertEqual(rig.transports.count, 1, """
            the answer to this side's own request was refused, so Connect built \
            nothing and the peer was told `busy`
            """)
        XCTAssertEqual(rig.model.connection, .establishing(sas: nil))
        XCTAssertEqual(rig.model.peerLabel, "Studio Mac",
                       "the label the user tapped survives the adoption")
        XCTAssertEqual(rig.model.armedFiles.map(\.name), ["brief.txt"],
                       "and so does the batch they staged before connecting")

        rig.transports[0].publish(identity(peerId: "aaa", role: .responder))
        await settle()
        XCTAssertTrue(rig.model.connection.isOpen)
        XCTAssertTrue(rig.model.isVerificationPending,
                      "the SAS boundary is still the one gate on the staged batch")
    }

    /// An offer attributed to a peer that never announced `link/1` is not routed
    /// at all — the capability predicate is the first thing the router asks, so a
    /// relay cannot manufacture a link out of a legacy peer's id.
    func testAnOfferFromAnUnannouncedPeerIsNotRouted() async {
        let rig = rig(selfId: "zzz")
        announceLegacy(rig, "aaa")

        let offer = linkSDPSignal(kind: "offer", sdp: "v=0", commit: nil,
                                  caps: [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa", data: offer))
        await settle()

        XCTAssertTrue(rig.transports.isEmpty,
                      "the SDP's own caps list must not upgrade a roster-legacy peer")
        XCTAssertEqual(rig.model.connection, .idle)
    }

    /// A frame attributed to a peer this link is not bound to changes nothing.
    func testAFrameFromTheWrongPeerDoesNotTouchTheLiveLink() async {
        let rig = rig()
        _ = await openLink(rig)

        let offer = linkSDPSignal(kind: "offer", sdp: "v=0", commit: nil,
                                  caps: [TEXT_CAPABILITY, LINK_CAPABILITY])
        announceLink(rig, "yyy")
        rig.channel.fire(Envelope(type: SignalType.signal, from: "yyy", data: offer))
        await settle()

        XCTAssertEqual(rig.transports.count, 1, "a second peer may not take the room")
        XCTAssertTrue(rig.model.connection.isOpen)
    }

    /// The receive directory is a SNAPSHOT the application resolved, taken per
    /// link and handed straight through.
    func testTheReceiveDirectoryIsTheApplicationsSnapshot() async {
        let rig = rig()
        _ = await openLink(rig)
        XCTAssertEqual(rig.receiveDirectories, [dir])
    }

    // MARK: - 9. the production wiring

    /// The LAN link is built from STUN only, with every credential dropped, so
    /// it cannot allocate a TURN relay — which is why this room needs no relay
    /// lifetime bound and a pairing-code room would.
    func testTheSameNetworkLinkCannotAllocateARelay() {
        let filtered = RealtimeConnectionFactory.nearbyICEServers([
            ICEServerConfig(urls: ["stun:stun.example:3478"]),
            ICEServerConfig(urls: ["turn:relay.example:3478"],
                            username: "9999999999:tok", credential: "secret"),
            ICEServerConfig(urls: ["turns:relay.example:5349", "stun:relay.example:3478"],
                            username: "9999999999:tok", credential: "secret"),
        ])
        XCTAssertEqual(filtered.map(\.urls),
                       [["stun:stun.example:3478"], ["stun:relay.example:3478"]])
        for server in filtered {
            XCTAssertNil(server.username, "a nearby link carries no relay credential")
            XCTAssertNil(server.credential)
        }
    }

    // MARK: - 10. the same-network room's own authority
    //
    // The observer callbacks below are ignored while a pairing code owns the
    // router — see `LinkPairingRoomTests`. These two are the other side of that
    // rule, and they are what stops the isolation from becoming a blanket
    // disable: when the same-network room IS the room being routed, its roster
    // and its departure frames keep exactly the authority they always had.

    /// A device that vanished from the roster this request was made against
    /// withdraws the ask, rather than leaving it running for the router's full
    /// bound against something that is no longer there.
    func testTheSameNetworkRosterStillWithdrawsItsOwnRequest() async {
        // The larger id, so this side asks and waits instead of offering.
        let rig = rig(selfId: "zzz")
        announceLink(rig, "aaa")
        XCTAssertTrue(rig.model.connect(peerId: "aaa", peerLabel: "Phone"))
        await settle()
        XCTAssertEqual(rig.model.connection, .requesting)

        rig.model.roomRosterChanged(peerIds: ["other"])
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.closed))
        XCTAssertTrue(rig.transports.isEmpty)
    }

    /// And the hub's `left` frame still ends the exact link bound to that id.
    func testTheSameNetworkDepartureStillEndsItsOwnLink() async {
        let rig = rig()
        let transport = await openLink(rig)
        XCTAssertTrue(rig.model.connection.isOpen)

        rig.model.roomPeerLeft("zzz")
        await settle()

        XCTAssertFalse(rig.model.connection.isOpen,
                       "a physical departure in the routed room must still end its link")
        XCTAssertTrue(transport.isClosed)
    }

    /// The default receive directory is the one the legacy nearby receive
    /// already writes into, so a user does not have to learn a second place.
    func testTheDefaultReceiveDirectoryMatchesTheLegacyNearbyReceive() {
        let expected = FileManager.default
            .urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        XCTAssertEqual(AppEnvironment.defaultLinkReceiveDirectory(), expected)
    }

    // MARK: - 9. what the peer's arrival does and does not repaint
    //
    // The observation boundary, stated as a test rather than as a comment in a
    // view file.
    //
    // Runtime proof: on a stable mixed LAN link the Web peer sent two messages
    // and the Mac transcript stayed blank. When the link later FAILED, both
    // appeared at once, newest-first, each with its Copy — nothing had been
    // lost, and nothing had been observing. The pane observes
    // `LinkWorkspaceModel`; the messages had landed in
    // `LinkSessionPresentationModel`, whose only observer was a child view the
    // pane's own mount condition had never put on screen.
    //
    // So this is the property that makes "mount the child whenever the model
    // exists" load-bearing rather than stylistic: an inbound message or an
    // inbound batch repaints the NESTED model and nothing else. If either of
    // these assertions has to be relaxed, `TransferLinkPane` is free to gate on
    // contents again — and until then it is not.

    func testAPeersMessageAndBatchRepaintOnlyTheNestedModelsThatHoldThem() async throws {
        let rig = rig()
        await openLink(rig)
        let text = try XCTUnwrap(rig.model.textModel)
        let files = try XCTUnwrap(rig.model.fileModel)

        // Attached after the link is fully open, so nothing here is counting the
        // establishment the pane already rebuilt for.
        var parentPublications = 0
        var textPublications = 0
        var filePublications = 0
        rig.model.objectWillChange.sink { _ in parentPublications += 1 }.store(in: &observers)
        text.objectWillChange.sink { _ in textPublications += 1 }.store(in: &observers)
        files.objectWillChange.sink { _ in filePublications += 1 }.store(in: &observers)

        // 1. The peer's message. Exactly the event `LinkSessionAttempt` delivers
        //    when a `received` crosses the text lane.
        text.apply(.text(.received("ORDER-OLD")))
        text.apply(.text(.received("ORDER-NEW")))
        await settle()

        XCTAssertEqual(text.textMessages.map(\.body), ["ORDER-OLD", "ORDER-NEW"],
                       "the transcript did not take the peer's messages")
        XCTAssertEqual(text.textMessagesNewestFirst.map(\.body), ["ORDER-NEW", "ORDER-OLD"],
                       "the transcript a view reads is no longer newest first")
        XCTAssertGreaterThanOrEqual(textPublications, 2,
                                    "a view observing the conversation is not told a message arrived")
        XCTAssertEqual(parentPublications, 0,
                       "the pane's own model repainted for a nested change — if this is now "
                       + "intended, say so here rather than gating a mount on nested contents")

        // 2. The peer's batch, on the same still-silent link.
        files.apply(.file(.inboundOffer(batch: 7, files: [meta("a.bin", 8)])))
        await settle()

        XCTAssertEqual(files.batches.map(\.id), [7], "the transfer list did not take the offer")
        XCTAssertGreaterThanOrEqual(filePublications, 1,
                                    "a view observing the transfers is not told a batch arrived")
        XCTAssertEqual(parentPublications, 0,
                       "the pane's own model repainted for a nested batch")

        // 3. And the link itself is untouched by either. This is what made the
        //    fault invisible for as long as it was: the pane had no reason to
        //    rebuild until something ENDED the link.
        XCTAssertTrue(rig.model.connection.isOpen)
    }
}

// MARK: - the composer's text, and who owns it

extension LinkWorkspaceModelTests {

    /// **The draft belongs to the link, not to a view.**
    ///
    /// macOS keeps running with its window closed, so the pane is torn down and
    /// rebuilt while the link survives. A view-local draft vanished on every
    /// close/reopen with the connection still up, and the quit guard could not
    /// see it either — ⌘Q with a draft and no transcript warned about nothing
    /// and discarded it.
    ///
    /// Reconstruction is modelled as what it is: the view goes away and the
    /// model does not.
    func testADraftSurvivesTheViewThatWasTypingIt() async {
        let rig = rig()
        _ = await openLink(rig)

        rig.model.draft = "half a sentence"
        // The pane is rebuilt: nothing about that touches the model.
        XCTAssertEqual(rig.model.draft, "half a sentence",
                       "the draft was lost with the view that held it")
        XCTAssertTrue(rig.model.holdsLocalText,
                      "a draft alone is not reported as local text, so ⌘Q would "
                      + "discard it without warning")
    }

    /// Whitespace is not content, so an accidental newline does not turn a
    /// hangup into a dialog.
    func testWhitespaceAloneIsNotLocalText() async {
        let rig = rig()
        _ = await openLink(rig)
        rig.model.draft = "   \n  "
        XCTAssertFalse(rig.model.holdsLocalText)
    }

    /// **A confirmed destructive leave actually discards.**
    ///
    /// `leave()` keeps the projections on purpose, so the ended page still held
    /// the conversation — the confirmation's promise was untrue, and the Done on
    /// that page met the same predicate and asked a second time. One
    /// confirmation, one discard.
    func testAConfirmedLeaveDiscardsTheLocalTextItWarnedAbout() async {
        let rig = rig()
        let transport = await openLink(rig)
        rig.model.draft = "unsent"
        // A message still waiting for the peer to accept is local text too: it
        // is in the model rather than on the wire, and a teardown loses it.
        rig.model.send(message: "also unsent")
        await settle()
        XCTAssertTrue(rig.model.holdsLocalText, "there is nothing at risk to discard")

        rig.model.leaveDiscardingLocalText()
        await settle()

        XCTAssertEqual(rig.model.draft, "", "the confirmed discard kept the draft")
        XCTAssertNil(rig.model.textModel,
                     "the confirmed discard kept the transcript it warned about")
        XCTAssertFalse(rig.model.holdsLocalText,
                       "the terminal page still holds local text, so Done asks again")
        guard case .ended = rig.model.connection else {
            return XCTFail("the confirmed discard did not end the link")
        }
    }

    /// …and the file results survive it. A terminal batch's result is not the
    /// local text anybody was warned about, and discarding it would be a second
    /// unannounced loss in the other direction.
    func testAConfirmedLeaveKeepsTerminalFileResults() async {
        let rig = rig()
        _ = await openLink(rig)
        XCTAssertNotNil(rig.model.fileModel)

        rig.model.leaveDiscardingLocalText()
        await settle()

        XCTAssertNotNil(rig.model.fileModel,
                        "the confirmed text discard also threw away the file results")
    }

    /// An ordinary leave with nothing at risk keeps the transcript projection as
    /// it always did — this is the control that stops the discard from being
    /// applied to every exit.
    func testAnOrdinaryLeaveKeepsTheProjectionsItAlwaysKept() async {
        let rig = rig()
        _ = await openLink(rig)

        rig.model.leave()
        await settle()

        XCTAssertNotNil(rig.model.textModel,
                        "an unconfirmed leave discarded a projection nobody warned about")
    }

    // MARK: - one message waiting at a time

    /// **A second Send cannot overwrite the first while it waits.**
    ///
    /// `pendingMessage` was assigned unconditionally, so a second Send while the
    /// peer had not yet accepted the conversation replaced the first — gone,
    /// with no error and no trace, and the composer already cleared for it.
    func testASecondSendCannotOverwriteAMessageStillWaiting() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)
        // The first send opens the conversation and waits for the peer, which is
        // the window a second send used to overwrite.
        rig.model.send(message: "first")
        await settle()
        XCTAssertFalse(rig.model.canSendMessage,
                       "the composer stays live while a message is already waiting")

        XCTAssertFalse(rig.model.send(message: "second"),
                       "a second send while one waits reported acceptance")

        XCTAssertNotNil(rig.model.actionError,
                        "the refused second send said nothing")
        XCTAssertTrue(rig.model.isWaitingForConversation)
    }

    /// **A refused send reports refusal, so the composer can keep the words.**
    ///
    /// The view cleared its draft unconditionally after calling `send`, so every
    /// refusal erased the text it was refusing. `send` returning the model's own
    /// answer is what makes the composer's clear transactional rather than an
    /// inference from having called it.
    func testSendReportsWhetherItTookTheMessage() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)

        XCTAssertTrue(rig.model.send(message: "first"), "an accepted send reported refusal")
        await settle()
        XCTAssertFalse(rig.model.canSendMessage,
                       "the composer is still live for a press the model would refuse")
        XCTAssertFalse(rig.model.send(message: "second"))

        // …and it becomes sendable again once the first resolves. The peer
        // refusing the conversation hands the first message back and frees the
        // lane for another attempt.
        rig.transports[0].onFrame?(.text, [RealtimeControl.reject.rawValue])
        await settle()
        XCTAssertEqual(rig.model.returnedDraft, "first",
                       "the refused conversation did not hand the message back")
        XCTAssertNotNil(rig.model.actionError, "a refusal with no explanation")
        XCTAssertTrue(rig.model.canSendMessage,
                      "the lane stayed blocked after the pending message resolved")
    }

    /// **A returned message is not consumed into a composer that is busy.**
    ///
    /// `takeReturnedDraft` cleared the model's copy and THEN checked whether the
    /// composer was free, so a user who had started typing something new lost
    /// the returned text entirely — out of the model, refused by the
    /// destination, held by nobody.
    func testAReturnedMessageIsNotConsumedIntoABusyComposer() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)
        rig.model.send(message: "held")
        await settle()
        rig.model.leave()
        await settle()

        XCTAssertEqual(rig.model.returnedDraft, "held",
                       "a message the lane never took was not handed back")

        // The user typed something else in the meantime.
        rig.model.draft = "new words"
        XCTAssertFalse(rig.model.restoreReturnedDraft(),
                       "the returned message overwrote what the user was typing")
        XCTAssertEqual(rig.model.draft, "new words")
        XCTAssertEqual(rig.model.returnedDraft, "held",
                       "the refused restore consumed the text anyway, losing it")

        // …and it lands as soon as the composer is free again.
        rig.model.draft = ""
        XCTAssertTrue(rig.model.restoreReturnedDraft())
        XCTAssertEqual(rig.model.draft, "held")
        XCTAssertNil(rig.model.returnedDraft, "a landed message was not consumed")
    }
}


// MARK: - the pending-message policy, and the returned draft

extension LinkWorkspaceModelTests {

    /// **The shared default still replaces**, which is what the paused iOS
    /// composer needs.
    ///
    /// That composer gates Send on `canCompose`, ignores what `send` returns and
    /// clears its own view-local draft either way. Refusing globally did not
    /// protect it — it broke it: the second message was declined by the model
    /// AND wiped by the view, a silent loss where there had been a visible
    /// replacement. Asserted by NOT naming a policy, so a flipped default fails
    /// here rather than reading as a test update.
    func testTheDefaultPolicyStillReplacesAWaitingMessage() async {
        let rig = rig()
        _ = await openLink(rig)

        XCTAssertTrue(rig.model.send(message: "first"))
        await settle()
        XCTAssertTrue(rig.model.canSendMessage,
                      "the shared default stopped allowing a replacement")
        XCTAssertTrue(rig.model.send(message: "second"),
                      "the shared default refused, which the iOS composer cannot see")

        // **A Bool is not the behaviour.** Reporting acceptance and then keeping
        // the first message would satisfy every assertion above while silently
        // dropping the second — so the replacement is proved by which message
        // the lane hands back when the conversation is refused.
        rig.transports[0].onFrame?(.text, [RealtimeControl.reject.rawValue])
        await settle()
        XCTAssertEqual(rig.model.returnedDraft, "second",
                       "the shared default reported acceptance but kept the first "
                       + "message, so the second was lost after all")
    }

    /// …and a composition that opted in refuses instead.
    func testTheOptedInPolicyRefusesAWaitingMessage() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)

        XCTAssertTrue(rig.model.send(message: "first"))
        await settle()
        XCTAssertFalse(rig.model.canSendMessage)
        XCTAssertFalse(rig.model.send(message: "second"))
    }

    /// **A handed-back message is guarded and eventually lands.**
    ///
    /// It refuses to overwrite live text — correctly — but nothing retried, so
    /// it sat in the model invisible and unreachable. And `holdsLocalText`
    /// omitted it, so the one text nobody could see was also the one nobody
    /// warned about before a quit or a Leave.
    func testAReturnedMessageIsGuardedUntilTheComposerIsFree() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)
        rig.model.send(message: "first")
        await settle()
        rig.transports[0].onFrame?(.text, [RealtimeControl.reject.rawValue])
        await settle()
        XCTAssertEqual(rig.model.returnedDraft, "first")

        // The user has typed something else in the meantime.
        rig.model.draft = "second"
        XCTAssertFalse(rig.model.restoreReturnedDraft(),
                       "the returned message overwrote live text")
        XCTAssertEqual(rig.model.returnedDraft, "first", "…and was consumed anyway")
        // It is protected while it waits: a quit or a Leave must warn.
        XCTAssertTrue(rig.model.holdsLocalText)

        // Sending or clearing the second frees the composer, and it lands.
        rig.model.draft = ""
        XCTAssertTrue(rig.model.restoreReturnedDraft())
        XCTAssertEqual(rig.model.draft, "first")
        XCTAssertNil(rig.model.returnedDraft)
    }

    /// A returned message ALONE is still local text — the case where the
    /// composer is empty and the transcript is empty, which is exactly when a
    /// predicate that omitted it warned about nothing.
    func testAReturnedMessageAloneIsLocalText() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)
        rig.model.send(message: "held")
        await settle()
        rig.transports[0].onFrame?(.text, [RealtimeControl.reject.rawValue])
        await settle()

        // Simulate a composer that is busy at the moment it is handed back, so
        // the model keeps it rather than placing it.
        rig.model.draft = "typing"
        _ = rig.model.restoreReturnedDraft()
        rig.model.draft = ""
        // …and before the retry runs, it is already protected.
        XCTAssertNotNil(rig.model.returnedDraft)
        XCTAssertTrue(rig.model.holdsLocalText,
                      "a handed-back message is invisible AND unguarded")
    }

    /// The confirmed discard clears it too, so a session cannot carry it away.
    func testAConfirmedDiscardClearsTheReturnedMessage() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)
        rig.model.send(message: "held")
        await settle()
        rig.transports[0].onFrame?(.text, [RealtimeControl.reject.rawValue])
        await settle()
        rig.model.draft = "typing"
        _ = rig.model.restoreReturnedDraft()
        XCTAssertNotNil(rig.model.returnedDraft)

        rig.model.leaveDiscardingLocalText()
        await settle()

        XCTAssertNil(rig.model.returnedDraft,
                     "the confirmed discard left a handed-back message behind")
        XCTAssertFalse(rig.model.holdsLocalText)
    }
}


// MARK: - the confirmed discard, on a session that has already ended

extension LinkWorkspaceModelTests {

    /// **A handed-back message cannot survive the Done that promised to discard
    /// it.**
    ///
    /// The pane's ended branch cleared the draft itself and then dismissed,
    /// which missed `returnedDraft` entirely: a message the lane handed back
    /// after a refusal outlived a user-CONFIRMED destructive Done and carried
    /// into the next session, invisible and unasked for. Every holder goes
    /// through the one model operation now.
    func testAConfirmedDoneOnAnEndedSessionClearsEveryLocalTextHolder() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)

        // A message waits, the peer refuses it, and the lane hands it back while
        // the composer is busy — so the model keeps it rather than placing it.
        rig.model.send(message: "held")
        await settle()
        rig.transports[0].onFrame?(.text, [RealtimeControl.reject.rawValue])
        await settle()
        rig.model.draft = "typing"
        _ = rig.model.restoreReturnedDraft()
        XCTAssertNotNil(rig.model.returnedDraft, "the setup did not reach the state at issue")

        // Now the link ends, and the user confirms the destructive Done.
        rig.model.leave()
        await settle()
        guard case .ended = rig.model.connection else {
            return XCTFail("the session did not reach its terminal page")
        }
        XCTAssertTrue(rig.model.holdsLocalText,
                      "the terminal page holds text but would not have warned")

        rig.model.leaveDiscardingLocalText()
        await settle()

        XCTAssertNil(rig.model.returnedDraft,
                     "a handed-back message survived the Done that discarded it")
        XCTAssertEqual(rig.model.draft, "")
        XCTAssertFalse(rig.model.holdsLocalText,
                       "the next session would inherit text nobody asked to keep")
        XCTAssertEqual(rig.model.connection, .idle,
                       "the confirmed Done did not dismiss the ended session")
        // Done has always cleared the result page it dismisses; that is what
        // Done means, and it is unchanged here.
        XCTAssertNil(rig.model.fileModel)
        XCTAssertNil(rig.model.textModel)
    }

    /// The LIVE confirmed discard still keeps the file results, which is the
    /// other half of the same rule and must not drift with the change above.
    func testAConfirmedDiscardOnALiveLinkStillKeepsFileResults() async {
        let rig = rig(pendingMessages: .refuseWhileWaiting)
        _ = await openLink(rig)
        rig.model.draft = "unsent"

        rig.model.leaveDiscardingLocalText()
        await settle()

        XCTAssertEqual(rig.model.draft, "")
        XCTAssertNil(rig.model.textModel, "the transcript it warned about survived")
        XCTAssertNotNil(rig.model.fileModel,
                        "the text discard also threw away the file results")
        guard case .ended = rig.model.connection else {
            return XCTFail("the confirmed discard did not end the live link")
        }
    }
}
