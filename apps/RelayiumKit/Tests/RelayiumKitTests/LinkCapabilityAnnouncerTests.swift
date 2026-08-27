import XCTest
@testable import RelayiumKit

/// Telling each peer in the room what this build can speak.
///
/// The announcement rides the roster, not a connection's SDP, and the reason is
/// an older peer: it treats ANY inbound offer as a file transfer and waits for a
/// manifest that will never come, then fails it as a stall. A capability that
/// arrives with the offer is too late to prevent the thing it exists to prevent.
///
/// The rules that matter are bounded retries and no ping-pong. This frame is
/// unacknowledged, so it needs repeats; but a peer that answers every hello with
/// a hello turns a two-device room into an unbounded exchange.
@MainActor
final class LinkCapabilityAnnouncerTests: XCTestCase {

    private final class Recorder {
        var sent: [(peer: String, caps: [String])] = []
        var peers: [String] { sent.map(\.peer) }
    }

    private func make(linkRoomActive: Bool = true)
        -> (LinkCapabilityAnnouncer, Recorder, PeerCapabilityRegistry) {
        let recorder = Recorder()
        let registry = PeerCapabilityRegistry(linkRoomActive: { linkRoomActive })
        let announcer = LinkCapabilityAnnouncer(
            registry: registry,
            linkRoomActive: { linkRoomActive },
            send: { peer, signal in recorder.sent.append((peer, peerCaps(from: signal))) }
        )
        return (announcer, recorder, registry)
    }

    // MARK: - announcing

    func testAnnouncesTheAdvertisedListToEachNewPeerExactlyOnce() {
        let (announcer, recorder, _) = make()
        announcer.rosterChanged(peerIds: ["p1", "p2"])
        XCTAssertEqual(Set(recorder.peers), ["p1", "p2"])
        XCTAssertEqual(recorder.sent.first?.caps, [TEXT_CAPABILITY, LINK_CAPABILITY])

        recorder.sent = []
        announcer.rosterChanged(peerIds: ["p1", "p2"])
        XCTAssertTrue(recorder.sent.isEmpty, "an unchanged roster is not a new peer")
    }

    func testOnlyNewPeersAreGreeted() {
        let (announcer, recorder, _) = make()
        announcer.rosterChanged(peerIds: ["p1"])
        recorder.sent = []
        announcer.rosterChanged(peerIds: ["p1", "p2"])
        XCTAssertEqual(recorder.peers, ["p2"])
    }

    /// Nothing is announced where link mode cannot run. The legacy
    /// per-connection SDP capability confirmation continues to serve `text/1`
    /// exactly as it does today, so this adds no frame to a code room.
    func testNothingIsAnnouncedWhereLinkModeIsNotActive() {
        let (announcer, recorder, _) = make(linkRoomActive: false)
        announcer.rosterChanged(peerIds: ["p1"])
        announcer.retryTick()
        XCTAssertTrue(recorder.sent.isEmpty)
    }

    /// The same gate as `testThisBuildNeitherAdvertisesNorRoutesLink`, at the
    /// frame level: wired to the REAL composed predicate rather than an injected
    /// one, this build puts no hello on the wire in any room. `link/1` cannot be
    /// announced from a build that cannot honour it.
    func testThisBuildAnnouncesInEveryRoomItsPlatformAllows() {
        for isCodelessRoom in [true, false] {
            let recorder = Recorder()
            let active = { linkRoomActive(isCodelessRoom: isCodelessRoom) }
            let announcer = LinkCapabilityAnnouncer(
                registry: PeerCapabilityRegistry(linkRoomActive: active),
                linkRoomActive: active,
                send: { peer, signal in recorder.sent.append((peer, peerCaps(from: signal))) }
            )
            announcer.rosterChanged(peerIds: ["p1", "p2"])
            for _ in 0..<LINK_CAPS_ANNOUNCE_ATTEMPTS { announcer.retryTick() }

            guard LINK_BUILD_SUPPORT else {
                // A platform that cannot answer a link must not invite one, and
                // the SILENCE is the load-bearing half.
                XCTAssertTrue(recorder.sent.isEmpty,
                              "a build without link/1 may not greet anybody, room: \(isCodelessRoom)")
                continue
            }
            XCTAssertFalse(recorder.sent.isEmpty,
                           "every room must greet its peers, room: \(isCodelessRoom)")
            for (_, caps) in recorder.sent {
                XCTAssertEqual(caps, [TEXT_CAPABILITY, LINK_CAPABILITY])
            }
        }
    }

