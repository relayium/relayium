import Foundation

/// The one wake-up that turns `LinkEstablishmentWatchdog`'s decisions into an
/// actual timer, for ONE link transport.
///
/// ## Why this is its own object
///
/// Both link drivers need it and the subtle parts are the same in both: arming
/// exactly once whichever of `start()` and the first acted-on signal happens
/// first, cancelling a superseded wake-up, recognising one that was already
/// dispatched when a milestone moved the deadline out from under it, and never
/// re-arming after teardown. A second hand-written copy of that inside a
/// replacement driver is precisely the code that drifts unnoticed — and its
/// first version lived inline, where the only way to exercise any of it was a
/// ninety-second establishment against a live peer.
///
/// The split is deliberate: `LinkEstablishmentWatchdog` owns the arithmetic and
/// has no clock, no queue and no timer; this owns the single
/// `DispatchWorkItem`; the driver owns what a crossed deadline MEANS, because
/// only the driver can fail a transport and run its client callbacks.
///
/// ## Threading
///
/// Deliberately none of its own: the owner serializes, exactly as it does for
/// `LinkEstablishment`. Every method belongs to the owner's `LinkTransportQueue`,
/// which is also the queue `wake` fires on and the queue the client's callbacks
/// run on — so a wake-up cannot run while a callback holds the queue, which is
/// the whole reason a served event may be late and must re-read the clock.
///
/// `disarm()` touches no queue, so it is safe from `deinit`.
public final class LinkDeadlineClock {
    private let queue: LinkTransportQueue
    private let deadlines: LinkDeadlines
    private let identityPresent: Bool

    private var watchdog: LinkEstablishmentWatchdog?
    /// Whether `disarm()` has been called, tracked separately from the watchdog.
    ///
    /// Permanence cannot be read off `watchdog`: teardown is reachable BEFORE
    /// the lazy arming — an owner that closes a rebuild it has just constructed,
    /// a `deinit` on a candidate transport nobody started — and at that point
    /// there is no watchdog to carry the fact. Both drivers happen to hold their
    /// own `closed` flag as well, but an invariant this type documents must not
    /// depend on a caller's state: without this, a clock disarmed early arms
    /// normally later and fires a deadline into a transport whose consumer has
    /// already been told it is gone.
    private var disarmed = false
    private var timer: DispatchWorkItem?
    /// Which scheduling of the wake-up is current. A work item that was already
    /// dispatched when a milestone rescheduled it cannot be cancelled any more,
    /// so it has to be able to recognise that it is stale.
    private var generation = 0
    private var wake: (() -> Void)?

    /// - Parameter identityPresent: true for an authenticated transport
    ///   replacement, whose identity existed before its PeerConnection did.
    ///   See `LinkEstablishmentWatchdog.init` for why that suppresses the
    ///   key-reveal window rather than merely making it unreachable.
    public init(queue: LinkTransportQueue,
                deadlines: LinkDeadlines = LinkDeadlines(),
                identityPresent: Bool = false) {
        self.queue = queue
        self.deadlines = deadlines
        self.identityPresent = identityPresent
    }

    /// Whether a clock is running: armed and not yet disarmed.
    public var isRunning: Bool { watchdog?.isArmed == true }

    /// Start the clock and schedule the first wake-up. Returns whether THIS call
    /// started it.
    ///
    /// Idempotent, and permanently so: a second call does not restart the clock,
    /// and a call after `disarm()` does not resurrect it. The owner arms from
    /// whichever of `start()` and the first signal it will actually act on comes
    /// first, and both paths run unconditionally.
    ///
    /// `wake` fires on the owner's queue when the earliest armed deadline is
    /// reached. It is NOT told that anything expired: only the owner can decide
    /// what a crossed deadline means, so its job is to check `expiry` and either
    /// end the transport or call `reschedule`.
    @discardableResult
    public func arm(at now: TimeInterval, wake: @escaping () -> Void) -> Bool {
        guard !disarmed, watchdog == nil else { return false }
        watchdog = LinkEstablishmentWatchdog(start: now,
                                             deadlines: deadlines,
                                             identityPresent: identityPresent)
        self.wake = wake
        reschedule(at: now)
        return true
    }

    /// Which deadline had ALREADY passed at `now`, if any. Nil for an unarmed or
    /// disarmed clock, and nil for a wake-up that fired early or was overtaken
    /// by a re-arm.
    public func expiry(at now: TimeInterval) -> LinkTimeout? {
        watchdog?.expiry(at: now)
    }

    /// Record one milestone, rescheduling the wake-up if a deadline moved.
    ///
    /// Returns the timeout that had already passed when this arrived, if any —
    /// which is terminal for the owner. A milestone served late is not progress;
    /// it is the proof that the establishment already lost, so nothing is
    /// extended on the way out.
    @discardableResult
    public func note(_ milestone: LinkMilestone, at now: TimeInterval) -> LinkTimeout? {
        guard watchdog != nil else { return nil }
        switch watchdog!.note(milestone, at: now) {
        case .rearmed:
            reschedule(at: now)
            return nil
        case .unchanged:
            return nil
        case let .expired(timeout):
            return timeout
        }
    }

    /// Put the one wake-up back on the current earliest deadline, cancelling
    /// whatever was scheduled before.
    ///
    /// Called by `note` when a deadline moved, and by an owner whose wake-up
    /// fired without anything having expired.
    public func reschedule(at now: TimeInterval) {
        timer?.cancel()
        timer = nil
        guard let deadline = watchdog?.deadline else { return }
        generation += 1
        let scheduled = generation
        timer = queue.after(deadline - now) { [weak self] in
            guard let self, scheduled == self.generation, self.watchdog != nil else { return }
            self.wake?()
        }
    }

    /// Publication, failure or teardown: nothing here applies any more.
    ///
    /// Idempotent and permanent, and permanent in BOTH directions: a clock
    /// disarmed before it was ever armed can no more be armed afterwards than
    /// one disarmed while running can be re-armed. Releases `wake`, which is
    /// what keeps a timer from holding the owner alive, and touches no queue so
    /// it is safe from `deinit`.
    public func disarm() {
        disarmed = true
        watchdog?.disarm()
        timer?.cancel()
        timer = nil
        wake = nil
    }
}
