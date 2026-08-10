import Foundation

/// Cancels one `addSignalListener` registration.
///
/// A class rather than a returned closure so the call site reads as a
/// subscription it is holding, and so Swift's unused-result warning catches a
/// registration nobody kept — a listener that cannot be cancelled is a listener
/// that outlives the thing it repaints.
public final class SignalSubscription {
    private weak var client: SignalingClient?
    private let id: Int
    private let lock = NSLock()
    private var cancelled = false

    fileprivate init(client: SignalingClient, id: Int) {
        self.client = client
        self.id = id
    }

    /// Idempotent, and safe from any thread: `stop` and a socket drop both reach
    /// for it.
    public func cancel() {
        lock.lock()
        let first = !cancelled
        cancelled = true
        lock.unlock()
        guard first else { return }
        client?.removeSignalListener(id)
    }

    /// RAII: dropping the subscription unregisters it.
    ///
    /// Without this, an owner that replaces its subscription — or is itself
    /// deallocated — leaves the old closure registered on a client that may
    /// outlive it, and the listener keeps interpreting frames on behalf of an
    /// object nobody can reach any more. `cancel()` stays public because the
    /// common case (a socket drop) needs to unregister at a moment that is not
    /// the owner's deallocation.
    deinit { cancel() }
}

/// What an interceptor decided about one inbound frame.
public enum SignalDisposition: Equatable {
    /// Not mine. Keep routing it: later interceptors, then the per-connection
    /// slot.
    case pass
    /// Claimed. Routing stops here — no later interceptor and, crucially, not
    /// the per-connection slot either.
    case consume
}

/// Proof of one `installSignalHandler` call, so its installer can clear the
/// per-connection slot without being able to clear anybody else's.
///
/// Opaque and value-typed on purpose: it carries no reference back to the
/// client, so holding one in a `deinit` (which is exactly where the stale-close
/// hazard lives) cannot resurrect anything.
public struct SignalHandlerToken: Equatable {
    fileprivate let id: Int
}

/// WebSocket rendezvous client: joins a code room, surfaces the self id + peer
/// roster, relays opaque `signal` payloads. Mirrors web/src/lib/signaling.ts.
public final class SignalingClient {
    public var onSelfId: ((String, String) -> Void)?   // (selfPeerId, serverObservedIP)
    public var onPeers: (([Peer]) -> Void)?
    /// One peer's signaling connection actually closed.
    ///
    /// Deliberately *not* derivable from `onPeers`. A peer can leave the roster
    /// because a representative handoff moved that device's advertised id to
    /// another of its connections, and tearing down a session on that is a bug:
    /// the device is still there. The hub emits `left` only for a physical
    /// departure, which is the one signal that is definitive permission to tear
    /// down sessions bound to that peer id. Mirrors the same distinction in
    /// web/src/lib/signaling.ts.
    public var onPeerLeft: ((String) -> Void)?
    /// The single per-connection slot. `RealtimeConnection` takes it over when it
    /// is built and gives it back on close, so it is last-writer-wins by design:
    /// exactly one live connection interprets SDP/ICE/reveal at a time.
    ///
    /// A listener that has to survive that takeover — a persistent
    /// unsolicited-offer router — belongs in `addSignalInterceptor` instead.
    ///
    /// Assigning here always wins and always invalidates the previous owner's
    /// token. A connection that wants to be able to clear *only its own*
    /// installation must use `installSignalHandler`/`removeSignalHandler`: see
    /// `SignalHandlerToken` for the stale-close hazard that exists otherwise.
    public var onSignal: ((String, JSONValue) -> Void)? { // (fromPeerId, data)
        get {
            slotLock.lock(); defer { slotLock.unlock() }
            return _onSignal
        }
        set {
            slotLock.lock()
            slotOwner += 1
            _onSignal = newValue
            slotLock.unlock()
        }
    }
    private var _onSignal: ((String, JSONValue) -> Void)?
    /// Identifies the current installation. Monotonic, so a token can only ever
    /// be current for the one installation that minted it.
    private var slotOwner = 0
    private let slotLock = NSLock()

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
    /// The name this socket puts in its `join` frame — i.e. the label every
    /// other member of the room sees for this device.
    ///
    /// Public and immutable so a surface can state what this Mac is CALLED in
    /// the room without recomputing it. Recomputing is the defect: the device
    /// name is read once, when the socket is built, and a user who renames their
    /// Mac afterwards is still announced under the old name until the socket is
    /// replaced. A UI that asked the system again would print a name nobody in
    /// the room can see.
    public let announcedName: String
    private let enc = JSONEncoder()
    private let dec = JSONDecoder()

    /// Registered alongside — never instead of — `onSignal`. Mirrors
    /// web/src/lib/signaling.ts, whose `onSignal` has always been a list for the
    /// same reason: the browser runs a persistent inbound-offer router at the
    /// same time as a per-connection handler.
    ///
    /// Locked because registration happens on the caller's thread while
    /// dispatch happens on the socket's delivery queue.
    private var listeners: [(id: Int, body: (String, JSONValue) -> SignalDisposition)] = []
    private var nextListenerID = 0
    private let listenerLock = NSLock()

