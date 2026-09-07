import SwiftUI

/// One line of status attached to the thing it is about.
///
/// It replaces four separate private `failureLine` helpers — one each in
/// `NearbyView`, `SendView`, `DeviceTargetPicker` and `DeviceDeliveryList` —
/// which were the same six lines copied four times, plus the nearby tab's
/// standing caution, which was a plain secondary paragraph with nothing to mark
/// it as one. The helpers keep their names and their call shapes — the panes'
/// own ordering guards address them by name — and all now render this.
///
/// Colour is never the only carrier: every kind draws an SF Symbol beside the
/// text, so the message still reads as a warning with colour filters on, in
/// Increase Contrast, and to anyone who cannot distinguish the orange.
struct InlineMessage: View {
    enum Kind {
        /// Something true the reader needs before deciding. Secondary, because
        /// it is not a failure and must not compete with one.
        case info
        /// Something went wrong, or could.
        case warning

        var symbol: String {
            switch self {
            // nonlocalized: SF Symbol names
            case .info: return "info.circle"
            case .warning: return "exclamationmark.triangle.fill"
            }
        }

        var tint: Color {
            switch self {
            // secondary-role: symbol — the info glyph. The sentence beside it is
            // Palette.supportingLabel; this tints only the icon. Non-text.
            case .info: return .secondary
            case .warning: return Palette.warningLabel
            }
        }
    }

    private let kind: Kind
    private let text: String

    init(_ kind: Kind, _ text: String) {
        self.kind = kind
        self.text = text
    }

    var body: some View {
        Label {
            Text(text)
                .foregroundStyle(kind == .info ? AnyShapeStyle(Palette.supportingLabel)
                                               : AnyShapeStyle(.primary))
                // Wrapping rather than truncating: these sentences are the ones
                // that say what went wrong and what to do, and the part a
                // truncation removes is the remedy at the end.
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: kind.symbol)
                .foregroundStyle(kind.tint)
                // Capped, because it is a landmark rather than reading. Left to
                // scale, at Accessibility 5 it became a 60pt glyph holding a
                // third of the line width hostage — so the sentence it is meant
                // to mark got narrower exactly where it was already longest.
                .dynamicTypeSize(...DynamicTypeSize.xLarge)
        }
        .font(.callout)
        // One spoken sentence rather than an unlabelled image followed by text.
        .accessibilityElement(children: .combine)
    }
}
