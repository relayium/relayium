import Foundation
import RelayiumKit

/// What the buffer decided about one inbound signal.
enum LinkSignalCapture: Equatable {
    /// Held, in arrival order, for the transport that does not exist yet.
    case captured
    /// The assembly exists and nothing is queued ahead of this: deliver it
    /// straight to the link.
    case ready
    /// Not this establishment's — a different peer, a different generation, or
    /// admission's own control vocabulary. The caller must decide what happens to
    /// it; this buffer has taken no responsibility for it.
    case rejected
    /// The bound was exceeded. Terminal, and the caller must fail the
    /// establishment: see `LinkEstablishmentSignalBuffer`'s note on overflow.
    case overflowed
}

/// The signals that chase a consumed offer, held for the one turn in which they
/// have nowhere to go.
///
/// ## The window this exists for
///
/// A responder's establishment begins because an offer arrived and the room's
/// router CONSUMED it — it had to, or the live connection would have acted on it
/// too. The router then has to reach the main actor to assemble anything, and
/// `WebRTCLinkTransport` claims the socket's single per-connection slot in its
/// own initializer, one turn later. Everything the peer sends in between —
/// trickled candidates, and on the initiating side the answer — arrives with no
/// transport to reach: the slot still belongs to whatever owned it before, which
/// is a legacy connection or nobody.
///
/// One turn sounds like nothing. It is the turn in which a peer that already has
/// its host candidates sends all of them, and those are exactly the candidates a
/// same-network link depends on.
///
/// So: hold them, in order, and hand them over the moment there is something to
/// hand them to. `RealtimeConnectionFactory` solves the same problem the same way
/// for the legacy generations, with a temporary slot and a replay.
///
/// ## What it will and will not hold
///
/// EXACTLY the admitted peer's `link`-generation SDP and ICE. Everything else is
/// `rejected`, and each exclusion is a different thing going wrong:
///
///  - **another peer's frames** are not this establishment's at all, and holding
///    them would replay a stranger's SDP into a transport that trusts its room to
///    have filtered by sender;
///  - **another generation** belongs to the legacy file/text connections or to a
///    rebuild, and swallowing one would break a feature that already ships;
///  - **link CONTROL** — a request, a busy, a leave — is `LinkAdmission`'s
///    vocabulary and not a transport's. `LinkSignalPolicy` would ignore all three
///    anyway, so holding them would spend the bound on frames that could never
///    matter, which is the cheapest possible way for a flood to deny a real
///    candidate its place.
///
/// It does not deduplicate, reorder or coalesce. Arrival order IS the contract:
/// an answer applied after the candidates that chase it is not the same
/// establishment as one applied before them.
///
/// ## Overflow is never silent truncation
///
/// The bound is `LINK_PENDING_CANDIDATE_MAX`, and it is the same number for the
/// same reason the candidate gate uses it: a real exchange for one data m-line is
/// single-digit to low double-digit, so sixty-four is several times the worst
/// realistic case and still a fixed ceiling on bytes a peer chose to send.
///
/// Past it, this object refuses everything and says so, rather than dropping the
/// earliest (which would drop the host candidates) or the latest (which would
/// hide the flood). `drain` then answers false, and the caller fails the
/// establishment closed — exactly as `LinkCandidateGate` requires of its own
/// caller, and for the identical reason. That answer does not promise nothing
/// was delivered: the bound can break part-way through a replay, and `drain`
/// says what the prefix means.
///
/// ## Threading
///
/// Thread-safe by lock rather than by isolation, for the reason `LinkAdmission`
/// records: capture happens on the socket's delivery queue, in the same instant
/// the signal is seen, while the drain happens on the main actor where the
/// assembly lives. A buffer that could only be written from the main actor would
/// have to hop first — and the hop is the very window it exists to cover.
///
/// ## What it is not
///
/// It is not a router: it decides nothing about admission, answers no peer and
/// begins no establishment. It is not a queue for a live link either — once the
/// replay has finished it holds nothing again and says `ready`, because a
/// transport that exists is a transport that can be delivered to directly.
///
/// Internal, and unreachable from production: nothing outside the tests
/// constructs one, and both Link flags are still false.
final class LinkEstablishmentSignalBuffer: @unchecked Sendable {

    /// Where this buffer is. One word rather than two booleans that could
    /// disagree.
    private enum State {
        /// Holding, for an assembly that does not exist yet — and still holding
        /// while a replay is in progress, which is the whole point: a signal that
        /// arrives mid-replay must queue BEHIND the batch being handed over, not
        /// overtake it.
        case capturing
        /// Drained, with nothing left behind. Everything from here goes straight
        /// to the link.
        case open
        /// The bound was exceeded, or the establishment was given up. Terminal.
        case closed
    }

    /// The peer this establishment was admitted for. Nothing from anybody else is
    /// ever held: see "What it will and will not hold".
    let peerId: String

    /// How many signals may be held. `LINK_PENDING_CANDIDATE_MAX` by default —
    /// the same ceiling, for the same window shape, as the candidate gate one
    /// layer down.
    let limit: Int

    private let lock = NSLock()
    private var state: State = .capturing
    private var held: [(from: String, signal: JSONValue)] = []
    /// Whether a drain owner is running. See `drain`.
    private var replaying = false

    init(peerId: String, limit: Int = LINK_PENDING_CANDIDATE_MAX) {
        self.peerId = peerId
        self.limit = limit
    }