    /// A room whose rule says no is still silent, whatever the build says. The
    /// predicate is injected here because that is the only way to exercise the
    /// refusal on a platform whose real answer is yes.
    func testARoomThatForbidsLinkIsSilent() {
        let (announcer, recorder, _) = make(linkRoomActive: false)
        announcer.rosterChanged(peerIds: ["p1", "p2"])
        for _ in 0..<LINK_CAPS_ANNOUNCE_ATTEMPTS { announcer.retryTick() }
        XCTAssertTrue(recorder.sent.isEmpty)
    }

    // MARK: - bounded retries

    /// The hello is unacknowledged, so it repeats — but a bounded number of
    /// times. An unbounded repeat is a peer that never stops talking to a peer
    /// that may never have existed.
    func testRetriesAreBounded() {
        let (announcer, recorder, _) = make()
        announcer.rosterChanged(peerIds: ["p1"])
        for _ in 0..<(LINK_CAPS_ANNOUNCE_ATTEMPTS * 3) { announcer.retryTick() }
        XCTAssertEqual(recorder.peers.count, LINK_CAPS_ANNOUNCE_ATTEMPTS)
    }

    /// A peer that has told us what it speaks does not need to be told again.
    func testHearingFromAPeerRetiresItsRemainingRetries() {
        let (announcer, recorder, _) = make()
        announcer.rosterChanged(peerIds: ["p1"])
        XCTAssertEqual(recorder.peers.count, 1)
        announcer.didHearFrom(peerId: "p1")
        announcer.retryTick()
        announcer.retryTick()
        XCTAssertEqual(recorder.peers.count, 1)
    }

    /// The no-ping-pong rule, stated directly: receiving a hello must never
    /// produce one.
    func testReceivingAHelloNeverProducesAHello() {
        let (announcer, recorder, registry) = make()
        announcer.rosterChanged(peerIds: [])
        XCTAssertTrue(registry.record(peerId: "p1", signal: linkCapsHello(linkRoomActive: true)))
        announcer.didHearFrom(peerId: "p1")
        XCTAssertTrue(recorder.sent.isEmpty)
    }

    // MARK: - scope and expiry

    func testDepartedPeersAreForgottenByBothTheRegistryAndTheAnnouncer() {
        let (announcer, recorder, registry) = make()
        announcer.rosterChanged(peerIds: ["p1"])
        _ = registry.record(peerId: "p1", signal: linkCapsHello(linkRoomActive: true))
        XCTAssertTrue(registry.supports("p1", LINK_CAPABILITY))

        recorder.sent = []
        announcer.rosterChanged(peerIds: ["p2"])
        XCTAssertFalse(registry.supports("p1", LINK_CAPABILITY))
        XCTAssertEqual(recorder.peers, ["p2"])
    }

    /// A new socket means new peer ids and a roster nobody has been greeted in.
    /// The previous room's announcements must not answer for ids in this one.
    func testRoomEpochChangeClearsEverythingAndGreetsAgain() {
        let (announcer, recorder, registry) = make()
        announcer.rosterChanged(peerIds: ["p1"])
        _ = registry.record(peerId: "p1", signal: linkCapsHello(linkRoomActive: true))
        recorder.sent = []

        announcer.roomChanged()
        XCTAssertFalse(registry.supports("p1", LINK_CAPABILITY))
        announcer.rosterChanged(peerIds: ["p1"])
        XCTAssertEqual(recorder.peers, ["p1"], "a peer id in a new room is a new peer")
    }

    func testStopEndsRetriesWithoutLeavingStaleState() {
        let (announcer, recorder, _) = make()
        announcer.rosterChanged(peerIds: ["p1"])
        recorder.sent = []
        announcer.stop()
        announcer.retryTick()
        XCTAssertTrue(recorder.sent.isEmpty)
    }
}

