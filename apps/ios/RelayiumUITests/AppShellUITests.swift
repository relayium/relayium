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

}
