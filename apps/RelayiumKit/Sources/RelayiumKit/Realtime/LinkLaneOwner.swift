import Foundation

/// Why an operation on the whole link — rather than on one of its lanes — could
/// not go on.
///
/// Deliberately small, and every case is one only THIS object can answer.
/// Anything a single lane can refuse for itself stays that lane's refusal —
/// `LinkTextDriverError.identityMismatch`, `LinkFileDriverError.sendFailed` —
/// because re-wrapping those would hide which lane answered.
///
/// ## The two lifecycle refusals, and how they differ
///
/// `transportUnavailable` is **retryable**: the link is between transports right
/// now, nothing has been spent, and the same call is accepted again once a
/// replacement attaches. `linkEnded` is **terminal**: the held link is over, and
/// no later call on this owner will be accepted.
///
/// Both are refusals the OWNER made, before either lane was reached, and that is
/// the whole reason they are not a driver's error. See `onTransportLost` for
/// what the window is and why a lane's own answer arrives too late in it.
public enum LinkLaneOwnerError: Error, Equatable, Sendable {
    /// A coordinator holding a different link's authentication.
    case foreignCoordinator
    /// The link is between transports: a gap is being reported to the lanes, or
    /// a replacement is being attached to them. **Retryable** — nothing was
    /// sealed, queued or spent, and the operation may simply be made again.
    case transportUnavailable
    /// The held link is ending or has ended, and both lanes go with it.
    /// **Terminal.**
    case linkEnded
}

