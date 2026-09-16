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
/// answer inverted.
///
/// Drawn as the reference's Security group: the switch with what it does in
/// one visible line, and an Encryption row that states what the switch never
/// changes. The longer explanation folds behind that row's ⓘ.
struct VerificationSetting: View {
    let locked: Bool
    @ObservedObject var preference: VerificationPreference

    var body: some View {
        SectionCard(title: L10n.t(.verifySecurityHeading), rows: true) {
            CardRows {
                CardBlockRow {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(L10n.t(.verifyToggleShort))
                                .font(.body)
                                .foregroundStyle(Palette.text)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(L10n.t(.verifyToggleDetail))
                                .font(.subheadline)
                                .foregroundStyle(Palette.textTertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: Metrics.tight)
                        // The setter re-checks `locked` rather than trusting
                        // `.disabled`: a click delivered from the previous render
                        // can land after a claim.
                        //
                        // No label content: the visible line beside it names the
                        // switch, and the explicit accessibility label below is
                        // the one name assistive technology reads. A title
                        // string here would only exist as a hidden text child.
                        Toggle(isOn: Binding(
                            get: { preference.requiresSASConfirmation },
                            set: { if !locked { preference.requiresSASConfirmation = $0 } }
                        )) {
                            EmptyView()
                        }
                            .toggleStyle(.switch)
                            .labelsHidden()
                            .disabled(locked)
                            .accessibilityLabel(L10n.t(.verifyToggle))
                            .accessibilityIdentifier("transfer-verification-toggle")
                    }
                }
                SettingsRow(label: L10n.t(.verifyEncryptionLabel),
                            value: L10n.t(.verifyEncryptionValue),
                            explanation: [L10n.t(.verifyExplainEncryption),
                                          L10n.t(.verifyExplainWhat)]
                                .joined(separator: "\n\n")) // nonlocalized: paragraph break
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }
}
