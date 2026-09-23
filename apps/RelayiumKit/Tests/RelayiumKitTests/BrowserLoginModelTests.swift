import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private final class StubDeviceAuth: DeviceAuthClient, @unchecked Sendable {
    var startResult = DeviceAuthStart(userCode: "AAAA-BBBB", deviceCode: "dc",
                                      verificationURL: URL(string: "https://x.test/device")!,
                                      interval: 0, expiresIn: 600)
    var startError: Error?
    /// Runs inside the awaited start, so a test can cancel before any URL exists.
    var onStart: (() async -> Void)?
    /// Thrown by every poll once set: a connection lost mid-wait.
    var pollError: Error?
    /// Consumed in order; the last entry repeats.
    var pollScript: [DevicePollOutcome] = [.ok(token: "rlm_cli_t", accountEmail: "a@b.c")]
    private(set) var pollCount = 0
    /// Runs inside the awaited poll, so a test can land an event mid-flight.
    var onPoll: (() async -> Void)?

    func start() async throws -> DeviceAuthStart {
        await onStart?()
        if let e = startError { throw e }
        return startResult
    }

    func poll(deviceCode: String) async throws -> DevicePollOutcome {
        await onPoll?()
        defer { pollCount += 1 }
        if let e = pollError { throw e }
        return pollScript[min(pollCount, pollScript.count - 1)]
    }
}

@MainActor
final class BrowserLoginModelTests: XCTestCase {
    func testHandsBackTheToken() async {
        let c = StubDeviceAuth()
        let m = BrowserLoginModel(client: c)
        var got: String?
        await m.begin { got = $0 }
        XCTAssertEqual(got, "rlm_cli_t")
    }

    /// The URL the sheet opens must carry the code, or the user has to type it.
    /// Asserted on the published property rather than inside the token closure,
    /// so the test does not depend on when the closure happens to run.
    func testPublishesThePrefilledApprovalURL() async {
        let c = StubDeviceAuth()
        c.pollScript = [.pending, .ok(token: "t", accountEmail: "")]
        let m = BrowserLoginModel(client: c)
        await m.begin { _ in }
        XCTAssertEqual(m.lastApprovalURL?.absoluteString, "https://x.test/device?code=AAAA-BBBB")
        XCTAssertGreaterThanOrEqual(c.pollCount, 2, "should have polled past the pending result")
    }

    /// Deny is a decision, not a failure to keep waiting for.
    func testStopsAndReportsOnDenied() async {
        let c = StubDeviceAuth()
        c.pollScript = [.denied]
        let m = BrowserLoginModel(client: c)
        var got: String?
        await m.begin { got = $0 }
        XCTAssertNil(got)
        guard case .failed(let msg) = m.state else { return XCTFail("got \(m.state)") }
        // What the message *says* is ErrorCopy's job and is asserted there; here
        // it only has to exist and the loop has to stop.
        XCTAssertFalse(msg.isEmpty)
        XCTAssertEqual(c.pollCount, 1, "must not keep polling after a denial")
    }

    func testStopsAndReportsOnExpired() async {
        let c = StubDeviceAuth()
        c.pollScript = [.expired]
        let m = BrowserLoginModel(client: c)
        await m.begin { _ in }
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(c.pollCount, 1)
    }

    /// A failing start is reported, not retried into a hang.
    func testReportsAStartFailure() async {
        let c = StubDeviceAuth()
        c.startError = AccountError.rateLimited
        let m = BrowserLoginModel(client: c)
        await m.begin { _ in }
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(c.pollCount, 0)
    }

    /// Closing the sheet cancels the login. It is not an error and must not
    /// leave a poll loop running against a code nobody will approve.
    func testCancelReturnsToIdle() {
        let m = BrowserLoginModel(client: StubDeviceAuth())
        m.cancel()
        guard case .idle = m.state else { return XCTFail("got \(m.state)") }
    }

    /// A cancel that lands *during* the poll wins: the token from the superseded
    /// run must not be handed to a screen the user has already left. The stub
    /// closes the sheet from inside the awaited call, which is the real race.
    func testCancelDuringAPollDiscardsTheToken() async {
        let c = StubDeviceAuth()
        c.pollScript = [.ok(token: "late", accountEmail: "")]
        let m = BrowserLoginModel(client: c)
        c.onPoll = { [weak m] in await MainActor.run { m?.cancel() } }
        var got: String?
        await m.begin { got = $0 }
        XCTAssertNil(got, "a superseded run handed back a token")
    }

