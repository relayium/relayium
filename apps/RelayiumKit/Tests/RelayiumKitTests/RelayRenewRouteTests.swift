import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Renewal driven end to end through the PRODUCTION composition:
/// `LinkWorkspaceModel` → `LinkSessionFactory.make` → `LinkSessionRuntime` →
/// `LinkLaneOwner` → `RelayRenewController` → the transport's input
/// subscription → the room socket.
///
/// ## Why this suite exists, and the rule it is written under
///
/// Twice, a renewal checkpoint compiled, passed its tests and could not renew.
/// First the model's hooks had no caller; then the controller existed but the
/// transport's three inputs had no subscriber, so a real signal, a real
/// candidate and a real selected-pair change each reached a nil optional. Both
/// times the engine suites were green, because they call the engine's inputs
/// directly — which is exactly the composition the app was missing.
///
/// So nothing here calls the engine or the controller. Every input enters the
/// way production delivers it: a frame on the fake socket, a frame on the
/// transport's lane, or an event fired through the subscription the controller
/// itself installed. Every assertion is on something that left the system: a
/// frame on the socket, a call on the transport, or the model's published
/// deadline. If the composition is cut anywhere, these fail.
@MainActor
final class RelayRenewRouteTests: XCTestCase {

    // MARK: - doubles

