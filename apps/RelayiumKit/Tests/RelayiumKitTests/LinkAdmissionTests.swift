import XCTest
@testable import RelayiumKit

/// One-link admission and signal routing, as a pure state machine.
///
/// This is the seam the WebRTC driver cannot be: every clause below is a way
/// two peers deadlock, build two competing PeerConnections into one pair of
/// lanes, or answer a peer that has no business being answered. Pinned against
/// `web/src/lib/peer-link.svelte.ts`'s `listen()` and `ensure()`.
///
/// The security claim being tested is deliberately narrow, and it is the honest
/// one: a forged capability or a forged link signal must at worst DENY SERVICE.
/// It must never activate a different room or generation, and it can never
/// deliver plaintext — the keys are derived through commit/reveal, not
/// negotiated here.
final class LinkAdmissionTests: XCTestCase {

    /// "aaa" is lexicographically smaller than "bbb", so a self of "aaa" is the
    /// initiator toward "bbb" and the responder toward "AAA".
    private let smaller = "aaa"
    private let larger = "bbb"

    private func admission(
        selfId: String,
        supports: @escaping (String) -> Bool = { _ in true },
        canAccept: @escaping (String) -> Bool = { _ in true }
    ) -> LinkAdmission {
        LinkAdmission(selfId: { selfId }, supportsLink: supports, canAcceptLink: canAccept)
    }

    // MARK: - local intent

    func testInitiatorEstablishesDirectlyAndResponderAsksFirst() {
        let a = admission(selfId: smaller)
        XCTAssertEqual(a.ensure(peerId: larger), .establish(role: .initiator))

        let b = admission(selfId: larger)
        XCTAssertEqual(b.ensure(peerId: smaller), .request)
    }

    /// A larger-id caller must NEVER send a competing offer. Two offers into one
    /// lane pair is the failure the whole deterministic-role rule exists to
    /// prevent.
    func testResponderNeverEstablishesFromLocalIntent() {
        let b = admission(selfId: larger)
        if case .establish = b.ensure(peerId: smaller) {
            XCTFail("the larger peer id must request, never offer")
        }
    }

    func testUnsupportedPeerIsRefusedBeforeAnySignalIsSent() {
        let a = admission(selfId: smaller, supports: { _ in false })
        XCTAssertEqual(a.ensure(peerId: larger), .unsupported)
    }

    func testSecondIntentForTheSamePeerJoinsTheOneInFlight() {
        let a = admission(selfId: smaller)
        XCTAssertEqual(a.ensure(peerId: larger), .establish(role: .initiator))
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        XCTAssertEqual(a.ensure(peerId: larger), .joinInFlight)
    }

    func testIntentForADifferentPeerIsRefusedWhileOneLinkIsHeld() {
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        XCTAssertEqual(a.ensure(peerId: "ccc"), .busy)
    }

    func testIntentForTheOpenPeerReturnsTheExistingLink() {
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        XCTAssertEqual(a.ensure(peerId: larger), .existing)
    }

    /// Mid-gap intent must join the rebuild instead of attaching to the dead
    /// transport the held link still points at.
    func testIntentDuringAGapJoinsTheRecovery() {
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        a.didInterrupt()
        XCTAssertEqual(a.ensure(peerId: larger), .recovering)
    }

    // MARK: - inbound link requests

    func testInboundRequestMakesTheSmallerPeerEstablish() {
        let a = admission(selfId: smaller)
        XCTAssertEqual(a.route(from: larger, signal: linkRequestSignal()),
                       .establish(role: .initiator))
    }

    /// A request that reaches the WRONG side is dropped in silence. Answering
    /// it would produce two offerers.
    func testInboundRequestAtTheResponderIsIgnored() {
        let b = admission(selfId: larger)
        XCTAssertEqual(b.route(from: smaller, signal: linkRequestSignal()), .ignore)
    }

