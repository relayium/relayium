import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The only thing in the product that may make a "saved" claim.
///
/// Every arm that is not a completed commit produces NOTHING, and the one that
/// is produces exactly what the commit recorded. The sharp case is a journal
/// with a plan and no commits — planned, then interrupted — where a receipt
/// derived from the plan rather than from `committed` would name files that were
/// never created.
final class InboxReceiptTests: XCTestCase {

    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    private func journal(plan: [(String, Int)], committed: [String],
                         completed: Bool, completedAt: Int64 = 0) -> InboxJournal {
        let entries = plan.enumerated().map { index, entry in
            InboxPlanEntry(index: index, name: URL(fileURLWithPath: entry.0).lastPathComponent,
                           size: entry.1, destination: entry.0)
        }
        return InboxJournal(taskID: "t1", storedFileID: "obj1", targetKeyID: "key1",
                            root: "/tmp/root", plan: entries,
                            plannedAt: Int64(epoch.timeIntervalSince1970),
                            committed: committed, isCompleted: completed,
                            completedAt: completedAt,
                            updatedAt: Int64(epoch.timeIntervalSince1970))
    }

    func testNoJournalMeansNoReceipt() {
        XCTAssertNil(InboxReceipt.make(taskID: "t1", journal: nil, isReplay: false))
    }

    func testAnIncompleteJournalMeansNoReceipt() {
        let incomplete = journal(plan: [("/tmp/root/a.txt", 3)], committed: ["/tmp/root/a.txt"],
                                 completed: false)
        XCTAssertNil(InboxReceipt.make(taskID: "t1", journal: incomplete, isReplay: false))
    }

    /// Planned, then interrupted before any commit. A receipt here would name a
    /// file that does not exist, and Reveal in Finder would open an empty folder
    /// having told the user their delivery landed.
    func testAPlanWithNoCommitsMeansNoReceipt() {
        let planned = journal(plan: [("/tmp/root/a.txt", 3)], committed: [], completed: true)
        XCTAssertNil(InboxReceipt.make(taskID: "t1", journal: planned, isReplay: false))
    }

    /// A partially committed task names only what was actually created.
    func testOnlyCommittedEntriesReachTheReceipt() throws {
        let partial = journal(plan: [("/tmp/root/a.txt", 3), ("/tmp/root/b.txt", 7)],
                              committed: ["/tmp/root/a.txt"], completed: true,
                              completedAt: 1_700_000_500)
        let receipt = try XCTUnwrap(InboxReceipt.make(taskID: "t1", journal: partial,
                                                      isReplay: false))
        XCTAssertEqual(receipt.urls.map(\.path), ["/tmp/root/a.txt"])
        XCTAssertEqual(receipt.fileCount, 1)
        XCTAssertEqual(receipt.byteCount, 3)
    }

    /// Plan order, not append order: the plan is what the sender's manifest
    /// described and it is stable across a resumed commit.
    func testTheReceiptFollowsPlanOrderRatherThanCommitOrder() throws {
        let out = journal(plan: [("/tmp/root/a.txt", 1), ("/tmp/root/b.txt", 2)],
                          committed: ["/tmp/root/b.txt", "/tmp/root/a.txt"], completed: true,
                          completedAt: 1_700_000_500)
        let receipt = try XCTUnwrap(InboxReceipt.make(taskID: "t1", journal: out, isReplay: false))
        XCTAssertEqual(receipt.urls.map(\.lastPathComponent), ["a.txt", "b.txt"])
        XCTAssertEqual(receipt.byteCount, 3)
    }

    /// A replay carries the ORIGINAL commit time. A result list that re-dated an
    /// old delivery on every relaunch would be lying about when the user's files
    /// arrived.
    func testAReplayKeepsTheOriginalCommitTime() throws {
        let done = journal(plan: [("/tmp/root/a.txt", 3)], committed: ["/tmp/root/a.txt"],
                           completed: true, completedAt: 1_699_000_000)
        let receipt = try XCTUnwrap(InboxReceipt.make(taskID: "t1", journal: done, isReplay: true))
        XCTAssertEqual(receipt.savedAt, Date(timeIntervalSince1970: 1_699_000_000))
        XCTAssertTrue(receipt.isReplay)
    }

    /// A completed journal that never stamped `completedAt` falls back to the
    /// last write rather than to 1970, which would sort a real delivery to the
    /// bottom of the list and read as absurd on screen.
    func testAMissingCompletionStampFallsBackToTheLastWrite() throws {
        let done = journal(plan: [("/tmp/root/a.txt", 3)], committed: ["/tmp/root/a.txt"],
                           completed: true, completedAt: 0)
        let receipt = try XCTUnwrap(InboxReceipt.make(taskID: "t1", journal: done, isReplay: false))
        XCTAssertEqual(receipt.savedAt, epoch)
    }

    // MARK: - how it is described

    /// The summary is a count, a size and a time — never a name.
    func testTheSummaryNamesNothingInTheDelivery() {
        let receipt = InboxReceipt(taskID: "task_secret",
                                   urls: [URL(fileURLWithPath: "/Users/lily/Inbox/salary.pdf")],
                                   byteCount: 2_048, savedAt: epoch, isReplay: false)
        for language in AppLanguage.allCases {
            let summary = InboxReceiptPresentation.summary(receipt, language: language)
            XCTAssertFalse(summary.contains("salary"), "\(language) rendered a file name")
            XCTAssertFalse(summary.contains("/Users"), "\(language) rendered a path")
            XCTAssertFalse(summary.contains("task_secret"), "\(language) rendered a task id")
            XCTAssertFalse(summary.isEmpty)
        }
    }

    /// Every row's visible button reads the same three words, which is right to
    /// look at and useless to hear. The spoken name carries the row.
    func testTheRevealActionLabelDistinguishesItsRow() {
        let first = InboxReceipt(taskID: "t1", urls: [URL(fileURLWithPath: "/tmp/a")],
                                 byteCount: 1_024, savedAt: epoch, isReplay: false)
        let second = InboxReceipt(taskID: "t2",
                                  urls: [URL(fileURLWithPath: "/tmp/b"),
                                         URL(fileURLWithPath: "/tmp/c")],
                                  byteCount: 4_096, savedAt: epoch, isReplay: false)
        let a = InboxReceiptPresentation.revealActionLabel(first, language: .en)
        let b = InboxReceiptPresentation.revealActionLabel(second, language: .en)
        XCTAssertNotEqual(a, b, "two result rows sound identical to a screen reader")
        XCTAssertTrue(a.contains(L10n.t(.inboxReveal, language: .en)))
    }
}
