import XCTest
@testable import RelayiumKit

/// One `LinkLaneChannel` with no WebRTC under it.
///
/// The whole point of the seam: a real `RTCDataChannel` cannot be opened
/// without two negotiating endpoints, so every ordering question below — the
/// text lane arriving first, a lane that dies one instant before the barrier
/// would have lifted, a peer that speaks before a consumer exists — would
/// otherwise only be reachable from a live two-peer run, which is the worst
/// place to reproduce any of them.
private final class FakeLane: LinkLaneChannel {
    enum State { case connecting, open, closing, closed }

    let laneLabel: String
    var state: State
    var sendSucceeds = true
    private(set) var sent: [[UInt8]] = []
    private(set) var closeCount = 0
    var laneBufferedAmount: UInt64 = 0

    init(_ label: String, state: State = .open) {
        self.laneLabel = label
        self.state = state
    }

    var laneIsOpen: Bool { state == .open }
    var laneIsTerminal: Bool { state == .closing || state == .closed }

    @discardableResult
    func laneSend(_ bytes: [UInt8]) -> Bool {
        guard sendSucceeds else { return false }
        sent.append(bytes)
        return true
    }

    func laneClose() {
        closeCount += 1
        state = .closed
    }
}

/// What an initial `link/1` transport does with its two lanes, before and after
/// the moment it may publish anything.
final class LinkEstablishmentTests: XCTestCase {

    // MARK: - helpers

