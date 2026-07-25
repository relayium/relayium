import Foundation

/// The minimal socket surface SignalingClient needs. Abstracted so tests inject
/// a fake and the real implementation wraps URLSessionWebSocketTask.
public protocol WebSocketChannel: AnyObject {
    var onOpen: (() -> Void)? { get set }
    var onText: ((String) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    var isOpen: Bool { get }
    func send(_ text: String)
    func close()
}

/// Real WebSocket over URLSessionWebSocketTask. Connects on init; drives a
/// receive loop that forwards text frames to onText and ends on error/close.
public final class URLSessionWebSocketChannel: NSObject, WebSocketChannel, URLSessionWebSocketDelegate {
    public var onOpen: (() -> Void)?
    public var onText: ((String) -> Void)?
    public var onClose: (() -> Void)?
    public private(set) var isOpen = false

    private var task: URLSessionWebSocketTask!
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    private var closedFired = false   // one-shot: a close arrives via BOTH the receive
                                       // failure and the didClose delegate — fire onClose once.

    public init(url: URL) {
        super.init()
        task = session.webSocketTask(with: url)
        task.resume()
        receive()
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                if case let .string(s) = msg { self.onText?(s) }
                self.receive()   // keep reading
            case .failure:
                self.markClosed()
            }
        }
    }
    private func markClosed() {
        guard !closedFired else { return }   // idempotent: at most one onClose per socket
        closedFired = true
        isOpen = false
        onClose?()
        // URLSession retains its delegate (self) until invalidated; break the
        // session <-> channel retain cycle on every terminal path (remote drop,
        // receive failure, or explicit close all funnel through here).
        session.invalidateAndCancel()
    }

    public func send(_ text: String) {
        guard isOpen else { return }          // best-effort; drop when not open
        task.send(.string(text)) { _ in }     // fire-and-forget; a lost frame is re-aligned after reconnect
    }
    public func close() {
        isOpen = false
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()   // safe to call again even if already invalidated
    }

    // URLSessionWebSocketDelegate:
    public func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol proto: String?) { isOpen = true; onOpen?() }
    public func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) { markClosed() }
}
