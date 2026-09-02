import XCTest

/// **Runtime evidence for the destination iOS 0.3.0 added, on the device shape
/// most people will meet it on.**
///
/// The Device Inbox has package coverage for everything a package can reach —
/// `IOSInboxReceiveTests`, `IOSInboxConversationTests`, `IOSInboxCopyTests` and
/// `IOSShellPlacementTests` drive the controller, the entry mapping, the copy
/// and the placement rule. None of them can see a tab that renders nothing, a
/// gate whose button goes nowhere, or a screen whose content builds into a blank
/// page — which is exactly the class of defect that reached a real UI run in this
/// batch and that `build-for-testing` cannot catch.
///
/// Compact width only. The regular-width shell draws the same destination
/// through the same `destination(for:)` call, and `AdaptiveShellUITests` is
/// where the layout itself is the subject; running these twice would assert the
/// same product facts and pay for them on two simulators.
final class DeviceInboxShellUITests: XCTestCase {
    private var app: XCUIApplication!

    /// Every assertion below names a rendered English string, so the language
    /// and locale are pinned rather than inherited from whatever a runner's
    /// simulator was last left in — the same thing `AppShellUITests` does.
    private let offlineLaunchArguments = [
        "--relayium-ui-testing", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
    ]

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = offlineLaunchArguments
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// Launch, and skip on a shell this class is not about.
    ///
    /// A skip rather than a silent pass: it is visible in the result bundle, so
    /// an iPad-only run cannot look like it covered the compact Device Inbox.
    private func launchCompact(_ extra: [String] = []) throws {
        app.launchArguments = offlineLaunchArguments + extra
        app.launch()
        guard waitForShell(app) == .compact else {
            throw XCTSkip("the compact Device Inbox surface needs a compact-width shell")
        }
    }

    // MARK: - the destination exists at all

    /// The Device Inbox is one of the five destinations the shell offers, and
    /// selecting it draws the Device Inbox rather than an empty page.
    ///
    /// This is the assertion the batch was missing. `AppDestination.deviceInbox`
    /// existed for macOS while the iOS tab bar had no `.tag` for it, and a
    /// `TabView` handed a selection with no matching tag renders nothing at all;
    /// the guard that used to prevent that was a source-level ban on the word,
    /// which cannot survive the destination actually shipping. What replaces it
    /// has to be runtime, because "the tab is present" and "the tab draws its
    /// screen" are different facts and only the second one matters.
    func testTheDeviceInboxIsAPrimaryDestinationThatRendersItsOwnScreen() throws {
        try launchCompact()

        open(Shell.deviceInbox, in: app)

        // Its own title, not the title of whatever was drawn before it.
        XCTAssertTrue(app.navigationBars["Device Inbox"].exists,
                      "the Device Inbox tab did not render the Device Inbox")
        // And leaving and returning still lands here, so the tag matches the
        // selection rather than happening to be first.
        open(Shell.lanTransfer, in: app)
        open(Shell.deviceInbox, in: app)
        XCTAssertTrue(app.navigationBars["Device Inbox"].exists,
                      "returning to the Device Inbox did not render it again")
    }

    // MARK: - signed out

