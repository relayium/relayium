import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The iOS shell's two layers, and the property that replaced a source ban.
///
/// `IOSSurfaceGuardTests` used to refuse the word `deviceInbox` anywhere under
/// `apps/ios`, because `AppDestination` carried a case that shell could not draw
/// and a `TabView` handed a selection with no matching `.tag` renders an empty
/// screen. iOS draws it now, so that ban is false — and deleting it alone would
/// leave the empty-screen defect unguarded. What holds the property instead is
/// this type: the shell binds its selection to `IOSShellPlacement.background`,
/// which is a browseable surface **by construction**, whatever destination is
/// selected.
///
/// These are behavioural, not textual: every assertion drives the real model
/// with a real publisher, so they fail if the rule changes rather than if the
/// code is re-laid-out.
@MainActor
final class IOSShellPlacementTests: XCTestCase {

    // MARK: - the vocabulary

    /// Five rows, in the product's order, and the one that is not a row.
    func testTheBrowseableListIsTheFiveProductSurfacesInOrder() {
        XCTAssertEqual(IOSSurface.browseable,
                       [.lanTransfer, .crossNetworkTransfer, .storedSend, .deviceInbox, .account],
                       "the shell's row order is a product decision, not an enum's")
        XCTAssertFalse(IOSSurface.storedReceive.isBrowseable,
                       "opening a stored link is handed to this app, not browsed to")
        // Derived from the list, never the other way round.
        for surface in IOSSurface.allCases {
            XCTAssertEqual(surface.isBrowseable, IOSSurface.browseable.contains(surface))
        }
    }

    /// Every destination resolves to a surface, and every surface round-trips
    /// back to the destination that selects it.
    ///
    /// The round trip is what stops a row opening a screen other than the one it
    /// names — the defect a hand-written mapping produces the first time a case
    /// is inserted in the middle.
    func testEveryDestinationMapsToASurfaceAndBack() {
        for destination in AppDestination.allCases {
            XCTAssertEqual(destination.iosSurface.route, destination,
                           "\(destination.rawValue) does not round-trip through IOSSurface")
        }
        for surface in IOSSurface.allCases {
            XCTAssertEqual(surface.route.iosSurface, surface,
                           "\(surface.rawValue) does not round-trip through AppDestination")
        }
        XCTAssertEqual(Set(IOSSurface.allCases.map(\.route)), Set(AppDestination.allCases),
                       "a destination with no iOS surface would render nothing at all")
    }

    /// Distinct symbols, so two rows are never marked with one glyph.
    func testEverySurfaceHasItsOwnSymbol() {
        let symbols = IOSSurface.allCases.map(\.symbol)
        XCTAssertEqual(Set(symbols).count, symbols.count,
                       "two surfaces share a glyph; the row and the screen it opens must match")
        XCTAssertFalse(symbols.contains(where: \.isEmpty))
    }

    // MARK: - the placement rule

    /// **A background surface is always browseable — for every destination, at
    /// every point in any sequence.**
    ///
    /// This is the empty-tab guard, stated as behaviour. The shell reads only
    /// `backgroundRoute`, so as long as this holds, a `TabView` selection with
    /// no matching `.tag` is unreachable.
    func testTheBackgroundIsAlwaysBrowseableWhateverIsSelected() {
        let shell = IOSShellModel()
        for destination in AppDestination.allCases {
            shell.apply(destination)
            XCTAssertTrue(shell.placement.background.isBrowseable,
                          "selecting \(destination.rawValue) left an unbrowseable background")
            XCTAssertTrue(IOSSurface.browseable.contains(where: {
                $0.route == shell.placement.backgroundRoute
            }), "the shell would bind a selection no tab is tagged with")
        }
        // And over every ordered pair, so it is not an artefact of the order
        // `allCases` happens to have.
        for first in AppDestination.allCases {
            for second in AppDestination.allCases {
                let model = IOSShellModel()
                model.apply(first)
                model.apply(second)
                XCTAssertTrue(model.placement.background.isBrowseable,
                              "\(first.rawValue) then \(second.rawValue) left an "
                              + "unbrowseable background")
            }
        }
    }

