import SwiftUI

/// **The one place an action decides what colour it is, and it is a role rather
/// than a tint.**
///
/// `DesignTokens` says where the brand violet may go. This file is the half of
/// that answer the accent asset cannot give, and it exists because of a measured
/// failure rather than a preference.
///
/// ## What was wrong
///
/// `Color.accentColor` is one value used two ways. The system draws it as a
/// FILL — the tab bar's selection, a switch, a `.borderedProminent` shape — and
/// SwiftUI also draws it as a FOREGROUND, because a `.bordered` button's label
/// and a plain button's text are both the accent on a neutral background. Those
/// two uses have different contrast requirements against different backgrounds,
/// and one value cannot satisfy both. Measured on real Dark screenshots of this
/// app, at 3× on a 402×874pt iPhone:
///
///  * as a fill it is correct. White on the dark accent `#7C3AED` measures
///    5.6–5.7:1, comfortably past the 4.5:1 text needs;
///  * as a foreground it is not. `#7C3AED` on the `#39393D` neutral fill a
///    `.bordered` button draws under it measures **2.02:1**, and on the
///    `#1C1C1E` card a plain text action sits on, **2.99:1**.
///
/// Darkening the accent asset would have fixed the labels and broken the fills,
/// which is why the accent is untouched and this is a second, narrower role.
///
/// ## What it is
///
/// `ActionLabel` in the asset catalog: `#6D28D9` in Light — the *same* value the
/// accent already resolves to there, so **Light mode is unchanged, by design and
/// by arithmetic** — and `#B49CFB` in Dark. Re-measured on the same screenshots
/// after the change, the two failures above became **4.91:1** and **7.4:1**, and
/// the nearby roster's selected glyph went from 2.70:1 to 6.7:1.
///
/// No high-contrast (`Increase Contrast`) appearance is declared, and that is a
/// decision rather than an omission: the asset would need one only if the
/// ordinary Dark value failed under it, and the fills these controls draw get
/// *more* separated in that mode, not less. Adding a third value this batch
/// cannot measure would be prose, not evidence. If a measured Increase Contrast
/// pass ever shows otherwise, the colourset is where the answer goes.
///
/// ## Why `.foregroundStyle` and not `.tint`
///
/// Both colour a `.bordered` button's label. Only one leaves its FILL alone —
/// and on iOS 26 `.bordered` derives that fill from the tint, so tinting the
/// label lighter lightened the pill underneath it by the same amount and the
/// ratio barely moved: `#B39BF9` on a tinted `#423C55` measured **4.47:1**,
/// still short. `.foregroundStyle` colours the words and leaves the neutral
/// `#39393D` fill exactly as the app already shipped it, which is both the
/// larger contrast gain and the smaller visual change.
///
/// ## Why a modifier and not a colour at the call site
///
/// There are 64 `.bordered` controls in this app. A colour written at each of
/// them is 64 chances to forget one, and the 65th would inherit the failing
/// value silently — which is exactly how the two the first audit happened to
/// visit came to be the only two anybody knew about. So `.buttonStyle(.bordered)`
/// is spelled HERE and nowhere else, every call site names its role, and
/// `IOSActionColorGuardTests` fails when a new one does not.
///
/// ## Why this file is not in the Share extension's target
///
/// `Components/DesignTokens.swift`, `InlineMessage.swift` and `SectionCard.swift`
/// are listed in `project.pbxproj` as membership exceptions that add them to
/// `RelayiumShare`'s sources. This file is deliberately NOT on that list, and
/// `Palette.actionLabel` is declared here rather than beside its siblings in
/// `DesignTokens` for that one reason: an extension resolves an asset name in
/// its OWN bundle, so a role reached through a symbol the app declares would be
/// a name that compiles everywhere and resolves in one place. A symbol the
/// extension cannot see fails to COMPILE instead, which is the only version of
/// that boundary which cannot be crossed by accident.
///
/// So the extension answers the same question in its own words. `ShareRootView`
/// has one ordinary bordered control — its Cancel — and it had the identical
/// defect, because that target's own `AccentColor` carries the identical
/// `#7C3AED`. It now ships an `ActionLabel` colourset in its OWN asset catalog
/// with these same two values and reaches for it by name, through the same
/// `.foregroundStyle` mechanism this file uses.
///
/// Two copies of one brand value is a thing that drifts, so it is guarded rather
/// than trusted: `IOSActionColorGuardTests` compares the two coloursets byte for
/// byte, requires that Cancel to keep the role, and refuses the app-only
/// spellings in that target.
extension Palette {
    /// The brand at the weight a LABEL can carry — an action's words, and the
    /// small symbols that mean something rather than decorate.
    ///
    /// Never a fill. `Palette.action` stays the fill role, and the two are
    /// deliberately not interchangeable: swapping them would put a 5.6:1 white
    /// label on a `#B49CFB` shape at 2.1:1.
    static var actionLabel: Color { Color("ActionLabel") }
}

