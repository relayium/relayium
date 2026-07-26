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

    public init(client: AccountClient, tokenStore: TokenStore, deviceName: String) {
        self.client = client
        self.tokenStore = tokenStore
        self.deviceName = deviceName
    }

    /// Where a `loadAccount` call came from, which decides what a non-401 failure means.
    private enum LoadOrigin { case restore, login }

    public func restore() async {
        state = .restoring
        guard let token = await loadTokenOffMainActor(), !token.isEmpty else {
            state = .loggedOut
            return
        }
        await loadAccount(token: token, origin: .restore)
    }

    public func logIn(email: String, password: String) async {
        state = .authenticating
        do {
            let outcome = try await client.login(email: email, password: password, deviceName: deviceName)
            switch outcome {
            case let .success(token, _):
                // The 6-field LoginUser has no billing fields; only /api/me does. So a
                // successful login is always followed by a fetch, never rendered directly.
                try? tokenStore.save(token)
                await loadAccount(token: token, origin: .login)
            case let .emailUnverified(email):
                state = .emailUnverified(email: email)
            case let .pendingDeletion(purgeAfter, reactivateToken):
                state = .pendingDeletion(purgeAfter: purgeAfter, reactivateToken: reactivateToken)
            }
        } catch {
            state = .failed(message: ErrorCopy.message(for: error))
        }
    }

    public func refresh() async {
        guard let token = await loadTokenOffMainActor(), !token.isEmpty else {
            state = .loggedOut
            return
        }
        await loadAccount(token: token, origin: .restore)
    }

    public func logOut() {
        // A keychain clear failure must not strand the user in a signed-in UI: the
        // in-memory session is gone either way.
        try? tokenStore.clear()
        isStale = false
        state = .loggedOut
    }

    private func loadAccount(token: String, origin: LoadOrigin) async {
        do {
            let user = try await client.fetchMe(token: token)
            let usage = try await client.fetchUsage(token: token)
            state = .ready(user: user, usage: usage)
            isStale = false
        } catch AccountError.invalidCredentials {
            // The one and only signal that a stored token has gone bad.
            try? tokenStore.clear()
            isStale = false
            state = .loggedOut
        } catch {
            let message = ErrorCopy.message(for: error)
            if case .ready = state {
                isStale = true          // keep the last known good on screen
            } else {
                // A rejected sign-in belongs back on the form; a token that could not
                // be exchanged for an account belongs on a retry screen.
                state = origin == .login ? .failed(message: message) : .unavailable(message: message)
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
