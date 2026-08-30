import XCTest
import WebRTC
@testable import RelayiumKit

/// What the real driver does, driven through its own public surface with no
/// second peer.
///
/// A live peer is needed for SDP, ICE and DCEP — and for nothing else. Failure,
/// teardown ordering, the re-entrancy rules of the client callbacks, the local
/// candidate gate and the deadline wiring are all reachable from this side
/// alone: a `busy` signal is a complete failure path, a delegate callback can be
/// invoked directly, and the deadlines are injectable. What remains
/// unevidenced is the wire itself — no native↔native and no native↔Web run has
/// been made against this driver.
final class WebRTCLinkTransportTests: XCTestCase {

    private let peer = "peer-b"
    private let peerCommit = "Y29tbWl0"      // base64, shape only; nothing here verifies it

    /// A clock the test moves by hand, so "this event reached the queue after
    /// the deadline had passed" is an assertion rather than a sleep. Locked
    /// because the transport reads it on its own private queue.
    private final class TestClock {
        private let lock = NSLock()
        private var value: TimeInterval = 0
        var now: TimeInterval {
            get { lock.withLock { value } }
            set { lock.withLock { value = newValue } }
        }
    }

    /// A clock that reads `before` for its first `readingsBeforeJump` readings
    /// and `after` from then on.
    ///
    /// The only way to land a deadline INSIDE an asynchronous WebRTC completion
    /// from outside it: the window between `pc.offer`/`pc.answer` returning and
    /// its completion reaching the transport's queue is inside libwebrtc and is
    /// not observable from a test. Counting readings is a legitimate stand-in
    /// because the driver states and keeps a one-reading-per-event-boundary
    /// rule — "ONE reading for this whole decision" — so the k-th reading IS the
    /// k-th boundary. Each test below names the boundaries it is counting; a
    /// driver that grew an extra reading would fail them rather than pass
    /// vacuously.
    private final class StepClock {
        private let lock = NSLock()
        private let before: TimeInterval
        private let after: TimeInterval
        private var remaining: Int

        init(before: TimeInterval = 0, after: TimeInterval, readingsBeforeJump: Int) {
            self.before = before
            self.after = after
            self.remaining = readingsBeforeJump
        }

        var now: TimeInterval {
            lock.withLock {
                guard remaining > 0 else { return after }
                remaining -= 1
                return before
            }
        }
    }

    private func harness(
        role: Role = .initiator,
        deadlines: LinkDeadlines = LinkDeadlines(),
        capture: LinkFrameCapture = LinkFrameCapture(),
        clock: TestClock? = nil,
        now: (() -> TimeInterval)? = nil
    ) -> (FakeWebSocketChannel, SignalingClient, WebRTCLinkTransport) {
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        let transport = WebRTCLinkTransport(
            signaling: signaling,
            peerId: peer,
            role: role,
            iceServers: [],
            capture: capture,
            deadlines: deadlines,
            now: now
                ?? clock.map { clock in { clock.now } }
                ?? { ProcessInfo.processInfo.systemUptime })
        return (channel, signaling, transport)
    }

    /// Flushes the transport's private queue: every public accessor runs on it,
    /// so returning from one means everything queued earlier has run.
    private func drain(_ transport: WebRTCLinkTransport) {
        _ = transport.bufferedAmount(on: .file)
    }

    private func newPeerConnection() throws -> RTCPeerConnection {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        return try XCTUnwrap(RTCPeerConnectionFactory().peerConnection(
            with: RTCConfiguration(), constraints: constraints, delegate: nil))
    }

    /// A real `RTCDataChannel` on the file lane's exact label.
    ///
    /// Real rather than faked because the thing under test is what the
    /// Objective-C wrapper does with its weak `delegate`, which no substitute
    /// has. It never negotiates — `readyState` stays `connecting` — and that is
    /// all these tests need it to do. One label, because the lane a claimed
    /// channel ends up on is what `capture.file` is read against below.
    private func newLinkChannel(on pc: RTCPeerConnection) throws -> RTCDataChannel {
        let config = RTCDataChannelConfiguration()
        config.isOrdered = true
        return try XCTUnwrap(pc.dataChannel(forLabel: LINK_FILE_CHANNEL, configuration: config))
    }

