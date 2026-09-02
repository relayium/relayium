import XCTest

/// The vocabulary and the primitives the two-physical-device roles share.
///
/// `DevicePairUITests` holds the roles themselves; everything here is the part
/// that has to be identical on both devices — the run description, the launch,
/// how a roster row may be chosen, how a six-digit value is read off a screen,
/// and the bounded line format the launcher parses.
///
/// ## What this launch is, and what it deliberately is not
///
/// A physical run passes **no `--relayium-transfer-origin` and no
/// `--relayium-ui-testing`**. Both omissions are load-bearing and
/// `DevicePairSeamTests` pins them in source:
///
///  - `--relayium-transfer-origin` admits loopback only. `127.0.0.1` on an
///    iPhone is that iPhone, so pointing a device at it would prove nothing, and
///    widening the seam to a LAN address is exactly the weakening
///    `TransferOriginSeamTests` exists to prevent;
///  - `--relayium-ui-testing` sets `UITestMode.isActive`, and
///    `UITestMode.allowsResidency` is `isActive && isLoopbackTransferOrigin`. On
///    a production origin that composition is FALSE, so `RelayiumApp` takes its
///    `residency.pause()` arm and the device never joins the room. A run that
///    passed it would be proving that nothing arrives.
///
/// So the transport, the origin, the room, the roster, the announcement, the
/// handshake, the SAS, both lanes, the writer and the keychain are all the
/// shipped ones. Three Debug-only arguments remain, every one of them `#if
/// DEBUG` in `UITestMode` and absent from Release along with its parser:
///
///  1. `--relayium-ui-testing-preselect-direct-fixture` — hands the app-scoped
///     `DirectSendSelection` the exact `.success([url])` the `fileImporter`
///     callback would have produced, for a deterministic 1,536-byte file. It
///     replaces the system document browser and nothing else: the security
///     scope, the expansion, the limits, the pending row, the arming, the wire
///     and the receiving writer are all production;
///  2. `--relayium-ui-testing-fresh-received-folder` — empties this app's own
///     `Received` folder before it resolves. iOS has no folder picker for a
///     download, so the destination is fixed and the product REFUSES a name
///     already taken; without this a second run of the same phase would fail on
///     a file the first run legitimately kept;
///  3. the `NSArgumentDomain` pin on `com.relayium.verifyPeers`, which is the
///     shipped `UserDefaults` key `VerificationPreference` reads. No product
///     code changes; only the stored answer is chosen.

// MARK: - the run this process was launched for

struct DevicePairRun {
    /// The launcher's per-run tag. Every message this run puts on the wire
    /// carries it, so a device that is somehow talking to an unrelated Relayium
    /// on the same address is a failed assertion rather than a passing one.
    let tag: String
    /// Which half of the flow this runner drives, echoed on every emitted line.
    let role: String
    /// The name the OTHER device announces itself in the room under.
    ///
    /// Derived by the launcher from the two resolved device records rather than
    /// guessed here. It is a label and never an identity; see `awaitPeerRow`,
    /// which refuses an ambiguous roster instead of picking.
    let peerName: String
    /// Whether `peerName` distinguishes the peer from this device AT ALL.
    ///
    /// Decided by the launcher, so the suite never infers it, and it changes
    /// exactly one thing: whether a name match is evidence about which device a
    /// row is. See `DevicePairRosterChoice`.
    let peerNaming: DevicePairPeerNaming
    /// The exact text this runner sends, unique to the run, the flow and the
    /// role. The far end asserts this string and no other, which is what makes
    /// "the intended peer" an assertion rather than a hope.
    let message: String
    /// The exact text this runner must RECEIVE, which is the other role's
    /// `message`.
    ///
    /// Both halves are named by the launcher and both are asserted, because a
    /// conversation is bidirectional and asserting only the outbound half would
    /// leave one of its two directions unevidenced by a suite that had a live
    /// link in hand.
    let peerMessage: String?
    /// The digits the generating runner minted, for a joining role only.
    let pairingCode: String?
    /// Whether a receiving role must LEAVE this device's `Received` folder as it
    /// found it.
    ///
    /// The launcher's `--keep-received`, threaded rather than assumed. iOS has a
    /// FIXED download destination and the product refuses a name already taken,
    /// so a receiving role normally starts from the empty folder a fresh install
    /// has. An operator who needs a device's received files to survive can say
    /// so — and the run then fails honestly on the second execution of a phase
    /// rather than quietly deleting something to keep itself green.
    let keepsReceivedFolder: Bool

    /// How long a role may wait for the other device to reach the same point.
    ///
    /// One budget rather than a constant per wait: the thing being waited for is
    /// always "the other runner got here too", and that is bounded by a device
    /// install plus a launch plus a shell navigation. Overridable so a slow
    /// device does not need a code change, and bounded on both sides so a typo
    /// cannot turn a run into an unbounded hang.
    let peerBudget: TimeInterval
}

