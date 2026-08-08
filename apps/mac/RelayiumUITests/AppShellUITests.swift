import XCTest
import Carbon.HIToolbox

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
    private var pendingFileFixture: URL?

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
         "-AppleLocale", "en_US", "-SUEnableAutomaticChecks", "NO"]
    }

    /// The keyboard input source this suite found the machine in.
    private var previousInputSource: TISInputSource?

    /// Type into the app, not into an input method.
    ///
    /// `typeText` synthesizes key events, so a non-ASCII input source gets them
    /// first: characters become candidates and Return commits the candidate
    /// instead of the dialog underneath. That is invisible in the failure — the
    /// panel simply stays modal — and it is why paths that type text failed on a
    /// workstation with a Chinese input method while passing on an
    /// English-only runner. Scoped to the suite: the previous source is restored
    /// in `tearDown`, so the machine's own default is never changed.
    private func useASCIIKeyboard() {
        guard let ascii = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?
            .takeRetainedValue() else { return }
        previousInputSource = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
        TISSelectInputSource(ascii)
    }

    private func restoreInputSource() {
        if let previousInputSource { TISSelectInputSource(previousInputSource) }
        previousInputSource = nil
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        useASCIIKeyboard()
        app = XCUIApplication()
        app.launchArguments = offlineLaunchArguments
        app.launch()
        ensureProductWindowIsOpen()
    }

    override func tearDownWithError() throws {
        app?.terminate()
        restoreInputSource()
        if let pendingFileFixture {
            try? FileManager.default.removeItem(at: pendingFileFixture)
        }
    }

    /// A fresh runner may show Sparkle's one-time consent, while a reused
    /// runner may restore the deliberate closed-window state from the residency
    /// test. Resolve either through the controls a person actually sees, then
    /// begin every product assertion with the real work window in front.
    private func ensureProductWindowIsOpen() {
        let sparkleDecline = app.buttons["Don’t Check"]
        if sparkleDecline.waitForExistence(timeout: 2) { sparkleDecline.click() }
        if app.windows.allElementsBoundByIndex.contains(where: {
            $0.frame.width >= 800 && $0.frame.height >= 500
        }) { return }

        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 5),
                      "the resident app has no menu-bar recovery surface")
        statusItem.click()
        let open = app.menuItems["Open Relayium"]
        XCTAssertTrue(open.waitForExistence(timeout: 5),
                      "the menu-bar surface cannot reopen the product window")
        open.click()
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 10),
                      "Open Relayium did not restore the product window")
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
        let visibleTitle = NSPredicate(format: "label == %@ OR value == %@", title, title)
        if let row = window.descendants(matching: .any).matching(visibleTitle)
            .allElementsBoundByIndex
            .first(where: { $0.frame.midX < dividingX }) {
            return row
        }
        return stable
    }

    /// macOS 15 frequently drops SwiftUI's accessibility identifier from a
    /// combined Text while retaining its visible value. Prefer the stable id,
    /// then fall back to the exact English copy this runtime suite launches.
    private func visibleElement(id: String, text: String,
                                in window: XCUIElement) -> XCUIElement {
        let stable = window.descendants(matching: .any)[id].firstMatch
        if stable.exists { return stable }
        let visible = NSPredicate(format: "label == %@ OR value == %@", text, text)
        return window.descendants(matching: .any).matching(visible).firstMatch
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
        XCTAssertFalse(window.buttons["Pause receiving"].exists,
                       "an off listener offers the contradictory action to pause")
        XCTAssertFalse(window.buttons["Resume receiving"].exists,
                       "Look again is the one recovery for a listener that never started")
        XCTAssertTrue(window.staticTexts[
            "This device is not listening for nearby devices. It can still send, and pairing codes still work."
        ].exists, "the off state claims this Mac is still listening")
        XCTAssertFalse(window.staticTexts[
            "Incoming files are written to your Downloads folder."
        ].exists, "an off listener still promises to deliver an incoming file")
    }

    /// A count is not the identity of a send. Drive a real file through the
    /// system picker and require the running product to show both the complete
    /// name and its formatted size before any device or Send action is chosen.
    func testPendingSendNamesTheFileAndItsSizeBeforeTransfer() throws {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let nearby = sidebarDestination("Nearby", in: window)
        XCTAssertTrue(nearby.waitForExistence(timeout: 10))
        nearby.click()

        let fixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("Relayium product brief \(UUID().uuidString).txt")
        try Data(repeating: 0x52, count: 1_536).write(to: fixture, options: .atomic)
        pendingFileFixture = fixture

        let chooser = window.descendants(matching: .any)["Files to send"].firstMatch
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "Nearby has no file-selection surface")
        chooser.click()

        app.typeKey("g", modifierFlags: [.command, .shift])
        let location = app.textFields.firstMatch
        XCTAssertTrue(location.waitForExistence(timeout: 10),
                      "the system picker did not expose Go to Folder")
        location.typeText(fixture.path)
        app.typeKey(.return, modifierFlags: [])

        // macOS 15 exposes both the panel button and its Touch Bar mirror with
        // the title "Choose". Scope to the open panel's stable system button
        // identity so the real confirmation is unambiguous on either OS.
        let choose = app.dialogs["open-panel"].buttons["OKButton"]
        XCTAssertTrue(choose.waitForExistence(timeout: 10),
                      "the system picker has no confirmation action")
        choose.click()

        let identity = window.descendants(matching: .any)["pendingFile.0"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 10),
                      "the pending send did not expose its file identity")
        XCTAssertTrue(identity.label.contains(fixture.lastPathComponent),
                      "the pending send shortened or omitted the file name")
        XCTAssertTrue(identity.label.contains("1.5 KB"),
                      "the pending send omitted the formatted file size")
        XCTAssertTrue(window.buttons["Clear"].exists,
                      "the identified pending send cannot be cleared")
    }

    /// Selecting each destination renders something. The regression this catches
    /// is a destination whose body fails to build — which is a blank pane, not a
    /// crash, and is invisible to every other test in this repository.
    func testEachDestinationRendersItsOwnSurface() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let destinations = ["Pairing code", "Send a link", "Open a link",
                            "Account", "Nearby"]
        for destination in destinations {
            let row = sidebarDestination(destination, in: window)
            guard row.waitForExistence(timeout: 10) else {
                return XCTFail("the sidebar has no row for \(destination)")
            }
            row.click()
            let titleChanged = NSPredicate(format: "title == %@", destination)
            expectation(for: titleChanged, evaluatedWith: window)
            waitForExpectations(timeout: 10)
        }
    }

    /// A remedy must deliver the task its label promises. Both account actions
    /// stay inside Relayium, select Account, and open the matching half of the
    /// form instead of merely landing somewhere account-related.
    func testStoredSendAccountRemediesOpenThePromisedForm() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))

        let send = sidebarDestination("Send a link", in: window)
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.click()

        let signIn = window.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 10),
                      "signed-out Send offers no sign-in remedy")
        XCTAssertTrue(window.descendants(matching: .any)["account.create"].firstMatch.exists,
                      "signed-out Send offers no registration remedy")
        signIn.click()
        XCTAssertEqual(window.title, "Account",
                       "Sign in did not select the Account destination")
        XCTAssertTrue(window.staticTexts["Welcome back"].waitForExistence(timeout: 10),
                      "Sign in opened the wrong half of the Account form")

        let sendAgain = sidebarDestination("Send a link", in: window)
        XCTAssertTrue(sendAgain.waitForExistence(timeout: 10))
        sendAgain.click()
        let create = window.descendants(matching: .any)["account.create"].firstMatch
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.click()
        XCTAssertEqual(window.title, "Account",
                       "Create an account did not select the Account destination")
        XCTAssertTrue(window.staticTexts["Create your Relayium account"]
            .waitForExistence(timeout: 10),
                      "Create an account opened the sign-in half of the form")
        XCTAssertTrue(window.secureTextFields["account.confirmPassword"].exists,
                      "the promised registration form is incomplete")
    }

    /// A bad paste is ordinary recovery, not a dead end. The refusal must say
    /// what belongs here while leaving the same field and action available for
    /// correction on the same task.
    func testMalformedStoredLinkExplainsHowToRecover() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))

        let receive = sidebarDestination("Open a link", in: window)
        XCTAssertTrue(receive.waitForExistence(timeout: 10))
        receive.click()

        let link = window.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        let open = window.buttons["Open"]
        XCTAssertTrue(open.exists)
        XCTAssertFalse(open.isEnabled,
                       "an empty receive field offers an action that cannot succeed")

        link.click()
        link.typeText("not a link")
        XCTAssertTrue(open.isEnabled)
        open.click()

        let guidance = "That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…"
        XCTAssertTrue(visibleElement(
            id: "download-error", text: guidance, in: window
        ).waitForExistence(timeout: 10),
                      "the refusal does not explain the capability-link shape")
        XCTAssertTrue(link.exists && link.isEnabled,
                      "the malformed value cannot be corrected in place")
        XCTAssertTrue(open.exists,
                      "the receive action disappeared after a correctable refusal")
        XCTAssertEqual(window.title, "Open a link",
                       "a malformed link navigated away from its recovery task")
    }

    /// Account creation is one correctable in-app task. Local validation must
    /// explain the refusal without erasing secrets, changing destination, or
    /// forcing the user to begin the form again.
    func testRegistrationProblemKeepsTheDraftCorrectable() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))

        let account = sidebarDestination("Account", in: window)
        XCTAssertTrue(account.waitForExistence(timeout: 10))
        account.click()
        let chooseRegistration = window.descendants(matching: .any)[
            "account.switchMode"
        ].firstMatch
        XCTAssertTrue(chooseRegistration.waitForExistence(timeout: 10))
        chooseRegistration.click()

        XCTAssertTrue(window.staticTexts["Create your Relayium account"]
            .waitForExistence(timeout: 10))
        XCTAssertTrue(window.textFields["account.name"].exists)
        let email = window.textFields["account.email"]
        let password = window.secureTextFields["account.password"]
        let confirmation = window.secureTextFields["account.confirmPassword"]
        XCTAssertTrue(email.exists && password.exists && confirmation.exists)

        let create = window.buttons["Create account"]
        XCTAssertTrue(create.exists)
        XCTAssertFalse(create.isEnabled,
                       "an empty registration form can be submitted")
        email.click()
        email.typeText("person@example.com")
        password.click()
        password.typeText("short")
        confirmation.click()
        confirmation.typeText("wrong battery")

        let submittedPassword = password.value as? String
        let submittedConfirmation = confirmation.value as? String
        XCTAssertTrue(create.isEnabled)
        create.click()

        XCTAssertTrue(window.staticTexts["Use at least 8 characters for your password."]
            .waitForExistence(timeout: 10),
                      "the local refusal does not explain the password rule")
        XCTAssertEqual(password.value as? String, submittedPassword,
                       "the local refusal erased the password")
        XCTAssertEqual(confirmation.value as? String, submittedConfirmation,
                       "the local refusal erased the confirmation")
        XCTAssertTrue(password.isEnabled && confirmation.isEnabled && create.exists)
        XCTAssertEqual(window.title, "Account",
                       "a registration refusal navigated away from Account")

        let back = window.descendants(matching: .any)["account.switchMode"].firstMatch
        XCTAssertTrue(back.exists)
        XCTAssertEqual(back.label, "Back to sign in")
        back.click()
        XCTAssertTrue(window.staticTexts["Welcome back"].waitForExistence(timeout: 10))
        XCTAssertFalse(window.secureTextFields["account.confirmPassword"].exists,
                       "returning to sign in left registration-only controls behind")
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
        XCTAssertTrue(visibleElement(
            id: "pairing-mode-match-hint",
            text: "Choose Files or Text to match what the sender started. The code itself does not identify the type.",
            in: window).exists,
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
        XCTAssertTrue(visibleElement(
            id: "pairing-code-expiry-note",
            text: "Only this pairing code expires. A transfer that has already started can continue.",
            in: window).exists,
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

    /// Both pairing modes accept the same six-digit task. Fast entry must be
    /// canonicalized once without an older partial value replacing later
    /// digits, and the complete value must make Join actionable.
    func testPairingJoinKeepsACompleteCodeActionableInBothModes() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let pairing = sidebarDestination("Pairing code", in: window)
        XCTAssertTrue(pairing.waitForExistence(timeout: 10))
        pairing.click()

        for (mode, code) in [("Files", "123456"), ("Text", "654321")] {
            let choice = window.radioButtons[mode]
            XCTAssertTrue(choice.waitForExistence(timeout: 10))
            choice.click()
            let field = window.textFields["pairing.joinCode"]
            XCTAssertTrue(field.waitForExistence(timeout: 10),
                          "\(mode) has no pairing-code field")
            field.click()
            field.typeText(code)
            XCTAssertEqual(field.value as? String, code,
                           "\(mode) lost digits during fast entry")
            XCTAssertTrue(window.buttons["Join"].isEnabled,
                          "\(mode) cannot join with a complete code")
        }
    }

    /// A terminal task is not an invitation to start another one on top of it.
    /// Done is the explicit boundary that releases the old connection/history;
    /// only after it is pressed may Create and Join return.
    func testTerminalTextSessionMustBeDismissedBeforeStartingAgain() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-terminal-text"]
        app.launch()
        ensureProductWindowIsOpen()

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
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        XCTAssertTrue(visibleElement(
            id: "nearby-session-peer", text: "Session with Studio Mac · 19af02",
            in: window).waitForExistence(timeout: 10),
                      "the terminal task lost who it was with")
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
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: window, handler: nil)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(app.state, .runningForeground,
                       "closing the window must not end the process; the menu bar keeps it alive")
    }
    /// A launch that already holds an account renders it, and Send a link stops
    /// offering the remedy for a state it is no longer in.
    ///
    /// Every signed-in macOS surface was unreachable from acceptance until this,
    /// which on macOS includes a whole sidebar destination. The account is
    /// answered by a deterministic in-process transport: nothing leaves the
    /// machine and no real credential exists in it.
    func testASignedInLaunchRendersItsAccountAndUngatesStoredSend() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let account = sidebarDestination("Account", in: window)
        XCTAssertTrue(account.waitForExistence(timeout: 10))
        account.click()

        XCTAssertTrue(window.staticTexts["person@example.com"].waitForExistence(timeout: 20),
                      "a signed-in launch did not render the account it holds")
        XCTAssertTrue(window.staticTexts["Signed-in devices"].exists,
                      "the signed-in account has no device section")

        XCTAssertTrue(window.staticTexts["Studio Mac"].waitForExistence(timeout: 10),
                      "the signed-in device list did not name this device")
        XCTAssertTrue(window.staticTexts["Kitchen laptop"].exists,
                      "the device list dropped a revocable row")
        XCTAssertTrue(window.staticTexts["This device"].exists,
                      "nothing distinguishes the device the user is holding")
        let revokes = window.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Kitchen laptop"))
        XCTAssertGreaterThan(revokes.count, 0,
                             "a revoke action does not identify the row it destroys")

        // Both arms of a stored row, side by side. A `#k=` link is the plaintext
        // to anybody holding it, so which arm a row is in is a security fact,
        // not a convenience one.
        XCTAssertTrue(window.staticTexts["obj_uitest"].waitForExistence(timeout: 10),
                      "the stored object is not identified by the id the server knows")
        XCTAssertTrue(window.staticTexts["obj_nokey"].exists,
                      "the second stored object is missing from the list")
        for handoff in ["Share the link for stored file", "Copy link", "Open"] {
            XCTAssertGreaterThan(window.buttons.matching(NSPredicate(
                format: "label BEGINSWITH %@ AND label CONTAINS %@",
                handoff, "obj_uitest")).count, 0,
                "a rebuildable row does not offer \(handoff)")
        }
        let keyAbsent = window.descendants(matching: .any)["storedFile.keyAbsent.obj_nokey"]
            .firstMatch
        XCTAssertTrue(keyAbsent.waitForExistence(timeout: 10),
                      "a row that cannot be rebuilt does not explain why")
        for handoff in ["Share the link for stored file", "Copy link", "Open"] {
            XCTAssertEqual(window.buttons.matching(NSPredicate(
                format: "label BEGINSWITH %@ AND label CONTAINS %@",
                handoff, "obj_nokey")).count, 0,
                "a row with no key still offers \(handoff)")
        }
        XCTAssertEqual(window.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Delete stored file")).count, 2,
            "a stored object that cannot be linked also cannot be removed")
        XCTAssertFalse(window.staticTexts["Welcome back"].exists,
                       "a signed-in launch still shows the sign-in form")

        let send = sidebarDestination("Send a link", in: window)
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.click()
        XCTAssertFalse(window.buttons["Sign in"].exists,
                       "a signed-in stored send still offers the signed-out remedy")
    }


    /// macOS mirrors a dialog's buttons onto the Touch Bar, so a bare
    /// `app.buttons["Cancel"]` is ambiguous — the same limit batch 94 hit with
    /// the open panel's Choose. Scope the dismissal to the sheet that owns it.
    private func dismissConfirmation(in window: XCUIElement) {
        let sheetCancel = window.sheets.buttons["Cancel"].firstMatch
        if sheetCancel.waitForExistence(timeout: 5) { return sheetCancel.click() }
        let anyCancel = app.buttons.matching(
            NSPredicate(format: "label == %@", "Cancel")).firstMatch
        XCTAssertTrue(anyCancel.waitForExistence(timeout: 5),
                      "the destructive confirmation offers no way out")
        anyCancel.click()
    }

    /// Both arms of the revoke confirmation, and the delete confirmation, in the
    /// running Mac app.
    ///
    /// Revoking the credential in your hand signs this app out; revoking another
    /// one does not. macOS built that sentence inline in the view rather than
    /// asking the seam a test drives, so the rule existed twice and could be
    /// corrected in one place while staying wrong here.
    func testDestructiveConfirmationsNameTheirSubjectAndConsequence() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let account = sidebarDestination("Account", in: window)
        XCTAssertTrue(account.waitForExistence(timeout: 10))
        account.click()

        let other = window.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Kitchen laptop")).firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 20),
                      "no revoke action identifies the other device")
        other.click()
        XCTAssertTrue(app.staticTexts[
            "That device will be signed out and will have to sign in again."
        ].waitForExistence(timeout: 10),
            "revoking another device claims the wrong consequence")
        XCTAssertFalse(app.staticTexts[
            "This is the device you're using. Revoking it signs this app out immediately."
        ].exists, "revoking another device threatens to sign this one out")
        dismissConfirmation(in: window)

        let current = window.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Studio Mac")).firstMatch
        XCTAssertTrue(current.waitForExistence(timeout: 10),
                      "cancelling the confirmation lost the device list")
        current.click()
        XCTAssertTrue(app.staticTexts[
            "This is the device you're using. Revoking it signs this app out immediately."
        ].waitForExistence(timeout: 10),
            "revoking this device hides that it signs the app out")
        dismissConfirmation(in: window)

        // Deleting stored ciphertext is irreversible and takes the object away
        // from everyone holding the link, so the dialog must say both.
        // By the delete action itself, not merely by the row's id: a rebuildable
        // row also carries Open, Copy link and Share, and any of them would
        // match an id-only query.
        let delete = window.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@",
            "Delete stored file", "obj_uitest")).firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 10),
                      "no delete action identifies the stored object")
        delete.click()
        XCTAssertTrue(app.staticTexts["Delete this stored file?"]
            .waitForExistence(timeout: 10),
            "the delete confirmation does not say what it deletes")
        XCTAssertTrue(app.staticTexts[
            "The encrypted data is erased from the server. Anyone holding the link will get nothing. This cannot be undone."
        ].exists, "the delete confirmation hides that it is irreversible")
        dismissConfirmation(in: window)
        XCTAssertTrue(window.staticTexts["obj_uitest"].waitForExistence(timeout: 10),
                      "a cancelled delete did not leave the stored object alone")
    }

    /// Signing out returns the Mac app to the state a first launch is in, and
    /// leaves none of the account's own surfaces behind.
    func testSigningOutReturnsToTheSignedOutSurfaces() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let account = sidebarDestination("Account", in: window)
        XCTAssertTrue(account.waitForExistence(timeout: 10))
        account.click()

        XCTAssertTrue(window.staticTexts["person@example.com"].waitForExistence(timeout: 20),
                      "the signed-in launch did not render the account it holds")
        let signOut = window.buttons["Sign out"]
        XCTAssertTrue(signOut.waitForExistence(timeout: 10),
                      "a signed-in account offers no way out")
        signOut.click()

        XCTAssertTrue(window.staticTexts["Welcome back"].waitForExistence(timeout: 20),
                      "signing out did not return to the sign-in form")
        // Deliberately NOT asserting that the device rows and stored objects are
        // gone from here. They are — but so is the whole summary view, so such
        // an assertion passes whether or not the model was cleared: removing
        // `management.clear` from the sign-out coordinator left it green. An
        // assertion that cannot fail is worse than none, because it reads as
        // coverage. Whether the model drops the account is
        // `AccountSignOutCoordinatorTests`' subject, driven directly.
        XCTAssertFalse(window.staticTexts["person@example.com"].exists,
                       "signing out left the account address on screen")

        let send = sidebarDestination("Send a link", in: window)
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.click()
        XCTAssertTrue(window.buttons["Sign in"].waitForExistence(timeout: 10),
                      "a signed-out stored send no longer offers its account remedy")
    }

    /// Correcting the field clears the refusal with it.
    ///
    /// The malformed-link path proves the refusal explains itself and leaves the
    /// field editable. It does not prove the refusal is not STICKY: guidance
    /// that outlives the input it described sits beside corrected text telling
    /// the user they are still wrong.
    func testCorrectingARefusedStoredLinkClearsTheRefusalWithIt() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let receive = sidebarDestination("Open a link", in: window)
        XCTAssertTrue(receive.waitForExistence(timeout: 10))
        receive.click()

        let link = window.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 10),
                      "Open a link has no link field")
        link.click()
        link.typeText("not a link")
        window.buttons["Open"].firstMatch.click()

        let guidance = window.staticTexts[
            "That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…"
        ]
        XCTAssertTrue(guidance.waitForExistence(timeout: 10),
                      "an invalid link does not explain the required shape")

        // Re-resolve: SwiftUI rebuilds the field around the refusal, so the
        // handle captured before it is stale.
        let corrected = window.textFields["receive.link"]
        XCTAssertTrue(corrected.waitForExistence(timeout: 10))
        corrected.click()
        app.typeKey("a", modifierFlags: .command)
        app.typeKey(.delete, modifierFlags: [])

        XCTAssertFalse(guidance.waitForExistence(timeout: 3),
                       "the refusal outlived the input it described")
    }

    /// A signed-in stored send identifies what it is about to upload, before any
    /// expiry choice or Send action is made.
    ///
    /// Send a link is account-gated, so this destination was unreachable from
    /// acceptance until the signed-in fixture existed — every earlier
    /// pending-file path used the anonymous Nearby surface instead.
    func testASignedInStoredSendNamesTheFileItWouldUpload() throws {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + ["--relayium-ui-testing-signed-in"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let send = sidebarDestination("Send a link", in: window)
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.click()
        XCTAssertFalse(window.buttons["Sign in"].exists,
                       "a signed-in stored send still offers the signed-out remedy")

        let fixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("Relayium product brief \(UUID().uuidString).txt")
        try Data(repeating: 0x52, count: 1_536).write(to: fixture, options: .atomic)
        pendingFileFixture = fixture

        let chooser = window.descendants(matching: .any)["Files to send"].firstMatch
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "a signed-in stored send has no file-selection surface")
        chooser.click()

        app.typeKey("g", modifierFlags: [.command, .shift])
        let location = app.textFields.firstMatch
        XCTAssertTrue(location.waitForExistence(timeout: 10),
                      "the system picker did not expose Go to Folder")
        location.typeText(fixture.path)
        app.typeKey(.return, modifierFlags: [])

        let choose = app.dialogs["open-panel"].buttons["OKButton"]
        XCTAssertTrue(choose.waitForExistence(timeout: 10),
                      "the system picker has no confirmation action")
        choose.click()

        let identity = window.descendants(matching: .any)["pendingFile.0"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 10),
                      "the stored send did not expose what it would upload")
        XCTAssertTrue(identity.label.contains(fixture.lastPathComponent),
                      "the stored send shortened or omitted the file name")
        XCTAssertTrue(identity.label.contains("1.5 KB"),
                      "the stored send omitted the formatted file size")
    }

    /// A stored send that finishes hands the result over, and offers the way to
    /// start another.
    ///
    /// The macOS half of the first completion surface acceptance can reach. It
    /// needs a server to say yes, so nothing before the upload fixture could get
    /// here; the encryption, chunking, manifest and link construction are all
    /// production code.
    func testACompletedStoredSendHandsOverItsLinkAndOffersAnother() throws {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + ["--relayium-ui-testing-signed-in"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let send = sidebarDestination("Send a link", in: window)
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.click()

        let fixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("Relayium product brief \(UUID().uuidString).txt")
        try Data(repeating: 0x52, count: 1_536).write(to: fixture, options: .atomic)
        pendingFileFixture = fixture

        let chooser = window.descendants(matching: .any)["Files to send"].firstMatch
        XCTAssertTrue(chooser.waitForExistence(timeout: 10))
        chooser.click()
        app.typeKey("g", modifierFlags: [.command, .shift])
        let location = app.textFields.firstMatch
        XCTAssertTrue(location.waitForExistence(timeout: 10))
        location.typeText(fixture.path)
        app.typeKey(.return, modifierFlags: [])
        let choose = app.dialogs["open-panel"].buttons["OKButton"]
        XCTAssertTrue(choose.waitForExistence(timeout: 10))
        choose.click()

        let sendAction = window.buttons["Send"]
        XCTAssertTrue(sendAction.waitForExistence(timeout: 15),
                      "a chosen file offers no way to send it")
        sendAction.click()

        // The link IS the result and carries the only decryption key, so it has
        // to be inspectable in full before it is handed to anybody.
        let link = window.descendants(matching: .any)["storedSend.resultLink"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 30),
                      "a completed upload did not render its capability link")
        let shown = (link.value as? String) ?? link.label
        XCTAssertTrue(shown.contains("/d/obj_uitest#k="),
                      "the rendered result is not the capability link for this object")
        XCTAssertTrue(window.buttons["Copy"].exists, "the result cannot be copied")
        XCTAssertTrue(window.buttons["Share"].exists, "the result cannot be shared")

        let another = window.buttons["Send another"]
        XCTAssertTrue(another.waitForExistence(timeout: 10),
                      "a completed send offers no way to start the next one")
        another.click()
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "Send another did not return to a new selection")
        XCTAssertFalse(link.exists,
                       "the previous result stayed on screen after Send another")
    }

    /// Signing in through the form turns an empty session into a real one.
    ///
    /// Every other account path either started signed out or started already
    /// signed in. The transition itself — the one a first-time user performs —
    /// had no runtime evidence on either platform.
    func testSigningInThroughTheFormOpensTheAccount() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + ["--relayium-ui-testing-sign-in"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let account = sidebarDestination("Account", in: window)
        XCTAssertTrue(account.waitForExistence(timeout: 10))
        account.click()
        XCTAssertTrue(window.staticTexts["Welcome back"].waitForExistence(timeout: 15),
                      "a signed-out launch did not offer the sign-in form")

        // By identity across any type: macOS classifies a SwiftUI SecureField
        // inconsistently between the sign-in and registration halves of this
        // form, and the identifier is the same in both.
        let email = window.descendants(matching: .any)["account.email"].firstMatch
        let password = window.descendants(matching: .any)["account.password"].firstMatch
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        XCTAssertTrue(password.waitForExistence(timeout: 10))
        email.click()
        email.typeText("person@example.com")
        password.click()
        password.typeText("correct horse battery")

        let signIn = window.buttons["Sign in"]
        XCTAssertTrue(signIn.exists, "the completed form cannot be submitted")
        signIn.click()

        XCTAssertTrue(window.staticTexts["person@example.com"].waitForExistence(timeout: 20),
                      "signing in did not open the account")
        XCTAssertTrue(window.staticTexts["Signed-in devices"].exists,
                      "the opened account has no device section")
        XCTAssertFalse(window.staticTexts["Welcome back"].exists,
                       "the sign-in form survived a successful sign-in")
    }

    /// Cancelling an upload in flight returns the task to the user, with nothing
    /// half-finished left claiming to be a result.
    ///
    /// The contract differs from iOS ON PURPOSE and the test says so rather than
    /// copying the other platform's: macOS builds its upload model without a
    /// pending store, so `.interrupted` falls back to the selection and keeps
    /// the chosen files in front of the user, instead of offering Resume and
    /// Discard. Asserting iOS's surface here would invent a requirement.
    func testCancellingAnUploadInFlightReturnsTheTask() throws {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-stall-upload"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let send = sidebarDestination("Send a link", in: window)
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.click()

        let fixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("Relayium product brief \(UUID().uuidString).txt")
        try Data(repeating: 0x52, count: 1_536).write(to: fixture, options: .atomic)
        pendingFileFixture = fixture

        let chooser = window.descendants(matching: .any)["Files to send"].firstMatch
        XCTAssertTrue(chooser.waitForExistence(timeout: 10))
        chooser.click()
        app.typeKey("g", modifierFlags: [.command, .shift])
        let location = app.textFields.firstMatch
        XCTAssertTrue(location.waitForExistence(timeout: 10))
        location.typeText(fixture.path)
        app.typeKey(.return, modifierFlags: [])
        let choose = app.dialogs["open-panel"].buttons["OKButton"]
        XCTAssertTrue(choose.waitForExistence(timeout: 10))
        choose.click()

        let sendAction = window.buttons["Send"]
        XCTAssertTrue(sendAction.waitForExistence(timeout: 15))
        sendAction.click()

        let cancel = window.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 20),
                      "an upload in flight cannot be cancelled")
        cancel.click()

        XCTAssertTrue(chooser.waitForExistence(timeout: 20),
                      "a cancelled upload did not return the selection")
        let identity = window.descendants(matching: .any)["pendingFile.0"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 10),
                      "a cancelled upload lost the files the user had chosen")
        XCTAssertFalse(window.descendants(matching: .any)["storedSend.resultLink"]
            .firstMatch.exists,
            "a cancelled upload left a capability link on screen")
    }

    /// Nearby's transfer type is two different tasks, not a label.
    func testNearbyTransferTypeChangesWhatIsStaged() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let nearby = sidebarDestination("Nearby", in: window)
        XCTAssertTrue(nearby.waitForExistence(timeout: 10))
        nearby.click()

        let chooser = window.descendants(matching: .any)["Files to send"].firstMatch
        XCTAssertTrue(chooser.waitForExistence(timeout: 15),
                      "Nearby's file mode stages nothing")

        let text = window.radioButtons["Text"]
        XCTAssertTrue(text.waitForExistence(timeout: 10),
                      "Nearby offers no transfer type choice")
        text.click()
        XCTAssertFalse(chooser.waitForExistence(timeout: 3),
                       "choosing Text left the file staging surface behind")

        window.radioButtons["Files"].click()
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "returning to Files did not restore its staging surface")
    }

    /// An upload that fails mid-transfer keeps the user's files in front of them.
    ///
    /// As with cancelling, macOS builds its upload model without a pending store,
    /// so the recovery it offers is the selection itself rather than Resume and
    /// Discard. The claim that matters on both platforms is the same: the work
    /// is not thrown away and no link is produced from a failure.
    func testAFailedUploadKeepsTheWorkAndOffersToCarryOn() throws {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-fail-upload"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let send = sidebarDestination("Send a link", in: window)
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        send.click()

        let fixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("Relayium product brief \(UUID().uuidString).txt")
        try Data(repeating: 0x52, count: 1_536).write(to: fixture, options: .atomic)
        pendingFileFixture = fixture

        let chooser = window.descendants(matching: .any)["Files to send"].firstMatch
        XCTAssertTrue(chooser.waitForExistence(timeout: 10))
        chooser.click()
        app.typeKey("g", modifierFlags: [.command, .shift])
        let location = app.textFields.firstMatch
        XCTAssertTrue(location.waitForExistence(timeout: 10))
        location.typeText(fixture.path)
        app.typeKey(.return, modifierFlags: [])
        let choose = app.dialogs["open-panel"].buttons["OKButton"]
        XCTAssertTrue(choose.waitForExistence(timeout: 10))
        choose.click()

        let sendAction = window.buttons["Send"]
        XCTAssertTrue(sendAction.waitForExistence(timeout: 15))
        sendAction.click()

        let identity = window.descendants(matching: .any)["pendingFile.0"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 30),
                      "a failed upload lost the files the user had chosen")
        XCTAssertFalse(window.descendants(matching: .any)["storedSend.resultLink"]
            .firstMatch.exists,
            "a failed upload produced a capability link anyway")
    }

    /// Creating a FILE pairing code stays on Pairing code and shows every
    /// handoff, with the mode the user actually chose preserved in the link.
    ///
    /// The text half of this flow has had a runtime path since the eighth batch.
    /// The file half — the mode most people reach for — had none, so the link's
    /// mode parameter was only ever proven for Text.
    func testCreatingAFilePairingCodeStaysOnPairingAndShowsEveryHandoff() throws {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + ["--relayium-ui-testing-file-code"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let pairing = sidebarDestination("Pairing code", in: window)
        XCTAssertTrue(pairing.waitForExistence(timeout: 10))
        pairing.click()
        window.radioButtons["Files"].click()

        let fixture = FileManager.default.temporaryDirectory
            .appendingPathComponent("Relayium product brief \(UUID().uuidString).txt")
        try Data(repeating: 0x52, count: 1_536).write(to: fixture, options: .atomic)
        pendingFileFixture = fixture

        let chooser = window.descendants(matching: .any)["Files to send"].firstMatch
        XCTAssertTrue(chooser.waitForExistence(timeout: 10),
                      "the file pairing mode stages nothing")
        chooser.click()
        app.typeKey("g", modifierFlags: [.command, .shift])
        let location = app.textFields.firstMatch
        XCTAssertTrue(location.waitForExistence(timeout: 10))
        location.typeText(fixture.path)
        app.typeKey(.return, modifierFlags: [])
        let choose = app.dialogs["open-panel"].buttons["OKButton"]
        XCTAssertTrue(choose.waitForExistence(timeout: 10))
        choose.click()

        let create = window.buttons["Create a code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "a staged file offers no way to create a code")
        create.click()

        XCTAssertTrue(window.staticTexts["4 8 3 9 2 0"].waitForExistence(timeout: 20),
                      "the generated pairing code is not visible")
        XCTAssertTrue(window.staticTexts["Join link"].exists,
                      "the generated code has no visible browser handoff")
        XCTAssertTrue(window.staticTexts[
            "https://relayium.com/cross-network?mode=file#c=483920"
        ].exists, "the visible handoff did not preserve the created Files mode")
        XCTAssertTrue(window.buttons["Copy"].exists, "the join link cannot be copied")
        XCTAssertTrue(window.buttons["Share"].exists,
                      "the join link cannot use the system share sheet")
    }

    /// A stored link that resolves and downloads, ending on a result the user
    /// can act on.
    ///
    /// Every earlier Open a link path stopped at a refusal. This one carries a
    /// key that actually decrypts what the fixture serves — the ciphertext is
    /// produced by the production encryptor — so the manifest, the frame format
    /// and the key handling are exercised rather than asserted about. The name
    /// it renders is one the server never sees, which is what makes it evidence
    /// that the manifest decrypted here.
    func testOpeningAValidStoredLinkDownloadsAndNamesTheResult() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments + ["--relayium-ui-testing-sign-in"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let receive = sidebarDestination("Open a link", in: window)
        XCTAssertTrue(receive.waitForExistence(timeout: 10))
        receive.click()

        let link = window.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.click()
        link.typeText(
            "https://relayium.com/d/obj_uitest#k=ERERERERERERERERERERERERERERERERERERERERERE")
        window.buttons["Open"].firstMatch.click()

        // macOS resolves first and then asks WHERE to put it: the download does
        // not start until the user picks a folder, which is the platform's own
        // contract and not an extra step invented by the test.
        let save = window.buttons["Save…"]
        XCTAssertTrue(save.waitForExistence(timeout: 30),
                      "a resolved link offers no way to save what it points at")
        save.click()
        let saveHere = app.dialogs["open-panel"].buttons["OKButton"]
        XCTAssertTrue(saveHere.waitForExistence(timeout: 15),
                      "the destination panel has no confirmation action")
        saveHere.click()

        // By the row's stable identity, not a window-wide predicate: that query
        // times out on macOS, the same limit batches 94, 102 and 115 hit.
        let identity = window.descendants(matching: .any)["pendingFile.0"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 40),
                      "a completed download did not name what it received")
        XCTAssertTrue(identity.label.contains("brief.txt"),
                      "the received result is not the file the manifest named")
    }

}
