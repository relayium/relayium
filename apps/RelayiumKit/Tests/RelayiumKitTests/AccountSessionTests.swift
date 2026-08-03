import XCTest
import Combine
import RelayiumKit
@testable import RelayiumAppKit

@MainActor
final class AccountSessionTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: name, withExtension: "json")!)
    }
    private func session(store: TokenStore) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: URL(string: "https://relayium.test")!,
                                  session: StubURLProtocol.session()),
            tokenStore: store,
            deviceName: "Test Mac"
        )
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.router = nil
        StubURLProtocol.lastRequest = nil
    }

    /// Routes /api/me and /api/me/usage to their fixtures, everything else to login.
    private func routeLoggedIn(loginBody: Data) throws {
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:              return .init(status: 200, body: loginBody)
            }
        }
    }

    func testEmptyStoreGoesToLoggedOutWithoutANetworkCall() async {
        let s = session(store: InMemoryTokenStore())
        StubURLProtocol.router = { _ in XCTFail("must not call the network"); return .init(status: 500) }
        await s.restore()
        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertNil(StubURLProtocol.lastRequest)
    }

    func testSuccessfulLoginSavesTokenAndLandsReady() async throws {
        let store = InMemoryTokenStore()
        try routeLoggedIn(loginBody: try fixture("login-success"))
        let s = session(store: store)
        await s.logIn(email: "a@b.co", password: "pw")
        guard case let .ready(user, usage) = s.state else { return XCTFail("want ready, got \(s.state)") }
        XCTAssertEqual(user.planId, "pro")          // from /api/me — NOT from the login body
        XCTAssertEqual(usage.plan.name, "Pro")
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN")
    }

    /// A token obtained out of band — the browser login's device flow — must
    /// reach exactly the state a password login reaches: same fetch, same
    /// keychain write, same .ready.
    func testAdoptBearerReachesReadyAndPersists() async throws {
        let store = InMemoryTokenStore()
        try routeLoggedIn(loginBody: Data())     // the login body is never used here
        let s = session(store: store)
        await s.adoptBearer("rlm_cli_ADOPTED")
        guard case let .ready(user, usage) = s.state else { return XCTFail("want ready, got \(s.state)") }
        XCTAssertEqual(user.planId, "pro")       // proves /api/me ran, not the token alone
        XCTAssertEqual(usage.plan.name, "Pro")
        XCTAssertEqual(try store.load(), "rlm_cli_ADOPTED")
    }

    /// The adopted token must actually authenticate the follow-up fetch. Sending
    /// the wrong one (or none) would still reach .ready in a stub that ignores
    /// headers, so assert the header rather than the outcome.
    func testAdoptBearerUsesTheAdoptedTokenForTheFetch() async throws {
        try routeLoggedIn(loginBody: Data())
        let s = session(store: InMemoryTokenStore())
        await s.adoptBearer("rlm_cli_HEADERCHECK")
        XCTAssertEqual(StubURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"),
                       "Bearer rlm_cli_HEADERCHECK")
    }

    /// An unusable token must not leave the app looking signed in. The keychain
    /// write happens first by design, so restore() would resurrect it — this is
    /// the case that decides whether that matters.
    func testAdoptBearerWithARejectedTokenDoesNotLandReady() async {
        StubURLProtocol.router = { _ in .init(status: 401, body: Data("unauthorized".utf8)) }
        let s = session(store: InMemoryTokenStore())
        await s.adoptBearer("rlm_cli_STALE")
        if case .ready = s.state { XCTFail("a rejected token reached .ready") }
    }

    // 200 does not mean signed in. These two are the other halves of that.
    func testEmailUnverifiedIsItsOwnState() async throws {
        StubURLProtocol.stub = .init(status: 403, body: try fixture("login-unverified"))
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "a@b.co", password: "pw")
        XCTAssertEqual(s.state, .emailUnverified(email: "a@b.co"))
    }
    func testPendingDeletionIsItsOwnState() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try fixture("login-pending-deletion"))
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "a@b.co", password: "pw")
        XCTAssertEqual(s.state, .pendingDeletion(purgeAfter: 1_780_000_000, reactivateToken: "react_abc"))
    }
    func testPendingDeletionStoresNoToken() async throws {
        let store = InMemoryTokenStore()
        StubURLProtocol.stub = .init(status: 200, body: try fixture("login-pending-deletion"))
        await session(store: store).logIn(email: "a@b.co", password: "pw")
        XCTAssertNil(try store.load())
    }

    func testBadCredentialsSurfaceCopyNotATypeName() async {
        StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"nope"}"#.utf8))
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "a@b.co", password: "wrong")
        guard case let .failed(message) = s.state else { return XCTFail("want failed, got \(s.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: AccountError.invalidCredentials))
    }

    // The only signal a stored token has gone bad.
    func testStaleTokenIsClearedAndRoutesToLoggedOut() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_STALE")
        StubURLProtocol.router = { _ in .init(status: 401, body: Data("unauthorized".utf8)) }
        let s = session(store: store)
        await s.restore()
        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertNil(try store.load(), "a 401 must clear the keychain")
    }

    func testRestoreWithGoodTokenLandsReady() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        try routeLoggedIn(loginBody: Data())
        let s = session(store: store)
        await s.restore()
        guard case .ready = s.state else { return XCTFail("want ready, got \(s.state)") }
    }

    // A network blip must not blank a working screen, and must not bounce the user
    // to a login form that would not help.
    func testNetworkFailureDuringRefreshKeepsLastGoodAndMarksStale() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        try routeLoggedIn(loginBody: Data())
        let s = session(store: store)
        await s.restore()
        guard case .ready = s.state else { return XCTFail("setup failed") }

        StubURLProtocol.router = { _ in .init(status: 503, body: Data()) }
        await s.refresh()
        // Bound and checked against the fixture's identifying fields, not just the
        // case: proves the *same* last-known-good data survived rather than the
        // state being torn down and rebuilt with something else (e.g. defaults).
        guard case let .ready(user, usage) = s.state else { return XCTFail("must keep last-known-good, got \(s.state)") }
        XCTAssertEqual(user.planId, "pro")
        XCTAssertEqual(usage.plan.name, "Pro")
        XCTAssertTrue(s.isStale)
        XCTAssertNotNil(try store.load(), "a 503 is not a bad token — keep it")
    }

    // A token we still hold plus a server that is down is not a credentials problem.
    // Bouncing to a sign-in form would ask the user to fix something that is not broken.
    func testRestoreFailureIsUnavailableNotFailed() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        StubURLProtocol.router = { _ in .init(status: 503, body: Data()) }
        let s = session(store: store)
        await s.restore()
        guard case let .unavailable(message) = s.state else { return XCTFail("want unavailable, got \(s.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: AccountError.server(status: 503)))
        XCTAssertNotNil(try store.load(), "a 503 is not a bad token — keep it")
    }

    func testLogOutClearsTokenAndState() async throws {
        let store = InMemoryTokenStore()
        try routeLoggedIn(loginBody: try fixture("login-success"))
        let s = session(store: store)
        await s.logIn(email: "a@b.co", password: "pw")
        await s.logOut()
        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertFalse(s.isStale)
        XCTAssertNil(try store.load())
    }

    // A freshly issued token is a token in hand, not a rejected sign-in: a down
    // server here must offer retry, not bounce the user back to the login form
    // they just successfully filled out.
    func testLoginSucceedsButAccountFetchFailsIsUnavailableNotFailed() async throws {
        let store = InMemoryTokenStore()
        let loginBody = try fixture("login-success")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me": return .init(status: 503, body: Data())
            default:        return .init(status: 200, body: loginBody)
            }
        }
        let s = session(store: store)
        await s.logIn(email: "a@b.co", password: "pw")
        guard case let .unavailable(message) = s.state else { return XCTFail("want unavailable, got \(s.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: AccountError.server(status: 503)))
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN", "a freshly issued token must be kept, not cleared")
    }

    // A save() failure (locked keychain, failing SecItemAdd) must not be able to
    // sign a working session out from under it on the next refresh just because
    // the store comes back empty.
    func testSwallowedSaveErrorDoesNotCauseFalseLogoutOnRefresh() async throws {
        let store = FailingSaveTokenStore()
        try routeLoggedIn(loginBody: try fixture("login-success"))
        let s = session(store: store)
        await s.logIn(email: "a@b.co", password: "pw")
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }
        XCTAssertNil(try store.load(), "save() failed, so the store never actually held the token")

        await s.refresh()
        guard case .ready = s.state else { return XCTFail("must stay ready, got \(s.state)") }
        XCTAssertNotNil(s.bearerToken, "the live session must still hold a usable bearer")
    }

    // Same defect as above, but for restore() specifically: closing and reopening
    // the window on macOS recreates ContentView, which re-runs `.task { restore() }`.
    // If save() had silently failed, a naive restore() that always re-reads the
    // store would find nothing and drop a live session to .loggedOut even though
    // sessionToken is still held in memory. restore() must prefer the in-memory
    // token first, exactly like refresh() already does.
    func testSwallowedSaveErrorDoesNotCauseFalseLogoutOnRestore() async throws {
        let store = FailingSaveTokenStore()
        try routeLoggedIn(loginBody: try fixture("login-success"))
        let s = session(store: store)
        await s.logIn(email: "a@b.co", password: "pw")
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }
        XCTAssertNil(try store.load(), "save() failed, so the store never actually held the token")

        await s.restore()
        guard case .ready = s.state else { return XCTFail("must stay ready, got \(s.state)") }
        XCTAssertNotNil(s.bearerToken, "the live session must still hold a usable bearer")
    }

    // MARK: - Registration
    //
    // Creating an account issues NO credential: the only success is the
    // check-email state, and every assertion below is about not pretending
    // otherwise.

    func testRegisterLandsOnCheckEmailWithTheServersAddress() async throws {
        let store = InMemoryTokenStore()
        StubURLProtocol.stub = .init(status: 200, body: registeredBody)
        let s = session(store: store)
        await s.register(email: " Ada@Example.COM ", password: "correct horse battery",
                         displayName: "Ada")
        XCTAssertEqual(s.state, .emailUnverified(email: "ada@example.com"),
                       "the check-email screen must name the address the account was created under")
        XCTAssertNil(try store.load(), "registration issues no token — there is nothing to store")
        XCTAssertNil(s.bearerToken)
        XCTAssertEqual(s.resendState, .idle)
    }

    /// It must never reach `.ready`, and must never try: the account cannot
    /// authenticate anything until the email is verified.
    func testRegisterNeverFetchesTheAccount() async throws {
        StubURLProtocol.router = { req in
            if req.url?.path != "/api/auth/register" {
                XCTFail("registration must not call \(req.url?.path ?? "?")")
            }
            return .init(status: 200, body: registeredBody)
        }
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        guard case .emailUnverified = s.state else { return XCTFail("got \(s.state)") }
    }

    /// A refused registration belongs back on the form with the server's reason
    /// — never `.unavailable`, which offers a retry for something a retry cannot
    /// fix, and never `.loggedOut`, which would silently discard the reason.
    func testRegisterRejectionSurfacesTheReasonOnTheForm() async {
        StubURLProtocol.stub = .init(status: 409,
                                     body: Data(#"{"error":"email already registered"}"#.utf8))
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        XCTAssertEqual(s.state, .failed(message: ErrorCopy.message(for: AccountError.emailTaken)))
    }

    /// Switching between the two halves of the one form must not carry a
    /// rejection from the old half with it. The state change stays inside the
    /// form-owning set, so SwiftUI keeps the draft and mode alive.
    func testDismissingAnAccessErrorReturnsToTheSameFormWithoutANetworkCall() async {
        StubURLProtocol.stub = .init(status: 409,
                                     body: Data(#"{"error":"email already registered"}"#.utf8))
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        guard case .failed = s.state else { return XCTFail("setup failed, got \(s.state)") }

        StubURLProtocol.reset()
        StubURLProtocol.router = { _ in
            XCTFail("dismissing copy must not call the network")
            return .init(status: 500)
        }
        s.dismissAccountAccessError()

        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
    }

    /// A sign-out that lands while a registration is in flight wins, exactly as
    /// it does for a sign-in: the late completion must not put a check-email
    /// screen on top of a form the user went back to.
    func testSignOutDuringAnInFlightRegistrationWins() async throws {
        let gate = RequestGate()
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/register": gate.hold(); return .init(status: 200, body: registeredBody)
            default:                   return .init(status: 200, body: Data())
            }
        }
        let s = session(store: InMemoryTokenStore())
        let registering = Task {
            await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        }
        await gate.reached()
        let loggingOut = Task { await s.logOut() }
        await Task.yield()
        gate.release()
        await loggingOut.value
        await registering.value

        XCTAssertEqual(s.state, .loggedOut,
                       "a registration that finished after sign-out must not take the screen")
    }

    /// The other interleaving: a second registration (or a sign-in) started
    /// while the first is in flight. The last one to start is the only one
    /// allowed to finish.
    func testAStaleRegistrationCannotOverwriteANewerOne() async throws {
        StubURLProtocol.reset()
        let gate = RequestGate()
        // Keyed on the transport's own counter rather than on a captured `var`:
        // the router runs on URLSession's thread, and a mutable capture there
        // would be the data race this suite exists to avoid staging.
        StubURLProtocol.router = { _ in
            guard StubURLProtocol.requestCount == 1 else {
                return .init(status: 200, body: registeredBody)
            }
            gate.hold()
            return .init(status: 409, body: Data(#"{"error":"email already registered"}"#.utf8))
        }
        let s = session(store: InMemoryTokenStore())
        let first = Task { await s.register(email: "a@b.co", password: "pw12345678", displayName: "") }
        await gate.reached()
        let second = Task { await s.register(email: "c@d.co", password: "pw12345678", displayName: "") }
        await Task.yield()
        gate.release()
        await second.value
        await first.value

        XCTAssertEqual(s.state, .emailUnverified(email: "ada@example.com"),
                       "the superseded attempt's rejection must not land on top")
        StubURLProtocol.reset()
    }

    /// A new window opening mid-registration must not restart from the (still
    /// empty) keychain: that would abort the registration and drop the user on
    /// the form, which is the same defect `restore()` already guards for a
    /// sign-in.
    func testRestoreDuringAnInFlightRegistrationDoesNotAbortIt() async throws {
        let gate = RequestGate()
        StubURLProtocol.router = { req in
            gate.hold(); return .init(status: 200, body: registeredBody)
        }
        let s = session(store: InMemoryTokenStore())
        let registering = Task {
            await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        }
        await gate.reached()
        await s.restore()
        gate.release()
        await registering.value

        XCTAssertEqual(s.state, .emailUnverified(email: "ada@example.com"))
    }

    /// The check-email screen holds an address and a resend action that nothing
    /// else can reproduce — the keychain certainly cannot. Reopening a window
    /// over it must leave it alone; the way out is the explicit "Back to sign
    /// in", which signs out.
    func testRestoreDoesNotDiscardTheCheckEmailScreen() async throws {
        StubURLProtocol.stub = .init(status: 200, body: registeredBody)
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        guard case .emailUnverified = s.state else { return XCTFail("setup failed, got \(s.state)") }

        StubURLProtocol.router = { _ in XCTFail("must not call the network"); return .init(status: 500) }
        await s.restore()
        XCTAssertEqual(s.state, .emailUnverified(email: "ada@example.com"))
    }

    /// Same rule for the reactivation notice, and for a sharper reason: it
    /// carries the one token that can undo a deletion, and a cold restore would
    /// throw it away.
    func testRestoreDoesNotDiscardThePendingDeletionNotice() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try fixture("login-pending-deletion"))
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "a@b.co", password: "pw")
        guard case .pendingDeletion = s.state else { return XCTFail("setup failed, got \(s.state)") }

        await s.restore()
        XCTAssertEqual(s.state, .pendingDeletion(purgeAfter: 1_780_000_000,
                                                 reactivateToken: "react_abc"))
    }

    // MARK: - Resending the verification email

    func testResendReportsWhatTheServerAccepted() async throws {
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/email/resend": return .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
            default:                       return .init(status: 200, body: registeredBody)
            }
        }
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        await s.resendVerification(email: "ada@example.com")

        XCTAssertEqual(s.resendState, .requested)
        XCTAssertEqual(s.state, .emailUnverified(email: "ada@example.com"),
                       "asking about the screen must not replace the screen")
    }

    func testResendFailureIsReportedAndLeavesTheScreenIntact() async throws {
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/email/resend": return .init(status: 503, body: Data())
            default:                       return .init(status: 200, body: registeredBody)
            }
        }
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        await s.resendVerification(email: "ada@example.com")

        XCTAssertEqual(s.resendState,
                       .failed(message: ErrorCopy.message(for: AccountError.server(status: 503))))
        XCTAssertEqual(s.state, .emailUnverified(email: "ada@example.com"))
    }

    /// No second request while one is in flight. The endpoint throttles per
    /// address anyway, so a queued second press would buy nothing and turn a
    /// "requested" into a silently swallowed one.
    func testASecondResendWhileOneIsInFlightIsRefused() async throws {
        StubURLProtocol.stub = .init(status: 200, body: registeredBody)
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        guard case .emailUnverified = s.state else { return XCTFail("setup failed, got \(s.state)") }

        StubURLProtocol.reset()
        let gate = RequestGate()
        StubURLProtocol.router = { _ in gate.hold(); return .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8)) }

        let first = Task { await s.resendVerification(email: "ada@example.com") }
        await gate.reached()
        await s.resendVerification(email: "ada@example.com")   // the impatient second press
        gate.release()
        await first.value

        XCTAssertEqual(StubURLProtocol.requestCount, 1, "exactly one request reached the transport")
        XCTAssertEqual(s.resendState, .requested)
        StubURLProtocol.reset()
    }

    /// A resend that completes after the user has left the screen must write
    /// nothing: "Sent" on a sign-in form is a claim about an email nobody there
    /// asked for.
    func testALateResendCannotWriteOntoAScreenThatMovedOn() async throws {
        StubURLProtocol.stub = .init(status: 200, body: registeredBody)
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        guard case .emailUnverified = s.state else { return XCTFail("setup failed, got \(s.state)") }

        let gate = RequestGate()
        StubURLProtocol.stub = nil
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/logout": return .init(status: 200, body: Data())
            default:                 gate.hold(); return .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
            }
        }
        let resending = Task { await s.resendVerification(email: "ada@example.com") }
        await gate.reached()
        let loggingOut = Task { await s.logOut() }
        await Task.yield()
        gate.release()
        await loggingOut.value
        await resending.value

        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertEqual(s.resendState, .idle, "the notice must not survive the screen it was about")
    }

    /// A callback from a check-email screen that is no longer current has no
    /// authority to send mail — and, just as importantly, no authority to claim
    /// the shared generation and supersede the operation that replaced it.
    func testAStaleResendForTheWrongStateOrAddressDoesNothing() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.router = { _ in
            XCTFail("a stale resend must not reach the transport")
            return .init(status: 500)
        }
        let s = session(store: InMemoryTokenStore())

        await s.resendVerification(email: "old@example.com")
        XCTAssertEqual(s.state, .restoring)
        XCTAssertEqual(s.resendState, .idle)
        XCTAssertEqual(StubURLProtocol.requestCount, 0)

        StubURLProtocol.router = { _ in .init(status: 200, body: registeredBody) }
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        StubURLProtocol.reset()
        StubURLProtocol.router = { _ in
            XCTFail("an address from an older screen must not be used")
            return .init(status: 500)
        }
        await s.resendVerification(email: "old@example.com")
        XCTAssertEqual(s.state, .emailUnverified(email: "ada@example.com"))
        XCTAssertEqual(s.resendState, .idle)
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
    }

    /// And the simple half: any session-moving operation clears a stale notice.
    func testEverySessionOperationClearsTheResendNotice() async throws {
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/email/resend": return .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
            default:                       return .init(status: 200, body: registeredBody)
            }
        }
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        await s.resendVerification(email: "ada@example.com")
        XCTAssertEqual(s.resendState, .requested)

        StubURLProtocol.stub = nil
        StubURLProtocol.router = { _ in .init(status: 401, body: Data(#"{"error":"nope"}"#.utf8)) }
        await s.logIn(email: "a@b.co", password: "wrong")
        XCTAssertEqual(s.resendState, .idle)
    }

    /// The registration password and address ride in the POST body, exactly as
    /// the login credentials do. Either one in a URL would reach every proxy
    /// log, the server's access log, and any `Referer` that followed.
    func testRegistrationCredentialsNeverAppearInARequestURL() async throws {
        let recorder = URLRecorder()
        StubURLProtocol.router = { req in
            recorder.record(req.url)
            return .init(status: 200, body: registeredBody)
        }
        let s = session(store: InMemoryTokenStore())
        await s.register(email: "person@example.com", password: "hunter2-correct-horse",
                         displayName: "Ada Lovelace")
        guard case .emailUnverified = s.state else { return XCTFail("setup failed, got \(s.state)") }

        XCTAssertFalse(recorder.urls.isEmpty, "nothing was sent — the test proves nothing")
        for url in recorder.urls {
            XCTAssertFalse(url.contains("hunter2"), url)
            XCTAssertFalse(url.contains("person@example.com"), url)
            XCTAssertFalse(url.contains("Ada"), url)
            XCTAssertNil(URLComponents(string: url)?.query, url)
        }
    }

    // MARK: - Operation identity
    //
    // Being @MainActor serializes each step, not each operation: `logOut()` and
    // a load both suspend, so a sign-out lands
    // *between* a load's awaits whenever the server is slow — which is exactly
    // when the user reaches for Sign out. These are the interleavings; the
    // `RequestGate` below holds a response open so they are deterministic.

    func testSignOutDuringAnInFlightRefreshStaysSignedOut() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        try routeLoggedIn(loginBody: Data())
        let s = session(store: store)
        await s.restore()
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }

        let gate = RequestGate()
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       gate.hold(); return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            case "/api/auth/logout": return .init(status: 200, body: Data())
            default:              return .init(status: 500)
            }
        }
        let refreshing = Task { await s.refresh() }
        await gate.reached()
        let loggingOut = Task { await s.logOut() } // user signs out while refresh is in flight
        await Task.yield()        // let logout claim the newer operation generation
        gate.release()
        await loggingOut.value
        await refreshing.value

        XCTAssertEqual(s.state, .loggedOut, "a completed refresh must not undo an explicit sign-out")
        XCTAssertFalse(s.isStale)
        XCTAssertNil(try store.load())
    }

    func testSignOutDuringAnInFlightLoginNeverLandsReady() async throws {
        let store = InMemoryTokenStore()
        let loginBody = try fixture("login-success")
        let me = try fixture("me"), usage = try fixture("me-usage")
        let gate = RequestGate()
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:              gate.hold(); return .init(status: 200, body: loginBody)
            }
        }
        let s = session(store: store)
        let signingIn = Task { await s.logIn(email: "a@b.co", password: "pw") }
        await gate.reached()
        await s.logOut()
        gate.release()
        await signingIn.value

        XCTAssertEqual(s.state, .loggedOut, "a login that finished after sign-out must not sign the user back in")
        XCTAssertNil(try store.load(), "and must not write its token into the keychain afterwards")
    }

    // `.task` is cancelled when the window closes, which surfaces as a transport
    // error. Painting that as "Couldn't reach the server" reports an outage that
    // is not happening.
    func testACancelledLoadDoesNotRenderAnOutage() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        let gate = RequestGate()
        StubURLProtocol.router = { _ in gate.hold(); return .init(status: 503, body: Data()) }
        let s = session(store: store)

        let restoring = Task { await s.restore() }
        await gate.reached()
        restoring.cancel()
        gate.release()
        await restoring.value

        if case .unavailable = s.state {
            XCTFail("a user-initiated cancel must not be reported as a server outage")
        }
    }

    // MARK: - Re-entrant restore
    //
    // A WindowGroup gives ⌘N and window-reopen for free, and every ContentView
    // runs `.task { await session.restore() }`.

    /// Reopening a window while the user is typing must not turn the shared
    /// session into `.restoring`: that tears the form out of every window and
    /// loses its draft. Once the session says logged out, the empty keychain has
    /// already been established.
    func testRestoreDoesNotRebuildALoggedOutForm() async {
        let s = session(store: InMemoryTokenStore())
        await s.restore()
        XCTAssertEqual(s.state, .loggedOut)

        StubURLProtocol.reset()
        StubURLProtocol.router = { _ in
            XCTFail("a re-entrant restore must not reload an established empty store")
            return .init(status: 500)
        }
        var seen: [SessionState] = []
        let sub = s.$state.sink { seen.append($0) }
        defer { sub.cancel() }

        await s.restore()

        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertFalse(seen.contains(.restoring))
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
    }

    /// A rejected attempt is the same form plus a useful sentence. A second
    /// window must not erase both by running a cold restore against an empty
    /// keychain.
    func testRestoreDoesNotDiscardARejectedForm() async {
        StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"nope"}"#.utf8))
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "a@b.co", password: "wrong")
        let failed = s.state
        guard case .failed = failed else { return XCTFail("setup failed, got \(failed)") }

        StubURLProtocol.reset()
        StubURLProtocol.router = { _ in
            XCTFail("the rejection is already a settled session state")
            return .init(status: 500)
        }
        await s.restore()

        XCTAssertEqual(s.state, failed)
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
    }

    func testRestoreOnALiveSessionKeepsTheAccountOnScreen() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        try routeLoggedIn(loginBody: Data())
        let s = session(store: store)
        await s.restore()
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }

        // Record every state the second restore publishes, and make the server
        // hostile while it runs: neither may cost the user the loaded account.
        var seen: [SessionState] = []
        let sub = s.$state.sink { seen.append($0) }
        defer { sub.cancel() }
        StubURLProtocol.router = { _ in .init(status: 503, body: Data()) }

        await s.restore()

        guard case let .ready(user, usage) = s.state else {
            return XCTFail("a second window must not discard the loaded account, got \(s.state)")
        }
        XCTAssertEqual(user.planId, "pro")
        XCTAssertEqual(usage.plan.name, "Pro")
        XCTAssertFalse(seen.contains(.restoring), "and must not flash a full-screen spinner over it")
        XCTAssertFalse(s.isStale, "nor refetch — the account screen has an explicit Refresh")
    }

    // A new window opening mid-sign-in must not restart from the (still empty)
    // keychain: that would supersede the sign-in and drop the user on the form.
    func testRestoreDuringAnInFlightLoginDoesNotAbortIt() async throws {
        let store = InMemoryTokenStore()
        let loginBody = try fixture("login-success")
        let me = try fixture("me"), usage = try fixture("me-usage")
        let gate = RequestGate()
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:              gate.hold(); return .init(status: 200, body: loginBody)
            }
        }
        let s = session(store: store)
        let signingIn = Task { await s.logIn(email: "a@b.co", password: "pw") }
        await gate.reached()
        await s.restore()               // ⌘N while the sign-in is in flight
        gate.release()
        await signingIn.value

        guard case .ready = s.state else { return XCTFail("the sign-in must still land, got \(s.state)") }
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN")
    }

    // The other half: a token in hand but no account on screen. Reopening the
    // window there *should* retry — it just must not do it as a cold start.
    func testRestoreFromUnavailableRetriesWithoutAFullScreenSpinner() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        StubURLProtocol.router = { _ in .init(status: 503, body: Data()) }
        let s = session(store: store)
        await s.restore()
        guard case .unavailable = s.state else { return XCTFail("setup failed, got \(s.state)") }

        var seen: [SessionState] = []
        let sub = s.$state.sink { seen.append($0) }
        defer { sub.cancel() }
        try routeLoggedIn(loginBody: Data())

        await s.restore()

        guard case .ready = s.state else { return XCTFail("want ready, got \(s.state)") }
        XCTAssertFalse(seen.contains(.restoring), "a reopened window is a refresh, not a cold start")
    }

    // A refused revocation must NOT delete local state: that would leave a
    // still-valid server credential nothing on this device can revoke. The user
    // is offered a retry instead, and the retry has to actually work.
    func testSignOutFailureKeepsTheCredentialAndOffersRetry() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        try routeLoggedIn(loginBody: Data())
        let s = session(store: store)
        await s.restore()
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }

        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/logout": return .init(status: 503, body: Data())
            default:                 return .init(status: 500, body: Data())
            }
        }
        await s.logOut()

        XCTAssertEqual(s.state, .unavailable(message: L10n.t(.accountSignOutFailed)))
        XCTAssertEqual(s.bearerToken, "rlm_cli_TESTTOKEN",
                       "the credential must survive so the revocation can be retried")
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN")

        StubURLProtocol.router = { _ in .init(status: 200, body: Data()) }
        await s.logOut()

        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertNil(s.bearerToken)
        XCTAssertNil(try store.load())
    }

    // restore()'s COLD path — read the store, then fetch — is the one entry
    // point the generation guard was never proved on. A sign-out that lands
    // while the launch fetch is in flight must win: otherwise the late success
    // writes `.ready` over it and puts the user back on an account screen whose
    // token was just cleared.
    func testSignOutDuringLaunchRestoreStaysSignedOut() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        let gate = RequestGate()
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":          gate.hold(); return .init(status: 200, body: me)
            case "/api/me/usage":    return .init(status: 200, body: usage)
            case "/api/auth/logout": return .init(status: 200, body: Data())
            default:                 return .init(status: 500, body: Data())
            }
        }
        let s = session(store: store)
        let restoring = Task { await s.restore() }
        await gate.reached()
        // In a Task and released before it is awaited, exactly like the refresh
        // case above: `StubURLProtocol.startLoading` blocks URLSession's own
        // loading thread, so a sign-out awaited while /api/me is still held
        // would wait out the 60s transport timeout instead of racing it. The
        // yield is what matters — `logOut()` bumps the operation generation
        // synchronously, before its first await, so by the time the gate opens
        // the launch restore is already superseded.
        let loggingOut = Task { await s.logOut() }   // the user signs out during the launch fetch
        await Task.yield()
        gate.release()
        await loggingOut.value
        await restoring.value

        XCTAssertEqual(s.state, .loggedOut, "a launch restore must not undo a sign-out that beat it")
        XCTAssertNil(s.bearerToken)
        XCTAssertNil(try store.load())
    }

    // The password rides in the POST body and the bearer in a header. Either one
    // in a URL would reach every proxy log, the server's access log, and any
    // Referer that followed.
    func testCredentialsNeverAppearInARequestURL() async throws {
        let recorder = URLRecorder()
        let loginBody = try fixture("login-success")
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.router = { req in
            recorder.record(req.url)
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:              return .init(status: 200, body: loginBody)
            }
        }
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "person@example.com", password: "hunter2-correct-horse")
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }

        XCTAssertFalse(recorder.urls.isEmpty, "nothing was sent — the test proves nothing")
        for url in recorder.urls {
            XCTAssertFalse(url.contains("hunter2"), url)
            XCTAssertFalse(url.contains("person@example.com"), url)
            XCTAssertFalse(url.contains("rlm_cli_TESTTOKEN"), url)
            XCTAssertNil(URLComponents(string: url)?.query, url)
        }
    }
}

