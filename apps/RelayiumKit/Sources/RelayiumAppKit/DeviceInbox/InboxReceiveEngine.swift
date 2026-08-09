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
    public let folder: InboxReceiveFolder
    public let account: InboxAccountID
    public let now: @Sendable () -> Date
    public let log: InboxLog?
    /// Passed through to the receiver; see `InboxReceiver.renewInterval`.
    public var renewInterval: TimeInterval
    public var streamAttempts: Int
    /// Free space on the receive volume; see `InboxReceiver.freeBytes`. Passed to
    /// the receiver AND used by the disk-full requeue, so the two cannot disagree
    /// about whether a parked delivery now fits.
    public var freeBytes: @Sendable (URL) -> Int64?

    public init(transport: InboxTransport, keys: InboxDeviceKeyStoring,
                journals: InboxJournalStore, folder: InboxReceiveFolder,
                account: InboxAccountID,
                now: @escaping @Sendable () -> Date = { Date() },
                log: InboxLog? = nil,
                renewInterval: TimeInterval = Double(InboxProtocol.defaultLeaseSeconds) / 3,
                streamAttempts: Int = 5,
                freeBytes: @escaping @Sendable (URL) -> Int64? = InboxSpace.freeBytes) {
        self.transport = transport
        self.keys = keys
        self.journals = journals
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

    /// The automatic-receive policy this device announces.
    ///
    /// `off` unless the user has explicitly enabled automatic receive for THIS
    /// account. A device that announces `off` makes central refuse task creation
    /// outright (`auto_receive_disabled`), which is the truthful answer: queuing a
    /// task this Mac will never take would be a lie in the sender's UI.
    ///
    /// Note what it does NOT depend on: whether the folder is usable right now. An
    /// enabled device with a broken folder still announces `auto` and reports
    /// `receiveDirReady: false`, so central starts the task in
    /// `attention_required` — "your Mac is set up for this and something is wrong
    /// with the folder", not "your Mac does not do this".
    public var announcedPolicy: InboxAutoAccept {
        folder.isAutomaticReceiveEnabled(account: account) ? .auto : .off
    }

    /// Enrol and make this account's device key usable. Run once before passes.
    @discardableResult
    public func prepare(platform: String, appVersion: String) async throws -> InboxKey {
        let opened = folder.open(account: account)
        defer { opened.access?.release() }
        let result = try await InboxEnrolment.enrol(transport, platform: platform,
                                                   appVersion: appVersion,
                                                   autoAccept: announcedPolicy,
                                                   receiveDirReady: opened.state.canReceive)
        return try await InboxEnrolment.ensureUsableKey(transport: transport, keys: keys,
                                                        account: account,
                                                        current: result.inbox.key, now: now())
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

        guard case .usable(let root) = opened.state else {
            // Refuse to CLAIM into a folder that just failed its probe. Claiming
            // would take a lease this Mac cannot honour and would leave the sender
            // watching a task that is not progressing.
            return .notReceiving(opened.state)
        }

        let pending = try await transport.pending(limit: InboxProtocol.claimBatch)
        if pending.isEmpty {
            journals.prune(now: now())
            return .idle
        }
        // A write probe says the folder is writable; it does not say it now has
        // room for a task that was parked as `disk_full`. Re-check that task's own
        // declared size, and re-queue it only once the same preflight the receiver
        // uses would pass. That makes "free some space" self-healing without
        // turning a still-full disk into a claim/report busy loop.
        await requeueRecovered(pending, root: root)

        let claimed = try await transport.claim(max: InboxProtocol.claimBatch)
        guard let delivery = claimed.deliveries.first else {
            // Pending said there was work but the claim leased none: another worker
            // took it, or it expired between the two calls. Not an error.
            return .idle
        }
        log?(.claimed(taskID: delivery.task.id,
                      ciphertextBytes: delivery.task.ciphertextBytes))

        var receiver = InboxReceiver(transport: transport, keys: keys, journals: journals,
                                     account: account, root: root, now: now, log: log,
                                     renewInterval: renewInterval, streamAttempts: streamAttempts,
                                     freeBytes: freeBytes)
        if claimed.leaseSeconds > 0 {
            // Follow what CENTRAL says a lease lasts rather than the compiled-in
            // constant, so a server that shortens it is followed instead of
            // contradicted.
            receiver.renewInterval = Double(claimed.leaseSeconds) / 3
        }

        do {
            _ = try await receiver.deliver(delivery)
            await reportSaved(delivery, receiver: receiver)
        } catch let abandon as InboxAbandon {
            // Central already took the task away. Silence is the only safe answer.
            log?(.abandoned(taskID: delivery.task.id, cause: abandon.cause))
        } catch {
            let failure = (error as? InboxFailure) ?? InboxClassify.filesystem(error)
            await report(delivery, state: failure.state, code: failure.code)
        }
        return .worked
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
