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
    /// claim: **both** apps implement `link/1`; macOS announces and routes it in
    /// every room, and iOS in the code-less room ONLY.
    ///
    /// Both halves matter and both have been wrong in the other direction. The
    /// room half was code-less-only on macOS while a pairing code had no room
    /// object above `RealtimeConnectionFactory`; `LinkPairingRoom` gave it one,
    /// with the socket shared by the link and by the legacy fallback, and
    /// `RelayDeadline` bounded the credential a relayed link runs on. The
    /// platform half used to be the whole boundary — iOS composed nothing — and
    /// is now one room narrower rather than absent: `AppEnvironment`'s iOS link
    /// factory takes no room handle, so nothing on that platform can join a code
    /// room as a link, and announcing there would be exactly the promise-it-
    /// cannot-keep this gate has always existed to prevent.
    func testThisBuildAdvertisesLinkInEveryRoomOnMacOSAndTheCodelessRoomOnIOS() {
        XCTAssertTrue(LINK_BUILD_SUPPORT,
                      "both apps compose link/1 through LinkWorkspaceModel")
        #if os(macOS)
        XCTAssertTrue(LINK_PAIRING_ROOM_SUPPORT,
                      "macOS watches a pairing code through LinkWorkspaceModel")
        #else
        XCTAssertFalse(LINK_PAIRING_ROOM_SUPPORT,
                       "iOS composes no pairing-code link, so it must announce none")
        #endif

        // The code-less room: every platform that implements the protocol
        // announces and routes there.
        XCTAssertTrue(linkRoomActive(isCodelessRoom: true),
                      "the code-less room is where both platforms link")
        // The pairing room: this platform's own answer, and it is the ONE thing
        // the parameter now decides.
        XCTAssertEqual(linkRoomActive(isCodelessRoom: false), LINK_PAIRING_ROOM_SUPPORT,
                       "a pairing room links only where a pairing link is composed")

        for isCodelessRoom in [true, false] {
            let active = linkRoomActive(isCodelessRoom: isCodelessRoom)
            XCTAssertEqual(advertisedLinkCapabilities(linkRoomActive: active),
                           active ? [TEXT_CAPABILITY, LINK_CAPABILITY] : [TEXT_CAPABILITY])
            XCTAssertEqual(peerCaps(from: linkCapsHello(linkRoomActive: active)),
                           active ? [TEXT_CAPABILITY, LINK_CAPABILITY] : [TEXT_CAPABILITY])

            let registry = PeerCapabilityRegistry(
                linkRoomActive: { linkRoomActive(isCodelessRoom: isCodelessRoom) })
            XCTAssertTrue(registry.record(peerId: "p1",
                                          signal: capsSignalValue([TEXT_CAPABILITY, LINK_CAPABILITY])))
            XCTAssertEqual(registry.supports("p1", LINK_CAPABILITY), active,
                           "announcement and routing must agree, room: \(isCodelessRoom)")
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

    /// The build gate, pinned as SOURCE: `true` on the two Apple app platforms
    /// and `false` everywhere else.
    ///
    /// The value assertion above runs only on the platform executing it, and
    /// `RelayiumKit` is NOT limited to the two app binaries — a Linux or tool
    /// build of the package compiles this constant too. Collapsing the directive
    /// to an unconditional `true` would make such a process announce `link/1`
    /// with no link surface behind it and then fail the establishment it had
    /// itself invited, which is exactly the promise-it-cannot-keep failure the
    /// original macOS/iOS split existed to prevent. Widening the condition was
    /// the delivered change; removing it is a regression, and this is the
    /// assertion that catches it on this machine.
    func testTheBuildFlagIsCompiledForAppleAppPlatformsOnly() throws {
        let source = try registrySource()
        // The exact five lines, in order, with nothing between them: the
        // conditional IS the guarantee, so a partial match would let an edit
        // leave the directive standing while both branches said true.
        let expected = """
        #if os(macOS) || os(iOS)
        public let LINK_BUILD_SUPPORT = true
        #else
        public let LINK_BUILD_SUPPORT = false
        #endif
        """.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let lines = source.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let start = lines.firstIndex(of: expected[0]) else {
            return XCTFail("LINK_BUILD_SUPPORT must be compiled for macOS and iOS only")
        }
        XCTAssertEqual(Array(lines[start..<min(start + expected.count, lines.count)]),
                       expected,
                       "link/1 is composed by the macOS and iOS apps, and the source must say so")
        // And exactly one of each branch in the whole file, so a second,
        // unconditional definition cannot be added below while the block above
        // still matches.
        XCTAssertEqual(lines.filter { $0 == "public let LINK_BUILD_SUPPORT = true" }.count, 1)
        XCTAssertEqual(lines.filter { $0 == "public let LINK_BUILD_SUPPORT = false" }.count, 1)
    }

    /// The pairing-room gate, pinned as SOURCE as well as value.
    ///
    /// The value assertion above can only ever run on the platform executing it,
    /// so on its own it proves nothing about the other build. `swift test` runs
    /// on macOS here, which means the iOS half of this boundary has exactly one
    /// piece of executable evidence on this machine: this test, reading the
    /// constant's own definition and requiring the conditional to be there.
    ///
    /// It is the same shape the test it replaces had for `LINK_BUILD_SUPPORT`,
    /// moved to the constant that now carries the platform split. Collapsing
    /// this one to a cross-platform `true` would ship an iPhone announcing
    /// `link/1` in every pairing room while having nothing that could join one.
    func testThePairingRoomFlagIsCompiledPerPlatform() throws {
        let source = try registrySource()
        // The exact five lines, in order, with nothing between them: the
        // conditional IS the guarantee, so a partial match would let an edit
        // leave the directive standing while both branches said true.
        let expected = """
        #if os(macOS)
        public let LINK_PAIRING_ROOM_SUPPORT = true
        #else
        public let LINK_PAIRING_ROOM_SUPPORT = false
        #endif
        """.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let lines = source.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let start = lines.firstIndex(of: expected[0]) else {
            return XCTFail("LINK_PAIRING_ROOM_SUPPORT must be compiled per platform")
        }
        XCTAssertEqual(Array(lines[start..<min(start + expected.count, lines.count)]),
                       expected,
                       "a pairing-code link is macOS-only, and the source must say so")
    }

    /// **The room rule reads BOTH constants, and iOS's pairing answer is false
    /// for a reason a reader can see.**
    ///
    /// The value test above cannot fail on this machine for the iOS case — it
    /// runs on macOS, where both constants are true — so the composition is
    /// pinned at the source too. Without this, `linkRoomActive` could be edited
    /// back to `return LINK_BUILD_SUPPORT` and every executable assertion in this
    /// file would still pass, while the iOS build silently announced `link/1` in
    /// pairing rooms it cannot join. That is precisely the failure
    /// `WORKFLOW-LEARNINGS` records for 2026-08-10: green tests protecting a
    /// different property than their names claim.
    func testTheRoomRuleIsComposedFromBothFlags() throws {
        let source = try registrySource()
        let body = """
        guard LINK_BUILD_SUPPORT else { return false }
        return isCodelessRoom || LINK_PAIRING_ROOM_SUPPORT
        """.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let lines = source.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let start = lines.firstIndex(of: body[0]) else {
            return XCTFail("linkRoomActive must gate on LINK_BUILD_SUPPORT first")
        }
        XCTAssertEqual(Array(lines[start..<min(start + body.count, lines.count)]), body,
                       "the room rule must be the two flags and the room kind, and nothing else")
    }

    /// The constant's own file, read raw: this assertion is ABOUT the
    /// preprocessor directives, so a comment-stripping reader would be reading
    /// something other than what compiles.
    private func registrySource() throws -> String {
        try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Realtime/PeerCapabilityRegistry.swift")
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
