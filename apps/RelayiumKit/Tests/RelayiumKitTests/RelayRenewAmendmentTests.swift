import XCTest
@testable import RelayiumKit

/// The rules the shared spec gained after the first Apple checkpoint, each
/// pinned against the behaviour it replaced.
///
/// `docs/protocol/relay-renew-v1.md` is read-only to this port and was amended
/// while this batch was in flight: §6.6 (the two peers do not commit together),
/// §7.2 (the margin's anchor, the retry backoff, and refusing a grant that does
/// not extend), and two §10 refusals. This suite is the Apple port catching up
/// to that amendment, and each test states the concrete wrong outcome the rule
/// exists to prevent.
final class RelayRenewAmendmentTests: XCTestCase {
    private let alice = "peer-a1b2c3"
    private let bob = "peer-d4e5f6"
    private let key = [UInt8](repeating: 0x2e, count: 32)

    private final class Conditions {
        var userData = true
        var liveGrant = true
    }
    private var conditions = Conditions()

    override func setUp() {
        super.setUp()
        conditions = Conditions()
    }

    private func sdp(ufrag: String) -> String {
        "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
            + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
            + "a=ice-ufrag:\(ufrag)\r\na=fingerprint:sha-256 AB:CD:EF:01\r\n"
            + "a=setup:actpass\r\na=mid:0\r\n"
    }

    private func candidate(ufrag: String, port: Int = 54321) -> String {
        "candidate:842163049 1 udp 1677729535 203.0.113.9 \(port) typ relay"
            + " raddr 0.0.0.0 rport 0 generation 0 ufrag \(ufrag) network-cost 999"
    }

