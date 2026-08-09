import Foundation
import RelayiumKit
import RelayiumShareKit

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
    /// The shared draft these bytes were copied out of, when they came from the
    /// iOS share extension rather than from a picker.
    ///
    /// **Optional, and the version is deliberately NOT bumped.** A plan written
    /// by the previous build has no such key; Swift's synthesized decoding of an
    /// optional uses `decodeIfPresent`, so it reads back as nil and that job
    /// resumes exactly as it did before. A plan written by this build with no
    /// draft behind it encodes nothing, so an ordinary picker send is
    /// byte-identical to what it was. Bumping the version instead would have
    /// made every interrupted upload on every existing install unresumable, to
    /// record a field that changes nothing about how the bytes are sent.
    ///
    /// It is an id and nothing else: opaque, minted by the extension, and
    /// carrying no name, path or size. What it is FOR is the retirement rule —
    /// the draft is the user's only other copy, so it may be removed only once
    /// this plan and its Keychain content key both exist, and a crash in that
    /// window is repaired by recovery reading this field and retiring the draft
    /// then.
    public var sourceDraftId: String?

    /// What this job is uploading FOR.
    ///
    /// **Optional, and the version is deliberately NOT bumped**, for exactly the
    /// reasons written above `sourceDraftId`: a plan from the previous build has
    /// no such key and reads back as nil, and a plan this build writes for an
    /// ordinary share encodes nothing, so a share plan stays byte-identical.
    /// Bumping instead would make every interrupted upload on every existing
    /// install unresumable.
    ///
    /// nil means `share` — the only thing a plan predating this field could have
    /// been. Read it through `effectivePurpose`, never directly, so no call site
    /// can treat "absent" as "unknown".
    ///
    /// An unrecognised raw value is a DECODE failure rather than a default: a
    /// purpose written by a future build describes an authorization model this
    /// one cannot honour, and resuming it as a share is the specific mistake
    /// that would publish a device delivery.
    public var purpose: UploadPurpose?
    /// The device this job is being delivered to. Present exactly when
    /// `effectivePurpose` is `.deviceTask`; see `PendingUploadTarget`.
    public var targetDeviceId: String?
    /// The identity and generation of the target public key this job's content
    /// key was sealed to. Both are recorded so a resume can tell "the same key"
    /// from "the key rotated while we were uploading" without re-reading the
    /// device row — and so a reseal is a decision made against a recorded fact
    /// rather than against whatever the device list says at the moment of retry.
    public var targetKeyId: String?
    public var targetKeyGeneration: Int64?
    /// The sender's creation-idempotency key, minted ONCE when this plan is
    /// written and never again.
    ///
    /// This is the field the whole durable-device-send design turns on. Central
    /// converges repeated creates carrying the same key onto exactly one task,
    /// so a create whose answer was lost — to a suspension, a force quit, a
    /// crash, a reaped upload session, or a network failure after the request
    /// left — can be retried safely. Minting a fresh key on retry instead would
    /// queue the same ciphertext as a SECOND delivery, and the user would see
    /// the file arrive twice with no way to tell which one to keep.
    ///
    /// It is minted before any network work, and it survives every mutation
    /// below because each of them reads the current plan and changes one field.
    public var createIdempotencyKey: String?
    /// The sealed content key carried by task creation.
    ///
    /// Sealed boxes are randomized: sealing the same content key to the same
    /// device twice produces different bytes. Central includes this value in
    /// its idempotency comparison, so it must be written before the first
    /// create and reused after a crash or lost response. Otherwise a safe retry
    /// would look like a different request under the same idempotency key.
    ///
    /// Optional and additive so plans written before native sending existed
    /// continue to decode. An old plan seals once and persists the result before
    /// its first create under this build.
    public var targetWrappedKey: String?
    /// The Inbox task central definitively minted for this job, once one exists.
    ///
    /// Written the moment a create returns — BEFORE the staged bytes, the
    /// content key or this plan are removed — and never rewritten to a
    /// different value. That ordering is what makes a crash during cleanup
    /// recoverable: the next launch reads this field, knows the delivery is
    /// already queued, and finishes tidying up instead of starting a send.
    ///
    /// Optional and additive, with the version deliberately NOT bumped, for the
    /// reasons written above `sourceDraftId`.
    public var deviceTaskId: String?
    /// Whether this send has already spent its ONE refresh-and-reseal.
    ///
    /// Durable rather than a loop counter on purpose. A rotation discovered
    /// mid-send may be answered by re-reading the device and sealing the same
    /// content key to its new current key exactly once; a force-quit between
    /// two create attempts must not hand the next launch a fresh budget, or
    /// "at most one reseal" quietly becomes "one per launch" and a device
    /// rotating in a loop would be chased forever.
    ///
    /// Read through `targetKeyWasResealed`, never directly, so absent and false
    /// cannot be told apart by a call site.
    public var targetKeyResealed: Bool?

    /// The purpose to act on. Absent means `share`: the only thing a plan
    /// written before this field existed could have been.
    public var effectivePurpose: UploadPurpose { purpose ?? .share }

    /// Whether the one refresh-and-reseal has been spent. Absent means no: a
    /// plan written before this field existed had never resealed anything.
    public var targetKeyWasResealed: Bool { targetKeyResealed ?? false }

    /// The coherent device target, when this is a device send.
    ///
    /// All-or-nothing by construction: it is nil unless the purpose is
    /// `.deviceTask` AND every one of the four fields is present. A partially
    /// populated plan never reaches here — `PendingUploadStore.valid` refuses it
    /// outright — so a caller cannot be handed half a target.
    public var target: PendingUploadTarget? {
        guard effectivePurpose == .deviceTask,
              let targetDeviceId, let targetKeyId, let targetKeyGeneration,
              let createIdempotencyKey else { return nil }
        return PendingUploadTarget(deviceId: targetDeviceId, keyId: targetKeyId,
                                   keyGeneration: targetKeyGeneration,
                                   createIdempotencyKey: createIdempotencyKey)
    }

    public var totalBytes: Int { files.reduce(0) { $0 + $1.size } }
}

