import Foundation
import RelayiumKit
import RelayiumShareKit

/// TTL options, mirroring the web's. An unknown cap (signed out, or a usage
/// fetch that failed) offers all of them: the server truncates anyway, and
/// hiding working options because a side request failed is the worse error.
///
/// A cap below the shortest option still yields the shortest one rather than an
/// empty picker — an empty list would leave nothing selectable and no way to send.
public func allowedTTLs(retentionSecs: Int64) -> [Int] {
    let all = [3600, 86400, 259200, 604800, 1209600]
    guard retentionSecs > 0 else { return all }
    let allowed = all.filter { Int64($0) <= retentionSecs }
    return allowed.isEmpty ? [all[0]] : allowed
}

public enum UploadState: Equatable {
    case idle
    /// The expanded file list, not the roots: a folder is only "picked" once we
    /// know what is in it, and `.picked([])` must be unreachable.
    case picked([SelectedFile])
    /// Looking only at local disk and Keychain for an interrupted upload. It is
    /// brief, but it blocks a new selection so an older valid job cannot become
    /// a hidden second job while its key is being checked.
    case checkingRecovery
    /// Copying the selection into this app's own storage, before any server
    /// session exists. Its own state because it takes real time on a large
    /// selection and a spinner with no sentence says nothing to anybody.
    case preparing
    case uploading(sent: Int, total: Int)
    /// A staged job that stopped — the network died, the app was terminated, or
    /// the user left. The bytes and the key are still here; what happens next
    /// is the user's choice, never this model's.
    case interrupted(files: Int, bytes: Int, message: String?)
    /// The server's idle reaper got to the session first, so a fresh one is
    /// being opened with the same key and manifest. Shown because the progress
    /// bar is about to go back to zero, and a bar that restarts with no
    /// explanation reads as a bug.
    case restarting
    /// `keyWarning` is non-nil when the upload succeeded but this device could
    /// not keep the key. The link is still here — it is the only copy of that
    /// key — and the warning is what turns a silent future "this file's key is
    /// not on this device" into something the user could act on now, by copying
    /// it.
    case done(link: String, expiresAt: Int64, keyWarning: String?)
    case failed(String)
}

@MainActor
public final class CloudUploadModel: ObservableObject {
    @Published public private(set) var state: UploadState = .idle
    @Published public var ttl: Int = 86400
    @Published public var burnAfterRead: Bool = false
    /// 0 == unknown; the hint is advisory and the upload works without it.
    @Published public var maxFileSize: Int64 = 0
    @Published public private(set) var ttlChoices: [Int] = allowedTTLs(retentionSecs: 0)

    /// Stated whenever a finished upload could not have its staged bytes, its
    /// plan or its pending key removed. Never a failure of the upload — the
    /// object exists and the link works — but the user's files are still on
    /// this device and that is theirs to know.
    @Published public private(set) var cleanupWarning: String?

    /// Files that are presently actionable as a picked selection. Derived from
    /// `state`, never retained as a second presentation list.
    public var selectedFiles: [SelectedFile] {
        guard case let .picked(files) = state else { return [] }
        return files
    }

    /// The names and sizes the current upload surface must keep showing after
    /// the picker disappears. Unlike `lastPicked`, this contains no file URLs
    /// or security-scoped resources, so a completed link can truthfully name
    /// what it contains without keeping access to the source files alive.
    @Published public private(set) var sessionFiles: [FileMeta] = []

