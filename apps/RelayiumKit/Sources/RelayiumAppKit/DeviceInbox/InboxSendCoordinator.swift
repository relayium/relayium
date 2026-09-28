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
///    rolled back and no task can own this ciphertext. The local job that
///    described it is released. The object itself is invisible — no link, no
///    list row, no control — and nothing is issued for it: the server refuses
///    the share-delete route for task-purpose objects, and its collector
///    reclaims an unbound one — at its expiry while its finalize record still
///    names it (G34-N5, so a lost finalize answer stays recoverable), otherwise
///    after the bind grace (protocol §27). A
///    send that never uploaded an object releases nothing, because the staged
///    copy may be the last one Relayium holds. See `abandon`.
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
    /// Bounds of the recoverable finalize; tests shorten the waits.
    let finalizePolicy: FinalizeRecoveryPolicy

    /// `store` must be the protected Device Inbox store
    /// (`PendingUploadSupport.deviceStore`); `deliver` refuses any other.
    public convenience init(store: PendingUploadStore, keys: StoredLinkKeyStore, uploader: CloudUploader,
                sender: InboxSenderTransport) {
        self.init(store: store, keys: keys, uploader: uploader, sender: sender,
                  finalizePolicy: FinalizeRecoveryPolicy())
    }

    init(store: PendingUploadStore, keys: StoredLinkKeyStore, uploader: CloudUploader,
         sender: InboxSenderTransport, finalizePolicy: FinalizeRecoveryPolicy) {
        self.store = store
        self.keys = keys
        self.uploader = uploader
        self.sender = sender
        self.finalizePolicy = finalizePolicy
    }

    // MARK: - delivering

    /// Take one staged delivery all the way to a task, or fail saying exactly
    /// what is known about whether a delivery exists.
    public func deliver(_ plan: PendingUploadPlan, token: String,
                        onProgress: (@Sendable (_ sent: Int, _ total: Int) -> Void)? = nil)
        async throws -> InboxSendResult {
        try Task.checkCancellation()
        guard plan.effectivePurpose == .deviceTask, plan.target != nil else {
            throw InboxSendFailure.notADelivery
        }
        // Ownership before ANY request or write, on every branch. Only the
        // protected root drives deliveries, and only a job it owns
        // exclusively: an id that also exists in the shared root is a conflict
        // neither copy is executed from.
        guard store.isProtectedDeviceStore else { throw InboxSendFailure.notADelivery }
        switch store.ownership(of: plan.jobId) {
        case .owned: break
        case .conflict: throw InboxSendFailure.ownershipConflict
        case .missing: throw InboxSendFailure.notADelivery
        }
        // Decisions about the upload are made from the plan on DISK, never a
        // snapshot the caller has been holding: a finalizing phase written by
        // an attempt that was cancelled a moment ago must be honoured.
        guard let plan = store.ownedDevicePlan(jobId: plan.jobId),
              let target = plan.target else {
            throw InboxSendFailure.notADelivery
        }

        // A plan that already names a task is a previous attempt that succeeded
        // and died during its own tidy-up. Creating again here is the one thing
        // that must never happen, so this branch reads the delivery rather than
        // making a second one.
        // A recorded terminal disposition stops EVERY branch — before the
        // recorded-task tidy-up, before any create, whether or not an object id
        // is also recorded — with no request of any kind. The one exception is
        // the disposition this build itself writes for a pre-v2 delivery with a
        // recorded object (`olderVersion` + object): it keeps its read-only
        // convergence below, and once that convergence has recorded the task an
        // earlier build's lost create made (a crash before the tidy-up leaves
        // `olderVersion` + task), the recorded-task branch finishes it. No other
        // terminal can gain a task (`setDeviceTask` refuses). A value this build does not recognise is
        // never read as a known one, and never as permission to continue.
        if case .terminal(let terminal) = plan.deviceSessionState,
           !(terminal == .olderVersion && !plan.speaksInboxV2 && plan.finalizedStoredId != nil) {
            throw InboxSendFailure.uploadUnavailable(InboxUploadUnavailable(terminal, plan: plan))
        }

        if let taskID = plan.deviceTaskId {
            return try await finishRecordedDelivery(plan, target: target, taskID: taskID)
        }

        // A pre-v2 delivery whose object an earlier build recorded may ALSO
        // have sent its create and lost the answer, so a delivery may exist.
        // It is resolved READ-ONLY, every attempt: a positive match on this
        // job's idempotency key and stored object is recorded and finished; no
        // match leaves it unknown. Never a create, a re-upload or a key
        // rotation: the ciphertext is framed for a protocol this build does not
        // continue.
        if !plan.speaksInboxV2, plan.finalizedStoredId != nil {
            return try await convergeLegacyFinalized(plan, target: target)
        }

        // An upload session this build cannot explain stops here, before the
        // content key is read and before any request. (Terminal records were
        // stopped above; a recorded object no longer needs its session.)
        if plan.finalizedStoredId == nil, case .unknown = plan.deviceSessionState {
            throw InboxSendFailure.uploadOutcomeUnknown
        }

        // A pre-v2 delivery with a session but no recorded object has an
        // unknown upload outcome under framing this build cannot continue. It
        // is NOT restarted: that would rotate the key and upload a second object
        // while the first may be counted. No create can have been sent (an
        // earlier build records the object before any create), so no delivery
        // can arrive. It stops, retained; a new send is the user's own.
        if !plan.speaksInboxV2, plan.uploadId != nil {
            do {
                try store.recordTerminal(.olderVersion, uploadId: plan.uploadId, for: plan)
            } catch {
                throw InboxSendFailure.recoveryStateWriteFailed
            }
            throw InboxSendFailure.uploadUnavailable(.olderVersion)
        }

        // A delivery staged before this build may already have fed a server
        // session whose frame 0 is the shared Stored-Wire manifest. It is
        // restarted here — before the content key is read, before the target is
        // checked, and before a byte moves — because everything below assumes
        // the object it is continuing was framed the way this build frames one.
        //
        // Checked on the plan the CALLER holds and applied to the plan on DISK,
        // and deliberately after the recorded-task branch above: a job whose
        // task exists is not uploading anything and must keep its convergence
        // state exactly as the attempt that created it left it.
        let staged = plan.speaksInboxV2 ? plan : try await restartOnInboxV2(plan)

        var contentKey = try await contentKey(for: staged)
        defer { InboxKeyMaterial.zero(&contentKey) }
        // A sign-out or account switch may have cancelled the owner while the
        // protected store was answering. Never let that old credential cross
        // the first network boundary after the suspension returns.
        try Task.checkCancellation()

        var current = staged
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
            // job uploaded is provably unbound and the job is released now.
            guard !current.targetKeyWasResealed else {
                try await abandon(current)
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
                try await abandon(current)
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
                        try await abandon(current)
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
                                              resealed: resealed)
                case .refused(let token_):
                    // Includes `stored_object_already_bound`, which says a task
                    // we did not create owns these bytes. Only the local job is
                    // released; no refusal issues anything for the object.
                    try await abandon(current)
                    throw InboxSendFailure.refused(token_)
                case .rejected(let status):
                    try await abandon(current)
                    throw InboxSendFailure.rejected(status: status)
                case .unauthorized:
                    // Deliberately releases NOTHING. The create provably did not
                    // happen, but this is the one refusal whose remedy is local
                    // and self-healing: sign in and retry with the same
                    // idempotency key. Releasing would destroy the user's
                    // staged copy of their own file for nothing.
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

        return try await converge(current, target: target, resealed: resealed)
    }

    /// Every create attempt was ambiguous. Ask central what actually exists
    /// rather than guess — it is the only honest way out.
    private func converge(_ plan: PendingUploadPlan, target: PendingUploadTarget,
                          resealed: Bool) async throws -> InboxSendResult {
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

    /// A pre-v2 delivery that reached a finalized object: look for the task an
    /// earlier build may have created, and change nothing on central.
    private func convergeLegacyFinalized(_ plan: PendingUploadPlan,
                                         target: PendingUploadTarget) async throws
        -> InboxSendResult {
        try Task.checkCancellation()
        if let existing = try? await sender.tasks(targetDeviceID: target.deviceId,
                                                  limit: Self.convergenceLookupLimit),
           let found = existing.first(where: {
               $0.idempotencyKey == target.createIdempotencyKey
                   && $0.storedFileID == plan.finalizedStoredId
           }) {
            try Task.checkCancellation()
            return try await record(found, created: false, resealed: plan.targetKeyWasResealed,
                                    plan: plan, target: target)
        }
        try Task.checkCancellation()
        // Absence in a bounded recent-task page is not proof: the delivery may
        // exist outside it. Recorded as terminal for this build, presented as
        // "may still arrive", and looked up again on every Retry.
        do {
            try store.recordTerminal(.olderVersion, uploadId: plan.uploadId, for: plan)
        } catch {
            throw InboxSendFailure.recoveryStateWriteFailed
        }
        throw InboxSendFailure.uploadUnavailable(.olderVersionDeliveryUnknown)
    }

    /// A previous attempt created the task and died before finishing cleanup.
    private func finishRecordedDelivery(_ plan: PendingUploadPlan, target: PendingUploadTarget,
                                        taskID: String) async throws
        -> InboxSendResult {
        let task: InboxTask
        do {
            task = try await sender.task(targetDeviceID: target.deviceId, taskID: taskID)
        } catch let error as InboxError where error.status == 404 {
            // Central says the task is gone — deleted or expired. Its ciphertext
            // went with it inside the same transaction, so only the local
            // remains are ours to remove.
            try await abandon(plan)
            throw InboxSendFailure.noTaskCreated
        } catch {
            throw InboxSendFailure.unknownOutcome
        }
        try await release(plan)
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
        // Local remains only: the object belongs to the task now.
        try await release(recorded)
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

    /// Abandon a staged delivery and remove its local remains.
    ///
    /// Once a task exists, central's own delete takes the ciphertext with it.
    /// An object no task owns is left to the server's collector (protocol §27);
    /// no stored-file delete is issued for it.
    public func discard(_ plan: PendingUploadPlan) async throws {
        guard plan.effectivePurpose == .deviceTask else { throw InboxSendFailure.notADelivery }
        // Ownership BEFORE any request: a job whose id the shared root also
        // holds is a conflict nobody acts on — no cancel, no key removal, no
        // tombstone, no deletion — even when a stale in-memory plan asks.
        try refuseUnlessDiscardable(plan.jobId)
        if let taskID = plan.deviceTaskId, let target = plan.target {
            // Not `try?`. A cancel central refuses leaves a live delivery, and
            // deleting the local record of it would leave the user with a file
            // arriving that nothing here can name or stop.
            try await sender.cancelTask(targetDeviceID: target.deviceId, taskID: taskID)
        }
        try await release(plan)
    }

    // MARK: - steps

    /// Put a pre-v2 delivery back at byte zero, with a content key that has
    /// never sealed anything.
    ///
    /// **The key rotation is not hygiene, it is the reason this cannot be a
    /// plan edit alone.** Frame 0 is sealed at AEAD sequence 0 under the
    /// content key, and the v2 document is not the v1 one — so re-sealing frame
    /// 0 for the same job under the same key would encrypt DIFFERENT plaintext
    /// under a nonce that key has already used. That is nonce reuse in the
    /// strict sense: it exposes both manifests to anyone holding the old
    /// ciphertext and hands them the authentication key for forging frames.
    /// A fresh content key makes the restarted upload an unrelated stream.
    ///
    /// The old object becomes unopenable the moment its key is replaced, which
    /// is the honest end state for ciphertext no task will ever own: central's
    /// own collector reclaims an unbound `device_task` object, and nothing in it
    /// was ever readable by anyone but this device.
    ///
    /// **The order is the crash contract.** The key is rotated first and the
    /// plan is rewritten second, so a crash in between leaves a plan that still
    /// says "legacy" — and the next attempt runs this whole step again, which is
    /// exactly what it should do. The reverse order would leave a plan claiming
    /// v2 while the key that sealed the v1 header was still in place, and the
    /// window would be one where nothing knows a restart is owed.
    ///
    /// Both failures are `recoveryStateWriteFailed`: nothing has been sent,
    /// nothing is released, the staged bytes and the idempotency key stay, and a
    /// later attempt repeats the step once local storage is writable.
    private func restartOnInboxV2(_ plan: PendingUploadPlan) async throws -> PendingUploadPlan {
        var fresh = generateStoreKey()
        defer { InboxKeyMaterial.zero(&fresh) }
        do {
            try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(fresh))
        } catch {
            throw InboxSendFailure.recoveryStateWriteFailed
        }
        do {
            return try store.restartForInboxV2(plan)
        } catch {
            throw InboxSendFailure.recoveryStateWriteFailed
        }
    }

    private func contentKey(for plan: PendingUploadPlan) async throws -> [UInt8] {
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
            try await abandon(plan)
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
            try await abandon(plan)
            throw InboxSendFailure.targetMissing
        }
        guard let target = InboxTargetEligibility.target(for: row) else {
            let block = InboxTargetEligibility.availability(for: row).block ?? .cannotReceive
            try await abandon(plan)
            throw InboxSendFailure.targetUnavailable(block)
        }
        // The capability gate for a MESSAGE, re-checked here rather than trusted
        // from the moment the send was staged: a device can drop the claim by
        // downgrading between the two.
        //
        // What the absent token means is that the target has NOT promised a
        // user-visible message surface — not that the message becomes a file. A
        // v2 receiver classifies the sealed kind before it consults any folder:
        // the CLI and the headless receiver refuse a text delivery outright, and
        // a native build without the surface may commit the message to its own
        // store and never show it to anyone. Either way the sender would have
        // promised a message its recipient cannot read. Definitive — the remedy
        // is on that machine — so an uploaded job is released.
        //
        // A FILE delivery deliberately never reaches this branch. Requiring
        // `inbox.text.v1` of it would refuse ordinary file sends to every
        // receiver that does not render messages.
        if plan.effectiveDeliveryKind == .text, !InboxTargetEligibility.canReceiveText(row) {
            try await abandon(plan)
            throw InboxSendFailure.textUnsupported
        }
        return target
    }

    private func upload(_ plan: PendingUploadPlan, key: [UInt8], token: String,
                        onProgress: (@Sendable (Int, Int) -> Void)?) async throws
        -> PendingUploadPlan {
        // The invariant `deliver` establishes, restated where it is relied on: a
        // v2 manifest may only be sealed over a session this build's framing
        // opened. Deliberately NOT a terminal refusal — it releases nothing and
        // deletes nothing, because the remedy for a plan that reached here
        // un-restarted is to restart it, not to destroy the user's staged copy.
        guard plan.speaksInboxV2 else { throw InboxSendFailure.uploadFailed }
        // Built BEFORE the session is opened, and outside the catch below, so a
        // plan that cannot produce a valid v2 manifest fails as itself rather
        // than as a resumable upload failure the user would be invited to retry
        // forever. Every bound the receiver applies is applied here first.
        let manifest: UploadManifest
        do {
            manifest = try InboxSendManifest.sealed(for: plan)
        } catch {
            // Terminal and definitive: the names and sizes are the plan's own,
            // so every later attempt would rebuild exactly the same refusal.
            // Nothing has been uploaded yet, so `abandon` releases only what a
            // never-uploaded send owns — which is nothing.
            try await abandon(plan)
            throw InboxSendFailure.unsendableContent
        }
        // What the durable record proves about the recorded session decides
        // everything the uploader may do with it (see `resumeRecoverable`).
        let recorded: DeliverySession?
        switch plan.deviceSessionState {
        case .noSession:
            recorded = nil
        case .uploading(let id), .finalizing(let id), .unproven(let id):
            guard let chunkSize = plan.uploadChunkSize else {
                throw InboxSendFailure.uploadOutcomeUnknown
            }
            let provenance: DeliverySessionProvenance
            switch plan.deviceSessionState {
            case .uploading: provenance = .trustedUploading
            case .finalizing: provenance = .finalizing
            default: provenance = .unproven
            }
            recorded = DeliverySession(uploadId: id, chunkSize: chunkSize, provenance: provenance)
        case .unknown, .terminal:
            // Unreachable: `deliver` stops these before the key is read.
            throw InboxSendFailure.uploadOutcomeUnknown
        }
        let outcome: RecoveredUpload
        do {
            let sources = try store.sources(for: plan)
            outcome = try await uploader.resumeRecoverable(
                sources: sources, key: key, session: recorded,
                // From the durable plan, never inferred: this field decides the
                // object's authorization model, and a `share` here would publish
                // the user's delivery as a public link.
                purpose: plan.effectivePurpose,
                // Likewise from the plan: the dedicated Device Inbox v2 document,
                // never the shared Stored-Wire manifest. A reaped session that
                // re-inits rebuilds this same value, so the replacement object
                // carries the same manifest (and the same ciphertext).
                manifest: manifest,
                ttl: plan.ttl, token: token, policy: finalizePolicy,
                onUploadSession: { [store] id, chunkSize in
                    // Persisted, with its trusted phase, before bytes move.
                    try store.setUploadSession(id: id, chunkSize: chunkSize, for: plan)
                },
                onFinalizing: { [store] id in
                    // Persisted before EVERY finalize request. If this throws,
                    // no request is sent.
                    try store.markFinalizing(uploadId: id, for: plan)
                },
                onProgress: { sent, total in onProgress?(sent, total) })
        } catch {
            try Task.checkCancellation()
            // A cancellation raised inside the upload (a cancelled sleep or
            // request) is a cancellation, never an upload failure.
            if error is CancellationError { throw error }
            // Nothing below releases anything: the plan, its session, its phase
            // and its staged bytes all survive every one of these.
            switch error {
            case DeliveryUploadError.finalizeStateNotRecorded:
                throw InboxSendFailure.recoveryStateWriteFailed
            case DeliveryUploadError.unconfirmed, DeliveryUploadError.inconsistentSession:
                throw InboxSendFailure.uploadOutcomeUnknown
            case DeliveryUploadError.notCompleted(let finalizeOutcome):
                let terminal = PendingDeviceTerminal(finalizeOutcome)
                let current = store.ownedDevicePlan(jobId: plan.jobId) ?? plan
                do {
                    try store.recordTerminal(terminal, uploadId: current.uploadId, for: current)
                } catch {
                    // Central's answer is durable on ITS side; the next attempt
                    // reads the same answer and records it then.
                    throw InboxSendFailure.recoveryStateWriteFailed
                }
                throw InboxSendFailure.uploadUnavailable(InboxUploadUnavailable(terminal, plan: current))
            default:
                break
            }
            // Preserve typed refusals for presentation only. Recovery, ownership
            // and cleanup are identical to an interrupted network upload.
            switch error as? CloudError {
            case .quota: throw InboxSendFailure.uploadQuota
            case .dailyQuota: throw InboxSendFailure.uploadDailyQuota
            case .monthlyTraffic: throw InboxSendFailure.uploadMonthlyTraffic
            case .rateLimited: throw InboxSendFailure.uploadRateLimited
            case .unauthorized: throw InboxSendFailure.notAuthorized
            default: throw InboxSendFailure.uploadFailed
            }
        }
        // Deliberately OUTSIDE the upload catch. Central has an object; failing
        // to record it locally is not an interrupted upload, and must never be
        // reported as one — a Retry of `uploadFailed` is exactly the path that
        // used to upload everything a second time. The finalizing phase stays
        // on disk, so the next attempt recovers this same object.
        do {
            let latest = store.ownedDevicePlan(jobId: plan.jobId) ?? plan
            return try store.markFinalized(latest, storedId: outcome.id, uploadId: outcome.uploadId)
        } catch {
            throw InboxSendFailure.recoveryStateWriteFailed
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
    /// When no object was ever created, purging the staged copy accomplishes
    /// exactly one thing — deleting the user's files. That matters most for a
    /// job copied out of a Share Extension draft: the draft is retired the
    /// moment this plan becomes durable, so the staged copy IS the last copy
    /// Relayium holds, and every refusal that lands here names a remedy on the
    /// other device and invites a retry. Deleting the bytes would make that
    /// invitation false.
    ///
    /// The job stays outstanding instead, with its idempotency key and content
    /// key intact, and the user decides: Retry once the other device is fixed,
    /// or Discard. Discard goes through `release` directly, because a person
    /// asking for their copy to be removed is not this branch.
    private func abandon(_ plan: PendingUploadPlan) async throws {
        guard plan.finalizedStoredId != nil else { return }
        try await release(plan)
    }

    /// Remove this send's local remains: its content key, its plan and its
    /// staged bytes.
    ///
    /// Nothing is issued for the uploaded object, bound or not. `DELETE
    /// /api/files/{id}` is the account's share-delete route and the server
    /// refuses it (404) for task-purpose objects, so an unbound object is
    /// reclaimed by the server's collector: at its expiry while its finalize
    /// record still names it (G34-N5), otherwise after the bind grace
    /// (protocol §27).
    private func release(_ plan: PendingUploadPlan) async throws {
        // Re-checked here, after whatever suspension preceded this call (a
        // cancel, a create): a collision that appeared meanwhile stops the
        // release before it touches the key, the plan or the bytes.
        try refuseUnlessDiscardable(plan.jobId)
        // The tombstone goes down before the bytes, so a removal that fails
        // cannot turn this job back into outstanding work on the next launch.
        // Its write is itself refused for a conflicting job.
        let retired = (try? store.markRetired(plan)) ?? plan
        let purged = store.purge(retired)
        // The content key LAST, and only once no directory anywhere still
        // names this job: the key is filed by job id, so while either root
        // holds the id it belongs to that copy too. A key left behind by a
        // failed purge is removed with the retired tombstone by the next
        // `InboxSendModel.refreshOutstanding` sweep; no later release names it.
        if store.ownership(of: plan.jobId) == .conflict || store.sharedRootHolds(jobId: plan.jobId) {
            throw InboxSendFailure.ownershipConflict
        }
        if purged { try? await keys.remove(id: plan.jobId) }
    }

    /// Throw `ownershipConflict` unless this protected store is the only root
    /// that could hold the job: it owns it, or the job is already gone from
    /// both (an idempotent release of work already cleaned up).
    private func refuseUnlessDiscardable(_ jobId: String) throws {
        guard store.isProtectedDeviceStore else { throw InboxSendFailure.notADelivery }
        switch store.ownership(of: jobId) {
        case .owned:
            return
        case .conflict:
            throw InboxSendFailure.ownershipConflict
        case .missing:
            if store.sharedRootHolds(jobId: jobId) { throw InboxSendFailure.ownershipConflict }
        }
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
    /// The existing transport's 413 classification does not distinguish file
    /// size from storage capacity, and never proves membership expiry.
    case uploadQuota
    case uploadDailyQuota
    case uploadMonthlyTraffic
    case uploadRateLimited
    /// The account no longer has this device.
    case targetMissing
    /// The device is still here but may not be sent to, for this named reason.
    case targetUnavailable(InboxTargetBlock)
    /// The target does not announce `inbox.text.v1`, so a message sent to it
    /// would be presented as something nobody promised. Applies to a MESSAGE
    /// delivery only; a file delivery never consults the token.
    case textUnsupported
    /// This plan cannot produce a valid Device Inbox v2 manifest — a name no
    /// receiver would accept, a message outside its bounds, more items than the
    /// protocol carries. Terminal: the names and sizes are the plan's own, so
    /// every retry would rebuild the same refusal.
    case unsendableContent
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
    /// exists. Definitive: the local job has been released.
    case noTaskCreated
    /// Nobody knows whether a delivery exists. NOTHING has been released — not
    /// the ciphertext, not the staged bytes, not the content key, and not the
    /// idempotency key the next attempt needs to converge.
    case unknownOutcome
    /// Whether the UPLOAD finished could not be confirmed. No task was ever
    /// requested, so no delivery can arrive; nothing was released, and nothing
    /// will upload these bytes again. Retry only asks central again.
    case uploadOutcomeUnknown
    /// Central's record says this upload produced no usable object, or this is
    /// a pre-v2 delivery that already reached the server. Terminal: nothing
    /// re-uploads it; the user may discard it and start a new send.
    case uploadUnavailable(InboxUploadUnavailable)
    /// The same job exists in the shared and the protected root. Neither copy
    /// is executed and neither is deleted.
    case ownershipConflict
}

/// Why an upload is terminally unusable.
public enum InboxUploadUnavailable: Equatable, Sendable {
    /// Central refused or never completed it; no object exists.
    case notCompleted
    /// The object was stored and has since expired.
    case expired
    /// The object was stored and has since been removed.
    case removed
    /// Started by a pre-v2 build and already on the server; no create was ever
    /// sent, so nothing can arrive.
    case olderVersion
    /// Started by a pre-v2 build that recorded its object and may have sent the
    /// create: a delivery may exist and may still arrive. Retry looks for it,
    /// read-only; nothing is ever created or uploaded again.
    case olderVersionDeliveryUnknown
    /// A recorded disposition this build does not recognise, on a job with no
    /// recorded object: no create can have been sent.
    case unrecognized
    /// A recorded disposition this build does not recognise, on a job that
    /// also records an object or a task: a create may have been sent, so a
    /// delivery may exist and may still arrive. Nothing is sent or released.
    case unrecognizedMayArrive

    /// The presentation of a recorded terminal disposition. `plan` matters for
    /// `olderVersion`: a pre-v2 plan that recorded an object may have a
    /// delivery, and must never be described as one that cannot arrive.
    init(_ terminal: PendingDeviceTerminal, plan: PendingUploadPlan) {
        switch terminal {
        case .failed: self = .notCompleted
        case .expired: self = .expired
        case .removed: self = .removed
        case .olderVersion:
            self = plan.finalizedStoredId == nil ? .olderVersion : .olderVersionDeliveryUnknown
        case .unrecognized:
            self = plan.finalizedStoredId == nil && plan.deviceTaskId == nil
                ? .unrecognized : .unrecognizedMayArrive
        }
    }
}

extension PendingDeviceTerminal {
    init(_ outcome: FinalizeOutcome) {
        switch outcome {
        case .failed: self = .failed
        case .expired: self = .expired
        case .removed: self = .removed
        }
    }
}
