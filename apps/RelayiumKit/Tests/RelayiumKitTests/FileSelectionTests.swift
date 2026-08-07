import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The SEND side of folder transfer: what a picked or dropped tree becomes.
final class FileSelectionTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-sel-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    private func file(_ relative: String, _ bytes: [UInt8] = [1]) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(bytes).write(to: url)
        return url
    }

    private func dir(_ relative: String) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    // MARK: - hierarchy and order

    /// The top-level folder name has to survive, or the tree arrives shredded
    /// into the destination root. Matches the web (`walkEntry` keeps the dropped
    /// folder in `fullPath`) and the CLI (`filepath.Rel` from the root's PARENT).
    func testRecursesKeepingTheTopLevelFolderName() throws {
        try file("trip/day1/a.txt")
        try file("trip/day2/b.txt")
        try file("trip/readme.md")
        let selection = try expandSelection([try dir("trip")])
        XCTAssertEqual(selection.files.map(\.relativePath),
                       ["trip/day1/a.txt", "trip/day2/b.txt", "trip/readme.md"])
    }

    /// Deterministic, and by bytes rather than by locale: the same tree has to
    /// produce the same manifest on every machine, or the interop fixtures mean
    /// nothing.
    func testOrderIsDeterministicAndLocaleIndependent() throws {
        // Deliberately no case-only pair: the temp volume is case-insensitive,
        // so "A.txt" and "a.txt" would be one file and the test would be
        // asserting the filesystem's behaviour rather than the sort's.
        for name in ["b.txt", "Q.txt", "Z.txt", "10.txt", "2.txt", "é.txt"] {
            try file("mix/\(name)")
        }
        let first = try expandSelection([try dir("mix")]).files.map(\.relativePath)
        let second = try expandSelection([try dir("mix")]).files.map(\.relativePath)
        XCTAssertEqual(first, second)
        // UTF-8 order: uppercase before lowercase, "10" before "2" (byte order,
        // not numeric), non-ASCII last.
        XCTAssertEqual(first, ["mix/10.txt", "mix/2.txt", "mix/Q.txt", "mix/Z.txt",
                               "mix/b.txt", "mix/é.txt"])
    }

    /// The same tree, the same list, as the Go CLI produces.
    ///
    /// `filepath.WalkDir` sorts each directory's ENTRIES and descends where the
    /// subdirectory sorts, so `trip/b.txt` precedes `trip/day1/a.txt`. The walk
    /// here has to agree, or the same folder sent from a Mac and from the CLI
    /// produces two different manifests. Pinned against
    /// `server/internal/cloud/transfer_folder_interop_test.go`'s
    /// `TestWalkUploadPathsNamesMatchNativeConvention`, which asserts this exact
    /// list for this exact tree.
    func testWalkOrderMatchesTheGoCLIConvention() throws {
        try file("trip/day1/a.txt")
        try file("trip/b.txt")
        let loose = try file("loose.txt")
        let selection = try expandSelection([try dir("trip"), loose])
        XCTAssertEqual(selection.files.map(\.relativePath),
                       ["trip/b.txt", "trip/day1/a.txt", "loose.txt"])
    }

    /// Mixed roots: a loose file beside a folder, in the order they were given.
    func testMixedFilesAndFoldersKeepSelectionOrder() throws {
        let loose = try file("loose.txt")
        try file("folder/inner.txt")
        let selection = try expandSelection([loose, try dir("folder")])
        XCTAssertEqual(selection.files.map(\.relativePath), ["loose.txt", "folder/inner.txt"])
        XCTAssertEqual(selection.files.map(\.isNested), [false, true])
        XCTAssertEqual(selection.files.map(\.name), ["loose.txt", "inner.txt"])
    }

    /// A folder holding exactly one file is still a folder.
    func testSingleFileFolderStaysNested() throws {
        try file("solo/only.txt")
        let selection = try expandSelection([try dir("solo")])
        XCTAssertEqual(selection.files.map(\.relativePath), ["solo/only.txt"])
        XCTAssertTrue(selection.files[0].isNested)
    }

    /// The same folder dropped twice is one folder, not a guaranteed
    /// duplicate-path refusal on the receiving side.
    func testDuplicateRootsAreCollapsed() throws {
        try file("dup/a.txt")
        let d = try dir("dup")
        let selection = try expandSelection([d, d, d])
        XCTAssertEqual(selection.files.map(\.relativePath), ["dup/a.txt"])
    }

    /// Zero-byte files are real files and must be listed — a receiver that never
    /// hears about them writes a tree that is missing them.
    func testZeroByteFilesAreIncluded() throws {
        try file("z/empty.bin", [])
        try file("z/one.bin", [7])
        let selection = try expandSelection([try dir("z")])
        XCTAssertEqual(selection.files.map(\.relativePath), ["z/empty.bin", "z/one.bin"])
        XCTAssertEqual(selection.files.map(\.byteCount), [0, 1],
                       "the sender must be able to distinguish an empty file from an unknown size")
    }

    /// Size is captured in the same filesystem read that classifies the item,
    /// so the UI does not reopen every file merely to describe the selection.
    func testSelectionCapturesExactByteCountsForLooseAndNestedFiles() throws {
        let loose = try file("loose.bin", Array(repeating: 1, count: 2_048))
        try file("trip/a.bin", Array(repeating: 2, count: 3))
        let selection = try expandSelection([loose, try dir("trip")])
        XCTAssertEqual(selection.files.map(\.byteCount), [2_048, 3])
    }

    // MARK: - what cannot be sent

    /// Neither wire format can describe a directory, so an empty one cannot be
    /// sent. It is reported rather than dropped in silence.
    func testEmptyDirectoriesAreReportedNotSilentlyDropped() throws {
        try file("tree/full/a.txt")
        try dir("tree/hollow")
        try dir("tree/hollow-too/deeper")
        let selection = try expandSelection([try dir("tree")])
        XCTAssertEqual(selection.files.map(\.relativePath), ["tree/full/a.txt"])
        XCTAssertEqual(selection.emptyDirectories,
                       ["tree/hollow", "tree/hollow-too/deeper", "tree/hollow-too"])
    }

    /// Selecting nothing but an empty folder is its own answer, not "choose
    /// between 1 and 1000 files".
    func testAnEntirelyEmptySelectionFailsWithItsOwnReason() throws {
        try dir("nothing")
        XCTAssertThrowsError(try expandSelection([try dir("nothing")])) { err in
            XCTAssertEqual(err as? FileSelectionError, .noFiles)
        }
        XCTAssertThrowsError(try expandSelection([])) { err in
            XCTAssertEqual(err as? FileSelectionError, .noFiles)
        }
    }

    /// A symlink is refused by name — not followed (which could send files from
    /// outside the selection) and not skipped (which would send a tree that is
    /// quietly missing something).
    func testSymlinkedFileInsideAFolderIsRefusedByName() throws {
        try file("linked/real.txt")
        let outside = try file("secret.txt", [9, 9, 9])
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("linked/leak.txt"), withDestinationURL: outside)
        XCTAssertThrowsError(try expandSelection([try dir("linked")])) { err in
            XCTAssertEqual(err as? FileSelectionError, .symbolicLink("linked/leak.txt"))
        }
    }

    func testSymlinkedDirectoryIsRefusedRatherThanFollowed() throws {
        try file("elsewhere/hidden.txt")
        try dir("box")
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("box/out"),
            withDestinationURL: root.appendingPathComponent("elsewhere"))
        XCTAssertThrowsError(try expandSelection([try dir("box")])) { err in
            XCTAssertEqual(err as? FileSelectionError, .symbolicLink("box/out"))
        }
    }

    /// A symlink chosen as the root is refused by the same rule, so there is one
    /// answer rather than two.
    func testSymlinkedRootIsRefused() throws {
        try file("target/a.txt")
        let link = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(
            at: link, withDestinationURL: root.appendingPathComponent("target"))
        XCTAssertThrowsError(try expandSelection([link])) { err in
            XCTAssertEqual(err as? FileSelectionError, .symbolicLink("alias"))
        }
    }

    /// MAX_FILES has to bite during the walk, before a connection is opened —
    /// and before the whole tree has been enumerated.
    func testMaxFilesIsEnforcedDuringTheWalk() throws {
        for i in 0..<(MAX_FILES + 5) {
            try file(String(format: "many/f%05d.bin", i), [])
        }
        XCTAssertThrowsError(try expandSelection([try dir("many")])) { err in
            XCTAssertEqual(err as? FileSelectionError, .tooManyFiles)
        }
    }

    /// Exactly MAX_FILES is fine — the bound is inclusive, as the manifest
    /// validator's is.
    func testExactlyMaxFilesIsAccepted() throws {
        for i in 0..<MAX_FILES {
            try file(String(format: "edge/f%05d.bin", i), [])
        }
        XCTAssertEqual(try expandSelection([try dir("edge")]).files.count, MAX_FILES)
    }

    /// The path byte bound, checked directly.
    ///
    /// Not driven through a real tree on purpose: Darwin caps a path at
    /// `PATH_MAX` (1024) and a component at 255 bytes, so a relative path over
    /// `MANIFEST_MAX_NAME_BYTES` cannot be created under a temp directory at
    /// all — only under a very short root. The bound still has to be the one the
    /// wire applies, which is what this pins.
    func testPathByteBoundMatchesTheManifestValidator() {
        let ok = String(repeating: "d/", count: 511) + "xx"      // exactly 1024 bytes
        XCTAssertEqual(ok.utf8.count, MANIFEST_MAX_NAME_BYTES)
        XCTAssertNoThrow(try checkSelectionBounds(relativePath: ok, countSoFar: 0))
        XCTAssertThrowsError(try checkSelectionBounds(relativePath: ok + "y", countSoFar: 0)) { err in
            XCTAssertEqual(err as? FileSelectionError, .pathTooLong(ok + "y"))
        }
        // And the count bound is inclusive on the same call.
        XCTAssertNoThrow(try checkSelectionBounds(relativePath: "a", countSoFar: MAX_FILES - 1))
        XCTAssertThrowsError(try checkSelectionBounds(relativePath: "a", countSoFar: MAX_FILES)) { err in
            XCTAssertEqual(err as? FileSelectionError, .tooManyFiles)
        }
    }

    /// A deep but legal tree is accepted, so the bound above is not a blanket
    /// refusal of nesting.
    func testDeepButLegalTreeIsAccepted() throws {
        let deep = String(repeating: "d/", count: 100) + "leaf.txt"
        try file("long/\(deep)")
        let selection = try expandSelection([try dir("long")])
        XCTAssertEqual(selection.files.count, 1)
        XCTAssertEqual(selection.files[0].name, "leaf.txt")
        XCTAssertTrue(selection.files[0].relativePath.hasPrefix("long/d/d/"))
    }

    func testMissingRootIsUnreadableRatherThanEmpty() {
        XCTAssertThrowsError(try expandSelection([root.appendingPathComponent("ghost")])) { err in
            XCTAssertEqual(err as? FileSelectionError, .unreadable("ghost"))
        }
    }

    // MARK: - staging

    /// The realtime manifest carries the leaf in `name` and the folder-relative
    /// path in `path`, with `path` ABSENT for a file picked on its own. That is
    /// the web's exact shape (`{ name: file.name, size, path }` where `walkEntry`
    /// sets `path` only when it nests), and it is what makes native folder sends
    /// land correctly in a browser.
    func testRealtimeStagingPopulatesPathOnlyForNestedFiles() throws {
        let loose = try file("flat.txt", [1, 2, 3])
        try file("pics/sub/deep.jpg", [4, 5])
        let staged = try stageRealtimeFiles(expandSelection([loose, try dir("pics")]).files)
        XCTAssertEqual(staged.metas, [
            FileMeta(name: "flat.txt", size: 3, path: nil),
            FileMeta(name: "deep.jpg", size: 2, path: "pics/sub/deep.jpg"),
        ])
        XCTAssertEqual(staged.sources.map(\.name), ["flat.txt", "deep.jpg"])
    }

    /// The stored manifest is frozen and has no `path`, so hierarchy rides in
    /// `name` — the Go CLI's convention (`walkUploadPaths`), which its own
    /// download side reads back with `safeJoin`.
    func testCloudStagingPutsTheRelativePathInTheManifestName() throws {
        try file("docs/2026/report.pdf", [1, 2, 3, 4])
        let sources = try stageCloudFiles(expandSelection([try dir("docs")]).files)
        XCTAssertEqual(sources.map(\.name), ["docs/2026/report.pdf"])
        XCTAssertEqual(sources.map(\.size), [4])
    }

    /// A manifest too big for one BATCH frame must be refused at staging time,
    /// not after signalling, the handshake and a dialled peer.
    func testStagingRefusesAnOversizedManifestBeforeAnyConnection() throws {
        let name = String(repeating: "n", count: 200)
        for i in 0..<MAX_FILES {
            try file("huge/\(String(format: "%04d", i))-\(name).bin", [])
        }
        let selection = try expandSelection([try dir("huge")])
        XCTAssertThrowsError(try stageRealtimeFiles(selection.files)) { err in
            XCTAssertEqual(err as? RealtimeSenderError, .manifestTooLarge)
        }
    }

    /// A file removed between selection and send fails staging as a whole rather
    /// than sending a short batch.
    ///
    /// It now fails with the file NAMED. That changed when staging began pinning
    /// descriptors: `FileURLSource` knows which file it could not open, and
    /// passing that through beats the old blanket "couldn't open every selected
    /// file", which left the user to work out which one. `RealtimeStagingError`
    /// is still what a non-source failure produces.
    func testStagingFailsWhenAFileVanishedAfterSelection() throws {
        let a = try file("gone/a.txt")
        try file("gone/b.txt")
        let selection = try expandSelection([try dir("gone")])
        try FileManager.default.removeItem(at: a)
        XCTAssertThrowsError(try stageRealtimeFiles(selection.files)) { err in
            XCTAssertEqual(err as? PlaintextSourceError, .unreadable(name: "a.txt"))
            XCTAssertTrue(ErrorCopy.message(for: err, language: .en).contains("a.txt"))
        }
    }
}
