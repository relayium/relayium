import SwiftUI

/// The app's only container chrome, and level one of exactly two.
///
/// One card style, used everywhere, is what makes hierarchy readable without any
/// new colour or border vocabulary: before this the deepest grouping the app had
/// was `Text(...).font(.headline)` followed by a `Divider`.
///
/// Level two is `OpenSection`, which has no background at all and nests inside
/// this. There is no third level and no card inside a card: the two together are
/// the whole depth vocabulary, and its numbers come from `Metrics` rather than
/// from a literal repeated per call site.
///
/// `children: .contain` with the title as label is the pattern `NearbyPane`
/// already uses: VoiceOver announces the group's name once and then navigates
/// into it, instead of reading every control as a peer of everything else on the
/// screen.
struct SectionCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            Text(title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Metrics.section)
        .background(Palette.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.corner))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}
