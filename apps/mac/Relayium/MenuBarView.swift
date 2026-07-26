import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct MenuBarView: View {
    @EnvironmentObject private var session: AccountSession
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        // Every state named: a `default:` here claimed "Not signed in" while a
        // token was in hand and the account was merely loading or unreachable,
        // which is the one moment the menu bar is the only surface the user has.
        switch session.state {
        case let .ready(user, usage):
            Text(user.email)
            Text("\(usage.plan.name) — \(UsagePresentation.display(usage.traffic).usedText) used")
        case .restoring:
            Text("Loading your account…")
        case .authenticating:
            Text("Signing in…")
        case .unavailable:
            Text("Signed in — can't reach the server")
        case let .emailUnverified(email):
            Text("\(email) — email not verified")
        case .pendingDeletion:
            Text("Account scheduled for deletion")
        case .loggedOut, .failed:
            Text("Not signed in")
        }
        Divider()
        // The window can be closed while the app keeps running, so this is the
        // only way back to it. Spec'd in "Menu-bar residency".
        Button("Open Relayium") {
            activateApp()
            openWindow(id: "main")
        }
        Divider()
        // The R1-A acceptance signal, kept reachable: proves the Kit is linked and
        // both native cores initialized in the shipped bundle.
        Text("Core: \(sodiumReady() ? "ok" : "FAILED") · WebRTC: \(webrtcAvailable() ? "ok" : "FAILED")")
        Divider()
        Button("Quit Relayium") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
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

    @available(macOS, deprecated: 14.0, message: "Only reachable on macOS 13.")
    private func activateAppLegacy() {
        NSApp.activate(ignoringOtherApps: true)
    }
}
