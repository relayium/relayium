import XCTest
// @testable, not a plain import: `Meter`'s memberwise initializer is internal (the
// struct is public but declares no explicit `init`), so constructing one in a test
// needs testable access. Production code in RelayiumAppKit only *reads* Meter, which
// a plain import allows.
@testable import RelayiumKit
@testable import RelayiumAppKit

final class UsagePresentationTests: XCTestCase {
    // cap == 0 means unlimited. A bar that divides by cap breaks on exactly the
    // plans that matter most.
    func testUnlimitedMeterHasNoFraction() {
        let d = UsagePresentation.display(Meter(used: 2_097_152, cap: 0), language: .en)
        XCTAssertTrue(d.isUnlimited)
        XCTAssertNil(d.fraction)
        XCTAssertEqual(d.capText, "Unlimited")
        XCTAssertEqual(d.usedText, "2.0 MB")
    }
    func testCappedMeterComputesFraction() {
        let d = UsagePresentation.display(Meter(used: 1_073_741_824, cap: 5_368_709_120), language: .en)
        XCTAssertFalse(d.isUnlimited)
        XCTAssertEqual(d.fraction!, 0.2, accuracy: 0.0001)
        XCTAssertEqual(d.capText, "5.0 GB")
    }
    // Over-quota is a real server state; the bar must not exceed full.
    func testOverQuotaClampsToOne() {
        let d = UsagePresentation.display(Meter(used: 20, cap: 10), language: .en)
        XCTAssertEqual(d.fraction!, 1.0, accuracy: 0.0001)
    }
    func testZeroUsedOnUnlimitedIsStillUnlimited() {
        let d = UsagePresentation.display(Meter(used: 0, cap: 0), language: .en)
        XCTAssertTrue(d.isUnlimited)
        XCTAssertEqual(d.usedText, "0 B")
    }
    // A free account carries an empty status and an active subscription needs no
    // annotation: both must be silent, or every user gets a meaningless badge.
    func testNoBadgeForFreeOrActiveSubscriptions() {
        XCTAssertNil(UsagePresentation.subscriptionBadge(for: "", language: .en))
        XCTAssertNil(UsagePresentation.subscriptionBadge(for: "active", language: .en))
    }
    // These are raw Stripe statuses. Rendering `past_due` verbatim shows a paying
    // customer snake_case machine vocabulary at the worst possible moment.
    func testNonActiveStatusesGetHumanCopy() {
        XCTAssertEqual(UsagePresentation.subscriptionBadge(for: "past_due", language: .en), "Payment failed")
        XCTAssertEqual(UsagePresentation.subscriptionBadge(for: "canceled", language: .en), "Canceled")
        XCTAssertEqual(UsagePresentation.subscriptionBadge(for: "incomplete", language: .en), "Payment incomplete")
        XCTAssertEqual(UsagePresentation.subscriptionBadge(for: "trialing", language: .en), "Trial")
    }
    // An unknown future status is still not active, so it must show — as English.
    func testUnknownStatusShowsButNeverVerbatim() {
        XCTAssertEqual(UsagePresentation.subscriptionBadge(for: "some_future_status", language: .en), "Inactive")
    }

    // Binary units, English separator. The separator is per-language now, which
    // is why the locale is named rather than inherited from the runner.
    func testBytesTextUsesBinaryUnitsInEnglish() {
        XCTAssertEqual(UsagePresentation.bytesText(0, language: .en), "0 B")
        XCTAssertEqual(UsagePresentation.bytesText(512, language: .en), "512 B")
        XCTAssertEqual(UsagePresentation.bytesText(1024, language: .en), "1.0 KB")
        XCTAssertEqual(UsagePresentation.bytesText(1_048_576, language: .en), "1.0 MB")
        XCTAssertEqual(UsagePresentation.bytesText(10_737_418_240, language: .en), "10.0 GB")
    }
    // Days-remaining rather than a formatted date, and pinned to English through
    // the explicit locale seam, so the assertion is stable on any machine and in CI.
    func testResetTextCountsWholeDays() {
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 5 * 86_400, now: now, language: .en),
                       "Resets in 5 days")
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 86_400, now: now, language: .en),
                       "Resets in 1 day")
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 3_600, now: now, language: .en),
                       "Resets today")
    }
    func testResetTextInThePastReadsAsToday() {
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_779_000_000, now: now, language: .en), "Resets today")
    }
}
