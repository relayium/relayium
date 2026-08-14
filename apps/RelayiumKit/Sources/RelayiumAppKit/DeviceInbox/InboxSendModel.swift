import Combine
import Foundation
import RelayiumKit
import RelayiumShareKit

/// Everything the main app owns about sending a file to one of the account's own
/// devices, and nothing a view does.
///
/// It is the product half of `InboxSendCoordinator`: the coordinator drives ONE
/// staged delivery to exactly one task and says precisely what is known about
/// it, and this decides which devices may be offered, when a selection becomes a
/// durable delivery, what a user is told while it runs, and which recovery a
/// stopped one is allowed to offer.
///
/// **App-scoped, and for the sharpest version of the reason the other models
/// are.** A device send outlives the screen that started it in three separate
/// ways: SwiftUI may tear an off-screen tab down mid-upload; a durable plan
/// survives the process itself; and an account leaving has to cancel work that
/// no view is watching. A view-scoped owner would be absent for exactly those
/// three cases.
///
/// **Nothing here starts on its own.** Recovery is an OFFER read from disk with
/// no network, targets are read when the surface asks, and no plan is ever
/// resumed, retried, cancelled or discarded except from an explicit user action.
/// That is the PRD's rule and it is also the safe one: every one of those verbs
/// touches either the user's only local copy of their files or a delivery that
/// may already be live.
@MainActor
public final class InboxSendModel: ObservableObject {

    // MARK: - the render surface

    /// Whether the account's device list has been read, and what came back.
    @Published public private(set) var directory: InboxSendDirectory = .idle
    /// Every device that may be OFFERED — sendable and blocked alike, minus this
    /// one. See `InboxSendCandidate.candidates(from:)` for why blocked rows stay.
    @Published public private(set) var candidates: [InboxSendCandidate] = []
    /// The device the user chose. Never set by this model on the user's behalf.
    @Published public private(set) var selectedTargetID: String?
    /// Every send this account still has outstanding, newest first.
    @Published public private(set) var items: [InboxSendItem] = []
    /// Why the newest attempt to start a send was refused, or nil.
    @Published public private(set) var refusal: InboxSendRefusal?
    /// An action that left something running after saying it would stop it.
    @Published public private(set) var actionError: InboxSendActionError?

    // MARK: - collaborators

    private let pending: PendingUploadSupport
    private let uploader: CloudUploader
    /// A sender transport bound to one credential. A closure rather than an
    /// object because the bearer belongs to a session and is read at the moment
    /// of use — this model stores no credential and has no property that could
    /// hold one.
    private let makeSender: @Sendable (String) -> InboxSenderTransport
    /// The account's own stored-object routes, used by the coordinator for
    /// exactly one thing: returning the quota of a provably unbound object.
    private let objects: AccountManagementService
    private let sleeper: InboxSleeping
    private let pollSeconds: TimeInterval

    /// Announced, on the main actor, the moment a durable device job has taken
    /// ownership of the current selection — with the account it belongs to and
    /// the shared draft it came from, when there was one.
    ///
    /// Installed by the app, wired to `SendSelectionModel`, which is the only
    /// object that knows what is selected and owns the draft store. Doing it
    /// through a closure rather than a reference keeps this model drivable with
    /// no selection model, no App Group and no view.
    ///
    /// The ACCOUNT is passed rather than implied, and it is the reason this
    /// signature is not just the draft id: the receiver retires a draft, which
    /// deletes the user's only copy of files another app handed them. Its
    /// authority to do that comes entirely from the durable job named here, so
    /// it has to be able to check that the job belongs to the account it is
    /// currently describing rather than to one that has since left.
    public var onSelectionCommitted: (@MainActor (_ accountId: String,
                                                  _ sourceDraftId: String?) -> Void)?

    // MARK: - internal state, rendered by nothing

