import XCTest

/// **The regular-width shell, which is a layout no test had ever run.**
///
/// iOS 0.3.0 gives a full-width iPad a `NavigationSplitView` — a sidebar of
/// destinations and a detail column — while an iPhone and a narrow iPad keep the
/// tab bar. Both render the same five `IOSSurface.browseable` rows through the
/// same `destination(for:)` switch, and that shared list is the whole design:
/// "compact and regular show the same app" is meant to be a property of the
/// composition rather than a rule two layouts have to remember.
///
/// A property of the composition still fails at runtime. A `List(selection:)`
/// whose rows carry tags the binding never produces selects nothing; a detail
/// column that fails to build leaves the sidebar perfectly tappable in front of
/// an empty page; and a sheet presented over a split view can land on the wrong
/// column. None of that is visible from the package, and none of it is visible
/// from an iPhone run — which is why this class exists and why the suite has to
/// be executed on both device shapes rather than on whichever one is faster.
///
/// Regular width only, by skip. A skip is visible in the result bundle; a test
/// that quietly passes on an iPhone by asserting nothing is not.
final class AdaptiveShellUITests: XCTestCase {
    private var app: XCUIApplication!

    private let offlineLaunchArguments = [
        "--relayium-ui-testing", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
    ]

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    private func launchRegular(_ extra: [String] = []) throws {
        app.launchArguments = offlineLaunchArguments + extra
        app.launch()
        guard waitForShell(app) == .regular else {
            throw XCTSkip("the adaptive sidebar needs a regular-width shell")
        }
    }

    /// The sidebar lists exactly the five browseable destinations, in the
    /// product's order, and says what each one does before it is opened.
    ///
    /// Order is asserted by GEOMETRY rather than by the array the rows were
    /// built from, because the second would only re-check the list this test
    /// reads its expectations from. The two account-free live transfers come
    /// first — they are what the app can do for somebody who has never signed in
    /// — then the two account-backed halves, then the account itself.
    func testTheSidebarListsEveryDestinationInTheProductOrder() throws {
        try launchRegular()

        // iPadOS 18 launches the portrait split view with the sidebar
        // collapsed; its rows and title exist only once it is on screen.
        revealSidebar(app)
        XCTAssertTrue(app.navigationBars["Relayium destinations"].waitForExistence(timeout: 15),
                      "the sidebar has no accessible title")

        var previousY: CGFloat = -1
        for surface in Shell.browseable {
            let row = app.descendants(matching: .any)["sidebar-\(surface.id)"].firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10),
                          "the sidebar has no \(surface.id) row")
            XCTAssertGreaterThan(row.frame.minY, previousY,
                                 "\(surface.id) is not in the product's sidebar order")
            previousY = row.frame.minY

