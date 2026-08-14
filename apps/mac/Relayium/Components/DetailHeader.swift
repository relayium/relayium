import SwiftUI

/// **What this screen is for, said once, where there is room to say it.**
///
/// ## Why a header came back, and why it is not the old one
///
/// Every destination used to open with a `largeTitle` and a caption copied
/// verbatim from the sidebar row that had just been clicked. That was removed
/// for a good reason — on a Mac the sidebar is on screen at the same time with
/// that row highlighted, so a heading repeating it told the reader nothing —
/// and removing it created the opposite problem: five long explanatory
/// sentences were left stacked in a 208pt column, three lines each, and the
/// longest locales made the sidebar itself unusable at the 560pt minimum
/// height.
///
/// So the sentence moved rather than came back. **The sidebar names a
/// destination; this header explains the one that is open.** The explanation is
/// on screen exactly once, in a column with 600pt to render it instead of 208,
/// and every sidebar row keeps the complete sentence as its `accessibilityHint`
/// and its pointer tooltip — so nothing was lost to anyone, including the reader
/// choosing between two rows before opening either.
///
/// `navigationTitle` still names the window for Mission Control, the window menu
/// and VoiceOver's window chrome. This is the detail column's own heading, at
/// `title3` rather than `largeTitle`: it is a label on a screen, not a banner.
struct DetailHeader: View {
    /// An SF Symbol, the same one the sidebar row carries, tinted with the one
    /// action colour — the only place on the screen it appears before a control.
    let symbol: String
    let title: String
    /// The destination's own one sentence. Optional because the deep-link-only
    /// screen has no row and therefore no sentence to move.
    let purpose: String?

    var body: some View {
        HStack(alignment: .top, spacing: Metrics.inner) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(Palette.action)
                // The title says the same thing in words, and a symbol that
                // announced itself would read the destination's name twice.
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    // On the leaf. An identifier on the stack would propagate
                    // down and rename the sentence under it, which is the defect
                    // this app has already lost controls to twice.
                    .accessibilityIdentifier("destination-header")
                if let purpose {
                    Text(purpose)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                        .accessibilityIdentifier("destination-purpose")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
