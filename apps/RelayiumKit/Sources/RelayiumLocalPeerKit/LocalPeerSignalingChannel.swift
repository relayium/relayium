import Foundation
import RelayiumKit

/// A local hub adapter: Bonjour supplies the roster, direct TCP carries only
/// addressed `signal` envelopes, and the existing `SignalingClient` remains the
/// sole interface seen by the app and WebRTC layers.
public final class LocalPeerSignalingChannel: WebSocketChannel, LocalPeerTransportDelegate {
    public var onOpen: (() -> Void)?
    public var onText: ((String) -> Void)?
    public var onClose: (() -> Void)?
    /// Written on `queue`, read by anyone holding the channel. Locked rather
    /// than a bare stored property because `WebSocketChannel` publishes it to
    /// callers this class does not control the thread of, and an unsynchronized
    /// `Bool` read across a queue boundary is a data race whether or not a
    /// particular reader ever observes the torn answer.
    public var isOpen: Bool {
        openLock.lock(); defer { openLock.unlock() }
        return _isOpen
    }
    private var _isOpen = false
    private let openLock = NSLock()

    public static let inboundGracePeriod: TimeInterval = 5
    public static let maximumGraceFrames = 16

    public let advertisement: LocalPeerAdvertisement
    private let transport: LocalPeerTransport
    private let queue: DispatchQueue
    private let schedule: (TimeInterval, @escaping () -> Void) -> Void
    private var discovered: [String: LocalPeerAdvertisement] = [:]
    private var connections: [String: Record] = [:]
    private var pending: [Record] = []
    private var joined = false
    private var closed = false

    private final class Record {
        let connection: LocalPeerConnection
        let outbound: Bool
        var reader = LocalPeerFraming.Reader()
        var heldFrames: [String] = []

        init(connection: LocalPeerConnection, outbound: Bool) {
            self.connection = connection
            self.outbound = outbound
        }
    }

    public init(advertisement: LocalPeerAdvertisement,
                transport: LocalPeerTransport,
                queue: DispatchQueue = DispatchQueue(label: "com.relayium.localpeer.channel"),
                schedule: ((TimeInterval, @escaping () -> Void) -> Void)? = nil) {
        self.advertisement = advertisement
        self.transport = transport
        self.queue = queue
        self.schedule = schedule ?? { delay, body in
            queue.asyncAfter(deadline: .now() + delay, execute: body)
        }
    }

    /// Arm the listener and browser. Separate from `init` on purpose, and the
    /// separation is load-bearing rather than stylistic.
    ///
    /// `SignalingClient` is constructed FROM this channel and installs
    /// `onOpen`/`onText`/`onClose` afterwards. A transport that announced
    /// readiness — or failure — inside `init` would deliver that edge into three
    /// nil handlers, and nothing ever re-announces one: the join would never be
    /// sent, `welcome` would never be synthesized, and `LanDiscoveryModel` would
    /// sit in `connecting` forever with no error and no retry.
    /// `NetworkLocalPeerTransport` happens to hop through its own queue first,
    /// but that is its implementation detail and not something the protocol
    /// promises, so the window is closed here instead of relied upon not to open.
    ///
    /// The `async` hop is also the memory barrier: every handler installed
    /// before this call happens-before anything the queue then reads.
    public func begin() {
        queue.async { [self] in
            guard !closed else { return }
            transport.start(advertising: advertisement, delegate: self)
        }
    }

    deinit { cancelEverything() }

    public func send(_ text: String) {
        queue.async { [weak self] in self?.handleOutbound(text) }
    }

    public func close() {
        queue.async { [weak self] in self?.finish() }
    }

