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

    @MainActor func testMacIncomingRoutingClaimsBeforeItNavigates() {
        let presence = TransferPresence(mode: .files)
        let nav = AppNavigationModel(selection: .pairingCode)
        XCTAssertTrue(presence.claim(.pairingCode, mode: .text))

        XCTAssertFalse(AppRouting.claimIncoming(
            .text, presence: presence, navigation: nav))
        XCTAssertEqual(presence.owner, .pairingCode)
        XCTAssertEqual(presence.mode, .text)
        XCTAssertEqual(nav.selection, .pairingCode,
                       "a refused claim must not switch Pairing code to Nearby")
        XCTAssertEqual(nav.selectionWrites, 0)

        presence.release(.pairingCode)
        XCTAssertTrue(AppRouting.claimIncoming(
            .file, presence: presence, navigation: nav))
        XCTAssertEqual(presence.owner, .nearby)
        XCTAssertEqual(presence.mode, .files)
        XCTAssertEqual(nav.selection, .nearby)
        XCTAssertEqual(nav.selectionWrites, 1)

        XCTAssertFalse(AppRouting.claimIncoming(
            .text, peerLabel: "Second peer", presence: presence, navigation: nav),
                       "a second offer on Nearby is a new session, not reconstruction")
        XCTAssertEqual(presence.mode, .files)
        XCTAssertNil(presence.sessionPeerLabel)
        XCTAssertEqual(nav.selectionWrites, 1)
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

    // MARK: - R3-F: everything an inbound session must settle synchronously

    /// An unsolicited session is admitted on the socket's own queue and its
    /// responder is then built across an `await`. Everything that decides WHERE
    /// it will be drawn has to be settled before that await, in one hop, or the
    /// session becomes live on a surface nobody is looking at — and the mode
    /// picker that would fix it is by then locked, because a model is busy.
    ///
    /// One function so the three writes cannot drift apart or be reordered by a
    /// later edit to a view.
    @MainActor func testAnIncomingSessionClaimsItsSurfaceItsModeAndItsTabAtOnce() {
        for (kind, mode) in [(NearbyReceiveKind.file, TransferMode.files), (.text, .text)] {
            let presence = TransferPresence()
            let modes = DirectModeSelection(mode: mode == .files ? .text : .files)
            let nav = AppNavigationModel(selection: .storedReceive)

            XCTAssertTrue(AppRouting.claimIncoming(
                kind, peerLabel: "Kitchen iPad", presence: presence,
                modes: modes, navigation: nav))

            XCTAssertEqual(presence.owner, .nearby, "\(kind) was left with no surface to draw it")
            XCTAssertEqual(presence.sessionPeerLabel, "Kitchen iPad")
            XCTAssertEqual(modes.mode, mode, "\(kind) arrived on the other half of the picker")
            XCTAssertEqual(nav.selection, .nearby)
            XCTAssertEqual(nav.selectionWrites, 1)
        }
    }

    /// A second offer cannot repoint a surface the first one owns. The models
    /// refuse the session itself; this is the half that stops the *rendering*
    /// from being stolen — and it must not half-apply, which is why the mode is
    /// asserted unchanged too.
    @MainActor func testAnIncomingSessionCannotStealASurfaceThePairingCodeTabOwns() {
        let presence = TransferPresence()
        let modes = DirectModeSelection(mode: .files)
        let nav = AppNavigationModel(selection: .pairingCode)
        presence.claim(.pairingCode)

        XCTAssertFalse(AppRouting.claimIncoming(
            .text, presence: presence, modes: modes, navigation: nav))

        XCTAssertEqual(presence.owner, .pairingCode)
        XCTAssertEqual(modes.mode, .files, "a refused claim still moved the picker")
        XCTAssertEqual(nav.selection, .pairingCode, "a refused claim still navigated away")
        XCTAssertEqual(nav.selectionWrites, 0)
    }

    /// `TransferPresence.claim` is intentionally idempotent for a surface that
    /// is reconciling a session it already owns. Inbound admission cannot use
    /// that leniency: after an outbound Nearby tap, the actor may not have run
    /// the model's connect task yet, so both models still look idle even though
    /// a new attempt already owns the surface.
    @MainActor func testAnIncomingSessionCannotEnterAnAlreadyClaimedNearbySurface() {
        let presence = TransferPresence()
        let modes = DirectModeSelection(mode: .files)
        let nav = AppNavigationModel(selection: .nearby)
        XCTAssertTrue(presence.claim(.nearby))

        XCTAssertFalse(AppRouting.claimIncoming(
            .text, presence: presence, modes: modes, navigation: nav))

        XCTAssertEqual(presence.owner, .nearby)
        XCTAssertEqual(modes.mode, .files)
        XCTAssertEqual(nav.selectionWrites, 0)
    }
}
