import SwiftUI
import RelayiumAppKit

/// A pairing code or a verification phrase, for transcription by a human.
///
/// The iOS counterpart of `SecurityCodeText` on macOS, and it is a separate file
/// for the same functional reason that one is: **both of these are read off this
/// screen and typed into another device**, so they need a stable monospaced
/// character grid that does not reflow, and they need to be spoken correctly.
///
/// A six-digit code read as a *number* is "four hundred eighty-three thousand
/// nine hundred twenty", which nobody can type — so the accessibility label
/// spaces the digits and VoiceOver reads them one at a time. `L10n.token` puts
/// the value inside a bidi isolate, so in Arabic the sentence around it mirrors
/// and the code does not.
///
/// Unlike the Mac's, this one scales. `.system(size:)` with a fixed point size
/// is what that file needs at a desk; on a phone held at arm's length in a
/// noisy room the same code has to grow with Dynamic Type, so this uses a
/// semantic style with a monospaced design and lets the user's setting decide.
struct PairingCodeText: View {
    enum Style {
        /// The six-digit pairing code — the largest thing on its screen.
        case pairing
        /// The short-authentication-string phrase compared with the peer.
        case verification

        var font: Font {
            switch self {
            case .pairing: return .system(.largeTitle, design: .monospaced).weight(.semibold)
            case .verification: return .system(.title2, design: .monospaced).weight(.semibold)
            }
        }
    }

    let code: String
    let style: Style

    var body: some View {
        Text(L10n.token(code))
            .font(style.font)
            .textSelection(.enabled)
            // Wrapping a code is worse than shrinking it: the grid is the thing
            // being transcribed.
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .accessibilityLabel(spokenCode)
    }

    /// Digits one at a time; a phrase left as the words it already is.
    ///
    /// The separator is a space, and the digits are data in every language.
    // nonlocalized: digits and their separator
    private var spokenCode: String {
        guard code.allSatisfy({ $0.isNumber }) else { return code }
        return code.map(String.init).joined(separator: " ")
    }
}
