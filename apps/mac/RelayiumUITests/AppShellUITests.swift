import XCTest

/// The first automated tests that drive the real app.
///
/// **What these are for, and what they are not.** The package's source guards
/// already assert what the SwiftUI files *contain*; nothing before this asserted
/// that launching the app produces a window with those surfaces in it. The two
/// failure classes that only appear at runtime — a scene that does not open, and
/// a destination that renders nothing — are what this suite exists to catch.
///
/// They are deliberately a smoke suite. Asserting pixel layout or exact copy
/// here would duplicate `LocalizedCopyTests` and break on every wording change,
/// which is how a UI suite becomes something people disable.
///
/// **The app runs with residency off** (`UITestMode`), because launching it
/// normally opens a persistent room socket and every device reaching the
/// internet from the same public address sees the others. CI runners share
/// public addresses. Nothing else is faked: these are the real destinations in
/// the real shell.
final class AppShellUITests: XCTestCase {
    private var app: XCUIApplication!

    /// Sparkle and AppKit may create auxiliary windows before the shell on a
    /// hosted runner. `windows.firstMatch` therefore is not a product window:
    /// it happened to be Relayium locally, but was an auxiliary window on
    /// macOS 15. Newer systems expose the SwiftUI scene id, but macOS 15 does
    /// not; the cross-version product contract is that Relayium's 860×560 work
    /// area is the process's largest window. Select by that visible geometry.
    private var mainWindow: XCUIElement {
        app.windows.allElementsBoundByIndex.max {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        } ?? app.windows.firstMatch
    }

