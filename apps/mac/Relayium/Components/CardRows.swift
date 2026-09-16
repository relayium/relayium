import RelayiumAppKit
import SwiftUI

/// The rows inside a `SectionCard`, separated by hairlines with no line under
/// the last one.
///
/// A builder rather than a stack of hand-placed `Divider`s: "which row is last"
/// is then a property of the list rather than a rule every call site has to
/// remember, and a row that appears only in one state cannot leave a rule
/// hanging under nothing.
struct CardRows: View {
    private let rows: [AnyView]

    init(@CardRowBuilder rows: () -> [AnyView]) {
        self.rows = rows()
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { index in
                if index > 0 {
                    Divider()
                }
                rows[index]
            }
        }
    }
}

/// A run of rows built from data, keyed by the data's OWN identity.
///
/// `CardRows` keys its slots by position, which is correct for the fixed set of
/// rows a card declares and wrong for a roster: a device that arrives, leaves or
/// reorders would hand its view — and anything focus or state is attached to —
/// to whichever device landed at that index. One slot holds this, and `ForEach`
/// over `Identifiable` data keeps each element's identity inside it.
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
            // Keyed by `element.id`, with the index used only to decide where a
            // rule goes — the same composition `PathRail` uses.
            ForEach(Array(data.enumerated()), id: \.element.id) { index, element in
                if index > 0 {
                    Divider()
                }
                content(element)
            }
        }
    }
}

@resultBuilder
enum CardRowBuilder {
    static func buildExpression<V: View>(_ row: V) -> [AnyView] { [AnyView(row)] }
    /// A run of rows built from data — a device roster, a list of files — where
    /// each element is its own row rather than one row holding a stack.
    static func buildExpression(_ rows: [AnyView]) -> [AnyView] { rows }
    static func buildBlock(_ parts: [AnyView]...) -> [AnyView] { parts.flatMap { $0 } }
    static func buildOptional(_ part: [AnyView]?) -> [AnyView] { part ?? [] }
    static func buildEither(first: [AnyView]) -> [AnyView] { first }
    static func buildEither(second: [AnyView]) -> [AnyView] { second }
    static func buildArray(_ parts: [[AnyView]]) -> [AnyView] { parts.flatMap { $0 } }
    static func buildLimitedAvailability(_ part: [AnyView]) -> [AnyView] { part }
}

/// The ⓘ that folds one optional explanation out of the page and behind a
/// press.
///
/// **Only optional explanations may go behind it.** An error, a consent, a
/// required instruction or a live status stays on the page — which is why the
/// types that own one take their content separately from their explanation.
struct RowExplainButton: View {
    @Binding var explaining: Bool
    /// What the explanation is about — the card's title or the row's label.
    ///
    /// Required, because the glyph is identical everywhere: a screen with two
    /// ⓘ side by side (This Mac's name and its addresses) read to VoiceOver as
    /// two buttons called "Explain", told apart only by position. The visible
    /// control, its hit area and its identifier do not change.
    let subject: String

    var body: some View {
        Button {
            explaining.toggle()
        } label: {
            Image(systemName: "info.circle")
                .font(.callout)
                .foregroundStyle(explaining ? Palette.actionLabel : Color.secondary)
                // The glyph lays out at the compact size a 40pt row has room
                // for, and the pad/shape/unpad pair gives it the platform's
                // 44pt hit rectangle overhanging the row rather than a second
                // set of insets inside it.
                .frame(width: Metrics.compactControl, height: Metrics.compactControl)
                .padding(Metrics.compactControlOverhang)
                .contentShape(Rectangle())
                .padding(-Metrics.compactControlOverhang)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L10n.detail([L10n.t(.rowExplainLabel), subject]))
        .accessibilityValue(L10n.t(explaining ? .helpExpandedValue : .helpCollapsedValue))
        .accessibilityHint(L10n.t(.rowExplainHint))
        .accessibilityIdentifier("row-explain")
        .help(L10n.t(.rowExplainHint))
    }
}

/// What an ⓘ reveals: one short paragraph, at the smallest step in the scale.
struct RowExplanation: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("row-explanation")
    }
}

/// One row: a label, what it is set to, and whatever changes it.
struct SettingsRow<Trailing: View>: View {
    let label: String
    /// The short noun on the right — `Ready`, a folder name, an address.
    let value: String?
    /// Values that are transcribed or compared read as monospaced.
    let valueIsCode: Bool
    let explanation: String?
    @ViewBuilder let trailing: () -> Trailing

    @State private var explaining = false

    init(label: String,
         value: String? = nil,
         valueIsCode: Bool = false,
         explanation: String? = nil,
         @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.label = label
        self.value = value
        self.valueIsCode = valueIsCode
        self.explanation = explanation
        self.trailing = trailing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            line
            if explaining, let explanation {
                RowExplanation(text: explanation)
                    .padding(.horizontal, Metrics.rowHorizontal)
                    .padding(.bottom, Metrics.tight)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    private var line: some View {
        HStack(spacing: Metrics.tight) {
            Text(label)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Metrics.tight)
            if let value {
                Text(value)
                    .font(valueIsCode ? .callout.monospaced() : .body)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if explanation != nil {
                RowExplainButton(explaining: $explaining, subject: label)
            }
            trailing()
        }
        .padding(.vertical, Metrics.rowVertical)
        .padding(.horizontal, Metrics.rowHorizontal)
        .frame(minHeight: Metrics.rowMinHeight)
    }
}

/// A row that is a whole statement rather than a label and a value: a device in
/// a roster, a status that has to stay on the page, a control with its own
/// layout. Same insets and same floor, so it sits in the same grid as
/// `SettingsRow`.
struct CardBlockRow<Content: View>: View {
    /// An optional explanation and what it is about, as ONE value: this row has
    /// no label of its own to name the ⓘ after, so the two are supplied together
    /// or not at all.
    private struct Explanation {
        let text: String
        let subject: String
    }

    private let explanation: Explanation?
    @ViewBuilder let content: () -> Content

    @State private var explaining = false

    init(@ViewBuilder content: @escaping () -> Content) {
        self.explanation = nil
        self.content = content
    }

    /// A row whose ⓘ folds `explanation`, announced as explaining `subject`.
    init(explanation: String,
         subject: String,
         @ViewBuilder content: @escaping () -> Content) {
        self.explanation = Explanation(text: explanation, subject: subject)
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            HStack(alignment: .top, spacing: Metrics.tight) {
                content()
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let explanation {
                    RowExplainButton(explaining: $explaining, subject: explanation.subject)
                }
            }
            if explaining, let explanation {
                RowExplanation(text: explanation.text)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Metrics.rowVertical)
        .padding(.horizontal, Metrics.rowHorizontal)
        .frame(minHeight: Metrics.rowMinHeight)
    }
}
