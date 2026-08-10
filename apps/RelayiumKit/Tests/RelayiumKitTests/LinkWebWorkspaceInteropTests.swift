import WebRTC
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **Web ↔ macOS `link/1`, at the exact version, against the frames a browser
/// really puts on the wire.**
///
/// ## What this is, and what it deliberately is not
///
/// It is protocol-faithful, not a live browser. Two halves, and the split is the
/// honest part:
///
///  1. **The signalling half is byte-exact.** Every frame the scripted peer
///     sends below is the literal JSON the deployed Web client produces —
///     `{"caps":[…]}` from `peer-caps.svelte.ts`'s `capsSignal()`, and the
///     `link`-generation SDP envelope from `webrtc.ts`'s `sdpExtra`. Nothing
///     here is built by calling the native producer and then asserting the
///     native parser agrees with it, which would be a tautology; the literals
///     are the contract, and a native change that stopped accepting them fails
///     here.
///  2. **The lane half is ONE end, and it is stated as one.** The mixed workload
///     — one SAS, a conversation and several file batches on ONE link — runs
///     through the production router, room session, factory, attempt, runtime
///     and both lane drivers, down to a transport double that records the bytes
///     each lane was handed. What the assertions then check is that those bytes
///     are ones the browser's own demux has a class for
///     (`linkFileFrameClass`, `LINK_TEXT_REQUEST`), not that a second endpoint
///     decoded them.
///
/// **What it does NOT prove**, and must not be read as proving:
///
///  - that a real browser, on a real network, with a real `RTCPeerConnection`,
///    completes this. That needs a hosted run against the deployed Web build.
///  - that a second endpoint DECRYPTS what this one sealed. The AEAD, the
///    manifest encoding and the resume wire have their own two-ended vector
///    tests (`LinkFileProtocolTests`, `LinkFileResumeWireTests`,
///    `RealtimeWireVectors`); this file does not repeat them and does not stand
///    in for them.
///  - anything about the pairing-code room's TURN behaviour, which is
///    `LinkPairingRoomTests`.
@MainActor
final class LinkWebWorkspaceInteropTests: XCTestCase {

    // MARK: - the exact frames a browser sends

    /// `capsSignal()` in `web/src/lib/peer-caps.svelte.ts`, verbatim, for a build
    /// with `LINK_BUILD_SUPPORT = true` in a room `linkRoomActive()` allows.
    private let webLinkHello = #"{"caps":["text/1","link/1"]}"#
    /// The same function on an older Web build, and on the CLI and every native
    /// client still on the shipped wire.
    private let webLegacyHello = #"{"caps":["text/1"]}"#

    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    /// The `link`-generation SDP envelope `webrtc.ts` puts on the wire: the SDP,
    /// the generation tag, the handshake commit and the per-connection capability
    /// confirmation, in one frame.
    private func webLinkOffer(sdp: String = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n",
                              commit: String = "Y29tbWl0") -> JSONValue {
        .object([
            "link": .bool(true),
            "sdp": .object(["type": .string("offer"), "sdp": .string(sdp)]),
            "commit": .string(commit),
            "caps": .array([.string("text/1"), .string("link/1")]),
        ])
    }

    // MARK: - 1. the announcement, byte for byte

    /// A browser's roster hello activates link mode on this build, and an older
    /// browser's does not. The exactness is the whole downgrade boundary.
    func testABrowsersCapsHelloIsUnderstoodExactly() throws {
        let registry = PeerCapabilityRegistry(linkRoomActive: { true })

        XCTAssertTrue(registry.record(peerId: "web", signal: try json(webLinkHello)),
                      "the browser's hello must be recognised as a hello")
        XCTAssertTrue(registry.supports("web", LINK_CAPABILITY))
        XCTAssertTrue(registry.supports("web", TEXT_CAPABILITY))

        XCTAssertTrue(registry.record(peerId: "old", signal: try json(webLegacyHello)))
        XCTAssertFalse(registry.supports("old", LINK_CAPABILITY),
                       "an older Web build is legacy and must never be offered a link")
        XCTAssertTrue(registry.supports("old", TEXT_CAPABILITY))
    }