    /// A stored link is layered ON the surface the user was on, and dismissing
    /// it puts them back there — not on whichever tab is first.
    func testAStoredLinkIsPresentedOverWhereTheUserWas() {
        let shell = IOSShellModel()
        shell.apply(.storedSend)
        XCTAssertEqual(shell.placement, IOSShellPlacement(background: .storedSend))

        shell.apply(.storedReceive)
        XCTAssertEqual(shell.placement.background, .storedSend,
                       "the link replaced the surface instead of covering it")
        XCTAssertEqual(shell.placement.presented, .storedReceive)
        XCTAssertEqual(shell.placement.backgroundRoute, .storedSend,
                       "dismissing would drop the user somewhere they never chose")

        // Selecting it again changes nothing: the background is only ever
        // written by a browseable selection.
        shell.apply(.storedReceive)
        XCTAssertEqual(shell.placement.background, .storedSend)
        XCTAssertEqual(shell.placement.presented, .storedReceive)
    }

    /// Choosing a tab dismisses the link.
    ///
    /// A sheet that survived a tab change would be a modal the tab bar cannot
    /// get out from under — the user taps Account, the link screen stays up, and
    /// nothing on it explains why.
    func testSelectingABrowseableSurfaceClearsAnythingPresented() {
        let shell = IOSShellModel()
        shell.apply(.storedReceive)
        XCTAssertNotNil(shell.placement.presented)
        shell.apply(.account)
        XCTAssertNil(shell.placement.presented,
                     "a presented surface survived the user choosing a tab")
        XCTAssertEqual(shell.placement.background, .account)
    }

    /// **A cold launch straight from a Universal Link.**
    ///
    /// The link can be delivered before any view exists, so the shell's initial
    /// value has to go through the same rule every later change does — otherwise
    /// it would begin with a non-browseable background and the first frame would
    /// be an empty tab behind the sheet.
    func testAShellBuiltOnANonBrowseableDestinationStillHasABrowseableBackground() {
        let shell = IOSShellModel(initial: .storedReceive)
        XCTAssertTrue(shell.placement.background.isBrowseable)
        XCTAssertEqual(shell.placement.background, .lanTransfer,
                       "a cold launch from a link must land on the first browseable surface")
        XCTAssertEqual(shell.placement.presented, .storedReceive,
                       "the link that launched the app is not on screen")
    }

    /// The shell follows the one navigation authority and never writes to it.
    ///
    /// Subscribed rather than read on redraw, because the selection moves from
    /// outside the view tree — an unsolicited session admitted on a socket's
    /// queue, a link on a cold launch — and a shell that only re-read during a
    /// render would be looking the other way.
    func testTheShellFollowsTheNavigationModelAndNeverWritesBack() async {
        let navigation = AppNavigationModel(selection: .nearby)
        let shell = IOSShellModel(initial: navigation.selection)
        shell.observe(navigation.$selection)

        navigation.select(.deviceInbox)
        await settle()
        XCTAssertEqual(shell.placement.background, .deviceInbox)

        let writesBefore = navigation.selectionWrites
        navigation.select(.storedReceive)
        await settle()
        XCTAssertEqual(shell.placement.background, .deviceInbox,
                       "the link covered the Device Inbox instead of replacing it")
        XCTAssertEqual(shell.placement.presented, .storedReceive)
        XCTAssertEqual(navigation.selectionWrites, writesBefore + 1,
                       "the shell wrote back to the selection it is derived from")
    }

    /// `observe` is idempotent, so a rebuilt scene cannot install a second
    /// subscription that applies every change twice.
    func testObservingTwiceInstallsOneSubscription() async {
        let navigation = AppNavigationModel(selection: .nearby)
        let shell = IOSShellModel(initial: navigation.selection)
        shell.observe(navigation.$selection)
        shell.observe(navigation.$selection)
        navigation.select(.account)
        await settle()
        XCTAssertEqual(shell.placement, IOSShellPlacement(background: .account))
    }

    private func settle(_ turns: Int = 4) async {
        for _ in 0..<turns { await Task.yield() }
    }
}
