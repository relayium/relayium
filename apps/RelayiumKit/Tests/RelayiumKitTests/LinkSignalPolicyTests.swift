import XCTest
@testable import RelayiumKit

/// Which signals an initial `link/1` establishment will act on.
///
/// Every case here is a way a transport is talked into doing something for
/// somebody it should not be listening to — a peer that never confirmed the
/// protocol, a generation this build cannot honour, a second offer that would
/// replace the commitment the handshake is bound to.
final class LinkSignalPolicyTests: XCTestCase {

    private let peer = "peer-b"
    private let commit = "Y29tbWl0"          // base64, shape only; nothing here verifies it
    private let otherCommit = "b3RoZXI="

    private func policy(role: Role) -> LinkSignalPolicy {
        LinkSignalPolicy(peerId: peer, role: role)
    }

    private func offer(caps: [String] = [LINK_CAPABILITY],
                       commit: String? = nil,
                       sdp: String = "v=0-offer") -> JSONValue {
        linkSDPSignal(kind: "offer", sdp: sdp, commit: commit, caps: caps)
    }

    private func answer(caps: [String] = [LINK_CAPABILITY],
                        commit: String? = nil,
                        sdp: String = "v=0-answer") -> JSONValue {
        linkSDPSignal(kind: "answer", sdp: sdp, commit: commit, caps: caps)
    }

    private func ice(_ candidate: String = "candidate:1 1 udp 1 10.0.0.1 5 typ host") -> JSONValue {
        taggedSignal(iceSignal(candidate, sdpMid: "0", sdpMLineIndex: 0), generation: .link)
    }

    private func reveal(key: String = "a2V5", nonce: String = "bm9uY2U=") -> JSONValue {
        taggedSignal(revealField(Reveal(key: key, nonce: nonce)), generation: .link)
    }

    /// Drives a responder past its capability gate so ICE/reveal policy can be
    /// examined on its own.
    private func confirmedResponder() -> LinkSignalPolicy {
        let p = policy(role: .responder)
        XCTAssertEqual(p.plan(from: peer, signal: offer(commit: commit)),
                       [.recordPeerCommit(commit), .applyRemoteOffer("v=0-offer")])
        XCTAssertTrue(p.isPeerCapabilityConfirmed)
        return p
    }

    // MARK: - who and which generation

    func testSignalsFromAnyOtherPeerAreIgnored() {
        let p = policy(role: .responder)
        XCTAssertEqual(p.plan(from: "someone-else", signal: offer(commit: commit)), [])
        XCTAssertFalse(p.isPeerCapabilityConfirmed)
    }

    /// A room carries several independent generations. Only the exact `link`
    /// one is this transport's.
    func testOnlyTheExactLinkGenerationIsActedOn() {
        let p = policy(role: .responder)
        let untagged = sdpSignal(kind: "offer", sdp: "v=0", commit: commit, generation: .file,
                                 caps: [LINK_CAPABILITY])
        let text = sdpSignal(kind: "offer", sdp: "v=0", commit: commit, generation: .text,
                             caps: [LINK_CAPABILITY, TEXT_CAPABILITY])
        XCTAssertEqual(p.plan(from: peer, signal: untagged), [])
        XCTAssertEqual(p.plan(from: peer, signal: text), [])
    }

    /// `signalGeneration` ranks `resume` above `link`, so a signal carrying both
    /// flags is a rebuild. This slice implements no authenticated resume and
    /// must not answer one — see `LINK_TRANSPORT_REPLACEMENT_SUPPORTED`.
    func testResumeSignalsAreNeverAccepted() {
        let p = policy(role: .responder)
        let rebuild = taggedSignal(offer(commit: commit), generation: .resume)
        XCTAssertEqual(signalGeneration(rebuild), .resume)
        XCTAssertEqual(p.plan(from: peer, signal: rebuild), [])
        XCTAssertFalse(p.isPeerCapabilityConfirmed)
    }

    /// Admission's own vocabulary rides the same generation and must be inert
    /// here: answering a request or acting on a leave is the one-link rule's
    /// business, not a transport's.
    func testAdmissionSignalsAreInertForATransport() {
        let p = confirmedResponder()
        XCTAssertEqual(p.plan(from: peer, signal: linkRequestSignal()), [])
        XCTAssertEqual(p.plan(from: peer, signal: linkLeaveSignal(auth: String(repeating: "a", count: LINK_LEAVE_AUTH_LENGTH))), [])
    }

    // MARK: - busy

    /// Deliberately ahead of the capability gate: a busy carries no SDP and
    /// therefore no caps, and an initiator that has already offered would
    /// otherwise wait out its whole deadline for a refusal it was actually told.
    func testBusyFailsTheEstablishmentEvenBeforeAnySDP() {
        let p = policy(role: .initiator)
        XCTAssertEqual(p.plan(from: peer, signal: linkBusySignal()), [.fail(.peerBusy)])
    }

    // MARK: - exact capability on the first SDP

    func testAnSDPWithoutExactLinkCapabilityFailsClosed() {
        for caps in [[], ["link/2"], ["link"], ["link/1 "], ["text/1"], ["LINK/1"]] {
            let p = policy(role: .responder)
            XCTAssertEqual(p.plan(from: peer, signal: offer(caps: caps, commit: commit)),
                           [.fail(.unsupportedPeer)],
                           "caps=\(caps) is not link/1")
        }
    }

    /// A capability confirmation is per connection, so it must be enough that
    /// the first acted-on SDP carries it — a later message from the same
    /// establishment does not repeat it.
    func testCapabilityIsConfirmedOnceByTheFirstActedOnSDP() {
        let p = confirmedResponder()
        XCTAssertEqual(p.plan(from: peer, signal: ice()),
                       [.addRemoteCandidate(candidate: "candidate:1 1 udp 1 10.0.0.1 5 typ host",
                                            sdpMid: "0", sdpMLineIndex: 0)])
    }

