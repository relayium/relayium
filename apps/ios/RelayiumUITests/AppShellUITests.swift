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

    /// A launch that already holds an account renders it, and the tasks that are
    /// account-gated stop offering their signed-out remedy.
    ///
    /// Every signed-in surface in the product was unreachable from acceptance
    /// until this: the suite could only ever be signed out, so Send a link,
    /// Account's device and stored-file sections and every completion that
    /// follows them had no runtime evidence at all. The account is answered by a
    /// deterministic in-process transport, so this reaches no server and no real
    /// credential exists anywhere in it.
    func testASignedInLaunchRendersItsAccountAndUngatesSend() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in"]
        app.launch()

        openTask("Account", title: "Account")
        XCTAssertTrue(app.staticTexts["person@example.com"].waitForExistence(timeout: 20),
                      "a signed-in launch did not render the account it holds")
        XCTAssertTrue(app.staticTexts["Signed-in devices"].exists,
                      "the signed-in account has no device section")

        XCTAssertTrue(app.staticTexts["Studio Mac"].waitForExistence(timeout: 10),
                      "the signed-in device list did not name this device")
        XCTAssertTrue(app.staticTexts["Kitchen laptop"].exists,
                      "the device list dropped a revocable row")
        XCTAssertTrue(app.staticTexts["This device"].exists,
                      "nothing distinguishes the device the user is holding")
        // "Revoke" is the same word on every row. What VoiceOver must hear is
        // WHICH credential the button would destroy.
        let revokes = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Kitchen laptop"))
        XCTAssertGreaterThan(revokes.count, 0,
                             "a revoke action does not identify the row it destroys")

        // Both arms of a stored row, side by side. A `#k=` link is the plaintext
        // to anybody holding it, so which arm a row is in is a security fact,
        // not a convenience one.
        XCTAssertTrue(app.staticTexts["obj_uitest"].waitForExistence(timeout: 10),
                      "the stored object is not identified by the id the server knows")
        XCTAssertTrue(app.staticTexts["obj_nokey"].exists,
                      "the second stored object is missing from the list")

        // The key for this one IS on this device, so the hand-off exists.
        for handoff in ["Share the link for stored file", "Copy link", "Open"] {
            XCTAssertGreaterThan(app.buttons.matching(NSPredicate(
                format: "label BEGINSWITH %@ AND label CONTAINS %@",
                handoff, "obj_uitest")).count, 0,
                "a rebuildable row does not offer \(handoff)")
        }
        // The key for this one never arrived. XCUITest caps a string-identifier
        // query at 128 characters and the explanation is deliberately longer,
        // so match its opening.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@",
            "The key for this file isn't on this device")).firstMatch.exists,
            "a row that cannot be rebuilt does not explain why")
        for handoff in ["Share the link for stored file", "Copy link", "Open"] {
            XCTAssertEqual(app.buttons.matching(NSPredicate(
                format: "label BEGINSWITH %@ AND label CONTAINS %@",
                handoff, "obj_nokey")).count, 0,
                "a row with no key still offers \(handoff)")
        }
        // Delete IS offered on both: removing ciphertext needs no key.
        XCTAssertEqual(app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Delete stored file")).count, 2,
            "a stored object that cannot be linked also cannot be removed")

        openTask("Send", title: "Send files")
        XCTAssertFalse(app.buttons["Go to Account"].exists,
                       "a signed-in Send task still offers the signed-out remedy")
    }

    /// The off state a destination failure leaves behind — never resident,
    /// never paused — rendered by the running app.
    ///
    /// The card used to take its status from `receive.state` and everything
    /// else from `residency.isPaused`, so this state read as: off, but still
    /// listening, files will be saved here, and here is a Pause button for the
    /// listener that is already off. Look again, in the roster below, is the
    /// one recovery that matches it.
    func testStoppedNearbyReceivingAsksForActionWithoutPretendingToWork() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-off-receiving"]
        app.launch()

        openTask("Nearby", title: "Nearby")

        XCTAssertTrue(app.staticTexts["Nearby receiving: off"].waitForExistence(timeout: 10),
                      "the stopped listener does not report itself as off")
        XCTAssertTrue(app.staticTexts[
            "This device is not listening for nearby devices. It can still send, and pairing codes still work."
        ].exists, "the off state claims this device is still listening")
        XCTAssertFalse(app.staticTexts[
            "Incoming files are saved in Relayium's own folder, which you can open in the Files app."
        ].exists, "an off listener still promises to deliver an incoming file")
        XCTAssertFalse(app.buttons["Pause receiving"].exists,
                       "an off listener offers the contradictory action to pause")
        XCTAssertFalse(app.buttons["Resume receiving"].exists,
                       "an off listener offers to undo a pause nobody took")

        let lookAgain = app.buttons["Look again"]
        XCTAssertTrue(lookAgain.waitForExistence(timeout: 10),
                      "the off state leaves no recovery at all")
        scrollUntilHittable(lookAgain)
        XCTAssertTrue(lookAgain.isEnabled)
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

    /// Leave a destructive confirmation without taking it.
    ///
    /// SwiftUI presents `confirmationDialog` as a POPOVER here, and a popover
    /// deliberately carries no Cancel button: dismissing it by tapping outside
    /// IS the cancel, which is the platform's convention rather than a missing
    /// affordance. Prefer a real Cancel where one exists, then fall back to the
    /// dismiss region UIKit provides for exactly this.
    private func dismissConfirmation() {
        let cancel = app.buttons.matching(
            NSPredicate(format: "label == %@", "Cancel")).firstMatch
        if cancel.exists { return cancel.tap() }
        let outside = app.otherElements["PopoverDismissRegion"]
        XCTAssertTrue(outside.waitForExistence(timeout: 10),
                      "the destructive confirmation offers no way out")
        outside.tap()
    }

    /// A destructive confirmation must name what it destroys AND state the
    /// consequence that actually applies to that row.
    ///
    /// Revoking the credential in your hand signs this app out; revoking another
    /// one does not. A dialog that carried the wrong sentence would be a
    /// destructive button lying about itself, and nothing before this drove the
    /// two arms in the running app.
    func testRevokeConfirmationNamesTheDeviceAndItsRealConsequence() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in"]
        app.launch()
        openTask("Account", title: "Account")

        let other = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Kitchen laptop")).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 20),
                      "no revoke action identifies the other device")
        scrollUntilHittable(other)
        other.tap()

        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "Kitchen laptop")).firstMatch
            .waitForExistence(timeout: 10),
            "the confirmation does not name the device it would revoke")
        XCTAssertTrue(app.staticTexts[
            "That device will be signed out and will have to sign in again."
        ].exists, "revoking another device claims the wrong consequence")
        XCTAssertFalse(app.staticTexts[
            "This is the device you're using. Revoking it signs this app out immediately."
        ].exists, "revoking another device threatens to sign this one out")

        dismissConfirmation()

        let current = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Studio Mac")).firstMatch
        XCTAssertTrue(current.waitForExistence(timeout: 10),
                      "cancelling the confirmation lost the device list")
        scrollUntilHittable(current)
        current.tap()

        XCTAssertTrue(app.staticTexts[
            "This is the device you're using. Revoking it signs this app out immediately."
        ].waitForExistence(timeout: 10),
            "revoking this device hides that it signs the app out")
        dismissConfirmation()
        XCTAssertTrue(app.staticTexts["Kitchen laptop"].waitForExistence(timeout: 10),
                      "a cancelled revoke did not leave the list intact")
    }

    /// Deleting stored ciphertext is irreversible and takes the object away from
    /// everyone holding the link. The dialog must say both, and cancelling it
    /// must leave the object alone.
    func testDeleteConfirmationStatesWhatItErasesAndForWhom() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in"]
        app.launch()
        openTask("Account", title: "Account")

        // By the delete action itself, not merely by the row's id: a rebuildable
        // row also carries Open, Copy link and Share, and any of them would
        // match an id-only query.
        let delete = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@",
            "Delete stored file", "obj_uitest")).firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 20),
                      "no delete action identifies the stored object")
        scrollUntilHittable(delete)
        delete.tap()

        XCTAssertTrue(app.staticTexts["Delete this stored file?"]
            .waitForExistence(timeout: 10),
            "the delete confirmation does not say what it deletes")
        XCTAssertTrue(app.staticTexts[
            "The encrypted data is erased from the server. Anyone holding the link will get nothing. This cannot be undone."
        ].exists, "the delete confirmation hides that it is irreversible")

        dismissConfirmation()
        XCTAssertTrue(app.staticTexts["obj_uitest"].waitForExistence(timeout: 10),
                      "a cancelled delete did not leave the stored object alone")
    }

    /// Signing out returns the app to the state a first launch is in, and does
    /// not leave any of the account's own surfaces behind.
    ///
    /// This is the one way out of a signed-in session, and until the acceptance
    /// account existed there was no way to reach it at all.
    func testSigningOutReturnsToTheSignedOutSurfaces() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in"]
        app.launch()
        openTask("Account", title: "Account")

        XCTAssertTrue(app.staticTexts["person@example.com"].waitForExistence(timeout: 20),
                      "the signed-in launch did not render the account it holds")
        let signOut = app.buttons["Sign out"]
        XCTAssertTrue(signOut.waitForExistence(timeout: 10),
                      "a signed-in account offers no way out")
        scrollUntilHittable(signOut)
        signOut.tap()

        XCTAssertTrue(app.staticTexts["Welcome back"].waitForExistence(timeout: 20),
                      "signing out did not return to the sign-in form")
        // Deliberately NOT asserting that the device rows and stored objects are
        // gone from here. They are — but so is the whole summary view, so such
        // an assertion passes whether or not the model was cleared: removing
        // `management.clear` from the sign-out coordinator left it green. An
        // assertion that cannot fail is worse than none, because it reads as
        // coverage. Whether the model drops the account is
        // `AccountSignOutCoordinatorTests`' subject, driven directly.
        XCTAssertFalse(app.staticTexts["person@example.com"].exists,
                       "signing out left the account address on screen")

        // The account-gated task must go back to offering its remedy, not to a
        // half-signed-in surface that would fail on first use.
        openTask("Send", title: "Send files")
        XCTAssertTrue(app.buttons["Go to Account"].waitForExistence(timeout: 10),
                      "a signed-out Send task no longer offers its account remedy")
    }

    /// Creating a text pairing code stays on Direct and shows every handoff.
    ///
    /// This is the flow the owner's 2026-08-07 review found broken: creating a
    /// text code jumped to Nearby, and the generated code offered digits and a
    /// QR but no visible, copyable, shareable join link. macOS has had a runtime
    /// path for it since; iOS had none, so the platform that produced the
    /// complaint was the one with no evidence.
    func testCreatingATextCodeStaysOnDirectAndShowsEveryHandoff() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-text-code"]
        app.launch()

        let directTab = openTask("Direct", title: "Direct")
        let textMode = app.segmentedControls.firstMatch.buttons["Text"]
        XCTAssertTrue(textMode.waitForExistence(timeout: 10), "Direct offers no text mode")
        textMode.tap()

        let create = app.buttons["Create a text code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "a signed-in Direct text task cannot create a code")
        scrollUntilHittable(create)
        create.tap()

        // Digit by digit, so VoiceOver never reads the pairing code as one
        // large number the listener has to re-segment.
        XCTAssertTrue(app.staticTexts["4 8 3 9 2 0"].waitForExistence(timeout: 15),
                      "the generated pairing code is not visible")
        XCTAssertTrue(directTab.isSelected,
                      "creating a text code navigated away from Direct")
        XCTAssertTrue(app.navigationBars["Direct"].exists)

        XCTAssertTrue(app.staticTexts["Join link"].exists,
                      "the generated code has no visible browser handoff")
        XCTAssertTrue(app.staticTexts[
            "https://relayium.com/cross-network?mode=text#c=483920"
        ].exists, "the visible handoff did not preserve the created Text mode")
        XCTAssertTrue(app.buttons["Copy"].exists, "the join link cannot be copied")
        XCTAssertTrue(app.buttons["Share"].exists,
                      "the join link cannot use the system share sheet")
    }

    /// Cancelling a generated code is the whole exit, not the first half of
    /// Cancel → Session ended → Done. No transcript exists yet, so manufacturing
    /// an empty terminal task would make the user dismiss something that never
    /// happened.
    func testCancellingAGeneratedTextCodeReturnsDirectlyToTheStartControls() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-text-code"]
        app.launch()

        openTask("Direct", title: "Direct")
        app.segmentedControls.firstMatch.buttons["Text"].tap()
        let create = app.buttons["Create a text code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        scrollUntilHittable(create)
        create.tap()
        XCTAssertTrue(app.staticTexts["4 8 3 9 2 0"].waitForExistence(timeout: 15))

        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10),
                      "the generated-code surface hides its escape action")
        cancel.tap()

        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "Cancel did not return directly to text-code creation")
        XCTAssertFalse(app.buttons["Done"].exists,
                       "Cancel manufactured an empty terminal task requiring Done")
        XCTAssertFalse(app.staticTexts["4 8 3 9 2 0"].exists,
                       "the cancelled pairing code remained on screen")
    }

    /// A terminal task is not an invitation to start another one on top of it.
    /// Done is the explicit boundary that releases the old session; only after
    /// it is pressed may Create return.
    func testATerminalTextSessionMustBeDismissedBeforeStartingAgain() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-terminal-text"]
        app.launch()

        openTask("Direct", title: "Direct")
        app.segmentedControls.firstMatch.buttons["Text"].tap()
        let create = app.buttons["Create a text code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        scrollUntilHittable(create)
        create.tap()

        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15),
                      "the failed session has no cleanup boundary")
        XCTAssertFalse(create.exists,
                       "a new create path replaced a terminal session before Done")

        scrollUntilHittable(done)
        done.tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "the start controls did not return after cleanup")
    }

    /// A terminal Nearby task keeps both its peer context and a real cleanup
    /// boundary.
    ///
    /// Back to nearby devices is not navigation: it disconnects, drops a partial
    /// receive and discards the staged selection, so it must remain reachable
    /// from the retained terminal surface and must actually release it. macOS
    /// has covered this since batch 12; iOS had no runtime evidence.
    func testATerminalNearbySessionNamesItsPeerAndReturnsToTheRoster() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-terminal-nearby"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Session with Studio Mac · 19af02"]
            .waitForExistence(timeout: 20),
            "the terminal task lost who it was with")
        XCTAssertTrue(app.staticTexts[
            "This name is provided by the other device and is not verified identity."
        ].exists, "the peer name is presented as verified identity")

        let back = app.buttons["Back to nearby devices"]
        XCTAssertTrue(back.waitForExistence(timeout: 10),
                      "the retained Nearby owner made its own exit unreachable")
        scrollUntilHittable(back)
        back.tap()

        // The discovery section is back. Not "Look again": this launch pauses
        // receiving, so the paused state's own control is what iOS renders —
        // asserting the macOS surface here would encode the other platform's
        // acceptance state as a product requirement.
        XCTAssertTrue(app.buttons["Resume receiving"].waitForExistence(timeout: 10),
                      "Back to devices did not release the terminal task")
        XCTAssertTrue(app.staticTexts["Nearby receiving: paused"].exists,
                      "the released task did not restore the discovery surface")
        XCTAssertFalse(app.staticTexts["Session with Studio Mac · 19af02"].exists,
                       "the released task kept stale peer context on screen")
    }

    /// A signed-in stored send identifies what it is about to upload, before any
    /// expiry choice or Send action is made.
    ///
    /// Send is account-gated, so this cell was unreachable until the acceptance
    /// account existed: every earlier pending-file path used the anonymous
    /// Nearby surface instead. The selection runs through the real system
    /// document browser, so the picker, the security scope and the expansion are
    /// production code.
    func testASignedInStoredSendNamesTheFileItWouldUpload() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-pending-fixture"]
        app.launch()

        openTask("Send", title: "Send files")
        XCTAssertFalse(app.buttons["Go to Account"].exists,
                       "a signed-in Send task still offers the signed-out remedy")

        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15),
                      "a signed-in Send task has no file-selection surface")
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
                      "the stored send did not expose what it would upload")
        XCTAssertTrue(identity.label.contains("Relayium product brief.txt"),
                      "the stored send shortened or omitted the file name")
        XCTAssertTrue(identity.label.contains("1.5 KB"),
                      "the stored send omitted the formatted file size")
        XCTAssertTrue(app.buttons["Clear"].exists,
                      "the identified stored send cannot be cleared")
    }

    /// Correcting the field clears the refusal with it.
    ///
    /// The malformed-link path already proves the refusal explains itself and
    /// leaves the field editable. What it does not prove is that the refusal is
    /// not STICKY: guidance that outlives the input it described sits next to
    /// corrected text telling the user they are still wrong.
    func testCorrectingARefusedLinkClearsTheRefusalWithIt() {
        openTask("Receive", title: "Receive files")

        let link = app.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        let open = app.buttons["Open"]
        link.tap()
        link.typeText("not a link")
        open.tap()

        let guidance = app.staticTexts[
            "That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…"
        ]
        XCTAssertTrue(guidance.waitForExistence(timeout: 10),
                      "an invalid link does not explain the required shape")

        link.tap()
        link.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12))

        XCTAssertFalse(open.isEnabled,
                       "an empty link can still be opened after a refusal")
        XCTAssertFalse(guidance.exists,
                       "the refusal outlived the input it described")
    }

    /// A stored send that finishes hands the result over, and offers the way to
    /// start another.
    ///
    /// This is the first completion surface acceptance has ever reached on
    /// either platform: it needs a server to say yes, so nothing before the
    /// upload fixture could get here. The encryption, chunking, manifest and
    /// link construction are all production code; only the transport is local.
    func testACompletedStoredSendHandsOverItsLinkAndOffersAnother() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-pending-fixture"]
        app.launch()

        openTask("Send", title: "Send files")
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15))
        scrollUntilHittable(chooser)
        chooser.tap()

        let browsingTabs = app.tabBars["DOC.browsingModeTabBar"]
        XCTAssertTrue(browsingTabs.waitForExistence(timeout: 20))
        browsingTabs.buttons["Browse"].tap()
        tapInBrowser("On My iPhone")
        tapInBrowser("Relayium")
        tapStagedFixture(named: "Relayium product brief")
        let open = app.buttons["Open"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        open.tap()

        // NOT app.buttons["Send"]: the tab bar carries a Send tab with the same
        // label, and it is the one that matches first.
        let send = app.scrollViews.buttons["Send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 15),
                      "a chosen file offers no way to send it")
        scrollUntilHittable(send, maxSwipes: 10)
        send.tap()

        // The link IS the result and contains the only decryption key, so it has
        // to be inspectable in full before it is handed to anybody.
        let link = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "/d/obj_uitest#k=")).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 30),
                      "a completed upload did not render its capability link")
        XCTAssertTrue(app.buttons["Copy"].exists, "the result cannot be copied")
        XCTAssertTrue(app.buttons["Share"].exists, "the result cannot be shared")

        let another = app.buttons["Send another"]
        XCTAssertTrue(another.waitForExistence(timeout: 10),
                      "a completed send offers no way to start the next one")
        scrollUntilHittable(another)
        another.tap()
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "Send another did not return to a new selection")
        XCTAssertFalse(link.exists,
                       "the previous result stayed on screen after Send another")
    }

    /// Cancelling an upload in flight returns the task to the user, with nothing
    /// half-finished left claiming to be a result.
    ///
    /// The fixture holds the chunk request open, so the surface under test is
    /// the real in-flight one and Cancel ends the real request.
    func testCancellingAnUploadInFlightReturnsTheTask() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-pending-fixture",
               "--relayium-ui-testing-stall-upload"]
        app.launch()

        openTask("Send", title: "Send files")
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15))
        scrollUntilHittable(chooser)
        chooser.tap()
        let browsingTabs = app.tabBars["DOC.browsingModeTabBar"]
        XCTAssertTrue(browsingTabs.waitForExistence(timeout: 20))
        browsingTabs.buttons["Browse"].tap()
        tapInBrowser("On My iPhone")
        tapInBrowser("Relayium")
        tapStagedFixture(named: "Relayium product brief")
        let open = app.buttons["Open"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        open.tap()

        let send = app.scrollViews.buttons["Send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 15))
        scrollUntilHittable(send, maxSwipes: 10)
        send.tap()

        let cancel = app.scrollViews.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 20),
                      "an upload in flight cannot be cancelled")
        // The in-flight surface replaces the page, so the control can sit above
        // wherever the selection screen was scrolled to. Look upward first.
        for _ in 0..<6 where !cancel.isHittable { app.swipeDown() }
        scrollUntilHittable(cancel, maxSwipes: 10)
        cancel.tap()

        // Cancel does NOT throw the work away: the staged bytes are the user's
        // own, so the task becomes resumable and discarding is a separate,
        // explicit choice. What must not survive is a half-finished result
        // pretending to be a link.
        XCTAssertTrue(app.buttons["Resume upload"].waitForExistence(timeout: 20),
                      "a cancelled upload cannot be resumed")
        XCTAssertTrue(app.buttons["Discard saved copy"].exists,
                      "a cancelled upload cannot be discarded either")
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "#k=")).count, 0,
            "a cancelled upload left a capability link on screen")
    }

    /// Signing in through the form turns an empty session into a real one.
    ///
    /// Every other account path either started signed out or started already
    /// signed in. The transition itself — the one a first-time user actually
    /// performs — had no runtime evidence on either platform.
    func testSigningInThroughTheFormOpensTheAccount() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + ["--relayium-ui-testing-sign-in"]
        app.launch()

        openTask("Account", title: "Account")
        XCTAssertTrue(app.staticTexts["Welcome back"].waitForExistence(timeout: 15),
                      "a signed-out launch did not offer the sign-in form")

        let email = app.textFields["account.email"]
        let password = app.secureTextFields["account.password"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        XCTAssertTrue(password.exists)
        email.tap()
        email.typeText("person@example.com")
        password.tap()
        password.typeText("correct horse battery")

        let signIn = app.buttons["Sign in"]
        XCTAssertTrue(signIn.exists, "the completed form cannot be submitted")
        scrollUntilHittable(signIn)
        signIn.tap()

        XCTAssertTrue(app.staticTexts["person@example.com"].waitForExistence(timeout: 20),
                      "signing in did not open the account")
        XCTAssertTrue(app.staticTexts["Signed-in devices"].exists,
                      "the opened account has no device section")
        XCTAssertFalse(app.staticTexts["Welcome back"].exists,
                       "the sign-in form survived a successful sign-in")

        // The consequence — an account-gated task losing its remedy — is already
        // proven by testASignedInLaunchRendersItsAccountAndUngatesSend. Asserting
        // it again here would only add a tab switch that can fail for reasons
        // that have nothing to do with signing in.
    }

    /// Nearby's transfer type is two different tasks, not a label.
    ///
    /// Files stages a selection before any device is chosen; Text stages nothing
    /// and must not leave the file surface behind, or the user would be looking
    /// at a pending send that the mode they picked cannot perform.
    func testNearbyTransferTypeChangesWhatIsStaged() {
        openTask("Nearby", title: "Nearby")

        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15),
                      "Nearby's file mode stages nothing")

        let modes = app.segmentedControls.firstMatch
        XCTAssertTrue(modes.waitForExistence(timeout: 10),
                      "Nearby offers no transfer type choice")
        modes.buttons["Text"].tap()
        XCTAssertFalse(chooser.waitForExistence(timeout: 3),
                       "choosing Text left the file staging surface behind")

        modes.buttons["Files"].tap()
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "returning to Files did not restore its staging surface")
    }

    /// An upload that fails mid-transfer keeps the work and offers to carry on.
    ///
    /// The staged bytes are already on this device, so a server-side failure is
    /// recoverable — starting over would spend the user's time and bandwidth
    /// twice for nothing. Nothing before this drove an upload failure at all;
    /// the cell was covered only by the signed-out account remedy.
    func testAFailedUploadKeepsTheWorkAndOffersToCarryOn() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-pending-fixture",
               "--relayium-ui-testing-fail-upload"]
        app.launch()

        openTask("Send", title: "Send files")
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15))
        scrollUntilHittable(chooser)
        chooser.tap()
        let browsingTabs = app.tabBars["DOC.browsingModeTabBar"]
        XCTAssertTrue(browsingTabs.waitForExistence(timeout: 20))
        browsingTabs.buttons["Browse"].tap()
        tapInBrowser("On My iPhone")
        tapInBrowser("Relayium")
        tapStagedFixture(named: "Relayium product brief")
        let open = app.buttons["Open"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        open.tap()

        let send = app.scrollViews.buttons["Send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 15))
        scrollUntilHittable(send, maxSwipes: 10)
        send.tap()

        // Resume, not "start again": the recovery on offer has to be the one
        // that keeps what was already staged.
        let resume = app.buttons["Resume upload"]
        XCTAssertTrue(resume.waitForExistence(timeout: 30),
                      "a failed upload does not offer to carry on")
        XCTAssertTrue(app.buttons["Discard saved copy"].exists,
                      "a failed upload cannot be abandoned either")
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "#k=")).count, 0,
            "a failed upload produced a capability link anyway")
    }

    /// Creating a FILE pairing code stays on Direct and shows every handoff,
    /// with the mode the user actually chose preserved in the link.
    ///
    /// macOS proved this one batch earlier and the assertion it produced was not
    /// the one I would have written from memory: the link carries `mode=file`,
    /// not `mode=files`. iOS gets the same path rather than inheriting the claim.
    func testCreatingAFilePairingCodeStaysOnDirectAndShowsEveryHandoff() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-pending-fixture",
               "--relayium-ui-testing-file-code"]
        app.launch()

        let directTab = openTask("Direct", title: "Direct")
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15),
                      "Direct's file mode stages nothing")
        scrollUntilHittable(chooser)
        chooser.tap()

        let browsingTabs = app.tabBars["DOC.browsingModeTabBar"]
        XCTAssertTrue(browsingTabs.waitForExistence(timeout: 20))
        browsingTabs.buttons["Browse"].tap()
        tapInBrowser("On My iPhone")
        tapInBrowser("Relayium")
        tapStagedFixture(named: "Relayium product brief")
        let open = app.buttons["Open"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        open.tap()

        let create = app.buttons["Create a code"]
        XCTAssertTrue(create.waitForExistence(timeout: 15),
                      "a staged file offers no way to create a code")
        scrollUntilHittable(create, maxSwipes: 10)
        create.tap()

        XCTAssertTrue(app.staticTexts["4 8 3 9 2 0"].waitForExistence(timeout: 20),
                      "the generated pairing code is not visible")
        XCTAssertTrue(directTab.isSelected,
                      "creating a file code navigated away from Direct")
        XCTAssertTrue(app.staticTexts["Join link"].exists,
                      "the generated code has no visible browser handoff")
        XCTAssertTrue(app.staticTexts[
            "https://relayium.com/cross-network?mode=file#c=483920"
        ].exists, "the visible handoff did not preserve the created Files mode")
        XCTAssertTrue(app.buttons["Copy"].exists, "the join link cannot be copied")
        XCTAssertTrue(app.buttons["Share"].exists,
                      "the join link cannot use the system share sheet")
    }

    /// A stored link that resolves and downloads, ending on a result the user
    /// can act on.
    ///
    /// Every earlier Open a link path stopped at a refusal. This one carries a
    /// key that actually decrypts what the fixture serves — the ciphertext is
    /// produced by the production encryptor — so the manifest, the frame format
    /// and the key handling are all exercised rather than asserted about.
    func testOpeningAValidStoredLinkDownloadsAndNamesTheResult() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + ["--relayium-ui-testing-sign-in"]
        app.launch()

        openTask("Receive", title: "Receive files")
        let link = app.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        link.tap()
        link.typeText(
            "https://relayium.com/d/obj_uitest#k=ERERERERERERERERERERERERERERERERERERERERERE")

        let open = app.buttons["Open"]
        XCTAssertTrue(open.isEnabled, "a complete link cannot be opened")
        scrollUntilHittable(open)
        open.tap()

        // The result names the file the manifest carried — the server never saw
        // that name, so rendering it proves the manifest decrypted here.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "brief.txt")).firstMatch
            .waitForExistence(timeout: 40),
            "a completed download did not name what it received")
    }

    /// Every shipped language renders, in the running app.
    ///
    /// `LocalizedCopyTests` proves the catalogs line up and that `ErrorCopy` in
    /// Arabic is Arabic — through the model seams, and its own header says so.
    /// What no test asserted is that a launch in each language produces a shell
    /// whose destinations are in that language: a missing bundle, a resource not
    /// copied into the app, or a language the shell never asks for all look
    /// exactly like a correct catalog from inside the package.
    func testEveryShippedLanguageRendersItsOwnShell() {
        let shipped = [
            ("en", "Nearby"), ("zh-Hans", "附近设备"), ("ja", "近くのデバイス"),
            ("ko", "근처 기기"), ("de", "In der Nähe"), ("fr", "À proximité"),
            ("ar", "الأجهزة القريبة"), ("es", "Cerca"), ("pt", "Por perto"),
        ]
        for (code, nearby) in shipped {
            app.terminate()
            app.launchArguments = ["--relayium-ui-testing",
                                   "-AppleLanguages", "(\(code))",
                                   "-AppleLocale", code]
            app.launch()
            let tabs = app.tabBars.firstMatch
            XCTAssertTrue(tabs.waitForExistence(timeout: 20),
                          "\(code) did not produce a shell at all")
            XCTAssertTrue(tabs.buttons[nearby].waitForExistence(timeout: 10),
                          "\(code) rendered a shell that is not in \(code)")
        }
    }

    /// An Arabic launch lays the shell out right-to-left, not merely in Arabic.
    ///
    /// Translated strings in a left-to-right layout is the failure mode that
    /// looks fine in a screenshot review and is wrong for every RTL reader: the
    /// first destination sits where the last one should. Geometry is what
    /// distinguishes them, so geometry is what this asserts — by ORDER rather
    /// than by label, so it cannot pass or fail on a translation changing.
    func testAnArabicLaunchLaysTheShellOutRightToLeft() {
        app.terminate()
        app.launchArguments = ["--relayium-ui-testing",
                               "-AppleLanguages", "(ar)", "-AppleLocale", "ar"]
        app.launch()

        let tabs = app.tabBars.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 20))
        let ordered = tabs.buttons.allElementsBoundByIndex
        XCTAssertGreaterThanOrEqual(ordered.count, 2,
                                    "the Arabic shell rendered fewer destinations than it has")
        XCTAssertGreaterThan(ordered[0].frame.minX, ordered[ordered.count - 1].frame.minX,
                             "an Arabic launch laid the tab bar out left-to-right")
    }

    /// At the largest accessibility text size every task still reaches its own
    /// primary action.
    ///
    /// This is the small-screen failure that matters on iOS: not a narrower
    /// device, but text three times the size on the same one. A control pushed
    /// past the bottom of a screen does not fail loudly — and the control that
    /// falls off is usually the one the task ends with. Several surfaces in this
    /// product were rearranged for exactly this reason; nothing asserted it.
    func testEveryTaskReachesItsActionAtTheLargestTextSize() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["-UIPreferredContentSizeCategoryName",
               "UICTContentSizeCategoryAccessibilityXXL"]
        app.launch()

        // Receive's Open, Direct's mode choice and Nearby's chooser are the three
        // that sit furthest down their own screens.
        openTask("Receive", title: "Receive files")
        let open = app.buttons["Open"]
        XCTAssertTrue(open.waitForExistence(timeout: 15),
                      "Receive lost its action at the largest text size")
        scrollUntilHittable(open, maxSwipes: 12)

        openTask("Nearby", title: "Nearby")
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15),
                      "Nearby lost its file chooser at the largest text size")
        scrollUntilHittable(chooser, maxSwipes: 12)

        openTask("Account", title: "Account")
        let create = app.buttons["New to Relayium? Create an account"]
        XCTAssertTrue(create.waitForExistence(timeout: 15),
                      "Account lost its registration path at the largest text size")
        scrollUntilHittable(create, maxSwipes: 12)
    }

}
