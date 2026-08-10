import Foundation
import RelayiumKit

// MARK: - the initial-transport seam

/// The initial transport of ONE `link/1`, as the runtime below drives it.
///
/// Exactly `WebRTCLinkTransport`'s existing public shape, and that is the point:
/// this seam exists so the assembly, the lifetime and the terminal-callback
/// wiring can be exercised without two negotiating endpoints, not so a second
/// dialect can grow beside the driver. A conformance that needed an adapter would
/// mean this file had been written against a transport that does not exist.
///
/// It refines both halves the runtime needs and nothing more:
///
///  - `LinkLiveTransport`, because the lanes are built ON this transport and the
///    file driver installs its one frame route through it, and
///  - `LinkTransportHandle`, because `LinkRecoveryCoordinator` has to be able to
///    hold it as the current transport and to release it.
///
/// ## The callback slots are written once, before anything runs
///
/// `LinkSessionRuntime` writes all four in its own INITIALIZER, and never again.
/// That is not tidiness: `WebRTCLinkTransport` stores them as plain properties,
/// so once it is started it reads them from its own queue and any write there is
/// an ordinary data race. A conformer may synchronize them, but it may not
/// require it — and it must not call back into whatever installed them from a
/// setter, because at that moment the runtime is still being constructed.
///
/// Everything that enters the transport's queue — `start`, `close`, `send`,
/// `bufferedAmount` — is called by the runtime with no lock of its own held.
public protocol LinkInitialTransport: LinkLiveTransport, LinkTransportHandle {
    /// The six digits both users compare, the instant the peer's reveal is
    /// verified — before the transport is published, so a user can start
    /// comparing while the lanes finish opening.
    var onSAS: ((String) -> Void)? { get set }
    /// Both exact lanes are open and the link is authenticated. Fires at most
    /// once, on the transport's own publication queue, and carries the identity
    /// that owns the link's one `LinkCodecs`. Anything captured before this
    /// transport had a consumer replays the instant the handler returns.
    var onReady: ((LinkIdentity) -> Void)? { get set }
    /// Fires at most once, and only for a failure. By the time it runs the
    /// transport has already closed itself.
    var onError: ((Error) -> Void)? { get set }
    /// Fires at most once, whatever ended the transport, and always last — so a
    /// failure is reported as `onError` THEN `onClose`, and a clean end as
    /// `onClose` alone.
    var onClose: (() -> Void)? { get set }

    /// Begin establishing. Idempotent.
    ///
    /// **`close()` dominates it, in either issue order, and that is a
    /// REQUIREMENT of this seam rather than an accident of one conformer.** A
    /// start issued before a close must be superseded by it, and a start issued
    /// after one must do nothing at all: not open a channel, not offer, not arm a
    /// deadline, and not produce a callback.
    ///
    /// `LinkSessionRuntime` depends on exactly that. `start()` there moves the
    /// state and calls this with its own lock released — it must, because this
    /// enters the transport's queue — so a concurrent `stop()` can close the
    /// transport in the gap between those two lines, and the start that follows
    /// lands on a transport whose end has already been reported. Closing that gap
    /// in the runtime instead would mean holding a lock across a call into this
    /// object, which is the one thing that runtime's synchronization rule forbids
    /// and which would deadlock against a conformer that calls back inline.
    ///
    /// `WebRTCLinkTransport` satisfies it structurally: both calls enter one
    /// serial queue, `startLocked` opens with `guard !closed, !started`, and
    /// `terminateLocked` sets `closed` before anything else — so whichever is
    /// applied first, a closed transport never starts.
    func start()
}

extension WebRTCLinkTransport: LinkInitialTransport {}

/// `LinkInitialTransport`, plus the one call an establishment that ADMISSION
/// routed additionally needs of its transport.
///
/// ## Why the establishment cannot get by without it
///
/// A responder's establishment exists BECAUSE a signal arrived: the room
/// intercepted the peer's offer, `LinkAdmission.route` read it, decided
/// `establish(role: .responder)`, and the router CONSUMED it so the live
/// connection could not also act on it. By the time this transport is built, the
/// offer that justifies its existence has already been taken off the wire — and
/// nothing sends it again.
///
/// The same is true of everything that CHASES that offer. A peer trickles its
/// candidates the instant it has them, so they arrive while the room is still
/// hopping to the main actor to assemble anything at all; and on the initiating
/// side the peer's answer can arrive the same way. None of those has a transport
/// to reach yet — `WebRTCLinkTransport` claims the single per-connection slot in
/// its own initializer, which is a turn later — so a router that could not hand
/// them over would drop exactly the host candidates a LAN link depends on.
///
/// ## Why it is a refinement rather than an optional cast
///
/// A requirement rather than an `as?` probe, because an optional cast would turn
/// a missing conformance into a silently dropped signal — which is precisely the
/// failure this seam exists to make unrepresentable. A builder that cannot answer
/// with one of these does not compile.
///
/// It refines rather than replaces `LinkInitialTransport` because the two are
/// genuinely different questions: that one is what a runtime DRIVES — start,
/// send, close, and the four callbacks it writes — and this is what a ROOM routes
/// to.
///
/// INTERNAL, and deliberately: the public initializer still takes a plain
/// `LinkInitialTransport`, because an application handing this runtime a
/// transport is not a room routing to one. Routing is reached through the
/// internal `init(establishing:)`, which is what `LinkSessionFactory` uses and
/// the only way a route is ever installed. Widening the public initializer would
/// have made every conformer outside this package implement a call none of them
/// can be given work for.
///
/// ## What this seam does NOT require
///
/// `receive` is called with no lock of this package's held, exactly like `start`,
/// `close` and `send`. A conformer may read the runtime back, call `stop()`, or
/// hop to its own queue — an earlier draft did hold a lock across this call, and
/// the first barrier test written against it deadlocked. See
/// `LinkSessionRuntime.receive` for what makes the resulting slack harmless.
protocol LinkRoutableInitialTransport: LinkInitialTransport {
    /// Hand this transport one signal that was routed elsewhere first.
    ///
    /// Safe for a signal the transport's own installed handler will also
    /// deliver: `LinkSignalPolicy` acts on exactly one remote offer and one
    /// remote answer, so a duplicate is dropped whole rather than reaching
    /// `setRemoteDescription` a second time.
    func receive(from: String, signal: JSONValue)
}

extension WebRTCLinkTransport: LinkRoutableInitialTransport {}

// MARK: - what a runtime reports

/// One inbound batch that reached the user's disk.
///
/// Produced only after `LinkFileWriterDestination` committed, which is the point
/// at which the bytes stop being a transfer and become the user's files. A batch
/// that failed, was refused or was aborted never produces one of these.
public struct LinkReceivedBatch: Equatable, Sendable {
    /// The inbound batch these files arrived on, so a presentation model can
    /// correlate this with the `LinkFileDriverEvent`s it already saw.
    public let batch: Int
    /// Where the files landed, in manifest order.
    public let files: [URL]
    /// The folder this batch created for itself, when it needed one. Nil for a
    /// flat batch, which lands straight in the directory the application chose.
    public let container: URL?

    public init(batch: Int, files: [URL], container: URL?) {
        self.batch = batch
        self.files = files
        self.container = container
    }
}

