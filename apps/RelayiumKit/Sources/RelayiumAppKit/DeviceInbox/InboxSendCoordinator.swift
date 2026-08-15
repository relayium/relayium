import Foundation
import RelayiumKit

/// One staged delivery, driven to exactly one task central holds.
///
/// The sequence, and why it is this order:
///
///   1. check the target is still a legal one, BEFORE a byte moves. A device
///      that turned receiving off refuses the create, so discovering it after
///      an encrypted upload would cost the user the entire transfer;
///   2. upload the ciphertext as `purpose=device_task` — no link, no file-list
///      row, 404 on the public endpoints even for its owner;
///   3. re-read the device and seal the content key to its CURRENT public key.
///      Sealing last is deliberate: it is the cheap step, so a rotation that
///      happened during a long upload is answered by re-wrapping 80 bytes
///      rather than by sending the file again;
///   4. create the task, which binds the object to it inside one transaction.
///
/// **The one line everything here is organised around** is definitive versus
/// ambiguous:
///
///  * a DEFINITIVE answer that is not a success means central's transaction
///    rolled back and no task can own this ciphertext. The object is invisible
///    — no link, no list row, no control — so leaving it behind is storage the
///    account pays for and cannot see. Release it. What that releases is the
///    OBJECT and the local job that described it; a send that never uploaded an
///    object releases neither, because there is no storage to reclaim and the
///    staged copy may be the last one Relayium holds. See `abandon`.
///  * an AMBIGUOUS outcome — the request never arrived, or its answer was lost
///    — means a delivery MAY be live. Nothing is released, because the mistake
///    in that direction destroys a real transfer of the user's file. The staged
///    bytes, the content key, the plan and above all the idempotency key are
///    kept, and the next attempt converges on the same task instead of queueing
///    a second one.
///
/// Nothing in this type persists or logs a content key: it is read from the
/// keychain into a local, sealed to the target, and zeroed on the way out.
public final class InboxSendCoordinator: @unchecked Sendable {

    /// How many times a create may be repeated after an AMBIGUOUS answer within
    /// one attempt. Each repeat carries the same persisted idempotency key, so a
    /// write that did land converges rather than duplicating.
    ///
    /// Small on purpose. Repeating a request whose answer was lost is a cheap
    /// guess; the real convergence is the lookup that follows, which asks
    /// central what actually exists instead of hoping.
    static let ambiguousCreateAttempts = 3

    /// A positive match in the recent task list can recover a lost create
    /// response. Absence is never treated as proof that no task exists: this is
    /// a bounded, paginated view and a timed-out create may still be committing.
    static let convergenceLookupLimit = 100

    private let store: PendingUploadStore
    private let keys: StoredLinkKeyStore
    private let uploader: CloudUploader
    private let sender: InboxSenderTransport
    /// The account's own stored-object routes, used for exactly one thing:
    /// returning the quota of a `device_task` object that is provably unbound.
    private let objects: AccountManagementService

    public init(store: PendingUploadStore, keys: StoredLinkKeyStore, uploader: CloudUploader,
                sender: InboxSenderTransport, objects: AccountManagementService) {
        self.store = store
        self.keys = keys
        self.uploader = uploader
        self.sender = sender
        self.objects = objects
    }

    // MARK: - delivering

