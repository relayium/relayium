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
///
/// What the switch DOES folds behind the row's ⓘ. What it does not do — change
/// the encryption — is the card's footnote and stays on the page, because that
/// is the misreading a reader has to be stopped from making without pressing
/// anything.
struct VerificationSetting: View {
    let locked: Bool
    @ObservedObject var preference: VerificationPreference

    var body: some View {
        SectionCard(title: L10n.t(.verifyHeading),
                    footnote: L10n.t(.verifyExplainEncryption),
                    rows: true) {
            CardRows {
                SettingsRow(label: L10n.t(.verifyToggle),
                            explanation: L10n.t(.verifyExplainWhat)) {
                    // The setter re-checks `locked` rather than trusting
                    // `.disabled`: a click delivered from the previous render
                    // can land after a claim.
                    Toggle(L10n.t(.verifyToggle), isOn: Binding(
                        get: { preference.requiresSASConfirmation },
                        set: { if !locked { preference.requiresSASConfirmation = $0 } }
                    ))
                        .labelsHidden()
                        .disabled(locked)
                        .accessibilityLabel(L10n.t(.verifyToggle))
                        .accessibilityIdentifier("transfer-verification-toggle")
                }
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }
}
