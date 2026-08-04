import Combine
import Foundation

/// Signing out, from wherever the decision came from — and outliving whatever
/// screen it came from.
///
/// This exists because of one lifecycle defect. Revoking the current device
/// cascades this app's own bearer server-side, and the app noticed by way of a
/// `.task(id: management.needsSignOut)` on the account screen. That reads
/// correctly and is wrong: a user who taps Revoke on the current device and then
/// switches tabs takes the account view down before the response lands. SwiftUI
/// mounts a `TabView`'s tabs lazily and can tear an off-screen one down, so the
/// observer goes with it. The app-scoped model still records the signal
/// truthfully — nothing is lost — but nothing CONSUMES it, so until the user
/// happens to return to the Account tab the other tabs go on offering to spend a
/// credential the server has already revoked.
///
/// So the observation is app-scoped and starts before any view exists. That is a
/// stronger claim than "an always-mounted root": it does not depend on a view
/// hierarchy at all, the same reason `SendSelectionModel.observe` is called from
/// the App's `init` rather than from a `.task`.
///
/// It takes a closure rather than an `AccountSession` for the reason
/// `SendSelectionModel` takes `fetchConfig` as one: the interesting moment is
/// *while the network call is in flight*, and a test can only stand in that
/// moment if it can hold the call open.
@MainActor
public final class AccountSignOutCoordinator: ObservableObject {
    /// True while a sign-out's network revocation is running.
    ///
    /// The whole app is blocked and labelled for that interval, which is not
    /// caution: by the time this is true the bearer is either revoked already
    /// (a self-revoke) or being revoked (an explicit sign-out), so an action
    /// started in another tab would fail against the server and be reported to
    /// the user as their problem.
    ///
    /// It is also the gate that stops a Refresh already in flight from putting
    /// the rows back. `AccountSession.logOut()` deliberately keeps `.ready` on
    /// screen until its revocation finishes, so a superseded refresh returns to a
    /// still-ready account and `AccountRefreshDecision` would legitimately choose
    /// `.reload` — recreating every `#k=` link for the length of the timeout the
    /// pre-call clear exists to avoid. Living here rather than in `@State` is
    /// what makes that gate survive the account view being torn down and rebuilt
    /// mid-sign-out.
    @Published public private(set) var isSigningOut = false

    private let management: AccountManagementModel
    private let logOut: @MainActor () async -> Void
    private var observation: AnyCancellable?
    private var task: Task<Void, Never>?

    public init(management: AccountManagementModel,
                logOut: @escaping @MainActor () async -> Void) {
        self.management = management
        self.logOut = logOut
    }

    /// Start watching for successful self-revokes. Call once, at app scope,
    /// before any view is built.
    public func observe<P: Publisher>(_ signals: P)
        where P.Output == Bool, P.Failure == Never {
        observation = signals
            .removeDuplicates()
            .sink { [weak self] raised in
                guard raised else { return }
                // `@Published` fires on **willSet**, so `needsSignOut` still
                // reads `false` inside this closure and claiming here would find
                // nothing. Worse, a claim that did land would be overwritten a
                // moment later by the very assignment that triggered it, leaving
                // the flag stuck `true` forever. So the claim happens on the next
                // main-actor turn, when the value is actually set — and it is
                // still exactly-once, because the claim itself is what decides.
                Task { @MainActor [weak self] in self?.selfRevoked() }
            }
    }

    /// The Sign out button. Scoped, because a press naming an account the model
    /// has already moved on from must not wipe the current one's rows.
    ///
    /// Routed through here rather than straight to the session so that "one
    /// logout at a time" is enforceable: a Sign out tapped while a self-revoke's
    /// sign-out is already running would otherwise be a second revocation of a
    /// credential that is already gone, and its failure would be reported over
    /// the first one's success.
    public func signOut(scope: AccountScope) {
        // The rows go BEFORE the call, not after it. `logOut` can take a minute
        // to time out, and there is no reason for a leaving user's device list
        // and reconstructed `#k=` links to sit in an app-scoped object for it.
        management.clear(scope: scope)
        start()
    }

    private func selfRevoked() {
        // Claimed unconditionally, even when a sign-out is already running: an
        // unclaimed signal would survive into the next session and sign THAT one
        // out. `start()` is what refuses to make a second network call.
        guard management.consumeSelfRevoke() else { return }
        start()
    }

    private func start() {
        guard !isSigningOut else { return }
        isSigningOut = true
        // Snapshotted before the task is created and read from the local rather
        // than through `self`. A `self?.logOut()` inside would let the shell
        // being released truncate a revocation part-way — the same failure as
        // the account view being torn down, one level up — and would leave the
        // credential valid on the server with nothing left to revoke it.
        let logOut = self.logOut
        task = Task { @MainActor [weak self] in
            await logOut()
            // Lowered either way. A failed sign-out leaves the user on a
            // retryable screen, and an app left permanently blocked would leave
            // them with nothing to retry it from.
            self?.isSigningOut = false
        }
    }
}
