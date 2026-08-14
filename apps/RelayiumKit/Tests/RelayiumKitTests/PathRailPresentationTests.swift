import AppKit
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// **What the path rail is allowed to claim.**
///
/// The rail is the round's one shared visual signature, and a route diagram is
/// the easiest thing in an interface to make dishonest: a step drawn as finished
/// costs nothing to render and is read as fact. Every assertion here is about a
/// claim rather than about a layout — the layout is guarded separately, in
/// `MacSurfaceGuardTests`, and neither substitutes for the other.
final class PathRailPresentationTests: XCTestCase {

    // MARK: - Send a link: the one rail with real progress

    /// Nothing chosen is step one, and step one is not finished.
    func testAnEmptyStoredSendClaimsNoCompletedStep() {
        let stops = PathRailPresentation.storedSend(.idle, language: .en)
        XCTAssertEqual(stops.map(\.progress), [.current, .pending, .pending])
    }

    /// A chosen selection is still on step one: the encryption and the upload
    /// have not started, and the model says so.
    func testChoosingFilesDoesNotAdvancePastTheChoosingStep() {
        let picked = UploadState.picked([])
        XCTAssertEqual(PathRailPresentation.storedSend(picked, language: .en).map(\.progress),
                       [.current, .pending, .pending])
    }

    /// Bytes moving is the middle step, and only the first is behind it.
    func testAnUploadInFlightMarksExactlyTheStepBehindItAsReached() {
        let stops = PathRailPresentation.storedSend(.uploading(sent: 3, total: 10), language: .en)
        XCTAssertEqual(stops.map(\.progress), [.reached, .current, .pending])
        // Preparing and restarting are the same claim: work started, nothing
        // finished. A separate mapping for either is how they drift.
        for state in [UploadState.preparing, .restarting,
                      .interrupted(files: 1, bytes: 2, message: nil)] {
            XCTAssertEqual(PathRailPresentation.storedSend(state, language: .en).map(\.progress),
                           [.reached, .current, .pending],
                           "\(state) is not the middle step")
        }
    }

    /// **The failure case, which is the whole reason this is a tested seam.**
    ///
    /// A failed upload has usually moved real bytes, and crediting the upload
    /// step for them would draw a finished tick over a task that did not
    /// finish. The user is back at the step they can retry, and the rail says
    /// exactly that.
    func testAFailedUploadNeverCreditsTheBytesThatMoved() {
        let stops = PathRailPresentation.storedSend(.failed("boom"), language: .en)
        XCTAssertEqual(stops.map(\.progress), [.current, .pending, .pending])
        XCTAssertFalse(stops.contains { $0.progress == .reached },
                       "a failure left a completed step on screen")
    }

    /// Only a finished upload marks the middle step reached, and the last step —
    /// somebody actually opening the link — is never claimed at all.
    func testOnlyAFinishedUploadMarksTheStoredStepReached() {
        let done = UploadState.done(link: "https://relayium.com/d/x#k=y",
                                    expiresAt: 0, keyWarning: nil)
        let stops = PathRailPresentation.storedSend(done, language: .en)
        XCTAssertEqual(stops.map(\.progress), [.reached, .reached, .current])
        XCTAssertNotEqual(stops.last?.progress, .reached,
                          "the rail claims somebody has downloaded the link")
    }

    // MARK: - the rails that claim nothing

    /// The Device Inbox is a standing route, not a task with a position, so
    /// every stop is unclaimed.
    func testTheDeviceInboxRailStatesARouteAndNoProgress() {
        let stops = PathRailPresentation.deviceInbox(language: .en)
        XCTAssertEqual(stops.count, 3)
        XCTAssertTrue(stops.allSatisfy { $0.progress == nil },
                      "a standing route is being drawn as a task in progress")
        XCTAssertEqual(stops.last?.title, L10n.t(.pathThisMac, language: .en))
    }

