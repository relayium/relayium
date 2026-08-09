import Foundation
import Darwin
@preconcurrency import RelayiumKit

/// One delivery, end to end: claim material in, a committed file tree out.
///
/// The pipeline is ordered so that nothing observable is produced until
/// everything has been proven:
///
///     unseal -> decrypt+validate manifest -> plan destinations -> journal the plan
///       -> preflight space -> stream ciphertext into STAGING, authenticating every
///       frame -> verify the WHOLE stream -> report `verifying` -> commit -> report
///       `saved`
///
/// Nothing is written outside the staging area before the last authenticated
/// frame has been accepted and the total length checked, so a tampered, truncated
/// or wrongly-keyed blob can never leave an apparently complete file where the
/// user will find it.
///
/// It is deliberately SEQUENTIAL and holds no state between deliveries: one disk,
/// one folder grant, one journal per task. Concurrency here would buy little and
/// would cost the invariant that at most one delivery is touching the receive
/// directory at a time.

/// What a log line is allowed to contain.
///
/// A structured event rather than a format string, so "a log line may carry a
/// task id, a protocol state, a closed error code, and byte or file COUNTS, and
/// nothing else" is a property of the TYPE rather than of whoever audits the call
/// sites. There is no case that can carry a file name, a destination, a bearer, a
/// claim token or key material, so no future call site can add one by accident.
public enum InboxLogEvent: Equatable, Sendable {
    case claimed(taskID: String, ciphertextBytes: Int64)
    case alreadyCommittedLocally(taskID: String, files: Int)
    case streamInterrupted(taskID: String, attempt: Int)
    case committed(taskID: String, files: Int, bytes: Int64)
    case reported(taskID: String, state: InboxTaskState, code: InboxDeviceErrorCode)
    case reportFailed(taskID: String, state: InboxTaskState)
    case abandoned(taskID: String, cause: InboxAbandon.Cause)
    case receiveFolder(problem: InboxFolderProblem?)
}

public typealias InboxLog = @Sendable (InboxLogEvent) -> Void

public struct InboxReceiver: Sendable {
    public let transport: InboxTransport
    public let keys: InboxDeviceKeyStoring
    public let journals: InboxJournalStore
    public let account: InboxAccountID
    /// The receive directory, resolved and held under an OPEN security scope by
    /// the caller for the whole delivery. The receiver never resolves a bookmark
    /// itself: whoever owns the scope owns the permission, and splitting the two
    /// is how a scope gets leaked.
    public let root: URL
    public let now: @Sendable () -> Date
    public let log: InboxLog?

    /// How often a working delivery re-reports its current state (an idempotent
    /// no-op that renews the lease). A third of the lease, so two renewals may be
    /// lost before the lease is at risk — the same tolerance presence gives two
    /// missed heartbeats.
    public var renewInterval: TimeInterval
    /// Reconnects bounded for ONE delivery attempt. Beyond this the task is failed
    /// retryable and central's own backoff and attempt budget take over, which is
    /// the layer that decides when a delivery is hopeless — the receiver must not
    /// out-retry it.
    public var streamAttempts: Int
    /// Free space on the receive volume, injected.
    ///
    /// A seam, not a convenience: a test runner has room for any delivery a test
    /// could plausibly describe, so the disk-full branch — one of the PRD's three
    /// `attention_required` outcomes — has no other way to be reached
    /// deterministically. Production passes the real `statfs`.
    public var freeBytes: @Sendable (URL) -> Int64?

    public init(transport: InboxTransport, keys: InboxDeviceKeyStoring,
                journals: InboxJournalStore, account: InboxAccountID, root: URL,
                now: @escaping @Sendable () -> Date = { Date() },
                log: InboxLog? = nil,
                renewInterval: TimeInterval = Double(InboxProtocol.defaultLeaseSeconds) / 3,
                streamAttempts: Int = 5,
                freeBytes: @escaping @Sendable (URL) -> Int64? = InboxSpace.freeBytes) {
        self.transport = transport
        self.keys = keys
        self.journals = journals
        self.account = account
        self.root = root
        self.now = now
        self.log = log
        self.renewInterval = renewInterval
        self.streamAttempts = streamAttempts
        self.freeBytes = freeBytes
    }

