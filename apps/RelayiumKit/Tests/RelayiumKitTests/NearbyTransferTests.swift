import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - stubs

/// Records whether anything asked the server to mint a pairing code. The whole
/// point of the nearby path is that nothing does.
private final class RecordingPair: PairCodeClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _mintCount = 0
    var mintCount: Int { lock.lock(); defer { lock.unlock() }; return _mintCount }

    func mint(token: String) async throws -> MintedCode {
        lock.lock(); _mintCount += 1; lock.unlock()
        return MintedCode(code: "483920", expiresAt: 1800000000)
    }
}

private final class RecordingICE: ICEConfigClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _codes: [String] = []
    var codes: [String] { lock.lock(); defer { lock.unlock() }; return _codes }
    var result = ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])])
    var error: Error?

    func fetch(code: String) async throws -> ICEConfig {
        lock.lock(); _codes.append(code); lock.unlock()
        if let error { throw error }
        return result
    }
}

private final class StubPeer: RealtimePeerConnection, @unchecked Sendable {
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

    private(set) var started = false
    private(set) var closeCount = 0

    func start() { started = true }
    func send(sources: [PlaintextSource], metas: [FileMeta]) {}
    func accept() {}
    func reject() {}
    func complete() {}
    func confirmTextSAS() {}
    func acceptText() {}
    func rejectText() {}
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) { completion(nil) }
    var textBufferedAmount: UInt64 { 0 }
    func close() { closeCount += 1 }
}

/// What `connectNearby` handed the connection builder.
private final class NearbyBuildRecord: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var peerId: String?
    private(set) var servers: [ICEServerConfig]?
    private(set) var relayOnly: Bool?
    private(set) var generation: RealtimeGeneration?
    private(set) var capabilities: [String] = []
    func note(peerId: String, servers: [ICEServerConfig], relayOnly: Bool,
              generation: RealtimeGeneration, capabilities: [String]) {
        lock.lock()
        self.peerId = peerId
        self.servers = servers
        self.relayOnly = relayOnly
        self.generation = generation
        self.capabilities = capabilities
        lock.unlock()
    }
}

/// Copies the one behaviour of `RealtimeConnection` the replay depends on: its
/// initialiser takes over `signaling.onSignal`.
private final class ReplayRecorder: RealtimePeerConnection, @unchecked Sendable {
    struct Signal { let from: String; let data: JSONValue }
    private let lock = NSLock()
    private var _received: [Signal] = []
    var received: [Signal] { lock.lock(); defer { lock.unlock() }; return _received }

    init(signaling: SignalingClient) {
        signaling.onSignal = { [weak self] from, data in
            guard let self else { return }
            lock.lock(); _received.append(Signal(from: from, data: data)); lock.unlock()
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

    func start() {}
    func send(sources: [PlaintextSource], metas: [FileMeta]) {}
    func accept() {}
    func reject() {}
    func complete() {}
    func confirmTextSAS() {}
    func acceptText() {}
    func rejectText() {}
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) { completion(nil) }
    var textBufferedAmount: UInt64 { 0 }
    func close() {}
}

// MARK: - the factory's nearby path

final class NearbyConnectionFactoryTests: XCTestCase {
    private func openSocket() -> (FakeWebSocketChannel, SignalingClient) {
        let ch = FakeWebSocketChannel()
        let client = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        return (ch, client)
    }

