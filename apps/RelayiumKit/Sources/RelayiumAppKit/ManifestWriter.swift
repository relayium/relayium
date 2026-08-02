import Foundation
import Darwin
import RelayiumKit

/// Where received files land on disk, shared by both transports.
///
/// The cloud download and the realtime receive have the identical problem:
/// chunks arrive with no file boundaries, the manifest's sizes are the only
/// thing that splits them, and the names — now the whole relative paths — come
/// from the other side. Two copies of that would be two path-traversal
/// boundaries, and drift would eventually leave the bug in only one of them.

public enum DownloadDestinationError: Error, Equatable {
    case directoryExists(name: String)
    case unsafeName(String)
    case fileExists(name: String)
    case exceedsManifest
    case incomplete
    /// A syscall on the destination failed for a reason that is not one of the
    /// above — out of space, permissions, too many open files. Carries `errno`
    /// so a bug report can say which.
    case systemError(Int32)
}

/// One entry of an incoming transfer, in the only fields the writer needs.
/// Neither transport's manifest type leaks into the other through this.
///
/// `path` is the realtime side's folder-relative path (`FileMeta.path`). The
/// stored side has no separate field and keeps its hierarchy in `name`, so it
/// passes `path: nil` and the writer falls back to the name — see
/// `resolveEntries`.
public struct WritableFile: Equatable {
    public let name: String
    public let size: Int
    public let path: String?
    public init(name: String, size: Int, path: String? = nil) {
        self.name = name
        self.size = size
        self.path = path
    }
}

/// A multi-file transfer gets its own directory so it cannot scatter into an
/// existing folder or overwrite by name collision. An existing directory is
/// refused rather than merged: we cannot tell a leftover partial download from
/// files the user put there.
/// Created and PINNED: the returned handle carries the descriptor, and every
/// later operation — writing into it, removing it again — uses that descriptor
/// rather than the name. See `OwnedContainer`.
func destinationDirectory(parent: URL, id: String) throws -> OwnedContainer {
    let name = "relayium-\(id)"
    guard let container = try createOwnedContainer(parent: parent, name: name) else {
        // `mkdirat` refused because the name is taken. Atomic, unlike the
        // `fileExists`-then-create this replaced.
        throw DownloadDestinationError.directoryExists(name: name)
    }
    return container
}

/// The container a FOLDER transfer is written into, named after the folder that
/// was sent and uniquified rather than merged.
///
/// Distinct from `destinationDirectory` on purpose. That one refuses on
/// collision, which is right for an opaque `relayium-<id>` box: a second one of
/// those means something is already wrong. A folder name is not opaque —
/// receiving `photos` twice is ordinary — so this one steps aside to
/// `photos (2)` instead of failing, and NEVER merges into or deletes what is
/// already there.
///
/// Exclusive creation is the race guard: `createOwnedContainer`'s `mkdirat`
/// fails `EEXIST` rather than adopting a name that is already taken, so two
/// concurrent receives cannot both believe they own the same directory — and
/// that answer is atomic rather than a check either could lose.
func folderDestinationDirectory(parent: URL, preferredName: String,
                                limit: Int = 64) throws -> OwnedContainer {
    let segments = try? safePathSegments(preferredName)
    let base = segments?.last ?? "relayium"
    for attempt in 0..<limit {
        let name = attempt == 0 ? base : "\(base) (\(attempt + 1))"
        if let container = try createOwnedContainer(parent: parent, name: name) {
            return container
        }
        // Name taken — step aside rather than merge.
    }
    throw DownloadDestinationError.directoryExists(name: base)
}

/// Prepare where an incoming batch will be written, and open its writer.
///
/// One function so the two transports cannot disagree about what a folder
/// receive looks like. Flat batches land directly in `parent`, exactly as they
/// always have. A batch with any nested path gets its own directory, named after
/// the folder that was sent when there is one — never merged into an existing
/// directory, and never written loose into the user's Downloads where it would
/// join a folder of the same name.
///
/// `fallbackName` is used when the batch has no single root (two folders, or a
/// folder beside a loose file): there is no folder name to take, so an opaque
/// per-transfer one is the honest choice.
func openReceiveWriter(parent: URL, files: [WritableFile], fallbackName: String,
                       raceHook: ((ManifestWriterRaceEvent) -> Void)? = nil)
    throws -> (writer: ManifestWriter, container: URL?) {
    guard hasNestedPaths(files) else {
        return (try ManifestWriter(directory: parent, files: files, raceHook: raceHook), nil)
    }
    let lifted = stripCommonRoot(files)
    let container = try folderDestinationDirectory(parent: parent,
                                                   preferredName: lifted?.root ?? fallbackName)
    let writer = try openWriterInOwnedContainer(container, files: lifted?.files ?? files,
                                                raceHook: raceHook)
    return (writer, container.url)
}