    /// And what THIS build says back is the same list the browser reads, in the
    /// same shape, so neither side has to special-case the other.
    func testThisBuildAnswersWithTheSameHelloShape() throws {
        let hello = linkCapsHello(linkRoomActive: true)
        let encoded = try JSONEncoder().encode(hello)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: encoded)
        XCTAssertEqual(decoded, try json(webLinkHello),
                       "the native hello must be byte-equivalent to the browser's")
    }

    /// A browser's link-generation offer is classified as one, and nothing else
    /// is. `signalGeneration` is what keeps a link offer away from the legacy
    /// inbound router, which is the failure that makes an older peer wait out a
    /// stall watchdog.
    func testABrowsersLinkOfferIsClassifiedAsLinkAndNotAsALegacyOffer() {
        let offer = webLinkOffer()
        XCTAssertTrue(isLinkOffer(offer))
        XCTAssertNil(inboundOfferGeneration(offer),
                     "the legacy unsolicited-offer router must pass a link offer through")
        XCTAssertEqual(signalGeneration(offer), .link)
    }

    /// The browser's `linkRequest`, `busy` and `leave` shapes, which the native
    /// admission layer routes on.
    func testTheBrowsersControlFramesAreRecognisedByShape() throws {
        XCTAssertTrue(isLinkRequest(try json(#"{"link":true,"linkRequest":true}"#)))
        XCTAssertTrue(isLinkBusy(try json(#"{"busy":true,"link":true}"#)))

        let tag = String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH)
        XCTAssertEqual(parsedLinkLeaveAuth(try json(#"{"link":true,"leave":true,"auth":"\#(tag)"}"#)),
                       tag)
        // The allow-list, which is what keeps a leave inert everywhere else.
        XCTAssertNil(parsedLinkLeaveAuth(
            try json(#"{"link":true,"leave":true,"auth":"\#(tag)","caps":["link/1"]}"#)),
                     "a leave may not smuggle a capability claim past the registry")
    }

    // MARK: - 2. a scripted browser against the real Workspace

    private final class InteropRig {
        let model: LinkWorkspaceModel
        let capabilities: PeerCapabilityRegistry
        let channel: FakeWebSocketChannel
        let signaling: SignalingClient
        var assembledPeers: [String] = []
        var assembledRoles: [Role] = []
        var initialSignals: [JSONValue?] = []
        var transports: [InteropTransport] = []

        init(model: LinkWorkspaceModel, capabilities: PeerCapabilityRegistry,
             channel: FakeWebSocketChannel, signaling: SignalingClient) {
            self.model = model
            self.capabilities = capabilities
            self.channel = channel
            self.signaling = signaling
        }
    }

    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-interop-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// The Workspace, in a room whose self id makes the BROWSER the offerer —
    /// which is the ordinary shape, because the browser's page-load id is the
    /// one a user reaches for first.
    private func interopRig(selfId: String = "zzz-mac",
                            requiresVerification: Bool = false) -> InteropRig {
        let capabilities = PeerCapabilityRegistry(linkRoomActive: { true })
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "Mac")
        channel.fireOpen()
        channel.fire(Envelope(type: SignalType.welcome, name: selfId))

        let dir = self.dir!
        var box: InteropRig?
        let model = LinkWorkspaceModel(
            capabilities: capabilities,
            receiveDirectory: { dir },
            requiresVerification: { requiresVerification },
            iceClient: nil,
            assemble: { signaling, peerId, role, ice, relayOnly, generation,
                        directory, admission, signal in
                let transport = InteropTransport()
                box?.transports.append(transport)
                box?.assembledPeers.append(peerId)
                box?.assembledRoles.append(role)
                box?.initialSignals.append(signal)
                return LinkSessionFactory.make(
                    signaling: signaling, peerId: peerId, role: role, iceServers: ice,
                    iceTransportPolicy: relayOnly ? .relay : .all,
                    authenticationGeneration: generation,
                    receiveDirectory: directory, admission: admission,
                    deadlines: LinkDeadlines(), initialSignal: signal,
                    buildInitialTransport: { _, _, _, _, _, _, _ in transport },
                    buildReplacementFactory: { _, _, _, _ in
                        { _ in throw LinkTransportError.notReady }
                    })
            })
        let rig = InteropRig(model: model, capabilities: capabilities,
                             channel: channel, signaling: signaling)
        box = rig
        model.roomDidConnect(signaling)
        return rig
    }

    private func settle(_ turns: Int = 12) async {
        for _ in 0..<turns { await Task.yield() }
    }

    /// The whole discovery-to-establishment path, driven by the browser's own
    /// frames: it greets, it offers, and the Mac assembles a responder for it.
    func testABrowserGreetsAndOffersAndTheMacAssemblesTheResponder() async throws {
        let rig = interopRig()
        // "aaa-web" is the smaller id, so the browser offers and the Mac answers
        // — the deterministic role rule both clients compute identically.
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa-web",
                                  data: try json(webLinkHello)))
        rig.capabilities.record(peerId: "aaa-web", signal: try json(webLinkHello))
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa-web",
                                  data: webLinkOffer()))
        await settle()

        XCTAssertEqual(rig.assembledPeers, ["aaa-web"])
        XCTAssertEqual(rig.assembledRoles, [.responder],
                       "the smaller id offers; this side must never offer back")
        XCTAssertEqual(rig.initialSignals.first ?? nil, webLinkOffer(),
                       "the offer the room consumed is handed to the transport, once")
        XCTAssertTrue(rig.model.connection.isActive)
    }

    /// An older browser is left entirely alone: no link is assembled, and the
    /// Workspace's legacy text/file paths own that peer.
    func testAnOlderBrowserIsLeftOnTheLegacyPaths() async throws {
        let rig = interopRig()
        rig.capabilities.record(peerId: "aaa-web", signal: try json(webLegacyHello))
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa-web",
                                  data: webLinkOffer()))
        await settle()

        XCTAssertTrue(rig.assembledPeers.isEmpty,
                      "a peer that announced only text/1 must not be routed into link mode")
        XCTAssertEqual(rig.model.connection, .idle)
        XCTAssertFalse(rig.model.canLink(peerId: "aaa-web"))
    }

    /// A relay that strips the browser's hello denies the feature rather than
    /// producing a link the browser is not in.
    func testAStrippedHelloDeniesRatherThanDowngrades() async throws {
        let rig = interopRig()
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa-web",
                                  data: webLinkOffer()))
        await settle()
        XCTAssertTrue(rig.assembledPeers.isEmpty)
    }

    // MARK: - 3. one link, one SAS, mixed text and repeated file batches

    /// **The acceptance workload, over two real runtimes.**
    ///
    /// One authenticated link, one set of digits, then a conversation and THREE
    /// file batches across it — with the first batch armed before the digits were
    /// compared and released only afterwards, and the room socket lost part way
    /// through without the link noticing.
    func testOneLinkCarriesOneSasThenTextAndSeveralBatchesAcrossSignalingLoss() async throws {
        let rig = interopRig(requiresVerification: true)
        rig.capabilities.record(peerId: "aaa-web", signal: try json(webLinkHello))
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa-web",
                                  data: webLinkOffer()))
        await settle()

        let transport = try XCTUnwrap(rig.transports.first)

        // The user staged a batch before anything was verified.
        rig.model.send(files: [FileMeta(name: "report.pdf", size: 16, path: nil)],
                       sources: [DataSource(name: "report.pdf",
                                            bytes: [UInt8](repeating: 1, count: 16))])
        XCTAssertEqual(rig.model.armedFiles.map(\.name), ["report.pdf"],
                       "a send before the link is open arms rather than leaks")

        // The browser and the Mac derive the same digits from commit/reveal; the
        // transport publishes them.
        transport.publish(peerId: "aaa-web", role: .responder, sas: "195023")
        await settle()

        XCTAssertEqual(rig.model.verification, .pending(sas: "195023"))
        XCTAssertNil(transport.sent[.file], "nothing leaves before the digits are compared")

        rig.model.confirmSAS()
        await settle()
        XCTAssertTrue(rig.model.armedFiles.isEmpty)
        XCTAssertEqual(try XCTUnwrap(rig.model.fileModel).outbound.count, 1,
                       "the armed batch is released exactly once")

        // A conversation on the SAME link. The browser's lane sees the one-byte
        // REQUEST that `mixed-text-session.svelte.ts` answers.
        rig.model.send(message: "here it is")
        await settle()
        XCTAssertEqual(transport.sent[.text]?.first, [LINK_TEXT_REQUEST])

        // The room socket goes away. The lanes are an SCTP association and do not
        // need it.
        rig.model.roomDidDisconnect()
        await settle()
        XCTAssertTrue(rig.model.connection.isOpen)
        XCTAssertTrue(rig.model.signalingLost)

        // Two MORE batches, after the loss, with no new code and no new digits.
        rig.model.send(files: [FileMeta(name: "b.bin", size: 8, path: nil)],
                       sources: [DataSource(name: "b.bin", bytes: [UInt8](repeating: 2, count: 8))])
        rig.model.send(files: [FileMeta(name: "c.bin", size: 8, path: nil)],
                       sources: [DataSource(name: "c.bin", bytes: [UInt8](repeating: 3, count: 8))])
        await settle()

        let outbound = try XCTUnwrap(rig.model.fileModel).outbound
        XCTAssertEqual(outbound.map(\.files.first?.name), ["report.pdf", "b.bin", "c.bin"])
        XCTAssertEqual(Set(outbound.map(\.id)).count, 3, "three batches, three lane ids")
        XCTAssertEqual(rig.model.verification, .confirmed, "and still one verification")
        XCTAssertEqual(rig.transports.count, 1, "on one connection throughout")
    }

    /// The manifest the Mac puts on the file lane is the `link/1` frame the
    /// browser's demux routes — not a legacy one, and not something the browser
    /// would have to special-case.
    func testTheOutboundManifestIsALinkFileFrameTheBrowserWouldRoute() async throws {
        let rig = interopRig()
        rig.capabilities.record(peerId: "aaa-web", signal: try json(webLinkHello))
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa-web",
                                  data: webLinkOffer()))
        await settle()
        let transport = try XCTUnwrap(rig.transports.first)
        transport.publish(peerId: "aaa-web", role: .responder)
        await settle()

        rig.model.send(files: [FileMeta(name: "a.bin", size: 8, path: nil)],
                       sources: [DataSource(name: "a.bin", bytes: [UInt8](repeating: 9, count: 8))])
        await settle()

        let frames = try XCTUnwrap(transport.sent[.file])
        XCTAssertFalse(frames.isEmpty, "a batch must reach the lane")
        for frame in frames {
            XCTAssertNotEqual(linkFileFrameClass(frame), .unroutable,
                              "every frame must land in a class the browser's demux has")
        }
        XCTAssertTrue(frames.contains { linkFileFrameClass($0) == .protected },
                      "the manifest travels as a protected frame")
    }
}

// MARK: - the transport under an interop run

/// A `link/1` transport whose only job is to be driven from a test: it records
/// what each lane was asked to send and can publish an identity whose keys are
/// the mirror of a peer's.
private final class InteropTransport: LinkRoutableInitialTransport, @unchecked Sendable {
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

    /// The two mirrored halves of one link's session secrets: this side's send
    /// key is the peer's receive key, which is what makes one shared resume
    /// authentication derivable from two different `LinkCodecs`.
    func publish(peerId: String, role: Role, sas: String = "424242") {
        let identity = LinkIdentity(
            peerId: peerId, role: role, sas: sas,
            codecs: LinkCodecs(sendKey: [UInt8](repeating: 0x11, count: 32),
                               recvKey: [UInt8](repeating: 0x22, count: 32)),
            authenticationGeneration: 1)
        onSAS?(sas)
        onReady?(identity)
    }
}
