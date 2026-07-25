import XCTest
@testable import RelayiumKit
final class RealtimeFrameTests: XCTestCase {
    func testConstants() {
        XCTAssertEqual(CHUNK_SIZE, 192*1024); XCTAssertEqual(CHUNK_OVERHEAD, 21)
        XCTAssertEqual(FLOW_WINDOW, 8<<20); XCTAssertEqual(FLOW_ACK_INTERVAL, 512*1024)
    }
    func testFrameLayout() {
        let f = realtimeFrame(kind: 1, seq: 0x01020304, payload: [0xaa,0xbb])
        XCTAssertEqual(f, [1, 0x01,0x02,0x03,0x04, 0xaa,0xbb])
    }
    func testAckMatchesVector() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        XCTAssertEqual(ackFrame(1_048_576), v.hex("ackHex"))
        XCTAssertEqual(parseAck(v.hex("ackHex")), 1_048_576)
        XCTAssertNil(parseAck([1,2,3]))
    }
    func testControl() {
        XCTAssertEqual(parseControl([0xfe]), .accept)
        XCTAssertEqual(parseControl([0xfd]), .complete)
        XCTAssertNil(parseControl([0xfe, 0x00]))   // must be exactly 1 byte
        XCTAssertNil(parseControl([0x01]))
    }
}
