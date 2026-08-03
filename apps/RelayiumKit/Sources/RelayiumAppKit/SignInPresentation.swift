import Foundation

/// What the sign-in form should show, derived from the session state.
public struct SignInFormState: Equatable {
    /// The reason the last attempt was rejected, or `nil` when there is nothing
    /// to report.
    public let errorMessage: String?
    /// An attempt is in flight: the fields stay on screen, disabled, and the
    /// button is replaced in place rather than by a sibling view.
    public let isBusy: Bool

    public init(errorMessage: String?, isBusy: Bool) {
        self.errorMessage = errorMessage
        self.isBusy = isBusy
    }
}

/// The three states the sign-in form owns, and the five it does not.
///
/// This exists so the form has exactly ONE call site. Its typed email and
/// password are `@State`, and each branch of a SwiftUI `switch` is a distinct
/// structural identity — so rendering "signing in" from a second branch tears
/// the form down and rebuilds it, blanking both fields on every wrong password.
/// The macOS app keeps the three together by hand and explains it in a comment;
/// putting the decision here makes it one `if let` in the view, and makes the
/// mapping something `swift test` can read.
public enum SignInPresentation {
    /// Non-nil for exactly the three states the form owns. Exhaustive rather
    /// than `default:`, so a new `SessionState` case cannot silently fall into
    /// "show the form".
    public static func form(for state: SessionState) -> SignInFormState? {
        switch state {
        case .loggedOut:
            return SignInFormState(errorMessage: nil, isBusy: false)
        case .authenticating:
            return SignInFormState(errorMessage: nil, isBusy: true)
        case let .failed(message):
            return SignInFormState(errorMessage: message, isBusy: false)
        case .restoring, .emailUnverified, .pendingDeletion, .ready, .unavailable:
            return nil
        }
    }
}
