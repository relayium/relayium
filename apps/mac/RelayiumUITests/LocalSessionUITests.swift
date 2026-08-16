import XCTest

/// **The built macOS app, driven through its own UI, holding TWO genuinely
/// established connections at the same time** — one same-network `link/1` and
/// one cross-network pairing `link/1` — and cancelling them one at a time in
/// both orders.
///
/// This is the runtime evidence for the owner's requirement, and the half a
/// fixture cannot claim: that two connections which really exist survive
/// navigating between the two destinations in both directions, and that each
/// screen's Cancel ends exactly the connection that screen is drawing.
///
/// **Nothing here is a fixture.** Both connections are real `link/1` sessions
/// over real WebRTC, against real counterpart processes and a real throwaway Go
/// server. Every claim the app's own UI makes is checked a second time against
/// the counterpart's control API, so a suite that somehow went green against a
/// peer that never served a link still fails.
///
/// ## Why a second real session was possible at all
///
/// An earlier round of this file recorded that the app joining a pairing code
/// minted by another native process "does not currently establish: both native
/// ends reach `watching` and neither requests", and left the Direct half
/// unconnected. That measurement was real and the diagnosis was wrong. The cause
/// was in the harness, not the wire: `RelayiumApp` substituted `UITestMode`'s
/// offline models for every launch with `--relayium-ui-testing`, including this
/// one, so the Direct module was built with an ICE client that sleeps for five
/// minutes and a `connectPairingSocket` that is a `preconditionFailure`.
/// `LinkWorkspaceModel.watchPairingCode` reads ICE *before* it opens the room —
/// so the app published `.watching` and never opened a socket for the peer to
/// find. Both ends waited, correctly, for somebody who was not there.
///
/// `UITestMode.usesOfflineTransfer` is the repair: the fixtures now apply to the
/// offline suite and not to a launch that resolved a loopback origin. Nothing
/// about the pairing protocol changed.
///
/// `AppShellUITests.testEachTransferModuleKeepsItsOwnSessionAcrossNavigationAndCancel`
/// covers the same requirement offline and deterministically. Both are needed,
/// and neither replaces the other: that one runs on every push with no server,
/// and this one is the only place two real connections coexist.
///
/// Every path SKIPS without the harness, so the file can sit in the same target
/// as the offline suite and cost a plain `-only-testing:RelayiumUITests` run
/// nothing. Run it through `scripts/macos-ui-session-acceptance.sh`.
final class LocalSessionUITests: XCTestCase {

    // MARK: - the harness

    /// What the launcher passes through `TEST_RUNNER_*`.
    ///
    /// The environment rather than launch arguments, and the control bearer
    /// above all: argv on macOS is readable by every process this user runs, so
    /// a token on the `xcodebuild` command line would be published to the whole
    /// session for the length of the run. The origin is not a secret and does
    /// travel in argv — it has to, because `AppEnvironment.resolvedTransferBaseURL`
    /// reads `ProcessInfo.arguments`.
    private struct Harness {
        let origin: String
        let controlToken: String
        let nearbyPort: Int
        let peerName: String
        /// One pairing counterpart per test, and that is a requirement rather
        /// than tidiness. `LocalTransferPeer`'s `pair-link` role starts one run
        /// per process and `watchPairingCode` refuses a second room while the
        /// first is active, so the two cancel orders below cannot share one.
        let pairPorts: [Int]
    }

    private var app: XCUIApplication!

    /// Every assertion below names a rendered English string, so the language
    /// and locale are pinned rather than inherited from whatever the machine was
    /// last left in — the same thing `AppShellUITests` does.
    /// `-SUEnableAutomaticChecks NO` is not tidiness: Sparkle's own window is an
    /// auxiliary window this process owns, and an update check racing the launch
    /// is how a suite ends up driving the updater instead of the product.
    private let launchArguments = [
        "--relayium-ui-testing", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        "-SUEnableAutomaticChecks", "NO",
    ]

