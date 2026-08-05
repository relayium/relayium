import Foundation

/// One durable receive checkpoint: `offset` bytes of file `index` are on disk,
/// and `chain` is the running per-file hash state that agrees with them.
///
/// All three travel together because a resume is only safe where they agree. A
/// point restored with the wrong chain would verify the file's DONE against
/// bytes that were never written.
public struct LinkFileCheckpoint: Equatable, Sendable {
    public let index: Int
    public let offset: Int
    /// A SHA-256 state: exactly 32 bytes.
    public let chain: [UInt8]

    public init(index: Int, offset: Int, chain: [UInt8]) {
        self.index = index
        self.offset = offset
        self.chain = chain
    }

    public var point: ResumePoint { ResumePoint(index: index, offset: offset) }
}

public enum LinkFileLaneError: Error, Equatable, Sendable {
    /// This lane is terminal. Nothing further is routed, produced or restored.
    case laneFailed
    /// The transport is gone. NOT a failure: the nonce a frame consumed is
    /// repaired by the next generation's announcement, so the caller unwinds
    /// into the gap instead of poisoning a reusable codec pair.
    case transportGap
    /// A protected frame in a replacement generation that has not announced
    /// where its sequence resumes.
    case protectedBeforeRealignment
    /// New outbound work offered to an attached generation whose realignment is
    /// still unpaid. NOT a failure and NOT terminal: pay the debt with
    /// `outboundOriginRealignment` and offer the batch again.
    case realignmentPending
    /// A second announcement in one generation, or one on a lane that never lost
    /// its transport.
    case unexpectedResumeMarker
    /// A `RESUME_REQ` built outside its one legal moment: on a lane with no
    /// realignment to answer, or a second time in one generation.
    case unexpectedResumeRequest
    /// An announcement for an active inbound batch that arrived before this
    /// generation's request was built, so it cannot be an answer to one.
    case resumeMarkerBeforeRequest
    /// The announced point is not the durable one this side holds.
    case resumeMarkerMismatch
    /// The peer asked to resume from a point outside the manifest, off the fixed
    /// grid, or past what this attempt actually produced.
    case resumePointRejected
    /// Plaintext control on an unauthenticated channel whose payload does not
    /// parse, or a frame this lane cannot route at all.
    case malformedControl
    case unroutableFrame
    case noActiveBatch
    case batchAlreadyActive
    case invalidManifest
    /// A write the owner was told to make durable has not reported back yet.
    case persistAlreadyPending
    case invalidChain
    /// More bytes than the manifest declares, or a DONE before a file's declared
    /// bytes arrived.
    case lengthMismatch
    /// A checkpoint that is neither on the `CHUNK_SIZE` grid nor an exact file
    /// end. The chain hash is not defined there, so no resume could name it.
    case unalignedCheckpoint
}

/// What a lane that has failed requires of its driver, in order.
public enum LinkFileEffect: Equatable, Sendable {
    /// These codecs can no longer be proven safe to reuse.
    case poisonCodecs
    case closeLane
}

/// What one inbound frame is, once this lane has decided.
public enum LinkFileInboundDecision: Equatable, Sendable {
    /// Hand it to the link's `RealtimeReceiver` in wire order; it consumes a
    /// nonce, so skipping it would strand the receive sequence.
    case feedProtected
    /// The generation's realignment announcement, already shape-checked. Bring
    /// it straight back through `acceptResumeStart`.
    case resumeMarker(ResumePoint, seq: UInt32)
    case control(LinkFileControl)
    case resumeRequest(ResumePoint)
    /// A flow-control ACK. `total` is nil when the frame carried a number no
    /// conforming peer could produce — ignored rather than fatal, because a
    /// plaintext ACK is forgeable and one injected frame must not be able to end
    /// a working lane. A usable value has already been applied to the send
    /// window, clamped to bytes THIS attempt emitted.
    case ack(total: Int?)
    /// The lane is now terminal. See `terminalEffects`.
    case failClosed(LinkFileLaneError)
}

public enum LinkFilePersistOutcome: Equatable, Sendable {
    /// The checkpoint advanced. `ack` is the cumulative durable batch total to
    /// acknowledge now, or nil when the pacing interval has not been reached.
    case committed(ack: Int?)
    /// Work whose admission is not outstanding any more: the one chunk a gap
    /// left in flight has already committed, or nothing ever named this point.
    case rejectedStale
}

public enum LinkFileDoneOutcome: Equatable, Sendable {
    /// Open this file next. The checkpoint is already pending: report it through
    /// `didPersist` once the destination for it exists.
    case nextFile(LinkFileCheckpoint)
    /// Every file verified. The checkpoint deliberately stays on the last file's
    /// exact end, which is the point a replayed final DONE resumes from.
    case batchComplete
}

