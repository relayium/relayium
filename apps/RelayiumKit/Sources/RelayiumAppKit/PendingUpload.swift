import Foundation
import RelayiumKit

/// One file inside a staged job.
///
/// `name` is the manifest name — the forward-slash relative path the receiver
/// rebuilds hierarchy from. `staged` is the file's name inside the job's own
/// `staged/` directory and is deliberately NOT derived from it: a manifest name
/// legitimately contains separators, and composing one into a path is how a
/// selection escapes the directory it was supposed to stay in. It is the
/// index, and nothing else.
public struct PendingUploadFile: Codable, Equatable {
    public let name: String
    public let size: Int
    public let staged: String
}

/// Everything needed to finish an upload in a process that has never seen the
/// user's files — and nothing else.
///
/// Two things are deliberately absent. The **bearer** is never here: it is read
/// at the moment of use and belongs to a session, not to a job. The **content
/// key** is never here either; it lives in the keychain under the job id, so
/// the metadata on disk cannot decrypt the bytes beside it.
///
/// `version` is checked on read rather than assumed. A plan written by a future
/// build is refused, not guessed at: a mis-parsed plan would resume an upload
/// from the wrong offset, and the failure mode of that is a blob nobody can
/// open.
public struct PendingUploadPlan: Codable, Equatable {
    public static let currentVersion = 1

    public let version: Int
    public let jobId: String
    public let accountId: String
    public let files: [PendingUploadFile]
    public let burnAfterRead: Bool
    public let ttl: Int
    public let createdAt: Int64
    /// The server session these bytes are being fed to, once one exists.
    public var uploadId: String?
    /// The transport chunk size issued with `uploadId`.
    ///
    /// It is part of the session, not a client preference. A later process did
    /// not see the init response, so guessing the current default would change
    /// PATCH boundaries whenever the server configuration changes.
    public var uploadChunkSize: Int?
    /// The user discarded this job. Kept as a tombstone until directory
    /// removal succeeds, so a failed delete can never turn Discard back into a
    /// Resume offer on the next launch.
    public var retired: Bool
    /// Set the moment the server finalizes the object, BEFORE any cleanup runs.
    ///
    /// This is what stops a finished upload from coming back as a resumable job
    /// when cleanup fails: the object exists, the user has the link, and
    /// uploading the bytes again would bill them twice for one file.
    public var finalizedStoredId: String?

    public var totalBytes: Int { files.reduce(0) { $0 + $1.size } }
}

public enum PendingUploadError: Error, Equatable {
    /// The selection is empty, too large, or carries a name/size this app will
    /// not stage.
    case unusableSelection
    /// The staged bytes are missing or no longer match the plan.
    case stagingMissing
}

/// The staged bytes and the plan that describes them.
///
/// The whole point is the ORDER. Bytes are copied out of already-pinned
/// descriptors into a directory this app owns, and only then is the plan
/// written — atomically, and last. A job directory without a plan is therefore
/// a preparation that died part-way and is swept; a job directory with one is
/// complete by construction.
///
/// It lives under Application Support rather than `tmp` (purgeable, and swept
/// per launch by the photo staging area) or `Documents` (published to the Files
/// app by `UIFileSharingEnabled` — the user's received-files folder is not a
/// place to leave copies of what they are sending).
public final class PendingUploadStore: @unchecked Sendable {
    private let root: URL
    private let fileManager: FileManager
    /// Preparation, launch sweep, session updates and deletion all touch the
    /// same job directories from different tasks. Serializing them is what
    /// prevents a launch sweep from mistaking a new job (whose plan is written
    /// last) for an abandoned half-copy and deleting it mid-preparation.
    private let lock = NSRecursiveLock()

    /// Peak bytes held while copying during the last `prepare`. Staging a
    /// 4 GB video may not put 4 GB in memory, and a bound nobody measures is a
    /// bound nobody keeps.
    public private(set) var lastCopyBufferPeak = 0

    public init(root: URL, fileManager: FileManager = .default) {
        self.root = root
        self.fileManager = fileManager
    }

    /// `<Application Support>/PendingUploads`.
    public static func defaultRoot(_ fileManager: FileManager = .default) -> URL {
        // Resolving the sandbox's Application Support URL does not need to
        // create it. `prepare` creates the concrete job directory and reports
        // that filesystem failure to the user; the app must never silently
        // fall back to a non-resumable upload because eager directory creation
        // happened to fail during app construction.
        guard let base = fileManager.urls(for: .applicationSupportDirectory,
                                          in: .userDomainMask).first else {
            preconditionFailure("Application Support is unavailable") // nonlocalized: programmer diagnostic
        }
        return base.appendingPathComponent("PendingUploads", isDirectory: true)
    }

