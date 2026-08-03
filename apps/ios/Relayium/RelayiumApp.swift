import SwiftUI
import RelayiumAppKit

/// R3-A: the first native iOS slice.
///
/// One screen, one capability — receive an anonymous encrypted stored link —
/// built on the same `RelayiumKit`/`RelayiumAppKit` stack the macOS app and the
/// CLI already use. Sending, realtime, accounts, background transfer and the
/// Share Extension are later R3 slices and are deliberately absent rather than
/// stubbed.
///
/// No `onOpenURL` here. Without Associated Domains — which this slice does not
/// claim, because the routing it would justify does not exist yet — nothing can
/// deliver a URL to this app, so wiring the handler would be dead code that
/// reads like universal-link support.
@main
struct RelayiumApp: App {
    /// App-scoped rather than view-scoped, for the reason the macOS app scopes
    /// its transfer models the same way: a download in flight must survive the
    /// window's view tree being rebuilt.
    @StateObject private var download: CloudDownloadModel

    @MainActor
    init() {
        _download = StateObject(wrappedValue: AppEnvironment.makeDownloadModel())
    }

    var body: some Scene {
        WindowGroup {
            ReceiveView(model: download)
        }
    }
}