public struct LinkFileGapOutcome: Equatable, Sendable {
    /// Did this lane have work worth holding the whole link — and the
    /// initiator's ICE/TURN allocations — open for?
    public let needsRecovery: Bool
    /// What the driver must do because of this gap.
    ///
    /// Empty on every ordinary path, and that emptiness is the contract: unlike
    /// the text lane, a file-lane transport gap NEVER poisons a codec. The file
    /// protocol has a forward-only nonce and a sender-announced resume point, so
    /// whatever the gap burned is repaired by the next generation's marker.
    public let effects: [LinkFileEffect]

    public init(needsRecovery: Bool, effects: [LinkFileEffect] = []) {
        self.needsRecovery = needsRecovery
        self.effects = effects
    }
}

/// One reusable file lane on a long-lived authenticated link: its transport
/// generations, its durable receive checkpoint and its flow-control cursors.
///
/// ## What this owns, and what it deliberately does not
///
/// It owns the PROTOCOL invariants a driver must not recreate: which frame is
/// which, when a generation owes a realignment, where the durable point is, what
/// a resume request is allowed to name, and how a resumed attempt rebases its
/// flow-control cursors. It owns no pickers, no sinks, no source queues, no
/// timers and no DataChannel, and it never constructs a `RealtimeSender` or
/// `RealtimeReceiver` — a second codec under the same session key restarts the
/// GCM nonce at zero, which is a break of the encryption rather than a bug in
/// it. The link's own codecs are passed IN, on the two calls that must move
/// them.
///
/// ## The invariant it exists for
///
/// A link owns one `(content key, direction)` sequence for its whole life. A
/// transport can die under it at any moment, and the frames the dead transport
/// sealed but never delivered have burned their nonces permanently. So:
///
/// > For every transport generation after the first, each direction emits
/// > exactly one `RESUME_START` before its first protected frame, and the peer
/// > requires exactly one before it will accept a protected frame.
///
/// That single announcement carries the peer forward over the hole. Reclaiming a
/// burned nonce instead is exactly how one gets used twice, so nothing here ever
/// rewinds a sequence — `resumeAt` and `resumeAtOrigin` both refuse to.
///
/// ## Why a gap is not a failure, and a missing marker is
///
/// The gap itself proves nothing about the codecs: the marker still repairs it.
/// A MISSING, duplicate, backwards or malformed marker is different — after one
/// of those, this side cannot prove which nonces the peer has seen, and no later
/// frame can establish it. That makes only THIS lane terminal. The text lane is
/// independent and survives all of it, and this type holds no reference to it or
/// to the link's recovery coordinator, which is what makes that structural
/// rather than a rule somebody has to remember.
///
/// ## Concurrency
///
/// Pure and synchronous: no timers, no I/O, no queues, no sleeps. **The owner
/// serializes every call.** In the driver this batch does not include, that
/// means the same FIFO that already serializes the receive chain — the durable
/// checkpoint is only meaningful next to the order the writes actually
/// completed in.
///
/// Pinned against `web/src/lib/mixed-file-session.svelte.ts`.
public final class LinkFileLane {

    // MARK: - configuration

    private let window: Int
    private let ackInterval: Int

    // MARK: - generation

    /// Which transport era this lane is in. Advances on a gap, once per era
    /// however many callbacks reported it.
    public private(set) var generation = 0
    /// In a gap: nothing may be produced, and the era's debt is outstanding.
    private var suspended = false
    /// This direction owes exactly one announcement before its next protected
    /// frame.
    public private(set) var outboundOwesResumeMarker = false
    /// This direction requires exactly one announcement before it will accept a
    /// protected frame.
    public private(set) var inboundRequiresResumeMarker = false
    /// This era's `RESUME_REQ` has been built. One per era, and per era only:
    /// the request is what the peer's announcement answers, so a second would
    /// invite a second answer — which that peer's own lane must then reject as a
    /// duplicate marker.
    private var inboundResumeRequestSent = false
    public private(set) var codecsPoisoned = false
    private var recoveryIntent = false

    /// The ordered effects a failed lane requires, and nothing when it has not
    /// failed. ONE list, so a driver cannot poison without closing or close
    /// without poisoning.
    public var terminalEffects: [LinkFileEffect] {
        codecsPoisoned ? [.poisonCodecs, .closeLane] : []
    }

    // MARK: - outbound batch

    private var outSizes: [Int]?
    private var outIndex = 0
    private var outFileOffset = 0
    /// The furthest logical point that entered an authenticated transport.
    ///
    /// A resume request beyond it can only have been forged or corrupted, and
    /// honouring one would make the sender skip source bytes it never sent. It
    /// deliberately passes through unaligned points while a chunk is fragmented
    /// across several messages — it is an upper BOUND, and alignment is a
    /// separate check.
    public private(set) var producedFrontier = ResumePoint(index: 0, offset: 0)
    private var sendWindow: SendWindow

