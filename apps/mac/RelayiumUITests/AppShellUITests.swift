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
    /// A directory this test owns, so a download can be saved somewhere with a
    /// name nothing else on the machine has. Removed in `tearDown` — the point
    /// of the path that uses it is that the product does NOT remove it.
    private var receivedFolderFixture: URL?

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
        ["--relayium-ui-testing", "--relayium-ui-testing-file-code",
         "-AppleLanguages", "(en)",
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
        if let receivedFolderFixture {
            try? FileManager.default.removeItem(at: receivedFolderFixture)
        }
    }

    /// Relaunch this app the way the OS hands it a stored link, and return the
    /// product window.
    ///
    /// **The only route to Open a link, and the point of the test rather than a
    /// workaround.** That destination has no sidebar row: it is where a link the
    /// OS delivers is opened, not somewhere to browse to. The launch argument
    /// hands the URL to the same `AppDeepLinkRouter.open` that `onOpenURL` feeds,
    /// so the parser, the coordinator, the routing decision and the shell arm
    /// under test are all production code.
    private func openStoredLink(_ link: String,
                                extraArguments: [String] = []) -> XCUIElement {
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = offlineLaunchArguments + extraArguments
            + ["--relayium-ui-testing-open-link", link]
        app.launch()
        ensureProductWindowIsOpen()
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        XCTAssertTrue(window.descendants(matching: .any)["destination-storedReceive"]
            .firstMatch.waitForExistence(timeout: 20),
                      "an OS-delivered stored link did not open the destination that "
                      + "no longer has a sidebar row")
        return window
    }

    /// Empty the receive field, whatever the link that opened it left in there.
    private func clearReceiveField(in window: XCUIElement) -> XCUIElement {
        let link = window.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 20))
        link.click()
        app.typeKey("a", modifierFlags: .command)
        app.typeKey(.delete, modifierFlags: [])
        return link
    }

    /// Sparkle's one-time "check for updates automatically?" consent, which a
    /// fresh runner shows before anything else this app draws.
    ///
    /// Extracted from `ensureProductWindowIsOpen` because the version-blocked
    /// launch cannot use that helper: its recovery path is the menu bar's Open
    /// item, and a blocked build's menu deliberately offers only Update and
    /// Quit. The consent still has to be cleared, so this half is shared and the
    /// window half is not.
    private func declineSparkleAutomaticChecksIfAsked() {
        let sparkleDecline = app.buttons["Don’t Check"]
        if sparkleDecline.waitForExistence(timeout: 2) { sparkleDecline.click() }
    }

    /// A fresh runner may show Sparkle's one-time consent, while a reused
    /// runner may restore the deliberate closed-window state from the residency
    /// test. Resolve either through the controls a person actually sees, then
    /// begin every product assertion with the real work window in front.
    private func ensureProductWindowIsOpen() {
        declineSparkleAutomaticChecksIfAsked()
        if app.windows.allElementsBoundByIndex.contains(where: {
            $0.frame.width >= 800 && $0.frame.height >= 500
        }) { return }

        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 5),
                      "the resident app has no menu-bar recovery surface")
        statusItem.click()
        app.typeKey("o", modifierFlags: [])
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 10),
                      "the menu-bar recovery action did not restore the product window")
    }

    /// Every BROWSEABLE destination's visible title and the `MacSurface` raw
    /// value the product identifies it by. One list, so the suite that walks the
    /// sidebar and the assertion that names a rendered surface cannot drift into
    /// two sets.
    ///
    /// **Five rows, and Open a link is not one of them.** That destination is
    /// reached by a `relayium.com` link the OS hands the app, so this suite
    /// reaches it the same way — see `openStoredLink(_:)` — rather than by a
    /// row it deliberately does not have.
    ///
    /// The two transfer rows are two destinations again: same network and
    /// pairing code have opposite preconditions, and each screen shows only its
    /// own connection method.
    private static let destinationIDs = [
        "LAN Transfer": "lanTransfer",
        "Cross-network Transfer": "crossNetworkTransfer",
        "Send a link": "storedSend",
        "Device Inbox": "deviceInbox",
        "Account": "account",
    ]

    /// A `relayium.com` stored link that resolves against the in-process
    /// fixture, and one that does not.
    ///
    /// Both are handed to the app at launch, which is the only route to Open a
    /// link. The failing one exists so the refusal paths below can start from a
    /// settled screen with an editable field instead of racing a resolution.
    // nonlocalized: acceptance fixture links, never real
    private static let resolvableStoredLink =
        "https://relayium.com/d/obj_uitest#k=ERERERERERERERERERERERERERERERERERERERERERE"
    // nonlocalized: acceptance fixture links, never real
    private static let unresolvableStoredLink =
        "https://relayium.com/d/obj_absent#k=ERERERERERERERERERERERERERERERERERERERERERE"

    /// Destinations no longer print their row as a page heading, but the window
    /// title carries the same words. Scope navigation to the labelled sidebar
    /// outline so nothing else with that label can turn one intended click into
    /// an ambiguous two-element query.
    private func sidebarDestination(_ title: String, in window: XCUIElement) -> XCUIElement {
        let id = Self.destinationIDs[title]!
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

    /// The same resolution for a sentence too long to assert whole.
    ///
    /// A paragraph is copy somebody will reword; the CLAIM inside it is the
    /// contract. Matching on the claim keeps the test about the promise rather
    /// than about the punctuation around it.
    private func visibleElement(id: String, contains fragment: String,
                                in window: XCUIElement) -> XCUIElement {
        let stable = window.descendants(matching: .any)[id].firstMatch
        if stable.exists { return stable }
        let visible = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@",
                                  fragment, fragment)
        return window.descendants(matching: .any).matching(visible).firstMatch
    }

    /// The system file panel the app has just opened, whichever container
    /// AppKit chose to present it in.
    ///
    /// Three candidates rather than one, because the same `NSOpenPanel` is a
    /// dialog, a window or a sheet depending on how it was presented and on the
    /// macOS version; polling rather than `waitForExistence`, because the wait
    /// has to be for whichever of the three appears.
    private func systemFilePanel(timeout: TimeInterval = 15) -> XCUIElement? {
        let candidates = [app.dialogs["open-panel"],
                          app.windows["open-panel"],
                          app.sheets["open-panel"]]
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let panel = candidates.first(where: { $0.exists }) { return panel }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        return nil
    }

    /// Point an open system panel at an exact path and confirm it.
    ///
    /// Go to Folder rather than clicking through the sidebar: the destination is
    /// a path this test owns, and typing it is the only way to reach a directory
    /// that did not exist when the panel was configured. `useASCIIKeyboard`
    /// is what makes the typing land in the panel instead of an input method —
    /// see its own note, and batch T1c.
    private func confirm(_ panel: XCUIElement, at path: String,
                         file: StaticString = #filePath, line: UInt = #line) {
        app.activate()
        var location: XCUIElement?
        for _ in 0..<3 where location == nil {
            app.typeKey("g", modifierFlags: [.command, .shift])
            let fieldCandidates = [app.sheets["GoToWindow"].textFields["PathTextField"],
                                   panel.sheets["GoToWindow"].textFields["PathTextField"],
                                   app.textFields["PathTextField"]]
            let fieldDeadline = Date().addingTimeInterval(5)
            repeat {
                location = fieldCandidates.first(where: { $0.exists })
                if location != nil { break }
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            } while Date() < fieldDeadline
            if location == nil { app.activate() }
        }
        guard let location else {
            return XCTFail("the system picker did not expose Go to Folder",
                           file: file, line: line)
        }

        location.typeText(path)
        app.typeKey(.return, modifierFlags: [])

        let choose = panel.buttons["OKButton"]
        guard choose.waitForExistence(timeout: 15) else {
            return XCTFail("the system picker has no confirmation action",
                           file: file, line: line)
        }
        choose.click()
    }

    /// Select a fixture through the real AppKit panel, after the panel is
    /// actually present. SwiftUI's selectable empty-state text can consume a
    /// click on the surrounding drop zone, so UI tests use the adjacent,
    /// explicit chooser button that invokes the same product action.
    private func chooseFixture(_ fixture: URL,
                               in window: XCUIElement,
                               file: StaticString = #filePath,
                               line: UInt = #line) {
        let identified = window.descendants(matching: .any)["transfer-choose-files"].firstMatch
        let chooser = identified.exists
            ? identified
            : window.buttons["Choose Files or Folders…"]
        guard chooser.waitForExistence(timeout: 10) else {
            return XCTFail("the transfer surface has no explicit file chooser",
                           file: file, line: line)
        }

        app.activate()
        chooser.click()

        guard let panel = systemFilePanel() else {
            return XCTFail("the explicit file chooser opened no system panel",
                           file: file, line: line)
        }
        confirm(panel, at: fixture.path, file: file, line: line)
    }

    /// The window opens at all. A `Window` scene that fails to build leaves a
    /// running process with nothing on screen, and the menu-bar extra keeps that
    /// process alive — so "it launched" is not evidence.
    func testTheMainWindowOpens() {
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 20),
                      "the unique main window did not appear")
    }

    /// Relaunch this app with the version its SUPPORT POLICY should evaluate.
    ///
    /// **Only the number changes.** `CFBundleShortVersionString` is untouched,
    /// so this is the real signed candidate with the real gate, the real
    /// embedded floor and the real update seam — it is simply asked the question
    /// a below-minimum build asks. That input cannot come from the bundle: the
    /// release guard refuses a candidate that ships below its own published
    /// minimum, precisely because such a build would block on first launch.
    ///
    /// The relaunch is deliberate rather than a fresh `XCUIApplication` alone:
    /// `setUp` has already opened the product window, so this process inherits a
    /// restored-open window state. Without that, a run following the
    /// closed-window test would restore closed — and a blocked build's menu bar
    /// offers no way to reopen it, by design.
    private func launchEvaluating(version: String) {
        app.terminate()
        app = XCUIApplication()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-app-version", version]
        app.launch()
        declineSparkleAutomaticChecksIfAsked()
    }

    /// **A build below the minimum supported version does not run the product.**
    ///
    /// The one state the source guards cannot reach: that the gate replaces the
    /// shell rather than covering it is a claim about a running app, and every
    /// candidate this suite can build is above the minimum.
    ///
    /// Three separate things are asserted, because a screen that appeared while
    /// the shell went on running behind it would satisfy the first alone — and
    /// that is the failure the whole design exists to prevent: the transfer
    /// modules' tasks opening a room socket and registering for notifications
    /// behind an update button.
    func testABuildBelowTheMinimumIsBlockedAndOffersOnlyTheUpdateAction() {
        // Below `SupportedVersionPolicy.embeddedFloor.minimumSupported`, which
        // is what decides this launch: acceptance never fetches a policy, so the
        // floor compiled into the binary is the whole requirement.
        // `SupportedVersionSurfaceTests` holds this literal to that floor.
        launchEvaluating(version: "1.2.3")

        let blocked = app.descendants(matching: .any)["version-blocked"].firstMatch
        XCTAssertTrue(blocked.waitForExistence(timeout: 30),
                      "a build below the minimum supported version did not show the "
                      + "blocking surface")

        // The product is NOT BUILT, not merely hidden. Every shell arm and every
        // sidebar row is checked, so a gate that had become an overlay would
        // fail here rather than pass on the presence of the screen above.
        for (title, id) in Self.destinationIDs {
            XCTAssertFalse(app.descendants(matching: .any)["destination-\(id)"].firstMatch.exists,
                           "the blocked build still renders the \(title) surface")
            XCTAssertFalse(app.descendants(matching: .any)["sidebar-\(id)"].firstMatch.exists,
                           "the blocked build still offers the \(title) sidebar row")
            XCTAssertFalse(app.staticTexts[title].exists,
                           "the blocked build still names \(title)")
        }
        // The dismissible recommendation is a different state and the two must
        // never be on screen together.
        XCTAssertFalse(app.descendants(matching: .any)["version-recommendation"]
            .firstMatch.exists,
                       "the blocked build also shows the dismissible recommendation")

        // Two ways out and no third. A dismiss here would make the minimum a
        // suggestion, and this state exists for the cases where it is not one.
        let update = app.descendants(matching: .any)["version-blocked-update"].firstMatch
        XCTAssertTrue(update.waitForExistence(timeout: 10),
                      "the blocking surface offers no update action")
        XCTAssertTrue(app.descendants(matching: .any)["version-blocked-quit"].firstMatch.exists,
                      "the blocking surface offers no way to leave")
        XCTAssertFalse(app.descendants(matching: .any)["version-recommendation-dismiss"]
            .firstMatch.exists,
                       "the blocking surface offers a way past the block")

        // **The button reaches the shipped update action**, which in this build
        // is Sparkle's own check. Asserted through the Debug-only witness the
        // action writes rather than through what Sparkle then does: an appcast
        // fetch over the public network, a signature check and possibly a
        // download are all outside this change and none of them may decide
        // whether this test passes. That the action IS Sparkle's check, and that
        // the witness is compiled out of Release and cannot displace it, are
        // source claims — `SupportedVersionSurfaceTests` makes them.
        XCTAssertFalse(app.descendants(matching: .any)["version-blocked-update-reached"]
            .firstMatch.exists,
                       "the update action ran before anybody pressed the button")
        update.click()
        XCTAssertTrue(app.descendants(matching: .any)["version-blocked-update-reached"]
            .firstMatch.waitForExistence(timeout: 20),
                      "the blocking surface's update button did not reach the "
                      + "direct build's Sparkle update action")
    }

    /// The other side of the same seam: a supported version runs the product.
    ///
    /// Two launches, because they answer two different questions. The first
    /// names a supported version explicitly, so passing the argument at all is
    /// shown not to be what blocks. The second passes no override, which is the
    /// shipped path — the bundle's own `CFBundleShortVersionString` against the
    /// embedded floor — and is the one that would catch a floor raised past the
    /// version this candidate actually is.
    func testASupportedBuildRendersTheOrdinaryShell() {
        // `SupportedVersionPolicy.embeddedFloor.recommended`, held to that value
        // by `SupportedVersionSurfaceTests`: at the recommendation there is
        // nothing to say at all, so neither surface should appear.
        launchEvaluating(version: "1.2.5")
        ensureProductWindowIsOpen()
        assertTheOrdinaryShellIsRunning()

        app.terminate()
        app = XCUIApplication()
        app.launchArguments = offlineLaunchArguments
        app.launch()
        ensureProductWindowIsOpen()
        assertTheOrdinaryShellIsRunning()
    }

    private func assertTheOrdinaryShellIsRunning(file: StaticString = #filePath,
                                                 line: UInt = #line) {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20),
                      "the supported build has no product window", file: file, line: line)
        XCTAssertTrue(sidebarDestination("LAN Transfer", in: window)
            .waitForExistence(timeout: 20),
                      "the supported build's shell has no destinations",
                      file: file, line: line)
        XCTAssertFalse(app.descendants(matching: .any)["version-blocked"].firstMatch.exists,
                       "a supported build was blocked", file: file, line: line)
        XCTAssertFalse(app.descendants(matching: .any)["version-recommendation"]
            .firstMatch.exists,
                       "a supported build was told to update", file: file, line: line)
    }

    /// All five browseable destinations are in the sidebar, by their
    /// accessibility labels — and the hidden one is not.
    ///
    /// By label rather than by index: the order is a design decision that may
    /// change, and a positional assertion would fail on a reorder that harmed
    /// nobody. What must not change is that every capability is reachable.
    ///
    /// Signed out, which is the state the list is checked in and the one that
    /// matters: a row that appears only once somebody has an account cannot be
    /// what tells them the capability is there. Device Inbox shipped without a
    /// row at all and was, in practice, missing.
    func testEveryDestinationIsReachableFromTheSidebar() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        // English is the CI locale; the language matrix above covers the other
        // shipped language and the archived-preference fallback.
        for destination in ["LAN Transfer", "Cross-network Transfer", "Send a link",
                            "Device Inbox", "Account"] {
            let row = sidebarDestination(destination, in: window)
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the sidebar has no row for \(destination)")
        }
        // …and exactly those five. Open a link is reached by an OS-delivered
        // link, so a row for it is the regression this batch removed.
        XCTAssertFalse(window.descendants(matching: .any)["sidebar-storedReceive"]
            .firstMatch.exists,
                       "Open a link is an ordinary sidebar row again")
        XCTAssertFalse(window.staticTexts["Open a link"].exists,
                       "the sidebar still names Open a link")
    }

    func testStoppedNearbyDiscoveryAsksForActionWithoutPretendingToWork() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let nearby = sidebarDestination("LAN Transfer", in: window)
        XCTAssertTrue(nearby.waitForExistence(timeout: 10))
        nearby.click()

        // The action is named for what it does. It calls
        // `LanDiscoveryModel.start()`, which opens the room socket and makes
        // this Mac reachable — so beside a status line reading "off", "Look
        // again" described a search that was not happening and hid the one
        // thing the user actually had to do.
        XCTAssertTrue(window.buttons["Start receiving"].waitForExistence(timeout: 10))
        XCTAssertFalse(window.buttons["Look again"].exists,
                       "the off state still names its recovery after a search")
        XCTAssertEqual(window.progressIndicators.count, 0,
                       "an off listener must not show a spinner beside the manual retry")
        XCTAssertFalse(window.buttons["Pause receiving"].exists,
                       "an off listener offers the contradictory action to pause")
        XCTAssertFalse(window.buttons["Resume receiving"].exists,
                       "Start receiving is the one recovery for a listener that never started")
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
    /// **Neither real-time screen can hold work before it holds a connection**,
    /// observed in the built app rather than in the source.
    ///
    /// This test used to do the opposite: it staged a fixture on LAN Transfer
    /// and asserted the pending-file list named it and its size. That product
    /// is gone — a session is established before anything is chosen — so what
    /// remains to check at runtime is that none of the machinery is on screen.
    /// The pending-file identity rendering it used to prove is still covered,
    /// on the surface that still stages: see
    /// `testASignedInStoredSendNamesTheFileItWouldUpload`.
    func testNeitherTransferScreenStagesAnythingBeforeConnecting() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        for destination in ["LAN Transfer", "Cross-network Transfer"] {
            let row = sidebarDestination(destination, in: window)
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            row.click()
            XCTAssertEqual(window.title, destination,
                           "the window is not on the destination this asserts about")
            XCTAssertFalse(window.descendants(matching: .any)["Files to send"]
                .firstMatch.exists,
                           "\(destination) stages files before connecting")
            XCTAssertFalse(window.descendants(matching: .any)["transfer-choose-files"]
                .firstMatch.exists,
                           "\(destination) offers a pre-connect file picker")
            XCTAssertFalse(window.descendants(matching: .any)["transfer-staging-optional"]
                .firstMatch.exists,
                           "\(destination) still describes optional pre-connect staging")
            XCTAssertFalse(window.descendants(matching: .any)["pendingFile.0"]
                .firstMatch.exists,
                           "\(destination) shows a staged batch before connecting")
            XCTAssertFalse(window.buttons["Send files"].exists,
                           "\(destination) offers a pre-connect file verb")
            XCTAssertFalse(window.buttons["Send a message"].exists,
                           "\(destination) offers a pre-connect message verb")
        }
    }

    /// Selecting each destination renders something. The regression this catches
    /// is a destination whose body fails to build — which is a blank pane, not a
    /// crash, and is invisible to every other test in this repository.
    func testEachDestinationRendersItsOwnSurface() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let destinations = ["Send a link", "Device Inbox", "Account",
                            "LAN Transfer", "Cross-network Transfer"]
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
        // Arrived at the way this destination is reached at all: a link the OS
        // handed the app. This one names an object the fixture does not serve,
        // so the screen settles on a refusal with an editable field rather than
        // racing a resolution.
        let window = openStoredLink(Self.unresolvableStoredLink)

        let link = clearReceiveField(in: window)
        let open = window.buttons["Open"]
        XCTAssertTrue(open.exists)
        XCTAssertFalse(open.isEnabled,
                       "an empty receive field offers an action that cannot succeed")

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
        // The window still names the destination even though no row does — the
        // title is what a hidden destination has instead of a heading.
        XCTAssertFalse(window.descendants(matching: .any)["sidebar-storedReceive"]
            .firstMatch.exists,
                       "reaching Open a link by link put a row in the sidebar")
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
    /// a pairing code must not be mistaken for unsolicited Nearby receive, and
    /// its handoff must be usable without transcribing six digits.
    ///
    /// It used to be named for a "text code". Nothing mints one: the verb no
    /// longer carries a lane, and the code this screen produces is the same code
    /// whatever the peer turns out to want to send.
    func testCreatingAPairingCodeStaysOnPairingAndShowsEveryHandoff() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))

        let pairing = sidebarDestination("Cross-network Transfer", in: window)
        XCTAssertTrue(pairing.waitForExistence(timeout: 10))
        pairing.click()

        // No mode picker to set first: the verb carries the kind. This is the
        // runtime half of `testNoSegmentedModePickerSurvivesAnywhereOnMacOS`.
        XCTAssertEqual(window.radioButtons.count, 0,
                       "the pairing screen still offers a segmented transfer-type choice")

        let create = window.buttons["Create a pairing code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.click()

        // SecurityCodeText deliberately exposes digits one by one so
        // VoiceOver never reads the pairing code as one large number.
        let generatedCode = window.descendants(matching: .any)["pairing-code-value"]
            .firstMatch
        XCTAssertTrue(generatedCode.waitForExistence(timeout: 10),
                      "the generated pairing code was not visible")
        XCTAssertEqual(generatedCode.label, "4 8 3 9 2 0",
                       "VoiceOver no longer reads the pairing code digit by digit")
        XCTAssertTrue(window.staticTexts["Join link"].exists,
                      "the generated code has no visible browser handoff")
        // The code and nothing else. A `?mode=` hint would name a lane the
        // sender was never asked to choose, which is the removed question
        // smuggled back into a URL.
        let expectedLink = "https://relayium.com/cross-network#c=483920"
        XCTAssertTrue(window.staticTexts[expectedLink].exists,
                      "the visible handoff is not the bare code the sender created")
        XCTAssertTrue(window.buttons["Copy"].exists,
                      "the join link cannot be copied")
        XCTAssertTrue(window.buttons["Share"].exists,
                      "the join link cannot use the system share sheet")
        // **Counted, not merely found.** This screen used to render the wait
        // and its Cancel twice — once in the handoff card and once beside it —
        // so a `.exists` check passed while a click on either raised for
        // matching two elements. The requirement is not "a status is present",
        // it is "the page says this once", and only a count can state that.
        XCTAssertEqual(window.activityIndicators
            .matching(NSPredicate(format: "label == %@", "Waiting for the other device…"))
            .count, 1,
                       "the generated-code surface does not show its live status exactly once")
        XCTAssertTrue(visibleElement(
            id: "pairing-code-expiry-note",
            text: "Only this pairing code expires. A transfer that has already started can continue.",
            in: window).exists,
                      "the handoff leaves it ambiguous whether the code or transfer expires")
        // The same count for the escape, and for the same reason: one page, one
        // way out of it. Taken by label, which is what a person reads and what a
        // duplicate would double.
        let cancels = window.buttons.matching(NSPredicate(format: "label == %@", "Cancel"))
        XCTAssertEqual(cancels.count, 1,
                       "the generated-code surface does not offer exactly one Cancel")
        let cancelWatch = cancels.element
        XCTAssertEqual(window.title, "Cross-network Transfer",
                       "creating a pairing-code message session navigated elsewhere")
        XCTAssertFalse(window.descendants(matching: .any)["transfer-lane-note"]
            .firstMatch.exists,
                       "the handoff guessed a one-lane peer before anybody joined")

        // No conversation or transcript exists yet. Cancel must be the whole
        // exit, not the first half of Cancel -> Session ended -> Done.
        cancelWatch.click()
        XCTAssertTrue(window.buttons["Create a pairing code"].waitForExistence(timeout: 10),
                      "Cancel did not return directly to code creation")
        XCTAssertTrue(window.buttons["Connect"].exists,
                      "Cancel did not restore the pairing-code join path")
        XCTAssertFalse(window.buttons["Done"].exists,
                       "Cancel manufactured an empty terminal task requiring Done")
        XCTAssertFalse(window.descendants(matching: .any)["pairing-code-value"]
            .firstMatch.exists,
                       "the cancelled pairing code remained on screen")
    }

    /// **One field, one verb, and it is inert until six digits are in.**
    ///
    /// It used to be two verbs — join messages, join files — because the joiner
    /// had to state what a stranger's client was doing. That question is gone:
    /// the room decides for itself once the peer announces, so the screen offers
    /// the one action a person actually has in mind, which is connecting.
    ///
    /// Fast entry must still be canonicalized once, without an older partial
    /// value replacing later digits.
    func testCrossNetworkJoinKeepsACompleteCodeActionable() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let cross = sidebarDestination("Cross-network Transfer", in: window)
        XCTAssertTrue(cross.waitForExistence(timeout: 10))
        cross.click()

        let field = window.textFields["pairing.joinCode"]
        XCTAssertTrue(field.waitForExistence(timeout: 10),
                      "Cross-network Transfer has no pairing-code field")
        XCTAssertFalse(window.buttons["Connect"].isEnabled,
                       "an empty code left the connect action actionable")
        // And neither retired kind-specific verb survives beside it.
        XCTAssertFalse(window.buttons["Join messages"].exists,
                       "the pairing screen still asks whether to join messages")
        XCTAssertFalse(window.buttons["Join files"].exists,
                       "the pairing screen still asks whether to join files")

        field.click()
        field.typeText("123456")
        XCTAssertEqual(field.value as? String, "123456",
                       "the join field lost digits during fast entry")
        XCTAssertTrue(window.buttons["Connect"].isEnabled,
                      "a complete code cannot be connected with")

        window.buttons["Connect"].click()
        // By label rather than by identifier: the joiner's wait is the handoff
        // card's own, now that the pane no longer draws a second one beside it.
        let waiting = window.activityIndicators["Waiting for the other device…"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 10),
                      "joining a code leaves a blank screen while it waits")
        let cancel = window.buttons["Cancel"]
        XCTAssertTrue(cancel.exists, "a pairing-room wait has no escape")
        cancel.click()
        XCTAssertTrue(window.textFields["pairing.joinCode"].waitForExistence(timeout: 10),
                      "cancelling the pairing-room wait did not return to joining")
    }

    /// **Each transfer destination offers exactly one way to connect.**
    ///
    /// This is the owner's correction, at runtime: the two connection methods
    /// were merged onto one screen, and neither could then be described without
    /// describing the other. LAN Transfer shows the roster and no pairing
    /// controls at all; Cross-network Transfer shows the code and no roster.
    /// Both keep the files and folders they will carry inside their own flow.
    func testLanTransferOffersOnlySameNetworkConnecting() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let lan = sidebarDestination("LAN Transfer", in: window)
        XCTAssertTrue(lan.waitForExistence(timeout: 10))
        lan.click()

        // Same-network discovery, and no page heading repeating the row.
        XCTAssertTrue(window.buttons["Start receiving"].waitForExistence(timeout: 10),
                      "LAN Transfer lost same-network discovery")
        XCTAssertEqual(window.title, "LAN Transfer",
                       "the window no longer names the destination it is on")

        // Not one pairing control anywhere on this screen.
        XCTAssertFalse(window.buttons["Create a pairing code"].exists,
                       "LAN Transfer still offers pairing-code creation")
        XCTAssertFalse(window.textFields["pairing.joinCode"].exists,
                       "LAN Transfer still offers pairing-code joining")

        // And nothing that could hold work before there is a peer. Connect-first:
        // the roster is the whole screen, and what a connection carries is chosen
        // inside it.
        XCTAssertFalse(window.descendants(matching: .any)["Files to send"].firstMatch.exists,
                       "LAN Transfer stages files before connecting")
        XCTAssertFalse(window.descendants(matching: .any)["transfer-staging-optional"]
            .firstMatch.exists,
                       "LAN Transfer still describes optional pre-connect staging")
    }

    func testCrossNetworkTransferOffersOnlyPairingCodeConnectingAndLeadsWithMessages() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let cross = sidebarDestination("Cross-network Transfer", in: window)
        XCTAssertTrue(cross.waitForExistence(timeout: 10))
        cross.click()

        // Pairing-code create AND connect, one of each.
        XCTAssertTrue(window.buttons["Create a pairing code"].waitForExistence(timeout: 10),
                      "Cross-network Transfer lost pairing-code creation")
        XCTAssertTrue(window.buttons["Connect"].exists,
                      "Cross-network Transfer lost pairing-code joining")
        XCTAssertTrue(window.textFields["pairing.joinCode"].exists,
                      "Cross-network Transfer lost pairing-code joining")
        XCTAssertEqual(window.title, "Cross-network Transfer",
                       "the window no longer names the destination it is on")

        // The one thing this destination exists to say, said on the destination
        // rather than only in the sidebar hint.
        XCTAssertTrue(visibleElement(
            id: "cross-network-explain", contains: "do not need to be on the same network",
            in: window).exists,
                      "the pairing screen does not say a shared network is unnecessary")

        // No same-network discovery here at all.
        XCTAssertFalse(window.buttons["Start receiving"].exists,
                       "Cross-network Transfer still offers same-network discovery")
        XCTAssertFalse(window.buttons["Pause receiving"].exists,
                       "Cross-network Transfer still carries the residency control")

        // **No staging, at all.** Pairing is ONE workspace, and a workspace with
        // no connection in it has nothing to offer yet. A "Files and folders"
        // group beside the two code actions is the lane question in a different
        // costume, which is why its own heading is checked by name.
        XCTAssertFalse(window.descendants(matching: .any)["Files to send"].firstMatch.exists,
                       "the pairing screen stages files before connecting")
        XCTAssertFalse(window.descendants(matching: .any)["transfer-choose-files"]
            .firstMatch.exists,
                       "the pairing screen offers a pre-connect file picker")
        // No peer exists yet, so the surface must not guess whether this will
        // become a unified link or a legacy one-lane session.
        XCTAssertFalse(window.descendants(matching: .any)["lan-device-connection-note"]
            .firstMatch.exists,
                       "the pairing screen claimed a legacy limit before knowing the peer")
        // **One create action, and it needs nothing** — which is now structural
        // rather than a property of the disabled state.
        XCTAssertTrue(window.buttons["Create a pairing code"].isEnabled,
                      "creating a code requires something this screen cannot offer")
        for retired in ["Create a code for messages", "Create a code for files",
                        "Join messages", "Join files", "Send files", "Send a message",
                        "Choose Files or Folders…"] {
            XCTAssertFalse(window.buttons[retired].exists,
                           "the pairing screen still offers a pre-connect choice: \(retired)")
        }
    }

    /// **Same-network residency is stated once, on the pane that can change
    /// it.**
    ///
    /// `testCrossNetworkTransferOffersOnlyPairingCodeConnecting…` above already
    /// forbids the residency *control* on the pairing screen. It passed while
    /// the sidebar's own footer reported "Receiving · ready" under every row,
    /// including Cross-network Transfer — a destination whose whole premise is
    /// that the two devices share no network — because that footer is one
    /// column to the left of everything that test looks at.
    ///
    /// Scoping the footer to LAN Transfer answered that and left the smaller
    /// defect behind: on the one screen it could still appear on, the LAN pane
    /// states the same sentence with Pause and Resume beside it. So the footer
    /// is gone, and this asserts both halves — the sidebar reports nothing on
    /// any destination, and the LAN pane still says whether this Mac can be
    /// reached. Each absence waits for the window to actually be on the
    /// destination it is claimed about; an absence observed before navigating
    /// would be about nothing.
    func testResidencyIsStatedOnTheLanPaneAndNotInTheSidebar() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let footer = window.descendants(matching: .any)["sidebar-lan-residency"].firstMatch

        let lan = sidebarDestination("LAN Transfer", in: window)
        XCTAssertTrue(lan.waitForExistence(timeout: 10))
        lan.click()
        expectation(for: NSPredicate(format: "title == %@", "LAN Transfer"),
                    evaluatedWith: window)
        waitForExpectations(timeout: 10)
        // The fact, on the surface that owns it and offers the controls.
        XCTAssertTrue(window.staticTexts["Nearby receiving: off"].waitForExistence(timeout: 10),
                      "the LAN pane no longer says whether this Mac can be reached")
        XCTAssertFalse(footer.exists,
                       "the sidebar repeats the LAN pane's own residency line")

        for destination in ["Cross-network Transfer", "Send a link",
                            "Device Inbox", "Account"] {
            let row = sidebarDestination(destination, in: window)
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the sidebar has no row for \(destination)")
            row.click()
            expectation(for: NSPredicate(format: "title == %@", destination),
                        evaluatedWith: window)
            waitForExpectations(timeout: 10)
            XCTAssertFalse(footer.exists,
                           "\(destination) still reports same-network residency")
        }
    }

    /// A live session is on the destination that owns it, and on no other.
    ///
    /// Two screens over one set of models is exactly the shape that renders one
    /// transfer twice, each copy with its own exit. `TransferSurfacePresentation`
    /// refuses that by construction and `MacSurfaceTests` drives the rules; this
    /// is the running app agreeing with them.
    func testALiveSessionIsVisibleOnlyOnTheDestinationThatOwnsIt() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let cross = sidebarDestination("Cross-network Transfer", in: window)
        XCTAssertTrue(cross.waitForExistence(timeout: 10))
        cross.click()
        let create = window.buttons["Create a pairing code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.click()
        XCTAssertTrue(window.descendants(matching: .any)["pairing-code-value"]
            .firstMatch.waitForExistence(timeout: 20),
                      "the generated pairing code was not visible")

        // The other transfer destination shows its own connect controls and
        // never this session: a session is drawn by the module that owns it and
        // by nothing else.
        let lan = sidebarDestination("LAN Transfer", in: window)
        XCTAssertTrue(lan.waitForExistence(timeout: 10))
        lan.click()
        XCTAssertTrue(window.buttons["Start receiving"].waitForExistence(timeout: 10),
                      "the other destination did not return to its own connect phase")
        XCTAssertFalse(window.descendants(matching: .any)["pairing-code-value"]
            .firstMatch.exists,
                       "one session is rendered on both transfer destinations")
        // **And it is fully usable.** This assertion is inverted from what it
        // was: a pairing code used to disable every control on this screen and
        // print `transfer-busy-elsewhere` under them, so a user holding a code
        // could not start receiving on their own network. The two modules are
        // independent now, and this is where that is proved from the outside.
        XCTAssertTrue(window.buttons["Start receiving"].isEnabled,
                      "a pairing session still locks the same-network screen")
        XCTAssertFalse(window.descendants(matching: .any)["transfer-busy-elsewhere"]
            .firstMatch.exists,
                       "the same-network screen still explains a lock it no longer has")

        // …and the session is still there when its owner comes back.
        cross.click()
        XCTAssertTrue(window.descendants(matching: .any)["pairing-code-value"]
            .firstMatch.waitForExistence(timeout: 10),
                      "leaving and returning discarded the live session")
    }

    /// **The pairing code counts down, dies exactly at its deadline, and can be
    /// replaced in one press.**
    ///
    /// The deadline is REAL. `UITestPairClient` mints the first code of this
    /// launch with a genuine seconds-from-now `expiresAt` and lets the shipped
    /// `PairingCodeExpiry` arrive there on its own, so this drives the product's
    /// own path to expiry rather than a fixture that renders the expired state
    /// directly. `PairingCodeExpiryTests` pins the second on either side of the
    /// boundary; this proves the surface obeys it.
    ///
    /// **Standalone, and deliberately so.** It used to open a fabricated Nearby
    /// session beside the code and re-check it at the end, to claim that
    /// expiring or regenerating disturbs nothing across the module boundary.
    /// That half is gone with the fixture that faked the session: module
    /// independence is now proved by `LocalSessionUITests` against two
    /// genuinely established `link/1` connections, which is a stronger claim
    /// than this one could make. What is left here is the part only an offline
    /// suite can drive — a real deadline arriving on its own.
    func testTheExpiringPairingCodeCountsDownDiesAndCanBeReplaced() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-expiring-code"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let cross = sidebarDestination("Cross-network Transfer", in: window)
        let code = window.descendants(matching: .any)["pairing-code-value"].firstMatch
        // `staticTexts`, not `descendants(matching: .any)`: the latter can match
        // a wrapper that carries the identifier and no label, which reads as "the
        // countdown is not a clock" when the clock is right there underneath it.
        let countdown = window.staticTexts["pairing-code-countdown"]
        let expired = window.descendants(matching: .any)["pairing-code-expired"].firstMatch

        XCTAssertTrue(cross.waitForExistence(timeout: 10))
        cross.click()
        let create = window.buttons["Create a pairing code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.click()
        XCTAssertTrue(code.waitForExistence(timeout: 20), "no pairing code was minted")
        let firstCode = shown(code)

        // (1) It counts DOWN — two readings, and the second is smaller. A static
        // deadline rendered once would pass an "is there a countdown" check and
        // fail this.
        XCTAssertTrue(countdown.waitForExistence(timeout: 10),
                      "the minted code shows no countdown")
        let firstReading = seconds(in: shown(countdown))
        XCTAssertNotNil(firstReading, "the countdown is not a clock: \(shown(countdown))")
        Thread.sleep(forTimeInterval: 3)
        let secondReading = seconds(in: shown(countdown))
        XCTAssertNotNil(secondReading, "the countdown stopped being a clock")
        XCTAssertLessThan(secondReading ?? 0, firstReading ?? 0,
                          "the countdown is not counting down")

        // (2) At the deadline it becomes unusable, and the handoff goes with it.
        // The QR and the join link are the sharp part: scanning a dead code
        // produces an error on a phone with nothing near this screen to explain
        // it.
        XCTAssertTrue(expired.waitForExistence(timeout: 30),
                      "the code never expired, or never said so")
        XCTAssertFalse(countdown.exists,
                       "an expired code still shows a countdown beside the expiry notice")
        XCTAssertFalse(window.staticTexts["Join link"].exists,
                       "an expired code still offers its join link and QR")
        XCTAssertTrue(code.exists,
                      "the expired digits were hidden, so the reader cannot check "
                      + "which code they just read out")

        // (3) One press replaces it, with fresh digits and a live deadline.
        let regenerate = window.descendants(matching: .any)["pairing-code-regenerate"].firstMatch
        XCTAssertTrue(regenerate.waitForExistence(timeout: 10),
                      "an expired code offers no way to get another one")
        regenerate.click()
        XCTAssertTrue(countdown.waitForExistence(timeout: 20),
                      "regenerating produced no live code")
        XCTAssertFalse(expired.exists, "the replacement code is already expired")
        XCTAssertNotEqual(shown(code), firstCode,
                          "regenerating re-published the same six digits")
        // It never passed through the connect screen: the surface stayed owned
        // by this module for the whole action.
        XCTAssertFalse(create.exists,
                       "regenerating dropped the user back to the connect screen")
    }

    /// What a `Text` on this platform actually reads.
    ///
    /// **SwiftUI puts a `Text`'s content in the accessibility VALUE on macOS, not
    /// in its label**, so `element.label` is the empty string for every static
    /// text in this app. A check written against `label` compares "" with "" and
    /// passes for the wrong reason — which is worse than the failure it looks
    /// like, so every read of rendered text in this file goes through here.
    private func shown(_ element: XCUIElement) -> String {
        if let value = element.value as? String, !value.isEmpty { return value }
        return element.label
    }

    /// The seconds a `m:ss` or `h:mm:ss` clock is showing, or nil if the label is
    /// not a clock at all. Written here rather than compared as strings because
    /// "0:09" sorts after "0:10".
    private func seconds(in label: String) -> Int? {
        let digits = label.split(whereSeparator: { !"0123456789:".contains($0) })
            .first { $0.contains(":") }
        guard let digits else { return nil }
        let parts = digits.split(separator: ":").compactMap { Int($0) }
        guard !parts.isEmpty else { return nil }
        return parts.reduce(0) { $0 * 60 + $1 }
    }

    /// **A mint that fails says so, and the screen it failed on still works
    /// afterwards.**
    ///
    /// This test used to drive a terminal legacy TEXT session and press its
    /// "Leave this session" boundary. There is no such session to fail any more,
    /// and the fixture it launched with does something different now: it makes
    /// `UITestPairClient.mint` throw, which is a failure of the pairing code
    /// itself.
    ///
    /// Retargeted rather than deleted, because that is a shipping path with a
    /// defect fixed in this very change and no other offline coverage. `.failed`
    /// is deliberately ACTIVE so the message survives the app-scoped liveness
    /// observer — and holding the surface is what disabled Create and Join
    /// underneath it, leaving Cross-network permanently unusable for the life of
    /// the process with the reason showing and nothing to press. Dismiss is the
    /// whole recovery, so the test is: the reason is readable, the controls are
    /// honestly locked while it is, and one press gives them back.
    func testAFailedPairingMintSaysSoAndCanBeRecoveredFrom() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-failing-mint"]
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let cross = sidebarDestination("Cross-network Transfer", in: window)
        XCTAssertTrue(cross.waitForExistence(timeout: 10))
        cross.click()
        let create = window.buttons["Create a pairing code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.click()

        // (1) The reason is on screen, and it is a message rather than a silence.
        let failure = window.descendants(matching: .any)["pairing-code-failed"].firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 10),
                      "a mint that failed left the screen looking like nothing happened")
        XCTAssertFalse(window.descendants(matching: .any)["pairing-code-value"]
            .firstMatch.exists,
                       "a failed mint published a code it never received")

        // (2) The lock is honest while the message stands: the surface is held
        // so the reason cannot be swept off it, and Create says so by being
        // disabled rather than by failing again when pressed.
        XCTAssertTrue(create.exists,
                      "the failed mint hid the control it failed from")
        XCTAssertFalse(create.isEnabled,
                       "Create stayed live under a failure still holding the surface")

        // (3) One press is the whole recovery — and THIS is the regression: the
        // shipped build had no press to make here.
        let dismiss = window.buttons["pairing-code-failed-dismiss"]
        XCTAssertTrue(dismiss.exists,
                      "a failed mint offers no way out of itself, so the screen "
                      + "stays unusable for the life of the process")
        dismiss.click()

        XCTAssertFalse(failure.exists, "dismissing left the stale failure on screen")
        XCTAssertTrue(create.isEnabled,
                      "dismissing the failure did not give the screen back")
        XCTAssertTrue(window.buttons["Connect"].exists,
                      "dismissing the failure did not restore the join path")
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

        // The server-observed address, and the sentence that says what it is.
        // The fixture gives this device an address and the other none, so both
        // arms are on one screen: an IP appears exactly once, and the row the
        // server has never seen used says nothing about an address rather than
        // rendering the words with nothing after them.
        XCTAssertGreaterThan(window.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@",
                        "203.0.113.9", "203.0.113.9")).count, 0,
                       "the device list does not show the server-observed address it was given")
        // Exactly one, which is the both-arms half: the row the server has never
        // seen used must not render the words with nothing after them.
        XCTAssertEqual(window.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@",
                        "last address", "last address")).count, 1,
                       "an address sentence is rendered for a row that has no address")
        XCTAssertTrue(visibleElement(id: "devices-address-note",
                                     contains: "it is not a location", in: window).exists,
                      "the device list shows an address without saying what it is")

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
        let window = openStoredLink(Self.unresolvableStoredLink)
        let link = clearReceiveField(in: window)
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
        chooseFixture(fixture, in: window)

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
        chooseFixture(fixture, in: window)

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

        // Locate the action by its stable identity only after the last field
        // edit. SwiftUI replaces this button's accessibility node when
        // `canSubmit` changes, and a label-based element captured across that
        // replacement intermittently remains attached to the disabled node on
        // hosted macOS 15 runners.
        let signIn = window.descendants(matching: .any)["account.submit"].firstMatch
        let submitReady = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND enabled == true"), object: signIn)
        XCTAssertEqual(XCTWaiter.wait(for: [submitReady], timeout: 10), .completed,
                       "the completed form cannot be submitted")
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
        chooseFixture(fixture, in: window)

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

    /// **Staging is available whenever the transfer pipeline is free, and never
    /// a precondition of connecting.**
    ///
    /// This replaces the old "transfer type changes what is staged" test, which
    /// asserted the behaviour of the segmented picker this round removed: the
    /// file staging surface used to DISAPPEAR when the user chose Text, so
    /// choosing to say something also threw away the batch they had picked. The
    /// property that matters now is the opposite one — the drop zone, the picker
    /// button and the message verb are on screen together, and none of them is
    /// gated on the others.
    /// **The pairing screen's pre-connect UI is exactly two user choices**, at
    /// runtime and counted rather than read.
    ///
    /// It asserted the opposite premise until the owner's correction: that a
    /// staging surface was always available beside the two code actions, and
    /// that connecting never depended on it. Both halves are settled a level up
    /// now — there is nothing to stage, so nothing can gate anything — and what
    /// is worth checking in the built app is the count: Create, a field, and one
    /// verb behind it.
    func testThePairingScreenOffersOnlyCreateAndEnterCode() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let cross = sidebarDestination("Cross-network Transfer", in: window)
        XCTAssertTrue(cross.waitForExistence(timeout: 10))
        cross.click()

        let create = window.buttons["Create a pairing code"]
        XCTAssertTrue(create.waitForExistence(timeout: 15),
                      "the pairing screen lost Create a pairing code")
        XCTAssertTrue(create.isEnabled,
                      "creating a code was made to depend on something first")
        XCTAssertTrue(window.textFields["pairing.joinCode"].exists,
                      "the pairing screen lost the field a code is entered into")
        XCTAssertTrue(window.buttons["Connect"].exists,
                      "entering a code offers no action")
        XCTAssertEqual(window.radioButtons.count, 0,
                       "a transfer-type picker is back on the pairing screen")
        // Nothing that could hold work: no staging group, no picker, no composer.
        XCTAssertFalse(window.descendants(matching: .any)["Files to send"]
            .firstMatch.exists,
                       "the pairing screen stages files before connecting")
        XCTAssertFalse(window.descendants(matching: .any)["transfer-choose-files"]
            .firstMatch.exists,
                       "the pairing screen offers a pre-connect file picker")
        XCTAssertFalse(window.descendants(matching: .any)["link-composer"]
            .firstMatch.exists,
                       "the pairing screen composes a message before connecting")
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
        chooseFixture(fixture, in: window)

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

    /// Creating a pairing code with a batch already staged stays on
    /// Cross-network Transfer and shows every handoff.
    ///
    /// It used to be the FILE half of a two-button create, proving that the
    /// link's `?mode=file` survived. There is one create action now and no mode
    /// to preserve, so what this proves is what is left and what actually
    /// matters: a batch staged before the code is minted does not change the
    /// action, does not change the link, and does not leave the screen.
    /// **Creating a code needs nothing first, and hands over every way to pass
    /// it on.**
    ///
    /// It staged a fixture before pressing Create, to prove a staged batch did
    /// not make the create action inert. There is nothing to stage, so what it
    /// proves now is the simpler and stronger version: Create is live on a
    /// screen with no preconditions on it at all. The handoff assertions —
    /// code, join link, Copy, Share — are unchanged and are the point.
    func testCreatingAPairingCodeShowsEveryHandoff() throws {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let pairing = sidebarDestination("Cross-network Transfer", in: window)
        XCTAssertTrue(pairing.waitForExistence(timeout: 10))
        pairing.click()

        let create = window.buttons["Create a pairing code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10),
                      "the pairing screen offers no way to create a code")
        XCTAssertTrue(create.isEnabled,
                      "the create action is inert on a screen with no preconditions")
        create.click()

        XCTAssertTrue(window.descendants(matching: .any)["pairing-code-value"]
            .firstMatch.waitForExistence(timeout: 20),
                      "the generated pairing code is not visible")
        XCTAssertTrue(window.staticTexts["Join link"].exists,
                      "the generated code has no visible browser handoff")
        XCTAssertTrue(window.staticTexts[
            "https://relayium.com/cross-network#c=483920"
        ].exists, "the handoff link is not the bare code the sender created")
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
        // Delivered by the OS, resolved by the app: with no sidebar row, this is
        // the whole route, and it is the one a person actually takes — they
        // follow a link somebody sent them.
        let window = openStoredLink(Self.resolvableStoredLink,
                                    extraArguments: ["--relayium-ui-testing-sign-in"])

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

    /// A finished download is a result somebody can hand on, and Done ends the
    /// task without ending the file.
    ///
    /// These are the last two cells of Open a link — "what happens next" and
    /// "how do I hand this on" — and they were unwritten because no runtime path
    /// had ever reached `.done` holding a payload. The path above stops at the
    /// first named row.
    ///
    /// **Saved into a directory this test creates.** That is what makes Reveal
    /// assertable at all: a Finder window titled `Downloads` proves nothing on a
    /// machine that probably has one open already, while a window named
    /// `relayium-received-<uuid>` can only have been opened by the button under
    /// test.
    func testACompletedDownloadHandsOverItsResultAndDoneKeepsTheFile() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("relayium-received-\(UUID().uuidString.prefix(8))",
                                    isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        receivedFolderFixture = folder

        let window = openStoredLink(Self.resolvableStoredLink,
                                    extraArguments: ["--relayium-ui-testing-sign-in"])
        let save = window.buttons["Save…"]
        XCTAssertTrue(save.waitForExistence(timeout: 30),
                      "a resolved link offers no way to save what it points at")
        save.click()
        guard let panel = systemFilePanel() else {
            return XCTFail("Save opened no destination panel")
        }
        confirm(panel, at: folder.path)

        // **Typed queries only, from here to the end of this path.**
        //
        // `window.descendants(matching: .any)[…]` asks the accessibility tree
        // for every descendant of the window and then filters — the shape that
        // times out on macOS, which batches 94, 102 and 115 each hit and which
        // this path hit again while the download was still running. A typed
        // collection is a different query, and it is the one that survives here.
        //
        // Completion is signalled by the Done button rather than by the result
        // row: it is the cheapest element unique to `.done`, so the long wait
        // for the transfer never runs an expensive query.
        let done = window.buttons["download.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 60),
                      "the download never reached a completed state")

        // The result by its own address, not the pending row above it: this is
        // the list a person drags out of, and the one Reveal and Share act on.
        // Combining a row's children yields a group on macOS and a static text
        // on some versions, so both typed collections are asked — never `.any`.
        let group = window.otherElements["received.file.0"]
        let result = group.exists ? group : window.staticTexts["received.file.0"]
        XCTAssertTrue(result.exists,
                      "a completed download rendered no result to hand on")

        // Label OR value: macOS puts a combined row's text in `value` about as
        // often as in `label`, which is why `visibleElement(id:text:)` above
        // matches either. The diagnostic prints both, because an empty string
        // says nothing about which of the two ways this can be wrong happened.
        let named = result.label.isEmpty ? (result.value as? String ?? "") : result.label
        XCTAssertEqual(named, "brief.txt",
                       "the result does not name the file the manifest carried — "
                       + "label=\"\(result.label)\" "
                       + "value=\(String(describing: result.value))")

        // Share OPENED, not merely present. A `ShareLink` over an empty item
        // array renders exactly this button and does nothing when pressed, which
        // is why the system-share gate is written this way everywhere in this
        // suite rather than as "the control exists".
        let share = window.buttons["received.share"]
        XCTAssertTrue(share.waitForExistence(timeout: 10),
                      "a completed download offers no system share")
        share.click()
        XCTAssertTrue(app.menus.firstMatch.waitForExistence(timeout: 20),
                      "Share did not open the system sharing picker")
        app.typeKey(.escape, modifierFlags: [])

        // Reveal, in the Finder it names. `activateFileViewerSelecting` over an
        // empty array is silent, and the button that calls it looks identical.
        let reveal = window.buttons["received.reveal"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 10),
                      "a completed download offers no way to find what it saved")
        reveal.click()
        let finder = XCUIApplication(bundleIdentifier: "com.apple.finder")
        let revealed = finder.windows[folder.lastPathComponent]
        XCTAssertTrue(revealed.waitForExistence(timeout: 20),
                      "Reveal opened no Finder window on the folder that was saved into")
        revealed.buttons[XCUIIdentifierCloseWindow].click()

        // From the app again: revealing handed Finder the focus, which is what
        // revealing is for.
        app.activate()
        XCTAssertTrue(done.waitForExistence(timeout: 10),
                      "a completed download cannot be ended")
        done.click()

        // Back to the entry this destination starts from: the field returns,
        // empty of the link just spent, above the designed idle state rather
        // than the blank rectangle this pane used to render.
        let link = window.textFields["receive.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 15),
                      "Done did not return the link field")
        XCTAssertFalse((link.value as? String ?? "").contains("obj_uitest"),
                       "Done left the finished task's link in the field")
        // Scoped to `staticTexts`, not to every descendant: the same query-shape
        // limit as above, and the idle hint is a static text either way.
        let idle = NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@",
                               "The key stays in the link", "The key stays in the link")
        XCTAssertTrue(window.staticTexts.matching(idle)
            .firstMatch.waitForExistence(timeout: 15),
                      "Done returned to a blank pane rather than to the idle state")
        XCTAssertFalse(window.otherElements["received.file.0"].exists
                       || window.staticTexts["received.file.0"].exists,
                       "Done kept the finished result on screen")

        // And the bytes are still where the user put them. This is the half that
        // matters and the half a screen cannot show: a Done that tidied the file
        // away would look exactly like this one.
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: folder.appendingPathComponent("brief.txt").path),
                      "Done deleted what the download had already saved")
    }

    /// Every shipped language renders, in the running app.
    ///
    /// `LocalizedCopyTests` proves the catalogs line up, through the model seams,
    /// and its own header says its results cannot depend on the machine. What no
    /// test asserted is that a launch in each language produces a shell whose
    /// destinations are in that language — a resource not copied into the app,
    /// or a language the shell never asks for, looks exactly like a correct
    /// catalog from inside the package.
    func testEveryShippedLanguageRendersItsOwnShell() {
        // Exactly the two Relayium ships. The seven that used to be here left
        // with their catalogs; what a Mac set to one of them now sees is asserted
        // by `testAnArchivedLanguagePreferenceRendersACompleteEnglishLeftToRightShell`.
        let shipped = [("en", "LAN Transfer"), ("zh-Hans", "局域网传输")]
        for (code, lanTransfer) in shipped {
            app.terminate()
            app.launchArguments = ["--relayium-ui-testing", "-AppleLanguages", "(\(code))",
                                   "-AppleLocale", code, "-SUEnableAutomaticChecks", "NO"]
            app.launch()
            ensureProductWindowIsOpen()
            let window = mainWindow
            XCTAssertTrue(window.waitForExistence(timeout: 20),
                          "\(code) did not produce a window at all")
            let row = window.descendants(matching: .any)["sidebar-lanTransfer"].firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "\(code) produced a window with no LAN Transfer destination")
            let shown = (row.value as? String) ?? row.label
            XCTAssertEqual(shown, lanTransfer,
                           "\(code) rendered a shell that is not in \(code)")
        }
    }

    /// **An archived language preference renders a complete ENGLISH, LEFT-TO-RIGHT
    /// shell — in the running app.**
    ///
    /// This test used to assert the opposite for Arabic: that the window laid
    /// itself out right-to-left, because a translated app in a left-to-right
    /// layout is wrong for every RTL reader. Arabic is frozen now, so the
    /// requirement inverted, and the geometry half is exactly why this still has
    /// to run against a real launch rather than only through the model seams.
    ///
    /// Two failures are possible here and neither is visible from inside the
    /// package. The app could still ADVERTISE Arabic — `CFBundleLocalizations`
    /// is what macOS reads to decide layout direction, so a stale entry would
    /// mirror the window while the copy came back English, producing an English
    /// UI laid out right to left. Or a resolver that matched a language whose
    /// catalog is gone would render raw keys. Both are asserted against, for an
    /// RTL preference and a non-RTL archived one.
    ///
    /// `sidebarDestination` deliberately is not used: it resolves rows by
    /// assuming the sidebar is on the left, which is part of what is under test.
    func testAnArchivedLanguagePreferenceRendersACompleteEnglishLeftToRightShell() {
        for code in ["ar", "ja"] {
            app.terminate()
            app.launchArguments = ["--relayium-ui-testing", "-AppleLanguages", "(\(code))",
                                   "-AppleLocale", code, "-SUEnableAutomaticChecks", "NO"]
            app.launch()
            ensureProductWindowIsOpen()

            let window = mainWindow
            XCTAssertTrue(window.waitForExistence(timeout: 20),
                          "\(code) did not produce a window at all")
            let row = window.descendants(matching: .any)["sidebar-lanTransfer"].firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 15),
                          "the \(code) window has no LAN Transfer destination")

            // English words, not the archived translation and not a raw key.
            let shown = (row.value as? String) ?? row.label
            XCTAssertEqual(shown, "LAN Transfer",
                           "a \(code) launch did not render the English shell")
            XCTAssertFalse(shown.hasPrefix("nav."),
                           "a \(code) launch rendered a raw catalog key: \(shown)")

            // And laid out left to right: the sidebar is the LEADING pane, so
            // under LTR it belongs on the left half of the window.
            XCTAssertLessThan(row.frame.midX, window.frame.midX,
                              "a \(code) launch mirrored the window to right-to-left")
        }
    }

    /// The window's smallest work area still carries the whole task.
    ///
    /// 860×560 is the product's stated minimum, and the earlier batches that
    /// verified a handoff "at the 860×560 minimum" did so by resizing the real
    /// window by hand. Nothing asserted it. A destination that needs more room
    /// than the window can be shrunk to does not fail loudly — it clips, and the
    /// control that falls off the bottom is usually the one the task ends with.
    func testTheSmallestWindowStillCarriesTheWholeTask() {
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))

        // The scene's own minimum: the product contract is that this is a
        // USABLE size, not merely an allowed one.
        XCTAssertGreaterThanOrEqual(window.frame.width, 860,
                                    "the work area is narrower than the stated minimum")
        XCTAssertGreaterThanOrEqual(window.frame.height, 560,
                                    "the work area is shorter than the stated minimum")

        // Every destination, at that size, still renders its own surface and
        // keeps its primary control inside the window rather than past the edge.
        //
        // Device Inbox is in this list for the reason it was added to the sidebar
        // at all: it is the one destination whose content is a grouped `Form`
        // rather than a stack of cards, so it is the one whose height the
        // scaffold's non-scrolling mode has to carry, and the minimum window is
        // where that would clip first.
        for destination in ["LAN Transfer", "Cross-network Transfer", "Send a link",
                            "Device Inbox", "Account"] {
            let row = sidebarDestination(destination, in: window)
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the sidebar lost \(destination) at the minimum size")
            row.click()
            // The WINDOW title, not a heading in the body: no destination prints
            // its sidebar row a second time any more.
            expectation(for: NSPredicate(format: "title == %@", destination),
                        evaluatedWith: window)
            waitForExpectations(timeout: 10)
            // A title can also be satisfied by the sidebar row's own words. The
            // rendered destination cannot: the shell stamps `destination-<id>`
            // on the detail half only.
            let id = Self.destinationIDs[destination]!
            XCTAssertTrue(window.descendants(matching: .any)["destination-\(id)"]
                .waitForExistence(timeout: 10),
                          "\(destination)'s row opened no destination at the minimum size")
            XCTAssertTrue(window.frame.contains(row.frame),
                          "\(destination)'s own sidebar row sits outside the window")

            // **The surface is inside the window it opened in.**
            //
            // The assertions above were all true of a destination that shipped
            // unusable: Device Inbox rendered, carried its identifier, and laid
            // itself out 1326pt tall inside a 612pt window on macOS 26.6.
            // SwiftUI centres a child that overflows, so the top 251pt — the
            // heading and the first controls under it — was drawn above the top
            // edge of the window, where nothing can see or reach it and no
            // amount of scrolling helps, because the scroll view itself started
            // there. "It rendered" is not the property that matters at the
            // smallest size; "it rendered where the window is" is.
            //
            // Content BELOW the bottom edge is deliberately not asserted: a
            // destination whose sections do not fit scrolls, and that is the
            // designed answer. A surface taller than the whole window is not
            // scrolling — it is a scroll view that believes it has room it does
            // not have, and will never offer the rest of itself.
            for surface in window.descendants(matching: .any)
                .matching(identifier: "destination-\(id)").allElementsBoundByIndex {
                XCTAssertGreaterThanOrEqual(
                    surface.frame.minY, window.frame.minY,
                    "\(destination) draws \(Int(window.frame.minY - surface.frame.minY))pt "
                    + "of itself above the top of the window at the minimum size")
                XCTAssertLessThanOrEqual(
                    surface.frame.height, window.frame.height,
                    "\(destination)'s surface is \(Int(surface.frame.height))pt tall in a "
                    + "\(Int(window.frame.height))pt window, so it cannot scroll to the rest")
            }
        }
    }

    /// The keyboard alone completes a task, without reaching for the mouse.
    ///
    /// Return in the link field resolves it, and Return in the sign-in form
    /// submits it. Both are `onSubmit` handlers that no test drove: a control
    /// that only responds to a click is not a bug anyone SEES, and it is the
    /// difference between an app someone can use by keyboard and one they
    /// cannot.
    func testTheKeyboardAloneCompletesATask() {
        // Opened on the link destination, because that is the only way to it —
        // and the account half below is then reached by an ordinary sidebar
        // click from there, which is also the route a person has.
        let window = openStoredLink(Self.unresolvableStoredLink,
                                    extraArguments: ["--relayium-ui-testing-sign-in"])

        // 1. A link resolved by Return, never by clicking Open.
        let link = clearReceiveField(in: window)
        link.typeText("not a link")
        app.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(window.staticTexts[
            "That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…"
        ].waitForExistence(timeout: 10),
            "Return in the link field did not resolve it")

        // 2. A sign-in submitted by Return, never by clicking Sign in.
        let account = sidebarDestination("Account", in: window)
        XCTAssertTrue(account.waitForExistence(timeout: 10))
        account.click()
        let email = window.descendants(matching: .any)["account.email"].firstMatch
        let password = window.descendants(matching: .any)["account.password"].firstMatch
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        XCTAssertTrue(password.waitForExistence(timeout: 10))
        email.click()
        email.typeText("person@example.com")
        password.click()
        password.typeText("correct horse battery")
        app.typeKey(.return, modifierFlags: [])

        XCTAssertTrue(window.staticTexts["person@example.com"].waitForExistence(timeout: 20),
                      "Return in the sign-in form did not submit it")
    }

    /// Share actually opens the system sharing picker.
    ///
    /// Every handoff path so far asserted that a Share control EXISTS. A
    /// `ShareLink` over a value the system refuses renders the same button and
    /// does nothing when pressed — and on the pairing surface this is how the
    /// code reaches the other person at all.
    func testShareOpensTheSystemSharingPicker() {
        app.terminate()
        app.launchArguments = offlineLaunchArguments
        app.launch()
        ensureProductWindowIsOpen()

        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))
        let pairing = sidebarDestination("Cross-network Transfer", in: window)
        XCTAssertTrue(pairing.waitForExistence(timeout: 10))
        pairing.click()
        let create = window.buttons["Create a pairing code"]
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        create.click()
        XCTAssertTrue(window.descendants(matching: .any)["pairing-code-value"]
            .firstMatch.waitForExistence(timeout: 20))

        let share = window.buttons["Share"]
        XCTAssertTrue(share.waitForExistence(timeout: 10),
                      "the generated code offers no system share")
        share.click()

        // The picker is a system menu, presented outside the window.
        let picker = app.menus.firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 20),
                      "Share did not open the system sharing picker")
        app.typeKey(.escape, modifierFlags: [])
    }

    // MARK: - what VoiceOver would meet

    /// The identity `SidebarView` stamps on the element carrying each group
    /// heading's words. Three, the same three `MacSurfaceGuardTests` counts in
    /// the source, so this suite and the sidebar cannot drift into two sets.
    private static let sectionHeaderIDs = ["sidebar-sectionDirect",
                                           "sidebar-sectionLinks",
                                           "sidebar-sectionDevice"]

    /// What VoiceOver would meet on every destination, decided by the system's
    /// audit of the rendered tree rather than by an assertion we wrote.
    ///
    /// The macOS half of iOS's
    /// `testEveryPrimaryTaskPassesTheSystemAccessibilityAudit`, and the reason it
    /// arrives later is worth keeping: the audit found six shell-level classes
    /// here, and the only way to a green gate before adjudicating them was to
    /// drop the check that found them. So each class was matched against the
    /// running accessibility tree instead (`WORK-QUEUE.md` Q9), the product's own
    /// defects were fixed, and only the framework's own containers are excluded —
    /// individually, by kind, with their evidence. No audit type is subtracted
    /// except `contrast`, for the measured reason `auditedTypes` records.
    ///
    /// **The five destinations, not one screen.** All five reported an identical
    /// set, which is what identified the findings as shell-level rather than
    /// per-surface; auditing every destination is still what would notice the
    /// day that stops being true.
    func testEveryDestinationPassesTheSystemAccessibilityAudit() throws {
        guard #available(macOS 14.0, *) else {
            throw XCTSkip("the system accessibility audit needs macOS 14")
        }
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20))

        // Where the product's own group headings are, and whether they have
        // anything to say at all — read from the running tree BEFORE the audit,
        // so the report below can say which findings sit on their geometry while
        // ruling out those findings BEING them.
        //
        // Collected rather than asserted on the spot, deliberately: this suite
        // stops at the first failure, and every macOS run of it costs somebody a
        // terminal. One run should answer both halves of the question, not the
        // first half twice.
        //
        // **Typed collections, and every heading asked for on its own.**
        // `window.descendants(matching: .any)[…]` is the window-wide query that
        // times out on macOS — batches 94, 102 and 115 each hit it, and
        // `WORKFLOW-LEARNINGS.md` (2026-08-15) records that a macOS path written
        // on this workstation cannot be smoke-tested before it reaches the owner,
        // so it must be read against that limit rather than run into it.
        //
        // The 2026-08-16 run spent itself on the two assumptions this block no
        // longer makes. It reported `sidebar-sectionDirect` PRESENT in
        // `staticTexts`, and then reported all three headings — that one
        // included — as "nowhere in it", which is only possible if the lookup
        // that confirmed it and the lookup that read it were different lookups:
        //
        //  - one heading answering in a collection was taken as proof that all
        //    three live there. `.accessibilityAddTraits(.isHeader)` can promote
        //    one heading to `AXHeading` — a role reported as `other` — without
        //    promoting its siblings, and a `List` can merge one into its row's
        //    cell, so nothing entitles the three to share a type. Each is now
        //    resolved independently, each across all four collections;
        //  - and the confirmed query was then thrown away by appending
        //    `.firstMatch` to it. That builds a new element which resolves
        //    against a narrower snapshot, and it answered `false` for the exact
        //    identifier that had just answered `true`. The element a collection
        //    returns is now kept and read directly — frame, type and words all
        //    come off that one element, and nothing is looked up a second time.
        //
        // The failure names the collection AND the type for every heading, so a
        // run that still cannot find one says which four questions were asked
        // rather than leaving the next run to ask them again.
        var headers: [String: CGRect] = [:]
        var kinds: [String: String] = [:]
        var problems: [String] = []
        let collections = Self.headingCollections(of: window)
        let asked = collections.map(\.name).joined(separator: ", ")
        // One budget for all three headings rather than one each, so a sidebar
        // that never renders costs a bounded wait once instead of three times.
        // Every heading is still swept across all four collections at least once
        // even after it is spent, so "not found" can never mean "not asked".
        let deadline = Date(timeIntervalSinceNow: Self.headingResolutionBudget)
        for id in Self.sectionHeaderIDs {
            guard let hit = Self.resolveHeading(id, across: collections, until: deadline) else {
                problems.append("\(id): no element carries it in \(asked) — this heading's "
                                + "annotations are not reaching the accessibility tree, so "
                                + "nothing below can be attributed to the product or to the "
                                + "framework by elimination")
                continue
            }
            // The element that answered, used as it was returned.
            let header = hit.element
            let place = "\(hit.name)/\(Self.name(for: header.elementType))"
            guard !Self.words(of: header).isEmpty else {
                problems.append("\(id): a group heading is on screen as \(place) with nothing "
                                + "to read, which is the class of defect this gate exists for")
                continue
            }
            // Recorded only once it is BOTH identified and has words, because
            // this is what licenses the wrapper exclusion below. A heading that
            // lost its words leaves this dictionary, and the framework wrapper
            // around it stops being excluded in the same run.
            headers[id] = header.frame
            kinds[id] = place
        }

        var found: [String] = []
        for destination in Self.destinationIDs.keys.sorted() {
            let row = sidebarDestination(destination, in: window)
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the sidebar has no row for \(destination)")
            row.click()
            // Wait on the rendered destination rather than on anything being
            // audited: an audit of the previous destination is an audit that
            // proves nothing about this one.
            //
            // On the window's own title, which is the cheapest signal that says
            // it — `DestinationScaffold` sets `.navigationTitle`, so the title
            // changes when and only when the new destination's scaffold renders,
            // and reading a window attribute runs no descendant query at all.
            // This is the macOS answer to the `navigationBars[title]` wait the
            // iOS half makes, and the signal
            // `testTheSmallestWindowStillCarriesTheWholeTask` already navigates
            // by. The `destination-<id>` element is deliberately NOT the thing
            // waited on: addressing it needs either the `.any` query that times
            // out here, or a guess at which type the scaffold produced — a
            // `ScrollView` on four destinations and the non-scrolling arm's
            // container on Device Inbox — and a wrong guess would spend the one
            // owner-run this gate gets on a message about the query rather than
            // about accessibility. That identifier is asserted by
            // `testTheSmallestWindowStillCarriesTheWholeTask`, which is not this
            // gate's job.
            expectation(for: NSPredicate(format: "title == %@", destination),
                        evaluatedWith: window)
            waitForExpectations(timeout: 15) { error in
                guard error != nil else { return }
                XCTFail("\(destination)'s row opened no destination to audit — the "
                        + "window is still titled \(window.title)")
            }

            // Handled here rather than left to XCTest, so a failure names the
            // destination, the element and whether the product authored it. The
            // framework's own report is "Element has no description", which is
            // true and unactionable.
            let bounds = window.frame
            try app.performAccessibilityAudit(for: Self.auditedTypes) { issue in
                if Self.frameworkOwnedContainer(issue.element,
                                                in: bounds,
                                                around: headers) != nil { return true }
                found.append(Self.describe(issue, on: destination, against: headers))
                return true
            }
        }

        let identified = headers.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)(\(kinds[$0.key] ?? "?"))" }.joined(separator: " ")
        XCTAssertTrue(problems.isEmpty && found.isEmpty,
                      "the system accessibility audit rejected what VoiceOver would meet:\n"
                      + (problems + found).joined(separator: "\n")
                      + "\nthe product's own identified group headings, as "
                      + "id=frame(collection/type): " + identified)
    }

    /// The element carrying `id` and the name of the typed collection that
    /// answered, or `nil` once all four have been asked and the caller's shared
    /// budget is spent.
    ///
    /// **The element is returned exactly as the collection produced it.**
    /// Appending `.firstMatch` to a subscript that has already resolved is what
    /// the 2026-08-16 run proved costs the answer: the same identifier in the
    /// same collection reported `exists == true` before it and `false` after,
    /// because `.firstMatch` builds a second element that resolves against a
    /// narrower snapshot. So the caller reads frame, type and words off this one
    /// element rather than looking it up again.
    ///
    /// **Per heading, across every collection.** Which collection answered for
    /// one heading says nothing about the others — the heading trait can promote
    /// one of them and not its siblings — so this is called once per identifier
    /// and each call asks all four.
    ///
    /// **Bounded, and never by sleeping.** `exists` resolves a fresh snapshot
    /// each call, so the retry is real work against a settling tree rather than
    /// a spin, and it stops at the deadline the caller shares between headings.
    /// One complete sweep always happens first, so a heading is never reported
    /// missing from a collection that was not actually asked.
    private static func resolveHeading(_ id: String,
                                       across collections: [(name: String,
                                                             query: XCUIElementQuery)],
                                       until deadline: Date)
        -> (name: String, element: XCUIElement)? {
        var swept = false
        repeat {
            for collection in collections {
                let candidate = collection.query[id]
                if candidate.exists { return (collection.name, candidate) }
                if swept, Date() >= deadline { return nil }
            }
            swept = true
        } while Date() < deadline
        return nil
    }

    /// Fifteen seconds for all three headings together. The window itself has
    /// already been waited on for twenty above and the sidebar renders with it,
    /// so this is the allowance for a tree that has not settled, not for a
    /// surface that has not appeared.
    private static let headingResolutionBudget: TimeInterval = 15

    /// What VoiceOver would actually read from an element.
    ///
    /// macOS puts a `Text`'s words in `value` and leaves `label` empty often
    /// enough that this same suite reads the sidebar's own rows that way —
    /// `testEveryShippedLanguageRendersItsOwnShell` takes
    /// `(row.value as? String) ?? row.label`, and the 2026-08-15 probe recorded
    /// exactly that split on five identified rows. A heading is therefore proved
    /// to have words if either carries them; carrying neither is still a
    /// failure, and still the one this gate exists for.
    private static func words(of element: XCUIElement) -> String {
        element.label.isEmpty ? (element.value as? String ?? "") : element.label
    }

    /// The typed collections a sidebar group heading can land in, in the order
    /// the running tree justifies asking them, each named so a failure says which
    /// one answered rather than only that none did.
    ///
    ///  - `staticTexts` — what the heading now is. `SidebarView` annotates the
    ///    `Text` in place instead of synthesizing an element around it, and the
    ///    2026-08-15 probe printed all three heading words as TEXT elements
    ///    (`(778,362,34,14) label=Direct`);
    ///  - `otherElements` — `.accessibilityAddTraits(.isHeader)` can promote that
    ///    same element to `AXHeading`, a role `XCUIElement.ElementType` has no
    ///    case for and therefore reports as `other`;
    ///  - `groups` — where a synthesized element lands on this platform. Asked so
    ///    that a return to `.accessibilityElement(children: .ignore)` on the
    ///    header reports itself here instead of disappearing the way it did on
    ///    2026-08-16;
    ///  - `cells` — a `List` row is an AppKit cell, and a header holding a single
    ///    element can be merged into it.
    ///
    /// Asked in full for EVERY heading, not once for the group: the list is the
    /// set of roles a heading can hold, and `resolveHeading` sweeps all of it per
    /// identifier because one heading's answer does not constrain another's.
    ///
    /// Identifier lookups against typed queries throughout. Never
    /// `descendants(matching: .any)`, which is the shape that times out here.
    private static func headingCollections(of window: XCUIElement)
        -> [(name: String, query: XCUIElementQuery)] {
        [("staticTexts", window.staticTexts),
         ("otherElements", window.otherElements),
         ("groups", window.groups),
         ("cells", window.cells)]
    }

    /// Everything the system audits EXCEPT contrast, stated as a subtraction so
    /// it keeps covering whatever Apple adds next — and so it states the same
    /// rule as the iOS half rather than a second list. A literal list would have
    /// had to fork: this platform has neither `dynamicType` nor `trait` nor
    /// `textClipped`.
    ///
    /// Contrast is excluded for the measured reason recorded on the iOS half:
    /// ten findings there split into three genuine failures, four pieces of
    /// correct UI the checker rejects anyway, and a disabled control WCAG 1.4.3
    /// exempts. It is recorded and measured rather than automated. Nothing else
    /// is subtracted, on either platform.
    @available(macOS 14.0, *)
    private static var auditedTypes: XCUIAccessibilityAuditType {
        XCUIAccessibilityAuditType.all.subtracting(.contrast)
    }

    /// The name of the framework-created container this issue is describing, or
    /// `nil` when the product is answerable for it.
    ///
    /// **Named individually, from the running tree, never by dropping the audit
    /// type that found them.** The 2026-08-15 probe (`WORK-QUEUE.md` Q9) matched
    /// every unlabelled container the audit reported to a node SwiftUI or AppKit
    /// creates, by frame:
    ///
    ///  - `(80,0,685,30)` — the process menu bar, drawn above the product window;
    ///  - `(756,308,914,612)` — the detail half's wrapper, reported TWICE because
    ///    a `Group` and a `SplitGroup` share that exact frame;
    ///  - `(764,316,224,596)` — the same structure around the sidebar's scroll
    ///    view.
    ///
    /// VoiceOver stops on none of the three; it enters the children that carry
    /// the words. They are matched here by kind and proportion rather than by
    /// those pixel values, so a resized window or a different display cannot turn
    /// an exclusion into a silent pass — and so the rule cannot reach anything
    /// the shell draws: both wrappers are taller than half the window, while
    /// every element the product authors inside them, the 19-point group headings
    /// included, is a fraction of that.
    ///
    /// The owner's 2026-08-16 run named three more, and they are the last three:
    ///
    ///  - the unlabelled `Group` on each of the three group-heading rows,
    ///    `(778,360,208,19)`, `(778,456,208,19)` and `(778,520,208,19)`. Q9 froze
    ///    the reading of this element in advance: `List`'s own header wrapper if
    ///    the owner's runtime proved it, the product's element if not. It proved
    ///    it twice over. The frames are byte-identical to the ones the 2026-08-15
    ///    audit reported, across a rewrite that moved the heading's annotations
    ///    off an `HStack`, onto a `Text` and then off a synthesized element
    ///    altogether — no product change has ever moved them — and each one
    ///    encloses a heading the product identifies and this test has already
    ///    proved has words. No product code can name it;
    ///  - the 14-point-wide `Group` at `(821,327)` the audit reports for a
    ///    parent/child mismatch: the disclosure control `List` draws for a
    ///    collapsible `Section`, and a mismatch inside the framework's own
    ///    hierarchy. **Two runtimes have now measured it, and both are
    ///    authoritative.** The owner's Xcode 17 / macOS 26 run read it 14×14;
    ///    GitHub's Xcode 16.4 / macOS 15.5 read it 14×16 — the same width, on
    ///    all five destinations, with the same empty identifier, empty label and
    ///    parent/child finding. The width is stable across both and stays a
    ///    single measurement; only the height varies, so only the height is
    ///    written as a range, and it spans nothing but the two values actually
    ///    observed;
    ///  - `elementType(81)`, the Touch Bar. The product declares none, so this is
    ///    the system's own remote representation of the app.
    ///
    /// The wrapper rule is the narrowest of the three and is deliberately
    /// self-invalidating: it excludes a container only while it wraps a heading
    /// that is BOTH identified and labelled. A heading that lost its words leaves
    /// `headers` — see the collection loop — and the wrapper around it stops
    /// being excluded in the very same run, so this can never become the quiet
    /// way to pass an empty heading.
    ///
    /// **Enclosure is not on its own enough, and neither is an upper bound.**
    /// Enclosing a proven heading is a property a container of ANY size has, so
    /// a product-authored group holding a heading together with its rows would
    /// have satisfied the wrapper rule and been swallowed — and an upper bound
    /// alone admits everything smaller than it, so a 2×2 or a 9×9 unnamed group
    /// would have passed as the disclosure control. Both are therefore bound to
    /// the geometry their evidence actually measured, from both sides. That is
    /// what Q9 froze: a framework-owned finding leaves by exact evidence, never
    /// by a rule shaped loosely enough to also cover something unmeasured.
    ///
    /// A range is held to the same standard. The disclosure height spans two
    /// measurements because two supported runtimes each produced one, and its
    /// endpoints are those two readings — not a band chosen to be safe. The
    /// lower endpoint is still a lower bound, so nothing smaller than a
    /// disclosure triangle gets in underneath it, and the upper endpoint stays
    /// clear of the 19-point heading rows above. Widening either endpoint needs
    /// a third runtime that actually measured it.
    ///
    /// The resident menu-bar extra is deliberately NOT covered: it is
    /// `statusItem`, product code, and an unlabelled one would be a real defect.
    @available(macOS 14.0, *)
    private static func frameworkOwnedContainer(_ element: XCUIElement?,
                                                in window: CGRect,
                                                around headers: [String: CGRect]) -> String? {
        guard let element else { return nil }
        if element.elementType == .menuBar || element.elementType == .menuBarItem {
            return "AppKit's own menu bar"
        }
        if element.elementType == .touchBar {
            return "the system Touch Bar representation of an app that declares none"
        }
        if [XCUIElement.ElementType.group, .splitGroup].contains(element.elementType),
           element.frame.height >= window.height / 2 {
            return "a structural wrapper around a whole half of the window"
        }
        // Everything below is bounded to a container the product neither names
        // nor labels, so no rule here can reach an element the shell draws.
        guard element.elementType == .group,
              element.identifier.isEmpty,
              element.label.isEmpty else { return nil }
        // Height, and deliberately not width. 19 points is what a `List` row is
        // on this platform — the same in all three measured frames, and the same
        // wherever the window sits — while their 208-point width is the sidebar's
        // current width and moves the moment the split is dragged. Binding the
        // height keeps the rule pinned to the measured shape; leaving the width
        // free keeps it resize-independent.
        if measures(element.frame.height, Self.headingRowHeight),
           let wrapped = headers.first(where: { encloses(element.frame, $0.value) })?.key {
            return "the wrapper List draws around the identified, labelled \(wrapped)"
        }
        // Width is one measurement, matched from both sides; height is the two
        // the supported runtimes measured, matched from both ends of that span.
        // A ±1 slack for a different backing scale's rounding is the whole
        // further allowance; even at the top it does not reach the 19-point
        // heading rows above, and the bottom end keeps everything smaller than a
        // disclosure triangle out from underneath it.
        if measures(element.frame.width, Self.disclosureWidth),
           measures(element.frame.height,
                    from: Self.disclosureHeightLow,
                    through: Self.disclosureHeightHigh) {
            return "the disclosure control List draws for a collapsible Section"
        }
        return nil
    }

    /// The `List`-drawn geometry the audit runs measured, in points.
    ///
    /// Sizes, never positions: a stated size survives a resized window, a moved
    /// window and a different display, which is why the excluded frames are
    /// matched by these rather than by the `(778,360,…)` coordinates they were
    /// read at.
    private static let headingRowHeight: CGFloat = 19

    /// The disclosure control's width, the one dimension both runtimes agreed on.
    private static let disclosureWidth: CGFloat = 14

    /// Its height, which they did not. These two numbers are readings, not a
    /// tolerance: 14 from the owner's Xcode 17 / macOS 26 run, 16 from GitHub's
    /// Xcode 16.4 / macOS 15.5 run. Neither endpoint was chosen, only measured.
    ///
    /// The span does admit a 15 no run has reported, which is the honest cost of
    /// accepting both readings at once: the alternative is a rule that rejects
    /// one of the two runtimes the product is actually tested on. It is bounded
    /// on both sides by observations rather than open in either direction, and
    /// the one unobserved height it lets through is bracketed by two that were
    /// measured — not a range extended until the failure stopped.
    private static let disclosureHeightLow: CGFloat = 14
    private static let disclosureHeightHigh: CGFloat = 16

    /// What a different backing scale's rounding may add in either direction.
    /// One point: enough for a half-point rounding on a 2× display, and still
    /// two points short of the 19-point heading rows even from the taller
    /// disclosure reading.
    private static let geometrySlack: CGFloat = 1

    /// Whether a measured length is the recorded one, within that slack.
    ///
    /// Both bounds, and that is the point of the function. An upper bound alone
    /// admits every smaller element as well, which is how a rule written for one
    /// measured framework container silently becomes a rule about size.
    private static func measures(_ value: CGFloat, _ measured: CGFloat) -> Bool {
        value >= measured - geometrySlack && value <= measured + geometrySlack
    }

    /// Whether a measured length falls between two recorded readings, within
    /// that same slack at each end.
    ///
    /// Both ends, for exactly the reason above, and it is deliberately a
    /// separate function rather than a widened `measures`: the moment one call
    /// can pass a low and a high, every other call site can too, and the single
    /// measurements stop being single. This one exists only where two supported
    /// runtimes measured the same framework-drawn control differently. Its
    /// arguments are those two readings; it is not a place to put a guess.
    private static func measures(_ value: CGFloat,
                                 from low: CGFloat,
                                 through high: CGFloat) -> Bool {
        value >= low - geometrySlack && value <= high + geometrySlack
    }

    /// Whether `outer` encloses `inner`, within a point of slack for rounding.
    /// Containment rather than an equal frame, because `List`'s wrapper is the
    /// full 208×19 row while the heading inside it is the size of its own words.
    private static func encloses(_ outer: CGRect, _ inner: CGRect) -> Bool {
        outer.insetBy(dx: -1, dy: -1).contains(inner)
    }

    /// One finding, in the terms needed to dispose of it: which destination, what
    /// the system said, and whether it lands on a row the product identifies.
    ///
    /// That last part is the question Q9 stopped on, and it is now answered: the
    /// heading carries `sidebar-section…`, is proved to have a description before
    /// the audit runs, and `frameworkOwnedContainer` retires the wrapper that
    /// encloses it. What remains here is the report for anything that is NOT
    /// disposed of — attribution by enclosure, so a container is described by the
    /// identified heading it wraps rather than by matching pixels a second time.
    @available(macOS 14.0, *)
    private static func describe(_ issue: XCUIAccessibilityAuditIssue,
                                 on destination: String,
                                 against headers: [String: CGRect]) -> String {
        let element = issue.element
        let frame = element?.frame ?? .zero
        let row = headers.first { encloses(frame, $0.value) }
        let owner = row.map { "wrapped around \($0.key), which is identified and labelled, "
                              + "so this is not it" }
            ?? "around no heading the product identifies"
        return "\(destination): \(issue.compactDescription) — "
            + "type=\(Self.name(for: element?.elementType)) "
            + "id=\(element?.identifier ?? "") "
            + "label=\(element?.label ?? "") frame=\(frame) [\(owner)]"
    }

    /// `XCUIElement.ElementType` prints as a bare number, and a number in a
    /// report the owner has to run for us is a round trip spent looking it up.
    /// Name the kinds this shell can actually produce a finding on; anything
    /// else falls back to the raw value, which is still enough to identify.
    private static func name(for type: XCUIElement.ElementType?) -> String {
        switch type {
        case .none: return "none"
        case .some(.group): return "group"
        case .some(.splitGroup): return "splitGroup"
        case .some(.scrollView): return "scrollView"
        case .some(.table): return "table"
        case .some(.outline): return "outline"
        case .some(.outlineRow): return "outlineRow"
        case .some(.cell): return "cell"
        case .some(.staticText): return "staticText"
        case .some(.image): return "image"
        case .some(.button): return "button"
        case .some(.menuBar): return "menuBar"
        case .some(.menuBarItem): return "menuBarItem"
        case .some(.statusItem): return "statusItem"
        case .some(.touchBar): return "touchBar"
        case .some(.window): return "window"
        case .some(.other): return "other"
        case .some(let other): return "elementType(\(other.rawValue))"
        }
    }

}
