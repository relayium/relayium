import XCTest
@testable import RelayiumKit

final class BoundedDataStreamTests: XCTestCase {
    func testSlowConsumerSuspendsAtHighWaterAndResumesAtLowWaterWithoutDroppingBytes() async throws {
        let stream = BoundedDataStream(highWaterBytes: 8, lowWaterBytes: 4)
        let lock = NSLock()
        var suspends = 0
        var resumes = 0
        var cancels = 0
        stream.attach(
            suspend: { lock.lock(); suspends += 1; lock.unlock() },
            resume: { lock.lock(); resumes += 1; lock.unlock() },
            cancel: { lock.lock(); cancels += 1; lock.unlock() })

        stream.yield(Data([1, 2, 3, 4]))
        stream.yield(Data([5, 6, 7, 8]))
        XCTAssertEqual(stream.bufferedBytesForTesting, 8)
        XCTAssertTrue(stream.isBackpressuredForTesting)
        XCTAssertEqual(suspends, 1)

        var iterator: BoundedDataStream.Iterator? = stream.makeAsyncIterator()
        let first = try await iterator?.next()
        XCTAssertEqual(first, Data([1, 2, 3, 4]))
        XCTAssertEqual(stream.bufferedBytesForTesting, 4)
        XCTAssertFalse(stream.isBackpressuredForTesting)
        XCTAssertEqual(resumes, 1)

        let second = try await iterator?.next()
        XCTAssertEqual(second, Data([5, 6, 7, 8]))
        stream.finish()
        let end = try await iterator?.next()
        XCTAssertNil(end)
        iterator = nil
        XCTAssertEqual(cancels, 0, "a fully consumed completed task is not cancelled")
    }

    func testAbandoningIteratorCancelsTheOwnedTaskAndDiscardsBufferedCiphertext() async throws {
        let stream = BoundedDataStream(highWaterBytes: 8, lowWaterBytes: 4)
        let lock = NSLock()
        var cancels = 0
        stream.attach(suspend: {}, resume: {}, cancel: {
            lock.lock(); cancels += 1; lock.unlock()
        })
        stream.yield(Data(repeating: 7, count: 8))

        var iterator: BoundedDataStream.Iterator? = stream.makeAsyncIterator()
        XCTAssertNotNil(iterator)
        iterator = nil

        XCTAssertEqual(cancels, 1)
        XCTAssertEqual(stream.bufferedBytesForTesting, 0)
        await XCTAssertBoundedStreamThrows(try await stream.makeAsyncIterator().next()) { error in
            XCTAssertTrue(error is CancellationError)
        }
    }
}

private func XCTAssertBoundedStreamThrows<T>(
    _ expression: @autoclosure () async throws -> T,
    _ verify: (Error) -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("expected error", file: file, line: line)
    } catch {
        verify(error)
    }
}
