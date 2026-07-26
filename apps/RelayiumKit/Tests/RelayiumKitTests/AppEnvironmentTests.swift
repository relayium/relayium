import XCTest
@testable import RelayiumAppKit

final class AppEnvironmentTests: XCTestCase {
    func testProductionBaseURLIsTheServiceOrigin() {
        XCTAssertEqual(AppEnvironment.productionBaseURL.absoluteString, "https://relayium.com")
    }
    // Never empty: it becomes the device name in the user's device list on the web.
    func testDeviceNameIsNeverEmpty() {
        XCTAssertFalse(AppEnvironment.deviceName().isEmpty)
    }
    func testKeychainIdentityMatchesTheBundle() {
        XCTAssertEqual(AppEnvironment.keychainService, "com.relayium.mac")
        XCTAssertEqual(AppEnvironment.keychainAccount, "bearer-token")
    }
}
