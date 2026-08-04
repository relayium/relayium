import XCTest
@testable import RelayiumKit

/// What a `link/1` transport must be before anything is published on it: both
/// exact lanes and nothing else, one authentication step, one set of codecs for
/// the link's whole life, and a bounded window in which a peer that speaks
/// first cannot outrun lane attachment.
final class LinkTransportContractTests: XCTestCase {

    // MARK: - exactly two lanes, by exact label

    func testALinkIsIncompleteUntilBothExactLanesAreOpen() {
        var set = LinkChannelSet()
        XCTAssertFalse(set.isComplete)
        XCTAssertEqual(set.admit(label: LINK_FILE_CHANNEL), .accepted)
        XCTAssertFalse(set.isComplete, "a link whose text lane never opened cannot honour link/1")
        XCTAssertEqual(set.admit(label: LINK_TEXT_CHANNEL), .accepted)
        XCTAssertTrue(set.isComplete)
    }

    func testLaneArrivalOrderIsIrrelevant() {
        var set = LinkChannelSet()
        XCTAssertEqual(set.admit(label: LINK_TEXT_CHANNEL), .accepted)
        XCTAssertEqual(set.admit(label: LINK_FILE_CHANNEL), .accepted)
        XCTAssertTrue(set.isComplete)
    }

    /// A second channel on a label we already hold is not a lane, it is a
    /// second SCTP stream nobody asked for. Admitting it would give the peer
    /// two producers on one receiver sequence.
    func testDuplicateLaneIsRejected() {
        var set = LinkChannelSet()
        _ = set.admit(label: LINK_FILE_CHANNEL)
        XCTAssertEqual(set.admit(label: LINK_FILE_CHANNEL), .duplicate)
    }

    /// Anything outside the exact pair is refused and closed. The legacy `data`
    /// label in particular must not be adopted as a link lane.
    func testUnexpectedLabelsAreRejected() {
        var set = LinkChannelSet()
        for label in ["data", "relayium-file", "Relayium", "relayium-text ", "", "relayium/1"] {
            XCTAssertEqual(set.admit(label: label), .unexpected, "\(label) is not a link lane")
        }
        XCTAssertFalse(set.isComplete)
    }

    // MARK: - bounded pre-attachment capture

    /// An SCTP stream can deliver data before its sibling has finished DCEP, and
    /// on a replacement those frames belong to codecs that already exist. Both
    /// lanes are therefore captured from the instant each channel is collected.
    func testCapturePreservesPerLaneFIFOOrder() {
        let capture = LinkFrameCapture()
        capture.capture(label: LINK_FILE_CHANNEL, frame: [1])
        capture.capture(label: LINK_TEXT_CHANNEL, frame: [9])
        capture.capture(label: LINK_FILE_CHANNEL, frame: [2])
        let taken = capture.take()
        XCTAssertEqual(taken.file, [[1], [2]])
        XCTAssertEqual(taken.text, [[9]])
        XCTAssertFalse(capture.overflowed)
    }

    /// There is deliberately no cross-lane ordering contract; each SCTP stream
    /// is ordered independently.
    func testTakeIsAtomicAndDrainsOnce() {
        let capture = LinkFrameCapture()
        capture.capture(label: LINK_FILE_CHANNEL, frame: [1])
        XCTAssertEqual(capture.take().file, [[1]])
        XCTAssertEqual(capture.take().file, [], "a second take must not replay the first")
    }

    /// Frames captured after the drain belong to the attached lane, not to the
    /// capture buffer — otherwise a replay would feed the live array back into
    /// itself.
    func testCaptureStopsAcceptingAfterTake() {
        let capture = LinkFrameCapture()
        _ = capture.take()
        capture.capture(label: LINK_FILE_CHANNEL, frame: [1])
        XCTAssertEqual(capture.take().file, [])
    }

    /// The bound is combined across both lanes, and overflow is NEVER silent
    /// truncation: a dropped admitted frame is exactly what the receiver codecs
    /// cannot tolerate, so the caller has to fail closed.
    func testOverflowIsReportedRatherThanTruncatingSilently() {
        let capture = LinkFrameCapture(limit: 16)
        capture.capture(label: LINK_FILE_CHANNEL, frame: [UInt8](repeating: 0, count: 10))
        XCTAssertFalse(capture.overflowed)
        capture.capture(label: LINK_TEXT_CHANNEL, frame: [UInt8](repeating: 0, count: 10))
        XCTAssertTrue(capture.overflowed, "the bound is combined across both lanes")
    }

