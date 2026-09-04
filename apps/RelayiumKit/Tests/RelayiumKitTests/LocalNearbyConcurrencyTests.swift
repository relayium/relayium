import XCTest
@testable import RelayiumKit
@testable import RelayiumLocalPeerKit

/// Everything a `LocalPeerConnection` implementation owes when its bytes arrive
/// on a queue the owner does not control. Locked internally so a race this test
/// reports is the channel's and not the double's.
private final class ConcurrentFakeConnection: LocalPeerConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var _onBytes: ((Data) -> Void)?
    private var _onClosed: (() -> Void)?
    private var _cancelled = false

    var onBytes: ((Data) -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _onBytes }
        set { lock.lock(); _onBytes = newValue; lock.unlock() }
    }
    var onClosed: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _onClosed }
        set { lock.lock(); _onClosed = newValue; lock.unlock() }
    }
    var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return _cancelled }

    func start() {}
    func send(_ bytes: Data) {}
    func cancel() {
        lock.lock()
        let first = !_cancelled
        _cancelled = true
        let closed = _onClosed
        lock.unlock()
        guard first else { return }
        closed?()
    }
    func deliver(_ envelope: Envelope) {
        let json = String(data: try! JSONEncoder().encode(envelope), encoding: .utf8)!
        onBytes?(LocalPeerFraming.encode(json)!)
    }
}

private final class ConcurrentFakeTransport: LocalPeerTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _delegate: LocalPeerTransportDelegate?
    private var _dialled = 0
    private var _stopped = false

    var delegate: LocalPeerTransportDelegate? {
        lock.lock(); defer { lock.unlock() }; return _delegate
    }
    var dialled: Int { lock.lock(); defer { lock.unlock() }; return _dialled }
    var stopped: Bool { lock.lock(); defer { lock.unlock() }; return _stopped }

    func start(advertising advertisement: LocalPeerAdvertisement,
               delegate: LocalPeerTransportDelegate) {
        lock.lock(); _delegate = delegate; lock.unlock()
    }
    func connect(to peer: LocalPeerAdvertisement) -> LocalPeerConnection {
        lock.lock(); _dialled += 1; lock.unlock()
        return ConcurrentFakeConnection()
    }
    func stop() { lock.lock(); _stopped = true; lock.unlock() }
}

/// The half of this transport that only a sanitizer can check.
///
/// `Network.framework` delivers browse results, accepted streams, state changes
/// and bytes on its own queue while the app sends, pauses and stops from the
/// main actor. The serialized tests in `LocalNearbyChannelTests` pin the RULES;
/// these drive the same rules with real contention so `--sanitize=thread` has
/// something to report. Run with:
/// `swift test --sanitize=thread --filter LocalNearbyConcurrencyTests`.
final class LocalNearbyConcurrencyTests: XCTestCase {
    private let mine = String(repeating: "1", count: 32)

    private func identity(_ index: Int) -> String {
        String(format: "%032x", index + 0x20)
    }

    private func peer(_ index: Int) -> LocalPeerAdvertisement {
        .init(identity: identity(index), name: "peer-\(index)", capabilities: ["text/1", "link/1"])
    }

    /// The channel's own queue, injected so the test can DRAIN it rather than
    /// sleep for a guess. `close()` is asynchronous and lands behind everything
    /// the lanes below have already enqueued.
    private func makeChannel(_ transport: ConcurrentFakeTransport,
                             queue: DispatchQueue) -> LocalPeerSignalingChannel {
        let channel = LocalPeerSignalingChannel(
            advertisement: .init(identity: mine, name: "iPhone",
                                 capabilities: ["text/1", "link/1"]),
            transport: transport,
            queue: queue)
        channel.begin()
        return channel
    }

    /// Discovery, inbound streams, outbound sends and a close all racing. The
    /// assertion that matters is structural: the channel closes exactly once,
    /// stops its transport exactly once, and never dials a peer it has not been
    /// told about — under a schedule no serialized test produces.
    func testConcurrentDiscoverySendAcceptAndCloseKeepOneOwner() {
        let transport = ConcurrentFakeTransport()
        let channelQueue = DispatchQueue(label: "test.local.concurrency.channel")
        let channel = makeChannel(transport, queue: channelQueue)

        let closes = NSLock()
        var closeCount = 0
        var opened = false
        channel.onOpen = { closes.lock(); opened = true; closes.unlock() }
        channel.onClose = { closes.lock(); closeCount += 1; closes.unlock() }
        channel.onText = { _ in }

        transport.delegate?.localPeerTransportDidStart()
        channel.send(#"{"type":"join","name":"iPhone"}"#)

        let group = DispatchGroup()
        let lanes = (0..<6).map { DispatchQueue(label: "test.local.concurrency.\($0)") }
        let roster = (0..<8).map(peer)

        for (index, lane) in lanes.enumerated() {
            lane.async(group: group) {
                for round in 0..<40 {
                    switch (index + round) % 5 {
                    case 0:
                        transport.delegate?.localPeerTransport(
                            didDiscover: Array(roster.prefix((round % roster.count) + 1)))
                    case 1:
                        let stream = ConcurrentFakeConnection()
                        transport.delegate?.localPeerTransport(didAccept: stream)
                        stream.deliver(.init(type: SignalType.signal,
                                             from: self.identity(round % roster.count),
                                             to: self.mine, data: .string("offer-\(round)")))
                    case 2:
                        let envelope = Envelope(type: SignalType.signal,
                                                to: self.identity(round % roster.count),
                                                data: .string("send-\(round)"))
                        channel.send(String(data: try! JSONEncoder().encode(envelope),
                                            encoding: .utf8)!)
                    case 3:
                        _ = channel.isOpen
                    default:
                        transport.delegate?.localPeerTransportDidStart()
                    }
                }
            }
        }

        // The close races everything above rather than following it.
        lanes[0].async(group: group) { channel.close() }
        group.wait()
        // Everything the lanes enqueued, then the close behind it.
        channelQueue.sync {}

        closes.lock()
        let (sawOpen, finalCloses) = (opened, closeCount)
        closes.unlock()
        XCTAssertTrue(sawOpen)
        XCTAssertEqual(finalCloses, 1, "the channel announced more than one close")
        XCTAssertTrue(transport.stopped)
        XCTAssertFalse(channel.isOpen)
        XCTAssertLessThanOrEqual(transport.dialled, roster.count,
                                 "a peer was dialled more than once per identity")
    }

    /// A transport failure racing an explicit close. Both funnel to the same
    /// one-shot, so the room is torn down once no matter which arrives first.
    func testFailureRacingCloseAnnouncesExactlyOneTeardown() {
        for _ in 0..<25 {
            let transport = ConcurrentFakeTransport()
            let channelQueue = DispatchQueue(label: "test.local.concurrency.failure")
            let channel = makeChannel(transport, queue: channelQueue)
            let lock = NSLock()
            var closeCount = 0
            channel.onText = { _ in }
            channel.onClose = { lock.lock(); closeCount += 1; lock.unlock() }
            transport.delegate?.localPeerTransportDidStart()

            let group = DispatchGroup()
            DispatchQueue.global().async(group: group) {
                transport.delegate?.localPeerTransportDidFail()
            }
            DispatchQueue.global().async(group: group) { channel.close() }
            group.wait()
            channelQueue.sync {}

            lock.lock()
            let count = closeCount
            lock.unlock()
            XCTAssertEqual(count, 1)
            XCTAssertTrue(transport.stopped)
        }
    }
}
