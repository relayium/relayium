import XCTest
@testable import RelayiumKit
@testable import RelayiumLocalPeerKit

/// A synchronous stand-in for `NetworkLocalPeerConnection`.
///
/// Its close handler is owned by the same pure rules production uses
/// (`LocalPeerStreamHandlers`), so the double cannot be weaker than the
/// contract it stands for: an end observed before a close handler exists
/// remains owed to the first handler installed afterwards, a close is delivered
/// at most once, and clearing the handler does not consume an owed close. A
/// plain stored `onClosed` fired only from `cancel()` honoured none of that,
/// which let a channel that attaches to an already-ended stream look correct.
///
/// Two differences from production are deliberate and are the fake's, not the
/// contract's: `cancel()` delivers the close synchronously on the caller's
/// thread (production hears `.cancelled` from Network.framework on its queue),
/// and there is no lock, because every test here drives it from one thread at
/// a time. `LocalNearbyConcurrencyTests` owns the cross-queue case.
private final class LocalChannelFakeConnection: LocalPeerConnection {
    private var handlers = LocalPeerStreamHandlers()
    var onBytes: ((Data) -> Void)? {
        get { handlers.onBytes }
        set { handlers.onBytes = newValue }
    }
    var onClosed: (() -> Void)? {
        get { handlers.onClosed }
        set {
            // Decide under the state, call after it: the owed handler may
            // re-enter this connection.
            let owed = handlers.installCloseHandler(newValue)
            owed?()
        }
    }
    var written: [Data] = []
    var cancelled = false
    var started = false
    var onStart: (() -> Void)?

    func start() {
        started = true
        onStart?()
    }
    func send(_ bytes: Data) { written.append(bytes) }
    func cancel() {
        guard handlers.cancel() == .cancel else { return }
        cancelled = true
        end()
    }
    /// The stream ended without this side cancelling it: the remote closed, or
    /// the connection failed. Production reaches the same one-shot through
    /// `fireClosed()`.
    func end() {
        let callback = handlers.takeCloseCallback()
        callback?()
    }
    func deliver(_ envelope: Envelope) {
        let data = try! JSONEncoder().encode(envelope)
        onBytes?(LocalPeerFraming.encode(String(data: data, encoding: .utf8)!)!)
    }
    var envelopes: [Envelope] {
        var reader = LocalPeerFraming.Reader()
        return written.flatMap { (try? reader.append($0)) ?? [] }
            .compactMap { try? JSONDecoder().decode(Envelope.self, from: Data($0.utf8)) }
    }
}

private final class LocalChannelFakeTransport: LocalPeerTransport {
    weak var delegate: LocalPeerTransportDelegate?
    var advertised: LocalPeerAdvertisement?
    var dialled: [LocalPeerAdvertisement] = []
    var outbound: [String: LocalChannelFakeConnection] = [:]
    var stopped = false

    func start(advertising advertisement: LocalPeerAdvertisement,
               delegate: LocalPeerTransportDelegate) {
        advertised = advertisement
        self.delegate = delegate
    }
    func connect(to peer: LocalPeerAdvertisement) -> LocalPeerConnection {
        dialled.append(peer)
        let connection = LocalChannelFakeConnection()
        outbound[peer.identity] = connection
        return connection
    }
    func stop() { stopped = true }
}

final class LocalNearbyChannelTests: XCTestCase {
    private let mine = String(repeating: "1", count: 32)
    private let theirs = String(repeating: "2", count: 32)
    private let peerCaps = ["text/1", "link/1"]
    private var peer: LocalPeerAdvertisement {
        .init(identity: theirs, name: "iPad", capabilities: peerCaps)
    }
    private var queue: DispatchQueue!
    private var transport: LocalChannelFakeTransport!
    private var channel: LocalPeerSignalingChannel!
    private var texts: [String] = []
    private var timers: [() -> Void] = []

