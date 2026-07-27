import SwiftUI
import RelayiumAppKit

@main
struct RelayiumApp: App {
    @StateObject private var session = AppEnvironment.makeSession()
    // App-scoped rather than view-scoped: a transfer must survive the window's
    // view tree being rebuilt, and the quit guard has to be able to ask whether
    // one is running.
    @StateObject private var uploadModel = AppEnvironment.makeUploadModel()
    @StateObject private var downloadModel = AppEnvironment.makeDownloadModel()

    var body: some Scene {
        // Identified so the menu bar can reopen it: closing the last window does
        // not quit the app (the MenuBarExtra keeps it running), so without an id
        // there is no way back to the UI short of quitting and relaunching.
        WindowGroup(id: "main") {
            ContentView()
                .environmentObject(session)
                .environmentObject(uploadModel)
                .environmentObject(downloadModel)
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
