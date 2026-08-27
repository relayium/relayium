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

    /// `advertisedCaps()` in `web/src/lib/peer-caps.svelte.ts` — READ from the
    /// generated vector, not transcribed into this file.
    ///
    /// It used to be the literal `{"caps":["text/1","link/1"]}`, described here
    /// as that function "verbatim". It had not been verbatim since
    /// `preupload/1` shipped, and both suites stayed green anyway, because the
    /// workflows are path-filtered (`macos.yml` on `apps/**`, `web.yml` on
    /// `web/**`) so no commit can run both. A hand-copied literal is not a
    /// cross-language assertion; it is one language asserting its own memory of
    /// the other, and this is what that costs.
    ///
    /// The list has since changed AGAIN — it is `["link/1", "preupload/1"]` now,
    /// because the browser withdrew `text/1` along with the single-lane
    /// conversation transport behind it — and this reader needed no edit for
    /// that, which is the point of reading it.
    private func webLinkHello() throws -> JSONValue {
        capsField(try webCaps("web"))
    }

    /// A peer whose hello is exactly `text/1`: a native client or the CLI on the
    /// shipped wire, and this build itself in a room where link mode is off.
    ///
    /// It is **not** "an older browser" and is no longer named as one. Older Web
    /// builds announced `text/1` *and* `link/1`, so they were link-capable; what
    /// this vector row describes is a peer with no `link/1` at all, which is the
    /// case that has to stay rejected. Today's browser, when it cannot open a
    /// link, announces an empty hello rather than this one — see the row's own
    /// comment in `gen-realtime-wire-vectors.mjs`.
    private func textOnlyHello() throws -> JSONValue {
        capsField(try webCaps("linkRoomInactive"))
    }

    private func webCaps(_ name: String) throws -> [String] {
        let v = try Vectors.load("realtime-wire-vectors")
        let block = try XCTUnwrap(v.json["capability"] as? [String: Any],
                                  "realtime-wire-vectors.json has no capability block; "
                                  + "run `node scripts/gen-realtime-wire-vectors.mjs` from web/")
        let hello = try XCTUnwrap(block["hello"] as? [String: Any])
        let entry = try XCTUnwrap(hello[name] as? [String: Any])
        return try XCTUnwrap((entry["caps"] as? [Any])?.compactMap { $0 as? String })
    }

    private func json(_ text: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    }

    /// The `link`-generation SDP envelope `webrtc.ts` puts on the wire: the SDP,
    /// the generation tag, the handshake commit and the per-connection capability
    /// confirmation, in one frame.
    ///
    /// The `caps` field is `sdpExtra: () => ({ commit, caps: [...localCaps()] })`
    /// in `webrtc.ts`, and `localCaps()` returns `advertisedCaps()` unchanged —
    /// so the per-connection confirmation is the SAME list as the roster hello.
    /// It is spelled out as a literal here **on purpose**: this is the one thing
    /// in the file that must break loudly if the browser's SDP confirmation and
    /// its roster hello ever drift apart, and reading both from one vector row
    /// would make that drift invisible. `testTheLinkOfferConfirmsTheSameCapsAsTheHello`
    /// pins the literal against the generated hello so the copy cannot rot in
    /// silence, which is the failure the reader above documents.
    private func webLinkOffer(sdp: String = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n",
                              commit: String = "Y29tbWl0") -> JSONValue {
        .object([
            "link": .bool(true),
            "sdp": .object(["type": .string("offer"), "sdp": .string(sdp)]),
            "commit": .string(commit),
            "caps": .array([.string("link/1"), .string("preupload/1")]),
        ])
    }

    // MARK: - 1. the announcement, byte for byte

    /// A browser's roster hello activates link mode on this build, and a hello
    /// without `link/1` does not. The exactness is the whole downgrade boundary.
    ///
    /// The browser's hello is now read for what it does NOT contain as well.
    /// `text/1` is absent, so this build must not conclude the browser can take a
    /// legacy conversation: the registry has to report that honestly rather than
    /// leaving a stale or inferred `text/1` standing, because the legacy lane the
    /// paused iOS build still ships routes on exactly this answer.
    func testABrowsersCapsHelloIsUnderstoodExactly() throws {
        let registry = PeerCapabilityRegistry(linkRoomActive: { true })

        XCTAssertTrue(registry.record(peerId: "web", signal: try webLinkHello()),
                      "the browser's hello must be recognised as a hello")
        XCTAssertTrue(registry.supports("web", LINK_CAPABILITY))
        XCTAssertFalse(registry.supports("web", TEXT_CAPABILITY),
                       "the browser withdrew text/1; reading it as present would route a "
                       + "legacy conversation at a page with no lane to answer it")

        XCTAssertTrue(registry.record(peerId: "old", signal: try textOnlyHello()))
        XCTAssertFalse(registry.supports("old", LINK_CAPABILITY),
                       "a peer with no link/1 must never be offered a link")
        XCTAssertTrue(registry.supports("old", TEXT_CAPABILITY))
    }

    /// The per-connection confirmation in the browser's link offer is the same
    /// list as its roster hello, and this is the assertion that keeps the literal
    /// in `webLinkOffer` honest.
    ///
    /// `localCaps()` is `advertisedCaps()` in `webrtc.ts`, with nothing between
    /// them, so one generated row is the truth for both. If the browser ever
    /// confirms something narrower or wider than it announced, that asymmetry is
    /// what strands a peer — it admits on the hello and then routes on the
    /// confirmation — and it fails here rather than at a stall watchdog.
    func testTheLinkOfferConfirmsTheSameCapsAsTheHello() throws {
        let confirmed = peerCaps(from: webLinkOffer())
        XCTAssertEqual(confirmed, try webCaps("web"),
                       "webLinkOffer's caps literal drifted from the generated Web hello; "
                       + "localCaps() returns advertisedCaps() unchanged, so they are one list")
        XCTAssertTrue(confirmed.contains(LINK_CAPABILITY))
        XCTAssertFalse(confirmed.contains(TEXT_CAPABILITY))
    }

    /// And what THIS build says back is a list the browser reads with the same
    /// rule, in the same shape, so neither side has to special-case the other.
    ///
    /// **Neither byte-equal nor a subset, and this test has claimed both in
    /// turn.** It first asserted equality, which was false once the browser
    /// shipped `preupload/1`; it then asserted that this build's hello was a
    /// SUBSET of the browser's, which was true only for as long as the browser
    /// still announced `text/1`. It does not: it withdrew that capability with
    /// the transport behind it. This build announces `text/1` for the paused iOS
    /// legacy lane and the browser announces `preupload/1` for its pre-upload
    /// handoff, so **neither list contains the other**, and any containment
    /// assertion here is a fiction that will be re-broken by the next capability
    /// either side ships alone.
    ///
    /// The contract is exactly one string wide: both hellos name `link/1`, that
    /// spelling and no other, and each side reads the other's hello as naming it.
    /// A capability only one side implements is a fact to be ignored, not a
    /// defect — ignoring it is precisely how a client that ships a lane the other
    /// does not keeps interoperating.
    func testBothHellosNameTheSameExactLinkAndNothingElseIsRequired() throws {
        let hello = linkCapsHello(linkRoomActive: true)
        let encoded = try JSONEncoder().encode(hello)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: encoded)
        XCTAssertEqual(decoded, capsField(try webCaps("native")),
                       "the native hello drifted from the generated statement of it")

        let native = peerCaps(from: decoded)
        let web = try webCaps("web")

        // The shared contract, from both directions, spelled exactly.
        XCTAssertEqual(native.filter { $0 == LINK_CAPABILITY }, [LINK_CAPABILITY],
                       "this build's hello no longer names exactly one link/1: \(native)")
        XCTAssertEqual(web.filter { $0 == LINK_CAPABILITY }, [LINK_CAPABILITY],
                       "the browser hello no longer names exactly one link/1: \(web)")

        // The browser's withdrawal is a recorded expectation, not an accident
        // this suite would tolerate either way: a browser announcing `text/1`
        // again would mean the deleted transport had come back. Nothing asserts
        // that the two lists stay non-containable — that IS an accident, and
        // pinning it would re-create the fiction this test just removed.
        XCTAssertFalse(web.contains(TEXT_CAPABILITY),
                       "the browser advertises a legacy lane it no longer implements: \(web)")

        // Read back through the browser's own rule, which is exact match on
        // `link/1` and nothing else.
        let asBrowserReadsIt = PeerCapabilityRegistry(linkRoomActive: { true })
        XCTAssertTrue(asBrowserReadsIt.record(peerId: "mac", signal: decoded))
        XCTAssertTrue(asBrowserReadsIt.supports("mac", LINK_CAPABILITY))
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
                                  data: try webLinkHello()))
        rig.capabilities.record(peerId: "aaa-web", signal: try webLinkHello())
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

    /// A peer with no `link/1` is left entirely alone: no link is assembled, and
    /// the Workspace's legacy text/file paths own that peer.
    func testATextOnlyPeerIsLeftOnTheLegacyPaths() async throws {
        let rig = interopRig()
        rig.capabilities.record(peerId: "aaa-web", signal: try textOnlyHello())
        rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa-web",
                                  data: webLinkOffer()))
        await settle()

        XCTAssertTrue(rig.assembledPeers.isEmpty,
                      "a peer that announced only text/1 must not be routed into link mode")
        XCTAssertEqual(rig.model.connection, .idle)
        XCTAssertFalse(rig.model.canLink(peerId: "aaa-web"))
    }

    /// **Every inbound tag that is not exactly `link/1` stays rejected**, and it
    /// is rejected even when a well-formed link offer arrives right behind it.
    ///
    /// The offer is the adversarial half. A peer that announces `LINK/1` and then
    /// sends the real `link`-generation envelope is asking this build to infer
    /// support from the frame instead of the hello. Case folding, a future
    /// version, an empty hello and the legacy lane are all equally not this
    /// protocol, and none of them may assemble anything.
    func testNoNonExactInboundTagCanReachALink() async throws {
        for caps in [[], ["text/1"], ["LINK/1"], ["link/2"], ["link/1x"],
                     ["Link/1", "preupload/1"], ["text/1", "link/2"]] {
            let rig = interopRig()
            rig.capabilities.record(peerId: "aaa-web", signal: capsField(caps))
            rig.channel.fire(Envelope(type: SignalType.signal, from: "aaa-web",
                                      data: webLinkOffer()))
            await settle()

            XCTAssertTrue(rig.assembledPeers.isEmpty,
                          "caps \(caps) reached a link; only exact link/1 may")
            XCTAssertEqual(rig.model.connection, .idle, "caps \(caps)")
            XCTAssertFalse(rig.model.canLink(peerId: "aaa-web"), "caps \(caps)")
        }
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
        rig.capabilities.record(peerId: "aaa-web", signal: try webLinkHello())
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
        rig.capabilities.record(peerId: "aaa-web", signal: try webLinkHello())
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
