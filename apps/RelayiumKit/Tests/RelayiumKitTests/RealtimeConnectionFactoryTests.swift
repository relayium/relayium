import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

final class RealtimeConnectionFactoryTests: XCTestCase {
    /// The hub broadcasts the WHOLE room roster to every member, including the
    /// recipient (signal/hub.go's broadcastRoster). So the moment a sender joins
    /// the code it just minted, it is handed a roster containing itself — and
    /// taking the first entry means dialling its own peer id, which fails in
    /// WebRTC with a bare NSError and no useful copy.
    func testIgnoresItselfInTheRoster() async throws {
        let ch = FakeWebSocketChannel()
        let client = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()

        let waiting = Task { try await RealtimeConnectionFactory.firstPeer(on: client, timeout: 5) }
        await Task.yield()

        // The welcome names us. Then a roster with nobody but us in it.
        ch.fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"}]}"#)
        await Task.yield()
        XCTAssertFalse(waiting.isCancelled)

        // Only once someone else actually joins may it resolve — to them.
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"},{"id":"other-2","name":"Phone"}]}"#)
        let peer = try await waiting.value
        XCTAssertEqual(peer, "other-2", "resolved to the wrong member of the room")
    }

    /// A roster that arrives before the welcome cannot be trusted to exclude us,
    /// because we do not yet know which id is ours.
    func testDoesNotGuessBeforeItKnowsItsOwnID() async throws {
        let ch = FakeWebSocketChannel()
        let client = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()

        let waiting = Task { try await RealtimeConnectionFactory.firstPeer(on: client, timeout: 5) }
        await Task.yield()

        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"}]}"#)
        await Task.yield()
        XCTAssertFalse(waiting.isCancelled)

        ch.fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"},{"id":"other-2","name":"Phone"}]}"#)
        let peer = try await waiting.value
        XCTAssertEqual(peer, "other-2")
    }

    /// The timeout has to actually surface. It used to be a `Task.sleep` child
    /// racing a `withCheckedThrowingContinuation` child inside a
    /// `withThrowingTaskGroup`: the sleeper threw, the group cancelled the
    /// other child and then awaited it anyway, and cancellation cannot resume a
    /// raw continuation — so `firstPeer` hung until `signaling.onClose`
    /// happened to fire, which for a peer that simply never joins is never.
    ///
    /// Driven through an expectation rather than a bare `await`: against the
    /// old code this call does not return at all, and a test that awaited it
    /// directly would hang the whole suite instead of failing it.
    func testTheTimeoutSurfacesAsNoPeerAppeared() async {
        let ch = FakeWebSocketChannel()
        let client = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        // A welcome, but nobody else ever joins and the socket never closes —
        // the one path the timeout exists for.
        ch.fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"}]}"#)

        let returned = expectation(description: "firstPeer returned")
        let caught = ErrorBox()
        Task {
            do { _ = try await RealtimeConnectionFactory.firstPeer(on: client, timeout: 0.2) }
            catch { caught.value = error }
            returned.fulfill()
        }
        await fulfillment(of: [returned], timeout: 5)
        XCTAssertEqual(caught.value as? RealtimeConnectionFactory.FactoryError, .noPeerAppeared)
    }

    /// The buffer stays installed for the whole firstPeer wait — up to two
    /// minutes — and anyone holding the pairing code can push signals into it
    /// for all of that. Unbounded, that is memory spent from the far end of a
    /// WebSocket. The cap has to hold, and it has to keep the EARLIEST signals:
    /// the offer arrives first and a flood behind it must not evict it.
    func testPendingSignalsCapsAndKeepsTheEarliestSignals() {
        let pending = PendingSignals()
        for i in 0..<(PendingSignals.capacity + 500) {
            pending.append(("peer", .object(["n": .number(Double(i))])))
        }
        let drained = pending.drain()
        XCTAssertEqual(drained.count, PendingSignals.capacity)
        XCTAssertEqual(drained.first?.1, .object(["n": .number(0)]), "the offer must survive the flood")
        XCTAssertEqual(drained.last?.1, .object(["n": .number(Double(PendingSignals.capacity - 1))]))
        XCTAssertTrue(pending.drain().isEmpty, "draining empties the buffer")
    }

    // MARK: make()

    private static let legacy = ICEServerConfig(urls: ["stun:legacy.example:3478"])
    private static let near = RelayEntry(id: "near",
                                         iceServers: [ICEServerConfig(urls: ["turn:near.example:3478"])])

    /// Drives `make` to completion against a fake socket, a fake measurement
    /// and a fake connection builder. Returns once `make` has returned.
    ///
    /// `drive` runs after `make` has installed both of its callbacks — polled
    /// for rather than slept on — so a test can fire socket traffic knowing it
    /// will be seen.
    private func runMake(pool: [RelayEntry],
                         choiceDeadline: TimeInterval,
                         measure: @escaping RelayNegotiator.Measure,
                         drive: @escaping (FakeWebSocketChannel) async -> Void)
        async throws -> (RecordingConnection, BuildRecord) {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let record = BuildRecord()

        let task = Task { [sig] in
            try await RealtimeConnectionFactory.make(
                role: .initiator,
                config: ICEConfig(iceServers: [Self.legacy], relays: pool),
                signaling: sig,
                peerTimeout: 5,
                choiceDeadline: choiceDeadline,
                measure: measure,
                build: { signaling, peerId, _, servers, relayOnly in
                    record.note(servers: servers, relayOnly: relayOnly, peerId: peerId)
                    return RecordingConnection(signaling: signaling)
                })
        }
        // `make` sets onSignal first and onPeers second (inside firstPeer), so
        // onPeers being installed means both are.
        var waited = 0
        while sig.onPeers == nil && waited < 500 {
            try await Task.sleep(nanoseconds: 5_000_000)
            waited += 1
        }
        XCTAssertNotNil(sig.onPeers, "make never got as far as waiting for a peer")

        await drive(ch)
        let conn = try await task.value
        return (conn as! RecordingConnection, record)
    }

