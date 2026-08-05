import Foundation

/// How much may sit in the TEXT channel's send buffer before this driver stops
/// handing it messages.
///
/// One mebibyte, and deliberately far below the file lane's `FLOW_WINDOW`: a
/// text message is a human typing, so a buffer this deep is already a channel
/// that is not draining rather than a transfer under way. The number is a
/// policy, not a protocol constant — the peer never sees it — which is why it is
/// injectable and why the two paths that consult it are described where they
/// are used.
public let LINK_TEXT_SEND_HIGH_WATER: UInt64 = 1 << 20

// MARK: - what a driver reports

/// Why a local text operation, or the text lane itself, could not go on.
///
/// Never carries a message body. Everything here is a state or a length, and
/// `LinkTextSessionError`'s payloads are byte counts and sequence numbers by the
/// same rule — an error string is the one place plaintext leaks into a log
/// without anybody deciding it should.
public enum LinkTextDriverError: Error, Equatable, Sendable {
    /// The TEXT lane is terminal. The link, the transport and the file lane are
    /// deliberately untouched.
    case laneTerminal
    /// The held link ended. Nothing routes any more.
    case linkEnded
    /// A replacement published an identity that is not this link's — including
    /// one whose peer, role and SAS match but whose `LinkCodecs` object does
    /// not, which is the catastrophe rather than a mismatch.
    case identityMismatch
    /// A replacement transport that cannot carry a lane.
    case replacementNotLive
    /// No usable text transport right now: a gap, or a channel this driver has
    /// already marked unwritable. Retryable once one is attached.
    case transportUnavailable
    /// The channel's send buffer is above the high-water mark. **Retryable, and
    /// it consumed no nonce**: the check runs before the sender is touched.
    case backpressured
    /// The session refused THIS message and can still produce the next one — an
    /// empty body, a size, an unnegotiated frame limit, a closed conversation.
    case refused(LinkTextSessionError)
    /// A frame this session sealed could not be put on the wire. Its nonce is
    /// spent and the peer will never see it, so the text codecs cannot be proven
    /// safe to reuse.
    case protectedSendFailed
}

/// What an owner above this driver observes.
///
/// Three cases and no more. Status is the conversation the user is looking at,
/// `received` is the only place plaintext leaves this object, and `failed` is
/// the ONE terminal report — emitted at most once for the whole life of the
/// driver, whatever combination of a poisoned lane, a refused frame and an ended
/// link arrives afterwards.
///
/// Every one of these is delivered with NO lock held, in the order it was
/// produced.
public enum LinkTextDriverEvent: Equatable, Sendable {
    /// The conversation moved. Emitted only on a real change, so an owner can
    /// render it directly.
    case status(LinkTextStatus)
    /// One authenticated inbound message for a conversation both sides consented
    /// to.
    case received(String)
    /// Terminal, and at most one.
    case failed(LinkTextDriverError)
}

// MARK: - the driver

/// Owns ONE `LinkTextSession` across an initial transport and its authenticated
/// replacements, executes the session's effects, and plugs into
/// `LinkRecoveryCoordinator`'s policy seams.
///
/// ## What it deliberately is not
///
/// **It never installs `LinkLiveTransport.onFrame`, and it holds no reference to
/// a file driver or a recovery coordinator.** That slot belongs to whoever owns
/// the whole transport — `LinkFileDriver` on the initial one, the coordinator on
/// a replacement — and two owners racing for one unsynchronised slot is not a
/// policy question, it is a lost lane. Inbound bytes reach this driver through
/// `admitTextFrame` and nowhere else, which is what lets a later
/// `LinkLaneOwner` demux one route into two lanes without either lane being able
/// to take the other's frames.
///
/// ## Synchronization
///
/// The same three rules `LinkFileDriver` records, and they are the same rules
/// because the deadlock is the same deadlock.
///
/// **1. `state` guards every mutable field, and nothing blocking runs under
/// it.** No `send`, no `bufferedAmount`, no `close`, no owner callback. The real
/// transports enter their own serial queue synchronously and deliver frames from
/// it, so a driver that sent under the lock its own inbound path needs would
/// deadlock against a peer that happened to be talking. Scheduling and
/// cancelling a timer under the lock IS allowed, exactly as in the file driver:
/// a scheduler hands back a handle and never calls out.
///
/// The prohibition is on holding A LOCK across a transport call, not on that one
/// lock's name. `sendGate` is the other lock here and it is bound by exactly the
/// same rule: the queue a transport call waits for may be delivering the owner
/// callback that wants the gate. See `sendGate` and `send(_:)`.
///
/// **2. Everything that leaves this object leaves through a queue.** Under the
/// lock, effects append to the typed `outbox` and to `notices`; after the lock is
/// released the caller drains them. Both drains are single-consumer hand-offs, so
/// a callback that re-enters this driver can neither recurse into a second
/// delivery nor reorder anything.
///
/// **3. The wire drain is scoped to a transport EPOCH.** Every transport change
/// bumps `epoch`, and a drain, a poll or a timer whose epoch was replaced
/// underneath it stops without touching the new generation's work.
///
/// ## The two things this lane has that the file lane does not
///
/// **A typed outbox.** A lifecycle control and a sealed frame fail differently
/// and irreversibly so: a control consumes no nonce, so bytes that never left
/// the buffer cost this transport GENERATION and a replacement may simply send
/// them again; a protected frame's nonce is already spent, so the same failure
/// leaves the peer expecting a sequence number that will never arrive. The
/// driver must never have to re-demux bytes to know which one it is holding, so
/// the queue carries the answer.
///
/// **An authoritative `protectedUnflushed`.** The recovery coordinator closes and
/// removes the channels BEFORE the owner's policy runs, so `bufferedAmount` at
/// gap time is zero for a channel that never flushed anything. This driver
/// therefore keeps its own conservative answer: true from the instant a frame is
/// sealed, and false only after it has itself observed, off the lock, both an
/// empty local outbox and a zero buffer on a transport that is still open.
///
/// ## What it is not, again
///
/// Unreachable from production. `LINK_BUILD_SUPPORT` and
/// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still false, nothing
/// constructs one, and it owns no UI, no admission and no composition with the
/// file lane — that is `LinkLaneOwner`'s, and it does not exist yet.
public final class LinkTextDriver: @unchecked Sendable {

