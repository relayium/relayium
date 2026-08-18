import Darwin
import XCTest
@testable import RelayiumAppKit

/// The v2 bidirectional timeline: what it holds, what it refuses, what happens
/// to a v1 file, and — the point of the whole round — what a deletion is
/// permanently unable to undo.
///
/// Six of these are the no-resurrection gates, one per replay source the Device
/// Inbox actually has, driven independently rather than through one composite
/// "restart" scenario. A composite passes while five of the six are broken.
final class InboxConversationStoreTests: XCTestCase {

    private func store(_ name: String = UUID().uuidString) -> InboxConversationStore {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relayium-conversations-\(name)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return InboxConversationStore(directory: directory)
    }

    /// A second store over the SAME directory — a relaunch, with no in-process
    /// state carried across.
    private func reopen(_ store: InboxConversationStore) -> InboxConversationStore {
        InboxConversationStore(directory: store.directory)
    }

    private func received(_ id: String, peer: String = "peer-a", at: TimeInterval = 10,
                          readAt: Date? = nil) -> InboxTimelineEntry {
        .received(taskID: id, peerDeviceID: peer, peerNameSnapshot: "Lily's Mac",
                  kind: .message, at: Date(timeIntervalSince1970: at),
                  messageID: id, byteCount: 5, readAt: readAt)
    }

    private func receivedFiles(_ id: String, peer: String = "peer-a", at: TimeInterval = 10,
                               path: String = "/tmp/received.txt") -> InboxTimelineEntry {
        .received(taskID: id, peerDeviceID: peer, peerNameSnapshot: "Lily's Mac",
                  kind: .files, at: Date(timeIntervalSince1970: at),
                  files: [.init(url: URL(fileURLWithPath: path))], byteCount: 9)
    }

    private func sent(_ id: String, peer: String = "peer-a", at: TimeInterval = 20,
                      state: InboxTimelineEntry.SentState = .staged) -> InboxTimelineEntry {
        .sent(jobID: id, peerDeviceID: peer, peerNameSnapshot: "iPhone", kind: .message,
              at: Date(timeIntervalSince1970: at), byteCount: 4, state: state)
    }

    private func sentFiles(_ id: String, peer: String = "peer-a", at: TimeInterval = 20,
                           names: [String] = ["report.pdf"]) -> InboxTimelineEntry {
        .sent(jobID: id, peerDeviceID: peer, peerNameSnapshot: "iPhone", kind: .files,
              at: Date(timeIntervalSince1970: at), byteCount: 12,
              files: names.map { .init(name: $0, size: 12) })
    }

    private func writeLegacyIndex(_ store: InboxConversationStore, version: Int = 1,
                                  rows: String) throws {
        try InboxJournalStore.ensureDirectory(store.directory)
        try Data("""
        {"version":\(version),"records":[\(rows)]}
        """.utf8).write(to: store.directory.appendingPathComponent("conversations-v1.json"))
    }

    private func legacyRow(_ taskID: String, sender: String = "peer-a", kind: String = "message",
                           receivedAt: TimeInterval = 10, readAt: TimeInterval? = nil) -> String {
        let read = readAt.map { ",\"readAt\":\($0)" } ?? ""
        let message = kind == "message" ? ",\"messageID\":\"\(taskID)\"" : ""
        let files = kind == "message" ? "[]"
            : "[{\"urlPath\":\"/tmp/legacy.txt\",\"displayName\":\"legacy.txt\"}]"
        // `receivedAt` is a `Date`, which JSONDecoder reads as seconds since the
        // 2001 reference date by default — the same encoder wrote the file this
        // migration is replacing, so the fixture uses that spelling too.
        return """
        {"taskID":"\(taskID)","senderDeviceID":"\(sender)","senderNameSnapshot":"Old Mac",\
        "kind":"\(kind)","receivedAt":\(receivedAt)\(message),"files":\(files),\
        "byteCount":5\(read)}
        """
    }

    // MARK: - v1 → v2

