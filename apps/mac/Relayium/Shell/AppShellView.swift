import SwiftUI
import Combine
import RelayiumAppKit

/// The window's whole content: a sidebar and whichever destination is selected.
///
/// **The split view is rendered unconditionally.** The shell holds no reference
/// to the account and never switches on its state — the source guard checks that
/// by name — because the moment it does, every capability that works signed out
/// disappears behind a sign-in form that does not gate it. A destination that
/// has an account-backed half asks for an `AccountGate` and renders it beside
/// the half that has none; exactly one destination switches on the session state
/// itself, and it is the one that *is* the sign-in.
struct AppShellView: View {
    @EnvironmentObject private var navigation: AppNavigationModel
    // Routing only. The shell holds these because it is the one place that sees
    // an event arriving for a destination that is not on screen; it populates a
    // field and selects, and never renders any of them.
    @EnvironmentObject private var deepLinks: AppDeepLinkRouter
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var downloadModel: CloudDownloadModel
    @EnvironmentObject private var realtimeModel: RealtimeSessionModel
    @EnvironmentObject private var realtimeTextModel: RealtimeTextSessionModel
    @EnvironmentObject private var nearbyReceive: NearbyReceiveModel
    /// The ONE account-adjacent fact this file learns, and it is deliberately
    /// not who is signed in: whether a sign-out's network revocation is running
    /// right now.
    ///
    /// That distinction is why this does not break the rule above. A
    /// `session.state` read would decide the shell's STRUCTURE from whether
    /// somebody has an account, which is the sign-in wall this design removed.
    /// This is a transient operation — it goes up when a revocation starts and
    /// comes down when it ends, signed in or not — and while it is up the bearer
    /// is either already dead server-side or being killed, so an upload started
    /// from any destination would be spent against a credential that is going
    /// away.
    @EnvironmentObject private var signOut: AccountSignOutCoordinator

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 208, ideal: 224, max: 288)
        } detail: {
            // No `default`: a sixth destination is a compile error here rather
            // than a sidebar row that opens nothing.
            switch navigation.selection {
            case .nearby:        NearbyDestination()
            case .pairingCode:   PairingCodeDestination()
            case .storedSend:    StoredSendDestination()
            case .storedReceive: StoredReceiveDestination()
            case .account:       AccountDestination()
            }
        }
        .frame(minWidth: 860, minHeight: 560)
        // A modifier ON the split view, never a branch around it: the structure
        // still renders unconditionally, which is what keeps every signed-out
        // capability reachable. Applied here rather than inside a destination so
        // it reaches the sidebar too — a destination the user could still select
        // is a destination they could still act in.
        .disabled(signOut.isSigningOut)
        // Said out loud, not merely enforced. A window that stops responding
        // with no explanation reads as the app having hung, and a bare
        // `ProgressView()` reads as nothing at all to VoiceOver.
        .overlay {
            if signOut.isSigningOut {
                ProgressView { Text(L10n.t(.accountSigningOut)) }
                    .controlSize(.small)
                    .padding(20)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
            }
        }
        // A link the OS handed this app. `AppDeepLinkRouter` has already
        // refused anything that is not a relayium.com link this app can serve,
        // so what arrives here is one of exactly two shapes.
        .onReceive(deepLinks.$pending.compactMap { $0 }) { link in
            // The ONE selection write, derived from the link rather than
            // decided here — the mapping is a `switch` with no `default` in
            // `AppRouting`, so a third link shape is a compile error there
            // instead of a link that opens whatever was already on screen.
            navigation.select(AppRouting.destination(for: link))
            switch link {
            case let .download(url):
                downloadModel.linkText = url.absoluteString
                downloadModel.resolve()
            case let .realtime(code):
                // A pairing code does not reveal whether the sender chose files
                // or text, so both models are populated and the mode picker in
                // the destination is what decides. Populating one would make a
                // deep link work for half of the codes it can carry.
                if let code {
                    realtimeModel.updateJoinCode(code)
                    realtimeTextModel.updateJoinCode(code)
                }
            }
            // Consumed, so the same link cannot be applied twice — a second
            // application would re-`resolve()` a download the user may already
            // have saved, throwing away the result surface it is looking at.
            //
            // Deferred by one turn, and that is load-bearing rather than
            // stylistic: `@Published` emits in `willSet`, so this handler runs
            // BEFORE the router has stored the link. A `consume()` called
            // straight from here is overwritten by the very assignment that
            // delivered it, leaving the router holding the link — and
            // `Published` replays its current value to every NEW subscriber.
            // This subscription is rebuilt each time the unique window is
            // closed and reopened from the menu bar, so an unconsumed link
            // would resolve itself again on reopen. `AppDeepLinkTests` pins
            // that ordering on the router.
            Task { @MainActor in deepLinks.consume() }
        }
        // A session nobody asked for. `task(id:)` rather than `onChange`
        // because the window may have been closed when it started and rebuilt
        // while it is still running: `onChange` fires on a transition this view
        // tree never saw, `task(id:)` fires on the value it comes back to.
        .task(id: nearbyReceive.activeKind) {
            guard let kind = nearbyReceive.activeKind else { return }
            navigation.select(AppRouting.destination(forIncoming: kind))
            // Idempotent, and deliberately duplicated by `NearbyDestination`:
            // that one claims when nearby is the destination on screen, this
            // one claims when it is not yet. A claim by the current owner
            // returns true and changes nothing.
            presence.claim(.nearby, mode: kind == .file ? .files : .text)
        }
    }
}