    /// **The rail states the route and no stop restates the receive folder.**
    ///
    /// The destination stop used to carry `InboxFolderPresentation.description`,
    /// which put "No folder chosen" — or the folder's name — on screen twice:
    /// once in `caption2` under the rail, where nothing could be done about it,
    /// and once in the folder section that owns the fact and the two buttons
    /// that change it. Asserted as an absence, because that is what regressed:
    /// a `detail` on any stop of this rail is a second answer to a question one
    /// section already answers.
    func testTheDeviceInboxRailDoesNotRestateTheReceiveFolder() {
        let chosen = InboxFolderSummary(
            url: URL(fileURLWithPath: "/Users/someone/Deliveries", isDirectory: true),
            isChosen: true, problem: nil)
        for language in AppLanguage.allCases {
            let stops = PathRailPresentation.deviceInbox(language: language)
            XCTAssertTrue(stops.allSatisfy { $0.detail == nil },
                          "\(language.rawValue) rail carries a detail the sections own")
            // Neither spelling of the folder fact reaches the rail, whether or
            // not one has been chosen.
            let words = stops.compactMap(\.detail).joined(separator: " ")
            for restated in [InboxFolderPresentation.description(.none, language: language),
                             InboxFolderPresentation.description(chosen, language: language)] {
                XCTAssertFalse(words.contains(restated),
                               "\(language.rawValue) rail repeats the folder section")
            }
        }
    }

    /// The cross-network rail is drawn before a peer exists, so there is nothing
    /// to be part-way through — and its middle stop says encrypted and stops
    /// there, because this client cannot tell a direct connection from a relayed
    /// one at the moment it draws.
    func testTheCrossNetworkRailNamesNoRouteItCannotProve() {
        let stops = PathRailPresentation.crossNetwork(language: .en)
        XCTAssertEqual(stops.count, 3)
        XCTAssertTrue(stops.allSatisfy { $0.progress == nil })
        XCTAssertEqual(stops[1].title, L10n.t(.pathEncryptedConnection, language: .en))
        let words = stops.map(\.title).joined(separator: " ").lowercased()
        for guess in ["direct", "peer-to-peer", "peer to peer", "relay"] {
            XCTAssertFalse(words.contains(guess),
                           "the rail guesses a route this build cannot observe: \(guess)")
        }
    }

    func testTheLanRailStatesAnEncryptedRouteWithoutInventingProgress() {
        let stops = PathRailPresentation.lan(language: .en)
        XCTAssertEqual(stops.count, 3)
        XCTAssertTrue(stops.allSatisfy { $0.progress == nil })
        XCTAssertEqual(stops[1].title, L10n.t(.pathEncryptedConnection, language: .en))
    }

    // MARK: - the same rails, from a device that is not a Mac

    /// **The one word that could be false on iOS, and the reason the iOS rails
    /// exist at all.**
    ///
    /// `path.thisMac` renders "This Mac" — true on the four macOS rails and a
    /// plain lie on an iPhone. Every iOS rail's origin therefore comes from
    /// `path.thisDevice`, and none of them may reach the Mac string.
    func testEveryIOSRailNamesTheDeviceItIsActuallyDrawnOn() {
        for language in AppLanguage.allCases {
            let rails = [PathRailPresentation.iosStoredSend(.idle, language: language),
                         PathRailPresentation.iosDeviceSend(language: language),
                         PathRailPresentation.iosNearby(language: language)]
            for stops in rails {
                XCTAssertEqual(stops.first?.title, L10n.t(.pathThisDevice, language: language),
                               "an iOS rail does not start at this device")
                XCTAssertFalse(stops.contains { $0.title == L10n.t(.pathThisMac, language: .en) },
                               "an iOS rail tells an iPhone user it is a Mac")
                XCTAssertFalse(stops.contains { $0.title.hasPrefix("path.") },
                               "\(language.rawValue) fell back to a raw rail key")
            }
        }
        // English is the fallback for the seven frozen catalogs, so the sentence
        // a frozen locale renders is still a sentence rather than a key.
        XCTAssertEqual(L10n.t(.pathThisDevice, language: .ja),
                       L10n.t(.pathThisDevice, language: .en))
    }

    /// The stored-send rail's progress is the macOS function's, not a second
    /// copy that can advance differently on one platform.
    func testTheIOSStoredSendRailAdvancesExactlyAsTheMacsDoes() {
        let states: [UploadState] = [.idle, .picked([]), .preparing,
                                     .uploading(sent: 1, total: 2), .restarting,
                                     .failed("boom"),
                                     .done(link: "x", expiresAt: 0, keyWarning: nil)]
        for state in states {
            XCTAssertEqual(PathRailPresentation.iosStoredSend(state).map(\.progress),
                           PathRailPresentation.storedSend(state).map(\.progress),
                           "\(state) advances differently on iOS")
        }
    }