    /// True exactly once, from any thread.
    private final class OneShot {
        private let lock = NSLock()
        private var fired = false
        func fire() -> Bool {
            lock.withLock {
                defer { fired = true }
                return !fired
            }
        }
    }

    private func candidate(_ address: String = "10.0.0.1") -> RTCIceCandidate {
        RTCIceCandidate(sdp: "candidate:1 1 udp 1 \(address) 5 typ host",
                        sdpMLineIndex: 0,
                        sdpMid: "0")
    }

    /// A real offer, carrying both lanes, from a throwaway PeerConnection.
    ///
    /// A hand-written SDP would be refused by `setRemoteDescription`, and a
    /// transport that fails on a malformed description cannot show whether it
    /// was on the clock — the two outcomes look the same from outside.
    private func realOfferSDP() throws -> String {
        let pc = try newPeerConnection()
        defer { pc.close() }
        let config = RTCDataChannelConfiguration()
        config.isOrdered = true
        for label in LINK_CHANNEL_LABELS {
            XCTAssertNotNil(pc.dataChannel(forLabel: label, configuration: config))
        }
        var sdp: String?
        let made = expectation(description: "a real offer")
        pc.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) {
            description, _ in
            sdp = description?.sdp
            made.fulfill()
        }
        wait(for: [made], timeout: 10)
        return try XCTUnwrap(sdp)
    }

    /// The admitted peer's offer, exactly as `LinkAdmission` would hand it over.
    private func admittedOffer() throws -> JSONValue {
        linkSDPSignal(kind: "offer",
                      sdp: try realOfferSDP(),
                      commit: peerCommit,
                      caps: [LINK_CAPABILITY])
    }

    /// Blocks until the transport has answered, which is the only observable
    /// proof that its policy accepted the peer.
    private func waitForAnswer(_ channel: FakeWebSocketChannel) {
        let answered = expectation(description: "the responder answered")
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                if channel.sent.contains(where: { $0.contains("answer") }) {
                    answered.fulfill()
                    return
                }
                usleep(20_000)
            }
        }
        wait(for: [answered], timeout: 6)
    }

    // MARK: - the terminal path

    /// Teardown happens FIRST, so a failure callback cannot speak for a
    /// transport that is already gone. Before this ordering existed, `onError`
    /// ran while the transport still believed it was open.
    func testFailureCallbacksObserveAClosedTransport() {
        let (_, _, transport) = harness()
        var closedDuringError: Bool?
        var sendError: LinkTransportError?
        var closedDuringClose: Bool?

        transport.onError = { _ in
            closedDuringError = transport.isClosed
            do { try transport.send([1], on: .file) } catch {
                sendError = error as? LinkTransportError
            }
        }
        transport.onClose = { closedDuringClose = transport.isClosed }

        transport.receive(from: peer, signal: linkBusySignal())
        drain(transport)

        XCTAssertEqual(closedDuringError, true)
        XCTAssertEqual(sendError, .closed, "a send from onError is refused as closed, not as early")
        XCTAssertEqual(closedDuringClose, true)
        XCTAssertTrue(transport.isClosed)
    }

    /// One failure, one of each callback, in that order, and neither nested
    /// inside the other.
    func testOnErrorThenOnCloseFireExactlyOnceAndAreNotNested() {
        let (_, _, transport) = harness()
        var trace: [String] = []
        transport.onError = { _ in
            trace.append("error:enter")
            // A caller is entitled to close from here. It must be a no-op, not a
            // second teardown and not an `onClose` nested inside this callback.
            transport.close()
            trace.append("error:exit")
        }
        transport.onClose = { trace.append("close") }

        transport.receive(from: peer, signal: linkBusySignal())
        // A second failure and a second close must add nothing.
        transport.receive(from: peer, signal: linkBusySignal())
        transport.close()
        drain(transport)

        XCTAssertEqual(trace, ["error:enter", "error:exit", "close"])
    }

    func testTheReportedFailureIsThePolicysOwnError() {
        let (_, _, transport) = harness()
        var reported: LinkTransportError?
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.receive(from: peer, signal: linkBusySignal())
        drain(transport)
        XCTAssertEqual(reported, .peerBusy)
    }

    /// An explicit close is not a failure.
    func testAnExplicitCloseEmitsOnlyOnClose() {
        let (_, _, transport) = harness()
        var errors = 0
        var closes = 0
        transport.onError = { _ in errors += 1 }
        transport.onClose = { closes += 1 }

        transport.close()
        transport.close()
        drain(transport)

        XCTAssertEqual(errors, 0)
        XCTAssertEqual(closes, 1)
    }

    /// Teardown gives the signalling slot back and clears it, so a later signal
    /// cannot reach a transport that has ended.
    func testCloseReleasesTheSignallingSlot() {
        let (_, signaling, transport) = harness()
        XCTAssertNotNil(signaling.onSignal)
        transport.close()
        drain(transport)
        XCTAssertNil(signaling.onSignal)
    }

    /// A closed transport says nothing more to the peer.
    func testNothingIsSentAfterClose() {
        let (channel, _, transport) = harness()
        transport.close()
        drain(transport)
        channel.sent = []

        transport.receive(from: peer, signal: linkBusySignal())
        transport.peerConnection(try! newPeerConnection(), didGenerate: candidate())
        drain(transport)
        XCTAssertEqual(channel.sent, [])
    }

    // MARK: - close from inside a callback is immediate

    /// The property everything in the header's "close from a callback" rule
    /// rests on: by the time `close()` returns to a callback, the transport is
    /// closed — not scheduled to be.
    func testCloseFromInsideACallbackTakesEffectBeforeTheCallbackReturns() {
        let (_, _, transport) = harness()
        var closedImmediately: Bool?
        transport.onError = { _ in
            transport.close()
            closedImmediately = transport.isClosed
        }
        transport.receive(from: peer, signal: linkBusySignal())
        drain(transport)
        XCTAssertEqual(closedImmediately, true)
    }

    // MARK: - local candidate ordering

    /// A candidate that overtakes the description it belongs to reaches a peer
    /// with no remote description and is dropped there — and on a LAN the ones
    /// gathered first are exactly the host candidates that would have made the
    /// link direct.
    func testALocalCandidateGeneratedBeforeTheDescriptionIsHeld() throws {
        let (channel, _, transport) = harness()
        let pc = try newPeerConnection()
        defer { pc.close() }

        transport.peerConnection(pc, didGenerate: candidate())
        transport.peerConnection(pc, didGenerate: candidate("10.0.0.2"))
        drain(transport)

        XCTAssertEqual(channel.sent.filter { $0.contains("candidate") }.count, 0,
                       "nothing may precede the local description")
    }

    /// The same rule against real gathering: whatever the ICE agent produced
    /// while the offer was being made, none of it left ahead of the offer.
    func testNoLocalCandidateIsEverSentBeforeTheOffer() throws {
        let (channel, _, transport) = harness(role: .initiator)
        let offered = expectation(description: "the offer was sent")

        transport.start()
        // Poll rather than sleep: real SDP generation is asynchronous.
        let deadline = Date().addingTimeInterval(5)
        DispatchQueue.global().async {
            while Date() < deadline {
                if channel.sent.contains(where: { $0.contains("\"sdp\"") }) {
                    offered.fulfill()
                    return
                }
                usleep(20_000)
            }
        }
        wait(for: [offered], timeout: 6)

        // Give any gathered candidates a moment to follow it.
        let settled = expectation(description: "settled")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { settled.fulfill() }
        wait(for: [settled], timeout: 2)

        let sent = channel.sent
        let firstSDP = try XCTUnwrap(sent.firstIndex { $0.contains("\"sdp\"") },
                                     "the initiator must have offered")
        let firstCandidate = sent.firstIndex { $0.contains("\"candidate\"") }
        if let firstCandidate {
            XCTAssertGreaterThan(firstCandidate, firstSDP,
                                 "every candidate follows the description it belongs to")
        }
        transport.close()
        drain(transport)
    }

    // MARK: - claiming a channel the peer opened

    /// The delegate must be OWNED by the time this callback returns.
    ///
    /// `RTCDataChannel` registers its native observer while the Objective-C
    /// wrapper is built, and that adapter reads the weak `delegate` when each
    /// callback runs — sending to `nil`, silently, if nobody has claimed it. So
    /// a claim made one queue hop later is a window in which libwebrtc drops the
    /// peer's first frame before Relayium is told anything happened.
    ///
    /// Made an assertion rather than a race by parking the queue: the injected
    /// clock is read inside the item `didOpen` queues and BEFORE `collectLocked`
    /// — the only other place a delegate is ever assigned — so holding it there
    /// pins the one instant where "the callback has returned and the collection
    /// has not run" is true. A transport that claimed on the queue instead owns
    /// nothing at that instant.
    func testTheChannelDelegateIsClaimedBeforeDidOpenReturns() throws {
        let pc = try newPeerConnection()
        defer { pc.close() }
        let channel = try newLinkChannel(on: pc)

        let parked = DispatchSemaphore(value: 0)
        let resume = DispatchSemaphore(value: 0)
        let firstReading = OneShot()
        let (_, _, transport) = harness(role: .responder, now: {
            if firstReading.fire() {
                parked.signal()
                resume.wait()
            }
            return 0
        })
        // Flushed, not just closed: teardown runs on the queue this test parks.
        defer { resume.signal(); transport.close(); drain(transport) }
        XCTAssertNil(channel.delegate, "nothing owns it before the callback")

        transport.peerConnection(pc, didOpen: channel)

        XCTAssertEqual(parked.wait(timeout: .now() + 5), .success,
                       "the queued collection must have reached the clock")
        XCTAssertTrue(channel.delegate === transport,
                      "didOpen must not return without having taken the delegate itself")
    }

    /// A frame arriving the instant the callback returns must not overtake the
    /// collection that gives its label a lane.
    ///
    /// This is the real boundary, and the reason the claim is safe to make
    /// synchronously. `SctpDataChannel`'s observer adapter posts every message
    /// callback onto the signalling thread that is running `didOpen`, so the
    /// earliest a frame can be delivered is after that method returns — which is
    /// exactly what this does, from the same thread, with nothing in between. By
    /// then the collection is already on the transport queue and the frame
    /// queues behind it. A frame that arrived before its lane existed would not
    /// be delayed, it would be discarded: `LinkEstablishment.inbound` ignores a
    /// label it holds no channel for, so the capture would come back empty.
    func testAFrameArrivingAsSoonAsDidOpenReturnsQueuesBehindTheCollection() throws {
        let capture = LinkFrameCapture()
        let (_, _, transport) = harness(role: .responder, capture: capture)
        defer { transport.close(); drain(transport) }
        let pc = try newPeerConnection()
        defer { pc.close() }
        let channel = try newLinkChannel(on: pc)
        let frame: [UInt8] = [0x01, 0x02, 0x03, 0x04]

        transport.peerConnection(pc, didOpen: channel)
        transport.dataChannel(channel,
                              didReceiveMessageWith: RTCDataBuffer(data: Data(frame),
                                                                   isBinary: true))
        drain(transport)

        XCTAssertEqual(capture.take().file, [frame],
                       "the collection didOpen queued must already own this label")
    }

    /// A channel claimed for a transport that has already ended is given back.
    ///
    /// Between the synchronous claim and the collection it queued, the channel
    /// is owned by this transport and absent from `delegatedChannels` — the one
    /// list teardown walks. Nothing else would ever clear its delegate or close
    /// it.
    ///
    /// `didOpen` is invoked from inside `onClose`, which runs ON the transport
    /// queue: the claim is therefore synchronous while the queue is occupied,
    /// and the item it queues is ordered strictly after this callback returns.
    /// The interleaving is pinned by construction rather than won by a race.
    func testAChannelClaimedForAClosedTransportIsGivenBackRatherThanEscapingTeardown() throws {
        let (_, _, transport) = harness(role: .responder)
        let pc = try newPeerConnection()
        defer { pc.close() }
        let channel = try newLinkChannel(on: pc)

        var ownerAtClaim: AnyObject?
        transport.onClose = {
            transport.peerConnection(pc, didOpen: channel)
            ownerAtClaim = channel.delegate
        }
        transport.close()
        // Twice, and the second one is load-bearing: the first flush may be
        // queued behind the close that fires `onClose`, so the item `didOpen`
        // queues from inside that callback can land behind it. Only the second
        // flush is ordered after that item has actually run.
        drain(transport)
        drain(transport)

        XCTAssertTrue(ownerAtClaim === transport,
                      "the claim is unconditional — didOpen cannot read the queue's state")
        XCTAssertNil(channel.delegate,
                     "and a transport that has already ended must give the channel back")
        XCTAssertTrue(channel.readyState == .closing || channel.readyState == .closed,
                      "closed too, or it survives the transport that owned it")
    }

    /// The same for the other terminal path, which reaches it differently: the
    /// transport is live when the claim is made and only the boundary check
    /// inside the queued item discovers that its deadline is gone. The failure
    /// it raises tears down through `delegatedChannels`, which this channel has
    /// not reached — so the release has to happen on this path too, or an
    /// expired establishment leaves an open channel behind with a delegate
    /// pointing at it.
    func testAChannelClaimedForAnExpiredTransportIsGivenBackRatherThanEscapingTeardown() throws {
        let clock = TestClock()
        let (_, _, transport) = harness(role: .responder,
                                        deadlines: LinkDeadlines(setupHardCap: 600,
                                                                 noProgress: 100,
                                                                 keyReveal: 600),
                                        clock: clock)
        let failed = expectation(description: "failed closed")
        var reported: LinkTransportError?
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }
        let pc = try newPeerConnection()
        defer { pc.close() }
        let channel = try newLinkChannel(on: pc)

        transport.start()
        drain(transport)
        clock.now = 200

        transport.peerConnection(pc, didOpen: channel)
        wait(for: [failed], timeout: 5)
        drain(transport)

        XCTAssertEqual(reported, .establishmentTimeout(.noProgress),
                       "the collection is what discovers the crossed deadline")
        XCTAssertNil(channel.delegate,
                     "an expired establishment must not keep a channel it never collected")
        XCTAssertTrue(channel.readyState == .closing || channel.readyState == .closed,
                      "and must not leave it open")
    }

    // MARK: - deadlines

    /// The gap this closes: a candidate transport with no owner watching it used
    /// to sit inert forever. A responder that is never sent an offer is exactly
    /// that case.
    func testAnEstablishmentThatNeverProgressesFailsOnTheNoProgressDeadline() {
        let (_, _, transport) = harness(role: .responder,
                                        deadlines: LinkDeadlines(setupHardCap: 30,
                                                                 noProgress: 0.05,
                                                                 keyReveal: 30))
        let failed = expectation(description: "timed out")
        var reported: LinkTransportError?
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertTrue(transport.isClosed)
    }

    /// The hard cap bounds the total and outranks the rest when both have
    /// passed.
    func testTheHardCapEndsAnEstablishmentEvenWithoutTheNoProgressDeadline() {
        let (_, _, transport) = harness(role: .responder,
                                        deadlines: LinkDeadlines(setupHardCap: 0.05,
                                                                 noProgress: 30,
                                                                 keyReveal: 30))
        let failed = expectation(description: "timed out")
        var reported: LinkTransportError?
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .establishmentTimeout(.setup))
    }

    /// A transport nobody started, but which was handed the offer that created
    /// it, is still on the clock. A responder is the whole reason arming cannot
    /// wait for `start()`: `LinkAdmission` builds it FROM that offer.
    func testTheAdmittedOfferArmsTheDeadlinesWithoutStart() throws {
        let (_, _, transport) = harness(role: .responder,
                                        deadlines: LinkDeadlines(setupHardCap: 0.05,
                                                                 noProgress: 30,
                                                                 keyReveal: 30))
        let failed = expectation(description: "timed out")
        var reported: LinkTransportError?
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.receive(from: peer, signal: try admittedOffer())
        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .establishmentTimeout(.setup))
        XCTAssertTrue(transport.isClosed)
    }

    /// The clock belongs to THIS establishment, so only this establishment's
    /// own work may start it.
    ///
    /// A room is a broadcast surface: a stranger's `busy`, a generation that is
    /// not ours, admission's own request/leave vocabulary and a roster caps
    /// hello all reach every transport in the room. None of them is progress,
    /// none of them is even addressed here, and a transport that started its
    /// deadline on one would be killed by traffic between two other peers.
    func testASignalThisEstablishmentWillNotActOnNeitherArmsNorEndsIt() {
        let (_, _, transport) = harness(role: .responder,
                                        deadlines: LinkDeadlines(setupHardCap: 0.05,
                                                                 noProgress: 0.05,
                                                                 keyReveal: 0.05))
        var errors = 0
        var closes = 0
        transport.onError = { _ in errors += 1 }
        transport.onClose = { closes += 1 }

        transport.receive(from: "somebody-else", signal: linkBusySignal())
        transport.receive(from: "somebody-else", signal: linkSDPSignal(kind: "offer",
                                                                      sdp: "v=0",
                                                                      commit: peerCommit,
                                                                      caps: [LINK_CAPABILITY]))
        transport.receive(from: peer, signal: sdpSignal(kind: "offer",
                                                        sdp: "v=0",
                                                        commit: peerCommit,
                                                        generation: .file,
                                                        caps: [LINK_CAPABILITY]))
        transport.receive(from: peer, signal: linkRequestSignal())
        transport.receive(from: peer, signal: linkLeaveSignal(
            auth: String(repeating: "a", count: LINK_LEAVE_AUTH_LENGTH)))
        transport.receive(from: peer,
                          signal: taggedSignal(capsField([LINK_CAPABILITY]), generation: .link))

        let settled = expectation(description: "well past every deadline")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        drain(transport)

        XCTAssertEqual(errors, 0, "an inert signal is not a failure")
        XCTAssertEqual(closes, 0, "and it does not start a clock that then fires")
        XCTAssertFalse(transport.isClosed)
    }

    // MARK: - an event that arrives after a deadline

    /// A `DispatchWorkItem` is not a promise about time. The wake-up can be
    /// queued behind a client callback that ran long, or behind a device that
    /// suspended, and by the time an event is served its deadline may already
    /// have passed. Acting on it would extend an establishment that had
    /// already exceeded its bound — so the boundary check comes first.
    ///
    /// The clock here moves without the wake-up ever firing: it is scheduled a
    /// hundred real seconds out and this test never waits for it.
    func testASignalServedAfterItsDeadlineFailsClosedInsteadOfProgressing() throws {
        let clock = TestClock()
        let (channel, _, transport) = harness(role: .responder,
                                              deadlines: LinkDeadlines(setupHardCap: 600,
                                                                       noProgress: 100,
                                                                       keyReveal: 600),
                                              clock: clock)
        let failed = expectation(description: "failed closed")
        var reported: LinkTransportError?
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        drain(transport)
        clock.now = 200

        transport.receive(from: peer, signal: try admittedOffer())
        wait(for: [failed], timeout: 5)

        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertFalse(channel.sent.contains { $0.contains("answer") },
                       "an expired establishment does not answer")
    }

    /// The same rule at the point where it costs the most: a reveal is what
    /// derives the session keys and produces the SAS, and one served after the
    /// establishment's deadline must authenticate nobody. The peer that sent it
    /// is entitled to assume this side gave up.
    func testARevealServedAfterItsDeadlineNeverEmitsSAS() throws {
        let clock = TestClock()
        let (channel, _, transport) = harness(role: .responder,
                                              deadlines: LinkDeadlines(setupHardCap: 600,
                                                                       noProgress: 100,
                                                                       keyReveal: 600),
                                              clock: clock)
        var sas: String?
        var ready = 0
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onSAS = { sas = $0 }
        transport.onReady = { _ in ready += 1 }
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.receive(from: peer, signal: try admittedOffer())
        // The answer is the proof that the policy accepted this peer, so the
        // reveal below is one this transport would otherwise verify.
        waitForAnswer(channel)
        clock.now = 200

        transport.receive(from: peer,
                          signal: taggedSignal(revealField(Reveal(key: "a2V5", nonce: "bm9uY2U=")),
                                               generation: .link))
        wait(for: [failed], timeout: 5)

        XCTAssertNil(sas, "an expired establishment authenticates nobody")
        XCTAssertEqual(ready, 0)
        XCTAssertEqual(reported, .establishmentTimeout(.noProgress),
                       "it ended on its deadline, not on the handshake it should never have run")
    }

    // MARK: - a deadline crossed inside a client callback

    /// `onSAS` is the consumer's own code, it runs on the transport's queue, and
    /// showing six digits to a user is exactly the kind of thing that takes an
    /// unbounded amount of time. While it holds the queue the wake-up that would
    /// have reported the crossed deadline cannot run, so the transport used to
    /// come back from it, check only `closed`, disclose its own key and disarm
    /// the watchdog by publishing — an establishment continuing well past the
    /// bound it had already lost.
    ///
    /// The clock here is moved from inside the callback, which is the exact
    /// shape of the hazard, and the wake-up never fires: it is scheduled a
    /// hundred seconds out and this test never waits for it.
    func testADeadlineCrossedInsideOnSASStopsTheRevealAndThePublication() throws {
        let clock = TestClock()
        let (channel, _, transport) = harness(role: .responder,
                                              deadlines: LinkDeadlines(setupHardCap: 600,
                                                                       noProgress: 100,
                                                                       keyReveal: 600),
                                              clock: clock)
        // A real peer handshake, so the reveal below genuinely verifies and
        // `onSAS` genuinely runs. A reveal that merely failed to verify would
        // prove nothing about the window this test is about.
        let peerHandshake = HandshakeState(role: .initiator)

        var sasSeen: String?
        var ready = 0
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onSAS = { sas in
            sasSeen = sas
            clock.now = 200
        }
        transport.onReady = { _ in ready += 1 }
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.receive(from: peer,
                          signal: linkSDPSignal(kind: "offer",
                                                sdp: try realOfferSDP(),
                                                commit: peerHandshake.selfCommitBase64,
                                                caps: [LINK_CAPABILITY]))
        // The answer is the proof that the policy accepted this peer; clearing
        // afterwards leaves only what this side said AFTER the callback.
        waitForAnswer(channel)
        channel.sent = []

        transport.receive(from: peer,
                          signal: taggedSignal(revealField(peerHandshake.reveal()),
                                               generation: .link))
        wait(for: [failed], timeout: 10)

        XCTAssertNotNil(sasSeen, "the reveal verified, so the callback really did run")
        XCTAssertFalse(channel.sent.contains { $0.contains("reveal") },
                       "a link that lost its window discloses no key")
        XCTAssertEqual(ready, 0, "and publishes nothing")
        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertTrue(transport.isClosed)
    }

    // MARK: - a deadline crossed inside an asynchronous WebRTC completion

    /// Producing an offer is asynchronous, and its completion comes back on the
    /// queue the wake-up was waiting for. A completion served after the deadline
    /// would apply a local description, put an offer on the wire and open the
    /// local candidate gate for an establishment that had already lost.
    ///
    /// Reading 1 is `start`'s own arming — the driver's single reading for that
    /// decision — so the clock is already past the no-progress deadline by the
    /// time the offer comes back, without the wake-up (a hundred seconds out)
    /// ever firing.
    func testAnOfferCompletedAfterTheDeadlineNeverReachesTheWire() {
        let clock = StepClock(after: 200, readingsBeforeJump: 1)
        let (channel, _, transport) = harness(role: .initiator,
                                              deadlines: LinkDeadlines(setupHardCap: 600,
                                                                       noProgress: 100,
                                                                       keyReveal: 600),
                                              now: { clock.now })
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        wait(for: [failed], timeout: 10)

        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertFalse(channel.sent.contains { $0.contains("\"sdp\"") },
                       "an expired establishment offers nothing")
        XCTAssertFalse(channel.sent.contains { $0.contains("\"candidate\"") },
                       "and never opens the gate that would let its candidates out")
    }

    /// The same boundary in the responder's role. Reading 1 is the inbound
    /// signal's own boundary and reading 2 is `setRemoteDescription`'s
    /// completion, so the jump lands between the applied offer and the answer
    /// this transport was about to produce for it.
    func testAnAnswerCompletedAfterTheDeadlineNeverReachesTheWire() throws {
        let clock = StepClock(after: 200, readingsBeforeJump: 2)
        let (channel, _, transport) = harness(role: .responder,
                                              deadlines: LinkDeadlines(setupHardCap: 600,
                                                                       noProgress: 100,
                                                                       keyReveal: 600),
                                              now: { clock.now })
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.receive(from: peer, signal: try admittedOffer())
        wait(for: [failed], timeout: 10)

        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertFalse(channel.sent.contains { $0.contains("answer") },
                       "an expired establishment answers nothing")
        XCTAssertFalse(channel.sent.contains { $0.contains("\"candidate\"") },
                       "and never opens the gate that would let its candidates out")
    }

    /// Teardown cancels the wake-up. A timer that fired into a closed transport
    /// would report a failure to a consumer that had already been told it was
    /// gone.
    func testClosingCancelsThePendingDeadline() {
        let (_, _, transport) = harness(role: .responder,
                                        deadlines: LinkDeadlines(setupHardCap: 30,
                                                                 noProgress: 0.1,
                                                                 keyReveal: 30))
        var errors = 0
        var closes = 0
        transport.onError = { _ in errors += 1 }
        transport.onClose = { closes += 1 }

        transport.start()
        transport.close()

        let settled = expectation(description: "well past the deadline")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        drain(transport)

        XCTAssertEqual(errors, 0, "a cancelled deadline reports nothing")
        XCTAssertEqual(closes, 1)
    }

    /// A transport dropped without being closed must not leave a timer holding
    /// it alive, and must not fire into a deallocated object.
    func testADroppedTransportDoesNotFireItsDeadline() {
        var closes = 0
        do {
            let (_, _, transport) = harness(role: .responder,
                                            deadlines: LinkDeadlines(setupHardCap: 30,
                                                                     noProgress: 0.1,
                                                                     keyReveal: 30))
            transport.onClose = { closes += 1 }
            transport.start()
            drain(transport)
        }
        let settled = expectation(description: "well past the deadline")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        XCTAssertEqual(closes, 0)
    }
}
