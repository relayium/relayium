import XCTest
@testable import RelayiumKit

/// What each peer in the room has told us it can speak.
///
/// This is a HINT, never a security input — the signalling relay sees every
/// frame and can strip one (denial of service) or forge one (we invite a peer
/// that cannot answer: also denial of service). It can never make plaintext
/// leave this device, because the session keys are derived, not negotiated.
///
/// What it must do exactly is scope and expiry: an announcement belongs to one
/// peer id in one room epoch, and both of those end.
final class PeerCapabilityRegistryTests: XCTestCase {

    private func registry(roomActive: Bool = true) -> PeerCapabilityRegistry {
        PeerCapabilityRegistry(linkRoomActive: { roomActive })
    }

    // MARK: - recording

    func testRecordsAnExactCapabilityList() {
        let r = registry()
        XCTAssertTrue(r.record(peerId: "p1", signal: capsSignalValue([TEXT_CAPABILITY, LINK_CAPABILITY])))
        XCTAssertTrue(r.supports("p1", LINK_CAPABILITY))
        XCTAssertTrue(r.supports("p1", TEXT_CAPABILITY))
    }

    /// Exact match, deliberately: a later wire-incompatible dialect must not be
    /// read as this one.
    func testCapabilityMatchIsExactNotPrefix() {
        let r = registry()
        _ = r.record(peerId: "p1", signal: capsSignalValue(["link/2", "link/10", "link"]))
        XCTAssertFalse(r.supports("p1", LINK_CAPABILITY))
    }

    func testUnknownPeerSupportsNothing() {
        XCTAssertFalse(registry().supports("never-seen", LINK_CAPABILITY))
    }

    /// A frame we do not understand is not "a peer with no capabilities": it is
    /// not a caps hello at all, and must leave an earlier announcement standing.
    func testNonHelloFramesAreNotHellosAndDoNotRevoke() {
        let r = registry()
        _ = r.record(peerId: "p1", signal: capsSignalValue([LINK_CAPABILITY]))
        XCTAssertFalse(r.record(peerId: "p1", signal: .object(["relayRtt": .number(12)])))
        XCTAssertFalse(r.record(peerId: "p1", signal: .object(["caps": .string("link/1")])))
        XCTAssertFalse(r.record(peerId: "p1", signal: .array([.string(LINK_CAPABILITY)])))
        XCTAssertFalse(r.record(peerId: "p1", signal: .null))
        XCTAssertTrue(r.supports("p1", LINK_CAPABILITY))
    }

    /// Peer-authored input on an untrusted channel: non-string entries are
    /// dropped rather than trusted, and the frame is still a hello.
    func testMalformedEntriesAreDroppedNotThrown() {
        let r = registry()
        XCTAssertTrue(r.record(peerId: "p1", signal: .object(["caps": .array([
            .string(LINK_CAPABILITY), .number(7), .bool(true), .null,
        ])])))
        XCTAssertTrue(r.supports("p1", LINK_CAPABILITY))
    }

    // MARK: - revocation

    /// A later EMPTY snapshot revokes. A peer that reloaded into a pairing-code
    /// room announces `[]`, and continuing to route link traffic at it would
    /// strand every intent until the roster changed.
    func testLaterEmptySnapshotRevokes() {
        let r = registry()
        _ = r.record(peerId: "p1", signal: capsSignalValue([TEXT_CAPABILITY, LINK_CAPABILITY]))
        XCTAssertTrue(r.record(peerId: "p1", signal: capsSignalValue([])))
        XCTAssertFalse(r.supports("p1", LINK_CAPABILITY))
    }

    func testSnapshotReplacesRatherThanMerges() {
        let r = registry()
        _ = r.record(peerId: "p1", signal: capsSignalValue([TEXT_CAPABILITY, LINK_CAPABILITY]))
        _ = r.record(peerId: "p1", signal: capsSignalValue([TEXT_CAPABILITY]))
        XCTAssertFalse(r.supports("p1", LINK_CAPABILITY))
        XCTAssertTrue(r.supports("p1", TEXT_CAPABILITY))
    }

