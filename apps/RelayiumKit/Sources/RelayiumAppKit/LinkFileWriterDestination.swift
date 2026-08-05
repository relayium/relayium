import Foundation
import RelayiumKit

/// The link driver's inbound batch, on this device's filesystem.
///
/// `LinkFileDestination` is declared in `RelayiumKit` and deliberately left
/// unimplemented there: the validated writer lives in this module, which DEPENDS
/// on that one, and a filesystem destination written on the other side of that
/// boundary would have to duplicate path validation. This is the adapter that
/// closes the seam, and it is the ONLY thing between the protocol and
/// `ManifestWriter` — every path decision, traversal refusal, collision rule and
/// cleanup below still belongs to `openReceiveWriter` and the writer itself.
///
/// ## What this actually adds
///
/// Two things the writer cannot know about, and nothing else.
///
///  1. **The boundary acknowledgement.** The wire ends each file with its own
///     DONE, so the protocol counts files; the writer counts BYTES and advances
///     itself. `openNextFile` is where the two are checked against each other.
///  2. **Terminal semantics.** Commit happens exactly once, is reported exactly
///     once, and after it no abort may touch the result. The driver already
///     serializes calls and already tries not to abort a committed destination,
///     but "the caller is careful" is not the same guarantee as "the object
///     cannot do it", and the thing at stake is deleting a file the user has
///     already been told they have.
///
/// ## Threading
///
/// The driver invokes every method on its own serial destination queue, one at a
/// time. This does not rely on that: the state machine and the writer are guarded
/// by a lock, so a mis-serialized caller gets a refusal rather than a corrupted
/// writer. `onCommitted` fires OUTSIDE the lock, because the owner it belongs to
/// will want to hop to the main actor and may well call back in — a re-entrant
/// `abort()` from inside it must find a committed destination, not a deadlock.
/// Nothing here is `@MainActor` and nothing imports SwiftUI; dispatching UI work
/// is the later owner's job.
///
/// ## Lifetime
///
/// There is no cleanup in `deinit`. An uncommitted destination is discarded when
/// its owner says so — every `releaseDestinationLocked` path in `LinkFileDriver`
/// passes `discard: true`, and a stale operation's orphan is aborted explicitly —
/// so dropping one without a decision does not happen. Deleting a user's
/// directory tree from an arbitrary thread during deallocation is a worse failure
/// than leaving a partial file behind, which is what an unreferenced writer
/// already does today.
public enum LinkFileDestinationError: Error, Equatable {
    /// A call after this destination committed or was discarded. Terminal states
    /// are absorbing: nothing reopens them.
    case notOpen
    /// A file boundary that is not the next one owed — a duplicate, a skipped
    /// index, a negative one, or one past the end of the manifest.
    case unexpectedBoundary(expected: Int, received: Int)
    /// The right boundary, too early: the bytes of the file before it have not
    /// all reached the disk.
    case boundaryNotReached(index: Int)
}

public final class LinkFileWriterDestination: LinkFileDestination, @unchecked Sendable {
    /// Terminal states are ABSORBING. `discarded` is not reachable from
    /// `committed`, which is the property that keeps a late abort from removing
    /// the user's files.
    private enum State {
        case open
        case committed
        case discarded
    }

    private let lock = NSLock()
    private let writer: ManifestWriter
    private let fileCount: Int

    private var state: State = .open
    /// The next file index this destination will accept an acknowledgement for.
    /// Starts at 1: index 0 is opened by CREATING the destination, so it never
    /// has a boundary of its own.
    private var expectedIndex = 1
    private var committed: [URL]?
    /// Cleared the moment it fires, so "exactly once" survives a repeated
    /// finalize without a second flag to keep in step.
    private var onCommitted: (([URL]) -> Void)?

    /// The directory this batch created for itself, when it needed one. Nil for a
    /// flat batch, which lands straight in the parent the user chose. Set once at
    /// creation and immutable, so a reporting owner may read it from anywhere.
    public let containerURL: URL?

    /// Where the files landed, and only once they are really the user's. Nil
    /// until `finalize()` succeeds — an incomplete or failed finalize leaves it
    /// nil, because a URL list is exactly the thing a UI would show as a result.
    public var committedURLs: [URL]? {
        lock.lock(); defer { lock.unlock() }
        return committed
    }

    /// The container name for a batch that has no single root folder.
    ///
    /// Derived from the batch id rather than random: the name is part of what an
    /// owner will show the user, and a deterministic one can be named before the
    /// transfer ends. Collisions are not this function's problem — a repeated id
    /// across links is ordinary, and `folderDestinationDirectory` steps aside to
    /// `… (2)` rather than merging into or overwriting what is there.
    public static func fallbackContainerName(batch: Int) -> String {
        "relayium-link-\(batch)"
    }