    /// Where THIS attempt has got to.
    ///
    /// Deliberately separate from `producedFrontier`, and confusing the two is
    /// how a resumed attempt goes wrong. This one REWINDS to the resume point,
    /// because it is the cursor the next frame continues from. The produced
    /// frontier is a high-water mark that must never rewind, because it is what
    /// bounds the next request — a peer that could walk it backwards by asking
    /// twice could then ask for a point the sender never actually produced.
    public var attemptFrontier: ResumePoint {
        ResumePoint(index: outIndex, offset: outFileOffset)
    }

    /// The cumulative batch bytes this attempt has emitted. The number the
    /// receiver's ACK is clamped to.
    public var attemptBytes: Int { sendWindow.sentTotal }

    // MARK: - inbound batch

    private var inSizes: [Int]?
    /// Authenticated-but-not-durable position. Deliberately separate from
    /// `durable`: a frame that decrypted is not a byte that survived a crash.
    private var inIndex = 0
    private var inOffset = 0
    private var durable = LinkFileCheckpoint(index: 0, offset: 0,
                                             chain: [UInt8](repeating: 0, count: 32))
    /// The ONE checkpoint the owner has been told to make durable and has not
    /// reported back. At most one, because the receive FIFO has at most one
    /// write in flight — which is what makes an old generation's completion
    /// unambiguous.
    private var pendingPersist: LinkFileCheckpoint?
    private var pacer: AckPacer
    /// Every file of the inbound batch verified. The destination may be
    /// finalised once, and until the peer's COMPLETE is known to have arrived a
    /// replacement generation must be able to replay the final encrypted DONE.
    public private(set) var inboundBatchComplete = false
    public private(set) var destinationFinalized = false

    public init(window: Int = FLOW_WINDOW, ackInterval: Int = FLOW_ACK_INTERVAL) {
        self.window = window
        self.ackInterval = ackInterval
        self.sendWindow = SendWindow(window: window)
        self.pacer = AckPacer(interval: ackInterval)
    }

    /// The durable point a `RESUME_REQ` would name right now.
    public var durableCheckpoint: LinkFileCheckpoint { durable }

    /// May a protected frame enter the channel? Credit, the gap and the
    /// generation's unpaid debt are all reasons it may not.
    public var maySendProtected: Bool {
        !codecsPoisoned && !suspended && !outboundOwesResumeMarker && sendWindow.maySend
    }

    // MARK: - transport generations

    /// End this lane from the owner above it, and hand back what that requires.
    ///
    /// The lane sees FRAMES; an owner sees what they mean. "Protected content
    /// arrived before the user consented" and "the link's receiver refused this
    /// frame" are both violations only the owner can detect, and both leave the
    /// same question unanswerable — which nonces the peer has consumed. Routing
    /// them through here rather than letting an owner keep its own terminal flag
    /// is what keeps one terminal path: a lane cannot end without its codecs
    /// being poisoned, and cannot be poisoned without being closed.
    ///
    /// Idempotent, and scoped to THIS lane: nothing here reaches the text lane or
    /// the link's recovery coordinator.
    @discardableResult
    public func failClosed() -> [LinkFileEffect] {
        poison()
        return terminalEffects
    }

    /// Enter a transport gap.
    ///
    /// Idempotent: a channel `onclose` and the PeerConnection's own terminal
    /// callback are ONE gap however many times they report it, and advancing the
    /// era twice would owe a second announcement the peer is required to reject.
    @discardableResult
    public func transportGap() -> LinkFileGapOutcome {
        // FIRST, and before this gap is sampled for work: a terminal lane has
        // nothing a replacement could restore, because its codecs are what a
        // replacement would have had to reuse. Asking for recovery here would
        // hold the whole link — and the initiator's ICE/TURN allocations — open
        // for a lane no transport can bring back. It also starts no era and owes
        // no marker, since it could never send one.
        guard !codecsPoisoned else { return LinkFileGapOutcome(needsRecovery: false) }
        guard !suspended else { return LinkFileGapOutcome(needsRecovery: recoveryIntent) }
        suspended = true
        // Sampled at the FIRST report of the gap: by the time a coordinator
        // observes a dead PeerConnection this may already have run, and "is there
        // work now" is a different question from the one recovery has to answer.
        recoveryIntent = recoveryIntent || outSizes != nil || inSizes != nil
        generation += 1
        outboundOwesResumeMarker = true
        inboundRequiresResumeMarker = true
        // The era that died took its request with it. The new one asks again, and
        // once — from whatever prefix is durable by then.
        inboundResumeRequestSent = false
        // Deliberately no effects: the file protocol repairs a gap with its next
        // announcement, so nothing here poisons a codec.
        return LinkFileGapOutcome(needsRecovery: recoveryIntent)
    }

    /// A replacement transport answers the question the gap recorded. Same
    /// authenticated link, same codecs, new channel — so the era's debt stays
    /// exactly as it was, and only the ability to send returns.
    public func didAttachReplacementTransport() {
        suspended = false
        // A replacement is the only thing that answers the marker, so it is the
        // only thing that may clear it.
        recoveryIntent = false
    }

