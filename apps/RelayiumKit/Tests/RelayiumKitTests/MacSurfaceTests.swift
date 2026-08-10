import XCTest
@testable import RelayiumAppKit

/// The routing half of the macOS Workspace merge, driven rather than read.
///
/// `MacSurfaceGuardTests` proves the sidebar and the shell enumerate this type;
/// these prove the type itself says the right thing. Every assertion here is
/// mutation-sensitive: each one fails for a different single-line edit to
/// `MacSurface.route` or `AppDestination.macSurface`, which is the point — a
/// mapping with one `switch` in each direction is exactly where a plausible
/// wrong answer survives review.
final class MacSurfaceTests: XCTestCase {

    /// **The whole product claim, as one assertion.** Nearby and Pairing code
    /// are two ways to reach one peer; on macOS they draw one screen.
    func testBothDirectRoutesDrawTheOneWorkspaceSurface() {
        XCTAssertEqual(AppDestination.nearby.macSurface, .workspace)
        XCTAssertEqual(AppDestination.pairingCode.macSurface, .workspace)
        XCTAssertEqual(AppDestination.macWorkspaceRoutes, [.nearby, .pairingCode])
    }

    /// …and nothing else does. A `deviceInbox` or `account` that folded into the
    /// Workspace would be a destination the user can no longer reach, and it
    /// would look exactly like the intended merge in a diff.
    func testNoOtherDestinationIsAbsorbedByTheWorkspace() {
        let absorbed = AppDestination.allCases.filter { $0.macSurface == .workspace }
        XCTAssertEqual(Set(absorbed), AppDestination.macWorkspaceRoutes)
        for destination in AppDestination.allCases
        where !AppDestination.macWorkspaceRoutes.contains(destination) {
            XCTAssertEqual(destination.macSurface.rawValue, destination.rawValue,
                           "\(destination.rawValue) silently changed which screen draws it")
        }
    }

    /// Clicking a row and rendering what it opened have to agree. A `route` that
    /// returned a destination whose `macSurface` is a different row would leave
    /// the sidebar selection and the detail column permanently out of step —
    /// visible only as a row that will not stay highlighted.
    func testEveryRowSelectsARouteThatDrawsThatRow() {
        for surface in MacSurface.allCases {
            XCTAssertEqual(surface.route.macSurface, surface, surface.rawValue)
        }
        // Every surface is reachable, and no two rows select the same route.
        XCTAssertEqual(Set(MacSurface.allCases.map(\.route)).count, MacSurface.allCases.count)
        XCTAssertEqual(Set(AppDestination.allCases.map(\.macSurface)),
                       Set(MacSurface.allCases))
    }

    /// The Workspace's canonical route is the anonymous one, and that is a
    /// product decision rather than an arbitrary pick: a sidebar click, a fresh
    /// launch and a Dock drop all land on the half that needs no account and no
    /// code. Selecting `.pairingCode` from a row would put a signed-out user on
    /// the gated half of the screen by default.
    func testTheWorkspaceRowSelectsTheRouteThatNeedsNoAccount() {
        XCTAssertEqual(MacSurface.workspace.route, .nearby)
    }

    /// A deep link still selects `.pairingCode`, and it still arrives here. This
    /// is the property that let the enum stay untouched — and therefore let iOS
    /// keep its two tabs.
    func testAPairingCodeDeepLinkStillArrivesAtTheWorkspace() {
        XCTAssertEqual(AppRouting.destination(for: .realtime(code: "483920")).macSurface,
                       .workspace)
        XCTAssertEqual(AppRouting.destination(for: .realtimeWithMode(code: "483920", mode: .text))
                        .macSurface, .workspace)
        // …and a stored link does not.
        let download = URL(string: "https://relayium.com/d/abc#k=key")!
        XCTAssertEqual(AppRouting.destination(for: .download(download)).macSurface,
                       .storedReceive)
    }

    /// An unsolicited nearby session, of either kind, reaches the one screen
    /// that can draw it. Both already routed to `.nearby`; what this pins is
    /// that neither was left pointing at a row that no longer exists.
    func testAnIncomingSessionOfEitherKindReachesTheWorkspace() {
        for kind in [NearbyReceiveKind.file, .text] {
            XCTAssertEqual(AppRouting.destination(forIncoming: kind).macSurface, .workspace)
        }
    }

