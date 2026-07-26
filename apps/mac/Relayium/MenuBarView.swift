import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct MenuBarView: View {
    @EnvironmentObject private var session: AccountSession
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        switch session.state {
        case let .ready(user, usage):
            Text(user.email)
            Text("\(usage.plan.name) — \(UsagePresentation.display(usage.traffic).usedText) used")
        default:
            Text("Not signed in")
        }
        Divider()
        // The R1-A acceptance signal, kept reachable: proves the Kit is linked and
        // both native cores initialized in the shipped bundle.
        Text("Core: \(sodiumReady() ? "ok" : "FAILED") · WebRTC: \(webrtcAvailable() ? "ok" : "FAILED")")
        Divider()
        Button("Quit Relayium") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }
}
