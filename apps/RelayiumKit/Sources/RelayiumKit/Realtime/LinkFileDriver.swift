import Foundation

// MARK: - the live-transport seam

/// The smallest surface a file driver needs from whatever transport is current:
/// the frames coming off it, and the ability to write frames back.
///
/// Deliberately SEPARATE from `LinkTransportHandle`, which
/// `LinkRecoveryCoordinator` holds. That protocol is one method — `close()` — on
/// purpose: the coordinator never sends, never reads a buffer and never inspects
/// a lane, so widening it would hand a stale-transport code path the ability to
/// write bytes into a sequence it does not own. This protocol exists next to it
/// rather than above it, and the driver composes the two at its own attach
/// boundary.
///
/// `onFrame` is part of it because the INITIAL transport has to be routable
/// without a manual call: production hands this driver a `WebRTCLinkTransport`,
/// which is a live lane and not a replacement driver, and a driver that could
/// only route `LinkReplacementTransport` would never see its first frame. Both
/// concrete transports already satisfy every requirement here byte for byte; the
/// conformances below add no code to either.
///
/// ## The `onFrame` slot is shared state
///
/// `WebRTCLinkTransport` publishes on its own private queue and stores this slot
/// unsynchronised, so the ONE safe moment to install a route on the initial
/// transport is from inside its `onReady`, on that queue, before it delivers a
/// single frame. That is exactly where this driver is constructed, and the
/// installation happens in `init` for that reason — see the initializer.
/// `WebRTCLinkReplacementTransport` guards its slots with a leaf lock and is safe
/// from anywhere, which is what lets `LinkRecoveryCoordinator` own a
/// replacement's route from whichever thread reported the rebuild.
public protocol LinkLiveTransport: AnyObject {
    /// One raw frame off one exact lane. Owned by whoever installed it: for the
    /// initial transport that is this driver, and for a replacement it is
    /// `LinkRecoveryCoordinator`, which applies its own staleness rules first.
    var onFrame: ((LinkLane, [UInt8]) -> Void)? { get set }
    /// Safe from any thread, including from inside a callback. May block: the
    /// real transports enter their own serial queue synchronously, which is why
    /// this driver never calls it while holding a lock of its own.
    func send(_ bytes: [UInt8], on lane: LinkLane) throws
    func bufferedAmount(on lane: LinkLane) -> UInt64
    var isClosed: Bool { get }
    func close()
}

extension WebRTCLinkTransport: LinkLiveTransport {}
extension WebRTCLinkReplacementTransport: LinkLiveTransport {}

// MARK: - the producer seam

/// One outbound attempt's frame stream.
///
/// A protocol rather than the concrete producer so a test can drive the exact
/// failure boundaries — a source that changes under a transfer, a read that
/// throws — without a filesystem. `LinkFileRealtimeProducer` below is the
/// production adapter, and it is the only place `RealtimeFrameProducer` is
/// constructed.
public protocol LinkFileProducing: AnyObject {
    /// The next frame, or nil once this attempt has produced everything.
    /// Throwing ends the attempt through `producerFailed`.
    func next() throws -> [UInt8]?
}

/// Everything one attempt needs to exist.
///
/// `sources` are PRISTINE for this attempt: a resumed batch never rewinds a used
/// source, it re-stages, because a `PlaintextSource` is pinned to a descriptor
/// from the moment it was staged and reading one twice is not defined.
public struct LinkFileProducerRequest {
    public let batch: Int
    public let attempt: Int
    public let files: [FileMeta]
    public let sources: [PlaintextSource]
    public let resume: ResumePoint?
    /// The link's ONE sender, for the whole life of the link. A producer that
    /// built its own would restart the GCM nonce at zero under a key that has
    /// already used it.
    public let sender: RealtimeSender
    public let maxFrameBytes: Double

    public init(batch: Int, attempt: Int, files: [FileMeta], sources: [PlaintextSource],
                resume: ResumePoint?, sender: RealtimeSender, maxFrameBytes: Double) {
        self.batch = batch
        self.attempt = attempt
        self.files = files
        self.sources = sources
        self.resume = resume
        self.sender = sender
        self.maxFrameBytes = maxFrameBytes
    }
}

public typealias LinkFileProducerFactory = (LinkFileProducerRequest) throws -> LinkFileProducing

/// The production adapter: a `RealtimeFrameProducer` over the link's own sender.
public final class LinkFileRealtimeProducer: LinkFileProducing {
    private let producer: RealtimeFrameProducer

    public init(_ request: LinkFileProducerRequest) {
        self.producer = RealtimeFrameProducer(sender: request.sender,
                                              sources: request.sources,
                                              declaredSizes: request.files.map(\.size),
                                              resume: request.resume,
                                              maxFrameBytes: request.maxFrameBytes)
    }

    public func next() throws -> [UInt8]? { try producer.next() }
}

// MARK: - the destination seam

/// One inbound batch's destination.
///
/// **Concrete filesystem selection is deliberately NOT in this target.** The
/// validated writer this maps onto — `ManifestWriter`, with its owned container,
/// per-segment name validation and atomic finish — lives in `RelayiumAppKit`,
/// which DEPENDS on this module. Implementing a filesystem destination here
/// would invert that dependency or duplicate path validation, and duplicated
/// path validation is exactly the kind of second lookup that can lie. So the
/// seam is shaped to fit that writer and the adapter is built by the later
/// AppKit factory:
///
/// - `write` maps to `ManifestWriter.write`,
/// - `finalize` to `finish()`,
/// - `abort` to `discard()`,
/// - `openNextFile` is a BOUNDARY ACKNOWLEDGEMENT: that writer advances between
///   files by declared byte count on its own, so the adapter verifies the index
///   it has reached rather than opening anything.
///
/// Every call happens off the driver's lock, one at a time, in wire order, on the
/// destination's own serial queue, and the driver admits no further frame until
/// the one outstanding call has reported back.
public protocol LinkFileDestination: AnyObject {
    func write(_ bytes: [UInt8]) throws
    func openNextFile(index: Int) throws
    /// Commit. After this returns the bytes are the user's file, and no later
    /// abort may remove them.
    func finalize() throws
    /// Discard everything not yet finalised. Never called after `finalize`
    /// returned, however late the decision to discard was taken.
    func abort()
}

public typealias LinkFileDestinationFactory = (Int, [FileMeta]) throws -> LinkFileDestination

// MARK: - what a driver reports

public enum LinkFileDriverError: Error, Equatable, Sendable {
    /// A frame the session produced could not be put on the wire.
    case sendFailed
    /// More inbound file bytes than this driver will hold while a write is out.
    case inboundBufferOverflow
    /// The file lane itself became terminal.
    case laneFailed
    /// A replacement published an identity that is not this link's.
    case identityMismatch
    /// A replacement transport that cannot carry a lane.
    case replacementNotLive
    /// The held link ended.
    case linkEnded
    /// A coordinator holding a different link's authentication.
    case foreignCoordinator
}

/// What an owner above this driver observes.
///
/// ## The retirement contract, exactly
///
/// For every batch `enqueue` accepted, EXACTLY ONE of these eventually happens:
///
///  - `outboundFinished(batch:ok:)` — the batch left the outbound slot for good.
///    `ok` is true only for a peer COMPLETE the session honoured; a consent
///    timeout, a completion timeout, a producer or source failure, a local
///    cancel, a refusal, an ordered abort and a gap that stranded an unanswered
///    batch are all `ok: false`.
///  - `batchesFailed([Int])` — the FILE lane went terminal and named the work it
///    took with it. Those batches deliberately get NO `outboundFinished`: one
///    loss is one report, and a driver that emitted both would make a UI show a
///    result and a failure for the same batch.
///
/// A peer BUSY is neither: the batch goes back to the head of the queue with its
/// staged sources intact, and its one result comes when it really ends.
///
/// Inbound is the same shape one level down: `inboundFinished(batch:ok:)` is
/// emitted exactly once for a batch that got as far as a destination, with `ok`
/// true only when that destination committed.
public enum LinkFileDriverEvent: Equatable, Sendable {
    /// A peer's manifest is waiting for this user's answer.
    case inboundOffer(batch: Int, files: [FileMeta])
    /// Durable bytes of the WHOLE manifest, never of the current file and never
    /// of the current attempt. Monotonic.
    case inboundProgress(batch: Int, durableBytes: Int)
    case inboundFinished(batch: Int, ok: Bool)
    /// Bytes of the whole manifest that entered the authenticated channel.
    /// Monotonic across a resumed attempt, which restarts its own byte count.
    case outboundProgress(batch: Int, sentBytes: Int)
    case outboundFinished(batch: Int, ok: Bool)
    /// These queued/active batches will never go out.
    case batchesFailed([Int])
    /// A terminal transition. At most one for the FILE lane and at most one for
    /// the held link, and they are different events: a file lane that failed
    /// closed leaves a live transport carrying a live conversation.
    case failed(LinkFileDriverError)
}

