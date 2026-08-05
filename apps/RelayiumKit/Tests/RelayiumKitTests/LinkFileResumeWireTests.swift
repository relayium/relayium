import XCTest
@testable import RelayiumKit

/// The two receiver states a REUSABLE file lane needs that a one-shot transfer
/// never did: a direction whose batch has closed out but must still accept the
/// replayed final DONE, and a direction with no batch at all that still owes a
/// generation realignment.
///
/// Both are consequences of `link/1` keeping one `RealtimeReceiver` alive for
/// the whole link. A one-shot connection could forget everything after the last
/// DONE because the connection died with it.
final class LinkFileResumeWireTests: XCTestCase {

    private let zeroChain = [UInt8](repeating: 0, count: 32)
    private let key = [UInt8](repeating: 0x41, count: 32)

    /// Drive one whole batch through a real sender/receiver pair and hand back
    /// the durable checkpoint the receiver held when the last file's bytes were
    /// all written — which is exactly `{lastIndex, lastSize, chain}`.
    @discardableResult
    private func runBatch(
        sender: RealtimeSender,
        receiver: RealtimeReceiver,
        metas: [FileMeta],
        bodies: [[UInt8]],
        stoppingBeforeFinalDone: Bool = false
    ) throws -> (checkpoint: [UInt8], events: [RealtimeEvent]) {
        var events: [RealtimeEvent] = []
        for frame in try sender.batchFrames(metas) { events.append(try receiver.feed(frame)) }
        var lastChain = zeroChain
        let frames = try sender.dataFrames(zip(metas, bodies).map { ($0, $1) })
        for (i, frame) in frames.enumerated() {
            let isFinalDone = stoppingBeforeFinalDone && i == frames.count - 1
            if isFinalDone { break }
            events.append(try receiver.feed(frame))
            if frame[0] == RealtimeKind.chunk { lastChain = receiver.snapshotChain() }
        }
        return (lastChain, events)
    }

    // ── the replayed final DONE ─────────────────────────────────────────────

    /// A batch whose last DONE arrived but whose COMPLETE was lost with the
    /// transport. The sender has no acknowledgement, so on the replacement it
    /// resumes from the receiver's checkpoint — the exact end of the last file —
    /// and replays that one encrypted DONE. The receiver must be able to accept
    /// the restore, or the very frame the replay exists to deliver is refused.
    func testAReceiverThatClosedOutStillAcceptsItsOwnDurableEndPoint() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(CHUNK_SIZE, seed: 91)
        let meta = FileMeta(name: "a.bin", size: body.count)
        let run = try runBatch(sender: sender, receiver: receiver, metas: [meta], bodies: [body])
        XCTAssertEqual(run.events.last, .done(ok: true), "the batch really did close out")

        // The gap. The next generation announces the receiver's durable point.
        let end = ResumePoint(index: 0, offset: body.count)
        XCTAssertNoThrow(try receiver.resumeAt(end, chain: run.checkpoint, seq: sender.nextSequence))

