import XCTest
@testable import RelayiumKit

/// The producer against a source that returns POSITIVE SHORT reads.
///
/// `PlaintextSource.read(_:)` promises "up to `max` bytes", and `FileURLSource`
/// is a single `pread`, which POSIX allows to return fewer bytes than asked for
/// long before end of file — after partial progress around an interrupt, or on
/// filesystems that simply answer per extent. That is legal, so it has to
/// produce the same wire as a source that always fills the request.
///
/// It does not, unless the producer refills: emitting each positive return as a
/// whole logical chunk changes the hash-chain unit (so the browser cannot verify
/// the DONE), and lets the receiver checkpoint at an offset that is neither on
/// the `CHUNK_SIZE` grid nor the exact end of the file — which the sender then
/// refuses as unaligned when the receiver asks to resume from its OWN durable
/// point.
final class RealtimeFrameProducerShortReadTests: XCTestCase {

    /// Returns a positive but deliberately irregular number of bytes, always
    /// fewer than asked once the file is bigger than a step, and never zero while
    /// content remains. It is a conforming source: nothing here is malformed.
    struct ShortReadSource: PlaintextSource {
        let name: String
        private let content: [UInt8]
        private let steps: [Int]
        private var off = 0
        private var step = 0
        var size: Int { content.count }

        init(name: String, bytes: [UInt8],
             steps: [Int] = [1, 7, 4_096, 999, 65_536, 3, CHUNK_SIZE - 1]) {
            self.name = name
            self.content = bytes
            self.steps = steps
        }

        mutating func read(_ max: Int) throws -> [UInt8] {
            guard off < content.count else { return [] }
            let want = Swift.min(max, steps[step % steps.count], content.count - off)
            step += 1
            let end = off + want
            defer { off = end }
            return Array(content[off..<end])
        }
    }

    /// A source that hands back MORE than it was asked for. Not a real
    /// filesystem: a broken or hostile `PlaintextSource` implementation, whose
    /// bytes the producer cannot place on the chunk grid.
    struct OverReadSource: PlaintextSource {
        let name: String
        private let content: [UInt8]
        private let extra: Int
        private var off = 0
        var size: Int { content.count }

        init(name: String, bytes: [UInt8], extra: Int) {
            self.name = name; self.content = bytes; self.extra = extra
        }

        mutating func read(_ max: Int) throws -> [UInt8] {
            guard off < content.count else { return [] }
            let end = Swift.min(off + max + extra, content.count)
            defer { off = end }
            return Array(content[off..<end])
        }
    }

    private func drain(_ p: RealtimeFrameProducer) throws -> [[UInt8]] {
        var out: [[UInt8]] = []
        while let f = try p.next() { out.append(f) }
        return out
    }

    // ── the wire ────────────────────────────────────────────────────────────

    /// The load-bearing one: short positive reads must not change a single byte
    /// of what goes out, at the default frame size and when the transport
    /// fragments.
    func testShortPositiveReadsProduceExactlyTheDataFramesWire() throws {
        let key = [UInt8](repeating: 0x51, count: 32)
        let bodies = [WireVectors.content(CHUNK_SIZE * 2 + 77, seed: 91),
                      WireVectors.content(13, seed: 92),
                      [],
                      WireVectors.content(CHUNK_SIZE, seed: 93)]
        let metas = bodies.enumerated().map { FileMeta(name: "f\($0.offset)", size: $0.element.count) }

        for limit in [Double(CHUNK_SIZE + CHUNK_OVERHEAD), 65_536, .infinity] {
            let a = RealtimeSender(sessionKey: key)
            _ = try a.batchFrames(metas, maxFrameBytes: limit)
            let expected = try a.dataFrames(zip(metas, bodies).map { ($0, $1) }, maxFrameBytes: limit)

            let b = RealtimeSender(sessionKey: key)
            _ = try b.batchFrames(metas, maxFrameBytes: limit)
            let p = RealtimeFrameProducer(
                sender: b,
                sources: bodies.enumerated().map { ShortReadSource(name: "f\($0.offset)", bytes: $0.element) },
                declaredSizes: metas.map(\.size), maxFrameBytes: limit)
            let streamed = try drain(p)

            XCTAssertEqual(streamed, expected, "frame size \(limit)")
            // Refilling must not turn the producer into `dataFrames`: the whole
            // point is that it still holds one logical chunk at a time.
            XCTAssertLessThanOrEqual(p.peakHeldBytes, (CHUNK_SIZE + 4_096) * 2, "frame size \(limit)")
        }
    }

