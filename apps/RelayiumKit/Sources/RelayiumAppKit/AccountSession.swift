import Foundation
// @preconcurrency: RelayiumKit predates strict concurrency and marks nothing Sendable.
// The one capture this silences — the TokenStore existential crossing to a background
// queue in loadTokenOffMainActor() — is safe: KeychainTokenStore is a final class with
// two immutable lets, calling thread-safe Keychain APIs.
@preconcurrency import RelayiumKit

public enum SessionState: Equatable {
    case restoring
    case loggedOut
    case authenticating
    /// A registration is in flight.
    ///
    /// Distinct from `.authenticating` because it is a different operation with
    /// a different destination: it can never produce a session, only the
    /// check-email state, so a screen that reported "Signing in…" here would be
    /// naming an outcome that cannot happen.
    case registering
    case emailUnverified(email: String)
    case pendingDeletion(purgeAfter: Int64, reactivateToken: String)
    case ready(user: NativeUser, usage: UsageResponse)
    /// A sign-in or a registration was rejected — show the form again with the
    /// reason. Which of the two the form was in the middle of is the FORM's
    /// state, not the session's: the session does not own the mode, so a failed
    /// registration cannot silently drop the user back onto the sign-in half.
    case failed(message: String)
    /// We hold a token but could not load the account (server down, offline).
    /// Distinct from `.failed` on purpose: a sign-in form cannot fix this.
    case unavailable(message: String)
}

/// What the "send it again" action on the check-email screen is doing.
///
/// Its own published value rather than a `SessionState` case: asking for another
/// verification email does not change who is signed in, and modelling it as a
/// session state would mean the check-email screen — the address, the
/// instructions, the way back — was torn down and rebuilt around a button press.
public enum ResendState: Equatable {
    case idle
    case sending
    /// The server took the request. Deliberately not `.sent`: the endpoint
    /// answers 200 whether it emailed anything or silently swallowed the request
    /// under its per-address throttle, and the copy says only what is true.
    case requested
    case failed(message: String)
}

/// The whole account state machine. Routing *is* session state, so there is one
/// source of truth rather than a separate router.
///
/// Every Kit call it makes is `async`; every Kit callback it would ever adopt fires
/// off the main thread. Keeping this type `@MainActor` and doing the hopping here
/// means the SwiftUI views never think about threads.
@MainActor
public final class AccountSession: ObservableObject {
    @Published public private(set) var state: SessionState = .restoring
    /// Last refresh failed but the displayed user/usage is still the last known good.
    @Published public private(set) var isStale: Bool = false
    /// The check-email screen's own action. Reset by every operation that moves
    /// the session, so a "sent" notice cannot outlive the screen it was about.
    @Published public private(set) var resendState: ResendState = .idle

    private let client: AccountClient
    private let tokenStore: TokenStore
    private let deviceName: String
    /// The live session token. Source of truth for an in-progress session — the
    /// keychain is persistence only. A swallowed `save()` failure (locked keychain,
    /// failing `SecItemAdd`) must not be able to sign a working session out from
    /// under it just because the store comes back empty on the next refresh.
    private var sessionToken: String?

    /// The bearer token for callers that must authenticate their own requests —
    /// G2's uploader, which needs it at `POST /api/uploads`.
    ///
    /// Deliberately not `@Published`: a credential has no business being part of
    /// the view-update surface, and nothing should re-render because a token was
    /// refreshed. Read it at the moment of use, never cache it.
    public var bearerToken: String? { sessionToken }

    /// Operation identity. Being `@MainActor` serializes each *step*, not each
    /// operation: a load has suspension points and `logOut()` may overlap it,
    /// so a sign-out lands *between* a load's awaits routinely — sign out while a
    /// refresh is in flight, or while "Try again" is waiting out URLSession's 60s
    /// timeout. Without identity the late completion writes `.ready` on top and
    /// puts the user back on the account screen they just left, with no token.
    ///
    /// Every entry point claims the next number; every write that happens after an
    /// `await` is guarded on still holding it. The last call to start is the only
    /// one allowed to finish.
    private var generation = 0

    public init(client: AccountClient, tokenStore: TokenStore, deviceName: String) {
        self.client = client
        self.tokenStore = tokenStore
        self.deviceName = deviceName
    }

    private func beginOperation() -> Int {
        generation += 1
        return generation
    }

