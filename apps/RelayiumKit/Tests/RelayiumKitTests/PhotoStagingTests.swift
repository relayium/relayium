import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Three halves: the pure naming table, ownership, and staging on a real
/// temporary filesystem.
///
/// Ownership is the half worth the most here. `Transferable`'s import closure is
/// invoked by the framework, and the framework may decode a value and then drop
/// it without ever calling back into this app — a cancelled `loadTransferable`,
/// a superseded import, a torn-down task. ARC is the only cleanup hook that
/// survives that, which is why a candidate owns its directory and why there is
/// no runtime sweep to race a provider callback still completing.
final class PhotoStagingTests: XCTestCase {

    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("photo-staging-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    // MARK: - helpers

    private func tempInbox() throws -> URL {
        let url = scratch.appendingPathComponent("inbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// Stands in for the file `FileRepresentation` hands the import closure —
    /// which the provider deletes the moment that closure returns.
    private func providerFile(_ name: String, bytes: Int = 32) throws -> URL {
        let directory = scratch.appendingPathComponent("provider-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name)
        try Data(repeating: 7, count: bytes).write(to: url)
        return url
    }

    private func makeArea() throws -> (PhotoStagingArea, PhotoStagingBatch, URL) {
        let root = scratch.appendingPathComponent("imports-\(UUID().uuidString)")
        let area = PhotoStagingArea(root: root)
        return (area, try area.makeBatch(), try tempInbox())
    }

    private func entries(_ url: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []).sorted()
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    private var photoStagingSourceURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .appendingPathComponent("Sources/RelayiumAppKit/PhotoStaging.swift")
    }

    // MARK: - naming

    func testStagedNamesAreSafeAndUnique() {
        XCTAssertEqual(stagedFileName(suggested: "IMG_1.HEIC", taken: []), "IMG_1.HEIC")
        // A separator must not be able to escape the batch directory.
        XCTAssertEqual(stagedFileName(suggested: "a/b/IMG_1.HEIC", taken: []), "IMG_1.HEIC")
        XCTAssertEqual(stagedFileName(suggested: "  ", taken: []), "photo")
        XCTAssertEqual(stagedFileName(suggested: "", taken: []), "photo")
        // Two photos with one provider name are the case that would otherwise
        // make the app emit a manifest its own receive side rejects with
        // `error.manifest.duplicatePath`.
        XCTAssertEqual(stagedFileName(suggested: "IMG_1.HEIC", taken: ["IMG_1.HEIC"]),
                       "IMG_1 (2).HEIC")
        XCTAssertEqual(stagedFileName(suggested: "IMG_1.HEIC",
                                      taken: ["IMG_1.HEIC", "IMG_1 (2).HEIC"]),
                       "IMG_1 (3).HEIC")
    }

    /// Control characters and `:` are stripped, and a name is never allowed to
    /// carry a path separator into the batch directory.
    func testControlCharactersAndColonsAreStripped() {
        XCTAssertEqual(stagedFileName(suggested: "IM\u{0}G:1.HEIC", taken: []), "IMG1.HEIC")
        XCTAssertEqual(stagedFileName(suggested: "../../etc/passwd", taken: []), "passwd")
    }

    /// A provider name that is ONLY an extension. The split happens at the last
    /// dot, so the stem is EMPTY — not "mov" — and an empty stem becomes
    /// `photo`. Getting this wrong turns every such item into an extensionless
    /// file called "mov", which the receiving side cannot open by type.
    func testANameThatIsOnlyAnExtension() {
        XCTAssertEqual(stagedFileName(suggested: ".mov", taken: []), "photo.mov")
        XCTAssertEqual(stagedFileName(suggested: ".HEIC", taken: []), "photo.HEIC")
        XCTAssertEqual(stagedFileName(suggested: ".mov", taken: ["photo.mov"]),
                       "photo (2).mov")
        // A leading dot on a name that HAS an extension is stripped from the
        // stem instead, so nothing lands hidden.
        XCTAssertEqual(stagedFileName(suggested: ".IMG_1.HEIC", taken: []), "IMG_1.HEIC")
    }

    /// A name with no extension keeps none — `photo` is the empty-stem answer,
    /// not an extension-inventing one.
    func testANameWithNoExtensionIsLeftWithout() {
        XCTAssertEqual(stagedFileName(suggested: "holiday", taken: []), "holiday")
        XCTAssertEqual(stagedFileName(suggested: "holiday", taken: ["holiday"]), "holiday (2)")
    }

    /// Something longer than 16 bytes after the last dot is not an extension —
    /// it is part of the name, and truncating around it as though it were would
    /// eat the part the user recognises.
    func testAnOverlongSuffixIsNotTreatedAsAnExtension() {
        let name = "clip." + String(repeating: "x", count: 20)
        XCTAssertEqual(stagedFileName(suggested: name, taken: []), name)
        XCTAssertEqual(stagedFileName(suggested: name, taken: [name]), name + " (2)")
    }

    /// Truncation removes whole Characters. A byte slice can split a scalar or
    /// a grapheme cluster and produce a name with a replacement character in it.
    func testTruncationNeverSplitsAMultibyteCharacter() {
        let name = stagedFileName(suggested: String(repeating: "写", count: 300) + ".mov",
                                  taken: [])
        XCTAssertLessThanOrEqual(name.utf8.count, 200)
        XCTAssertTrue(name.hasSuffix(".mov"))
        XCTAssertFalse(name.unicodeScalars.contains("\u{FFFD}"))
        XCTAssertTrue(String(name.dropLast(4)).allSatisfy { $0 == "写" })
    }

    /// The cap has to hold AFTER the collision suffix, which means the stem is
    /// re-truncated per attempt rather than truncated once and then extended.
    func testACollisionSuffixStillFitsTheByteBudget() {
        let long = String(repeating: "n", count: 300) + ".mov"
        let first = stagedFileName(suggested: long, taken: [])
        let second = stagedFileName(suggested: long, taken: [first])
        let third = stagedFileName(suggested: long, taken: [first, second])
        for name in [first, second, third] { XCTAssertLessThanOrEqual(name.utf8.count, 200) }
        XCTAssertTrue(second.hasSuffix(" (2).mov"))
        XCTAssertTrue(third.hasSuffix(" (3).mov"))
        XCTAssertNotEqual(first, second)
        XCTAssertNotEqual(second, third)
    }

    func testTheMultibyteCollisionSuffixAlsoFits() {
        let long = String(repeating: "写", count: 300) + ".mov"
        let first = stagedFileName(suggested: long, taken: [])
        let second = stagedFileName(suggested: long, taken: [first])
        XCTAssertLessThanOrEqual(second.utf8.count, 200)
        XCTAssertTrue(second.hasSuffix(" (2).mov"))
        XCTAssertFalse(second.unicodeScalars.contains("\u{FFFD}"))
    }

    /// Far below `MANIFEST_MAX_NAME_BYTES`, so a staged name can never be the
    /// reason the app's own manifest is refused.
    func testTheNameBudgetIsWellInsideTheManifestBound() {
        let name = stagedFileName(suggested: String(repeating: "写", count: 400) + ".mov",
                                  taken: [])
        XCTAssertLessThan(name.utf8.count, MANIFEST_MAX_NAME_BYTES)
    }

    // MARK: - ownership

    func testTakeCopiesTheProviderFileAndLeavesItAlone() throws {
        let inbox = try tempInbox()
        let provider = try providerFile("IMG_1.HEIC")
        let candidate = try PhotoInbox.take(provider, in: inbox)

        XCTAssertTrue(exists(provider), "step 1 copies; the provider owns its own file")
        XCTAssertTrue(exists(candidate.url))
        XCTAssertEqual(try Data(contentsOf: candidate.url), try Data(contentsOf: provider))
        XCTAssertEqual(candidate.suggestedName, "IMG_1.HEIC")
        // Its own directory, so step 1 needs no collision rule and therefore no
        // context — which is what lets it be reachable from a static closure.
        XCTAssertEqual(candidate.url.deletingLastPathComponent().deletingLastPathComponent().path,
                       inbox.path)
    }

    /// The framework can decode a `StagedPhotoFile` and then drop it — a
    /// cancelled loadTransferable, a superseded import, a torn-down task — and
    /// when it does, no app code runs. ARC is the only cleanup hook left, which
    /// is why there is no sweep to race the provider callback.
    func testACandidateRemovesItsDirectoryOnDeinit() throws {
        let inbox = try tempInbox()
        var directory: URL!
        do {
            let candidate = try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox)
            directory = candidate.url.deletingLastPathComponent()
            XCTAssertTrue(exists(directory))
        }
        XCTAssertFalse(exists(directory))
    }

    func testDiscardIsExactlyOnceAndSafeToRepeat() throws {
        let inbox = try tempInbox()
        let candidate = try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox)
        let directory = candidate.url.deletingLastPathComponent()
        candidate.discard()
        candidate.discard()
        XCTAssertFalse(exists(directory))
    }

    /// Ownership moves only after the move succeeds, and the emptied inbox
    /// directory goes with it.
    func testAdoptTransfersOwnershipOnlyAfterASuccessfulMove() throws {
        let (area, batch, inbox) = try makeArea()
        let candidate = try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox)
        let directory = candidate.url.deletingLastPathComponent()
        let staged = try area.adopt(candidate, into: batch)
        XCTAssertTrue(exists(staged))
        XCTAssertFalse(exists(candidate.url), "a move, not a copy")
        XCTAssertFalse(exists(directory))
    }

