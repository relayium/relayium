import XCTest

/// How every test in this target reaches a destination, on either of the two
/// shells the app draws.
///
/// ## Why this file exists
///
/// Until 0.3.0 there was one shell and one way in: five tabs, addressed by their
/// rendered English labels, with the helper copy-pasted into two test classes
/// and a third list of literals in a third. The Device Inbox batch removed one
/// of those tabs — `storedReceive` is presented now, not browsed to — and added
/// another, and every one of those literals kept compiling. `build-for-testing`
/// was green. The suite then failed at runtime, waiting twenty seconds for a
/// `Receive` button that the product had deliberately stopped drawing.
///
/// That is the failure this file is shaped against, so it makes two changes:
///
///  1. **Destinations are addressed by identifier, not by copy.**
///     `IOSSurface.rawValue` is the same string on the tab bar, in the sidebar,
///     on the detail column, and in both shipped languages. A copy change can no
///     longer break navigation that has nothing to do with copy — and the tests
///     that are genuinely ABOUT copy (`testEveryShippedLanguageRendersItsOwnShell`)
///     still read labels, deliberately, because that is their subject.
///  2. **The five surfaces are written down once.** `Shell.browseable` is the
///     list; a sixth destination, or a fifth that goes away, is one edit here
///     rather than a hunt through three files for string literals.
///
/// ## The two shells
///
/// The app draws a tab bar in compact width and a `NavigationSplitView` in
/// regular width — an iPhone and a full-width iPad are two layouts of one app,
/// over one `IOSSurface.browseable` list. Neither is a special case here:
/// `open(_:)` resolves which shell is on screen and drives it, so an ordinary
/// test asserts product behaviour and never mentions the layout. The tests that
/// are ABOUT the layout are in `AdaptiveShellUITests`, which is where the
/// distinction belongs.
enum Shell {

    /// One browseable destination, as this target addresses it.
    struct Surface {
        /// `IOSSurface.rawValue`. The tab item, the sidebar row and the detail
        /// column are all built from it, so it is the stable half of this
        /// record: it survives a copy change, a language change, and the move
        /// between the two shells.
        let id: String
        /// The navigation bar title the destination's own screen renders.
        ///
        /// Load-bearing, and not redundant with the identifier. Tapping a row
        /// proves a row was tappable; a `TabView` handed a selection with no
        /// matching `.tag`, or a detail column that failed to build, both leave
        /// the row perfectly tappable and draw nothing. The title is the
        /// user-visible evidence that the DESTINATION rendered.
        let title: String
    }

    static let lanTransfer = Surface(id: "lanTransfer", title: "Nearby")
    static let crossNetworkTransfer = Surface(id: "crossNetworkTransfer", title: "Cross-network")
    static let storedSend = Surface(id: "storedSend", title: "Share a link")
    static let deviceInbox = Surface(id: "deviceInbox", title: "Device Inbox")
    static let account = Surface(id: "account", title: "Account")

    /// The five, in the order `IOSSurface.browseable` lists them.
    ///
    /// `IOSShellPlacementTests` pins that order against the product enum; this
    /// is the runtime counterpart, and the order matters to more than tidiness —
    /// `AdaptiveShellUITests` asserts the sidebar presents them in it, and the
    /// app launches on the first.
    static let browseable: [Surface] = [
        lanTransfer, crossNetworkTransfer, storedSend, deviceInbox, account,
    ]

    /// The one destination that is NOT in the list above.
    ///
    /// It is reached by being presented — a verified Universal Link, a
    /// stored-file row in Account, or the acceptance seam that starts a launch
    /// on it — never by browsing to it, which is why it has no identifier here.
    ///
    /// The screen's own `navigationTitle` is `nav.storedReceive`, the same name
    /// the shell uses for the surface. It was `upload`/`download.heading` until
    /// the destinations were renamed, and this literal is what the largest-text
    /// test resolves the presented sheet by.
    static let storedReceiveTitle = "Open a link"

    /// Which shell is drawn. Resolved from what actually rendered rather than
    /// from `UIDevice.userInterfaceIdiom`, because the app decides on the
    /// horizontal size class: an iPad in a narrow Split View draws the compact
    /// shell, and an idiom check would send this driver after a tab bar that is
    /// not there.
    enum Layout { case compact, regular }
}

extension XCTestCase {

