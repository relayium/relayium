import Foundation

/// How many batches may wait behind the active one.
///
/// A peer that never answers must not let a local queue grow without bound, and
/// the queue is the one structure here whose size a REMOTE peer can influence
/// without consenting to anything: every unanswered batch stays queued.
public let LINK_FILE_MAX_QUEUED_BATCHES = 32

/// One consent window, never renewed. `mixed-file-session.svelte.ts`'s
/// `MIXED_FILE_CONSENT_TIMEOUT_MS`, in seconds — BOTH sides use it, which is what
/// makes an expired prompt and an expired wait the same deadline.
public let LINK_FILE_CONSENT_TIMEOUT: TimeInterval = 600

/// How long a finished sender waits for the receiver's COMPLETE.
/// `mixed-file-session.svelte.ts`'s `COMPLETE_TIMEOUT_MS`, in seconds.
public let LINK_FILE_COMPLETE_TIMEOUT: TimeInterval = 60

/// How long a refused batch may keep draining in-flight content.
/// `MIXED_FILE_DRAIN_TIMEOUT_MS`, in seconds.
public let LINK_FILE_DRAIN_TIMEOUT: TimeInterval = 30

/// How long a consented receive may go without progress.
/// `MIXED_FILE_RECEIVE_STALL_MS`, in seconds.
public let LINK_FILE_RECEIVE_STALL: TimeInterval = 60

/// Which half of the lane a batch belongs to.
///
/// Consent runs in BOTH directions at once — this side can be waiting for the
/// peer's answer to its own batch while the peer waits for this user's answer to
/// theirs — so a consent effect that named only a batch could still be routed to
/// the wrong prompt by a driver holding one timer per lane.
public enum LinkFileDirection: Equatable, Sendable {
    case outbound
    case inbound
}

/// What the driver must do, in order, because of one event.
///
/// Every external action this owner needs is exactly one of these, and nothing
/// here performs any of them. That is what keeps the core deterministic: a test
/// drives the same seams a DataChannel driver would, in the same order, with no
/// timers, no I/O and no queues in between.
///
/// ## Every asynchronous result is correlated
///
/// Each effect that a driver answers LATER names the exact work it belongs to,
/// and the matching callback must carry those identifiers back. A batch id alone
/// is not enough for a producer, because a replacement transport starts a second
/// producer for the SAME batch — so producers carry an attempt id too, and the
/// pair is what a frame is admitted against. Nothing here is correlated by
/// content: two batches over one manifest produce byte-identical checkpoints.
public enum LinkFileSessionEffect: Equatable, Sendable {
    /// Put these exact bytes on the file channel, in this order.
    case sendFrame([UInt8])
    /// Build a streaming producer for this batch and attempt — from `resume` when
    /// one is given — and pump it, handing every frame back through
    /// `produced(batch:attempt:frame:)`.
    case startProducer(batch: Int, attempt: Int, resume: ResumePoint?)
    /// Stop pumping, release this attempt's producer, and report
    /// `producerStopped(batch:attempt:)` once it can seal nothing more.
    ///
    /// **This is a barrier, not an instant.** A producer may already have sealed
    /// a frame across the stop; that frame's nonce is spent, so it must still be
    /// handed back through `produced` and put on the wire. Only when the driver
    /// reports quiescence does the batch retire.
    case stopProducer(batch: Int, attempt: Int)
    /// The send window is closed. Stop pulling frames until `resumeProducer`.
    case pauseProducer(batch: Int, attempt: Int)
    case resumeProducer(batch: Int, attempt: Int)
    /// Write these authenticated plaintext bytes, then report
    /// `didPersist(batch:checkpoint:)`.
    ///
    /// The bytes and the checkpoint travel together because they are only
    /// meaningful together: the checkpoint claims exactly these bytes reached the
    /// disk, and it is what the peer's resume request will name.
    case persistChunk(batch: Int, bytes: [UInt8], checkpoint: LinkFileCheckpoint)
    /// Open the next file of this batch, then report `didPersist`.
    case openFile(batch: Int, index: Int, checkpoint: LinkFileCheckpoint)
    /// Open a destination for these files and their FIRST file, then report
    /// `didCreateDestination` — or `destinationFailed`.
    case createDestination(batch: Int, files: [FileMeta])
    /// Every file verified. Finalise, then report `didFinalizeDestination`; the
    /// peer's COMPLETE goes out only after that.
    case finalizeDestination(batch: Int)
    case abortDestination(batch: Int)
    case armConsentTimeout(batch: Int, direction: LinkFileDirection)
    case cancelConsentTimeout(batch: Int, direction: LinkFileDirection)
    case armCompleteTimeout(batch: Int)
    case cancelCompleteTimeout(batch: Int)
    /// Arm or RE-ARM the progress watchdog for a consented receive. Re-emitted on
    /// every admitted chunk, exactly like the web's `refreshReceiveWatchdog`.
    case armReceiveStall(batch: Int)
    case cancelReceiveStall(batch: Int)
    /// Arm the bound on how long a refused batch may keep draining.
    case armDrainTimeout(batch: Int)
    case cancelDrainTimeout(batch: Int)
    /// These batch ids will never reach the peer, because the lane is terminal.
    /// Emitted once, so a driver or UI can retire exactly the work it showed the
    /// user rather than discovering the loss by inference.
    case batchesFailed([Int])
    /// This lane's codecs can no longer be proven safe to reuse.
    case poisonCodecs
    case closeLane
}

public enum LinkFileSessionError: Error, Equatable, Sendable {
    case queueFull
    case invalidManifest
    case laneFailed
    /// The identifier space is exhausted. Refused rather than wrapped or reused:
    /// a repeated batch id would make every staleness check above meaningless.
    case identifiersExhausted
}

public enum LinkFileOutboundPhase: Equatable, Sendable {
    case waitingAccept
    case sending
    /// Stopped, but not yet quiescent: the producer may have sealed a frame
    /// across the stop, and that frame's nonce is already spent.
    case stopping
    /// Every frame produced; waiting for the peer's COMPLETE.
    case finishing
    /// In a gap, or attached and waiting for the peer's resume request.
    case resuming
}

public enum LinkFileInboundPhase: Equatable, Sendable {
    case prompt
    /// Consented; the destination is being opened.
    case picking
    case receiving
    case resuming
    /// Refused or failed integrity, but the peer's in-flight frames still have to
    /// be authenticated to keep the sequence. Bounded, and written nowhere.
    case draining
    /// Every file verified. Deliberately NOT retired: until the peer's next
    /// manifest or its ordered barrier arrives, a replacement generation must
    /// still be able to replay the final encrypted DONE.
    case complete
}