    // MARK: - owned synchronization
    //
    // `@unchecked Sendable` is earned:
    //
    //  - `identity`, `session`, `scheduler` and the three tuning values are
    //    immutable after `init`.
    //  - EVERY other stored property is read and written only with `state` held.
    //  - `state` is never held across a transport call or an owner callback.
    //  - `sendGate` orders the ONE path that consumes a sender nonce. It is
    //    always taken BEFORE `state` and never from under it, so the order is
    //    total: sendGate -> state.
    //  - NEITHER lock is ever held across a transport call. `state` because the
    //    transports deliver inbound frames from the same serial queue their
    //    methods enter; `sendGate` for exactly the same reason one level up —
    //    a delivery on that queue can reach an owner callback that sends, so a
    //    gate held across a transport call closes the cycle. The gate covers
    //    sealing and queueing; the probe before it and the drain after it are
    //    both ungated.
    //
    // `state` is recursive because effect execution genuinely nests: a session
    // call produces `closeLane`, whose handling runs more effects. Recursion is
    // legal; blocking is not.

    private let state = NSRecursiveLock()
    /// Serializes the nonce-consuming step alone: `session.send` and the queueing
    /// of what it sealed, so two concurrent sends cannot interleave and put the
    /// link's sender sequence numbers on the wire out of order.
    ///
    /// It covers NO transport call. The pre-seal buffer probe is left outside it
    /// on purpose — that probe enters the transport's serial queue, and an owner
    /// callback delivered from that same queue may re-enter `send` and want this
    /// gate. See `send(_:)`.
    ///
    /// Deliberately not `state` either: `state` is a recursive lock that effect
    /// execution genuinely nests under, and nesting a nonce boundary is how two
    /// sends end up interleaved rather than ordered.
    private let sendGate = NSLock()

    private let identity: LinkIdentity
    private let session: LinkTextSession
    private let scheduler: LinkRecoveryScheduler
    /// What the CONNECTION negotiated, not the product cap. A sealed 64 KiB
    /// message is 65 557 B and does not fit a peer that negotiated the RFC 8841
    /// default of 65 536.
    private let maxFrameBytes: Double
    private let sendBufferHighWater: UInt64
    private let sendBufferPollInterval: TimeInterval
    private let onEvent: (LinkTextDriverEvent) -> Void

    // MARK: - state, all of it under `state`

    private var transport: LinkLiveTransport?
    private var currentToken: ObjectIdentifier?
    /// Bumped on every transport change. Names the wire generation an emission
    /// belongs to and the drain, poll or timer that is allowed to carry it.
    private var epoch = 0

    /// The TEXT lane is terminal. The link and the transport may be perfectly
    /// alive, and the file lane certainly is.
    private var textTerminal = false
    /// The held link itself ended.
    private var linkEnded = false
    /// A lifecycle control could not be written, so this generation's text
    /// channel is not usable — but nothing was poisoned, and the queue behind
    /// that control is kept until a real gap can decide what it means.
    private var textTransportClosing = false
    /// One terminal report, ever.
    private var terminalEmitted = false
    /// The error the terminal report should carry, when the driver — rather than
    /// the lane — is what detected the failure.
    private var pendingFailure: LinkTextDriverError?

    /// A protected frame has been sealed and this driver has NOT proven it left
    /// the channel. Conservative by construction: set before the frame can leave
    /// `state`, cleared only by an observation this driver made itself.
    private var protectedUnflushed = false

