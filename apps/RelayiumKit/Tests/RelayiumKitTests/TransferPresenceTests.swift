import XCTest
import Combine
@testable import RelayiumAppKit

/// Who presents the live session.
///
/// Nearby and Pairing code drive the SAME `RealtimeSessionModel` and
/// `RealtimeTextSessionModel`. Split across two destinations, both would render
/// one live session, each with its own Cancel — the hazard `DirectHubPane`'s
/// local `nearbySession` flag guarded against before this round. These
/// assertions are that flag generalized: exactly one owner, a refusal rather
/// than a takeover, and a release only the owner can perform.
///
/// Stated narrowly on purpose: this answers *which of two destinations renders
/// the session inside the unique window*, and nothing else. It is not a defence
/// against a second window — scene uniqueness is what makes that impossible.
@MainActor
final class TransferPresenceTests: XCTestCase {
    func testNobodyRendersASessionWhenIdle() {
        let p = TransferPresence()
        XCTAssertNil(p.owner)
        for d in AppDestination.allCases { XCTAssertFalse(p.rendersSession(d)) }
    }

    func testClaimIsIdempotentForTheOwner() {
        let p = TransferPresence()
        XCTAssertTrue(p.claim(.nearby, mode: .files))
        XCTAssertTrue(p.claim(.nearby, mode: .files))
        XCTAssertEqual(p.owner, .nearby)
    }

    func testBeginningANewSessionIsNotIdempotentForTheOwner() {
        let p = TransferPresence(mode: .files)
        XCTAssertTrue(p.beginSession(.nearby, mode: .text,
                                     peerLabel: "First device"))
        XCTAssertFalse(p.beginSession(.nearby, mode: .files,
                                      peerLabel: "Second device"),
                       "a second tap must not start a second session on the same surface")
        XCTAssertEqual(p.owner, .nearby)
        XCTAssertEqual(p.mode, .text)
        XCTAssertEqual(p.sessionPeerLabel, "First device")
    }

    func testASecondDestinationIsRefusedAndChangesNothing() {
        let p = TransferPresence()
        p.claim(.nearby, mode: .text)
        XCTAssertFalse(p.claim(.pairingCode, mode: .files))
        XCTAssertEqual(p.owner, .nearby)
        XCTAssertEqual(p.mode, .text)
    }

    func testNearbyClaimRetainsPeerLabelUntilTheSessionIsReleased() {
        let p = TransferPresence()
        XCTAssertTrue(p.claim(.nearby, mode: .files, peerLabel: "Studio Mac · 19af02"))
        XCTAssertEqual(p.sessionPeerLabel, "Studio Mac · 19af02")

        XCTAssertTrue(p.claim(.nearby, mode: .files),
                      "window reconstruction must keep an already-snapshotted label")
        XCTAssertEqual(p.sessionPeerLabel, "Studio Mac · 19af02")

        XCTAssertFalse(p.claim(.pairingCode, mode: .text, peerLabel: "Impostor"))
        XCTAssertEqual(p.sessionPeerLabel, "Studio Mac · 19af02")

        p.release(.nearby)
        XCTAssertNil(p.sessionPeerLabel)
    }

    func testUserModeSelectionStopsAtTheOwnershipBoundary() {
        let p = TransferPresence(mode: .files)
        p.selectMode(.text)
        XCTAssertEqual(p.mode, .text)

        XCTAssertTrue(p.claim(.nearby, mode: .text))
        p.selectMode(.files)
        XCTAssertEqual(p.mode, .text,
                       "a claimed session must not be hidden before its model starts")

        p.release(.nearby)
        p.selectMode(.files)
        XCTAssertEqual(p.mode, .files)
    }

    func testInitialIdleObservationCannotEraseALaterClaimBeforeModelStart() {
        let p = TransferPresence()
        let liveness = PassthroughSubject<Bool, Never>()
        p.observeSessionLiveness(liveness.eraseToAnyPublisher())

        liveness.send(false)
        XCTAssertTrue(p.claim(.pairingCode, mode: .text))
        XCTAssertEqual(p.owner, .pairingCode,
                       "the already-observed idle baseline must not race a fresh claim")

        liveness.send(true)
        XCTAssertEqual(p.owner, .pairingCode)
        liveness.send(false)
        XCTAssertNil(p.owner, "the real live-to-idle edge must release retained ownership")
    }

    func testExactlyOneDestinationRendersTheSession() {
        let p = TransferPresence()
        p.claim(.pairingCode, mode: .files)
        XCTAssertEqual(AppDestination.allCases.filter { p.rendersSession($0) }, [.pairingCode])
    }

    func testOnlyTheOwnerCanReleaseAndReleaseAllAlwaysClears() {
        let p = TransferPresence()
        p.claim(.nearby, mode: .files)
        p.release(.pairingCode)
        XCTAssertEqual(p.owner, .nearby, "a non-owner must not be able to clear the session")
        p.release(.nearby)
        XCTAssertNil(p.owner)
        p.claim(.pairingCode, mode: .text); p.releaseAll()
        XCTAssertNil(p.owner)
    }