    /// `beginOperation`, plus the one thing every session-moving operation owes
    /// the check-email screen: its resend notice belongs to ONE address in ONE
    /// state, so signing in, signing out, restoring or registering clears it.
    /// A "Sent" line surviving into the next screen would be a claim about an
    /// email nobody there asked for.
    ///
    /// `resendVerification()` deliberately uses the bare `beginOperation()`
    /// instead: it claims the same generation counter — so a sign-out mid-resend
    /// still supersedes it — while leaving `resendState` alone, since that is
    /// the value it exists to write.
    private func beginSessionOperation() -> Int {
        resendState = .idle
        return beginOperation()
    }

    /// True once a newer operation has started — this one must write nothing.
    private func superseded(_ g: Int) -> Bool { generation != g }

    /// Launch restore — and also what every window runs, because a `WindowGroup`
    /// gives ⌘N and window-reopen for free and each `ContentView` carries
    /// `.task { await session.restore() }`. So it must not be a blind "reset to a
    /// spinner and refetch": that would flip a live account screen to a full-screen
    /// `ProgressView`, and against a down server it would trade the last-known-good
    /// figures `isStale` exists to preserve for a bare `.unavailable`.
    public func restore() async {
        // Already showing an account: nothing to restore. The account screen has an
        // explicit Refresh for the deliberate case.
        if case .ready = state { return }
        // A sign-in is already running and owns the screen. Starting over from the
        // (still empty) keychain here would supersede it — a ⌘N mid-sign-in would
        // abort the sign-in and drop the user back on the form.
        if case .authenticating = state { return }
        // The same, for a registration: it holds no token and never will, so a
        // cold start would find an empty keychain and replace an in-flight
        // account creation with a sign-in form.
        if case .registering = state { return }
        // A session-scoped restore has already established that there is no
        // credential to load. Reopening a window while the user is typing — or
        // after a rejected attempt — must not flash `.restoring`, tear the one
        // form down and discard every field it owns.
        if case .loggedOut = state { return }
        if case .failed = state { return }
        // Two states reached deliberately, holding no token, that a cold start
        // would silently discard: the check-email screen (which owns the address
        // and the resend action) and the reactivation notice (which owns the one
        // token that can undo a deletion). Neither is something the keychain can
        // reproduce, and on macOS reopening the window re-runs this. Leaving
        // them is what makes ⌘N harmless; the way out of both is the explicit
        // "Back to sign in", which signs out.
        if case .emailUnverified = state { return }
        if case .pendingDeletion = state { return }
        // A token in hand but no account on screen (`.unavailable`, or a window
        // opened while the first load is still running) is a refresh, not a cold
        // start: keep the current screen while it runs.
        if sessionToken != nil {
            await refresh()
            return
        }

        let g = beginSessionOperation()
        state = .restoring
        let token = await loadTokenOffMainActor()
        guard !superseded(g) else { return }
        guard let token, !token.isEmpty else {
            state = .loggedOut
            isStale = false
            return
        }
        sessionToken = token
        await loadAccount(token: token, generation: g)
    }

    /// Adopt a bearer obtained outside this type — the browser login's device
    /// flow hands one back after the user approves in a browser.
    ///
    /// Deliberately the same tail as `logIn`'s success branch: persist, then
    /// fetch. The token alone carries no billing fields, so a session rendered
    /// from it would show half an account screen. Every guard is the existing
    /// one; this adds a way to arrive at a session, not a second kind of session.
    public func adoptBearer(_ token: String) async {
        let g = beginSessionOperation()
        state = .authenticating
        guard !superseded(g) else { return }
        sessionToken = token
        try? tokenStore.save(token)
        await loadAccount(token: token, generation: g)
    }

    public func logIn(email: String, password: String) async {
        let g = beginSessionOperation()
        state = .authenticating
        do {
            let outcome = try await client.login(email: email, password: password, deviceName: deviceName)
            // A sign-out (or a second sign-in) that landed while this was in flight
            // wins. Returning here is also what stops a stale success from writing a
            // token into the keychain *after* the user signed out.
            guard !superseded(g) else { return }
            switch outcome {
            case let .success(token, _):
                // The 6-field LoginUser has no billing fields; only /api/me does. So a
                // successful login is always followed by a fetch, never rendered directly.
                sessionToken = token
                try? tokenStore.save(token)
                await loadAccount(token: token, generation: g)
            case let .emailUnverified(email):
                state = .emailUnverified(email: email)
            case let .pendingDeletion(purgeAfter, reactivateToken):
                state = .pendingDeletion(purgeAfter: purgeAfter, reactivateToken: reactivateToken)
            }
        } catch {
            guard !superseded(g) else { return }
            // A cancelled request (the window closed mid-sign-in) is not a rejected
            // sign-in. Nothing was saved for this attempt, so the honest resting
            // state is the form again, without an error the user didn't cause.
            guard !Task.isCancelled else {
                state = .loggedOut
                return
            }
            // A rejected sign-in (bad credentials, rate limited, login endpoint down)
            // belongs back on the form — nothing was ever saved for this attempt.
            state = .failed(message: ErrorCopy.message(for: error))
        }
    }

