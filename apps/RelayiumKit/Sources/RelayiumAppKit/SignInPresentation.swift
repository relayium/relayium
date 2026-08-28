import Foundation
import RelayiumShareKit

/// Which half of the account form is on screen.
///
/// One form with a mode, not two forms. The typed email is the same email either
/// way, and a user who tried to sign in, was told the account does not exist and
/// then had to retype the address into a separate screen would be doing the
/// app's bookkeeping for it.
public enum AuthMode: String, Equatable, CaseIterable, Sendable {
    case signIn
    case register

    public var toggled: AuthMode { self == .signIn ? .register : .signIn }

    /// The primary button.
    public var submitTitleKey: L10nKey {
        self == .signIn ? .loginSignIn : .loginCreateAccount
    }

    /// The form's product-level heading and explanation.
    public var titleKey: L10nKey {
        self == .signIn ? .loginSignInTitle : .loginRegisterTitle
    }

    public var bodyKey: L10nKey {
        self == .signIn ? .loginSignInBody : .loginRegisterBody
    }

    /// The control that switches modes. Two different registers on purpose:
    /// leaving sign-in is an invitation ("New here?"), and leaving
    /// create-account is a return to something the user already knows about.
    public var switchTitleKey: L10nKey {
        self == .signIn ? .loginNeedAccount : .contentBackToSignIn
    }
}

/// What is in flight, if anything.
///
/// A tri-state rather than a `Bool`, because the two operations end in different
/// places and the label has to say which one is running: a registration that
/// reported "Signing in…" would be naming an outcome it cannot reach.
public enum AuthActivity: Equatable, Sendable {
    case idle
    case signingIn
    case creatingAccount

    /// The label shown in place of the primary button, or nil when idle.
    public var busyTitleKey: L10nKey? {
        switch self {
        case .idle:            return nil
        case .signingIn:       return .loginSigningIn
        case .creatingAccount: return .loginCreatingAccount
        }
    }
}

/// What the sign-in / create-account form should show, derived from the session
/// state.
public struct SignInFormState: Equatable {
    /// The reason the last attempt was rejected, or `nil` when there is nothing
    /// to report.
    public let errorMessage: String?
    /// An attempt is in flight: the fields stay on screen, disabled, and the
    /// button is replaced in place rather than by a sibling view.
    public let activity: AuthActivity

    public init(errorMessage: String?, activity: AuthActivity) {
        self.errorMessage = errorMessage
        self.activity = activity
    }

    public var isBusy: Bool { activity != .idle }
}

/// What the user has typed. All four fields, whichever mode is showing — the two
/// the sign-in half does not use are simply not rendered, and are never sent.
public struct RegistrationDraft: Equatable, Sendable {
    /// Optional to the server and optional here. Sent as typed; it is the user's
    /// own text and is never translated.
    public var displayName: String
    public var email: String
    public var password: String
    public var confirmPassword: String

    public init(displayName: String = "",
                email: String = "",
                password: String = "",
                confirmPassword: String = "") {
        self.displayName = displayName
        self.email = email
        self.password = password
        self.confirmPassword = confirmPassword
    }
}

/// A reason the form will not send what has been typed.
///
/// Checked in the app so the three most common mistakes cost no round trip, no
/// rate-limit budget and no wait — and, for a mistyped confirmation, so the
/// server is never asked to guess which of the two passwords was meant.
public enum RegistrationProblem: Equatable, Sendable {
    case emailMissing
    case passwordTooShort
    case passwordsDiffer

    /// The sentence to show. `passwordTooShort` borrows the SERVER's key: it is
    /// the server's rule, and one rule stated two ways is two rules to keep in
    /// step across every shipped catalog.
    public var messageKey: L10nKey {
        switch self {
        case .emailMissing:     return .loginErrorEmailMissing
        case .passwordTooShort: return .errorAccountPasswordTooShort
        case .passwordsDiffer:  return .loginErrorPasswordsDiffer
        }
    }
}

/// The three states the sign-in form owns, and the five it does not.
///
/// This exists so the form has exactly ONE call site. Its typed fields and its
/// mode are `@State`, and each branch of a SwiftUI `switch` is a distinct
/// structural identity — so rendering "signing in" from a second branch tears
/// the form down and rebuilds it, blanking every field on every wrong password
/// and dropping a half-filled registration back onto the sign-in half.
public enum SignInPresentation {
    /// The server's own minimum, in **bytes**: Go's `len(password) < 8` counts
    /// UTF-8 bytes, so a six-character Chinese password is eighteen bytes and
    /// passes, while a seven-character ASCII one does not. Counting characters
    /// here would refuse passwords the server accepts.
    public static let minimumPasswordBytes = 8

    /// Non-nil for exactly the four states the form owns. Exhaustive rather
    /// than `default:`, so a new `SessionState` case cannot silently fall into
    /// "show the form".
    public static func form(for state: SessionState) -> SignInFormState? {
        switch state {
        case .loggedOut:
            return SignInFormState(errorMessage: nil, activity: .idle)
        case .authenticating:
            return SignInFormState(errorMessage: nil, activity: .signingIn)
        case .registering:
            return SignInFormState(errorMessage: nil, activity: .creatingAccount)
        case let .failed(message):
            return SignInFormState(errorMessage: message, activity: .idle)
        case .restoring, .emailUnverified, .pendingDeletion, .ready, .unavailable:
            return nil
        }
    }

    /// Whether the primary button does anything.
    ///
    /// Emptiness only — the same rule the sign-in half has always used. The
    /// substantive checks are deliberately NOT here: a button greyed out because
    /// two passwords differ states no reason and offers no way forward, which is
    /// the pattern `CapabilityGateView` exists to remove from the rest of the
    /// app. They run on submit and produce a sentence instead.
    public static func canSubmit(mode: AuthMode,
                                 draft: RegistrationDraft,
                                 isBusy: Bool) -> Bool {
        guard !isBusy else { return false }
        guard !draft.email.isEmpty, !draft.password.isEmpty else { return false }
        if mode == .register, draft.confirmPassword.isEmpty { return false }
        return true
    }

    /// Why a registration will not be sent, or nil when it will.
    ///
    /// Ordered by what the user should fix first, and each check is about ONE
    /// field so the message always names something on screen. Whitespace-only
    /// input counts as missing: the server trims and would refuse it anyway,
    /// having spent a rate-limit slot to do so.
    public static func problem(in draft: RegistrationDraft) -> RegistrationProblem? {
        if draft.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .emailMissing
        }
        if draft.password.utf8.count < minimumPasswordBytes {
            return .passwordTooShort
        }
        if draft.password != draft.confirmPassword {
            return .passwordsDiffer
        }
        return nil
    }
}