/// Why this runtime is over. Terminal, and reported exactly once.
///
/// Deliberately carries no `Error`. The transport has already closed itself by
/// the time it reports, a presentation model has no different action for one
/// `LinkTransportError` than for another, and an `Error` payload would both make
/// this type unequatable and invite a description into a log.
public enum LinkSessionRuntimeEnd: Equatable, Sendable {
    /// `stop()`.
    case stopped
    /// The initial transport failed before it ever published a link.
    case establishmentFailed
    /// The initial transport closed before it ever published a link. Not a
    /// failure: a peer that hung up during establishment closes cleanly.
    case establishmentClosed
    /// The held link ended, as both lanes were told. Whatever ended it —
    /// a declined gap, an expired window, a departed peer, a rebuild that could
    /// not be taken over — is `LinkRecoveryCoordinator`'s reason, and the note
    /// on `LinkSessionRuntime` records why it does not travel this far.
    case linkEnded
    /// The assembly itself could not be completed. Structurally unreachable —
    /// see `LinkSessionRuntime.publish` — and handled rather than forced,
    /// because the alternative is a trap inside a publication callback.
    case wiringFailed
}

/// What an owner above this runtime observes.
///
/// ## Delivery contract
///
/// **There is NO main-actor guarantee, in either direction.** This runtime never
/// hops: an event is delivered on whichever producer or drainer thread owns the
/// queue at that moment, and that thread is sometimes the main one — a `stop()`
/// made from the main thread with nothing else delivering runs the whole
/// teardown and hands `ended` to the handler synchronously, right there. So a
/// presentation model may neither assume it is already on the main actor nor
/// assume it is not. It must make the hop explicit — `MainActor.assumeIsolated`
/// is wrong here, and the correct shape is an unconditional
/// `Task { @MainActor in … }` or `DispatchQueue.main.async`, which is also what
/// keeps a handler from blocking the drain it is running on.
///
/// **They are SERIALIZED and TOTALLY ORDERED.** Each is admitted under the same
/// lock acquisition as the state decision that produced it and handed to one
/// queue with one consumer, so exactly one handler runs at a time and the order
/// an owner observes is the order this runtime decided — not the order two
/// threads happened to reach the callback in.
///
/// The thread is whichever one is draining. Ordinarily that is the thread that
/// produced the event: the transport's own publication queue for `sas` and
/// `opened`, a driver's emission drain for `text` and `file`, the file driver's
/// destination queue for `received`, the caller's thread for the `ended` that
/// `stop()` produces. But an event produced while another thread is mid-delivery
/// is handed to THAT thread, and its producer returns without waiting — which is
/// what keeps a `stop()` from blocking behind a publication's handler. So a
/// handler must not assume it runs on the thread that caused its event.
///
/// **`ended` is terminal.** It is the last event of this runtime's life, and
/// nothing follows it: not a late SAS, not a lane's own report, not a batch that
/// committed as the link was ending.
///
/// That last rule costs something, and it is paid deliberately. Each driver
/// drains its own owner callbacks through a single consumer, so a `stop()` that
/// lands while a driver is already delivering hands that driver's
/// `.failed(.linkEnded)` to the consumer already running rather than delivering
/// it inline — and that consumer may not reach it until after `ended` has been
/// queued. **A lane's terminal report is therefore delivered before `ended` or
/// not at all**, and the second case is a real one. The alternative would be to
/// hold `stop()` open until every driver's consumer had drained, which is
/// blocking the caller behind a client callback it did not write. See
/// `LinkSessionRuntime.end`.
///
/// `opened` and `ended` cannot invert either — a `stop()` that arrives before
/// publication claims the link produces `ended` with no `opened` at all, and one
/// that arrives after it produces `opened` first, however far apart the two
/// deliveries are.
///
/// `sas` and `opened` are ordinarily delivered synchronously inside the
/// transport's publication, before a single captured frame replays. A handler
/// that blocks there holds up the link's first frames, so it must do nothing but
/// hand the event on.
///
/// A handler may call straight back into the runtime on the delivering thread;
/// nothing here is held while one runs, and an event that call produces is queued
/// behind the one being delivered rather than nested inside it.
///
/// Each lane keeps its own order, exactly as its driver produces it. There is
/// deliberately no cross-lane ordering contract, because the two drivers have
/// none either — they drain independently.
public enum LinkSessionRuntimeEvent: Equatable, Sendable {
    /// The six digits to compare. Before `opened`, as the transport emits them.
    case sas(String)
    /// Both lanes are open under one authenticated identity, and everything
    /// below is assembled and bound.
    ///
    /// It carries the peer and the digits rather than the `LinkIdentity`,
    /// deliberately: that value owns the link's one `LinkCodecs`, and a
    /// presentation model has no business holding the session keys to render a
    /// screen.
    case opened(peerId: String, sas: String)
    /// The conversation, verbatim. `received` is the only place authenticated
    /// plaintext leaves this runtime.
    case text(LinkTextDriverEvent)
    /// The transfer, verbatim.
    case file(LinkFileDriverEvent)
    /// An inbound batch that is now really the user's files.
    case received(LinkReceivedBatch)
    /// Terminal, and at most one for the whole life of this runtime.
    case ended(LinkSessionRuntimeEnd)
}

/// Why an operation on the whole runtime — rather than on one of its lanes —
/// could not go on.
///
/// Two cases, and both are questions only THIS object can answer: whether there
/// is an authenticated link yet, and whether there still is one. Everything a
/// lane can refuse for itself stays that lane's refusal, unwrapped —
/// `LinkTextDriverError.backpressured`, `LinkLaneOwnerError.transportUnavailable`
/// — because re-wrapping those would hide which layer answered.
public enum LinkSessionRuntimeError: Error, Equatable, Sendable {
    /// The initial transport has not published a link yet. **Retryable**: the
    /// same call is accepted once it does.
    case notReady
    /// This runtime is over. **Terminal.**
    case ended
}

// MARK: - the runtime