    /// The rows the last device read returned, KEY MATERIAL INCLUDED.
    ///
    /// Private and never published: a seal must use the target's current key, so
    /// the one place a key is read is the moment a plan is staged — and the
    /// coordinator re-reads it again after the upload for the same reason.
    private var rows: [InboxDeviceRow] = []

    /// One send, as this model tracks it between the durable plan and central.
    private struct Record {
        /// The durable plan, or nil once the coordinator has released it.
        var plan: PendingUploadPlan?
        /// The task central definitively minted, once one exists.
        var result: InboxSendResult?
        var activity: InboxSendActivity
        /// The manifest identities, held here rather than re-read from the plan
        /// on every publish: the plan goes when the coordinator releases it, and
        /// a card that lost its file list at the moment it became a result would
        /// be the one the user is looking at.
        let files: [FileMeta]
        let fileCount: Int
        let byteCount: Int
        let targetDeviceID: String
        /// Creation order, so a job keeps its place in the list at the exact
        /// moment its plan is released and it stops being a durable row.
        let sequence: Int
    }

    private var records: [String: Record] = [:]
    private var sequence = 0
    /// The ready account these records belong to, or nil. Not `@Published`:
    /// nothing renders an account id and nothing should redraw because one moved.
    private var accountId: String?
    /// Bumped per account event, so every asynchronous result is checked against
    /// the account that asked for it.
    private var accountGeneration = 0

    private var observation: AnyCancellable?
    private var directoryTask: Task<Void, Never>?
    /// The attempt running for one job, if any.
    private var work: [String: Task<Void, Never>] = [:]
    /// The state poll running for one job, if any.
    private var polls: [String: Task<Void, Never>] = [:]

    public init(pending: PendingUploadSupport,
                uploader: CloudUploader,
                makeSender: @escaping @Sendable (String) -> InboxSenderTransport,
                objects: AccountManagementService,
                sleeper: InboxSleeping = InboxTaskSleeper(),
                pollSeconds: TimeInterval = 5) {
        self.pending = pending
        self.uploader = uploader
        self.makeSender = makeSender
        self.objects = objects
        self.sleeper = sleeper
        self.pollSeconds = pollSeconds
    }

    // No `deinit` teardown, deliberately. Every task this model starts captures
    // `[weak self]` and returns on its next resumption once the model is gone,
    // and the account-scoped cancellation that MATTERS — an account leaving
    // while a delivery is running — happens in `isolateFromPreviousAccount`,
    // synchronously, rather than whenever ARC gets around to the object.

    // MARK: - the account, app-scoped and session-driven

    /// Installed once, at app construction, for this model's whole life.
    ///
    /// Same shape and the same reason as `SendSelectionModel.observe(_:)`: the
    /// sink is formed inside a `@MainActor` method so it INHERITS main-actor
    /// isolation and runs SYNCHRONOUSLY with the state write. A hop here would
    /// leave a window in which an account-owned delivery is still running, and
    /// still on screen, under an account that is already gone.
    public func observe<P: Publisher>(_ states: P)
        where P.Output == SessionState, P.Failure == Never {
        observation = states
            .map(SendAccountContext.context(for:))
            .removeDuplicates()
            .sink { [weak self] context in self?.accountContextChanged(context) }
    }

    private func accountContextChanged(_ context: SendAccountContext) {
        let changed = context.userId != accountId
        accountGeneration += 1
        if changed { isolateFromPreviousAccount() }
        accountId = context.userId
        guard context.userId != nil else { return }
        // An OFFER, made from disk and touching no network. Nothing is resumed,
        // retried or removed until the user asks for it.
        refreshOutstanding()
    }

