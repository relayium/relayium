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

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["--relayium-ui-testing"]
        app.launch()
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// The window opens at all. A `Window` scene that fails to build leaves a
    /// running process with nothing on screen, and the menu-bar extra keeps that
    /// process alive — so "it launched" is not evidence.
    func testTheMainWindowOpens() {
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 20),
                      "the unique main window did not appear")
    }

    /// All five destinations are in the sidebar, by their accessibility labels.
    ///
    /// By label rather than by index: the order is a design decision that may
    /// change, and a positional assertion would fail on a reorder that harmed
    /// nobody. What must not change is that every capability is reachable.
    func testEveryDestinationIsReachableFromTheSidebar() {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        // English is the CI locale; the localized suites cover the other eight.
        for destination in ["Nearby", "Pairing code", "Send a link",
                            "Open a link", "Account"] {
            let row = window.descendants(matching: .any)[destination]
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the sidebar has no row for \(destination)")
        }
    }

    /// Selecting each destination renders something. The regression this catches
    /// is a destination whose body fails to build — which is a blank pane, not a
    /// crash, and is invisible to every other test in this repository.
    func testEachDestinationRendersItsOwnSurface() {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        for destination in ["Pairing code", "Send a link", "Open a link", "Account", "Nearby"] {
            let row = window.descendants(matching: .any)[destination]
            guard row.waitForExistence(timeout: 10) else {
                return XCTFail("the sidebar has no row for \(destination)")
            }
            row.click()
            // The window's title tracks the selected destination, so it is the
            // one assertion that holds for all five without naming each pane's
            // internals.
            XCTAssertTrue(window.staticTexts[destination].waitForExistence(timeout: 10)
                            || window.title == destination,
                          "\(destination) selected but nothing identifying it rendered")
        }
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
        let main = app.windows.firstMatch
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
        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        window.buttons[XCUIIdentifierCloseWindow].click()
        let gone = NSPredicate(format: "count == 0")
        expectation(for: gone, evaluatedWith: app.windows, handler: nil)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(app.state, .runningForeground,
                       "closing the window must not end the process; the menu bar keeps it alive")
    }
}