    /// Nothing from a peer whose protocol is unconfirmed reaches the
    /// PeerConnection. It costs no candidate: a remote candidate is only useful
    /// once a remote description exists, and the SDP that would set one is
    /// exactly what has not been accepted.
    func testNothingElseIsActedOnBeforeCapabilityIsConfirmed() {
        let p = policy(role: .responder)
        XCTAssertEqual(p.plan(from: peer, signal: ice()), [])
        XCTAssertEqual(p.plan(from: peer, signal: reveal()), [])
    }

    /// The gate this rule guards downstream: a candidate that is never planned
    /// is never held by `LinkCandidateGate` and never counted as progress by
    /// `LinkEstablishmentWatchdog`. So an unconfirmed peer can neither fill the
    /// pending bound nor extend a deadline, however many candidates it sends.
    func testAnUnconfirmedPeerCannotSpendTheCandidateBoundOrBuyTime() {
        let p = policy(role: .responder)
        for index in 0..<(LINK_PENDING_CANDIDATE_MAX * 4) {
            XCTAssertEqual(p.plan(from: peer, signal: ice("candidate:\(index) 1 udp 1 10.0.0.1 5 typ host")),
                           [], "candidate \(index) from an unconfirmed peer")
        }
        XCTAssertFalse(p.isPeerCapabilityConfirmed)
    }

    // MARK: - commit before answer

    /// The anti-MITM ordering: answering an offer sends our commit, so the
    /// peer's must already be recorded when a reveal arrives in the same burst.
    func testTheCommitIsRecordedBeforeTheOfferItArrivedWith() {
        let p = policy(role: .responder)
        XCTAssertEqual(p.plan(from: peer, signal: offer(commit: commit)),
                       [.recordPeerCommit(commit), .applyRemoteOffer("v=0-offer")])
    }

    func testTheInitiatorRecordsTheCommitBeforeApplyingTheAnswer() {
        let p = policy(role: .initiator)
        XCTAssertEqual(p.plan(from: peer, signal: answer(commit: commit)),
                       [.recordPeerCommit(commit), .applyRemoteAnswer("v=0-answer")])
    }

    /// An SDP with no commit can never complete the handshake, so it fails now
    /// rather than after a PeerConnection has been held open for the whole
    /// deadline waiting for a reveal that could not be verified.
    func testAnSDPWithNoCommitFailsClosed() {
        XCTAssertEqual(policy(role: .responder).plan(from: peer, signal: offer()),
                       [.fail(.missingPeerCommit)])
        XCTAssertEqual(policy(role: .initiator).plan(from: peer, signal: answer()),
                       [.fail(.missingPeerCommit)])
    }

    // MARK: - one offer, one answer

    /// A second offer is dropped WHOLE — commit included. Recording the later
    /// commit would replace the commitment this handshake is bound to with one
    /// the peer chose after seeing our key, which is precisely what
    /// commit-before-reveal exists to prevent.
    func testASecondOfferIsDroppedWithoutRecordingItsCommit() {
        let p = confirmedResponder()
        XCTAssertEqual(p.plan(from: peer, signal: offer(commit: otherCommit, sdp: "v=0-second")), [])
    }

    func testASecondAnswerIsDropped() {
        let p = policy(role: .initiator)
        XCTAssertEqual(p.plan(from: peer, signal: answer(commit: commit)),
                       [.recordPeerCommit(commit), .applyRemoteAnswer("v=0-answer")])
        XCTAssertEqual(p.plan(from: peer, signal: answer(commit: otherCommit, sdp: "v=0-second")), [])
    }

    /// Glare: the deterministic role says who offers, so an offer reaching an
    /// initiator is not an establishment — and its commit must not be recorded
    /// either.
    func testAnOfferReachingTheInitiatorIsIgnoredEntirely() {
        let p = policy(role: .initiator)
        XCTAssertEqual(p.plan(from: peer, signal: offer(commit: otherCommit)), [])
        XCTAssertFalse(p.isPeerCapabilityConfirmed)
        // …and the genuine answer still establishes normally afterwards.
        XCTAssertEqual(p.plan(from: peer, signal: answer(commit: commit)),
                       [.recordPeerCommit(commit), .applyRemoteAnswer("v=0-answer")])
    }

    func testAnAnswerReachingTheResponderIsIgnored() {
        let p = policy(role: .responder)
        XCTAssertEqual(p.plan(from: peer, signal: answer(commit: commit)), [])
    }

    // MARK: - reveal

    func testTheFirstRevealIsVerifiedAndLaterOnesAreNot() {
        let p = confirmedResponder()
        XCTAssertEqual(p.plan(from: peer, signal: reveal()),
                       [.verifyPeerReveal(Reveal(key: "a2V5", nonce: "bm9uY2U="))])
        XCTAssertEqual(p.plan(from: peer, signal: reveal(key: "b3RoZXI=")), [],
                       "a replayed reveal must not re-derive keys or produce a second identity")
    }

    /// A single burst can legitimately carry both.
    func testICEAndRevealInOneSignalAreBothPlanned() {
        let p = confirmedResponder()
        var merged: [String: JSONValue] = [:]
        for signal in [ice(), reveal()] {
            if case let .object(fields) = signal { merged.merge(fields) { a, _ in a } }
        }
        let plan = p.plan(from: peer, signal: .object(merged))
        XCTAssertEqual(plan.count, 2)
        XCTAssertEqual(plan.last, .verifyPeerReveal(Reveal(key: "a2V5", nonce: "bm9uY2U=")))
    }
}
