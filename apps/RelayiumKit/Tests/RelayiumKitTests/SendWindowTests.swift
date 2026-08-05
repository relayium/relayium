import XCTest
@testable import RelayiumKit

final class SendWindowTests: XCTestCase {
    func testBlocksBeyondWindow() {
        var w = SendWindow(window: 100)
        XCTAssertTrue(w.maySend)
        w.recordSent(80); XCTAssertTrue(w.maySend)   // inFlight 80 <= 100
        w.recordSent(40); XCTAssertFalse(w.maySend)  // inFlight 120 > 100
        w.recordAck(50); XCTAssertTrue(w.maySend)    // inFlight 70 <= 100
    }
    func testAckIsMonotonic() {
        var w = SendWindow(window: 100)
        w.recordSent(120); w.recordAck(60); w.recordAck(30) // stale ack ignored
        XCTAssertEqual(w.inFlight, 60)                        // 120 - 60
    }
    func testDefaultWindowIsFlowWindow() {
        var w = SendWindow(); w.recordSent(FLOW_WINDOW); XCTAssertTrue(w.maySend)
        w.recordSent(1); XCTAssertFalse(w.maySend)
    }
}

/// Flow-control accounting for a REUSABLE file lane, where a batch can be
/// resumed on a replacement transport and the cumulative cursors both rebase to
/// the durable checkpoint.
///
/// Every number here is peer-controlled or peer-influenced: the ACK total comes
/// off the wire as an IEEE double, and the frame length comes from a transport
/// message. Neither may wrap, trap or buy credit.
final class LinkFileFlowControlTests: XCTestCase {

    // ── only file bytes count ───────────────────────────────────────────────

    func testOnlyChunkFramesRecordPlaintext() {
        var w = SendWindow(window: 1_000_000)
        let chunk = realtimeFrame(kind: RealtimeKind.chunk, seq: 1,
                                  payload: [UInt8](repeating: 0, count: 100 + 16))
        XCTAssertEqual(w.recordSentFrame(chunk), 100)
        let part = realtimeFrame(kind: RealtimeKind.chunkPart, seq: 2,
                                 payload: [UInt8](repeating: 0, count: 40 + 16))
        XCTAssertEqual(w.recordSentFrame(part), 40, "a fragment carries file bytes too")
        XCTAssertEqual(w.inFlight, 140)

        for kind in [RealtimeKind.doneEnc, RealtimeKind.batchEnc, RealtimeKind.batchPart] {
            let frame = realtimeFrame(kind: kind, seq: 3, payload: [UInt8](repeating: 0, count: 64))
            XCTAssertEqual(w.recordSentFrame(frame), 0, "kind \(kind) carries no file plaintext")
        }
        XCTAssertEqual(w.inFlight, 140, "manifest and integrity frames are not progress")
    }

    /// A chunk frame too short to hold its own AEAD tag would otherwise record a
    /// NEGATIVE plaintext length and hand the window free credit.
    func testUndersizedChunkFrameRecordsNothing() {
        var w = SendWindow(window: 100)
        w.recordSent(200)
        XCTAssertFalse(w.maySend)
        XCTAssertEqual(w.recordSentFrame([RealtimeKind.chunk, 0, 0, 0, 0]), 0)
        XCTAssertEqual(w.inFlight, 200)
        XCTAssertFalse(w.maySend, "a malformed frame must not open the window")
    }

    // ── the resume rebase ───────────────────────────────────────────────────

    func testResumeRebasesBothCursorsToTheDurableOffset() {
        var w = SendWindow(window: 100)
        w.recordSent(500)          // the attempt that died
        _ = w.recordAck(180)
        w.rebase(to: 200)          // durable batch offset the peer asked to resume from
        XCTAssertEqual(w.inFlight, 0, "a replacement attempt starts with a whole window")
        XCTAssertTrue(w.maySend)
        w.recordSent(101)
        XCTAssertFalse(w.maySend)
        _ = w.recordAck(250)
        XCTAssertEqual(w.inFlight, 51)
    }

    /// The ACK is cumulative and batch-local, so after a rebase the pre-rebase
    /// totals are exactly the delayed frames a forgery would replay.
    func testAckBelowTheRebasedBaseGrantsNoCredit() {
        var w = SendWindow(window: 100)
        w.rebase(to: 1_000)
        w.recordSent(300)
        XCTAssertEqual(w.inFlight, 300)
        XCTAssertFalse(w.recordAck(999))
        XCTAssertFalse(w.recordAck(0))
        XCTAssertEqual(w.inFlight, 300)
        XCTAssertTrue(w.recordAck(1_100))
        XCTAssertEqual(w.inFlight, 200)
    }

    func testPacerRebasesSoTheNextAckIsMeasuredFromTheCheckpoint() {
        var p = AckPacer(interval: 100)
        XCTAssertEqual(p.onWritten(total: 100), 100)
        p.rebase(to: 5_000)
        XCTAssertNil(p.onWritten(total: 5_050), "50 bytes past the checkpoint is not an interval")
        XCTAssertEqual(p.onWritten(total: 5_100), 5_100)
    }

