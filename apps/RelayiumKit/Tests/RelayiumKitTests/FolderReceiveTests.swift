import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The RECEIVE side of folder transfer. Every path here arrives from the other
/// device and is treated as hostile.
final class FolderReceiveTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-recv-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func relative(_ url: URL, to base: URL) -> String {
        String(url.standardized.path.dropFirst(base.standardized.path.count + 1))
    }

    private func exists(_ path: String, in base: URL? = nil) -> Bool {
        FileManager.default.fileExists(atPath: (base ?? dir).appendingPathComponent(path).path)
    }

    // MARK: - the happy shape

    /// The realtime side carries hierarchy in `path`; the stored side carries it
    /// in `name`. Both must land the same way — that is the whole reason
    /// `resolveEntries` reads `path ?? name`.
    func testBothConventionsProduceTheSameTree() throws {
        let byPath = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a.txt", size: 1, path: "trip/day1/a.txt"),
        ])
        try byPath.write([1])
        let fromPath = try byPath.finish()

        let other = dir.appendingPathComponent("second")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let byName = try ManifestWriter(directory: other, files: [
            WritableFile(name: "trip/day1/a.txt", size: 1),
        ])
        try byName.write([1])
        let fromName = try byName.finish()

        XCTAssertEqual(relative(fromPath[0], to: dir), "trip/day1/a.txt")
        XCTAssertEqual(relative(fromName[0], to: other), "trip/day1/a.txt")
    }

    /// Chunks carry no file boundaries, and that does not change because the
    /// files are now in different directories.
    func testChunksStillSplitByManifestSizeAcrossDirectories() throws {
        let w = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 3, path: "t/one/a"),
            WritableFile(name: "b", size: 2, path: "t/two/b"),
        ])
        try w.write([1, 2, 3, 4])
        try w.write([5])
        let urls = try w.finish()
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([4, 5]))
    }

    /// A zero-byte file inside a folder still has to appear, and its directory
    /// has to be created for it.
    func testZeroByteFileInsideAFolderIsCreated() throws {
        let w = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "empty", size: 0, path: "t/sub/empty"),
            WritableFile(name: "x", size: 1, path: "t/x"),
        ])
        try w.write([9])
        let urls = try w.finish()
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data())
        XCTAssertTrue(exists("t/sub/empty"))
    }

    // MARK: - hostile paths

    func testRefusesAbsoluteAndTraversingPaths() {
        for hostile in ["/etc/passwd", "../escape.txt", "a/../../escape.txt",
                        "./a.txt", "a/./b.txt", "a//b.txt", "trip/", "..", "."] {
            XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
                WritableFile(name: "x", size: 1, path: hostile),
            ]), "accepted \(hostile)") { err in
                XCTAssertEqual(err as? ManifestPathError, .unsafePath(hostile))
            }
        }
        // Nothing was created on the way to any of those refusals.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
    }

    /// A backslash is an ordinary filename character on Darwin, so it neither
    /// nests nor traverses: it produces ONE inert file inside the destination.
    /// Splitting it would corrupt the legitimate POSIX name `a\b.txt`.
    func testBackslashIsAFilenameCharacterNotASeparator() throws {
        let w = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "odd", size: 1, path: #"..\..\escape.txt"#),
        ])
        try w.write([1])
        let urls = try w.finish()
        XCTAssertEqual(urls[0].deletingLastPathComponent().standardized.path,
                       dir.standardized.path)
        XCTAssertEqual(urls[0].lastPathComponent, #"..\..\escape.txt"#)
    }

    /// Control and bidi characters are stripped PER SEGMENT, so a folder name
    /// cannot smuggle them either. `sanitizeFileMeta` does the same for display;
    /// this is the copy that decides what is written.
    func testStripsControlAndBidiCharactersPerSegment() throws {
        let w = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "b", size: 1, path: "d\u{202E}ir/fi\u{0007}le\u{200F}.txt"),
        ])
        try w.write([1])
        let urls = try w.finish()
        XCTAssertEqual(relative(urls[0], to: dir), "dir/file.txt")
    }

    /// A segment made entirely of stripped characters would collapse to nothing
    /// — or, worse, back onto a dot segment. Both are refusals, not repairs.
    func testRefusesSegmentsThatCollapseWhenSanitized() {
        for hostile in ["\u{202E}/a.txt", "a/\u{0007}/b.txt", ".\u{202E}./x"] {
            XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
                WritableFile(name: "x", size: 1, path: hostile),
            ]), "accepted \(hostile)")
        }
    }

    // MARK: - collisions

    /// APFS/HFS+ default volumes are case-insensitive and normalize Unicode, so
    /// two entries that differ only that way are ONE file on disk — the second
    /// would silently overwrite the first.
    func testRefusesCanonicalAndCaseInsensitiveDuplicates() {
        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 1, path: "t/A.txt"),
            WritableFile(name: "a", size: 1, path: "t/a.txt"),
        ])) { XCTAssertEqual($0 as? ManifestPathError, .duplicatePath("t/a.txt")) }

        // é as one scalar vs. e + combining acute.
        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: "e", size: 1, path: "t/e\u{0301}.txt"),
            WritableFile(name: "e", size: 1, path: "t/\u{00E9}.txt"),
        ]))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
    }

    /// `a` cannot be a file and the parent directory of `a/b` at the same time,
    /// in either order.
    func testRefusesFileVersusDirectoryPrefixCollisions() {
        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 1, path: "t/a"),
            WritableFile(name: "b", size: 1, path: "t/a/b"),
        ])) { XCTAssertEqual($0 as? ManifestPathError, .pathCollision("t/a/b")) }

        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: "b", size: 1, path: "t/a/b"),
            WritableFile(name: "a", size: 1, path: "t/a"),
        ])) { XCTAssertEqual($0 as? ManifestPathError, .pathCollision("t/a")) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
    }

    /// A file already at the destination is never overwritten, and the refusal
    /// happens before ANY file of the batch is created.
    func testRefusesAPreExistingTargetWithoutWritingAnything() throws {
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("t"),
                                                withIntermediateDirectories: true)
        let existing = dir.appendingPathComponent("t/b.txt")
        try Data("keep".utf8).write(to: existing)
        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 1, path: "t/a.txt"),
            WritableFile(name: "b", size: 1, path: "t/b.txt"),
        ]))
        XCTAssertEqual(try String(contentsOf: existing), "keep")
        XCTAssertFalse(exists("t/a.txt"), "the earlier entry must not have been created")
    }

    /// A DANGLING symlink does not "exist" by `fileExists`, so a preflight built
    /// on that test would create through it and write wherever it points.
    func testRefusesADanglingSymlinkAtTheLeaf() throws {
        let outside = dir.deletingLastPathComponent()
            .appendingPathComponent("g2-outside-\(UUID().uuidString).txt")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("t"),
                                                withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: dir.appendingPathComponent("t/a.txt"), withDestinationURL: outside)
        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 1, path: "t/a.txt"),
        ]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.path),
                       "a write escaped through the symlink")
    }

    /// The Zip-Slip variant a lexical check misses: an ANCESTOR directory that
    /// is a pre-planted symlink. `createDirectory(withIntermediateDirectories:)`
    /// would follow it happily.
    func testRefusesASymlinkedAncestorDirectory() throws {
        let outside = dir.deletingLastPathComponent()
            .appendingPathComponent("g2-outdir-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }
        try FileManager.default.createSymbolicLink(
            at: dir.appendingPathComponent("t"), withDestinationURL: outside)

        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 1, path: "t/sub/a.txt"),
        ]))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [],
                       "a directory or file was created outside the destination")
    }

    // MARK: - cleanup

    /// A failed transfer leaves nothing: not the partial file, not the
    /// directories that were created for it — and never the parent it was told
    /// to write into.
    func testDiscardRemovesPartialFilesAndTheDirectoriesItCreated() throws {
        let w = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 10, path: "t/deep/a.bin"),
        ])
        try w.write([1, 2, 3])
        w.discard()
        XCTAssertFalse(exists("t/deep/a.bin"))
        XCTAssertFalse(exists("t/deep"))
        XCTAssertFalse(exists("t"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path),
                      "the destination the user chose must survive")
    }

    /// Only directories this writer created are removed, and only while empty.
    func testDiscardLeavesADirectoryThatHeldSomethingElse() throws {
        let w = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 10, path: "t/a.bin"),
        ])
        try w.write([1])
        try Data("theirs".utf8).write(to: dir.appendingPathComponent("t/mine.txt"))
        w.discard()
        XCTAssertFalse(exists("t/a.bin"))
        XCTAssertTrue(exists("t/mine.txt"), "a directory that gained a file is not ours to delete")
    }

    /// Over-length and short streams stay all-or-nothing with nesting in play.
    func testRejectsExcessAndIncompleteNestedStreams() throws {
        let excess = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "a", size: 1, path: "t/a"),
        ])
        XCTAssertThrowsError(try excess.write([1, 2]))
        excess.discard()
        XCTAssertFalse(exists("t"))

        let short = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "b", size: 2, path: "t/b"),
        ])
        try short.write([1])
        XCTAssertThrowsError(try short.finish())
        short.discard()
        XCTAssertFalse(exists("t"))
    }

    /// The wire's own byte bound still applies to a path — a 1024-byte cap is
    /// not something a nested manifest gets to opt out of.
    func testRefusesAnOverlongManifestName() {
        let huge = String(repeating: "a", count: MANIFEST_MAX_NAME_BYTES + 1)
        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: huge, size: 1),
        ]))
    }

    // MARK: - the container

    /// A folder receive gets a directory NAMED AFTER the folder that was sent,
    /// and the root is lifted out of the entries so the tree does not gain a
    /// level.
    func testFolderReceiveCreatesAContainerNamedAfterTheSentFolder() throws {
        let opened = try openReceiveWriter(parent: dir, files: [
            WritableFile(name: "a.txt", size: 1, path: "trip/day1/a.txt"),
            WritableFile(name: "b.txt", size: 1, path: "trip/b.txt"),
        ], fallbackName: "relayium-x")
        try opened.writer.write([1, 2])
        let urls = try opened.writer.finish()
        XCTAssertEqual(opened.container?.lastPathComponent, "trip")
        XCTAssertEqual(urls.map { relative($0, to: dir) }, ["trip/day1/a.txt", "trip/b.txt"])
        XCTAssertFalse(exists("trip/trip"), "the container must not duplicate the root level")
    }

    /// A folder holding exactly one file keeps its folder.
    func testOneFileFolderStillGetsItsFolder() throws {
        let opened = try openReceiveWriter(parent: dir, files: [
            WritableFile(name: "only.txt", size: 1, path: "solo/only.txt"),
        ], fallbackName: "relayium-x")
        try opened.writer.write([1])
        let urls = try opened.writer.finish()
        XCTAssertEqual(relative(urls[0], to: dir), "solo/only.txt")
    }

    /// Receiving the same folder twice steps aside rather than merging into — or
    /// overwriting — the first one.
    func testASecondFolderOfTheSameNameStepsAside() throws {
        let files = [WritableFile(name: "a.txt", size: 1, path: "trip/a.txt")]
        let first = try openReceiveWriter(parent: dir, files: files, fallbackName: "x")
        try first.writer.write([1])
        _ = try first.writer.finish()

        let second = try openReceiveWriter(parent: dir, files: files, fallbackName: "x")
        try second.writer.write([2])
        let urls = try second.writer.finish()
        XCTAssertEqual(second.container?.lastPathComponent, "trip (2)")
        XCTAssertEqual(relative(urls[0], to: dir), "trip (2)/a.txt")
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("trip/a.txt")), Data([1]))
    }

    /// Two roots — or a folder beside a loose file — have no single name a
    /// container could take, so the opaque per-transfer one is used and the full
    /// paths are kept.
    func testMultiRootBatchUsesTheFallbackContainerAndKeepsFullPaths() throws {
        let opened = try openReceiveWriter(parent: dir, files: [
            WritableFile(name: "a.txt", size: 1, path: "one/a.txt"),
            WritableFile(name: "b.txt", size: 1, path: "two/b.txt"),
            WritableFile(name: "loose.txt", size: 1),
        ], fallbackName: "relayium-abc")
        try opened.writer.write([1, 2, 3])
        let urls = try opened.writer.finish()
        XCTAssertEqual(opened.container?.lastPathComponent, "relayium-abc")
        XCTAssertEqual(urls.map { relative($0, to: dir) },
                       ["relayium-abc/one/a.txt", "relayium-abc/two/b.txt",
                        "relayium-abc/loose.txt"])
    }

    /// A FLAT batch is unchanged: straight into the destination, no container.
    /// That is the behaviour every existing receive already had.
    func testFlatBatchStillLandsDirectlyInTheDestination() throws {
        let opened = try openReceiveWriter(parent: dir, files: [
            WritableFile(name: "a.txt", size: 1),
            WritableFile(name: "b.txt", size: 1),
        ], fallbackName: "relayium-x")
        try opened.writer.write([1, 2])
        let urls = try opened.writer.finish()
        XCTAssertNil(opened.container)
        XCTAssertEqual(urls.map { relative($0, to: dir) }, ["a.txt", "b.txt"])
    }

    /// A container created for a manifest that then turns out to be unusable
    /// must not survive as an empty folder named after a transfer that never
    /// happened.
    func testAContainerIsRemovedWhenTheManifestIsRefused() {
        XCTAssertThrowsError(try openReceiveWriter(parent: dir, files: [
            WritableFile(name: "a", size: 1, path: "trip/a.txt"),
            WritableFile(name: "a", size: 1, path: "trip/A.txt"),
        ], fallbackName: "relayium-x"))
        XCTAssertFalse(exists("trip"))
        XCTAssertFalse(exists("relayium-x"))
    }

    /// Discarding a folder receive removes the container it created — it owns it
    /// — while a flat receive never touches the directory it was handed.
    func testDiscardRemovesAnOwnedContainerButNeverTheChosenParent() throws {
        let owned = try openReceiveWriter(parent: dir, files: [
            WritableFile(name: "a", size: 5, path: "trip/a.bin"),
        ], fallbackName: "x")
        try owned.writer.write([1])
        owned.writer.discard()
        XCTAssertFalse(exists("trip"))

        let flat = try openReceiveWriter(parent: dir, files: [
            WritableFile(name: "a.bin", size: 5),
        ], fallbackName: "x")
        try flat.writer.write([1])
        flat.writer.discard()
        XCTAssertFalse(exists("a.bin"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))
    }

    // MARK: - the reveal/drag-out seam

    /// A foldered result is ONE drag item — the container. Dragging the
    /// individual files out would flatten the tree at the destination, losing
    /// the hierarchy at the last step.
    func testFolderedResultOffersTheContainerAsTheSingleDragItem() {
        let container = dir.appendingPathComponent("trip")
        let payload = receivedPayload(
            files: [container.appendingPathComponent("a"), container.appendingPathComponent("b/c")],
            container: container)
        XCTAssertEqual(payload.dragURLs, [container])
        XCTAssertEqual(payload.revealURLs, [container])
    }

    func testFlatResultOffersEachFile() {
        let a = dir.appendingPathComponent("a.txt")
        let b = dir.appendingPathComponent("b.txt")
        let payload = receivedPayload(files: [a, b], container: nil)
        XCTAssertEqual(payload.dragURLs, [a, b])
        XCTAssertEqual(payload.revealURLs, [a, b])
    }

    /// Nothing received means nothing to drag. A sender reaches `.completed`
    /// with no URLs of its own, and offering it a drag source would be offering
    /// files it never wrote.
    func testNoFilesMeansNoDragSourceEvenWithAContainer() {
        let payload = receivedPayload(files: [], container: dir)
        XCTAssertTrue(payload.isEmpty)
    }
}