/// Open a writer inside a container this transfer created moments ago, removing
/// the container again if the writer refuses the manifest.
///
/// Every caller that creates its own container must go through here. The writer's
/// own `discard` covers the failures it reaches, but a manifest refused during
/// VALIDATION throws before there is a writer at all — and the directory already
/// exists by then. Leaving the creation and the cleanup in the caller is how the
/// cloud multi-file path ended up creating `relayium-<id>` and then abandoning it
/// empty on every rejected manifest.
///
/// Cleanup goes through the descriptor pinned when the container was CREATED —
/// `container.removeIfStillOurs()` — never a fresh open of its path.
///
/// That distinction is the whole point and it is easy to lose. An earlier
/// version of this function opened `container.path` inside this very `catch`,
/// i.e. after the failure window. If the directory had been replaced by then,
/// that open pinned the REPLACEMENT, `removeDirectoryIfUnchanged` compared the
/// replacement against itself, found it identical, and deleted it — while
/// looking, in review, exactly like a careful identity check. The only thing
/// that saved the non-empty case was `ENOTEMPTY`, which is luck, not a
/// guarantee. Under ambiguous identity the rule is to LEAK an empty directory,
/// never to delete a replacement.
func openWriterInOwnedContainer(_ container: OwnedContainer, files: [WritableFile],
                                raceHook: ((ManifestWriterRaceEvent) -> Void)? = nil) throws -> ManifestWriter {
    do {
        return try ManifestWriter(container: container, files: files, raceHook: raceHook)
    } catch {
        container.removeIfStillOurs()
        throw error
    }
}


/// Splits an incoming chunk stream back into the manifest's files. Chunks do
/// not carry file boundaries; the manifest's sizes are the only thing that does.
///
/// Every filesystem operation below the destination is descriptor-relative —
/// see `DirectoryDescriptor.swift` for why a path-based writer cannot be made
/// safe here. In short: this writer opens the destination once, walks each
/// component with `O_NOFOLLOW | O_DIRECTORY`, creates the leaf with
/// `O_CREAT | O_EXCL | O_NOFOLLOW`, and writes through the descriptor that call
/// returned.
///
/// The precise claim is narrower than "no name is ever looked up twice", which
/// would be false: creating a directory really does name it twice, `mkdirat`
/// then `openat`. `mkdirat` is exclusive, so it cannot adopt something already
/// there, and the `openat` behind it carries `O_NOFOLLOW | O_DIRECTORY`, so a
/// SYMLINK or a file swapped into that gap fails the open — though a real
/// directory swapped into it does not, and would be written into instead of
/// ours. The leaf is genuinely single-lookup: `O_CREAT | O_EXCL` decides and
/// takes the name in one syscall, and every byte afterwards goes through that
/// descriptor.
///
/// What that adds up to is stated once, on `DirectoryDescriptor.swift`, and
/// stated narrowly: path lookups cannot be redirected. It is deliberately NOT
/// "never a write outside the destination" — an actor who can rename the
/// destination moves the inode, and the descriptor follows it.
final class ManifestWriter {
    private let directory: URL
    /// True when `directory` was created by this transfer and nothing else has
    /// ever been in it, so `discard` may remove it. False for a destination the
    /// user chose (Downloads, a Save panel folder) — that one is never removed,
    /// whatever happens.
    private let ownsDirectory: Bool
    /// Test-only. Fired immediately before the syscall each case names, so a
    /// test can perform the worst-case swap in exactly the window an attacker
    /// would have to win. Nil in production.
    private let raceHook: ((ManifestWriterRaceEvent) -> Void)?
    /// Test-only substitute for the durability barrier, so a sync FAILURE can be
    /// exercised deterministically. Production always uses `fsync`.
    private let syncLeaf: (Int32) -> Int32

    /// The destination, held open for this writer's whole life. Every other
    /// descriptor is reached from this one, which is what confines the writer:
    /// a name swapped afterwards cannot move an operation already anchored here.
    private var rootFD: Int32 = -1
    /// The file currently being written. Obtained from the `O_CREAT | O_EXCL`
    /// call that created it and used directly — never reopened by pathname,
    /// because a reopen is a second lookup of a name that may no longer mean
    /// what it did.
    private var leafFD: Int32 = -1

