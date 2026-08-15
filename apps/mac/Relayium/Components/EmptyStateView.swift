import SwiftUI

/// An address an empty state is asking the reader to open somewhere else.
///
/// It carries its own hint and identifier rather than deriving them, because
/// the visible title of a link like this IS the address: `relayium.com` is a
/// complete and honest VoiceOver label, and the one thing it cannot say is what
/// activating it does.
struct EmptyStateLink {
    let title: String
    let url: URL
    let accessibilityHint: String
    let identifier: String
}

/// A symbol, a title, an optional explanation, an optional address to open and
/// an optional action.
///
/// Hand-rolled because `ContentUnavailableView` is macOS 14 and this app deploys
/// to 13.0. It exists so that "nothing here yet" is a designed state with a way
/// forward rather than an `EmptyView()` — which is literally what the stored
/// download pane rendered before this round.
struct EmptyStateView: View {
    private let symbol: String
    private let title: String
    private let message: String?
    private let link: EmptyStateLink?
    private let actionTitle: String?
    private let action: (() -> Void)?
    /// Whether this action is the way off a screen that offers nothing else.
    ///
    /// Default false: an empty state is usually one part of a screen with live
    /// controls around it, and a prominent button there would outrank the work
    /// the user actually came to do. It is true only where the empty state IS
    /// the destination — a whole surface behind an account gate — because there
    /// the one button on screen is the only thing to press, and drawing it as an
    /// ordinary bordered control leaves a screenful of explanation with no
    /// visible exit.
    private let actionIsProminent: Bool

    /// `body:` is the outward name; it is stored as `message` because `body` is
    /// already taken by `View`.
    init(symbol: String,
         title: String,
         body: String? = nil,
         link: EmptyStateLink? = nil,
         actionTitle: String? = nil,
         actionIsProminent: Bool = false,
         action: (() -> Void)? = nil) {
        self.symbol = symbol
        self.title = title
        self.message = body
        self.link = link
        self.actionTitle = actionTitle
        self.actionIsProminent = actionIsProminent
        self.action = action
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol)
                .font(.title)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            // Both sentences are selectable. An empty state is where the reader
            // is told what to do somewhere ELSE — on another device, in another
            // app, to somebody else — and text they cannot select is text they
            // have to retype from memory. There is nothing to conflict with:
            // neither line is inside a control, and the link and the button
            // below are their own hit targets.
            Text(title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let link {
                // A `Link`, never a `Button` drawn to look like one. `Link` is
                // what makes an address behave as an address: the system's own
                // pointer and focus treatment, the contextual menu that copies
                // it, activation from the keyboard, and `openURL` deciding
                // where it goes rather than this view guessing. A button in
                // accent colour has the appearance and none of that — and this
                // is the exact screen where it matters, because the reader is
                // being asked to reach this address from a DIFFERENT device,
                // where copying it beats clicking it.
                //
                // Deliberately not also `.textSelection(.enabled)`: on a link,
                // selection takes the drag that activation and the copy menu
                // need, and the result is a control that looks live and answers
                // to nothing. Copying stays on the link's own menu.
                //
                // `.title3.weight(.semibold)` is this app's primary-VALUE type,
                // the same as the announced device name on the LAN screen — and
                // that is what an address to be read across a desk or typed
                // into another device is. Above the `.headline` title on
                // purpose: the title says what happened, this says what to do.
                Link(link.title, destination: link.url)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHint(link.accessibilityHint)
                    .accessibilityIdentifier(link.identifier)
            }
            if let actionTitle, let action {
                // Two branches rather than a conditional style: `buttonStyle`
                // takes a concrete type, and there is no state inside a `Button`
                // for the structural identity change to reset. Prominent is
                // still only a STYLE — no `keyboardShortcut(.defaultAction)` —
                // because ⏎ belongs to whatever form the user is actually
                // typing in, and this view is rendered inside several.
                if actionIsProminent {
                    Button(actionTitle, action: action)
                        .buttonStyle(.borderedProminent)
                } else {
                    Button(actionTitle, action: action)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
