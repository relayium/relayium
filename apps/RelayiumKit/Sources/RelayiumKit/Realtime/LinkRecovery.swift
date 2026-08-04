import Foundation

/// How long a link may stay interrupted with no transport under it.
///
/// The deployed web client's `LINK_RECOVERY_WINDOW_MS`, in seconds. It is the
/// legacy one-shot resume window and means the same thing here: the peer that
/// dropped is the same peer, and a bounded wait is cheaper for a user than
/// re-comparing six digits.
public let LINK_RECOVERY_WINDOW: TimeInterval = 90

/// How long a failed rebuild attempt waits before the next one, on the
/// initiator only. The deployed web client's `LINK_RECOVERY_RETRY_MS`.
public let LINK_RECOVERY_RETRY: TimeInterval = 1.5

/// A transport a link can be holding, as the recovery coordinator needs to see
/// it: something it can identify and something it can release.
///
/// Deliberately this small. The coordinator never sends on the current
/// transport, never reads its buffers and never inspects its identity — the
/// lanes are the owner's — so anything more here would be surface a stale
/// transport could be operated through.
public protocol LinkTransportHandle: AnyObject {
    func close()
}

/// One authenticated replacement transport, as the coordinator drives it.
///
/// Exactly `WebRTCLinkReplacementTransport`'s existing public shape, and that is
/// the point: the seam exists so the orchestration below can be exercised
/// without two negotiating endpoints, not so a second dialect can grow beside
/// the driver. A conformance that needed an adapter would mean this file had
/// been written against a transport that does not exist.
///
/// ## The callback slots are shared state
///
/// **A conformer MUST synchronize the four slots below.** They are written from
/// a different thread than the one that reads them, and not occasionally: the
/// coordinator installs all four when it builds a rebuild and clears all four —
/// `LinkRecoveryCoordinator.detach` — from whichever thread reported that the
/// attempt lost its race or that the link ended, while the transport is reading
/// them on its own queue to publish, to deliver a frame or to report a failure.
/// As plain stored properties that is an ordinary data race, and Thread
/// Sanitizer reports it as one.
///
/// Guarding the slots is the whole requirement; nothing here asks a conformer to
/// hold anything while it CALLS one. The opposite, in fact: each closure should
/// be read into a local and invoked with the guard released, because the
/// coordinator's handlers run under a lock of their own and are explicitly
/// allowed to call straight back into the transport — `close()` from inside
/// `onReady` is a documented case. A lock held across that would be an
/// inversion waiting to happen. `WebRTCLinkReplacementTransport` does exactly
/// this, with a leaf `NSLock` around the slots alone.
public protocol LinkReplacementTransport: LinkTransportHandle {
    /// Both lanes are open again under the identity this transport was given.
    /// The coordinator's handler for it runs SYNCHRONOUSLY inside the driver's
    /// publication, before any captured frame replays — see
    /// `LinkEstablishment.publish`.
    var onReady: ((LinkIdentity) -> Void)? { get set }
    var onFrame: ((LinkLane, [UInt8]) -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    func start()
    /// Hand over the authenticated `resume` offer that caused this transport to
    /// be built at all. The driver verifies it again; this is not a shortcut
    /// past its own policy.
    func receive(from: String, signal: JSONValue)
}

/// Builds ONE replacement transport under an identity that already exists.
///
/// It is handed the held identity rather than the ingredients of one, which is
/// what keeps "a rebuild cannot construct a second `LinkCodecs`" a property of
/// the type system rather than of a factory's good behaviour.
public typealias LinkReplacementFactory = (LinkIdentity) throws -> LinkReplacementTransport

/// One scheduled wake-up the coordinator can take back.
public protocol LinkRecoveryTimer: AnyObject {
    func cancel()
}

/// The coordinator's whole notion of time.
///
/// Injected for the reason `LinkDeadlineClock` takes a queue: a ninety-second
/// window and a 1.5-second retry cadence are decisions, and a decision that can
/// only be observed by waiting ninety seconds against a live peer is a decision
/// nobody re-checks. Every bound here is a scheduled wake-up, so this is the
/// only clock the coordinator needs — the transports keep their own uptime
/// deadlines, which are theirs to enforce.
public protocol LinkRecoveryScheduler: AnyObject {
    func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer
}

/// Where the held link is. Not the same question as `LinkPhase`, which is the
/// whole room's admission state; this is one authentication's transport.
public enum LinkRecoveryPhase: Equatable {
    /// A transport is current.
    case open
    /// Authenticated and held, with no transport under it.
    case interrupted
    /// Terminal. Nothing revives it.
    case ended
}

/// Why a held link ended. Every case is terminal for the authentication, which
/// is what makes this distinct from `LinkTransportError`: that ends a transport,
/// this ends the link the transport belonged to.
public enum LinkRecoveryError: Error {
    /// The owner's recorded answer was "nothing here needs recovering".
    case declined
    /// The owner's recovery policy threw. It recorded nothing, so holding a link
    /// open on the strength of an exception is not available.
    case policyFailed(Error)
    case windowExpired
    /// Explicit close, stop, or owner cancellation.
    case cancelled
    /// The peer left on purpose.
    case peerDeparted
    /// A rebuild published an identity that is not this link's. Terminal, and
    /// deliberately not a retryable attempt failure — see `identityMatches`.
    case identityMismatch
    /// The owner could not take the rebuilt lanes over. The replacement is never
    /// made current, so the lanes end up owned by nobody.
    case attachFailed(Error)
    /// A failure that proves the reused receiver sequences are no longer safe.
    case unrecoverable(Error)
}

/// The coordinator was driven without an integration it cannot substitute for.
///
/// Neither case is a transport failure or a peer's doing: both are a local
/// wiring mistake, and both surface through `LinkRecoveryError.attachFailed`
/// because they fail in the same place a throwing `onAttach` does — inside the
/// publication barrier, before the replacement is ever made current.
///
/// `Equatable` so an owner can tell the two apart, and act on them, without
/// matching on a description.
public enum LinkRecoveryIntegrationError: Error, Equatable {
    /// A rebuild published and there was no `onAttach` to hand it to.
    ///
    /// Nothing takes the lanes over, so treating the absence as a successful
    /// attach would make a transport current whose frames reach nobody at all —
    /// which is the one outcome the attach barrier exists to prevent.
    case missingAttachHandler
    /// `onAttach` returned and no `onFrame` was installed.
    ///
    /// The driver replays its pre-attachment capture the instant publication
    /// returns, so a missing handler here is not a hook that fires later: it is
    /// the captured backlog going to nothing. Those frames belong to receiver
    /// codecs whose sequence has to stay continuous, and a hole in it is not a
    /// missed message but a lane that can never be used again.
    case missingFrameHandler
}

/// What local intent raised during a gap resolves to.
public enum LinkRecoveryJoin: Equatable {
    /// Registered on the one recovery outcome.
    case joined
    /// A held link belongs to another peer, gap or no gap.
    case busy
    /// There is no gap to join.
    case unavailable
}

/// The owner of ONE authenticated `link/1` across the loss of its transport.
///
/// ## What it is for
///
/// `WebRTCLinkReplacementTransport` can rebuild both lanes under an
/// authentication that already exists. Nothing constructed one. This is the
/// thing that does: it turns a terminal current transport into ONE bounded
/// recovery gap, drives or awaits a rebuild inside that gap, and publishes the
/// winner under the identity the link already had.
///
/// The invariant everything below serves is the one the whole feature rests on:
/// **a link owns exactly one `(content key, direction)` AEAD sequence for its
/// lifetime.** So this object holds the `LinkIdentity` — and with it the one
/// `LinkCodecs` — across the gap and never lets go of it. It derives no keys,
/// constructs no codecs, announces no SAS and never advances
/// `authenticationGeneration`: recovery is the same authentication step on a new
/// wire, and a user who compared six digits must not be asked to compare them
/// again.
///
/// ## The shape of one gap
///
/// A dying transport reports `failed` and then `closed`. That is ONE gap, and
/// the dedupe is structural rather than a second flag: the transport stops being
/// current in the same synchronous step that handles its first terminal event,
/// so every later callback from it — including the one its own `close()`
/// produces — finds itself stale. The owner's recovery policy is therefore asked
/// exactly once per transport.
///
/// That policy is `deps.onTransportLost` in `web/src/lib/peer-link.svelte.ts`
/// and means the same thing: the owner synchronously suspends both lane state
/// machines and then answers whether anything recorded there is worth a
/// recovery. The ANSWER is what this object acts on. Re-reading lane status
/// afterwards would be reading state the owner has by then already mutated,
/// which is how "suspend, then decide" turns into "decide from what suspending
/// did".
///
/// ## Who drives, and for how long
///
/// The role the original connection settled, never a recomputed one. The
/// original initiator attempts immediately and retries a failed attempt every
/// `LINK_RECOVERY_RETRY`; the original responder starts nothing and answers the
/// initiator's authenticated offer. Two drivers would be rebuild glare: two
/// PeerConnections racing into one pair of lanes. One `LINK_RECOVERY_WINDOW`
/// bounds the whole gap, and its expiry is final — no callback and no timer
/// revives it.
///
/// ## Threading
///
/// **Its own, by one recursive lock**, and that is a property of this code rather
/// than a requirement on an integration. There is no serialization context an
/// owner could supply that would cover this object anyway: it installs its
/// callbacks directly into replacement drivers, each of which has a private
/// serial queue of its own; its public calls arrive from the signalling and
/// session side; and its timers wake on whatever queue the scheduler chose. Those
/// are already three or more contexts before any owner is involved, so "the owner
/// serializes" would be an invariant nothing could enforce.
///
/// Every mutable field, every stored hook and every read or write of `phase` is
/// taken under `lock`, and the owner's hooks — `onTransportLost`, `onAttach`,
/// `onFrame`, `onEnded` and every `join` completion — RUN under it. Holding it
/// across owner code is the design, not an oversight, and it buys the two things
/// that matter:
///
///  - **The publication barrier stays synchronous.** `onReady` arrives on a
///    driver's private queue and must attach before it returns, because the
///    driver replays its pre-attachment capture the instant it does. Hopping to
///    another queue to take a lock would break that ordering outright, and — if
///    `onAttach` then sent on the new transport — could deadlock against the very
///    queue that is waiting for `onReady`.
///  - **Re-entry is legal.** An owner hook, a waiter completion or `onEnded` may
///    call `stop`, `join`, `peerDeparted` or anything else here on the same
///    thread; the lock is recursive, so it proceeds, and the terminal and
///    staleness guards decide the outcome. A second thread trying the same thing
///    blocks and then finds the world the first one left.
///
/// The one thing an owner must NOT do is block one of these callbacks on another
/// thread that is itself trying to enter this coordinator. That is the ordinary
/// price of a re-entrant lock, and it is the whole of the contract.
///
/// Nothing here ever blocks on a transport. `LinkTransportHandle.close`,
/// `start` and `receive` are the only calls it makes, and
/// `WebRTCLinkReplacementTransport` implements all three as `nowOrLater`/`later`
/// — inline when already on its queue, asynchronous otherwise — so this lock can
/// never be held waiting for a driver queue that is waiting for this lock. The
/// `send` and `bufferedAmount` calls that DO block are deliberately absent from
/// both seams above, which is what keeps that argument structural. An owner
/// sending from inside `onAttach` is on the driver's own queue already, so its
/// `queue.sync` runs inline and blocks on nothing.
///
/// The two other locks this one is ever held across are both leaves, which is
/// what makes the ordering total rather than merely usual:
///
///  - **`LinkAdmission`'s.** Only the lifecycle transitions are called from
///    here, and none of them invokes owner code — `selfId` and `canAcceptLink`
///    are evaluated outside that lock by construction. So the order is always
///    this lock, then admission's, and admission never reaches back.
///  - **A driver's callback-slot lock.** `detach` writes the four slots; the
///    driver reads them and releases the lock before invoking anything. Nothing
///    is ever called while it is held.
///
/// The scheduler chooses only where a wake-up is DELIVERED. It is not this
/// object's lock and does not serialize anything for it.
///
/// ## What this is NOT
///
/// It is the coordinator, not the feature. `LINK_TRANSPORT_REPLACEMENT_SUPPORTED`
/// and `LINK_BUILD_SUPPORT` both remain false, and each of these is its own
/// piece of work:
///
///  - **Durable file recovery.** No checkpoints and no `RESUME_REQ`/
///    `RESUME_START`, so a rebuilt lane resumes a connection, not a transfer.
///  - **File- and text-lane integration.** `onTransportLost` and `onAttach` are
///    where a lane suspends and re-attaches; no lane implements either yet, and
///    a text lane that proved its codecs unsafe to reuse has no policy here.
///  - **END acknowledgement timing.** Untouched.
///  - **ICE restart.** Absent on purpose in the driver, and this object does not
///    supply one: a rebuild is a whole new PeerConnection.
///  - **Admission and UI lifecycle.** The `LinkAdmission` transitions below are
///    driven; routing, presentation, background/foreground behaviour and the
///    session model are not.
///  - **Live evidence.** Native↔native replacement interop exists
///    (`WebRTCLinkReplacementInteropTests`); a coordinated gap over a real
///    network, and anything native↔Web, does not.
public final class LinkRecoveryCoordinator: @unchecked Sendable {