    /// Wait for either shell to render, and say which one did.
    ///
    /// Both are waited on together rather than one after the other. Waiting on
    /// the tab bar first and falling back would spend the whole timeout on every
    /// iPad launch before doing anything useful, and would report "the tab bar
    /// did not render" for a perfectly correct sidebar.
    @discardableResult
    func waitForShell(_ app: XCUIApplication,
                      timeout: TimeInterval = 30,
                      file: StaticString = #filePath,
                      line: UInt = #line) -> Shell.Layout {
        let tabs = app.tabBars.firstMatch
        let sidebar = app.descendants(matching: .any)["sidebar"].firstMatch
        // iPadOS 18 launches the portrait split view with its sidebar
        // COLLAPSED: neither shell control renders, and the only on-screen
        // evidence of the regular layout is the system "ToggleSidebar" button
        // on the detail column's navigation bar. The compact shell is a
        // `TabView` and never draws that button, so its presence identifies the
        // regular shell as decisively as the sidebar itself — and the tab bar
        // is still checked first, so a compact shell can never be classified
        // regular by it.
        let toggle = app.buttons["ToggleSidebar"].firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if tabs.exists { return .compact }
            if sidebar.exists || toggle.exists { return .regular }
            _ = tabs.waitForExistence(timeout: 0.5)
        }
        XCTFail("neither the tab bar nor the sidebar rendered within \(timeout)s",
                file: file, line: line)
        return .compact
    }

    /// Bring the sidebar itself on screen, using the system toggle when the
    /// split view is showing only its detail column.
    ///
    /// iPadOS 18 starts a portrait `NavigationSplitView` with the sidebar
    /// collapsed, so a perfectly correct regular shell can have no `sidebar`
    /// element in the hierarchy at all — the first physical iPad 7 run found
    /// exactly that, with the system's "Show Sidebar" button as the only way
    /// in. An already-visible sidebar returns immediately, so calling this on a
    /// launch that expands the sidebar (or calling it twice) never toggles the
    /// sidebar closed.
    func revealSidebar(_ app: XCUIApplication,
                       timeout: TimeInterval = 10,
                       file: StaticString = #filePath,
                       line: UInt = #line) {
        let sidebar = app.descendants(matching: .any)["sidebar"].firstMatch
        // A short grace rather than a bare `exists`: an EXPANDING sidebar whose
        // toggle registered first would otherwise be mistaken for a collapsed
        // one, and the tap below would hide it. The toggle's label cannot
        // disambiguate — it is localized, and the language tests launch in
        // locales this target does not read.
        if sidebar.waitForExistence(timeout: 2) { return }
        let toggle = app.buttons["ToggleSidebar"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: timeout),
                      "the sidebar is off screen and the shell offers no system "
                      + "toggle to reveal it",
                      file: file, line: line)
        toggle.tap()
        XCTAssertTrue(sidebar.waitForExistence(timeout: timeout),
                      "tapping the system sidebar toggle did not reveal the sidebar",
                      file: file, line: line)
    }

    /// The compact shell's tab-bar button for a surface: by identifier when the
    /// OS exposes it, by the product's own tab order when it does not.
    ///
    /// iOS 18's UIKit-backed `TabView` stamps the identifier written inside a
    /// `tabItem` Label onto the tab bar button of the SELECTED tab only. The
    /// hosted iPhone 16 Pro (iOS 18.5) runs showed exactly that split:
    /// `tab-lanTransfer` — the launch tab — resolved in under a second while
    /// `tab-crossNetworkTransfer` never existed in ten; an iOS 26.5 launch
    /// stamps all five immediately. So the identifier stays the first choice,
    /// and the fallback is POSITION in `Shell.browseable` — which is the
    /// product's `IOSSurface.browseable` order, pinned by
    /// `IOSShellPlacementTests` and asserted by geometry on both shells — not
    /// rendered copy. A positional tap that somehow landed on the wrong tab
    /// still fails loudly, because `open(_:)` accepts nothing short of the
    /// destination's own navigation title.
    func compactTabRow(_ surface: Shell.Surface,
                       in app: XCUIApplication,
                       timeout: TimeInterval = 10) -> XCUIElement {
        let bar = app.tabBars.firstMatch
        let byIdentifier = bar.buttons["tab-\(surface.id)"].firstMatch
        let index = Shell.browseable.firstIndex { $0.id == surface.id }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            // The identifier is checked first in every pass, so it wins
            // whenever the OS exposes it; the positional button is the same
            // physical control either way, because both derive from the one
            // browseable order.
            if byIdentifier.exists { return byIdentifier }
            if let index, bar.buttons.count > index {
                return bar.buttons.element(boundBy: index)
            }
            _ = byIdentifier.waitForExistence(timeout: 0.5)
        }
        return byIdentifier
    }

    /// Open a destination on whichever shell is drawn, and prove the destination
    /// itself rendered.
    ///
    /// The row is addressed by identifier and the arrival is asserted on the
    /// screen's own navigation title — the two halves of the runtime failure
    /// this helper replaces. Returns the row, for the tests that go on to assert
    /// something about it.
    @discardableResult
    func open(_ surface: Shell.Surface,
              in app: XCUIApplication,
              file: StaticString = #filePath,
              line: UInt = #line) -> XCUIElement {
        let layout = waitForShell(app, file: file, line: line)
        let row: XCUIElement
        switch layout {
        case .compact:
            row = compactTabRow(surface, in: app)
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the tab bar has no \(surface.id) destination", file: file, line: line)
        case .regular:
            // A collapsed split view has tappable rows only once the sidebar is
            // on screen; when it already is, this is a no-op.
            revealSidebar(app, file: file, line: line)
            row = app.descendants(matching: .any)["sidebar-\(surface.id)"].firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the sidebar has no \(surface.id) destination", file: file, line: line)
        }
        // nil unless this is a Debug build whose launch carries BOTH
        // `--relayium-ui-testing` and the trace flag — the app's own gate — and
        // then nothing below differs from a plain tap-and-wait. When it is not
        // nil, the before-tap record spends real time querying and capturing
        // before the tap, so an instrumented run is not timing-identical to an
        // ordinary one: a pass with the trace on does not show the original
        // failure is fixed.
        let diagnostics = NavigationDiagnostics(requested: surface, row: row, in: app)
        diagnostics?.record(.beforeTap)
        row.tap()
        // SwiftUI may replace the labelled tab accessibility element with its
        // selected icon after the tap, so holding the old element and waiting on
        // `selected == true` observes a stale object even though the real
        // destination rendered. The navigation bar is the user-visible task
        // state, so it is the synchronization point and the assertion.
        //
        // The one tap and the one 15-second wait are the original ones. The
        // wait's answer is captured before the after-wait record is collected
        // and is what the assertion judges, so time spent collecting AFTER the
        // wait cannot turn a destination that missed its 15 seconds into a
        // pass. (Collection BEFORE the tap can still shift when the tap lands.)
        let rendered = app.navigationBars[surface.title].waitForExistence(timeout: 15)
        diagnostics?.record(.afterWait(rendered: rendered))
        XCTAssertTrue(rendered,
                      "\(surface.id) was selected but its screen did not render",
                      file: file, line: line)
        return row
    }

    /// The stored-link screen, which is presented rather than browsed to.
    ///
    /// Asserted through the control that only the PRESENTED form carries:
    /// `ReceiveView` renders its Done toolbar item exactly when the shell hands
    /// it an `onDismiss`, so finding it proves the screen came up as a sheet
    /// over a background surface rather than as a destination of its own.
    func waitForPresentedStoredReceive(_ app: XCUIApplication,
                                       timeout: TimeInterval = 20,
                                       file: StaticString = #filePath,
                                       line: UInt = #line) {
        XCTAssertTrue(app.navigationBars[Shell.storedReceiveTitle].waitForExistence(timeout: timeout),
                      "the stored-link screen did not render", file: file, line: line)
        XCTAssertTrue(app.buttons["stored-receive-done"].waitForExistence(timeout: timeout),
                      "the stored-link screen rendered without the explicit dismissal "
                      + "that a presented sheet owes a VoiceOver user",
                      file: file, line: line)
    }

    /// The Device Inbox receiving consent, with its disclosure opened first.
    ///
    /// The control is inside a `DisclosureGroup` that starts open only while the
    /// stored policy is still `Off`. A CONFIGURED account therefore arrives with
    /// it closed and `inbox-policy` genuinely absent from the tree — so a test
    /// that wants the picker has to open the row rather than wait for something
    /// that will never appear. Idempotent: already-open is a no-op.
    ///
    /// Returns the picker so callers can drive its wheel.
    @discardableResult
    func revealReceivingConsent(in app: XCUIApplication,
                                timeout: TimeInterval = 20,
                                file: StaticString = #filePath,
                                line: UInt = #line) -> XCUIElement {
        let policy = app.descendants(matching: .any)["inbox-policy"].firstMatch
        if policy.waitForExistence(timeout: 3) { return policy }
        let row = app.descendants(matching: .any)["inbox-settings-disclosure"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: timeout),
                      "the Device Inbox offers neither the receiving consent nor the row "
                      + "that opens it", file: file, line: line)
        row.tap()
        XCTAssertTrue(policy.waitForExistence(timeout: timeout),
                      "opening the receiving-consent row did not reveal its control",
                      file: file, line: line)
        return policy
    }
}

