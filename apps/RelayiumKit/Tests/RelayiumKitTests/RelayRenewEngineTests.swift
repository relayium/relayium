import XCTest
@testable import RelayiumKit

/// `RelayRenewEngine` driven through complete migrations in BOTH roles, and
/// through every refusal in `relay-renew/1` §10.
///
/// The engine is the single place the protocol's rules live, so this is where
/// "the old deadline survives" is proved: `commit` is the only effect that may
/// move one, and every negative case below asserts its ABSENCE rather than
/// asserting some other effect's presence.
final class RelayRenewEngineTests: XCTestCase {
    private let alice = "peer-a1b2c3"
    private let bob = "peer-d4e5f6"
    private let key = [UInt8](repeating: 0x2e, count: 32)

    /// An SDP shaped like the fixture's baseline, with a nameable generation.
    private func sdp(ufrag: String, setup: String = "actpass", mids: [String] = ["0"]) -> String {
        var out = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
        for mid in mids {
            out += "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
            out += "a=ice-ufrag:\(ufrag)\r\n"
            out += "a=fingerprint:sha-256 AB:CD:EF:01\r\n"
            out += "a=setup:\(setup)\r\na=mid:\(mid)\r\n"
        }
        return out
    }

    private func candidate(ufrag: String, type: String = "relay", port: Int = 54321) -> String {
        "candidate:842163049 1 udp 1677729535 203.0.113.9 \(port) typ \(type)"
            + " raddr 0.0.0.0 rport 0 generation 0 ufrag \(ufrag) network-cost 999"
    }

