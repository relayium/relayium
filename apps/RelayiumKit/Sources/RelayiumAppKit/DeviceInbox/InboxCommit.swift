import Foundation
import Darwin
@preconcurrency import RelayiumKit

/// Committing verified bytes into the user's directory.
///
/// THE CENTRAL CHOICE: `linkat(2)`, NOT `rename(2)`.
///
/// `rename` replaces its destination unconditionally and silently. Every "check
/// that it does not exist, then rename" is therefore a race: a file created in
/// the window between the check and the call is destroyed with no error and no
/// trace. That window is not theoretical here — the check happens at PLANNING
/// time, before a download that may take minutes.
///
/// `linkat` fails with `EEXIST` if the destination name is taken by ANYTHING: a
/// file, a directory, a socket, a device node, or a dangling symlink. The kernel
/// makes the test and the creation one operation, so there is no window at all.
/// Its two costs are accepted deliberately: it needs the same filesystem (which
/// is why staging lives inside the receive directory) and it leaves the source
/// behind — which is what makes a crashed commit PROVABLE rather than a guess.
///
/// Nothing in this file opens, truncates, executes, or extracts anything that was
/// already on disk. The only mutations are: create a fresh directory, create a
/// fresh link, remove a file this component itself staged.

public enum InboxCommitError: Error, Equatable, Sendable {
    /// The destination name is taken by something that is NOT this task's staged
    /// inode. Ambiguous by definition: never overwritten, never merged, never
    /// guessed. A person decides.
    case destinationOccupied(index: Int)
    /// A component of the destination path is a symlink, is not a directory, or
    /// the receive directory itself became unusable.
    case directoryUnavailable
    /// A separate filesystem is mounted inside the receive directory, so the
    /// commit cannot be atomic. Copying instead would give up the no-replace
    /// guarantee, so this stops and says exactly what is wrong.
    case crossDevice
    /// A syscall failed for a reason that is not one of the above. Carries
    /// `errno` and nothing else.
    case system(Int32)
}

public enum InboxCommit {
    /// The mode of a committed file: owner read/write, and NO EXECUTABLE BIT
    /// (PRD §9). Set explicitly on the staged file rather than left to the
    /// process umask, so the result does not depend on how the app happened to be
    /// launched — a login item, a Finder launch and a test host all produce the
    /// same thing.
    ///
    /// 0600 rather than 0644 because an inbox is personal by default. Widening is
    /// a decision the user can make; narrowing after the fact cannot un-expose a
    /// file that was briefly world-readable.
    public static let fileMode: mode_t = 0o600
    /// Directories created for a received tree are private to the receiving user.
    public static let directoryMode: mode_t = 0o700

    /// Create every missing component between `root` and `directory`, refusing to
    /// traverse anything that is not a real directory.
    ///
    /// Deliberately NOT `createDirectory(withIntermediateDirectories:)`. That
    /// follows an existing symlinked component — a pre-planted
    /// `inbox/photos -> /etc` is enough to have it happily create `/etc/2026` —
    /// and discovers it only afterwards, if at all. Here each component is opened
    /// `O_NOFOLLOW | O_DIRECTORY` from the PREVIOUS component's descriptor, so a
    /// symlink is seen as a symlink and refused, anything that exists but is not a
    /// directory is refused, and the name that is acted on is the one that was
    /// resolved.
    ///
    /// Returns an open descriptor for the leaf directory, which the caller owns
    /// and must close. Returning the descriptor rather than the path is the point:
    /// the `linkat` that follows is anchored to the inode this walk resolved, not
    /// to a name that could mean something else by then.
    static func openDirectory(root rootFD: Int32, components: [String],
                              create: Bool) throws -> Int32 {
        var current = dupCloseOnExec(rootFD)
        guard current >= 0 else { throw InboxCommitError.system(errno) }
        for component in components {
            do {
                guard let opened = try openSubdirectory(parent: current, name: component,
                                                        create: create) else {
                    close(current)
                    throw InboxCommitError.directoryUnavailable
                }
                if opened.created {
                    _ = fchmod(opened.fd, InboxCommit.directoryMode)
                }
                close(current)
                current = opened.fd
            } catch let e as DownloadDestinationError {
                close(current)
                guard case let .systemError(code) = e else { throw InboxCommitError.directoryUnavailable }
                // A symlink (`ELOOP`) or a non-directory (`ENOTDIR`) at a
                // component is the refusal that matters; anything else stays a
                // system failure so a full disk is not reported as a traversal.
                if code == ELOOP || code == ENOTDIR || code == ENOENT {
                    throw InboxCommitError.directoryUnavailable
                }
                throw InboxCommitError.system(code)
            }
        }
        return current
    }

