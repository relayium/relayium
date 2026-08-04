import XCTest
@testable import RelayiumKit

/// Bounded resumed streaming: the producer replays a batch from a durable
/// checkpoint over pristine staged sources, without ever holding more than one
/// logical chunk and without reopening anything by path.
final class RealtimeFrameProducerResumeTests: XCTestCase {

    /// A source that records what was actually read from it. `PlaintextSource` is
    /// a value type, so the counter has to be a reference the test still holds
    /// after the producer has copied the struct.
    final class ReadLog {
        private(set) var calls = 0
        private(set) var bytes = 0
        func record(_ n: Int) { calls += 1; bytes += n }
    }

    struct CountingSource: PlaintextSource {
        let name: String
        let log: ReadLog
        private let content: [UInt8]
        private var off = 0
        var size: Int { content.count }
        init(name: String, bytes: [UInt8], log: ReadLog) {
            self.name = name; self.content = bytes; self.log = log
        }
        mutating func read(_ max: Int) throws -> [UInt8] {
            guard off < content.count else { log.record(0); return [] }
            let end = Swift.min(off + max, content.count)
            log.record(end - off)
            defer { off = end }
            return Array(content[off..<end])
        }
    }

    private func drain(_ p: RealtimeFrameProducer) throws -> [[UInt8]] {
        var out: [[UInt8]] = []
        while let f = try p.next() { out.append(f) }
        return out
    }

    private func sources(_ bodies: [[UInt8]]) -> ([PlaintextSource], [ReadLog]) {
        let logs = bodies.map { _ in ReadLog() }
        let s = bodies.enumerated().map { CountingSource(name: "f\($0.offset)", bytes: $0.element, log: logs[$0.offset]) }
        return (s, logs)
    }

    /// The producer and the whole-batch `dataFrames` must agree byte for byte at
    /// every frame size — the streaming path is the only one a real send uses, so
    /// a divergence is a transfer the browser cannot decrypt.
    func testStreamsTheSameBytesAsDataFramesAtAnyFrameSize() throws {
        let key = [UInt8](repeating: 0x41, count: 32)
        let bodies = [WireVectors.content(CHUNK_SIZE * 2 + 77, seed: 81),
                      [],
                      WireVectors.content(13, seed: 82)]
        let metas = bodies.enumerated().map { FileMeta(name: "f\($0.offset)", size: $0.element.count) }

        for limit in [Double(CHUNK_SIZE + CHUNK_OVERHEAD), 65_536, 4_096 + Double(CHUNK_OVERHEAD), .infinity] {
            let a = RealtimeSender(sessionKey: key)
            _ = try a.batchFrames(metas, maxFrameBytes: limit)
            let expected = try a.dataFrames(zip(metas, bodies).map { ($0, $1) }, maxFrameBytes: limit)

            let b = RealtimeSender(sessionKey: key)
            _ = try b.batchFrames(metas, maxFrameBytes: limit)
            let p = RealtimeFrameProducer(sender: b, sources: sources(bodies).0,
                                          declaredSizes: metas.map(\.size), maxFrameBytes: limit)
            XCTAssertEqual(try drain(p), expected, "frame size \(limit)")
        }
    }

    func testResumedStreamMatchesDataFramesAndSkipsEarlierFilesEntirely() throws {
        let key = [UInt8](repeating: 0x42, count: 32)
        let bodies = [WireVectors.content(CHUNK_SIZE + 3, seed: 83),
                      WireVectors.content(9, seed: 84),
                      WireVectors.content(CHUNK_SIZE * 2, seed: 85)]
        let metas = bodies.enumerated().map { FileMeta(name: "f\($0.offset)", size: $0.element.count) }
        let point = ResumePoint(index: 2, offset: CHUNK_SIZE)

        let a = RealtimeSender(sessionKey: key, startingSequence: 11)
        let expected = try a.dataFrames(zip(metas, bodies).map { ($0, $1) },
                                        resume: point, maxFrameBytes: 65_536)

        let b = RealtimeSender(sessionKey: key, startingSequence: 11)
        let (srcs, logs) = sources(bodies)
        let p = RealtimeFrameProducer(sender: b, sources: srcs, declaredSizes: metas.map(\.size),
                                      resume: point, maxFrameBytes: 65_536)
        XCTAssertEqual(try drain(p), expected)

        // Files before the checkpoint were already delivered: not one byte of
        // them may be read again. Staged sources are descriptor-pinned and a
        // resumed batch is exactly when re-reading them would cost the most.
        XCTAssertEqual(logs[0].calls, 0, "file 0 was read on a resume that starts at file 2")
        XCTAssertEqual(logs[1].calls, 0, "file 1 was read on a resume that starts at file 2")
        // The resumed file IS read from byte zero — the chain hash is defined
        // over the whole file, so its DONE has to cover the skipped bytes too.
        XCTAssertEqual(logs[2].bytes, bodies[2].count)
    }

