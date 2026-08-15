import SwiftUI
import RelayiumAppKit

/// The app's shell, and deliberately the dumbest file in it.
///
/// It never reads `session.state`. The receive flow R3-A shipped works with no
/// account, and the only way to keep that true in a slice that ADDS an account
/// is to make it structural: the tab bar and all five tabs exist in every
/// session state, so signing out, failing to sign in, or never signing in
/// cannot remove, gate or rebuild the anonymous tabs.
///
/// R3-C adds the Send tab, which is the first tab that genuinely needs an
/// account — and the temptation it creates is a "is the user signed in" gate up
/// here, above the tab bar. There is none. The send tab's gate lives INSIDE the
/// send tab, and the only thing this file learns about the account is where to
/// route a user who needs one: the routes are destination selections handed
/// down as closures, not session reads.
///
/// R3-E adds Direct, whose two halves are gated DIFFERENTLY — creating a code
/// needs an account, joining one needs nothing — so the natural way to draw them
/// apart would be a `session.state` switch up here, and it would take the
/// anonymous receive tab with it. Direct got the same treatment as Send: the
/// gate is inside it.
///
/// **R3-F changes exactly two things here, and both are about a session nobody
/// asked for.**
///
///  1. The selection moved from a `@State` to the app-scoped
///     `AppNavigationModel`. An unsolicited nearby session has to be able to
///     select the Nearby tab from outside the view tree — it is admitted on a
///     socket's queue, with no view involved — and a `@State` is reset whenever
///     SwiftUI rebuilds that tree, which is a thing it may do at any time.
///     `AppDestination` is the same five-case vocabulary the macOS shell uses,
///     so the two shells route from one enum rather than two that can drift.
///  2. It reconciles `TransferPresence` when both models go idle. Ownership
///     outlives a transfer on purpose — a `.completed` receive still owns its
///     result and its share sheet, an `.ended` text session still owns the only
///     copy of its transcript — so the one fact that can make it stale is that
///     there is no session left at all. Doing it HERE rather than in a tab is
///     the point: the tab that claimed ownership may be the one SwiftUI has
///     torn down, and a stale owner leaves the other tab showing "shown
///     elsewhere" for a transfer that is not running anywhere.
///
/// **Universal Links add a third, and it is the same kind of thing:** a link the
/// OS delivers arrives for a tab that is not on screen. This file is where the
/// one subscription lives, for the reason the selection moved up here — a
/// handler inside a tab is absent for exactly the case that matters. It decides
/// nothing about the link: `AppDeepLinkCoordinator` owns where it goes and what
/// it is allowed to overwrite, and that object lives in the shared layer where a
/// test can drive it against real models.
struct RootView: View {
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
    // The device-delivery half of the Send tab, passed through for the same
    // reason every other model here is: this file renders none of it and decides
    // none of it.
    @ObservedObject var deliveries: InboxSendModel
    @ObservedObject var sendRoutes: SendRouteSelection
    // The direct half's app-scoped owners, passed through rather than read:
    // this file renders none of their state and decides none of it. The four
    // that both direct tabs share are handed to BOTH — one set of models, one
    // set of security scopes, one answer to files-or-text.
    @ObservedObject var direct: RealtimeSessionModel
    @ObservedObject var directText: RealtimeTextSessionModel
    @ObservedObject var directSelection: DirectSendSelection
    @ObservedObject var directModes: DirectModeSelection
    @ObservedObject var foreground: ForegroundSessionCoordinator
    @ObservedObject var discovery: LanDiscoveryModel
    @ObservedObject var nearbyReceive: NearbyReceiveModel
    @ObservedObject var residency: NearbyResidencyCoordinator
    /// The unified `link/1` and its own post-connect file selection. Both go to
    /// the Nearby tab alone: `link/1` is code-less-room only on this platform,
    /// so the Direct tab has nothing to do with either.
    @ObservedObject var link: LinkWorkspaceModel
    @ObservedObject var linkSelection: DirectSendSelection
    @ObservedObject var navigation: AppNavigationModel
    @ObservedObject var presence: TransferPresence
    // Routing only. This file renders neither: it observes the one place a
    // verified link arrives and hands it straight to the coordinator that
    // decides what it may touch.
    @ObservedObject var deepLinks: AppDeepLinkRouter
    @ObservedObject var deepLinkRouting: AppDeepLinkCoordinator

    var body: some View {
        TabView(selection: $navigation.selection) {
            ReceiveView(model: download)
                .tabItem { Label(L10n.t(.tabReceive), systemImage: "tray.and.arrow.down") }
                .tag(AppDestination.storedReceive)

            SendView(upload: upload, selection: send,
                     deliveries: deliveries, routes: sendRoutes,
                     onOpenAccount: { navigation.select(.account) })
                .tabItem { Label(L10n.t(.tabSend), systemImage: "arrow.up.doc") }
                .tag(AppDestination.storedSend)

            DirectView(file: direct, text: directText,
                       selection: directSelection, modes: directModes,
                       foreground: foreground, presence: presence,
                       // Two destination selections, and neither is a session
                       // read. The first is the honest route for a large file —
                       // Direct needs both devices open, Send does not — and the
                       // second is where a user who needs an account goes.
                       onOpenSend: { navigation.select(.storedSend) },
                       onOpenAccount: { navigation.select(.account) },
                       onShowSession: { navigation.select($0) })
                .tabItem { Label(L10n.t(.tabDirect), systemImage: "arrow.left.arrow.right") }
                .tag(AppDestination.pairingCode)

            NearbyView(file: direct, text: directText,
                       selection: directSelection, modes: directModes,
                       foreground: foreground, presence: presence,
                       discovery: discovery, receive: nearbyReceive,
                       residency: residency,
                       link: link, linkSelection: linkSelection,
                       onShowSession: { navigation.select($0) })
                .tabItem { Label(L10n.t(.navNearby), systemImage: "dot.radiowaves.left.and.right") }
                .tag(AppDestination.nearby)

            AccountTab(onOpenStoredLink: { deepLinkRouting.deliverStoredLink($0) })
                .tabItem { Label(L10n.t(.tabAccount), systemImage: "person.crop.circle") }
                .tag(AppDestination.account)
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
        // A link the OS handed this app. `AppDeepLinkRouter` has already refused
        // anything that is not a relayium.com link this app can serve, so what
        // arrives is one of exactly two shapes — and everything that happens to
        // it is the shared coordinator's. In particular this file does not
        // decide whether the link may overwrite a transfer that is running; that
        // is the whole reason the coordinator exists.
        .onReceive(deepLinks.$pending.compactMap { $0 }) { link in
            deepLinkRouting.deliver(link)
            // Consumed one turn later, and BOTH halves of that are load-bearing.
            //
            // Deferred, because `@Published` emits in `willSet`: this handler
            // runs before the router has stored the link, so a `consume()` from
            // here is overwritten by the very assignment that delivered it —
            // leaving the router holding a link that `Published` then replays to
            // the next subscriber, which is a re-resolve of a download the user
            // may already have saved. `AppDeepLinkTests` pins that ordering.
            //
            // And EXPECTED, because that deferral is real time: a second link
            // can land inside it, and a bare `consume()` would throw away a link
            // this subscription has never seen and `Published` will not re-emit.
            Task { @MainActor in deepLinks.consume(link) }
        }
    }
}
