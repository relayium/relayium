import SwiftUI

/// The page every destination is drawn on: one scroller, one gutter, one rhythm
/// between groups, and one answer to a screen wider than a phone.
///
/// Every screen scrolls, because at the largest accessibility content sizes
/// anything that does not puts its own action off the bottom with no way to
/// reach it. That is a correctness property, so it belongs to the scaffold
/// rather than to each screen remembering the same four lines.
///
/// At a regular width the column stops at `Metrics.readingMeasure` and the
/// gutters take the rest, which is what makes an iPad a two-column app rather
/// than a stretched phone. No size-class check: a compact width is narrower
/// than the measure, so the cap does nothing there and one rule serves both
/// shells.
///
/// The column is centred; its contents are not — a centred ragged column is
/// unreadable at the largest Dynamic Type sizes.
struct DestinationPage<Content: View>: View {
    private let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.section) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Metrics.page)
            .padding(.top, Metrics.pageTop)
            .padding(.bottom, Metrics.pageBottom)
            // The gutters are inside the measure, so the reading column is the
            // whole 660 rather than 660 plus two more.
            .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            // …and the capped column is centred in whatever is left.
            .frame(maxWidth: .infinity)
        }
        .background(Palette.pageBackground)
    }
}