    /// The full loop through a real receiver: the DONE of a resumed file must
    /// still be the hash of the WHOLE file, which is only true if the producer
    /// hashes from byte zero while emitting from the checkpoint.
    func testResumedProducerFinishesTheFileAgainstARealReceiver() throws {
        let key = [UInt8](repeating: 0x43, count: 32)
        let body = WireVectors.content(CHUNK_SIZE * 3 + 1234, seed: 86)
        let meta = FileMeta(name: "big.bin", size: body.count)

        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        _ = try receiver.feed(try sender.batchFrame([meta]))

        // Attempt 1: stream until two logical chunks are durable, then drop.
        let first = RealtimeFrameProducer(sender: sender, sources: sources([body]).0,
                                          declaredSizes: [body.count])
        var durable = 0
        var got: [UInt8] = []
        while durable < 2, let f = try first.next() {
            if case .chunk(let c) = try receiver.feed(f) { got += c; durable += 1 }
        }
        let checkpoint = ResumePoint(index: 0, offset: got.count)
        XCTAssertEqual(checkpoint.offset, CHUNK_SIZE * 2)
        let chain = receiver.snapshotChain()

        // …and one more frame goes out but never lands.
        _ = try first.next()

        // Attempt 2: a NEW producer over pristine staged copies, on the same
        // sender, at a smaller negotiated size.
        let announce = try sender.resumeStartFrame(checkpoint)
        guard case .resume(_, _, let seq) = try receiver.feed(announce) else { return XCTFail() }
        try receiver.resumeAt(checkpoint, chain: chain, seq: seq)

        let (srcs, logs) = sources([body])
        let second = RealtimeFrameProducer(sender: sender, sources: srcs, declaredSizes: [body.count],
                                           resume: checkpoint, maxFrameBytes: 65_536)
        var ok: Bool?
        while let f = try second.next() {
            switch try receiver.feed(f) {
            case .pending: break
            case .chunk(let c): got += c
            case .done(let done): ok = done
            default: XCTFail("unexpected event")
            }
        }
        XCTAssertEqual(got, body, "no skipped and no duplicated bytes across the drop")
        XCTAssertEqual(ok, true, "the DONE hash must cover the whole file, not just the resumed tail")
        XCTAssertEqual(logs[0].bytes, body.count, "the resumed file is hashed from byte zero")
    }

    /// A point at the exact end of a file emits that file's DONE and nothing
    /// else of it — the case a naive `offset < size` loop silently drops.
    func testAPointAtTheExactEndOfAFileStillEmitsItsDone() throws {
        let key = [UInt8](repeating: 0x44, count: 32)
        let bodies = [WireVectors.content(CHUNK_SIZE + 5, seed: 87), WireVectors.content(7, seed: 88)]
        let metas = bodies.enumerated().map { FileMeta(name: "f\($0.offset)", size: $0.element.count) }
        let point = ResumePoint(index: 0, offset: bodies[0].count)

        let s = RealtimeSender(sessionKey: key, startingSequence: 5)
        let p = RealtimeFrameProducer(sender: s, sources: sources(bodies).0,
                                      declaredSizes: metas.map(\.size), resume: point)
        let frames = try drain(p)
        XCTAssertEqual(frames.map { $0[0] },
                       [RealtimeKind.doneEnc, RealtimeKind.chunk, RealtimeKind.doneEnc])

        let expected = try RealtimeSender(sessionKey: key, startingSequence: 5)
            .dataFrames(zip(metas, bodies).map { ($0, $1) }, resume: point)
        XCTAssertEqual(frames, expected)
    }