    /// Both standing routes claim no position at all: the nearby rail is drawn
    /// while the roster is still being chosen from, and the device-send rail
    /// while nothing has been handed over.
    func testTheIOSStandingRoutesInventNoProgress() {
        for stops in [PathRailPresentation.iosNearby(language: .en),
                      PathRailPresentation.iosDeviceSend(language: .en)] {
            XCTAssertEqual(stops.count, 3)
            XCTAssertTrue(stops.allSatisfy { $0.progress == nil },
                          "a standing route claims a position")
        }
        XCTAssertEqual(PathRailPresentation.iosNearby(language: .en)[1].title,
                       L10n.t(.pathEncryptedConnection, language: .en))
        // A delivery to one of your own devices waits on Relayium as ciphertext;
        // a nearby transfer never does. Two different middles, deliberately.
        XCTAssertEqual(PathRailPresentation.iosDeviceSend(language: .en)[1].title,
                       L10n.t(.pathEncryptedOnRelayium, language: .en))
    }

    /// The sender's rail is not the receiver's turned around.
    func testTheDeviceSendRailIsNotTheInboxRailBackwards() {
        let sending = PathRailPresentation.iosDeviceSend(language: .en)
        let receiving = PathRailPresentation.deviceInbox(language: .en)
        XCTAssertNotEqual(sending.map(\.title), receiving.map(\.title),
                          "the sending device is drawn at the end of its own delivery")
        XCTAssertEqual(receiving.first?.title, L10n.t(.pathYourAccount, language: .en))
    }

    // MARK: - the vocabulary itself

    /// Every rail label is a real catalog string in every language, not an
    /// English literal that happens to render.
    func testEveryRailLabelIsLocalizedInEveryLanguage() {
        for language in AppLanguage.allCases {
            let all = PathRailPresentation.storedSend(.idle, language: language)
                + PathRailPresentation.deviceInbox(language: language)
                + PathRailPresentation.crossNetwork(language: language)
                + PathRailPresentation.lan(language: language)
                + PathRailPresentation.iosStoredSend(.idle, language: language)
                + PathRailPresentation.iosDeviceSend(language: language)
                + PathRailPresentation.iosNearby(language: language)
            for stop in all {
                XCTAssertFalse(stop.title.isEmpty,
                               "\(language.rawValue) has an empty rail label")
                XCTAssertFalse(stop.title.hasPrefix("path."),
                               "\(language.rawValue) fell back to the raw key: \(stop.title)")
            }
            XCTAssertFalse(PathRailPresentation.routeLabel(language: language).isEmpty)
        }
    }

    /// **Every symbol the rail draws actually exists on this platform.**
    ///
    /// A missing SF Symbol renders as nothing at all, silently, and the stop
    /// keeps its label — so the rail looks merely plain rather than broken, and
    /// a screenshot review would not necessarily catch it.
    func testEveryRailSymbolResolvesOnThisSystem() {
        let done = UploadState.done(link: "x", expiresAt: 0, keyWarning: nil)
        let all = PathRailPresentation.storedSend(.idle)
            + PathRailPresentation.storedSend(done)
            + PathRailPresentation.deviceInbox()
            + PathRailPresentation.crossNetwork()
            + PathRailPresentation.lan()
            + PathRailPresentation.iosStoredSend(.idle)
            + PathRailPresentation.iosStoredSend(done)
            + PathRailPresentation.iosDeviceSend()
            + PathRailPresentation.iosNearby()
        // The checkmark the view substitutes for a reached stop's own symbol.
        let symbols = Set(all.map(\.symbol)).union(["checkmark"])
        for symbol in symbols {
            XCTAssertNotNil(NSImage(systemSymbolName: symbol, accessibilityDescription: nil),
                            "no such SF Symbol on this system: \(symbol)")
        }
    }

    /// Both the sidebar row and the destination header draw a surface's symbol
    /// from `MacSurface`, so the row and the screen it opens cannot drift apart.
    func testEverySurfaceSymbolResolvesOnThisSystem() {
        for surface in MacSurface.allCases {
            XCTAssertNotNil(NSImage(systemSymbolName: surface.symbol,
                                    accessibilityDescription: nil),
                            "\(surface.rawValue) names an SF Symbol that does not exist")
        }
    }
}