    func testInboundRequestFromAnIncapablePeerIsIgnored() {
        let a = admission(selfId: smaller, supports: { _ in false })
        XCTAssertEqual(a.route(from: larger, signal: linkRequestSignal()), .ignore)
    }

    func testInboundRequestIsRefusedBusyWhenAdmissionSaysNo() {
        let a = admission(selfId: smaller, canAccept: { _ in false })
        XCTAssertEqual(a.route(from: larger, signal: linkRequestSignal()), .busy)
    }

    func testInboundRequestIsRefusedBusyWhileALinkIsHeld() {
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        XCTAssertEqual(a.route(from: larger, signal: linkRequestSignal()), .busy)
        XCTAssertEqual(a.route(from: "ccc", signal: linkRequestSignal()), .busy)
    }

    func testInboundRequestForAnotherPeerIsRefusedWhileEstablishing() {
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        XCTAssertEqual(a.route(from: "ccc", signal: linkRequestSignal()), .busy)
    }

    // MARK: - inbound offers

    func testInboundOfferMakesTheLargerPeerRespond() {
        let b = admission(selfId: larger)
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    func testInboundOfferAtTheInitiatorSideIsIgnored() {
        let a = admission(selfId: smaller)
        XCTAssertEqual(a.route(from: larger, signal: linkOffer()), .ignore)
    }

    func testInboundOfferFromAnIncapablePeerIsIgnored() {
        let b = admission(selfId: larger, supports: { _ in false })
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()), .ignore)
    }

    func testInboundOfferIsRefusedBusyWhileALinkIsHeld() {
        let b = admission(selfId: larger)
        b.didBeginEstablishing(peerId: smaller, role: .responder)
        b.didOpen(peerId: smaller)
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()), .busy)
    }

    /// Both users pressed at once. The smaller peer's own offer is already in
    /// flight when the larger peer's request arrives; the larger peer's request
    /// must not spawn a second attempt.
    func testSimultaneousOpenConvergesOnOneAttempt() {
        let a = admission(selfId: smaller)
        XCTAssertEqual(a.ensure(peerId: larger), .establish(role: .initiator))
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        // The peer's request crosses our offer. It must be absorbed by the
        // attempt already running, never spawn a second one.
        XCTAssertEqual(a.route(from: larger, signal: linkRequestSignal()), .alreadyInFlight)

        let b = admission(selfId: larger)
        XCTAssertEqual(b.ensure(peerId: smaller), .request)
        b.didBeginRequesting(peerId: smaller)
        // Our request crosses the peer's offer: adopt the offer.
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    // MARK: - request lifecycle

    func testBusyReplyFailsOnlyOurOwnOutstandingRequest() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        XCTAssertEqual(b.route(from: "zzz", signal: linkBusySignal()), .ignore)
        XCTAssertEqual(b.route(from: smaller, signal: linkBusySignal()), .requestRefused)
        XCTAssertEqual(b.phase, .failed)
    }

    /// A request that timed out must not black-hole the peer for the rest of
    /// the session: one late offer is consumed and answered with an explicit
    /// busy so its sender retries, and the next one is accepted normally.
    func testOneLateOfferAfterTimeoutIsRefusedAndThenTheNextIsAccepted() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        b.didRequestTimeOut(peerId: smaller)
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()), .busy)
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    func testANewRequestClearsThatPeersTimeoutMark() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        b.didRequestTimeOut(peerId: smaller)
        XCTAssertEqual(b.ensure(peerId: smaller), .request)
        b.didBeginRequesting(peerId: smaller)
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    // MARK: - rebuild offers

    func testResumeOfferIsOnlyConsumedByAnInterruptedResponderLink() {
        let b = admission(selfId: larger)
        b.didBeginEstablishing(peerId: smaller, role: .responder)
        b.didOpen(peerId: smaller)
        // Open, not interrupted: a rebuild offer has no business here.
        XCTAssertEqual(b.route(from: smaller, signal: resumeOffer()), .ignore)
        b.didInterrupt()
        XCTAssertEqual(b.route(from: smaller, signal: resumeOffer()), .resumeOffer)
    }

    /// The initiator drives its own rebuild; consuming an inbound one would put
    /// two PeerConnections into the same lanes.
    func testInitiatorIgnoresInboundResumeOffers() {
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        a.didInterrupt()
        XCTAssertEqual(a.route(from: larger, signal: resumeOffer()), .ignore)
    }

    func testResumeOfferFromAnotherPeerIsIgnored() {
        let b = admission(selfId: larger)
        b.didBeginEstablishing(peerId: smaller, role: .responder)
        b.didOpen(peerId: smaller)
        b.didInterrupt()
        XCTAssertEqual(b.route(from: "zzz", signal: resumeOffer()), .ignore)
    }

    /// One rebuild at a time: a second offer arriving in the same burst must
    /// not start a second PeerConnection into the same lanes.
    func testOnlyOneRebuildSlotIsHandedOut() {
        let b = admission(selfId: larger)
        b.didBeginEstablishing(peerId: smaller, role: .responder)
        b.didOpen(peerId: smaller)
        b.didInterrupt()
        XCTAssertEqual(b.route(from: smaller, signal: resumeOffer()), .resumeOffer)
        b.didBeginReplacingTransport()
        XCTAssertEqual(b.route(from: smaller, signal: resumeOffer()), .ignore)
    }

    /// The rebuild slot is given back when an attempt ends without publishing.
    ///
    /// Without this the slot is one-shot for the whole gap: a responder whose
    /// first attempt failed would ignore every later offer from the peer that is
    /// still trying, and sit out the rest of its recovery window holding a link
    /// it could have rebuilt. Deliberately NOT a phase change — the link is still
    /// interrupted, and still refuses everyone else.
    func testTheRebuildSlotIsReturnedWhenAnAttemptEnds() {
        let b = admission(selfId: larger)
        b.didBeginEstablishing(peerId: smaller, role: .responder)
        b.didOpen(peerId: smaller)
        b.didInterrupt()
        XCTAssertEqual(b.route(from: smaller, signal: resumeOffer()), .resumeOffer)
        b.didBeginReplacingTransport()

        b.didEndReplacingTransport()

        XCTAssertEqual(b.phase, .interrupted(peerId: smaller))
        XCTAssertEqual(b.route(from: smaller, signal: resumeOffer()), .resumeOffer)
        XCTAssertEqual(b.route(from: "zzz", signal: linkRequestSignal()), .busy)
    }

    // MARK: - leave

    func testLeaveIsRoutedForVerificationOnlyForTheCurrentPeer() {
        let auth = String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH)
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        XCTAssertEqual(a.route(from: larger, signal: linkLeaveSignal(auth: auth)), .leave(auth: auth))
        XCTAssertEqual(a.route(from: "zzz", signal: linkLeaveSignal(auth: auth)), .ignore)
    }

    func testLeaveWithNoLinkIsIgnoredWithoutSpendingAnHMAC() {
        let auth = String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH)
        let a = admission(selfId: smaller)
        XCTAssertEqual(a.route(from: larger, signal: linkLeaveSignal(auth: auth)), .ignore)
    }

    /// Every cheap check runs before the HMAC, and the budget bounds how much
    /// verification work a flood of forged tags can ever buy.
    func testLeaveVerificationBudgetIsBoundedPerAuthenticatedLink() {
        let auth = String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH)
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        for _ in 0..<LINK_LEAVE_MAX_ATTEMPTS {
            XCTAssertEqual(a.route(from: larger, signal: linkLeaveSignal(auth: auth)),
                           .leave(auth: auth))
        }
        XCTAssertEqual(a.route(from: larger, signal: linkLeaveSignal(auth: auth)), .ignore,
                       "a replayed tag must not buy unbounded HMAC work")
    }

    /// A transport replacement is the SAME authentication step, so it must not
    /// hand a flooding peer a fresh budget. A genuinely new link does.
    func testLeaveBudgetResetsOnANewLinkButNotOnATransportReplacement() {
        let auth = String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH)
        let a = admission(selfId: smaller)
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        for _ in 0..<LINK_LEAVE_MAX_ATTEMPTS {
            _ = a.route(from: larger, signal: linkLeaveSignal(auth: auth))
        }
        a.didInterrupt()
        a.didBeginReplacingTransport()
        a.didReplaceTransport(peerId: larger)
        XCTAssertEqual(a.route(from: larger, signal: linkLeaveSignal(auth: auth)), .ignore)

        a.didClose()
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        a.didOpen(peerId: larger)
        XCTAssertEqual(a.route(from: larger, signal: linkLeaveSignal(auth: auth)),
                       .leave(auth: auth))
    }

    // MARK: - stale peers and room teardown

    func testCloseReleasesTheLinkAndTheTimeoutMarks() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        b.didRequestTimeOut(peerId: smaller)
        b.didClose()
        XCTAssertEqual(b.phase, .idle)
        XCTAssertEqual(b.boundPeerId, "")
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// A server-confirmed departure cancels an establishment in flight as well
    /// as an established link — `boundPeerId` is the broader view that makes
    /// that one check rather than four.
    func testBoundPeerIsVisibleInEveryLifecyclePhase() {
        let a = admission(selfId: smaller)
        XCTAssertEqual(a.boundPeerId, "")
        a.didBeginEstablishing(peerId: larger, role: .initiator)
        XCTAssertEqual(a.boundPeerId, larger)
        a.didOpen(peerId: larger)
        XCTAssertEqual(a.boundPeerId, larger)
        a.didInterrupt()
        XCTAssertEqual(a.boundPeerId, larger)
        a.didClose()
        XCTAssertEqual(a.boundPeerId, "")
    }

    // MARK: - hostile input

    /// The whole point of the capability gate. A forged roster claim or a
    /// forged signal may deny service; it must not reach a different room or
    /// generation, and it must not open anything.
    func testForgedSignalsCanOnlyEverDenyService() {
        let a = admission(selfId: smaller, supports: { _ in false })
        for signal in [linkRequestSignal(), linkOffer(), resumeOffer(), linkBusySignal()] {
            let decision = a.route(from: larger, signal: signal)
            XCTAssertTrue(decision == .ignore || decision == .busy,
                          "an incapable peer must never reach \(decision)")
        }
        XCTAssertEqual(a.phase, .idle)
    }

    func testSignalsOfOtherGenerationsAreNotThisRoutersBusiness() {
        let a = admission(selfId: smaller)
        // A legacy untagged file offer, a text offer, and a bare ICE candidate.
        XCTAssertEqual(a.route(from: larger, signal: sdpSignal(kind: "offer", sdp: "v=0", commit: nil)), .ignore)
        XCTAssertEqual(a.route(from: larger,
                               signal: sdpSignal(kind: "offer", sdp: "v=0", commit: nil,
                                                 generation: .text, caps: [TEXT_CAPABILITY])), .ignore)
        XCTAssertEqual(a.route(from: larger,
                               signal: iceSignal("candidate:1", sdpMid: "0", sdpMLineIndex: 0)), .ignore)
    }

    func testMalformedSignalsAreInert() {
        let a = admission(selfId: smaller)
        for signal: JSONValue in [.null, .array([]), .string("link/1"), .number(1),
                                  .object([:]), .object(["link": .string("true")])] {
            XCTAssertEqual(a.route(from: larger, signal: signal), .ignore)
        }
    }

    // MARK: - the admission predicate is external code

    /// `canAcceptLink` is owner-supplied, and the obvious implementation asks
    /// this admission what it is currently doing. `NSLock` is not recursive, so
    /// evaluating that closure while holding the lock is a self-deadlock — on
    /// the signalling delivery queue, which would strand every later inbound
    /// signal on the socket, not just this one.
    ///
    /// Bounded on purpose. The route runs on another queue and the test fails by
    /// TIMEOUT rather than by hanging the suite, so a regression is reported
    /// instead of silently wedging CI.
    func testAdmissionPredicateMayReadPhaseReentrantly() {
        let probe = ReentrantAdmissionProbe(selfId: larger, peerId: smaller, offer: linkOffer())
        probe.admission.didBeginRequesting(peerId: smaller)

        let routed = expectation(description: "route(from:signal:) returned")
        DispatchQueue.global().async {
            probe.route()
            routed.fulfill()
        }
        wait(for: [routed], timeout: 5)

        // Our request crossed the peer's offer, so the offer is adopted.
        XCTAssertEqual(probe.decision, .establish(role: .responder))
        XCTAssertEqual(probe.calls, 1, "the predicate is consulted exactly once")
        XCTAssertEqual(probe.observedPhase, .requesting(peerId: smaller),
                       "the predicate must see the live phase, not a stale snapshot")
    }

    /// The late-offer rule is unchanged by moving the predicate out of the
    /// lock: a consumed late offer is refused on the timeout mark ALONE, without
    /// asking the owner anything. Its answer could not change the outcome, and
    /// spending a call on it would put an owner-visible side effect on a path
    /// that is purely bookkeeping.
    func testAConsumedLateOfferDoesNotConsultTheAdmissionPredicate() {
        var calls = 0
        let b = admission(selfId: larger, canAccept: { _ in calls += 1; return true })
        b.didBeginRequesting(peerId: smaller)
        b.didRequestTimeOut(peerId: smaller)
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()), .busy)
        XCTAssertEqual(calls, 0)
        // The next offer is an ordinary one, and is admitted normally.
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()), .establish(role: .responder))
        XCTAssertEqual(calls, 1)
    }

    func testInboundOfferIsRefusedBusyWhenAdmissionSaysNo() {
        let b = admission(selfId: larger, canAccept: { _ in false })
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()), .busy)
    }

    /// The predicate runs with nothing held, so the world it returns into is not
    /// the world it was called in — and the phase must be read AFTER it, in the
    /// same critical section as the timeout mark it may have created.
    ///
    /// The deterministic case: a `canAcceptLink` that gives up on this side's own
    /// outstanding request while it is being consulted, which is exactly what a
    /// session model deciding it cannot take this peer would do. Reading a
    /// snapshot from before the call answers `establish` on an attempt this side
    /// has just abandoned AND leaves the new mark standing, so the peer's next,
    /// genuine offer is the one that gets refused.
    func testAnOfferRacingItsOwnRequestTimeoutIsRefusedAndConsumesTheMark() {
        let probe = TimingOutAdmissionProbe(selfId: larger, peerId: smaller, offer: linkOffer())
        probe.admission.didBeginRequesting(peerId: smaller)

        XCTAssertEqual(probe.route(), .busy,
                       "the attempt this predicate abandoned cannot also be adopted")
        XCTAssertEqual(probe.admission.phase, .failed)
        // The mark was consumed by the very offer that created it, so the peer's
        // retry is admitted normally rather than refused on a mark it can never
        // see or clear.
        XCTAssertEqual(probe.route(), .establish(role: .responder))
    }

    /// `selfId` is owner-supplied too, and `ensure` evaluated it inside the
    /// locked idle branch. `NSLock` is not recursive, so an owner whose identity
    /// getter reads this admission back — the same shape `canAcceptLink` already
    /// has — self-deadlocks its own caller.
    ///
    /// Bounded on purpose, exactly like the predicate test above: the call runs
    /// on another queue and this fails by TIMEOUT rather than wedging CI.
    func testSelfIdMayReadPhaseReentrantly() {
        let probe = ReentrantSelfIdProbe(selfId: larger, peerId: smaller)

        let returned = expectation(description: "ensure(peerId:) returned")
        DispatchQueue.global().async {
            probe.ensure()
            returned.fulfill()
        }
        wait(for: [returned], timeout: 5)

        XCTAssertEqual(probe.intent, .request, "the larger peer asks rather than offering")
        XCTAssertEqual(probe.observedPhase, .idle,
                       "the getter must see the live phase, not a stale snapshot")
    }

    // MARK: - helpers

    private func linkOffer() -> JSONValue {
        linkSDPSignal(kind: "offer", sdp: "v=0", commit: "Yw==",
                      caps: [TEXT_CAPABILITY, LINK_CAPABILITY])
    }

    private func resumeOffer() -> JSONValue {
        var signal = sdpSignal(kind: "offer", sdp: "v=0", commit: nil, generation: .resume)
        guard case var .object(fields) = signal else { return signal }
        fields["auth"] = .string(String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH))
        signal = .object(fields)
        return signal
    }
}