    // MARK: - inbound routing

    /// Route one frame off the file channel.
    ///
    /// Lifecycle controls, ACKs and the resume REQUEST are plaintext and consume
    /// no nonce, so they keep flowing during a realignment — the request is
    /// precisely the frame a realignment is waiting for. Only protected input is
    /// held behind the barrier.
    public func admitInboundFrame(_ frame: [UInt8]) -> LinkFileInboundDecision {
        guard !codecsPoisoned else { return .failClosed(.laneFailed) }
        switch linkFileFrameClass(frame) {
        case let .lifecycle(control):
            return .control(control)
        case .ack:
            guard let total = linkFileAckTotal(frame) else { return .ack(total: nil) }
            // Exact: the value has already been proven to be a non-negative
            // integer at or below `Number.MAX_SAFE_INTEGER`, which every `Double`
            // represents without loss.
            sendWindow.recordAck(Double(total))
            return .ack(total: total)
        case .resumeRequest:
            guard let point = parseResumeReq(frame) else { return routeTerminal(.malformedControl) }
            return .resumeRequest(point)
        case .resumeStart:
            guard let announced = parseResumeStart(frame) else { return routeTerminal(.malformedControl) }
            return .resumeMarker(announced.point, seq: announced.seq)
        case .protected:
            // The sequence here is unaligned until the peer says where it
            // resumed. A protected frame would either fail to decrypt or, worse,
            // decrypt at a sequence this side cannot prove was never used.
            guard !inboundRequiresResumeMarker else { return routeTerminal(.protectedBeforeRealignment) }
            return .feedProtected
        case .unroutable:
            // Never skipped: on an ordered channel a frame this lane cannot route
            // is either corruption or a protocol this build does not have, and
            // one the peer counted would strand the receive sequence.
            return routeTerminal(.unroutableFrame)
        }
    }

    // MARK: - outbound batch

    /// Admit a new outbound batch.
    ///
    /// An admitted batch means "this direction may now produce protected frames",
    /// and its very first one is the manifest. So both reasons that frame could
    /// not go out are reasons the batch may not be admitted:
    ///
    ///  - **In a gap.** Pinned to `mixed-file-session.svelte.ts`'s `pump()`,
    ///    which refuses to launch while `suspended` and re-checks it after
    ///    `ensureLink` resolves, because "a batch must never launch into that".
    ///  - **Attached, realignment unpaid.** An idle direction pays its debt at
    ///    the batch-free ORIGIN, and `outboundOriginRealignment` is defined only
    ///    while no batch is active. Admitting first therefore left the lane
    ///    holding work it could not announce for: the origin call answered
    ///    `batchAlreadyActive`, and the only remaining exit was
    ///    `outboundBatchResume` — an API documented for a batch that is RESUMING,
    ///    reachable here solely because a fresh batch's frontier happens to be
    ///    the origin. Refusing up front is what makes the legal order the only
    ///    order: attach, realign, admit, produce.
    ///
    /// Both refusals are non-terminal and mutate nothing: the caller pays the
    /// debt, or waits for the replacement, and offers the same batch again. This
    /// is deliberately about NEW work — a batch admitted before the gap is what a
    /// resume exists for, and it reaches `outboundBatchResume` untouched.
    public func beginOutboundBatch(sizes: [Int]) throws {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        guard !suspended else { throw LinkFileLaneError.transportGap }
        guard outSizes == nil else { throw LinkFileLaneError.batchAlreadyActive }
        guard !outboundOwesResumeMarker else { throw LinkFileLaneError.realignmentPending }
        try validate(sizes)
        outSizes = sizes
        outIndex = 0
        outFileOffset = 0
        producedFrontier = ResumePoint(index: 0, offset: 0)
        sendWindow = SendWindow(window: window)
    }

    /// Retire the outbound batch without touching the generation state. A batch
    /// ends; the lane and its codecs go on.
    public func retireOutboundBatch() {
        outSizes = nil
        outIndex = 0
        outFileOffset = 0
        producedFrontier = ResumePoint(index: 0, offset: 0)
        sendWindow = SendWindow(window: window)
    }