// MARK: - opt-in navigation diagnostics

extension Shell {
    /// Opts ONE launch in to the app's navigation trace. The app honours it only
    /// in a Debug build and only beside `--relayium-ui-testing`; the same
    /// string is `NavigationTrace.argument` in `RootView.swift`.
    static let navigationTraceArgument = "--relayium-ui-testing-navigation-trace"
    /// The offline acceptance flag the app's trace gate also requires.
    static let uiTestingArgument = "--relayium-ui-testing"
    /// The app's 1-point trace element, `NavigationTrace.identifier`.
    static let navigationTraceIdentifier = "relayium-navigation-trace"
}

/// Evidence around one `open(_:in:)` tap, for a launch that asked for it.
///
/// It exists for one hosted failure: a tap at the Device Inbox tab's centre
/// after which Nearby stayed selected. What it records is what that failure
/// could not answer — the row's frame, hittability and selected state before
/// the tap, the tab buttons' state before and after, the windows and
/// navigation bars, a screenshot, and the app's own trace of whether the
/// selection setter ran.
///
/// **Gate.** The same as the app's: a Debug build, and a launch carrying BOTH
/// `--relayium-ui-testing` and `--relayium-ui-testing-navigation-trace`.
/// Either flag alone, or a Release build, yields nil and records nothing — so
/// no screenshot or accessibility text is collected from a launch that is not
/// the offline acceptance launch.
///
/// **What it can and cannot change.** It never taps, waits, scrolls, retries
/// or asserts, and it reads through `snapshot()`, which throws rather than
/// recording a failure; `isHittable` is read only before the tap, on the row
/// `open` has just waited for — the one live getter it uses. It is
/// NOT free of timing effects: the before-tap queries, `isHittable` and
/// screenshot take real time before the tap is sent, and that can change when
/// the tap lands relative to the app's own work. What it preserves is the
/// original single tap, the original 15-second wait, and the rule that the
/// assertion judges the wait's own captured answer.
///
/// **Bounds.** At most `maxVisited` nodes are walked in the tab bar, every
/// field is clipped to `maxField` characters, and the whole text attachment to
/// `maxText`; each truncation is marked. The app trace is fetched by its
/// identifier, not by reading the hierarchy's text. Attachments are kept on
/// success too, because a passing run's trace is the comparison a failing one
/// needs; each call adds one text file and one screenshot.
struct NavigationDiagnostics {
    enum Phase {
        case beforeTap
        case afterWait(rendered: Bool)

