import XCTest
@testable import RelayiumAppKit

/// The routing half of the macOS surface split, driven rather than read.
///
/// `MacSurfaceGuardTests` proves the sidebar and the shell enumerate this type;
/// these prove the type itself says the right thing. Every assertion here is
/// mutation-sensitive: each one fails for a different single-line edit to
/// `MacSurface.route`, `MacSurface.browseable` or `AppDestination.macSurface`,
/// which is the point — a mapping with one `switch` in each direction is exactly
/// where a plausible wrong answer survives review.
final class MacSurfaceTests: XCTestCase {

    /// **The product claim, as one assertion.** Same-network transfer and
    /// pairing-code transfer are two destinations, not one merged row: they have
    /// opposite preconditions, so they get two screens.
    func testTheTwoDirectRoutesDrawTwoSeparateSurfaces() {
        XCTAssertEqual(AppDestination.nearby.macSurface, .lanTransfer)
        XCTAssertEqual(AppDestination.pairingCode.macSurface, .crossNetworkTransfer)
        XCTAssertNotEqual(AppDestination.nearby.macSurface,
                          AppDestination.pairingCode.macSurface,
                          "the two connection methods share a screen again")
    }

    /// No destination is absorbed by another. A `deviceInbox` or `account` that
    /// folded into a transfer surface would be a destination the user can no
    /// longer reach, and it would look exactly like an intended merge in a diff.
    func testEveryDestinationDrawsItsOwnSurface() {
        XCTAssertEqual(Set(AppDestination.allCases.map(\.macSurface)).count,
                       AppDestination.allCases.count,
                       "two destinations were merged into one macOS screen")
        XCTAssertEqual(Set(AppDestination.allCases.map(\.macSurface)),
                       Set(MacSurface.allCases),
                       "a macOS surface exists that no destination can reach")
    }

    /// Clicking a row and rendering what it opened have to agree. A `route` that
    /// returned a destination whose `macSurface` is a different row would leave
    /// the sidebar selection and the detail column permanently out of step —
    /// visible only as a row that will not stay highlighted.
    func testEverySurfaceSelectsARouteThatDrawsThatSurface() {
        for surface in MacSurface.allCases {
            XCTAssertEqual(surface.route.macSurface, surface, surface.rawValue)
        }
        XCTAssertEqual(Set(MacSurface.allCases.map(\.route)).count, MacSurface.allCases.count,
                       "two surfaces select the same destination")
    }

    // MARK: - exactly five browseable rows

    /// **The sidebar inventory, named and counted.**
    ///
    /// Five rows, in this order, and `storedReceive` is not one of them. Both
    /// halves are load-bearing: a sixth row is a destination the owner asked to
    /// have removed coming back, and a missing one is a capability with no way
    /// in — which is exactly how the Device Inbox shipped invisible once already.
    func testTheSidebarOffersExactlyTheFiveBrowseableSurfaces() {
        XCTAssertEqual(MacSurface.browseable,
                       [.lanTransfer, .crossNetworkTransfer, .storedSend,
                        .deviceInbox, .account])
        XCTAssertEqual(MacSurface.browseable.count, 5)
        XCTAssertEqual(Set(MacSurface.browseable).count, MacSurface.browseable.count,
                       "a surface is listed twice")
        for surface in MacSurface.browseable {
            XCTAssertTrue(surface.isBrowseable, surface.rawValue)
        }
    }

    /// Open a link is reachable and not browseable, and those are two different
    /// facts. It has a surface, a route and a destination file; it has no row.
    func testOpenALinkIsHiddenFromTheSidebarAndStillReachable() {
        XCTAssertFalse(MacSurface.storedReceive.isBrowseable,
                       "Open a link is an ordinary sidebar destination again")
        XCTAssertFalse(MacSurface.browseable.contains(.storedReceive))
        XCTAssertEqual(MacSurface.storedReceive.route, .storedReceive)
        XCTAssertEqual(AppDestination.storedReceive.macSurface, .storedReceive,
                       "the deep-link destination no longer has a screen to draw it")
        // …and exactly one surface is hidden. Hiding a second one silently
        // removes a capability from the product.
        XCTAssertEqual(MacSurface.allCases.filter { !$0.isBrowseable }, [.storedReceive])
    }