/// The composition and lifetime boundary for ONE authenticated `link/1`: a text
/// driver and a file driver over one identity, one transport, and one route
/// between them.
///
/// ## What it is for
///
/// `LinkTextDriver` and `LinkFileDriver` are each complete, and neither can be
/// used on its own. The file driver installs the initial transport's `onFrame`
/// and hands text frames straight out through a callback it cannot supply a
/// destination for; the text driver installs no route at all and reaches its
/// session only through `admitTextFrame`. The recovery coordinator, meanwhile,
/// has exactly one set of four owner hooks and one `onFrame` slot, so a link
/// with two lanes needs something to answer for both. This is that something,
/// and it is deliberately nothing else: it owns no UI, no admission, no
/// factory, no picker and no filesystem.
///
/// ## The invariants it exists to make structural
///
/// **1. One identity, therefore one `LinkCodecs`.** Both drivers are built here
/// from the SAME `LinkIdentity` value, and there is no initializer that takes a
/// session, a codec pair, a key or two identities. Two lanes on two `LinkCodecs`
/// would be two AEAD sequences counting from zero under one pair of session
/// keys, which is the catastrophe the whole feature is arranged around.
///
/// **2. One route.** The file driver's initializer installs the initial
/// transport's `onFrame` as its last act, and that stays the SOLE installation.
/// The text lane is reached from inside it, through `onTextFrame`. Two owners
/// racing for one unsynchronised slot is not a policy question, it is a lost
/// lane — see `LinkLiveTransport`.
///
/// **3. Neither lane may speak for the other.** The gap policy calls both hooks
/// on EVERY report and returns their logical or; the terminal path calls both
/// every time. A short-circuited `||` there would leave one lane unsuspended on
/// a transport that is gone — which is exactly how a live conversation ends
/// because the file lane happened to be idle.
///
/// **4. A lane-local terminal is local.** A file lane that failed closed leaves
/// the conversation on the same transport running, and a text lane whose codecs
/// are spent leaves the transfer running. Nothing here composes the two failure
/// states into one.
///
/// **5. A lifecycle transition reaches the whole link before either lane can
/// report it.** Telling ONE lane that its transport is gone runs that lane's
/// owner callbacks before the other lane has been told anything, and the
/// coordinator has already CLOSED the dying transport by then. An owner
/// answering such a callback by driving the other lane would therefore be
/// driving it into a channel that can no longer take a byte — spending a lane
/// that a gap exists to suspend. The gate below closes that window for both
/// lanes at once, which is a thing only this object can do: neither driver can
/// see the other's report. See `onTransportLost`.
///
/// ## Threading
///
/// **One lock, `gate`, and it protects two words that no driver, transport or
/// callback can see.** It is taken to read or write a decision and released
/// before anything is called — there is no path from under it to a driver, a
/// coordinator, a transport, a destination, a producer, the scheduler or an
/// owner callback, and it is never held across `text` or `file`. So it is a LEAF
/// in the lock order — nothing is ever acquired under it and nothing is ever
/// called under it — but a leaf is not the same as an UNNESTED lock, and this
/// one is nested.
///
/// **The order is coordinator → `gate`.** `LinkRecoveryCoordinator` runs the
/// four owner hooks UNDER its own lock, and those hooks are exactly where
/// `beginTransition` and `endTransition` are called, so a lifecycle transition
/// takes `gate` with the coordinator's lock held. It is released again before
/// the first driver call, so what is nested beneath that lock is the two-word
/// state update and nothing else. The coordinator → driver order the coordinator
/// documents is unchanged; this lock sits below the coordinator's rather than
/// beside it.
///
/// **With a driver's lock `gate` is never nested at all, in either direction.**
/// The hooks above and the owner facade below each release it before reaching
/// `text` or `file`, and an owner callback that re-enters this object comes from a
/// driver's drain with that driver's own state lock already released — which is
/// what each driver documents. So there is no path on which either waits for the
/// other.
///
/// Re-entrancy therefore behaves exactly as each driver documents it, with one
/// addition. An owner callback delivered from a driver's drain may call straight
/// back into this object on the same thread; if it does so while a lifecycle
/// transition is in flight, it is refused HERE, before the other lane's seam is
/// reached. Otherwise it reaches that seam, which is where the question was
/// always answered.
///
/// **What the gate guarantees, and what it does not.** It is a check-then-call,
/// so it guarantees an ORDERING rather than mutual exclusion: the flag is set
/// before the first driver hook is called and cleared after the last one
/// returns, so any call that begins after a transition began — above all a
/// re-entrant one, on the very thread delivering the transition, which is the
/// window this closes — observes it. A call on ANOTHER thread that had already
/// passed the gate when the transition began is not rewound, and cannot be
/// without holding this lock across a driver call. That residue is each driver's
/// own affair and was never this object's: both serialize their state under
/// their own lock, both refuse a send once they know the transport is gone, and
/// both treat a write that fails on a dying transport as their documented
/// lane-local terminal. What this removes is the window where the drivers had
/// not been told and so could not refuse anything.
///
/// ## Lifetime
///
/// `bind(to:)` makes the COORDINATOR this object's owner: the four hooks capture
/// `self` strongly, and this object holds no reference to the coordinator. That
/// is the same lifetime decision `LinkFileDriver.bind(to:)` records, moved up one
/// level so it is the whole link that cannot silently disappear behind a
/// publication barrier — `try self?.onAttach(…)` on a deallocated owner SUCCEEDS,
/// and a successful attach is precisely what makes a replacement current. It is
/// an owner relationship and not a cycle, so both go together when whatever
/// holds the coordinator lets go.
///
/// ## What it is not
///
/// Unreachable from production. `LINK_BUILD_SUPPORT` and
/// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still false, nothing
/// constructs one, and the file lane's destination factory is still the later
/// `RelayiumAppKit` work (see `LinkFileDestination`). What this closes is the
/// hole `LinkRecovery` names: the thing that supplies the text lane's recovery
/// answer, which `LinkFileDriver` could not and did not try to.
public final class LinkLaneOwner: @unchecked Sendable {

    // `@unchecked Sendable` is earned property by property:
    //
    //  - `identity`, `text` and `file` are immutable after `init`, and both
    //    drivers are themselves `@unchecked Sendable` with the invariants they
    //    document.
    //  - `transitions` and `ending` are the ONLY mutable state, and every read
    //    and every write of both is made with `gate` held.
    //  - `gate` is never held across a call to anything: not a driver, not the
    //    coordinator, not a transport, destination, producer or scheduler, and
    //    not an owner callback. Every use below takes it, decides, and releases
    //    it before acting on the decision. That is one-directional: the
    //    coordinator's lock IS held across the hooks that take `gate`.

    /// The link's ONE authenticated identity, and with it the one `LinkCodecs`.
    /// Both lanes were built from this exact value.
    public let identity: LinkIdentity

    // MARK: - the lifecycle gate

