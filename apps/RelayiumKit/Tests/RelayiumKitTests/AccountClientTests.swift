import XCTest
@testable import RelayiumKit

final class AccountClientTests: XCTestCase {
    private func client() -> AccountClient {
        AccountClient(baseURL: URL(string: "https://relayium.test")!, session: StubURLProtocol.session())
    }
    private func data(_ name: String) throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: name, withExtension: "json")!)
    }
    override func tearDown() { StubURLProtocol.stub = nil; StubURLProtocol.lastRequest = nil }

    func testLoginSuccess() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try data("login-success"), check: { req in
            XCTAssertEqual(req.url?.path, "/api/auth/native/login")
            XCTAssertEqual(req.httpMethod, "POST")
        })
        let outcome = try await client().login(email: "a@b.co", password: "pw", deviceName: "Mac")
        guard case let .success(token, user) = outcome else { return XCTFail("want success") }
        XCTAssertEqual(token, "rlm_cli_TESTTOKEN")
        XCTAssertEqual(user.email, "a@b.co")
        XCTAssertEqual(user.displayName, "Ada")
    }
    func testLoginInvalidCredentials() async {
        StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"invalid credentials"}"#.utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().login(email: "a@b.co", password: "x", deviceName: "Mac")) {
            XCTAssertEqual($0 as? AccountError, .invalidCredentials)
        }
    }
    func testLoginEmailUnverified() async throws {
        StubURLProtocol.stub = .init(status: 403, body: try data("login-unverified"), check: nil)
        let outcome = try await client().login(email: "a@b.co", password: "pw", deviceName: "Mac")
        XCTAssertEqual(outcome, .emailUnverified(email: "a@b.co"))
    }
    func testLoginPendingDeletion() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try data("login-pending-deletion"), check: nil)
        let outcome = try await client().login(email: "a@b.co", password: "pw", deviceName: "Mac")
        XCTAssertEqual(outcome, .pendingDeletion(purgeAfter: 1_780_000_000, reactivateToken: "react_abc"))
    }
    func testLoginRateLimited() async {
        StubURLProtocol.stub = .init(status: 429, body: Data(#"{"error":"too many"}"#.utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().login(email: "a@b.co", password: "x", deviceName: "Mac")) {
            XCTAssertEqual($0 as? AccountError, .rateLimited)
        }
    }
    func testFetchMeSendsBearerAndDecodes() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try data("me"), check: { req in
            XCTAssertEqual(req.url?.path, "/api/me")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_TESTTOKEN")
        })
        let user = try await client().fetchMe(token: "rlm_cli_TESTTOKEN")
        XCTAssertEqual(user.planId, "pro")
        XCTAssertEqual(user.subscriptionStatus, "active")
    }
    func testFetchUsageSendsBearerAndDecodes() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try data("me-usage"), check: { req in
            XCTAssertEqual(req.url?.path, "/api/me/usage")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_TESTTOKEN")
        })
        let u = try await client().fetchUsage(token: "rlm_cli_TESTTOKEN")
        XCTAssertTrue(u.storage.isUnlimited)
        XCTAssertEqual(u.plan.name, "Pro")
    }
    func testFetchMeUnauthorizedThrows() async {
        StubURLProtocol.stub = .init(status: 401, body: Data("unauthorized".utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().fetchMe(token: "bad")) {
            XCTAssertEqual($0 as? AccountError, .invalidCredentials)
        }
    }

    // MARK: - registration
    //
    // The wire contract of `POST /api/auth/register`, one test per documented
    // answer. The 200 is the only one that means an account exists; every other
    // arm is a different thing for the user to do next, which is why they are
    // distinct errors rather than one `.server(status:)`.

    func testRegisterSendsTheThreeFieldsAndReturnsTheNormalizedEmail() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(#"{"status":"verification_sent","email":"ada@example.com"}"#.utf8),
            check: { req in
                XCTAssertEqual(req.url?.path, "/api/auth/register")
                XCTAssertEqual(req.httpMethod, "POST")
                XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
                let body = StubURLProtocol.bodyJSON(req)
                XCTAssertEqual(body?["email"] as? String, " Ada@Example.COM ")
                XCTAssertEqual(body?["password"] as? String, "correct horse battery")
                XCTAssertEqual(body?["displayName"] as? String, "Ada")
                XCTAssertEqual(body?.count, 3, "exactly the three documented fields")
            })
        // The typed address goes up as typed; what comes back is the server's
        // normalization, and that is what the check-email screen must name.
        let outcome = try await client().register(email: " Ada@Example.COM ",
                                                  password: "correct horse battery",
                                                  displayName: "Ada")
        XCTAssertEqual(outcome, RegistrationOutcome(email: "ada@example.com"))
    }

    /// A server that stops sending `email` must not leave the check-email screen
    /// naming no mailbox at all.
    func testRegisterFallsBackToTheTypedAddressWhenTheBodyOmitsIt() async throws {
        StubURLProtocol.stub = .init(status: 200,
                                     body: Data(#"{"status":"verification_sent"}"#.utf8),
                                     check: nil)
        let outcome = try await client().register(email: "a@b.co", password: "pw12345678",
                                                  displayName: "")
        XCTAssertEqual(outcome.email, "a@b.co")
    }

    /// 200 alone does not mean an account was created. A body that is not the
    /// documented one is a response this version does not understand.
    func testRegisterRejectsA200ThatIsNotVerificationSent() async {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"status":"ok"}"#.utf8), check: nil)
        await XCTAssertThrowsErrorAsync(
            try await self.client().register(email: "a@b.co", password: "pw12345678",
                                             displayName: "")) {
            XCTAssertEqual($0 as? AccountError, .decoding)
        }
    }

    func testRegisterMapsEveryDocumentedRefusal() async {
        let cases: [(status: Int, body: String, want: AccountError)] = [
            (400, #"{"error":"invalid_email"}"#, .emailInvalid),
            (400, #"{"error":"password too short"}"#, .passwordTooShort),
            (409, #"{"error":"email already registered"}"#, .emailTaken),
            (409, #"{"error":"account_pending_deletion","hint":"…"}"#, .accountPendingDeletion),
            (429, #"{"error":"too many requests"}"#, .rateLimited),
            // Not one of the documented bodies: the status is all that is known,
            // and guessing a reason for it would put a wrong remedy on screen.
            (400, "bad request", .server(status: 400)),
            (409, #"{"error":"something new"}"#, .server(status: 409)),
            (500, "server error", .server(status: 500)),
        ]
        for c in cases {
            StubURLProtocol.stub = .init(status: c.status, body: Data(c.body.utf8), check: nil)
            await XCTAssertThrowsErrorAsync(
                try await self.client().register(email: "a@b.co", password: "pw12345678",
                                                 displayName: "")) {
                XCTAssertEqual($0 as? AccountError, c.want, "\(c.status) \(c.body)")
            }
        }
    }

    // MARK: - resending the verification email

    func testResendSendsOnlyTheAddress() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8),
                                     check: { req in
            XCTAssertEqual(req.url?.path, "/api/auth/email/resend")
            XCTAssertEqual(req.httpMethod, "POST")
            let body = StubURLProtocol.bodyJSON(req)
            XCTAssertEqual(body?["email"] as? String, "a@b.co")
            XCTAssertEqual(body?.count, 1, "no password, no token — the address only")
            XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"),
                         "an unverified account has no bearer to present")
        })
        try await client().resendVerification(email: "a@b.co")
    }

    /// The endpoint answers 200 whether or not it sent anything, so anything
    /// else came from the transport or from something in front of the server —
    /// and that is worth reporting.
    func testResendReportsATransportOrProxyFailure() async {
        StubURLProtocol.stub = .init(status: 502, body: Data("bad gateway".utf8), check: nil)
        await XCTAssertThrowsErrorAsync(
            try await self.client().resendVerification(email: "a@b.co")) {
            XCTAssertEqual($0 as? AccountError, .server(status: 502))
        }
        StubURLProtocol.stub = .init(status: 429, body: Data(), check: nil)
        await XCTAssertThrowsErrorAsync(
            try await self.client().resendVerification(email: "a@b.co")) {
            XCTAssertEqual($0 as? AccountError, .rateLimited)
        }
    }

    func testLogoutSendsBearer() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(), check: { req in
            XCTAssertEqual(req.url?.path, "/api/auth/logout")
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_TESTTOKEN")
        })
        try await client().logout(token: "rlm_cli_TESTTOKEN")
    }
}

/// Small async throwing-assert helper (XCTAssertThrowsError has no async form).
func XCTAssertThrowsErrorAsync<T>(_ expr: @autoclosure () async throws -> T,
                                  _ handler: (Error) -> Void, file: StaticString = #file, line: UInt = #line) async {
    do { _ = try await expr(); XCTFail("expected throw", file: file, line: line) }
    catch { handler(error) }
}
