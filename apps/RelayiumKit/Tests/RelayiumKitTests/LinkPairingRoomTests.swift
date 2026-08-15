import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **The pairing-code half of the unified Workspace**, which is the half with
/// something to lose.
///
/// A same-network room is code-less, STUN-only and already owned by
/// `LanDiscoveryModel`; a code room is none of those. It has a socket this
/// process opens itself, TURN credentials that expire, and a peer that may turn
/// out to speak the older wire after this side has already joined. Every test
/// here is one of those three going wrong.
@MainActor
final class LinkPairingRoomTests: XCTestCase {

    // MARK: - doubles

    /// Fires nothing until a test says so, and records what it was asked to
    /// wait for. Three different bounds are armed in this room — the capability
    /// window, the relay warning and the relay deadline — and telling them apart
    /// by delay is what lets a test drive one without the others.
    private final class ManualScheduler: LinkRecoveryScheduler, @unchecked Sendable {
        private let lock = NSLock()
        private var pending: [(delay: TimeInterval, body: () -> Void, cancelled: Box)] = []

        final class Box: @unchecked Sendable {
            private let lock = NSLock()
            private var value = false
            var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return value }
            func cancel() { lock.lock(); value = true; lock.unlock() }
        }

        private final class Handle: LinkRecoveryTimer {
            let box: Box
            init(box: Box) { self.box = box }
            func cancel() { box.cancel() }
        }

