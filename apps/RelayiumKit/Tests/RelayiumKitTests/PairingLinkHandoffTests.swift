import Combine
import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **The iOS Cross-network composition, built the way the iOS app builds it.**
///
/// iOS `0.3.2` shipped a Cross-network screen that no current Mac or browser
/// would talk to: it announced `text/1` only in a pairing room, and both of them
/// refuse a pairing peer that does not announce exact `link/1`. The owner met it
/// as an up-to-date Mac saying an up-to-date iPhone was "running an older
/// version". Every model test was green, because no test built the graph the
/// app builds — the lesson WORKFLOW-LEARNINGS records for 2026-08-21.
///
/// `swift test` runs on macOS and cannot compile `apps/ios`. It can call what
/// that app calls: `TransferModule.crossNetwork`, `CrossNetworkPairingStart` and
/// `ForegroundSessionCoordinator(crossNetwork:)` are in this package for exactly
/// that reason. The link is built with the three answers
/// `AppEnvironment.makeCrossNetworkLinkWorkspaceModel` gives — the strict
/// fallback policy, the link-only hello and a registry of its own — and
/// `IOSSurfaceGuardTests` pins that the factory still gives them.
@MainActor
final class PairingLinkHandoffTests: XCTestCase {

    // MARK: - doubles

