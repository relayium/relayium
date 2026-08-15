import Combine
import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the transport under an iOS link
//
// The same shape `LinkWorkspaceModelTests` uses, and for the same reason: a
// transport that can be driven through every ending a real one produces, while
// the router, the room session, the factory, the attempt, the runtime and both
// projections are production code. It is a second copy rather than a shared
// fixture because the existing rig is `private` to that suite and lifting it out
// would make one suite's harness the other's dependency — this file's questions
// are about the ORDER of iOS's lifecycle and its destination, not about the wire.

private final class IOSLinkTransport: LinkRoutableInitialTransport, @unchecked Sendable {
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

    var sent: [LinkLane: [[UInt8]]] { state.lock(); defer { state.unlock() }; return _sent }
    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }

    func start() {}
    func receive(from: String, signal: JSONValue) {}
    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        state.lock(); _sent[lane, default: []].append(bytes); state.unlock()
    }
    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    func close() { state.lock(); _closed = true; state.unlock() }

    func publish(_ identity: LinkIdentity, sas: String = "424242") {
        onSAS?(sas)
        onReady?(identity)
    }
}

/// A no-op legacy connection, so a `RealtimeSessionModel`/`RealtimeTextSessionModel`
/// can exist beside the link without reaching anything.
private final class IdleConnection: RealtimePeerConnection, @unchecked Sendable {
    var onSAS: ((String) -> Void)?
    var onOpen: (() -> Void)?
    var onManifest: (([FileMeta]) -> Void)?
    var onFileChunk: (([UInt8]) -> Void)?
    var onProgress: ((Int) -> Void)?
    var onDone: ((Bool) -> Void)?
    var onText: ((String, Int) -> Void)?
    var onControl: ((RealtimeControl) -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?

    func start() {}
    func send(sources: [PlaintextSource], metas: [FileMeta]) {}
    func accept() {}
    func reject() {}
    func complete() {}
    func confirmTextSAS() {}
    func acceptText() {}
    func rejectText() {}
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) { completion(nil) }
    var textBufferedAmount: UInt64 { 0 }
    func close() {}
}

private final class StubPairClient: PairCodeClient, @unchecked Sendable {
    func mint(token: String) async throws -> MintedCode {
        MintedCode(code: "483920", expiresAt: 1800000000)
    }
}

private final class StubICEClient: ICEConfigClient, @unchecked Sendable {
    func fetch(code: String) async throws -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])])
    }
}

/// **The iOS half of `link/1`**: the lifecycle that ends it, the destination it
/// writes into, and the one connection that carries messages and repeated
/// batches at once.
///
/// The wire itself is `LinkWorkspaceModelTests`' subject and is not re-proved
/// here. What these tests own is what iOS added: `ForegroundSessionCoordinator`
/// as the single owner of a backgrounded link, a receive directory that is read
/// rather than resolved, and the reachability claim the Nearby tab now makes.
@MainActor
final class IOSLinkWorkspaceTests: XCTestCase {

