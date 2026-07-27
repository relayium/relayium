import XCTest
@testable import RelayiumKit

final class ResumableTransportTests: XCTestCase {
    /// 409 is not an error: the server is ahead of us, and its offset is the
    /// one to believe. Treating it as a failure would abandon a live upload.
    func testPatchOutcomeDistinguishesServerAhead() {
        XCTAssertNotEqual(PatchOutcome.committed(received: 10), .serverAhead(received: 10))
        XCTAssertEqual(PatchOutcome.committed(received: 10), .committed(received: 10))
    }

    /// The header the server parses. A wrong end offset silently corrupts the
    /// blob, so it is pinned by a test rather than trusted to review.
    func testContentRangeHeaderIsInclusiveOfEnd() {
        XCTAssertEqual(contentRangeHeader(from: 0, to: 100, total: 500), "bytes 0-99/500")
        XCTAssertEqual(contentRangeHeader(from: 100, to: 150, total: 500), "bytes 100-149/500")
    }

    /// The upload path has three different 429s and only one of them means
    /// "wait". Telling a user to wait a minute for a limit that resets next
    /// month is worse than saying nothing.
    ///
    /// Retry-After is the discriminator, not the prose: the server sets it on
    /// the concurrency gate (uploads_resumable.go:205) and on neither quota
    /// gate. The body only chooses between the two quota wordings.
    func testConcurrencyLimitIsTheOnlyTransient429() {
        XCTAssertEqual(tooManyRequestsError(retryAfter: "1",
                                            body: "too many concurrent uploads"), .rateLimited)
        // Retry-After wins even if the body is unfamiliar — a server that asks
        // us to retry is asking for a retry.
        XCTAssertEqual(tooManyRequestsError(retryAfter: "3", body: "something new"), .rateLimited)
    }

    func testDailyQuotaAndMonthlyTrafficAreDistinguished() {
        XCTAssertEqual(tooManyRequestsError(retryAfter: nil,
                                            body: "daily quota exceeded"), .dailyQuota)
        XCTAssertEqual(tooManyRequestsError(retryAfter: nil,
                                            body: "monthly traffic limit reached — upgrade to continue"),
                       .monthlyTraffic)
    }

    /// Matching server prose is a wire contract that can drift. When it does,
    /// degrade to the generic wait copy rather than asserting a wrong cause.
    func testUnrecognised429WithoutRetryAfterFallsBackToWaiting() {
        XCTAssertEqual(tooManyRequestsError(retryAfter: nil, body: "some future gate"), .rateLimited)
        XCTAssertEqual(tooManyRequestsError(retryAfter: nil, body: ""), .rateLimited)
    }
}