    /// One outbound item, with its two failures kept apart by the type.
    private enum Outgoing {
        case control(UInt8)
        case protected([UInt8])

        var bytes: [UInt8] {
            switch self {
            case let .control(byte): return [byte]
            case let .protected(frame): return frame
            }
        }
        var isProtected: Bool {
            if case .protected = self { return true }
            return false
        }
    }
    private var outbox: [(epoch: Int, item: Outgoing)] = []
    /// The epoch whose wire drain is owned right now, or nil when it is free.
    private var wireOwner: Int?

    private var notices: [LinkTextDriverEvent] = []
    private var noticing = false
    /// The last status an owner was told about, so a transition is reported once.
    private var lastStatus: LinkTextStatus

    private enum TimerKey: Hashable {
        case consent
        case endAck
        /// The head of the outbox is a protected frame parked above the
        /// high-water mark.
        case drainPoll(epoch: Int)
        /// A sealed frame reached the transport and has not been observed to
        /// leave it.
        case flushPoll(epoch: Int)
    }
    /// A timer's identity is its TOKEN, not its key: a re-armed poll occupies the
    /// same key, and a real cancelled callback that had already started running
    /// would otherwise find its successor's entry and act on it.
    private var timers: [TimerKey: (token: Int, handle: LinkRecoveryTimer)] = [:]
    private var nextTimerToken = 1

    // MARK: - init

    /// - Parameters:
    ///   - identity: the link's ONE authenticated identity. Its `codecs` are the
    ///     only codecs this driver ever uses, and the session is built from them
    ///     HERE — there is deliberately no initializer that accepts a session, a
    ///     codec pair or a key, because a second text sender under a key that has
    ///     already been used restarts an AES-GCM nonce at zero.
    ///   - transport: the live transport the text lane is on right now. Unlike
    ///     `LinkFileDriver`, this may be constructed from anywhere: it installs
    ///     no callback on the transport at all.
    ///   - maxFrameBytes: what the CONNECTION negotiated.
    public convenience init(identity: LinkIdentity,
                            transport: LinkLiveTransport,
                            scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
                            maxFrameBytes: Double = DEFAULT_MAX_FRAME_BYTES,
                            sendBufferHighWater: UInt64 = LINK_TEXT_SEND_HIGH_WATER,
                            sendBufferPollInterval: TimeInterval = 0.05,
                            onEvent: @escaping (LinkTextDriverEvent) -> Void) {
        self.init(identity: identity, transport: transport, scheduler: scheduler,
                  maxFrameBytes: maxFrameBytes, sendBufferHighWater: sendBufferHighWater,
                  sendBufferPollInterval: sendBufferPollInterval,
                  now: { Date().timeIntervalSince1970 }, onEvent: onEvent)
    }

    /// The same construction with the lane's rate-bucket clock exposed.
    ///
    /// Internal, so a test can state a flood rule without waiting in real time.
    /// It still takes no session and no codecs.
    init(identity: LinkIdentity,
         transport: LinkLiveTransport,
         scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
         maxFrameBytes: Double = DEFAULT_MAX_FRAME_BYTES,
         sendBufferHighWater: UInt64 = LINK_TEXT_SEND_HIGH_WATER,
         sendBufferPollInterval: TimeInterval = 0.05,
         now: @escaping () -> TimeInterval,
         onEvent: @escaping (LinkTextDriverEvent) -> Void) {
        self.identity = identity
        self.session = LinkTextSession(identity: identity, now: now)
        self.scheduler = scheduler
        self.maxFrameBytes = maxFrameBytes
        self.sendBufferHighWater = sendBufferHighWater
        self.sendBufferPollInterval = sendBufferPollInterval
        self.onEvent = onEvent
        self.lastStatus = .idle
        self.transport = transport
        self.currentToken = ObjectIdentifier(transport)
        self.epoch = 1
        // Deliberately nothing else. `transport.onFrame` is not this driver's.
    }

    // MARK: - the two drains
    //
    // Both are entered with NO lock held, and both take and release `state`
    // around each individual step.

    @discardableResult
    private func withState<T>(_ body: () -> T) -> T {
        state.lock()
        let result = body()
        state.unlock()
        flush()
        return result
    }

    private func flush() {
        drainWire(owning: nil)
        drainNotices()
    }

