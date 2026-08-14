import SwiftUI

/// **The whole visual vocabulary of the iOS app, in one file.**
///
/// The macOS app got this layer first and for the same reason: the numbers were
/// written as literals at every call site — a literal `20` between sections, a
/// literal `12` inside one, `.quaternary.opacity(0.35)` in two places and
/// `.quaternary.opacity(0.25)` in a third — so the next screen inherited nothing
/// and every screen was a slightly different app.
///
/// ## What it does NOT contain
///
/// No colour of its own beyond the two roles below, and no hex value anywhere.
/// UIKit already has semantic backgrounds and label colours that answer light
/// mode, dark mode, Increase Contrast and Smart Invert correctly, and a literal
/// written here would answer none of them. The one brand colour in the app is
/// the `AccentColor` asset — `#6D28D9`, `#7C3AED` in dark, the same asset values
/// the Mac ships — and it is reached through `Color.accentColor`, which is also
/// what makes the system draw the tab bar, switches, selection and prominent
/// buttons in it for free. `Palette` exists to say where it may and may not go.
///
/// No fonts either. Every string in this app uses a semantic text style so it
/// scales with the user's setting; the one deliberate exception is
/// `PairingCodeText`, which states its own reason.
enum Metrics {
    /// Between top-level sections on a screen. The value the two refreshed
    /// scroll views already used, kept so the rhythm did not change under the
    /// screens that were not touched.
    static let section: CGFloat = 20
    /// Between the parts of one section, and the padding inside a card.
    static let inner: CGFloat = 16
    /// Between a label and the thing it labels.
    static let tight: CGFloat = 8
    /// Between lines of the same thought.
    static let hairline: CGFloat = 4
    /// One card's corner. Continuous, at the call site — a circular corner at
    /// this radius reads as a foreign control on iOS.
    static let corner: CGFloat = 12
    /// The badge on a path stop. The connector is centred on it, so the two
    /// numbers are related rather than separately tuned.
    static let pathBadge: CGFloat = 22
    /// The smallest thing a finger is allowed to have to find. Every control
    /// here is `.controlSize(.large)`, which clears it — this is written down so
    /// that a future compact control has a floor to fail against rather than a
    /// look to match.
    static let hitTarget: CGFloat = 44
}

/// Where the brand violet is allowed to go.
///
/// It is an action colour, and this app has exactly three uses for it: the thing
/// you press, the row you are on, and the state that has actually been reached.
/// It is never body text, never a background behind a paragraph, and never
/// decoration — a screen that tints its prose has spent the one signal it had
/// for "this is the thing to do next".
///
/// Everything resolves through `Color.accentColor`, so the asset is the single
/// source and dark mode is already answered.
enum Palette {
    /// The primary action, the current selection, the reached state.
    static var action: Color { .accentColor }
    /// The same colour at the weight a background can carry behind a symbol —
    /// used for the one current stop on a path rail, never for a block of copy.
    static var actionSurface: Color { Color.accentColor.opacity(0.14) }
    /// A card, and the only container chrome in the app.
    ///
    /// Deliberately a system fill rather than a fill plus a hairline: the Mac
    /// needed the border because `controlBackgroundColor` on `windowBackground`
    /// is nearly invisible in Light, and `secondarySystemBackground` on
    /// `systemBackground` is not — it is the separation iOS itself uses for
    /// grouped content in both appearances, and it tracks Increase Contrast on
    /// its own.
    static var cardBackground: Color { Color(uiColor: .secondarySystemBackground) }
    /// A line that bounds or separates without being looked at.
    static var hairline: Color { Color(uiColor: .separator) }
}
