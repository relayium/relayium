import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Turning a sender-controlled manifest into local paths.
///
/// AEAD proves who BUILT a manifest. It does not make the names inside it safe: a
/// name is an instruction to this filesystem, and the sender is another machine.
/// Everything here treats a manifest name as hostile input, and every refusal is
/// a refusal rather than a repair — a repaired name delivers a file under a name
/// nobody chose, unattended.
final class InboxDestinationPlanTests: XCTestCase {

    private func temporaryDirectory() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-plan-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func plan(_ names: [String], root: URL,
                      exists: @escaping (String) -> Bool = { _ in false })
        throws -> [InboxPlanEntry] {
        try InboxDestinationPlan.plan(root: root,
                                      files: names.map { InboxManifestItem(kind: .file, name:$0, size: 1) },
                                      exists: exists)
    }

    // MARK: - refusals

    /// Each of these is a different way for a name to leave, rename or
    /// misrepresent the destination. `checkedRelativePath` is the single gate they
    /// all pass through, so the list is the whole policy.
    func testEveryUnsafeNameShapeIsRefused() {
        let refused: [String] = [
            "",                                   // nothing to create
            "/etc/passwd",                        // absolute
            "../escape",                          // traversal
            "a/../../escape",                     // traversal, mid-path
            "a/./b",                              // a second spelling of one path
            "a//b",                               // an empty component
            "a/",                                 // a trailing separator
            "back\\slash",                        // a Windows separator on a POSIX name
            "C:/drive",                           // drive-absolute
            "C:relative",                         // drive-relative
            "trailing.",                          // Windows strips the dot
            "trailing ",                          // Windows strips the space
            "CON", "con.txt", "LPT1", "nul.log",  // Windows device names
            "with\u{0}nul",                       // truncates a C string
            "with\u{7}bell",                      // rewrites a terminal line
            "with\u{7F}delete",
            "with\u{202E}override",               // reads one way, lands another
            String(repeating: "a", count: MANIFEST_MAX_NAME_BYTES + 1),
            Array(repeating: "d", count: 40).joined(separator: "/") + "/f",   // too deep
        ]
        for name in refused {
            XCTAssertNil(InboxDestinationPlan.checkedRelativePath(name),
                         "accepted \(name.debugDescription)")
        }
    }

    func testOrdinaryNamesAndNestedPathsAreAccepted() {
        for name in ["a.txt", "photos/2026/a.jpg", ".bashrc", "backup.tar.gz",
                     "naïve — file (1).pdf", "文件.txt", "a\u{200D}b.txt"] {
            XCTAssertEqual(InboxDestinationPlan.checkedRelativePath(name), name, name)
        }
    }

    func testARefusedNameNamesItsManifestIndex() throws {
        let root = try temporaryDirectory()
        XCTAssertThrowsError(try plan(["fine.txt", "../escape"], root: root)) {
            XCTAssertEqual($0 as? InboxPlanError, .unsafeName(index: 1))
        }
    }

    /// A delivery into the staging area would land ON its own staged source, so
    /// the commit would link the file to itself and then unlink it — reporting
    /// `saved` with nothing on disk. A delivery named as the probe would be
    /// DELETED by the next writability probe.
    func testAManifestCannotNameThisComponentsOwnWorkingEntries() throws {
        let root = try temporaryDirectory()
        for name in [InboxDestinationPlan.stagingDirectoryName,
                     InboxDestinationPlan.stagingDirectoryName + "/task/0.part",
                     InboxReceiveFolder.probeName] {
            XCTAssertThrowsError(try plan([name], root: root), name) {
                XCTAssertEqual($0 as? InboxPlanError, .unsafeName(index: 0))
            }
        }
    }

    /// A case-insensitive volume (APFS, HFS+) collapses these into one file. A
    /// REFUSAL rather than a rename: two entries differing only by case are the
    /// sender describing two files, and quietly renaming one would hide that this
    /// receiver cannot represent what was sent.
    func testTwoEntriesDifferingOnlyByCaseAreRefused() throws {
        let root = try temporaryDirectory()
        XCTAssertThrowsError(try plan(["Report.txt", "report.txt"], root: root)) {
            XCTAssertEqual($0 as? InboxPlanError, .duplicateDestination(index: 1))
        }
    }

    func testTwoIdenticalEntriesAreRefused() throws {
        let root = try temporaryDirectory()
        XCTAssertThrowsError(try plan(["a.txt", "a.txt"], root: root)) {
            XCTAssertEqual($0 as? InboxPlanError, .duplicateDestination(index: 1))
        }
    }

    // MARK: - collisions

    /// The deterministic safe rename (PRD §9), with the extension preserved:
    /// `report (2).pdf` with the extension moved or dropped stops opening in the
    /// right application, and a user cannot tell what the file is.
    func testACollisionTakesTheDeterministicSuffixAndKeepsTheExtension() throws {
        let root = try temporaryDirectory()
        let taken = Set([root.path + "/report.pdf", root.path + "/report (2).pdf"])
        let entries = try plan(["report.pdf"], root: root) { taken.contains($0) }
        XCTAssertEqual(entries.map(\.destination), [root.path + "/report (3).pdf"])
    }