        var name: String {
            switch self {
            case .beforeTap: return "before-tap"
            case .afterWait(let rendered): return rendered ? "after-wait-rendered"
                                                           : "after-wait-not-rendered"
            }
        }
    }

    static let maxVisited = 128
    static let maxTabButtons = 12
    static let maxField = 160
    static let maxTrace = 8_192
    static let maxText = 24_576

    private let requested: Shell.Surface
    private let row: XCUIElement
    private let app: XCUIApplication

    /// nil unless the gate above is open.
    init?(requested: Shell.Surface, row: XCUIElement, in app: XCUIApplication) {
        guard Self.isEnabled(launchArguments: app.launchArguments) else { return nil }
        self.requested = requested
        self.row = row
        self.app = app
    }

    /// The gate, separate so it reads as one rule: Debug, and BOTH flags.
    static func isEnabled(launchArguments: [String]) -> Bool {
        #if DEBUG
        return launchArguments.contains(Shell.uiTestingArgument)
            && launchArguments.contains(Shell.navigationTraceArgument)
        #else
        return false
        #endif
    }

    func record(_ phase: Phase) {
        let name = "navigation-\(requested.id)-\(phase.name)"
        var lines = ["requested=\(requested.id) title=\(requested.title) phase=\(phase.name)",
                     "uptime=\(String(format: "%.3f", ProcessInfo.processInfo.systemUptime))"]
        if let row = try? row.snapshot() {
            lines.append("row " + Self.describe(row))
            if case .beforeTap = phase { lines.append("row hittable=\(self.row.isHittable)") }
        } else {
            lines.append("row unresolved")
        }
        lines += Self.tabButtons(in: app)
        lines += Self.windows(in: app, limit: 4)
        lines += Self.navigationBars(in: app, limit: 4)
        if let trace = try? app.descendants(matching: .any)[Shell.navigationTraceIdentifier]
            .firstMatch.snapshot() {
            lines.append("app-trace " + Self.clip(String(describing: trace.value ?? "-"),
                                                  to: Self.maxTrace))
        } else {
            lines.append("app-trace unresolved")
        }
        XCTContext.runActivity(named: name) { activity in
            let text = XCTAttachment(string: Self.clip(lines.joined(separator: "\n"),
                                                       to: Self.maxText))
            text.name = name + ".txt"
            text.lifetime = .keepAlways
            activity.add(text)
            let shot = XCTAttachment(screenshot: app.screenshot())
            shot.name = name + ".png"
            shot.lifetime = .keepAlways
            activity.add(shot)
        }
    }