    /// Everything below, including the owner hooks. Recursive on purpose — see
    /// this type's "Threading" section.
    private let lock = NSRecursiveLock()

    /// Run `body` with `lock` held.
    ///
    /// The lock is taken BY VALUE first, and that is load-bearing rather than
    /// style. Owner hooks run under this lock, and `onEnded` is precisely where
    /// an owner finishes with this object — a session model tearing down drops
    /// its last reference there, deallocating this coordinator while the call
    /// that ended it is still on the stack. Reading `self.lock` again in the
    /// `defer` would then unlock through a freed object. A local strong
    /// reference to the lock costs one retain and makes the unlock independent
    /// of whether `self` survived the callback.
    private func locked<T>(_ body: () -> T) -> T {
        let lock = self.lock
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    // MARK: - owner hooks

    /// The transport under this link is gone. Suspend both lane state machines,
    /// then answer whether anything recorded there needs recovering.
    ///
    /// Called at most once per transport, synchronously, before anything is
    /// scheduled or allocated. The answer is recorded; it is never re-derived
    /// from lane status afterwards. Returning false — or throwing — ends the
    /// link rather than holding it.
    ///
    /// Stored under `lock` and CALLED under it — see this type's "Threading"
    /// section. An owner may replace it from any thread; it is not read from a
    /// stale copy.
    public var onTransportLost: ((LinkIdentity) throws -> Bool)? {
        get { locked { _onTransportLost } }
        set { locked { _onTransportLost = newValue } }
    }

    /// Take the rebuilt lanes over, under the identity this link has had all
    /// along.
    ///
    /// Runs INSIDE the replacement's `onReady`, which is inside the driver's
    /// publication — so it happens before a single captured frame replays. That
    /// is the whole ordering contract: those frames belong to receiver codecs
    /// that already exist, and one delivered to nothing is not a missed message
    /// but a lane that can never be used again.
    ///
    /// Throwing fails closed. Only a successful attach makes the replacement
    /// current — and an ABSENT hook is not one: a rebuild that reaches this
    /// point with nothing wired here ends the link with
    /// `attachFailed(LinkRecoveryIntegrationError.missingAttachHandler)` rather
    /// than publishing lanes nobody owns.
    public var onAttach: ((LinkIdentity, LinkReplacementTransport) throws -> Void)? {
        get { locked { _onAttach } }
        set { locked { _onAttach = newValue } }
    }

    /// One raw frame off the CURRENT transport's lane — including the replayed
    /// backlog, which arrives immediately after `onAttach` returns. Frames from
    /// any other transport are dropped.
    ///
    /// REQUIRED by the time `onAttach` returns, and installing it there is a
    /// perfectly ordinary way to satisfy that: forwarding frames is part of
    /// taking the lanes over. What is not available is publishing without one.
    /// The replay follows the attach with nothing in between, so a handler
    /// installed later is a captured backlog already dropped — and a rebuild
    /// that finds this nil at that moment ends the link with
    /// `attachFailed(LinkRecoveryIntegrationError.missingFrameHandler)` instead.
    public var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { locked { _onFrame } }
        set { locked { _onFrame = newValue } }
    }