    /// A `relayium.com/d/...` link the OS handed this app still arrives at the
    /// screen that opens it — the whole point of hiding a row rather than
    /// deleting a destination.
    func testAStoredDownloadLinkStillReachesTheHiddenSurface() {
        let download = URL(string: "https://relayium.com/d/abc#k=key")!
        XCTAssertEqual(AppRouting.destination(for: .download(download)), .storedReceive)
        XCTAssertEqual(AppRouting.destination(for: .download(download)).macSurface,
                       .storedReceive)
    }

    /// A pairing-code deep link selects the pairing destination and draws the
    /// Cross-network screen — not the LAN one, which cannot act on a code.
    func testAPairingCodeDeepLinkReachesTheCrossNetworkSurface() {
        XCTAssertEqual(AppRouting.destination(for: .realtime(code: "483920")).macSurface,
                       .crossNetworkTransfer)
        XCTAssertEqual(AppRouting.destination(for: .realtimeWithMode(code: "483920",
                                                                    mode: .text)).macSurface,
                       .crossNetworkTransfer)
    }

    /// An unsolicited same-network session, of either kind, reaches the LAN
    /// screen — the one with the roster and the resident receiver.
    func testAnIncomingSessionOfEitherKindReachesTheLanSurface() {
        for kind in [NearbyReceiveKind.file, .text] {
            XCTAssertEqual(AppRouting.destination(forIncoming: kind).macSurface, .lanTransfer)
        }
    }

    /// Files the OS opened keep the user where they are when that place can
    /// send, and land on LAN Transfer when it cannot.
    ///
    /// The `storedReceive` line is the one this batch has to keep true: Open a
    /// link is no longer browseable, so a Finder **Open With** performed while a
    /// deep link is on screen must not stage the user's files on a surface they
    /// cannot navigate back to.
    func testOpenedFilesNeverLandOnTheHiddenSurface() {
        for destination in AppDestination.allCases {
            let target = AppRouting.destination(forOpenedFiles: destination)
            XCTAssertTrue(target.macSurface.isBrowseable,
                          "\(destination.rawValue) stages files on a hidden surface")
            // Stored Send alone. The two transfer surfaces are connect-first
            // and hold nothing before a session exists, so a batch landing on
            // either would be staging with no control that could have caused it.
            XCTAssertEqual(target.macSurface, .storedSend,
                           "\(destination.rawValue) stages files on a surface that cannot hold them")
        }
        for destination in AppDestination.allCases {
            XCTAssertEqual(AppRouting.destination(forOpenedFiles: destination), .storedSend,
                           "\(destination.rawValue) stages files somewhere that no longer holds them")
        }
    }
}

/// Which pane each transfer destination draws, and whether it may start
/// anything — the rules that keep one shared set of models from being rendered
/// or restarted by two screens.
final class TransferSurfacePresentationTests: XCTestCase {

    private let lan = AppDestination.nearby
    private let cross = AppDestination.pairingCode

    /// **A session is visible on its owning route and nowhere else.**
    ///
    /// The failure this refuses is concrete: the two destinations share one
    /// `RealtimeSessionModel`, so a pane keyed on model state would draw a
    /// pairing-code transfer on the LAN screen as well — one transfer, two exits.
    func testASessionIsDrawnOnlyByTheRouteThatOwnsIt() {
        XCTAssertEqual(TransferSurfacePresentation.pane(route: lan, owner: lan,
                                                        linkHasSession: false),
                       .legacySession)
        XCTAssertEqual(TransferSurfacePresentation.pane(route: cross, owner: lan,
                                                        linkHasSession: false),
                       .connect)
        XCTAssertEqual(TransferSurfacePresentation.pane(route: cross, owner: cross,
                                                        linkHasSession: false),
                       .legacySession)
        XCTAssertEqual(TransferSurfacePresentation.pane(route: lan, owner: cross,
                                                        linkHasSession: false),
                       .connect)
    }

    /// A live `link/1` is still only the owner's, and `linkHasSession` only
    /// chooses WHICH session pane that owner draws.
    func testALinkSessionIsAlsoOnlyDrawnByItsOwner() {
        XCTAssertEqual(TransferSurfacePresentation.pane(route: lan, owner: lan,
                                                        linkHasSession: true),
                       .link)
        XCTAssertEqual(TransferSurfacePresentation.pane(route: cross, owner: cross,
                                                        linkHasSession: true),
                       .link)
        XCTAssertEqual(TransferSurfacePresentation.pane(route: lan, owner: cross,
                                                        linkHasSession: true),
                       .connect,
                       "a link session owned by the pairing route is drawn on the LAN screen")
        XCTAssertEqual(TransferSurfacePresentation.pane(route: cross, owner: lan,
                                                        linkHasSession: true),
                       .connect)
    }