    /// What `deliver` established.
    public enum Outcome: Equatable, Sendable {
        /// Every planned destination is durably on disk, in this run.
        case committed
        /// The journal already said so from an earlier run whose `saved` report
        /// did not land. Re-downloading would duplicate the delivery; the correct
        /// action is to re-assert what already happened.
        case alreadyCommitted
    }

    /// Run one task to completion. Returns only on a durable commit.
    ///
    /// Every error it throws is either an `InboxFailure` carrying the closed code
    /// and state to report, or an `InboxAbandon` meaning report nothing — so the
    /// caller never has to interpret a local error to decide what to tell central.
    @discardableResult
    public func deliver(_ delivery: InboxDelivery) async throws -> Outcome {
        try Task.checkCancellation()
        let task = delivery.task

        var journal: InboxJournal
        do {
            if let existing = try journals.load(task.id), existing.isCompleted {
                try validateJournalIdentity(existing, for: task)
                // A crash between the last journal write and the staging cleanup
                // leaves an empty per-task directory behind — `commit` removes each
                // staged source as it records it. Inert, but nothing else would
                // ever collect it, because this path never calls `prepareStaging`.
                InboxCommit.cleanStaging(root: root, taskID: task.id)
                log?(.alreadyCommittedLocally(taskID: task.id, files: existing.plan.count))
                return .alreadyCommitted
            }
        } catch {
            throw InboxClassify.filesystem(error)
        }

        var contentKey = try await unsealContentKey(delivery)
        defer { InboxKeyMaterial.zero(&contentKey) }

        let (manifest, total) = try openManifest(delivery, key: contentKey)
        journal = try planAndJournal(delivery, manifest: manifest)

        guard InboxSpace.hasRoom(at: root, for: total, freeBytes: freeBytes) else {
            throw InboxFailure.attention(.diskFull, .notEnoughSpace)
        }

        let staging: URL
        do { staging = try InboxCommit.prepareStaging(root: root, taskID: task.id) }
        catch { throw InboxClassify.filesystem(error) }
        journal.staging = staging.path
        do { try journals.save(&journal, now: now()) }
        catch { throw InboxClassify.filesystem(error) }

        do {
            try await stream(delivery, key: contentKey, plan: journal.plan,
                             staging: staging, total: total)
        } catch {
            // Nothing outside staging exists yet, so removing it leaves no trace.
            InboxCommit.cleanStaging(root: root, taskID: task.id)
            throw error
        }

        // The bytes are proven. Tell central we are verifying BEFORE touching the
        // user's directory, so the sender's UI never shows a gap between
        // "downloaded" and "landed".
        do {
            try Task.checkCancellation()
            try await renew(delivery, state: .verifying)
            // Cancellation is allowed until the last reversible boundary. Once
            // the multi-file commit begins it must run to completion; stopping
            // between links would expose only part of one delivery to the user.
            try Task.checkCancellation()
        } catch {
            // The staged bytes are complete and verified but nothing is visible
            // yet, so abandoning here costs a re-download and risks nothing.
            // Committing under a lease central has already reassigned could let
            // two workers deliver the same task into two directories.
            InboxCommit.cleanStaging(root: root, taskID: task.id)
            throw error
        }

        var lastRenew = now()
        do {
            try await InboxCommit.commit(journal: &journal, root: root, store: journals,
                                         now: now) {
                guard now().timeIntervalSince(lastRenew) >= renewInterval else { return }
                // A refused renewal mid-commit stops the remaining destinations.
                // Files already committed stay committed and stay journalled: they
                // are real, verified deliveries, and the next attempt resumes from
                // the journal rather than re-creating what exists.
                try await renew(delivery, state: .verifying)
                lastRenew = now()
            }
        } catch let abandon as InboxAbandon {
            throw abandon
        } catch {
            throw InboxClassify.filesystem(error)
        }

        InboxCommit.cleanStaging(root: root, taskID: task.id)
        log?(.committed(taskID: task.id, files: journal.plan.count, bytes: total))
        return .committed
    }

    /// Mark this task's receipt as acknowledged by central, so it is not retried
    /// forever after the task has left the queue.
    public func markSavedReported(_ taskID: String) {
        guard var journal = try? journals.load(taskID), journal.isCompleted else { return }
        journal.isSavedReported = true
        try? journals.save(&journal, now: now())
    }

    // MARK: - pipeline steps

