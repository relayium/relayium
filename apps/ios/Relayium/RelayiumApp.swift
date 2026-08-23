import SwiftUI
import RelayiumAppKit

/// R3-F: the sixth native iOS slice.
///
/// Five tabs. **Receive** is R3-A unchanged — an anonymous encrypted stored
/// link, no account involved. **Send** is R3-C: files, folders, photos and
/// videos chosen inside the app, encrypted here and uploaded to the signed-in
/// account. **Direct** is R3-E: a six-digit pairing code carrying text or small
/// files straight to another device, across networks, while both stay open.
/// **Nearby** is this slice: the same transfer without a code, to a device the
/// user picks off a live roster, plus the passive half — one unsolicited file or
/// text session at a time. **Account** is R3-B's sign-in and usage summary plus
/// R3-D's device and stored-file management.
///
/// **What R3-E got wrong about Nearby, and this slice corrects.** R3-E deferred
/// the nearby half on the grounds that it needed "the local-network
/// entitlement". It does not. `LanDiscoveryModel` is not Bonjour and scans
/// nothing: it joins Relayium's code-less rendezvous room over the same origin
/// as everything else in the app, and the server groups that room by the public
/// IP it observes. So it needs ordinary internet access — and, in exchange, it
/// can list a stranger sitting behind the same carrier or VPN gateway, which is
/// why the tab explains what the roster is and never picks a device.
///
/// This slice therefore adds **no** capability: no `NSLocalNetworkUsageDescription`,
/// no Bonjour service, no multicast entitlement, no background mode, no push and
/// no notification. A session that arrives while the user is elsewhere brings
/// the Nearby tab forward in app instead — which is also why residency is
/// foreground-only and honestly says so.
///
/// R3-G adds durable recovery to the STORED half only, and adds no capability
/// to do it: the selected bytes are copied into this app's own Application
/// Support directory before a server session exists, so an upload the system
/// interrupts can be finished after a relaunch. It is user-driven — an explicit
/// Resume or Discard — because nothing here runs while the app is suspended.
/// Direct and Nearby remain live sessions and are unaffected.
///
/// **The Share Extension ships in this slice, and it needed one entitlement
/// rather than the three an earlier version of this comment predicted.**
/// `RelayiumShare.appex` accepts files, folders, images and movies from any
/// app's share sheet and copies them into the App Group. It claims
/// `com.apple.security.application-groups` and nothing else: no shared keychain
/// group, because it holds no credential and mints no key, and no network
/// entitlement of any kind, because it makes no request. The division is the
/// point — the extension stages plaintext copies on this device, and this app is
/// still the only thing that encrypts, uploads, knows the account's limits, or
/// produces a link. Nothing is uploaded until Send is pressed here.
///
/// **The extension does not open this app, and no link exists for it to open.**
/// Apple documents `NSExtensionContext.open` as the Today and iMessage extension
/// points' method; a Share Extension is neither, so it publishes the draft, says
/// so, and finishes. The supported hand-off is the user opening or returning to
/// Relayium, which is why `send.phaseChanged(to:)` is wired at the scene root
/// below and why the association file is unchanged by this slice.
///
/// The app gains the same App Group so it can read that inbox. It is the third
/// entitlement on a list of three, and `keychain-access-groups` is still absent.
///
/// Still absent, and deliberately not stubbed: background transfer (no
/// `URLSessionConfiguration.background`, no background mode — an upload never
/// progresses while suspended, force-quit or rebooted) and notifications.
/// StoreKit subscriptions are app-scoped below and reuse the same server-owned
/// entitlement model as macOS; the Share extension never links that adapter.
///
/// **Universal Links are wired, and their shape is unchanged here.**
/// `Relayium.entitlements` claims `associated-domains` for `applinks:relayium.com`
/// — that one domain, that one service — and the association file names exactly
/// `/d/*` and `/cross-network`. There is no custom URL scheme, so nothing but a
/// real relayium.com HTTPS link the OS has verified against the site can reach
/// `onOpenURL`. What arrives is refused a second time by `parseAppDeepLink`,
/// which is stricter still: this scheme, this host, no userinfo, no port other
/// than 443, and one of exactly two paths.
///
/// The handler here is deliberately one line. Where the link goes, what it
/// writes into the models, and — the part that is easy to get wrong — what it
/// must NOT overwrite while a transfer is running all live in the shared
/// `AppDeepLinkCoordinator`, which `AppDeepLinkCoordinatorTests` drives against
/// real models. A link never joins a session and never starts a download: it
/// selects a tab and fills a field.
@main
struct RelayiumApp: App {
    /// App-scoped rather than view-scoped, for the reason the macOS app scopes
    /// its models the same way: a download in flight must survive the view tree
    /// being rebuilt, and the session outlives any one screen.
    @StateObject private var download: CloudDownloadModel
    @StateObject private var session: AccountSession
    /// One purchase model for the process. Its update stream must remain alive
    /// while Account is off screen so renewals, refunds and interrupted
    /// purchases still reach Relayium's server and refresh the session.
    private let appleSubscription: AppleSubscriptionModel?
    /// An upload in flight and the selection behind it survive a tab switch and
    /// a view rebuild for the same reason.
    @StateObject private var upload: CloudUploadModel
    @StateObject private var send: SendSelectionModel
    /// Delivering to one of the account's own devices, and which of the two
    /// kinds of send the tab is offering.
    ///
    /// App-scoped for the sharpest version of the reason the upload model is: a
    /// device delivery outlives the screen that started it in three separate
    /// ways. SwiftUI may tear an off-screen tab down mid-upload; the durable
    /// plan survives the process itself; and an account leaving has to cancel
    /// work no view is watching. A view-scoped owner would be absent for exactly
    /// those three cases.
    @StateObject private var deliveries: InboxSendModel
    @StateObject private var sendRoutes: SendRouteSelection
    /// The account's devices and stored objects, app-scoped for a sharper
    /// reason than the others: a revoke can end THIS app's own session, and a
    /// `TabView` tears down off-screen tabs. A view-scoped model would have that
    /// operation cancelled by the user switching tabs mid-request, and would
    /// raise `needsSignOut` on an object nothing is observing any more.
    @StateObject private var management: AccountManagementModel
    /// Leaving the account, and the one thing on this list whose absence is a
    /// security defect rather than a lost transfer: a revoke of the current
    /// device kills this app's bearer server-side, and the response can land
    /// after the account tab is gone. See `AccountSignOutCoordinator`.
    @StateObject private var signOut: AccountSignOutCoordinator
    /// One preference object for the whole app, read by BOTH realtime models
    /// when a SAS arrives and written by the one control that flips it. Two
    /// instances would be a toggle that moves a setting no session consults.
    @StateObject private var verification: VerificationPreference
    /// The two direct-session models. App-scoped for the sharpest version of the
    /// reason the others are: a `TabView` tears an off-screen tab down, and the
    /// user checking their plan mid-transfer would take a live DataChannel — and
    /// a partly written receive — with it.
    @StateObject private var direct: RealtimeSessionModel
    @StateObject private var directText: RealtimeTextSessionModel
    /// The direct send's files and, more to the point, their security scopes.
    /// `fileImporter` hands back scoped URLs whose start/stop must balance
    /// exactly once, and a view whose lifetime SwiftUI decides is the one place
    /// that balance must not live.
    @StateObject private var directSelection: DirectSendSelection
    /// Files or text. App-scoped so the answer survives the tab being rebuilt
    /// mid-session, which is exactly when it matters.
    ///
    /// It is now consulted for LEGACY peers only. A peer that announced exact
    /// `link/1` has one connection carrying both, so the Nearby tab hides the
    /// picker for it entirely — `NearbyConnectPresentation` owns that decision,
    /// and this object is left holding the answer to a question that is still
    /// asked on the Direct tab and for every legacy device.
    @StateObject private var directModes: DirectModeSelection
    /// The unified `link/1`, for same-network peers that announced it.
    ///
    /// App-scoped for the sharpest version of the reason the two legacy models
    /// are, and then one more: a link outlives the tab in all the same ways, and
    /// it is ALSO the object an unsolicited inbound link is admitted into from
    /// the socket's delivery queue. A view-scoped owner would be absent exactly
    /// when a peer dials this device while the user is on Account.
    ///
    /// The pairing-code half is deliberately absent. `AppEnvironment`'s iOS
    /// overload takes no room handle, so this model has no `connectPairingSocket`
    /// and nothing here can watch a code — the structural half of the boundary
    /// `LINK_PAIRING_ROOM_SUPPORT` states at the wire.
    @StateObject private var link: LinkWorkspaceModel
    /// The link's own post-connect file picker, and a SECOND selection owner on
    /// purpose.
    ///
    /// `directSelection` holds what the user staged before connecting, and that
    /// batch belongs to them until it is sent or cleared. A send made INSIDE the
    /// workspace is a different act — already committed, already addressed to a
    /// peer on screen — so writing it into the shared store would silently
    /// replace a selection they may still want for a different device. Same
    /// reason the macOS pane uses a private `SelectionStore` for its own sends.
    ///
    /// App-scoped rather than view-scoped for the reason `DirectSendSelection`
    /// records about itself: `fileImporter` hands back security-scoped URLs whose
    /// start/stop must balance exactly once, and a `TabView` decides when a view
    /// dies.
    @StateObject private var linkSelection: DirectSendSelection
    /// Foreground-only, enforced. This app claims no background mode, so a
    /// direct session cannot survive being backgrounded; this ends it and says
    /// so, instead of leaving a progress bar that will never move again.
    @StateObject private var foreground: ForegroundSessionCoordinator
    /// The one code-less room socket, and the one inbound listener on it.
    ///
    /// App-scoped for a reason the tabs do not share: residency is what makes
    /// this device reachable, so it must not be created or destroyed by a tab
    /// appearing. Two would put this device in the room twice, under two peer
    /// ids, and every other device would list it as two devices.
    @StateObject private var discovery: LanDiscoveryModel
    @StateObject private var nearbyReceive: NearbyReceiveModel
    /// The order in which becoming reachable happens — the receive folder
    /// resolved and installed first, the room left before the session cleanup —
    /// which is a decision no SwiftUI modifier can hold and no test could reach
    /// if it were spread across the scene body.
    @StateObject private var residency: NearbyResidencyCoordinator
    /// Which of the two direct tabs draws the session. They drive the SAME two
    /// models, so rendered side by side they would show one transfer twice,
    /// each copy with its own Cancel.
    @StateObject private var presence: TransferPresence
    /// Which tab is on screen. App-scoped rather than `@State` in the shell for
    /// exactly one case, and it is this slice's: an unsolicited session has to
    /// be able to select the Nearby tab from outside the view tree, and a
    /// `@State` is reset the moment SwiftUI rebuilds that tree.
    @StateObject private var navigation: AppNavigationModel
    /// The link the OS handed this app, parsed and held until the shell has
    /// acted on it. App-scoped because `onOpenURL` can fire before the shell's
    /// subscription exists — a cold launch straight from a link is exactly that
    /// — and `@Published` replays its current value to a late subscriber.
    @StateObject private var deepLinks = AppDeepLinkRouter()
    /// What that link then does. App-scoped for the sharper reason: a link that
    /// arrives mid-transfer is RETAINED and applied when the transfer stops, so
    /// the object holding it has to outlive whichever tab happened to be on
    /// screen — and it watches the models directly rather than through a view.
    @StateObject private var deepLinkRouting: AppDeepLinkCoordinator