    func testOverflowStopsAdmittingRatherThanEvicting() {
        let capture = LinkFrameCapture(limit: 4)
        capture.capture(label: LINK_FILE_CHANNEL, frame: [1, 2, 3, 4])
        capture.capture(label: LINK_FILE_CHANNEL, frame: [5])
        XCTAssertTrue(capture.overflowed)
        XCTAssertEqual(capture.take().file, [[1, 2, 3, 4]],
                       "the earliest frames are the ones that matter")
    }

    func testDefaultCaptureBoundMatchesWeb() {
        XCTAssertEqual(LINK_CAPTURE_MAX_BYTES, 256 * 1024)
    }

    /// A label outside the exact pair is not a lane. Nothing here would ever
    /// replay it, so it must not be able to spend a budget that exists for
    /// lanes — still less to trip the overflow that makes the caller fail the
    /// whole link closed.
    func testUnexpectedLabelsConsumeNoCaptureBudget() {
        let capture = LinkFrameCapture(limit: 8)
        capture.capture(label: "data", frame: [UInt8](repeating: 0, count: 64))
        XCTAssertFalse(capture.overflowed, "a label that is not a lane cannot overflow the bound")

        capture.capture(label: LINK_FILE_CHANNEL, frame: [1, 2, 3, 4, 5, 6, 7, 8])
        XCTAssertFalse(capture.overflowed, "the whole bound was still available")
        XCTAssertEqual(capture.take().file, [[1, 2, 3, 4, 5, 6, 7, 8]])
    }

    /// …and it does not disturb the two-lane FIFO it is interleaved with.
    func testUnexpectedLabelsDoNotDisturbTwoLaneFIFOOrder() {
        let capture = LinkFrameCapture()
        capture.capture(label: LINK_FILE_CHANNEL, frame: [1])
        capture.capture(label: "data", frame: [99])
        capture.capture(label: LINK_TEXT_CHANNEL, frame: [9])
        capture.capture(label: LINK_FILE_CHANNEL, frame: [2])
        let taken = capture.take()
        XCTAssertEqual(taken.file, [[1], [2]])
        XCTAssertEqual(taken.text, [[9]])
        XCTAssertFalse(capture.overflowed)
    }

    /// Exactly the bound fits; one byte past it is refused and admits nothing.
    ///
    /// The source writes this as `frame.count <= limit - bytes` rather than
    /// `bytes + frame.count <= limit` because the frame length is peer-supplied
    /// and the addition wraps for a value near `Int.max` into one that passes.
    /// A frame that large cannot be allocated to test directly, so what is
    /// pinned here is the boundary the safe form has to keep exact.
    func testTheCaptureBoundIsExactAtItsEdge() {
        let exact = LinkFrameCapture(limit: 8)
        exact.capture(label: LINK_FILE_CHANNEL, frame: [UInt8](repeating: 0, count: 8))
        XCTAssertFalse(exact.overflowed, "exactly the bound fits")
        XCTAssertEqual(exact.take().file.count, 1)

        let over = LinkFrameCapture(limit: 8)
        over.capture(label: LINK_FILE_CHANNEL, frame: [UInt8](repeating: 0, count: 9))
        XCTAssertTrue(over.overflowed)
        XCTAssertEqual(over.take().file, [], "and nothing was admitted")
    }

    // MARK: - one authentication step, one set of codecs

    /// The contract of a transport replacement: the same `SessionKeys`, the
    /// same SAS and the same four codec objects, with only the connection and
    /// the two channels changing. A rebuilt transport must not be an
    /// opportunity to construct a second sender.
    func testTransportReplacementPreservesKeysSASAndAllFourCodecs() {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                recvKey: [UInt8](repeating: 2, count: 32))
        let first = LinkIdentity(peerId: "p", role: .initiator, sas: "123456", codecs: codecs)
        let rebuilt = first.replacingTransport()

