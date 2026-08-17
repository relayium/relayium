import Foundation
@preconcurrency import RelayiumKit

/// Everything this Mac's Device Inbox can honestly be, as a closed set.
///
/// An enum with no `default:` anywhere that renders it, for the reason the menu
/// bar already learned once: a `default:` said "Not signed in" while a token was
/// in hand and the account was merely loading, which is exactly the moment the
/// user has no other surface to look at. Here the equivalent mistake is worse —
/// the fall-through state would be `ready`, and `ready` is a promise to a
/// STRANGER that their file will land on this machine.
///
/// So there is no state that means "something else". An internal error, an
/// unrecognised condition, a keychain that refuses, an enrolment central will not
/// accept: all of them are `failed`, which says so and offers the next action.
/// Failing closed here is the difference between a sender seeing "this Mac cannot
/// take deliveries right now" and a sender watching a task that will never move.
public enum InboxRuntimeState: Equatable, Sendable {
    /// No account. The feature is account-bound end to end — the keys, the
    /// folder grant and the policy are all keyed by account id — so this is a
    /// real state and not an error.
    case signedOut
    /// Signed in, and the device row, enrolment and key are still being
    /// established. Distinct from `ready` because nothing can be claimed yet, and
    /// distinct from `offline` because nothing has failed.
    case loading
    /// The user's own answer is Off. Nothing is wrong.
    case disabled
    /// Receiving is on and no folder is chosen. Reachable only as a repair state
    /// — the policy setter refuses a non-`off` answer without a folder — so it
    /// means a grant went missing under a policy that is still on, and it says
    /// what to do about it rather than silently going quiet.
    case folderMissing
    /// Enrolled, folder proven writable, nothing to do. Carries the policy so
    /// "waiting for files" and "waiting to ask you about files" are different
    /// sentences.
    case ready(InboxAutoAccept)
    /// Central is holding deliveries for an answer under the `ask` policy.
    /// Nothing is downloaded and nothing is written until the user says yes.
    case asking(count: Int)
    /// The user paused. Sticky across passes, cleared only by an explicit resume.
    case paused
    /// A delivery is being worked right now.
    case working
    /// Something a person has to fix. Never merged into `offline`: a revoked
    /// folder grant does not resolve itself by waiting, and telling a user to
    /// wait for it is how a stalled inbox looks fine for a week.
    case attention(InboxAttention)
    /// Central is unreachable. The last known-good local configuration stands;
    /// what is unknown is central's view, not the folder or the policy.
    /// `retryInSeconds` is the bounded backoff already scheduled, so the UI can
    /// say when rather than spin.
    case offline(retryInSeconds: Int?)
    /// A delivery just landed. Set only from a durable commit receipt, and
    /// replaced by the next state the loop reaches.
    case saved(files: Int)
    /// A MESSAGE just landed. A separate case rather than `saved(files: 0)`,
    /// because that sentence would be false twice over: nothing was saved to the
    /// user's folder, and something was in fact received. It carries no length
    /// and no preview — the status line is rendered in the menu bar, over a
    /// shared screen, and what arrived is the user's own content.
    case savedMessage
    /// Terminal for this generation: nothing further will be attempted until the
    /// user acts or the account changes.
    case failed(InboxRuntimeFailure)

    /// Whether this state permits a claim. Deliberately narrow, and deliberately
    /// NOT derived from "no error": `loading`, `asking` and `saved` are all
    /// blameless states in which claiming would still be wrong.
    public var isReceiving: Bool {
        if case .ready = self { return true }
        return false
    }

    /// Whether the user's own pause is what is stopping work.
    public var isPaused: Bool { self == .paused }
}

/// The two kinds of blocker a person can act on, kept apart because the actions
/// are different: one is about the folder, the other about one delivery.
public enum InboxAttention: Equatable, Sendable {
    /// The receive folder cannot be used right now.
    case folder(InboxFolderProblem)
    /// A delivery was parked with a local blocker central is now holding.
    case delivery(InboxDeviceErrorCode)
}

/// Why the inbox stopped, when it is not the folder and not the network.
///
/// A closed set with no `other(String)` case. A free-form string here would be
/// the one place a bearer, a path or a file name could reach a crash report or a
/// screenshot, and the recovery advice does not vary by error text anyway.
public enum InboxRuntimeFailure: String, Equatable, Sendable, CaseIterable {
    /// Central would not enrol this device for the inbox.
    case enrolmentRefused
    /// This device's key history could not be read or written — a locked or
    /// refusing keychain.
    case keyUnavailable
    /// The signed-in account or device row cannot be used as an identity here.
    case identity
    /// Anything else at all. The fail-closed arm: it exists so that no unknown
    /// condition can fall through to `ready`.
    case unknown
}