    /// One frame has entered an authenticated transport.
    ///
    /// Called AFTER the frame is on the channel, because that is what the
    /// frontier claims. Only `chunk`/`chunkPart` carry file plaintext: the
    /// manifest and the per-file DONE burn nonces without being progress, and
    /// counting them would make this cursor disagree with the receiver's durable
    /// total, which is the number the ACK clamp is measured against.
    ///
    /// The manifest BOUNDS all of it. A chunk past a file's declared size, a
    /// chunk with no file left to belong to and a DONE before a file's declared
    /// bytes are each a frame that already spent a nonce the peer counts, so
    /// there is nothing to unwind and nothing later can repair the disagreement:
    /// this lane fails closed. Every check runs before any mutation, so a refused
    /// frame leaves the cursor, the frontier and the window untouched — a
    /// half-applied refusal would leave the very frontier a resume request is
    /// bounded by pointing somewhere this side never produced.
    public func didProduceFrame(_ frame: [UInt8]) throws {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        guard let sizes = outSizes else { throw LinkFileLaneError.noActiveBatch }
        // The gap comes first and is NOT a failure: the frame's nonce is repaired
        // by the next generation's announcement.
        guard !suspended else { throw LinkFileLaneError.transportGap }
        guard !outboundOwesResumeMarker else {
            // The announcement is what makes the announced seq the one the next
            // protected frame carries. A frame in front of it leaves the peer
            // realigning to a number that is already stale, and no later frame
            // can repair that.
            throw makeTerminal(.protectedBeforeRealignment)
        }
        if isChunkFrame(frame) {
            // Every chunk belongs to a file. Past the last DONE there is none, and
            // a cursor that kept counting would name points outside the manifest —
            // exactly the points `validResumeRequest` exists to refuse.
            guard outIndex < sizes.count else { throw makeTerminal(.lengthMismatch) }
            let plaintext = chunkPlaintextBytes(frame)
            // Not a short chunk: a malformed one. No conforming producer emits a
            // chunk with nothing under its tag, and counting one would claim a
            // chunk went out while the cursor stood still.
            guard plaintext > 0 else { throw makeTerminal(.lengthMismatch) }
            let (offset, overflow) = outFileOffset.addingReportingOverflow(plaintext)
            // Checked, and bounded by the DECLARED size. The manifest is what the
            // peer validates a later resume request against, so a frontier past it
            // is a point no side could agree on — and one this side would then
            // honour a request for, skipping source bytes it never sent.
            guard !overflow, offset <= sizes[outIndex] else { throw makeTerminal(.lengthMismatch) }
            // Nothing above this line mutates: a refusal leaves the cursor, the
            // frontier and the window exactly where the last accepted frame did.
            sendWindow.recordSent(plaintext)
            outFileOffset = offset
            advanceProduced(ResumePoint(index: outIndex, offset: offset))
            return
        }
        guard frame.first == RealtimeKind.doneEnc else { return }
        guard outIndex < sizes.count else { throw makeTerminal(.lengthMismatch) }
        // A file cannot end before its declared bytes were produced. A zero-byte
        // file satisfies this on its DONE alone, and a resumed attempt that
        // rebased onto a file's exact end satisfies it immediately — which is
        // what makes the replayed final DONE expressible.
        guard outFileOffset == sizes[outIndex] else { throw makeTerminal(.lengthMismatch) }
        let finished = outIndex
        outIndex += 1
        outFileOffset = 0
        // A finished file that is not the last one moves to the next file's zero;
        // the last one lands on its own exact end, never past the manifest.
        advanceProduced(outIndex < sizes.count
                        ? ResumePoint(index: outIndex, offset: 0)
                        : ResumePoint(index: finished, offset: sizes[finished]))
    }

    /// Would this peer's `RESUME_REQ` be honoured?
    ///
    /// Three separate questions, all of which must hold. Range is "does this
    /// batch have such a byte"; alignment is "is the chain hash even defined
    /// there"; the frontier is "did this side ever actually produce it".
    public func validResumeRequest(_ point: ResumePoint) -> Bool {
        guard !codecsPoisoned, let sizes = outSizes else { return false }
        guard resumePointInRange(point, sizes), resumePointAligned(point, sizes) else { return false }
        return pointAtOrBefore(point, producedFrontier)
    }

    /// Pay this generation's outbound debt for a batch that is resuming, and
    /// hand back the exact announcement to send.
    ///
    /// The frame is built by the LINK's own sender, so the seq it names is the
    /// one that sender will really use next. Nothing here constructs a codec.
    public func outboundBatchResume(to point: ResumePoint,
                                    sender: RealtimeSender) throws -> [UInt8] {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        // Only a replacement transport answers a gap, so nothing may answer one
        // before the owner reports that a replacement exists. An announcement
        // built here would name a sequence into a channel that is gone, while
        // clearing a debt the real replacement then has no way to pay.
        guard !suspended else { throw LinkFileLaneError.transportGap }
        guard let sizes = outSizes else { throw LinkFileLaneError.noActiveBatch }
        guard outboundOwesResumeMarker else { throw makeTerminal(.unexpectedResumeMarker) }
        // A forged request is not proof the codecs are unusable, so this refuses
        // the point and leaves the debt unspent rather than ending the lane.
        guard validResumeRequest(point) else { throw LinkFileLaneError.resumePointRejected }
        let frame = try sender.resumeStartFrame(point)
        outboundOwesResumeMarker = false
        outIndex = point.index
        outFileOffset = point.offset
        // One fresh window measured from the durable checkpoint. Both cursors
        // move together, so a delayed ACK from the attempt that died cannot be
        // replayed as credit against this one.
        sendWindow.rebase(to: batchOffset(sizes, point))
        return frame
    }

