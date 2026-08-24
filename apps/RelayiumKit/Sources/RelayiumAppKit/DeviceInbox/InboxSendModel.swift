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
    /// Every account device, including this installation. Unlike `candidates`,
    /// this directory exists for management and therefore never drops the
    /// current or non-receiving rows.
    @Published public private(set) var devices: [InboxDeviceRow] = []
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
    @Published public private(set) var renamingDeviceIDs: Set<String> = []
    @Published public private(set) var renameFailureDeviceID: String?

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

    /// Announced, on the main actor, the moment a durable device job exists and
    /// BEFORE network delivery proceeds — and again whenever a later process
    /// rediscovers that plan on disk.
    ///
    /// This is how the local conversation gains its outgoing half without this
    /// model learning what a conversation index is. It stays a closure, exactly
    /// like `onSelectionCommitted` above, for the reason recorded there and one
    /// more: every test in `InboxSendModelTests` drives this model with no
    /// Application Support directory at all, and a direct store reference would
    /// make that impossible.
    ///
    /// The second argument PRODUCES the message body, and is deliberately a
    /// closure rather than a value.
    ///
    /// For a text send the user just composed it simply returns what they typed.
    /// For a plan rediscovered in a later process it re-reads the staged
    /// plaintext this app already owns — which is what closes the crash window
    /// between a durable plan existing and its history row being written. Before
    /// that backfill, a send interrupted in that window came back after a
    /// relaunch as a message row with no body: permanently "not available",
    /// because the only copy the app still had was the staged one and nothing
    /// ever looked at it.
    ///
    /// It is a closure so that plaintext is read ONLY when the receiving side
    /// has decided it actually needs a body — the common recovery, where history
    /// already holds the message, never touches the staged bytes at all. It
    /// returns nil for a file delivery, and for a text plan whose staging is
    /// gone.
    public var onSentHistory: (@MainActor (InboxSentHistoryEvent,
                                           @MainActor () -> String?) -> Void)?

    /// Announced whenever what is known about one outgoing delivery changes.
    ///
    /// Deliberately separate from `onSentHistory`: a state change must never be
    /// able to CREATE a row. If it could, an update arriving after the user
    /// deleted the history would write the entry back — which is the exact
    /// resurrection the tombstones exist to prevent, reintroduced one layer up.
    public var onSentStateChanged: (@MainActor (_ accountId: String, _ jobID: String,
                                                _ state: InboxTimelineEntry.SentState,
                                                _ taskID: String?) -> Void)?

    /// Whether the user has deleted this job's local history.
    ///
    /// A deleted send stops being described here — the card goes — while the
    /// delivery itself continues untouched: no cancel, no discard, no staged byte
    /// removed and no idempotency key invalidated. The confirmation the user saw
    /// says exactly that, and offers the real cancel separately when one is
    /// genuinely available.
    ///
    /// Defaulted to "nothing is deleted", so every existing harness and the iOS
    /// host are unchanged.
    public var isSentHistoryDeleted: (@MainActor (_ accountId: String,
                                                 _ jobID: String) -> Bool)?

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
    private var renameTasks: [String: Task<Void, Never>] = [:]
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
        for task in renameTasks.values { task.cancel() }
        renameTasks = [:]
        for task in work.values { task.cancel() }
        for task in polls.values { task.cancel() }
        work = [:]
        polls = [:]
        records = [:]
        rows = []
        devices = []
        candidates = []
        selectedTargetID = nil
        directory = .idle
        refusal = nil
        actionError = nil
        renamingDeviceIDs = []
        renameFailureDeviceID = nil
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
        devices = rows
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

    /// Rename by the server-issued row id. Duplicate labels are deliberately
    /// allowed; identity and every later action remain keyed by `id`.
    @discardableResult
    public func renameDevice(id: String, name: String, token: String) -> Task<Void, Never>? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard accountId != nil, !token.isEmpty, !trimmed.isEmpty,
              rows.contains(where: { $0.id == id }) else { return nil }
        let g = accountGeneration
        renameTasks[id]?.cancel()
        renamingDeviceIDs.insert(id)
        renameFailureDeviceID = nil
        let sender = makeSender(token)
        let task = Task { [weak self] in
            do {
                try await sender.renameDevice(deviceID: id, name: trimmed)
                guard let self, g == self.accountGeneration else { return }
                self.renameTasks[id] = nil
                self.renamingDeviceIDs.remove(id)
                self.refreshTargets(token: token)
            } catch {
                guard let self, g == self.accountGeneration else { return }
                self.renameTasks[id] = nil
                self.renamingDeviceIDs.remove(id)
                self.renameFailureDeviceID = id
            }
        }
        renameTasks[id] = task
        return task
    }

    private static func directoryFailure(for error: Error) -> InboxSendDirectoryFailure {
        guard case .api(let status, _)? = error as? InboxError else { return .unreachable }
        return status == 401 || status == 403 ? .notAuthorized : .unreachable
    }

    /// The chosen device as the picker describes it, or nil.
    ///
    /// **The single answer to "is a per-device screen still legal".** A macOS
    /// send screen is bound to one device, and the three ways that binding can
    /// stop being true are already handled here rather than anywhere a view
    /// could reimplement them: `adopt(_ rows:)` drops a selection whose device
    /// went away, was revoked or had receiving switched off, and
    /// `isolateFromPreviousAccount` drops it when the account changes. A surface
    /// that renders only while this is non-nil therefore returns to the list by
    /// construction instead of sending to whichever row moved into that place.
    ///
    /// Computed rather than published: it is a lookup in two values that are
    /// already `@Published`, so a view reading it redraws when either moves and
    /// there is no third copy of the selection to fall out of step.
    public var selectedCandidate: InboxSendCandidate? {
        guard let selectedTargetID else { return nil }
        return candidates.first { $0.id == selectedTargetID }
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
                // A plan this process has not seen before: either a recovery
                // after a relaunch, or a crash between the plan being written
                // and its history row. Materialize by the plan's REAL job id and
                // its own creation time, so a recovered send keeps its place in
                // the timeline instead of jumping to the top on every launch.
                // Tombstoned jobs are refused by the store's write gate, so this
                // cannot resurrect a deleted send.
                //
                // No `messageText`: this process never saw the string. The body
                // provider re-reads the staged plaintext instead, and only if the
                // history is actually missing a body — which is what makes a
                // text send interrupted in that window come back as the message
                // the user wrote rather than as a permanently empty row.
                announceSentHistory(plan, state: .staged, accountId: accountId)
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
            // A job whose local history the user deleted stops being described.
            // Nothing about the delivery changes; this is the card, not the send.
            .filter { job, _ in
                guard let accountId else { return true }
                return !(isSentHistoryDeleted?(accountId, job) ?? false)
            }
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
                // And the same moment the local history may honestly say this
                // Mac sent something: durable, before any byte leaves.
                self.announceSentHistory(plan, state: .staged, accountId: accountId)
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

    /// Stage one MESSAGE as a delivery to the chosen device and drive it to a
    /// task.
    ///
    /// The same durable machinery a file send uses, and deliberately so: the
    /// idempotency key is minted once and written before any network work, the
    /// content key is filed under the job, an ambiguous create converges rather
    /// than queueing a second delivery, and a retry rebuilds the identical
    /// manifest from the plan. A message is not special enough to earn a second
    /// copy of that.
    ///
    /// What IS different is stated in three places and nowhere else: the plan
    /// records `deliveryKind: .text`, the manifest carries one `text` item and
    /// only its byte length, and the target must announce `inbox.text.v1`.
    ///
    /// The message body never reaches central, the manifest, the card, a log or
    /// this model's published state — only its length does. Its bytes are the
    /// payload frames, and nothing else.
    ///
    /// **One kind per delivery**: there are no attachments here and no parameter
    /// for one. A mixed manifest is refused by the codec, so mixing could only
    /// ever produce a delivery no receiver accepts.
    public func sendText(_ message: String, token: String) {
        refusal = nil
        actionError = nil
        guard let accountId, !accountId.isEmpty, !token.isEmpty else {
            refusal = .notSignedIn
            return
        }
        // Measured in UTF-8 BYTES, which is what the manifest declares and what
        // the receiver re-measures. A per-Character bound would let one emoji
        // past a check the seal then refuses.
        let bytes = Array(message.utf8)
        guard bytes.count >= InboxManifest.minTextBytes else { refusal = .messageEmpty; return }
        guard bytes.count <= InboxManifest.maxTextBytes else { refusal = .messageTooLong; return }
        guard let targetID = selectedTargetID,
              let candidate = candidates.first(where: { $0.id == targetID }) else {
            refusal = .noTargetChosen
            return
        }
        guard let row = rows.first(where: { $0.id == targetID }),
              let target = InboxTargetEligibility.target(for: row) else {
            refusal = .targetUnavailable(candidate.availability.block ?? .cannotReceive)
            return
        }
        // Checked AFTER the general verdict so the sentence a user reads names
        // the first thing that would have to change: a revoked device is
        // revoked, not "cannot present text". The coordinator re-checks this
        // against a fresh device read before a byte moves.
        guard InboxTargetEligibility.canReceiveText(row) else {
            refusal = .textUnsupported
            return
        }
        guard work[Self.stagingKey] == nil else { refusal = .alreadySending; return }

        let g = accountGeneration
        let store = pending.store
        let keys = pending.keys
        let durableTarget = PendingUploadTarget(target)
        stageTextPlaceholder(byteCount: bytes.count, target: targetID)
        work[Self.stagingKey] = Task { [weak self] in
            var staged: PendingUploadPlan?
            var keyWasSaved = false
            do {
                let preparation = Task.detached(priority: .userInitiated) {
                    // The source is built INSIDE the detached task, from the
                    // bytes alone, so nothing carrying the message crosses an
                    // isolation boundary as a live object.
                    try store.prepare(sources: [DataSource(name: Self.messageStagingName,
                                                           bytes: bytes)],
                                      accountId: accountId, burnAfterRead: false,
                                      ttl: UploadPurpose.deviceTaskTTLSeconds,
                                      sourceDraftId: nil, target: durableTarget,
                                      deliveryKind: .text)
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
                    store.purge(plan)
                    throw InboxSendRefusal.keyStorageFailed
                }
                guard let self, g == self.accountGeneration else { throw CancellationError() }
                self.work[plan.jobId] = self.work[Self.stagingKey]
                self.work[Self.stagingKey] = nil
                self.adopt(plan, g: g)
                // No `onSelectionCommitted`: a message has no shared draft and
                // no picked selection behind it, so there is nothing to retire
                // and nothing whose last copy this staging just became.
                //
                // The BODY is handed over exactly here and nowhere else. It goes
                // to the protected sent-message store, keyed by this job — never
                // to central, a manifest, a log, a notification or a file name —
                // and it is what makes a conversation able to show what this Mac
                // actually said rather than "a message, 42 bytes".
                self.announceSentHistory(plan, state: .staged, accountId: accountId,
                                         messageText: message)
                await self.run(plan, token: token, g: g)
            } catch {
                guard let self else { return }
                if let plan = staged, self.records[plan.jobId] == nil {
                    if keyWasSaved { try? await keys.remove(id: plan.jobId) }
                    store.purge(plan)
                }
                self.work[Self.stagingKey] = nil
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

    /// The on-disk slot label for a staged message.
    ///
    /// It is a `PendingUploadFile.name`, which the store requires to be
    /// non-empty, and it goes NOWHERE else: the v2 manifest omits `name`
    /// entirely for a text item, and `manifest(of:)` below hands the card an
    /// empty file list for a text plan. So this string is never sealed, never
    /// sent and never displayed.
    ///
    /// `nonisolated` because it is read inside the `Task.detached` that prepares
    /// the message, which does not inherit this actor. That is sound rather than
    /// a waiver: it is an immutable `Sendable` literal, not main-actor state, so
    /// there is nothing for the detached read to race against. `stagingKey`
    /// below stays isolated because every one of its reads is already on the
    /// main actor.
    // nonlocalized: an internal staging label, never displayed and never sealed
    nonisolated static let messageStagingName = "message"

    /// The card for a message being staged. It carries the byte count and the
    /// target — never the message.
    private func stageTextPlaceholder(byteCount: Int, target: String) {
        sequence += 1
        records[Self.stagingKey] = Record(
            plan: nil, result: nil, activity: .preparing,
            files: [], fileCount: 1, byteCount: byteCount,
            targetDeviceID: target, sequence: sequence)
        publish()
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

    /// Hand this send's durable identity to whoever keeps the local history.
    ///
    /// **Only ever from a real plan.** `Self.stagingKey` is a global singleton
    /// slot two concurrent stagings would share, so a durable row built on it
    /// would be one send overwriting another's history; the store refuses it
    /// too, in `InboxConversationStore.valid`.
    ///
    /// The manifest names are the plan's own — already sanitized, already what
    /// every other send surface renders — and the staged slot names are
    /// deliberately not carried across.
    private func announceSentHistory(_ plan: PendingUploadPlan,
                                     state: InboxTimelineEntry.SentState,
                                     accountId: String, messageText: String? = nil) {
        guard let onSentHistory, let deviceID = plan.targetDeviceId,
              plan.jobId != Self.stagingKey, plan.accountId == accountId else { return }
        let kind: InboxTimelineEntry.Kind =
            plan.effectiveDeliveryKind == .text ? .message : .files
        // The body the caller already holds, or — for a recovered plan, which
        // has none — the staged plaintext, read only if it is asked for.
        let body: @MainActor () -> String? = { [weak self] in
            guard kind == .message else { return nil }
            if let messageText { return messageText }
            return self?.stagedMessageBody(of: plan)
        }
        let event = InboxSentHistoryEvent(
            accountID: accountId, jobID: plan.jobId, peerDeviceID: deviceID,
            kind: kind,
            // The plan's own creation time: local, durable, and identical on
            // every later recovery of the same plan.
            at: Date(timeIntervalSince1970: TimeInterval(plan.createdAt)),
            byteCount: Int64(plan.totalBytes),
            files: kind == .files
                ? plan.files.map { InboxTimelineEntry.FileNameSnapshot(name: $0.name,
                                                                       size: Int64($0.size)) }
                : [],
            state: state, taskID: plan.deviceTaskId)
        onSentHistory(event, body)
    }

    /// The message a text plan is still holding, read back from this app's own
    /// staged copy.
    ///
    /// **Only ever the staged copy.** These are bytes `PendingUploadStore
    /// .prepare` already wrote inside this app's container from the string the
    /// user typed, so reading them re-derives nothing and reaches nothing the
    /// user owns — no source file, no receive folder, no network. It is also the
    /// only remaining copy after a crash between staging and the history row,
    /// which is exactly the case this exists for.
    ///
    /// A file plan is refused before any read: `sources(for:)` on a multi-file
    /// job would open the user's actual content, and a file delivery has no body
    /// to recover in the first place.
    private func stagedMessageBody(of plan: PendingUploadPlan) -> String? {
        guard plan.effectiveDeliveryKind == .text, plan.files.count == 1,
              plan.files[0].size >= InboxManifest.minTextBytes,
              plan.files[0].size <= InboxManifest.maxTextBytes,
              var source = try? pending.store.sources(for: plan).first else { return nil }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(plan.files[0].size)
        while bytes.count < plan.files[0].size {
            guard let chunk = try? source.read(plan.files[0].size - bytes.count),
                  !chunk.isEmpty else { return nil }
            bytes.append(contentsOf: chunk)
        }
        // Refused rather than repaired if it is not the text that was staged:
        // a body this app cannot decode is one it must not claim the user wrote.
        guard let text = String(bytes: bytes, encoding: .utf8),
              InboxMessageStore.isAcceptable(text) else { return nil }
        return text
    }

    /// The durable snapshot of what one activity means for a delivery.
    ///
    /// **`saved` is reachable through exactly one predicate.** Everything local —
    /// preparing, uploading, creating — is `sending`, because an upload is not a
    /// delivery; only `InboxSendActivity.isSavedOnTarget`, which is
    /// `tracking(.saved)`, produces an arrival. Every case below is writable, so
    /// there is no state in the durable enum that nothing can ever put there.
    static func sentState(for activity: InboxSendActivity) -> InboxTimelineEntry.SentState {
        if activity.isSavedOnTarget { return .saved }
        switch activity {
        case .staged: return .staged
        case .preparing, .uploading, .creating: return .sending
        case .unknown: return .unknown
        case .stopped: return .stopped
        case .tracking(let state):
            switch state {
            case .expired, .revoked, .failedTerminal: return .stopped
            case .queued, .notified, .downloading, .verifying, .attentionRequired,
                 .failedRetryable: return .created
            case .saved: return .saved     // unreachable: isSavedOnTarget above
            }
        }
    }

    /// A plan's manifest, in the shape every other send surface renders.
    ///
    /// `PendingUploadFile.staged` — the on-disk slot name — is deliberately not
    /// carried across. It is a path component inside this app's container and
    /// has no business on a screen; the NAME is the sanitized manifest identity
    /// the receiving side will rebuild.
    private static func manifest(of plan: PendingUploadPlan) -> [FileMeta] {
        // A MESSAGE has no file list. Its plan carries one staged entry under an
        // internal slot label, and handing that label to a card would put a
        // fabricated file name in front of the user for a delivery that is not a
        // file. The byte count on the record is the whole truthful description.
        guard plan.effectiveDeliveryKind == .file else { return [] }
        return plan.files.map { FileMeta(name: $0.name, size: $0.size) }
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
        announceSentState(job: job, activity: activity, taskID: record.result?.task.id)
    }

    private func adopt(_ result: InboxSendResult, for job: String, g: Int) {
        guard g == accountGeneration, var record = records[job] else { return }
        record.result = result
        record.activity = .tracking(result.task.state)
        records[job] = record
        publish()
        announceSentState(job: job, activity: record.activity, taskID: result.task.id)
    }

    /// Report what is now known, and never create a row by doing so.
    ///
    /// The staging placeholder is excluded because it is not a delivery yet and
    /// has no durable identity to report against.
    private func announceSentState(job: String, activity: InboxSendActivity,
                                   taskID: String?) {
        guard let onSentStateChanged, let accountId, job != Self.stagingKey else { return }
        onSentStateChanged(accountId, job, Self.sentState(for: activity), taskID)
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
