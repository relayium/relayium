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
    /// The two independent transfer modules. Held here because this is the one
    /// place that decides WHICH destination draws, and therefore the one place
    /// that hands each of them its own module. It renders neither itself.
    @EnvironmentObject private var modules: TransferModules
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

    /// Whether the sidebar is showing. View state: hiding it is a window
    /// arrangement, not a preference anything else reads.
    @State private var sidebarVisible = true
    /// Where AppKit put the traffic lights, so the drawn chrome lines up.
    @State private var controls = WindowControlsMetrics()

    var body: some View {
        // **A flat split rather than `NavigationSplitView`.** The reference is
        // a full-height 216pt sidebar in its own colour, flush with the window
        // edge, under the window's real traffic lights, beside a detail column
        // whose toolbar carries the title, a subtitle and the live status.
        // `NavigationSplitView` on current macOS draws an inset glass sidebar
        // and its own title, which is the system-default styling the owner
        // rejected; the routing below is unchanged.
        HStack(spacing: 0) {
            if sidebarVisible {
                SidebarView()
                    .frame(width: Metrics.sidebar)
                    .frame(maxHeight: .infinity)
                    .background(Palette.sidebar)
                Rectangle()
                    .fill(Palette.hairline)
                    .frame(width: 1)
                    .accessibilityHidden(true)
            }
            Group {
                // Switched on the SURFACE rather than on the destination.
                // `MacSurface` is where macOS says which screens exist and which
                // of them the sidebar offers, and `storedReceive` is the case
                // that proves it — it has an arm here and no row there.
                //
                // No `default`: a seventh macOS surface is a compile error here
                // rather than a sidebar row that opens nothing.
                switch navigation.selection.macSurface {
                // Each transfer destination is handed ONE module, by name, and
                // holds no way to reach the other.
                case .lanTransfer:          LanTransferDestination(module: modules.nearby)
                case .crossNetworkTransfer: CrossNetworkTransferDestination(module: modules.direct)
                case .storedSend:           StoredSendDestination()
                // Reachable, never browseable: a download link the OS handed
                // this app selects `.storedReceive`, and this arm draws it.
                case .storedReceive:        StoredReceiveDestination()
                case .deviceInbox:          DeviceInboxDestination()
                case .account:              AccountDestination()
                }
            }
            // Stable and nonlocalized. The UI suite must observe the detail
            // surface itself, not mistake the identically titled sidebar row
            // for proof that a destination rendered.
            .accessibilityIdentifier("destination-\(navigation.selection.macSurface.rawValue)")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Palette.pageBackground)
        }
        // Under the transparent title bar, so the sidebar colour and the
        // toolbar run to the window's top edge as they do in the reference.
        .ignoresSafeArea(.container, edges: .top)
        .foregroundStyle(Palette.text)
        .tint(Palette.action)
        .environment(\.shellChrome, ShellChrome(
            sidebarVisible: sidebarVisible,
            controls: controls,
            toggleSidebar: { sidebarVisible.toggle() }))
        .background(WindowChrome(metrics: $controls))
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
                    // The reference card, so the one transient panel the shell
                    // draws is the same kind of thing as every group below it.
                    .background(RoundedRectangle(cornerRadius: Metrics.corner)
                        .fill(Palette.cardBackground))
                    .overlay(RoundedRectangle(cornerRadius: Metrics.corner)
                        .strokeBorder(Palette.cardBorder, lineWidth: 1))
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
        // **No `activeKind` task.**
        //
        // It reconciled an unsolicited LEGACY same-network session onto the
        // Nearby module's surface — claim first, then navigate — for the case
        // where the window had been closed when the session started. There is no
        // such session to reconcile now: `RelayiumApp` refuses every legacy
        // inbound offer at `receive.shouldAcceptSession`, so `activeKind` cannot
        // become non-nil, and a task that could only ever no-op would still read
        // as a live route into a transport this build does not compose.
        //
        // An unsolicited `link/1` claims and navigates from
        // `LinkWorkspaceModel.shouldAcceptLink`, which is app-scoped and
        // therefore already survives the window being closed — the property this
        // task existed to provide.
    }
}
