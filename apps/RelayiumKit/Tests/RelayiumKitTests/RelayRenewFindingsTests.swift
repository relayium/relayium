import XCTest
@testable import RelayiumKit

/// Regressions for the four defects root's Apple review reproduced (A2-A5).
///
/// Each test is written so it FAILS against the behaviour that was there
/// before, not merely so it passes now: the assertions are about the concrete
/// wrong outcome — a round requested on an idle link, a peer left waiting after
/// this side committed, an ack bought without an HMAC, a migration that hangs —
/// rather than about the shape of the fix.
final class RelayRenewFindingsTests: XCTestCase {
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

    private func sdp(ufrag: String, setup: String = "actpass") -> String {
        "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
            + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
            + "a=ice-ufrag:\(ufrag)\r\na=fingerprint:sha-256 AB:CD:EF:01\r\n"
            + "a=setup:\(setup)\r\na=mid:0\r\n"
    }

    private func candidate(ufrag: String) -> String {
        "candidate:842163049 1 udp 1677729535 203.0.113.9 54321 typ relay"
            + " raddr 0.0.0.0 rport 0 generation 0 ufrag \(ufrag) network-cost 999"
    }

    private func config(expiry: Int = 1_790_000_000) -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:relay.example:3478"],
                                               username: "\(expiry):abc",
                                               credential: "zzz")])
    }

    private func engine(role: Role = .initiator,
                        nonce: [UInt8] = [UInt8](repeating: 0x11, count: 16)) -> RelayRenewEngine {
        let conditions = self.conditions
        return RelayRenewEngine(selfId: alice,
                                peerId: bob,
                                role: role,
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

    private func peerProbe(type: RelayRenewProbeType,
                           epoch: UInt32,
                           round: UInt32,
                           nonce: [UInt8]) -> RelayRenewProbeFrame {
        let payload = relayRenewProbePayload(type: type, from: bob, to: alice,
                                             epoch: epoch, round: round, nonce: nonce)
        let tag = Data(base64Encoded: signResume(key: key, payload: payload))!
        return RelayRenewProbeFrame(type: type, epoch: epoch, round: round,
                                    nonce: nonce, tag: Array(tag))
    }

    private func rounds(_ effects: [RelayRenewEffect]) -> [UInt32] {
        effects.compactMap { if case let .requestRound(round, _) = $0 { return round } else { return nil } }
    }

    private func probes(_ effects: [RelayRenewEffect]) -> [RelayRenewProbeFrame] {
        effects.compactMap {
            guard case let .sendProbeFrame(bytes) = $0 else { return nil }
            return parsedRelayRenewProbeFrame(bytes)
        }
    }

    private func commits(_ effects: [RelayRenewEffect]) -> [UInt32] {
        effects.compactMap { if case let .commit(round, _) = $0 { return round } else { return nil } }
    }

    // MARK: - A2: an inbound prepare is consent, and consent is gated

    /// A valid, signed `prepare` from the peer must NOT make an idle link
    /// request a round.
    ///
    /// The tag proves the peer holds `resumeAuth`. It proves nothing about
    /// whether anybody is using THIS link, and a side that took the peer's word
    /// for it would spend a server issuance and apply a credential on a link
    /// that should be closing — from the side that was behaving.
    func testAValidSignedPrepareOnAnIdleLinkRequestsNoRound() {
        let e = engine()
        conditions.userData = false

        let effects = e.receive(peerSignal(.prepare(epoch: 1)))
        XCTAssertTrue(rounds(effects).isEmpty, "an idle link must not ask the server for a round")
        XCTAssertFalse(e.isAttempting, "and must not start an epoch")
        XCTAssertTrue(effects.isEmpty, "it answers nothing at all")
    }

    /// The same link, once sparse user data actually moves, consents normally.
    /// The gate is "is this link being used", not "has this link ever refused".
    func testTheSameLinkConsentsOnceUserDataMoves() {
        let e = engine()
        conditions.userData = false
        XCTAssertTrue(e.receive(peerSignal(.prepare(epoch: 1))).isEmpty)

        conditions.userData = true
        let effects = e.receive(peerSignal(.prepare(epoch: 2)))
        XCTAssertEqual(rounds(effects), [1])
        XCTAssertEqual(e.currentEpoch, 2, "it adopts the peer's epoch")
    }

    /// Inbound consent requires a LIVE grant but deliberately not this side's
    /// own margin: the two peers' expiries may legitimately differ, so a peer
    /// whose credential dies sooner is entitled to ask first.
    func testInboundConsentNeedsALiveGrantButNotThisSidesMargin() {
        let expired = engine()
        expired.evaluateIsIrrelevant()
        conditions.liveGrant = false
        XCTAssertTrue(expired.receive(peerSignal(.prepare(epoch: 1))).isEmpty,
                      "a side with no live grant renews nothing")

        conditions.liveGrant = true
        let e = engine()
        // No local margin has opened — nothing called `evaluate()` — and the
        // peer's prepare is still honoured.
        let effects = e.receive(peerSignal(.prepare(epoch: 1)))
        XCTAssertEqual(rounds(effects), [1])
    }

    /// Adopting a HIGHER epoch is the same act of consent, and is gated too.
    func testAdoptingAHigherEpochIsAlsoGated() {
        let e = engine()
        _ = e.evaluate()
        XCTAssertEqual(e.currentEpoch, 1)

        conditions.userData = false
        XCTAssertTrue(e.receive(peerSignal(.prepare(epoch: 5))).isEmpty)
        XCTAssertEqual(e.currentEpoch, 1, "an idle link does not follow the peer up")
    }

    // MARK: - A3: commit is local, so the peer must still converge

    /// After this side commits, the peer's bounded retransmits must still be
    /// answered.
    ///
    /// This is the asymmetric-commit defect: commit clears the attempt, and an
    /// engine that answered nothing afterwards would leave the peer
    /// retransmitting five times into silence and keeping its OLD deadline,
    /// while this side had renewed. The two ends would then disagree about when
    /// the link dies.
    func testTheAckSurvivesCommitSoTheePeerConverges() throws {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(nonce: nonce)
        reachProbing(e)

        // The peer probes first; this side acks it once observation holds.
        let peerNonce = [UInt8](repeating: 0xC3, count: 16)
        let peerFrame = peerProbe(type: .probe, epoch: 1, round: 1, nonce: peerNonce)
        _ = e.probeFrameReceived(peerFrame)
        let acks = probes(e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1")))
            .filter { $0.type == .ack }
        XCTAssertEqual(acks.count, 1)
        let originalAck = try XCTUnwrap(acks.first)

        // This side commits on the peer's ack for its OWN nonce.
        let committed = commits(e.probeFrameReceived(peerProbe(type: .ack, epoch: 1, round: 1,
                                                               nonce: nonce)))
        XCTAssertEqual(committed, [1])
        XCTAssertFalse(e.isAttempting)

        // The peer, which has not heard its ack, retransmits. It must still be
        // answered, with the SAME ack.
        let replayed = probes(e.probeFrameReceived(peerFrame))
        XCTAssertEqual(replayed.count, 1, "a post-commit retransmit must still be answered")
        XCTAssertEqual(replayed.first?.nonce, originalAck.nonce)
        XCTAssertEqual(replayed.first?.tag, originalAck.tag, "byte-identical, not recomputed")
    }

    /// The post-commit replay is bounded, grants nothing and moves no deadline.
    func testThePostCommitReplayIsBoundedAndGrantsNothing() {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(nonce: nonce)
        reachProbing(e)
        let peerNonce = [UInt8](repeating: 0xC3, count: 16)
        let peerFrame = peerProbe(type: .probe, epoch: 1, round: 1, nonce: peerNonce)
        _ = e.probeFrameReceived(peerFrame)
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        _ = e.probeFrameReceived(peerProbe(type: .ack, epoch: 1, round: 1, nonce: nonce))

        var served = 0
        for _ in 0..<20 {
            let effects = e.probeFrameReceived(peerFrame)
            XCTAssertTrue(commits(effects).isEmpty, "a replay never commits again")
            XCTAssertTrue(rounds(effects).isEmpty, "and never asks for a round")
            served += probes(effects).count
        }
        XCTAssertEqual(served, RENEW_PROBE_MAX_SENDS,
                       "exactly as many replays as a genuine peer can send")
    }

    /// "An exact duplicate of an already-verified frame" means the TAG too.
    ///
    /// The nonce travels in clear inside a frame anyone on the path can
    /// observe. Matching on it alone would let an observer buy unbounded ack
    /// SENDS with forged tags, entirely outside the per-epoch HMAC budget.
    func testASameNonceFrameWithAnAlteredTagIsNotADuplicate() {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(nonce: nonce)
        reachProbing(e)
        let peerNonce = [UInt8](repeating: 0xC3, count: 16)
        let genuine = peerProbe(type: .probe, epoch: 1, round: 1, nonce: peerNonce)
        _ = e.probeFrameReceived(genuine)
        XCTAssertEqual(probes(e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1")))
            .filter { $0.type == .ack }.count, 1)

        // Same nonce, one bit of the tag flipped. It is a forgery, so it goes
        // through the budgeted path, fails to verify, and is answered with
        // nothing.
        var forgedTag = genuine.tag
        forgedTag[0] ^= 0x01
        let forged = RelayRenewProbeFrame(type: .probe, epoch: 1, round: 1,
                                          nonce: peerNonce, tag: forgedTag)
        XCTAssertTrue(probes(e.probeFrameReceived(forged)).isEmpty,
                      "an altered tag is not an exact duplicate")

        // The genuine frame still replays from the cache, so the fix did not
        // cost the idempotence it exists for.
        XCTAssertEqual(probes(e.probeFrameReceived(genuine)).count, 1)
    }

    /// Forged same-nonce frames spend the HMAC budget rather than bypassing it.
    func testForgedSameNonceFramesAreBoundedByTheHMACBudget() {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(nonce: nonce)
        reachProbing(e)
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))

        let peerNonce = [UInt8](repeating: 0xC3, count: 16)
        var sends = 0
        for i in 0..<100 {
            let forged = RelayRenewProbeFrame(type: .probe, epoch: 1, round: 1,
                                              nonce: peerNonce,
                                              tag: [UInt8](repeating: UInt8(i % 251), count: 32))
            sends += probes(e.probeFrameReceived(forged)).count
        }
        XCTAssertEqual(sends, 0, "no forgery is ever answered")
    }

    // MARK: - A4: a selected-pair report may beat the local description

    /// `didChangeLocalCandidate` and `setLocalDescription`'s completion are
    /// independent asynchronous events. When the pair changes FIRST, the report
    /// must be retained and re-examined — otherwise observation never holds, no
    /// probe is ever sent, and the epoch hangs to its hard cap for no reason.
    func testASelectedCandidateThatBeatsTheLocalDescriptionIsNotLost() throws {
        let nonce = [UInt8](repeating: 0x11, count: 16)
        let e = engine(nonce: nonce)
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config()))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1)))

        // The pair change arrives BEFORE this epoch's descriptions are applied.
        let early = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        XCTAssertTrue(probes(early).isEmpty, "nothing can be decided yet")

        // Applying the LOCAL description alone is still not enough: spec §10
        // forbids observation before BOTH are applied.
        let local = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        XCTAssertTrue(probes(local).isEmpty, "one description is not both")

        // The answer completes the pair, and the retained report is re-examined
        // against it — no second pair change required, which is the whole point.
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2"))))
        let sent = probes(e.remoteDescriptionApplied(epoch: 1, ok: true))
        XCTAssertEqual(sent.count, 1, "the retained observation must produce the probe")
        XCTAssertEqual(sent.first?.type, .probe)
        XCTAssertEqual(sent.first?.nonce, nonce)

        XCTAssertEqual(commits(e.probeFrameReceived(peerProbe(type: .ack, epoch: 1, round: 1,
                                                              nonce: nonce))), [1])
    }

    /// A retained report for the WRONG generation still decides nothing. The
    /// candidate names its own generation, so retaining it is safe.
    func testARetainedReportForAnOldGenerationStillDoesNotHold() {
        let e = engine()
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config()))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1)))
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "AAAA"))

        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2"))))
        XCTAssertTrue(probes(e.remoteDescriptionApplied(epoch: 1, ok: true)).isEmpty,
                      "the old generation is still the old generation")
    }

    /// Only the LATEST report is retained: one slot, not a queue a peer's
    /// network churn could grow.
    func testOnlyTheLatestEarlyReportIsRetained() {
        let e = engine()
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config()))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1)))
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "NEW1"))
        _ = e.selectedLocalCandidate(sdp: candidate(ufrag: "AAAA"))

        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2"))))
        XCTAssertTrue(probes(e.remoteDescriptionApplied(epoch: 1, ok: true)).isEmpty,
                      "the latest report won, and it names the old one")
    }

    // MARK: - A5: what this platform actually advertises

    func testTheLinkOnlyHelloAdvertisesRenewalExactlyOnce() {
        XCTAssertEqual(linkOnlyCapabilities(linkRoomActive: true),
                       [LINK_CAPABILITY, RELAY_RENEW_CAPABILITY])
        XCTAssertEqual(linkOnlyCapabilities(linkRoomActive: false), [],
                       "a room that allows no link advertises nothing")
        XCTAssertEqual(linkOnlyCapsHello(linkRoomActive: true),
                       capsField([LINK_CAPABILITY, RELAY_RENEW_CAPABILITY]))
    }

    /// The hint is unsigned. It gates only which peer this side STARTS a renewal
    /// toward; an authenticated inbound `prepare` is honoured without it.
    func testRenewalDoesNotDependOnTheCapabilityHint() {
        let e = engine()
        // No capability was ever recorded for this peer, and consent still
        // works — the authenticated `prepare` is what counts.
        XCTAssertEqual(rounds(e.receive(peerSignal(.prepare(epoch: 1)))), [1])
        // Both hellos announce it now that the shared vector carries it.
        XCTAssertTrue(advertisedLinkCapabilities(linkRoomActive: true)
            .contains(RELAY_RENEW_CAPABILITY))
    }

    // MARK: - helpers

    private func reachProbing(_ e: RelayRenewEngine) {
        _ = e.evaluate()
        _ = e.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: 1,
                                             config: config()))
        _ = e.configurationApplied(epoch: 1, ok: true)
        _ = e.receive(peerSignal(.ready(epoch: 1, round: 1)))
        _ = e.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp(ufrag: "NEW1"))
        _ = e.receive(peerSignal(.sdp(epoch: 1, round: 1, sdpType: .answer,
                                      sdp: sdp(ufrag: "NEW2"))))
        _ = e.remoteDescriptionApplied(epoch: 1, ok: true)
    }
}

private extension RelayRenewEngine {
    /// Readability shim: this test is about the INBOUND path, and calling
    /// `evaluate()` here would only prove the outbound one.
    func evaluateIsIrrelevant() {}
}
