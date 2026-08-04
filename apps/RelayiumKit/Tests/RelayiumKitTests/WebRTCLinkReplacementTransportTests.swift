import XCTest
import WebRTC
@testable import RelayiumKit

/// What the real replacement driver does, driven through its own public surface
/// with no second peer.
///
/// A live peer is needed for SDP, ICE and DCEP — and for nothing else. What this
/// batch actually adds is reachable from this side alone: which signals are
/// acted on, what leaves this side and under whose key, the deadlines, the
/// terminal path and the re-entrancy rules. What remains unevidenced is the wire
/// itself — no native↔native and no native↔Web run has been made against this
/// driver.
final class WebRTCLinkReplacementTransportTests: XCTestCase {

    private let peer = "peer-b"

    /// A clock the test moves by hand, so "this event reached the queue after
    /// the deadline had passed" is an assertion rather than a sleep.
    private final class TestClock {
        private let lock = NSLock()
        private var value: TimeInterval = 0
        var now: TimeInterval {
            get { lock.withLock { value } }
            set { lock.withLock { value = newValue } }
        }
    }

    /// A clock that reads `before` for its first `readingsBeforeJump` readings
    /// and `after` from then on — the only way to land a deadline INSIDE an
    /// asynchronous WebRTC completion from outside it. The driver states and
    /// keeps a one-reading-per-event-boundary rule, so the k-th reading IS the
    /// k-th boundary; each test names the boundaries it counts.
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

    // MARK: - harness