    /// Link one staged file into its planned destination with no-replace
    /// semantics, and report whether the destination now holds THIS task's bytes.
    ///
    /// The `EEXIST` branch is the crash-recovery core. If the destination exists
    /// and the staged source still exists, `(st_dev, st_ino)` decides the question
    /// the directory alone cannot answer: a hard link shares an inode with its
    /// source, so equal means "this is the link I made before I crashed" —
    /// idempotent, finish the bookkeeping. Unequal means somebody else's file is
    /// at that name, which is never overwritten and never merged.
    static func linkStaged(stagingFD: Int32, stagedName: String,
                           destinationFD: Int32, destinationName: String,
                           index: Int) throws {
        let rc = stagedName.withCString { source in
            destinationName.withCString { target in
                retryOnEINTR { linkat(stagingFD, source, destinationFD, target, 0) }
            }
        }
        if rc == 0 {
            // The link is only durable once its parent directory entry is.
            _ = retryOnEINTR { fsync(destinationFD) }
            return
        }
        let code = errno
        if code == EXDEV { throw InboxCommitError.crossDevice }
        guard code == EEXIST else { throw InboxCommitError.system(code) }
        guard let staged = statAt(parent: stagingFD, name: stagedName),
              let existing = statAt(parent: destinationFD, name: destinationName),
              staged.st_dev == existing.st_dev, staged.st_ino == existing.st_ino else {
            throw InboxCommitError.destinationOccupied(index: index)
        }
        _ = retryOnEINTR { fsync(destinationFD) }
    }

    /// The staged file name for a plan entry.
    ///
    /// Named by manifest INDEX, never by the manifest's own name: the staging area
    /// is created and consumed entirely by this component, so it has no reason to
    /// contain attacker-influenced names, and giving it none removes the whole
    /// class of question about what is safe to create there.
    public static func stagedName(_ entry: InboxPlanEntry) -> String { "\(entry.index).part" }

