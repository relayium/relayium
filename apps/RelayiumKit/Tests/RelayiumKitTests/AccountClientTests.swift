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
}

/// Small async throwing-assert helper (XCTAssertThrowsError has no async form).
func XCTAssertThrowsErrorAsync<T>(_ expr: @autoclosure () async throws -> T,
                                  _ handler: (Error) -> Void, file: StaticString = #file, line: UInt = #line) async {
    do { _ = try await expr(); XCTFail("expected throw", file: file, line: line) }
    catch { handler(error) }
}
