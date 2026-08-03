import SwiftUI

/// A symbol, a tint and a label: what something is doing right now.
///
/// Used for background-receive residency in the sidebar footer and for session
/// state inside a destination. Like `InlineMessage`, it never carries meaning in
/// colour alone — the symbol changes with the state as well as the tint.
struct StatusBadge: View {
    let symbol: String
    let tint: Color
    let label: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
