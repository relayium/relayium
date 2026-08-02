import XCTest
import Darwin
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The receive path against a local process that wins every race.
///
/// These are not "a symlink was already there" tests — `FolderReceiveTests`
/// covers that. Here the swap happens INSIDE the window, at the instant the
/// writer is about to make the syscall, which is the case a check-then-use
/// writer cannot survive no matter how careful its checks are. The writer's
/// `raceHook` exists for exactly this and is nil everywhere else.
///
/// Every test asserts the same two things: the operation was refused, and
/// nothing appeared outside the destination the user chose.
final class ManifestWriterRaceTests: XCTestCase {
    private var dest: URL!
    private var outside: URL!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-race-\(UUID().uuidString)")
        dest = base.appendingPathComponent("dest")
        outside = base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dest.deletingLastPathComponent())
    }

    private func outsideIsUntouched(_ message: String) {
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: outside.path)) ?? []
        XCTAssertEqual(contents, [], message)
    }

    /// Replaces the real directory `dest/name` with a symlink to `outside`,
    /// i.e. the attacker's move, performed while the writer is mid-syscall.
    ///
    /// Returns whether the swap actually happened: the writer walks the same
    /// name during its preflight, before anything has been created, and a hook
    /// that "fired" against a directory that does not exist yet would make these
    /// tests pass without ever testing anything.
    @discardableResult
    private func swapDirectoryForSymlink(_ name: String) -> Bool {
        let victim = dest.appendingPathComponent(name)
        guard (try? FileManager.default.contentsOfDirectory(atPath: victim.path)) != nil else {
            return false
        }
        try? FileManager.default.removeItem(at: victim)
        try? FileManager.default.createSymbolicLink(at: victim, withDestinationURL: outside)
        return (try? victim.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink == true
    }

    // MARK: - ancestors

    /// The classic window: the writer creates `t`, and before it can open it the
    /// attacker rmdir's it and drops a symlink to somewhere else in its place.
    ///
    /// A path-based writer would then `mkdir`/`open` through that symlink and
    /// write outside the destination. Opening the component with `O_NOFOLLOW`
    /// makes the swap fail the open instead.
    func testAncestorSwappedForASymlinkBetweenCreateAndOpenIsRefused() {
        var swapped = false
        XCTAssertThrowsError(try ManifestWriter(directory: dest, files: [
            WritableFile(name: "a.txt", size: 3, path: "t/a.txt"),
        ], raceHook: { event in
            // Only once, and only once `t` genuinely exists: the preflight walks
            // the same name first, before anything has been created.
            if case .beforeDirectoryOpen("t") = event, !swapped {
                swapped = self.swapDirectoryForSymlink("t")
            }
        })) { err in
            XCTAssertEqual(err as? DownloadDestinationError, .unsafeName("t"),
                           "a swapped ancestor must be a refusal, not a redirect")
        }
        XCTAssertTrue(swapped, "the test never performed the swap it is meant to test")
        outsideIsUntouched("a write escaped through an ancestor swapped mid-syscall")
    }

    /// The same swap, but landed between two files of one batch: the first file
    /// is already on disk when `t` is replaced under the second.
    func testAncestorSwappedMidBatchIsRefusedAndCleansUp() throws {
        var swapped = false
        let writer = try ManifestWriter(directory: dest, files: [
            WritableFile(name: "a.txt", size: 1, path: "t/a.txt"),
            WritableFile(name: "b.txt", size: 1, path: "t/b.txt"),
        ], raceHook: { event in
            // After the first file is written, poison the directory the second
            // one is about to be opened in.
            if case .beforeLeafCreate("t/b.txt") = event, !swapped {
                swapped = self.swapDirectoryForSymlink("t")
            }
        })
        // The first byte lands; the second file's create is what discovers the
        // swap, because `t` is now a symlink and its descriptor cannot be walked.
        XCTAssertThrowsError(try writer.write([1, 2]))
        writer.discard()
        outsideIsUntouched("a mid-batch ancestor swap escaped the destination")
    }

    // MARK: - the leaf

    /// A dangling symlink dropped at the leaf name in the instant before the
    /// create. `stat`-based existence checks do not see a dangling link at all,
    /// and an `O_CREAT` without `O_EXCL` would follow it and create the file at
    /// the far end. `O_CREAT | O_EXCL` refuses in the same syscall.
    func testLeafReplacedByADanglingSymlinkJustBeforeCreateIsRefused() {
        let target = outside.appendingPathComponent("planted.txt")
        var swapped = false
        XCTAssertThrowsError(try ManifestWriter(directory: dest, files: [
            WritableFile(name: "a.txt", size: 3, path: "t/a.txt"),
        ], raceHook: { event in
            if case .beforeLeafCreate("t/a.txt") = event, !swapped {
                swapped = true
                try? FileManager.default.createSymbolicLink(
                    at: self.dest.appendingPathComponent("t/a.txt"), withDestinationURL: target)
            }
        })) { err in
            XCTAssertEqual(err as? DownloadDestinationError, .fileExists(name: "a.txt"))
        }
        XCTAssertTrue(swapped, "the test never performed the swap it is meant to test")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path),
                       "the write followed a symlink planted at the leaf")
        outsideIsUntouched("a leaf swapped mid-syscall escaped the destination")
    }

    /// The reopen-by-name bug, stated as a test.
    ///
    /// Once the leaf descriptor exists, the attacker renames the real file away
    /// and puts a symlink to `outside` under the same name. A writer that
    /// reopened the path to write — as the previous implementation did with
    /// `FileHandle(forWritingTo:)` — would now be writing through that symlink.
    /// Writing through the descriptor that `O_CREAT|O_EXCL` returned cannot be
    /// diverted: the descriptor names an inode, not a path.
    func testBytesFollowTheOpenDescriptorNotTheNameAfterItIsSwapped() throws {
        let decoy = outside.appendingPathComponent("decoy.bin")
        let moved = dest.appendingPathComponent("moved-away.bin")
        var swapped = false
        let writer = try ManifestWriter(directory: dest, files: [
            WritableFile(name: "a.bin", size: 4),
        ], raceHook: { event in
            if case .afterLeafOpen("a.bin") = event, !swapped {
                swapped = true
                // The real file goes somewhere we can still read it, and its
                // name now points outside the destination.
                try? FileManager.default.moveItem(at: self.dest.appendingPathComponent("a.bin"),
                                                  to: moved)
                try? FileManager.default.createSymbolicLink(
                    at: self.dest.appendingPathComponent("a.bin"), withDestinationURL: decoy)
            }
        })
        XCTAssertTrue(swapped, "the test never performed the swap it is meant to test")
        try writer.write([9, 8, 7, 6])
        _ = try writer.finish()

        XCTAssertFalse(FileManager.default.fileExists(atPath: decoy.path),
                       "the bytes were written through the swapped NAME, not the descriptor")
        XCTAssertEqual(try Data(contentsOf: moved), Data([9, 8, 7, 6]),
                       "the bytes must have gone to the inode that was opened")
        outsideIsUntouched("a post-open name swap escaped the destination")
    }

    // MARK: - cleanup

    /// Cleanup is walked with the same `O_NOFOLLOW` descriptors as the writes,
    /// so an ancestor swapped before `discard` cannot redirect a deletion either.
    func testCleanupCannotBeRedirectedByASwappedAncestor() throws {
        let bystander = outside.appendingPathComponent("someone-elses.txt")
        try Data("keep".utf8).write(to: bystander)
        let writer = try ManifestWriter(directory: dest, files: [
            WritableFile(name: "a.bin", size: 8, path: "t/a.bin"),
        ])
        try writer.write([1, 2, 3])          // partial: discard must clean it up
        swapDirectoryForSymlink("t")         // ... but `t` is now a symlink out
        writer.discard()
        XCTAssertEqual(try String(contentsOf: bystander), "keep",
                       "cleanup deleted through a swapped ancestor")
        XCTAssertTrue(FileManager.default.fileExists(atPath: bystander.path))
    }

    /// A directory that gained somebody else's file is not this transfer's to
    /// remove. `AT_REMOVEDIR` enforces that atomically (`ENOTEMPTY`) rather than
    /// by a check that could be lost.
    func testCleanupLeavesADirectoryThatGainedAFile() throws {
        let writer = try ManifestWriter(directory: dest, files: [
            WritableFile(name: "a.bin", size: 8, path: "t/a.bin"),
        ])
        try writer.write([1])
        try Data("theirs".utf8).write(to: dest.appendingPathComponent("t/theirs.txt"))
        writer.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.appendingPathComponent("t/a.bin").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.appendingPathComponent("t/theirs.txt").path))
    }

    /// A container is created and pinned in ONE step, and there is no longer any
    /// way to hand the writer a container by pathname — which is what removed
    /// this whole class of bug rather than guarding against it.
    ///
    /// What remains testable at the boundary: a name already occupied by a
    /// symlink is refused by the exclusive `mkdirat` itself, so nothing is ever
    /// followed through it.
    func testCreatingAContainerOverASymlinkIsRefusedNotFollowed() throws {
        let name = "relayium-sym"
        try FileManager.default.createSymbolicLink(
            at: dest.appendingPathComponent(name), withDestinationURL: outside)
        // nil == the name is taken. `mkdirat` will not adopt it, and nothing
        // reopens the name to find out what it is.
        XCTAssertNil(try createOwnedContainer(parent: dest, name: name))
        // The factory built on it turns that nil into the refusal callers see.
        XCTAssertThrowsError(try destinationDirectory(parent: dest, id: "sym")) { err in
            XCTAssertEqual(err as? DownloadDestinationError, .directoryExists(name: "relayium-sym"))
        }
        outsideIsUntouched("creating a container followed a symlink")
    }

    /// The pinned descriptor, not the name, is what the writer writes through:
    /// renaming the container away mid-transfer does not move or break the write.
    func testAPinnedContainerKeepsWorkingAfterItsNameChanges() throws {
        let container = try folderDestinationDirectory(parent: dest, preferredName: "trip")
        let writer = try ManifestWriter(container: container,
                                        files: [WritableFile(name: "a.bin", size: 2)])
        let renamed = dest.appendingPathComponent("renamed-underneath")
        try FileManager.default.moveItem(at: container.url, to: renamed)
        try writer.write([7, 8])
        _ = try writer.finish()
        XCTAssertEqual(try Data(contentsOf: renamed.appendingPathComponent("a.bin")), Data([7, 8]))
        outsideIsUntouched("a renamed container let a write escape")
    }

    // MARK: - durability

    /// A failed `fsync` is a failed file.
    ///
    /// It is how a full disk, a disconnected volume or an I/O error reaches us,
    /// and the bytes it reports on are the ones the receiver is about to tell
    /// the sender it has safely stored. Swallowing the result — as
    /// `_ = fsync(...)` did — reports a transfer complete whose file may not be
    /// on disk. The `FileHandle.synchronize()` this replaced threw.
    func testAFailedSyncFailsTheTransferAndNeverReachesSuccess() throws {
        let writer = try ManifestWriter(directory: dest, files: [
            WritableFile(name: "a.bin", size: 3, path: "t/a.bin"),
        ], syncLeaf: { _ in errno = EIO; return -1 })

        XCTAssertThrowsError(try writer.write([1, 2, 3])) { err in
            XCTAssertEqual(err as? DownloadDestinationError, .systemError(EIO),
                           "the errno has to survive the close() that follows it")
        }
        // Not merely "an error was thrown": the batch must not then be
        // completable, because a caller that ignored the throw would otherwise
        // still get URLs back.
        XCTAssertThrowsError(try writer.finish()) { err in
            XCTAssertEqual(err as? DownloadDestinationError, .incomplete)
        }
        // And cleanup still works after the failure — no leaked descriptor
        // keeps the file undeletable, and the directory it made goes too.
        writer.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.appendingPathComponent("t/a.bin").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.appendingPathComponent("t").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.path))
    }

    /// The success path still syncs — a test that only proves failures would let
    /// the barrier be removed entirely.
    func testTheDurabilityBarrierRunsOnceForEveryCompletedFile() throws {
        var synced = 0
        let writer = try ManifestWriter(directory: dest, files: [
            WritableFile(name: "a.bin", size: 2),
            WritableFile(name: "b.bin", size: 0),
            WritableFile(name: "c.bin", size: 1),
        ], syncLeaf: { fd in synced += 1; return fsync(fd) })
        try writer.write([1, 2, 3])
        _ = try writer.finish()
        // Only files with bytes get a descriptor to sync; the empty one is
        // created and closed without one.
        XCTAssertEqual(synced, 2)
    }

    // MARK: - the owned container

    /// A container swapped for somebody ELSE'S empty directory is left alone.
    ///
    /// Removing a directory means naming it in its parent — there is no
    /// "remove the directory this descriptor refers to" on macOS — so the name
    /// is checked against the descriptor's `(st_dev, st_ino)` first. Under
    /// ambiguous identity the choice is to leave a stray empty directory behind
    /// rather than delete a replacement: the second error is much worse.
    func testCleanupLeavesAReplacementContainerAlone() throws {
        let container = try folderDestinationDirectory(parent: dest, preferredName: "trip")
        let writer = try ManifestWriter(container: container,
                                        files: [WritableFile(name: "a.bin", size: 8)])
        try writer.write([1])

        // Somebody replaces our container with a different, EMPTY directory of
        // the same name. Empty is the point: `AT_REMOVEDIR` would happily remove
        // it, so only the identity check can save it.
        let stashed = dest.appendingPathComponent("stashed")
        try FileManager.default.moveItem(at: container.url, to: stashed)
        try FileManager.default.createDirectory(at: container.url, withIntermediateDirectories: false)

        writer.discard()
        XCTAssertTrue(FileManager.default.fileExists(atPath: container.url.path),
                      "cleanup deleted a directory that was no longer ours")
        // Ours is still identified by the descriptor, so its partial file went.
        XCTAssertFalse(FileManager.default.fileExists(atPath: stashed.appendingPathComponent("a.bin").path))
    }

    /// The unswapped case still cleans up, or the guard above would be a licence
    /// to leave debris everywhere.
    func testCleanupRemovesItsOwnEmptyContainer() throws {
        let container = try folderDestinationDirectory(parent: dest, preferredName: "trip")
        let writer = try ManifestWriter(container: container,
                                        files: [WritableFile(name: "a.bin", size: 8)])
        try writer.write([1])
        writer.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: container.url.path))
    }

    /// The LAST line of defence, and only that.
    ///
    /// A container replaced by a NON-EMPTY directory survives because
    /// `AT_REMOVEDIR` refuses with `ENOTEMPTY` — which is a backstop, NOT
    /// evidence that identity was checked. Stated explicitly because this test
    /// once stood in for identity coverage it does not provide: it passed
    /// unchanged against a cleanup that reopened the name and compared the
    /// replacement against itself. `testCleanupLeavesAReplacementContainerAlone`
    /// and `testAPinnedContainerIsNotConfusedWithAnEmptyReplacement` are the
    /// ones that actually test identity, because their replacement is EMPTY.
    func testANonEmptyReplacementSurvivesEvenIfIdentityWereLost() throws {
        let container = try folderDestinationDirectory(parent: dest, preferredName: "trip")
        let writer = try ManifestWriter(container: container,
                                        files: [WritableFile(name: "a.bin", size: 8)])
        try writer.write([1])
        try Data("theirs".utf8).write(to: container.url.appendingPathComponent("theirs.txt"))
        writer.discard()
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: container.url.appendingPathComponent("theirs.txt").path))
    }

    /// The case the redesign exists for: the container is swapped for a
    /// different EMPTY directory AFTER its identity was pinned but BEFORE the
    /// manifest is validated — i.e. inside the failure window that
    /// `openWriterInOwnedContainer`'s cleanup runs in.
    ///
    /// A cleanup that reopened the container's PATH at that moment would pin the
    /// replacement, compare it against itself, find it identical, and delete it.
    /// Using the descriptor pinned at creation, the identities differ and the
    /// replacement is left alone. The cost is a leaked empty directory (ours,
    /// now under no name we can reach) — deliberately the lesser error.
    func testAPinnedContainerIsNotConfusedWithAnEmptyReplacement() throws {
        let container = try destinationDirectory(parent: dest, id: "abc")
        let stashed = dest.appendingPathComponent("stashed")
        try FileManager.default.moveItem(at: container.url, to: stashed)
        // A DIFFERENT, empty directory takes the name. Nothing but the pinned
        // descriptor can tell it from ours.
        try FileManager.default.createDirectory(at: container.url, withIntermediateDirectories: false)

        // A manifest refused during validation — the failure window in question.
        XCTAssertThrowsError(try openWriterInOwnedContainer(container, files: [
            WritableFile(name: "a.txt", size: 1),
            WritableFile(name: "A.txt", size: 1),
        ]))

        XCTAssertTrue(FileManager.default.fileExists(atPath: container.url.path),
                      "cleanup deleted an empty directory that was no longer ours")
        var replacement = stat()
        var ours = stat()
        XCTAssertEqual(lstat(container.url.path, &replacement), 0)
        XCTAssertEqual(lstat(stashed.path, &ours), 0)
        XCTAssertNotEqual(replacement.st_ino, ours.st_ino,
                          "the test never actually swapped the directory")
    }

    /// The other cleanup path: a container created for a manifest that is then
    /// refused. It used to use `contentsOfDirectory` + `removeItem` — a
    /// check-then-use whose removal is RECURSIVE, so losing that race would have
    /// destroyed whatever replaced the container rather than removing an empty
    /// directory. It now goes through the same identity-checked removal.
    func testARefusedManifestDoesNotRecursivelyDeleteAReplacementContainer() throws {
        // A batch that passes size validation but is refused by the path
        // resolver, so the container exists before the refusal.
        XCTAssertThrowsError(try openReceiveWriter(parent: dest, files: [
            WritableFile(name: "a", size: 1, path: "trip/a.txt"),
            WritableFile(name: "a", size: 1, path: "trip/A.txt"),
        ], fallbackName: "relayium-x"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.appendingPathComponent("trip").path),
                       "the container it created should be gone")
        outsideIsUntouched("refusing a manifest reached outside the destination")
    }

    /// A destination the USER chose is opened without `O_NOFOLLOW`, because a
    /// user who points the app at a symlinked folder means that folder. This
    /// pins that asymmetry so it cannot be "tidied away" into a blanket refusal.
    func testAUserChosenDestinationMayItselfBeASymlink() throws {
        let real = dest.appendingPathComponent("real-folder")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: false)
        let alias = dest.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: real)

        let writer = try ManifestWriter(directory: alias, files: [WritableFile(name: "a.bin", size: 1)])
        try writer.write([5])
        _ = try writer.finish()
        XCTAssertEqual(try Data(contentsOf: real.appendingPathComponent("a.bin")), Data([5]))
    }
}

