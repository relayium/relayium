import XCTest
import RelayiumKit
@testable import RelayiumAppKit

private struct UnknownFailure: Error {}

final class ErrorCopyTests: XCTestCase {
    func testAccountErrorsAllMapToNonEmptyText() {
        let cases: [AccountError] = [
            .invalidCredentials, .rateLimited, .server(status: 503), .decoding, .network,
        ]
        for e in cases {
            XCTAssertFalse(ErrorCopy.message(for: e).isEmpty, "no copy for \(e)")
        }
    }
    func testServerErrorNamesTheStatus() {
        XCTAssertTrue(ErrorCopy.message(for: AccountError.server(status: 503)).contains("503"))
    }
    func testInvalidCredentialsTalksAboutEmailAndPassword() {
        let m = ErrorCopy.message(for: AccountError.invalidCredentials).lowercased()
        XCTAssertTrue(m.contains("email") && m.contains("password"))
    }
    func testKeychainErrorNamesTheStatusCode() {
        XCTAssertTrue(ErrorCopy.message(for: KeychainError.status(-25300)).contains("-25300"))
    }
    /// Quota and rate-limit are the only two an upload user can act on, so they
    /// must not collapse into a generic message.
    func testCloudQuotaAndRateLimitAreDistinctAndActionable() {
        let quota = ErrorCopy.message(for: CloudError.quota)
        let rate = ErrorCopy.message(for: CloudError.rateLimited)
        XCTAssertNotEqual(quota, rate)
        XCTAssertTrue(quota.lowercased().contains("space") || quota.lowercased().contains("quota"))
        XCTAssertTrue(rate.lowercased().contains("wait") || rate.lowercased().contains("too many"))
    }

    /// The three 429s must read differently, and only one of them may suggest
    /// waiting — the other two reset tomorrow and next month.
    func testTheThree429sReadDifferently() {
        let wait = ErrorCopy.message(for: CloudError.rateLimited)
        let daily = ErrorCopy.message(for: CloudError.dailyQuota)
        let monthly = ErrorCopy.message(for: CloudError.monthlyTraffic)
        XCTAssertEqual(Set([wait, daily, monthly]).count, 3)
        XCTAssertTrue(daily.lowercased().contains("tomorrow"))
        XCTAssertTrue(monthly.lowercased().contains("month"))
        // The gate is `used + this file > quota`, so one big file trips it with
        // nothing else sent today. Copy that blames past usage would misdirect.
        XCTAssertTrue(daily.lowercased().contains("single large file"))
    }

    /// Deny and expire are different events and must not share a message: one
    /// says a person refused, the other says nobody answered in time.
    func testDeviceAuthOutcomesReadDifferently() {
        let denied = ErrorCopy.message(for: DeviceAuthOutcomeError.denied)
        let expired = ErrorCopy.message(for: DeviceAuthOutcomeError.expired)
        XCTAssertNotEqual(denied, expired)
        XCTAssertFalse(denied.contains("DeviceAuthOutcomeError"), "fell through to the type-name fallback")
        XCTAssertFalse(expired.contains("DeviceAuthOutcomeError"), "fell through to the type-name fallback")
        // A timeout is nobody's mistake; it must not read as a rejection.
        XCTAssertFalse(expired.lowercased().contains("declined"))
    }

    /// A missing link has three plausible causes and the copy must not assert one.
    func testNotFoundNamesAllThreeCauses() {
        let m = ErrorCopy.message(for: CloudError.notFound).lowercased()
        XCTAssertTrue(m.contains("expired"))
        XCTAssertTrue(m.contains("downloaded") || m.contains("burn"))
    }

    /// Integrity failures must not invite a retry — they are not transient.
    func testIntegrityFailuresDoNotInviteRetry() {
        for e in [StoredWireError.lengthMismatch, .truncatedStream] {
            let m = ErrorCopy.message(for: e).lowercased()
            XCTAssertFalse(m.contains("try again"), "\(e) must not invite a retry")
        }
    }

    func testEveryCloudErrorHasCopy() {
        let cases: [CloudError] = [
            .unauthorized, .quota, .rateLimited, .dailyQuota, .monthlyTraffic,
            .notFound, .server(status: 500), .network, .decoding,
        ]
        for e in cases {
            let m = ErrorCopy.message(for: e)
            XCTAssertFalse(m.isEmpty, "no copy for \(e)")
            XCTAssertFalse(m.contains("CloudError"), "\(e) fell through to the type-name fallback")
        }
    }

    /// The refusal has to explain itself — the spec calls a bare refusal a bug.
    func testDirectoryExistsExplainsWhyItWontMerge() {
        let m = ErrorCopy.message(for: DownloadDestinationError.directoryExists(name: "relayium-abc"))
        XCTAssertTrue(m.contains("relayium-abc"))
        XCTAssertTrue(m.lowercased().contains("merge"))
    }

    /// A manifest that tries to escape the destination is refused by name, so a
    /// bug report can say which entry did it.
    func testUnsafeNameIsReportedWithTheOffendingName() {
        let m = ErrorCopy.message(for: DownloadDestinationError.unsafeName("../escape.txt"))
        XCTAssertTrue(m.contains("../escape.txt"))
    }

    // The realtime rounds route ConnectionError, HandshakeError, RealtimeError and bare
    // WebRTC NSErrors through one ((Error) -> Void). The fallback must already be total.
    func testUnknownErrorStillProducesActionableText() {
        let m = ErrorCopy.message(for: UnknownFailure())
        XCTAssertFalse(m.isEmpty)
        XCTAssertTrue(m.contains("UnknownFailure"), "fallback should name the type for a bug report")
    }
}
