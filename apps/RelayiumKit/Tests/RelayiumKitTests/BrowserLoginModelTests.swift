import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private final class StubDeviceAuth: DeviceAuthClient, @unchecked Sendable {
    var startResult = DeviceAuthStart(userCode: "AAAA-BBBB", deviceCode: "dc",
                                      verificationURL: URL(string: "https://x.test/device")!,
                                      interval: 0, expiresIn: 600)
    var startError: Error?
    /// Consumed in order; the last entry repeats.
    var pollScript: [DevicePollOutcome] = [.ok(token: "rlm_cli_t", accountEmail: "a@b.c")]
    private(set) var pollCount = 0
    /// Runs inside the awaited poll, so a test can land an event mid-flight.
    var onPoll: (() async -> Void)?

    func start() async throws -> DeviceAuthStart {
        if let e = startError { throw e }
        return startResult
    }

    func poll(deviceCode: String) async throws -> DevicePollOutcome {
        await onPoll?()
        defer { pollCount += 1 }
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
}