/// **What a client announces, and the seam that lets a composition tell the
/// truth about itself.**
///
/// The announcer used to call `linkCapsHello` directly, so every client that
/// linked this module made the same promise. macOS deleted the legacy file and
/// text transports and refuses every legacy session; a hello naming `text/1`
/// from that build invites a peer onto a lane the app cannot open, which is the
/// one input that peer is entitled to act on.
///
/// So the hello is a parameter. What these pin is that the DEFAULT is unchanged
/// — iOS, the headless acceptance hosts and every existing consumer announce
/// exactly what they announced before — and that the override says exactly
/// `link/1` and nothing else.
@MainActor
final class LinkCapabilityAnnouncerHelloTests: XCTestCase {

    private func sent(hello: ((Bool) -> JSONValue)? = nil,
                      linkRoomActive: Bool = true) -> [JSONValue] {
        var frames: [JSONValue] = []
        let announcer: LinkCapabilityAnnouncer
        if let hello {
            announcer = LinkCapabilityAnnouncer(
                registry: PeerCapabilityRegistry(linkRoomActive: { linkRoomActive }),
                linkRoomActive: { linkRoomActive },
                send: { _, signal in frames.append(signal) },
                hello: hello)
        } else {
            // The default path — the argument is deliberately not supplied.
            announcer = LinkCapabilityAnnouncer(
                registry: PeerCapabilityRegistry(linkRoomActive: { linkRoomActive }),
                linkRoomActive: { linkRoomActive },
                send: { _, signal in frames.append(signal) })
        }
        announcer.roomChanged()
        announcer.rosterChanged(peerIds: ["zzz-peer"])
        return frames
    }

    /// **The default is the shipped hello, and this proves it by NOT passing
    /// one.** A default flipped here would change what every current consumer
    /// puts on the wire.
    func testTheDefaultAnnouncementIsUnchanged() {
        XCTAssertEqual(sent().first, linkCapsHello(linkRoomActive: true))
        XCTAssertEqual(peerCaps(from: try! XCTUnwrap(sent().first)),
                       [TEXT_CAPABILITY, LINK_CAPABILITY],
                       "the default hello stopped announcing the legacy lane iOS ships")
    }

    /// …including where link mode is off, which is the iOS pairing-room scope.
    func testTheDefaultAnnouncementIsUnchangedWithLinkModeOff() {
        let frames = sent(linkRoomActive: false)
        // Nothing is announced at all where link mode cannot run — the
        // announcer's own rule, untouched by this seam.
        XCTAssertTrue(frames.isEmpty)
    }

    /// The override announces exactly `link/1`: not a superset, not a case
    /// variant, and never the lane the composition deleted.
    func testTheLinkOnlyOverrideAnnouncesExactlyLinkOne() throws {
        let frame = try XCTUnwrap(sent(hello: linkOnlyCapsHello(linkRoomActive:)).first)
        XCTAssertEqual(peerCaps(from: frame), [LINK_CAPABILITY])
        XCTAssertFalse(peerCaps(from: frame).contains(TEXT_CAPABILITY),
                       "a build that refuses every legacy session still advertised one")
    }

    /// An empty hello where link mode is off is still a hello, and still says
    /// "nothing here for you" rather than saying nothing.
    func testTheLinkOnlyHelloIsEmptyRatherThanAbsentWhenLinkModeIsOff() {
        XCTAssertEqual(linkOnlyCapsHello(linkRoomActive: false), capsField([]))
        XCTAssertEqual(linkOnlyCapsHello(linkRoomActive: true), capsField([LINK_CAPABILITY]))
    }

    /// **The two hellos are read by the same rule**, so a peer on the other end
    /// needs no special case for either. The registry is the browser's rule too:
    /// exact match on `link/1`.
    func testBothHellosAreReadByTheOneRule() {
        for (hello, expectsText) in [(linkCapsHello(linkRoomActive: true), true),
                                     (linkOnlyCapsHello(linkRoomActive: true), false)] {
            let registry = PeerCapabilityRegistry(linkRoomActive: { true })
            XCTAssertTrue(registry.record(peerId: "p", signal: hello))
            XCTAssertTrue(registry.supports("p", LINK_CAPABILITY),
                          "both hellos must name link/1")
            XCTAssertEqual(registry.supports("p", TEXT_CAPABILITY), expectsText)
        }
    }
}
