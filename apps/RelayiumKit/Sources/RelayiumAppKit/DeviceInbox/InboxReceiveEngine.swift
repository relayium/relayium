import Foundation
@preconcurrency import RelayiumKit

/// One pass of the receive loop: say what this Mac can do, ask whether there is
/// work, take at most one task, and report exactly what happened to it.
///
/// A single BOUNDED pass rather than a resident loop. The scheduling shell —
/// menu-bar residency, login-item behaviour, notifications and the settings UI —
/// is a separate concern; what belongs here is the part where a wrong decision
/// loses a user's file, and that part has to be drivable to completion by a test
/// with no timers in it.
///
/// WHAT KEEPS IT HONEST:
///
///   - Presence is asserted only while this Mac can actually receive. An
///     unusable receive folder is REPORTED as such rather than papered over.
///   - Nothing is claimed that will not be worked: one task per pass, worked to a
///     terminal report before another can be taken.
///   - `saved` is reported only from a completed local commit, and a task whose
///     journal already says completed is re-reported rather than re-delivered.
public struct InboxReceiveEngine: Sendable {
    public let transport: InboxTransport
    public let keys: InboxDeviceKeyStoring
    public let journals: InboxJournalStore
    /// Where a received message is committed. Independent of `folder` on
    /// purpose: see `InboxMessageStore`.
    public let messages: InboxMessageStore
    public let folder: InboxReceiveFolder
    public let account: InboxAccountID
    public let now: @Sendable () -> Date
    /// `var` so the scheduling shell can attach its own observer to an engine it
    /// was handed by a factory. Every event is a closed case carrying at most a
    /// task id, a protocol state, a closed code and counts — see `InboxLogEvent`.
    public var log: InboxLog?
    /// Passed through to the receiver; see `InboxReceiver.renewInterval`.
    public var renewInterval: TimeInterval
    public var streamAttempts: Int
    /// Free space on the receive volume; see `InboxReceiver.freeBytes`. Passed to
    /// the receiver AND used by the disk-full requeue, so the two cannot disagree
    /// about whether a parked delivery now fits.
    public var freeBytes: @Sendable (URL) -> Int64?
    /// Every task central currently holds for this device, as read at the top of
    /// a pass. The scheduling shell needs it to render an `ask` question and an
    /// `attention_required` blocker; the engine itself only ever acts on the
    /// narrow subset `requeueRecovered` describes.
    ///
    /// Called with the raw list, before any decision is taken about it, so a
    /// caller sees what central said rather than what this pass did with it.
    public var onPending: (@Sendable ([InboxTask]) -> Void)?
    /// A DURABLE commit, and the only event in the product from which a "saved"
    /// claim may be built. Emitted after `InboxReceiver.deliver` has returned and
    /// the journal says completed — never from a claim, a byte count or a report.
    public var onReceipt: (@Sendable (InboxReceipt) throws -> Void)?

    public init(transport: InboxTransport, keys: InboxDeviceKeyStoring,
                journals: InboxJournalStore, messages: InboxMessageStore,
                folder: InboxReceiveFolder,
                account: InboxAccountID,
                now: @escaping @Sendable () -> Date = { Date() },
                log: InboxLog? = nil,
                renewInterval: TimeInterval = Double(InboxProtocol.defaultLeaseSeconds) / 3,
                streamAttempts: Int = 5,
                freeBytes: @escaping @Sendable (URL) -> Int64? = InboxSpace.freeBytes) {
        self.transport = transport
        self.keys = keys
        self.journals = journals
        self.messages = messages
        self.folder = folder
        self.account = account
        self.now = now
        self.log = log
        self.renewInterval = renewInterval
        self.streamAttempts = streamAttempts
        self.freeBytes = freeBytes
    }

    /// What one pass established.
    public enum PassResult: Equatable, Sendable {
        /// A delivery was worked to a terminal report in this pass.
        case worked
        /// Central had nothing for this device.
        case idle
        /// This Mac cannot receive right now, so nothing was claimed. Carries the
        /// state a person needs to act on.
        case notReceiving(InboxFolderState)
    }

