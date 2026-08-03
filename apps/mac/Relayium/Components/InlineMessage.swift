import SwiftUI

/// One line of status attached to the thing it is about.
///
/// Replaces the ad-hoc `Text(...).font(.callout).foregroundStyle(.red)` sites
/// scattered through the panes. Colour is never the only carrier: every kind
/// renders an SF Symbol beside the text, so the message still reads as a warning
/// with colour filters on, in Increase Contrast, or to anyone who cannot
/// distinguish the red.
struct InlineMessage: View {
    enum Kind {
        case info
        case warning
        case failure

        var symbol: String {
            switch self {
            case .info: return "info.circle"
            case .warning: return "exclamationmark.triangle"
            case .failure: return "xmark.octagon"
            }
        }

        var tint: Color {
            switch self {
            case .info: return .secondary
            case .warning: return .orange
            case .failure: return .red
            }
        }
    }

    let kind: Kind
    let text: String

    init(_ kind: Kind, _ text: String) {
        self.kind = kind
        self.text = text
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: kind.symbol)
                .foregroundStyle(kind.tint)
                .accessibilityHidden(true)
            Text(text)
                .font(.callout)
                .foregroundStyle(kind == .info ? AnyShapeStyle(.secondary)
                                               : AnyShapeStyle(kind.tint))
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