    // MARK: - locations

    public func jobURL(for jobId: String) -> URL {
        root.appendingPathComponent(jobId, isDirectory: true)
    }

    public func planURL(for jobId: String) -> URL {
        jobURL(for: jobId).appendingPathComponent("plan.json")
    }

    private func stagedRoot(for jobId: String) -> URL {
        jobURL(for: jobId).appendingPathComponent("staged", isDirectory: true)
    }

    // MARK: - preparation

    /// Stage a selection: copy it, then describe it.
    public func prepare(files: [SelectedFile], accountId: String,
                        burnAfterRead: Bool, ttl: Int) throws -> PendingUploadPlan {
        // Through `stageCloudFiles`, so the sources are the same descriptor-
        // pinned ones the uploader would have used. The pin is what makes these
        // the bytes the user consented to: a path looked up a second time is
        // the lookup that can lie.
        try prepare(sources: try stageCloudFiles(files), accountId: accountId,
                    burnAfterRead: burnAfterRead, ttl: ttl)
    }

    /// The real preparation, taking already-pinned sources.
    ///
    /// It takes `PlaintextSource` rather than URLs on purpose: this function
    /// cannot reopen anything, because it is handed no path to reopen.
    public func prepare(sources: [PlaintextSource], accountId: String,
                        burnAfterRead: Bool, ttl: Int) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        guard !sources.isEmpty, sources.count <= MAX_FILES else {
            throw PendingUploadError.unusableSelection
        }
        guard !accountId.isEmpty, ttl > 0 else {
            throw PendingUploadError.unusableSelection
        }
        for source in sources {
            guard source.size >= 0, !source.name.isEmpty else {
                throw PendingUploadError.unusableSelection
            }
        }
        // The declared ciphertext size must be expressible. Overflow here would
        // wrap a Content-Range total and misplace every subsequent offset.
        let sizes = sources.map(\.size)
        var plaintextTotal = 0
        for size in sizes {
            let (sum, overflow) = plaintextTotal.addingReportingOverflow(size)
            guard !overflow else { throw PendingUploadError.unusableSelection }
            plaintextTotal = sum
        }
        guard plaintextTotal < Int.max / 2 else { throw PendingUploadError.unusableSelection }

