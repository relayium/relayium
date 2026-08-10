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
    // an event arriving for a destination that is not on screen; it selects, and
    // never renders any of them.
    //
    // The link path deliberately does NOT hold the transfer models any more.
    // Deciding what a link may write — and what it must not overwrite while a
    // transfer is running — belongs to `AppDeepLinkCoordinator`, and a view that
    // still had the models to hand is a view that could re-derive that decision
    // where no test reaches it.
    @EnvironmentObject private var deepLinks: AppDeepLinkRouter
    @EnvironmentObject private var deepLinkRouting: AppDeepLinkCoordinator
    /// The OS hand-off for opened files, and where they go. Held here for the
    /// same reason the link pair is: this shell forwards one to the other and
    /// decides nothing itself.
    @EnvironmentObject private var fileOpens: AppFileOpenRouter
    @EnvironmentObject private var fileOpenRouting: AppFileOpenCoordinator
    @EnvironmentObject private var presence: TransferPresence
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
            Group {
                // Switched on the SURFACE rather than on the destination, and
                // that indirection is the whole shape of this round: `.nearby`
                // and `.pairingCode` are still two routes — iOS renders them as
                // two tabs, deep links and incoming sessions still select them
                // by name — and on macOS they are two ways into one screen.
                //
                // No `default`, exactly as before: a sixth macOS surface is a
                // compile error here rather than a sidebar row that opens
                // nothing, and a seventh destination is a compile error in
                // `AppDestination.macSurface` rather than a screen that never
                // opens.
                switch navigation.selection.macSurface {
                case .workspace:     WorkspaceDestination()
                case .storedSend:    StoredSendDestination()
                case .storedReceive: StoredReceiveDestination()
                case .deviceInbox:   DeviceInboxDestination()
                case .account:       AccountDestination()
                }
            }
            // Stable and nonlocalized. The UI suite must observe the detail
            // surface itself, not mistake the identically titled sidebar row
            // for proof that a destination rendered. Keyed on the surface, so
            // a pairing-code deep link and a nearby session both prove the ONE
            // screen they actually land on.
            .accessibilityIdentifier("destination-\(navigation.selection.macSurface.rawValue)")
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
        // so what arrives here is one of exactly two shapes — and everything
        // that happens to it is the shared coordinator's. In particular this
        // file does not decide where the link goes, what it writes, or whether
        // it may overwrite a transfer that is running; that last one is the
        // whole reason the coordinator exists, and the inline version this
        // replaced never asked it at all.
        .onReceive(deepLinks.$pending.compactMap { $0 }) { link in
            deepLinkRouting.deliver(link)
            // Consumed one turn later, and BOTH halves of that are load-bearing.
            //
            // Deferred, because `@Published` emits in `willSet`: this handler
            // runs BEFORE the router has stored the link, so a `consume()` from
            // here is overwritten by the very assignment that delivered it —
            // leaving the router holding a link that `Published` then replays to
            // every NEW subscriber. On this platform that replay is not
            // hypothetical: this subscription is rebuilt each time the unique
            // window is closed and reopened from the menu bar, so an unconsumed
            // download link would resolve itself again on reopen.
            // `AppDeepLinkTests` pins that ordering on the router.
            //
            // And EXPECTED, because that deferral is real time: a second link
            // can land inside it, and a bare `consume()` would throw away a link
            // this subscription has never seen and `Published` will not re-emit.
            Task { @MainActor in deepLinks.consume(link) }
        }
        // Files the OS opened with this app. Structurally identical to the link
        // hand-off above, and for the identical reasons — this file forwards a
        // batch and consumes it one turn later, deciding nothing. Where the
        // files go is `AppFileOpenCoordinator`'s, and whether the addressed pane
        // may take them yet is that pane's own `busy`.
        //
        // The router's `pending` is the batch the OS gave; the coordinator's
        // `staged` is that batch addressed to a destination. Two objects rather
        // than one, so a batch that arrives while the window is closed is still
        // routed the moment this subscription is rebuilt.
        .onReceive(fileOpens.$pending.compactMap { $0 }) { urls in
            fileOpenRouting.deliver(urls)
            Task { @MainActor in fileOpens.consume(urls) }
        }
        // A session nobody asked for. `task(id:)` rather than `onChange`
        // because the window may have been closed when it started and rebuilt
        // while it is still running: `onChange` fires on a transition this view
        // tree never saw, `task(id:)` fires on the value it comes back to.
        .task(id: nearbyReceive.activeKind) {
            guard let kind = nearbyReceive.activeKind else { return }
            // Claim BEFORE navigating. Pairing-code and Nearby use the same
            // models, so a mistaken/stale publication must not move the user
            // away from a pairing session that already owns its surface.
            AppRouting.reconcileIncoming(kind,
                                         presence: presence,
                                         navigation: navigation)
        }
    }
}