/// The assembly and lifetime boundary for ONE authenticated `link/1`: one
/// transport, one identity, one `LinkLaneOwner` and one
/// `LinkRecoveryCoordinator`, wired together at the exact moment the transport
/// publishes and taken apart again, once, on demand.
///
/// ## What it is for
///
/// `LinkLaneOwner` composes the two lanes and `LinkRecoveryCoordinator` holds the
/// authentication across a rebuild, and both are complete — but nothing builds
/// either, and the two have an ordering requirement between them that no test of
/// either alone can state. This is the thing that builds them, in that order, and
/// it is deliberately nothing else: it owns no UI, no signalling policy, no
/// picker and no directory selection.
///
/// It owns no admission POLICY either — it admits nobody, refuses nobody and
/// decides no role — but it does make exactly one admission transition, and that
/// is not a policy: `didOpen`, at the instant this runtime claims a published
/// link. It is the only layer that can. See invariant 6.
///
/// ## The invariants it exists to make structural
///
/// **1. One identity, therefore one `LinkCodecs`, and it is the published one.**
/// Everything below is built from the exact `LinkIdentity` value the transport
/// handed to `onReady`. There is no initializer here that takes a key, a codec
/// pair or an identity, and nothing here derives one — so a second AEAD sequence
/// counting from zero under one pair of session keys is unrepresentable rather
/// than merely avoided.
///
/// **2. The owner is built INSIDE the publication.** `LinkFileDriver` installs
/// the link's one frame route as its last initializer act, and a real transport
/// replays whatever the peer sent before it had a consumer the instant `onReady`
/// returns. So the owner is constructed synchronously on the publication queue,
/// and the coordinator is bound before that handler returns: a route installed
/// one step later is a captured backlog already delivered to nobody, and those
/// frames belong to receiver codecs whose sequence has to stay continuous.
///
/// **3. The runtime never touches the route.** It installs no `onFrame` on
/// anything. The initial transport's slot is the file driver's, claimed once in
/// its initializer; a replacement's is `LinkRecoveryCoordinator`'s, which is what
/// applies the staleness rules. An overwrite after readiness is a lost lane that
/// only a live peer would ever reveal, so `LinkSessionRuntimeTests` pins it as
/// source as well as behaviour.
///
/// **4. The initial transport's terminal callbacks are this object's.** The
/// coordinator installs and removes callbacks on the replacements IT built; the
/// transport it was handed is the owner's, and its `onError`/`onClose` are wired
/// here. After readiness both feed `transportTerminated`, and the dedupe is the
/// coordinator's own and structural: the dying transport stops being current in
/// the same synchronous step that handles its first terminal event, so the pair
/// buys exactly one gap. Before readiness there is no coordinator yet, so the
/// dedupe is this object's typed state, and the pair is exactly one visible end.
///
/// **5. Stop is what discards an uncommitted receive.** Not `deinit` — see
/// "Lifetime".
///
/// **6. This runtime is what tells the room its link is OPEN, and the only thing
/// that can be.** `LinkAdmission` is moved to `.connecting` by the room owner
/// before this object exists, and from there nothing else in the system can move
/// it to `.open`: `LinkRecoveryCoordinator` drives only interrupt, replace, close
/// and fail, and a screen or a future UI coordinator learns of `opened` one hop
/// later, by which time the transport may already have died. So `publish` makes
/// that one transition, in the same critical section that claims `.active` — see
/// the comment there for why the two cannot be separate steps, and why this is
/// the single call this object makes with `lock` held.
///
/// It is `didOpen` and nothing else. A REPLACEMENT is the same authentication
/// step on a new wire and stays `didReplaceTransport`, which is the coordinator's
/// — the two differ in whether the peer's leave budget is refilled, and refilling
/// it for a rebuild would hand a peer that already spent it a fresh one by
/// dropping the connection.
///
/// ## Threading
///
/// **One lock, `lock`, and it protects two things that must agree: `state`, and
/// the queue of events that state has admitted.** It is taken to read or write a
/// decision and released before anything is acted on. There is no path from under
/// it to the transport, the coordinator, the owner, either driver, a destination,
/// the scheduler or a client callback, and it is therefore a LEAF for every one of
/// those: nothing that can run arbitrary code, re-enter this object or acquire a
/// lock of its own is ever called under it.
///
/// **The one call made under it is `LinkAdmission.didOpen`, and it is a leaf
/// mutation rather than an exception to the rule's purpose.** It assigns three
/// stored properties under that object's own lock and returns; the only arbitrary
/// code `LinkAdmission` holds is its three owner-supplied predicates, every one of
/// which it evaluates outside its lock precisely so re-entrancy is impossible, and
/// `didOpen` evaluates none of them. `lock` → the admission's lock is therefore a
/// terminal edge that cannot close a cycle, and it is the same direction
/// `LinkRecoveryCoordinator` already takes when it drives that object from inside
/// its own critical sections. Invariant 6 and `publish` record why it cannot be
/// moved outside.
///
/// `receive` deliberately does NOT join it: forwarding a routed signal calls into
/// a conformer, and `receive` records why the slack that leaves is harmless and
/// why holding the lock there would be a deadlock waiting for the first conformer
/// that read this runtime back. The
/// transport's four callback slots, which are the one thing that has to be written
/// before anything else can happen, are written in `init`, where there is no
/// concurrency to guard against and therefore no reason to hold anything across
/// them.
///
/// **The two are under one lock because deciding and reporting cannot be two
/// steps.** A publication that moved `state` to `.active`, released the lock and
/// only then called the owner's handler would leave a window in which a `stop()`
/// observes the open link, ends it and reports that end FIRST — the owner would
/// be told its session was over before it was told it began. So the event is
/// queued in the same acquisition that admits it, and the queue is drained
/// afterwards with the lock released. `report` is the same rule for everything a
/// lane or a destination produces, and `deliver` is the one consumer.
///
/// Because it is a leaf and is never held across anything, a client callback may
/// re-enter this object freely: it will find a lock nobody holds and the typed
/// state whichever thread got there first left behind. An event that re-entrant
/// call produces is queued and delivered by the consumer already running, so the
/// callback returns rather than nesting a second delivery inside the first.
/// Concurrent `stop()`, publication and terminal callbacks therefore settle on
/// ONE outcome — the first to take `state` past its guard — with no double event,
/// no inverted end and no lost route.
///
/// The lock ordering with everything below is one-directional and unchanged:
/// this lock is released before `LinkRecoveryCoordinator`'s is ever taken, and
/// the coordinator's hooks reach `LinkLaneOwner`'s gate and each driver's state
/// lock without ever coming back here.
///
/// ## Lifetime
///
/// **`stop()` is the contract, and there is no `deinit` cleanup.** Stopping ends
/// the held link through the coordinator, which ends both lanes, and the file
/// lane's terminal path is what discards an uncommitted destination through
/// `LinkFileDestination.abort`. Doing that from `deinit` would mean deleting a
/// user's partially-received tree from an arbitrary deallocating thread —
/// `LinkFileWriterDestination` makes exactly this call one level down, and
/// `LinkRecoveryCoordinator` makes it about the transport it was handed.
///
/// Every callback this object installs captures it weakly, and it holds the
/// transport, the owner and the coordinator strongly until it ends — at which
/// point it releases both of the objects it assembled. A caller that wants to
/// inspect the aftermath must keep its own reference. The coordinator holds the
/// owner strongly, by `LinkLaneOwner.bind(to:)`'s own decision, so the two go
/// together.
///
/// ## What it deliberately does NOT report
///
/// **A gap and a resume.** `LinkRecoveryCoordinator`'s four owner hooks are
/// installed atomically by `LinkLaneOwner.bind(to:)` and belong to it: taking
/// `onEnded` here would leave both lanes unended, which is the one thing that
/// discards an uncommitted receive, and taking `onTransportLost` would leave a
/// lane pointing at a transport that is gone. Its other transition stream —
/// `LinkAdmission` — is the room owner's, and inventing a second one above the
/// coordinator would be exactly the signalling policy this layer must not have.
/// So the interruption a user should see cannot be produced HERE, and this object
/// does not fake half of it: the end is read back from the lanes, where it is
/// guaranteed to arrive, and `recoveryPhase` exposes the coordinator's own answer
/// as the snapshot it is. A complete interrupted/resumed stream belongs to the
/// batch that owns one of those two seams.
///
/// ## What it is not
///
/// Unreachable from production. `LINK_BUILD_SUPPORT` and
/// `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still false, nothing outside
/// the tests constructs one, and no `AppEnvironment`, session model, iOS or macOS
/// target names it. What this closes is the hole `LinkLaneOwner` names — the
/// thing that builds an owner at the one moment it may be built, and supplies the
/// file lane's destination factory, which `RelayiumKit` deliberately cannot.
public final class LinkSessionRuntime: @unchecked Sendable {

    // `@unchecked Sendable` is earned property by property:
    //
    //  - `transport`, `receiveDirectory`, `scheduler`, `replacementFactory`,
    //    `admission` and `onEvent` are immutable after `init`.
    //  - `state`, `pending` and `delivering` are the only mutable properties, and
    //    every read and every write of each is made with `lock` held.
    //  - `lock` is never held across a call to anything that can run arbitrary
    //    code or reach back here: not the transport, not the coordinator, not
    //    the owner, not a driver, not a destination, not the scheduler and not a
    //    client callback. The single call it IS held across is
    //    `LinkAdmission.didOpen`, a closure-free leaf mutation — see "Threading"
    //    and invariant 6.