// MARK: - the driver

/// Owns ONE `LinkFileSession` across an initial transport and its authenticated
/// replacements, executes the session's effects, and plugs into
/// `LinkRecoveryCoordinator`.
///
/// ## Synchronization, and why it is shaped like this
///
/// Three rules, and everything else follows from them.
///
/// **1. `state` guards every mutable field, and NOTHING that can block runs
/// under it.** Not `send`, not `bufferedAmount`, not `close`, not a destination
/// or producer call, and not an owner callback. The real transports enter their
/// own serial queue synchronously, and that queue is where their frames are
/// delivered from — so a driver that sent while holding the lock its own
/// `onFrame` needs would deadlock against a peer that happened to be talking.
/// That is not a hypothetical: `LinkFileDriverReviewTests` reproduces it with a
/// genuine serial queue.
///
/// **2. Everything that leaves this object leaves through an emission queue.**
/// Under the lock, effects append frames to `outbox` and owner callbacks to
/// `notices`. After the lock is released the caller drains them. Both drains are
/// single-consumer hand-offs: a thread that finds a drain already owned appends
/// and returns, and the owner picks its work up. Order is therefore exactly the
/// order the effects were produced in — the manifest, the controls, the
/// realignment markers, the protected frames and the ordered barriers — with no
/// thread ever blocked on another one.
///
/// **3. The wire drain is scoped to a transport EPOCH.** Every transport change —
/// the initial installation, a gap, an attach — bumps `epoch` under the lock and
/// clears the outbox, because a frame queued for a transport that is gone can
/// never reach the peer and the next generation's announcement is what repairs
/// the sequence. An attach claims the drain for its brand-new epoch as part of
/// that same atomic swap, which is what lets it flush its `RESUME_REQ`
/// SYNCHRONOUSLY without ever waiting for another thread: nobody can already own
/// an epoch that did not exist a moment ago. A drainer whose epoch was replaced
/// underneath it stops without touching the new owner's work.
///
/// ## Lock ordering
///
/// `LinkRecoveryCoordinator` calls this driver's hooks UNDER its own lock, so the
/// only safe order is coordinator → driver. This driver therefore never calls
/// into a coordinator while holding `state`; the single call it makes,
/// `bind(to:)`, is made with no lock of its own held. There is no path from
/// inside `state` to the coordinator at all.
///
/// One consequence is worth stating plainly: owner callbacks emitted during a
/// recovery attach are delivered while the COORDINATOR's lock is held, because
/// `onAttach` is a synchronous publication barrier and that is the contract the
/// coordinator documents. They are never delivered under this driver's lock.
///
/// ## What it is not
///
/// It owns no UI, no admission, no picker and no filesystem — destination
/// selection is the AppKit factory's (see `LinkFileDestination`). Production
/// construction is macOS-only through the unified Workspace; transport
/// replacement remains disabled until the replacement path is supported.
public final class LinkFileDriver: @unchecked Sendable {

    // MARK: - owned synchronization
    //
    // `@unchecked Sendable` is earned rather than asserted, and this is the whole
    // invariant:
    //
    //  - `identity`, `session`, `scheduler`, the two factories, the two queues
    //    and the two owner closures are immutable after `init`.
    //  - EVERY other stored property below is read and written only with `state`
    //    held. There is no atomic, no "just a Bool" and no property that is read
    //    outside it.
    //  - `state` is never held across a call that can block or run owner code.
    //    The two drains take and release it around each individual step instead,
    //    which is why they are written as loops rather than as one critical
    //    section.
    //  - Every closure this driver installs anywhere captures `self` weakly and
    //    takes `state` before touching anything. The one deliberate exception is
    //    `bind(to:)`, whose hooks the COORDINATOR owns: a weak driver behind an
    //    attach barrier is a barrier that passes with nobody home. See `bind`.
    //
    // It is recursive because effect execution genuinely nests: a session call
    // produces effects, one of which is a stop whose quiescence produces more.
    // Recursion is legal; blocking is not.

    private let state = NSRecursiveLock()
    /// Outbound source reads and the sends they feed. Separate from the
    /// destination queue so a slow source cannot delay durable persistence.
    private let producerQueue: DispatchQueue
    /// Inbound durable writes. Separate from the producer queue for the same
    /// reason in the other direction, and serial so writes reach the disk in
    /// exactly the order the receive FIFO admitted them.
    private let destinationQueue: DispatchQueue

    private let session: LinkFileSession
    private let identity: LinkIdentity
    private let scheduler: LinkRecoveryScheduler
    private let makeProducer: LinkFileProducerFactory
    private let makeDestination: LinkFileDestinationFactory
    private let maxFrameBytes: Double
    private let maxBufferedInboundBytes: Int
    private let maxBufferedInboundFrames: Int
    private let sendBufferHighWater: UInt64
    private let sendBufferPollInterval: TimeInterval

    /// Text frames are handed straight out. This driver never interprets one, and
    /// never drops one while the link is alive — including after the FILE lane has
    /// failed closed, which is the entire point of keeping them apart.
    private let onTextFrame: ([UInt8]) -> Void
    private let onEvent: (LinkFileDriverEvent) -> Void

    // MARK: - state, all of it under `state`

    /// The transport the lanes are on, and the identity of the transport whose
    /// direct route is authoritative. A frame arriving from any other one belongs
    /// to a generation the replacement's announcement has already carried the peer
    /// past.
    private var transport: LinkLiveTransport?
    private var currentToken: ObjectIdentifier?
    /// Bumped on every transport change. Names the wire generation an emission
    /// belongs to and the drain that is allowed to carry it.
    private var epoch = 0

    /// The FILE lane is terminal. The link may still be perfectly alive.
    private var fileTerminal = false
    /// The held link itself ended. Nothing routes any more, in either lane.
    private var linkEnded = false

    private var outbox: [(epoch: Int, frame: [UInt8])] = []
    /// The epoch whose wire drain is owned right now, or nil when it is free.
    private var wireOwner: Int?

    private enum Notice {
        case event(LinkFileDriverEvent)
        case text([UInt8])
    }
    private var notices: [Notice] = []
    private var noticing = false

    /// Inbound file frames waiting for the receive FIFO to settle.
    private var inboundBuffer: [[UInt8]] = []
    private var inboundBufferedBytes = 0
    private var draining = false

    /// One inbound batch's destination, as an explicit correlated operation
    /// state rather than a handful of flags.
    ///
    /// `operation` is what makes every completion answerable: a create, a write,
    /// a boundary or a commit that lands for an operation this slot no longer has
    /// outstanding belongs to a batch that is gone, and it may not touch the one
    /// that is live now. `committed` and `discardWhenQuiet` are the finalize race:
    /// a terminal that observes an uncommitted destination must not queue a
    /// discard that runs after the commit succeeded.
    private struct DestinationSlot {
        let batch: Int
        var sink: LinkFileDestination?
        var operation: Int?
        var committed = false
        var discardWhenQuiet = false
        /// `inboundFinished` has been reported for this batch.
        var reported = false
    }
    private var destinationSlot: DestinationSlot?
    private var nextOperation = 1
    private var destinationBusy: Bool { destinationSlot?.operation != nil }

    /// One outbound attempt's producer.
    ///
    /// `run` is unique per start, so a poll wake-up, a completion or a stop that
    /// belongs to a producer this driver has already released cannot revive it or
    /// start a second one for the same (batch, attempt).
    private struct ProducerRun {
        let run: Int
        let batch: Int
        let attempt: Int
        var producer: LinkFileProducing?
        var paused = false
        var stopRequested = false
        /// A pump loop is live on `producerQueue` for this run.
        var pumping = false
    }
    private var producerRun: ProducerRun?
    private var nextRun = 1