    /// Leaving an account cancels its work and stops describing it — and deletes
    /// nothing.
    ///
    /// **The asymmetry with `CloudUploadModel.purgePendingJob` is deliberate.** A
    /// staged public link is bytes the account owns and nothing else can be
    /// waiting for, so it leaves WITH the account. A device delivery may already
    /// exist on central, or may be one ambiguous answer away from existing, and
    /// destroying its plan would take the idempotency key that is the only thing
    /// able to converge it. The plans stay on disk, scoped to their own account
    /// id, where `deviceSendPlans(for:)` will not show them to anybody else.
    ///
    /// Everything below is synchronous, before any await: a delivery still on
    /// screen for one runloop turn is a delivery the next account can see.
    private func isolateFromPreviousAccount() {
        directoryTask?.cancel()
        directoryTask = nil
        for task in work.values { task.cancel() }
        for task in polls.values { task.cancel() }
        work = [:]
        polls = [:]
        records = [:]
        rows = []
        candidates = []
        selectedTargetID = nil
        directory = .idle
        refusal = nil
        actionError = nil
        publish()
    }

    // MARK: - targets

    /// Read the account's devices. Explicit: it is called when the surface
    /// appears and by the refresh control, never on a timer.
    public func refreshTargets(token: String) {
        refusal = nil
        guard accountId != nil, !token.isEmpty else {
            directory = .unavailable(.notAuthorized)
            return
        }
        let g = accountGeneration
        directoryTask?.cancel()
        directory = .loading
        let sender = makeSender(token)
        directoryTask = Task { [weak self] in
            do {
                let rows = try await sender.devices()
                guard let self, g == self.accountGeneration else { return }
                self.adopt(rows)
            } catch {
                guard let self, g == self.accountGeneration else { return }
                self.directory = .unavailable(Self.directoryFailure(for: error))
            }
        }
    }

    private func adopt(_ rows: [InboxDeviceRow]) {
        self.rows = rows
        candidates = InboxSendCandidate.candidates(from: rows)
        directory = .loaded
        // A device that has gone away, been revoked, or had receiving switched
        // off stops being the chosen one. Leaving it selected would put a Send
        // button in front of the user whose only outcome is a refusal.
        if let id = selectedTargetID,
           candidates.first(where: { $0.id == id && $0.isSendable }) == nil {
            selectedTargetID = nil
        }
        publish()
    }

    private static func directoryFailure(for error: Error) -> InboxSendDirectoryFailure {
        guard case .api(let status, _)? = error as? InboxError else { return .unreachable }
        return status == 401 || status == 403 ? .notAuthorized : .unreachable
    }

    /// Choose a device, or choose none. A blocked row can never become the
    /// selection: a selection the Send button then refuses is a dead end the
    /// user has to discover by pressing it.
    public func selectTarget(_ id: String?) {
        refusal = nil
        guard let id else { selectedTargetID = nil; return }
        guard candidates.first(where: { $0.id == id })?.isSendable == true else { return }
        selectedTargetID = id
    }

    // MARK: - outstanding work, read from disk

    /// Every durable device plan this account still has, plus the deliveries
    /// this session is watching. Touches no network.
    public func refreshOutstanding() {
        guard let accountId else { records = [:]; publish(); return }
        for plan in pending.store.deviceSendPlans(for: accountId) {
            guard let deviceID = plan.targetDeviceId else { continue }
            if var existing = records[plan.jobId] {
                // Only the durable half is refreshed. The activity is what the
                // user is reading — a stopped attempt's reason, a live upload's
                // progress — and re-deriving it from disk would erase it.
                existing.plan = plan
                records[plan.jobId] = existing
            } else {
                sequence += 1
                records[plan.jobId] = Record(plan: plan, result: nil, activity: .staged,
                                             files: Self.manifest(of: plan),
                                             fileCount: plan.files.count,
                                             byteCount: plan.totalBytes,
                                             targetDeviceID: deviceID,
                                             sequence: sequence)
            }
        }
        // A record whose plan is gone AND which this session is not watching is
        // a job some other process finished. Drop it rather than leave a card
        // nothing can act on.
        for (id, record) in records where record.plan == nil && record.result == nil
            && !record.activity.isRunning {
            if case .stopped = record.activity { continue }   // the reason is still worth reading
            if case .unknown = record.activity { continue }
            records.removeValue(forKey: id)
        }
        publish()
    }

