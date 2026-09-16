import AppKit
import SwiftUI

/// **The whole visual vocabulary of this app, in one file.**
///
/// The numbers and colours come from the owner's macOS interface reference
/// (`RelayiumApp.dc.html`, variant b, rendered at 940×620): a 216pt sidebar
/// with a 40pt window-control row, a 44pt detail toolbar, a 660pt reading
/// measure, 16pt between groups, 11pt card corners, 14pt hero corners, and a
/// settings row that is at least 40pt tall with 8/14pt insets.
///
/// ## Typography
///
/// The reference's five sizes map onto macOS's own text styles exactly — 17pt
/// is `.title2`, 13pt is `.body`, 12pt is `.callout`, 11pt is `.subheadline` —
/// so the text styles are kept and only the WEIGHTS follow the reference
/// (600 → `.semibold`, 500 → `.medium`). A style scales with the user's
/// settings; a point size would not. The transcribed digits are the one fixed
/// base, and `SecurityCodeText` scales that too.
///
/// ## Colour
///
/// Every colour is a named set in `Assets.xcassets` carrying the reference's
/// dark value, its existing light counterpart, and a High Contrast variant for
/// each. The catalog answers light, dark and Increase Contrast by itself, so no
/// hex value is written in Swift and no view branches on the appearance.
enum Metrics {
    /// The gutter around a destination's content.
    static let page: CGFloat = 22
    /// Above the first thing on a page, and below the last.
    static let pageTop: CGFloat = 18
    static let pageBottom: CGFloat = 30
    /// Between top-level groups inside a destination.
    static let section: CGFloat = 16
    /// Between the parts of one section.
    static let inner: CGFloat = 12
    /// Between a label and the thing it labels.
    static let tight: CGFloat = 8
    /// Between lines of the same thought.
    static let hairline: CGFloat = 4
    /// Between a group's caption and its card.
    static let caption: CGFloat = 6
    /// The reading measure. A wider window does not set the text wider, so the
    /// column is centred rather than stretched.
    static let readingMeasure: CGFloat = 660
    /// A card's corner.
    static let corner: CGFloat = 11
    /// A status head's corner: one step softer than a card, so the one summary
    /// per screen reads as a different kind of thing.
    static let heroCorner: CGFloat = 14
    /// The status head's own insets.
    static let heroPadding: CGFloat = 20
    /// A settings row: the floor, and the insets inside it.
    static let rowMinHeight: CGFloat = 40
    static let rowVertical: CGFloat = 8
    static let rowHorizontal: CGFloat = 14
    /// The sidebar, at the reference's width.
    static let sidebar: CGFloat = 216
    /// The sidebar's top row, which the window's own controls sit in.
    static let sidebarControlRow: CGFloat = 40
    /// A sidebar row, its corner and its insets.
    static let sidebarRowHeight: CGFloat = 28
    static let sidebarRowCorner: CGFloat = 7
    static let sidebarInset: CGFloat = 10
    /// The detail column's unified toolbar.
    static let toolbarHeight: CGFloat = 44
    /// The space the window's traffic lights take when the sidebar is hidden
    /// and the toolbar starts at the window's leading edge.
    static let trafficLightsWidth: CGFloat = 78
    /// The smallest thing a pointer or a Full Keyboard Access ring is allowed
    /// to have to find.
    static let hitTarget: CGFloat = 44
    /// A control inside a compact grouped row: it LAYS OUT at this size so the
    /// 40pt row keeps its height, and takes `hitTarget` as its actual hit
    /// rectangle by overhanging the row's insets.
    static let compactControl: CGFloat = 24
    static var compactControlOverhang: CGFloat { (hitTarget - compactControl) / 2 }
    /// The reference's button: 24pt tall, 11pt insets, 6pt corners.
    static let buttonHeight: CGFloat = 24
    static let buttonCorner: CGFloat = 6
    /// The brand radar in the status head.
    static let radar: CGFloat = 52
    static let radarCore: CGFloat = 30
    /// The chip behind a device glyph in a roster row.
    static let deviceChip: CGFloat = 30
    /// A composer that is a place to write rather than a line to fill, and a
    /// cap so a long draft scrolls inside it instead of pushing everything
    /// below it out of a 560pt window.
    static let composerMinHeight: CGFloat = 96
    static let composerMaxHeight: CGFloat = 220
    /// `NSTextView`'s own horizontal text-container inset, which `TextEditor`
    /// inherits and does not expose. A placeholder has to match it or the line
    /// jumps sideways the moment somebody types.
    static let textEditorInset: CGFloat = 5
}

/// The two container weights a destination is allowed to use, and nothing
/// between them.
enum SurfaceLevel {
    /// A card: the app's only container chrome.
    case primary
    /// A titled group with no background, nested inside a card.
    case open
}

/// The reference palette, by role.
///
/// Violet is still an action colour: the thing you press, the row you are on,
/// the state that is live. It is never body text and never a paragraph's
/// background.
enum Palette {
    private static func named(_ name: String) -> Color { Color(name) }

    // MARK: surfaces