/// **A run that was described to this process incoherently.**
///
/// Distinct from the `XCTSkip` a MISSING description produces, and the
/// difference is the whole reason it exists: no description at all means "this
/// process is not part of a two-device run", which is the ordinary case when the
/// fast offline smoke runs this target whole. A description that is present and
/// contradictory means the launcher and the suite disagree, which is a harness
/// defect and must be a failure — a skip would retire the very roles a physical
/// run was started to drive, and report green.
struct DevicePairRunError: Error, CustomStringConvertible {
    let description: String
}

extension XCTestCase {

    /// The run this process was launched for, or a skip.
    ///
    /// Skips rather than fails for the reason `LocalSessionUITests` does: these
    /// tests live in the same `RelayiumUITests` target the fast offline smoke
    /// runs whole, and a skip is visible in the result bundle where a test
    /// deleted from a scheme is not.
    func requireDevicePairRun() throws -> DevicePairRun {
        let environment = ProcessInfo.processInfo.environment
        func value(_ name: String) -> String? {
            let raw = environment["RELAYIUM_DEVICE_PAIR_\(name)"]
            return (raw?.isEmpty == false) ? raw : nil
        }
        guard let tag = value("TAG"), let role = value("ROLE"),
              let peer = value("PEER_NAME"), let message = value("MESSAGE")
        else {
            throw XCTSkip("""
                No two-device acceptance run. These paths need a second physical \
                device driving the other half of the same session; run them \
                through scripts/ios-device-pair-acceptance.sh.
                """)
        }
        let budget = value("PEER_BUDGET_SECONDS").flatMap(TimeInterval.init) ?? 300
        // A value that is PRESENT and unrecognised is a launcher and a suite
        // that disagree about how selection works, and it fails loudly rather
        // than falling back: the fallback is the mode that consults the family
        // name, and a typo would silently restore a check that, for a same-name
        // pair, cannot distinguish the peer from a stranger.
        let mode = value("PEER_NAME_MODE") ?? DevicePairPeerNaming.distinct.rawValue
        guard let naming = DevicePairPeerNaming(rawValue: mode) else {
            throw DevicePairRunError(description: """
                RELAYIUM_DEVICE_PAIR_PEER_NAME_MODE is "\(mode)", which is neither \
                "\(DevicePairPeerNaming.distinct.rawValue)" nor \
                "\(DevicePairPeerNaming.shared.rawValue)". The launcher and this suite \
                disagree about how the roster row may be selected, and guessing either way \
                would either refuse a valid same-name pair or apply a name check that \
                cannot distinguish the peer from a stranger.
                """)
        }
        return DevicePairRun(tag: tag, role: role, peerName: peer, peerNaming: naming,
                             message: message,
                             peerMessage: value("PEER_MESSAGE"),
                             pairingCode: value("PAIRING_CODE"),
                             keepsReceivedFolder: value("KEEP_RECEIVED") == "1",
                             peerBudget: min(max(budget, 30), 1_800))
    }

    /// Only the role this process was launched as. A runner asked for one half
    /// must not silently drive the other.
    func requireDevicePairRun(role expected: String) throws -> DevicePairRun {
        let run = try requireDevicePairRun()
        guard run.role == expected else {
            throw XCTSkip("this runner was launched as \(run.role), not \(expected)")
        }
        return run
    }

    // MARK: - the launch

    /// The shipped configuration, plus the three Debug-only arguments this
    /// harness owns. See this file's header for why the other two acceptance
    /// arguments are absent and must stay absent.
    func launchForDevicePair(_ app: XCUIApplication,
                             verifying: Bool,
                             stagingFixture: Bool = false,
                             freshReceivedFolder: Bool = false) {
        app.launchArguments =
            // Pinned for the same reason every other suite pins it: every
            // assertion below names a rendered English string, and a device left
            // in another language would fail on copy rather than on behaviour.
            ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            // `VerificationPreference` reads `UserDefaults`, which persists on a
            // physical device even more durably than in a simulator. Pinned per
            // role so a run cannot inherit the previous one's answer and meet a
            // SAS gate it is not driving — or, worse, miss one it is.
            + ["-\(DevicePair.verifyPeersDefaultsKey)", verifying ? "YES" : "NO"]
            + (stagingFixture ? [DevicePair.preselectDirectFixtureArgument] : [])
            + (freshReceivedFolder ? [DevicePair.freshReceivedFolderArgument] : [])
        app.launch()
    }

    // MARK: - the shell

