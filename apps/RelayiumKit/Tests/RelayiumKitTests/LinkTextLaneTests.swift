import XCTest
@testable import RelayiumKit

/// The text lane's conversation lifecycle, as a pure state machine.
///
/// A conversation opens, ends and reopens many times on ONE authenticated link.
/// The invariant that makes that safe is that a conversation boundary is not a
/// codec boundary: the link owns exactly one `RealtimeTextSender` and one
/// `RealtimeTextReceiver` for its whole life, so ending a conversation must
/// never reset an AEAD sequence. Everything here exists to keep that true while
/// two humans press buttons in an arbitrary order.
///
/// Pinned against `web/src/lib/mixed-text-session.svelte.ts`.
final class LinkTextLaneTests: XCTestCase {

    /// A clock the test moves by hand. Every rate rule below is worth testing,
    /// and a rule that can only be tested by waiting in real time does not get
    /// tested — so the lane takes its clock as a parameter and these tests
    /// supply one that only moves when they say so.
    private final class TestClock {
        /// Deliberately not zero: a bucket whose mark starts at the epoch would
        /// hide a refill computed against the wrong origin.
        var seconds: TimeInterval = 1_000
        func advance(_ interval: TimeInterval) { seconds += interval }
    }

    private func lane(role: Role = .initiator, clock: TestClock? = nil) -> LinkTextLane {
        guard let clock else { return LinkTextLane(role: role) }
        return LinkTextLane(role: role, now: { clock.seconds })
    }

    private let request = LINK_TEXT_REQUEST
    private let end = LINK_TEXT_END
    private let accept = RealtimeControl.accept.rawValue
    private let reject = RealtimeControl.reject.rawValue

    // MARK: - the ordinary conversation

    func testOpenAcceptSendEnd() {
        let l = lane()
        XCTAssertEqual(l.status, .idle)
        XCTAssertEqual(l.localOpen(), [.sendControl(request), .armConsentTimeout])
        XCTAssertEqual(l.status, .waitingAccept)

        XCTAssertEqual(l.inboundControl(accept), [.cancelConsentTimeout])
        XCTAssertEqual(l.status, .open)
        XCTAssertTrue(l.maySendProtected)

        // No consent cancellation: the prompt was resolved by the ACCEPT above,
        // and a driver told to cancel a timer it is not holding is being handed
        // an approximate effect list.
        XCTAssertEqual(l.localEnd(), [.sendControl(end), .armEndAckTimeout])
        XCTAssertEqual(l.status, .ended)
        XCTAssertFalse(l.maySendProtected)
    }

    func testInboundRequestBecomesAConsentPromptAndAcceptOpens() {
        let l = lane(role: .responder)
        XCTAssertEqual(l.inboundControl(request), [.armConsentTimeout])
        XCTAssertEqual(l.status, .incomingRequest)
        XCTAssertFalse(l.maySendProtected, "no plaintext before this side consents")
        XCTAssertEqual(l.localAccept(), [.cancelConsentTimeout, .sendControl(accept)])
        XCTAssertEqual(l.status, .open)
        XCTAssertTrue(l.maySendProtected)
    }

    func testLocalRejectRefusesWithoutEndingTheLink() {
        let l = lane(role: .responder)
        _ = l.inboundControl(request)
        XCTAssertEqual(l.localReject(), [.cancelConsentTimeout, .sendControl(reject)])
        XCTAssertEqual(l.status, .refused)
        XCTAssertFalse(l.effectsIncludeLinkTeardown)
    }

    func testRemoteRejectWhileWaitingIsRefusal() {
        let l = lane()
        _ = l.localOpen()
        XCTAssertEqual(l.inboundControl(reject), [.cancelConsentTimeout])
        XCTAssertEqual(l.status, .refused)
    }

    // MARK: - reuse without resetting a sequence

    /// The claim the whole lane exists to support: many conversations, one
    /// codec pair, never a reset.
    func testRepeatedConversationsNeverResetTheCodecs() {
        let l = lane()
        for _ in 0..<5 {
            _ = l.localOpen()
            _ = l.inboundControl(accept)
            XCTAssertEqual(l.status, .open)
            _ = l.localEnd()
            _ = l.inboundControl(end)          // the peer's symmetric END
            XCTAssertEqual(l.status, .ended)
            XCTAssertFalse(l.codecsPoisoned, "a normal conversation boundary is not a codec boundary")
        }
        XCTAssertEqual(l.conversationCount, 5)
    }