    /// Where this runtime is, as one word rather than a handful of booleans that
    /// could disagree.
    private enum State {
        /// Built. Nothing wired, nothing started.
        case idle
        /// Started: every callback is installed and the transport is running,
        /// but it has published nothing yet.
        case establishing
        /// The transport published, and these two are assembled and bound.
        case active(owner: LinkLaneOwner, coordinator: LinkRecoveryCoordinator)
        /// The end has been claimed and the teardown is running on some thread.
        ///
        /// A phase of its own rather than a step inside `.ended`, because the
        /// teardown is what produces both lanes' own terminal reports — and those
        /// are the owner's LAST look at the session that is ending, so a report
        /// that arrives while it runs is admitted and queued ahead of the one
        /// `ended` rather than dropped by it.
        ///
        /// It is a WINDOW, not a promise that both arrive inside it. A driver
        /// whose single-consumer notice drain is already in flight on another
        /// thread hands its `.failed(.linkEnded)` to that consumer, which may not
        /// reach it until this phase is over — and `report` then refuses it,
        /// because `ended` is terminal. See `end`.
        ///
        /// That is only true of a link that was published: `published` is false for a
        /// runtime that ends before publication, whose only lanes belong either to
        /// nothing or to an owner that lost the race and is being discarded, and
        /// whose reports are about a link the owner above was never told about.
        ///
        /// Terminal from the outside in every other respect: nothing revives it,
        /// no operation reaches an owner through it, and a second end is a no-op.
        case ending(published: Bool)
        /// Over. `ended` has been queued, everything this object assembled has
        /// been released, and no further event is admitted.
        case ended
    }

    /// Guards `state` and the event queue below, which have to agree. A leaf —
    /// see this type's "Threading".
    private let lock = NSLock()
    private var state: State = .idle

    /// Events admitted but not yet delivered, in the order they were admitted,
    /// and whether a consumer is already delivering them.
    ///
    /// One queue and one consumer is the whole mechanism: it is what turns "this
    /// runtime decided A before B" into "the owner above saw A before B", across
    /// however many threads produced them.
    private var pending: [LinkSessionRuntimeEvent] = []
    private var delivering = false

    /// The transport the lanes will be built on, held for the whole life of this
    /// object so `stop()` before publication still has something to close.
    private let transport: LinkInitialTransport

    /// How a ROOM hands this establishment a signal it routed first, or nil for a
    /// runtime that was not built by one.
    ///
    /// A closure rather than a second typed reference to the transport, and
    /// internal rather than public, so the public initializer's `transport`
    /// parameter keeps the shape every existing caller passes: an application
    /// that hands over a transport is not a room routing to one, and giving it a
    /// routing seam it can never be given work for would be API for nobody.
    /// `init(establishing:)` is the one place this is installed.
    private let route: ((String, JSONValue) -> Void)?

    /// Where inbound batches land, as an IMMUTABLE snapshot the application
    /// resolved once, before this object existed.
    ///
    /// It is a snapshot on purpose. Resolving a destination — a security-scoped
    /// bookmark started, a Save-panel URL still valid, a container directory
    /// created — is the application's, and it is the only thing that can hold
    /// that access open. Re-reading a user preference per batch would let a
    /// setting changed mid-transfer decide where the second half of a folder
    /// goes.
    private let receiveDirectory: URL

    private let scheduler: LinkRecoveryScheduler
    private let replacementFactory: LinkReplacementFactory
    private let admission: LinkAdmission?
    /// Whether this link may spend `LINK_RECOVERY_WINDOW` waiting for a rebuild.
    ///
    /// **This is a product decision, and this is the layer that composes the
    /// product.** `LinkRecoveryCoordinator` and `LinkLaneOwner` implement
    /// recovery completely and their suites drive it with real replacements;
    /// gating it inside either of them would delete the mechanism's testability
    /// along with the feature. What `LINK_TRANSPORT_REPLACEMENT_SUPPORTED`
    /// records is that the SHIPPED feature is incomplete — no durable file-wire
    /// owner, no END acknowledgement timing, no ICE restart, no native↔Web
    /// evidence — so a window opened here can only ever expire.
    ///
    /// And an expiring window is not a neutral wait. Everything above this layer
    /// spends it believing the link is alive: a screen that keeps saying
    /// connected, a composer that keeps accepting typing, and a user told ninety
    /// seconds later that none of it happened. Declining the window turns that
    /// into the truthful terminal state the transport already reached.
    ///
    /// Defaulted from the constant so production cannot forget it, and injected
    /// so `LinkSessionRuntimeTests` — whose subject IS the gap — can keep
    /// exercising it.
    private let holdsRecoveryWindow: Bool
    private let onEvent: (LinkSessionRuntimeEvent) -> Void

    /// - Parameters:
    ///   - transport: the initial transport, NOT yet started. This runtime takes
    ///     it over: all four of its callback slots are written HERE, which is
    ///     what makes "installed before `start()`" structural — see below.
    ///   - receiveDirectory: the already-reachable parent every inbound batch is
    ///     written under, for the whole life of this runtime.
    ///   - replacementFactory: builds one authenticated rebuild under the held
    ///     identity. Handed the identity rather than the ingredients of one,
    ///     which is what keeps "a rebuild cannot construct a second `LinkCodecs`"
    ///     a property of the type system.
    ///   - admission: the room's one-link state, if the caller owns one, so it
    ///     and the coordinator's gap cannot disagree about whether a rebuild is
    ///     in flight. This object makes no admission DECISION of its own — it
    ///     admits nobody, refuses nobody and decides no role — and it makes
    ///     exactly one transition: `didOpen`, at the instant it claims a
    ///     published link, because nothing else in the system can. Everything
    ///     after that is the coordinator's, through the same object. See
    ///     invariant 6.
    ///
    ///     Still optional, and a runtime built without one simply announces
    ///     nothing. A caller that has a room passes its admission —
    ///     `LinkSessionFactory` makes that non-optional at the boundary where it
    ///     stops being a convention.
    ///   - onEvent: see `LinkSessionRuntimeEvent` for the delivery contract.
    ///     There is no main-actor guarantee: it runs on whichever thread is
    ///     draining, which may or may not be the main one, so a presentation
    ///     model has to hop explicitly.
    public convenience init(transport: LinkInitialTransport,
                            receiveDirectory: URL,
                scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
                replacementFactory: @escaping LinkReplacementFactory,
                admission: LinkAdmission? = nil,
                            holdsRecoveryWindow: Bool = LINK_TRANSPORT_REPLACEMENT_SUPPORTED,
                onEvent: @escaping (LinkSessionRuntimeEvent) -> Void) {
        self.init(transport: transport,
                  route: nil,
                  receiveDirectory: receiveDirectory,
                  scheduler: scheduler,
                  replacementFactory: replacementFactory,
                  admission: admission,
                  holdsRecoveryWindow: holdsRecoveryWindow,
                  onEvent: onEvent)
    }

    /// The same runtime, for an establishment a ROOM routed into being.
    ///
    /// The only difference is that the transport can be handed the signals that
    /// chased the offer its room consumed — see `receive`. Internal, because that
    /// is the only kind of caller the seam exists for.
    convenience init(establishing transport: LinkRoutableInitialTransport,
                     receiveDirectory: URL,
                     scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
                     replacementFactory: @escaping LinkReplacementFactory,
                     admission: LinkAdmission? = nil,
                     holdsRecoveryWindow: Bool = LINK_TRANSPORT_REPLACEMENT_SUPPORTED,
                     onEvent: @escaping (LinkSessionRuntimeEvent) -> Void) {
        self.init(transport: transport,
                  // Captured strongly, and that is not a second owner: this
                  // runtime already holds the same object as its transport for
                  // its whole life, so the closure adds no lifetime.
                  route: { [transport] from, signal in
                      transport.receive(from: from, signal: signal)
                  },
                  receiveDirectory: receiveDirectory,
                  scheduler: scheduler,
                  replacementFactory: replacementFactory,
                  admission: admission,
                  holdsRecoveryWindow: holdsRecoveryWindow,
                  onEvent: onEvent)
    }