    /// Take one staged delivery all the way to a task, or fail saying exactly
    /// what is known about whether a delivery exists.
    public func deliver(_ plan: PendingUploadPlan, token: String,
                        onProgress: (@Sendable (_ sent: Int, _ total: Int) -> Void)? = nil)
        async throws -> InboxSendResult {
        try Task.checkCancellation()
        guard plan.effectivePurpose == .deviceTask, let target = plan.target else {
            throw InboxSendFailure.notADelivery
        }

        // A plan that already names a task is a previous attempt that succeeded
        // and died during its own tidy-up. Creating again here is the one thing
        // that must never happen, so this branch reads the delivery rather than
        // making a second one.
        if let taskID = plan.deviceTaskId {
            return try await finishRecordedDelivery(plan, target: target, taskID: taskID,
                                                    token: token)
        }

        var contentKey = try await contentKey(for: plan, token: token)
        defer { InboxKeyMaterial.zero(&contentKey) }
        // A sign-out or account switch may have cancelled the owner while the
        // protected store was answering. Never let that old credential cross
        // the first network boundary after the suspension returns.
        try Task.checkCancellation()

        var current = plan
        if current.finalizedStoredId == nil {
            // The fail-fast guard. Its only job is to not spend the user's
            // bandwidth on a target that is going to refuse.
            _ = try await eligibleTarget(target.deviceId, plan: current, token: token)
            try Task.checkCancellation()
            current = try await upload(current, key: contentKey, token: token,
                                       onProgress: onProgress)
            try Task.checkCancellation()
        }

        // Re-read AFTER the upload: this is the key the seal must use, and an
        // upload can take long enough for the one it started with to be stale.
        var sealTarget = try await eligibleTarget(target.deviceId, plan: current, token: token)
        try Task.checkCancellation()
        var resealed = false
        var wrapped: String
        if sealTarget.keyID != current.targetKeyId
            || sealTarget.keyGeneration != current.targetKeyGeneration {
            // A rotation on a send that has already followed one is a dead end,
            // and a definitive one: nothing was created, so the ciphertext this
            // job uploaded is provably unbound and goes back now.
            guard !current.targetKeyWasResealed else {
                try await abandon(current, token: token, includingObject: true)
                throw InboxSendFailure.staleTargetKey
            }
            (current, wrapped) = try persistReseal(current, to: sealTarget,
                                                   contentKey: contentKey)
            resealed = true
        } else if let persisted = current.targetWrappedKey {
            // Sealed boxes are randomized. Reusing this exact durable value is
            // what makes a retry in another process the same request to
            // central, rather than an idempotency conflict under the same key.
            wrapped = persisted
        } else {
            let newlyWrapped = try seal(contentKey, to: sealTarget)
            do {
                current = try store.setTargetWrappedKey(newlyWrapped, for: current)
                wrapped = newlyWrapped
            } catch {
                // No create may leave this process until the randomized request
                // identity is durable. Preserve the whole job and retry the
                // local write later.
                throw InboxSendFailure.recoveryStateWriteFailed
            }
        }

        var ambiguousAttempts = 0
        while ambiguousAttempts < Self.ambiguousCreateAttempts {
            try Task.checkCancellation()
            let request: InboxSendRequest
            do {
                request = try InboxSendRequest(
                    idempotencyKey: target.createIdempotencyKey,
                    storedFileID: try storedObjectID(of: current),
                    wrappedKey: wrapped, targetKeyID: sealTarget.keyID,
                    targetKeyGeneration: sealTarget.keyGeneration)
            } catch {
                // Locally malformed, so nothing was sent and nothing can own the
                // ciphertext. Definitive by construction.
                try await abandon(current, token: token, includingObject: true)
                throw InboxSendFailure.sealFailed
            }

            let creation: InboxTaskCreation
            do {
                creation = try await sender.createTask(targetDeviceID: target.deviceId,
                                                       request)
            } catch {
                // Cancellation is not a refusal and is never authority to
                // release staged bytes or an uploaded object. The account that
                // supplied this credential has gone; preserve the durable plan
                // for an explicit retry after a future sign-in.
                try Task.checkCancellation()
                switch classify(error) {
                case .ambiguous:
                    ambiguousAttempts += 1
                    continue
                case .refused(.staleTargetKey):
                    // The rotation landed between the read above and this
                    // create. One refresh, one reseal, the SAME object and the
                    // SAME idempotency key — the failed create rolled its
                    // binding back, so the retry is the first binding rather
                    // than a rebinding, and no byte is re-uploaded.
                    guard !current.targetKeyWasResealed else {
                        try await abandon(current, token: token, includingObject: true)
                        throw InboxSendFailure.staleTargetKey
                    }
                    sealTarget = try await eligibleTarget(target.deviceId, plan: current,
                                                          token: token)
                    (current, wrapped) = try persistReseal(current, to: sealTarget,
                                                           contentKey: contentKey)
                    resealed = true
                    continue
                case .refused(.idempotencyKeyConflict):
                    // Positive evidence that this key already names a task.
                    // This is reachable for a plan created by an older build,
                    // which could have sent a randomized sealed box without
                    // persisting it. Never delete the bound object; look for
                    // the existing task and otherwise preserve every recovery
                    // input because the recent-task page is not authoritative.
                    return try await converge(current, target: target,
                                              resealed: resealed, token: token)
                case .refused(let token_):
                    // `stored_object_already_bound` is the one refusal that must
                    // NOT release. It says a task we did not create owns these
                    // bytes; deleting them would destroy somebody else's live
                    // delivery in order to tidy up ours.
                    try await abandon(current, token: token,
                                      includingObject: token_ != .storedObjectAlreadyBound)
                    throw InboxSendFailure.refused(token_)
                case .rejected(let status):
                    try await abandon(current, token: token, includingObject: true)
                    throw InboxSendFailure.rejected(status: status)
                case .unauthorized:
                    // Deliberately releases NOTHING. The create provably did not
                    // happen, but this is the one refusal whose remedy is local
                    // and self-healing: sign in and retry with the same
                    // idempotency key. Releasing would also be issued with the
                    // very bearer that was just rejected, so it would fail and
                    // orphan the object anyway — after destroying the user's
                    // staged copy of their own file.
                    throw InboxSendFailure.notAuthorized
                }
            }

            // Deliberately outside the create catch. Once central has returned a
            // task, a local persistence failure is not a network ambiguity and
            // must not be classified into another create attempt. The exact
            // idempotency key remains on disk so a later retry can converge.
            return try await record(creation.task, created: creation.created,
                                    resealed: resealed, plan: current, target: target)
        }

        return try await converge(current, target: target, resealed: resealed, token: token)
    }

