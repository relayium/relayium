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

    /// THE regression gate for this batch, stated as one executable claim: this
    /// build cannot advertise `link/1` and cannot route it, in any room.
    ///
    /// Everything above deliberately drives an INJECTED room predicate, because
    /// that is the only way to test the protocol at all while the feature is
    /// source-disabled. This test is the counterweight: it reads the real
    /// constant and the real composed predicate, so a change that flips
    /// `LINK_BUILD_SUPPORT` — or that quietly stops `linkRoomActive` from
    /// consulting it — fails here rather than shipping a half-built `link/1` to
    /// a real room.
    ///
    /// It is a gate, not an opinion about the feature: enabling `link/1` is
    /// meant to mean editing this expectation together with the constant, once
    /// byte-exact active-file transport recovery and the production driver and
    /// UI exist.
    func testThisBuildNeitherAdvertisesNorRoutesLink() {
        XCTAssertFalse(LINK_BUILD_SUPPORT,
                       "link/1 is not implemented end to end in this build")
        // Both room kinds, because the build flag is the outer term: a code-less
        // LAN room is exactly the room the feature would otherwise be live in.
        XCTAssertFalse(linkRoomActive(isCodelessRoom: true),
                       "the code-less room must stay inactive while the build cannot honour link/1")
        XCTAssertFalse(linkRoomActive(isCodelessRoom: false))

        for isCodelessRoom in [true, false] {
            let active = linkRoomActive(isCodelessRoom: isCodelessRoom)
            XCTAssertEqual(advertisedLinkCapabilities(linkRoomActive: active), [TEXT_CAPABILITY])
            XCTAssertEqual(peerCaps(from: linkCapsHello(linkRoomActive: active)), [TEXT_CAPABILITY])

            // And the routing predicate refuses even a peer that loudly claims
            // it — which is what a relay-forged roster entry looks like.
            let r = PeerCapabilityRegistry(linkRoomActive: { linkRoomActive(isCodelessRoom: isCodelessRoom) })
            XCTAssertTrue(r.record(peerId: "p1", signal: capsSignalValue([TEXT_CAPABILITY, LINK_CAPABILITY])))
            XCTAssertFalse(r.supports("p1", LINK_CAPABILITY),
                           "this build must never route link/1, code-less room: \(isCodelessRoom)")
            XCTAssertTrue(r.supports("p1", TEXT_CAPABILITY), "text/1 is unaffected by the gate")
        }
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
