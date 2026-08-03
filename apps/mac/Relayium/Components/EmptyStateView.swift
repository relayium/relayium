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

    /// `body:` is the outward name; it is stored as `message` because `body` is
    /// already taken by `View`.
    init(symbol: String,
         title: String,
         body: String? = nil,
         actionTitle: String? = nil,
         action: (() -> Void)? = nil) {
        self.symbol = symbol
        self.title = title
        self.message = body
        self.actionTitle = actionTitle
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
                Button(actionTitle, action: action)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