/// An owner-shaped `canAcceptLink`: one that reads the admission it is being
/// asked by. Everything the routed call needs lives on this object, so the
/// dispatched work captures one reference and no test-case state.
private final class ReentrantAdmissionProbe: @unchecked Sendable {
    private(set) var observedPhase: LinkPhase?
    private(set) var decision: LinkAdmissionDecision?
    private(set) var calls = 0

    /// Implicitly unwrapped so every stored property has a value before the
    /// predicate below closes over `self` — which is what lets the closure ask
    /// the very admission it is being consulted by.
    private(set) var admission: LinkAdmission!
    private let peerId: String
    private let offer: JSONValue

    init(selfId: String, peerId: String, offer: JSONValue) {
        self.peerId = peerId
        self.offer = offer
        admission = LinkAdmission(
            selfId: { selfId },
            supportsLink: { _ in true },
            canAcceptLink: { [unowned self] _ in
                calls += 1
                observedPhase = admission.phase
                return true
            }
        )
    }

    func route() {
        decision = admission.route(from: peerId, signal: offer)
    }
}

/// An owner-shaped `canAcceptLink` that CHANGES this admission while it is being
/// consulted, rather than only reading it. Giving up on an outstanding request
/// is the obvious thing a session model does when it decides it cannot take a
/// peer, and it is the one mutation that can invalidate a phase snapshot taken
/// before the call.
///
/// `didRequestTimeOut` is a no-op outside `requesting`, so the probe can call it
/// unconditionally and still describe exactly one race.
private final class TimingOutAdmissionProbe: @unchecked Sendable {
    private(set) var admission: LinkAdmission!
    private let peerId: String
    private let offer: JSONValue

    init(selfId: String, peerId: String, offer: JSONValue) {
        self.peerId = peerId
        self.offer = offer
        admission = LinkAdmission(
            selfId: { selfId },
            supportsLink: { _ in true },
            canAcceptLink: { [unowned self] peer in
                admission.didRequestTimeOut(peerId: peer)
                return true
            }
        )
    }

    func route() -> LinkAdmissionDecision {
        admission.route(from: peerId, signal: offer)
    }
}

/// An owner-shaped `selfId`: a stored identity read through a model that also
/// exposes the link's phase.
private final class ReentrantSelfIdProbe: @unchecked Sendable {
    private(set) var observedPhase: LinkPhase?
    private(set) var intent: LinkIntent?

    private(set) var admission: LinkAdmission!
    private let peerId: String

    init(selfId: String, peerId: String) {
        self.peerId = peerId
        admission = LinkAdmission(
            selfId: { [unowned self] in
                observedPhase = admission.phase
                return selfId
            },
            supportsLink: { _ in true }
        )
    }

    func ensure() {
        intent = admission.ensure(peerId: peerId)
    }
}
