import XCTest
@testable import RelayiumKit

final class ChunkEncryptorTests: XCTestCase {
    private func drain(_ e: ChunkEncryptor) throws -> [UInt8] {
        var out: [UInt8] = []
        while let f = try e.next() { out += f }
        return out
    }

    /// The whole point: streaming must produce the identical byte stream the
    /// batch encoder produces, or native uploads become unreadable by web.
    func testMatchesEncryptChunksByteForByte() throws {
        let key = [UInt8](repeating: 7, count: 32)
        let a = [UInt8](repeating: 0xAB, count: STORE_CHUNK_SIZE * 2 + 13)
        let b = [UInt8](repeating: 0xCD, count: 5)
        let batch = encryptChunks(key: key, files: [a, b])
        let streamed = try drain(ChunkEncryptor(key: key, sources: [
            DataSource(name: "a", bytes: a), DataSource(name: "b", bytes: b),
        ]))
        XCTAssertEqual(streamed, batch)
    }

    /// A zero-length file yields no frames — matches encryptChunks, whose
    /// `off < count` loop never runs. Getting this wrong desynchronises seq.
    func testEmptyFileContributesNoFrames() throws {
        let key = [UInt8](repeating: 1, count: 32)
        let batch = encryptChunks(key: key, files: [[], [9, 9, 9]])
        let streamed = try drain(ChunkEncryptor(key: key, sources: [
            DataSource(name: "empty", bytes: []), DataSource(name: "x", bytes: [9, 9, 9]),
        ]))
        XCTAssertEqual(streamed, batch)
    }

    /// No frame may exceed one chunk of plaintext plus overhead — this is the
    /// property the uploader's buffer sizing depends on.
    func testEveryFrameFitsOneChunkPlusOverhead() throws {
        let key = [UInt8](repeating: 3, count: 32)
        let e = ChunkEncryptor(key: key, sources: [
            DataSource(name: "big", bytes: [UInt8](repeating: 0x11, count: STORE_CHUNK_SIZE * 3 + 1)),
        ])
        while let f = try e.next() {
            XCTAssertLessThanOrEqual(f.count, STORE_CHUNK_SIZE + FRAME_OVERHEAD + 16)
        }
    }

    func testDrainsToNilAndStaysNil() throws {
        let e = ChunkEncryptor(key: [UInt8](repeating: 2, count: 32),
                               sources: [DataSource(name: "s", bytes: [1, 2, 3])])
        XCTAssertNotNil(try e.next())
        XCTAssertNil(try e.next())
        XCTAssertNil(try e.next())
    }

    /// FileURLSource is what the app actually uses; DataSource is the test
    /// stand-in. If they disagree the tests above prove nothing about the app.
    func testFileSourceMatchesDataSource() throws {
        let key = [UInt8](repeating: 5, count: 32)
        let bytes = [UInt8](repeating: 0x3C, count: STORE_CHUNK_SIZE + 1234)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("chunkenc-\(UUID().uuidString).bin")
        try Data(bytes).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let fromData = try drain(ChunkEncryptor(key: key, sources: [DataSource(name: "f", bytes: bytes)]))
        let fromFile = try drain(ChunkEncryptor(key: key, sources: [try FileURLSource(url: url)]))
        XCTAssertEqual(fromFile, fromData)
    }
}
