import Darwin
import XCTest
@testable import RelayiumAppKit

final class InboxConversationStoreTests: XCTestCase {
    private func store(_ name: String = UUID().uuidString) -> InboxConversationStore {
        InboxConversationStore(directory: FileManager.default.temporaryDirectory
            .appendingPathComponent("relayium-conversations-\(name)", isDirectory: true))
    }

    private func message(_ id: String, sender: String = "sender-a", at: TimeInterval = 10,
                         readAt: Date? = nil) -> InboxDeliveryRecord {
        InboxDeliveryRecord(taskID: id, senderDeviceID: sender,
            senderNameSnapshot: "Lily's Mac", kind: .message,
            receivedAt: Date(timeIntervalSince1970: at), messageID: id,
            byteCount: 5, readAt: readAt)
    }

    func testStoreIsPrivateDurableOrderedAndIdempotent() throws {
        let store = store()
        XCTAssertTrue(try store.record(message("task-a", at: 10)))
        XCTAssertTrue(try store.record(message("task-b", at: 20)))
        XCTAssertFalse(try store.record(message("task-b", at: 20)))
        let conversation = try XCTUnwrap(store.conversations().first)
        XCTAssertEqual(conversation.deliveries.map(\.taskID), ["task-b", "task-a"])
        XCTAssertEqual(conversation.unreadCount, 2)

        var st = stat()
        XCTAssertEqual(lstat(store.directory.path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o700)
        XCTAssertEqual(lstat(store.directory.appendingPathComponent("conversations-v1.json").path, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o600)
    }

    func testObservedReadSetDoesNotClearConcurrentArrival() throws {
        let store = store()
        try store.record(message("observed", at: 10))
        let observed = Set(try store.conversations()[0].deliveries.map(\.taskID))
        try store.record(message("arrived-later", at: 20))
        try store.markRead(senderDeviceID: "sender-a", observedTaskIDs: observed,
                           at: Date(timeIntervalSince1970: 30))
        let records = try store.conversations()[0].deliveries
        XCTAssertNotNil(records.first { $0.taskID == "observed" }?.readAt)
        XCTAssertNil(records.first { $0.taskID == "arrived-later" }?.readAt)
    }

    func testRenameSameNameReinstallAndAccountIsolationUseStableIDs() throws {
        let first = store("account-a")
        try first.record(message("one", sender: "stable-id"))
        var renamed = message("two", sender: "stable-id", at: 20)
        renamed.senderNameSnapshot = "Renamed Mac"
        try first.record(renamed)
        try first.record(message("three", sender: "reinstall-id", at: 30))
        XCTAssertEqual(try first.conversations().count, 2)
        XCTAssertEqual(try first.conversations().first { $0.senderDeviceID == "stable-id" }?
            .senderNameSnapshot, "Renamed Mac")
        XCTAssertTrue(try store("account-b").conversations().isEmpty)
    }

    func testCorruptionFailsVisibleAndLegacyImportReferencesMessageOnly() throws {
        let store = store()
        try InboxJournalStore.ensureDirectory(store.directory)
        let index = store.directory.appendingPathComponent("conversations-v1.json")
        try Data("partial".utf8).write(to: index)
        XCTAssertThrowsError(try store.conversations()) {
            XCTAssertEqual($0 as? InboxConversationStoreError, .unreadable)
        }

        try FileManager.default.removeItem(at: index)
        try store.importLegacy(messages: [InboxMessage(id: "legacy-task",
            receivedAt: Date(timeIntervalSince1970: 5), text: "secret")])
        let legacy = try XCTUnwrap(store.conversations().first)
        XCTAssertEqual(legacy.senderDeviceID, InboxConversationStore.legacySenderID)
        XCTAssertEqual(legacy.deliveries.first?.messageID, "legacy-task")
        let bytes = try Data(contentsOf: index)
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("secret"))
    }
}
