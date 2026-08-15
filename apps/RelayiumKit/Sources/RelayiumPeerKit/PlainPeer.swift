import Foundation
import RelayiumAppKit
import RelayiumKit
import WebRTC

// The plain WebRTC peer that `RealtimeE2E` and `NearbyReceiveE2E` each grew
// their own copy of.
//
// Both had the same three parts and had diverged in all of them: join a room,
// find ONE named counterpart on the roster rather than whoever else is in it,
// and build a `RealtimeConnection` with the full callback set wired. The
// divergences were not cosmetic — one waited for a peer inside `onPeers` and one
// polled, one guarded against re-entry with a `started` flag and one with a
// `peerId == nil` check, and only one of them had learned that `send()` must not
// be called on the connection's own callback queue. This is the union, once.
//
// It is deliberately NOT the app's model layer. `AppReceiverHost` is that, and
// the two exist side by side because an acceptance run needs both halves to be
// real in different ways: one end has to be the machinery a user's app actually
// runs, and the other has to be an independent implementation that can state
// what it sent without asking the first one.

public final class PlainPeer: @unchecked Sendable {

    public struct Options {
        /// The origin whose `/ws` hub this peer rendezvouses through.
        public var baseURL: URL
        /// The pairing code, or "" for the hub's code-less room.
        public var code: String
        /// This peer's announced name.
        public var name: String
        /// **No default, and no public STUN anywhere in this module.** Both
        /// existing harnesses hard-code `stun.l.google.com`, which sends this
        /// machine's address to Google on every run and makes an "offline"
        /// acceptance run quietly depend on the internet. Peers on one machine
        /// pair on host candidates, so the correct value for a local run is the
        /// empty list — and it has to be passed rather than defaulted, so a call
        /// site that wants servers has to say which.
        public var iceServers: [RTCIceServer]
        public var log: @Sendable (String) -> Void

        public init(baseURL: URL, code: String, name: String,
                    iceServers: [RTCIceServer],
                    log: @escaping @Sendable (String) -> Void) {
            self.baseURL = baseURL
            self.code = code
            self.name = name
            self.iceServers = iceServers
            self.log = log
        }
    }

    /// Everything a caller may want to observe about one session, in one value
    /// rather than as eight optional closures each harness set a different
    /// subset of.
    public struct Handlers {
        public var onSAS: ((String) -> Void)?
        public var onOpen: ((RealtimeConnection) -> Void)?
        public var onManifest: (([FileMeta]) -> Void)?
        public var onChunk: (([UInt8]) -> Void)?
        public var onProgress: ((Int) -> Void)?
        public var onDone: ((Bool) -> Void)?
        public var onText: ((String, Int) -> Void)?
        public var onControl: ((RealtimeControl) -> Void)?
        public var onError: ((Error) -> Void)?
        public var onClose: (() -> Void)?

        public init() {}
    }

    public let options: Options
    public let signaling: SignalingClient

    private let lock = NSLock()
    private var roster: [String: String] = [:]      // announced name -> peer id
    private var sessions: [RealtimeConnection] = []
    private var _selfId: String?

    public var selfId: String? { lock.lock(); defer { lock.unlock() }; return _selfId }

    public init(options: Options) {
        self.options = options
        signaling = SignalingClient.connect(
            wsBase: RealtimeConnectionFactory.signalingBase(options.baseURL),
            code: options.code,
            name: options.name)
        let log = options.log
        let name = options.name
        signaling.onSelfId = { [weak self] id, ip in
            self?.lock.lock(); self?._selfId = id; self?.lock.unlock()
            log("\(name): self=\(id) ip=\(ip)")
        }
        signaling.onClose = { log("\(name): signalling closed") }
        // The roster is RECORDED rather than acted on, and that is the fix for
        // the race both harnesses carried in different shapes. Acting inside
        // `onPeers` means the decision to connect happens on the socket's
        // delivery path, where re-entrancy has to be guarded by a flag that each
        // harness invented separately; recording it lets the caller ask when it
        // is ready, exactly once, from wherever it is running.
        signaling.onPeers = { [weak self] peers in
            guard let self else { return }
            lock.lock()
            for peer in peers { roster[peer.name] = peer.id }
            lock.unlock()
            log("\(name): roster \(peers.map(\.name))")
        }
    }