    private func config(expiry: Int) -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:relay.example:3478"],
                                               username: "\(expiry):abc",
                                               credential: "zzz")])
    }

    /// One engine wired to a fixed nonce, so an ack can be constructed exactly.
    /// The two answers the engine asks for, movable from a test.
    private final class Conditions {
        var userData = true
        var liveGrant = true
    }

    private var conditions = Conditions()

    override func setUp() {
        super.setUp()
        conditions = Conditions()
    }

    private func engine(selfId: String,
                        peerId: String,
                        role: Role,
                        baseline: RelayRenewSDPPin? = nil,
                        nonce: [UInt8] = [UInt8](repeating: 0x11, count: 16)) -> RelayRenewEngine {
        let conditions = self.conditions
        return RelayRenewEngine(selfId: selfId,
                                peerId: peerId,
                                role: role,
                                baseline: baseline ?? relayRenewPin(sdp: sdp(ufrag: "AAAA")),
                                sign: { signResume(key: self.key, payload: $0) },
                                verify: { verifyResume(key: self.key, payload: $0, mac: $1) },
                                makeNonce: { nonce },
                                userDataIsRecent: { conditions.userData },
                                grantIsLive: { conditions.liveGrant })
    }

    /// A signed envelope as the PEER would have produced it.
    private func peerSignal(_ message: RelayRenewMessage,
                            from: String,
                            to: String) -> RelayRenewEnvelope {
        RelayRenewEnvelope(message: message,
                           auth: signResume(key: key,
                                            payload: relayRenewPayload(message,
                                                                       from: from, to: to)))
    }

    /// A control frame as the PEER would have produced it.
    private func peerProbe(type: RelayRenewProbeType,
                           from: String,
                           to: String,
                           epoch: UInt32,
                           round: UInt32,
                           nonce: [UInt8]) -> RelayRenewProbeFrame {
        let payload = relayRenewProbePayload(type: type, from: from, to: to,
                                             epoch: epoch, round: round, nonce: nonce)
        let tag = Data(base64Encoded: signResume(key: key, payload: payload))!
        return RelayRenewProbeFrame(type: type, epoch: epoch, round: round,
                                    nonce: nonce, tag: Array(tag))
    }

    // MARK: - effect inspection

    private func signals(_ effects: [RelayRenewEffect]) -> [RelayRenewMessage] {
        effects.compactMap {
            guard case let .sendSignal(json) = $0 else { return nil }
            return parsedRelayRenewEnvelope(json)?.message
        }
    }

    private func commits(_ effects: [RelayRenewEffect]) -> [(UInt32, ICEConfig)] {
        effects.compactMap {
            guard case let .commit(round, config) = $0 else { return nil }
            return (round, config)
        }
    }

    private func probes(_ effects: [RelayRenewEffect]) -> [RelayRenewProbeFrame] {
        effects.compactMap {
            guard case let .sendProbeFrame(bytes) = $0 else { return nil }
            return parsedRelayRenewProbeFrame(bytes)
        }
    }

    private func rounds(_ effects: [RelayRenewEffect]) -> [(UInt32, UInt32)] {
        effects.compactMap {
            guard case let .requestRound(round, rid) = $0 else { return nil }
            return (round, rid)
        }
    }

    private func has(_ effects: [RelayRenewEffect], _ match: (RelayRenewEffect) -> Bool) -> Bool {
        effects.contains(where: match)
    }

    // MARK: - a complete migration, as the initiator

    func testTheInitiatorMigratesAndCommitsOnlyOnTheThreeConditions() throws {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(selfId: alice, peerId: bob, role: .initiator, nonce: nonce)

        // The margin opens on a link that is carrying user data.
        var effects = e.evaluate()
        XCTAssertEqual(signals(effects), [.prepare(epoch: 1)])
        XCTAssertEqual(rounds(effects).map(\.0), [1], "the first renewal asks for round 1")
        XCTAssertTrue(has(effects) { $0 == .armTimer(.epochHardCap(epoch: 1),
                                                     after: RENEW_EPOCH_HARD_CAP_MS) })

        // The grant arrives. Applying it is not a migration and commits nothing.
        let fresh = config(expiry: 1_790_000_000)
        effects = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                                   config: fresh))
        XCTAssertEqual(effects, [.applyConfiguration(fresh, epoch: 1)])
        XCTAssertTrue(commits(effects).isEmpty)

        // `setConfiguration` succeeded: that is exactly what `ready` announces.
        effects = e.configurationApplied(epoch: 1, ok: true)
        XCTAssertEqual(signals(effects), [.ready(epoch: 1, round: 1)])
        XCTAssertTrue(commits(effects).isEmpty, "setConfiguration is not a commit")
        // No offer yet — the peer has not said it holds the same round.
        XCTAssertFalse(has(effects) { $0 == .createOffer(epoch: 1) })

        effects = e.receive(peerSignal(.ready(epoch: 1, round: 1), from: bob, to: alice))
        XCTAssertTrue(has(effects) { $0 == .createOffer(epoch: 1) })

        // The offer is applied locally and goes out signed, naming this epoch's
        // generation.
        effects = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        guard case let .sdp(_, _, type, _)? = signals(effects).first else {
            return XCTFail("the offer must be signed and sent")
        }
        XCTAssertEqual(type, .offer)

        // A local candidate naming the NEW generation is forwarded; one naming
        // the old generation is not.
        XCTAssertEqual(signals(e.localCandidate(sdp: candidate(ufrag: "NEW1"),
                                                sdpMid: "0", sdpMLineIndex: 0)).count, 1)
        XCTAssertTrue(e.localCandidate(sdp: candidate(ufrag: "AAAA"),
                                       sdpMid: "0", sdpMLineIndex: 0).isEmpty)
        XCTAssertTrue(e.localCandidate(sdp: "candidate:1 1 udp 1 1.2.3.4 1 typ host",
                                       sdpMid: "0", sdpMLineIndex: 0).isEmpty,
                      "a candidate with no nameable generation is dropped, not sent")

        // The answer.
        effects = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                            sdp: sdp(ufrag: "NEW2", setup: "actpass")),
                                       from: bob, to: alice))
        XCTAssertTrue(has(effects) { if case .applyRemoteDescription = $0 { return true }
                                     else { return false } })
        effects = e.remoteDescriptionApplied(epoch: 1, ok: true)
        XCTAssertTrue(has(effects) { $0 == .armTimer(.iceProbe(epoch: 1), after: RENEW_ICE_PROBE_MS) })
        XCTAssertTrue(commits(effects).isEmpty, "an applied answer is not a commit")

        // An ack BEFORE local observation holds commits nothing: there is no
        // nonce yet for it to match.
        effects = e.probeFrameReceived(peerProbe(type: .ack, from: bob, to: alice,
                                                 epoch: 1, round: 1, nonce: nonce))
        XCTAssertTrue(commits(effects).isEmpty, "an ack cannot precede observation")

        // Observation holds: the selected local candidate names THIS epoch.
        effects = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        let sent = probes(effects)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.type, .probe)
        XCTAssertEqual(sent.first?.nonce, nonce)
        XCTAssertTrue(commits(effects).isEmpty, "observation alone is not a commit")

        // And now the ack for this side's own fresh nonce. All three conditions.
        effects = e.probeFrameReceived(peerProbe(type: .ack, from: bob, to: alice,
                                                 epoch: 1, round: 1, nonce: nonce))
        let committed = commits(effects)
        XCTAssertEqual(committed.count, 1)
        XCTAssertEqual(committed.first?.0, 1)
        XCTAssertEqual(committed.first?.1, fresh,
                       "the deadline derives from the configuration actually received")
        XCTAssertFalse(e.isAttempting)
    }

    /// The responder never offers, and answers only what its established role
    /// entitles it to answer.
    func testTheResponderAnswersAndNeverOffers() throws {
        let e = engine(selfId: bob, peerId: alice, role: .responder)
        // The peer's prepare starts this side's attempt too.
        var effects = e.receive(peerSignal(.prepare(epoch: 1), from: alice, to: bob))
        XCTAssertEqual(signals(effects), [.prepare(epoch: 1)])
        XCTAssertEqual(rounds(effects).map(\.0), [1])

        let fresh = config(expiry: 1_790_000_000)
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1, config: fresh))
        effects = e.configurationApplied(epoch: 1, ok: true)
        XCTAssertEqual(signals(effects), [.ready(epoch: 1, round: 1)])

        // Both ready — and the responder still does NOT offer.
        effects = e.receive(peerSignal(.ready(epoch: 1, round: 1), from: alice, to: bob))
        XCTAssertFalse(has(effects) { $0 == .createOffer(epoch: 1) })
        XCTAssertTrue(has(effects) { $0 == .armTimer(.readyToAnswer(epoch: 1),
                                                     after: RENEW_READY_TO_ANSWER_MS) })

        // An "answer" aimed at a responder is refused: it is not the message
        // its role can receive.
        XCTAssertTrue(e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                                sdp: sdp(ufrag: "NEW1")),
                                           from: alice, to: bob)).isEmpty)

        effects = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .offer,
                                            sdp: sdp(ufrag: "NEW1")),
                                       from: alice, to: bob))
        XCTAssertTrue(has(effects) { if case .applyRemoteDescription = $0 { return true }
                                     else { return false } })
        effects = e.remoteDescriptionApplied(epoch: 1, ok: true)
        XCTAssertTrue(has(effects) { $0 == .createAnswer(epoch: 1) })
    }

    /// The two peers' initial expiries may legitimately differ, and EITHER
    /// side's trigger works. Here the responder's margin opens first.
    func testEitherSideMayTriggerTheRenewal() {
        let e = engine(selfId: bob, peerId: alice, role: .responder)
        let effects = e.evaluate()
        XCTAssertEqual(signals(effects), [.prepare(epoch: 1)],
                       "a responder may prepare; only the OFFER is role-bound")
    }

    // MARK: - activity

    /// The independent clock is the whole gate on asking at all.
    func testAnIdleLinkNeverAsksForARound() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        conditions.userData = false
        XCTAssertTrue(e.evaluate().isEmpty)
        XCTAssertFalse(e.isAttempting)
        // And the clock itself excludes everything spec §7.1 names.
        let clock = RelayRenewActivityClock()
        XCTAssertFalse(clock.isActive(at: 0), "a link that never carried user data is not active")
        clock.record(.fileAckProgress, at: 100)
        XCTAssertTrue(clock.isActive(at: 100 + RENEW_USER_DATA_WINDOW))
        XCTAssertFalse(clock.isActive(at: 100 + RENEW_USER_DATA_WINDOW + 1))
        // ACK progress with no byte volume at all still counts: there is
        // deliberately no minimum transfer floor.
        XCTAssertEqual(clock.lastUserData, 100)
    }

    /// The margin is a WINDOW. A transfer that starts partway through it makes
    /// the same idle link renewable, on the very next evaluation.
    func testUserDataInsideTheMarginMakesAPreviouslyIdleLinkRenewable() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        conditions.userData = false
        XCTAssertTrue(e.evaluate().isEmpty)
        conditions.userData = true
        let effects = e.evaluate()
        XCTAssertEqual(signals(effects), [.prepare(epoch: 1)])
    }

    // MARK: - epochs

    /// A higher valid authenticated prepare wins; a lower one is ignored; an
    /// equal one coalesces into ONE attempt.
    func testEpochAdoptionConvergesOnTheLargerAndCoalescesAtEquality() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        XCTAssertEqual(e.currentEpoch, 1)

        // Equal: simultaneous prepare, one attempt, nothing restarted.
        XCTAssertTrue(e.receive(peerSignal(.prepare(epoch: 1), from: bob, to: alice)).isEmpty)
        XCTAssertEqual(e.currentEpoch, 1)

        // Lower: ignored.
        XCTAssertTrue(e.receive(peerSignal(.prepare(epoch: 0), from: bob, to: alice)).isEmpty)
        XCTAssertEqual(e.currentEpoch, 1)

        // Higher: adopted, and the old epoch is voided with the old deadline
        // intact.
        let effects = e.receive(peerSignal(.prepare(epoch: 4), from: bob, to: alice))
        XCTAssertEqual(e.currentEpoch, 4)
        XCTAssertTrue(commits(effects).isEmpty)
        XCTAssertTrue(has(effects) { $0 == .epochEnded(epoch: 1, reason: .closed) })
    }

    /// A retry is a NEW, higher epoch, which is what makes the aborted
    /// attempt's signed messages unreplayable into it.
    func testARetryUsesAFreshEpochAndTheAbortedEpochsSignaturesAreDead() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        let old = peerSignal(.ready(epoch: 1, round: 1), from: bob, to: alice)
        _ = e.timerFired(.epochHardCap(epoch: 1))
        XCTAssertFalse(e.isAttempting)
        _ = e.timerFired(.retryBackoff(epoch: 1))

        _ = e.evaluate()
        XCTAssertEqual(e.currentEpoch, 2, "never reused")
        // The old epoch's perfectly valid signature does nothing in the retry.
        XCTAssertTrue(e.receive(old).isEmpty)
    }

    /// At most three MIGRATION epochs on one round — epochs that obtained a
    /// configuration — and a fourth is refused rather than retried forever.
    func testAFourthMigrationEpochOnOneRoundIsRefused() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        for attempt in 1...RENEW_MAX_EPOCHS_PER_ROUND {
            let epoch = UInt32(attempt)
            XCTAssertEqual(signals(e.evaluate()), [.prepare(epoch: epoch)], "epoch \(attempt)")
            // The server replays its cached round 1 each time: this side never
            // committed it, so it keeps asking for the SAME round.
            let granted = e.receive(grant: RelayRenewGrant(status: .granted, round: 1,
                                                           rid: epoch,
                                                           config: config(expiry: 1_790_000_000)))
            XCTAssertFalse(granted.isEmpty, "epoch \(attempt) obtains the configuration")
            _ = e.timerFired(.epochHardCap(epoch: epoch))
            _ = e.timerFired(.retryBackoff(epoch: epoch))
        }
        XCTAssertTrue(e.evaluate().isEmpty, "a fourth migration epoch on one round is refused")
    }

    /// Pre-grant failures do NOT spend the migration budget (Fable
    /// clarification 2): three transient refusals must not abandon a renewal
    /// whose margin still has minutes left. They have their own bound.
    func testPreGrantFailuresSpendTheirOwnBudgetAndItIsBounded() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        var started = 0
        for attempt in 1...(RENEW_MAX_PREGRANT_ATTEMPTS + 5) {
            let effects = e.evaluate()
            guard !effects.isEmpty else { break }
            started += 1
            let epoch = UInt32(attempt)
            _ = e.receive(grant: RelayRenewGrant(status: .unavailable, round: 1, rid: epoch,
                                                 reason: "rate"))
            _ = e.timerFired(.retryBackoff(epoch: epoch))
        }
        XCTAssertGreaterThan(started, RENEW_MAX_EPOCHS_PER_ROUND,
                             "three refusals are not the end of the renewal")
        XCTAssertEqual(started, RENEW_MAX_PREGRANT_ATTEMPTS, "and it is still a bound")
    }

    // MARK: - the server exchange

    /// `denied` is terminal for that round, mints no configuration, and leaves
    /// the deadline alone.
    func testADeniedRoundIsTerminalAndMintsNothing() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        let effects = e.receive(grant: RelayRenewGrant(status: .denied, round: 1, rid: 1,
                                                       relayDenied: "quota", reason: "quota"))
        XCTAssertTrue(commits(effects).isEmpty)
        XCTAssertFalse(has(effects) { if case .applyConfiguration = $0 { return true }
                                      else { return false } })
        XCTAssertEqual(signals(effects), [.abort(epoch: 1, reason: .denied)])
        // And no later attempt asks for that round again.
        XCTAssertTrue(e.evaluate().isEmpty)
    }

    /// `unavailable` does not advance issuance and permits a bounded retry.
    func testUnavailableEndsTheEpochButNotTheRound() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        let effects = e.receive(grant: RelayRenewGrant(status: .unavailable, round: 1, rid: 1))
        XCTAssertEqual(signals(effects), [.abort(epoch: 1, reason: .unavailable)])
        XCTAssertTrue(commits(effects).isEmpty)
        _ = e.timerFired(.retryBackoff(epoch: 1))
        XCTAssertEqual(rounds(e.evaluate()).map(\.0), [1],
                       "issuance did not advance, so the retry asks for the same round")
    }

    /// A `stale` reply resynchronises to the round the server reports and
    /// re-asks for it — once, and only when the report moves this side forward,
    /// so two clients cannot trade re-asks forever.
    func testStaleResynchronisesOnceAndCannotLoop() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        var effects = e.receive(grant: RelayRenewGrant(status: .stale, round: 5, rid: 1))
        XCTAssertEqual(rounds(effects).map(\.0), [5])
        XCTAssertEqual(e.currentInstalledRound, 0, "a round is installed by COMMIT, not by hearsay")
        // A second stale — even correctly correlated — buys nothing more.
        effects = e.receive(grant: RelayRenewGrant(status: .stale, round: 7, rid: 2))
        XCTAssertTrue(rounds(effects).isEmpty, "one resynchronisation per epoch")
    }

    /// `stale 0` means nothing was ever issued: there is no cache to fetch, so
    /// the client stops. It never asks for round 0 and never spins.
    func testStaleZeroEndsTheEpochAndNeverAsksForRoundZero() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        let effects = e.receive(grant: RelayRenewGrant(status: .stale, round: 0, rid: 1))
        XCTAssertTrue(rounds(effects).isEmpty)
        XCTAssertFalse(e.isAttempting)
        XCTAssertTrue(commits(effects).isEmpty)
    }

    /// A reply is this epoch's business only if it answers the request this
    /// epoch is waiting on: wrong rid, or the right rid for the wrong round.
    func testUncorrelatedRepliesAreIgnored() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        let fresh = config(expiry: 1_790_000_000)
        XCTAssertTrue(e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 99,
                                                       config: fresh)).isEmpty, "wrong rid")
        XCTAssertTrue(e.receive(grant: RelayRenewGrant(status: .granted, round: 2, rid: 1,
                                                       config: fresh)).isEmpty, "wrong round")
        XCTAssertTrue(e.receive(grant: RelayRenewGrant(status: .denied, round: 1, rid: 99)).isEmpty)
        XCTAssertTrue(e.isAttempting, "none of them touched the epoch")
        XCTAssertFalse(e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                                        config: fresh)).isEmpty)
    }

    /// Server silence is `unavailable`, never a blind retry past the old
    /// deadline: nothing here produces a request without an epoch to carry it.
    func testTheServerNeverGetsARequestWithoutALiveEpoch() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        _ = e.timerFired(.epochHardCap(epoch: 1))
        // A grant that arrives after the epoch died is inert.
        let late = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                                    config: config(expiry: 1_790_000_000)))
        XCTAssertTrue(late.isEmpty, "a dropped epoch's grant reaches nothing")
    }

    // MARK: - pinning

    /// A remote description that moves the DTLS peer, the media shape or the
    /// answering role is refused, and the OLD deadline stands.
    func testHostileRemoteDescriptionsAreRefusedAndKeepTheOldDeadline() throws {
        func reach(_ e: RelayRenewEngine) {
            _ = e.evaluate()
            _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                                 config: config(expiry: 1_790_000_000)))
            _ = e.configurationApplied(epoch: 1, ok: true)
            _ = e.receive(peerSignal(.ready(epoch: 1, round: 1), from: bob, to: alice))
            _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        }

        let baseline = relayRenewPin(sdp: sdp(ufrag: "AAAA", setup: "active"))
        let cases: [(String, String)] = [
            ("a foreign fingerprint",
             "v=0\r\nm=application 9 x\r\na=ice-ufrag:NEW2\r\n"
                + "a=fingerprint:sha-256 99:88:77:66\r\na=setup:active\r\na=mid:0\r\n"),
            ("an added m-line", sdp(ufrag: "NEW2", setup: "active", mids: ["0", "1"])),
            ("a flipped answer role", sdp(ufrag: "NEW2", setup: "passive")),
            ("no nameable generation",
             "v=0\r\nm=application 9 x\r\na=fingerprint:sha-256 AB:CD:EF:01\r\n"
                + "a=setup:active\r\na=mid:0\r\n"),
        ]
        for (label, hostile) in cases {
            let e = engine(selfId: alice, peerId: bob, role: .initiator, baseline: baseline)
            reach(e)
            let effects = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                                    sdp: hostile),
                                               from: bob, to: alice))
            XCTAssertTrue(commits(effects).isEmpty, label)
            XCTAssertFalse(has(effects) { if case .applyRemoteDescription = $0 { return true }
                                          else { return false } },
                           "\(label) must never reach setRemoteDescription")
            XCTAssertEqual(signals(effects), [.abort(epoch: 1, reason: .sdp)], label)
        }

        // The legitimate case still passes: same identity, NEW ufrag, and the
        // answer keeps its role.
        let e = engine(selfId: alice, peerId: bob, role: .initiator, baseline: baseline)
        reach(e)
        let ok = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                           sdp: sdp(ufrag: "NEW2", setup: "active")),
                                      from: bob, to: alice))
        XCTAssertTrue(has(ok) { if case .applyRemoteDescription = $0 { return true }
                                else { return false } })
    }

    // MARK: - signatures and replay

    /// There is no unauthenticated branch, and a tag from the wrong key, the
    /// wrong direction or a different message buys nothing.
    func testHostileSignaturesAreRefusedInSilence() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()

        let wrongKey = RelayRenewEnvelope(
            message: .ready(epoch: 1, round: 1),
            auth: signResume(key: [UInt8](repeating: 0x99, count: 32),
                             payload: relayRenewPayload(.ready(epoch: 1, round: 1),
                                                        from: bob, to: alice)))
        XCTAssertTrue(e.receive(wrongKey).isEmpty)

        // This side's OWN outbound tag, reflected back at it. The payload it
        // verifies against is the reversed tuple, so it fails.
        let reflected = RelayRenewEnvelope(
            message: .prepare(epoch: 1),
            auth: signResume(key: key, payload: relayRenewPayload(.prepare(epoch: 1),
                                                                  from: alice, to: bob)))
        XCTAssertTrue(e.receive(reflected).isEmpty)
        XCTAssertFalse(e.suppressesUnsignedLinkSDP,
                       "no forged signal may flip the unsigned-SDP refusal")

        // A tag over a DIFFERENT message of the same shape.
        let swapped = RelayRenewEnvelope(
            message: .ready(epoch: 1, round: 2),
            auth: signResume(key: key, payload: relayRenewPayload(.ready(epoch: 1, round: 1),
                                                                  from: bob, to: alice)))
        XCTAssertTrue(e.receive(swapped).isEmpty)

        // And one genuine signal flips it, monotonically.
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1), from: bob, to: alice))
        XCTAssertTrue(e.suppressesUnsignedLinkSDP)
    }

    /// A probe or ack for another epoch, another round, or with a foreign tag
    /// is dropped — and the per-epoch HMAC budget bounds what a flood can spend.
    func testProbeVerificationIsBoundedAndHostileFramesAreDropped() throws {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(selfId: alice, peerId: bob, role: .initiator, nonce: nonce)
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config(expiry: 1_790_000_000)))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1), from: bob, to: alice))
        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2")), from: bob, to: alice))
        _ = e.remoteDescriptionApplied(epoch: 1, ok: true)
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))

        // Wrong epoch and wrong round are refused before any HMAC.
        XCTAssertTrue(e.probeFrameReceived(peerProbe(type: .probe, from: bob, to: alice,
                                                     epoch: 2, round: 1,
                                                     nonce: nonce)).isEmpty)
        XCTAssertTrue(e.probeFrameReceived(peerProbe(type: .probe, from: bob, to: alice,
                                                     epoch: 1, round: 9,
                                                     nonce: nonce)).isEmpty)

        // A flood of forged PROBES spends the probe reservation and nothing
        // else. Root reproduced the old shape — one pool of eight — letting
        // eight junk frames veto the one genuine ack that would have committed.
        for i in 0..<(RENEW_MAX_PROBE_VERIFICATIONS * 4) {
            let junk = RelayRenewProbeFrame(type: .probe, epoch: 1, round: 1,
                                            nonce: [UInt8](repeating: UInt8(i), count: 16),
                                            tag: [UInt8](repeating: 0xEE, count: 32))
            XCTAssertTrue(e.probeFrameReceived(junk).isEmpty, "forged probe \(i)")
        }
        // An ack for a nonce that is not this side's is dropped BEFORE any HMAC,
        // so it cannot touch the ack reservation however many arrive.
        for i in 0..<64 {
            let wrong = RelayRenewProbeFrame(type: .ack, epoch: 1, round: 1,
                                             nonce: [UInt8](repeating: UInt8(i + 100), count: 16),
                                             tag: [UInt8](repeating: 0xEE, count: 32))
            XCTAssertTrue(e.probeFrameReceived(wrong).isEmpty)
        }
        let genuine = e.probeFrameReceived(peerProbe(type: .ack, from: bob, to: alice,
                                                     epoch: 1, round: 1, nonce: nonce))
        XCTAssertEqual(commits(genuine).count, 1,
                       "probe junk must not be able to spend the ack's share")
    }

    /// The ack reservation is itself a hard cap: forged acks naming the RIGHT
    /// nonce (it travels in clear) spend it, and past it even a genuine ack is
    /// refused — the safe direction. The epoch times out; the deadline stands.
    func testTheAckReservationIsAHardCap() {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(selfId: alice, peerId: bob, role: .initiator, nonce: nonce)
        reachProbing(e)
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        for _ in 0..<RENEW_ACK_VERIFICATION_RESERVE {
            let forged = RelayRenewProbeFrame(type: .ack, epoch: 1, round: 1, nonce: nonce,
                                              tag: [UInt8](repeating: 0xEE, count: 32))
            XCTAssertTrue(e.probeFrameReceived(forged).isEmpty)
        }
        let genuine = e.probeFrameReceived(peerProbe(type: .ack, from: bob, to: alice,
                                                     epoch: 1, round: 1, nonce: nonce))
        XCTAssertTrue(commits(genuine).isEmpty)
        XCTAssertEqual(RENEW_PROBE_VERIFICATION_RESERVE + RENEW_ACK_VERIFICATION_RESERVE,
                       RENEW_MAX_PROBE_VERIFICATIONS, "one budget of eight, not eight each")
    }

    /// An ack must match THIS side's own current nonce.
    func testAnAckForSomebodyElsesNonceCommitsNothing() {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(selfId: alice, peerId: bob, role: .initiator, nonce: nonce)
        reachProbing(e)
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        let other = e.probeFrameReceived(peerProbe(type: .ack, from: bob, to: alice,
                                                   epoch: 1, round: 1,
                                                   nonce: [UInt8](repeating: 0x22, count: 16)))
        XCTAssertTrue(commits(other).isEmpty)
    }

    /// A verified probe arriving before observation holds is retained in a
    /// SINGLE slot, latest nonce wins, and acked once observation holds. A
    /// duplicate then gets the same ack idempotently, spending no HMAC.
    func testAnEarlyProbeIsHeldInOneSlotAndAckedIdempotently() throws {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        reachProbing(e)
        let first = [UInt8](repeating: 0xA1, count: 16)
        let latest = [UInt8](repeating: 0xB2, count: 16)
        XCTAssertTrue(probes(e.probeFrameReceived(peerProbe(type: .probe, from: bob, to: alice,
                                                            epoch: 1, round: 1,
                                                            nonce: first))).isEmpty)
        XCTAssertTrue(probes(e.probeFrameReceived(peerProbe(type: .probe, from: bob, to: alice,
                                                            epoch: 1, round: 1,
                                                            nonce: latest))).isEmpty)

        let onObserving = probes(e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1")))
        let acks = onObserving.filter { $0.type == .ack }
        XCTAssertEqual(acks.count, 1, "one slot, not a queue")
        XCTAssertEqual(acks.first?.nonce, latest, "latest nonce wins")

        // An exact duplicate reuses the cached ack.
        let duplicate = probes(e.probeFrameReceived(peerProbe(type: .probe, from: bob, to: alice,
                                                              epoch: 1, round: 1,
                                                              nonce: latest)))
        XCTAssertEqual(duplicate.count, 1)
        XCTAssertEqual(duplicate.first?.nonce, latest)
    }

    /// A probe retransmits the SAME nonce, on cadence, a bounded number of
    /// times.
    func testTheProbeRetransmitsOneNonceAtMostFiveTimes() {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(selfId: alice, peerId: bob, role: .initiator, nonce: nonce)
        reachProbing(e)
        var sends = probes(e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))).count
        for _ in 0..<10 {
            let effects = e.timerFired(.probeRetry(epoch: 1))
            let sent = probes(effects)
            XCTAssertTrue(sent.allSatisfy { $0.nonce == nonce }, "the same nonce, never a new one")
            sends += sent.count
        }
        XCTAssertEqual(sends, RENEW_PROBE_MAX_SENDS)
    }

    // MARK: - candidates

    /// Inbound candidates are keyed by the generation they name, released only
    /// with the description they belong to, and bounded.
    func testHeldInboundCandidatesAreGenerationKeyedAndBounded() throws {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config(expiry: 1_790_000_000)))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1), from: bob, to: alice))
        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))

        // Far more than the bound, half of them for a generation this epoch
        // will never apply.
        for i in 0..<(RENEW_MAX_HELD_CANDIDATES * 2) {
            let ufrag = i.isMultiple(of: 2) ? "NEW2" : "OLD9"
            _ = e.receive(peerSignal(.ice(epoch: 1, round: 1,
                                          candidate: candidate(ufrag: ufrag, port: 1000 + i),
                                          sdpMid: "0", sdpMLineIndex: 0,
                                          usernameFragment: ufrag),
                                     from: bob, to: alice))
        }
        // A candidate that names two generations at once is dropped outright.
        XCTAssertTrue(e.receive(peerSignal(.ice(epoch: 1, round: 1,
                                                candidate: candidate(ufrag: "NEW2"),
                                                sdpMid: nil, sdpMLineIndex: nil,
                                                usernameFragment: "OLD9"),
                                           from: bob, to: alice)).isEmpty)

        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2")), from: bob, to: alice))
        let released = e.remoteDescriptionApplied(epoch: 1, ok: true).filter {
            if case .addRemoteCandidate = $0 { return true } else { return false }
        }
        XCTAssertLessThanOrEqual(released.count, RENEW_MAX_HELD_CANDIDATES)
        XCTAssertGreaterThan(released.count, 0)
        for effect in released {
            guard case let .addRemoteCandidate(candidate, _, _) = effect else { continue }
            XCTAssertEqual(relayRenewCandidateUfrag(candidate: candidate), "NEW2",
                           "only this epoch's generation is released")
        }
    }

    /// A `prflx` selected local candidate cannot be attributed to a
    /// generation, so observation does not hold and the old deadline is kept.
    func testAnUnattributableSelectedCandidateMeansObservationDoesNotHold() {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(selfId: alice, peerId: bob, role: .initiator, nonce: nonce)
        reachProbing(e)
        let effects = e.selectedLocalCandidate(sdp: "candidate:1 1 udp 1 1.2.3.4 9 typ prflx")
        XCTAssertTrue(probes(effects).isEmpty)
        // And with no observation, even a genuine ack commits nothing.
        XCTAssertTrue(commits(e.probeFrameReceived(peerProbe(type: .ack, from: bob, to: alice,
                                                             epoch: 1, round: 1,
                                                             nonce: nonce))).isEmpty)
        // The epoch then simply runs out.
        let timeout = e.timerFired(.iceProbe(epoch: 1))
        XCTAssertTrue(commits(timeout).isEmpty)
        XCTAssertEqual(signals(timeout), [.abort(epoch: 1, reason: .timeout)])
    }

    // MARK: - timeouts, compatibility and teardown

    /// Every phase bound ends the epoch and preserves the old deadline.
    func testEveryPhaseTimeoutPreservesTheOldDeadline() {
        let bounds: [RelayRenewTimer] = [.prepareToReady(epoch: 1), .readyToAnswer(epoch: 1),
                                         .iceProbe(epoch: 1), .epochHardCap(epoch: 1)]
        for bound in bounds {
            let e = engine(selfId: alice, peerId: bob, role: .initiator)
            _ = e.evaluate()
            let effects = e.timerFired(bound)
            XCTAssertTrue(commits(effects).isEmpty, "\(bound)")
            XCTAssertEqual(signals(effects), [.abort(epoch: 1, reason: .timeout)], "\(bound)")
            XCTAssertFalse(e.isAttempting, "\(bound)")
        }
    }

    /// Two prepares about ten seconds apart with no reply means the peer does
    /// not implement renewal, for the remainder of this link.
    func testSilenceConcludesThePeerIsUnsupportedAndStopsTrying() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        let second = e.timerFired(.prepareSilence(epoch: 1))
        XCTAssertEqual(signals(second), [.prepare(epoch: 1)], "the same epoch, resent")
        XCTAssertFalse(e.peerIsUnsupported)

        let giveUp = e.timerFired(.prepareSilence(epoch: 1))
        XCTAssertTrue(has(giveUp) { $0 == .peerUnsupported })
        XCTAssertTrue(commits(giveUp).isEmpty)
        XCTAssertTrue(e.peerIsUnsupported)
        XCTAssertTrue(e.evaluate().isEmpty,
                      "an unsupported peer is not asked again")
    }

    /// A `link:§8` rebuild re-pins the baseline, voids an epoch that belonged
    /// to a connection that is gone, and does NOT reset the epoch counter.
    func testATransportRebuildVoidsTheEpochButNotTheCounter() {
        let e = engine(selfId: alice, peerId: bob, role: .initiator)
        _ = e.evaluate()
        let effects = e.transportRebuilt(baseline: relayRenewPin(sdp: sdp(ufrag: "ZZZZ")))
        XCTAssertTrue(commits(effects).isEmpty)
        XCTAssertFalse(e.isAttempting)
        // A rebuild voids the epoch, which is a failure of that epoch and
        // therefore starts the backoff like any other.
        _ = e.timerFired(.retryBackoff(epoch: 1))
        _ = e.evaluate()
        XCTAssertEqual(e.currentEpoch, 2, "the counter survives the rebuild")
    }

    /// Close is terminal, silent on the wire, and nothing later is accepted.
    func testCloseIsTerminalAndSendsNothing() {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(selfId: alice, peerId: bob, role: .initiator, nonce: nonce)
        reachProbing(e)
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        let closed = e.close()
        XCTAssertTrue(signals(closed).isEmpty, "a closing link does not write to a dead socket")
        XCTAssertTrue(commits(closed).isEmpty)
        // Every late callback is inert.
        XCTAssertTrue(e.probeFrameReceived(peerProbe(type: .ack, from: bob, to: alice,
                                                     epoch: 1, round: 1, nonce: nonce)).isEmpty)
        XCTAssertTrue(e.timerFired(.probeRetry(epoch: 1)).isEmpty)
        XCTAssertTrue(e.evaluate().isEmpty)
        XCTAssertTrue(e.close().isEmpty, "idempotent")
    }

    /// Two consecutive renewals on one link: epochs keep climbing, the round
    /// advances, and each commit derives its deadline from its OWN grant.
    func testRepeatedRenewalsKeepClimbingAndEachCommitUsesItsOwnConfiguration() throws {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(selfId: alice, peerId: bob, role: .initiator, nonce: nonce)
        var expiry = 1_790_000_000
        var seenEpochs: [UInt32] = []
        for round in UInt32(1)...UInt32(2) {
            expiry += 3600
            let fresh = config(expiry: expiry)
            _ = e.evaluate()
            let epoch = try XCTUnwrap(e.currentEpoch)
            seenEpochs.append(epoch)
            _ = e.receive(grant: RelayRenewGrant(status: .granted, round: round, rid: round,
                                                 config: fresh))
            _ = e.configurationApplied(epoch: epoch, ok: true)
            _ = e.receive(peerSignal(.ready(epoch: epoch, round: round), from: bob, to: alice))
            _ = e.localDescriptionApplied(epoch: epoch, type: .offer,
                                          sdp: sdp(ufrag: "GEN\(round)"))
            _ = e.receive(peerSignal(.sdp(epoch: epoch, round: round, sdpType: .answer,
                                          sdp: sdp(ufrag: "REM\(round)")), from: bob, to: alice))
            _ = e.remoteDescriptionApplied(epoch: epoch, ok: true)
            _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "GEN\(round)"))
            let committed = commits(e.probeFrameReceived(
                peerProbe(type: .ack, from: bob, to: alice,
                          epoch: epoch, round: round, nonce: nonce)))
            XCTAssertEqual(committed.count, 1, "round \(round)")
            XCTAssertEqual(committed.first?.1, fresh, "round \(round) uses its own grant")
        }
        XCTAssertEqual(seenEpochs, [1, 2])
        XCTAssertEqual(e.currentInstalledRound, 2)
    }

    /// Drive one engine to the point where a probe is possible.
    private func reachProbing(_ e: RelayRenewEngine) {
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config(expiry: 1_790_000_000)))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1), from: bob, to: alice))
        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2")), from: bob, to: alice))
        _ = e.remoteDescriptionApplied(epoch: 1, ok: true)
    }
}