/// Where a device send is going, and the key that makes its create idempotent.
///
/// One value rather than four loose fields so the set travels together. The
/// plan stores them separately because JSON optionality is per-key and a nested
/// object would change the encoding of a share plan; the coherence rule that
/// makes them one thing lives in `PendingUploadStore.valid`.
public struct PendingUploadTarget: Equatable, Sendable {
    public let deviceId: String
    public let keyId: String
    public let keyGeneration: Int64
    /// Defaulted to a freshly minted key, so a caller that has no reason to
    /// choose one cannot forget to. Either way it is written into the plan
    /// before the first byte of network work and never rotated afterwards.
    public let createIdempotencyKey: String

    public init(deviceId: String, keyId: String, keyGeneration: Int64,
                createIdempotencyKey: String = InboxIdempotencyKey.mint()) {
        self.deviceId = deviceId
        self.keyId = keyId
        self.keyGeneration = keyGeneration
        self.createIdempotencyKey = createIdempotencyKey
    }

    /// The durable half of a chosen `InboxSendTarget`.
    ///
    /// The public key is deliberately NOT carried across. What is recorded is
    /// the key's IDENTITY — id and generation — because the seal reads the
    /// device's current key at send time and compares it against these two
    /// fields. Persisting the key bytes instead would make a rotation
    /// invisible: the plan would happily reseal to a key central has already
    /// superseded, and the delivery would land on a device that cannot open it.
    public init(_ target: InboxSendTarget,
                createIdempotencyKey: String = InboxIdempotencyKey.mint()) {
        self.init(deviceId: target.deviceID, keyId: target.keyID,
                  keyGeneration: target.keyGeneration,
                  createIdempotencyKey: createIdempotencyKey)
    }

