import XCTest
import Darwin
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The per-task crash journal: the record that makes every commit boundary
/// answerable without ever overwriting and without ever reporting a false
/// `saved`.
final class InboxJournalTests: XCTestCase {

    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    private func store() throws -> (InboxJournalStore, URL) {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-journal-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return (InboxJournalStore(directory: url), url)
    }

    private func journal(_ taskID: String = "task1",
                         plan: [InboxPlanEntry] = []) -> InboxJournal {
        InboxJournal(taskID: taskID, storedFileID: "obj1", targetKeyID: "k1",
                     root: "/tmp/root", plan: plan, plannedAt: 1)
    }

    // MARK: - lifecycle

    func testAnUnstartedTaskHasNoJournal() throws {
        let (store, _) = try store()
        XCTAssertNil(try store.load("task1"))
    }

    func testSavingCreatesThePrivateDirectoryAndRoundTrips() throws {
        let (store, directory) = try store()
        var written = journal(plan: [InboxPlanEntry(index: 0, name: "a.txt", size: 3,
                                                    destination: "/tmp/root/a.txt")])
        try store.save(&written, now: epoch)

        let loaded = try XCTUnwrap(try store.load("task1"))
        XCTAssertEqual(loaded.plan, written.plan)
        XCTAssertEqual(loaded.updatedAt, Int64(epoch.timeIntervalSince1970))

        // It holds plaintext file names and absolute destinations, so it is 0600
        // inside a 0700 directory.
        var directoryStat = stat()
        XCTAssertEqual(lstat(directory.path, &directoryStat), 0)
        XCTAssertEqual(directoryStat.st_mode & 0o777, 0o700)
        var fileStat = stat()
        XCTAssertEqual(lstat(directory.appendingPathComponent("task1.json").path, &fileStat), 0)
        XCTAssertEqual(fileStat.st_mode & 0o777, 0o600)
    }

    func testSavingLeavesNoTemporaryFileBehind() throws {
        let (store, directory) = try store()
        var written = journal()
        try store.save(&written, now: epoch)
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(names, ["task1.json"])
    }

    func testRemoveIsIdempotent() throws {
        let (store, _) = try store()
        var written = journal()
        try store.save(&written, now: epoch)
        XCTAssertNoThrow(try store.remove("task1"))
        XCTAssertNoThrow(try store.remove("task1"))
        XCTAssertNil(try store.load("task1"))
    }

    // MARK: - fail closed

    /// The journal turns a REMOTE string into a local file name, and that
    /// conversion must not depend on a remote invariant staying true. Central
    /// mints these ids itself, which is exactly why the check is here.
    func testATaskIDThatCouldEscapeTheDirectoryIsRefused() throws {
        let (store, _) = try store()
        for bad in ["", "../escape", "with/slash", "with space", String(repeating: "a", count: 100)] {
            XCTAssertThrowsError(try store.load(bad), bad) {
                XCTAssertEqual($0 as? InboxJournalError, .invalidTaskID)
            }
            var written = journal(bad)
            XCTAssertThrowsError(try store.save(&written, now: epoch), bad)
        }
    }

    /// Refused rather than parsed optimistically: guessing at a future format
    /// could mean treating a journal as authoritative while it is missing the
    /// destinations a resumed task must not recompute.
    func testAJournalFromAnotherVersionIsRefused() throws {
        let (store, directory) = try store()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("task1.json")
        try Data(#"{"version":99,"taskId":"task1"}"#.utf8).write(to: path)
        XCTAssertThrowsError(try store.load("task1")) {
            XCTAssertEqual($0 as? InboxJournalError, .unreadable)
        }
    }

    /// "Not there" and "there and unreadable" are opposite facts: the first is a
    /// first delivery, the second means an in-flight task's plan cannot be read
    /// and re-planning would risk delivering twice.
    func testAnUnreadableJournalIsNotMistakenForAnAbsentOne() throws {
        let (store, directory) = try store()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: directory.appendingPathComponent("task1.json"))
        XCTAssertThrowsError(try store.load("task1")) {
            XCTAssertEqual($0 as? InboxJournalError, .unreadable)
        }
    }

    // MARK: - retention

    /// Receipts outlive central's own terminal-row retention, so a duplicate
    /// delivery attempt for a task this Mac already saved is recognised from local
    /// evidence alone.
    func testTheRetentionOutlivesCentralsTerminalRowRetention() {
        XCTAssertGreaterThan(InboxJournalStore.retention, 7 * 24 * 60 * 60)
    }

    func testPruneRemovesOnlyOldCompletedAndReportedReceipts() throws {
        let (store, _) = try store()
        let old = epoch.addingTimeInterval(-InboxJournalStore.retention - 60)

        var finished = journal("finished")
        finished.isCompleted = true
        finished.isSavedReported = true
        try store.save(&finished, now: old)

        // Completed but never acknowledged by central: the receipt is still the
        // reason a re-claim re-reports instead of re-delivering.
        var unreported = journal("unreported")
        unreported.isCompleted = true
        try store.save(&unreported, now: old)

        // Unfinished: the only record of an in-flight task's destination plan.
        var unfinished = journal("unfinished")
        try store.save(&unfinished, now: old)

        // Recent and finished.
        var recent = journal("recent")
        recent.isCompleted = true
        recent.isSavedReported = true
        try store.save(&recent, now: epoch)

        store.prune(now: epoch)

        XCTAssertNil(try store.load("finished"))
        XCTAssertNotNil(try store.load("unreported"))
        XCTAssertNotNil(try store.load("unfinished"))
        XCTAssertNotNil(try store.load("recent"))
    }

    func testPruneOnAMissingDirectoryIsSilent() throws {
        let (store, _) = try store()
        store.prune(now: epoch)
    }

    // MARK: - the committed set

    func testCommittedDestinationsAreRecognised() {
        var written = journal()
        written.committed = ["/tmp/root/a.txt"]
        XCTAssertTrue(written.hasCommitted("/tmp/root/a.txt"))
        XCTAssertFalse(written.hasCommitted("/tmp/root/b.txt"))
    }
}