    /// The list, newest first, keyed by the JOB rather than by the task.
    ///
    /// A job exists before any task does, so keeping the identity stable across
    /// the create is what stops a card disappearing and reappearing as a
    /// different one at the exact moment the user is watching it — and it is
    /// still stable afterwards, when the coordinator releases the plan and the
    /// row stops being a durable one.
    private func publish() {
        items = records
            .sorted { $0.value.sequence > $1.value.sequence }
            .map { job, record in
                InboxSendItem(
                    id: job, files: record.files,
                    fileCount: record.fileCount, byteCount: record.byteCount,
                    targetDeviceID: record.targetDeviceID,
                    targetName: candidates.first { $0.id == record.targetDeviceID }?.name,
                    activity: record.activity,
                    taskID: record.result?.task.id ?? record.plan?.deviceTaskId,
                    savedAt: record.result?.task.savedAt ?? 0,
                    expiresAt: record.result?.task.expiresAt ?? 0,
                    isRecoverable: record.plan != nil)
            }
    }

    // MARK: - sending

    /// Stage this selection as a delivery to the chosen device and drive it to a
    /// task.
    ///
    /// The order is the correctness, and it is the same order the stored-send
    /// path uses: the bytes become this app's own, the content key is filed
    /// under the job, and only then does anything leave the device. The
    /// idempotency key is minted once here, before the plan is written, so it
    /// exists on disk before a create could ever be attempted.
    public func send(files: [SelectedFile], sourceDraftId: String?, token: String) {
        refusal = nil
        actionError = nil
        guard let accountId, !accountId.isEmpty, !token.isEmpty else {
            refusal = .notSignedIn
            return
        }
        guard !files.isEmpty else { refusal = .noSelection; return }
        guard let targetID = selectedTargetID,
              let candidate = candidates.first(where: { $0.id == targetID }) else {
            refusal = .noTargetChosen
            return
        }
        // The row this list was built from, checked again rather than trusted.
        // It is deliberately NOT a fresh read of the account: this list can be
        // minutes old, so the authority on whether a device may be sent to is
        // central, and `InboxSendCoordinator` asks it before a byte of
        // ciphertext moves. What this catches is the cheaper mistake — a
        // selection and a candidate list that have drifted apart — which would
        // otherwise stage the user's files for a target this screen already
        // knows is refusable.
        guard let row = rows.first(where: { $0.id == targetID }),
              let target = InboxTargetEligibility.target(for: row) else {
            refusal = .targetUnavailable(candidate.availability.block ?? .cannotReceive)
            return
        }
        guard work[Self.stagingKey] == nil else { refusal = .alreadySending; return }

        let g = accountGeneration
        let store = pending.store
        let keys = pending.keys
        // Minted HERE, once, and written into the plan before any network work.
        let durableTarget = PendingUploadTarget(target)
        // On screen from the moment the button is pressed, and BEFORE the copy
        // starts. Staging a large video is the longest part of a send and it
        // produces no job id to render, so without this the user taps Send and
        // watches nothing happen for a minute — which is exactly when a second
        // tap, or a swipe out of the app, looks like the reasonable thing to do.
        stagePlaceholder(files: files, target: targetID)
        work[Self.stagingKey] = Task { [weak self] in
            var staged: PendingUploadPlan?
            var keyWasSaved = false
            do {
                let preparation = Task.detached(priority: .userInitiated) {
                    try store.prepare(files: files, accountId: accountId,
                                      // A delivery may never burn after read and
                                      // has a fixed TTL; the store refuses any
                                      // other pairing outright.
                                      burnAfterRead: false,
                                      ttl: UploadPurpose.deviceTaskTTLSeconds,
                                      sourceDraftId: sourceDraftId, target: durableTarget)
                }
                let plan = try await withTaskCancellationHandler {
                    try await preparation.value
                } onCancel: {
                    preparation.cancel()
                }
                staged = plan
                try Task.checkCancellation()
                let key = generateStoreKey()
                do {
                    try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
                    keyWasSaved = true
                } catch {
                    // A job whose key cannot be filed could never be opened by
                    // the target, so it must not be left on disk pretending to
                    // be a delivery. The shared draft is deliberately untouched:
                    // in this failure it is the user's only other copy.
                    store.purge(plan)
                    throw InboxSendRefusal.keyStorageFailed
                }
                guard let self, g == self.accountGeneration else { throw CancellationError() }
                // The running attempt moves from the staging slot to the job it
                // produced. Without this hand-over the task driving the upload
                // is tracked under nothing: Stop would report success and stop
                // nothing, and the card's own Stop button would be the control
                // that proves it.
                self.work[plan.jobId] = self.work[Self.stagingKey]
                self.work[Self.stagingKey] = nil
                self.adopt(plan, g: g)
                // The plan is on disk and its content key is in the Keychain, so
                // the job survives anything from here on. THAT is the moment the
                // shared draft stops being the user's only copy, and the only
                // moment removing it is safe.
                self.onSelectionCommitted?(accountId, plan.sourceDraftId)
                await self.run(plan, token: token, g: g)
            } catch {
                guard let self else { return }
                if let plan = staged, self.records[plan.jobId] == nil {
                    if keyWasSaved { try? await keys.remove(id: plan.jobId) }
                    store.purge(plan)
                }
                self.work[Self.stagingKey] = nil
                // The placeholder describes bytes this branch has just deleted,
                // or never copied. It goes whether or not the account moved.
                self.records.removeValue(forKey: Self.stagingKey)
                self.publish()
                guard g == self.accountGeneration else { return }
                if let refusal = error as? InboxSendRefusal {
                    self.refusal = refusal
                } else if !(error is CancellationError) {
                    self.refusal = .stagingFailed
                }
            }
        }
    }