    // MARK: - A17: the iOS browser sign-in's acceptance cases

    /// Cancelled while `/start` is still in flight: no approval URL is ever
    /// published (so no sheet opens) and nothing is polled.
    func testCancelDuringStartPublishesNoURLAndNeverPolls() async {
        let c = StubDeviceAuth()
        let m = BrowserLoginModel(client: c)
        c.onStart = { [weak m] in await MainActor.run { m?.cancel() } }
        var got: String?
        await m.begin { got = $0 }
        XCTAssertNil(got)
        XCTAssertNil(m.lastApprovalURL, "a cancelled start still published a page to open")
        XCTAssertEqual(c.pollCount, 0)
        XCTAssertEqual(m.state, .idle)
    }

    /// Two logins, one after the other, where the first is still polling when
    /// the second starts: only the NEWER run can bind a token. The older run's
    /// approval arriving late must not land on the screen the newer one owns.
    func testANewerLoginSupersedesAnOlderOnesLateToken() async {
        let c = StubDeviceAuth()
        c.pollScript = [.ok(token: "token", accountEmail: "")]
        let m = BrowserLoginModel(client: c)
        var older: [String] = [], newer: [String] = []
        c.onPoll = { [weak m, weak c] in
            c?.onPoll = nil
            await m?.begin { newer.append($0) }
        }
        await m.begin { older.append($0) }
        XCTAssertEqual(newer, ["token"], "the newer run must complete")
        XCTAssertEqual(older, [], "the superseded run bound a token")
    }

    /// A connection lost mid-wait is a failure with a sentence — never a
    /// silent success and never a hang.
    func testANetworkFailureWhilePollingIsReportedNotSucceeded() async {
        let c = StubDeviceAuth()
        c.pollError = AccountError.network
        let m = BrowserLoginModel(client: c)
        var got: String?
        await m.begin { got = $0 }
        XCTAssertNil(got)
        guard case let .failed(message) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: AccountError.network))
    }

    /// A throttled poll is reported as throttling, not as a denial or expiry.
    func testARateLimitedPollSaysSo() async {
        let c = StubDeviceAuth()
        c.pollError = AccountError.rateLimited
        let m = BrowserLoginModel(client: c)
        await m.begin { _ in }
        XCTAssertEqual(m.state, .failed(ErrorCopy.message(for: AccountError.rateLimited)))
    }

    /// The iOS factory, end to end over the wire: the start request is the
    /// bodyless POST every CLI sends — no `install_id`, no Content-Type — and
    /// the approved token comes back through the same model.
    func testTheIOSFactorySendsNoInstallationHint() async throws {
        StubURLProtocol.reset()
        var startBodies: [[UInt8]] = []
        defer { StubURLProtocol.router = nil; StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.router = { request in
            if request.url?.path == "/api/cli/device/start" {
                startBodies.append(StubURLProtocol.lastBodyBytes)
                return .init(status: 200, body: Data("""
                {"user_code":"WDJB-MJHT","device_code":"dc","verification_uri":"https://relayium.test/device",
                 "interval":0,"expires_in":600}
                """.utf8))
            }
            return .init(status: 200, body: Data(#"{"status":"ok","access_token":"rlm_t","account_email":"a@b.c"}"#.utf8))
        }
        let m = AppEnvironment.makeIOSBrowserLoginModel(baseURL: URL(string: "https://relayium.test")!,
                                                        transport: StubURLProtocol.session())
        var got: String?
        await m.begin { got = $0 }
        XCTAssertEqual(got, "rlm_t")
        XCTAssertEqual(startBodies, [[]], "the iOS start request carried a body")
        let start = try XCTUnwrap(StubURLProtocol.observed.first)
        XCTAssertEqual(start.url?.path, "/api/cli/device/start")
        XCTAssertNil(start.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertEqual(m.lastApprovalURL?.absoluteString, "https://relayium.test/device?code=WDJB-MJHT")
    }
}
