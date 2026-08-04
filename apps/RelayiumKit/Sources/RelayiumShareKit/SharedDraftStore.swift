import Foundation

/// The staged bytes of every shared draft, and the plans that describe them.
///
/// The whole point is the ORDER, and it is stricter than `PendingUploadStore`'s
/// because two PROCESSES read this directory rather than one. Bytes are copied
/// into `staging/<id>`, the plan is written atomically and LAST *inside that
/// staging directory*, and only then is the whole directory renamed into the
/// published root. A reader therefore sees either no directory at all or a
/// complete one — there is no instant at which a published directory exists
/// without its plan, which is what a plan-written-after-the-rename design would
/// have created and what the app's own sweep would then have deleted.
///
/// The lock below is this process's own concurrent tasks and NOTHING ELSE. It
/// is not, and cannot be, a cross-process lock: the extension and the app are
/// separate processes with separate `SharedDraftStore` instances. Every
/// cross-process property here is carried by the filesystem's own atomicity —
/// `rename(2)` for publication, an atomic write for the plan and for a
/// tombstone — rather than by mutual exclusion.
///
/// **Nothing here expires a complete draft.** No TTL, no sweep of published
/// work, no "it has been a week". The user shared those files deliberately and
/// the app told them the draft stays on this device; deleting it on a timer
/// would be this product losing something the user asked it to hold. The sweep
/// removes only work that is *provably* incomplete, and it will not delete a
/// directory whose plan is merely unreadable — see `sweepIncomplete`.
public final class SharedDraftStore: @unchecked Sendable {
    /// `<App Group container>/SharedDrafts` in production; a temporary directory
    /// under test. Injected rather than resolved, which is what lets `swift test`
    /// drive every path below with no entitlement and no container.
    public let root: URL
    private let fileManager: FileManager
    private let lock = NSRecursiveLock()

    public init(root: URL, fileManager: FileManager = .default) {
        self.root = root
        self.fileManager = fileManager
    }

    /// The production store, or a refusal. See `AppGroup`.
    public static func shared(_ fileManager: FileManager = .default) throws -> SharedDraftStore {
        SharedDraftStore(root: try AppGroup.sharedDraftRoot(fileManager), fileManager: fileManager)
    }

    // MARK: - locations

    public func draftURL(id: String) -> URL {
        root.appendingPathComponent(id, isDirectory: true)
    }

    func planURL(id: String) -> URL {
        planURL(in: draftURL(id: id))
    }

    func planURL(in directory: URL) -> URL {
        directory.appendingPathComponent(planFileName)
    }

    func stagedRoot(id: String) -> URL {
        stagedRoot(in: draftURL(id: id))
    }

    func stagedRoot(in directory: URL) -> URL {
        directory.appendingPathComponent(stagedDirectoryName, isDirectory: true)
    }

    /// `<root>/staging` — where a preparation assembles a draft before it is
    /// published, and one of the two directories a reader ignores by name.
    ///
    /// A draft is published by writing its plan here and then renaming the whole
    /// directory out, so a preparation in flight is never a directory a reader
    /// has to reason about at all.
    var stagingRoot: URL {
        root.appendingPathComponent(stagingDirectoryName, isDirectory: true)
    }

    /// `<root>/retired` — one empty marker file per draft the app has finished
    /// with, and the other directory a reader ignores by name.
    ///
    /// This is the LOGICAL half of removal, and it exists because the physical
    /// half can fail. Once an account-bound upload job and its Keychain content
    /// key are both durable, the draft it was copied out of must never be
    /// offered again — an `unlink` that returns `EPERM` is not permission to
    /// send the user's files a second time. So the marker is written FIRST, and
    /// every reader treats a marked id as gone whether or not its bytes are.
    /// `retryRetirements` finishes the physical half on a later launch.
    var retiredRoot: URL {
        root.appendingPathComponent(retiredDirectoryName, isDirectory: true)
    }

    private let planFileName = "draft.json"            // nonlocalized: a file name
    private let stagedDirectoryName = "staged"         // nonlocalized: a directory name
    private let stagingDirectoryName = "staging"       // nonlocalized: a directory name
    private let retiredDirectoryName = "retired"       // nonlocalized: a directory name