    /// The one scene-phase reader in the app.
    ///
    /// At the App scope rather than on a view, because a view-scoped observer is
    /// absent for exactly the interval this exists to handle: SwiftUI need not
    /// keep an off-screen tab mounted, and "the app went away" is not a moment
    /// to depend on which tab happened to be on screen.
    @Environment(\.scenePhase) private var scenePhase

    @MainActor
    init() {
        // Held as a local as well, because the deep-link coordinator built at
        // the end of this initializer needs it: a `@StateObject`'s wrapped value
        // cannot be read from `init`, so anything two objects share has to exist
        // as a local first. Same shape as `keys`, `account` and `managing`.
        let downloads = AppEnvironment.makeDownloadModel(
            transport: UITestMode.makeAccountTransport())
        UITestMode.prefillValidDownloadLink(in: downloads)
        _download = StateObject(wrappedValue: downloads)
        let account = AppEnvironment.makeSession(tokenStore: UITestMode.makeTokenStore(),
                                                 transport: UITestMode.makeAccountTransport())
        _session = StateObject(wrappedValue: account)
        appleSubscription = UITestMode.makeSubscriptionModel(
            bearer: { account.bearerToken },
            refreshAccount: { await account.refresh() })
            ?? IOSAppleSubscriptions.makeModel(
                bearer: { account.bearerToken },
                refreshAccount: { await account.refresh() })
        // ONE stored-link key store: the upload model WRITES a key here and the
        // account management model READS it back and removes it with the object.
        // Two instances would still address the same keychain items, so this is
        // not a correctness fix — it is what keeps the shared dependency visible
        // rather than implied by two constructors happening to agree. Getting it
        // wrong looks like an upload whose link the Account tab cannot rebuild,
        // and the key exists nowhere else: not on the server, only in the link
        // and in this store. R3-B made `makeStoredLinkKeyStore` per-platform, so
        // this resolves to com.relayium.app with NO access group and no `#if`.
        let keys = UITestMode.makeStoredLinkKeyStore()
            ?? AppEnvironment.makeStoredLinkKeyStore()
        // R3-G: the stored-send half gets durable recovery. The bytes are
        // staged into this app's own Application Support directory before a
        // server session exists, so an upload the system interrupts can be
        // finished later — by the user asking, never on its own.
        // ONE shared-draft store, handed to both halves that touch it: the send
        // model, which lists and adopts what the share extension staged, and the
        // upload model, which retires the source once a job carrying it is
        // durable. Two stores would address the same directory and so would not
        // fail — until one of them was pointed somewhere else.
        //
        // Nil when the App Group cannot be resolved, which is the un-provisioned
        // development build. Everything else on this tab goes on working; the
        // shared-draft surface simply never appears, because nothing can arrive.
        let drafts = AppEnvironment.makeSharedDraftStore()
        // ONE `PendingUploadSupport`, held as a local and handed to BOTH halves
        // that stage bytes: the link upload model and the device delivery model.
        // Two would be two staging roots and two keychain namespaces over one
        // directory — which would work, right up until one of them was pointed
        // elsewhere, and would then leave device deliveries the recovery path
        // cannot see. Same shape and same reason as `keys` and `drafts` above.
        let pending = AppEnvironment.makePendingUploadSupport(
            drafts: drafts, root: UITestMode.pendingUploadRoot())
        let uploads = AppEnvironment.makeUploadModel(
            keyStore: keys,
            pending: pending,
            transport: UITestMode.makeAccountTransport())
        let managing = AppEnvironment.makeAccountManagementModel(
            keyStore: keys, transport: UITestMode.makeAccountTransport())
        _management = StateObject(wrappedValue: managing)
        // Subscribed HERE, in init, and not from a `.task` on any view. That is
        // the whole point: the signal it watches for is raised by a network
        // response that can arrive after the account tab has been torn down, so
        // an observer with a view's lifetime is an observer that is not there
        // when it is needed. Same reason `sending.observe` below is here.
        //
        // The session is passed as a closure rather than as an object so the
        // coordinator's tests can hold a logout open and inspect the app while
        // the revocation is in flight.
        let leaving = AccountSignOutCoordinator(management: managing,
                                                logOut: { await account.logOut() })
        leaving.observe(managing.$needsSignOut)
        _signOut = StateObject(wrappedValue: leaving)
        _upload = StateObject(wrappedValue: uploads)
        let sending = AppEnvironment.makeSendSelectionModel(upload: uploads, drafts: drafts)
        // App-scoped, for the model's whole life, and BEFORE any view exists.
        // A `.task` inside SendView would not do: SwiftUI mounts a TabView's
        // tabs lazily and may tear down an off-screen one, so a user who signs
        // out while looking at the Receive tab would get no isolation at all and
        // an authenticated upload would keep running under an account that is
        // gone.
        sending.observe(account.$state)
        // AFTER `observe`, and the order is the correctness. Both subscribe to
        // `account.$state`, `@Published` delivers in subscription order, and the
        // preselection's whole job is to inject only once the model this line
        // installs has already accepted the ready account. Subscribing first
        // would mean asking the send model about an account it has not been told
        // about yet. A no-op without the acceptance argument, and absent from
        // Release: see `UITestMode.preselectPendingFixture`.
        UITestMode.preselectPendingFixture(into: sending, upload: uploads, session: account)
        _send = StateObject(wrappedValue: sending)

        // The device-delivery half, built from the SAME pending support and
        // observing the SAME session — and both for reasons that are safety
        // rather than symmetry.
        //
        // The observation is installed HERE, before any view exists, for the
        // reason `sending.observe` is: a `TabView` may tear an off-screen tab
        // down, so a user who signs out while looking at Receive would otherwise
        // get no isolation at all and an account-owned delivery would keep
        // running — and keep being described on screen — under an account that
        // is gone.
        let delivering = AppEnvironment.makeInboxSendModel(
            pending: pending, transport: UITestMode.makeAccountTransport())
        delivering.observe(account.$state)
        // The one seam between the two halves of the Send tab, and the only
        // thing in this app allowed to retire a shared draft on a delivery's
        // behalf. It fires the moment a durable, account-bound job owns those
        // bytes and never before: until then the staged draft is the user's only
        // copy of what another app handed them. The ACCOUNT travels with it so
        // the receiver can refuse a report that arrives after the account it
        // belongs to has left, which is the case a closure alone could not
        // express. `SendSelectionModel.deviceSendCommitted` owns what it means.
        delivering.onSelectionCommitted = { [weak sending] accountId, draftId in
            sending?.deviceSendCommitted(accountId: accountId, sourceDraftId: draftId)
        }
        _deliveries = StateObject(wrappedValue: delivering)
        _sendRoutes = StateObject(wrappedValue: SendRouteSelection())

        // The direct half. Built against ONE preference instance, because both
        // models read it through a closure when the SAS lands — a second object
        // would be a setting the sessions never see.
        //
        // R3-F switches these to the NEARBY factories, and the whole graph is
        // built here because each object needs the previous one at construction
        // and a `@StateObject` default value cannot reference another property.
        // One discovery model, one inbound room, two session models, one
        // listener: both same-network directions reach through the single room
        // socket the discovery model owns, and reconnecting mints a new socket,
        // which is why the listener re-subscribes through the observer slot
        // rather than holding one.
        let verifying = VerificationPreference()
        _verification = StateObject(wrappedValue: verifying)
        let nearby = AppEnvironment.makeLanDiscoveryModel()
        // Holds the exact socket an inbound attempt is being built on. A peer id
        // only means something inside the room that issued it, so a builder that
        // read "the current room" would, in the one case that matters — a drop
        // mid-setup — reach a room where that id belongs to somebody else.
        let room = InboundRoom()
        let files = UITestMode.makeTerminalNearbyFileModel(verification: verifying)
            ?? UITestMode.makeWaitingFileModel(verification: verifying)
            ?? AppEnvironment.makeRealtimeModel(verification: verifying, nearby: nearby, inboundRoom: room)
        let texts = UITestMode.makeRealtimeTextModel(verification: verifying)
            ?? AppEnvironment.makeRealtimeTextModel(verification: verifying, nearby: nearby, inboundRoom: room)
        _direct = StateObject(wrappedValue: files)
        _directText = StateObject(wrappedValue: texts)
        _discovery = StateObject(wrappedValue: nearby)
        let selecting = DirectSendSelection()
        let modes = DirectModeSelection()
        _directSelection = StateObject(wrappedValue: selecting)
        _directModes = StateObject(wrappedValue: modes)
        _linkSelection = StateObject(wrappedValue: DirectSendSelection())

        // **The unified link, and the one thing about its construction that is a
        // correctness decision rather than an ordering one.**
        //
        // `receiveDirectory` reads `files.saveDirectory` at call time. That
        // property is not a convenience copy of `ReceiveDestination.directory()`
        // — it is the value `NearbyResidencyCoordinator.installDestination`
        // resolved and installed, and residency refuses to join the room at all
        // when it cannot. So this closure is not "resolve the receive folder"; it
        // is "read the folder this device was made reachable on the strength of".
        //
        // Calling `ReceiveDestination.directory()` here instead would compile,
        // return the same URL almost always, and be wrong in exactly the case
        // that matters: something in the user's own Files app occupying the name
        // `Received`. Residency reports that, stays out of the room and offers a
        // retry; an independently re-resolving link would either throw where it
        // cannot report, or — worse — succeed against a directory residency had
        // already decided this device could not use, and write a peer's files
        // into a destination the receiving surface is telling the user is broken.
        // One resolver, one owner, read rather than repeated.
        let unified = AppEnvironment.makeLinkWorkspaceModel(
            verification: verifying, nearby: nearby,
            receiveDirectory: { files.saveDirectory })
        _link = StateObject(wrappedValue: unified)

        let presenting = TransferPresence()
        // The link is the THIRD liveness source, and it is not optional: a link
        // uses NEITHER legacy model, so both of them read `.idle` for its entire
        // life. Observed by the two-model overload, an iOS link would have its
        // surface claim released the instant it started, and the tab would go
        // back to the roster with a live connection running behind it.
        presenting.observeSessions(fileModel: files, textModel: texts, link: unified)
        let routing = AppNavigationModel(selection: .storedReceive)
        _presence = StateObject(wrappedValue: presenting)
        _navigation = StateObject(wrappedValue: routing)

        // The authoritative gate for an UNSOLICITED link, on the main actor, and
        // through the SAME `TransferPresence` the legacy admission below uses —
        // which is what makes "a link session and a legacy session cannot
        // coexist" structural rather than intended. No `DirectModeSelection.adopt`
        // here, unlike `AppRouting.claimIncoming`: a link has no lane to adopt,
        // and writing one would leave the picker's answer describing a session
        // that has no halves.
        unified.shouldAcceptLink = { peerID in
            guard presenting.beginSession(.nearby,
                                          peerLabel: nearby.label(forPeerID: peerID))
            else { return false }
            routing.select(.nearby)
            return true
        }
        // The advisory mirror the socket's delivery queue reads, written from the
        // one authoritative fact — whether anything owns the surface — so it
        // cannot drift from the gate above by more than the hop it is documented
        // to lag by. Subscribed here, at app scope, because the subscription must
        // outlive any tab exactly as the link does.
        unified.observeAvailability(
            presenting.$owner.map { $0 == nil }.eraseToAnyPublisher())
        #if DEBUG
        if UITestMode.showsTerminalNearby {
            presenting.claim(.nearby, mode: .files,
                             peerLabel: "Studio Mac · 19af02") // nonlocalized: deterministic UI-test fixture
            routing.select(.nearby)
            Task { await files.connectNearby(peerId: "ui-nearby-peer", role: .initiator) }
        }
        #endif

        let receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: files, textModel: texts, discovery: nearby, inboundRoom: room)
        // Called synchronously as the offer is admitted and BEFORE the responder
        // is built across an await — which is the only moment this can be done,
        // because by the time the session is live the mode picker that would fix
        // a wrong surface is locked. One shared call rather than three writes
        // here, so a later edit to this file cannot reorder them; `AppRouting`
        // owns what it does and `AppRoutingTests` drives it.
        receive.shouldAcceptSession = { kind, peerID in
            AppRouting.claimIncoming(kind, peerLabel: nearby.label(forPeerID: peerID),
                                     presence: presenting,
                                     modes: modes, navigation: routing)
        }
        _nearbyReceive = StateObject(wrappedValue: receive)
        // Built here, before any view exists, for the same reason the sign-out
        // coordinator is: it acts on a signal that arrives when the surface that
        // would have observed it may already be gone.
        //
        // The link goes in as the THIRD thing that cannot survive backgrounding,
        // and this object is its single owner: residency stops the room first —
        // which by design does NOT end an open link, only marks it
        // `signalingLost` — and then hands `.background` here. No view ends it on
        // disappearance, because a `TabView` teardown is not the user leaving.
        let ending = ForegroundSessionCoordinator(file: files, text: texts, link: unified)
        _foreground = StateObject(wrappedValue: ending)
        // The lifecycle now goes through residency, which owns the ORDER: on
        // `.background` the room is left BEFORE R3-E's session cleanup runs, or
        // there is a window in which this device is listed, dialable, and has
        // already torn its transfer down.
        _residency = StateObject(wrappedValue: NearbyResidencyCoordinator(
            discovery: nearby, fileModel: files, foreground: ending))
        // Last, because it is built from four objects above and owns none of
        // them. It navigates exactly once per link, and it is the ONE place that
        // decides whether a link may write into a model that is mid-transfer —
        // which is why no view on this platform repeats that decision.
        _deepLinkRouting = StateObject(wrappedValue: AppDeepLinkCoordinator(
            navigation: routing, download: downloads,
            realtime: files, realtimeText: texts, presence: presenting,
            selectRealtimeMode: { mode in
                modes.select(mode, file: files.state, text: texts.state)
            }))
    }

    /// SwiftUI's three phases, narrowed to the one decision this app makes.
    ///
    /// **`.inactive` is not `.background`.** The system reports `.inactive`
    /// while a document picker, a share sheet, Control Centre or the app
    /// switcher is up — which is to say, at the exact moment the user is
    /// choosing the files they are about to send. Folding it into `.background`
    /// would cancel the session on the way into the picker, every time, and
    /// would read as the picker being broken.
    private func lifecycle(_ phase: ScenePhase) -> AppLifecyclePhase {
        switch phase {
        case .background: return .background
        case .inactive: return .inactive
        default: return .active
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(download: download, upload: upload, send: send,
                     deliveries: deliveries, sendRoutes: sendRoutes,
                     direct: direct, directText: directText,
                     directSelection: directSelection, directModes: directModes,
                     foreground: foreground,
                     discovery: discovery, nearbyReceive: nearbyReceive,
                     residency: residency,
                     link: link, linkSelection: linkSelection,
                     navigation: navigation, presence: presence,
                     deepLinks: deepLinks, deepLinkRouting: deepLinkRouting)
                .environmentObject(session)
                // The preference the two direct models read. Injected rather
                // than passed, because the two session views render the derived
                // phrase from it and neither owns the decision.
                .environmentObject(verification)
                // Installed at the app scope rather than handed to the account
                // tab, so the object survives a tab being torn down. Only the
                // ready account surface declares it; the receive tab names
                // neither it nor the session, which is what keeps anonymous
                // receive structurally independent of an account.
                .environmentObject(management)
                .environmentObject(signOut)
                .environment(\.appleSubscription, appleSubscription)
                .task { appleSubscription?.startObservingUpdates() }
                // The one lifecycle observer, on the scene root rather than on a
                // tab. What it does with each phase is
                // `NearbyResidencyCoordinator`'s decision — which includes when
                // to hand `.background` on to `ForegroundSessionCoordinator`,
                // and in what order relative to leaving the room.
                // `NearbyResidencyCoordinatorTests` and
                // `ForegroundSessionCoordinatorTests` drive every phase against
                // real models; this only reports the phase.
                .onChange(of: scenePhase) { phase in
                    // UI acceptance must not publish a simulator into the
                    // public-address Nearby room. In Release `isActive` is a
                    // compile-time false, so shipped residency is unconditional.
                    //
                    // `allowsResidency` is the one exception, and it is the
                    // exception that removes the reason rather than overriding
                    // it: it is true only for an acceptance launch whose
                    // resolved origin is loopback, where the room is a server on
                    // this machine and holds nobody else. See its own comment.
                    if !UITestMode.isActive || UITestMode.allowsResidency {
                        residency.phaseChanged(to: lifecycle(phase))
                    }
                    // The share extension's ONLY hand-off. It cannot open this
                    // app — a Share Extension is not an extension point Apple
                    // lets do that — so what brings a staged draft onto the Send
                    // tab is the user coming back to Relayium, which is this.
                    // The phase is reported and nothing more: whether `.active`
                    // means "re-read the App Group inbox", and whether
                    // `.inactive` does, is `SendSelectionModel`'s decision, and
                    // `SharedDraftAdoptionTests` drives it.
                    send.phaseChanged(to: lifecycle(phase))
                }
                // Launch. `onChange` fires on a CHANGE, and the app is already
                // `.active` when the scene first appears — so without this the
                // device would only ever become reachable after its first trip
                // to the background and back. Re-entrant by construction:
                // resolving the folder is idempotent and `startResident` refuses
                // both a second socket and an override of the user's pause.
                .task {
                    // Before anything can be chosen, and a no-op in Release.
                    UITestMode.stagePendingFixture()
                    // Before anything can be received, and likewise a no-op in
                    // Release: the acceptance path that completes a download
                    // needs the empty folder a fresh install has, not whatever
                    // an earlier run of the same path left in the container.
                    UITestMode.resetReceivedFolder()
                    if UITestMode.showsOffReceiving {
                        // Neither. This is the off state a destination failure
                        // leaves behind — never resident, never paused — and
                        // the one the receiving card used to describe as a
                        // listener it could offer to pause.
                    } else if UITestMode.isActive, !UITestMode.allowsResidency {
                        // Keep the acceptance UI internally coherent as well
                        // as offline: the status, explanation and action all
                        // describe a deliberate pause instead of an unstarted
                        // listener with a live-looking Pause button.
                        //
                        // A loopback launch takes the ordinary arm below
                        // instead, and has to: a paused listener answers no
                        // offer, so pausing it would leave the acceptance run
                        // proving that nothing arrives.
                        residency.pause()
                    } else {
                        residency.phaseChanged(to: .active)
                    }
                    // Cold launch, including the launch that follows a user
                    // sharing something and then tapping Relayium on the home
                    // screen. `onChange` fires on a CHANGE and the scene is
                    // already `.active` when it first appears, so without this a
                    // draft staged before launch would not appear until the app
                    // had been backgrounded and brought forward again.
                    send.phaseChanged(to: .active)
                }
                // A Universal Link the OS verified against relayium.com, at the
                // SCENE root rather than on a tab: this fires on a cold launch
                // before any tab has been built, and on a warm one while an
                // arbitrary tab is on screen. `open` refuses anything
                // `parseAppDeepLink` does not recognise and returns without
                // touching the pending link, so a hostile URL cannot discard a
                // valid one that is still waiting to be acted on. What a
                // recognised link then DOES is `RootView`'s one subscription and
                // `AppDeepLinkCoordinator`'s decision; nothing is applied here.
                .onOpenURL { deepLinks.open($0) }
        }
    }
}
