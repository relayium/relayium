import Foundation
import Darwin
@preconcurrency import RelayiumKit

/// One delivery, end to end: claim material in, a committed file tree — or one
/// committed message — out.
///
/// The pipeline is ordered so that nothing observable is produced until
/// everything has been proven:
///
///     unseal -> decrypt+validate manifest -> CLASSIFY -> plan destinations ->
///       journal the plan -> preflight space -> stream ciphertext into STAGING,
///       authenticating every frame -> verify the WHOLE stream -> report
///       `verifying` -> commit -> report `saved`
///
/// ## Classify first, and the receive folder second
///
/// The manifest is decoded and its KIND decided before anything asks whether
/// this Mac has a usable receive folder, and that ordering is a requirement
/// rather than a tidy-up. A message is not written to the receive folder — it is
/// committed whole to `InboxMessageStore` — so a missing, revoked, unwritable or
/// never-chosen folder has nothing to do with whether it can land. Checking the
/// folder first would block a delivery that does not need it, and would report
/// `directory_unavailable` about a directory this delivery was never going to
/// touch. Only a FILE delivery enters the folder-attention flow.
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
    /// A message landed. A BYTE COUNT and nothing else: the body is not logged,
    /// and there is no case here through which it could be.
    case committedMessage(taskID: String, bytes: Int64)
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
    /// Where a received MESSAGE is committed. Never the receive folder, and
    /// never dependent on it: see `InboxMessageStore`.
    public let messages: InboxMessageStore
    public let account: InboxAccountID
    /// The receive directory, resolved and held under an OPEN security scope by
    /// the caller for the whole delivery. The receiver never resolves a bookmark
    /// itself: whoever owns the scope owns the permission, and splitting the two
    /// is how a scope gets leaked.
    ///
    /// OPTIONAL, because a delivery may not need one. A `nil` root means this
    /// Mac has no usable folder right now; a message still lands, and a file
    /// delivery is the only thing that reports `directory_unavailable`.
    public let root: URL?
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
                journals: InboxJournalStore, messages: InboxMessageStore,
                account: InboxAccountID, root: URL?,
                now: @escaping @Sendable () -> Date = { Date() },
                log: InboxLog? = nil,
                renewInterval: TimeInterval = Double(InboxProtocol.defaultLeaseSeconds) / 3,
                streamAttempts: Int = 5,
                freeBytes: @escaping @Sendable (URL) -> Int64? = InboxSpace.freeBytes) {
        self.transport = transport
        self.keys = keys
        self.journals = journals
        self.messages = messages
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

        do {
            if let existing = try journals.load(task.id), existing.isCompleted {
                try validateJournalIdentity(existing, for: task)
                if existing.contentKind == .file, let root {
                    // A crash between the last journal write and the staging
                    // cleanup leaves an empty per-task directory behind —
                    // `commit` removes each staged source as it records it.
                    // Inert, but nothing else would ever collect it, because
                    // this path never calls `prepareStaging`. A message has no
                    // staging area at all.
                    InboxCommit.cleanStaging(root: root, taskID: task.id)
                }
                log?(.alreadyCommittedLocally(taskID: task.id, files: existing.plan.count))
                return .alreadyCommitted
            }
        } catch {
            throw InboxClassify.filesystem(error)
        }

        var contentKey = try await unsealContentKey(delivery)
        defer { InboxKeyMaterial.zero(&contentKey) }

        let (manifest, total) = try openManifest(delivery, key: contentKey)
        // The classification, and it happens HERE — before the receive folder is
        // consulted, before a destination is planned, before space is measured
        // against a volume this delivery may never write to.
        switch manifest.kind {
        case .text:
            return try await deliverMessage(delivery, key: contentKey, total: total)
        case .file:
            return try await deliverFiles(delivery, key: contentKey, manifest: manifest,
                                          total: total)
        case nil:
            // `validate` refuses an empty manifest, so this is unreachable from
            // a decoded document. Fails closed rather than defaulting to either
            // kind: a delivery whose kind this build cannot name is one it must
            // not commit anywhere.
            throw InboxFailure.terminal(.verifyFailed, .manifestInvalid)
        }
    }

    /// A file delivery: planned, staged, verified and linked into the user's own
    /// receive folder, and nowhere else.
    private func deliverFiles(_ delivery: InboxDelivery, key: [UInt8],
                              manifest: InboxManifestV2, total: Int64) async throws -> Outcome {
        let task = delivery.task
        // The one place the folder is required, and the only delivery that can
        // be blocked by it.
        guard let root else {
            throw InboxFailure.attention(.directoryUnavailable, .directoryUnavailable)
        }
        var journal = try planAndJournal(delivery, manifest: manifest, root: root)

        guard InboxSpace.hasRoom(at: root, for: total, freeBytes: freeBytes) else {
            throw InboxFailure.attention(.diskFull, .notEnoughSpace)
        }

        let staging: URL
        do { staging = try InboxCommit.prepareStaging(root: root, taskID: task.id) }
        catch { throw InboxClassify.filesystem(error) }
        journal.staging = staging.path
        do { try journals.save(&journal, now: now()) }
        catch { throw InboxClassify.filesystem(error) }

        let writer: InboxStagingWriter
        do { writer = try InboxStagingWriter(staging: staging, plan: journal.plan) }
        catch {
            InboxCommit.cleanStaging(root: root, taskID: task.id)
            throw InboxClassify.filesystem(error)
        }
        defer { writer.closeAll() }
        do {
            try await stream(delivery, key: key, sink: writer, total: total)
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

    /// A message delivery: held whole in memory, proven to be exactly the
    /// declared number of valid UTF-8 bytes, and committed to the protected
    /// per-account message store.
    ///
    /// Nothing in this path resolves the receive folder, plans a destination,
    /// creates a staging area, or measures the volume the user chose. A message
    /// is bounded at 64 KiB by the protocol precisely so a receiver can hold one
    /// in memory rather than needing a staging path of its own — which is also
    /// what frees it from the folder grant entirely.
    private func deliverMessage(_ delivery: InboxDelivery, key: [UInt8],
                                total: Int64) async throws -> Outcome {
        let task = delivery.task
        var journal = try messageJournal(delivery)

        guard InboxSpace.hasRoom(at: messages.directory, for: total, freeBytes: freeBytes) else {
            throw InboxFailure.attention(.diskFull, .notEnoughSpace)
        }

        let buffer = InboxMessageBuffer(declared: Int(total))
        try await stream(delivery, key: key, sink: buffer, total: total)

        // The bytes authenticated and are exactly as long as the manifest said.
        // That still does not make them a MESSAGE: a sender may be broken or
        // hostile, and a receiver that repaired invalid UTF-8 would show the
        // user something nobody wrote. Refused, terminally — the same bytes fail
        // the same way on every attempt.
        guard let text = buffer.message(), InboxMessageStore.isAcceptable(text) else {
            throw InboxFailure.terminal(.verifyFailed, .messageMalformed)
        }

        try Task.checkCancellation()
        try await renew(delivery, state: .verifying)
        try Task.checkCancellation()

        // Store first, journal second. A crash between them costs a re-download
        // that rewrites the SAME record at the SAME name — the store is keyed by
        // task id — so the window produces a duplicate of nothing. The reverse
        // order would let a journal claim a message that is not there.
        do { try messages.commit(id: task.id, text: text, receivedAt: now()) }
        catch { throw InboxClassify.filesystem(error) }

        journal.committed = [task.id]
        journal.messageBytes = Int(total)
        journal.isCompleted = true
        journal.completedAt = Int64(now().timeIntervalSince1970)
        do { try journals.save(&journal, now: now()) }
        catch { throw InboxClassify.filesystem(error) }

        log?(.committedMessage(taskID: task.id, bytes: total))
        return .committed
    }

    /// Journal a message delivery before it is committed.
    ///
    /// Its `root` is the MESSAGE STORE's directory, not the receive folder: that
    /// is where this delivery is going, and pinning it is what stops a journal
    /// written for one account's store being resumed against another's.
    private func messageJournal(_ delivery: InboxDelivery) throws -> InboxJournal {
        let task = delivery.task
        let existing: InboxJournal?
        do { existing = try journals.load(task.id) }
        catch { throw InboxClassify.filesystem(error) }
        if let existing {
            try validateJournalIdentity(existing, for: task, kind: .text)
            return existing
        }
        var journal = InboxJournal(taskID: task.id, storedFileID: task.storedFileID,
                                   targetKeyID: task.targetKeyID,
                                   root: messages.directory.standardizedFileURL.path,
                                   plan: [],
                                   plannedAt: Int64(now().timeIntervalSince1970),
                                   kind: .text)
        do { try journals.save(&journal, now: now()) }
        catch { throw InboxClassify.filesystem(error) }
        return journal
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
                              key: [UInt8]) throws -> (InboxManifestV2, Int64) {
        guard let encoded = Data(base64Encoded: delivery.encManifest) else {
            throw InboxFailure.terminal(.verifyFailed, .manifestUnreadable)
        }
        let manifest: InboxManifestV2
        do {
            // The DEDICATED v2 codec, never `decryptManifestRaw`. The shared
            // Stored-Wire manifest has no content kind, so decoding this
            // document with it would read a message as a nameless file — and it
            // is the one structure that says which of the two a delivery is.
            //
            // RAW names throughout: nothing here strips control or bidi
            // characters for display, because a stripped name is one this device
            // would then create under a name nobody chose. The codec refuses
            // them outright and the planner refuses what is left.
            manifest = try InboxManifest.open(key: key, sealed: [UInt8](encoded))
        } catch {
            throw InboxClassify.crypto(error)
        }
        let total = Int64(manifest.totalSize)
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
    private func planAndJournal(_ delivery: InboxDelivery, manifest: InboxManifestV2,
                                root: URL) throws -> InboxJournal {
        let task = delivery.task
        let existing: InboxJournal?
        do { existing = try journals.load(task.id) }
        catch { throw InboxClassify.filesystem(error) }

        if let existing, !existing.plan.isEmpty {
            try validateJournalIdentity(existing, for: task, kind: .file)
            return existing
        }

        let plan: [InboxPlanEntry]
        do { plan = try InboxDestinationPlan.plan(root: root, files: manifest.items) }
        catch { throw InboxClassify.filesystem(error) }

        var journal = InboxJournal(taskID: task.id, storedFileID: task.storedFileID,
                                   targetKeyID: task.targetKeyID,
                                   root: root.standardizedFileURL.path,
                                   plan: plan,
                                   plannedAt: Int64(now().timeIntervalSince1970),
                                   kind: .file)
        do { try journals.save(&journal, now: now()) }
        catch { throw InboxClassify.filesystem(error) }
        return journal
    }

    /// A task id names the journal file, but it is not sufficient identity for
    /// resumption. Refuse a stale or replaced journal unless every immutable
    /// delivery binding and the receive root still match this claim.
    ///
    /// `kind` is what this delivery turned out to be, or nil at the top of
    /// `deliver`, where the manifest has not been opened yet and the journal's
    /// own answer is the only one available.
    private func validateJournalIdentity(_ journal: InboxJournal, for task: InboxTask,
                                         kind: InboxManifestKind? = nil) throws {
        guard journal.taskID == task.id,
              journal.storedFileID == task.storedFileID,
              journal.targetKeyID == task.targetKeyID,
              // The kind is part of the identity too. A journal that describes
              // files cannot be resumed as a message or the other way round:
              // they commit to different places, so continuing under the wrong
              // one is how a delivery lands twice or lands nowhere.
              kind == nil || journal.contentKind == kind else {
            throw InboxFailure.terminal(.internal, .journalUnreadable)
        }
        // Which root a journal must still match depends on what it describes: a
        // message was journalled against the MESSAGE STORE, which does not move
        // with the user's folder grant, so a folder change is irrelevant to it.
        let expected = journal.contentKind == .text
            ? messages.directory.standardizedFileURL.path
            : root?.standardizedFileURL.path
        guard journal.root == expected else {
            // The receive directory changed under an unfinished or unreported
            // task — or is unavailable right now, so this build cannot prove it
            // is the same one. Reusing absolute destinations from the old grant
            // could land the same delivery in two places.
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
    private func stream(_ delivery: InboxDelivery, key: [UInt8], sink: InboxPayloadSink,
                        total: Int64) async throws {
        let writer = sink
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
        // Independent of the sink's own accounting: for files, stat every staged
        // entry and compare it against the manifest; for a message, re-measure
        // what was collected. The sink could be wrong; what it wrote cannot be,
        // and this is the last chance to notice before anything is committed.
        try writer.verifyDelivered()
    }

    private func streamOnce(_ delivery: InboxDelivery, decryptor: StoreDecryptor,
                            writer: InboxPayloadSink, lastRenew: inout Date) async throws {
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

/// Where a delivery's decrypted payload goes while it is still unproven.
///
/// Two implementations, and the split is the file/message boundary itself: a
/// file tree lands in a staging directory inside the user's receive folder,
/// while a message is held in memory and never touches that folder at all. The
/// streaming loop is written against this protocol so neither kind can acquire
/// the other's obligations by accident — there is no way to reach the staging
/// area from the message path, because the message path never has one.
protocol InboxPayloadSink: AnyObject {
    /// One run of authenticated plaintext, in delivery order.
    func write(_ plaintext: [UInt8]) throws
    /// The stream ended. Flush anything the writes alone would have left.
    func finish() throws
    /// Prove what was written matches what the manifest declared. Called after
    /// the whole authenticated stream has been consumed and before anything is
    /// committed.
    func verifyDelivered() throws
}

/// Collects one message in memory, bounded by its declared length.
///
/// In memory because the protocol bounds a message at 64 KiB precisely so a
/// receiver can do this rather than build a second staging path — and because a
/// message that never reaches a temporary file is one that cannot be left behind
/// in the user's folder by a crash.
final class InboxMessageBuffer: InboxPayloadSink {
    private let declared: Int
    private var bytes: [UInt8] = []

    init(declared: Int) {
        self.declared = declared
        bytes.reserveCapacity(min(max(declared, 0), InboxManifest.maxTextBytes))
    }

    /// Refuses the first byte past the declared length rather than growing.
    /// The stream is authenticated, so an over-long one is a sender that lied in
    /// its own manifest — and an unbounded append here would be a memory
    /// exhaustion any sender could ask for.
    func write(_ plaintext: [UInt8]) throws {
        guard bytes.count + plaintext.count <= declared else {
            throw InboxFailure.terminal(.verifyFailed, .messageMalformed)
        }
        bytes.append(contentsOf: plaintext)
    }

    func finish() throws {}

    func verifyDelivered() throws {
        guard bytes.count == declared else {
            throw InboxFailure.retryable(.verifyFailed, .stagedSizeMismatch)
        }
    }

    /// The message, or nil if these bytes are not exactly one valid UTF-8 string
    /// of the declared length.
    ///
    /// The re-encode is not belt and braces. `String(bytes:encoding:)` is the
    /// strict initialiser, but the round trip is what proves it: if any decoder
    /// on any future OS version ever repaired an invalid sequence into U+FFFD,
    /// the re-encoded bytes would differ and this returns nil instead of handing
    /// the user something the sender did not write.
    func message() -> String? {
        guard bytes.count == declared,
              let text = String(bytes: bytes, encoding: .utf8),
              Array(text.utf8) == bytes else { return nil }
        return text
    }
}

/// Fans decrypted plaintext across the staged files in plan order.
///
/// The manifest is the ONLY source of per-file boundaries — the ciphertext stream
/// carries none — so the declared sizes are consumed exactly, and a stream that
/// delivers more data than the manifest accounts for is refused rather than
/// spilling into the next file or a new one.
final class InboxStagingWriter: InboxPayloadSink {
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

    func verifyDelivered() throws { try verifySizes() }

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