// MARK: - descriptors must not survive an exec

/// Every descriptor this app holds on a receive directory or a file inside it is
/// close-on-exec, so no child process can inherit a live handle on the user's
/// files.
///
/// The one that is easy to get wrong is the duplicate. `dup(2)` does NOT copy
/// `FD_CLOEXEC`: a descriptor opened with `O_CLOEXEC` and then `dup`ed comes back
/// INHERITABLE, silently, with nothing at the call site to suggest it. This app
/// does spawn children (Sparkle's installer runs outside the sandbox), so an
/// inherited directory handle is a real handle on a real user's files.
extension ManifestWriterRaceTests {
    /// The primitive, directly.
    func testDuplicatingADescriptorKeepsItCloseOnExec() throws {
        let original = retryOnEINTR { open(dest.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
        XCTAssertGreaterThanOrEqual(original, 0)
        defer { close(original) }
        XCTAssertNotEqual(fcntl(original, F_GETFD) & FD_CLOEXEC, 0, "precondition: O_CLOEXEC")

        let copy = dupCloseOnExec(original)
        XCTAssertGreaterThanOrEqual(copy, 0)
        defer { close(copy) }
        XCTAssertNotEqual(fcntl(copy, F_GETFD) & FD_CLOEXEC, 0,
                          "the duplicate is inheritable — a child process would get the directory")

        // And the contrast that makes the assertion mean something: a plain
        // `dup` really does lose it, so the helper is not decoration.
        let bare = retryOnEINTR { dup(original) }
        XCTAssertGreaterThanOrEqual(bare, 0)
        defer { close(bare) }
        XCTAssertEqual(fcntl(bare, F_GETFD) & FD_CLOEXEC, 0,
                       "if dup() ever starts preserving FD_CLOEXEC, the helper's reason is gone")
    }

    /// The invariant as a property of the whole live writer, not of one call:
    /// while a receive is in flight, NO descriptor in this process that points
    /// at the destination or anything under it may be inheritable.
    ///
    /// Walks the process's own open descriptors and resolves each one back to a
    /// path (`F_GETPATH`), so it covers the container dup, the destination
    /// handle and the open leaf together — including any future descriptor
    /// somebody adds without thinking about `exec`.
    func testNoLiveReceiveDescriptorIsInheritable() throws {
        let container = try folderDestinationDirectory(parent: dest, preferredName: "trip")
        let writer = try ManifestWriter(container: container,
                                        files: [WritableFile(name: "a.bin", size: 8)])
        try writer.write([1, 2, 3])          // a leaf descriptor is open right now
        defer { writer.discard() }

        // The root is derived through F_GETPATH too, not from URL
        // normalisation: the kernel answers with its own canonical form
        // (/private/var/... rather than /var/...), and comparing two different
        // spellings would silently match nothing and pass vacuously — which is
        // exactly how this test first "passed".
        let probeFD = retryOnEINTR { open(dest.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
        XCTAssertGreaterThanOrEqual(probeFD, 0)
        var rootBuffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        XCTAssertNotEqual(fcntl(probeFD, F_GETPATH, &rootBuffer), -1)
        let root = String(cString: rootBuffer)
        close(probeFD)
        var checked = 0
        var limit = rlimit()
        XCTAssertEqual(getrlimit(RLIMIT_NOFILE, &limit), 0)
        for fd in 0..<Int32(min(limit.rlim_cur, 4096)) {
            let flags = fcntl(fd, F_GETFD)
            if flags == -1 { continue }                       // not open
            var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
            guard fcntl(fd, F_GETPATH, &buffer) != -1 else { continue }
            let path = String(cString: buffer)
            guard path == root || path.hasPrefix(root + "/") else { continue }
            checked += 1
            XCTAssertNotEqual(flags & FD_CLOEXEC, 0,
                              "fd \(fd) on \(path) would be inherited by a child process")
        }
        XCTAssertGreaterThanOrEqual(checked, 2,
                                    "expected at least the container and the open leaf")
    }
}
