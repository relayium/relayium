import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
import RelayiumShareKit

/// A18: the "forgot password" request — the client call and the model the iOS
/// sheet renders. The reset itself is the website's `/reset-password` page.
@MainActor
final class PasswordResetRequestModelTests: XCTestCase {
    private let base = URL(string: "https://relayium.test")!

    // MARK: - the wire

    func testTheRequestIsTheServersForgotEndpointWithOnlyTheAddress() async throws {
        StubURLProtocol.reset()
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
        try await AccountClient(baseURL: base, session: StubURLProtocol.session())
            .requestPasswordReset(email: "a@b.test")
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/auth/password/forgot")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"),
                     "asking for a reset needs no session and must send none")
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(request))
        XCTAssertEqual(body as NSDictionary, ["email": "a@b.test"] as NSDictionary)
    }

    func testA429IsRateLimitedAndA5xxIsAServerError() async {
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        let client = AccountClient(baseURL: base, session: StubURLProtocol.session())
        StubURLProtocol.stub = .init(status: 429)
        do { try await client.requestPasswordReset(email: "a@b.test"); XCTFail("accepted a 429") }
        catch { XCTAssertEqual(error as? AccountError, .rateLimited) }
        StubURLProtocol.stub = .init(status: 503)
        do { try await client.requestPasswordReset(email: "a@b.test"); XCTFail("accepted a 503") }
        catch { XCTAssertEqual(error as? AccountError, .server(status: 503)) }
    }

    // MARK: - the model

    /// Registered or not, the server answers 200 and the model lands on the
    /// same state for both — the sheet renders one sentence for every address.
    func testEveryAcceptedAddressLandsOnTheSameNonEnumeratingState() async {
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
        let m = AppEnvironment.makePasswordResetRequestModel(baseURL: base,
                                                             transport: StubURLProtocol.session())
        await m.request(email: "  known@b.test ")
        XCTAssertEqual(m.state, .requested(email: "known@b.test"), "the address is trimmed")
        await m.request(email: "nobody@b.test")
        XCTAssertEqual(m.state, .requested(email: "nobody@b.test"))
        // One key, whatever the address: the copy cannot branch on existence.
        let en = L10n.t(.loginResetRequested, [L10n.token("x@y.z")], language: .en)
        XCTAssertTrue(en.hasPrefix("If an account uses"), en)
    }

    func testAnEmptyAddressSendsNothing() async {
        var sent = 0
        let m = PasswordResetRequestModel(send: { _ in sent += 1 })
        await m.request(email: "   ")
        XCTAssertEqual(m.state, .emailMissing)
        XCTAssertEqual(sent, 0)
    }

    /// Tapping again while a request is in flight does not send a second one.
    func testASecondTapWhileSendingIsRefused() async {
        var sent = 0
        var m: PasswordResetRequestModel!
        m = PasswordResetRequestModel(send: { _ in
            sent += 1
            // The second tap, landing mid-flight — once.
            if sent == 1 { await m.request(email: "a@b.test") }
        })
        await m.request(email: "a@b.test")
        XCTAssertEqual(sent, 1)
        XCTAssertEqual(m.state, .requested(email: "a@b.test"))
    }

    /// Throttling is throttling: never the sentence about a wrong password.
    func testThrottlingIsNeverReportedAsAWrongPassword() async {
        let m = PasswordResetRequestModel(send: { _ in throw AccountError.rateLimited })
        await m.request(email: "a@b.test")
        XCTAssertEqual(m.state, .failed(message: ErrorCopy.message(for: AccountError.rateLimited)))
        XCTAssertNotEqual(m.state, .failed(message: ErrorCopy.message(for: AccountError.invalidCredentials)))
    }

    func testAnOutageIsReportedAsAnOutage() async {
        let m = PasswordResetRequestModel(send: { _ in throw AccountError.network })
        await m.request(email: "a@b.test")
        XCTAssertEqual(m.state, .failed(message: ErrorCopy.message(for: AccountError.network)))
    }

    /// The sheet closed mid-request: the late answer writes nothing.
    func testACancelledRequestsLateAnswerIsDiscarded() async {
        var m: PasswordResetRequestModel!
        m = PasswordResetRequestModel(send: { _ in await MainActor.run { m.cancel() } })
        await m.request(email: "a@b.test")
        XCTAssertEqual(m.state, .idle)
    }
}