    private let uploader: CloudUploader
    /// Where the key of every successful upload is kept, so the Account tab can
    /// rebuild this link later. The same store the account management model
    /// reads — one installation, one answer to "do I have this key".
    private let keyStore: StoredLinkKeyStore
    private let origin: String
    /// Durable recovery, or nil on a platform that does not offer it. macOS
    /// passes nothing: its uploads are not interrupted by the OS suspending the
    /// app, and claiming a resume it has not shipped would be a lie in a menu.
    private let pending: PendingUploadSupport?
    /// The ready account these staged bytes belong to. Written by the send
    /// model when the session changes; a job is only ever prepared, recovered
    /// or resumed for the account that is signed in NOW.
    public var accountId: String?
    /// The shared draft the current selection was adopted from, or nil for the
    /// ordinary picker and photo paths — which is what keeps those two
    /// unchanged, recording nothing and retiring nothing.
    ///
    /// Written by `SendSelectionModel` at adoption and cleared with the
    /// selection. It is copied into the pending plan at `start()` and read back
    /// from the plan afterwards, so the retirement decision is made from what is
    /// durably on disk rather than from a field this object still happens to
    /// hold.
    public var sourceDraftId: String?
    /// Announced, on the main actor, the moment a durable job has taken
    /// ownership of a shared draft and that draft has been retired.
    ///
    /// Installed by `SendSelectionModel`, which is the only thing that knows a
    /// draft is *selected*. This model's own half of the same moment is
    /// `consumeSourceDraft` below: the staged copies it was picking from have
    /// just been deleted, so nothing may return to them. Both halves have to
    /// happen HERE, at the retirement, rather than at whatever button the user
    /// presses next — the bytes are gone whether or not anybody presses one.
    public var onSourceDraftConsumed: (@MainActor (String) -> Void)?
    /// The staged job this model is currently offering or running, if any.
    private var job: PendingUploadPlan?
    var task: Task<Void, Never>?
    /// Keychain verification for a job found on disk. Separate from the upload
    /// task because recovery is an offer and must never contact the network.
    var recoveryTask: Task<Void, Never>?
    /// Removal runs after the state has already changed, so a test (and a
    /// caller that needs to know the disk is clean) can await it.
    var cleanupTask: Task<Void, Never>?
    /// The files the user chose, kept so cancel() and reset() can return to a
    /// state they can act from instead of making them choose again.
    private var lastPicked: [SelectedFile] = []
    /// Operation identity, as in AccountSession: a late callback from a
    /// superseded upload must not repaint a screen the user has moved past.
    private var generation = 0

    public init(uploader: CloudUploader, keyStore: StoredLinkKeyStore, origin: String,
                pending: PendingUploadSupport? = nil) {
        self.uploader = uploader
        self.keyStore = keyStore
        self.origin = origin
        self.pending = pending
    }

    public var isBusy: Bool {
        switch state {
        case .checkingRecovery, .preparing, .uploading, .restarting: return true
        default: return false
        }
    }

    /// Exposed for the superseded-callback test; nothing else should read it.
    var currentGeneration: Int { generation }

    public func applyRetentionCap(_ secs: Int64) {
        ttlChoices = allowedTTLs(retentionSecs: secs)
        if !ttlChoices.contains(ttl) { ttl = ttlChoices.last ?? 3600 }
    }

    /// Advisory limits, applied as a pair so they can only be set and cleared
    /// together. `UploadCaps.unknown` on every transition out of a ready
    /// account is what stops one account's plan from bounding another's picker.
    ///
    /// The *selected* TTL is left where the user put it unless the new cap no
    /// longer allows it: a cap is a limit, a selection is a preference.
    public func apply(_ caps: UploadCaps) {
        applyRetentionCap(caps.retentionSecs)
        maxFileSize = caps.maxFileSize
    }

    /// Roots the user chose or dropped — files, folders, or a mix. Folders are
    /// expanded here, before anything is uploaded, so the per-file size gate and
    /// the file-count bound apply to what is actually going to be sent rather
    /// than to the handful of items that were selected.
    public func pick(_ urls: [URL]) {
        let selection: FileSelection
        do { selection = try expandSelection(urls) }
        catch {
            state = .failed(ErrorCopy.message(for: error))
            return
        }
        pick(selection)
    }

