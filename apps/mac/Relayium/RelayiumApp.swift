import SwiftUI
import RelayiumAppKit
// For the two protocol values the pairing-code fallback carries — the room's
// deterministic `Role` and the `ICEConfig` its code was issued — which reach
// this scene as themselves rather than as anything it re-derives.
import RelayiumKit

// **This file is shared source, compiled into BOTH macOS products**, and it does
// not import Sparkle. The update mechanism is the one thing the two builds
// cannot agree on — the direct download updates itself, the App Store build is
// updated by the App Store, and shipping Sparkle in the latter is grounds for
// rejection — so it reaches this scene through the distribution seam
// (`AppUpdates`, `AppUpdatesMenuItem`), whose two implementations are each a
// member of exactly one target. See `Distribution/DirectDistribution.swift`.

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
    /// Whatever this build's update mechanism is. Sparkle's updater in the
    /// direct download; an object that owns nothing in the App Store build.
    private let updates = AppUpdates()
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
    /// **Whether this build is still one the product answers for.**
    ///
    /// App-scoped, and evaluated in `init` from the cached policy rather than
    /// from a request, so the very first frame is already correct: a model that
    /// started supported and turned blocking when a response came back would show
    /// a below-minimum build its whole product surface for the length of a
    /// network round trip — which is exactly the interval that matters.
    ///
    /// It reaches the network once per launch and can only ever be made stricter
    /// by what it finds there. Every failure — offline, a 500, a body that is not
    /// this schema, a document that would take the requirement below the floor
    /// compiled into this binary — leaves the state exactly as it was.
    @StateObject private var versionSupport: SupportedVersionModel
    // One preference object shared by both realtime models and the UI that
    // toggles it, so a change applies to the next session of either kind
    // without a relaunch.
    @StateObject private var verification: VerificationPreference
    // One discovery model for the whole app: it owns a single room socket, and
    // the NEARBY module's realtime models build their connections on that same
    // socket. The Direct module never touches it.
    @StateObject private var lanDiscovery: LanDiscoveryModel
    /// **The two independent transfer modules**, and the reason there are two.
    ///
    /// LAN Transfer and Cross-network Transfer used to be two screens over one
    /// set of models — one `RealtimeSessionModel`, one text model, one
    /// `LinkWorkspaceModel`, one `TransferPresence`. That made a session on
    /// either screen lock the other one entirely, made one `link/1` owner route
    /// two different rooms (so the LAN roster's churn cancelled pairing requests
    /// in flight), and made "cancel this screen" impossible to express. Each
    /// module now owns its own everything; see `TransferModule`.
    ///
    /// App-scoped, like every model it replaces, and that is what makes the
    /// owner's requirement true: navigating between the two destinations does
    /// not touch either module, so a live connection on one survives a visit to
    /// the other and is still connected on return.
    @StateObject private var transferModules: TransferModules
    // Background receive and the notifications it needs are app-scoped for the
    // same reason the transfer models are: both have to outlive the window.
    @StateObject private var nearbyReceive: NearbyReceiveModel
    // **There is no app-scoped transfer selection any more.**
    //
    // It held the one batch both real-time destinations staged before
    // connecting. They do not: Nearby and Pairing establish the session first
    // and the work is chosen inside it, so nothing writes such a store and
    // nothing reads one. Deleting it rather than leaving it injected is what
    // makes that structural — a later edit cannot reach for a shared staging
    // context that is not in the environment. `TransferStagingSection` survives
    // in source, dormant and constructed by nobody, for a future re-enable.
    @StateObject private var notifications: TransferNotificationCenter
    // Which destination is on screen. App-scoped rather than `@State` so the
    // selection survives the window's view tree being torn down and rebuilt: the
    // window is closable while the process keeps running, and reopening it from
    // the menu bar has to land where the user — or a deep link, or an incoming
    // session — last was. Built in `init` rather than defaulted inline because
    // the deep-link coordinator is constructed from this exact instance.
    @StateObject private var navigation: AppNavigationModel
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
    /// The Device Inbox's SEND half: this account's own devices as delivery
    /// targets.
    ///
    /// App-scoped for the sharpest version of the reason the receiver is. A
    /// device send outlives the screen that started it in three separate ways:
    /// SwiftUI tears an off-screen destination down mid-upload, a durable plan
    /// survives the process itself, and an account leaving has to cancel work no
    /// view is watching. Its session observation is installed in `init` for the
    /// last of those — a sign-out can land while the window is closed, which on
    /// this app is an ordinary running state.
    @StateObject private var inboxSend: InboxSendModel
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
    /// The app's one in-app purchase model, or `nil` in a build that does not
    /// sell — which is what the direct download's seam returns.
    ///
    /// **App-scoped, and not a `@StateObject`, for the same reason the drafts
    /// inbox above is neither: it is created once and never replaced.** What
    /// makes it app-scoped rather than owned by the account screen is the store's
    /// update stream. A renewal, a refund, an Ask-to-Buy approval and a purchase
    /// interrupted by a crash all arrive through it, at moments when no window
    /// need exist — this app's window is closable without ending the process —
    /// and each one has to reach the server and refresh the session.
    ///
    /// Assigned in `init` because both closures need the session, which is built
    /// there. It holds no bearer and no user of its own: it reads the credential
    /// at the moment of use and asks the session, not itself, what the account
    /// now holds.
    private let appleSubscription: AppleSubscriptionModel?

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
        // NEARBY model's inbound builder cannot reach for a room the offer never
        // came from. Owned by the receive model; the session models only read it.
        let inboundRoom = InboundRoom()
        // The pairing code's ONE socket, and the DIRECT module's alone. The
        // direct `LinkWorkspaceModel` opens it, watches it for a `link/1` peer,
        // and — when the peer speaks the older wire — leaves it here for that
        // module's legacy connection to be built on rather than closing it and
        // making the peer's already-sent offer land on nobody.
        let pairingRoom = LinkRoomHandle()

        // ── the Nearby module ────────────────────────────────────────────────
        //
        // Same-network only, in every direction. Its models are built with no
        // code path at all, so this module cannot mint, join or watch a pairing
        // code even if a later edit asked it to.
        #if DEBUG
        let nearbyFiles = UITestMode.makeTerminalNearbyFileModel(verification: prefs)
            ?? AppEnvironment.makeNearbyRealtimeModel(
                verification: prefs, nearby: nearby, inboundRoom: inboundRoom)
        // `usesOfflineTransfer`, never `isActive`. A LOOPBACK acceptance launch
        // is pointed at a real server on this machine and has to exercise the
        // real transfer graph; substituting here made every built-App run
        // evidence about the fixtures instead. See `UITestMode.usesOfflineTransfer`.
        let nearbyText = UITestMode.usesOfflineTransfer
            ? UITestMode.makeRealtimeTextModel(verification: prefs)
            : AppEnvironment.makeNearbyRealtimeTextModel(
                verification: prefs, nearby: nearby, inboundRoom: inboundRoom)
        #else
        let nearbyFiles = AppEnvironment.makeNearbyRealtimeModel(
            verification: prefs, nearby: nearby, inboundRoom: inboundRoom)
        let nearbyText = AppEnvironment.makeNearbyRealtimeTextModel(
            verification: prefs, nearby: nearby, inboundRoom: inboundRoom)
        #endif
        let receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: nearbyFiles, textModel: nearbyText,
            discovery: nearby, inboundRoom: inboundRoom)
        // Registered on the SAME discovery model, after background receive, so
        // the shipped interceptor keeps its position in the socket's routing
        // order. Built here rather than in a view because an open link outlives
        // the window.
        #if DEBUG
        let nearbyLink = UITestMode.usesOfflineTransfer
            ? UITestMode.makeNearbyLinkWorkspaceModel(verification: prefs, nearby: nearby)
            : AppEnvironment.makeNearbyLinkWorkspaceModel(verification: prefs, nearby: nearby)
        #else
        let nearbyLink = AppEnvironment.makeNearbyLinkWorkspaceModel(
            verification: prefs, nearby: nearby)
        #endif

        // ── the Direct module ────────────────────────────────────────────────
        //
        // A pairing code and the room it names, and no roster anywhere. It is
        // NOT a room observer of the discovery model, which is what stops the
        // same-network roster's churn from cancelling a pairing request in
        // flight — see `AppEnvironment.makeDirectLinkWorkspaceModel`.
        #if DEBUG
        let directFiles = UITestMode.makeWaitingFileModel(verification: prefs)
            ?? AppEnvironment.makeDirectRealtimeModel(
                verification: prefs, pairingRoom: pairingRoom)
        let directText = UITestMode.usesOfflineTransfer
            ? UITestMode.makeRealtimeTextModel(verification: prefs)
            : AppEnvironment.makeDirectRealtimeTextModel(
                verification: prefs, pairingRoom: pairingRoom)
        // **The one substitution that made a real Direct session impossible.**
        // The offline fixture's `connectPairingSocket` is a
        // `preconditionFailure` and its ICE client sleeps for five minutes, and
        // `watchPairingCode` reads ICE first — so an acceptance launch given
        // this model joins a code, publishes `.watching`, and never opens the
        // room's socket at all. Both native ends then wait for each other
        // forever, which is precisely the "neither side promotes" measurement
        // that was written up as a pairing-wire defect.
        let directLink = UITestMode.usesOfflineTransfer
            ? UITestMode.makeDirectLinkWorkspaceModel(
                verification: prefs, pairingRoom: pairingRoom)
            : AppEnvironment.makeDirectLinkWorkspaceModel(
                verification: prefs, pairingRoom: pairingRoom)
        #else
        let directFiles = AppEnvironment.makeDirectRealtimeModel(
            verification: prefs, pairingRoom: pairingRoom)
        let directText = AppEnvironment.makeDirectRealtimeTextModel(
            verification: prefs, pairingRoom: pairingRoom)
        let directLink = AppEnvironment.makeDirectLinkWorkspaceModel(
            verification: prefs, pairingRoom: pairingRoom)
        #endif

        // Each module wires its own liveness, availability and surface-idle
        // observation from its OWN presence — see `TransferModule.init`. Two
        // presences is the whole point: neither module can be locked, released
        // or refused by the other one's session.
        let nearbyModule = TransferModule(route: .nearby, files: nearbyFiles,
                                          text: nearbyText, link: nearbyLink)
        let directModule = TransferModule(route: .pairingCode, files: directFiles,
                                          text: directText, link: directLink)
        let modules = TransferModules(nearby: nearbyModule, direct: directModule)
        _transferModules = StateObject(wrappedValue: modules)

        // The one place a watched code becomes an ordinary legacy session. The
        // socket is already open and already the room's; this only chooses which
        // model runs on it from the staged batch and peer capabilities.
        //
        // It reaches the DIRECT module and nothing else: a pairing room's
        // fallback is a pairing session, and the Nearby module has no code path
        // for one to land in.
        let adoptLegacy: (String, Role, ICEConfig, TransferMode) -> Void = {
            peerID, role, config, mode in
            // The lane the LINK MODEL decided on — from what was staged and what
            // the peer announced, never from a verb the user pressed — and the
            // surface has to follow it: the pane renders one lane at a time.
            directModule.presence.claim(.pairingCode, mode: mode)
            switch mode {
            case .files:
                Task { await directFiles.adoptRoom(peerId: peerID, role: role, config: config) }
            case .text:
                // **The minted code has to be retired, and only after the text
                // lane is live.**
                //
                // A code is always minted through the FILE model: that is the
                // lane whose `showingCode`, expiry and manifest the pairing
                // surface renders, and the only one that can hold a staged
                // batch. A room that resolves to a legacy TEXT peer therefore
                // leaves that model parked in `.showingCode` — never idle — so
                // this module's `sessionIsLiveOrRetained` would hold the Direct
                // destination locked for the rest of the launch and its surface
                // would never return to the connect phase. (It no longer locks
                // the Nearby screen as well; that is what modules changed.)
                //
                // The ORDER is the load-bearing half. `TransferPresence` gives
                // the surface up the moment every model and the link all read
                // idle, and that release closes the handed-over pairing socket
                // (`observeSurfaceIdle`) — the socket this connection is being
                // built on. Cancelling first would pass through exactly that
                // state. So the text lane publishes `.connecting` first, and the
                // file lane is cleared behind it.
                //
                // Safe on the batch: `legacyFallbackMode` answers `.files` for
                // anything staged, so a text room is one with nothing to send.
                Task {
                    await directText.adoptRoom(peerId: peerID, role: role, config: config)
                    directFiles.cancel()
                }
            }
        }
        // A batch armed while the room was still being watched. The legacy file
        // model stages its own, so it is handed over rather than enqueued twice.
        directLink.onLegacyFallbackBatch = { metas, sources in
            guard !metas.isEmpty else { return }
            directFiles.stageSend(sources: sources, metas: metas)
        }
        // Pairing codes are rendered by the legacy file model until a peer is
        // known. Once the room resolves to `link/1`, the link has already
        // published `.requesting`, so clearing that stale code cannot create an
        // all-idle ownership gap. Without this handoff the old code would
        // reappear after the unified link ended and keep the Direct route
        // locked.
        directLink.onPairingLinkActivated = { directFiles.cancel() }
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
        _nearbyReceive = StateObject(wrappedValue: receive)
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
        // The version policy. Its cache is the app's own defaults in a shipped
        // launch and an in-memory one under acceptance, for the same reason the
        // keychain and the staging root are isolated there: a UI-test launch must
        // not write a policy into the installed product's defaults, and must not
        // inherit one either. The source is the production document; the refresh
        // that would reach it is skipped for acceptance at the scene root, so the
        // suite runs against the embedded floor and nothing leaves the machine.
        //
        // The version this policy is evaluated against is the BUNDLE's, except
        // in an acceptance launch that names another one. `appVersionOverride`
        // is nil in Release — the whole seam is inside `#if DEBUG` — and nil in
        // any Debug launch that is not a UI test, so a shipped process reaches
        // `bundleVersion()` unconditionally. It exists because the blocking
        // state is the one this suite cannot otherwise reach: every candidate
        // that can be built and signed is, by the release guard's own rule,
        // above the published minimum.
        _versionSupport = StateObject(wrappedValue: SupportedVersionModel(
            currentVersion: UITestMode.appVersionOverride
                ?? SupportedVersionModel.bundleVersion(),
            store: UITestMode.isActive
                ? InMemorySupportedVersionPolicyStore()
                : UserDefaultsSupportedVersionPolicyStore(),
            source: HTTPSupportedVersionPolicySource()))
        // The purchase model, built from the session and from nothing else this
        // scene owns. Both closures read through to the session at the moment of
        // use rather than capturing its state, which is what keeps this object
        // from becoming a second thing to invalidate on sign-out.
        //
        // The UI-test seam comes first and is absent from Release, exactly like
        // the token store, the transport and the inbox controller above:
        // acceptance has to drive a purchase surface without a store and without
        // a server, and a shipped launch never evaluates it. In the direct
        // download both arms answer nil, so no purchase model exists at all.
        appleSubscription = UITestMode.makeSubscriptionModel(
            bearer: { account.bearerToken },
            refreshAccount: { await account.refresh() })
            ?? AppDistribution.makeSubscriptionModel(
                bearer: { account.bearerToken },
                refreshAccount: { await account.refresh() })
        _notifications = StateObject(wrappedValue: TransferNotificationCenter(
            uploadModel: uploads,
            downloadModel: downloads,
            modules: modules,
            receiveModel: receive))
        let routing = AppNavigationModel()
        _navigation = StateObject(wrappedValue: routing)
        // Admission happens before NearbyReceive builds or publishes an
        // inbound responder. The models alone are still idle during the short
        // interval after an outbound action has claimed its surface, so waiting
        // for AppShell's activeKind task would reject navigation only after the
        // inbound attempt had already reached the shared model.
        //
        // The NEARBY module's presence, and only that one. An inbound
        // same-network offer is refused when this module is already busy; a
        // pairing code being minted on the other screen is no longer a reason to
        // refuse it, which is the defect the modules split repairs — a peer
        // dialling this Mac used to be turned away because its owner was
        // creating a code somewhere else in the app.
        receive.shouldAcceptSession = { kind, peerID in
            AppRouting.claimIncoming(kind,
                                     peerLabel: nearby.label(forPeerID: peerID),
                                     presence: nearbyModule.presence, navigation: routing)
        }
        // The authoritative gate for an UNSOLICITED link, on the main actor.
        // Same arbitration as the legacy one above, through the same NEARBY
        // presence, which is what makes "a link session and a legacy session
        // cannot coexist *in this module*" true rather than merely intended.
        // Navigation follows, so a link that arrives while the user is on
        // another destination is not invisible.
        nearbyLink.shouldAcceptLink = { peerID in
            guard nearbyModule.presence.beginSession(
                .nearby, peerLabel: nearby.label(forPeerID: peerID))
            else { return false }
            routing.select(.nearby)
            return true
        }
        // The advisory mirror the pairing socket's delivery queue reads. Written
        // from the one authoritative fact — whether the DIRECT module owns its
        // surface — so it cannot drift from the gate above by more than the hop
        // it is documented to lag by.
        directLink.adoptLegacyRoom = { peerID, role, config, mode in
            adoptLegacy(peerID, role, config, mode)
        }
        #if DEBUG
        if UITestMode.showsTerminalNearby {
            nearbyModule.presence.claim(.nearby, mode: .files,
                                        peerLabel: "Studio Mac · 19af02") // nonlocalized: deterministic UI-test fixture
            routing.select(.nearby)
            Task { await nearbyFiles.connectNearby(peerId: "ui-nearby-peer", role: .initiator) }
        }
        #endif
        // Last, because it is built from four objects above and owns none of
        // them. It navigates exactly once per link, and it is the ONE place that
        // decides whether a link may write into a model that is mid-transfer —
        // which is why no view on this platform repeats that decision.
        //
        // **The DIRECT module's models, and only those.** `AppRouting` sends a
        // `realtime` link to `.pairingCode`, so the model it may write a code
        // into is that module's — and the busy rule it applies is that module's
        // too. Handed the Nearby module's, it would refuse to apply a pairing
        // link because a same-network transfer was running, which is precisely
        // the cross-module interference this split removes.
        _deepLinkRouting = StateObject(wrappedValue: AppDeepLinkCoordinator(
            navigation: routing, download: downloads,
            realtime: directFiles, realtimeText: directText,
            presence: directModule.presence,
            selectRealtimeMode: { mode in directModule.presence.selectMode(mode) }))
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

        // The SEND half of the Device Inbox, built from the same factory iOS
        // uses and observing the same session.
        //
        // **`drafts: nil`, and that is a refusal rather than an omission.** A
        // draft store is the authority to RETIRE a draft — to delete the only
        // copy of files another process handed this app — and macOS device sends
        // are chosen with this app's own file picker, so no delivery here can
        // ever have come from one. Passing the store would hand that authority
        // to a path that has no legitimate use for it.
        //
        // The observation is installed HERE, before any view exists, for the
        // reason `InboxSessionBridge` is: a sign-out or an account switch has to
        // cancel an account-owned delivery — and stop describing it — while the
        // unique window may be closed, which on this app is an ordinary running
        // state rather than a shutdown.
        let delivering = AppEnvironment.makeInboxSendModel(
            pending: AppEnvironment.makePendingUploadSupport(
                drafts: nil, root: UITestMode.pendingUploadRoot()),
            transport: UITestMode.makeAccountTransport())
        delivering.observe(account.$state)
        _inboxSend = StateObject(wrappedValue: delivering)
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
                .environmentObject(navigation)
                // BOTH modules, as one container. SwiftUI's environment is keyed
                // by type, so two `TransferModule`s could not both live in it —
                // and two wrapper types differing only by name would be a
                // distinction nothing enforces. The shell reads `modules.nearby`
                // and `modules.direct` by name and hands each destination
                // exactly one, which is what keeps a screen unable to reach the
                // other module's session at all.
                .environmentObject(transferModules)
                .environmentObject(session)
                .environmentObject(deepLinks)
                .environmentObject(deepLinkRouting)
                .environmentObject(fileOpens)
                .environmentObject(fileOpenRouting)
                .environmentObject(uploadModel)
                .environmentObject(downloadModel)
                .environmentObject(accountManagement)
                .environmentObject(signOut)
                .environmentObject(verification)
                .environmentObject(lanDiscovery)
                .environmentObject(nearbyReceive)
                // The receiver and the login-item preference reach the main
                // window because the Device Inbox is a destination in it now,
                // not only a settings tab. It is the SAME app-scoped controller
                // the settings scene and the menu bar render — a second one
                // would be a second scheduler claiming against one account, and
                // `InboxSurfaceGuardTests` counts these injections for exactly
                // that reason.
                .environmentObject(inbox)
                // The send half, into the one window that renders it. The menu
                // bar deliberately does not get it: nothing there sends, and a
                // second injection point is how a second reader starts.
                .environmentObject(inboxSend)
                .environmentObject(loginItem)
                // An environment VALUE, because the honest type is optional: the
                // direct build has no purchase model, and `@EnvironmentObject`
                // can only express that by crashing whoever asks.
                .environment(\.appleSubscription, appleSubscription)
                .task { await session.restore() }
                .task {
                    // The store's update stream, drained for as long as the
                    // process runs. Started here rather than by the account
                    // screen because a renewal, a refund or a purchase
                    // interrupted by a crash arrives whether or not anybody is
                    // looking — and this app keeps running with its window
                    // closed. Idempotent, and a no-op in a build with no model.
                    appleSubscription?.startObservingUpdates()
                }
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
                    // A link the UI suite launched this process with, handed to
                    // the SAME router `onOpenURL` feeds. It is the only way that
                    // suite can reach Open a link, which has no sidebar row —
                    // and routing it through the real entry point is the point:
                    // the parser, the coordinator and the shell arm are all
                    // production. `launchDeepLink` is nil in Release.
                    guard let link = UITestMode.launchDeepLink else { return }
                    _ = deepLinks.open(link)
                }
                .task {
                    // Both idempotent, and both app-scoped rather than
                    // window-scoped: residency is what makes this Mac reachable,
                    // and it outlives every window (MenuBarExtra keeps the
                    // process up). A second window must not reopen the room
                    // socket, and must never override an explicit pause.
                    // Notification registration reaches Apple's servers and
                    // nothing about a local acceptance run needs it, so it stays
                    // on the shipped-launch side of the gate unconditionally.
                    if !UITestMode.isActive { notifications.start() }
                    // Residency joins a room on the origin THIS launch resolved,
                    // and that is what decides whether skipping it is a privacy
                    // requirement or merely a habit. Against production the hub
                    // groups the room by the public address it observes, so a
                    // resident acceptance run puts a shared CI runner into
                    // strangers' device lists — which is why this has always
                    // been skipped. Against a loopback origin the room is a
                    // server on this machine, its roster can only hold this
                    // machine's own processes, and residency is the exact thing
                    // a peer-to-peer acceptance run needs to have running.
                    //
                    // `allowsResidency` is a stored `false` in Release, where
                    // `isActive` is a stored `false` too — so a shipped launch
                    // takes the unconditional path either way.
                    guard !UITestMode.isActive || UITestMode.allowsResidency else { return }
                    lanDiscovery.startResident()
                }
                .task {
                    // Wired here rather than at init: the delegate is created by
                    // the adaptor before the StateObjects exist.
                    // BOTH modules, on all three. Quit is the one action in the
                    // app that genuinely means every module: a guard that asked
                    // only one of them would let ⌘Q kill a live transfer on the
                    // other without ever mentioning it, and that is the exact
                    // silent loss this guard exists to prevent. It is also the
                    // ONLY path allowed to reach `TransferModules.cancelEverything`
                    // — a per-module Cancel must never come through here.
                    quitGuard.isTransferRunning = {
                        uploadModel.isBusy || downloadModel.isBusy
                            || transferModules.isBusy
                    }
                    quitGuard.hasLocalText = { transferModules.hasLocalText }
                    quitGuard.cancelTransfers = {
                        uploadModel.cancel()
                        downloadModel.cancel()
                        transferModules.cancelEverything()
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
                // **Outside everything above, and that is the point.** Below the
                // minimum supported version the shell is not in the tree at all,
                // so none of the tasks attached to it run: no residency, no
                // notification registration, no shared-draft collection. A build
                // the product refuses to answer for does not quietly go on being
                // reachable behind an update button.
                //
                // Neither action is decided here. `startUpdate` is the seam's —
                // Sparkle in this build, the App Store in the other — so no
                // policy document can name where an update comes from.
                .appVersionGate(versionSupport,
                                update: updates.startUpdate,
                                quit: { NSApplication.shared.terminate(nil) })
                // This scene root's ONE derived direction, and it moved out here
                // rather than being duplicated: the gate draws the blocking
                // screen INSTEAD of the shell, so a direction applied inside
                // would leave that screen — the only thing on the window — laid
                // out left to right in Arabic. Applied outermost, it reaches
                // both arms, and the count `MacSurfaceGuardTests` holds every
                // scene root to is unchanged.
                .environment(\.layoutDirection, appLayoutDirection)
                .task {
                    // Once per presentation of this window — a cold launch, and
                    // again when the window is reopened from the menu bar, which
                    // on this app is an ordinary thing to do after days of
                    // running. Re-reading then is the point rather than a cost:
                    // it is the only moment a long-lived process notices a
                    // requirement that moved.
                    //
                    // Skipped for acceptance for the same reason residency is:
                    // it reaches production, and nothing about a UI-test run
                    // needs it. A skipped refresh leaves the embedded floor in
                    // force, which cannot block this build.
                    guard !UITestMode.isActive else { return }
                    await versionSupport.refresh()
                }
        }
        .defaultSize(width: 1040, height: 700)
        .commands {
            CommandGroup(after: .appInfo) {
                // Sparkle's "Check for Updates…" in the direct build; nothing at
                // all in the App Store build, where an `EmptyView` contributes
                // no menu item.
                AppUpdatesMenuItem(updates: updates)
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
        // Two panes now: the login item and the verification default, and
        // updates. The Device Inbox tab left with this batch — it is a
        // destination in the main window and a menu-bar route, and a settings
        // copy of it was a second complete screen for one capability. So this
        // scene injects exactly what its two panes read: nothing about the
        // account, the navigation model or the receiver.
        Settings {
            SettingsView(updates: updates)
                .environment(\.layoutDirection, appLayoutDirection)
                .environmentObject(loginItem)
                .environmentObject(verification)
        }

        // Residency. This is the surface the persistent room socket reports
        // through: with the window closed it is the only place the user can see
        // whether this Mac is actually able to receive, and the only way back to
        // the app.
        MenuBarExtra("Relayium", systemImage: "paperplane") {
            // The menu bar is a live control surface, not a status readout: it
            // can resume nearby receiving and the Device Inbox, both of which
            // make this Mac reachable. A blocked build that kept it would be one
            // the product refuses to run and a user could put back into service
            // from a menu — so it offers the same two actions the window does.
            // Grouped so this scene root keeps ONE derived direction across both
            // arms, for the reason on the window above.
            Group {
                if versionSupport.isBlocked {
                    MenuBarVersionBlock(update: updates.startUpdate)
                } else {
                    MenuBarView()
                        .environmentObject(session)
                        .environmentObject(nearbyReceive)
                        .environmentObject(lanDiscovery)
                        .environmentObject(inbox)
                        // The Device Inbox item opens the main window on its
                        // destination, so the menu bar has to be able to select
                        // one. It renders none of them.
                        .environmentObject(navigation)
                }
            }
            .environment(\.layoutDirection, appLayoutDirection)
        }
    }
}
