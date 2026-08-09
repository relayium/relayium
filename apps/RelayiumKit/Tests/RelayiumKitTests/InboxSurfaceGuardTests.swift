import XCTest
@testable import RelayiumAppKit

/// What the Device Inbox surfaces are NOT allowed to contain.
///
/// Modelled on `MacSurfaceGuardTests` and for the same reason: these are
/// ABSENCES, and an absence has no runtime to observe. Four of them decide
/// whether the round's central claims are true at all.
///
///  1. **The receiver is app-scoped.** The product claim is that a Mac with its
///     window closed still receives. A controller owned by a view or by the
///     Settings scene stops the moment that scene goes away — which is precisely
///     the case the capability exists for.
///  2. **The session observer subscribes before any scene.** A sign-out or an
///     account switch must cancel the loop even while no window exists, and a
///     view-scoped observer is absent for exactly that interval.
///  3. **No surface renders a received file name or path.** The menu bar is drawn
///     over whatever the user is presenting; a notification preview is drawn on
///     the lock screen.
///  4. **No renderer may fall through to ready.** `InboxRuntimeState` is closed
///     and every renderer switches over all of it, because the fall-through state
///     would be a promise to a stranger that their file will land here.
final class InboxSurfaceGuardTests: XCTestCase {

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
    }

    private var macRoot: URL { appsRoot.appendingPathComponent("mac/Relayium") }
    private var packageRoot: URL {
        appsRoot.appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit")
    }

    /// A source with whole-line comments dropped — the same loader the other
    /// guards use, and for the same reason: these files explain what they
    /// deliberately do NOT do, so scanning raw text would fail on the very
    /// comments documenting the absence being checked.
    private func code(_ url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
            .components(separatedBy: "\n")
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("*")
                    && !trimmed.hasPrefix("/*")
            }
            .joined(separator: "\n")
    }

    private func macSource(_ name: String) throws -> String {
        try code(macRoot.appendingPathComponent(name))
    }

    private func packageSource(_ name: String) throws -> String {
        try code(packageRoot.appendingPathComponent(name))
    }

    private func macSources() throws -> [(name: String, text: String)] {
        let names = try FileManager.default.subpathsOfDirectory(atPath: macRoot.path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertGreaterThanOrEqual(names.count, 30,
                                    "found \(names.count) sources at \(macRoot.path)")
        return try names.map { ($0, try code(macRoot.appendingPathComponent($0))) }
    }

    private func occurrences(of needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    // MARK: - the receiver outlives every window

    func testTheReceiverIsAppScopedAndItsSessionObserverStartsBeforeAnyScene() throws {
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(app.contains("@StateObject private var inbox: InboxController"),
                      "the receiver belongs to the App, not to a window or a view")
        XCTAssertTrue(app.contains("private let inboxSession: InboxSessionBridge"),
                      "nothing retains the session observer, so it would be deallocated")
        guard let initRange = app.range(of: "init() {"),
              let body = app.range(of: "var body: some Scene"),
              let observe = app.range(of: "bridge.observe(account.$state") else {
            return XCTFail("RelayiumApp no longer has the shape this checks")
        }
        XCTAssertTrue(initRange.upperBound < observe.lowerBound
                      && observe.upperBound < body.lowerBound,
                      "the session subscription must be made in init, before any scene is built")
        XCTAssertEqual(occurrences(of: "InboxSessionBridge(", in: app), 1,
                       "a second bridge would be a second, competing session mapping")
        XCTAssertEqual(occurrences(of: "InboxController(runtime:", in: app), 0,
                       "the scene assembles the controller itself instead of using the factory")
        // Both surfaces render the SAME object. Two controllers would be two
        // schedulers claiming against one account.
        XCTAssertEqual(occurrences(of: ".environmentObject(inbox)", in: app), 2,
                       "the menu bar and Settings must share one controller")
    }

    func testNoViewBuildsASecondControllerOrASecondObserver() throws {
        for (name, text) in try macSources() where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("InboxSessionBridge("),
                           "\(name) starts a second session observer")
            XCTAssertFalse(text.contains("AppEnvironment.makeInboxController("),
                           "\(name) builds a second receiver")
        }
    }

    // MARK: - the two consents stay separate

    /// Choosing a folder must not enable receiving, and the policy control must
    /// go through the setter that refuses a non-`off` answer without a folder.
    func testTheFolderAndThePolicyAreTwoControlsThroughTwoSetters() throws {
        let pane = try macSource("Settings/DeviceInboxSettingsView.swift")
        XCTAssertTrue(pane.contains("inbox.chooseFolder(url)"))
        XCTAssertTrue(pane.contains("set: { inbox.setPolicy($0) }"),
                      "the picker bypasses the setter that refuses a policy without a folder")
        XCTAssertFalse(pane.contains("setAutomaticReceive"),
                       "the pane writes the receive consent behind the controller's back")
        XCTAssertFalse(pane.contains("setReceivePolicy"),
                       "the pane writes the policy straight to the store")
        // Choosing a folder in the same action as enabling would be the single
        // control PRD §8 forbids.
        guard let choose = pane.range(of: "private func chooseFolder() {") else {
            return XCTFail("the pane no longer owns one folder-picking action")
        }
        let action = pane[choose.upperBound...].components(separatedBy: "\n    }").first ?? ""
        XCTAssertFalse(action.contains("setPolicy"),
                       "picking a folder also turns receiving on")
    }

    // MARK: - nothing falls through to ready

    /// Every renderer of the state switches over the closed enum with no
    /// `default:`. A `default:` here would render some future state as whatever
    /// arm it landed in — and the arm that matters is `ready`.
    func testNoStateRendererCanFallThrough() throws {
        for name in ["Settings/DeviceInboxSettingsView.swift", "MenuBarView.swift"] {
            let source = try macSource(name)
            for marker in ["switch inbox.state {"] where source.contains(marker) {
                let switches = source.components(separatedBy: marker).dropFirst()
                for block in switches {
                    let body = String(block.prefix(1_200))
                    XCTAssertFalse(body.contains("default:"),
                                   "\(name) renders the inbox state with a fall-through")
                }
            }
        }
        let copy = try packageSource("Localization/InboxCopy.swift")
        XCTAssertTrue(copy.contains("switch state {"))
        guard let statusSwitch = copy.range(of: "switch state {") else {
            return XCTFail("the status presentation no longer switches over the state")
        }
        let body = String(copy[statusSwitch.lowerBound...].prefix(2_000))
        XCTAssertFalse(body.contains("default:"),
                       "the shared status copy has a fall-through arm")
    }

    /// Both surfaces render the SAME presentation. Two switch statements over one
    /// state enum is two places for a case to go missing, and the menu bar is the
    /// one that is visible when nothing else is.
    func testTheMenuBarAndSettingsRenderOneSharedPresentation() throws {
        for name in ["Settings/DeviceInboxSettingsView.swift", "MenuBarView.swift"] {
            XCTAssertTrue(try macSource(name).contains("InboxStatusPresentation.text(for: inbox.state)"),
                          "\(name) writes its own status copy")
        }
    }

    // MARK: - what is never rendered

    /// No Device Inbox surface may render a received file name, a destination
    /// path, or an identifier. `InboxReceipt` carries the URLs because Reveal
    /// cannot work without them; nothing may draw them.
    func testNoInboxSurfaceRendersANameAPathOrAnIdentifier() throws {
        let surfaces = ["Settings/DeviceInboxSettingsView.swift", "MenuBarView.swift",
                        "InboxNotifier.swift"]
        for name in surfaces {
            let source = try macSource(name)
            for banned in ["receipt.urls", "url.path", "lastPathComponent", "receipt.taskID",
                           "asking.first", "bearerToken"] {
                XCTAssertFalse(source.contains(banned), "\(name) can render \(banned)")
            }
        }
    }

    /// Reveal is one call site, it is fed by the controller, and the controller
    /// is what refuses anything that is not a known completed receipt.
    func testFinderRevealHasExactlyOneCallSiteAndItGoesThroughTheController() throws {
        let all = try macSources()
        // Two, and each is the ONE site for its own capability:
        // `ReceivedResultView` reveals a stored-link download the user opened
        // themselves, and `RelayiumApp` holds the Device Inbox seam. A third
        // would be a path reaching the Finder from a surface that never checked
        // where it came from.
        let sites = all.filter { $0.text.contains("activateFileViewerSelecting") }.map(\.name)
        XCTAssertEqual(sites, ["ReceivedResultView.swift", "RelayiumApp.swift"],
                       "a received path reaches the Finder from somewhere other than the two seams")
        XCTAssertTrue(try macSource("Settings/DeviceInboxSettingsView.swift")
            .contains("inbox.reveal(receipt)"))
        XCTAssertTrue(try macSource("MenuBarView.swift").contains("inbox.reveal(latest)"))
        let controller = try packageSource("DeviceInbox/InboxController.swift")
        XCTAssertTrue(controller.contains("guard let known = results.first(where:"),
                      "Reveal no longer checks the path against this generation's own results")
    }

    /// PRD §9: receiving ends at a quarantined file on disk. It never hands that
    /// file to an application, a process launcher or an archive extractor.
    func testTheInboxNeverOpensExecutesOrExtractsReceivedContent() throws {
        let inboxRoot = packageRoot.appendingPathComponent("DeviceInbox")
        let names = try FileManager.default.subpathsOfDirectory(atPath: inboxRoot.path)
            .filter { $0.hasSuffix(".swift") }
        let sources = try names.map { try code(inboxRoot.appendingPathComponent($0)) }
            + [macSource("Settings/DeviceInboxSettingsView.swift"),
               macSource("InboxNotifier.swift")]
        for source in sources {
            for banned in ["NSWorkspace.shared.open(", "Process(", "/usr/bin/open",
                           "Archive(", "unzip", "extractItem("] {
                XCTAssertFalse(source.contains(banned),
                               "Device Inbox can launch or unpack received content via \(banned)")
            }
        }
    }

    // MARK: - the notification-settings route

    /// **The seam that opens System Settings can never be handed a path.**
    ///
    /// The ban above stops the Device Inbox surfaces from launching anything at
    /// all, and this is what keeps the one deliberate exception from becoming a
    /// hole in it. The seam is declared to take NO argument, so there is no
    /// parameter through which a received file name, a destination path or a task
    /// id could travel to `NSWorkspace` — the property holds by the type, not by
    /// the care of whoever writes the next call site.
    func testTheNotificationSettingsSeamTakesNothingAndOpensOnlyALiteral() throws {
        let controller = try packageSource("DeviceInbox/InboxController.swift")
        XCTAssertTrue(controller.contains("public var openNotificationSettings: @Sendable () -> Bool"),
                      "the System Settings seam no longer refuses to take an argument")

        // The one implementation, in the scene that already owns the other
        // platform seam. The URL is built in the same expression as the call,
        // from the route type and this bundle's own identifier — never from a
        // value that reached the scene from anywhere else.
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(app.contains("InboxNotificationSettingsRoute"),
                      "the notification-settings route lost its deep link")
        XCTAssertTrue(app.contains(".url(forBundleIdentifier: Bundle.main.bundleIdentifier)"),
                      "the notification-settings route no longer names THIS app; a "
                        + "constant or a missing id opens whichever row System "
                        + "Settings was last left on")
        let openers = try macSources().filter {
            $0.text.contains("InboxNotificationSettingsRoute")
        }.map(\.name)
        XCTAssertEqual(openers, ["RelayiumApp.swift"],
                       "the notification settings pane is opened from more than one place")
        // And the URL itself exists in exactly one place, which is the place the
        // execution tests can drive. A second copy in the app would be a route
        // nothing proves selects an app row.
        for (name, text) in try macSources() {
            XCTAssertFalse(text.contains("Notifications-Settings.extension"),
                           "\(name) builds the notification settings URL a second time")
        }
    }

    /// **The pane identifier alone is not the route, and this is what would have
    /// caught the shipped defect.**
    ///
    /// The first version of this recovery opened
    /// `x-apple.systempreferences:com.apple.Notifications-Settings.extension`,
    /// and on macOS 26.6 that re-opened System Settings on whichever app row it
    /// was last left on — Google Chrome's, in the observed case — while the
    /// button claimed to have opened Relayium's. The guard then in place checked
    /// only that the pane identifier was present, so it passed the wrong target.
    ///
    /// The binding is checked end to end instead: the identifier this app is
    /// actually built with must produce a URL that selects that app's row. An
    /// identifier the route refuses — one carrying a character macOS allows in a
    /// product name but not in an identifier, say — would leave every denied Mac
    /// with a recovery that reports failure, and no unit test over a fixture id
    /// would notice.
    func testTheShippedBundleIdentifierProducesARowSelectingRoute() throws {
        let project = try String(
            contentsOf: appsRoot.appendingPathComponent("mac/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)
        let configured = Set(project.components(separatedBy: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("PRODUCT_BUNDLE_IDENTIFIER = ") else { return nil }
            // Xcode writes the value bare or quoted depending on its content;
            // both forms name the same identifier.
            return trimmed.dropFirst("PRODUCT_BUNDLE_IDENTIFIER = ".count)
                .trimmingCharacters(in: CharacterSet(charactersIn: ";\""))
        })
        XCTAssertFalse(configured.isEmpty, "no bundle identifier is configured at all")
        // Every target's identifier must be routable — the app is the one that
        // matters, and its extensions share its prefix, so a change that broke
        // the shape would break all of them together.
        for identifier in configured {
            guard let url = InboxNotificationSettingsRoute
                .url(forBundleIdentifier: identifier) else {
                return XCTFail("the shipped identifier \(identifier) cannot be routed")
            }
            XCTAssertTrue(url.absoluteString.hasSuffix("?id=\(identifier)"),
                          "the route for \(identifier) does not select its row")
        }
        // The app itself, named explicitly: the extensions extend it, and the
        // notification row this recovery opens is the app's.
        XCTAssertTrue(configured.contains("com.relayium.mac"),
                      "the macOS app's bundle identifier changed; the notification "
                        + "recovery's verified route must be re-verified against macOS")
    }

    /// A blocked banner is NOT an inbox runtime state.
    ///
    /// The tempting shortcut is to reuse `.attention`, and it would put "needs
    /// attention" on the status line of a Mac that is receiving, decrypting and
    /// committing perfectly — the mirror image of the `ready`-over-a-broken-grant
    /// untruth the closed state enum exists to prevent. The two axes stay apart,
    /// and the state enum stays free of any notion of notifications.
    func testNotificationAuthorizationIsNotFoldedIntoTheRuntimeState() throws {
        let state = try packageSource("DeviceInbox/InboxRuntimeState.swift")
        for banned in ["notification", "Notification", "banner", "Banner"] {
            XCTAssertFalse(state.contains(banned),
                           "InboxRuntimeState learned about \(banned)")
        }
        // And the pane renders it from its own closed presentation rather than
        // from a second switch over the runtime state.
        let pane = try macSource("Settings/DeviceInboxSettingsView.swift")
        XCTAssertTrue(pane.contains("InboxNotificationPermissionPresentation"),
                      "the pane no longer renders the banner permission from the copy layer")
        XCTAssertTrue(pane.contains("inbox.refreshNotificationPermission()"),
                      "the pane never re-measures notification authorization")
        XCTAssertTrue(pane.contains("NSApplication.didBecomeActiveNotification"),
                      "the pane cannot notice authorization changed while it stayed open")
    }

    /// One mapping decides both what the pane says and whether a banner is
    /// posted, so the claim and the behaviour cannot drift apart.
    func testTheNotifierAndThePaneShareOneAuthorizationMapping() throws {
        let notifier = try macSource("InboxNotifier.swift")
        XCTAssertTrue(notifier.contains("InboxNotificationPermission("),
                      "the notifier interprets the platform status on its own again")
        XCTAssertFalse(notifier.contains("settings.authorizationStatus {"),
                       "the notifier switches over the raw status a second time")
        XCTAssertTrue(notifier.contains("onPermission"),
                      "the notifier measures authorization and tells nobody")
    }

    // MARK: - the credential

    /// Nothing in the Device Inbox package sources persists or publishes a
    /// bearer. The controller holds one privately for the life of a generation
    /// and drops it; nothing else may keep a copy.
    func testTheBearerIsNeverPublishedOrPersisted() throws {
        let names = try FileManager.default.subpathsOfDirectory(
            atPath: packageRoot.appendingPathComponent("DeviceInbox").path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertGreaterThanOrEqual(names.count, 12,
                                    "found \(names.count) Device Inbox sources")
        for name in names {
            let source = try code(packageRoot.appendingPathComponent("DeviceInbox")
                .appendingPathComponent(name))
            XCTAssertFalse(source.contains("@Published public private(set) var identity"),
                           "\(name) publishes the credential")
            XCTAssertFalse(source.contains("UserDefaults") && source.contains("bearer"),
                           "\(name) writes a bearer to defaults")
        }
        let controller = try packageSource("DeviceInbox/InboxController.swift")
        XCTAssertTrue(controller.contains("private var identity: InboxAccountIdentity?"),
                      "the credential is no longer private to the controller")
        XCTAssertFalse(controller.contains("@Published public private(set) var identity"))
    }

    // MARK: - the acceptance suite

    /// The runtime suite exists and covers the five modes the acceptance contract
    /// names, plus the residency path. A UI suite that lost a mode is a mode with
    /// no runtime evidence at all.
    func testTheRuntimeSuiteCoversEveryRequiredMode() throws {
        let ui = try String(contentsOf: macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/DeviceInboxUITests.swift"), encoding: .utf8)
        for name in ["testSignedOutSetupExplainsWhatDeviceInboxNeeds",
                     "testAReadyAutomaticInboxNamesItsFolderAndItsPolicy",
                     "testAFolderAttentionStateAsksForTheFolderRatherThanARetry",
                     "testMultipleAskDeliveriesAreVisiblyDistinct",
                     "testAWorkingInboxSaysSoWithoutNamingTheDelivery",
                     "testACompletedDeliveryOffersRevealInFinderWithoutNamingTheFile",
                     "testClosingTheWindowLeavesTheInboxRunningAndReopeningMakesNoSecondWindow",
                     "testTheMenuBarOffersNoFolderGrantAndNoPolicyChange",
                     "testBlockedBannersSayReceivingStillWorksAndOfferSystemSettings",
                     "testTheSystemSettingsActionSaysSoWhenThePlatformRefusesIt",
                     "testAllowingNotificationsRemovesTheWarningWithoutARelaunch"] {
            XCTAssertTrue(ui.contains(name), "the runtime suite lost \(name)")
        }
        for argument in ["--relayium-ui-testing-inbox-ready",
                         "--relayium-ui-testing-inbox-attention",
                         "--relayium-ui-testing-inbox-ask",
                         "--relayium-ui-testing-inbox-working",
                         "--relayium-ui-testing-inbox-result",
                         "--relayium-ui-testing-inbox-notifications-denied",
                         "--relayium-ui-testing-inbox-notifications-recover"] {
            XCTAssertTrue(ui.contains(argument), "no launch drives \(argument)")
        }
    }

    /// The acceptance fixture exists only in DEBUG. What it substitutes is the
    /// thing that decides what gets written to a user's disk, so a shipped binary
    /// must not contain the flags at all.
    func testTheAcceptanceFixtureIsAbsentFromRelease() throws {
        let raw = try String(contentsOf: macRoot.appendingPathComponent("UITestInbox.swift"),
                             encoding: .utf8)
        XCTAssertTrue(raw.hasPrefix("#if DEBUG"),
                      "the inbox acceptance fixture is not compiled out of Release")
        XCTAssertTrue(raw.hasSuffix("#endif\n"))
        let mode = try macSource("UITestMode.swift")
        XCTAssertTrue(mode.contains("static func makeInboxController() -> InboxController? { nil }"),
                      "a Release launch can be pointed at a substituted receiver")
        // Every store the fixture touches is isolated: the keychain history, the
        // folder grant, the journal directory and the receive folder itself.
        // Isolating one store is not isolating the app.
        let fixture = try macSource("UITestInbox.swift")
        for isolated in ["InMemoryInboxFolderStore()", "InMemoryInboxDeviceKeyStore()",
                         "uitest-inbox-receive", "uitest-inbox-journal"] {
            XCTAssertTrue(fixture.contains(isolated),
                          "the acceptance fixture shares \(isolated) with the installed product")
        }
        XCTAssertFalse(fixture.contains("temporaryDirectory"),
                       "a delivery or its journal may not land somewhere the system can purge")
        XCTAssertFalse(fixture.contains("cachesDirectory"))
    }
}
