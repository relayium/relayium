import XCTest
@testable import RelayiumKit

/// The durable-resume wire: RESUME_REQ / RESUME_START, the checkpoint contract,
/// and a sender and receiver that continue a batch across a replaced transport
/// without ever rewinding the AEAD nonce sequence.
///
/// Pinned to bytes the WEB generated. The two numbers a resume request carries
/// are handed straight to the sender's file slicing, and the frame is plaintext
/// on a channel whose signalling has a relay in the middle — so the shapes are
/// tested adversarially, not only on the happy path.
final class RealtimeDurableResumeTests: XCTestCase {

    private let zeroChain = [UInt8](repeating: 0, count: 32)

    // ── the control frames ──────────────────────────────────────────────────

    func testResumeRequestBytesAreCanonicalAndMatchTheWeb() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let p = v.point("resume.reqPoint")
        let frame = resumeReqFrame(index: p.index, offset: p.offset)
        XCTAssertEqual(frame.hexString, v.str("resume.reqFrameHex"))
        // Key order is part of the bytes: {"index":…,"offset":…}, nothing else.
        XCTAssertEqual(String(decoding: frame[5...], as: UTF8.self),
                       #"{"index":3,"offset":987654}"#)
        XCTAssertEqual(frame[0], RealtimeKind.resumeReq)
        XCTAssertEqual(Array(frame[1...4]), [0, 0, 0, 0], "a plaintext frame consumes no nonce")
        XCTAssertEqual(parseResumeReq(frame), p)
        XCTAssertTrue(isResumeReq(frame))
    }

    func testResumeStartBytesAreCanonicalAndMatchTheWeb() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let d = v.dict("resume.startPoint")
        let s = RealtimeSender(sessionKey: [UInt8](repeating: 0x31, count: 32),
                               startingSequence: UInt32(d["seq"] as! Int))
        let frame = try s.resumeStartFrame(v.pointFrom(d))
        XCTAssertEqual(frame.hexString, v.str("resume.startFrameHex"))
        XCTAssertEqual(String(decoding: frame[5...], as: UTF8.self),
                       #"{"index":1,"offset":393216,"seq":9}"#)
        XCTAssertEqual(s.nextSequence, UInt32(d["seq"] as! Int),
                       "announcing where the stream resumes must not itself burn a nonce")
    }

