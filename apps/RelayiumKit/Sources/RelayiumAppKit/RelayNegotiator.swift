import Foundation
import RelayiumKit

/// Owns the two relay-RTT maps for one session and turns them into a choice.
///
/// Both peers measure the pool, swap maps over signalling, and run the same
/// symmetric `RelayChoice.pick` — so there is no negotiation round here, only
/// an exchange. `waitForChoice` exists because the maps may not have met yet
/// when the connection needs building.
///
/// Measurement is injected rather than owned: everything in this type is a
/// decision, and decisions are worth testing without a live TURN allocation.
///
/// ## On symmetry, which incremental measurement weakens
///
/// `RelayChoice.pick` is symmetric, so two peers holding the *same pair of
/// maps* cannot disagree. Publishing measurements incrementally means the
/// pairs are no longer guaranteed identical: each side picks from whatever
/// prefix of the other's map has reached it, and the two prefixes can differ.
/// Accepted deliberately, on three grounds.
///
/// 1. The alternative is not a symmetric choice, it is no choice. With the
///    map published only on completion, the 4 s probe timeout overruns the
///    800 ms deadline whenever any relay is silent, and both peers fall back —
///    every time. A feature that agrees perfectly and never runs is worth less
///    than one that agrees usually.
/// 2. Disagreement degrades rather than fails. Both sides still allocate on a
///    TURN server and exchange relay candidates; ICE connects them through two
///    relays instead of one, which costs a hop, not the transfer.
/// 3. The window is small and self-closing: both maps converge on their final
///    contents within the probe timeout, and re-broadcasting every increment
///    is what keeps the peer's copy close to ours while it does.
///
/// The measurement that would settle this — how often two real peers converge
/// — is the same one the design doc already flags as unrun, and is what the
/// per-session log line in `RealtimeConnectionFactory` exists to feed.
public final class RelayNegotiator: @unchecked Sendable {
    private let signaling: SignalingClient
    private let pool: [RelayEntry]
    /// Runs the pool's probes and calls `publish` once per relay that answers,
    /// as it answers. Streaming, not returning a finished map: see `start`.
    public typealias Measure =
        (_ pool: [RelayEntry], _ publish: @escaping @Sendable (String, Int) -> Void) async -> Void

    private let measure: Measure

    private let lock = NSLock()
    private var mine: [String: Int] = [:]
    private var theirs: [String: Int] = [:]
    private var peers: Set<String> = []
    // Each waiter is a "fire" closure rather than a raw continuation: see
    // `waitForChoice` for why a plain `withCheckedContinuation` here would
    // deadlock the whole call in the (very common) case nobody ever wakes it.
    private var waiters: [() -> Void] = []

    public init(signaling: SignalingClient,
                pool: [RelayEntry],
                measure: @escaping Measure) {
        self.signaling = signaling
        self.pool = pool
        self.measure = measure
    }

    /// Begin measuring. Returns immediately; the work runs detached so the
    /// caller can go on waiting for a peer, which is the window this uses.
    ///
    /// Each relay is recorded and broadcast the moment it answers, rather than
    /// once the whole pool has settled. That ordering is what makes the
    /// feature reachable at all: probes time out at 4 s and `waitForChoice`'s
    /// deadline upstream is 800 ms, so a map published only on completion
    /// arrives five times too late whenever any one relay is silent — on both
    /// peers, on every transfer. Publishing per probe means our fast relays are
    /// on the wire, and in the peer's hands, inside the budget.
    public func start() {
        guard !pool.isEmpty else { return }
        Task { [self] in
            await measure(pool) { id, ms in self.record(id, ms) }
        }
    }

    /// One relay's measurement: remember it, tell whoever is already here, and
    /// wake anyone parked in `waitForChoice` if that made a choice possible.
    ///
    /// Called concurrently, once per probe, from whatever task the probe
    /// finished on — hence the lock, and hence the broadcast being at most
    /// `pool.count` small messages per peer over the session rather than one.
    /// Re-broadcasting is deliberate: an incremental map is only useful to the
    /// peer if the peer actually receives the increments.
    ///
    /// The broadcast happens INSIDE the lock, which is the one thing here that
    /// is not obvious. Growing the map and then releasing the lock before
    /// encoding and sending let two probes reach the socket in the opposite
    /// order to the growth:
    ///
    ///     A: mine = {a}       snapshot {a}
    ///     B: mine = {a, b}    snapshot {a, b}
    ///     B: sends {a, b}     — reaches the wire first
    ///     A: sends {a}        — reaches the wire second
    ///
    /// The peer applies the LAST thing it received, so its copy of our map
    /// shrinks — permanently, when this lands on the final increments, which is
    /// exactly when several probes finish together (two unreachable relays
    /// timing out in the same instant). The reordering is ours, on this side of
    /// the socket; the transport has nothing to do with it. Serialising the
    /// encode and the send with the growth is what makes "what we put on the
    /// wire only ever grows" true rather than merely likely.
    ///
    /// Synchronous on purpose. `NSLock.lock()`/`unlock()` are `noasync`, so
    /// taking the lock inline in `start()`'s async closure was a warning today
    /// and an error under the Swift 6 language mode. `current()`, `wake()` and
    /// `broadcastLocked()` below are the same move for the same reason.
    private func record(_ id: String, _ ms: Int) {
        lock.lock()
        mine[id] = ms
        broadcastLocked(to: Array(peers))
        lock.unlock()
        wake()
    }