    /// Put queued items on the wire, in order, one at a time, with the lock
    /// released across every transport call.
    ///
    /// The head is PEEKED rather than popped while its buffer question is asked,
    /// which is what makes residual backpressure a park rather than a loss: a
    /// sealed frame above the high-water mark stays exactly where it is, and the
    /// END behind it stays behind it.
    ///
    /// - Parameter claimed: the epoch this thread has already claimed. Only
    ///   `onAttach` passes one, because only an attach can claim an epoch nobody
    ///   has ever drained.
    private func drainWire(owning claimed: Int?) {
        var mine = claimed
        while true {
            var item: Outgoing?
            var live: LinkLiveTransport?

            state.lock()
            if mine == nil, wireOwner == nil {
                wireOwner = epoch
                mine = epoch
            }
            guard let owned = mine, wireOwner == owned, epoch == owned else {
                releaseWireLocked(mine)
                state.unlock()
                return
            }
            // A frame queued for a transport that is gone reaches nobody.
            outbox.removeAll { $0.epoch != owned }
            guard !textTerminal, !linkEnded, !textTransportClosing,
                  let head = outbox.first, let current = transport else {
                releaseWireLocked(mine)
                state.unlock()
                return
            }
            if head.item.isProtected {
                state.unlock()
                // OFF the lock: this enters the transport's own serial queue.
                let buffered = current.bufferedAmount(on: .text)
                state.lock()
                guard wireOwner == owned, epoch == owned, !textTerminal, !linkEnded,
                      !textTransportClosing, let still = outbox.first, still.item.isProtected,
                      let target = transport, target === current else {
                    state.unlock()
                    continue
                }
                if buffered > sendBufferHighWater {
                    // Parked IN PLACE. Nothing is dropped, resealed or reordered
                    // — the nonce is spent, so the only correct move is to wait.
                    armDrainPollLocked(epoch: owned)
                    releaseWireLocked(mine)
                    state.unlock()
                    return
                }
            }
            item = outbox.removeFirst().item
            live = current
            state.unlock()

            guard let outgoing = item, let target = live else { continue }
            do {
                try target.send(outgoing.bytes, on: .text)
            } catch {
                reportSendFailure(outgoing, epoch: owned, mine: mine)
                return
            }
            if outgoing.isProtected { observeFlush(on: target, epoch: owned) }
        }
    }

    /// One item could not be written. Which item it was decides everything.
    private func reportSendFailure(_ item: Outgoing, epoch owned: Int, mine: Int?) {
        var toClose: LinkLiveTransport?
        state.lock()
        if epoch == owned {
            switch item {
            case .protected:
                // The nonce is spent and the peer will never see the frame, so
                // no replacement channel can repair the sequence. Only the TEXT
                // lane dies: the transport stays current and the file lane on it
                // is untouched.
                failTextClosedLocked(.protectedSendFailed)
            case .control:
                // A control consumes no nonce, so this poisons nothing. The
                // channel is not usable, though, and the honest move is to close
                // the transport and let the recovery coordinator make its ONE
                // policy call — NOT to call `transportGap` here, which would
                // spend the lane's suspend before anything asked for it. The
                // queue behind this control is kept: only a real gap may decide
                // that a sealed frame in it fails the lane closed.
                textTransportClosing = true
                toClose = transport
            }
        }
        releaseWireLocked(mine)
        state.unlock()
        // NEVER under the lock.
        toClose?.close()
        drainNotices()
    }

    /// Did the frame just written actually leave the channel?
    ///
    /// Runs with no lock held. Only an observation of a ZERO buffer, on a
    /// transport that is still open, with no protected item left locally, may
    /// clear the conservative answer — anything else arms a correlated poll and
    /// leaves it true.
    private func observeFlush(on target: LinkLiveTransport, epoch owned: Int) {
        let buffered = target.bufferedAmount(on: .text)
        let closed = target.isClosed
        state.lock()
        defer { state.unlock() }
        guard epoch == owned, !textTerminal, !linkEnded, protectedUnflushed else { return }
        guard buffered == 0, !closed, !outboxHasProtectedLocked() else {
            armFlushPollLocked(epoch: owned)
            return
        }
        cancel(.flushPoll(epoch: owned))
        session.didFlushSendBuffer()
        protectedUnflushed = false
    }

    private func releaseWireLocked(_ mine: Int?) {
        guard let mine, wireOwner == mine else { return }
        wireOwner = nil
        outbox.removeAll { $0.epoch != epoch }
    }

    private func outboxHasProtectedLocked() -> Bool { outbox.contains { $0.item.isProtected } }

    /// Deliver owner callbacks, in order, with no lock held.
    ///
    /// Single-consumer: a thread that finds delivery already in progress leaves
    /// its notice for the current deliverer, so a callback that re-enters this
    /// driver cannot recurse into a second delivery and cannot reorder anything.
    private func drainNotices() {
        while true {
            state.lock()
            guard !noticing, !notices.isEmpty else { state.unlock(); return }
            noticing = true
            let batch = notices
            notices.removeAll()
            state.unlock()
            for event in batch { onEvent(event) }
            state.lock()
            noticing = false
            state.unlock()
        }
    }

    private func emitLocked(_ event: LinkTextDriverEvent) { notices.append(event) }

