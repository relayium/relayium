import XCTest
@testable import RelayiumKit

final class RealtimeFrameProducerTests: XCTestCase {
    private func drain(_ p: RealtimeFrameProducer) throws -> [UInt8] {
        var out: [UInt8] = []
        while let f = try p.next() { out += f }
        return out
    }

    /// The load-bearing test: streaming must emit exactly what dataFrames emits.
    /// A stream that differs by a byte is a transfer the web cannot decrypt, and
    /// the golden vectors only cover single-chunk files — this covers the rest.
    func testMatchesDataFramesForMultiChunkFiles() throws {
        let key = [UInt8](repeating: 9, count: 32)
        let a = [UInt8](repeating: 0x41, count: CHUNK_SIZE * 2 + 77)
        let b = [UInt8](repeating: 0x42, count: 13)
        let metaA = FileMeta(name: "a.bin", size: a.count)
        let metaB = FileMeta(name: "b.bin", size: b.count)

        let batch = RealtimeSender(sessionKey: key)
        _ = try batch.batchFrame([metaA, metaB])           // consumes seq 0
        var expected: [UInt8] = []
        for f in batch.dataFrames([(metaA, a), (metaB, b)]) { expected += f }

        let streamed = RealtimeSender(sessionKey: key)
        _ = try streamed.batchFrame([metaA, metaB])        // same seq 0
        let p = RealtimeFrameProducer(sender: streamed, sources: [
            DataSource(name: "a.bin", bytes: a), DataSource(name: "b.bin", bytes: b),
        ])
        XCTAssertEqual(try drain(p), expected)
    }

    /// An empty file still gets its DONE frame — it is in the manifest, and a
    /// receiver counting DONEs against the manifest would stall without it.
    func testEmptyFileStillProducesADoneFrame() throws {
        let key = [UInt8](repeating: 3, count: 32)
        let meta = FileMeta(name: "empty", size: 0)

        let batch = RealtimeSender(sessionKey: key)
        _ = try batch.batchFrame([meta])
        var expected: [UInt8] = []
        for f in batch.dataFrames([(meta, [])]) { expected += f }

        let streamed = RealtimeSender(sessionKey: key)
        _ = try streamed.batchFrame([meta])
        let p = RealtimeFrameProducer(sender: streamed,
                                      sources: [DataSource(name: "empty", bytes: [])])
        XCTAssertEqual(try drain(p), expected)
    }

    /// Memory must not track the transfer. Nothing the producer holds may exceed
    /// one chunk plus the frame it is building.
    func testPeakHeldBytesIsBoundedByOneChunk() throws {
        let key = [UInt8](repeating: 5, count: 32)
        let big = [UInt8](repeating: 0x7E, count: CHUNK_SIZE * 20)
        let s = RealtimeSender(sessionKey: key)
        _ = try s.batchFrame([FileMeta(name: "big", size: big.count)])
        let p = RealtimeFrameProducer(sender: s, sources: [DataSource(name: "big", bytes: big)])
        while let f = try p.next() {
            XCTAssertLessThanOrEqual(f.count, CHUNK_SIZE + 4096,
                                     "a frame larger than one chunk means it buffered")
        }
        XCTAssertLessThanOrEqual(p.peakHeldBytes, (CHUNK_SIZE + 4096) * 2)
    }

    /// `peakHeldBytes` only sees what Swift retains. Reading a real file goes
    /// through `FileHandle`, which hands back autoreleased objects — those live
    /// until the *enclosing* pool drains, and in a live send that is not until
    /// the whole transfer has gone out. So the producer can hold one chunk and
    /// the process can still grow by the size of the transfer.
    ///
    /// Measured on phys_footprint, never RSS (G2's false alarm).
    func testStreamingARealFileDoesNotGrowWithTheTransfer() throws {
        let size = 64 << 20
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("producer-fp-\(UUID().uuidString).bin")
        try Data(count: size).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let key = [UInt8](repeating: 3, count: 32)
        let s = RealtimeSender(sessionKey: key)
        _ = try s.batchFrame([FileMeta(name: "big.bin", size: size)])
        let p = RealtimeFrameProducer(sender: s, sources: [try FileURLSource(url: url)],
                                      declaredSizes: [size])

        let before = physFootprint()
        var peak = before
        while try p.next() != nil { peak = max(peak, physFootprint()) }

        let grew = peak - before
        XCTAssertLessThan(grew, 16 << 20,
                          "footprint grew \(grew >> 20) MB streaming \(size >> 20) MB — "
                          + "the reads are accumulating instead of draining")
    }

    /// A file read short of its declared size must fail rather than send a DONE
    /// whose hash covers fewer bytes than the manifest promised.
    func testShortReadIsRejected() throws {
        let key = [UInt8](repeating: 1, count: 32)
        let s = RealtimeSender(sessionKey: key)
        _ = try s.batchFrame([FileMeta(name: "x", size: 100)])
        let p = RealtimeFrameProducer(sender: s,
                                      sources: [DataSource(name: "x", bytes: [1, 2, 3])],
                                      declaredSizes: [100])
        XCTAssertThrowsError(try drain(p)) { err in
            XCTAssertEqual(err as? RealtimeSenderError, .sourceShorterThanDeclared(name: "x"))
        }
    }

    func testDrainsToNilAndStaysNil() throws {
        let s = RealtimeSender(sessionKey: [UInt8](repeating: 2, count: 32))
        let p = RealtimeFrameProducer(sender: s, sources: [DataSource(name: "s", bytes: [1])])
        XCTAssertNotNil(try p.next())      // CHUNK
        XCTAssertNotNil(try p.next())      // DONE
        XCTAssertNil(try p.next())
        XCTAssertNil(try p.next())
    }

    /// Three files in one batch: the chain hash must reset per file while seq
    /// keeps climbing. Mixing those up is silent — the bytes arrive and the
    /// DONE check fails at the very end.
    func testChainHashResetsPerFileWhileSeqContinues() throws {
        let key = [UInt8](repeating: 7, count: 32)
        let datas = [[UInt8](repeating: 1, count: 10),
                     [UInt8](repeating: 2, count: CHUNK_SIZE + 1),
                     [UInt8](repeating: 3, count: 5)]
        let metas = datas.enumerated().map { FileMeta(name: "f\($0.offset)", size: $0.element.count) }

        let batch = RealtimeSender(sessionKey: key)
        _ = try batch.batchFrame(metas)
        var expected: [UInt8] = []
        for f in batch.dataFrames(zip(metas, datas).map { ($0, $1) }) { expected += f }

        let streamed = RealtimeSender(sessionKey: key)
        _ = try streamed.batchFrame(metas)
        let p = RealtimeFrameProducer(sender: streamed, sources: zip(metas, datas).map {
            DataSource(name: $0.name, bytes: $1)
        })
        XCTAssertEqual(try drain(p), expected)
    }
}