public struct LinkFileSessionGapOutcome: Equatable, Sendable {
    public let needsRecovery: Bool
    public let effects: [LinkFileSessionEffect]

    public init(needsRecovery: Bool, effects: [LinkFileSessionEffect] = []) {
        self.needsRecovery = needsRecovery
        self.effects = effects
    }
}

/// The reusable file-session owner above `LinkFileLane`.
///
/// ## What it adds to the lane
///
/// `LinkFileLane` owns the protocol invariants of ONE lane: which frame is which,
/// which generation owes a realignment, where the durable point is. It has no
/// notion of a batch a user picked, a queue, a consent prompt, or a destination.
/// This type is that notion: one outbound batch plus a bounded queue behind it,
/// one inbound batch, and the ORDERINGS that connect them to the lane below.
///
/// ## What it deliberately does not own
///
/// No DataChannel, no picker, no filesystem, no timers and no UI. Every external
/// action is a `LinkFileSessionEffect` the driver performs, and every
/// asynchronous result comes back carrying the identifiers of the work it belongs
/// to. It also never constructs a codec: the link's one `LinkCodecs` is passed in,
/// and its `fileSender`/`fileReceiver` are the only ones used for the whole life
/// of the link. A second pair under the same session key would restart the GCM
/// nonce at zero, which is a break of the encryption rather than a bug.
///
/// ## Identity, and why content is never an identity
///
/// Batches and producer attempts are numbered from one monotonic counter that is
/// never reused and never wrapped. Everything asynchronous is matched on those
/// numbers, because nothing else distinguishes the cases that matter: two batches
/// over one manifest produce byte-identical checkpoints, and a replacement
/// transport produces a second producer for one batch. A frame from a superseded
/// attempt has already spent a nonce in the single shared sender, so it can be
/// neither adopted nor dropped — it fails the lane closed.
///
/// ## The text lane
///
/// This type depends on file-lane abstractions ONLY. It holds no reference to
/// `LinkTextLane`, cannot reach one, and nothing here closes, pauses or mutates a
/// conversation. Simultaneous text and file use is therefore structural rather
/// than a rule somebody has to remember: a file batch failing closed cannot touch
/// a live conversation because there is nothing to touch it through.
///
/// ## Concurrency
///
/// Pure and synchronous: no timers, no I/O, no queues, no sleeps. **The owner
/// serializes every call**, and specifically must not admit the next protected
/// frame while a `persistChunk`/`openFile` it was handed is still outstanding —
/// the durable checkpoint is only meaningful next to the order the writes
/// actually completed in. That is the same FIFO the web's `recvChain` is.
///
/// Pinned against `web/src/lib/mixed-file-session.svelte.ts`.
public final class LinkFileSession {

    // MARK: - what it is built from

    /// The link's one codec pair, for the whole life of the link. Never replaced.
    private let codecs: LinkCodecs
    let lane: LinkFileLane
    private let maxQueued: Int

    /// Effects raised by a seam whose signature cannot return them — today only
    /// the recovery-policy hook, whose shape belongs to
    /// `LinkRecoveryCoordinator`. Nothing else uses it.
    public var onEffects: (([LinkFileSessionEffect]) -> Void)?

    public convenience init(codecs: LinkCodecs,
                            window: Int = FLOW_WINDOW,
                            ackInterval: Int = FLOW_ACK_INTERVAL,
                            maxQueued: Int = LINK_FILE_MAX_QUEUED_BATCHES) {
        self.init(codecs: codecs, window: window, ackInterval: ackInterval,
                  maxQueued: maxQueued, firstIdentifier: 1)
    }

    /// - Parameter firstIdentifier: where the batch/attempt counter starts.
    ///   Internal, and it exists so exhaustion is reachable in a test rather than
    ///   only after 2^63 batches.
    init(codecs: LinkCodecs,
         window: Int = FLOW_WINDOW,
         ackInterval: Int = FLOW_ACK_INTERVAL,
         maxQueued: Int = LINK_FILE_MAX_QUEUED_BATCHES,
         firstIdentifier: Int) {
        self.codecs = codecs
        self.lane = LinkFileLane(window: window, ackInterval: ackInterval)
        self.maxQueued = maxQueued
        self.nextIdentifier = firstIdentifier
    }

    // MARK: - state

    private struct OutboundBatch {
        let id: Int
        let files: [FileMeta]
        var phase: LinkFileOutboundPhase
        /// The producer generation. A replacement starts a new one for the same
        /// batch, and only frames carrying the CURRENT value may be admitted.
        var attempt: Int
        var paused: Bool
        /// A stop is outstanding and the producer has not reported quiescence.
        var awaitingQuiescence: Bool
        /// The peer's COMPLETE arrived while the send path was still unwinding.
        ///
        /// The web's `Outbound.gotComplete`, and it exists for the same race: the
        /// receiver verifies the final DONE and answers while this side's producer
        /// loop has not yet reported that it is out of frames. The answer is real
        /// — it can only be produced by a peer that received everything — so it is
        /// remembered rather than dropped, and retires the batch the moment the
        /// producer ends.
        var gotComplete: Bool
    }

    private struct InboundBatch {
        let id: Int
        let files: [FileMeta]
        var phase: LinkFileInboundPhase
        /// Plaintext bytes authenticated for this batch so far, across every file.
        /// What is left of the manifest is what a drain is allowed to cost.
        var admitted: Int
        /// Remaining budget once a drain starts.
        var drainRemaining: Int
        let total: Int
        /// A `finalizeDestination` is outstanding. A replayed final DONE crossing
        /// it must not ask for a second one.
        var finalizePending: Bool
    }

    /// One counter for batches AND attempts, so no id is ever both.
    private var nextIdentifier: Int
    private var queue: [(id: Int, files: [FileMeta])] = []
    private var outbound: OutboundBatch?
    private var inbound: InboundBatch?

    /// In a gap: nothing launches and nothing is produced.
    private var suspended = false
    /// Recorded at the FIRST report of a gap, exactly like the lane's own answer
    /// and the web's `recoveryIntent`. Never re-derived afterwards.
    private var recoveryIntent = false
    /// A replacement attached while a write was still outstanding, so this
    /// generation's `RESUME_REQ` is owed as soon as the FIFO settles.
    private var resumeRequestPending = false

    // MARK: - what a driver may read