    /// Resolve the device private key the task names and open the sealed content
    /// key.
    private func unsealContentKey(_ delivery: InboxDelivery) async throws -> [UInt8] {
        let keyPair: InboxDeviceKeyPair?
        do {
            keyPair = try await keys.keyPair(forKeyID: delivery.task.targetKeyID, account: account)
        } catch {
            throw InboxFailure.retryable(.internal, .unexpected)
        }
        guard let keyPair else {
            // Central sealed to a key this account does not hold on this Mac — a
            // re-login that minted a new device, a restored machine, or a key
            // history that was destroyed. Nothing here can ever open it.
            throw InboxFailure.terminal(.decryptFailed, .noLocalPrivateKey)
        }
        do {
            return try InboxKeyMaterial.unsealContentKey(algorithm: delivery.task.wrapAlgorithm,
                                                         wrappedKey: delivery.wrappedKey,
                                                         keyPair: keyPair)
        } catch {
            throw InboxClassify.crypto(error)
        }
    }

    /// Decrypt and validate the copied encrypted manifest.
    ///
    /// The size cross-check is the one that matters: a manifest is
    /// sender-controlled, and AEAD only proves who wrote it. Declared plaintext
    /// can never exceed the ciphertext byte count central measured itself — every
    /// frame adds a length prefix and a Poly1305 tag — so a manifest claiming
    /// terabytes behind a 4 KiB object is a lie central can be used to catch,
    /// before any space is reserved for it.
    private func openManifest(_ delivery: InboxDelivery,
                              key: [UInt8]) throws -> (StoredManifest, Int64) {
        guard let encoded = Data(base64Encoded: delivery.encManifest) else {
            throw InboxFailure.terminal(.verifyFailed, .manifestUnreadable)
        }
        let manifest: StoredManifest
        do {
            // RAW names: `decryptManifest` strips control and bidi characters for
            // display, and a stripped name is one this device would then create
            // under a name nobody chose. The refusal belongs to the planner.
            manifest = try decryptManifestRaw(key: key, [UInt8](encoded))
        } catch {
            throw InboxClassify.crypto(error)
        }
        let total = manifest.files.reduce(Int64(0)) { $0 + Int64($1.size) }
        if delivery.task.ciphertextBytes > 0, total > delivery.task.ciphertextBytes {
            throw InboxFailure.terminal(.verifyFailed, .manifestExceedsCiphertext)
        }
        return (manifest, total)
    }

    /// Compute the destination plan and make it durable BEFORE any destination can
    /// exist.
    ///
    /// A resumed task keeps its ORIGINAL plan: recomputing it against a directory
    /// that now contains this task's own earlier output would walk the collision
    /// suffix forward and deliver the same file twice.
    private func planAndJournal(_ delivery: InboxDelivery,
                                manifest: StoredManifest) throws -> InboxJournal {
        let task = delivery.task
        let existing: InboxJournal?
        do { existing = try journals.load(task.id) }
        catch { throw InboxClassify.filesystem(error) }

        if let existing, !existing.plan.isEmpty {
            try validateJournalIdentity(existing, for: task)
            return existing
        }

        let plan: [InboxPlanEntry]
        do { plan = try InboxDestinationPlan.plan(root: root, files: manifest.files) }
        catch { throw InboxClassify.filesystem(error) }

        var journal = InboxJournal(taskID: task.id, storedFileID: task.storedFileID,
                                   targetKeyID: task.targetKeyID,
                                   root: root.standardizedFileURL.path,
                                   plan: plan,
                                   plannedAt: Int64(now().timeIntervalSince1970))
        do { try journals.save(&journal, now: now()) }
        catch { throw InboxClassify.filesystem(error) }
        return journal
    }

    /// A task id names the journal file, but it is not sufficient identity for
    /// resumption. Refuse a stale or replaced journal unless every immutable
    /// delivery binding and the receive root still match this claim.
    private func validateJournalIdentity(_ journal: InboxJournal,
                                         for task: InboxTask) throws {
        guard journal.taskID == task.id,
              journal.storedFileID == task.storedFileID,
              journal.targetKeyID == task.targetKeyID else {
            throw InboxFailure.terminal(.internal, .journalUnreadable)
        }
        guard journal.root == root.standardizedFileURL.path else {
            // The receive directory changed under an unfinished or unreported
            // task. Reusing absolute destinations from the old grant could land
            // the same delivery in two places.
            throw InboxFailure.attention(.directoryUnavailable, .receiveFolderChanged)
        }
    }

