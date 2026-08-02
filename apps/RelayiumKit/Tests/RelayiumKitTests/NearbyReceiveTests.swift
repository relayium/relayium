import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - stubs

/// An ICE client that can be held open, so a test can drive what arrives
/// *during* the window between claiming an offer and having a connection to
/// give it to. That window is where every ordering bug in this feature lives.
private final class HeldICE: ICEConfigClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _codes: [String] = []
    var codes: [String] { lock.lock(); defer { lock.unlock() }; return _codes }
    let gate = ReceiveGate()
    /// When true, `fetch` blocks until `gate.open()`.
    var holds = false
    var error: Error?

    func fetch(code: String) async throws -> ICEConfig {
        lock.lock(); _codes.append(code); let hold = holds; let failure = error; lock.unlock()
        if hold { await gate.wait() }
        if let failure { throw failure }
        return ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])])
    }
}

private final class NoMintPair: PairCodeClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _mintCount = 0
    var mintCount: Int { lock.lock(); defer { lock.unlock() }; return _mintCount }
    func mint(token: String) async throws -> MintedCode {
        lock.lock(); _mintCount += 1; lock.unlock()
        return MintedCode(code: "483920", expiresAt: 1800000000)
    }
}

/// Copies the two behaviours of `RealtimeConnection` the routing depends on: it
/// takes over `signaling.onSignal` when it is built, and it gives that slot back
/// on close — but only if the slot is still its own, which is the ownership rule
/// a stale close must not be able to break. Both halves go through the real
/// token API, so a regression there fails here rather than only in a live app.
private final class ReplayPeer: RealtimePeerConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var _received: [JSONValue] = []
    var received: [JSONValue] { lock.lock(); defer { lock.unlock() }; return _received }
    private(set) var closeCount = 0
    private(set) var acceptCount = 0
    private(set) var acceptTextCount = 0
    private(set) var started = false
    private let signaling: SignalingClient
    private var slot: SignalHandlerToken?

    init(signaling: SignalingClient) {
        self.signaling = signaling
        slot = signaling.installSignalHandler { [weak self] _, data in
            guard let self else { return }
            lock.lock(); _received.append(data); lock.unlock()
        }
    }

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

    /// Every manifest this connection was asked to send. Empty is the assertion
    /// that matters on the inbound path: answering an offer must never upload.
    private(set) var sentBatches: [[FileMeta]] = []

    func start() { started = true }
    func send(sources: [PlaintextSource], metas: [FileMeta]) { sentBatches.append(metas) }
    func accept() { acceptCount += 1 }
    func reject() {}
    func complete() {}
    func confirmTextSAS() {}
    func acceptText() { acceptTextCount += 1 }
    func rejectText() {}
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) { completion(nil) }
    var textBufferedAmount: UInt64 { 0 }
    func close() {
        closeCount += 1
        // Exactly what `RealtimeConnection.closeLocked` does: hand the slot back
        // if and only if it is still ours.
        if let slot { signaling.removeSignalHandler(slot) }
    }
}

/// Records what the inbound builder was asked for, and hands back the peers the
/// test then drives.
private final class InboundLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _peerIds: [String] = []
    private var _peers: [ReplayPeer] = []
    var peerIds: [String] { lock.lock(); defer { lock.unlock() }; return _peerIds }
    var peers: [ReplayPeer] { lock.lock(); defer { lock.unlock() }; return _peers }
    var latest: ReplayPeer? { peers.last }
    func note(_ peerId: String, _ peer: ReplayPeer) {
        lock.lock(); _peerIds.append(peerId); _peers.append(peer); lock.unlock()
    }
}

/// One-shot rendezvous for holding an async step open.
actor ReceiveGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var opened = false
    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }
}

// MARK: - the harness

/// Background receive: the machinery that answers an offer nobody asked for.
///
/// Everything here runs against a real `SignalingClient` over a fake socket, so
/// the tests exercise the actual listener registration, the actual generation
/// routing and the actual buffer handoff rather than a model of them.
@MainActor
final class NearbyReceiveTests: XCTestCase {
    private var sockets = SocketLog()
    /// The live socket. A reconnect mints a new one, exactly as the real client
    /// does, so a test firing on an earlier one is firing into a dead room.
    private var channel: FakeWebSocketChannel { sockets.channels.last! }
    private var discovery: LanDiscoveryModel!
    private var fileModel: RealtimeSessionModel!
    private var textModel: RealtimeTextSessionModel!
    private var receive: NearbyReceiveModel!
    private var inboundRoom = InboundRoom()
    private var ice = HeldICE()
    private var pair = NoMintPair()
    private var inbound = InboundLog()
    private var requiresVerification = false
    private var saveDirectory: URL!
    /// When set, the inbound builder blocks on this before returning, so a test
    /// can land a cancel inside the build window rather than the ICE window.
    /// `entered` is what makes that deterministic: "the ICE fetch was called" is
    /// true the moment it is entered, which is still the ICE window.
    @MainActor final class BuildHold {
        let gate = ReceiveGate()
        var entered = false
    }
    private var buildHold: BuildHold?
    /// Holds the builder open *after* the connection exists and has claimed
    /// `onSignal`, but before `acceptNearby` hands the buffer off. That sliver
    /// is the only place a frame can be both buffered by the router and
    /// delivered live to the connection, so it is the only place the duplicate
    /// can be observed — and nothing else in the harness can stop time there.
    private var postBuildHold: BuildHold?

    override func setUp() async throws {
        try await super.setUp()
        sockets = SocketLog()
        ice = HeldICE()
        pair = NoMintPair()
        inbound = InboundLog()
        inboundRoom = InboundRoom()
        requiresVerification = false
        buildHold = nil
        postBuildHold = nil
        saveDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relayium-receive-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: saveDirectory, withIntermediateDirectories: true)

        let log = sockets
        discovery = LanDiscoveryModel(
            connect: {
                let ch = log.open()
                let client = SignalingClient(channel: ch, name: "Mac")
                ch.fireOpen()
                return client
            },
            sleep: { _ in })

