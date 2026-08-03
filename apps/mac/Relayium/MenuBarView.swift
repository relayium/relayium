import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct MenuBarView: View {
    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var receive: NearbyReceiveModel
    @EnvironmentObject private var discovery: LanDiscoveryModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        // Every state named: a `default:` here claimed "Not signed in" while a
        // token was in hand and the account was merely loading or unreachable,
        // which is the one moment the menu bar is the only surface the user has.
        switch session.state {
        case let .ready(user, usage):
            // The email and the plan name are the account's own data, never
            // translated — only the sentence around them is.
            Text(user.email)
            Text(L10n.t(.menubarPlanUsage,
                        [L10n.token(usage.plan.name),
                         UsagePresentation.display(usage.traffic).usedText]))
        case .restoring:
            Text(L10n.t(.menubarLoadingAccount))
        case .authenticating:
            Text(L10n.t(.menubarSigningIn))
        case .unavailable:
            Text(L10n.t(.menubarSignedInUnreachable))
        case let .emailUnverified(email):
            Text(L10n.t(.menubarEmailUnverified, [L10n.token(email)]))
        case .pendingDeletion:
            Text(L10n.t(.menubarPendingDeletion))
        case .loggedOut, .failed:
            Text(L10n.t(.menubarNotSignedIn))
        }
        Divider()
        // What background receive is actually doing. With the window closed this
        // is the only place it is visible, and "ready" has to be a claim the app
        // can back up — hence a state per case rather than one optimistic label.
        Text(NearbyStatusPresentation.text(for: receive.state))
        if receive.state == .paused {
            Button(L10n.t(.menubarResumeNearby)) { discovery.resume() }
        } else {
            Button(L10n.t(.menubarPauseNearby)) { discovery.pause() }
                .disabled(isReceiving)
        }
        Divider()
        // The window can be closed while the app keeps running, so this is the
        // only way back to it — including back to a session that arrived while
        // it was closed. Spec'd in "Menu-bar residency".
        Button(L10n.t(isReceiving ? .menubarOpenToSeeTransfer : .menubarOpen)) {
            activateApp()
            openWindow(id: "main")
        }
        Divider()
        // The R1-A acceptance signal, kept reachable: proves the Kit is linked and
        // both native cores initialized in the shipped bundle. `ok`/`FAILED` are
        // diagnostic tokens a bug report quotes verbatim, so only the sentence
        // around them is localized. nonlocalized: build diagnostic tokens.
        Text(L10n.t(.menubarCoreStatus, [
            L10n.token(sodiumReady() ? "ok" : "FAILED"),
            L10n.token(webrtcAvailable() ? "ok" : "FAILED"),
        ]))
        Divider()
        Button(L10n.t(.menubarQuit)) { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var isReceiving: Bool {
        if case .active = receive.state { return true }
        return false
    }

    /// Clicking a menu-bar item does not bring the app forward, so the reopened
    /// window would otherwise appear behind whatever the user was using.
    ///
    /// `NSApp.activate()` is macOS 14+ and this app deploys to 13.0, so the older
    /// call is still needed — and it is deprecated in 14, which would warn. Putting
    /// it in a declaration that is itself marked deprecated is what silences that
    /// without silencing anything else.
    private func activateApp() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            activateAppLegacy()
        }
    }

    // nonlocalized: compiler diagnostic, never rendered
    @available(macOS, deprecated: 14.0, message: "Only reachable on macOS 13.")
    private func activateAppLegacy() {
        NSApp.activate(ignoringOtherApps: true)
    }
}
