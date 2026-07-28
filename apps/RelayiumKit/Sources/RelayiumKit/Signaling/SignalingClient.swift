import Foundation

/// WebSocket rendezvous client: joins a code room, surfaces the self id + peer
/// roster, relays opaque `signal` payloads. Mirrors web/src/lib/signaling.ts.
public final class SignalingClient {
    public var onSelfId: ((String, String) -> Void)?   // (selfPeerId, serverObservedIP)
    public var onPeers: (([Peer]) -> Void)?
    public var onSignal: ((String, JSONValue) -> Void)? // (fromPeerId, data)
    public var onClose: (() -> Void)?

    /// The id the hub assigned us, once `welcome` has arrived; nil before that.
    ///
    /// Stored, not merely announced through `onSelfId`, because the roster is
    /// unusable without it — the hub broadcasts the whole room to every member,
    /// so "which of these is me" has to be answerable by a caller that
    /// subscribed after `welcome` had already landed.
    public var selfId: String? {
        selfLock.lock(); defer { selfLock.unlock() }
        return _selfId
    }
    private var _selfId: String?
    private let selfLock = NSLock()

    private let channel: WebSocketChannel
    private let name: String
    private let enc = JSONEncoder()
    private let dec = JSONDecoder()

    public init(channel: WebSocketChannel, name: String) {
        self.channel = channel
        self.name = name
        channel.onOpen = { [weak self] in self?.sendJoin() }
        channel.onText = { [weak self] in self?.handle($0) }
        channel.onClose = { [weak self] in self?.onClose?() }
    }

    /// End the signaling session (closes the underlying socket).
    public func close() { channel.close() }

    // Tear down the channel even if `close()` was never called explicitly —
    // e.g. the owner drops the client while the socket is still OPEN. The
    // channel's callbacks are `[weak self]`, so nothing here keeps
    // SignalingClient alive; this just makes sure dropping it also releases
    // the underlying URLSession (see URLSessionWebSocketChannel.close/markClosed).
    deinit { channel.close() }

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
            if let id = e.name {
                selfLock.lock(); _selfId = id; selfLock.unlock()
                onSelfId?(id, e.ip ?? "")
            }
        case SignalType.peers:
            if let p = e.peers { onPeers?(p) }
        case SignalType.signal:
            if let from = e.from, let data = e.data { onSignal?(from, data) }
        default:
            break
        }
    }
}
