import SwiftUI
import Sparkle
import RelayiumAppKit
// For the two protocol values the pairing-code fallback carries — the room's
// deterministic `Role` and the `ICEConfig` its code was issued — which reach
// this scene as themselves rather than as anything it re-derives.
import RelayiumKit

/// Keeps the SwiftUI command enabled state in sync with Sparkle's updater.
///
/// `canCheckForUpdates` is KVO-backed rather than SwiftUI state, so reading it
/// directly from a button would leave the menu disabled state stale.
@MainActor
final class CheckForUpdatesViewModel: ObservableObject {
    @Published var canCheckForUpdates = false

    init(updater: SPUUpdater) {
        updater.publisher(for: \.canCheckForUpdates)
            .assign(to: &$canCheckForUpdates)
    }
}

struct CheckForUpdatesView: View {
    @ObservedObject private var model: CheckForUpdatesViewModel
    private let updater: SPUUpdater

    init(updater: SPUUpdater) {
        self.updater = updater
        model = CheckForUpdatesViewModel(updater: updater)
    }

    var body: some View {
        Button(L10n.t(.appCheckForUpdates), action: updater.checkForUpdates)
            .disabled(!model.canCheckForUpdates)
    }
}

/// Refuses a silent exit while work or the only text-history copy is at risk.
///
/// Deferring background `URLSession` to R3 means a transfer dies with the app.
/// That is a deliberate deferral, so this round owns its consequence rather than
/// letting a user discover it by losing an upload they watched for two minutes.
@MainActor
final class AppQuitGuard: NSObject, NSApplicationDelegate {
    /// Set by the scene once the models exist. A closure rather than references
    /// so the delegate holds no opinion about what a transfer is.
    var isTransferRunning: (() -> Bool)?
    var hasLocalText: (() -> Bool)?
    var cancelTransfers: (() -> Void)?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let risk = QuitPresentation.risk(transferRunning: isTransferRunning?() == true,
                                         hasLocalText: hasLocalText?() == true)
        guard let prompt = QuitPresentation.prompt(for: risk) else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = prompt.title
        alert.informativeText = prompt.body
        alert.addButton(withTitle: prompt.quitAction)
        alert.addButton(withTitle: prompt.stayAction)
        guard alert.runModal() == .alertFirstButtonReturn else { return .terminateCancel }
        cancelTransfers?()
        return .terminateNow
    }

    /// The menu bar — not the window — is what makes this Mac reachable. The room
    /// socket, an in-flight transfer and `MenuBarExtra` all outlive the window, so
    /// closing it must not end the process. Quit is still ⌘Q, still guarded by
    /// `applicationShouldTerminate` above.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Finder's **Open With**, and a drop on the Dock icon.
    ///
    /// **The `urls` are empty here, and that is not a bug to work around.**
    /// Measured on this tree: SwiftUI's own app delegate consumes an open and
    /// re-publishes each URL through the scene's `onOpenURL` — including
    /// `file://` ones — and then calls this method with nothing left in it. The
    /// probe that established it logged `onOpenURL file:///…/qa-sample.txt`
    /// followed one millisecond later by `application(_:open:) got 0 urls`. So
    /// the payload arrives at the scene, and this method's only remaining job is
    /// the one the scene cannot do.
    ///
    /// That job is showing the window. The most native case for this feature is
    /// also the one where there is nothing on screen: the app is resident in the
    /// menu bar with its window closed, the user picks Open With, and without
    /// this the files stage correctly into a window nobody can see.
    ///
    /// The array is still forwarded rather than ignored. It is empty on every
    /// macOS this tree has been run on, so that branch is not exercised today —
    /// but the failure it covers is silent, and a version of this method that
    /// dropped a non-empty array on the floor would lose the user's files with
    /// no error anywhere.
    func application(_ application: NSApplication, open urls: [URL]) {
        showTheMainWindow()
        if !urls.isEmpty { didOpenFiles?(urls) }
    }

    /// Where opened files would go if AppKit stopped emptying the array above.
    ///
    /// Wired to the same app-scoped router `onOpenURL` feeds, so the fallback is
    /// a working path rather than a comment.
    var didOpenFiles: (([URL]) -> Void)?

    /// Bring the window back when files arrive and it is closed.
    ///
    /// `SwiftUI.Window` is a single persistent window rather than a group, so
    /// closing it orders it out instead of releasing it, and it is still in
    /// `NSApp.windows` to be ordered back. That is exactly why this app's main
    /// scene is a `Window`; against a `WindowGroup` there would be nothing here
    /// to find, and re-creating one would be the second window the whole shell
    /// is designed to prevent.
    ///
    /// Which window, and why not simply the first titled one. This process owns
    /// several `NSWindow`s and three of them are titled: the shell, Sparkle's
    /// update window, and the quit-guard `NSAlert` this same class puts up. The
    /// first-titled rule would order whichever AppKit happened to list first,
    /// so an Open With during an update check could raise the updater and leave
    /// the staged files invisible — the exact bug this method exists to prevent.
    ///
    /// `canBecomeMain` is the property that separates them: only a real document
    /// window can become the app's main window. An alert is a modal panel and
    /// the `MenuBarExtra`'s status item is not a main-window candidate either,
    /// so neither can be selected here regardless of ordering. `isSheet` is
    /// excluded as well, because a sheet reports its parent's capabilities while
    /// being the wrong thing to raise on its own.
    private func showTheMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        guard let window = NSApp.windows.first(where: {
            $0.canBecomeMain && $0.styleMask.contains(.titled) && $0.sheetParent == nil
        }) else { return }
        window.makeKeyAndOrderFront(nil)
    }
}

