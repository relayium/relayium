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
    /// `pool`'s ids, which is what the dominance rule iterates. Derived once
    /// rather than per evaluation; the pool is fixed for the session.
    private let poolIDs: [String]
    /// Runs the pool's probes and reports through `publish` once per relay that
    /// answers, as it answers. Streaming, not returning a finished map: see
    /// `start`.
    ///
    /// ## The second thing the sink carries, and why it has to exist
    ///
    /// `settledLocked` retires a probe that is still running once it has been
    /// running longer than the current pick's worse leg — the browser does
    /// exactly that, and it is what stops one silently dropping relay from
    /// holding a choice the room already has for the whole probe timeout.
    /// Elapsed time is a valid LOWER bound on what a probe will report only when
    /// it is measured from an anchor at or after that probe's own start, and
    /// neither of the obvious candidates is one:
    ///
    /// - `start()` runs BEFORE `measure` is even called, so elapsed from there
    ///   over-estimates every probe's round trip — the unsafe direction, which
    ///   retires relays that can still win.
    /// - The first result would be the natural anchor, as it is in the browser,
    ///   but only if every probe had begun timing before it. In `measureRelays`
    ///   (`web/src/lib/ice.ts`) that is a fact about the language: every probe's
    ///   clock starts in the one synchronous job that `pool.map` runs in, and
    ///   nothing can be published until that job ends. A Swift task group has no
    ///   equivalent guarantee — `group.addTask` children are merely enqueued on
    ///   the global concurrent executor, so under load a later child can still
    ///   be waiting for a thread while an earlier one publishes.
    ///
    /// So the fact is reported rather than inferred. `RelayProbeSink` carries a
    /// second, one-shot edge — `allProbesStarted()` — and the contract a
    /// measurement must honour to use it is exactly:
    ///
    /// > every probe has taken the monotonic instant it will later measure its
    /// > own round trip from, on the same clock this negotiator's `now` reads,
    /// > and none of them has suspended since.
    ///
    /// `RelayProbe.measureAll` implements it with `ProbeStartBarrier`. Hoisting
    /// a timestamp ahead of `addTask` would NOT: executor delay between that
    /// timestamp and the probe's real start lands in elapsed, over-stating the
    /// bound in the unsafe direction, which is the same guess with a tidier
    /// call site.
    ///
    /// **Not calling it is always safe.** A measurement that never fires the
    /// edge leaves the anchor nil, `elapsedMs` nil, and the rule reduced to its
    /// timing-free half — which is the behaviour every caller had before the
    /// edge existed, and is why the fakes in this package's tests did not have
    /// to change.
    public typealias Measure =
        (_ pool: [RelayEntry], _ publish: RelayProbeSink) async -> Void

    private let measure: Measure
    /// Monotonic, and injectable so the dominance rule can be exercised at
    /// millisecond scale. `systemUptime` rather than a wall clock — the same
    /// choice, for the same reason, as `WebRTCLinkTransport`: elapsed time is
    /// used here as a LOWER bound on an unfinished probe's round trip, so the
    /// unsafe direction is a clock that runs FAST, and a wall clock stepped
    /// FORWARD (NTP, the user setting the date, a VM resuming) would retire a
    /// relay that could still win. A monotonic clock cannot do that; if it
    /// stalls — the machine sleeping mid-probe — elapsed under-counts, the bound
    /// gets weaker, and the room waits longer than it strictly had to.
    ///
    /// It must be the SAME clock `RelayProbe` times its round trips on, or the
    /// two quantities being compared are not in the same domain. Both default to
    /// `systemUptime`; see `RelayProbe.measureAll`.
    private let now: () -> TimeInterval

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
    private var measurementStartedAt: TimeInterval?
    /// **The instant every probe in the pool is known to have started**, or nil
    /// until `Measure` says so.
    ///
    /// The anchor `RelayChoice.dominates` needs, and deliberately NOT
    /// `measurementStartedAt`: that one is taken before `measure` is even
    /// entered, so everything between it and a probe's real start — task
    /// creation, executor queueing, `RTCPeerConnectionFactory` construction —
    /// would be counted as round-trip time the probe has already spent. Elapsed
    /// is a LOWER bound, so over-counting it retires relays that can still win.
    ///
    /// An anchor taken at or AFTER the last start is the safe error: elapsed
    /// under-states every pending probe's true running time, so the bound is
    /// weaker than it could be and the room waits slightly longer. What it costs
    /// is the barrier call itself.
    ///
    /// Nil therefore means "no sound bound yet", and the rule falls back to its
    /// timing-free half rather than to zero. `record` may well have run several
    /// times by then — an early publication is buffered into `mine` and
    /// broadcast exactly as before; only the CLOCK half of the rule waits.
    private var probeAnchor: TimeInterval?
    /// Milliseconds from `measurementStartedAt` to `finishMeasurement` —
    /// latched once and never recomputed, so a caller that asks after the
    /// fact gets the same answer `wake()` already acted on. Nil until our own
    /// measurement has actually finished; see `measuredMs()`.
    private var measurementElapsedMs: Int?
    // Each waiter is a "fire" closure rather than a raw continuation: see
    // `waitForChoice` for why a plain `withCheckedContinuation` here would
    // deadlock the whole call in the (very common) case nobody ever wakes it.
    private var waiters: [ResumeOnce] = []
    /// The early exit's wake-up.
    ///
    /// Necessary because the clock half of the rule turns true with TIME rather
    /// than with an event: a room whose peer has spoken and whose fast relay has
    /// answered gets no further callback until the silent probe's timeout, and
    /// waiting for that is the whole defect. Separate from `waitForChoice`'s own
    /// deadline `Task` because they mean opposite things — one gives up, the
    /// other stops waiting for an answer it already has.
    private var dominanceTask: Task<Void, Never>?
    /// `dominanceTask`'s invalidation token. A wake-up that was already in
    /// flight when the pick moved underneath it must be able to recognise that,
    /// whether or not `cancel()` also stopped it in time.
    private var dominanceToken = 0

    public init(signaling: SignalingClient,
                pool: [RelayEntry],
                now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                measure: @escaping Measure) {
        self.signaling = signaling
        self.pool = pool
        self.poolIDs = pool.map(\.id)
        self.now = now
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
        measurementStartedAt = now()
        lock.unlock()
        // An empty pool has no probe to start, so nothing will ever fire the
        // all-started edge and `probeAnchor` stays nil for the whole session.
        // That costs nothing: `waitForChoice` refuses an empty pool outright and
        // `pick` has nothing to return, so there is no choice for an elapsed
        // bound to protect.
        guard !pool.isEmpty else { finishMeasurement(); return }
        let sink = RelayProbeSink(onResult: { [self] id, ms in record(id, ms) },
                                  onAllStarted: { [self] in probesStarted() })
        Task { [self] in
            await measure(pool, sink)
            finishMeasurement()
        }
    }

    /// Every probe has taken its own start instant and none has suspended since
    /// — so from here, elapsed time is a lower bound on what any of them will
    /// report. See `probeAnchor` and the `Measure` contract.
    ///
    /// Called synchronously from inside whichever probe acknowledged last, which
    /// is the point: the anchor is that instant, not the instant some later
    /// event happened to notice it. Nothing here suspends and nothing calls back
    /// into `measure`, so it cannot deadlock the group it is called from — it
    /// takes this object's lock, releases it, and at most resumes continuations
    /// parked in `waitForChoice`.
    ///
    /// First call wins. A `Measure` that fires the edge twice is honouring the
    /// contract on the first one; a later instant is also at-or-after every
    /// start, so it would be sound too, but it would be needlessly weaker and
    /// would move a scheduled wake-up that is already correct.
    private func probesStarted() {
        lock.lock()
        if probeAnchor == nil { probeAnchor = now() }
        lock.unlock()
        // The bound is live from this instant, and the maps may already have
        // been sitting on a choice that only lacked one. Re-evaluate, wake, and
        // arm — `wake` does all three.
        wake()
    }

    /// `mine` will not grow again. Recorded because it is half of the condition
    /// `waitForChoice` wakes on, and it is the half that turns a one-relay
    /// prefix into a decision worth latching. The empty pool takes this path
    /// too, so the flag never lies about a measurement that is not coming.
    private func finishMeasurement() {
        lock.lock()
        measurementFinished = true
        if measurementElapsedMs == nil, let startedAt = measurementStartedAt {
            measurementElapsedMs = milliseconds(now() - startedAt)
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
        // Re-derived, not abandoned. A departure that emptied `theirs` unmade
        // the pick, and the early exit armed against that pick's worse leg is
        // now measuring a room that no longer exists — so it must not be allowed
        // to fire. A departure that left another contributor changed nothing,
        // and re-arming lands on the same instant it already held.
        armDominanceLocked()
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
            waiters.append(once)
            // Now that somebody is actually parked, schedule the instant the
            // clock alone would settle this. Nothing else would: `record`,
            // `handleSignal` and `probesStarted` may all have run already.
            armDominanceLocked()
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

    /// A choice exists and our own measurement can no longer change it, so
    /// waiting longer can only help if the PEER sends more — and waiting on the
    /// peer is what the deadline is for.
    ///
    /// "Our own measurement has finished" is the sufficient condition, not the
    /// necessary one. What actually matters is that no probe still running can
    /// beat the pick, and `RelayChoice.dominates` answers that directly: a relay
    /// every one of us has already measured, or one the PEER has measured and
    /// found worse than the pick's worse leg, cannot turn the choice.
    ///
    /// Elapsed time is the third way a probe stops mattering and the one that
    /// actually retires a silently dropping relay: it is available from the
    /// instant `Measure` reports every probe started, and nil before that. See
    /// `probeAnchor`.
    private func settledLocked() -> Bool {
        guard let id = chosenIDLocked() else { return false }
        return measurementFinished
            || RelayChoice.dominates(selectedID: id,
                                     mine: mine,
                                     theirs: theirs,
                                     poolIDs: poolIDs,
                                     elapsedMs: elapsedMsLocked())
    }

    /// How long every probe has been running for AT LEAST, or nil while no
    /// sound anchor exists. **Call with the lock held.**
    private func elapsedMsLocked() -> Int? {
        guard let anchor = probeAnchor else { return nil }
        return milliseconds(now() - anchor)
    }

    /// Seconds to whole milliseconds, TRUNCATED, clamped, and never trapping.
    ///
    /// Truncation matches what `RelayProbe` does to its own round trip, which is
    /// what makes the comparison in `RelayChoice.dominates` sound: elapsed is
    /// never larger than the probe's real running time, and truncation is
    /// monotone, so the truncated elapsed is never larger than the value the
    /// probe will eventually report. Rounding one side and truncating the other
    /// would be out by up to a millisecond in the unsafe direction.
    ///
    /// The clamp is not decoration: `Int(_: Double)` traps on NaN and on
    /// anything outside `Int`'s range, `now` is injectable, and this runs under
    /// the lock on the path every waiter goes through.
    private func milliseconds(_ seconds: TimeInterval) -> Int {
        let ms = seconds * 1000
        guard ms.isFinite else { return 0 }
        return Int(min(max(ms, 0), 1_000_000_000))
    }

    /// Stop the early exit and make any wake-up already in flight
    /// unrecognisable. **Call with the lock held.**
    ///
    /// The token is what actually invalidates; `cancel()` only stops the sleep
    /// early. That split is deliberate — cancelling a `Task.sleep` resumes it
    /// through its executor rather than inline on this thread, so the cancelled
    /// wake-up reaches `dominanceDeadlineElapsed` and this lock afterwards, not
    /// re-entrantly underneath the caller that is holding it.
    private func abandonDominanceLocked() {
        dominanceTask?.cancel()
        dominanceTask = nil
        dominanceToken &+= 1
    }

    /// Schedule the instant at which the clock alone settles the choice, if it
    /// has not already and could still. **Call with the lock held.**
    ///
    /// Superseded on every re-derivation, because the deadline is a function of
    /// the pick's worse leg and that moves when the pick does. Armed only while
    /// somebody is parked: with no waiter there is nothing for the wake-up to
    /// release, and `waitForChoice` arms its own on the way in.
    private func armDominanceLocked() {
        abandonDominanceLocked()
        // A waiter whose own deadline already resumed it is not somebody to
        // wake; leaving it in the list would keep this wake-up re-arming itself
        // for as long as measurement runs, against a room nobody is in.
        waiters.removeAll { !$0.isPending }
        guard !measurementFinished, !waiters.isEmpty,
              let anchor = probeAnchor,
              let id = chosenIDLocked(),
              let myLeg = mine[id], let peerLeg = theirs[id] else { return }
        let target = TimeInterval(RelayChoice.dominanceElapsedMs(worstLegMs: max(myLeg, peerLeg)))
        let delay = target / 1000 - (now() - anchor)
        // Unreachable while `settledLocked()` is false for a clock reason — the
        // rule and this deadline are the same inequality — but `now` is
        // injectable. Written as "not positive" rather than "at most zero" so a
        // NaN delay stops here too: a wake-up that re-arms itself on NaN forever
        // is the one failure mode a timer this file owns could spin on.
        guard delay > 0, delay.isFinite else { return }
        let token = dominanceToken
        let nanoseconds = UInt64(min(delay, 3600) * 1_000_000_000)
        dominanceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            // Weak on purpose: a negotiator whose session ended mid-sleep has
            // nobody left to wake, and a strong capture would keep it — and the
            // socket it holds — alive for the remainder of the delay.
            self?.dominanceDeadlineElapsed(token)
        }
    }

    /// The early exit's wake-up fired. Re-evaluates rather than assumes: the
    /// deadline was computed against a pick that may since have moved, and
    /// `wake` re-arms on the new one if it has.
    private func dominanceDeadlineElapsed(_ token: Int) {
        lock.lock()
        guard token == dominanceToken else { lock.unlock(); return }
        dominanceTask = nil
        lock.unlock()
        wake()
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
    /// costs. Called from `record`, `handleSignal`, `probesStarted`,
    /// `finishMeasurement` and the early exit's own wake-up, which is every
    /// place any part of the condition can become true.
    ///
    /// The `else` branch is not housekeeping. Once the maps stop moving, the
    /// only thing left that can settle the choice is the CLOCK, and no clock
    /// calls back — so every path that leaves the room unsettled has to leave a
    /// wake-up armed behind it.
    private func wake() {
        lock.lock()
        guard settledLocked() else {
            armDominanceLocked()
            lock.unlock()
            return
        }
        abandonDominanceLocked()
        let pending = waiters
        waiters = []
        lock.unlock()
        for waiter in pending { waiter.fire() }
    }
}

/// The channel a `RelayNegotiator.Measure` reports through: one call per relay
/// that answers, plus the one-shot edge that says every probe has started.
///
/// A single value rather than two closure parameters, and that is load-bearing
/// in two directions. It keeps `publish(id, ms)` spelled exactly as it always
/// was at every call site — `callAsFunction` — so a measurement that has no
/// opinion about start times needs no edit and keeps its previous behaviour
/// exactly. And it keeps the two halves of the contract in one place, where the
/// rule that relates them can be stated once: `allProbesStarted()` is only ever
/// legal AFTER every probe has taken the instant it will later report a round
/// trip from. See `RelayNegotiator.Measure`.
public struct RelayProbeSink: Sendable {
    private let onResult: @Sendable (String, Int) -> Void
    private let onAllStarted: @Sendable () -> Void

    public init(onResult: @escaping @Sendable (String, Int) -> Void,
                onAllStarted: @escaping @Sendable () -> Void = {}) {
        self.onResult = onResult
        self.onAllStarted = onAllStarted
    }

    /// One relay answered, in `rttMs`. Called concurrently, once per probe.
    public func callAsFunction(_ id: String, _ rttMs: Int) { onResult(id, rttMs) }

    /// Every probe in the pool has taken its own monotonic start instant and
    /// none of them has suspended since. One-shot by contract; the negotiator
    /// keeps the first anchor if it is called again.
    public func allProbesStarted() { onAllStarted() }
}

/// Fires `onAllStarted` exactly once, when every expected probe has
/// acknowledged its own start.
///
/// Counting acknowledgements would not do. A probe that acknowledged twice while
/// another had not started at all would reach the count with the barrier's whole
/// claim false — and the anchor taken there would precede a probe's start, which
/// is the one error the elapsed bound cannot survive. So this tracks WHICH
/// entries have acknowledged, by index, and a duplicate is a no-op rather than
/// progress.
///
/// Separate from `RelayProbe` on purpose: that type is deliberately untested
/// because it is a stopwatch around a live TURN allocation, and this is the one
/// piece of it that is a rule. Rules belong where a test can reach them.
final class ProbeStartBarrier: @unchecked Sendable {
    private let lock = NSLock()
    private var outstanding: Set<Int>
    private var fired = false
    private var onAllStarted: (@Sendable () -> Void)?

    /// An `expected` of zero is already satisfied and fires immediately — the
    /// empty pool, which `RelayNegotiator.start` never reaches `measure` for
    /// anyway. Anything less is treated the same way rather than trapping.
    init(expected: Int, onAllStarted: @escaping @Sendable () -> Void) {
        self.outstanding = Set(0..<max(0, expected))
        self.onAllStarted = onAllStarted
        if outstanding.isEmpty { fire() }
    }

    /// Probe `index` has taken its start instant. Idempotent per index, safe to
    /// call from any thread, and safe to call after the barrier has already
    /// fired — a late acknowledgement from a probe the barrier had counted is
    /// simply nothing new.
    func acknowledge(_ index: Int) {
        lock.lock()
        outstanding.remove(index)
        let complete = outstanding.isEmpty
        lock.unlock()
        if complete { fire() }
    }

    /// Runs the callback OUTSIDE the lock, exactly once, and drops it — so the
    /// barrier cannot hold what it captured for the rest of the pool's life, and
    /// so a callback that reaches back into the negotiator cannot deadlock
    /// against a probe acknowledging on another thread.
    private func fire() {
        lock.lock()
        guard !fired else { lock.unlock(); return }
        fired = true
        let callback = onAllStarted
        onAllStarted = nil
        lock.unlock()
        callback?()
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

    /// Whether anybody is still parked on this. False once either racer has
    /// fired, which is what lets `armDominanceLocked` tell a live waiter from a
    /// spent one.
    var isPending: Bool {
        lock.lock(); defer { lock.unlock() }
        return continuation != nil
    }

    func fire() {
        lock.lock()
        guard let c = continuation else { lock.unlock(); return }
        continuation = nil
        lock.unlock()
        c.resume()
    }
}
