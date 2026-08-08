import XCTest

/// Runtime evidence that the real iOS shell exposes and renders every primary
/// product destination. Model/source tests cannot catch a TabView destination
/// that builds into a blank page at runtime.
final class AppShellUITests: XCTestCase {
    private var app: XCUIApplication!

    /// Every assertion below names a rendered English string, and one of them
    /// names a byte size the formatter derives from the locale. Pin both rather
    /// than inherit whatever a runner's simulator was last left in — the same
    /// thing the macOS suite does.
    private let offlineLaunchArguments = [
        "--relayium-ui-testing", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
    ]

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = offlineLaunchArguments
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

    /// The system document browser is presented as a remote view inside the
    /// app's own element tree, not as a separate `DocumentManagerUICore`
    /// process, so every step below addresses `app`.
    private func tapInBrowser(_ label: String, timeout: TimeInterval = 15) {
        let element = app.descendants(matching: .any)[label].firstMatch
        guard element.waitForExistence(timeout: timeout) else {
            return XCTFail("""
                the system document browser has no "\(label)".
                \(app.debugDescription)
                """)
        }
        element.tap()
    }

    /// Files hides a known extension, so match the fixture by the stem it is
    /// guaranteed to render rather than by a display name the OS may shorten.
    private func tapStagedFixture(named stem: String, timeout: TimeInterval = 15) {
        let element = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", stem)).firstMatch
        guard element.waitForExistence(timeout: timeout) else {
            return XCTFail("""
                the staged fixture "\(stem)" is not in the browser.
                \(app.debugDescription)
                """)
        }
        element.tap()
    }

    /// Runtime evidence that a chosen file is identified before a recipient or
    /// a Send action exists at all.
    ///
    /// `--relayium-ui-testing-pending-fixture` stages one deterministic file
    /// inside the app's own Documents directory and does nothing else. The
    /// picker, the security scope, the expansion and the rendering asserted
    /// below are production code driven through the real system browser, which
    /// reaches that directory because the app publishes it to Files.
    func testPendingSendNamesTheFileAndItsSizeBeforeTransfer() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-pending-fixture"]
        app.launch()

        openTask("Nearby", title: "Nearby")
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "Nearby has no file-selection surface")
        scrollUntilHittable(chooser)
        chooser.tap()

        let browsingTabs = app.tabBars["DOC.browsingModeTabBar"]
        XCTAssertTrue(browsingTabs.waitForExistence(timeout: 20),
                      "choosing files did not present the system document browser")
        browsingTabs.buttons["Browse"].tap()
        tapInBrowser("On My iPhone")
        tapInBrowser("Relayium")
        tapStagedFixture(named: "Relayium product brief")

        let open = app.buttons["Open"]
        XCTAssertTrue(open.waitForExistence(timeout: 10),
                      "the system browser has no confirmation action")
        open.tap()

        let identity = app.descendants(matching: .any)["pendingFile.0"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 15),
                      "the pending send did not expose its file identity")
        XCTAssertTrue(identity.label.contains("Relayium product brief.txt"),
                      "the pending send shortened or omitted the file name")
        XCTAssertTrue(identity.label.contains("1.5 KB"),
                      "the pending send omitted the formatted file size")
        XCTAssertTrue(app.buttons["Clear"].exists,
                      "the identified pending send cannot be cleared")
    }

    func testRegistrationProblemKeepsTheDraftCorrectable() {
        openTask("Account", title: "Account")
        app.buttons["New to Relayium? Create an account"].tap()
        XCTAssertTrue(app.staticTexts["Create your Relayium account"]
            .waitForExistence(timeout: 10))

        let email = app.textFields["account.email"]
        let password = app.secureTextFields["account.password"]
        let confirmation = app.secureTextFields["account.confirmPassword"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        XCTAssertTrue(password.exists)
        XCTAssertTrue(confirmation.exists)

        email.tap()
        email.typeText("person@example.com")
        password.tap()
        password.typeText("short")
        confirmation.tap()
        confirmation.typeText("wrong battery")

        let submittedPassword = password.value as? String
        let submittedConfirmation = confirmation.value as? String
        let create = app.buttons["Create account"]
        XCTAssertTrue(create.isEnabled, "a complete form cannot explain its problem")
        scrollUntilHittable(create)
        create.tap()

        XCTAssertTrue(app.staticTexts["Use at least 8 characters for your password."]
            .waitForExistence(timeout: 10),
                      "a short password is not explained beside the form")
        XCTAssertEqual(password.value as? String, submittedPassword,
                       "a local validation error erased the password")
        XCTAssertEqual(confirmation.value as? String, submittedConfirmation,
                       "a local validation error erased the confirmation")
        XCTAssertTrue(password.isEnabled)
        XCTAssertTrue(confirmation.isEnabled)
        XCTAssertTrue(create.exists, "a local refusal leaves no way to submit a correction")
    }
}