    public func localPeerTransportDidStart() {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.openLock.lock()
            let first = !self._isOpen
            self._isOpen = true
            self.openLock.unlock()
            guard first else { return }
            self.onOpen?()
        }
    }

    public func localPeerTransportDidFail() {
        queue.async { [weak self] in self?.finish() }
    }

    public func localPeerTransport(didDiscover peers: [LocalPeerAdvertisement]) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            var next: [String: LocalPeerAdvertisement] = [:]
            for peer in peers where peer.identity != self.advertisement.identity {
                next[peer.identity] = peer
            }
            let appeared = next.keys.filter { self.discovered[$0] == nil }
            self.discovered = next
            guard self.joined else { return }
            self.publishDiscovery(crediting: appeared)
            for identity in appeared.sorted() { self.flushHeldFrames(for: identity) }
        }
    }

    public func localPeerTransport(didAccept connection: LocalPeerConnection) {
        queue.async { [weak self] in
            guard let self, !self.closed else {
                connection.cancel()
                return
            }
            let record = Record(connection: connection, outbound: false)
            self.attach(record)
            self.pending.append(record)
            connection.start()
            self.schedule(Self.inboundGracePeriod) { [weak self, weak record] in
                guard let self, let record else { return }
                self.queue.async {
                    guard self.contains(record) else { return }
                    let identity = self.identity(for: record)
                    if identity == nil || self.discovered[identity!] == nil {
                        self.drop(record, emitDeparture: false)
                    }
                }
            }
        }
    }

    /// A roster-level capability announcement never opens a stream.
    ///
    /// `LinkCapabilityAnnouncer` greets every peer the roster gains and then
    /// repeats on a bounded timer. In the hub's room each of those frames costs
    /// a relay hop; here each one would be a TCP connection to a device the user
    /// has not chosen, which is precisely the property this transport exists to
    /// keep — browsing lists, only selection dials. The greeting still goes out
    /// on a stream that already exists, because by then the user has chosen that
    /// peer.
    ///
    /// Matched on SHAPE, not on equality with this build's own greeting.
    /// `LanDiscoveryModel.localHello` is injectable and `linkOnlyCapsHello` is
    /// already a shipped alternative, so a rule keyed to one exact value would
    /// start dialling every discovered device the day a composition passed a
    /// different hello — silently, and with nothing failing. A `caps` object
    /// with no other field is a roster announcement whatever it lists; an SDP
    /// confirmation carries `sdp` and `commit` beside it and is not one.
    static func isRosterCapabilityAnnouncement(_ data: JSONValue) -> Bool {
        guard case let .object(fields) = data else { return false }
        return Set(fields.keys) == ["caps"]
    }

    private func handleOutbound(_ text: String) {
        guard !closed, isOpen,
              var envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8))
        else { return }

        if envelope.type == SignalType.join {
            guard !joined else { return }
            joined = true
            emit(Envelope(type: SignalType.welcome, name: advertisement.identity, ip: ""))
            publishDiscovery(crediting: Array(discovered.keys))
            return
        }

        guard envelope.type == SignalType.signal,
              let target = envelope.to,
              LocalPeerAdvertisement.isValidIdentity(target),
              target != advertisement.identity,
              let peer = discovered[target],
              let payload = envelope.data else { return }
        if connections[target] == nil, Self.isRosterCapabilityAnnouncement(payload) { return }

        envelope.from = advertisement.identity
        guard let encoded = try? JSONEncoder().encode(envelope),
              let json = String(data: encoded, encoding: .utf8),
              let frame = LocalPeerFraming.encode(json) else { return }
        let record = connections[target] ?? adopt(transport.connect(to: peer),
                                                   identity: target,
                                                   outbound: true)
        record.connection.send(frame)
    }

    private func adopt(_ connection: LocalPeerConnection,
                       identity: String,
                       outbound: Bool) -> Record {
        let record = Record(connection: connection, outbound: outbound)
        attach(record)
        bind(record, to: identity)
        if connections[identity] === record { connection.start() }
        return connections[identity] ?? record
    }

    private func attach(_ record: Record) {
        record.connection.onBytes = { [weak self, weak record] bytes in
            guard let self, let record else { return }
            self.queue.async { self.receive(bytes, on: record) }
        }
        record.connection.onClosed = { [weak self, weak record] in
            guard let self, let record else { return }
            self.queue.async { self.drop(record, emitDeparture: true) }
        }
    }

    private func bind(_ record: Record, to identity: String) {
        pending.removeAll { $0 === record }
        guard let existing = connections[identity] else {
            connections[identity] = record
            return
        }
        guard existing !== record else { return }

        let winner: Record
        if existing.outbound == record.outbound {
            winner = existing
        } else {
            let keepOutbound = advertisement.identity < identity
            winner = existing.outbound == keepOutbound ? existing : record
        }
        let loser = winner === existing ? record : existing
        connections[identity] = winner
        disownAndCancel(loser)
    }

    private func receive(_ bytes: Data, on record: Record) {
        guard !closed, contains(record) else { return }
        do {
            for frame in try record.reader.append(bytes) { route(frame, on: record) }
        } catch {
            drop(record, emitDeparture: true)
        }
    }

    private func route(_ text: String, on record: Record) {
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
              envelope.type == SignalType.signal,
              let sender = envelope.from,
              LocalPeerAdvertisement.isValidIdentity(sender),
              let payload = envelope.data else { return }
        guard sender != advertisement.identity else {
            drop(record, emitDeparture: false)
            return
        }
        guard envelope.to == advertisement.identity else { return }

        if let bound = identity(for: record) {
            guard bound == sender else {
                drop(record, emitDeparture: true)
                return
            }
        } else {
            bind(record, to: sender)
            guard connections[sender] === record else { return }
        }

        guard discovered[sender] != nil else {
            guard record.heldFrames.count < Self.maximumGraceFrames else {
                drop(record, emitDeparture: true)
                return
            }
            record.heldFrames.append(text)
            return
        }
        deliverSignal(from: sender, data: payload)
    }

    private func flushHeldFrames(for identity: String) {
        guard let record = connections[identity], !record.heldFrames.isEmpty else { return }
        let held = record.heldFrames
        record.heldFrames.removeAll(keepingCapacity: true)
        for text in held {
            guard let envelope = try? JSONDecoder().decode(Envelope.self, from: Data(text.utf8)),
                  envelope.from == identity,
                  envelope.to == advertisement.identity,
                  let payload = envelope.data else { continue }
            deliverSignal(from: identity, data: payload)
        }
    }

    /// Credits each newly appeared peer with the capabilities THAT PEER
    /// advertised, then publishes the roster — in that order, because a device
    /// must never be listed as selectable before what it can speak has been
    /// established. `SignalingClient` runs its listeners synchronously on this
    /// queue, so the registry has recorded the announcement before the `peers`
    /// frame behind it is decoded.
    private func publishDiscovery(crediting identities: [String]) {
        for identity in identities.sorted() {
            guard let peer = discovered[identity] else { continue }
            deliverSignal(from: identity, data: capsField(peer.capabilities))
        }
        var peers = [Peer(id: advertisement.identity, name: advertisement.name)]
        peers += discovered.values.sorted { $0.identity < $1.identity }
            .map { Peer(id: $0.identity, name: $0.name) }
        emit(Envelope(type: SignalType.peers, peers: peers))
    }

    private func deliverSignal(from identity: String, data: JSONValue) {
        emit(Envelope(type: SignalType.signal, from: identity, data: data))
    }

    private func emit(_ envelope: Envelope) {
        guard let data = try? JSONEncoder().encode(envelope),
              let json = String(data: data, encoding: .utf8) else { return }
        onText?(json)
    }

    private func emitDeparture(_ identity: String) {
        onText?(#"{"type":"left","peer":"\#(identity)"}"#)
    }

    private func identity(for record: Record) -> String? {
        connections.first { $0.value === record }?.key
    }

    private func contains(_ record: Record) -> Bool {
        pending.contains { $0 === record } || identity(for: record) != nil
    }

    private func drop(_ record: Record, emitDeparture: Bool) {
        pending.removeAll { $0 === record }
        let identity = identity(for: record)
        if let identity, connections[identity] === record { connections[identity] = nil }
        disownAndCancel(record)
        if emitDeparture, let identity, !closed { self.emitDeparture(identity) }
    }

    private func disownAndCancel(_ record: Record) {
        record.connection.onBytes = nil
        record.connection.onClosed = nil
        record.connection.cancel()
    }

    private func finish() {
        guard !closed else { return }
        closed = true
        openLock.lock()
        _isOpen = false
        openLock.unlock()
        cancelEverything()
        onClose?()
    }

    private func cancelEverything() {
        transport.stop()
        var seen: Set<ObjectIdentifier> = []
        for record in Array(connections.values) + pending {
            guard seen.insert(ObjectIdentifier(record)).inserted else { continue }
            disownAndCancel(record)
        }
        connections.removeAll()
        pending.removeAll()
        discovered.removeAll()
    }
}
