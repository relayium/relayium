import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The controller half of the denied-banner repair: what a denied Mac is allowed
/// to change, what it must NOT change, and what pressing the recovery does.
///
/// The two platform calls are substituted — asking `UNUserNotificationCenter` for
/// its status and asking `NSWorkspace` to open System Settings — because neither
/// can be driven from a test process. Everything between them is the shipped
/// code: the published permission, the refusal, and the rule that none of this
/// touches what the inbox IS.
@MainActor
final class InboxNotificationRecoveryTests: XCTestCase {

    private let account = try! InboxAccountID("accountnotify01")

    /// The platform, answering however the test tells it to.
    private final class Platform: @unchecked Sendable {
        private let lock = NSLock()
        private var _answer: InboxNotificationPermission = .unmeasured
        private var _opens = true
        private var _refreshes = 0
        private var _opened = 0

        var answer: InboxNotificationPermission {
            get { lock.lock(); defer { lock.unlock() }; return _answer }
            set { lock.lock(); _answer = newValue; lock.unlock() }
        }
        var opens: Bool {
            get { lock.lock(); defer { lock.unlock() }; return _opens }
            set { lock.lock(); _opens = newValue; lock.unlock() }
        }
        var refreshes: Int { lock.lock(); defer { lock.unlock() }; return _refreshes }
        var opened: Int { lock.lock(); defer { lock.unlock() }; return _opened }

        func countRefresh() { lock.lock(); _refreshes += 1; lock.unlock() }
        func countOpen() -> Bool {
            lock.lock(); defer { lock.unlock() }
            _opened += 1
            return _opens
        }
    }

    private struct Harness {
        let platform: Platform
        let store: InMemoryInboxFolderStore
        let controller: InboxController
    }

