import SwiftUI

/// A symbol and a sentence, for a list that is empty for a reason.
///
/// Hand-rolled because `ContentUnavailableView` is iOS 17 and this app deploys
/// to 16.0. It exists so that "nothing here yet" is a designed state that says
/// what to do about it, drawn the same way on both surfaces that have one — the
/// nearby roster before another device arrives, and the device list of an
/// account that has not set one up.
///
/// It carries no action of its own. On both of those surfaces the thing to press
/// next is already on the screen — Look again below the roster, Refresh above
/// the device list — and a second button here would be a duplicate control that
/// looks like the primary one.
struct EmptyStateView: View {
    private let symbol: String
    private let message: String
    private let detail: String?

    init(symbol: String, message: String, detail: String? = nil) {
        self.symbol = symbol
        self.message = message
        self.detail = detail
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(.secondary)
                // The sentence below carries the meaning; the symbol is a
                // landmark for the eye and says nothing to VoiceOver.
                .accessibilityHidden(true)
            Text(message)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if let detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
