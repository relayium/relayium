import SwiftUI
import RelayiumAppKit

/// R3-C: the third native iOS slice.
///
/// Three tabs. **Receive** is R3-A unchanged — an anonymous encrypted stored
/// link, no account involved. **Account** is R3-B: password sign-in and a
/// read-only usage summary on the same `AccountSession` the macOS app runs.
/// **Send** is new: files, folders, photos and videos chosen inside the app,
/// encrypted here and uploaded to the signed-in account.
///
/// Still absent, and deliberately not stubbed: realtime and nearby transfer,
/// device and stored-file management, background transfer and resume,
/// notifications, IAP, and the **Share Extension** — which is deferred to the
/// separately designed capability/release slice, because it is a second target
/// in a second process needing an App Group and a shared keychain access group,
/// which are three entitlements this development build cannot claim.
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

    @MainActor
    init() {
        _download = StateObject(wrappedValue: AppEnvironment.makeDownloadModel())
        let account = AppEnvironment.makeSession()
        _session = StateObject(wrappedValue: account)
        // ONE stored-link key store, and the one R3-D's account management model
        // will read. Two stores would mean an upload whose link the Account tab
        // cannot rebuild — the key exists nowhere else. R3-B made
        // `makeStoredLinkKeyStore` per-platform, so this resolves to
        // com.relayium.app with NO access group and needs no `#if`.
        let keys = AppEnvironment.makeStoredLinkKeyStore()
        let uploads = AppEnvironment.makeUploadModel(keyStore: keys)
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
        }
    }
}