    // MARK: - scope and expiry

    func testDepartedPeersAreDiscarded() {
        let r = registry()
        _ = r.record(peerId: "p1", signal: capsSignalValue([LINK_CAPABILITY]))
        _ = r.record(peerId: "p2", signal: capsSignalValue([LINK_CAPABILITY]))
        r.retain(["p2"])
        XCTAssertFalse(r.supports("p1", LINK_CAPABILITY))
        XCTAssertTrue(r.supports("p2", LINK_CAPABILITY))
    }

    /// A reconnecting peer is issued a fresh id by the hub, so nothing stale
    /// can be inherited — but a room epoch change must not leave the previous
    /// room's announcements answering for ids in the new one.
    func testRoomEpochChangeDiscardsEverything() {
        let r = registry()
        _ = r.record(peerId: "p1", signal: capsSignalValue([LINK_CAPABILITY]))
        r.reset()
        XCTAssertFalse(r.supports("p1", LINK_CAPABILITY))
    }

    /// Room scope is enforced at the PREDICATE, not only at the announcement.
    /// Refusing to *say* `link/1` in a pairing-code room is worth nothing on
    /// its own: a relay can inject a roster claim, so the routing predicate
    /// every decision reads has to be the thing that refuses.
    func testForgedCapabilityCannotActivateLinkOutsideACodelessRoom() {
        let r = registry(roomActive: false)
        XCTAssertTrue(r.record(peerId: "p1", signal: capsSignalValue([LINK_CAPABILITY])))
        XCTAssertFalse(r.supports("p1", LINK_CAPABILITY),
                       "a code room must never route link/1, however loudly a peer claims it")
        // text/1 is unaffected: it is not room-scoped.
        _ = r.record(peerId: "p1", signal: capsSignalValue([TEXT_CAPABILITY]))
        XCTAssertTrue(r.supports("p1", TEXT_CAPABILITY))
    }

    // MARK: - what this build announces

    func testAdvertisedCapabilitiesAreRoomScoped() {
        XCTAssertEqual(advertisedLinkCapabilities(linkRoomActive: true),
                       [TEXT_CAPABILITY, LINK_CAPABILITY])
        XCTAssertEqual(advertisedLinkCapabilities(linkRoomActive: false), [TEXT_CAPABILITY])
    }

    // MARK: - the gate on this incomplete foundation

    /// THE regression gate for the delivered scope, stated as one executable
    /// claim: on macOS this build implements `link/1` and announces and routes
    /// it in EVERY room; on any other platform it does neither, anywhere.
    ///
    /// Both halves matter and both used to be wrong in the other direction. The
    /// room half was code-less-only while a pairing code had no room object
    /// above `RealtimeConnectionFactory`; `LinkPairingRoom` gave it one, with the
    /// socket shared by the link and by the legacy fallback, and `RelayDeadline`
    /// bounded the credential a relayed link runs on. The platform half is the
    /// one that must never be widened by accident: `RelayiumKit` is linked by
    /// both apps and `LanDiscoveryModel` announces on both, so a cross-platform
    /// `true` would have an iPhone inviting peers into a link it cannot answer.
    func testThisBuildAdvertisesLinkOnEveryRoomOnMacOSAndNowhereElse() {
        #if os(macOS)
        XCTAssertTrue(LINK_BUILD_SUPPORT,
                      "macOS composes link/1 through LinkWorkspaceModel")
        #else
        XCTAssertFalse(LINK_BUILD_SUPPORT,
                       "no other platform composes link/1, so none may announce it")
        #endif

        // Every room, on this platform's answer — the parameter is where a
        // future room kind states its own, not a scope this batch still applies.
        for isCodelessRoom in [true, false] {
            let active = linkRoomActive(isCodelessRoom: isCodelessRoom)
            XCTAssertEqual(active, LINK_BUILD_SUPPORT,
                           "the room rule is the build rule, room: \(isCodelessRoom)")
            XCTAssertEqual(advertisedLinkCapabilities(linkRoomActive: active),
                           active ? [TEXT_CAPABILITY, LINK_CAPABILITY] : [TEXT_CAPABILITY])
            XCTAssertEqual(peerCaps(from: linkCapsHello(linkRoomActive: active)),
                           active ? [TEXT_CAPABILITY, LINK_CAPABILITY] : [TEXT_CAPABILITY])

            let registry = PeerCapabilityRegistry(
                linkRoomActive: { linkRoomActive(isCodelessRoom: isCodelessRoom) })
            XCTAssertTrue(registry.record(peerId: "p1",
                                          signal: capsSignalValue([TEXT_CAPABILITY, LINK_CAPABILITY])))
            XCTAssertEqual(registry.supports("p1", LINK_CAPABILITY), active)
            XCTAssertTrue(registry.supports("p1", TEXT_CAPABILITY),
                          "text/1 is unaffected by the link scope")
        }

        // Exactness is the whole downgrade boundary, and it did not move.
        let legacy = PeerCapabilityRegistry(linkRoomActive: { true })
        XCTAssertTrue(legacy.record(peerId: "old", signal: capsSignalValue([TEXT_CAPABILITY])))
        XCTAssertFalse(legacy.supports("old", LINK_CAPABILITY),
                       "a peer that announced only text/1 is legacy in every room")
        let future = PeerCapabilityRegistry(linkRoomActive: { true })
        XCTAssertTrue(future.record(peerId: "next",
                                    signal: capsSignalValue([TEXT_CAPABILITY, "link/2"])))
        XCTAssertFalse(future.supports("next", LINK_CAPABILITY),
                       "link/2 is a different wire and must never be read as this one")
    }