    /// The held link ended. Fires at most once, after every waiter has been
    /// finished and everything this object held has been released.
    public var onEnded: ((LinkRecoveryError) -> Void)? {
        get { locked { _onEnded } }
        set { locked { _onEnded = newValue } }
    }

    // MARK: - held state, all of it guarded by `lock`

    /// The one authenticated identity, and with it the one `LinkCodecs`, for the
    /// whole life of this coordinator. Never replaced, never re-derived — and
    /// therefore the one thing here that needs no lock.
    public let identity: LinkIdentity

    /// Where the held link is, as anybody outside may read it.
    ///
    /// A snapshot, and only ever that: by the time a caller acts on it another
    /// thread may have moved on. Every decision inside this object reads
    /// `_phase` under the lock it is about to act under, which is why none of
    /// them goes through here.
    public var phase: LinkRecoveryPhase { locked { _phase } }

    private var _onTransportLost: ((LinkIdentity) throws -> Bool)?
    private var _onAttach: ((LinkIdentity, LinkReplacementTransport) throws -> Void)?
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    private var _onEnded: ((LinkRecoveryError) -> Void)?

    private var _phase: LinkRecoveryPhase = .open

    private let factory: LinkReplacementFactory
    private let scheduler: LinkRecoveryScheduler
    private let admission: LinkAdmission?

