import SwiftUI

/// The app's only container chrome, and level one of exactly two.
///
/// One card style, used everywhere, is what makes hierarchy readable without a
/// new colour or border vocabulary. Before this these screens had two kinds of
/// grouping and no system: `Text(...).font(.headline)` followed by twenty points
/// of nothing, so a status, a task and a footnote were peers down one flat
/// column — and, in the two places somebody did reach for a container, a
/// `.quaternary.opacity(0.35)` fill written out by hand, equal to the other only
/// by coincidence.
///
/// Level two is `OpenSection`, which has no background at all and nests inside
/// this. There is no third level and no card inside a card: the two together are
/// the whole depth vocabulary.
///
/// The title is optional, and the reason is a finding from the Mac's own audit —
/// destination names repeated in the sidebar, the window title and the detail
/// header. A card whose only honest title would repeat the navigation title, or
/// the segmented control directly above it, gets none.
///
/// `children: .contain` with the title as label is what the refreshed panes on
/// macOS already do: VoiceOver announces the group's name once and then
/// navigates into it, instead of reading every control as a peer of everything
/// else on the screen.
struct SectionCard<Content: View>: View {
    private let title: String?
    private let content: () -> Content

    init(_ title: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        // Two branches rather than `.accessibilityLabel(title ?? "")`: an empty
        // label on a container is not the same as no label, and which of the two
        // VoiceOver does with it is not something this file should be betting
        // on. An untitled card is a grouping, and says nothing of its own.
        if let title {
            container.accessibilityLabel(title)
        } else {
            container
        }
    }

    private var container: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            if let title {
                Text(title)
                    .font(.headline)
                    // Wrapping rather than truncating: at accessibility content
                    // sizes a card title is several lines on a 375pt screen, and
                    // the part that would be cut is the part that says what the
                    // card is for.
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Metrics.inner)
        .background(Palette.cardBackground,
                    in: RoundedRectangle(cornerRadius: Metrics.corner, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// Level two: a titled group with no chrome at all, used INSIDE a card.
///
/// It exists so that a card holding two acts — what to send, and who to send it
/// to — can say so without nesting a second box, which is what the one
/// `Divider` on that screen was reaching for and never quite said.
struct OpenSection<Content: View>: View {
    private let title: String
    private let content: () -> Content

    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