    public func pick(_ selection: FileSelection) {
        // A live upload is sending the bytes the CURRENT list describes.
        // Replacing it mid-flight would leave the progress bar, the manifest and
        // the files disagreeing. The panes disable their pickers while busy;
        // this is the guard that does not depend on a redraw.
        guard !isBusy else { return }
        // Keep the attempted selection's harmless display facts even when a
        // validation below refuses it. A failure card must never name files
        // left over from an earlier attempt.
        sessionFiles = selection.files.map(Self.fileMeta)
        if maxFileSize > 0 {
            for file in selection.files {
                let attrs = try? FileManager.default.attributesOfItem(atPath: file.url.path)
                let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
                if size > maxFileSize {
                    state = .failed(L10n.t(.uploadFileTooLarge, [L10n.token(file.name)]))
                    return
                }
            }
        }
        guard !selection.files.isEmpty else {
            state = .failed(ErrorCopy.message(for: FileSelectionError.noFiles))
            return
        }
        lastPicked = selection.files
        state = .picked(selection.files)
    }

    private static func fileMeta(_ file: SelectedFile) -> FileMeta {
        let bytes = file.byteCount ?? 0
        let size = bytes > Int64(Int.max) ? Int.max : Int(max(bytes, 0))
        return FileMeta(name: file.name, size: size,
                        path: file.isNested ? file.relativePath : nil)
    }

    private static func fileMeta(_ file: PendingUploadFile) -> FileMeta {
        FileMeta(name: file.name.split(separator: "/").last.map(String.init) ?? file.name,
                 size: max(file.size, 0),
                 path: file.name.contains("/") ? file.name : nil)
    }

    public func start(token: String) {
        guard case .picked(let files) = state else { return }
        generation += 1
        let g = generation
        cleanupWarning = nil

        // Without durable recovery (macOS today) this is the original path,
        // unchanged: one live uploader, one in-memory key, no staged copy.
        guard let pending, let accountId, !accountId.isEmpty else {
            state = .uploading(sent: 0, total: 0)
            task = Task { [weak self] in
                guard let self else { return }
                do {
                    // Through `stageCloudFiles`, not a second copy of it: the rule
                    // that folder hierarchy rides in `ManifestFile.name` has to have
                    // exactly one implementation, or the native upload and the thing
                    // its interop test pins drift apart.
                    let sources = try stageCloudFiles(files)
                    let outcome = try await self.uploader.upload(
                        sources: sources,
                        burnAfterRead: self.burnAfterRead,
                        ttl: self.ttl,
                        token: token,
                        onProgress: { sent, total in
                            Task { @MainActor in self.report(sent: sent, total: total, g: g) }
                        })
                    await self.finish(outcome, g: g)
                } catch is CancellationError {
                    await MainActor.run { self.restore(g: g) }
                } catch {
                    await MainActor.run { self.fail(error, g: g) }
                }
            }
            return
        }

        // The durable path. The order is the correctness: the bytes become this
        // app's own, the key is filed under the job, and only then does a
        // server session exist. Reversed, a crash in between would leave a
        // session nothing on this device could feed.
        state = .preparing
        let burn = burnAfterRead
        let ttl = self.ttl
        let source = sourceDraftId
        task = Task { [weak self] in
            guard let self else { return }
            let store = pending.store
            var stagedPlan: PendingUploadPlan?
            var keyWasSaved = false
            var wasAdopted = false
            do {
                let preparation = Task.detached(priority: .userInitiated) {
                    try store.prepare(files: files, accountId: accountId,
                                      burnAfterRead: burn, ttl: ttl,
                                      sourceDraftId: source)
                }
                let plan = try await withTaskCancellationHandler {
                    try await preparation.value
                } onCancel: {
                    preparation.cancel()
                }
                stagedPlan = plan
                try Task.checkCancellation()
                let key = generateStoreKey()
                do {
                    try await pending.keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
                    keyWasSaved = true
                } catch {
                    // A job whose key cannot be kept is not recoverable, so it
                    // must not be left on disk pretending to be. The SHARED
                    // DRAFT is deliberately untouched here: this is the failure
                    // in which the user's only other copy of those files is the
                    // draft, so it stays and is offered again.
                    store.purge(plan)
                    throw error
                }
                try Task.checkCancellation()
                wasAdopted = self.adopt(plan, g: g)
                guard wasAdopted else { throw CancellationError() }
                // The plan is on disk, its content key is in the Keychain, and
                // this model has adopted the job — so it survives anything that
                // happens from here on, and the two failure paths above (which
                // purge the job) are now behind us. THAT is the moment the draft
                // stops being the user's only copy, and the only moment removing
                // it is safe. Retiring one line earlier would mean a
                // cancellation landing in between deleting both copies.
                //
                // Before the upload finishes rather than after it: an upload can
                // be cancelled, interrupted, or resumed days later, and a draft
                // sitting in the inbox through all of that would be offered as a
                // second, separate send of the same files.
                //
                // A failure here is NOT an upload failure. The retirement is
                // recorded durably before any byte is deleted, so the draft is
                // already out of the inbox and already queued for another
                // attempt; what is left is a copy taking up space, and that is
                // exactly what `uploadCleanupFailed` is for. Turning it into a
                // failed send would be this app refusing to transfer files it
                // has already staged, because it could not tidy up after itself.
                self.consumeSourceDraft(of: plan, using: pending, g: g)
                await self.run(plan: plan, key: key, token: token, g: g)
            } catch is CancellationError {
                if let plan = stagedPlan, !wasAdopted {
                    if keyWasSaved { try? await pending.keys.remove(id: plan.jobId) }
                    store.purge(plan)
                }
                self.pauseOrRestore(g: g)
            } catch {
                if let plan = stagedPlan, !wasAdopted {
                    if keyWasSaved { try? await pending.keys.remove(id: plan.jobId) }
                    store.purge(plan)
                }
                self.fail(error, g: g)
            }
        }
    }

