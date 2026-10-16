import XCTest
@testable import RelayiumKit

final class LinkInboundFrameQueueTests: XCTestCase {
    func testWrapAndGrowPreserveEveryFrameInOrder() {
        var queue = LinkInboundFrameQueue<[UInt8]>()
        var oracle: [[UInt8]] = []
        var state: UInt64 = 17
        var peak = 0
        // Repeatedly wrap partially filled rings and grow with a nonzero head.
        for i in 0..<50_000 {
            state = state &* 6364136223846793005 &+ 1
            if oracle.isEmpty || (oracle.count < 4096 && state >> 61 < 5) {
                let frame = [UInt8(i & 255), UInt8((i >> 8) & 255)]
                queue.append(frame)
                oracle.append(frame)
                peak = max(peak, oracle.count)
            } else {
                XCTAssertEqual(queue.removeFirst(), oracle.removeFirst())
            }
            XCTAssertEqual(queue.count, oracle.count)
            XCTAssertEqual(queue.isEmpty, oracle.isEmpty)
            XCTAssertLessThanOrEqual(queue.capacity, max(8, peak * 2))
        }
        while !oracle.isEmpty {
            XCTAssertEqual(queue.removeFirst(), oracle.removeFirst())
        }
        XCTAssertTrue(queue.isEmpty)
        for i in 0..<10_000 {
            queue.append([UInt8(i & 255)])
            XCTAssertEqual(queue.removeFirst(), [UInt8(i & 255)])
        }
        XCTAssertEqual(queue.count, 0)
        XCTAssertLessThanOrEqual(queue.capacity, max(8, peak * 2))
    }

    func testConsumedPayloadAndResetDoNotRetainFrames() {
        final class Payload { let bytes = [UInt8](repeating: 7, count: 65_536) }
        var queue = LinkInboundFrameQueue<Payload>()
        weak var consumed: Payload?
        weak var waiting: Payload?
        do {
            let first = Payload(), second = Payload()
            consumed = first
            waiting = second
            queue.append(first)
            queue.append(second)
        }
        do {
            let frame = queue.removeFirst()
            XCTAssertTrue(frame === consumed)
        }
        XCTAssertNil(consumed, "a popped frame must not stay in a consumed ring slot")
        XCTAssertNotNil(waiting, "a queued frame is still owned")
        queue = LinkInboundFrameQueue()
        XCTAssertNil(waiting, "terminal reset releases every queued payload")
        XCTAssertEqual(queue.capacity, 0)
        XCTAssertEqual(queue.count, 0)
    }

    func testOptionalPayloadIsDistinctFromAnEmptySlot() {
        var queue = LinkInboundFrameQueue<Int?>()
        queue.append(nil)
        queue.append(7)
        XCTAssertNil(queue.removeFirst())
        XCTAssertEqual(queue.removeFirst(), 7)
        XCTAssertTrue(queue.isEmpty)
    }
}