    /// The transport the lanes are on. Nil for the whole gap — which is exactly
    /// what makes a dying transport's second terminal callback inert.
    private var current: LinkTransportHandle?
    /// `current`, when this object built and wired it. The initial transport is
    /// the owner's and its callbacks are the owner's to remove.
    private var currentReplacement: LinkReplacementTransport?

    /// The ONE rebuild slot, as three states rather than one nullable transport.
    ///
    /// `.allocating` is the whole reason this is an enum. Building a transport
    /// runs an arbitrary owner-supplied factory, and a slot that is only taken
    /// once that factory RETURNS is not taken while it runs: a factory that
    /// re-enters — a session model draining a queued signal on its way through —
    /// finds the slot free, allocates a second PeerConnection into the same pair
    /// of lanes, and can do so to any depth until the stack gives out. The
    /// reservation exists so the cheap duplicate checks and the re-entrant path
    /// see the same "taken" the claimed state does.
    private enum AttemptSlot {
        /// Nothing is being built and nothing is in flight.
        case free
        /// Reserved for the factory call that is running right now.
        case allocating
        /// One transport owns the slot until it publishes or ends.
        case claimed(LinkReplacementTransport)
    }
    private var slot: AttemptSlot = .free

    /// Whether an attempt could be started right now. The cheap check an inbound
    /// offer is refused by, and deliberately true in neither in-flight state.
    private var attemptSlotIsFree: Bool {
        if case .free = slot { return true }
        return false
    }