        let room = inboundRoom
        let peers = inbound
        let held = { [weak self] in self?.buildHold }
        let heldAfterBuild = { [weak self] in self?.postBuildHold }
        // Exactly what AppEnvironment wires: the responder factory, on the exact
        // socket the offer arrived on, with the real peer connection swapped for
        // one that records the replay.
        func builder(_ mode: RealtimeConnectionFactory.Mode)
            -> @MainActor (String, ICEConfig) async throws -> RealtimePeerConnection {
            { peerId, config in
                if let hold = held() {
                    hold.entered = true
                    await hold.gate.wait()
                }
                guard let signaling = room.signaling else { throw NearbyError.notScanning }
                let peer = try RealtimeConnectionFactory.acceptNearby(
                    signaling: signaling, peerId: peerId, config: config, mode: mode,
                    build: { signaling, _, _, _, _, _, _ in ReplayPeer(signaling: signaling) })
                peers.note(peerId, peer as! ReplayPeer)
                // The connection now owns `onSignal` and the router still holds
                // the buffer: the handoff window, held open on request.
                if let hold = heldAfterBuild() {
                    hold.entered = true
                    await hold.gate.wait()
                }
                return peer
            }
        }

        // The outbound twin, so "the local user started a session" is the real
        // path rather than a stand-in for it.
        let outboundRoom = { [weak self] in self?.discovery.client }
        let outbound: @MainActor (String, Role, ICEConfig) async throws -> RealtimePeerConnection = { peerId, role, config in
            guard let signaling = outboundRoom() else { throw NearbyError.notScanning }
            return try await RealtimeConnectionFactory.connectNearby(
                signaling: signaling, peerId: peerId, role: role, config: config,
                mode: .file, capabilityTimeout: 1,
                build: { signaling, _, _, _, _, _, _ in ReplayPeer(signaling: signaling) })
        }

