import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **The capability handshake, pinned against the browser rather than against
/// this language's own opinion of it.**
///
/// ## Why a vector and not another Swift literal
///
/// There was already a Swift statement of what a browser sends —
/// `LinkWebWorkspaceInteropTests` called `{"caps":["text/1","link/1"]}`
/// "`capsSignal()` … verbatim". The browser had sent three capabilities since
/// `preupload/1` shipped. `peer-caps.test.ts` pinned the browser to three, this
/// file's ancestor pinned it to two, and both suites were green — because the
/// workflows are path-filtered (`macos.yml` on `apps/**`, `web.yml` on `web/**`)
/// so no commit can ever run both. A hand-copied literal is not a cross-language
/// assertion; it is one language asserting its own memory of the other.
///
/// `realtime-wire-vectors.json` is generated from the Web's constants and read
/// by both suites, so a change on either side that the other did not follow
/// fails somewhere instead of nowhere.
///
/// ## What is pinned here, and why each one
///
/// Every entry below is a decision that was made in two places at once and could
/// therefore disagree: what each client announces, how often it repeats it,
/// how long the other side waits for it, exactly which strings promote, which
/// legacy lane a peer that does not promote gets, what a client says when it
/// gives that promotion up, and which of the two peers dials.
final class LinkCapabilityVectorTests: XCTestCase {

    private func vectors() throws -> Vectors { try Vectors.load("realtime-wire-vectors") }

    private func caps(_ node: Any?) -> [String] {
        guard let object = node as? [String: Any], let list = object["caps"] as? [Any] else {
            return []
        }
        return list.compactMap { $0 as? String }
    }

    private func capability(_ v: Vectors) throws -> [String: Any] {
        let node = v.json["capability"] as? [String: Any]
        return try XCTUnwrap(node, "realtime-wire-vectors.json has no capability block; "
                             + "run `node scripts/gen-realtime-wire-vectors.mjs` from web/")
    }

    // MARK: - what each client announces

    /// The native roster hello, against the generated statement of it.
    ///
    /// Not against the browser's: they genuinely differ, because `preupload/1`
    /// is a Web lane these clients do not implement. Both are recorded so the
    /// difference is a fact somebody chose rather than one a test discovers by
    /// failing.
    func testNativeHelloMatchesTheVector() throws {
        let block = try capability(vectors())
        let hello = try XCTUnwrap(block["hello"] as? [String: Any])
        XCTAssertEqual(advertisedLinkCapabilities(linkRoomActive: true),
                       caps(hello["native"]))
        XCTAssertEqual(advertisedLinkCapabilities(linkRoomActive: false),
                       caps(hello["linkRoomInactive"]))
    }

    /// The shared contract is `link/1`, exactly — and it is no longer a subset
    /// relation in either direction.
    ///
    /// It used to be: this build's hello had to be a SUBSET of the browser's, and
    /// the browser's `text/1` was asserted here as a capability this side could
    /// count on. Both halves have stopped being true. The browser withdrew
    /// `text/1` when it deleted the single-lane conversation transport behind it,
    /// so requiring the browser to announce it would be requiring an untruthful
    /// hello; and this build announces `text/1` while the browser announces
    /// `preupload/1`, so neither list contains the other.
    ///
    /// What actually has to hold — and all that ever had to — is that both name
    /// the SAME EXACT `link/1`, and that each side reads the other's hello as
    /// naming it. A capability only one side implements is a fact, not a defect;
    /// a `link/1` the two sides spell differently is the defect, and that is what
    /// this asserts. Anything a peer announces beyond it is ignored rather than
    /// required, which is exactly how a client that ships a lane the other does
    /// not can keep interoperating.
    func testBothHellosNameTheSameExactLink() throws {
        let block = try capability(vectors())
        let hello = try XCTUnwrap(block["hello"] as? [String: Any])
        let web = caps(hello["web"])
        let native = advertisedLinkCapabilities(linkRoomActive: true)

        XCTAssertTrue(web.contains(LINK_CAPABILITY),
                      "the browser hello no longer names link/1: \(web)")
        XCTAssertTrue(native.contains(LINK_CAPABILITY),
                      "this build's hello no longer names link/1: \(native)")
        // Exact, not a prefix and not a case fold: the string is the contract.
        XCTAssertEqual(web.filter { $0 == LINK_CAPABILITY }, [LINK_CAPABILITY])

        // …and the browser's withdrawal of the legacy conversation lane is a
        // recorded expectation rather than an accident this suite would tolerate
        // either way. A browser that started announcing it again would mean the
        // deleted transport had come back.
        XCTAssertFalse(web.contains(TEXT_CAPABILITY),
                       "the browser advertises a legacy lane it no longer implements: \(web)")

        let registry = PeerCapabilityRegistry(linkRoomActive: { true })
        XCTAssertTrue(registry.record(peerId: "web", signal: capsField(web)))
        XCTAssertTrue(registry.supports("web", LINK_CAPABILITY))
        XCTAssertFalse(registry.supports("web", TEXT_CAPABILITY))
    }