    private func enqueueWireLocked(_ item: Outgoing) -> Bool {
        // A terminal lane writes nothing more, and a gap has nowhere to write.
        // `textTransportClosing` deliberately does NOT refuse here: the item is
        // kept so a later gap can see it.
        guard !textTerminal, !linkEnded, transport != nil else { return false }
        outbox.append((epoch: epoch, item: item))
        return true
    }

    // MARK: - what an owner may call

    /// Ask the peer for a conversation.
    public func open() throws { try apply { session.localOpen() } }
    /// Consent to the peer's request.
    public func accept() throws { try apply { session.localAccept() } }
    /// Refuse the peer's request.
    public func reject() throws { try apply { session.localReject() } }
    /// End the current conversation. An ordering BARRIER, not a hangup: frames
    /// already in flight keep being authenticated until the peer's own marker.
    public func end() throws { try apply { session.localEnd() } }

    private func apply(_ call: () -> [LinkTextSessionEffect]) throws {
        state.lock()
        if let refusal = terminalRefusalLocked() {
            state.unlock()
            throw refusal
        }
        // Refused BEFORE the session moves. Every one of these calls exists to
        // put a lifecycle control on the wire, and the lane has no notion of a
        // channel: `localOpen` in a gap would happily move to `waitingAccept`
        // and arm a ten-minute consent window for a REQUEST that reaches nobody,
        // leaving the user watching a prompt no peer was ever shown.
        guard transport != nil, !textTransportClosing else {
            state.unlock()
            throw LinkTextDriverError.transportUnavailable
        }
        applyLocked(call)
        state.unlock()
        flush()
    }

    private func terminalRefusalLocked() -> LinkTextDriverError? {
        if linkEnded { return .linkEnded }
        if textTerminal { return .laneTerminal }
        return nil
    }

    /// Seal and queue one message for the open conversation.
    ///
    /// ## What `sendGate` covers, and what it deliberately does not
    ///
    /// The gate covers the SEALING alone — the one step that consumes the link's
    /// sender nonce — so two concurrent messages cannot put their sequence
    /// numbers on the wire out of order. Under it this driver touches nothing but
    /// `state`.
    ///
    /// The pre-seal backpressure probe runs BEFORE the gate is taken, because it
    /// enters the transport's own serial queue and that queue is where inbound
    /// frames are delivered from. A probe under the gate would wait for a queue
    /// whose current work may be an owner's `received` callback replying into
    /// this same driver and waiting for the gate — a cycle nothing here could
    /// break. **No transport method may execute while `sendGate` is held.**
    ///
    /// Two senders may therefore probe the same buffer concurrently, which costs
    /// nothing: the probe is read-only, it consumes no nonce, and everything it
    /// observed — the transport object and its epoch — is re-proven under `state`
    /// once the gate is held. If the buffer rose in between, the frame is already
    /// sealed and the drain parks it in place rather than dropping it.
    ///
    /// A refusal here costs nothing either: `throws .backpressured` and the next
    /// message still gets sequence n.
    public func send(_ body: String) throws {
        let outcome = probeSealAndQueue(body)
        // On EVERY exit, refusal included, and with the gate already released:
        // every public entry point on this driver flushes on its way out.
        flush()
        if let error = outcome { throw error }
    }

    /// - Returns: the refusal, or nil when the message was sealed and queued.
    private func probeSealAndQueue(_ body: String) -> LinkTextDriverError? {
        // With NEITHER lock held. `current` is only a candidate at this point;
        // the gated seal below is what decides whether it is still the one.
        state.lock()
        if let refusal = terminalRefusalLocked() { state.unlock(); return refusal }
        guard let current = transport, !textTransportClosing else {
            state.unlock()
            return .transportUnavailable
        }
        let mine = epoch
        state.unlock()

        // Before the sender is touched, and before the gate is taken.
        let buffered = current.bufferedAmount(on: .text)
        guard buffered <= sendBufferHighWater else { return .backpressured }

        sendGate.lock()
        defer { sendGate.unlock() }
        return sealAndQueue(body, probed: current, epoch: mine)
    }

    /// The nonce-consuming half, under `sendGate` and touching no transport.
    ///
    /// - Parameters:
    ///   - probed: the transport the caller's backpressure probe was asked of.
    ///   - mine: the epoch that transport belonged to when it was captured.
    /// - Returns: the refusal, or nil when the message was sealed and queued.
    private func sealAndQueue(_ body: String, probed: LinkLiveTransport,
                              epoch mine: Int) -> LinkTextDriverError? {
        state.lock()
        defer { state.unlock() }
        // Everything observed before the gate is re-proven here: the transport
        // may have been replaced, the lane may have failed and the conversation
        // may have ended while the buffer was being read or the gate waited for.
        if let refusal = terminalRefusalLocked() { return refusal }
        guard epoch == mine, let live = transport, live === probed, !textTransportClosing else {
            return .transportUnavailable
        }
        let effects: [LinkTextSessionEffect]
        do {
            effects = try session.send(body, maxFrameBytes: maxFrameBytes)
        } catch let error as LinkTextSessionError {
            return .refused(error)
        } catch {
            return .refused(.laneFailed)
        }
        let sealed = effects.contains { if case .sendProtected = $0 { return true } else { return false } }
        runEffectsLocked(effects)
        noteStatusLocked()
        // A sender refusal that is a property of the SENDER does not throw: it
        // fails the lane closed and returns terminal effects with no frame in
        // them. Nothing crossed the wire, so the caller is owed a refusal too.
        guard sealed else { return .laneTerminal }
        return nil
    }

