import XCTest
@testable import RelayiumKit

/// The two re-entrancy decisions a link transport's private queue has to make,
/// tested as the ordinary unit tests they are rather than as a source guard.
///
/// Both are invisible until they are wrong, and both are wrong by default: a
/// `sync` from a callback deadlocks, and an `async` from a callback silently
/// reorders a close behind exactly the work it was meant to prevent.
final class LinkTransportQueueTests: XCTestCase {

    private func queue(_ label: String = #function) -> LinkTransportQueue {
        LinkTransportQueue(label: "test.\(label)")
    }

    // MARK: - which queue am I on

    func testIsCurrentIsFalseOutsideAndTrueInside() {
        let queue = self.queue()
        XCTAssertFalse(queue.isCurrent)
        queue.sync { XCTAssertTrue(queue.isCurrent) }
        XCTAssertFalse(queue.isCurrent)
    }

    /// Each instance marks its own queue with its own identity: a transport
    /// running inside another transport's callback must see "not my queue", or
    /// its `sync` runs on somebody else's serial queue and its inline close
    /// fires at the wrong moment.
    func testOneQueueIsNeverMistakenForAnother() {
        let first = self.queue("first")
        let second = self.queue("second")
        first.sync {
            XCTAssertTrue(first.isCurrent)
            XCTAssertFalse(second.isCurrent)
        }
    }

    // MARK: - sync

    /// A consumer asking `bufferedAmount` from inside `onFrame` is already on
    /// the queue. A bare `queue.sync` there is a self-deadlock, not a
    /// theoretical one.
    func testSyncFromInsideTheQueueRunsInlineInsteadOfDeadlocking() {
        let queue = self.queue()
        let finished = expectation(description: "the nested sync returned")
        queue.later {
            XCTAssertEqual(queue.sync { 42 }, 42)
            finished.fulfill()
        }
        wait(for: [finished], timeout: 2)
    }

    func testSyncFromOutsideReturnsTheValue() {
        XCTAssertEqual(queue().sync { "value" }, "value")
    }

    // MARK: - nowOrLater

    /// The guarantee `close()` rests on: work submitted from inside the queue
    /// has already run by the time the submitting call returns.
    func testNowOrLaterRunsInlineWhenAlreadyOnTheQueue() {
        let queue = self.queue()
        let finished = expectation(description: "checked")
        queue.later {
            var trace: [String] = []
            queue.nowOrLater { trace.append("submitted") }
            trace.append("after")
            XCTAssertEqual(trace, ["submitted", "after"],
                           "an inline close must take effect before the caller continues")
            finished.fulfill()
        }
        wait(for: [finished], timeout: 2)
    }

    /// From outside it must NOT run inline: an owner pressing cancel would
    /// otherwise block its thread on `RTCPeerConnection.close()`, which joins
    /// WebRTC's internal threads.
    func testNowOrLaterIsAsynchronousFromOutsideTheQueue() {
        let queue = self.queue()
        let blocked = DispatchSemaphore(value: 0)
        let entered = expectation(description: "the queue is busy")
        let ran = expectation(description: "the submitted work ran")

        // Occupy the serial queue so anything asynchronous provably cannot have
        // run yet when `nowOrLater` returns.
        queue.later {
            entered.fulfill()
            blocked.wait()
        }
        wait(for: [entered], timeout: 2)

        let done = NSLock()
        var didRun = false
        queue.nowOrLater {
            done.lock(); didRun = true; done.unlock()
            ran.fulfill()
        }
        done.lock()
        XCTAssertFalse(didRun, "an outside caller is not made to wait for the queue")
        done.unlock()

        blocked.signal()
        wait(for: [ran], timeout: 2)
    }

    // MARK: - scheduling

    func testAfterRunsOnTheQueue() {
        let queue = self.queue()
        let fired = expectation(description: "fired")
        queue.after(0.01) {
            XCTAssertTrue(queue.isCurrent)
            fired.fulfill()
        }
        wait(for: [fired], timeout: 2)
    }

    /// Cancelling before the item starts is what keeps a superseded deadline
    /// from firing.
    func testACancelledItemNeverRuns() {
        let queue = self.queue()
        let shouldNotFire = expectation(description: "cancelled")
        shouldNotFire.isInverted = true
        let item = queue.after(0.05) { shouldNotFire.fulfill() }
        item.cancel()
        wait(for: [shouldNotFire], timeout: 0.3)
    }
}
