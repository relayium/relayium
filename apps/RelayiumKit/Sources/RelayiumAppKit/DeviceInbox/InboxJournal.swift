import Foundation
import Darwin
@preconcurrency import RelayiumKit

/// The per-task crash journal.
///
/// WHAT IT IS FOR. Central knows a task's state; only this Mac knows what it did
/// to its own disk. Between "the ciphertext verified" and "every file is
/// committed" there are as many crash windows as there are files, and after a
/// crash the directory alone cannot answer "did I create that, or did the user?".
/// The journal is the record that makes each of those windows recoverable
/// without ever overwriting and without ever reporting a false `saved`.
///
/// THE ORDERING CONTRACT, which the receiver depends on:
///
///  1. The plan is journalled DURABLY before the first destination exists.
///  2. Each destination is linked, its directory is fsynced, and only THEN is it
///     appended to `committed` and the journal fsynced. A crash between the link
///     and the journal append leaves a destination whose staged source still
///     exists — and a shared `(st_dev, st_ino)` proves it was ours, because a
///     hard link shares an inode with its source.
///  3. The staged source is removed only after the journal records the commit, so
///     the evidence outlives the ambiguity.
///  4. `isCompleted` is set only when every planned destination is committed.
///     `saved` is reported only from `isCompleted`, so a lost report retries into
///     an idempotent no-op rather than a second delivery.
///
/// It is a LOCAL SECRET: it holds manifest file names and absolute destinations,
/// so it lives at 0600 inside a 0700 directory that is scoped to one account, and
/// nothing in it is ever logged or sent to central.

public struct InboxJournal: Codable, Equatable, Sendable {
    public static let version = 1

    public var version: Int
    public var taskID: String
    public var storedFileID: String
    public var targetKeyID: String
    /// The receive directory the plan was computed against. A task journalled for
    /// one directory must never be resumed into another: the planned destinations
    /// would be meaningless there.
    public var root: String
    public var staging: String
    /// The complete, ordered set of destinations this task may create. Fixed at
    /// planning time and never recomputed for a resumed task.
    public var plan: [InboxPlanEntry]
    public var plannedAt: Int64
    /// Destinations already durably in place, in plan order.
    public var committed: [String]
    /// Every planned destination is committed. The ONLY basis on which `saved` is
    /// reported.
    public var isCompleted: Bool
    /// Central acknowledged the commit, so a receipt is not retried forever after
    /// the task has left the queue.
    public var isSavedReported: Bool
    public var completedAt: Int64
    public var updatedAt: Int64

    public init(taskID: String, storedFileID: String, targetKeyID: String,
                root: String, staging: String = "", plan: [InboxPlanEntry],
                plannedAt: Int64, committed: [String] = [], isCompleted: Bool = false,
                isSavedReported: Bool = false, completedAt: Int64 = 0, updatedAt: Int64 = 0) {
        self.version = InboxJournal.version
        self.taskID = taskID
        self.storedFileID = storedFileID
        self.targetKeyID = targetKeyID
        self.root = root
        self.staging = staging
        self.plan = plan
        self.plannedAt = plannedAt
        self.committed = committed
        self.isCompleted = isCompleted
        self.isSavedReported = isSavedReported
        self.completedAt = completedAt
        self.updatedAt = updatedAt
    }

    public func hasCommitted(_ destination: String) -> Bool { committed.contains(destination) }
}

public enum InboxJournalError: Error, Equatable, Sendable {
    /// A task id that could not safely become a file name.
    case invalidTaskID
    /// The stored journal is unreadable or a version this build does not
    /// understand. Refused rather than parsed optimistically.
    case unreadable
    /// A filesystem call failed. Carries `errno` and nothing else — a path in an
    /// error is a plaintext destination in a log.
    case system(Int32)
}

/// The per-task journals for ONE account, in a 0700 directory.
///
/// Account-scoped for the same reason the key history is: a journal holds
/// plaintext file names and absolute destinations, and an account switch must not
/// make one account's in-flight delivery visible to — or resumable by — the next.
public struct InboxJournalStore: Sendable {
    public let directory: URL

    public init(directory: URL) { self.directory = directory }

    /// Bounds how long a finished receipt is kept.
    ///
    /// It deliberately OUTLIVES central's own terminal-row retention (7 days), so
    /// a duplicate delivery attempt for a task this Mac already saved is still
    /// recognised from local evidence alone.
    public static let retention: TimeInterval = 30 * 24 * 60 * 60

    /// Bound a central-issued id to characters that are inert in a path.
    ///
    /// Central mints these itself, so this can never fire in practice — which is
    /// exactly why it is here: the journal turns a REMOTE string into a local file
    /// name, and that conversion must not depend on a remote invariant staying
    /// true.
    static func checkedTaskID(_ id: String) throws -> String {
        guard let checked = try? StoredObjectID.checked(id), checked.count <= 64 else {
            throw InboxJournalError.invalidTaskID
        }
        return checked
    }

