import XCTest

/// Runtime evidence that the real iOS shell exposes and renders every primary
/// product destination. Model/source tests cannot catch a TabView destination
/// that builds into a blank page at runtime.
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

    func testEveryPrimaryTaskRendersItsOwnScreen() {
        let tabs = app.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 20), "the primary tab bar did not render")

        let destinations = [
            (tab: "Receive", title: "Receive files"),
            (tab: "Send", title: "Send files"),
            (tab: "Direct", title: "Direct"),
            (tab: "Nearby", title: "Nearby"),
            (tab: "Account", title: "Account"),
        ]
        for destination in destinations {
            let tab = tabs.buttons[destination.tab]
            XCTAssertTrue(tab.waitForExistence(timeout: 10),
                          "the tab bar has no \(destination.tab) task")
            tab.tap()
            let selected = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "selected == true"), object: tab)
            XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 10), .completed,
                           "\(destination.tab) did not become the selected task")
            XCTAssertTrue(app.navigationBars[destination.title].waitForExistence(timeout: 10),
                          "\(destination.tab) selected but its screen did not render")
            if destination.tab == "Nearby" {
                XCTAssertTrue(app.staticTexts["Nearby receiving: paused"].exists,
                              "the offline acceptance state is not explained")
                XCTAssertTrue(app.buttons["Resume receiving"].exists,
                              "the paused state does not offer its matching recovery")
            }
        }
    }
}
