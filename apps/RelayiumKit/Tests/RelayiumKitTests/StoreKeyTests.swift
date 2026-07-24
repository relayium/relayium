import XCTest
@testable import RelayiumKit

final class StoreKeyTests: XCTestCase {
    func testEncodeMatchesVector() throws {
        let v = try Vectors.load("store-wire-vectors")
        XCTAssertEqual(encodeStoreKey(v.hex("keyHex")), v.str("keyB64url"))
    }
    func testDecodeRoundTrips() throws {
        let v = try Vectors.load("store-wire-vectors")
        XCTAssertEqual(try decodeStoreKey(v.str("keyB64url")), v.hex("keyHex"))
    }
    func testDecodeRejectsInvalid() {
        XCTAssertThrowsError(try decodeStoreKey("a"))          // length % 4 == 1
        XCTAssertThrowsError(try decodeStoreKey("****"))       // outside alphabet
        XCTAssertThrowsError(try decodeStoreKey("ab=c"))       // '=' not allowed
    }
    func testGenerateIs32Random() {
        XCTAssertEqual(generateStoreKey().count, 32)
        XCTAssertNotEqual(generateStoreKey(), generateStoreKey())
    }
}