@main
struct RelayiumApp: App {
    private let updaterController = SPUStandardUpdaterController(
        startingUpdater: true,
        updaterDelegate: nil,
        userDriverDelegate: nil
    )
    @NSApplicationDelegateAdaptor(AppQuitGuard.self) private var quitGuard
    /// Whether this app is frontmost. Read only to notice a return to `.active`,
    /// which is when a draft the Share extension staged in the meantime becomes
    /// collectable.
    @Environment(\.scenePhase) private var scenePhase
    // Assigned in `init` rather than defaulted inline, because the sign-out
    // coordinator built there needs a reference to it: a property's wrapped
    // value cannot be read from `init`, so the object has to exist as a local
    // first. Same shape the iOS app uses for the same reason.
    @StateObject private var session: AccountSession
    /// The link the OS handed this app, parsed and held until the shell has acted
    /// on it. App-scoped because `onOpenURL` can fire before the shell's
    /// subscription exists — a cold launch straight from a link, and on this
    /// platform also a link arriving while the unique window is closed — and
    /// `@Published` replays its current value to a late subscriber.
    @StateObject private var deepLinks = AppDeepLinkRouter()
    /// What that link then does. App-scoped for the sharper reason: a link that
    /// arrives mid-transfer is RETAINED and applied when the transfer stops, so
    /// the object holding it has to outlive both the window's view tree and, on
    /// this platform, the window itself — and it watches the models directly
    /// rather than through a view.
    @StateObject private var deepLinkRouting: AppDeepLinkCoordinator
    /// Files the OS opened with this app — Finder's Open With, a drop on the
    /// Dock icon. App-scoped for a reason the link router only half has: those
    /// files can arrive *as the launch*, before any scene exists, and they must
    /// still be staged once one does.
    @StateObject private var fileOpens = AppFileOpenRouter()
    /// Where those files go. App-scoped because the batch is retained until the
    /// pane it is addressed to is free to take it, and that pane may be
    /// mid-transfer — or its window closed — for the whole wait.
    @StateObject private var fileOpenRouting: AppFileOpenCoordinator
    // App-scoped rather than view-scoped: a transfer must survive the window's
    // view tree being rebuilt, and the quit guard has to be able to ask whether
    // one is running.
    @StateObject private var uploadModel: CloudUploadModel
    @StateObject private var downloadModel: CloudDownloadModel
    // Devices and stored files. App-scoped like the transfer models: a revoke or
    // a delete must survive the window's view tree being rebuilt, and it shares
    // the upload model's key store, so a link saved by an upload is the same one
    // this can rebuild.
    @StateObject private var accountManagement: AccountManagementModel
    // Leaving the account, from either direction, and the one object on this
    // list whose absence is a security defect rather than a lost transfer.
    // Revoking the current device kills this app's own bearer server-side, and
    // the response can arrive after the account destination has been replaced —
    // or after the window has been closed, which on this app does not end the
    // process. So the observer is app-scoped and subscribes in `init`, below.
    @StateObject private var signOut: AccountSignOutCoordinator
    // One preference object shared by both realtime models and the UI that
    // toggles it, so a change applies to the next session of either kind
    // without a relaunch.
    @StateObject private var verification: VerificationPreference
    // One discovery model for the whole app: it owns a single room socket, and
    // both realtime models build their nearby connections on that same socket.
    @StateObject private var lanDiscovery: LanDiscoveryModel
    @StateObject private var realtimeModel: RealtimeSessionModel
    @StateObject private var realtimeTextModel: RealtimeTextSessionModel
    // Background receive and the notifications it needs are app-scoped for the
    // same reason the transfer models are: both have to outlive the window.
    @StateObject private var nearbyReceive: NearbyReceiveModel
    // The unified `link/1`. App-scoped for the same reason the transport models
    // are: it follows the resident room socket, so an open link has to survive
    // the unique window being closed and rebuilt.
    @StateObject private var linkWorkspace: LinkWorkspaceModel
    @StateObject private var notifications: TransferNotificationCenter
    // Which destination is on screen. App-scoped rather than `@State` so the
    // selection survives the window's view tree being torn down and rebuilt: the
    // window is closable while the process keeps running, and reopening it from
    // the menu bar has to land where the user — or a deep link, or an incoming
    // session — last was. Built in `init` rather than defaulted inline because
    // the deep-link coordinator is constructed from this exact instance.
    @StateObject private var navigation: AppNavigationModel
    // Which destination presents the live session. App-scoped for the same
    // reason the models are: Nearby and Pairing code drive the SAME realtime
    // models, and the answer to "which of them is showing it" has to survive the
    // window's view tree being torn down and rebuilt. It is not — and cannot be
    // — a defence against a second window; the scene being a unique `Window` is
    // what makes that impossible.
    @StateObject private var presence: TransferPresence
    /// Whether this Mac starts Relayium at login. App-scoped because it is the
    /// settings scene's, and that scene is opened and closed independently of
    /// the main window — a view-scoped object would re-read the system on every
    /// open and lose a refusal the user has not yet read.
    @StateObject private var loginItem = LoginItemPreference(service: SystemLoginItem())
    /// The resident Device Inbox.
    ///
    /// App-scoped for the sharpest version of the reason every object above it
    /// is: this one runs with NO window at all. It claims, decrypts and commits
    /// deliveries while the user is in another app, and its own settings pane —
    /// which is where its state is rendered — may never be opened during the
    /// session in which a file arrives. A window-scoped or scene-scoped
    /// scheduler would stop the moment the window closed, which is precisely the
    /// case the whole capability exists for.
    @StateObject private var inbox: InboxController
    /// Who the inbox is receiving for. Subscribed in `init` and never from a
    /// view, because a sign-out, an account switch or a session going
    /// `unavailable` must cancel the loop even while no window exists — the same
    /// reasoning, and the same shape, as `AccountSignOutCoordinator`.
    private let inboxSession: InboxSessionBridge
    /// Drafts the Share extension left in the App Group.
    ///
    /// Not a `@StateObject`: it publishes nothing and holds no state a view
    /// renders — it is asked a question on activation and answers with files.
    /// App-scoped all the same, because the answer must be given once per
    /// activation and not once per view that happens to be mounted.
    ///
    /// `makeSharedDraftStore()` is nil on an un-provisioned build, and the inbox
    /// takes that in its stride: nothing can arrive, so nothing does, and the
    /// rest of the app is unaffected.
    private let sharedDrafts = SharedDraftInbox(store: AppEnvironment.makeSharedDraftStore())