    /// Open one of the two destinations this harness drives.
    ///
    /// Addressed by `IOSSurface.rawValue`, never by rendered copy: since 0.3.0
    /// `RootView` draws a five-item tab bar in compact width and a sidebar/detail
    /// split in regular width, and both shells stamp the same stable identifier
    /// on their rows (`tab-<id>` and `sidebar-<id>`). A full-width iPad in the
    /// three-device fleet therefore navigates the sidebar, a compact iPhone the
    /// tab bar, and neither depends on which visible label a locale or copy
    /// change happens to render. Both shells are waited on together, so a
    /// regular-width launch does not spend the whole tab-bar timeout before
    /// finding its sidebar. A run that reaches neither shell says so with the
    /// full hierarchy rather than proceeding on a screen it did not identify —
    /// that diagnostic is load-bearing on a physical fleet, where the failure
    /// artefact is often all the run leaves behind.
    @discardableResult
    func openDevicePairDestination(_ surface: Shell.Surface,
                                   in app: XCUIApplication,
                                   file: StaticString = #filePath,
                                   line: UInt = #line) -> Bool {
        let bar = app.tabBars.firstMatch
        let tab = bar.buttons["tab-\(surface.id)"].firstMatch
        // iOS 18 stamps a `tabItem` Label's identifier onto the SELECTED tab's
        // button only, and the fleet runs iOS 18 devices — so an identifier
        // that never appears must not spend the whole deadline. Position in
        // `Shell.browseable` is the product's own pinned tab order, the
        // identifier is still preferred within each pass, and the navigation
        // title below accepts nothing short of the destination itself.
        let tabByOrder = Shell.browseable.firstIndex { $0.id == surface.id }
            .map { bar.buttons.element(boundBy: $0) }
        let sidebarRow = app.descendants(matching: .any)["sidebar-\(surface.id)"].firstMatch
        let sidebarToggle = app.buttons["ToggleSidebar"].firstMatch
        var opened = false
        // A physical device can take far longer than a simulator to draw its
        // first shell, so the two shells share one generous deadline.
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !opened {
            if tab.exists {
                tab.tap()
                opened = true
            } else if let tabByOrder, tabByOrder.exists {
                tabByOrder.tap()
                opened = true
            } else if sidebarRow.exists {
                sidebarRow.tap()
                opened = true
            } else if sidebarToggle.exists {
                // iPadOS 18 launches the portrait split view with its sidebar
                // collapsed: no row is on screen and the system "Show Sidebar"
                // toggle is the only way in. One tap brings the identified rows
                // out, and the next pass of the loop taps the row itself. The
                // compact shell never draws this toggle, and the tab bar is
                // checked first, so this cannot misdrive an iPhone.
                sidebarToggle.tap()
                _ = sidebarRow.waitForExistence(timeout: 5)
            } else {
                _ = tab.waitForExistence(timeout: 0.5)
            }
        }
        guard opened else {
            XCTFail("""
                no shell control identified "\(surface.id)" in either the tab \
                bar or the sidebar.
                \(app.debugDescription)
                """, file: file, line: line)
            return false
        }
        guard app.navigationBars[surface.title].waitForExistence(timeout: 20) else {
            XCTFail("""
                \(surface.id) was selected but its "\(surface.title)" screen \
                did not render.
                \(app.debugDescription)
                """, file: file, line: line)
            return false
        }
        return true
    }

    /// Bring an element within reach without assuming which way the screen is
    /// scrolled. Nearby is the longest screen in the app and a control can be
    /// below the fold on one device and above it on another.
    func scrollUntilHittable(_ element: XCUIElement,
                             in app: XCUIApplication,
                             file: StaticString = #filePath,
                             line: UInt = #line) {
        for _ in 0..<6 where !element.isHittable { app.swipeUp() }
        for _ in 0..<4 where !element.isHittable { drag(app, fraction: 0.22) }
        for _ in 0..<8 where !element.isHittable { drag(app, fraction: -0.22) }
        XCTAssertTrue(element.isHittable,
                      "\(element) never became reachable", file: file, line: line)
    }