/// The 200 body of a successful registration, in the server's documented shape.
///
/// File scope rather than a member of the `@MainActor` test case: the stub's
/// router runs on URLSession's own thread and cannot reach main-actor state.
private let registeredBody = Data(#"{"status":"verification_sent","email":"ada@example.com"}"#.utf8)

/// A latch a stubbed response can block on, so a test can run a main-actor call
/// (sign out, cancel) *while* a request is in flight. `hold()` runs on
/// URLSession's own thread from inside the stub; `reached()` waits for it without
/// ever blocking the main actor, so the session under test keeps running.
final class RequestGate {
    private let entered = DispatchSemaphore(value: 0)
    private let released = DispatchSemaphore(value: 0)

    /// Call from inside the stub: announce arrival, then block until released.
    func hold() {
        entered.signal()
        released.wait()
    }

    func reached() async {
        // The semaphore, not `self`: `DispatchSemaphore` is Sendable, so the wait
        // crosses to the background queue without a capture warning.
        let entered = self.entered
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                entered.wait()
                continuation.resume()
            }
        }
    }

    func release() { released.signal() }
}

/// A `TokenStore` whose `save` always fails (e.g. a locked keychain), while `load`
/// and `clear` behave like an in-memory store. Exists only to prove that a
/// swallowed save error cannot turn a live, in-memory session into a false
/// sign-out on the next refresh. Not used outside this test file.
final class FailingSaveTokenStore: TokenStore {
    private var token: String?
    func save(_ token: String) throws { throw KeychainError.status(-25308) }
    func load() throws -> String? { token }
    func clear() throws { token = nil }
}

/// Collects every URL that reached the transport. The stub's router runs on
/// URLSession's own thread, so a captured local array would be a data race.
final class URLRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []

    func record(_ url: URL?) {
        lock.lock(); defer { lock.unlock() }
        seen.append(url?.absoluteString ?? "")
    }

    var urls: [String] {
        lock.lock(); defer { lock.unlock() }
        return seen
    }
}
