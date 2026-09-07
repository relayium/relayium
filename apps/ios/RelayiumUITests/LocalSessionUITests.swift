import XCTest

/// Q0-T2b: the BUILT iOS app driving real transfers against a real second
/// endpoint, through its own UI.
///
/// ## Why this file exists separately from `AppShellUITests`
///
/// Every test in that file is offline by construction: `--relayium-ui-testing`
/// with no origin resolves production, `UITestMode.allowsResidency` is therefore
/// false, and the app deliberately becomes reachable to nobody. That is the
/// right default — an acceptance build that advertised itself would offer a
/// stranger's device a connection to a test — and it is also why 35 UI tests
/// could never once observe a second device. Q0's four remaining iOS cells all
/// reduce to the same sentence: *no second endpoint has ever existed at
/// runtime.*
///
/// T2a built the endpoint (a real Go server, a real WebRTC counterpart process,
/// a loopback control API) and closed no cell, saying so in its own header. This
/// file is what consumes it.
///
/// ## The two halves reach the app by two different rendezvous
///
/// Nearby is the local link: shipped iOS advertises and browses
/// `_relayium._tcp` and joins no room on any server, so the counterpart these
/// two cases name is a real Bonjour peer the launcher advertises on this
/// machine and nothing about the roster travels through the throwaway server.
/// Direct is a room on that server, minted by a second process, and is
/// unaffected by any of it.
///
/// ## What is real here, and what a reader should not over-read
///
/// Real: the server, the counterpart process, the Bonjour advertisement, the
/// WebRTC transport, the roster, the capability announcement, the `link/1`
/// establishment, the SAS, the file lane, the text lane, the writer, and every
/// control the assertions touch. The digests compared at the end are of bytes a
/// separate process wrote to disk.
///
/// Not real, and deliberately: the origin is loopback, the account lives on a
/// throwaway database, and the counterpart answers its own admission prompts
/// without a person — see `LinkCounterpart`, which states each of those as a
/// policy. None of them is on the app's side of a decision.
///
/// ## Skipping
///
/// Without a harness there is no second endpoint, so every test here skips. That
/// is what lets them sit in the same `RelayiumUITests` target the existing smoke
/// runs whole: `.github/workflows/macos.yml` keeps running
/// `-only-testing:RelayiumUITests` fast and offline, and a dedicated step runs
/// `scripts/ios-ui-session-acceptance.sh`, which starts the harness first. A
/// skip is visible in the result bundle; a test quietly deleted from a scheme is
/// not.
final class LocalSessionUITests: XCTestCase {

    // MARK: - the harness

    /// What the launcher passes through `TEST_RUNNER_*`.
    ///
    /// The environment rather than launch arguments, and the control bearer
    /// above all: argv on macOS is readable by every process this user runs, so
    /// a token on the `xcodebuild` command line would be published to the whole
    /// session for the length of a simulator boot. The origin is not a secret
    /// and does travel in argv — it has to, because
    /// `AppEnvironment.resolvedTransferBaseURL` reads `ProcessInfo.arguments`.
    private struct Harness {
        let origin: String
        let controlToken: String
        let nearbyPort: Int
        let peerName: String
        let pairPort: Int
    }

    private var app: XCUIApplication!

    /// Every assertion below names a rendered English string. Pin the language
    /// and locale rather than inherit whatever a runner's simulator was last
    /// left in — the same thing `AppShellUITests` and the macOS suite do.
    private let offlineLaunchArguments = [
        "--relayium-ui-testing", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
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
              let pair = value("PAIR_PORT").flatMap(Int.init)
        else {
            throw XCTSkip("""
                No local acceptance harness. These paths need a throwaway server \
                and a counterpart process; run them through \
                scripts/ios-ui-session-acceptance.sh.
                """)
        }
        return Harness(origin: origin, controlToken: token, nearbyPort: nearby,
                       peerName: name, pairPort: pair)
    }

