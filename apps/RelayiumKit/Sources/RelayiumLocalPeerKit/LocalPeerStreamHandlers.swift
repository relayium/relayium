import Foundation

/// Pure one-shot ownership rules for a stream. An end observed before a close
/// handler exists remains owed to the first handler installed afterwards.
struct LocalPeerStreamHandlers {
    enum CloseState: Equatable { case open, endedUndelivered, delivered }
    enum StartDecision: Equatable { case start, ignore }
    enum CancelDecision: Equatable { case cancel, ignore }

    var onBytes: ((Data) -> Void)?
    private(set) var onClosed: (() -> Void)?
    private(set) var closeState: CloseState = .open
    private(set) var hasStarted = false
    private(set) var hasCancelled = false

    func byteCallback() -> ((Data) -> Void)? { onBytes }

    mutating func installCloseHandler(_ handler: (() -> Void)?) -> (() -> Void)? {
        guard let handler else {
            onClosed = nil
            return nil
        }
        switch closeState {
        case .open:
            onClosed = handler
            return nil
        case .endedUndelivered:
            closeState = .delivered
            onClosed = nil
            return handler
        case .delivered:
            onClosed = nil
            return nil
        }
    }

    mutating func takeCloseCallback() -> (() -> Void)? {
        guard closeState == .open else { return nil }
        guard let callback = onClosed else {
            closeState = .endedUndelivered
            return nil
        }
        closeState = .delivered
        onClosed = nil
        return callback
    }

    mutating func start() -> StartDecision {
        guard !hasStarted else { return .ignore }
        hasStarted = true
        return .start
    }

    mutating func cancel() -> CancelDecision {
        guard !hasCancelled else { return .ignore }
        hasCancelled = true
        return .cancel
    }
}

/// The only synchronization point between an owner queue and Network.framework
/// delivery. Owner callbacks are returned and invoked after unlocking.
final class LocalPeerStreamHandlerBox {
    private let lock = NSLock()
    private var state = LocalPeerStreamHandlers()

    var onBytes: ((Data) -> Void)? {
        get { locked { $0.onBytes } }
        set { locked { $0.onBytes = newValue } }
    }

    var onClosed: (() -> Void)? { locked { $0.onClosed } }
    func installCloseHandler(_ value: (() -> Void)?) -> (() -> Void)? {
        locked { $0.installCloseHandler(value) }
    }
    func byteCallback() -> ((Data) -> Void)? { locked { $0.byteCallback() } }
    func takeCloseCallback() -> (() -> Void)? { locked { $0.takeCloseCallback() } }
    func start() -> LocalPeerStreamHandlers.StartDecision { locked { $0.start() } }
    func cancel() -> LocalPeerStreamHandlers.CancelDecision { locked { $0.cancel() } }
    var snapshot: LocalPeerStreamHandlers { locked { $0 } }

    private func locked<T>(_ body: (inout LocalPeerStreamHandlers) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }
}