    public var queuedBatchIds: [Int] { queue.map(\.id) }
    public var outboundBatch: Int? { outbound?.id }
    public var outboundAttempt: Int? { outbound?.attempt }
    public var outboundPhase: LinkFileOutboundPhase? { outbound?.phase }
    public var inboundBatch: Int? { inbound?.id }
    public var inboundPhase: LinkFileInboundPhase? { inbound?.phase }
    public var laneFailed: Bool { lane.codecsPoisoned }
    public var generation: Int { lane.generation }
    /// The batches a terminal lane will never carry, in the order they were
    /// queued. A queryable snapshot of the same truth `batchesFailed` announces.
    public private(set) var failedBatchIds: [Int] = []
    /// Work in flight right now. Deliberately distinct from the gap outcome's
    /// answer, which is the historical question a gap makes unanswerable.
    public var isActive: Bool { outbound != nil || inbound != nil || !queue.isEmpty }

    // MARK: - identifiers

    /// The next never-used identifier, or nil when the space is exhausted.
    ///
    /// Checked rather than incremented blindly: `Int` addition TRAPS on overflow,
    /// and wrapping would be worse than trapping — a reused id makes every
    /// staleness check in this type silently wrong.
    private func allocateIdentifier() -> Int? {
        guard nextIdentifier != Int.max else { return nil }
        defer { nextIdentifier += 1 }
        return nextIdentifier
    }

    // MARK: - the outbound queue

    /// Queue one batch. Returns the id every later effect and callback names it by.
    @discardableResult
    public func enqueue(files: [FileMeta]) throws -> Int {
        guard !lane.codecsPoisoned else { throw LinkFileSessionError.laneFailed }
        guard !files.isEmpty, files.count <= MAX_FILES else {
            throw LinkFileSessionError.invalidManifest
        }
        // The SAME predicate the lane will apply when this batch reserves it, so a
        // manifest that would be refused there is refused here — where the user
        // can still be told — rather than half-way through a launch that has
        // already spent the era's realignment.
        var total = 0
        for file in files {
            guard file.size >= 0, file.size <= 9_007_199_254_740_991 else {
                throw LinkFileSessionError.invalidManifest
            }
            let (sum, overflow) = total.addingReportingOverflow(file.size)
            guard !overflow, sum <= 9_007_199_254_740_991 else {
                throw LinkFileSessionError.invalidManifest
            }
            total = sum
        }
        guard (try? validateRealtimeManifestSize(files)) != nil else {
            throw LinkFileSessionError.invalidManifest
        }
        guard queue.count < maxQueued else { throw LinkFileSessionError.queueFull }
        guard let id = allocateIdentifier() else {
            throw LinkFileSessionError.identifiersExhausted
        }
        queue.append((id: id, files: files))
        return id
    }

    /// Drop a batch that has not launched. The active one is `cancelOutbound`'s.
    public func cancelQueued(_ id: Int) -> [LinkFileSessionEffect] {
        queue.removeAll { $0.id == id }
        return []
    }

    /// Launch the head of the queue, if the lane can take it.
    ///
    /// The driver calls this after handling effects; nothing here launches a batch
    /// on its own, so the order in which batches take the lane is always the
    /// driver's own, observable decision.
    ///
    /// **The reservation comes first.** `beginOutboundBatch` is what makes the
    /// manifest legal, so it runs before a single manifest frame is sealed: a
    /// nonce-bearing frame for a batch the lane never admitted is one the lane
    /// would refuse to count, leaving the peer's view of the sequence and this
    /// side's disagreeing with nothing able to repair it.
    public func pump() -> [LinkFileSessionEffect] {
        guard !lane.codecsPoisoned, !suspended, outbound == nil, let head = queue.first else {
            return []
        }
        var effects: [LinkFileSessionEffect] = []
        let sizes = head.files.map(\.size)
        do {
            try lane.beginOutboundBatch(sizes: sizes)
        } catch LinkFileLaneError.realignmentPending {
            // An idle direction in a replaced generation pays its debt at the
            // batch-free origin, LAZILY — exactly here, immediately before the
            // first protected frame of the first new batch, which is what
            // `runOutbound`'s `if (resyncOut)` gate does on the web.
            guard let marker = try? lane.outboundOriginRealignment(sender: codecs.fileSender) else {
                return []
            }
            // Appended BEFORE the batch is reserved: the era's debt is spent the
            // moment this frame exists, so it has to reach the wire even if the
            // batch behind it turns out to be unusable.
            effects.append(.sendFrame(marker))
            guard (try? lane.beginOutboundBatch(sizes: sizes)) != nil else {
                queue.removeFirst()
                return effects
            }
        } catch {
            // Unreachable: `enqueue` applies the same predicate. Dropping the head
            // rather than retrying it is what keeps one impossible manifest from
            // wedging every batch behind it.
            queue.removeFirst()
            return []
        }
        guard let attempt = allocateIdentifier() else {
            // The batch has an id and its producer cannot get one. A session that
            // cannot name a producer cannot correlate anything it hands out, so
            // every later callback would be unmatchable — it ends deterministically
            // here, naming the work that dies with it, rather than refusing to
            // pump for ever while the queue looks alive.
            lane.retireOutboundBatch()
            return effects + failLane()
        }
        queue.removeFirst()
        do {
            for frame in try codecs.fileSender.batchFrames(head.files) {
                try lane.didProduceFrame(frame)
                effects.append(.sendFrame(frame))
            }
        } catch {
            // The manifest was validated at `enqueue`, so reaching here means a
            // partially sealed manifest has already spent nonces the peer counts
            // and this side cannot say which. Nothing later can repair that.
            lane.retireOutboundBatch()
            return effects + failLane()
        }
        outbound = OutboundBatch(id: head.id, files: head.files, phase: .waitingAccept,
                                 attempt: attempt, paused: false, awaitingQuiescence: false,
                                 gotComplete: false)
        effects.append(.armConsentTimeout(batch: head.id, direction: .outbound))
        return effects
    }