    private func config(expiry: Int) -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:relay.example:3478"],
                                               username: "\(expiry):abc",
                                               credential: "zzz")])
    }

    private func engine(nonce: [UInt8] = [UInt8](repeating: 0x11, count: 16)) -> RelayRenewEngine {
        let conditions = self.conditions
        return RelayRenewEngine(selfId: alice, peerId: bob, role: .initiator,
                                baseline: relayRenewPin(sdp: sdp(ufrag: "AAAA")),
                                sign: { signResume(key: self.key, payload: $0) },
                                verify: { verifyResume(key: self.key, payload: $0, mac: $1) },
                                makeNonce: { nonce },
                                userDataIsRecent: { conditions.userData },
                                grantIsLive: { conditions.liveGrant })
    }

    private func peerSignal(_ message: RelayRenewMessage) -> RelayRenewEnvelope {
        RelayRenewEnvelope(message: message,
                           auth: signResume(key: key,
                                            payload: relayRenewPayload(message,
                                                                       from: bob, to: alice)))
    }

    private func peerProbe(type: RelayRenewProbeType, epoch: UInt32, round: UInt32,
                           nonce: [UInt8]) -> RelayRenewProbeFrame {
        let payload = relayRenewProbePayload(type: type, from: bob, to: alice,
                                             epoch: epoch, round: round, nonce: nonce)
        let tag = Data(base64Encoded: signResume(key: key, payload: payload))!
        return RelayRenewProbeFrame(type: type, epoch: epoch, round: round,
                                    nonce: nonce, tag: Array(tag))
    }

    private func probes(_ e: [RelayRenewEffect]) -> [RelayRenewProbeFrame] {
        e.compactMap {
            guard case let .sendProbeFrame(b) = $0 else { return nil }
            return parsedRelayRenewProbeFrame(b)
        }
    }
    private func commits(_ e: [RelayRenewEffect]) -> [UInt32] {
        e.compactMap { if case let .commit(r, _) = $0 { return r } else { return nil } }
    }
    private func signals(_ e: [RelayRenewEffect]) -> [RelayRenewMessage] {
        e.compactMap {
            guard case let .sendSignal(j) = $0 else { return nil }
            return parsedRelayRenewEnvelope(j)?.message
        }
    }
    private func rounds(_ e: [RelayRenewEffect]) -> [UInt32] {
        e.compactMap { if case let .requestRound(r, _) = $0 { return r } else { return nil } }
    }

    /// Drive one engine all the way to a commit.
    @discardableResult
    private func commit(_ e: RelayRenewEngine,
                        nonce: [UInt8] = [UInt8](repeating: 0x11, count: 16),
                        peerNonce: [UInt8]? = nil) -> [RelayRenewEffect] {
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config(expiry: 1_790_000_000)))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1)))
        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2"))))
        _ = e.remoteDescriptionApplied(epoch: 1, ok: true)
        if let peerNonce {
            _ = e.probeFrameReceived(peerProbe(type: .probe, epoch: 1, round: 1,
                                               nonce: peerNonce))
        }
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        return e.probeFrameReceived(peerProbe(type: .ack, epoch: 1, round: 1, nonce: nonce))
    }

    // MARK: - §6.6 the two peers do not commit together

    /// A committed epoch verifies a nonce it has NOT seen before.
    ///
    /// The case: this side's observation held and its own ack arrived, so it
    /// committed — but the peer's probe had not reached it yet, or every ack it
    /// sent was lost and the peer moved to a fresh nonce. Answering only from
    /// cache would leave that peer waiting, and it would keep an expiring
    /// deadline while this side believed the migration was shared.
    func testACommittedEpochVerifiesANonceItHadNotSeen() throws {
        let e = engine()
        XCTAssertEqual(commits(commit(e)), [1])
        XCTAssertFalse(e.isAttempting)

        let unseen = [UInt8](repeating: 0x77, count: 16)
        let answered = probes(e.probeFrameReceived(peerProbe(type: .probe, epoch: 1, round: 1,
                                                             nonce: unseen)))
        XCTAssertEqual(answered.count, 1, "a committed epoch must still answer the peer")
        XCTAssertEqual(answered.first?.type, .ack)
        XCTAssertEqual(answered.first?.nonce, unseen)
    }

    /// Those verifications are bounded, and a forgery buys none of them.
    func testTheCommittedEpochsVerificationBudgetIsBounded() {
        let e = engine()
        _ = commit(e)
        var answered = 0
        for i in 0..<40 {
            let nonce = [UInt8](repeating: UInt8(i % 251), count: 16)
            answered += probes(e.probeFrameReceived(peerProbe(type: .probe, epoch: 1, round: 1,
                                                              nonce: nonce))).count
        }
        XCTAssertEqual(answered, RENEW_PROBE_VERIFICATION_RESERVE,
                       "what is LEFT of this epoch's probe reservation — never a fresh eight")

        let forged = RelayRenewProbeFrame(type: .probe, epoch: 1, round: 1,
                                          nonce: [UInt8](repeating: 0x99, count: 16),
                                          tag: [UInt8](repeating: 0xEE, count: 32))
        XCTAssertTrue(probes(e.probeFrameReceived(forged)).isEmpty)
    }

    /// The budget is ONE per epoch, before and after commit (Fable
    /// clarification 3): verifications spent before committing are not given
    /// back afterwards.
    func testThePostCommitBudgetIsTheSameEpochsBudget() {
        let e = engine()
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config(expiry: 1_790_000_000)))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1)))
        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2"))))
        _ = e.remoteDescriptionApplied(epoch: 1, ok: true)
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        // Three distinct genuine probes BEFORE committing.
        for i in 0..<3 {
            XCTAssertEqual(probes(e.probeFrameReceived(
                peerProbe(type: .probe, epoch: 1, round: 1,
                          nonce: [UInt8](repeating: UInt8(0x40 + i), count: 16)))).count, 1)
        }
        XCTAssertEqual(commits(e.probeFrameReceived(
            peerProbe(type: .ack, epoch: 1, round: 1,
                      nonce: [UInt8](repeating: 0x11, count: 16)))), [1])
        // Exactly ONE probe verification is left to the committed epoch.
        var answered = 0
        for i in 0..<10 {
            answered += probes(e.probeFrameReceived(
                peerProbe(type: .probe, epoch: 1, round: 1,
                          nonce: [UInt8](repeating: UInt8(0x80 + i), count: 16)))).count
        }
        XCTAssertEqual(answered, RENEW_PROBE_VERIFICATION_RESERVE - 3)
    }

    /// A committed epoch cannot start a negotiation, move a deadline again, or
    /// be promoted back into an attempt.
    func testACommittedEpochStartsNothingAndCommitsNothingAgain() {
        let e = engine()
        _ = commit(e)
        let nonce = [UInt8](repeating: 0x11, count: 16)

        // A second ack for the same nonce must not commit twice.
        let again = e.probeFrameReceived(peerProbe(type: .ack, epoch: 1, round: 1, nonce: nonce))
        XCTAssertTrue(commits(again).isEmpty)
        XCTAssertTrue(probes(again).isEmpty, "an ack is not something a committed epoch answers")

        // Nor may a peer signal revive it.
        let revive = e.receive(peerSignal(.ready(epoch: 1, round: 1)))
        XCTAssertTrue(revive.isEmpty)
        XCTAssertFalse(e.isAttempting)
        XCTAssertTrue(commits(e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                                        sdp: sdp(ufrag: "NEW9"))))).isEmpty)
    }

    /// The window closes, and after it the epoch answers nothing.
    func testTheCommittedEpochStopsAnsweringWhenItsWindowCloses() {
        let e = engine()
        let committed = commit(e)
        XCTAssertTrue(committed.contains(.armTimer(.postCommitAck(epoch: 1),
                                                   after: RENEW_POST_COMMIT_ACK_MS)))

        _ = e.timerFired(.postCommitAck(epoch: 1))
        let unseen = [UInt8](repeating: 0x77, count: 16)
        XCTAssertTrue(probes(e.probeFrameReceived(peerProbe(type: .probe, epoch: 1, round: 1,
                                                            nonce: unseen))).isEmpty,
                      "the peer's own window cannot outlive this one")
    }

    /// After a commit, gathering does not stop — and every later candidate
    /// still belongs to the committed generation, so it keeps travelling
    /// SIGNED rather than falling back to the unauthenticated path.
    func testPostCommitTrickleStaysSignedUnderTheCommittedEpoch() throws {
        let e = engine()
        _ = commit(e)

        let late = signals(e.localCandidate(sdp: candidate(ufrag: "NEW1", port: 60001),
                                            sdpMid: "0", sdpMLineIndex: 0))
        XCTAssertEqual(late.count, 1, "a later candidate for this generation must still be sent")
        guard case let .ice(epoch, round, _, _, _, ufrag)? = late.first else {
            return XCTFail("it must be an ice message")
        }
        XCTAssertEqual(epoch, 1)
        XCTAssertEqual(round, 1)
        XCTAssertEqual(ufrag, "NEW1")

        // A candidate for the OLD generation is still dropped.
        XCTAssertTrue(e.localCandidate(sdp: candidate(ufrag: "AAAA"),
                                       sdpMid: "0", sdpMLineIndex: 0).isEmpty)
    }

    // MARK: - §7.2 the margin's anchor

    /// The margin is a fraction of the grant's LIFETIME, measured from the
    /// instant the boundary was installed.
    ///
    /// Measured from "now" it becomes a fraction of the shrinking remainder,
    /// and `remaining <= remaining / 3` is false for every positive remaining —
    /// so the attempt never fires until the deadline has already passed. Root
    /// reproduced exactly that against the shipped Web controller.
    func testTheMarginIsAFractionOfLifetimeAndNotOfTheRemainder() throws {
        let armedAt = Date(timeIntervalSince1970: 1_000_000)
        let hour = RelayDeadline(expiresAt: armedAt.addingTimeInterval(3600 + TURN_CLOCK_SKEW),
                                 deadlineAt: armedAt.addingTimeInterval(3600),
                                 warnAt: armedAt.addingTimeInterval(3300))
        let attemptAt = try XCTUnwrap(relayRenewAttemptAt(hour, armedAt: armedAt))
        XCTAssertEqual(attemptAt.timeIntervalSince(armedAt), 3000, accuracy: 0.001,
                       "a one-hour grant is renewed from 50 minutes in")

        // The same boundary, asked again five minutes before it expires. The
        // ANSWER MUST NOT MOVE: it is a property of the grant, not of when the
        // question was asked.
        let late = try XCTUnwrap(relayRenewAttemptAt(hour, armedAt: armedAt))
        XCTAssertEqual(late, attemptAt)

        // And an accelerated test credential still renews, from a third in.
        let short = RelayDeadline(expiresAt: armedAt.addingTimeInterval(60 + TURN_CLOCK_SKEW),
                                  deadlineAt: armedAt.addingTimeInterval(60),
                                  warnAt: armedAt)
        let quick = try XCTUnwrap(relayRenewAttemptAt(short, armedAt: armedAt))
        XCTAssertEqual(quick.timeIntervalSince(armedAt), 40, accuracy: 0.001,
                       "a 60-second credential is renewed from 40 seconds in")
    }

    /// A boundary already at or behind its anchor is never renewed.
    func testAGrantWithNothingLeftIsNeverRenewed() {
        let armedAt = Date(timeIntervalSince1970: 1_000_000)
        let spent = RelayDeadline(expiresAt: armedAt, deadlineAt: armedAt, warnAt: armedAt)
        XCTAssertNil(relayRenewAttemptAt(spent, armedAt: armedAt))
    }

    // MARK: - §7.2 the retry backoff

    /// A failed epoch waits before another is spent.
    ///
    /// Without this the trigger's own cadence burns all three of a round's
    /// epochs in milliseconds: `userDataMoved()` fires on every progress
    /// notice, so a transfer that is genuinely moving is the fastest way to
    /// spend the whole budget before the window has begun.
    func testAFailedEpochWaitsBeforeAnotherIsSpent() {
        let e = engine()
        _ = e.evaluate()
        XCTAssertEqual(e.currentEpoch, 1)

        let failed = e.timerFired(.epochHardCap(epoch: 1))
        XCTAssertTrue(failed.contains(.armTimer(.retryBackoff(epoch: 1),
                                                after: RENEW_RETRY_BACKOFF_MS)))

        // Every re-evaluation inside the backoff is refused — this is the
        // burst the bound exists for.
        for _ in 0..<50 { XCTAssertTrue(e.evaluate().isEmpty) }
        XCTAssertFalse(e.isAttempting)

        // And once it elapses, the next trigger works normally.
        _ = e.timerFired(.retryBackoff(epoch: 1))
        XCTAssertEqual(signals(e.evaluate()), [.prepare(epoch: 2)])
    }

    /// The backoff does not itself start an attempt: the next trigger decides,
    /// and it re-reads the activity clock when it does.
    func testTheBackoffElapsingStartsNothingByItself() {
        let e = engine()
        _ = e.evaluate()
        _ = e.timerFired(.epochHardCap(epoch: 1))
        let elapsed = e.timerFired(.retryBackoff(epoch: 1))
        XCTAssertTrue(elapsed.isEmpty)
        XCTAssertFalse(e.isAttempting)

        conditions.userData = false
        XCTAssertTrue(e.evaluate().isEmpty, "and an idle link still renews nothing")
    }

    /// The backoff bounds what THIS side starts, not what it consents to: a
    /// peer that has waited its own is still answered.
    func testTheBackoffDoesNotRefuseThePeersPrepare() {
        let e = engine()
        _ = e.evaluate()
        _ = e.timerFired(.epochHardCap(epoch: 1))
        XCTAssertTrue(e.evaluate().isEmpty)

        let effects = e.receive(peerSignal(.prepare(epoch: 2)))
        XCTAssertEqual(rounds(effects), [1])
        XCTAssertEqual(e.currentEpoch, 2)
    }

    /// Adopting a higher epoch is a REPLACEMENT, not a failure, so it does not
    /// start a backoff of its own.
    func testAdoptingAHigherEpochDoesNotStartABackoff() {
        let e = engine()
        _ = e.evaluate()
        let adopted = e.receive(peerSignal(.prepare(epoch: 4)))
        XCTAssertFalse(adopted.contains(.armTimer(.retryBackoff(epoch: 1),
                                                  after: RENEW_RETRY_BACKOFF_MS)))
        XCTAssertEqual(e.currentEpoch, 4)
    }

    // MARK: - §7.2 a grant must extend

    /// A grant that would move the boundary earlier, or not at all, is refused.
    func testOnlyAGrantThatExtendsTheBoundaryIsAccepted() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let current = RelayDeadline(expiresAt: now.addingTimeInterval(3600),
                                    deadlineAt: now.addingTimeInterval(3540),
                                    warnAt: now.addingTimeInterval(3240))
        let later = RelayDeadline(expiresAt: now.addingTimeInterval(7200),
                                  deadlineAt: now.addingTimeInterval(7140),
                                  warnAt: now.addingTimeInterval(6840))
        let earlier = RelayDeadline(expiresAt: now.addingTimeInterval(1800),
                                    deadlineAt: now.addingTimeInterval(1740),
                                    warnAt: now.addingTimeInterval(1440))

        XCTAssertTrue(relayRenewAdvancesDeadline(later, beyond: current))
        XCTAssertFalse(relayRenewAdvancesDeadline(earlier, beyond: current),
                       "retiring a live allocation for a shorter-lived one is worse than nothing")
        XCTAssertFalse(relayRenewAdvancesDeadline(current, beyond: current),
                       "an unchanged boundary is not an extension")
        XCTAssertTrue(relayRenewAdvancesDeadline(later, beyond: nil),
                      "with no boundary yet, any grant is an improvement")
    }

    // MARK: - §10 observation may not begin before BOTH descriptions

    /// Observation must not hold on this epoch's local description alone.
    ///
    /// With only the local one applied the connection can still be pairing this
    /// epoch's new local candidate against the PREVIOUS generation's remote
    /// one. That selection is real and it carries this epoch's ufrag, so a
    /// local-only check accepts it — and it proves nothing about the path the
    /// peer will actually use.
    func testObservationDoesNotHoldBeforeTheRemoteDescriptionIsApplied() {
        let e = engine()
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config(expiry: 1_790_000_000)))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1)))
        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))

        // This side's own description is applied; the peer's answer is not.
        let early = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        XCTAssertTrue(probes(early).isEmpty, "one description is not both")

        // Applying the answer releases the retained observation.
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2"))))
        let applied = e.remoteDescriptionApplied(epoch: 1, ok: true)
        let sent = probes(applied)
        XCTAssertEqual(sent.count, 1, "and now it may")
        XCTAssertEqual(sent.first?.type, .probe)
    }
}
