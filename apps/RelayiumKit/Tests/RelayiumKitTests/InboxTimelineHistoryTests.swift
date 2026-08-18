import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The controller's half of the bidirectional conversation: how an outgoing
/// delivery becomes durable local history, what a local deletion removes, and —
/// the two properties the whole feature rests on — what it must never remove and
/// what it must never let come back.
///
/// The stores here are REAL. A fake conversation store would make every
/// assertion below about a test double rather than about the file the shipped
/// app writes, and the crash-window convergence in particular is only meaningful
/// against durable state.
@MainActor
final class InboxTimelineHistoryTests: XCTestCase {

    private let accountA = try! InboxAccountID("accounttlaaa01")
    private let accountB = try! InboxAccountID("accounttlbbb02")
    private let epoch = Date(timeIntervalSince1970: 1_700_000_000)

    private struct Bookmarking: InboxFolderBookmarking {
        let url: URL
        func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
        func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) { (url, false) }
        func startAccess(to url: URL) -> Bool { true }
        func stopAccess(to url: URL) {}
    }

    private final class Harness {
        var root: URL!
        var received: InboxMessageStore!
        var sent: InboxMessageStore!
        var conversations: [String: InboxConversationStore] = [:]
        var revealed: [[URL]] = []
        var controller: InboxController!
    }

    private func makeHarness() throws -> Harness {
        let harness = Harness()
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-timeline-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        harness.root = root
        harness.received = InboxMessageStore(directory: root.appendingPathComponent("messages"))
        harness.sent = InboxMessageStore(directory: root.appendingPathComponent("sent-messages"))
        for account in [accountA, accountB] {
            harness.conversations[account.value] = InboxConversationStore(
                directory: root.appendingPathComponent("conversations-" + account.value))
        }
        let received = harness.received!
        let sent = harness.sent!
        let stores = harness.conversations
        let controller = InboxController(runtime: InboxRuntime(
            folder: InboxReceiveFolder(store: InMemoryInboxFolderStore(),
                                       bookmarking: Bookmarking(url: root)),
            // No receiving in these tests: the loop fails once and then sleeps,
            // which keeps every assertion below about the history rather than
            // about a delivery pass.
            makeEngine: { _, _ in throw InboxError.network },
            messageStore: { account in
                // Account-scoped in the app; one store per test here, because
                // what is being asserted is which NAMESPACE a body lands in.
                account == self.accountA ? received : nil
            },
            sentMessageStore: { account in account == self.accountA ? sent : nil },
            conversationStore: { account in stores[account.value] },
            sleeper: ManualInboxSleeper(),
            reveal: { [weak harness] urls in harness?.revealed.append(urls) },
            platform: "macos", appVersion: "test"))
        harness.controller = controller
        return harness
    }

    private func signIn(_ harness: Harness, _ account: InboxAccountID) {
        harness.controller.session(InboxAccountIdentity(accountID: account.value,
                                                        bearer: "bearer-" + account.value))
    }

    private func store(_ harness: Harness,
                       _ account: InboxAccountID) throws -> InboxConversationStore {
        try XCTUnwrap(harness.conversations[account.value])
    }

    private func event(_ jobID: String, account: InboxAccountID? = nil,
                       kind: InboxTimelineEntry.Kind = .message,
                       at: TimeInterval = 20, peer: String = "peer-a",
                       files: [InboxTimelineEntry.FileNameSnapshot] = [],
                       state: InboxTimelineEntry.SentState = .staged) -> InboxSentHistoryEvent {
        InboxSentHistoryEvent(accountID: (account ?? accountA).value, jobID: jobID,
                              peerDeviceID: peer, kind: kind,
                              at: Date(timeIntervalSince1970: at), byteCount: 4,
                              files: files, state: state)
    }

    private func receive(_ harness: Harness, taskID: String, at: TimeInterval = 10,
                         text: String? = nil, files: [URL] = [],
                         peer: String = "peer-a") throws {
        let store = try store(harness, accountA)
        if let text {
            try harness.received.commit(id: taskID, text: text,
                                        receivedAt: Date(timeIntervalSince1970: at))
            try store.record(.received(taskID: taskID, peerDeviceID: peer,
                                       peerNameSnapshot: "Peer", kind: .message,
                                       at: Date(timeIntervalSince1970: at),
                                       messageID: taskID, byteCount: 4))
        } else {
            try store.record(.received(taskID: taskID, peerDeviceID: peer,
                                       peerNameSnapshot: "Peer", kind: .files,
                                       at: Date(timeIntervalSince1970: at),
                                       files: files.map { .init(url: $0) }, byteCount: 9))
        }
        harness.controller.refreshConversations()
    }

    // MARK: - the outgoing half becomes durable history

    func testASentMessageBecomesHistoryAndItsBodyLandsInTheSentNamespaceOnly() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)

        XCTAssertTrue(harness.controller.recordSentHistory(event("job-a")) { "what I said" })

        let conversation = try XCTUnwrap(harness.controller.conversations.first)
        XCTAssertEqual(conversation.peerDeviceID, "peer-a")
        let entry = try XCTUnwrap(conversation.entries.first)
        XCTAssertEqual(entry.id, "s:job-a")
        XCTAssertEqual(entry.direction, .sent)
        XCTAssertEqual(entry.sentState, .staged)
        XCTAssertFalse(entry.isUnread, "this Mac claimed it had not read what it sent")

        // The body is in the SENT store, and the received namespace is untouched.
        XCTAssertEqual(harness.controller.sentMessage(for: entry)?.text, "what I said")
        XCTAssertNil(try harness.received.load("job-a"),
                     "an outgoing body was written into the received-message namespace")
        XCTAssertNil(harness.controller.message(for: entry),
                     "a sent row resolved a body through the received reader")
    }

    func testASentFileDeliveryCarriesManifestNamesAndNoBody() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        XCTAssertTrue(harness.controller.recordSentHistory(
            event("job-files", kind: .files,
                  files: [.init(name: "photos/a.jpg", size: 12)])) { "must not be asked for" })

        let entry = try XCTUnwrap(harness.controller.conversations.first?.entries.first)
        XCTAssertEqual(entry.sentFiles, [.init(name: "photos/a.jpg", size: 12)])
        XCTAssertNil(entry.sentMessageID, "a file delivery carried a key to a message body")
        XCTAssertNil(try harness.sent.load("job-files"),
                     "a file delivery wrote a message body")
        XCTAssertTrue(entry.files.isEmpty, "a sent entry carries a filesystem path")
    }

    /// **The account is checked rather than assumed.** The send model holds its
    /// account as a plain string and this controller's stores are keyed by
    /// `InboxAccountID`; they are adopted from one session a turn apart.
    func testHistoryIsRefusedWhenTheAnnouncedAccountIsNotTheActiveOne() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)

        XCTAssertFalse(harness.controller.recordSentHistory(
            event("job-other", account: accountB)) { "not mine" })
        harness.controller.updateSentHistory(accountID: accountB.value, jobID: "job-other",
                                             state: .saved)
        XCTAssertTrue(harness.controller.conversations.isEmpty)
        XCTAssertTrue(try store(harness, accountA).conversations().isEmpty)
        XCTAssertTrue(try store(harness, accountB).conversations().isEmpty)
        XCTAssertNil(try harness.sent.load("job-other"))
        XCTAssertFalse(harness.controller.isSentHistoryDeleted(accountID: accountB.value,
                                                              jobID: "job-other"))
    }

    /// Switching accounts leaves each history where it belongs, and coming back
    /// finds it intact — an ordinary sign-out is not a deletion.
    func testAccountSwitchingKeepsEachHistoryToItselfAndSignOutPreservesIt() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        XCTAssertTrue(harness.controller.recordSentHistory(event("job-a")) { "A's message" })

        signIn(harness, accountB)
        XCTAssertTrue(harness.controller.conversations.isEmpty,
                      "one account's history was published under another")
        XCTAssertFalse(harness.controller.recordSentHistory(event("job-a")) { "A's message" },
                       "account A's job was accepted while account B was active")

        harness.controller.signedOut()
        XCTAssertTrue(harness.controller.conversations.isEmpty)
        signIn(harness, accountA)
        let entry = try XCTUnwrap(harness.controller.conversations.first?.entries.first)
        XCTAssertEqual(entry.id, "s:job-a")
        XCTAssertEqual(harness.controller.sentMessage(for: entry)?.text, "A's message")
    }

    /// **The crash window between a durable plan and its body.** A recovery pass
    /// writes the body when it is MISSING and leaves it alone when it is not —
    /// one condition covering both halves of the window, and covering neither
    /// twice.
    func testARecoveredPlanBackfillsAMissingBodyAndNeverRewritesAPresentOne() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)

        // The process died between the plan and the history row: the first thing
        // this account ever hears about the job is a recovery.
        XCTAssertTrue(harness.controller.recordSentHistory(event("job-a")) { "recovered" })
        XCTAssertEqual(try harness.sent.load("job-a")?.text, "recovered")

        // A second recovery must not re-ask for the body or overwrite it.
        var asked = 0
        XCTAssertFalse(harness.controller.recordSentHistory(event("job-a")) {
            asked += 1
            return "a different string"
        })
        XCTAssertEqual(asked, 0, "the body was re-read for a history that already had one")
        XCTAssertEqual(try harness.sent.load("job-a")?.text, "recovered")

        // The other half of the window: a row exists and the body does not.
        try harness.sent.remove("job-a")
        XCTAssertFalse(harness.controller.recordSentHistory(event("job-a")) { "backfilled" })
        XCTAssertEqual(try harness.sent.load("job-a")?.text, "backfilled")
    }

    /// A recovery for a job the user deleted must not write the plaintext back.
    /// The row is refused by the tombstone, so nothing on screen could ever
    /// delete that body again.
    func testARecoveredPlanForADeletedJobWritesNeitherRowNorPlaintext() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        XCTAssertTrue(harness.controller.recordSentHistory(event("job-a")) { "gone" })
        harness.controller.deleteTimelineEntry("s:job-a", peerDeviceID: "peer-a")
        XCTAssertNil(try harness.sent.load("job-a"))

        XCTAssertFalse(harness.controller.recordSentHistory(event("job-a")) { "gone" })
        XCTAssertTrue(harness.controller.conversations.isEmpty)
        XCTAssertNil(try harness.sent.load("job-a"),
                     "a recovery pass rewrote a deleted message's plaintext")
        harness.controller.updateSentHistory(accountID: accountA.value, jobID: "job-a",
                                             state: .saved, taskID: "central-task")
        XCTAssertTrue(harness.controller.conversations.isEmpty)
    }

    func testAnOutgoingUpdateChangesStateWithoutEverCreatingARow() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        harness.controller.updateSentHistory(accountID: accountA.value, jobID: "job-ghost",
                                             state: .saved)
        XCTAssertTrue(harness.controller.conversations.isEmpty,
                      "a state update created a history row")

        XCTAssertTrue(harness.controller.recordSentHistory(event("job-a")) { "hello" })
        harness.controller.updateSentHistory(accountID: accountA.value, jobID: "job-a",
                                             state: .created, taskID: "central-task")
        harness.controller.updateSentHistory(accountID: accountA.value, jobID: "job-a",
                                             state: .saved)
        let entry = try XCTUnwrap(harness.controller.conversations.first?.entries.first)
        XCTAssertEqual(entry.sentState, .saved)
        XCTAssertTrue(entry.isSavedOnTarget)
        XCTAssertEqual(entry.at, Date(timeIntervalSince1970: 20), "an update moved the row")
    }

    // MARK: - deletion is local, and never a recall

    /// **The two files a deletion may never touch.** A received file already in
    /// the user's folder and any file the user owns are unreachable from here:
    /// what goes is the row and the Relayium-owned body behind it.
    func testDeletingHistoryRemovesProtectedBodiesAndNeverAUserOwnedFile() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        let saved = harness.root.appendingPathComponent("already-saved.txt")
        try Data("the user's copy".utf8).write(to: saved)
        try receive(harness, taskID: "task-files", at: 10, files: [saved])
        try receive(harness, taskID: "task-message", at: 20, text: "what they said")
        XCTAssertTrue(harness.controller.recordSentHistory(event("job-a", at: 30)) { "what I said" })

        let conversation = try XCTUnwrap(harness.controller.conversations.first)
        XCTAssertEqual(conversation.entries.map(\.id),
                       ["s:job-a", "r:task-message", "r:task-files"])
        harness.controller.deleteConversation(peerDeviceID: "peer-a",
                                              observedEntryIDs: conversation.entryIDs)

        XCTAssertTrue(harness.controller.conversations.isEmpty)
        XCTAssertNil(try harness.received.load("task-message"))
        XCTAssertNil(try harness.sent.load("job-a"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: saved.path),
                      "a file already saved into the user's receive folder was deleted")
        XCTAssertEqual(String(decoding: try Data(contentsOf: saved), as: UTF8.self),
                       "the user's copy")
        // And the published deletion set is what the send model filters through.
        XCTAssertEqual(harness.controller.deletedTimelineIDs,
                       ["s:job-a", "r:task-message", "r:task-files"])
        XCTAssertTrue(harness.controller.isSentHistoryDeleted(accountID: accountA.value,
                                                             jobID: "job-a"))
        XCTAssertFalse(harness.controller.isSentHistoryDeleted(accountID: accountB.value,
                                                              jobID: "job-a"),
                       "one account's deletion hid another account's live send")
    }

    /// A delivery committed after the snapshot survives as a new unread row, and
    /// every observed id stays refused.
    func testAConcurrentReceiveSurvivesAConversationDeleteAndTheDeletedOnesDoNot() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        try receive(harness, taskID: "task-seen", at: 10, text: "seen")
        let observed = try XCTUnwrap(harness.controller.conversations.first).entryIDs

        // Committed while the confirmation was on screen.
        try receive(harness, taskID: "task-late", at: 15, text: "arrived later")

        harness.controller.deleteConversation(peerDeviceID: "peer-a", observedEntryIDs: observed)
        let after = try XCTUnwrap(harness.controller.conversations.first)
        XCTAssertEqual(after.entries.map(\.id), ["r:task-late"])
        XCTAssertEqual(after.unreadCount, 1)
        XCTAssertEqual(try harness.received.load("task-late")?.text, "arrived later")
        XCTAssertNil(try harness.received.load("task-seen"))

        // Replaying the deleted one through the ordinary write gate changes nothing.
        try store(harness, accountA).record(.received(
            taskID: "task-seen", peerDeviceID: "peer-a", peerNameSnapshot: "Peer",
            kind: .message, at: Date(timeIntervalSince1970: 10), messageID: "task-seen",
            byteCount: 4))
        harness.controller.refreshConversations(importLegacy: true)
        XCTAssertEqual(harness.controller.conversations.first?.entries.map(\.id), ["r:task-late"])
    }

    func testDeletingOneRowLeavesTheRestOfTheConversationAlone() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        try receive(harness, taskID: "task-a", at: 10, text: "first")
        try receive(harness, taskID: "task-b", at: 20, text: "second")

        harness.controller.deleteTimelineEntry("r:task-a", peerDeviceID: "peer-a")
        XCTAssertEqual(harness.controller.conversations.first?.entries.map(\.id), ["r:task-b"])
        XCTAssertNil(try harness.received.load("task-a"))
        XCTAssertEqual(try harness.received.load("task-b")?.text, "second")
    }

    /// The controller passes the peer at every deletion call site, so a stale or
    /// mis-plumbed snapshot cannot reach another conversation's rows.
    func testDeletionCannotReachAnotherPeersRowsThroughTheController() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        try receive(harness, taskID: "task-mine", at: 10, text: "mine", peer: "peer-a")
        try receive(harness, taskID: "task-theirs", at: 20, text: "theirs", peer: "peer-b")

        harness.controller.deleteConversation(
            peerDeviceID: "peer-a", observedEntryIDs: ["r:task-mine", "r:task-theirs"])
        XCTAssertEqual(harness.controller.conversations
            .first { $0.peerDeviceID == "peer-b" }?.entries.map(\.id), ["r:task-theirs"])
        XCTAssertEqual(try harness.received.load("task-theirs")?.text, "theirs",
                       "another peer's protected body was unlinked")
        XCTAssertEqual(harness.controller.deletedTimelineIDs, ["r:task-mine"])
    }

    /// **The crash between the durable index write and the unlink.** The
    /// tombstone still owes the cleanup, so the next refresh finishes it — the
    /// row is already gone and nothing on screen could ask again.
    func testAnInterruptedPlaintextCleanupConvergesOnTheNextRefresh() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        try receive(harness, taskID: "task-a", at: 10, text: "received body")
        XCTAssertTrue(harness.controller.recordSentHistory(event("job-a", at: 20)) { "sent body" })

        // The store's half happens; the process dies before either unlink.
        let cleanup = try store(harness, accountA).delete(
            entryIDs: ["r:task-a", "s:job-a"], peerDeviceID: "peer-a")
        XCTAssertFalse(cleanup.isEmpty)
        XCTAssertNotNil(try harness.received.load("task-a"))
        XCTAssertNotNil(try harness.sent.load("job-a"))

        // The relaunch's first refresh is what converges it.
        harness.controller.refreshConversations(importLegacy: true)
        XCTAssertNil(try harness.received.load("task-a"),
                     "a deleted received body survived the restart")
        XCTAssertNil(try harness.sent.load("job-a"),
                     "a deleted sent body survived the restart")
        XCTAssertTrue(try store(harness, accountA).pendingPlaintextCleanup().isEmpty)
        XCTAssertTrue(harness.controller.conversations.isEmpty)
        XCTAssertEqual(harness.controller.deletedTimelineIDs, ["r:task-a", "s:job-a"])
    }

    /// Reveal is fed only by what this Mac received. An outgoing row carries no
    /// path at all, so the Finder action cannot reach a file the user owns.
    func testTheFinderActionIsFedOnlyByReceivedFiles() throws {
        let harness = try makeHarness()
        signIn(harness, accountA)
        let saved = harness.root.appendingPathComponent("received.txt")
        try Data("x".utf8).write(to: saved)
        try receive(harness, taskID: "task-files", at: 10, files: [saved])
        XCTAssertTrue(harness.controller.recordSentHistory(
            event("job-files", kind: .files, at: 20,
                  files: [.init(name: "outgoing.txt", size: 1)])) { nil })

        let conversation = try XCTUnwrap(harness.controller.conversations.first)
        XCTAssertEqual(conversation.receivedFileURLs, [saved])
        harness.controller.reveal(conversation)
        XCTAssertEqual(harness.revealed, [[saved]])
    }
}
