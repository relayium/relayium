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
    case emailUnverified(email: String)
    case pendingDeletion(purgeAfter: Int64, reactivateToken: String)
    case ready(user: NativeUser, usage: UsageResponse)
    /// A sign-in attempt was rejected — show the form again with the reason.
    case failed(message: String)
    /// We hold a token but could not load the account (server down, offline).
    /// Distinct from `.failed` on purpose: a sign-in form cannot fix this.
    case unavailable(message: String)
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
    /// operation: a load has two suspension points and `logOut()` is synchronous,
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
        // A token in hand but no account on screen (`.unavailable`, or a window
        // opened while the first load is still running) is a refresh, not a cold
        // start: keep the current screen while it runs.
        if sessionToken != nil {
            await refresh()
            return
        }

        let g = beginOperation()
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

    public func logIn(email: String, password: String) async {
        let g = beginOperation()
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

    public func refresh() async {
        let g = beginOperation()
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

    public func logOut() {
        // Bumping the generation is the load-bearing half: an in-flight refresh or
        // sign-in must not be able to resume afterwards and undo this.
        _ = beginOperation()
        // A keychain clear failure must not strand the user in a signed-in UI: the
        // in-memory session is gone either way.
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