    /// The receive policy this device announces.
    ///
    /// `off` unless the user has explicitly chosen otherwise for THIS account. A
    /// device that announces `off` makes central refuse task creation outright
    /// (`auto_receive_disabled`), which is the truthful answer: queuing a task
    /// this Mac will never take would be a lie in the sender's UI.
    ///
    /// Note what it does NOT depend on: whether the folder is usable right now. An
    /// enabled device with a broken folder still announces its policy and reports
    /// `receiveDirReady: false`, so central starts the task in
    /// `attention_required` — "your Mac is set up for this and something is wrong
    /// with the folder", not "your Mac does not do this".
    public var announcedPolicy: InboxAutoAccept {
        folder.receivePolicy(account: account)
    }

    /// Enrol and make this account's device key usable. Run once before passes.
    ///
    /// `capabilities` is what this BUILD announces, handed down from the app
    /// that composed the controller. Defaulted to the base set so a caller that
    /// says nothing claims nothing extra.
    @discardableResult
    public func prepare(platform: String, appVersion: String,
                        capabilities: [String] = InboxProtocol.capabilities)
        async throws -> InboxKey {
        let opened = folder.open(account: account)
        defer { opened.access?.release() }
        let result = try await InboxEnrolment.enrol(transport, platform: platform,
                                                   appVersion: appVersion,
                                                   capabilities: capabilities,
                                                   autoAccept: announcedPolicy,
                                                   receiveDirReady: opened.state.canReceive)
        return try await InboxEnrolment.ensureUsableKey(transport: transport, keys: keys,
                                                        account: account,
                                                        current: result.inbox.key, now: now())
    }

    /// Answer a task central is holding under the `ask` policy.
    ///
    /// The ONLY way a held task is ever resolved. `requeueRecovered` explicitly
    /// refuses to touch one, so nothing in this engine can answer for the user;
    /// reaching this method requires a person to have pressed something.
    public func respond(toAsk taskID: String, accept: Bool) async throws {
        _ = try await transport.accept(taskID: taskID, accept: accept)
    }

    /// Tell central this device is no longer taking deliveries.
    ///
    /// The counterpart of `prepare`, and it is NOT optional politeness. Central
    /// keeps the last policy a device announced, so a Mac whose owner switched
    /// receiving off would go on being offered as an `auto` target: the sender's
    /// UI would accept the send, the task would be queued, and it would sit there
    /// until it expired. Announcing `off` makes central refuse the send outright
    /// (`auto_receive_disabled`), which is the truthful answer.
    ///
    /// The enrolment is announced WITHOUT touching the key history. Registering a
    /// device key is work the user has just said they do not want done.
    public func announceStopped(platform: String, appVersion: String,
                                capabilities: [String] = InboxProtocol.capabilities)
        async throws {
        let opened = folder.open(account: account)
        defer { opened.access?.release() }
        _ = try await InboxEnrolment.enrol(transport, platform: platform,
                                           appVersion: appVersion,
                                           capabilities: capabilities,
                                           autoAccept: announcedPolicy,
                                           receiveDirReady: opened.state.canReceive)
        // Presence is a claim about NOW. This device is about to stop polling,
        // and a sender watching an "online" Mac that is not listening is exactly
        // the misleading state PRD §7 refuses.
        try await transport.goOffline()
    }