    /// A controller with the two seams wired and nothing else running.
    ///
    /// `makeEngine` throws on purpose: none of these tests is about a pass, and a
    /// generation whose engine never builds still exercises every published
    /// property and every user control below. The sleeper is manual so the loop
    /// parks instead of spinning while the assertions run.
    private func makeHarness() -> Harness {
        let platform = Platform()
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store)
        let controllerBox = ControllerBox()
        let controller = InboxController(runtime: InboxRuntime(
            folder: folder,
            makeEngine: { _, _ in throw InboxError.network },
            sleeper: ManualInboxSleeper(),
            // Strong on the box, weak on the controller inside it — the same
            // direction the shipped seam uses, and for the same reason: the
            // controller owns this closure, so a closure that held the controller
            // would never let it go, while a weakly held box is deallocated the
            // instant this factory returns.
            refreshNotificationPermission: {
                platform.countRefresh()
                let next = platform.answer
                Task { @MainActor in
                    controllerBox.controller?.updateNotificationPermission(next)
                }
            },
            openNotificationSettings: { platform.countOpen() },
            platform: "macos", appVersion: "test",
            backoff: InboxBackoff(idle: 30, afterWork: 2, first: 5, cap: 300, blocked: 60)))
        controllerBox.controller = controller
        return Harness(platform: platform, store: store, controller: controller)
    }

    @MainActor
    private final class ControllerBox {
        weak var controller: InboxController?
    }

    /// Let the seam's main-actor hop land.
    private func settle() async {
        for _ in 0..<5 { await Task.yield() }
    }

    // MARK: - measuring

    /// Nothing claims anything before the platform has answered.
    ///
    /// The starting value is the one every launch is in for the interval between
    /// the pane appearing and `getNotificationSettings` returning, and a warning
    /// rendered there would be shown to every user on every open.
    func testAFreshControllerHasNotMeasuredNotificationAuthorization() {
        let harness = makeHarness()
        XCTAssertEqual(harness.controller.notificationPermission, .unmeasured)
        XCTAssertNil(InboxNotificationPermissionPresentation
            .notice(for: harness.controller.notificationPermission))
    }

    /// A refresh reaches the platform, and the platform's answer reaches the
    /// published property the pane renders.
    func testRefreshingAsksThePlatformAndPublishesWhatItSays() async {
        let harness = makeHarness()
        harness.platform.answer = .denied
        harness.controller.refreshNotificationPermission()
        await settle()
        XCTAssertEqual(harness.platform.refreshes, 1)
        XCTAssertEqual(harness.controller.notificationPermission, .denied)
        XCTAssertNotNil(InboxNotificationPermissionPresentation
            .notice(for: harness.controller.notificationPermission),
                        "a denied Mac still renders nothing")
    }

    /// **The surface follows the switch in System Settings.**
    ///
    /// macOS publishes no notification when authorization changes, so re-asking is
    /// the entire mechanism. This drives the journey the pane is built around: the
    /// warning appears, the user changes the setting elsewhere, the app asks
    /// again, and the warning goes away on its own.
    func testTheWarningClearsOnceAuthorizationIsGrantedElsewhere() async {
        let harness = makeHarness()
        harness.platform.answer = .denied
        harness.controller.refreshNotificationPermission()
        await settle()
        XCTAssertTrue(harness.controller.notificationPermission.needsAttention)

        harness.platform.answer = .allowed
        harness.controller.refreshNotificationPermission()
        await settle()
        XCTAssertEqual(harness.controller.notificationPermission, .allowed)
        XCTAssertNil(InboxNotificationPermissionPresentation
            .notice(for: harness.controller.notificationPermission),
                     "the warning survived the user allowing notifications")
    }

    /// And back again. A user who switches notifications off later is told, rather
    /// than keeping a stale "everything is fine" from the first measurement.
    func testRevokingAuthorizationLaterBringsTheWarningBack() async {
        let harness = makeHarness()
        harness.platform.answer = .allowed
        harness.controller.refreshNotificationPermission()
        await settle()
        harness.platform.answer = .denied
        harness.controller.refreshNotificationPermission()
        await settle()
        XCTAssertEqual(harness.controller.notificationPermission, .denied)
    }

    // MARK: - the boundary that matters

    /// **A denied Mac still receives, and nothing about the inbox changes.**
    ///
    /// The single most important property in this batch. Notification
    /// authorization is a separate axis from what the inbox can do, so measuring
    /// it — in either direction — must leave the runtime state, the policy, the
    /// folder, the pause and the result list exactly as they were. A repair that
    /// quietly stopped the receiver, or that pushed the status line into
    /// `attention`, would have replaced a missing banner with a broken product.
    func testMeasuringNotificationAuthorizationChangesNothingAboutReceiving() async {
        let harness = makeHarness()
        harness.controller.session(InboxAccountIdentity(accountID: account.value,
                                                        bearer: "bearer-notify"))
        await settle()
        let stateBefore = harness.controller.state
        let policyBefore = harness.controller.policy
        let pausedBefore = harness.controller.isPaused
        let resultsBefore = harness.controller.results.count

        for answer in [InboxNotificationPermission.denied, .allowed, .denied] {
            harness.platform.answer = answer
            harness.controller.refreshNotificationPermission()
            await settle()
            XCTAssertEqual(harness.controller.state, stateBefore,
                           "\(answer.rawValue) changed what the inbox reports it can do")
            XCTAssertEqual(harness.controller.policy, policyBefore)
            XCTAssertEqual(harness.controller.isPaused, pausedBefore)
            XCTAssertEqual(harness.controller.results.count, resultsBefore)
        }
    }

    /// The runtime state has no notification arm at all, and cannot grow one by
    /// accident.
    ///
    /// Asserted as a property rather than as prose because the tempting shortcut —
    /// reusing `.attention` for this — is exactly what would make the status line
    /// say the inbox needs fixing while every delivery is landing correctly.
    func testNoRuntimeStateIsProducedForABlockedBanner() async {
        let harness = makeHarness()
        harness.platform.answer = .denied
        harness.controller.refreshNotificationPermission()
        await settle()
        if case .attention = harness.controller.state {
            XCTFail("a blocked banner was reported as an inbox attention state")
        }
        if case .failed = harness.controller.state {
            XCTFail("a blocked banner was reported as a terminal inbox failure")
        }
    }

    /// **Signing out does not forget it.**
    ///
    /// Everything `reset()` clears belongs to one account. This belongs to the app
    /// and to this Mac: the same person signing back in has the same blocked
    /// banners, and blanking the warning at that moment would hide a true problem
    /// precisely when a new generation starts announcing deliveries.
    func testSigningOutAndBackInKeepsTheMeasuredAuthorization() async {
        let harness = makeHarness()
        harness.platform.answer = .denied
        harness.controller.session(InboxAccountIdentity(accountID: account.value,
                                                        bearer: "bearer-notify"))
        harness.controller.refreshNotificationPermission()
        await settle()
        XCTAssertEqual(harness.controller.notificationPermission, .denied)

        harness.controller.signedOut()
        await settle()
        XCTAssertEqual(harness.controller.notificationPermission, .denied,
                       "signing out blanked a system permission it does not own")

        harness.controller.session(InboxAccountIdentity(accountID: "accountnotify02",
                                                        bearer: "bearer-other"))
        await settle()
        XCTAssertEqual(harness.controller.notificationPermission, .denied,
                       "switching account blanked a system permission it does not own")
    }

    // MARK: - the recovery

    /// Pressing the action reaches the platform, and a platform that accepts it
    /// leaves no error behind.
    func testOpeningNotificationSettingsReachesThePlatform() {
        let harness = makeHarness()
        harness.platform.opens = true
        harness.controller.openNotificationSettings()
        XCTAssertEqual(harness.platform.opened, 1)
        XCTAssertNil(harness.controller.settingsError)
    }

    /// **A recovery that cannot run says so.**
    ///
    /// The defect this batch was opened for was a silent discard, and the batch
    /// before it fixed a recovery button whose action was a `break`. A button that
    /// reports nothing when the platform refuses it is the same failure a third
    /// time, so the refusal is published as its own message.
    func testAPlatformThatWillNotOpenItsSettingsIsReportedRatherThanSwallowed() {
        let harness = makeHarness()
        harness.platform.opens = false
        harness.controller.openNotificationSettings()
        XCTAssertEqual(harness.platform.opened, 1)
        XCTAssertEqual(harness.controller.settingsError, .notificationSettingsUnavailable)
        XCTAssertFalse(InboxSettingsErrorCopy
            .message(.notificationSettingsUnavailable).isEmpty)
    }

    /// The refusal does not outlive the problem it described. Once the user has
    /// allowed notifications, a message saying System Settings could not be opened
    /// is stale, and its section is gone anyway.
    func testGrantingAuthorizationClearsAStaleSettingsRefusal() async {
        let harness = makeHarness()
        harness.platform.answer = .denied
        harness.platform.opens = false
        harness.controller.refreshNotificationPermission()
        await settle()
        harness.controller.openNotificationSettings()
        XCTAssertEqual(harness.controller.settingsError, .notificationSettingsUnavailable)

        harness.platform.answer = .allowed
        harness.controller.refreshNotificationPermission()
        await settle()
        XCTAssertNil(harness.controller.settingsError,
                     "a refusal about System Settings survived notifications being allowed")
    }

    /// A permission update clears ONLY its own refusal. A folder message the user
    /// has not read yet must not be wiped by an unrelated system measurement that
    /// happens to arrive while they are reading it.
    func testAPermissionUpdateDoesNotClearAnUnrelatedRefusal() async {
        let harness = makeHarness()
        harness.controller.session(InboxAccountIdentity(accountID: account.value,
                                                        bearer: "bearer-notify"))
        await settle()
        // Receiving on with no folder chosen is refused, and that refusal is the
        // one this test protects.
        harness.controller.setPolicy(.auto)
        XCTAssertEqual(harness.controller.settingsError, .noFolderChosen)

        harness.platform.answer = .denied
        harness.controller.refreshNotificationPermission()
        await settle()
        XCTAssertEqual(harness.controller.settingsError, .noFolderChosen,
                       "measuring notifications erased an unrelated refusal")
    }

    /// Repeated identical answers publish nothing new. Activation fires this on
    /// every switch back to the app, and a permission that reassigned itself each
    /// time would redraw the pane on every focus change.
    func testAnUnchangedAnswerIsNotRepublished() async {
        let harness = makeHarness()
        harness.platform.answer = .denied
        var updates = 0
        let cancellable = harness.controller.$notificationPermission.sink { _ in updates += 1 }
        defer { cancellable.cancel() }
        for _ in 0..<3 {
            harness.controller.refreshNotificationPermission()
            await settle()
        }
        // One for the initial subscription value, one for the single change.
        XCTAssertEqual(updates, 2, "an unchanged permission was republished")
    }
}