    private struct BatchSources {
        let files: [FileMeta]
        let stage: () throws -> [PlaintextSource]
    }
    /// Held from `enqueue` until the batch's ONE result. Its presence is the
    /// "not retired yet" flag: `retireOutboundLocked` removes the entry and emits
    /// in the same step, which is what makes exactly-once structural rather than a
    /// rule spread over eight call sites.
    private var sources: [Int: BatchSources] = [:]
    /// The batch a peer COMPLETE this session honoured belongs to. Read once, by
    /// the retirement that follows it — which may be several effects later, because
    /// a COMPLETE that crosses the producer's last frames is remembered by the
    /// session and acted on when the producer ends.
    private var outboundSucceeded: Int?

    private var lastInboundProgress: (batch: Int, bytes: Int)?
    private var lastOutboundProgress: (batch: Int, bytes: Int)?

    private enum TimerKey: Hashable {
        case outboundConsent(batch: Int)
        case inboundConsent(batch: Int)
        case complete(batch: Int)
        case receiveStall(batch: Int)
        case drain(batch: Int)
        case producerPoll(run: Int)
    }
    /// A timer's identity is its TOKEN, not its key. Re-arming a watchdog — the
    /// receive stall re-arms on every admitted chunk, under the same key — cancels
    /// the old handle and stores a new one, and a real cancelled callback that had
    /// already started running then arrives to find the key occupied by its
    /// successor. Matching on the token is what stops it from firing the live
    /// watchdog early.
    private var timers: [TimerKey: (token: Int, handle: LinkRecoveryTimer)] = [:]
    private var nextTimerToken = 1

    // MARK: - init

    /// - Parameters:
    ///   - identity: the link's ONE authenticated identity. Its `codecs` are the
    ///     only codecs this driver ever uses, and the session is built from them
    ///     here — there is no initializer that accepts a session, because a
    ///     session over any other codecs would run a second AEAD sequence under
    ///     keys that have already been used.
    ///   - transport: the live transport the lanes are on right now. **Construct
    ///     this driver from that transport's `onReady`**, on the transport's own
    ///     publication queue: `init` installs the frame route as its last act, and
    ///     `WebRTCLinkTransport` stores its callback slots unsynchronised and
    ///     replays nothing — a route installed from another thread is both a data
    ///     race and a frame already delivered to nobody.
    ///   - onTextFrame: the independent text route. Never called for a file frame,
    ///     and every text frame reaches it for as long as the LINK is alive,
    ///     including after the file lane has failed closed.
    public convenience init(identity: LinkIdentity,
                            transport: LinkLiveTransport,
                            scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
                            producerFactory: @escaping LinkFileProducerFactory
                                = { LinkFileRealtimeProducer($0) },
                            destinationFactory: @escaping LinkFileDestinationFactory,
                            maxFrameBytes: Double = DEFAULT_MAX_FRAME_BYTES,
                            maxBufferedInboundBytes: Int = FLOW_WINDOW * 2,
                            maxBufferedInboundFrames: Int = 4096,
                            sendBufferHighWater: UInt64 = UInt64(FLOW_WINDOW),
                            sendBufferPollInterval: TimeInterval = 0.05,
                            onTextFrame: @escaping ([UInt8]) -> Void,
                            onEvent: @escaping (LinkFileDriverEvent) -> Void) {
        self.init(identity: identity, transport: transport, scheduler: scheduler,
                  producerFactory: producerFactory, destinationFactory: destinationFactory,
                  window: FLOW_WINDOW, ackInterval: FLOW_ACK_INTERVAL,
                  maxFrameBytes: maxFrameBytes,
                  maxBufferedInboundBytes: maxBufferedInboundBytes,
                  maxBufferedInboundFrames: maxBufferedInboundFrames,
                  sendBufferHighWater: sendBufferHighWater,
                  sendBufferPollInterval: sendBufferPollInterval,
                  onTextFrame: onTextFrame, onEvent: onEvent)
    }