    private var index = 0
    private var writtenInCurrent = 0
    /// `var`, not `let`, so the initializer can finish initialising `self`
    /// before the manifest is validated, which lets a validation failure reach
    /// `discard()` instead of throwing out of a half-initialised `self`. That is
    /// one of two redundant cleanup paths, not the load-bearing one — see the
    /// designated initialiser.
    private var entries: [ResolvedEntry] = []
    private(set) var urls: [URL] = []
    /// Segment paths of the subdirectories this writer created, in creation
    /// order. Only these are removed on failure — a directory that was already
    /// there is not this transfer's to delete.
    private var createdDirectories: [[String]] = []

    /// Writes into a destination the USER chose (Downloads, a Save-panel
    /// folder). Opened here by path, because the user's own directory is the one
    /// thing this transfer did not create and cannot have pinned earlier.
    convenience init(directory: URL, files: [WritableFile],
                     raceHook: ((ManifestWriterRaceEvent) -> Void)? = nil,
                     syncLeaf: @escaping (Int32) -> Int32 = { fsync($0) }) throws {
        let fd = openDestinationDirectory(directory)
        guard fd >= 0 else { throw DownloadDestinationError.systemError(errno) }
        try self.init(directory: directory, rootFD: fd, ownsDirectory: false,
                      files: files, raceHook: raceHook, syncLeaf: syncLeaf)
    }

    /// Writes into a container THIS transfer created, using the descriptor
    /// pinned at creation.
    ///
    /// Not reopened by pathname, on success or on failure: the descriptor is
    /// what makes "the directory we created" a stable identity, and re-resolving
    /// the name would ask "what is at this name now" — the question whose answer
    /// an attacker controls. `dup` gives this writer its own descriptor for the
    /// same open file description, so ownership is unambiguous while the
    /// identity stays the container's.
    convenience init(container: OwnedContainer, files: [WritableFile],
                     raceHook: ((ManifestWriterRaceEvent) -> Void)? = nil,
                     syncLeaf: @escaping (Int32) -> Int32 = { fsync($0) }) throws {
        // `dupCloseOnExec`, never bare `dup`: a plain duplicate loses
        // FD_CLOEXEC, so this descriptor on the user's receive directory would
        // be inherited by any child process the app spawns.
        let fd = dupCloseOnExec(container.fd)
        guard fd >= 0 else { throw DownloadDestinationError.systemError(errno) }
        try self.init(directory: container.url, rootFD: fd, ownsDirectory: true,
                      files: files, raceHook: raceHook, syncLeaf: syncLeaf)
    }

    /// `rootFD` is taken over by this writer, which closes it.
    ///
    /// Every stored property is initialised BEFORE the manifest is validated, so
    /// a validation failure can reach `discard()` rather than throwing out of a
    /// half-initialised `self`. That makes the writer self-sufficient: it cleans
    /// up whatever it created, including an owned container, on every failure it
    /// can reach.
    ///
    /// It is not the only guarantee — `openWriterInOwnedContainer` also removes
    /// the container if this throws — and the two are deliberately redundant.
    /// Neither is load-bearing alone, which is why removing this ordering does
    /// not by itself leak a container.
    private init(directory: URL, rootFD: Int32, ownsDirectory: Bool,
                 files: [WritableFile],
                 raceHook: ((ManifestWriterRaceEvent) -> Void)?,
                 syncLeaf: @escaping (Int32) -> Int32) throws {
        self.directory = directory
        self.ownsDirectory = ownsDirectory
        self.raceHook = raceHook
        self.syncLeaf = syncLeaf
        self.rootFD = rootFD
        do {
            // Sizes/count first, then paths: an oversized or malformed manifest
            // should not even reach the path resolver.
            try validateManifestFiles(files.map { ManifestFile(name: $0.name, size: $0.size) })
            entries = try resolveEntries(files)
            try preflightDestinations()
            try openCurrent()
        } catch {
            discard()
            closeRoot()
            throw error
        }
    }

    convenience init(directory: URL, manifest: StoredManifest) throws {
        try self.init(directory: directory,
                      files: manifest.files.map { WritableFile(name: $0.name, size: $0.size) })
    }

    deinit {
        if leafFD >= 0 { close(leafFD) }
        closeRoot()
    }

    private func closeRoot() {
        if rootFD >= 0 { close(rootFD); rootFD = -1 }
    }

    // MARK: - descriptor-relative traversal