    /// The transport in flight, once one exists. Nil while the factory is still
    /// running, which is what `attemptSlotIsFree` exists to say instead.
    private var candidate: LinkReplacementTransport? {
        if case let .claimed(transport) = slot { return transport }
        return nil
    }

    private var windowTimer: LinkRecoveryTimer?
    private var retryTimer: LinkRecoveryTimer?
    private var waiters: [(Result<LinkIdentity, Error>) -> Void] = []

    /// - Parameters:
    ///   - identity: the authenticated link this object holds. Its role decides
    ///     who drives a rebuild, and it is never recomputed from peer ids: both
    ///     sides must keep the offerer/responder split their first connection
    ///     produced.
    ///   - current: the transport the lanes are on right now.
    ///   - admission: driven through `didInterrupt` / `didBeginReplacingTransport`
    ///     / `didEndReplacingTransport` / `didReplaceTransport` / `didFail`, so
    ///     the room's one-link rule and this object's gap cannot disagree about
    ///     whether a rebuild is in flight.
    public init(identity: LinkIdentity,
                current: LinkTransportHandle,
                factory: @escaping LinkReplacementFactory,
                scheduler: LinkRecoveryScheduler,
                admission: LinkAdmission? = nil) {
        self.identity = identity
        self.current = current
        self.factory = factory
        self.scheduler = scheduler
        self.admission = admission
    }

    // MARK: - one terminal event, one gap

    /// The current transport reported a failure, or that it has closed.
    ///
    /// Both go here, and both are the same question. A transport that is not the
    /// current one is answered by doing nothing: a stale transport may fail
    /// itself, but it must never end a link it no longer belongs to.
    public func transportTerminated(_ transport: AnyObject, error: Error?) {
        locked { transportTerminatedLocked(transport, error: error) }
    }

    private func transportTerminatedLocked(_ transport: AnyObject, error: Error?) {
        // `current` is non-nil in exactly one phase, so the phase test is a
        // second reading of the same invariant rather than a separate condition.
        // It is kept because that invariant is what the whole dedupe rests on: an
        // edit that left a transport current across a gap would otherwise turn a
        // stale callback into a second recovery in silence.
        guard _phase == .open, let live = current, live === transport else { return }
        // BEFORE anything else, and before any owner code runs: from here the
        // dying transport is not current, so its `close()` below — and the
        // `onClose` a driver emits after its `onError` — re-enter this method
        // inertly. That is the dedupe; there is deliberately no second flag to
        // drift out of step with it.
        current = nil
        let replacement = currentReplacement
        currentReplacement = nil
        if let replacement { detach(replacement) }
        live.close()

        if let error, isUnrecoverable(error) {
            endLocked(.unrecoverable(error), admission: .failed)
            return
        }
        let hold: Bool
        do {
            hold = try _onTransportLost?(identity) ?? false
        } catch {
            endLocked(.policyFailed(error), admission: .failed)
            return
        }
        guard hold else {
            // The owner declined to RECOVER this transport, which says nothing
            // about whether it broke. A transport that closed cleanly is an
            // ordinary end of session — the web client's `close()` path — and
            // leaves the room free; one that failed leaves a failed link.
            endLocked(.declined, admission: error == nil ? .closed : .failed)
            return
        }
        // The hook is arbitrary owner code that may have re-entered and ended
        // this link — a user pressing disconnect while its lanes suspend, a peer
        // already known to have left. Its "hold" answer describes the world it
        // was asked about, not the one it returns into, so a link that ended
        // underneath it must not be resurrected here.
        guard _phase == .open else { return }
        _phase = .interrupted
        admission?.didInterrupt()
        beginRecoveryLocked()
    }

    /// The peer left the room, or announced an authenticated departure.
    ///
    /// Rebuilding toward a peer that has gone spends real ICE and TURN
    /// allocations for the whole window and answers everybody else `busy` while
    /// it does. A peer that left on purpose is a normal end, not a fault.
    public func peerDeparted(_ peerId: String) {
        guard peerId == identity.peerId else { return }
        locked { endLocked(.peerDeparted, admission: .closed) }
    }

    /// Explicit close, stop, or owner cancellation.
    public func stop() {
        locked { endLocked(.cancelled, admission: .closed) }
    }

    // MARK: - the recovery window

    private func beginRecoveryLocked() {
        windowTimer = scheduler.schedule(after: LINK_RECOVERY_WINDOW) { [weak self] in
            guard let self else { return }
            self.locked { self.expireWindowLocked() }
        }
        // The role the first connection settled. The responder starts nothing:
        // it answers the initiator's authenticated offer, so there is no rebuild
        // glare and no new signal type.
        guard identity.role == .initiator else { return }
        beginAttemptLocked(offer: nil)
    }

    private func expireWindowLocked() {
        windowTimer = nil
        guard _phase == .interrupted else { return }
        endLocked(.windowExpired, admission: .failed)
    }

