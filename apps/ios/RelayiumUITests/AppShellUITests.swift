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

    private func waitForSelection(_ tab: XCUIElement, named name: String) {
        let selected = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "selected == true"), object: tab)
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 10), .completed,
                       "\(name) did not become the selected task")
    }

    private func scrollUntilHittable(_ element: XCUIElement, maxSwipes: Int = 6) {
        for _ in 0..<maxSwipes where !element.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "\(element) never became reachable")
    }

    @discardableResult
    private func openTask(_ tabName: String, title: String) -> XCUIElement {
        let tabs = app.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 20), "the primary tab bar did not render")
        let tab = tabs.buttons[tabName]
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "the tab bar has no \(tabName) task")
        tab.tap()
        waitForSelection(tab, named: tabName)
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10),
                      "\(tabName) selected but its screen did not render")
        return tab
    }

    func testEveryPrimaryTaskRendersItsOwnScreen() {
        let destinations = [
            (tab: "Receive", title: "Receive files"),
            (tab: "Send", title: "Send files"),
            (tab: "Direct", title: "Direct"),
            (tab: "Nearby", title: "Nearby"),
            (tab: "Account", title: "Account"),
        ]
        for destination in destinations {
            openTask(destination.tab, title: destination.title)
            if destination.tab == "Nearby" {
                XCTAssertTrue(app.staticTexts["Nearby receiving: paused"].exists,
                              "the offline acceptance state is not explained")
                XCTAssertTrue(app.buttons["Resume receiving"].exists,
                              "the paused state does not offer its matching recovery")
            }
        }
    }

    func testAccountRemediesRouteToTheAccountTask() {
        let accountTab = app.tabBars.firstMatch.buttons["Account"]

        openTask("Send", title: "Send files")
        let sendRemedy = app.buttons["Go to Account"]
        XCTAssertTrue(sendRemedy.waitForExistence(timeout: 10),
                      "the signed-out Send task offers no account remedy")
        sendRemedy.tap()
        waitForSelection(accountTab, named: "Account")
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 10))

        openTask("Direct", title: "Direct")
        let directRemedy = app.buttons["Open Account"]
        XCTAssertTrue(directRemedy.waitForExistence(timeout: 10),
                      "the signed-out Direct task offers no account remedy")
        directRemedy.tap()
        waitForSelection(accountTab, named: "Account")
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 10))
    }

    func testDirectModeChoiceStaysInDirect() {
        let directTab = openTask("Direct", title: "Direct")
        let textMode = app.segmentedControls.firstMatch.buttons["Text"]
        XCTAssertTrue(textMode.waitForExistence(timeout: 10),
                      "Direct offers no text mode")
        textMode.tap()

        XCTAssertTrue(directTab.isSelected, "choosing Text navigated away from Direct")
        XCTAssertTrue(app.navigationBars["Direct"].exists)
        XCTAssertTrue(app.staticTexts["Start a text session"].waitForExistence(timeout: 10),
                      "Direct selected Text but did not render the text task")

        let code = app.textFields["Code"]
        XCTAssertTrue(code.waitForExistence(timeout: 10),
                      "the anonymous text receiver has no code field")
        code.tap()
        code.typeText("123456")
        XCTAssertEqual(code.value as? String, "123456")
        XCTAssertTrue(app.buttons["Join"].isEnabled,
                      "a complete text code cannot be joined")
    }

    func testDirectLargeFileRouteReachesSend() {
        openTask("Direct", title: "Direct")
        let route = app.buttons["Open Send"]
        XCTAssertTrue(route.waitForExistence(timeout: 10),
                      "Direct does not offer its large-file route")
        scrollUntilHittable(route)
        route.tap()

        let sendTab = app.tabBars.firstMatch.buttons["Send"]
        waitForSelection(sendTab, named: "Send")
        XCTAssertTrue(app.navigationBars["Send files"].waitForExistence(timeout: 10),
                      "the large-file route selected Send without rendering it")
    }

    func testAccountSwitchesToACompleteInAppRegistrationForm() {
        let accountTab = openTask("Account", title: "Account")
        let create = app.buttons["New to Relayium? Create an account"]
        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "the sign-in form offers no registration path")
        create.tap()

        XCTAssertTrue(accountTab.isSelected, "registration navigated away from Account")
        XCTAssertTrue(app.staticTexts["Create your Relayium account"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["Name (optional)"].exists)
        XCTAssertTrue(app.textFields["Email"].exists)
        XCTAssertTrue(app.secureTextFields["Password"].exists)
        XCTAssertTrue(app.secureTextFields["Confirm password"].exists)
        XCTAssertTrue(app.buttons["Create account"].exists)
        XCTAssertFalse(app.buttons["Create account"].isEnabled,
                       "an empty registration form can be submitted")

        let back = app.buttons["Back to sign in"]
        XCTAssertTrue(back.exists, "registration offers no way back to sign in")
        back.tap()
        XCTAssertTrue(accountTab.isSelected, "returning to sign in left Account")
        XCTAssertTrue(app.staticTexts["Welcome back"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.secureTextFields["Confirm password"].exists,
                       "returning to sign in left the registration fields behind")
    }

    func testMalformedReceiveLinkExplainsHowToRecover() {
        openTask("Receive", title: "Receive files")

        let link = app.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 10),
                      "Receive offers no link field")
        let open = app.buttons["Open"]
        XCTAssertTrue(open.exists, "Receive offers no way to inspect a link")
        XCTAssertFalse(open.isEnabled, "an empty receive link can be opened")

        link.tap()
        link.typeText("not a link")
        XCTAssertTrue(open.isEnabled, "a pasted link cannot be inspected")
        open.tap()

        let guidance = app.staticTexts[
            "That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…"
        ]
        XCTAssertTrue(guidance.waitForExistence(timeout: 10),
                      "an invalid link does not explain the required Relayium link shape")
        XCTAssertTrue(link.isEnabled, "an invalid link cannot be corrected in place")
        XCTAssertTrue(open.exists, "an invalid link leaves no way to try the correction")
    }
}