    /// Stop at the first failure, as `AppShellUITests` does.
    ///
    /// It matters more here than there. Almost every assertion below is a
    /// `waitForExistence` or a poll with a real ceiling, so continuing past a
    /// failure does not produce more information — it produces one timeout after
    /// another, each waiting out its full budget against a screen that is
    /// already in the wrong state. The first run of this file spent minutes that
    /// way and buried the one assertion that had actually failed.
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// Launch pointed at the local server.
    ///
    /// `--relayium-transfer-origin` is the whole seam: it is `#if DEBUG`, it
    /// admits loopback origins only, and it is what makes
    /// `UITestMode.allowsResidency` true — so this launch, and only a launch
    /// like it, may become reachable at all. It buys both halves at once: the
    /// Direct room is on this server rather than the public hub, and the Nearby
    /// half gets the residency that starts the local advertisement and browse.
    private func launch(_ harness: Harness,
                        verifying: Bool,
                        extraArguments: [String] = []) {
        app = XCUIApplication()
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-transfer-origin", harness.origin]
            // Passed only HERE, beside the loopback origin that is its second
            // gate, and only by this file: the app resolves it through
            // `UITestMode.allowsSameHostLoopback`, which is
            // `--relayium-ui-testing` AND a loopback origin AND this argument.
            // Both endpoints of this acceptance are on one machine — XCUITest
            // drives one app and the counterpart is a process beside the
            // Simulator — so the route between them is a same-host route, which
            // the shipped transport prohibits and a shipped build cannot be
            // asked to permit. Every offline test in `LocalSessionUITests`'
            // sibling files passes no origin, so this cannot reach them.
            + [Self.sameHostLoopbackArgument]
            // **The verification preference, pinned per test.**
            //
            // `VerificationPreference` reads `UserDefaults`, which PERSISTS in
            // the simulator between launches — so a test that switched the
            // setting on through the shipped toggle left it on for every test
            // that ran afterwards, and the next one connected into a SAS gate it
            // was not expecting. That is exactly the failure this pinning
            // removes, and it was observed rather than anticipated.
            //
            // `-key value` is the `NSArgumentDomain` idiom already used two
            // lines above for `-AppleLanguages`. It reads through
            // `defaults.bool(forKey:)` unchanged, so the product code under test
            // is the shipped code and only the stored answer is chosen here.
            + ["-\(Self.verifyPeersDefaultsKey)", verifying ? "YES" : "NO"]
            + extraArguments
        app.launch()
    }

    /// `UITestMode.sameHostLoopbackArgument`, repeated because a UI test target
    /// links no product module.
    ///
    /// A rename cannot silently turn this into a no-op: the app would take the
    /// shipped prohibition, no link would establish on this host, and both
    /// Nearby cases below would fail rather than pass vacuously.
    private static let sameHostLoopbackArgument = "--relayium-ui-testing-same-host-loopback"

    /// `VerificationPreference.defaultsKey`, repeated because a UI test target
    /// links no product module.
    ///
    /// A rename cannot silently turn the SAS assertions here into no-ops,
    /// because both callers READ THE SETTING BACK off the shipped toggle before
    /// relying on it: the roster test asserts it renders off, the transfer test
    /// asserts it renders on. A key this no longer matches makes the argument
    /// inert, the toggle shows the stored default instead, and one of those two
    /// assertions fails immediately — which is a better pin than a source-text
    /// guard, because it checks the value the product actually resolved.
    private static let verifyPeersDefaultsKey = "com.relayium.verifyPeers"

    /// The shipped toggle's own label, which is also how these tests read the
    /// resolved preference back.
    private static let verifyToggleLabel =
        "Compare verification codes with the other device"

    // MARK: - the counterpart's control API

