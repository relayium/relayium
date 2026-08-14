import SwiftUI

/// **What this screen is for, said once, where there is room to say it.**
///
/// ## The name is said by the chrome; this says the purpose
///
/// Every destination used to open with a `largeTitle` and a caption copied
/// verbatim from the sidebar row that had just been clicked. That was removed
/// for a good reason — on a Mac the sidebar is on screen at the same time with
/// that row highlighted, so a heading repeating it told the reader nothing —
/// and removing it created the opposite problem: five long explanatory
/// sentences were left stacked in a 208pt column, three lines each, and the
/// longest locales made the sidebar itself unusable at the 560pt minimum
/// height.
///
/// So the sentence moved rather than came back — and then came back with the
/// title still attached to it, which put the destination's name on screen three
/// times at once: the highlighted sidebar row, the window's own title bar (a
/// `navigationTitle` on the detail column IS the window title, sitting directly
/// above this view), and this heading between them. The audit's finding is that
/// the third one costs a line of a 560pt window and adds nothing.
///
/// **So the rule is: the header names the destination only where the sidebar
/// does not.** `MacSurface.browseable` is the one list that says which those
/// are, so there is no second answer to keep in step:
///
///  - A browseable destination — LAN, Cross-network, Send a link, Device Inbox,
///    Account — has a row and a window title already carrying its name, so this
///    renders the symbol and the destination's own sentence, and nothing else.
///  - **Open a link** has no sidebar row (it is arrived at from a link the OS
///    hands the app), so nothing else on screen names it and the header does.
///    It has no sentence of its own for the same reason: there is no row for one
///    to have moved from.
///
/// The sentence remains available in three appropriate places: as each row's
/// `accessibilityHint`, as its pointer tooltip, and visibly on the selected
/// destination in a column with room to render it. `navigationTitle` still names
/// the window for Mission Control, the window menu and VoiceOver's window chrome.
struct DetailHeader: View {
    /// An SF Symbol, the same one the sidebar row carries, tinted with the one
    /// action colour — the only place on the screen it appears before a control.
    let symbol: String
    let title: String
    /// The destination's own one sentence, or nil for the deep-link-only screen
    /// that has no sidebar row and therefore no sentence of its own.
    let purpose: String?
    /// Whether this header is the only thing that names the destination.
    ///
    /// Derived by `DestinationScaffold` from `MacSurface.isBrowseable` rather
    /// than passed by each screen, so "which destinations does the sidebar name"
    /// has exactly one answer in the app.
    let namesDestination: Bool

    var body: some View {
        HStack(alignment: .top, spacing: Metrics.inner) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(Palette.action)
                // The screen says what it is in words either way, and a symbol
                // that announced itself would read that twice.
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                if namesDestination {
                    Text(title)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        // On the leaf. An identifier on the stack would
                        // propagate down and rename the sentence under it, which
                        // is the defect this app has already lost controls to
                        // twice.
                        .accessibilityIdentifier("destination-header")
                }
                if let purpose {
                    // `callout` rather than `subheadline`: with the title gone
                    // this is the first line of the detail column, and it has to
                    // be scannable on its own rather than read as a caption
                    // under something. Still secondary — it explains the screen,
                    // it is not the thing to do on it.
                    Text(purpose)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
                        .accessibilityIdentifier("destination-purpose")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
