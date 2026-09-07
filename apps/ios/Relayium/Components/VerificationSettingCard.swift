import SwiftUI
import RelayiumAppKit

/// The advanced-verification setting, on the two iOS surfaces that can start a
/// session — control visible, cryptography one tap away.
///
/// **One component, not two copies.** Nearby and Pairing rendered
/// byte-identical `verificationSetting` bodies over the SAME app-scoped
/// preference, which is precisely the shape where a hierarchy change lands on
/// one screen and not the other. macOS has had `Components/VerificationSetting`
/// for this reason; iOS did not.
///
/// **The explanation is disclosed; the control is not.** The two paragraphs are
/// ~580 characters of key handling and SAS semantics, and permanently open they
/// were several screens of background under the last control on the longest tab
/// in the app at accessibility content sizes. Neither is dropped — without them
/// the toggle reads as "turn this on to be encrypted", the one wrong thing a
/// person could conclude here. One disclosure holding both, not one per
/// sentence.
///
/// **Nothing about the semantics moved.** Default off, the setter still refuses
/// while a session owns the models, and `.disabled` is still the courtesy rather
/// than the refusal — SwiftUI owns the binding behind a disabled control.
struct VerificationSettingCard: View {
    /// True while a live session has claimed the models. The models read the
    /// preference when the SAS arrives, so flipping it mid-handshake would make
    /// the gate depend on timing.
    let isLocked: Bool

    @EnvironmentObject private var verification: VerificationPreference

    /// Closed on every build, deliberately not persisted. This is a disclosure
    /// over an explanation, not a preference; persisting "open" would restore
    /// exactly the layout this exists to remove, on the content size where it
    /// hurts most. Same decision, and same reasoning, as
    /// `NearbyView.showsMechanism`.
    @State private var showsDetail = false

    var body: some View {
        // In a card, untitled: the toggle's own label is the title.
        SectionCard {
            Toggle(L10n.t(.verifyToggle), isOn: Binding(
                get: { verification.requiresSASConfirmation },
                set: { if !isLocked { verification.requiresSASConfirmation = $0 } }
            ))
                .disabled(isLocked)
                .accessibilityIdentifier("verify-toggle")

            // Labelled, because a bare chevron says nothing about what it hides
            // — and a disclosure nobody opens is the same as deleting the
            // explanation.
            DisclosureGroup(isExpanded: $showsDetail) {
                VStack(alignment: .leading, spacing: Metrics.tight) {
                    Text(L10n.t(.verifyExplainWhat))
                    Text(L10n.t(.verifyExplainEncryption))
                }
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, Metrics.hairline)
                .accessibilityIdentifier("verify-detail")
            } label: {
                // Identifier on the label leaf rather than on the group: a
                // container identifier reaches into what it holds, which is how
                // `verify-detail` would stop resolving to the paragraphs —
                // `DeviceInboxUITests.testEachReceivingPolicyChoiceIsSeparatelyIdentifiable`
                // is the measured record of that.
                Text(L10n.t(.verifyHowItWorks))
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("verify-detail-disclosure")
            }
            // Grey, not violet, for the reason the Nearby mechanism disclosure
            // is: a disclosure over an explanation is a control, but it is not
            // THE control on this card. The role rather than the system grey,
            // because `.tint` on a `DisclosureGroup` colours the label as well
            // as the chevron.
            .tint(Palette.supportingLabel)
        }
    }
}