    /// The platform gate, pinned as SOURCE as well as value.
    ///
    /// The test above can only ever run on macOS, so on its own it proves
    /// nothing about the iOS build. This reads the constant's own definition and
    /// requires the conditional to be there — which is the only thing that stops
    /// a later edit from collapsing it to one cross-platform `true` and shipping
    /// an announcement iOS cannot honour.
    func testTheBuildFlagIsCompiledPerPlatform() throws {
        let source = try registrySource()
        // The exact three lines, in order, with nothing between them: the
        // conditional IS the guarantee, so a partial match would let an edit
        // leave the directive standing while both branches said true.
        let expected = """
        #if os(macOS)
        public let LINK_BUILD_SUPPORT = true
        #else
        public let LINK_BUILD_SUPPORT = false
        #endif
        """.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let lines = source.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let start = lines.firstIndex(of: expected[0]) else {
            return XCTFail("LINK_BUILD_SUPPORT must be compiled per platform")
        }
        XCTAssertEqual(Array(lines[start..<min(start + expected.count, lines.count)]),
                       expected,
                       "LINK_BUILD_SUPPORT must be true on macOS and false everywhere else")
    }

    /// The constant's own file, read raw: this assertion is ABOUT the
    /// preprocessor directives, so a comment-stripping reader would be reading
    /// something other than what compiles.
    private func registrySource() throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RelayiumKit/Realtime/PeerCapabilityRegistry.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Transport replacement is a SEPARATE decision and this batch did not make
    /// it. A link whose transport dies is terminal, and the Workspace says so
    /// rather than implying a recovery no code performs.
    func testTransportReplacementRemainsUnsupported() {
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
    }

    /// One expression feeds both the roster hello and the per-connection SDP
    /// confirmation, so the two announcements cannot disagree.
    func testCapsHelloCarriesExactlyTheAdvertisedList() {
        let hello = linkCapsHello(linkRoomActive: true)
        XCTAssertEqual(peerCaps(from: hello), [TEXT_CAPABILITY, LINK_CAPABILITY])
        let registry = registry()
        XCTAssertTrue(registry.record(peerId: "self-echo", signal: hello))
    }
}

/// The roster-level hello shape both peers exchange, built the way the web's
/// `capsSignal()` does.
private func capsSignalValue(_ caps: [String]) -> JSONValue {
    .object(["caps": .array(caps.map(JSONValue.string))])
}
