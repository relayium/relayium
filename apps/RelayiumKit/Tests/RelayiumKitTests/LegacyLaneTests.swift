import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **Which legacy generation a peer that cannot speak `link/1` gets.**
///
/// The rule used to be two buttons on two screens. It is now one pure function
/// asked at two different moments — before a same-network session exists, and
/// after a pairing room's capability window closes — so the thing worth testing
/// is that the answer depends on the peer's announcement and on nothing else a
/// surface could accidentally supply.
final class LegacyLaneTests: XCTestCase {

    /// A peer that said `text/1` IS a text session. On the shipped native wire
    /// that announcement is only ever sent by one, so this is a statement rather
    /// than an inference.
    func testAnAnnouncedTextPeerGetsTheTextLane() {
        XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: true, hasArmedBatch: false), .text)
    }

    /// **Silence is a file peer, not a coin toss.** A legacy client with no
    /// announcement is one on the file generation by construction — `Mode.file`
    /// has no local capabilities — so answering it with a text offer would
    /// guarantee the one failure this decision exists to avoid.
    func testASilentPeerGetsTheFileLane() {
        XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: false, hasArmedBatch: false), .files)
    }

    /// An armed batch overrides the announcement in both directions. It is the
    /// user's stated intent and it is the one thing a text lane cannot carry at
    /// all.
    func testAnArmedBatchOverridesWhateverThePeerAnnounced() {
        XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: true, hasArmedBatch: true), .files)
        XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: false, hasArmedBatch: true), .files)
    }

    /// **The whole truth table**, so a later edit cannot change one arm while
    /// leaving the three tests above passing.
    func testTheCompleteTable() {
        let expected: [(text: Bool, armed: Bool, mode: TransferMode)] = [
            (false, false, .files),
            (true,  false, .text),
            (false, true,  .files),
            (true,  true,  .files),
        ]
        for row in expected {
            XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: row.text,
                                           hasArmedBatch: row.armed),
                           row.mode,
                           "announced text \(row.text), armed \(row.armed)")
        }
    }

    /// **A connect-first surface asks with `hasArmedBatch: false`, always** — it
    /// has nothing that could arm one — so the answer it gets is the peer's
    /// announcement and nothing else. Stated as its own case because it is the
    /// arm the macOS screens actually take, and because a surface that started
    /// passing `true` here would silently force every legacy peer onto the file
    /// lane including the ones that said they are text sessions.
    func testAConnectFirstSurfaceGetsExactlyThePeersAnswer() {
        for announced in [true, false] {
            XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: announced, hasArmedBatch: false),
                           announced ? .text : .files)
        }
    }
}

/// The roster carries the announcement a connect-first surface reads.
final class NearbyDeviceLegacyTextTests: XCTestCase {

    private func peer(_ id: String, _ name: String) -> Peer { Peer(id: id, name: name) }

    /// Both capability flags come from the room's own registry, per peer, and
    /// they are independent: a current client announces both, an older Web tab
    /// announces text alone, and a native file session announces neither.
    func testEachDeviceCarriesItsOwnTwoAnnouncements() {
        let devices = nearbyDevices(
            roster: [peer("both", "Current"), peer("text", "Old web"), peer("none", "File peer")],
            selfId: "me",
            supportsLink: { $0 == "both" },
            announcesLegacyText: { $0 == "both" || $0 == "text" })
        let byId = Dictionary(uniqueKeysWithValues: devices.map { ($0.id, $0) })
        XCTAssertEqual(byId["both"]?.supportsLink, true)
        XCTAssertEqual(byId["both"]?.announcesLegacyText, true)
        XCTAssertEqual(byId["text"]?.supportsLink, false)
        XCTAssertEqual(byId["text"]?.announcesLegacyText, true)
        XCTAssertEqual(byId["none"]?.supportsLink, false)
        XCTAssertEqual(byId["none"]?.announcesLegacyText, false)
    }

    /// **Unheard-from is false, never a default that guesses text.** A device in
    /// the roster that has not announced anything yet must resolve to the file
    /// lane, which is what a legacy file peer is; defaulting the other way would
    /// send a text offer to a client that will never answer it.
    func testAPeerWithNoAnnouncementDefaultsToNeitherCapability() {
        let devices = nearbyDevices(roster: [peer("quiet", "Quiet")], selfId: "me")
        XCTAssertEqual(devices.first?.announcesLegacyText, false)
        XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: devices.first?.announcesLegacyText ?? true,
                                       hasArmedBatch: false),
                       .files)
    }
}
