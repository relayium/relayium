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
        /// The ICE URLs each assembly was actually built with — the one
        /// observable that says which relay this room converged on.
        var serverUrls: [[String]] = []
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

        /// The ask the LARGER id sends. It carries no `caps` field at all, which
        /// is what makes it the frame a lost hello is unrecoverable from.
        func request(from peerId: String) {
            channels[0].fire(Envelope(type: SignalType.signal, from: peerId,
                                      data: linkRequestSignal()))
        }

        /// Every `link/1` request or offer this side actually put on the wire.
        ///
        /// The relay gate's outbound half is a statement about the SOCKET, not
        /// about internal state: nothing that commits this client to a relay —
        /// and nothing that starts the peer's or this side's request timeout —
        /// may leave before the choice is made.
        var linkFramesSent: [String] {
            channels[0].sent.compactMap { text in
                guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                      envelope.type == SignalType.signal, let data = envelope.data else { return nil }
                if isLinkRequest(data) { return "request" }
                if case let .object(root) = data, root["link"] == .bool(true), root["sdp"] != nil {
                    return "offer"
                }
                return nil
            }
        }

        /// A `link`-generation SDP offer, exactly as `webrtc.ts` frames one:
        /// the SDP, the generation tag, the handshake commit and the
        /// per-connection capability confirmation in a single frame.
        func offer(from peerId: String, commit: String = String(repeating: "a", count: 44)) {
            channels[0].fire(Envelope(type: SignalType.signal, from: peerId,
                                      data: linkSDPSignal(kind: "offer", sdp: "v=0\r\n",
                                                          commit: commit,
                                                          caps: [TEXT_CAPABILITY, LINK_CAPABILITY])))
        }
    }

    private func rig(config: ICEConfig,
                     requiresVerification: Bool = false,
                     selfId: String = "aaa-mac",
                     relayMeasure: @escaping RelayNegotiator.Measure = { _, _ in },
                     relayChoiceDeadline: TimeInterval = 30,
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
            relayMeasure: relayMeasure,
            relayChoiceDeadline: relayChoiceDeadline,
            assemble: { signaling, peerId, role, servers, relayOnly, generation,
                        directory, admission, signal in
                let transport = PairingTransport()
                box?.transports.append(transport)
                box?.relayOnly.append(relayOnly)
                box?.serverUrls.append(servers.flatMap(\.urlStrings))
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

    // MARK: - 12. the capability handshake this room actually runs

    /// Every `data` payload this room put on its socket, in order.
    ///
    /// Reading the outbound frames is the half `LinkPairingRoomTests` never had:
    /// the Mac's own hello in a code room was untested, which is precisely why
    /// "it announces once and never again" survived to ship.
    private func sentSignals(_ rig: Rig) -> [(to: String, data: JSONValue)] {
        rig.channels[0].sent.compactMap { text in
            guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                  envelope.type == SignalType.signal,
                  let to = envelope.to, let data = envelope.data else { return nil }
            return (to, data)
        }
    }

    private func sentHellos(_ rig: Rig, to peer: String) -> [[String]] {
        sentSignals(rig).filter { $0.to == peer }.compactMap { entry in
            guard case let .object(fields) = entry.data, case .array = fields["caps"] else { return nil }
            return peerCaps(from: entry.data)
        }
    }

    /// **The defect the retries were written for, and never ran against.**
    ///
    /// `LINK_CAPS_ANNOUNCE_ATTEMPTS` promised three attempts. In a pairing room
    /// its only consumer — `retryTick()` — had no caller at all: the 1.5s tick
    /// belonged to `LanDiscoveryModel`, so a code room announced exactly once per
    /// peer, forever, and two undelivered attempts sat in `pending` for the life
    /// of the room. One unacknowledged frame on a relayed socket was the whole
    /// difference between a unified workspace and a composer-less legacy lane.
    func testAPairingRoomRunsItsBoundedCapabilityHelloRetries() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("zzz-mac")
        rig.roster(["aaa-web"])          // present, and saying nothing back
        await settle()

        XCTAssertEqual(sentHellos(rig, to: "aaa-web").count, 1,
                       "the roster announcement itself")

        // Every retry the constant promises, at the shared cadence, all of them
        // inside the window the peer is waiting out.
        for attempt in 1...LINK_CAPS_ANNOUNCE_ATTEMPTS {
            rig.scheduler.advance(to: LINK_CAPS_RETRY_INTERVAL * Double(attempt))
            await settle()
        }
        let hellos = sentHellos(rig, to: "aaa-web")
        XCTAssertEqual(hellos.count, LINK_CAPS_ANNOUNCE_ATTEMPTS,
                       "bounded: the promised attempts and not one more")
        for hello in hellos {
            XCTAssertEqual(hello, advertisedLinkCapabilities(linkRoomActive: true))
        }
        XCTAssertLessThan(Double(LINK_CAPS_ANNOUNCE_ATTEMPTS - 1) * LINK_CAPS_RETRY_INTERVAL,
                          LinkWorkspaceModel.pairingCapabilityWait,
                          "an attempt that lands after the window is a frame that changes nothing")
    }

    /// They RETIRE on an answer. A client that keeps greeting a peer which has
    /// already spoken is two devices talking past each other.
    func testCapabilityRetriesRetireWhenThePeerAnswers() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("zzz-mac")
        rig.roster(["aaa-web"])
        await settle()
        rig.announce("aaa-web", [TEXT_CAPABILITY])   // legacy, so the room resolves without a link
        await settle()

        let afterAnswer = sentHellos(rig, to: "aaa-web").count
        for attempt in 1...LINK_CAPS_ANNOUNCE_ATTEMPTS {
            rig.scheduler.advance(to: LINK_CAPS_RETRY_INTERVAL * Double(attempt))
            await settle()
        }
        XCTAssertEqual(sentHellos(rig, to: "aaa-web").count, afterAnswer,
                       "a peer that has spoken does not need telling again")
    }

    /// And they retire with the ROOM. A timer that outlived its room would be
    /// announcing this build's capabilities into a code somebody else is in.
    func testCapabilityRetriesRetireWithTheRoom() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("zzz-mac")
        rig.roster(["aaa-web"])
        await settle()
        let armed = sentHellos(rig, to: "aaa-web").count

        rig.model.leave()
        await settle()
        for attempt in 1...LINK_CAPS_ANNOUNCE_ATTEMPTS {
            rig.scheduler.advance(to: LINK_CAPS_RETRY_INTERVAL * Double(attempt))
            await settle()
        }
        XCTAssertEqual(sentHellos(rig, to: "aaa-web").count, armed,
                       "a retired room kept announcing")
    }

    /// **A hello that arrives late — but inside the window — still promotes.**
    ///
    /// This is the shape a throttled mobile tab produces: the peer is capable,
    /// its frame is simply slower than the first retry tick. Nothing may have
    /// latched by then.
    func testALateHelloInsideTheWindowStillPromotes() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()

        rig.scheduler.advance(to: LINK_CAPS_RETRY_INTERVAL * 2)
        await settle()
        XCTAssertTrue(rig.adopted.isEmpty, "the room decided before its window elapsed")

        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY, "preupload/1"])
        await settle()
        XCTAssertEqual(rig.transports.count, 1, "a late but in-window hello did not promote")
        XCTAssertTrue(rig.adopted.isEmpty, "and nothing fell back")

        // The window that would have fired is gone with the decision.
        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()
        XCTAssertTrue(rig.adopted.isEmpty)
    }

    /// **Same burst: the caps hello and the link offer, back to back.**
    ///
    /// The ordinary case whenever the browser is the initiator — it broadcasts
    /// its capabilities and establishes on the same roster event — which the id
    /// comparison makes it in about half of all pairings. The hello used to be
    /// recorded inside a hop to the main actor while `LinkRoomRouter.intercept`
    /// gates inline on the delivery queue, so the offer behind it reached that
    /// gate with the announcement still in flight, was passed to a legacy
    /// handler that does not exist in a watched room, and was dropped with no
    /// reply at all — not even `busy`.
    ///
    /// Delivered with no `await` between the two frames, which is the whole
    /// point: an `await` here would let the hop run and the test would pass
    /// against the defect.
    func testAHelloAndAnOfferInOneBurstAreBothHonoured() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("zzz-mac")           // larger id: this side RESPONDS to the offer
        rig.roster(["aaa-web"])
        await settle()

        rig.announce("aaa-web", [TEXT_CAPABILITY, LINK_CAPABILITY, "preupload/1"])
        rig.offer(from: "aaa-web")
        await settle()

        XCTAssertEqual(rig.transports.count, 1,
                       "the offer was dropped before the announcement became visible")
        XCTAssertTrue(rig.adopted.isEmpty)
        XCTAssertFalse(sentSignals(rig).contains { isLinkBusy($0.data) },
                       "an offer this side asked for must never be refused")
    }

    /// **The other half: a hello that never arrived at all.**
    ///
    /// The larger-id peer does not offer — it ASKS, with `linkRequestSignal()`,
    /// and that frame carries no `caps` field of any kind. An SDP offer happens
    /// to repeat the announcement in its own envelope, so a lost hello is
    /// survivable there; a request has nothing to fall back on. Without the
    /// repair the ask is dropped in silence, the browser re-asks every three
    /// seconds for thirty, and this side spends its five-second window deciding
    /// the peer is legacy — from a peer that has been talking the whole time.
    ///
    /// A `link`-generation frame is itself the announcement, so it stands in for
    /// the hello. Only a peer that has said NOTHING is read this way; see
    /// `PeerCapabilityRegistry.recordProvenLink`.
    func testARequestFromAPeerWhoseHelloWasLostIsStillAnswered() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")           // smaller id: this side is asked to offer
        rig.roster(["zzz-web"])
        await settle()

        rig.request(from: "zzz-web")     // no hello, ever, and no caps in the frame
        await settle()

        XCTAssertEqual(rig.transports.count, 1, "the peer was black-holed")
        XCTAssertTrue(rig.adopted.isEmpty)

        // The window that would have called it legacy is gone with the decision.
        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()
        XCTAssertTrue(rig.adopted.isEmpty)
    }

    /// Both assignments reach a link, driven from the same room object.
    ///
    /// The ids decide which side offers, and a client can be entirely correct in
    /// the half its own id happens to produce. The smaller-id case assembles the
    /// moment the peer announces; the larger-id case asks and then answers the
    /// offer that comes back.
    func testBothRoleAssignmentsReachALink() async {
        let offering = rig(config: stunOnlyConfig())
        XCTAssertTrue(offering.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        offering.welcome("aaa-mac")
        offering.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY, "preupload/1"])
        offering.roster(["zzz-web"])
        await settle()
        XCTAssertEqual(linkRole(selfId: "aaa-mac", peerId: "zzz-web"), .initiator)
        XCTAssertEqual(offering.transports.count, 1, "the smaller id must assemble and offer")

        let answering = rig(config: stunOnlyConfig())
        XCTAssertTrue(answering.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        answering.welcome("zzz-mac")
        answering.announce("aaa-web", [TEXT_CAPABILITY, LINK_CAPABILITY, "preupload/1"])
        answering.roster(["aaa-web"])
        await settle()
        XCTAssertEqual(linkRole(selfId: "zzz-mac", peerId: "aaa-web"), .responder)
        XCTAssertEqual(answering.model.connection, .requesting,
                       "the larger id asks rather than offering")
        answering.offer(from: "aaa-web")
        await settle()
        XCTAssertEqual(answering.transports.count, 1, "the answer to its own ask was refused")
    }

    // MARK: - 13. giving up is SAID, and what was heard is carried over

    /// **The downgrade is announced, so it is no longer one-sided.**
    ///
    /// This client latches — `resolved` is set once and there is no re-promotion
    /// path — while a browser never does: it re-derives from its capability
    /// roster and re-asks every three seconds for thirty. So a lost hello was
    /// not a clean failure on either side; it was split-brain, with this Mac on
    /// a legacy file lane and the browser still asking a peer that had stopped
    /// listening. One ordinary hello ends it, and it names the lane this side
    /// actually landed on.
    func testGivingUpAnnouncesTheLaneItLandedOn() async {
        let silent = rig(config: stunOnlyConfig())
        XCTAssertTrue(silent.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        silent.welcome("aaa-mac")
        silent.roster(["zzz-web"])
        await settle()
        silent.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()

        XCTAssertEqual(silent.adopted.map(\.mode), [.files])
        XCTAssertEqual(sentHellos(silent, to: "zzz-web").last, [],
                       "a file lane must withdraw link/1 and claim nothing in its place")

        // A peer that announced text/1 gets a text lane, and is told exactly
        // that — the one capability the session it is about to build can carry.
        let talking = rig(config: stunOnlyConfig())
        XCTAssertTrue(talking.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        talking.welcome("aaa-mac")
        talking.roster(["zzz-web"])
        await settle()
        talking.announce("zzz-web", [TEXT_CAPABILITY])
        await settle()

        XCTAssertEqual(talking.adopted.map(\.mode), [.text])
        XCTAssertEqual(sentHellos(talking, to: "zzz-web").last, [TEXT_CAPABILITY])
    }

    /// **What the room heard goes over with the socket.**
    ///
    /// `retire()` resets the room's registry and `connectInRoom` then builds a
    /// fresh, empty one and waits five seconds for a `text/1` that has already
    /// been said. Nothing re-says it — a hello is sent on a roster EDGE, this
    /// roster has not changed, and neither client answers a hello with a hello —
    /// so a peer that correctly announced `text/1` reached `unsupportedPeer`
    /// *because* this side had understood it.
    func testTheLegacyHandoverCarriesWhatTheRoomHeard() async {
        let rig = rig(config: stunOnlyConfig())
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        await settle()

        XCTAssertEqual(rig.adopted.map(\.mode), [.text])
        XCTAssertEqual(rig.handle.peerAnnouncedCaps["zzz-web"], [TEXT_CAPABILITY],
                       "the legacy connection has to re-ask a question nothing will answer twice")
        XCTAssertNotNil(rig.handle.signaling, "and it is handed over WITH the socket")

        // Released with the room. A peer id means nothing outside the room that
        // issued it, so the evidence must not outlive it either.
        rig.model.releaseHandedOverPairingRoom()
        XCTAssertTrue(rig.handle.peerAnnouncedCaps.isEmpty)
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
    // MARK: - N. the room's relay choice

    /// Two pool relays plus the legacy top-level TURN, which is the shape a
    /// production `/api/ice` answer has today.
    private func pooledConfig(expiresIn: TimeInterval = 3600,
                              now: Date = Date(timeIntervalSince1970: 1_000_000)) -> ICEConfig {
        let expiry = Int(now.addingTimeInterval(expiresIn).timeIntervalSince1970)
        return ICEConfig(
            iceServers: [
                ICEServerConfig(urls: ["stun:stun.relayium.test:3478"]),
                ICEServerConfig(urls: ["turn:legacy.relayium.test:3478"],
                                username: "\(expiry):tok", credential: "secret"),
            ],
            relays: [
                RelayEntry(id: "near", iceServers: [
                    ICEServerConfig(urls: ["turn:near.relayium.test:3478"],
                                    username: "\(expiry):tok", credential: "secret"),
                ]),
                RelayEntry(id: "far", iceServers: [
                    ICEServerConfig(urls: ["turn:far.relayium.test:3478"],
                                    username: "\(expiry):tok", credential: "secret"),
                ]),
            ])
    }

    /// A pool-only answer: the "only my nodes" account, whose top-level list
    /// carries no TURN at all.
    private func poolOnlyConfig(now: Date = Date(timeIntervalSince1970: 1_000_000)) -> ICEConfig {
        let expiry = Int(now.addingTimeInterval(3600).timeIntervalSince1970)
        return ICEConfig(
            iceServers: [ICEServerConfig(urls: ["stun:stun.relayium.test:3478"])],
            relays: [
                RelayEntry(id: "mine", iceServers: [
                    ICEServerConfig(urls: ["turn:mine.relayium.test:3478"],
                                    username: "\(expiry):tok", credential: "secret"),
                ]),
            ])
    }

    /// The peer's map, exactly as `App.svelte`'s `broadcastRelayRtt` frames one.
    private func relayRtt(_ rig: Rig, from peerId: String, _ map: [String: Int]) {
        rig.channels[0].fire(Envelope(type: SignalType.signal, from: peerId,
                                      data: RelayRttMessage.encode(map)))
    }

    /// **The defect this batch exists for.**
    ///
    /// The unified `link/1` path stored only `ICEConfig.iceServers` and dropped
    /// the pool, so every relayed Workspace link was built on whichever legacy
    /// relay the top-level entry named — while the browser measured the pool and
    /// nominated something else. Two peers, two relays, two hops.
    func testAPoolRoomConvergesOnTheRelayBothPeersMeasured() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "far" ? 20 : 300) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        // Our own probes have landed, but the peer has said nothing: the choice
        // cannot be made, so nothing may be built on a guess at it.
        XCTAssertTrue(rig.serverUrls.isEmpty, "no link may be assembled before the maps meet")

        relayRtt(rig, from: "zzz-web", ["near": 30, "far": 25])
        await settle()

        XCTAssertEqual(rig.serverUrls, [["turn:far.relayium.test:3478"]],
                       "both sides minimise the WORSE of the two RTTs, which is `far`")
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// The map the peer sends is untrusted signalling input. A hostile or broken
    /// one must not select anything, and must not stop the room either.
    func testARubbishPeerMapSelectsNothingAndStillOpensTheGate() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, 40) }
                      },
                      relayChoiceDeadline: 0.05)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        // Infinite, negative and absurd values, plus a non-number: every one of
        // them is rejected by `RelayRttMessage.decode` rather than trapping on
        // `Int(_: Double)` or selecting a relay this side cannot reach.
        rig.channels[0].fire(Envelope(
            type: SignalType.signal, from: "zzz-web",
            data: .object(["relayRtt": .object(["near": .number(.infinity),
                                                "far": .number(-1),
                                                "ghost": .string("5")])])))
        try? await Task.sleep(nanoseconds: 200_000_000)
        await settle()

        XCTAssertEqual(rig.serverUrls.count, 1)
        XCTAssertEqual(rig.serverUrls.first?.first, "stun:stun.relayium.test:3478",
                       "no relay was agreed, so the whole capped set is folded in")
        XCTAssertEqual(rig.relayOnly, [true], "a fallback that contains TURN still relays")
    }

    /// **A peer on a build with no relay exchange must not stall the room.**
    ///
    /// It sends no map at all, so no choice can ever settle. The bounded
    /// deadline is the only thing that ends that wait, and what it lands on is
    /// the capped, pool-folded, relay-only fallback rather than nothing.
    func testAMapLessPeerFallsBackAfterTheBoundedDeadline() async {
        let rig = rig(config: poolOnlyConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, 12) }
                      },
                      relayChoiceDeadline: 0.05)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty, "still inside the deadline")

        try? await Task.sleep(nanoseconds: 200_000_000)
        await settle()

        XCTAssertEqual(rig.serverUrls,
                       [["stun:stun.relayium.test:3478", "turn:mine.relayium.test:3478"]],
                       "an own-node account has its only TURN in the pool")
        XCTAssertEqual(rig.relayOnly, [true],
                       "a pool-only account must still be relay-only, or ICE spends 20s on nothing")
    }

    /// **The outbound half, stated on the wire.**
    ///
    /// This side is the LARGER id, so the link it asks for is a `linkRequest` —
    /// the frame whose thirty-second timeout starts the moment it is sent, on
    /// both clients. Sending it before the relay choice would either start that
    /// timeout against a wait the peer knows nothing about or commit the answer
    /// to a configuration this room has not decided.
    func testNoLinkRequestReachesTheWireBeforeTheChoiceIsMade() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("zzz-mac")
        rig.announce("aaa-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["aaa-web"])
        await settle()

        XCTAssertEqual(rig.linkFramesSent, [], "nothing that commits to a relay may go out yet")
        XCTAssertEqual(rig.model.connection, .requesting,
                       "the wait is not hidden: this side has decided to ask, and says so")

        relayRtt(rig, from: "aaa-web", ["near": 12, "far": 80])
        await settle()

        XCTAssertEqual(rig.linkFramesSent, ["request"])
    }

    /// A room with no pool has nothing to wait for, and waiting would be a
    /// regression the user can feel: this is every same-network link and every
    /// STUN-only code.
    func testARoomWithNoPoolIsImmediate() async {
        let rig = rig(config: stunOnlyConfig(),
                      relayMeasure: { _, _ in XCTFail("an empty pool must not be measured") })
        let transport = await openPairedLink(rig)
        XCTAssertNotNil(transport, "the link is built on the same turn, with no relay wait")
        XCTAssertEqual(rig.relayOnly, [false])
    }

    /// **An inbound offer is held by the same gate, and loses nothing.**
    ///
    /// The peer with the smaller id offers without asking, so this frame can
    /// arrive before this side has decided anything. Assembling on it would
    /// snapshot the fallback for the life of the link.
    func testAnEarlyInboundOfferIsHeldRatherThanAssembledOnTheFallback() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 200) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        // A LARGER self id, so this side is the responder and the peer offers.
        rig.welcome("zzz-mac")
        rig.announce("aaa-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["aaa-web"])
        rig.offer(from: "aaa-web")
        await settle()

        XCTAssertTrue(rig.serverUrls.isEmpty, "the offer waits for the choice, it does not bypass it")

        relayRtt(rig, from: "aaa-web", ["near": 15, "far": 400])
        await settle()

        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]])
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// **A second code must not inherit the first code's relay.**
    ///
    /// Every credential in a pool answer is minted for one code. A choice that
    /// survived a room switch would select a `RelayEntry` id in a pool whose
    /// credentials were issued for a room this client has left — and the
    /// probe/gate completion of the abandoned room must not reopen anything in
    /// the new one.
    func testANewCodeCarriesNoRelayChoiceOrCredentialFromTheOldOne() async {
        let first = pooledConfig()
        let rig = rig(config: first,
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 5 : 500) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        // The first room really does COMMIT a choice — `near` — so what the
        // second room must not inherit is a decision this object actually made,
        // not merely one it was still thinking about.
        relayRtt(rig, from: "zzz-web", ["near": 7, "far": 900])
        await settle()

        rig.model.leave()
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty, "no peer announced link/1, so nothing was built")

        // A second code, whose answer names a DIFFERENT pool. The old room's
        // `near` does not exist in it, so a leaked id could only resolve to the
        // fallback — and a leaked credential would show up as the old URL.
        XCTAssertTrue(rig.model.watchPairingCode("EF34GH", legacyRole: .responder))
        await settle()
        // The SECOND socket. The rig's helpers address the first, which is the
        // one this room must not be reachable on any more.
        XCTAssertEqual(rig.channels.count, 2)
        let second = rig.channels[1]
        second.fire(Envelope(type: SignalType.welcome, name: "aaa-mac"))
        second.fire(Envelope(type: SignalType.signal, from: "zzz-web",
                             data: .object(["caps": .array([.string(TEXT_CAPABILITY),
                                                            .string(LINK_CAPABILITY)])])))
        second.fire(Envelope(type: SignalType.peers, peers: [Peer(id: "zzz-web", name: "peer")]))
        second.fire(Envelope(type: SignalType.signal, from: "zzz-web",
                             data: RelayRttMessage.encode(["far": 40])))
        await settle()

        XCTAssertEqual(rig.serverUrls, [["turn:far.relayium.test:3478"]],
                       "the second room chose from its own pool, on its own maps")

        // And the abandoned socket is inert: a late frame on it — the shape a
        // room that was left mid-exchange really produces — changes nothing.
        relayRtt(rig, from: "zzz-web", ["near": 1])
        rig.offer(from: "zzz-web")
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:far.relayium.test:3478"]])
    }
}