    override func setUp() {
        queue = DispatchQueue(label: "test.local.channel")
        transport = LocalChannelFakeTransport()
        texts = []
        timers = []
        channel = LocalPeerSignalingChannel(
            advertisement: .init(identity: mine, name: "iPhone",
                                 capabilities: ["text/1", "link/1"]),
            transport: transport,
            queue: queue,
            schedule: { [weak self] _, body in self?.timers.append(body) })
        channel.onText = { [weak self] in self?.texts.append($0) }
        channel.begin()
        drain()
    }

    private func drain() { queue.sync {} }
    private func openAndJoin() {
        transport.delegate?.localPeerTransportDidStart()
        drain()
        channel.send(#"{"type":"join","name":"iPhone"}"#)
        drain()
    }
    private func discover() {
        transport.delegate?.localPeerTransport(didDiscover: [peer])
        drain()
    }
    private func send(_ payload: JSONValue, to identity: String? = nil) {
        let envelope = Envelope(type: SignalType.signal, to: identity ?? theirs, data: payload)
        let data = try! JSONEncoder().encode(envelope)
        channel.send(String(data: data, encoding: .utf8)!)
        drain()
    }
    private var envelopes: [Envelope] {
        texts.compactMap { try? JSONDecoder().decode(Envelope.self, from: Data($0.utf8)) }
    }
    private func accept() -> LocalChannelFakeConnection {
        let connection = LocalChannelFakeConnection()
        transport.delegate?.localPeerTransport(didAccept: connection)
        drain()
        return connection
    }

    func testJoinSynthesizesWelcomeAndRosterWithSelfExactlyOnce() {
        openAndJoin()
        discover()
        XCTAssertEqual(envelopes.filter { $0.type == SignalType.welcome }.first?.name, mine)
        XCTAssertEqual(envelopes.filter { $0.type == SignalType.peers }.last?.peers?.map(\.id),
                       [mine, theirs])
    }

    func testDiscoveryAndCapabilityGreetingDoNotDial() {
        openAndJoin()
        discover()
        send(linkCapsHello(linkRoomActive: linkRoomActive(isCodelessRoom: true)))
        XCTAssertTrue(transport.dialled.isEmpty)
    }

    /// The no-dial rule is about the KIND of frame, not about one build's
    /// greeting. `LanDiscoveryModel.localHello` is injectable and
    /// `linkOnlyCapsHello` is already a shipped alternative, so a rule keyed to
    /// one exact value would start dialling every discovered device — without
    /// the user picking one — the day a composition passed a different hello.
    func testNoRosterLevelCapabilityAnnouncementDialsWhateverItAnnounces() {
        openAndJoin()
        discover()
        for hello in [linkOnlyCapsHello(linkRoomActive: true),
                      linkOnlyCapsHello(linkRoomActive: false),
                      capsField([]),
                      capsField(["text/1"]),
                      capsField(["some/future"])] {
            send(hello)
            XCTAssertTrue(transport.dialled.isEmpty,
                          "\(hello) opened a connection to a device nobody selected")
        }

        // And the rule stops at roster announcements: a frame that carries a
        // capability BESIDE an establishment is the session the user asked for.
        send(.object(["caps": .array([.string("link/1")]), "sdp": .string("v=0")]))
        XCTAssertEqual(transport.dialled.map(\.identity), [theirs])
    }

    /// Once the user has picked a device and a stream exists, the greeting is
    /// delivered on it — suppressing it there would deny the capability the
    /// announcer's retries exist to establish.
    func testTheGreetingIsDeliveredOnAStreamThatAlreadyExists() {
        openAndJoin()
        discover()
        send(.string("offer"))
        let stream = transport.outbound[theirs]
        let before = stream?.envelopes.count ?? 0

        send(linkCapsHello(linkRoomActive: linkRoomActive(isCodelessRoom: true)))

        XCTAssertEqual(transport.dialled.count, 1, "the greeting opened a second stream")
        XCTAssertEqual(stream?.envelopes.count, before + 1)
        XCTAssertEqual(stream?.envelopes.last?.data,
                       linkCapsHello(linkRoomActive: linkRoomActive(isCodelessRoom: true)))
    }

    func testOnlyAddressedDiscoveredSessionFrameDialsAndStampsSender() {
        openAndJoin()
        send(.string("offer"))
        XCTAssertTrue(transport.dialled.isEmpty)
        discover()
        send(.string("offer"), to: mine)
        XCTAssertTrue(transport.dialled.isEmpty)
        send(.string("offer"))
        XCTAssertEqual(transport.dialled.map(\.identity), [theirs])
        XCTAssertTrue(transport.outbound[theirs]?.started == true)
        XCTAssertEqual(transport.outbound[theirs]?.envelopes.first?.from, mine)
    }

    func testAcceptedConnectionStartsOnlyAfterHandlersAreInstalled() {
        openAndJoin()
        let connection = LocalChannelFakeConnection()
        var handlersWereInstalledAtStart = false
        connection.onStart = {
            handlersWereInstalledAtStart = connection.onBytes != nil
                && connection.onClosed != nil
        }

        transport.delegate?.localPeerTransport(didAccept: connection)
        drain()

        XCTAssertTrue(connection.started)
        XCTAssertTrue(handlersWereInstalledAtStart)
    }

    func testCapabilityCreditPrecedesFirstRosterAppearance() throws {
        openAndJoin()
        texts = []
        discover()
        let credit = try XCTUnwrap(envelopes.firstIndex { $0.type == SignalType.signal })
        let roster = try XCTUnwrap(envelopes.firstIndex { $0.type == SignalType.peers })
        XCTAssertLessThan(credit, roster)
    }

    func testPeerDiscoveredBeforeJoinStillGetsCapabilityCreditBeforeRoster() throws {
        transport.delegate?.localPeerTransportDidStart()
        drain()
        discover()
        texts = []
        channel.send(#"{"type":"join","name":"iPhone"}"#)
        drain()

        let credit = try XCTUnwrap(envelopes.firstIndex { $0.type == SignalType.signal })
        let roster = try XCTUnwrap(envelopes.firstIndex { $0.type == SignalType.peers })
        XCTAssertLessThan(credit, roster)
        XCTAssertEqual(envelopes[credit].from, theirs)
    }

    func testBrowseLossUpdatesRosterWithoutClaimingTheConnectionLeft() {
        openAndJoin()
        discover()
        texts = []

        transport.delegate?.localPeerTransport(didDiscover: [])
        drain()

        XCTAssertEqual(envelopes.last?.type, SignalType.peers)
        XCTAssertEqual(envelopes.last?.peers?.map(\.id), [mine])
        XCTAssertFalse(envelopes.contains { $0.type == "left" })
    }

    func testInboundRequiresDiscoveryAndStableIdentity() {
        openAndJoin()
        texts = []
        let connection = accept()
        connection.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                                 data: .string("offer")))
        drain()
        XCTAssertTrue(envelopes.isEmpty)
        discover()
        XCTAssertEqual(envelopes.last?.data, .string("offer"))

        let other = String(repeating: "3", count: 32)
        connection.deliver(.init(type: SignalType.signal, from: other, to: mine,
                                 data: .string("switch")))
        drain()
        XCTAssertTrue(connection.cancelled)
    }