    /// The most a plan document may occupy before it is refused unread.
    ///
    /// A thousand files at a kilobyte of manifest name each is a legitimate
    /// megabyte, so the bound is loose — but it is a bound, and it is applied
    /// from `lstat` before a byte is read. Without it, any process in the group
    /// could make this one allocate whatever it wrote.
    private let maxPlanBytes = 4 * 1024 * 1024

    /// The staged file for one entry, refused if the name could reach anything
    /// other than a direct child of `directory/staged`.
    func stagedURL(in directory: URL, staged: String) throws -> URL {
        guard !staged.isEmpty, staged.count <= 16,
              staged.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            throw SharedDraftError.storageFailed
        }
        let base = stagedRoot(in: directory).standardizedFileURL
        let url = base.appendingPathComponent(staged).standardizedFileURL
        guard url.deletingLastPathComponent().path == base.path else {
            throw SharedDraftError.storageFailed
        }
        return url
    }

    func stagedURL(id: String, staged: String) throws -> URL {
        guard SharedDraftID.isValid(id) else { throw SharedDraftError.storageFailed }
        return try stagedURL(in: draftURL(id: id), staged: staged)
    }

    // MARK: - path trust
    //
    // Every one of these uses `attributesOfItem`, which has lstat semantics: it
    // does NOT resolve a final symlink. That is the whole reason they exist. The
    // App Group container is writable by both processes in the group, and a
    // reader that opened `<draft>/draft.json` without asking what it is would
    // follow a link out of the store — and a sweep that removed what it found
    // there would delete the target rather than the link.

    private func kind(of url: URL) -> FileAttributeType? {
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path) else {
            return nil
        }
        return attributes[.type] as? FileAttributeType
    }

    /// A real directory, not a symlink to one.
    private func isRealDirectory(_ url: URL) -> Bool { kind(of: url) == .typeDirectory }

    // MARK: - writing

    /// Begin one draft. The returned writer owns its directory until it is
    /// published or abandoned — including if it is simply dropped.
    public func beginDraft(now: Date = Date()) throws -> SharedDraftWriter {
        lock.lock()
        defer { lock.unlock() }
        let id = SharedDraftID.make()
        let staging = stagingRoot.appendingPathComponent(id, isDirectory: true)
        do {
            try fileManager.createDirectory(at: stagedRoot(in: staging),
                                            withIntermediateDirectories: true)
            // Set before a byte lands in it, and it survives the publish rename
            // because it is an attribute of the directory itself. These are
            // copies of files the user already has; restoring them onto another
            // device is not something anybody asked for.
            var excluded = staging
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try excluded.setResourceValues(values)
            guard try excluded.resourceValues(forKeys: [.isExcludedFromBackupKey])
                .isExcludedFromBackup == true else {
                throw SharedDraftError.storageFailed
            }
        } catch {
            try? fileManager.removeItem(at: staging)
            throw SharedDraftError.storageFailed
        }
        return SharedDraftWriter(id: id, store: self, staging: staging,
                                 createdAt: Int64(now.timeIntervalSince1970),
                                 fileManager: fileManager)
    }

    /// Publish a finished preparation: verify it, describe it, then rename the
    /// COMPLETE directory into place in one atomic step.
    ///
    /// The order is the cross-process property. The plan is written inside
    /// `staging/<id>` — a directory no reader in either process looks at — and
    /// the last thing that happens is `rename(2)`, which is atomic. There is
    /// therefore no instant in which a published directory lacks its plan, so
    /// the app's sweep cannot catch a publication in flight, and a reader
    /// enumerating the root mid-publish sees either nothing or a whole draft.
    ///
    /// The earlier shape — rename first, plan second — had exactly that window,
    /// and the app's launch sweep deletes plan-less published directories. Two
    /// processes, one of them deleting what the other was in the middle of
    /// writing, is not something a lock in either could have fixed.
    func publish(id: String, staging: URL, files: [SharedDraftFile],
                 createdAt: Int64) throws -> SharedDraftPlan {
        lock.lock()
        defer { lock.unlock() }
        guard !files.isEmpty, files.count <= SHARED_DRAFT_MAX_FILES else {
            throw SharedDraftError.nothingUsable
        }
        let plan = SharedDraftPlan(version: SharedDraftPlan.currentVersion,
                                   id: try SharedDraftID.checked(id),
                                   createdAt: createdAt, files: files)
        guard valid(plan, directoryName: id) else { throw SharedDraftError.storageFailed }

        let destination = draftURL(id: id)
        do {
            // The bytes are where the plan is about to say they are — checked
            // BEFORE the plan is written, so a plan never describes staging that
            // moved, shrank or never arrived.
            try verifyStaging(plan, in: staging)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(plan).write(to: planURL(in: staging), options: .atomic)

            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
            guard !fileManager.fileExists(atPath: destination.path) else {
                throw SharedDraftError.storageFailed
            }
            // Atomic. Everything before this line happened inside a directory
            // nothing reads; everything after it is a complete draft.
            try fileManager.moveItem(at: staging, to: destination)
        } catch {
            // Whatever failed, it failed before the rename or during it, so the
            // published area holds nothing half-made. The staging directory is
            // still the writer's to abandon.
            throw SharedDraftError.storageFailed
        }
        return plan
    }

    // MARK: - reading

    /// Every complete, valid, unretired draft, oldest first.
    ///
    /// FIFO because several share invocations are several separate things the
    /// user asked for, and the one they made first is the one they have been
    /// waiting on. The order is total — `createdAt`, then the id — so two drafts
    /// created inside the same second still list deterministically rather than
    /// in whatever order the directory happened to enumerate.
    public func drafts() -> [SharedDraftPlan] {
        lock.lock()
        defer { lock.unlock() }
        let entries = (try? fileManager.contentsOfDirectory(
            at: root, includingPropertiesForKeys: nil)) ?? []
        return entries
            .compactMap { entry -> SharedDraftPlan? in
                guard !reservedNames.contains(entry.lastPathComponent) else { return nil }
                guard let plan = decoded(directory: entry), !isRetired(plan.id) else { return nil }
                return plan
            }
            .filter { (try? verifyStaging($0, in: draftURL(id: $0.id))) != nil }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    /// One draft by id, complete, valid and unretired, or nil.
    public func draft(id: String) -> SharedDraftPlan? {
        lock.lock()
        defer { lock.unlock() }
        guard SharedDraftID.isValid(id), !isRetired(id),
              let plan = decoded(directory: draftURL(id: id)),
              (try? verifyStaging(plan, in: draftURL(id: id))) != nil else { return nil }
        return plan
    }

    /// The staged file for every entry, paired with its manifest name, in plan
    /// order. The app sends from THESE — never from anything the extension saw,
    /// which may be gone, changed, or behind a scope this process never held.
    public func stagedFiles(for plan: SharedDraftPlan) throws -> [(name: String, url: URL)] {
        lock.lock()
        defer { lock.unlock() }
        guard valid(plan, directoryName: plan.id) else { throw SharedDraftError.storageFailed }
        let directory = draftURL(id: plan.id)
        try verifyStaging(plan, in: directory)
        return try plan.files.map { (name: $0.name,
                                     url: try stagedURL(in: directory, staged: $0.staged)) }
    }

    private var reservedNames: Set<String> {
        [stagingDirectoryName, retiredDirectoryName]
    }

    /// Read one plan, refusing path indirection before following any of it.
    ///
    /// Nothing here is resolved. A symlinked draft directory or a symlinked
    /// `draft.json` is not repaired, not followed and not reported as a draft —
    /// it simply is not one. `Data(contentsOf:)` would have followed both.
    private func decoded(directory: URL) -> SharedDraftPlan? {
        guard isRealDirectory(directory) else { return nil }
        let url = planURL(in: directory)
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let size = (attributes[.size] as? NSNumber)?.intValue,
              size > 0, size <= maxPlanBytes,
              let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: size),
              let plan = try? JSONDecoder().decode(SharedDraftPlan.self, from: data),
              valid(plan, directoryName: directory.lastPathComponent) else { return nil }
        return plan
    }

    /// Validate every value that can influence a path, an allocation or what is
    /// uploaded, before a decoded plan becomes usable state.
    func valid(_ plan: SharedDraftPlan, directoryName: String) -> Bool {
        guard plan.version == SharedDraftPlan.currentVersion,
              plan.id == directoryName,
              SharedDraftID.isValid(plan.id),
              plan.createdAt > 0,
              !plan.files.isEmpty,
              plan.files.count <= SHARED_DRAFT_MAX_FILES
        else { return false }

        var total = 0
        var names = Set<String>()
        for (index, file) in plan.files.enumerated() {
            guard file.staged == String(index),
                  validManifestName(file.name),
                  names.insert(file.name).inserted,
                  file.size >= 0
            else { return false }
            let (next, overflow) = total.addingReportingOverflow(file.size)
            guard !overflow else { return false }
            total = next
        }
        return total < Int.max / 2
    }

    /// The staged tree a plan describes: a real `staged/` directory holding one
    /// REGULAR file of the declared size per entry.
    ///
    /// Every check is lstat-based. A symlinked `staged/` directory, or a
    /// symlinked entry inside it, is a refusal rather than something to follow —
    /// otherwise a draft could name bytes anywhere on the device and the app
    /// would upload them under a manifest name the user chose for something
    /// else.
    @discardableResult
    func verifyStaging(_ plan: SharedDraftPlan, in directory: URL) throws -> Bool {
        guard isRealDirectory(directory), isRealDirectory(stagedRoot(in: directory)) else {
            throw SharedDraftError.storageFailed
        }
        for file in plan.files {
            let url = try stagedURL(in: directory, staged: file.staged)
            let attributes = try? fileManager.attributesOfItem(atPath: url.path)
            guard attributes?[.type] as? FileAttributeType == .typeRegular,
                  let size = (attributes?[.size] as? NSNumber)?.intValue,
                  size == file.size else {
                throw SharedDraftError.storageFailed
            }
        }
        return true
    }

    // MARK: - removal

    /// The user chose Discard. Destructive and immediate.
    ///
    /// Marked before it is removed, exactly like `retire`: a Discard whose
    /// `unlink` fails must not put the draft back on the Send tab as though the
    /// user had never pressed the button.
    @discardableResult
    public func discard(id: String) -> Bool { retire(id: id) }

    /// The app has durably taken ownership: the account-bound pending plan and
    /// its Keychain content key are both committed, so this copy is redundant.
    ///
    /// **The marker is written before the bytes are removed, and that ordering
    /// is the invariant.** From the moment a durable job owns a source draft,
    /// the draft must never be offered as a second send — a failed `removeItem`
    /// is not authority to upload the user's files twice. So the logical
    /// retirement lands first and every reader honours it; the physical removal
    /// is then attempted, and if it fails the marker stays behind for
    /// `retryRetirements` to finish on a later launch.
    ///
    /// Returns whether the BYTES are gone. `false` means the draft is hidden and
    /// will be retried, not that it is still offered — the caller turns it into
    /// the ordinary cleanup warning beside a successful upload.
    ///
    /// Idempotent in every direction: an already-marked id, an already-removed
    /// directory, and an id that was never a draft all behave.
    @discardableResult
    public func retire(id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard SharedDraftID.isValid(id) else { return false }
        // Best effort, and deliberately not a precondition for the removal below.
        // If the store is unwritable, deleting the bytes is still the strongest
        // cleanup available and still satisfies the invariant outright.
        mark(retired: id)
        guard remove(id: id) else { return false }
        // The bytes are provably gone, so the marker has nothing left to hide.
        try? fileManager.removeItem(at: retiredURL(id: id))
        return true
    }

    /// Finish the physical half of any retirement whose `removeItem` failed.
    ///
    /// Called from the app's launch sweep. Idempotent, and safe against a draft
    /// that is already gone — that case simply drops the marker.
    public func retryRetirements() {
        lock.lock()
        defer { lock.unlock() }
        for entry in (try? fileManager.contentsOfDirectory(
            at: retiredRoot, includingPropertiesForKeys: nil)) ?? [] {
            let id = entry.lastPathComponent
            guard SharedDraftID.isValid(id) else { continue }
            retire(id: id)
        }
    }

    func retiredURL(id: String) -> URL {
        retiredRoot.appendingPathComponent(id)
    }

    /// Whether a draft has been logically retired, whatever is still on disk.
    func isRetired(_ id: String) -> Bool {
        guard SharedDraftID.isValid(id) else { return false }
        return kind(of: retiredURL(id: id)) != nil
    }

    @discardableResult
    private func mark(retired id: String) -> Bool {
        do {
            try fileManager.createDirectory(at: retiredRoot, withIntermediateDirectories: true)
            // Atomic and empty. The NAME is the whole record; a marker that was
            // half-written would be one this process could not tell from a
            // marker that was never written.
            try Data().write(to: retiredURL(id: id), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private func remove(id: String) -> Bool {
        let url = draftURL(id: id)
        guard fileManager.fileExists(atPath: url.path) else { return true }
        // The plan FIRST: a removal interrupted after this point leaves a
        // plan-less directory, which every reader ignores. Removing the tree
        // first could leave a plan describing bytes that are gone, which is a
        // draft the app would offer and then fail to send.
        try? fileManager.removeItem(at: planURL(id: id))
        do {
            try fileManager.removeItem(at: url)
            return !fileManager.fileExists(atPath: url.path)
        } catch {
            return false
        }
    }

    /// Remove what is PROVABLY incomplete: a published directory with no plan at
    /// all, and staging from a preparation the system killed outright.
    ///
    /// **What it will not do is delete a directory whose plan it cannot read.**
    /// A malformed plan, a plan from a version this build does not know, a
    /// symlinked plan — each of those is a directory holding the user's bytes
    /// with *something* describing them, and a build that deleted it would be
    /// destroying data because it had been upgraded past, downgraded from, or
    /// simply confused. Such work is ignored: it is not offered, not followed
    /// and not removed. A future build that understands it can still read it.
    ///
    /// `grace` applies to every removal candidate, published or staging. Nothing
    /// here relies on a directory's modification date changing while a child
    /// file's contents are written — it does not — because atomic publication
    /// means a live publisher never has a directory in the published root at
    /// all, and a live preparation's staging directory is created at the moment
    /// the copy starts.
    public func sweepIncomplete(grace: TimeInterval = 3600, now: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        for entry in (try? fileManager.contentsOfDirectory(
            at: root, includingPropertiesForKeys: nil)) ?? [] {
            let name = entry.lastPathComponent
            if name == stagingDirectoryName {
                for pending in (try? fileManager.contentsOfDirectory(
                    at: entry, includingPropertiesForKeys: nil)) ?? []
                    where isRealDirectory(pending) && stale(pending, grace: grace, now: now) {
                    try? fileManager.removeItem(at: pending)
                }
                continue
            }
            // The retirement markers are this store's own bookkeeping.
            if name == retiredDirectoryName { continue }
            // Not a real directory — a symlink, a stray file, a device node. It
            // is not a draft, and it is not something to follow or to delete:
            // removing a symlink here would be acting on a name somebody else
            // in the group chose, and following it would leave the store.
            guard isRealDirectory(entry) else { continue }
            // A plan is PRESENT — readable or not, this build's version or not.
            // That is somebody's complete work and this function does not touch
            // it.
            guard kind(of: planURL(in: entry)) == nil else { continue }
            // Plan-less, so it can only be a publication that never finished or
            // a removal that did not — and only once it is provably stale, so a
            // legacy publisher from an older build is never swept mid-flight.
            if stale(entry, grace: grace, now: now) {
                try? fileManager.removeItem(at: entry)
            }
        }
    }

    private func stale(_ url: URL, grace: TimeInterval, now: Date) -> Bool {
        let modified = (try? fileManager.attributesOfItem(atPath: url.path))?[.modificationDate]
            as? Date
        // An unreadable date is not a licence to delete somebody's files.
        guard let modified else { return false }
        return now.timeIntervalSince(modified) > grace
    }
}

/// A manifest name a draft may carry.
///
/// Forward-slash relative, non-empty, within the wire's byte budget, and unable
/// to name anything above the tree it belongs to. The traversal components are
/// refused here as well as at `stagedURL` — the staged path is an index and
/// never composed from this, but the name is what the app turns into a
/// `SelectedFile.relativePath` and then into a manifest entry the receiver
/// rebuilds a directory from.
func validManifestName(_ name: String) -> Bool {
    guard !name.isEmpty, name.utf8.count <= SHARED_DRAFT_MAX_NAME_BYTES,
          !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0") else { return false }
    let components = name.split(separator: "/", omittingEmptySubsequences: false)
    guard !components.isEmpty else { return false }
    for component in components {
        guard !component.isEmpty, component != ".", component != ".." else { return false }
    }
    return true
}
