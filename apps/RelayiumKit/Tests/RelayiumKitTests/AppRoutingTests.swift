import XCTest
@testable import RelayiumAppKit

/// The presentation seam between an event and the destination it puts on
/// screen. Both mappings are pure functions of their own input, and selection
/// is a single assignment onto an app-scoped model — which is what makes "the
/// last event wins" a contract rather than a race: nothing else is mutated on
/// the way, so the result is a function of event order alone.
final class AppRoutingTests: XCTestCase {
    func testExactlyFiveDistinctDestinations() {
        XCTAssertEqual(AppDestination.allCases.count, 5)
        XCTAssertEqual(Set(AppDestination.allCases.map(\.rawValue)).count, 5)
    }
    func testDownloadLinkGoesToStoredReceive() {
        let url = URL(string: "https://relayium.com/d/abc#k=zzz")!
        XCTAssertEqual(AppRouting.destination(for: .download(url)), .storedReceive)
    }
    func testRealtimeLinkGoesToPairingCodeWithAndWithoutACode() {
        XCTAssertEqual(AppRouting.destination(for: .realtime(code: "123456")), .pairingCode)
        XCTAssertEqual(AppRouting.destination(for: .realtime(code: nil)), .pairingCode)
    }
    func testEveryIncomingKindGoesToNearby() {
        XCTAssertEqual(NearbyReceiveKind.allCases.count, 2)
        for kind in NearbyReceiveKind.allCases {
            XCTAssertEqual(AppRouting.destination(forIncoming: kind), .nearby)
        }
    }
    @MainActor func testSelectIsASingleAssignment() {
        let nav = AppNavigationModel()
        XCTAssertEqual(nav.selection, .nearby)
        nav.select(.storedReceive)
        XCTAssertEqual(nav.selection, .storedReceive)
        XCTAssertEqual(nav.selectionWrites, 1)
        nav.select(.storedReceive)                      // same value, still one write
        XCTAssertEqual(nav.selectionWrites, 2)
        XCTAssertEqual(nav.selection, .storedReceive)
    }
    @MainActor func testLaterEventWinsAndNeitherClearsTheOther() {
        let nav = AppNavigationModel()
        nav.select(AppRouting.destination(forIncoming: .file))
        nav.select(AppRouting.destination(for: .realtime(code: "123456")))
        XCTAssertEqual(nav.selection, .pairingCode)
        XCTAssertEqual(nav.selectionWrites, 2)
    }
}
