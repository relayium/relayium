import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The staging decisions the three send panes delegate rather than each having
/// their own copy of.
@MainActor
final class SelectionStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    private func file(_ relative: String) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data([1]).write(to: url)
        return url
    }

    private func dir(_ relative: String) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A picker REPLACES: the panel showed the user exactly what was highlighted
    /// when they pressed Choose.
    func testPickerReplacesTheSelection() throws {
        let store = SelectionStore()
        store.replace(with: [try file("a.txt")])
        store.replace(with: [try file("b.txt")])
        XCTAssertEqual(store.selection?.files.map(\.relativePath), ["b.txt"])
    }

    /// A drop APPENDS: there is no moment of confirmation for a drag, and
    /// silently discarding a folder dropped ten seconds earlier is how work is
    /// lost with nothing on screen to notice.
    func testDropAppendsAndDeDuplicates() throws {
        let store = SelectionStore()
        let a = try file("a.txt")
        store.add([a])
        store.add([try file("folder/b.txt").deletingLastPathComponent()])
        XCTAssertEqual(store.selection?.files.map(\.relativePath), ["a.txt", "folder/b.txt"])
        store.add([a])                       // the same root again
        XCTAssertEqual(store.selection?.files.map(\.relativePath), ["a.txt", "folder/b.txt"])
        XCTAssertEqual(store.roots.count, 2)
    }

    func testClearEmptiesEverything() throws {
        let store = SelectionStore()
        store.add([try file("a.txt")])
        store.clear()
        XCTAssertTrue(store.isEmpty)
        XCTAssertNil(store.selection)
        XCTAssertTrue(store.roots.isEmpty)
    }

    /// The summary is the only place a user is told that an empty folder cannot
    /// be sent — before they send, not by noticing it missing afterwards.
    func testSummaryCountsFilesFoldersAndUnsendableEmptyOnes() throws {
        let store = SelectionStore()
        try file("trip/a.txt")
        try file("trip/sub/b.txt")
        try dir("trip/hollow")
        store.replace(with: [try dir("trip"), try file("loose.txt")])
        // English named explicitly: the summary is three pluralized fragments
        // now, and which words they are depends on the language, not on the
        // machine running the test.
        let summary = try XCTUnwrap(store.summaryText(language: .en))
        XCTAssertTrue(summary.contains("3 files"), summary)
        XCTAssertTrue(summary.contains("1 folder"), summary)
        XCTAssertTrue(summary.contains("empty folder"), summary)
    }

    func testNoSummaryWhenNothingIsSelected() {
        XCTAssertNil(SelectionStore().summaryText(language: .en))
        XCTAssertTrue(SelectionStore().isEmpty)
    }

    /// A refused selection keeps its roots, so the user can see what they chose
    /// and remove the offending item instead of starting over. The message is
    /// already user-facing copy, not an error description.
    func testAFailedExpansionKeepsTheRootsAndExplains() throws {
        let store = SelectionStore()
        try file("box/real.txt")
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("box/link.txt"),
            withDestinationURL: root.appendingPathComponent("box/real.txt"))
        store.replace(with: [try dir("box")])
        XCTAssertNil(store.selection)
        XCTAssertTrue(store.isEmpty)
        XCTAssertEqual(store.roots.count, 1)
        let message = try XCTUnwrap(store.error)
        XCTAssertTrue(message.contains("symbolic link"), message)
        XCTAssertTrue(message.contains("box/link.txt"), message)
    }

    /// Views watch `revision` rather than the file count: two different
    /// selections can hold the same number of files, and a view that compared
    /// counts would miss the change entirely.
    func testRevisionAdvancesOnEveryChangeIncludingEqualCounts() throws {
        let store = SelectionStore()
        let start = store.revision
        store.replace(with: [try file("a.txt")])
        let afterFirst = store.revision
        XCTAssertGreaterThan(afterFirst, start)
        store.replace(with: [try file("b.txt")])          // same count, different file
        XCTAssertGreaterThan(store.revision, afterFirst)
        let beforeClear = store.revision
        store.clear()
        XCTAssertGreaterThan(store.revision, beforeClear)
    }

    /// An empty drop is a no-op, not a clear: a drag that carried nothing usable
    /// must not throw away a staged selection.
    func testAnEmptyDropChangesNothing() throws {
        let store = SelectionStore()
        store.replace(with: [try file("a.txt")])
        let before = store.revision
        store.add([])
        XCTAssertEqual(store.revision, before)
        XCTAssertEqual(store.selection?.files.count, 1)
    }

    // MARK: - decoding what a drag actually hands over

    /// `public.file-url` is vended as several different representations
    /// depending on the source app and OS version. Accepting only `Data` — as
    /// the drop zone used to — meant a drag from an app that vends `NSURL` did
    /// nothing at all, silently.
    func testEveryFileURLRepresentationDecodes() throws {
        let url = try file("dropped.txt")
        let expected = url.standardizedFileURL

        XCTAssertEqual(droppedFileURL(from: url), expected, "URL")
        XCTAssertEqual(droppedFileURL(from: url as NSURL), expected, "NSURL")
        XCTAssertEqual(droppedFileURL(from: url.dataRepresentation), expected, "Data")
        XCTAssertEqual(droppedFileURL(from: url.dataRepresentation as NSData), expected, "NSData")
        XCTAssertEqual(droppedFileURL(from: url.absoluteString), expected, "String")
        XCTAssertEqual(droppedFileURL(from: url.absoluteString as NSString), expected, "NSString")
    }

    /// A folder drags as a file URL too — the whole point of folder support —
    /// and every representation of it has to decode to the SAME value. `NSURL`
    /// vends a directory with a trailing slash and `Data` without one; this is
    /// a de-duplication key, so two spellings of one folder must not both stage.
    func testADirectoryURLDecodesIdenticallyFromEveryRepresentation() throws {
        let d = try dir("folder")
        let fromData = droppedFileURL(from: d.dataRepresentation)
        let fromNSURL = droppedFileURL(from: d as NSURL)
        let fromString = droppedFileURL(from: (d as NSURL).absoluteString!)
        XCTAssertEqual(fromData, fromNSURL)
        XCTAssertEqual(fromData, fromString)
        XCTAssertEqual(fromData?.lastPathComponent, "folder")

        let store = SelectionStore()
        store.add([fromData!, fromNSURL!, fromString!])
        XCTAssertEqual(store.roots.count, 1, "one folder, three spellings, one root")
    }

    /// Dragging a link out of a browser must not become a file send, and
    /// nothing unrecognisable may be guessed at.
    func testNonFileAndUnusableItemsAreRejected() {
        XCTAssertNil(droppedFileURL(from: URL(string: "https://relayium.com/d/x")!))
        XCTAssertNil(droppedFileURL(from: "https://relayium.com"))
        XCTAssertNil(droppedFileURL(from: Data([0xff, 0xfe, 0x00])))
        XCTAssertNil(droppedFileURL(from: Data()))
        XCTAssertNil(droppedFileURL(from: nil))
        XCTAssertNil(droppedFileURL(from: 42))
        XCTAssertNil(droppedFileURL(from: ""))
        // A bare POSIX path is not a URL, and `public.file-url` never promises
        // one — guessing that a loose string is a path would accept input no
        // drop source actually vended.
        XCTAssertNil(droppedFileURL(from: "/etc/passwd"))
    }
}
