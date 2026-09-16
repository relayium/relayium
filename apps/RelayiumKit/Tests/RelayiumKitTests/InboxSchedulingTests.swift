import XCTest
@testable import RelayiumAppKit

/// The waiting, and the being woken out of it.
final class InboxSchedulingTests: XCTestCase {

    private let backoff = InboxBackoff()

    /// Bounded in both directions. The floor keeps an offline Mac from spinning a
    /// request a second; the ceiling is what makes "continues after the unique
    /// window closes" a promise rather than a hope — the loop never stops, it
    /// only slows.
    func testTheFailureCurveDoublesFromTheFirstDelayAndHoldsAtTheCap() {
        XCTAssertEqual(backoff.delay(afterFailures: 1), 5)
        XCTAssertEqual(backoff.delay(afterFailures: 2), 10)
        XCTAssertEqual(backoff.delay(afterFailures: 3), 20)
        XCTAssertEqual(backoff.delay(afterFailures: 6), 160)
        XCTAssertEqual(backoff.delay(afterFailures: 7), 300)
        XCTAssertEqual(backoff.delay(afterFailures: 8), 300)
    }

    /// A long outage must not be able to produce an unrepresentable interval on
    /// its way to the cap. A sleep of infinity is a STOPPED inbox, not a slow
    /// one, and `pow`-based doubling reaches it in about a thousand failures.
    func testAVeryLongOutageStillProducesTheCapAndNotInfinity() {
        for failures in [50, 500, 5_000, 1_000_000] {
            let delay = backoff.delay(afterFailures: failures)
            XCTAssertEqual(delay, backoff.cap, "\(failures) failures left the cap")
            XCTAssertTrue(delay.isFinite)
        }
    }

    func testNoFailuresIsTheIdlePollRatherThanTheFirstRetry() {
        XCTAssertEqual(backoff.delay(afterFailures: 0), backoff.idle)
    }

    /// A delivery was just worked, so the next pass is soon: deliveries arrive in
    /// batches and the sender is usually still watching.
    func testTheAfterWorkDelayIsShorterThanTheIdlePoll() {
        XCTAssertLessThan(backoff.afterWork, backoff.idle)
        XCTAssertGreaterThan(backoff.blocked, backoff.idle,
                             "polling a blocker as often as an idle inbox is a busy loop")
    }

    /// The wake has to come from OUTSIDE the sleeping context — a menu-bar click,
    /// a folder change, a resumed pause — or "Try again" is a button that appears
    /// to do nothing for the next four minutes.
    func testWakeEndsASleepInProgress() async {
        let sleeper = InboxTaskSleeper()
        let started = Date()
        async let slept: Void = sleeper.sleep(60)
        // Give the sleep a moment to register before waking it, so this measures
        // the wake rather than a race with it.
        try? await Task.sleep(nanoseconds: 20_000_000)
        sleeper.wake()
        await slept
        XCTAssertLessThan(Date().timeIntervalSince(started), 5,
                          "wake did not end the sleep in progress")
    }

    /// Waking when nothing is sleeping is a no-op, not a crash: every user
    /// control calls it, and most of the time the loop is mid-pass.
    func testWakingAnIdleSleeperIsSafe() {
        let sleeper = InboxTaskSleeper()
        sleeper.wake()
        sleeper.wake()
    }

    /// A wake that lands after the caller read its mark but before the sleep
    /// registered is honoured, not lost. This is the hop from the main actor into
    /// the sleeper, where "check now" used to be dropped and the loop waited out
    /// its whole idle interval.
    func testAWakeBeforeTheSleepRegistersIsNotLost() async {
        let sleeper = InboxTaskSleeper()
        let started = Date()
        let mark = sleeper.wakeMark()
        sleeper.wake()
        // Bounded: a lost wake costs this test 10 s, not a minute.
        await sleeper.sleep(10, unlessWokenSince: mark)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5,
                          "a wake between the mark and the sleep was lost")
    }

    /// A wake from BEFORE the mark is not replayed. Otherwise every control that
    /// wakes a loop mid-pass would make the next sleep return at once, turning
    /// each press into an extra round trip to central.
    func testAWakeBeforeTheMarkDoesNotShortenTheNextSleep() async {
        let sleeper = InboxTaskSleeper()
        sleeper.wake()
        sleeper.wake()
        let started = Date()
        await sleeper.sleep(0.3, unlessWokenSince: sleeper.wakeMark())
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 0.25,
                                    "a stale wake ended a later sleep")
        // And the plain `sleep` other callers use is unaffected by old wakes.
        let plain = Date()
        await sleeper.sleep(0.3)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(plain), 0.25)
    }

    /// The race itself, many times: a wake fired from another thread at the same
    /// instant the sleep registers must end that sleep in every ordering.
    ///
    /// Bounded in total: each sleep is 2 s and the loop stops at the first one
    /// that was not ended by its wake, so a broken sleeper costs one interval,
    /// not two hundred.
    func testConcurrentWakesAreNeverLost() async {
        let sleeper = InboxTaskSleeper()
        for round in 0..<200 {
            let started = Date()
            let mark = sleeper.wakeMark()
            let waker = Task.detached { sleeper.wake() }
            await sleeper.sleep(2, unlessWokenSince: mark)
            await waker.value
            if Date().timeIntervalSince(started) >= 1.5 {
                XCTFail("the concurrent wake in round \(round) was lost")
                return
            }
        }
    }

    /// A zero or negative interval returns immediately rather than registering a
    /// sleep nothing will ever wake.
    func testANonPositiveIntervalReturnsAtOnce() async {
        let sleeper = InboxTaskSleeper()
        await sleeper.sleep(0)
        await sleeper.sleep(-5)
    }
}