    /// Fetch the ciphertext, authenticate every frame, and land the plaintext in
    /// staging — resuming from the last COMPLETE frame boundary across transport
    /// failures.
    ///
    /// The resume offset comes from `StoreDecryptor.consumedCipher`, which only
    /// advances past frames that already authenticated, so a resumed request never
    /// re-feeds a partial frame and never skips one.
    private func stream(_ delivery: InboxDelivery, key: [UInt8], plan: [InboxPlanEntry],
                        staging: URL, total: Int64) async throws {
        let writer = try InboxStagingWriter(staging: staging, plan: plan)
        defer { writer.closeAll() }
        let decryptor = StoreDecryptor(key: key)
        var lastRenew = now()

        var attempt = 1
        while true {
            do {
                try await streamOnce(delivery, decryptor: decryptor, writer: writer,
                                     lastRenew: &lastRenew)
                break
            } catch let abandon as InboxAbandon {
                throw abandon
            } catch let failure as InboxFailure {
                // Already classified and not retryable within this attempt.
                throw failure
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if attempt >= streamAttempts { throw InboxClassify.transport(error) }
                if case InboxError.rangeIgnored = error {
                    // The server answered a resume with a full body. Restarting the
                    // whole delivery is the only safe response: splicing a fresh
                    // start into the middle of a stream would produce
                    // authenticated-looking garbage.
                    throw InboxFailure.retryable(.downloadFailed, .rangeIgnored)
                }
                decryptor.resetBuffer()
                attempt += 1
                log?(.streamInterrupted(taskID: delivery.task.id, attempt: attempt))
            }
        }

        // `end` is the completeness proof: it rejects trailing bytes (a truncated
        // final frame) and any total length other than what the manifest declared.
        do { try decryptor.end(expectedBytes: Int(total)) }
        catch { throw InboxClassify.crypto(error) }
        do { try writer.finish() }
        catch { throw InboxClassify.filesystem(error) }
        // Independent of the writer's own accounting: stat every staged file and
        // compare it against the manifest. The writer could be wrong; the
        // filesystem cannot be, and this is the last chance to notice before
        // anything becomes visible to the user.
        try writer.verifySizes()
    }

    private func streamOnce(_ delivery: InboxDelivery, decryptor: StoreDecryptor,
                            writer: InboxStagingWriter, lastRenew: inout Date) async throws {
        try Task.checkCancellation()
        let start = Int64(decryptor.consumedCipher)
        let stream: InboxBlobStream
        do {
            stream = try await transport.blob(taskID: delivery.task.id,
                                              claimToken: delivery.claimToken,
                                              offset: start)
        } catch let error as InboxError {
            // A rejection with a machine-readable code is central's judgement and
            // is not something a reconnect fixes.
            switch error.rejection {
            case .staleClaim: throw InboxAbandon(.staleClaim)
            case .taskTerminal: throw InboxAbandon(.taskTerminal)
            case .storedObjectUnavailable: throw InboxAbandon(.storedObjectUnavailable)
            default: throw error
            }
        }
        try Task.checkCancellation()
        guard start == 0 || stream.isPartial else { throw InboxError.rangeIgnored }

        for try await chunk in stream.chunks {
            try Task.checkCancellation()
            let plaintexts: [[UInt8]]
            do { plaintexts = try decryptor.push([UInt8](chunk)) }
            catch { throw InboxClassify.crypto(error) }
            for plaintext in plaintexts {
                do { try writer.write(plaintext) }
                catch { throw InboxClassify.filesystem(error) }
            }
            if now().timeIntervalSince(lastRenew) >= renewInterval {
                // A refused renewal means the lease is gone. Finishing the download
                // would be work this receiver is no longer authorised to assert, so
                // it stops here rather than at the end.
                try await renew(delivery, state: .downloading)
                lastRenew = now()
            }
        }
    }

