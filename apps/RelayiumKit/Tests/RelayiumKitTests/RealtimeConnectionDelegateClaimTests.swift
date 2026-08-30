import XCTest
import WebRTC
@testable import RelayiumKit

/// Who owns a channel the peer opened, and from which thread.
///
/// `RealtimeConnection` is otherwise integration-tested — it needs two live
/// peers for offer/answer, ICE and DCEP, and its file header says so. The one
/// thing in it that a single side CAN decide is this: `didOpen` is a callback
/// from a WebRTC-internal thread, and whether the delegate is claimed on that
/// thread or one queue hop later is settled before any peer is involved. A
/// delegate callback can be invoked directly, a real `RTCDataChannel` can be
/// built from one `RTCPeerConnection`, and the connection's own queue can be
/// parked on a client callback — which is all these need.
///
/// None of this is evidence about the wire. No native↔native or native↔Web run
/// has been made against this file.
final class RealtimeConnectionDelegateClaimTests: XCTestCase {

    private let peer = "peer-b"

    // MARK: - harness

    private func harness(role: Role = .responder)
        -> (FakeWebSocketChannel, SignalingClient, RealtimeConnection) {
        let socket = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: socket, name: "self")
        socket.fireOpen()
        let connection = RealtimeConnection(
            signaling: signaling,
            peerId: peer,
            role: role,
            iceServers: [])
        return (socket, signaling, connection)
    }

    /// Flushes the connection's private queue: `textBufferedAmount` reads it
    /// with `queue.sync`, so returning from it means everything queued earlier
    /// has run.
    private func drain(_ connection: RealtimeConnection) {
        _ = connection.textBufferedAmount
    }

    private func newPeerConnection() throws -> RTCPeerConnection {
        ensureRTCSSL()
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        return try XCTUnwrap(RTCPeerConnectionFactory().peerConnection(
            with: RTCConfiguration(), constraints: constraints, delegate: nil))
    }

    /// A real `RTCDataChannel`, on a peer connection that is NOT the one under
    /// test.
    ///
    /// Real rather than faked because the thing under test is what the
    /// Objective-C wrapper does with its weak `delegate`, which no substitute
    /// has. Owned by a separate `RTCPeerConnection` because the connection's
    /// own teardown closes its `pc` — and a channel closed as a side effect of
    /// that could not distinguish "the release path closed it" from "its peer
    /// connection went away underneath it". It never negotiates: `readyState`
    /// stays `connecting` until something closes it, and that is the signal.
    private func newDataChannel(on pc: RTCPeerConnection) throws -> RTCDataChannel {
        let config = RTCDataChannelConfiguration()
        config.isOrdered = true
        return try XCTUnwrap(pc.dataChannel(forLabel: "data", configuration: config))
    }

    /// Waits for something decided on a queue this test can no longer reach.
    ///
    /// Used only where the connection that owned the queue has been
    /// deallocated, so no synchronous flush is left to call. The work is
    /// already enqueued and already unblocked when this starts: it is waiting
    /// for a scheduled item to be observed, not racing one that may never run.
    private func waitUntil(_ what: String,
                           _ condition: () -> Bool,
                           file: StaticString = #filePath,
                           line: UInt = #line) {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if condition() { return }
            Thread.sleep(forTimeInterval: 0.002)
        }
        XCTFail("timed out waiting until \(what)", file: file, line: line)
    }

    // MARK: - the claim is synchronous

    /// The delegate must be OWNED by the time this callback returns.
    ///
    /// `RTCDataChannel` registers its native observer while the Objective-C
    /// wrapper is built, and that adapter reads the weak `delegate` when each
    /// callback runs — sending to `nil`, silently, if nobody has claimed it. So
    /// a claim made one queue hop later is a window in which libwebrtc drops the
    /// peer's first frame before Relayium is told anything happened.
    ///
    /// Made an assertion rather than a race by parking the queue on a client
    /// callback that runs on it. `send` with no session keys reaches
    /// `onError(.notReady)` from the queue and does nothing else, so blocking
    /// inside that callback holds the queue at an instant where the connection
    /// is fully live and NOTHING queued afterwards has run. A connection that
    /// claimed on the queue instead owns nothing at that instant, because the
    /// item that would do the claiming is sitting behind this one.
    func testTheChannelDelegateIsClaimedBeforeDidOpenReturns() throws {
        let pc = try newPeerConnection()
        defer { pc.close() }
        let dataChannel = try newDataChannel(on: pc)
        let (_, _, connection) = harness()

        let parked = DispatchSemaphore(value: 0)
        let resume = DispatchSemaphore(value: 0)
        connection.onError = { _ in
            parked.signal()
            resume.wait()
        }
        // Flushed, not just closed: teardown runs on the queue this test parks.
        defer { resume.signal(); connection.close(); drain(connection) }

        connection.send(sources: [], metas: [])
        XCTAssertEqual(parked.wait(timeout: .now() + 5), .success,
                       "the send path must have reached the queue and parked it")
        XCTAssertNil(dataChannel.delegate, "nothing owns it before the callback")

        connection.peerConnection(pc, didOpen: dataChannel)

        XCTAssertTrue(dataChannel.delegate === connection,
                      "didOpen must not return without having taken the delegate itself")
    }

    /// The claim is unconditional, and the state it queues still lands.
    ///
    /// The same parked instant, released: the item `didOpen` queued runs behind
    /// the parked callback, and the connection keeps the channel it claimed
    /// rather than handing it back. This is the live counterpart of the two
    /// release paths below — it is what must NOT happen to a connection that is
    /// still open.
    func testAClaimedChannelIsKeptWhenTheConnectionIsStillOpen() throws {
        let pc = try newPeerConnection()
        defer { pc.close() }
        let dataChannel = try newDataChannel(on: pc)
        let (_, _, connection) = harness()

        let parked = DispatchSemaphore(value: 0)
        let resume = DispatchSemaphore(value: 0)
        connection.onError = { _ in
            parked.signal()
            resume.wait()
        }
        connection.send(sources: [], metas: [])
        XCTAssertEqual(parked.wait(timeout: .now() + 5), .success)

        connection.peerConnection(pc, didOpen: dataChannel)
        resume.signal()
        drain(connection)

        XCTAssertTrue(dataChannel.delegate === connection,
                      "an open connection keeps what it claimed")
        XCTAssertEqual(dataChannel.readyState, .connecting,
                       "and must not close it")

        connection.close()
        drain(connection)
        XCTAssertNil(dataChannel.delegate,
                     "and the collected channel is released by the ordinary close")
    }

    // MARK: - a claim made for a connection that has already ended

    /// A channel claimed for a closed connection is given back.
    ///
    /// Between the synchronous claim and the queued assignment, the channel is
    /// owned by this connection and is not yet `channel` — the one reference
    /// `closeLocked` clears and drops. Nothing else would ever clear its
    /// delegate or close it.
    ///
    /// `didOpen` is invoked from inside `onClose`, which `closeLocked` fires ON
    /// the queue: the claim is therefore synchronous while the queue is
    /// occupied, and the item it queues is ordered strictly after this callback
    /// returns. The interleaving is pinned by construction rather than won by a
    /// race.
    func testAChannelClaimedForAClosedConnectionIsGivenBackRatherThanEscapingTeardown() throws {
        let pc = try newPeerConnection()
        defer { pc.close() }
        let dataChannel = try newDataChannel(on: pc)
        let (_, _, connection) = harness()

        var ownedAtClaim = false
        connection.onClose = {
            connection.peerConnection(pc, didOpen: dataChannel)
            ownedAtClaim = dataChannel.delegate === connection
        }
        connection.close()
        // Twice, and the second one is load-bearing: the first flush is queued
        // behind the close that fires `onClose`, so the item `didOpen` queues
        // from inside that callback lands behind it. Only the second flush is
        // ordered after that item has actually run.
        drain(connection)
        drain(connection)

        XCTAssertTrue(ownedAtClaim,
                      "the claim is unconditional — didOpen cannot read the queue's state")
        XCTAssertNil(dataChannel.delegate,
                     "and a connection that has already ended must give the channel back")
        XCTAssertTrue(dataChannel.readyState == .closing || dataChannel.readyState == .closed,
                      "closed too, or it survives the connection that owned it")
    }

    /// The other way a claim can outlive its owner: the caller drops its last
    /// reference without ever calling `close()`, which `deinit` exists to
    /// survive. `deinit` tears down through `channel`, which an uncollected
    /// channel has not reached, so the queued item is the only thing left that
    /// knows about it — and by then its weak delegate has died with the
    /// connection, leaving only the close to do.
    ///
    /// The queue is parked exactly as above, so the claim happens while the
    /// connection is alive and the last reference is dropped before the item
    /// that would collect it can run.
    func testAChannelClaimedForADeallocatedConnectionIsClosedRatherThanLeftOpen() throws {
        let pc = try newPeerConnection()
        defer { pc.close() }
        let dataChannel = try newDataChannel(on: pc)

        let parked = DispatchSemaphore(value: 0)
        let resume = DispatchSemaphore(value: 0)
        var ownedAtClaim = false
        weak var weakConnection: RealtimeConnection?

        do {
            let (_, _, connection) = harness()
            weakConnection = connection
            // Captures the semaphores and nothing else: a closure that held the
            // connection would be stored ON it, and it could never deallocate.
            connection.onError = { _ in
                parked.signal()
                resume.wait()
            }
            connection.send(sources: [], metas: [])
            XCTAssertEqual(parked.wait(timeout: .now() + 5), .success)

            connection.peerConnection(pc, didOpen: dataChannel)
            ownedAtClaim = dataChannel.delegate === connection
        }
        // The last strong reference is gone; whether the parked item still
        // holds one until it returns only decides WHERE `deinit` runs, not
        // whether the connection is gone before the collection is reached.
        resume.signal()

        XCTAssertTrue(ownedAtClaim, "the claim is made while the connection is alive")
        waitUntil("the deallocated connection's queued collection has run") {
            weakConnection == nil && dataChannel.readyState != .connecting
        }
        XCTAssertNil(weakConnection, "the connection must not be kept alive by the claim")
        XCTAssertNil(dataChannel.delegate, "a dead owner leaves no delegate behind")
        XCTAssertTrue(dataChannel.readyState == .closing || dataChannel.readyState == .closed,
                      "and the channel it never collected must not be left open")
    }

    // MARK: - source guards

    private func source() throws -> String {
        try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift")
    }

    /// The source with every comment removed.
    ///
    /// The guards below are about what `didOpen` DOES, and it explains its own
    /// reasoning at length — including, necessarily, the name of the thing it
    /// deliberately does not do off the queue. Counting that explanation as
    /// code would make the guard fire on its own rationale, which is the
    /// fastest way to teach the next reader to delete it.
    private func code() throws -> String {
        try source()
            .components(separatedBy: "\n")
            .map { line -> String in
                guard let marker = line.range(of: "//") else { return line }
                return String(line[line.startIndex..<marker.lowerBound])
            }
            .joined(separator: "\n")
    }

    /// The non-empty, non-comment lines of a fragment, trimmed.
    private func statements(in fragment: Substring) -> [String] {
        fragment
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("//") }
    }

    /// `didOpen` runs on a WebRTC-internal thread, and exactly two things
    /// happen there, in this order: the delegate is CLAIMED, and then the
    /// mutable state is QUEUED.
    ///
    /// Both halves are load-bearing and neither is visible from outside. The
    /// claim has to be synchronous because `RTCDataChannel`'s adapter reads its
    /// weak `delegate` when each callback runs and drops the frame when it is
    /// nil — a claim one queue hop later loses the peer's first frame, and no
    /// test without two negotiating endpoints can watch libwebrtc read that
    /// pointer. The claim has to come FIRST because the item it queues is the
    /// one that gives a closed connection its chance to hand the channel back:
    /// queued ahead of the claim, that release can run on `queue` while this
    /// thread has not assigned yet, and the assignment then lands on an
    /// already-released channel that nothing else will ever clear or close. No
    /// frame is at risk in either order — the adapter posts its callbacks onto
    /// the very thread running this method, so the earliest one arrives after
    /// it returns — which is exactly why the release race is what decides the
    /// order. And nothing else may appear here: this method is on the wrong
    /// thread for every other line in this file.
    func testDidOpenClaimsTheChannelAndThenQueuesTheMutableState() throws {
        let source = try self.code()
        XCTAssertFalse(source.isEmpty, "the connection source must be readable")
        let opened = try XCTUnwrap(source.range(of: "didOpen dataChannel: RTCDataChannel) {"))
        let tail = String(source[opened.upperBound...])
        // Up to the method's own closing brace — the first one at member indent.
        let end = try XCTUnwrap(tail.range(of: "\n    }"))
        let body = String(tail[tail.startIndex..<end.lowerBound])

        let queued = try XCTUnwrap(body.range(of: "queue.async { [weak self] in"),
                                   "the mutable state stays a queue item")
        let closureEnd = try XCTUnwrap(body.range(of: "\n        }",
                                                 range: queued.upperBound..<body.endIndex),
                                       "the queued block must close at member indent")

        XCTAssertEqual(statements(in: body[body.startIndex..<queued.lowerBound]),
                       ["dataChannel.delegate = self"],
                       "the claim is synchronous, and it is all that precedes the queue hop")
        XCTAssertEqual(statements(in: body[closureEnd.upperBound...]), [],
                       "and nothing at all follows it off the queue")
    }

    /// Both ways an uncollected claim can outlive its owner are answered inside
    /// the queued item, and neither may quietly become a bare `return`: a
    /// closed connection releases the channel, and a deallocated one closes it.
    func testTheQueuedCollectionReleasesTheChannelOnBothTerminalPaths() throws {
        let source = try self.code()
        let opened = try XCTUnwrap(source.range(of: "didOpen dataChannel: RTCDataChannel) {"))
        let tail = String(source[opened.upperBound...])
        let end = try XCTUnwrap(tail.range(of: "\n    }"))
        let body = String(tail[tail.startIndex..<end.lowerBound])

        let gone = try XCTUnwrap(body.range(of: "guard let self else {"),
                                 "the deallocated owner must be its own case")
        let goneEnd = try XCTUnwrap(body.range(of: "\n            }",
                                              range: gone.upperBound..<body.endIndex))
        XCTAssertEqual(statements(in: body[gone.upperBound..<goneEnd.lowerBound]),
                       ["dataChannel.close()", "return"],
                       "a dead owner's weak delegate is already nil; only the close is left")

        let closed = try XCTUnwrap(body.range(of: "guard !self.closed else {"),
                                   "the closed connection must be its own case")
        let closedEnd = try XCTUnwrap(body.range(of: "\n            }",
                                                range: closed.upperBound..<body.endIndex))
        XCTAssertEqual(statements(in: body[closed.upperBound..<closedEnd.lowerBound]),
                       ["self.releaseUncollectedLocked(dataChannel)", "return"],
                       "a closed connection hands the channel back through the one release path")
    }

    /// The release clears before it closes, for the same reason `closeLocked`
    /// does: closing a channel that still names a delegate is a callback into a
    /// connection whose client has already been told it ended.
    func testAnUncollectedChannelIsClearedBeforeItIsClosed() throws {
        let source = try self.code()
        let release = try XCTUnwrap(source.range(
            of: "private func releaseUncollectedLocked(_ channel: RTCDataChannel) {"))
        let tail = String(source[release.upperBound...])
        let end = try XCTUnwrap(tail.range(of: "\n    }"))
        XCTAssertEqual(statements(in: tail[tail.startIndex..<end.lowerBound]),
                       ["channel.delegate = nil", "channel.close()"])
    }
}
