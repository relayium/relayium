import SwiftUI

/// **What this screen is for, said once, above the first group.**
///
/// The window's title bar and the highlighted sidebar row already carry the
/// destination's name, so a heading repeating it costs a line of a 560pt window
/// and adds nothing. The rule is: **the header names the destination only where
/// the sidebar does not**, and `MacSurface.browseable` is the one list that says
/// which those are, so there is no second answer to keep in step.
///
///  - A browseable destination — LAN, Cross-network, Send a link, Device Inbox,
///    Account — renders the symbol and the destination's own sentence.
///  - **Open a link** has no sidebar row (it is arrived at from a link the OS
///    hands the app), so nothing else on screen names it and the header does.
///
/// The sentence remains available as each row's `accessibilityHint` and pointer
/// tooltip; `navigationTitle` still names the window for Mission Control, the
/// window menu and VoiceOver's window chrome.
struct DetailHeader: View {
    /// An SF Symbol, the same one the sidebar row carries, in the one accent
    /// chip a screen is allowed before any control.
    let symbol: String
    let title: String
    /// The destination's own one sentence, or nil for the deep-link-only screen
    /// that has no sidebar row and therefore no sentence of its own.
    let purpose: String?
    /// Whether this header is the only thing that names the destination.
    let namesDestination: Bool

    var body: some View {
        HStack(alignment: .center, spacing: Metrics.inner) {
            chip
            VStack(alignment: .leading, spacing: 2) {
                if namesDestination {
                    Text(title)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        // On the leaf. An identifier on the stack would
                        // propagate down and rename the sentence under it.
                        .accessibilityIdentifier("destination-header")
                }
                if let purpose {
                    Text(purpose)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("destination-purpose")
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The symbol is decorative here: the screen says what it is in words
    /// either way, and an announced symbol would read that twice.
    private var chip: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(Palette.actionSurface)
            Image(systemName: symbol)
                .font(.callout)
                .foregroundStyle(Palette.actionLabel)
        }
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
    }
}
