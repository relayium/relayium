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
        XCTAssertEqual(first.url.lastPathComponent, "relayium-dup")
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

    /// A traversing manifest is REFUSED, not repaired.
    ///
    /// This assertion changed with folder support, deliberately. It used to
    /// require that `../escape.txt` be reduced to `escape.txt` and written — safe
    /// (it could not leave the directory) but dishonest, because the file landed
    /// under a name the user never saw on the confirmation card. Now that a
    /// manifest path is a real path rather than a name to strip, refusal is both
    /// available and correct, and it matches what the Go receive path already
    /// does (`safeJoin` returns an error). Nothing that legitimately produces
    /// these manifests can emit `..`: the web derives paths from `fullPath`, the
    /// CLI from `filepath.Rel`, this app from `expandSelection`.
    func testWriterRefusesTraversingManifestPaths() throws {
        let dir = try tempDir()
        let m = StoredManifest(files: [ManifestFile(name: "../escape.txt", size: 1)])
        XCTAssertThrowsError(try ManifestWriter(directory: dir, manifest: m)) { err in
            XCTAssertEqual(err as? ManifestPathError, .unsafePath("../escape.txt"))
        }
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: dir.deletingLastPathComponent().appendingPathComponent("escape.txt").path))
    }

    func testWriterRefusesExistingDestinationsWithoutTouchingThem() throws {
        let dir = try tempDir()
        let existing = dir.appendingPathComponent("same.txt")
        try Data("keep".utf8).write(to: existing)
        XCTAssertThrowsError(try ManifestWriter(directory: dir, files: [WritableFile(name: "same.txt", size: 1)]))
        XCTAssertEqual(try String(contentsOf: existing), "keep")
    }

    /// The other half of the same deliberate change: `one/same.bin` and
    /// `two/same.bin` used to be a REFUSAL, because both flattened to
    /// `same.bin`. They are two different files in two different folders and
    /// must now both arrive, in their own directories.
    func testWriterKeepsSameLeafNameInDifferentFolders() throws {
        let dir = try tempDir()
        let w = try ManifestWriter(directory: dir, files: [
            WritableFile(name: "one/same.bin", size: 1),
            WritableFile(name: "two/same.bin", size: 1),
        ])
        try w.write([1, 2])
        let urls = try w.finish()
        XCTAssertEqual(urls.map { $0.pathComponents.suffix(2).joined(separator: "/") },
                       ["one/same.bin", "two/same.bin"])
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([2]))
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

    // MARK: - a rejected manifest must not leave its container behind

    /// The MULTI-FLAT cloud shape: several files, no folders, so the download
    /// creates its opaque `relayium-<id>` box and writes into it.
    ///
    /// The box is created BEFORE the writer exists, and a manifest refused
    /// during validation or path resolution throws before there is a writer
    /// whose `discard` could clean up. This path used to abandon the directory
    /// empty on every rejected manifest — one per bad link, accumulating in the
    /// user's chosen folder.
    func testARejectedMultiFlatManifestLeavesNoEmptyContainer() throws {
        let parent = try tempDir()
        let dir = try destinationDirectory(parent: parent, id: "abc")
        XCTAssertThrowsError(try openWriterInOwnedContainer(dir, files: [
            // Flat (no "/"), more than one entry, and refused: on a
            // case-insensitive volume these are one file.
            WritableFile(name: "notes.txt", size: 1),
            WritableFile(name: "NOTES.txt", size: 1),
        ])) { err in
            XCTAssertEqual(err as? ManifestPathError, .duplicatePath("NOTES.txt"))
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path), [],
                       "the relayium-<id> container was abandoned empty")
    }

    /// The same for a manifest refused by size validation, which throws even
    /// earlier — before the path resolver runs at all.
    func testAManifestRefusedByValidationAlsoLeavesNoContainer() throws {
        let parent = try tempDir()
        let dir = try destinationDirectory(parent: parent, id: "def")
        XCTAssertThrowsError(try openWriterInOwnedContainer(dir, files: [
            WritableFile(name: "a.txt", size: -1),
            WritableFile(name: "b.txt", size: 1),
        ]))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path), [])
    }

    /// A container replaced by somebody else's directory before the cleanup runs
    /// is LEFT ALONE — the same guarantee `removeDirectoryIfUnchanged` documents.
    /// The cleanup must not become a recursive delete just because it moved into
    /// a shared helper.
    func testCleanupOfARejectedManifestNeverDeletesAReplacementContainer() throws {
        let parent = try tempDir()
        let dir = try destinationDirectory(parent: parent, id: "ghi")
        // Swap it for a different directory that is NOT empty, so a recursive
        // remove would destroy data.
        try FileManager.default.removeItem(at: dir.url)
        try FileManager.default.createDirectory(at: dir.url, withIntermediateDirectories: false)
        try Data("theirs".utf8).write(to: dir.url.appendingPathComponent("theirs.txt"))

        XCTAssertThrowsError(try openWriterInOwnedContainer(dir, files: [
            WritableFile(name: "a.txt", size: 1),
            WritableFile(name: "A.txt", size: 1),
        ]))
        XCTAssertEqual(try String(contentsOf: dir.url.appendingPathComponent("theirs.txt")), "theirs",
                       "cleanup recursively deleted a replacement container")
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

// MARK: - the real download path, end to end

/// Drives `CloudDownloadModel.resolve()` + `download(into:)` against a stubbed
/// server, so the container discipline is proved where it actually lives rather
/// than only on the helper it delegates to.
///
/// The unit tests above cover `openWriterInOwnedContainer` directly. They would
/// keep passing if somebody re-inlined `ManifestWriter(container:…)` into the
/// model — which is exactly the shape the bug had. This one would not.
@MainActor
final class CloudDownloadModelContainerTests: XCTestCase {
    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-e2e-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    override func tearDown() {
        StubURLProtocol.router = nil
        StubURLProtocol.stub = nil
        super.tearDown()
    }

    /// Serve `/api/files/<id>/meta` (the encrypted manifest) and, when
    /// `contents` is given, `/api/files/<id>/blob` (the framed ciphertext the
    /// real uploader produces, via the same `ChunkEncryptor`).
    private func makeModel(files: [ManifestFile], key: [UInt8],
                           contents: [String: [UInt8]]? = nil,
                           errorCopy: ((Error) -> String)? = nil) throws -> CloudDownloadModel {
        let enc = try encryptManifest(key: key, StoredManifest(files: files))
        let meta = StoredFileMeta(encManifest: Data(enc).base64EncodedString(),
                                  size: 0, burnAfterRead: false, expiresAt: 0)
        let metaBody = try JSONEncoder().encode(meta)

        var blobBody = Data()
        if let contents {
            let encryptor = ChunkEncryptor(key: key, sources: files.map {
                DataSource(name: $0.name, bytes: contents[$0.name] ?? [])
            })
            while let frame = try encryptor.next() { blobBody.append(frame) }
        }
        StubURLProtocol.router = { req in
            req.url?.path.hasSuffix("/blob") == true
                ? .init(status: 200, body: blobBody)
                : .init(status: 200, body: metaBody)
        }
        let client = CloudClient(baseURL: URL(string: "https://example.invalid")!,
                                 session: StubURLProtocol.session())
        guard let errorCopy else { return CloudDownloadModel(client: client) }
        return CloudDownloadModel(client: client, errorCopy: errorCopy)
    }

    /// Yields are not enough here: `resolve`/`download` run a real (stubbed)
    /// URLSession round trip on another queue, so the test has to wait for the
    /// state to actually settle rather than for the actor to drain.
    private func waitFor(_ what: String,
                         _ ready: @MainActor () -> Bool,
                         seconds: TimeInterval = 5) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if ready() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(what)")
        return false
    }

    /// The reported blocker: a MULTI-FLAT manifest that the writer rejects. The
    /// model creates `relayium-<id>` before the writer exists, so a rejection
    /// used to abandon it — one empty directory per bad link, in the folder the
    /// user picked.
    func testAnInvalidMultiFlatManifestLeavesNoEmptyContainerInTheChosenFolder() async throws {
        let key = [UInt8](repeating: 4, count: 32)
        // Flat (no "/"), more than one entry, and refused: on a
        // case-insensitive volume these two are one destination.
        let m = try makeModel(files: [ManifestFile(name: "notes.txt", size: 1),
                                      ManifestFile(name: "NOTES.txt", size: 1)],
                              key: key)
        m.linkText = "https://relayium.com/d/abc123#k=\(encodeStoreKey(key))"
        m.resolve()
        _ = await waitFor("the manifest to resolve", { if case .ready = m.state { return true }; return false })
        guard case .ready = m.state else { return XCTFail("resolve failed: \(m.state)") }

        let parent = try tempDir()
        m.download(into: parent)
        _ = await waitFor("the download to refuse", { if case .failed = m.state { return true }; return false })

        guard case .failed = m.state else { return XCTFail("expected a refusal, got \(m.state)") }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path), [],
                       "an empty relayium-<id> was left in the folder the user chose")
        XCTAssertNil(m.receivedContainer)
        XCTAssertNil(m.received)
    }

    /// The same shape, but a download that actually SUCCEEDS: several flat
    /// files, a real ciphertext blob, and the `relayium-<id>` container with the
    /// files inside it.
    ///
    /// Without this, the cleanup assertion above would pass just as happily
    /// against a model that never creates a container at all — "the folder is
    /// empty afterwards" is not evidence unless something proves the container
    /// is otherwise created and used.
    func testAValidMultiFlatManifestCreatesItsContainerAndFillsIt() async throws {
        let key = [UInt8](repeating: 5, count: 32)
        let m = try makeModel(files: [ManifestFile(name: "a.txt", size: 3),
                                      ManifestFile(name: "b.txt", size: 2)],
                              key: key,
                              contents: ["a.txt": [1, 2, 3], "b.txt": [4, 5]])
        m.linkText = "https://relayium.com/d/xyz789#k=\(encodeStoreKey(key))"
        m.resolve()
        _ = await waitFor("the manifest to resolve", { if case .ready = m.state { return true }; return false })
        guard case .ready = m.state else { return XCTFail("resolve failed: \(m.state)") }

        let parent = try tempDir()
        m.download(into: parent)
        _ = await waitFor("the download to finish", { if case .done = m.state { return true }; return false })

        guard case .done(let urls) = m.state else { return XCTFail("expected .done, got \(m.state)") }
        let container = try XCTUnwrap(m.receivedContainer)
        XCTAssertEqual(container.lastPathComponent, "relayium-xyz789")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path),
                       ["relayium-xyz789"], "the batch must land in its own container")
        XCTAssertEqual(urls.map(\.lastPathComponent), ["a.txt", "b.txt"])
        XCTAssertEqual(urls.map { $0.deletingLastPathComponent().path },
                       [container.path, container.path])
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([4, 5]))
        // The finished result is what Reveal/drag-out is offered on.
        XCTAssertEqual(m.received?.dragURLs, [container])
    }

    // MARK: - the same link received twice into a FIXED destination
    //
    // macOS asks for a folder every time, so receiving the same link twice
    // usually lands somewhere else and the collision is a corner case. iOS
    // (R3-A) has one app-owned folder and no picker, so "the destination name is
    // already taken" is simply what the second tap does — the ordinary path, not
    // the adversarial one.
    //
    // Both shapes are driven through `ReceiveDestination`, so what is asserted
    // is the destination the iOS app actually uses rather than a temporary
    // directory that merely resembles it.

    /// Several flat files: the second receive finds its `relayium-<id>` box
    /// already there. It must refuse, leave the first download's bytes exactly
    /// as they were, and not present the earlier result as this transfer's.
    func testASecondMultiFileReceiveRefusesTheExistingContainerAndKeepsItsBytes() async throws {
        let key = [UInt8](repeating: 6, count: 32)
        let files = [ManifestFile(name: "a.txt", size: 3), ManifestFile(name: "b.txt", size: 2)]
        let contents = ["a.txt": [UInt8]([1, 2, 3]), "b.txt": [UInt8]([4, 5])]
        let documents = try tempDir()
        let link = "https://relayium.com/d/twice-multi#k=\(encodeStoreKey(key))"

        let first = try makeModel(files: files, key: key, contents: contents)
        try await receive(first, link: link, into: documents)
        guard case .done = first.state else { return XCTFail("first receive: \(first.state)") }
        let container = try XCTUnwrap(first.receivedContainer)

        let second = try makeModel(files: files, key: key, contents: contents)
        try await receive(second, link: link, into: documents,
                          until: { if case .failed = $0 { return true }; return false })

        guard case .failed = second.state else {
            return XCTFail("a taken container must refuse, got \(second.state)")
        }
        // Nothing half-finished may be offered as a result.
        XCTAssertNil(second.received)
        XCTAssertNil(second.receivedContainer)
        // And the first download is untouched — same directory, same bytes.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: container.path).sorted(),
                       ["a.txt", "b.txt"])
        XCTAssertEqual(try Data(contentsOf: container.appendingPathComponent("a.txt")),
                       Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: container.appendingPathComponent("b.txt")),
                       Data([4, 5]))
        XCTAssertEqual(try FileManager.default
                        .contentsOfDirectory(atPath: container.deletingLastPathComponent().path),
                       ["relayium-twice-multi"],
                       "a refused second receive must not leave anything beside the first")
    }

    /// One flat file: it is written straight into the receive folder, so the
    /// second receive collides on the FILE name rather than on a container. The
    /// existing file's bytes are the thing that must not move.
    func testASecondSingleFileReceiveRefusesAndKeepsTheExistingBytes() async throws {
        let key = [UInt8](repeating: 7, count: 32)
        let files = [ManifestFile(name: "notes.txt", size: 4)]
        let documents = try tempDir()
        let link = "https://relayium.com/d/twice-one#k=\(encodeStoreKey(key))"

        let first = try makeModel(files: files, key: key, contents: ["notes.txt": [1, 2, 3, 4]])
        try await receive(first, link: link, into: documents)
        guard case .done(let urls) = first.state else {
            return XCTFail("first receive: \(first.state)")
        }
        let saved = try XCTUnwrap(urls.first)
        XCTAssertEqual(try Data(contentsOf: saved), Data([1, 2, 3, 4]))

        // Different bytes behind the same manifest: if the refusal ever became a
        // truncate-and-rewrite, the assertion below would catch it as a content
        // change rather than only as a missing error.
        let second = try makeModel(files: files, key: key, contents: ["notes.txt": [9, 9, 9, 9]])
        try await receive(second, link: link, into: documents,
                          until: { if case .failed = $0 { return true }; return false })

        guard case .failed = second.state else {
            return XCTFail("a taken file name must refuse, got \(second.state)")
        }
        XCTAssertNil(second.received)
        XCTAssertEqual(try Data(contentsOf: saved), Data([1, 2, 3, 4]),
                       "the refusal overwrote the file it was supposed to protect")
        XCTAssertEqual(try FileManager.default
                        .contentsOfDirectory(atPath: saved.deletingLastPathComponent().path),
                       ["notes.txt"])
    }

    /// The refusal above is only half of what the user gets — the other half is
    /// the sentence explaining it, and on iOS the shared one ends in advice that
    /// cannot be followed. Driven through the model rather than through
    /// `ReceiveDestinationCopy` directly, because the message the user reads is
    /// the one the model put in `.failed`, and the seam between the two is
    /// exactly what a future refactor would drop.
    ///
    /// Both copies are asserted against the SAME failure so the negative claim
    /// means something: the shared wording really does say "choose another
    /// folder" here, and the iOS wording really does replace it.
    func testTheIOSCopyReplacesPickerAdviceForARefusedSecondReceive() async throws {
        let failed: (DownloadState) -> Bool = { if case .failed = $0 { return true }; return false }
        let key = [UInt8](repeating: 8, count: 32)
        let files = [ManifestFile(name: "notes.txt", size: 4)]
        let bytes: [String: [UInt8]] = ["notes.txt": [1, 2, 3, 4]]
        let documents = try tempDir()
        let link = "https://relayium.com/d/twice-copy#k=\(encodeStoreKey(key))"

        let first = try makeModel(files: files, key: key, contents: bytes)
        try await receive(first, link: link, into: documents)
        guard case .done = first.state else { return XCTFail("first receive: \(first.state)") }

        // macOS's model, built the way `AppEnvironment` builds it there.
        let mac = try makeModel(files: files, key: key, contents: bytes,
                                errorCopy: { ErrorCopy.message(for: $0, language: .en) })
        try await receive(mac, link: link, into: documents, until: failed)
        guard case .failed(let macMessage) = mac.state else {
            return XCTFail("a taken file name must refuse, got \(mac.state)")
        }
        XCTAssertTrue(macMessage.contains("Choose another folder"), macMessage)

        // The iOS model. Same refusal, same preserved bytes, different recovery.
        let ios = try makeModel(files: files, key: key, contents: bytes,
                                errorCopy: { ReceiveDestinationCopy.message(for: $0,
                                                                            language: .en) })
        try await receive(ios, link: link, into: documents, until: failed)
        guard case .failed(let message) = ios.state else {
            return XCTFail("a taken file name must refuse, got \(ios.state)")
        }
        XCTAssertFalse(message.contains("Choose another folder"),
                       "iOS has no folder picker to send the user to: \(message)")
        XCTAssertTrue(message.contains("notes.txt"), message)
        XCTAssertTrue(message.contains("Relayium/Received"), message)
        XCTAssertTrue(message.contains("Files app"), message)
        XCTAssertNil(ios.received)
    }

    /// Resolve, then download into the app-owned receive folder under
    /// `documents`, and wait for the state the caller expects.
    private func receive(_ model: CloudDownloadModel, link: String, into documents: URL,
                         until done: @escaping (DownloadState) -> Bool = {
                             if case .done = $0 { return true }; return false
                         }) async throws {
        model.linkText = link
        model.resolve()
        _ = await waitFor("the manifest to resolve",
                          { if case .ready = model.state { return true }; return false })
        guard case .ready = model.state else {
            return XCTFail("resolve failed: \(model.state)")
        }
        model.download(into: try ReceiveDestination.directory(inDocuments: documents))
        _ = await waitFor("the download to settle", { done(model.state) })
    }
}