    /// The key the ONE staging attempt is tracked under. A job id does not exist
    /// yet while a selection is being copied, and two concurrent stagings of the
    /// same selection would be two deliveries of the same files.
    ///
    /// It is also the id of the card that describes that copy, which is safe for
    /// the same reason it is unique: `PendingUploadStore` job ids are checked
    /// `StoredObjectID`s minted from a UUID, so no durable job can ever collide
    /// with it.
    // nonlocalized: an internal task-table and placeholder key, never displayed
    static let stagingKey = "staging"

    /// The card for a selection being copied into this app's own storage.
    ///
    /// It carries the real file count, byte total and target, so what the user
    /// reads while they wait describes what they actually chose.
    private func stagePlaceholder(files: [SelectedFile], target: String) {
        sequence += 1
        records[Self.stagingKey] = Record(
            plan: nil, result: nil, activity: .preparing,
            // From the picker's own descriptors, so the card describes what the
            // user chose while it is being copied — before a plan exists to read
            // a manifest from.
            files: files.map { FileMeta(name: $0.name, size: Int(max($0.byteCount ?? 0, 0)),
                                        path: $0.isNested ? $0.relativePath : nil) },
            fileCount: files.count,
            // A file the picker gave no size for contributes nothing rather than
            // a guess: the total is read as bytes, and the plan's own total
            // replaces this the moment the copy finishes.
            byteCount: files.reduce(0) { $0 + Int($1.byteCount ?? 0) },
            targetDeviceID: target, sequence: sequence)
        publish()
    }

    private func adopt(_ plan: PendingUploadPlan, g: Int) {
        guard g == accountGeneration, let deviceID = plan.targetDeviceId else { return }
        // The placeholder's place in the list, so the card the user is already
        // watching does not jump when it stops being a placeholder.
        var place = records[Self.stagingKey]?.sequence
        if place == nil {
            sequence += 1
            place = sequence
        }
        records.removeValue(forKey: Self.stagingKey)
        records[plan.jobId] = Record(plan: plan, result: nil,
                                     activity: initialActivity(for: plan),
                                     files: Self.manifest(of: plan),
                                     fileCount: plan.files.count,
                                     byteCount: plan.totalBytes,
                                     targetDeviceID: deviceID, sequence: place ?? sequence)
        publish()
    }

