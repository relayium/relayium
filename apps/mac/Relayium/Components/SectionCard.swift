import SwiftUI

/// A named group: a caption, a card, and an optional footnote under it.
///
/// One group style, used everywhere, is what makes hierarchy readable without
/// any new colour or border vocabulary. The caption sits ABOVE the card rather
/// than inside it, which is what System Settings does and what lets several
/// groups on one page read as a list of named things rather than as a column of
/// boxes with headings in them.
///
/// Level two is `OpenSection`, which has no background at all and nests inside
/// this. There is no third level and no card inside a card.
///
/// `rows: true` hands the card's full width to the content, for a
/// `CardRows` list whose separators have to run edge to edge. The default pads
/// the content, for a card that holds prose and controls.
///
/// `children: .contain` with the caption as label is what makes VoiceOver
/// announce the group's name once and then navigate into it, instead of reading
/// every control as a peer of everything else on the screen.
struct SectionCard<Content: View>: View {
    let title: String
    /// A short qualifier on the caption line, right-aligned. For a fact about
    /// the whole group that is not worth a row.
    let note: String?
    /// The one line under a card that has to stay on screen — where files land,
    /// what is never stored. Not a place for an explanation; those fold into a
    /// row's ⓘ.
    let footnote: String?
    /// The group's own optional explanation, folded behind the caption's ⓘ.
    /// Never an error, a consent or a live status — those stay on the page.
    let explanation: String?
    /// Whether the content is a flush row list rather than padded content.
    let rows: Bool
    @ViewBuilder let content: () -> Content

    @State private var explaining = false

    init(title: String,
         note: String? = nil,
         footnote: String? = nil,
         explanation: String? = nil,
         rows: Bool = false,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.note = note
        self.footnote = footnote
        self.explanation = explanation
        self.rows = rows
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.caption) {
            caption
            if explaining, let explanation {
                RowExplanation(text: explanation)
                    .padding(.horizontal, Metrics.hairline)
            }
            card
            if let footnote {
                Text(footnote)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Metrics.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    private var caption: some View {
        HStack(alignment: .firstTextBaseline, spacing: Metrics.tight) {
            Text(title)
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if explanation != nil {
                RowExplainButton(explaining: $explaining)
            }
            if let note {
                Spacer(minLength: Metrics.tight)
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.trailing)
            }
        }
        .padding(.horizontal, Metrics.hairline)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, rows ? 0 : Metrics.inner)
        .padding(.horizontal, rows ? 0 : Metrics.rowHorizontal)
        // The lift sits between the system fill and the content, so Dark gets
        // the reference's raised card and Light — where the fill is already
        // white — is unchanged.
        .background(Palette.cardLift)
        .background(Palette.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.corner))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.corner)
                .strokeBorder(Palette.cardBorder, lineWidth: 1)
        )
    }
}