    /// Sign in with an Apple authorization the platform just completed.
    ///
    /// Deliberately the same shape as `logIn` — same generation claim, same
    /// keychain write, same `/api/me` + usage load, same pending-deletion and
    /// cancellation handling — because it is the same thing: a credential
    /// exchange that ends in a bearer. A second, parallel path to `.ready`
    /// would be a second set of races to get right.
    ///
    /// It reports `.authenticating` rather than a state of its own: what is in
    /// flight is a sign-in, and it can end on an account. The one place it
    /// differs from a password sign-in is the failure copy, which comes from
    /// the Apple-specific `AccountError` cases and never says "check your email
    /// and password" about credentials the user never typed.
    ///
    /// There is no `.emailUnverified` branch: Apple asserting the address IS
    /// the verification, so the server never answers that here.
    public func logInWithApple(idToken: String,
                               authorizationCode: String,
                               nonce: String,
                               name: String) async {
        let g = beginSessionOperation()
        state = .authenticating
        do {
            let outcome = try await client.loginWithApple(idToken: idToken,
                                                          authorizationCode: authorizationCode,
                                                          nonce: nonce,
                                                          name: name)
            // A sign-out (or a newer sign-in) that landed while this was in
            // flight wins — and, as in `logIn`, this is what stops a stale
            // success from writing a token into the keychain afterwards.
            guard !superseded(g) else { return }
            switch outcome {
            case let .success(token, _):
                sessionToken = token
                try? tokenStore.save(token)
                await loadAccount(token: token, generation: g)
            case let .pendingDeletion(purgeAfter, reactivateToken):
                state = .pendingDeletion(purgeAfter: purgeAfter, reactivateToken: reactivateToken)
            case let .emailUnverified(email):
                // Not reachable through this route today. Rendered rather than
                // ignored so a server that ever did answer it produces the
                // screen that can act on it, not a silently dropped response.
                state = .emailUnverified(email: email)
            }
        } catch {
            guard !superseded(g) else { return }
            guard !Task.isCancelled else {
                state = .loggedOut
                return
            }
            state = .failed(message: ErrorCopy.message(for: error))
        }
    }

    /// Report a native Apple authorization that never reached the server.
    ///
    /// The system sheet failed, or completed with a credential missing the
    /// fields the exchange needs. Nothing was sent, so this is the form again
    /// with a reason — the same resting place a rejected sign-in reaches, and
    /// deliberately not `.unavailable`, which offers a retry of a request that
    /// was never made.
    ///
    /// A user CANCELLING is not this: the caller drops that on the floor, since
    /// the whole meaning of cancelling is that nothing happens.
    ///
    /// It claims the operation generation like every other entry point here, so
    /// an older in-flight attempt cannot land afterwards and paint over the
    /// reason the user is looking at.
    public func reportAppleSignInFailure(_ error: Error) {
        _ = beginSessionOperation()
        state = .failed(message: ErrorCopy.message(for: error))
    }

    /// Create an account from the app.
    ///
    /// Three things it deliberately does NOT do, each of which would be a lie
    /// about what the server did:
    ///
    ///  * It never touches `sessionToken` or the keychain. Registration issues
    ///    no credential, so there is nothing to persist, and a token written
    ///    here could only be a stale one from an earlier session.
    ///  * It never lands on `.ready`. The only success is `.emailUnverified`,
    ///    carrying the server's normalized address — the same state a sign-in
    ///    against an unverified account reaches, so one screen serves both.
    ///  * It never reports a rejection as `.unavailable`. Nothing is held, so
    ///    the form is the honest place to be, and the form is where the fields
    ///    that produced the rejection still are.
    public func register(email: String, password: String, displayName: String) async {
        let g = beginSessionOperation()
        state = .registering
        do {
            let outcome = try await client.register(email: email,
                                                    password: password,
                                                    displayName: displayName)
            // A sign-out, a sign-in or a second registration that landed while
            // this was in flight wins — the same rule every other entry point
            // here follows.
            guard !superseded(g) else { return }
            state = .emailUnverified(email: outcome.email)
        } catch {
            guard !superseded(g) else { return }
            // A cancelled request (the window closed mid-registration) is not a
            // rejected registration. Nothing was created for this attempt as far
            // as this app can tell, so the honest resting state is the form
            // again, without an error the user did not cause.
            guard !Task.isCancelled else {
                state = .loggedOut
                return
            }
            state = .failed(message: ErrorCopy.message(for: error))
        }
    }