    /// No owner means no session anywhere, on either screen — including with a
    /// link flag that has gone stale.
    func testWithNoOwnerBothScreensShowTheirConnectControls() {
        for route in [lan, cross] {
            for linkHasSession in [true, false] {
                XCTAssertEqual(TransferSurfacePresentation.pane(route: route, owner: nil,
                                                                linkHasSession: linkHasSession),
                               .connect, route.rawValue)
            }
        }
    }

    /// A destination that is not a transfer destination never owns one of these
    /// panes, whatever the presence object says.
    func testAnUnrelatedOwnerLeavesBothTransferScreensOnConnect() {
        for owner in [AppDestination.storedSend, .storedReceive, .deviceInbox, .account] {
            XCTAssertEqual(TransferSurfacePresentation.pane(route: lan, owner: owner,
                                                            linkHasSession: false), .connect)
            XCTAssertEqual(TransferSurfacePresentation.pane(route: cross, owner: owner,
                                                            linkHasSession: false), .connect)
        }
    }

    /// **Switching screens cannot start a conflicting session.**
    ///
    /// Ownership alone refuses, and so does a retained terminal state that has
    /// not been dismissed yet — the `.completed` receive holding its result is
    /// exactly the case where every busy flag reads false.
    func testNothingNewMayStartWhileAnythingIsOwnedOrRetained() {
        XCTAssertTrue(TransferSurfacePresentation.acceptsNewSession(
            owner: nil, sessionIsLiveOrRetained: false))
        XCTAssertFalse(TransferSurfacePresentation.acceptsNewSession(
            owner: lan, sessionIsLiveOrRetained: false),
            "a claim with no published model state still has to refuse a second start")
        XCTAssertFalse(TransferSurfacePresentation.acceptsNewSession(
            owner: cross, sessionIsLiveOrRetained: false))
        XCTAssertFalse(TransferSurfacePresentation.acceptsNewSession(
            owner: nil, sessionIsLiveOrRetained: true),
            "a retained terminal session left the connect controls live")
        XCTAssertFalse(TransferSurfacePresentation.acceptsNewSession(
            owner: lan, sessionIsLiveOrRetained: true))
    }

    /// The two answers agree at the boundary: whenever a screen is drawing
    /// somebody else's session it is also refusing to start one, so there is no
    /// state in which the connect controls are visible AND live over a session.
    func testAScreenShowingConnectControlsOverALiveSessionStillRefuses() {
        for route in [lan, cross] {
            for owner in [lan, cross] where owner != route {
                XCTAssertEqual(TransferSurfacePresentation.pane(route: route, owner: owner,
                                                                linkHasSession: false),
                               .connect)
                XCTAssertFalse(TransferSurfacePresentation.acceptsNewSession(
                    owner: owner, sessionIsLiveOrRetained: true))
            }
        }
    }
}

/// Ownership arbitration end to end, through the real `TransferPresence`.
///
/// `TransferSurfacePresentationTests` drives the rules with hand-written owners;
/// this drives them with the object the app actually claims through, so a change
/// to either side that makes the two disagree fails here.
@MainActor
final class TransferSurfaceOwnershipTests: XCTestCase {

    func testASecondScreenCannotBeginASessionWhileTheFirstOwnsOne() {
        let presence = TransferPresence()
        XCTAssertTrue(presence.beginSession(.nearby, mode: .files))
        XCTAssertEqual(TransferSurfacePresentation.pane(route: .nearby,
                                                        owner: presence.owner,
                                                        linkHasSession: false),
                       .legacySession)
        XCTAssertEqual(TransferSurfacePresentation.pane(route: .pairingCode,
                                                        owner: presence.owner,
                                                        linkHasSession: false),
                       .connect)
        XCTAssertFalse(presence.beginSession(.pairingCode, mode: .text),
                       "the pairing screen started a session over a live LAN one")
        XCTAssertEqual(presence.owner, .nearby)
        XCTAssertEqual(presence.mode, .files, "a refused claim repointed the live mode")
    }

