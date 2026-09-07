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
/// No colour of its own beyond the roles below, and no hex value anywhere. UIKit
/// already has semantic backgrounds and label colours that answer light mode,
/// dark mode, Increase Contrast and Smart Invert correctly, and a literal
/// written here would answer none of them. Both brand values in the app are
/// assets: `AccentColor` — `#6D28D9`, `#7C3AED` in dark, the same asset values
/// the Mac ships — reached through `Color.accentColor`, which is also what makes
/// the system draw the tab bar, switches, selection and prominent buttons in it
/// for free; and `ActionLabel`, which `Components/ActionButton.swift` declares
/// and explains. `Palette` exists to say where each may and may not go.
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
    /// The brand as a FILL: the tab bar's selection, a switch, a
    /// `.borderedProminent` shape, and the wash below.
    ///
    /// Not a foreground. White on this measures 5.6–5.7:1 and is correct; this
    /// colour ON something measured 2.02–2.99:1 and is not, which is what
    /// `Palette.actionLabel` in `Components/ActionButton.swift` answers. The
    /// split is the one rule to keep: an accent-coloured label or meaningful
    /// symbol uses that role, never this one.
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
    /// **Prose the eye reaches second.** Every explanation, caption, detail line,
    /// timestamp, byte count and empty-state sentence in the app.
    ///
    /// It exists because the system role it replaces is not readable enough in
    /// Light. `Color.secondary` there is `#3C3C43` at 60%, which composites to
    /// `#8A8A8E` on white and measures **3.44:1** — and **3.29:1** on
    /// `Palette.cardBackground`, which is where most of this app's supporting
    /// prose actually sits. WCAG 1.4.3 wants 4.5:1 for text this size, and none
    /// of it is large enough for the 3:1 exemption.
    ///
    /// The asset answers all four appearances rather than one:
    ///
    /// | appearance | value | worst measured background | ratio |
    /// | --- | --- | --- | --- |
    /// | Light | `#66666C` | `#E7E7EC` quaternary composite | 4.63:1 |
    /// | Light + Increase Contrast | `#4A4A50` | same | 7.14:1 |
    /// | Dark | `#98989F` | `#28282A` quaternary composite | 5.13:1 |
    /// | Dark + Increase Contrast | `#C6C6CE` | same | 8.67:1 |
    ///
    /// The Increase Contrast rows are written down because they are the thing a
    /// literal loses. `Color.secondary` tracks that setting for free; a named
    /// asset only tracks it if the catalog declares the variant, and one that
    /// did not would have quietly made the accessibility setting a no-op on
    /// every sentence in the app. `IOSSupportingTextGuardTests` recomputes all
    /// four numbers from the catalog rather than trusting this table.
    ///
    /// Not a fill, not a symbol, not a control tint. The system role stays where
    /// it belongs: a decorative glyph, a disclosure chevron, a pending marker,
    /// an unselected checkbox — things WCAG measures at 3:1 as graphics, or not
    /// at all. Those uses are enumerated in the guard by name.
    static var supportingLabel: Color { Color("SupportingLabel") }
    /// **A warning said in words**, at a contrast the words survive.
    ///
    /// `Color.orange` is `#FF9500` in Light and measures **2.14:1** on white —
    /// so the over-limit byte counter and the "not sent" label, the two places
    /// this app puts a warning into small prose, were the least readable text in
    /// it. Being redundant with a symbol makes the symbol accessible; it does
    /// not make the sentence beside it legible.
    ///
    /// | appearance | value | worst measured background | ratio |
    /// | --- | --- | --- | --- |
    /// | Light | `#9A4C00` | `#E7E7EC` quaternary composite | 5.00:1 |
    /// | Light + Increase Contrast | `#7A3D00` | same | 6.83:1 |
    /// | Dark | `#FF9F0A` | `#28282A` quaternary composite | 7.16:1 |
    /// | Dark + Increase Contrast | `#FFB340` | same | 8.25:1 |
    ///
    /// The dark values are the system's own orange pair, kept deliberately: dark
    /// orange was never the failure, and changing it would have moved a colour
    /// that measures 7:1 for the sake of symmetry.
    ///
    /// The accompanying `exclamationmark.triangle.fill` symbols take this role
    /// too. Not because a redundant glyph needs 4.5:1 — it does not — but
    /// because leaving them at system orange would have put two different
    /// oranges inside one warning, in the same `HStack`, which is the state the
    /// dark-action batch recorded as worse than being uniformly wrong.
    static var warningLabel: Color { Color("WarningLabel") }
}
