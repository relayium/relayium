import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **What the iOS Device Inbox is that the macOS one is not**: foreground-only,
/// receiving into a fixed container folder, and composing under an account that
/// can leave at any moment.
///
/// Everything the two platforms share is already driven by `InboxControllerTests`
/// against the real engine, key store, sealed box, commit and journal. What is
/// here is only the iOS half, and every test is adversarial about the case that
/// actually loses data or leaks it across an account boundary.
@MainActor
final class IOSInboxReceiveTests: XCTestCase {

    private let accountA = try! InboxAccountID("accountiosaaa01")
    private let accountB = try! InboxAccountID("accountiosbbb02")

    // MARK: - the fixed container folder

    /// A test double for the container: a real directory this process owns, with
    /// no security scope, exactly as `Documents/Received` behaves on device.
    private func containerFolder(at root: URL,
                                 base: InboxFolderStoring = InMemoryInboxFolderStore())
        -> (folder: InboxReceiveFolder, store: ContainerInboxFolderStore) {
        let store = ContainerInboxFolderStore(base: base)
        let bookmarking = ContainerInboxFolderBookmarking(directory: { root })
        return (InboxReceiveFolder(store: store, bookmarking: bookmarking), store)
    }

    private func temporaryDirectory() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-ios-inbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    /// **The whole reason this seam exists.**
    ///
    /// `SystemInboxFolderBookmarking` already falls back to a plain bookmark on
    /// iOS, and a plain bookmark's URL answers
    /// `startAccessingSecurityScopedResource()` with false — which
    /// `InboxReceiveFolder.open` reports as `.unavailable(.accessDenied)`. The
    /// receiver would claim a permission failure on a directory the app owns
    /// outright, and no control on the screen could repair it. This asserts the
    /// container seam produces a usable folder instead.
    func testTheContainerFolderIsUsableWithNoSecurityScope() throws {
        let root = try temporaryDirectory()
        let (folder, _) = containerFolder(at: root)

        XCTAssertTrue(folder.hasFolder(account: accountA),
                      "the container folder must exist for every account without being chosen")
        let opened = folder.open(account: accountA)
        XCTAssertEqual(opened.state, .usable(root))
        XCTAssertNotNil(opened.access)
        opened.access?.release()
        XCTAssertEqual(folder.inspect(account: accountA), .usable(root))
    }

    /// The marker is never parsed, so nothing stored can redirect a delivery.
    ///
    /// A forged, truncated or stale value resolves to the same container
    /// directory, because `resolve` ignores its argument and asks the container
    /// again. That is the property that makes storing a fixed marker safe where
    /// storing a container path would not be — the OS reassigns that path
    /// between installs.
    func testStoredBookmarkBytesCannotRedirectADelivery() throws {
        let root = try temporaryDirectory()
        let elsewhere = try temporaryDirectory()
        let bookmarking = ContainerInboxFolderBookmarking(directory: { root })

        for forged in [Data(), Data("file://\(elsewhere.path)".utf8),
                       Data(repeating: 0xFF, count: 64)] {
            let resolved = try bookmarking.resolve(forged)
            XCTAssertEqual(resolved.url, root,
                           "stored bytes steered a delivery away from the container")
            XCTAssertFalse(resolved.isStale)
        }
        // And a scope is never actually opened, so nothing has to be balanced.
        XCTAssertTrue(bookmarking.startAccess(to: root))
        bookmarking.stopAccess(to: root)
    }

    /// **The receiving consent survives; the folder grant cannot be given up.**
    ///
    /// `forget` clears both on macOS, and `removeFolder()` is what calls it.
    /// There is no such control on iOS and there is no second folder to move to,
    /// so a bookmark that could be cleared would leave the inbox permanently in
    /// `folderMissing` with nothing on screen able to repair it. The policy half
    /// still goes through, because "receiving is off" is the meaningful part of
    /// that method when the folder cannot be surrendered.
    func testTheFixedFolderCannotBeRemovedButTheConsentStillCanBe() throws {
        let root = try temporaryDirectory()
        let (folder, store) = containerFolder(at: root)
        try folder.setReceivePolicy(.auto, account: accountA)
        XCTAssertEqual(folder.receivePolicy(account: accountA), .auto)

        folder.forget(account: accountA)
        XCTAssertTrue(folder.hasFolder(account: accountA),
                      "the container grant was surrendered; nothing could restore it")
        XCTAssertEqual(folder.receivePolicy(account: accountA), .off,
                       "signing out left a stored yes waiting for the next account")
        // Even a direct write cannot clear it.
        store.setBookmarkData(nil, account: accountA)
        XCTAssertNotNil(store.bookmarkData(account: accountA))
    }

