import Network
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumLocalPeerKit
import RelayiumShareKit

private final class NoOpFakeConnection: LocalPeerConnection {
    var onBytes: ((Data) -> Void)?
    var onClosed: (() -> Void)?
    func start() {}
    func send(_ bytes: Data) {}
    func cancel() {}
}

/// A transport that is READY the moment it is started: the roster and the open
/// edge are announced synchronously from `start`, before it returns — the local
/// link with a peer already advertising on it. Anything the composition has not
/// installed by then never hears these edges, because nothing re-sends them.
private final class SynchronouslyReadyFakeTransport: LocalPeerTransport {
    let peer: LocalPeerAdvertisement
    init(peer: LocalPeerAdvertisement) { self.peer = peer }

    func start(advertising advertisement: LocalPeerAdvertisement,
               delegate: LocalPeerTransportDelegate) {
        delegate.localPeerTransport(didDiscover: [peer])
        delegate.localPeerTransportDidStart()
    }
    func connect(to peer: LocalPeerAdvertisement) -> LocalPeerConnection {
        NoOpFakeConnection()
    }
    func stop() {}
}

/// Starts, then fails on demand — the local link going away, which is the only
/// thing this composition can lose.
private final class FailingFakeTransport: LocalPeerTransport, @unchecked Sendable {
    private var delegate: LocalPeerTransportDelegate?
    func start(advertising advertisement: LocalPeerAdvertisement,
               delegate: LocalPeerTransportDelegate) {
        self.delegate = delegate
        delegate.localPeerTransportDidStart()
    }
    func fail() { delegate?.localPeerTransportDidFail() }
    func connect(to peer: LocalPeerAdvertisement) -> LocalPeerConnection {
        NoOpFakeConnection()
    }
    func stop() { delegate = nil }
}

final class LocalNearbyDiscoveryTests: XCTestCase {
    private let id = "0123456789abcdef0123456789abcdef"
    private let caps = ["text/1", "link/1"]

    func testServiceScopeIsOneLocalTCPType() {
        XCTAssertEqual(LOCAL_PEER_SERVICE_TYPE, "_relayium._tcp")
        XCTAssertEqual(LOCAL_PEER_SERVICE_DOMAIN, "local.")
    }

    func testIdentityIsFreshLowercaseHex() {
        let first = LocalPeerAdvertisement.mintIdentity()
        let second = LocalPeerAdvertisement.mintIdentity()
        XCTAssertTrue(LocalPeerAdvertisement.isValidIdentity(first))
        XCTAssertTrue(LocalPeerAdvertisement.isValidIdentity(second))
        XCTAssertNotEqual(first, second)
    }

    func testExactAdvertisementRoundTrips() {
        let value = LocalPeerAdvertisement(identity: id, name: "iPad", capabilities: caps)
        XCTAssertEqual(value.serviceInstanceName, id)
        XCTAssertEqual(value.txtRecord["c"], "text/1,link/1")
        XCTAssertEqual(LocalPeerAdvertisement.parse(instanceName: id,
                                                     txtRecord: value.txtRecord), value)
    }

    /// What goes on the wire is what the roster hello and the SDP confirmation
    /// compose, read from one function. Two spellings of "what this build
    /// speaks" is how an advertisement promises a wire the routing predicate
    /// then refuses.
    func testAdvertisedCapabilitiesAreTheSameListTheHelloAnnounces() {
        XCTAssertEqual(
            capsField(LocalNearbyEnvironment.advertisedCapabilities),
            linkCapsHello(linkRoomActive: linkRoomActive(isCodelessRoom: true)))
    }