    /// The sidebar column.
    static var sidebar: Color { named("RelayiumSidebar") }
    /// The detail column behind the cards.
    static var pageBackground: Color { named("RelayiumContent") }
    /// The detail toolbar's wash over the page.
    static var toolbar: Color { named("RelayiumToolbar") }
    /// A card, and the only chrome in the app.
    static var cardBackground: Color { named("RelayiumCard") }
    /// The edge of a card.
    static var cardBorder: Color { named("RelayiumCardBorder") }
    /// A rule between rows, and under the toolbar.
    static var hairline: Color { named("RelayiumSeparator") }
    /// The status head's gradient: violet at the leading top, fading to the
    /// card's own weight.
    static var heroBackground: LinearGradient {
        LinearGradient(colors: [named("RelayiumHeroTint"), named("RelayiumHeroBase")],
                       startPoint: .topLeading,
                       endPoint: UnitPoint(x: 0.75, y: 1))
    }
    /// Behind a small glyph, a status chip, or a value that reads as a token.
    static var chip: Color { named("RelayiumChip") }
    /// A text field's fill.
    static var field: Color { named("RelayiumField") }
    /// A pairing-code digit tile.
    static var codeTile: Color { named("RelayiumCodeTile") }
    /// A secondary button's fill and edge.
    static var button: Color { named("RelayiumButton") }
    static var buttonBorder: Color { named("RelayiumButtonBorder") }
    /// Pointer hover over a row.
    static var rowHover: Color { named("RelayiumRowHover") }

    // MARK: text

    static var text: Color { named("RelayiumText") }
    static var textSecondary: Color { named("RelayiumTextSecondary") }
    static var textTertiary: Color { named("RelayiumTextTertiary") }

    // MARK: state

    /// The primary action, the current selection, the live state — as a FILL,
    /// with white on it. Dark appearance uses `#7A57F5`, one step deeper than
    /// the reference's `#8B6BFF` (3.7:1), so small white text on a selected
    /// row or a primary button clears 4.5:1 without Increase Contrast; the
    /// lighter reference violet remains `actionLabel`.
    static var action: Color { named("RelayiumAccent") }
    /// The same role as a LABEL drawn on a surface rather than behind white.
    static var actionLabel: Color { named("RelayiumAccentLabel") }
    /// The same colour at the weight a background can carry behind ordinary
    /// text.
    static var actionSurface: Color { named("RelayiumAccentSoft") }
    /// Something is running and healthy. Always paired with words.
    static var good: Color { named("RelayiumGood") }
}

/// The reference's two buttons: a violet primary and a quiet secondary.
///
/// 24pt tall with 12pt medium text, but the hit rectangle is at least
/// `Metrics.hitTarget` tall, and the label is never truncated. Disabled is
/// carried by the fill AND by the text weight, never by opacity alone.
struct ReferenceButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary }

    let kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        ReferenceButton(kind: kind, configuration: configuration)
    }

    private struct ReferenceButton: View {
        let kind: Kind
        let configuration: ButtonStyleConfiguration

        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.colorSchemeContrast) private var contrast
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.callout.weight(.medium))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .foregroundStyle(foreground)
                .padding(.horizontal, 11)
                .frame(minHeight: Metrics.buttonHeight)
                .background(
                    RoundedRectangle(cornerRadius: Metrics.buttonCorner)
                        .fill(fill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Metrics.buttonCorner)
                        .strokeBorder(border, lineWidth: 1)
                )
                .brightness(kind == .primary && isEnabled && hovering ? 0.06 : 0)
                .opacity(configuration.isPressed ? 0.85 : 1)
                .padding(.vertical, (Metrics.hitTarget - Metrics.buttonHeight) / 2)
                .contentShape(Rectangle())
                .padding(.vertical, -(Metrics.hitTarget - Metrics.buttonHeight) / 2)
                .onHover { hovering = $0 }
        }

        /// A destructive button keeps the platform's warning red on its label,
        /// so a Revoke or Delete never reads as an ordinary action.
        private var isDestructive: Bool { configuration.role == .destructive }

        private var foreground: Color {
            guard isEnabled else { return Palette.textTertiary }
            switch kind {
            case .primary: return .white
            case .secondary:
                if isDestructive { return InlineMessage.Kind.failure.tint }
                return hovering ? Palette.actionLabel : Palette.text
            }
        }

        private var fill: Color {
            guard isEnabled else { return Palette.chip }
            switch kind {
            case .primary: return Palette.action
            case .secondary:
                return hovering && !isDestructive ? Palette.actionSurface : Palette.button
            }
        }

        private var border: Color {
            switch kind {
            case .primary:
                return contrast == .increased ? Palette.buttonBorder : .clear
            case .secondary:
                return isEnabled ? Palette.buttonBorder : .clear
            }
        }
    }
}

extension ButtonStyle where Self == ReferenceButtonStyle {
    static var referencePrimary: ReferenceButtonStyle { ReferenceButtonStyle(kind: .primary) }
    static var referenceSecondary: ReferenceButtonStyle { ReferenceButtonStyle(kind: .secondary) }
}

/// A small token of live state: a dot and a word, on a chip.
///
/// The word carries the state; the dot's colour is the second carrier, never
/// the only one.
struct StatusChip: View {
    enum Tone { case good, busy, idle, failure }

    let label: String
    let tone: Tone

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(dot)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Palette.textSecondary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 9)
        .frame(minHeight: 22)
        .background(Capsule().fill(Palette.chip))
        // One leaf that says the word, rather than a merge of a hidden dot and
        // a text: the dot is decoration and the word is the whole of what is
        // spoken either way. `.combine` over a hidden child left hosted
        // macOS 15's accessibility audit reporting an element that is not an
        // accessibility child of its parent on exactly the two destinations
        // that draw this chip; whether this is that element is what the next
        // hosted audit decides.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("toolbar-status")
    }

    private var dot: Color {
        switch tone {
        case .good: return Palette.good
        case .busy: return InlineMessage.Kind.warning.tint
        case .idle: return Palette.textTertiary
        case .failure: return InlineMessage.Kind.failure.tint
        }
    }
}

/// What the toolbar says about the open destination's live state, if it has
/// one worth saying.
struct ToolbarStatus: Equatable {
    let label: String
    let tone: StatusChip.Tone
}