    /// The consent is per account and default-off, exactly as on macOS.
    ///
    /// A fixed destination removes the folder question. It does not remove the
    /// permission one: letting the account's other devices write here unattended
    /// is still a decision the user makes, and it must not carry across a switch.
    func testTheReceivingConsentIsPerAccountAndDefaultOff() throws {
        let root = try temporaryDirectory()
        let (folder, _) = containerFolder(at: root)
        XCTAssertEqual(folder.receivePolicy(account: accountA), .off)
        XCTAssertEqual(folder.receivePolicy(account: accountB), .off)

        try folder.setReceivePolicy(.auto, account: accountA)
        XCTAssertEqual(folder.receivePolicy(account: accountA), .auto)
        XCTAssertEqual(folder.receivePolicy(account: accountB), .off,
                       "one account's consent to unattended writes reached another's")
    }

    /// A directory that is gone is re-created; something that is not a directory
    /// in its place is refused rather than removed.
    ///
    /// The user can delete the Received folder in the Files app between two
    /// passes, and they can also put a FILE there. The first is repaired
    /// silently; the second is reported, because whatever is there belongs to
    /// them and this is not the code that gets to decide it is disposable.
    func testTheContainerFolderIsRecreatedButNeverOverwrites() throws {
        let documents = try temporaryDirectory()
        let received = documents.appendingPathComponent(ReceiveDestination.folderName,
                                                        isDirectory: true)
        let bookmarking = ContainerInboxFolderBookmarking(directory: {
            try ReceiveDestination.directory(inDocuments: documents)
        })
        // Missing → created.
        XCTAssertEqual(try bookmarking.resolve(Data()).url.standardizedFileURL,
                       received.standardizedFileURL)
        // Deleted between passes → created again.
        try FileManager.default.removeItem(at: received)
        XCTAssertEqual(try bookmarking.resolve(Data()).url.standardizedFileURL,
                       received.standardizedFileURL)
        // Occupied by a file → refused, and the file is untouched.
        try FileManager.default.removeItem(at: received)
        try Data("mine".utf8).write(to: received)
        XCTAssertThrowsError(try bookmarking.resolve(Data())) { error in
            XCTAssertEqual(error as? DownloadDestinationError,
                           .fileExists(name: ReceiveDestination.folderName))
        }
        XCTAssertEqual(try Data(contentsOf: received), Data("mine".utf8),
                       "the receiver deleted something the user put there")

        // And the folder the receiver uses is the SAME one a stored-link
        // download writes into — one Received folder in the Files app, not two.
        try FileManager.default.removeItem(at: received)
        XCTAssertEqual(try ReceiveDestination.directory(inDocuments: documents)
                        .standardizedFileURL,
                       try bookmarking.resolve(Data()).url.standardizedFileURL)
    }

    // MARK: - foreground only

    /// A minimal controller: no network, no engine, just the loop and the seams
    /// the lifecycle touches.
    ///
    /// The engine factory throws, so nothing can claim; what is under test is
    /// whether the loop RUNS at all, which is what the foreground gate decides.
    private func makeController(folder: InboxReceiveFolder,
                                sleeper: ManualInboxSleeper,
                                engineStarts: EngineCounter) -> InboxController {
        InboxController(runtime: InboxRuntime(
            folder: folder,
            makeEngine: { _, _ in
                engineStarts.bump()
                throw InboxError.network
            },
            sleeper: sleeper,
            platform: AppEnvironment.iosInboxPlatform,
            capabilities: InboxProtocol.announcedCapabilities(presentingText: true),
            appVersion: "test",
            backoff: InboxBackoff(idle: 30, afterWork: 2, first: 5, cap: 300, blocked: 60)))
    }

