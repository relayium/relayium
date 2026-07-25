import XCTest
@testable import RelayiumKit

final class AckPacerTests: XCTestCase {
    func testAcksAtInterval() {
        var p = AckPacer(interval: 100)
        XCTAssertNil(p.onWritten(total: 50))     // < interval
        XCTAssertEqual(p.onWritten(total: 100), 100)  // reached interval → ack 100
        XCTAssertNil(p.onWritten(total: 150))    // 150-100 < 100
        XCTAssertEqual(p.onWritten(total: 220), 220)  // 220-100 >= 100 → ack 220
    }
    func testDefaultInterval() {
        var p = AckPacer()
        XCTAssertNil(p.onWritten(total: FLOW_ACK_INTERVAL - 1))
        XCTAssertEqual(p.onWritten(total: FLOW_ACK_INTERVAL), FLOW_ACK_INTERVAL)
    }
}