    /// Route one raw frame off the TEXT lane.
    ///
    /// The ONLY inbound seam, and it is explicit on purpose: this driver installs
    /// no route, so a frame reaches it because an owner that demuxed the whole
    /// transport decided this one is text.
    ///
    /// Inbound malformed, authentication, ordering and rate failures poison the
    /// TEXT codecs and nothing else — never the transport, never the file lane.
    public func admitTextFrame(_ bytes: [UInt8]) {
        withState {
            guard !linkEnded, !textTerminal, transport != nil else { return }
            applyLocked { session.admitFrame(bytes) }
        }
    }

    // MARK: - transport generations

    /// The exact `LinkRecoveryCoordinator.onTransportLost` policy seam, for the
    /// TEXT lane alone.
    ///
    /// The order inside it is the whole contract. The local outbox and the
    /// unflushed answer are inspected BEFORE anything is cleared, because
    /// clearing first is precisely how a driver loses the evidence that a sealed
    /// frame never left. And `bufferedBytes: 0` is passed deliberately: the
    /// coordinator has already closed and removed the channels, so the
    /// transport's own number is not evidence of anything.
    public func onTransportLost(_ ready: LinkIdentity) -> Bool {
        // A recovery policy is asked about ONE link. Suspending this
        // conversation because a different link lost its transport would end a
        // perfectly live one.
        guard identityMatches(ready) else { return false }
        return withState { beginGapLocked() }
    }

    private func beginGapLocked() -> Bool {
        // Inspected FIRST, while the evidence still exists.
        let unflushed = protectedUnflushed || outboxHasProtectedLocked()

        epoch += 1
        transport = nil
        currentToken = nil
        textTransportClosing = false
        outbox.removeAll()
        cancelPollsLocked()

        guard !textTerminal, !linkEnded else { return false }
        if unflushed {
            // A frame whose nonce is spent and whose bytes cannot be proven to
            // have left. `failClosed` withdraws this lane's claim on the link's
            // recovery window, so the answer below is false — a lane that is over
            // has nothing a replacement could restore.
            failTextClosedLocked(.protectedSendFailed)
            return session.needsRecovery
        }
        applyLocked { session.transportGap(bufferedBytes: 0).effects }
        // The STICKY intent, read separately from the idempotent gap call: a
        // second report of the same failure suspends nothing and must not be
        // read as "nothing to recover". See `LinkTextLane.needsRecovery`.
        return session.needsRecovery
    }

    /// The exact `LinkRecoveryCoordinator.onAttach` seam.
    ///
    /// Synchronous by contract, and it deliberately does three things it could
    /// be tempted to do more of: it proves the identity, it swaps the transport
    /// and it tells the session. It never constructs codecs, never installs a
    /// route on the replacement, and never replays a byte of text — consent was
    /// given on a transport that no longer exists, and re-sending it would be
    /// this side answering a prompt the user never saw again.
    ///
    /// A terminal text lane attaches WITHOUT taking anything over and stays
    /// terminal.
    public func onAttach(_ ready: LinkIdentity, _ replacement: LinkReplacementTransport) throws {
        // Identity first, and with no lock at all: `identity` is immutable, and
        // the `LinkCodecs` object itself is compared by identity because equal
        // contents would be exactly the catastrophe.
        guard identityMatches(ready) else { throw LinkTextDriverError.identityMismatch }
        // The coordinator's own protocol cannot send, deliberately. The driver
        // composes it with the live seam here, at its own boundary.
        guard let live = replacement as? LinkLiveTransport else {
            throw LinkTextDriverError.replacementNotLive
        }

        state.lock()
        guard !linkEnded else {
            state.unlock()
            throw LinkTextDriverError.linkEnded
        }
        // The swap and the drain claim are ONE step: a brand-new epoch has never
        // been drained by anybody, so claiming it here cannot contend with the
        // drainer of the epoch that just died.
        epoch += 1
        let mine = epoch
        outbox.removeAll()
        cancelPollsLocked()
        textTransportClosing = false
        transport = live
        currentToken = ObjectIdentifier(live)
        wireOwner = mine
        // Unreachable in the coordinator's ordering — a gap with unflushed work
        // has already failed this lane closed — but an attach is a publication
        // barrier, and guessing on the safe side costs nothing.
        if protectedUnflushed, !textTerminal { failTextClosedLocked(.protectedSendFailed) }
        if !textTerminal { applyLocked { session.didAttachReplacementTransport() } }
        protectedUnflushed = false
        state.unlock()

        drainWire(owning: mine)
        drainNotices()
    }