    final class EngineCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func bump() { lock.lock(); value += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    /// **Leaving the app stops the loop; coming back restarts it.**
    ///
    /// The receiver is foreground-only and the app declares no background mode,
    /// no push and no notification. What must not happen is a pass that the
    /// system is about to suspend continuing to look live — or, worse, a claim
    /// being taken while the user is elsewhere.
    func testLeavingTheForegroundStopsTheLoopAndReturningRestartsIt() async throws {
        let root = try temporaryDirectory()
        let (folder, _) = containerFolder(at: root)
        try folder.setReceivePolicy(.auto, account: accountA)
        let sleeper = ManualInboxSleeper()
        let starts = EngineCounter()
        let controller = makeController(folder: folder, sleeper: sleeper, engineStarts: starts)

        controller.session(InboxAccountIdentity(accountID: accountA.value, bearer: "bearer-a"))
        await waitUntil({ starts.count >= 1 }, "the receiver never started in the foreground")

        controller.foreground(false)
        XCTAssertFalse(controller.isForeground)
        let afterLeaving = starts.count
        // Let the stopped loop have every chance to take another pass.
        sleeper.wake()
        await settle(40)
        XCTAssertEqual(starts.count, afterLeaving,
                       "the receiver kept working after the app left the foreground")

        controller.foreground(true)
        XCTAssertTrue(controller.isForeground)
        // Checked SYNCHRONOUSLY, before the loop has run again: the first frame
        // after returning must be honest about having stopped rather than
        // showing a state left over from before the app went away.
        // `restart()` republishes it in the same turn, which is why this is not
        // a race — and asserting it after an await would only ever observe
        // whatever the resumed loop had reached by then.
        XCTAssertEqual(controller.state, .loading,
                       "returning to the foreground kept a state from before leaving")
        await waitUntil({ starts.count > afterLeaving },
                        "the receiver never resumed when the app came back")
        controller.signedOut()
    }

    /// `.inactive` is **not** background, and the gate must never be told it is.
    ///
    /// A document picker, Control Centre, the app switcher and a call banner all
    /// produce `.inactive` while the app is still visible. Treating any of them
    /// as background would cancel a delivery the user can see, several times a
    /// session, and read as the feature being broken. This asserts the mapping
    /// the app applies, over every phase.
    func testInactiveIsNotBackgroundForTheReceiver() async throws {
        let root = try temporaryDirectory()
        let (folder, _) = containerFolder(at: root)
        try folder.setReceivePolicy(.auto, account: accountA)
        let sleeper = ManualInboxSleeper()
        let starts = EngineCounter()
        let controller = makeController(folder: folder, sleeper: sleeper, engineStarts: starts)
        controller.session(InboxAccountIdentity(accountID: accountA.value, bearer: "bearer-a"))
        await waitUntil({ starts.count >= 1 }, "the receiver never started")

        // The app's own mapping, applied to all three phases: only `.background`
        // closes the gate. Listed rather than derived from `allCases`, because
        // `AppLifecyclePhase` deliberately has none — its three cases are a
        // decision, and a fourth must be a decision here too.
        for phase in [AppLifecyclePhase.active, .inactive, .background] {
            controller.foreground(phase != .background)
            XCTAssertEqual(controller.isForeground, phase != .background,
                           "\(phase) was treated as the wrong side of the foreground gate")
        }
        controller.foreground(true)
        XCTAssertTrue(controller.isForeground,
                      "an inactive app must keep receiving; it is still on screen")
        // The claim stated positively: going inactive is not a restart, so the
        // loop that was running before it is the one running after. Settled
        // first, because the `foreground(true)` above genuinely does restart —
        // it follows a `.background` in the sweep — and sampling before that
        // restart had run would measure it here instead.
        await settle(20)
        let beforeInactive = starts.count
        controller.foreground(AppLifecyclePhase.inactive != .background)
        await settle(20)
        XCTAssertEqual(starts.count, beforeInactive,
                       "going inactive restarted the receiver, cancelling a live delivery")
        controller.signedOut()
    }

    /// **An account switch that lands while the app is in the background must
    /// not start claiming for the new account.**
    ///
    /// This is the hole the seam alone does not cover: `foreground(false)` stops
    /// the loop that is running, but `session(_:)` with a new identity calls
    /// `start`, and `start` builds a new loop unconditionally. The gate is
    /// therefore checked inside the loop as well, and this is the test that
    /// fails if that check is removed.
    func testAnAccountSwitchInTheBackgroundStartsNoWork() async throws {
        let root = try temporaryDirectory()
        let (folder, _) = containerFolder(at: root)
        try folder.setReceivePolicy(.auto, account: accountA)
        try folder.setReceivePolicy(.auto, account: accountB)
        let sleeper = ManualInboxSleeper()
        let starts = EngineCounter()
        let controller = makeController(folder: folder, sleeper: sleeper, engineStarts: starts)

        controller.session(InboxAccountIdentity(accountID: accountA.value, bearer: "bearer-a"))
        await waitUntil({ starts.count >= 1 }, "the receiver never started")
        controller.foreground(false)
        let afterLeaving = starts.count

        // The switch lands with the app away.
        controller.session(InboxAccountIdentity(accountID: accountB.value, bearer: "bearer-b"))
        sleeper.wake()
        await settle(40)
        XCTAssertEqual(starts.count, afterLeaving,
                       "a background account switch started claiming for the new account")
        XCTAssertEqual(controller.activeAccountID, accountB.value,
                       "the new account was not adopted at all")

        controller.foreground(true)
        await waitUntil({ starts.count > afterLeaving },
                        "the new account never started once the app returned")
        controller.signedOut()
    }