    private func drag(_ app: XCUIApplication, fraction: CGFloat) {
        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let target = app.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5 - fraction))
        middle.press(forDuration: 0.05, thenDragTo: target)
    }

    // MARK: - the roster, and refusing to guess which row is the peer

    /// The two scopes `DevicePairRosterChoice` decides between, snapshotted once.
    ///
    /// Snapshotted rather than re-read: every property read off an element is
    /// another accessibility-hierarchy fetch, and a rule that re-read `label`
    /// while it decided would be judging a roster that may have changed between
    /// its own clauses.
    func rosterCandidates(_ run: DevicePairRun, in app: XCUIApplication)
        -> (contained: [DevicePairRosterCandidate], named: [DevicePairRosterCandidate])
    {
        func snapshot(_ query: XCUIElementQuery) -> [DevicePairRosterCandidate] {
            query.allElementsBoundByIndex.map {
                DevicePairRosterCandidate(label: $0.label, isEnabled: $0.isEnabled)
            }
        }
        let container = app.otherElements[DevicePair.rosterContainerLabel]
        let contained = container.exists ? snapshot(container.buttons) : []
        // `containing` HERE, and `matching` everywhere else in this file. The
        // difference is deliberate: a roster row is a SwiftUI `Button` whose
        // announced name is carried by a `Text` descendant, so the row is found
        // by what it contains — which is the form `LocalSessionUITests` has
        // driven against a real second endpoint. Every other query in this file
        // READS the matched element's own label, and `containing` would hand it
        // an enclosing group's combined string instead.
        let named = snapshot(app.buttons.containing(
            NSPredicate(format: "label CONTAINS %@", run.peerName)))
        return (contained, named)
    }

    /// The one roster row this runner may tap, or a failure that says why not.
    ///
    /// Polls until the room produces exactly one selectable candidate or the
    /// budget expires. An AMBIGUOUS roster is terminal immediately rather than
    /// waited out: a third device in the room does not leave because a harness
    /// waits, and continuing would mean tapping a device this run cannot justify.
    func awaitPeerRow(_ run: DevicePairRun,
                      in app: XCUIApplication,
                      file: StaticString = #filePath,
                      line: UInt = #line) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(run.peerBudget)
        var last = DevicePairRosterChoice.empty
        while Date() < deadline {
            let (contained, named) = rosterCandidates(run, in: app)
            let choice = DevicePairRosterChoice.decide(naming: run.peerNaming,
                                                       contained: contained,
                                                       named: named,
                                                       peerName: run.peerName)
            last = choice
            switch choice {
            case .takeContained:
                return app.otherElements[DevicePair.rosterContainerLabel]
                    .buttons.element(boundBy: 0)
            case .takeNamed:
                return app.buttons.containing(
                    NSPredicate(format: "label CONTAINS %@", run.peerName)).firstMatch
            case let .ambiguous(contained, named):
                XCTFail("""
                    the Nearby room holds more than one selectable device \
                    (container scope saw \(contained), name scope saw \(named)). \
                    This run will not choose between them: take every other device \
                    off this address, or run the pair somewhere it is alone.
                    \(app.debugDescription)
                    """, file: file, line: line)
                return nil
            case let .notSelectable(label):
                XCTFail("""
                    the one roster row ("\(label)") cannot be selected. A session \
                    is already running on this device, or the roster is locked.
                    \(app.debugDescription)
                    """, file: file, line: line)
                return nil
            case .notTheIntendedPeer, .empty:
                // Both are legitimately transient: the room fills over seconds,
                // and a stranger's row can precede the peer's. Keep waiting.
                break
            }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTFail("""
            the Nearby roster never produced exactly one selectable device \
            announcing "\(run.peerName)" within \(Int(run.peerBudget))s. \
            Last decision: \(last).
            \(app.debugDescription)
            """, file: file, line: line)
        return nil
    }

    // MARK: - reading a six-digit value off a screen

    /// **The digits an element is actually labelled with.**
    ///
    /// `PairingCodeText` renders the six digits as one string but labels the
    /// element with `spokenCode` — each digit separated by a space — so
    /// VoiceOver reads "5 9 0 3 9 7" rather than the number five hundred ninety
    /// thousand. Accessibility labels are what XCUITest matches on, so a query
    /// for the written form finds nothing even when the right digits are on
    /// screen.
    ///
    /// Exactly one match is required. Both a pairing code and a SAS are rendered
    /// through the same view, and a screen holding two of them is a screen this
    /// harness has misidentified — reading either would be a guess.
    func awaitSpokenDigits(in app: XCUIApplication,
                           within budget: TimeInterval,
                           describing what: String,
                           file: StaticString = #filePath,
                           line: UInt = #line) -> String? {
        // `matching`, never `containing`: `containing` returns the ANCESTORS of
        // an element whose descendant matches, so the label read below would be
        // some enclosing group's combined string — which for a code grid inside
        // a card is a sentence with other numbers in it.
        let query = app.staticTexts.matching(
            NSPredicate(format: "label MATCHES %@", DevicePair.spokenDigitsPattern))
        let deadline = Date().addingTimeInterval(budget)
        var seen = 0
        while Date() < deadline {
            let matches = query.allElementsBoundByIndex
            seen = matches.count
            if seen == 1 {
                let spoken = matches[0].label
                let digits = spoken.filter { $0.isNumber }
                guard digits.count == DevicePair.digitCount else {
                    XCTFail("""
                        \(what) rendered "\(spoken)", which is not \
                        \(DevicePair.digitCount) digits.
                        """, file: file, line: line)
                    return nil
                }
                return String(digits)
            }
            if seen > 1 {
                XCTFail("""
                    \(what): \(seen) six-digit values are on screen at once, so \
                    reading one of them would be a guess. Labels: \
                    \(matches.map(\.label)).
                    \(app.debugDescription)
                    """, file: file, line: line)
                return nil
            }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTFail("""
            \(what) never appeared within \(Int(budget))s.
            \(app.debugDescription)
            """, file: file, line: line)
        return nil
    }

    /// **The same six digits, when the product renders them as prose rather
    /// than as a code grid.**
    ///
    /// `DirectTextSessionView` shows the responder's short-authentication string
    /// through `text.verifiedPhrase` — "Verified phrase: %@" — which is an
    /// ordinary `Text`, so its accessibility label is the whole sentence with
    /// the digits inline and `L10n.token`'s bidi isolates around them. A query
    /// for the spoken grid finds nothing there even though the right digits are
    /// on screen.
    ///
    /// The digits are filtered out of the label rather than parsed with an
    /// index, and exactly `digitCount` of them are required: a sentence that
    /// acquired a second number would produce a value neither device derived.
    func awaitDigitsInPhrase(prefixed prefix: String,
                             in app: XCUIApplication,
                             within budget: TimeInterval,
                             describing what: String,
                             file: StaticString = #filePath,
                             line: UInt = #line) -> String? {
        // `matching` for the same reason `awaitSpokenDigits` uses it: this
        // reads the element's OWN label and counts the digits in it.
        let element = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        guard element.waitForExistence(timeout: budget) else {
            XCTFail("""
                \(what) never appeared within \(Int(budget))s: nothing on screen \
                begins with "\(prefix)".
                \(app.debugDescription)
                """, file: file, line: line)
            return nil
        }
        let digits = element.label.filter(\.isNumber)
        guard digits.count == DevicePair.digitCount else {
            XCTFail("""
                \(what) rendered "\(element.label)", which carries \(digits.count) \
                digits rather than \(DevicePair.digitCount).
                """, file: file, line: line)
            return nil
        }
        return String(digits)
    }

    /// Wait for any element whose label contains `text`, and say what was on
    /// screen instead when it does not arrive.
    @discardableResult
    func awaitLabel(containing text: String,
                    in app: XCUIApplication,
                    within budget: TimeInterval,
                    describing what: String,
                    file: StaticString = #filePath,
                    line: UInt = #line) -> Bool {
        let element = app.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        guard element.waitForExistence(timeout: budget) else {
            XCTFail("""
                \(what): nothing on screen carries "\(text)" after \(Int(budget))s.
                \(app.debugDescription)
                """, file: file, line: line)
            return false
        }
        return true
    }

    // MARK: - staying alive while the launcher reads this device's container

    /// **Hold the state the product reached until the launcher has read the
    /// received bytes off this device — then let the run finish through the
    /// shipped exit.**
    ///
    /// ## Why a receiving role may not simply finish
    ///
    /// The launcher's byte check is the one receiver claim no UI can make, and
    /// it used to be taken after BOTH `xcodebuild` processes had exited. That
    /// read cannot distinguish three different worlds: bytes that were never
    /// written, bytes a container read cannot reach once the automation session
    /// has ended, and bytes the product itself removed on the way out. Those
    /// need different people to fix them, so the run must not report them the
    /// same way.
    ///
    /// So a receiving role publishes RECEIVED and then stops here, with its app
    /// still running and still on the screen that named the file. The launcher
    /// reads and hashes the container WHILE that is true, and only then releases
    /// this runner to press the product's own Done. The check that used to be
    /// the only one is still taken afterwards, so the difference between "on
    /// disk while the app was alive" and "on disk after the app was dismissed"
    /// becomes an observation this harness makes rather than a question it
    /// leaves open.
    ///
    /// ## How the release arrives, and why the ceiling is not a weakening
    ///
    /// Nothing in this harness normally travels Mac → device: the run's facts
    /// are launch environment and the channel is this process's stdout. So the
    /// launcher writes one file, carrying this run's tag, into THIS TEST
    /// RUNNER's own container — the only container this process can read, and
    /// deliberately not the app-under-test's, whose contents are the thing being
    /// proved. `scripts/lib/device_pair_channel.py` composes the name for both
    /// ends.
    ///
    /// The wait is bounded and expiring it is NOT a failure, for the same reason
    /// `holdRoomUntilPeerLeaves` is not: every claim this role owns has already
    /// been made, the byte checks live in the launcher and are unchanged either
    /// way, and a run that turned "the release did not arrive" into a red test
    /// would be reporting a slow handshake as a product defect. What the ceiling
    /// costs is time; what it cannot do is make a missing or wrong file pass.
    func holdForContainerRead(_ run: DevicePairRun,
                              in app: XCUIApplication,
                              showing terminal: String,
                              file: StaticString = #filePath,
                              line: UInt = #line) {
        // Composed from the same bounded tokens the channel admits, and refused
        // rather than sanitised: a tag or role outside that set means this
        // process and the launcher disagree about what a run is called, and a
        // path built out of it is not something a test should be repairing.
        guard DevicePairChannel.isEmittable(run.tag),
              DevicePairChannel.isEmittable(run.role) else {
            XCTFail("""
                this run's tag or role is outside the bounded set the channel admits, so \
                the launcher's release cannot be named.
                """, file: file, line: line)
            return
        }
        guard let documents = FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask).first else {
            XCTFail("this test runner has no Documents directory to be released through",
                    file: file, line: line)
            return
        }
        // Created rather than assumed. A stub automation app's container has a
        // `Documents` by convention, not by contract, and the launcher's write
        // lands INSIDE it — so a container that happened not to have one would
        // turn every release into a failed copy and every receiving role into a
        // full-ceiling hold. Cheap, idempotent, and inside this runner's own
        // sandbox.
        try? FileManager.default.createDirectory(at: documents,
                                                 withIntermediateDirectories: true)
        let release = documents.appendingPathComponent(
            DevicePair.releaseFileName(tag: run.tag, role: run.role))

        let deadline = Date().addingTimeInterval(run.peerBudget)
        var released = false
        while Date() < deadline {
            // The tag is required in the CONTENT as well as in the name. A
            // runner container outlives one run, and a release is the thing
            // that ends a hold — so it is matched exactly as strictly as the
            // launcher matches a published line.
            if let data = try? Data(contentsOf: release),
               String(decoding: data, as: UTF8.self)
                   .trimmingCharacters(in: .whitespacesAndNewlines) == run.tag {
                released = true
                // Removed once consumed, so a container that survives this run
                // does not accumulate one file per phase per run.
                try? FileManager.default.removeItem(at: release)
                break
            }
            Thread.sleep(forTimeInterval: 1)
        }

        // What the hold was FOR, asserted rather than assumed. If the app died
        // or left its completion screen while the launcher was reading, the read
        // was not taken against the state this run claims it was.
        XCTAssertEqual(app.state, .runningForeground, """
            the receiving app was no longer running in the foreground when the launcher's \
            read of its container finished, so that read is not evidence about the state \
            this device reached.
            """, file: file, line: line)
        awaitLabel(containing: terminal, in: app, within: DevicePair.settleBudget,
                   describing: "the completion this device held while its container was read",
                   file: file, line: line)

        print("""
            \(DevicePairChannel.marker) note: \(run.role) held its completed state \
            \(released ? "until the launcher released it"
                       : "for its full \(Int(run.peerBudget))s ceiling; no release arrived").
            """)
    }

    // MARK: - publishing one fact to the launcher

    /// One bounded line on stdout, which `scripts/lib/device_pair_channel.py`
    /// reads back out of this runner's `xcodebuild` log.
    ///
    /// `print` rather than an attachment or a file: an attachment lives inside a
    /// result bundle the launcher would have to open with another tool, and this
    /// value is needed WHILE the runner is still on screen waiting.
    func emitDevicePair(_ event: DevicePairChannel.Event,
                        value: String,
                        for run: DevicePairRun,
                        file: StaticString = #filePath,
                        line: UInt = #line) {
        guard DevicePairChannel.isEmittable(value) else {
            XCTFail("""
                refusing to publish \(event.rawValue) = "\(value)": it is outside \
                the bounded set this channel admits, and the launcher would either \
                refuse it or — worse — hand part of it to another process.
                """, file: file, line: line)
            return
        }
        print(DevicePairChannel.line(tag: run.tag, role: run.role,
                                     event: event, value: value))
    }
}