    /// Runs `body` with an open descriptor for the directory `segments` name,
    /// relative to the destination.
    ///
    /// Every component is opened `O_NOFOLLOW | O_DIRECTORY` from the previous
    /// component's descriptor, so no component can be a symlink and none can be
    /// resolved against a name that changed after it was opened. Returns nil
    /// when `create` is false and some component does not exist — for the
    /// preflight that means "nothing can already be there".
    ///
    /// Exactly one directory descriptor is held at a time, whatever the tree
    /// looks like, so a thousand-file manifest costs one descriptor rather than
    /// one per directory. The chain is re-walked per entry; `openat` on an
    /// already-cached inode is cheap, and a cache here would be one more piece
    /// of state that could go stale against the filesystem.
    @discardableResult
    private func withDirectory<R>(_ segments: [String], create: Bool,
                                  _ body: (Int32) throws -> R) throws -> R? {
        guard !segments.isEmpty else { return try body(rootFD) }
        var fd: Int32 = -1
        defer { if fd >= 0 { close(fd) } }
        var walked: [String] = []
        for segment in segments {
            walked.append(segment)
            let relative = walked.joined(separator: "/")
            let opened: (fd: Int32, created: Bool)?
            do {
                opened = try openSubdirectory(
                    parent: fd >= 0 ? fd : rootFD, name: segment, create: create,
                    // Fires between `mkdirat` and `openat` — the only window
                    // there is. See `openSubdirectory`.
                    beforeOpen: { self.raceHook?(.beforeDirectoryOpen(relative)) })
            } catch let e as DownloadDestinationError {
                throw Self.mapDirectoryFailure(e, relative: relative)
            }
            guard let opened else { return nil }
            if opened.created { createdDirectories.append(walked) }
            if fd >= 0 { close(fd) }
            fd = opened.fd
        }
        return try body(fd)
    }

    /// A component that is a symlink (`ELOOP`) or not a directory (`ENOTDIR`)
    /// is the traversal refusal users need named; anything else is a real
    /// system failure and stays one.
    private static func mapDirectoryFailure(_ e: DownloadDestinationError,
                                            relative: String) -> DownloadDestinationError {
        guard case let .systemError(code) = e else { return e }
        return (code == ELOOP || code == ENOTDIR) ? .unsafeName(relative) : e
    }

    // MARK: - preflight

    /// Nothing is created here. Resolve every destination and refuse the whole
    /// batch if any of them is already taken, so a collision is discovered
    /// before the first file exists rather than after half of them do.
    ///
    /// This is a courtesy, not the safety property: `openat(O_CREAT|O_EXCL)`
    /// below is what actually makes taking a name atomic. The preflight exists
    /// so a batch that cannot possibly land refuses before touching the disk at
    /// all.
    private func preflightDestinations() throws {
        for entry in entries {
            let leaf = entry.segments[entry.segments.count - 1]
            // `fstatat(AT_SYMLINK_NOFOLLOW)`, not an existence test: a DANGLING
            // symlink at the leaf does not "exist" by that measure, and creating
            // through it would write wherever it points.
            let taken = try withDirectory(Array(entry.directorySegments), create: false) { parent in
                statAt(parent: parent, name: leaf) != nil
            }
            if taken == true {
                throw DownloadDestinationError.fileExists(name: entry.segments.joined(separator: "/"))
            }
        }
    }

    /// Lexical join, for the URLs handed to Finder and the models. Purely a
    /// display path: nothing is opened through it. The prefix guard is the
    /// backstop that says the segments really are relative.
    private func join(_ segments: [String]) throws -> URL {
        var url = directory
        for segment in segments { url = url.appendingPathComponent(segment) }
        guard url.standardized.path.hasPrefix(directory.standardized.path + "/") else {
            throw DownloadDestinationError.unsafeName(segments.joined(separator: "/"))
        }
        return url
    }

    // MARK: - writing