        fileModel = RealtimeSessionModel(
            pairClient: pair,
            iceClient: ice,
            requiresVerification: { [weak self] in self?.requiresVerification ?? false },
            nearbyAnswerTimeout: 600,
            makeNearbyConnection: outbound,
            makeInboundConnection: builder(.file),
            makeConnection: { _, _, _ in throw NearbyError.notScanning })
        fileModel.saveDirectory = saveDirectory
        textModel = RealtimeTextSessionModel(
            pairClient: pair,
            iceClient: ice,
            requiresVerification: { [weak self] in self?.requiresVerification ?? false },
            nearbyAnswerTimeout: 600,
            makeInboundConnection: builder(.text),
            makeConnection: { _, _, _ in throw NearbyError.notScanning })
        receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: fileModel, textModel: textModel, discovery: discovery,
            inboundRoom: inboundRoom)
        discovery.startResident()
        joinRoom()
        await settle()
    }

    /// The hub's `welcome`. Fired explicitly because a socket that is merely
    /// open is NOT a joined room: without a self id this Mac is in nobody's
    /// roster and cannot be offered to, which `NearbyReceiveState.connecting`
    /// now says out loud. Every test that expects `.ready` needs the room to
    /// have actually been joined.
    private func joinRoom() {
        channel.fireText(#"{"type":"welcome","name":"self-mac","ip":"203.0.113.5"}"#)
    }

    override func tearDown() async throws {
        discovery?.stop()
        try? FileManager.default.removeItem(at: saveDirectory)
        try await super.tearDown()
    }

    // MARK: helpers

    private func settle(_ rounds: Int = 8) async {
        for _ in 0..<rounds { await Task.yield() }
    }

    private func settle(until condition: @MainActor () -> Bool, rounds: Int = 200) async {
        for _ in 0..<rounds {
            if condition() { return }
            await Task.yield()
        }
    }

    private func fileOffer(from peer: String = "peer-1") -> String {
        #"{"type":"signal","from":"\#(peer)","data":{"sdp":{"type":"offer","sdp":"v=0"},"commit":"Yw=="}}"#
    }

    private func textOffer(from peer: String = "peer-1", caps: String = #"["text/1"]"#) -> String {
        #"{"type":"signal","from":"\#(peer)","data":{"sdp":{"type":"offer","sdp":"v=0"},"commit":"Yw==","text":true,"caps":\#(caps)}}"#
    }

    private func candidate(_ id: String, from peer: String = "peer-1", text: Bool = false) -> String {
        let tag = text ? #","text":true"# : ""
        return #"{"type":"signal","from":"\#(peer)","data":{"ice":{"candidate":"\#(id)","sdpMid":"0","sdpMLineIndex":0}\#(tag)}}"#
    }

    /// Every `signal` envelope this Mac has sent, decoded.
    private func sentSignals() -> [(to: String, data: JSONValue)] {
        channel.sent.compactMap {
            guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data($0.utf8)),
                  envelope.type == SignalType.signal,
                  let to = envelope.to, let data = envelope.data else { return nil }
            return (to, data)
        }
    }

    private func busyReplies() -> [(to: String, generation: RealtimeGeneration)] {
        sentSignals().filter { parseBusy($0.data) }.map { ($0.to, signalGeneration($0.data)) }
    }

    /// Drives one inbound file transfer all the way to `.completed` through the
    /// real model: handshake, manifest, bytes, DONE. Leaves the session terminal
    /// but NOT torn down — which is the state the sequential-session tests are
    /// about.
    private func completeAFileTransfer(on peer: ReplayPeer, named name: String) async {
        let bytes: [UInt8] = [1, 2, 3, 4]
        peer.onSAS?("123456")
        peer.onOpen?()
        await settle()
        peer.onManifest?([FileMeta(name: name, size: bytes.count, path: nil)])
        await settle()
        peer.onFileChunk?(bytes)
        await settle()
        peer.onDone?(true)
        await settle(until: {
            if case .completed = self.fileModel.state { return true }
            return false
        })
        // The transfer being terminal is not the same as the listener being
        // admitted again: the gate is handed back only once the models have
        // been re-read. Waiting for that is the app's real admission rule, not
        // a delay invented for the test — and firing the next offer before it
        // would simply earn a truthful busy.
        await settle(until: { self.receive.state == .ready })
    }

    // MARK: - the shape of the feature

    /// One unsolicited offer, one responder session — with no code minted, no
    /// code joined, and `/api/ice` asked without one. That triple is what makes
    /// receiving work signed out and cost nobody relay quota.
    func testAnUnsolicitedFileOfferStartsAResponderSession() async {
        channel.fireText(fileOffer())
        await settle(until: { self.inbound.latest != nil })

        XCTAssertEqual(inbound.peerIds, ["peer-1"], "the responder is built on the offer's own peer id")
        XCTAssertEqual(ice.codes, [""], "an inbound nearby session must ask /api/ice without a code")
        XCTAssertEqual(pair.mintCount, 0, "nothing on this path may mint a pairing code")
        XCTAssertEqual(fileModel.state, .connecting)
        XCTAssertEqual(receive.state, .active(.file))
        XCTAssertEqual(receive.activeKind, .file)
    }

    /// The offer this Mac is answering, and the candidates that chase it, arrive
    /// before there is anything to give them to — on a LAN the candidates
    /// routinely beat the `/api/ice` round trip. Losing them is a session that
    /// connects slowly or not at all, with no error anywhere.
    func testTheOfferAndEarlyCandidatesReachTheConnectionInWireOrder() async {
        ice.holds = true
        channel.fireText(fileOffer())
        await settle()
        XCTAssertNil(inbound.latest, "the connection cannot exist yet — ICE is still in flight")

        channel.fireText(candidate("cand-a"))
        channel.fireText(candidate("cand-b"))
        // A different peer's candidate belongs to nobody here and must not be
        // spliced into this session's buffer.
        channel.fireText(candidate("cand-other", from: "peer-9"))
        await settle()

        await ice.gate.open()
        await settle(until: { self.inbound.latest != nil })

        guard let peer = inbound.latest else { return XCTFail("no connection was built") }
        let candidates = peer.received.compactMap { parseICE($0)?.candidate }
        XCTAssertEqual(peer.received.count, 3, "the offer plus both of this peer's candidates")
        XCTAssertEqual(parseSDP(peer.received[0])?.type, "offer",
                       "the offer has to arrive first, or the candidates have no session to attach to")
        XCTAssertEqual(candidates, ["cand-a", "cand-b"], "buffered signals replay in wire order")
    }

    /// Two offers in one delivery burst. The reservation is taken
    /// synchronously, on the socket's own queue, precisely so the second cannot
    /// find the gate open while the first is still being set up.
    func testTwoOffersInOneBurstCreateOneSessionAndOneBusyReply() async {
        ice.holds = true
        channel.fireText(fileOffer(from: "peer-1"))
        channel.fireText(fileOffer(from: "peer-2"))
        await settle()
        await ice.gate.open()
        await settle(until: { self.inbound.latest != nil })

        XCTAssertEqual(inbound.peerIds, ["peer-1"], "exactly one session, for the offer that got there first")
        XCTAssertEqual(ice.codes.count, 1)
        XCTAssertEqual(busyReplies().map(\.to), ["peer-2"])
    }

    /// A busy reply has to be tagged with the generation the initiator is
    /// listening on. The wrong tag is filtered out by the peer, which then
    /// spends its whole ICE timeout instead of failing fast with "that device
    /// is busy".
    func testBusyIsTaggedForTheGenerationTheInitiatorIsListeningOn() async {
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.fileModel.state == .connecting })
        channel.sent.removeAll()

        channel.fireText(fileOffer(from: "peer-2"))
        channel.fireText(textOffer(from: "peer-3"))
        await settle()

        let replies = busyReplies()
        XCTAssertEqual(replies.count, 2)
        XCTAssertEqual(replies.first { $0.to == "peer-2" }?.generation, .file,
                       "a file initiator only reads untagged signals")
        XCTAssertEqual(replies.first { $0.to == "peer-3" }?.generation, .text,
                       "a text initiator only reads text-tagged signals")
    }

    // MARK: - mutual exclusion

    func testALiveFileSessionRefusesAnInboundTextOffer() async {
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.fileModel.state == .connecting })
        channel.sent.removeAll()

        channel.fireText(textOffer(from: "peer-2"))
        await settle()

        XCTAssertEqual(textModel.state, .idle, "text and files are mutually exclusive")
        XCTAssertEqual(busyReplies().map(\.to), ["peer-2"])
    }

    func testALiveTextSessionRefusesAnInboundFileOffer() async {
        channel.fireText(textOffer(from: "peer-1"))
        await settle(until: { self.textModel.state == .connecting })
        channel.sent.removeAll()

        channel.fireText(fileOffer(from: "peer-2"))
        await settle()

        XCTAssertEqual(fileModel.state, .idle)
        XCTAssertEqual(busyReplies().map(\.to), ["peer-2"])
    }

    /// A session the local user started owns the models too. The gate's busy
    /// flag is one hop behind by construction, so the main-actor re-check is
    /// what actually holds this line.
    func testAnOutboundSessionRefusesInboundOffers() async {
        // The real outbound path: the user picked a device off the roster.
        await fileModel.connectNearby(peerId: "chosen-7")
        await settle(until: { self.fileModel.isBusy })
        XCTAssertEqual(fileModel.state, .connecting)
        channel.sent.removeAll()

        channel.fireText(fileOffer(from: "stranger-2"))
        await settle()

        XCTAssertEqual(busyReplies().map(\.to), ["stranger-2"])
        XCTAssertTrue(inbound.peerIds.isEmpty, "an inbound offer must not displace the user's own session")
    }

    // MARK: - what never opens a session

    /// Answers, candidates and reveals belong to a connection that already
    /// exists. A router that treated one as a new session would both lose the
    /// frame and spend a connection on nothing.
    func testNonOfferFramesNeverOpenASession() async {
        channel.fireText(candidate("cand-a"))
        channel.fireText(#"{"type":"signal","from":"peer-1","data":{"sdp":{"type":"answer","sdp":"v=0"}}}"#)
        channel.fireText(#"{"type":"signal","from":"peer-1","data":{"reveal":{"key":"a","nonce":"b"}}}"#)
        channel.fireText(#"{"type":"signal","from":"peer-1","data":{"busy":true}}"#)
        channel.fireText(#"{"type":"signal","from":"peer-1","data":{"caps":["text/1"]}}"#)
        await settle()

        XCTAssertEqual(fileModel.state, .idle)
        XCTAssertEqual(textModel.state, .idle)
        XCTAssertTrue(inbound.peerIds.isEmpty)
        XCTAssertTrue(sentSignals().isEmpty, "nothing here deserves an answer, not even a busy")
        XCTAssertEqual(receive.state, .ready)
    }

    /// A resume offer re-attaches to a paused transfer this client does not
    /// implement; `link` is the web's own generation. Answering either strands
    /// the initiator on a wire this side is not speaking.
    func testResumeAndLinkOffersAreNotMistakenForNewSessions() async {
        channel.fireText(#"{"type":"signal","from":"peer-1","data":{"sdp":{"type":"offer","sdp":"v=0"},"resume":true}}"#)
        channel.fireText(#"{"type":"signal","from":"peer-2","data":{"sdp":{"type":"offer","sdp":"v=0"},"link":true}}"#)
        await settle()

        XCTAssertEqual(fileModel.state, .idle)
        XCTAssertTrue(inbound.peerIds.isEmpty)
        XCTAssertTrue(sentSignals().isEmpty)
    }

    /// A text offer without exact `text/1` cannot be answered: the session it
    /// would open could never carry a message. Fail closed and stay silent —
    /// "busy" would tell the peer to try again later, which is not what is
    /// wrong.
    func testATextOfferWithoutTheExactCapabilityFailsClosedAndSilently() async {
        channel.fireText(textOffer(from: "peer-1", caps: "[]"))
        channel.fireText(textOffer(from: "peer-2", caps: #"["text/2"]"#))
        await settle()

        XCTAssertEqual(textModel.state, .idle)
        XCTAssertTrue(inbound.peerIds.isEmpty)
        XCTAssertTrue(sentSignals().isEmpty, "we cannot speak this peer's dialect; busy would be a lie")

        // …and the listener is still live afterwards.
        channel.fireText(textOffer(from: "peer-3"))
        await settle(until: { self.inbound.latest != nil })
        XCTAssertEqual(inbound.peerIds, ["peer-3"])
    }

    // MARK: - releasing the reservation

    /// The failure that matters most: if a reservation survived a failed setup,
    /// background receive would be dead until the app restarted — and nothing
    /// would say so.
    func testAFailedSetupReleasesTheReservationSoTheNextOfferIsAnswered() async {
        ice.error = NSError(domain: "test", code: 1)
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.receive.lastFailure != nil })
        guard case .failed = fileModel.state else { return XCTFail("got \(fileModel.state)") }

        ice.error = nil
        channel.fireText(fileOffer(from: "peer-2"))
        await settle(until: { self.inbound.latest != nil })
        XCTAssertEqual(inbound.peerIds, ["peer-2"], "the listener has to survive its own failures")
        XCTAssertEqual(receive.state, .active(.file))
    }

    /// A user who cancels while the ICE round trip is in flight has moved on
    /// before there is anything to close. Nothing may be built afterwards, and
    /// the listener has to be answerable again.
    func testCancellingDuringTheICEWindowBuildsNothingAndFreesTheListener() async {
        ice.holds = true
        channel.fireText(fileOffer(from: "peer-1"))
        await settle()
        XCTAssertEqual(fileModel.state, .connecting)

        fileModel.cancel()
        XCTAssertEqual(fileModel.state, .idle)

        await ice.gate.open()
        await settle(until: { self.receive.state == .ready })

        XCTAssertTrue(inbound.peerIds.isEmpty, "a cancelled attempt must not build a connection")
        XCTAssertEqual(fileModel.state, .idle, "a stale attempt must not repaint the pane")

        ice.holds = false
        channel.fireText(fileOffer(from: "peer-2"))
        await settle(until: { self.inbound.latest != nil })
        XCTAssertEqual(inbound.peerIds, ["peer-2"])
    }

    /// A cancel that lands *after* the connection was built. That one exists and
    /// has to be closed rather than installed over the state the user is now
    /// looking at — otherwise it holds the peer and the socket for good.
    func testALateConnectionAfterCancelIsClosedAndDoesNotReplaceNewerState() async {
        let hold = BuildHold()
        buildHold = hold
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { hold.entered })
        XCTAssertEqual(fileModel.state, .connecting)

        fileModel.cancel()
        XCTAssertEqual(fileModel.state, .idle)

        buildHold = nil
        await hold.gate.open()
        await settle(until: { self.inbound.latest?.closeCount == 1 })

        XCTAssertEqual(fileModel.state, .idle, "a stale attempt must not repaint the pane")
        XCTAssertEqual(inbound.latest?.closeCount, 1,
                       "the connection nobody is watching has to be closed")

        channel.fireText(fileOffer(from: "peer-2"))
        await settle(until: { self.inbound.peerIds.count == 2 })
        XCTAssertEqual(inbound.peerIds, ["peer-1", "peer-2"])
    }

    /// The socket carrying the offer went away mid-setup. A peer id only means
    /// anything inside the room that issued it, so the attempt must fail rather
    /// than be rebuilt against whatever room we join next.
    func testASocketDropDuringSetupFailsTheAttemptAndFreesTheListener() async {
        ice.holds = true
        channel.fireText(fileOffer(from: "peer-1"))
        await settle()

        channel.fireRemoteClose()
        await settle()
        await ice.gate.open()
        await settle(until: { self.receive.lastFailure != nil })

        XCTAssertTrue(inbound.peerIds.isEmpty, "no connection may be built against a room we left")
        guard case .failed = fileModel.state else { return XCTFail("got \(fileModel.state)") }
    }

    // MARK: - following the socket

    /// Reconnecting mints a new socket and a new peer id. A listener still
    /// subscribed to the old one hears nothing on the new one — which is the
    /// silent way background receive dies after a network blip.
    func testTheListenerFollowsTheSocketAcrossAReconnect() async {
        let old = channel
        old.fireRemoteClose()
        await settle(until: { self.sockets.channels.count == 2 })
        XCTAssertNotNil(discovery.client, "residency has to bring the room back")

        // The dead socket must not be able to start anything.
        old.fireText(fileOffer(from: "ghost-1"))
        await settle()
        XCTAssertTrue(inbound.peerIds.isEmpty)

        // The live one must.
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.inbound.latest != nil })
        XCTAssertEqual(inbound.peerIds, ["peer-1"])
    }

    /// A paused app is not listening, and says so rather than accepting
    /// quietly.
    func testAPausedListenerAnswersNothing() async {
        discovery.pause()
        await settle()
        XCTAssertEqual(receive.state, .paused)

        channel.fireText(fileOffer())
        await settle()
        XCTAssertTrue(inbound.peerIds.isEmpty)
        XCTAssertTrue(sentSignals().isEmpty)

        discovery.resume()
        joinRoom()
        await settle(until: { self.receive.state == .ready })
        channel.fireText(fileOffer())
        await settle(until: { self.inbound.latest != nil })
        XCTAssertEqual(inbound.peerIds, ["peer-1"])
    }

    /// The state a user is shown while the socket is down. "Ready" here would
    /// be a claim the app cannot back up.
    func testReconnectingIsReportedAsSuch() async {
        // Hold the retry open so the gap is observable.
        let held = ReceiveGate()
        discovery.stop()
        let log = SocketLog()
        let ch = log.open()
        discovery = LanDiscoveryModel(
            connect: {
                let client = SignalingClient(channel: ch, name: "Mac")
                ch.fireOpen()
                return client
            },
            sleep: { _ in await held.wait() })
        discovery.observer = receive
        receive.observe(discovery)
        discovery.startResident()
        ch.fireText(#"{"type":"welcome","name":"self-mac","ip":"203.0.113.5"}"#)
        await settle()
        XCTAssertEqual(receive.state, .ready)

        ch.fireRemoteClose()
        await settle(until: { self.receive.state == .reconnecting })
        XCTAssertEqual(receive.state, .reconnecting)
        await held.open()
        discovery.stop()
    }

    // MARK: - the responder session itself

    /// The default: no verification, no Accept, the file lands in the
    /// configured directory. The manifest still decides — an invalid one is
    /// refused before a byte is written.
    func testAFileResponderAcceptsTheManifestWithVerificationOff() async {
        channel.fireText(fileOffer())
        await settle(until: { self.inbound.latest != nil })
        guard let peer = inbound.latest else { return XCTFail("no connection") }

        peer.onSAS?("123456")
        peer.onOpen?()
        await settle()
        guard case .transferring = fileModel.state else { return XCTFail("got \(fileModel.state)") }

        peer.onManifest?([FileMeta(name: "note.txt", size: 4, path: nil)])
        await settle()
        XCTAssertEqual(peer.acceptCount, 1, "the responder accepts the batch itself")
        XCTAssertEqual(fileModel.incoming.map(\.name), ["note.txt"])
    }

    /// Opt-in verification still gates an inbound session. Turning the
    /// preference on must not need a different code path — it is the same
    /// model, in the same responder role.
    func testAFileResponderStillGatesOnTheSASWhenVerificationIsOn() async {
        requiresVerification = true
        channel.fireText(fileOffer())
        await settle(until: { self.inbound.latest != nil })
        guard let peer = inbound.latest else { return XCTFail("no connection") }

        peer.onSAS?("123456")
        peer.onOpen?()
        await settle()
        XCTAssertEqual(fileModel.state, .verifying(sas: "123456"))

        peer.onManifest?([FileMeta(name: "note.txt", size: 4, path: nil)])
        await settle()
        XCTAssertEqual(peer.acceptCount, 0, "nothing is accepted before the phrase is compared")
    }

    /// The existing responder auto-open, reached from an offer instead of a
    /// code: with verification off the composer opens without a prompt.
    func testATextResponderOpensWithoutAPromptWhenVerificationIsOff() async {
        channel.fireText(textOffer())
        await settle(until: { self.inbound.latest != nil })
        guard let peer = inbound.latest else { return XCTFail("no connection") }

        peer.onSAS?("123456")
        peer.onOpen?()
        await settle()

        XCTAssertEqual(textModel.state, .open(sas: "123456"))
        XCTAssertEqual(peer.acceptTextCount, 1)
        XCTAssertEqual(receive.state, .active(.text))
        XCTAssertEqual(receive.activeKind, .text)
    }

    func testATextResponderAsksWhenVerificationIsOn() async {
        requiresVerification = true
        channel.fireText(textOffer())
        await settle(until: { self.inbound.latest != nil })
        guard let peer = inbound.latest else { return XCTFail("no connection") }

        peer.onSAS?("123456")
        peer.onOpen?()
        await settle()

        XCTAssertEqual(textModel.state, .verifying(sas: "123456"))
        XCTAssertEqual(peer.acceptTextCount, 0, "nothing is decrypted before the phrase is compared")
    }

    // MARK: - routing: exactly once, and only to the right connection

    /// The duplicate. Between "the connection claimed `onSignal`" and "the
    /// router replayed its buffer", a frame the router buffers would ALSO be
    /// delivered live if the router were a plain observer — and then replayed,
    /// so the connection sees it twice. A duplicated candidate is survivable; a
    /// duplicated offer is a second `setRemoteDescription` on a connection
    /// mid-negotiation.
    func testABufferedFrameIsNotAlsoDeliveredLiveInTheHandoffWindow() async {
        let hold = BuildHold()
        postBuildHold = hold
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { hold.entered })
        guard let peer = inbound.latest else { return XCTFail("no connection was built") }
        XCTAssertTrue(peer.received.isEmpty, "nothing is replayed before the handoff")

        // The connection exists and owns the slot; the router still owns the
        // buffer. Exactly the window.
        channel.fireText(candidate("cand-a"))
        channel.fireText(candidate("cand-b"))
        await settle()
        XCTAssertTrue(peer.received.isEmpty,
                      "a frame the router buffered must not also reach the connection live")

        postBuildHold = nil
        await hold.gate.open()
        await settle(until: { self.fileModel.state == .connecting && !peer.received.isEmpty })

        let candidates = peer.received.compactMap { parseICE($0)?.candidate }
        XCTAssertEqual(peer.received.count, 3, "the offer and both candidates, once each")
        XCTAssertEqual(candidates, ["cand-a", "cand-b"], "exactly once, in wire order")
    }

    /// A second offer from the peer whose FIRST offer we are still setting up.
    /// Buffering it meant `handoff` replayed two offers into one responder,
    /// driving `setRemoteDescription` twice mid-setup. It is dropped instead —
    /// and pointedly not answered busy, because the only peer that would reach
    /// is the one whose legitimate attempt is about to succeed.
    func testADuplicateOfferDuringSetupIsNeitherReplayedNorAnswered() async {
        let hold = BuildHold()
        postBuildHold = hold
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { hold.entered })
        channel.sent.removeAll()

        channel.fireText(candidate("cand-a"))
        channel.fireText(fileOffer(from: "peer-1"))   // the duplicate
        channel.fireText(candidate("cand-b"))
        await settle()

        postBuildHold = nil
        await hold.gate.open()
        await settle(until: { self.inbound.latest?.received.count == 3 })

        guard let peer = inbound.latest else { return XCTFail("no connection was built") }
        XCTAssertEqual(peer.received.compactMap { parseSDP($0)?.type }, ["offer"],
                       "exactly one offer may reach the responder")
        XCTAssertEqual(peer.received.compactMap { parseICE($0)?.candidate }, ["cand-a", "cand-b"],
                       "the ICE around it still replays in wire order")
        XCTAssertTrue(busyReplies().isEmpty,
                      "the peer we are accepting must not be told to give up")
        XCTAssertEqual(inbound.peerIds, ["peer-1"], "and no second session is opened")
    }

    /// A stale attempt that unblocks after its socket is gone owns nothing —
    /// not the reservation, and not the screen. It used to publish its failure
    /// unconditionally, painting "could not be set up" over a transfer that was
    /// running fine on the socket that replaced it, with no way to dismiss it.
    func testAStaleAttemptFromAnOldSocketDoesNotReportOverALiveSession() async {
        ice.holds = true
        channel.fireText(fileOffer(from: "peer-1"))
        await settle()
        XCTAssertNil(inbound.latest, "the first attempt is still waiting on ICE")

        // The socket carrying that attempt drops, and the user gives up on the
        // session that is going nowhere. Both are ordinary; what matters is that
        // the attempt's async work is STILL in flight, holding a peer id from a
        // room that no longer exists.
        channel.fireRemoteClose()
        fileModel.cancel()
        await settle(until: { self.sockets.channels.count == 2 })
        joinRoom()
        await settle(until: { self.receive.state == .ready })

        // A new offer on the NEW socket, which succeeds.
        ice.holds = false
        channel.fireText(fileOffer(from: "peer-2"))
        await settle(until: { self.inbound.latest != nil })
        XCTAssertEqual(inbound.peerIds, ["peer-2"])
        XCTAssertEqual(fileModel.state, .connecting)

        // Only now does the attempt from the dead socket unblock and fail.
        await ice.gate.open()
        await settle()

        XCTAssertNil(receive.lastFailure,
                     "a stale attempt must not report a failure over a working session")
        XCTAssertEqual(fileModel.state, .connecting, "the live session is untouched")
        XCTAssertEqual(receive.state, .active(.file))
        XCTAssertEqual(inbound.peerIds, ["peer-2"], "and it must not build anything either")
    }

    /// Glare, end to end: the peer we are already answering sends a fresh offer.
    /// It must be refused rather than routed into the live connection, where it
    /// would drive a second `setRemoteDescription` on a session mid-handshake.
    func testAFreshOfferFromTheLivePeerNeverReachesTheLiveConnection() async {
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.inbound.latest != nil })
        guard let peer = inbound.latest else { return XCTFail("no connection") }
        XCTAssertEqual(peer.received.compactMap { parseSDP($0)?.type }, ["offer"])
        channel.sent.removeAll()

        channel.fireText(fileOffer(from: "peer-1"))
        await settle()

        XCTAssertEqual(peer.received.compactMap { parseSDP($0)?.type }, ["offer"],
                       "the live connection must see one offer, not two")
        XCTAssertEqual(busyReplies().map(\.to), ["peer-1"],
                       "and the peer is told we are busy rather than left waiting")
        XCTAssertEqual(inbound.peerIds, ["peer-1"], "no second session either")
    }

    /// What the router must NOT eat. A live session's answer, candidates and
    /// reveal all arrive on the same socket the router is intercepting;
    /// consuming them would open a connection that never finishes its
    /// handshake.
    func testTheLiveConnectionStillReceivesItsOwnFrames() async {
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.inbound.latest != nil })
        guard let peer = inbound.latest else { return XCTFail("no connection") }

        channel.fireText(candidate("cand-live"))
        channel.fireText(#"{"type":"signal","from":"peer-1","data":{"reveal":{"key":"a","nonce":"b"}}}"#)
        await settle()

        XCTAssertEqual(peer.received.compactMap { parseICE($0)?.candidate }, ["cand-live"])
        XCTAssertEqual(peer.received.compactMap { peerReveal(from: $0)?.key }, ["a"],
                       "the reveal is what derives the session keys — losing it hangs the session")
    }

    /// A stale connection closing after a newer one claimed the socket. The old
    /// object's teardown must not take the live handler with it: the new session
    /// would then never hear its peer again and would sit on "Connecting…" until
    /// its answer timeout, with nothing logged and nothing to see.
    func testAStaleConnectionClosingDoesNotDeafenTheNewOne() async {
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.inbound.latest != nil })
        guard let first = inbound.peers.first else { return XCTFail("no first connection") }
        fileModel.cancel()
        await settle(until: { self.receive.state == .ready })

        channel.fireText(fileOffer(from: "peer-2"))
        await settle(until: { self.inbound.peerIds.count == 2 })
        guard let second = inbound.peers.last else { return XCTFail("no second connection") }

        // The old connection finally tears down — after the new one installed
        // itself. ARC alone can produce this ordering.
        first.close()

        channel.fireText(candidate("cand-after", from: "peer-2"))
        await settle()
        XCTAssertEqual(second.received.compactMap { parseICE($0)?.candidate }, ["cand-after"],
                       "the live connection must still be reachable after a stale close")
    }

    // MARK: - one passive session after another

    /// Two unsolicited file transfers in a row. The first session is terminal
    /// but its connection is still retained: the second must retire it rather
    /// than overwrite the reference and leak an open peer connection.
    func testASecondPassiveFileSessionRetiresTheFirst() async {
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.inbound.latest != nil })
        guard let first = inbound.latest else { return XCTFail("no connection") }
        await completeAFileTransfer(on: first, named: "one.txt")
        guard case .completed = fileModel.state else {
            return XCTFail("got \(fileModel.state)")
        }
        XCTAssertEqual(first.closeCount, 0, "a completed session does not tear itself down")

        // No cancel, no wait: the next offer simply arrives.
        channel.fireText(fileOffer(from: "peer-2"))
        await settle(until: { self.inbound.peerIds.count == 2 })

        XCTAssertEqual(first.closeCount, 1, "the retained connection has to be retired, not dropped")
        XCTAssertEqual(fileModel.state, .connecting)
        XCTAssertEqual(receive.state, .active(.file))
        guard let second = inbound.peers.last else { return XCTFail("no second connection") }
        XCTAssertEqual(second.received.compactMap { parseSDP($0)?.type }, ["offer"])
    }

    /// A file transfer staged by the local user must not be handed to a peer who
    /// dialled us. `pendingSend` outlives a terminal session, and
    /// `proceedAfterVerification` sends whatever is pending — so retiring it is
    /// a confidentiality rule, not tidiness.
    func testAPassiveSessionNeverSendsWhatTheLocalUserStaged() async {
        fileModel.stageSend(
            sources: [DataSource(name: "private.txt", bytes: [1, 2, 3, 4])],
            metas: [FileMeta(name: "private.txt", size: 4, path: nil)])

        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.inbound.latest != nil })
        guard let peer = inbound.latest else { return XCTFail("no connection") }
        peer.onSAS?("123456")
        peer.onOpen?()
        await settle()

        XCTAssertTrue(peer.sentBatches.isEmpty,
                      "answering an unsolicited offer must not upload a staged selection")
    }

    /// File then text, back to back, with nothing on the receiving side slowing
    /// the first session's teardown down. The old file connection is still
    /// alive when the text connection claims the socket, and closes afterwards.
    func testAPassiveFileSessionIsFollowedByAPassiveTextSession() async {
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.inbound.latest != nil })
        guard let filePeer = inbound.latest else { return XCTFail("no file connection") }
        await completeAFileTransfer(on: filePeer, named: "two.txt")
        await settle(until: { self.receive.state == .ready })

        channel.fireText(textOffer(from: "peer-2"))
        await settle(until: { self.inbound.peerIds.count == 2 })
        guard let textPeer = inbound.peers.last else { return XCTFail("no text connection") }

        // The file connection is retired only now — after the text connection
        // took the slot.
        filePeer.close()

        textPeer.onSAS?("654321")
        textPeer.onOpen?()
        await settle()

        XCTAssertEqual(textModel.state, .open(sas: "654321"))
        XCTAssertEqual(textPeer.acceptTextCount, 1)
        XCTAssertEqual(receive.state, .active(.text))
        channel.fireText(candidate("cand-text", from: "peer-2", text: true))
        await settle()
        XCTAssertEqual(textPeer.received.compactMap { parseICE($0)?.candidate }, ["cand-text"],
                       "the text session stays reachable after the file connection closed")
    }

    // MARK: - what the user is told

    /// `connecting` is its own state. Until `welcome` lands this Mac has no peer
    /// id and is in nobody's roster, so "ready" would be a claim the app cannot
    /// back up — and a room that never finishes joining would look identical to
    /// one that is working.
    func testJoiningIsReportedAsConnectingRatherThanReady() async {
        discovery.stop()
        let log = SocketLog()
        let ch = log.open()
        // Deliberately never fires `welcome`: the socket is up, the room is not.
        discovery = LanDiscoveryModel(
            connect: {
                let client = SignalingClient(channel: ch, name: "Mac")
                ch.fireOpen()
                return client
            },
            sleep: { _ in })
        discovery.observer = receive
        receive.observe(discovery)
        discovery.startResident()
        await settle()

        XCTAssertEqual(receive.state, .connecting,
                       "no welcome means no peer id means nobody can offer to this Mac")

        ch.fireText(#"{"type":"welcome","name":"self-1","ip":"203.0.113.9"}"#)
        await settle(until: { self.receive.state == .ready })
        XCTAssertEqual(receive.state, .ready)
        discovery.stop()
    }

    /// A failure notice describes an attempt that is over. Leaving it up once
    /// the next one starts reads as a report on the session the user is now
    /// watching, and nothing else ever clears it.
    func testANewAttemptClearsThePreviousFailure() async {
        ice.error = NSError(domain: "test", code: 1)
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.receive.lastFailure != nil })
        XCTAssertNotNil(receive.lastFailure)

        ice.error = nil
        channel.fireText(fileOffer(from: "peer-2"))
        await settle(until: { self.inbound.latest != nil })
        XCTAssertNil(receive.lastFailure, "the stale notice must not outlive the attempt it described")
    }

    /// A finished session hands the gate back. Without this the first inbound
    /// transfer would be the last one the app ever accepted.
    func testAFinishedSessionLetsTheNextOfferThrough() async {
        channel.fireText(fileOffer(from: "peer-1"))
        await settle(until: { self.inbound.latest != nil })
        fileModel.cancel()
        await settle(until: { self.receive.state == .ready })
        XCTAssertNil(receive.activeKind)

        channel.fireText(fileOffer(from: "peer-2"))
        await settle(until: { self.inbound.peerIds.count == 2 })
        XCTAssertEqual(inbound.peerIds, ["peer-1", "peer-2"])
    }
}