// MARK: - the shared vocabulary

/// Every literal both roles depend on, in one place.
///
/// A UI-test target links no product module, so these are repeated rather than
/// imported. Each one is either read back off a shipped control before it is
/// relied on, or is a constant the product cannot change without a visible
/// failure here — see the individual notes.
enum DevicePair {

    /// The bundle whose container the launcher reads a received file out of.
    static let bundleID = "com.relayium.app"

    /// `VerificationPreference.defaultsKey`.
    ///
    /// A rename cannot silently turn the SAS assertions into no-ops, because
    /// every caller READS THE SETTING BACK off the shipped toggle before relying
    /// on it. A key the product no longer reads makes the launch argument inert,
    /// the toggle then shows the stored default, and that read-back fails.
    static let verifyPeersDefaultsKey = "com.relayium.verifyPeers"

    /// The shipped toggle's own label, which is also how a role reads the
    /// resolved preference back.
    static let verifyToggleLabel = "Compare verification codes with the other device"

    /// `UITestMode.preselectDirectFixtureArgument` and
    /// `UITestMode.freshReceivedFolderArgument`. Both are `#if DEBUG`.
    static let preselectDirectFixtureArgument =
        "--relayium-ui-testing-preselect-direct-fixture"
    static let freshReceivedFolderArgument =
        "--relayium-ui-testing-fresh-received-folder"

