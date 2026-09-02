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
    static let crossNetworkTransfer = Surface(id: "crossNetworkTransfer", title: "Direct")
    static let storedSend = Surface(id: "storedSend", title: "Send files")
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
    static let storedReceiveTitle = "Receive files"

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
            row = app.tabBars.firstMatch.buttons["tab-\(surface.id)"].firstMatch
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
        row.tap()
        // SwiftUI may replace the labelled tab accessibility element with its
        // selected icon after the tap, so holding the old element and waiting on
        // `selected == true` observes a stale object even though the real
        // destination rendered. The navigation bar is the user-visible task
        // state, so it is the synchronization point and the assertion.
        XCTAssertTrue(app.navigationBars[surface.title].waitForExistence(timeout: 15),
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
}
