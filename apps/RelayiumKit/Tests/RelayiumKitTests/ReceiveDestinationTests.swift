import XCTest
@testable import RelayiumAppKit

/// The app-owned folder iOS receives into.
///
/// Driven through `directory(inDocuments:)` rather than `directory()` so these
/// run under `swift test` on macOS: the rule under test is what happens at the
/// name, not which container the OS assigned. `documentsDirectory` is the one
/// line that cannot be exercised here, and it is a single `FileManager` lookup
/// with nothing to get wrong except hard-coding a path, which is precisely what
/// it exists to avoid.
final class ReceiveDestinationTests: XCTestCase {
    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("r3a-dest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testCreatesTheFolderOnDemandInsideDocuments() throws {
        let documents = try tempDir()
        let url = try ReceiveDestination.directory(inDocuments: documents)

        XCTAssertEqual(url.lastPathComponent, ReceiveDestination.folderName)
        XCTAssertEqual(url.deletingLastPathComponent().standardized.path,
                       documents.standardized.path,
                       "the receive folder must be inside the documents directory it was given")
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
    }

    /// The normal case from the second download onwards. It must return the same
    /// directory and must not disturb what is already in it — this runs before
    /// every single receive, so a destructive answer here would be a data-loss
    /// bug reached by ordinary use rather than by an attack.
    func testIsIdempotentAndKeepsWhatIsAlreadyThere() throws {
        let documents = try tempDir()
        let first = try ReceiveDestination.directory(inDocuments: documents)
        let existing = first.appendingPathComponent("earlier.txt")
        try Data("earlier".utf8).write(to: existing)

        let second = try ReceiveDestination.directory(inDocuments: documents)

        XCTAssertEqual(second.standardized.path, first.standardized.path)
        XCTAssertEqual(try String(contentsOf: existing), "earlier")
    }

    /// A FILE sitting where the folder belongs is refused, not replaced.
    /// Whatever is there is the user's — this is not the code that gets to
    /// decide it is disposable.
    func testRefusesAFileOccupyingTheFolderName() throws {
        let documents = try tempDir()
        let blocker = documents.appendingPathComponent(ReceiveDestination.folderName)
        try Data("mine".utf8).write(to: blocker)

        XCTAssertThrowsError(try ReceiveDestination.directory(inDocuments: documents)) { error in
            XCTAssertEqual(error as? DownloadDestinationError,
                           .fileExists(name: ReceiveDestination.folderName))
        }
        XCTAssertEqual(try String(contentsOf: blocker), "mine",
                       "the refusal must leave the existing item exactly as it was")
    }

    /// The folder name is a stable on-disk identity, not copy. If it ever became
    /// a localized string, every earlier download would be stranded under a name
    /// nothing looks for the next time the user changes language.
    func testTheFolderNameIsASingleStablePathComponent() {
        let name = ReceiveDestination.folderName
        XCTAssertFalse(name.isEmpty)
        XCTAssertFalse(name.contains("/"))
        XCTAssertEqual(try? safePathSegments(name), [name])
    }
}