    /// Pay this generation's outbound debt on a direction with nothing to
    /// continue. With no batch, the batch-free origin is the only point that
    /// means anything.
    public func outboundOriginRealignment(sender: RealtimeSender) throws -> [UInt8] {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        // Same rule as the batch case, and for the same reason: an idle direction
        // still owes exactly one announcement, and paying it into a dead channel
        // spends the era's only chance to realign.
        guard !suspended else { throw LinkFileLaneError.transportGap }
        guard outSizes == nil else { throw LinkFileLaneError.batchAlreadyActive }
        guard outboundOwesResumeMarker else { throw makeTerminal(.unexpectedResumeMarker) }
        let frame = try sender.resumeStartFrame(ResumePoint(index: 0, offset: 0))
        outboundOwesResumeMarker = false
        sendWindow.rebase(to: 0)
        return frame
    }

    // MARK: - inbound batch and its durable checkpoint

    /// Admit a new inbound batch.
    ///
    /// Deliberately WITHOUT the outbound admission guards, and the asymmetry is
    /// the point rather than an oversight. A manifest is a PROTECTED frame, so the
    /// only way one reaches an owner is through `admitInboundFrame`, which already
    /// refuses protected input — terminally — while this era's marker is unpaid.
    /// The barrier is the routing gate; a second copy here would guard a state
    /// that cannot be reached through this type's own API.
    ///
    /// A gap is not a reason to refuse either, and refusing would lose data. This
    /// call records a manifest the OLD generation already authenticated, whose
    /// consent and bookkeeping can easily complete after the transport died — the
    /// receive FIFO is asynchronous. That is the same ground-truth argument that
    /// lets `didPersist` commit a write which crossed a replacement: refusing it
    /// would drop the very batch recovery exists to restore.
    public func beginInboundBatch(sizes: [Int]) throws {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        guard inSizes == nil else { throw LinkFileLaneError.batchAlreadyActive }
        try validate(sizes)
        inSizes = sizes
        inIndex = 0
        inOffset = 0
        durable = LinkFileCheckpoint(index: 0, offset: 0, chain: zeroChain)
        pendingPersist = nil
        pacer = AckPacer(interval: ackInterval)
        inboundBatchComplete = false
        destinationFinalized = false
    }

    public func retireInboundBatch() {
        inSizes = nil
        inIndex = 0
        inOffset = 0
        durable = LinkFileCheckpoint(index: 0, offset: 0, chain: zeroChain)
        pendingPersist = nil
        pacer = AckPacer(interval: ackInterval)
        inboundBatchComplete = false
        destinationFinalized = false
    }

    /// One whole logical chunk has been authenticated. Returns the checkpoint the
    /// owner must make durable and then report through `didPersist`.
    ///
    /// `chain` is the receiver's `snapshotChain()` taken with this chunk, so the
    /// hash state and the bytes agree at exactly this point.
    @discardableResult
    public func didAdmitChunk(byteCount: Int, chain: [UInt8]) throws -> LinkFileCheckpoint {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        guard let sizes = inSizes, inIndex < sizes.count, !inboundBatchComplete else {
            throw LinkFileLaneError.noActiveBatch
        }
        // The receive FIFO has at most one write outstanding. A second admission
        // in front of it would make an old generation's completion ambiguous,
        // which is the one thing the single-slot rule exists to prevent.
        guard pendingPersist == nil else { throw LinkFileLaneError.persistAlreadyPending }
        guard chain.count == 32 else { throw LinkFileLaneError.invalidChain }
        guard byteCount > 0, byteCount <= sizes[inIndex] - inOffset else {
            throw LinkFileLaneError.lengthMismatch
        }
        let offset = inOffset + byteCount
        // Every durable point is on the boundary set the chain hash is defined
        // on — a `CHUNK_SIZE` multiple or an exact file end — because that is the
        // set the peer's sender will validate the resulting request against.
        guard offset % CHUNK_SIZE == 0 || offset == sizes[inIndex] else {
            throw LinkFileLaneError.unalignedCheckpoint
        }
        inOffset = offset
        let point = LinkFileCheckpoint(index: inIndex, offset: offset, chain: chain)
        pendingPersist = point
        return point
    }

