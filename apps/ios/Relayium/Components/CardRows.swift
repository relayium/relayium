import SwiftUI
import RelayiumAppKit

/// The rows inside a `SectionCard(rows: true)`, separated by hairlines with no
/// rule under the last one.
///
/// A builder rather than hand-placed `Divider`s, so a row that appears only in
/// one state cannot leave a rule hanging under nothing.
struct CardRows: View {
    private let rows: [AnyView]

    init(@CardRowBuilder rows: () -> [AnyView]) {
        self.rows = rows()
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { index in
                if index > 0 { CardRowRule() }
                rows[index]
            }
        }
    }
}

/// A run of rows built from data, keyed by the data's OWN identity.
///
/// `CardRows` keys its slots by position, which is right for the fixed set of
/// rows a card declares and wrong for a live list: a row that arrives, leaves or
/// reorders would otherwise hand its view — and whatever selection or gesture is
/// attached to it — to whichever element landed at that index.
struct CardRowList<Data: RandomAccessCollection, Content: View>: View
where Data.Element: Identifiable {
    private let data: Data
    private let content: (Data.Element) -> Content

    init(_ data: Data, @ViewBuilder content: @escaping (Data.Element) -> Content) {
        self.data = data
        self.content = content
    }

    var body: some View {
        VStack(spacing: 0) {
            // Keyed by `element.id`; the index decides only where a rule goes.
            ForEach(Array(data.enumerated()), id: \.element.id) { index, element in
                if index > 0 { CardRowRule() }
                content(element)
            }
        }
    }
}

/// The rule between two rows: inset by the row's own leading inset and run to
/// the trailing edge, which is what says the rows are one list rather than
/// separate cards stacked. `Divider` rather than a hand-built line, so the
/// hairline, Increase Contrast and the right-to-left inset are the platform's.
private struct CardRowRule: View {
    var body: some View {
        Divider()
            .padding(.leading, Metrics.rowHorizontal)
            .accessibilityHidden(true)
    }
}

@resultBuilder
enum CardRowBuilder {
    static func buildExpression<V: View>(_ row: V) -> [AnyView] { [AnyView(row)] }
    /// A run of rows built from data, where each element is its own row rather
    /// than one row holding a stack.
    static func buildExpression(_ rows: [AnyView]) -> [AnyView] { rows }
    static func buildBlock(_ parts: [AnyView]...) -> [AnyView] { parts.flatMap { $0 } }
    static func buildOptional(_ part: [AnyView]?) -> [AnyView] { part ?? [] }
    static func buildEither(first: [AnyView]) -> [AnyView] { first }
    static func buildEither(second: [AnyView]) -> [AnyView] { second }
    static func buildArray(_ parts: [[AnyView]]) -> [AnyView] { parts.flatMap { $0 } }
    static func buildLimitedAvailability(_ part: [AnyView]) -> [AnyView] { part }
}

/// The ⓘ that folds one optional explanation behind a tap.
///
/// Only optional explanations go behind it: an error, a consent, a required
/// instruction, a limit or a live status stays on the page, which is why the row
/// types below take their content and their explanation separately.
///
/// The control occupies a real 44×44 square inside the row — the row grows to
/// hold it rather than the glyph overhanging its insets — so its touch and
/// accessibility rectangle is the area it actually claims and cannot overlap the
/// action beside it. The glyph itself stops scaling past `xLarge`, because at
/// the largest sizes it otherwise takes a third of the row from the label it
/// marks.
struct RowExplainButton: View {
    @Binding var explaining: Bool

    var body: some View {
        Button {
            explaining.toggle()
        } label: {
            // nonlocalized: SF Symbol name
            Image(systemName: "info.circle")
                .font(.callout)
                .foregroundStyle(explaining ? Palette.actionLabel : Palette.supportingLabel)
                .dynamicTypeSize(...DynamicTypeSize.xLarge)
                .frame(width: Metrics.hitTarget, height: Metrics.hitTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.t(.rowExplainLabel))
        .accessibilityValue(L10n.t(explaining ? .helpExpandedValue : .helpCollapsedValue))
        .accessibilityHint(L10n.t(.rowExplainHint))
        .accessibilityIdentifier("row-explain")
    }
}

/// What an ⓘ reveals: one short paragraph, at the smallest step in the scale.
struct RowExplanation: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Palette.supportingLabel)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("row-explanation")
    }
}

/// One row of a card: a device, a stored object, a status, a control with its
/// own layout.
///
/// It lays out its own content rather than imposing a label-and-value shape,
/// because every row this app actually has is a whole statement — a device name
/// over its badge and its detail, a meter, a route. What it does impose is the
/// grid: the same insets and the same 44pt floor on every row, and one place for
/// the ⓘ that holds an optional explanation.
struct CardBlockRow<Content: View>: View {
    let explanation: String?
    @ViewBuilder let content: () -> Content

    @State private var explaining = false

    init(explanation: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.explanation = explanation
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            HStack(alignment: .top, spacing: Metrics.tight) {
                content()
                    .frame(maxWidth: .infinity, alignment: .leading)
                if explanation != nil { RowExplainButton(explaining: $explaining) }
            }
            if explaining, let explanation { RowExplanation(text: explanation) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Metrics.rowVertical)
        .padding(.horizontal, Metrics.rowHorizontal)
        .frame(minHeight: Metrics.rowMinHeight)
    }
}