    private func requireHarness() throws -> Harness {
        let environment = ProcessInfo.processInfo.environment
        func value(_ name: String) -> String? {
            let raw = environment["RELAYIUM_ACCEPTANCE_\(name)"]
            return (raw?.isEmpty == false) ? raw : nil
        }
        guard let origin = value("ORIGIN"),
              let token = value("CONTROL_TOKEN"),
              let nearby = value("NEARBY_PORT").flatMap(Int.init),
              let name = value("NEARBY_NAME"),
              let ports = value("PAIR_PORTS")?
                  .split(separator: ",").compactMap({ Int($0) }),
              ports.count >= 2
        else {
            throw XCTSkip("""
                No local acceptance harness. These paths need a throwaway server \
                and three counterpart processes; run them through \
                scripts/macos-ui-session-acceptance.sh.
                """)
        }
        return Harness(origin: origin, controlToken: token, nearbyPort: nearby,
                       peerName: name, pairPorts: ports)
    }

    /// Stop at the first failure.
    ///
    /// Almost every assertion below is a `waitForExistence` with a real ceiling,
    /// so continuing past a failure produces one timeout after another against a
    /// window that is already in the wrong state, and buries the assertion that
    /// actually failed.
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// Launch pointed at the local server.
    ///
    /// `--relayium-transfer-origin` is the whole seam: `#if DEBUG`, loopback
    /// origins only, and it is what makes `UITestMode.allowsResidency` true — so
    /// this launch, and only a launch like it, may join the code-less room and
    /// compose the real transfer models rather than the offline fixtures.
    ///
    /// Verification is pinned OFF through the argument domain, exactly as the
    /// iOS suite pins it: `VerificationPreference` reads `UserDefaults`, which
    /// persists between launches on a real Mac, so a machine whose owner had
    /// switched the setting on would drop every connection below into a SAS gate
    /// these paths are not driving. The product code is unchanged; only the
    /// stored answer is chosen here.
    private func launch(_ harness: Harness) {
        app = XCUIApplication()
        app.launchArguments = launchArguments
            + ["--relayium-transfer-origin", harness.origin]
            + ["-com.relayium.verifyPeers", "NO"]
        app.launch()
    }

    // MARK: - the counterparts' control API