    func testPacerIgnoresATotalThatMovesBackwards() {
        var p = AckPacer(interval: 100)
        XCTAssertEqual(p.onWritten(total: 500), 500)
        XCTAssertNil(p.onWritten(total: 100))
        XCTAssertNil(p.onWritten(total: -1_000_000))
        XCTAssertEqual(p.onWritten(total: 600), 600)
    }

    // ── hostile numbers ─────────────────────────────────────────────────────

    func testAckValuesOffTheWireAreValidatedBeforeUse() {
        XCTAssertEqual(linkFileAckTotal(ackFrame(4096)), 4096)
        XCTAssertEqual(linkFileAckTotal(ackFrame(0)), 0)
        XCTAssertNil(linkFileAckTotal(ackFrame(.nan)))
        XCTAssertNil(linkFileAckTotal(ackFrame(.infinity)))
        XCTAssertNil(linkFileAckTotal(ackFrame(-.infinity)))
        XCTAssertNil(linkFileAckTotal(ackFrame(-1)))
        XCTAssertNil(linkFileAckTotal(ackFrame(1.5)))
        // Above JS's MAX_SAFE_INTEGER a conforming peer cannot count at all.
        XCTAssertNil(linkFileAckTotal(ackFrame(9_007_199_254_740_992)))
        XCTAssertEqual(linkFileAckTotal(ackFrame(9_007_199_254_740_991)), 9_007_199_254_740_991)
        XCTAssertNil(linkFileAckTotal([RealtimeKind.ack, 0, 0, 0, 0]))
    }

    /// `Int(Double)` traps outside `Int`'s range, and a trap a peer chooses is a
    /// remotely triggerable crash. Nothing here may reach that conversion.
    func testHostileAckDoublesNeitherTrapNorGrantCredit() {
        var w = SendWindow(window: 100)
        w.recordSent(500)
        for hostile in [Double.nan, .infinity, -.infinity, -1, 1.5,
                        1e308, -1e308, 9_007_199_254_740_992,
                        Double(Int.max), Double(Int.min)] {
            XCTAssertFalse(w.recordAck(hostile), "\(hostile) must buy nothing")
        }
        XCTAssertEqual(w.inFlight, 500)
    }

    func testAckIsClampedToBytesThisAttemptEmitted() {
        var w = SendWindow(window: 100)
        w.recordSent(300)
        XCTAssertFalse(w.recordAck(301), "an ACK past what we sent can only be forged or delayed")
        XCTAssertEqual(w.inFlight, 300)
        XCTAssertTrue(w.recordAck(300))
        XCTAssertEqual(w.inFlight, 0)
    }

    /// A hostile length near `Int.max` must saturate rather than wrap: a wrapped
    /// `sent` goes NEGATIVE, which makes `inFlight` negative and opens the window
    /// forever.
    func testExtremeSentTotalsSaturateInsteadOfWrapping() {
        var w = SendWindow(window: 100)
        w.recordSent(Int.max)
        w.recordSent(Int.max)
        XCTAssertEqual(w.inFlight, Int.max)
        XCTAssertFalse(w.maySend, "saturation must fail closed, not open the window")
        XCTAssertEqual(w.recordSentFrame(realtimeFrame(kind: RealtimeKind.chunk, seq: 0,
                                                       payload: [UInt8](repeating: 0, count: 32))), 16)
        XCTAssertFalse(w.maySend)
    }

    func testNegativeSentBytesAreRefused() {
        var w = SendWindow(window: 100)
        w.recordSent(50)
        w.recordSent(-1_000)
        XCTAssertEqual(w.inFlight, 50, "a negative length is not a refund")
    }

    func testRebaseRefusesANegativeBase() {
        var w = SendWindow(window: 100)
        w.recordSent(40)
        w.rebase(to: -5)
        XCTAssertEqual(w.inFlight, 40, "an invalid checkpoint must not silently reset the window")
    }

    // ── the shared clamp ────────────────────────────────────────────────────

    func testAdvanceAckMirrorsTheWebGate() {
        // transfer.ts: candidate > acked && candidate <= sent ? candidate : acked
        XCTAssertEqual(advanceAck(acked: 10, sent: 100, candidate: 50), 50)
        XCTAssertEqual(advanceAck(acked: 10, sent: 100, candidate: 10), 10)
        XCTAssertEqual(advanceAck(acked: 10, sent: 100, candidate: 9), 10)
        XCTAssertEqual(advanceAck(acked: 10, sent: 100, candidate: 101), 10)
        XCTAssertEqual(advanceAck(acked: 10, sent: 100, candidate: Int.max), 10)
        XCTAssertEqual(advanceAck(acked: 10, sent: 100, candidate: Int.min), 10)
    }
}
