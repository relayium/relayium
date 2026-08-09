import XCTest

/// The Device Inbox, driven through the app a person actually uses.
///
/// The package suites already assert what the controller decides and what the
/// SwiftUI files contain. What only appears at runtime is whether those
/// decisions reach a screen: a settings tab that fails to build, a status that
/// renders nothing, a Reveal control that is not there, and — the one this whole
/// capability rests on — a receiver that stops when the window closes.
///
/// Each launch below substitutes exactly one thing, the transport, and lets the
/// real enrolment, key store, sealed box, decryptor, planner, `linkat` commit and
/// journal run. So "a completed result with Reveal" on screen means a file
/// genuinely landed on this machine during the test.
final class DeviceInboxUITests: XCTestCase {
    private var app: XCUIApplication!

    private var offlineLaunchArguments: [String] {
        ["--relayium-ui-testing", "-AppleLanguages", "(en)",
         "-AppleLocale", "en_US", "-SUEnableAutomaticChecks", "NO"]
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// Relayium's work area is the process's largest window — the cross-version
    /// contract `AppShellUITests` established, because macOS 15 does not expose
    /// the SwiftUI scene id and auxiliary windows can appear first.
    private var mainWindow: XCUIElement {
        app.windows.allElementsBoundByIndex.max {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        } ?? app.windows.firstMatch
    }

    /// The settings scene, identified by the shipped `.frame(width: 520)`
    /// contract rather than by index: with the product window closed the
    /// settings window is the ONLY window, so "the second window" does not
    /// identify it, and the MenuBarExtra's own status-item window is smaller.
    private var settingsWindow: XCUIElement? {
        app.windows.allElementsBoundByIndex
            .first { $0.frame.width >= 400 && $0.frame.width < 800 }
    }

    /// Wait for the settings scene itself to appear.
    ///
    /// A window COUNT is deliberately not the condition. With the product window
    /// closed this process still reports windows of its own, so "the count
    /// reached one" can be satisfied by something that is not Settings and would
    /// let the assertion below race the scene being built.
    private func waitForSettingsWindow(timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let settings = settingsWindow { return settings }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return settingsWindow
    }

    private func launch(_ extraArguments: [String]) {
        app.launchArguments = offlineLaunchArguments + extraArguments
        app.launch()
        let sparkleDecline = app.buttons["Don’t Check"]
        if sparkleDecline.waitForExistence(timeout: 2) { sparkleDecline.click() }

        // A hosted runner can restore the last deliberate closed-window state.
        // Relayium remains alive in that state by design, so process launch is
        // not proof that its work window is visible. Recover through the same
        // menu-bar action a person uses, matching AppShellUITests.
        if !app.windows.allElementsBoundByIndex.contains(where: {
            $0.frame.width >= 800 && $0.frame.height >= 500
        }) {
            let statusItem = app.statusItems.firstMatch
            XCTAssertTrue(statusItem.waitForExistence(timeout: 5),
                          "the resident app has no menu-bar recovery surface")
            statusItem.click()
            app.typeKey("o", modifierFlags: [])
        }
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 20),
                      "the product window did not open")
    }

    /// Open ⌘, through the menu item, then select the Device Inbox tab.
    ///
    /// Driven from the menu rather than the keyboard for the reason
    /// `AppShellUITests` recorded: a synthetic ⌘, never reached the app, so the
    /// assertion measured XCUITest rather than the scene.
    @discardableResult
    private func openDeviceInboxSettings() -> XCUIElement {
        let appMenu = app.menuBarItems.element(boundBy: 1)
        XCTAssertTrue(appMenu.waitForExistence(timeout: 10))
        appMenu.click()
        let settingsItem = appMenu.menuItems["Settings…"]
        XCTAssertTrue(settingsItem.waitForExistence(timeout: 10),
                      "the app menu has no Settings item")
        settingsItem.click()

        let twoWindows = NSPredicate(format: "count >= 2")
        expectation(for: twoWindows, evaluatedWith: app.windows, handler: nil)
        waitForExpectations(timeout: 20)
        return selectDeviceInboxPane()
    }

    /// Find the settings scene among the process's windows and put the Device
    /// Inbox pane on screen.
    ///
    /// Split out of `openDeviceInboxSettings` so the menu-bar entry point can be
    /// held to the SAME proof as the app-menu one: it is not enough for a window
    /// to appear, it has to be the settings scene with this pane in it.
    @discardableResult
    private func selectDeviceInboxPane() -> XCUIElement {
        // Do not identify this as merely "not the main element". XCUIElement
        // queries can rebind after a second scene appears (observed on the
        // hosted Xcode 16.4 runner), making an element captured before opening
        // Settings compare unequal to the same product window afterward. The
        // shipped scene contract is spatial: Settings is 520 points wide and
        // the product window is at least 800 points wide.
        let settings = settingsWindow ?? app.windows.element(boundBy: 1)

        // A settings window REMEMBERS its last tab, so it may already be here —
        // and the tab control is not a radio button on every macOS: measured on
        // this tree it is a static text carrying the title in its `value`, which
        // is the same label/value split `AppShellUITests` records for macOS 15.
        // Try every candidate, and accept the pane appearing as the answer, so
        // this suite fails on the product rather than on a control type.
        if !deviceInboxPaneIsShowing(in: settings) {
            let named = NSPredicate(format: "label == %@ OR value == %@",
                                    "Device Inbox", "Device Inbox")
            for candidate in settings.descendants(matching: .any).matching(named)
                .allElementsBoundByIndex where candidate.isHittable {
                candidate.click()
                if deviceInboxPaneIsShowing(in: settings) { break }
            }
        }
        XCTAssertTrue(deviceInboxPaneIsShowing(in: settings),
                      "the settings window never showed the Device Inbox pane")
        return settings
    }

    /// The pane is showing when one of its two mutually exclusive roots is on
    /// screen: the signed-out explanation, or the status line.
    private func deviceInboxPaneIsShowing(in settings: XCUIElement) -> Bool {
        element("inbox-status", in: settings).waitForExistence(timeout: 3)
            || element("inbox-signed-out", in: settings).exists
    }

    /// A SwiftUI `Text` puts its string in `label` for a control and in `value`
    /// for a combined element, and which of the two it uses varies by macOS
    /// version. Reading both is the only stable way to assert on rendered copy.
    private func text(of element: XCUIElement) -> String {
        let value = element.value.map { String(describing: $0) } ?? ""
        return element.label + " " + value
    }

    private func element(_ identifier: String, in window: XCUIElement) -> XCUIElement {
        window.descendants(matching: .any)[identifier].firstMatch
    }

    /// The whole text of a settings surface, for assertions about what is NOT on
    /// it. Built from labels and values because SwiftUI splits a `Form` across
    /// many elements and macOS 15 drops identifiers from some of them.
    private func visibleText(in window: XCUIElement) -> String {
        window.descendants(matching: .any).allElementsBoundByIndex
            .map { "\($0.label) \($0.value.map { String(describing: $0) } ?? "")" }
            .joined(separator: "\n")
    }

    // MARK: - signed out

    /// Signed out, the pane explains what the capability needs rather than
    /// rendering a folder chooser that could not be used.
    func testSignedOutSetupExplainsWhatDeviceInboxNeeds() {
        launch([])
        let settings = openDeviceInboxSettings()
        XCTAssertTrue(element("inbox-signed-out", in: settings).waitForExistence(timeout: 10),
                      "a signed-out Device Inbox pane says nothing about why it is empty")
        XCTAssertFalse(element("inbox-choose-folder", in: settings).exists,
                       "a signed-out pane offers a folder grant it cannot store")
        XCTAssertFalse(element("inbox-policy", in: settings).exists)
    }

    // MARK: - ready

    /// A signed-in Mac with a chosen folder and Automatic selected says it is
    /// ready, names the folder, and offers the way to change or remove it.
    func testAReadyAutomaticInboxNamesItsFolderAndItsPolicy() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let ready = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                "Ready to receive", "Ready to receive")
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)

        XCTAssertTrue(element("inbox-folder", in: settings).exists,
                      "a ready inbox does not say where it receives")
        XCTAssertTrue(element("inbox-choose-folder", in: settings).exists)
        XCTAssertTrue(element("inbox-remove-folder", in: settings).exists,
                      "a chosen folder cannot be given back")
        XCTAssertTrue(element("inbox-policy", in: settings).exists)
        XCTAssertTrue(element("inbox-open-at-login", in: settings).exists,
                      "residency has no control on the surface that depends on it")
        // Open at Login is not evidence the inbox is ready now, and the pane
        // says so rather than leaving the inference to the reader.
        XCTAssertTrue(visibleText(in: settings).contains("does not mean the inbox is ready"),
                      "Open at Login is presented as proof of readiness")
    }

    // MARK: - folder attention

    /// A grant that will not resolve is actionable and truthful: it asks for the
    /// folder again rather than offering a retry that cannot help, and it never
    /// reads as ready.
    func testAFolderAttentionStateAsksForTheFolderRatherThanARetry() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-attention"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let broken = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                 "receive folder", "receive folder")
        expectation(for: broken, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertFalse(text(of: status).contains("Ready to receive"),
                       "a broken grant rendered as ready")

        let recovery = element("inbox-recovery", in: settings)
        XCTAssertTrue(recovery.waitForExistence(timeout: 10),
                      "a folder problem offers no way out")
        XCTAssertTrue(recovery.label.contains("Choose Folder"),
                      "a folder problem offers a retry instead of the folder")
    }

    // MARK: - ask

    /// Two encrypted deliveries cannot reveal names before acceptance, but they
    /// must not render as two indistinguishable rows. Number and encrypted size
    /// are safe metadata and each row keeps its own answer controls.
    func testMultipleAskDeliveriesAreVisiblyDistinct() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ask"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        let asking = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                 "waiting for your answer", "waiting for your answer")
        expectation(for: asking, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        // The Settings form is intentionally compact; ask rows sit between the
        // status and folder sections and may be lazily created below the fold.
        settings.swipeUp()
        XCTAssertTrue(element("inbox-ask-accept-0", in: settings).waitForExistence(timeout: 20))
        XCTAssertTrue(element("inbox-ask-accept-1", in: settings).exists)
        XCTAssertTrue(element("inbox-ask-decline-0", in: settings).exists)
        XCTAssertTrue(element("inbox-ask-decline-1", in: settings).exists)
        let copy = visibleText(in: settings)
        XCTAssertTrue(copy.contains("1.0 KB"), "the first held delivery has no safe identity")
        XCTAssertTrue(copy.contains("8.0 KB"), "the second held delivery has no safe identity")
        XCTAssertFalse(copy.contains("task_ask_one") || copy.contains("task_ask_two"),
                       "the Ask surface exposed central task identifiers")
    }

    // MARK: - working

    /// A delivery in progress says so. The label names no file: this window can
    /// be on a shared screen.
    func testAWorkingInboxSaysSoWithoutNamingTheDelivery() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-working"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let working = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                  "Receiving…", "Receiving…")
        expectation(for: working, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 30)

        XCTAssertTrue(element("inbox-pause", in: settings).exists,
                      "a running inbox cannot be paused")
        XCTAssertFalse(visibleText(in: settings).contains("brief.txt"),
                       "the in-progress surface named the file being received")
    }

    // MARK: - a completed result

    /// A real delivery, decrypted and committed during this launch, appears as a
    /// result that can be revealed — and is described by count, size and time
    /// rather than by name.
    func testACompletedDeliveryOffersRevealInFinderWithoutNamingTheFile() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-result"])
        let settings = openDeviceInboxSettings()

        let reveal = element("inbox-reveal", in: settings)
        XCTAssertTrue(reveal.waitForExistence(timeout: 60),
                      "a completed delivery cannot be revealed in Finder")
        let row = text(of: element("inbox-result", in: settings))
        XCTAssertTrue(row.contains("1 file saved"), "the result does not say what arrived")
        // Scoped to the ROW, not to the window: the folder line legitimately
        // names the chosen folder, and asserting over the whole pane would make
        // this test pass or fail on that instead.
        XCTAssertFalse(row.contains("brief.txt"),
                       "the result rendered the received file's name")
        XCTAssertFalse(row.contains("/"), "the result rendered a path")
        // The spoken name carries the row, so two results do not sound alike.
        XCTAssertTrue(reveal.label.contains("Show in Finder"))
        XCTAssertTrue(reveal.label.contains("1 file saved"))
    }

    // MARK: - residency

    /// The property the whole capability rests on: closing the window does not
    /// stop the receiver, the menu bar still reports it, and reopening produces
    /// the SAME single window rather than a second one rendering the same
    /// app-scoped state twice.
    func testClosingTheWindowLeavesTheInboxRunningAndReopeningMakesNoSecondWindow() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let window = mainWindow
        window.buttons[XCUIIdentifierCloseWindow].click()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: window, handler: nil)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(app.state, .runningForeground,
                       "closing the window ended the process the inbox lives in")

        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 10),
                      "the resident app has no menu-bar surface")
        statusItem.click()
        // With no window at all, this line is the only thing that can say whether
        // this Mac is currently able to take a delivery.
        let inboxLine = app.menuItems.allElementsBoundByIndex
            .first { $0.title.contains("Device Inbox") }
            ?? app.descendants(matching: .any).matching(
                NSPredicate(format: "label CONTAINS[c] %@", "Device Inbox")).firstMatch
        XCTAssertTrue(inboxLine.exists,
                      "the menu bar does not report the Device Inbox with the window closed")

        app.typeKey("o", modifierFlags: [])
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 15),
                      "the menu bar could not reopen the window")
        let productWindows = app.windows.allElementsBoundByIndex
            .filter { $0.frame.width >= 800 && $0.frame.height >= 500 }
        XCTAssertEqual(productWindows.count, 1,
                       "reopening produced a second window rendering the same state twice")
    }

    /// **The menu-bar route to Settings, clicked.**
    ///
    /// This is the state the item exists for and the one nothing covered: the
    /// window is closed, so the menu bar is the only surface there is, and the
    /// app is not frontmost when the click arrives. Asserting that the item is
    /// PRESENT — which is all the suite did — passes against a button wired to
    /// nothing, and that is exactly what shipped: on macOS 26.6 the item was
    /// there and produced no window.
    ///
    /// Every window is closed first, deliberately. `Settings` is a lazily built
    /// scene, so an already-open settings window would let a no-op action look
    /// like a success, and the product window would supply a responder chain the
    /// real failing case does not have.
    func testTheMenuBarOpensSettingsWithEveryWindowClosed() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let window = mainWindow
        window.buttons[XCUIIdentifierCloseWindow].click()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: window, handler: nil)
        waitForExpectations(timeout: 15)
        XCTAssertNil(settingsWindow,
                     "a settings window was already open, so this proves nothing")
        XCTAssertEqual(app.state, .runningForeground,
                       "closing the window ended the process the menu bar lives in")

        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 10),
                      "the resident app has no menu-bar surface")
        statusItem.click()
        let openSettings = app.menuItems.allElementsBoundByIndex
            .first { $0.title.contains("Open Device Inbox settings") }
        XCTAssertNotNil(openSettings, "the menu bar has no route to Device Inbox settings")
        openSettings?.click()

        // The scene, not merely "a window": width is the shipped contract and
        // the pane below is what the item promises to show.
        guard let settings = waitForSettingsWindow(timeout: 20) else {
            return XCTFail("clicking Open Device Inbox settings opened no settings window")
        }
        XCTAssertEqual(settings.frame.width, 520, accuracy: 1,
                       "the window that opened is not the 520-point settings scene")
        // Held to the same proof as the app-menu route: the shared helper fails
        // unless the Device Inbox pane itself is selectable and on screen, so a
        // settings window that opened on some other tab is not a pass.
        selectDeviceInboxPane()
    }

    // MARK: - the three-way policy

    /// The three choices, addressed the way the product identifies them.
    private func policyChoice(_ policy: String, in settings: XCUIElement) -> XCUIElement {
        element("inbox-policy-\(policy)", in: settings)
    }

    /// **Each receiving choice is its own control.**
    ///
    /// Whatever the section did before, it could not be checked. The container
    /// element existed and the section rendered, so every assertion anyone wrote
    /// passed; none of them could name a single choice.
    ///
    /// Two separate observations sit behind this test, and they do not agree, so
    /// both are recorded rather than merged:
    ///
    /// - Acceptance review reported that on the INSTALLED Developer ID build on
    ///   macOS 26.6, the radio group's three children all reported the same name
    ///   "Receiving", the same selected value and the same activation point.
    /// - Measured here on macOS 26.6 against a locally signed DEBUG build, they
    ///   did not: the three buttons carried distinct labels, distinct values and
    ///   distinct frames. What they carried instead was NO identifier at all —
    ///   `inbox-policy` resolved to exactly one element, the group, and stopped
    ///   there. A `Picker` does not propagate an identifier down the way the
    ///   containers elsewhere in this file do; it strands it on the group.
    ///
    /// The repair covers both, which is why the assertions below are wider than
    /// the reproduction. Distinct identifiers fix the gap that WAS reproduced,
    /// and distinct names, distinct activation points and a single selection
    /// would fail loudly if the reported collapse ever appears here — including
    /// on a configuration or an assistive-technology path this suite cannot
    /// launch. One of these three choices authorizes unattended writes to the
    /// user's disk, so "you cannot tell which one you are choosing" is the defect
    /// whether it arrives as a shared name or as no name at all.
    func testEachReceivingPolicyChoiceIsSeparatelyIdentifiable() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let settings = openDeviceInboxSettings()

        let off = policyChoice("off", in: settings)
        XCTAssertTrue(off.waitForExistence(timeout: 15),
                      "the Off choice has no identity of its own")
        let ask = policyChoice("ask", in: settings)
        let auto = policyChoice("auto", in: settings)
        XCTAssertTrue(ask.exists, "the Ask every time choice has no identity of its own")
        XCTAssertTrue(auto.exists, "the Automatically choice has no identity of its own")

        // The spoken names. Each must carry its OWN copy — the property the
        // installed build was reported to have lost, where all three said
        // "Receiving". It held in this launch before the repair as well, so this
        // is the guard against the reported collapse, not a reproduction of it.
        XCTAssertTrue(text(of: off).contains("Off"),
                      "the Off choice does not say what it is")
        XCTAssertTrue(text(of: ask).contains("Ask every time"),
                      "the Ask choice does not say what it is")
        XCTAssertTrue(text(of: auto).contains("Receive automatically from my account"),
                      "the unattended-write choice does not say what it is")
        // Stated as a set, so two choices collapsing into one name fails here even
        // if the substrings above happen to be satisfied by a shared string.
        XCTAssertEqual(Set([off.label, ask.label, auto.label]).count, 3,
                       "the three receiving choices share a spoken name")

        // Three separate activation points. Two controls that report the same
        // point are one control to anything driving this pane.
        let points = [off, ask, auto].map { CGPoint(x: $0.frame.midX, y: $0.frame.midY) }
        XCTAssertEqual(Set(points.map { "\($0.x)x\($0.y)" }).count, 3,
                       "the receiving choices share an activation point")

        // Exactly one is selected, and it is the one the fixture stored. A picker
        // whose children all report the group's value cannot answer this.
        XCTAssertTrue(isSelected(auto),
                      "the stored Automatically policy is not reported as selected")
        XCTAssertFalse(isSelected(off), "Off is reported selected alongside Automatically")
        XCTAssertFalse(isSelected(ask), "Ask is reported selected alongside Automatically")

        // One identifier, one element. This is the assertion that actually fails
        // when the container identifier comes back: restoring
        // `.accessibilityIdentifier("inbox-policy")` on the `Picker` was measured
        // to take `inbox-policy` from one match to two — the section heading and
        // the radio group — while `element(_:in:)` resolves by `firstMatch` and
        // would go on returning whichever of them the query happened to order
        // first. That is how the section marker silently stops meaning the
        // section, and it is the state the pane shipped in.
        for choice in ["off", "ask", "auto"] {
            let matches = settings.descendants(matching: .any)
                .matching(identifier: "inbox-policy-\(choice)").count
            XCTAssertEqual(matches, 1,
                           "inbox-policy-\(choice) does not identify exactly one control")
        }
        // And the section marker names the SECTION, not the controls: it is on a
        // header leaf precisely so it cannot reach into them.
        XCTAssertEqual(settings.descendants(matching: .any)
            .matching(identifier: "inbox-policy").count, 1,
                       "the policy section marker matches more than the section heading")
        XCTAssertEqual(settings.radioButtons.matching(identifier: "inbox-policy").count, 0,
                       "the section marker propagated onto the receiving choices")
    }

    /// A radio button reports its selection in `value` as 1/0 on macOS, while
    /// `isSelected` is the AppKit-side trait. Read both, because which one carries
    /// it varies by macOS version — the same label/value split this file records
    /// for the settings tab control.
    private func isSelected(_ element: XCUIElement) -> Bool {
        if element.isSelected { return true }
        let value = element.value.map { String(describing: $0) } ?? ""
        return value == "1" || value == "true"
    }

    /// **Choosing Automatically actually turns receiving on.**
    ///
    /// Distinguishable is not the same as actionable, and the reason to insist on
    /// both is that the failing build had a picker that LOOKED settable. So this
    /// drives the real consent boundary: switch receiving Off, watch the running
    /// controller report Off, then choose Automatically with the folder still
    /// granted and watch it report that it is ready to receive.
    ///
    /// The status line is the assertion target on purpose. It is rendered from
    /// `InboxController.state`, not from the picker's own binding, so it can only
    /// change if the click reached the controller and the controller accepted the
    /// policy — which is the thing the store refuses to do without a folder.
    func testChoosingAutomaticallyTurnsReceivingOnWithAGrantedFolder() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let settings = openDeviceInboxSettings()

        let status = element("inbox-status", in: settings)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let ready = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                "Ready to receive", "Ready to receive")
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(element("inbox-folder", in: settings).exists,
                      "this fixture is supposed to start with a granted folder")

        // Off first, so the Automatically click below has something to change.
        // Starting from the fixture's stored `auto` and clicking `auto` would
        // assert nothing: a picker wired to nothing would pass it.
        let off = policyChoice("off", in: settings)
        XCTAssertTrue(off.waitForExistence(timeout: 15),
                      "the Off choice has no identity of its own")
        off.click()
        let switchedOff = NSPredicate(format: "NOT (label CONTAINS[c] %@ OR value CONTAINS[c] %@)",
                                      "Ready to receive", "Ready to receive")
        expectation(for: switchedOff, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(isSelected(off), "Off was clicked and did not become the selection")

        // And back on. The folder grant was never touched, so the store has no
        // reason to refuse — and the status returning to ready is the running
        // controller agreeing, not the picker redrawing itself.
        let auto = policyChoice("auto", in: settings)
        XCTAssertTrue(auto.exists, "the Automatically choice has no identity of its own")
        auto.click()
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(isSelected(auto),
                      "Automatically was clicked and did not become the selection")
        XCTAssertFalse(isSelected(off),
                       "Off stayed selected after Automatically was chosen")
        // The consent is one choice, not an accumulation of them.
        XCTAssertFalse(isSelected(policyChoice("ask", in: settings)),
                       "Ask became selected while Automatically was chosen")
    }

    // MARK: - blocked notification banners

    /// The launch every notification test starts from: a working, ready inbox
    /// whose banners macOS will not show.
    private func launchWithBlockedBanners(recovering: Bool = false) -> XCUIElement {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready",
                recovering ? "--relayium-ui-testing-inbox-notifications-recover"
                           : "--relayium-ui-testing-inbox-notifications-denied"])
        return openDeviceInboxSettings()
    }

    /// Wait for the ready status, which is also the proof that the receiver under
    /// this pane is genuinely running rather than merely rendered.
    private func waitForReady(in settings: XCUIElement) {
        let status = element("inbox-status", in: settings)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let ready = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                "Ready to receive", "Ready to receive")
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
    }

    /// **The state that shipped silent.**
    ///
    /// On the installed build, a Mac whose notification authorization had been
    /// refused discarded the banner and said nothing: no status, no warning, and
    /// nothing anywhere in the app that could change it. This is that Mac, and
    /// what it now says.
    ///
    /// The second assertion is the one that keeps the repair from creating a worse
    /// bug than it fixes. "Notifications are off" alone, in the Device Inbox pane,
    /// reads as "the Device Inbox is off" — so the surface has to state that files
    /// are still received and still saved, and the status line beside it has to go
    /// on saying Ready. A user who stops trusting the feature because of a warning
    /// about banners has lost more than the banner.
    func testBlockedBannersSayReceivingStillWorksAndOfferSystemSettings() {
        let settings = launchWithBlockedBanners()

        let blocked = element("inbox-banners-blocked", in: settings)
        XCTAssertTrue(blocked.waitForExistence(timeout: 20),
                      "a Mac that will show no banner says nothing about it")
        XCTAssertTrue(text(of: blocked).contains("Notification banners are turned off"),
                      "the warning does not say what is actually switched off")

        let copy = visibleText(in: settings)
        XCTAssertTrue(copy.contains("still received and saved"),
                      "the warning does not say that deliveries still arrive and are saved")

        // Still ready. The receiver under this pane is the real one, so this is
        // the product agreeing that a blocked banner has not stopped anything.
        waitForReady(in: settings)

        let action = element("inbox-open-notification-settings", in: settings)
        XCTAssertTrue(action.exists, "there is no way to change it from inside the app")
        XCTAssertTrue(action.isEnabled, "the only route out of this state is disabled")
        XCTAssertTrue(action.label.contains("Notification settings"),
                      "the action does not say where it goes")
        XCTAssertFalse(element("inbox-notification-settings-error", in: settings).exists,
                       "a refusal is shown before the button has been pressed")

        // **Leaf discipline, measured rather than assumed.**
        //
        // This pane has lost a control to identifier propagation twice: once on
        // the result row, where the row's identifier renamed the Reveal button
        // inside it, and once on the Ask section's container, where it renamed all
        // four answer buttons. Both looked correct on screen and both left a
        // control unreachable. The warning and the button here sit in one section,
        // so the same mistake is one edit away, and it is checked the same way the
        // policy choices are: by counting.
        XCTAssertEqual(settings.descendants(matching: .any)
            .matching(identifier: "inbox-open-notification-settings").count, 1,
                       "the System Settings action does not identify exactly one control")
        XCTAssertEqual(settings.buttons.matching(identifier: "inbox-banners-blocked").count, 0,
                       "the warning's identifier propagated onto the recovery button")
        XCTAssertFalse(action.label.contains("Notification banners are turned off"),
                       "the button is speaking the warning's copy instead of its own")
    }

    /// **The button reports a platform that will not open its own settings.**
    ///
    /// This launch's opener answers no, which is the one way this recovery can
    /// fail. Pressing it has to produce a sentence rather than nothing: a control
    /// that silently does nothing is the same defect as the silently discarded
    /// banner, and this app has already shipped one recovery button whose action
    /// was a `break`. Pressing it is also what proves the control is wired at all
    /// — asserting that it EXISTS passes against a button connected to nothing.
    func testTheSystemSettingsActionSaysSoWhenThePlatformRefusesIt() {
        let settings = launchWithBlockedBanners()
        let action = element("inbox-open-notification-settings", in: settings)
        XCTAssertTrue(action.waitForExistence(timeout: 20))
        action.click()

        let refusal = element("inbox-notification-settings-error", in: settings)
        XCTAssertTrue(refusal.waitForExistence(timeout: 10),
                      "the action did nothing and said nothing")
        XCTAssertTrue(text(of: refusal).contains("open System Settings"),
                      "the refusal does not name what could not be done")
        // Beside the button that caused it, not three sections away in the status
        // block where it would read as an unrelated fault.
        XCTAssertTrue(element("inbox-banners-blocked", in: settings).exists,
                      "the refusal replaced the state it belongs to")
        XCTAssertFalse(element("inbox-error", in: settings).exists,
                       "the refusal was also rendered in the general error slot")
    }

    /// **The warning goes away when the user fixes it, without a relaunch.**
    ///
    /// macOS publishes nothing when notification authorization changes, so the
    /// pane re-asks instead. This drives the whole journey: the warning is there,
    /// the button is pressed, the setting changes outside the app, and the pane is
    /// looked at again.
    ///
    /// Pressing the button is load-bearing rather than decorative — this launch's
    /// fixture only reports `allowed` once the pane's own action has actually run,
    /// so a button wired to nothing leaves the warning up and fails here.
    func testAllowingNotificationsRemovesTheWarningWithoutARelaunch() {
        var settings = launchWithBlockedBanners(recovering: true)
        let blocked = element("inbox-banners-blocked", in: settings)
        XCTAssertTrue(blocked.waitForExistence(timeout: 20),
                      "this launch is supposed to start with banners blocked")

        let action = element("inbox-open-notification-settings", in: settings)
        XCTAssertTrue(action.exists)
        action.click()
        XCTAssertFalse(element("inbox-notification-settings-error", in: settings).exists,
                       "an opener that succeeded still reported a refusal")

        // Away and back, which is what a person does: the pane re-measures when it
        // appears, so this is the same code path as returning from System
        // Settings. The window is closed rather than merely switched away from, so
        // the assertion cannot pass on a stale view that never re-ran.
        settings.buttons[XCUIIdentifierCloseWindow].click()
        let closed = NSPredicate(format: "exists == false")
        expectation(for: closed, evaluatedWith: blocked, handler: nil)
        waitForExpectations(timeout: 15)
        settings = openDeviceInboxSettings()

        // The pane is up and the receiver is running, and the warning is not here.
        waitForReady(in: settings)
        XCTAssertFalse(element("inbox-banners-blocked", in: settings).exists,
                       "the warning survived the user allowing notifications")
        XCTAssertFalse(element("inbox-open-notification-settings", in: settings).exists,
                       "the recovery is still offered for a problem that is fixed")
        XCTAssertFalse(visibleText(in: settings).contains("Notification banners are turned off"))
    }

    /// The menu bar carries the smallest safe control set and NOT the
    /// consequential consents: no folder chooser and no policy control, both of
    /// which belong on a screen with their explanations.
    func testTheMenuBarOffersNoFolderGrantAndNoPolicyChange() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 10))
        statusItem.click()
        let titles = app.menuItems.allElementsBoundByIndex.map(\.title)
        XCTAssertFalse(titles.contains { $0.contains("Choose Folder") },
                       "the menu bar offers a folder grant")
        XCTAssertFalse(titles.contains { $0.contains("Receive automatically") },
                       "the menu bar offers the unattended-write consent")
        XCTAssertTrue(titles.contains { $0.contains("Open Device Inbox settings") },
                      "the menu bar has no route to where those decisions are made")
    }
}