    private func scheduleRetryLocked() {
        guard _phase == .interrupted, identity.role == .initiator, retryTimer == nil else { return }
        retryTimer = scheduler.schedule(after: LINK_RECOVERY_RETRY) { [weak self] in
            guard let self else { return }
            self.locked {
                self.retryTimer = nil
                self.beginAttemptLocked(offer: nil)
            }
        }
    }

    // MARK: - one attempt

    /// - Parameter offer: the authenticated `resume` offer that caused this
    ///   attempt, on the responder side. The driver verifies it again; handing
    ///   it over only saves the peer a retransmission.
    private func beginAttemptLocked(offer: JSONValue?) {
        guard _phase == .interrupted, attemptSlotIsFree else { return }
        // RESERVED BEFORE THE FACTORY RUNS. Everything past this line is
        // arbitrary owner code, and until the slot says "taken" a re-entrant
        // call would find it free — see `AttemptSlot`.
        slot = .allocating
        admission?.didBeginReplacingTransport()
        let transport: LinkReplacementTransport
        do {
            transport = try factory(identity)
        } catch {
            // A factory may end this link and THEN fail. The reservation is
            // given back only if it is still ours: `endLocked` has already freed
            // the slot and settled admission, and re-announcing an attempt that
            // ended with the link would put admission back into a rebuild that
            // no longer exists.
            guard _phase == .interrupted, case .allocating = slot else { return }
            slot = .free
            // Not being able to build a PeerConnection right now is an ordinary
            // attempt failure: the next interval may find a working one.
            admission?.didEndReplacingTransport()
            scheduleRetryLocked()
            return
        }
        // Building a transport is owner code too, and it can end this link the
        // same way the hooks above can. A transport built for a gap that closed
        // underneath it is released here rather than wired and started, because
        // nothing after this point would ever close it.
        guard _phase == .interrupted, case .allocating = slot else {
            transport.close()
            return
        }
        // Claimed before it is wired, so a driver that fails synchronously
        // inside `start()` finds itself recognised rather than stale.
        slot = .claimed(transport)
        // Callbacks FIRST, and all of them, so nothing this transport does can
        // reach a handler that does not exist yet — least of all a peer that
        // speaks the instant its lanes open.
        let id = ObjectIdentifier(transport)
        transport.onReady = { [weak self] ready in
            guard let self else { return }
            self.locked { self.replacementReadyLocked(id, ready) }
        }
        transport.onFrame = { [weak self] lane, bytes in
            guard let self else { return }
            self.locked { self.replacementFrameLocked(id, lane, bytes) }
        }
        transport.onError = { [weak self] error in
            guard let self else { return }
            self.locked { self.replacementEndedLocked(id, error: error) }
        }
        transport.onClose = { [weak self] in
            guard let self else { return }
            self.locked { self.replacementEndedLocked(id, error: nil) }
        }
        if let offer { transport.receive(from: identity.peerId, signal: offer) }
        transport.start()
    }

    /// The rebuild is up. Prove it is THIS link's, hand it to the owner, and only
    /// then let it become current.
    private func replacementReadyLocked(_ id: ObjectIdentifier, _ ready: LinkIdentity) {
        guard _phase == .interrupted,
              let transport = candidate,
              ObjectIdentifier(transport) == id else { return }
        guard identityMatches(ready) else {
            // Not a retryable attempt failure. A factory that can publish a
            // different identity can publish a second `LinkCodecs`, which is two
            // AEAD sequences counting from zero under one pair of session keys —
            // so the only safe thing left is to fail the held link closed.
            endLocked(.identityMismatch, admission: .failed)
            return
        }
        // No hook is not a successful attach. `try _onAttach?(…)` succeeds on a
        // nil hook, and "succeeded" is precisely what makes a replacement
        // current — so an owner that never wired one would get a live transport
        // whose frames reach nobody. The candidate slot is still held here, as
        // it is for a throw, so `end` has something to close.
        guard let attach = _onAttach else {
            endLocked(.attachFailed(LinkRecoveryIntegrationError.missingAttachHandler),
                      admission: .failed)
            return
        }
        do {
            // Synchronously, inside the driver's publication and therefore
            // before its captured backlog replays.
            try attach(ready, transport)
        } catch {
            endLocked(.attachFailed(error), admission: .failed)
            return
        }
        // Same rule as the recovery policy above: an owner that ended the
        // session while taking the lanes over has already closed this
        // replacement, and publishing it now would make a dead transport
        // current. A successful return is not a promise that the gap survived.
        guard _phase == .interrupted, candidate === transport else { return }
        // AFTER the hook, which is entitled to install this as part of taking
        // the lanes over, and after the guard above, which is what decides the
        // gap still exists to publish into. Before publication, because the
        // driver replays its captured backlog the instant `onReady` returns: a
        // handler installed any later is a backlog already discarded, and those
        // frames belong to receiver codecs whose sequence has to stay
        // continuous. Forwarding them nowhere is the same failure as never
        // attaching, one step later, so it fails the same way.
        guard _onFrame != nil else {
            endLocked(.attachFailed(LinkRecoveryIntegrationError.missingFrameHandler),
                      admission: .failed)
            return
        }
        slot = .free
        current = transport
        currentReplacement = transport
        _phase = .open
        cancelTimersLocked()
        // The SAME authentication step on a new transport, which is why this is
        // `didReplaceTransport` and not `didOpen`: a peer that has already spent
        // its leave budget must not earn a fresh one by dropping the connection.
        admission?.didReplaceTransport(peerId: identity.peerId)
        settleWaitersLocked(.success(ready))
    }