    private func joinPeer(_ ch: FakeWebSocketChannel) {
        ch.fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        ch.fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"},{"id":"other-2","name":"Phone"}]}"#)
    }

    /// The ordering the whole feature rests on, and which nothing tested
    /// before: the connection must be built AFTER the relay choice is settled,
    /// with the chosen relay's servers. Moving the construction above
    /// `waitForChoice` — the exact silent regression the plan opens by warning
    /// about — used to leave the entire suite green, because the fallback is
    /// indistinguishable from success from the outside.
    ///
    /// Hoist it and this goes red twice over: the builder receives the legacy
    /// advertised server instead of the chosen relay, and `relayOnly` is false.
    func testTheConnectionIsBuiltAfterTheChoiceIsSettled() async throws {
        let (_, record) = try await runMake(
            pool: [Self.near],
            choiceDeadline: 2.0,
            measure: { _, publish in publish("near", 10) },
            drive: { ch in
                self.joinPeer(ch)
                // The peer's own map, so a choice is actually reachable.
                ch.fireText(#"{"type":"signal","from":"other-2","data":{"relayRtt":{"near":20}}}"#)
            })

        XCTAssertEqual(record.servers?.map(\.urls), [["turn:near.example:3478"]],
                       "the chosen relay's servers, not the advertised fallback")
        XCTAssertEqual(record.relayOnly, true, "a chosen relay means relay-only transport")
        XCTAssertEqual(record.peerId, "other-2")
    }

    /// The other half of the same ordering: with no pool there is nothing to
    /// choose, so the advertised servers go through and the transport policy
    /// must NOT be forced to relay — a LAN room has no relay to gather.
    func testFallsBackToTheAdvertisedServersWithNoPool() async throws {
        let (_, record) = try await runMake(
            pool: [],
            choiceDeadline: 2.0,
            measure: { _, _ in XCTFail("an empty pool must not be measured") },
            drive: { ch in self.joinPeer(ch) })

        XCTAssertEqual(record.servers?.map(\.urls), [["stun:legacy.example:3478"]])
        XCTAssertEqual(record.relayOnly, false)
    }

    /// The buffer-and-replay path, end to end. A signal that lands while the
    /// relay choice is still pending must reach the connection's own handler
    /// once that handler exists — in arrival order, none dropped.
    ///
    /// Both signals below are fired after the peer has joined but before the
    /// measurement publishes, so `signaling.onSignal` is still the
    /// negotiator's buffering handler when they arrive. The offer is the one
    /// that matters: before the buffer existed it was discarded outright and
    /// the responder waited for an offer that had already been sent and thrown
    /// away.
    func testASignalArrivingDuringTheWaitReachesTheConnection() async throws {
        let (conn, _) = try await runMake(
            pool: [Self.near],
            choiceDeadline: 5.0,
            measure: { _, publish in
                // Hold the choice open long enough for `drive` to fire into
                // the window this test is about.
                try? await Task.sleep(nanoseconds: 300_000_000)
                publish("near", 10)
            },
            drive: { ch in
                self.joinPeer(ch)
                ch.fireText(#"{"type":"signal","from":"other-2","data":{"relayRtt":{"near":20}}}"#)
                ch.fireText(#"{"type":"signal","from":"other-2","data":{"sdp":{"type":"offer","sdp":"v=0"}}}"#)
            })

        XCTAssertEqual(conn.received.count, 2, "both buffered signals must be replayed, none dropped")
        XCTAssertEqual(conn.received.first?.from, "other-2")
        // Order preserved: the relay map arrived first, the offer second.
        guard case let .object(last)? = conn.received.last?.data else {
            return XCTFail("got \(conn.received)")
        }
        XCTAssertNotNil(last["sdp"], "the offer must be the second thing replayed, not the first")
    }
}

/// What `make` handed the connection builder, and when.
private final class BuildRecord: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var servers: [ICEServerConfig]?
    private(set) var relayOnly: Bool?
    private(set) var peerId: String?
    func note(servers: [ICEServerConfig], relayOnly: Bool, peerId: String) {
        lock.lock()
        self.servers = servers
        self.relayOnly = relayOnly
        self.peerId = peerId
        lock.unlock()
    }
}

/// Stands in for `RealtimeConnection`, and copies the one behaviour of it that
/// `make` depends on: its initialiser takes over `signaling.onSignal`. Without
/// that the replay would have nowhere to land and the test would prove nothing.
private final class RecordingConnection: RealtimePeerConnection, @unchecked Sendable {
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
    var onControl: ((RealtimeControl) -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?

    func start() {}
    func send(sources: [PlaintextSource], metas: [FileMeta]) {}
    func complete() {}
    func close() {}
}

/// Carries the thrown error out of a detached `Task` without an unstructured
/// capture the compiler has to take on trust.
private final class ErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Error?
    var value: Error? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