    private init(transport: LinkInitialTransport,
                 route: ((String, JSONValue) -> Void)?,
                 receiveDirectory: URL,
                 scheduler: LinkRecoveryScheduler,
                 replacementFactory: @escaping LinkReplacementFactory,
                 admission: LinkAdmission?,
                 holdsRecoveryWindow: Bool,
                 onEvent: @escaping (LinkSessionRuntimeEvent) -> Void) {
        self.transport = transport
        self.holdsRecoveryWindow = holdsRecoveryWindow
        self.route = route
        self.receiveDirectory = receiveDirectory
        self.scheduler = scheduler
        self.replacementFactory = replacementFactory
        self.admission = admission
        self.onEvent = onEvent

        // ALL FOUR SLOTS, HERE, and this is the whole reason the initializer has
        // a side effect on its argument.
        //
        // From the moment the transport is running it reads these from its own
        // queue, and `WebRTCLinkTransport` stores them unsynchronised — so a slot
        // written late is both a data race and an event already delivered to
        // nobody. Writing them in `start()` would satisfy the ordering but leave a
        // window: a concurrent `stop()` landing between two of them closes a
        // transport that is still half wired, and the callback that would report
        // that close may not exist yet. Closing THAT window by holding `lock`
        // across the four writes would mean holding a lock across a call to the
        // transport, which is the one thing this object's synchronization rule
        // forbids.
        //
        // Doing it here removes the race instead of guarding it: no other thread
        // can hold this object yet, so there is nothing to be concurrent with.
        // Every closure captures `self` weakly — the transport must not keep this
        // runtime alive — and every one of them refuses on the typed state, so a
        // transport that speaks before `start()` reaches a runtime that assembles
        // nothing and says nothing.
        transport.onSAS = { [weak self] digits in self?.announce(sas: digits) }
        transport.onReady = { [weak self] ready in self?.publish(ready) }
        transport.onError = { [weak self] error in self?.initialTransportTerminated(error) }
        transport.onClose = { [weak self] in self?.initialTransportTerminated(nil) }
    }

    // MARK: - lifetime

    /// Start the transport. Idempotent, and inert once this runtime has ended.
    ///
    /// Everything the transport can report is already wired — see `init` — so
    /// this is only the state transition and the one call, made with `lock`
    /// released because `start()` enters the transport's own queue.
    public func start() {
        lock.lock()
        guard case .idle = state else { lock.unlock(); return }
        state = .establishing
        lock.unlock()

        transport.start()
    }

    /// End this runtime, once, from any thread.
    ///
    /// Everything it assembled goes with it: the held link is ended through the
    /// coordinator — which ends both lanes, discards an uncommitted receive and
    /// closes whichever transport is current — and a runtime that never got that
    /// far closes the transport it was handed. Idempotent, and terminal: nothing
    /// restarts a stopped runtime.
    public func stop() { end(.stopped) }

    // MARK: - publication
    //
    // Both of these run on the transport's own publication queue, and `publish`
    // runs synchronously: everything it must do happens before it returns,
    // because the real transport replays whatever the peer sent before it had a
    // consumer the instant this handler is done.

    /// The six digits, announced before the lanes finish opening so a user can
    /// start comparing while they do.
    ///
    /// Gated on the state like everything else the transport reports: a SAS is
    /// only meaningful for an establishment this runtime asked for, and one that
    /// arrived before `start()` or after the end has nobody to show it to.
    private func announce(sas digits: String) {
        lock.lock()
        guard case .establishing = state else { lock.unlock(); return }
        // Queued under the acquisition that admitted it, so digits for a
        // runtime that ends a moment later cannot overtake that end.
        pending.append(.sas(digits))
        lock.unlock()

        deliver()
    }

    private func publish(_ ready: LinkIdentity) {
        lock.lock()
        guard case .establishing = state else { lock.unlock(); return }
        lock.unlock()

        // BOTH LANES FIRST, and with no lock held: the file driver's initializer
        // installs the link's one frame route as its last act, so from the line
        // below the peer's frames reach a complete owner. Building this under
        // `lock` would put a driver construction — and the transport slot write
        // inside it — beneath a lock the same frames can re-enter through.
        let owner = LinkLaneOwner(
            identity: ready,
            transport: transport,
            scheduler: scheduler,
            destinationFactory: { [weak self] batch, files in
                guard let self else { throw LinkSessionRuntimeError.ended }
                return try self.makeReceiveDestination(batch: batch, files: files)
            },
            onTextEvent: { [weak self] event in self?.laneReported(text: event) },
            onFileEvent: { [weak self] event in self?.laneReported(file: event) })

        // Then the coordinator, over the SAME identity value and the transport
        // the lanes are already on. It derives nothing and holds that one
        // `LinkCodecs` for the whole gap.
        let coordinator = LinkRecoveryCoordinator(identity: ready,
                                                  current: transport,
                                                  factory: replacementFactory,
                                                  scheduler: scheduler,
                                                  admission: admission)
        do {
            // Cannot throw: `bind` refuses a coordinator holding a DIFFERENT
            // link's authentication, and these two were built from the same
            // `ready` value three lines apart — `identityMatches` is comparing a
            // value with itself, `LinkCodecs` object included. Handled rather
            // than forced, because a `try!` here would turn a later edit that
            // separated those two constructions into a trap inside a publication
            // callback, on a queue with a peer waiting on the other end.
            try owner.bind(to: coordinator)
            narrowRecoveryWindow(coordinator)
        } catch {
            // `bind` throws BEFORE it installs anything, so this coordinator has
            // no owner hooks and cannot end the lanes — what it does do is close
            // the transport they are pointing at, which is the part that matters.
            // The owner is then released unbound, holding nothing that needs an
            // explicit discard: the captured backlog has not replayed yet, so no
            // batch can have reached a destination.
            coordinator.stop()
            end(.wiringFailed)
            return
        }

        lock.lock()
        guard case .establishing = state else {
            // A `stop()` won the race while this was being assembled. It closed
            // the transport and claimed the end already, so what is left is to
            // take apart what was just built rather than publish it: ending the
            // coordinator ends both lanes, which is what releases anything they
            // had started to hold. Those two lanes then report their own end —
            // and those reports are refused, because this owner was never
            // published and the owner above has no session to attach them to.
            lock.unlock()
            coordinator.stop()
            return
        }
        state = .active(owner: owner, coordinator: coordinator)
        // The claim, the room's phase and the report are ONE step. A `stop()`
        // from another thread cannot get between them, so it can only find this
        // link already open and queue its end behind this — never in front of it.
        //
        // ADMISSION IS MOVED HERE, AND IT HAS TO BE INSIDE THIS CRITICAL SECTION.
        // The room owner moved it to `.connecting` before this runtime existed
        // and nothing else can move it to `.open`: the coordinator below only
        // ever drives interrupt/replace/close/fail, and by the time a screen or a
        // future UI coordinator could observe `opened` the transport may already
        // have died. This is the first and only layer that knows one authenticated
        // identity published, both lanes and the coordinator are built and bound,
        // and this runtime has atomically claimed `.active`.
        //
        // The line below `lock.unlock()` is where it would race. `.active` is
        // exactly what `initialTransportTerminated` needs to route a terminal
        // callback into `coordinator.transportTerminated`, which calls
        // `admission.didInterrupt()` — and `didInterrupt` only acts on a phase
        // that is `.open`. Opening after the unlock would therefore let a
        // transport that died in that window take the interrupt as a no-op and
        // leave this side announcing `.open` for a link that is already gone:
        // every later peer answered `busy` for nothing, and the rebuild offer
        // that could have saved it routed to `.ignore`. Opening inside makes that
        // window not exist.
        //
        // **This is the one call made under `lock`, and it is deliberate.**
        // `LinkAdmission.didOpen` is a leaf mutation — it takes that object's own
        // lock, assigns three stored properties and returns, calling nothing and
        // reaching nothing that can reach back here. `LinkAdmission` guarantees
        // that structurally rather than by convention: its owner-supplied
        // predicates (`selfId`, `supportsLink`, `canAcceptLink`) are the only
        // arbitrary code it holds, every one of them is evaluated OUTSIDE its
        // lock precisely so re-entrancy is impossible, and `didOpen` evaluates
        // none of them. So `lock` → the admission's lock is a terminal edge that
        // cannot close a cycle, and it is the direction `LinkRecoveryCoordinator`
        // already takes: it calls `didInterrupt`, `didClose` and `didFail` from
        // inside its own `locked` sections, for exactly this reason. Nothing else
        // — not the transport, the coordinator, the owner, a driver, a
        // destination, the scheduler or a client callback — is ever called from
        // under this lock. See this type's `@unchecked Sendable` note.
        admission?.didOpen(peerId: ready.peerId)
        pending.append(.opened(peerId: ready.peerId, sas: ready.sas))
        lock.unlock()

        deliver()
    }