    /// Only the owner may let go, which is why each transfer pane releases its
    /// OWN route rather than whatever the presence object currently holds.
    func testTheNonOwningRouteCannotReleaseTheSession() {
        let presence = TransferPresence()
        XCTAssertTrue(presence.beginSession(.pairingCode, mode: .text))
        presence.release(.nearby)
        XCTAssertEqual(presence.owner, .pairingCode,
                       "the LAN screen released a pairing-code session")
        presence.release(.pairingCode)
        XCTAssertNil(presence.owner)
        XCTAssertTrue(TransferSurfacePresentation.acceptsNewSession(
            owner: presence.owner, sessionIsLiveOrRetained: false))
    }

    /// The live-session marker follows the owning row only, which is what makes
    /// following it land the user on the transfer.
    func testOnlyTheOwningRowAnnouncesARunningTransfer() {
        let presence = TransferPresence()
        XCTAssertTrue(presence.beginSession(.pairingCode, mode: .files))
        XCTAssertTrue(presence.announcesRunningTransfer(.pairingCode, sessionIsBusy: true))
        XCTAssertFalse(presence.announcesRunningTransfer(.nearby, sessionIsBusy: true))
        // …and no row announces one once the bytes stop, even though the owner
        // keeps the surface for its retained result.
        XCTAssertFalse(presence.announcesRunningTransfer(.pairingCode, sessionIsBusy: false))
    }
}

/// The shared-layer helper used by destinations that share one staging context.
/// **Who may take an OS-opened batch, now that only one surface can hold one.**
///
/// The class this replaces guarded a widened `forAnyOf:` ask: LAN Transfer and
/// Cross-network Transfer were separate routes over one app-scoped selection, so
/// either could adopt a batch addressed to the other. Both are connect-first —
/// no selection, no drop zone, no adoption — so the overload is gone and the
/// rule is the narrow one it always delegated to.
@MainActor
final class OpenedFileBatchTests: XCTestCase {

    private func coordinator() -> AppFileOpenCoordinator {
        AppFileOpenCoordinator(navigation: AppNavigationModel(selection: .storedSend))
    }

    /// Exact, for every destination: the addressed one takes it and nobody else
    /// does — including, by name, the two screens that used to.
    func testOnlyTheAddressedDestinationTakesTheBatch() {
        let coordinator = coordinator()
        coordinator.deliver([URL(fileURLWithPath: "/tmp/brief.txt")])
        let batch = coordinator.batch(for: .storedSend, busy: false)
        XCTAssertEqual(batch?.destination, .storedSend)
        XCTAssertEqual(batch?.urls, [URL(fileURLWithPath: "/tmp/brief.txt")])
        for refused in AppDestination.allCases where refused != .storedSend {
            XCTAssertNil(coordinator.batch(for: refused, busy: false),
                         "\(refused.rawValue) took a batch addressed to Stored Send")
        }
    }

    /// Wherever the user was standing, the batch is addressed to Stored Send and
    /// the transfer screens are refused it.
    func testATransferScreenIsRefusedWhereverTheBatchCameFrom() {
        for route in [AppDestination.nearby, .pairingCode] {
            let navigation = AppNavigationModel(selection: route)
            let coordinator = AppFileOpenCoordinator(navigation: navigation)
            coordinator.deliver([URL(fileURLWithPath: "/tmp/brief.txt")])
            XCTAssertEqual(coordinator.staged?.destination, .storedSend,
                           "an open from \(route.rawValue) was addressed to a transfer screen")
            XCTAssertNil(coordinator.batch(for: .nearby, busy: false))
            XCTAssertNil(coordinator.batch(for: .pairingCode, busy: false))
        }
    }

    /// Busy still refuses and still RETAINS, so the batch lands the moment the
    /// surface legitimately can take it rather than being discarded.
    func testBusyRefusesWithoutDiscarding() {
        let coordinator = coordinator()
        coordinator.deliver([URL(fileURLWithPath: "/tmp/brief.txt")])
        XCTAssertNil(coordinator.batch(for: .storedSend, busy: true))
        XCTAssertNotNil(coordinator.staged, "a refused ask discarded the user's files")
        XCTAssertNotNil(coordinator.batch(for: .storedSend, busy: false))
    }
}