    func testReopeningAfterAnEndedConversationIsAllowed() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        _ = l.inboundControl(end)
        XCTAssertEqual(l.localOpen(), [.sendControl(request), .armConsentTimeout])
        XCTAssertEqual(l.status, .waitingAccept)
    }

    // MARK: - glare

    /// Both users pressed at once. The smaller peer keeps its outbound request;
    /// the larger peer converts its intent into the one consent prompt. Without
    /// this the two sides sit in `waitingAccept` forever, each waiting for the
    /// other's ACCEPT.
    func testCrossingRequestsConvergeOnOneConversation() {
        let initiator = lane(role: .initiator)
        _ = initiator.localOpen()
        XCTAssertEqual(initiator.inboundControl(request), [.sendControl(reject)])
        XCTAssertEqual(initiator.status, .waitingAccept, "the smaller peer keeps its request")

        let responder = lane(role: .responder)
        _ = responder.localOpen()
        // Its own outbound prompt is armed and is being REPLACED, so the
        // cancellation leads the new arming — the web's `beginConversation` is
        // literally a `clearTimeout` followed by a `setTimeout`, and a driver
        // handed only the arming would end up holding two timers.
        XCTAssertEqual(responder.inboundControl(request),
                       [.cancelConsentTimeout, .armConsentTimeout])
        XCTAssertEqual(responder.status, .incomingRequest, "the larger peer adopts the prompt")
    }

    func testDuplicateRequestWhilePromptingIsIgnored() {
        let l = lane(role: .responder)
        _ = l.inboundControl(request)
        XCTAssertEqual(l.inboundControl(request), [])
        XCTAssertEqual(l.status, .incomingRequest)
    }

    func testRequestWhileAlreadyOpenIsRefusedWithoutDisturbingTheConversation() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        XCTAssertEqual(l.inboundControl(request), [.sendControl(reject)])
        XCTAssertEqual(l.status, .open)
    }

    // MARK: - END is an ordering barrier, not a hangup

    /// A local END cannot identify the peer's last already-in-flight message.
    /// Those frames must still be fed to the receiver — otherwise the sequence
    /// the peer has already spent is never consumed — but must never be shown.
    func testFramesArrivingAfterALocalEndAreDrainedNotRendered() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64), [.feedProtected(discard: true)])
        XCTAssertFalse(l.codecsPoisoned)
    }

    func testThePeersSymmetricEndClosesTheDrainWindow() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        _ = l.inboundProtectedFrame(byteCount: 64)
        XCTAssertEqual(l.inboundControl(end), [.cancelEndAckTimeout])
        // Past the barrier, an unexpected protected frame is a hard lane failure.
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64), [.poisonCodecs, .closeLane])
        XCTAssertEqual(l.status, .failed)
    }

    /// A REJECT emitted before the peer observed our END is still a complete
    /// ordered barrier for that conversation.
    func testRemoteRejectAcknowledgesAPendingEnd() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        XCTAssertEqual(l.inboundControl(reject), [.cancelEndAckTimeout])
        XCTAssertEqual(l.status, .ended)
        XCTAssertFalse(l.codecsPoisoned)
    }

    /// The peer ended first. This side answers with its own END — the symmetric
    /// barrier — but must not then acknowledge that acknowledgement forever.
    func testRemoteEndProducesExactlyOneSymmetricEnd() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        XCTAssertEqual(l.inboundControl(end), [.sendControl(end)])
        XCTAssertEqual(l.status, .ended)
        XCTAssertEqual(l.inboundControl(end), [], "no acknowledgement loop")
    }

    /// A REQUEST is ordered after every protected frame the peer sent for its
    /// previous conversation, so it closes the local-END drain window — and the
    /// END-ack timer that window was waiting on has to go with it, exactly as
    /// the web's `receiveRequest` pairs `awaitingEndAck = false` with
    /// `finishEndAck()`. Leaving it armed would let a timer belonging to a
    /// conversation that is already over outlive the consent prompt replacing
    /// it.
    func testInboundRequestCancelsAPendingEndAckTimer() {
        let l = lane(role: .responder)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        XCTAssertEqual(l.localEnd(), [.sendControl(end), .armEndAckTimeout])

        // The peer opens a new conversation instead of acknowledging.
        XCTAssertEqual(l.inboundControl(request), [.cancelEndAckTimeout, .armConsentTimeout],
                       "the cancellation leads, so a torn-down barrier never follows the new prompt")
        XCTAssertEqual(l.status, .incomingRequest)
        // The barrier is genuinely gone: its timer firing late is inert.
        XCTAssertEqual(l.endAckTimedOut(), [])
        XCTAssertFalse(l.codecsPoisoned)
    }

    /// Glare on the same window: a local END from `waitingAccept` arms the same
    /// barrier, and a crossing REQUEST must cancel it on that branch too.
    ///
    /// Deliberately NOT reached by reopening under the pending barrier — that is
    /// refused outright now, see
    /// `testReopeningIsRefusedWhileAnEndBarrierIsOutstanding`.
    func testInboundRequestCancelsABarrierArmedFromWaitingAccept() {
        let l = lane(role: .initiator)
        _ = l.localOpen()
        XCTAssertEqual(l.localEnd(),
                       [.cancelConsentTimeout, .sendControl(end), .armEndAckTimeout],
                       "this branch DOES hold a consent prompt, and it is cancelled")
        XCTAssertEqual(l.inboundControl(request), [.cancelEndAckTimeout, .armConsentTimeout])
        XCTAssertEqual(l.status, .incomingRequest)
        XCTAssertEqual(l.endAckTimedOut(), [], "the barrier is genuinely gone")
    }

    /// The other half of the claim: no spurious cancellation. A driver that is
    /// told to cancel a timer it never armed is being handed an approximate
    /// effect list, which is exactly what this state machine exists to avoid.
    func testAnOrdinaryRequestCancelsNoEndAckTimer() {
        let fresh = lane(role: .responder)
        XCTAssertEqual(fresh.inboundControl(request), [.armConsentTimeout])

        // …including after a barrier that was already acknowledged.
        let settled = lane(role: .responder)
        _ = settled.localOpen()
        _ = settled.inboundControl(accept)
        _ = settled.localEnd()
        XCTAssertEqual(settled.inboundControl(end), [.cancelEndAckTimeout])
        XCTAssertEqual(settled.inboundControl(request), [.armConsentTimeout],
                       "the barrier was closed once; it must not be closed twice")

        // …and while a conversation is open, where no END was ever sent.
        let open = lane(role: .responder)
        _ = open.localOpen()
        _ = open.inboundControl(accept)
        XCTAssertEqual(open.inboundControl(request), [.sendControl(reject)])
    }

    /// If the barrier never arrives, the codecs cannot be proven safe to reuse:
    /// an old protected frame may still be in flight. Fail THIS lane only.
    func testEndAckTimeoutPoisonsOnlyTheTextLane() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        XCTAssertEqual(l.endAckTimedOut(), [.poisonCodecs, .closeLane])
        XCTAssertEqual(l.status, .failed)
        XCTAssertTrue(l.codecsPoisoned)
    }

    func testAPoisonedLaneRefusesToReopen() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        _ = l.endAckTimedOut()
        XCTAssertEqual(l.localOpen(), [])
        XCTAssertEqual(l.status, .failed)
    }

    // MARK: - consent has a bounded exit

    func testUnansweredConsentPromptEndsItself() {
        let l = lane(role: .responder)
        _ = l.inboundControl(request)
        // No ACCEPT was sent, so the peer could never enter its protected send
        // state. REJECT is the complete barrier and — unlike END — cannot
        // produce a stale acknowledgement that cancels a reopened request.
        XCTAssertEqual(l.consentTimedOut(), [.sendControl(reject)])
        XCTAssertEqual(l.status, .ended)
        XCTAssertFalse(l.codecsPoisoned)
    }

    func testUnansweredOutboundRequestEndsItself() {
        let l = lane()
        _ = l.localOpen()
        XCTAssertEqual(l.consentTimedOut(), [.sendControl(end), .armEndAckTimeout])
        XCTAssertEqual(l.status, .ended)
    }

    /// An ACCEPT that crossed our timeout is an ordered barrier for the attempt
    /// it belongs to: authenticate what follows, render none of it.
    func testLateAcceptOpensADiscardOnlyDrain() {
        let l = lane()
        _ = l.localOpen()
        _ = l.consentTimedOut()
        XCTAssertEqual(l.inboundControl(accept), [])
        XCTAssertEqual(l.status, .ended)
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64), [.feedProtected(discard: true)])
        XCTAssertFalse(l.codecsPoisoned)
    }

    // MARK: - protected frames outside a conversation

    /// A later conversation's acceptance cannot authorize content sent before
    /// it — and dropping the frame instead would desynchronise the link-scoped
    /// nonce, so this is a hard lane failure rather than a silent discard.
    func testProtectedFrameWithNoConversationFailsTheLane() {
        let l = lane()
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64), [.poisonCodecs, .closeLane])
        XCTAssertEqual(l.status, .failed)
    }

    /// …and the consent prompt that is still armed over it goes with it. The
    /// web's `markFailed` finishes both timers; a lane that only changed its own
    /// status would leave the driver holding a callback into a terminal lane.
    func testProtectedFrameBeforeLocalConsentFailsTheLane() {
        let l = lane(role: .responder)
        _ = l.inboundControl(request)
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64),
                       [.cancelConsentTimeout, .poisonCodecs, .closeLane])
    }

    // MARK: - flooding

    /// Lifecycle controls consume no AEAD sequence, so a flood may close this
    /// channel generation without poisoning codecs a replacement transport
    /// could still use.
    func testLifecycleFloodClosesTheLaneWithoutPoisoningCodecs() {
        let l = lane(role: .responder)
        for _ in 0..<(LINK_TEXT_BURST + 1) { _ = l.inboundControl(request) }
        XCTAssertEqual(l.status, .failed)
        XCTAssertFalse(l.codecsPoisoned,
                       "a replacement transport may still reuse these codecs")
    }

    /// A protected frame is the opposite case, and the difference is the whole
    /// reason the two buckets are separate. The frame was admitted in wire
    /// order; refusing to feed it leaves the receiver expecting a sequence the
    /// peer has already spent, which no replacement transport can repair.
    func testProtectedFrameBurstIsBoundedPerConversation() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        for i in 0..<LINK_TEXT_BURST {
            XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64),
                           [.feedProtected(discard: false)], "frame \(i) is inside the burst")
        }
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64), [.poisonCodecs, .closeLane])
        XCTAssertEqual(l.status, .failed)
        XCTAssertTrue(l.codecsPoisoned)
    }

    /// A token bucket, not a counter: a long, legitimate conversation must not
    /// eventually be refused. One second buys exactly `LINK_TEXT_PER_SEC`
    /// frames — not a fresh burst.
    func testProtectedFrameBucketRefillsAtTheAgreedRate() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        for _ in 0..<LINK_TEXT_BURST { _ = l.inboundProtectedFrame(byteCount: 64) }

        clock.advance(1)
        for i in 0..<Int(LINK_TEXT_PER_SEC) {
            XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64),
                           [.feedProtected(discard: false)], "refilled token \(i)")
        }
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64), [.poisonCodecs, .closeLane],
                       "one second buys five frames, not twenty")
    }

    /// The message cap, distinct from the rate: the clock is moved deliberately
    /// so the bucket is never the thing that refuses.
    func testProtectedFrameCountIsCappedPerConversation() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        for i in 0..<LINK_TEXT_SESSION_MAX_MESSAGES {
            clock.advance(1)
            XCTAssertEqual(l.inboundProtectedFrame(byteCount: 8),
                           [.feedProtected(discard: false)], "message \(i)")
        }
        clock.advance(1)
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 8), [.poisonCodecs, .closeLane])
    }

    /// The two buckets are independent in BOTH directions. Nineteen lifecycle
    /// controls buy nothing from the conversation, and twenty protected frames
    /// buy nothing from the channel generation.
    func testTheLifecycleAndProtectedFrameBucketsAreIndependent() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)                                    // token 1
        for _ in 0..<(LINK_TEXT_BURST - 2) {                            // tokens 2…19
            XCTAssertEqual(l.inboundControl(request), [.sendControl(reject)])
        }
        for i in 0..<LINK_TEXT_BURST {
            XCTAssertEqual(l.inboundProtectedFrame(byteCount: 8),
                           [.feedProtected(discard: false)],
                           "protected frame \(i) still has its own full burst")
        }
        XCTAssertEqual(l.status, .open)
        XCTAssertEqual(l.inboundControl(request), [.sendControl(reject)],
                       "the twentieth lifecycle token was never spent by a text frame")
        XCTAssertEqual(l.inboundControl(request), [.closeLane])
        XCTAssertFalse(l.codecsPoisoned,
                       "a lifecycle flood is still only a channel-generation problem")
    }

    // MARK: - a drain spends the conversation it belongs to

    /// A drain is the SAME conversation with its plaintext withheld, so it keeps
    /// spending the budget that conversation was already spending. The web
    /// captures the budget object at the END for exactly this reason: otherwise
    /// a peer buys a fresh burst, 500 messages and 4 MiB simply by getting this
    /// side to end.
    func testDrainedFramesKeepSpendingTheEndedConversationsBudget() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        for _ in 0..<15 { _ = l.inboundProtectedFrame(byteCount: 64) }
        _ = l.localEnd()

        for i in 0..<5 {
            XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64),
                           [.feedProtected(discard: true)],
                           "drained frame \(i) completes the ORIGINAL burst")
        }
        // The barrier this drain was running under is still armed, so failing
        // the lane cancels it on the way out.
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64),
                       [.cancelEndAckTimeout, .poisonCodecs, .closeLane],
                       "the drain inherited the spend; it did not get a fresh one")
    }

    /// The same claim for bytes, which the rate bucket cannot stand in for.
    func testDrainedFramesKeepSpendingTheEndedConversationsByteBudget() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        let half = LINK_TEXT_SESSION_MAX_BYTES / 2
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: half),
                       [.feedProtected(discard: false)])
        _ = l.localEnd()

        clock.advance(60)                       // the rate is not what is under test
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: half),
                       [.feedProtected(discard: true)], "exactly the cap still fits")
        clock.advance(60)
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 1),
                       [.cancelEndAckTimeout, .poisonCodecs, .closeLane],
                       "one byte past the ENDED conversation's cap")
    }

    /// The counterpart: a conversation that closed COMPLETELY is finished with
    /// its budget, and the next one starts full — at the very same instant, so
    /// this is a new budget rather than a refill.
    func testAFullyClosedConversationLeavesTheNextOneAFreshBudget() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        for _ in 0..<LINK_TEXT_BURST { _ = l.inboundProtectedFrame(byteCount: 64) }
        _ = l.localEnd()
        _ = l.inboundControl(end)               // the peer's ordered barrier
        XCTAssertFalse(l.codecsPoisoned)

        _ = l.localOpen()
        _ = l.inboundControl(accept)
        XCTAssertEqual(l.status, .open)
        for i in 0..<LINK_TEXT_BURST {
            XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64),
                           [.feedProtected(discard: false)],
                           "the clock never moved: frame \(i) proves a NEW budget")
        }
    }

    /// …and a later conversation cannot reach BACKWARDS into a drain that is
    /// still running. No transition mints a budget while a drain is live, and
    /// this is the reachable statement of that: the barrier this side is waiting
    /// on refuses the reopen outright, so the drain's spend survives the attempt.
    func testALaterConsentWindowCannotRefillALiveDrain() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        for _ in 0..<LINK_TEXT_BURST { _ = l.inboundProtectedFrame(byteCount: 64) }
        _ = l.localEnd()

        XCTAssertEqual(l.localOpen(), [], "no new consent window under an open barrier")
        XCTAssertEqual(l.status, .ended)
        XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64),
                       [.cancelEndAckTimeout, .poisonCodecs, .closeLane],
                       "the drain is still exhausted")
    }

    // MARK: - timer ownership

    /// The web's `openWith` gates on `active()`, and `active()` includes an
    /// outstanding END barrier. Reopening under one would emit a REQUEST that
    /// the peer's pending acknowledgement of the PREVIOUS conversation can
    /// cancel, and would arm a second consent window beneath a barrier that has
    /// not closed. Relying on the acknowledgement being inert is not the same
    /// property: it is not late, it is on time for a conversation this side has
    /// not finished ending.
    func testReopeningIsRefusedWhileAnEndBarrierIsOutstanding() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        XCTAssertEqual(l.status, .ended)
        XCTAssertEqual(l.localOpen(), [])
        XCTAssertEqual(l.status, .ended, "no second consent window under the barrier")

        // Once the peer's ordered marker closes it, the lane reopens normally.
        XCTAssertEqual(l.inboundControl(end), [.cancelEndAckTimeout])
        XCTAssertEqual(l.localOpen(), [.sendControl(request), .armConsentTimeout])
    }

    /// A lane that fails hands back the cancellations for everything it was
    /// holding, on the END-ack side as well as the consent side.
    func testFailingTheLaneCancelsAnArmedEndAckBarrier() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)                        // lifecycle token 1
        XCTAssertEqual(l.localEnd(), [.sendControl(end), .armEndAckTimeout])
        // An ACCEPT past a closed attempt is inert but still costs a token, so
        // the lane can be flooded while the barrier is outstanding.
        for _ in 0..<(LINK_TEXT_BURST - 1) {
            XCTAssertEqual(l.inboundControl(accept), [])
        }
        XCTAssertEqual(l.inboundControl(accept), [.cancelEndAckTimeout, .closeLane])
        XCTAssertFalse(l.codecsPoisoned)
    }

    /// The other half of the rule: a timer that is FIRING is not armed any more,
    /// so its own transition must never ask the driver to cancel it.
    func testAFiringEndAckTimerCancelsNothing() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        XCTAssertEqual(l.endAckTimedOut(), [.poisonCodecs, .closeLane])
    }

    func testAFiringConsentTimerCancelsNothing() {
        let l = lane()
        _ = l.localOpen()
        XCTAssertEqual(l.consentTimedOut(), [.sendControl(end), .armEndAckTimeout])
        XCTAssertEqual(l.inboundControl(end), [.cancelEndAckTimeout],
                       "the barrier it armed is the only timer left to cancel")
    }

    // MARK: - transport gaps

    /// An interrupted conversation ends VISIBLY and replays nothing. Its
    /// transcript survives; its consent does not.
    func testTransportGapEndsAnOpenConversationVisibly() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        XCTAssertTrue(l.transportGap().needsRecovery)
        XCTAssertEqual(l.status, .ended)
        XCTAssertFalse(l.codecsPoisoned)
        XCTAssertFalse(l.maySendProtected, "consent does not survive a transport it was not given on")
    }

    func testTransportGapIsIdempotent() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        XCTAssertTrue(l.transportGap().needsRecovery)
        XCTAssertFalse(l.transportGap().needsRecovery, "one gap, however many callbacks report it")
    }

    /// An idle lane has nothing worth spending a recovery window — and the
    /// initiator's ICE/TURN allocations — on.
    func testIdleLaneDoesNotClaimRecovery() {
        XCTAssertFalse(lane().transportGap().needsRecovery)
    }

    /// `send()` only enqueues. If bytes remain buffered when the transport
    /// dies, the sender nonce may have advanced without the peer ever seeing
    /// the frame — which no replacement transport can repair.
    func testUnflushedProtectedSendPoisonsTheLaneAtAGap() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        l.didSendProtected()
        let gap = l.transportGap(bufferedBytes: 4096)
        XCTAssertEqual(gap.needsRecovery, false)
        // Poisoning the codecs and closing the lane are things only the DRIVER
        // can do. An outcome that reported neither told it a transport had
        // dropped and nothing about the lane that drop had just condemned.
        XCTAssertEqual(gap.effects, [.poisonCodecs, .closeLane])
        XCTAssertTrue(l.codecsPoisoned)
        XCTAssertEqual(l.status, .failed)
    }

    /// A gap ends the conversation, so it owns the cancellation of the prompt
    /// that conversation was waiting on — exactly as the web's
    /// `markTransportInterrupted` calls `finishConsent` before it looks at
    /// anything else.
    func testATransportGapCancelsTheConsentPromptItEnds() {
        let l = lane()
        _ = l.localOpen()
        let gap = l.transportGap()
        XCTAssertTrue(gap.needsRecovery)
        XCTAssertEqual(gap.effects, [.cancelConsentTimeout])
        XCTAssertEqual(l.status, .ended)
    }

    func testATransportGapCancelsTheEndAckBarrierItEnds() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        let gap = l.transportGap()
        XCTAssertTrue(gap.needsRecovery, "an outstanding barrier is still work")
        XCTAssertEqual(gap.effects, [.cancelEndAckTimeout])
        XCTAssertEqual(l.status, .ended)
    }

    func testAnIdleGapCancelsNothing() {
        let gap = lane().transportGap()
        XCTAssertFalse(gap.needsRecovery)
        XCTAssertEqual(gap.effects, [])
    }

    func testASecondGapCallbackCancelsNothingTwice() {
        let l = lane()
        _ = l.localOpen()
        XCTAssertEqual(l.transportGap().effects, [.cancelConsentTimeout])
        XCTAssertEqual(l.transportGap().effects, [],
                       "one gap, however many callbacks report it")
    }

    func testFlushedProtectedSendSurvivesAGap() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        l.didSendProtected()
        XCTAssertTrue(l.transportGap(bufferedBytes: 0).needsRecovery)
        XCTAssertFalse(l.codecsPoisoned)
    }

    /// A terminal lane withdraws its claim: nothing a replacement transport
    /// could restore is left, so continuing to hold the whole link would spend
    /// the recovery window on a lane that is over.
    func testTerminalLaneWithdrawsItsRecoveryClaim() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        _ = l.endAckTimedOut()
        XCTAssertFalse(l.transportGap().needsRecovery)
    }

    // MARK: - reattachment

    /// A resumed transport is a new channel object but the same authenticated
    /// link. The transcript is retained and the interrupted conversation stays
    /// visibly ended — text is deliberately never replayed across a gap.
    func testReattachSurfacesAnInterruptedConversationAsEnded() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.transportGap()
        XCTAssertEqual(l.didAttachReplacementTransport(), [])
        XCTAssertEqual(l.status, .ended)
        XCTAssertFalse(l.maySendProtected)
        // …and the lane is usable again.
        XCTAssertEqual(l.localOpen(), [.sendControl(request), .armConsentTimeout])
    }

    func testAPoisonedLaneRefusesAReplacementTransport() {
        let l = lane()
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        _ = l.localEnd()
        _ = l.endAckTimedOut()
        XCTAssertEqual(l.didAttachReplacementTransport(), [])
        XCTAssertEqual(l.status, .failed)
        XCTAssertEqual(l.localOpen(), [])
    }

    /// A driver that attaches a replacement without routing the gap first would
    /// otherwise keep a prompt armed over a conversation this attachment has
    /// already declared ended. The web's `attach` finishes both timers for the
    /// same reason.
    func testReplacementAttachmentCancelsAStillArmedPrompt() {
        let l = lane()
        _ = l.localOpen()
        XCTAssertEqual(l.didAttachReplacementTransport(), [.cancelConsentTimeout])
        XCTAssertEqual(l.status, .ended)
    }

    func testReplacementAttachmentAfterAGapCancelsNothingTwice() {
        let l = lane()
        _ = l.localOpen()
        XCTAssertEqual(l.transportGap().effects, [.cancelConsentTimeout])
        XCTAssertEqual(l.didAttachReplacementTransport(), [],
                       "the prompt was cancelled once; it must not be cancelled twice")
    }

    /// A replacement channel starts both buckets full: the lifecycle bucket is
    /// scoped to the transport generation, and there is no conversation left for
    /// the previous protected-frame budget to belong to.
    func testAReplacementTransportRefillsBothBuckets() {
        let clock = TestClock()
        let l = lane(clock: clock)
        _ = l.localOpen()
        _ = l.inboundControl(accept)
        for _ in 0..<LINK_TEXT_BURST { _ = l.inboundProtectedFrame(byteCount: 64) }
        _ = l.transportGap()
        XCTAssertEqual(l.didAttachReplacementTransport(), [])

        _ = l.localOpen()
        _ = l.inboundControl(accept)
        for i in 0..<LINK_TEXT_BURST {
            XCTAssertEqual(l.inboundProtectedFrame(byteCount: 64),
                           [.feedProtected(discard: false)],
                           "frame \(i) on the replacement, at the same instant")
        }
    }
}

private extension LinkTextLane {
    /// Nothing in this lane may ever close the peer link itself: the file lane
    /// is independent and must survive every text-lane outcome.
    var effectsIncludeLinkTeardown: Bool { false }
}
