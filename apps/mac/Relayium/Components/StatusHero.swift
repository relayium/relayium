import SwiftUI

/// The one summary at the top of a screen: what this Mac is doing right now,
/// and the control that changes it.
///
/// At most one per destination, and it is the only place a 17pt line appears —
/// which is what stops a page of equal-weight cards reading as a list of
/// features. A fact stated here is not repeated in the groups below it.
///
/// No motion. A pulsing radar reads well in a prototype and costs a
/// reduced-motion branch that can be wrong, a screenshot that says less than
/// the screen, and nothing a still badge does not already say.
struct StatusHero<Trailing: View>: View {
    let symbol: String
    let title: String
    /// The one supporting line: counts, boundaries, whether an account is
    /// needed. Never a paragraph — those belong in a row's ⓘ or in Help.
    let detail: String?
    let isActive: Bool
    @ViewBuilder let trailing: () -> Trailing

    init(symbol: String,
         title: String,
         detail: String? = nil,
         isActive: Bool = true,
         @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.symbol = symbol
        self.title = title
        self.detail = detail
        self.isActive = isActive
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .center, spacing: Metrics.rowHorizontal) {
            badge
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.title2.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("status-hero-title")
                if let detail {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Metrics.tight)
            trailing()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Metrics.section)
        .padding(.horizontal, 20)
        .background(Palette.heroBackground)
        .background(Palette.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.heroCorner))
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.heroCorner)
                .strokeBorder(Palette.cardBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    /// Filled while the thing is running, outlined while it is not: the state
    /// is carried by the shape as well as by the tint, so it survives a colour
    /// filter and a greyscale screenshot.
    private var badge: some View {
        ZStack {
            Circle()
                .fill(isActive ? Palette.action : Palette.chip)
            Image(systemName: symbol)
                .font(.callout.weight(.semibold))
                .foregroundStyle(isActive ? Color.white : Color.secondary)
        }
        .frame(width: 30, height: 30)
        .accessibilityHidden(true)
    }
}
