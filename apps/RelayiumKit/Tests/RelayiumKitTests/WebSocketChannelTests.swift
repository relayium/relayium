import XCTest
@testable import RelayiumKit

final class WebSocketChannelTests: XCTestCase {
    func testFakeRecordsSendsOnlyWhenOpen() {
        let ch = FakeWebSocketChannel()
        ch.send("dropped")           // not open yet → dropped (best-effort)
        ch.fireOpen()
        ch.send("kept")
        XCTAssertEqual(ch.sent, ["kept"])
    }
}
