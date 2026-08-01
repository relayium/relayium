import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

@MainActor
final class CloudDownloadModelTests: XCTestCase {
    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-dl-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testParsesAFullLink() {
        let p = parseTransferLink("https://relayium.com/d/abc123#k=KEYPART")
        XCTAssertEqual(p, ParsedLink(id: "abc123", keyB64url: "KEYPART"))
    }

    /// Whitespace is what a paste actually looks like.
    func testParseTolerantOfSurroundingWhitespace() {
        XCTAssertEqual(parseTransferLink("  https://relayium.com/d/x#k=Y \n"),
                       ParsedLink(id: "x", keyB64url: "Y"))
    }

    /// Fail before any network call, and fail for each distinct reason.
    func testRejectsLinksThatCannotWork() {
        XCTAssertNil(parseTransferLink("https://relayium.com/d/abc"))        // no key
        XCTAssertNil(parseTransferLink("https://relayium.com/x/abc#k=K"))    // not a /d/ link
        XCTAssertNil(parseTransferLink("https://relayium.com/d/#k=K"))       // no id
        XCTAssertNil(parseTransferLink("not a url"))
        XCTAssertNil(parseTransferLink(""))
    }

    /// A self-hosted deployment is a different origin — the id and key are what
    /// matter, not the hostname.
    func testAcceptsAnyOrigin() {
        XCTAssertEqual(parseTransferLink("https://files.example.org/d/zz#k=QQ"),
                       ParsedLink(id: "zz", keyB64url: "QQ"))
    }

    /// Refusing to merge is the design; the refusal has to be detectable by the
    /// caller rather than by string matching.
    func testRefusesAnExistingDestinationDirectory() throws {
        let parent = try tempDir()
        let first = try destinationDirectory(parent: parent, id: "dup")
        XCTAssertEqual(first.lastPathComponent, "relayium-dup")
        XCTAssertThrowsError(try destinationDirectory(parent: parent, id: "dup")) { err in
            XCTAssertEqual(err as? DownloadDestinationError, .directoryExists(name: "relayium-dup"))
        }
    }

    /// The stream carries no file boundaries — the manifest's sizes are the only
    /// thing that splits it, and getting this wrong silently mixes two files.
    func testManifestWriterSplitsChunksAcrossFiles() throws {
        let dir = try tempDir()
        let m = StoredManifest(files: [ManifestFile(name: "a.txt", size: 3),
                                       ManifestFile(name: "b.txt", size: 2)])
        let w = try ManifestWriter(directory: dir, manifest: m)
        try w.write([1, 2, 3, 4])     // spans the boundary
        try w.write([5])
        let urls = try w.finish()
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([4, 5]))
    }

    /// A zero-length file still has to appear on disk — it is in the manifest,
    /// so its absence would read as a failed download.
    func testManifestWriterCreatesEmptyFiles() throws {
        let dir = try tempDir()
        let m = StoredManifest(files: [ManifestFile(name: "empty.txt", size: 0),
                                       ManifestFile(name: "x.txt", size: 1)])
        let w = try ManifestWriter(directory: dir, manifest: m)
        try w.write([9])
        let urls = try w.finish()
        XCTAssertEqual(urls.count, 2)
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data())
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([9]))
    }

    /// A truncated file with a plausible name is worse than no file.
    func testDiscardRemovesEverythingItWrote() throws {
        let dir = try tempDir()
        let m = StoredManifest(files: [ManifestFile(name: "part.bin", size: 10)])
        let w = try ManifestWriter(directory: dir, manifest: m)
        try w.write([1, 2, 3])
        w.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("part.bin").path))
    }

    /// Names come through the Kit's sanitizer, so a manifest cannot write
    /// outside the directory it was handed.
    func testWriterSanitizesNamesRatherThanTrustingTheManifest() throws {
        let dir = try tempDir()
        let m = StoredManifest(files: [ManifestFile(name: "../escape.txt", size: 1)])
        let w = try ManifestWriter(directory: dir, manifest: m)
        try w.write([7])
        let urls = try w.finish()
        XCTAssertEqual(urls[0].deletingLastPathComponent().path, dir.path,
                       "a sanitized name must stay inside the destination directory")
    }

    func testWriterRefusesExistingAndDuplicateDestinationsWithoutTouchingThem() throws {
        let dir = try tempDir()
        let existing = dir.appendingPathComponent("same.txt")
        try Data("keep".utf8).write(to: existing)
        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [WritableFile(name: "same.txt", size: 1)]))
        XCTAssertEqual(try String(contentsOf: existing), "keep")

        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [
            WritableFile(name: "one/same.bin", size: 1),
            WritableFile(name: "two/same.bin", size: 1),
        ]))
    }

    func testWriterRejectsExcessAndIncompleteStreams() throws {
        let dir = try tempDir()
        let excess = try ManifestWriter(directory: dir, files: [WritableFile(name: "a", size: 1)])
        XCTAssertThrowsError(try excess.write([1, 2]))
        excess.discard()

        let short = try ManifestWriter(directory: dir, files: [WritableFile(name: "b", size: 2)])
        try short.write([1])
        XCTAssertThrowsError(try short.finish())
        short.discard()
    }

    /// A malformed link fails before any network call, with copy that says so.
    func testResolveRejectsAMalformedLinkWithoutNetwork() {
        let m = CloudDownloadModel(client: CloudClient(baseURL: URL(string: "https://example.invalid")!))
        m.linkText = "nonsense"
        m.resolve()
        guard case .failed(let msg) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertTrue(msg.contains("relayium.com/d/"), "the copy should show the expected shape: \(msg)")
    }
}