    /// Every create attempt was ambiguous. Ask central what actually exists
    /// rather than guess — it is the only honest way out.
    private func converge(_ plan: PendingUploadPlan, target: PendingUploadTarget,
                          resealed: Bool, token: String) async throws -> InboxSendResult {
        let existing: [InboxTask]
        do {
            try Task.checkCancellation()
            existing = try await sender.tasks(targetDeviceID: target.deviceId,
                                              limit: Self.convergenceLookupLimit)
        } catch {
            try Task.checkCancellation()
            // Still unknown. Keep everything: a delivery that may be live must
            // never be destroyed to tidy up a failed request.
            throw InboxSendFailure.unknownOutcome
        }
        if let found = existing.first(where: {
            $0.idempotencyKey == target.createIdempotencyKey
                && $0.storedFileID == plan.finalizedStoredId
        }) {
            return try await record(found, created: false, resealed: resealed,
                                    plan: plan, target: target)
        }
        // This is a paginated recent-task view, not an authoritative lookup by
        // idempotency key. A missing row can mean it fell outside the window or
        // a timed-out create is still committing. Destroying the object here
        // could strand a live task, so the only honest result is unknown.
        throw InboxSendFailure.unknownOutcome
    }

    /// A previous attempt created the task and died before finishing cleanup.
    private func finishRecordedDelivery(_ plan: PendingUploadPlan, target: PendingUploadTarget,
                                        taskID: String, token: String) async throws
        -> InboxSendResult {
        let task: InboxTask
        do {
            task = try await sender.task(targetDeviceID: target.deviceId, taskID: taskID)
        } catch let error as InboxError where error.status == 404 {
            // Central says the task is gone — deleted or expired. Its ciphertext
            // went with it inside the same transaction, so only the local
            // remains are ours to remove.
            try await abandon(plan, token: token, includingObject: false)
            throw InboxSendFailure.noTaskCreated
        } catch {
            throw InboxSendFailure.unknownOutcome
        }
        try await release(plan, token: token, includingObject: false)
        return InboxSendResult(targetDeviceID: target.deviceId, task: task, created: false,
                               resealed: plan.targetKeyWasResealed)
    }

    /// Persist the task id FIRST, then release. The order is the recovery
    /// contract: a process that dies during the tidy-up comes back knowing the
    /// delivery exists rather than starting a second one.
    private func record(_ task: InboxTask, created: Bool, resealed: Bool,
                        plan: PendingUploadPlan, target: PendingUploadTarget) async throws
        -> InboxSendResult {
        let recorded: PendingUploadPlan
        do {
            recorded = try store.setDeviceTask(id: task.id, for: plan)
        } catch {
            // Central has definitively created the task, but cleanup cannot
            // start until its id is durable. Preserve the plan, content key,
            // staged bytes and object ownership so the same idempotency key can
            // converge after local storage becomes writable again.
            throw InboxSendFailure.recoveryStateWriteFailed
        }
        // `includingObject: false` — the object belongs to the task now, and
        // deleting it would strand a delivery central has already promised.
        try await release(recorded, token: nil, includingObject: false)
        return InboxSendResult(targetDeviceID: target.deviceId, task: task, created: created,
                               resealed: resealed)
    }