    /// A plan's manifest, in the shape every other send surface renders.
    ///
    /// `PendingUploadFile.staged` — the on-disk slot name — is deliberately not
    /// carried across. It is a path component inside this app's container and
    /// has no business on a screen; the NAME is the sanitized manifest identity
    /// the receiving side will rebuild.
    private static func manifest(of plan: PendingUploadPlan) -> [FileMeta] {
        plan.files.map { FileMeta(name: $0.name, size: $0.size) }
    }

    /// What a plan about to be attempted is doing, read from the plan itself.
    ///
    /// A resumed plan whose object central already holds reports `creating`
    /// rather than an upload at zero: its bytes are up, and a progress bar that
    /// never moves because there is nothing left to send reads as a stall.
    private func initialActivity(for plan: PendingUploadPlan) -> InboxSendActivity {
        plan.finalizedStoredId == nil ? .uploading(sent: 0, total: plan.totalBytes) : .creating
    }

    // MARK: - one attempt

    private func start(_ plan: PendingUploadPlan, token: String) {
        let g = accountGeneration
        work[plan.jobId]?.cancel()
        set(initialActivity(for: plan), for: plan.jobId, g: g)
        work[plan.jobId] = Task { [weak self] in
            await self?.run(plan, token: token, g: g)
        }
    }

    private func run(_ plan: PendingUploadPlan, token: String, g: Int) async {
        let coordinator = coordinator(token: token)
        let job = plan.jobId
        do {
            let result = try await coordinator.deliver(plan, token: token) { [weak self] sent, total in
                Task { @MainActor in self?.progress(sent: sent, total: total, job: job, g: g) }
            }
            guard g == accountGeneration else { return }
            adopt(result, for: job, g: g)
            poll(job: job, token: token, g: g)
        } catch let failure as InboxSendFailure {
            guard g == accountGeneration else { return }
            set(.stopped(failure), for: job, g: g)
        } catch is CancellationError {
            // The user stopped this attempt. Everything durable survives, so the
            // honest state is the one a recovered plan is in.
            guard g == accountGeneration else { return }
            set(.staged, for: job, g: g)
        } catch {
            guard g == accountGeneration else { return }
            set(.unknown, for: job, g: g)
        }
        guard g == accountGeneration else { return }
        work[job] = nil
        reloadPlan(for: job, g: g)
    }

    private func progress(sent: Int, total: Int, job: String, g: Int) {
        // Every byte is up and the create is what is left. Said out loud,
        // because a bar sitting at 100% with no sentence beside it is the exact
        // place a user concludes the file has arrived.
        guard total > 0, sent < total else { return set(.creating, for: job, g: g) }
        set(.uploading(sent: sent, total: total), for: job, g: g)
    }

    private func set(_ activity: InboxSendActivity, for job: String, g: Int) {
        guard g == accountGeneration, var record = records[job] else { return }
        record.activity = activity
        records[job] = record
        publish()
    }

    private func adopt(_ result: InboxSendResult, for job: String, g: Int) {
        guard g == accountGeneration, var record = records[job] else { return }
        record.result = result
        record.activity = .tracking(result.task.state)
        records[job] = record
        publish()
    }

    private func reloadPlan(for job: String, g: Int) {
        guard g == accountGeneration, var record = records[job], let accountId else { return }
        record.plan = pending.store.deviceSendPlans(for: accountId)
            .first { $0.jobId == job }
        records[job] = record
        publish()
    }

    // MARK: - watching one delivery