    /// **The file the launcher writes into THIS TEST RUNNER's own container to
    /// release a receiving role that is holding its completed state.**
    ///
    /// `RELEASE_PREFIX` in `scripts/lib/device_pair_channel.py`, which is where
    /// the launcher composes the same name — repeated here rather than imported
    /// for the same reason the marker is, and pinned against the launcher's copy
    /// by `DevicePairSeamTests`. A name the two ends disagreed about would leave
    /// every receiving role holding to its ceiling while the launcher reported
    /// that it had released it: slower on every run, and silent.
    ///
    /// The run tag is in the name, so a release left behind by an earlier run
    /// cannot open this run's hold; see `holdForContainerRead`, which also
    /// requires the tag in the file's contents.
    static let releaseFilePrefix = "relayium-device-pair-release"

    static func releaseFileName(tag: String, role: String) -> String {
        "\(releaseFilePrefix)-\(tag)-\(role)"
    }

    /// `UITestMode.pendingFixtureName` and the exact length it writes.
    ///
    /// The digest is of 1,536 bytes of `0x52` and is a CONSTANT here rather than
    /// something read back off the sending device — which is what makes the
    /// launcher's comparison a comparison and not an echo.
    static let fixtureName = "Relayium product brief.txt"
    static let fixtureByteCount = 1_536