        // Exactly what a resumed producer emits from that point: no chunks, one
        // DONE covering the whole file.
        let replay = try sender.dataFrames([(meta, body)], resume: end)
        XCTAssertEqual(replay.count, 1)
        XCTAssertEqual(replay[0][0], RealtimeKind.doneEnc)
        XCTAssertEqual(try receiver.feed(replay[0]), .done(ok: true),
                       "a lost COMPLETE must be repairable without re-sending the file")
    }

    /// The other half: after a batch closes out the lane goes on carrying more
    /// batches, so a fresh manifest must still be admitted.
    func testAReceiverThatClosedOutStillAdmitsTheNextBatch() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let first = WireVectors.content(64, seed: 92)
        try runBatch(sender: sender, receiver: receiver,
                     metas: [FileMeta(name: "a", size: first.count)], bodies: [first])

        let second = WireVectors.content(128, seed: 93)
        let meta = FileMeta(name: "b", size: second.count)
        var events: [RealtimeEvent] = []
        for frame in try sender.batchFrames([meta]) { events.append(try receiver.feed(frame)) }
        XCTAssertEqual(events.last, .batch([meta]))
        for frame in try sender.dataFrames([(meta, second)]) { events.append(try receiver.feed(frame)) }
        XCTAssertEqual(events.last, .done(ok: true))
    }

    /// A second manifest while a batch is still LIVE is still refused. The
    /// closed-out state must widen exactly one gate and no more.
    func testASecondManifestDuringALiveBatchIsStillRefused() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let meta = FileMeta(name: "a", size: CHUNK_SIZE * 2)
        for frame in try sender.batchFrames([meta]) { _ = try receiver.feed(frame) }
        for frame in try sender.batchFrames([FileMeta(name: "b", size: 1)]) {
            if frame[0] == RealtimeKind.batchEnc {
                XCTAssertThrowsError(try receiver.feed(frame)) {
                    XCTAssertEqual($0 as? RealtimeError, .malformed)
                }
            } else {
                _ = try receiver.feed(frame)
            }
        }
    }

    /// Restoring INTO a closed-out batch is the replay, so the completion state
    /// has to come back off with it — otherwise the replayed DONE would be
    /// followed by a manifest gate that is still open.
    func testRestoringIntoAClosedOutBatchReclosesTheManifestGate() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(CHUNK_SIZE, seed: 94)
        let meta = FileMeta(name: "a.bin", size: body.count)
        let run = try runBatch(sender: sender, receiver: receiver, metas: [meta], bodies: [body])
        try receiver.resumeAt(ResumePoint(index: 0, offset: body.count),
                              chain: run.checkpoint, seq: sender.nextSequence)
        // The batch is live again, so a manifest injected before the replayed
        // DONE must be refused exactly as it would mid-transfer.
        for frame in try sender.batchFrames([FileMeta(name: "b", size: 1)])
        where frame[0] == RealtimeKind.batchEnc {
            XCTAssertThrowsError(try receiver.feed(frame)) {
                XCTAssertEqual($0 as? RealtimeError, .malformed)
            }
        }
    }

    /// An ordered BATCH_ABORT retires a closed-out batch as completely as a live
    /// one, so the next manifest is admitted through the ordinary gate.
    func testAbortClearsTheClosedOutStateToo() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(64, seed: 95)
        try runBatch(sender: sender, receiver: receiver,
                     metas: [FileMeta(name: "a", size: body.count)], bodies: [body])
        receiver.abortBatch()
        let meta = FileMeta(name: "b", size: 8)
        var last: RealtimeEvent?
        for frame in try sender.batchFrames([meta]) { last = try receiver.feed(frame) }
        XCTAssertEqual(last, .batch([meta]))
    }

    // ── the idle direction's realignment ────────────────────────────────────

    /// Every transport generation after the first owes exactly one forward-only
    /// realignment before its first protected frame, INCLUDING on a direction
    /// that is merely idle. Without it the next batch's manifest would be sealed
    /// under a nonce this side cannot prove was never used.
    ///
    /// There is no batch here to validate a point against, so the only point that
    /// means anything is the batch-free origin.
    func testAnIdleDirectionRealignsAtTheBatchFreeOrigin() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        // A first generation ran and finished; the sequence is well past zero.
        let body = WireVectors.content(64, seed: 96)
        try runBatch(sender: sender, receiver: receiver,
                     metas: [FileMeta(name: "a", size: body.count)], bodies: [body])
        receiver.abortBatch()

        // The gap burned three nonces the peer never saw.
        _ = try sender.nextChunkFrame([1])
        _ = try sender.nextChunkFrame([2])
        _ = try sender.nextChunkFrame([3])
        XCTAssertNoThrow(try receiver.resumeAtOrigin(seq: sender.nextSequence))

        // The next batch now decrypts, which is the whole point of realigning.
        let meta = FileMeta(name: "b", size: 8)
        let next = WireVectors.content(8, seed: 97)
        var last: RealtimeEvent?
        for frame in try sender.batchFrames([meta]) { last = try receiver.feed(frame) }
        XCTAssertEqual(last, .batch([meta]))
        for frame in try sender.dataFrames([(meta, next)]) { last = try receiver.feed(frame) }
        XCTAssertEqual(last, .done(ok: true))
    }

    /// An "origin" realignment on a direction with a live manifest would rewind a
    /// transfer's position while claiming to move the sequence forward — the one
    /// shape of this call that can lose bytes.
    func testOriginRealignmentIsRefusedWhileABatchIsLive() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(CHUNK_SIZE * 2, seed: 98)
        let meta = FileMeta(name: "a.bin", size: body.count)
        for frame in try sender.batchFrames([meta]) { _ = try receiver.feed(frame) }
        let frames = try sender.dataFrames([(meta, body)])
        _ = try receiver.feed(frames[0])

        XCTAssertThrowsError(try receiver.resumeAtOrigin(seq: sender.nextSequence)) {
            XCTAssertEqual($0 as? RealtimeError, .resumeRejected)
        }
        // The position was not disturbed: the batch carries on exactly where it was.
        for frame in frames.dropFirst() { _ = try receiver.feed(frame) }
    }

    /// A closed-out batch is not a live one, so it realigns at the origin — that
    /// is the ordinary "this direction has nothing to continue" case after the
    /// peer's COMPLETE was received and the batch really is over.
    func testAClosedOutBatchRealignsAtTheOriginToo() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(64, seed: 99)
        try runBatch(sender: sender, receiver: receiver,
                     metas: [FileMeta(name: "a", size: body.count)], bodies: [body])
        XCTAssertNoThrow(try receiver.resumeAtOrigin(seq: sender.nextSequence))
        let meta = FileMeta(name: "b", size: 4)
        var last: RealtimeEvent?
        for frame in try sender.batchFrames([meta]) { last = try receiver.feed(frame) }
        XCTAssertEqual(last, .batch([meta]))
    }

    /// The nonce rule survives both new entry points. A realignment may skip
    /// forward over frames that were sent and lost; moving BACKWARDS would make
    /// an old ciphertext valid again under the same key and sequence number.
    func testNeitherRealignmentMayMoveTheSequenceBackwards() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(CHUNK_SIZE, seed: 100)
        let meta = FileMeta(name: "a.bin", size: body.count)
        let run = try runBatch(sender: sender, receiver: receiver, metas: [meta], bodies: [body])
        let live = sender.nextSequence
        XCTAssertGreaterThan(live, 1)

        XCTAssertThrowsError(try receiver.resumeAtOrigin(seq: live - 1)) {
            XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
        }
        XCTAssertThrowsError(try receiver.resumeAt(ResumePoint(index: 0, offset: body.count),
                                                   chain: run.checkpoint, seq: live - 1)) {
            XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
        }
        // Standing still is forward enough: the announced seq is the one the next
        // protected frame will actually carry.
        XCTAssertNoThrow(try receiver.resumeAtOrigin(seq: live))
    }

    /// The origin realignment resets the chain with the position, because there
    /// is no file left for a carried-over chain to belong to.
    func testOriginRealignmentResetsTheChain() throws {
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(CHUNK_SIZE, seed: 101)
        try runBatch(sender: sender, receiver: receiver,
                     metas: [FileMeta(name: "a.bin", size: body.count)], bodies: [body])
        receiver.abortBatch()
        try receiver.resumeAtOrigin(seq: sender.nextSequence)
        XCTAssertEqual(receiver.snapshotChain(), zeroChain)
    }
}