    /// Re-read one task's state until it can never change again.
    ///
    /// A poll that fails changes nothing: the last state central gave is still
    /// the last thing known, and turning a network failure into a delivery
    /// failure would report this device's connection as the target's answer.
    private func poll(job: String, token: String, g: Int) {
        polls[job]?.cancel()
        polls[job] = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, g == self.accountGeneration,
                      let current = self.records[job]?.result, !current.task.isTerminal else {
                    self?.polls[job] = nil
                    return
                }
                await self.sleeper.sleep(self.pollSeconds)
                guard !Task.isCancelled, g == self.accountGeneration,
                      let live = self.records[job]?.result else { return }
                let coordinator = self.coordinator(token: token)
                guard let task = try? await coordinator.state(of: live) else { continue }
                guard g == self.accountGeneration else { return }
                self.adopt(InboxSendResult(targetDeviceID: live.targetDeviceID, task: task,
                                           created: false, resealed: live.resealed),
                           for: job, g: g)
            }
        }
    }

    // MARK: - what the user may do about one send

    public func act(_ action: InboxSendAction, on itemID: String, token: String) {
        refusal = nil
        actionError = nil
        guard let record = records[itemID] else { return }
        switch action {
        case .send, .retry:
            guard let plan = record.plan, !record.activity.isRunning else { return }
            guard let accountId, plan.accountId == accountId, !token.isEmpty else {
                refusal = .notSignedIn
                return
            }
            start(plan, token: token)
        case .stopAttempt:
            // The durable plan, its staged bytes, its content key and its
            // idempotency key all survive. `run` reports `.staged`.
            work[itemID]?.cancel()
        case .cancelDelivery:
            cancelDelivery(itemID, token: token)
        case .discard:
            discard(itemID, token: token)
        case .dismiss:
            forget(itemID)
        }
    }

    private func cancelDelivery(_ job: String, token: String) {
        guard let result = records[job]?.result, !result.task.isTerminal else { return }
        guard !token.isEmpty else { refusal = .notSignedIn; return }
        let g = accountGeneration
        let coordinator = coordinator(token: token)
        work[job]?.cancel()
        work[job] = Task { [weak self] in
            do {
                try await coordinator.cancel(result)
                guard let self, g == self.accountGeneration else { return }
                self.work[job] = nil
                self.forget(job)
            } catch {
                guard let self, g == self.accountGeneration else { return }
                self.work[job] = nil
                // Central refuses a cancel while the target holds a live claim.
                // The card stays: removing it would leave the user with a file
                // arriving that nothing here can name or stop.
                self.actionError = .cancelRefused(itemID: job)
            }
        }
    }

    private func discard(_ job: String, token: String) {
        guard let record = records[job] else { return }
        guard let plan = record.plan else { return forget(job) }
        guard !token.isEmpty else { refusal = .notSignedIn; return }
        let g = accountGeneration
        let coordinator = coordinator(token: token)
        work[job]?.cancel()
        work[job] = Task { [weak self] in
            do {
                try await coordinator.discard(plan, token: token)
                guard let self, g == self.accountGeneration else { return }
                self.work[job] = nil
                self.forget(job)
            } catch {
                guard let self, g == self.accountGeneration else { return }
                self.work[job] = nil
                // `discard` cancels the task FIRST and releases nothing when
                // that is refused, so this is a live delivery and the record of
                // it has to stay.
                self.actionError = .cancelRefused(itemID: job)
                self.reloadPlan(for: job, g: g)
            }
        }
    }

    /// Stop showing a send. Removes nothing anywhere — not on disk, not on
    /// central — which is why it is only ever offered for one that is finished.
    private func forget(_ job: String) {
        polls[job]?.cancel()
        polls[job] = nil
        work[job]?.cancel()
        work[job] = nil
        records.removeValue(forKey: job)
        publish()
    }

    private func coordinator(token: String) -> InboxSendCoordinator {
        InboxSendCoordinator(store: pending.store, keys: pending.keys, uploader: uploader,
                             sender: makeSender(token), objects: objects)
    }
}
