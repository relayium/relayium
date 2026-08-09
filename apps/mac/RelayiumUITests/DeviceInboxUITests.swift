import XCTest

/// The Device Inbox, driven through the app a person actually uses.
///
/// The package suites already assert what the controller decides and what the
/// SwiftUI files contain. What only appears at runtime is whether those
/// decisions reach a screen: a destination that fails to build, a status that
/// renders nothing, a Reveal control that is not there, and — the one this whole
/// capability rests on — a receiver that stops when the window closes.
///
/// **Every functional flow here is driven through the main window's Device Inbox
/// destination**, which is the first-class surface the product now leads with.
/// They used to be driven through ⌘, ▸ Device Inbox, and that setup was flaky
/// rather than merely indirect: opening the settings scene and then finding a tab
/// whose control type varies by macOS left the pane unselected, and the failure
/// moved between tests, which is the signature of shared setup rather than of any
/// one product behaviour. Settings still renders the identical surface, and
/// `InboxSurfaceGuardTests` proves it does from the source — one file, two thin
/// hosts, no second copy of a control that could disagree.
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
    ///
    /// **Only ever read to assert that it is absent.** No functional flow in this
    /// file goes through Settings any more. Driving one meant opening the scene
    /// and then selecting a tab whose control type varies by macOS version, and
    /// that setup was measured to fail on the hosted runner and locally, moving
    /// between tests — the pane simply never came up. It was never the product
    /// under test either: the Device Inbox now has a first-class destination, and
    /// `InboxSurfaceGuardTests.testBothDeviceInboxEntriesRenderTheOneSharedSurface`
    /// proves by source that the settings tab renders that same one surface, which
    /// is a stronger statement than a second runtime pass over a copy of it.
    private var settingsWindow: XCUIElement? {
        app.windows.allElementsBoundByIndex
            .first { $0.frame.width >= 400 && $0.frame.width < 800 }
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

    // MARK: - the first-class destination

    /// The sidebar row, addressed the way the product identifies it.
    ///
    /// The fallback mirrors `AppShellUITests`: macOS 15 does not always propagate
    /// a combined `List` row's identifier into the AX tree, and the destination
    /// heading carries the same words as the row — so the visible fallback is
    /// scoped to the leading half of the window, never to "the first element with
    /// this label".
    private func sidebarDeviceInbox(in window: XCUIElement) -> XCUIElement {
        let stable = element("sidebar-deviceInbox", in: window)
        if stable.exists { return stable }
        let dividing = window.frame.midX
        let visible = NSPredicate(format: "label == %@ OR value == %@",
                                  "Device Inbox", "Device Inbox")
        return window.descendants(matching: .any).matching(visible)
            .allElementsBoundByIndex.first { $0.frame.midX < dividing } ?? stable
    }

    /// Put the Device Inbox destination on screen through the sidebar, the way a
    /// person reaches it.
    @discardableResult
    private func openDeviceInboxDestination() -> XCUIElement {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let row = sidebarDeviceInbox(in: window)
        XCTAssertTrue(row.waitForExistence(timeout: 10),
                      "the sidebar has no Device Inbox row")
        row.click()
        XCTAssertTrue(element("destination-deviceInbox", in: window).waitForExistence(timeout: 10),
                      "the Device Inbox row opened no destination")
        return window
    }

    /// A control that may be below the fold of a long form.
    ///
    /// The Device Inbox surface is seven sections tall in the main window, and a
    /// SwiftUI `Form` creates its rows lazily. Scrolling once and re-asking is the
    /// difference between "this control is missing" and "this window is 700 points
    /// high", and only one of those is a product defect.
    ///
    /// The timeout is a parameter because two different things are being waited
    /// for here. Most of these controls are rendered the moment the destination
    /// is: the only question is whether they are on screen. A completed delivery
    /// is not — the receiver has to decrypt and commit a real file first — so that
    /// one waits far longer before concluding the control is missing.
    private func revealed(_ identifier: String, in window: XCUIElement,
                          timeout: TimeInterval = 5) -> XCUIElement {
        let found = element(identifier, in: window)
        if found.waitForExistence(timeout: timeout) { return found }
        window.swipeUp()
        _ = found.waitForExistence(timeout: timeout)
        return found
    }

    /// A control the user is meant to act on, checked the way a person meets it:
    /// drawn inside the window, and clickable where it is drawn.
    ///
    /// **Existence is not the property that failed.** The defect this guards
    /// against had every one of these controls in the accessibility tree, with
    /// the right identifier and the right label — and laid out above the top of
    /// the window, because the destination's content was taller than the window
    /// and SwiftUI centres what overflows. `exists` was true throughout. What was
    /// false was that anybody could see or press them.
    ///
    /// The vertical bounds are asserted separately from `contains` so the failure
    /// says WHICH edge and by how much: "23pt above the top of the window" is a
    /// layout report, and `Not hittable` on its own is not.
    private func assertOnScreen(_ element: XCUIElement, _ name: String,
                                in window: XCUIElement, clickable: Bool = true,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.exists, "\(name) is not on the destination at all",
                      file: file, line: line)
        let frame = element.frame
        let bounds = window.frame
        XCTAssertGreaterThanOrEqual(
            frame.minY, bounds.minY,
            "\(name) is drawn \(Int(bounds.minY - frame.minY))pt above the top of the "
            + "\(Int(bounds.width))x\(Int(bounds.height)) window, where it cannot be "
            + "seen or reached", file: file, line: line)
        XCTAssertLessThanOrEqual(
            frame.maxY, bounds.maxY,
            "\(name) is drawn \(Int(frame.maxY - bounds.maxY))pt below the bottom of the "
            + "\(Int(bounds.width))x\(Int(bounds.height)) window", file: file, line: line)
        XCTAssertTrue(bounds.contains(frame),
                      "\(name) at \(frame) is outside the window at \(bounds)",
                      file: file, line: line)
        if clickable {
            // Occlusion, which the frame arithmetic above cannot see: an element
            // inside the window but underneath the toolbar reads as present and
            // still cannot be pressed.
            XCTAssertTrue(element.isHittable,
                          "\(name) is inside the window at \(frame) and still not "
                          + "clickable", file: file, line: line)
        }
    }

    /// **The two actions a signed-out visitor has are on the screen.**
    ///
    /// This is the state the destination exists to serve — the row is deliberately
    /// visible before anybody has an account — and these two controls are the
    /// entire way out of it. They were in the tree, correctly named and correctly
    /// wired, and laid out above the top edge of the window: measured on macOS
    /// 26.6 at the shipped minimum, the destination's content came out 1326pt tall
    /// inside a 560pt column, SwiftUI centred the overflow, and the heading, the
    /// section header, **Sign in** and **Create an account** all sat off the top.
    ///
    /// The tests that click them caught it as `Not hittable`, which is true but
    /// says nothing about why. This one states the product property directly: at
    /// the smallest window the app allows, the primary account actions of the
    /// signed-out Device Inbox are visible and pressable without scrolling
    /// anything — they are the first thing on the screen, so needing to scroll to
    /// them would be the same defect wearing a different name.
    func testTheSignedOutAccountActionsAreOnScreenAtTheMinimumWindow() {
        launch([])
        let window = openDeviceInboxDestination()

        // The stated minimum is a USABLE size, not merely an allowed one, and it
        // is the size this window comes up at.
        XCTAssertGreaterThanOrEqual(window.frame.width, 860,
                                    "the work area is narrower than the stated minimum")
        XCTAssertGreaterThanOrEqual(window.frame.height, 560,
                                    "the work area is shorter than the stated minimum")

        // The screen's own title went off the top with them, and a destination
        // whose heading is missing does not read as a destination at all.
        assertOnScreen(element("inbox-signed-out", in: window),
                       "the signed-out Device Inbox heading",
                       in: window, clickable: false)

        let signIn = window.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 10),
                      "the signed-out destination has no way to sign in")
        assertOnScreen(signIn, "Sign in", in: window)

        let create = element("account.create", in: window)
        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "the signed-out destination cannot create an account")
        assertOnScreen(create, "Create an account", in: window)
    }

    /// **The row is there, and it opens the feature rather than a link to it.**
    ///
    /// This is the whole defect the batch exists for, stated as one assertion: a
    /// capability with a resident receiver, a menu-bar line and a complete
    /// settings pane was in practice absent, because the main window never named
    /// it. Signed out on purpose — the row has to be findable BEFORE somebody has
    /// an account, or it cannot be what tells them the feature exists.
    func testTheSidebarRowOpensTheDeviceInboxDestination() {
        launch([])
        let window = openDeviceInboxDestination()
        // The destination, not the sidebar row that shares its name: the detail
        // surface carries its own identifier for exactly this reason.
        XCTAssertTrue(element("destination-deviceInbox", in: window).exists)
        // And it explains itself rather than pointing at Settings.
        let copy = visibleText(in: window)
        XCTAssertTrue(copy.contains("Choose a folder on this Mac"),
                      "the destination never says what Device Inbox does")
        XCTAssertFalse(copy.contains("Open Device Inbox settings"),
                       "the destination forwards the user to Settings instead of working")
        // The other five destinations are still reachable beside it.
        for other in ["sidebar-nearby", "sidebar-pairingCode", "sidebar-storedSend",
                      "sidebar-storedReceive", "sidebar-account"] {
            XCTAssertTrue(element(other, in: window).exists,
                          "adding the Device Inbox row displaced \(other)")
        }
    }

    /// **Signed out, the destination is useful rather than merely present.**
    ///
    /// It states what the capability needs, and the way out is a control that
    /// actually goes somewhere — pressed here, and checked by what it produces.
    /// A row that renders two sentences and no action is the same dead end as the
    /// silent notification banner this product already shipped once.
    func testTheSignedOutDestinationExplainsItselfAndCanReachTheForm() {
        launch([])
        let window = openDeviceInboxDestination()

        XCTAssertTrue(element("inbox-signed-out", in: window).waitForExistence(timeout: 10),
                      "the signed-out destination says nothing about why it is empty")
        let copy = visibleText(in: window)
        XCTAssertTrue(copy.contains("Device Inbox delivers files sent from your own account"),
                      "the destination does not say why it needs an account")
        // Nothing that could not be stored is offered. The controller refuses a
        // grant and a policy without a generation, and a disabled-looking control
        // is exactly what this app replaced with stated reasons.
        XCTAssertFalse(element("inbox-choose-folder", in: window).exists,
                       "a signed-out destination offers a folder grant it cannot store")
        XCTAssertFalse(element("inbox-policy", in: window).exists,
                       "a signed-out destination offers the unattended-write consent")

        let signIn = window.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 10),
                      "the signed-out destination has no way to sign in")
        signIn.click()
        // What it produced, not that it was clickable: the Account destination on
        // the sign-in half of the form.
        XCTAssertTrue(element("destination-account", in: window).waitForExistence(timeout: 10),
                      "Sign in did not open the Account destination")
        XCTAssertTrue(window.staticTexts["Welcome back"].waitForExistence(timeout: 10),
                      "Sign in landed somewhere other than the sign-in form")
    }

    /// The second action, and the half it promises.
    ///
    /// Separate from the test above because the failure it catches is specific:
    /// routing to the Account destination without naming the create-account half
    /// lands **Create an account** on a sign-in form — a button that says one
    /// thing and produces another, which is the defect `CapabilityGateView` was
    /// built to remove and would silently reappear here.
    func testTheSignedOutDestinationCanReachTheCreateAccountForm() {
        launch([])
        let window = openDeviceInboxDestination()

        let create = element("account.create", in: window)
        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "the signed-out destination cannot create an account")
        create.click()
        XCTAssertTrue(element("destination-account", in: window).waitForExistence(timeout: 10))
        XCTAssertTrue(window.staticTexts["Create your Relayium account"]
            .waitForExistence(timeout: 10),
                      "Create an account produced the sign-in form instead")
    }

    /// **An account the receiver could not adopt is truthful and not a dead end.**
    ///
    /// This launch's `/api/me` answers with an account id the Device Inbox
    /// refuses to use as a keychain item name, which is the one state where "an
    /// account is signed in" and "the receiver is running" disagree permanently.
    /// Everything under it is real: the real session, the real bridge, the real
    /// controller and the real identifier check.
    ///
    /// Both halves of the branch are asserted, because each of the two obvious
    /// renderings fails a different way. The full surface would put a folder
    /// chooser and a receiving policy on screen whose setters return immediately
    /// — controls that look operable and do nothing. The capability gate would be
    /// handed an `.allowed` it asserts on and draws nothing for, leaving a blank
    /// screen. So: a status line that says what is wrong, one route out, and none
    /// of the controls that cannot work.
    func testAnAccountTheReceiverCannotUseSaysSoAndOffersARouteOut() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-unusable-account"])
        let window = openDeviceInboxDestination()

        let status = element("inbox-status", in: window)
        XCTAssertTrue(status.waitForExistence(timeout: 15),
                      "an account the receiver refused renders no status at all")
        let refused = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                  "Sign in again to keep receiving",
                                  "Sign in again to keep receiving")
        expectation(for: refused, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertFalse(text(of: status).contains("Ready to receive"),
                       "an inbox that cannot start rendered as ready")
        // The explanation is still there, so the screen is not a bare error.
        XCTAssertTrue(visibleText(in: window).contains("Choose a folder on this Mac"),
                      "a refused account leaves the destination with no explanation at all")

        // None of the controls the controller would refuse.
        for dead in ["inbox-choose-folder", "inbox-remove-folder", "inbox-policy",
                     "inbox-recovery", "inbox-pause"] {
            XCTAssertFalse(element(dead, in: window).exists,
                           "\(dead) is offered for an account with no generation, so pressing "
                           + "it does nothing")
        }
        // And one that is not dead: pressed, and checked by what it produced.
        let openAccount = element("inbox-open-account", in: window)
        XCTAssertTrue(openAccount.exists,
                      "an account the receiver refused is a dead end with no route out")
        // On the screen, not merely in the tree. This branch renders one section
        // and one button, and that button was measured at y=-1 — one point above
        // the top of the window — while `exists` stayed true the whole time. A
        // route out that cannot be seen or pressed is the dead end this assertion
        // says it is not.
        assertOnScreen(openAccount, "Open Account", in: window)
        openAccount.click()
        XCTAssertTrue(element("destination-account", in: window).waitForExistence(timeout: 10),
                      "the route out of a refused account goes nowhere")
    }

    /// **The destination carries the WHOLE surface, not a summary of it.**
    ///
    /// The requirement is that Settings stops being the only full entry, and the
    /// way that fails quietly is a destination that shows a status line and a
    /// "change this in Settings" link. Every consequential control is named here:
    /// status, the folder grant and its removal, all three receiving choices, the
    /// result list and residency.
    func testTheDestinationCarriesTheCompleteSignedInSurface() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let window = openDeviceInboxDestination()

        let status = element("inbox-status", in: window)
        XCTAssertTrue(status.waitForExistence(timeout: 15),
                      "the destination renders no Device Inbox status at all")
        let ready = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                "Ready to receive", "Ready to receive")
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)

        XCTAssertTrue(element("inbox-folder", in: window).exists,
                      "the destination does not say where it receives")
        XCTAssertTrue(element("inbox-choose-folder", in: window).exists,
                      "the folder grant cannot be given from the destination")
        XCTAssertTrue(element("inbox-remove-folder", in: window).exists,
                      "a chosen folder cannot be given back from the destination")
        for choice in ["off", "ask", "auto"] {
            XCTAssertTrue(element("inbox-policy-\(choice)", in: window).exists,
                          "the \(choice) receiving choice is not on the destination")
        }
        XCTAssertTrue(revealed("inbox-results-empty", in: window).exists,
                      "the destination has no result list")
        XCTAssertTrue(revealed("inbox-open-at-login", in: window).exists,
                      "residency has no control on the destination that depends on it")
        XCTAssertTrue(visibleText(in: window).contains("does not mean the inbox is ready"),
                      "Open at Login is presented as proof of readiness")
        // The consent is operable here, not merely visible. The status line is
        // rendered from `InboxController.state` rather than from the picker's own
        // binding, so it can only change if the click reached the controller.
        element("inbox-policy-off", in: window).click()
        let switchedOff = NSPredicate(format: "NOT (label CONTAINS[c] %@ OR value CONTAINS[c] %@)",
                                      "Ready to receive", "Ready to receive")
        expectation(for: switchedOff, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        element("inbox-policy-auto", in: window).click()
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
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

    /// The whole text of a surface, for assertions about what is NOT on it. Built
    /// from labels and values because SwiftUI splits a `Form` across many
    /// elements and macOS 15 drops identifiers from some of them.
    private func visibleText(in window: XCUIElement) -> String {
        window.descendants(matching: .any).allElementsBoundByIndex
            .map { "\($0.label) \($0.value.map { String(describing: $0) } ?? "")" }
            .joined(separator: "\n")
    }

    // MARK: - signed out

    /// Signed out, the surface explains what the capability needs rather than
    /// rendering a folder chooser that could not be used.
    func testSignedOutSetupExplainsWhatDeviceInboxNeeds() {
        launch([])
        let window = openDeviceInboxDestination()
        XCTAssertTrue(element("inbox-signed-out", in: window).waitForExistence(timeout: 10),
                      "a signed-out Device Inbox says nothing about why it is empty")
        XCTAssertFalse(element("inbox-choose-folder", in: window).exists,
                       "a signed-out surface offers a folder grant it cannot store")
        XCTAssertFalse(element("inbox-policy", in: window).exists)
    }

    // MARK: - ready

    /// A signed-in Mac with a chosen folder and Automatic selected says it is
    /// ready, names the folder, and offers the way to change or remove it.
    func testAReadyAutomaticInboxNamesItsFolderAndItsPolicy() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let window = openDeviceInboxDestination()

        let status = element("inbox-status", in: window)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let ready = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                "Ready to receive", "Ready to receive")
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)

        XCTAssertTrue(element("inbox-folder", in: window).exists,
                      "a ready inbox does not say where it receives")
        XCTAssertTrue(element("inbox-choose-folder", in: window).exists)
        XCTAssertTrue(element("inbox-remove-folder", in: window).exists,
                      "a chosen folder cannot be given back")
        XCTAssertTrue(element("inbox-policy", in: window).exists)
        XCTAssertTrue(revealed("inbox-open-at-login", in: window).exists,
                      "residency has no control on the surface that depends on it")
        // Open at Login is not evidence the inbox is ready now, and the surface
        // says so rather than leaving the inference to the reader.
        XCTAssertTrue(visibleText(in: window).contains("does not mean the inbox is ready"),
                      "Open at Login is presented as proof of readiness")
    }

    // MARK: - folder attention

    /// A grant that will not resolve is actionable and truthful: it asks for the
    /// folder again rather than offering a retry that cannot help, and it never
    /// reads as ready.
    func testAFolderAttentionStateAsksForTheFolderRatherThanARetry() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-attention"])
        let window = openDeviceInboxDestination()

        let status = element("inbox-status", in: window)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let broken = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                 "receive folder", "receive folder")
        expectation(for: broken, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertFalse(text(of: status).contains("Ready to receive"),
                       "a broken grant rendered as ready")

        let recovery = element("inbox-recovery", in: window)
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
        let window = openDeviceInboxDestination()

        let status = element("inbox-status", in: window)
        let asking = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                 "waiting for your answer", "waiting for your answer")
        expectation(for: asking, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        // Ask rows sit between the status and folder sections, and a `Form`
        // creates its rows lazily, so at the window's shorter sizes they can be
        // below the fold rather than absent.
        XCTAssertTrue(revealed("inbox-ask-accept-0", in: window, timeout: 20).exists)
        XCTAssertTrue(element("inbox-ask-accept-1", in: window).exists)
        XCTAssertTrue(element("inbox-ask-decline-0", in: window).exists)
        XCTAssertTrue(element("inbox-ask-decline-1", in: window).exists)
        let copy = visibleText(in: window)
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
        let window = openDeviceInboxDestination()

        let status = element("inbox-status", in: window)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let working = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                  "Receiving…", "Receiving…")
        expectation(for: working, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 30)

        XCTAssertTrue(element("inbox-pause", in: window).exists,
                      "a running inbox cannot be paused")
        XCTAssertFalse(visibleText(in: window).contains("brief.txt"),
                       "the in-progress surface named the file being received")
    }

    // MARK: - a completed result

    /// A real delivery, decrypted and committed during this launch, appears as a
    /// result that can be revealed — and is described by count, size and time
    /// rather than by name.
    func testACompletedDeliveryOffersRevealInFinderWithoutNamingTheFile() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-result"])
        let window = openDeviceInboxDestination()

        // The result list is the last section but one, so it may be below the
        // fold as well as not yet written — `revealed` distinguishes the two.
        let reveal = revealed("inbox-reveal", in: window, timeout: 60)
        XCTAssertTrue(reveal.exists,
                      "a completed delivery cannot be revealed in Finder")
        let row = text(of: element("inbox-result", in: window))
        XCTAssertTrue(row.contains("1 file saved"), "the result does not say what arrived")
        // Scoped to the ROW, not to the window: the folder line legitimately
        // names the chosen folder, and asserting over the whole surface would
        // make this test pass or fail on that instead.
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

    /// **The menu-bar route into the product, clicked.**
    ///
    /// This is the state the item exists for and the one nothing covered until
    /// the defect escaped: the window is closed, so the menu bar is the only
    /// surface there is, and the app is not frontmost when the click arrives.
    /// Asserting that the item is PRESENT — which is all the suite did — passes
    /// against a button wired to nothing, and that is exactly what shipped: on
    /// macOS 26.6 the item was there and produced no window.
    ///
    /// **What it opens changed with this batch.** It used to promise Settings,
    /// because the settings tab was the only full Device Inbox surface there was;
    /// it now opens the main window ON the Device Inbox destination. Both halves
    /// are asserted, because a window that opens on whatever the user last looked
    /// at is a menu item that names one thing and produces another.
    ///
    /// Every window is closed first, deliberately: an already-open window would
    /// let a no-op action look like a success and would supply a responder chain
    /// the real failing case does not have.
    func testTheMenuBarOpensTheDeviceInboxWithEveryWindowClosed() {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready"])
        let window = mainWindow
        // Somewhere else first, so "it opened on the Device Inbox" cannot be
        // satisfied by the destination the app happened to launch on.
        let nearby = element("sidebar-nearby", in: window)
        if nearby.waitForExistence(timeout: 10) { nearby.click() }
        window.buttons[XCUIIdentifierCloseWindow].click()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: window, handler: nil)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(app.state, .runningForeground,
                       "closing the window ended the process the menu bar lives in")

        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 10),
                      "the resident app has no menu-bar surface")
        statusItem.click()
        let openInbox = app.menuItems.allElementsBoundByIndex
            .first { $0.title.contains("Open Device Inbox") }
        XCTAssertNotNil(openInbox, "the menu bar has no route to the Device Inbox")
        XCTAssertFalse(openInbox?.title.contains("settings") ?? true,
                       "the menu bar still promises a settings window")
        openInbox?.click()

        // The product window, on the destination the item named — and not a
        // settings window, which is what this item used to produce.
        let reopened = mainWindow
        XCTAssertTrue(reopened.waitForExistence(timeout: 20),
                      "clicking Open Device Inbox opened no window")
        XCTAssertTrue(element("destination-deviceInbox", in: reopened).waitForExistence(timeout: 15),
                      "the window opened somewhere other than the Device Inbox")
        XCTAssertTrue(element("inbox-status", in: reopened).waitForExistence(timeout: 15),
                      "the destination it opened carries no Device Inbox surface")
        XCTAssertNil(settingsWindow,
                     "the menu-bar item still opens the settings scene")
        // Still the ONE window. `openWindow(id:)` against a unique `Window` scene
        // orders the existing one forward; against a `WindowGroup` it would build
        // a second, rendering the same app-scoped receiver twice.
        let productWindows = app.windows.allElementsBoundByIndex
            .filter { $0.frame.width >= 800 && $0.frame.height >= 500 }
        XCTAssertEqual(productWindows.count, 1,
                       "the menu-bar route produced a second product window")
    }

    // MARK: - the three-way policy

    /// The three choices, addressed the way the product identifies them.
    private func policyChoice(_ policy: String, in window: XCUIElement) -> XCUIElement {
        element("inbox-policy-\(policy)", in: window)
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
        let window = openDeviceInboxDestination()

        let off = policyChoice("off", in: window)
        XCTAssertTrue(off.waitForExistence(timeout: 15),
                      "the Off choice has no identity of its own")
        let ask = policyChoice("ask", in: window)
        let auto = policyChoice("auto", in: window)
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
        // point are one control to anything driving this surface.
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
        // section, and it is the state the surface shipped in.
        for choice in ["off", "ask", "auto"] {
            let matches = window.descendants(matching: .any)
                .matching(identifier: "inbox-policy-\(choice)").count
            XCTAssertEqual(matches, 1,
                           "inbox-policy-\(choice) does not identify exactly one control")
        }
        // And the section marker names the SECTION, not the controls: it is on a
        // header leaf precisely so it cannot reach into them.
        XCTAssertEqual(window.descendants(matching: .any)
            .matching(identifier: "inbox-policy").count, 1,
                       "the policy section marker matches more than the section heading")
        XCTAssertEqual(window.radioButtons.matching(identifier: "inbox-policy").count, 0,
                       "the section marker propagated onto the receiving choices")
    }

    /// A radio button reports its selection in `value` as 1/0 on macOS, while
    /// `isSelected` is the AppKit-side trait. Read both, because which one carries
    /// it varies by macOS version — the same label/value split this file records
    /// for the sidebar row.
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
        let window = openDeviceInboxDestination()

        let status = element("inbox-status", in: window)
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        let ready = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                                "Ready to receive", "Ready to receive")
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(element("inbox-folder", in: window).exists,
                      "this fixture is supposed to start with a granted folder")

        // Off first, so the Automatically click below has something to change.
        // Starting from the fixture's stored `auto` and clicking `auto` would
        // assert nothing: a picker wired to nothing would pass it.
        let off = policyChoice("off", in: window)
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
        let auto = policyChoice("auto", in: window)
        XCTAssertTrue(auto.exists, "the Automatically choice has no identity of its own")
        auto.click()
        expectation(for: ready, evaluatedWith: status, handler: nil)
        waitForExpectations(timeout: 20)
        XCTAssertTrue(isSelected(auto),
                      "Automatically was clicked and did not become the selection")
        XCTAssertFalse(isSelected(off),
                       "Off stayed selected after Automatically was chosen")
        // The consent is one choice, not an accumulation of them.
        XCTAssertFalse(isSelected(policyChoice("ask", in: window)),
                       "Ask became selected while Automatically was chosen")
    }

    // MARK: - blocked notification banners

    /// The launch every notification test starts from: a working, ready inbox
    /// whose banners macOS will not show.
    private func launchWithBlockedBanners(recovering: Bool = false) -> XCUIElement {
        launch(["--relayium-ui-testing-signed-in", "--relayium-ui-testing-inbox-ready",
                recovering ? "--relayium-ui-testing-inbox-notifications-recover"
                           : "--relayium-ui-testing-inbox-notifications-denied"])
        return openDeviceInboxDestination()
    }

    /// Wait for the ready status, which is also the proof that the receiver under
    /// this surface is genuinely running rather than merely rendered.
    private func waitForReady(in window: XCUIElement) {
        let status = element("inbox-status", in: window)
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
    /// bug than it fixes. "Notifications are off" alone, on the Device Inbox
    /// screen, reads as "the Device Inbox is off" — so the surface has to state
    /// that files are still received and still saved, and the status line beside
    /// it has to go on saying Ready. A user who stops trusting the feature because
    /// of a warning about banners has lost more than the banner.
    func testBlockedBannersSayReceivingStillWorksAndOfferSystemSettings() {
        let window = launchWithBlockedBanners()

        let blocked = element("inbox-banners-blocked", in: window)
        XCTAssertTrue(blocked.waitForExistence(timeout: 20),
                      "a Mac that will show no banner says nothing about it")
        XCTAssertTrue(text(of: blocked).contains("Notification banners are turned off"),
                      "the warning does not say what is actually switched off")

        let copy = visibleText(in: window)
        XCTAssertTrue(copy.contains("still received and saved"),
                      "the warning does not say that deliveries still arrive and are saved")

        // Still ready. The receiver under this surface is the real one, so this is
        // the product agreeing that a blocked banner has not stopped anything.
        waitForReady(in: window)

        let action = element("inbox-open-notification-settings", in: window)
        XCTAssertTrue(action.exists, "there is no way to change it from inside the app")
        XCTAssertTrue(action.isEnabled, "the only route out of this state is disabled")
        XCTAssertTrue(action.label.contains("Notification settings"),
                      "the action does not say where it goes")
        XCTAssertFalse(element("inbox-notification-settings-error", in: window).exists,
                       "a refusal is shown before the button has been pressed")

        // **Leaf discipline, measured rather than assumed.**
        //
        // This surface has lost a control to identifier propagation twice: once on
        // the result row, where the row's identifier renamed the Reveal button
        // inside it, and once on the Ask section's container, where it renamed all
        // four answer buttons. Both looked correct on screen and both left a
        // control unreachable. The warning and the button here sit in one section,
        // so the same mistake is one edit away, and it is checked the same way the
        // policy choices are: by counting.
        XCTAssertEqual(window.descendants(matching: .any)
            .matching(identifier: "inbox-open-notification-settings").count, 1,
                       "the System Settings action does not identify exactly one control")
        XCTAssertEqual(window.buttons.matching(identifier: "inbox-banners-blocked").count, 0,
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
        let window = launchWithBlockedBanners()
        let action = element("inbox-open-notification-settings", in: window)
        XCTAssertTrue(action.waitForExistence(timeout: 20))
        action.click()

        let refusal = element("inbox-notification-settings-error", in: window)
        XCTAssertTrue(refusal.waitForExistence(timeout: 10),
                      "the action did nothing and said nothing")
        XCTAssertTrue(text(of: refusal).contains("open System Settings"),
                      "the refusal does not name what could not be done")
        // Beside the button that caused it, not three sections away in the status
        // block where it would read as an unrelated fault.
        XCTAssertTrue(element("inbox-banners-blocked", in: window).exists,
                      "the refusal replaced the state it belongs to")
        XCTAssertFalse(element("inbox-error", in: window).exists,
                       "the refusal was also rendered in the general error slot")
    }

    /// **The warning goes away when the user fixes it, without a relaunch.**
    ///
    /// macOS publishes nothing when notification authorization changes, so the
    /// surface re-asks instead. This drives the whole journey: the warning is
    /// there, the button is pressed, the setting changes outside the app, and the
    /// screen is looked at again.
    ///
    /// Pressing the button is load-bearing rather than decorative — this launch's
    /// fixture only reports `allowed` once the surface's own action has actually
    /// run, so a button wired to nothing leaves the warning up and fails here.
    func testAllowingNotificationsRemovesTheWarningWithoutARelaunch() {
        let window = launchWithBlockedBanners(recovering: true)
        let blocked = element("inbox-banners-blocked", in: window)
        XCTAssertTrue(blocked.waitForExistence(timeout: 20),
                      "this launch is supposed to start with banners blocked")

        let action = element("inbox-open-notification-settings", in: window)
        XCTAssertTrue(action.exists)
        action.click()
        XCTAssertFalse(element("inbox-notification-settings-error", in: window).exists,
                       "an opener that succeeded still reported a refusal")

        // Away and back, which is what a person does: the surface re-measures when
        // it appears, so this is the same code path as returning from System
        // Settings. The window is CLOSED rather than merely switched away from, so
        // the assertion cannot pass on a stale view that never re-ran — and the
        // way back is the menu-bar item, because with no window there is nothing
        // else to click. That is also the state a resident app spends most of its
        // life in.
        window.buttons[XCUIIdentifierCloseWindow].click()
        let closed = NSPredicate(format: "exists == false")
        expectation(for: closed, evaluatedWith: blocked, handler: nil)
        waitForExpectations(timeout: 15)

        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 10),
                      "the resident app has no menu-bar surface")
        statusItem.click()
        let openInbox = app.menuItems.allElementsBoundByIndex
            .first { $0.title.contains("Open Device Inbox") }
        XCTAssertNotNil(openInbox, "the menu bar has no route back to the Device Inbox")
        openInbox?.click()

        let reopened = mainWindow
        XCTAssertTrue(element("destination-deviceInbox", in: reopened)
            .waitForExistence(timeout: 20),
                      "the menu bar did not bring the Device Inbox back")

        // The surface is up and the receiver is running, and the warning is gone.
        waitForReady(in: reopened)
        XCTAssertFalse(element("inbox-banners-blocked", in: reopened).exists,
                       "the warning survived the user allowing notifications")
        XCTAssertFalse(element("inbox-open-notification-settings", in: reopened).exists,
                       "the recovery is still offered for a problem that is fixed")
        XCTAssertFalse(visibleText(in: reopened).contains("Notification banners are turned off"))
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
        XCTAssertTrue(titles.contains { $0.contains("Open Device Inbox") },
                      "the menu bar has no route to where those decisions are made")
    }
}