    private var dir: URL!
    /// A second directory nothing should ever write into. It stands in for
    /// "whatever an independent re-resolution would have produced".
    private var strayDir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ios-link-\(UUID().uuidString)")
        strayDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ios-link-stray-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: strayDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.removeItem(at: strayDir)
    }

    // MARK: - fixtures

    private final class Rig {
        let model: LinkWorkspaceModel
        let capabilities: PeerCapabilityRegistry
        let channel: FakeWebSocketChannel
        let signaling: SignalingClient
        var transports: [IOSLinkTransport] = []
        /// Every directory an assembled link was handed, in order. The whole
        /// point of the residency test below.
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

    /// `receiveDirectory` is a CLOSURE the test controls, exactly as the app's
    /// is: the app hands over `{ files.saveDirectory }`, and this hands over a
    /// box the test can move, so "read per link rather than captured once" is
    /// something an assertion can distinguish.
    private func rig(requiresVerification: Bool = false,
                     receiveDirectory: @escaping () -> URL,
                     selfId: String = "aaa") -> Rig {
        let capabilities = PeerCapabilityRegistry(
            // The iOS answer for the room iOS actually links in.
            linkRoomActive: { linkRoomActive(isCodelessRoom: true) })
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        channel.fire(Envelope(type: SignalType.welcome, name: selfId))

        var box: Rig?
        let model = LinkWorkspaceModel(
            capabilities: capabilities,
            receiveDirectory: receiveDirectory,
            requiresVerification: { requiresVerification },
            iceClient: nil,
            assemble: { signaling, peerId, role, iceServers, relayOnly, generation,
                        assembledDirectory, admission, initialSignal in
                let transport = IOSLinkTransport()
                box?.transports.append(transport)
                box?.receiveDirectories.append(assembledDirectory)
                return LinkSessionFactory.make(
                    signaling: signaling,
                    peerId: peerId,
                    role: role,
                    iceServers: iceServers,
                    iceTransportPolicy: relayOnly ? .relay : .all,
                    authenticationGeneration: generation,
                    receiveDirectory: assembledDirectory,
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

    private func identity(peerId: String, role: Role = .initiator) -> LinkIdentity {
        LinkIdentity(peerId: peerId, role: role, sas: "424242",
                     codecs: LinkCodecs(sendKey: [UInt8](repeating: 0x41, count: 32),
                                        recvKey: [UInt8](repeating: 0x42, count: 32)),
                     authenticationGeneration: 1)
    }

    private func announceLink(_ rig: Rig, _ peerId: String) {
        rig.capabilities.record(peerId: peerId,
                                signal: .object(["caps": .array([.string(TEXT_CAPABILITY),
                                                                 .string(LINK_CAPABILITY)])]))
    }

    private func announceLegacy(_ rig: Rig, _ peerId: String) {
        rig.capabilities.record(peerId: peerId,
                                signal: .object(["caps": .array([.string(TEXT_CAPABILITY)])]))
    }

    private func settle(_ turns: Int = 12) async {
        for _ in 0..<turns { await Task.yield() }
    }

    @discardableResult
    private func openLink(_ rig: Rig,
                          peerId: String = "zzz",
                          files: [FileMeta] = [],
                          sources: [PlaintextSource] = []) async -> IOSLinkTransport {
        announceLink(rig, peerId)
        XCTAssertTrue(rig.model.connect(peerId: peerId, peerLabel: "Studio Mac",
                                        files: files, sources: sources))
        await settle()
        let transport = rig.transports[0]
        transport.publish(identity(peerId: peerId))
        await settle()
        return transport
    }

    private func legacyModels() -> (RealtimeSessionModel, RealtimeTextSessionModel) {
        let connection = IdleConnection()
        let file = RealtimeSessionModel(pairClient: StubPairClient(), iceClient: StubICEClient(),
                                        requiresVerification: { false },
                                        makeConnection: { _, _, _ in connection })
        let text = RealtimeTextSessionModel(pairClient: StubPairClient(),
                                            iceClient: StubICEClient(),
                                            requiresVerification: { false },
                                            makeConnection: { _, _, _ in connection })
        return (file, text)
    }

    // MARK: - 1. the receive destination is the residency-owned one

    /// **The link writes where residency said this device could write, and it
    /// asks at the moment a link is built rather than at launch.**
    ///
    /// This is the difference between reading `RealtimeSessionModel.saveDirectory`
    /// and calling `ReceiveDestination.directory()` again, and it is not
    /// cosmetic. Residency resolves the folder, installs it on the model, and
    /// refuses to join the room when it cannot — so the model's property is the
    /// value this device was made *reachable* on the strength of. A link with its
    /// own resolver would be a second answer, and the case where the two differ
    /// is exactly the case residency exists for.
    ///
    /// The moving box proves the second half: residency re-runs
    /// `installDestination` on every `.active`, so a folder the user deleted from
    /// the Files app between two foregrounds is recreated — and the NEXT link
    /// must use the new answer, not a URL captured at construction.
    func testEveryLinkIsBuiltWithTheDirectoryTheAppCurrentlyOwns() async {
        var owned = strayDir!
        let rig = rig(receiveDirectory: { owned })
        // The app installs the real destination before this device is reachable.
        owned = dir

        await openLink(rig)
        XCTAssertEqual(rig.receiveDirectories, [dir],
                       "the link was built with a directory captured before residency installed one")

        // A second link, after residency re-resolved to somewhere else.
        let moved = dir.appendingPathComponent("moved")
        try? FileManager.default.createDirectory(at: moved, withIntermediateDirectories: true)
        owned = moved
        rig.model.leave()
        rig.model.dismiss()
        await settle()
        await openLink(rig, peerId: "yyy")
        XCTAssertEqual(rig.receiveDirectories, [dir, moved],
                       "the second link reused the first link's directory")
    }

    // MARK: - 2. backgrounding, and its single owner

    /// **`.background` ends an open link, and says so truthfully.**
    ///
    /// This app declares no `UIBackgroundModes`, so the link's SCTP association
    /// goes with the process's foreground time whatever anybody does. The choice
    /// is between ending it with a sentence and letting the user come back to a
    /// workspace that looks open on a connection that died minutes ago.
    func testBackgroundingEndsAnOpenLinkAndExplainsIt() async {
        let rig = rig(receiveDirectory: { self.dir })
        let transport = await openLink(rig)
        XCTAssertTrue(rig.model.connection.isOpen)

        let (file, text) = legacyModels()
        let coordinator = ForegroundSessionCoordinator(file: file, text: text, link: rig.model)
        coordinator.phaseChanged(to: .background)
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.closed),
                       "the link outlived the foreground it depends on")
        XCTAssertTrue(transport.isClosed, "the transport was left open")
        XCTAssertEqual(coordinator.interruption, L10n.t(.linkInterrupted),
                       "the link ended with no explanation, or with the legacy one")
    }

    /// **`.inactive` does nothing at all** — and on this surface that matters
    /// more than it did for the legacy models, not less.
    ///
    /// The workspace's own file verb opens a document browser, which IS
    /// `.inactive`. An implementation that ended the link there would kill the
    /// connection at the exact moment the user is choosing what to send on it,
    /// every time, on the one surface where choosing happens after connecting.
    func testInactiveNeverTouchesALiveLink() async {
        let rig = rig(receiveDirectory: { self.dir })
        let transport = await openLink(rig)

        let (file, text) = legacyModels()
        let coordinator = ForegroundSessionCoordinator(file: file, text: text, link: rig.model)
        coordinator.phaseChanged(to: .inactive)
        await settle()

        XCTAssertTrue(rig.model.connection.isOpen,
                      "the document picker ended the connection it was opened from")
        XCTAssertFalse(transport.isClosed)
        XCTAssertNil(coordinator.interruption)
    }

    /// An attempt that has not reached a link yet is ended too, and for a reason
    /// that is not symmetry: `requesting` and `establishing` have deadlines
    /// running against a peer that is answering, and leaving one behind means a
    /// peer waiting on an establishment this process cannot finish.
    func testBackgroundingEndsAnAttemptThatNeverBecameALink() async {
        let rig = rig(receiveDirectory: { self.dir })
        announceLink(rig, "zzz")
        XCTAssertTrue(rig.model.connect(peerId: "zzz", peerLabel: "Studio Mac"))
        await settle()
        XCTAssertTrue(rig.model.connection.isActive)
        XCTAssertFalse(rig.model.connection.isOpen)

        let (file, text) = legacyModels()
        let coordinator = ForegroundSessionCoordinator(file: file, text: text, link: rig.model)
        coordinator.phaseChanged(to: .background)
        await settle()

        XCTAssertFalse(rig.model.connection.isActive)
        XCTAssertNotNil(coordinator.interruption)
    }

    /// **A terminal link is left exactly as it is**, for the same reason a
    /// `.completed` receive is: it is holding the transcript, the saved paths of
    /// a committed batch and the reason it ended, and none of that is the app's
    /// to discard because the user checked their notifications. And reporting an
    /// interruption over it would be claiming to have taken away something the
    /// user had already been told about.
    func testBackgroundingLeavesAnAlreadyEndedLinkAndItsResultAlone() async {
        let rig = rig(receiveDirectory: { self.dir })
        await openLink(rig)
        rig.model.leave()
        await settle()
        guard case .ended = rig.model.connection else {
            return XCTFail("got \(rig.model.connection)")
        }

        let (file, text) = legacyModels()
        let coordinator = ForegroundSessionCoordinator(file: file, text: text, link: rig.model)
        coordinator.phaseChanged(to: .background)
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.closed))
        XCTAssertNil(coordinator.interruption,
                     "a finished connection was reported as interrupted")
    }

    /// Nothing running at all: still no notice. Noise is what teaches people to
    /// dismiss the notice that matters.
    func testBackgroundingWithAnIdleLinkSaysNothing() async {
        let rig = rig(receiveDirectory: { self.dir })
        let (file, text) = legacyModels()
        let coordinator = ForegroundSessionCoordinator(file: file, text: text, link: rig.model)
        coordinator.phaseChanged(to: .background)
        await settle()
        XCTAssertNil(coordinator.interruption)
    }

    /// **Leaving the discovery room is not what ends the link, and must not be.**
    ///
    /// `NearbyResidencyCoordinator` stops the room BEFORE handing `.background`
    /// on, so this is the intermediate state the app really passes through. The
    /// model's invariant 2 says a healthy data channel survives signalling loss:
    /// the room going away is reported and nothing is torn down. If that ever
    /// changed, the ordering in residency would silently become the thing that
    /// ends the link, and `ForegroundSessionCoordinator` would stop being its
    /// single owner while every other test here still passed.
    func testLeavingTheRoomReportsTheLossAndEndsNothing() async {
        let rig = rig(receiveDirectory: { self.dir })
        let transport = await openLink(rig)

        rig.model.roomDidDisconnect()
        await settle()

        XCTAssertTrue(rig.model.connection.isOpen,
                      "leaving the discovery room tore down a working connection")
        XCTAssertTrue(rig.model.signalingLost,
                      "the room loss was not reported, so the user is not told it cannot be restored")
        XCTAssertFalse(transport.isClosed)

        // And the coordinator is still the thing that ends it.
        let (file, text) = legacyModels()
        ForegroundSessionCoordinator(file: file, text: text, link: rig.model)
            .phaseChanged(to: .background)
        await settle()
        XCTAssertFalse(rig.model.connection.isActive)
    }

    // MARK: - 3. one connection, both products

    /// **The claim the whole surface makes, as one assertion**: after connecting
    /// once, a message and a file batch both reach the peer on that same link —
    /// no second connection, no second set of digits, and in either order.
    func testOneOpenLinkCarriesAMessageAndRepeatedFileBatches() async {
        let rig = rig(receiveDirectory: { self.dir })
        let transport = await openLink(rig)
        XCTAssertTrue(rig.model.acceptsWork)

        rig.model.send(message: "on the same connection")
        await settle()
        XCTAssertFalse(transport.sent[.text, default: []].isEmpty,
                       "the message never reached the text lane")

        rig.model.send(files: [FileMeta(name: "a.bin", size: 4, path: nil)],
                       sources: [DataSource(name: "a.bin", bytes: [1, 2, 3, 4])])
        await settle()
        XCTAssertEqual(rig.model.fileModel?.batches.count, 1,
                       "the first batch never reached the file lane")

        // The second batch is the part that separates this from the legacy wire:
        // the connection is still open and still verified, so nothing is asked
        // again.
        rig.model.send(files: [FileMeta(name: "b.bin", size: 2, path: nil)],
                       sources: [DataSource(name: "b.bin", bytes: [5, 6])])
        await settle()
        XCTAssertEqual(rig.model.fileModel?.batches.count, 2,
                       "a second batch needed a new connection")
        XCTAssertTrue(rig.model.connection.isOpen, "the link did not survive its own transfers")
        XCTAssertEqual(rig.model.actionError, nil)
    }

    /// **A batch staged before Connect is armed, not sent** — and it is released
    /// once, in full, when the digits are answered.
    ///
    /// This is what keeps iOS's pre-connect picker honest. macOS removed
    /// pre-connect staging entirely; iOS keeps it because its picker is a
    /// full-screen document browser, and the safety property that makes keeping
    /// it acceptable is exactly this: nothing crosses the verification boundary
    /// early.
    func testAPreConnectBatchIsHeldBehindVerificationAndThenReleased() async {
        let rig = rig(requiresVerification: true, receiveDirectory: { self.dir })
        await openLink(rig,
                       files: [FileMeta(name: "staged.bin", size: 3, path: nil)],
                       sources: [DataSource(name: "staged.bin", bytes: [7, 8, 9])])

        XCTAssertTrue(rig.model.isVerificationPending)
        XCTAssertEqual(rig.model.armedFiles.count, 1,
                       "the staged batch was dropped rather than held")
        XCTAssertTrue(rig.model.fileModel?.batches.isEmpty ?? true,
                      "a staged batch reached the lane before the digits were compared")
        XCTAssertFalse(rig.model.acceptsWork)

        rig.model.confirmSAS()
        await settle()

        XCTAssertTrue(rig.model.armedFiles.isEmpty, "the batch is still armed after confirmation")
        XCTAssertEqual(rig.model.fileModel?.batches.count, 1,
                       "the batch the user staged was never sent")
    }

    // MARK: - 4. the legacy boundary is untouched

    /// **A peer that never announced exact `link/1` is not part of this feature
    /// at all**, on iOS exactly as on macOS: `canLink` is false, `connect`
    /// refuses, nothing is assembled, and the Nearby tab's shipped legacy paths
    /// own that device.
    ///
    /// It is the same assertion `LinkWorkspaceModelTests` makes about the wire,
    /// repeated here because iOS is the platform where it is newly load-bearing:
    /// this build previously could not link at all, so every peer took the
    /// legacy path by construction, and nothing but this boundary keeps that
    /// true for the peers that still need it.
    func testALegacyPeerIsNeverOfferedALinkAndTheSurfaceKnowsIt() async {
        let rig = rig(receiveDirectory: { self.dir })
        announceLegacy(rig, "old")

        XCTAssertFalse(rig.model.canLink(peerId: "old"))
        XCTAssertFalse(rig.model.connect(peerId: "old", peerLabel: "Old Phone"))
        await settle()
        XCTAssertTrue(rig.model.transportsWereNeverBuilt(rig.transports.count))
        XCTAssertFalse(rig.model.hasSession,
                       "a refused link claimed the surface a legacy session needs")

        // And the tab draws the legacy verbs for it, from the roster's own fact.
        let legacyDevice = NearbyDevice(id: "old", name: "Old Phone", label: "Old Phone",
                                        supportsLink: false, announcesLegacyText: true)
        XCTAssertEqual(NearbyConnectPresentation.sendChoice(for: legacyDevice), .legacyLanes)
        XCTAssertEqual(NearbyConnectPresentation.legacyMode(for: legacyDevice,
                                                            hasStagedBatch: false), .text)
    }

    /// A peer announcing a DIFFERENT version is legacy too. Exactness is the
    /// whole downgrade boundary and this platform must not soften it.
    func testANeighbouringLinkVersionIsNotThisOne() async {
        let rig = rig(receiveDirectory: { self.dir })
        rig.capabilities.record(peerId: "next",
                                signal: .object(["caps": .array([.string(TEXT_CAPABILITY),
                                                                 .string("link/2")])]))
        XCTAssertFalse(rig.model.canLink(peerId: "next"))
        XCTAssertFalse(rig.model.connect(peerId: "next", peerLabel: "Future"))
        await settle()
        XCTAssertTrue(rig.transports.isEmpty)
    }
}

private extension LinkWorkspaceModel {
    /// Readability helper: a refusal must assemble nothing at all.
    func transportsWereNeverBuilt(_ count: Int) -> Bool { count == 0 }
}
