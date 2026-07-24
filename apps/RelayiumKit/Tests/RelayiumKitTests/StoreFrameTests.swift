import XCTest
@testable import RelayiumKit

final class StoreFrameTests: XCTestCase {
    func testConstants() {
        XCTAssertEqual(STORE_CHUNK_SIZE, 192 * 1024)
        XCTAssertEqual(FRAME_OVERHEAD, 20)
        XCTAssertEqual(MAX_FRAME_CT, 192 * 1024 + 16 + 256)
    }
    func testEncryptChunksMatchesVectorStream() throws {
        let v = try Vectors.load("store-wire-vectors")
        let files = v.fileDatas()   // [[UInt8]] from files[].dataHex
        XCTAssertEqual(encryptChunks(key: v.hex("keyHex"), files: files), v.hex("streamHex"))
        XCTAssertEqual(cipherSizeFor(files.map(\.count)), v.int("cipherSize"))
    }
    func testDecryptorReassemblesWholeStream() throws {
        let v = try Vectors.load("store-wire-vectors")
        let d = StoreDecryptor(key: v.hex("keyHex"))
        let out = try d.push(v.hex("streamHex"))
        try d.end(expectedBytes: v.int("plaintextBytes"))
        XCTAssertEqual(out, v.fileDatas())
        XCTAssertEqual(d.decryptedBytes, v.int("plaintextBytes"))
    }
    func testDecryptorReassemblesAcrossByteBoundaries() throws {
        let v = try Vectors.load("store-wire-vectors")
        let stream = v.hex("streamHex")
        let d = StoreDecryptor(key: v.hex("keyHex"))
        var out: [[UInt8]] = []
        for byte in stream { out += try d.push([byte]) }   // one byte at a time
        try d.end(expectedBytes: v.int("plaintextBytes"))
        XCTAssertEqual(out, v.fileDatas())
    }
    func testRejectsOversizedFrame() {
        let d = StoreDecryptor(key: [UInt8](repeating: 0x55, count: 32))
        var big = [UInt8](repeating: 0, count: 4)
        // length prefix = MAX_FRAME_CT + 1 (big-endian)
        let n = UInt32(MAX_FRAME_CT + 1)
        big[0] = UInt8(n >> 24 & 0xff); big[1] = UInt8(n >> 16 & 0xff)
        big[2] = UInt8(n >> 8 & 0xff);  big[3] = UInt8(n & 0xff)
        XCTAssertThrowsError(try d.push(big)) { XCTAssertEqual($0 as? StoredWireError, .frameTooLarge) }
    }
    func testEndRejectsTrailingBytes() throws {
        let v = try Vectors.load("store-wire-vectors")
        let d = StoreDecryptor(key: v.hex("keyHex"))
        _ = try d.push(Array(v.hex("streamHex").dropLast()))   // last frame incomplete
        XCTAssertThrowsError(try d.end(expectedBytes: nil)) { XCTAssertEqual($0 as? StoredWireError, .truncatedStream) }
    }
    func testEndRejectsLengthMismatch() throws {
        let v = try Vectors.load("store-wire-vectors")
        let d = StoreDecryptor(key: v.hex("keyHex"))
        _ = try d.push(v.hex("streamHex"))
        XCTAssertThrowsError(try d.end(expectedBytes: v.int("plaintextBytes") + 1)) {
            XCTAssertEqual($0 as? StoredWireError, .lengthMismatch)
        }
    }
}
