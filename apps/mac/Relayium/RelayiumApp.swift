import SwiftUI
import RelayiumAppKit

@main
struct RelayiumApp: App {
    @StateObject private var session = AppEnvironment.makeSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(session)
                .task { await session.restore() }
        }
        .defaultSize(width: 420, height: 460)

        // Residency. In G1 this shows connection-independent state only; it exists
        // now so G3's persistent signaling socket has a home that does not require
        // restructuring the app around it later.
        MenuBarExtra("Relayium", systemImage: "paperplane") {
            MenuBarView().environmentObject(session)
        }
    }
}
