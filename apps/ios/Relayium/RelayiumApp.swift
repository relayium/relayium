import SwiftUI
import RelayiumAppKit

/// R3-B: the second native iOS slice.
///
/// Two tabs. **Receive** is R3-A unchanged — an anonymous encrypted stored link,
/// no account involved. **Account** is password sign-in and a read-only usage
/// summary on the same `AccountSession` the macOS app runs. Sending, realtime,
/// device and file management, background transfer, the Share Extension and
/// notifications are later R3 slices and are deliberately absent rather than
/// stubbed.
///
/// Still no `onOpenURL`. Without Associated Domains — which this slice does not
/// claim, because the routing it would justify still does not exist — nothing
/// can deliver a URL to this app, so wiring the handler would be dead code that
/// reads like universal-link support.
@main
struct RelayiumApp: App {
    /// App-scoped rather than view-scoped, for the reason the macOS app scopes
    /// its models the same way: a download in flight must survive the view tree
    /// being rebuilt, and the session outlives any one screen.
    @StateObject private var download: CloudDownloadModel
    @StateObject private var session = AppEnvironment.makeSession()

    @MainActor
    init() {
        _download = StateObject(wrappedValue: AppEnvironment.makeDownloadModel())
    }

    var body: some Scene {
        WindowGroup {
            RootView(download: download)
                .environmentObject(session)
        }
    }
}