    private var offlineLaunchArguments: [String] {
        ["--relayium-ui-testing", "-AppleLanguages", "(en)",
         "-AppleLocale", "en_US"]
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = offlineLaunchArguments
        app.launch()
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// Destination titles also appear as page headings. Scope navigation to
    /// the labelled sidebar outline so a rendered heading cannot turn one
    /// intended click into an ambiguous two-element query.
    private func sidebarDestination(_ title: String, in window: XCUIElement) -> XCUIElement {
        let id = [
            "Nearby": "nearby",
            "Pairing code": "pairingCode",
            "Send a link": "storedSend",
            "Open a link": "storedReceive",
            "Account": "account",
        ][title]!
        let stable = window.descendants(matching: .any)["sidebar-\(id)"].firstMatch
        if stable.exists { return stable }

        // macOS 15 does not propagate a combined List row's identifier into
        // its AX tree. Resolve the visible row by its actual sidebar position,
        // never by an OS-private table/outline container and never by the page
        // heading with the same label in the detail half.
        let dividingX = window.frame.midX
        if let row = window.staticTexts.matching(identifier: title).allElementsBoundByIndex
            .first(where: { $0.frame.midX < dividingX }) {
            return row
        }
        return stable
    }

    /// The window opens at all. A `Window` scene that fails to build leaves a
    /// running process with nothing on screen, and the menu-bar extra keeps that
    /// process alive — so "it launched" is not evidence.
    func testTheMainWindowOpens() {
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 20),
                      "the unique main window did not appear")
    }

    /// All five destinations are in the sidebar, by their accessibility labels.
    ///
    /// By label rather than by index: the order is a design decision that may
    /// change, and a positional assertion would fail on a reorder that harmed
    /// nobody. What must not change is that every capability is reachable.
    func testEveryDestinationIsReachableFromTheSidebar() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        // English is the CI locale; the localized suites cover the other eight.
        for destination in ["Nearby", "Pairing code", "Send a link",
                            "Open a link", "Account"] {
            let row = sidebarDestination(destination, in: window)
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the sidebar has no row for \(destination)")
        }
    }

    func testStoppedNearbyDiscoveryAsksForActionWithoutPretendingToWork() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let nearby = sidebarDestination("Nearby", in: window)
        XCTAssertTrue(nearby.waitForExistence(timeout: 10))
        nearby.click()

        XCTAssertTrue(window.buttons["Look again"].waitForExistence(timeout: 10))
        XCTAssertEqual(window.progressIndicators.count, 0,
                       "an off listener must not show a spinner beside the manual retry")
    }

    /// Selecting each destination renders something. The regression this catches
    /// is a destination whose body fails to build — which is a blank pane, not a
    /// crash, and is invisible to every other test in this repository.
    func testEachDestinationRendersItsOwnSurface() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let destinations = [
            (title: "Pairing code", id: "pairingCode"),
            (title: "Send a link", id: "storedSend"),
            (title: "Open a link", id: "storedReceive"),
            (title: "Account", id: "account"),
            (title: "Nearby", id: "nearby"),
        ]
        for destination in destinations {
            let row = sidebarDestination(destination.title, in: window)
            guard row.waitForExistence(timeout: 10) else {
                return XCTFail("the sidebar has no row for \(destination.title)")
            }
            row.click()
            XCTAssertTrue(window.descendants(matching: .any)["destination-\(destination.id)"]
                .waitForExistence(timeout: 10),
                          "\(destination.title) selected but its detail surface did not render")
        }
    }

    /// The exact launch-blocking path reported from the installed app: creating
    /// a pairing-code text session must not be mistaken for unsolicited Nearby
    /// receive, and its handoff must be usable without transcribing six digits.
    func testCreatingATextCodeStaysOnPairingAndShowsEveryHandoff() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))

        let pairing = sidebarDestination("Pairing code", in: window)
        XCTAssertTrue(pairing.waitForExistence(timeout: 10))
        pairing.click()

        let textMode = window.radioButtons["Text"]
        XCTAssertTrue(textMode.waitForExistence(timeout: 10))
        XCTAssertTrue(window.staticTexts["pairing-mode-match-hint"].exists,
                      "the mode picker hides the requirement to match the sender")
        textMode.click()

        let create = window.buttons["Create a text code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.click()

        // SecurityCodeText deliberately exposes digits one by one so
        // VoiceOver never reads the pairing code as one large number.
        XCTAssertTrue(window.staticTexts["4 8 3 9 2 0"].waitForExistence(timeout: 10),
                      "the generated pairing code was not visible")
        XCTAssertTrue(window.staticTexts["Join link"].exists,
                      "the generated code has no visible browser handoff")
        let expectedLink = "https://relayium.com/cross-network?mode=text#c=483920"
        XCTAssertTrue(window.staticTexts[expectedLink].exists,
                      "the visible handoff did not preserve the created Text mode")
        XCTAssertTrue(window.buttons["Copy"].exists,
                      "the join link cannot be copied")
        XCTAssertTrue(window.buttons["Share"].exists,
                      "the join link cannot use the system share sheet")
        XCTAssertTrue(window.activityIndicators["Waiting for the other device…"].exists,
                      "the generated-code surface hides its live status")
        XCTAssertTrue(window.staticTexts["pairing-code-expiry-note"].exists,
                      "the handoff leaves it ambiguous whether the code or transfer expires")
        XCTAssertTrue(window.buttons["Cancel"].exists,
                      "the generated-code surface hides its escape action")
        XCTAssertTrue(window.staticTexts["Pairing code"].exists || window.title == "Pairing code",
                      "creating a pairing-code text session navigated elsewhere")

        // No conversation or transcript exists yet. Cancel must be the whole
        // exit, not the first half of Cancel -> Session ended -> Done.
        window.buttons["Cancel"].click()
        XCTAssertTrue(window.buttons["Create a text code"].waitForExistence(timeout: 10),
                      "Cancel did not return directly to text-code creation")
        XCTAssertTrue(window.buttons["Join"].exists,
                      "Cancel did not restore the pairing-code join path")
        XCTAssertFalse(window.buttons["Done"].exists,
                       "Cancel manufactured an empty terminal task requiring Done")
        XCTAssertFalse(window.staticTexts["4 8 3 9 2 0"].exists,
                       "the cancelled pairing code remained on screen")
    }

    /// A terminal task is not an invitation to start another one on top of it.
    /// Done is the explicit boundary that releases the old connection/history;
    /// only after it is pressed may Create and Join return.
    func testTerminalTextSessionMustBeDismissedBeforeStartingAgain() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-terminal-text"]
        app.launch()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let pairing = sidebarDestination("Pairing code", in: window)
        XCTAssertTrue(pairing.waitForExistence(timeout: 10))
        pairing.click()
        let textMode = window.radioButtons["Text"]
        XCTAssertTrue(textMode.waitForExistence(timeout: 10))
        textMode.click()
        XCTAssertTrue(window.buttons["Create a text code"].waitForExistence(timeout: 10))
        window.buttons["Create a text code"].click()

        let done = window.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10),
                      "the failed session has no cleanup boundary")
        XCTAssertFalse(window.buttons["Create a text code"].exists,
                       "a new create path replaced a terminal session before Done")
        XCTAssertFalse(window.buttons["Join"].exists,
                       "a new join path replaced a terminal session before Done")

        done.click()
        XCTAssertTrue(window.buttons["Create a text code"].waitForExistence(timeout: 10),
                      "the start controls did not return after cleanup")
        XCTAssertTrue(window.buttons["Join"].exists)
    }

    /// A terminal Nearby task retains both its peer context and a real cleanup
    /// boundary. This catches the regression where ownership was folded into a
    /// generic `busy` value, making `if !busy` false for the entire lifetime of
    /// the very surface that needed to expose Back to devices.
    func testTerminalNearbySessionNamesItsPeerAndReturnsToTheRoster() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-terminal-nearby"]
        app.launch()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        XCTAssertTrue(window.descendants(matching: .any)["nearby-session-peer"]
            .waitForExistence(timeout: 10), "the terminal task lost who it was with")
        XCTAssertTrue(window.staticTexts[
            "This name is provided by the other device and is not verified identity."
        ].exists)

        let back = window.buttons["Back to nearby devices"]
        XCTAssertTrue(back.waitForExistence(timeout: 10),
                      "the retained Nearby owner made its own exit unreachable")
        back.click()
        XCTAssertTrue(window.buttons["Look again"].waitForExistence(timeout: 10),
                      "Back to devices did not release the terminal task")
        XCTAssertFalse(window.staticTexts["Session with Studio Mac · 19af02"].exists,
                       "the released task kept stale peer context on screen")
    }

    /// Settings opens as a SECOND window rather than a replacement — the main
    /// window must survive it.
    ///
    /// Driven from the menu item rather than ⌘,. The first version of this test
    /// used `typeKey(",", modifierFlags: .command)` and failed: the synthetic
    /// keystroke never reached the app, so the assertion was measuring XCUITest
    /// rather than the scene. Clicking the item tests the same thing — that a
    /// `Settings` scene exists and opens — through the path a user actually
    /// takes, and it additionally proves the item is in the app menu at all,
    /// which is the placement a `Settings` scene is chosen for.
    func testSettingsOpensWithoutReplacingTheMainWindow() {
        let main = mainWindow
        XCTAssertTrue(main.waitForExistence(timeout: 20))

        let appMenu = app.menuBarItems.element(boundBy: 1)
        XCTAssertTrue(appMenu.waitForExistence(timeout: 10))
        appMenu.click()
        let settingsItem = appMenu.menuItems["Settings…"]
        XCTAssertTrue(settingsItem.waitForExistence(timeout: 10),
                      "the app menu has no Settings item; a Settings scene creates one")
        settingsItem.click()

        // Two windows: the shell and the settings scene.
        let twoWindows = NSPredicate(format: "count >= 2")
        expectation(for: twoWindows, evaluatedWith: app.windows, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(main.exists, "opening settings must not close the main window")
    }

    /// Closing the window does not quit the app. This is the property the whole
    /// residency design rests on — `applicationShouldTerminateAfterLastWindowClosed`
    /// returning false — and until now nothing observed it running.
    func testClosingTheWindowLeavesTheAppRunning() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        window.buttons[XCUIIdentifierCloseWindow].click()
        let gone = NSPredicate(format: "count == 0")
        expectation(for: gone, evaluatedWith: app.windows, handler: nil)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(app.state, .runningForeground,
                       "closing the window must not end the process; the menu bar keeps it alive")
    }
}
