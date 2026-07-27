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
    // The realtime rounds route ConnectionError, HandshakeError, RealtimeError and bare
    // WebRTC NSErrors through one ((Error) -> Void). The fallback must already be total.
    func testUnknownErrorStillProducesActionableText() {
        let m = ErrorCopy.message(for: UnknownFailure())
        XCTAssertFalse(m.isEmpty)
        XCTAssertTrue(m.contains("UnknownFailure"), "fallback should name the type for a bug report")
    }
}
