import Foundation
@testable import RelayiumKit

final class FakeWebSocketChannel: WebSocketChannel {
    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    var onClose: (() -> Void)?
    private(set) var sent: [String] = []
    private(set) var closed = false
    var isOpen: Bool = false

    func send(_ text: String) { if isOpen { sent.append(text) } }
    func close() { closed = true; isOpen = false; onClose?() }

    // Test drivers:
    func fireOpen() { isOpen = true; onOpen?() }
    func fireText(_ t: String) { onText?(t) }
    func fireRemoteClose() { isOpen = false; onClose?() }
}
