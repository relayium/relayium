import Foundation
import RelayiumShareKit

/// Which shared drafts this app has already had its one chance to load on its
/// own.
///
/// A draft the share extension staged is loaded into the Send selection
/// automatically at most ONCE: the first time the user brings Relayium forward
/// after sharing it, and only when nothing else is on the Send screen. Every
/// draft the app has considered for that — adopted, refused, or passed over
/// because several arrived at once — is recorded here, so that
///
///  - Clear really clears: the draft goes back to its card and stays there, in
///    this process and in the next one iOS starts after killing this one;
///  - a draft handed back by one account is never loaded for the next;
///  - the drafts already waiting when this version first runs are recorded as
///    handled rather than treated as new, because nothing about them says the
///    user meant them now.
///
/// **What is stored is opaque draft ids and nothing else** — no names, sizes,
/// paths or bytes — in this app's own defaults. The share extension neither
/// reads nor writes it. A missing key means "never seeded"; an empty array
/// means "seeded, nothing handled".
///
/// Entries are removed only when the draft's own directory is provably gone,
/// never because a lookup came back empty or false. An inbox that cannot be
/// read looks exactly like an empty one — and a directory behind a parent this
/// process may not search makes `fileExists` answer false — so forgetting on
/// either would make every waiting draft new again. "Provably gone" is the
/// filesystem itself answering `ENOENT`; every other failure, including a
/// Cocoa "no such file" that is really a permission refusal, decides nothing.
@MainActor
public final class SharedDraftArrivalLedger {
    // nonlocalized: a defaults key, never displayed.
    public nonisolated static let defaultsKey = "sharedDraftArrivals.handled.v1"

    private let defaults: UserDefaults
    private let key: String
    private var handled: Set<String>
    public private(set) var isSeeded: Bool

    public init(defaults: UserDefaults, key: String = SharedDraftArrivalLedger.defaultsKey) {
        self.defaults = defaults
        self.key = key
        if let stored = defaults.array(forKey: key) {
            handled = Set(stored.compactMap { $0 as? String })
            isSeeded = true
        } else {
            handled = []
            isSeeded = false
        }
    }

    public func contains(_ id: String) -> Bool { handled.contains(id) }

    /// Everything waiting the first time this version lists the inbox.
    public func seed<S: Sequence>(_ ids: S) where S.Element == String {
        handled.formUnion(ids)
        isSeeded = true
        persist()
    }

    /// Record ids as handled. Written through immediately: the caller records
    /// BEFORE it adopts, so a crash in between leaves a card rather than a draft
    /// that loads itself every launch.
    ///
    /// Before the first seed it is held in memory only. Persisting it would
    /// mark the ledger seeded with one id, and every OTHER draft already waiting
    /// would then look newly shared.
    public func record<S: Sequence>(_ ids: S) where S.Element == String {
        let before = handled.count
        handled.formUnion(ids)
        guard isSeeded, handled.count != before else { return }
        persist()
    }

    public func forget(_ id: String) {
        guard handled.remove(id) != nil else { return }
        persist()
    }

    /// Drop every id whose draft directory is no longer in `present`, the full
    /// set of entry names of a root that was actually listed.
    func retain(present: Set<String>) {
        let kept = handled.intersection(present)
        guard kept.count != handled.count else { return }
        handled = kept
        persist()
    }

    private func persist() {
        defaults.set(handled.sorted(), forKey: key)
    }

    /// The entry names directly under `root`, `[]` when there provably is no
    /// root yet, or nil when it could not be listed for any other reason —
    /// which is the case that must neither seed nor prune.
    ///
    /// Absence is not inferred from the listing's error. A root whose PARENT
    /// this process may not search fails to list with Cocoa's "no such file"
    /// and `fileExists` answers false, although the root and every draft in it
    /// are still there; only `isProvablyAbsent` tells the two apart.
    nonisolated static func presentEntries(in root: URL,
                                           fileManager: FileManager = .default) -> Set<String>? {
        if let names = try? fileManager.contentsOfDirectory(atPath: root.path) { return Set(names) }
        return isProvablyAbsent(root) ? [] : nil
    }

    /// Whether nothing at all exists at `url`, as the filesystem itself
    /// reports it: `lstat` failing with `ENOENT`, for the entry or for a
    /// directory above it. A permission refusal, a component that is not a
    /// directory, or anything else unexpected is NOT absence.
    nonisolated static func isProvablyAbsent(_ url: URL) -> Bool {
        var info = stat()
        guard lstat(url.path, &info) != 0 else { return false }
        return errno == ENOENT
    }

    /// The draft ids positively known to be waiting: every directory name in a
    /// listed root that has the shape of a draft id, plus whatever the store
    /// managed to decode. Seeding takes BOTH, because a plan that is
    /// momentarily unreadable leaves its draft out of the store's list while
    /// its directory is plainly there — and a draft left out of the seed would
    /// come back later looking newly shared. Only opaque ids are kept.
    nonisolated static func knownDraftIds<S: Sequence>(present: Set<String>, listed: S) -> Set<String>
        where S.Element == String {
        present.union(listed).filter(SharedDraftID.isValid)
    }
}
