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
                         body: [String: Any]? = nil,
                         file: StaticString = #filePath,
                         line: UInt = #line) -> [String: Any]? {
        guard let harness = try? requireHarness(),
              let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        if let body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
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

    /// Take the discard confirmation a workspace exit raises, by IDENTIFIER.
    ///
    /// **The label is ambiguous by design, and the last match is not the
    /// dialog.** The confirmation's destructive button carries the same title as
    /// the control that raised it — Leave's dialog says "End connection", Done's
    /// says "Done" — so `buttons.matching(label == …)` returns both the dialog's
    /// button and the workspace control underneath it. Both sites here took the
    /// LAST index on the belief that the topmost element sorts last. It does
    /// not: the 2026-09-18 local Cross-network run selected the obscured
    /// `link-leave-session` beneath the sheet and failed
    /// `LocalSessionUITests.swift:922` with "Failed to … not hittable". That is
    /// the query's ordering, not the product — the dialog was up, and the title
    /// assertion one line above had already proved it.
    ///
    /// `link-discard-local-text-confirm` is the shipped identifier on the
    /// dialog's own destructive button (`NearbyLinkWorkspaceView`, and the same
    /// identifier on macOS `TransferLinkPane`), and the workspace control
    /// underneath carries `link-leave-session` instead — so the identifier picks
    /// the sheet rather than the thing it covers, which is the whole repair.
    ///
    /// **`.firstMatch`, because the identifier is not unique — it is NESTED.**
    /// The 2026-09-18 `a6f50064` run proved the identifier forwards through
    /// `.confirmationDialog` and then found two elements carrying it:
    ///
    /// ```text
    /// Sheet, label: 'Discard local text?'
    ///   … ↳Button, identifier: 'link-discard-local-text-confirm', label: 'End connection'
    ///        ↳Button, identifier: 'link-discard-local-text-confirm', label: 'End connection'
    /// ```
    ///
    /// UIKit gives the sheet's action a wrapper element and an inner one, both
    /// inheriting the identifier. `waitForExistence` was satisfied — a query
    /// with matches exists — and only the TAP failed, on "Find single matching
    /// element", at `LocalSessionUITests.swift:375`. So this is not an ambiguity
    /// between two different controls, as the label form was: both matches are
    /// the same button. `.firstMatch` takes the outer wrapper, which is the one
    /// laid out and hit-testable, and it is stable under the pair collapsing to
    /// one element on a future OS.
    ///
    /// A rename still cannot make this pass vacuously: neither element would be
    /// found and the wait below fails loudly.
    private func confirmLocalTextDiscard(file: StaticString = #filePath,
                                         line: UInt = #line) {
        let confirm = app.buttons
            .matching(identifier: "link-discard-local-text-confirm").firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), """
            the discard confirmation is up but carries no destructive button of \
            its own.
            \(app.debugDescription)
            """, file: file, line: line)
        confirm.tap()
    }

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

        // The released batch still says WHAT it is sending, not only that it is
        // sending one of something. The same identity row the staging section
        // showed before Connect, now inside the transfer list — the outbound
        // half of the receipt the Cross-network cell asserts inbound. The size
        // is left to that cell, which derives it from the counterpart; here the
        // fixture's name is the identity and the digest at the end of this test
        // is the byte evidence.
        let sending = transfers.descendants(matching: .any)["pendingFile.0"]
        XCTAssertTrue(sending.waitForExistence(timeout: 30), """
            the released batch is unnamed: the transfer list shows a count and \
            no file identity.
            \(app.debugDescription)
            """)
        XCTAssertTrue(sending.label.hasPrefix("Relayium product brief.txt,"), """
            the outbound row names "\(sending.label)" rather than the staged fixture.
            \(app.debugDescription)
            """)

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
        // A message was exchanged above, so leaving would destroy the only copy
        // of that conversation and the workspace asks first. The title is
        // asserted here — that the question WAS asked is the product claim — and
        // the answer is pressed by identifier; see `confirmLocalTextDiscard`.
        XCTAssertTrue(app.staticTexts["Discard local text?"].waitForExistence(timeout: 10),
                      "leaving a link that holds a conversation asked nothing")
        confirmLocalTextDiscard()

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

    /// **Cross-network against the composition a Mac ships: join a code minted
    /// by a `link/1` pairing host, and use the ONE workspace it opens.**
    ///
    /// This is the owner's 2026-09-17 report as a runtime path. iOS `0.3.2`
    /// announced only `text/1` in a pairing room; macOS `1.4.0` refuses such a
    /// peer and said the iPhone was "running an older version". The counterpart
    /// here is `pair-link` — `AppPairLinkHost`, the macOS Cross-network pane with
    /// the SwiftUI removed — so its verdict on this app is the Mac's verdict. It
    /// used to be `pair-sender`, the LEGACY pairing wire, which this build now
    /// refuses exactly as macOS does.
    ///
    /// What the counterpart reports is read off its production models:
    /// `hasSession` with no `legacyFallback` is that host saying this app spoke
    /// `link/1` in the code's room. Everything after that is the workspace the
    /// Nearby cell also drives — a batch offered, accepted and committed, and a
    /// message each way — over a connection that was opened with nothing chosen
    /// beforehand.
    func testCrossNetworkJoinsAMintedCodeAndOpensTheUnifiedWorkspace() throws {
        let harness = try requireHarness()
        // The shipped default, so the link opens without a comparison step and
        // the run does not depend on whichever test happened to go first.
        launch(harness, verifying: false)

        control(harness.pairPort, "POST", "/start", body: ["action": "create"])
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
        XCTAssertFalse(app.segmentedControls.firstMatch.exists,
                       "Cross-network asks for Files or Text before a connection exists")

        let field = app.textFields["Code"]
        XCTAssertTrue(field.waitForExistence(timeout: 15),
                      "Cross-network offers no code field to connect with")
        scrollUntilHittable(field)
        field.tap()
        field.typeText(code)

        let join = app.buttons["Connect"]
        XCTAssertTrue(join.waitForExistence(timeout: 10))
        scrollUntilHittable(join)
        XCTAssertTrue(join.isEnabled, "a complete pairing code did not enable Connect")
        join.tap()

        // The Mac-shaped counterpart's own answer about THIS app. A legacy
        // fallback here is the 0.3.2 defect, named by the host that saw it.
        let linked = awaitCounterpart(
            harness.pairPort, timeout: 120,
            describing: "opened a link/1 session with this app") { facts in
                if facts["legacyFallback"] != nil { return true }
                return (facts["hasSession"] as? Bool) == true
                    && ((facts["linkPhase"] as? String) ?? "").hasPrefix("open")
            }
        XCTAssertNil(linked?["legacyFallback"], """
            the pairing host fell back to the legacy wire, so this app did not announce \
            link/1 in the code's room: \(String(describing: linked?["legacyFallback"]))
            """)
        XCTAssertFalse(app.staticTexts[
            "The other device is running an older version that can't complete this transfer. It needs updating."
        ].exists, "this app refused an up-to-date link/1 peer as an older version")

        // One workspace, both lanes. The composer is the text lane's proof that
        // the screen is the link's and not a one-lane file session.
        let composer = app.textFields["Message"]
        XCTAssertTrue(composer.waitForExistence(timeout: 60), """
            a connected Cross-network peer did not open the unified workspace.
            \(app.debugDescription)
            """)

        // Inbound files: offered by the peer AFTER connecting, accepted here.
        let fileName = "cross-network-\(harness.peerName).txt"
        let contents = "relayium cross-network acceptance \(harness.peerName)"
        let driven = control(harness.pairPort, "POST", "/drive",
                             body: ["command": "files", "name": fileName, "contents": contents])
        XCTAssertEqual(driven?["ok"] as? Bool, true,
                       "the counterpart could not offer a batch: \(String(describing: driven))")
        // The size the SENDER says it enqueued, read back off its own answer
        // rather than recomputed here — so the assertion below compares the two
        // sides instead of comparing this test to itself.
        let offeredBytes = try XCTUnwrap(driven?["size"] as? Int,
                                         "the counterpart did not report the size it offered")

        // **Everything about this batch is asked of the transfer list itself.**
        //
        // The assertions this replaces were `app.descendants(matching: .any)
        // .containing(…)`, which is answered by every ANCESTOR of a match up to
        // and including the application element: it can say that a string is
        // somewhere on screen, never that it is on the row being accepted. That
        // matters twice here. "Saved" is the committed batch's state, but this
        // screen also permanently carries "Files you accept are saved to
        // Relayium's folder in the Files app.", so a whole-app match for the
        // word proves nothing about a transfer; and a file name found anywhere
        // would have been satisfied by a conversation bubble quoting it.
        //
        // `linkA11yTransfers` is the list's own accessibility container, the
        // same address the Nearby cell uses, and the hint above is outside it.
        let transfers = app.otherElements["Files on this connection"]
        XCTAssertTrue(transfers.waitForExistence(timeout: 60), """
            the peer's batch never reached this app as a transfer at all.
            \(app.debugDescription)
            """)

        // **Identity BEFORE consent.** Accept releases a write to this user's
        // disk; a row that says only "1 file" is not something a person can
        // agree to. Addressed by the file row's own identifier rather than by a
        // text match, because the row is one combined accessibility element and
        // a leaf query would depend on which element type SwiftUI happened to
        // synthesise for it.
        let offered = transfers.descendants(matching: .any)["pendingFile.0"]
        XCTAssertTrue(offered.waitForExistence(timeout: 60), """
            the offered batch is unnamed: the transfer list shows a count and no \
            file identity, so there is nothing to accept or refuse on.
            \(app.debugDescription)
            """)
        XCTAssertEqual(offered.label, "\(fileName), \(offeredBytes) B", """
            the offered row names a different file or a different size than the \
            counterpart enqueued.
            \(app.debugDescription)
            """)

        let accept = app.buttons["Accept files"]
        XCTAssertTrue(accept.waitForExistence(timeout: 60), """
            the peer's batch never reached this app as an offer.
            \(app.debugDescription)
            """)
        scrollUntilHittable(accept)
        accept.tap()

        // The SENDER's own verdict on the bytes, before this app is asked for
        // its. `outboundStates` is `LinkFileBatchState` read straight off the
        // counterpart's production file model, and `finished` there is the
        // driver reporting the whole manifest was taken — evidence that bytes
        // moved which no assertion on this app's screen can supply, because
        // this app is the receiving end and has no digest seam here.
        //
        // EVERY outbound batch, not merely one of them. One resident
        // counterpart serves the run, so `contains("finished")` could be
        // answered by an earlier batch while the one this test drove is still
        // moving — the same baseline mistake `counterpartEpoch` exists for.
        // `allSatisfy` also rejects a `failed` batch, which `contains` would
        // have read straight past.
        awaitCounterpart(
            harness.pairPort, timeout: 180,
            describing: "reported its outbound batch complete") { facts in
                let states = facts["outboundStates"] as? [String] ?? []
                return !states.isEmpty && states.allSatisfy { $0 == "finished" }
            }

        // **The receipt.** `link.batchReceived` — "Saved" — is the ONLY state
        // that carries committed URLs; `finished` on an inbound batch means the
        // driver claimed a commit this app has seen no proof of, so matching it
        // would be matching the weaker of the two. The row is one combined
        // element ("1 file, 57 B, Saved"), so this matches the element itself
        // inside the list rather than any ancestor that contains it.
        let committed = transfers.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Saved")).firstMatch
        XCTAssertTrue(committed.waitForExistence(timeout: 120), """
            the accepted batch never committed inside the transfer list.
            \(app.debugDescription)
            """)
        // And it still names what landed. A receipt that lost the identity at
        // the moment of commit is the failure this whole block exists for.
        let landed = transfers.descendants(matching: .any)["pendingFile.0"]
        XCTAssertTrue(landed.exists, """
            the committed batch does not name "\(fileName)".
            \(app.debugDescription)
            """)
        XCTAssertEqual(landed.label, "\(fileName), \(offeredBytes) B", """
            the committed row names a different file or a different size than \
            the counterpart sent.
            \(app.debugDescription)
            """)

        // Outbound message, over the same connection.
        scrollUntilHittable(composer)
        composer.tap()
        let body = "T2b-cross-\(harness.peerName)"
        composer.typeText(body)
        // The workspace's own Send, not the Send TAB — see the Nearby cell.
        let send = app.scrollViews.buttons["Send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 15),
                      "the live link's composer offers no way to send")
        scrollUntilHittable(send)
        send.tap()
        _ = awaitCounterpart(
            harness.pairPort, timeout: 120,
            describing: "received this app's message") { facts in
                (facts["messages"] as? [String] ?? []).contains(body)
            }

        // And one back, which is what makes it a conversation rather than a
        // delivery.
        let reply = "T2b-reply-\(harness.peerName)"
        control(harness.pairPort, "POST", "/drive", body: ["command": "message", "body": reply])
        let replied = app.descendants(matching: .any)
            .containing(NSPredicate(format: "label CONTAINS %@", reply)).firstMatch
        XCTAssertTrue(replied.waitForExistence(timeout: 60), """
            the peer's message never reached this app's conversation.
            \(app.debugDescription)
            """)

        // 完成后下一步: leaving asks first, because the conversation is stored
        // nowhere else; then Done returns to the connect controls with the spent
        // code retired.
        let leave = app.buttons["End connection"]
        XCTAssertTrue(leave.waitForExistence(timeout: 15), "a live link offers no way out")
        scrollUntilHittable(leave)
        leave.tap()
        XCTAssertTrue(app.staticTexts["Discard local text?"].waitForExistence(timeout: 10),
                      "leaving a link that holds a conversation asked nothing")
        confirmLocalTextDiscard()

        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), """
            ending the connection did not produce its terminal Done.
            \(app.debugDescription)
            """)
        scrollUntilHittable(done)
        done.tap()

        XCTAssertTrue(app.textFields["Code"].waitForExistence(timeout: 30), """
            Done did not return to the Cross-network connect controls.
            \(app.debugDescription)
            """)
        XCTAssertTrue(app.buttons["Connect"].exists,
                      "the connect controls returned without their own action")
        XCTAssertFalse(app.otherElements["Conversation"].exists,
                       "Done left the finished conversation on the connect screen")
        XCTAssertFalse(done.exists,
                       "Done left the finished session's own control on screen")
    }
}
