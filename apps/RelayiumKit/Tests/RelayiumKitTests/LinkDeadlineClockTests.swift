import XCTest
@testable import RelayiumKit

/// The one `DispatchWorkItem` that turns `LinkEstablishmentWatchdog`'s decisions
/// into an actual wake-up.
///
/// Extracted because BOTH link drivers need it and the subtle parts are the same
/// in both: arming exactly once, cancelling a superseded wake-up, recognising
/// one that was already dispatched when a milestone moved the deadline, and
/// never re-arming after teardown. A second hand-written copy of that in a
/// replacement driver is the kind of code that drifts silently — the first
/// version of this logic lived inline, where the only way to exercise it was a
/// ninety-second establishment.
final class LinkDeadlineClockTests: XCTestCase {

    private func makeQueue() -> LinkTransportQueue {
        LinkTransportQueue(label: "im.relayium.LinkDeadlineClockTests")
    }

    /// Every method belongs to the owner's queue, so the tests speak from it too.
    private func on<T>(_ queue: LinkTransportQueue, _ body: () -> T) -> T {
        queue.sync(body)
    }

    // MARK: - arming

    func testAClockIsNotRunningUntilItIsArmed() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue, deadlines: LinkDeadlines())
        on(queue) {
            XCTAssertFalse(clock.isRunning)
            XCTAssertNil(clock.expiry(at: 10_000), "an unarmed clock expires nothing")
            XCTAssertNil(clock.note(.remoteOffer, at: 0), "and records nothing")
        }
    }

    /// Whichever of `start()` and the first acted-on signal happens first starts
    /// the clock; the second must not restart it.
    func testArmingIsIdempotent() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 90,
                                                               noProgress: 30,
                                                               keyReveal: 30))
        on(queue) {
            XCTAssertTrue(clock.arm(at: 0) {})
            XCTAssertFalse(clock.arm(at: 100) {}, "the second call does not restart the clock")
            XCTAssertTrue(clock.isRunning)
            XCTAssertEqual(clock.expiry(at: 31), .noProgress,
                           "the deadline is still measured from the first arming")
        }
    }

    // MARK: - expiry and progress

    func testExpiryReportsTheOutermostDeadlineThatHasPassed() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 90, noProgress: 30))
        on(queue) {
            clock.arm(at: 0) {}
            XCTAssertNil(clock.expiry(at: 29))
            XCTAssertEqual(clock.expiry(at: 30), .noProgress)
            XCTAssertEqual(clock.expiry(at: 90), .setup,
                           "when both have passed the reported reason is the one nothing extends")
        }
    }

    func testAMilestoneExtendsTheNoProgressDeadline() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 900, noProgress: 30))
        on(queue) {
            clock.arm(at: 0) {}
            XCTAssertNil(clock.note(.remoteOffer, at: 20))
            XCTAssertNil(clock.expiry(at: 45), "the deadline moved with the milestone")
            XCTAssertEqual(clock.expiry(at: 50), .noProgress)
        }
    }

    /// A wake-up queued behind a long client callback runs late, so an event can
    /// be served after the bound it was racing is gone. That event is not
    /// progress — it is the proof the establishment already lost.
    func testAMilestoneServedAfterItsDeadlineReportsTheExpiry() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 900, noProgress: 30))
        on(queue) {
            clock.arm(at: 0) {}
            XCTAssertEqual(clock.note(.remoteOffer, at: 31), .noProgress)
            XCTAssertEqual(clock.expiry(at: 31), .noProgress,
                           "and nothing was extended on the way out")
        }
    }

    // MARK: - the key-reveal window

    /// An establishment that still has to learn its peer's key gets the reveal
    /// window once both lanes are open.
    func testAnUnauthenticatedEstablishmentArmsTheKeyRevealWindow() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 900,
                                                               noProgress: 30,
                                                               keyReveal: 10))
        on(queue) {
            clock.arm(at: 0) {}
            clock.note(.laneOpened(.file), at: 1)
            clock.note(.laneOpened(.text), at: 1)
            XCTAssertEqual(clock.expiry(at: 11), .keyReveal)
        }
    }

    /// A REPLACEMENT has no key-reveal phase: its identity existed before its
    /// PeerConnection did. Arming that window would put a rebuild on a deadline
    /// for a message no peer is going to send, and would report `.keyReveal` for
    /// a link that was never waiting on a reveal.
    func testAPreAuthenticatedClockNeverArmsTheKeyRevealWindow() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 900,
                                                               noProgress: 30,
                                                               keyReveal: 10),
                                      identityPresent: true)
        on(queue) {
            clock.arm(at: 0) {}
            clock.note(.laneOpened(.file), at: 1)
            clock.note(.laneOpened(.text), at: 1)
            XCTAssertNil(clock.expiry(at: 500),
                         "both lanes open leaves a rebuild bounded only by the hard cap")
            XCTAssertEqual(clock.expiry(at: 900), .setup)
        }
    }

    // MARK: - the wake-up

    func testTheWakeUpFiresOnTheQueueWhenTheEarliestDeadlineArrives() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 30, noProgress: 0.05))
        let woke = expectation(description: "the wake-up fired")
        var onQueue = false
        on(queue) {
            clock.arm(at: 0) {
                onQueue = queue.isCurrent
                woke.fulfill()
            }
        }
        wait(for: [woke], timeout: 5)
        XCTAssertTrue(onQueue, "every deadline decision belongs to the owner's queue")
    }

    /// A work item already dispatched when a milestone rescheduled it cannot be
    /// cancelled any more, so it has to be able to recognise that it is stale.
    /// Firing it would hand the owner a deadline that has since moved.
    ///
    /// Both lanes opening on a pre-authenticated clock is the sharpest form of
    /// that: it retires the near no-progress deadline outright and leaves only
    /// the distant hard cap, so a wake-up that fired anyway would be reporting a
    /// bound that no longer exists.
    func testAWakeUpSupersededByAMilestoneDoesNotFire() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 30, noProgress: 0.2),
                                      identityPresent: true)
        var wakes = 0
        on(queue) {
            clock.arm(at: 0) { wakes += 1 }
            clock.note(.laneOpened(.file), at: 0)
            clock.note(.laneOpened(.text), at: 0)
        }
        let settled = expectation(description: "well past the original deadline")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.6) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        on(queue) { XCTAssertEqual(wakes, 0) }
    }

    /// Teardown cancels the wake-up, and a disarmed clock never re-arms — a
    /// timer that fired into a closed transport would report a failure to a
    /// consumer that had already been told it was gone.
    func testDisarmingIsPermanentAndCancelsThePendingWakeUp() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 30, noProgress: 0.05))
        var wakes = 0
        on(queue) {
            clock.arm(at: 0) { wakes += 1 }
            clock.disarm()
            XCTAssertFalse(clock.isRunning)
            XCTAssertFalse(clock.arm(at: 0) { wakes += 1 }, "a disarmed clock never re-arms")
            XCTAssertNil(clock.expiry(at: 10_000))
            XCTAssertNil(clock.note(.remoteOffer, at: 10_000))
        }
        let settled = expectation(description: "well past the deadline")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        on(queue) { XCTAssertEqual(wakes, 0) }
    }

    /// The same permanence from the other side: a clock disarmed BEFORE it was
    /// ever armed stays dead too.
    ///
    /// Not a hypothetical ordering. Teardown is reachable before `start()` and
    /// before the first acted-on signal — an owner that closes a rebuild it has
    /// just constructed, a `deinit` on a dropped candidate transport — and both
    /// drivers arm lazily from whichever of those comes first. Today they each
    /// hold a separate `closed` flag that happens to cover the gap, so the
    /// invariant this type documents is true only because of somebody else's
    /// state; a third owner, or a driver that stops checking `closed` before
    /// arming, revives a clock whose transport is already gone and hands its
    /// consumer a deadline failure after `onClose`.
    func testDisarmingBeforeArmingIsAlsoPermanent() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 30, noProgress: 0.05))
        var wakes = 0
        on(queue) {
            clock.disarm()
            XCTAssertFalse(clock.isRunning)
            XCTAssertFalse(clock.arm(at: 0) { wakes += 1 },
                           "a clock disarmed before it was armed never arms")
            XCTAssertFalse(clock.isRunning, "and arming it did not start it either")
            XCTAssertNil(clock.expiry(at: 10_000), "so it bounds nothing")
            XCTAssertNil(clock.note(.remoteOffer, at: 10_000), "and records nothing")
        }
        let settled = expectation(description: "well past the deadline that arm would have set")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        on(queue) { XCTAssertEqual(wakes, 0, "and no wake-up was ever scheduled") }
    }

    /// A milestone MOVES the one wake-up; it never adds a second. Two live work
    /// items for one establishment would report the same deadline twice, and the
    /// earlier one would report a bound that had already been extended.
    func testAMilestoneMovesTheWakeUpRatherThanAddingASecondOne() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 30, noProgress: 0.4))
        var wakes = 0
        let woke = expectation(description: "the moved wake-up fired")
        on(queue) {
            clock.arm(at: 0) {
                wakes += 1
                woke.fulfill()
            }
            clock.note(.remoteOffer, at: 0.3)
        }
        wait(for: [woke], timeout: 5)
        let settled = expectation(description: "past the superseded wake-up too")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { settled.fulfill() }
        wait(for: [settled], timeout: 3)
        on(queue) { XCTAssertEqual(wakes, 1) }
    }

    /// A wake-up that fired before its deadline — because a re-arm overtook it —
    /// must be able to put the clock back rather than leaving the establishment
    /// with no wake-up at all. That is the owner's move after it has checked
    /// `expiry` and survived.
    func testReschedulingRestoresAWakeUpForTheCurrentDeadline() {
        let queue = makeQueue()
        let clock = LinkDeadlineClock(queue: queue,
                                      deadlines: LinkDeadlines(setupHardCap: 30, noProgress: 0.05))
        var wakes = 0
        let twice = expectation(description: "the wake-up came back")
        on(queue) {
            clock.arm(at: 0) {
                wakes += 1
                if wakes < 2 {
                    // Nothing has expired on this clock's own reading of time,
                    // so the owner puts the wake-up back.
                    clock.reschedule(at: 0)
                } else {
                    twice.fulfill()
                }
            }
        }
        wait(for: [twice], timeout: 5)
        on(queue) {
            clock.disarm()
            XCTAssertEqual(wakes, 2)
        }
    }
}