    /// One frame came out of this batch's producer.
    ///
    /// The (batch, attempt) pair is the whole staleness check, and a mismatch is
    /// TERMINAL rather than ignored. The frame is already sealed: its nonce is
    /// spent in the one shared sender whatever this owner decides, so admitting it
    /// as the current attempt's would misplace the cursor, and dropping it would
    /// leave the peer's sequence with a hole no later frame can close.
    public func produced(batch: Int, attempt: Int, frame: [UInt8]) -> [LinkFileSessionEffect] {
        guard !lane.codecsPoisoned else { return [] }
        guard var current = outbound, current.id == batch, current.attempt == attempt else {
            return failLane()
        }
        switch current.phase {
        case .sending, .stopping:
            break   // admitted below
        case .resuming where lane.outboundOwesResumeMarker:
            // The ordinary cancellation race, and the ONE case where a
            // nonce-bearing frame may simply be dropped. The transport died, this
            // attempt handed back a frame it had already sealed, and the marker
            // this generation still owes has not been built yet — so it will read
            // the shared sender's newer `nextSequence` and carry the peer forward
            // across every nonce burned here. Nothing is sent, and the produced
            // frontier deliberately does not move: this side never delivered it,
            // so no later resume request may name it. Once the marker IS built the
            // announced sequence is fixed and a late frame is terminal again —
            // which is also when a new attempt id makes it unrecognisable anyway.
            return []
        case .waitingAccept, .finishing, .resuming:
            return failLane()
        }
        do {
            try lane.didProduceFrame(frame)
        } catch LinkFileLaneError.transportGap {
            // Not a failure: the next generation's announcement repairs whatever
            // nonce this frame consumed.
            return []
        } catch {
            return failLane()
        }
        var effects: [LinkFileSessionEffect] = [.sendFrame(frame)]
        // A frame that crossed a stop still goes out; the batch retires behind it.
        if current.phase == .sending, !lane.maySendProtected, !current.paused {
            current.paused = true
            outbound = current
            effects.append(.pauseProducer(batch: batch, attempt: attempt))
        }
        return effects
    }

    /// The producer has no more frames for this attempt.
    ///
    /// During a stop this IS quiescence: a producer that ran out has nothing left
    /// to seal, which is the same fact `producerStopped` reports.
    public func producerFinished(batch: Int, attempt: Int) -> [LinkFileSessionEffect] {
        guard var current = outbound, current.id == batch, current.attempt == attempt else {
            // Carries no nonce, so a stale one is inert rather than terminal.
            return []
        }
        if current.phase == .stopping { return quiesce() }
        guard current.phase == .sending else { return [] }
        if current.gotComplete {
            // The answer arrived while this loop was still unwinding. Now that the
            // producer can seal nothing more, it is safe to act on — and no
            // completion wait is ever armed for a batch that is already answered.
            retireOutbound()
            return []
        }
        current.phase = .finishing
        outbound = current
        return [.armCompleteTimeout(batch: batch)]
    }

    /// This attempt's producer could not produce.
    ///
    /// Real producers read real sources: they change under a transfer, they become
    /// unreadable, they go away. The callback CERTIFIES quiescence — a producer
    /// that failed is not going to seal anything else — and it consumes no nonce,
    /// so the ordered barrier may follow it immediately instead of waiting for a
    /// separate stop. It is a source failure, never a codec one: the lane survives
    /// and carries the next batch.
    ///
    /// A report for an attempt that is already gone is inert for the same reason:
    /// nothing about it reached the wire.
    public func producerFailed(batch: Int, attempt: Int) -> [LinkFileSessionEffect] {
        guard let current = outbound, current.id == batch, current.attempt == attempt,
              current.phase == .sending || current.phase == .stopping else { return [] }
        return quiesce()
    }

    /// The producer for this attempt can seal nothing more.
    public func producerStopped(batch: Int, attempt: Int) -> [LinkFileSessionEffect] {
        guard let current = outbound, current.id == batch, current.attempt == attempt,
              current.awaitingQuiescence else { return [] }
        return quiesce()
    }

    /// The stop barrier closes: everything the producer sealed is on the wire, so
    /// the ordered retirement may follow it.
    private func quiesce() -> [LinkFileSessionEffect] {
        guard let current = outbound else { return [] }
        var effects: [LinkFileSessionEffect] = [.cancelCompleteTimeout(batch: current.id)]
        effects.append(contentsOf: sendControl(LINK_FILE_BATCH_ABORT))
        retireOutbound()
        return effects
    }

    /// The user stopped an outbound batch.
    public func cancelOutbound() -> [LinkFileSessionEffect] {
        guard let current = outbound else { return [] }
        return stopOutbound(current, cancelConsent: current.phase == .waitingAccept)
    }

    /// Retire an outbound batch with the ordered barrier, waiting for the producer
    /// first when one could still be sealing frames.
    private func stopOutbound(_ current: OutboundBatch,
                              cancelConsent: Bool) -> [LinkFileSessionEffect] {
        var effects: [LinkFileSessionEffect] = []
        if cancelConsent {
            effects.append(.cancelConsentTimeout(batch: current.id, direction: .outbound))
        }
        switch current.phase {
        case .sending:
            // A producer is live and may have sealed a frame across this stop.
            // Nothing may follow that frame on the wire until it has gone out, so
            // the barrier waits for quiescence.
            var next = current
            next.phase = .stopping
            next.awaitingQuiescence = true
            next.paused = false
            outbound = next
            effects.append(.stopProducer(batch: current.id, attempt: current.attempt))
            return effects
        case .stopping:
            return effects   // already waiting for the same barrier
        case .waitingAccept, .finishing, .resuming:
            // No producer is pulling frames: waiting-accept never started one, a
            // finished one is done, and a resuming one was released at the gap.
            effects.append(.cancelCompleteTimeout(batch: current.id))
            effects.append(contentsOf: sendControl(LINK_FILE_BATCH_ABORT))
            retireOutbound()
            return effects
        }
    }

    /// This side's wait for the peer's answer expired.
    public func outboundConsentTimedOut(batch: Int) -> [LinkFileSessionEffect] {
        guard let current = outbound, current.id == batch,
              current.phase == .waitingAccept else { return [] }
        return stopOutbound(current, cancelConsent: true)
    }

    /// The inbound prompt's own consent window expired.
    ///
    /// Deliberately answers NOTHING. The sender reached the same deadline and is
    /// putting its ordered BATCH_ABORT on the wire; a late ACCEPT or REJECT here
    /// carries no batch id, so it could be read as the answer to whatever batch
    /// the sender starts next.
    public func inboundConsentTimedOut(batch: Int) -> [LinkFileSessionEffect] {
        guard let current = inbound, current.id == batch,
              current.phase == .prompt || current.phase == .picking else { return [] }
        var effects: [LinkFileSessionEffect] = [
            .cancelConsentTimeout(batch: current.id, direction: .inbound)
        ]
        if current.phase == .picking { effects.append(.abortDestination(batch: current.id)) }
        codecs.fileReceiver.abortBatch()
        retireInbound()
        return effects
    }

