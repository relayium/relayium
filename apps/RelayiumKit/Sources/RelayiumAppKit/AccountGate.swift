import Foundation
import RelayiumKit
import RelayiumShareKit

/// What a feature that genuinely needs an account gets when it has one.
///
/// `retentionSecs` rides along because the stored-send surface needs it for
/// `CloudUploadModel.applyRetentionCap` and it is only knowable from `.ready`'s
/// usage payload. Carrying it here is what removes the `session.bearerToken ??
/// ""` empty-string sentinel and the separate retention lookup that used to be
/// threaded through the view layer side by side.
public struct AccountAccess: Equatable, Sendable {
    public let token: String
    public let retentionSecs: Int64

    public init(token: String, retentionSecs: Int64) {
        self.token = token
        self.retentionSecs = retentionSecs
    }
}

/// Whether one account-backed capability may run, and if not, what is true
/// instead.
///
/// This replaces four ad-hoc patterns that each answered the question
/// differently: the root `session.state` switch that hid the whole app behind a
/// sign-in form, `UploadPane`'s bare `.disabled(token.isEmpty)`, the hand-rolled
/// `if token.isEmpty` hint in the text pane, and the empty-string bearer
/// sentinel. A greyed control states nothing and offers nothing; every case
/// here names a reason and implies the action that resolves it.
public enum AccountGate: Equatable {
    case allowed(AccountAccess)
    case loading
    case signInRequired
    case unavailable(message: String)
    case verifyEmail(email: String)
    case pendingDeletion(purgeAfter: Int64, reactivateToken: String)

    /// The mapping, total over `SessionState`.
    ///
    /// The `switch` carries **no `default`**: that absence is the exhaustiveness
    /// proof, so a new session state is a compile error here rather than a
    /// capability that silently starts claiming one of these reasons.
    ///
    /// `language` follows the convention the rest of this layer uses
    /// (`NearbyStatusPresentation`, `AccountPresentation`, `ErrorCopy`): it
    /// defaults to the app's current language, and a test passes it explicitly
    /// so an assertion about copy cannot depend on the machine it runs on.
    public static func from(_ state: SessionState,
                            bearer: String?,
                            language: AppLanguage? = nil) -> AccountGate {
        switch state {
        case .restoring, .authenticating:
            // Not "sign in". Restoring is a keychain read that usually succeeds,
            // and a gate that asks for a password during it is a lie the user
            // acts on — by typing credentials they did not need to.
            return .loading
        case .loggedOut:
            return .signInRequired
        case .registering:
            // NOT `.loading`. A registration in flight cannot produce an account
            // for this capability — it ends on the check-email screen at best —
            // so "hold on, we're finding out who you are" would be false, and a
            // spinner that resolved into a gate anyway is worse than the gate.
            return .signInRequired
        case .failed:
            // The reason a sign-in attempt was rejected belongs on the form,
            // beside the fields that produced it — not on a feature card
            // somewhere else in the app.
            return .signInRequired
        case let .unavailable(message):
            return .unavailable(message: message)
        case let .emailUnverified(email):
            return .verifyEmail(email: email)
        case let .pendingDeletion(purgeAfter, reactivateToken):
            return .pendingDeletion(purgeAfter: purgeAfter, reactivateToken: reactivateToken)
        case let .ready(_, usage):
            // `.signInRequired` here would be the sharpest lie the old shell
            // could tell: this user IS signed in, and the thing that broke is
            // the credential, which signing in again on this form cannot reach.
            // `account.bearerInvalid` already says the true thing and names the
            // remedy — sign out, then sign in again.
            guard let bearer, !bearer.isEmpty else {
                return .unavailable(message: L10n.t(.accountBearerInvalid, language: language))
            }
            return .allowed(AccountAccess(token: bearer,
                                          retentionSecs: usage.plan.retentionSecs))
        }
    }
}