    /// A malformed kind-5 payload is NOT "not a resume request". A lane has to be
    /// able to tell the two apart, because the safe answer to malformed control
    /// on this channel is to fail closed, and the safe answer to an unrelated
    /// frame is to route it onward.
    func testParsingDistinguishesWrongKindFromMalformedPayload() {
        let wrongKind = realtimeFrame(kind: RealtimeKind.chunk, seq: 0, payload: Array(#"{"index":0,"offset":0}"#.utf8))
        XCTAssertNil(parseResumeReq(wrongKind))
        XCTAssertFalse(isResumeReq(wrongKind))

        let malformed = realtimeFrame(kind: RealtimeKind.resumeReq, seq: 0, payload: Array("not json".utf8))
        XCTAssertNil(parseResumeReq(malformed))
        XCTAssertTrue(isResumeReq(malformed), "a lane must be able to fail closed on this")

        // Nothing here may crash on a truncated or empty frame.
        XCTAssertFalse(isResumeReq([]))
        XCTAssertNil(parseResumeReq([]))
        XCTAssertNil(parseResumeReq([RealtimeKind.resumeReq]))
        XCTAssertTrue(isResumeReq([RealtimeKind.resumeReq]))
    }

    /// 续传通道没有对端认证：这条请求可以由信令层的中间人注入，而它带的两个数字会被
    /// 发送端直接拿去切文件——负的 offset 会从文件尾部倒着切，发出去的是文件末尾的
    /// 字节。所以在解析这一层就把形状卡死。
    func testResumeRequestAcceptsOnlyNonNegativeJSONSafeIntegers() {
        let req = { (json: String) in
            realtimeFrame(kind: RealtimeKind.resumeReq, seq: 0, payload: Array(json.utf8))
        }
        XCTAssertEqual(parseResumeReq(req(#"{"index":1,"offset":4096}"#)), ResumePoint(index: 1, offset: 4096))
        XCTAssertEqual(parseResumeReq(req(#"{"index":0,"offset":9007199254740991}"#)),
                       ResumePoint(index: 0, offset: 9_007_199_254_740_991))
        // Extra keys are ignored, exactly like the web's structural typing.
        XCTAssertEqual(parseResumeReq(req(#"{"index":2,"offset":0,"extra":true}"#)), ResumePoint(index: 2, offset: 0))

        for bad in [
            #"{"index":0,"offset":-1000}"#,      // 倒着切文件
            #"{"index":-1,"offset":0}"#,
            #"{"index":0.5,"offset":0}"#,
            #"{"index":0,"offset":1.5}"#,
            #"{"index":true,"offset":0}"#,       // Bool bridges to NSNumber — must not pass
            #"{"index":0,"offset":false}"#,
            #"{"index":"0","offset":0}"#,
            #"{"index":0,"offset":9007199254740992}"#,  // past Number.MAX_SAFE_INTEGER
            #"{"index":0}"#,
            #"{"offset":0}"#,
            "{}",
            "null",
            "[0,1]",
            #"{"index":0,"offset":0}trailing"#,
            "",
        ] {
            XCTAssertNil(parseResumeReq(req(bad)), "\(bad) must not parse as a resume point")
        }
    }

    func testRangeAndAlignmentAreSeparateChecks() {
        let sizes = [100, 200, 2 * CHUNK_SIZE]
        // Range: only the caller knows which files this batch carries.
        XCTAssertTrue(resumePointInRange(ResumePoint(index: 0, offset: 100), sizes))
        XCTAssertFalse(resumePointInRange(ResumePoint(index: 1, offset: 201), sizes))
        XCTAssertFalse(resumePointInRange(ResumePoint(index: 3, offset: 0), sizes))
        XCTAssertFalse(resumePointInRange(ResumePoint(index: -1, offset: 0), sizes))

        // Alignment: the chain hash is defined only on the CHUNK_SIZE grid and at
        // the exact end of a file. Honouring an unaligned point would make the
        // sender skip the bytes between it and the next boundary.
        XCTAssertTrue(resumePointAligned(ResumePoint(index: 2, offset: 0), sizes))
        XCTAssertTrue(resumePointAligned(ResumePoint(index: 2, offset: CHUNK_SIZE), sizes))
        XCTAssertTrue(resumePointAligned(ResumePoint(index: 0, offset: 100), sizes), "the exact end of a file")
        XCTAssertFalse(resumePointAligned(ResumePoint(index: 0, offset: 50), sizes))
        XCTAssertFalse(resumePointAligned(ResumePoint(index: 2, offset: 100_000), sizes))
        XCTAssertFalse(resumePointAligned(ResumePoint(index: 9, offset: 0), sizes))
    }

    // ── the sender's sequence, which may only ever advance ──────────────────

    func testSequenceOnlyAdvancesAcrossBatchDataAndResume() throws {
        let key = [UInt8](repeating: 0x32, count: 32)
        let body = WireVectors.content(CHUNK_SIZE * 2 + 7, seed: 71)
        let meta = FileMeta(name: "a.bin", size: body.count)
        let s = RealtimeSender(sessionKey: key)

        var seqs: [UInt32] = []
        seqs += try s.batchFrames([meta], maxFrameBytes: 65_536).map(seqOf)
        seqs += try s.dataFrames([(meta, body)], maxFrameBytes: 65_536).map(seqOf)
        // The transport dies here; those frames are burned, never re-sent.
        let announce = try s.resumeStartFrame(ResumePoint(index: 0, offset: CHUNK_SIZE))
        XCTAssertEqual(seqOf(announce), 0, "plaintext frames carry seq 0 and burn nothing")
        seqs += try s.dataFrames([(meta, body)],
                                 resume: ResumePoint(index: 0, offset: CHUNK_SIZE),
                                 maxFrameBytes: Double(CHUNK_SIZE + CHUNK_OVERHEAD)).map(seqOf)

        XCTAssertEqual(seqs, Array(0..<UInt32(seqs.count)), "the counter must be dense and monotonic")
        XCTAssertEqual(Set(seqs).count, seqs.count, "no nonce may be reused under the session key")
        XCTAssertEqual(s.nextSequence, UInt32(seqs.count))
    }

    /// A call that fails must fail BEFORE reserving a nonce, or a retry would
    /// leave permanent holes — and, worse, a failure after a partial reservation
    /// is where a rewind would be introduced to "fix" the hole.
    func testAFailedCallConsumesNoSequence() throws {
        let key = [UInt8](repeating: 0x33, count: 32)
        let s = RealtimeSender(sessionKey: key)
        _ = try s.batchFrame([FileMeta(name: "a", size: 10)])
        XCTAssertEqual(s.nextSequence, 1)

        let body = [UInt8](repeating: 7, count: 10)
        let meta = FileMeta(name: "a", size: 10)
        // Unaligned resume point: refused before a single protected frame.
        XCTAssertThrowsError(try s.dataFrames([(meta, body)], resume: ResumePoint(index: 0, offset: 3))) {
            XCTAssertEqual($0 as? RealtimeSenderError, .resumePointRejected)
        }
        // Out of range.
        XCTAssertThrowsError(try s.dataFrames([(meta, body)], resume: ResumePoint(index: 9, offset: 0))) {
            XCTAssertEqual($0 as? RealtimeSenderError, .resumePointRejected)
        }
        // A connection too small to send files at all.
        XCTAssertThrowsError(try s.dataFrames([(meta, body)], maxFrameBytes: 512)) {
            XCTAssertEqual($0 as? RealtimeSenderError, .frameSizeTooSmall)
        }
        XCTAssertThrowsError(try s.batchFrames([meta], maxFrameBytes: .nan)) {
            XCTAssertEqual($0 as? RealtimeSenderError, .frameSizeTooSmall)
        }
        XCTAssertEqual(s.nextSequence, 1, "a refused call must not have burned a nonce")
    }

    /// The counter is 32 bits on the wire. Wrapping it would reuse a nonce under
    /// a key that is still live, and trapping would take the process down — so it
    /// fails closed, and the last usable value is genuinely used.
    func testSequenceFailsClosedAtTheWrapBoundaryInsteadOfWrappingOrTrapping() throws {
        let key = [UInt8](repeating: 0x34, count: 32)
        let s = RealtimeSender(sessionKey: key, startingSequence: UInt32.max - 1)
        XCTAssertEqual(seqOf(try s.nextChunkFrame([1])), UInt32.max - 1)
        XCTAssertEqual(seqOf(try s.nextChunkFrame([2])), UInt32.max)
        for _ in 0..<3 {
            XCTAssertThrowsError(try s.nextChunkFrame([3])) {
                XCTAssertEqual($0 as? RealtimeSenderError, .sequenceExhausted)
            }
        }
        XCTAssertThrowsError(try s.nextDoneFrame(hash: zeroChain)) {
            XCTAssertEqual($0 as? RealtimeSenderError, .sequenceExhausted)
        }
        XCTAssertThrowsError(try s.resumeStartFrame(ResumePoint(index: 0, offset: 0))) {
            XCTAssertEqual($0 as? RealtimeSenderError, .sequenceExhausted)
        }
        XCTAssertEqual(s.nextSequence, UInt32.max, "it must not have wrapped to 0")
    }

    /// A multi-frame call that runs out mid-stream stops; it must not rewind, and
    /// the frames it did emit keep the nonces they were sealed under.
    func testExhaustionMidStreamDoesNotRewind() throws {
        let key = [UInt8](repeating: 0x35, count: 32)
        let s = RealtimeSender(sessionKey: key, startingSequence: UInt32.max - 1)
        let body = [UInt8](repeating: 9, count: CHUNK_SIZE * 3)
        XCTAssertThrowsError(try s.dataFrames([(FileMeta(name: "a", size: body.count), body)])) {
            XCTAssertEqual($0 as? RealtimeSenderError, .sequenceExhausted)
        }
        XCTAssertEqual(s.nextSequence, UInt32.max)
    }

    // ── the receiver's resume contract ──────────────────────────────────────

    /// RESUME_START is plaintext: a signalling relay can inject one. Surfacing
    /// the announcement is all the receiver may do with it — the owner compares
    /// it against its OWN durable checkpoint before anything moves.
    func testResumeAnnouncementAloneMutatesNothing() throws {
        let key = [UInt8](repeating: 0x36, count: 32)
        let s = RealtimeSender(sessionKey: key)
        let r = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(CHUNK_SIZE * 2, seed: 72)
        let meta = FileMeta(name: "a.bin", size: body.count)
        _ = try r.feed(try s.batchFrame([meta]))
        _ = try r.feed(try s.nextChunkFrame(Array(body[0..<CHUNK_SIZE])))
        let chain = r.snapshotChain()

        // An injected announcement claiming a wildly advanced sequence.
        let injected = realtimeFrame(kind: RealtimeKind.resumeStart, seq: 0,
                                     payload: Array(#"{"index":0,"offset":196608,"seq":900}"#.utf8))
        XCTAssertEqual(try r.feed(injected), .resume(index: 0, offset: CHUNK_SIZE, seq: 900))
        XCTAssertEqual(r.snapshotChain(), chain, "the chain must not have moved")
        // The nonce counter did not move either: the next in-order frame is still
        // the one the honest sender is about to send.
        _ = try r.feed(try s.nextChunkFrame(Array(body[CHUNK_SIZE...])))
    }

    func testResumeAtRefusesABackwardReceiveSequence() throws {
        let key = [UInt8](repeating: 0x37, count: 32)
        let s = RealtimeSender(sessionKey: key)
        let r = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(CHUNK_SIZE, seed: 73)
        let meta = FileMeta(name: "a.bin", size: CHUNK_SIZE * 2)
        _ = try r.feed(try s.batchFrame([meta]))            // seq 0
        _ = try r.feed(try s.nextChunkFrame(body))          // seq 1
        let chain = r.snapshotChain()
        let point = ResumePoint(index: 0, offset: CHUNK_SIZE)

        // Moving the receive counter backwards would make an old ciphertext valid
        // again under the same key and sequence number.
        for backwards in [UInt32(0), 1] {
            XCTAssertThrowsError(try r.resumeAt(point, chain: chain, seq: backwards)) {
                XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
            }
        }
        XCTAssertNoThrow(try r.resumeAt(point, chain: chain, seq: 2))   // standing still is allowed
        XCTAssertNoThrow(try r.resumeAt(point, chain: chain, seq: 40))  // skipping burned frames is allowed
        XCTAssertThrowsError(try r.resumeAt(point, chain: chain, seq: 39)) {
            XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
        }
    }

    /// The receive counter has the same 32-bit ceiling as the sender's, and
    /// `UInt32.max` is a value a conforming sender genuinely emits — the sender
    /// hands out that last value and only then fails closed. A receiver that
    /// holds the counter in a `UInt32` traps on the increment that follows, so
    /// the peer decides when this process dies. Exhaustion has to be a state the
    /// counter can represent: everything after the last nonce is refused, and no
    /// resume may rewind back underneath it.
    func testReceiveSequenceSurvivesTheLastNonceThenFailsClosed() throws {
        let key = [UInt8](repeating: 0x3c, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        let meta = FileMeta(name: "a.bin", size: 8)
        _ = try r.feed(try RealtimeSender(sessionKey: key).batchFrame([meta]))   // seq 0

        // A long-lived link arrives near the ceiling the honest way: a resume
        // skips forward over everything the old transport burned.
        let start = ResumePoint(index: 0, offset: 0)
        try r.resumeAt(start, chain: zeroChain, seq: UInt32.max - 1)

        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunk, UInt32.max - 1, [1, 2, 3, 4], key)),
                       .chunk([1, 2, 3, 4]))
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunk, UInt32.max, [5, 6, 7, 8], key)),
                       .chunk([5, 6, 7, 8]),
                       "the last usable nonce is usable — the sender does emit it")

        // Nothing protected may be accepted afterwards, on any kind, at any seq:
        // every 32-bit value is now behind the counter.
        for kind in [RealtimeKind.chunk, RealtimeKind.chunkPart,
                     RealtimeKind.batchEnc, RealtimeKind.batchPart, RealtimeKind.doneEnc] {
            for seq in [UInt32.max, UInt32.max - 1, 0] {
                XCTAssertThrowsError(try r.feed(rawFrame(kind, seq, [1], key)), "kind \(kind) at seq \(seq)") {
                    XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
                }
            }
        }
        // …and a resume cannot pull the counter back under the exhausted point,
        // which is the only way an old ciphertext becomes valid again.
        for seq in [UInt32(0), UInt32.max - 1, UInt32.max] {
            XCTAssertThrowsError(try r.resumeAt(start, chain: zeroChain, seq: seq), "resume to \(seq)") {
                XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
            }
        }
    }

    func testResumeAtValidatesManifestRangeAlignmentAndChainLength() throws {
        let key = [UInt8](repeating: 0x38, count: 32)
        let s = RealtimeSender(sessionKey: key)
        let r = RealtimeReceiver(sessionKey: key)
        let metas = [FileMeta(name: "a", size: 2 * CHUNK_SIZE), FileMeta(name: "b", size: 100)]

        // No consented manifest yet: there is nothing to resume into.
        XCTAssertThrowsError(try r.resumeAt(ResumePoint(index: 0, offset: 0), chain: zeroChain, seq: 0)) {
            XCTAssertEqual($0 as? RealtimeError, .resumeRejected)
        }
        _ = try r.feed(try s.batchFrame(metas))

        for bad in [ResumePoint(index: 2, offset: 0),           // no such file
                    ResumePoint(index: 0, offset: 2 * CHUNK_SIZE + 1),  // past the end
                    ResumePoint(index: 0, offset: 5),           // off the chunk grid
                    ResumePoint(index: -1, offset: 0)] {
            XCTAssertThrowsError(try r.resumeAt(bad, chain: zeroChain, seq: 1), "\(bad)") {
                XCTAssertEqual($0 as? RealtimeError, .resumeRejected)
            }
        }
        // A chain snapshot that is not a SHA-256 state cannot be a checkpoint.
        for wrong in [[], zeroChain + [0], Array(zeroChain[0..<31])] {
            XCTAssertThrowsError(try r.resumeAt(ResumePoint(index: 0, offset: 0), chain: wrong, seq: 1)) {
                XCTAssertEqual($0 as? RealtimeError, .resumeRejected)
            }
        }
        XCTAssertNoThrow(try r.resumeAt(ResumePoint(index: 1, offset: 100), chain: zeroChain, seq: 1),
                         "the exact end of a file is a legal checkpoint")
    }

    /// A resume restores where the receiver actually is, not just its nonce: the
    /// bytes already written to file `index` must not be counted again, or the
    /// length guard would reject the rest of the file.
    func testResumeAtRestoresFileIndexOffsetAndChain() throws {
        let key = [UInt8](repeating: 0x39, count: 32)
        let s = RealtimeSender(sessionKey: key)
        let r = RealtimeReceiver(sessionKey: key)
        let bodies = [WireVectors.content(CHUNK_SIZE * 2, seed: 74), WireVectors.content(50, seed: 75)]
        let metas = [FileMeta(name: "a", size: bodies[0].count), FileMeta(name: "b", size: bodies[1].count)]
        _ = try r.feed(try s.batchFrame(metas))
        _ = try r.feed(try s.nextChunkFrame(Array(bodies[0][0..<CHUNK_SIZE])))
        let chain = r.snapshotChain()

        // A fresh receiver, restored to that checkpoint, finishes the batch.
        let r2 = RealtimeReceiver(sessionKey: key)
        _ = try r2.feed(try RealtimeSender(sessionKey: key).batchFrame(metas))
        try r2.resumeAt(ResumePoint(index: 0, offset: CHUNK_SIZE), chain: chain, seq: 2)

        let s2 = RealtimeSender(sessionKey: key, startingSequence: 2)
        XCTAssertEqual(try r2.feed(try s2.nextChunkFrame(Array(bodies[0][CHUNK_SIZE...]))),
                       .chunk(Array(bodies[0][CHUNK_SIZE...])))
        var hash = zeroChain
        for o in stride(from: 0, to: bodies[0].count, by: CHUNK_SIZE) {
            hash = chainHash(hash, Array(bodies[0][o..<min(o + CHUNK_SIZE, bodies[0].count)]))
        }
        XCTAssertEqual(try r2.feed(try s2.nextDoneFrame(hash: hash)), .done(ok: true),
                       "the DONE hash covers the whole file, including the bytes sent before the drop")
        XCTAssertEqual(try r2.feed(try s2.nextChunkFrame(bodies[1])), .chunk(bodies[1]))
    }

    /// Pieces of a chunk the old transport cut in half are worthless: the sender
    /// restarts from the checkpoint, which is a whole-chunk boundary. Keeping
    /// them would prepend an old generation's bytes to the resumed chunk.
    func testResumeAtDiscardsOldGenerationPartialPieces() throws {
        let key = [UInt8](repeating: 0x3a, count: 32)
        let s = RealtimeSender(sessionKey: key)
        let r = RealtimeReceiver(sessionKey: key)
        let meta = FileMeta(name: "a", size: 3)
        _ = try r.feed(try s.batchFrame([meta]))
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunkPart, 1, [UInt8](repeating: 0xee, count: 1024), key)), .pending)

        // The piece authenticated, so it advanced the nonce counter; the resume
        // continues from there rather than rewinding over it.
        try r.resumeAt(ResumePoint(index: 0, offset: 0), chain: zeroChain, seq: 2)
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunk, 2, [1, 2, 3], key)), .chunk([1, 2, 3]),
                       "the orphaned piece must not have been prepended")
    }

    /// An ordered batch abort has authenticated every frame of the old batch. It
    /// ends the batch — and only the batch. The link's nonce sequence deliberately
    /// continues, because the keys have not changed.
    func testBatchAbortResetsIntegrityStateButNeverTheSequence() throws {
        let key = [UInt8](repeating: 0x3b, count: 32)
        let s = RealtimeSender(sessionKey: key)
        let r = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(CHUNK_SIZE, seed: 76)
        _ = try r.feed(try s.batchFrame([FileMeta(name: "a", size: CHUNK_SIZE * 2)]))
        _ = try r.feed(try s.nextChunkFrame(body))
        XCTAssertNotEqual(r.snapshotChain(), zeroChain)

        r.abortBatch()
        XCTAssertEqual(r.snapshotChain(), zeroChain)

        // The next batch continues the same counter — a frame at the old seq is
        // refused, and the frame at the current one is accepted.
        XCTAssertThrowsError(try r.feed(rawFrame(RealtimeKind.batchEnc, 0, Array(#"{"files":[]}"#.utf8), key))) {
            XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
        }
        let next = [FileMeta(name: "b", size: 4)]
        if case .batch(let m) = try r.feed(try s.batchFrame(next)) {
            XCTAssertEqual(m.map(\.name), ["b"])
        } else {
            XCTFail("a reusable lane must accept the next batch after an ordered abort")
        }
    }

    // ── the whole loop, against Web-generated bytes ─────────────────────────

    /// Two durable chunks, frames that were sent but never landed, a replacement
    /// transport that negotiates a SMALLER message size, and the rest of the file
    /// delivered byte for byte under nonces that only ever moved forward.
    func testDurableResumeAcrossAChangeOfMessageSizeMatchesTheWeb() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let d = v.dict("durableResume")
        let key = (d["keyHex"] as! String).hexBytes
        let metas = v.fileMetas("durableResume.manifest")
        let body = v.body("durableResume.body")
        let firstLimit = Double(d["firstMaxFrameBytes"] as! Int)
        let resumedLimit = Double(d["resumedMaxFrameBytes"] as! Int)

        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)

        // Attempt 1, on a desktop-class connection.
        let batch = try sender.batchFrames(metas, maxFrameBytes: firstLimit)
        XCTAssertEqual(batch.map(\.hexString), v.strArray("durableResume.batchFramesHex"))
        _ = try receiver.feed(batch[0])

        let attempt1 = try sender.dataFrames([(metas[0], body.bytes)], maxFrameBytes: firstLimit)
        let delivered = Array(attempt1.prefix(v.dict("durableResume.deliveredFrames")["count"] as! Int))
        let lost = Array(attempt1.dropFirst(delivered.count))
        v.frameStream("durableResume.deliveredFrames").assertMatches(delivered, "delivered")
        v.frameStream("durableResume.lostFrames").assertMatches(lost, "sent but never durable")

        var written = 0
        for f in delivered {
            guard case .chunk(let c) = try receiver.feed(f) else { return XCTFail("expected a chunk") }
            written += c.count
        }
        let checkpoint = v.point("durableResume.checkpoint")
        XCTAssertEqual(written, checkpoint.offset)
        let chain = receiver.snapshotChain()
        XCTAssertEqual(chain.hexString, v.str("durableResume.chainAtCheckpointHex"))

        // The transport dies. The receiver asks from its DURABLE point.
        let req = resumeReqFrame(index: checkpoint.index, offset: checkpoint.offset)
        XCTAssertEqual(req.hexString, v.str("durableResume.resumeReqHex"))

        // The sender validates the request against the batch it is actually sending.
        guard let asked = parseResumeReq(req) else { return XCTFail("the sender could not parse its own peer's request") }
        XCTAssertTrue(resumePointInRange(asked, metas.map(\.size)))
        XCTAssertTrue(resumePointAligned(asked, metas.map(\.size)))

        let announce = try sender.resumeStartFrame(asked)
        XCTAssertEqual(announce.hexString, v.str("durableResume.resumeStartHex"))
        guard case .resume(let i, let o, let seq) = try receiver.feed(announce) else {
            return XCTFail("expected a resume announcement")
        }
        XCTAssertEqual(seq, UInt32(d["resumeSeq"] as! Int))
        XCTAssertGreaterThan(seq, lost.map(seqOf).max()!, "the resumed stream must start past every burned nonce")

        // Only now — the owner has compared the announcement with its own
        // durable checkpoint — does receiver state move.
        XCTAssertEqual(ResumePoint(index: i, offset: o), checkpoint)
        try receiver.resumeAt(checkpoint, chain: chain, seq: seq)

        let resumed = try sender.dataFrames([(metas[0], body.bytes)], resume: asked, maxFrameBytes: resumedLimit)
        v.frameStream("durableResume.resumedFrames").assertMatches(resumed, "resumed")
        XCTAssertTrue(resumed.contains { $0[0] == RealtimeKind.chunkPart }, "the smaller connection must refragment")
        for f in resumed { XCTAssertLessThanOrEqual(Double(f.count), resumedLimit) }
        XCTAssertFalse(resumed.contains { $0[0] == RealtimeKind.batchEnc || $0[0] == RealtimeKind.batchPart },
                       "consent was given once; a resume must not re-send the manifest")

        var tail: [UInt8] = []
        var done: Bool?
        for f in resumed {
            switch try receiver.feed(f) {
            case .pending: break
            case .chunk(let c): tail += c
            case .done(let ok): done = ok
            default: XCTFail("unexpected event in a resumed stream")
            }
        }
        XCTAssertEqual(tail, Array(body.bytes[checkpoint.offset...]), "no skipped and no duplicated bytes")
        XCTAssertEqual(done, true, "the chain hash survived the change of message size")

        // Every nonce this transfer ever used, once, in order.
        let all = (batch + attempt1 + resumed).map(seqOf)
        XCTAssertEqual(all, Array(0..<UInt32(all.count)))
        XCTAssertEqual(Set(all).count, all.count)
    }

    /// Multi-file checkpoints: the exact end of a file, a later file with nothing
    /// of it written, and a mid-file point on the grid.
    func testMultiFileResumePointsMatchTheWeb() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let m = v.dict("multiFileResume")
        let key = (m["keyHex"] as! String).hexBytes
        let metas = v.fileMetas("multiFileResume.manifest")
        let bodies = v.bodies("multiFileResume.bodies")
        let limit = Double(m["maxFrameBytes"] as! Int)

        for c in v.objects("multiFileResume.cases") {
            let point = v.pointFrom(c["point"] as! [String: Any])
            let startSeq = UInt32(c["seqAtResume"] as! Int)
            let sender = RealtimeSender(sessionKey: key, startingSequence: startSeq)

            XCTAssertEqual((try sender.resumeStartFrame(point)).hexString, c["resumeStartHex"] as! String)
            XCTAssertEqual(resumeReqFrame(index: point.index, offset: point.offset).hexString,
                           c["resumeReqHex"] as! String)

            let frames = try sender.dataFrames(zip(metas, bodies.map(\.bytes)).map { ($0, $1) },
                                               resume: point, maxFrameBytes: limit)
            v.frameStreamFrom(c["frames"] as! [String: Any])
                .assertMatches(frames, "multi-file resume at \(point)")
            XCTAssertFalse(frames.contains { $0[0] == RealtimeKind.batchEnc || $0[0] == RealtimeKind.batchPart })

            // A point at the exact end of a file still emits that file's DONE.
            let dones = frames.filter { $0[0] == RealtimeKind.doneEnc }.count
            XCTAssertEqual(dones, metas.count - point.index,
                           "every file from the checkpoint onward, inclusive, must be closed out")

            // Receive it against a receiver restored to the same point.
            let r = RealtimeReceiver(sessionKey: key)
            _ = try r.feed(try RealtimeSender(sessionKey: key).batchFrame(metas))
            var chain = [UInt8](repeating: 0, count: 32)
            for o in stride(from: 0, to: point.offset, by: CHUNK_SIZE) {
                chain = chainHash(chain, Array(bodies[point.index].bytes[o..<min(o + CHUNK_SIZE, point.offset)]))
            }
            try r.resumeAt(point, chain: chain, seq: startSeq)

            var got: [[UInt8]] = metas.map { _ in [] }
            var index = point.index
            var oks: [Bool] = []
            for f in frames {
                switch try r.feed(f) {
                case .pending: break
                case .chunk(let c): got[index] += c
                case .done(let ok): oks.append(ok); index += 1
                default: XCTFail("unexpected event")
                }
            }
            XCTAssertEqual(oks, [Bool](repeating: true, count: metas.count - point.index))
            XCTAssertEqual(got[point.index], Array(bodies[point.index].bytes[point.offset...]))
            for later in (point.index + 1)..<metas.count {
                XCTAssertEqual(got[later], bodies[later].bytes)
            }
        }
    }
}

func seqOf(_ f: [UInt8]) -> UInt32 {
    (UInt32(f[1]) << 24) | (UInt32(f[2]) << 16) | (UInt32(f[3]) << 8) | UInt32(f[4])
}
