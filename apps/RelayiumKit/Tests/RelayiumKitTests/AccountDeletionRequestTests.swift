import XCTest
import RelayiumKit
@testable import RelayiumAppKit

/// Asking the server to email an account-deletion confirmation link.
///
/// Every test here is about the same two things, because they are what the
/// feature can get wrong in a way no screenshot would show:
///
///  1. **It reports only what happened.** The server took a request; nothing
///     was deleted, no email was promised, and the session is untouched. An app
///     that signed out here — or said "deleted" — would be asserting something
///     that has not happened and taking away the credential the user needs if
///     they change their mind before opening the link.
///  2. **A late response cannot repaint a screen that moved on.** The request
///     suspends, and a sign-out or a sign-in as somebody else lands mid-flight
///     routinely. The operation is scoped to a generation, an account id AND
///     the credential, and each of the three is exercised below.
@MainActor
final class AccountDeletionRequestTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: name, withExtension: "json")!)
    }

    private func session(store: TokenStore) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: URL(string: "https://relayium.test")!,
                                  session: StubURLProtocol.session()),
            tokenStore: store,
            deviceName: "Test Device"
        )
    }

    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.router = nil
        StubURLProtocol.lastRequest = nil
    }

    private static let deletePath = "/api/account/delete/request"

    /// A session sitting on a loaded account, which is the only state the
    /// delete action is reachable from. `delete` decides what the deletion
    /// endpoint answers; everything else resolves against the fixtures.
    private func readySession(delete: @escaping () -> StubURLProtocol.Stub)
        throws -> (AccountSession, InMemoryTokenStore) {
        let store = InMemoryTokenStore()
        let me = try fixture("me"), usage = try fixture("me-usage")
        let login = try fixture("login-success")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case Self.deletePath:  return delete()
            case "/api/me":        return .init(status: 200, body: me)
            case "/api/me/usage":  return .init(status: 200, body: usage)
            default:               return .init(status: 200, body: login)
            }
        }
        let s = session(store: store)
        return (s, store)
    }

    private func signIn(_ s: AccountSession) async {
        await s.logIn(email: "a@b.co", password: "pw")
    }

    // MARK: - what a success establishes, and what it does not

    /// The whole contract in one test: the notice says "requested", the account
    /// is still on screen, and the credential is still held — locally and in the
    /// keychain. Nothing about a deletion has happened.
    func testASuccessfulRequestOnlyReportsThatTheServerTookIt() async throws {
        let (s, store) = try readySession { .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8)) }
        await signIn(s)
        guard case let .ready(user, _) = s.state else { return XCTFail("setup: \(s.state)") }

        await s.requestAccountDeletion()

        XCTAssertEqual(s.deletionRequestState, .requested)
        guard case let .ready(after, _) = s.state else {
            return XCTFail("the account must still be on screen, got \(s.state)")
        }
        XCTAssertEqual(after.id, user.id)
        XCTAssertEqual(s.bearerToken, "rlm_cli_TESTTOKEN",
                       "requesting a deletion must not clear the bearer")
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN",
                       "and must not clear the stored credential either")
    }

    /// The request goes out under the credential the session holds, in a header.
    /// A stub that ignores headers would still reach `.requested`, so the header
    /// is asserted rather than the outcome.
    func testTheRequestCarriesTheSessionsOwnBearer() async throws {
        let (s, _) = try readySession { .init(status: 200, body: Data()) }
        await signIn(s)
        StubURLProtocol.lastRequest = nil

        await s.requestAccountDeletion()

        XCTAssertEqual(StubURLProtocol.lastRequest?.url?.path, Self.deletePath)
        XCTAssertEqual(StubURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"),
                       "Bearer rlm_cli_TESTTOKEN")
    }

    /// A refused request is retryable and costs nothing: the account is
    /// untouched, the credential is untouched, and the sentence is real copy
    /// rather than a type name.
    func testAFailedRequestIsReportedAndLeavesTheSessionIntact() async throws {
        let (s, store) = try readySession { .init(status: 503, body: Data()) }
        await signIn(s)

        await s.requestAccountDeletion()

        XCTAssertEqual(s.deletionRequestState,
                       .failed(message: ErrorCopy.message(for: AccountError.server(status: 503))))
        guard case .ready = s.state else { return XCTFail("still ready, got \(s.state)") }
        XCTAssertEqual(s.bearerToken, "rlm_cli_TESTTOKEN")
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN")
    }

    /// A 401 is the one failure that could plausibly be read as "sign this user
    /// out", and it must not be. The bearer was revoked elsewhere; the user is
    /// told so and keeps the screen, because this path may not end a session.
    ///
    /// The sentence is the bearer-specific one, not `ErrorCopy`'s
    /// invalid-credentials copy — that one is about an email and a password,
    /// neither of which was involved.
    func testARejectedBearerIsReportedWithoutSigningTheUserOut() async throws {
        let (s, store) = try readySession { .init(status: 401, body: Data("unauthorized".utf8)) }
        await signIn(s)

        await s.requestAccountDeletion()

        XCTAssertEqual(s.deletionRequestState, .failed(message: L10n.t(.accountBearerInvalid)))
        XCTAssertNotEqual(s.deletionRequestState,
                          .failed(message: ErrorCopy.message(for: AccountError.invalidCredentials)))
        guard case .ready = s.state else { return XCTFail("must stay on the account: \(s.state)") }
        XCTAssertEqual(s.bearerToken, "rlm_cli_TESTTOKEN")
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN")
    }

    // MARK: - who may ask

    /// A tap that arrives when no account is loaded sends nothing — and, just as
    /// importantly, does not claim the shared operation generation, which would
    /// supersede whatever replaced the screen it came from.
    func testARequestWithNoAccountOnScreenSendsNothing() async {
        StubURLProtocol.reset()
        StubURLProtocol.router = { _ in
            XCTFail("a request with no account must not reach the transport")
            return .init(status: 500)
        }
        let s = session(store: InMemoryTokenStore())
        await s.restore()
        XCTAssertEqual(s.state, .loggedOut)

        await s.requestAccountDeletion()

        XCTAssertEqual(s.deletionRequestState, .idle)
        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
        StubURLProtocol.reset()
    }

    /// No second request while one is in flight. The endpoint throttles per
    /// account anyway, so a queued second press would buy nothing and could turn
    /// a "requested" into a silently swallowed one.
    func testASecondRequestWhileOneIsInFlightIsRefused() async throws {
        let gate = RequestGate()
        let (s, _) = try readySession {
            gate.hold()
            return .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
        }
        await signIn(s)
        StubURLProtocol.reset()

        let first = Task { await s.requestAccountDeletion() }
        await gate.reached()
        await s.requestAccountDeletion()     // the impatient second press
        gate.release()
        await first.value

        XCTAssertEqual(StubURLProtocol.requestCount, 1,
                       "exactly one request reached the transport")
        XCTAssertEqual(s.deletionRequestState, .requested)
        StubURLProtocol.reset()
    }

    // MARK: - a late response may not repaint the screen

    /// The adversarial case for a sign-out: the response lands AFTER the user
    /// signed out. Writing "we've emailed you a confirmation link" onto a
    /// sign-in form would be a claim about an account nobody is looking at.
    func testALateResponseCannotWriteOntoASignedOutSession() async throws {
        let gate = RequestGate()
        let store = InMemoryTokenStore()
        let me = try fixture("me"), usage = try fixture("me-usage")
        let login = try fixture("login-success")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case Self.deletePath:
                gate.hold()
                return .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
            case "/api/me":          return .init(status: 200, body: me)
            case "/api/me/usage":    return .init(status: 200, body: usage)
            case "/api/auth/logout": return .init(status: 200, body: Data())
            default:                 return .init(status: 200, body: login)
            }
        }
        let s = session(store: store)
        await signIn(s)
        guard case .ready = s.state else { return XCTFail("setup: \(s.state)") }

        let requesting = Task { await s.requestAccountDeletion() }
        await gate.reached()
        let signingOut = Task { await s.logOut() }
        await Task.yield()          // let the sign-out claim the newer generation
        gate.release()
        await signingOut.value
        await requesting.value

        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertEqual(s.deletionRequestState, .idle,
                       "a notice about a signed-out account must not survive it")
        XCTAssertNil(s.bearerToken)
        XCTAssertNil(try store.load())
    }

    /// And the sharper one: the response lands after a sign-in as SOMEBODY ELSE.
    /// The generation guard already catches this; the account-id and token
    /// checks are the belt to its braces, because the failure they prevent is
    /// the worst one this screen has — a deletion notice attached to the wrong
    /// account, on a screen showing that account's name.
    func testALateResponseCannotWriteOntoADifferentAccount() async throws {
        let gate = RequestGate()
        let usage = try fixture("me-usage")
        let firstUser = try fixture("me")
        let secondUser = Data(#"""
        { "user": { "id":"u_2","email":"bea@example.com","displayName":"Bea","hasPassword":true,
          "emailVerified":true,"linkedMethods":["password"],"onlyOwnNodes":false,"planId":"pro",
          "subscriptionStatus":"active","subscriptionEnd":1790000000,"hasBilling":true,
          "scheduledPlanId":"","scheduledCycle":"","billingCycle":"monthly" } }
        """#.utf8)
        let firstLogin = try fixture("login-success")
        let secondLogin = Data(#"""
        { "token": "rlm_cli_SECOND", "user": { "id":"u_2","email":"bea@example.com",
          "displayName":"Bea","hasPassword":true,"emailVerified":true,
          "linkedMethods":["password"] } }
        """#.utf8)

        // Which account /api/me answers for is flipped between the two sign-ins,
        // so the second one really lands as a different user.
        let whoami = AtomicBox(firstUser)
        let credential = AtomicBox(firstLogin)
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case Self.deletePath:
                gate.hold()
                return .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
            case "/api/me":       return .init(status: 200, body: whoami.value)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:              return .init(status: 200, body: credential.value)
            }
        }
        let s = session(store: InMemoryTokenStore())
        await signIn(s)
        guard case let .ready(first, _) = s.state, first.id == "u_1" else {
            return XCTFail("setup: \(s.state)")
        }

        let requesting = Task { await s.requestAccountDeletion() }
        await gate.reached()
        whoami.value = secondUser
        credential.value = secondLogin
        let signingIn = Task { await s.logIn(email: "bea@example.com", password: "pw") }
        await Task.yield()          // let the sign-in claim the newer generation
        gate.release()
        await signingIn.value
        await requesting.value

        guard case let .ready(second, _) = s.state else {
            return XCTFail("the second account should be on screen, got \(s.state)")
        }
        XCTAssertEqual(second.id, "u_2")
        XCTAssertEqual(s.bearerToken, "rlm_cli_SECOND")
        XCTAssertEqual(s.deletionRequestState, .idle,
                       "the first account's request must not paint a notice on the second's screen")
    }

    /// The simple half of the same rule: any session-moving operation clears a
    /// settled notice, so it cannot outlive the account it was about.
    func testEverySessionMovingOperationClearsTheNotice() async throws {
        let (s, _) = try readySession { .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8)) }
        await signIn(s)
        await s.requestAccountDeletion()
        XCTAssertEqual(s.deletionRequestState, .requested)

        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/logout": return .init(status: 200, body: Data())
            default:                 return .init(status: 401, body: Data(#"{"error":"nope"}"#.utf8))
            }
        }
        await s.logOut()
        XCTAssertEqual(s.deletionRequestState, .idle)
        XCTAssertEqual(s.state, .loggedOut)
    }

    /// Nothing about this operation may reach a URL: not the bearer, not the
    /// address. The token is a credential and the address is personal data, and
    /// a URL is the one place both would end up in an access log.
    func testNothingAboutTheRequestReachesAURL() async throws {
        let (s, _) = try readySession { .init(status: 200, body: Data()) }
        await signIn(s)
        StubURLProtocol.reset()

        await s.requestAccountDeletion()

        XCTAssertGreaterThan(StubURLProtocol.observed.count, 0, "nothing was sent")
        for request in StubURLProtocol.observed {
            let url = request.url?.absoluteString ?? ""
            XCTAssertFalse(url.contains("rlm_cli"), url)
            XCTAssertFalse(url.contains("a@b.co"), url)
            XCTAssertNil(URLComponents(string: url)?.query, url)
        }
        StubURLProtocol.reset()
    }
}

/// A value the stub router reads from a background queue while the test mutates
/// it from the main actor. `nonisolated(unsafe)` in the same spirit as
/// `StubURLProtocol`'s own statics: the writes happen while the router is parked
/// in `RequestGate.hold()`, so there is no concurrent access to order.
final class AtomicBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: T
    init(_ value: T) { stored = value }
    var value: T {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}
