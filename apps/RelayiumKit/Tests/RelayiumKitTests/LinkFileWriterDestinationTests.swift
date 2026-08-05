import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The production `LinkFileDestination`: the link driver's inbound seam wired to
/// the descriptor-pinned `ManifestWriter`.
///
/// Everything here is about the JOIN, not about the writer: the writer's own path
/// validation, traversal, collision and cleanup rules are proven in
/// `FolderReceiveTests` and `ManifestWriterRaceTests` and are deliberately not
/// re-tested. What is tested is the boundary arithmetic the adapter adds — the
/// protocol's `openNextFile(index:)` against a writer that advances itself by
/// byte count — and the terminal semantics the driver relies on: commit once,
/// abort once, and never delete a committed file.
final class LinkFileWriterDestinationTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("link-dest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func relative(_ url: URL, to base: URL) -> String {
        String(url.standardized.path.dropFirst(base.standardized.path.count + 1))
    }

    private func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent(path).path)
    }

    private func contents(_ path: String) throws -> Data {
        try Data(contentsOf: dir.appendingPathComponent(path))
    }

    private func make(batch: Int = 1, _ files: [FileMeta],
                     onCommitted: (([URL]) -> Void)? = nil) throws
        -> LinkFileWriterDestination {
        try LinkFileWriterDestination(batch: batch, files: files, parent: dir,
                                      onCommitted: onCommitted)
    }

    // MARK: - the happy shapes

    /// A flat batch lands straight in the chosen parent, in manifest order, with
    /// the bytes split by the manifest's sizes and nothing else.
    func testFlatBatchWritesEveryFileAndReportsExactURLs() throws {
        var committed: [[URL]] = []
        let sink = try make([FileMeta(name: "a.txt", size: 3),
                             FileMeta(name: "b.txt", size: 2)]) { committed.append($0) }

        try sink.write([1, 2, 3])
        try sink.openNextFile(index: 1)
        try sink.write([9, 9])
        try sink.finalize()

        XCTAssertEqual(try contents("a.txt"), Data([1, 2, 3]))
        XCTAssertEqual(try contents("b.txt"), Data([9, 9]))
        XCTAssertEqual(committed.count, 1)
        XCTAssertEqual(committed.first?.map { relative($0, to: dir) }, ["a.txt", "b.txt"])
        XCTAssertEqual(sink.committedURLs?.map { relative($0, to: dir) }, ["a.txt", "b.txt"])
    }

    /// A foldered batch keeps its hierarchy and gets its own container, exactly as
    /// the shared `openReceiveWriter` decides — the adapter passes `FileMeta.path`
    /// through rather than flattening to `name`.
    func testNestedBatchPreservesPathsUnderItsOwnContainer() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 1, path: "trip/day1/a.txt"),
                             FileMeta(name: "b.txt", size: 1, path: "trip/b.txt")])

        try sink.write([1])
        try sink.openNextFile(index: 1)
        try sink.write([2])
        try sink.finalize()

        XCTAssertEqual(sink.committedURLs?.map { relative($0, to: dir) },
                       ["trip/day1/a.txt", "trip/b.txt"])
        XCTAssertEqual(sink.containerURL?.lastPathComponent, "trip")
    }

    /// A batch with no single root has no folder name to take, so the container is
    /// named from the BATCH id — deterministic, so a report can name it before the
    /// transfer ends and two batches on one link cannot collide.
    func testMultiRootBatchUsesADeterministicNameDerivedFromTheBatchId() throws {
        let files = [FileMeta(name: "a.txt", size: 1, path: "one/a.txt"),
                     FileMeta(name: "b.txt", size: 1, path: "two/b.txt")]
        let sink = try make(batch: 7, files)
        XCTAssertEqual(sink.containerURL?.lastPathComponent,
                       LinkFileWriterDestination.fallbackContainerName(batch: 7))

        // Deterministic: the same batch asked twice picks the same NAME, and the
        // writer's own step-aside — not a random suffix — resolves the collision.
        let again = try make(batch: 7, files)
        XCTAssertEqual(again.containerURL?.lastPathComponent,
                       LinkFileWriterDestination.fallbackContainerName(batch: 7) + " (2)")
    }

    // MARK: - the boundary acknowledgement

    /// `openNextFile` is an acknowledgement, not a second open: it may not run
    /// ahead of the bytes. The writer is still inside file 0, so the boundary into
    /// file 1 has not happened.
    func testPrematureBoundaryIsRefused() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 4),
                             FileMeta(name: "b.txt", size: 1)])
        try sink.write([1, 2])
        XCTAssertThrowsError(try sink.openNextFile(index: 1)) { error in
            XCTAssertEqual(error as? LinkFileDestinationError, .boundaryNotReached(index: 1))
        }
    }

    /// The same boundary twice is a protocol error, not a second advance. The
    /// writer has genuinely reached index 1, so only the adapter's own expectation
    /// can catch this.
    func testDuplicateBoundaryIsRefused() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 1),
                             FileMeta(name: "b.txt", size: 1)])
        try sink.write([1])
        try sink.openNextFile(index: 1)
        XCTAssertThrowsError(try sink.openNextFile(index: 1)) { error in
            XCTAssertEqual(error as? LinkFileDestinationError,
                           .unexpectedBoundary(expected: 2, received: 1))
        }
    }

    /// A skipped boundary would leave one file's DONE unaccounted for.
    func testSkippedBoundaryIsRefused() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 1),
                             FileMeta(name: "b.txt", size: 0),
                             FileMeta(name: "c.txt", size: 1)])
        try sink.write([1])
        XCTAssertThrowsError(try sink.openNextFile(index: 2)) { error in
            XCTAssertEqual(error as? LinkFileDestinationError,
                           .unexpectedBoundary(expected: 1, received: 2))
        }
    }

    /// Index 0 is never acknowledged — creating the destination opened it — and a
    /// negative index is arithmetic that must not reach an array.
    func testIndexZeroAndNegativeIndicesAreRefused() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 1),
                             FileMeta(name: "b.txt", size: 1)])
        XCTAssertThrowsError(try sink.openNextFile(index: 0))
        XCTAssertThrowsError(try sink.openNextFile(index: -1))
        XCTAssertThrowsError(try sink.openNextFile(index: Int.min))
    }

    /// There is no boundary past the last file: that end is a COMPLETE, and the
    /// index it would carry is out of the manifest.
    func testABoundaryPastTheLastFileIsRefused() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 1),
                             FileMeta(name: "b.txt", size: 1)])
        try sink.write([1])
        try sink.openNextFile(index: 1)
        try sink.write([2])
        XCTAssertThrowsError(try sink.openNextFile(index: 2)) { error in
            XCTAssertEqual(error as? LinkFileDestinationError,
                           .unexpectedBoundary(expected: 2, received: 2))
        }
        XCTAssertThrowsError(try sink.openNextFile(index: Int.max))
    }

    /// The case the naive check gets wrong. The writer CREATES zero-length files
    /// as it walks past them, so by the time file 0's DONE arrives the writer is
    /// already sitting on file 3 — while the protocol still owes three ordered
    /// acknowledgements. Requiring the writer to be exactly at the acknowledged
    /// index would refuse every one of them.
    func testConsecutiveZeroLengthFilesAreAcknowledgedInOrder() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 3),
                             FileMeta(name: "z1.txt", size: 0),
                             FileMeta(name: "z2.txt", size: 0),
                             FileMeta(name: "b.txt", size: 2)])
        try sink.write([1, 2, 3])
        try sink.openNextFile(index: 1)
        try sink.openNextFile(index: 2)
        try sink.openNextFile(index: 3)
        try sink.write([7, 8])
        try sink.finalize()

        XCTAssertEqual(try contents("z1.txt"), Data())
        XCTAssertEqual(try contents("z2.txt"), Data())
        XCTAssertEqual(try contents("b.txt"), Data([7, 8]))
        XCTAssertEqual(sink.committedURLs?.count, 4)
    }

    /// A manifest that is nothing but empty files never calls `write` at all, and
    /// still owes exactly one acknowledgement per boundary.
    func testAnAllEmptyManifestStillCommitsEveryFile() throws {
        let sink = try make([FileMeta(name: "z0.txt", size: 0),
                             FileMeta(name: "z1.txt", size: 0)])
        try sink.openNextFile(index: 1)
        try sink.finalize()

        XCTAssertTrue(exists("z0.txt"))
        XCTAssertTrue(exists("z1.txt"))
        XCTAssertEqual(sink.committedURLs?.count, 2)
    }

    // MARK: - commit

    /// The commit callback is one-shot. A repeated finalize — a replayed final
    /// DONE, a retried effect — must not report a second time and must not touch
    /// the filesystem again.
    func testRepeatedFinalizeCommitsOnceAndReportsOnce() throws {
        var reports = 0
        let sink = try make([FileMeta(name: "a.txt", size: 1)]) { _ in reports += 1 }
        try sink.write([5])
        try sink.finalize()
        try sink.finalize()
        try sink.finalize()

        XCTAssertEqual(reports, 1)
        XCTAssertEqual(try contents("a.txt"), Data([5]))
    }

    /// Commit is what `finish()` says it is. An incomplete manifest is not
    /// committed, reports nothing, and stays abortable — that is the state a
    /// stalled or replaced transfer is cleaned up from.
    func testIncompleteFinalizeDoesNotCommitAndLeavesTheBatchAbortable() throws {
        var reports = 0
        let sink = try make([FileMeta(name: "a.txt", size: 4)]) { _ in reports += 1 }
        try sink.write([1, 2])

        XCTAssertThrowsError(try sink.finalize())
        XCTAssertEqual(reports, 0)
        XCTAssertNil(sink.committedURLs)
        XCTAssertTrue(exists("a.txt"), "the partial file is still the writer's until it is discarded")

        sink.abort()
        XCTAssertFalse(exists("a.txt"))
    }

    /// After a commit the bytes are the USER'S file. A late abort — a terminal
    /// lane, a link that ended while the commit was in flight — must never remove
    /// them.
    func testAbortAfterCommitNeverDeletesTheUsersFiles() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 1, path: "trip/a.txt")])
        try sink.write([1])
        try sink.finalize()

        sink.abort()
        sink.abort()

        XCTAssertEqual(try contents("trip/a.txt"), Data([1]))
    }

    /// Nothing may reach the writer after a terminal decision.
    func testWorkAfterATerminalDecisionIsRefused() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 2),
                             FileMeta(name: "b.txt", size: 1)])
        sink.abort()

        XCTAssertThrowsError(try sink.write([1, 2])) { error in
            XCTAssertEqual(error as? LinkFileDestinationError, .notOpen)
        }
        XCTAssertThrowsError(try sink.openNextFile(index: 1)) { error in
            XCTAssertEqual(error as? LinkFileDestinationError, .notOpen)
        }
        XCTAssertThrowsError(try sink.finalize()) { error in
            XCTAssertEqual(error as? LinkFileDestinationError, .notOpen)
        }
        XCTAssertFalse(exists("a.txt"))
    }

    // MARK: - abort

    /// The second abort is INERT, not a second discard. If it ran again it would
    /// unlink whatever now stands at those names — which, by the time a stale
    /// abort arrives, may be the next transfer's file or the user's own.
    func testRepeatedAbortDiscardsExactlyOnce() throws {
        let sink = try make([FileMeta(name: "a.txt", size: 4)])
        try sink.write([1, 2])
        sink.abort()
        XCTAssertFalse(exists("a.txt"))

        // Somebody else now owns that name.
        try Data([42]).write(to: dir.appendingPathComponent("a.txt"))
        sink.abort()
        XCTAssertEqual(try contents("a.txt"), Data([42]))
    }

    // MARK: - creation

    /// A manifest the writer refuses never becomes a destination, and leaves
    /// nothing behind — not the container it would have needed, and not a
    /// half-written file.
    func testARefusedManifestLeavesNoResidue() {
        XCTAssertThrowsError(try make([FileMeta(name: "a", size: 1, path: "trip/a.txt"),
                                       FileMeta(name: "a", size: 1, path: "trip/A.txt")]))
        XCTAssertFalse(exists("trip"))
    }

    /// A name already taken in the user's own directory is a refusal, and the
    /// file that was there is untouched.
    func testACollidingFlatBatchIsRefusedWithoutTouchingWhatIsThere() throws {
        try Data([99]).write(to: dir.appendingPathComponent("a.txt"))
        XCTAssertThrowsError(try make([FileMeta(name: "a.txt", size: 1)]))
        XCTAssertEqual(try contents("a.txt"), Data([99]))
    }

    /// An empty manifest is the upstream validator's decision. The adapter's job
    /// is only to not trap on the index arithmetic that follows from a count of
    /// zero.
    func testAnEmptyManifestIsRefusedRatherThanTrapping() {
        XCTAssertThrowsError(try make([]))
    }

    // MARK: - the seam itself

    /// The driver never sees the concrete type: it holds a `LinkFileDestination`
    /// built by a `LinkFileDestinationFactory`. Drive a whole batch through those
    /// two, so the adapter is proven at the width the driver actually uses.
    func testDrivesAWholeBatchThroughTheProtocolSeam() throws {
        var committed: [URL] = []
        let factory: LinkFileDestinationFactory = { [dir] batch, files in
            try LinkFileWriterDestination(batch: batch, files: files, parent: dir!,
                                          onCommitted: { committed = $0 })
        }

        let sink: LinkFileDestination = try factory(3, [FileMeta(name: "a.bin", size: 2),
                                                        FileMeta(name: "b.bin", size: 1)])
        try sink.write([1, 2])
        try sink.openNextFile(index: 1)
        try sink.write([3])
        try sink.finalize()
        sink.abort()

        XCTAssertEqual(committed.map { relative($0, to: dir) }, ["a.bin", "b.bin"])
        XCTAssertEqual(try contents("a.bin"), Data([1, 2]))
        XCTAssertEqual(try contents("b.bin"), Data([3]))
    }
}