    func testTheSuffixHandlesDotfilesAndCompoundExtensions() {
        XCTAssertEqual(InboxDestinationPlan.collisionName("notes", 2), "notes (2)")
        XCTAssertEqual(InboxDestinationPlan.collisionName(".bashrc", 2), ".bashrc (2)")
        XCTAssertEqual(InboxDestinationPlan.collisionName("backup.tar.gz", 2), "backup (2).tar.gz")
        XCTAssertEqual(InboxDestinationPlan.collisionName("a.b.c", 3), "a.b (3).c")
        XCTAssertEqual(InboxDestinationPlan.collisionName("trailing.", 2), "trailing. (2)")
    }

    /// ANYTHING at a name occupies it — a file, a directory, a socket, a device
    /// node, or a dangling symlink. `lstat` rather than an existence test is the
    /// point: a symlink pointing at somebody's `~/.ssh/authorized_keys` is
    /// emphatically not a free name.
    func testADanglingSymlinkOccupiesItsName() throws {
        let root = try temporaryDirectory()
        let link = root.appendingPathComponent("a.txt")
        try FileManager.default.createSymbolicLink(
            at: link, withDestinationURL: root.appendingPathComponent("nowhere"))
        XCTAssertTrue(InboxDestinationPlan.pathExists(link.path))

        // The REAL filesystem predicate, not the stub the other tests use: this
        // is the one assertion about what `pathExists` itself considers occupied.
        let entries = try plan(["a.txt"], root: root, exists: InboxDestinationPlan.pathExists)
        XCTAssertEqual(entries.map(\.destination), [root.path + "/a (2).txt"])
    }

    /// Determinism is what lets a resumed task compare its journalled plan against
    /// reality instead of guessing: the same manifest against the same directory
    /// must always produce the same plan.
    func testThePlanIsDeterministicForTheSameManifestAndDirectory() throws {
        let root = try temporaryDirectory()
        let taken = Set([root.path + "/a.txt"])
        let names = ["a.txt", "a.txt".uppercased(), "b/c.txt"]
        let first = try InboxDestinationPlan.plan(
            root: root, files: [InboxManifestItem(kind: .file, name:"a.txt", size: 1),
                                InboxManifestItem(kind: .file, name:"b/c.txt", size: 2)],
            exists: { taken.contains($0) })
        let second = try InboxDestinationPlan.plan(
            root: root, files: [InboxManifestItem(kind: .file, name:"a.txt", size: 1),
                                InboxManifestItem(kind: .file, name:"b/c.txt", size: 2)],
            exists: { taken.contains($0) })
        XCTAssertEqual(first, second)
        _ = names
    }

    /// Two manifest entries cannot be given one destination even when the
    /// directory is empty: the first takes the name, and the second steps aside.
    func testTwoEntriesThatWouldCollideAfterSuffixingStillGetDistinctPaths() throws {
        let root = try temporaryDirectory()
        let taken = Set([root.path + "/a.txt"])
        let entries = try InboxDestinationPlan.plan(
            root: root,
            files: [InboxManifestItem(kind: .file, name:"a.txt", size: 1), InboxManifestItem(kind: .file, name:"a (2).txt", size: 1)],
            exists: { taken.contains($0) })
        XCTAssertEqual(Set(entries.map(\.destination)).count, 2)
        XCTAssertEqual(entries[0].destination, root.path + "/a (2).txt")
        XCTAssertEqual(entries[1].destination, root.path + "/a (2) (2).txt")
    }

    /// Reaching the bound means the folder genuinely holds thousands of same-named
    /// files, which is a human problem — not something to keep scanning for.
    func testAnExhaustedCollisionSearchIsAnHonestRefusal() throws {
        let root = try temporaryDirectory()
        XCTAssertThrowsError(try plan(["a.txt"], root: root, exists: { _ in true })) {
            XCTAssertEqual($0 as? InboxPlanError, .noFreeName(index: 0))
        }
    }

    // MARK: - shape of the plan

    func testThePlanCarriesTheManifestIndexNameAndSize() throws {
        let root = try temporaryDirectory()
        let entries = try InboxDestinationPlan.plan(
            root: root,
            files: [InboxManifestItem(kind: .file, name:"a.txt", size: 3), InboxManifestItem(kind: .file, name:"d/b.bin", size: 0)])
        XCTAssertEqual(entries.map(\.index), [0, 1])
        XCTAssertEqual(entries.map(\.name), ["a.txt", "d/b.bin"])
        XCTAssertEqual(entries.map(\.size), [3, 0])
        XCTAssertEqual(entries.map(\.destination),
                       [root.path + "/a.txt", root.path + "/d/b.bin"])
    }

    /// Belt and braces over the component checks: every destination must still be
    /// under the root. Cheap, and it catches any future regression in the name
    /// rules before it reaches the filesystem.
    func testEveryPlannedDestinationIsUnderTheRoot() throws {
        let root = try temporaryDirectory()
        let entries = try plan(["a.txt", "x/y/z.txt"], root: root)
        for entry in entries {
            XCTAssertTrue(entry.destination.hasPrefix(root.standardizedFileURL.path + "/"))
        }
    }
}
