import Foundation
import RelayiumKit

#if DEBUG
/// Empties a UI-test pending-upload root WITHOUT orphaning its content keys.
///
/// **Debug-only, and a compile-time absence in Release** — the same shape as
/// `UITestMode`, its only caller. A shipped build never discards a staging
/// root, so it has no use for this, and must not carry a function whose whole
/// job is to delete pending-upload keys.
///
/// **Why it exists.** An acceptance launch stages into a root of its own and
/// empties it before use, so a run never inherits the previous run's
/// interrupted job. The staged bytes live in that directory, but each job's
/// content key does not: until N-0928-6 option A,
/// `AppEnvironment.makePendingUploadSupport` always paired the store with the
/// product's keychain namespace (`pending-upload-key:<jobId>`), because the
/// app's composition root is shared with Release. Deleting only the directory
/// therefore left one keychain item behind per staged job, every run, on every
/// developer Mac and simulator that ran the suite.
///
/// **Why keys are removed by the ids of the directories being discarded**, and
/// never by enumerating the keychain: those items share a namespace with the
/// installed product's real pending uploads. Only a job whose directory is
/// inside the discarded roots is provably this suite's, so only its id may be
/// named. A key whose job lives anywhere else is not touched.
///
/// **Since N-0928-6 option A, a UI-test launch no longer writes those keys**:
/// `RelayiumApp` passes `UITestMode.makePendingUploadKeyStore()`, an in-memory
/// store, to `AppEnvironment.makePendingUploadSupport`. This reset still runs,
/// because a staging root left by a run from before that change holds jobs
/// whose keys ARE in the keychain; for a newer run's jobs the deletes are
/// no-ops. Nothing in the suite relies on a key surviving a relaunch; a job
/// directory never survives one.
public enum PendingUploadTestRootReset {
    /// Discard `shared` AND its protected Device Inbox sibling, returning the
    /// id of every job directory that was in either. Synchronous, so both roots
    /// are empty before the caller hands `shared` to a store.
    ///
    /// The sibling is part of the same root: `PendingUploadSupport` derives it
    /// from `shared` for every construction, so emptying only `shared` let a
    /// previous run's device delivery — and its key — survive into the next.
    public static func discardRoots(besides shared: URL,
                                    fileManager: FileManager = .default) -> [String] {
        let roots = [shared, PendingUploadStore.protectedDeviceRoot(besides: shared)]
        var ids: [String] = []
        for root in roots {
            let entries = (try? fileManager.contentsOfDirectory(
                at: root, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
            for entry in entries
            where (try? entry.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true {
                ids.append(entry.lastPathComponent)
            }
            try? fileManager.removeItem(at: root)
        }
        return ids
    }

    /// Remove the pending-upload key of each id. Best effort: an entry whose
    /// name is not a valid job id never had a key (`remove` refuses it), and a
    /// failed delete leaves an inert item, which is the pre-existing outcome.
    /// Async because every keychain call must stay off the main actor.
    public static func removeKeys(for ids: [String], from keys: StoredLinkKeyStore) async {
        for id in ids {
            try? await keys.remove(id: id)
        }
    }
}
#endif