    /// The initial transport failed, or closed. Both go here, and both are the
    /// same question.
    ///
    /// After readiness this is reported to the coordinator EVERY time, because
    /// the dedupe is the coordinator's and structural — the dying transport stops
    /// being current in the same synchronous step that handles its first terminal
    /// event, so the `onError` + `onClose` pair asks the owner's recovery policy
    /// exactly once. Reporting only the first here would instead mean a
    /// cleanly-closed transport, which emits `onClose` alone, was never reported
    /// at all.
    ///
    /// Before readiness there is no coordinator, so the pair has to settle here:
    /// the typed state is what makes it exactly one visible end, and the reason
    /// is taken from whichever callback arrived first — a failure, then, rather
    /// than the clean close that always follows it.
    private func initialTransportTerminated(_ error: Error?) {
        let coordinator: LinkRecoveryCoordinator
        lock.lock()
        switch state {
        case .idle, .ending, .ended:
            // `.ending` included: the teardown running on another thread is
            // closing this very transport, and this is the close it asked for.
            lock.unlock()
            return
        case .establishing:
            lock.unlock()
            end(error == nil ? .establishmentClosed : .establishmentFailed)
            return
        case let .active(_, live):
            coordinator = live
        }
        lock.unlock()

        coordinator.transportTerminated(transport, error: error)
    }

    // MARK: - the one terminal path

    /// Claim the end, take apart whatever was assembled, and queue the one
    /// `ended`. Idempotent: the first thread past the guard owns the reason.
    ///
    /// ## What the teardown does and does not promise about the lanes
    ///
    /// Ending the held link produces each lane's own `.failed(.linkEnded)`, and
    /// a lane whose driver is free to drain delivers it from inside
    /// `coordinator.stop()` below — so it reaches `laneReported`, finds this
    /// runtime `.ending` with a published link, and is queued AHEAD of the end.
    /// That is the ordinary case and the one worth having.
    ///
    /// It is not guaranteed. Each driver has its own single-consumer notice
    /// drain, so if a driver callback was already in flight on another thread
    /// when this ran, that driver leaves its terminal notice for the consumer
    /// already running — which may only get to it after the lines below have
    /// queued and delivered `ended`. `report` refuses it there, and that is the
    /// intended outcome rather than a gap: `ended` is terminal, and this runtime
    /// already owns the reason it ended for. **Nothing here waits for a driver's
    /// consumer**, because that consumer is running a client callback and
    /// blocking `stop()` behind one is exactly what the queue-and-drain design
    /// exists to avoid. `LinkSessionRuntimeTests` pins both halves.
    private func end(_ reason: LinkSessionRuntimeEnd) {
        /// What this end has to take apart, decided under the lock and performed
        /// outside it.
        enum Teardown {
            /// Nothing was assembled, so the transport this object was handed is
            /// what has to be closed.
            case transport
            /// The held link is what has to end: that closes whichever transport
            /// is current, ends both lanes, and discards an uncommitted receive.
            case link(LinkRecoveryCoordinator)
        }

        let work: Teardown
        lock.lock()
        switch state {
        case .ending, .ended:
            lock.unlock()
            return
        case .idle, .establishing:
            state = .ending(published: false)
            work = .transport
        case let .active(_, coordinator):
            state = .ending(published: true)
            work = .link(coordinator)
        }
        lock.unlock()

        switch work {
        case .transport:
            transport.close()
        case let .link(coordinator):
            // Reached with the lock released, so the coordinator's own lock — and
            // everything under it: the lane owner's gate, both drivers' state — is
            // taken in the one direction that is ever taken. Both lanes' terminal
            // reports are PRODUCED from inside this call; each is DELIVERED here,
            // ahead of the one end, only if that driver's notice consumer is free
            // to run it — and one left for a consumer already in flight lands
            // after the end and is refused. Either way it adds no second end of
            // its own: `end` is idempotent and this thread is already past the
            // guard. See this function's note.
            coordinator.stop()
        }

        lock.lock()
        state = .ended
        // Last, and from now on the queue takes nothing else — see `report`.
        pending.append(.ended(reason))
        lock.unlock()

        deliver()
    }

    /// One lane's report, forwarded verbatim — and, for `.failed(.linkEnded)`,
    /// the signal that the held link is over.
    ///
    /// The held link ending is read back from HERE rather than from the
    /// coordinator, because `onEnded` belongs to `LinkLaneOwner` — see this
    /// type's "What it deliberately does NOT report". `LinkFileDriver` emits
    /// `.failed(.linkEnded)` exactly once for the held link whatever its own lane
    /// already reported — the text lane does not, because a lane that already
    /// failed has told its owner and a link ending afterwards is not a second
    /// loss — so the FILE lane is the one that makes the signal guaranteed, and
    /// `end` makes it exactly one report however many lanes send it.
    ///
    /// **The two directions this arrives from are not the same, and only one of
    /// them is load-bearing.**
    ///
    ///  - **The coordinator ended the link itself** — a declined gap, an expired
    ///    window, a departed peer, a rebuild nobody could take over. Nothing has
    ///    claimed an end here, so this IS how the runtime learns, and the file
    ///    lane's unconditional report is what makes it certain to arrive: the
    ///    `end` below runs on whichever lane's report lands first, whenever that
    ///    driver's consumer gets to it, and any other is then a no-op. A busy
    ///    consumer only DELAYS this — it cannot lose it, because there is no
    ///    competing end for `report` to refuse it against.
    ///  - **`stop()` claimed the end first**, and the reason travelling with it
    ///    is already the right one. A lane report that arrives while the teardown
    ///    is still running is admitted for its own sake — it is the owner's last
    ///    look at the session — but one a busy driver hands over late is refused
    ///    by `report`, and the `end` below is a no-op either way. Nothing is lost:
    ///    the runtime is not waiting to be told something it decided.
    private func laneReported(text event: LinkTextDriverEvent) {
        report(.text(event))
        if case .failed(.linkEnded) = event { end(.linkEnded) }
    }

    private func laneReported(file event: LinkFileDriverEvent) {
        report(.file(event))
        if case .failed(.linkEnded) = event { end(.linkEnded) }
    }