    /// The peer id announced under `name`, if it is in the room right now.
    ///
    /// **By exact name, never "the first other peer".** A code-less room is
    /// keyed by observed public address, so on a production origin it can
    /// contain a stranger sharing that address; on a loopback origin it can
    /// contain another run on the same machine. Matching by name is what makes
    /// an acceptance run pair with its own counterpart in both cases.
    public func peerId(named name: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return roster[name]
    }

    /// Waits for a named peer to join, or gives up.
    ///
    /// Polling rather than a continuation resumed from `onPeers`: the roster is
    /// broadcast on every join, so a peer that was already present when this
    /// peer connected arrives in the FIRST roster and a one-shot continuation
    /// armed afterwards would wait for a second one that may never come.
    public func awaitPeer(named name: String, timeout: TimeInterval) async -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let id = peerId(named: name) { return id }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        options.log("\(options.name): gave up waiting for \(name)")
        return nil
    }

    /// Builds and wires one session on this peer's room socket.
    ///
    /// The connection is returned rather than kept private because the caller
    /// drives it — `accept()`, `send()`, `confirmTextSAS()` — and retained here
    /// too, so `close()` can retire every session this peer opened without the
    /// caller tracking them.
    ///
    /// `start` defaults to true, and the default is the safe direction. An
    /// initiator that is built and never started looks exactly like one waiting
    /// on the network: the roster matched, the session exists, and nothing ever
    /// happens until the timeout blames the far side. Both existing harnesses
    /// call `start()` by hand, and the first run of this extraction reproduced
    /// that omission — so the wiring and the start are one call, and a caller
    /// that genuinely needs to delay the offer has to say so.
    @discardableResult
    public func connect(to peerId: String,
                        role: Role,
                        mode: RealtimeConnectionFactory.Mode = .file,
                        start: Bool = true,
                        handlers: Handlers) -> RealtimeConnection {
        let connection = RealtimeConnection(
            signaling: signaling, peerId: peerId, role: role,
            iceServers: options.iceServers,
            // `.all`, and never `.relay`: a relay-only policy on a room with no
            // TURN server produces a session that gathers nothing and fails
            // after the ICE timeout, which reads as a product bug. The local
            // acceptance server issues no relay at all, by design.
            iceTransportPolicy: .all,
            generation: mode == .text ? .text : .file,
            localCapabilities: mode == .text ? [TEXT_CAPABILITY] : [])
        let log = options.log
        let name = options.name
        connection.onSAS = { sas in
            log("\(name): SAS=\(sas)")
            handlers.onSAS?(sas)
        }
        connection.onOpen = { [weak connection] in
            log("\(name): channel open")
            guard let connection else { return }
            handlers.onOpen?(connection)
        }
        connection.onManifest = { handlers.onManifest?($0) }
        connection.onFileChunk = { handlers.onChunk?($0) }
        connection.onProgress = { handlers.onProgress?($0) }
        connection.onDone = { ok in
            log("\(name): DONE ok=\(ok)")
            handlers.onDone?(ok)
        }
        connection.onText = { body, at in handlers.onText?(body, at) }
        connection.onControl = { control in
            log("\(name): control \(control)")
            handlers.onControl?(control)
        }
        connection.onError = { error in
            log("\(name): ERROR \(error)")
            handlers.onError?(error)
        }
        connection.onClose = {
            log("\(name): connection closed")
            handlers.onClose?()
        }
        lock.lock(); sessions.append(connection); lock.unlock()
        if start { connection.start() }
        return connection
    }

    /// Hands a batch to an open connection from OFF the connection's queue.
    ///
    /// `send()` does a `queue.sync` internally, so calling it from `onOpen` —
    /// which runs on that very queue — deadlocks. Both harnesses learned this
    /// separately and each wrote the `DispatchQueue.global().async` hop inline
    /// with a comment explaining it; it belongs here, where a third caller
    /// cannot rediscover it.
    public func send(_ batch: [(meta: FileMeta, bytes: [UInt8])],
                     on connection: RealtimeConnection) {
        DispatchQueue.global().async {
            connection.send(sources: batch.map { DataSource(name: $0.meta.name, bytes: $0.bytes) },
                            metas: batch.map(\.meta))
        }
    }

    public func close() {
        lock.lock()
        let open = sessions
        sessions = []
        lock.unlock()
        for connection in open { connection.close() }
        signaling.close()
    }
}