    /// Everything that identifies the AUTHENTICATION has to survive a rebuild —
    /// above all the `LinkCodecs` object itself, compared by identity because
    /// equal contents would be exactly the catastrophe.
    private func identityMatches(_ ready: LinkIdentity) -> Bool {
        ready.peerId == identity.peerId
            && ready.role == identity.role
            && ready.sas == identity.sas
            && ready.authenticationGeneration == identity.authenticationGeneration
            && ready.codecs === identity.codecs
    }

    private func replacementFrameLocked(_ id: ObjectIdentifier,
                                        _ lane: LinkLane,
                                        _ bytes: [UInt8]) {
        guard _phase != .ended,
              let live = currentReplacement,
              ObjectIdentifier(live) == id else { return }
        _onFrame?(lane, bytes)
    }

    /// One replacement ended — either the live one, which opens a new gap, or a
    /// candidate, which costs at most a retry.
    private func replacementEndedLocked(_ id: ObjectIdentifier, error: Error?) {
        if let live = currentReplacement, ObjectIdentifier(live) == id {
            transportTerminatedLocked(live, error: error)
            return
        }
        guard let transport = candidate, ObjectIdentifier(transport) == id else { return }
        slot = .free
        // Before the close below, so the `onClose` a driver emits after its
        // `onError` reaches nothing. That pair is one ended attempt.
        detach(transport)
        admission?.didEndReplacingTransport()
        if let error, isUnrecoverable(error) {
            transport.close()
            endLocked(.unrecoverable(error), admission: .failed)
            return
        }
        transport.close()
        scheduleRetryLocked()
    }

    /// The failures a rebuild cannot be the answer to.
    ///
    /// Capture overflow means an ADMITTED frame was dropped before a consumer
    /// existed, which is the one thing the reused receiver codecs cannot
    /// tolerate: the sequence they continue now has a hole in it. Another
    /// transport onto that is not recovery.
    private func isUnrecoverable(_ error: Error) -> Bool {
        (error as? LinkTransportError) == .captureOverflow
    }

    // MARK: - inbound rebuild offers

    /// Consume an inbound `resume` offer for the interrupted link.
    ///
    /// The tag is verified HERE, against this link's own `resumeAuth`, before an
    /// offer is allowed to allocate a PeerConnection. The driver verifies it
    /// again — it never trusts a caller's word for who sent something — but by
    /// then it has already allocated, begun ICE, and consumed the one rebuild
    /// slot. `LinkAdmission.route` is the layer above and decides only that a
    /// signal is worth a verification; it never spends one.
    ///
    /// Every cheap check runs before the HMAC — phase, peer, role, shape, tag
    /// length, and the allocation slot — so a forged or replayed flood cannot buy
    /// verification work, and cannot deny the genuine peer its one allocation.
    /// Anything that does not pass is dropped in SILENCE: answering would tell a
    /// signalling relay which peer holds a live link, and failing would hand any
    /// stranger on the socket a one-message kill switch for a gap it otherwise
    /// cannot touch.
    public func receiveResumeOffer(from: String, signal: JSONValue) {
        locked { receiveResumeOfferLocked(from: from, signal: signal) }
    }

    private func receiveResumeOfferLocked(from: String, signal: JSONValue) {
        guard _phase == .interrupted else { return }
        guard from == identity.peerId else { return }
        // The role the ORIGINAL connection settled. The initiator drives its own
        // rebuild; consuming an inbound offer there would put two
        // PeerConnections into the same pair of lanes.
        guard identity.role == .responder else { return }
        guard signalGeneration(signal) == .resume else { return }
        guard parseSDP(signal)?.type == "offer" else { return }
        guard case let .object(fields) = signal,
              case let .string(auth)? = fields["auth"],
              auth.count == LINK_AUTH_TAG_LENGTH else { return }
        // Ahead of the HMAC, so a duplicate costs nothing — and behind every
        // other refusal, so a rejected signal never consumes the slot. It reads
        // the RESERVATION, not just a claimed transport, so an offer arriving
        // while the factory is still building sees the slot as taken.
        guard attemptSlotIsFree else { return }
        guard resumeSignalIsAuthentic(signal, key: identity.codecs.resumeAuthKey) else { return }
        beginAttemptLocked(offer: signal)
    }