    private final class ManualScheduler: LinkRecoveryScheduler, @unchecked Sendable {
        private final class Handle: LinkRecoveryTimer { func cancel() {} }
        func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
            Handle()
        }
    }

    private final class StubPair: PairCodeClient {
        var fails = false
        func mint(token: String) async throws -> MintedCode {
            if fails { throw AccountError.network }
            return MintedCode(code: "483920", expiresAt: 4_102_444_800)
        }
    }

    private final class StubICE: ICEConfigClient, @unchecked Sendable {
        func fetch(code: String) async throws -> ICEConfig {
            ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:stun.relayium.test:3478"])])
        }
    }

    private final class QuietTransport: LinkRoutableInitialTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _onSAS: ((String) -> Void)?
        private var _onReady: ((LinkIdentity) -> Void)?
        private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
        private var _onError: ((Error) -> Void)?
        private var _onClose: (() -> Void)?
        var onSAS: ((String) -> Void)? {
            get { lock.withLock { _onSAS } } set { lock.withLock { _onSAS = newValue } }
        }
        var onReady: ((LinkIdentity) -> Void)? {
            get { lock.withLock { _onReady } } set { lock.withLock { _onReady = newValue } }
        }
        var onFrame: ((LinkLane, [UInt8]) -> Void)? {
            get { lock.withLock { _onFrame } } set { lock.withLock { _onFrame = newValue } }
        }
        var onError: ((Error) -> Void)? {
            get { lock.withLock { _onError } } set { lock.withLock { _onError = newValue } }
        }
        var onClose: (() -> Void)? {
            get { lock.withLock { _onClose } } set { lock.withLock { _onClose = newValue } }
        }
        func start() {}
        func receive(from: String, signal: JSONValue) {}
        func send(_ bytes: [UInt8], on lane: LinkLane) throws {}
        func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
        private var _closed = false
        var isClosed: Bool { lock.withLock { _closed } }
        func close() { lock.withLock { _closed = true } }

        func publish(peerId: String, role: Role, sas: String = "424242") {
            onSAS?(sas)
            onReady?(LinkIdentity(peerId: peerId, role: role, sas: sas,
                                  codecs: LinkCodecs(sendKey: [UInt8](repeating: 3, count: 32),
                                                     recvKey: [UInt8](repeating: 4, count: 32)),
                                  authenticationGeneration: 1))
        }
    }

    // MARK: - the graph under test

    @MainActor
    private final class Rig {
        let module: TransferModule
        let pair: StubPair
        var channels: [FakeWebSocketChannel] = []
        var joinedCodes: [String] = []
        var transports: [QuietTransport] = []

        init(module: TransferModule, pair: StubPair) {
            self.module = module
            self.pair = pair
        }

        var link: LinkWorkspaceModel { module.link }
        var code: PairingCodeModel { module.code }
        var start: CrossNetworkPairingStart { CrossNetworkPairingStart(module: module) }

        func welcome(_ selfId: String) {
            channels[0].fire(Envelope(type: SignalType.welcome, name: selfId))
        }
        func roster(_ ids: [String]) {
            channels[0].fire(Envelope(type: SignalType.peers,
                                      peers: ids.map { Peer(id: $0, name: "peer") }))
        }
        func announce(_ peerId: String, hello: JSONValue) {
            channels[0].fire(Envelope(type: SignalType.signal, from: peerId, data: hello))
        }
        func announce(_ peerId: String, _ caps: [String]) {
            announce(peerId, hello: .object(["caps": .array(caps.map(JSONValue.string))]))
        }

        /// Every capability hello this side actually put on the wire for `peer`.
        func hellosSent(to peer: String) -> [JSONValue] {
            channels[0].sent.compactMap { text in
                guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                      envelope.type == SignalType.signal, envelope.to == peer,
                      let data = envelope.data,
                      case let .object(fields) = data, case .array = fields["caps"] else { return nil }
                return data
            }
        }
    }

    private var directories: [URL] = []

    override func tearDown() async throws {
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        directories = []
    }

    /// `assembled: false` builds the same link and the same code and then uses
    /// the bare `TransferModule` initializer instead of `crossNetwork` — the
    /// composition an `App` initializer that forgot the callbacks would produce.
    private func rig(policy: LinkPairingFallbackPolicy = .terminateUnsupported,
                     hello: @escaping (Bool) -> JSONValue = linkOnlyCapsHello(linkRoomActive:),
                     assembled: Bool = true) throws -> Rig {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("pairing-handoff-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        directories.append(directory)

        var box: Rig?
        let link = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(
                linkRoomActive: { linkRoomActive(isCodelessRoom: false) }),
            receiveDirectory: { directory },
            requiresVerification: { false },
            iceClient: StubICE(),
            connectPairingSocket: { code in
                let channel = FakeWebSocketChannel()
                let socket = SignalingClient(channel: channel, name: "iPhone")
                channel.fireOpen()
                box?.channels.append(channel)
                box?.joinedCodes.append(code)
                return socket
            },
            pairingRoomHandle: LinkRoomHandle(),
            legacyFallback: policy,
            localHello: hello,
            scheduler: ManualScheduler(),
            assemble: { signaling, peerId, role, servers, relayOnly, generation,
                        directory, admission, signal in
                let transport = QuietTransport()
                box?.transports.append(transport)
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
        let pair = StubPair()
        let code = PairingCodeModel(client: pair)
        let module = assembled
            ? TransferModule.crossNetwork(link: link, code: code)
            : TransferModule(route: .pairingCode, link: link, code: code)
        let rig = Rig(module: module, pair: pair)
        box = rig
        return rig
    }

    private func settle(_ turns: Int = 20) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// What `DirectView.createCode` does, in its order: claim, then mint and
    /// watch.
    private func create(_ rig: Rig) async {
        XCTAssertTrue(rig.module.presence.beginSession(.pairingCode))
        await rig.start.createAndWatch(token: "token")
        await settle()
    }

    /// A peer that speaks `link/1` turns up on the code. `aaa` sorts below the
    /// peer, so this side offers and assembles as soon as the peer announces.
    private func linkPeerArrives(_ rig: Rig, peer: String = "zzz-mac") async {
        rig.welcome("aaa-iphone")
        rig.announce(peer, [LINK_CAPABILITY])
        rig.roster([peer])
        await settle()
    }

    // MARK: - 1. the iOS build now says what a strict Mac accepts

    /// The constant the whole defect hung on. `swift test` is hosted on macOS,
    /// so the iOS answer is asserted against the source the iOS build compiles.
    func testThePairingRoomCapabilityIsCompiledTrueForTheiOSBuild() throws {
        let source = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Realtime/PeerCapabilityRegistry.swift")
        XCTAssertTrue(source.contains("""
            #if os(macOS) || os(iOS)
            public let LINK_PAIRING_ROOM_SUPPORT = true
            #else
            public let LINK_PAIRING_ROOM_SUPPORT = false
            #endif
            """), """
            iOS must announce link/1 in a pairing-code room: macOS and the Web refuse a \
            pairing peer that does not, and tell the user it is an older version.
            """)
        XCTAssertTrue(linkRoomActive(isCodelessRoom: false))
    }

    /// **The owner's report, reproduced at the model and then closed.**
    ///
    /// Two rooms on one code. The first is this composition; the hello it
    /// actually puts on the wire is carried, unedited, into a second room built
    /// with the macOS policy. The Mac must link with it. The control is the
    /// hello iOS `0.3.2` sent — `text/1` and nothing else — which that same Mac
    /// must refuse, because that refusal is the sentence the owner was shown.
    func testTheHelloThisCompositionSendsIsAcceptedByAStrictMacAndTheOldOneIsNot() async throws {
        let phone = try rig()
        await create(phone)
        phone.welcome("zzz-iphone")
        phone.roster(["aaa-mac"])
        await settle()
        let sent = phone.hellosSent(to: "aaa-mac")
        let hello = try XCTUnwrap(sent.first, "the pairing room announced nothing to its peer")
        XCTAssertTrue(peerCaps(from: hello).contains(LINK_CAPABILITY),
                      "the iOS pairing room still does not announce link/1")

        let mac = try rig()
        await create(mac)
        mac.welcome("aaa-mac")
        mac.announce("zzz-iphone", hello: hello)
        mac.roster(["zzz-iphone"])
        await settle()
        XCTAssertFalse(mac.link.unsupportedPairingPeer,
                       "a strict Mac refused the hello this iOS composition sends")
        XCTAssertTrue(mac.link.hasSession, "a strict Mac did not begin a link with it")

        let oldMac = try rig()
        await create(oldMac)
        oldMac.welcome("aaa-mac")
        oldMac.announce("zzz-iphone", [TEXT_CAPABILITY])
        oldMac.roster(["zzz-iphone"])
        await settle()
        XCTAssertTrue(oldMac.link.unsupportedPairingPeer,
                      "the control lost its meaning: text/1 alone is what 0.3.2 sent and what a Mac refuses")
    }

    // MARK: - 2. connect first, and the two edges that keep the digits truthful

    func testCreatingACodeWatchesItsRoomAndALinkPeerOpensTheWorkspace() async throws {
        let rig = try rig()
        await create(rig)
        XCTAssertEqual(rig.code.state.code, "483920")
        XCTAssertEqual(rig.joinedCodes, ["483920"], "the minted code's room was not watched")
        XCTAssertEqual(rig.link.connection, .watching(code: "483920"))
        XCTAssertEqual(rig.module.pane, .connect,
                       "a waiting code is the pairing surface, not an empty workspace")

        await linkPeerArrives(rig)
        XCTAssertTrue(rig.link.hasSession)
        XCTAssertEqual(rig.module.pane, .link, "a link peer must open the unified workspace")
        XCTAssertEqual(rig.code.state, .idle,
                       "the spent code must be retired, or it reappears when the link ends")
        XCTAssertEqual(rig.module.presence.owner, .pairingCode,
                       "retiring the code released the surface under a live link")
    }

    /// The executable mutation. Identical objects, assembled WITHOUT
    /// `TransferModule.crossNetwork`: the spent digits stay on screen. If this
    /// ever passes `.idle`, the assertion above has stopped proving the wiring.
    func testWithoutTheSharedAssemblyTheSpentCodeStaysOnScreen() async throws {
        let rig = try rig(assembled: false)
        await create(rig)
        await linkPeerArrives(rig)
        XCTAssertTrue(rig.link.hasSession)
        XCTAssertEqual(rig.code.state.code, "483920",
                       "the control no longer fails without the wiring, so the real test proves nothing")
    }

    func testJoiningAdoptsTheDigitsAndWatchesThatRoom() async throws {
        let rig = try rig()
        rig.code.updateJoinCode("120 934")
        XCTAssertTrue(rig.code.canJoin)
        XCTAssertTrue(rig.module.presence.beginSession(.pairingCode))
        XCTAssertTrue(rig.start.joinAndWatch(code: rig.code.joinCode))
        await settle()
        XCTAssertEqual(rig.joinedCodes, ["120934"])
        XCTAssertEqual(rig.code.state, .showing("120934", expiresAt: 0),
                       "a joined code shows the same wait a minted one does, with no deadline")
        await linkPeerArrives(rig)
        XCTAssertEqual(rig.module.pane, .link)
        XCTAssertEqual(rig.code.state, .idle)
    }

    /// An internal iOS build at or below `0.3.2` is the one legacy pairing peer
    /// left. It is refused, the refusal stays readable, the digits and the
    /// socket go, and the surface is given back so the user can try again.
    func testAPeerWithoutLinkIsRefusedAndNothingIsLeftHalfOpen() async throws {
        let rig = try rig()
        await create(rig)
        rig.welcome("aaa-iphone")
        rig.announce("zzz-old-iphone", [TEXT_CAPABILITY])
        rig.roster(["zzz-old-iphone"])
        await settle()

        XCTAssertTrue(rig.link.unsupportedPairingPeer)
        XCTAssertEqual(rig.code.state, .idle, "digits stayed on screen over a closed room")
        XCTAssertTrue(rig.channels[0].closed, "the refused room's socket was left open")
        XCTAssertFalse(rig.link.hasSession)
        XCTAssertEqual(rig.module.pane, .connect)
        XCTAssertNil(rig.module.presence.owner, "a refusal must not keep the surface locked")
        XCTAssertTrue(rig.transports.isEmpty, "a transport was built for a peer that cannot link")

        rig.module.cancelPairingCode()
        XCTAssertFalse(rig.link.unsupportedPairingPeer, "Dismiss did not clear the refusal")
        XCTAssertTrue(rig.module.acceptsNewSession)
    }

    func testAFailedMintKeepsItsMessageAndDismissGivesTheSurfaceBack() async throws {
        let rig = try rig()
        rig.pair.fails = true
        XCTAssertTrue(rig.module.presence.beginSession(.pairingCode))
        let watching = await rig.start.createAndWatch(token: "token")
        XCTAssertFalse(watching)
        guard case .failed = rig.code.state else {
            return XCTFail("a failed mint must leave its own message: \(rig.code.state)")
        }
        XCTAssertTrue(rig.joinedCodes.isEmpty, "a room was opened for a code that was never minted")
        XCTAssertFalse(rig.module.acceptsNewSession,
                       "a second start was allowed over an unread failure")
        rig.module.cancelPairingCode()
        await settle()
        XCTAssertNil(rig.module.presence.owner)
        XCTAssertTrue(rig.module.acceptsNewSession)
    }

    // MARK: - 3. the room admits the peer its code names

    /// Invariant (d). Creating a code claims the surface BEFORE the room is
    /// watched, so "nothing owns this module" is false for the whole wait. Fed
    /// to the inbound gate unchanged, that refused every request from the peer
    /// the room exists for — about half of all pairings, decided by which side
    /// the hub gave the smaller id. `TransferModule` separates the two
    /// questions; this is that separation, observed from the iOS composition.
    func testAWaitingCodeAdmitsAnInboundLinkAlthoughTheSurfaceIsOwned() async throws {
        let rig = try rig()
        XCTAssertTrue(rig.link.acceptsInboundLinkNow)
        await create(rig)
        XCTAssertEqual(rig.module.presence.owner, .pairingCode)
        XCTAssertTrue(rig.link.acceptsInboundLinkNow,
                      "a watched pairing room answered busy to the peer its own code names")

        await linkPeerArrives(rig)
        XCTAssertFalse(rig.link.acceptsInboundLinkNow,
                       "a second unsolicited link was admissible while one is held")
    }

    // MARK: - 4. leaving the foreground

    private func coordinator(_ rig: Rig) -> ForegroundSessionCoordinator {
        let file = RealtimeSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                        makeConnection: { _, _, _ in throw AccountError.network })
        let text = RealtimeTextSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                            makeConnection: { _, _, _ in throw AccountError.network })
        return ForegroundSessionCoordinator(file: file, text: text, link: nil,
                                            crossNetwork: rig.module)
    }

    /// A code that is only waiting holds an open room socket. Backgrounded, the
    /// digits, the room and the surface all go — a code left on screen would
    /// name a room this app has already left.
    func testBackgroundingAWaitingCodeRetiresTheDigitsTheRoomAndTheSurface() async throws {
        let rig = try rig()
        let foreground = coordinator(rig)
        await create(rig)

        foreground.phaseChanged(to: .inactive)
        XCTAssertEqual(rig.code.state.code, "483920",
                       "`.inactive` is a share sheet or a picker, not the user leaving")

        foreground.phaseChanged(to: .background)
        await settle()
        XCTAssertEqual(rig.code.state, .idle)
        XCTAssertTrue(rig.channels[0].closed)
        XCTAssertNil(rig.module.presence.owner)
        XCTAssertEqual(foreground.interruption, L10n.t(.directInterrupted))
    }

    /// A link that reached a peer is LEFT, not dismissed: its ending stays on
    /// screen to be read, exactly as the same-network link's does.
    func testBackgroundingALinkLeavesItAndKeepsTheEndingReadable() async throws {
        let rig = try rig()
        let foreground = coordinator(rig)
        await create(rig)
        await linkPeerArrives(rig)
        let transport = try XCTUnwrap(rig.transports.first)
        transport.publish(peerId: "zzz-mac", role: .responder)
        await settle()
        XCTAssertTrue(rig.link.connection.isOpen)

        foreground.phaseChanged(to: .background)
        await settle()
        XCTAssertFalse(rig.link.connection.isActive)
        XCTAssertTrue(rig.link.hasSession, "the ending was dismissed before anybody could read it")
        XCTAssertEqual(rig.module.presence.owner, .pairingCode)
        XCTAssertEqual(foreground.interruption, L10n.t(.linkInterrupted))

        // Nothing is left to end, so a second transition says nothing new.
        foreground.dismissInterruption()
        foreground.phaseChanged(to: .background)
        XCTAssertNil(foreground.interruption)
    }

    func testBackgroundingAnIdleModuleDoesNothing() async throws {
        let rig = try rig()
        let foreground = coordinator(rig)
        foreground.phaseChanged(to: .background)
        XCTAssertNil(foreground.interruption)
        XCTAssertTrue(rig.module.acceptsNewSession)
    }
}