    public func peerJoined(_ peerId: String) {
        lock.lock()
        peers.insert(peerId)
        // Only worth sending once there is something to say — which is what
        // broadcastLocked's own guard does; `record`'s broadcast covers the
        // other ordering.
        broadcastLocked(to: [peerId])
        lock.unlock()
    }

    /// A peer's map, MERGED rather than assigned.
    ///
    /// A native peer sends this several times as its own probes land, each send
    /// carrying everything it has measured so far, so within one session the
    /// map only grows and the newest value for a relay is always the right one.
    /// Merging is what keeps a *short* message from undoing that: a peer on a
    /// build without the send-ordering fix above, or any future client that
    /// broadcasts genuine increments rather than cumulative maps, can hand us
    /// fewer entries than we already hold, and assigning wholesale would drop
    /// the rest for the rest of the session. A browser peer sends one complete
    /// map, for which merging and assigning are the same thing.
    ///
    /// Nothing removes a relay from a peer's map mid-session, so there is no
    /// case where forgetting an entry is the correct behaviour.
    public func handleSignal(from: String, data: JSONValue) {
        guard let map = RelayRttMessage.decode(data) else { return }
        lock.lock()
        theirs.merge(map) { _, new in new }
        lock.unlock()
        // Deliberately no reply. Broadcasts happen on measure-done and on
        // peer-join; answering here would have two peers echoing maps forever.
        wake()
    }

    /// The chosen relay, waiting up to `deadline` for both maps to arrive.
    /// Nil means "use whatever the caller already had" — an empty pool, a peer
    /// that never answered, no relay in common, or simply not in time.
    ///
    /// Deliberately NOT a `withTaskGroup` racing a continuation-waiting child
    /// against a `Task.sleep` child: cancelling the loser after `group.next()`
    /// does not resume a raw `withCheckedContinuation`, and `withTaskGroup`
    /// implicitly awaits every child at scope exit regardless of cancellation —
    /// so on exactly the path this method exists for ("nobody answers before
    /// the deadline") that shape hangs forever. Verified with a standalone
    /// repro; the runtime itself reports the leaked continuation. Instead, one
    /// continuation is shared by both the wake-up path and the timeout, guarded
    /// so only the first of the two actually resumes it.
    public func waitForChoice(deadline: TimeInterval) async -> RelayEntry? {
        if let e = current() { return e }
        guard !pool.isEmpty else { return nil }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let once = ResumeOnce(c)
            lock.lock()
            // Re-check inside the lock: the answer may have arrived between
            // current() above and here.
            if chosenIDLocked() != nil { lock.unlock(); once.fire(); return }
            waiters.append(once.fire)
            lock.unlock()
            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, deadline) * 1_000_000_000))
                once.fire()
            }
        }
        return current()
    }

    /// Both maps as they stood when asked. Exists for the one per-session log
    /// line the design's acceptance list asks for: without the two maps
    /// alongside the chosen id there is no way to tell a relay that won from a
    /// relay that was the only one measured, and no way to replace
    /// `relayChoiceDeadline`'s 800 ms guess with a number.
    public func maps() -> (mine: [String: Int], theirs: [String: Int]) {
        lock.lock(); defer { lock.unlock() }
        return (mine, theirs)
    }

    private func current() -> RelayEntry? {
        lock.lock(); defer { lock.unlock() }
        guard let id = chosenIDLocked() else { return nil }
        return pool.first { $0.id == id }
    }

    private func chosenIDLocked() -> String? {
        RelayChoice.pick(mine: mine, theirs: theirs)
    }

    /// Puts `mine` on the wire for each of `targets`. **Call with the lock
    /// held**, and keep the encode inside it — that is the whole fix described
    /// on `record`; releasing early to be polite about lock hold time is what
    /// lets a later, larger map overtake an earlier, smaller one.
    ///
    /// `sendSignal` is a synchronous encode plus a `WebSocketChannel.send`, and
    /// nothing on that path re-enters this object, so holding the lock across
    /// it cannot deadlock.
    private func broadcastLocked(to targets: [String]) {
        guard !mine.isEmpty else { return }
        let payload = RelayRttMessage.encode(mine)
        for p in targets { signaling.sendSignal(to: p, data: payload) }
    }

    private func wake() {
        lock.lock()
        guard chosenIDLocked() != nil else { lock.unlock(); return }
        let pending = waiters
        waiters = []
        lock.unlock()
        for fire in pending { fire() }
    }
}

/// Resumes a continuation at most once, whichever of "woken by a fresh map"
/// or "deadline elapsed" gets there first. Without this guard the two racing
/// callers in `waitForChoice` could both try to resume the same continuation.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?

    init(_ continuation: CheckedContinuation<Void, Never>) {
        self.continuation = continuation
    }

    func fire() {
        lock.lock()
        guard let c = continuation else { lock.unlock(); return }
        continuation = nil
        lock.unlock()
        c.resume()
    }
}
