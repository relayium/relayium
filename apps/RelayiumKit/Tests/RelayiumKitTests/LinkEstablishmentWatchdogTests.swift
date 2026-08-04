import XCTest
@testable import RelayiumKit

/// When an unfinished `link/1` establishment gives up, and why.
///
/// Every case here is a question about ninety seconds of behaviour, answered in
/// microseconds, because the watchdog is handed the time rather than reading a
/// clock. The one thing a live test could add — that the wake-up actually fires
/// — is covered against the real driver in `WebRTCLinkTransportTests`.
final class LinkEstablishmentWatchdogTests: XCTestCase {

    /// Short, distinct, and nothing like each other, so a test that passes for
    /// the wrong reason is visible.
    private let deadlines = LinkDeadlines(setupHardCap: 100,
                                          noProgress: 10,
                                          keyReveal: 20,
                                          maxCandidateProgress: 3)

    private func watchdog(start: TimeInterval = 0) -> LinkEstablishmentWatchdog {
        LinkEstablishmentWatchdog(start: start, deadlines: deadlines)
    }

    // MARK: - the no-progress deadline

    func testAnEstablishmentWithNoProgressAtAllExpiresOnTheNoProgressDeadline() {
        let watchdog = self.watchdog()
        XCTAssertEqual(watchdog.deadline, 10)
        XCTAssertNil(watchdog.expiry(at: 9.99))
        XCTAssertEqual(watchdog.expiry(at: 10), .noProgress)
    }

    /// A connection that is genuinely progressing must not be cut off. A phone
    /// radio waking, two TURN Allocates and hole punching legitimately exceed
    /// one flat window.
    func testGenuineMilestonesReArmTheNoProgressDeadline() {
        var watchdog = self.watchdog()
        XCTAssertEqual(watchdog.note(.remoteAnswer, at: 8), .rearmed)
        XCTAssertEqual(watchdog.deadline, 18)
        XCTAssertNil(watchdog.expiry(at: 17))

        XCTAssertEqual(watchdog.note(.laneOpened(.file), at: 16), .rearmed)
        XCTAssertEqual(watchdog.deadline, 26)
        XCTAssertEqual(watchdog.expiry(at: 26), .noProgress)
    }

    /// Identity IS the key: nothing a peer can repeat buys a second extension.
    func testARepeatedMilestoneBuysNoTime() {
        var watchdog = self.watchdog()
        XCTAssertEqual(watchdog.note(.laneOpened(.file), at: 5), .rearmed)
        XCTAssertEqual(watchdog.deadline, 15)
        XCTAssertEqual(watchdog.note(.laneOpened(.file), at: 14), .unchanged,
                       "the same lane reported open twice is one milestone")
        XCTAssertEqual(watchdog.deadline, 15)
        XCTAssertEqual(watchdog.expiry(at: 15), .noProgress)
    }

    /// Candidates are the one input a peer can produce without limit, so they
    /// are budgeted rather than remembered.
    func testRemoteCandidatesReArmOnlyUpToTheirBudget() {
        var watchdog = self.watchdog()
        for index in 0..<deadlines.maxCandidateProgress {
            XCTAssertEqual(watchdog.note(.remoteCandidate, at: TimeInterval(index)), .rearmed,
                           "candidate \(index) is inside the budget")
        }
        XCTAssertEqual(watchdog.deadline, 12)
        XCTAssertEqual(watchdog.note(.remoteCandidate, at: 11), .unchanged, "the budget is spent")
        XCTAssertEqual(watchdog.deadline, 12, "and the deadline did not move")
    }

    /// The attack the whole design exists for. Two independent things stop it,
    /// and this is the inner one: the budget runs out, and the establishment
    /// then dies on the ordinary no-progress deadline long before the hard cap
    /// is even in sight.
    func testACandidateFloodStopsBuyingTimeOnceTheBudgetIsSpent() {
        var watchdog = self.watchdog()
        var now: TimeInterval = 0
        while now < 200 {
            watchdog.note(.remoteCandidate, at: now)
            if let expiry = watchdog.expiry(at: now) {
                XCTAssertEqual(expiry, .noProgress)
                // Three candidates at 0, 1, 2 re-arm; the last one expires at 12.
                XCTAssertEqual(now, 12)
                return
            }
            now += 1
        }
        XCTFail("a candidate flood was never cut off")
    }

    // MARK: - the hard cap