    private func codecs() -> LinkCodecs {
        LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                   recvKey: [UInt8](repeating: 2, count: 32))
    }

    private func identity(role: Role = .initiator,
                          codecs: LinkCodecs? = nil) -> LinkIdentity {
        LinkIdentity(peerId: peer,
                     role: role,
                     sas: "482913",
                     codecs: codecs ?? self.codecs(),
                     authenticationGeneration: 4)
    }

    private func harness(
        role: Role = .initiator,
        identity: LinkIdentity? = nil,
        deadlines: LinkDeadlines = LinkDeadlines(),
        clock: TestClock? = nil,
        now: (() -> TimeInterval)? = nil
    ) -> (FakeWebSocketChannel, SignalingClient, LinkIdentity, WebRTCLinkReplacementTransport) {
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        let existing = identity ?? self.identity(role: role)
        let transport = WebRTCLinkReplacementTransport(
            signaling: signaling,
            identity: existing,
            iceServers: [],
            deadlines: deadlines,
            now: now
                ?? clock.map { clock in { clock.now } }
                ?? { ProcessInfo.processInfo.systemUptime })
        return (channel, signaling, existing, transport)
    }

    /// Flushes the transport's private queue: every public accessor runs on it,
    /// so returning from one means everything queued earlier has run.
    private func drain(_ transport: WebRTCLinkReplacementTransport) {
        _ = transport.bufferedAmount(on: .file)
    }

    private func newPeerConnection() throws -> RTCPeerConnection {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        return try XCTUnwrap(RTCPeerConnectionFactory().peerConnection(
            with: RTCConfiguration(), constraints: constraints, delegate: nil))
    }

    private func candidate(_ address: String = "10.0.0.1") -> RTCIceCandidate {
        RTCIceCandidate(sdp: "candidate:1 1 udp 1 \(address) 5 typ host",
                        sdpMLineIndex: 0,
                        sdpMid: "0")
    }

    /// A real offer carrying both lanes, from a throwaway PeerConnection. A
    /// hand-written SDP would be refused by `setRemoteDescription`, and a
    /// transport that fails on a malformed description cannot show whether it
    /// was on the clock.
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

    /// Everything this side put on the signalling socket, decoded.
    private func outbound(_ channel: FakeWebSocketChannel) -> [JSONValue] {
        channel.sent.compactMap { text in
            guard let data = text.data(using: .utf8),
                  let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else {
                return nil
            }
            return envelope.data
        }
    }

    private func waitFor(_ channel: FakeWebSocketChannel,
                         _ description: String,
                         _ matches: @escaping (JSONValue) -> Bool) {
        let seen = expectation(description: description)
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(8)
            while Date() < deadline {
                if self.outbound(channel).contains(where: matches) {
                    seen.fulfill()
                    return
                }
                usleep(20_000)
            }
        }
        wait(for: [seen], timeout: 10)
    }

    private func settle(_ seconds: TimeInterval = 0.3) {
        let settled = expectation(description: "settled")
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { settled.fulfill() }
        wait(for: [settled], timeout: seconds + 3)
    }

    private func isSDP(_ kind: String) -> (JSONValue) -> Bool {
        { parseSDP($0)?.type == kind }
    }

    private func isCandidate(_ signal: JSONValue) -> Bool { parseICE(signal) != nil }

    private func fields(_ signal: JSONValue) -> [String: JSONValue] {
        guard case let .object(o) = signal else { return [:] }
        return o
    }

    // MARK: - what leaves this side

    /// Every outbound signal is on the `resume` generation and carries a tag
    /// this link's peer — and only this link's peer — can verify. There is no
    /// commit/reveal here, so that tag is the whole of what stops a signalling
    /// relay offering its own replacement transport.
    func testEveryOutboundSignalIsSignedOnTheResumeGeneration() throws {
        let (channel, _, existing, transport) = harness(role: .initiator)
        defer { transport.close() }

        transport.start()
        waitFor(channel, "the offer was sent", isSDP("offer"))
        settle()

        let sent = outbound(channel)
        XCTAssertFalse(sent.isEmpty)
        for signal in sent {
            XCTAssertEqual(signalGeneration(signal), .resume, "\(signal) is not tagged as a rebuild")
            XCTAssertTrue(resumeSignalIsAuthentic(signal, key: existing.codecs.resumeAuthKey),
                          "\(signal) is not signed by this link")
        }
        XCTAssertTrue(sent.contains(where: isSDP("offer")))
    }

    /// A foreign key must not verify what this transport sends, which is the
    /// same assertion from the attacker's side: possession of the link's keys is
    /// what the tag proves.
    func testNoOutboundSignalVerifiesUnderAForeignKey() throws {
        let (channel, _, _, transport) = harness(role: .initiator)
        defer { transport.close() }
        let foreign = LinkCodecs(sendKey: [UInt8](repeating: 8, count: 32),
                                 recvKey: [UInt8](repeating: 9, count: 32)).resumeAuthKey

        transport.start()
        waitFor(channel, "the offer was sent", isSDP("offer"))
        settle()

        for signal in outbound(channel) {
            XCTAssertFalse(resumeSignalIsAuthentic(signal, key: foreign))
        }
    }

    /// A replacement inherits its authentication. It commits to nothing, reveals
    /// nothing, announces no capability and never emits a SAS — every one of
    /// those would be this transport claiming to establish trust it was handed.
    func testNothingCryptographicOrCapabilityBearingIsEverEmitted() throws {
        let (channel, _, _, transport) = harness(role: .initiator)
        defer { transport.close() }

        transport.start()
        waitFor(channel, "the offer was sent", isSDP("offer"))
        settle()

        for signal in outbound(channel) {
            XCTAssertNil(peerCommit(from: signal), "a replacement commits to nothing")
            XCTAssertNil(peerReveal(from: signal), "and discloses nothing")
            XCTAssertEqual(peerCaps(from: signal), [], "and announces no capability")
            XCTAssertFalse(fields(signal).keys.contains("link"))
            XCTAssertFalse(fields(signal).keys.contains("text"))
        }
        for text in channel.sent {
            XCTAssertFalse(text.contains(identity().sas),
                           "the six digits belong to the authentication, not to a rebuild")
        }
    }

    /// The initiator's offer precedes every candidate it gathered for it. A
    /// candidate that overtakes its description reaches a peer with no remote
    /// description and is dropped there — and on a LAN the ones gathered first
    /// are exactly the host candidates that would have made the link direct.
    func testNoLocalCandidateIsEverSentBeforeTheOffer() throws {
        let (channel, _, _, transport) = harness(role: .initiator)
        defer { transport.close() }

        transport.start()
        waitFor(channel, "the offer was sent", isSDP("offer"))
        settle()

        let sent = outbound(channel)
        let firstSDP = try XCTUnwrap(sent.firstIndex(where: isSDP("offer")))
        if let firstCandidate = sent.firstIndex(where: isCandidate) {
            XCTAssertGreaterThan(firstCandidate, firstSDP,
                                 "every candidate follows the description it belongs to")
        }
    }

    /// The same rule against a synthetic candidate, which is the only way to be
    /// sure the gate — rather than gathering latency — is what held it.
    func testALocalCandidateGeneratedBeforeTheDescriptionIsHeld() throws {
        let (channel, _, _, transport) = harness(role: .responder)
        defer { transport.close() }
        let pc = try newPeerConnection()
        defer { pc.close() }

        transport.peerConnection(pc, didGenerate: candidate())
        transport.peerConnection(pc, didGenerate: candidate("10.0.0.2"))
        drain(transport)

        XCTAssertTrue(outbound(channel).filter(isCandidate).isEmpty,
                      "nothing may precede the local description")
    }

    // MARK: - what this side will act on

    /// The genuine peer's signed offer is answered. Establishes that everything
    /// refused below is refused for its tag, not because this harness could
    /// never answer anything.
    func testAGenuineSignedOfferIsAnswered() throws {
        let (channel, _, existing, transport) = harness(role: .responder)
        defer { transport.close() }

        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer",
                                                  sdp: try realOfferSDP(),
                                                  key: existing.codecs.resumeAuthKey))
        waitFor(channel, "the responder answered", isSDP("answer"))
    }

    /// Missing, malformed, foreign-session and forged tags are all dropped in
    /// SILENCE — answering would tell a signalling relay which peer holds a live
    /// link — and none of them consumes the one remote offer this transport will
    /// ever apply. The genuine peer still arrives afterwards.
    func testUnauthenticatedOffersNeitherAnswerNorConsumeTheSlot() throws {
        let (channel, _, existing, transport) = harness(
            role: .responder,
            deadlines: LinkDeadlines(setupHardCap: 600, noProgress: 600, keyReveal: 600))
        defer { transport.close() }
        let key = existing.codecs.resumeAuthKey
        let foreignKey = LinkCodecs(sendKey: [UInt8](repeating: 8, count: 32),
                                    recvKey: [UInt8](repeating: 9, count: 32)).resumeAuthKey
        let sdp = try realOfferSDP()

        func rewriting(_ signal: JSONValue,
                       _ mutate: (inout [String: JSONValue]) -> Void) -> JSONValue {
            guard case var .object(o) = signal else { return signal }
            mutate(&o)
            return .object(o)
        }
        let genuine = resumeSDPSignal(kind: "offer", sdp: sdp, key: key)

        // No tag at all.
        transport.receive(from: peer, signal: rewriting(genuine) { $0["auth"] = nil })
        // A tag that is not a tag.
        transport.receive(from: peer, signal: rewriting(genuine) { $0["auth"] = .string("nope") })
        // Another link's key.
        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer", sdp: sdp, key: foreignKey))
        // A genuine tag over a description swapped in flight.
        transport.receive(from: peer, signal: rewriting(genuine) {
            $0["sdp"] = .object(["type": .string("offer"), "sdp": .string(sdp + "a=relay\r\n")])
        })
        // The right tag from the wrong peer.
        transport.receive(from: "somebody-else", signal: genuine)
        // The right tag on the wrong generation.
        transport.receive(from: peer,
                          signal: linkSDPSignal(kind: "offer", sdp: sdp,
                                                commit: "Y29tbWl0", caps: [LINK_CAPABILITY]))
        settle(0.4)

        XCTAssertTrue(outbound(channel).isEmpty,
                      "a rebuild answers nothing it cannot attribute to the peer")
        XCTAssertFalse(transport.isClosed, "and it does not end on one either")

        transport.receive(from: peer, signal: genuine)
        waitFor(channel, "the genuine peer still arrives", isSDP("answer"))
    }

    /// A rebuild is not an establishment: nothing a stranger can put on the
    /// socket ends one, and nothing a stranger can put on the socket starts its
    /// clock. A room is a broadcast surface shared with an establishment on the
    /// `link` generation and with the legacy file/text connections.
    func testAForeignSignalNeitherArmsTheDeadlineNorEndsTheTransport() throws {
        let (_, _, _, transport) = harness(role: .responder,
                                           deadlines: LinkDeadlines(setupHardCap: 0.05,
                                                                    noProgress: 0.05,
                                                                    keyReveal: 0.05))
        defer { transport.close() }
        var errors = 0
        var closes = 0
        transport.onError = { _ in errors += 1 }
        transport.onClose = { closes += 1 }

        transport.receive(from: "somebody-else", signal: linkBusySignal())
        transport.receive(from: peer, signal: linkBusySignal())
        transport.receive(from: peer, signal: taggedSignal(busySignal(), generation: .resume))
        transport.receive(from: peer, signal: linkRequestSignal())
        transport.receive(from: peer, signal: sdpSignal(kind: "offer", sdp: "v=0",
                                                        commit: nil, generation: .file))
        settle(0.5)
        drain(transport)

        XCTAssertEqual(errors, 0, "an inert signal is not a failure")
        XCTAssertEqual(closes, 0, "and it does not start a clock that then fires")
        XCTAssertFalse(transport.isClosed)
    }

    // MARK: - lanes

    /// Both exact lanes or nothing. A channel on any other label means the peer
    /// is not speaking `link/1` as this build understands it, and a link that
    /// degraded to one lane would be a link that cannot honour the protocol.
    func testAChannelOnAnyOtherLabelFailsTheRebuildClosed() throws {
        let (_, _, _, transport) = harness(role: .responder)
        let pc = try newPeerConnection()
        defer { pc.close() }
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        let config = RTCDataChannelConfiguration()
        config.isOrdered = true
        let stray = try XCTUnwrap(pc.dataChannel(forLabel: "data", configuration: config))
        transport.peerConnection(pc, didOpen: stray)

        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .unexpectedLane("data"))
    }

    /// A second channel on a label already held is a second SCTP producer on one
    /// receiver sequence — on a rebuild, a sequence that already exists.
    func testASecondChannelOnALaneAlreadyHeldFailsTheRebuildClosed() throws {
        let (_, _, _, transport) = harness(role: .responder)
        let pc = try newPeerConnection()
        defer { pc.close() }
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        let config = RTCDataChannelConfiguration()
        config.isOrdered = true
        transport.peerConnection(pc, didOpen: try XCTUnwrap(
            pc.dataChannel(forLabel: LINK_FILE_CHANNEL, configuration: config)))
        transport.peerConnection(pc, didOpen: try XCTUnwrap(
            pc.dataChannel(forLabel: LINK_FILE_CHANNEL, configuration: config)))

        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .duplicateLane(LINK_FILE_CHANNEL))
    }

    /// A rebuild whose second lane never finishes DCEP is a rebuild that cannot
    /// publish, and it must end by itself rather than hold an authentication
    /// open forever.
    func testALaneThatNeverOpensEndsOnTheHardCap() throws {
        let (_, _, _, transport) = harness(role: .responder,
                                           deadlines: LinkDeadlines(setupHardCap: 0.1,
                                                                    noProgress: 30,
                                                                    keyReveal: 30))
        let pc = try newPeerConnection()
        defer { pc.close() }
        var reported: LinkTransportError?
        let failed = expectation(description: "timed out")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        let config = RTCDataChannelConfiguration()
        config.isOrdered = true
        transport.peerConnection(pc, didOpen: try XCTUnwrap(
            pc.dataChannel(forLabel: LINK_FILE_CHANNEL, configuration: config)))

        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .establishmentTimeout(.setup))
    }

    // MARK: - deadlines

    /// A rebuild that never hears from its peer ends by itself. Nothing above
    /// this driver is wired yet, so a candidate transport with no owner watching
    /// it would otherwise sit inert forever.
    func testARebuildThatNeverProgressesFailsOnTheNoProgressDeadline() {
        let (_, _, _, transport) = harness(role: .responder,
                                           deadlines: LinkDeadlines(setupHardCap: 30,
                                                                    noProgress: 0.05,
                                                                    keyReveal: 30))
        var reported: LinkTransportError?
        let failed = expectation(description: "timed out")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertTrue(transport.isClosed)
    }

    func testTheHardCapEndsARebuildEvenWithoutTheNoProgressDeadline() {
        let (_, _, _, transport) = harness(role: .responder,
                                           deadlines: LinkDeadlines(setupHardCap: 0.05,
                                                                    noProgress: 30,
                                                                    keyReveal: 30))
        var reported: LinkTransportError?
        let failed = expectation(description: "timed out")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .establishmentTimeout(.setup))
    }

    /// A rebuild has no key-reveal phase — its identity existed before its
    /// PeerConnection did — so `.keyReveal` must never be the reason one ends.
    func testARebuildNeverReportsTheKeyRevealDeadline() {
        let (_, _, _, transport) = harness(role: .responder,
                                           deadlines: LinkDeadlines(setupHardCap: 30,
                                                                    noProgress: 0.05,
                                                                    keyReveal: 0.05))
        var reported: LinkTransportError?
        let failed = expectation(description: "timed out")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .establishmentTimeout(.noProgress),
                       "a rebuild waits for a transport, never for a reveal")
    }

    /// The signal that arms the clock is the first one this rebuild will
    /// actually act on — an inbound offer can precede any `start()`.
    func testTheGenuineOfferArmsTheDeadlineWithoutStart() throws {
        let (_, _, existing, transport) = harness(role: .responder,
                                                  deadlines: LinkDeadlines(setupHardCap: 0.1,
                                                                           noProgress: 30,
                                                                           keyReveal: 30))
        var reported: LinkTransportError?
        let failed = expectation(description: "timed out")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer",
                                                  sdp: try realOfferSDP(),
                                                  key: existing.codecs.resumeAuthKey))
        wait(for: [failed], timeout: 5)
        XCTAssertEqual(reported, .establishmentTimeout(.setup))
    }

    /// A `DispatchWorkItem` is not a promise about time. The wake-up can be
    /// queued behind a client callback that ran long, or behind a device that
    /// suspended, so an event can be served after the bound it was racing is
    /// gone. Acting on it would extend a rebuild that had already lost.
    ///
    /// The clock here moves without the wake-up ever firing: it is scheduled a
    /// hundred real seconds out and this test never waits for it.
    func testASignalServedAfterItsDeadlineFailsClosedInsteadOfAnswering() throws {
        let clock = TestClock()
        let (channel, _, existing, transport) = harness(
            role: .responder,
            deadlines: LinkDeadlines(setupHardCap: 600, noProgress: 100, keyReveal: 600),
            clock: clock)
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        drain(transport)
        clock.now = 200

        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer",
                                                  sdp: try realOfferSDP(),
                                                  key: existing.codecs.resumeAuthKey))
        wait(for: [failed], timeout: 5)

        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertTrue(outbound(channel).filter(isSDP("answer")).isEmpty,
                      "an expired rebuild does not answer")
    }

    /// Repeated hostile signals must not buy unbounded progress. Only what the
    /// closed `LinkMilestone` set admits extends anything, and a signal this
    /// rebuild refuses is not in it — so the hard cap arrives on schedule no
    /// matter how many arrive.
    func testAFloodOfRefusedSignalsBuysNoTime() throws {
        let (_, _, _, transport) = harness(role: .responder,
                                           deadlines: LinkDeadlines(setupHardCap: 0.4,
                                                                    noProgress: 0.4,
                                                                    keyReveal: 0.4))
        let foreignKey = LinkCodecs(sendKey: [UInt8](repeating: 8, count: 32),
                                    recvKey: [UInt8](repeating: 9, count: 32)).resumeAuthKey
        var reported: LinkTransportError?
        let failed = expectation(description: "timed out anyway")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        for i in 0..<200 {
            transport.receive(from: peer,
                              signal: resumeSDPSignal(kind: "offer", sdp: "v=\(i)", key: foreignKey))
        }
        wait(for: [failed], timeout: 5)
        XCTAssertNotNil(reported)
    }

    /// Producing an offer is asynchronous, and its completion comes back on the
    /// queue the wake-up was waiting for. Reading 1 is `start`'s own arming, so
    /// the clock is already past the no-progress deadline by the time the offer
    /// returns — without the wake-up (a hundred seconds out) ever firing.
    func testAnOfferCompletedAfterTheDeadlineNeverReachesTheWire() {
        let clock = StepClock(after: 200, readingsBeforeJump: 1)
        let (channel, _, _, transport) = harness(
            role: .initiator,
            deadlines: LinkDeadlines(setupHardCap: 600, noProgress: 100, keyReveal: 600),
            now: { clock.now })
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.start()
        wait(for: [failed], timeout: 10)

        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertTrue(outbound(channel).isEmpty,
                      "an expired rebuild offers nothing and opens no candidate gate")
    }

    /// The same boundary in the responder's role. Reading 1 is the inbound
    /// signal's own boundary and reading 2 is `setRemoteDescription`'s
    /// completion, so the jump lands between the applied offer and the answer
    /// this transport was about to produce for it.
    func testAnAnswerCompletedAfterTheDeadlineNeverReachesTheWire() throws {
        let clock = StepClock(after: 200, readingsBeforeJump: 2)
        let (channel, _, existing, transport) = harness(
            role: .responder,
            deadlines: LinkDeadlines(setupHardCap: 600, noProgress: 100, keyReveal: 600),
            now: { clock.now })
        var reported: LinkTransportError?
        let failed = expectation(description: "failed closed")
        transport.onError = { reported = $0 as? LinkTransportError }
        transport.onClose = { failed.fulfill() }

        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer",
                                                  sdp: try realOfferSDP(),
                                                  key: existing.codecs.resumeAuthKey))
        wait(for: [failed], timeout: 10)

        XCTAssertEqual(reported, .establishmentTimeout(.noProgress))
        XCTAssertTrue(outbound(channel).isEmpty,
                      "an expired rebuild answers nothing and opens no candidate gate")
    }

    func testClosingCancelsThePendingDeadline() {
        let (_, _, _, transport) = harness(role: .responder,
                                           deadlines: LinkDeadlines(setupHardCap: 30,
                                                                    noProgress: 0.1,
                                                                    keyReveal: 30))
        var errors = 0
        var closes = 0
        transport.onError = { _ in errors += 1 }
        transport.onClose = { closes += 1 }

        transport.start()
        transport.close()
        settle(0.5)
        drain(transport)

        XCTAssertEqual(errors, 0, "a cancelled deadline reports nothing")
        XCTAssertEqual(closes, 1)
    }

    func testADroppedTransportDoesNotFireItsDeadline() {
        var closes = 0
        do {
            let (_, _, _, transport) = harness(role: .responder,
                                               deadlines: LinkDeadlines(setupHardCap: 30,
                                                                        noProgress: 0.1,
                                                                        keyReveal: 30))
            transport.onClose = { closes += 1 }
            transport.start()
            drain(transport)
        }
        settle(0.5)
        XCTAssertEqual(closes, 0)
    }

    // MARK: - the terminal path

    /// Teardown happens FIRST, so a failure callback cannot speak for a
    /// transport that is already gone.
    func testFailureCallbacksObserveAClosedTransport() throws {
        let (_, _, _, transport) = harness(role: .responder)
        let pc = try newPeerConnection()
        defer { pc.close() }
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

        transport.peerConnection(pc, didChange: RTCPeerConnectionState.failed)
        drain(transport)

        XCTAssertEqual(closedDuringError, true)
        XCTAssertEqual(sendError, .closed, "a send from onError is refused as closed, not as early")
        XCTAssertEqual(closedDuringClose, true)
        XCTAssertTrue(transport.isClosed)
    }

    /// One failure, one of each callback, in that order, and neither nested
    /// inside the other.
    func testOnErrorThenOnCloseFireExactlyOnceAndAreNotNested() throws {
        let (_, _, _, transport) = harness(role: .responder)
        let pc = try newPeerConnection()
        defer { pc.close() }
        var trace: [String] = []
        transport.onError = { _ in
            trace.append("error:enter")
            transport.close()
            trace.append("error:exit")
        }
        transport.onClose = { trace.append("close") }

        transport.peerConnection(pc, didChange: RTCPeerConnectionState.failed)
        transport.peerConnection(pc, didChange: RTCPeerConnectionState.failed)
        transport.close()
        drain(transport)

        XCTAssertEqual(trace, ["error:enter", "error:exit", "close"])
    }

    func testTheReportedFailureIsTheConnectionsOwnError() throws {
        let (_, _, _, transport) = harness(role: .responder)
        let pc = try newPeerConnection()
        defer { pc.close() }
        var reported: LinkTransportError?
        transport.onError = { reported = $0 as? LinkTransportError }

        transport.peerConnection(pc, didChange: RTCPeerConnectionState.failed)
        drain(transport)
        XCTAssertEqual(reported, .peerConnectionFailed)
    }

    func testAnExplicitCloseEmitsOnlyOnClose() {
        let (_, _, _, transport) = harness()
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

    /// By the time `close()` returns to a callback the transport is closed — not
    /// scheduled to be. A consumer that stops a rebuild must not then have the
    /// rest of it done for it.
    func testCloseFromInsideACallbackTakesEffectBeforeTheCallbackReturns() throws {
        let (_, _, _, transport) = harness(role: .responder)
        let pc = try newPeerConnection()
        defer { pc.close() }
        var closedImmediately: Bool?
        transport.onError = { _ in
            transport.close()
            closedImmediately = transport.isClosed
        }
        transport.peerConnection(pc, didChange: RTCPeerConnectionState.failed)
        drain(transport)
        XCTAssertEqual(closedImmediately, true)
    }

    /// Teardown gives the signalling slot back and clears it, so a later signal
    /// cannot reach a transport that has ended.
    func testCloseReleasesTheSignallingSlot() {
        let (_, signaling, _, transport) = harness()
        XCTAssertNotNil(signaling.onSignal)
        transport.close()
        drain(transport)
        XCTAssertNil(signaling.onSignal)
    }

    /// A closed transport says nothing more to the peer, whatever reaches it.
    func testNothingIsSentAfterClose() throws {
        let (channel, _, existing, transport) = harness(role: .responder)
        transport.close()
        drain(transport)
        channel.sent = []

        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer", sdp: try realOfferSDP(),
                                                  key: existing.codecs.resumeAuthKey))
        transport.peerConnection(try newPeerConnection(), didGenerate: candidate())
        settle(0.3)
        XCTAssertEqual(channel.sent, [])
    }

    // MARK: - sending

    /// A rebuild refuses to carry anything until BOTH lanes are open under the
    /// identity it inherited. Before that there is no transport to speak on.
    func testSendIsRefusedBeforePublication() {
        let (_, _, _, transport) = harness()
        defer { transport.close() }
        XCTAssertThrowsError(try transport.send([1], on: .file)) { error in
            XCTAssertEqual(error as? LinkTransportError, .notReady)
        }
        XCTAssertThrowsError(try transport.send([1], on: .text)) { error in
            XCTAssertEqual(error as? LinkTransportError, .notReady)
        }
    }

    func testSendIsRefusedAfterClose() {
        let (_, _, _, transport) = harness()
        transport.close()
        XCTAssertThrowsError(try transport.send([1], on: .file)) { error in
            XCTAssertEqual(error as? LinkTransportError, .closed)
        }
    }

    // MARK: - what this batch still does not do

    func testNeitherSupportConstantIsFlippedByThisBatch() {
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
        XCTAssertFalse(LINK_BUILD_SUPPORT)
    }
}