    /// Re-report the current state. An idempotent no-op that renews the lease;
    /// any refusal means the lease is gone.
    private func renew(_ delivery: InboxDelivery, state: InboxTaskState) async throws {
        do {
            try await transport.report(taskID: delivery.task.id,
                                       claimToken: delivery.claimToken,
                                       state: state, errorCode: .none, committed: false)
        } catch {
            log?(.abandoned(taskID: delivery.task.id, cause: .leaseRenewalRefused))
            throw InboxAbandon(.leaseRenewalRefused)
        }
    }

}

/// Fans decrypted plaintext across the staged files in plan order.
///
/// The manifest is the ONLY source of per-file boundaries — the ciphertext stream
/// carries none — so the declared sizes are consumed exactly, and a stream that
/// delivers more data than the manifest accounts for is refused rather than
/// spilling into the next file or a new one.
final class InboxStagingWriter {
    private let plan: [InboxPlanEntry]
    private let stagingFD: Int32
    private var index = 0
    private var current: Int32 = -1
    private var remaining = 0

    init(staging: URL, plan: [InboxPlanEntry]) throws {
        self.plan = plan
        let fd = retryOnEINTR {
            Darwin.open(staging.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard fd >= 0 else { throw InboxStagingError(errno) }
        stagingFD = fd
    }

    deinit {
        if current >= 0 { close(current) }
        close(stagingFD)
    }

    /// Open staged files from `index`, creating and closing zero-size entries
    /// along the way (no ciphertext frames exist for them), until one with bytes
    /// to receive is found or the plan is exhausted.
    private func openNext() throws {
        while current < 0, index < plan.count {
            let entry = plan[index]
            let name = InboxCommit.stagedName(entry)
            // `O_EXCL` because the staging directory was created empty for this
            // task: anything already at this name means the area is not ours to
            // use. The mode is set at creation so the committed file's mode never
            // depends on the umask and never has an exec bit.
            let fd = name.withCString { cName in
                retryOnEINTR {
                    openat(stagingFD, cName,
                           O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                           InboxCommit.fileMode)
                }
            }
            guard fd >= 0 else { throw InboxStagingError(errno) }
            _ = fchmod(fd, InboxCommit.fileMode)
            index += 1
            if entry.size == 0 {
                try syncClose(fd)
                continue
            }
            current = fd
            remaining = entry.size
        }
    }

    func write(_ plaintext: [UInt8]) throws {
        var offset = 0
        while offset < plaintext.count {
            if current < 0 {
                try openNext()
                guard current >= 0 else {
                    // More decrypted data than the manifest declares.
                    throw InboxFailure.terminal(.verifyFailed, .stagedSizeMismatch)
                }
            }
            let take = min(remaining, plaintext.count - offset)
            if take > 0 {
                do { try writeAll(current, plaintext[offset..<(offset + take)]) }
                catch { throw InboxStagingError(errno) }
                offset += take
                remaining -= take
            }
            if remaining == 0 {
                let fd = current
                current = -1
                try syncClose(fd)
            }
        }
    }

    /// Flush trailing zero-size entries, which never receive a write call.
    func finish() throws {
        if current >= 0 {
            let fd = current
            current = -1
            try syncClose(fd)
        }
        try openNext()
    }

    /// Confirm every planned entry exists in staging at exactly its declared size,
    /// and that none carries an executable bit.
    func verifySizes() throws {
        for entry in plan {
            let name = InboxCommit.stagedName(entry)
            guard let st = statAt(parent: stagingFD, name: name) else {
                throw InboxFailure.retryable(.verifyFailed, .stagedSizeMismatch)
            }
            guard (st.st_mode & S_IFMT) == S_IFREG else {
                throw InboxFailure.retryable(.verifyFailed, .stagedSizeMismatch)
            }
            guard Int(st.st_size) == entry.size else {
                throw InboxFailure.retryable(.verifyFailed, .stagedSizeMismatch)
            }
            guard (st.st_mode & 0o111) == 0 else {
                throw InboxFailure.terminal(.verifyFailed, .stagedSizeMismatch)
            }
        }
    }

    func closeAll() {
        if current >= 0 { close(current); current = -1 }
    }

    /// Flush a staged file's contents to stable storage before it is closed. The
    /// link that later publishes it is only meaningful if the bytes behind it
    /// survive a crash.
    private func syncClose(_ fd: Int32) throws {
        let failed = retryOnEINTR { fsync(fd) } != 0
        let code = errno
        close(fd)
        if failed { throw InboxStagingError(code) }
    }
}