    /// The nearby room holds everyone behind one public address. The connection
    /// must go to the id the user picked and to nothing else — in particular it
    /// must not consult the roster at all, because "the first peer that is not
    /// me" is precisely the wrong answer here.
    func testDialsTheChosenPeerAndNeverConsultsTheRoster() async throws {
        let (ch, sig) = openSocket()
        let record = NearbyBuildRecord()

        let connection = try await RealtimeConnectionFactory.connectNearby(
            signaling: sig, peerId: "chosen-7", role: .initiator,
            config: ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])]),
            mode: .file, capabilityTimeout: 1,
            build: { signaling, peerId, _, servers, relayOnly, generation, caps in
                record.note(peerId: peerId, servers: servers, relayOnly: relayOnly,
                            generation: generation, capabilities: caps)
                return ReplayRecorder(signaling: signaling)
            })

        XCTAssertEqual(record.peerId, "chosen-7")
        XCTAssertNil(sig.onPeers, "the nearby path must not install a first-peer wait")
        XCTAssertFalse(ch.closed, "the discovery socket is not this call's to close")
        XCTAssertNotNil(connection)
    }

    /// The code-less room has no code, therefore no TURN credentials and no
    /// relay to bill. Even if a server answered with them, they must not reach
    /// WebRTC.
    func testNeverCarriesTURNOrItsCredentials() async throws {
        let (_, sig) = openSocket()
        let record = NearbyBuildRecord()
        let advertised = [
            ICEServerConfig(urls: ["stun:stun.example:3478"]),
            ICEServerConfig(urls: ["turn:relay.example:3478", "stun:relay.example:3478"],
                            username: "user", credential: "secret"),
            ICEServerConfig(urls: ["turns:relay.example:5349"], username: "user", credential: "secret"),
        ]

        _ = try await RealtimeConnectionFactory.connectNearby(
            signaling: sig, peerId: "chosen-7", role: .initiator,
            config: ICEConfig(iceServers: advertised, relays: [
                RelayEntry(id: "near", iceServers: [ICEServerConfig(urls: ["turn:near.example:3478"])])
            ]),
            mode: .file, capabilityTimeout: 1,
            build: { signaling, peerId, _, servers, relayOnly, generation, caps in
                record.note(peerId: peerId, servers: servers, relayOnly: relayOnly,
                            generation: generation, capabilities: caps)
                return ReplayRecorder(signaling: signaling)
            })

        let urls = (record.servers ?? []).flatMap(\.urls)
        XCTAssertEqual(urls, ["stun:stun.example:3478", "stun:relay.example:3478"])
        XCTAssertTrue((record.servers ?? []).allSatisfy { $0.username == nil && $0.credential == nil },
                      "a relay credential must not survive into a nearby connection")
        XCTAssertEqual(record.relayOnly, false,
                       "relay-only with no relay would leave ICE nothing to gather on a LAN")
    }

    /// Directly: the filter is the guarantee, so it is tested as one.
    func testNearbyICEServersKeepsOnlySTUN() {
        let filtered = RealtimeConnectionFactory.nearbyICEServers([
            ICEServerConfig(urls: ["TURN:loud.example:3478"], username: "u", credential: "c"),
            ICEServerConfig(urls: ["STUNS:secure.example:5349"]),
            ICEServerConfig(urls: ["https://not-ice.example"]),
        ])
        XCTAssertEqual(filtered.map(\.urls), [["STUNS:secure.example:5349"]])
    }

    func testRefusesAnEmptyPeerID() async {
        let (_, sig) = openSocket()
        do {
            _ = try await RealtimeConnectionFactory.connectNearby(
                signaling: sig, peerId: "", role: .initiator,
                config: ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])]),
                mode: .file, capabilityTimeout: 1,
                build: { signaling, _, _, _, _, _, _ in ReplayRecorder(signaling: signaling) })
            XCTFail("an empty peer id must not reach WebRTC")
        } catch {
            XCTAssertEqual(error as? RealtimeConnectionFactory.FactoryError, .noPeerAppeared)
        }
    }

    /// The chosen device can answer before the connection object exists — on a
    /// LAN it usually does. A dropped offer stalls the session with no error at
    /// all, which is why this is buffered and replayed rather than raced.
    func testReplaysSignalsThatArrivedBeforeTheConnectionExisted() async throws {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()

        let connection = try await RealtimeConnectionFactory.connectNearby(
            signaling: sig, peerId: "chosen-7", role: .responder,
            config: ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])]),
            mode: .file, capabilityTimeout: 1,
            build: { signaling, _, _, _, _, _, _ in
                // Fired while the buffering handler is still the installed one:
                // the builder runs before the replay.
                ch.fireText(#"{"type":"signal","from":"chosen-7","data":{"sdp":{"type":"offer","sdp":"v=0"}}}"#)
                return ReplayRecorder(signaling: signaling)
            }) as! ReplayRecorder

        XCTAssertEqual(connection.received.count, 1, "the offer must reach the connection, not the void")
        XCTAssertEqual(connection.received.first?.from, "chosen-7")
    }

    /// Text is never offered speculatively: an older peer reads a text offer as
    /// a file offer. On failure the discovery socket must survive — the user is
    /// expected to pick a different device on the very same roster.
    func testTextRefusesAPeerWithoutTheExactCapabilityAndKeepsTheSocketOpen() async {
        let (ch, sig) = openSocket()
        do {
            _ = try await RealtimeConnectionFactory.connectNearby(
                signaling: sig, peerId: "old-peer", role: .initiator,
                config: ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])]),
                mode: .text, capabilityTimeout: 0.05,
                build: { _, _, _, _, _, _, _ in
                    XCTFail("a text connection must not be built for an unsupported peer")
                    return StubPeer()
                })
            XCTFail("expected unsupportedPeer")
        } catch {
            XCTAssertEqual(error as? RealtimeConnectionFactory.FactoryError, .unsupportedPeer)
        }
        XCTAssertFalse(ch.closed, "closing here would kill the roster the user is still picking from")
    }

    /// The capability hello goes to the chosen peer only — the room may hold
    /// devices with no business hearing from us.
    func testTextAnnouncesItsCapabilityToTheChosenPeerOnly() async throws {
        let (ch, sig) = openSocket()
        let record = NearbyBuildRecord()

        let task = Task {
            try await RealtimeConnectionFactory.connectNearby(
                signaling: sig, peerId: "chosen-7", role: .initiator,
                config: ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])]),
                mode: .text, capabilityTimeout: 2,
                build: { signaling, peerId, _, servers, relayOnly, generation, caps in
                    record.note(peerId: peerId, servers: servers, relayOnly: relayOnly,
                                generation: generation, capabilities: caps)
                    return ReplayRecorder(signaling: signaling)
                })
        }
        while ch.sent.isEmpty { await Task.yield() }
        ch.fireText(#"{"type":"signal","from":"chosen-7","data":{"caps":["text/1"]}}"#)
        _ = try await task.value

        XCTAssertEqual(record.generation, .text)
        XCTAssertEqual(record.capabilities, ["text/1"])
        let envelopes = ch.sent.compactMap {
            try? JSONDecoder().decode(Envelope.self, from: Data($0.utf8))
        }
        let announcements = envelopes.filter { $0.data.map(peerCaps(from:)) == ["text/1"] }
        XCTAssertFalse(announcements.isEmpty)
        XCTAssertTrue(announcements.allSatisfy { $0.to == "chosen-7" },
                      "a capability hello must be addressed, never broadcast to the room")
    }
}