    // MARK: - the cadence, and the window it has to fit inside

    /// One retry cadence for both rooms and both languages, and every attempt
    /// inside the window the peer waits.
    ///
    /// The arithmetic is asserted rather than left in a comment because the two
    /// numbers live in different files from the window, and raising either one
    /// alone is how the last hello ends up arriving after the peer has already
    /// decided this side is legacy — a frame that changes nothing, sent by a
    /// client that believes it is still negotiating.
    func testRetryCadenceFitsInsideTheCapabilityWindow() throws {
        let block = try capability(vectors())
        let retry = try XCTUnwrap(block["retry"] as? [String: Any])
        XCTAssertEqual(LINK_CAPS_ANNOUNCE_ATTEMPTS, retry["attempts"] as? Int)
        XCTAssertEqual(LINK_CAPS_RETRY_INTERVAL, (retry["intervalMs"] as? Double).map { $0 / 1000 })

        let settle = try XCTUnwrap(block["settleSeconds"] as? Double)
        XCTAssertEqual(LinkWorkspaceModel.pairingCapabilityWait, settle)

        let last = try XCTUnwrap(block["lastAttemptSeconds"] as? Double)
        XCTAssertEqual(last, Double(LINK_CAPS_ANNOUNCE_ATTEMPTS - 1) * LINK_CAPS_RETRY_INTERVAL)
        XCTAssertLessThan(last, settle,
                          "the last hello must land inside the peer's window, not after it")
    }

    // MARK: - exactly which strings promote

