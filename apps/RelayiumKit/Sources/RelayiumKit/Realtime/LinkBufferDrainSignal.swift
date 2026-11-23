import Foundation

/// One non-blocking, one-shot file-buffer subscription per transport. The
/// callback is only a hint: the producer must recheck buffer and receive credit.
/// No transport queue is entered on subscribe/cancel and no callback runs under
/// the leaf lock. A cancellation can race a captured callback; run/transport
/// correlation belongs to the consumer.
final class LinkBufferDrainSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var nextID: UInt64 = 0
    private var pending: (id: UInt64, threshold: UInt64, wake: () -> Void)?

    func observe(whenAtMost threshold: UInt64, wake: @escaping () -> Void) -> () -> Void {
        lock.lock()
        nextID &+= 1
        let id = nextID
        pending = (id, threshold, wake)
        lock.unlock()
        return { [weak self] in
            guard let self else { return }
            self.lock.lock()
            if self.pending?.id == id { self.pending = nil }
            self.lock.unlock()
        }
    }

    func notify(bufferedAmount: UInt64) {
        lock.lock()
        let wake: (() -> Void)?
        if let current = pending, bufferedAmount <= current.threshold {
            wake = current.wake
            pending = nil
        } else {
            wake = nil
        }
        lock.unlock()
        wake?()
    }
}
