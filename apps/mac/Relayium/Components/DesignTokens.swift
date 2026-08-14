import SwiftUI

/// **The whole visual vocabulary of this app, in one file.**
///
/// Not a design system and deliberately not trying to be one. It is the small
/// set of numbers and roles that were previously written as literals at forty
/// call sites — a literal `24` gutter, a literal `16` spacing, a literal `720`
/// reading measure,
/// `Color(nsColor: .controlBackgroundColor)`, `cornerRadius: 10` — so that the
/// next screen inherits the rhythm instead of guessing at it, and so a change to
/// the rhythm is one edit rather than a search.
///
/// ## What it does NOT contain
///
/// No colour of its own. macOS already has semantic backgrounds and text styles
/// that answer light mode, dark mode, Increase Contrast and Reduce Transparency
/// correctly, and a hex value written here would answer none of them. The one
/// brand colour in the app is the `AccentColor` asset (`#6D28D9`, `#7C3AED` in
/// dark), and it is reached through `Color.accentColor` — which is also what
/// makes the system draw selection, focus rings and prominent buttons in it for
/// free. `Palette` below exists to say where it may and may not be spent.
///
/// No fonts either. Every string in the app uses a semantic text style, so it
/// scales with the user's settings; the one deliberate exception is
/// `SecurityCodeText`, which states its own reason and is now scaled too.
enum Metrics {
    /// The gutter around a destination's content.
    static let page: CGFloat = 24
    /// Between top-level sections inside a destination.
    static let section: CGFloat = 16
    /// Between the parts of one section.
    static let inner: CGFloat = 12
    /// Between a label and the thing it labels.
    static let tight: CGFloat = 8
    /// Between lines of the same thought.
    static let hairline: CGFloat = 4
    /// The reading measure for prose. Not a compatibility floor — a paragraph
    /// set at a thousand points is unreadable, and a destination with wide
    /// structured data opts out and constrains only its prose.
    static let readingMeasure: CGFloat = 720
    /// One card's corner.
    static let corner: CGFloat = 10
}

/// The two container weights a destination is allowed to use, and nothing
/// between them.
///
/// Depth was the actual complaint about this app's screens: a `SectionCard`
/// containing `Divider`-separated groups reads as one flat box with lines in it,
/// and the obvious repair — nesting a second card — produces a box inside a box.
/// So there are exactly two levels. `Level.primary` is the card. `Level.open` is
/// a titled group with no chrome at all, used INSIDE a card, which is what the
/// dividers were reaching for.
enum SurfaceLevel {
    /// A card: the app's only container chrome.
    case primary
    /// A titled group with no background, nested inside a card.
    case open
}

/// Where the brand violet is allowed to go.
///
/// It is an action colour, and the app has exactly three uses for it: the thing
/// you press, the row you are on, and the code you are checking. It is never
/// body text, never a background for a paragraph, and never decoration — a
/// screen that tints its prose has spent the one signal it had for "this is the
/// thing to do next".
///
/// Everything here resolves through `Color.accentColor`, so the asset is the
/// single source and dark mode is already answered.
enum Palette {
    /// The primary action, the current selection, the verified state.
    static var action: Color { .accentColor }
    /// The same colour at the weight a background can carry behind ordinary
    /// text — used for the one-step-at-a-time marker on the path rail, never
    /// for a block of copy.
    static var actionSurface: Color { Color.accentColor.opacity(0.14) }
    /// A card, and the only chrome in the app.
    static var cardBackground: Color { Color(nsColor: .controlBackgroundColor) }
    /// A hairline that separates without drawing a line the eye stops at.
    static var hairline: Color { Color(nsColor: .separatorColor) }
    /// The edge of a card.
    ///
    /// **A card needs one because its fill alone does not carry it in Light
    /// appearance.** `controlBackgroundColor` on `windowBackgroundColor` is
    /// roughly `#FFFFFF` on `#ECECEC` in Light and about six times that
    /// separation in Dark, so the same two colours that make a card obvious at
    /// night make it a barely-there rectangle by day — the audit's finding, and
    /// the reason four stacked cards read as one undifferentiated column.
    ///
    /// It is the SAME role as `hairline`, deliberately: `separatorColor` is the
    /// system's answer to "a line that bounds without being looked at", it
    /// tracks Increase Contrast and both appearances on its own, and giving a
    /// card edge a second, louder colour of its own would be exactly the kind of
    /// invented vocabulary this file exists to prevent. Named separately only so
    /// the intent at the call site is a boundary rather than a division, and so
    /// a future change to one does not silently move the other.
    ///
    /// Not a shadow and not a gradient. A drop shadow under every card is depth
    /// the app does not have — there are two levels, and the second has no
    /// background at all — and it costs offscreen rendering per card for a cue
    /// a one-pixel line already gives.
    static var cardBorder: Color { Color(nsColor: .separatorColor) }
}