    func testPromotionTableIsExact() throws {
        let block = try capability(vectors())
        let rows = try XCTUnwrap(block["promotion"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let announced = (row["caps"] as? [Any])?.compactMap { $0 as? String } ?? []
            let registry = PeerCapabilityRegistry(linkRoomActive: { true })
            XCTAssertTrue(registry.record(peerId: "p", signal: capsField(announced)),
                          "a caps array is always a hello, including an empty one: \(announced)")
            XCTAssertEqual(registry.supports("p", LINK_CAPABILITY), row["link"] as? Bool,
                           "promotion disagreed for \(announced)")

            // The second half of the rule: a peer that SAID something is decided
            // on the spot, and only silence is worth waiting the window out.
            // `LinkWorkspaceModel.pairingPeerAnnounced` reads exactly these two
            // predicates to make that call.
            let resolvesImmediately = registry.supports("p", LINK_CAPABILITY)
                || registry.supports("p", TEXT_CAPABILITY)
            XCTAssertEqual(resolvesImmediately, row["resolvesImmediately"] as? Bool,
                           "immediacy disagreed for \(announced)")

            if let lane = row["legacyLane"] as? String {
                let expected: TransferMode = lane == "text" ? .text : .files
                XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: registry.supports("p", TEXT_CAPABILITY),
                                               hasArmedBatch: false),
                               expected, "legacy lane disagreed for \(announced)")
            }
        }
    }

    /// Room scope is enforced at the PREDICATE, so a forged roster claim cannot
    /// activate link mode where the room does not allow it. The same table, read
    /// through a registry whose room says no.
    func testNoAnnouncementPromotesWhereTheRoomForbidsIt() throws {
        let block = try capability(vectors())
        let rows = try XCTUnwrap(block["promotion"] as? [[String: Any]])
        for row in rows {
            let announced = (row["caps"] as? [Any])?.compactMap { $0 as? String } ?? []
            let registry = PeerCapabilityRegistry(linkRoomActive: { false })
            registry.record(peerId: "p", signal: capsField(announced))
            XCTAssertFalse(registry.supports("p", LINK_CAPABILITY),
                           "a room that forbids link mode promoted \(announced)")
        }
    }

    func testLegacyLaneTableIsExact() throws {
        let block = try capability(vectors())
        let rows = try XCTUnwrap(block["legacyLane"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let lane = row["lane"] as? String
            let expected: TransferMode = lane == "text" ? .text : .files
            XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: row["peerAnnouncesText"] as? Bool ?? false,
                                           hasArmedBatch: row["hasArmedBatch"] as? Bool ?? false),
                           expected, "legacy lane disagreed for \(row)")
        }
    }

    // MARK: - what a hello is, and is not

    /// An announcement REPLACES the last one. Both clients record a snapshot, so
    /// a smaller later hello revokes — which is what makes the agreed downgrade
    /// below a real withdrawal rather than an additional claim.
    func testAHelloRevokesRatherThanAdds() throws {
        let block = try capability(vectors())
        let row = try XCTUnwrap(block["revocation"] as? [String: Any])
        let registry = PeerCapabilityRegistry(linkRoomActive: { true })
        registry.record(peerId: "p", signal: capsField(caps(row["first"])))
        XCTAssertTrue(registry.supports("p", LINK_CAPABILITY))
        registry.record(peerId: "p", signal: capsField(caps(row["then"])))
        XCTAssertEqual(registry.supports("p", LINK_CAPABILITY), row["link"] as? Bool)
        XCTAssertEqual(registry.supports("p", TEXT_CAPABILITY), row["text"] as? Bool)
    }

    /// A frame with no `caps` array is not a hello at all — a shape we do not
    /// understand rather than a peer with no capabilities — so it must leave an
    /// earlier announcement standing.
    func testAFrameThatIsNotAHelloLeavesTheAnnouncementStanding() throws {
        let block = try capability(vectors())
        let rows = try XCTUnwrap(block["notAHello"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let registry = PeerCapabilityRegistry(linkRoomActive: { true })
            registry.record(peerId: "p", signal: capsField([TEXT_CAPABILITY, LINK_CAPABILITY]))
            let signal = try JSONValue.decode(row)
            XCTAssertFalse(registry.record(peerId: "p", signal: signal),
                           "\(row) was read as a hello")
            XCTAssertTrue(registry.supports("p", LINK_CAPABILITY),
                          "\(row) cleared an announcement it does not carry")
        }
    }

    // MARK: - the agreed downgrade

    /// What a client announces when it stops being a `link/1` peer, per lane.
    ///
    /// The frame is the ordinary hello, so nothing on the wire is new; what is
    /// new is that giving up is now SAID. `LinkWorkspaceModel.announceDowngrade`
    /// sends it, and the peer's own snapshot rule above is what makes it land.
    func testDowngradeAnnouncementMatchesTheLaneItNamesForBothLanes() throws {
        let block = try capability(vectors())
        let row = try XCTUnwrap(block["downgrade"] as? [String: Any])

        // A text lane announces text/1 and nothing else: the peer may open a
        // conversation, and may not expect a link.
        let text = caps(row["text"])
        XCTAssertEqual(text, [TEXT_CAPABILITY])
        let afterText = PeerCapabilityRegistry(linkRoomActive: { true })
        afterText.record(peerId: "mac", signal: capsField(text))
        XCTAssertFalse(afterText.supports("mac", LINK_CAPABILITY))
        XCTAssertTrue(afterText.supports("mac", TEXT_CAPABILITY))
        XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: afterText.supports("mac", TEXT_CAPABILITY),
                                       hasArmedBatch: false),
                       .text, "the peer must reach the same lane this side announced")

        // A file lane announces nothing at all, because the legacy file wire
        // carries no capability and claiming text/1 beside it would invite a
        // conversation the session has no composer for.
        let files = caps(row["files"])
        XCTAssertEqual(files, [])
        let afterFiles = PeerCapabilityRegistry(linkRoomActive: { true })
        afterFiles.record(peerId: "mac", signal: capsField([TEXT_CAPABILITY, LINK_CAPABILITY]))
        XCTAssertTrue(afterFiles.record(peerId: "mac", signal: capsField(files)),
                      "an empty caps array is still a hello — that is what makes it revoke")
        XCTAssertFalse(afterFiles.supports("mac", LINK_CAPABILITY))
        XCTAssertFalse(afterFiles.supports("mac", TEXT_CAPABILITY))
        XCTAssertEqual(LegacyLane.mode(peerAnnouncesText: afterFiles.supports("mac", TEXT_CAPABILITY),
                                       hasArmedBatch: false),
                       .files)
    }

    // MARK: - who dials

    /// Both assignments, because a client can be correct in only the half of
    /// pairings its own id happens to produce and look entirely healthy.
    func testRoleAssignmentMatchesTheVectorInBothDirections() throws {
        let block = try capability(vectors())
        let rows = try XCTUnwrap(block["role"] as? [[String: Any]])
        XCTAssertEqual(rows.count % 2, 0, "every pair must be stated from both ends")
        for row in rows {
            let selfId = try XCTUnwrap(row["self"] as? String)
            let peerId = try XCTUnwrap(row["peer"] as? String)
            let expected: Role = (row["role"] as? String) == "initiator" ? .initiator : .responder
            XCTAssertEqual(linkRole(selfId: selfId, peerId: peerId), expected,
                           "role disagreed for \(selfId) → \(peerId)")
        }
    }

    // MARK: - a frame that IS its own announcement

    func testALinkFrameStandsInForAHelloThatNeverArrived() throws {
        let block = try capability(vectors())
        let row = try XCTUnwrap(block["provenLink"] as? [String: Any])
        let signal = try JSONValue.decode(XCTUnwrap(row["signal"] as? [String: Any]))

        let silent = PeerCapabilityRegistry(linkRoomActive: { true })
        XCTAssertFalse(silent.record(peerId: "p", signal: signal),
                       "an establishment frame is not a hello")
        XCTAssertTrue(silent.recordProvenLink(peerId: "p", signal: signal))
        XCTAssertEqual(silent.announcements(for: "p"), caps(row as Any))
        XCTAssertTrue(silent.supports("p", LINK_CAPABILITY))

        // …and only for a peer that has said nothing. A peer that stated its
        // wire is not overruled by a later frame claiming otherwise, which is
        // what keeps this a repair for silence rather than an upgrade path.
        let stated = PeerCapabilityRegistry(linkRoomActive: { true })
        stated.record(peerId: "p", signal: capsField(caps(row["doesNotOverrule"])))
        XCTAssertFalse(stated.recordProvenLink(peerId: "p", signal: signal))
        XCTAssertFalse(stated.supports("p", LINK_CAPABILITY))

        // Room scope still decides. Proof is evidence about the peer, never
        // permission for the room.
        let forbidden = PeerCapabilityRegistry(linkRoomActive: { false })
        XCTAssertTrue(forbidden.recordProvenLink(peerId: "p", signal: signal))
        XCTAssertFalse(forbidden.supports("p", LINK_CAPABILITY))
    }
}

extension JSONValue {
    /// Decode a plain `[String: Any]` read out of a vector file.
    ///
    /// Through `JSONSerialization` and the production decoder rather than by
    /// mapping the dictionary here: a hand-written converter would be a second
    /// opinion about what the bytes mean, which is the whole thing these vectors
    /// exist to remove.
    static func decode(_ object: [String: Any]) throws -> JSONValue {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
