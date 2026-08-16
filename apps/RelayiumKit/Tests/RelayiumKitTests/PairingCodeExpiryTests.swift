import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// **The deterministic half of "the code counts down and stops being usable".**
///
/// The boundary is the whole point. A pairing code is refused by the server from
/// its `expiresAt` second onward, so the one behaviour worth pinning is what the
/// surface says in the second before, the second of, and the second after — and
/// that no state exists where a countdown and a live join control are drawn
/// together on a code that is already dead.
///
/// The clock is injected, so none of this depends on when the suite runs.
final class PairingCodeExpiryTests: XCTestCase {

    /// 2026-08-16 12:00:00 UTC, as a plain number so nothing here reads the
    /// machine's own clock.
    private let mintedAt: Int64 = 1_786_000_000

    private func at(_ offset: TimeInterval) -> Date {
        Date(timeIntervalSince1970: TimeInterval(mintedAt) + offset)
    }

    // MARK: - the boundary

    /// One second before, the code is usable and says how long is left.
    func testTheSecondBeforeExpiryIsStillUsable() {
        let shown = PairingCodeExpiry.presentation(expiresAt: mintedAt + 300,
                                                   now: at(299), language: .en)
        XCTAssertTrue(shown.isUsable)
        XCTAssertFalse(shown.isExpired)
        XCTAssertEqual(shown.remaining, 1)
        XCTAssertEqual(shown.countdown, "0:01")
    }

    /// **Exactly at expiry it is unusable**, which is the assertion the owner
    /// asked for by name. The server refuses the code in this same second, so a
    /// surface that still offered it would be offering something that cannot
    /// work — and the person reading the digits out would have no way to know.
    func testExactlyAtExpiryItIsUnusableAndHasNoCountdown() {
        let shown = PairingCodeExpiry.presentation(expiresAt: mintedAt + 300,
                                                   now: at(300), language: .en)
        XCTAssertFalse(shown.isUsable)
        XCTAssertTrue(shown.isExpired)
        XCTAssertEqual(shown.remaining, 0)
        // No `0:00`. A countdown to a moment that has passed is not a countdown,
        // and drawing one beside "expired" states the same thing twice in two
        // registers — one of which looks like the code is still alive.
        XCTAssertNil(shown.countdown)
    }

    /// And it stays unusable afterwards rather than wrapping into a negative
    /// clock, which is what an unclamped subtraction would render.
    func testAfterExpiryItStaysUnusableAndNeverCountsBackwards() {
        for elapsed in [301.0, 600.0, 86_400.0] {
            let shown = PairingCodeExpiry.presentation(expiresAt: mintedAt + 300,
                                                       now: at(elapsed), language: .en)
            XCTAssertFalse(shown.isUsable, "the code came back to life at +\(elapsed)")
            XCTAssertEqual(shown.remaining, 0, "the countdown went negative at +\(elapsed)")
            XCTAssertNil(shown.countdown)
        }
    }

    // MARK: - how it reads

    /// Minutes unpadded, seconds always padded — every clock a Mac user reads.
    func testTheCountdownIsWrittenAsAClock() {
        func countdown(_ left: Int) -> String? {
            PairingCodeExpiry.presentation(expiresAt: mintedAt + Int64(left),
                                           now: at(0), language: .en).countdown
        }
        XCTAssertEqual(countdown(9), "0:09")
        XCTAssertEqual(countdown(60), "1:00")
        XCTAssertEqual(countdown(75), "1:15")
        XCTAssertEqual(countdown(600), "10:00")
        // Long enough to need an hour field rather than "70:00".
        XCTAssertEqual(countdown(3_725), "1:02:05")
    }

    /// A partial second is floored, so the number never rounds UP to a second
    /// the code does not have.
    func testAPartialSecondIsFlooredRatherThanRounded() {
        let shown = PairingCodeExpiry.presentation(expiresAt: mintedAt + 300,
                                                   now: at(298.4), language: .en)
        XCTAssertEqual(shown.remaining, 1)
        XCTAssertEqual(shown.countdown, "0:01")
    }

    // MARK: - the awkward inputs

    /// A mint that answered no deadline is treated as usable and uncounted.
    ///
    /// Refusing a code because the server declined to say when it dies would
    /// break a working transfer over a missing field — and the server still
    /// refuses it at the real moment, whatever this screen believes.
    func testAMissingDeadlineIsUsableAndUncounted() {
        for absent in [Int64(0), Int64(-1)] {
            let shown = PairingCodeExpiry.presentation(expiresAt: absent,
                                                       now: at(0), language: .en)
            XCTAssertTrue(shown.isUsable, "a code with no stated deadline was refused")
            XCTAssertNil(shown.countdown)
        }
    }

    /// The clock reading keeps its own reading order in a right-to-left
    /// language: a bare `4:32` dropped into an Arabic sentence is laid out by
    /// the bidi algorithm against the surrounding text, which can reverse it.
    func testTheClockIsIsolatedInARightToLeftLanguage() throws {
        let arabic = try XCTUnwrap(PairingCodeExpiry.presentation(
            expiresAt: mintedAt + 272, now: at(0), language: .ar).countdown)
        XCTAssertTrue(arabic.contains("4:32"), "the clock digits were rewritten")
        XCTAssertTrue(arabic.hasPrefix("\u{2068}") && arabic.hasSuffix("\u{2069}"),
                      "the clock is not isolated, so bidi may reorder it")
        // …and untouched in a left-to-right one, so English output is unchanged.
        XCTAssertEqual(PairingCodeExpiry.presentation(expiresAt: mintedAt + 272,
                                                      now: at(0), language: .en).countdown,
                       "4:32")
    }

    /// Both maintained languages render the sentence the countdown goes inside,
    /// and neither loses the substitution.
    func testBothMaintainedLanguagesRenderTheDeadlineCopy() {
        for language in [AppLanguage.en, .zh] {
            let inside = L10n.t(.pairingCodeExpiresIn, ["4:32"], language: language)
            XCTAssertTrue(inside.contains("4:32"),
                          "\(language) dropped the countdown out of its sentence")
            XCTAssertFalse(L10n.t(.pairingCodeExpired, language: language).isEmpty)
            XCTAssertFalse(L10n.t(.pairingNewCode, language: language).isEmpty)
        }
    }
}