    /// Prepare a destination for one inbound batch under `parent`.
    ///
    /// Throws — and leaves nothing behind — for every manifest the writer
    /// refuses: an unsafe path, a collision, an empty or oversized manifest. That
    /// cleanup is `openReceiveWriter`'s and the writer's, not repeated here;
    /// nothing after that call can fail, so there is no partly-built adapter to
    /// unwind.
    ///
    /// `parent` must already be reachable — a security-scoped bookmark started,
    /// a Save-panel URL still valid. This does not resolve access, because the
    /// owner that chose the directory is the only thing that can hold it open.
    public init(batch: Int, files: [FileMeta], parent: URL,
                onCommitted: (([URL]) -> Void)? = nil) throws {
        // `path` carried through, not flattened to `name`: it is the folder-relative
        // path, and dropping it would put a whole received tree in one flat heap.
        let opened = try openReceiveWriter(
            parent: parent,
            files: files.map { WritableFile(name: $0.name, size: $0.size, path: $0.path) },
            fallbackName: Self.fallbackContainerName(batch: batch))
        self.writer = opened.writer
        self.containerURL = opened.container
        // The same count the writer resolved: `openReceiveWriter` only rewrites
        // paths, never adds or drops an entry. It bounds the boundary index and
        // nothing else — `finish()` is what actually refuses to commit a batch
        // that is short, so a divergence here could not turn into a false commit.
        self.fileCount = files.count
        self.onCommitted = onCommitted
    }

    public func write(_ bytes: [UInt8]) throws {
        lock.lock(); defer { lock.unlock() }
        guard state == .open else { throw LinkFileDestinationError.notOpen }
        try writer.write(bytes)
    }

    /// Acknowledge that file `index - 1` is finished and file `index` is the one
    /// the next bytes belong to.
    ///
    /// NOT a second open. The writer creates and closes files on its own as the
    /// declared byte counts are met; this only checks that the protocol's count
    /// and the writer's agree, and refuses if they do not.
    ///
    /// Two separate conditions, because they catch different lies:
    ///
    ///  - **Exactly the next index.** A duplicate would acknowledge one DONE
    ///    twice, a skip would swallow a file's DONE entirely, and a negative or
    ///    out-of-range index is arithmetic that must never reach an array. The
    ///    counter is the adapter's own, so this holds even when the writer is
    ///    already past the index in question.
    ///  - **The writer really got there.** `preparedIndex` only advances when a
    ///    file's declared bytes are all on disk, so `>= index` means file
    ///    `index - 1` is complete. Premature acknowledgement is refused.
    ///
    /// `>=`, deliberately not `==`: `openCurrent` CREATES a run of zero-length
    /// files and steps past all of them the moment it reaches them, so after one
    /// write the writer can already sit several entries ahead while the protocol
    /// still owes an ordered acknowledgement for each. Requiring equality would
    /// refuse every legitimate empty-file boundary.
    public func openNextFile(index: Int) throws {
        lock.lock(); defer { lock.unlock() }
        guard state == .open else { throw LinkFileDestinationError.notOpen }
        // `index < fileCount` also makes the last file's end unacknowledgeable:
        // that end is a COMPLETE and arrives as `finalize`, never as a boundary.
        guard index == expectedIndex, index < fileCount else {
            throw LinkFileDestinationError.unexpectedBoundary(expected: expectedIndex,
                                                              received: index)
        }
        guard writer.preparedIndex >= index else {
            throw LinkFileDestinationError.boundaryNotReached(index: index)
        }
        expectedIndex += 1
    }

    /// Commit. `finish()` is what decides: it refuses a manifest that is not
    /// fully on disk, so nothing is committed and nothing is reported until it
    /// returns.
    ///
    /// Idempotent on SUCCESS only. A replayed final DONE or a retried effect must
    /// not report a second result or re-read the filesystem, so a second finalize
    /// after a committed one returns quietly. A finalize that THREW leaves the
    /// destination open, which is what keeps an incomplete batch abortable.
    public func finalize() throws {
        lock.lock()
        switch state {
        case .discarded:
            lock.unlock()
            throw LinkFileDestinationError.notOpen
        case .committed:
            lock.unlock()          // already the user's file; nothing more to do
            return
        case .open:
            break
        }
        let urls: [URL]
        do {
            urls = try writer.finish()
        } catch {
            lock.unlock()
            throw error
        }
        state = .committed
        committed = urls
        // Taken under the lock and fired outside it: the callback belongs to an
        // owner that may hop queues and may call back in, and by the time it can
        // do so this destination is already terminal.
        let report = onCommitted
        onCommitted = nil
        lock.unlock()
        report?(urls)
    }

    /// Discard everything not committed, at most once.
    ///
    /// After a commit this does NOTHING. The driver defers a discard that races a
    /// commit and is careful not to abort a committed slot, but the consequence
    /// of getting it wrong is deleting files the user has been told they have, so
    /// the refusal lives here too.
    ///
    /// A second abort is inert for the same reason one level down: by then those
    /// names may belong to the next transfer, or to the user.
    public func abort() {
        lock.lock(); defer { lock.unlock() }
        guard state == .open else { return }
        state = .discarded
        writer.discard()
    }
}