    /// What the wire difference actually costs downstream: a receiver fed by a
    /// short-reading producer must still only ever surface whole `CHUNK_SIZE`
    /// units (bar each file's last), so every offset it could durably checkpoint
    /// at is one the sender will accept back as a resume point.
    func testAReceiverOnlySeesGridAlignedChunksFromAShortReadingSource() throws {
        let key = [UInt8](repeating: 0x52, count: 32)
        let bodies = [WireVectors.content(CHUNK_SIZE * 3 + 4_321, seed: 94),
                      WireVectors.content(CHUNK_SIZE * 2, seed: 95)]
        let metas = bodies.enumerated().map { FileMeta(name: "f\($0.offset)", size: $0.element.count) }

        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        _ = try receiver.feed(try sender.batchFrame(metas))
        let p = RealtimeFrameProducer(
            sender: sender,
            sources: bodies.enumerated().map { ShortReadSource(name: "f\($0.offset)", bytes: $0.element) },
            declaredSizes: metas.map(\.size), maxFrameBytes: 65_536)

        var index = 0
        var written = 0
        var got: [[UInt8]] = bodies.map { _ in [] }
        var oks: [Bool] = []
        while let f = try p.next() {
            switch try receiver.feed(f) {
            case .pending:
                break
            case .chunk(let c):
                got[index] += c
                written += c.count
                let isFileEnd = written == bodies[index].count
                XCTAssertTrue(c.count == CHUNK_SIZE || isFileEnd,
                              "a \(c.count)-byte chunk that is not the end of file \(index)")
                XCTAssertTrue(resumePointAligned(ResumePoint(index: index, offset: written),
                                                 metas.map(\.size)),
                              "durable offset \(written) of file \(index) is not a resume point "
                              + "the sender would accept back")
            case .done(let ok):
                oks.append(ok)
                index += 1
                written = 0
            default:
                XCTFail("unexpected event")
            }
        }
        XCTAssertEqual(got, bodies)
        XCTAssertEqual(oks, [true, true], "the DONE hash is over CHUNK_SIZE units, not over read sizes")
    }

    /// A resumed batch stages pristine copies, and those short-read too. Hashing
    /// still starts at byte zero while emission still starts at the checkpoint.
    func testAResumedStreamOverAShortReadingSourceMatchesDataFrames() throws {
        let key = [UInt8](repeating: 0x53, count: 32)
        let bodies = [WireVectors.content(CHUNK_SIZE + 3, seed: 96),
                      WireVectors.content(CHUNK_SIZE * 3 + 11, seed: 97)]
        let metas = bodies.enumerated().map { FileMeta(name: "f\($0.offset)", size: $0.element.count) }
        let point = ResumePoint(index: 1, offset: CHUNK_SIZE * 2)

        let a = RealtimeSender(sessionKey: key, startingSequence: 17)
        let expected = try a.dataFrames(zip(metas, bodies).map { ($0, $1) },
                                        resume: point, maxFrameBytes: 65_536)

        let b = RealtimeSender(sessionKey: key, startingSequence: 17)
        let p = RealtimeFrameProducer(
            sender: b,
            sources: bodies.enumerated().map { ShortReadSource(name: "f\($0.offset)", bytes: $0.element) },
            declaredSizes: metas.map(\.size), resume: point, maxFrameBytes: 65_536)
        XCTAssertEqual(try drain(p), expected)
    }

    // ── sources that do not hold up their end ───────────────────────────────

    /// End of input in the middle of a logical unit is the short-source failure,
    /// and the half-filled unit must never reach the wire: sending it would put
    /// an off-grid chunk in the chain and burn a nonce on bytes the receiver
    /// cannot checkpoint.
    func testEndOfInputMidLogicalUnitThrowsWithoutEmittingThePartialUnit() throws {
        let key = [UInt8](repeating: 0x54, count: 32)
        let body = WireVectors.content(CHUNK_SIZE + 1_000, seed: 98)
        let s = RealtimeSender(sessionKey: key)
        // Declares one full chunk plus a tail; the source runs out 500 bytes in.
        let p = RealtimeFrameProducer(sender: s,
                                      sources: [ShortReadSource(name: "x", bytes: Array(body[0..<500]))],
                                      declaredSizes: [body.count])
        XCTAssertThrowsError(try drain(p)) {
            XCTAssertEqual($0 as? RealtimeSenderError, .sourceShorterThanDeclared(name: "x"))
        }
        XCTAssertEqual(s.nextSequence, 0, "the incomplete logical unit was sealed and exposed")
    }

    /// A source returning more than it was asked for cannot be placed on the
    /// chunk grid — its extra bytes are outside the window the producer is
    /// allowed to take at this position — so it fails instead of emitting an
    /// oversized logical unit.
    func testASourceReturningMoreThanRequestedFailsInsteadOfEmittingAnOversizedUnit() throws {
        let key = [UInt8](repeating: 0x55, count: 32)
        let body = WireVectors.content(CHUNK_SIZE * 2, seed: 99)
        let s = RealtimeSender(sessionKey: key)
        let p = RealtimeFrameProducer(sender: s,
                                      sources: [OverReadSource(name: "x", bytes: body, extra: 64)],
                                      declaredSizes: [body.count])
        XCTAssertThrowsError(try drain(p)) {
            XCTAssertEqual($0 as? RealtimeSenderError, .sourceLongerThanDeclared(name: "x"))
        }
        XCTAssertEqual(s.nextSequence, 0, "an oversized logical unit went out")
    }
}
