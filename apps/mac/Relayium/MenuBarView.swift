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
        // What background receive is actually doing. With the window closed this
        // is the only place it is visible, and "ready" has to be a claim the app
        // can back up — hence a state per case rather than one optimistic label.
        Text(receiveStatus)
        if receive.state == .paused {
            Button("Resume receiving from nearby devices") { discovery.resume() }
        } else {
            Button("Pause receiving from nearby devices") { discovery.pause() }
                .disabled(isReceiving)
        }
        Divider()
        // The window can be closed while the app keeps running, so this is the
        // only way back to it — including back to a session that arrived while
        // it was closed. Spec'd in "Menu-bar residency".
        Button(isReceiving ? "Open Relayium to see this transfer" : "Open Relayium") {
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

    private var isReceiving: Bool {
        if case .active = receive.state { return true }
        return false
    }

    /// Deliberately never says "ready" for a state that is not. A dropped socket
    /// says it is reconnecting, because during that gap this Mac genuinely
    /// cannot be reached and a user who is waiting for a file needs to know it
    /// is the app, not the sender.
    private var receiveStatus: String {
        switch receive.state {
        case .off:
            return "Nearby receiving: off"
        case .paused:
            return "Nearby receiving: paused"
        case .connecting:
            return "Nearby receiving: joining…"
        case .ready:
            return "Nearby receiving: ready"
        case .reconnecting:
            return "Nearby receiving: reconnecting…"
        case .active(.file):
            return "Receiving files from a nearby device…"
        case .active(.text):
            return "A nearby message session is open"
        }
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
