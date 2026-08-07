import Foundation

/// A thread-safe, shared handle for one outbound link request.
///
/// Settlement is one-shot. User callbacks always run after the operation's lock
/// is released, so observers may safely re-enter the operation.
final class LinkRequestOperation: @unchecked Sendable {
    enum Outcome: Equatable {
        case establishing
        case refused
        case timedOut
        case cancelled
    }

    final class ObserverToken: @unchecked Sendable {
        private let lock = NSLock()
        private var removal: (() -> Void)?

        fileprivate init(removal: @escaping () -> Void) {
            self.removal = removal
        }

        func cancel() {
            lock.lock()
            let removal = self.removal
            self.removal = nil
            lock.unlock()
            removal?()
        }

        deinit { cancel() }
    }

    private let lock = NSLock()
    private var observers: [UInt64: (Outcome) -> Void] = [:]
    private var nextObserverID: UInt64 = 0
    private var outcome: Outcome?

    var settledOutcome: Outcome? {
        lock.lock()
        defer { lock.unlock() }
        return outcome
    }

    @discardableResult
    func observe(_ callback: @escaping (Outcome) -> Void) -> ObserverToken {
        lock.lock()
        if let outcome {
            lock.unlock()
            callback(outcome)
            return ObserverToken(removal: {})
        }
        let id = nextObserverID
        nextObserverID &+= 1
        observers[id] = callback
        lock.unlock()

        return ObserverToken { [weak self] in
            self?.removeObserver(id)
        }
    }

    @discardableResult
    func settle(_ outcome: Outcome) -> Bool {
        lock.lock()
        guard self.outcome == nil else {
            lock.unlock()
            return false
        }
        self.outcome = outcome
        let callbacks = Array(observers.values)
        observers.removeAll()
        lock.unlock()

        for callback in callbacks {
            callback(outcome)
        }
        return true
    }

    private func removeObserver(_ id: UInt64) {
        lock.lock()
        let removed = observers.removeValue(forKey: id)
        lock.unlock()
        _ = removed
    }
}