    /// Signed out, the destination stays reachable, explains what it needs, and
    /// its one action actually goes to the account.
    ///
    /// The reachability half is a product decision worth pinning: every
    /// browseable surface exists in every session state, so the shell never
    /// reads `session.state` and signing out cannot remove a destination. A gate
    /// that is merely a dead end would satisfy that structurally and fail the
    /// user, so the route out is driven rather than asserted to exist.
    func testASignedOutDeviceInboxExplainsItselfAndReachesTheAccount() throws {
        try launchCompact()

        open(Shell.deviceInbox, in: app)

        XCTAssertTrue(app.staticTexts["Sign in to use Device Inbox"]
            .waitForExistence(timeout: 15),
            "the signed-out Device Inbox does not say what it needs")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@",
            "Device Inbox delivers files and messages sent from your own account"))
            .firstMatch.exists,
            "the signed-out Device Inbox does not explain why it needs an account")

        // No control the controller would refuse. A policy picker on a screen
        // with no account is a setting whose setter returns immediately.
        XCTAssertFalse(app.descendants(matching: .any)["inbox-policy"].exists,
                       "the signed-out Device Inbox offers a receiving policy it "
                       + "cannot store against any account")

        let remedy = app.buttons["inbox-open-account"]
        XCTAssertTrue(remedy.waitForExistence(timeout: 10),
                      "the signed-out Device Inbox offers no route to an account")
        remedy.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 15),
                      "the Device Inbox's account remedy does not reach the account")
    }

    // MARK: - signed in

    /// A signed-in Device Inbox renders the whole surface, and says out loud the
    /// one thing that makes it different from the Mac.
    ///
    /// **The foreground-only sentence is the point of this test.** The receiver
    /// runs only while Relayium is open; this app declares no background mode,
    /// no push and no notification. That is a real limitation a person needs
    /// BEFORE they walk away from the phone expecting a file to land, so the
    /// product renders it unconditionally rather than as an error state somebody
    /// has to reach — and a silent regression to the macOS copy, which promises
    /// delivery with the window closed, would be a false claim about what this
    /// build does. Asserted by its rendered words for that reason.
    func testASignedInDeviceInboxRendersItsSurfaceAndItsForegroundOnlyLimit() throws {
        try launchCompact(["--relayium-ui-testing-signed-in"])

        open(Shell.deviceInbox, in: app)

        for part in [app.descendants(matching: .any)["inbox-status"],
                     app.descendants(matching: .any)["inbox-foreground-only"],
                     app.descendants(matching: .any)["inbox-folder"],
                     app.descendants(matching: .any)["inbox-policy"]] {
            XCTAssertTrue(part.waitForExistence(timeout: 20),
                          "the signed-in Device Inbox is missing \(part)")
        }

        // The limitation, in the words the product promises. XCUITest caps a
        // string-identifier query at 128 characters and this sentence is longer,
        // so it is matched by its opening — and by the half that carries the
        // consequence, which is the half a regression would drop.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@",
            "receives only while it is open on this device",
            "arrives the next time you open it")).firstMatch.exists,
            "the Device Inbox does not state that it receives only in the "
            + "foreground, or no longer names the consequence of that")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "works with the window closed"))
            .firstMatch.exists,
            "the iOS Device Inbox claims the Mac's background delivery")

        // Where the bytes go, named as a route the user can walk in the Files
        // app rather than as a container path.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "Files app")).firstMatch.exists,
            "the Device Inbox does not name where a delivery can be found")
    }

    /// The one consent this platform asks for: default OFF, all three answers
    /// reachable, and the explanation that goes with them.
    ///
    /// A fixed destination removes the FOLDER question that macOS asks; it does
    /// not remove the permission one. **Default-off is the half worth driving.**
    /// Receiving is a standing consent to unattended writes into the app's own
    /// container, so a build that shipped defaulting to `auto` would accept
    /// deliveries from the account before anybody agreed to it — and that is
    /// invisible in a test that only checks the control exists.
    ///
    /// The answers are set through the control the product actually draws.
    /// `.pickerStyle(.inline)` outside a `List` resolves to a wheel on iOS, so
    /// the options are the wheel's values rather than separate elements; an
    /// earlier version of this test looked for them as labels and passed by
    /// matching the status card's own "Off" instead. Driving the wheel asserts
    /// the setter, not the layout.
    func testTheReceivingConsentIsOffByDefaultAndEveryAnswerCanBeChosen() throws {
        try launchCompact(["--relayium-ui-testing-signed-in"])

        open(Shell.deviceInbox, in: app)
        let policy = app.descendants(matching: .any)["inbox-policy"].firstMatch
        XCTAssertTrue(policy.waitForExistence(timeout: 20),
                      "the signed-in Device Inbox offers no receiving consent")

        let wheel = policy.pickerWheels.firstMatch
        XCTAssertTrue(wheel.waitForExistence(timeout: 15),
                      "the receiving consent cannot be operated")
        XCTAssertEqual(wheel.value as? String, "Off",
                       "a fresh account defaults to receiving deliveries without "
                       + "having been asked")

        // Every answer is genuinely selectable, including the way back to Off:
        // a consent that cannot be withdrawn is not a consent.
        for answer in ["Ask every time", "Receive automatically from my account", "Off"] {
            wheel.adjust(toPickerWheelValue: answer)
            XCTAssertEqual(wheel.value as? String, answer,
                           "the receiving consent could not be set to \(answer)")
        }

        // And the explanation states the platform limit a second time, where the
        // choice is actually made: neither answer receives while Relayium is
        // closed, so an "Automatically" that implied otherwise would be the
        // misleading half of this control.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "nothing arrives unless Relayium is open"))
            .firstMatch.exists,
            "the receiving consent does not say that neither answer receives "
            + "while Relayium is closed")
    }

    /// The conversation list names the account's other devices, and a row opens
    /// the conversation with the device it names.
    ///
    /// **The row's spoken identity is the point.** The list is one row per
    /// device merged with one per conversation, and every row leads to the same
    /// page — so five rows reading "Open" would be a list a VoiceOver user
    /// cannot navigate at all. The product labels each row with the device it
    /// opens, and this drives that label rather than asserting it exists.
    ///
    /// Opening is asserted on the destination's own navigation title, which is
    /// the peer's name: a push that landed on the wrong device, or on nothing,
    /// leaves the row perfectly tappable.
    func testAConversationRowNamesItsDeviceAndOpensThatDevicesConversation() throws {
        try launchCompact(["--relayium-ui-testing-signed-in"])

        open(Shell.deviceInbox, in: app)

        XCTAssertTrue(app.staticTexts["Conversations"].waitForExistence(timeout: 20),
                      "the Device Inbox has no conversation section")
        let refresh = app.buttons["inbox-devices-refresh"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 15),
                      "the conversation list offers no way to ask for the devices again")
        XCTAssertTrue(refresh.isEnabled, "the refresh control cannot be used")

        // The account's other device, addressed by the id the row is built from
        // and asserted on the name a person would read.
        let row = app.buttons["inbox-conversation.dev_other"]
        XCTAssertTrue(row.waitForExistence(timeout: 20),
                      "the conversation list does not offer the account's other device")
        XCTAssertTrue(row.label.contains("Kitchen laptop"),
                      "a conversation row does not name the device it opens: "
                      + "'\(row.label)'")

        row.tap()

        // The conversation with THAT device, titled by its name.
        XCTAssertTrue(app.navigationBars["Kitchen laptop"].waitForExistence(timeout: 15),
                      "the conversation row did not open its device's conversation")
        XCTAssertTrue(app.descendants(matching: .any)["inbox-timeline-empty"]
            .firstMatch.waitForExistence(timeout: 15),
            "the conversation drew neither history nor an empty timeline")

        // A device that cannot currently be sent to is kept in the list rather
        // than filtered out — it is the device the user is looking for — and the
        // page says so instead of offering a composer that would refuse.
        XCTAssertTrue(app.descendants(matching: .any)["inbox-compose-unavailable"]
            .firstMatch.exists,
            "a device that cannot receive offers no explanation on its page")
        XCTAssertFalse(app.descendants(matching: .any)["inbox-send-files"].firstMatch.exists,
                       "a device that cannot receive still offers to send to it")

        // And back, without leaving the destination.
        app.navigationBars["Kitchen laptop"].buttons["BackButton"].tap()
        XCTAssertTrue(app.navigationBars["Device Inbox"].waitForExistence(timeout: 15),
                      "leaving a conversation did not return to the Device Inbox")
    }

    // MARK: - the destination that is not a destination

    /// A stored link opened from the account is PRESENTED over the surface the
    /// user was on, and dismissing it puts them back there.
    ///
    /// This is the product route, driven end to end: Account's stored-file row
    /// hands the link to `AppDeepLinkCoordinator`, which selects `.storedReceive`
    /// — a destination the shell has no tab for — and `IOSShellModel` puts it up
    /// as a sheet over whatever was underneath. Nothing here uses the acceptance
    /// seam that starts a launch on that screen, so the seam is never the only
    /// evidence that presenting a stored link works.
    ///
    /// The return is the half worth driving. `storedReceive` used to be the
    /// first of five tabs; if dismissing dropped the user on the first tab
    /// instead of where they were, every assertion about the sheet itself would
    /// still pass.
    func testAStoredLinkOpenedFromTheAccountReturnsToTheSurfaceUnderneath() throws {
        try launchCompact(["--relayium-ui-testing-signed-in"])

        open(Shell.account, in: app)
        let openStored = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@", "Open", "obj_uitest"))
            .firstMatch
        XCTAssertTrue(openStored.waitForExistence(timeout: 20),
                      "the signed-in account offers no stored file to open")
        openStored.tap()

        waitForPresentedStoredReceive(app)
        // The link the row carried reached the field it is about to be resolved
        // from — so this is the stored-link screen doing its job, not an empty
        // sheet with the right title.
        let link = app.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15),
                      "the presented stored-link screen has no link field")
        XCTAssertTrue((link.value as? String ?? "").contains("obj_uitest"),
                      "the stored row's link did not reach the screen it opened")

        app.buttons["stored-receive-done"].tap()

        // Back on Account — where the user actually was — and with the sheet
        // gone rather than merely covered.
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 15),
                      "dismissing the stored link did not return to the surface it "
                      + "was presented over")
        XCTAssertFalse(app.buttons["stored-receive-done"].exists,
                       "the stored-link sheet outlived its dismissal")
    }
}