    /// Apply a journalled plan to disk, resuming a partially committed task
    /// without duplicating a file and without ever overwriting one.
    ///
    /// The per-file order is fixed and is the whole recovery argument:
    ///
    ///     link -> fsync the destination directory -> journal it -> remove the staged source
    ///
    /// Crash after the link: the source survives, the shared inode proves
    /// ownership, the journal catches up. Crash after the journal: the entry is
    /// skipped and the stale source cleaned. There is no ordering in which a
    /// destination exists that the journal cannot account for, and none in which a
    /// file is written twice.
    ///
    /// `beforeEach` runs before every not-yet-committed destination so a long
    /// multi-file commit cannot continue after central has reassigned the task.
    /// Its throw propagates unchanged — the caller distinguishes "the lease is
    /// gone" from a filesystem failure, and a lease loss must NOT be reported.
    ///
    /// It is `async` for one reason, and it is the reason this function is: the
    /// guard is a network call. An earlier version kept the whole commit
    /// synchronous and bridged the renewal with a semaphore, which BLOCKS a
    /// cooperative-pool thread waiting on a task that needs the same pool — a
    /// deadlock hazard on a constrained pool and a hard rule Swift concurrency
    /// asks callers not to break. The `await` is deliberately placed BEFORE the
    /// `link`, never between the link and the journal write: that ordering is the
    /// crash-recovery argument, and a suspension inside it would widen exactly
    /// the window the ordering exists to close.
    public static func commit(journal: inout InboxJournal, root: URL,
                              store: InboxJournalStore, now: () -> Date,
                              beforeEach: (() async throws -> Void)? = nil) async throws {
        let rootFD = retryOnEINTR { Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
        guard rootFD >= 0 else { throw InboxCommitError.directoryUnavailable }
        defer { close(rootFD) }

        let stagingFD = retryOnEINTR {
            Darwin.open(journal.staging, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard stagingFD >= 0 else { throw InboxCommitError.directoryUnavailable }
        defer { close(stagingFD) }

        let rootPath = root.standardizedFileURL.path
        for entry in journal.plan {
            let staged = stagedName(entry)
            if journal.hasCommitted(entry.destination) {
                // Already durably placed. Drop any staged source left by a crash
                // between the journal write and the unlink.
                removeAt(parent: stagingFD, name: staged, isDirectory: false)
                continue
            }
            try await beforeEach?()

            guard let relative = InboxCommit.relativeComponents(of: entry.destination,
                                                                under: rootPath),
                  let leaf = relative.last else {
                throw InboxCommitError.directoryUnavailable
            }
            let parentFD = try openDirectory(root: rootFD, components: Array(relative.dropLast()),
                                             create: true)
            defer { close(parentFD) }
            try linkStaged(stagingFD: stagingFD, stagedName: staged,
                           destinationFD: parentFD, destinationName: leaf,
                           index: entry.index)

            journal.committed.append(entry.destination)
            // The destination exists but is unrecorded until this returns. That is
            // recoverable (the shared-inode branch above), so a failure here
            // surfaces rather than pressing on and losing the ordering guarantee
            // for the remaining files.
            try store.save(&journal, now: now())
            removeAt(parent: stagingFD, name: staged, isDirectory: false)
        }
        journal.isCompleted = true
        journal.completedAt = Int64(now().timeIntervalSince1970)
        try store.save(&journal, now: now())
    }

    /// Split an absolute destination into components relative to the root, or nil
    /// if it is not under the root at all.
    ///
    /// A lexical check on a path both sides of which this component produced. The
    /// filesystem-level containment is the descriptor walk in `openDirectory`;
    /// this is the cheap guard that a journal restored from elsewhere cannot aim a
    /// commit outside the folder the user granted.
    static func relativeComponents(of destination: String, under root: String) -> [String]? {
        guard destination.hasPrefix(root + "/") else { return nil }
        let tail = destination.dropFirst(root.count + 1)
        let parts = tail.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
            return nil
        }
        return parts
    }

    /// Create a fresh, private staging directory for a task, and return it with
    /// an open descriptor.
    ///
    /// An existing staging directory from an earlier attempt is REMOVED rather
    /// than reused: its contents were never verified as a whole — that only
    /// happens once the entire authenticated stream has been consumed — so
    /// treating them as a starting point would be exactly the "apparently complete
    /// unverified file" this design exists to prevent.
    public static func prepareStaging(root: URL, taskID: String) throws -> URL {
        let checked = try InboxJournalStore.checkedTaskID(taskID)
        let base = root.appendingPathComponent(InboxDestinationPlan.stagingDirectoryName,
                                               isDirectory: true)
        let rootFD = retryOnEINTR { Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
        guard rootFD >= 0 else { throw InboxCommitError.directoryUnavailable }
        defer { close(rootFD) }
        let baseFD = try openDirectory(root: rootFD,
                                       components: [InboxDestinationPlan.stagingDirectoryName],
                                       create: true)
        defer { close(baseFD) }
        // Re-assert the mode even when the directory already existed: a staging
        // area created by an older build, or left world-readable by a restore,
        // holds decrypted plaintext.
        _ = fchmod(baseFD, InboxCommit.directoryMode)

        let directory = base.appendingPathComponent(checked, isDirectory: true)
        removeRecursively(parent: baseFD, name: checked)
        let made = checked.withCString { name in
            retryOnEINTR { mkdirat(baseFD, name, InboxCommit.directoryMode) }
        }
        guard made == 0 else { throw InboxCommitError.system(errno) }
        return directory
    }

    /// Remove a per-task staging directory and everything in it.
    ///
    /// Bounded to one level because that is all a staging area ever has: files
    /// named `<index>.part`, created only by this component. It never recurses
    /// into a subdirectory, so a directory somehow present there is left alone
    /// rather than walked.
    static func removeRecursively(parent: Int32, name: String) {
        let fd = name.withCString { cName in
            retryOnEINTR { openat(parent, cName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        }
        if fd >= 0 {
            if let dir = fdopendir(fd) {
                // The whole listing is read BEFORE anything is unlinked. Removing
                // entries while a `readdir` walk is still in progress is not
                // defined to enumerate the remainder, and the residue of a partial
                // walk here is decrypted plaintext left in the staging area.
                var children: [String] = []
                while let entry = readdir(dir) {
                    let child = withUnsafeBytes(of: entry.pointee.d_name) { raw -> String in
                        guard let base = raw.baseAddress else { return "" }
                        return String(cString: base.assumingMemoryBound(to: CChar.self))
                    }
                    guard !child.isEmpty, child != ".", child != ".." else { continue }
                    children.append(child)
                }
                for child in children {
                    removeAt(parent: dirfd(dir), name: child, isDirectory: false)
                }
                closedir(dir)          // closes fd
            } else {
                close(fd)
            }
        }
        removeAt(parent: parent, name: name, isDirectory: true)
    }

    /// Remove this task's staging area. Best effort: a leftover staging directory
    /// is inert (0700, inside a dot-directory) and is cleaned by the next attempt,
    /// whereas failing a completed commit over it would be a false negative on
    /// work that actually succeeded.
    public static func cleanStaging(root: URL, taskID: String) {
        guard let checked = try? InboxJournalStore.checkedTaskID(taskID) else { return }
        let base = root.appendingPathComponent(InboxDestinationPlan.stagingDirectoryName,
                                               isDirectory: true)
        let baseFD = retryOnEINTR {
            Darwin.open(base.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard baseFD >= 0 else { return }
        defer { close(baseFD) }
        removeRecursively(parent: baseFD, name: checked)
    }
}
