import XCTest
@testable import RelayiumKit

final class AeadTests: XCTestCase {
    func testSealMatchesVector() throws {
        let v = try Vectors.load()
        let key = v.hex("aead.keyHex")
        let seq = UInt64(v.int("aead.seq"))
        let pt = v.hex("aead.ptHex")
        XCTAssertEqual(seal(key: key, seq: seq, plaintext: pt), v.hex("aead.ctHex"))
    }
    func testRoundTrip() throws {
        let v = try Vectors.load()
        let key = v.hex("aead.keyHex")
        let ct = v.hex("aead.ctHex")
        XCTAssertEqual(open(key: key, seq: 5, ciphertext: ct), v.hex("aead.ptHex"))
        XCTAssertNil(open(key: key, seq: 6, ciphertext: ct)) // wrong seq → auth fail
        XCTAssertNil(open(key: key, seq: 5, ciphertext: [1, 2, 3])) // too short → nil
    }
    func testNonceLayout() {
        // seq = 0x0000000100000002 → bytes 4..8 = 00 00 00 01, bytes 8..12 = 00 00 00 02
        let n = nonceFromSeq(0x0000_0001_0000_0002)
        XCTAssertEqual(n, [0,0,0,0, 0,0,0,1, 0,0,0,2])
    }
}
