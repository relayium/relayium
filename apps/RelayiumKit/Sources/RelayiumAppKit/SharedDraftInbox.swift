import Foundation
import RelayiumShareKit

/// What the app does with drafts the Share extension left in the App Group.
///
/// The extension cannot open its containing app, so a shared draft sits in the
/// group container until the user opens Relayium themselves. This is the object
/// that notices, hands the files to the send flow, and eventually cleans up.
///
/// **Why adoption does not retire the draft.** `SharedDraftStore.retire` means
/// "the app has durably taken ownership" and it deletes the bytes. On iOS that is
/// safe because a pending upload plan and its content key are committed first —
/// the bytes have been superseded by something durable. macOS's send paths have
/// no such record: a realtime send reads the files at the moment it sends, so
/// deleting them at adoption would hand the user a selection whose files no
/// longer exist. Nothing in the UI would say so until Send failed.
///
/// **So retirement is deferred by exactly one launch.** Ids adopted in an earlier
/// session are retired at the start of the next one, and only then are new
/// drafts adopted. The bytes therefore live for at least the whole session in
/// which they were staged, which covers any send the user makes in it, and the
/// container cannot grow without bound because every launch collects the
/// previous round. A draft is never offered twice, because its id is recorded
/// before it is handed over.
///
/// The trade-off is stated rather than hidden: a Mac left running for days keeps
/// one round of shared bytes on disk. Deleting them sooner would need a durable
/// record of an in-flight send, which macOS does not have and which this object
/// must not invent.
@MainActor
public final class SharedDraftInbox {
    /// The ids handed to the send flow in some session, waiting to be retired at
    /// the start of a later one.
    ///
    /// In `UserDefaults` rather than in the container: it is this app's memory
    /// of what it has done, not shared state, and the extension must never read
    /// or write it. Losing it is safe in the only direction that matters —
    /// a forgotten id means a draft is offered again, which shows the user their
    /// own files a second time. The opposite error would delete files they had
    /// not seen.
    public static let defaultsKey = "com.relayium.adoptedSharedDrafts"

    private let store: SharedDraftStore?
    private let defaults: UserDefaults

    /// `store` is nil when the App Group cannot be resolved — the un-provisioned
    /// development build. Everything else in the app goes on working; shared
    /// drafts simply never arrive, because nothing can write one.
    public init(store: SharedDraftStore?, defaults: UserDefaults = .standard) {
        self.store = store
        self.defaults = defaults
    }

    /// Retire what a previous session adopted, then adopt whatever is new.
    ///
    /// Returns the staged files, in draft order, for the caller to hand to the
    /// send flow. Empty is the ordinary case and is not an error.
    ///
    /// Safe to call repeatedly — on every activation, which is what the app
    /// does. A second call in the same session retires nothing new (the ids it
    /// just recorded are this session's) and adopts nothing new (their drafts
    /// are already recorded).
    @discardableResult
    public func collect() -> [URL] {
        guard let store else { return [] }

        // First, because a draft adopted earlier must not be re-offered by the
        // listing below, and because doing it after would retire ids this call
        // has only just recorded.
        let previouslyAdopted = Set(defaults.stringArray(forKey: Self.defaultsKey) ?? [])
        for id in previouslyAdopted {
            store.retire(id: id)
        }
        // Anything still listed after those retirements is genuinely new. A
        // retirement whose physical removal failed stays hidden from `drafts()`
        // by its marker, so it cannot come back around here.
        store.retryRetirements()

        var adopted: [String] = []
        var files: [URL] = []
        for plan in store.drafts() {
            // A draft whose files cannot be listed is left alone rather than
            // recorded: recording it would retire it next launch without the
            // user ever having seen it.
            guard let staged = try? store.stagedFiles(for: plan), !staged.isEmpty,
                  let roots = try? nameRestoredRoots(for: plan.id, staged: staged),
                  !roots.isEmpty else { continue }
            adopted.append(plan.id)
            files.append(contentsOf: roots)
        }
        // Written even when `files` is empty of new drafts, because the set has
        // changed: this session's adoptions replace the previous session's,
        // which have just been retired.
        defaults.set(adopted, forKey: Self.defaultsKey)
        return files
    }

    /// The send flow reads a file's name from its URL. The store does not keep
    /// it there.
    ///
    /// `stagedFiles` returns `(name:, url:)` where the URL's last component is an
    /// INDEX — `0`, `1`, `2` — and the manifest name is the other half of the
    /// pair. That is the store's own safety property: a hostile name never
    /// reaches the filesystem. But `expandSelection` derives what the receiver
    /// sees from the URL, so handing those URLs straight over would send the
    /// user's files across the network named `0` and `1`. A test caught it; no
    /// screenshot would have.
    ///
    /// So this rebuilds the names as **hard links** inside the draft's own
    /// directory. Links rather than copies because the bytes may be large and
    /// this is the same volume; inside the draft rather than in a new app-owned
    /// directory because that keeps ONE lifetime — retiring the draft removes
    /// the links with it, and no second cleanup path has to be invented.
    ///
    /// Returns the TOP-LEVEL entries, not the tree's root, so a shared folder
    /// keeps its own name and a loose file stays loose — the same shape a drop
    /// produces, which is what `expandSelection` is written against.
    private func nameRestoredRoots(for id: String,
                                   staged: [(name: String, url: URL)]) throws -> [URL] {
        guard let store else { return [] }
        let manager = FileManager.default
        // The store's own answer for where this draft lives, never
        // `AppGroup.sharedDraftRoot()`. Resolving the real container here would
        // make every test of this type inspect — and create state in — the
        // production group directory of whichever Mac runs the suite, which is
        // the trap `SharedDraftStoreTests` already records for its own fixtures.
        let base = store.draftURL(id: id)
            // nonlocalized: a directory name inside the app's own container
            .appendingPathComponent("named", isDirectory: true)
        // Rebuilt from scratch, so a half-written round from a previous launch
        // cannot contribute a stale or duplicated entry.
        try? manager.removeItem(at: base)
        try manager.createDirectory(at: base, withIntermediateDirectories: true)

        var tops: [String] = []
        var seen = Set<String>()
        for entry in staged {
            // The store wrote these names and validates them, but this is the
            // one place they are turned back into paths, so they are treated as
            // hostile here too. Anything that could escape the directory, or
            // that is not a plain relative path, is skipped rather than repaired.
            let parts = entry.name.split(separator: "/", omittingEmptySubsequences: false)
            guard !parts.isEmpty,
                  !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  !entry.name.hasPrefix("/") else { continue }
            let destination = parts.reduce(base) { $0.appendingPathComponent(String($1)) }
            try? manager.createDirectory(at: destination.deletingLastPathComponent(),
                                         withIntermediateDirectories: true)
            // A link, not a copy. If the link cannot be made the entry is
            // dropped rather than silently sent under the wrong name.
            guard (try? manager.linkItem(at: entry.url, to: destination)) != nil else { continue }
            let top = String(parts[0])
            if seen.insert(top).inserted { tops.append(top) }
        }
        return tops.map { base.appendingPathComponent($0) }
    }
}
