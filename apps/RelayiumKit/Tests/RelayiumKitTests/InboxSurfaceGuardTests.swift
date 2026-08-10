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
        // schedulers claiming against one account. Two rather than three since
        // the settings tab left: the main window, which holds the Device Inbox
        // destination, and the menu bar, which is the only surface visible while
        // the window is closed.
        XCTAssertEqual(occurrences(of: ".environmentObject(inbox)", in: app), 2,
                       "the main window and the menu bar must share one controller")
        // The same for the login-item preference. It reaches the main window for
        // the Device Inbox destination's residency control and the settings
        // scene for the Open at Login switch. Two preferences would be two
        // answers to a question `SMAppService` has only one of.
        XCTAssertEqual(occurrences(of: ".environmentObject(loginItem)", in: app), 2,
                       "the two login-item hosts must share one preference")
    }

    func testNoViewBuildsASecondControllerOrASecondObserver() throws {
        for (name, text) in try macSources() where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("InboxSessionBridge("),
                           "\(name) starts a second session observer")
            XCTAssertFalse(text.contains("AppEnvironment.makeInboxController("),
                           "\(name) builds a second receiver")
        }
    }

    // MARK: - one surface, two entries

    /// **One host renders the shared surface, and it is the destination.**
    ///
    /// The Device Inbox was, for a whole delivery, reachable only through ⌘, —
    /// every gate green about a capability that was in practice absent, because
    /// nothing in the main window named it. The repair was a first-class
    /// destination beside the settings tab, with `DeviceInboxSurface` shared so
    /// the two could not drift.
    ///
    /// The settings tab has now gone, and the drift risk goes with it: one
    /// capability with two complete screens reached by two different verbs is
    /// what the owner asked to be rid of. What must NOT change is the surface —
    /// the destination stays thin, deciding only where its account actions go,
    /// and every consequential control stays in the one file it renders.
    func testTheDeviceInboxDestinationIsTheOneHostOfTheSharedSurface() throws {
        let host = "Destinations/DeviceInboxDestination.swift"
        let source = try macSource(host)
        XCTAssertTrue(source.contains("DeviceInboxSurface"),
                      "\(host) does not render the shared Device Inbox surface")
        // Every consequential control, by name. A host that grew one of these is
        // a host that has started reimplementing the surface.
        for control in ["NSOpenPanel", "inbox.setPolicy", "inbox.chooseFolder",
                        "inbox.removeFolder", "inbox.reveal", "inbox.pause",
                        "inbox.respond", "InboxStatusPresentation",
                        "inbox.openNotificationSettings"] {
            XCTAssertFalse(source.contains(control),
                           "\(host) renders \(control) itself instead of sharing it")
        }
        // And exactly one host. A second would be a second place to keep in step
        // — which is how this capability ended up with a settings screen nobody
        // could find and a destination nobody had built.
        let hosts = try macSources().filter { $0.text.contains("DeviceInboxSurface {") }
            .map(\.name).sorted()
        XCTAssertEqual(hosts, ["Destinations/DeviceInboxDestination.swift"],
                       "the shared Device Inbox surface has grown another host")
    }

    /// Signed out, the surface offers ACTIONS rather than two sentences.
    ///
    /// The requirement it enforces is the one the row's visibility exists for: a
    /// destination that is listed before you have an account has to be able to
    /// get you one, in the app. The reuse of `CapabilityGateView` is the load-
    /// bearing half — it answers all five reasons an account is unavailable with
    /// the one action that resolves each, where a hand-rolled pair of buttons
    /// would tell a user whose address is merely unverified to sign in again.
    func testTheSignedOutSurfaceCarriesExecutableAccountActions() throws {
        let surface = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(surface.contains("CapabilityGateView(gate: gate,"),
                      "the signed-out Device Inbox states a problem and offers no way out")
        XCTAssertTrue(surface.contains("onAccount: onAccount"),
                      "the gate's actions are not wired to the host's account route")
        XCTAssertTrue(surface.contains("let onAccount: (AuthMode) -> Void"),
                      "the surface decides where the account actions go, so the two hosts "
                      + "cannot answer that differently for the same button")
        XCTAssertFalse(surface.contains("NSWorkspace"),
                       "the signed-out Device Inbox opens a website for account work")
        // The host routes to the native form, on the half the button promised.
        // A `select(.account)` alone lands "Create an account" on a sign-in form.
        //
        // It needs no `openWindow`: this host only exists inside the main
        // window, so the Account destination it selects is one row away. The
        // settings tab that DID need to open a window is gone.
        let destination = try macSource("Destinations/DeviceInboxDestination.swift")
        XCTAssertTrue(destination.contains("navigation.selectAccount(intent: intent)"),
                      "the destination's account actions do not carry the requested half")
        XCTAssertFalse(destination.contains("openWindow(id: \"main\")"),
                       "a destination inside the main window asks for it to be opened")
    }

    /// **A dead control is not offered.**
    ///
    /// `retryNow`, `resume` and `pause` all return immediately when the
    /// controller holds no generation, which is a state a `ready` session can
    /// genuinely be in — an account id this build refuses fails closed with the
    /// session beside it perfectly healthy. This app has already shipped one
    /// recovery button whose action was a `break`; the answer is to render it
    /// only where it can work.
    func testTheStatusOnlyBranchOffersNoControlTheControllerWouldRefuse() throws {
        let surface = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(surface.contains("private func statusSection(offersControls: Bool)"),
                      "the status section can no longer withhold its controls")
        XCTAssertTrue(surface.contains("statusSection(offersControls: false)"),
                      "the branch with no generation renders the full control set")
        for guarded in ["if offersControls,\n               let recovery",
                        "if offersControls, canPause"] {
            XCTAssertTrue(surface.contains(guarded),
                          "a control that needs a generation is rendered unguarded")
        }
        XCTAssertTrue(surface.contains(".accessibilityIdentifier(\"inbox-open-account\")"),
                      "an account the receiver refused is a dead end with no route out")
    }

    // MARK: - the two consents stay separate

    /// Choosing a folder must not enable receiving, and the policy control must
    /// go through the setter that refuses a non-`off` answer without a folder.
    func testTheFolderAndThePolicyAreTwoControlsThroughTwoSetters() throws {
        let pane = try macSource("DeviceInbox/DeviceInboxSurface.swift")
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
        for name in ["DeviceInbox/DeviceInboxSurface.swift", "MenuBarView.swift"] {
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
        for name in ["DeviceInbox/DeviceInboxSurface.swift", "MenuBarView.swift"] {
            XCTAssertTrue(try macSource(name).contains("InboxStatusPresentation.text(for: inbox.state)"),
                          "\(name) writes its own status copy")
        }
    }

    // MARK: - the menu bar's route into the product

    /// **The menu-bar item opens the Device Inbox, not the settings window.**
    ///
    /// Two defects retired at once, and the second is why this is a guard rather
    /// than a preference. The item used to promise Settings because Settings was
    /// the only full surface the feature had; and the way it got there was an
    /// undocumented selector dispatched through the responder chain, which on
    /// macOS 26.6 nothing in this app answers — with every window closed it
    /// produced no window at all while the menu closed looking like it had acted.
    ///
    /// `openWindow(id:)` addresses the unique `Window` scene directly, needs no
    /// responder chain and is available on the 13.0 deployment target, so the
    /// availability split and the private selector are both gone. The selection
    /// must be written BEFORE the window is asked for, or the window renders
    /// wherever the user last was and then moves under them.
    func testTheMenuBarOpensTheDeviceInboxDestinationRatherThanSettings() throws {
        let menu = try macSource("MenuBarView.swift")
        XCTAssertTrue(menu.contains("Button(L10n.t(.inboxOpenDeviceInbox))"),
                      "the menu bar's Device Inbox item is gone or renamed")
        XCTAssertTrue(menu.contains("navigation.select(.deviceInbox)"),
                      "the menu-bar item opens a window without choosing the destination")
        guard let select = menu.range(of: "navigation.select(.deviceInbox)"),
              let open = menu.range(of: "openWindow(id: \"main\")") else {
            return XCTFail("the menu bar no longer has the shape this checks")
        }
        XCTAssertTrue(select.upperBound < open.lowerBound,
                      "the window is opened before the destination is selected")
        // The two ways this used to reach ⌘,. Both are now dead ends for this
        // item — the private one never worked on a current macOS, and the
        // supported one raised the deployment floor for no product gain.
        for retired in ["showPreferencesWindow", "showSettingsWindow",
                        "openSettings", "OpenInboxSettingsButton"] {
            XCTAssertFalse(menu.contains(retired),
                           "the menu bar still routes the Device Inbox through \(retired)")
        }
        // Nothing anywhere reaches for the private selector again.
        for (name, text) in try macSources() {
            XCTAssertFalse(text.contains("showPreferencesWindow")
                           || text.contains("showSettingsWindow"),
                           "\(name) dispatches an undocumented settings selector")
        }
        // And ⌘, no longer carries the surface at all. The destination replaced
        // it rather than joining it: two complete screens for one capability,
        // reached by two different verbs, is what the owner asked to be rid of.
        // What the menu bar still owes is the route INTO the destination, which
        // is asserted above.
        XCTAssertFalse(try macSource("Settings/SettingsView.swift")
            .contains("DeviceInboxSettingsView()"),
                      "the settings tab is back beside the destination")
    }

    // MARK: - what is never rendered

    /// No Device Inbox surface may render a received file name, a destination
    /// path, or an identifier. `InboxReceipt` carries the URLs because Reveal
    /// cannot work without them; nothing may draw them.
    func testNoInboxSurfaceRendersANameAPathOrAnIdentifier() throws {
        let surfaces = ["DeviceInbox/DeviceInboxSurface.swift", "MenuBarView.swift",
                        "InboxNotifier.swift",
                        // The host too. It is thin today, and this is the ban a
                        // host would be most tempted to break first — a "you
                        // received X" heading above the shared form.
                        "Destinations/DeviceInboxDestination.swift"]
        for name in surfaces {
            let source = try macSource(name)
            var banned = ["receipt.urls", "url.path", "lastPathComponent", "receipt.taskID",
                          "asking.first", "bearerToken"]
            // The shared surface is the one file that may NAME the credential,
            // and only in the one expression every account-backed surface in this
            // app uses to ask "may this run" — `AccountGate.from` takes the token
            // because "ready with no bearer" is a real state it has to tell apart.
            // It is not stored, not published and not rendered, and the exemption
            // is bounded to a single occurrence below so a second mention of it in
            // this file fails here.
            if name == "DeviceInbox/DeviceInboxSurface.swift" {
                banned.removeAll { $0 == "bearerToken" }
                XCTAssertEqual(occurrences(of: "bearerToken", in: source), 1,
                               "the shared Device Inbox surface names the credential more "
                               + "than once; the exemption covers the gate expression only")
                XCTAssertTrue(source.contains(
                    "AccountGate.from(session.state, bearer: session.bearerToken)"),
                              "the credential is named outside the gate expression")
                XCTAssertFalse(source.contains("Text(session"),
                               "the surface renders a value straight off the session")
            }
            for banned in banned {
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
        XCTAssertTrue(try macSource("DeviceInbox/DeviceInboxSurface.swift")
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
            + [macSource("DeviceInbox/DeviceInboxSurface.swift"),
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
        let pane = try macSource("DeviceInbox/DeviceInboxSurface.swift")
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
                     "testAllowingNotificationsRemovesTheWarningWithoutARelaunch",
                     // The first-class entry, and the three things about it that
                     // only exist at runtime: the sidebar row opens the
                     // destination, the destination carries the WHOLE surface
                     // rather than a link to Settings, and the signed-out screen's
                     // two account actions actually go somewhere.
                     "testTheSidebarRowOpensTheDeviceInboxDestination",
                     "testTheDestinationCarriesTheCompleteSignedInSurface",
                     "testTheSignedOutDestinationExplainsItselfAndCanReachTheForm",
                     "testTheSignedOutDestinationCanReachTheCreateAccountForm",
                     "testTheMenuBarOpensTheDeviceInboxWithEveryWindowClosed",
                     // The third branch, driven rather than inferred from the two
                     // beside it. It is the one state where the session and the
                     // receiver disagree permanently, and both obvious renderings
                     // of it are defects.
                     "testAnAccountTheReceiverCannotUseSaysSoAndOffersARouteOut"] {
            XCTAssertTrue(ui.contains(name), "the runtime suite lost \(name)")
        }
        for argument in ["--relayium-ui-testing-inbox-ready",
                         "--relayium-ui-testing-inbox-attention",
                         "--relayium-ui-testing-inbox-ask",
                         "--relayium-ui-testing-inbox-working",
                         "--relayium-ui-testing-inbox-result",
                         "--relayium-ui-testing-inbox-notifications-denied",
                         "--relayium-ui-testing-inbox-notifications-recover",
                         "--relayium-ui-testing-unusable-account"] {
            XCTAssertTrue(ui.contains(argument), "no launch drives \(argument)")
        }
        // The fixture behind the last one substitutes the account id and nothing
        // else, so the identifier check it exercises is the product's own.
        let mode = try macSource("UITestMode.swift")
        XCTAssertTrue(mode.contains("hasUnusableAccount ? \"acct/uitest\" : \"acct_uitest\""),
                      "the refused-account fixture no longer supplies an id this build rejects")
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
