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

    func testV3AuthenticatedSenderReachesTheReceipt() throws {
        let done = journal(plan: [("/tmp/root/a.txt", 3)], committed: ["/tmp/root/a.txt"],
                           completed: true)
        let receipt = try XCTUnwrap(InboxReceipt.make(taskID: "t1",
            senderDeviceID: "sender-device", journal: done, isReplay: false))
        XCTAssertEqual(receipt.senderDeviceID, "sender-device")
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

    /// **The summary names the file, and still never renders a path or a task
    /// id.**
    ///
    /// This assertion is inverted from the one it replaces, and the inversion is
    /// the product decision rather than a relaxation. The old rule — a count,
    /// never a name — is the NOTIFICATION's rule, because macOS draws that text
    /// on a locked screen without being asked, and `InboxNotifier` still obeys it
    /// (asserted in `InboxSurfaceGuardTests`). Recently received is a list the
    /// user opened on their own Mac to find out what arrived, and answered with
    /// a count it could not tell two deliveries apart.
    ///
    /// What is still refused has not moved: the CONTAINING PATH, which carries
    /// the user's short name and possibly other people's, and the task id, which
    /// is de-duplication bookkeeping and means nothing to anybody.
    func testTheSummaryNamesTheFileButNeverThePathOrTheTaskID() {
        let receipt = InboxReceipt(taskID: "task_secret",
                                   urls: [URL(fileURLWithPath: "/Users/lily/Inbox/salary.pdf")],
                                   byteCount: 2_048, savedAt: epoch, isReplay: false)
        for language in AppLanguage.allCases {
            let summary = InboxReceiptPresentation.summary(receipt, language: language)
            XCTAssertTrue(summary.contains("salary.pdf"),
                          "\(language) did not name the file that arrived")
            XCTAssertFalse(summary.contains("/Users"), "\(language) rendered a path")
            XCTAssertFalse(summary.contains("Inbox/"), "\(language) rendered a directory")
            XCTAssertFalse(summary.contains("task_secret"), "\(language) rendered a task id")
        }
    }

    /// Two deliveries read differently, which is the whole reason the rows name
    /// anything: three rows of "1 file saved" is a list with no information in it.
    func testTwoDeliveriesAreDistinguishableFromTheirRowsAlone() {
        let first = InboxReceipt(taskID: "t1", urls: [URL(fileURLWithPath: "/tmp/brief.txt")],
                                 byteCount: 1_024, savedAt: epoch, isReplay: false)
        let second = InboxReceipt(taskID: "t2", urls: [URL(fileURLWithPath: "/tmp/notes.md")],
                                  byteCount: 1_024, savedAt: epoch, isReplay: false)
        XCTAssertNotEqual(InboxReceiptPresentation.summary(first, language: .en),
                          InboxReceiptPresentation.summary(second, language: .en),
                          "two deliveries of one file each are indistinguishable")
    }

    /// A long delivery names what it can and COUNTS the rest. Dropping the tail
    /// silently would under-report what landed on the disk.
    func testALongDeliveryNamesThreeFilesAndCountsTheRemainder() {
        let names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]
        let receipt = InboxReceipt(taskID: "t1",
                                   urls: names.map { URL(fileURLWithPath: "/tmp/\($0)") },
                                   byteCount: 5_120, savedAt: epoch, isReplay: false)
        let summary = InboxReceiptPresentation.summary(receipt, language: .en)
        for named in names.prefix(3) {
            XCTAssertTrue(summary.contains(named), "the row stopped naming \(named)")
        }
        XCTAssertFalse(summary.contains("d.txt"), "the row named more files than it bounds")
        XCTAssertTrue(summary.contains("2"), "the two unnamed files are not counted")
    }

    /// The menu bar keeps a per-receipt spoken name, because it offers ONE item
    /// with no surrounding list to give it context.
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

    /// The section's one Finder action says WHICH folder it opens, because that
    /// is what distinguishes it from every other Finder action in the window.
    func testTheFolderRevealLabelNamesTheFolderItOpens() {
        let chosen = InboxFolderSummary(url: URL(fileURLWithPath: "/tmp/Relayium"),
                                        isChosen: true, problem: nil)
        let label = InboxReceiptPresentation.revealFolderLabel(chosen, language: .en)
        XCTAssertTrue(label.contains("Relayium"), "the action does not name its folder")
        // The folder's own presentation rule is unchanged and still applies: the
        // last component only, never the containing path.
        XCTAssertFalse(label.contains("/tmp"), "the action rendered a containing path")
    }
}