    public func completeTimedOut(batch: Int) -> [LinkFileSessionEffect] {
        guard let current = outbound, current.id == batch, current.phase == .finishing else {
            return []
        }
        retireOutbound()
        return [.cancelCompleteTimeout(batch: batch)]
    }

    // MARK: - inbound routing

    /// Route one frame off the file channel.
    ///
    /// The lane decides what the frame IS; this decides what to do about it.
    /// Plaintext control, ACKs and the resume handshake consume no AEAD sequence
    /// and are answered here directly; only protected input reaches the link's
    /// receiver, and only in wire order.
    public func admitFrame(_ frame: [UInt8]) -> [LinkFileSessionEffect] {
        let alreadyFailed = lane.codecsPoisoned
        switch lane.admitInboundFrame(frame) {
        case let .control(control):
            return inboundControl(control)
        case let .ack(total):
            return ackArrived(total)
        case let .resumeRequest(point):
            return resumeRequested(point)
        case let .resumeMarker(point, seq):
            return markerArrived(point, seq: seq)
        case .feedProtected:
            return feedProtected(frame)
        case .failClosed:
            return alreadyFailed ? [] : failLane(alreadyPoisoned: true)
        }
    }

    private func inboundControl(_ control: LinkFileControl) -> [LinkFileSessionEffect] {
        switch control {
        case .accept:
            guard var current = outbound, current.phase == .waitingAccept else { return [] }
            current.phase = .sending
            outbound = current
            return [.cancelConsentTimeout(batch: current.id, direction: .outbound),
                    .startProducer(batch: current.id, attempt: current.attempt, resume: nil)]
        case .reject:
            guard let current = outbound else { return [] }
            if current.phase == .waitingAccept {
                // Refused before consent. The sender has emitted only the
                // manifest, so there is nothing in flight and no barrier is owed.
                retireOutbound()
                return [.cancelConsentTimeout(batch: current.id, direction: .outbound)]
            }
            // A remote STOP mid-transfer. The sender owns the ordered retirement
            // barrier for it, or the peer is left draining something that never
            // ends.
            return stopOutbound(current, cancelConsent: false)
        case .busy:
            // Not a refusal: the peer's lane is occupied. The batch goes back to
            // the FRONT, because it is older than everything behind it.
            guard let current = outbound, current.phase == .waitingAccept else { return [] }
            queue.insert((id: current.id, files: current.files), at: 0)
            retireOutbound()
            return [.cancelConsentTimeout(batch: current.id, direction: .outbound)]
        case .complete:
            guard var current = outbound else { return [] }
            switch current.phase {
            case .finishing:
                retireOutbound()
                return [.cancelCompleteTimeout(batch: current.id)]
            case .sending:
                // It crossed the producer's last frames — but only if there WERE
                // no frames left. The lane's produced frontier is the record of
                // what actually entered the authenticated channel, and a completed
                // batch leaves it on the exact end of the last file. Anything
                // short of that is a premature or forged answer, and recording it
                // would report a truncated transfer as delivered.
                guard producedWholeBatch(current) else { return [] }
                // Recorded, not acted on: retiring now would release the lane
                // while a frame this side has not seen yet could still be sealed.
                current.gotComplete = true
                outbound = current
                return []
            case .waitingAccept, .stopping, .resuming:
                // Nothing the peer can have completed. A batch it never accepted,
                // one being retired by a barrier, and one waiting to resume are
                // all states where honouring this would retire real work.
                return []
            }
        case .batchAbort:
            return abortBarrier()
        }
    }

    /// The sender's ordered retirement barrier. It retires the inbound batch
    /// whatever phase it is in — including a completed one, whose replay window
    /// this closes — and nothing else.
    private func abortBarrier() -> [LinkFileSessionEffect] {
        guard let current = inbound else { return [] }
        var effects: [LinkFileSessionEffect] = [
            .cancelConsentTimeout(batch: current.id, direction: .inbound),
            .cancelReceiveStall(batch: current.id),
            .cancelDrainTimeout(batch: current.id),
        ]
        // A destination that is finalised is the user's file. Aborting it because
        // the replay window closed would undo work that already succeeded.
        if current.phase != .prompt, !lane.destinationFinalized, !current.finalizePending {
            effects.append(.abortDestination(batch: current.id))
        }
        codecs.fileReceiver.abortBatch()
        retireInbound()
        return effects
    }

    private func ackArrived(_ total: Int?) -> [LinkFileSessionEffect] {
        // Validation and clamping happened in the lane, and a value no conforming
        // peer could produce was ignored there rather than being fatal: a
        // plaintext ACK is forgeable, and one injected frame must not end a lane.
        guard total != nil, var current = outbound, current.paused,
              current.phase == .sending, lane.maySendProtected else { return [] }
        current.paused = false
        outbound = current
        return [.resumeProducer(batch: current.id, attempt: current.attempt)]
    }

    // MARK: - protected input

    private func feedProtected(_ frame: [UInt8]) -> [LinkFileSessionEffect] {
        // The lane classified this as protected, so it has a header and a kind.
        let kind = frame[0]
        if kind == RealtimeKind.chunk || kind == RealtimeKind.chunkPart
            || kind == RealtimeKind.doneEnc {
            // Content before consent is never decrypted — not even transiently.
            // This lane's sequence is abandoned with its channel instead, which is
            // the price of the promise that nothing is opened before a user agrees.
            guard let current = inbound,
                  current.phase == .receiving || current.phase == .resuming
                      || current.phase == .draining || current.phase == .complete else {
                return failLane()
            }
        }
        let event: RealtimeEvent
        do {
            event = try codecs.fileReceiver.feed(frame)
        } catch {
            return failLane()
        }
        switch event {
        case .pending:
            return []
        case let .batch(files):
            return manifestArrived(files)
        case let .chunk(plain):
            return chunkArrived(plain)
        case let .done(ok):
            return doneArrived(ok: ok)
        case .resume:
            // The demux routes announcements before anything is fed, so this is
            // unreachable; it is not a reason to fail a working lane.
            return []
        }
    }

    private func manifestArrived(_ files: [FileMeta]) -> [LinkFileSessionEffect] {
        var effects: [LinkFileSessionEffect] = []
        // A completed batch is retired by the peer's NEXT manifest: that is the
        // moment its replayed-final-DONE window really closes, because a sender
        // that starts a new batch has had its COMPLETE.
        if let current = inbound, current.phase == .complete {
            effects.append(.cancelReceiveStall(batch: current.id))
            lane.retireInboundBatch()
            inbound = nil
        }
        guard inbound == nil else { return failLane() }
        var total = 0
        for file in files {
            let (sum, overflow) = total.addingReportingOverflow(file.size)
            guard !overflow else { return failLane() }
            total = sum
        }
        guard let id = allocateIdentifier() else { return failLane() }
        do {
            try lane.beginInboundBatch(sizes: files.map(\.size))
        } catch {
            return failLane()
        }
        inbound = InboundBatch(id: id, files: files, phase: .prompt, admitted: 0,
                               drainRemaining: 0, total: total, finalizePending: false)
        return effects + [.armConsentTimeout(batch: id, direction: .inbound)]
    }