    /// Every v1 row becomes a received entry, attribution and read marks intact,
    /// and the v1 file is retired only once the v2 it produced is on disk.
    func testLegacyIndexMigratesOnceAndIsRetiredOnlyAfterTheNewOneIsDurable() throws {
        let store = store()
        try writeLegacyIndex(store, rows: [
            legacyRow("task-one", readAt: 11),
            legacyRow("task-two", kind: "files", receivedAt: 20),
        ].joined(separator: ","))

        let conversations = try store.conversations()
        let entries = try XCTUnwrap(conversations.first).entries
        XCTAssertEqual(entries.map(\.id), ["r:task-two", "r:task-one"])
        XCTAssertTrue(entries.allSatisfy { $0.direction == .received })
        XCTAssertEqual(entries.first { $0.id == "r:task-one" }?.readAt,
                       Date(timeIntervalSinceReferenceDate: 11))
        XCTAssertEqual(entries.first { $0.id == "r:task-two" }?.kind, .files)
        XCTAssertEqual(entries.first { $0.id == "r:task-two" }?.files.first?.displayName,
                       "legacy.txt")
        XCTAssertEqual(try XCTUnwrap(conversations.first).peerNameSnapshot, "Old Mac")

        // v2 exists; v1 is gone; a second load and a relaunch see the same thing.
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: store.directory.appendingPathComponent("conversations-v2.json").path))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: store.directory.appendingPathComponent("conversations-v1.json").path))
        XCTAssertEqual(try store.conversations().first?.entries.map(\.id),
                       ["r:task-two", "r:task-one"])
        XCTAssertEqual(try reopen(store).conversations().first?.entries.map(\.id),
                       ["r:task-two", "r:task-one"])
    }

    /// **The foundation of the whole tombstone mechanism.** A v1 file left beside
    /// a good v2 — by a downgrade, a restore, a backup tool — is never read. If
    /// it were merged, every deletion would come back on the next launch.
    func testALeftoverLegacyIndexIsNeverMergedIntoAnExistingV2() throws {
        let store = store()
        try store.record(received("task-one"))
        let cleanup = try store.delete(entryIDs: ["r:task-one"], peerDeviceID: "peer-a")
        XCTAssertEqual(cleanup.receivedMessageIDs, ["task-one"])

        try writeLegacyIndex(store, rows: [legacyRow("task-one"),
                                           legacyRow("task-zombie")].joined(separator: ","))
        XCTAssertTrue(try store.conversations().isEmpty,
                      "a leftover v1 resurrected deleted history")
        XCTAssertTrue(try reopen(store).conversations().isEmpty)
    }

    /// A v2 that will not decode must not cost the user their v1. The refusal is
    /// visible and the only surviving copy of their history is still there.
    func testAnUnreadableV2FailsVisiblyAndLeavesTheLegacySourceInPlace() throws {
        let store = store()
        try writeLegacyIndex(store, rows: legacyRow("task-one"))
        try Data("half a file".utf8).write(
            to: store.directory.appendingPathComponent("conversations-v2.json"))

        XCTAssertThrowsError(try store.conversations()) {
            XCTAssertEqual($0 as? InboxConversationStoreError, .unreadable)
        }
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: store.directory.appendingPathComponent("conversations-v1.json").path),
                      "a refused v2 destroyed the only remaining copy of the history")
    }

    func testALegacyIndexOfAnUnknownVersionIsRefusedRatherThanGuessedAt() throws {
        let store = store()
        try writeLegacyIndex(store, version: 99, rows: legacyRow("task-one"))
        XCTAssertThrowsError(try store.conversations()) {
            XCTAssertEqual($0 as? InboxConversationStoreError, .unreadable)
        }
    }

    // MARK: - one timeline, both directions

    func testTheTimelineHoldsBothDirectionsAndBothKindsInOneDeterministicOrder() throws {
        let store = store()
        try store.record(received("task-a", at: 10))
        try store.recordSent(sentFiles("job-b", at: 20))
        try store.record(receivedFiles("task-c", at: 30))
        try store.recordSent(sent("job-d", at: 40))

        let conversation = try XCTUnwrap(store.conversations().first)
        XCTAssertEqual(conversation.entries.map(\.id),
                       ["s:job-d", "r:task-c", "s:job-b", "r:task-a"])
        XCTAssertEqual(conversation.entries.map(\.direction),
                       [.sent, .received, .sent, .received])
        XCTAssertEqual(conversation.unreadCount, 2, "a sent entry cannot be unread")
        XCTAssertEqual(conversation.messageCount, 2)
        XCTAssertEqual(conversation.fileCount, 2)
        XCTAssertEqual(conversation.receivedFileURLs.map(\.lastPathComponent), ["received.txt"],
                       "an outgoing entry contributed a path to the Finder action")

        // Persisted, not merely published.
        XCTAssertEqual(try reopen(store).conversations().first?.entries.map(\.id),
                       ["s:job-d", "r:task-c", "s:job-b", "r:task-a"])
    }

    /// Two entries in the same second still have ONE order, and it is the same
    /// order on every read. `sorted(by:)` is not stable, so without the id
    /// tie-break the list would reshuffle between two reads of an unchanged file.
    func testEntriesAtTheSameInstantOrderDeterministicallyByLocalID() throws {
        let store = store()
        try store.record(received("task-a", at: 50))
        try store.recordSent(sent("job-a", at: 50))
        try store.record(received("task-b", at: 50))
        let first = try XCTUnwrap(store.conversations().first).entries.map(\.id)
        XCTAssertEqual(first, ["s:job-a", "r:task-b", "r:task-a"])
        for _ in 0..<5 {
            XCTAssertEqual(try XCTUnwrap(reopen(store).conversations().first).entries.map(\.id),
                           first)
        }
    }

    /// **A state change may not move a row.** A poll that discovers central saved
    /// a delivery reorders nothing, and only `tracking(.saved)` — which is what
    /// reaches `.saved` here — may claim an arrival.
    func testAnOutgoingStateUpdateChangesStateAndTaskAndNeverTheOrderingAnchor() throws {
        let store = store()
        try store.recordSent(sent("job-a", at: 20))
        try store.record(received("task-b", at: 30))
        let anchor = try XCTUnwrap(store.conversations().first?.entries
            .first { $0.id == "s:job-a" }?.at)

        try store.updateSent(jobID: "job-a", state: .sending)
        try store.updateSent(jobID: "job-a", state: .created, taskID: "central-task")
        try store.updateSent(jobID: "job-a", state: .saved)

        let entries = try XCTUnwrap(store.conversations().first).entries
        XCTAssertEqual(entries.map(\.id), ["r:task-b", "s:job-a"], "an update reordered the timeline")
        let sent = try XCTUnwrap(entries.first { $0.id == "s:job-a" })
        XCTAssertEqual(sent.at, anchor)
        XCTAssertEqual(sent.sentState, .saved)
        XCTAssertTrue(sent.isSavedOnTarget)
        XCTAssertEqual(sent.sentTaskID, "central-task")
        // And every non-saved state leaves the arrival claim false.
        for state in InboxTimelineEntry.SentState.allCases where state != .saved {
            try store.updateSent(jobID: "job-a", state: state)
            XCTAssertFalse(try XCTUnwrap(store.conversations().first?.entries
                .first { $0.id == "s:job-a" }).isSavedOnTarget,
                           "\(state) claimed an arrival")
        }
    }

    /// `recordSent` is called again by every recovery pass. It must refresh what
    /// it may and move nothing — a re-materialized plan keeps its place.
    func testRecordingTheSameSendAgainIsIdempotentAndKeepsTheOriginalAnchor() throws {
        let store = store()
        XCTAssertTrue(try store.recordSent(sent("job-a", at: 20)))
        try store.updateSent(jobID: "job-a", state: .created, taskID: "central-task")
        XCTAssertFalse(try store.recordSent(sent("job-a", at: 999, state: .staged)))
        let entry = try XCTUnwrap(store.conversations().first?.entries.first)
        XCTAssertEqual(entry.at, Date(timeIntervalSince1970: 20))
        XCTAssertEqual(entry.sentState, .created,
                       "a recovery pass overwrote what was already known")
        XCTAssertEqual(entry.sentTaskID, "central-task")
    }

    func testObservedReadSetDoesNotClearAConcurrentArrival() throws {
        let store = store()
        try store.record(received("observed", at: 10))
        let observed = try XCTUnwrap(store.conversations().first).entryIDs
        try store.record(received("arrived-later", at: 20))
        try store.markRead(peerDeviceID: "peer-a", observedEntryIDs: observed,
                           at: Date(timeIntervalSince1970: 30))
        let entries = try XCTUnwrap(store.conversations().first).entries
        XCTAssertNotNil(entries.first { $0.id == "r:observed" }?.readAt)
        XCTAssertNil(entries.first { $0.id == "r:arrived-later" }?.readAt)
    }

    func testTheIndexIsPrivateOnDiskAndCarriesNoPlaintext() throws {
        let store = store()
        try store.record(received("task-a"))
        try store.importLegacy(messages: [InboxMessage(id: "legacy-task",
            receivedAt: Date(timeIntervalSince1970: 5), text: "secret")])
        var st = stat()
        XCTAssertEqual(lstat(store.directory.path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o700)
        let index = store.directory.appendingPathComponent("conversations-v2.json")
        XCTAssertEqual(lstat(index.path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
        XCTAssertFalse(String(decoding: try Data(contentsOf: index), as: UTF8.self)
            .contains("secret"))
    }

    // MARK: - the union, enforced

    /// **A sent entry never carries a filesystem path.** This is the one refusal
    /// that keeps a container path or a user's own directory structure out of a
    /// durable index a surface renders.
    func testASentEntryCarryingAPathOrAReceivedOnlyFieldIsRefused() throws {
        let store = store()
        let withPath = InboxTimelineEntry(
            id: "s:job-a", peerDeviceID: "peer-a", direction: .sent, kind: .files,
            at: Date(timeIntervalSince1970: 10), peerNameSnapshot: "iPhone", byteCount: 1,
            files: [.init(url: URL(fileURLWithPath: "/Users/lily/secret/report.pdf"))],
            jobID: "job-a", sentState: .staged,
            sentFiles: [.init(name: "report.pdf", size: 1)])
        XCTAssertFalse(InboxConversationStore.valid(withPath))
        XCTAssertThrowsError(try store.recordSent(withPath)) {
            XCTAssertEqual($0 as? InboxConversationStoreError, .invalidRecord)
        }

        for name in ["/etc/passwd", "~/Documents/a.txt", "..\\slot", "../../escape",
                     "staged\u{0}slot", ""] {
            XCTAssertFalse(InboxConversationStore.isSafeManifestName(name),
                           "\(name) passed as a manifest identity")
            XCTAssertThrowsError(try store.recordSent(sentFiles("job-\(abs(name.hashValue))",
                                                                names: [name])))
        }
        // A manifest name legitimately keeps a chosen folder's hierarchy.
        XCTAssertTrue(InboxConversationStore.isSafeManifestName("photos/2026/a.jpg"))
        XCTAssertTrue(try store.recordSent(sentFiles("job-ok", names: ["photos/2026/a.jpg"])))

        // Read as well as write: a hand-edited index is refused, not rendered.
        try Data("""
        {"version":2,"entries":[{"id":"s:job-x","peerDeviceID":"peer-a","direction":"sent",\
        "kind":"files","at":1,"peerNameSnapshot":"iPhone","byteCount":1,\
        "files":[{"urlPath":"/Users/lily/secret.pdf","displayName":"secret.pdf"}],\
        "jobID":"job-x","sentState":"staged","sentFiles":[{"name":"secret.pdf","size":1}]}],\
        "tombstones":[]}
        """.utf8).write(to: store.directory.appendingPathComponent("conversations-v2.json"))
        XCTAssertThrowsError(try store.conversations()) {
            XCTAssertEqual($0 as? InboxConversationStoreError, .unreadable)
        }
    }

    func testTheConverseUnionIsRefusedAndEachWriteGateRefusesTheOtherDirection() throws {
        let store = store()
        var receivedWithSentPayload = received("task-a")
        receivedWithSentPayload.sentState = .saved
        XCTAssertFalse(InboxConversationStore.valid(receivedWithSentPayload))
        XCTAssertThrowsError(try store.record(receivedWithSentPayload))

        // A received row that claims it was never read by the reader who sent it.
        let sentWithReadAt = InboxTimelineEntry(
            id: "s:job-a", peerDeviceID: "peer-a", direction: .sent, kind: .message,
            at: Date(), peerNameSnapshot: "iPhone", byteCount: 1,
            readAt: Date(), jobID: "job-a", sentState: .staged, sentMessageID: "job-a")
        XCTAssertFalse(InboxConversationStore.valid(sentWithReadAt))

        // Each gate takes its own direction only.
        XCTAssertThrowsError(try store.record(sent("job-a")))
        XCTAssertThrowsError(try store.recordSent(received("task-a")))

        // Kind and payload must agree in both directions.
        XCTAssertFalse(InboxConversationStore.valid(InboxTimelineEntry(
            id: "r:task-b", peerDeviceID: "peer-a", direction: .received, kind: .files,
            at: Date(), peerNameSnapshot: "Mac", byteCount: 1, taskID: "task-b")))
        XCTAssertFalse(InboxConversationStore.valid(InboxTimelineEntry(
            id: "s:job-b", peerDeviceID: "peer-a", direction: .sent, kind: .files,
            at: Date(), peerNameSnapshot: "iPhone", byteCount: 1,
            jobID: "job-b", sentState: .staged)))
    }

    /// The sender's staging placeholder is a global singleton slot. A durable row
    /// built on it would be one send overwriting another's history, and a
    /// tombstone on it would ban every future send.
    func testTheTransientStagingPlaceholderIsNeverPersistedAsHistory() throws {
        let store = store()
        XCTAssertThrowsError(try store.recordSent(sent("staging")))
        try store.updateSent(jobID: "staging", state: .saved)
        XCTAssertTrue(try store.conversations().isEmpty)
        XCTAssertFalse(InboxConversationStore.isTombstonable("s:staging"))
        XCTAssertFalse(InboxConversationStore.isTombstonable("task-a"),
                       "an unprefixed id is tombstonable, so the two namespaces can collide")
    }

    /// Equal raw identifiers in the two namespaces are two different rows.
    func testAnEqualTaskAndJobIdentifierCannotCollide() throws {
        let store = store()
        try store.record(received("same", at: 10))
        try store.recordSent(sent("same", at: 20))
        let entries = try XCTUnwrap(store.conversations().first).entries
        XCTAssertEqual(entries.map(\.id), ["s:same", "r:same"])

        let cleanup = try store.delete(entryIDs: ["s:same"], peerDeviceID: "peer-a")
        XCTAssertEqual(cleanup.sentMessageIDs, ["same"])
        XCTAssertEqual(cleanup.receivedMessageIDs, [],
                       "deleting a sent row scheduled the RECEIVED body of the same raw id")
        XCTAssertEqual(try store.conversations().first?.entries.map(\.id), ["r:same"])
    }

    // MARK: - deletion

    func testDeletingOneEntryTombstonesItAndReturnsOnlyRelayiumOwnedPlaintext() throws {
        let store = store()
        try store.record(received("task-a", at: 10))
        try store.record(receivedFiles("task-b", at: 20))
        try store.recordSent(sent("job-c", at: 30))
        try store.recordSent(sentFiles("job-d", at: 40))

        // A received FILE row and a sent FILE row own no plaintext at all: the
        // one is the user's file in their own folder, the other is a name.
        XCTAssertTrue(try store.delete(entryIDs: ["r:task-b"], peerDeviceID: "peer-a").isEmpty)
        XCTAssertTrue(try store.delete(entryIDs: ["s:job-d"], peerDeviceID: "peer-a").isEmpty)
        XCTAssertEqual(try store.delete(entryIDs: ["r:task-a"], peerDeviceID: "peer-a")
            .receivedMessageIDs, ["task-a"])
        XCTAssertEqual(try store.delete(entryIDs: ["s:job-c"], peerDeviceID: "peer-a")
            .sentMessageIDs, ["job-c"])

        XCTAssertTrue(try store.conversations().isEmpty)
        XCTAssertEqual(try store.deletedIDs(), ["r:task-a", "r:task-b", "s:job-c", "s:job-d"])
        XCTAssertTrue(store.isDeleted("s:job-c"))
        XCTAssertTrue(try reopen(store).conversations().isEmpty)
    }

    /// **The snapshot, not a peer-wide ban.** Exactly the ids the screen showed
    /// are removed; a delivery committed while the confirmation was up survives
    /// as a new unread row, and every observed id stays refused for good.
    func testConversationDeletionTakesTheObservedSnapshotAndSpsAConcurrentArrival() throws {
        let store = store()
        try store.record(received("task-a", at: 10))
        try store.recordSent(sent("job-b", at: 20))
        let observed = try XCTUnwrap(store.conversations().first).entryIDs
        XCTAssertEqual(observed, ["r:task-a", "s:job-b"])

        // Committed after the snapshot was taken, before the user confirmed.
        try store.record(received("task-late", at: 25))

        let cleanup = try store.delete(entryIDs: observed, peerDeviceID: "peer-a")
        XCTAssertEqual(cleanup.receivedMessageIDs, ["task-a"])
        XCTAssertEqual(cleanup.sentMessageIDs, ["job-b"])

        let after = try XCTUnwrap(store.conversations().first)
        XCTAssertEqual(after.entries.map(\.id), ["r:task-late"])
        XCTAssertEqual(after.unreadCount, 1, "the concurrent arrival was silently marked read")

        // And a replay of every observed id still cannot come back.
        try store.record(received("task-a", at: 10))
        try store.recordSent(sent("job-b", at: 20))
        XCTAssertEqual(try store.conversations().first?.entries.map(\.id), ["r:task-late"])
    }

    /// A screen's snapshot can be stale or mis-plumbed. An id whose row belongs
    /// to another peer is refused rather than deleted-and-permanently-banned.
    func testConversationDeletionCannotReachAnotherPeersRows() throws {
        let store = store()
        try store.record(received("task-mine", peer: "peer-a", at: 10))
        try store.record(received("task-theirs", peer: "peer-b", at: 20))

        let cleanup = try store.delete(entryIDs: ["r:task-mine", "r:task-theirs"],
                                       peerDeviceID: "peer-a")
        XCTAssertEqual(cleanup.receivedMessageIDs, ["task-mine"])
        XCTAssertEqual(try store.deletedIDs(), ["r:task-mine"],
                       "a tombstone was written for another peer's row")
        XCTAssertEqual(try store.conversations()
            .first { $0.peerDeviceID == "peer-b" }?.entries.map(\.id), ["r:task-theirs"])
        // Still deletable by its real owner, so the refusal did not strand it.
        XCTAssertEqual(try store.delete(entryIDs: ["r:task-theirs"], peerDeviceID: "peer-b")
            .receivedMessageIDs, ["task-theirs"])
    }

    func testDeletingNothingAndDeletingAnAbsentRowAreBothNoOps() throws {
        let store = store()
        try store.record(received("task-a"))
        XCTAssertTrue(try store.delete(entryIDs: [], peerDeviceID: "peer-a").isEmpty)
        XCTAssertTrue(try store.delete(entryIDs: ["r:never-existed"],
                                       peerDeviceID: "peer-a").isEmpty)
        XCTAssertTrue(try store.deletedIDs().isEmpty)
        XCTAssertEqual(try store.conversations().first?.entries.map(\.id), ["r:task-a"])
    }

    // MARK: - no resurrection, one gate at a time

    private func deletedStore() throws -> InboxConversationStore {
        let store = store()
        try store.record(received("task-a", at: 10))
        try store.recordSent(sent("job-a", at: 20))
        _ = try store.delete(entryIDs: ["r:task-a", "s:job-a"], peerDeviceID: "peer-a")
        XCTAssertTrue(try store.conversations().isEmpty)
        return store
    }

    func testAReplayedReceiptCannotResurrectADeletedEntry() throws {
        let store = try deletedStore()
        XCTAssertFalse(try store.record(received("task-a", at: 10)))
        XCTAssertTrue(try store.conversations().isEmpty)
    }

    func testTheLegacyMessageImportCannotResurrectADeletedEntry() throws {
        let store = store()
        try store.importLegacy(messages: [InboxMessage(id: "legacy-task",
            receivedAt: Date(timeIntervalSince1970: 5), text: "body")])
        _ = try store.delete(entryIDs: ["r:legacy-task"],
                             peerDeviceID: InboxConversationStore.legacySenderID)
        try store.importLegacy(messages: [InboxMessage(id: "legacy-task",
            receivedAt: Date(timeIntervalSince1970: 5), text: "body")])
        XCTAssertTrue(try store.conversations().isEmpty)
    }

    func testTheLegacyReceiptImportCannotResurrectADeletedEntry() throws {
        let store = try deletedStore()
        try store.importLegacy(receipts: [InboxReceipt(
            taskID: "task-a", senderDeviceID: "peer-a",
            urls: [URL(fileURLWithPath: "/tmp/a.txt")], byteCount: 1,
            savedAt: Date(timeIntervalSince1970: 10), isReplay: true)])
        XCTAssertTrue(try store.conversations().isEmpty)
    }

    /// `start()` runs the legacy import unconditionally, so `restart()` — a
    /// policy change, a folder change, Try again — reruns it. Repeating it must
    /// converge on nothing rather than on the deleted rows.
    func testRepeatedStartupImportsConvergeOnNothing() throws {
        let store = try deletedStore()
        for _ in 0..<3 {
            try store.importLegacy(receipts: [InboxReceipt(
                taskID: "task-a", senderDeviceID: "peer-a",
                urls: [URL(fileURLWithPath: "/tmp/a.txt")], byteCount: 1,
                savedAt: Date(timeIntervalSince1970: 10), isReplay: true)])
            try store.importLegacy(messages: [InboxMessage(id: "task-a",
                receivedAt: Date(timeIntervalSince1970: 10), text: "body")])
            XCTAssertTrue(try store.conversations().isEmpty)
        }
    }

    func testAnOutgoingStateUpdateCannotResurrectADeletedEntry() throws {
        let store = try deletedStore()
        try store.updateSent(jobID: "job-a", state: .saved, taskID: "central-task")
        XCTAssertTrue(try store.conversations().isEmpty)
    }

    /// A retry, or a plan rediscovered by `refreshOutstanding` in a later
    /// process, calls `recordSent` again. It must not write the row back.
    func testARecoveredPlanCannotMaterializeADeletedSend() throws {
        let store = try deletedStore()
        XCTAssertFalse(try store.recordSent(sent("job-a", at: 20)))
        XCTAssertFalse(try store.recordSent(sent("job-a", at: 20, state: .created)))
        XCTAssertTrue(try store.conversations().isEmpty)
    }

    func testARelaunchCannotResurrectADeletedEntry() throws {
        let store = try deletedStore()
        let relaunched = reopen(store)
        XCTAssertFalse(try relaunched.record(received("task-a", at: 10)))
        XCTAssertFalse(try relaunched.recordSent(sent("job-a", at: 20)))
        XCTAssertTrue(try relaunched.conversations().isEmpty)
        XCTAssertEqual(try relaunched.deletedIDs(), ["r:task-a", "s:job-a"])
    }

    /// Sign-out keeps this account's history and its tombstones; another account
    /// is a different directory and inherits neither.
    func testSignOutPreservesHistoryAndAnotherAccountInheritsNothing() throws {
        let accountA = store("account-a-" + UUID().uuidString)
        try accountA.record(received("task-keep", at: 10))
        try accountA.record(received("task-gone", at: 20))
        _ = try accountA.delete(entryIDs: ["r:task-gone"], peerDeviceID: "peer-a")

        // Signing out and back in is a new store over the same directory.
        let returned = reopen(accountA)
        XCTAssertEqual(try returned.conversations().first?.entries.map(\.id), ["r:task-keep"])
        XCTAssertFalse(try returned.record(received("task-gone", at: 20)))

        let accountB = store("account-b-" + UUID().uuidString)
        XCTAssertTrue(try accountB.conversations().isEmpty)
        XCTAssertTrue(try accountB.deletedIDs().isEmpty)
        XCTAssertTrue(try accountB.record(received("task-gone", at: 20)),
                      "one account's tombstone banned another account's delivery")
    }

    // MARK: - the crash window between the index write and the unlink

    /// The tombstone keeps the cleanup identity, so a process that died before
    /// the unlink converges on the next refresh instead of leaving a body on disk
    /// for a row nothing can delete again.
    func testPendingPlaintextCleanupSurvivesARelaunchAndClearsExactlyOnce() throws {
        let store = store()
        try store.record(received("task-a", at: 10))
        try store.recordSent(sent("job-a", at: 20))
        let cleanup = try store.delete(entryIDs: ["r:task-a", "s:job-a"], peerDeviceID: "peer-a")
        XCTAssertEqual(cleanup.receivedMessageIDs, ["task-a"])
        XCTAssertEqual(cleanup.sentMessageIDs, ["job-a"])

        // The process dies here, before either unlink. A relaunch is still owed
        // both of them.
        let relaunched = reopen(store)
        let owed = try relaunched.pendingPlaintextCleanup()
        XCTAssertEqual(owed.receivedMessageIDs, ["task-a"])
        XCTAssertEqual(owed.sentMessageIDs, ["job-a"])

        // Only what actually unlinked is cleared; the rest stays owed.
        try relaunched.clearPlaintextCleanup(InboxTimelineCleanup(receivedMessageIDs: ["task-a"]))
        XCTAssertTrue(try relaunched.pendingPlaintextCleanup().receivedMessageIDs.isEmpty)
        XCTAssertEqual(try relaunched.pendingPlaintextCleanup().sentMessageIDs, ["job-a"])

        try relaunched.clearPlaintextCleanup(InboxTimelineCleanup(sentMessageIDs: ["job-a"]))
        XCTAssertTrue(try reopen(store).pendingPlaintextCleanup().isEmpty)
        // Cleared is not forgotten: the ban survives the cleanup.
        XCTAssertEqual(try reopen(store).deletedIDs(), ["r:task-a", "s:job-a"])
    }

    // MARK: - attribution

    func testRestartImportKeepsAuthenticatedJournalSenderAndUpgradesLegacyPlaceholder() throws {
        let direct = store()
        try direct.importLegacy(receipts: [InboxReceipt(taskID: "journal-task",
            senderDeviceID: "peer-device", urls: [URL(fileURLWithPath: "/tmp/a.txt")],
            byteCount: 1, savedAt: Date(timeIntervalSince1970: 10), isReplay: true)])
        XCTAssertEqual(try direct.conversations().first?.peerDeviceID, "peer-device")

        let promoted = store()
        try promoted.importLegacy(messages: [InboxMessage(id: "same-task",
            receivedAt: Date(timeIntervalSince1970: 5), text: "body")])
        XCTAssertFalse(try promoted.record(received("same-task", peer: "peer-device", at: 5)))
        let conversation = try XCTUnwrap(promoted.conversations().first)
        XCTAssertEqual(conversation.peerDeviceID, "peer-device")
        XCTAssertNotNil(conversation.entries.first?.readAt,
                        "restart attribution must not turn an old delivery unread")

        XCTAssertThrowsError(try promoted.record(received("same-task", peer: "forged-device",
                                                          at: 5))) {
            XCTAssertEqual($0 as? InboxConversationStoreError, .invalidRecord)
        }
        XCTAssertEqual(try promoted.conversations().first?.peerDeviceID, "peer-device")
    }

    /// **A legacy import losing to real attribution is a no-op, not a failure.**
    ///
    /// `start()` replays the whole flat message store on every launch. Before
    /// this, the second launch after ANY authenticated received message threw
    /// `invalidRecord` out of `importLegacy` — and `refreshConversations` catches
    /// that by blanking the published list and raising the history-unreadable
    /// banner. One message plus one restart emptied the whole section.
    func testAReplayedLegacyImportOfAnAlreadyAttributedTaskIsANoOpNotAFailure() throws {
        let store = store()
        try store.record(received("task-a", peer: "peer-device", at: 10))
        // Exactly what `refreshConversations(importLegacy: true)` does with the
        // message store's contents on the next launch, twice.
        for _ in 0..<2 {
            try store.importLegacy(messages: [InboxMessage(id: "task-a",
                receivedAt: Date(timeIntervalSince1970: 10), text: "body")])
        }
        let conversation = try XCTUnwrap(store.conversations().first)
        XCTAssertEqual(conversation.peerDeviceID, "peer-device",
                       "a legacy replay downgraded authenticated attribution")
        XCTAssertEqual(conversation.entries.map(\.id), ["r:task-a"])
    }

    func testARenameUpdatesTheNameSnapshotAndControlCharactersAreRefusedInIt() throws {
        let store = store()
        try store.record(received("one", peer: "stable-id", at: 10))
        var renamed = received("two", peer: "stable-id", at: 20)
        renamed.peerNameSnapshot = "Renamed Mac"
        try store.record(renamed)
        XCTAssertEqual(try store.conversations().first { $0.peerDeviceID == "stable-id" }?
            .peerNameSnapshot, "Renamed Mac")

        var unsafe = received("three", peer: "other-id", at: 30)
        unsafe.peerNameSnapshot = "  Sender\u{0000}\n" + String(repeating: "x", count: 100)
        try store.record(unsafe)
        let normalized = try XCTUnwrap(try store.conversations()
            .first { $0.peerDeviceID == "other-id" }).peerNameSnapshot
        XCTAssertFalse(normalized.unicodeScalars.contains {
            CharacterSet.controlCharacters.contains($0)
        })
        XCTAssertLessThanOrEqual(normalized.unicodeScalars.count, 80)
    }
}