    func path(_ taskID: String) throws -> URL {
        directory.appendingPathComponent(try Self.checkedTaskID(taskID) + ".json")
    }

    /// The journal for `taskID`, or nil when this Mac has never started the task
    /// — the normal first-delivery case.
    public func load(_ taskID: String) throws -> InboxJournal? {
        let url = try path(taskID)
        guard let data = FileManager.default.contents(atPath: url.path) else {
            // Distinguish "not there" from "there and unreadable": only the first
            // is a first delivery. `contents(atPath:)` returns nil for both, so ask
            // the filesystem which one it was.
            var st = stat()
            if lstat(url.path, &st) == 0 { throw InboxJournalError.unreadable }
            return nil
        }
        guard let journal = try? JSONDecoder().decode(InboxJournal.self, from: data),
              journal.version == InboxJournal.version else {
            throw InboxJournalError.unreadable
        }
        return journal
    }

    /// Atomically replace the journal and return only once it is DURABLE.
    ///
    /// Every caller depends on that: the whole recovery argument is that the
    /// record reaches stable storage before the action it describes becomes
    /// irreversible. A `write` that returned before the bytes were on disk would
    /// make the ordering contract above decorative.
    public func save(_ journal: inout InboxJournal, now: Date) throws {
        journal.version = InboxJournal.version
        journal.updatedAt = Int64(now.timeIntervalSince1970)
        let url = try path(journal.taskID)
        guard let data = try? JSONEncoder().encode(journal) else {
            throw InboxJournalError.unreadable
        }
        try Self.ensureDirectory(directory)
        try Self.writeSecretFile(at: url, data: data, in: directory)
    }

    public func remove(_ taskID: String) throws {
        let url = try path(taskID)
        if unlink(url.path) != 0, errno != ENOENT {
            throw InboxJournalError.system(errno)
        }
        Self.fsyncDirectory(directory)
    }

    /// Delete receipts whose work finished longer ago than `retention`.
    ///
    /// Only COMPLETED, reported journals are eligible: an unfinished one is the
    /// only record of an in-flight task's destination plan, and deleting it early
    /// would turn a resumable crash into an ambiguous directory.
    public func prune(now: Date) {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else {
            return
        }
        let cutoff = Int64(now.addingTimeInterval(-Self.retention).timeIntervalSince1970)
        for name in names where name.hasSuffix(".json") {
            let id = String(name.dropLast(".json".count))
            guard let journal = try? load(id), journal.isCompleted,
                  journal.isSavedReported, journal.updatedAt < cutoff else { continue }
            try? remove(id)
        }
    }

    // MARK: - durable, private writes

    static func ensureDirectory(_ url: URL) throws {
        var st = stat()
        if lstat(url.path, &st) == 0 {
            guard (st.st_mode & S_IFMT) == S_IFDIR else { throw InboxJournalError.system(ENOTDIR) }
            // Re-assert the mode on every use: a directory created by an older
            // build, or by a restore, must not keep a wider one.
            _ = chmod(url.path, 0o700)
            return
        }
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            // Carry the POSIX reason rather than a Cocoa wrapper. The category a
            // failure lands in decides whether a delivery is parked for a person
            // (`permission_denied`, `disk_full`) or retried against a condition
            // nothing will change, and an opaque wrapper collapses all of them
            // into "internal".
            throw InboxJournalError.system(InboxPosix.code(of: error) ?? EIO)
        }
    }

    /// Temp file + fsync + rename + directory fsync, at 0600.
    ///
    /// `rename` is correct HERE and wrong for a delivery: this file is entirely
    /// owned by this component, so replacing it is the intent. A destination file
    /// is the user's, which is why `InboxCommit` uses `linkat` instead.
    static func writeSecretFile(at url: URL, data: Data, in directory: URL) throws {
        let temp = directory.appendingPathComponent("." + url.lastPathComponent + ".tmp")
        _ = unlink(temp.path)
        let fd = retryOnEINTR {
            Darwin.open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        }
        guard fd >= 0 else { throw InboxJournalError.system(errno) }
        var wrote = false
        defer {
            if !wrote { _ = unlink(temp.path) }
        }
        do {
            try writeAll(fd, ArraySlice([UInt8](data)))
        } catch {
            close(fd)
            throw InboxJournalError.system(errno)
        }
        if retryOnEINTR({ fsync(fd) }) != 0 {
            let code = errno
            close(fd)
            throw InboxJournalError.system(code)
        }
        close(fd)
        guard rename(temp.path, url.path) == 0 else { throw InboxJournalError.system(errno) }
        wrote = true
        fsyncDirectory(directory)
    }

    static func fsyncDirectory(_ url: URL) {
        let fd = retryOnEINTR { Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
        guard fd >= 0 else { return }
        _ = retryOnEINTR { fsync(fd) }
        close(fd)
    }
}