    private func chunkArrived(_ plain: [UInt8]) -> [LinkFileSessionEffect] {
        guard var current = inbound else { return failLane() }
        if current.phase == .draining {
            // Bounded by what is LEFT of the manifest, not by the whole of it:
            // bytes already admitted were already paid for.
            let (rest, overflow) = current.drainRemaining.subtractingReportingOverflow(plain.count)
            guard !overflow, rest >= 0 else { return failLane() }
            current.drainRemaining = rest
            inbound = current
            return []
        }
        guard current.phase == .receiving || current.phase == .resuming else { return failLane() }
        let (admitted, overflow) = current.admitted.addingReportingOverflow(plain.count)
        guard !overflow else { return failLane() }
        current.phase = .receiving
        current.admitted = admitted
        inbound = current
        do {
            let checkpoint = try lane.didAdmitChunk(byteCount: plain.count,
                                                    chain: codecs.fileReceiver.snapshotChain())
            return [.armReceiveStall(batch: current.id),
                    .persistChunk(batch: current.id, bytes: plain, checkpoint: checkpoint)]
        } catch {
            return failLane()
        }
    }

    private func doneArrived(ok: Bool) -> [LinkFileSessionEffect] {
        guard var current = inbound else { return failLane() }
        if current.phase == .draining { return [] }
        // `.complete` is reachable exactly once: a batch whose COMPLETE was lost
        // with the transport, whose sender replays the final encrypted DONE on the
        // replacement. Everything else in that state is refused by the receiver
        // itself before it ever reaches here.
        guard current.phase == .receiving || current.phase == .resuming
                || current.phase == .complete else { return failLane() }
        guard ok else {
            // The bytes are not the bytes the sender hashed. The sequence is
            // intact, so this ends the BATCH, not the lane.
            return beginDrain(current, abortDestination: true)
        }
        do {
            switch try lane.didAdmitDone() {
            case let .nextFile(checkpoint):
                current.phase = .receiving
                inbound = current
                return [.armReceiveStall(batch: current.id),
                        .openFile(batch: current.id, index: checkpoint.index,
                                  checkpoint: checkpoint)]
            case .batchComplete:
                current.phase = .complete
                var effects: [LinkFileSessionEffect] = [.cancelReceiveStall(batch: current.id)]
                if lane.destinationFinalized {
                    // The replay: the destination is already the user's file, and
                    // the sender is only missing the answer.
                    inbound = current
                    return effects + sendControl(RealtimeControl.complete.rawValue)
                }
                if current.finalizePending {
                    // A first finalisation is still outstanding and will answer.
                    inbound = current
                    return effects
                }
                current.finalizePending = true
                inbound = current
                effects.append(.finalizeDestination(batch: current.id))
                return effects
            }
        } catch {
            return failLane()
        }
    }

    /// Refuse a consented batch and drain whatever is already in flight.
    private func beginDrain(_ current: InboundBatch,
                            abortDestination: Bool) -> [LinkFileSessionEffect] {
        var next = current
        next.phase = .draining
        next.drainRemaining = max(0, current.total - current.admitted)
        inbound = next
        var effects: [LinkFileSessionEffect] = [
            .cancelConsentTimeout(batch: current.id, direction: .inbound),
            .cancelReceiveStall(batch: current.id),
        ]
        if abortDestination, !lane.destinationFinalized { effects.append(.abortDestination(batch: current.id)) }
        effects.append(contentsOf: sendControl(RealtimeControl.reject.rawValue))
        effects.append(.armDrainTimeout(batch: current.id))
        return effects
    }

    // MARK: - the inbound consent, destination and watchdog seams

    /// The user consented. Nothing is answered yet: the destination has to exist
    /// first.
    public func acceptInbound() -> [LinkFileSessionEffect] {
        guard var current = inbound, current.phase == .prompt else { return [] }
        current.phase = .picking
        inbound = current
        return [.createDestination(batch: current.id, files: current.files)]
    }

    /// The destination is open.
    ///
    /// **This is where receive opens, and ACCEPT goes out after it.** A sender that
    /// answers the instant it sees ACCEPT is entitled to put its first chunk
    /// straight on the wire, so a session that answered first would be racing its
    /// own destination.
    public func didCreateDestination(batch: Int) -> [LinkFileSessionEffect] {
        guard var current = inbound, current.id == batch, current.phase == .picking else {
            // The batch this destination belongs to is gone. It is nobody's, so
            // the driver is told to let it go rather than have it adopted by
            // whatever batch happens to be live now.
            return [.abortDestination(batch: batch)]
        }
        current.phase = .receiving
        inbound = current
        return [.cancelConsentTimeout(batch: batch, direction: .inbound),
                .armReceiveStall(batch: batch)]
            + sendControl(RealtimeControl.accept.rawValue)
    }

    /// A destination operation failed: opening it, writing a chunk, opening the
    /// next file, or finalising it. A save failure, never a protocol one — the
    /// receive sequence is intact, so only the BATCH ends.
    ///
    /// Which shape it takes is decided by whether ACCEPT has gone out, exactly as
    /// a refusal is. Before consent nothing is in flight and REJECT is itself the
    /// complete barrier; after consent the peer is still streaming, so the batch
    /// refuses, releases its destination, and drains under the bound until the
    /// sender's ordered BATCH_ABORT retires it.
    public func destinationFailed(batch: Int) -> [LinkFileSessionEffect] {
        guard let current = inbound, current.id == batch else {
            // The batch this destination belonged to is gone; the driver is told
            // to let it go rather than have the failure land on a later batch.
            return [.abortDestination(batch: batch)]
        }
        switch current.phase {
        case .picking:
            return refuseBeforeConsent()
        case .receiving, .resuming, .complete:
            // Including a finalisation that failed: a batch that verified but
            // could not be committed is not a delivered file, and the sender must
            // not be told it arrived.
            var next = current
            next.finalizePending = false
            inbound = next
            return beginDrain(next, abortDestination: true)
        case .prompt, .draining:
            // Nothing was ever opened, or the batch is already ending.
            return []
        }
    }