    /// One pass.
    ///
    /// The folder is opened ONCE and its security scope held for the whole pass,
    /// including the commit. Re-opening it per step would take and release a
    /// sandbox extension around every syscall and would leave a window in which
    /// the scope is closed while staged plaintext is on disk.
    public func pass() async throws -> PassResult {
        let opened = folder.open(account: account)
        defer { opened.access?.release() }

        if case .unavailable(let problem) = opened.state {
            log?(.receiveFolder(problem: problem))
        }

        // Presence is a claim about NOW, and it carries the folder verdict this
        // pass just measured — a real create-and-remove probe, not an inspection
        // of permission bits.
        try await transport.heartbeat(receiveDirReady: opened.state.canReceive)

        // A folder verdict is NOT the claim gate any more, and that is the whole
        // point of the v2 receiver: a message is committed to the protected
        // message store and never to the receive folder, so an unusable folder
        // must not stop one from landing. The pass goes on to claim; the
        // receiver decodes the manifest, decides the kind, and only a FILE
        // delivery reports `directory_unavailable` back to central.
        //
        // What an unusable folder still does: it is reported on the heartbeat
        // above, so central holds new tasks in `attention_required` rather than
        // queuing them, and it is what `.notReceiving` says when this pass has
        // nothing else to report.
        let root = opened.state.url

        let pending = try await transport.pending(limit: InboxProtocol.claimBatch)
        onPending?(pending)
        if pending.isEmpty {
            // The JOURNAL is pruned here and the message store is NOT, which is
            // the whole distinction between the two. A journal entry is
            // bookkeeping ABOUT a delivery and expires once it can no longer
            // prevent a duplicate or a data loss; a message IS the delivery —
            // the user's own content, received once and held until they say
            // otherwise. Deleting it on a timer nobody chose would be data loss
            // dressed as housekeeping, so there is no timer and no cutoff to
            // reach for: see `InboxMessageStore`.
            journals.prune(now: now())
            return root == nil ? .notReceiving(opened.state) : .idle
        }
        if let root {
            // A write probe says the folder is writable; it does not say it now
            // has room for a task that was parked as `disk_full`. Re-check that
            // task's own declared size, and re-queue it only once the same
            // preflight the receiver uses would pass. That makes "free some
            // space" self-healing without turning a still-full disk into a
            // claim/report busy loop.
            await requeueRecovered(pending, root: root)
        } else {
            await requeueUnjudged(pending)
        }

        let claimed = try await transport.claim(max: InboxProtocol.claimBatch)
        guard let delivery = claimed.deliveries.first else {
            // Pending said there was work but the claim leased none: another worker
            // took it, or it expired between the two calls. Not an error.
            return root == nil ? .notReceiving(opened.state) : .idle
        }
        log?(.claimed(taskID: delivery.task.id,
                      ciphertextBytes: delivery.task.ciphertextBytes))

        var receiver = InboxReceiver(transport: transport, keys: keys, journals: journals,
                                     messages: messages, account: account, root: root,
                                     now: now, log: log,
                                     renewInterval: renewInterval, streamAttempts: streamAttempts,
                                     freeBytes: freeBytes)
        if claimed.leaseSeconds > 0 {
            // Follow what CENTRAL says a lease lasts rather than the compiled-in
            // constant, so a server that shortens it is followed instead of
            // contradicted.
            receiver.renewInterval = Double(claimed.leaseSeconds) / 3
        }

        do {
            let outcome = try await receiver.deliver(delivery)
            try receiver.bindAuthenticatedSender(delivery.task)
            try emitReceipt(taskID: delivery.task.id,
                            isReplay: outcome == .alreadyCommitted)
            await reportSaved(delivery, receiver: receiver)
        } catch is CancellationError {
            // A policy change, sign-out or account switch owns
            // this cancellation. Reporting it as a device/filesystem failure
            // would mutate central under a generation the user already ended.
            throw CancellationError()
        } catch let abandon as InboxAbandon {
            // Central already took the task away. Silence is the only safe answer.
            log?(.abandoned(taskID: delivery.task.id, cause: abandon.cause))
        } catch {
            let failure = (error as? InboxFailure) ?? InboxClassify.filesystem(error)
            await report(delivery, state: failure.state, code: failure.code)
        }
        return .worked
    }

    /// Publish the durable commit, reading it back out of the journal.
    ///
    /// Read back rather than assembled from the delivery: the journal is what the
    /// commit itself wrote, entry by entry, so a partially committed task cannot
    /// produce a receipt naming files that were never created — and a receipt and
    /// a crash recovery can never disagree about what is on disk.
    private func emitReceipt(taskID: String, isReplay: Bool) throws {
        guard let onReceipt else { throw InboxFailure.retryable(.internal, .unexpected) }
        let journal: InboxJournal
        do {
            guard let loaded = try journals.load(taskID) else { throw InboxJournalError.unreadable }
            journal = loaded
        } catch { throw InboxClassify.filesystem(error) }
        guard let receipt = InboxReceipt.make(taskID: taskID, journal: journal,
                                              isReplay: isReplay),
              receipt.senderDeviceID != InboxConversationStore.legacySenderID else {
            throw InboxFailure.retryable(.internal, .unexpected)
        }
        try onReceipt(receipt)
    }

