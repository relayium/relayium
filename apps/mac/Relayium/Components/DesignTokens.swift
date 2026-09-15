import AppKit
import SwiftUI

/// **The whole visual vocabulary of this app, in one file.**
///
/// The numbers come from the owner's macOS interface reference: a 216pt
/// sidebar, a 660pt reading measure, 16pt between groups, 11pt corners, and a
/// settings row that is at least 40pt tall with 8/14pt insets. They live here
/// rather than at forty call sites so a screen inherits the rhythm instead of
/// guessing at it.
///
/// ## What it does NOT contain
///
/// No fonts. Every string in the app uses a semantic text style, so it scales
/// with the user's settings; the one deliberate exception is
/// `SecurityCodeText`, which states its own reason and is scaled too. The
/// reference's five type sizes map onto macOS's own steps exactly — 17pt is
/// `.title2`, 13pt semibold is `.headline`, 13pt is `.body`, 12pt is
/// `.callout`, 11pt is `.subheadline` — so following the reference and
/// following the platform are the same thing here.
///
/// Almost no colour. macOS already has semantic backgrounds and text styles
/// that answer light mode, dark mode, Increase Contrast and Reduce Transparency
/// correctly, and a hex value written here would answer none of them. The one
/// brand colour is the `AccentColor` asset, reached through `Color.accentColor`
/// — which is also what makes the system draw selection, focus rings and
/// prominent buttons in it for free. `Palette` says where it may be spent.
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
    /// The reading measure. A wider window does not set the text wider — that
    /// is the first source of the reference's native feel, and the reason the
    /// column is centred rather than stretched.
    static let readingMeasure: CGFloat = 660
    /// A card's corner, and the window's.
    static let corner: CGFloat = 11
    /// A status head's corner: one step softer than a card, so the one
    /// summary per screen reads as a different kind of thing.
    static let heroCorner: CGFloat = 14
    /// A settings row: the floor, and the insets inside it.
    static let rowMinHeight: CGFloat = 40
    static let rowVertical: CGFloat = 8
    static let rowHorizontal: CGFloat = 14
    /// The sidebar's width in the reference. A minimum rather than a lock:
    /// dragging the split divider is a Mac behaviour, and removing it would
    /// cost more native feel than the fixed width buys.
    static let sidebar: CGFloat = 216
    static let sidebarMax: CGFloat = 260
    /// A sidebar row.
    static let sidebarRowHeight: CGFloat = 28
    /// The smallest thing a pointer or a Full Keyboard Access ring is allowed
    /// to have to find. 44pt is the platform's own answer, and a control that
    /// happens to measure 40 because its label is short is a control somebody
    /// misses.
    static let hitTarget: CGFloat = 44
    /// A control inside a compact grouped row: it LAYS OUT at this size so the
    /// 40pt row keeps its height, and takes `hitTarget` as its actual hit
    /// rectangle by overhanging the row's insets.
    static let compactControl: CGFloat = 24
    static var compactControlOverhang: CGFloat { (hitTarget - compactControl) / 2 }
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
///
/// `Level.primary` is the card. `Level.open` is a titled group with no chrome
/// at all, used INSIDE a card, which is what a bare `Divider` was reaching for.
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
    /// The primary action, the current selection, the verified state — as a
    /// FILL, with white on it. The `AccentColor` asset is shared with iOS and
    /// Android and is not forked here; at this weight it carries white at about
    /// 5.3:1 in Light and 5.7:1 in Dark.
    static var action: Color { .accentColor }
    /// The same role as a LABEL: an accent-tinted symbol or word drawn ON a
    /// surface rather than behind white.
    ///
    /// The fill value cannot do both jobs. `#7C3AED` on a dark card measures
    /// about 2.99:1, which is the defect iOS answered with a separate
    /// `ActionLabel` asset. Rather than fork the brand, this lifts the SAME
    /// asset toward the foreground in Dark — which lands on the lighter violet
    /// the reference asks for (about 5.7:1 on the dark card) and leaves Light,
    /// where the fill value is already a legible label, untouched.
    static var actionLabel: Color {
        Color(nsColor: NSColor(name: "relayiumActionLabel") { appearance in
            var accent = NSColor.controlAccentColor
            appearance.performAsCurrentDrawingAppearance {
                accent = NSColor.controlAccentColor.usingColorSpace(.sRGB) ?? accent
            }
            guard appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua else {
                return accent
            }
            return accent.blended(withFraction: 0.35, of: .white) ?? accent
        })
    }
    /// The same colour at the weight a background can carry behind ordinary
    /// text — a reached step on the path rail, the chip behind an accent
    /// symbol. Never a block of copy.
    static var actionSurface: Color { Color.accentColor.opacity(0.14) }
    /// The detail column behind the cards. The sidebar's own material and this
    /// are what separate the three surfaces; the card adds the third.
    static var pageBackground: Color { Color(nsColor: .windowBackgroundColor) }
    /// A card, and the only chrome in the app.
    static var cardBackground: Color { Color(nsColor: .controlBackgroundColor) }
    /// What lifts a card off the window in Dark, where the two system fills
    /// coincide. White at this weight is invisible on the white Light card and
    /// is the reference's own `rgba(255,255,255,.045)` at night, so one value
    /// answers both appearances.
    static var cardLift: Color { Color.white.opacity(0.045) }
    /// A status head: one step brighter than a card, and the only surface that
    /// is.
    static var heroBackground: Color { Color.white.opacity(0.03) }
    /// Behind a small glyph or a value that needs to read as a token rather
    /// than as text.
    static var chip: Color { Color.primary.opacity(0.07) }
    /// A hairline that separates without drawing a line the eye stops at.
    static var hairline: Color { Color(nsColor: .separatorColor) }
    /// The edge of a card.
    ///
    /// **A card needs one because its fill alone does not carry it in Light
    /// appearance.** It is the same role as `hairline` deliberately:
    /// `separatorColor` is the system's answer to "a line that bounds without
    /// being looked at", and it tracks Increase Contrast and both appearances
    /// on its own. Named separately only so the intent at the call site is a
    /// boundary rather than a division.
    static var cardBorder: Color { Color(nsColor: .separatorColor) }
}