    // MARK: - reading and cancelling

    /// One task's current state, straight from central.
    public func state(of result: InboxSendResult) async throws -> InboxTask {
        try await sender.task(targetDeviceID: result.targetDeviceID, taskID: result.task.id)
    }

    /// Cancel a queued delivery. Central removes the task and drops its
    /// ciphertext in the same transaction, and refuses outright while a device
    /// holds a live claim — so a refusal here is a real one and is not reported
    /// as a cancellation.
    public func cancel(_ result: InboxSendResult) async throws {
        try await sender.cancelTask(targetDeviceID: result.targetDeviceID,
                                    taskID: result.task.id)
    }

    /// Abandon a staged delivery, releasing whatever it is safe to release.
    ///
    /// The object is dropped only when nothing else can own it: once a task
    /// exists, central's own delete takes the ciphertext with it, and issuing a
    /// second delete would be this app removing bytes it no longer owns.
    public func discard(_ plan: PendingUploadPlan, token: String) async throws {
        guard plan.effectivePurpose == .deviceTask else { throw InboxSendFailure.notADelivery }
        var owned = true
        if let taskID = plan.deviceTaskId, let target = plan.target {
            // Not `try?`. A cancel central refuses leaves a live delivery, and
            // deleting the local record of it would leave the user with a file
            // arriving that nothing here can name or stop.
            try await sender.cancelTask(targetDeviceID: target.deviceId, taskID: taskID)
            owned = false
        }
        try await release(plan, token: token, includingObject: owned)
    }

    // MARK: - steps

    private func contentKey(for plan: PendingUploadPlan, token: String) async throws -> [UInt8] {
        let stored: String?
        do {
            stored = try await keys.key(for: plan.jobId)
        } catch {
            // A locked or temporarily unavailable keychain is not evidence that
            // the key is absent. Releasing here would turn a recoverable local
            // read failure into permanent loss of the staged send.
            throw InboxSendFailure.recoveryStateReadFailed
        }
        guard let stored, let key = try? decodeStoreKey(stored), key.count == 32 else {
            // Nothing on this device can seal these bytes, so a task created now
            // would be one no target could ever open. Whatever was uploaded is
            // unopenable too, which makes releasing it the honest outcome.
            try await abandon(plan, token: token, includingObject: true)
            throw InboxSendFailure.contentKeyMissing
        }
        return key
    }

    /// The device row this plan targets, refused by name when it is no longer a
    /// legal destination.
    private func eligibleTarget(_ deviceID: String, plan: PendingUploadPlan,
                                token: String) async throws -> InboxSendTarget {
        let rows: [InboxDeviceRow]
        do {
            try Task.checkCancellation()
            rows = try await sender.devices()
        } catch {
            try Task.checkCancellation()
            // Neither branch releases anything: not knowing which devices exist
            // is not an answer about this delivery, and a rejected credential is
            // a local problem the user fixes by signing in again.
            if case .unauthorized = classify(error) { throw InboxSendFailure.notAuthorized }
            throw InboxSendFailure.unknownOutcome
        }
        guard let row = rows.first(where: { $0.id == deviceID }) else {
            // Definitive: the account no longer has this device, so no task
            // could ever be created against it.
            try await abandon(plan, token: token, includingObject: true)
            throw InboxSendFailure.targetMissing
        }
        guard let target = InboxTargetEligibility.target(for: row) else {
            let block = InboxTargetEligibility.availability(for: row).block ?? .cannotReceive
            try await abandon(plan, token: token, includingObject: true)
            throw InboxSendFailure.targetUnavailable(block)
        }
        return target
    }

