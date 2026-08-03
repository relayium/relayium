import SwiftUI
import RelayiumAppKit

/// The app's shell, and deliberately the dumbest file in it.
///
/// It never reads `session.state`. The receive flow R3-A shipped works with no
/// account, and the only way to keep that true in a slice that ADDS an account
/// is to make it structural: the tab bar and both tabs exist in every session
/// state, so signing out, failing to sign in, or never signing in cannot
/// remove, gate or rebuild the receive tab.
struct RootView: View {
    private enum Tab: Hashable { case receive, account }

    @EnvironmentObject private var session: AccountSession
    @ObservedObject var download: CloudDownloadModel
    @State private var selection: Tab = .receive

    var body: some View {
        TabView(selection: $selection) {
            ReceiveView(model: download)
                .tabItem { Label(L10n.t(.tabReceive), systemImage: "tray.and.arrow.down") }
                .tag(Tab.receive)

            AccountTab()
                .tabItem { Label(L10n.t(.tabAccount), systemImage: "person.crop.circle") }
                .tag(Tab.account)
        }
        // Launch restore. This is the ONE call site, which is what the surface
        // guard checks — not that it runs once. SwiftUI decides when a view's
        // task runs, and a rebuilt root, a re-created scene or a later
        // multi-scene setup can start it again; no Info.plist key makes that
        // impossible. Safety comes from the session instead: it is App-scoped,
        // so every invocation reaches the same object, and `restore()` is
        // re-entrant — early-returning on a live account or an in-flight
        // sign-in, refreshing rather than cold-starting when a token is held,
        // and guarding every post-await write on its operation generation.
        .task { await session.restore() }
    }
}