    private func openCurrent() throws {
        // Zero-length files still get created: they are in the manifest, so
        // their absence would read as a failed download.
        while index < entries.count {
            let entry = entries[index]
            let leaf = entry.segments[entry.segments.count - 1]
            let relative = entry.segments.joined(separator: "/")
            let opened = try withDirectory(Array(entry.directorySegments), create: true) { parent -> Int32 in
                self.raceHook?(.beforeLeafCreate(relative))
                do {
                    return try createLeafFile(parent: parent, name: leaf)
                } catch let e as DownloadDestinationError {
                    // `O_EXCL` refuses an existing name — including a symlink,
                    // dangling or otherwise — in the same call that would have
                    // created the file.
                    if case let .systemError(code) = e, code == EEXIST {
                        throw DownloadDestinationError.fileExists(name: leaf)
                    }
                    if case let .systemError(code) = e, code == ELOOP {
                        throw DownloadDestinationError.unsafeName(relative)
                    }
                    throw e
                }
            }
            // `create: true` never returns nil; treat the impossible as a refusal
            // rather than force-unwrapping into a crash.
            guard let fd = opened else { throw DownloadDestinationError.unsafeName(relative) }
            raceHook?(.afterLeafOpen(relative))
            urls.append(try join(entry.segments))
            writtenInCurrent = 0
            if entry.size > 0 {
                leafFD = fd
                return
            }
            close(fd)          // empty file: created, nothing to write, move on
            index += 1
        }
        leafFD = -1
    }

    /// Flush the finished file to stable storage, then close it.
    ///
    /// A failed `fsync` is a FAILED FILE, not a detail to swallow. It is how a
    /// full disk, a disconnected volume or an I/O error reaches us, and the
    /// bytes it reports on are the ones the receiver is about to tell the sender
    /// it has safely stored. Ignoring the result — as `_ = fsync(...)` did —
    /// turns that into a transfer reported as complete whose file may not be on
    /// disk at all. `FileHandle.synchronize()`, which this replaced, threw.
    ///
    /// `errno` is read on the line after the call: anything else in between,
    /// including `close`, can overwrite it.
    private func closeFinishedLeaf() throws {
        guard leafFD >= 0 else { return }
        let failed = retryOnEINTR { syncLeaf(leafFD) } != 0
        let code = errno
        close(leafFD)
        leafFD = -1
        if failed { throw DownloadDestinationError.systemError(code) }
    }

    func write(_ bytes: [UInt8]) throws {
        guard !bytes.isEmpty else { return }
        guard index < entries.count else { throw DownloadDestinationError.exceedsManifest }
        var off = 0
        while off < bytes.count, index < entries.count {
            let remaining = entries[index].size - writtenInCurrent
            let take = min(remaining, bytes.count - off)
            if take > 0 {
                guard leafFD >= 0 else { throw DownloadDestinationError.incomplete }
                try writeAll(leafFD, bytes[off..<(off + take)])
                writtenInCurrent += take
                off += take
            }
            if writtenInCurrent >= entries[index].size {
                try closeFinishedLeaf()
                index += 1
                try openCurrent()
            }
        }
        if off != bytes.count { throw DownloadDestinationError.exceedsManifest }
    }

    func finish() throws -> [URL] {
        guard index == entries.count, leafFD < 0 else {
            throw DownloadDestinationError.incomplete
        }
        return urls
    }

    /// Undo everything this writer put on disk, and nothing else.
    ///
    /// Confined the same way the writes were: every removal is `unlinkat`
    /// against a descriptor walked from the destination with `O_NOFOLLOW`, so
    /// cleanup cannot be redirected outside it either. Directories go through
    /// `AT_REMOVEDIR`, which the kernel refuses with `ENOTEMPTY` if anything is
    /// inside — that is the "only while empty" rule, enforced atomically rather
    /// than by a check this could lose a race on.
    ///
    /// `directory` itself is removed only when this transfer created it
    /// (`ownsDirectory`); a destination the user chose is never deleted, however
    /// this transfer ended.
    func discard() {
        if leafFD >= 0 { close(leafFD); leafFD = -1 }
        guard rootFD >= 0 else { urls = []; createdDirectories = []; return }
        // Files first, newest first, so the directories below can empty out.
        for i in stride(from: urls.count - 1, through: 0, by: -1) {
            let segments = entries[i].segments
            _ = try? withDirectory(Array(segments.dropLast()), create: false) { parent in
                removeAt(parent: parent, name: segments[segments.count - 1], isDirectory: false)
            }
        }
        urls = []
        for segments in createdDirectories.reversed() {
            _ = try? withDirectory(Array(segments.dropLast()), create: false) { parent in
                removeAt(parent: parent, name: segments[segments.count - 1], isDirectory: true)
            }
        }
        createdDirectories = []
        // The container this transfer created, removed only if the name still
        // refers to the directory `rootFD` was opened on. `removeDirectoryIfUnchanged`
        // documents exactly what that does and does not guarantee — in
        // particular that a container swapped for somebody else's empty
        // directory is LEFT ALONE rather than deleted.
        if ownsDirectory { removeDirectoryIfUnchanged(fd: rootFD, at: directory) }
    }
}
