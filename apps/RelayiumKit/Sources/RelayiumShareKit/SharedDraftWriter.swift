import Foundation

/// One draft being assembled, and the OWNER of the directory it is assembled in.
///
/// A class, not a struct, because ownership has to be releasable exactly once and
/// **by ARC**. When the user swipes the sheet away or the host tears the
/// extension's view controller down, no button is pressed and no completion
/// handler runs; `deinit` is the cleanup hook that still fires, and without it a
/// cancelled share would leave a partial copy of the user's files in a container
/// nothing ever looks at. Same reason `PhotoCandidate` is a class.
///
/// **`deinit` is not a force-quit hook and this comment used to say it was.**
/// Nothing in this process runs when it is killed outright — no `deinit`, no
/// `defer`, no atexit. Bytes left by a terminated extension are cleaned up by
/// `SharedDraftStore.sweepIncomplete`, which is the only mechanism that can be,
/// because it runs in a later process.
///
/// Every filesystem operation happens under `lock`, so `abandon()` and `deinit`
/// cannot delete the bytes out from under an `adopt` that is still copying them.
/// **Cancellation deliberately does not use that lock** — see `cancel()`.
public final class SharedDraftWriter: @unchecked Sendable {
    public let id: String

    /// Peak bytes held while copying. Staging a 4 GB video must not put 4 GB in
    /// an app extension's memory, and a bound nobody measures is a bound nobody
    /// keeps.
    public private(set) var copyBufferPeak = 0

    private let store: SharedDraftStore
    private let staging: URL
    private let createdAt: Int64
    private let fileManager: FileManager
    /// Ownership of the staging directory and of the file list. Held for the
    /// whole of an `adopt`, which is to say for the whole of a copy.
    private let lock = NSRecursiveLock()
    /// Cancellation, and NOTHING else.
    ///
    /// A second, separate lock, held for a single load or store and never across
    /// any filesystem work. That separation is the point: `lock` above is held
    /// for the entire streamed copy of a shared file, so a cancellation flag
    /// guarded by it could not be *set* until the copy it was meant to stop had
    /// already finished. On a large video that made Cancel a button that did
    /// nothing for a minute and then reported success.
    private let cancelLock = NSLock()

    private var files: [SharedDraftFile] = []
    private var names = Set<String>()
    private var released = false
    private var _cancelled = false

    init(id: String, store: SharedDraftStore, staging: URL,
         createdAt: Int64, fileManager: FileManager) {
        self.id = id
        self.store = store
        self.staging = staging
        self.createdAt = createdAt
        self.fileManager = fileManager
    }

