import XCTest
import Darwin
@testable import RelayiumAppKit
@testable import RelayiumKit

/// What gets sent must be what the user chose, even though staging and
/// transmission are minutes apart.
///
/// A realtime send stages the batch, shows the manifest, and then waits — for
/// the peer to appear on a code, for a nearby device to answer. Everything in
/// this file is about that gap: the file is picked, and then something replaces
/// it before a single byte has gone out.
final class StagedSourcePinningTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-pin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    private func write(_ relative: String, _ bytes: [UInt8]) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(bytes).write(to: url)
        return url
    }

    private func drain(_ source: inout PlaintextSource) throws -> [UInt8] {
        var out: [UInt8] = []
        while true {
            let chunk = try source.read(64)
            if chunk.isEmpty { break }
            out += chunk
        }
        return out
    }

    /// The case a size check cannot catch: the replacement is byte-for-byte the
    /// same length, so `size` still matches, the manifest still looks right, and
    /// a path-reopening source would happily transmit the attacker's bytes under
    /// the approved filename.
    func testSameSizeReplacementAfterStagingSendsTheOriginalBytes() throws {
        let url = try write("secret.txt", Array("AAAA".utf8))
        var source: PlaintextSource = try FileURLSource(url: url)

        // A same-size swap, done the way a real one would be: a fresh file
        // renamed over the original, so the name now refers to a new inode.
        let replacement = try write("replacement.txt", Array("BBBB".utf8))
        try FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: replacement, to: url)

        XCTAssertEqual(source.size, 4)
        XCTAssertEqual(try drain(&source), Array("AAAA".utf8),
                       "a same-size replacement was sent instead of the staged file")
    }

    /// Replacing the final component with a symlink after staging. A reopen by
    /// path would follow it; a pinned descriptor does not look the name up
    /// again at all.
    func testLeafReplacedBySymlinkAfterStagingSendsTheOriginalBytes() throws {
        let url = try write("doc.txt", Array("REAL".utf8))
        var source: PlaintextSource = try FileURLSource(url: url)

        let elsewhere = try write("elsewhere.txt", Array("EVIL".utf8))
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: elsewhere)

        XCTAssertEqual(try drain(&source), Array("REAL".utf8))
    }

    /// An ANCESTOR directory replaced by a symlink to a decoy tree holding a
    /// same-named, same-sized file. Nothing about the final component changed;
    /// only the path above it did. This is the case that defeats every check
    /// applied to the leaf alone.
    func testAncestorReplacedAfterStagingSendsTheOriginalBytes() throws {
        try write("box/report.txt", Array("REAL".utf8))
        try write("decoy/report.txt", Array("EVIL".utf8))
        var source: PlaintextSource =
            try FileURLSource(url: root.appendingPathComponent("box/report.txt"))

        try FileManager.default.removeItem(at: root.appendingPathComponent("box"))
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("box"),
            withDestinationURL: root.appendingPathComponent("decoy"))

        XCTAssertEqual(try drain(&source), Array("REAL".utf8),
                       "an ancestor swap redirected the send")
    }

    /// Deleting the file after staging does not break the send: the descriptor
    /// keeps the inode alive. The user consented to these bytes and they are
    /// still exactly these bytes.
    func testDeletionAfterStagingStillSendsTheStagedBytes() throws {
        let url = try write("gone.txt", Array("KEEP".utf8))
        var source: PlaintextSource = try FileURLSource(url: url)
        try FileManager.default.removeItem(at: url)
        XCTAssertEqual(try drain(&source), Array("KEEP".utf8))
    }

    /// A symlink handed straight to the source is refused rather than followed,
    /// matching `expandSelection`'s refusal so the two cannot disagree.
    func testASymlinkIsRefusedAtStagingTime() throws {
        let target = try write("target.txt", [1, 2, 3])
        let link = root.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try FileURLSource(url: link)) { err in
            XCTAssertEqual(err as? PlaintextSourceError, .unreadable(name: "link.txt"))
        }
    }

    /// A directory, or anything else that is not a regular file, is refused at
    /// staging. A FIFO in particular would block the reader forever.
    func testNonRegularFilesAreRefusedAtStagingTime() throws {
        try FileManager.default.createDirectory(at: root.appendingPathComponent("d"),
                                                withIntermediateDirectories: true)
        XCTAssertThrowsError(try FileURLSource(url: root.appendingPathComponent("d")))

        let fifo = root.appendingPathComponent("pipe")
        XCTAssertEqual(fifo.path.withCString { mkfifo($0, 0o600) }, 0)
        XCTAssertThrowsError(try FileURLSource(url: fifo)) { err in
            XCTAssertEqual(err as? PlaintextSourceError, .unreadable(name: "pipe"))
        }
    }

    /// Multi-file streaming is unchanged: the encryptor still walks the sources
    /// in order and still yields one frame at a time.
    func testMultiFileStreamingIsUnchanged() throws {
        let a = try write("a.bin", [1, 2, 3])
        let b = try write("b.bin", [4, 5])
        let key = [UInt8](repeating: 3, count: 32)
        let enc = ChunkEncryptor(key: key, sources: [
            try FileURLSource(url: a), try FileURLSource(url: b),
        ])
        var frames = 0
        while try enc.next() != nil { frames += 1 }
        XCTAssertEqual(frames, 2, "one frame per file for files under the chunk size")
    }

    /// Zero-byte files still stage and still yield nothing to send.
    func testZeroByteFileStagesAndReadsEmpty() throws {
        let url = try write("empty.bin", [])
        var source: PlaintextSource = try FileURLSource(url: url)
        XCTAssertEqual(source.size, 0)
        XCTAssertEqual(try source.read(64), [])
    }

    /// The descriptors are released when the staged batch is, with no `close()`
    /// for a caller to forget — the property `OpenFile`'s deinit exists for.
    /// Measured against the process's own open-file count, because a leak here
    /// is invisible until a user stages a thousand files twice.
    func testDroppingAStagedBatchReleasesItsDescriptors() throws {
        for i in 0..<40 { try write("many/f\(i).bin", [UInt8(i)]) }
        let selection = try expandSelection([root.appendingPathComponent("many")])
        let before = openDescriptorCount()
        do {
            let staged = try stageRealtimeFiles(selection.files)
            XCTAssertEqual(staged.sources.count, 40)
            XCTAssertGreaterThanOrEqual(openDescriptorCount(), before + 40,
                                        "staging is supposed to pin one descriptor per file")
        }
        XCTAssertLessThanOrEqual(openDescriptorCount(), before,
                                 "dropping the staged batch leaked descriptors")
    }

    /// Raising the soft limit never lowers it, and never traps.
    ///
    /// `Int.max` is not a hypothetical input: macOS reports `rlim_max` as
    /// `Int64.max`, so a caller reading the hard limit and passing it back in
    /// produces exactly this, and `count + reserve` on it used to trap the whole
    /// process — a crash where at most a no-op belongs.
    func testRaisingTheDescriptorBudgetIsMonotonicAndTrapFree() {
        let before = currentDescriptorLimit()
        raiseDescriptorBudget(for: MAX_FILES)
        XCTAssertGreaterThanOrEqual(currentDescriptorLimit(), before, "the limit must never be lowered")
        raiseDescriptorBudget(for: Int.max)          // must not trap
        raiseDescriptorBudget(for: 0)
        raiseDescriptorBudget(for: -1)
        raiseDescriptorBudget(for: Int.min)
        XCTAssertGreaterThanOrEqual(currentDescriptorLimit(), before)
    }

    /// A NEGATIVE sum must not reach `rlim_t(_:)`, which traps on one.
    ///
    /// Overflow was handled; this is the other direction, and `reserve` is a
    /// public parameter with a default — nothing stops a caller passing a
    /// negative one, and `count: 1, reserve: -2` is enough to crash the process.
    func testRaisingTheDescriptorBudgetSurvivesNegativeReserves() {
        let before = currentDescriptorLimit()
        raiseDescriptorBudget(for: 1, reserve: -2)
        raiseDescriptorBudget(for: 1, reserve: Int.min)
        raiseDescriptorBudget(for: Int.max, reserve: Int.min)
        raiseDescriptorBudget(for: Int.min, reserve: Int.min)
        raiseDescriptorBudget(for: Int.max, reserve: Int.max)   // overflows upward
        raiseDescriptorBudget(for: 1, reserve: 0)
        XCTAssertGreaterThanOrEqual(currentDescriptorLimit(), before,
                                    "a degenerate call must never lower the limit")
    }

    /// Descriptor exhaustion is its own answer, not "that file is unreadable".
    ///
    /// Driven by genuinely running the process out of descriptors rather than by
    /// predicting from the rlimit — that prediction is unsound on macOS, which
    /// happily accepts a soft limit of 2^40 while `kern.maxfilesperproc` is
    /// 61440. The limit is restored immediately, whatever the outcome.
    func testRunningOutOfDescriptorsIsReportedAsSuchAndRestoresCleanly() throws {
        let url = try write("one.bin", [1])

        var original = rlimit()
        XCTAssertEqual(getrlimit(RLIMIT_NOFILE, &original), 0)

        // Just above what is already open, so the first few pins succeed and the
        // process then genuinely runs dry. Squeezing the SOFT limit is the only
        // reversible option: the hard limit cannot be raised again without
        // privilege, so lowering it would break every later test in this process.
        //
        // That is also why this drives `FileURLSource` rather than
        // `stageRealtimeFiles`: staging begins by raising the soft limit back,
        // which is exactly what it is supposed to do. The behaviour under test
        // is the mapping of `EMFILE` onto its own error, and that lives here.
        var squeezed = original
        squeezed.rlim_cur = rlim_t(openDescriptorCount() + 8)
        XCTAssertEqual(setrlimit(RLIMIT_NOFILE, &squeezed), 0)

        var pinned: [FileURLSource] = []
        var caught: Error?
        for _ in 0..<64 {
            do { pinned.append(try FileURLSource(url: url)) }
            catch { caught = error; break }
        }
        // Restore before asserting anything: an assertion failure must not leave
        // the process unable to open files for every test that follows.
        var restore = original
        XCTAssertEqual(setrlimit(RLIMIT_NOFILE, &restore), 0)
        pinned = []

        let err = try XCTUnwrap(caught, "the process never ran out of descriptors")
        guard case .tooManyOpenFiles? = err as? PlaintextSourceError else {
            return XCTFail("expected tooManyOpenFiles, got \(err)")
        }
        XCTAssertTrue(ErrorCopy.message(for: err, language: .en).contains("smaller batches"),
                      "the copy has to say what to do about it")
    }

    /// Staging must not flatten a `PlaintextSourceError` into its own generic
    /// "couldn't open every selected file".
    ///
    /// The named errors are strictly better copy — "Couldn't open “notes.txt”"
    /// tells the user which item to fix — and descriptor exhaustion in
    /// particular has a completely different remedy from an unreadable file.
    func testStagingPropagatesTheNamedSourceErrorRatherThanFlatteningIt() throws {
        let target = try write("real.txt", [1, 2, 3])
        let link = root.appendingPathComponent("notes.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        // Constructed directly rather than through `expandSelection`, which
        // refuses symlinks earlier: this is the defence-in-depth layer.
        let selected = [SelectedFile(url: link, relativePath: "notes.txt")]

        XCTAssertThrowsError(try stageRealtimeFiles(selected)) { err in
            XCTAssertEqual(err as? PlaintextSourceError, .unreadable(name: "notes.txt"))
            XCTAssertTrue(ErrorCopy.message(for: err, language: .en).contains("notes.txt"))
        }
        XCTAssertThrowsError(try stageCloudFiles(selected)) { err in
            XCTAssertEqual(err as? PlaintextSourceError, .unreadable(name: "notes.txt"))
        }
    }

    private func openDescriptorCount() -> Int {
        var count = 0
        var limit = rlimit()
        guard getrlimit(RLIMIT_NOFILE, &limit) == 0 else { return 0 }
        let ceiling = Int32(min(limit.rlim_cur, 8192))
        for fd in 0..<ceiling where fcntl(fd, F_GETFD) != -1 { count += 1 }
        return count
    }
}