    /// `text` unchanged when it fits, otherwise its first `limit` characters
    /// and a marker saying how much was dropped.
    static func clip(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        return String(text.prefix(limit)) + "…[truncated \(text.count - limit) chars]"
    }

    private static func describe(_ e: XCUIElementSnapshot) -> String {
        "type=\(e.elementType.rawValue) id=\(clip(e.identifier, to: maxField)) "
            + "label=\(clip(e.label, to: maxField)) "
            + "selected=\(e.isSelected) enabled=\(e.isEnabled) frame=\(e.frame)"
    }

    /// The tab bar's buttons, in order, from one snapshot of the bar alone —
    /// never the whole app. Breadth-first with TWO caps: buttons kept, and
    /// nodes visited, so a bar with arbitrarily many non-button descendants
    /// still stops, and says so.
    private static func tabButtons(in app: XCUIApplication) -> [String] {
        guard let bar = try? app.tabBars.firstMatch.snapshot() else { return ["tabbar unresolved"] }
        var buttons: [XCUIElementSnapshot] = []
        var queue = bar.children
        var visited = 0
        while !queue.isEmpty, buttons.count < maxTabButtons, visited < maxVisited {
            let next = queue.removeFirst()
            visited += 1
            if next.elementType == .button { buttons.append(next) } else { queue += next.children }
        }
        let truncated = !queue.isEmpty
            ? " truncated(visited=\(visited) pending=\(queue.count))" : ""
        return ["tabbar frame=\(bar.frame) buttons=\(buttons.count)\(truncated)"]
            + buttons.enumerated().map { "tab[\($0.offset)] " + describe($0.element) }
    }

    /// Window count, and the first `limit` windows' own top-level metadata.
    ///
    /// Read through `try? snapshot()` rather than live getters: `exists` then
    /// `frame` is two resolutions, and a window gone between them makes `frame`
    /// record an XCTest failure — which, before the tap, would abort the test
    /// before its original tap, and after the wait would turn a rendered
    /// destination into a FAIL. A snapshot that throws is `unresolved` instead.
    ///
    /// Bounded in what is RECORDED, not in what XCTest fetches: taking a
    /// window's snapshot may materialise the hierarchy under it inside the
    /// framework. Only the window's own fields are read — `children` is never
    /// touched — and no more than `limit` windows are taken.
    private static func windows(in app: XCUIApplication, limit: Int) -> [String] {
        let query = app.windows
        let count = query.count
        var lines = ["windows count=\(count)"]
        for index in 0..<min(count, limit) {
            if let window = try? query.element(boundBy: index).snapshot() {
                lines.append("window[\(index)] " + describe(window))
            } else {
                lines.append("window[\(index)] unresolved")
            }
        }
        return lines
    }

    /// Navigation bars: each bar's own snapshot (a bar's subtree is its title
    /// and items), top-level fields only, clipped.
    private static func navigationBars(in app: XCUIApplication, limit: Int) -> [String] {
        let query = app.navigationBars
        let count = query.count
        var lines = ["navbars count=\(count)"]
        for index in 0..<min(count, limit) {
            if let e = try? query.element(boundBy: index).snapshot() {
                lines.append("navbar[\(index)] " + describe(e))
            } else {
                lines.append("navbar[\(index)] unresolved")
            }
        }
        return lines
    }
}
