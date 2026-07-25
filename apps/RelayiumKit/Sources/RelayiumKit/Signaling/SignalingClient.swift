import Foundation

/// WebSocket rendezvous client: joins a code room, surfaces the self id + peer
/// roster, relays opaque `signal` payloads. Mirrors web/src/lib/signaling.ts.
public final class SignalingClient {
    public var onSelfId: ((String, String) -> Void)?   // (selfPeerId, serverObservedIP)
    public var onPeers: (([Peer]) -> Void)?
    public var onSignal: ((String, JSONValue) -> Void)? // (fromPeerId, data)
    public var onClose: (() -> Void)?

    private let channel: WebSocketChannel
    private let name: String
    private let enc = JSONEncoder()
    private let dec = JSONDecoder()

    public init(channel: WebSocketChannel, name: String) {
        self.channel = channel
        self.name = name
        // Strong self: the channel is often the only thing keeping a freshly
        // `connect()`-ed client alive until its first event fires (a caller may
        // discard the returned instance and rely on the callbacks it already
        // wired up). That makes channel→closure→self and self→channel a cycle;
        // it's broken below once the socket closes, so both can deinit then.
        channel.onOpen = { self.sendJoin() }
        channel.onText = { self.handle($0) }
        channel.onClose = {
            self.onClose?()
            channel.onOpen = nil
            channel.onText = nil
            channel.onClose = nil
        }
    }

    /// Build a real client at `<wsBase>/ws?code=<code>` (empty code → LAN room).
    public static func connect(wsBase: URL, code: String, name: String) -> SignalingClient {
        var comps = URLComponents(url: wsBase.appendingPathComponent("ws"), resolvingAgainstBaseURL: false)!
        if !code.isEmpty { comps.queryItems = [.init(name: "code", value: code)] }
        let ch = URLSessionWebSocketChannel(url: comps.url!)
        return SignalingClient(channel: ch, name: name)
    }

    public func sendSignal(to: String, data: JSONValue) {
        send(Envelope(type: SignalType.signal, to: to, data: data))
    }

    private func sendJoin() { send(Envelope(type: SignalType.join, name: name)) }

    private func send(_ e: Envelope) {
        guard let d = try? enc.encode(e), let s = String(data: d, encoding: .utf8) else { return }
        channel.send(s)   // WebSocketChannel.send is itself best-effort (no-op when closed)
    }

    private func handle(_ text: String) {
        // Untrusted inbound: a malformed frame is dropped, never crashes the loop.
        guard let e = try? dec.decode(Envelope.self, from: Data(text.utf8)) else { return }
        switch e.type {
        case SignalType.welcome:
            if let id = e.name { onSelfId?(id, e.ip ?? "") }
        case SignalType.peers:
            if let p = e.peers { onPeers?(p) }
        case SignalType.signal:
            if let from = e.from, let data = e.data { onSignal?(from, data) }
        default:
            break
        }
    }
}