    /// The owner has made the outstanding checkpoint durable.
    ///
    /// A write that crossed a transport replacement still commits. It was
    /// authenticated in the OLD generation's FIFO and is on disk either way, and
    /// committing it is exactly what makes the replacement's `RESUME_REQ` name
    /// the real durable prefix rather than a speculative one. Everything after
    /// that single admission is stale and changes nothing.
    /// Deliberately usable on a terminal lane: this call reports GROUND TRUTH
    /// about what reached the disk, and refusing it would make the lane's own
    /// record less accurate than reality at exactly the moment somebody is
    /// reading it to decide what was saved.
    public func didPersist(_ point: LinkFileCheckpoint) -> LinkFilePersistOutcome {
        guard let pending = pendingPersist, pending == point else { return .rejectedStale }
        pendingPersist = nil
        durable = point
        guard let sizes = inSizes else { return .committed(ack: nil) }
        return .committed(ack: pacer.onWritten(total: batchOffset(sizes, point.point)))
    }

    /// One file's DONE has been authenticated and verified.
    public func didAdmitDone() throws -> LinkFileDoneOutcome {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        guard let sizes = inSizes, inIndex < sizes.count, !inboundBatchComplete else {
            throw LinkFileLaneError.noActiveBatch
        }
        guard pendingPersist == nil else { throw LinkFileLaneError.persistAlreadyPending }
        // A file cannot end before its declared bytes arrived. A zero-byte file
        // satisfies this on its DONE alone, which is what keeps an empty file a
        // real boundary rather than a special case.
        guard inOffset == sizes[inIndex] else { throw LinkFileLaneError.lengthMismatch }
        inIndex += 1
        inOffset = 0
        guard inIndex < sizes.count else {
            // The checkpoint deliberately does NOT move past the last file's
            // exact end: that end is the point a replayed final DONE resumes
            // from after a lost COMPLETE.
            inboundBatchComplete = true
            return .batchComplete
        }
        let next = LinkFileCheckpoint(index: inIndex, offset: 0, chain: zeroChain)
        pendingPersist = next
        return .nextFile(next)
    }

    /// Finalise the destination, exactly once for the life of this batch.
    ///
    /// One-shot by construction rather than by convention: a replayed final DONE
    /// runs the same completion path a second time, and finalising twice would
    /// leave the user a duplicate.
    @discardableResult
    public func didFinalizeDestination() -> Bool {
        guard inboundBatchComplete, !destinationFinalized else { return false }
        destinationFinalized = true
        return true
    }

    /// The request naming this side's durable prefix — one half of a handshake,
    /// not a getter.
    ///
    /// It is legal in exactly one state, and each condition is a separate
    /// protocol fact:
    ///
    ///  - **A replacement is attached.** The request is what the peer answers
    ///    with its announcement, and nothing can answer over a channel that is
    ///    gone.
    ///  - **This era still requires a marker.** Without an unpaid inbound debt
    ///    there is no announcement coming, so a request would invite a marker the
    ///    peer's own lane must reject as unexpected.
    ///  - **Once per era.** Two requests invite two answers, and the second is a
    ///    duplicate marker — terminal on the side that receives it.
    ///  - **There is a batch to resume.** An idle direction asks for nothing; it
    ///    waits for the peer's lazy origin announcement before that peer's next
    ///    protected batch.
    ///  - **The admitted receive FIFO has settled.** A write the owner has not
    ///    reported back on has not reached the disk, so the request would name a
    ///    point the FIFO is about to move underneath it.
    ///
    /// Refusals here are NOT terminal. Nothing reached the wire — the caller did
    /// not get a frame — so refusing is precisely what keeps the duplicate from
    /// existing, and ending a usable lane over a local ordering slip would turn a
    /// driver bug into a destroyed transfer.
    public func resumeRequestFrame() throws -> [UInt8] {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        guard !suspended else { throw LinkFileLaneError.transportGap }
        guard inboundRequiresResumeMarker else { throw LinkFileLaneError.unexpectedResumeRequest }
        guard !inboundResumeRequestSent else { throw LinkFileLaneError.unexpectedResumeRequest }
        guard inSizes != nil else { throw LinkFileLaneError.noActiveBatch }
        guard pendingPersist == nil else { throw LinkFileLaneError.persistAlreadyPending }
        inboundResumeRequestSent = true
        return resumeReqFrame(index: durable.index, offset: durable.offset)
    }

