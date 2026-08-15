import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// What the iOS Nearby tab offers before a connection exists, driven directly
/// rather than through a simulator.
///
/// The rules here are small, and that is the point: each of them removes or
/// keeps one control, and a UI test proving "the picker is not on screen" costs
/// a simulator launch and tells you nothing about WHY it was not.
final class NearbyConnectPresentationTests: XCTestCase {

    private func device(supportsLink: Bool = false,
                        announcesLegacyText: Bool = false) -> NearbyDevice {
        NearbyDevice(id: "peer-1", name: "Studio Mac", label: "Studio Mac",
                     supportsLink: supportsLink,
                     announcesLegacyText: announcesLegacyText)
    }

    // MARK: - the picker

    /// The whole point of the batch, as one assertion: a connection that carries
    /// messages and files at once has no halves to pick between.
    func testALinkPeerIsOfferedNoFilesOrTextPicker() {
        XCTAssertEqual(NearbyConnectPresentation.sendChoice(for: device(supportsLink: true)),
                       .unifiedLink)
        XCTAssertFalse(NearbyConnectPresentation.showsModePicker(for: device(supportsLink: true)),
                       "the picker asks a question a link/1 connection has no answer to")
    }

    /// And nothing else lost it. A legacy peer really does have two
    /// non-interoperating generations behind it, so the control that chooses
    /// between them stays.
    func testALegacyPeerKeepsThePicker() {
        XCTAssertEqual(NearbyConnectPresentation.sendChoice(for: device()), .legacyLanes)
        XCTAssertTrue(NearbyConnectPresentation.showsModePicker(for: device()))
        XCTAssertTrue(NearbyConnectPresentation.showsModePicker(
            for: device(announcesLegacyText: true)))
    }

    /// **No device chosen is not a third state**, and answering `unifiedLink`
    /// there would be worse than useless: the picker would then APPEAR when a
    /// legacy device was tapped, which reads as the app changing its mind about
    /// what it is.
    func testNoChosenDeviceKeepsTheShippedSurface() {
        XCTAssertEqual(NearbyConnectPresentation.sendChoice(for: nil), .legacyLanes)
        XCTAssertTrue(NearbyConnectPresentation.showsModePicker(for: nil))
    }

    // MARK: - staging

    /// iOS still stages before connecting, on BOTH products. For a link peer the
    /// batch is armed on the connection; for a legacy one it is the file lane's,
    /// exactly as it shipped.
    func testStagingIsOfferedToALinkPeerWhateverTheStalePickerSaysToo() {
        for mode in TransferMode.allCases {
            XCTAssertTrue(
                NearbyConnectPresentation.showsStaging(for: device(supportsLink: true),
                                                       mode: mode),
                "a link peer can always be handed a batch, mode: \(mode)")
        }
    }

    /// A legacy peer's staging is still gated on the picker, because for it the
    /// text lane genuinely cannot carry a file.
    func testALegacyPeersStagingStillFollowsThePicker() {
        XCTAssertTrue(NearbyConnectPresentation.showsStaging(for: device(), mode: .files))
        XCTAssertFalse(NearbyConnectPresentation.showsStaging(for: device(), mode: .text),
                       "a legacy text lane cannot carry a batch, so nothing may be staged for it")
    }

    // MARK: - the legacy lane

    /// A link peer has no lane, and saying so with `nil` rather than a default
    /// is what stops a caller acting on a value that means nothing.
    func testALinkPeerHasNoLegacyLane() {
        XCTAssertNil(NearbyConnectPresentation.legacyMode(for: device(supportsLink: true),
                                                          hasStagedBatch: false))
        XCTAssertNil(NearbyConnectPresentation.legacyMode(for: device(supportsLink: true),
                                                          hasStagedBatch: true))
        XCTAssertNil(NearbyConnectPresentation.legacyMode(for: nil, hasStagedBatch: false))
    }

    /// And a legacy peer's lane is `LegacyLane`'s answer rather than a second
    /// copy of the rule — which is the drift `LegacyLane` itself exists to stop,
    /// now across two platforms as well as two surfaces.
    func testALegacyPeersLaneIsTheSharedRule() {
        for announcesText in [true, false] {
            for staged in [true, false] {
                XCTAssertEqual(
                    NearbyConnectPresentation.legacyMode(
                        for: device(announcesLegacyText: announcesText),
                        hasStagedBatch: staged),
                    LegacyLane.mode(peerAnnouncesText: announcesText, hasArmedBatch: staged),
                    "text: \(announcesText), staged: \(staged)")
            }
        }
        // Spelled out for the one case a reader would want stated: a staged
        // batch wins over the peer's own text announcement, because a text lane
        // cannot carry it at all.
        XCTAssertEqual(NearbyConnectPresentation.legacyMode(
            for: device(announcesLegacyText: true), hasStagedBatch: true), .files)
    }

    // MARK: - which pane

    /// The pane rule is shared with macOS and iOS now uses it. Ownership alone
    /// decides WHETHER a session is drawn; the link only decides WHICH.
    func testTheLinkNeverPutsASessionOnATabThatDoesNotOwnIt() {
        XCTAssertEqual(TransferSurfacePresentation.pane(route: .nearby, owner: nil,
                                                        linkHasSession: true),
                       .connect,
                       "an unowned surface draws its connect controls whatever the link holds")
        XCTAssertEqual(TransferSurfacePresentation.pane(route: .nearby, owner: .pairingCode,
                                                        linkHasSession: true),
                       .connect)
        XCTAssertEqual(TransferSurfacePresentation.pane(route: .nearby, owner: .nearby,
                                                        linkHasSession: true),
                       .link)
        XCTAssertEqual(TransferSurfacePresentation.pane(route: .nearby, owner: .nearby,
                                                        linkHasSession: false),
                       .legacySession)
    }
}
