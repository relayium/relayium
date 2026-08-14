import SwiftUI
import RelayiumAppKit

/// A pairing code or a verification phrase, set at a deliberate size that still
/// scales.
///
/// **The only file under `apps/mac/Relayium` allowed to contain `.system(size:`,
/// and `MacSurfaceGuardTests` counts the files to keep it that way.** The
/// justification is functional rather than aesthetic: both of these are
/// transcribed by a human from this screen onto another device, often across a
/// room, and both have to present a stable character grid that cannot reflow or
/// shrink under a container. Every other string in the app uses a semantic text
/// style and scales with the user's settings.
///
/// ## The size is fixed relative to the user's text, not to the pixel
///
/// It used to be 34 and 26 points flat, which meant the one string in the app a
/// person has to read across a room was the one string that ignored their text
/// size entirely — larger system text made every label around the code grow and
/// left the code itself alone. `@ScaledMetric` keeps the ratio and the character
/// grid while following the setting, so the code is still the biggest thing on
/// its screen at every size.
///
/// **It must never wrap and never shrink.** `lineLimit(1)` plus a horizontal
/// `fixedSize` means the code is laid out at its full width whatever the
/// container offers: a six-digit code broken across two lines, or scaled down to
/// fit, is a code somebody transcribes wrongly. At the largest accessibility
/// sizes the six digits still occupy well under the 860pt minimum window.
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

    }

    let code: String
    let style: Style

    /// Both bases are declared, and the style picks between the two scaled
    /// results. `@ScaledMetric` is a property wrapper reading the environment,
    /// so it cannot be built from `style` inside `body` — declaring both and
    /// choosing afterwards is the form that actually tracks the setting.
    @ScaledMetric(relativeTo: .largeTitle) private var pairingSize: CGFloat = 34
    @ScaledMetric(relativeTo: .title) private var verificationSize: CGFloat = 26

    private var scaledSize: CGFloat {
        switch style {
        case .pairing: return pairingSize
        case .verification: return verificationSize
        }
    }

    @ViewBuilder
    var body: some View {
        switch style {
        case .pairing:
            // Label the same outer element that owns the identifier. AppKit
            // otherwise exposes the identifier on a wrapper with an empty
            // label and the spoken digits on its inner selectable Text. The
            // explicit accessibility element collapses that AppKit split.
            codeText
                .accessibilityElement(children: .ignore)
                .accessibilityIdentifier("pairing-code-value")
                .accessibilityLabel(spokenCode)
        case .verification:
            // Keep the identifier and spoken label on this same element for
            // the same AppKit reason as the pairing code above.
            codeText
                .accessibilityElement(children: .ignore)
                .accessibilityIdentifier("verification-code-value")
                .accessibilityLabel(spokenCode)
        }
    }

    private var codeText: some View {
        Text(L10n.token(code))
            .font(.system(size: scaledSize, weight: .semibold, design: .monospaced))
            .lineLimit(1)
            // Horizontal only: the code takes the width it needs rather than the
            // width it is offered, so no container can wrap or truncate it.
            .fixedSize(horizontal: true, vertical: false)
            .textSelection(.enabled)
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
