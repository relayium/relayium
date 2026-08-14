import SwiftUI

/// A symbol, a title, an optional explanation and an optional action.
///
/// Hand-rolled because `ContentUnavailableView` is macOS 14 and this app deploys
/// to 13.0. It exists so that "nothing here yet" is a designed state with a way
/// forward rather than an `EmptyView()` — which is literally what the stored
/// download pane rendered before this round.
struct EmptyStateView: View {
    private let symbol: String
    private let title: String
    private let message: String?
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
         actionTitle: String? = nil,
         actionIsProminent: Bool = false,
         action: (() -> Void)? = nil) {
        self.symbol = symbol
        self.title = title
        self.message = body
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
            Text(title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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
