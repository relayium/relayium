import Foundation
import RelayiumKit
import RelayiumShareKit

/// One waiting shared draft, as the Send surface renders it.
///
/// Deliberately not the plan: the view receives no staged URLs or container
/// layout. It does receive the manifest-safe display identity and size of each
/// file, because a count and total cannot distinguish several waiting drafts or
/// answer what the user is about to adopt.
public struct SharedDraftSummary: Equatable, Identifiable, Sendable {
    public let id: String
    public let fileCount: Int
    public let totalBytes: Int
    public let files: [FileMeta]

    public init(id: String, fileCount: Int, totalBytes: Int, files: [FileMeta] = []) {
        self.id = id
        self.fileCount = fileCount
        self.totalBytes = totalBytes
        self.files = files
    }

    public init(_ plan: SharedDraftPlan) {
        self.init(id: plan.id, fileCount: plan.files.count, totalBytes: plan.totalBytes,
                  files: plan.files.map { file in
                      FileMeta(name: file.name, size: file.size,
                               path: file.name.contains("/") ? file.name : nil)
                  })
    }
}

/// Why the Send surface will not let a waiting draft be used right now.
///
/// A named reason rather than a disabled button: "Use these files" that does
/// nothing, with no sentence beside it, is indistinguishable from a bug. Each
/// case maps to copy in `SharedDraftGate`, where a test can read it.
public enum SharedDraftRefusal: Equatable, Sendable {
    /// No ready account. The draft is safe and stays; it just cannot become an
    /// upload, because an upload belongs to an account.
    case needsAccount
    /// An upload, a recovery offer, a finished link or an unrelated selection
    /// occupies the screen. Adopting would overwrite work the user can still
    /// act on.
    case busy
}

/// A refusal, and the draft it belongs to.
///
/// The pairing is the whole point. The Send tab draws one card per waiting
/// draft, and a refusal held as a bare reason has no way of saying which card
/// asked — so pressing "Use these files" on one draft would put the sentence
/// under all of them, and the other four would read as refused for a reason
/// nobody gave them.
public struct SharedDraftRefusalNotice: Equatable, Sendable {
    public let draftId: String
    public let reason: SharedDraftRefusal

    public init(draftId: String, reason: SharedDraftRefusal) {
        self.draftId = draftId
        self.reason = reason
    }

    /// Whether this notice belongs under a given draft's card.
    public func applies(to id: String) -> Bool { draftId == id }
}

/// The one place the refusal becomes words, and the one place the decision is
/// made from the two states it depends on.
///
/// It lives here rather than in `SendView` for the reason every other decision
/// in this package does: a `switch` inside a SwiftUI computed property is not
/// something `swift test` can reach, and this one governs whether a user's files
/// can be overwritten.
public enum SharedDraftGate {
    /// Whether a waiting draft may be adopted, given the account and what the
    /// upload model currently holds.
    ///
    /// `.idle` only. Every other upload state is either work in flight
    /// (`preparing`, `uploading`, `restarting`, `checkingRecovery`), a
    /// recoverable job the user has not answered for yet (`interrupted`), a
    /// result they may not have copied (`done`), a failure they are reading
    /// (`failed`), or a selection they made themselves (`picked`). Replacing any
    /// of those with a draft would be this app throwing away something the user
    /// still has a use for.
    public static func refusal(hasReadyAccount: Bool,
                               upload state: UploadState) -> SharedDraftRefusal? {
        guard hasReadyAccount else { return .needsAccount }
        guard case .idle = state else { return .busy }
        return nil
    }

    public static func message(for refusal: SharedDraftRefusal,
                               language: AppLanguage? = nil) -> String {
        switch refusal {
        case .needsAccount: return L10n.t(.shareSignedOutBody, language: language)
        case .busy: return L10n.t(.shareBusyBody, language: language)
        }
    }

    /// The card's one-line description of what is waiting.
    public static func waitingBody(fileCount: Int, language: AppLanguage? = nil) -> String {
        L10n.t(.shareWaitingBody,
               [L10n.plural(.downloadFileCount, fileCount, language: language)],
               language: language)
    }
}