    /// The strings live in a Swift-package resource bundle, while SwiftUI asks
    /// the app bundle which way to lay out the scene. macOS therefore kept an
    /// Arabic package catalog in a left-to-right app even though
    /// `CFBundleLocalizations` named Arabic. Resolve the same language the copy
    /// layer uses and make that answer explicit at both scene roots.
    private var appLayoutDirection: LayoutDirection {
        L10n.current.isRightToLeft ? .rightToLeft : .leftToRight
    }

    @MainActor
    init() {
        // The models need the preference and the discovery model at
        // construction (they read both through closures), and a @StateObject
        // default value cannot reference another property — so all of them are
        // built here against one shared instance of each.
        let prefs = VerificationPreference()
        let nearby = AppEnvironment.makeLanDiscoveryModel()
        // Holds the exact socket an inbound attempt is being built on, so the
        // two models' inbound builders cannot reach for a room the offer never
        // came from. Owned by the receive model; the session models only read it.
        let inboundRoom = InboundRoom()
        // The pairing code's ONE socket. `LinkWorkspaceModel` opens it, watches
        // it for a `link/1` peer, and — when the peer speaks the older wire —
        // leaves it here for the legacy connection to be built on rather than
        // closing it and making the peer's already-sent offer land on nobody.
        let pairingRoom = LinkRoomHandle()
        #if DEBUG
        let files = UITestMode.makeTerminalNearbyFileModel(verification: prefs)
            ?? UITestMode.makeWaitingFileModel(verification: prefs)
            ?? AppEnvironment.makeRealtimeModel(
                verification: prefs, nearby: nearby, inboundRoom: inboundRoom,
                pairingRoom: pairingRoom)
        let text = UITestMode.isActive
            ? UITestMode.makeRealtimeTextModel(verification: prefs)
            : AppEnvironment.makeRealtimeTextModel(
                verification: prefs, nearby: nearby, inboundRoom: inboundRoom,
                pairingRoom: pairingRoom)
        #else
        let files = AppEnvironment.makeRealtimeModel(
            verification: prefs, nearby: nearby, inboundRoom: inboundRoom,
            pairingRoom: pairingRoom)
        let text = AppEnvironment.makeRealtimeTextModel(
            verification: prefs, nearby: nearby, inboundRoom: inboundRoom,
            pairingRoom: pairingRoom)
        #endif
        let receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: files, textModel: text, discovery: nearby, inboundRoom: inboundRoom)
        // Registered on the SAME discovery model, after background receive, so
        // the shipped interceptor keeps its position in the socket's routing
        // order. Built here rather than in a view because an open link outlives
        // the window.
        #if DEBUG
        let unified = UITestMode.isActive
            ? UITestMode.makeLinkWorkspaceModel(
                verification: prefs, nearby: nearby, pairingRoom: pairingRoom)
            : AppEnvironment.makeLinkWorkspaceModel(
                verification: prefs, nearby: nearby, pairingRoom: pairingRoom)
        #else
        let unified = AppEnvironment.makeLinkWorkspaceModel(
            verification: prefs, nearby: nearby, pairingRoom: pairingRoom)
        #endif
        // The one place a watched code becomes an ordinary legacy session. The
        // socket is already open and already the room's; this only chooses which
        // model runs on it, from the verb the user pressed.
        // Installed below, once `presenting` exists: the fallback has to move
        // the surface's mode as well as start the session, and that object is
        // built a few lines further down.
        let adoptLegacy: (String, Role, ICEConfig, TransferMode,
                          TransferPresence) -> Void = { peerID, role, config, mode, presence in
            // The mode the user pressed decides which legacy model runs, and the
            // surface has to follow it: the pane renders one lane at a time.
            presence.claim(AppDestination.pairingCode, mode: mode)
            switch mode {
            case .files:
                Task { await files.adoptRoom(peerId: peerID, role: role, config: config) }
            case .text:
                Task { await text.adoptRoom(peerId: peerID, role: role, config: config) }
            }
        }
        // A batch armed while the room was still being watched. The legacy file
        // model stages its own, so it is handed over rather than enqueued twice.
        unified.onLegacyFallbackBatch = { metas, sources in
            guard !metas.isEmpty else { return }
            files.stageSend(sources: sources, metas: metas)
        }
        // One key store for the whole app: the upload model writes a key here,
        // the account model reads it back and removes it with the object. Two
        // instances would still work — they address the same keychain items —
        // but building it once keeps the shared dependency visible rather than
        // implied by two constructors happening to agree.
        let storedKeys = UITestMode.makeStoredLinkKeyStore()
            ?? AppEnvironment.makeStoredLinkKeyStore()
        let uploads = AppEnvironment.makeUploadModel(
            keyStore: storedKeys, transport: UITestMode.makeAccountTransport())
        let downloads = AppEnvironment.makeDownloadModel(
            transport: UITestMode.makeAccountTransport())
        let management = AppEnvironment.makeAccountManagementModel(
            keyStore: storedKeys, transport: UITestMode.makeAccountTransport())
        _verification = StateObject(wrappedValue: prefs)
        _lanDiscovery = StateObject(wrappedValue: nearby)
        _realtimeModel = StateObject(wrappedValue: files)
        _realtimeTextModel = StateObject(wrappedValue: text)
        _nearbyReceive = StateObject(wrappedValue: receive)
        _linkWorkspace = StateObject(wrappedValue: unified)
        _uploadModel = StateObject(wrappedValue: uploads)
        _downloadModel = StateObject(wrappedValue: downloads)
        _accountManagement = StateObject(wrappedValue: management)
        let account = AppEnvironment.makeSession(tokenStore: UITestMode.makeTokenStore(),
                                                 transport: UITestMode.makeAccountTransport())
        _session = StateObject(wrappedValue: account)
        // Subscribed HERE, in init, and not from a `.task` on any view or scene.
        // That is the whole point: the signal is raised by a network response
        // that can land after the account destination has been replaced by
        // another one, or after the unique window has been closed —
        // `applicationShouldTerminateAfterLastWindowClosed` is false and the
        // MenuBarExtra keeps the process up, so "no window" is an ordinary
        // running state here, not a shutdown. An observer with a view's or a
        // window's lifetime is an observer that is absent for exactly the
        // interval this defect occupies.
        //
        // The session goes in as a closure rather than as an object so the
        // coordinator's tests can hold a logout open and inspect the app while
        // the revocation is in flight.
        let leaving = AccountSignOutCoordinator(management: management,
                                                logOut: { await account.logOut() })
        leaving.observe(management.$needsSignOut)
        _signOut = StateObject(wrappedValue: leaving)
        _notifications = StateObject(wrappedValue: TransferNotificationCenter(
            uploadModel: uploads,
            downloadModel: downloads,
            fileModel: files,
            textModel: text,
            receiveModel: receive))
        let presenting = TransferPresence()
        // The link is the THIRD liveness source. Without it, a link session
        // would be released the instant it started: it uses neither legacy
        // model, so both of them read idle for its whole life.
        presenting.observeSessions(fileModel: files, textModel: text, link: unified)
        _presence = StateObject(wrappedValue: presenting)
        let routing = AppNavigationModel()
        _navigation = StateObject(wrappedValue: routing)
        // Admission happens before NearbyReceive builds or publishes an
        // inbound responder. The models alone are still idle during the short
        // interval after an outbound action has claimed its surface, so waiting
        // for AppShell's activeKind task would reject navigation only after the
        // inbound attempt had already reached the shared model.
        receive.shouldAcceptSession = { kind, peerID in
            AppRouting.claimIncoming(kind,
                                     peerLabel: nearby.label(forPeerID: peerID),
                                     presence: presenting, navigation: routing)
        }
        // The authoritative gate for an UNSOLICITED link, on the main actor.
        // Same arbitration as the legacy one above, through the same
        // `TransferPresence`, which is what makes "a link session and a legacy
        // session cannot coexist" true rather than merely intended. Navigation
        // follows, so a link that arrives while the user is on another
        // destination is not invisible.
        unified.shouldAcceptLink = { peerID in
            guard presenting.beginSession(.nearby,
                                          peerLabel: nearby.label(forPeerID: peerID))
            else { return false }
            routing.select(.nearby)
            return true
        }
        // The advisory mirror the socket's delivery queue reads. Written from
        // the one authoritative fact — whether anything owns the surface — so it
        // cannot drift from the gate above by more than the hop it is
        // documented to lag by.
        unified.adoptLegacyRoom = { [weak presenting] peerID, role, config, mode in
            guard let presenting else { return }
            adoptLegacy(peerID, role, config, mode, presenting)
        }
        unified.observeAvailability(
            presenting.$owner.map { $0 == nil }.eraseToAnyPublisher())
        // The same ownership fact closes a room that was handed to the legacy
        // path: nothing owns the surface means that session is over, and the
        // code's socket has nobody left to serve.
        unified.observeSurfaceIdle(
            presenting.$owner.map { $0 == nil }.eraseToAnyPublisher())
        #if DEBUG
        if UITestMode.showsTerminalNearby {
            presenting.claim(.nearby, mode: .files,
                             peerLabel: "Studio Mac · 19af02") // nonlocalized: deterministic UI-test fixture
            routing.select(.nearby)
            Task { await files.connectNearby(peerId: "ui-nearby-peer", role: .initiator) }
        }
        #endif
        // Last, because it is built from four objects above and owns none of
        // them. It navigates exactly once per link, and it is the ONE place that
        // decides whether a link may write into a model that is mid-transfer —
        // which is why no view on this platform repeats that decision.
        _deepLinkRouting = StateObject(wrappedValue: AppDeepLinkCoordinator(
            navigation: routing, download: downloads,
            realtime: files, realtimeText: text, presence: presenting,
            selectRealtimeMode: { mode in presenting.selectMode(mode) }))
        // Built from the SAME navigation model, so an opened file and a tapped
        // link cannot disagree about where the user is. It takes nothing else:
        // staging a selection touches no transfer model, which is why this one
        // needs no busy rule of its own.
        _fileOpenRouting = StateObject(wrappedValue: AppFileOpenCoordinator(navigation: routing))