    /// Guards `transitions` and `ending`, and nothing else. A leaf — nothing is
    /// ever acquired or called under it — but taken UNDER the coordinator's lock
    /// during a lifecycle transition. See this type's "Threading" section.
    private let gate = NSLock()

    /// How many lifecycle transitions — a gap, an attach, an end — are being
    /// delivered to the lanes right now.
    ///
    /// A COUNT rather than a flag because these genuinely nest: a coordinator
    /// hook is arbitrary owner code, and an owner that answers a gap callback by
    /// ending the link puts a terminal transition on top of the gap that is
    /// still unwinding. A flag would let the inner one's exit reopen the gate
    /// while the outer transition still has a lane to tell.
    private var transitions = 0

    /// A TERMINAL transition has begun. Sticky, because the link ending is: once
    /// it is true, a later transition's refusal is `linkEnded` rather than a
    /// retryable `transportUnavailable`.
    private var ending = false

    /// Take the gate for one lifecycle transition. Paired with `endTransition`
    /// through `defer`, so a throwing `onAttach` cannot leave it closed.
    private func beginTransition(terminal: Bool) {
        gate.lock()
        transitions += 1
        if terminal { ending = true }
        gate.unlock()
    }

    private func endTransition() {
        gate.lock()
        transitions -= 1
        gate.unlock()
    }

    /// Why an owner-facade call made right now must be refused, or nil to let it
    /// through to its lane.
    ///
    /// Only while a transition is in flight. Once it has finished, both lanes
    /// know their own state and answer for themselves — a text lane in a gap
    /// throws `LinkTextDriverError.transportUnavailable`, an ended one throws
    /// `.linkEnded`, and the file lane accepts a batch that waits for the
    /// replacement it has a whole resume protocol for. Refusing on this object's
    /// behalf after that point would be a second opinion about a question the
    /// lanes already answer better.
    private func lifecycleRefusal() -> LinkLaneOwnerError? {
        gate.lock()
        defer { gate.unlock() }
        guard transitions > 0 else { return nil }
        return ending ? .linkEnded : .transportUnavailable
    }

    /// An owner-facade call that reports its refusal.
    private func gated<T>(_ body: () throws -> T) throws -> T {
        if let refusal = lifecycleRefusal() { throw refusal }
        return try body()
    }

    /// An owner-facade action that cannot report anything, so its refusal has to
    /// BE the absence of the action.
    private func inert(_ body: () -> Void) {
        guard lifecycleRefusal() == nil else { return }
        body()
    }

    /// The two lanes. Internal rather than public: the coordinator seams below
    /// are the owner's to answer, and a caller that reached past this object to
    /// `LinkFileDriver.bind(to:)` or `LinkTextDriver.onAttach` would be putting
    /// half a link on a replacement. Tests see them through `@testable`.
    let text: LinkTextDriver
    let file: LinkFileDriver

    // MARK: - init

    /// Build both lanes over one identity and one transport.
    ///
    /// - Parameters:
    ///   - identity: the link's one authenticated identity. Used for BOTH lanes,
    ///     which is what makes a codec mismatch between them unrepresentable.
    ///   - transport: the live transport the lanes are on right now. **Construct
    ///     this owner from that transport's `onReady`**, on the transport's own
    ///     publication queue: the file driver installs the frame route as its
    ///     last initializer act, and `WebRTCLinkTransport` stores its callback
    ///     slots unsynchronised and replays nothing.
    ///   - maxFrameBytes: what the CONNECTION negotiated. One number for both
    ///     lanes, because it is a property of the channel rather than of a lane.
    ///   - onTextEvent: the conversation's events. `received` is the only place
    ///     plaintext leaves this object.
    ///   - onFileEvent: the transfer's events.
    public convenience init(identity: LinkIdentity,
                            transport: LinkLiveTransport,
                            scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
                            producerFactory: @escaping LinkFileProducerFactory
                                = { LinkFileRealtimeProducer($0) },
                            destinationFactory: @escaping LinkFileDestinationFactory,
                            maxFrameBytes: Double = DEFAULT_MAX_FRAME_BYTES,
                            onTextEvent: @escaping (LinkTextDriverEvent) -> Void,
                            onFileEvent: @escaping (LinkFileDriverEvent) -> Void) {
        self.init(identity: identity, transport: transport, scheduler: scheduler,
                  producerFactory: producerFactory, destinationFactory: destinationFactory,
                  window: FLOW_WINDOW, ackInterval: FLOW_ACK_INTERVAL,
                  maxFrameBytes: maxFrameBytes,
                  maxBufferedInboundBytes: FLOW_WINDOW * 2,
                  maxBufferedInboundFrames: 4096,
                  fileSendBufferHighWater: UInt64(FLOW_WINDOW),
                  textSendBufferHighWater: LINK_TEXT_SEND_HIGH_WATER,
                  sendBufferPollInterval: 0.05,
                  now: { Date().timeIntervalSince1970 },
                  onTextEvent: onTextEvent, onFileEvent: onFileEvent)
    }

