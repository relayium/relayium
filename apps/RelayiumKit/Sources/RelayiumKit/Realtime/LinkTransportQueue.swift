import Foundation

/// The private serial queue a link transport serializes on, plus the two
/// re-entrancy questions that queue has to answer.
///
/// ## Why a type rather than a bare `DispatchQueue`
///
/// Every client callback a link transport makes fires ON its queue, and a
/// client is entitled to call back into the transport from one. That makes two
/// otherwise-invisible decisions load-bearing, and both of them are wrong by
/// default:
///
///  - **`sync` from a callback is a self-deadlock.** A consumer asking
///    `bufferedAmount` from inside `onFrame` — the obvious place to ask — is
///    already on the queue. `RealtimeConnection.textBufferedAmount` has the
///    unguarded shape.
///  - **`async` from a callback is a lie about ordering.** `close()` called
///    from `onSAS` or `onReady` must take effect *before* the code that invoked
///    the callback continues, or the transport goes on to send its reveal and
///    replay a backlog into a consumer that has already said stop. Scheduling
///    the close behind the current callback makes it arrive after exactly the
///    work it was meant to prevent.
///
/// Wrapping the queue is what makes both answerable without a live peer:
/// `isCurrent` and `nowOrLater` are ordinary unit tests here, where the same
/// decisions welded into a WebRTC driver would only be reachable from a
/// two-peer run.
///
/// Each instance marks its own queue with its own identity, so a transport
/// running inside another transport's callback correctly sees "not my queue".
public final class LinkTransportQueue: @unchecked Sendable {
    /// One process-wide key holding a per-instance value. The key identifies
    /// the question ("which link transport queue is this?"); the value
    /// identifies the answer.
    private static let key = DispatchSpecificKey<ObjectIdentifier>()
    private let queue: DispatchQueue

    public init(label: String) {
        self.queue = DispatchQueue(label: label)
        queue.setSpecific(key: Self.key, value: ObjectIdentifier(self))
    }

    /// True when the calling thread is already executing on this exact queue.
    public var isCurrent: Bool {
        DispatchQueue.getSpecific(key: Self.key) == ObjectIdentifier(self)
    }

    /// Run `body` on the queue and return its result, inline when the caller is
    /// already there.
    public func sync<T>(_ body: () throws -> T) rethrows -> T {
        if isCurrent { return try body() }
        return try queue.sync(execute: body)
    }

    /// Run `body` INLINE when the caller is already on the queue, and
    /// asynchronously otherwise.
    ///
    /// The inline branch is the whole point: it is what lets a callback's
    /// `close()` be finished before the callback returns. The asynchronous
    /// branch is equally deliberate — an outside caller must not be blocked on
    /// `RTCPeerConnection.close()`, which joins WebRTC's internal threads, and
    /// ordering is unaffected because anything that thread issues afterwards
    /// queues behind it.
    public func nowOrLater(_ body: @escaping () -> Void) {
        if isCurrent {
            body()
            return
        }
        queue.async(execute: body)
    }

    /// Always asynchronous. For work arriving from a WebRTC-internal thread,
    /// which must never run inline on the thread that delivered it.
    public func later(_ body: @escaping () -> Void) {
        queue.async(execute: body)
    }

    /// Schedule `body` on the queue after `delay`. The returned item is the
    /// owner's only handle on it: cancelling before it starts is what keeps a
    /// superseded deadline from firing.
    @discardableResult
    public func after(_ delay: TimeInterval, _ body: @escaping () -> Void) -> DispatchWorkItem {
        let item = DispatchWorkItem(block: body)
        queue.asyncAfter(deadline: .now() + max(0, delay), execute: item)
        return item
    }
}
