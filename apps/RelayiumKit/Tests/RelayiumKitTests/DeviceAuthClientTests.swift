import XCTest
@testable import RelayiumKit

final class DeviceAuthClientTests: XCTestCase {
    /// The server's own field names. Getting one wrong fails at runtime with a
    /// decode error that says nothing about which key was missing.
    func testParsesTheStartResponse() throws {
        let json = """
        {"user_code":"WDJB-MJHT","device_code":"dc_abc","verification_uri":"https://relayium.com/device",
         "interval":5,"expires_in":600}
        """.data(using: .utf8)!
        let s = try parseDeviceStart(json)
        XCTAssertEqual(s.userCode, "WDJB-MJHT")
        XCTAssertEqual(s.deviceCode, "dc_abc")
        XCTAssertEqual(s.verificationURL, URL(string: "https://relayium.com/device")!)
        XCTAssertEqual(s.interval, 5)
        XCTAssertEqual(s.expiresIn, 600)
    }

    /// All four poll outcomes arrive as HTTP 200 with a `status` field — a poll
    /// that treated non-200 as the signal would hang forever on `pending`.
    func testParsesEveryPollOutcome() throws {
        XCTAssertEqual(try parseDevicePoll(#"{"status":"authorization_pending"}"#.data(using: .utf8)!), .pending)
        XCTAssertEqual(try parseDevicePoll(#"{"status":"denied"}"#.data(using: .utf8)!), .denied)
        XCTAssertEqual(try parseDevicePoll(#"{"status":"expired"}"#.data(using: .utf8)!), .expired)
        XCTAssertEqual(
            try parseDevicePoll(#"{"status":"ok","access_token":"rlm_cli_x","account_email":"a@b.c"}"#.data(using: .utf8)!),
            .ok(token: "rlm_cli_x", accountEmail: "a@b.c"))
    }

    /// An unknown status must not be read as success. A future server state that
    /// silently mapped to `.ok` would sign the user in with an empty token.
    func testUnknownStatusIsRejected() {
        XCTAssertThrowsError(try parseDevicePoll(#"{"status":"something_new"}"#.data(using: .utf8)!))
    }

    /// `ok` without a token is a server bug, and adopting "" would land the app
    /// in .ready with a bearer that 401s on the next request.
    func testOkWithoutATokenIsRejected() {
        XCTAssertThrowsError(try parseDevicePoll(#"{"status":"ok","account_email":"a@b.c"}"#.data(using: .utf8)!))
        XCTAssertThrowsError(try parseDevicePoll(#"{"status":"ok","access_token":"","account_email":"a@b.c"}"#.data(using: .utf8)!))
    }

    /// The prefilled approval URL is what makes this one click rather than a
    /// transcription exercise.
    func testApprovalURLCarriesTheUserCode() throws {
        let json = """
        {"user_code":"WDJB-MJHT","device_code":"d","verification_uri":"https://relayium.com/device",
         "interval":5,"expires_in":600}
        """.data(using: .utf8)!
        let s = try parseDeviceStart(json)
        XCTAssertEqual(s.approvalURL.absoluteString, "https://relayium.com/device?code=WDJB-MJHT")
    }

    /// A self-hosted deployment is a different origin, and the code must survive
    /// percent-encoding rules unscathed.
    func testApprovalURLWorksForAnyOrigin() throws {
        let json = """
        {"user_code":"AB12-CD34","device_code":"d","verification_uri":"https://files.example.org/device",
         "interval":5,"expires_in":600}
        """.data(using: .utf8)!
        let s = try parseDeviceStart(json)
        XCTAssertEqual(s.approvalURL.absoluteString, "https://files.example.org/device?code=AB12-CD34")
    }

    /// A body that isn't the shape we expect must fail rather than yield a
    /// half-built start with an empty device code we would then poll with.
    func testMalformedStartIsRejected() {
        XCTAssertThrowsError(try parseDeviceStart(#"{"user_code":"X"}"#.data(using: .utf8)!))
        XCTAssertThrowsError(try parseDeviceStart(Data()))
    }
}