    /// How many files have been staged so far. Read by the extension's progress
    /// label, which is why it is published state rather than a count the view
    /// keeps its own copy of.
    public var stagedCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return files.count
    }

    /// Copy one shared root — a regular file or a directory — into this draft,
    /// **right now**.
    ///
    /// This is called from inside `NSItemProvider.loadFileRepresentation`'s
    /// completion handler, and that is the whole reason it is synchronous: the
    /// provider deletes its temporary representation the moment that handler
    /// returns, so a copy that had been dispatched elsewhere would be racing a
    /// deletion for the user's file. Nothing here awaits.
    ///
    /// `rootName` is the leaf the shared item will be sent under. Sanitized to a
    /// single path component, because a provider's suggested name is whatever
    /// the source app wrote and a separator in it would put this draft's bytes
    /// outside its own directory.
    public func adopt(_ url: URL, suggestedName: String) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !released else { throw SharedDraftError.cancelled }
        try checkCancelled()

        let rootName = sanitizedRootName(suggestedName.isEmpty ? url.lastPathComponent
                                                               : suggestedName)
        guard !rootName.isEmpty else {
            throw SharedDraftWalkError.unreadable(url.lastPathComponent)
        }
        switch try classify(url, describedAs: rootName) {
        case .symlink:
            throw SharedDraftWalkError.symbolicLink(rootName)
        case .file:
            try stage(url, as: rootName)
        case .directory:
            let before = files.count
            try walk(url, prefix: rootName)
            // A folder with nothing in it cannot be described by either wire
            // format, so it is not silently accepted as an empty draft.
            guard files.count > before else {
                throw SharedDraftWalkError.unreadable(rootName)
            }
        }
    }

    /// Publish everything staged so far.
    ///
    /// The plan is the last thing written INSIDE the staging directory, and the
    /// whole directory is then renamed into the published root in one atomic
    /// step — so a reader sees either no draft or a complete one. See
    /// `SharedDraftStore.publish`.
    public func publish() throws -> SharedDraftPlan {
        lock.lock()
        defer { lock.unlock() }
        guard !released else { throw SharedDraftError.cancelled }
        try checkCancelled()
        guard !files.isEmpty else { throw SharedDraftError.nothingUsable }
        let plan = try store.publish(id: id, staging: staging, files: files, createdAt: createdAt)
        // The directory belongs to the published draft now, so this writer must
        // never delete it — including from `deinit`.
        released = true
        return plan
    }

    /// The user backed out, a copy failed, or this writer was simply dropped.
    /// Idempotent and safe from any thread.
    public func abandon() {
        lock.lock()
        defer { lock.unlock() }
        guard !released else { return }
        released = true
        try? fileManager.removeItem(at: staging)
    }

    /// Ask an in-flight `adopt` to stop between chunks.
    ///
    /// A flag rather than `Task.cancel()`: the copy runs inside a provider's
    /// completion handler on a thread with no task context at all, so
    /// `Task.isCancelled` there is simply false. This is the only cancellation
    /// signal that reaches the loop that is actually holding the bytes.
    ///
    /// **It takes `cancelLock` and never `lock`, and it does no filesystem work
    /// at all** — so it returns immediately however large the file being copied
    /// is, and it may be called from the main actor while a copy is running. The
    /// copy itself is what abandons the bytes, once it observes this. A caller
    /// that also deleted the staging directory from here would be deleting bytes
    /// a live copy still owns.
    public func cancel() {
        cancelLock.lock()
        _cancelled = true
        cancelLock.unlock()
    }

    /// Whether cancellation has been asked for. Read between chunks, so it must
    /// be cheap and must not require the copy's own lock.
    public var isCancelled: Bool {
        cancelLock.lock()
        defer { cancelLock.unlock() }
        return _cancelled
    }

    private func checkCancelled() throws {
        if isCancelled { throw SharedDraftError.cancelled }
    }

    /// Last resort, for a writer that is simply dropped. It is not, and cannot
    /// be, cleanup for a process the system kills — nothing runs then.
    deinit { abandon() }

    // MARK: - the walk

    private enum Kind { case file, directory, symlink }

    /// lstat semantics: `attributesOfItem` does NOT resolve a final symlink,
    /// which is what makes the symlink refusal meaningful.
    private func classify(_ url: URL, describedAs name: String) throws -> Kind {
        let attributes: [FileAttributeKey: Any]
        do { attributes = try fileManager.attributesOfItem(atPath: url.path) }
        catch { throw SharedDraftWalkError.unreadable(name) }
        switch attributes[.type] as? FileAttributeType {
        case .typeSymbolicLink?: return .symlink
        case .typeDirectory?: return .directory
        case .typeRegular?: return .file
        default:
            // Sockets, FIFOs, devices: not something a transfer can carry, and a
            // FIFO in particular would block the copy below forever.
            throw SharedDraftWalkError.unreadable(name)
        }
    }

    /// Deterministic and locale-independent, exactly as `expandSelection` walks
    /// a picked folder: entries sorted by their UTF-8 bytes, directories recursed
    /// at the position they sort into, so one tree always produces one order.
    private func walk(_ directory: URL, prefix: String) throws {
        let children: [URL]
        do {
            children = try fileManager.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil, options: [])
        } catch {
            throw SharedDraftWalkError.unreadable(prefix)
        }
        let sorted = children.sorted {
            Array($0.lastPathComponent.utf8)
                .lexicographicallyPrecedes(Array($1.lastPathComponent.utf8))
        }
        for child in sorted {
            try checkCancelled()
            let relative = "\(prefix)/\(child.lastPathComponent)"
            switch try classify(child, describedAs: relative) {
            case .symlink:
                throw SharedDraftWalkError.symbolicLink(relative)
            case .file:
                try stage(child, as: relative)
            case .directory:
                try walk(child, prefix: relative)
            }
        }
    }

    // MARK: - the copy

    /// One regular file, copied in bounded chunks, then made read-only.
    private func stage(_ source: URL, as name: String) throws {
        try checkCancelled()
        guard files.count < SHARED_DRAFT_MAX_FILES else {
            throw SharedDraftWalkError.tooManyFiles(SHARED_DRAFT_MAX_FILES)
        }
        guard validManifestName(name) else { throw SharedDraftWalkError.pathTooLong(name) }
        // Refused rather than renamed. Two shared items landing on one manifest
        // path is a transfer the receiving side would reject anyway, and picking
        // a new name for one of them would send a file under a name the user
        // never saw.
        guard names.insert(name).inserted else { throw SharedDraftError.duplicatePath(name) }

        let index = files.count
        let destination = staging
            .appendingPathComponent("staged", isDirectory: true) // nonlocalized: a directory name
            .appendingPathComponent(String(index))
        do {
            let written = try copy(source, to: destination, named: name)
            try fileManager.setAttributes([.posixPermissions: 0o400],
                                          ofItemAtPath: destination.path)
            files.append(SharedDraftFile(name: name, size: written, staged: String(index)))
        } catch {
            names.remove(name)
            try? fileManager.removeItem(at: destination)
            throw error
        }
    }

    /// Streamed, never `Data(contentsOf:)`.
    ///
    /// The size is what the copy actually wrote rather than what `stat` said
    /// before it started: a provider's temporary file is not something this
    /// process controls, and a plan whose declared size disagrees with the bytes
    /// on disk is a draft the app would refuse at `verifyStaging` after the user
    /// had already been told it was ready.
    private func copy(_ source: URL, to destination: URL, named name: String) throws -> Int {
        guard fileManager.createFile(atPath: destination.path, contents: nil) else {
            throw SharedDraftError.storageFailed
        }
        let reader: FileHandle
        do { reader = try FileHandle(forReadingFrom: source) }
        catch { throw SharedDraftWalkError.unreadable(name) }
        defer { try? reader.close() }
        let writer: FileHandle
        do { writer = try FileHandle(forWritingTo: destination) }
        catch { throw SharedDraftError.storageFailed }
        defer { try? writer.close() }

        var written = 0
        while true {
            try checkCancelled()
            let chunk: Data?
            do { chunk = try reader.read(upToCount: SHARED_DRAFT_COPY_CHUNK) }
            catch { throw SharedDraftWalkError.unreadable(name) }
            guard let chunk, !chunk.isEmpty else { break }
            copyBufferPeak = max(copyBufferPeak, chunk.count)
            do { try writer.write(contentsOf: chunk) }
            catch { throw SharedDraftError.storageFailed }
            let (sum, overflow) = written.addingReportingOverflow(chunk.count)
            guard !overflow else { throw SharedDraftError.storageFailed }
            written = sum
        }
        do { try writer.close() } catch { throw SharedDraftError.storageFailed }
        return written
    }
}

/// A provider's suggested name, reduced to one path component this draft can
/// carry.
///
/// The leaf only, then the characters a file name may not hold. An empty result
/// is returned as empty rather than replaced with a made-up stem: the caller
/// turns that into a refusal naming the item, which is more honest than sending
/// somebody's file as `file`.
func sanitizedRootName(_ suggested: String) -> String {
    var name = (suggested as NSString).lastPathComponent
    name = String(name.unicodeScalars.filter { scalar in
        !CharacterSet.controlCharacters.contains(scalar) && scalar != "/" && scalar != ":"
    })
    name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard name != ".", name != ".." else { return "" }
    return name
}
