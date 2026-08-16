import Foundation
import RelayiumShareKit

/// **What a minted pairing code's own deadline means, on screen.**
///
/// ## Why this is a type rather than a line in the view
///
/// A pairing code carries a real expiry — `/api/pair` mints one and returns
/// `expiresAt`, and the server refuses the code from that second onward. The
/// surface rendered it as one static sentence, "Expires 14:05", which is true
/// and is not enough for the thing a person is actually doing with it: reading
/// six digits out loud to somebody on the phone. There was no way to tell, from
/// the screen, whether the code they were still dictating was worth anything.
/// The failure is silent on both ends — this Mac keeps drawing the digits, and
/// the other device is told the code is invalid — and the only visible symptom
/// is a person retyping a correct code twice.
///
/// So the deadline is turned into a countdown, and — the half that matters — into
/// an ANSWER about usability that the surface must obey rather than decorate.
/// Putting that in a view would put it where no `swift test` can reach it, and
/// "the moment it becomes unusable" is exactly the boundary worth testing: at
/// expiry, not a tick before and not a tick after.
///
/// ## The boundary is `>=`, deliberately
///
/// A code whose `expiresAt` is the current second is already refused by the
/// server, so a UI that still offered it would be offering something that cannot
/// work. `remaining` therefore reaches zero and `isUsable` becomes false in the
/// same instant, and no state exists where the countdown reads `0:00` beside a
/// live join link. `PairingCodeExpiryTests` drives the second on either side.
public enum PairingCodeExpiry {

    /// Everything the pairing-code surface may say about the deadline.
    public struct Presentation: Equatable, Sendable {
        /// Whole seconds left, rounded UP while any time remains, and never
        /// negative. Zero exactly when the code has expired.
        ///
        /// Ceiling rather than flooring because usability is decided on the
        /// exact interval, not on this number: with a tenth of a second left the
        /// code still works, and flooring would render `0:00` — a dead reading
        /// beside a live code. Rounding up means every usable code reads at
        /// least `0:01`, and the reading only reaches zero once it is expired.
        public let remaining: Int
        /// Whether the code can still be used by anybody.
        ///
        /// The surface reads THIS, never `remaining > 0` recomputed locally: one
        /// answer, so the countdown, the handoff controls and the expired notice
        /// cannot disagree about the same instant.
        public let isUsable: Bool
        /// `4:32` while it is usable, and nil once it is not — there is no such
        /// thing as a countdown to a moment that has passed, and rendering
        /// `0:00` beside "expired" says the same thing twice in two registers.
        public let countdown: String?

        public var isExpired: Bool { !isUsable }
    }

    /// - Parameters:
    ///   - expiresAt: the seconds-since-epoch the MINT returned. Never a
    ///     locally-invented deadline: the server owns when a code dies, so a
    ///     client that started its own timer from a locally-guessed lifetime
    ///     would disagree with the server about which code is still alive. This
    ///     does not make the reading clock-independent — the comparison below
    ///     still uses this machine's `now`, so a drifted clock still shows a
    ///     drifted countdown; it only ensures both sides are talking about the
    ///     same instant.
    ///   - now: injected so the boundary is testable. The surface passes the
    ///     tick it is redrawing for.
    public static func presentation(expiresAt: Int64,
                                    now: Date,
                                    language: AppLanguage? = nil) -> Presentation {
        // A mint that answered no deadline at all. Treated as usable and
        // uncounted rather than as expired: refusing a code because the server
        // declined to say when it dies would break a working transfer over a
        // missing field, and the server still refuses it at the real moment.
        guard expiresAt > 0 else {
            return Presentation(remaining: 0, isUsable: true, countdown: nil)
        }
        // Usability is decided on the exact interval, because that is what the
        // server decides on: it refuses the code from `expiresAt` onward, and
        // not one fractional second earlier. Deciding on a rounded-down whole
        // second would kill the code up to a second early on this screen while
        // the server still accepted it.
        let left = TimeInterval(expiresAt) - now.timeIntervalSince1970
        guard left > 0 else {
            return Presentation(remaining: 0, isUsable: false, countdown: nil)
        }
        // Positive, so rounding up cannot reach zero: a usable code always reads
        // at least `0:01`.
        let seconds = Int(left.rounded(.up))
        return Presentation(remaining: seconds, isUsable: true,
                            countdown: clock(seconds, language: language))
    }

    /// `m:ss`, or `h:mm:ss` for the codes long enough to need it.
    ///
    /// Digits and separators, not localized prose: this is a clock reading, it
    /// is placed inside a localized sentence by the caller, and `L10n.token`
    /// wraps it where the language reads right to left. Minutes are not padded
    /// and seconds always are, which is how every clock a Mac user has ever read
    /// is written.
    private static func clock(_ seconds: Int, language: AppLanguage?) -> String {
        let hours = seconds / 3_600
        let minutes = (seconds % 3_600) / 60
        let secs = seconds % 60
        let plain = hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
        return L10n.token(plain, language: language)
    }
}