        // The Device Inbox, and the ONE place it is assembled. Everything it
        // touches — the keychain key history, the folder bookmark and policy,
        // the journal directory, the transport — comes from a single factory, so
        // an acceptance launch substitutes one thing rather than four and cannot
        // half-isolate itself onto the installed product's stores.
        // The production half moved into a factory when the notifier and the
        // controller began referring to each other. It stays on the right of `??`
        // — an autoclosure — so a UI-test launch never evaluates it, never builds
        // an `InboxNotifier` and never touches `UNUserNotificationCenter`, which
        // is the outward reach `UITestMode` documents itself as skipping. Written
        // inline, the notifier would have been constructed in every launch
        // regardless of which controller won.
        let receiving = UITestMode.makeInboxController() ?? Self.makeProductionInbox()
        _inbox = StateObject(wrappedValue: receiving)
        // Subscribed HERE, in init, for the reason recorded on the property and
        // on `InboxSessionBridge`: the state change that must stop the loop can
        // land while no window exists.
        let bridge = InboxSessionBridge(controller: receiving)
        bridge.observe(account.$state, bearer: { account.bearerToken })
        inboxSession = bridge
    }

    /// The shipped Device Inbox: the real stores, the real transport, and the
    /// three platform seams the controller is deliberately unable to reach on its
    /// own.
    ///
    /// The notifier and the controller each need the other — the notifier
    /// measures notification authorization, the controller is what renders it —
    /// so the callback is attached after both exist. `weak` in both directions:
    /// the scene owns the controller for the life of the process, and a retain
    /// cycle here would be one that never breaks.
    @MainActor
    private static func makeProductionInbox() -> InboxController {
        let notifier = InboxNotifier()
        let receiving = AppEnvironment.makeInboxController(
            notifier: notifier,
            // The only path in the product that hands a received path to the
            // OS, and the controller refuses anything that is not in its own
            // completed-result list before it gets here.
            reveal: { urls in
                Task { @MainActor in
                    NSWorkspace.shared.activateFileViewerSelecting(urls)
                }
            },
            refreshNotificationPermission: { [weak notifier] in
                Task { @MainActor in notifier?.refreshPermission() }
            },
            // **The only site that opens System Settings, and the URL is built
            // here from nothing but this app's own identity.**
            //
            // The seam takes no parameter, so nothing from a delivery can reach
            // this call — which is what keeps the ban `InboxSurfaceGuardTests`
            // places on launching received content intact by construction rather
            // than merely unbroken by accident. The route refuses anything that
            // is not bundle-identifier shaped, so that stays true even if a later
            // call site passes something.
            //
            // The route is built in the package, from THIS bundle's own
            // identifier, because the pane identifier alone does not select an
            // app: it re-opens Notifications on whichever row it was last left
            // on, so the bare link would claim to open Relayium's settings and
            // hand the user Google Chrome's. `InboxNotificationSettingsRoute`
            // carries that reasoning and is what the execution tests drive.
            //
            // A build that cannot name itself yields no URL and the seam reports
            // false, which the pane renders as the "open it yourself" sentence —
            // truthful, and better than landing someone on a stranger's row.
            // `NSWorkspace` reporting false is passed back the same way, so the
            // pane can say so instead of leaving a button that does nothing.
            openNotificationSettings: {
                guard let url = InboxNotificationSettingsRoute
                    .url(forBundleIdentifier: Bundle.main.bundleIdentifier)
                else { return false }
                return NSWorkspace.shared.open(url)
            },
            appVersion: Self.appVersion)
        notifier.onPermission = { [weak receiving] permission in
            Task { @MainActor in receiving?.updateNotificationPermission(permission) }
        }
        return receiving
    }

    /// What this build reports when it enrols. Read from the bundle rather than
    /// hard-coded, so a version bump cannot leave the device list claiming the
    /// previous release.
    // nonlocalized: an em dash placeholder for a missing bundle value
    private static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    }

    var body: some Scene {
        // A UNIQUE `Window`, never a `WindowGroup`. Identified so the menu bar
        // can reopen it: closing the last window does not quit the app (the
        // MenuBarExtra and `applicationShouldTerminateAfterLastWindowClosed`
        // keep it running), so without an id there is no way back to the UI
        // short of quitting and relaunching.
        //
        // Uniqueness is what makes "one live session, one Cancel button" true.
        // `openWindow(id:)` against a `Window` orders the existing window
        // forward; against a `WindowGroup` it creates another one, and two
        // windows render the same app-scoped models twice — two Cancel buttons
        // for one transfer, however app-scoped the state is. A `Window` scene
        // also contributes no File ▸ New Window item and no ⌘N.
        Window("Relayium", id: "main") {
            AppShellView()
                .environment(\.layoutDirection, appLayoutDirection)
                .environmentObject(navigation)
                .environmentObject(presence)
                .environmentObject(session)
                .environmentObject(deepLinks)
                .environmentObject(deepLinkRouting)
                .environmentObject(fileOpens)
                .environmentObject(fileOpenRouting)
                .environmentObject(uploadModel)
                .environmentObject(downloadModel)
                .environmentObject(accountManagement)
                .environmentObject(signOut)
                .environmentObject(realtimeModel)
                .environmentObject(realtimeTextModel)
                .environmentObject(verification)
                .environmentObject(lanDiscovery)
                .environmentObject(nearbyReceive)
                .environmentObject(linkWorkspace)
                // The receiver and the login-item preference reach the main
                // window because the Device Inbox is a destination in it now,
                // not only a settings tab. It is the SAME app-scoped controller
                // the settings scene and the menu bar render — a second one
                // would be a second scheduler claiming against one account, and
                // `InboxSurfaceGuardTests` counts these injections for exactly
                // that reason.
                .environmentObject(inbox)
                .environmentObject(loginItem)
                .task { await session.restore() }
                // Files the Share extension staged while this app was closed or
                // in the background.
                //
                // A Share extension may not open its containing app, so nothing
                // pushes them here — the user opens Relayium and they are
                // waiting. `scenePhase` rather than a one-shot `.task`, because
                // the ordinary case is sharing from Finder while Relayium is
                // already running, and that never re-runs a `.task`.
                //
                // They are handed to the SAME router an Open With uses, so a
                // shared draft and an opened file take one path into the send
                // flow instead of two that can disagree.
                .onChange(of: scenePhase) { phase in
                    guard phase == .active else { return }
                    fileOpens.open(sharedDrafts.collect())
                }
                .task {
                    // Also on first appearance: `scenePhase` does not deliver a
                    // change for the state the scene starts in, so a draft
                    // staged before a cold launch would otherwise wait for the
                    // user to switch away and back.
                    fileOpens.open(sharedDrafts.collect())
                }
                .task {
                    // Both idempotent, and both app-scoped rather than
                    // window-scoped: residency is what makes this Mac reachable,
                    // and it outlives every window (MenuBarExtra keeps the
                    // process up). A second window must not reopen the room
                    // socket, and must never override an explicit pause.
                    guard !UITestMode.isActive else { return }
                    notifications.start()
                    lanDiscovery.startResident()
                }
                .task {
                    // Wired here rather than at init: the delegate is created by
                    // the adaptor before the StateObjects exist.
                    quitGuard.isTransferRunning = {
                        uploadModel.isBusy || downloadModel.isBusy
                            || realtimeModel.isBusy || realtimeTextModel.isBusy
                    }
                    quitGuard.hasLocalText = {
                        realtimeTextModel.hasLocalContent
                    }
                    quitGuard.cancelTransfers = {
                        uploadModel.cancel()
                        downloadModel.cancel()
                        realtimeModel.cancel()
                        realtimeTextModel.end()
                        // Every session at once, from a path with no
                        // destination to ask — the one case `releaseAll` exists
                        // for. Nothing is left owning a transfer that no longer
                        // runs.
                        presence.releaseAll()
                    }
                    // The fallback path, for the day AppKit stops emptying
                    // `application(_:open:)`. Wired here for the same reason as
                    // the two above: the adaptor builds the delegate before the
                    // StateObjects exist.
                    quitGuard.didOpenFiles = { fileOpens.open($0) }
                }
                // BOTH kinds of hand-off arrive here — a Universal Link and, as
                // this tree measured, every file the OS opens with this app.
                // SwiftUI republishes an AppKit open through this modifier and
                // then calls the delegate with an emptied array, so this is the
                // only place a `file://` URL actually exists.
                //
                // The two are disjoint by construction: `parseAppDeepLink`
                // requires `https` and `relayium.com`, and `droppedFileURL`
                // requires `isFileURL`. Trying the link first is therefore not a
                // precedence rule to reason about — it is two total predicates
                // over one value, and a URL that satisfies neither (a `mailto:`,
                // an https link to somewhere else) is refused by both and does
                // nothing, which is the intended answer.
                //
                // Before this split, an opened file reached `deepLinks.open`,
                // failed to parse, and was discarded in silence.
                .onOpenURL { url in
                    guard !deepLinks.open(url) else { return }
                    fileOpens.open([url])
                }
        }
        .defaultSize(width: 1040, height: 700)
        .commands {
            CommandGroup(after: .appInfo) {
                CheckForUpdatesView(updater: updaterController.updater)
            }
        }

        // ⌘, — and the reason the app menu gains a Settings item at all. A
        // `Settings` scene is the only way to get the standard placement and
        // shortcut; a window opened from a custom menu item would be neither.
        //
        // It carries the resolved layout direction like the other two scene
        // roots, for the reason recorded on `appLayoutDirection`: the catalogs
        // live in a package bundle, so SwiftUI does not mirror an Arabic UI on
        // its own.
        Settings {
            SettingsView(updater: updaterController.updater)
                .environment(\.layoutDirection, appLayoutDirection)
                .environmentObject(loginItem)
                .environmentObject(verification)
                .environmentObject(inbox)
                // Both new here, and both for the shared Device Inbox surface:
                // it reads the session to say WHY there is no account rather than
                // only that there is none, and it writes the navigation model to
                // send a signed-out user to the form — in the main window, which
                // this scene may be the only thing open.
                .environmentObject(session)
                .environmentObject(navigation)
        }

        // Residency. This is the surface the persistent room socket reports
        // through: with the window closed it is the only place the user can see
        // whether this Mac is actually able to receive, and the only way back to
        // the app.
        MenuBarExtra("Relayium", systemImage: "paperplane") {
            MenuBarView()
                .environment(\.layoutDirection, appLayoutDirection)
                .environmentObject(session)
                .environmentObject(nearbyReceive)
                .environmentObject(lanDiscovery)
                .environmentObject(inbox)
                // The Device Inbox item opens the main window on its
                // destination, so the menu bar has to be able to select one. It
                // renders none of them.
                .environmentObject(navigation)
        }
    }
}
