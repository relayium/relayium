import XCTest
@testable import RelayiumKit

final class TokenStoreTests: XCTestCase {
    func testInMemoryRoundTrip() throws {
        let s = InMemoryTokenStore()
        XCTAssertNil(try s.load())
        try s.save("rlm_cli_x")
        XCTAssertEqual(try s.load(), "rlm_cli_x")
        try s.save("rlm_cli_y")           // overwrite
        XCTAssertEqual(try s.load(), "rlm_cli_y")
        try s.clear()
        XCTAssertNil(try s.load())
    }
    func testKeychainRoundTripIfAvailable() throws {
        let s = KeychainTokenStore(service: "com.relayium.mac.test", account: "bearer")
        try? s.clear()
        do {
            try s.save("rlm_cli_kc")
        } catch {
            throw XCTSkip("keychain unavailable in this test host: \(error)")
        }
        XCTAssertEqual(try s.load(), "rlm_cli_kc")
        try s.clear()
        XCTAssertNil(try s.load())
    }
}
