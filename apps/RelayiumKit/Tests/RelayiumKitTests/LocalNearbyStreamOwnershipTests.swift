import XCTest
@testable import RelayiumLocalPeerKit

final class LocalNearbyStreamOwnershipTests: XCTestCase {
    func testEndBeforeInstallIsDeliveredExactlyOnce() {
        let box = LocalPeerStreamHandlerBox()
        XCTAssertNil(box.takeCloseCallback())
        XCTAssertEqual(box.snapshot.closeState, .endedUndelivered)

        var calls = 0
        box.installCloseHandler { calls += 1 }?()
        XCTAssertEqual(calls, 1)
        XCTAssertNil(box.takeCloseCallback())
        box.installCloseHandler { calls += 1 }?()
        XCTAssertEqual(calls, 1)
    }

    func testClearingDisownsOldHandlerWithoutConsumingFutureClose() {
        let box = LocalPeerStreamHandlerBox()
        var oldCalls = 0
        XCTAssertNil(box.installCloseHandler { oldCalls += 1 })
        XCTAssertNil(box.installCloseHandler(nil))
        XCTAssertNil(box.takeCloseCallback())

        var newCalls = 0
        box.installCloseHandler { newCalls += 1 }?()
        XCTAssertEqual(oldCalls, 0)
        XCTAssertEqual(newCalls, 1)
    }

    func testStartAndCancelAreIndependentOneShots() {
        let box = LocalPeerStreamHandlerBox()
        XCTAssertEqual(box.start(), .start)
        XCTAssertEqual(box.start(), .ignore)
        XCTAssertEqual(box.cancel(), .cancel)
        XCTAssertEqual(box.cancel(), .ignore)
    }

    func testCallbacksCanReenterWithoutDeadlock() {
        let box = LocalPeerStreamHandlerBox()
        var calls = 0
        XCTAssertNil(box.installCloseHandler {
            calls += 1
            XCTAssertNil(box.installCloseHandler(nil))
            XCTAssertEqual(box.cancel(), .cancel)
        })
        box.takeCloseCallback()?()
        XCTAssertEqual(calls, 1)
    }
}
