import Combine
import Foundation

/// Turns "who is signed in" into "which generation may receive".
///
/// ## Why this is an object subscribed in `init`, not an `.onChange` on a view
///
/// The signal it carries is a security boundary: a sign-out, an account switch,
/// or a session that has become `unavailable` must CANCEL the receive loop, and
/// the response that produces it can land at any moment — including while the
/// unique window is closed, which on this app is an ordinary running state
/// because the `MenuBarExtra` keeps the process up. A `.onChange` lives for as
/// long as a view tree does, so it would be absent for exactly the interval this
/// matters in: the app would go on claiming, decrypting and writing deliveries
/// under a credential the server has already revoked. `AccountSignOutCoordinator`
/// is app-scoped for the same reason and `MacSurfaceGuardTests` pins it there.
///
/// ## The mapping, and why only one state produces an identity
///
/// `ready` with a bearer in hand is the ONLY state that may receive. Every other
/// one — restoring, authenticating, registering, unverified, pending deletion,
/// failed, logged out, and `unavailable` above all — resolves to `nil` and stops
/// the loop. `unavailable` is the interesting one: a token is held but the
/// account could not be loaded, so this app cannot currently tell a revoked
/// credential from a server outage. Continuing to receive on that basis would be
/// exactly the case where "we are not sure" is being rendered as "yes".
@MainActor
public final class InboxSessionBridge {
    private let controller: InboxController
    private var cancellables: Set<AnyCancellable> = []
    private var started = false

    public init(controller: InboxController) {
        self.controller = controller
    }

    /// Subscribe. Idempotent, and separate from `init` for the reason
    /// `TransferNotificationCenter.start` is: a `@StateObject` takes its initial
    /// value as an autoclosure, so an object nobody reads is never built.
    ///
    /// The bearer is read through a closure rather than captured, so it is
    /// resolved at the instant the state changes and never held here.
    public func observe(_ states: Published<SessionState>.Publisher,
                        bearer: @escaping @MainActor () -> String?) {
        guard !started else { return }
        started = true
        states
            .sink { [weak self] state in
                guard let self else { return }
                // Deferred by one hop: `@Published` fires in `willSet`, so the
                // session's own `bearerToken` may still be the PREVIOUS one when
                // this runs. Reading it a tick later reads the credential that
                // belongs to the state being announced — and reading the old one
                // is how a signed-out app would keep a live generation.
                Task { @MainActor in
                    self.controller.session(Self.identity(for: state, bearer: bearer()))
                }
            }
            .store(in: &cancellables)
    }

    /// The mapping, as a pure function so it can be asserted over every case.
    public static func identity(for state: SessionState,
                                bearer: String?) -> InboxAccountIdentity? {
        guard case .ready(let user, _) = state else { return nil }
        guard let bearer, !bearer.isEmpty, !user.id.isEmpty else { return nil }
        return InboxAccountIdentity(accountID: user.id, bearer: bearer)
    }
}