// MARK: - the session models' nearby path

@MainActor
final class NearbySessionModelTests: XCTestCase {
    private var pair = RecordingPair()
    private var ice = RecordingICE()
    private var peer = StubPeer()

    private func makeFileModel(answerTimeout: TimeInterval = 30,
                               sleepImmediately: Bool = false,
                               nearby: (@MainActor (String, Role, ICEConfig) async throws -> RealtimePeerConnection)? = nil)
        -> RealtimeSessionModel {
        pair = RecordingPair(); ice = RecordingICE(); peer = StubPeer()
        let p = peer
        return RealtimeSessionModel(
            pairClient: pair,
            iceClient: ice,
            requiresVerification: { false },
            nearbyAnswerTimeout: answerTimeout,
            sleep: { nanoseconds in
                if sleepImmediately { return }
                try? await Task.sleep(nanoseconds: nanoseconds)
            },
            makeNearbyConnection: nearby ?? { _, _, _ in p },
            makeConnection: { _, _, _ in p })
    }

    private func settle() async { await Task.yield(); await Task.yield() }

    /// The whole shape of the feature in one test: a peer id instead of a code,
    /// an empty-code ICE fetch, and nothing minted — which is what makes it
    /// usable signed out.
    func testConnectsToTheChosenPeerWithoutACodeOrAnAccount() async {
        let model = makeFileModel()
        await model.connectNearby(peerId: "chosen-7")

        XCTAssertEqual(ice.codes, [""], "a nearby connection must ask /api/ice without a code")
        XCTAssertEqual(pair.mintCount, 0, "nothing on the nearby path may mint a pairing code")
        XCTAssertTrue(peer.started)
        XCTAssertEqual(model.state, .connecting)
        XCTAssertTrue(model.isBusy)
    }