    /// Accept the peer's announcement and move the LINK's real receiver through
    /// it. Nothing here constructs a receiver.
    ///
    /// With a batch, the point must be EXACTLY the durable one: a forged earlier
    /// point would duplicate bytes into an append-only sink, and a forged later
    /// one would make the sender skip source bytes. With no batch, only the
    /// batch-free origin means anything. Either way `resumeAt`/`resumeAtOrigin`
    /// still refuse to move the nonce backwards, so a forged announcement can
    /// only push this side forward into frames it cannot decrypt — denial of
    /// service, never nonce reuse and never an integrity bypass.
    public func acceptResumeStart(_ point: ResumePoint,
                                  seq: UInt32,
                                  receiver: RealtimeReceiver) throws {
        guard !codecsPoisoned else { throw LinkFileLaneError.laneFailed }
        // A frame can only arrive over a transport, so one reaching this side
        // before the owner has reported the replacement came from the channel
        // that died. Refused as the gap it is, and never terminal: the era's one
        // acceptance is still there for the real announcement.
        guard !suspended else { throw LinkFileLaneError.transportGap }
        // Exactly one, only in the state that expects one. That narrowness is
        // what keeps a forged plaintext frame from being a free sequence jump at
        // any moment the peer chooses.
        guard inboundRequiresResumeMarker else { throw makeTerminal(.unexpectedResumeMarker) }
        // The request named the durable prefix. A write still outstanding means
        // this side cannot prove the announced point matches what is on disk.
        guard pendingPersist == nil else { throw makeTerminal(.persistAlreadyPending) }
        // The handshake is REQUEST then ANNOUNCEMENT. With a batch, the point the
        // peer names can only have come from this side's request, so a marker in
        // front of one is a stale era's frame or a forged one. Accepting it would
        // spend this era's single acceptance on it and leave the real answer to be
        // rejected as a duplicate — after which no later frame could establish
        // which nonces the peer has actually consumed. An idle direction is
        // exempt: its origin announcement is lazy and answers no request.
        guard inSizes == nil || inboundResumeRequestSent else {
            throw makeTerminal(.resumeMarkerBeforeRequest)
        }
        do {
            if let sizes = inSizes {
                guard point == durable.point else { throw LinkFileLaneError.resumeMarkerMismatch }
                try receiver.resumeAt(point, chain: durable.chain, seq: seq)
                // The sender opened one new window from this same offset, so the
                // next ACK is measured from it too.
                pacer.rebase(to: batchOffset(sizes, point))
                inIndex = durable.index
                inOffset = durable.offset
                // Restoring INTO a batch that had closed out IS the replayed
                // final DONE, so the batch is live again for exactly that frame.
                // `destinationFinalized` deliberately survives it.
                inboundBatchComplete = false
            } else {
                guard point == ResumePoint(index: 0, offset: 0) else {
                    throw LinkFileLaneError.resumeMarkerMismatch
                }
                try receiver.resumeAtOrigin(seq: seq)
            }
        } catch {
            poison()
            throw error
        }
        inboundRequiresResumeMarker = false
    }

    // MARK: - internals

    private let zeroChain = [UInt8](repeating: 0, count: 32)

    /// The one terminal transition, so no path can end this lane while leaving it
    /// still claiming a replacement could restore it.
    ///
    /// Recovery intent drops here rather than only in `transportGap`, because the
    /// lane can fail at any point INSIDE a gap it has already reported — after
    /// which every later report of that same gap must answer with what is true
    /// now, not with what was in flight when the transport died.
    private func poison() {
        codecsPoisoned = true
        recoveryIntent = false
    }

    /// Make this lane terminal and report it as a routing decision.
    private func routeTerminal(_ error: LinkFileLaneError) -> LinkFileInboundDecision {
        poison()
        return .failClosed(error)
    }

    /// Make this lane terminal and hand back the error to throw. Separate from
    /// `routeTerminal` only in how the caller reports it; both mean the same
    /// thing, and both are scoped to THIS lane — nothing here reaches the text
    /// lane or the link's recovery coordinator.
    private func makeTerminal(_ error: LinkFileLaneError) -> LinkFileLaneError {
        poison()
        return error
    }

    private func advanceProduced(_ point: ResumePoint) {
        if pointAtOrBefore(producedFrontier, point) { producedFrontier = point }
    }

    private func pointAtOrBefore(_ candidate: ResumePoint, _ frontier: ResumePoint) -> Bool {
        candidate.index < frontier.index
            || (candidate.index == frontier.index && candidate.offset <= frontier.offset)
    }

    /// The batch-cumulative byte offset of a point. Total over any point, so a
    /// forged index cannot walk off the manifest.
    private func batchOffset(_ sizes: [Int], _ point: ResumePoint) -> Int {
        var sum = 0
        for i in 0..<Swift.min(Swift.max(point.index, 0), sizes.count) { sum += sizes[i] }
        return sum + Swift.max(point.offset, 0)
    }

    /// A manifest this lane can count in.
    ///
    /// The ceiling is `Number.MAX_SAFE_INTEGER`, both per file and on the total:
    /// every cursor here is a batch-cumulative sum, and `validate` is what keeps
    /// `batchOffset`'s additions inside `Int` without a checked add per file.
    private func validate(_ sizes: [Int]) throws {
        guard !sizes.isEmpty, sizes.count <= MAX_FILES else {
            throw LinkFileLaneError.invalidManifest
        }
        var total = 0
        for size in sizes {
            guard size >= 0, size <= 9_007_199_254_740_991 else {
                throw LinkFileLaneError.invalidManifest
            }
            let (sum, overflow) = total.addingReportingOverflow(size)
            guard !overflow, sum <= 9_007_199_254_740_991 else {
                throw LinkFileLaneError.invalidManifest
            }
            total = sum
        }
    }
}