        var delays: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return pending.map(\.delay) }

        func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
            let box = Box()
            lock.lock(); pending.append((delay, body, box)); lock.unlock()
            return Handle(box: box)
        }

        /// Fire every live timer whose delay is at most `delay`, once.
        func advance(to delay: TimeInterval) {
            lock.lock()
            let due = pending.filter { $0.delay <= delay && !$0.cancelled.isCancelled }
            pending.removeAll { $0.delay <= delay }
            lock.unlock()
            for item in due { item.body() }
        }
    }

    private final class StubICEClient: ICEConfigClient, @unchecked Sendable {
        let config: ICEConfig
        private let lock = NSLock()
        private var _codes: [String] = []
        var codes: [String] { lock.lock(); defer { lock.unlock() }; return _codes }

        init(config: ICEConfig) { self.config = config }

        func fetch(code: String) async throws -> ICEConfig {
            lock.lock(); _codes.append(code); lock.unlock()
            return config
        }
    }

    private final class PairingTransport: LinkRoutableInitialTransport, @unchecked Sendable {
        private let slots = NSLock()
        private let state = NSLock()
        private var _onSAS: ((String) -> Void)?
        private var _onReady: ((LinkIdentity) -> Void)?
        private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
        private var _onError: ((Error) -> Void)?
        private var _onClose: (() -> Void)?
        private var _closed = false
        private var _sent: [LinkLane: [[UInt8]]] = [:]

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

        var sent: [LinkLane: [[UInt8]]] { state.lock(); defer { state.unlock() }; return _sent }
        var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }

        func start() {}
        func receive(from: String, signal: JSONValue) {}
        func send(_ bytes: [UInt8], on lane: LinkLane) throws {
            state.lock(); _sent[lane, default: []].append(bytes); state.unlock()
        }
        func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
        func close() { state.lock(); _closed = true; state.unlock() }

        func publish(peerId: String, role: Role, sas: String = "424242") {
            onSAS?(sas)
            onReady?(LinkIdentity(peerId: peerId, role: role, sas: sas,
                                  codecs: LinkCodecs(sendKey: [UInt8](repeating: 3, count: 32),
                                                     recvKey: [UInt8](repeating: 4, count: 32)),
                                  authenticationGeneration: 1))
        }
    }

    // MARK: - the room under test

    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-pairing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// An `/api/ice` answer for a code: a real relay, with a TURN REST username
    /// whose expiry is `expiresIn` seconds from `now`.
    private func relayedConfig(expiresIn: TimeInterval, now: Date) -> ICEConfig {
        let expiry = Int(now.addingTimeInterval(expiresIn).timeIntervalSince1970)
        return ICEConfig(iceServers: [
            ICEServerConfig(urls: ["stun:stun.relayium.test:3478"]),
            ICEServerConfig(urls: ["turn:relay.relayium.test:3478"],
                            username: "\(expiry):tok", credential: "secret"),
        ])
    }

    private func stunOnlyConfig() -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:stun.relayium.test:3478"])])
    }

    private final class Rig {
        let model: LinkWorkspaceModel
        let scheduler: ManualScheduler
        let ice: StubICEClient
        let handle: LinkRoomHandle
        var channels: [FakeWebSocketChannel] = []
        var sockets: [SignalingClient] = []
        var joinedCodes: [String] = []
        var transports: [PairingTransport] = []
        var relayOnly: [Bool] = []
        var adopted: [(peerId: String, role: Role, mode: TransferMode)] = []
        var handedBackBatches: [[FileMeta]] = []
        var pairingLinkActivations = 0

        init(model: LinkWorkspaceModel, scheduler: ManualScheduler,
             ice: StubICEClient, handle: LinkRoomHandle) {
            self.model = model
            self.scheduler = scheduler
            self.ice = ice
            self.handle = handle
        }

        /// The room's socket as the hub would drive it.
        func welcome(_ selfId: String) {
            channels[0].fire(Envelope(type: SignalType.welcome, name: selfId))
        }

        func roster(_ ids: [String]) {
            channels[0].fire(Envelope(type: SignalType.peers,
                                      peers: ids.map { Peer(id: $0, name: "peer") }))
        }

        func announce(_ peerId: String, _ caps: [String]) {
            channels[0].fire(Envelope(type: SignalType.signal, from: peerId,
                                      data: .object(["caps": .array(caps.map(JSONValue.string))])))
        }
    }

    private func rig(config: ICEConfig,
                     requiresVerification: Bool = false,
                     selfId: String = "aaa-mac",
                     now: Date = Date(timeIntervalSince1970: 1_000_000)) -> Rig {
        let scheduler = ManualScheduler()
        let ice = StubICEClient(config: config)
        let handle = LinkRoomHandle()
        let dir = self.dir!
        var box: Rig?
        let model = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { dir },
            requiresVerification: { requiresVerification },
            iceClient: ice,
            connectPairingSocket: { code in
                let channel = FakeWebSocketChannel()
                let socket = SignalingClient(channel: channel, name: "Mac")
                channel.fireOpen()
                box?.channels.append(channel)
                box?.sockets.append(socket)
                box?.joinedCodes.append(code)
                return socket
            },
            pairingRoomHandle: handle,
            scheduler: scheduler,
            now: { now },
            assemble: { signaling, peerId, role, servers, relayOnly, generation,
                        directory, admission, signal in
                let transport = PairingTransport()
                box?.transports.append(transport)
                box?.relayOnly.append(relayOnly)
                return LinkSessionFactory.make(
                    signaling: signaling, peerId: peerId, role: role, iceServers: servers,
                    iceTransportPolicy: relayOnly ? .relay : .all,
                    authenticationGeneration: generation,
                    receiveDirectory: directory, admission: admission,
                    deadlines: LinkDeadlines(), initialSignal: signal,
                    buildInitialTransport: { _, _, _, _, _, _, _ in transport },
                    buildReplacementFactory: { _, _, _, _ in
                        { _ in throw LinkTransportError.notReady }
                    })
            })
        let rig = Rig(model: model, scheduler: scheduler, ice: ice, handle: handle)
        box = rig
        model.adoptLegacyRoom = { peerId, role, _, mode in
            rig.adopted.append((peerId, role, mode))
        }
        model.onLegacyFallbackBatch = { metas, _ in rig.handedBackBatches.append(metas) }
        model.onPairingLinkActivated = { rig.pairingLinkActivations += 1 }
        // The self id makes this side the SMALLER of the two, so it offers and
        // assembles as soon as the peer announces — the deterministic role rule,
        // not a preference. A larger self id would leave the room `requesting`
        // until the peer's own offer arrived, which is a different test.
        _ = selfId
        return rig
    }

    private func settle(_ turns: Int = 14) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// Join a code, greet a peer that speaks `link/1`, and open the link.
    @discardableResult
    private func openPairedLink(_ rig: Rig,
                                code: String = "AB12CD",
                                peer: String = "zzz-web",
                                legacyRole: Role = .responder,
                                files: [FileMeta] = [],
                                sources: [PlaintextSource] = []) async -> PairingTransport? {
        XCTAssertTrue(rig.model.watchPairingCode(code, legacyRole: legacyRole,
                                                 files: files, sources: sources))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce(peer, [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster([peer])
        await settle()
        guard let transport = rig.transports.first else { return nil }
        transport.publish(peerId: peer, role: .responder)
        await settle()
        return transport
    }

    // MARK: - 1. the room is joined, and it is ONE socket

    func testWatchingACodeJoinsExactlyOneRoomForThatCode() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()

        XCTAssertEqual(rig.joinedCodes, ["AB12CD"], "one socket, for that code")
        XCTAssertEqual(rig.ice.codes, ["AB12CD"],
                       "the ICE configuration is fetched WITH the code, which is what earns TURN")
        XCTAssertEqual(rig.model.connection, .watching(code: "AB12CD"))
        XCTAssertFalse(rig.model.hasSession,
                       "a watched code is not a session: the pairing surface stays on screen")
    }

    func testASecondCodeIsRefusedWhileOneIsWatched() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        XCTAssertFalse(rig.model.watchPairingCode("EF34GH", legacyRole: .initiator))
        await settle()
        XCTAssertEqual(rig.joinedCodes, ["AB12CD"])
    }

    func testACodeWithNoICEConfigurationIsRefusedTruthfully() async {
        final class FailingICE: ICEConfigClient, @unchecked Sendable {
            func fetch(code: String) async throws -> ICEConfig { throw NearbyError.notScanning }
        }
        let dir = self.dir!
        let model = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { dir }, requiresVerification: { false },
            iceClient: FailingICE(),
            connectPairingSocket: { _ in
                XCTFail("no socket may be opened for a code with no configuration")
                return SignalingClient(channel: FakeWebSocketChannel(), name: "Mac")
            },
            assemble: { _, _, _, _, _, _, _, _, _ in
                XCTFail("nothing may be assembled")
                fatalError()
            })
        XCTAssertTrue(model.watchPairingCode("AB12CD", legacyRole: .initiator))
        for _ in 0..<14 { await Task.yield() }
        XCTAssertEqual(model.connection, .ended(.roomUnavailable))
    }

    // MARK: - 2. exact capability, in a code room

    /// The peer announced exact `link/1`: the unified link, in a pairing room.
    func testAPeerThatAnnouncesLinkGetsAUnifiedLinkOverTheCode() async {
        let rig = rig(config: stunOnlyConfig())
        let transport = await openPairedLink(rig)

        XCTAssertNotNil(transport)
        XCTAssertTrue(rig.model.connection.isOpen)
        XCTAssertTrue(rig.adopted.isEmpty, "the legacy path must not have been handed the room")
        XCTAssertEqual(rig.transports.count, 1)
        XCTAssertEqual(rig.pairingLinkActivations, 1,
                       "the code-rendering legacy model was not retired exactly once")
    }

    /// **Capability stripping in a code room.** A relay that removes the
    /// announcement denies the feature; it must never produce a link the peer is
    /// not in. What happens instead is the legacy path, on the SAME socket.
    func testAStrippedAnnouncementFallsBackToLegacyOnTheSameSocket() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])          // present, and silent: the hello was stripped
        await settle()
        XCTAssertTrue(rig.adopted.isEmpty, "the window has not elapsed yet")

        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()

        XCTAssertEqual(rig.adopted.map(\.peerId), ["zzz-web"])
        XCTAssertEqual(rig.adopted.map(\.role), [.responder], "the verb the user pressed")
        XCTAssertEqual(rig.adopted.map(\.mode), [.files])
        XCTAssertEqual(rig.pairingLinkActivations, 0,
                       "a legacy fallback was mistaken for a unified link")
        XCTAssertTrue(rig.transports.isEmpty, "no link may be assembled for a silent peer")
        XCTAssertEqual(rig.joinedCodes.count, 1, "and no second socket was opened")
        XCTAssertTrue(rig.handle.signaling === rig.sockets[0],
                      "the legacy connection is built on the socket that joined the code")
        XCTAssertFalse(rig.channels[0].closed,
                       "closing it would strand a creator that had already offered")
    }

    /// A peer that announced `text/1` and nothing else is decided immediately —
    /// the answer is already known, so the window is not worth waiting out.
    func testATextOnlyPeerFallsBackWithoutWaitingOutTheWindow() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertEqual(rig.adopted.map(\.peerId), ["zzz-web"])
        XCTAssertEqual(rig.adopted.map(\.mode), [.text])
        XCTAssertTrue(rig.transports.isEmpty)
    }

    /// `link/2` is a different wire. A peer announcing it is legacy here.
    func testALaterProtocolVersionIsNotReadAsThisOne() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, "link/2"])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertEqual(rig.adopted.count, 1, "link/2 must not be read as link/1")
        XCTAssertTrue(rig.transports.isEmpty)
    }

    /// A batch armed before the room resolved is handed BACK when the room turns
    /// out to be legacy — not dropped, and not sent twice.
    func testAnArmedBatchIsHandedBackToTheLegacyPath() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode(
            "AB12CD", legacyRole: .initiator,
            files: [FileMeta(name: "a.bin", size: 8, path: nil)],
            sources: [DataSource(name: "a.bin", bytes: [1, 2, 3, 4, 5, 6, 7, 8])]))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertEqual(rig.handedBackBatches.map { $0.map(\.name) }, [["a.bin"]])
        XCTAssertTrue(rig.model.armedFiles.isEmpty, "the model may not keep a copy it will not send")
    }

    // MARK: - 2b. which legacy lane, decided from evidence

    /// **A staged batch outranks anything the peer announced.**
    ///
    /// This is the case the removed "create a code for files" button used to
    /// carry, and it is the one the user's own action already answers: they
    /// picked files. A text lane cannot carry a file at all, so an announcement
    /// of `text/1` must not talk this side out of the only lane that can.
    ///
    /// The peer here announces `text/1` — which is what a stale Web tab does
    /// unconditionally, whatever its user is doing — so this is exactly the
    /// input that would flip the decision if the announcement were weighed
    /// first.
    func testAnArmedBatchDecidesTheLegacyLaneWhateverThePeerAnnounced() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode(
            "AB12CD", legacyRole: .initiator,
            files: [FileMeta(name: "a.bin", size: 8, path: nil)],
            sources: [DataSource(name: "a.bin", bytes: [1, 2, 3, 4, 5, 6, 7, 8])]))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertEqual(rig.adopted.map(\.mode), [.files],
                       "a staged batch was handed to a lane that cannot carry it")
        // And the batch went with it, so the lane that was chosen for it has it.
        XCTAssertEqual(rig.handedBackBatches.map { $0.map(\.name) }, [["a.bin"]])
    }

    /// With nothing staged, the peer's own announcement decides — and `text/1`
    /// is a statement rather than a guess. On the shipped native wire it is sent
    /// only BY a text session (`RealtimeConnectionFactory.Mode.file` announces
    /// nothing at all), so answering it with a text lane is answering what the
    /// peer said it is doing.
    func testWithNothingStagedAnAnnouncedTextPeerDecidesTheLane() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertEqual(rig.adopted.map(\.mode), [.text])
        XCTAssertTrue(rig.handedBackBatches.flatMap { $0 }.isEmpty)
    }

    /// **Silence means files, and that is a reading rather than a default.**
    ///
    /// A legacy peer that announces nothing is a FILE peer by construction: the
    /// text path announces `text/1` and refuses to build without it, so a peer
    /// running one would have said so. Answering silence with a text offer would
    /// guarantee the mismatch this decision exists to avoid, and the file lane
    /// carries bytes in either direction, so it is also the answer that
    /// forecloses least.
    func testASilentLegacyPeerIsReadAsAFilePeer() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()
        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()

        XCTAssertEqual(rig.adopted.map(\.mode), [.files])
    }

    /// The decision is never the caller's, in either direction. Creating and
    /// joining reach the same rule with the same evidence and get the same
    /// answer; only the legacy ROLE differs, because which action the user took
    /// is a fact rather than a question.
    func testTheLegacyLaneDoesNotDependOnWhichActionOpenedTheRoom() async {
        for role in [Role.initiator, .responder] {
            let rig = rig(config: stunOnlyConfig())
            XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: role))
            await settle()
            rig.welcome("aaa-mac")
            rig.announce("zzz-web", [TEXT_CAPABILITY])
            rig.roster(["zzz-web"])
            await settle()

            XCTAssertEqual(rig.adopted.map(\.mode), [.text],
                           "\(role) got a different lane from the same evidence")
            XCTAssertEqual(rig.adopted.map(\.role), [role],
                           "the fallback lost the verb the user actually pressed")
        }
    }

    // MARK: - 3. the TURN credential's lifetime

    func testARelayedRoomDerivesItsBoundFromTheIssuedCredential() async {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let rig = rig(config: relayedConfig(expiresIn: 3600, now: now), now: now)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()

        let deadline = rig.model.relayDeadline
        XCTAssertEqual(deadline?.expiresAt, now.addingTimeInterval(3600))
        XCTAssertEqual(deadline?.deadlineAt, now.addingTimeInterval(3600 - TURN_CLOCK_SKEW))
        XCTAssertEqual(deadline?.warnAt,
                       now.addingTimeInterval(3600 - TURN_CLOCK_SKEW - RELAY_DEADLINE_WARN))
        XCTAssertTrue(rig.relayOnly.isEmpty, "nothing is assembled yet")
    }

    /// A relayed room builds its link relay-only, exactly as `make` does: a
    /// cross-network connection that spends the ICE timeout on direct candidates
    /// first is one that fails slowly.
    func testARelayedRoomBuildsItsLinkRelayOnly() async {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let rig = rig(config: relayedConfig(expiresIn: 3600, now: now), now: now)
        _ = await openPairedLink(rig)
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// A STUN-only code has no allocation to lose, so it gets no bound and no
    /// relay-only policy. Reading one out of a STUN entry would impose a
    /// deadline on a link that never relays.
    func testAStunOnlyRoomHasNoBoundAndIsNotRelayOnly() async {
        let rig = rig(config: stunOnlyConfig())
        _ = await openPairedLink(rig)
        XCTAssertNil(rig.model.relayDeadline)
        XCTAssertEqual(rig.relayOnly, [false])
    }

    func testTheRelayWarningFiresBeforeTheBoundAndTheLinkStaysUsable() async {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let rig = rig(config: relayedConfig(expiresIn: 3600, now: now), now: now)
        _ = await openPairedLink(rig)
        XCTAssertFalse(rig.model.relayExpiringSoon)

        rig.scheduler.advance(to: 3600 - TURN_CLOCK_SKEW - RELAY_DEADLINE_WARN)
        await settle()

        XCTAssertTrue(rig.model.relayExpiringSoon, "the user is told while they can still act")
        XCTAssertTrue(rig.model.connection.isOpen, "and the link still works")
        XCTAssertTrue(rig.model.acceptsWork)
    }

    /// **The bound itself.** The link is terminal BEFORE the credential dies,
    /// with a reason of its own — not `failed`, because nothing went wrong.
    func testTheRelayedLinkIsTerminalAtItsBound() async {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let rig = rig(config: relayedConfig(expiresIn: 3600, now: now), now: now)
        let transport = await openPairedLink(rig)

        rig.scheduler.advance(to: 3600 - TURN_CLOCK_SKEW)
        await settle()

        XCTAssertEqual(rig.model.connection, .ended(.relayExpired))
        XCTAssertFalse(rig.model.acceptsWork)
        XCTAssertEqual(transport?.isClosed, true)
    }

    /// An already-expired credential is a real state — a badly-set clock, or a
    /// configuration held far too long — and the truthful answer is an immediate
    /// terminal one rather than an unbounded link.
    func testAnAlreadyExpiredCredentialClampsToNow() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let config = relayedConfig(expiresIn: -600, now: now)
        let deadline = relayDeadline(for: config, now: now)
        XCTAssertEqual(deadline?.deadlineAt, now)
        XCTAssertEqual(deadline?.warnAt, now)
    }

    /// The EARLIEST credential bounds the link: the pool hands out one per relay
    /// and ICE decides which carries it, so the one that dies first is the only
    /// honest bound.
    func testTheEarliestCredentialInThePoolWins() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let soon = Int(now.addingTimeInterval(600).timeIntervalSince1970)
        let later = Int(now.addingTimeInterval(7200).timeIntervalSince1970)
        let config = ICEConfig(
            iceServers: [ICEServerConfig(urls: ["turn:a.test:3478"],
                                         username: "\(later):tok", credential: "s")],
            relays: [RelayEntry(id: "r2", iceServers: [
                ICEServerConfig(urls: ["turn:b.test:3478"],
                                username: "\(soon):tok", credential: "s")])])
        XCTAssertEqual(relayDeadline(for: config, now: now)?.expiresAt,
                       now.addingTimeInterval(600))
    }

    /// A hostile or malformed `/api/ice` body must not invent a deadline. Only a
    /// TURN entry with an all-digit REST prefix counts.
    func testNoDeadlineIsInventedFromNoiseOrFromStun() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let noise = ICEConfig(iceServers: [
            // STUN with a credential that LOOKS like a REST username.
            ICEServerConfig(urls: ["stun:a.test:3478"], username: "1000600:tok", credential: "s"),
            // TURN with usernames that are not REST usernames.
            ICEServerConfig(urls: ["turn:b.test:3478"], username: "notanumber:tok", credential: "s"),
            ICEServerConfig(urls: ["turn:c.test:3478"], username: ":tok", credential: "s"),
            ICEServerConfig(urls: ["turn:d.test:3478"], username: "0:tok", credential: "s"),
            ICEServerConfig(urls: ["turn:e.test:3478"], username: " 12 :tok", credential: "s"),
        ])
        XCTAssertNil(relayDeadline(for: noise, now: now))
        // …and one valid sibling is still honoured rather than dropped with them.
        let mixed = ICEConfig(iceServers: noise.iceServers + [
            ICEServerConfig(urls: ["turn:f.test:3478"],
                            username: "\(Int(now.timeIntervalSince1970) + 900):tok",
                            credential: "s"),
        ])
        XCTAssertEqual(relayDeadline(for: mixed, now: now)?.expiresAt,
                       now.addingTimeInterval(900))
    }

    // MARK: - 4. the same guarantees the same-network link has

    /// One SAS, then repeated work — over a pairing code, with the preselected
    /// batch held behind the digits.
    func testOneVerificationThenRepeatedBatchesOverAPairingCode() async throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let rig = rig(config: relayedConfig(expiresIn: 3600, now: now),
                      requiresVerification: true, now: now)
        let opened = await openPairedLink(
            rig,
            files: [FileMeta(name: "held.bin", size: 8, path: nil)],
            sources: [DataSource(name: "held.bin", bytes: [1, 2, 3, 4, 5, 6, 7, 8])])
        let transport = try XCTUnwrap(opened)

        XCTAssertEqual(rig.model.verification, .pending(sas: "424242"))
        XCTAssertEqual(rig.model.armedFiles.map(\.name), ["held.bin"])
        XCTAssertNil(transport.sent[.file], "nothing leaves a code room before the digits either")

        rig.model.confirmSAS()
        await settle()
        rig.model.send(files: [FileMeta(name: "b.bin", size: 8, path: nil)],
                       sources: [DataSource(name: "b.bin", bytes: [1, 2, 3, 4, 5, 6, 7, 8])])
        rig.model.send(message: "and a message")
        await settle()

        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.map(\.files.first?.name),
                       ["held.bin", "b.bin"])
        XCTAssertEqual(rig.model.verification, .confirmed, "one verification for the whole link")
        XCTAssertEqual(transport.sent[.text]?.first, [LINK_TEXT_REQUEST])
        XCTAssertEqual(rig.joinedCodes.count, 1, "and no second code was needed")
    }

    /// Cancel and re-arm, behind the digits, in a code room.
    func testAnArmedBatchCanBeCancelledAndReArmedOverAPairingCode() async throws {
        let rig = rig(config: stunOnlyConfig(), requiresVerification: true)
        let opened = await openPairedLink(
            rig,
            files: [FileMeta(name: "wrong.bin", size: 4, path: nil)],
            sources: [DataSource(name: "wrong.bin", bytes: [1, 2, 3, 4])])
        let transport = try XCTUnwrap(opened)

        rig.model.cancelArmedBatch()
        XCTAssertTrue(rig.model.armedFiles.isEmpty)
        rig.model.send(files: [FileMeta(name: "right.bin", size: 4, path: nil)],
                       sources: [DataSource(name: "right.bin", bytes: [5, 6, 7, 8])])
        XCTAssertEqual(rig.model.armedFiles.map(\.name), ["right.bin"])
        XCTAssertNil(transport.sent[.file])

        rig.model.confirmSAS()
        await settle()
        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.map(\.files.first?.name),
                       ["right.bin"])
    }

    /// The room's socket dying does not kill a healthy link — and new work still
    /// goes over it afterwards.
    func testAHealthyPairedLinkSurvivesItsRoomSocket() async throws {
        let rig = rig(config: stunOnlyConfig())
        let opened = await openPairedLink(rig)
        let transport = try XCTUnwrap(opened)

        rig.channels[0].fireRemoteClose()
        await settle()

        XCTAssertTrue(rig.model.connection.isOpen)
        XCTAssertTrue(rig.model.signalingLost)
        XCTAssertFalse(transport.isClosed)

        rig.model.send(message: "still here")
        await settle()
        XCTAssertEqual(transport.sent[.text]?.first, [LINK_TEXT_REQUEST])
    }

    /// The same loss BEFORE anything published cannot finish, and says so.
    func testARoomSocketLostBeforePublicationFailsClosed() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertTrue(rig.model.connection.isActive)

        rig.channels[0].fireRemoteClose()
        await settle()
        XCTAssertEqual(rig.model.connection, .ended(.roomLost))
    }

    /// A frame attributed to a peer this room has already resolved a link for
    /// cannot take the room from underneath it.
    func testASecondPeerCannotTakeAResolvedPairingRoom() async throws {
        let rig = rig(config: stunOnlyConfig())
        let opened = await openPairedLink(rig)
        XCTAssertNotNil(opened)

        rig.announce("zzzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web", "zzzz-web"])
        await settle()

        XCTAssertEqual(rig.transports.count, 1, "one link, one room")
        XCTAssertTrue(rig.adopted.isEmpty, "and no fallback for a peer that arrived late")
    }

    /// A peer decided once is decided once: a second roster frame naming it must
    /// not arm a second capability window or a second fallback.
    func testARepeatedRosterFrameDoesNotDecideAPeerTwice() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        rig.roster(["zzz-web"])
        rig.roster(["zzz-web"])
        await settle()

        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()
        XCTAssertEqual(rig.adopted.count, 1, "one fallback, whatever the roster repeated")
    }

    // MARK: - 5. the same-network room has no say over a code room
    //
    // `LinkWorkspaceModel` is registered as a `NearbyRoomObserver` on
    // `LanDiscoveryModel` for the whole life of the process, and that model
    // announces its roster to every observer without knowing which room the
    // workspace is actually routing. Once a code owns the router, those
    // announcements name ids from the OTHER room — and
    // `LinkRoomRouter.rosterChanged` cancels a request whose target is absent
    // from the roster it is handed. A same-network roster never contains a
    // pairing peer, so before this was isolated one ordinary LAN refresh
    // cancelled a macOS-to-Web pairing request that was still waiting for its
    // offer. Every test here is that, and its mirror: the code room's OWN
    // callbacks must keep working.

    /// Drive a code room to `requesting`, which is the state the cancellation
    /// destroyed.
    ///
    /// The self id is the LARGER of the two, so this side may not offer: it asks
    /// and waits for the peer's offer inside the router's bound. That wait is the
    /// whole window, and it is the one a roster frame can close.
    private func requestingPairedLink(_ rig: Rig,
                                      code: String = "AB12CD",
                                      peer: String = "aaa-web") async {
        XCTAssertTrue(rig.model.watchPairingCode(code, legacyRole: .responder))
        await settle()
        rig.welcome("zzz-mac")
        rig.announce(peer, [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster([peer])
        await settle()
        XCTAssertEqual(rig.model.connection, .requesting,
                       "the larger id must be asking, not offering")
    }

    /// **The reproduced defect.** Same-network roster churn while a code room is
    /// asking for its link.
    ///
    /// The three frames are exactly what `LanDiscoveryModel.refresh` announces:
    /// a room with another device in it, the empty list a reconnecting or
    /// just-joined room publishes, and a room that gained one. None of them says
    /// anything about the peer behind the code.
    func testLanRosterChurnCannotCancelAPairingRequest() async {
        let rig = rig(config: stunOnlyConfig())
        await requestingPairedLink(rig)

        for _ in 0..<3 {
            rig.model.roomRosterChanged(peerIds: ["lan-phone"])
            rig.model.roomRosterChanged(peerIds: [])
            rig.model.roomRosterChanged(peerIds: ["lan-phone", "lan-ipad"])
            await settle()
        }

        XCTAssertEqual(rig.model.connection, .requesting,
                       "a same-network roster cancelled a request it names nobody in")
        XCTAssertTrue(rig.transports.isEmpty, "nothing was established either way")
        XCTAssertTrue(rig.adopted.isEmpty, "and the room was not handed to the legacy path")
    }

    /// The same isolation for the frame that IS authority — in the room it came
    /// from. A departure announced by the same-network room says nothing about a
    /// peer in a code room, and the ids are not even comparable across the two:
    /// this test uses the SAME string in both rooms, which is the worst case.
    func testALanDepartureCannotEndAPairingRequestButTheCodeRoomsOwnDoes() async {
        let rig = rig(config: stunOnlyConfig())
        await requestingPairedLink(rig)

        rig.model.roomPeerLeft("aaa-web")
        rig.model.roomPeerLeft("lan-phone")
        await settle()
        XCTAssertEqual(rig.model.connection, .requesting,
                       "a departure from the same-network room ended a pairing request")

        // …and the code room's own socket still has exactly that authority. This
        // is the private `onPeerLeft` installed by `openPairingRoom`, driven as
        // the hub drives it.
        rig.channels[0].fireText(#"{"type":"left","peer":"aaa-web"}"#)
        await settle()
        XCTAssertEqual(rig.model.connection, .ended(.closed),
                       "the code room's own departure frame must still end its request")
    }

    /// After the link is OPEN, which is the other half of the churn window: the
    /// LAN room keeps refreshing for as long as the app is resident, and a
    /// departure frame there would relinquish the establishment bound to that id.
    func testLanRosterChurnCannotDisturbAnOpenPairedLink() async throws {
        let rig = rig(config: stunOnlyConfig())
        let opened = await openPairedLink(rig)
        let transport = try XCTUnwrap(opened)
        XCTAssertTrue(rig.model.connection.isOpen)

        rig.model.roomRosterChanged(peerIds: [])
        rig.model.roomRosterChanged(peerIds: ["lan-phone"])
        rig.model.roomPeerLeft("zzz-web")
        await settle()

        XCTAssertTrue(rig.model.connection.isOpen,
                      "same-network churn tore down a link established over a code")
        XCTAssertFalse(transport.isClosed)
        XCTAssertTrue(rig.model.acceptsWork)

        // Still a working link, not merely an undisturbed label.
        rig.model.send(message: "still here")
        await settle()
        XCTAssertEqual(transport.sent[.text]?.first, [LINK_TEXT_REQUEST])
    }

    /// The other direction: the code room's own roster frames still decide its
    /// peers. What is dropped is the announcement from a room that has no say —
    /// never the one from the room being routed.
    func testThePairingRoomsOwnRosterStillDecidesItsPeers() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")

        // Same-network churn interleaved with the code room's own frames.
        rig.model.roomRosterChanged(peerIds: ["lan-phone"])
        rig.roster(["zzz-web"])          // present, and silent: the private path
        rig.model.roomRosterChanged(peerIds: [])
        await settle()

        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()

        XCTAssertEqual(rig.adopted.map(\.peerId), ["zzz-web"],
                       "the code room's own roster no longer arms its capability window")
    }

    /// **The production path, end to end.** The three tests above call the
    /// observer methods directly; this one drives a real `LanDiscoveryModel`
    /// through a real socket, exactly as the app wires it — LAN residency first,
    /// then a code — so the isolation is proved against the announcement the
    /// product actually produces rather than against a hand-made call.
    func testARealLanRoomRefreshingUnderneathCannotCancelAPairingRequest() async {
        let rig = rig(config: stunOnlyConfig())
        let lan = FakeWebSocketChannel()
        let discovery = LanDiscoveryModel(connect: {
            let client = SignalingClient(channel: lan, name: "Mac")
            lan.fireOpen()
            return client
        })
        discovery.addRoomObserver(rig.model)
        discovery.start()
        lan.fireText(#"{"type":"welcome","name":"lan-self","ip":"1.2.3.4"}"#)
        lan.fireText(#"{"type":"peers","peers":[{"id":"lan-self","name":"Mac"},{"id":"lan-phone","name":"Phone"}]}"#)
        await settle()
        XCTAssertEqual(discovery.devices.map(\.id), ["lan-phone"],
                       "the same-network room must really be live and observed")

        await requestingPairedLink(rig)

        // A device joins, a device leaves, and the room empties — every one of
        // which calls `refresh()` and announces a roster to every observer.
        lan.fireText(#"{"type":"peers","peers":[{"id":"lan-self","name":"Mac"},{"id":"lan-phone","name":"Phone"},{"id":"lan-ipad","name":"iPad"}]}"#)
        lan.fireText(#"{"type":"peers","peers":[{"id":"lan-self","name":"Mac"}]}"#)
        lan.fireText(#"{"type":"left","peer":"lan-phone"}"#)
        lan.fireText(#"{"type":"peers","peers":[{"id":"lan-self","name":"Mac"},{"id":"lan-phone","name":"Phone"}]}"#)
        await settle()

        XCTAssertEqual(rig.model.connection, .requesting,
                       "the resident same-network room cancelled the code room's request")
        XCTAssertTrue(rig.transports.isEmpty)
        discovery.stop()
    }

    /// Leaving a watched code closes its socket. A room left open keeps this
    /// device in a pairing room nobody is looking at, with a credential still
    /// counting down against nothing.
    func testLeavingAWatchedCodeClosesItsRoom() async {
        let rig = rig(config: stunOnlyConfig())
        _ = await openPairedLink(rig)
        rig.model.leave()
        await settle()

        XCTAssertTrue(rig.channels[0].closed)
        XCTAssertNil(rig.handle.signaling,
                     "a room nobody was handed must not be left in the handle")
    }
}