// MARK: - the gate on its own

/// The synchronous admission decision, tested directly: it runs on the socket's
/// delivery queue, where a test cannot easily arrange the races it has to
/// survive.
final class InboundGateTests: XCTestCase {
    private func offer(_ generation: RealtimeGeneration, caps: [String] = []) -> JSONValue {
        sdpSignal(kind: "offer", sdp: "v=0", commit: "Yw==", generation: generation, caps: caps)
    }

    func testFirstOfferIsReservedAndTheSecondIsToldWeAreBusy() {
        let gate = InboundGate()
        XCTAssertEqual(gate.classify(from: "a", data: offer(.file)), .reserved(.file))
        XCTAssertTrue(gate.isEngaged)
        XCTAssertEqual(gate.classify(from: "b", data: offer(.file)), .busy(.file))
        XCTAssertEqual(gate.classify(from: "b", data: offer(.text, caps: ["text/1"])), .busy(.text))
    }

    /// While an attempt is being built, that peer's signals in that generation
    /// belong to it. Everything else is somebody else's problem.
    func testOnlyTheReservedPeerAndGenerationIsBuffered() {
        let gate = InboundGate()
        _ = gate.classify(from: "a", data: offer(.file))
        // Same peer, same generation: taken into the buffer, and therefore NOT
        // also passed on — the replay is where it gets delivered.
        XCTAssertEqual(gate.classify(from: "a", data: iceSignal("c1", sdpMid: "0", sdpMLineIndex: 0)),
                       .consumedIntoBuffer)
        // Same peer, different generation: not this attempt's, so it keeps
        // going to whatever connection owns the slot.
        XCTAssertEqual(
            gate.classify(from: "a", data: taggedSignal(iceSignal("c2", sdpMid: "0", sdpMLineIndex: 0),
                                                        generation: .text)),
            .pass)
        // Another peer's offer still gets a truthful busy.
        XCTAssertEqual(gate.classify(from: "b", data: offer(.file)), .busy(.file))
    }