    /// The same composition with each lane's flow-control constants and the text
    /// lane's rate-bucket clock exposed.
    ///
    /// Internal, because an ack interval and a poll cadence are tuning decisions
    /// a test needs to be able to make small, not public knobs. It deliberately
    /// still takes no session and no codecs: `identity.codecs` is the only codec
    /// pair any initializer here can reach, in either lane.
    init(identity: LinkIdentity,
         transport: LinkLiveTransport,
         scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
         producerFactory: @escaping LinkFileProducerFactory = { LinkFileRealtimeProducer($0) },
         destinationFactory: @escaping LinkFileDestinationFactory,
         window: Int = FLOW_WINDOW,
         ackInterval: Int = FLOW_ACK_INTERVAL,
         maxFrameBytes: Double = DEFAULT_MAX_FRAME_BYTES,
         maxBufferedInboundBytes: Int = FLOW_WINDOW * 2,
         maxBufferedInboundFrames: Int = 4096,
         fileSendBufferHighWater: UInt64 = UInt64(FLOW_WINDOW),
         textSendBufferHighWater: UInt64 = LINK_TEXT_SEND_HIGH_WATER,
         sendBufferPollInterval: TimeInterval = 0.05,
         now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 },
         onTextEvent: @escaping (LinkTextDriverEvent) -> Void,
         onFileEvent: @escaping (LinkFileDriverEvent) -> Void) {
        self.identity = identity

        // TEXT FIRST, and it installs nothing. The file driver's initializer
        // routes the transport as its last act, so the text lane has to be a
        // complete object by then — a frame can arrive on the very next line.
        let text = LinkTextDriver(identity: identity,
                                  transport: transport,
                                  scheduler: scheduler,
                                  maxFrameBytes: maxFrameBytes,
                                  sendBufferHighWater: textSendBufferHighWater,
                                  sendBufferPollInterval: sendBufferPollInterval,
                                  now: now,
                                  onEvent: onTextEvent)
        self.text = text

        // Then FILE, from the SAME identity and the SAME transport, and its
        // `onTextFrame` captures the text driver DIRECTLY rather than through
        // `self`. That is deliberate twice over: it cannot reference `self`
        // before every stored property exists, and capturing this object would
        // close a cycle — owner → file → closure → owner — that nothing would
        // ever break.
        self.file = LinkFileDriver(identity: identity,
                                   transport: transport,
                                   scheduler: scheduler,
                                   producerFactory: producerFactory,
                                   destinationFactory: destinationFactory,
                                   window: window,
                                   ackInterval: ackInterval,
                                   maxFrameBytes: maxFrameBytes,
                                   maxBufferedInboundBytes: maxBufferedInboundBytes,
                                   maxBufferedInboundFrames: maxBufferedInboundFrames,
                                   sendBufferHighWater: fileSendBufferHighWater,
                                   sendBufferPollInterval: sendBufferPollInterval,
                                   onTextFrame: { bytes in text.admitTextFrame(bytes) },
                                   onEvent: onFileEvent)
    }

    // MARK: - the recovery coordinator

    /// Install this owner's four hooks on a recovery coordinator, atomically,
    /// before anything can fire.
    ///
    /// Called with `gate` NOT held — no path here takes it — so this acquires the
    /// coordinator's lock with no lock of this object's outstanding. The hooks
    /// run the other way round: the coordinator invokes all four UNDER its own
    /// lock, and `beginTransition`/`endTransition` then take `gate` beneath it.
    /// So the one nesting in play is coordinator → `gate`, and this call adds no
    /// second one.
    ///
    /// ## Binding makes the coordinator this owner's OWNER
    ///
    /// The four closures capture `self` STRONGLY, and this object holds no
    /// reference to the coordinator, so the retain ends when the coordinator is
    /// released. A weakly-held owner would make `try self?.onAttach(…)` succeed
    /// once it is gone — the coordinator would then find its `onFrame` slot
    /// non-nil, publish the replacement, and replay the captured backlog into
    /// nothing. Those frames belong to receiver codecs whose sequence has to
    /// stay continuous, so that is the missing-owner failure the attach barrier
    /// exists to prevent, arriving as a silent success.
    public func bind(to coordinator: LinkRecoveryCoordinator) throws {
        guard identityMatches(coordinator.identity) else {
            throw LinkLaneOwnerError.foreignCoordinator
        }
        coordinator.installOwnerHooks(
            onTransportLost: { ready in self.onTransportLost(ready) },
            onAttach: { ready, replacement in try self.onAttach(ready, replacement) },
            onFrame: { lane, bytes in self.routeCurrentFrame(lane: lane, bytes: bytes) },
            onEnded: { error in self.onEnded(error) })
    }

    /// The exact `LinkRecoveryCoordinator.onTransportLost` policy seam, for the
    /// WHOLE link.
    ///
    /// Both lanes, every time. Each has to be SUSPENDED — a lane that is still
    /// pointing at a transport that is gone will arm timers for it, write into
    /// it and, in the text lane's case, seal a frame whose nonce it then cannot
    /// spend — so neither call may be short-circuited away by the other's
    /// answer. The two results are bound to locals for exactly that reason:
    /// `text.onTransportLost(ready) || file.onTransportLost(ready)` compiles,
    /// reads the same, and silently skips the file lane.
    ///
    /// ## The window this closes, and why the order alone could not
    ///
    /// Whichever lane is suspended first, suspending it DELIVERS THAT LANE'S
    /// OWNER CALLBACKS before the other lane has been told anything, and the
    /// coordinator closed the dying transport before it asked this policy at
    /// all. So an owner answering a callback in that window drives a lane whose
    /// driver still holds a transport that cannot take a byte: the write fails,
    /// and the driver's only honest reading of a failed write is that its lane
    /// is over. A gap that exists to SUSPEND a lane would have spent it.
    ///
    /// That is symmetric, so an order cannot fix it — it can only choose which
    /// lane is exposed. TEXT is still suspended first, for the reason it always
    /// was: its failure is the irreversible one, since a sealed frame's nonce is
    /// spent and no replacement can repair the sequence, whereas the file lane
    /// has a whole resume protocol for what a gap stranded. But BOTH lanes are
    /// now closed to owner-facade calls for the whole of this call, so neither
    /// depends on being second.
    ///
    /// The refusal is `LinkLaneOwnerError.transportUnavailable`, and it is
    /// retryable: the window is exactly this call, and once it returns each lane
    /// answers for itself again.
    ///
    /// The answers are OR-ed because either lane can hold the link open. An idle
    /// file lane saying "nothing to recover" says nothing about a live
    /// conversation, and the reverse is just as true.
    ///
    /// A FOREIGN identity closes nothing, exactly as it suspends nothing: both
    /// hooks are still called — neither lane may be skipped — and each refuses
    /// the foreign report itself. Closing the gate for another link's gap would
    /// refuse this link's work for a failure that is not its own.
    public func onTransportLost(_ ready: LinkIdentity) -> Bool {
        let mine = identityMatches(ready)
        if mine { beginTransition(terminal: false) }
        defer { if mine { endTransition() } }
        let textNeedsRecovery = text.onTransportLost(ready)
        let fileNeedsRecovery = file.onTransportLost(ready)
        return textNeedsRecovery || fileNeedsRecovery
    }

    /// The exact `LinkRecoveryCoordinator.onAttach` seam, for the whole link.
    ///
    /// Synchronous by contract: the coordinator replays the replacement's
    /// captured backlog the instant this returns, so BOTH lanes have to be on
    /// the new transport before it does.
    ///
    /// TEXT first again, and here the reason is what each attach emits. The text
    /// lane's attach produces no wire output at all — it finishes the timers a
    /// dead transport left armed and replays not one byte, because consent was
    /// given on a channel that no longer exists. The file lane's attach flushes
    /// its `RESUME_REQ` synchronously. Putting the silent one first means the
    /// resume request is the last thing on the wire before the replay, which is
    /// the ordering the receiver's own sequence depends on; it also means that
    /// an owner answering a file event from inside the barrier finds a text lane
    /// that already has a channel, rather than one that would refuse it.
    ///
    /// Unlike the gap order, this one has no failure a test can distinguish:
    /// both lanes reject exactly the same replacements, so whichever goes first
    /// throws first. It is fixed here because the reasons above are real, not
    /// because a green test proves it.
    ///
    /// **A throw fails the whole publication closed, and there is deliberately
    /// no rollback.** If the file lane cannot take over, the text lane has
    /// already swapped — and undoing that would mean re-attaching it to a
    /// transport the coordinator has declared gone, or worse, reusing codecs a
    /// failed attach may have proven unsafe. The coordinator's terminal path
    /// runs `onEnded` instead, which ends both lanes properly.
    ///
    /// **Owner-facade calls are refused for the whole of this call too**, with
    /// the same retryable `transportUnavailable`, and for a reason of its own:
    /// until this returns the coordinator has not PUBLISHED the replacement, and
    /// if the second lane throws it never will. Work started from inside the
    /// barrier would be work on a transport the link may be about to abandon —
    /// and, between the two attaches, it would also put a text frame on the wire
    /// ahead of the file lane's `RESUME_REQ`, which is the one ordering the
    /// replay depends on.
    public func onAttach(_ ready: LinkIdentity, _ replacement: LinkReplacementTransport) throws {
        beginTransition(terminal: false)
        defer { endTransition() }
        try text.onAttach(ready, replacement)
        try file.onAttach(ready, replacement)
    }

    /// One raw frame the RECOVERY COORDINATOR routed off the transport it has
    /// made current.
    ///
    /// Demultiplexed exactly ONCE, by the file driver, which is the only object
    /// in this link that has ever owned a route. That is a reuse rather than a
    /// shortcut: its current-frame path already drops a frame that arrives in a
    /// gap or after the link ended, already forwards `.text` through the
    /// callback this owner wired to the text lane, and already keeps forwarding
    /// it after the FILE lane has failed closed. A second demux here would be a
    /// second set of those rules to keep in step.
    ///
    /// Stale frames are still the coordinator's and the driver's to drop: a
    /// replacement's by the coordinator's own current-transport check, and the
    /// initial transport's by the token the file driver captured when it
    /// installed that route.
    ///
    /// Deliberately NOT behind the lifecycle gate. This is the INBOUND route,
    /// not an owner action: the gate exists to stop this object driving a lane
    /// whose driver has not been told the transport is gone, and a frame the
    /// coordinator routed is the opposite case — bytes the peer already sent,
    /// which the file driver drops itself the moment it has no current transport.
    /// Gating it would lose frames rather than refuse an action.
    public func routeCurrentFrame(lane: LinkLane, bytes: [UInt8]) {
        file.routeCurrentFrame(lane: lane, bytes: bytes)
    }

    /// The exact `LinkRecoveryCoordinator.onEnded` seam. The held link is over,
    /// so this is terminal for both lanes' routing.
    ///
    /// Both, every time, and idempotent in each: a driver that has already
    /// recorded the link ending returns without emitting a second loss, and one
    /// that has not gets its one terminal report. The file lane's own terminal
    /// path is what discards an uncommitted destination — through
    /// `LinkFileDestination.abort`, off its lock, and never after a `finalize`
    /// that succeeded.
    ///
    /// The same window as the gap, and the same close, with one difference that
    /// matters: the refusal here is `LinkLaneOwnerError.linkEnded` and it is
    /// TERMINAL. A lane's one `failed` report is delivered from inside this
    /// call, so an owner answering it must not be able to start work on the
    /// other lane — which would spend that lane on a closed transport and turn
    /// ONE loss into two reports for it: `sendFailed` for the work, then
    /// `linkEnded` for the link.
    ///
    /// `ending` is sticky, so a transition that begins after this one still
    /// refuses terminally rather than promising a retry that cannot come.
    public func onEnded(_ error: Error) {
        beginTransition(terminal: true)
        defer { endTransition() }
        text.onEnded(error)
        file.onEnded(error)
    }

    private func identityMatches(_ ready: LinkIdentity) -> Bool {
        ready.peerId == identity.peerId
            && ready.role == identity.role
            && ready.sas == identity.sas
            && ready.authenticationGeneration == identity.authenticationGeneration
            && ready.codecs === identity.codecs
    }

    // MARK: - the conversation
    //
    // Every one of these — and every file action below — passes the lifecycle
    // gate first. While a gap, an attach or an end is being delivered to the
    // lanes, they throw `LinkLaneOwnerError.transportUnavailable` or
    // `.linkEnded` without reaching a driver at all. Outside that window they
    // are exactly the forwarding calls they look like, and every refusal is the
    // lane's own.

    /// Ask the peer for a conversation.
    public func openTextConversation() throws { try gated { try text.open() } }
    /// Consent to the peer's request.
    public func acceptTextConversation() throws { try gated { try text.accept() } }
    /// Refuse the peer's request.
    public func rejectTextConversation() throws { try gated { try text.reject() } }
    /// End the current conversation. An ordering BARRIER, not a hangup.
    public func endTextConversation() throws { try gated { try text.end() } }
    /// Seal and queue one message for the open conversation.
    public func sendText(_ body: String) throws { try gated { try text.send(body) } }

    // MARK: - the transfer

    /// Queue one batch. `stage` produces PRISTINE sources each time it is
    /// called: once for the first attempt and once more for every resumed one.
    ///
    /// Refused only DURING a lifecycle transition. A batch queued in an ordinary
    /// gap is accepted and waits, which is the file lane's whole point.
    @discardableResult
    public func enqueueFiles(files: [FileMeta],
                             stage: @escaping () throws -> [PlaintextSource]) throws -> Int {
        try gated { try file.enqueue(files: files, stage: stage) }
    }

    // The five actions below return nothing, so a refusal has to BE the absence
    // of the action: during a lifecycle transition each is INERT — it reaches no
    // driver, moves no session, writes no byte and emits no event — and the
    // caller may simply make it again once the transition is over.

    /// Launch the head of the queue if the lane can take it.
    public func pumpFiles() { inert { file.pump() } }
    /// Drop a batch that is still WAITING to launch.
    public func cancelQueuedBatch(_ batch: Int) { inert { file.cancelQueued(batch) } }
    /// Cancel the batch that is on the lane right now.
    public func cancelOutboundBatch() { inert { file.cancelOutbound() } }
    public func acceptInboundBatch() { inert { file.acceptInbound() } }
    public func rejectInboundBatch() { inert { file.rejectInbound() } }

    // MARK: - what an owner above may read

    public var textStatus: LinkTextStatus { text.status }
    /// The TEXT lane is terminal. Says nothing about the file lane, which may
    /// still be transferring on the same transport.
    public var isTextTerminal: Bool { text.isTerminal }
    /// The FILE lane is terminal. Says nothing about the conversation.
    public var isFileTerminal: Bool { file.isTerminal }
    /// The held link ended. Nothing routes in either lane.
    ///
    /// Either driver's answer is the link's: `onEnded` tells both, every time,
    /// so a disagreement here would be a lane that was ended behind this
    /// object's back — and the honest reading of that is still "ended".
    public var isLinkEnded: Bool { text.isLinkEnded || file.isLinkEnded }
    public var activeInboundBatch: Int? { file.activeInboundBatch }
    public var activeOutboundBatch: Int? { file.activeOutboundBatch }

    /// Barrier: returns once every step both drivers dispatched off their own
    /// locks has run.
    ///
    /// Internal, and it exists so a test can be deterministic about work the two
    /// lanes deliberately do on their own queues. Production never needs it. The
    /// FILE lane settles first: its drain is what hands text frames to the text
    /// lane, so settling the other way round could leave a forwarded frame
    /// unaccounted for.
    func settle() {
        file.settle()
        text.settle()
    }
}