    /// The outer stop, tested with the budget deliberately taken out of the
    /// picture: even a milestone stream that genuinely re-arms every few seconds
    /// for the whole window cannot move the total, and the cap is what gets
    /// reported when both have passed. The truthful answer to "why did this end"
    /// is the bound that could not be extended.
    func testTheHardCapIsNeverReArmedByAnEndlessStreamOfProgress() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0, deadlines: LinkDeadlines(setupHardCap: 100,
                                               noProgress: 10,
                                               keyReveal: 20,
                                               maxCandidateProgress: .max))
        for step in stride(from: 5.0, through: 95.0, by: 5.0) {
            XCTAssertEqual(watchdog.note(.remoteCandidate, at: step), .rearmed,
                           "still genuinely progressing at \(step)")
        }
        XCTAssertNil(watchdog.expiry(at: 99.9), "no-progress alone would not have fired")
        XCTAssertEqual(watchdog.expiry(at: 100), .setup)
        XCTAssertEqual(watchdog.deadline, 100,
                       "no amount of progress moved the outer bound")
    }

    // MARK: - the key-reveal deadline

    /// The exact state it exists for: the lanes are open and healthy, and the
    /// only thing still owed is one signalling message that may never come —
    /// the socket dropped after the answer, or the peer's process was frozen.
    ///
    /// Both lanes open is also the END of the transport phase, so the
    /// no-progress deadline is retired at the same instant rather than left to
    /// race the reveal window it was replaced by.
    func testBothLanesOpenRetireTheNoProgressDeadlineAndArmTheKeyRevealOne() {
        var watchdog = self.watchdog()
        watchdog.note(.laneOpened(.file), at: 5)
        XCTAssertEqual(watchdog.deadline, 15, "one lane is not both")

        watchdog.note(.laneOpened(.text), at: 6)
        XCTAssertEqual(watchdog.deadline, 26, "lanes open at 6 + a 20 s reveal window")
        XCTAssertNil(watchdog.expiry(at: 25),
                     "the no-progress deadline it replaced would have fired at 16")
        XCTAssertEqual(watchdog.expiry(at: 26), .keyReveal)
    }

    /// The production regression this pair of values hides: shipped no-progress
    /// and shipped key-reveal are both 30 s, so a second lane opening used to
    /// set them to the SAME instant — and `expiry` consults no-progress first.
    /// Every real two-lane establishment that lost its peer's reveal therefore
    /// reported "the peer stopped answering" for a connection whose lanes were
    /// open and healthy, and `.keyReveal` could not occur in production at all.
    func testTheShippedDeadlinesReportAMissingRevealAsKeyRevealNotNoProgress() {
        var watchdog = LinkEstablishmentWatchdog(start: 0)
        watchdog.note(.laneOpened(.file), at: 1)
        watchdog.note(.laneOpened(.text), at: 2)
        XCTAssertEqual(watchdog.deadline, 32, "lanes open at 2 + the shipped 30 s window")
        XCTAssertNil(watchdog.expiry(at: 31.9))
        XCTAssertEqual(watchdog.expiry(at: 32), .keyReveal)
    }

    /// Simultaneous expiry still reports the bound that could not be extended.
    func testTheHardCapOutranksAKeyRevealDeadlineThatExpiresAtTheSameInstant() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0, deadlines: LinkDeadlines(setupHardCap: 10, noProgress: 30, keyReveal: 8))
        watchdog.note(.laneOpened(.file), at: 1)
        watchdog.note(.laneOpened(.text), at: 2)
        XCTAssertEqual(watchdog.deadline, 10, "the reveal window lands exactly on the cap")
        XCTAssertEqual(watchdog.expiry(at: 10), .setup)
    }

    /// Measured from the lanes opening, so a setup that spent most of its budget
    /// legitimately progressing does not then get a fresh full window — the hard
    /// cap still bounds it.
    func testTheKeyRevealDeadlineIsTheOneThatExpiresWhenNothingElseIsPending() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0, deadlines: LinkDeadlines(setupHardCap: 100, noProgress: 30, keyReveal: 5))
        watchdog.note(.laneOpened(.file), at: 1)
        watchdog.note(.laneOpened(.text), at: 2)
        XCTAssertEqual(watchdog.deadline, 7, "lanes open at 2 + a 5 s reveal window")
        XCTAssertEqual(watchdog.expiry(at: 7), .keyReveal)
    }

    /// The reveal arrived. There is nothing left for that deadline to protect.
    func testAuthenticationRetiresTheKeyRevealDeadline() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0, deadlines: LinkDeadlines(setupHardCap: 100, noProgress: 30, keyReveal: 5))
        watchdog.note(.laneOpened(.file), at: 1)
        watchdog.note(.laneOpened(.text), at: 2)
        XCTAssertEqual(watchdog.deadline, 7)

        watchdog.note(.authenticated, at: 3)
        XCTAssertEqual(watchdog.deadline, 100,
                       "both lanes are open and the reveal has arrived: only the cap is left")
        XCTAssertNil(watchdog.expiry(at: 7))
    }

    /// The other order — the reveal races ahead of the lanes, which is normal
    /// for a responder — must not arm a window for something already delivered.
    func testLanesOpeningAfterAuthenticationNeverArmTheKeyRevealDeadline() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0, deadlines: LinkDeadlines(setupHardCap: 100, noProgress: 30, keyReveal: 5))
        watchdog.note(.authenticated, at: 1)
        watchdog.note(.laneOpened(.file), at: 2)
        XCTAssertEqual(watchdog.deadline, 32, "one lane is still the transport phase")
        watchdog.note(.laneOpened(.text), at: 3)
        XCTAssertEqual(watchdog.deadline, 100,
                       "the second lane retires no-progress and arms nothing in its place")
        XCTAssertNil(watchdog.expiry(at: 10))
    }

    // MARK: - a late milestone never resurrects an expired establishment

    /// The hazard is ordinary scheduling, not a hostile peer: the wake-up is a
    /// `DispatchWorkItem`, and one queued behind a slow callback — or behind a
    /// device that suspended — runs late. If a milestone that arrived in that
    /// window could re-arm, an establishment that has already exceeded its
    /// deadline gets a fresh one, and the bound stops being a bound.
    func testAMilestoneAfterTheNoProgressDeadlineNeverResurrectsIt() {
        var watchdog = self.watchdog()
        XCTAssertEqual(watchdog.expiry(at: 10), .noProgress)

        XCTAssertEqual(watchdog.note(.remoteAnswer, at: 10), .expired(.noProgress),
                       "at the deadline is already past it")
        XCTAssertEqual(watchdog.deadline, 10, "and nothing moved")
        XCTAssertEqual(watchdog.expiry(at: 10), .noProgress)

        XCTAssertEqual(watchdog.note(.laneOpened(.file), at: 60), .expired(.noProgress))
        XCTAssertEqual(watchdog.deadline, 10)
    }

    func testAMilestoneAfterTheKeyRevealDeadlineNeverResurrectsIt() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0, deadlines: LinkDeadlines(setupHardCap: 100, noProgress: 30, keyReveal: 5))
        watchdog.note(.laneOpened(.file), at: 1)
        watchdog.note(.laneOpened(.text), at: 2)
        XCTAssertEqual(watchdog.expiry(at: 7), .keyReveal)

        XCTAssertEqual(watchdog.note(.remoteCandidate, at: 7), .expired(.keyReveal))
        XCTAssertEqual(watchdog.deadline, 7)
        // Not even the reveal the window was waiting for: it arrived after the
        // link had already been given up on, and the peer is entitled to assume
        // this side is gone.
        XCTAssertEqual(watchdog.note(.authenticated, at: 8), .expired(.keyReveal))
        XCTAssertEqual(watchdog.deadline, 7)
        XCTAssertEqual(watchdog.expiry(at: 8), .keyReveal)
    }

    /// No-progress is deliberately out of reach here, so the cap is the first
    /// bound to pass and the reason reported is unambiguous.
    func testAMilestoneAtOrAfterTheHardCapNeverResurrectsIt() {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0, deadlines: LinkDeadlines(setupHardCap: 100, noProgress: 200, keyReveal: 20))
        watchdog.note(.remoteOffer, at: 95)
        XCTAssertEqual(watchdog.expiry(at: 100), .setup)

        XCTAssertEqual(watchdog.note(.laneOpened(.file), at: 100), .expired(.setup),
                       "at the cap is already past it")
        XCTAssertEqual(watchdog.note(.laneOpened(.text), at: 101), .expired(.setup))
        XCTAssertEqual(watchdog.deadline, 100,
                       "and no reveal window was armed on the way out")
        XCTAssertEqual(watchdog.expiry(at: 101), .setup)
    }

    // MARK: - disarming

    /// Publication, failure or teardown. Permanent, so a wake-up already in
    /// flight cannot resurrect a deadline.
    func testDisarmingIsPermanent() {
        var watchdog = self.watchdog()
        watchdog.disarm()
        XCTAssertFalse(watchdog.isArmed)
        XCTAssertNil(watchdog.deadline)
        XCTAssertNil(watchdog.expiry(at: 1_000_000))
        XCTAssertEqual(watchdog.note(.remoteAnswer, at: 1), .unchanged, "and nothing re-arms it")
        XCTAssertNil(watchdog.deadline)
    }

    // MARK: - the shipped values

    /// Pinned to the deployed web client. Two peers that disagree about how long
    /// they are willing to wait produce a link where one has given up and the
    /// other is still holding a PeerConnection open.
    func testTheShippedDeadlinesMatchTheDeployedWebClient() {
        XCTAssertEqual(LINK_SETUP_HARD_CAP_SECONDS, 90)
        XCTAssertEqual(LINK_NO_PROGRESS_TIMEOUT_SECONDS, 30)
        XCTAssertEqual(LINK_KEY_REVEAL_TIMEOUT_SECONDS, 30)
        XCTAssertEqual(LINK_MAX_CANDIDATE_PROGRESS, 6)

        let defaults = LinkDeadlines()
        XCTAssertEqual(defaults.setupHardCap, LINK_SETUP_HARD_CAP_SECONDS)
        XCTAssertEqual(defaults.noProgress, LINK_NO_PROGRESS_TIMEOUT_SECONDS)
        XCTAssertEqual(defaults.keyReveal, LINK_KEY_REVEAL_TIMEOUT_SECONDS)
        XCTAssertEqual(defaults.maxCandidateProgress, LINK_MAX_CANDIDATE_PROGRESS)
    }

    /// The milestone set is closed, and the consequence is a statable bound.
    ///
    /// The TYPE admits five one-shot cases, because it has to describe both
    /// sides: `remoteOffer` and `remoteAnswer` are alternatives, not a pair.
    /// This is the type's bound, reached by offering every case in the order
    /// that lets each one move something.
    private func reArms(of milestones: [LinkMilestone], budget: Int = 3) -> Int {
        var watchdog = LinkEstablishmentWatchdog(
            start: 0, deadlines: LinkDeadlines(setupHardCap: 1_000_000,
                                               noProgress: 10,
                                               keyReveal: 20,
                                               maxCandidateProgress: budget))
        var count = 0
        // Every one offered repeatedly: a second pass may not buy anything.
        for round in 0..<10 {
            for milestone in milestones
            where watchdog.note(milestone, at: TimeInterval(round)) == .rearmed {
                count += 1
            }
        }
        return count
    }

    func testTheTypeAdmitsFiveOneShotMilestonesPlusTheCandidateBudget() {
        // Candidates first: once both lanes are open the transport phase is
        // over, so that is where the budget can still be spent.
        let everything: [LinkMilestone] = [.remoteCandidate, .remoteCandidate, .remoteCandidate,
                                           .remoteCandidate, .remoteOffer, .remoteAnswer,
                                           .laneOpened(.file), .laneOpened(.text), .authenticated]
        XCTAssertEqual(reArms(of: everything), 5 + 3,
                       "five one-shot cases plus the candidate budget, and nothing more")
    }

    /// What one real establishment can observe, which is one FEWER: `linkRole`
    /// makes the role deterministic, so a responder is offered to and an
    /// initiator is answered — never both. The type's fifth case belongs to the
    /// other side.
    func testOneDeterministicRoleObservesAtMostFourOfThem() {
        let responder: [LinkMilestone] = [.remoteCandidate, .remoteCandidate, .remoteCandidate,
                                          .remoteCandidate, .remoteOffer,
                                          .laneOpened(.file), .laneOpened(.text), .authenticated]
        let initiator: [LinkMilestone] = [.remoteCandidate, .remoteCandidate, .remoteCandidate,
                                          .remoteCandidate, .remoteAnswer,
                                          .laneOpened(.file), .laneOpened(.text), .authenticated]
        XCTAssertEqual(reArms(of: responder), 4 + 3)
        XCTAssertEqual(reArms(of: initiator), 4 + 3)
    }
}
