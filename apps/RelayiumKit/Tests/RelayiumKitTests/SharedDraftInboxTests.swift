import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// The app half of the Share extension hand-off: notice a staged draft, hand its
/// files to the send flow, and clean up one launch later.
@MainActor
final class SharedDraftInboxTests: XCTestCase {
    private var root: URL!
    private var store: SharedDraftStore!
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("inbox-\(UUID().uuidString)")
        store = SharedDraftStore(root: root)
        suiteName = "inbox-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: root)
    }

    /// Publish one draft holding one file, exactly as the extension does.
    @discardableResult
    private func publish(_ name: String, contents: String = "x") throws -> SharedDraftPlan {
        let tree = FileManager.default.temporaryDirectory
            .appendingPathComponent("src-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tree, withIntermediateDirectories: true)
        let file = tree.appendingPathComponent(name)
        try Data(contents.utf8).write(to: file)
        let writer = try store.beginDraft()
        try writer.adopt(file, suggestedName: name)
        return try writer.publish()
    }

    private func inbox() -> SharedDraftInbox {
        SharedDraftInbox(store: store, defaults: defaults)
    }

    private var adoptedIds: [String] {
        defaults.stringArray(forKey: SharedDraftInbox.defaultsKey) ?? []
    }

    func testAnEmptyContainerYieldsNothing() {
        XCTAssertTrue(inbox().collect().isEmpty)
        XCTAssertEqual(adoptedIds, [])
    }

    /// The un-provisioned development build: no App Group, so no store. The rest
    /// of the app must go on working.
    func testNoStoreIsNotAnError() {
        let none = SharedDraftInbox(store: nil, defaults: defaults)
        XCTAssertTrue(none.collect().isEmpty)
    }

    func testAStagedDraftIsHandedOverAndRecorded() throws {
        let plan = try publish("a.bin")
        let files = inbox().collect()
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0].lastPathComponent, "a.bin")
        XCTAssertEqual(adoptedIds, [plan.id])
    }

    /// **The bytes must still be there.** A realtime send reads the files at the
    /// moment it sends, so retiring at adoption would hand the user a selection
    /// whose files no longer exist — and nothing in the UI would say so until
    /// Send failed.
    func testAdoptionDoesNotDeleteTheFiles() throws {
        try publish("a.bin")
        let files = inbox().collect()
        XCTAssertTrue(FileManager.default.fileExists(atPath: files[0].path),
                      "the send flow still needs these bytes")
    }

    /// Called on every activation, so a second call in the same session must do
    /// nothing at all.
    func testASecondCollectInTheSameSessionOffersNothingAgain() throws {
        try publish("a.bin")
        let box = inbox()
        XCTAssertEqual(box.collect().count, 1)
        XCTAssertTrue(box.collect().isEmpty, "a draft must never be offered twice")
    }

    /// A new session — a new object over the same defaults — retires what the
    /// previous one adopted, and only then looks for new work.
    func testTheNextSessionRetiresWhatTheLastOneAdopted() throws {
        let plan = try publish("a.bin")
        let first = inbox().collect()
        XCTAssertEqual(first.count, 1)

        XCTAssertTrue(inbox().collect().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first[0].path),
                       "the previous session's bytes must be collected")
        XCTAssertNil(store.draft(id: plan.id))
        XCTAssertEqual(adoptedIds, [], "nothing is left recorded once it is retired")
    }

    /// A draft that arrives while an earlier one is still recorded: the old one
    /// is retired, the new one is handed over, and they do not interfere.
    func testANewDraftArrivesWhileAnOlderOneIsStillRecorded() throws {
        try publish("old.bin")
        let firstRound = inbox().collect()
        XCTAssertEqual(firstRound.count, 1)

        let second = try publish("new.bin")
        let secondRound = inbox().collect()
        XCTAssertEqual(secondRound.map(\.lastPathComponent), ["new.bin"])
        XCTAssertEqual(adoptedIds, [second.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: firstRound[0].path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: secondRound[0].path))
    }

    /// A shared FOLDER is handed over as one root, not as its leaves.
    ///
    /// That is the shape `expandSelection` is written against — the same one a
    /// drop produces — so the receiver sees the folder the user shared with its
    /// own name and its own tree, rather than a flat pile of files.
    func testASharedFolderIsHandedOverAsOneRootThatStillContainsItsFiles() throws {
        let tree = FileManager.default.temporaryDirectory
            .appendingPathComponent("src-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tree, withIntermediateDirectories: true)
        for name in ["a.bin", "b.bin", "c.bin"] {
            try Data("x".utf8).write(to: tree.appendingPathComponent(name))
        }
        let writer = try store.beginDraft()
        try writer.adopt(tree, suggestedName: "batch")
        _ = try writer.publish()

        let roots = inbox().collect()
        XCTAssertEqual(roots.map(\.lastPathComponent), ["batch"],
                       "one root, carrying the folder's own name")
        let contents = try FileManager.default
            .contentsOfDirectory(atPath: roots[0].path).sorted()
        XCTAssertEqual(contents, ["a.bin", "b.bin", "c.bin"],
                       "and every file, under the name the user gave it")
    }

    /// **The defect a screenshot would never show.** The store deliberately
    /// stages files under index names — `0`, `1`, `2` — with the real name held
    /// beside the URL, so a hostile name never reaches the filesystem. But the
    /// send path derives what the receiver sees from the URL, so handing those
    /// URLs straight over sends the user's files named `0`.
    func testTheHandedOverURLsCarryTheUsersNamesAndNotTheStoreSIndices() throws {
        try publish("holiday-photo.jpg")
        let roots = inbox().collect()
        XCTAssertEqual(roots.map(\.lastPathComponent), ["holiday-photo.jpg"])
        XCTAssertFalse(roots.contains { Int($0.lastPathComponent) != nil },
                       "an index name here is the bug this test exists for")
    }

    /// The names are links, not copies: the same bytes, not a second megabyte.
    func testNameRestorationLinksRatherThanCopies() throws {
        let plan = try publish("a.bin", contents: "payload")
        let roots = inbox().collect()
        let staged = try store.stagedFiles(for: plan)
        let linked = try FileManager.default.attributesOfItem(atPath: roots[0].path)
        let original = try FileManager.default.attributesOfItem(atPath: staged[0].url.path)
        XCTAssertEqual(linked[.systemFileNumber] as? Int,
                       original[.systemFileNumber] as? Int,
                       "the restored name must be a hard link to the staged bytes")
    }

    func testTwoDraftsAreBothHandedOverAndBothRecorded() throws {
        let one = try publish("a.bin")
        let two = try publish("b.bin")
        let files = inbox().collect()
        XCTAssertEqual(files.count, 2)
        XCTAssertEqual(Set(adoptedIds), Set([one.id, two.id]))
    }

    /// Forgetting the record is safe in exactly one direction: the draft is
    /// offered again, which shows the user their own files a second time. The
    /// opposite error would delete files they had never seen.
    func testALostRecordReOffersRatherThanDeletes() throws {
        try publish("a.bin")
        let files = inbox().collect()
        defaults.removeObject(forKey: SharedDraftInbox.defaultsKey)

        let again = inbox().collect()
        XCTAssertEqual(again.map(\.lastPathComponent), ["a.bin"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: files[0].path))
    }
}
