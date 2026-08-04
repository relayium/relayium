import XCTest
@testable import RelayiumKit

/// Transport fragmentation: the logical CHUNK_SIZE unit the hash chain and the
/// checkpoint grid are defined in, carried over a connection that cannot take a
/// whole one in a single message.
///
/// Every wire assertion here is pinned to bytes the WEB generated
/// (`web/scripts/gen-realtime-wire-vectors.mjs`, itself a transcription of
/// `web/src/lib/transfer.ts`). A Swift dialect that is self-consistent but
/// disagrees with the browser is exactly the failure this file exists to stop.
final class RealtimeFragmentationTests: XCTestCase {

    // ── kinds and limits ────────────────────────────────────────────────────

    /// The kind bytes are the wire. A build that predates fragmentation parsed
    /// 1...9 and threw on everything else, so keeping PART outside that set is
    /// what makes a mixed-version pair fail loudly instead of writing a fragment
    /// as though it were a whole chunk.
    func testPartKindsMatchTheWebAndAreOutsideTheOldSet() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let kinds = v.dict("kinds")
        XCTAssertEqual(Int(RealtimeKind.chunkPart), kinds["chunkPart"] as! Int)
        XCTAssertEqual(Int(RealtimeKind.batchPart), kinds["batchPart"] as! Int)
        XCTAssertEqual(RealtimeKind.chunkPart, 10)
        XCTAssertEqual(RealtimeKind.batchPart, 11)
        let old: [UInt8] = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        XCTAssertFalse(old.contains(RealtimeKind.chunkPart))
        XCTAssertFalse(old.contains(RealtimeKind.batchPart))
    }

    func testLimitsMatchTheWeb() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let limits = v.dict("limits")
        XCTAssertEqual(CHUNK_SIZE, limits["chunkSize"] as! Int)
        XCTAssertEqual(CHUNK_OVERHEAD, limits["chunkOverhead"] as! Int)
        XCTAssertEqual(MIN_PIECE_BYTES, limits["minPieceBytes"] as! Int)
    }

    /// `isChunkFrame` is what a lane counts progress and flow-control credit
    /// with, so a fragmented chunk must be accounted exactly like an
    /// unfragmented one rather than only its final piece.
    func testIsChunkFrameCoversBothPieceKinds() {
        XCTAssertTrue(isChunkFrame([RealtimeKind.chunk, 0, 0, 0, 0]))
        XCTAssertTrue(isChunkFrame([RealtimeKind.chunkPart, 0, 0, 0, 0]))
        XCTAssertFalse(isChunkFrame([RealtimeKind.batchEnc, 0, 0, 0, 0]))
        XCTAssertFalse(isChunkFrame([RealtimeKind.batchPart, 0, 0, 0, 0]))
        XCTAssertFalse(isChunkFrame([RealtimeKind.doneEnc, 0, 0, 0, 0]))
        XCTAssertFalse(isChunkFrame([]))
    }

    // ── piecePlainBytes ─────────────────────────────────────────────────────

    /// The cap is the point: CHUNK_SIZE is the fixed unit the hash chain and the
    /// checkpoint grid are expressed in, so a bigger allowance buys nothing and
    /// "no limit" must land on exactly today's unfragmented behaviour.
    func testPiecePlainBytesCapsAtOneLogicalChunk() throws {
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: CHUNK_SIZE + CHUNK_OVERHEAD), CHUNK_SIZE)
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: 10 * CHUNK_SIZE), CHUNK_SIZE)
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: Double.infinity), CHUNK_SIZE)
    }

    func testPiecePlainBytesSubtractsExactlyTheFrameOverhead() throws {
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: 65_536), 65_536 - CHUNK_OVERHEAD)
        // One byte short of a whole chunk must fragment, not silently round up.
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: CHUNK_SIZE + CHUNK_OVERHEAD - 1),
                       CHUNK_SIZE - 1)
        // A fractional allowance floors, exactly like Math.floor.
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: 65_536.9), 65_536 - CHUNK_OVERHEAD)
    }

    /// The MIN_PIECE_BYTES boundary, from both sides. Below it the per-message
    /// overhead and the number of round trips dominate, and no real SCTP
    /// implementation negotiates anything that small — a named error beats a
    /// transfer that crawls.
    func testPiecePlainBytesRefusesAnUnusablySmallConnection() throws {
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: MIN_PIECE_BYTES + CHUNK_OVERHEAD),
                       MIN_PIECE_BYTES)
        for tooSmall in [MIN_PIECE_BYTES + CHUNK_OVERHEAD - 1, 512, 21, 1, 0, -1] {
            XCTAssertThrowsError(try piecePlainBytes(maxFrameBytes: tooSmall), "\(tooSmall)") {
                XCTAssertEqual($0 as? RealtimeSenderError, .frameSizeTooSmall)
            }
        }
    }

    /// A non-finite or absurd allowance must produce a refusal or the cap — never
    /// an arithmetic trap. `Int(1e308)` and `Int(Double.nan)` both crash the
    /// process, so the clamp has to happen in floating point before any
    /// conversion.
    func testPiecePlainBytesHandlesNonFiniteAndOverflowingAllowances() throws {
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: 1e308), CHUNK_SIZE)
        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: Double.greatestFiniteMagnitude), CHUNK_SIZE)
        for bad in [Double.nan, -Double.infinity, -1e308, Double(Int.min)] {
            XCTAssertThrowsError(try piecePlainBytes(maxFrameBytes: bad), "\(bad)") {
                XCTAssertEqual($0 as? RealtimeSenderError, .frameSizeTooSmall)
            }
        }
    }

    // ── the sender's wire, against Web-generated bytes ──────────────────────

    /// The whole point of the default: on a connection that can carry a whole
    /// logical chunk, not one byte of the existing wire changes.
    func testDefaultFrameSizeEmitsTheExistingUnfragmentedWire() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let files = v.realtimeManifestFiles()
        let datas = v.realtimeFileDatas()

        let s = RealtimeSender(sessionKey: v.hex("sessionKeyHex"))
        var out = try s.batchFrame(files)
        for f in try s.dataFrames(zip(files, datas).map { ($0, $1) }) { out += f }
        XCTAssertEqual(out, v.hex("frameStreamHex"))

        // …and the fragmenting entry points, given the default allowance, agree.
        let t = RealtimeSender(sessionKey: v.hex("sessionKeyHex"))
        var out2 = try t.batchFrames(files).flatMap { $0 }
        out2 += try t.dataFrames(zip(files, datas).map { ($0, $1) }).flatMap { $0 }
        XCTAssertEqual(out2, v.hex("frameStreamHex"))
        XCTAssertEqual(try t.batchFrames(files).count, 1)
    }

    func testSenderFragmentsExactlyLikeTheWebOverA64KiBPeer() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let f = v.dict("fragmentation")
        let key = (f["keyHex"] as! String).hexBytes
        let limit = Double(f["maxFrameBytes"] as! Int)
        let metas = v.fileMetas("fragmentation.manifest")
        let bodies = v.bodies("fragmentation.bodies")

        XCTAssertEqual(try piecePlainBytes(maxFrameBytes: limit), f["pieceBytes"] as! Int)

        let s = RealtimeSender(sessionKey: key)
        let batch = try s.batchFrames(metas, maxFrameBytes: limit)
        XCTAssertEqual(batch.map(\.hexString), v.strArray("fragmentation.batchFramesHex"))

        let data = try s.dataFrames(zip(metas, bodies.map(\.bytes)).map { ($0, $1) },
                                    maxFrameBytes: limit)
        v.frameStream("fragmentation.dataFrames").assertMatches(data, "fragmented data frames")

        // It really did fragment, and no frame exceeds what the peer can take.
        XCTAssertTrue(data.contains { $0[0] == RealtimeKind.chunkPart })
        for frame in batch + data {
            XCTAssertLessThanOrEqual(Double(frame.count), limit)
        }
    }

    /// A manifest too big for one message is fragmented too — the second frame
    /// an unfragmented build could hand a 64 KiB peer and lose. The protocol
    /// ceiling still applies whatever the connection allows.
    func testManifestFragmentsAndStillHonoursTheProtocolCeiling() throws {
        let key = [UInt8](repeating: 0x21, count: 32)
        let files = (0..<900).map {
            FileMeta(name: "image-\($0).jpg", size: 1000 + $0,
                     path: "holiday/2026/summer/week-\($0 % 7)/camera-roll/batch-\($0)/image-\($0).jpg")
        }
        let s = RealtimeSender(sessionKey: key)
        let frames = try s.batchFrames(files, maxFrameBytes: 65_536)
        XCTAssertGreaterThan(frames.count, 1)
        for f in frames { XCTAssertLessThanOrEqual(f.count, 65_536) }
        XCTAssertEqual(frames.last![0], RealtimeKind.batchEnc)
        XCTAssertEqual(frames.dropLast().map { $0[0] },
                       [UInt8](repeating: RealtimeKind.batchPart, count: frames.count - 1))

        let r = RealtimeReceiver(sessionKey: key)
        var manifest: [FileMeta]?
        for f in frames {
            if case .batch(let m) = try r.feed(f) { manifest = m }
        }
        XCTAssertEqual(manifest?.count, 900)
        XCTAssertEqual(manifest?[899].path, files[899].path)

        // Over the protocol maximum it is refused however large the connection is.
        // Kept under MAX_FILES so this exercises MANIFEST_MAX_BYTES and not the
        // file-count guard — with long relative paths it is the byte ceiling, not
        // the count, that a real folder send hits first.
        let many = (0..<900).map {
            FileMeta(name: "\(String(repeating: "n", count: 150))-\($0).bin", size: $0,
                     path: "\(String(repeating: "d", count: 150))/\($0)")
        }
        XCTAssertThrowsError(try RealtimeSender(sessionKey: key).batchFrames(many, maxFrameBytes: .infinity)) {
            XCTAssertEqual($0 as? RealtimeSenderError, .manifestTooLarge)
        }
    }

    /// `MANIFEST_MAX_BYTES` (200 KiB) is LARGER than `CHUNK_SIZE` (192 KiB), so
    /// there is a band of perfectly legal manifests that do not fit one whole
    /// logical chunk. `batchFrame` has always carried them as one frame and must
    /// go on doing so; only `batchFrames`, which is told the connection's real
    /// ceiling, may cut them up.
    func testALegalManifestLargerThanOneLogicalChunkIsStillOneBatchFrame() throws {
        let key = [UInt8](repeating: 0x2d, count: 32)
        // Grow a folder manifest until it sits between the two limits.
        var files: [FileMeta] = []
        var i = 0
        while try realtimeManifestSealedSize(files) <= CHUNK_SIZE {
            // Long enough that ~600 files clear CHUNK_SIZE — MAX_FILES is 1000,
            // and this must land on the manifest byte ceiling, not the count one.
            files.append(FileMeta(name: "photo-\(i).jpg", size: i,
                                  path: "trip/\(String(repeating: "s", count: 250))/photo-\(i).jpg"))
            i += 1
        }
        let sealed = try realtimeManifestSealedSize(files)
        XCTAssertGreaterThan(sealed, CHUNK_SIZE)
        XCTAssertLessThanOrEqual(sealed, MANIFEST_MAX_BYTES)

        let one = try RealtimeSender(sessionKey: key).batchFrame(files)
        XCTAssertEqual(one[0], RealtimeKind.batchEnc)
        XCTAssertGreaterThan(one.count, CHUNK_SIZE + CHUNK_OVERHEAD)

        // The fragmenting entry point, told the same default ceiling, cuts it up
        // instead — and the receiver reassembles either shape to the same files.
        let many = try RealtimeSender(sessionKey: key).batchFrames(files)
        XCTAssertGreaterThan(many.count, 1)
        for (frames, label) in [([one], "unfragmented"), (many, "fragmented")] {
            let r = RealtimeReceiver(sessionKey: key)
            var decoded: [FileMeta]?
            for f in frames { if case .batch(let m) = try r.feed(f) { decoded = m } }
            XCTAssertEqual(decoded?.count, files.count, label)
        }
    }

    /// An empty plaintext still yields exactly one final frame, and a plaintext
    /// that divides evenly yields no trailing empty one.
    func testPieceBoundariesEmitNoEmptyTrailingFrame() throws {
        let key = [UInt8](repeating: 0x22, count: 32)
        let pieceLimit = Double(64 * 1024 + CHUNK_OVERHEAD)   // 64 KiB of plaintext exactly
        let body = [UInt8](repeating: 0x5a, count: 64 * 1024 * 3)   // 3 pieces exactly
        let s = RealtimeSender(sessionKey: key)
        let frames = try s.dataFrames([(FileMeta(name: "a", size: body.count), body)],
                                      maxFrameBytes: pieceLimit)
        // 3 pieces (2 PART + 1 CHUNK) + DONE, with no 4th zero-length piece.
        XCTAssertEqual(frames.map { $0[0] },
                       [RealtimeKind.chunkPart, RealtimeKind.chunkPart, RealtimeKind.chunk, RealtimeKind.doneEnc])
        XCTAssertEqual(frames[2].count, 64 * 1024 + CHUNK_OVERHEAD)

        let e = RealtimeSender(sessionKey: key)
        let empty = try e.dataFrames([(FileMeta(name: "e", size: 0), [])], maxFrameBytes: pieceLimit)
        XCTAssertEqual(empty.map { $0[0] }, [RealtimeKind.doneEnc])   // no chunk at all
    }

    // ── the receiver ────────────────────────────────────────────────────────

    func testReceiverReassemblesTheWebFragmentedStream() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let f = v.dict("fragmentation")
        let key = (f["keyHex"] as! String).hexBytes
        let metas = v.fileMetas("fragmentation.manifest")
        let bodies = v.bodies("fragmentation.bodies")
        let limit = Double(f["maxFrameBytes"] as! Int)

        let s = RealtimeSender(sessionKey: key)
        let batch = try s.batchFrames(metas, maxFrameBytes: limit)
        let data = try s.dataFrames(zip(metas, bodies.map(\.bytes)).map { ($0, $1) }, maxFrameBytes: limit)
        v.frameStream("fragmentation.dataFrames").assertMatches(data, "fragmented data frames")

        let r = RealtimeReceiver(sessionKey: key)
        var chunkLengths: [Int] = []
        var received: [[UInt8]] = metas.map { _ in [] }
        var oks: [Bool] = []
        var pending = 0
        var fileIndex = 0
        for frame in batch + data {
            switch try r.feed(frame) {
            case .batch(let m): XCTAssertEqual(m.count, metas.count)
            case .pending: pending += 1
            case .chunk(let c):
                chunkLengths.append(c.count)
                received[fileIndex] += c
            case .done(let ok):
                oks.append(ok)
                fileIndex += 1
            case .resume: XCTFail("no resume frame in this stream")
            }
        }
        XCTAssertGreaterThan(pending, 0, "the stream must actually have carried PART frames")
        // Whole logical chunks, however many messages carried them.
        XCTAssertEqual(chunkLengths, f["logicalChunkLengths"] as! [Int])
        XCTAssertEqual(oks, [true, true, true])
        for (i, b) in bodies.enumerated() {
            XCTAssertEqual(received[i], b.bytes, "file \(i) did not reassemble byte for byte")
        }
    }

    /// A non-final piece emits no event. Anything else would make a lane count a
    /// fragment as a written chunk and checkpoint off the CHUNK_SIZE grid.
    func testNonFinalPieceReturnsPendingAndWritesNothing() throws {
        let key = [UInt8](repeating: 0x23, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        _ = try r.feed(RealtimeSender(sessionKey: key).batchFrame([FileMeta(name: "a", size: 8)]))
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunkPart, 1, [1, 2, 3, 4], key)), .pending)
        XCTAssertEqual(r.snapshotChain(), [UInt8](repeating: 0, count: 32),
                       "a partial piece must not enter the hash chain")
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunk, 2, [5, 6, 7, 8], key)),
                       .chunk([1, 2, 3, 4, 5, 6, 7, 8]))
    }

    // ── what a hostile peer can make the receiver do ────────────────────────

    /// One logical chunk is the bound, and it is a bound on the LOGICAL unit,
    /// not on the fragmentation: a peer that skips the PART kinds and sends one
    /// authenticated terminal frame is the cheapest way to hand a receiver an
    /// arbitrarily large plaintext to hash or JSON-parse before any consent.
    func testRefusesToBufferMoreThanOneLogicalChunkOfFragments() throws {
        let key = [UInt8](repeating: 0x24, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        let piece = [UInt8](repeating: 0, count: 64 * 1024)
        for seq in 0..<3 { XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunkPart, UInt32(seq), piece, key)), .pending) }
        XCTAssertThrowsError(try r.feed(rawFrame(RealtimeKind.chunkPart, 3, piece, key))) {
            XCTAssertEqual($0 as? RealtimeError, .oversizedFrame)
        }
    }

    /// The byte bound alone is not a bound. Zero-length pieces never advance it,
    /// so a peer could hold the receiver in `pending` forever, one array slot at
    /// a time, on frames that carry nothing.
    func testRefusesAnUnboundedNumberOfEmptyFragments() throws {
        let key = [UInt8](repeating: 0x2b, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        for seq in 0..<MAX_PIECES_PER_LOGICAL_UNIT {
            XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunkPart, UInt32(seq), [], key)), .pending)
        }
        XCTAssertThrowsError(try r.feed(rawFrame(RealtimeKind.chunkPart, UInt32(MAX_PIECES_PER_LOGICAL_UNIT), [], key))) {
            XCTAssertEqual($0 as? RealtimeError, .oversizedFrame)
        }
    }

    /// …and the bound must not cost any conforming sender anything: the most
    /// pieces one is able to emit is bounded by MIN_PIECE_BYTES.
    func testTheHardestLegitimateFragmentationStaysInsideThePieceBound() throws {
        let key = [UInt8](repeating: 0x2c, count: 32)
        let smallest = Double(MIN_PIECE_BYTES + CHUNK_OVERHEAD)   // the smallest usable connection
        let body = [UInt8](repeating: 0x33, count: CHUNK_SIZE)
        let frames = try RealtimeSender(sessionKey: key)
            .dataFrames([(FileMeta(name: "a", size: body.count), body)], maxFrameBytes: smallest)
        let pieces = frames.filter { isChunkFrame($0) }.count
        XCTAssertLessThanOrEqual(pieces, MAX_PIECES_PER_LOGICAL_UNIT)

        let manifest = try RealtimeSender(sessionKey: key)
            .batchFrames((0..<900).map { FileMeta(name: "n-\($0)", size: $0, path: "d/\($0)") },
                         maxFrameBytes: smallest)
        XCTAssertLessThanOrEqual(manifest.count, MAX_PIECES_PER_LOGICAL_UNIT)

        // …and it really is the round trip, not just the count.
        let r = RealtimeReceiver(sessionKey: key)
        var manifestFiles: [FileMeta]?
        for f in manifest { if case .batch(let m) = try r.feed(f) { manifestFiles = m } }
        XCTAssertEqual(manifestFiles?.count, 900)
    }

    func testRefusesOneUnfragmentedFrameLargerThanItsLogicalUnit() throws {
        let key = [UInt8](repeating: 0x25, count: 32)
        XCTAssertThrowsError(try RealtimeReceiver(sessionKey: key)
            .feed(rawFrame(RealtimeKind.chunk, 0, [UInt8](repeating: 0, count: CHUNK_SIZE + 1), key))) {
            XCTAssertEqual($0 as? RealtimeError, .oversizedFrame)
        }
        XCTAssertThrowsError(try RealtimeReceiver(sessionKey: key)
            .feed(rawFrame(RealtimeKind.batchEnc, 0, [UInt8](repeating: 0x20, count: MANIFEST_MAX_BYTES + 1), key))) {
            XCTAssertEqual($0 as? RealtimeError, .oversizedFrame)
        }
    }

    func testCountsBufferedFragmentsAndTheTerminalFrameAgainstOneLimit() throws {
        let key = [UInt8](repeating: 0x26, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunkPart, 0, [UInt8](repeating: 0, count: CHUNK_SIZE - 1), key)), .pending)
        XCTAssertThrowsError(try r.feed(rawFrame(RealtimeKind.chunk, 1, [0, 0], key))) {
            XCTAssertEqual($0 as? RealtimeError, .oversizedFrame)
        }
    }

    func testRefusesInterleavedPartKinds() throws {
        let key = [UInt8](repeating: 0x27, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        _ = try r.feed(rawFrame(RealtimeKind.chunkPart, 0, [UInt8](repeating: 1, count: 16), key))
        XCTAssertThrowsError(try r.feed(rawFrame(RealtimeKind.batchPart, 1, [UInt8](repeating: 2, count: 16), key))) {
            XCTAssertEqual($0 as? RealtimeError, .interleavedParts)
        }
        // …and the terminating frame of the wrong kind is refused too.
        let r2 = RealtimeReceiver(sessionKey: key)
        _ = try r2.feed(rawFrame(RealtimeKind.chunkPart, 0, [UInt8](repeating: 1, count: 16), key))
        XCTAssertThrowsError(try r2.feed(rawFrame(RealtimeKind.batchEnc, 1, Array(#"{"files":[]}"#.utf8), key))) {
            XCTAssertEqual($0 as? RealtimeError, .interleavedParts)
        }
    }

    /// Fragments are authenticated in the same nonce order as whole frames.
    func testPartsHoldTheSameNonceOrderAsWholeFrames() throws {
        let key = [UInt8](repeating: 0x28, count: 32)
        XCTAssertThrowsError(try RealtimeReceiver(sessionKey: key)
            .feed(rawFrame(RealtimeKind.chunkPart, 7, [1, 2, 3], key))) {
            XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
        }
        // A tampered part fails to open rather than being buffered.
        let r = RealtimeReceiver(sessionKey: key)
        var bad = rawFrame(RealtimeKind.chunkPart, 0, [1, 2, 3], key)
        bad[bad.count - 1] ^= 0x01
        XCTAssertThrowsError(try r.feed(bad)) { XCTAssertEqual($0 as? RealtimeError, .tamper) }
    }

    /// A file cannot end in the middle of a logical chunk. Leftover pieces mean
    /// the sender's framing and ours disagree — fail rather than hash a short
    /// chunk and report a mismatched file at the very end.
    func testDoneWithAPartialLogicalChunkIsRefused() throws {
        let key = [UInt8](repeating: 0x29, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        let s = RealtimeSender(sessionKey: key)
        _ = try r.feed(try s.batchFrame([FileMeta(name: "a", size: 8)]))
        _ = try r.feed(rawFrame(RealtimeKind.chunkPart, 1, [1, 2, 3, 4], key))
        XCTAssertThrowsError(try r.feed(rawFrame(RealtimeKind.doneEnc, 2, Array(#"{"sha256":"00"}"#.utf8), key))) {
            XCTAssertEqual($0 as? RealtimeError, .malformed)
        }
    }

    /// `partBytes` counts bytes, not pieces, so it cannot answer "is a piece
    /// buffered?". A zero-length PART is authenticated and accepted (the count
    /// cap, not the byte cap, is what bounds it), yet leaves the byte total at
    /// zero — so joining takes the "nothing buffered" shortcut and leaves
    /// `parts`/`partKind` behind. The next logical unit is then refused as
    /// interleaved: a live transfer killed by a frame that was legal.
    func testJoiningAfterZeroLengthPiecesClearsTheFragmentState() throws {
        let key = [UInt8](repeating: 0x2e, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        _ = try r.feed(try RealtimeSender(sessionKey: key).batchFrame([FileMeta(name: "a", size: 4)]))
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunkPart, 1, [], key)), .pending)
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunkPart, 2, [], key)), .pending)
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunk, 3, [1, 2, 3, 4], key)), .chunk([1, 2, 3, 4]))

        let sha = chainHash([UInt8](repeating: 0, count: 32), [1, 2, 3, 4]).hexString
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.doneEnc, 4, Array(#"{"sha256":"\#(sha)"}"#.utf8), key)),
                       .done(ok: true))

        // The batch is closed out, so a reusable lane goes on to the next one —
        // which must not inherit a CHUNK_PART kind from the one before it.
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.batchEnc, 5,
                                           Array(#"{"files":[{"name":"b","size":2}]}"#.utf8), key)),
                       .batch([FileMeta(name: "b", size: 2)]))
    }

    /// The same proxy on the DONE path. A file cannot end while a piece of a
    /// logical chunk is still buffered — including a zero-length one, which says
    /// the sender's framing and ours disagree just as loudly as a short piece
    /// does. Checking only the byte count closes the file out over it.
    func testDoneWithAZeroLengthPieceBufferedIsRefused() throws {
        let key = [UInt8](repeating: 0x2f, count: 32)
        let r = RealtimeReceiver(sessionKey: key)
        _ = try r.feed(try RealtimeSender(sessionKey: key).batchFrame([FileMeta(name: "a", size: 4)]))
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunk, 1, [1, 2, 3, 4], key)), .chunk([1, 2, 3, 4]))
        XCTAssertEqual(try r.feed(rawFrame(RealtimeKind.chunkPart, 2, [], key)), .pending)

        let sha = chainHash([UInt8](repeating: 0, count: 32), [1, 2, 3, 4]).hexString
        XCTAssertThrowsError(try r.feed(rawFrame(RealtimeKind.doneEnc, 3,
                                                 Array(#"{"sha256":"\#(sha)"}"#.utf8), key))) {
            XCTAssertEqual($0 as? RealtimeError, .malformed)
        }
    }

    /// Dropping the frame that terminates a logical chunk must fail the transfer
    /// rather than silently splicing the next chunk's pieces onto the orphans.
    func testALostTerminatingFrameFailsTheTransfer() throws {
        let key = [UInt8](repeating: 0x2a, count: 32)
        let body = WireVectors.content(CHUNK_SIZE + 100, seed: 65)
        let meta = FileMeta(name: "a.bin", size: body.count)
        let s = RealtimeSender(sessionKey: key)
        let batch = try s.batchFrame([meta])
        let frames = try s.dataFrames([(meta, body)], maxFrameBytes: 65_536)
        let firstTerminator = frames.firstIndex { $0[0] == RealtimeKind.chunk }!
        let doctored = frames.enumerated().filter { $0.offset != firstTerminator }.map(\.element)

        let r = RealtimeReceiver(sessionKey: key)
        _ = try r.feed(batch)
        XCTAssertThrowsError(try { for f in doctored { _ = try r.feed(f) } }())
    }
}

/// One hand-built frame, the way a peer that is not this code would send it.
func rawFrame(_ kind: UInt8, _ seq: UInt32, _ plain: [UInt8], _ key: [UInt8]) -> [UInt8] {
    realtimeFrame(kind: kind, seq: seq, payload: seal(key: key, seq: UInt64(seq), plaintext: plain))
}
