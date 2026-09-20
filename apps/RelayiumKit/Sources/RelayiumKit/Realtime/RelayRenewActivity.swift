import Foundation

/// How recent authenticated user-lane traffic has to be for this link to count
/// as one somebody is using.
///
/// The same ten minutes the existing idle policy uses, deliberately: renewal
/// does not get its own, more generous, window. A link nobody is using still
/// dies on schedule, and this clock exists to decide whether to ASK for a
/// renewal at all — never to keep one alive.
public let RENEW_USER_DATA_WINDOW: TimeInterval = 600

/// What may move `lastUserDataAt`.
///
/// An explicit, closed list rather than a boolean, because the whole hazard
/// this type exists for is a call site that "obviously" counts. Every case here
/// is authenticated user-lane traffic on the established E2E link. Everything
/// that is NOT — a surface-active flag, a pending consent, an inbound offer,
/// queued-but-unsent work, keepalives, lifecycle bytes and renewal's own control
/// frames — is excluded where it would otherwise be reported, in
/// `LinkSessionRuntime.noteUserData`, which names each of them.
public enum RelayRenewUserData: Equatable, Sendable {
    /// Actual file bytes moved, in either direction.
    case fileBytes
    /// Flow-control ACK progress — a stalled-but-recovering transfer is a
    /// transfer, and there is deliberately no byte-volume floor anywhere here.
    case fileAckProgress
    /// A user text message sent.
    case textSent
    /// A user text message received and decrypted.
    case textReceived
}

/// The independent `lastUserDataAt` clock for one link.
///
/// ## Why it is independent
///
/// The existing session activity clock is refreshed by UI active flags, so it
/// answers "is this window in front" rather than "is this link carrying user
/// data". Deriving a renewal decision from it would mean a link left open on a
/// visible screen, moving nothing, would renew its credential forever — which
/// is precisely the outcome spec §0.3 says renewal is not.
///
/// ## Why it is re-read rather than sampled once
///
/// The margin ahead of the old deadline is a WINDOW, not an instant. A transfer
/// that starts two minutes into that window is a link being used, and a client
/// that sampled this clock only at the window's opening would refuse to renew
/// it. `RelayRenewController` therefore consults this at the margin AND on
/// every later user-data event until the deadline.
///
/// Thread-safe: file bytes arrive on WebRTC's delivery thread while a timer on
/// another asks whether to renew.
public final class RelayRenewActivityClock: @unchecked Sendable {
    private let lock = NSLock()
    private let window: TimeInterval
    private var lastUserDataAt: TimeInterval?

    public init(window: TimeInterval = RENEW_USER_DATA_WINDOW) {
        self.window = window
    }

    /// Record one piece of authenticated user-lane traffic.
    ///
    /// `kind` is unused at runtime and deliberately required: it is what makes
    /// a call site state which of the four things it is, so a fifth that does
    /// not belong has to be added to `RelayRenewUserData` first and reviewed
    /// there.
    public func record(_ kind: RelayRenewUserData, at now: TimeInterval) {
        _ = kind
        lock.lock(); defer { lock.unlock() }
        // MAX rather than assignment: two lanes deliver on different threads,
        // and a file frame that lost a race must not be able to move the clock
        // backwards past a text message that already landed.
        lastUserDataAt = Swift.max(lastUserDataAt ?? now, now)
    }

    /// The last instant user data moved, or nil if none ever has.
    public var lastUserData: TimeInterval? {
        lock.lock(); defer { lock.unlock() }
        return lastUserDataAt
    }

    /// Whether this link has carried user data recently enough to renew.
    ///
    /// A link that has never carried any is NOT active: an established but
    /// unused link is exactly the case the idle policy exists for, and
    /// answering "no data yet, so assume yes" would make the first ten minutes
    /// of every link renewable.
    public func isActive(at now: TimeInterval) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let last = lastUserDataAt else { return false }
        return now - last <= window
    }
}

/// The one object a lane reports user data to, from whatever thread it is on.
///
/// ## Why this exists rather than a call into the workspace
///
/// `lastUserDataAt` has to be moved by file bytes and text messages, which
/// arrive on WebRTC's delivery threads and on each driver's notice drain. The
/// surface that owns the room is main-actor isolated. Hopping to the main actor
/// for every inbound chunk would put a thread hop on the transfer's hot path to
/// update a timestamp, and — worse — would make the update arrive out of order
/// with the thing that reads it.
///
/// So the clock and the controller are reached DIRECTLY. Both are thread-safe
/// by construction: the clock takes a lock around one `TimeInterval`, and
/// `RelayRenewController.userDataMoved()` only enqueues onto its own serial
/// queue. This object exists to hold the pair together and to let the
/// controller be attached and detached — which happens on the main actor, at
/// publication and at the end — without the reporting side ever knowing.
///
/// ## Why it is safe for the hot path
///
/// One uncontended `NSLock` acquisition and one timestamp write per report.
/// Reports are per message and per progress notice, not per frame.
public final class RelayRenewUserDataSink: @unchecked Sendable {
    private let lock = NSLock()
    private let clock: RelayRenewActivityClock
    private let now: () -> TimeInterval
    private var controller: RelayRenewController?

    public init(clock: RelayRenewActivityClock,
                now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.clock = clock
        self.now = now
    }

    /// Point this sink at the live link's controller, or at nothing.
    ///
    /// Nil is the ordinary state before a link publishes and after one ends —
    /// the clock still records, because the room's activity is the room's, but
    /// there is nobody to re-evaluate a margin for.
    public func attach(_ controller: RelayRenewController?) {
        lock.lock(); defer { lock.unlock() }
        self.controller = controller
    }

    /// Record one piece of authenticated user-lane traffic and re-evaluate.
    ///
    /// The re-evaluation is the half that is easy to leave out: the renewal
    /// margin is a WINDOW, so a transfer that starts partway through it has to
    /// be able to make a link that was idle at the window's opening renewable
    /// now. Without this call that link would keep its original deadline and
    /// die mid-transfer.
    public func record(_ kind: RelayRenewUserData) {
        lock.lock()
        let controller = self.controller
        lock.unlock()
        clock.record(kind, at: now())
        controller?.userDataMoved()
    }
}

/// One value, readable and writable from any thread.
///
/// The renewal controller's closures run on its own serial queue while the
/// state they describe is owned by a main-actor model. Each such fact is either
/// captured as an immutable when the controller is built or published through
/// one of these — never read off the model from the wrong executor.
public final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    public init(_ value: Value) { self.value = value }

    public func get() -> Value {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    public func set(_ newValue: Value) {
        lock.lock(); value = newValue; lock.unlock()
    }
}