    /// One report from a lane or from a committed destination, admitted only for
    /// the link this runtime actually published and only before its end.
    ///
    /// Three answers, and each is about a different mistake:
    ///
    ///  - **Before publication, refused.** It would be an event about a link the
    ///    owner above has not been told exists — which is everything the owner
    ///    that LOST a publication race says as it is discarded.
    ///  - **While ending a published link, admitted.** Both lanes' own terminal
    ///    reports are produced by the teardown, they are the owner's last look at
    ///    the session, and they belong ahead of the one end rather than behind it.
    ///  - **After the end, refused.** `ended` is terminal, and a lane report or a
    ///    `received` that arrives behind it has no session left to belong to.
    ///
    /// The second and third answers are the same event on two paths, not two
    /// kinds of event: a lane's one `.failed(.linkEnded)` reaches the middle case
    /// when its driver could deliver it inline during the teardown and the last
    /// case when it was queued behind a callback that was already in flight. That
    /// is why this is a state question rather than an ordering assumption — see
    /// `end`.
    ///
    /// A late commit is the one that has to be said out loud: those bytes are
    /// already the user's file and stay exactly where `finalize` put them. What is
    /// dropped is the event, not the batch — see `LinkSessionRuntimeEvent`.
    private func report(_ event: LinkSessionRuntimeEvent) {
        lock.lock()
        let admitted: Bool
        switch state {
        case .active: admitted = true
        case let .ending(published): admitted = published
        case .idle, .establishing, .ended: admitted = false
        }
        if admitted { pending.append(event) }
        lock.unlock()

        guard admitted else { return }
        deliver()
    }

    /// The ONE consumer. Delivers whatever is queued, one event at a time, in the
    /// order it was admitted, with `lock` released across every callback.
    ///
    /// Re-entrant by design rather than by luck: a handler that calls back into
    /// this runtime and causes another event finds `delivering` already true, so
    /// it queues its event and returns instead of nesting a second delivery — and
    /// the loop below, which re-reads `pending` under the lock on every turn,
    /// picks it up. That is what makes a `stop()` from inside `opened` finish
    /// without deadlocking and still report its end after the event that caused
    /// it.
    ///
    /// The consumer is whichever thread arrives first, and it may therefore
    /// deliver an event another thread produced — which is the price of the
    /// producer not blocking behind a handler it did not write.
    private func deliver() {
        lock.lock()
        guard !delivering else { lock.unlock(); return }
        delivering = true
        while !pending.isEmpty {
            let event = pending.removeFirst()
            lock.unlock()
            onEvent(event)
            lock.lock()
        }
        delivering = false
        lock.unlock()
    }

    // MARK: - inbound files

    /// One inbound batch's destination, under the directory this runtime was
    /// built with.
    ///
    /// Everything about paths, traversal, collisions and cleanup stays where it
    /// already is — `openReceiveWriter`, `ManifestWriter` and
    /// `LinkFileWriterDestination` — and `FileMeta.path` is carried through
    /// untouched, so a received tree keeps its shape rather than landing in one
    /// flat heap. What is added here is one thing: the commit is turned into an
    /// event correlated to the batch it belongs to.
    ///
    /// The commit callback is the ONLY path to `received`, which is what makes
    /// "only after commit, at most once" structural rather than careful:
    /// `LinkFileWriterDestination` fires it from inside a successful `finalize`
    /// and clears it as it does, so a refused batch, a failed finalize and an
    /// abort all produce nothing, and a late abort cannot take the result back.
    ///
    /// "At most" rather than "exactly", and the gap is deliberate: a commit that
    /// lands after this runtime's end goes through `report`, which refuses it.
    /// The files stay — they were the user's from the moment `finalize` returned,
    /// and nothing here deletes them — but there is no longer a session for the
    /// event to belong to. See `LinkSessionRuntimeEvent` for that contract.
    ///
    /// Internal rather than private, for the same reason `owner` and
    /// `coordinator` are: it is production's own factory, and it is the ONLY
    /// place a `received` can come from — so the rule that a commit landing
    /// after the end keeps the file and loses the event has to be provable by
    /// calling it, not by racing a transfer against a stop and hoping.
    func makeReceiveDestination(batch: Int, files: [FileMeta]) throws
    -> LinkFileDestination {
        // A one-slot holder for the container the writer resolved. The
        // destination cannot report it itself — the callback is an initializer
        // parameter, so it is built before there is anything to read — and
        // capturing the destination in its own commit closure would close a cycle
        // that an aborted batch never breaks. Written below before this factory
        // returns, and read only from a commit, which cannot happen until the
        // driver calls `finalize`.
        let container = ContainerSlot()
        let destination = try LinkFileWriterDestination(
            batch: batch,
            files: files,
            parent: receiveDirectory) { [weak self] urls in
                self?.report(.received(LinkReceivedBatch(batch: batch,
                                                         files: urls,
                                                         container: container.url)))
            }
        container.url = destination.containerURL
        return destination
    }

    /// One URL, written once and read from whichever thread commits.
    private final class ContainerSlot: @unchecked Sendable {
        private let lock = NSLock()
        private var _url: URL?
        var url: URL? {
            get { lock.lock(); defer { lock.unlock() }; return _url }
            set { lock.lock(); _url = newValue; lock.unlock() }
        }
    }

    // MARK: - the two objects this runtime assembles
    //
    // Internal rather than public, and for the same reason `LinkLaneOwner` keeps
    // its two drivers internal: the facade below is what a composer above is meant
    // to use, and a caller that reached past it to `LinkLaneOwner.onAttach` or to
    // `LinkRecoveryCoordinator.installOwnerHooks` would be putting half a link on
    // a replacement. Both are nil before publication and again after the end.

    var owner: LinkLaneOwner? {
        lock.lock(); defer { lock.unlock() }
        if case let .active(owner, _) = state { return owner }
        return nil
    }

    var coordinator: LinkRecoveryCoordinator? {
        lock.lock(); defer { lock.unlock() }
        if case let .active(_, coordinator) = state { return coordinator }
        return nil
    }

    /// The owner to act on, or why this call cannot reach one.
    private func activeOwner() throws -> LinkLaneOwner {
        lock.lock(); defer { lock.unlock() }
        switch state {
        case .idle, .establishing: throw LinkSessionRuntimeError.notReady
        // `.ending` answers `.ended` because it IS the end from a caller's side:
        // the link is already being taken apart, and a call admitted here would
        // reach an owner mid-teardown.
        case .ending, .ended: throw LinkSessionRuntimeError.ended
        case let .active(owner, _): return owner
        }
    }

    // MARK: - the conversation
    //
    // Every one of these — and every file action below — resolves the owner under
    // the lock and calls it with the lock released. Outside an active link they
    // throw `notReady` or `ended`; inside one they are exactly the forwarding
    // calls they look like, and every other refusal is the lane's or the lane
    // owner's own, unwrapped.

    /// Ask the peer for a conversation.
    public func openTextConversation() throws { try activeOwner().openTextConversation() }
    /// Consent to the peer's request.
    public func acceptTextConversation() throws { try activeOwner().acceptTextConversation() }
    /// Refuse the peer's request.
    public func rejectTextConversation() throws { try activeOwner().rejectTextConversation() }
    /// End the current conversation. An ordering BARRIER, not a hangup.
    public func endTextConversation() throws { try activeOwner().endTextConversation() }
    /// Seal and queue one message for the open conversation.
    public func sendText(_ body: String) throws { try activeOwner().sendText(body) }

    // MARK: - the transfer

    /// Queue one batch. `stage` produces PRISTINE sources each time it is called:
    /// once for the first attempt and once more for every resumed one.
    @discardableResult
    public func enqueueFiles(files: [FileMeta],
                             stage: @escaping () throws -> [PlaintextSource]) throws -> Int {
        try activeOwner().enqueueFiles(files: files, stage: stage)
    }

    // The five below return nothing, so a refusal has to BE the absence of the
    // action: with no active link each is inert — it reaches no driver, moves no
    // session, writes no byte and emits no event — and the caller may simply make
    // it again once there is one.

