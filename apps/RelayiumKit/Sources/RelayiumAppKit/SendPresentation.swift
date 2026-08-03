import Foundation
import RelayiumKit

/// The pure decisions the send screen rests on.
///
/// Same seam shape `SignInPresentation` established, for the same reason: a
/// product rule inside a SwiftUI `switch` is a rule no test can read, and "who
/// is allowed to send", "what a ready account contributes" and "what an empty
/// picker change means" are not rules to leave unreadable.
///
/// Every `switch` over `SessionState` here is exhaustive, with no `default:`, so
/// a new session case is a compile error rather than a silent "can send".

/// What the Send tab draws, before any upload state is considered.
///
/// **Presentation only.** It decides what is *drawn*; it never decides what is
/// *cancelled or cleared*. That is `SendSelectionModel`'s job, driven by the
/// session, and it happens whether or not this view has ever been mounted.
public enum SendAvailability: Equatable {
    /// The session is still working out who this is.
    case checking
    /// There is no usable account, and signing in is the remedy.
    case needsAccount
    /// A token is held and the account did not load. Split out from
    /// `.needsAccount` because the two are different facts: one user needs to
    /// sign in, the other *is* signed in. Telling the second one to sign in
    /// would be a false sentence with a useless remedy.
    case accountUnavailable
    case ready

    public static func state(for state: SessionState) -> SendAvailability {
        switch state {
        case .restoring, .authenticating:
            return .checking
        case .ready:
            return .ready
        case .unavailable:
            return .accountUnavailable
        case .loggedOut, .failed, .emailUnverified, .pendingDeletion, .registering:
            // `.registering` sits here rather than with `.checking` for the same
            // reason `AccountGate` puts it under "sign in required": creating an
            // account never ends in one that can send, so a spinner would be
            // waiting for something that is not coming.
            return .needsAccount
        }
    }
}

/// What a ready account contributes to the send screen.
///
/// `.none` for every other session state — including `.unavailable`, where a
/// token is held but the plan is unknown, and a screen that guessed a retention
/// there would offer options the server truncates.
public struct SendAccountContext: Equatable, Sendable {
    /// nil == no ready account. The **id**, never the email: an email can
    /// change, and an isolation rule keyed on it would read as an account switch
    /// that never happened.
    public let userId: String?
    public let retentionSecs: Int64

    public init(userId: String?, retentionSecs: Int64) {
        self.userId = userId
        self.retentionSecs = retentionSecs
    }

    public static let none = SendAccountContext(userId: nil, retentionSecs: 0)

    public static func context(for state: SessionState) -> SendAccountContext {
        switch state {
        case let .ready(user, usage):
            return SendAccountContext(userId: user.id, retentionSecs: usage.plan.retentionSecs)
        case .restoring, .loggedOut, .authenticating, .registering,
             .emailUnverified, .pendingDeletion, .failed, .unavailable:
            return .none
        }
    }
}

/// The advisory limits, as one value.
///
/// A pair rather than two properties so they can only be set and cleared
/// together: a size gate that outlived the retention it arrived with would be
/// one account's plan bounding another account's picker.
public struct UploadCaps: Equatable, Sendable {
    /// 0 == unknown, which offers every TTL and lets the server truncate.
    public let retentionSecs: Int64
    /// 0 == unknown, which turns the client-side size gate off. The server
    /// enforces the real cap during `PATCH` either way.
    public let maxFileSize: Int64

    public init(retentionSecs: Int64, maxFileSize: Int64) {
        self.retentionSecs = retentionSecs
        self.maxFileSize = maxFileSize
    }

    public static let unknown = UploadCaps(retentionSecs: 0, maxFileSize: 0)
}

/// What a change to the `PhotosPicker` binding means.
///
/// Two facts that must not be conflated: the user chose something, and the view
/// reset the binding to make the same choice fire again. The second is not a
/// product change, and calling `importPhotos(count: 0)` for it would clear a
/// selection the user never asked to clear. Cancelling the system picker changes
/// the binding not at all, so it reaches this seam not at all.
public enum PhotoPickerChange: Equatable {
    /// Our own programmatic reset, or a change carrying nothing. Do NOTHING —
    /// in particular, do not clear the product selection.
    case ignore
    case importItems(count: Int)

    public static func decide(itemCount: Int) -> PhotoPickerChange {
        itemCount > 0 ? .importItems(count: itemCount) : .ignore
    }
}
