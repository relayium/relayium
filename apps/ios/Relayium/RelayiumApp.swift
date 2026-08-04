import SwiftUI
import RelayiumAppKit

/// R3-E: the fifth native iOS slice.
///
/// Four tabs. **Receive** is R3-A unchanged — an anonymous encrypted stored
/// link, no account involved. **Send** is R3-C: files, folders, photos and
/// videos chosen inside the app, encrypted here and uploaded to the signed-in
/// account. **Direct** is this slice: a six-digit pairing code carrying text or
/// small files straight to another device, across networks, while both stay
/// open. **Account** is R3-B's sign-in and usage summary plus R3-D's device and
/// stored-file management.
///
/// **What R3-E is careful NOT to acquire.** Direct is realtime transfer, and
/// realtime transfer on macOS comes with a nearby half — a resident room socket,
/// a device roster, an inbound listener — so the shape of the shared code
/// invites it. iOS takes none of it: `AppEnvironment`'s code-only factories
/// build both models with the pairing-code path alone, and this file names no
/// `LanDiscoveryModel`, no `InboundRoom` and no `NearbyReceiveModel`. That is a
/// capability claim as much as a wiring choice — the local-network entitlement
/// is one this app does not have and this slice does not add.
///
/// Still absent, and deliberately not stubbed: nearby transfer, background
/// transfer and resume, notifications, IAP, and the **Share Extension** — which
/// is deferred to the separately designed capability/release slice, because it
/// is a second target in a second process needing an App Group and a shared
/// keychain access group, which are three entitlements this development build
/// cannot claim.
///
/// Still no `onOpenURL`. Without Associated Domains — which this slice does not
/// claim, because the routing it would justify still does not exist — nothing
/// can deliver a URL to this app, so wiring the handler would be dead code that
/// reads like universal-link support. That includes `/cross-network#c=<code>`,
/// which macOS does route: the Direct tab could consume one now, and the
/// entitlement it would need is still not this slice's to add.
@main
struct RelayiumApp: App {
    /// App-scoped rather than view-scoped, for the reason the macOS app scopes
    /// its models the same way: a download in flight must survive the view tree
    /// being rebuilt, and the session outlives any one screen.
    @StateObject private var download: CloudDownloadModel
    @StateObject private var session: AccountSession
    /// An upload in flight and the selection behind it survive a tab switch and
    /// a view rebuild for the same reason.
    @StateObject private var upload: CloudUploadModel
    @StateObject private var send: SendSelectionModel
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
    @StateObject private var directModes: DirectModeSelection
    /// Foreground-only, enforced. This app claims no background mode, so a
    /// direct session cannot survive being backgrounded; this ends it and says
    /// so, instead of leaving a progress bar that will never move again.
    @StateObject private var foreground: ForegroundSessionCoordinator

    /// The one scene-phase reader in the app.
    ///
    /// At the App scope rather than on a view, because a view-scoped observer is
    /// absent for exactly the interval this exists to handle: SwiftUI need not
    /// keep an off-screen tab mounted, and "the app went away" is not a moment
    /// to depend on which tab happened to be on screen.
    @Environment(\.scenePhase) private var scenePhase

    @MainActor
    init() {
        _download = StateObject(wrappedValue: AppEnvironment.makeDownloadModel())
        let account = AppEnvironment.makeSession()
        _session = StateObject(wrappedValue: account)
        // ONE stored-link key store: the upload model WRITES a key here and the
        // account management model READS it back and removes it with the object.
        // Two instances would still address the same keychain items, so this is
        // not a correctness fix — it is what keeps the shared dependency visible
        // rather than implied by two constructors happening to agree. Getting it
        // wrong looks like an upload whose link the Account tab cannot rebuild,
        // and the key exists nowhere else: not on the server, only in the link
        // and in this store. R3-B made `makeStoredLinkKeyStore` per-platform, so
        // this resolves to com.relayium.app with NO access group and no `#if`.
        let keys = AppEnvironment.makeStoredLinkKeyStore()
        let uploads = AppEnvironment.makeUploadModel(keyStore: keys)
        let managing = AppEnvironment.makeAccountManagementModel(keyStore: keys)
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
        let sending = AppEnvironment.makeSendSelectionModel(upload: uploads)
        // App-scoped, for the model's whole life, and BEFORE any view exists.
        // A `.task` inside SendView would not do: SwiftUI mounts a TabView's
        // tabs lazily and may tear down an off-screen one, so a user who signs
        // out while looking at the Receive tab would get no isolation at all and
        // an authenticated upload would keep running under an account that is
        // gone.
        sending.observe(account.$state)
        _send = StateObject(wrappedValue: sending)

        // The direct half. Built against ONE preference instance, because both
        // models read it through a closure when the SAS lands — a second object
        // would be a setting the sessions never see.
        //
        // The factories are the CODE-ONLY ones. Their nearby siblings take a
        // `LanDiscoveryModel` and an `InboundRoom`, and constructing either here
        // would open a room socket nothing reads and claim a local-network
        // capability this app carries no entitlement for. What these produce
        // instead is a model whose nearby entry points refuse —
        // `AppEnvironmentTests` asserts exactly that, rather than the absence of
        // a closure, which nothing could observe.
        let verifying = VerificationPreference()
        _verification = StateObject(wrappedValue: verifying)
        let files = AppEnvironment.makeRealtimeModel(verification: verifying)
        let texts = AppEnvironment.makeRealtimeTextModel(verification: verifying)
        _direct = StateObject(wrappedValue: files)
        _directText = StateObject(wrappedValue: texts)
        _directSelection = StateObject(wrappedValue: DirectSendSelection())
        _directModes = StateObject(wrappedValue: DirectModeSelection())
        // Built here, before any view exists, for the same reason the sign-out
        // coordinator is: it acts on a signal that arrives when the surface that
        // would have observed it may already be gone.
        _foreground = StateObject(wrappedValue: ForegroundSessionCoordinator(file: files,
                                                                             text: texts))
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
                     direct: direct, directText: directText,
                     directSelection: directSelection, directModes: directModes,
                     foreground: foreground)
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
                // The one lifecycle observer, on the scene root rather than on a
                // tab. What it does with each phase is
                // `ForegroundSessionCoordinator`'s decision, where
                // `ForegroundSessionCoordinatorTests` drives every one of them
                // against real models; this only reports the phase.
                .onChange(of: scenePhase) { phase in
                    foreground.phaseChanged(to: lifecycle(phase))
                }
        }
    }
}