        // Uppercase hex and dashes: already inside `StoredObjectID`'s alphabet,
        // which matters because this id becomes a keychain account name.
        let jobId = try StoredObjectID.checked(UUID().uuidString)
        let job = jobURL(for: jobId)
        let staged = stagedRoot(for: jobId)
        do {
            try fileManager.createDirectory(at: staged, withIntermediateDirectories: true)
            // Set on the job directory before a byte lands in it. These are copies
            // of the user's files, kept only until the upload finishes; restoring
            // them onto another device is not something anyone asked for.
            var excluded = job
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try excluded.setResourceValues(values)
            guard try excluded.resourceValues(forKeys: [.isExcludedFromBackupKey])
                .isExcludedFromBackup == true else {
                throw PendingUploadError.unusableSelection
            }

            lastCopyBufferPeak = 0
            var entries: [PendingUploadFile] = []
            for (index, source) in sources.enumerated() {
                var source = source
                let stagedName = String(index)
                let destination = try stagedURL(jobId: jobId, staged: stagedName)
                guard fileManager.createFile(atPath: destination.path, contents: nil) else {
                    throw PendingUploadError.unusableSelection
                }
                let handle = try FileHandle(forWritingTo: destination)
                defer { try? handle.close() }
                var copied = 0
                while copied < source.size {
                    try Task.checkCancellation()
                    let want = min(STORE_CHUNK_SIZE, source.size - copied)
                    let chunk = try source.read(want)
                    // `PlaintextSource` promises at most `want` bytes and its
                    // declared size is the manifest contract. A source that
                    // grows, shrinks or violates the bound must not turn into a
                    // different resumable job while it is being staged.
                    guard !chunk.isEmpty, chunk.count <= want else {
                        throw PendingUploadError.unusableSelection
                    }
                    lastCopyBufferPeak = max(lastCopyBufferPeak, chunk.count)
                    try handle.write(contentsOf: Data(chunk))
                    let (sum, overflow) = copied.addingReportingOverflow(chunk.count)
                    guard !overflow else { throw PendingUploadError.unusableSelection }
                    copied = sum
                }
                guard try source.read(1).isEmpty else {
                    throw PendingUploadError.unusableSelection
                }
                try handle.close()
                // Read-only, so nothing in this app can edit the bytes a
                // resume will re-encrypt under a nonce the first attempt
                // already used.
                try fileManager.setAttributes([.posixPermissions: 0o400],
                                              ofItemAtPath: destination.path)
                entries.append(PendingUploadFile(name: source.name, size: source.size,
                                                 staged: stagedName))
            }

            let plan = PendingUploadPlan(version: PendingUploadPlan.currentVersion,
                                         jobId: jobId, accountId: accountId,
                                         files: entries, burnAfterRead: burnAfterRead, ttl: ttl,
                                         createdAt: Int64(Date().timeIntervalSince1970),
                                         uploadId: nil, uploadChunkSize: nil, retired: false,
                                         finalizedStoredId: nil)
            try write(plan)                 // LAST: this is what makes the job complete
            return plan
        } catch {
            // A half-copied job is bytes with nothing to describe them. Remove
            // it here rather than leaving it for the sweep, so a failed
            // preparation does not sit on the user's disk until next launch.
            try? fileManager.removeItem(at: job)
            throw error
        }
    }

    /// The staged file for one entry, refused if the name could name anything
    /// other than a direct child of this job's `staged/` directory.
    private func stagedURL(jobId: String, staged: String) throws -> URL {
        guard !staged.isEmpty, staged.count <= 16,
              staged.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            throw PendingUploadError.stagingMissing
        }
        let base = stagedRoot(for: jobId).standardizedFileURL
        let url = base.appendingPathComponent(staged).standardizedFileURL
        guard url.deletingLastPathComponent().path == base.path else {
            throw PendingUploadError.stagingMissing
        }
        return url
    }

    // MARK: - reading

    /// The recoverable job this account owns, if there is one.
    ///
    /// Ownership is checked here rather than by the caller, and a plan that
    /// does not parse, is a version this build does not know, or whose staged
    /// bytes no longer match is simply not returned. Recovery must never be
    /// offered for something that cannot actually be resumed.
    public func plan(for accountId: String?) -> PendingUploadPlan? {
        lock.lock()
        defer { lock.unlock() }
        guard let accountId, !accountId.isEmpty else { return nil }
        return plans()
            .filter { $0.accountId == accountId && !$0.retired && $0.finalizedStoredId == nil }
            .sorted { $0.createdAt > $1.createdAt }
            .first { (try? verifyStaging($0)) != nil }
    }

    private func plans() -> [PendingUploadPlan] {
        let entries = (try? fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return entries.compactMap { entry in
            guard let data = try? Data(contentsOf: entry.appendingPathComponent("plan.json")),
                  let plan = try? JSONDecoder().decode(PendingUploadPlan.self, from: data),
                  valid(plan, directoryName: entry.lastPathComponent)
            else { return nil }
            return plan
        }
    }

    private func currentPlan(jobId: String) -> PendingUploadPlan? {
        guard let checked = try? StoredObjectID.checked(jobId), checked == jobId,
              let data = try? Data(contentsOf: planURL(for: checked)),
              let plan = try? JSONDecoder().decode(PendingUploadPlan.self, from: data),
              valid(plan, directoryName: checked) else { return nil }
        return plan
    }

    /// Validate every value that can influence a path, an allocation or the
    /// encrypted stream before a decoded plan becomes executable state.
    private func valid(_ plan: PendingUploadPlan, directoryName: String) -> Bool {
        guard plan.version == PendingUploadPlan.currentVersion,
              plan.jobId == directoryName,
              (try? StoredObjectID.checked(plan.jobId)) == plan.jobId,
              !plan.accountId.isEmpty,
              plan.ttl > 0,
              !plan.files.isEmpty,
              plan.files.count <= MAX_FILES
        else { return false }

        if let finalized = plan.finalizedStoredId,
           (try? StoredObjectID.checked(finalized)) != finalized { return false }

        switch (plan.uploadId, plan.uploadChunkSize) {
        case (nil, nil): break
        case let (.some(id), .some(chunkSize)):
            guard (try? StoredObjectID.checked(id)) == id,
                  validUploadChunkSize(chunkSize) else { return false }
        default:
            return false
        }

        var total = 0
        for (index, file) in plan.files.enumerated() {
            guard !file.name.isEmpty, file.size >= 0,
                  file.staged == String(index) else { return false }
            let (next, overflow) = total.addingReportingOverflow(file.size)
            guard !overflow else { return false }
            total = next
        }
        return total < Int.max / 2
    }

    @discardableResult
    private func verifyStaging(_ plan: PendingUploadPlan) throws -> Bool {
        for file in plan.files {
            let url = try stagedURL(jobId: plan.jobId, staged: file.staged)
            let attributes = try? fileManager.attributesOfItem(atPath: url.path)
            guard attributes?[.type] as? FileAttributeType == .typeRegular,
                  let size = (attributes?[.size] as? NSNumber)?.intValue,
                  size == file.size else {
                throw PendingUploadError.stagingMissing
            }
        }
        return true
    }

    /// Byte sources over the STAGED copies — never the originals, which may be
    /// gone, changed, or behind a security scope this launch does not hold.
    public func sources(for plan: PendingUploadPlan) throws -> [PlaintextSource] {
        lock.lock()
        defer { lock.unlock() }
        guard valid(plan, directoryName: plan.jobId) else {
            throw PendingUploadError.stagingMissing
        }
        try verifyStaging(plan)
        return try plan.files.map { file in
            let url = try stagedURL(jobId: plan.jobId, staged: file.staged)
            do { return try FileURLSource(url: url, name: file.name) }
            catch { throw PendingUploadError.stagingMissing }
        }
    }

    // MARK: - mutation

    @discardableResult
    public func setUploadSession(id: String, chunkSize: Int,
                                 for plan: PendingUploadPlan) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        guard validUploadChunkSize(chunkSize) else {
            throw PendingUploadError.unusableSelection
        }
        guard let current = currentPlan(jobId: plan.jobId),
              !current.retired, current.finalizedStoredId == nil else {
            throw PendingUploadError.stagingMissing
        }
        var updated = current
        updated.uploadId = try StoredObjectID.checked(id)
        updated.uploadChunkSize = chunkSize
        try write(updated)
        return updated
    }

    /// Record that the server has the object. Written BEFORE any cleanup, so a
    /// crash between finalize and purge cannot resurrect the job.
    @discardableResult
    public func markFinalized(_ plan: PendingUploadPlan, storedId: String) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        guard let current = currentPlan(jobId: plan.jobId), !current.retired else {
            throw PendingUploadError.stagingMissing
        }
        var updated = current
        updated.finalizedStoredId = try StoredObjectID.checked(storedId)
        try write(updated)
        return updated
    }

    /// Persist the destructive choice before removing bytes. If removal is
    /// interrupted, launch sweep sees this marker and finishes the cleanup
    /// instead of offering the job again.
    @discardableResult
    public func markRetired(_ plan: PendingUploadPlan) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        guard let current = currentPlan(jobId: plan.jobId),
              current.finalizedStoredId == nil else {
            throw PendingUploadError.stagingMissing
        }
        var updated = current
        updated.retired = true
        try write(updated)
        return updated
    }

    /// Foundation's atomic write uses a sibling temporary file plus rename: a
    /// reader sees the old plan or the new one, never a truncated document. It
    /// also handles the first write, when there is no item to replace yet.
    private func write(_ plan: PendingUploadPlan) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(plan)
        try data.write(to: planURL(for: plan.jobId), options: .atomic)
    }

    // MARK: - removal

    @discardableResult
    public func purge(_ plan: PendingUploadPlan) -> Bool { purge(jobId: plan.jobId) }

    @discardableResult
    public func purge(jobId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let checked = try? StoredObjectID.checked(jobId) else { return false }
        let url = jobURL(for: checked)
        guard fileManager.fileExists(atPath: url.path) else { return true }
        do {
            try fileManager.removeItem(at: url)
            return !fileManager.fileExists(atPath: url.path)
        } catch {
            return false
        }
    }

    /// Remove what cannot be recovered anyway: job directories with no plan (a
    /// preparation that died part-way), plans this build cannot read, retired
    /// jobs, and jobs whose object the server already has.
    ///
    /// Called once at launch. It never touches a directory it cannot explain,
    /// and it is the only thing that deletes a job nobody asked about.
    public func sweepIncomplete() {
        lock.lock()
        defer { lock.unlock() }
        let entries = (try? fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for entry in entries {
            let planFile = entry.appendingPathComponent("plan.json")
            guard let data = try? Data(contentsOf: planFile),
                  let plan = try? JSONDecoder().decode(PendingUploadPlan.self, from: data),
                  valid(plan, directoryName: entry.lastPathComponent),
                  !plan.retired,
                  plan.finalizedStoredId == nil,
                  (try? verifyStaging(plan)) != nil
            else {
                try? fileManager.removeItem(at: entry)
                continue
            }
        }
    }
}

/// The two stores a pending job needs, handed to `CloudUploadModel` together.
///
/// A pair rather than two optional parameters: a store with no key store can
/// stage bytes it can never encrypt, and a key store with no store can keep a
/// key for a job that does not exist. Neither half is useful alone, so neither
/// can be supplied alone.
public struct PendingUploadSupport {
    public let store: PendingUploadStore
    /// Keyed by job id, in its own keychain namespace
    /// (`KeychainStoredLinkKeyStore.pendingUploadPrefix`).
    public let keys: StoredLinkKeyStore

    public init(store: PendingUploadStore, keys: StoredLinkKeyStore) {
        self.store = store
        self.keys = keys
    }
}
