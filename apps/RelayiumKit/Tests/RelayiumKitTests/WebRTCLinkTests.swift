import XCTest
@testable import RelayiumKit
final class WebRTCLinkTests: XCTestCase {
    func testWebRTCLinks() { XCTAssertTrue(webrtcAvailable()) }
}