    /// The one thing in the reserved window that is NOT buffered. The
    /// reservation seeded the buffer with the first offer, so appending a second
    /// means the replay hands one responder two offers — a second
    /// `setRemoteDescription` on a connection still in setup. Dropped, not
    /// answered: a busy here would go to the peer whose first offer we are
    /// currently accepting and tell it to abandon the attempt.
    func testADuplicateOfferIsDroppedRatherThanBufferedOrRefused() {
        let gate = InboundGate()
        XCTAssertEqual(gate.classify(from: "a", data: offer(.file)), .reserved(.file))
        XCTAssertEqual(gate.classify(from: "a", data: iceSignal("c1", sdpMid: "0", sdpMLineIndex: 0)),
                       .consumedIntoBuffer)
        XCTAssertEqual(gate.classify(from: "a", data: offer(.file)), .consumedDuplicateOffer,
                       "a second offer is neither this session's nor a new one")
        XCTAssertEqual(gate.classify(from: "a", data: iceSignal("c2", sdpMid: "0", sdpMLineIndex: 0)),
                       .consumedIntoBuffer,
                       "and it must not disturb the buffering around it")

        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "Mac")
        channel.fireOpen()
        var delivered: [String] = []
        signaling.onSignal = { _, data in
            if let sdp = parseSDP(data) { delivered.append("sdp:\(sdp.type)") }
            if let ice = parseICE(data) { delivered.append(ice.candidate) }
        }
        gate.handoff(to: signaling)
        XCTAssertEqual(delivered, ["sdp:offer", "c1", "c2"],
                       "exactly one offer is replayed, with the ICE in wire order")
    }

    /// The frames a live connection depends on — its peer's answer, candidates
    /// and reveal — must survive the router. Consuming those would be a session
    /// that opens and then never completes its handshake.
    func testALiveSessionsOwnFramesArePassedThrough() {
        let gate = InboundGate()
        _ = gate.classify(from: "a", data: offer(.file))
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "Mac")
        channel.fireOpen()
        gate.handoff(to: signaling)

        XCTAssertEqual(gate.classify(from: "a", data: iceSignal("c9", sdpMid: "0", sdpMLineIndex: 0)),
                       .pass)
        XCTAssertEqual(gate.classify(from: "a", data: sdpSignal(kind: "answer", sdp: "v=0",
                                                                commit: "Yw==", generation: .file)),
                       .pass)
        XCTAssertEqual(gate.classify(from: "a", data: revealField(Reveal(key: "a", nonce: "b"))),
                       .pass)
    }

    /// Glare: the peer we are already connected to sends a *new* offer. Passing
    /// it on would drive `setRemoteDescription` on a live connection; the gate
    /// answers busy and stops it instead.
    func testAFreshOfferFromTheLivePeerIsRefusedRatherThanPassedOn() {
        let gate = InboundGate()
        _ = gate.classify(from: "a", data: offer(.file))
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "Mac")
        channel.fireOpen()
        gate.handoff(to: signaling)

        XCTAssertEqual(gate.classify(from: "a", data: offer(.file)), .busy(.file),
                       "a second offer from the live peer is glare, not a continuation")
        XCTAssertEqual(gate.classify(from: "a", data: offer(.text, caps: ["text/1"])), .busy(.text))
    }

    func testABusyMirrorRefusesBeforeAnythingIsReserved() {
        let gate = InboundGate()
        gate.setBusy(true)
        XCTAssertEqual(gate.classify(from: "a", data: offer(.file)), .busy(.file))
        XCTAssertFalse(gate.isEngaged)
        gate.setBusy(false)
        XCTAssertEqual(gate.classify(from: "a", data: offer(.file)), .reserved(.file))
    }

    /// Handoff replays in wire order and then gets out of the way: the
    /// connection owns its own signals from that point, so a later frame must
    /// not be buffered a second time.
    func testHandoffReplaysInOrderAndThenStopsBuffering() {
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "Mac")
        channel.fireOpen()
        var delivered: [String] = []
        signaling.onSignal = { _, data in
            if let sdp = parseSDP(data) { delivered.append(sdp.type) }
            if let ice = parseICE(data) { delivered.append(ice.candidate) }
        }

        let gate = InboundGate()
        _ = gate.classify(from: "a", data: offer(.file))
        _ = gate.classify(from: "a", data: iceSignal("c1", sdpMid: "0", sdpMLineIndex: 0))
        _ = gate.classify(from: "a", data: iceSignal("c2", sdpMid: "0", sdpMLineIndex: 0))
        XCTAssertTrue(delivered.isEmpty, "nothing is delivered before there is a connection")

        gate.handoff(to: signaling)
        XCTAssertEqual(delivered, ["offer", "c1", "c2"])

        // A frame arriving now reaches the connection live, through the slot.
        _ = gate.classify(from: "a", data: iceSignal("c3", sdpMid: "0", sdpMLineIndex: 0))
        gate.handoff(to: signaling)   // idempotent: nothing left to replay
        XCTAssertEqual(delivered, ["offer", "c1", "c2"], "a live frame must not be replayed twice")
    }

    func testReleaseKindsOnlyTouchTheirOwnPhase() {
        let gate = InboundGate()
        _ = gate.classify(from: "a", data: offer(.file))
        gate.releaseIfLive()
        XCTAssertTrue(gate.isEngaged, "a pending attempt is not a live session")
        gate.releaseIfPending()
        XCTAssertFalse(gate.isEngaged)

        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "Mac")
        channel.fireOpen()
        _ = gate.classify(from: "a", data: offer(.file))
        gate.handoff(to: signaling)
        gate.releaseIfPending()
        XCTAssertTrue(gate.isEngaged, "a handed-off session is not a pending attempt")
        gate.releaseIfLive()
        XCTAssertFalse(gate.isEngaged)
    }
}
