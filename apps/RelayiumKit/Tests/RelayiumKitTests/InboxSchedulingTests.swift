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

    /// A zero or negative interval returns immediately rather than registering a
    /// sleep nothing will ever wake.
    func testANonPositiveIntervalReturnsAtOnce() async {
        let sleeper = InboxTaskSleeper()
        await sleeper.sleep(0)
        await sleeper.sleep(-5)
    }
}