    /// An invalid point must fail before a single protected frame exists, so no
    /// nonce is burned by a request the sender was never going to honour.
    func testAnInvalidResumePointFailsBeforeAnyFrameOrNonce() throws {
        let key = [UInt8](repeating: 0x45, count: 32)
        let body = WireVectors.content(CHUNK_SIZE * 2, seed: 89)
        for bad in [ResumePoint(index: 0, offset: 5),               // off the grid
                    ResumePoint(index: 0, offset: CHUNK_SIZE * 3),  // past the end
                    ResumePoint(index: 4, offset: 0),               // no such file
                    ResumePoint(index: -1, offset: 0)] {
            let s = RealtimeSender(sessionKey: key)
            let (srcs, logs) = sources([body])
            let p = RealtimeFrameProducer(sender: s, sources: srcs, declaredSizes: [body.count], resume: bad)
            XCTAssertThrowsError(try p.next(), "\(bad)") {
                XCTAssertEqual($0 as? RealtimeSenderError, .resumePointRejected)
            }
            XCTAssertEqual(s.nextSequence, 0, "\(bad) burned a nonce")
            XCTAssertEqual(logs[0].calls, 0, "\(bad) read a staged source before validating")
        }

        // The same for a connection too small to send files over.
        let s = RealtimeSender(sessionKey: key)
        let p = RealtimeFrameProducer(sender: s, sources: sources([body]).0,
                                      declaredSizes: [body.count], maxFrameBytes: 512)
        XCTAssertThrowsError(try p.next()) {
            XCTAssertEqual($0 as? RealtimeSenderError, .frameSizeTooSmall)
        }
        XCTAssertEqual(s.nextSequence, 0)
    }

    /// Memory must not track the transfer, and it must not start tracking it when
    /// the transport fragments: the producer holds one logical chunk and seals one
    /// piece of it at a time.
    func testMemoryStaysBoundedWhenTheTransportFragments() throws {
        let key = [UInt8](repeating: 0x46, count: 32)
        let big = [UInt8](repeating: 0x7e, count: CHUNK_SIZE * 20)
        let s = RealtimeSender(sessionKey: key)
        _ = try s.batchFrame([FileMeta(name: "big", size: big.count)])
        let p = RealtimeFrameProducer(sender: s, sources: sources([big]).0,
                                      declaredSizes: [big.count], maxFrameBytes: 65_536)
        var frames = 0
        while let f = try p.next() {
            XCTAssertLessThanOrEqual(f.count, 65_536)
            frames += 1
        }
        XCTAssertGreaterThan(frames, 20, "it really did fragment")
        XCTAssertLessThanOrEqual(p.peakHeldBytes, (CHUNK_SIZE + 4096) * 2)
    }

    /// The existing short/grown-source guards still apply on the resumed path:
    /// a staged copy that disagrees with the consented manifest must not ship.
    func testShortAndGrownSourcesAreStillRefusedOnAResumedStream() throws {
        let key = [UInt8](repeating: 0x47, count: 32)
        let point = ResumePoint(index: 0, offset: 0)

        let short = RealtimeFrameProducer(sender: RealtimeSender(sessionKey: key),
                                          sources: [DataSource(name: "x", bytes: [1, 2, 3])],
                                          declaredSizes: [CHUNK_SIZE + 10], resume: point)
        XCTAssertThrowsError(try { while try short.next() != nil {} }()) {
            XCTAssertEqual($0 as? RealtimeSenderError, .sourceShorterThanDeclared(name: "x"))
        }

        let grown = RealtimeFrameProducer(sender: RealtimeSender(sessionKey: key),
                                          sources: [DataSource(name: "x", bytes: [1, 2, 3])],
                                          declaredSizes: [2], resume: point, maxFrameBytes: 65_536)
        XCTAssertThrowsError(try { while try grown.next() != nil {} }()) {
            XCTAssertEqual($0 as? RealtimeSenderError, .sourceLongerThanDeclared(name: "x"))
        }
    }
}