    /// And the candidate's LATER deinit must not delete a file that now belongs
    /// to the batch.
    func testAnAdoptedCandidatesDeinitDoesNotTouchTheBatch() throws {
        let (area, batch, inbox) = try makeArea()
        var staged: URL!
        do {
            let candidate = try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox)
            staged = try area.adopt(candidate, into: batch)
        }
        XCTAssertTrue(exists(staged))
    }

    /// Explicitly discarding an already-adopted candidate is the same
    /// no-op — the model calls `discard()` on every path that drops one, and it
    /// must not matter whether that candidate was adopted first.
    func testDiscardingAnAdoptedCandidateDoesNotTouchTheBatch() throws {
        let (area, batch, inbox) = try makeArea()
        let candidate = try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox)
        let staged = try area.adopt(candidate, into: batch)
        candidate.discard()
        XCTAssertTrue(exists(staged))
    }

    /// A failed move leaves the candidate still owning — and still cleaning up
    /// — its directory. Otherwise a transient move failure leaks a video.
    func testAFailedMoveLeavesTheCandidateOwningItsCleanup() throws {
        let (area, batch, inbox) = try makeArea()
        let candidate = try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox)
        let directory = candidate.url.deletingLastPathComponent()
        try FileManager.default.removeItem(at: batch.url)      // make the move fail
        XCTAssertThrowsError(try area.adopt(candidate, into: batch))
        XCTAssertTrue(exists(directory))
        XCTAssertTrue(exists(candidate.url), "the bytes are still the candidate's")
        candidate.discard()
        XCTAssertFalse(exists(directory))
    }

    /// The move and the ownership release are ONE candidate-owned operation, so
    /// a concurrent `discard()` cannot delete the source directory out from
    /// under a move that is still copying bytes. Whichever wins, the outcome is
    /// consistent: either the bytes are in the batch and the inbox directory is
    /// gone, or they were discarded and the move refused.
    func testAConcurrentDiscardCannotRaceTheMove() throws {
        for _ in 0..<80 {
            let (area, batch, inbox) = try makeArea()
            let candidate = try PhotoInbox.take(try providerFile("IMG_1.HEIC", bytes: 64_000),
                                                in: inbox)
            let directory = candidate.url.deletingLastPathComponent()

            var staged: URL?
            let started = DispatchSemaphore(value: 0)
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                started.signal()
                candidate.discard()
                done.signal()
            }
            started.wait()
            staged = try? area.adopt(candidate, into: batch)
            done.wait()

            if let staged {
                XCTAssertTrue(exists(staged), "an adopt that reported success must have the bytes")
            }
            // Either way the candidate's directory is gone and nothing is left
            // half-owned: a refused move discarded, a successful one relinquished.
            XCTAssertFalse(exists(directory))
        }
    }

    func testAdoptAppliesTheCollisionRuleWithinTheBatch() throws {
        let (area, batch, inbox) = try makeArea()
        let first = try area.adopt(try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox),
                                   into: batch)
        let second = try area.adopt(try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox),
                                    into: batch)
        XCTAssertEqual(first.lastPathComponent, "IMG_1.HEIC")
        XCTAssertEqual(second.lastPathComponent, "IMG_1 (2).HEIC")
        XCTAssertEqual(entries(batch.url), ["IMG_1 (2).HEIC", "IMG_1.HEIC"])
    }

    /// No global mutable current-batch context — the reason step 1 can be
    /// static at all.
    func testPhotoStagingDeclaresNoMutableStatic() throws {
        let source = try String(contentsOf: photoStagingSourceURL, encoding: .utf8)
        XCTAssertFalse(source.contains("static var"))
        XCTAssertFalse(source.contains("TaskLocal"))
    }

    // MARK: - staging and leftovers

    func testDiscardRemovesTheWholeBatch() throws {
        let (area, batch, inbox) = try makeArea()
        _ = try area.adopt(try PhotoInbox.take(try providerFile("IMG_1.HEIC"), in: inbox),
                           into: batch)
        area.discard(batch)
        XCTAssertFalse(exists(batch.url))
    }

    func testAdoptingABatchRemovesThePreviouslyAdoptedOne() throws {
        let (area, first, inbox) = try makeArea()
        _ = try area.adopt(try PhotoInbox.take(try providerFile("A.HEIC"), in: inbox), into: first)
        area.adoptBatch(first)

        let second = try area.makeBatch()
        _ = try area.adopt(try PhotoInbox.take(try providerFile("B.HEIC"), in: inbox), into: second)
        area.adoptBatch(second)

        XCTAssertFalse(exists(first.url))
        XCTAssertTrue(exists(second.url))
    }

    func testClearRemovesTheLiveBatch() throws {
        let (area, batch, _) = try makeArea()
        area.adoptBatch(batch)
        area.clear()
        XCTAssertFalse(exists(batch.url))
        area.clear()   // idempotent
    }

    func testDeallocationRemovesTheLiveBatch() throws {
        let root = scratch.appendingPathComponent("imports-\(UUID().uuidString)")
        var live: URL!
        do {
            let area = PhotoStagingArea(root: root)
            let batch = try area.makeBatch()
            area.adoptBatch(batch)
            live = batch.url
            XCTAssertTrue(exists(live))
        }
        XCTAssertFalse(exists(live))
    }

    /// The launch sweep can never race a live batch, because a live batch is
    /// always inside the launch directory the sweep excludes by construction.
    func testTheLaunchSweepRemovesOtherLaunchesAndNeverThisOne() throws {
        let root = scratch.appendingPathComponent("imports-\(UUID().uuidString)")
        let previous = root.appendingPathComponent("a-previous-launch")
        try FileManager.default.createDirectory(at: previous, withIntermediateDirectories: true)
        try Data([1]).write(to: previous.appendingPathComponent("leftover.HEIC"))

        let area = PhotoStagingArea(root: root)
        let batch = try area.makeBatch()
        area.adoptBatch(batch)

        PhotoStagingArea.sweepOtherLaunches(under: root, keeping: area.launchRoot)

        XCTAssertFalse(exists(previous))
        XCTAssertTrue(exists(area.launchRoot))
        XCTAssertTrue(exists(batch.url), "the live batch is inside the directory kept")
    }

    func testSweepLeftoversEmptiesTheInbox() throws {
        let inbox = try tempInbox()
        let candidates = [
            try PhotoInbox.take(try providerFile("A.HEIC"), in: inbox),
            try PhotoInbox.take(try providerFile("B.HEIC"), in: inbox),
        ]
        XCTAssertEqual(entries(inbox).count, 2)
        PhotoInbox.sweepLeftovers(inbox)
        XCTAssertTrue(entries(inbox).isEmpty)
        // Held to here on purpose: if they had been released the sweep would
        // have proved nothing, because ARC would already have cleaned up.
        withExtendedLifetime(candidates) {}
    }

    func testThePhotoImportBoundIsAboutDiskNotTheManifest() {
        XCTAssertEqual(PHOTO_IMPORT_MAX, 50)
        XCTAssertLessThan(PHOTO_IMPORT_MAX, MAX_FILES)
    }
}