    private func identity(sas: String = "123456") -> LinkIdentity {
        LinkIdentity(peerId: "peer",
                     role: .initiator,
                     sas: sas,
                     codecs: LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                        recvKey: [UInt8](repeating: 2, count: 32)))
    }

    /// Publishes, ignoring the identity and the replayed backlog. Returns
    /// whether the barrier was actually lifted.
    @discardableResult
    private func publish(_ establishment: LinkEstablishment) -> Bool {
        establishment.publish(ready: { _ in }, frame: { _, _ in })
    }

    /// Publishes and collects the replayed backlog, per lane, in delivery order.
    private func publishCollectingReplay(
        _ establishment: LinkEstablishment
    ) -> (file: [[UInt8]], text: [[UInt8]]) {
        var file: [[UInt8]] = []
        var text: [[UInt8]] = []
        establishment.publish(ready: { _ in }, frame: { lane, bytes in
            switch lane {
            case .file: file.append(bytes)
            case .text: text.append(bytes)
            }
        })
        return (file, text)
    }

    /// Collects both lanes, open, in the given order. Returns the last step so a
    /// caller can assert on it.
    @discardableResult
    private func collectBothLanes(_ establishment: LinkEstablishment,
                                  _ file: FakeLane,
                                  _ text: FakeLane,
                                  textFirst: Bool = false) -> LinkEstablishment.Step {
        let order = textFirst ? [text, file] : [file, text]
        var last = LinkEstablishment.Step.none
        for lane in order { last = establishment.collect(lane) }
        return last
    }

    // MARK: - the publication barrier

    /// Both exact lanes, both open, AND a verified identity. Any two of the
    /// three is not a link.
    func testNothingIsPublishedUntilBothLanesAreOpenAndThePeerIsAuthenticated() {
        let establishment = LinkEstablishment()
        let file = FakeLane(LINK_FILE_CHANNEL)
        let text = FakeLane(LINK_TEXT_CHANNEL, state: .connecting)

        XCTAssertEqual(establishment.collect(file), .none, "one lane is not a link")
        XCTAssertEqual(establishment.collect(text), .none, "a connecting lane is not open")
        XCTAssertTrue(establishment.hasBothLanes)
        XCTAssertEqual(establishment.authenticated(identity()), .none,
                       "authenticated, but the text lane has not opened")
        XCTAssertFalse(publish(establishment), "the barrier has not lifted")

        text.state = .open
        XCTAssertEqual(establishment.laneStateChanged(label: LINK_TEXT_CHANNEL), .publish)
    }

    func testAuthenticationArrivingLastLiftsTheBarrier() {
        let establishment = LinkEstablishment()
        collectBothLanes(establishment, FakeLane(LINK_FILE_CHANNEL), FakeLane(LINK_TEXT_CHANNEL))
        XCTAssertEqual(establishment.authenticated(identity()), .publish)
    }

    /// DCEP delivers the two streams in whatever order it likes, and a link
    /// whose text lane happened to finish first is an ordinary link.
    func testLaneArrivalOrderIsIrrelevantToPublication() {
        for textFirst in [false, true] {
            let establishment = LinkEstablishment()
            _ = establishment.authenticated(identity())
            let step = collectBothLanes(establishment,
                                        FakeLane(LINK_FILE_CHANNEL),
                                        FakeLane(LINK_TEXT_CHANNEL),
                                        textFirst: textFirst)
            XCTAssertEqual(step, .publish, "textFirst=\(textFirst)")
        }
    }

    /// A link whose text lane never opened is not a degraded link — it is a link
    /// that cannot honour `link/1`.
    func testOneLaneNeverPublishes() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        XCTAssertEqual(establishment.collect(FakeLane(LINK_FILE_CHANNEL)), .none)
        XCTAssertFalse(publish(establishment))
    }

    func testPublicationHappensExactlyOnce() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        let file = FakeLane(LINK_FILE_CHANNEL)
        let text = FakeLane(LINK_TEXT_CHANNEL)
        XCTAssertEqual(collectBothLanes(establishment, file, text), .publish)

        XCTAssertTrue(publish(establishment))
        XCTAssertTrue(establishment.isPublished)
        XCTAssertFalse(publish(establishment), "a second publication would replay the capture")
        // And no later event re-announces readiness.
        XCTAssertEqual(establishment.laneStateChanged(label: LINK_FILE_CHANNEL), .none)
        XCTAssertEqual(establishment.authenticated(identity(sas: "999999")), .none)
    }

    // MARK: - exact labels

    /// Anything outside the exact pair fails the whole candidate link, and the
    /// offending channel is closed here rather than by a caller who might
    /// forget.
    func testAnUnexpectedLabelFailsTheLinkClosed() {
        for label in ["data", "relayium-file", "Relayium", "relayium-text ", "", "relayium/1"] {
            let establishment = LinkEstablishment()
            let stray = FakeLane(label)
            XCTAssertEqual(establishment.collect(stray), .fail(.unexpectedLane(label)))
            XCTAssertEqual(stray.closeCount, 1, "\(label) must not be left open")
        }
    }

    /// A second channel on a label already held is not a lane; it is a second
    /// SCTP stream nobody asked for, which would give the peer two producers on
    /// one receiver sequence.
    func testADuplicateLabelFailsTheLinkAndNeverReplacesTheFirstChannel() throws {
        let establishment = LinkEstablishment()
        let first = FakeLane(LINK_FILE_CHANNEL)
        let imposter = FakeLane(LINK_FILE_CHANNEL)
        XCTAssertEqual(establishment.collect(first), .none)
        XCTAssertEqual(establishment.collect(imposter), .fail(.duplicateLane(LINK_FILE_CHANNEL)))
        XCTAssertEqual(imposter.closeCount, 1)
        XCTAssertEqual(first.closeCount, 0, "the first channel was not the one refused")

        // Proof that it was never swapped in: after a (hypothetical) recovery of
        // the link, sends still reach the first channel.
        let live = LinkEstablishment()
        let file = FakeLane(LINK_FILE_CHANNEL)
        _ = live.collect(file)
        _ = live.collect(FakeLane(LINK_TEXT_CHANNEL))
        _ = live.authenticated(identity())
        publish(live)
        try live.send([7], on: .file)
        XCTAssertEqual(file.sent, [[7]])
    }

    // MARK: - a lane that dies

    func testALaneClosingBeforePublicationFailsClosed() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        let file = FakeLane(LINK_FILE_CHANNEL)
        _ = establishment.collect(file)
        _ = establishment.collect(FakeLane(LINK_TEXT_CHANNEL))

        file.state = .closing
        XCTAssertEqual(establishment.laneStateChanged(label: LINK_FILE_CHANNEL),
                       .fail(.laneClosedBeforeReady(LINK_FILE_CHANNEL)))
    }

    /// A channel handed over already dying produces no further state callback,
    /// so `collect` has to notice by itself.
    func testACollectedChannelThatIsAlreadyDyingFailsClosed() {
        let establishment = LinkEstablishment()
        XCTAssertEqual(establishment.collect(FakeLane(LINK_FILE_CHANNEL, state: .closed)),
                       .fail(.laneClosedBeforeReady(LINK_FILE_CHANNEL)))
    }

    /// After publication the same event is terminal for a different reason:
    /// this slice implements no recovery, so a dropped lane ends the transport
    /// rather than holding an authentication open.
    func testALaneClosingAfterPublicationEndsTheTransport() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        let file = FakeLane(LINK_FILE_CHANNEL)
        collectBothLanes(establishment, file, FakeLane(LINK_TEXT_CHANNEL))
        publish(establishment)

        file.state = .closed
        XCTAssertEqual(establishment.laneStateChanged(label: LINK_FILE_CHANNEL),
                       .fail(.laneClosed(LINK_FILE_CHANNEL)))
    }

    // MARK: - capture and replay

    /// An SCTP stream can deliver before its sibling has finished DCEP. What
    /// the peer said before a consumer existed is replayed per-lane FIFO at
    /// publication, in one indivisible step.
    func testFramesArrivingBeforePublicationAreReplayedPerLaneInOrder() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        collectBothLanes(establishment, FakeLane(LINK_FILE_CHANNEL), FakeLane(LINK_TEXT_CHANNEL))

        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL, frame: [1]), .captured)
        XCTAssertEqual(establishment.inbound(label: LINK_TEXT_CHANNEL, frame: [9]), .captured)
        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL, frame: [2]), .captured)

        let replay = publishCollectingReplay(establishment)
        XCTAssertEqual(replay.file, [[1], [2]])
        XCTAssertEqual(replay.text, [[9]])
    }

    /// Ready is where an owner naturally builds the consumers that need the
    /// identity — and therefore where it may decide it does not want the link
    /// after all. The backlog must not then be pushed at it.
    func testClosingFromInsideReadyStopsTheReplayBeforeItStarts() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        collectBothLanes(establishment, FakeLane(LINK_FILE_CHANNEL), FakeLane(LINK_TEXT_CHANNEL))
        _ = establishment.inbound(label: LINK_FILE_CHANNEL, frame: [1])
        _ = establishment.inbound(label: LINK_TEXT_CHANNEL, frame: [9])

        var delivered: [[UInt8]] = []
        XCTAssertTrue(establishment.publish(ready: { _ in establishment.close() },
                                            frame: { _, bytes in delivered.append(bytes) }))
        XCTAssertEqual(delivered, [], "a consumer that closed from onReady is gone")
    }

    /// The same rule one frame in: closing from a replayed frame stops the NEXT
    /// one, not the one after the last.
    func testClosingFromInsideAReplayedFrameStopsTheRestOfTheBacklog() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        collectBothLanes(establishment, FakeLane(LINK_FILE_CHANNEL), FakeLane(LINK_TEXT_CHANNEL))
        for frame: [UInt8] in [[1], [2], [3]] {
            _ = establishment.inbound(label: LINK_FILE_CHANNEL, frame: frame)
        }
        _ = establishment.inbound(label: LINK_TEXT_CHANNEL, frame: [9])

        var delivered: [[UInt8]] = []
        establishment.publish(ready: { _ in }, frame: { _, bytes in
            delivered.append(bytes)
            establishment.close()
        })
        XCTAssertEqual(delivered, [[1]], "and the text lane's backlog is not delivered either")
    }

    func testFramesAfterPublicationGoStraightToTheirExactLane() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        collectBothLanes(establishment, FakeLane(LINK_FILE_CHANNEL), FakeLane(LINK_TEXT_CHANNEL))
        publish(establishment)

        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL, frame: [1]), .deliver(.file))
        XCTAssertEqual(establishment.inbound(label: LINK_TEXT_CHANNEL, frame: [9]), .deliver(.text))
    }

    /// A frame on a label this transport holds no channel for is not a lane
    /// frame — nothing would ever replay it and nothing can consume it.
    func testFramesFromUncollectedLabelsAreIgnored() {
        let establishment = LinkEstablishment()
        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL, frame: [1]), .ignore)
        XCTAssertEqual(establishment.inbound(label: "data", frame: [1]), .ignore)
    }

    /// Overflow is never silent truncation: a dropped admitted frame is exactly
    /// what the receiver codecs cannot tolerate.
    func testCaptureOverflowFailsTheLinkClosed() {
        let establishment = LinkEstablishment(capture: LinkFrameCapture(limit: 8))
        _ = establishment.collect(FakeLane(LINK_FILE_CHANNEL))
        _ = establishment.collect(FakeLane(LINK_TEXT_CHANNEL))

        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL,
                                             frame: [UInt8](repeating: 0, count: 8)), .captured)
        XCTAssertEqual(establishment.inbound(label: LINK_TEXT_CHANNEL, frame: [1]),
                       .fail(.captureOverflow),
                       "the bound is combined across both lanes")
    }

    // MARK: - send

    func testSendIsRefusedBeforePublication() {
        let establishment = LinkEstablishment()
        let file = FakeLane(LINK_FILE_CHANNEL)
        collectBothLanes(establishment, file, FakeLane(LINK_TEXT_CHANNEL))

        XCTAssertThrowsError(try establishment.send([1], on: .file)) {
            XCTAssertEqual($0 as? LinkTransportError, .notReady)
        }
        XCTAssertEqual(file.sent, [], "nothing may go to a peer whose reveal is unverified")
    }

    /// A lane is selected by case, and the bytes reach that channel and no
    /// other one.
    func testSendReachesTheExactSelectedLane() throws {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        let file = FakeLane(LINK_FILE_CHANNEL)
        let text = FakeLane(LINK_TEXT_CHANNEL)
        collectBothLanes(establishment, file, text)
        publish(establishment)

        try establishment.send([1, 2], on: .file)
        try establishment.send([3], on: .text)
        XCTAssertEqual(file.sent, [[1, 2]])
        XCTAssertEqual(text.sent, [[3]])
    }

    func testSendOnALaneThatIsNoLongerOpenIsRefusedRatherThanDropped() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        let file = FakeLane(LINK_FILE_CHANNEL)
        collectBothLanes(establishment, file, FakeLane(LINK_TEXT_CHANNEL))
        publish(establishment)

        file.state = .closing
        XCTAssertThrowsError(try establishment.send([1], on: .file)) {
            XCTAssertEqual($0 as? LinkTransportError, .laneUnavailable(.file))
        }
    }

    func testARefusedChannelSendSurfacesRatherThanBeingSwallowed() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        let file = FakeLane(LINK_FILE_CHANNEL)
        collectBothLanes(establishment, file, FakeLane(LINK_TEXT_CHANNEL))
        publish(establishment)

        file.sendSucceeds = false
        XCTAssertThrowsError(try establishment.send([1], on: .file)) {
            XCTAssertEqual($0 as? LinkTransportError, .sendFailed(.file))
        }
    }

    func testBufferedAmountIsPerLane() {
        let establishment = LinkEstablishment()
        let file = FakeLane(LINK_FILE_CHANNEL)
        let text = FakeLane(LINK_TEXT_CHANNEL)
        collectBothLanes(establishment, file, text)
        file.laneBufferedAmount = 42

        XCTAssertEqual(establishment.bufferedAmount(on: .file), 42)
        XCTAssertEqual(establishment.bufferedAmount(on: .text), 0)
    }

    // MARK: - one authentication, one set of codecs

    /// The link owns ONE `LinkCodecs` for its lifetime. A second identity would
    /// be a second pair of AEAD sequences counting from zero under keys that
    /// have already been used.
    func testASecondIdentityIsRefusedRatherThanReplacingTheFirst() {
        let establishment = LinkEstablishment()
        let first = identity(sas: "111111")
        XCTAssertEqual(establishment.authenticated(first), .none)
        XCTAssertEqual(establishment.authenticated(identity(sas: "222222")), .none)

        XCTAssertEqual(establishment.identity?.sas, "111111")
        XCTAssertTrue(establishment.identity?.codecs === first.codecs)
    }

    /// This driver establishes; it does not replace. Stated as a constant so a
    /// reader does not have to infer it from what the driver happens to
    /// implement.
    func testThisBuildDoesNotClaimTransportReplacement() {
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
    }

    // MARK: - teardown

    func testCloseIsIdempotentAndReportsOnlyTheCallThatClosed() {
        let establishment = LinkEstablishment()
        let file = FakeLane(LINK_FILE_CHANNEL)
        collectBothLanes(establishment, file, FakeLane(LINK_TEXT_CHANNEL))

        XCTAssertTrue(establishment.close())
        XCTAssertFalse(establishment.close())
        XCTAssertFalse(establishment.close())
        XCTAssertEqual(file.closeCount, 1, "a lane is closed once, not once per close() call")
        XCTAssertTrue(establishment.isClosed)
    }

    func testEverythingIsInertAfterClose() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        collectBothLanes(establishment, FakeLane(LINK_FILE_CHANNEL), FakeLane(LINK_TEXT_CHANNEL))
        publish(establishment)
        _ = establishment.close()

        let late = FakeLane(LINK_FILE_CHANNEL)
        XCTAssertEqual(establishment.collect(late), .none)
        XCTAssertEqual(late.closeCount, 1, "a channel arriving after close is not left open")
        XCTAssertEqual(establishment.laneStateChanged(label: LINK_FILE_CHANNEL), .none)
        XCTAssertEqual(establishment.authenticated(identity()), .none)
        XCTAssertEqual(establishment.inbound(label: LINK_FILE_CHANNEL, frame: [1]), .ignore)
        XCTAssertFalse(publish(establishment))
        XCTAssertThrowsError(try establishment.send([1], on: .file)) {
            XCTAssertEqual($0 as? LinkTransportError, .closed)
        }
    }

    /// The identity owns the link's one `LinkCodecs`, and with it both session
    /// keys. A closed establishment has no use for either, and a consumer that
    /// wanted them was handed its own reference at publication.
    func testCloseReleasesTheIdentityAndItsCodecs() {
        let establishment = LinkEstablishment()
        _ = establishment.authenticated(identity())
        collectBothLanes(establishment, FakeLane(LINK_FILE_CHANNEL), FakeLane(LINK_TEXT_CHANNEL))

        var published: LinkIdentity?
        establishment.publish(ready: { published = $0 }, frame: { _, _ in })
        XCTAssertNotNil(establishment.identity)

        _ = establishment.close()
        XCTAssertNil(establishment.identity, "no key material is retained by a closed transport")
        XCTAssertNotNil(published?.codecs, "the consumer's own reference is unaffected")
    }

    // MARK: - open lanes

    /// Which lanes are open is the establishment's answer, not a second map the
    /// owner keeps: a watchdog re-arming on a lane that has since closed is
    /// exactly what two answers to that question produce.
    func testOpenLanesReportsExactlyTheChannelsThatAreOpenNow() {
        let establishment = LinkEstablishment()
        let file = FakeLane(LINK_FILE_CHANNEL)
        let text = FakeLane(LINK_TEXT_CHANNEL, state: .connecting)
        XCTAssertEqual(establishment.openLanes, [])

        _ = establishment.collect(file)
        XCTAssertEqual(establishment.openLanes, [.file])
        _ = establishment.collect(text)
        XCTAssertEqual(establishment.openLanes, [.file], "connecting is not open")

        text.state = .open
        XCTAssertEqual(establishment.openLanes, [.file, .text])

        file.state = .closing
        XCTAssertEqual(establishment.openLanes, [.text])
    }

    /// Captured-but-undelivered frames belong to codecs that are going away
    /// with the transport.
    func testCloseDropsTheCapture() {
        let capture = LinkFrameCapture()
        let establishment = LinkEstablishment(capture: capture)
        collectBothLanes(establishment, FakeLane(LINK_FILE_CHANNEL), FakeLane(LINK_TEXT_CHANNEL))
        _ = establishment.inbound(label: LINK_FILE_CHANNEL, frame: [1])

        _ = establishment.close()
        XCTAssertEqual(capture.take().file, [])
    }

    // MARK: - lane vocabulary

    func testLanesMapToTheExactWireLabelsAndNothingElse() {
        XCTAssertEqual(LinkLane.file.label, LINK_FILE_CHANNEL)
        XCTAssertEqual(LinkLane.text.label, LINK_TEXT_CHANNEL)
        XCTAssertEqual(LinkLane.allCases.map(\.label), LINK_CHANNEL_LABELS)
        XCTAssertEqual(LinkLane(label: LINK_FILE_CHANNEL), .file)
        XCTAssertEqual(LinkLane(label: LINK_TEXT_CHANNEL), .text)
        for label in ["data", "relayium ", "RELAYIUM", ""] {
            XCTAssertNil(LinkLane(label: label), "\(label) is not a link lane")
        }
    }
}