    /// The ONLY fake below the model: a transport with no PeerConnection. It
    /// implements the renewal seams as a recorder, and it holds whatever
    /// subscription the controller installs — it cannot install one itself.
    private final class RouteTransport: LinkRoutableInitialTransport, RelayRenewLinkTransport,
                                        @unchecked Sendable {
        private let lock = NSLock()
        var onSAS: ((String) -> Void)?
        var onReady: ((LinkIdentity) -> Void)?
        var onError: ((Error) -> Void)?
        var onClose: (() -> Void)?
        private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
        var onFrame: ((LinkLane, [UInt8]) -> Void)? {
            get { lock.lock(); defer { lock.unlock() }; return _onFrame }
            set { lock.lock(); _onFrame = newValue; lock.unlock() }
        }
        var negotiatedMaxMessageBytes: Double { DEFAULT_MAX_FRAME_BYTES }
        private var _closed = false
        private var _sentText: [[UInt8]] = []

        func start() {}
        func receive(from: String, signal: JSONValue) {}
        func send(_ bytes: [UInt8], on lane: LinkLane) throws {
            lock.lock(); defer { lock.unlock() }
            if lane == .text { _sentText.append(bytes) }
        }
        func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
        var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return _closed }
        func close() { lock.lock(); _closed = true; lock.unlock() }
        func deliver(_ lane: LinkLane, _ bytes: [UInt8]) { onFrame?(lane, bytes) }

        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 3, count: 32),
                                recvKey: [UInt8](repeating: 4, count: 32))
        func publish(peerId: String, role: Role) -> LinkIdentity {
            let identity = LinkIdentity(peerId: peerId, role: role, sas: "424242",
                                        codecs: codecs, authenticationGeneration: 1)
            onSAS?("424242")
            onReady?(identity)
            return identity
        }

        // ── the renewal seams ──
        var renewalBaselinePin: RelayRenewSDPPin? = relayRenewPin(sdp: RouteTransport.sdp("AAAA"))
        private var _inputs: RelayRenewTransportInputs?
        private var _installs = 0
        private var _signals: [JSONValue] = []
        private var _appliedServers: [[String]] = []
        private var _remoteDescriptions: [String] = []
        var offerUfrag = "NEW1"

        var inputs: RelayRenewTransportInputs? { lock.lock(); defer { lock.unlock() }; return _inputs }
        var installs: Int { lock.lock(); defer { lock.unlock() }; return _installs }
        var renewalSignals: [RelayRenewMessage] {
            lock.lock(); defer { lock.unlock() }
            return _signals.compactMap { parsedRelayRenewEnvelope($0)?.message }
        }
        var appliedServers: [[String]] { lock.lock(); defer { lock.unlock() }; return _appliedServers }
        var probeFramesSent: [RelayRenewProbeFrame] {
            lock.lock(); defer { lock.unlock() }
            return _sentText.compactMap(parsedRelayRenewProbeFrame)
        }

        func installRenewalInputs(_ inputs: RelayRenewTransportInputs?) {
            lock.lock(); _inputs = inputs; if inputs != nil { _installs += 1 }; lock.unlock()
        }
        func setRenewalEpochInFlight(_ inFlight: Bool) {}
        func noteRenewalAuthenticated() {}
        func sendRenewalSignal(_ signal: JSONValue) {
            lock.lock(); _signals.append(signal); lock.unlock()
        }
        func renewalApplyConfiguration(_ servers: [RTCIceServer],
                                       completion: @escaping (Bool) -> Void) {
            lock.lock(); _appliedServers.append(servers.flatMap(\.urlStrings)); lock.unlock()
            completion(true)
        }
        func renewalCreateOffer(completion: @escaping (String?) -> Void) {
            completion(RouteTransport.sdp(offerUfrag))
        }
        func renewalCreateAnswer(completion: @escaping (String?) -> Void) {
            completion(RouteTransport.sdp(offerUfrag))
        }
        func renewalApplyRemoteDescription(sdp: String, type: RelayRenewSDPType,
                                           completion: @escaping (Bool) -> Void) {
            lock.lock(); _remoteDescriptions.append(sdp); lock.unlock()
            completion(true)
        }
        func renewalAddRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: UInt32?) {}

        static func sdp(_ ufrag: String) -> String {
            "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
                + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
                + "a=ice-ufrag:\(ufrag)\r\na=fingerprint:sha-256 AB:CD:EF:01\r\n"
                + "a=setup:actpass\r\na=mid:0\r\n"
        }
    }

    private final class Scheduler: LinkRecoveryScheduler, @unchecked Sendable {
        private final class Handle: LinkRecoveryTimer {
            let at: TimeInterval
            let body: () -> Void
            var cancelled = false
            init(at: TimeInterval, body: @escaping () -> Void) { self.at = at; self.body = body }
            func cancel() { cancelled = true }
        }
        private let lock = NSLock()
        private var handles: [Handle] = []
        private var clock: TimeInterval = 0
        func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
            lock.lock(); defer { lock.unlock() }
            let handle = Handle(at: clock + delay, body: body)
            handles.append(handle)
            return handle
        }
        func advance(to time: TimeInterval) {
            lock.lock()
            clock = max(clock, time)
            let due = handles.filter { !$0.cancelled && $0.at <= clock }.sorted { $0.at < $1.at }
            handles.removeAll { $0.cancelled || $0.at <= clock }
            lock.unlock()
            for handle in due { handle.body() }
        }
    }

    private final class StubICE: ICEConfigClient, @unchecked Sendable {
        let config: ICEConfig
        init(_ config: ICEConfig) { self.config = config }
        func fetch(code: String) async throws -> ICEConfig { config }
    }

    /// A clock the test moves. Read from the controller's queue as well as the
    /// main actor, which is the point of `LockedValue`.
    private let wallClock = LockedValue<Date>(Date(timeIntervalSince1970: 1_000_000))
    private var dir: URL!
    private let peer = "zzz-web"
    private let selfId = "aaa-mac"

    override func setUpWithError() throws {
        wallClock.set(Date(timeIntervalSince1970: 1_000_000))
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("renew-route-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    private final class Rig {
        var model: LinkWorkspaceModel!
        let scheduler = Scheduler()
        var channel: FakeWebSocketChannel?
        var transports: [RouteTransport] = []
        /// The seam production handed the factory — the same value
        /// `LinkSessionRuntime.reportRebuilds` calls for a `link:§8` rebuild.
        var seam: LinkRenewalSeam?

        /// Every `ice-renew` this side put on the ROOM SOCKET.
        var renewRequests: [(round: UInt32, rid: UInt32)] {
            (channel?.sent ?? []).compactMap { text in
                guard let e = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                      e.type == RELAY_RENEW_REQUEST_TYPE, case let .object(d)? = e.data,
                      let round = renewUInt32(d["round"]), let rid = renewUInt32(d["rid"])
                else { return nil }
                return (round, rid)
            }
        }
        func fire(_ envelope: Envelope) { channel?.fire(envelope) }
    }

    private func relayed(expiresIn: TimeInterval, host: String = "relay.example") -> ICEConfig {
        let expiry = Int(wallClock.get().timeIntervalSince1970 + expiresIn)
        return ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:\(host):3478"],
                                                      username: "\(expiry):abc",
                                                      credential: "zzz")])
    }

    private func rig(config: ICEConfig) -> Rig {
        let rig = Rig()
        let dir = self.dir!
        let clock = wallClock
        rig.model = LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(linkRoomActive: { true }),
            receiveDirectory: { dir },
            requiresVerification: { false },
            iceClient: StubICE(config),
            connectPairingSocket: { [weak rig] _ in
                let channel = FakeWebSocketChannel()
                let socket = SignalingClient(channel: channel, name: "Mac")
                channel.fireOpen()
                rig?.channel = channel
                return socket
            },
            pairingRoomHandle: LinkRoomHandle(),
            legacyFallback: .terminateUnsupported,
            scheduler: rig.scheduler,
            now: { clock.get() },
            relayMeasure: { _, _ in },
            relayChoiceDeadline: 30,
            // THE PRODUCTION FACTORY. Only the transport underneath it is fake;
            // the renewal seam is handed over exactly as `liveAssembly` does.
            assemble: { [weak rig] signaling, peerId, role, servers, relayOnly, generation,
                         directory, admission, signal, renewal in
                let transport = RouteTransport()
                rig?.transports.append(transport)
                rig?.seam = renewal
                return LinkSessionFactory.make(
                    signaling: signaling, peerId: peerId, role: role, iceServers: servers,
                    iceTransportPolicy: relayOnly ? .relay : .all,
                    authenticationGeneration: generation,
                    receiveDirectory: directory, admission: admission,
                    deadlines: LinkDeadlines(), initialSignal: signal,
                    renewal: renewal,
                    buildInitialTransport: { _, _, _, _, _, _, _ in transport },
                    buildReplacementFactory: { _, _, _, _ in
                        { _ in throw LinkTransportError.notReady }
                    })
            })
        return rig
    }

    private func settle(_ turns: Int = 40) async {
        for _ in 0..<turns {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    /// Join the code room and publish a link to a peer with the given hello.
    @discardableResult
    private func openLink(_ rig: Rig,
                          peerCaps: [String] = [LINK_CAPABILITY, RELAY_RENEW_CAPABILITY],
                          publish: Bool = true) async throws -> RouteTransport? {
        XCTAssertTrue(rig.model.watchPairingCode("AB12CD", legacyRole: .responder))
        await settle()
        rig.fire(Envelope(type: SignalType.welcome, name: selfId))
        rig.fire(Envelope(type: SignalType.signal, from: peer,
                          data: .object(["caps": .array(peerCaps.map(JSONValue.string))])))
        rig.fire(Envelope(type: SignalType.peers, peers: [Peer(id: peer, name: "peer")]))
        await settle()
        guard publish else { return nil }
        let transport = try XCTUnwrap(rig.transports.first, "the production factory built no link")
        _ = transport.publish(peerId: peer, role: .initiator)
        await settle()
        return transport
    }

    /// REAL user data: an inbound batch the user accepts, then its bytes — in
    /// through the transport's file lane, up through the real drivers.
    private func moveRealFileBytes(_ rig: Rig, _ transport: RouteTransport) async throws {
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 4, count: 32))
        let data = [UInt8](repeating: 7, count: 2048)
        let meta = FileMeta(name: "a.bin", size: data.count)
        for frame in try sender.batchFrames([meta]) { transport.deliver(.file, frame) }
        await settle()
        rig.model.acceptInboundBatch()
        await settle()
        for frame in try sender.dataFrames([(meta: meta, data: data)]) {
            transport.deliver(.file, frame)
        }
        await settle()
    }

    private func sign(_ message: RelayRenewMessage, _ transport: RouteTransport) -> RelayRenewEnvelope {
        let payload = relayRenewPayload(message, from: peer, to: selfId)
        return RelayRenewEnvelope(message: message,
                                  auth: signResume(key: transport.codecs.resumeAuthKey,
                                                   payload: payload))
    }

    // MARK: - A7: the transport's inputs are really subscribed

    /// Publishing a link makes the controller subscribe to the transport. This
    /// is the assertion whose absence let two checkpoints ship a client that
    /// could not renew.
    func testPublishingALinkSubscribesToTheTransportsRenewalInputs() async throws {
        let rig = rig(config: relayed(expiresIn: 3600))
        let transport = try await XCTUnwrapAsync(try await openLink(rig))
        XCTAssertEqual(transport.installs, 1, "exactly one subscription, installed by production")
        XCTAssertNotNil(transport.inputs)
    }

    /// A same-network style room with no relayed bound subscribes to nothing
    /// and makes no backend call of its own.
    func testAStunOnlyRoomNeverSubscribesOrAsks() async throws {
        let stun = ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:stun.example:3478"])])
        let rig = rig(config: stun)
        let transport = try await XCTUnwrapAsync(try await openLink(rig))
        try await moveRealFileBytes(rig, transport)
        rig.scheduler.advance(to: 4000)
        await settle()
        XCTAssertEqual(transport.installs, 0)
        XCTAssertTrue(rig.renewRequests.isEmpty)
    }

    /// An authenticated `prepare` delivered THROUGH THE SUBSCRIPTION reaches
    /// the engine and produces a round request on the room socket.
    func testASignalThroughTheRealSubscriptionReachesTheServerRequest() async throws {
        let rig = rig(config: relayed(expiresIn: 3600))
        let transport = try await XCTUnwrapAsync(try await openLink(rig))
        try await moveRealFileBytes(rig, transport)

        let inputs = try XCTUnwrap(transport.inputs)
        inputs.signal(sign(.prepare(epoch: 1), transport))
        await settle()

        XCTAssertEqual(rig.renewRequests.map(\.round), [1],
                       "the peer's prepare must reach `ice-renew` on the socket")
        XCTAssertEqual(transport.renewalSignals.first, .prepare(epoch: 1),
                       "and this side answers on the transport")
    }

    /// The same signal on an IDLE link asks the server for nothing (A2, on the
    /// real route rather than the engine).
    func testAnIdleLinkConsentsToNothingOnTheRealRoute() async throws {
        let rig = rig(config: relayed(expiresIn: 3600))
        let transport = try await XCTUnwrapAsync(try await openLink(rig))
        let inputs = try XCTUnwrap(transport.inputs)
        inputs.signal(sign(.prepare(epoch: 1), transport))
        await settle()
        XCTAssertTrue(rig.renewRequests.isEmpty)
        XCTAssertTrue(transport.renewalSignals.isEmpty)
    }

    // MARK: - the whole migration, through the real route

    /// Margin → request → grant over the socket → `setConfiguration` with the
    /// renewed servers → signed offer → answer → selected pair through the
    /// subscription → probe on the text lane → ack through the REAL lane demux
    /// → the model's published deadline moves.
    func testAFullMigrationMovesTheDeadlineOnlyAtCommit() async throws {
        let rig = rig(config: relayed(expiresIn: 3600))
        let transport = try await XCTUnwrapAsync(try await openLink(rig))
        let original = try XCTUnwrap(rig.model.relayDeadline)
        try await moveRealFileBytes(rig, transport)

        // 50 minutes into a one-hour grant (3540 s boundary, margin 600 s).
        wallClock.set(Date(timeIntervalSince1970: 1_000_000 + 2940))
        try await moveRealFileBytes(rig, transport)
        rig.scheduler.advance(to: 2940)
        await settle()
        XCTAssertEqual(rig.renewRequests.map(\.round), [1], "the margin must reach the socket")
        let rid = try XCTUnwrap(rig.renewRequests.first?.rid)
        XCTAssertEqual(transport.renewalSignals, [.prepare(epoch: 1)])

        // The grant arrives ON THE SOCKET, as `ice-grant`.
        let freshExpiry = Int(wallClock.get().timeIntervalSince1970 + 3600)
        rig.fire(Envelope(type: RELAY_RENEW_GRANT_TYPE, data: .object([
            "status": .string("granted"), "round": .number(1), "rid": .number(Double(rid)),
            "iceServers": .array([.object([
                "urls": .array([.string("turn:renewed.example:3478")]),
                "username": .string("\(freshExpiry):new"), "credential": .string("yyy")])])])))
        await settle()
        XCTAssertEqual(transport.appliedServers, [["turn:renewed.example:3478"]],
                       "setConfiguration must receive the RENEWED servers")
        XCTAssertEqual(rig.model.relayDeadline, original, "a grant is not a commit")
        XCTAssertTrue(transport.renewalSignals.contains(.ready(epoch: 1, round: 1)))

        let inputs = try XCTUnwrap(transport.inputs)
        inputs.signal(sign(.ready(epoch: 1, round: 1), transport))
        await settle()
        guard case .sdp(1, 1, .offer, _)? = transport.renewalSignals.last else {
            return XCTFail("the established initiator must offer: \(transport.renewalSignals)")
        }
        inputs.signal(sign(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                sdp: RouteTransport.sdp("REM1")), transport))
        await settle()
        XCTAssertEqual(rig.model.relayDeadline, original, "applied descriptions are not a commit")

        // The selected pair, through the subscription.
        let local = "candidate:1 1 udp 1 203.0.113.9 5000 typ relay raddr 0.0.0.0 rport 0"
            + " generation 0 ufrag NEW1 network-cost 999"
        inputs.selectedCandidatePair(local, "")
        await settle()
        let probe = try XCTUnwrap(transport.probeFramesSent.first { $0.type == .probe },
                                  "observation must put a probe on the TEXT lane")
        XCTAssertEqual(rig.model.relayDeadline, original, "observation is not a commit")

        // The peer's ack, in through the text lane and the real front demux.
        let payload = relayRenewProbePayload(type: .ack, from: peer, to: selfId,
                                             epoch: 1, round: 1, nonce: probe.nonce)
        let tag = try XCTUnwrap(Data(base64Encoded: signResume(key: transport.codecs.resumeAuthKey,
                                                               payload: payload)))
        let ack = try XCTUnwrap(relayRenewProbeFrame(type: .ack, epoch: 1, round: 1,
                                                     nonce: probe.nonce, tag: Array(tag)))
        transport.deliver(.text, ack)
        await settle()

        let renewed = try XCTUnwrap(rig.model.relayDeadline)
        XCTAssertGreaterThan(renewed.deadlineAt, original.deadlineAt,
                             "commit — and only commit — moves the published deadline")
        XCTAssertEqual(renewed.expiresAt, Date(timeIntervalSince1970: TimeInterval(freshExpiry)),
                       "derived from the configuration actually received")
        XCTAssertTrue(rig.model.connection.isOpen, "same link, same SAS, still open")

        // The OLD terminal timer must no longer end the link.
        wallClock.set(Date(timeIntervalSince1970: 1_000_000 + 3541))
        rig.scheduler.advance(to: 3541)
        await settle()
        XCTAssertTrue(rig.model.connection.isOpen,
                      "the replaced credential's deadline must not still fire")
    }

    // MARK: - A9: the margin can open before the controller exists

    /// The margin timer is armed with the room's credential — before anybody
    /// has opened a link. A link that publishes INSIDE the margin must renew.
    func testAMarginThatOpenedBeforeTheLinkExistedIsNotLost() async throws {
        let rig = rig(config: relayed(expiresIn: 3600))
        try await openLink(rig, publish: false)
        XCTAssertTrue(rig.transports.first?.inputs == nil)

        // The margin opens with NO published link and therefore no controller.
        wallClock.set(Date(timeIntervalSince1970: 1_000_000 + 2940))
        rig.scheduler.advance(to: 2940)
        await settle()
        XCTAssertTrue(rig.renewRequests.isEmpty)

        // The link publishes afterwards, and real data moves.
        let transport = try XCTUnwrap(rig.transports.first)
        _ = transport.publish(peerId: peer, role: .initiator)
        await settle()
        try await moveRealFileBytes(rig, transport)

        XCTAssertEqual(rig.renewRequests.map(\.round), [1],
                       "a controller built inside an open margin must act on it")
    }

    // MARK: - A10: unsolicited initiation needs the peer's announcement

    /// A peer that never announced `relay-renew/1` is sent no renewal frame and
    /// the server is asked for nothing: exactly today's behaviour, truthfully.
    func testAPeerThatNeverAnnouncedRenewalIsNeverAsked() async throws {
        let rig = rig(config: relayed(expiresIn: 3600))
        let transport = try await XCTUnwrapAsync(try await openLink(rig, peerCaps: [LINK_CAPABILITY]))
        wallClock.set(Date(timeIntervalSince1970: 1_000_000 + 2940))
        try await moveRealFileBytes(rig, transport)
        rig.scheduler.advance(to: 2940)
        await settle()
        XCTAssertTrue(rig.renewRequests.isEmpty)
        XCTAssertTrue(transport.renewalSignals.isEmpty, "an older peer hears nothing")

        // …and its original deadline still ends it truthfully.
        wallClock.set(Date(timeIntervalSince1970: 1_000_000 + 3540))
        rig.scheduler.advance(to: 3540)
        await settle()
        XCTAssertEqual(rig.model.connection, .ended(.relayExpired))
    }

    /// The hint gates only what this side STARTS. An authenticated inbound
    /// `prepare` from a peer that never announced is still honoured.
    func testAnAuthenticatedPrepareIsHonouredWithoutTheAnnouncement() async throws {
        let rig = rig(config: relayed(expiresIn: 3600))
        let transport = try await XCTUnwrapAsync(try await openLink(rig, peerCaps: [LINK_CAPABILITY]))
        try await moveRealFileBytes(rig, transport)
        try XCTUnwrap(transport.inputs).signal(sign(.prepare(epoch: 1), transport))
        await settle()
        XCTAssertEqual(rig.renewRequests.map(\.round), [1])
    }

    // MARK: - one controller across a same-authentication rebuild

    /// A `link:§8` rebuild hands the SAME controller a new transport: the old
    /// subscription is removed, the new one installed, and the epoch counter
    /// continues — so an aborted epoch's signatures stay dead.
    func testASameAuthenticationRebuildKeepsOneControllerAndItsEpochCounter() async throws {
        let rig = rig(config: relayed(expiresIn: 3600))
        let first = try await XCTUnwrapAsync(try await openLink(rig))
        try await moveRealFileBytes(rig, first)
        try XCTUnwrap(first.inputs).signal(sign(.prepare(epoch: 3), first))
        await settle()
        XCTAssertEqual(first.renewalSignals, [.prepare(epoch: 3)])

        // The rebuilt transport, published under the SAME authentication.
        let rebuilt = RouteTransport()
        let identity = LinkIdentity(peerId: peer, role: .initiator, sas: "424242",
                                    codecs: first.codecs, authenticationGeneration: 1)
        let lanes = LinkLaneOwner(identity: identity, transport: rebuilt,
                                  destinationFactory: { _, _ in throw LinkTransportError.notReady },
                                  onTextEvent: { _ in }, onFileEvent: { _ in })
        // Exactly the call `LinkSessionRuntime.reportRebuilds` makes once the
        // lanes have taken a replacement over.
        try XCTUnwrap(rig.seam).published(rebuilt, lanes, identity)
        await settle()

        XCTAssertNil(first.inputs, "the replaced transport is unsubscribed")
        XCTAssertEqual(rebuilt.installs, 1, "and the new one subscribed")

        // Epoch 3's signatures are dead; only a HIGHER epoch is acted on.
        try XCTUnwrap(rebuilt.inputs).signal(sign(.prepare(epoch: 3), rebuilt))
        await settle()
        XCTAssertTrue(rebuilt.renewalSignals.isEmpty, "a reset counter would have accepted this")
        try XCTUnwrap(rebuilt.inputs).signal(sign(.prepare(epoch: 4), rebuilt))
        await settle()
        XCTAssertEqual(rebuilt.renewalSignals, [.prepare(epoch: 4)])

        // An event still in flight from the OLD transport's closures is fenced.
        XCTAssertNil(first.inputs)
    }

    // MARK: - the one link of the route a rig cannot reach

    /// Every test above injects `assemble`, so `liveAssembly` — the production
    /// value of that seam — is the single place this suite does not execute: it
    /// builds a real `RTCPeerConnection` that cannot publish without a peer.
    /// A seam dropped THERE would leave every test here green and the app unable
    /// to renew, which is the exact failure this whole suite exists to prevent.
    /// So that hop is pinned as source, and the app compositions are pinned to
    /// use it.
    func testTheProductionAssemblyHandsTheRenewalSeamToTheFactory() throws {
        let model = try RepoRoot.text("apps/RelayiumKit/Sources/RelayiumAppKit/LinkWorkspaceModel.swift")
        let live = try XCTUnwrap(model.range(of: "static let liveAssembly: Assemble = {"))
        let body = String(model[live.upperBound...].prefix(1500))
        XCTAssertTrue(body.contains("initialSignal, renewal in"),
                      "liveAssembly must RECEIVE the room's seam")
        XCTAssertTrue(body.contains("renewal: renewal)"),
                      "and must hand it to LinkSessionFactory.make")

        let factory = try RepoRoot.text("apps/RelayiumKit/Sources/RelayiumAppKit/LinkSessionFactory.swift")
        XCTAssertTrue(factory.contains("renewal: renewal,\n                                             onEvent: sink)")
                      || factory.contains("renewal: renewal,"),
                      "the factory must pass it to the runtime it builds")
        XCTAssertTrue(factory.contains("WebRTCLinkTransport(signaling: signaling,"),
                      "and the transport it builds is the real renewable one")

        // No app composition replaces the assembly, so all of them renew.
        let environment = try RepoRoot.text("apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift")
        XCTAssertFalse(environment.contains("assemble:"),
                       "an app composition that overrode `assemble` would bypass the seam")
    }

    /// The acceptance host reports the link's relayed bound so a long run can
    /// SEE the initial boundary and see it advance — survival alone proves
    /// nothing, because an allocation can outlive its REST credential. It must
    /// be read off the model and nothing else, and a link with no relayed bound
    /// must OMIT the keys rather than report zero: a zero is an instant, and a
    /// harness comparing instants would read "no bound" as "expired in 1970".
    /// (The host is not linked into this test target, so this is a source pin.)
    func testTheAcceptanceHostReportsTheModelsDeadlineAndOmitsItWhenThereIsNone() throws {
        let host = try RepoRoot.text("apps/RelayiumKit/Sources/RelayiumPeerKit/AppPairLinkHost.swift")
        let seam = try XCTUnwrap(host.range(of: "if let deadline = link.relayDeadline {"),
                                 "both keys must sit inside the optional binding")
        let body = String(host[seam.upperBound...].prefix(400))
        XCTAssertTrue(body.contains(
            "out[\"relayExpiresAtMs\"] = Int64(deadline.expiresAt.timeIntervalSince1970 * 1000)"))
        XCTAssertTrue(body.contains(
            "out[\"relayDeadlineAtMs\"] = Int64(deadline.deadlineAt.timeIntervalSince1970 * 1000)"))
        XCTAssertEqual(host.components(separatedBy: "relayExpiresAtMs").count - 1, 1,
                       "one write site: no default, no zero, no second source")
        XCTAssertEqual(host.components(separatedBy: "relayDeadlineAtMs").count - 1, 1)
    }

    // MARK: - what this build announces

    /// Both hellos a real composition sends name renewal exactly when they
    /// name a link, and the shared-default one is the list the shared
    /// `capability.hello.native` vector pins.
    func testEveryLinkCapableHelloAnnouncesRenewal() {
        XCTAssertEqual(advertisedLinkCapabilities(linkRoomActive: true),
                       [TEXT_CAPABILITY, LINK_CAPABILITY, RELAY_RENEW_CAPABILITY])
        XCTAssertEqual(linkOnlyCapabilities(linkRoomActive: true),
                       [LINK_CAPABILITY, RELAY_RENEW_CAPABILITY])
        XCTAssertFalse(advertisedLinkCapabilities(linkRoomActive: false)
            .contains(RELAY_RENEW_CAPABILITY), "with no link there is nothing to renew")
        XCTAssertTrue(linkOnlyCapabilities(linkRoomActive: false).isEmpty)
    }
}

private func XCTUnwrapAsync<T>(_ expression: @autoclosure () async throws -> T?,
                               file: StaticString = #filePath,
                               line: UInt = #line) async throws -> T {
    let value = try await expression()
    return try XCTUnwrap(value, file: file, line: line)
}
