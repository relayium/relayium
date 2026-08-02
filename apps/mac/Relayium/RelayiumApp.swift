import SwiftUI
import Sparkle
import RelayiumAppKit

/// Keeps the SwiftUI command enabled state in sync with Sparkle's updater.
///
/// `canCheckForUpdates` is KVO-backed rather than SwiftUI state, so reading it
/// directly from a button would leave the menu disabled state stale.
@MainActor
final class CheckForUpdatesViewModel: ObservableObject {
    @Published var canCheckForUpdates = false

    init(updater: SPUUpdater) {
        updater.publisher(for: \.canCheckForUpdates)
            .assign(to: &$canCheckForUpdates)
    }
}

struct CheckForUpdatesView: View {
    @ObservedObject private var model: CheckForUpdatesViewModel
    private let updater: SPUUpdater

    init(updater: SPUUpdater) {
        self.updater = updater
        model = CheckForUpdatesViewModel(updater: updater)
    }

    var body: some View {
        Button("Check for Updates…", action: updater.checkForUpdates)
            .disabled(!model.canCheckForUpdates)
    }
}

/// Refuses a silent exit while a transfer is running.
///
/// Deferring background `URLSession` to R3 means a transfer dies with the app.
/// That is a deliberate deferral, so this round owns its consequence rather than
/// letting a user discover it by losing an upload they watched for two minutes.
@MainActor
final class TransferQuitGuard: NSObject, NSApplicationDelegate {
    /// Set by the scene once the models exist. A closure rather than references
    /// so the delegate holds no opinion about what a transfer is.
    var isTransferRunning: (() -> Bool)?
    var cancelTransfers: (() -> Void)?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard isTransferRunning?() == true else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "A transfer is still running"
        alert.informativeText = "Quitting now cancels it. Nothing is saved, and an upload in progress will have to start over."
        alert.addButton(withTitle: "Cancel Transfer and Quit")
        alert.addButton(withTitle: "Keep Transferring")
        guard alert.runModal() == .alertFirstButtonReturn else { return .terminateCancel }
        cancelTransfers?()
        return .terminateNow
    }
}

@main
struct RelayiumApp: App {
    private let updaterController = SPUStandardUpdaterController(
        startingUpdater: true,
        updaterDelegate: nil,
        userDriverDelegate: nil
    )
    @NSApplicationDelegateAdaptor(TransferQuitGuard.self) private var quitGuard
    @StateObject private var session = AppEnvironment.makeSession()
    @StateObject private var deepLinks = AppDeepLinkRouter()
    // App-scoped rather than view-scoped: a transfer must survive the window's
    // view tree being rebuilt, and the quit guard has to be able to ask whether
    // one is running.
    @StateObject private var uploadModel: CloudUploadModel
    @StateObject private var downloadModel: CloudDownloadModel
    // One preference object shared by both realtime models and the UI that
    // toggles it, so a change applies to the next session of either kind
    // without a relaunch.
    @StateObject private var verification: VerificationPreference
    // One discovery model for the whole app: it owns a single room socket, and
    // both realtime models build their nearby connections on that same socket.
    @StateObject private var lanDiscovery: LanDiscoveryModel
    @StateObject private var realtimeModel: RealtimeSessionModel
    @StateObject private var realtimeTextModel: RealtimeTextSessionModel
    // Background receive and the notifications it needs are app-scoped for the
    // same reason the transfer models are: both have to outlive the window.
    @StateObject private var nearbyReceive: NearbyReceiveModel
    @StateObject private var notifications: TransferNotificationCenter

    @MainActor
    init() {
        // The models need the preference and the discovery model at
        // construction (they read both through closures), and a @StateObject
        // default value cannot reference another property — so all of them are
        // built here against one shared instance of each.
        let prefs = VerificationPreference()
        let nearby = AppEnvironment.makeLanDiscoveryModel()
        // Holds the exact socket an inbound attempt is being built on, so the
        // two models' inbound builders cannot reach for a room the offer never
        // came from. Owned by the receive model; the session models only read it.
        let inboundRoom = InboundRoom()
        let files = AppEnvironment.makeRealtimeModel(
            verification: prefs, nearby: nearby, inboundRoom: inboundRoom)
        let text = AppEnvironment.makeRealtimeTextModel(
            verification: prefs, nearby: nearby, inboundRoom: inboundRoom)
        let receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: files, textModel: text, discovery: nearby, inboundRoom: inboundRoom)
        let uploads = AppEnvironment.makeUploadModel()
        let downloads = AppEnvironment.makeDownloadModel()
        _verification = StateObject(wrappedValue: prefs)
        _lanDiscovery = StateObject(wrappedValue: nearby)
        _realtimeModel = StateObject(wrappedValue: files)
        _realtimeTextModel = StateObject(wrappedValue: text)
        _nearbyReceive = StateObject(wrappedValue: receive)
        _uploadModel = StateObject(wrappedValue: uploads)
        _downloadModel = StateObject(wrappedValue: downloads)
        _notifications = StateObject(wrappedValue: TransferNotificationCenter(
            uploadModel: uploads,
            downloadModel: downloads,
            fileModel: files,
            textModel: text,
            receiveModel: receive))
    }

    var body: some Scene {
        // Identified so the menu bar can reopen it: closing the last window does
        // not quit the app (the MenuBarExtra keeps it running), so without an id
        // there is no way back to the UI short of quitting and relaunching.
        WindowGroup(id: "main") {
            ContentView()
                .environmentObject(session)
                .environmentObject(deepLinks)
                .environmentObject(uploadModel)
                .environmentObject(downloadModel)
                .environmentObject(realtimeModel)
                .environmentObject(realtimeTextModel)
                .environmentObject(verification)
                .environmentObject(lanDiscovery)
                .environmentObject(nearbyReceive)
                .task { await session.restore() }
                .task {
                    // Both idempotent, and both app-scoped rather than
                    // window-scoped: residency is what makes this Mac reachable,
                    // and it outlives every window (MenuBarExtra keeps the
                    // process up). A second window must not reopen the room
                    // socket, and must never override an explicit pause.
                    notifications.start()
                    lanDiscovery.startResident()
                }
                .task {
                    // Wired here rather than at init: the delegate is created by
                    // the adaptor before the StateObjects exist.
                    quitGuard.isTransferRunning = {
                        uploadModel.isBusy || downloadModel.isBusy
                            || realtimeModel.isBusy || realtimeTextModel.isBusy
                    }
                    quitGuard.cancelTransfers = {
                        uploadModel.cancel()
                        downloadModel.cancel()
                        realtimeModel.cancel()
                        realtimeTextModel.end()
                    }
                }
                .onOpenURL { deepLinks.open($0) }
        }
        .defaultSize(width: 420, height: 460)
        .commands {
            CommandGroup(after: .appInfo) {
                CheckForUpdatesView(updater: updaterController.updater)
            }
        }

        // Residency. This is the surface the persistent room socket reports
        // through: with the window closed it is the only place the user can see
        // whether this Mac is actually able to receive, and the only way back to
        // the app.
        MenuBarExtra("Relayium", systemImage: "paperplane") {
            MenuBarView()
                .environmentObject(session)
                .environmentObject(nearbyReceive)
                .environmentObject(lanDiscovery)
        }
    }
}
