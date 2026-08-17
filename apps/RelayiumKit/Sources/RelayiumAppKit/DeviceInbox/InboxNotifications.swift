import Foundation
@preconcurrency import RelayiumKit

/// What the Device Inbox is allowed to put on a notification banner.
///
/// Four cases carrying, between them, a COUNT and two closed codes — and, when a
/// message arrives, nothing whatsoever. This is the type that makes "notification
/// previews contain no user content" a property of the design rather than of
/// whoever writes the next call site: there is no field here through which a file
/// name, a destination path, an account email, a device id, a task id, a bearer
/// or key material could travel, so no future caller can add one without changing
/// this declaration and its tests.
///
/// The rule it exists for: a macOS notification preview is readable on a LOCKED
/// screen, by anyone in the room. "3 files saved" is the most a person walking
/// past may learn about what someone sent to this Mac.
public enum InboxNotification: Equatable, Sendable {
    /// A durable commit landed. `files` is a count, never a list.
    case saved(files: Int)
    /// A message landed. It carries NOTHING — not the text, not a preview, not
    /// its length, not who sent it. A macOS banner is drawn on a locked screen
    /// by anyone in the room, and "you received a message" is the most a person
    /// walking past may learn. The body is in `InboxMessageStore` and is read by
    /// the user opening the app.
    case savedMessage
    /// Something a person has to fix, named only by its closed category.
    case attention(InboxAttention)
    /// The inbox stopped for this session and will not resume on its own.
    case failed(InboxRuntimeFailure)
}

/// Where a notification actually goes.
///
/// A seam rather than `UNUserNotificationCenter` directly: the decision of WHAT
/// to publish and WHEN — which is where the duplicate-suppression rule lives — is
/// testable in `swift test`, while the platform call stays in the app target that
/// owns the authorization prompt.
public protocol InboxNotifying: AnyObject, Sendable {
    func deliver(_ notification: InboxNotification)
}

/// Decides whether a completion or a blocker is news.
///
/// Three distinct duplicates it refuses, which are three different bugs:
///
///  1. **The same task, twice in one session.** A `saved` report that central
///     never acknowledged is re-asserted on the next claim; the files did not
///     arrive twice and the user must not be told they did.
///  2. **The same task, after a relaunch.** Handled upstream and re-checked here:
///     a receipt built from a journal that already said completed is a REPLAY,
///     and a replay is evidence, not an event. The result row still appears —
///     the files are genuinely there — but nothing buzzes.
///  3. **The same blocker, every backoff cycle.** A revoked folder grant is
///     re-measured on every pass, and a banner per pass would turn one problem
///     into a stream of notifications the user learns to dismiss unread. It is
///     announced once and re-armed only after the condition clears.
///
/// Not persisted to disk. The relaunch case is covered by the replay flag, which
/// is derived from the journal the commit itself wrote — a durable record that is
/// already the authority on what happened, rather than a second one that could
/// disagree with it.
public final class InboxNotificationLedger: @unchecked Sendable {
    private let lock = NSLock()
    private var announced: Set<String> = []
    private var currentAttention: InboxAttention?
    private var currentFailure: InboxRuntimeFailure?

    public init() {}

    /// Whether this terminal failure is news. A generation that keeps failing the
    /// same way says so once.
    public func shouldAnnounce(_ failure: InboxRuntimeFailure) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard currentFailure != failure else { return false }
        currentFailure = failure
        return true
    }

    /// Whether this receipt is news. A replay never is.
    public func shouldAnnounce(_ receipt: InboxReceipt) -> Bool {
        guard !receipt.isReplay else { return false }
        lock.lock(); defer { lock.unlock() }
        return announced.insert(receipt.taskID).inserted
    }

    /// Whether this blocker is news. The same blocker repeated is not; a
    /// DIFFERENT blocker is, even while the previous one is unresolved, because
    /// the action it asks for has changed.
    public func shouldAnnounce(_ attention: InboxAttention) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard currentAttention != attention else { return false }
        currentAttention = attention
        return true
    }

    /// The blocker cleared. Re-arms the banner so a problem that comes back is
    /// announced again rather than suppressed forever by a stale memory.
    public func attentionCleared() {
        lock.lock(); defer { lock.unlock() }
        currentAttention = nil
        currentFailure = nil
    }

    /// Forget everything. Called on a generation change: account B must not
    /// inherit account A's idea of what has already been announced, in either
    /// direction.
    public func reset() {
        lock.lock(); defer { lock.unlock() }
        announced.removeAll()
        currentAttention = nil
        currentFailure = nil
    }
}