    /// The exact `LinkRecoveryCoordinator.onEnded` seam. The held link is over,
    /// so this is terminal for routing in both directions.
    public func onEnded(_ error: Error) {
        withState {
            guard !linkEnded else { return }
            linkEnded = true
            epoch += 1
            transport = nil
            currentToken = nil
            textTransportClosing = false
            outbox.removeAll()
            cancelPollsLocked()
            // At most ONE terminal report: a lane that already failed closed has
            // told its owner, and a link ending afterwards is not a second loss.
            if !textTerminal { failTextClosedLocked(.linkEnded) }
        }
    }

    private func identityMatches(_ ready: LinkIdentity) -> Bool {
        ready.peerId == identity.peerId
            && ready.role == identity.role
            && ready.sas == identity.sas
            && ready.authenticationGeneration == identity.authenticationGeneration
            && ready.codecs === identity.codecs
    }

    // MARK: - the effect executor

    private func applyLocked(_ call: () -> [LinkTextSessionEffect]) {
        runEffectsLocked(call())
        noteStatusLocked()
    }

    /// Interpret every effect in order. Nothing here calls a transport or an
    /// owner: the two queues are what carry those out, after the lock is gone.
    private func runEffectsLocked(_ effects: [LinkTextSessionEffect]) {
        for effect in effects {
            switch effect {
            case let .sendControl(byte):
                _ = enqueueWireLocked(.control(byte))
            case let .sendProtected(frame):
                // The nonce is spent from the moment `session.send` returned, so
                // this is recorded BEFORE the frame can leave `state` — which is
                // what a gap consults when the transport's own buffer cannot be
                // trusted.
                protectedUnflushed = true
                guard enqueueWireLocked(.protected(frame)) else {
                    // Nowhere to write a frame whose sequence the peer is already
                    // expecting. Unreachable while the session gates sending on an
                    // open conversation, and terminal if it ever is not.
                    failTextClosedLocked(.protectedSendFailed)
                    return
                }
            case .armConsentTimeout:
                arm(.consent, after: LINK_TEXT_CONSENT_TIMEOUT) { [weak self] token in
                    self?.timerFired(.consent, token) { self?.session.consentTimedOut() ?? [] }
                }
            case .cancelConsentTimeout:
                cancel(.consent)
            case .armEndAckTimeout:
                arm(.endAck, after: LINK_TEXT_END_ACK_TIMEOUT) { [weak self] token in
                    self?.timerFired(.endAck, token) { self?.session.endAckTimedOut() ?? [] }
                }
            case .cancelEndAckTimeout:
                cancel(.endAck)
            case let .received(body):
                emitLocked(.received(body))
            case .poisonCodecs:
                continue   // the close below is the effect that acts
            case .closeLane:
                failTextLocked(.laneTerminal)
            }
        }
    }

    private func noteStatusLocked() {
        let current = session.status
        guard current != lastStatus else { return }
        lastStatus = current
        emitLocked(.status(current))
    }

    // MARK: - timers
    //
    // Scheduling and cancelling under the lock is deliberate and matches
    // `LinkFileDriver`: a scheduler hands back a handle and never calls out, so
    // neither can block or re-enter. The prohibition is on transport calls and
    // owner callbacks.

    private func arm(_ key: TimerKey, after delay: TimeInterval, _ body: @escaping (Int) -> Void) {
        timers[key]?.handle.cancel()
        let token = nextTimerToken
        nextTimerToken += 1
        timers[key] = (token: token, handle: scheduler.schedule(after: delay) { body(token) })
    }

    private func cancel(_ key: TimerKey) {
        timers[key]?.handle.cancel()
        timers[key] = nil
    }

    /// Take back the polls this driver armed for a generation that is over.
    ///
    /// The keys are snapshotted into an array first, because `cancel` mutates
    /// `timers` — iterating the live view while writing to it is the kind of
    /// thing that works until the day it does not. The two CONSENT/END-ACK
    /// timers are deliberately left alone: those are the session's, and it emits
    /// its own cancellations as effects of the gap.
    private func cancelPollsLocked() {
        for key in Array(timers.keys) {
            switch key {
            case .drainPoll, .flushPoll: cancel(key)
            case .consent, .endAck: continue
            }
        }
    }

    /// A wake-up acts only if the handle it belongs to is still the live one.
    private func timerFired(_ key: TimerKey, _ token: Int,
                            _ body: @escaping () -> [LinkTextSessionEffect]) {
        withState {
            guard !textTerminal, !linkEnded, timers[key]?.token == token else { return }
            timers[key] = nil
            applyLocked(body)
        }
    }

