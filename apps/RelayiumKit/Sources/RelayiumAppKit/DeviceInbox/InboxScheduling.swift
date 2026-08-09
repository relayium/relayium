import Foundation

/// Waiting between passes, and being woken out of it.
///
/// A seam rather than `Task.sleep`, for the reason `WORKFLOW-LEARNINGS` records
/// about environmental branches: a scheduler whose only clock is the real one has
/// tests that either take minutes or assert nothing. Every timing decision this
/// controller makes — the idle poll, the bounded failure backoff, the prompt wake
/// after an explicit user action — is observable through this protocol as a
/// requested interval, and drivable without one second of wall clock.
///
/// `wake` is the other half and is not decoration: an inbox that only reacts on
/// its own schedule makes "Try again" a button that appears to do nothing for the
/// next four minutes.
public protocol InboxSleeping: AnyObject, Sendable {
    /// Suspend for `seconds`, or until `wake()`, whichever comes first.
    func sleep(_ seconds: TimeInterval) async
    /// End the current sleep now. Safe to call when nothing is sleeping.
    func wake()
}

/// The real one.
///
/// A cancellable child task rather than a bare `Task.sleep`, because the wake has
/// to come from OUTSIDE the sleeping context — a menu-bar click, a folder change,
/// a resumed pause — and cancelling the task the loop is awaiting is the only way
/// to do that without a timer that keeps the process busy while it waits.
public final class InboxTaskSleeper: InboxSleeping, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Task<Void, Never>?

    public init() {}

    public func sleep(_ seconds: TimeInterval) async {
        guard seconds > 0 else { return }
        let nanoseconds = UInt64(min(seconds, 86_400) * 1_000_000_000)
        let task = Task<Void, Never> {
            do { try await Task.sleep(nanoseconds: nanoseconds) } catch {}
        }
        adopt(task)
        await task.value
        retire(task)
    }

    public func wake() { take()?.cancel() }

    /// The three below are non-`async` on purpose: taking an `NSLock` directly
    /// inside an `async` function is an error under the Swift 6 language mode.
    private func adopt(_ task: Task<Void, Never>) {
        lock.lock(); defer { lock.unlock() }
        current = task
    }

    /// Clear only if the finished sleep is still the registered one, so a sleep
    /// that ends just as the next one starts cannot leave the new one unwakeable.
    private func retire(_ task: Task<Void, Never>) {
        lock.lock(); defer { lock.unlock() }
        if current == task { current = nil }
    }

    private func take() -> Task<Void, Never>? {
        lock.lock(); defer { lock.unlock() }
        let previous = current
        current = nil
        return previous
    }
}

/// How long to wait before the next pass.
///
/// Bounded in both directions, and the bounds are the product requirement rather
/// than tuning. Too eager and an offline Mac spins a network request every second
/// for as long as the user's wifi is down; too lazy and a file sent from a phone
/// sits in the queue for ten minutes while the Mac it was sent to is awake and
/// idle. The cap is what makes "continues after the unique window closes" a
/// promise rather than a hope: the loop never stops, it only slows.
public struct InboxBackoff: Equatable, Sendable {
    /// Nothing to do, everything healthy.
    public var idle: TimeInterval
    /// A delivery was just worked. Short, because deliveries arrive in batches
    /// and the sender is usually still watching.
    public var afterWork: TimeInterval
    /// First retry after a failed pass.
    public var first: TimeInterval
    /// Ceiling for the doubling. Reached and then held, forever if need be.
    public var cap: TimeInterval
    /// A local blocker a person has to clear. Slower than a failure retry: no
    /// amount of polling fixes a revoked folder grant, and the recheck exists
    /// only so that fixing it is noticed without the user going back to Settings.
    public var blocked: TimeInterval

    public init(idle: TimeInterval = 30, afterWork: TimeInterval = 2,
                first: TimeInterval = 5, cap: TimeInterval = 300,
                blocked: TimeInterval = 60) {
        self.idle = idle
        self.afterWork = afterWork
        self.first = first
        self.cap = cap
        self.blocked = blocked
    }

    /// The delay after `failures` consecutive failed passes, doubling from
    /// `first` and clamped at `cap`.
    ///
    /// Computed by doubling in a loop rather than with `pow`, so a long outage
    /// cannot produce an infinite or NaN interval on its way to the cap — a
    /// floating-point overflow here would be a sleep of an unrepresentable
    /// length, which is a stopped inbox rather than a slow one.
    public func delay(afterFailures failures: Int) -> TimeInterval {
        guard failures > 0 else { return idle }
        var value = first
        for _ in 1..<failures {
            value *= 2
            if value >= cap { return cap }
        }
        return min(value, cap)
    }
}