    /// One synchronous request to the counterpart, from inside the test.
    ///
    /// The simulator shares this machine's network stack, so `127.0.0.1` here is
    /// the same loopback the launcher bound. Synchronous because every caller is
    /// a polling assertion that has nothing else to do, and an `expectation` per
    /// probe would bury the thing being asserted.
    @discardableResult
    private func control(_ port: Int, _ method: String, _ path: String,
                         file: StaticString = #filePath,
                         line: UInt = #line) -> [String: Any]? {
        guard let harness = try? requireHarness(),
              let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue("Bearer \(harness.controlToken)", forHTTPHeaderField: "Authorization")
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

    /// Which link the counterpart is on right now, read before this test's app
    /// has had a chance to start one.
    ///
    /// **Every assertion about the counterpart is relative to this.** One
    /// resident counterpart serves every test in the run, and its facts are
    /// per-link; without a baseline, "has a SAS arrived" is answered by the
    /// PREVIOUS test's digits and a test that established nothing passes. That
    /// is not hypothetical — it is what the second run of this file did.
    private func counterpartEpoch(_ harness: Harness) -> Int {
        (control(harness.nearbyPort, "GET", "/observed")?["epoch"] as? Int) ?? 0
    }

    /// Wait until the counterpart holds no link, before asking it for one.
    ///
    /// **A precondition, not a retry.** `LinkWorkspaceModel` serves one link at
    /// a time; a request that arrives while it is still winding down an earlier
    /// one is answered `busy`, and the asking side sits out the router's bound
    /// and reports "The other device didn't answer." Each test here launches a
    /// fresh app against ONE long-lived counterpart, so the previous test's link
    /// may still be closing when the next one taps Connect. The cell this
    /// supports says "with `--role nearby-receiver` resident", and a counterpart
    /// still holding the last app's link is not yet that.
    ///
    /// **It is deliberately NOT what fixed the repeated-link failure**, and the
    /// distinction cost a full diagnosis. Runs in which a Nearby path failed with
    /// ten or eleven claimed-and-abandoned link epochs were read as "the
    /// counterpart had not returned to idle" — but the retained logs show an
    /// `idle` between every one of those epochs, and one run failed on its FIRST
    /// link with no earlier link to wind down at all. The cause was
    /// `LinkAdmission` refusing the answer to this side's own request; see
    /// `testTheAnswerToThisSidesOwnRequestIsNotRefusedByAClosedSurfaceGate`.
    /// This wait remains because it is a cheap, honest precondition, not because
    /// it repaired anything.
    ///
    /// Bounded, and loud when it expires: a counterpart that never returns to
    /// idle is a real failure and must not be waited out silently.
    private func awaitIdleCounterpart(_ harness: Harness,
                                      file: StaticString = #filePath,
                                      line: UInt = #line) {
        awaitCounterpart(harness.nearbyPort, timeout: 60,
                         describing: "returned to idle before this test connected",
                         satisfied: { facts in
                             (facts["linkPhase"] as? String) == "idle"
                         },
                         file: file, line: line)
    }

    /// The peer ids the counterpart's own roster already holds, read BEFORE
    /// this test's app has advertised anything.
    ///
    /// A baseline for the same reason `counterpartEpoch` is one: one
    /// counterpart serves the whole run and a shared build agent may hold
    /// another run's peer on the same link, so "has it discovered a device"
    /// answered against a roster that was never empty is not an answer.
    private func counterpartRoster(_ harness: Harness) -> Set<String> {
        let roster = control(harness.nearbyPort, "GET", "/observed")?["roster"]
            as? [[String: Any]]
        return Set((roster ?? []).compactMap { $0["id"] as? String })
    }

    /// Wait until the counterpart can answer, not merely until this app can ask.
    ///
    /// Local-link discovery is symmetric and its two halves complete at
    /// different times: this app lists a peer that was already advertising
    /// almost at once, while the counterpart has to be told about a service the
    /// Simulator registers afterwards. `LocalPeerSignalingChannel` holds an
    /// inbound offer from a device it has not discovered for five seconds and
    /// then drops it, so an app that taps Connect as soon as its own roster
    /// fills reaches a counterpart that is still blind — the app reports a
    /// failed connection and the counterpart reports no link at all.
    ///
    /// Nothing here makes discovery happen; the app is still found on its own
    /// merits. `supportsLink` is required as well as presence, so what is waited
    /// for is a real capability announcement rather than a name appearing.
    /// Bounded, and loud when it expires.
    private func awaitCounterpartDiscovery(_ harness: Harness,
                                           notIn known: Set<String>,
                                           file: StaticString = #filePath,
                                           line: UInt = #line) {
        awaitCounterpart(harness.nearbyPort, timeout: 150,
                         describing: "discovered this app on the link and credited "
                                   + "it with link/1",
                         satisfied: { facts in
                             let roster = facts["roster"] as? [[String: Any]] ?? []
                             return roster.contains { entry in
                                 guard let id = entry["id"] as? String,
                                       !known.contains(id) else { return false }
                                 return entry["supportsLink"] as? Bool == true
                             }
                         },
                         file: file, line: line)
    }

    /// Poll the counterpart's live view until `satisfied`, or fail saying what
    /// it last held.
    ///
    /// **The failure message is the point.** A run that stalls has to say which
    /// side stalled and in what state — the alternative is a bare timeout
    /// attributed to whichever assertion happened to be first, which is exactly
    /// how a deterministic ICE fault once presented as "Nearby hangs for
    /// minutes".
    @discardableResult
    private func awaitCounterpart(_ port: Int,
                                  timeout: TimeInterval = 120,
                                  describing what: String,
                                  satisfied: ([String: Any]) -> Bool,
                                  file: StaticString = #filePath,
                                  line: UInt = #line) -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        var last: [String: Any]?
        while Date() < deadline {
            if let facts = control(port, "GET", "/observed") {
                last = facts
                if satisfied(facts) { return facts }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTFail("""
            the counterpart never \(what) within \(Int(timeout))s.
            last observed: \(last.map { String(describing: $0) } ?? "<no answer>")
            """, file: file, line: line)
        return nil
    }

    // MARK: - shared UI helpers

    private func scrollUntilHittable(_ element: XCUIElement, maxSwipes: Int = 6) {
        for _ in 0..<maxSwipes where !element.isHittable { app.swipeUp() }
        for _ in 0..<4 where !element.isHittable { drag(fraction: 0.22) }
        for _ in 0..<6 where !element.isHittable { drag(fraction: -0.22) }
        // **`isHittable` is not "a tap lands" under the top chrome on iOS 26.**
        // A control scrolled up under the status-bar/navigation-bar band still
        // hit-tests as hittable there, but the synthesized touch is consumed by
        // system chrome and never reaches it: the roster tap in the Nearby link
        // acceptance died exactly this way at (201, 56) on iOS 26.5 while the
        // same coordinates worked on iOS 18.5. So being hittable is necessary
        // but no longer sufficient — also drag the content back down until the
        // element clears the navigation bar. At the top of the scroll view this
        // only rubber-bands, so the loop is safe when there is nowhere lower.
        let bar = app.navigationBars.firstMatch
        let chromeFloor = bar.exists ? bar.frame.maxY : 0
        for _ in 0..<6 where element.frame.minY < chromeFloor { drag(fraction: -0.22) }
        XCTAssertTrue(element.isHittable, "\(element) never became reachable")
    }

    private func drag(fraction: CGFloat) {
        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let target = app.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5 - fraction))
        middle.press(forDuration: 0.05, thenDragTo: target)
    }

    // Navigation is `AppShellNavigation`'s, shared with the rest of the target.
    // This file used to carry its own copy of the helper, addressing tabs by
    // their rendered English labels — a second list of the same literals that
    // kept compiling after the shell changed underneath it. One driver, one list
    // of destinations, and it works on the sidebar shell this suite may be run
    // on as well.

    /// The roster row for the counterpart.
    ///
    /// Matched on the peer's own announced NAME, which carries the run tag.
    /// Bonjour has no per-run room to hide behind — every peer advertising
    /// `_relayium._tcp` on this link is a candidate, including another run's on
    /// a shared build agent — so a row matched by position would tap whichever
    /// device the browser happened to report first.
    private func rosterRow(_ harness: Harness) -> XCUIElement {
        app.buttons.containing(
            NSPredicate(format: "label CONTAINS %@", harness.peerName)).firstMatch
    }

    /// Wait for the link to produce the counterpart, and assert the roster is
    /// describing it rather than still describing an empty one.
    ///
    /// The launcher has already established that the peer is advertising before
    /// a simulator was booted, so a failure here is the APP's side of discovery
    /// — the browser, the advertisement parse, the capability credit or the
    /// roster render — and not a harness that never came up.
    private func awaitRoster(_ harness: Harness) -> XCUIElement {
        let row = rosterRow(harness)
        XCTAssertTrue(row.waitForExistence(timeout: 90), """
            the Nearby roster never named the resident counterpart "\(harness.peerName)".
            \(app.debugDescription)
            """)
        XCTAssertTrue(app.otherElements["Nearby devices"].waitForExistence(timeout: 10),
                      "the roster rendered rows outside its own accessibility container")
        XCTAssertFalse(
            app.staticTexts[
                "No other devices yet. Open the Relayium app on the other device, connected to this same network, and leave it open."
            ].exists,
            "the roster names a device and still tells the user there are none")
        return row
    }

    // MARK: - Nearby, 创建/加入

    /// The roster names a real second endpoint, and Connect establishes a link.
    ///
    /// This is the whole of the `Nearby → 创建/加入` cell. Every earlier iOS run
    /// could assert only that an empty roster explained itself.
    func testNearbyRosterNamesThePeerAndConnects() throws {
        let harness = try requireHarness()
        awaitIdleCounterpart(harness)
        let baseline = counterpartEpoch(harness)
        let knownPeers = counterpartRoster(harness)
        // Verification OFF, which is the shipped default: this cell is about the
        // roster and the join, and the SAS boundary is the other test's subject.
        // Pinned rather than inherited, because the preference persists in the
        // simulator across launches and this test may run after one that wanted
        // it on.
        launch(harness, verifying: false)

        open(Shell.lanTransfer, in: app)

        let verify = app.switches[Self.verifyToggleLabel]
        XCTAssertTrue(verify.waitForExistence(timeout: 20),
                      "Nearby offers no verification setting")
        XCTAssertEqual(verify.value as? String, "0", """
            this launch asked for no verification and the app resolved it on, so \
            Connect would stop at a SAS this path does not answer
            """)

        // The listener really did start. A loopback launch takes the ordinary
        // residency arm; the paused arm is what every offline test sees, and
        // asserting its absence is what would catch `allowsResidency` silently
        // reverting to false.
        XCTAssertFalse(app.staticTexts["Nearby receiving: paused"].exists,
                       "a loopback acceptance launch paused its listener")

        // Before the roster is touched, not between reading it and tapping
        // it: this wait is tens of seconds, and holding an expanded row open
        // across it exposes Connect to every roster repaint in that window.
        awaitCounterpartDiscovery(harness, notIn: knownPeers)

        let row = awaitRoster(harness)
        scrollUntilHittable(row)
        row.tap()

        // A `link/1` peer offers exactly one verb. Its presence is the assertion
        // that the capability announcement crossed the link and was believed —
        // on this transport the peer's TXT record IS that announcement — and a
        // legacy peer would render Send and "Start a message session" instead.
        let connect = app.buttons["Connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 15),
                      "the roster row offered no unified Connect for a link/1 peer")
        scrollUntilHittable(connect)
        connect.tap()

        // Established, observed from BOTH ends. The app's own workspace is
        // rendering, and the separate process reports a SAS — which it can only
        // have if a transport really completed its handshake with this app.
        XCTAssertTrue(app.staticTexts["Conversation"].waitForExistence(timeout: 90), """
            Connect did not produce a live link workspace.
            \(app.debugDescription)
            """)
        awaitCounterpart(harness.nearbyPort,
                         describing: "reported an open link of its own") { facts in
            (facts["epoch"] as? Int ?? 0) > baseline
                && (facts["sas"] as? String)?.isEmpty == false
        }
    }

    // MARK: - Nearby, 完成后下一步

    /// A staged file and a typed message cross a verified link, and Done leaves
    /// a clean roster behind.
    ///
    /// The verification toggle is switched on through the app's OWN shipped
    /// control rather than through a launch argument. `VerificationPreference`
    /// defaults to off, so without this the SAS boundary — the one gate that
    /// holds an armed batch back until a human answers — would never appear and
    /// the path would evidence the weaker of the two shapes the product ships.
    func testNearbyLinkTransfersThenDoneReturnsToACleanRoster() throws {
        let harness = try requireHarness()
        awaitIdleCounterpart(harness)
        let baseline = counterpartEpoch(harness)
        let knownPeers = counterpartRoster(harness)
        launch(harness, verifying: true,
               extraArguments: ["--relayium-ui-testing-preselect-direct-fixture"])

        open(Shell.lanTransfer, in: app)

        // The preference this launch pinned, read back off the shipped control.
        // Also the pin on `verifyPeersDefaultsKey`: a key the product no longer
        // reads makes the launch argument inert and this reads "0".
        let verify = app.switches[Self.verifyToggleLabel]
        XCTAssertTrue(verify.waitForExistence(timeout: 15),
                      "Nearby offers no verification setting")
        scrollUntilHittable(verify)
        XCTAssertEqual(verify.value as? String, "1", """
            this launch asked for verification and the app resolved it off, so \
            the SAS boundary below would never appear
            """)

        // Stage the batch BEFORE connecting, which is the shape the copy under
        // Connect promises: the files travel with the connection and are
        // released once the digits are compared. This transfer acceptance uses
        // the Debug-only preselection seam and waits for its production-model
        // result. The two AppShellUITests dedicated to the picker still drive
        // the real system browser, security scope and expansion. Repeating that
        // external presentation here made a transport gate fail when Files did
        // not present, before any transport behavior ran.
        XCTAssertTrue(app.descendants(matching: .any)["pendingFile.0"]
            .waitForExistence(timeout: 20),
                      "the preselected fixture never became a pending Nearby send")

        // Before the roster is touched, for the reason the roster case records.
        awaitCounterpartDiscovery(harness, notIn: knownPeers)

        let row = awaitRoster(harness)
        scrollUntilHittable(row)
        row.tap()

        XCTAssertTrue(app.staticTexts[
            "The files you chose will be sent on this connection once you have compared the code."
        ].waitForExistence(timeout: 15),
                      "a staged batch is not named as travelling with the connection")

        let connect = app.buttons["Connect"]
        scrollUntilHittable(connect)
        connect.tap()

        // The one verification boundary for the whole link.
        XCTAssertTrue(app.staticTexts["Compare this code"].waitForExistence(timeout: 90), """
            the verified link never presented digits to compare.
            \(app.debugDescription)
            """)
        // The digits the app is showing are the digits the OTHER PROCESS
        // derived. Two independent handshakes producing one string is the
        // evidence a matching set of file digests does not carry: it says both
        // ends hold the same key, rather than that one wrote what the other
        // sent.
        let peerFacts = awaitCounterpart(
            harness.nearbyPort,
            describing: "derived a SAS for a link of its own") { facts in
                (facts["epoch"] as? Int ?? 0) > baseline
                    && (facts["sas"] as? String)?.isEmpty == false
            }
        let peerSAS = try XCTUnwrap(peerFacts?["sas"] as? String)
        // **Spoken, not written.** `PairingCodeText` renders the digits as one
        // string but labels the element `spokenCode` — each digit separated by a
        // space — so VoiceOver reads "5 9 0 3 9 7" rather than the number five
        // hundred ninety thousand. Accessibility labels are what XCUITest
        // matches on, so asserting the written form finds nothing even when the
        // right digits are on screen, which is exactly what the first run of
        // this assertion did.
        let spoken = peerSAS.map(String.init).joined(separator: " ")
        XCTAssertTrue(app.staticTexts[spoken].exists, """
            the app is showing different digits from the counterpart's \
            "\(peerSAS)" (expected the spoken form "\(spoken)").
            \(app.debugDescription)
            """)

        let matches = app.buttons["They match"]
        XCTAssertTrue(matches.waitForExistence(timeout: 10))
        scrollUntilHittable(matches)
        matches.tap()

        // The armed batch is released by the confirmation and nothing else.
        // Addressed by the transfer list's own accessibility container rather
        // than by its heading: the heading is the word "Files", which several
        // unrelated surfaces also render, and a negative assertion on it later
        // would be answered by whichever one happened to be on screen.
        let transfers = app.otherElements["Files on this connection"]
        XCTAssertTrue(transfers.waitForExistence(timeout: 30),
                      "confirming the digits did not release the staged batch")

        // Now a message, over the same link, with no second connection and no
        // second set of digits — which is the claim the workspace makes.
        let composer = app.textFields["Message"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20),
                      "the live link offers no composer")
        scrollUntilHittable(composer)
        composer.tap()
        let body = "T2b-\(harness.peerName)"
        composer.typeText(body)
        // NOT `app.buttons["Send"]`, for the reason `AppShellUITests` already
        // records: the tab bar carries a Send TAB with the same label, and it is
        // the one that matches first. It sits at the bottom of the screen, so
        // with the keyboard raised by the line above it is never hittable and no
        // amount of scrolling makes it so — this test spent its whole budget
        // dragging the workspace against a tab it was never trying to press.
        // The composer's own Send is inside the workspace's `ScrollView`
        // (`NearbyView.swift`), which the tab bar is not, so the scroll view is
        // the discriminator rather than a label or a position.
        let send = app.scrollViews.buttons["Send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 15),
                      "the live link's composer offers no way to send")
        scrollUntilHittable(send)
        send.tap()

        // Both halves, read back off the separate process. The digest is the
        // point: a receipt of names and sizes passes for a receiver that wrote
        // the right number of zero bytes into a file of the right length.
        let received = awaitCounterpart(
            harness.nearbyPort, timeout: 180,
            describing: "received the staged file and the message") { facts in
                guard (facts["epoch"] as? Int ?? 0) > baseline else { return false }
                let files = facts["files"] as? [[String: Any]] ?? []
                let messages = facts["messages"] as? [String] ?? []
                return !files.isEmpty && messages.contains(body)
            }
        let files = try XCTUnwrap(received?["files"] as? [[String: Any]])
        let receipt = try XCTUnwrap(files.first)
        XCTAssertEqual(receipt["name"] as? String, "Relayium product brief.txt",
                       "the counterpart wrote a different name than was staged")
        XCTAssertEqual(receipt["size"] as? Int, 1_536,
                       "the counterpart wrote a different number of bytes")
        // `UITestMode.stagePendingFixture` writes exactly 1,536 bytes of 0x52,
        // so the digest is a constant rather than something read back from the
        // sending side — which is what makes this a comparison and not an echo.
        XCTAssertEqual(receipt["sha256"] as? String,
                       "1d71499ab7454d9955704333e6fddbded53e45217087bfdbaf529436765cfcfc",
                       "the bytes that arrived are not the bytes that were staged")

        // The app's own record of what it just did.
        XCTAssertTrue(transfers.exists, "the workspace kept no record of the transfer")

        // ── 完成后下一步 ────────────────────────────────────────────────────
        //
        // The two exits the workspace offers, and what each leaves behind.
        let leave = app.buttons["End connection"]
        XCTAssertTrue(leave.waitForExistence(timeout: 15),
                      "a live link offers no way out")
        scrollUntilHittable(leave)
        leave.tap()

        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), """
            ending the connection did not produce its terminal Done.
            \(app.debugDescription)
            """)
        scrollUntilHittable(done)
        done.tap()

        // Back to the roster, with nothing of the finished session left on it.
        // The counterpart is still resident, so the roster must name it again —
        // an assertion that "we are back" cannot be satisfied by a screen that
        // merely lost its workspace.
        XCTAssertTrue(rosterRow(harness).waitForExistence(timeout: 60), """
            Done did not return to a working roster.
            \(app.debugDescription)
            """)
        XCTAssertFalse(app.otherElements["Conversation"].exists,
                       "Done left the finished conversation on the roster screen")
        XCTAssertFalse(app.otherElements["Files on this connection"].exists,
                       "Done left the finished transfer list on the roster screen")
        XCTAssertFalse(app.textFields["Message"].exists,
                       "Done left the link composer on the roster screen")
        XCTAssertFalse(app.buttons["They match"].exists,
                       "Done left a verification prompt from the finished link")
    }

    // MARK: - Direct (pairing), 创建/加入 and 完成后下一步

    /// The app joins a code another process minted on the local server, and
    /// drives it to a completed transfer.
    ///
    /// A REAL join, which is the distinction the cell turns on: every earlier
    /// run could assert only that Join became enabled. The code is minted here
    /// rather than by the launcher because a pairing code is short-lived and
    /// single-use, and one minted before a simulator boot would be spent on
    /// waiting.
    ///
    /// **What the sender reaching `done` proves.** `PairSenderRun` finishes on
    /// its own model reaching `.completed`, and a SENDING model reaches that
    /// only on the receiver's `CTRL_COMPLETE` — which the receiving side emits
    /// after its writer finished and the batch verified. So the peer's `done`,
    /// carrying per-file SHA-256 digests of the bytes it read, is the far side's
    /// confirmation that this app wrote and verified exactly those files.
    func testDirectJoinsAMintedCodeAndCompletes() throws {
        let harness = try requireHarness()
        // The shipped default. iOS announces no `link/1` in a pairing room, so
        // this half is the legacy wire either way; pinning it keeps the run
        // independent of whichever test happened to go first.
        launch(harness, verifying: false)

        control(harness.pairPort, "POST", "/start")
        var code = ""
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline, code.isEmpty {
            let status = control(harness.pairPort, "GET", "/status")
            if (status?["phase"] as? String) == "failed" {
                return XCTFail("the minting peer failed: \(String(describing: status))")
            }
            code = (status?["code"] as? String) ?? ""
            if code.isEmpty { Thread.sleep(forTimeInterval: 0.3) }
        }
        XCTAssertFalse(code.isEmpty, "the counterpart never minted a pairing code")

        open(Shell.crossNetworkTransfer, in: app)

        let field = app.textFields["Code"]
        XCTAssertTrue(field.waitForExistence(timeout: 15),
                      "Direct offers no code field to join with")
        scrollUntilHittable(field)
        field.tap()
        field.typeText(code)

        let join = app.buttons["Join"]
        XCTAssertTrue(join.waitForExistence(timeout: 10))
        scrollUntilHittable(join)
        XCTAssertTrue(join.isEnabled, "a complete pairing code did not enable Join")
        join.tap()

        // The far side's own confirmation that this app wrote and verified the
        // batch. Polled on `/status` rather than `/observed`: this half is the
        // LEGACY wire — iOS announces no `link/1` in a pairing room, because
        // `LINK_PAIRING_ROOM_SUPPORT` is false there — so the peer's live link
        // view is empty by design and `done` is the honest terminal signal.
        var sent: [String: Any]?
        let transferDeadline = Date().addingTimeInterval(180)
        while Date() < transferDeadline {
            let status = control(harness.pairPort, "GET", "/status")
            let phase = status?["phase"] as? String
            if phase == "failed" {
                return XCTFail("the sending peer failed: \(String(describing: status))")
            }
            if phase == "done" {
                sent = control(harness.pairPort, "GET", "/result")
                break
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        let receipts = try XCTUnwrap(
            sent?["files"] as? [[String: Any]],
            "the pairing transfer never completed: \(String(describing: sent))")
        XCTAssertFalse(receipts.isEmpty, "the peer reported a completed send of nothing")

        // The app agrees, on screen, about every file the peer says it handed
        // over. A terminal state alone would pass for a session that completed
        // having written nothing the user can see.
        for receipt in receipts {
            let name = try XCTUnwrap(receipt["name"] as? String)
            let shown = app.descendants(matching: .any)
                .containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
            XCTAssertTrue(shown.waitForExistence(timeout: 60), """
                the completed Direct session does not name "\(name)", which the \
                peer reported sending.
                \(app.debugDescription)
                """)
        }

        // 完成后下一步: the terminal state offers its exit, and taking it
        // returns to the controls a new session starts from.
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), """
            the completed Direct session offers no next step.
            \(app.debugDescription)
            """)
        scrollUntilHittable(done)
        done.tap()

        XCTAssertTrue(app.textFields["Code"].waitForExistence(timeout: 30), """
            Done did not return to the Direct start controls.
            \(app.debugDescription)
            """)
        XCTAssertTrue(app.buttons["Join"].exists,
                      "the start controls returned without their own action")
        XCTAssertFalse(done.exists,
                       "Done left the finished session's own control on screen")

        // **Not asserted: that the Code field is empty.** It is not — this run
        // observed the spent code still in it — and that is worth recording
        // rather than either fixing here or passing over. It is CONSISTENT:
        // neither `RealtimeSessionModel.cancel()` (the file path's Done) nor
        // `RealtimeTextSessionModel.reset()` (the text path's) clears
        // `joinCode`, so both surfaces behave the same way. A pairing code is
        // single-use and short-lived, so re-tapping Join with it would fail —
        // but whether the field should clear is a product decision about the
        // start controls, not something this cell turns on, and changing shared
        // model behaviour to satisfy an assertion nobody asked for would be the
        // wrong way to find that out. Recorded for disposition instead.
    }
}
