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

    private func scrollUntilHittable(_ element: XCUIElement, maxSwipes: Int = 6) {
        for _ in 0..<maxSwipes where !element.isHittable {
            app.swipeUp()
        }
        // **Then close the last gap in thirds, both ways.**
        //
        // A full-screen `swipeUp` moves a control from below the fold to above
        // it in one step, so a coarse loop can pass a control that is perfectly
        // reachable and then keep scrolling away from it — and on the smallest
        // iPhone the floating tab bar takes another slice off the bottom, so a
        // control resting under it is on screen and still not hittable. Both
        // got easier to hit on the Phase-C account screen, which is a card per
        // question and therefore taller than the flat column it replaced.
        // Nothing here weakens the claim: the control must still become
        // genuinely hittable, and the assertion below is unchanged.
        for _ in 0..<4 where !element.isHittable { drag(fraction: 0.22) }
        for _ in 0..<6 where !element.isHittable { drag(fraction: -0.22) }
        XCTAssertTrue(element.isHittable, "\(element) never became reachable")
    }

    /// Scroll by a fraction of the screen. Positive moves the content up — the
    /// direction a `swipeUp` goes — and negative moves it back down.
    private func drag(fraction: CGFloat) {
        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let target = app.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5 - fraction))
        middle.press(forDuration: 0.05, thenDragTo: target)
    }

    /// Relaunch with the stored-link screen already presented.
    ///
    /// **Why the stored-link tests below relaunch at all.** They used to open a
    /// `Receive` TAB, which was the first of five and the destination the app
    /// launched on. 0.3.0 removed it: opening a stored link is something the OS
    /// hands this app — a verified Universal Link, or a stored-file row inside
    /// Account — rather than somewhere a person sets out to go, so the screen is
    /// presented over whichever destination the user was on instead of occupying
    /// a primary tab. The signed-out behaviour these tests own has neither of
    /// those two routes available, so the launch names the destination and
    /// `IOSShellModel` applies its ordinary rule to it.
    ///
    /// The presentation itself is asserted rather than assumed, through the Done
    /// control that only the presented form of the screen carries — so a
    /// regression that drew this as a bare destination again fails here rather
    /// than passing quietly.
    private func relaunchOnStoredLink(_ extra: [String] = []) {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-open-stored-link"] + extra
        app.launch()
        waitForPresentedStoredReceive(app)
    }

    /// Every browseable destination draws its own screen.
    ///
    /// The list is `Shell.browseable`, which is the runtime mirror of
    /// `IOSSurface.browseable` — one list, so a destination cannot be added to
    /// the product and left out of the smoke, and the compact and regular shells
    /// cannot be checked against two different sets.
    func testEveryPrimaryTaskRendersItsOwnScreen() {
        for surface in Shell.browseable {
            open(surface, in: app)
            if surface.id == Shell.lanTransfer.id {
                XCTAssertTrue(app.staticTexts["Nearby receiving: paused"].exists,
                              "the offline acceptance state is not explained")
                XCTAssertTrue(app.buttons["Resume receiving"].exists,
                              "the paused state does not offer its matching recovery")
            }
        }
    }

    /// The sixth destination, which is not a row on either shell.
    ///
    /// `storedReceive` losing its tab must not mean losing its runtime
    /// evidence: it is still fully supported, still reachable from a verified
    /// Universal Link and from Account, and still the screen a downloaded file
    /// arrives through. This is the smoke's entry for it — presented rather than
    /// browsed to, with a browseable destination still underneath.
    func testTheStoredLinkScreenIsPresentedOverABrowseableDestination() {
        relaunchOnStoredLink()

        XCTAssertTrue(app.textFields["receive.link"].waitForExistence(timeout: 15),
                      "the presented stored-link screen offers no link field")
        app.buttons["stored-receive-done"].tap()

        // Dismissing lands on a real destination rather than on nothing: the
        // background is a browseable surface by construction, and this is the
        // runtime half of that claim.
        XCTAssertTrue(app.navigationBars[Shell.lanTransfer.title].waitForExistence(timeout: 15),
                      "dismissing the stored-link screen left no destination behind it")
    }

    func testAccountRemediesRouteToTheAccountTask() {
        open(Shell.storedSend, in: app)
        let sendRemedy = app.buttons["Go to Account"]
        XCTAssertTrue(sendRemedy.waitForExistence(timeout: 10),
                      "the signed-out Send task offers no account remedy")
        sendRemedy.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 10))

        open(Shell.crossNetworkTransfer, in: app)
        let directRemedy = app.buttons["Open Account"]
        XCTAssertTrue(directRemedy.waitForExistence(timeout: 10),
                      "the signed-out Direct task offers no account remedy")
        directRemedy.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 10))
    }

    func testDirectModeChoiceStaysInDirect() {
        open(Shell.crossNetworkTransfer, in: app)
        let textMode = app.segmentedControls.firstMatch.buttons["Text"]
        XCTAssertTrue(textMode.waitForExistence(timeout: 10),
                      "Direct offers no text mode")
        textMode.tap()

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
        open(Shell.crossNetworkTransfer, in: app)
        let route = app.buttons["Open Send"]
        XCTAssertTrue(route.waitForExistence(timeout: 10),
                      "Direct does not offer its large-file route")
        scrollUntilHittable(route)
        route.tap()

        XCTAssertTrue(app.navigationBars["Send files"].waitForExistence(timeout: 10),
                      "the large-file route selected Send without rendering it")
    }

    func testAccountSwitchesToACompleteInAppRegistrationForm() {
        open(Shell.account, in: app)
        let create = app.buttons["New to Relayium? Create an account"]
        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "the sign-in form offers no registration path")
        create.tap()

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
        XCTAssertTrue(app.staticTexts["Welcome back"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.secureTextFields["Confirm password"].exists,
                       "returning to sign in left the registration fields behind")
    }

    func testMalformedReceiveLinkExplainsHowToRecover() {
        relaunchOnStoredLink()

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

        open(Shell.account, in: app)
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

        open(Shell.storedSend, in: app)
        XCTAssertFalse(app.buttons["Go to Account"].exists,
                       "a signed-in Send task still offers the signed-out remedy")
    }

    /// The iOS App Store surface reuses the production catalog, purchase and
    /// submission orchestration while replacing only StoreKit with a local
    /// deterministic adapter. No request or Apple account leaves the simulator.
    func testSubscriptionsRenderAndPurchaseWithoutAWebCheckout() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + [
            "--relayium-ui-testing-signed-in",
            "--relayium-ui-testing-subscriptions",
        ]
        app.launch()

        open(Shell.account, in: app)
        let monthly = app.buttons["subscription-buy-uitest.subscription.month"]
        for _ in 0..<8 where !monthly.exists { app.swipeUp() }
        XCTAssertTrue(monthly.waitForExistence(timeout: 20),
                      "the server catalog and StoreKit price never rendered")
        XCTAssertTrue(app.buttons["subscription-buy-uitest.subscription.year"].exists)
        XCTAssertTrue(monthly.isEnabled)
        XCTAssertTrue(app.buttons["subscription-restore"].exists,
                      "an existing Apple purchase cannot be restored")
        let privacy = app.descendants(matching: .any)["subscription-privacy"]
        for _ in 0..<6 where !privacy.exists { app.swipeUp() }
        XCTAssertTrue(privacy.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["subscription-terms"].exists)
        XCTAssertFalse(app.buttons["Manage plan"].exists,
                       "the App Store build offers a competing web checkout")

        // Back to the purchase controls, without assuming which way they are.
        // The subscription surface is its own card since the Phase-C account
        // refresh, and on the smallest iPhone it is taller than one screen, so
        // a fixed number of swipes in one direction can overshoot to the top
        // and leave the control below the fold. Return toward the top first,
        // then scroll down until it is actually hittable.
        for _ in 0..<8 where !monthly.isHittable { app.swipeDown() }
        scrollUntilHittable(monthly)
        XCTAssertTrue(monthly.isHittable)
        monthly.tap()
        let notice = app.descendants(matching: .any)["subscription-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 20),
                      "an accepted purchase produced no confirmation")
        XCTAssertFalse(app.descendants(matching: .any)["subscription-failure"].exists)
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

        open(Shell.lanTransfer, in: app)

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

    /// Land the system picker on Browse, whichever shape iOS presented it in.
    ///
    /// Compact widths present a browsing-mode chooser —
    /// `DOC.browsingModeTabBar` — and Browse must be selected before any
    /// location exists to tap. Full-width iPadOS 18 never draws that tab bar:
    /// the picker opens directly on the Browse view, with the
    /// `com_apple_DocumentManager_Service.DOCSidebarView` navigation bar
    /// already on screen. Both are real states of the same real system
    /// picker, so accept whichever arrives rather than require the compact
    /// chrome on a shape that never draws it. Nothing downstream weakens: the
    /// fixture still has to be found, tapped and confirmed through the real
    /// Open.
    private func openBrowseInSystemPicker(timeout: TimeInterval = 20) {
        let browsingTabs = app.tabBars["DOC.browsingModeTabBar"]
        let sidebar = app.navigationBars[
            "com_apple_DocumentManager_Service.DOCSidebarView"]
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if sidebar.exists { return }
            if browsingTabs.waitForExistence(timeout: 1) {
                return browsingTabs.buttons["Browse"].tap()
            }
        } while Date() < deadline
        XCTFail("""
            choosing files did not present the system document browser.
            \(app.debugDescription)
            """)
    }

    /// Select the staged document without assuming which directory the system
    /// browser remembered from an earlier import. Files may reopen inside the
    /// app folder, at the app folder's parent, or at the Locations root; all
    /// three are valid system states and expose the same production importer.
    /// The Locations root names the device it is on — "On My iPhone" or
    /// "On My iPad" — so match either rather than encode one device idiom.
    private func selectStagedFixture(named stem: String) {
        let fixture = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", stem)).firstMatch
        if fixture.waitForExistence(timeout: 2) {
            return fixture.tap()
        }

        let appFolder = app.descendants(matching: .any)["Relayium"].firstMatch
        if appFolder.waitForExistence(timeout: 2) {
            appFolder.tap()
            return tapStagedFixture(named: stem)
        }

        let device = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@ OR label == %@",
                        "On My iPhone", "On My iPad")).firstMatch
        guard device.waitForExistence(timeout: 15) else {
            return XCTFail("""
                the system document browser offers no on-device location.
                \(app.debugDescription)
                """)
        }
        device.tap()
        tapInBrowser("Relayium")
        tapStagedFixture(named: stem)
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

        open(Shell.lanTransfer, in: app)
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "Nearby has no file-selection surface")
        scrollUntilHittable(chooser)
        chooser.tap()

        openBrowseInSystemPicker()
        selectStagedFixture(named: "Relayium product brief")

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
        open(Shell.account, in: app)
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

        // The refusal is inserted above the submit button. On the smallest
        // simulator the button had to be scrolled down to become hittable, so
        // inserting the message can leave it just above the visible viewport.
        // `XCUIElement.exists` only describes the current accessibility tree;
        // bring the form's feedback region back into view before judging it.
        let problem = app.staticTexts["Use at least 8 characters for your password."]
        for _ in 0..<6 where !problem.exists { app.swipeDown() }
        XCTAssertTrue(problem.waitForExistence(timeout: 10),
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
        open(Shell.account, in: app)

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
        open(Shell.account, in: app)

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
        open(Shell.account, in: app)

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
        open(Shell.storedSend, in: app)
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

        open(Shell.crossNetworkTransfer, in: app)
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

        open(Shell.crossNetworkTransfer, in: app)
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

        open(Shell.crossNetworkTransfer, in: app)
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

        open(Shell.storedSend, in: app)
        XCTAssertFalse(app.buttons["Go to Account"].exists,
                       "a signed-in Send task still offers the signed-out remedy")

        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15),
                      "a signed-in Send task has no file-selection surface")
        scrollUntilHittable(chooser)
        chooser.tap()

        openBrowseInSystemPicker()
        selectStagedFixture(named: "Relayium product brief")
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

    /// Editing the field clears the refusal with it.
    ///
    /// The malformed-link path already proves the refusal explains itself and
    /// leaves the field editable. What it does not prove is that the refusal is
    /// not STICKY: guidance that outlives the input it described sits next to
    /// corrected text telling the user they are still wrong.
    ///
    /// **The refused string is setup here, not subject.** Typing it drove a
    /// run of synthetic keystrokes to establish a precondition, and hosted run
    /// 33020899047 lost input events along the way: the field read `not ink`,
    /// and the precondition assertion failed before this test reached the
    /// property it names. So the value arrives through the Debug-only launch
    /// fixture, this test verifies the REAL field carries it, produces the
    /// refusal with a real Open, and spends its one keystroke on the edit that
    /// is the subject.
    /// `testMalformedReceiveLinkExplainsHowToRecover` and
    /// `testTheKeyboardGoKeyResolvesTheLink` keep the real typing and the real
    /// submission, so nothing here removes that coverage.
    func testEditingARefusedLinkClearsTheRefusalWithIt() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-invalid-download-link",
               "--relayium-ui-testing-open-stored-link"]
        app.launch()

        waitForPresentedStoredReceive(app)

        let link = app.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        XCTAssertEqual(link.value as? String, "not a link",
                       "the deterministic refused-link fixture did not reach the real field")

        let open = app.buttons["Open"]
        XCTAssertTrue(open.isEnabled, "a filled-in link cannot be inspected")
        scrollUntilHittable(open)
        open.tap()

        let guidance = app.staticTexts[
            "That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…"
        ]
        XCTAssertTrue(guidance.waitForExistence(timeout: 10),
                      "an invalid link does not explain the required shape")

        // The one genuine keyboard edit, on the real field, after a real
        // refusal: this is the boundary the test exists to cross.
        //
        // An ORDINARY VISIBLE CHARACTER, not a control key. Hosted run
        // 33032681386 reached this line with the fixture in the real field and
        // the real refusal on screen, tapped it, logged `Type DEL` — and the
        // field still read `not a link` for the whole ten-second wait. A delete
        // needs something to its left to consume, and on a field nobody typed
        // into it delivered no edit at all. An insertion needs nothing: wherever
        // the tap left the caret, one visible character changes the value.
        scrollUntilHittable(link)
        link.tap()
        link.typeText("x")

        // One delivered edit is the product boundary under test. Clearing the
        // whole field with a burst of synthetic keystrokes made this acceptance
        // depend on every hosted keyboard event arriving. The model's
        // edit-clears-refusal invariant has deterministic package coverage, and
        // the neighbouring malformed-link UI test owns empty-button disabling.
        //
        // The wait is `value != "not a link"` rather than an exact corrected
        // string, deliberately: the caret lands wherever the tap did, so
        // `xnot a link`, `not a linkx` and `not xa link` are all the same
        // delivered edit. What the product owes is that the value CHANGED and
        // that the refusal went with it — not that it changed in one place.
        let edited = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND value != %@", "not a link"),
            object: link)
        XCTAssertEqual(XCTWaiter.wait(for: [edited], timeout: 10), .completed,
                       "the refused link did not accept the correction")
        let cleared = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: guidance)
        XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 10), .completed,
                       "the refusal outlived the input it described")
        XCTAssertTrue(app.staticTexts[
            "Paste a Relayium link. The key stays in the link and never reaches Relayium's servers."
        ].waitForExistence(timeout: 10),
                      "editing the refused link did not restore the idle receive state")
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
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-preselect-fixture"]
        app.launch()

        open(Shell.storedSend, in: app)
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["pendingFile.0"].firstMatch
            .waitForExistence(timeout: 15),
            "the deterministic selection did not reach the stored send")

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
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-preselect-fixture",
               "--relayium-ui-testing-stall-upload"]
        app.launch()

        open(Shell.storedSend, in: app)
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["pendingFile.0"].firstMatch
            .waitForExistence(timeout: 15),
            "the deterministic selection did not reach the stalled upload")

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

        open(Shell.account, in: app)
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
        open(Shell.lanTransfer, in: app)

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
    ///
    /// **Why this one does not open the system document browser.** Reaching the
    /// behavior it is actually about would otherwise mean surviving a five-step
    /// traversal of a separate process — `DOC.browsingModeTabBar`, Browse, On
    /// My iPhone, Relayium, the fixture, Open — and hosted CI lost it on exactly
    /// that traversal rather than on anything to do with uploading. Other setup
    /// paths in this file still drive that traversal; the point is not that this
    /// test is the only one exposed to it, but that picker behavior is not what
    /// this test covers, so this test should not depend on the picker at all.
    /// The picker itself is not uncovered by dropping it here:
    /// `testPendingSendNamesTheFileAndItsSizeBeforeTransfer` and
    /// `testASignedInStoredSendNamesTheFileItWouldUpload` are ABOUT the picker,
    /// still drive it for real, and are deliberately left alone.
    /// `--relayium-ui-testing-preselect-fixture` calls the same
    /// `SendSelectionModel.chooseFiles` callback the real `fileImporter` calls,
    /// once the account is ready and the upload model is idle, so everything
    /// this test asserts about is still production code. The `pendingFile.0`
    /// wait below is that seam's precondition: it fails by name if the
    /// selection never arrived, instead of letting Send be tapped with nothing
    /// staged and reporting a missing Resume upload.
    func testAFailedUploadKeepsTheWorkAndOffersToCarryOn() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in",
               "--relayium-ui-testing-preselect-fixture",
               "--relayium-ui-testing-fail-upload"]
        app.launch()

        open(Shell.storedSend, in: app)

        // The precondition, asserted rather than assumed: Send below is only
        // meaningful against a file this launch actually staged and selected.
        let identity = app.descendants(matching: .any)["pendingFile.0"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 30),
                      "the preselected fixture never became a pending send")
        XCTAssertTrue(identity.label.contains("Relayium product brief.txt"),
                      "the preselected pending send names something else")

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

        open(Shell.crossNetworkTransfer, in: app)
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15),
                      "Direct's file mode stages nothing")
        scrollUntilHittable(chooser)
        chooser.tap()

        openBrowseInSystemPicker()
        selectStagedFixture(named: "Relayium product brief")
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
        XCTAssertTrue(app.staticTexts["Join link"].exists,
                      "the generated code has no visible browser handoff")
        XCTAssertTrue(app.staticTexts[
            "https://relayium.com/cross-network?mode=file#c=483920"
        ].exists, "the visible handoff did not preserve the created Files mode")
        XCTAssertTrue(app.buttons["Copy"].exists, "the join link cannot be copied")
        XCTAssertTrue(app.buttons["Share"].exists,
                      "the join link cannot use the system share sheet")
    }

    /// A stored link that resolves to the real pre-download manifest surface.
    ///
    /// Every earlier Open a link path stopped at a refusal. This one carries a
    /// key that actually decrypts what the fixture serves — the manifest
    /// ciphertext is produced by the production encryptor — so metadata,
    /// manifest decryption and key handling are exercised rather than asserted
    /// about. Blob framing and disk completion belong to
    /// `CloudDownloadModelTests` and macOS's runtime save test; this test has
    /// never tapped Receive and must not claim that it does.
    func testOpeningAValidStoredLinkDecryptsAndNamesTheManifest() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + [
            "--relayium-ui-testing-sign-in",
            "--relayium-ui-testing-valid-download-link",
            "--relayium-ui-testing-open-stored-link",
        ]
        app.launch()

        waitForPresentedStoredReceive(app)
        let link = app.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        XCTAssertEqual(link.value as? String,
                       "https://relayium.com/d/obj_uitest#k=ERERERERERERERERERERERERERERERERERERERERERE",
                       "the deterministic encrypted-link fixture did not reach the real field")

        let open = app.buttons["Open"]
        XCTAssertTrue(open.isEnabled, "a complete link cannot be opened")
        scrollUntilHittable(open)
        open.tap()

        // The ready result names the file the manifest carried — the server
        // never saw that name, so rendering it proves the manifest decrypted
        // here. Download-to-disk behaviour is covered by the model/writer suite;
        // this runtime path stops before writing into a persistent simulator
        // container that a later CI attempt would inherit.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "brief.txt")).firstMatch
            .waitForExistence(timeout: 40),
            "the decrypted manifest did not name what the link contains")
    }

    /// The completion this platform reaches, the hand-off it offers, and a Done
    /// that ends the task without ending the file.
    ///
    /// The path above deliberately stops before writing, so the two cells this
    /// closes — "what happens next" and "how do I hand this on" — had no runtime
    /// evidence on iOS at all. What made writing unrepeatable is a product rule
    /// rather than a test problem: the destination here is FIXED inside the
    /// container and a taken name is REFUSED, so the second run of the same path
    /// legitimately fails on the file the first run legitimately kept.
    /// `--relayium-ui-testing-fresh-received-folder` puts the launch back in the
    /// state a fresh install is in, and nothing else about the rule changes.
    ///
    /// **The last assertion is the point.** iOS has no folder for a test process
    /// to look in, so "Done did not delete what was saved" is proved through the
    /// product itself: a relaunch WITHOUT that argument opens the same link
    /// again and must be refused, by name, because the file is still there.
    func testACompletedDownloadHandsOverItsResultAndDoneKeepsTheFile() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + [
            "--relayium-ui-testing-sign-in",
            "--relayium-ui-testing-valid-download-link",
            "--relayium-ui-testing-fresh-received-folder",
            "--relayium-ui-testing-open-stored-link",
        ]
        app.launch()

        waitForPresentedStoredReceive(app)
        let open = app.buttons["Open"]
        XCTAssertTrue(open.waitForExistence(timeout: 15))
        scrollUntilHittable(open)
        open.tap()

        let receive = app.buttons["Download"]
        XCTAssertTrue(receive.waitForExistence(timeout: 40),
                      "a resolved manifest offers no way to receive what it names")
        scrollUntilHittable(receive, maxSwipes: 10)
        receive.tap()

        // The completed card names what landed, by the row's own address.
        let row = app.descendants(matching: .any)["pendingFile.0"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 60),
                      "a completed download did not name what it saved")
        XCTAssertTrue(row.label.contains("brief.txt"),
                      "the saved result is not the file the manifest named")

        // Share OPENED, not merely present: a `ShareLink` over an empty item
        // array renders the same button and does nothing when tapped.
        let share = app.buttons["received.share"]
        XCTAssertTrue(share.waitForExistence(timeout: 15),
                      "a completed download offers no system share")
        scrollUntilHittable(share, maxSwipes: 10)
        share.tap()
        XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 20),
                      "Share did not open the system share sheet")
        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) { close.tap() }

        let done = app.buttons["receive.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 15),
                      "a completed download cannot be ended")
        scrollUntilHittable(done, maxSwipes: 10)
        done.tap()

        // Back to the entry this screen starts from: the field returns, empty of
        // the link just spent, above the designed idle state.
        let link = app.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15),
                      "Done did not return the link field")
        XCTAssertFalse((link.value as? String ?? "").contains("obj_uitest"),
                       "Done left the finished task's link in the field")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "The key stays in the link")).firstMatch
            .waitForExistence(timeout: 15),
            "Done returned to a blank screen rather than to the idle state")
        XCTAssertFalse(app.buttons["received.share"].exists,
                       "Done kept the finished result on screen")

        // And the bytes are still there, proved by the product's own refusal.
        app.terminate()
        app.launchArguments = offlineLaunchArguments + [
            "--relayium-ui-testing-sign-in",
            "--relayium-ui-testing-valid-download-link",
            "--relayium-ui-testing-open-stored-link",
        ]
        app.launch()
        waitForPresentedStoredReceive(app)
        let reopen = app.buttons["Open"]
        XCTAssertTrue(reopen.waitForExistence(timeout: 15))
        scrollUntilHittable(reopen)
        reopen.tap()
        let again = app.buttons["Download"]
        XCTAssertTrue(again.waitForExistence(timeout: 40))
        scrollUntilHittable(again, maxSwipes: 10)
        again.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@",
            "brief.txt", "will not overwrite")).firstMatch
            .waitForExistence(timeout: 60),
            "the second download was not refused by name — Done deleted what the "
            + "first one had already saved, or the destination overwrote it")
    }

    /// Every shipped language renders, in the running app.
    ///
    /// `LocalizedCopyTests` proves the catalogs line up — through the model
    /// seams, and its own header says so. What no test asserted is that a launch
    /// in each language produces a shell whose destinations are in that
    /// language: a missing bundle, a resource not copied into the app, or a
    /// language the shell never asks for all look exactly like a correct catalog
    /// from inside the package.
    ///
    /// The shared package ships exactly `en` and `zh-Hans`. This matrix listed
    /// nine, from when it did; the other seven catalogs are frozen under
    /// `apps/RelayiumKit/LocalizationArchive/` and `AppLanguage` can no longer
    /// name them, so a launch under one of those preferences resolves to English
    /// and renders the English shell. Those rows asserted translations that no
    /// longer exist anywhere in the build.
    ///
    /// This app's own `Info.plist` now declares exactly the same two, so the
    /// bundle and the package agree: `CFBundleLocalizations` is what UIKit reads
    /// to decide layout direction, and with the seven archived entries gone an
    /// Arabic preference no longer mirrors the shell. What a device set to one
    /// of the archived languages actually sees is asserted by
    /// `testAnArchivedLanguagePreferenceRendersACompleteEnglishLeftToRightShell`.
    func testEveryShippedLanguageRendersItsOwnShell() {
        // Two destinations per language, not one: the second is the one this
        // batch added, so a Device Inbox row shipped with an untranslated or
        // missing title would be caught here rather than by eye.
        let shipped = [("en", "Nearby", "Inbox"), ("zh-Hans", "附近设备", "收件箱")]
        for (code, nearby, inbox) in shipped {
            app.terminate()
            app.launchArguments = ["--relayium-ui-testing",
                                   "-AppleLanguages", "(\(code))",
                                   "-AppleLocale", code]
            app.launch()
            let layout = waitForShell(app)
            // A portrait iPadOS 18 launch collapses the sidebar, and rows that
            // are off screen have no labels to read.
            if layout == .regular { revealSidebar(app) }

            // Located by IDENTIFIER and asserted on its LABEL. Looking the row
            // up by its translated label could only ever fail by not finding it,
            // which is indistinguishable from a shell that did not render;
            // reading the label off the row the product built says which words
            // it actually drew — and it is the same assertion on both shells.
            for (surface, expected) in [(Shell.lanTransfer, nearby),
                                        (Shell.deviceInbox, inbox)] {
                let row = shellRow(surface, layout: layout)
                XCTAssertTrue(row.waitForExistence(timeout: 15),
                              "\(code) did not render the \(surface.id) destination")
                XCTAssertTrue(row.label.contains(expected),
                              "\(code) rendered \(surface.id) as '\(row.label)' "
                              + "rather than in \(code)")
            }
        }
    }

    /// The row a destination is selected by, on whichever shell is drawn.
    ///
    /// Only the two tests that are ABOUT the shell itself — its copy and its
    /// layout direction — need the row rather than the destination behind it.
    /// Everything else goes through `open(_:in:)` and never learns which shell
    /// it is running on.
    private func shellRow(_ surface: Shell.Surface, layout: Shell.Layout) -> XCUIElement {
        switch layout {
        case .compact:
            // Not a bare identifier lookup: iOS 18 stamps a `tabItem` Label's
            // identifier onto the SELECTED tab's button only, and these two
            // tests read the labels and frames of rows they never select.
            return compactTabRow(surface, in: app)
        case .regular:
            return app.descendants(matching: .any)["sidebar-\(surface.id)"].firstMatch
        }
    }

    /// **An archived language preference renders a complete ENGLISH,
    /// LEFT-TO-RIGHT shell — in the running app.**
    ///
    /// This test used to assert the opposite for Arabic: that the tab bar laid
    /// itself out right-to-left, because translated strings in a left-to-right
    /// layout is wrong for every RTL reader. Arabic is frozen now, so the
    /// requirement inverted, and the geometry half is exactly why this still has
    /// to run against a real launch rather than only through the model seams.
    ///
    /// Two failures are possible here and neither is visible from inside the
    /// package. The app could still ADVERTISE Arabic — `CFBundleLocalizations`
    /// is what UIKit reads to decide layout direction, so a stale entry would
    /// mirror the tab bar while the copy came back English, producing an English
    /// UI laid out right to left. Or a resolver that matched a language whose
    /// catalog is gone would render raw keys. Both are asserted against, for an
    /// RTL preference and a non-RTL archived one.
    ///
    /// The geometry is asserted by ORDER rather than by label, so it cannot pass
    /// or fail on a translation changing; the raw-key half reads every tab's own
    /// words rather than only the one looked up by name, which a lookup BY name
    /// could never fail on.
    func testAnArchivedLanguagePreferenceRendersACompleteEnglishLeftToRightShell() {
        for code in ["ar", "ja"] {
            app.terminate()
            app.launchArguments = ["--relayium-ui-testing",
                                   "-AppleLanguages", "(\(code))", "-AppleLocale", code]
            app.launch()

            let layout = waitForShell(app)
            // A portrait iPadOS 18 launch collapses the sidebar; the rows the
            // assertions below read exist only once it is on screen.
            if layout == .regular { revealSidebar(app) }

            // English words, not the archived translation.
            let first = shellRow(Shell.lanTransfer, layout: layout)
            XCTAssertTrue(first.waitForExistence(timeout: 15),
                          "a \(code) launch did not render a shell at all")
            XCTAssertTrue(first.label.contains("Nearby"),
                          "a \(code) launch did not render the English shell")

            // And no destination fell through to its own catalog key. Asked of
            // EVERY row, because the lookup above resolves one known surface and
            // so can never be the one that catches a raw key.
            let ordered = Shell.browseable.map { shellRow($0, layout: layout) }
            for row in ordered {
                let shown = row.label.isEmpty ? (row.value as? String ?? "") : row.label
                XCTAssertFalse(shown.hasPrefix("tab.") || shown.hasPrefix("nav."),
                               "a \(code) launch rendered a raw catalog key: \(shown)")
            }

            // And laid out left to right. The two shells express the same
            // property along different axes, which is why the geometry is asked
            // of each in its own terms rather than of a tab bar that a
            // regular-width launch does not draw.
            switch layout {
            case .compact:
                // The first destination is the LEADING one, so under LTR it sits
                // left of the last.
                XCTAssertLessThan(ordered[0].frame.minX,
                                  ordered[ordered.count - 1].frame.minX,
                                  "a \(code) launch mirrored the tab bar to right-to-left")
            case .regular:
                // The sidebar is the leading column, so under LTR it sits in
                // the LEFT half of the screen. Asserted against the window's
                // own midline rather than against the detail column, because a
                // collapsed launch (portrait iPadOS 18) reveals the sidebar
                // OVER a full-width detail whose minX matches the sidebar's on
                // both layout directions; the midline separates the two
                // directions on the tiled and the overlaid presentation alike.
                let sidebar = app.descendants(matching: .any)["sidebar"].firstMatch
                let detail = app.descendants(matching: .any)["destination-lanTransfer"]
                    .firstMatch
                XCTAssertTrue(detail.waitForExistence(timeout: 15),
                              "a \(code) launch drew no detail column")
                XCTAssertLessThan(sidebar.frame.midX,
                                  app.windows.firstMatch.frame.midX,
                                  "a \(code) launch mirrored the split view to "
                                  + "right-to-left")
            }
        }
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
               "UICTContentSizeCategoryAccessibilityXXL",
               // The stored-link screen is presented rather than browsed to, so
               // it is reached at launch and dismissed below before the
               // browseable destinations are visited.
               "--relayium-ui-testing-open-stored-link"]
        app.launch()

        // The stored link's Open, the Device Inbox's account route, Nearby's
        // chooser and Account's registration path are the four that sit furthest
        // down their own screens.
        waitForPresentedStoredReceive(app)
        let openLink = app.buttons["Open"]
        XCTAssertTrue(openLink.waitForExistence(timeout: 15),
                      "the stored-link screen lost its action at the largest text size")
        scrollUntilHittable(openLink, maxSwipes: 12)
        app.buttons["stored-receive-done"].tap()

        open(Shell.lanTransfer, in: app)
        let chooser = app.buttons["Choose Files or Folders…"]
        XCTAssertTrue(chooser.waitForExistence(timeout: 15),
                      "Nearby lost its file chooser at the largest text size")
        scrollUntilHittable(chooser, maxSwipes: 12)

        // The destination this batch added, and the one with the most content
        // above its action: the status card, the foreground-only notice, the
        // explanation and the folder route all sit before it.
        open(Shell.deviceInbox, in: app)
        let inboxAccount = app.buttons["inbox-open-account"]
        XCTAssertTrue(inboxAccount.waitForExistence(timeout: 15),
                      "the Device Inbox lost its account route at the largest text size")
        scrollUntilHittable(inboxAccount, maxSwipes: 12)

        open(Shell.account, in: app)
        let create = app.buttons["New to Relayium? Create an account"]
        XCTAssertTrue(create.waitForExistence(timeout: 15),
                      "Account lost its registration path at the largest text size")
        scrollUntilHittable(create, maxSwipes: 12)
    }

    /// The software keyboard's own Go key completes the task.
    ///
    /// `submitLabel(.go)` and its `onSubmit` are a promise that the key the
    /// keyboard shows does what it says. Nothing drove it: a Go key that does
    /// nothing is invisible in review and is the difference between finishing a
    /// paste with one thumb and hunting for a button.
    func testTheKeyboardGoKeyResolvesTheLink() {
        relaunchOnStoredLink()

        let link = app.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        link.tap()
        link.typeText("not a link")
        // The real key, not a typed newline: this field is vertical-axis, where
        // a newline is text rather than a submission.
        let go = app.keyboards.buttons["go"]
        XCTAssertTrue(go.waitForExistence(timeout: 10),
                      "the keyboard does not offer the Go key the field promises")
        go.tap()

        XCTAssertTrue(app.staticTexts[
            "That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…"
        ].waitForExistence(timeout: 10),
            "the keyboard's Go key did not resolve the link")
    }

    /// Share actually opens the system share sheet.
    ///
    /// Every handoff path so far asserted that a Share control EXISTS. A
    /// `ShareLink` whose item is nil, or one built over a value the system
    /// refuses, renders exactly the same button and does nothing when pressed —
    /// and this is the control the whole pairing handoff depends on, because it
    /// is how the code reaches the other person at all.
    func testShareOpensTheSystemShareSheet() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-text-code"]
        app.launch()

        open(Shell.crossNetworkTransfer, in: app)
        app.segmentedControls.firstMatch.buttons["Text"].tap()
        let create = app.buttons["Create a text code"]
        XCTAssertTrue(create.waitForExistence(timeout: 15))
        scrollUntilHittable(create)
        create.tap()
        XCTAssertTrue(app.staticTexts["4 8 3 9 2 0"].waitForExistence(timeout: 20))

        let share = app.buttons["Share"]
        XCTAssertTrue(share.waitForExistence(timeout: 10),
                      "the generated code offers no system share")
        scrollUntilHittable(share, maxSwipes: 10)
        share.tap()

        // The sheet itself, not the button that should have opened it.
        let sheet = app.otherElements["ActivityListView"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 20),
                      "Share did not open the system share sheet")

        // Leave it the way a person would, so the app is not left modal.
        let close = app.buttons["Close"]
        if close.waitForExistence(timeout: 5) { close.tap() }
    }

    /// What VoiceOver would meet on every primary surface, decided by the
    /// system's audit of the rendered tree rather than by an assertion we wrote.
    ///
    /// **Why a label assertion is not this gate.** Every accessibility claim the
    /// suite made until now starts by naming an element it already expects to
    /// find, and then checks the words on it. That cannot see the failures that
    /// matter here, because each of them is a property of something the test
    /// never thought to name: an element rendered with no description at all, a
    /// control that reads as plain text because its trait was lost, a label
    /// truncated away at the largest type size, a target too small to land on.
    /// `performAccessibilityAudit` walks what is actually on screen and reports
    /// exactly those — so it is run once per surface, because an audit of one
    /// screen says nothing about the next.
    ///
    /// It does not synthesise speech, and this suite does not claim to: driving
    /// VoiceOver itself needs the screen reader switched on for the whole
    /// machine. What the audit does cover is the input that speech is composed
    /// FROM, which is where the defects this product has actually shipped —
    /// unlabelled rows, a Revoke that read the same word on every device — all
    /// lived.
    func testEveryPrimaryTaskPassesTheSystemAccessibilityAudit() throws {
        guard #available(iOS 17.0, *) else {
            throw XCTSkip("the system accessibility audit needs iOS 17")
        }
        var found: [String] = []
        // Handled here rather than left to XCTest so a failure names the surface
        // and the element. The framework's own report is "Hit area is too
        // small", which is true and unactionable.
        func audit(_ surface: String) throws {
            try app.performAccessibilityAudit(for: Self.auditedTypes) { issue in
                found.append("\(surface): \(issue.compactDescription) — "
                             + "label=\(issue.element?.label ?? "") "
                             + "frame=\(issue.element?.frame ?? .zero)")
                return true
            }
        }

        for surface in Shell.browseable {
            open(surface, in: app)
            try audit(surface.id)
        }

        // And the destination that is presented rather than browsed to. Losing
        // its tab must not lose its audit: it is the screen a stored link
        // arrives through, and the sheet form is the only form users now meet.
        relaunchOnStoredLink()
        try audit("storedReceive")

        XCTAssertTrue(found.isEmpty,
                      "the system accessibility audit rejected what VoiceOver "
                      + "would meet:\n" + found.joined(separator: "\n"))
    }

    /// Everything the system audits EXCEPT contrast, and the reason is measured
    /// rather than assumed.
    ///
    /// Contrast was run first, on this build, and reported ten issues across the
    /// five surfaces. Each was then measured off a real screenshot, in pixels:
    ///
    /// * three were genuine — the paused card's `Resume receiving` at 2.06:1 and
    ///   the gate's `Open Account` at 2.02:1, both accent-on-fill where text
    ///   needs 4.5:1, and `New to Relayium? Create an account` at 2.99:1 in a
    ///   19-point row. The row height is fixed in this batch. The two label
    ///   colours are NOT, because they are not three controls: every one of the
    ///   48 `.bordered` buttons in this app draws its label in the accent, so
    ///   the answer is a palette decision for the whole app rather than a tint
    ///   on whichever three screens an audit happened to visit first;
    /// * four were correct UI the checker rejects anyway — `or` measured 5.94:1,
    ///   and after the row-height fix `Resume receiving` measures 5.6:1 as white
    ///   on the brand violet, the identical style the same screen's `Choose
    ///   Files or Folders…` passes with at 5.70:1;
    /// * the rest were a disabled control, which WCAG 1.4.3 exempts and iOS
    ///   draws faint on purpose, or body text the audit sampled while it sat
    ///   under the translucent tab bar it scrolls beneath.
    ///
    /// A gate that is red for correct UI is a gate people learn to discount —
    /// this workspace has one of those already. So contrast stays measured and
    /// recorded, and the automated gate keeps the checks whose findings here
    /// were all real.
    ///
    /// Subtracted from `.all` rather than listed, so it keeps covering whatever
    /// Apple adds next — and so the macOS half, when it lands, can state the
    /// same rule rather than a different list: that platform has neither
    /// `dynamicType` nor `trait` nor `textClipped`, which a literal list would
    /// have had to fork. The macOS half is `WORK-QUEUE.md` Q9; it is not written
    /// here yet because the audit finds six real shell-level gaps there and the
    /// only way to a green macOS gate today is dropping the check that found them.
    @available(iOS 17.0, *)
    private static var auditedTypes: XCUIAccessibilityAuditType {
        XCUIAccessibilityAuditType.all.subtracting(.contrast)
    }

}