    public init(channel: WebSocketChannel, name: String) {
        self.channel = channel
        self.announcedName = name
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

    /// Observes every inbound signal, independently of `onSignal`, and never
    /// changes where it goes next.
    ///
    /// Registered listeners are not disturbed by a connection claiming
    /// `onSignal`, which is the whole point: background receive has to keep
    /// hearing new offers while a live session owns the single slot. Use this
    /// for tracing and metrics; a listener that has to *route* — to decide that
    /// a frame belongs to it and not to the live connection — needs
    /// `addSignalInterceptor`.
    public func addSignalListener(_ body: @escaping (String, JSONValue) -> Void) -> SignalSubscription {
        addSignalInterceptor { from, data in
            body(from, data)
            return .pass
        }
    }

    /// Subscribes to every inbound signal *and* may claim one.
    ///
    /// Returning `.consume` stops that frame: no later interceptor sees it and
    /// — the point of the whole mechanism — neither does `onSignal`. Without
    /// that, a router cannot both buffer a frame and prevent the live
    /// connection from also acting on it, which is two distinct bugs:
    ///
    /// * a frame buffered for an attempt still being built *also* reaches the
    ///   connection the instant that connection installs itself, so the handoff
    ///   replay then delivers it a second time; and
    /// * a fresh offer from a peer we are already connected to reaches a live
    ///   `setRemoteDescription` as glare, instead of earning the truthful busy
    ///   reply the router wanted to send.
    ///
    /// Interceptors run in registration order, and all of them run before the
    /// slot. That order is load-bearing: it is what lets a router block a live
    /// frame until it has replayed the ones it buffered ahead of it.
    public func addSignalInterceptor(
        _ body: @escaping (String, JSONValue) -> SignalDisposition
    ) -> SignalSubscription {
        listenerLock.lock()
        nextListenerID += 1
        let id = nextListenerID
        listeners.append((id, body))
        listenerLock.unlock()
        return SignalSubscription(client: self, id: id)
    }

    /// Claims the per-connection slot and returns proof of *which* claim it was.
    ///
    /// The bare `onSignal` setter cannot express "clear the slot only if it is
    /// still mine", and that is exactly what a closing connection needs. Two
    /// connections legitimately overlap on one socket — a session ends while
    /// the next one is already being built, and a `RealtimeConnection` clears
    /// the slot from both `close()` and `deinit`, neither of which is ordered
    /// against the new connection's init. Last-writer-wins on the *clear* means
    /// a stale connection silently deletes the live one's handler, and the new
    /// session then never hears its peer's answer, candidates or reveal: it
    /// simply hangs with nothing logged.
    public func installSignalHandler(
        _ body: @escaping (String, JSONValue) -> Void
    ) -> SignalHandlerToken {
        slotLock.lock()
        slotOwner += 1
        let token = SignalHandlerToken(id: slotOwner)
        _onSignal = body
        slotLock.unlock()
        return token
    }

    /// Clears the slot if — and only if — `token` still owns it. A no-op for a
    /// token that has since been superseded, which is the whole point.
    public func removeSignalHandler(_ token: SignalHandlerToken) {
        slotLock.lock()
        if slotOwner == token.id { _onSignal = nil }
        slotLock.unlock()
    }

    fileprivate func removeSignalListener(_ id: Int) {
        listenerLock.lock()
        listeners.removeAll { $0.id == id }
        listenerLock.unlock()
    }

    /// Matches `signal.TypeLeft` on the hub. Named here rather than in
    /// `SignalType` because the client only ever receives it.
    private static let leftType = "left"

    /// Just the `peer` of a `left` frame. A separate model because it has to
    /// reject a non-string `peer`, which `Envelope` — having no such key —
    /// would silently ignore.
    private struct LeftFrame: Decodable { let peer: String? }

    private func sendJoin() { send(Envelope(type: SignalType.join, name: announcedName)) }

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
        case Self.leftType:
            // `Envelope` carries no `peer`, so read that one field separately —
            // and read it strictly. A `left` frame whose peer is missing, empty
            // or not a string names nobody, and acting on it would tear down a
            // session belonging to a peer the hub never said had gone. Ignoring
            // it costs a stale entry until the next roster; guessing costs a
            // live transfer.
            guard let left = try? dec.decode(LeftFrame.self, from: Data(text.utf8)),
                  let peer = left.peer, !peer.isEmpty else { break }
            onPeerLeft?(peer)
        case SignalType.signal:
            guard let from = e.from, let data = e.data else { break }
            // Listeners first, then the per-connection slot, and the order is
            // load-bearing rather than incidental.
            //
            // A persistent router buffers an unsolicited offer and the ICE that
            // chases it, then replays that buffer into a freshly built
            // connection. Between "the connection installed itself in
            // `onSignal`" and "the replay finished" a live frame must not
            // overtake the buffered ones. Running listeners first lets the
            // router block this delivery until its replay is done; the slot
            // below then sees the live frame in the right order.
            listenerLock.lock()
            let current = listeners.map(\.body)
            listenerLock.unlock()
            for listener in current {
                // Claimed: the router has taken responsibility for this frame,
                // so delivering it to the slot as well would be the duplicate.
                if listener(from, data) == .consume { return }
            }
            onSignal?(from, data)
        default:
            break
        }
    }
}
