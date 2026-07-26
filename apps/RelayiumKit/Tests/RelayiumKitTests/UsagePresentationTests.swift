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
        let d = UsagePresentation.display(Meter(used: 2_097_152, cap: 0))
        XCTAssertTrue(d.isUnlimited)
        XCTAssertNil(d.fraction)
        XCTAssertEqual(d.capText, "Unlimited")
        XCTAssertEqual(d.usedText, "2.0 MB")
    }
    func testCappedMeterComputesFraction() {
        let d = UsagePresentation.display(Meter(used: 1_073_741_824, cap: 5_368_709_120))
        XCTAssertFalse(d.isUnlimited)
        XCTAssertEqual(d.fraction!, 0.2, accuracy: 0.0001)
        XCTAssertEqual(d.capText, "5.0 GB")
    }
    // Over-quota is a real server state; the bar must not exceed full.
    func testOverQuotaClampsToOne() {
        let d = UsagePresentation.display(Meter(used: 20, cap: 10))
        XCTAssertEqual(d.fraction!, 1.0, accuracy: 0.0001)
    }
    func testZeroUsedOnUnlimitedIsStillUnlimited() {
        let d = UsagePresentation.display(Meter(used: 0, cap: 0))
        XCTAssertTrue(d.isUnlimited)
        XCTAssertEqual(d.usedText, "0 B")
    }
    func testBytesTextUsesBinaryUnitsAndIsLocaleIndependent() {
        XCTAssertEqual(UsagePresentation.bytesText(0), "0 B")
        XCTAssertEqual(UsagePresentation.bytesText(512), "512 B")
        XCTAssertEqual(UsagePresentation.bytesText(1024), "1.0 KB")
        XCTAssertEqual(UsagePresentation.bytesText(1_048_576), "1.0 MB")
        XCTAssertEqual(UsagePresentation.bytesText(10_737_418_240), "10.0 GB")
    }
    // Days-remaining rather than a formatted date: no locale dependence, so the
    // assertion is stable on any machine and in CI.
    func testResetTextCountsWholeDays() {
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 5 * 86_400, now: now),
                       "Resets in 5 days")
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 86_400, now: now),
                       "Resets in 1 day")
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 3_600, now: now),
                       "Resets today")
    }
    func testResetTextInThePastReadsAsToday() {
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_779_000_000, now: now), "Resets today")
    }
}