    // MARK: - the shell

    /// The two destinations this harness drives, shared with the simulator
    /// suites: `Shell.Surface` carries the stable `IOSSurface.rawValue` both
    /// shells stamp on their rows and the navigation title that proves the
    /// destination rendered, so the physical harness cannot drift from the
    /// shell the product actually draws.
    static let nearbySurface = Shell.lanTransfer
    static let directSurface = Shell.crossNetworkTransfer

    // MARK: - Nearby

    /// `nearby.a11yDevices`. The container `NearbyView.roster` draws every device
    /// row inside, and which `actions(for:)` is rendered OUTSIDE.
    static let rosterContainerLabel = "Nearby devices"
    /// `nearby.status.paused`. Asserted ABSENT on a physical launch: a device
    /// that paused its listener is a device that is not in the room, and the run
    /// would go on to prove that nothing arrives.
    static let pausedStatus = "Nearby receiving: paused"
    /// `nearby.status.off`, likewise.
    static let offStatus = "Nearby receiving: off"
    /// `nearby.status.ready` — the card title once the room socket is JOINED
    /// and nothing is running on it.
    ///
    /// This, and not the absence of the two above, is what the resident waits
    /// for before it publishes READY. "Not paused and not off" is also true of
    /// `nearby.status.joining…`, so a barrier built on the absences would open
    /// the connector's gate while the resident was still reaching the room —
    /// which is the same failure as no barrier at all, one step later.
    static let readyStatus = "Nearby receiving: ready"
    /// `nearby.emptyRoster`.
    static let emptyRosterCopy =
        "No other devices yet. Open relayium.com on the other device and leave the page open."

    // MARK: - the unified link workspace, which only Nearby reaches on iOS

    /// `link.connectToDevice`. Its presence for a selected row is itself the
    /// assertion that the peer's `link/1` announcement crossed the room and was
    /// believed: a legacy peer would render Send and "Start a message session".
    static let connectLabel = "Connect"
    /// `link.connectCarriesStagedFiles`.
    static let stagedTravelsNote =
        "The files you chose will be sent on this connection once you have compared the code."
    /// `link.verifyTitle`, `link.verifyMatches`.
    static let verifyTitle = "Compare this code"
    static let verifyMatchesLabel = "They match"
    /// `link.a11yConversation` and `link.a11yTransfers`, the two containers the
    /// workspace labels. Addressed by container rather than by heading because
    /// the transfers heading is the bare word "Files", which several unrelated
    /// surfaces also render.
    static let conversationLabel = "Conversation"
    static let transfersLabel = "Files on this connection"
    /// `link.composerLabel`, `link.send`, `link.acceptFiles`.
    static let composerLabel = "Message"
    static let sendLabel = "Send"
    static let acceptFilesLabel = "Accept files"
    /// `link.batchReceived` and `link.batchFinished` — the two terminal batch
    /// states, one per direction.
    static let batchSavedLabel = "Saved"
    static let batchFinishedLabel = "Done"
    /// `link.leaveConnection`, then `common.done`.
    static let endConnectionLabel = "End connection"
    static let doneLabel = "Done"