    /// The lifecycle may not manufacture a generation.
    ///
    /// `session(_:)` is what starts one. A `foreground(true)` on a signed-out
    /// controller that began receiving would be the receiver running with no
    /// account at all.
    func testTheForegroundGateCannotStartAReceiverWithNoAccount() async throws {
        let root = try temporaryDirectory()
        let (folder, _) = containerFolder(at: root)
        try folder.setReceivePolicy(.auto, account: accountA)
        let sleeper = ManualInboxSleeper()
        let starts = EngineCounter()
        let controller = makeController(folder: folder, sleeper: sleeper, engineStarts: starts)

        controller.foreground(false)
        controller.foreground(true)
        await settle(20)
        XCTAssertEqual(starts.count, 0, "a lifecycle event started a receiver with no account")
        XCTAssertEqual(controller.state, .signedOut)
    }

    /// The user's own pause outranks a trip to the home screen.
    ///
    /// `pause()` is sticky and renders as *Paused*; the foreground gate is
    /// neither. Returning from the background must not clear a pause the user
    /// set — which is exactly what reusing `resume()` for the lifecycle would
    /// have done.
    func testReturningToTheForegroundDoesNotClearTheUsersOwnPause() async throws {
        let root = try temporaryDirectory()
        let (folder, _) = containerFolder(at: root)
        try folder.setReceivePolicy(.auto, account: accountA)
        let sleeper = ManualInboxSleeper()
        let starts = EngineCounter()
        let controller = makeController(folder: folder, sleeper: sleeper, engineStarts: starts)
        controller.session(InboxAccountIdentity(accountID: accountA.value, bearer: "bearer-a"))
        await waitUntil({ starts.count >= 1 }, "the receiver never started")

        controller.pause()
        XCTAssertTrue(controller.isPaused)
        controller.foreground(false)
        controller.foreground(true)
        await settle(20)
        XCTAssertTrue(controller.isPaused, "a trip to the home screen cleared the user's pause")
        XCTAssertEqual(controller.state, .paused,
                       "the status stopped saying the user had paused")
        controller.signedOut()
    }

    /// macOS is untouched: nothing there ever calls the gate, so its resident
    /// receiver keeps working with the window closed.
    func testTheGateDefaultsOpenSoTheResidentMacReceiverIsUnaffected() throws {
        let root = try temporaryDirectory()
        let (folder, _) = containerFolder(at: root)
        let controller = makeController(folder: folder, sleeper: ManualInboxSleeper(),
                                        engineStarts: EngineCounter())
        XCTAssertTrue(controller.isForeground,
                      "a platform that never calls the gate must not be gated by it")
    }

    // MARK: - what this build announces

    /// The platform token and the capability set are this device's own.
    ///
    /// The token is read by a person choosing where to send a file, and the
    /// capability is a claim about a SCREEN: `inbox.text.v1` says this build
    /// presents a received message, which it does — the conversation timeline —
    /// so announcing it is honest rather than optimistic.
    func testTheIOSBuildAnnouncesItselfAsIOSAndAsPresentingText() {
        XCTAssertEqual(AppEnvironment.iosInboxPlatform, "ios")
        XCTAssertNotEqual(AppEnvironment.iosInboxPlatform, AppEnvironment.inboxPlatform,
                          "a Mac and a phone must be tellable apart in the device list")
        let announced = InboxProtocol.announcedCapabilities(presentingText: true)
        XCTAssertTrue(announced.contains(InboxCapability.textV1),
                      "the timeline presents received messages and must say so")
        for base in InboxProtocol.capabilities {
            XCTAssertTrue(announced.contains(base))
        }
    }

    /// A build that cannot name its own version says so, and never says nothing.
    func testTheAnnouncedVersionIsNeverBlank() {
        XCTAssertEqual(AppEnvironment.appVersion(Bundle(for: Self.self)), "—",
                       "a bundle with no version must announce the placeholder")
        XCTAssertFalse(AppEnvironment.appVersion().isEmpty)
    }

    // MARK: - helpers

    private func settle(_ turns: Int = 8) async {
        for _ in 0..<turns { await Task.yield() }
    }

    private func waitUntil(_ condition: @escaping () -> Bool, _ message: String,
                           file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<3000 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail(message, file: file, line: line)
    }
}