    func testInboundGraceIsBoundedByTimeAndCount() {
        openAndJoin()
        let timed = accept()
        timed.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                            data: .string("offer")))
        drain()
        timers.first?()
        drain()
        XCTAssertTrue(timed.cancelled)

        let flooded = accept()
        for index in 0...LocalPeerSignalingChannel.maximumGraceFrames {
            flooded.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                                  data: .number(Double(index))))
        }
        drain()
        XCTAssertTrue(flooded.cancelled)
    }

    func testHeldInboundFramesKeepOrderAfterCapabilityCreditAndRoster() throws {
        openAndJoin()
        texts = []
        let connection = accept()
        connection.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                                 data: .string("first")))
        connection.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                                 data: .string("second")))
        drain()
        XCTAssertTrue(envelopes.isEmpty)

        discover()

        let signals = envelopes.filter { $0.type == SignalType.signal }
        // The DISCOVERED PEER's own advertisement, which is what this frame
        // carries. It used to be spelled with this build's `linkCapsHello`
        // because the two lists happened to be equal; they are different facts,
        // and stopped being equal when this build began announcing renewal.
        XCTAssertEqual(signals.first?.data, capsField(peerCaps))
        XCTAssertEqual(Array(signals.dropFirst().compactMap(\.data)),
                       [.string("first"), .string("second")])
        let roster = try XCTUnwrap(envelopes.firstIndex { $0.type == SignalType.peers })
        let firstHeld = try XCTUnwrap(envelopes.firstIndex { $0.data == .string("first") })
        XCTAssertLessThan(roster, firstHeld)
    }

    func testSimultaneousDialKeepsDeterministicConnectionWithoutFalseDeparture() {
        openAndJoin()
        discover()
        send(.string("outgoing"))
        texts = []
        let inbound = accept()
        inbound.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                              data: .string("incoming")))
        drain()

        XCTAssertTrue(inbound.cancelled, "the lower identity keeps its outbound stream")
        XCTAssertEqual(transport.dialled.map(\.identity), [theirs])
        XCTAssertEqual(transport.outbound[theirs]?.envelopes.first?.data, .string("outgoing"))
        XCTAssertFalse(envelopes.contains { $0.type == "left" })
    }

    func testConnectionCloseEmitsDepartureButBrowseLossDoesNot() {
        openAndJoin()
        discover()
        send(.string("offer"))
        texts = []

        transport.delegate?.localPeerTransport(didDiscover: [])
        drain()
        XCTAssertFalse(envelopes.contains { $0.type == "left" })

        transport.outbound[theirs]?.onClosed?()
        drain()
        XCTAssertEqual(envelopes.filter { $0.type == "left" }.count, 1)
        XCTAssertEqual(texts.last, #"{"type":"left","peer":"22222222222222222222222222222222"}"#)
    }

    func testForgedSelfIdentityAndOversizedFrameCloseTheStream() {
        openAndJoin()
        let forged = accept()
        forged.deliver(.init(type: SignalType.signal, from: mine, to: mine,
                             data: .string("spoof")))
        drain()
        XCTAssertTrue(forged.cancelled)

        let oversized = accept()
        oversized.onBytes?(Data([0xff, 0xff, 0xff, 0xff]))
        drain()
        XCTAssertTrue(oversized.cancelled)
    }

    func testCloseCancelsTransportAndConnectionsOnce() {
        openAndJoin()
        discover()
        send(.string("offer"))
        let connection = transport.outbound[theirs]
        channel.close()
        drain()
        XCTAssertTrue(transport.stopped)
        XCTAssertTrue(connection?.cancelled == true)
    }

    // MARK: - the edges an unarmed or torn-down channel must not deliver

    /// `SignalingClient` is built FROM this channel and installs its handlers
    /// afterwards. Nothing may be advertised, browsed or announced before that,
    /// or the open edge lands in a nil handler and no join is ever sent.
    func testNothingIsAdvertisedUntilTheChannelIsExplicitlyBegun() {
        let idleQueue = DispatchQueue(label: "test.local.channel.idle")
        let idleTransport = LocalChannelFakeTransport()
        let idle = LocalPeerSignalingChannel(
            advertisement: .init(identity: mine, name: "iPhone", capabilities: ["text/1"]),
            transport: idleTransport,
            queue: idleQueue,
            schedule: { _, _ in })
        idleQueue.sync {}

        XCTAssertNil(idleTransport.advertised, "the transport was armed before begin()")
        XCTAssertNil(idleTransport.delegate)
        XCTAssertFalse(idle.isOpen)

        // The handler an unarmed channel can still be given is the one the open
        // edge must reach, which is the whole reason arming is a second call.
        var opens = 0
        idle.onOpen = { opens += 1 }
        idle.begin()
        idleQueue.sync {}
        XCTAssertEqual(idleTransport.advertised?.identity, mine)
        idleTransport.delegate?.localPeerTransportDidStart()
        idleQueue.sync {}
        XCTAssertEqual(opens, 1)
    }

    /// A transport that announces readiness only after the handler exists still
    /// opens exactly once, and a repeat announcement is not a second open.
    func testOpenIsDeliveredOnceToTheInstalledHandler() {
        var opens = 0
        channel.onOpen = { opens += 1 }
        transport.delegate?.localPeerTransportDidStart()
        transport.delegate?.localPeerTransportDidStart()
        drain()
        XCTAssertEqual(opens, 1)
        XCTAssertTrue(channel.isOpen)
    }

    /// A transport that fails its start — which is how a refused Local Network
    /// permission and a down link both arrive — closes the channel, so
    /// `LanDiscoveryModel` leaves `connecting` and can retry.
    func testAFailedStartClosesTheChannelInsteadOfSearchingForever() {
        var closes = 0
        channel.onClose = { closes += 1 }
        transport.delegate?.localPeerTransportDidFail()
        drain()
        XCTAssertEqual(closes, 1)
        XCTAssertFalse(channel.isOpen)
        XCTAssertTrue(transport.stopped)

        // And a second failure from the same dead transport says nothing more.
        transport.delegate?.localPeerTransportDidFail()
        drain()
        XCTAssertEqual(closes, 1)
    }

    /// Every callback a stopped transport can still be holding. None of them may
    /// resurrect a socket, repopulate a roster, or emit into a closed channel.
    func testStaleTransportCallbacksAfterCloseResurrectNothing() {
        openAndJoin()
        discover()
        channel.close()
        drain()
        texts = []

        transport.delegate?.localPeerTransportDidStart()
        transport.delegate?.localPeerTransport(didDiscover: [peer])
        let late = LocalChannelFakeConnection()
        transport.delegate?.localPeerTransport(didAccept: late)
        drain()

        XCTAssertTrue(texts.isEmpty)
        XCTAssertFalse(channel.isOpen)
        XCTAssertFalse(late.started, "a stream accepted after close was read from")
        XCTAssertTrue(late.cancelled)
        XCTAssertTrue(transport.dialled.isEmpty)
    }

    /// The grace timer is armed per accepted stream and fires on its own clock.
    /// One that lands after the channel closed must not touch anything.
    func testAGracePeriodThatFiresAfterCloseIsSilent() {
        openAndJoin()
        let connection = accept()
        channel.close()
        drain()
        texts = []

        for timer in timers { timer() }
        drain()

        XCTAssertTrue(connection.cancelled)
        XCTAssertTrue(texts.isEmpty, "a timer from a closed channel emitted a departure")
    }

    // MARK: - capability admission

    /// The roster credits what the PEER advertised, not what this build speaks.
    /// A text-only peer must not be listed as able to answer a link.
    func testTheCapabilityCreditIsThePeersOwnAdvertisementNotOurs() throws {
        openAndJoin()
        texts = []
        transport.delegate?.localPeerTransport(
            didDiscover: [.init(identity: theirs, name: "iPad", capabilities: ["text/1"])])
        drain()

        let credit = try XCTUnwrap(envelopes.first { $0.type == SignalType.signal })
        XCTAssertEqual(credit.from, theirs)
        XCTAssertEqual(credit.data, capsField(["text/1"]))
        XCTAssertNotEqual(credit.data,
                          linkCapsHello(linkRoomActive: linkRoomActive(isCodelessRoom: true)))
    }

    /// A capability nobody in this build understands is relayed verbatim so the
    /// registry's exact match refuses it, rather than being rounded to one that
    /// would be accepted.
    func testAnUnknownCapabilityIsRelayedVerbatimAndCreditsNothingKnown() throws {
        openAndJoin()
        texts = []
        transport.delegate?.localPeerTransport(
            didDiscover: [.init(identity: theirs, name: "iPad", capabilities: ["link/2"])])
        drain()

        let credit = try XCTUnwrap(envelopes.first { $0.type == SignalType.signal })
        XCTAssertEqual(credit.data, capsField(["link/2"]))

        let registry = PeerCapabilityRegistry(linkRoomActive: { true })
        registry.record(peerId: theirs, signal: try XCTUnwrap(credit.data))
        XCTAssertFalse(registry.supports(theirs, LINK_CAPABILITY))
        XCTAssertFalse(registry.supports(theirs, TEXT_CAPABILITY))
    }

    /// The credit reaches a synchronous listener — which is where the registry
    /// records — strictly before the roster frame that would list the device.
    func testTheRegistryHasTheCreditBeforeTheRosterNamesThePeer() {
        openAndJoin()
        let registry = PeerCapabilityRegistry(linkRoomActive: { true })
        var supportedWhenListed: Bool?
        channel.onText = { text in
            guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8))
            else { return }
            if envelope.type == SignalType.signal, let from = envelope.from,
               let data = envelope.data {
                registry.record(peerId: from, signal: data)
            }
            if envelope.type == SignalType.peers,
               envelope.peers?.contains(where: { $0.id == self.theirs }) == true,
               supportedWhenListed == nil {
                supportedWhenListed = registry.supports(self.theirs, LINK_CAPABILITY)
            }
        }

        discover()
        XCTAssertEqual(supportedWhenListed, true)
    }

    // MARK: - duplicate identity

    /// Two inbound streams claiming one identity is one peer id with two
    /// sockets. The channel keeps exactly one and must not report a departure
    /// for the id it is still connected to.
    func testASecondInboundStreamClaimingOneIdentityIsRefusedWithoutDeparture() {
        openAndJoin()
        discover()
        texts = []

        let first = accept()
        first.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                            data: .string("first")))
        drain()
        let second = accept()
        second.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                             data: .string("second")))
        drain()

        XCTAssertFalse(first.cancelled, "the established stream was displaced by a duplicate")
        XCTAssertTrue(second.cancelled)
        XCTAssertFalse(envelopes.contains { $0.type == "left" })
        XCTAssertEqual(envelopes.filter { $0.type == SignalType.signal }.compactMap(\.data),
                       [.string("first")])
    }

    /// Two DIFFERENT identities on one stream is a peer changing who it claims
    /// to be mid-session; a duplicate identity across two streams is not the
    /// same thing and must not be resolved the same way.
    func testOneStreamMayNotServeTwoIdentities() {
        openAndJoin()
        discover()
        let other = String(repeating: "3", count: 32)
        transport.delegate?.localPeerTransport(
            didDiscover: [peer, .init(identity: other, name: "Mac", capabilities: peerCaps)])
        drain()
        texts = []

        let connection = accept()
        connection.deliver(.init(type: SignalType.signal, from: theirs, to: mine,
                                 data: .string("first")))
        drain()
        connection.deliver(.init(type: SignalType.signal, from: other, to: mine,
                                 data: .string("second")))
        drain()

        XCTAssertTrue(connection.cancelled)
        XCTAssertEqual(envelopes.filter { $0.type == SignalType.signal }.compactMap(\.data),
                       [.string("first")])
        XCTAssertEqual(envelopes.filter { $0.type == "left" }.count, 1)
    }

    // MARK: - the double honours the close contract it stands for

    func testFakeCloseHandlerInstalledBeforeTheCloseFiresOnce() {
        let connection = LocalChannelFakeConnection()
        var calls = 0
        connection.onClosed = { calls += 1 }

        connection.end()
        XCTAssertEqual(calls, 1)
        XCTAssertNil(connection.onClosed, "a delivered close keeps no handler to fire again")

        connection.end()
        connection.cancel()
        XCTAssertEqual(calls, 1, "one stream ends once, however many times it is told")
    }

    func testFakeCloseHandlerInstalledAfterTheCloseIsOwedItImmediatelyAndOnce() {
        let connection = LocalChannelFakeConnection()
        connection.end()

        var first = 0
        connection.onClosed = { first += 1 }
        XCTAssertEqual(first, 1, "an end observed before a handler existed was never delivered")
        XCTAssertNil(connection.onClosed)

        var second = 0
        connection.onClosed = { second += 1 }
        connection.end()
        connection.cancel()
        XCTAssertEqual(first, 1)
        XCTAssertEqual(second, 0, "the owed close belongs to the first handler only")
    }

    func testFakeClearingTheHandlerDoesNotConsumeAnOwedClose() {
        let connection = LocalChannelFakeConnection()
        var disowned = 0
        connection.onClosed = { disowned += 1 }
        connection.onClosed = nil
        connection.cancel()
        connection.onClosed = nil

        var calls = 0
        connection.onClosed = { calls += 1 }
        XCTAssertEqual(disowned, 0)
        XCTAssertEqual(calls, 1)
    }

    func testFakeReplacingTheCloseHandlerDoesNotDoubleFire() {
        let connection = LocalChannelFakeConnection()
        var replaced = 0
        var current = 0
        connection.onClosed = { replaced += 1 }
        connection.onClosed = { current += 1 }

        connection.end()
        XCTAssertEqual(replaced, 0)
        XCTAssertEqual(current, 1)

        var afterwards = 0
        connection.onClosed = { afterwards += 1 }
        XCTAssertEqual(current, 1)
        XCTAssertEqual(afterwards, 0, "a close already delivered is not delivered to a replacement")
    }

    func testFakeCancelTwiceDoesNotDoubleFire() {
        let connection = LocalChannelFakeConnection()
        var calls = 0
        connection.onClosed = { calls += 1 }

        connection.cancel()
        connection.cancel()
        XCTAssertTrue(connection.cancelled)
        XCTAssertEqual(calls, 1)

        let unheard = LocalChannelFakeConnection()
        unheard.cancel()
        unheard.cancel()
        var owed = 0
        unheard.onClosed = { owed += 1 }
        XCTAssertEqual(owed, 1, "two cancels with nobody listening still owe exactly one close")
    }

    /// What the owed close is FOR. A stream can end between the transport
    /// accepting it and the channel attaching to it; the channel installs its
    /// handler afterwards and must still hear the end, or the record sits in
    /// `pending` holding a dead stream until the grace timer happens to fire.
    /// No timer is run here, so the only thing that can release it is the owed
    /// close.
    func testAStreamThatEndedBeforeTheChannelAttachedIsReleasedWithoutTheGraceTimer() {
        openAndJoin()
        discover()
        texts = []
        let connection = LocalChannelFakeConnection()
        connection.end()

        transport.delegate?.localPeerTransport(didAccept: connection)
        // Twice: the owed close is heard inside the accept block, and the drop
        // it schedules is queued behind the first barrier.
        drain()
        drain()

        XCTAssertTrue(connection.cancelled, "the channel never learned the stream had ended")
        XCTAssertNil(connection.onBytes)
        XCTAssertNil(connection.onClosed)
        XCTAssertFalse(envelopes.contains { $0.type == "left" },
                       "a stream that never named a peer has nobody to announce as departed")
    }
}
