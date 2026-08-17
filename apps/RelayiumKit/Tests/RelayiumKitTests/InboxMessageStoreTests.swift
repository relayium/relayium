import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The protected message store, on its own terms.
///
/// Every assertion here is about a property a text delivery depends on: that a
/// message is stored whole and exactly, that storing the same delivery twice
/// produces one message and not two, that the directory and the record are
/// private, and that a message never has anything to do with the receive folder.
final class InboxMessageStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-messages-\(UUID().uuidString)")
        addTeardownBlock { [directory] in
            try? FileManager.default.removeItem(at: directory!)
        }
    }

    private func store() -> InboxMessageStore { InboxMessageStore(directory: directory) }

    func testAMessageIsStoredAndReadBackExactly() throws {
        let s = store()
        // Deliberately not plain ASCII: a message is arbitrary user text, and a
        // store that mangled an emoji, a combining mark or a right-to-left run
        // would be showing the user something nobody wrote.
        let text = "Meet at 六点 — ok? 👍\u{202E}rev\nsecond line\ttab"
        try s.commit(id: "task1", text: text, receivedAt: Date(timeIntervalSince1970: 1_700_000_000))

        let loaded = try XCTUnwrap(s.load("task1"))
        XCTAssertEqual(loaded.text, text)
        XCTAssertEqual(loaded.id, "task1")
        XCTAssertEqual(loaded.byteCount, text.utf8.count)
        XCTAssertEqual(loaded.receivedAt, Date(timeIntervalSince1970: 1_700_000_000))
    }

    /// The message half of the no-duplicate contract. A `saved` report that never
    /// reached central is re-asserted on the next claim, and the commit is
    /// replayed — the user must end up with ONE message, not two.
    func testCommittingTheSameDeliveryTwiceLeavesOneMessage() throws {
        let s = store()
        try s.commit(id: "task1", text: "hello", receivedAt: Date(timeIntervalSince1970: 10))
        try s.commit(id: "task1", text: "hello", receivedAt: Date(timeIntervalSince1970: 20))

        XCTAssertEqual(s.all().count, 1)
        XCTAssertEqual(try s.load("task1")?.text, "hello")
    }

    func testTwoDeliveriesAreTwoMessagesNewestFirst() throws {
        let s = store()
        try s.commit(id: "task1", text: "first", receivedAt: Date(timeIntervalSince1970: 10))
        try s.commit(id: "task2", text: "second", receivedAt: Date(timeIntervalSince1970: 20))

        XCTAssertEqual(s.all().map(\.id), ["task2", "task1"])
    }

    /// Not one byte outside the protocol's bounds. An empty message is not a
    /// message, and one past 64 KiB is not one this store will claim to hold.
    func testTheBoundsAreRefusedRatherThanTruncated() throws {
        let s = store()
        XCTAssertThrowsError(try s.commit(id: "task1", text: "",
                                          receivedAt: Date())) { error in
            XCTAssertEqual(error as? InboxMessageStoreError, .invalidMessage)
        }
        let tooLong = String(repeating: "a", count: InboxManifest.maxTextBytes + 1)
        XCTAssertThrowsError(try s.commit(id: "task2", text: tooLong,
                                          receivedAt: Date())) { error in
            XCTAssertEqual(error as? InboxMessageStoreError, .invalidMessage)
        }
        // Exactly at the ceiling is legal: the bound is inclusive, and an
        // off-by-one here would silently refuse a message the sender was told
        // would fit.
        XCTAssertNoThrow(try s.commit(id: "task3",
                                      text: String(repeating: "a",
                                                   count: InboxManifest.maxTextBytes),
                                      receivedAt: Date()))
        XCTAssertEqual(s.all().map(\.id), ["task3"])
    }

    /// A remote string becomes a local file name here, so that conversion must
    /// not depend on a remote invariant staying true.
    func testAHostileTaskIDCannotNameAFile() throws {
        let s = store()
        for id in ["../escape", "a/b", "", String(repeating: "x", count: 65)] {
            XCTAssertThrowsError(try s.commit(id: id, text: "x", receivedAt: Date()),
                                 "task id \(id) was accepted as a file name")
        }
        let landed = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        XCTAssertEqual(landed, [])
    }

    /// A message is the user's own content. The directory is 0700 and the record
    /// 0600 — the same posture as the journal, which holds far less.
    func testTheStoreAndItsRecordsArePrivate() throws {
        let s = store()
        try s.commit(id: "task1", text: "private", receivedAt: Date())

        let dir = try FileManager.default.attributesOfItem(atPath: directory.path)
        XCTAssertEqual(dir[.posixPermissions] as? Int, 0o700)
        let file = try FileManager.default.attributesOfItem(
            atPath: directory.appendingPathComponent("task1.json").path)
        XCTAssertEqual(file[.posixPermissions] as? Int, 0o600)
    }

    /// A record this build cannot interpret is refused, never guessed at.
    func testAnUnreadableRecordIsRefusedRatherThanParsedOptimistically() throws {
        let s = store()
        try s.commit(id: "task1", text: "hello", receivedAt: Date())
        try Data("{\"version\":999,\"id\":\"task1\",\"receivedAt\":0,\"text\":\"x\"}".utf8)
            .write(to: directory.appendingPathComponent("task1.json"))

        XCTAssertThrowsError(try s.load("task1")) { error in
            XCTAssertEqual(error as? InboxMessageStoreError, .unreadable)
        }
        // One unreadable record must not make the rest unreachable.
        try s.commit(id: "task2", text: "still here", receivedAt: Date())
        XCTAssertEqual(s.all().map(\.id), ["task2"])
    }

    func testANeverReceivedDeliveryIsNilRatherThanAnError() throws {
        XCTAssertNil(try store().load("task-never-seen"))
    }
}