    /// Remove the rejection from the shared account-access form when the user
    /// switches between sign-in and registration.
    ///
    /// A bad-password sentence on the create-account half (or an invalid-email
    /// registration sentence on the sign-in half) describes a different form.
    /// Both states are rendered at the same structural call site, so this does
    /// not discard the draft or its mode.
    public func dismissAccountAccessError() {
        guard case .failed = state else { return }
        state = .loggedOut
    }

    /// Ask the server for another verification email.
    ///
    /// Reachable only from the check-email screen, and it writes only
    /// `resendState`: the address on screen, and the session state that carries
    /// it, are untouched by a request about them.
    ///
    /// A second press while one is in flight is refused rather than queued. The
    /// endpoint throttles per address anyway, so a queued second request would
    /// buy nothing and cost the user a "Sent" that meant "swallowed".
    public func resendVerification(email: String) async {
        // A stale view/task is not authority to send mail or to claim the
        // operation generation. In particular it must not supersede a newer
        // sign-in or registration just because its tap was delivered late.
        guard case let .emailUnverified(currentEmail) = state,
              currentEmail == email else { return }
        if case .sending = resendState { return }
        // The shared counter, so a sign-out or a sign-in that lands mid-flight
        // supersedes this and the late completion writes nothing onto a screen
        // that has moved on.
        let g = beginOperation()
        resendState = .sending
        do {
            try await client.resendVerification(email: email)
            guard !superseded(g) else { return }
            resendState = .requested
        } catch {
            guard !superseded(g) else { return }
            guard !Task.isCancelled else {
                resendState = .idle
                return
            }
            resendState = .failed(message: ErrorCopy.message(for: error))
        }
    }

    public func refresh() async {
        let g = beginSessionOperation()
        let token: String?
        if let held = sessionToken {
            token = held
        } else {
            token = await loadTokenOffMainActor()
        }
        guard !superseded(g) else { return }
        guard let token, !token.isEmpty else {
            state = .loggedOut
            isStale = false
            return
        }
        sessionToken = token
        await loadAccount(token: token, generation: g)
    }

    public func logOut() async {
        // Bumping the generation is the load-bearing half: an in-flight refresh or
        // sign-in must not be able to resume afterwards and undo this.
        let g = beginSessionOperation()
        let token = sessionToken
        if let token {
            do {
                try await client.logout(token: token)
                guard !superseded(g) else { return }
            } catch {
                // Keep the token so the user can retry revocation. Merely deleting
                // Keychain state here would leave a still-valid server credential
                // that can no longer be self-revoked from this device.
                guard !Task.isCancelled, !superseded(g) else { return }
                state = .unavailable(message: L10n.t(.accountSignOutFailed))
                return
            }
        }
        sessionToken = nil
        try? tokenStore.clear()
        isStale = false
        state = .loggedOut
    }

    /// By the time this is called a token is always already in hand — either just
    /// issued by a successful login or read back from storage. So a non-401 failure
    /// here is never a rejected sign-in; it is always "we hold a token but couldn't
    /// load the account," which is what `.unavailable` (retry, not a login form) means.
    private func loadAccount(token: String, generation g: Int) async {
        do {
            let user = try await client.fetchMe(token: token)
            let usage = try await client.fetchUsage(token: token)
            guard !superseded(g) else { return }
            state = .ready(user: user, usage: usage)
            isStale = false
        } catch AccountError.invalidCredentials {
            guard !superseded(g) else { return }
            // The one and only signal that a stored token has gone bad.
            sessionToken = nil
            try? tokenStore.clear()
            isStale = false
            state = .loggedOut
        } catch {
            guard !superseded(g) else { return }
            // `.task` is cancelled when the window closes; URLSession surfaces that
            // as a transport error, which `AccountClient` maps to `.network`.
            // Rendering a user-initiated cancel as an outage is a lie about
            // something that isn't happening.
            guard !Task.isCancelled else { return }
            let message = ErrorCopy.message(for: error)
            if case .ready = state {
                isStale = true          // keep the last known good on screen
            } else {
                state = .unavailable(message: message)
            }
        }
    }

    /// `KeychainTokenStore.load()` is a synchronous, blocking Keychain call whose first
    /// use can raise a system authorization prompt. It never runs on the main actor.
    private func loadTokenOffMainActor() async -> String? {
        let store = tokenStore
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: try? store.load())
            }
        }
    }
}