            // One element per row, and it is announced by the destination rather
            // than by the glyph beside it. The first iPad run of this shell
            // found rows publishing three elements each, the first of which was
            // an icon announced as "number.circle".
            XCTAssertFalse(row.label.contains("."),
                           "the \(surface.id) row is announced by a raw SF Symbol "
                           + "name: '\(row.label)'")
        }

        // A screen with room for them answers "what is this destination" before
        // it is opened. Read off the ROW rather than off any static text on
        // screen, so this cannot pass on the same words appearing somewhere in
        // the detail column. These two are the ones whose iOS wording differs
        // from the Mac's, so they are the ones a regression would get wrong.
        let lan = app.descendants(matching: .any)["sidebar-lanTransfer"].firstMatch
        XCTAssertTrue(lan.label.contains("no account"),
                      "the LAN Transfer row does not say it needs no account: "
                      + "'\(lan.label)'")
        let inbox = app.descendants(matching: .any)["sidebar-deviceInbox"].firstMatch
        XCTAssertTrue(inbox.label.contains("arrives while Relayium is open"),
                      "the Device Inbox row promises the Mac's background delivery, "
                      + "or says nothing about when a delivery arrives: '\(inbox.label)'")
        XCTAssertFalse(inbox.label.contains("window closed"),
                       "the iPad Device Inbox row claims the Mac's background delivery")
    }

    /// No tab bar in regular width, and the sidebar is not a second one.
    ///
    /// Both halves matter. A shell that drew both would give the same five
    /// destinations two controls with one selection between them, and the one a
    /// user did not touch would silently disagree with where they are.
    func testTheRegularShellDrawsASidebarInsteadOfATabBar() throws {
        try launchRegular()

        XCTAssertFalse(app.tabBars.firstMatch.exists,
                       "the regular-width shell draws a tab bar as well as a sidebar")
        // On iPadOS 18 the portrait split view launches with the sidebar
        // collapsed behind the system toggle, so the sidebar is asserted after
        // that toggle brings it on screen — the ACTUAL sidebar element, not the
        // toggle, remains the evidence that the split shell drew one.
        revealSidebar(app)
        XCTAssertTrue(app.descendants(matching: .any)["sidebar"].firstMatch.exists,
                      "the regular-width shell drew no sidebar")
        XCTAssertFalse(app.tabBars.firstMatch.exists,
                       "revealing the sidebar drew a tab bar beside it")
    }

    /// Selecting a sidebar row renders that destination in the DETAIL column.
    ///
    /// **This is the assertion the identifier on the detail column exists for.**
    /// The sidebar row and the screen it opens can carry the same title, so
    /// waiting on a title alone would let an identically-titled row stand in as
    /// proof that a destination rendered. `destination-<surface>` is applied to
    /// the detail column itself, so it is only present when the column actually
    /// built the screen.
    ///
    /// Driven over every destination, because a `switch` arm that fails to build
    /// is a per-destination failure — the empty-page defect this batch shipped
    /// against was exactly one arm having no case at all.
    func testSelectingASidebarRowRendersItsDestinationInTheDetailColumn() throws {
        try launchRegular()

        for surface in Shell.browseable {
            open(surface, in: app)
            XCTAssertTrue(app.descendants(matching: .any)["destination-\(surface.id)"]
                .firstMatch.waitForExistence(timeout: 15),
                "selecting \(surface.id) did not render it in the detail column")
            // And nothing else is in the detail column at the same time.
            for other in Shell.browseable where other.id != surface.id {
                XCTAssertFalse(app.descendants(matching: .any)["destination-\(other.id)"]
                    .firstMatch.exists,
                    "the detail column drew \(other.id) while \(surface.id) was selected")
            }
        }
    }

    /// The regular shell offers the same app the compact one does.
    ///
    /// Asserted against the destinations' own screens rather than against the
    /// rows, so a sidebar that listed five things and could open three would
    /// fail here. `Shell.browseable` is the one list both this and the compact
    /// smoke read, which is what keeps the two layouts from drifting into two
    /// products.
    func testTheRegularShellReachesEveryDestinationTheCompactOneDoes() throws {
        try launchRegular()

        for surface in Shell.browseable {
            open(surface, in: app)
            XCTAssertTrue(app.navigationBars[surface.title].exists,
                          "\(surface.id) has no screen on the regular-width shell")
        }
    }

    /// A stored link is presented OVER the sidebar's selection, and dismissing
    /// it returns to that selection rather than to the first row.
    ///
    /// The split view is where this is easiest to get wrong: the sheet has two
    /// columns to land on, and the background it is layered over is a detail
    /// column that SwiftUI may rebuild while the sheet is up. `IOSShellModel` is
    /// app-scoped precisely so "where the user was before the link" survives
    /// that rebuild, and this is the runtime half of that claim.
    ///
    /// The user is moved OFF the first destination before the link arrives, so a
    /// dismissal that dropped them on `IOSSurface.browseable.first` — the thing
    /// a `@State` would do after a rebuild — fails rather than coincidentally
    /// passing.
    func testAStoredLinkIsPresentedOverTheSidebarSelectionAndReturnsToIt() throws {
        try launchRegular(["--relayium-ui-testing-signed-in"])

        open(Shell.deviceInbox, in: app)
        XCTAssertTrue(app.descendants(matching: .any)["destination-deviceInbox"]
            .firstMatch.waitForExistence(timeout: 15))

        open(Shell.account, in: app)
        let openStored = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@", "Open", "obj_uitest"))
            .firstMatch
        XCTAssertTrue(openStored.waitForExistence(timeout: 20),
                      "the signed-in account offers no stored file to open")
        openStored.tap()

        waitForPresentedStoredReceive(app)
        app.buttons["stored-receive-done"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["destination-account"]
            .firstMatch.waitForExistence(timeout: 15),
            "dismissing the stored link on the split shell did not return to the "
            + "destination it was presented over")
        XCTAssertFalse(app.buttons["stored-receive-done"].exists,
                       "the stored-link sheet outlived its dismissal")
    }

    /// A launch that begins on the stored-link screen still has a browseable
    /// destination underneath it.
    ///
    /// The invariant `IOSShellPlacement` is built around: the background is
    /// never a non-browseable surface, so a `List(selection:)` — or a `TabView`
    /// — can never be handed a selection none of its rows carry. A cold launch
    /// straight from a Universal Link is the case that would break it, because
    /// there is no earlier selection to fall back to; the acceptance seam
    /// reproduces exactly that starting condition and nothing else.
    func testALaunchThatBeginsOnAStoredLinkStillHasABrowseableBackground() throws {
        try launchRegular(["--relayium-ui-testing-open-stored-link"])

        waitForPresentedStoredReceive(app)

        // The sidebar is still there and still selects something drawable: the
        // first browseable surface, which is what `IOSShellModel.init` falls
        // back to when the destination it is given is not browseable.
        app.buttons["stored-receive-done"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["destination-lanTransfer"]
            .firstMatch.waitForExistence(timeout: 15),
            "a launch that began on the stored-link screen left no browseable "
            + "destination behind it")
    }
}
