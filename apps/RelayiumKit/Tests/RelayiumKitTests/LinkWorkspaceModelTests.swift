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
                     roomActive: Bool = true) -> Rig {
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

        XCTAssertEqual(rig.model.takeReturnedDraft(), "please take this")
        XCTAssertNil(rig.model.takeReturnedDraft(), "handed back exactly once")
        XCTAssertNotNil(rig.model.actionError)
    }

    /// The same rule when the link itself ends with a message still held.
    func testALinkThatEndsHandsBackAnUndeliveredDraft() async {
        let rig = rig()
        _ = await openLink(rig)
        rig.model.send(message: "unsent")
        await settle()

        rig.model.leave()
        await settle()

        XCTAssertEqual(rig.model.takeReturnedDraft(), "unsent")
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

    /// The default receive directory is the one the legacy nearby receive
    /// already writes into, so a user does not have to learn a second place.
    func testTheDefaultReceiveDirectoryMatchesTheLegacyNearbyReceive() {
        let expected = FileManager.default
            .urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        XCTAssertEqual(AppEnvironment.defaultLinkReceiveDirectory(), expected)
    }
}