    func testMalformedOrExpandedAdvertisementsAreRejected() {
        let valid = ["i": id, "n": "iPhone", "c": "text/1"]
        func mutated(_ changes: [String: String?]) -> [String: String] {
            var copy = valid
            for (key, value) in changes { copy[key] = value }
            return copy
        }

        XCTAssertNotNil(LocalPeerAdvertisement.parse(instanceName: id, txtRecord: valid))
        // Instance name and advertised identity must be the same claim.
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: String(id.dropLast()),
                                                   txtRecord: valid))
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id,
                                                   txtRecord: mutated(["i": id.uppercased()])))
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id, txtRecord: mutated(["n": ""])))
        XCTAssertNil(LocalPeerAdvertisement.parse(
            instanceName: id, txtRecord: mutated(["n": String(repeating: "x", count: 65)])))
        // An unknown key is an incompatible record, not a partly understood one.
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id,
                                                   txtRecord: mutated(["account": "secret"])))
        // A record with no capability field at all is the OLD shape, and this
        // build must not admit it and then guess what it speaks.
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id,
                                                   txtRecord: mutated(["c": nil])))
    }

    /// A capability list this build could not have meant is a record it does not
    /// understand. Admitting the advertisement with the survivable tokens would
    /// list a device as able to do something nobody established.
    func testMaliciousCapabilityFieldsRejectTheWholeAdvertisement() {
        for field in ["",                                        // no claim at all
                      ",",                                       // two empty claims
                      "text/1,",                                 // trailing empty claim
                      ",text/1",                                 // leading empty claim
                      "text/1,text/1",                           // one claim, twice
                      "text/1 ",                                 // whitespace a comparison cannot match
                      "link/1\u{0}",                             // embedded NUL
                      "li\u{202e}nk/1",                          // bidi override
                      String(repeating: "x", count: 25),         // over the per-token bound
                      (1...9).map { "c/\($0)" }.joined(separator: ",")] { // over the list bound
            XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id,
                                                       txtRecord: ["i": id, "n": "iPhone",
                                                                   "c": field]),
                         "the capability field \(field.debugDescription) was admitted")
        }

        // And the bounds admit what they are meant to admit.
        XCTAssertEqual(LocalPeerAdvertisement.parse(
            instanceName: id,
            txtRecord: ["i": id, "n": "iPhone", "c": "text/1,link/1"])?.capabilities,
                       ["text/1", "link/1"])
    }

    /// A peer that announces a wire this build does not speak is admitted and
    /// carried VERBATIM. Rewriting it to something recognisable is the forgery;
    /// `PeerCapabilityRegistry.supports` is where exactness is enforced.
    func testUnknownCapabilitiesSurviveParsingUnchanged() {
        XCTAssertEqual(LocalPeerAdvertisement.parse(
            instanceName: id,
            txtRecord: ["i": id, "n": "iPhone", "c": "link/2"])?.capabilities, ["link/2"])
    }

    /// The composition regression the prepared-connection seam exists for: a
    /// transport that announces a `link/1` peer and readiness synchronously
    /// inside `start` — before `begin()`'s dispatch even returns — must still
    /// end with that peer listed AND credited, because the model installs every
    /// callback and the capability listener before the transport is armed.
    /// Under the old ordering (`channel.begin()` inside the connect factory,
    /// installation afterwards) those first frames race handlers that may not
    /// exist yet, and a lost capability credit is lost for good.
    @MainActor
    func testPeerAlreadyOnTheLinkIsListedWithItsLinkCapability() async {
        let transport = SynchronouslyReadyFakeTransport(
            peer: .init(identity: id, name: "iPad", capabilities: caps))
        let model = LocalNearbyEnvironment.makeDiscoveryModel(transport: { transport })
        model.start()

        // Deterministic yields, no clocks: the channel's queue runs the whole
        // synchronous-ready chain the moment it is armed; yielding hands the
        // main actor over until its hops have landed, bounded so a lost frame
        // fails instead of hanging.
        for _ in 0..<10_000 {
            if model.devices.first?.supportsLink == true { break }
            await Task.yield()
        }

        XCTAssertEqual(model.devices.map(\.id), [id])
        XCTAssertEqual(model.devices.first?.supportsLink, true)
        model.stop()
    }

    /// **The composition, not the seam: what a real iOS drop actually says.**
    ///
    /// `LanDiscoveryModel`'s default drop banner names the hub's rendezvous
    /// socket, which is exactly right for the macOS pane and false here — this
    /// composition has no rendezvous, only a Bonjour transport that stopped.
    /// `LanDiscoveryTests` covers the parameter in both positions; this covers
    /// the one call site iOS actually ships, because a correct default and a
    /// correct override still leave the possibility that this factory forgot to
    /// pass it.
    ///
    /// The state is asserted, not the argument: `reconnectingCopy` is private,
    /// and a test that read it back would pass against a model that never
    /// rendered it.
    @MainActor
    func testTheShippedIOSCompositionDropsWithTheLocalLinkSentence() async {
        let transport = FailingFakeTransport()
        let model = LocalNearbyEnvironment.makeDiscoveryModel(transport: { transport })
        model.start()

        for _ in 0..<10_000 {
            if case .reconnecting = model.state { break }
            transport.fail()
            await Task.yield()
        }

        guard case .reconnecting(let text) = model.state else {
            model.stop()
            return XCTFail("the shipped composition never reached a drop: \(model.state)")
        }
        model.stop()
        XCTAssertEqual(text, L10n.t(.nearbyIOSReconnecting))
        XCTAssertNotEqual(text, L10n.t(.nearbyReconnecting),
                          "the shipped iOS composition still names a rendezvous it never had")
    }

    /// A channel whose room is already fully formed the instant it is armed:
    /// the activation synchronously replays `welcome`, the capability credit
    /// and the roster, with no queue in between. Purely synchronous on purpose
    /// — this is the model-level ordering pin the GCD-backed composition test
    /// above cannot make deterministic.
    private final class ScriptedReadyChannel: WebSocketChannel {
        var onOpen: (() -> Void)?
        var onText: ((String) -> Void)?
        var onClose: (() -> Void)?
        var isOpen: Bool { true }
        func send(_ text: String) {}
        func close() {}

        func emit(_ envelope: Envelope) {
            let data = try! JSONEncoder().encode(envelope)
            onText?(String(data: data, encoding: .utf8)!)
        }
    }

    /// The prepared-connection contract itself: `openSocket` runs the
    /// activation EXACTLY once, and only after every callback and the
    /// capability listener are installed. Under the old ordering — the
    /// transport armed inside the connect factory, installation afterwards —
    /// every frame this activation replays lands in a nil handler and an empty
    /// listener list, the roster is lost for good, and this test fails.
    @MainActor
    func testActivationRunsExactlyOnceAndOnlyAfterCallbacksAreInstalled() async {
        let peerId = id
        var activations = 0
        let model = LanDiscoveryModel(prepare: {
            let channel = ScriptedReadyChannel()
            let client = SignalingClient(channel: channel, name: "iPhone")
            return PreparedNearbyConnection(client: client, activate: {
                activations += 1
                channel.emit(Envelope(type: SignalType.welcome, name: "self-id", ip: ""))
                channel.emit(Envelope(type: SignalType.signal, from: peerId,
                                      data: capsField(["text/1", "link/1"])))
                channel.emit(Envelope(type: SignalType.peers,
                                      peers: [Peer(id: "self-id", name: "iPhone"),
                                              Peer(id: peerId, name: "iPad")]))
            })
        })
        model.start()

        // The activation ran synchronously inside `start()`; only the model's
        // own main-actor hops are outstanding. Same settle shape as
        // `LanDiscoveryTests`.
        for _ in 0..<10 {
            if model.devices.first?.supportsLink == true { break }
            await Task.yield()
        }

        XCTAssertEqual(activations, 1)
        XCTAssertEqual(model.devices.map(\.id), [peerId])
        XCTAssertEqual(model.devices.first?.supportsLink, true)
        XCTAssertEqual(model.announcedName, "iPhone")
        model.stop()
    }

    /// **The reverse direction's real emission order, end to end.**
    ///
    /// `LocalPeerSignalingChannel` answers a join with `welcome` and a roster of
    /// ONE — itself — when the browser has not delivered anybody yet, and only
    /// afterwards credits the peer it then finds and republishes the roster that
    /// names it. Physical run `7e1970a0` proved every one of those four frames
    /// correct on the connector and the device still listed with no
    /// capabilities: the self-only roster is DELIVERED before the credit and
    /// PROJECTED after it, so the retain it drives is against a membership that
    /// predates the announcement it deletes.
    ///
    /// Replayed synchronously through the prepared connection, which is what
    /// makes the order a fact of the test rather than of the queue.
    @MainActor
    func testTheSelfOnlyRosterAJoinAnswersDoesNotDeleteTheCreditBehindIt() async {
        let peerId = id
        let model = LanDiscoveryModel(prepare: {
            let channel = ScriptedReadyChannel()
            let client = SignalingClient(channel: channel, name: "iPhone")
            return PreparedNearbyConnection(client: client, activate: {
                channel.emit(Envelope(type: SignalType.welcome, name: "self-id", ip: ""))
                channel.emit(Envelope(type: SignalType.peers,
                                      peers: [Peer(id: "self-id", name: "iPhone")]))
                channel.emit(Envelope(type: SignalType.signal, from: peerId,
                                      data: capsField(["text/1", "link/1"])))
                channel.emit(Envelope(type: SignalType.peers,
                                      peers: [Peer(id: "self-id", name: "iPhone"),
                                              Peer(id: peerId, name: "iPad")]))
            })
        })
        model.start()

        for _ in 0..<10 {
            if model.devices.first?.supportsLink == true { break }
            await Task.yield()
        }

        XCTAssertEqual(model.devices.map(\.id), [peerId])
        XCTAssertEqual(model.devices.first?.supportsLink, true,
                       "the join's self-only roster deleted the credit that followed it")
        XCTAssertEqual(model.devices.first?.announcesLegacyText, true)
        model.stop()
    }

    // MARK: - the interface policy

    /// The shipped default prohibits `.loopback`, and only an explicit opt-in
    /// changes that.
    ///
    /// Both halves matter. A default that is checked but overridable everywhere
    /// is worth nothing, and so is an opt-in whose default was flipped
    /// underneath it — so what a DEFAULT-CONSTRUCTED transport resolves is
    /// asserted too, which is the answer every shipped composition builds.
    ///
    /// The seam permits a same-host route and nothing else: `includePeerToPeer`
    /// is false in both answers, so no build can quietly gain AWDL or Bluetooth.
    func testLoopbackIsProhibitedByDefaultAndTheSeamWidensNothingElse() {
        XCTAssertEqual(NetworkLocalPeerTransport.parameters().prohibitedInterfaceTypes,
                       [.loopback],
                       "the shipped default no longer keeps this transport off loopback")
        XCTAssertEqual(
            NetworkLocalPeerTransport.parameters(sameHostAcceptanceAllowsLoopback: false)
                .prohibitedInterfaceTypes,
            [.loopback],
            "the explicit production answer disagrees with the default")

        let shipped = NetworkLocalPeerTransport().parameters()
        XCTAssertEqual(shipped.prohibitedInterfaceTypes, [.loopback],
                       "a default-constructed transport no longer prohibits loopback")
        XCTAssertFalse(shipped.includePeerToPeer,
                       "a default-constructed transport turned on peer-to-peer")

        for allowsLoopback in [true, false] {
            XCTAssertFalse(
                NetworkLocalPeerTransport
                    .parameters(sameHostAcceptanceAllowsLoopback: allowsLoopback)
                    .includePeerToPeer,
                "sameHostAcceptanceAllowsLoopback: \(allowsLoopback) turned on peer-to-peer")
        }
        XCTAssertFalse(
            NetworkLocalPeerTransport(sameHostAcceptanceAllowsLoopback: true)
                .parameters().includePeerToPeer,
            "the opt-in reaches beyond the loopback prohibition")

        // The permissive answer exists in Debug only. This suite builds Debug,
        // so it is asserted here; the Release half is asserted by source, in
        // `LocalNearbyModuleBoundaryTests`, because no Debug test can observe a
        // branch that is not compiled.
        #if DEBUG
        // `?? []` because the property is optional and nil means "nothing
        // prohibited", which is the same answer this asserts.
        XCTAssertEqual(
            NetworkLocalPeerTransport
                .parameters(sameHostAcceptanceAllowsLoopback: true)
                .prohibitedInterfaceTypes ?? [],
            [],
            "the same-host answer still prohibits the one interface it exists to permit")
        #endif
    }
}