    /// Launch the head of the queue if the lane can take it.
    public func pumpFiles() { owner?.pumpFiles() }
    /// Drop a batch that is still WAITING to launch.
    public func cancelQueuedBatch(_ batch: Int) { owner?.cancelQueuedBatch(batch) }
    /// Cancel the batch that is on the lane right now.
    public func cancelOutboundBatch() { owner?.cancelOutboundBatch() }
    /// Consent to the peer's manifest.
    public func acceptInboundBatch() { owner?.acceptInboundBatch() }
    /// Refuse it.
    public func rejectInboundBatch() { owner?.rejectInboundBatch() }

    // MARK: - the establishment's routed signals

    /// Hand the ESTABLISHING transport a `link/1` signal the room routed first.
    ///
    /// This is the other half of `LinkSessionFactory`'s `initialSignal`. That one
    /// carries the offer that made admission decide this link should exist; this
    /// carries everything that chased it — the peer's trickled candidates, and on
    /// the initiating side its answer — for the window between the room deciding
    /// to establish and the transport claiming the socket's single per-connection
    /// slot. A room that could not hand those over would drop exactly the host
    /// candidates a LAN link depends on.
    ///
    /// **The forward is made with the lock RELEASED, and the slack that leaves is
    /// benign by construction rather than by luck.**
    ///
    /// Holding the lock across it would make the state test and the forward one
    /// step, and that is genuinely tempting — but it would put an arbitrary
    /// conformer's code inside this object's critical section, and a conformer
    /// that so much as READ this runtime back (`isEnded`, `recoveryPhase`,
    /// `textStatus`) or called `stop()` would deadlock on a non-recursive lock.
    /// That is not a hypothetical: the first barrier test written against that
    /// contract deadlocked on exactly it. So this keeps the rule the rest of the
    /// type obeys — nothing arbitrary is called under `lock` — and pays for it by
    /// making the slack harmless:
    ///
    ///  - **A publication landing in the window is not a problem to solve.** ICE
    ///    is trickled, and a peer legitimately keeps sending candidates after the
    ///    lanes are open; handing one to the transport that is still running the
    ///    link is CORRECT, not stale.
    ///  - **A transport that has been superseded is already inert.** The only
    ///    genuinely wrong target is the initial transport after a rebuild has
    ///    replaced it, and `LinkRecoveryCoordinator` closes it in the same
    ///    synchronous step that stops it being current — so a forward that
    ///    arrives afterwards reaches a closed transport, and
    ///    `WebRTCLinkTransport.handleLocked` refuses on `closed` before it looks
    ///    at anything. `LinkSessionRuntimeTests` pins that closure.
    ///  - **An end landing in the window is the same case.** `end()` closes the
    ///    transport it was built with, whichever path it took.
    ///
    /// What is still refused here is the case the transport cannot judge for
    /// itself: a runtime that has not started, or one whose end has been claimed,
    /// has no establishment for a routed signal to belong to.
    ///
    /// This object inspects nothing else. It does not check the sender, the
    /// generation, the SDP kind or the ordering: `LinkSignalPolicy` inside the
    /// transport already refuses everything that is not this establishment's, and
    /// a second filter here would be a second policy that can silently disagree
    /// with the authoritative one.
    func receive(from: String, signal: JSONValue) {
        lock.lock()
        let live: Bool
        switch state {
        case .idle, .ending, .ended: live = false
        case .establishing, .active: live = true
        }
        lock.unlock()

        guard live else { return }
        route?(from, signal)
    }

    // MARK: - the recovery seams
    //
    // Straight pass-throughs to the coordinator, which is where every one of
    // these decisions already lives: this object verifies nothing, answers
    // nothing and starts nothing of its own. They exist because the room and
    // admission owner above needs to reach them and must not be handed the
    // coordinator itself.

    /// Hand the coordinator an inbound `resume` offer.
    ///
    /// It is verified THERE, against this link's own resume key, before it can
    /// allocate anything — and dropped in silence if it does not pass. Nothing
    /// here inspects, answers or counts it.
    public func receiveResumeOffer(from: String, signal: JSONValue) {
        coordinator?.receiveResumeOffer(from: from, signal: signal)
    }

    /// Hand the coordinator an authenticated departure. `to` must be the room
    /// envelope's local recipient id, forwarded unchanged from signaling.
    ///
    /// It is verified THERE, against this link's own resume key, and dropped in
    /// silence if it does not pass. Nothing here inspects, answers or counts it.
    public func receiveLeave(from: String, to: String, auth: String) {
        coordinator?.receiveLeave(from: from, to: to, auth: auth)
    }

    /// The peer left the room, or announced an authenticated departure. Ignored
    /// by the coordinator unless it is the peer this link belongs to.
    public func peerDeparted(_ peerId: String) {
        coordinator?.peerDeparted(peerId)
    }

    /// Join the one recovery outcome for this link, so intent raised mid-gap
    /// lands on the rebuilt link rather than on the transport that is gone.
    ///
    /// `.unavailable` before there is a link at all, exactly as it is when there
    /// is no gap to join.
    @discardableResult
    public func joinRecovery(peerId: String,
                             _ complete: @escaping (Result<LinkIdentity, Error>) -> Void)
    -> LinkRecoveryJoin {
        guard let coordinator else { return .unavailable }
        return coordinator.join(peerId: peerId, complete)
    }

    // MARK: - what an owner above may read

    /// Where the held link is, as `LinkRecoveryCoordinator` answers it, or nil
    /// before publication and after the end.
    ///
    /// A SNAPSHOT, and only ever that: by the time a caller acts on it another
    /// thread may have moved on. See "What it deliberately does NOT report" for
    /// why this is a read rather than an event.
    /// Refuse the recovery window when this build cannot use it.
    ///
    /// It COMPOSES the owner's hook rather than taking it, and the difference is
    /// the whole reason this is allowed to exist beside `bind`'s atomic install:
    /// the lane owner's answer is still called, on every report, with its throw
    /// preserved — so both lanes are still suspended, which is what stops a
    /// driver writing into a transport that is gone, and a policy failure still
    /// reaches the coordinator as one. Only the ANSWER is narrowed, from "there
    /// is work a replacement could resume" to "this build will not attempt one".
    ///
    /// The coordinator reads `false` as the owner declining to recover and ends
    /// the link at once, choosing `.closed` or `.failed` from whether the dead
    /// transport carried an error — the same terminal reason the expiring window
    /// would have produced, without the ninety seconds of false "open".
    ///
    /// The owner's hook is read ONCE, here, and captured by value. Reading it
    /// from inside the wrapper would re-enter the coordinator's lock while the
    /// coordinator is holding it to run the hook.
    ///
    /// Installed inside the same `do` as `bind`, before publication, so no gap
    /// can be in flight while it is written.
    private func narrowRecoveryWindow(_ coordinator: LinkRecoveryCoordinator) {
        guard !holdsRecoveryWindow else { return }
        let suspendLanes = coordinator.onTransportLost
        coordinator.onTransportLost = { ready in
            _ = try suspendLanes?(ready)
            return false
        }
    }

    public var recoveryPhase: LinkRecoveryPhase? { coordinator?.phase }

    /// This runtime is over. Terminal.
    ///
    /// True from the moment an end is CLAIMED, not from the moment it is
    /// reported: a caller that reaches this while the teardown is still running
    /// — a client callback re-entering from a lane's own terminal report, for
    /// instance — is looking at a runtime nothing can revive.
    public var isEnded: Bool {
        lock.lock(); defer { lock.unlock() }
        switch state {
        case .ending, .ended: return true
        case .idle, .establishing, .active: return false
        }
    }

    /// The conversation the user is looking at, or nil before publication.
    public var textStatus: LinkTextStatus? { owner?.textStatus }
}