    private func armDrainPollLocked(epoch owned: Int) {
        let key = TimerKey.drainPoll(epoch: owned)
        arm(key, after: sendBufferPollInterval) { [weak self] token in
            guard let self else { return }
            self.withState {
                guard self.timers[key]?.token == token else { return }
                self.timers[key] = nil
                // `withState` flushes on the way out, and the drain re-asks the
                // buffer question itself.
            }
        }
    }

    private func armFlushPollLocked(epoch owned: Int) {
        let key = TimerKey.flushPoll(epoch: owned)
        arm(key, after: sendBufferPollInterval) { [weak self] token in
            self?.pollFlush(key: key, epoch: owned, token: token)
        }
    }

    private func pollFlush(key: TimerKey, epoch owned: Int, token: Int) {
        var live: LinkLiveTransport?
        state.lock()
        if timers[key]?.token == token { timers[key] = nil }
        else { state.unlock(); return }
        guard epoch == owned, !textTerminal, !linkEnded, protectedUnflushed,
              !textTransportClosing, let current = transport else {
            state.unlock()
            return
        }
        live = current
        state.unlock()

        guard let target = live else { return }
        observeFlush(on: target, epoch: owned)
        drainNotices()
    }

    // MARK: - terminal

    /// End the TEXT lane from the driver's own side, telling the session first.
    ///
    /// The session's seam is what retires the lane's state — disarming its
    /// timers, dropping its drains and poisoning its codecs — so a driver that
    /// kept a private terminal flag while the session still looked live would be
    /// two answers to one question.
    private func failTextClosedLocked(_ error: LinkTextDriverError) {
        guard !textTerminal else { return }
        // Read back by `failTextLocked`, which the `closeLane` below re-enters:
        // the lane's own answer is "the lane closed", and this is what the
        // DRIVER knows about why.
        pendingFailure = error
        runEffectsLocked(session.protectedSendFailed())
        // A lane that was already poisoned returns nothing, so the transition is
        // made here instead.
        if !textTerminal { failTextLocked(error) }
        pendingFailure = nil
    }

    /// The one terminal transition for this lane.
    ///
    /// Deliberately does NOT touch the transport: neither concrete transport can
    /// close one data channel independently, so a failed text lane is expressed
    /// as "no further text frame is routed or written" rather than as a closed
    /// channel — and the file lane on the same transport goes on.
    private func failTextLocked(_ fallback: LinkTextDriverError) {
        guard !textTerminal else { return }
        // FIRST: the effects below re-enter here and must find it already made.
        textTerminal = true
        let error = pendingFailure ?? fallback
        pendingFailure = nil

        for timer in timers.values { timer.handle.cancel() }
        timers = [:]
        outbox.removeAll()
        protectedUnflushed = false

        // The status the lane reached on its way out, then the one report.
        noteStatusLocked()
        guard !terminalEmitted else { return }
        terminalEmitted = true
        emitLocked(.failed(error))
    }

    // MARK: - what a test or an owner above may read

    public var status: LinkTextStatus { state.lock(); defer { state.unlock() }; return session.status }
    /// The TEXT lane is terminal. Says nothing about the link, which may still be
    /// carrying a file transfer on the same transport.
    public var isTerminal: Bool { state.lock(); defer { state.unlock() }; return textTerminal }
    /// The held link ended. Nothing routes in this lane or any other.
    public var isLinkEnded: Bool { state.lock(); defer { state.unlock() }; return linkEnded }
    /// The sticky claim this lane has on the link's recovery window.
    public var needsRecovery: Bool {
        state.lock(); defer { state.unlock() }; return session.needsRecovery
    }
    public var conversationCount: Int {
        state.lock(); defer { state.unlock() }; return session.conversationCount
    }

    /// Barrier: let everything already queued out, with no lock held.
    ///
    /// Internal, and it exists so a test can be deterministic about work this
    /// driver deliberately does off its own lock. Production never needs it: every
    /// public entry point flushes on its way out.
    func settle() { flush() }

    /// How many sealed frames are still LOCAL. The number a gap consults, and the
    /// one a residual-parking test has to be able to see.
    var queuedProtectedCount: Int {
        state.lock(); defer { state.unlock() }
        return outbox.filter { $0.item.isProtected }.count
    }
    var queuedFrameCount: Int { state.lock(); defer { state.unlock() }; return outbox.count }
    /// A sealed frame exists that this driver has not proven left the channel.
    var hasUnflushedProtected: Bool {
        state.lock(); defer { state.unlock() }; return protectedUnflushed
    }
    /// A control could not be written, so this generation's channel is unusable.
    var isTextTransportClosing: Bool {
        state.lock(); defer { state.unlock() }; return textTransportClosing
    }
}
