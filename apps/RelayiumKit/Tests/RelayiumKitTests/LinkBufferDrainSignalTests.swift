import XCTest
@testable import RelayiumKit

final class LinkBufferDrainSignalTests: XCTestCase {
    func testThresholdAndOneShotDelivery() {
        let signal = LinkBufferDrainSignal()
        var count = 0
        let cancel = signal.observe(whenAtMost: 10) { count += 1 }
        signal.notify(bufferedAmount: 11)
        XCTAssertEqual(count, 0)
        signal.notify(bufferedAmount: 10)
        signal.notify(bufferedAmount: 0)
        XCTAssertEqual(count, 1)
        cancel()
    }

    func testCancelledSubscriptionDoesNotRun() {
        let signal = LinkBufferDrainSignal()
        var count = 0
        let cancel = signal.observe(whenAtMost: 10) { count += 1 }
        cancel()
        cancel()
        signal.notify(bufferedAmount: 0)
        XCTAssertEqual(count, 0)
    }

    func testOldCancellationCannotRemoveANewSubscription() {
        let signal = LinkBufferDrainSignal()
        var result = ""
        let old = signal.observe(whenAtMost: 10) { result += "old" }
        let current = signal.observe(whenAtMost: 10) { result += "new" }
        old()
        signal.notify(bufferedAmount: 0)
        XCTAssertEqual(result, "new")
        current()
    }

    func testCallbackMaySubscribeAndCancelWithoutDeadlocking() {
        let signal = LinkBufferDrainSignal()
        var count = 0
        let cancel = signal.observe(whenAtMost: 10) {
            count += 1
            let next = signal.observe(whenAtMost: 10) { count += 100 }
            next()
        }
        signal.notify(bufferedAmount: 0)
        signal.notify(bufferedAmount: 0)
        XCTAssertEqual(count, 1)
        cancel()
    }
}