    /// Refuse an inbound batch.
    ///
    /// Which of the two shapes this takes depends entirely on whether ACCEPT has
    /// gone out, because that is what decides whether anything is in flight.
    public func rejectInbound() -> [LinkFileSessionEffect] {
        guard let current = inbound else { return [] }
        switch current.phase {
        case .prompt, .picking:
            return refuseBeforeConsent()
        case .receiving, .resuming:
            return beginDrain(current, abortDestination: true)
        case .draining, .complete:
            return []
        }
    }

    /// A consented receive has made no progress inside the stall window.
    public func receiveStalled(batch: Int) -> [LinkFileSessionEffect] {
        guard let current = inbound, current.id == batch,
              current.phase == .receiving || current.phase == .resuming else { return [] }
        return beginDrain(current, abortDestination: true)
    }

    /// A refused batch is still being streamed at after the drain window.
    ///
    /// The peer is not draining any more, and this side cannot tell how much of
    /// its sequence is still to come — so only the FILE lane ends.
    public func drainTimedOut(batch: Int) -> [LinkFileSessionEffect] {
        guard let current = inbound, current.id == batch, current.phase == .draining else {
            return []
        }
        return failLane()
    }

    /// A refusal the sender has not started sending content for.
    ///
    /// Before ACCEPT the sender has emitted only the manifest, so REJECT is ITSELF
    /// the complete ordered barrier: there is nothing in flight to drain and the
    /// lane is reusable immediately. The receiver's batch is retired with it —
    /// `RealtimeReceiver` refuses a second manifest while one is live, so a batch
    /// left standing here would fail the peer's very next batch.
    private func refuseBeforeConsent() -> [LinkFileSessionEffect] {
        guard let current = inbound else { return [] }
        var effects: [LinkFileSessionEffect] = [
            .cancelConsentTimeout(batch: current.id, direction: .inbound)
        ]
        if current.phase == .picking { effects.append(.abortDestination(batch: current.id)) }
        effects.append(contentsOf: sendControl(RealtimeControl.reject.rawValue))
        codecs.fileReceiver.abortBatch()
        retireInbound()
        return effects
    }

    /// One checkpoint reached the disk.
    ///
    /// The batch id is required, because a checkpoint alone cannot say which batch
    /// a write belongs to: two batches over one manifest produce byte-identical
    /// checkpoints, so a late write from a retired batch would otherwise commit
    /// the live one's pending point.
    ///
    /// Deliberately usable on a terminal lane: this reports GROUND TRUTH about what
    /// was written. It just commits nothing when the admission it names is not
    /// outstanding any more.
    public func didPersist(batch: Int, checkpoint: LinkFileCheckpoint) -> [LinkFileSessionEffect] {
        guard inbound?.id == batch else { return [] }
        guard case let .committed(ack) = lane.didPersist(checkpoint) else { return [] }
        var effects: [LinkFileSessionEffect] = []
        if let ack { effects.append(.sendFrame(ackFrame(Double(ack)))) }
        // A replacement attached while this write was outstanding, so the request
        // that names the durable prefix was owed until exactly now.
        if resumeRequestPending, let request = try? lane.resumeRequestFrame() {
            resumeRequestPending = false
            effects.append(.sendFrame(request))
        }
        return effects
    }

    /// The destination is finalised. Only now is the peer told the batch arrived.
    public func didFinalizeDestination(batch: Int) -> [LinkFileSessionEffect] {
        guard var current = inbound, current.id == batch, current.phase == .complete else {
            return []
        }
        current.finalizePending = false
        inbound = current
        // One-shot in the lane. A replay reaches this path only through the
        // already-finalised branch above, which answers without asking again.
        _ = lane.didFinalizeDestination()
        return sendControl(RealtimeControl.complete.rawValue)
    }

    // MARK: - the resume handshake

    private func resumeRequested(_ point: ResumePoint) -> [LinkFileSessionEffect] {
        guard let current = outbound else { return [] }
        // Only where this generation actually owes an announcement. A request on
        // an aligned lane is forged or stale, and answering one would spend a
        // marker the peer is required to reject.
        guard lane.outboundOwesResumeMarker else { return [] }
        // Range, alignment and the produced frontier, all decided by the lane. A
        // refusal here is not proof of anything: it leaves the debt unspent and
        // the lane usable.
        guard lane.validResumeRequest(point) else { return [] }
        // A resumed batch is a NEW producer over pristine sources. It gets its own
        // attempt id, which is what makes a frame from the one that died
        // recognisable rather than plausible.
        guard let attempt = allocateIdentifier() else { return failLane() }
        guard let marker = try? lane.outboundBatchResume(to: point, sender: codecs.fileSender) else {
            return []
        }
        var next = current
        next.phase = .sending
        next.paused = false
        next.awaitingQuiescence = false
        next.attempt = attempt
        outbound = next
        return [.sendFrame(marker), .startProducer(batch: current.id, attempt: attempt, resume: point)]
    }

    private func markerArrived(_ point: ResumePoint, seq: UInt32) -> [LinkFileSessionEffect] {
        do {
            try lane.acceptResumeStart(point, seq: seq, receiver: codecs.fileReceiver)
        } catch LinkFileLaneError.transportGap {
            // A frame from the transport that died, before the replacement was
            // reported. Refused, and not a failure.
            return []
        } catch {
            return failLane()
        }
        if var current = inbound, current.phase == .resuming {
            current.phase = .receiving
            inbound = current
            return [.armReceiveStall(batch: current.id)]
        }
        return []
    }

    // MARK: - transport generations

