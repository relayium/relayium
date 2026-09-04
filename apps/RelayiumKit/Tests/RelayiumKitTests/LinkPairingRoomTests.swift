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

    /// A latch a test opens by hand, so `/api/ice` can be held for exactly as
    /// long as an assertion needs rather than for a sleep.
    ///
    /// It is what makes "the room joined while the answer was still in flight"
    /// a statement about ordering instead of about timing: nothing here elapses,
    /// so a slow machine cannot turn the window this exercises into a pass.
    private final class ICELatch: @unchecked Sendable {
        private let lock = NSLock()
        private var released = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                lock.lock()
                if released { lock.unlock(); c.resume(); return }
                waiters.append(c)
                lock.unlock()
            }
        }

        func release() {
            lock.lock()
            released = true
            let parked = waiters
            waiters = []
            lock.unlock()
            for c in parked { c.resume() }
        }
    }

    private final class StubICEClient: ICEConfigClient, @unchecked Sendable {
        let config: ICEConfig
        /// Per-code answers, for the one thing a single config cannot say: that
        /// a room built on THIS code's credentials and not on the previous
        /// code's. Falls back to `config` for every code not named here.
        let perCode: [String: ICEConfig]
        /// Per-code latches. A code that has one parks in `fetch` until the test
        /// releases it — the window the room now joins inside. Absent is the
        /// immediate answer every other test wants.
        let latches: [String: ICELatch]
        private let lock = NSLock()
        private var _codes: [String] = []
        var codes: [String] { lock.lock(); defer { lock.unlock() }; return _codes }

        init(config: ICEConfig,
             perCode: [String: ICEConfig] = [:],
             latches: [String: ICELatch] = [:]) {
            self.config = config
            self.perCode = perCode
            self.latches = latches
        }

        func fetch(code: String) async throws -> ICEConfig {
            lock.lock(); _codes.append(code); lock.unlock()
            await latches[code]?.wait()
            return perCode[code] ?? config
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
        ///
        /// `at` is the socket index, for the one test that watches two codes in
        /// sequence: the second code opens a SECOND socket, and driving the
        /// first would be driving a room that is closed.
        func welcome(_ selfId: String, at index: Int = 0) {
            channels[index].fire(Envelope(type: SignalType.welcome, name: selfId))
        }

        func roster(_ ids: [String], at index: Int = 0) {
            channels[index].fire(Envelope(type: SignalType.peers,
                                          peers: ids.map { Peer(id: $0, name: "peer") }))
        }

        func announce(_ peerId: String, _ caps: [String], at index: Int = 0) {
            channels[index].fire(Envelope(type: SignalType.signal, from: peerId,
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

        /// Every peer this side answered `busy` — the refusal a peer settles
        /// `.refused` on. Separate from `linkFramesSent`, which counts only what
        /// this side ASKED for: a refusal is not an ask, and a test that watched
        /// asks alone would call a room that refused its own counterpart quiet.
        var busyRefusalsSent: [String] {
            channels[0].sent.compactMap { text in
                guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                      envelope.type == SignalType.signal, let data = envelope.data,
                      parseBusy(data) else { return nil }
                return envelope.to
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
                     // Defaulted to the shipped policy, so every test written
                     // before this seam existed still drives the fallback path
                     // and still asserts the behaviour it was written for.
                     legacyFallback: LinkPairingFallbackPolicy = .adoptLegacySession,
                     selfId: String = "aaa-mac",
                     iceByCode: [String: ICEConfig] = [:],
                     iceLatches: [String: ICELatch] = [:],
                     relayMeasure: @escaping RelayNegotiator.Measure = { _, _ in },
                     relayChoiceDeadline: TimeInterval = 30,
                     now: Date = Date(timeIntervalSince1970: 1_000_000)) -> Rig {
        let scheduler = ManualScheduler()
        let ice = StubICEClient(config: config, perCode: iceByCode, latches: iceLatches)
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
            legacyFallback: legacyFallback,
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

    /// A code whose configuration never arrives ends the same way it always did
    /// — and takes the socket it optimistically joined with it.
    ///
    /// The socket IS opened now, because the join and the fetch start together
    /// (see `watchPairingCode`). What must not change is either half of the
    /// answer: nothing may be assembled without a configuration, and the room
    /// this object opened must not be left behind holding a hub connection
    /// nobody is looking at.
    func testACodeWithNoICEConfigurationIsRefusedTruthfullyAndClosesItsSocket() async {
        final class FailingICE: ICEConfigClient, @unchecked Sendable {
            func fetch(code: String) async throws -> ICEConfig { throw NearbyError.notScanning }
        }
        let dir = self.dir!
        let channel = FakeWebSocketChannel()
        let model = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { dir }, requiresVerification: { false },
            iceClient: FailingICE(),
            connectPairingSocket: { _ in
                let socket = SignalingClient(channel: channel, name: "Mac")
                channel.fireOpen()
                return socket
            },
            assemble: { _, _, _, _, _, _, _, _, _ in
                XCTFail("nothing may be assembled without a configuration")
                fatalError()
            })
        XCTAssertTrue(model.watchPairingCode("AB12CD", legacyRole: .initiator))
        for _ in 0..<14 { await Task.yield() }
        XCTAssertEqual(model.connection, .ended(.roomUnavailable))
        XCTAssertTrue(channel.closed,
                      "a room whose configuration never came is not a room to keep open")
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
    // MARK: - the fallback policy, and the composition that has nothing to fall
    //         back to

    /// **The default is the shipped behaviour, and this test proves it by NOT
    /// naming a policy.**
    ///
    /// It builds its model inline rather than through `rig(...)`, and that is
    /// the whole point. The rig carries its own defaulted `legacyFallback`
    /// argument, so a rig-based "default" test would pass the rig's default and
    /// never touch the production one — flipping
    /// `LinkWorkspaceModel.init`'s default would leave it green. This omits the
    /// argument entirely, so the value under test is the one every existing
    /// caller inherits: the paused iOS composition, the headless acceptance
    /// hosts, and every test written before this seam existed.
    func testTheProductionDefaultStillHandsAStrippedRoomToTheLegacyPath() async {
        let dir = self.dir!
        let scheduler = ManualScheduler()
        let channel = FakeWebSocketChannel()
        var adopted: [(peerId: String, role: Role, mode: TransferMode)] = []
        let model = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { dir }, requiresVerification: { false },
            iceClient: StubICEClient(config: stunOnlyConfig(), perCode: [:], latches: [:]),
            connectPairingSocket: { _ in
                let socket = SignalingClient(channel: channel, name: "Mac")
                channel.fireOpen()
                return socket
            },
            // NO `legacyFallback:` argument. Adding one here would defeat the test.
            scheduler: scheduler,
            assemble: { _, _, _, _, _, _, _, _, _ in
                XCTFail("a stripped room must not assemble a link")
                fatalError()
            })
        model.adoptLegacyRoom = { peerId, role, _, mode in adopted.append((peerId, role, mode)) }

        XCTAssertTrue(model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        channel.fire(Envelope(type: SignalType.welcome, name: "aaa-mac"))
        channel.fire(Envelope(type: SignalType.peers, peers: [Peer(id: "zzz-web", name: "peer")]))
        await settle()
        scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()

        XCTAssertEqual(adopted.map(\.peerId), ["zzz-web"],
                       "the production default must keep handing the room over")
        XCTAssertEqual(adopted.map(\.role), [.responder], "the verb the user pressed")
        XCTAssertFalse(model.unsupportedPairingPeer,
                       "the production default must never publish the refusal")
        XCTAssertFalse(channel.closed,
                       "and must keep the socket open for the session it handed it to")
    }

    /// The same default, read directly. A behavioural test says what the default
    /// DOES; this says what it IS, so a flip is named in the diff of whichever
    /// one the author was not thinking about.
    func testTheProductionDefaultPolicyIsTheLegacyHandover() async {
        let dir = self.dir!
        let model = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { dir }, requiresVerification: { false },
            iceClient: nil)
        // The convenience initializer's default, through the public surface the
        // app targets actually call.
        XCTAssertEqual(model.pairingFallbackPolicy, .adoptLegacySession)
    }

    /// **The positive control, under the new policy.** Contracting the fallback
    /// must not contract the protocol: a peer that announces exact `link/1` gets
    /// the same unified link it always did, over the same one socket, with the
    /// same activation callback and the same verified transport.
    ///
    /// Written first and deliberately: every assertion below it is an absence,
    /// and a rig that had silently stopped linking at all would satisfy every
    /// one of them.
    func testExactLinkStillOpensNormallyWhenTheFallbackIsDisabled() async throws {
        let rig = rig(config: stunOnlyConfig(), legacyFallback: .terminateUnsupported)
        let transport = await openPairedLink(rig)
        let opened = try XCTUnwrap(transport, "exact link/1 must still reach a transport")

        XCTAssertTrue(rig.model.connection.isOpen)
        XCTAssertEqual(rig.pairingLinkActivations, 1)
        XCTAssertEqual(rig.transports.count, 1, "one link, on one connection")
        XCTAssertEqual(rig.joinedCodes.count, 1, "and one room for it")
        XCTAssertFalse(rig.model.unsupportedPairingPeer,
                       "a link/1 peer is not unsupported")
        XCTAssertTrue(rig.adopted.isEmpty, "and no legacy session was started for it")

        // …and it carries both lanes, which is the whole claim the code makes.
        rig.model.send(message: "hello")
        await settle()
        XCTAssertEqual(opened.sent[.text]?.first, [LINK_TEXT_REQUEST])
        rig.model.send(files: [FileMeta(name: "a.bin", size: 4, path: nil)],
                       sources: [DataSource(name: "a.bin", bytes: [1, 2, 3, 4])])
        await settle()
        XCTAssertFalse(opened.sent[.file, default: []].isEmpty,
                       "the file lane must still carry a batch")
    }

    /// **Every inbound tag that is not exactly `link/1` terminates as
    /// unsupported, and none of them reaches a fallback, an offer or a
    /// transport.**
    ///
    /// The table is the adversarial half. `LINK/1` and `Link/1` are case folds,
    /// `link/2` is a later wire, `link/1x` is a prefix, `text/1` is the legacy
    /// lane and the mixed rows are a peer announcing a real capability beside a
    /// near-miss — the shape that would pass any `contains`-flavoured check
    /// written against a substring instead of an element.
    ///
    /// An EMPTY hello is deliberately in this table too: it is a hello, and
    /// under this policy it is a decidable one, so it must not wait out the
    /// window. Genuine silence is the separate test below.
    func testNoNonExactAnnouncementReachesAnythingWhenTheFallbackIsDisabled() async {
        let cases: [[String]] = [
            [],
            [TEXT_CAPABILITY],
            ["LINK/1"],
            ["Link/1", "preupload/1"],
            ["link/2"],
            ["link/1x"],
            ["link/10"],
            [TEXT_CAPABILITY, "link/2"],
            ["preupload/1"],
        ]
        for caps in cases {
            let rig = rig(config: stunOnlyConfig(), legacyFallback: .terminateUnsupported)
            XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
            await settle()
            rig.welcome("aaa-mac")
            rig.announce("zzz-web", caps)
            rig.roster(["zzz-web"])
            await settle()

            XCTAssertTrue(rig.model.unsupportedPairingPeer,
                          "caps \(caps) did not terminate as unsupported")
            // Decided on the spot: the clock is never advanced above, so a rule
            // that still waited out `pairingCapabilityWait` fails here.
            XCTAssertTrue(rig.adopted.isEmpty, "caps \(caps) reached a legacy session")
            XCTAssertTrue(rig.handedBackBatches.isEmpty, "caps \(caps) handed a batch back")
            XCTAssertEqual(rig.pairingLinkActivations, 0, "caps \(caps)")
            XCTAssertTrue(rig.transports.isEmpty, "caps \(caps) assembled a transport")
            XCTAssertEqual(rig.linkFramesSent, [],
                           "caps \(caps) put a speculative link frame on the wire")
            XCTAssertEqual(rig.model.connection, .idle, "caps \(caps)")
            XCTAssertNil(rig.model.handedOverPairing, "caps \(caps) recorded a handover")
            XCTAssertTrue(rig.channels[0].closed,
                          "caps \(caps) left the refused room's socket open")
            XCTAssertNil(rig.handle.signaling, "caps \(caps) left a socket in the handle")
        }
    }

    /// A peer that says nothing at all still waits out the window — silence is
    /// not an announcement — and then terminates rather than falling back.
    func testASilentPeerWaitsTheWindowAndThenTerminatesUnsupported() async {
        let rig = rig(config: stunOnlyConfig(), legacyFallback: .terminateUnsupported)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertFalse(rig.model.unsupportedPairingPeer,
                       "the window has not elapsed; a silent peer may still announce")
        XCTAssertEqual(rig.model.connection, .watching(code: "AB12CD"))

        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait)
        await settle()

        XCTAssertTrue(rig.model.unsupportedPairingPeer)
        XCTAssertTrue(rig.adopted.isEmpty)
        XCTAssertTrue(rig.channels[0].closed)
    }

    /// **A late hello inside the window still promotes**, even under the policy
    /// whose whole job is to refuse. The window is a grace, not a countdown to a
    /// refusal, and a peer whose roster frame beat its hello must not be
    /// answered before it has spoken.
    func testALateExactHelloInsideTheWindowStillPromotesUnderTheStrictPolicy() async {
        let rig = rig(config: stunOnlyConfig(), legacyFallback: .terminateUnsupported)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()

        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait - 0.01)
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()

        XCTAssertFalse(rig.model.unsupportedPairingPeer,
                       "a hello that arrived inside the window is not a refusal")
        XCTAssertEqual(rig.pairingLinkActivations, 1)
        XCTAssertEqual(rig.transports.count, 1)

        // And the window that was already armed must not fire behind it.
        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait * 3)
        await settle()
        XCTAssertFalse(rig.model.unsupportedPairingPeer,
                       "the elapsed window retired a link that had already been claimed")
        XCTAssertTrue(rig.adopted.isEmpty)
    }

    /// A batch the user armed before the peer turned up is DROPPED, not handed
    /// back — there is no lane left to hand it to — and it is never put on the
    /// wire.
    ///
    /// The armed-batch path is where the default policy does its most work
    /// (`legacyFallbackMode` reads it to choose a lane), so it is the most
    /// likely place for the old behaviour to survive the seam.
    func testAnArmedBatchIsDroppedRatherThanHandedBackWhenTheFallbackIsDisabled() async {
        let rig = rig(config: stunOnlyConfig(), legacyFallback: .terminateUnsupported)
        XCTAssertTrue(rig.model.watchPairingCode(
            "AB12CD", legacyRole: .initiator,
            files: [FileMeta(name: "secret.pdf", size: 9, path: nil)],
            sources: [DataSource(name: "secret.pdf", bytes: [UInt8](repeating: 7, count: 9))]))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertTrue(rig.model.unsupportedPairingPeer)
        XCTAssertTrue(rig.handedBackBatches.isEmpty,
                      "a batch handed back has nowhere to go and would be held forever")
        XCTAssertTrue(rig.model.armedFiles.isEmpty,
                      "and it must not stay armed for whatever the object does next")
        XCTAssertTrue(rig.transports.isEmpty)
        XCTAssertEqual(rig.linkFramesSent, [])
    }

    /// The refusal does not announce a downgrade.
    ///
    /// The hand-over sends one — it names the lane the legacy session is about
    /// to run — and sending it here would revoke a `link/1` this build genuinely
    /// still speaks. Asserted on the SOCKET, because that is where a lie would
    /// actually be told.
    func testTheRefusalTellsThePeerNothingAtAll() async {
        let rig = rig(config: stunOnlyConfig(), legacyFallback: .terminateUnsupported)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        rig.welcome("aaa-mac")
        let before = rig.channels[0].sent.count
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()

        XCTAssertTrue(rig.model.unsupportedPairingPeer)
        let after = rig.channels[0].sent.dropFirst(before)
        let downgrades = after.filter { text in
            guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                  envelope.type == SignalType.signal, let data = envelope.data else { return false }
            // Any hello at all: an empty `caps` array is the revocation the
            // hand-over sends for a file lane, and it is exactly what must not
            // appear here.
            if case let .object(root) = data { return root["caps"] != nil }
            return false
        }
        XCTAssertEqual(Array(downgrades), [],
                       "the refusal withdrew a capability this build still has")
    }

    /// The refusal is cleared by a new rendezvous and by the user reading it,
    /// and by nothing else. A flag that survived the next code would make a
    /// fresh room open under somebody else's answer.
    func testTheRefusalIsClearedByANewCodeAndByDismissal() async {
        let rig = rig(config: stunOnlyConfig(), legacyFallback: .terminateUnsupported)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertTrue(rig.model.unsupportedPairingPeer)

        rig.model.dismissUnsupportedPairingPeer()
        XCTAssertFalse(rig.model.unsupportedPairingPeer)

        // …and a refusal still standing does not block the next code, which is
        // the failure a latched flag would actually cause.
        XCTAssertTrue(rig.model.watchPairingCode("EF34GH", legacyRole: .initiator),
                      "a refused room must not hold the next one out")
        await settle()
        rig.welcome("aaa-mac", at: 1)
        rig.announce("yyy-web", [TEXT_CAPABILITY], at: 1)
        rig.roster(["yyy-web"], at: 1)
        await settle()
        XCTAssertTrue(rig.model.unsupportedPairingPeer)
        rig.model.dismissUnsupportedPairingPeer()

        XCTAssertTrue(rig.model.watchPairingCode("IJ56KL", legacyRole: .initiator))
        await settle()
        XCTAssertFalse(rig.model.unsupportedPairingPeer,
                       "watching a new code must clear the previous room's answer")
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
    private func relayRtt(_ rig: Rig, from peerId: String, _ map: [String: Int],
                          at index: Int = 0) {
        rig.channels[index].fire(Envelope(type: SignalType.signal, from: peerId,
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

    // MARK: - O. the grace belongs to a PEER, not to the room's clock

    /// Long enough that a `settle()` between two assertions cannot be mistaken
    /// for it, short enough that a test can actually spend one.
    private static let graceForTests: TimeInterval = 0.3

    /// Sleep past `graceForTests`, with margin.
    private func sleepPastGrace() async {
        try? await Task.sleep(nanoseconds: UInt64(Self.graceForTests * 2 * 1_000_000_000))
    }

    /// **The code creator sits alone, and that is the ordinary case.**
    ///
    /// One side creates a code and waits — often for a minute — while the other
    /// person types it in. The first version of this gate armed its five-second
    /// deadline when the room started measuring, so it had expired long before
    /// the peer existed: the gate was already open when that peer finally
    /// announced, and its capability hello could beat its RTT map to the first
    /// legal `link/1` frame. The link was then built on the fallback for its
    /// whole life, which is the defect the gate exists to prevent.
    ///
    /// This side is the LARGER id, so the frame at stake is the `linkRequest`
    /// whose thirty-second timeout starts on both clients the moment it is sent.
    func testAPeerlessRoomOpensNoGateHoweverLongItSitsThere() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      relayChoiceDeadline: Self.graceForTests)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("zzz-mac")

        // Our own probes finish immediately; nobody is here to compare them
        // with. Well past the old deadline, and nothing has been decided.
        await sleepPastGrace()
        await settle()
        XCTAssertEqual(rig.linkFramesSent, [],
                       "an empty room has nobody to send a link frame to, and nothing to decide")
        XCTAssertTrue(rig.serverUrls.isEmpty)

        // The late peer arrives. Its CAPABILITY hello lands first — which is the
        // native ordering; a browser sends its RTT greet first — so a gate keyed
        // on either one alone would be wrong for one of the two clients.
        rig.announce("aaa-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["aaa-web"])
        await settle()
        XCTAssertEqual(rig.linkFramesSent, [],
                       "this peer's grace has only just started; nothing may commit to a relay yet")
        XCTAssertTrue(rig.serverUrls.isEmpty, "and no configuration may be snapshotted")
        XCTAssertEqual(rig.model.connection, .requesting,
                       "the wait is not hidden: this side has decided to ask, and says so")

        relayRtt(rig, from: "aaa-web", ["near": 12, "far": 80])
        await settle()
        XCTAssertEqual(rig.linkFramesSent, ["request"],
                       "exactly one request, and only once the maps had met")
    }

    /// The same peerless room in the OTHER link role: this side is the smaller
    /// id, so it offers rather than asks, and the frame held back is the offer
    /// that carries this client's committed ICE configuration.
    func testAPeerlessRoomHoldsTheOfferingRoleToo() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      relayChoiceDeadline: Self.graceForTests)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")

        await sleepPastGrace()
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty)

        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "the offering side may not snapshot a configuration either")

        relayRtt(rig, from: "zzz-web", ["near": 12, "far": 80])
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]])
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// **The only evidence is the offer itself.**
    ///
    /// A peer whose roster frame and capability hello have not arrived — or
    /// never do — still proves it exists the moment it puts a `link`-generation
    /// frame on the socket. That has to arm the grace, because the frame it
    /// arms it for is the one the router is holding: nothing else would ever
    /// open the gate, and the offer would wait forever.
    func testAnOfferIsItselfEnoughToStartTheGrace() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 200) }
                      },
                      relayChoiceDeadline: Self.graceForTests)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("zzz-mac")
        await sleepPastGrace()
        await settle()

        // No roster, no hello: the offer is the first thing this room hears.
        rig.offer(from: "aaa-web")
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty, "held, not assembled on an undecided configuration")

        relayRtt(rig, from: "aaa-web", ["near": 15, "far": 400])
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]])

        // And the same room, had the map never come, would still have got out:
        // the grace this offer armed is bounded.
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// A late peer on a build with no relay exchange gets a FULL fresh grace,
    /// not the remainder of one that expired while the room was empty — and then
    /// the capped, pool-folded, relay-only fallback rather than nothing.
    func testAMapLessLatePeerGetsAFullFreshGraceThenFallsBack() async {
        let rig = rig(config: poolOnlyConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, 12) }
                      },
                      relayChoiceDeadline: Self.graceForTests)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")

        await sleepPastGrace()
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty)

        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "a fresh grace, not the remains of one that expired in an empty room")

        await sleepPastGrace()
        await settle()
        XCTAssertEqual(rig.serverUrls,
                       [["stun:stun.relayium.test:3478", "turn:mine.relayium.test:3478"]],
                       "an own-node account has its only TURN in the pool")
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// **A departure cancels its own wait, and the next peer starts over.**
    ///
    /// Letting the departed peer's grace expire would open the gate on behalf of
    /// somebody who is gone — so the peer that arrives next would have its first
    /// link frame built before it had any chance to send a map, which is exactly
    /// the failure the peer scoping exists to remove.
    func testADepartedPeersGraceCannotReleaseTheGateAndTheNextPeerGetsAFullOne() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      relayChoiceDeadline: Self.graceForTests)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        // A peer that is present but has not said what it speaks, so the room
        // stays unresolved and a second peer can still take it.
        rig.roster(["zzz-web"])
        // …and whose map names nothing this side measured, so no choice settles.
        relayRtt(rig, from: "zzz-web", ["ghost": 5])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty)

        rig.channels[0].fireText(#"{"type":"left","peer":"zzz-web"}"#)
        await settle()
        await sleepPastGrace()
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "the departed peer's deadline must not have opened anything")

        // A different peer takes the room. If the gate had been released on the
        // first one's behalf, this link would be assembled on the fallback right
        // here, before its map could arrive.
        rig.announce("yyy-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["yyy-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty, "a full fresh grace, not an already-open gate")

        relayRtt(rig, from: "yyy-web", ["near": 15, "far": 400])
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]],
                       "and it is the ARRIVING peer's map that decides")
        XCTAssertEqual(rig.relayOnly, [true])
    }

    // MARK: - P. a roster that no longer names a peer is a departure too

    /// Sleep for a stated stretch of real time. The two tests below turn on
    /// WHICH deadline elapsed, so they have to let one actually run out.
    private func pause(_ seconds: TimeInterval) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    /// A relay probe that has not answered yet, held open by the test.
    ///
    /// The ordinary first seconds of a room: one relay replies at once and
    /// another is still being probed, so a choice can EXIST without being
    /// settled. That window is the only place a peer's measurements can sit on
    /// record without the gate having already opened on them, which is exactly
    /// the state a departure has to clear.
    private final class ProbeStall: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Void, Never>?
        private var released = false

        func wait() async {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                lock.lock()
                if released { lock.unlock(); c.resume(); return }
                continuation = c
                lock.unlock()
            }
        }

        func release() {
            lock.lock()
            let c = continuation
            continuation = nil
            released = true
            lock.unlock()
            c?.resume()
        }
    }

    /// **The gap this section exists for.**
    ///
    /// The hub sends `left` only for a physical disconnect, so a peer can leave
    /// the roster with nothing else behind it. That branch used to clear the
    /// grace and nothing more — and after the room had RESOLVED, which is the
    /// state a gated link intent is parked in, it did not even get that far: the
    /// roster handler returned before it. So the departed peer's deadline ran to
    /// the end, opened the gate on its behalf, and put this side's held ask on
    /// the wire to somebody who was no longer in the room.
    func testARosterRemovalAfterResolutionRetiresTheParkedLinkIntent() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      relayChoiceDeadline: Self.graceForTests)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        // The room has latched onto this peer — `resolved` — and the intent to
        // link with it is parked behind the relay gate.
        XCTAssertEqual(rig.model.connection, .requesting)
        XCTAssertEqual(rig.linkFramesSent, [])
        XCTAssertTrue(rig.serverUrls.isEmpty)

        // It vanishes from the roster, with no `left` frame behind it.
        rig.roster([])
        await settle()
        await sleepPastGrace()
        await settle()
        XCTAssertEqual(rig.linkFramesSent, [],
                       "a departed peer's deadline must not put this side's held ask on the wire")
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "and nothing may be assembled for a peer that has gone")

        // A map arriving after the departure is not a resurrection either: the
        // wait it would have woken is no longer anybody's.
        relayRtt(rig, from: "zzz-web", ["near": 12, "far": 80])
        await settle()
        XCTAssertEqual(rig.linkFramesSent, [])
        XCTAssertTrue(rig.serverUrls.isEmpty)
        XCTAssertEqual(rig.model.connection, .requesting,
                       "and the attempt is neither settled twice nor failed behind the user's back")
    }

    /// The same removal for a peer no roster frame has ever named.
    ///
    /// A capability hello can arrive before the roster that lists its sender —
    /// the room is built to accept that — so the peer being waited on, and the
    /// peer a parked intent names, are evidence of presence in their own right.
    /// A roster that omits them is therefore a departure, not a roster that
    /// simply has not mentioned them yet.
    func testAPeerKnownOnlyFromItsOwnHelloIsStillRemovedByTheRoster() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      relayChoiceDeadline: Self.graceForTests)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        XCTAssertEqual(rig.model.connection, .requesting)

        // The first roster this room ever sees, and it is empty.
        rig.roster([])
        await settle()
        await sleepPastGrace()
        await settle()
        XCTAssertEqual(rig.linkFramesSent, [])
        XCTAssertTrue(rig.serverUrls.isEmpty)
    }

    /// **A departed peer's measurements leave with it, and that is what makes
    /// the next peer's grace real.**
    ///
    /// `RelayNegotiator.peerLeft` drops the map of the last peer contributing
    /// one. Reaching it only from a `left` frame meant a roster-only departure
    /// left the room holding a settled choice made from numbers taken by
    /// somebody who had gone: the next peer's supposedly fresh grace returned
    /// instantly, before that peer could send anything, and its link was built
    /// on the departed peer's relay.
    func testARosterRemovalTakesThePeersMeasurementsWithIt() async {
        let stall = ProbeStall()
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          _ = pool
                          publish("near", 10)
                          await stall.wait()
                          publish("far", 90)
                      },
                      // Long enough that no deadline can elapse anywhere in this
                      // test: what it asserts is settling, not timing out.
                      relayChoiceDeadline: 1.5)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()

        // Its map names a relay this side has already measured, so a choice
        // EXISTS — and is not settled, because our own probing has not finished.
        // The gate stays shut, which is what puts these numbers on record
        // without the room having acted on them.
        relayRtt(rig, from: "zzz-web", ["near": 5])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty)

        rig.roster([])
        await settle()

        // The straggler answers. Our own measurement is now complete, so from
        // here a peer map is the ONLY thing missing from a settled choice.
        stall.release()
        await pause(0.1)
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "our own map alone is not a choice, however complete it is")

        // The replacement. Had the departed peer's map survived, this arrival
        // would settle on it instantly — `near` is common and measurement is
        // finished — and the link would be built on a relay chosen by somebody
        // who is not in the room.
        rig.announce("yyy-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["yyy-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "a full fresh grace, decided by nobody but the peer that is here")

        relayRtt(rig, from: "yyy-web", ["far": 4])
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:far.relayium.test:3478"]],
                       "the arriving peer's own map chose this, and it is not what the "
                           + "departed peer's map would have chosen")
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// **A peer that comes back is not still serving out its old wait.**
    ///
    /// The same id is the one supersede the grace's own identity check cannot
    /// see: abandoning the wait and re-arming it under that id left the FIRST
    /// wait parked and still matching, so the gate opened on a deadline that had
    /// started before the departure — the stale-deadline release the peer
    /// scoping exists to prevent, reached from the one direction it did not
    /// cover. `relayGraceToken` is what tells the two apart.
    func testARejoiningPeerWaitsOutAFreshDeadlineNotTheRemainsOfItsOldOne() async {
        let deadline: TimeInterval = 1.0
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      relayChoiceDeadline: deadline)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()

        // Most of the first grace is spent, then the peer drops out of the
        // roster and comes straight back under the same id.
        await pause(deadline * 0.6)
        rig.roster([])
        await settle()
        rig.roster(["zzz-web"])
        await settle()
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()

        // Past the FIRST grace's deadline, and well short of the second's.
        await pause(deadline * 0.7)
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "the abandoned wait's deadline must not open the gate for the wait "
                          + "that replaced it")
        XCTAssertEqual(rig.linkFramesSent, [])

        // The fresh grace runs out on its own, and only then does the room fall
        // back — a map-less peer's answer, arrived at once.
        await pause(deadline * 0.7)
        await settle()
        XCTAssertEqual(rig.serverUrls.count, 1,
                       "one link, built when this peer's own grace elapsed")
        XCTAssertEqual(rig.relayOnly, [true],
                       "and the fallback stays relay-only, pool folded in")
    }

    /// Both departure signals arrive for an ordinary disconnect, and in either
    /// order. The second one must find nothing left to do rather than undo the
    /// first, or settle the user's attempt a second time.
    func testAnExplicitLeftAndARosterRemovalTogetherStayIdempotent() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      relayChoiceDeadline: Self.graceForTests)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        // A map that names nothing this side measured, so no choice settles and
        // the room is still holding its gate when the peer goes.
        relayRtt(rig, from: "zzz-web", ["ghost": 5])
        await settle()

        rig.channels[0].fireText(#"{"type":"left","peer":"zzz-web"}"#)
        await settle()
        rig.roster([])
        await settle()
        await sleepPastGrace()
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty)
        XCTAssertEqual(rig.linkFramesSent, [])

        // And the room still works: the next peer gets one grace, one choice and
        // one link, not one per departure signal.
        rig.announce("yyy-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["yyy-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty, "a full fresh grace")

        relayRtt(rig, from: "yyy-web", ["near": 15, "far": 400])
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]])
        XCTAssertEqual(rig.relayOnly, [true])
        XCTAssertEqual(rig.transports.count, 1, "one establishment")
        XCTAssertEqual(rig.pairingLinkActivations, 1, "and one user-visible settlement")
    }

    // MARK: - P2. a roster is authority only over what was delivered BEFORE it

    /// **The hostile burst, under the policy that has no lane to fall back to.**
    ///
    /// The hub sends a self-only roster and the peer's capability hello lands
    /// behind it, in that delivery order — the ordinary shape whenever this side
    /// joins a code a moment before the peer's hello is relayed. Both are on the
    /// socket's delivery queue, so their order there is a fact; what is not a
    /// fact is when the room ACTS on them, because a roster crosses to the main
    /// actor through its own `Task` while the hello is recorded inline.
    ///
    /// The room therefore projects the older roster after the newer
    /// announcement, and a prune driven by that membership deleted an
    /// announcement the registry had already correctly taken. Under
    /// `terminateUnsupported` the peer had then said something and supported
    /// nothing, which is a decidable refusal: the room terminated a peer that
    /// had announced exact `link/1` one hop earlier, told the user it was
    /// unsupported, and closed the socket.
    ///
    /// Deterministic by construction: `fire` delivers inline, so the two hops
    /// are enqueued on the main actor in the order the hub sent them, and this
    /// asserts the room's answer rather than a scheduler's.
    func testAStaleSelfOnlyRosterDoesNotRefuseAPeerThatAnnouncedBehindIt() async {
        let rig = rig(config: stunOnlyConfig(), legacyFallback: .terminateUnsupported)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")

        // One burst, no settle between: the roster is DELIVERED first and the
        // hello second, and the room sees them in the other order.
        rig.roster([])
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()

        XCTAssertFalse(rig.model.unsupportedPairingPeer,
                       "a roster delivered BEFORE the hello refused the peer that sent it")
        XCTAssertTrue(rig.adopted.isEmpty, "and it must not have reached a legacy session either")
        XCTAssertFalse(rig.channels[0].closed,
                       "a refusal closes the socket; there was nothing to refuse")
        XCTAssertEqual(rig.model.connection, .establishing(sas: nil),
                       "the room proceeds toward the link the peer announced")
        XCTAssertEqual(rig.pairingLinkActivations, 1)
        XCTAssertEqual(rig.transports.count, 1)

        // And the answer is stable: nothing armed behind the burst turns it over.
        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait * 3)
        await settle()
        XCTAssertFalse(rig.model.unsupportedPairingPeer)
        XCTAssertTrue(rig.adopted.isEmpty)
    }

    /// The same burst under the SHIPPED policy, where the loss is silent rather
    /// than loud: a peer whose announcement was pruned supports neither `link/1`
    /// nor `text/1`, so it is not decidable at all and simply waits out
    /// `pairingCapabilityWait` — after which the room adopts a legacy session
    /// with a peer that had announced the unified wire.
    ///
    /// The genuinely later roster is delivered too, because that is what makes
    /// the window exist: it is the frame that arms the capability wait this test
    /// then advances past.
    func testAStaleSelfOnlyRosterDoesNotTimeAnAnnouncedPeerOutIntoLegacy() async {
        let rig = rig(config: stunOnlyConfig(), legacyFallback: .adoptLegacySession)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")

        rig.roster([])
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        XCTAssertEqual(rig.model.connection, .establishing(sas: nil),
                       "the announcement is the decision; the stale roster has no say in it")

        // The roster the hub really meant, behind both of them.
        rig.roster(["zzz-web"])
        await settle()
        rig.scheduler.advance(to: LinkWorkspaceModel.pairingCapabilityWait * 3)
        await settle()

        XCTAssertTrue(rig.adopted.isEmpty,
                      "a peer that announced link/1 timed out into the legacy lane")
        XCTAssertTrue(rig.handedBackBatches.isEmpty)
        XCTAssertEqual(rig.pairingLinkActivations, 1, "one unified link, and it stayed")
        XCTAssertEqual(rig.transports.count, 1)
        XCTAssertFalse(rig.model.unsupportedPairingPeer)
    }

    /// **Two roster frames, applied in the order the hop can really produce.**
    ///
    /// The socket cannot be made to hand the room a reversed pair — the rig's
    /// delivery is in order by construction and so is the queue behind it — so
    /// this drives `pairingRosterChanged` itself, at the stamps
    /// `rosterDelivered()` would have issued, through the exact fence production
    /// runs.
    ///
    /// The room is holding a parked link intent behind a shut relay gate, which
    /// is where all three losses are visible at once: the older frame would
    /// retire the peer's grace and its merged map, withdraw the ask through
    /// `LinkRoomRouter.rosterChanged`, and overwrite `roster` with a membership
    /// the room had already superseded. The peer's map then arrives and settles
    /// a choice nobody is waiting for, so the link is never built at all.
    func testARosterOlderThanTheOneAlreadyAppliedChangesNothing() async {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      // Long enough that no deadline elapses anywhere here: what
                      // opens this gate is the peer's map, and nothing else.
                      relayChoiceDeadline: 30)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        XCTAssertEqual(rig.model.connection, .requesting)
        XCTAssertTrue(rig.serverUrls.isEmpty, "the gate is shut: no map has met ours yet")

        // The newer frame, and then the older one the hub had sent before it.
        rig.model.pairingRosterChanged([Peer(id: "zzz-web", name: "peer")], deliveredAt: 20)
        await settle()
        rig.model.pairingRosterChanged([], deliveredAt: 19)
        await settle()

        XCTAssertEqual(rig.model.connection, .requesting,
                       "the room has not retreated from the peer it parked an intent for")

        // The one thing this room was waiting for. It can only settle if the
        // peer, its grace and its parked intent all survived the older frame.
        relayRtt(rig, from: "zzz-web", ["near": 12, "far": 80])
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]],
                       "an older roster took the peer's measurements with it")
        XCTAssertEqual(rig.relayOnly, [true])
        XCTAssertEqual(rig.transports.count, 1)
        XCTAssertEqual(rig.pairingLinkActivations, 1)

        // The fence is about ORDER, not about rejecting empty rosters: a
        // genuinely later frame that names nobody is still a departure, and the
        // room must not have been made deaf to one.
        rig.model.pairingRosterChanged([], deliveredAt: 21)
        await settle()
        XCTAssertEqual(rig.transports.count, 1,
                       "a later empty roster is heard; it simply has no live link to tear down")
    }

    /// The router half of the same reversal: the ask that already reached the
    /// wire.
    ///
    /// `pairingRosterChanged` hands `LinkRoomRouter.rosterChanged` the
    /// membership it applies, and the router withdraws a request whose target
    /// that membership does not name — which is exactly right for a roster the
    /// hub sent last, and exactly wrong for one it sent first. This side is the
    /// LARGER id, so the frame at stake is a `linkRequest` already sent and
    /// waiting for the peer's offer: the window the cancellation closes.
    func testARosterOlderThanTheOneAlreadyAppliedDoesNotWithdrawTheAsk() async {
        let rig = rig(config: stunOnlyConfig())
        await requestingPairedLink(rig)
        XCTAssertEqual(rig.linkFramesSent, ["request"])

        rig.model.pairingRosterChanged([Peer(id: "aaa-web", name: "peer")], deliveredAt: 40)
        await settle()
        rig.model.pairingRosterChanged([], deliveredAt: 39)
        await settle()
        XCTAssertEqual(rig.model.connection, .requesting,
                       "a roster older than the one already applied withdrew a live ask")
        XCTAssertTrue(rig.adopted.isEmpty)

        // And the authority itself is intact: the same empty membership,
        // delivered genuinely later, still withdraws it.
        rig.model.pairingRosterChanged([], deliveredAt: 41)
        await settle()
        XCTAssertNotEqual(rig.model.connection, .requesting,
                          "a genuinely later roster must still withdraw an ask it names nobody in")
    }

    // MARK: - R. the peer this side already chose, asking during the relay hold

    /// A room that has parked its link intent behind a shut relay gate, with the
    /// surface already claimed — the exact state a macOS pairing is in between
    /// the peer announcing and the relay choice being made.
    ///
    /// `setAvailableForInboundLink(false)` is not a contrivance: it is precisely
    /// what `TransferModule`'s observer writes here. Its predicate is
    /// `owner == nil || connection.isWatchingPairingRoom`, and `beginLinkAttempt`
    /// leaves `.watching` for `.requesting` as it parks — so from the instant
    /// this room decides which peer it wants until the gate opens, the surface
    /// answer is no.
    ///
    /// Nobody publishes a relay map, so the choice cannot settle and the gate
    /// cannot open until a test releases it. No timer, no sleep.
    private func heldGateWithAChosenPeer() async -> Rig {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")           // smaller id: this side is asked to offer
        rig.roster(["zzz-web"])
        // The surface is claimed, exactly as the app claims it.
        rig.model.setAvailableForInboundLink(false)
        rig.announce("zzz-web", [LINK_CAPABILITY])
        await settle()

        // The preconditions the tests below are worthless without.
        XCTAssertEqual(rig.model.connection, .requesting,
                       "this side has chosen its peer and says so")
        XCTAssertEqual(rig.linkFramesSent, [],
                       "and the gate is shut, so nothing it chose is on the wire")
        XCTAssertTrue(rig.transports.isEmpty)
        XCTAssertFalse(rig.model.acceptsInboundLinkNow,
                       "the general answer is no, which is what makes this a hold")
        return rig
    }

    /// **The defect this section exists for, at the wire.**
    ///
    /// A peer parked behind the relay gate has claimed the surface and published
    /// `requesting`, but has NOT reached `router.ensure` — so `LinkAdmission` is
    /// still `.idle`, and its own `.requesting(peer)` exemption cannot apply. The
    /// surface predicate is the whole decision there, and it says no. A request
    /// from the one peer this room was opened for was therefore answered `busy`,
    /// and that peer settled `.refused`: measured in the macOS acceptance run as
    /// a counterpart that minted a code, waited, asked six seconds later and was
    /// refused by the device it had paired with.
    ///
    /// Role-dependent, which is why it survived: only when the ids make this side
    /// the offerer does the peer send a request into the hold at all.
    func testAChosenPeersRequestDuringTheRelayHoldIsNotRefused() async {
        let rig = await heldGateWithAChosenPeer()

        rig.request(from: "zzz-web")
        await settle()

        XCTAssertEqual(rig.busyRefusalsSent, [],
                       "the room refused the one peer it was opened for")
        XCTAssertEqual(rig.model.connection, .requesting,
                       "and nothing about the refusal reached the screen either")
        // The hold still holds. Admitting the request claims and BUFFERS it in
        // the router; it must not build a transport on a relay nobody has chosen.
        XCTAssertTrue(rig.transports.isEmpty,
                      "an establishment was built before the relay choice")
        XCTAssertEqual(rig.linkFramesSent, [],
                       "and an SDP or request went out ahead of the choice")

        // Releasing the gate settles the SAME conversation — the buffered inbound
        // claim and this side's own parked intent are one link, not two.
        relayRtt(rig, from: "zzz-web", ["near": 15, "far": 400])
        await settle()

        XCTAssertEqual(rig.transports.count, 1, "exactly one establishment")
        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]],
                       "and it was built on the choice the gate was held for")
        XCTAssertEqual(rig.relayOnly, [true])
        XCTAssertEqual(rig.busyRefusalsSent, [])
    }

    /// The exemption is for ONE peer, compared exactly.
    ///
    /// Asked of the gate directly, because this is a statement about the gate
    /// rather than about a room: a second peer arriving mid-hold is refused by
    /// the resolved room before the gate is ever consulted, so a wire-level test
    /// would pass whether the reservation were exact or not.
    func testTheHoldsExemptionAdmitsOnlyTheChosenPeer() async {
        let rig = await heldGateWithAChosenPeer()

        XCTAssertTrue(rig.model.admitsInboundLink(from: "zzz-web"),
                      "the peer this side chose is not a stranger to it")
        XCTAssertFalse(rig.model.admitsInboundLink(from: "yyy-web"),
                       "a second peer took the surface the hold is reserving")
        XCTAssertFalse(rig.model.admitsInboundLink(from: ""),
                       "an unnamed peer matched a reservation")
    }

    /// The reservation dies with the intent it belongs to.
    ///
    /// `leave` is the terminal teardown; a reservation that survived it would
    /// keep one peer able to take a surface this module has given up.
    func testTheHoldsExemptionIsReleasedWithTheAttempt() async {
        let rig = await heldGateWithAChosenPeer()

        rig.model.leave()
        await settle()

        XCTAssertFalse(rig.model.admitsInboundLink(from: "zzz-web"),
                       "a reservation outlived the attempt that made it")
    }

    /// And with the peer, when the room is told it left.
    func testAChosenPeersDepartureReleasesItsExemption() async {
        let rig = await heldGateWithAChosenPeer()

        rig.channels[0].fireText(#"{"type":"left","peer":"zzz-web"}"#)
        await settle()

        XCTAssertFalse(rig.model.admitsInboundLink(from: "zzz-web"),
                       "a departed peer kept its reservation")
    }

    // MARK: - Q. the gate had already opened, and then that peer left

    /// A room whose gate has FULLY SETTLED and opened, and which has built
    /// nothing with it.
    ///
    /// This side's probes have finished and the peer's map named a relay both
    /// measured, so the choice can no longer change from here and the gate
    /// released on it. The peer has announced nothing, so the room has not
    /// latched onto it and no link intent exists — which leaves exactly the state
    /// this section is about: the decision is made, and the transport it was made
    /// for does not exist yet.
    ///
    /// The relay both peers minimise the worse RTT on is `near`; a replacement
    /// peer below chooses `far`, so which map decided is never ambiguous.
    private func settledGateWithNothingBuilt(deadline: TimeInterval = 30) async -> Rig {
        let rig = rig(config: pooledConfig(),
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "near" ? 10 : 90) }
                      },
                      relayChoiceDeadline: deadline)
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        relayRtt(rig, from: "zzz-web", ["near": 15, "far": 400])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "the choice is made, and nothing has been built with it yet")
        XCTAssertEqual(rig.linkFramesSent, [])
        return rig
    }

    /// **The precondition every test below rests on**: that setup really does
    /// open the gate.
    ///
    /// Without this the departure tests would be vacuous — holding is what a
    /// room does by default, so "nothing was built" proves nothing unless the
    /// gate is known to have been open beforehand.
    func testASettledGateBuildsTheNextLinkWithNoFurtherWait() async {
        let rig = await settledGateWithNothingBuilt()

        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()

        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]],
                       "the gate was open, so the link went out on the settled choice at once")
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// **The generation hole this commit closes.**
    ///
    /// The gate opened for a peer, that peer left before any transport was
    /// created, and the gate stayed open. Both departure paths cleared the
    /// departed peer's map — so no stale choice survived — but the OPEN GATE
    /// survived, and an open gate is the whole of the permission: the next peer's
    /// first legal `link/1` frame was assembled the instant the room latched onto
    /// it, on the configuration the departed peer's map had chosen, before its own
    /// map could possibly arrive.
    func testAnExplicitLeftRelocksAGateThatNothingHasBuiltOn() async {
        let rig = await settledGateWithNothingBuilt()

        rig.channels[0].fireText(#"{"type":"left","peer":"zzz-web"}"#)
        await settle()

        // The replacement announces `link/1`, so the room latches onto it and
        // wants a link right now. That ask is the frame the gate exists to hold.
        rig.announce("yyy-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["yyy-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "a full fresh grace, not the gate the departed peer left open")
        XCTAssertEqual(rig.linkFramesSent, [],
                       "and nothing that commits this side to a relay may be on the wire")
        XCTAssertEqual(rig.model.connection, .requesting,
                       "the wait is not hidden: this side has decided to ask, and says so")

        relayRtt(rig, from: "yyy-web", ["far": 4])
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:far.relayium.test:3478"]],
                       "the ARRIVING peer's map decided this, not the departed peer's")
        XCTAssertEqual(rig.relayOnly, [true])
        XCTAssertEqual(rig.transports.count, 1, "one establishment")
        XCTAssertEqual(rig.pairingLinkActivations, 1, "and one user-visible settlement")
    }

    /// The same hole through the departure signal the hub may not send at all.
    ///
    /// A peer can leave a pairing room's roster with no `left` frame behind it,
    /// and that removal has to re-lock the gate exactly as an explicit departure
    /// does — the state left behind is identical, and so is what the next peer
    /// would otherwise be built on.
    func testARosterOnlyDepartureRelocksAGateThatNothingHasBuiltOn() async {
        let rig = await settledGateWithNothingBuilt()

        rig.roster([])
        await settle()

        rig.announce("yyy-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["yyy-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "a roster removal is a departure, and it re-locks the gate too")
        XCTAssertEqual(rig.linkFramesSent, [])

        relayRtt(rig, from: "yyy-web", ["far": 4])
        await settle()
        XCTAssertEqual(rig.serverUrls, [["turn:far.relayium.test:3478"]])
        XCTAssertEqual(rig.relayOnly, [true])
        XCTAssertEqual(rig.transports.count, 1)
    }

    /// **A replacement that never sends a map waits out its OWN deadline.**
    ///
    /// The re-locked gate must be bounded by the same rule as the first one, or
    /// closing it would trade a link on the wrong relay for a link that is never
    /// built at all. What ends this wait is the arriving peer's own full grace,
    /// and what it lands on is the capped, pool-folded, relay-only fallback.
    func testAMapLessReplacementWaitsOutItsOwnFullDeadline() async {
        let rig = await settledGateWithNothingBuilt(deadline: Self.graceForTests)

        rig.roster([])
        await settle()

        rig.announce("yyy-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        rig.roster(["yyy-web"])
        await settle()
        XCTAssertTrue(rig.serverUrls.isEmpty, "its own grace is running, and it has not elapsed")

        await sleepPastGrace()
        await settle()
        XCTAssertEqual(rig.serverUrls,
                       [["stun:stun.relayium.test:3478",
                         "turn:legacy.relayium.test:3478",
                         "turn:near.relayium.test:3478",
                         "turn:far.relayium.test:3478"]],
                       "the departed peer's chosen configuration went with it: what a map-less "
                           + "peer lands on is the fallback, pool folded in")
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// **The gate may not reach a transport that already exists.**
    ///
    /// Once the room has built on its choice, the departure of the peer that
    /// contributed it is not a reason to re-lock anything: the configuration is
    /// snapshotted inside the assembly, the router is holding that
    /// establishment's queue, and parking its head would stall the frames the
    /// link is being built from. `LinkRoomRouter.holdHandoff` refuses, and a
    /// refusal leaves the room exactly as it was.
    func testARosterRemovalCannotRelockTheGateUnderALiveLink() async {
        let rig = await settledGateWithNothingBuilt()
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        guard let transport = rig.transports.first else {
            XCTFail("the settled gate should have let one link be built")
            return
        }
        transport.publish(peerId: "zzz-web", role: .responder)
        await settle()
        XCTAssertTrue(rig.model.connection.isOpen)

        // The roster stops naming the peer whose DataChannel is carrying the
        // session. That is not authority over the transport, and it must not
        // become authority over it by way of the gate either.
        rig.roster([])
        await settle()

        XCTAssertTrue(rig.model.connection.isOpen, "the live link was torn down")
        XCTAssertFalse(transport.isClosed)
        XCTAssertEqual(rig.transports.count, 1, "and nothing was rebuilt behind it")
        XCTAssertEqual(rig.serverUrls, [["turn:near.relayium.test:3478"]])
    }

    // MARK: - R. the join and the configuration are started together

    /// Every capability hello this side actually put on the wire, decoded.
    ///
    /// Decoded rather than substring-matched: `JSONEncoder` escapes the slash in
    /// `link/1`, so a text search for the constant finds nothing while the frame
    /// is right there.
    private func announcedCaps(_ rig: Rig, at index: Int = 0) -> [[String]] {
        rig.channels[index].sent.compactMap { text in
            guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                  envelope.type == SignalType.signal,
                  case let .object(root)? = envelope.data,
                  case let .array(caps)? = root["caps"] else { return nil }
            return caps.compactMap { entry in
                guard case let .string(value) = entry else { return nil }
                return value
            }
        }
    }

    /// **The room is joined while `/api/ice` is still in flight.**
    ///
    /// The join needs a code and a socket; it does not need an ICE server, a
    /// TURN credential or a pool. Awaiting the answer first spent a serial round
    /// trip before the hub had been told this side exists, which delayed the
    /// roster, the capability hellos and the peer's own announcement by exactly
    /// that much on both the creating and the joining side.
    ///
    /// Every assertion below is made with the answer still parked in the latch,
    /// so this is an ordering statement rather than a timing one. Under the
    /// serialised order it fails on the first line: no socket exists yet.
    func testTheRoomIsJoinedAndDiscoversItsPeerWhileTheICEAnswerIsStillInFlight() async {
        let latch = ICELatch()
        let rig = rig(config: pooledConfig(), iceLatches: ["AB12CD": latch],
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, 40) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()

        XCTAssertEqual(rig.joinedCodes, ["AB12CD"],
                       "the socket is opened for the code without waiting for its configuration")
        XCTAssertEqual(rig.ice.codes, ["AB12CD"], "and the fetch is in flight beside it")
        XCTAssertEqual(rig.model.connection, .watching(code: "AB12CD"))

        // Peer discovery is the whole point of joining early, and none of it
        // reads ICE: the hub's welcome, the roster, this side's capability
        // hello, and the peer's own announcement.
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()
        XCTAssertTrue(announcedCaps(rig).contains { $0.contains(LINK_CAPABILITY) },
                      "the capability hello reaches the wire a round trip sooner")

        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        XCTAssertEqual(rig.pairingLinkActivations, 1,
                       "the peer is decided, and the room claims its link, while the "
                       + "configuration is still coming")
        XCTAssertEqual(rig.model.peerLabel, "AB12CD")
    }

    /// **And nothing is built with it.**
    ///
    /// The other half of the same change, and the one that makes it safe: a peer
    /// that announces and offers inside the window is HELD by the room's relay
    /// gate — which now starts shut for every code room, because "is there
    /// anything to choose?" is itself unanswered until the fetch returns. No
    /// `link/1` frame leaves, no assembly is built, and when the answer lands
    /// the link is built on THIS room's configuration rather than on a default.
    func testNoTransportIsBuiltUntilTheICEAnswerArrives() async {
        let latch = ICELatch()
        let rig = rig(config: pooledConfig(), iceLatches: ["AB12CD": latch],
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, entry.id == "far" ? 20 : 300) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY])
        // The peer's map arrives BEFORE this room has a pool to merge it into.
        // Held by the inbox rather than dropped: a peer that has finished
        // probing sends its greet once, so losing it would decide this room's
        // relay from one side's measurements.
        relayRtt(rig, from: "zzz-web", ["near": 30, "far": 25])
        // And the peer offers on the same burst, which is the ordinary case
        // whenever the browser is the initiator.
        rig.offer(from: "zzz-web")
        await settle()

        XCTAssertTrue(rig.serverUrls.isEmpty,
                      "no transport may snapshot a configuration this room does not have")
        XCTAssertTrue(rig.linkFramesSent.isEmpty,
                      "and nothing that commits this side to one may reach the wire")
        XCTAssertEqual(rig.model.connection, .requesting,
                       "the screen says what is true: this side has decided to ask")

        latch.release()
        await settle()

        XCTAssertEqual(rig.serverUrls, [["turn:far.relayium.test:3478"]],
                       "the held offer is answered on the relay BOTH maps chose")
        XCTAssertEqual(rig.relayOnly, [true])
    }

    /// **A room that ended before its answer arrived does not take it, and the
    /// room that replaced it does not take it either.**
    ///
    /// This is the window the concurrent fetch opens: the answer now outlives
    /// the room it was started for, so a code left and re-watched could have the
    /// PREVIOUS code's credentials installed underneath it. The generation stamp
    /// and the room identity are what say no, and the two codes are given
    /// deliberately different pools so the assertion can tell them apart rather
    /// than merely observing that nothing happened.
    func testAStaleICEAnswerCannotConfigureTheRoomThatReplacedIt() async {
        let first = ICELatch()
        let rig = rig(config: pooledConfig(),
                      iceByCode: ["AB12CD": pooledConfig(), "EF34GH": poolOnlyConfig()],
                      iceLatches: ["AB12CD": first],
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, 40) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        await settle()

        // The user gives up on this code and enters another one. The first
        // room's socket is closed with it; its fetch is still parked.
        rig.model.leave()
        rig.model.dismiss()
        XCTAssertTrue(rig.channels[0].closed, "the abandoned room's socket is not left open")
        XCTAssertTrue(rig.model.watchPairingCode("EF34GH", legacyRole: .responder))
        await settle()
        XCTAssertEqual(rig.joinedCodes, ["AB12CD", "EF34GH"])

        // The FIRST code's answer finally lands, into a room that no longer
        // exists and beside a room it was never fetched for.
        first.release()
        await settle()

        // Now drive the SECOND room to a link and read which credentials it was
        // built on.
        rig.welcome("aaa-mac", at: 1)
        rig.roster(["zzz-web"], at: 1)
        rig.announce("zzz-web", [TEXT_CAPABILITY, LINK_CAPABILITY], at: 1)
        relayRtt(rig, from: "zzz-web", ["mine": 15], at: 1)
        await settle()

        XCTAssertEqual(rig.serverUrls, [["turn:mine.relayium.test:3478"]],
                       "the link is built on the code it was made for")
        XCTAssertFalse(rig.serverUrls.flatMap { $0 }.contains { $0.contains("near") || $0.contains("far") },
                       "and never on the abandoned code's pool")
    }

    /// A legacy peer decided inside the window still hands the room over with
    /// THIS room's configuration.
    ///
    /// The hand-over gives `adoptLegacyRoom` the room's `ICEConfig`, so the
    /// decision is held until there is one rather than made against nothing —
    /// and it is not a longer wait than before, because the window it defers
    /// inside is the same fetch the whole room used to sit behind before its
    /// capability window was even armed.
    func testALegacyPeerDecidedBeforeTheAnswerStillAdoptsWithThisRoomsConfig() async {
        let latch = ICELatch()
        let rig = rig(config: pooledConfig(), iceLatches: ["AB12CD": latch],
                      relayMeasure: { pool, publish in
                          for entry in pool { publish(entry.id, 40) }
                      })
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .initiator))
        await settle()
        rig.welcome("aaa-mac")
        rig.roster(["zzz-web"])
        rig.announce("zzz-web", [TEXT_CAPABILITY])
        await settle()

        XCTAssertTrue(rig.adopted.isEmpty,
                      "a hand-over with no configuration to hand over is not a hand-over")
        XCTAssertEqual(rig.model.connection, .watching(code: "AB12CD"))

        latch.release()
        await settle()

        XCTAssertEqual(rig.adopted.count, 1)
        XCTAssertEqual(rig.adopted.first?.peerId, "zzz-web")
        XCTAssertEqual(rig.adopted.first?.role, .initiator)
        XCTAssertEqual(rig.adopted.first?.mode, .text)
        XCTAssertFalse(rig.channels[0].closed,
                       "the legacy connection is built on this socket, so it stays open")
    }
}