    @discardableResult
    private func control(_ port: Int, _ method: String, _ path: String,
                         body: [String: Any]? = nil) -> [String: Any]? {
        guard let harness = try? requireHarness(),
              let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue("Bearer \(harness.controlToken)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        var result: [String: Any]?
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data {
                result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 20)
        return result
    }

    /// The pairing counterpart mints a code and waits in its room.
    ///
    /// Minted at the moment it is about to be typed, never earlier: a code is
    /// short-lived and single-use, so a code minted at peer start would already
    /// be stale by the time a roster and a link had been established in front of
    /// it.
    private func mintPairingCode(_ harness: Harness, port: Int) throws -> String {
        // `create`, explicitly: the `pair-link` role defaults to `join`, and a
        // start with no action would leave the counterpart waiting for a code
        // this test is waiting for it to publish.
        control(port, "POST", "/start", body: ["action": "create"])
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            if let code = control(port, "GET", "/status")?["code"] as? String,
               !code.isEmpty {
                return code
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        throw XCTSkip("the pairing counterpart never published a code")
    }

    /// **The counterpart's own answer, not the app's.**
    ///
    /// Every assertion about a connection in this file is made twice: once
    /// against what the window draws, and once against the process on the other
    /// end of the wire. A UI identifier proves the app believes it is connected;
    /// only this proves somebody is connected to it.
    private func pairingCounterpartHoldsAnOpenLink(_ port: Int) -> Bool {
        guard let observed = control(port, "GET", "/observed") else { return false }
        // `open(`, not merely `hasSession`: a link publishes a session the moment
        // it starts establishing, and the lanes do not exist until the transport
        // is ready.
        guard let phase = observed["linkPhase"] as? String else { return false }
        XCTAssertNil(observed["legacyFallback"],
                     "the pairing counterpart fell back to the LEGACY wire, so the "
                     + "session on screen is not the link/1 this test is about")
        return phase.hasPrefix("open(")
    }

    private func nearbyCounterpartServedLinks(_ port: Int) -> Int {
        (control(port, "GET", "/observed")?["epoch"] as? Int) ?? 0
    }

    /// Whether the same-network counterpart's link is OPEN right now.
    ///
    /// **Separate from `epoch`, and the distinction cost an assertion.** `epoch`
    /// counts the links this process has served and never decreases, so "the
    /// same-network link survived cancelling the pairing one" checked against it
    /// would stay true after the link had been torn down — a check that cannot
    /// fail is worse than no check, because it reads like one that can.
    private func nearbyCounterpartHoldsAnOpenLink(_ port: Int) -> Bool {
        guard let phase = control(port, "GET", "/observed")?["linkPhase"] as? String
        else { return false }
        return phase.hasPrefix("open(")
    }

    /// Poll a counterpart until it agrees, or give up with its last answer.
    @discardableResult
    private func waitFor(_ what: String, timeout: TimeInterval = 120,
                         _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTFail("timed out waiting for \(what)")
        return false
    }

    // MARK: - window and navigation

    /// Sparkle and AppKit may create auxiliary windows before the shell, so
    /// `windows.firstMatch` is not a product window. Newer systems expose the
    /// SwiftUI scene id and macOS 15 does not; the cross-version product
    /// contract is that Relayium's 860×560 work area is the process's largest
    /// window. Selected by that visible geometry, exactly as `AppShellUITests`
    /// does — one rule, because a second one would drift.
    private var mainWindow: XCUIElement {
        app.windows.allElementsBoundByIndex.max {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        } ?? app.windows.firstMatch
    }

    /// This app keeps running with its window closed, and a machine that has run
    /// it before may reopen it that way. The menu bar is the product's own route
    /// back, and it is the one used here rather than a relaunch.
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
        app.typeKey("o", modifierFlags: [])
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 10),
                      "the menu-bar recovery action did not restore the product window")
    }

    /// Select a destination through its sidebar row and prove the DETAIL column
    /// actually changed.
    ///
    /// The identifier is the shell's own `destination-<surface>`, which exists
    /// precisely because a sidebar row and a page heading carry the same words:
    /// a check that only clicked the row would go green against a detail column
    /// that never moved, which is the failure `AppShellUITests` records.
    private func select(_ row: String, surface: String) {
        let window = mainWindow
        let sidebarRow = window.descendants(matching: .any)["sidebar-\(row)"].firstMatch
        XCTAssertTrue(sidebarRow.waitForExistence(timeout: 20),
                      "the \(row) sidebar row never appeared")
        sidebarRow.click()
        XCTAssertTrue(window.descendants(matching: .any)["destination-\(surface)"]
            .firstMatch.waitForExistence(timeout: 20),
                      "clicking \(row) did not put \(surface) in the detail column")
    }

    private func showNearby() { select("lanTransfer", surface: "lanTransfer") }
    private func showDirect() { select("crossNetworkTransfer", surface: "crossNetworkTransfer") }

    private func element(_ identifier: String) -> XCUIElement {
        mainWindow.descendants(matching: .any)[identifier].firstMatch
    }

    // MARK: - establishing each module's own connection

    /// Open a real `link/1` to the resident counterpart, from the roster.
    private func connectNearby(_ harness: Harness) {
        showNearby()
        let window = mainWindow
        // Residency is started by the app itself; the roster is what proves the
        // room is joined and the counterpart is in it.
        //
        // `matching` on `buttons`, never `containing` on `descendants`: a roster
        // row is one combined Button whose label is the peer's own name, while
        // `containing` matches any ANCESTOR that holds such a label — which is
        // the window. The first version of this test clicked the window, found
        // it existed, and reported "choosing a device offered no Connect".
        let row = window.buttons
            .matching(NSPredicate(format: "label CONTAINS %@", harness.peerName))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 90),
                      "the counterpart \(harness.peerName) never appeared in the roster")
        row.click()
        let connect = element("lan-connect-device")
        XCTAssertTrue(connect.waitForExistence(timeout: 20),
                      "choosing a device offered no Connect")
        connect.click()
        XCTAssertTrue(element("link-session-peer").waitForExistence(timeout: 120),
                      "the same-network link never reached a session")
        // …and the peer agrees it is serving one.
        waitFor("the same-network counterpart to serve a link") {
            nearbyCounterpartServedLinks(harness.nearbyPort) >= 1
        }
    }

    /// Join the code the pairing counterpart minted, producing a SECOND real
    /// connection while the first is still open.
    ///
    /// Every assertion on the way in is also a regression test for the shipped
    /// build: one `TransferPresence` arbitrated both destinations, so an open
    /// same-network link disabled the code field and the Connect button this
    /// method types into and clicks.
    private func connectDirect(_ harness: Harness, port: Int) throws {
        let code = try mintPairingCode(harness, port: port)
        showDirect()
        let window = mainWindow
        let field = window.textFields["pairing.joinCode"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 20),
                      "the Direct screen offered no code field while Nearby was connected")
        XCTAssertTrue(field.isEnabled,
                      "a same-network session disabled the Direct screen's code field")
        field.click()
        field.typeText(code)
        let join = element("cross-network-join-code")
        XCTAssertTrue(join.isEnabled,
                      "a same-network session disabled the Direct screen's Connect")
        join.click()
        // The diagnosis is part of the assertion, because "no session" has
        // several distinct causes and they are not distinguishable afterwards:
        // still watching the room, an ended link with a reason on screen, or a
        // legacy fallback that never announced `link/1`.
        XCTAssertTrue(element("link-session-peer").waitForExistence(timeout: 120),
                      "the pairing link never reached a session — "
                      + "waiting=\(element("transfer-waiting-pairing-peer").exists) "
                      + "ended=\(element("link-ended").exists) "
                      + "legacyPeer=\(element("transfer-session-peer").exists) "
                      + "stillOnConnect=\(element("cross-network-join-code").exists)")
        // …and the counterpart on the other end of that code agrees.
        waitFor("the pairing counterpart to reach an open link/1") {
            pairingCounterpartHoldsAnOpenLink(port)
        }
    }

    /// Both modules connected, from the outside, at the same moment.
    private func assertBothCounterpartsHoldALiveLink(_ harness: Harness, pairPort: Int) {
        XCTAssertGreaterThanOrEqual(
            nearbyCounterpartServedLinks(harness.nearbyPort), 1,
            "the same-network counterpart is serving no link while the app draws one")
        XCTAssertTrue(pairingCounterpartHoldsAnOpenLink(pairPort),
                      "the pairing counterpart is serving no link while the app draws one")
    }

    /// The one Cancel the pane offers, pressed on whichever destination is open.
    private func cancelTheSessionOnScreen(_ what: String) {
        let leave = element("link-leave-session")
        XCTAssertTrue(leave.waitForExistence(timeout: 30),
                      "the live \(what) session offered no Cancel")
        leave.click()
    }

    /// **What "this module let go of its connection" actually looks like.**
    ///
    /// `link-ended` is listed FIRST because it is the expected outcome, not a
    /// fallback. Leaving a `link/1` publishes a RETAINED terminal state: the pane
    /// keeps the peer heading, the result of anything that transferred and the
    /// reason it ended until the user dismisses it, exactly as a completed
    /// receive keeps its Reveal in Finder. So the screen does NOT return to its
    /// connect phase on the press, and a check that waited for the roster first
    /// spent thirty seconds timing out before finding the state the product was
    /// always going to be in.
    ///
    /// The connect-phase spellings stay as the other legitimate ending — a
    /// module whose terminal notice was already dismissed, or one that never
    /// published a session to retain.
    private func assertModuleReleasedItsSession(_ what: String,
                                                connectPhase: [() -> Bool],
                                                file: StaticString = #filePath,
                                                line: UInt = #line) {
        if element("link-ended").waitForExistence(timeout: 30) { return }
        XCTAssertTrue(connectPhase.contains { $0() },
                      "cancelling the \(what) session neither ended it nor returned "
                      + "its own screen to the connect phase",
                      file: file, line: line)
    }

    private func assertNearbyScreenReleased() {
        let window = mainWindow
        assertModuleReleasedItsSession("same-network", connectPhase: [
            { window.buttons["Start receiving"].waitForExistence(timeout: 5) },
            { self.element("lan-connect-device").waitForExistence(timeout: 5) },
        ])
    }

    private func assertDirectScreenReleased() {
        let window = mainWindow
        assertModuleReleasedItsSession("pairing", connectPhase: [
            { window.textFields["pairing.joinCode"].firstMatch.waitForExistence(timeout: 5) },
        ])
    }

    /// **The ended session's exit is still there, and now reads `Done`.**
    ///
    /// An earlier spelling of this check asserted that `link-leave-session` was
    /// GONE, and that was simply not true of the product: an ended `link/1` keeps
    /// its retained terminal pane, and `TransferLinkPane.leaveTitle` swaps the
    /// button's title from Leave session to `L10n.t(.commonDone)` rather than
    /// removing the button. The absence assertion could therefore only have gone
    /// green against a pane that had thrown the user's result away — which is the
    /// opposite of the behaviour the comment beside it was defending. The title
    /// is the honest evidence: it changes exactly when the connection ends.
    ///
    /// The literal rather than `L10n.t(.commonDone)`: this bundle links the app
    /// under test and no Swift package, so `RelayiumShareKit`'s key is not in
    /// scope here. Pinning the English string is safe because `launchArguments`
    /// fixes this launch at `en`, and English is the source language.
    private func assertTerminalExitReadsDone(_ what: String,
                                             file: StaticString = #filePath,
                                             line: UInt = #line) {
        let terminalExit = element("link-leave-session")
        XCTAssertTrue(terminalExit.waitForExistence(timeout: 30),
                      "the ended \(what) session dropped its terminal action entirely",
                      file: file, line: line)
        XCTAssertEqual(terminalExit.label, "Done",
                       "the ended \(what) session's exit still reads "
                       + "“\(terminalExit.label)”, so it is offering to leave a link "
                       + "that should already be over",
                       file: file, line: line)
    }

    // MARK: - the requirement

    /// **Two real connections at once, navigation in both directions, and Cancel
    /// on Direct ending only Direct.**
    ///
    /// The order matters and is half the point: this test cancels the module the
    /// user is standing on second in the pair, and
    /// `testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected`
    /// cancels the other one first. A teardown that reached across modules would
    /// pass one order and fail the other, which is exactly how a shared teardown
    /// hides.
    func testBothModulesHoldRealConnectionsAcrossNavigationAndCancelDirectOnly() throws {
        let harness = try requireHarness()
        let pairPort = harness.pairPorts[0]
        launch(harness)
        ensureProductWindowIsOpen()
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 60))

        // ── two genuinely established sessions ───────────────────────────────
        connectNearby(harness)

        // Before the second one exists: the other module is FREE, against a
        // connection that genuinely exists.
        showDirect()
        XCTAssertFalse(element("transfer-busy-elsewhere").exists,
                       "the Direct screen still explains a lock it no longer has")
        XCTAssertFalse(element("link-session-peer").exists,
                       "the same-network session is drawn on the Direct screen too")

        try connectDirect(harness, port: pairPort)
        assertBothCounterpartsHoldALiveLink(harness, pairPort: pairPort)

        // ── (1) and (2): both directions, repeatedly ─────────────────────────
        //
        // Five round trips rather than one, because a defect that ends a session
        // on the SECOND return passes a single trip. Each leg asserts the
        // session that belongs to the screen AND that the other module's is not
        // drawn on it.
        for trip in 0..<5 {
            showNearby()
            XCTAssertTrue(element("link-session-peer").waitForExistence(timeout: 30),
                          "the same-network connection did not survive trip \(trip) to Direct")
            showDirect()
            XCTAssertTrue(element("link-session-peer").waitForExistence(timeout: 30),
                          "the pairing connection did not survive trip \(trip) to Nearby")
        }
        // Both were still live for the whole of that, on the wire and not only
        // on screen.
        assertBothCounterpartsHoldALiveLink(harness, pairPort: pairPort)

        // ── (3) Cancel on Direct ends Direct, and only Direct ────────────────
        showDirect()
        cancelTheSessionOnScreen("pairing")
        assertDirectScreenReleased()
        // **The CANCELLED module's counterpart, not only the surviving one.**
        // Without this half, a Cancel that repainted its own screen and left the
        // link open on the wire would pass every assertion in this test: the pair
        // below is about the module that was NOT cancelled, and the screen checks
        // are about what the app believes. Only the far end can say the link is
        // actually closed.
        //
        // Polled rather than read once, because the counterpart learns the link
        // is over when the close reaches it and not when the button is clicked.
        waitFor("the pairing counterpart to close its link") {
            !pairingCounterpartHoldsAnOpenLink(pairPort)
        }

        showNearby()
        XCTAssertTrue(element("link-session-peer").waitForExistence(timeout: 30),
                      "cancelling the pairing session ended the same-network one too")
        XCTAssertTrue(nearbyCounterpartHoldsAnOpenLink(harness.nearbyPort),
                      "cancelling the pairing session closed the same-network link on "
                      + "the counterpart, so the teardown reached across modules")

        // …and then its own, whose exit leaves the Direct screen where it was.
        cancelTheSessionOnScreen("same-network")
        assertNearbyScreenReleased()
        waitFor("the same-network counterpart to close its link") {
            !nearbyCounterpartHoldsAnOpenLink(harness.nearbyPort)
        }
        showDirect()
        assertDirectScreenReleased()
        // **Deliberately NOT "the peer heading is gone", and not "the exit is
        // gone" either.** An ended link is a retained terminal state: the pane
        // keeps the peer, the transfer result and the reason until the user
        // dismisses it, exactly as a completed receive keeps its Reveal in
        // Finder — and it keeps its button too, retitled `Done`. What must be
        // true is that the connection is over and cannot still be taking bytes;
        // asserting either element's absence would be asserting that the product
        // throws away a result the user has not read.
        assertTerminalExitReadsDone("pairing")
    }

    /// **The other order**: the same two real connections, and Cancel on Nearby
    /// leaving the Direct one connected.
    ///
    /// Its own launch and its own pairing counterpart, so nothing survives from
    /// the test above — a pairing room is one per `pair-link` process, and a
    /// second establishment in a reused app would be proving recovery rather
    /// than independence.
    func testCancellingTheNearbyModuleFirstLeavesTheDirectSessionConnected() throws {
        let harness = try requireHarness()
        let pairPort = harness.pairPorts[1]
        launch(harness)
        ensureProductWindowIsOpen()
        XCTAssertTrue(mainWindow.waitForExistence(timeout: 60))

        connectNearby(harness)
        try connectDirect(harness, port: pairPort)
        assertBothCounterpartsHoldALiveLink(harness, pairPort: pairPort)

        // Cancel the SAME-NETWORK one first, from its own screen.
        showNearby()
        cancelTheSessionOnScreen("same-network")
        assertNearbyScreenReleased()
        // The cancelled module really let go, proved from the far end — the same
        // half the other order checks, and the reason a Cancel that only
        // repainted its screen cannot pass either order.
        waitFor("the same-network counterpart to close its link") {
            !nearbyCounterpartHoldsAnOpenLink(harness.nearbyPort)
        }

        // The pairing connection is untouched — on screen…
        showDirect()
        XCTAssertTrue(element("link-session-peer").waitForExistence(timeout: 30),
                      "cancelling the same-network session ended the pairing one too")
        // …and on the wire, which is the assertion a shared teardown fails.
        XCTAssertTrue(pairingCounterpartHoldsAnOpenLink(pairPort),
                      "cancelling the same-network session closed the pairing link "
                      + "on the counterpart, so the teardown reached across modules")

        // And it can still be ended by its own screen afterwards.
        cancelTheSessionOnScreen("pairing")
        assertDirectScreenReleased()
        waitFor("the pairing counterpart to close its link") {
            !pairingCounterpartHoldsAnOpenLink(pairPort)
        }
        assertTerminalExitReadsDone("pairing")
    }
}