    /// Continue the staged job the user is being offered. Only ever from an
    /// explicit choice — there is no path from launch, from `.ready`, or from
    /// the network coming back that reaches this.
    public func resume(token: String) {
        guard case .interrupted = state, let pending, let job else { return }
        generation += 1
        let g = generation
        cleanupWarning = nil
        state = .uploading(sent: 0, total: job.totalBytes)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let storedKey = try await pending.keys.key(for: job.jobId)
                guard let storedKey, let key = try? decodeStoreKey(storedKey) else {
                    // The bytes are here and the key is not: nothing can ever
                    // open this upload, so offering it again would be a lie.
                    try? await pending.keys.remove(id: job.jobId)
                    let retired = (try? pending.store.markRetired(job)) ?? job
                    pending.store.purge(retired)
                    self.job = nil
                    throw PendingUploadError.stagingMissing
                }
                await self.run(plan: job, key: key, token: token, g: g)
            } catch is CancellationError {
                await MainActor.run { self.pauseOrRestore(g: g) }
            } catch {
                await MainActor.run { self.fail(error, g: g) }
            }
        }
    }

    /// Run one attempt at a staged job, from wherever the server got to.
    private func run(plan: PendingUploadPlan, key: [UInt8], token: String, g: Int) async {
        guard let pending else { return }
        do {
            let sources = try pending.store.sources(for: plan)
            let known = plan.uploadId
            let outcome = try await uploader.resume(
                sources: sources, key: key, uploadId: plan.uploadId,
                uploadChunkSize: plan.uploadChunkSize,
                burnAfterRead: plan.burnAfterRead, ttl: plan.ttl, token: token,
                onUploadSession: { [weak self] id, chunkSize in
                    // Persisted from the uploader's own context, before bytes
                    // move. A session recorded after the first PATCH is a
                    // session a crash can orphan.
                    let updated = try pending.store.setUploadSession(
                        id: id, chunkSize: chunkSize, for: plan)
                    Task { @MainActor in
                        self?.sessionEstablished(updated, replaced: known != nil && known != id, g: g)
                    }
                },
                onProgress: { [weak self] sent, total in
                    Task { @MainActor in self?.report(sent: sent, total: total, g: g) }
                })
            // The session callback has already committed the newest plan to
            // disk. Use that version for finalization even if its MainActor UI
            // callback has not run yet.
            let active = pending.store.plan(for: plan.accountId)
                .flatMap { $0.jobId == plan.jobId ? $0 : nil } ?? plan
            await completed(outcome, plan: active, g: g)
        } catch is CancellationError {
            await MainActor.run { self.pauseOrRestore(g: g) }
        } catch {
            if let active = pending.store.plan(for: plan.accountId),
               active.jobId == plan.jobId {
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.job = active
                }
            }
            await MainActor.run { self.interrupt(error, g: g) }
        }
    }

    /// Success. The order here is what stops one upload from becoming two.
    ///
    /// The object exists on the server the moment `finalize` returns, so the
    /// plan is marked finalized FIRST — before the final key is saved and
    /// before anything is deleted. A crash, a keychain failure or an
    /// undeletable file after that point leaves a job that recovery will not
    /// offer, rather than one that would upload the same bytes a second time.
    private func completed(_ outcome: UploadOutcome, plan: PendingUploadPlan, g: Int) async {
        guard let pending else { return }
        var cleanupFailed = (try? pending.store.markFinalized(plan, storedId: outcome.id)) == nil
        // Cancellation normally lands at the explicit check before finalize.
        // If it races an already in-flight finalize, the server still owns a
        // completed object. Present that result only while this exact job still
        // owns the screen; never overwrite a discard or a newer upload.
        let presentationGeneration: Int? = await MainActor.run {
            if g == self.generation || self.job?.jobId == plan.jobId {
                return self.generation
            }
            return nil
        }
        await finish(outcome, g: presentationGeneration ?? g)
        do {
            try await pending.keys.remove(id: plan.jobId)
        } catch {
            cleanupFailed = true
        }
        if !pending.store.purge(plan) { cleanupFailed = true }
        await MainActor.run {
            if self.job?.jobId == plan.jobId { self.job = nil }
            guard let presentationGeneration,
                  presentationGeneration == self.generation else { return }
            if cleanupFailed { self.cleanupWarning = L10n.t(.uploadCleanupFailed) }
        }
    }

    /// Remove the shared draft a durable job was copied out of, and stop
    /// pointing at the bytes that are about to go.
    ///
    /// Called from exactly two places, and it has to be both: the commit path,
    /// and validated recovery. A crash between "the key is saved" and "the draft
    /// is gone" leaves a job that is complete and a draft that still looks
    /// waiting — which, without the second call, would offer the same files as a
    /// second send forever. `SharedDraftStore.retire` is idempotent, so the
    /// overwhelmingly common case of recovery finding an already-retired draft
    /// is a no-op that reports success.
    ///
    /// **`retire`'s Bool is about BYTES, not about the offer.** It records the
    /// retirement durably before it deletes anything, so a draft whose
    /// `removeItem` fails is already hidden from the inbox and already queued
    /// for another attempt on the next launch — the invariant "one durable job,
    /// one send" holds either way. `false` means only that a copy of the user's
    /// files is still occupying the container, which is the same thing
    /// `uploadCleanupFailed` says about a pending job's own bytes.
    ///
    /// **`lastPicked` is dropped here, and that is the point of the method.**
    /// It held the draft's STAGED copies, and `reset()`, `cancel()`, `restore()`
    /// and `discard()` all return to `.picked(lastPicked)`. Left populated, Send
    /// another and Discard would hand the user back a selection of files this
    /// process has just deleted, and the next send would read them. There is
    /// nothing to preserve either: the only surviving copy is the account-bound
    /// job, and it is exactly what these two callers have just committed to.
    ///
    /// Deliberately NOT symmetrical with the failure paths above. A key save
    /// that fails purges the job and leaves the draft alone, so `lastPicked`
    /// still describes files that exist and Try again still works — which is the
    /// one case where the draft is the user's only remaining copy.
    ///
    /// **The generation check is the first thing here, and it guards the STORE
    /// as well as the screen.** A superseded caller mutates nothing at all: not
    /// the draft store, not `lastPicked`, not the state the user is looking at.
    /// This method's authority to delete comes entirely from the durable job its
    /// caller has just committed, and a superseded caller no longer has one —
    /// the account may have left and taken that job with it, which puts the
    /// draft straight back to being the only copy of those files on the device.
    /// Retiring first and checking afterwards would delete them on the way out.
    ///
    /// Both callers guard before reaching this, and this guards again anyway.
    /// Recovery's own check cannot be the only one: the reason it is needed is
    /// that a Keychain read may resume a task that was cancelled long ago, and
    /// the cost of getting that wrong is the user's files.
    private func consumeSourceDraft(of plan: PendingUploadPlan,
                                    using pending: PendingUploadSupport, g: Int) {
        guard g == generation else { return }
        guard let id = plan.sourceDraftId, let drafts = pending.drafts else { return }
        let removed = drafts.retire(id: id)
        if !removed { cleanupWarning = L10n.t(.uploadCleanupFailed) }
        lastPicked = []
        sourceDraftId = nil
        onSourceDraftConsumed?(id)
    }

    // MARK: - recovery, offered and never taken on its own

    /// Look for a job this account can finish. Called when the session becomes
    /// ready and when the app launches — and it contacts nothing: recovery is
    /// an offer made from disk, not a transfer started on the user's behalf.
    public func recoverPendingJob(for accountId: String?) {
        self.accountId = accountId
        guard let pending else { return }
        // Recovery is an account-entry action, never a refresh action. Do not
        // replace a selection, a failure the user is reading, or a completed
        // link even if a caller asks twice for the same account.
        guard case .idle = state else { return }
        generation += 1
        let g = generation
        recoveryTask?.cancel()
        cleanupWarning = nil
        guard let accountId else { return }
        state = .checkingRecovery
        recoveryTask = Task { [weak self] in
            guard let self else { return }
            await Task.detached(priority: .utility) {
                pending.store.sweepIncomplete()
            }.value
            guard !Task.isCancelled, g == self.generation,
                  self.accountId == accountId else { return }
            guard let plan = pending.store.plan(for: accountId) else {
                self.state = .idle
                self.recoveryTask = nil
                return
            }

            let message: String?
            do {
                guard let storedKey = try await pending.keys.key(for: plan.jobId),
                      (try? decodeStoreKey(storedKey)) != nil else {
                    // A crash can land after the atomic plan write but before
                    // Keychain save, and an item can itself be corrupted. Such
                    // a job is not resumable and must never be presented as
                    // though its key still exists.
                    try? await pending.keys.remove(id: plan.jobId)
                    let retired = (try? pending.store.markRetired(plan)) ?? plan
                    pending.store.purge(retired)
                    guard g == self.generation else { return }
                    self.state = .idle
                    self.recoveryTask = nil
                    return
                }
                message = nil
                // The key is here and readable, so this job IS durable — which
                // means a shared draft behind it is redundant even though the
                // process that proved it crashed before saying so. Idempotent,
                // and deliberately inside the arm that validated the key: a job
                // whose key could not be read is one whose source must stay.
                //
                // This is also the retry that finishes a retirement the previous
                // process recorded but could not carry out, for the case where
                // the job is still pending. `SendSelectionModel`'s launch sweep
                // covers the case where it is not.
                //
                // Revalidated HERE, on the main actor, immediately before the
                // only mutation in this task that can destroy user data. The
                // key read above is recovery's one suspension point, and a key
                // store need not observe cancellation to be correct — the real
                // one wraps a synchronous `SecItemCopyMatching`, which returns
                // what it fetched whatever became of the Swift task around it.
                // So this can resume after the account has left, after the
                // generation moved on, and after `purgePendingJob` deleted the
                // account-bound job named by `plan`. The draft `plan` points at
                // is device-owned and is still there, which by then makes it the
                // user's only copy again. Everything checked before the await is
                // stale by definition.
                guard !Task.isCancelled, g == self.generation,
                      self.accountId == accountId else { return }
                self.consumeSourceDraft(of: plan, using: pending, g: g)
            } catch {
                // Keychain may merely be locked. Keep the job and let an
                // explicit Resume retry the read; state what blocked recovery.
                message = ErrorCopy.storedLinkKeyMessage(for: error, operation: .read)
            }
            guard !Task.isCancelled, g == self.generation,
                  self.accountId == accountId else { return }
            self.job = plan
            self.sessionFiles = plan.files.map(Self.fileMeta)
            self.state = .interrupted(files: plan.files.count, bytes: plan.totalBytes,
                                      message: message)
            self.recoveryTask = nil
        }
    }

    /// Forget the job on this screen and remove it from disk. What "Discard"
    /// means, and also what an account leaving means.
    public func discardPendingJob() {
        guard let pending, let plan = job else { return }
        discard(plan, using: pending)
    }

    private func discard(_ plan: PendingUploadPlan, using pending: PendingUploadSupport) {
        generation += 1
        job = nil
        restorePickedState()
        cleanupWarning = nil
        let cleanupGeneration = generation
        // Record Discard before the asynchronous keychain cleanup begins. A
        // force-quit on the next line must still leave a job the launch sweep
        // deletes rather than a job recovery offers.
        let cleanupPlan = (try? pending.store.markRetired(plan)) ?? plan
        cleanupTask = Task { [weak self] in
            var failed = false
            do { try await pending.keys.remove(id: cleanupPlan.jobId) }
            catch { failed = true }
            if !pending.store.purge(cleanupPlan) { failed = true }
            guard failed, let self, cleanupGeneration == self.generation else { return }
            self.cleanupWarning = L10n.t(.uploadCleanupFailed)
        }
    }

    /// The account left. Hide the job SYNCHRONOUSLY — before any await, so no
    /// runloop turn exists in which the next account could see it — and then
    /// remove it.
    public func purgePendingJob() {
        // Recovery may still be checking Keychain and therefore may not have
        // assigned `job` yet. Resolve the outgoing account's plan before its
        // identity is cleared, so a sign-out in that brief window still obeys
        // the same purge rule as a job already visible on screen.
        let undisplayed = job == nil ? pending?.store.plan(for: accountId) : nil
        task?.cancel()
        task = nil
        recoveryTask?.cancel()
        recoveryTask = nil
        if let pending, let plan = job ?? undisplayed {
            discard(plan, using: pending)
        } else {
            generation += 1
            restorePickedState()
        }
        job = nil
        accountId = nil
    }

    // MARK: - staged-job state transitions, each guarded by generation

    @discardableResult
    private func adopt(_ plan: PendingUploadPlan, g: Int) -> Bool {
        guard g == generation else { return false }
        job = plan
        sessionFiles = plan.files.map(Self.fileMeta)
        state = .uploading(sent: 0, total: plan.totalBytes)
        return true
    }

    private func sessionEstablished(_ plan: PendingUploadPlan, replaced: Bool, g: Int) {
        guard g == generation else { return }
        job = plan
        // A session that was replaced means the server's idle reaper took the
        // old one: the bar is about to go back to zero, and saying so beats
        // looking like a bug.
        if replaced { state = .restarting }
    }

    /// A failure that leaves the job recoverable. Distinct from `fail`: there
    /// are staged bytes and a key on this device, so the honest offer is
    /// "resume or discard", not "try again" against a selection that is gone.
    private func interrupt(_ error: Error, g: Int) {
        guard g == generation else { return }
        guard let plan = job else { return fail(error, g: g) }
        state = .interrupted(files: plan.files.count, bytes: plan.totalBytes,
                             message: ErrorCopy.message(for: error))
    }

    /// Cancellation with a staged job behind it is a pause, not a loss.
    private func pauseOrRestore(g: Int) {
        guard g == generation else { return }
        if let plan = job {
            state = .interrupted(files: plan.files.count, bytes: plan.totalBytes, message: nil)
        } else {
            restore(g: g)
        }
    }

    /// Cancel and return to the files the user chose. Bumping the generation is
    /// the load-bearing half: an in-flight progress callback must not resume.
    public func cancel() {
        task?.cancel()
        task = nil
        recoveryTask?.cancel()
        recoveryTask = nil
        generation += 1
        // A staged job survives being cancelled: the bytes are this app's own
        // and the user may want them later. Discard is the destructive choice,
        // and it is a separate one.
        if let plan = job {
            state = .interrupted(files: plan.files.count, bytes: plan.totalBytes, message: nil)
            return
        }
        restorePickedState()
    }

    /// Forget the selection entirely — what "Clear" means. Distinct from
    /// `reset`, which deliberately keeps it so a failure does not make the user
    /// choose everything again. Refuses mid-upload: the bytes being sent are the
    /// ones this list describes.
    public func clearSelection() {
        guard !isBusy else { return }
        generation += 1
        lastPicked = []
        sessionFiles = []
        state = .idle
    }

    /// Back to a state the user can start from, after a success or a failure.
    public func reset() {
        generation += 1
        restorePickedState()
    }

    // MARK: - state transitions, each guarded by generation

    func report(sent: Int, total: Int, g: Int) {
        guard g == generation else { return }
        state = .uploading(sent: sent, total: total)
    }

    /// Check the id, persist the key, then present the link.
    ///
    /// The id is checked FIRST, before the key store is touched and before any
    /// link is built. `CloudUploader` already refuses an id the server should
    /// never have sent, so nothing legitimate reaches this — but an
    /// `UploadOutcome` is a plain public struct that anything can construct, and
    /// this is the last point before its id becomes a keychain account name and
    /// a URL shown to the user as the way to open the upload. A hostile id must
    /// not be presented as a working link, which is what interpolating it
    /// unchecked would do even when the save that precedes it was refused.
    ///
    /// The key is stored BEFORE the generation is checked, and deliberately so:
    /// by the time this runs the server has the bytes, whatever the screen is
    /// showing. If the user cancelled or started another upload in the meantime,
    /// nothing here should repaint — but the key is still the only thing that
    /// could ever open what was uploaded, so throwing it away because a view
    /// moved on would be losing data to a UI event.
    ///
    /// A refused id is the one case with nothing to preserve: no key can be
    /// filed under it and no link can be built from it, so the generation rule
    /// applies plainly — a superseded result stays silent, a current one fails
    /// with the sentence the app already has for an id it will not act on.
    func finish(_ o: UploadOutcome, g: Int) async {
        let id: String
        do {
            id = try StoredObjectID.checked(o.id)
        } catch {
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: error))
            return
        }
        var warning: String?
        do {
            try await keyStore.save(id: id, keyB64url: o.keyB64url)
        } catch {
            // Never a failed upload: the transfer succeeded, and reporting it as
            // a failure would invite a retry that sends every byte a second
            // time. The link itself is intact — and it is now the ONLY place
            // that key exists, which is the whole reason this is said loudly and
            // said here, on the last screen the link appears on.
            //
            // It leads with what failed rather than wrapping it, because the
            // stored-key copy already names the operation: the shared table's
            // `KeychainError` wording is the SIGN-IN store's, and a save that
            // never touched the session must not borrow it.
            warning = L10n.t(.uploadKeyWarning,
                             [ErrorCopy.storedLinkKeyMessage(for: error, operation: .save)])
        }
        guard g == generation else { return }
        state = .done(link: buildDownloadLink(origin: origin, id: id, keyB64url: o.keyB64url),
                      expiresAt: o.expiresAt, keyWarning: warning)
    }

    func restore(g: Int) {
        guard g == generation else { return }
        restorePickedState()
    }

    private func restorePickedState() {
        sessionFiles = lastPicked.map(Self.fileMeta)
        state = lastPicked.isEmpty ? .idle : .picked(lastPicked)
    }

    func fail(_ error: Error, g: Int) {
        guard g == generation else { return }
        state = .failed(ErrorCopy.message(for: error))
    }

    /// A failure raised outside the upload — an unreadable selection, say. Not
    /// applied mid-upload: a picker error must not repaint a live transfer.
    public func fail(_ message: String) {
        guard !isBusy else { return }
        generation += 1
        state = .failed(message)
    }

    /// Split out so the link construction and key persistence are testable
    /// without a transfer.
    public func applyOutcome(_ o: UploadOutcome) async {
        await finish(o, g: generation)
    }
}
