import XCTest
@testable import RelayiumAppKit

final class LinkRequestOperationTests: XCTestCase {
    func testFirstSettlementWinsAndIsRetained() {
        let operation = LinkRequestOperation()
        var received: [LinkRequestOperation.Outcome] = []
        let token = operation.observe { received.append($0) }

        XCTAssertTrue(operation.settle(.establishing))
        XCTAssertFalse(operation.settle(.refused))
        XCTAssertEqual(operation.settledOutcome, .establishing)
        XCTAssertEqual(received, [.establishing])
        withExtendedLifetime(token) {}
    }

    func testMultipleRetainedObserversRunOnce() {
        let operation = LinkRequestOperation()
        var first: [LinkRequestOperation.Outcome] = []
        var second: [LinkRequestOperation.Outcome] = []
        let firstToken = operation.observe { first.append($0) }
        let secondToken = operation.observe { second.append($0) }

        XCTAssertTrue(operation.settle(.refused))
        XCTAssertFalse(operation.settle(.cancelled))
        XCTAssertEqual(first, [.refused])
        XCTAssertEqual(second, [.refused])
        withExtendedLifetime((firstToken, secondToken)) {}
    }

    func testCancellingTokenRemovesOnlyThatObserverAndIsIdempotent() {
        let operation = LinkRequestOperation()
        var cancelledCount = 0
        var retainedCount = 0
        let cancelled = operation.observe { _ in cancelledCount += 1 }
        let retained = operation.observe { _ in retainedCount += 1 }

        cancelled.cancel()
        cancelled.cancel()
        XCTAssertTrue(operation.settle(.timedOut))
        XCTAssertEqual(cancelledCount, 0)
        XCTAssertEqual(retainedCount, 1)
        withExtendedLifetime(retained) {}
    }

    func testDroppedTokenRemovesObserver() {
        let operation = LinkRequestOperation()
        var count = 0
        var token: LinkRequestOperation.ObserverToken? = operation.observe { _ in count += 1 }
        XCTAssertNotNil(token)

        token = nil
        XCTAssertTrue(operation.settle(.cancelled))
        XCTAssertEqual(count, 0)
    }

    func testLateObserverRunsSynchronously() {
        let operation = LinkRequestOperation()
        XCTAssertTrue(operation.settle(.timedOut))
        var returned = false
        var ranBeforeReturn = false

        let token = operation.observe { outcome in
            ranBeforeReturn = !returned
            XCTAssertEqual(outcome, .timedOut)
        }
        returned = true

        XCTAssertTrue(ranBeforeReturn)
        withExtendedLifetime(token) {}
    }

    func testObserverCanReenterAfterSettlement() {
        let operation = LinkRequestOperation()
        var nestedOutcome: LinkRequestOperation.Outcome?
        var nestedToken: LinkRequestOperation.ObserverToken?
        let outerToken = operation.observe { _ in
            XCTAssertEqual(operation.settledOutcome, .establishing)
            nestedToken = operation.observe { nestedOutcome = $0 }
        }

        XCTAssertTrue(operation.settle(.establishing))
        XCTAssertEqual(nestedOutcome, .establishing)
        withExtendedLifetime((outerToken, nestedToken)) {}
    }
}
