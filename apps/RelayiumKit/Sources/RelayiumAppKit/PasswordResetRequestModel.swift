import Foundation
import RelayiumShareKit
@preconcurrency import RelayiumKit

/// What the "forgot password" request is doing.
public enum PasswordResetRequestState: Equatable {
    case idle
    case sending
    /// The server accepted a request for this address.
    ///
    /// Deliberately not `.sent`: `POST /api/auth/password/forgot` answers 200
    /// whether an account uses the address or not, and whether or not its own
    /// per-address throttle swallowed the request. The copy rendered for this
    /// state says only what is true for EVERY address, so a registered address
    /// and an unregistered one produce the same screen.
    case requested(email: String)
    /// The request did not reach a 200 — a transport failure, a 429 from the
    /// edge, a 5xx. Never a claim about the address or a password.
    case failed(message: String)
    /// The form's own refusal: nothing to send. No request went out.
    case emailMissing
}

/// Asks for a password-reset email, and nothing else.
///
/// The reset itself is the website's: the emailed link opens relayium.com's
/// `/reset-password` page, which spends the one-time token and sets the new
/// password. This model never holds that token, so there is no second
/// implementation of the token lifecycle to get wrong (expiry, single use,
/// reuse after success) — the page that already enforces it is the only one.
///
/// It is separate from `AccountSession` on purpose. Asking for a reset email
/// does not change who is signed in, so it must not claim the session's
/// operation generation — a stale reset request superseding a newer sign-in
/// would be exactly the race that counter exists to prevent.
@MainActor
public final class PasswordResetRequestModel: ObservableObject {
    @Published public private(set) var state: PasswordResetRequestState = .idle

    private let send: (String) async throws -> Void
    /// A request's identity. `cancel()` and a newer request bump it, and a
    /// completion from an older one writes nothing — the sheet it belonged to
    /// may be gone, or showing a different address.
    private var generation = 0

    public init(send: @escaping (String) async throws -> Void) {
        self.send = send
    }

    public var isSending: Bool { state == .sending }

    /// Request a reset link for `email`.
    ///
    /// A second call while one is in flight is refused rather than queued: the
    /// server throttles per address anyway, so a queued second request buys
    /// nothing and costs the user a result that might mean "swallowed".
    public func request(email: String) async {
        if case .sending = state { return }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else {
            state = .emailMissing
            return
        }
        generation += 1
        let g = generation
        state = .sending
        do {
            try await send(address)
            guard g == generation else { return }
            state = .requested(email: address)
        } catch {
            guard g == generation else { return }
            // A cancelled request (the sheet closed mid-flight) asked for
            // nothing to be shown.
            guard !Task.isCancelled else {
                state = .idle
                return
            }
            state = .failed(message: ErrorCopy.message(for: error))
        }
    }

    /// The sheet closed, or the user went back to sign in. Anything still in
    /// flight belongs to nobody now.
    public func cancel() {
        generation += 1
        state = .idle
    }
}
