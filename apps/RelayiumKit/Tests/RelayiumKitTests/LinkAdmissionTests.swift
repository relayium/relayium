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

    // MARK: - claiming what a decision authorised
    //
    // `route` and `ensure` answer from the phase they observed and deliberately
    // do not act, so acting on one is a second step — and the window between them
    // is where two offers delivered in one socket burst both find an idle room.
    // These two close that window: the test and the claim are one critical
    // section, and the loser is told it lost.

    /// The first claim wins and takes the room; the second is refused, which is
    /// exactly when its peer is owed a `busy`.
    func testOnlyOneEstablishmentCanClaimAnIdleRoom() {
        let admission = admission(selfId: smaller)

        XCTAssertTrue(admission.admitEstablishment(peerId: larger, role: .initiator))
        XCTAssertFalse(admission.admitEstablishment(peerId: "ccc", role: .initiator))

        XCTAssertEqual(admission.phase, .connecting(peerId: larger))
    }

    /// Idempotent for the peer already being established with, so a crossing
    /// offer adopted while this side's own attempt is in flight is not told it
    /// lost a race it is not in.
    func testClaimingTheRoomTwiceForOnePeerIsIdempotent() {
        let admission = admission(selfId: smaller)
        XCTAssertTrue(admission.admitEstablishment(peerId: larger, role: .initiator))

        XCTAssertTrue(admission.admitEstablishment(peerId: larger, role: .initiator))
        XCTAssertEqual(admission.phase, .connecting(peerId: larger))
    }

    /// A reclaim must not rewrite the role, and the proof is what happens a whole
    /// lifecycle later.
    ///
    /// `establishedRole` is not read at claim time at all: it is read during
    /// RECOVERY, where it decides who drives a rebuild. Only the responder
    /// consumes an inbound authenticated resume offer, because the initiator
    /// drives its own — so a duplicate claim carrying the opposite role would
    /// turn this initiator into a second consumer, and the two peers would put
    /// two PeerConnections into one pair of lanes. Nothing at the moment of the
    /// reclaim would look wrong; the damage surfaces during a gap, which is
    /// exactly why this asserts through one.
    func testAReclaimWithAConflictingRoleDoesNotChangeWhoDrivesARebuild() {
        let admission = admission(selfId: smaller)
        XCTAssertTrue(admission.admitEstablishment(peerId: larger, role: .initiator))

        // The duplicate: same peer, opposite role. Idempotent, and inert.
        XCTAssertTrue(admission.admitEstablishment(peerId: larger, role: .responder),
                      "a duplicate claim for the peer we are already dialling still succeeds")

        admission.didOpen(peerId: larger)
        admission.didInterrupt()
        XCTAssertEqual(admission.phase, .interrupted(peerId: larger))

        XCTAssertEqual(admission.route(from: larger, signal: resumeOffer()), .ignore,
                       "this side is still the initiator, so it drives its own rebuild")
    }

    /// The positive control for the test above: a link whose role really IS
    /// responder consumes the same signal. Without this, the assertion above
    /// would pass just as well against a resume offer that is malformed, and the
    /// regression it exists for would go unnoticed.
    func testAResponderStillConsumesTheSameResumeOffer() {
        let admission = admission(selfId: larger)
        XCTAssertTrue(admission.admitEstablishment(peerId: smaller, role: .responder))
        admission.didOpen(peerId: smaller)
        admission.didInterrupt()

        XCTAssertEqual(admission.route(from: smaller, signal: resumeOffer()), .resumeOffer,
                       "the responder answers the initiator's authenticated offer")
    }

    /// The role a NEW establishment settles is the one it was given, whichever
    /// path it came in on — a claim from idle, and a claim that supersedes this
    /// side's own outstanding ask.
    func testANewEstablishmentSettlesTheRoleItWasGiven() {
        let fromIdle = admission(selfId: larger)
        XCTAssertTrue(fromIdle.admitEstablishment(peerId: smaller, role: .responder))
        fromIdle.didOpen(peerId: smaller)
        fromIdle.didInterrupt()
        XCTAssertEqual(fromIdle.route(from: smaller, signal: resumeOffer()), .resumeOffer)

        let fromAsk = admission(selfId: larger)
        fromAsk.didBeginRequesting(peerId: smaller)
        XCTAssertTrue(fromAsk.admitEstablishment(peerId: smaller, role: .responder),
                      "the crossing offer supersedes our ask")
        fromAsk.didOpen(peerId: smaller)
        fromAsk.didInterrupt()
        XCTAssertEqual(fromAsk.route(from: smaller, signal: resumeOffer()), .resumeOffer,
                       "and it settled the role, because nothing had settled one before")
    }

    /// A room that has been given up and re-taken settles a fresh role: `didClose`
    /// clears it, so the next establishment is genuinely new.
    func testARoomGivenUpAndRetakenSettlesAFreshRole() {
        let admission = admission(selfId: larger)
        XCTAssertTrue(admission.admitEstablishment(peerId: smaller, role: .initiator))
        admission.didClose()

        XCTAssertTrue(admission.admitEstablishment(peerId: smaller, role: .responder))
        admission.didOpen(peerId: smaller)
        admission.didInterrupt()

        XCTAssertEqual(admission.route(from: smaller, signal: resumeOffer()), .resumeOffer,
                       "the new establishment's role is the one that applies")
    }

    /// A crossing offer supersedes this side's own outstanding ask to the same
    /// peer — that convergence is what the request mechanism exists to produce —
    /// and is refused for any other peer.
    func testAnOutstandingAskIsSupersededOnlyByItsOwnPeer() {
        let admission = admission(selfId: smaller)
        admission.didBeginRequesting(peerId: larger)

        XCTAssertFalse(admission.admitEstablishment(peerId: "ccc", role: .responder))
        XCTAssertEqual(admission.phase, .requesting(peerId: larger))

        XCTAssertTrue(admission.admitEstablishment(peerId: larger, role: .responder))
        XCTAssertEqual(admission.phase, .connecting(peerId: larger))
    }

    /// A held link is never displaced by a claim, open or interrupted.
    func testAHeldLinkIsNeverDisplacedByAClaim() {
        let admission = admission(selfId: smaller)
        admission.didBeginEstablishing(peerId: larger, role: .initiator)
        admission.didOpen(peerId: larger)

        XCTAssertFalse(admission.admitEstablishment(peerId: "ccc", role: .initiator))
        XCTAssertEqual(admission.phase, .open(peerId: larger))

        admission.didInterrupt()
        XCTAssertFalse(admission.admitEstablishment(peerId: "ccc", role: .initiator))
        XCTAssertEqual(admission.phase, .interrupted(peerId: larger))
    }

    /// Claiming the room consumes the peer's timed-out mark: this side is no
    /// longer waiting on it, so its next offer is genuine rather than the one
    /// late offer a mark exists to answer.
    func testClaimingConsumesATimedOutMark() {
        let admission = admission(selfId: larger)
        admission.didBeginRequesting(peerId: smaller)
        admission.didRequestTimeOut(peerId: smaller)

        XCTAssertTrue(admission.admitEstablishment(peerId: smaller, role: .responder))
        admission.didClose()
        admission.didBeginRequesting(peerId: smaller)

        // The mark is gone, so a later offer is establishment rather than busy.
        XCTAssertEqual(admission.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// An ask claims an idle room, is idempotent for its own peer, and never
    /// overwrites an establishment that was admitted in the meantime — which is
    /// the race a router acting on `ensure`'s answer would otherwise lose.
    func testAnAskClaimsOnlyAnIdleRoom() {
        let admission = admission(selfId: larger)

        XCTAssertTrue(admission.admitRequest(peerId: smaller))
        XCTAssertTrue(admission.admitRequest(peerId: smaller), "idempotent for its own peer")
        XCTAssertFalse(admission.admitRequest(peerId: "aab"))
        XCTAssertEqual(admission.phase, .requesting(peerId: smaller))

        admission.didClose()
        XCTAssertTrue(admission.admitEstablishment(peerId: smaller, role: .responder))
        XCTAssertFalse(admission.admitRequest(peerId: "aab"),
                       "an establishment is not overwritten by an ask")
        XCTAssertEqual(admission.phase, .connecting(peerId: smaller))
    }

    /// Concurrent claims from many threads: exactly one wins, and the room ends
    /// up committed to that one peer.
    func testConcurrentClaimsAdmitExactlyOnePeer() {
        let admission = admission(selfId: smaller)
        let peers = (0..<32).map { "peer-\($0)" }
        let won = NSLock()
        var winners: [String] = []

        DispatchQueue.concurrentPerform(iterations: peers.count) { index in
            if admission.admitEstablishment(peerId: peers[index], role: .initiator) {
                won.lock(); winners.append(peers[index]); won.unlock()
            }
        }

        XCTAssertEqual(winners.count, 1, "exactly one claim took the room")
        XCTAssertEqual(admission.phase, .connecting(peerId: winners[0]))
    }

    // MARK: - ending exactly the request a claim took
    //
    // A router arms its own timeout and tears its own ask down when the peer
    // disappears, so both endings arrive from outside — one instant after the
    // request may have become an establishment, an open link, or somebody else's
    // ask entirely. Each test below is a way a late or misaddressed ending
    // destroys something it has no business touching, or leaves a debt on a peer
    // that will pay it with its next genuine offer.

    /// An ending names the request it means to end. Fired at any other peer it
    /// is inert — it does not end the live ask, and it does not leave a mark on
    /// the peer it named either.
    func testEndingARequestForAnotherPeerIsInert() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)

        XCTAssertFalse(b.endRequest(peerId: "aab", as: .timedOut))
        XCTAssertFalse(b.endRequest(peerId: "aab", as: .cancelled))
        XCTAssertEqual(b.phase, .requesting(peerId: smaller))
        XCTAssertFalse(b.forgetRequestTimeout(peerId: "aab"),
                       "an inert ending must not leave a mark on the peer it named")

        // The ask it did not end still converges on the peer's crossing offer.
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// The timer that fires one instant too late. By then the ask has become an
    /// establishment — or an open link — and cancelling it would tear down a
    /// link that had just connected, on behalf of a wait nobody is doing any
    /// more.
    func testEndingARequestThatAlreadyBecameAnEstablishmentIsInert() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        XCTAssertTrue(b.admitEstablishment(peerId: smaller, role: .responder),
                      "the crossing offer supersedes our ask")

        XCTAssertFalse(b.endRequest(peerId: smaller, as: .cancelled))
        XCTAssertFalse(b.endRequest(peerId: smaller, as: .timedOut))
        XCTAssertEqual(b.phase, .connecting(peerId: smaller))

        b.didOpen(peerId: smaller)
        XCTAssertFalse(b.endRequest(peerId: smaller, as: .cancelled))
        XCTAssertFalse(b.endRequest(peerId: smaller, as: .timedOut))
        XCTAssertEqual(b.phase, .open(peerId: smaller))
    }

    /// Exactly one caller ends the request, and a repeat does not quietly buy a
    /// second late-offer refusal on top of the first.
    func testARequestTimesOutOnlyOnce() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)

        XCTAssertTrue(b.endRequest(peerId: smaller, as: .timedOut))
        XCTAssertFalse(b.endRequest(peerId: smaller, as: .timedOut),
                       "only the call that changed the state may report it")
        XCTAssertEqual(b.phase, .failed)

        // One mark, not two: the repeat is inert on the debt as well as on the
        // phase, so the peer still pays exactly one offer.
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()), .busy)
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// The debt a timeout leaves, paid in full and once: the peer whose offer
    /// was already in flight is told explicitly to retry, and the retry is
    /// admitted rather than black-holed for the rest of the session.
    func testATimedOutRequestCostsExactlyOneLateOfferThenEstablishes() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        XCTAssertTrue(b.endRequest(peerId: smaller, as: .timedOut))
        XCTAssertEqual(b.phase, .failed)

        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()), .busy)
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// A withdrawal owes the peer nothing. The room goes back to idle and the
    /// peer's next offer is admitted normally — a mark here would refuse the
    /// first genuine offer of a peer that came back.
    func testSilentCancellationNeverRefusesTheNextOffer() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)

        XCTAssertTrue(b.endRequest(peerId: smaller, as: .cancelled))
        XCTAssertEqual(b.phase, .idle)
        XCTAssertEqual(b.boundPeerId, "")
        XCTAssertFalse(b.forgetRequestTimeout(peerId: smaller), "no debt was left")
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))

        // And a cancellation after an EARLIER timeout is still clean: the
        // re-ask cleared that mark, and this ending adds none back.
        b.didClose()
        b.didBeginRequesting(peerId: smaller)
        XCTAssertTrue(b.endRequest(peerId: smaller, as: .timedOut))
        b.didBeginRequesting(peerId: smaller)
        XCTAssertTrue(b.endRequest(peerId: smaller, as: .cancelled))
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// One peer leaving says nothing about another peer's outstanding late
    /// offer. Forgetting is per peer and one-shot.
    func testForgettingOneStalePeerLeavesTheOthersMarkStanding() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        XCTAssertTrue(b.endRequest(peerId: smaller, as: .timedOut))
        b.didBeginRequesting(peerId: "aab")
        XCTAssertTrue(b.endRequest(peerId: "aab", as: .timedOut))

        XCTAssertTrue(b.forgetRequestTimeout(peerId: smaller))
        XCTAssertFalse(b.forgetRequestTimeout(peerId: smaller), "one mark, forgotten once")

        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder),
                       "the forgotten peer owes nothing")
        XCTAssertEqual(b.route(from: "aab", signal: linkOffer()), .busy,
                       "the other peer's late offer is still owed an explicit refusal")
        XCTAssertEqual(b.route(from: "aab", signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// Forgetting a mark is bookkeeping about an ABSENT peer, so it must not
    /// disturb the room — this side may be mid-ask with somebody else while a
    /// roster update proves an unrelated peer gone.
    func testForgettingAStaleMarkChangesNoPhase() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: "aab")
        XCTAssertTrue(b.endRequest(peerId: "aab", as: .timedOut))
        b.didBeginRequesting(peerId: smaller)

        XCTAssertTrue(b.forgetRequestTimeout(peerId: "aab"))
        XCTAssertEqual(b.phase, .requesting(peerId: smaller))
        XCTAssertFalse(b.forgetRequestTimeout(peerId: "ccc"),
                       "a peer that never timed out has nothing to forget")
        XCTAssertEqual(b.phase, .requesting(peerId: smaller))

        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// The narrow calls above do not weaken the broad one: giving up the room
    /// still drops every mark, for every peer.
    func testCloseStillClearsEveryPeersMark() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        XCTAssertTrue(b.endRequest(peerId: smaller, as: .timedOut))
        b.didBeginRequesting(peerId: "aab")
        XCTAssertTrue(b.endRequest(peerId: "aab", as: .timedOut))

        b.didClose()

        XCTAssertEqual(b.phase, .idle)
        XCTAssertFalse(b.forgetRequestTimeout(peerId: smaller))
        XCTAssertFalse(b.forgetRequestTimeout(peerId: "aab"))
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       .establish(role: .responder))
        XCTAssertEqual(b.route(from: "aab", signal: linkOffer()),
                       .establish(role: .responder))
    }

    /// A timeout and a departure can reach one ask from two threads at once —
    /// the timer queue and the signalling queue. Exactly one of them ends it,
    /// and the room lands in the state that winner chose, never a mixture of
    /// both.
    func testConcurrentEndingsResolveToExactlyOneWinner() {
        let b = admission(selfId: larger)
        b.didBeginRequesting(peerId: smaller)
        let won = NSLock()
        var winners: [LinkRequestEnding] = []

        DispatchQueue.concurrentPerform(iterations: 32) { index in
            let ending: LinkRequestEnding = index.isMultiple(of: 2) ? .timedOut : .cancelled
            if b.endRequest(peerId: smaller, as: ending) {
                won.lock(); winners.append(ending); won.unlock()
            }
            // A roster sweep for an unrelated peer, running through the same
            // lock at the same time.
            _ = b.forgetRequestTimeout(peerId: "aab")
        }

        XCTAssertEqual(winners.count, 1, "exactly one call ended the request")
        XCTAssertEqual(b.phase, winners[0] == .timedOut ? .failed : .idle)
        // And the ending that won is the only one that left a debt.
        XCTAssertEqual(b.route(from: smaller, signal: linkOffer()),
                       winners[0] == .timedOut ? .busy : .establish(role: .responder))
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
