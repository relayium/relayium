import XCTest
@testable import RelayiumKit

final class SendWindowTests: XCTestCase {
    func testBlocksBeyondWindow() {
        var w = SendWindow(window: 100)
        XCTAssertTrue(w.maySend)
        w.recordSent(80); XCTAssertTrue(w.maySend)   // inFlight 80 <= 100
        w.recordSent(40); XCTAssertFalse(w.maySend)  // inFlight 120 > 100
        w.recordAck(50); XCTAssertTrue(w.maySend)    // inFlight 70 <= 100
    }
    func testAckIsMonotonic() {
        var w = SendWindow(window: 100)
        w.recordSent(120); w.recordAck(60); w.recordAck(30) // stale ack ignored
        XCTAssertEqual(w.inFlight, 60)                        // 120 - 60
    }
    func testDefaultWindowIsFlowWindow() {
        var w = SendWindow(); w.recordSent(FLOW_WINDOW); XCTAssertTrue(w.maySend)
        w.recordSent(1); XCTAssertFalse(w.maySend)
    }
}