/// What an action MEANS, which is the thing that decides its colour.
///
/// It mirrors SwiftUI's own `ButtonRole` rather than replacing it: the role
/// still goes on the `Button`, where it also decides the confirmation dialog's
/// wording and the accessibility trait. This is the second half of that same
/// statement, said where the style is applied, because a `ViewModifier` cannot
/// read the role off the button it is attached to.
///
/// Two cases and no default that guesses. The one control in the app whose role
/// is conditional — `NearbyLinkWorkspaceView`'s Leave, destructive while a
/// session is live and ordinary once it has ended — passes the same expression
/// to both.
enum ActionRole {
    /// Anything that is not destructive: choose, copy, share, retry, resume,
    /// look again, done. Drawn in `Palette.actionLabel`.
    case ordinary
    /// Delete, revoke, decline, reject, discard, end, sign out, cancel-with-loss.
    ///
    /// Drawn in the SYSTEM's destructive red, which is why this case sets no
    /// foreground at all rather than a red of its own. The red is a platform
    /// semantic — it tracks Increase Contrast, colour filters and whatever Apple
    /// changes it to — and a chosen red would be a second, worse copy of it that
    /// also stopped matching the confirmation dialogs these buttons open.
    case destructive
}

extension View {
    /// A bordered action, in the colour its role calls for.
    ///
    /// Deliberately does NOT set `.controlSize`. Sixty of the sixty-four call
    /// sites are `.large` and four are not, and folding the majority in here
    /// would have silently resized those four — a layout change smuggled into a
    /// colour fix. Size stays a call-site decision; colour does not.
    func borderedAction(_ role: ActionRole = .ordinary) -> some View {
        modifier(ActionColour(role: role, bordered: true))
    }

    /// A text action with no border — the way to the other half of a task, a
    /// Clear beside what it clears, a Dismiss under the notice it dismisses.
    ///
    /// Separate from `borderedAction` rather than a third `ActionRole`, because
    /// it answers a different question. The role says what an action means; this
    /// says what shape it has. A destructive text action keeps the system red
    /// and takes neither.
    ///
    /// It is for this app's OWN content only. The two kinds of text action it
    /// must not reach are the system's: a `ToolbarItem`, and the buttons inside
    /// an `.alert` or `.confirmationDialog`. Those are drawn by iOS on chrome
    /// this app does not paint and at contrasts it does not control, and
    /// colouring them would be a guess about a background the app cannot see.
    func textAction() -> some View {
        modifier(ActionColour(role: .ordinary, bordered: false))
    }
}

/// The one implementation both spellings share.
///
/// A `ViewModifier` rather than two `View` extensions because the destructive
/// branch and the ordinary branch return different opaque types, and a
/// `@ViewBuilder` body is what makes that one function instead of two.
private struct ActionColour: ViewModifier {
    let role: ActionRole
    let bordered: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if role == .destructive {
            styled(content)
        } else {
            styled(content).foregroundStyle(Palette.actionLabel)
        }
    }

    @ViewBuilder
    private func styled(_ content: Content) -> some View {
        if bordered { content.buttonStyle(.bordered) } else { content }
    }
}