    /// Assert the commit, then record that central acknowledged it.
    ///
    /// The journal is what makes this idempotent across a lost response: it
    /// already says completed, so a re-claimed task skips straight back to here
    /// rather than downloading and committing a second time.
    private func reportSaved(_ delivery: InboxDelivery, receiver: InboxReceiver) async {
        // `saved` is reachable only from `verifying`, so assert that first.
        // Reporting the state a task is already in is an idempotent no-op, which
        // makes this safe on a retry.
        do {
            try await transport.report(taskID: delivery.task.id, claimToken: delivery.claimToken,
                                       state: .verifying, errorCode: .none, committed: false)
        } catch let error as InboxError where error.rejection == .taskTerminal {
            receiver.markSavedReported(delivery.task.id)
            return
        } catch {
            // The files ARE on disk. The report is retried on the next claim from
            // the journal, never by re-delivering.
            log?(.reportFailed(taskID: delivery.task.id, state: .verifying))
            return
        }
        do {
            try await transport.report(taskID: delivery.task.id, claimToken: delivery.claimToken,
                                       state: .saved, errorCode: .none, committed: true)
        } catch let error as InboxError where error.rejection == .taskTerminal {
            // Central already recorded the outcome — this is the retry converging.
            receiver.markSavedReported(delivery.task.id)
            return
        } catch {
            log?(.reportFailed(taskID: delivery.task.id, state: .saved))
            return
        }
        log?(.reported(taskID: delivery.task.id, state: .saved, code: .none))
        receiver.markSavedReported(delivery.task.id)
    }

    private func report(_ delivery: InboxDelivery, state: InboxTaskState,
                        code: InboxDeviceErrorCode) async {
        do {
            try await transport.report(taskID: delivery.task.id, claimToken: delivery.claimToken,
                                       state: state, errorCode: code, committed: false)
            log?(.reported(taskID: delivery.task.id, state: state, code: code))
        } catch {
            log?(.reportFailed(taskID: delivery.task.id, state: state))
        }
    }

    /// Re-queue the tasks CENTRAL parked because this device last reported an
    /// unusable receive folder, so their kind can be discovered.
    ///
    /// Central cannot know what a delivery contains — kind is sealed — so when a
    /// device reports `receiveDirReady: false` it holds every new task in
    /// `attention_required`, message or not. Left alone, a message would be
    /// blocked by a folder it was never going to touch, which is exactly what v2
    /// says must not happen. The only way to find out which it is, is to claim
    /// it: a message then commits to the message store, and a file delivery is
    /// re-parked with `directory_unavailable` — a better answer than the empty
    /// code it had, and one `requeueRecovered` will act on once the folder works.
    ///
    /// Two guards make this narrow rather than a blanket unpark:
    ///
    ///   - **Only under `auto`.** A task with no error code under the `ask`
    ///     policy is a question waiting for the USER. Accepting one would be this
    ///     machine answering on their behalf, which is the one thing the ask
    ///     policy exists to prevent.
    ///   - **Only with NO error code.** A task carrying one was parked for a
    ///     blocker this device reported; `requeueRecovered` owns those, and it
    ///     only clears them once the condition is actually gone. That is also
    ///     what makes this converge instead of looping: a file delivery claimed
    ///     here comes back with a code and is not picked up again.
    private func requeueUnjudged(_ tasks: [InboxTask]) async {
        guard announcedPolicy == .auto else { return }
        for task in tasks where task.state == .attentionRequired && task.errorCode.isNone {
            _ = try? await transport.accept(taskID: task.id, accept: true)
        }
    }

    /// Re-queue the `attention_required` tasks this device parked for a local
    /// blocker that has now cleared.
    ///
    /// The filter is deliberately narrow. Disk space is decided per task, because
    /// an empty-file readiness probe can succeed while the task still does not
    /// fit. A `name_conflict` needs a person to look at the folder. And a task
    /// held under the `ask` policy carries NO error code at all — auto-accepting
    /// it would be this machine answering a question that was asked of its owner
    /// (PRD §8).
    private func requeueRecovered(_ tasks: [InboxTask], root: URL) async {
        for task in tasks where task.state == .attentionRequired {
            switch task.errorCode {
            case .device(.diskFull):
                guard InboxSpace.hasRoom(at: root, for: task.ciphertextBytes,
                                         freeBytes: freeBytes) else { continue }
            case .device(.permissionDenied), .device(.directoryUnavailable):
                break        // the folder probe above already said it is usable now
            default:
                continue
            }
            _ = try? await transport.accept(taskID: task.id, accept: true)
        }
    }
}