    /// Enter a transport gap. Idempotent: one gap, however many callbacks report it.
    @discardableResult
    public func transportGap() -> LinkFileSessionGapOutcome {
        guard !lane.codecsPoisoned else {
            // A terminal lane has nothing a replacement could restore.
            recoveryIntent = false
            return LinkFileSessionGapOutcome(needsRecovery: false)
        }
        guard !suspended else { return LinkFileSessionGapOutcome(needsRecovery: recoveryIntent) }
        suspended = true
        let laneOutcome = lane.transportGap()
        // Sampled at the FIRST report, and deliberately WIDER than the lane's own
        // answer: a queued batch and an unanswered prompt are work a replacement
        // would carry, and the lane cannot see either of them.
        recoveryIntent = recoveryIntent || laneOutcome.needsRecovery || isActive
        resumeRequestPending = false
        var effects: [LinkFileSessionEffect] = []
        if var current = outbound {
            // Released, not paused: a resumed batch gets a NEW producer over
            // pristine sources, from the point the peer asks for. Told only to a
            // batch that could still have one running — a batch waiting for
            // consent never started one, a finished one is done, and one already
            // parked to resume had its released at the gap that parked it.
            if current.phase == .sending || current.phase == .stopping {
                effects.append(.stopProducer(batch: current.id, attempt: current.attempt))
            }
            switch current.phase {
            case .waitingAccept, .stopping:
                // Pre-consent there is no byte-level checkpoint contract, so there
                // is nothing to resume; a batch that was already stopping has no
                // barrier left to deliver on a transport that is gone.
                effects.append(.cancelConsentTimeout(batch: current.id, direction: .outbound))
                effects.append(.cancelCompleteTimeout(batch: current.id))
                retireOutbound()
            case .sending, .finishing, .resuming:
                // The completion wait dies with the transport it was waiting on:
                // this batch will finish again on the replacement, and a timer
                // left armed would retire it mid-resume.
                if current.phase == .finishing {
                    effects.append(.cancelCompleteTimeout(batch: current.id))
                }
                current.phase = .resuming
                current.paused = false
                current.awaitingQuiescence = false
                outbound = current
            }
        }
        if let current = inbound {
            switch current.phase {
            case .prompt, .picking, .draining:
                // A prompt, a picker and a drain all lack a durable byte contract
                // to resume from. The receiver's batch goes with them, or the
                // peer's next manifest would find one still live.
                effects.append(.cancelConsentTimeout(batch: current.id, direction: .inbound))
                effects.append(.cancelDrainTimeout(batch: current.id))
                if current.phase == .picking { effects.append(.abortDestination(batch: current.id)) }
                codecs.fileReceiver.abortBatch()
                retireInbound()
            case .receiving:
                effects.append(.cancelReceiveStall(batch: current.id))
                inbound?.phase = .resuming
            case .resuming, .complete:
                // A consented transfer, and a finished batch that may still owe a
                // replayed final DONE, both survive the gap by design.
                break
            }
        }
        return LinkFileSessionGapOutcome(needsRecovery: recoveryIntent, effects: effects)
    }

    /// A replacement transport is current. Same link, same codecs, new channel.
    ///
    /// Everything this generation owes is settled from here and not before: an
    /// active receive asks for its resume point, an active send waits for the
    /// peer's request, and an idle direction realigns lazily at the origin when
    /// its next batch launches.
    public func didAttachReplacementTransport() -> [LinkFileSessionEffect] {
        guard !lane.codecsPoisoned else { return [] }
        suspended = false
        lane.didAttachReplacementTransport()
        recoveryIntent = false
        do {
            return [.sendFrame(try lane.resumeRequestFrame())]
        } catch LinkFileLaneError.persistAlreadyPending {
            // The request must name the durable prefix, and a write the owner has
            // not reported back on has not reached the disk yet.
            resumeRequestPending = true
            return []
        } catch {
            // No inbound batch to resume, or nothing owed. Both are ordinary.
            return []
        }
    }

    /// The exact `LinkRecoveryCoordinator.onTransportLost` shape, so a driver can
    /// hand this over without an adapter: suspend both directions, then answer
    /// whether anything here is worth holding the link — and its ICE/TURN
    /// allocations — open for.
    ///
    /// Nothing installs it in production yet. `LINK_BUILD_SUPPORT` and
    /// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still false, and the
    /// DataChannel driver that would own this session does not exist.
    public func onTransportLost(_ identity: LinkIdentity) -> Bool {
        let outcome = transportGap()
        if !outcome.effects.isEmpty { onEffects?(outcome.effects) }
        return outcome.needsRecovery
    }

    // MARK: - internals

    private func sendControl(_ byte: UInt8) -> [LinkFileSessionEffect] { [.sendFrame([byte])] }

    /// Has every declared file, and the final DONE, actually entered the channel?
    ///
    /// Asked of the LANE rather than of this owner's own bookkeeping, because the
    /// frontier is the record of what was really produced — and it is the same
    /// record a resume request is bounded by. A finished batch leaves it on the
    /// exact end of the last file.
    private func producedWholeBatch(_ current: OutboundBatch) -> Bool {
        guard let last = current.files.indices.last else { return false }
        return lane.producedFrontier == ResumePoint(index: last, offset: current.files[last].size)
    }

    private func retireOutbound() {
        lane.retireOutboundBatch()
        outbound = nil
    }

    private func retireInbound() {
        lane.retireInboundBatch()
        inbound = nil
    }

    /// End the FILE lane, and only it.
    ///
    /// The live work is released first so the driver is never left holding a
    /// producer or a half-written destination for a lane that has stopped, the
    /// batches that will never go out are NAMED rather than silently dropped, and
    /// the two codec effects come last, in the order the lane's own
    /// `terminalEffects` fixes them.
    private func failLane(alreadyPoisoned: Bool = false) -> [LinkFileSessionEffect] {
        var effects: [LinkFileSessionEffect] = []
        var lost: [Int] = []
        if let current = outbound {
            // Same truthfulness rule as the gap: only a batch that could still
            // have a producer running is told to stop one.
            if current.phase == .sending || current.phase == .stopping {
                effects.append(.stopProducer(batch: current.id, attempt: current.attempt))
            }
            effects.append(.cancelConsentTimeout(batch: current.id, direction: .outbound))
            effects.append(.cancelCompleteTimeout(batch: current.id))
            lost.append(current.id)
        }
        if let current = inbound {
            effects.append(.cancelConsentTimeout(batch: current.id, direction: .inbound))
            effects.append(.cancelReceiveStall(batch: current.id))
            effects.append(.cancelDrainTimeout(batch: current.id))
            if current.phase != .prompt, !lane.destinationFinalized {
                effects.append(.abortDestination(batch: current.id))
            }
        }
        lost.append(contentsOf: queue.map(\.id))
        outbound = nil
        inbound = nil
        queue = []
        if !lost.isEmpty {
            failedBatchIds = lost
            effects.append(.batchesFailed(lost))
        }
        if !alreadyPoisoned { lane.failClosed() }
        return effects + lane.terminalEffects.map(asSessionEffect)
    }

    /// The lane's terminal requirements, in ITS order, expressed as this owner's
    /// effects. Kept as a translation rather than a second list, so a driver still
    /// cannot poison without closing.
    private func asSessionEffect(_ effect: LinkFileEffect) -> LinkFileSessionEffect {
        switch effect {
        case .poisonCodecs: return .poisonCodecs
        case .closeLane: return .closeLane
        }
    }
}