    /// The same rule `PendingUploadStore.valid` applies on read, so a target
    /// that could not be persisted is refused before a byte is staged.
    var isWellFormed: Bool {
        (try? StoredObjectID.checked(deviceId)) == deviceId
            && (try? StoredObjectID.checked(keyId)) == keyId
            && keyGeneration > 0
            && InboxIdempotencyKey.isValid(createIdempotencyKey)
    }
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
                        burnAfterRead: Bool, ttl: Int,
                        sourceDraftId: String? = nil,
                        target: PendingUploadTarget? = nil) throws -> PendingUploadPlan {
        // Through `stageCloudFiles`, so the sources are the same descriptor-
        // pinned ones the uploader would have used. The pin is what makes these
        // the bytes the user consented to: a path looked up a second time is
        // the lookup that can lie.
        try prepare(sources: try stageCloudFiles(files), accountId: accountId,
                    burnAfterRead: burnAfterRead, ttl: ttl,
                    sourceDraftId: sourceDraftId, target: target)
    }

    /// The real preparation, taking already-pinned sources.
    ///
    /// It takes `PlaintextSource` rather than URLs on purpose: this function
    /// cannot reopen anything, because it is handed no path to reopen.
    public func prepare(sources: [PlaintextSource], accountId: String,
                        burnAfterRead: Bool, ttl: Int,
                        sourceDraftId: String? = nil,
                        target: PendingUploadTarget? = nil) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        guard !sources.isEmpty, sources.count <= MAX_FILES else {
            throw PendingUploadError.unusableSelection
        }
        guard !accountId.isEmpty, ttl > 0 else {
            throw PendingUploadError.unusableSelection
        }
        // Checked before a byte is copied, for the same reason the draft id is:
        // a target that would not validate on read is one no resume could ever
        // act on, so the job would stage the user's bytes and then be swept.
        if let target {
            guard target.isWellFormed else { throw PendingUploadError.unusableSelection }
            // The server refuses burn-after-read on a task-purpose object
            // rather than rewriting it, so a plan that recorded the pair would
            // be a staged job whose every upload attempt 400s.
            guard !burnAfterRead else { throw PendingUploadError.unusableSelection }
            guard ttl == UploadPurpose.deviceTaskTTLSeconds else {
                throw PendingUploadError.unusableSelection
            }
        }
        // Checked before a byte is copied. A draft id that would not validate on
        // read is one recovery could never act on, so a job carrying it would be
        // a source the crash path silently fails to retire.
        if let sourceDraftId, !SharedDraftID.isValid(sourceDraftId) {
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

            // `purpose` stays nil for a share so the encoded plan is
            // byte-identical to what the previous build wrote. The device
            // fields are minted here, LAST before the write and therefore
            // before any network work — the idempotency key in particular
            // exists on disk before a create could ever be attempted.
            let plan = PendingUploadPlan(version: PendingUploadPlan.currentVersion,
                                         jobId: jobId, accountId: accountId,
                                         files: entries, burnAfterRead: burnAfterRead, ttl: ttl,
                                         createdAt: Int64(Date().timeIntervalSince1970),
                                         uploadId: nil, uploadChunkSize: nil, retired: false,
                                         finalizedStoredId: nil, sourceDraftId: sourceDraftId,
                                         purpose: target == nil ? nil : .deviceTask,
                                         targetDeviceId: target?.deviceId,
                                         targetKeyId: target?.keyId,
                                         targetKeyGeneration: target?.keyGeneration,
                                         createIdempotencyKey: target?.createIdempotencyKey,
                                         targetWrappedKey: nil)
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

    /// The device delivery this account still has work outstanding on.
    ///
    /// Deliberately NOT `plan(for:)` with a filter. The two answer different
    /// questions and disagree on exactly one condition: `plan(for:)` offers an
    /// upload the user could resume, so it excludes a job whose object the
    /// server already has. A delivery is the opposite — a finalized object with
    /// no task yet is precisely the state the orchestrator exists to finish, and
    /// offering it as a resumable upload would invite re-uploading bytes that
    /// are already paid for.
    ///
    /// A retired delivery is excluded: the user discarded it, and the tombstone
    /// outranks the outstanding work.
    public func deviceSendPlans(for accountId: String?) -> [PendingUploadPlan] {
        lock.lock()
        defer { lock.unlock() }
        guard let accountId, !accountId.isEmpty else { return [] }
        return plans()
            .filter { $0.accountId == accountId && $0.effectivePurpose == .deviceTask
                && !$0.retired }
            .sorted { $0.createdAt > $1.createdAt }
            .filter { (try? verifyStaging($0)) != nil }
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

        // A plan carrying a malformed draft id is refused whole rather than
        // read with the field ignored. Ignoring it would leave the user's only
        // other copy of those files staged forever with nothing able to name it.
        if let source = plan.sourceDraftId, !SharedDraftID.isValid(source) { return false }

        guard validTargetMetadata(plan) else { return false }

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

    /// The device metadata is coherent as a SET, in both directions.
    ///
    /// A device send needs all four fields and needs each of them usable; a
    /// share must carry none of them. Both halves are refusals rather than
    /// repairs, and each prevents a distinct real failure:
    ///
    ///  - a device plan missing its idempotency key would mint a fresh one on
    ///    the retry that needed the old one, and deliver the same bytes twice;
    ///  - a device plan missing its target key id or generation could not tell
    ///    a rotation from the key it sealed to, so it would either reseal
    ///    needlessly or send a box the target can no longer open;
    ///  - a SHARE plan carrying target metadata is a plan two builds disagree
    ///    about. Ignoring the extra fields would resume it as a public object
    ///    while something else on this device still believed it was a delivery.
    ///
    /// Refusing makes the job unresumable and sweepable, which is the honest
    /// outcome: the staged bytes are still the user's, and nothing was sent.
    private func validTargetMetadata(_ plan: PendingUploadPlan) -> Bool {
        let fields: [Bool] = [plan.targetDeviceId != nil, plan.targetKeyId != nil,
                              plan.targetKeyGeneration != nil,
                              plan.createIdempotencyKey != nil]
        switch plan.effectivePurpose {
        case .share:
            // The delivery-progress fields are refused here for exactly the
            // reason the target fields are: a share plan carrying them is two
            // builds disagreeing about what this job is, and ignoring the extra
            // keys would resume it as a public object while something else on
            // this device still believed it was a delivery.
            return fields.allSatisfy { !$0 }
                && plan.deviceTaskId == nil && plan.targetKeyResealed == nil
                && plan.targetWrappedKey == nil
        case .deviceTask:
            guard fields.allSatisfy({ $0 }), let target = plan.target else { return false }
            if let wrapped = plan.targetWrappedKey,
               (try? InboxKeyMaterial.decode(wrapped,
                                             expecting: InboxProtocol.sealedBoxBytes)) == nil {
                return false
            }
            // A task id that could not become a poll/cancel path component is a
            // delivery nothing could ever act on.
            if let taskId = plan.deviceTaskId,
               (try? StoredObjectID.checked(taskId)) != taskId { return false }
            // A device delivery may never be burn-after-read: the queue refuses
            // a limited object, so such a plan could not be uploaded at all.
            return target.isWellFormed && !plan.burnAfterRead
                && plan.ttl == UploadPurpose.deviceTaskTTLSeconds
        }
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

    /// Record the task central definitively minted for this delivery.
    ///
    /// Called BEFORE any cleanup, so the window in which a crash could lose the
    /// only local record of a live delivery is the single atomic plan write
    /// below rather than the whole tidy-up.
    ///
    /// Recording the SAME id again succeeds and changes nothing — that is how a
    /// retried cleanup gets through. Recording a DIFFERENT one is refused: one
    /// job's ciphertext is owned by one task, and a plan naming two of them
    /// could not decide which to cancel or which to believe.
    @discardableResult
    public func setDeviceTask(id: String, for plan: PendingUploadPlan) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        let checked = try StoredObjectID.checked(id)
        guard let current = currentPlan(jobId: plan.jobId), !current.retired,
              current.effectivePurpose == .deviceTask else {
            throw PendingUploadError.stagingMissing
        }
        if let existing = current.deviceTaskId {
            guard existing == checked else { throw PendingUploadError.unusableSelection }
            return current
        }
        var updated = current
        updated.deviceTaskId = checked
        try write(updated)
        return updated
    }

    /// Persist the randomized sealed box before the first create request.
    ///
    /// Re-recording the same value is a no-op. A different value is refused:
    /// once a create may have left this process, changing the wrapped key would
    /// make central's idempotency comparison reject the retry.
    @discardableResult
    public func setTargetWrappedKey(_ wrappedKey: String,
                                    for plan: PendingUploadPlan) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        _ = try InboxKeyMaterial.decode(wrappedKey, expecting: InboxProtocol.sealedBoxBytes)
        guard let current = currentPlan(jobId: plan.jobId), !current.retired,
              current.effectivePurpose == .deviceTask, current.deviceTaskId == nil else {
            throw PendingUploadError.stagingMissing
        }
        if let existing = current.targetWrappedKey {
            guard existing == wrappedKey else { throw PendingUploadError.unusableSelection }
            return current
        }
        var updated = current
        updated.targetWrappedKey = wrappedKey
        try write(updated)
        return updated
    }

    /// Spend this send's ONE refresh-and-reseal, recording the key identity the
    /// content key has just been sealed to.
    ///
    /// Everything else about the job is left exactly as it was — the content
    /// key, the staged bytes, the finalized object and the creation idempotency
    /// key all survive, because a reseal changes only WHO can open the delivery,
    /// never WHAT is being delivered or WHICH task will own it.
    ///
    /// Refused once a task exists: after a create has succeeded the target key
    /// is central's record, not this plan's decision.
    @discardableResult
    public func resealTargetKey(id: String, generation: Int64, wrappedKey: String,
                                for plan: PendingUploadPlan) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        guard let current = currentPlan(jobId: plan.jobId), !current.retired,
              current.effectivePurpose == .deviceTask, current.deviceTaskId == nil else {
            throw PendingUploadError.stagingMissing
        }
        // Checked before anything is written, so a refused reseal does not spend
        // the budget it was refused for.
        guard !current.targetKeyWasResealed else { throw PendingUploadError.unusableSelection }
        let checked = try StoredObjectID.checked(id)
        guard generation > 0 else { throw PendingUploadError.unusableSelection }
        _ = try InboxKeyMaterial.decode(wrappedKey, expecting: InboxProtocol.sealedBoxBytes)
        var updated = current
        updated.targetKeyId = checked
        updated.targetKeyGeneration = generation
        updated.targetKeyResealed = true
        // Key identity, reseal budget and randomized sealed box are one atomic
        // decision. A crash may observe the old trio or the new trio, never a
        // new key identity paired with the previous key's box.
        updated.targetWrappedKey = wrappedKey
        try write(updated)
        return updated
    }

    /// Persist the destructive choice before removing bytes. If removal is
    /// interrupted, launch sweep sees this marker and finishes the cleanup
    /// instead of offering the job again.
    ///
    /// A finalized SHARE may not be retired, and that refusal is deliberate: the
    /// object exists, the user holds the only copy of its key in the link they
    /// were shown, and turning that back into a discard would delete bytes they
    /// believe they have.
    ///
    /// A finalized DELIVERY has none of those properties. It has no link, no
    /// file-list row and no key the user holds — it is reachable only through
    /// the task that owns it — so a cancelled or definitively refused delivery
    /// has to be tombstonable, or its invisible staged bytes could never be
    /// released and the job would be offered to the orchestrator forever.
    @discardableResult
    public func markRetired(_ plan: PendingUploadPlan) throws -> PendingUploadPlan {
        lock.lock()
        defer { lock.unlock() }
        guard let current = currentPlan(jobId: plan.jobId),
              current.finalizedStoredId == nil || current.effectivePurpose == .deviceTask else {
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
                  // A finalized SHARE is finished: the object is on the server,
                  // the user has the link, and the job is nothing but leftovers.
                  // A finalized DELIVERY is the opposite — its ciphertext is up
                  // and its task still has to be created — so sweeping it would
                  // destroy the one idempotency key that could converge that
                  // create, and strand paid storage the account cannot see.
                  plan.finalizedStoredId == nil || plan.effectivePurpose == .deviceTask,
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
    /// Where a shared draft came from, so the one that fed this job can be
    /// retired once the job is durable.
    ///
    /// Optional, unlike the pair above, and that is the honest shape: macOS has
    /// no share extension and passes nothing, and the iOS app itself must keep
    /// working when the App Group cannot be resolved — an un-provisioned build
    /// still sends files chosen in the picker. Nil means "no draft can ever be
    /// the source of a job here", which is exactly true in both cases.
    ///
    /// It is a plain `SharedDraftStore` rather than anything main-actor-bound:
    /// retirement happens on whichever context finished the commit, and the
    /// store is lock-guarded for precisely that.
    public let drafts: SharedDraftStore?

    public init(store: PendingUploadStore, keys: StoredLinkKeyStore,
                drafts: SharedDraftStore? = nil) {
        self.store = store
        self.keys = keys
        self.drafts = drafts
    }
}
