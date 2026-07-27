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
    /// Exercises the real keychain, and is opt-in on purpose.
    ///
    /// This test used to decide for itself: it caught a failing `SecItemAdd` and
    /// turned it into a skip. That made its outcome track ambient state — whether
    /// the login keychain happens to be unlocked, whether an earlier run left an
    /// ACL behind — and on one machine, in one afternoon, it both skipped and
    /// passed without the code changing. A test that green for environmental
    /// reasons reports nothing, and it must not be carried into CI, where the
    /// keychain state is different again on every fresh runner.
    ///
    /// So it skips deterministically unless asked for. Run it by hand as a smoke
    /// check when the keychain configuration is what you are testing:
    ///
    ///     RELAYIUM_KEYCHAIN_ROUNDTRIP=1 swift test --filter TokenStoreTests
    ///
    /// When enabled it does not swallow failures — that is the point of asking.
    func testKeychainRoundTripIfAvailable() throws {
        guard ProcessInfo.processInfo.environment["RELAYIUM_KEYCHAIN_ROUNDTRIP"] == "1" else {
            throw XCTSkip("opt-in: set RELAYIUM_KEYCHAIN_ROUNDTRIP=1 to exercise the real keychain")
        }
        let s = KeychainTokenStore(service: "com.relayium.mac.test", account: "bearer")
        try? s.clear()
        try s.save("rlm_cli_kc")
        XCTAssertEqual(try s.load(), "rlm_cli_kc")
        try s.clear()
        XCTAssertNil(try s.load())
    }
}
