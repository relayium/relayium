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
    /// A counter of wakes so far, read immediately before deciding to sleep.
    ///
    /// **The half that makes a wake reliable.** `wake()` ends a sleep that is
    /// already registered; a wake that lands after the caller decided to sleep but
    /// before the sleep registered — the hop from the main actor into `sleep` —
    /// would otherwise be lost, and the loop would wait out the whole interval
    /// the wake existed to skip.
    func wakeMark() -> UInt64
    /// Sleep as `sleep(_:)` does, but return at once if any `wake()` happened
    /// after `mark` was read. Wakes from BEFORE the mark are not remembered, so a
    /// stale wake cannot make every later sleep return immediately.
    func sleep(_ seconds: TimeInterval, unlessWokenSince mark: UInt64) async
}

/// Defaults for sleepers that have no wake window to close — test doubles whose
/// `sleep` either never suspends or registers synchronously.
public extension InboxSleeping {
    func wakeMark() -> UInt64 { 0 }
    func sleep(_ seconds: TimeInterval, unlessWokenSince mark: UInt64) async {
        await sleep(seconds)
    }
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
    /// Incremented by every `wake()`. Compared, under the same lock that
    /// registers a sleep, against the mark the caller read before sleeping.
    private var wakes: UInt64 = 0

    public init() {}

    public func sleep(_ seconds: TimeInterval) async {
        await suspend(seconds, unlessWokenSince: nil)
    }

    public func wakeMark() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        return wakes
    }

    public func sleep(_ seconds: TimeInterval, unlessWokenSince mark: UInt64) async {
        await suspend(seconds, unlessWokenSince: mark)
    }

    private func suspend(_ seconds: TimeInterval, unlessWokenSince mark: UInt64?) async {
        guard seconds > 0 else { return }
        let nanoseconds = UInt64(min(seconds, 86_400) * 1_000_000_000)
        let task = Task<Void, Never> {
            do { try await Task.sleep(nanoseconds: nanoseconds) } catch {}
        }
        guard adopt(task, unlessWokenSince: mark) else {
            // A wake landed between the mark and this registration. Honour it
            // rather than waiting out an interval nobody can now interrupt.
            task.cancel()
            return
        }
        await task.value
        retire(task)
    }

    public func wake() { take()?.cancel() }

    /// The three below are non-`async` on purpose: taking an `NSLock` directly
    /// inside an `async` function is an error under the Swift 6 language mode.
    ///
    /// Check-and-register is one critical section, so a concurrent `wake()`
    /// either sees this sleep registered and cancels it, or has already moved the
    /// counter past `mark` and this refuses to register. There is no third order.
    private func adopt(_ task: Task<Void, Never>, unlessWokenSince mark: UInt64?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let mark, wakes != mark { return false }
        current = task
        return true
    }

    /// Clear only if the finished sleep is still the registered one, so a sleep
    /// that ends just as the next one starts cannot leave the new one unwakeable.
    private func retire(_ task: Task<Void, Never>) {
        lock.lock(); defer { lock.unlock() }
        if current == task { current = nil }
    }

    private func take() -> Task<Void, Never>? {
        lock.lock(); defer { lock.unlock() }
        wakes &+= 1
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