        XCTAssertEqual(rebuilt.sas, first.sas)
        XCTAssertEqual(rebuilt.peerId, first.peerId)
        XCTAssertEqual(rebuilt.role, first.role)
        XCTAssertTrue(rebuilt.codecs === first.codecs)
        XCTAssertTrue(rebuilt.codecs.textSender === first.codecs.textSender)
        XCTAssertTrue(rebuilt.codecs.textReceiver === first.codecs.textReceiver)
        XCTAssertTrue(rebuilt.codecs.fileSender === first.codecs.fileSender)
        XCTAssertTrue(rebuilt.codecs.fileReceiver === first.codecs.fileReceiver)
        XCTAssertEqual(rebuilt.authenticationGeneration, first.authenticationGeneration,
                       "a rebuilt transport is the same authentication step")
    }

    // MARK: - link-lifetime nonce ownership

    /// Two conversations, one sender. The second conversation's first frame must
    /// continue the sequence, never restart it — restarting reuses an AES-GCM
    /// nonce under the same key, which is catastrophic.
    func testTextSequenceContinuesAcrossReopenedConversations() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                recvKey: [UInt8](repeating: 2, count: 32))
        let lane = LinkTextLane(role: .initiator)

        _ = lane.localOpen()
        _ = lane.inboundControl(RealtimeControl.accept.rawValue)
        let first = try codecs.textSender.frame(body: "one", key: codecs.textSendKey)
        _ = lane.localEnd()
        _ = lane.inboundControl(LINK_TEXT_END)

        _ = lane.localOpen()
        _ = lane.inboundControl(RealtimeControl.accept.rawValue)
        let second = try codecs.textSender.frame(body: "two", key: codecs.textSendKey)

        XCTAssertEqual(sequenceOf(first), 0)
        XCTAssertEqual(sequenceOf(second), 1, "a new conversation must not reset the nonce")
    }

    /// The same claim for the file lane: a second batch continues the sequence
    /// the first one advanced.
    func testFileSequenceContinuesAcrossBatches() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                recvKey: [UInt8](repeating: 2, count: 32))
        let first = try codecs.fileSender.batchFrame([FileMeta(name: "a.txt", size: 1)])
        let second = try codecs.fileSender.batchFrame([FileMeta(name: "b.txt", size: 1)])
        XCTAssertEqual(sequenceOf(first), 0)
        XCTAssertEqual(sequenceOf(second), 1, "a new batch must not reset the nonce")
    }

    /// The two lanes have independent sequences under independently derived
    /// keys, so a message and a file chunk can never collide on one nonce.
    func testTextAndFileLanesOwnSeparateSequencesAndKeys() throws {
        let session = [UInt8](repeating: 3, count: 32)
        let codecs = LinkCodecs(sendKey: session, recvKey: [UInt8](repeating: 4, count: 32))
        XCTAssertNotEqual(codecs.textSendKey, session,
                          "the text key is domain-separated from the file key")
        XCTAssertEqual(codecs.textSendKey, deriveTextKey(sessionKey: session))

        let file = try codecs.fileSender.batchFrame([FileMeta(name: "a.txt", size: 1)])
        let text = try codecs.textSender.frame(body: "hi", key: codecs.textSendKey)
        XCTAssertEqual(sequenceOf(file), 0)
        XCTAssertEqual(sequenceOf(text), 0, "each lane counts on its own")
        XCTAssertEqual(file[0], RealtimeKind.batchEnc)
        XCTAssertEqual(text[0], RealtimeKind.text)
    }

    /// Direction separation: our send key is the peer's receive key, so the two
    /// directions must never collapse onto one counter.
    func testDirectionsAreDerivedIndependently() {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                recvKey: [UInt8](repeating: 2, count: 32))
        XCTAssertNotEqual(codecs.textSendKey, codecs.textRecvKey)
    }

    // MARK: - lane independence

    /// The file lane must survive every text-lane outcome. A poisoned text lane
    /// is a poisoned text lane, not a dead link.
    func testPoisonedTextLaneLeavesTheFileLaneUsable() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                recvKey: [UInt8](repeating: 2, count: 32))
        let text = LinkTextLane(role: .initiator)
        _ = text.localOpen()
        _ = text.inboundControl(RealtimeControl.accept.rawValue)
        _ = text.localEnd()
        _ = text.endAckTimedOut()
        XCTAssertTrue(text.codecsPoisoned)

        // The file lane is untouched and its sequence is where it was.
        let frame = try codecs.fileSender.batchFrame([FileMeta(name: "a.txt", size: 1)])
        XCTAssertEqual(sequenceOf(frame), 0)
    }

    // MARK: - helpers

    private func sequenceOf(_ frame: [UInt8]) -> UInt32 {
        (UInt32(frame[1]) << 24) | (UInt32(frame[2]) << 16)
            | (UInt32(frame[3]) << 8) | UInt32(frame[4])
    }
}
