import Foundation
@testable import RelayiumKit

final class FakeWebSocketChannel: WebSocketChannel {
    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    var onClose: (() -> Void)?
    private let stateLock = NSLock()
    private var _sent: [String] = []
    private var _closed = false
    private var _isOpen = false

    // Internal (not private(set)): tests across files reset the captured frames.
    // Production code sends from background Tasks, so reads need the same lock
    // as writes or polling the capture itself introduces a data race.
    var sent: [String] {
        get { stateLock.withLock { _sent } }
        set { stateLock.withLock { _sent = newValue } }
    }
    var closed: Bool { stateLock.withLock { _closed } }
    var isOpen: Bool { stateLock.withLock { _isOpen } }

    func send(_ text: String) {
        stateLock.withLock {
            if _isOpen { _sent.append(text) }
        }
    }
    func close() {
        stateLock.withLock {
            _closed = true
            _isOpen = false
        }
        onClose?()
    }

    // Test drivers:
    func fireOpen() {
        stateLock.withLock { _isOpen = true }
        onOpen?()
    }
    func fireText(_ t: String) { onText?(t) }
    func fireRemoteClose() {
        stateLock.withLock { _isOpen = false }
        onClose?()
    }
}
