import SwiftUI
import RelayiumAppKit

/// The advanced-verification toggle, as both transfer destinations render it.
///
/// One component rather than a copy per destination, because it carries a rule
/// that is easy to state and easy to get subtly wrong twice: it locks the moment
/// a session is CLAIMED, not when a model reports busy. The session models read
/// this preference when the SAS arrives, and ownership is taken synchronously
/// before either model can publish a non-idle state — so a lock keyed on busy
/// flags leaves a window in which flipping the switch changes whether a
/// handshake already under way stops for confirmation.
///
/// `locked` is the caller's `TransferSurfacePresentation.acceptsNewSession`
/// answer inverted, so a session owned by the OTHER transfer destination locks
/// this one too. The setting is global; a screen that let it change while any
/// session was live would be changing it for that session.
struct VerificationSetting: View {
    let locked: Bool
    @ObservedObject var preference: VerificationPreference

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // The setter re-checks `locked` rather than trusting `.disabled`: a
            // click delivered from the previous render can land after a claim.
            Toggle(L10n.t(.verifyToggle), isOn: Binding(
                get: { preference.requiresSASConfirmation },
                set: { if !locked { preference.requiresSASConfirmation = $0 } }
            ))
                .disabled(locked)
                .accessibilityIdentifier("transfer-verification-toggle")
            Text(L10n.t(.verifyExplainWhat))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(.verifyExplainEncryption))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }
}