    /// Ownership survives a session finishing, and that is the point.
    ///
    /// `NearbyPane` draws the session surface — including the terminal result
    /// with Reveal in Finder and the drag-out promise — only while presence says
    /// this destination owns it. So `.completed` must NOT release: a presence
    /// that let go the moment bytes stopped moving would replace the result the
    /// user is about to act on with the device roster. Whether the transfer is
    /// still *running* is a different question, answered by the models rather
    /// than duplicated here; see `SidebarView.hasLiveSession`.
    func testOwnershipIsNotGivenUpWhenASessionFinishes() {
        let p = TransferPresence()
        p.claim(.nearby, mode: .files)
        // Nothing about a session ending reaches this object; only `.idle` does,
        // through the destinations' reconciliation.
        XCTAssertTrue(p.rendersSession(.nearby),
                      "the terminal result must keep the surface that is drawing it")
    }

    /// The sidebar's live marker is a claim about the TRANSFER, not about the
    /// surface, so it takes both facts and stores neither.
    ///
    /// Ownership alone was the old answer, and it was wrong for the whole life
    /// of a terminal result: a finished receive kept `nav.a11yLiveSession` — "A
    /// transfer is running here" — on its row while the user read "Transfer
    /// complete". Telling a VoiceOver user bytes are moving when none are is
    /// misleading state, which `PROJECT-GOVERNANCE.md` § Quality treats as
    /// blocking.
    ///
    /// The activity fact is a parameter rather than a stored property on
    /// purpose: `RealtimeSessionModel.isBusy` already answers it, and a second
    /// copy here would be free to disagree with the models it claims to describe.
    func testTheRunningMarkerNeedsBothOwnershipAndAnActuallyBusySession() {
        let p = TransferPresence()
        p.claim(.nearby, mode: .files)

        XCTAssertTrue(p.announcesRunningTransfer(.nearby, sessionIsBusy: true))
        XCTAssertFalse(p.announcesRunningTransfer(.nearby, sessionIsBusy: false),
                       "a completed or failed session must not be announced as running")
        XCTAssertFalse(p.announcesRunningTransfer(.pairingCode, sessionIsBusy: true),
                       "only the row that owns the session may carry the marker")
        XCTAssertTrue(p.rendersSession(.nearby),
                      "and none of that gives up the surface drawing the result")
    }

    /// With nobody owning a session, no row is marked however busy a model
    /// claims to be.
    func testNoRowIsMarkedRunningWithoutAnOwner() {
        let p = TransferPresence()
        for d in AppDestination.allCases {
            XCTAssertFalse(p.announcesRunningTransfer(d, sessionIsBusy: true))
        }
    }

    func testIncomingClaimsNearbyAndSetsTheModeFromItsKind() {
        for (kind, mode) in [(NearbyReceiveKind.file, TransferMode.files), (.text, .text)] {
            let p = TransferPresence()
            XCTAssertTrue(p.claim(AppRouting.destination(forIncoming: kind), mode: mode))
            XCTAssertEqual(p.owner, .nearby)
            XCTAssertEqual(p.mode, mode)
        }
    }

    // MARK: - R3-F: claiming without answering the mode question

    /// iOS keeps the files-or-text answer in `DirectModeSelection`, which is
    /// where R3-E's lock lives. A claim there must therefore take ownership
    /// **without** writing a second copy of that answer — two copies of one
    /// answer are free to disagree, and the disagreement would show up as a tab
    /// rendering the wrong half of a session it does own.
    func testClaimingWithoutAModeLeavesTheModeExactlyWhereItWas() {
        let p = TransferPresence(mode: .text)
        XCTAssertTrue(p.claim(.nearby))
        XCTAssertEqual(p.owner, .nearby)
        XCTAssertEqual(p.mode, .text, "an ownership claim answered a question it was not asked")
    }

    /// Same arbitration as the mode-carrying claim: idempotent for the owner,
    /// refused for anybody else, and a refusal changes nothing at all.
    func testClaimingWithoutAModeIsIdempotentForTheOwnerAndRefusedForAnyoneElse() {
        let p = TransferPresence(mode: .files)
        XCTAssertTrue(p.claim(.nearby))
        XCTAssertTrue(p.claim(.nearby), "the owner must be able to re-claim its own session")
        XCTAssertFalse(p.claim(.pairingCode))
        XCTAssertEqual(p.owner, .nearby)
        XCTAssertEqual(p.mode, .files)
    }


    func testBeginningWithoutAModeAlsoRequiresAnUnownedSurface() {
        let p = TransferPresence(mode: .text)
        XCTAssertTrue(p.beginSession(.pairingCode))
        XCTAssertFalse(p.beginSession(.pairingCode))
        XCTAssertEqual(p.owner, .pairingCode)
        XCTAssertEqual(p.mode, .text)
    }
}