    /// A model built without a nearby connector — the code-only construction —
    /// must fail loudly rather than silently doing nothing.
    func testWithoutADiscoverySocketItExplainsItself() async {
        let model = RealtimeSessionModel(
            pairClient: pair, iceClient: ice,
            makeConnection: { _, _, _ in StubPeer() })
        await model.connectNearby(peerId: "chosen-7")

        guard case let .failed(message) = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: NearbyError.notScanning))
        XCTAssertTrue(message.lowercased().contains("scan again"))
    }

    /// Operation identity: cancelling mid-connect must close the connection the
    /// in-flight attempt produced and leave the screen the user moved to alone.
    func testAConnectionThatArrivesAfterCancelIsClosedNotShown() async {
        // Two gates rather than a yield count: the cancel has to land while the
        // factory is genuinely in flight, and "how many yields is the ICE fetch"
        // is not something a test should be guessing at.
        let entered = Gate()
        let release = Gate()
        let late = StubPeer()
        let model = makeFileModel(nearby: { _, _, _ in
            await entered.open()
            await release.wait()
            return late
        })

        let connecting = Task { await model.connectNearby(peerId: "chosen-7") }
        await entered.wait()
        model.cancel()
        XCTAssertEqual(model.state, .idle)
        await release.open()
        await connecting.value
        await settle()

        XCTAssertEqual(model.state, .idle, "a stale attempt must not repaint the pane")
        XCTAssertEqual(late.closeCount, 1, "the connection nobody is watching has to be closed")
    }

    /// Nothing else bounds a nearby connect: the peer id is already known, so
    /// there is no peer-arrival timeout to fall back on, and a device that is
    /// not listening for incoming offers simply never answers.
    func testASilentDeviceEventuallyGivesUp() async {
        let model = makeFileModel(answerTimeout: 0, sleepImmediately: true)
        await model.connectNearby(peerId: "chosen-7")

        for _ in 0..<50 {
            if case .failed = model.state { break }
            await settle()
        }
        guard case let .failed(message) = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: NearbyError.noAnswer))
        XCTAssertFalse(model.isBusy)
        XCTAssertEqual(peer.closeCount, 1, "giving up has to take the connection with it")
    }

    /// The same timer must not fire on a session that got going.
    func testTheAnswerTimeoutIsDroppedOnceTheConnectionOpens() async {
        let model = makeFileModel(answerTimeout: 0, sleepImmediately: true)
        await model.connectNearby(peerId: "chosen-7")
        peer.onSAS?("123456")
        peer.onOpen?()
        for _ in 0..<10 { await settle() }

        guard case .transferring = model.state else { return XCTFail("got \(model.state)") }
    }

    /// And it must be cancelled outright, not merely defused by a state check
    /// when it wakes up half a minute later. Asserted through the injected
    /// sleep, which reports the cancellation itself: a state guard would keep
    /// this test green even with the task left running, which is exactly the
    /// difference being pinned.
    func testTheAnswerTimeoutIsCancelledNotJustIgnored() async {
        let observer = CancellationObserver()
        pair = RecordingPair(); ice = RecordingICE(); peer = StubPeer()
        let p = peer
        let model = RealtimeSessionModel(
            pairClient: pair,
            iceClient: ice,
            requiresVerification: { false },
            nearbyAnswerTimeout: 600,
            sleep: { _ in
                // Returns only when the task is cancelled, so "did the model
                // cancel it" is observable rather than inferred.
                while !Task.isCancelled { await Task.yield() }
                await observer.markCancelled()
            },
            makeNearbyConnection: { _, _, _ in p },
            makeConnection: { _, _, _ in p })

        await model.connectNearby(peerId: "chosen-7")
        peer.onSAS?("123456")
        peer.onOpen?()

        for _ in 0..<200 where await !observer.cancelled { await settle() }
        let cancelled = await observer.cancelled
        XCTAssertTrue(cancelled, "the give-up timer must be cancelled the moment the device answers")
        guard case .transferring = model.state else { return XCTFail("got \(model.state)") }
    }

    /// Every other timer test injects a fake sleep, which is exactly how the
    /// REAL one went untested — and the real one aborted the process.
    ///
    /// An `async` closure literal in a default-argument position is miscompiled
    /// in unoptimised builds: when the task that ran it completes, the task
    /// allocator's LIFO discipline is violated and the runtime calls `abort()`
    /// with "freed pointer was not the last allocation". Both the answer timeout
    /// firing and the answer timeout being cancelled reach that completion, so a
    /// Debug build crashed on every nearby transfer. Optimised builds were fine,
    /// which is why the release gates never saw it.
    ///
    /// This test builds the models the way the app does — no injected sleep at
    /// all — and lets a short real timer run to completion. See `realSleep`.
    func testTheRealTimerCompletesWithoutTrippingTheTaskAllocator() async {
        let peer = StubPeer()
        let model = RealtimeSessionModel(
            pairClient: RecordingPair(),
            iceClient: RecordingICE(),
            nearbyAnswerTimeout: 0.001,
            makeNearbyConnection: { _, _, _ in peer },
            makeConnection: { _, _, _ in peer })
        await model.connectNearby(peerId: "chosen-7")
        for _ in 0..<500 {
            if case .failed = model.state { break }
            await settle()
        }
        guard case .failed = model.state else { return XCTFail("got \(model.state)") }

        // And the cancellation half of the same path: the device answers, the
        // timer is cancelled, and the cancelled task still has to complete
        // cleanly.
        let answered = StubPeer()
        let live = RealtimeSessionModel(
            pairClient: RecordingPair(),
            iceClient: RecordingICE(),
            nearbyAnswerTimeout: 600,
            makeNearbyConnection: { _, _, _ in answered },
            makeConnection: { _, _, _ in answered })
        await live.connectNearby(peerId: "chosen-7")
        answered.onSAS?("123456")
        answered.onOpen?()
        for _ in 0..<200 { await settle() }
        guard case .transferring = live.state else { return XCTFail("got \(live.state)") }
    }

    /// The text model's idle timer has the same shape and the same exposure:
    /// `touch()` arms it on every session that becomes interactive.
    func testTheRealTextIdleTimerCompletesWithoutTrippingTheTaskAllocator() async {
        let peer = StubPeer()
        let model = RealtimeTextSessionModel(
            pairClient: RecordingPair(),
            iceClient: RecordingICE(),
            requiresVerification: { false },
            idleSeconds: 0.001,
            nearbyAnswerTimeout: 600,
            makeNearbyConnection: { _, _, _ in peer },
            makeConnection: { _, _, _ in peer })
        await model.connectNearby(peerId: "chosen-7")
        peer.onSAS?("123456")
        peer.onOpen?()
        for _ in 0..<500 {
            if model.state == .ended { break }
            await settle()
        }
        XCTAssertEqual(model.state, .ended, "the idle timer has to fire, and survive doing so")
    }

    /// Regression guard for the code flow: it still mints, still fetches ICE
    /// for the code it is joining, and is untouched by any of the above.
    func testThePairingCodeFlowIsUnchanged() async {
        let model = makeFileModel()
        await model.mintCode(token: "tok")
        guard case let .showingCode(code, _) = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(code, "483920")
        await model.join(code: code, role: .initiator)

        XCTAssertEqual(pair.mintCount, 1)
        XCTAssertEqual(ice.codes, ["483920"], "the code flow must keep asking /api/ice for its code")
    }

    // MARK: text

    private func makeTextModel(answerTimeout: TimeInterval = 30,
                               sleepImmediately: Bool = false) -> RealtimeTextSessionModel {
        pair = RecordingPair(); ice = RecordingICE(); peer = StubPeer()
        let p = peer
        return RealtimeTextSessionModel(
            pairClient: pair,
            iceClient: ice,
            requiresVerification: { false },
            idleSleep: { nanoseconds in
                if sleepImmediately { return }
                try? await Task.sleep(nanoseconds: nanoseconds)
            },
            nearbyAnswerTimeout: answerTimeout,
            makeNearbyConnection: { _, _, _ in p },
            makeConnection: { _, _, _ in p })
    }

    func testTextConnectsToTheChosenPeerWithoutACodeOrAnAccount() async {
        let model = makeTextModel()
        await model.connectNearby(peerId: "chosen-7")

        XCTAssertEqual(ice.codes, [""])
        XCTAssertEqual(pair.mintCount, 0)
        XCTAssertTrue(peer.started)
        XCTAssertEqual(model.state, .connecting)
    }

    func testTextGivesUpOnASilentDevice() async {
        let model = makeTextModel(answerTimeout: 0, sleepImmediately: true)
        await model.connectNearby(peerId: "chosen-7")

        for _ in 0..<50 {
            if case .failed = model.state { break }
            await settle()
        }
        guard case let .failed(message) = model.state else { return XCTFail("got \(model.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: NearbyError.noAnswer))
    }

    /// A nearby text session has no code, so it must not poison the
    /// code-rejection list — a later join of a real code would be refused
    /// outright.
    func testANearbyRejectionDoesNotBlockAnyPairingCode() async {
        let model = makeTextModel()
        await model.connectNearby(peerId: "chosen-7")
        peer.onSAS?("123456")
        peer.onOpen?()
        await settle()
        model.reject()
        await settle()

        model.updateJoinCode("483920")
        XCTAssertTrue(model.canJoin, "no code was involved, so no code may be blacklisted")
    }
}

/// Records that the injected sleep saw its own task cancelled.
private actor CancellationObserver {
    private(set) var cancelled = false
    func markCancelled() { cancelled = true }
}

/// One-shot rendezvous so a test can hold an async factory open across a
/// cancellation and release it afterwards.
private actor Gate {
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