    private func upload(_ plan: PendingUploadPlan, key: [UInt8], token: String,
                        onProgress: (@Sendable (Int, Int) -> Void)?) async throws
        -> PendingUploadPlan {
        do {
            let sources = try store.sources(for: plan)
            let outcome = try await uploader.resume(
                sources: sources, key: key, uploadId: plan.uploadId,
                uploadChunkSize: plan.uploadChunkSize,
                // From the durable plan, never inferred: this field decides the
                // object's authorization model, and a `share` here would publish
                // the user's delivery as a public link.
                purpose: plan.effectivePurpose,
                burnAfterRead: plan.burnAfterRead, ttl: plan.ttl, token: token,
                onUploadSession: { [store] id, chunkSize in
                    // Persisted before bytes move, so a crash cannot orphan a
                    // server session this device can no longer name.
                    try store.setUploadSession(id: id, chunkSize: chunkSize, for: plan)
                },
                onProgress: { sent, total in onProgress?(sent, total) })
            // The session callback has already written a newer plan than the one
            // in hand; finalize against that.
            let latest = store.deviceSendPlans(for: plan.accountId)
                .first(where: { $0.jobId == plan.jobId }) ?? plan
            return try store.markFinalized(latest, storedId: outcome.id)
        } catch {
            try Task.checkCancellation()
            // An interrupted upload is resumable by construction: the plan, its
            // session and its staged bytes all survive.
            throw InboxSendFailure.uploadFailed
        }
    }

    private func persistReseal(_ plan: PendingUploadPlan, to target: InboxSendTarget,
                               contentKey: [UInt8]) throws -> (PendingUploadPlan, String) {
        guard !plan.targetKeyWasResealed else {
            throw InboxSendFailure.staleTargetKey
        }
        let wrapped = try seal(contentKey, to: target)
        do {
            let updated = try store.resealTargetKey(id: target.keyID,
                                                    generation: target.keyGeneration,
                                                    wrappedKey: wrapped, for: plan)
            return (updated, wrapped)
        } catch {
            // The stale create was definitive, but no retry may leave until the
            // new key identity, one-reseal budget and randomized box are one
            // atomic durable fact.
            throw InboxSendFailure.recoveryStateWriteFailed
        }
    }

    private func seal(_ contentKey: [UInt8], to target: InboxSendTarget) throws -> String {
        guard let wrapped = try? InboxKeyMaterial.sealContentKey(algorithm: target.algorithm,
                                                                 targetPublicKey: target.publicKey,
                                                                 contentKey: contentKey) else {
            throw InboxSendFailure.sealFailed
        }
        return wrapped
    }

    private func storedObjectID(of plan: PendingUploadPlan) throws -> String {
        guard let id = plan.finalizedStoredId else { throw InboxSendFailure.sealFailed }
        return id
    }

    // MARK: - release

    /// Give up on this send, giving back only what it actually owns.
    ///
    /// **A send that never reached the server keeps the user's staged files.**
    /// The point of `release` is to return the quota of an object nothing can
    /// see; when no object was ever created there is no quota to return, and
    /// purging the staged copy accomplishes exactly one thing — deleting the
    /// user's files. That matters most for a job copied out of a Share
    /// Extension draft: the draft is retired the moment this plan becomes
    /// durable, so the staged copy IS the last copy Relayium holds, and every
    /// refusal that lands here names a remedy on the other device and invites a
    /// retry. Deleting the bytes would make that invitation false.
    ///
    /// The job stays outstanding instead, with its idempotency key and content
    /// key intact, and the user decides: Retry once the other device is fixed,
    /// or Discard. Discard goes through `release` directly, because a person
    /// asking for their copy to be removed is not this branch.
    private func abandon(_ plan: PendingUploadPlan, token: String?,
                         includingObject: Bool) async throws {
        guard plan.finalizedStoredId != nil else { return }
        try await release(plan, token: token, includingObject: includingObject)
    }

    /// Give back what this send no longer owns.
    ///
    /// `token` is nil when only the local remains are being removed, which is
    /// also the compile-time reason a success path cannot accidentally delete
    /// the object its own task now owns.
    private func release(_ plan: PendingUploadPlan, token: String?,
                         includingObject: Bool) async throws {
        if includingObject, let token, let storedId = plan.finalizedStoredId {
            // Best effort. The server's own collector reclaims an unbound
            // task-purpose object anyway; this only shortens the window in which
            // the account pays for storage it cannot see.
            _ = try? await objects.deleteStoredFile(id: storedId, token: token)
        }
        try? await keys.remove(id: plan.jobId)
        // The tombstone goes down before the bytes, so a removal that fails
        // cannot turn this job back into outstanding work on the next launch.
        let retired = (try? store.markRetired(plan)) ?? plan
        store.purge(retired)
    }

