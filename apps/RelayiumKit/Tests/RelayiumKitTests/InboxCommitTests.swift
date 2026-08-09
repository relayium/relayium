import XCTest
import Darwin
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The commit, and the crash boundaries around it.
///
/// The whole no-overwrite promise reduces to one syscall. `rename(2)` replaces
/// its destination silently, so any "check the name is free, then rename" is a
/// race — and here the check happens at PLANNING time and the write minutes
/// later, so the window is enormous rather than theoretical. `linkat(2)` fails
/// `EEXIST` on any existing name and makes the test and the creation one kernel
/// operation.
///
/// Its second-order property is the more useful one: because `link` leaves its
/// source behind, a crash between the link and the journal write is PROVABLE —
/// the destination shares an inode with our staged source, which no other writer
/// could have produced.
final class InboxCommitTests: XCTestCase {

    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    private struct Fixture {
        let root: URL
        let journals: InboxJournalStore
        var journal: InboxJournal
        let staging: URL
    }

    private func fixture(_ entries: [(name: String, bytes: [UInt8])],
                         taskID: String = "task1") throws -> Fixture {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-commit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }

        let journals = InboxJournalStore(directory: root.appendingPathComponent(".journals"))
        let plan = try InboxDestinationPlan.plan(
            root: root, files: entries.map { ManifestFile(name: $0.name, size: $0.bytes.count) })
        let staging = try InboxCommit.prepareStaging(root: root, taskID: taskID)
        for (index, entry) in entries.enumerated() {
            let path = staging.appendingPathComponent("\(index).part")
            try Data(entry.bytes).write(to: path)
            _ = chmod(path.path, InboxCommit.fileMode)
        }
        var journal = InboxJournal(taskID: taskID, storedFileID: "obj1", targetKeyID: "k1",
                                   root: root.standardizedFileURL.path,
                                   staging: staging.path, plan: plan, plannedAt: 1)
        try journals.save(&journal, now: epoch)
        return Fixture(root: root, journals: journals, journal: journal, staging: staging)
    }

    private func commit(_ f: inout Fixture,
                        beforeEach: (() async throws -> Void)? = nil) async throws {
        try await InboxCommit.commit(journal: &f.journal, root: f.root, store: f.journals,
                                     now: { self.epoch }, beforeEach: beforeEach)
    }

    // MARK: - the happy path

    func testCommitPlacesEveryPlannedDestinationAndClearsStaging() async throws {
        var f = try fixture([("a.txt", [1, 2, 3]), ("d/b.bin", [9])])
        try await commit(&f)

        XCTAssertEqual(try Data(contentsOf: f.root.appendingPathComponent("a.txt")),
                       Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: f.root.appendingPathComponent("d/b.bin")), Data([9]))
        XCTAssertTrue(f.journal.isCompleted)
        XCTAssertEqual(f.journal.committed.count, 2)
        // The staged sources are removed as each destination is journalled.
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.staging.appendingPathComponent("0.part").path))
    }

    /// Received files carry no executable bit on any platform, and the mode is
    /// set explicitly rather than inherited from the process umask.
    func testACommittedFileIsPrivateAndNotExecutable() async throws {
        var f = try fixture([("a.txt", [1])])
        try await commit(&f)
        var st = stat()
        XCTAssertEqual(lstat(f.root.appendingPathComponent("a.txt").path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, InboxCommit.fileMode)
        XCTAssertEqual(st.st_mode & 0o111, 0)
    }

    func testCreatedDirectoriesArePrivate() async throws {
        var f = try fixture([("d/b.bin", [9])])
        try await commit(&f)
        var st = stat()
        XCTAssertEqual(lstat(f.root.appendingPathComponent("d").path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, InboxCommit.directoryMode)
    }

    // MARK: - never overwrite

    /// The race the whole design exists for: a file appears at a planned
    /// destination AFTER the plan was journalled. `rename` would destroy it
    /// silently; `linkat` refuses, and the task stops for a person.
    func testAFileThatAppearsAfterPlanningIsNeverOverwritten() async throws {
        var f = try fixture([("a.txt", [1, 2, 3])])
        let destination = f.root.appendingPathComponent("a.txt")
        try Data("the user's own file".utf8).write(to: destination)

        do {
            try await commit(&f)
            XCTFail("the commit succeeded")
        } catch {
            XCTAssertEqual(error as? InboxCommitError, .destinationOccupied(index: 0))
        }
        XCTAssertEqual(try Data(contentsOf: destination), Data("the user's own file".utf8))
        XCTAssertFalse(f.journal.isCompleted)
        XCTAssertTrue(f.journal.committed.isEmpty)
    }

    /// A DIRECTORY, a symlink, a FIFO — anything at the name occupies it.
    func testADirectoryOrSymlinkAtADestinationIsAlsoARefusal() async throws {
        for makeObstacle in [{ (url: URL) in
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        }, { (url: URL) in
            try FileManager.default.createSymbolicLink(at: url,
                                                       withDestinationURL: URL(fileURLWithPath: "/nowhere"))
        }] {
            var f = try fixture([("a.txt", [1])])
            try makeObstacle(f.root.appendingPathComponent("a.txt"))
            do {
                try await commit(&f)
                XCTFail("the commit succeeded")
            } catch {
                XCTAssertEqual(error as? InboxCommitError, .destinationOccupied(index: 0))
            }
        }
    }

    /// `MkdirAll`-style creation follows an existing symlinked component — a
    /// pre-planted `photos -> /etc` is enough to have it create `/etc/2026`. Each
    /// component is opened `O_NOFOLLOW | O_DIRECTORY` from the previous one's
    /// descriptor instead, so a symlink is seen and refused.
    func testASymlinkedDirectoryComponentIsRefusedRatherThanFollowed() async throws {
        var f = try fixture([("d/b.bin", [9])])
        let elsewhere = f.root.appendingPathComponent("elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: f.root.appendingPathComponent("d"),
                                                   withDestinationURL: elsewhere)

        do {
            try await commit(&f)
            XCTFail("the commit succeeded")
        } catch {
            XCTAssertEqual(error as? InboxCommitError, .directoryUnavailable)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: elsewhere.appendingPathComponent("b.bin").path),
                       "the delivery was written through a symlinked component")
    }

    func testANonDirectoryWhereADirectoryMustBeCreatedIsRefused() async throws {
        var f = try fixture([("d/b.bin", [9])])
        try Data().write(to: f.root.appendingPathComponent("d"))
        do {
            try await commit(&f)
            XCTFail("the commit succeeded")
        } catch {
            XCTAssertEqual(error as? InboxCommitError, .directoryUnavailable)
        }
    }

    // MARK: - crash boundaries

    /// Crashed after the `link`, before the journal write. The staged source
    /// survives and shares an inode with the destination, which proves the link
    /// was this task's — so the second attempt finishes the bookkeeping instead of
    /// refusing.
    func testALinkThisTaskMadeButNeverJournalledIsRecognisedAndCompleted() async throws {
        var f = try fixture([("a.txt", [1, 2, 3])])
        let staged = f.staging.appendingPathComponent("0.part")
        let destination = f.root.appendingPathComponent("a.txt")
        // Exactly the state a crash in that window leaves: linked, unjournalled,
        // staged source still present.
        XCTAssertEqual(link(staged.path, destination.path), 0)

        try await commit(&f)

        XCTAssertTrue(f.journal.isCompleted)
        XCTAssertEqual(f.journal.committed, [destination.path])
        XCTAssertEqual(try Data(contentsOf: destination), Data([1, 2, 3]))
    }

    /// The same window, but the file at the destination is somebody else's. The
    /// inode differs, so it is ambiguous by definition: never overwritten, never
    /// merged, never guessed.
    func testAnUnrelatedFileAtTheDestinationIsNotMistakenForOurOwnLink() async throws {
        var f = try fixture([("a.txt", [1, 2, 3])])
        try Data([7, 7, 7]).write(to: f.root.appendingPathComponent("a.txt"))
        do {
            try await commit(&f)
            XCTFail("the commit succeeded")
        } catch {
            XCTAssertEqual(error as? InboxCommitError, .destinationOccupied(index: 0))
        }
    }

    /// Crashed after the journal write, before the unlink. The entry is skipped
    /// and the stale staged source removed — no second link, no duplicate.
    func testAJournalledDestinationIsSkippedAndItsStaleSourceCleaned() async throws {
        var f = try fixture([("a.txt", [1, 2, 3])])
        let staged = f.staging.appendingPathComponent("0.part")
        let destination = f.root.appendingPathComponent("a.txt")
        XCTAssertEqual(link(staged.path, destination.path), 0)
        f.journal.committed = [destination.path]
        try f.journals.save(&f.journal, now: epoch)

        try await commit(&f)

        XCTAssertTrue(f.journal.isCompleted)
        XCTAssertEqual(f.journal.committed, [destination.path], "the destination was recorded twice")
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
        XCTAssertEqual(try Data(contentsOf: destination), Data([1, 2, 3]))
    }

    /// A multi-file commit that fails part way leaves the files it DID place —
    /// they are real, verified deliveries — and records them, so the next attempt
    /// resumes from the journal rather than re-creating what exists.
    func testAPartiallyCommittedTaskKeepsAndRecordsWhatItPlaced() async throws {
        var f = try fixture([("a.txt", [1]), ("b.txt", [2])])
        try Data("mine".utf8).write(to: f.root.appendingPathComponent("b.txt"))

        do {
            try await commit(&f)
            XCTFail("the commit succeeded")
        } catch {}
        XCTAssertEqual(f.journal.committed, [f.root.appendingPathComponent("a.txt").path])
        XCTAssertFalse(f.journal.isCompleted)
        XCTAssertEqual(try Data(contentsOf: f.root.appendingPathComponent("a.txt")), Data([1]))
    }

    // MARK: - the lease guard

    /// A long multi-file commit cannot continue after central has reassigned the
    /// task. The guard's own error propagates UNCHANGED, because "the lease is
    /// gone" must not be reported to central at all.
    func testTheLeaseGuardStopsTheRemainingDestinationsAndPropagates() async throws {
        var f = try fixture([("a.txt", [1]), ("b.txt", [2])])
        var calls = 0
        do {
            try await commit(&f, beforeEach: {
                calls += 1
                if calls == 2 { throw InboxAbandon(.leaseRenewalRefused) }
            })
            XCTFail("a lost lease still committed every destination")
        } catch {
            XCTAssertEqual(error as? InboxAbandon, InboxAbandon(.leaseRenewalRefused))
        }
        XCTAssertEqual(f.journal.committed.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.root.appendingPathComponent("b.txt").path))
    }

    /// The guard runs BEFORE a destination is placed, not after: a lease lost
    /// between two files must stop the next one rather than discover the loss once
    /// it is already on disk.
    func testTheLeaseGuardRunsBeforeEachUncommittedDestination() async throws {
        var f = try fixture([("a.txt", [1]), ("b.txt", [2])])
        // Read out of `f` BEFORE the call: `commit(&f)` holds exclusive access to
        // it for the whole call, so a closure that reached back into `f` would be
        // an exclusivity violation rather than an observation.
        let second = f.root.appendingPathComponent("b.txt").path
        var seen: [Bool] = []
        try await commit(&f, beforeEach: {
            seen.append(FileManager.default.fileExists(atPath: second))
        })
        XCTAssertEqual(seen, [false, false])
    }

    // MARK: - staging

    /// An existing staging directory from an earlier attempt is REMOVED rather
    /// than reused: its contents were never verified as a whole, so treating them
    /// as a starting point would be exactly the "apparently complete unverified
    /// file" this design prevents.
    func testPreparingStagingDiscardsAnEarlierAttempt() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-staging-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }

        let first = try InboxCommit.prepareStaging(root: root, taskID: "task1")
        try Data([1, 2, 3]).write(to: first.appendingPathComponent("0.part"))

        let second = try InboxCommit.prepareStaging(root: root, taskID: "task1")
        XCTAssertEqual(first.path, second.path)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: second.path).isEmpty)

        var st = stat()
        XCTAssertEqual(lstat(second.path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, InboxCommit.directoryMode)
    }

    func testStagingIsInsideTheReceiveDirectorySoTheCommitCanBeALink() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-staging-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let staging = try InboxCommit.prepareStaging(root: root, taskID: "task1")
        XCTAssertEqual(staging.deletingLastPathComponent().lastPathComponent,
                       InboxDestinationPlan.stagingDirectoryName)
        XCTAssertTrue(staging.path.hasPrefix(root.path + "/"))
    }

    func testCleanStagingRemovesTheTaskDirectoryAndItsContents() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-staging-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let staging = try InboxCommit.prepareStaging(root: root, taskID: "task1")
        try Data([1]).write(to: staging.appendingPathComponent("0.part"))

        InboxCommit.cleanStaging(root: root, taskID: "task1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    }

    // MARK: - containment

    /// A journal restored from elsewhere cannot aim a commit outside the folder
    /// the user granted. The descriptor walk is the filesystem-level containment;
    /// this is the cheap lexical guard in front of it.
    func testADestinationOutsideTheRootIsRefused() {
        XCTAssertNil(InboxCommit.relativeComponents(of: "/etc/passwd", under: "/tmp/root"))
        XCTAssertNil(InboxCommit.relativeComponents(of: "/tmp/root", under: "/tmp/root"))
        XCTAssertNil(InboxCommit.relativeComponents(of: "/tmp/root/../x", under: "/tmp/root"))
        XCTAssertNil(InboxCommit.relativeComponents(of: "/tmp/rootx/a", under: "/tmp/root"))
        XCTAssertEqual(InboxCommit.relativeComponents(of: "/tmp/root/a/b.txt", under: "/tmp/root"),
                       ["a", "b.txt"])
    }

    func testAJournalNamingADestinationOutsideTheRootFailsTheCommit() async throws {
        var f = try fixture([("a.txt", [1])])
        f.journal.plan = [InboxPlanEntry(index: 0, name: "a.txt", size: 1,
                                         destination: "/tmp/somewhere-else/a.txt")]
        do {
            try await commit(&f)
            XCTFail("the commit succeeded")
        } catch {
            XCTAssertEqual(error as? InboxCommitError, .directoryUnavailable)
        }
    }
}
