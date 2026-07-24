import XCTest
@testable import RelayiumKit

final class SodiumReadyTests: XCTestCase {
    func testSodiumInitialises() {
        XCTAssertTrue(RelayiumKit.sodiumReady())
    }
}