    // MARK: - classification

    /// Which side of the definitive/ambiguous line an error falls on.
    ///
    /// Everything not positively known to be definitive is ambiguous, and that
    /// asymmetry is deliberate: the cost of treating a real refusal as ambiguous
    /// is one wasted lookup, and the cost of the reverse is destroying a live
    /// delivery of the user's file.
    private enum CreateOutcome {
        case ambiguous
        case refused(InboxRejection)
        case rejected(status: Int)
        /// The credential was rejected. Definitive about the create, and the
        /// only definitive answer that releases nothing.
        case unauthorized
    }

    private func classify(_ error: Error) -> CreateOutcome {
        guard let inbox = error as? InboxError else { return .ambiguous }
        switch inbox {
        case .api(let status, let code):
            // A 5xx may have written the row before failing to say so.
            guard status < 500 else { return .ambiguous }
            guard status != 401, status != 403 else { return .unauthorized }
            if let rejection = InboxRejection(rawValue: code) { return .refused(rejection) }
            return .rejected(status: status)
        case .network:
            return .ambiguous
        case .malformedResponse, .unknownProtocolValue:
            // Central answered 2xx in a shape this build cannot read, so a task
            // may well exist. Unknown, not refused.
            return .ambiguous
        default:
            return .ambiguous
        }
    }
}

/// What a delivery became.
public struct InboxSendResult: Equatable, Sendable {
    public let targetDeviceID: String
    public let task: InboxTask
    /// False when this attempt converged onto a task an EARLIER attempt made.
    /// Not cosmetic: reporting a converged retry as a fresh send would tell the
    /// user a second copy of their file is on its way.
    public let created: Bool
    /// Whether this send spent its one refresh-and-reseal following a rotation.
    public let resealed: Bool

    public init(targetDeviceID: String, task: InboxTask, created: Bool, resealed: Bool) {
        self.targetDeviceID = targetDeviceID
        self.task = task
        self.created = created
        self.resealed = resealed
    }
}

/// Why a delivery did not produce a task.
///
/// Closed, and carrying no server text: every case is either a token this
/// protocol already defines or a status. The localized sentence a user reads is
/// the UI layer's job.
public enum InboxSendFailure: Error, Equatable, Sendable {
    /// This plan is an ordinary share. Nothing here applies to it.
    case notADelivery
    /// The content key is not on this device, so nothing could open what was
    /// uploaded even if a task were created.
    case contentKeyMissing
    /// The ciphertext did not finish going up. Resumable: everything is kept.
    case uploadFailed
    /// The account no longer has this device.
    case targetMissing
    /// The device is still here but may not be sent to, for this named reason.
    case targetUnavailable(InboxTargetBlock)
    /// The target rotated its key again after the one reseal was spent.
    case staleTargetKey
    /// The content key could not be wrapped for this target.
    case sealFailed
    /// Central refused the create, by a token this protocol defines.
    case refused(InboxRejection)
    /// Central refused the create with a status this build has no token for.
    case rejected(status: Int)
    /// The session's credential was rejected. NOTHING has been released: the
    /// send is resumable after signing in, under the same idempotency key.
    case notAuthorized
    /// Central created the task but its id could not be made durable locally.
    /// Nothing has been released; retrying the same plan converges through the
    /// persisted idempotency key rather than creating a second delivery.
    case recoveryStateWriteFailed
    /// The durable content key could not be read from local protected storage.
    /// This is distinct from a confirmed missing/corrupt key and releases
    /// nothing, because retrying after protected storage recovers is safe.
    case recoveryStateReadFailed
    /// Central was asked and no task carrying this send's idempotency key
    /// exists. Definitive: the ciphertext has been released.
    case noTaskCreated
    /// Nobody knows whether a delivery exists. NOTHING has been released — not
    /// the ciphertext, not the staged bytes, not the content key, and not the
    /// idempotency key the next attempt needs to converge.
    case unknownOutcome
}
