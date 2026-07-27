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
        s.logOut()
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
    }

    // MARK: - Operation identity
    //
    // Being @MainActor serializes each step, not each operation: `logOut()` is
    // synchronous and a load has two suspension points, so a sign-out lands
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
            default:              return .init(status: 500)
            }
        }
        let refreshing = Task { await s.refresh() }
        await gate.reached()
        s.logOut()          // user signs out while the refresh is in flight
        gate.release()
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
        s.logOut()
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
}

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
