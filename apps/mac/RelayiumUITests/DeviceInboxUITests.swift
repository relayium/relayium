import XCTest

/// The Device Inbox, driven through the app a person actually uses.
///
/// The package suites already assert what the controller decides and what the
/// SwiftUI files contain. What only appears at runtime is whether those
/// decisions reach a screen: a settings tab that fails to build, a status that
/// renders nothing, a Reveal control that is not there, and — the one this whole
/// capability rests on — a receiver that stops when the window closes.
///
/// Each launch below substitutes exactly one thing, the transport, and lets the
/// real enrolment, key store, sealed box, decryptor, planner, `linkat` commit and
/// journal run. So "a completed result with Reveal" on screen means a file
/// genuinely landed on this machine during the test.
final class DeviceInboxUITests: XCTestCase {
    private var app: XCUIApplication!

    private var offlineLaunchArguments: [String] {
        ["--relayium-ui-testing", "-AppleLanguages", "(en)",
         "-AppleLocale", "en_US", "-SUEnableAutomaticChecks", "NO"]
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// Relayium's work area is the process's largest window — the cross-version
    /// contract `AppShellUITests` established, because macOS 15 does not expose
    /// the SwiftUI scene id and auxiliary windows can appear first.
    private var mainWindow: XCUIElement {
        app.windows.allElementsBoundByIndex.max {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        } ?? app.windows.firstMatch
    }

    private func launch(_ extraArguments: [String]) {
        app.launchArguments = offlineLaunchArguments + extraArguments
        app.launch()
        let sparkleDecline = app.buttons["Don’t Check"]
        if sparkleDecline.waitForExistence(timeout: 2) { sparkleDecline.click() }

        // A hosted runner can restore the last deliberate closed-window state.
        // Relayium remains alive in that state by design, so process launch is
        // not proof that its work window is visible. Recover through the same
        // menu-bar action a person uses, matching AppShellUITests.
        if !app.windows.allElementsBoundByIndex.contains(where: {
            $0.frame.width >= 800 && $0.frame.height >= 500
        }) {
            let statusItem = app.statusItems.firstMatch
            XCTAssertTrue(statusItem.waitForExistence(timeout: 5),
                          "the resident app has no menu-bar recovery surface")
            statusItem.click()
            app.typeKey("o", modifierFlags: [])
        }
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 20),
                      "the product window did not open")
    }

    /// Open ⌘, through the menu item, then select the Device Inbox tab.
    ///
    /// Driven from the menu rather than the keyboard for the reason
    /// `AppShellUITests` recorded: a synthetic ⌘, never reached the app, so the
    /// assertion measured XCUITest rather than the scene.
    @discardableResult
    private func openDeviceInboxSettings() -> XCUIElement {
        let main = mainWindow
        let appMenu = app.menuBarItems.element(boundBy: 1)
        XCTAssertTrue(appMenu.waitForExistence(timeout: 10))
        appMenu.click()
        let settingsItem = appMenu.menuItems["Settings…"]
        XCTAssertTrue(settingsItem.waitForExistence(timeout: 10),
                      "the app menu has no Settings item")
        settingsItem.click()

        let twoWindows = NSPredicate(format: "count >= 2")
        expectation(for: twoWindows, evaluatedWith: app.windows, handler: nil)
        waitForExpectations(timeout: 20)

        let settings = app.windows.allElementsBoundByIndex
            .first { $0 != main && $0.frame.width > 100 } ?? app.windows.element(boundBy: 1)

        // A settings window REMEMBERS its last tab, so it may already be here —
        // and the tab control is not a radio button on every macOS: measured on
        // this tree it is a static text carrying the title in its `value`, which
        // is the same label/value split `AppShellUITests` records for macOS 15.
        // Try every candidate, and accept the pane appearing as the answer, so
        // this suite fails on the product rather than on a control type.
        if !deviceInboxPaneIsShowing(in: settings) {
            let named = NSPredicate(format: "label == %@ OR value == %@",
                                    "Device Inbox", "Device Inbox")
            for candidate in settings.descendants(matching: .any).matching(named)
                .allElementsBoundByIndex where candidate.isHittable {
                candidate.click()
                if deviceInboxPaneIsShowing(in: settings) { break }
            }
        }
        XCTAssertTrue(deviceInboxPaneIsShowing(in: settings),
                      "the settings window never showed the Device Inbox pane")
        return settings
    }

    /// The pane is showing when one of its two mutually exclusive roots is on
    /// screen: the signed-out explanation, or the status line.
    private func deviceInboxPaneIsShowing(in settings: XCUIElement) -> Bool {
        element("inbox-status", in: settings).waitForExistence(timeout: 3)
            || element("inbox-signed-out", in: settings).exists
    }

    /// A SwiftUI `Text` puts its string in `label` for a control and in `value`
    /// for a combined element, and which of the two it uses varies by macOS
    /// version. Reading both is the only stable way to assert on rendered copy.
    private func text(of element: XCUIElement) -> String {
        let value = element.value.map { String(describing: $0) } ?? ""
        return element.label + " " + value
    }

    private func element(_ identifier: String, in window: XCUIElement) -> XCUIElement {
        window.descendants(matching: .any)[identifier].firstMatch
    }

    /// The whole text of a settings surface, for assertions about what is NOT on
    /// it. Built from labels and values because SwiftUI splits a `Form` across
    /// many elements and macOS 15 drops identifiers from some of them.
    private func visibleText(in window: XCUIElement) -> String {
        window.descendants(matching: .any).allElementsBoundByIndex
            .map { "\($0.label) \($0.value.map { String(describing: $0) } ?? "")" }
            .joined(separator: "\n")
    }

    // MARK: - signed out

    /// Signed out, the pane explains what the capability needs rather than
    /// rendering a folder chooser that could not be used.
    func testSignedOutSetupExplainsWhatDeviceInboxNeeds() {
        launch([])
        let settings = openDeviceInboxSettings()
        XCTAssertTrue(element("inbox-signed-out", in: settings).waitForExistence(timeout: 10),
                      "a signed-out Device Inbox pane says nothing about why it is empty")
        XCTAssertFalse(element("inbox-choose-folder", in: settings).exists,
                       "a signed-out pane offers a folder grant it cannot store")
        XCTAssertFalse(element("inbox-policy", in: settings).exists)
    }

    // MARK: - ready

    /// A signed-in Mac with a chosen folder and Automatic selected says it is
    /// ready, names the folder, and offers the way to change or remove it.
    func testAReadyAutomaticInboxNamesItsFolderAndItsPolicy() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let ready = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                "Ready to receive", "Ready to receive")
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)

        XCTAssertTrue(element("inbox-folder", in: settings).exists,
                      "a ready inbox does not say where it receives")
        XCTAssertTrue(element("inbox-choose-folder", in: settings).exists)
        XCTAssertTrue(element("inbox-remove-folder", in: settings).exists,
                      "a chosen folder cannot be given back")
        XCTAssertTrue(element("inbox-policy", in: settings).exists)
        XCTAssertTrue(element("inbox-open-at-login", in: settings).exists,
                      "residency has no control on the surface that depends on it")
        // Open at Login is not evidence the inbox is ready now, and the pane
        // says so rather than leaving the inference to the reader.
        XCTAssertTrue(visibleText(in: settings).contains("does not mean the inbox is ready"),
                      "Open at Login is presented as proof of readiness")
    }

    // MARK: - folder attention

    /// A grant that will not resolve is actionable and truthful: it asks for the
    /// folder again rather than offering a retry that cannot help, and it never
    /// reads as ready.
    func testAFolderAttentionStateAsksForTheFolderRatherThanARetry() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-attention"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let broken = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                 "receive folder", "receive folder")
        expectation(for: broken, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertFalse(text(of: status).contains("Ready to receive"),
                       "a broken grant rendered as ready")

        let recovery = element("inbox-recovery", in: settings)
        XCTAssertTrue(recovery.waitForExistence(timeout: 10),
                      "a folder problem offers no way out")
        XCTAssertTrue(recovery.label.contains("Choose Folder"),
                      "a folder problem offers a retry instead of the folder")
    }

    // MARK: - ask

    /// Two encrypted deliveries cannot reveal names before acceptance, but they
    /// must not render as two indistinguishable rows. Number and encrypted size
    /// are safe metadata and each row keeps its own answer controls.
    func testMultipleAskDeliveriesAreVisiblyDistinct() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ask"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        let asking = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                 "waiting for your answer", "waiting for your answer")
        expectation(for: asking, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        // The Settings form is intentionally compact; ask rows sit between the
        // status and folder sections and may be lazily created below the fold.
        settings.swipeUp()
        XCTAssertTrue(element("inbox-ask-accept-0", in: settings).waitForExistence(timeout: 20))
        XCTAssertTrue(element("inbox-ask-accept-1", in: settings).exists)
        XCTAssertTrue(element("inbox-ask-decline-0", in: settings).exists)
        XCTAssertTrue(element("inbox-ask-decline-1", in: settings).exists)
        let copy = visibleText(in: settings)
        XCTAssertTrue(copy.contains("1.0 KB"), "the first held delivery has no safe identity")
        XCTAssertTrue(copy.contains("8.0 KB"), "the second held delivery has no safe identity")
        XCTAssertFalse(copy.contains("task_ask_one") || copy.contains("task_ask_two"),
                       "the Ask surface exposed central task identifiers")
    }

    // MARK: - working

    /// A delivery in progress says so. The label names no file: this window can
    /// be on a shared screen.
    func testAWorkingInboxSaysSoWithoutNamingTheDelivery() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-working"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let working = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                  "Receiving…", "Receiving…")
        expectation(for: working, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 30)

        XCTAssertTrue(element("inbox-pause", in: settings).exists,
                      "a running inbox cannot be paused")
        XCTAssertFalse(visibleText(in: settings).contains("brief.txt"),
                       "the in-progress surface named the file being received")
    }

    // MARK: - a completed result

    /// A real delivery, decrypted and committed during this launch, appears as a
    /// result that can be revealed — and is described by count, size and time
    /// rather than by name.
    func testACompletedDeliveryOffersRevealInFinderWithoutNamingTheFile() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-result"])
        let settings = openDeviceInboxSettings()

        let reveal = element("inbox-reveal", in: settings)
        XCTAssertTrue(reveal.waitForExistence(timeout: 60),
                      "a completed delivery cannot be revealed in Finder")
        let row = text(of: element("inbox-result", in: settings))
        XCTAssertTrue(row.contains("1 file saved"), "the result does not say what arrived")
        // Scoped to the ROW, not to the window: the folder line legitimately
        // names the chosen folder, and asserting over the whole pane would make
        // this test pass or fail on that instead.
        XCTAssertFalse(row.contains("brief.txt"),
                       "the result rendered the received file's name")
        XCTAssertFalse(row.contains("/"), "the result rendered a path")
        // The spoken name carries the row, so two results do not sound alike.
        XCTAssertTrue(reveal.label.contains("Show in Finder"))
        XCTAssertTrue(reveal.label.contains("1 file saved"))
    }

    // MARK: - residency

    /// The property the whole capability rests on: closing the window does not
    /// stop the receiver, the menu bar still reports it, and reopening produces
    /// the SAME single window rather than a second one rendering the same
    /// app-scoped state twice.
    func testClosingTheWindowLeavesTheInboxRunningAndReopeningMakesNoSecondWindow() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let window = mainWindow
        window.buttons[XCUIIdentifierCloseWindow].click()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: window, handler: nil)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(app.state, .runningForeground,
                       "closing the window ended the process the inbox lives in")

        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 10),
                      "the resident app has no menu-bar surface")
        statusItem.click()
        // With no window at all, this line is the only thing that can say whether
        // this Mac is currently able to take a delivery.
        let inboxLine = app.menuItems.allElementsBoundByIndex
            .first { $0.title.contains("Device Inbox") }
            ?? app.descendants(matching: .any).matching(
                NSPredicate(format: "label CONTAINS[c] %@", "Device Inbox")).firstMatch
        XCTAssertTrue(inboxLine.exists,
                      "the menu bar does not report the Device Inbox with the window closed")

        app.typeKey("o", modifierFlags: [])
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 15),
                      "the menu bar could not reopen the window")
        let productWindows = app.windows.allElementsBoundByIndex
            .filter { $0.frame.width >= 800 && $0.frame.height >= 500 }
        XCTAssertEqual(productWindows.count, 1,
                       "reopening produced a second window rendering the same state twice")
    }

    /// The menu bar carries the smallest safe control set and NOT the
    /// consequential consents: no folder chooser and no policy control, both of
    /// which belong on a screen with their explanations.
    func testTheMenuBarOffersNoFolderGrantAndNoPolicyChange() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 10))
        statusItem.click()
        let titles = app.menuItems.allElementsBoundByIndex.map(\.title)
        XCTAssertFalse(titles.contains { $0.contains("Choose Folder") },
                       "the menu bar offers a folder grant")
        XCTAssertFalse(titles.contains { $0.contains("Receive automatically") },
                       "the menu bar offers the unattended-write consent")
        XCTAssertTrue(titles.contains { $0.contains("Open Device Inbox settings") },
                      "the menu bar has no route to where those decisions are made")
    }
}
