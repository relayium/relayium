import SwiftUI
import RelayiumAppKit

/// A pairing code or a verification phrase, set at a fixed size.
///
/// **The only file under `apps/mac/Relayium` allowed to contain `.system(size:`,
/// and `MacSurfaceGuardTests` counts the files to keep it that way.** The
/// justification is functional rather than aesthetic: both of these are
/// transcribed by a human from this screen onto another device, often across a
/// room, and both have to present a stable character grid that cannot reflow or
/// shrink under a container. Every other string in the app uses a semantic text
/// style and scales with the user's settings.
///
/// It also fixes what VoiceOver says. A six-digit code read as a *number* is
/// "four hundred two thousand nine hundred seventeen", which nobody can type;
/// spaced digits are read one at a time. `L10n.token` puts the code inside a
/// bidi isolate, so in Arabic the surrounding text mirrors and the code does
/// not.
struct SecurityCodeText: View {
    enum Style {
        /// The six-digit pairing code — the largest thing on its screen.
        case pairing
        /// The short-authentication-string phrase compared with the peer.
        case verification

        var size: CGFloat {
            switch self {
            case .pairing: return 34
            case .verification: return 26
            }
        }
    }

    let code: String
    let style: Style

    @ViewBuilder
    var body: some View {
        switch style {
        case .pairing:
            codeText.accessibilityIdentifier("pairing-code-value")
        case .verification:
            // Verification call sites name the surrounding task (for example
            // `link-sas`); do not overwrite that identifier on the inner Text.
            codeText
        }
    }

    private var codeText: some View {
        Text(L10n.token(code))
            .font(.system(size: style.size, weight: .semibold, design: .monospaced))
            .textSelection(.enabled)
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