    // MARK: - the pairing-code (legacy lane) surface

    /// `direct.createCode`, `direct.giveCode`, `common.join`, `common.code`.
    ///
    /// iOS composes NO pairing-code link — `LINK_PAIRING_ROOM_SUPPORT` is false
    /// off macOS — so a code here establishes the legacy lane and its own
    /// session view, not the workspace above. That is the whole reason this
    /// vocabulary is separate from the link one.
    static let createCodeLabel = "Create a code"
    static let giveCodeHeading = "Give this code to the other device"
    static let joinLabel = "Join"
    static let codeFieldLabel = "Code"
    static let filesModeLabel = "Files"
    static let textModeLabel = "Text"
    /// `gate.createCodeTitle`. Minting a code costs an account and joining one
    /// does not, so a device that cannot mint renders this instead of Create.
    /// The generating role SKIPS with the manual step quoted rather than timing
    /// out on a button nobody drew.
    static let createCodeGateTitle = "Creating a code needs an account"
    /// `session.checkMatches`, `session.theyMatch` — the legacy lane's own
    /// verification gate, which is NOT the workspace's.
    static let legacyVerifyTitle = "Check this matches"
    static let legacyMatchesLabel = "They match"
    /// `text.startHeading`, `text.createCode`, `text.giveCode`.
    static let textStartHeading = "Start a text session"
    static let textCreateCodeLabel = "Create a text code"
    static let textGiveCodeHeading = "Give this text code to the other device"
    /// `text.checkMatches` — the text lane's gate heading, on the INITIATING
    /// side. The responder reaches `text.incomingHeading` instead and renders
    /// its digits as prose; see `verifiedPhrasePrefix`.
    static let textVerifyTitle = "Check this matches the other device"
    static let textIncomingHeading = "The other device wants to exchange text"
    /// `text.verifiedPhrase`, up to its placeholder. The responder's SAS is
    /// inside this sentence rather than in a code grid.
    static let verifiedPhrasePrefix = "Verified phrase:"
    /// `common.accept` — the responder's own gate, reached only with advanced
    /// verification on.
    static let acceptLabel = "Accept"
    /// `text.sessionHeading`, `text.composerLabel`, `common.endSession`.
    static let textSessionHeading = "Private text session"
    static let textComposerLabel = "Message"
    static let endSessionLabel = "End session"
    /// `file.transfer` completion titles, from
    /// `FileTransferCompletionPresentation`.
    static let filesSentTitle = "Files sent"
    static let filesReceivedTitle = "Files received"

    // MARK: - shapes and budgets

    /// Six digits, spoken. `sas()` formats `%06u` and `signal.CodeLen` is 6, so
    /// both values this harness reads are exactly this shape.
    static let digitCount = 6
    static let spokenDigitsPattern = "[0-9]( [0-9]){5}"

    /// How long one device may wait for a transport step that involves the other
    /// one. Separate from `peerBudget`, which bounds waiting for the other
    /// RUNNER to reach a screen; these bound the product's own work once both
    /// are there.
    static let establishBudget: TimeInterval = 120
    static let verificationBudget: TimeInterval = 90
    static let transferBudget: TimeInterval = 180
    static let settleBudget: TimeInterval = 30
}

// MARK: - the channel

/// The bounded line format, defined here and again in
/// `scripts/lib/device_pair_channel.py`, with neither side trusting the other.
enum DevicePairChannel {

    static let marker = "RELAYIUM-DEVICE-PAIR"

    enum Event: String {
        /// This runner's app is up, on the screen its role starts from, and
        /// ready for the other device to be started. The start barrier.
        case ready = "READY"
        /// The six digits this device minted. Read by the launcher WHILE this
        /// runner is still waiting, and handed to the joining runner.
        case pairingCode = "PAIRING-CODE"
        /// The short-authentication string THIS device derived from its OWN
        /// handshake. The launcher requires the two equal; neither runner can
        /// see the other's.
        case sas = "SAS"
        /// This runner's app reported a committed inbound batch. The launcher
        /// pulls the bytes off this device afterwards and hashes them.
        case received = "RECEIVED"
        /// This runner has finished every assertion it owns and is deliberately
        /// staying present for its peer. The end barrier.
        case holding = "HOLDING"
    }

    /// The same set `VALUE` admits in the parser. A value outside it is refused
    /// at the point of emission rather than at the point of parse, so a runner
    /// cannot put something on the launcher's stdout that the launcher would
    /// then have to decide about.
    static func isEmittable(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 64 else { return false }
        return value.allSatisfy {
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-")
        }
    }

    static func line(tag: String, role: String, event: Event, value: String) -> String {
        "\(marker) \(tag) \(role) \(event.rawValue) \(value)"
    }
}
