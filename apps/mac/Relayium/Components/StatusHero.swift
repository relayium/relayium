import SwiftUI

/// The one summary at the top of a screen: what this Mac is doing right now,
/// and the control that changes it.
///
/// At most one per destination, and it is the only place a 17pt line appears —
/// which is what stops a page of equal-weight cards reading as a list of
/// features. A fact stated here is not repeated in the groups below it.
///
/// Drawn as the reference's hero: a violet-washed card with the brand radar at
/// its leading edge. **The radar does not move.** Its rings are static, so the
/// state reads identically in a screenshot, to a motion-sensitive reader and
/// with Reduce Motion on, and there is no animation branch to get wrong.
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
            BrandRadar(symbol: symbol, isActive: isActive)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(Palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("status-hero-title")
                if let detail {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("status-hero-detail")
                }
            }
            Spacer(minLength: Metrics.tight)
            trailing()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, Metrics.heroPadding)
        .padding(.bottom, 18)
        .padding(.horizontal, Metrics.heroPadding)
        .background(HeroSurface())
        #if DEBUG
        .modifier(UITestSwitchAudit.GroupSemantics(label: title))
        #else
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
        #endif
    }
}

/// The hero's surface: the violet wash, 14pt corners and the card's edge.
/// Shared by every hero so the pairing code and the LAN status are one kind of
/// thing.
struct HeroSurface: View {
    var body: some View {
        RoundedRectangle(cornerRadius: Metrics.heroCorner)
            .fill(Palette.heroBackground)
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.heroCorner)
                    .strokeBorder(Palette.cardBorder, lineWidth: 1)
            )
    }
}

/// The brand radar: a violet core inside two still rings, in a 52pt footprint.
///
/// Filled while the thing is running and a quiet chip while it is not, so the
/// state is carried by the shape as well as by the tint and survives a colour
/// filter and a greyscale screenshot.
struct BrandRadar: View {
    let symbol: String
    let isActive: Bool

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(ring.opacity(isActive ? 0.22 : 0.5), lineWidth: 1.5)
            Circle()
                .strokeBorder(ring.opacity(isActive ? 0.45 : 0.8), lineWidth: 1.5)
                .padding(6)
            Circle()
                .fill(isActive ? Palette.action : Palette.chip)
                .frame(width: Metrics.radarCore, height: Metrics.radarCore)
            Image(systemName: symbol)
                .font(.callout.weight(.semibold))
                .foregroundStyle(isActive ? Color.white : Palette.textSecondary)
        }
        .frame(width: Metrics.radar, height: Metrics.radar)
        .accessibilityHidden(true)
    }

    private var ring: Color { isActive ? Palette.action : Palette.chip }
}