    /// The same construction with the lane's flow-control constants exposed.
    ///
    /// Internal because an ack interval is a tuning decision a test needs to be
    /// able to make small, not a public knob. It deliberately still does NOT take
    /// a session: `identity.codecs` is the only codec pair any initializer here
    /// can reach.
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
         sendBufferHighWater: UInt64 = UInt64(FLOW_WINDOW),
         sendBufferPollInterval: TimeInterval = 0.05,
         onTextFrame: @escaping ([UInt8]) -> Void,
         onEvent: @escaping (LinkFileDriverEvent) -> Void) {
        self.identity = identity
        self.session = LinkFileSession(codecs: identity.codecs,
                                       window: window, ackInterval: ackInterval)
        self.scheduler = scheduler
        self.makeProducer = producerFactory
        self.makeDestination = destinationFactory
        self.maxFrameBytes = maxFrameBytes
        self.maxBufferedInboundBytes = maxBufferedInboundBytes
        self.maxBufferedInboundFrames = maxBufferedInboundFrames
        self.sendBufferHighWater = sendBufferHighWater
        self.sendBufferPollInterval = sendBufferPollInterval
        self.onTextFrame = onTextFrame
        self.onEvent = onEvent
        self.producerQueue = DispatchQueue(label: "com.relayium.link.file.producer")
        self.destinationQueue = DispatchQueue(label: "com.relayium.link.file.destination")

        self.transport = transport
        self.epoch = 1
        let token = ObjectIdentifier(transport)
        self.currentToken = token
        // LAST, and on the transport's own publication queue: from this line the
        // initial transport's frames reach this driver, and everything they can
        // touch already exists.
        transport.onFrame = { [weak self] lane, bytes in
            self?.receiveDirect(lane: lane, bytes: bytes, from: token)
        }
    }

    // MARK: - the two drains
    //
    // Both are entered with NO lock held, and both take and release `state`
    // around each individual step. Nothing in this file may call either one while
    // holding the lock.

    /// Take the lock, run `body`, release it, and only then let what `body`
    /// queued out. Every public entry point has exactly this shape.
    @discardableResult
    private func withState<T>(_ body: () -> T) -> T {
        let lock = state
        lock.lock()
        let result = body()
        lock.unlock()
        flush()
        return result
    }

    private func flush() {
        _ = drainWire(owning: nil)
        drainNotices()
    }

    /// Put queued frames on the wire, in order, one at a time, with the lock
    /// released across every `send`.
    ///
    /// - Parameter owning: the epoch this thread has already claimed. Only
    ///   `onAttach` passes one, because only an attach can claim an epoch nobody
    ///   has ever drained.
    /// - Returns: false when a frame could not be put on the wire.
    @discardableResult
    private func drainWire(owning claimed: Int?) -> Bool {
        var mine = claimed
        while true {
            var frame: [UInt8]?
            var live: LinkLiveTransport?
            var stale = false
            state.lock()
            if mine == nil, wireOwner == nil {
                wireOwner = epoch
                mine = epoch
            }
            if let owned = mine, wireOwner == owned, epoch == owned,
               !outbox.isEmpty, let current = transport {
                let item = outbox.removeFirst()
                // A frame queued for a transport that is gone reaches nobody.
                if item.epoch == owned {
                    frame = item.frame
                    live = current
                } else {
                    stale = true
                }
            }
            if stale { state.unlock(); continue }
            guard let bytes = frame, let target = live else {
                releaseWireLocked(mine)
                state.unlock()
                return true
            }
            state.unlock()

            do {
                try target.send(bytes, on: .file)
            } catch {
                // Correlated and terminal: this frame's nonce is spent and the
                // peer will never see it, so the lane cannot go on.
                state.lock()
                if epoch == mine { failFileLocked(.sendFailed) }
                releaseWireLocked(mine)
                state.unlock()
                drainNotices()
                return false
            }
        }
    }

    private func releaseWireLocked(_ mine: Int?) {
        guard let mine, wireOwner == mine else { return }
        wireOwner = nil
        outbox.removeAll { $0.epoch != epoch }
    }

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
            for notice in batch {
                switch notice {
                case let .event(event): onEvent(event)
                case let .text(bytes): onTextFrame(bytes)
                }
            }
            state.lock()
            noticing = false
            state.unlock()
        }
    }

    private func emitLocked(_ event: LinkFileDriverEvent) { notices.append(.event(event)) }

    private func enqueueWireLocked(_ frame: [UInt8]) {
        // A terminal file lane writes nothing more, and a gap has nowhere to
        // write: the next generation's announcement repairs the sequence.
        guard !fileTerminal, !linkEnded, transport != nil else { return }
        outbox.append((epoch: epoch, frame: frame))
    }

    // MARK: - what a UI or factory may call

    /// Queue one batch. `stage` produces PRISTINE sources each time it is called:
    /// once for the first attempt and once more for every resumed attempt.
    @discardableResult
    public func enqueue(files: [FileMeta],
                        stage: @escaping () throws -> [PlaintextSource]) throws -> Int {
        let lock = state
        lock.lock()
        do {
            guard !fileTerminal, !linkEnded else { throw LinkFileSessionError.laneFailed }
            let id = try session.enqueue(files: files)
            sources[id] = BatchSources(files: files, stage: stage)
            lock.unlock()
            flush()
            return id
        } catch {
            lock.unlock()
            flush()
            throw error
        }
    }

    /// Launch the head of the queue if the lane can take it.
    public func pump() {
        withState { applyLocked { session.pump() } }
    }

    /// Drop a batch that is still WAITING to launch.
    ///
    /// It names the queue and nothing else, exactly as the session's call does. An
    /// identifier that is the ACTIVE batch — or one this driver never issued — is
    /// inert here: the session leaves the live batch on the lane, and a driver that
    /// retired it anyway would release the staged sources of a transfer that is
    /// still running and report a result for a batch whose real outcome has not
    /// happened yet. Cancelling the active batch is `cancelOutbound`'s.
    public func cancelQueued(_ batch: Int) {
        withState {
            // The queue BEFORE the call is what decides whether there is anything
            // to retire, and the queue after it is what proves the call did it.
            let wasQueued = session.queuedBatchIds.contains(batch)
            applyLocked { session.cancelQueued(batch) }
            guard wasQueued, !session.queuedBatchIds.contains(batch) else { return }
            // Never launched, so no retirement is observed for it: it is reported
            // here, through the same one place every other result comes from.
            retireOutboundLocked(batch, ok: false)
        }
    }

    public func cancelOutbound() {
        withState { applyLocked { session.cancelOutbound() } }
    }

    public func acceptInbound() {
        withState { applyLocked { session.acceptInbound() } }
    }

    public func rejectInbound() {
        withState { applyLocked { session.rejectInbound() } }
    }

    /// The transport under this link is gone, reported by something other than the
    /// recovery coordinator.
    ///
    /// Unambiguous by construction: the route is closed BEFORE any effect runs, so
    /// nothing this produces can be written to the transport it has just declared
    /// gone.
    public func transportGap() {
        withState { _ = beginGapLocked() }
    }

    /// The exact `LinkRecoveryCoordinator.onTransportLost` policy seam, for the
    /// FILE lane alone.
    ///
    /// Composed with the other lanes' answer in `bind(to:)`. On its own it speaks
    /// only for files, which is why an idle file lane answering false is not the
    /// same as this link having nothing to recover.
    public func onTransportLost(_ ready: LinkIdentity) -> Bool {
        // A recovery policy is asked about ONE link. Suspending this session
        // because a different link lost its transport would strand a live
        // transfer on a transport that is still perfectly good.
        guard identityMatches(ready) else { return false }
        return withState { beginGapLocked() }
    }

    private func beginGapLocked() -> Bool {
        // First, and before any effect: from here nothing may be written to the
        // transport that is gone, and no frame from it is current any more.
        epoch += 1
        transport = nil
        currentToken = nil
        outbox.removeAll()
        guard !fileTerminal, !linkEnded else { return false }
        let before = session.outboundBatch
        let outcome = session.transportGap()
        runEffectsLocked(outcome.effects)
        noteOutboundRetirementLocked(before)
        return outcome.needsRecovery && !fileTerminal
    }

    /// The exact `LinkRecoveryCoordinator.onAttach` seam.
    ///
    /// SYNCHRONOUS by contract, and everything it must do happens before it
    /// returns: the identity is proven, the transport is switched, the session is
    /// told the replacement attached, and the effects that produced — the
    /// `RESUME_REQ` above all — are on the wire. The coordinator replays the
    /// replacement's captured backlog the instant this returns, and those frames
    /// belong to receiver codecs whose sequence has to stay continuous.
    ///
    /// It deliberately does NOT install a route on the replacement. That slot is
    /// `LinkRecoveryCoordinator`'s: the coordinator is what drops a stale
    /// transport's frames and what refuses to publish without a handler, and a
    /// driver that overwrote it would be taking frames behind those checks.
    ///
    /// A file lane that is already terminal attaches WITHOUT taking anything over
    /// — it has nothing to resume — but still becomes current, because the link's
    /// conversation is still on this transport and still has to reach its route.
    public func onAttach(_ ready: LinkIdentity, _ replacement: LinkReplacementTransport) throws {
        // Identity first, and with no lock at all: `identity` is immutable, and
        // everything that identifies the AUTHENTICATION has to survive a rebuild —
        // above all the `LinkCodecs` object itself, compared by identity because
        // equal contents would be exactly the catastrophe.
        guard identityMatches(ready) else { throw LinkFileDriverError.identityMismatch }
        // The coordinator's own protocol cannot send, deliberately. The driver
        // composes it with the live seam here, at its own boundary.
        guard let live = replacement as? LinkLiveTransport else {
            throw LinkFileDriverError.replacementNotLive
        }

        let lock = state
        lock.lock()
        guard !linkEnded else {
            lock.unlock()
            throw LinkFileDriverError.linkEnded
        }
        // The swap and the drain claim are ONE step. A brand-new epoch has never
        // been drained by anybody, so claiming it here can never contend with the
        // drainer of the epoch that just died — which is what lets the flush below
        // be synchronous without waiting for another thread.
        epoch += 1
        let mine = epoch
        outbox.removeAll()
        transport = live
        currentToken = ObjectIdentifier(live)
        wireOwner = mine
        if !fileTerminal {
            applyLocked { session.didAttachReplacementTransport() }
        }
        lock.unlock()

        let delivered = drainWire(owning: mine)
        drainNotices()
        // A resume effect that could not be written means this driver has not
        // taken the lanes over. Failing here fails the attach closed, before the
        // coordinator publishes.
        guard delivered else { throw LinkFileDriverError.sendFailed }
    }

    /// The exact `LinkRecoveryCoordinator.onEnded` seam. The held link is over, so
    /// this is terminal for BOTH lanes' routing — unlike a file-lane failure,
    /// which leaves the conversation alone.
    public func onEnded(_ error: Error) {
        withState {
            guard !linkEnded else { return }
            linkEnded = true
            epoch += 1
            transport = nil
            currentToken = nil
            outbox.removeAll()
            if fileTerminal {
                emitLocked(.failed(.linkEnded))
            } else {
                failFileLocked(.linkEnded)
            }
        }
    }

    /// Install this driver's hooks on a recovery coordinator, atomically, before
    /// anything can fire.
    ///
    /// Called with no lock of this driver's held, which is the whole lock-ordering
    /// rule: the coordinator calls these hooks under ITS lock, so a driver that
    /// reached into a coordinator from under `state` would close the cycle.
    ///
    /// ## Binding makes the coordinator this driver's OWNER
    ///
    /// The four hooks capture `self` STRONGLY, and that is a lifetime decision
    /// rather than an oversight. A weakly-held driver makes
    /// `try self?.onAttach(…)` SUCCEED once it is gone: the coordinator then finds
    /// its `onFrame` slot non-nil — the closure is still there, only its target is
    /// not — publishes the replacement, and replays the captured backlog into
    /// nothing. Those frames belong to receiver codecs whose sequence has to stay
    /// continuous, so that is exactly the missing-owner failure the attach barrier
    /// exists to prevent, arriving as a silent success instead of a refusal.
    ///
    /// It is an owner relationship and not a cycle: this driver holds no reference
    /// to the coordinator, and reaches one only through the `bind` argument on this
    /// stack. The retain therefore ends when the coordinator is released — a
    /// coordinator that ended its link keeps its hooks so a late terminal callback
    /// still finds an owner, and both go together when the owner above drops them.
    /// A caller whose `otherLanes…` closures capture this driver would close a
    /// cycle of its own; they are for the OTHER lanes, and passing the file
    /// driver's own work through them is what to avoid.
    ///
    /// - Parameters:
    ///   - otherLanesNeedRecovery: the answer for everything that is not the file
    ///     lane. **A text-only link is not this driver's to decline**: it holds no
    ///     reference to `LinkTextLane`, cannot reach one, and an idle file lane
    ///     answering "nothing to recover" says nothing about a live conversation.
    ///     Composed with `or`, so either lane can hold the link open. REQUIRED, and
    ///     deliberately without a default: an omitted answer would let an idle file
    ///     lane end a link a live conversation still needs, silently, by writing
    ///     nothing. A caller that genuinely owns no other lane passes
    ///     `{ _ in false }` and says so.
    ///   - otherLanesEnded: the same separation on the way out, and required for
    ///     the same reason — a link that ended is the other lanes' news too, and an
    ///     omitted hook is indistinguishable from one that was forgotten. A
    ///     file-only caller passes `{ _ in }`.
    public func bind(to coordinator: LinkRecoveryCoordinator,
                     otherLanesNeedRecovery: @escaping (LinkIdentity) -> Bool,
                     otherLanesEnded: @escaping (LinkRecoveryError) -> Void) throws {
        guard identityMatches(coordinator.identity) else {
            throw LinkFileDriverError.foreignCoordinator
        }
        coordinator.installOwnerHooks(
            onTransportLost: { ready in
                // Both, every time: each lane has to be SUSPENDED, so neither
                // answer may be short-circuited away by the other.
                let file = self.onTransportLost(ready)
                let other = otherLanesNeedRecovery(ready)
                return file || other
            },
            onAttach: { ready, replacement in
                try self.onAttach(ready, replacement)
            },
            onFrame: { lane, bytes in
                self.routeCurrentFrame(lane: lane, bytes: bytes)
            },
            onEnded: { error in
                self.onEnded(error)
                otherLanesEnded(error)
            })
    }

    /// One raw frame the RECOVERY COORDINATOR routed off the transport it has made
    /// current.
    ///
    /// Deliberately a different entry point from the direct route below, and
    /// deliberately without a token: the coordinator has already proven the frame
    /// came from the live transport and dropped everything else. What this still
    /// checks is that a transport is current at all, so a frame that arrives in a
    /// gap — or after this link ended — is dropped rather than fed into a sequence
    /// that has no channel under it.
    public func routeCurrentFrame(lane: LinkLane, bytes: [UInt8]) {
        withState {
            guard currentToken != nil else { return }
            routeLocked(lane: lane, bytes: bytes)
        }
    }

    /// One raw frame off the transport this driver installed its own route on.
    ///
    /// `token` is the transport that delivered it, captured when the route was
    /// installed. A frame from a transport that is no longer current is dropped.
    private func receiveDirect(lane: LinkLane, bytes: [UInt8], from token: ObjectIdentifier) {
        withState {
            guard token == currentToken else { return }
            routeLocked(lane: lane, bytes: bytes)
        }
    }

    private func routeLocked(lane: LinkLane, bytes: [UInt8]) {
        guard !linkEnded else { return }
        switch lane {
        case .text:
            // Independent, never interpreted here, and deliberately NOT gated on
            // the file lane: a file-lane failure poisons file codecs and nothing
            // else, and the conversation on this same transport goes on.
            notices.append(.text(bytes))
        case .file:
            guard !fileTerminal else { return }
            admitOrBufferLocked(bytes)
        }
    }

    private func identityMatches(_ ready: LinkIdentity) -> Bool {
        ready.peerId == identity.peerId
            && ready.role == identity.role
            && ready.sas == identity.sas
            && ready.authenticationGeneration == identity.authenticationGeneration
            && ready.codecs === identity.codecs
    }

    // MARK: - inbound file frames

    private func admitOrBufferLocked(_ frame: [UInt8]) {
        guard destinationBusy || !inboundBuffer.isEmpty else {
            admitNowLocked(frame)
            return
        }
        // A destination operation is outstanding, so this frame waits — including
        // a control frame, which must not overtake the protected frames it was
        // ordered behind.
        let (bytes, overflow) = inboundBufferedBytes.addingReportingOverflow(frame.count)
        guard !overflow, bytes <= maxBufferedInboundBytes,
              inboundBuffer.count < maxBufferedInboundFrames else {
            failFileLocked(.inboundBufferOverflow)
            return
        }
        inboundBufferedBytes = bytes
        inboundBuffer.append(frame)
    }

    private func admitNowLocked(_ frame: [UInt8]) {
        noteIncomingCompleteLocked(frame)
        applyLocked { session.admitFrame(frame) }
    }

    /// A peer COMPLETE is the only thing that makes an outbound retirement a
    /// success, and whether the session will honour this one is decidable HERE and
    /// nowhere later: by the time the batch retires, the phase that decided it is
    /// gone. It is recorded rather than acted on because a COMPLETE that crossed
    /// the producer's last frames retires the batch only when the producer ends.
    private func noteIncomingCompleteLocked(_ frame: [UInt8]) {
        guard frame.count == 1, frame[0] == RealtimeControl.complete.rawValue,
              let batch = session.outboundBatch, let phase = session.outboundPhase else { return }
        switch phase {
        case .finishing:
            outboundSucceeded = batch
        case .sending:
            // The same test the session applies: the produced frontier is the
            // record of what really entered the authenticated channel, and
            // anything short of the end of the manifest is a premature or forged
            // answer that would report a truncated transfer as delivered.
            if let files = sources[batch]?.files, let last = files.indices.last,
               session.lane.producedFrontier == ResumePoint(index: last, offset: files[last].size) {
                outboundSucceeded = batch
            }
        case .waitingAccept, .stopping, .resuming:
            break
        }
    }

    /// Deliver what the FIFO held back, in wire order, stopping the moment another
    /// destination operation goes out.
    private func drainInboundLocked() {
        guard !draining else { return }
        draining = true
        defer { draining = false }
        while !destinationBusy, !fileTerminal, !linkEnded, !inboundBuffer.isEmpty {
            let frame = inboundBuffer.removeFirst()
            inboundBufferedBytes -= frame.count
            admitNowLocked(frame)
        }
    }

    // MARK: - the effect executor

    /// Run one session call and observe what it retired.
    ///
    /// THE one place an outbound batch's result is decided. Every path that can
    /// end a batch — a COMPLETE, both timeouts, a producer failure, a cancel, a
    /// refusal, an ordered abort, a gap that stranded an unanswered batch — goes
    /// through a session call, so watching the outbound slot across every call is
    /// what makes "exactly one result per batch" a property of this method instead
    /// of eight remembered call sites.
    private func applyLocked(_ call: () -> [LinkFileSessionEffect]) {
        let before = session.outboundBatch
        runEffectsLocked(call())
        noteOutboundRetirementLocked(before)
    }

    private func noteOutboundRetirementLocked(_ before: Int?) {
        guard let before, session.outboundBatch != before else { return }
        // A peer BUSY is not a retirement: the batch went back to the HEAD of the
        // queue, because it is older than everything behind it, and it still needs
        // its staged sources.
        guard !session.queuedBatchIds.contains(before) else { return }
        retireOutboundLocked(before, ok: outboundSucceeded == before)
    }

    /// Release one batch's staged sources and report its one result.
    ///
    /// The entry's presence IS the "not retired yet" flag, so this is idempotent
    /// by construction: a terminal lane that already named the batch through
    /// `batchesFailed` has removed it, and this then reports nothing — which is
    /// the contract, because one loss must not also arrive as a result.
    private func retireOutboundLocked(_ batch: Int, ok: Bool) {
        guard sources.removeValue(forKey: batch) != nil else { return }
        if outboundSucceeded == batch { outboundSucceeded = nil }
        if lastOutboundProgress?.batch == batch { lastOutboundProgress = nil }
        emitLocked(.outboundFinished(batch: batch, ok: ok))
    }

    /// Interpret every effect in order.
    private func runEffectsLocked(_ effects: [LinkFileSessionEffect]) {
        for effect in effects {
            switch effect {
            case let .sendFrame(frame):
                enqueueWireLocked(frame)
            case let .startProducer(batch, attempt, resume):
                startProducerLocked(batch: batch, attempt: attempt, resume: resume)
            case let .stopProducer(batch, attempt):
                stopProducerLocked(batch: batch, attempt: attempt)
            case let .pauseProducer(batch, attempt):
                setProducerPausedLocked(batch: batch, attempt: attempt, paused: true)
            case let .resumeProducer(batch, attempt):
                setProducerPausedLocked(batch: batch, attempt: attempt, paused: false)
            case let .createDestination(batch, files):
                startDestinationLocked(batch: batch, kind: .create(files: files))
            case let .persistChunk(batch, bytes, checkpoint):
                startDestinationLocked(batch: batch,
                                       kind: .write(bytes: bytes, checkpoint: checkpoint))
            case let .openFile(batch, index, checkpoint):
                startDestinationLocked(batch: batch,
                                       kind: .openFile(index: index, checkpoint: checkpoint))
            case let .finalizeDestination(batch):
                startDestinationLocked(batch: batch, kind: .finalize)
            case let .abortDestination(batch):
                releaseDestinationLocked(batch: batch, discard: true)
            case let .armConsentTimeout(batch, direction):
                switch direction {
                case .outbound:
                    arm(.outboundConsent(batch: batch), after: LINK_FILE_CONSENT_TIMEOUT) {
                        [weak self] token in
                        self?.timerFired(.outboundConsent(batch: batch), token) {
                            self?.session.outboundConsentTimedOut(batch: batch) ?? []
                        }
                    }
                case .inbound:
                    arm(.inboundConsent(batch: batch), after: LINK_FILE_CONSENT_TIMEOUT) {
                        [weak self] token in
                        self?.timerFired(.inboundConsent(batch: batch), token) {
                            self?.session.inboundConsentTimedOut(batch: batch) ?? []
                        }
                    }
                    // Arming the INBOUND window is the exact moment a peer's
                    // manifest is waiting for this user's answer.
                    if session.inboundBatch == batch, let files = session.inboundFiles {
                        emitLocked(.inboundOffer(batch: batch, files: files))
                    }
                }
            case let .cancelConsentTimeout(batch, direction):
                switch direction {
                case .outbound: cancel(.outboundConsent(batch: batch))
                case .inbound: cancel(.inboundConsent(batch: batch))
                }
            case let .armCompleteTimeout(batch):
                arm(.complete(batch: batch), after: LINK_FILE_COMPLETE_TIMEOUT) { [weak self] token in
                    self?.timerFired(.complete(batch: batch), token) {
                        self?.session.completeTimedOut(batch: batch) ?? []
                    }
                }
            case let .cancelCompleteTimeout(batch):
                cancel(.complete(batch: batch))
            case let .armReceiveStall(batch):
                arm(.receiveStall(batch: batch), after: LINK_FILE_RECEIVE_STALL) { [weak self] token in
                    self?.timerFired(.receiveStall(batch: batch), token) {
                        self?.session.receiveStalled(batch: batch) ?? []
                    }
                }
            case let .cancelReceiveStall(batch):
                cancel(.receiveStall(batch: batch))
            case let .armDrainTimeout(batch):
                arm(.drain(batch: batch), after: LINK_FILE_DRAIN_TIMEOUT) { [weak self] token in
                    self?.timerFired(.drain(batch: batch), token) {
                        self?.session.drainTimedOut(batch: batch) ?? []
                    }
                }
            case let .cancelDrainTimeout(batch):
                cancel(.drain(batch: batch))
            case let .batchesFailed(ids):
                // Released WITHOUT a per-batch result: a terminal lane's loss is
                // reported once, here, and `retireOutboundLocked` finds nothing
                // left to report afterwards.
                for id in ids {
                    sources[id] = nil
                    if outboundSucceeded == id { outboundSucceeded = nil }
                }
                emitLocked(.batchesFailed(ids))
            case .poisonCodecs:
                continue   // the close below is the effect that acts
            case .closeLane:
                failFileLocked(.laneFailed)
            }
        }
    }

    // MARK: - timers

    private func arm(_ key: TimerKey, after delay: TimeInterval,
                     _ body: @escaping (Int) -> Void) {
        timers[key]?.handle.cancel()
        let token = nextTimerToken
        nextTimerToken += 1
        timers[key] = (token: token, handle: scheduler.schedule(after: delay) { body(token) })
    }

    private func cancel(_ key: TimerKey) {
        timers[key]?.handle.cancel()
        timers[key] = nil
    }

    /// A wake-up acts only if the handle it belongs to is still the live one.
    ///
    /// The TOKEN is what decides that, not the key: a re-armed watchdog occupies
    /// the same key, and a cancelled callback that had already started running
    /// would otherwise find its successor's entry and fire the live watchdog.
    private func timerFired(_ key: TimerKey, _ token: Int,
                            _ body: @escaping () -> [LinkFileSessionEffect]) {
        withState {
            guard !fileTerminal, !linkEnded, timers[key]?.token == token else { return }
            timers[key] = nil
            applyLocked(body)
        }
    }

    // MARK: - destinations

    private enum DestinationWork {
        case create(files: [FileMeta])
        case write(bytes: [UInt8], checkpoint: LinkFileCheckpoint)
        case openFile(index: Int, checkpoint: LinkFileCheckpoint)
        case finalize
    }

    private func startDestinationLocked(batch: Int, kind: DestinationWork) {
        if case let .create(files) = kind {
            // A create while the previous destination still has an operation
            // outstanding would STRAND that slot: its discard is deferred until
            // the operation lands, and overwriting the slot here would mean it
            // never does — a destination left open on disk for a batch nobody
            // owns. It is unreachable today, because the receive FIFO admits no
            // frame while an operation is out and so a second batch cannot yet
            // exist; if that gate ever moves, this fails the batch closed rather
            // than leaking.
            guard destinationSlot?.operation == nil else {
                applyLocked { session.destinationFailed(batch: batch) }
                return
            }
            // Anything left over belongs to a batch that is gone.
            releaseDestinationLocked(batch: destinationSlot?.batch, discard: true)
            let op = nextOperation
            nextOperation += 1
            destinationSlot = DestinationSlot(batch: batch, sink: nil, operation: op)
            destinationQueue.async { [weak self] in
                guard let self else { return }
                do {
                    let sink = try self.makeDestination(batch, files)
                    self.finishDestination(batch: batch, op: op, kind: kind, created: sink,
                                           failed: false)
                } catch {
                    self.finishDestination(batch: batch, op: op, kind: kind, created: nil,
                                           failed: true)
                }
            }
            return
        }
        guard var slot = destinationSlot, slot.batch == batch, let sink = slot.sink,
              slot.operation == nil, !slot.committed else {
            // No destination this operation could belong to. The session decides
            // what that means for the batch; the driver only reports it.
            applyLocked { session.destinationFailed(batch: batch) }
            return
        }
        let op = nextOperation
        nextOperation += 1
        slot.operation = op
        destinationSlot = slot
        destinationQueue.async { [weak self] in
            guard let self else { return }
            var failed = false
            do {
                switch kind {
                case .create: break
                case let .write(bytes, _): try sink.write(bytes)
                case let .openFile(index, _): try sink.openNextFile(index: index)
                case .finalize: try sink.finalize()
                }
            } catch {
                failed = true
            }
            self.finishDestination(batch: batch, op: op, kind: kind, created: nil, failed: failed)
        }
    }

    /// One destination operation landed. Runs on `destinationQueue`.
    private func finishDestination(batch: Int, op: Int, kind: DestinationWork,
                                   created: LinkFileDestination?, failed: Bool) {
        var orphan: LinkFileDestination?
        withState {
            guard var slot = destinationSlot, slot.batch == batch, slot.operation == op else {
                // Stale: the batch this operation belonged to is gone. It may not
                // touch a later batch or a terminal lane, and anything it built is
                // nobody's — discarded below, off the lock, because `abort()` is
                // filesystem work.
                orphan = created
                return
            }
            slot.operation = nil
            if let created { slot.sink = created }
            if case .finalize = kind, !failed {
                // Recorded FIRST: from here the bytes are the user's file, and a
                // discard queued while this was outstanding must not remove them.
                slot.committed = true
            }
            destinationSlot = slot

            if failed {
                if case .finalize = kind, !slot.reported {
                    destinationSlot?.reported = true
                    emitLocked(.inboundFinished(batch: batch, ok: false))
                }
                applyLocked { session.destinationFailed(batch: batch) }
            } else {
                switch kind {
                case .create:
                    applyLocked { session.didCreateDestination(batch: batch) }
                case let .write(_, checkpoint), let .openFile(_, checkpoint):
                    applyLocked { session.didPersist(batch: batch, checkpoint: checkpoint) }
                    noteInboundProgressLocked(batch: batch)
                case .finalize:
                    if destinationSlot?.reported == false {
                        destinationSlot?.reported = true
                        emitLocked(.inboundFinished(batch: batch, ok: true))
                    }
                    applyLocked { session.didFinalizeDestination(batch: batch) }
                }
            }
            // The retirement that was waiting for this operation to land. It runs
            // only now, and by now `committed` is known — which is what stops a
            // terminal that observed an uncommitted destination from discarding a
            // commit that had already succeeded.
            if destinationSlot?.batch == batch, destinationSlot?.discardWhenQuiet == true,
               destinationSlot?.operation == nil {
                releaseDestinationLocked(batch: batch, discard: true)
            }
            drainInboundLocked()
        }
        if let orphan { destinationQueue.async { orphan.abort() } }
    }

    /// Let a destination go.
    ///
    /// A COMMITTED one is forgotten rather than aborted: those bytes are the
    /// user's file. One with an operation still outstanding is not touched at all
    /// — the decision is remembered and applied when the operation lands, because
    /// a discard taken while a commit was in flight would otherwise delete a file
    /// that succeeded a millisecond later.
    private func releaseDestinationLocked(batch: Int?, discard: Bool) {
        guard let batch, var slot = destinationSlot, slot.batch == batch else { return }
        if slot.operation != nil {
            slot.discardWhenQuiet = slot.discardWhenQuiet || discard
            destinationSlot = slot
            return
        }
        destinationSlot = nil
        if !slot.reported { emitLocked(.inboundFinished(batch: batch, ok: slot.committed)) }
        if lastInboundProgress?.batch == batch { lastInboundProgress = nil }
        guard discard, !slot.committed, let sink = slot.sink else { return }
        // NEVER under the lock.
        destinationQueue.async { sink.abort() }
    }

    /// Where the inbound manifest's DURABLE prefix has reached, in bytes of the
    /// whole manifest.
    private func inboundManifestBytesLocked() -> Int? {
        guard session.inboundBatch != nil, let files = session.inboundFiles else { return nil }
        return cumulativeBytes(session.lane.durableCheckpoint.point, in: files)
    }

    /// Where the outbound manifest has reached, in bytes of the whole manifest.
    ///
    /// The lane's PRODUCED FRONTIER, which is a high-water mark — and deliberately
    /// not its send window's cursor. That one is batch-cumulative too, which is
    /// what makes it such a plausible substitute, but a resumed attempt REBASES it
    /// to the point the peer asked from: a receiver whose durable prefix was lost
    /// with the transport asks from further back, and progress would walk
    /// backwards with it.
    private func outboundManifestBytesLocked() -> Int? {
        guard let batch = session.outboundBatch, let files = sources[batch]?.files else {
            return nil
        }
        return cumulativeBytes(session.lane.producedFrontier, in: files)
    }

    private func noteInboundProgressLocked(batch: Int) {
        guard session.inboundBatch == batch, let bytes = inboundManifestBytesLocked() else {
            return
        }
        guard lastInboundProgress?.batch != batch || lastInboundProgress!.bytes < bytes else {
            return
        }
        lastInboundProgress = (batch: batch, bytes: bytes)
        emitLocked(.inboundProgress(batch: batch, durableBytes: bytes))
    }

    private func noteOutboundProgressLocked(batch: Int) {
        guard session.outboundBatch == batch, let bytes = outboundManifestBytesLocked() else {
            return
        }
        guard lastOutboundProgress?.batch != batch || lastOutboundProgress!.bytes < bytes else {
            return
        }
        lastOutboundProgress = (batch: batch, bytes: bytes)
        emitLocked(.outboundProgress(batch: batch, sentBytes: bytes))
    }

    /// Bytes of the WHOLE manifest at a point inside it.
    ///
    /// Progress is the user's question — how much of what they are sending or
    /// receiving is done — and both a per-file offset and an attempt's own byte
    /// count answer a different one. A resumed attempt restarts its counter at the
    /// resume point; the manifest position does not move backwards, so neither
    /// does this.
    private func cumulativeBytes(_ point: ResumePoint, in files: [FileMeta]) -> Int {
        var total = 0
        for (index, file) in files.enumerated() {
            if index < point.index {
                total += file.size
            } else if index == point.index {
                total += min(max(point.offset, 0), file.size)
                break
            } else {
                break
            }
        }
        return total
    }

    // MARK: - producers

    private func startProducerLocked(batch: Int, attempt: Int, resume: ResumePoint?) {
        releaseProducerLocked()
        guard let staged = sources[batch] else {
            applyLocked { session.producerFailed(batch: batch, attempt: attempt) }
            return
        }
        let run = nextRun
        nextRun += 1
        producerRun = ProducerRun(run: run, batch: batch, attempt: attempt, pumping: true)
        // The link's ONE sender, for the whole life of the link.
        let sender = identity.codecs.fileSender
        let maxFrameBytes = self.maxFrameBytes
        let files = staged.files
        let stage = staged.stage
        producerQueue.async { [weak self] in
            guard let self else { return }
            let built: LinkFileProducing
            do {
                // PRISTINE sources for this attempt: a resumed batch re-stages
                // rather than rewinding a source that has already been read.
                let request = LinkFileProducerRequest(batch: batch, attempt: attempt,
                                                      files: files, sources: try stage(),
                                                      resume: resume, sender: sender,
                                                      maxFrameBytes: maxFrameBytes)
                built = try self.makeProducer(request)
            } catch {
                self.withState {
                    guard self.producerRun?.run == run else { return }
                    self.producerRun = nil
                    self.applyLocked { self.session.producerFailed(batch: batch, attempt: attempt) }
                }
                return
            }
            let live: Bool = self.withState {
                guard var current = self.producerRun, current.run == run else { return false }
                current.producer = built
                self.producerRun = current
                return true
            }
            if live { self.pumpProducer(run: run, batch: batch, attempt: attempt) }
        }
    }

    /// Pull one frame, hand it to the session, and come back for the next.
    ///
    /// Runs on `producerQueue` and takes `state` only around the session calls, so
    /// a whole transfer is never materialised and a slow source never blocks the
    /// thread a frame arrived on. It is a bounded pump rather than a spin: when the
    /// transport's own buffer is above the high-water mark it parks on a scheduled
    /// wake-up.
    ///
    /// That polling is deliberate and it is the current WebRTC driver's limit
    /// rather than a preference: there is no low-buffer callback to subscribe to,
    /// so the policy is `sendBufferPollInterval` against `sendBufferHighWater`, and
    /// a real `onBufferedAmountLow` would replace the timer without changing
    /// anything else here. Every poll is correlated to `run`, so a wake-up for a
    /// producer that has been released can neither start a second pump nor revive
    /// a stopped attempt.
    private func pumpProducer(run: Int, batch: Int, attempt: Int) {
        enum Step { case produce(LinkFileProducing), park, stop, done }
        while true {
            let step: Step = withState {
                guard !fileTerminal, !linkEnded, var current = producerRun, current.run == run else {
                    return .done
                }
                if current.stopRequested { return .stop }
                guard let producer = current.producer else { return .done }
                if current.paused { return .park }
                // The backpressure question is deliberately NOT asked here:
                // `bufferedAmount` enters the transport's own serial queue and
                // would be a blocking transport call under this lock. It is asked
                // below, with the lock released.
                current.pumping = true
                producerRun = current
                return .produce(producer)
            }
            switch step {
            case .done:
                withState { if producerRun?.run == run { producerRun?.pumping = false } }
                return
            case .stop:
                // Quiescent: nothing more can be sealed for this attempt. Reported
                // only here, after the loop has left, so a frame sealed across the
                // stop has already been handed back through `produced` and queued
                // ahead of the ordered barrier.
                withState {
                    guard producerRun?.run == run else { return }
                    producerRun = nil
                    applyLocked { session.producerStopped(batch: batch, attempt: attempt) }
                }
                return
            case .park:
                parkProducer(run: run, batch: batch, attempt: attempt)
                return
            case let .produce(producer):
                // Off the lock, both of them: `bufferedAmount` enters the
                // transport's own serial queue, and a source read is real I/O.
                if let live = currentTransportForPolling(), live.bufferedAmount(on: .file) > sendBufferHighWater {
                    parkProducer(run: run, batch: batch, attempt: attempt)
                    return
                }
                let frame: [UInt8]?
                do {
                    frame = try producer.next()
                } catch {
                    withState {
                        guard producerRun?.run == run else { return }
                        producerRun = nil
                        applyLocked { session.producerFailed(batch: batch, attempt: attempt) }
                    }
                    return
                }
                guard let frame else {
                    withState {
                        guard producerRun?.run == run else { return }
                        producerRun = nil
                        applyLocked { session.producerFinished(batch: batch, attempt: attempt) }
                    }
                    return
                }
                withState {
                    // Reported UNCONDITIONALLY, even if this run has been
                    // superseded: the frame is sealed, its nonce is spent in the
                    // one shared sender, and the session is what decides that a
                    // superseded attempt's frame fails the lane closed rather than
                    // being quietly dropped.
                    applyLocked { session.produced(batch: batch, attempt: attempt, frame: frame) }
                    noteOutboundProgressLocked(batch: batch)
                }
            }
        }
    }

    private func currentTransportForPolling() -> LinkLiveTransport? {
        state.lock()
        defer { state.unlock() }
        return transport
    }

    private func parkProducer(run: Int, batch: Int, attempt: Int) {
        withState {
            guard var current = producerRun, current.run == run, !fileTerminal, !linkEnded else {
                if producerRun?.run == run { producerRun?.pumping = false }
                return
            }
            current.pumping = false
            producerRun = current
            arm(.producerPoll(run: run), after: sendBufferPollInterval) { [weak self] token in
                guard let self else { return }
                let go: Bool = self.withState {
                    guard self.timers[.producerPoll(run: run)]?.token == token else { return false }
                    self.timers[.producerPoll(run: run)] = nil
                    guard var current = self.producerRun, current.run == run,
                          !current.pumping, !current.paused, !current.stopRequested,
                          !self.fileTerminal, !self.linkEnded else { return false }
                    current.pumping = true
                    self.producerRun = current
                    return true
                }
                if go { self.producerQueue.async { self.pumpProducer(run: run, batch: batch, attempt: attempt) } }
            }
        }
    }

    private func stopProducerLocked(batch: Int, attempt: Int) {
        guard var current = producerRun, current.batch == batch, current.attempt == attempt else {
            // Nothing is running for this attempt, so it is already quiescent.
            applyLocked { session.producerStopped(batch: batch, attempt: attempt) }
            return
        }
        current.stopRequested = true
        producerRun = current
        cancel(.producerPoll(run: current.run))
        guard !current.pumping else { return }   // the pump reports when it lands
        producerRun = nil
        applyLocked { session.producerStopped(batch: batch, attempt: attempt) }
    }

    private func setProducerPausedLocked(batch: Int, attempt: Int, paused: Bool) {
        guard var current = producerRun, current.batch == batch, current.attempt == attempt else {
            return
        }
        current.paused = paused
        let run = current.run
        guard !paused else {
            producerRun = current
            return
        }
        cancel(.producerPoll(run: run))
        guard !current.pumping, !current.stopRequested else {
            producerRun = current
            return
        }
        current.pumping = true
        producerRun = current
        producerQueue.async { [weak self] in self?.pumpProducer(run: run, batch: batch, attempt: attempt) }
    }

    private func releaseProducerLocked() {
        guard let current = producerRun else { return }
        cancel(.producerPoll(run: current.run))
        producerRun = nil
    }

    // MARK: - terminal

    /// End the FILE lane, and only it.
    ///
    /// It routes through the session's own fail-closed seam rather than keeping a
    /// driver-side flag: a send that could not be written spent a nonce the peer
    /// will never see, and that is a sequence failure the session has to retire its
    /// state for — poisoning the file codecs, naming the batches that die, and
    /// releasing the destination — not something a driver may decide privately
    /// while the session still looks live.
    ///
    /// **It deliberately does not touch the text lane, and cannot.** This driver
    /// holds no reference to `LinkTextLane`, and the transport stays current so
    /// text frames on it keep reaching their route. That is also the honest limit
    /// of the current RTC abstraction: neither transport can close ONE data channel
    /// independently, so a failed file lane is expressed as "no further file frame
    /// is routed, produced or written" rather than as a closed channel. Making it a
    /// closed channel is a transport change, not a driver one — and neither this
    /// nor any of it is reachable while `LINK_BUILD_SUPPORT` and
    /// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` stay false and no factory builds one.
    private func failFileLocked(_ error: LinkFileDriverError) {
        guard !fileTerminal else { return }
        // FIRST: the `closeLane` the seam below returns re-enters here and must
        // find the transition already made.
        fileTerminal = true
        runEffectsLocked(session.failClosed())

        for timer in timers.values { timer.handle.cancel() }
        timers = [:]
        releaseProducerLocked()
        inboundBuffer = []
        inboundBufferedBytes = 0
        outbox.removeAll()
        releaseDestinationLocked(batch: destinationSlot?.batch, discard: true)
        // Anything the session did not name — a lane that was already poisoned
        // names nothing a second time.
        let stranded = sources.keys.sorted()
        for id in stranded { sources[id] = nil }
        outboundSucceeded = nil
        lastOutboundProgress = nil
        if !stranded.isEmpty { emitLocked(.batchesFailed(stranded)) }
        emitLocked(.failed(error))
    }

    // MARK: - what a test or an owner above may read

    /// Barrier: returns once every destination and producer step dispatched so far
    /// has run, including the ones those completions dispatched in turn.
    ///
    /// Internal, and it exists so a test can be deterministic about work this
    /// driver deliberately does off its own lock, on two independent queues.
    /// Production never needs it: the completions drive themselves.
    func settle(rounds: Int = 8) {
        for _ in 0..<rounds {
            producerQueue.sync {}
            destinationQueue.sync {}
        }
        flush()
    }

    /// The FILE lane is terminal. Says nothing about the link, which may still be
    /// carrying a conversation on the same transport.
    public var isTerminal: Bool { state.lock(); defer { state.unlock() }; return fileTerminal }
    /// The held link ended. Nothing routes in either lane.
    public var isLinkEnded: Bool { state.lock(); defer { state.unlock() }; return linkEnded }
    public var bufferedInboundFrames: Int {
        state.lock(); defer { state.unlock() }; return inboundBuffer.count
    }
    public var activeOutboundBatch: Int? {
        state.lock(); defer { state.unlock() }; return session.outboundBatch
    }
    public var activeInboundBatch: Int? {
        state.lock(); defer { state.unlock() }; return session.inboundBatch
    }
    public var retainedSourceBatches: [Int] {
        state.lock(); defer { state.unlock() }; return sources.keys.sorted()
    }

    /// The manifest position each direction has reached, BEFORE the monotonic
    /// clamp the progress events apply.
    ///
    /// Internal, and it exists because a clamp can hide a source that rewinds: a
    /// test that only ever sees clamped events cannot tell a high-water mark from
    /// a cursor that went backwards and was suppressed on the way up again.
    var outboundManifestBytes: Int? {
        state.lock(); defer { state.unlock() }; return outboundManifestBytesLocked()
    }
    var inboundManifestBytes: Int? {
        state.lock(); defer { state.unlock() }; return inboundManifestBytesLocked()
    }
}