    /// Files the OS opened keep the user where they are when that place can
    /// send, and land on the Workspace when it cannot. Both direct routes can
    /// send, so a Dock drop during a pairing-code flow is not yanked onto the
    /// other route — it is the same screen either way.
    func testOpenedFilesLandOnASurfaceThatCanActuallySendThem() {
        for destination in AppDestination.allCases {
            let target = AppRouting.destination(forOpenedFiles: destination)
            XCTAssertTrue(target.macSurface == .workspace || target.macSurface == .storedSend,
                          "\(destination.rawValue) stages files on a surface that cannot send")
        }
        XCTAssertEqual(AppRouting.destination(forOpenedFiles: .pairingCode), .pairingCode)
        XCTAssertEqual(AppRouting.destination(forOpenedFiles: .nearby), .nearby)
        XCTAssertEqual(AppRouting.destination(forOpenedFiles: .storedSend), .storedSend)
        XCTAssertEqual(AppRouting.destination(forOpenedFiles: .deviceInbox).macSurface, .workspace)
    }
}

/// The one shared-layer addition this round needed: a surface that renders more
/// than one destination has to be able to ask for either one's batch in a single
/// call, because two calls with a `consume` between them is two reads of one
/// answer.
@MainActor
final class OpenedFileBatchForAnySurfaceTests: XCTestCase {

    private func coordinator() -> AppFileOpenCoordinator {
        AppFileOpenCoordinator(navigation: AppNavigationModel(selection: .nearby))
    }

    func testEitherWorkspaceRoutesBatchIsAnsweredByTheOneAsk() {
        for route in AppDestination.macWorkspaceRoutes.sorted(by: { $0.rawValue < $1.rawValue }) {
            let navigation = AppNavigationModel(selection: route)
            let coordinator = AppFileOpenCoordinator(navigation: navigation)
            coordinator.deliver([URL(fileURLWithPath: "/tmp/brief.txt")])
            let batch = coordinator.batch(forAnyOf: AppDestination.macWorkspaceRoutes, busy: false)
            XCTAssertEqual(batch?.destination, route)
            XCTAssertEqual(batch?.urls, [URL(fileURLWithPath: "/tmp/brief.txt")])
        }
    }

    /// It widens WHO asks, never WHAT may be taken. A stored-send batch is still
    /// refused — otherwise the Workspace would stage files the user addressed to
    /// a different screen.
    func testItDoesNotWidenWhichBatchesMayBeTaken() {
        let navigation = AppNavigationModel(selection: .storedSend)
        let coordinator = AppFileOpenCoordinator(navigation: navigation)
        coordinator.deliver([URL(fileURLWithPath: "/tmp/brief.txt")])
        XCTAssertNil(coordinator.batch(forAnyOf: AppDestination.macWorkspaceRoutes, busy: false))
        XCTAssertNotNil(coordinator.batch(for: .storedSend, busy: false))
    }

    /// Busy still refuses and still RETAINS, so the batch lands the moment the
    /// surface legitimately can take it rather than being discarded.
    func testBusyRefusesWithoutDiscarding() {
        let coordinator = coordinator()
        coordinator.deliver([URL(fileURLWithPath: "/tmp/brief.txt")])
        XCTAssertNil(coordinator.batch(forAnyOf: AppDestination.macWorkspaceRoutes, busy: true))
        XCTAssertNotNil(coordinator.staged, "a refused ask discarded the user's files")
        XCTAssertNotNil(coordinator.batch(forAnyOf: AppDestination.macWorkspaceRoutes, busy: false))
    }

    /// The single-destination overload is the same rule, so the two cannot
    /// disagree about a batch either of them could be asked about.
    func testTheSingleDestinationOverloadIsTheSameRule() {
        let coordinator = coordinator()
        coordinator.deliver([URL(fileURLWithPath: "/tmp/brief.txt")])
        XCTAssertEqual(coordinator.batch(for: .nearby, busy: false),
                       coordinator.batch(forAnyOf: [.nearby], busy: false))
        XCTAssertNil(coordinator.batch(forAnyOf: [], busy: false))
    }
}