    /// Whether the bound was exceeded. Terminal once true.
    var isOverflowed: Bool {
        lock.lock(); defer { lock.unlock() }
        return overflowed
    }
    private var overflowed = false

    /// How many signals are held right now. Instrumentation for a caller that
    /// wants to report the replay; nothing acts on it.
    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return held.count
    }

    /// Offer one inbound signal to this establishment.
    ///
    /// The answer is what the CALLER must do with the frame, and the two that
    /// matter to a router are the same in one respect: `captured` and `ready`
    /// both mean this establishment has taken responsibility for it, so it must
    /// not also reach the socket's ordinary connection slot. `rejected` means the
    /// opposite — nothing here claimed it.
    func accept(from: String, signal: JSONValue) -> LinkSignalCapture {
        guard from == peerId, isEstablishmentSignal(signal) else { return .rejected }

        lock.lock(); defer { lock.unlock() }
        switch state {
        case .closed:
            // Overflowed, or given up. Either way this buffer is not going to
            // deliver anything, and saying `captured` would be a promise it
            // cannot keep.
            return overflowed ? .overflowed : .rejected
        case .open:
            // Nothing can be queued ahead of this: `open` is reached only by the
            // drain owner observing an empty queue, in the same acquisition that
            // sets it.
            return .ready
        case .capturing:
            guard held.count < limit else {
                overflowed = true
                state = .closed
                held.removeAll()
                return .overflowed
            }
            held.append((from, signal))
            return .captured
        }
    }

    /// Replay everything held, in one total order, and open the buffer.
    ///
    /// **There is exactly one drain owner, and this is it.** The batching is
    /// deliberately not exposed: a caller that took one batch and stopped would
    /// leave the buffer holding, and — worse — two callers draining at once would
    /// let the second observe an empty queue and flip to `open` while the first
    /// is still handing over its batch. The very next signal would then be
    /// answered `ready` and delivered ahead of signals that arrived before it,
    /// which is the reordering this whole object exists to prevent. A second,
    /// concurrent or re-entrant, call therefore delivers nothing and answers
    /// true: the owner already running loops until the queue is empty, so
    /// everything the second caller would have delivered is delivered by it, in
    /// the one order.
    ///
    /// While a replay is in progress the buffer keeps CAPTURING, so a signal that
    /// arrives mid-replay queues behind the batch being delivered. Only the round
    /// that finds nothing left flips to `open`, and it does so in the same
    /// critical section that observed the queue empty — which is what makes "no
    /// signal is ever delivered out of order" true rather than likely.
    /// `LinkSessionEventBridge.drain` closes its own window the same way.
    ///
    /// `deliver` is called with the lock RELEASED — it hands signals to a
    /// transport, which is exactly the kind of arbitrary work this object must
    /// never hold a lock across — and it may itself cause more signals to be
    /// captured; those come out of a later round of the same loop.
    ///
    /// **False means the bound was exceeded and the caller must fail the
    /// establishment.** It does NOT mean nothing was delivered: overflow can
    /// happen part-way through a replay, when a signal arriving mid-delivery
    /// pushes past the bound, and the signals already handed over stay handed
    /// over. That is not a loose end — a caller that gets false is failing the
    /// link, so what a doomed transport already applied cannot matter — but a
    /// caller must not read false as "nothing happened".
    @discardableResult
    func drain(into deliver: (_ from: String, _ signal: JSONValue) -> Void) -> Bool {
        lock.lock()
        if overflowed { lock.unlock(); return false }
        guard !replaying else {
            // One owner. See above: the drain already running will pick up
            // anything this caller would have delivered.
            lock.unlock()
            return true
        }
        replaying = true
        lock.unlock()

        defer { lock.lock(); replaying = false; lock.unlock() }

        while true {
            guard let batch = nextBatch() else { return false }
            guard !batch.isEmpty else { return true }
            for held in batch { deliver(held.from, held.signal) }
        }
    }

    /// One round of the replay, for the owner and nobody else.
    private func nextBatch() -> [(from: String, signal: JSONValue)]? {
        lock.lock(); defer { lock.unlock() }
        if overflowed { return nil }
        switch state {
        case .closed, .open:
            return []
        case .capturing:
            guard !held.isEmpty else {
                state = .open
                return []
            }
            let batch = held
            held.removeAll()
            return batch
        }
    }

    /// Give this establishment up: hold nothing, take nothing more.
    ///
    /// Distinct from overflow, and deliberately not reported as one: an
    /// establishment the room retired has no failure to answer for, so a later
    /// signal is simply not this buffer's — `rejected`, exactly as a stranger's
    /// frame is.
    func retire() {
        lock.lock()
        state = .closed
        held.removeAll()
        lock.unlock()
    }

    /// Whether this frame is one an ESTABLISHING transport could act on: exactly
    /// the `link` generation, and exactly an SDP or an ICE candidate.
    ///
    /// `signalGeneration` ranks `resume` above `link`, so a rebuild's signalling
    /// can never be read as an establishment's — which matters because a rebuild
    /// belongs to a coordinator this establishment does not have yet.
    private func isEstablishmentSignal(_ signal: JSONValue) -> Bool {
        guard signalGeneration(signal) == .link else { return false }
        return parseSDP(signal) != nil || parseICE(signal) != nil
    }
}
