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
///
/// ## A fill and a hairline, because the fill alone is not a boundary
///
/// The card was fill-only. In Dark appearance that works — `controlBackground`
/// sits well clear of `windowBackground` there — and in Light the two are close
/// enough that a screen of stacked cards read as one column with headings in it,
/// which is the audit's Light-appearance finding. The repair is the smallest one
/// that answers both appearances at once: keep the adaptive system fill and draw
/// the system separator around it. `strokeBorder` insets by half the line width,
/// so the rule sits inside the clipped shape instead of straddling it and
/// half-disappearing into whatever is behind.
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
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.corner)
                .strokeBorder(Palette.cardBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}
