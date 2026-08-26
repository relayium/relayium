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
///    old 800 ms deadline whenever any relay is silent, and both peers fall back —
///    every time. A feature that agrees perfectly and never runs is worth less
///    than one that agrees usually.
/// 2. Disagreement degrades rather than fails. Both sides still allocate on a
///    TURN server and exchange relay candidates; ICE connects them through two
///    relays instead of one. That costs a hop and roughly 2x metered relay
///    bandwidth — every byte crosses two of our coturn instances — but not the
///    transfer. See `RelayChoice` for why, and for what has not been measured.
/// 3. The window is small and self-closing: both maps converge on their final
///    contents within the probe timeout, and re-broadcasting every increment
///    is what keeps the peer's copy close to ours while it does.
///
/// What narrows that window to almost nothing is `waitForChoice` refusing to
/// return on a prefix of our OWN map: whenever measurement finishes inside the
/// deadline — the healthy case, and most of the time — `pick` sees the same
/// complete `mine` it saw before publishing went incremental, and the only
/// asymmetry left is how much of the peer's map has reached us. Only a
/// measurement that overruns the deadline still decides on a prefix, and there
/// the alternative really is no choice at all.
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
    /// Who `theirs` was actually learned from, so a room that loses every
    /// contributor stops offering a departed peer's measurements to the next
    /// one. See `peerLeft`.
    private var contributors: Set<String> = []
    /// True once `measure` has returned — every probe has answered or timed
    /// out, so `mine` can no longer grow. This is what `waitForChoice` waits
    /// for rather than the first common relay; see `wake`.
    private var measurementFinished = false
    /// When `start()` was called, so `finishMeasurement` can time our own
    /// probes. Set under the lock even though `start()` runs once, because the
    /// `Task` that reads it back in `finishMeasurement` can hop to a different
    /// thread — same reasoning as everywhere else in this file that a field
    /// crosses the async boundary.
    private var measurementStartedAt: Date?
    /// Milliseconds from `measurementStartedAt` to `finishMeasurement` —
    /// latched once and never recomputed, so a caller that asks after the
    /// fact gets the same answer `wake()` already acted on. Nil until our own
    /// measurement has actually finished; see `measuredMs()`.
    private var measurementElapsedMs: Int?
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
    /// deadline upstream used to be 800 ms, so a map published only on completion
    /// arrives five times too late whenever any one relay is silent — on both
    /// peers, on every transfer. Publishing per probe means our fast relays are
    /// on the wire, and in the peer's hands, inside the budget.
    public func start() {
        lock.lock()
        measurementStartedAt = Date()
        lock.unlock()
        guard !pool.isEmpty else { finishMeasurement(); return }
        Task { [self] in
            await measure(pool) { id, ms in self.record(id, ms) }
            finishMeasurement()
        }
    }

    /// `mine` will not grow again. Recorded because it is half of the condition
    /// `waitForChoice` wakes on, and it is the half that turns a one-relay
    /// prefix into a decision worth latching. The empty pool takes this path
    /// too, so the flag never lies about a measurement that is not coming.
    private func finishMeasurement() {
        lock.lock()
        measurementFinished = true
        if measurementElapsedMs == nil, let startedAt = measurementStartedAt {
            measurementElapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        }
        lock.unlock()
        wake()
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

    /// A peer left the room.
    ///
    /// Its map goes with it, once nothing else is contributing one. Keeping it
    /// would make the NEXT peer's bounded grace meaningless: the room would
    /// already hold a "settled" choice, made against measurements taken by
    /// somebody who is no longer there, and the arriving peer — which is
    /// measuring its own — would never get to influence the relay its link is
    /// built on. A room that still has another contributor keeps the merged map,
    /// which is the same answer merging has always given.
    ///
    /// Deliberately does not wake anyone: removing entries can only take a
    /// choice away, never make one.
    public func peerLeft(_ peerId: String) {
        lock.lock()
        peers.remove(peerId)
        if contributors.remove(peerId) != nil, contributors.isEmpty {
            theirs = [:]
        }
        lock.unlock()
    }

    /// Whether any peer is still contributing a map to this session's choice.
    ///
    /// The room's own question after a departure, and the one that decides
    /// whether a settled choice still belongs to somebody who is here.
    /// `peerLeft` drops the last contributor's map, so a false answer means the
    /// choice — and the gate that opened on it — was made from measurements
    /// nobody left in the room ever took. A room that still has another
    /// contributor keeps both, which is the same answer merging has always
    /// given.
    public func hasPeerMaps() -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !contributors.isEmpty
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
        contributors.insert(from)
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
    /// Returns early only once the choice can no longer change from our side:
    /// there is a choice AND our own measurement has finished. Returning at the
    /// first moment any relay was common to both maps was wrong twice over, and
    /// only became wrong when measurement started publishing incrementally:
    ///
    /// - `pick` ran over a one-element intersection, so "minimise the worse of
    ///   the two RTTs" was never evaluated at all. The pair converged on the
    ///   relay that answered fastest, not the jointly best one.
    /// - With both peers still probing, each side's own increment beats the
    ///   peer's matching broadcast by one network delay, so each evaluates its
    ///   nearest relay against the peer's older prefix and latches. The two
    ///   then SWAP — each picks the other's nearest, the worst pair available —
    ///   and nothing revisits it, because the choice latches once and the
    ///   connection is built on the next line. That is the structurally
    ///   favoured outcome, not a narrow race.
    ///
    /// The deadline is the other way out, and it is what keeps the reason
    /// measurement went incremental intact: a 4 s straggler still cannot stop
    /// the old 800 ms budget from producing an answer, it just cannot force a
    /// premature one either.
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
        guard !pool.isEmpty else { return nil }
        if let e = settledChoice() { return e }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let once = ResumeOnce(c)
            lock.lock()
            // Re-check inside the lock: the answer may have arrived between
            // settledChoice() above and here.
            if settledLocked() { lock.unlock(); once.fire(); return }
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
    /// `relayChoiceDeadline`'s original 800 ms guess with a number.
    public func maps() -> (mine: [String: Int], theirs: [String: Int]) {
        lock.lock(); defer { lock.unlock() }
        return (mine, theirs)
    }

    /// How long OUR OWN probes took to settle: `start()` to `finishMeasurement`,
    /// in milliseconds. Nil means our own measurement had not finished when
    /// this was asked — the case that matters is a caller checking right after
    /// `waitForChoice`'s deadline elapsed, where nil means a straggler relay
    /// overran the deadline rather than the peer being slow to arrive.
    ///
    /// Exists for the same log line `maps()` does: `waited` in
    /// `RealtimeConnectionFactory` conflates time spent waiting for the PEER
    /// with time spent waiting on our OWN probes, and those two call for
    /// opposite fixes to `relayChoiceDeadline`. This is the second one, on its
    /// own.
    public func measuredMs() -> Int? {
        lock.lock(); defer { lock.unlock() }
        return measurementElapsedMs
    }

    /// The best choice available right now, settled or not. This is what the
    /// deadline path returns: once the clock has run out, a choice made on a
    /// partial map still beats no choice at all.
    private func current() -> RelayEntry? {
        lock.lock(); defer { lock.unlock() }
        return entryLocked()
    }

    /// The choice only if it can no longer change from our side — the early
    /// return, as opposed to the deadline one.
    private func settledChoice() -> RelayEntry? {
        lock.lock(); defer { lock.unlock() }
        guard settledLocked() else { return nil }
        return entryLocked()
    }

    /// A choice exists and our own measurement is done, so waiting longer can
    /// only change it if the PEER sends more — and waiting on the peer is what
    /// the deadline is for.
    private func settledLocked() -> Bool {
        measurementFinished && chosenIDLocked() != nil
    }

    private func entryLocked() -> RelayEntry? {
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

    /// Wakes the parked waiters, but only for a choice that can no longer
    /// change from our side. A choice that is merely *available* is not a
    /// reason to stop waiting — see `waitForChoice` for what latching on one
    /// costs. Called from `record`, `handleSignal` and `finishMeasurement`,
    /// which is every place either half of the condition can become true.
    private func wake() {
        lock.lock()
        guard settledLocked() else { lock.unlock(); return }
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
