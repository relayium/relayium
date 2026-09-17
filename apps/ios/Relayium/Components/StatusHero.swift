import SwiftUI

/// **The one summary at the top of a task: what this device is doing right now,
/// and the controls that change it.**
///
/// The macOS 1.4.0 status head, translated to a touch screen rather than copied
/// onto one. A destination has at most one, and it is the only surface in the
/// app drawn on the violet wash — which is what stops a page of equal-weight
/// cards reading as a list of features. The navigation bar already names the
/// page, so the hero's title is the STATE (“Ready to receive”, “Nearby
/// receiving is on”) and never the destination's name a second time; a hero
/// with nothing to report beyond the page's purpose passes no title at all.
///
/// ## What changes from the Mac
///
///  * The controls are full-width, large, and BELOW the summary instead of
///    trailing it. A 24pt trailing button beside a wrapping sentence is the Mac's
///    pointer affordance; on a 375pt phone at the accessibility sizes it is a
///    word per line and a target under the 44pt floor.
///  * At the accessibility content sizes the radar moves above the text, so the
///    title keeps the whole width rather than wrapping beside a fixed 52pt glyph.
///  * The optional explanation folds behind the same ⓘ a grouped row uses, and
///    this view owns that one flag — so a destination that already pins its own
///    presentation state (the Device Inbox allows exactly one `@State`) can host
///    a hero without growing another.
///
/// **Nothing moves.** The radar's rings are static, so the state reads the same
/// in a screenshot, to a motion-sensitive reader and with Reduce Motion on, and
/// there is no animation branch to get wrong. The state is carried by the words
/// first, by the filled or quiet core second, and never by colour alone.
struct StatusHero<Content: View>: View {
    private let symbol: String
    private let title: String?
    private let titleIdentifier: String?
    private let detail: String?
    private let explanation: String?
    private let isActive: Bool
    private let content: () -> Content

    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var explaining = false

    init(symbol: String,
         title: String? = nil,
         titleIdentifier: String? = nil,
         detail: String? = nil,
         explanation: String? = nil,
         isActive: Bool,
         @ViewBuilder content: @escaping () -> Content) {
        self.symbol = symbol
        self.title = title
        self.titleIdentifier = titleIdentifier
        self.detail = detail
        self.explanation = explanation
        self.isActive = isActive
        self.content = content
    }

    var body: some View {
        // Two branches rather than `.accessibilityLabel(title ?? "")`, for the
        // reason `SectionCard` gives: an empty label on a container is not the
        // same as no label.
        if let title {
            hero.accessibilityLabel(title)
        } else {
            hero
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: Metrics.snug) {
            header
            if explaining, let explanation {
                RowExplanation(text: explanation)
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Metrics.heroPadding)
        .background(HeroSurface())
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Metrics.tight))
            : AnyLayout(HStackLayout(alignment: .center, spacing: Metrics.snug))
        return HStack(alignment: .top, spacing: 0) {
            layout {
                BrandRadar(symbol: symbol, isActive: isActive)
                summary
            }
            if explanation != nil {
                RowExplainButton(explaining: $explaining)
            }
        }
    }

    @ViewBuilder
    private var summary: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            if let title {
                titleText(title)
            }
            if let detail {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The title, with its identifier on the LEAF — an identifier on a container
    /// reaches into the controls underneath it, which is how `inbox-policy` once
    /// stopped resolving to its picker.
    @ViewBuilder
    private func titleText(_ title: String) -> some View {
        let text = Text(title)
            .font(.title3.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
        if let titleIdentifier {
            text.accessibilityIdentifier(titleIdentifier)
        } else {
            text
        }
    }
}

extension StatusHero where Content == EmptyView {
    init(symbol: String, title: String? = nil, titleIdentifier: String? = nil,
         detail: String? = nil, explanation: String? = nil, isActive: Bool) {
        self.init(symbol: symbol, title: title, titleIdentifier: titleIdentifier,
                  detail: detail, explanation: explanation, isActive: isActive,
                  content: { EmptyView() })
    }
}

/// The hero's surface: the wash, the softer corner, and the card's own edge.
/// Shared so every status head in the app is one kind of thing.
struct HeroSurface: View {
    var body: some View {
        RoundedRectangle(cornerRadius: Metrics.heroCorner, style: .continuous)
            .fill(Palette.heroBackground)
            .overlay(CardEdge(cornerRadius: Metrics.heroCorner))
    }
}

/// The brand radar: a core inside two still rings, in the Mac's 52pt footprint.
///
/// Filled with the brand while the thing it reports is running, and a quiet
/// chip while it is not — so the state is carried by the SHAPE as well as the
/// tint, and survives a colour filter and a greyscale screenshot. The glyph is
/// white on the fill (the accent's measured 5.6:1 fill role) and the supporting
/// role on the chip, and it stops growing at xLarge so it always fits its core.
struct BrandRadar: View {
    let symbol: String
    let isActive: Bool

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(ring.opacity(isActive ? 0.22 : 1), lineWidth: 1.5)
            Circle()
                .strokeBorder(ring.opacity(isActive ? 0.45 : 1), lineWidth: 1.5)
                .padding(6)
            Circle()
                .fill(isActive ? Palette.action : Palette.chip)
                .frame(width: Metrics.radarCore, height: Metrics.radarCore)
            Image(systemName: symbol)
                .font(.callout.weight(.semibold))
                .foregroundStyle(isActive ? Color.white : Palette.supportingLabel)
                .dynamicTypeSize(...DynamicTypeSize.xLarge)
        }
        .frame(width: Metrics.radar, height: Metrics.radar)
        .accessibilityHidden(true)
    }

    private var ring: Color { isActive ? Palette.action : Palette.hairline }
}
