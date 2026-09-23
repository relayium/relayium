import XCTest
@testable import RelayiumAppKit

/// The presentation seam between an event and the destination it puts on
/// screen. Both mappings are pure functions of their own input, and selection
/// is a single assignment onto an app-scoped model — which is what makes "the
/// last event wins" a contract rather than a race: nothing else is mutated on
/// the way, so the result is a function of event order alone.
final class AppRoutingTests: XCTestCase {
    func testExactlySixDistinctDestinations() {
        XCTAssertEqual(AppDestination.allCases.count, 6)
        XCTAssertEqual(Set(AppDestination.allCases.map(\.rawValue)).count, 6)
        // Named rather than counted alone. The count moved when the Device Inbox
        // became a first-class destination, and a count on its own is satisfied
        // by any sixth case — including a rename that silently drops this one and
        // takes the sidebar row, the shell's switch arm and the menu bar's route
        // with it.
        XCTAssertTrue(AppDestination.allCases.contains(.deviceInbox),
                      "the Device Inbox is no longer one of the app's destinations")
        XCTAssertEqual(AppDestination.deviceInbox.rawValue, "deviceInbox",
                       "the raw value is the runtime identity of the sidebar row and the "
                       + "detail surface; renaming it silently breaks every UI query")
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
    /// A capability gate's **Create an account** has to land on the
    /// create-account half of the form. Routing it to the Account destination
    /// alone would show a sign-in form — a button that names one thing and
    /// produces another, which is the same defect as the greyed control the
    /// gates exist to replace.
    @MainActor func testSelectingTheAccountCarriesTheHalfOfTheFormToShow() {
        let nav = AppNavigationModel()
        XCTAssertEqual(nav.accountIntent, .signIn, "the default is the common case")

        nav.selectAccount(intent: .register)
        XCTAssertEqual(nav.selection, .account)
        XCTAssertEqual(nav.accountIntent, .register)
        XCTAssertEqual(nav.selectionWrites, 1, "still exactly one selection write")

        nav.selectAccount(intent: .signIn)
        XCTAssertEqual(nav.accountIntent, .signIn)
        XCTAssertEqual(nav.selectionWrites, 2)

        nav.rememberAccountIntent(.register)
        XCTAssertEqual(nav.accountIntent, .register)
        XCTAssertEqual(nav.selectionWrites, 2,
                       "remembering the form's own switch is not navigation")
    }

    @MainActor func testMacIncomingReconstructionRestoresItsExistingSurface() {
        let presence = TransferPresence(mode: .text)
        let nav = AppNavigationModel(selection: .account)
        XCTAssertTrue(presence.claim(.nearby, mode: .files,
                                     peerLabel: "Kitchen iPad"))

        XCTAssertTrue(AppRouting.reconcileIncoming(
            .file, presence: presence, navigation: nav))
        XCTAssertEqual(presence.owner, .nearby)
        XCTAssertEqual(presence.mode, .files)
        XCTAssertEqual(presence.sessionPeerLabel, "Kitchen iPad")
        XCTAssertEqual(nav.selection, .nearby)
        XCTAssertEqual(nav.selectionWrites, 1)

        presence.release(.nearby)
        XCTAssertTrue(presence.claim(.pairingCode, mode: .text))
        nav.select(.pairingCode)
        XCTAssertFalse(AppRouting.reconcileIncoming(
            .file, presence: presence, navigation: nav))
        XCTAssertEqual(nav.selection, .pairingCode)
        XCTAssertEqual(nav.selectionWrites, 2)
    }

    @MainActor func testLaterEventWinsAndNeitherClearsTheOther() {
        let nav = AppNavigationModel()
        nav.select(AppRouting.destination(forIncoming: .file))
        nav.select(AppRouting.destination(for: .realtime(code: "123456")))
        XCTAssertEqual(nav.selection, .pairingCode)
        XCTAssertEqual(nav.selectionWrites, 2)
    }
}
