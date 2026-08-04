import SwiftUI
import RelayiumAppKit

/// R3-D: the fourth native iOS slice.
///
/// Three tabs. **Receive** is R3-A unchanged — an anonymous encrypted stored
/// link, no account involved. **Send** is R3-C: files, folders, photos and
/// videos chosen inside the app, encrypted here and uploaded to the signed-in
/// account. **Account** is R3-B's sign-in and usage summary plus this slice's
/// addition: the devices holding a token for this account, the ciphertext it is
/// storing, and the two writes that go with them — revoking a credential and
/// deleting a stored object.
///
/// Still absent, and deliberately not stubbed: realtime and nearby transfer,
/// background transfer and resume, notifications, IAP, and the **Share
/// Extension** — which is deferred to the separately designed capability/release
/// slice, because it is a second target in a second process needing an App Group
/// and a shared keychain access group, which are three entitlements this
/// development build cannot claim.
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
    }

    var body: some Scene {
        WindowGroup {
            RootView(download: download, upload: upload, send: send)
                .environmentObject(session)
                // Installed at the app scope rather than handed to the account
                // tab, so the object survives a tab being torn down. Only the
                // ready account surface declares it; the receive tab names
                // neither it nor the session, which is what keeps anonymous
                // receive structurally independent of an account.
                .environmentObject(management)
                .environmentObject(signOut)
        }
    }
}
