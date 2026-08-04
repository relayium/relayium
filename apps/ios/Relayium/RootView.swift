import SwiftUI
import RelayiumAppKit

/// The app's shell, and deliberately the dumbest file in it.
///
/// It never reads `session.state`. The receive flow R3-A shipped works with no
/// account, and the only way to keep that true in a slice that ADDS an account
/// is to make it structural: the tab bar and all three tabs exist in every
/// session state, so signing out, failing to sign in, or never signing in
/// cannot remove, gate or rebuild the receive tab.
///
/// R3-C adds the Send tab, which is the first tab that genuinely needs an
/// account — and the temptation it creates is a "is the user signed in" gate up
/// here, above the tab bar. There is none. The send tab's gate lives INSIDE the
/// send tab, and the only thing this file learns about the account is where to
/// route a user who needs one: `onOpenAccount` is a tab-selection change handed
/// down as a closure, not a session read.
struct RootView: View {
    private enum Tab: Hashable { case receive, send, account }

    @EnvironmentObject private var session: AccountSession
    /// The ONE account-adjacent fact this file learns, and it is not who is
    /// signed in: whether a sign-out's network revocation is currently running.
    ///
    /// That distinction is the whole reason this does not break the rule above.
    /// A gate on `session.state` would decide which tabs exist from whether
    /// somebody has an account, which is what the tab bar's structure exists to
    /// avoid. This is a transient operation — it goes up when a revocation
    /// starts and comes down when it ends, signed in or not — and while it is up
    /// the bearer is either already dead server-side or being killed, so an
    /// action in ANY tab would be spent against a credential that is going away.
    @EnvironmentObject private var signOut: AccountSignOutCoordinator
    @ObservedObject var download: CloudDownloadModel
    @ObservedObject var upload: CloudUploadModel
    @ObservedObject var send: SendSelectionModel
    @State private var selection: Tab = .receive

    var body: some View {
        TabView(selection: $selection) {
            ReceiveView(model: download)
                .tabItem { Label(L10n.t(.tabReceive), systemImage: "tray.and.arrow.down") }
                .tag(Tab.receive)

            SendView(upload: upload, selection: send,
                     onOpenAccount: { self.selection = .account })
                .tabItem { Label(L10n.t(.tabSend), systemImage: "arrow.up.doc") }
                .tag(Tab.send)

            AccountTab()
                .tabItem { Label(L10n.t(.tabAccount), systemImage: "person.crop.circle") }
                .tag(Tab.account)
        }
        // Applied to the `TabView` itself, so it reaches every control in every
        // tab AND the tab bar — a tab the user could still switch to would be a
        // tab they could still act in. It is the one place this rule lives; no
        // individual screen repeats it.
        .disabled(signOut.isSigningOut)
        // Said out loud, not merely enforced. A tab bar that stops responding
        // with no explanation reads as the app having hung, and a bare
        // `ProgressView()` reads as nothing at all to VoiceOver. The overlay is
        // deliberately outside the `.disabled` chain's meaning — it states what
        // the app is waiting for, and it goes away when the call does.
        .overlay {
            if signOut.isSigningOut {
                ProgressView { Text(L10n.t(.accountSigningOut)) }
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
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
