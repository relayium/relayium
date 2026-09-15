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
/// ## Two shapes
///
/// **A padded card** is the default: one intention laid out freely inside the
/// card's insets, titled from the inside because the title is the card's own
/// heading — the state it reports, or the act it asks for.
///
/// **A row group** (`rows: true`) is facts and settings, one per line,
/// hairline-separated, with the card supplying no insets so the rules reach both
/// edges. Its title moves above the card as a caption, which is both the
/// reference's rule and the platform's. The rows come from `CardRows`.
///
/// A `footnote` is the one line allowed under a group — where a file lands, what
/// is never stored, what a limit is. Outside the card in both shapes, because it
/// is about the group rather than part of it.
///
/// `children: .contain` with the title as label is what the refreshed panes on
/// macOS already do: VoiceOver announces the group's name once and then
/// navigates into it, instead of reading every control as a peer of everything
/// else on the screen.
struct SectionCard<Content: View>: View {
    private let title: String?
    private let footnote: String?
    private let rows: Bool
    private let content: () -> Content

    init(_ title: String? = nil,
         footnote: String? = nil,
         rows: Bool = false,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.footnote = footnote
        self.rows = rows
        self.content = content
    }

    var body: some View {
        // Two branches rather than `.accessibilityLabel(title ?? "")`: an empty
        // label on a container is not the same as no label, and which of the two
        // VoiceOver does with it is not something this file should be betting
        // on. An untitled card is a grouping, and says nothing of its own.
        if let title {
            group.accessibilityLabel(title)
        } else {
            group
        }
    }

    /// The card, whatever belongs outside it, and nothing between them but the
    /// caption step — so a caption stays nearer its own card than the next
    /// group is.
    private var group: some View {
        VStack(alignment: .leading, spacing: Metrics.caption) {
            if rows, let title, !title.isEmpty {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    // Wrapping rather than truncating: at accessibility content
                    // sizes a group caption is several lines on a 375pt screen,
                    // and the part that would be cut is the part that says what
                    // the group is for.
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.horizontal, Metrics.hairline)
            }
            card
            // Empty is absent, not a blank line: a state whose footnote has
            // nothing to say — a reset date with no period yet — would
            // otherwise leave a caption-sized gap under the card.
            if let footnote, !footnote.isEmpty {
                Text(footnote)
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Metrics.hairline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var card: some View {
        if rows {
            // No insets at all: the rules between rows have to reach both edges
            // of the card, and a row that inset itself twice would sit in a
            // different column from the caption above it.
            VStack(alignment: .leading, spacing: 0) { content() }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.cardBackground,
                            in: RoundedRectangle(cornerRadius: Metrics.corner, style: .continuous))
                // The fill alone rounds the card; this stops a row's own
                // background — a selected roster row, a pressed row — from
                // squaring the corners it sits in.
                .clipShape(RoundedRectangle(cornerRadius: Metrics.corner, style: .continuous))
        } else {
            VStack(alignment: .leading, spacing: Metrics.inner) {
                if let title {
                    Text(title)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                }
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Metrics.inner)
            .background(Palette.cardBackground,
                        in: RoundedRectangle(cornerRadius: Metrics.corner, style: .continuous))
        }
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
