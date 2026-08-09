import Foundation
@preconcurrency import RelayiumKit

/// What this Mac durably saved, once, for one task.
///
/// The ONLY thing in the product that may make a "saved" claim. Nothing derives
/// it from an upload, a claim, a byte count or a state string: it is built from
/// the per-task journal AFTER `InboxCommit` has linked every planned destination
/// into the user's folder, which is the same record crash recovery reads. If the
/// journal does not say completed, no receipt exists, and there is nothing for a
/// notification, a result row or a Reveal in Finder to be built out of.
///
/// ## What it carries, and what it deliberately does not
///
/// `urls` are LOCAL absolute paths inside the user's own receive folder. They
/// exist because Reveal in Finder cannot work without them, and they never leave
/// this process: `InboxReceiptPresentation` renders counts and sizes, the
/// notification body renders counts, and the menu bar renders neither. A file
/// name is the user's own content and is readable on a locked screen, so it is
/// not something the app puts in a notification preview (PRD §7, invariant 4).
///
/// There is no account id, bearer, claim token, key id or task-target device on
/// it either. `taskID` is here for exactly one reason — de-duplicating a
/// completion that is published twice, across a retry or a relaunch — and it is
/// never rendered.
public struct InboxReceipt: Equatable, Sendable, Identifiable {
    /// De-duplication identity, never displayed.
    public let taskID: String
    /// Absolute paths this delivery created, in plan order.
    public let urls: [URL]
    /// Bytes delivered, summed from the journalled plan.
    public let byteCount: Int64
    /// When the commit completed. For a replay this is the ORIGINAL commit time
    /// taken from the journal, not the moment it was noticed again: a result list
    /// that re-dated an old delivery on every relaunch would be lying about when
    /// the user's files arrived.
    public let savedAt: Date
    /// True when the journal already said completed before this pass — a `saved`
    /// report that never reached central, being re-asserted. The files are real
    /// and already on disk, so this is a receipt, not a delivery, and nothing
    /// downstream may announce it as new.
    public let isReplay: Bool

    public var id: String { taskID }

    public init(taskID: String, urls: [URL], byteCount: Int64,
                savedAt: Date, isReplay: Bool) {
        self.taskID = taskID
        self.urls = urls
        self.byteCount = byteCount
        self.savedAt = savedAt
        self.isReplay = isReplay
    }

    public var fileCount: Int { urls.count }

    /// Build one from a completed journal, or nothing.
    ///
    /// Fails closed on every arm that is not a completed commit: no journal, a
    /// journal that does not say completed, or one whose committed list is empty.
    /// The last is the sharp one — a journal can exist with a plan and no commits
    /// at all (planned, then interrupted), and a receipt derived from `plan`
    /// rather than `committed` would name files that were never created.
    public static func make(taskID: String, journal: InboxJournal?,
                            isReplay: Bool) -> InboxReceipt? {
        guard let journal, journal.isCompleted, !journal.committed.isEmpty else { return nil }
        // Plan order, not journal-append order: the plan is what the sender's
        // manifest described, and it is stable across a resumed commit.
        let committed = Set(journal.committed)
        let entries = journal.plan.filter { committed.contains($0.destination) }
        guard !entries.isEmpty else { return nil }
        let stamp = journal.completedAt > 0 ? journal.completedAt : journal.updatedAt
        return InboxReceipt(
            taskID: taskID,
            urls: entries.map { URL(fileURLWithPath: $0.destination) },
            byteCount: entries.reduce(Int64(0)) { $0 + Int64($1.size) },
            savedAt: Date(timeIntervalSince1970: TimeInterval(stamp)),
            isReplay: isReplay)
    }
}