    // MARK: - mid-gap intent

    /// Join the one recovery outcome for this link.
    ///
    /// Intent raised mid-gap must land on the rebuilt link. The two failures this
    /// exists to prevent are attaching to the dead transport the link still
    /// points at, and opening a second connection beside the rebuild.
    ///
    /// `complete` runs exactly once: on the successful attach, or on whatever
    /// ended the link.
    @discardableResult
    public func join(peerId: String,
                     _ complete: @escaping (Result<LinkIdentity, Error>) -> Void)
    -> LinkRecoveryJoin {
        locked {
            // A held link belongs to its peer whether or not it currently has a
            // transport. Another peer is refused for the whole gap, exactly as
            // it would be while the link was open.
            guard peerId == identity.peerId else { return .busy }
            guard _phase == .interrupted else { return .unavailable }
            waiters.append(complete)
            return .joined
        }
    }

    // MARK: - the one terminal path

    /// What a terminal reason means to the room's admission state.
    ///
    /// Deliberately a decision at every call site rather than a mapping derived
    /// from `LinkRecoveryError`, because the two are not the same question and
    /// one of the reasons is genuinely ambiguous on its own: `declined` after a
    /// clean close is an ordinary end of session, and `declined` after a failure
    /// is a failure the owner chose not to recover.
    private enum AdmissionEnd {
        /// A normal end: the room is free again, and the established role, the
        /// leave budget and the timeout marks reset with it.
        case closed
        /// Something broke. The link is reported as failed.
        case failed
    }

    private func endLocked(_ error: LinkRecoveryError, admission outcome: AdmissionEnd) {
        guard _phase != .ended else { return }
        _phase = .ended
        cancelTimersLocked()
        let candidate = self.candidate
        let current = self.current
        let replacement = self.currentReplacement
        // Freed before any of the closes below, including the reservation: a
        // factory still on the stack must find the slot gone rather than its own.
        slot = .free
        self.current = nil
        self.currentReplacement = nil
        // Released BEFORE the closes, so a transport dying under us cannot call
        // back into a coordinator that has already finished its waiters — and so
        // nothing this object installed is left retaining it.
        if let candidate { detach(candidate) }
        if let replacement { detach(replacement) }
        candidate?.close()
        current?.close()
        switch outcome {
        case .closed: admission?.didClose()
        case .failed: admission?.didFail()
        }
        settleWaitersLocked(.failure(error))
        _onEnded?(error)
    }

    private func cancelTimersLocked() {
        windowTimer?.cancel()
        windowTimer = nil
        retryTimer?.cancel()
        retryTimer = nil
    }

    private func detach(_ transport: LinkReplacementTransport) {
        transport.onReady = nil
        transport.onFrame = nil
        transport.onError = nil
        transport.onClose = nil
    }

    /// Exactly once each, and the list is emptied before any of them runs: a
    /// waiter that re-enters must not be able to find itself still pending.
    private func settleWaitersLocked(_ result: Result<LinkIdentity, Error>) {
        let pending = waiters
        waiters = []
        for waiter in pending { waiter(result) }
    }

    /// Safety net for an owner that drops this object without stopping it.
    ///
    /// A candidate is the one thing nobody else can release: it was never
    /// published, so no owner holds it, and left alone it keeps a live
    /// `RTCPeerConnection` and an installed signalling handler for as long as it
    /// takes something else to notice. `current` and `currentReplacement` are
    /// deliberately left alone — the first was handed in by the owner and the
    /// second handed back out through `onAttach`, so closing either here would
    /// tear down a transport somebody else is using.
    ///
    /// No lock and NO OWNER CALLBACKS. By the time this runs no strong reference
    /// can remain, so nothing else can be mutating this state; and an `onEnded`
    /// from a deallocating object would hand an owner a coordinator it cannot
    /// legally touch.
    deinit {
        windowTimer?.cancel()
        retryTimer?.cancel()
        if case let .claimed(transport) = slot {
            detach(transport)
            transport.close()
        }
        if let currentReplacement { detach(currentReplacement) }
    }
}

/// A `LinkRecoveryScheduler` on one `DispatchQueue`.
///
/// The queue chooses where a wake-up is DELIVERED and nothing else. It is not
/// the coordinator's lock and does not serialize it — the coordinator owns its
/// own synchronization, so any queue here is a correct one, and picking a
/// particular queue is a decision about which thread a timer costs, not about
/// safety.
public final class LinkDispatchRecoveryScheduler: LinkRecoveryScheduler {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue = .main) {
        self.queue = queue
    }

    public func schedule(after delay: TimeInterval,
                         _ body: @escaping () -> Void) -> LinkRecoveryTimer {
        let item = DispatchWorkItem(block: body)
        queue.asyncAfter(deadline: .now() + max(0, delay), execute: item)
        return item
    }
}

extension DispatchWorkItem: LinkRecoveryTimer {}
