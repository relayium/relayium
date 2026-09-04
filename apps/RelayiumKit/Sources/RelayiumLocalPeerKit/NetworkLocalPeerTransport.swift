import Foundation
import Network

/// Bonjour/TCP implementation. All listener, browser, delegate and lifecycle
/// state is confined to `queue`; no blocking hop is used during teardown.
public final class NetworkLocalPeerTransport: LocalPeerTransport {
    /// How long the listener/browser pair has to reach `ready` before the start
    /// is reported as failed. Long enough that a user reading and answering the
    /// system's Local Network alert is not raced, short enough that a refusal or
    /// a down link becomes a truthful `reconnecting` rather than an endless
    /// `connecting`. See `LocalPeerTransportLifecycle.startDeadlineElapsed`.
    public static let startDeadline: TimeInterval = 20

    private let queue: DispatchQueue
    private let startDeadline: TimeInterval
    private var lifecycle = LocalPeerTransportLifecycle()
    private var listener: NWListener?
    private var browser: NWBrowser?
    private weak var delegate: LocalPeerTransportDelegate?

    public init(queue: DispatchQueue = DispatchQueue(label: "com.relayium.localpeer.transport"),
                startDeadline: TimeInterval = NetworkLocalPeerTransport.startDeadline) {
        self.queue = queue
        self.startDeadline = startDeadline
    }

    public func start(advertising advertisement: LocalPeerAdvertisement,
                      delegate: LocalPeerTransportDelegate) {
        queue.async { self.beginStart(advertising: advertisement, delegate: delegate) }
    }

    private func beginStart(advertising advertisement: LocalPeerAdvertisement,
                            delegate: LocalPeerTransportDelegate) {
        guard lifecycle.start() == .arm else { return }
        self.delegate = delegate

        let parameters = Self.parameters()
        var txt = NWTXTRecord()
        for (key, value) in advertisement.txtRecord { txt[key] = value }

        do {
            let listener = try NWListener(using: parameters)
            listener.service = NWListener.Service(
                name: advertisement.serviceInstanceName,
                type: LOCAL_PEER_SERVICE_TYPE,
                domain: LOCAL_PEER_SERVICE_DOMAIN,
                txtRecord: txt)
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready: self?.listenerBecameReady()
                case .failed, .cancelled: self?.transportFailed()
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self, self.lifecycle.isDeliveringEvents else {
                    connection.cancel()
                    return
                }
                let stream = NetworkLocalPeerConnection(connection: connection, queue: self.queue)
                self.delegate?.localPeerTransport(didAccept: stream)
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            transportFailed()
            return
        }

        let browser = NWBrowser(
            for: .bonjourWithTXTRecord(type: LOCAL_PEER_SERVICE_TYPE,
                                       domain: LOCAL_PEER_SERVICE_DOMAIN),
            using: parameters)
        browser.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.browserBecameReady()
            case .failed, .cancelled: self?.transportFailed()
            default: break
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self, self.lifecycle.isDeliveringEvents else { return }
            self.delegate?.localPeerTransport(didDiscover: results.compactMap(Self.parse))
        }
        browser.start(queue: queue)
        self.browser = browser

        queue.asyncAfter(deadline: .now() + startDeadline) { [weak self] in
            self?.startDeadlineElapsed()
        }
    }

    public func connect(to peer: LocalPeerAdvertisement) -> LocalPeerConnection {
        let endpoint = NWEndpoint.service(name: peer.serviceInstanceName,
                                          type: LOCAL_PEER_SERVICE_TYPE,
                                          domain: LOCAL_PEER_SERVICE_DOMAIN,
                                          interface: nil)
        let stream = NetworkLocalPeerConnection(
            connection: NWConnection(to: endpoint, using: Self.parameters()), queue: queue)
        return stream
    }

    public func stop() {
        queue.async { self.performStop() }
    }

    private func performStop() {
        guard lifecycle.stop() == .tearDown else { return }
        delegate = nil
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.cancel()
        listener = nil
        browser?.stateUpdateHandler = nil
        browser?.browseResultsChangedHandler = nil
        browser?.cancel()
        browser = nil
    }

    private func listenerBecameReady() {
        guard lifecycle.listenerBecameReady() == .announce else { return }
        delegate?.localPeerTransportDidStart()
    }

    private func browserBecameReady() {
        guard lifecycle.browserBecameReady() == .announce else { return }
        delegate?.localPeerTransportDidStart()
    }

    private func transportFailed() {
        guard lifecycle.fail() == .announce else { return }
        announceFailureAndTearDown()
    }

    private func startDeadlineElapsed() {
        guard lifecycle.startDeadlineElapsed() == .announce else { return }
        announceFailureAndTearDown()
    }

    /// Announce first, then release the listener and browser.
    ///
    /// A failure this transport will not recover from must not leave the device
    /// still advertising `_relayium._tcp` while its own state says the room is
    /// gone. Waiting for the channel's `stop()` would make that window depend on
    /// a delegate being well behaved, and `delegate` is weak: an owner that went
    /// away leaves nobody to close what this object opened. `performStop` clears
    /// the delegate, so the announcement has to come first.
    private func announceFailureAndTearDown() {
        delegate?.localPeerTransportDidFail()
        performStop()
    }

    private static func parameters() -> NWParameters {
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        parameters.prohibitedInterfaceTypes = [.loopback]
        return parameters
    }

    static func parse(_ result: NWBrowser.Result) -> LocalPeerAdvertisement? {
        guard case let .service(name, type, domain, _) = result.endpoint,
              type == LOCAL_PEER_SERVICE_TYPE,
              domain == LOCAL_PEER_SERVICE_DOMAIN,
              case let .bonjour(record) = result.metadata else { return nil }
        var fields: [String: String] = [:]
        for (key, entry) in record {
            guard case let .string(value) = entry else { return nil }
            fields[key] = value
        }
        return LocalPeerAdvertisement.parse(instanceName: name, txtRecord: fields)
    }
}

private final class NetworkLocalPeerConnection: LocalPeerConnection {
    var onBytes: ((Data) -> Void)? {
        get { handlers.onBytes }
        set { handlers.onBytes = newValue }
    }
    var onClosed: (() -> Void)? {
        get { handlers.onClosed }
        set { handlers.installCloseHandler(newValue)?() }
    }

    private let handlers = LocalPeerStreamHandlerBox()
    private let connection: NWConnection
    private let queue: DispatchQueue

    init(connection: NWConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    func start() {
        guard handlers.start() == .start else { return }
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.fireClosed()
            default: break
            }
        }
        connection.start(queue: queue)
        receive()
    }

    func send(_ bytes: Data) {
        connection.send(content: bytes, completion: .contentProcessed { _ in })
    }

    func cancel() {
        guard handlers.cancel() == .cancel else { return }
        connection.cancel()
    }

    private func receive() {
        connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: LocalPeerFraming.maximumFrameBytes + LocalPeerFraming.headerBytes
        ) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.handlers.byteCallback()?(data) }
            guard !complete, error == nil else {
                self.fireClosed()
                return
            }
            self.receive()
        }
    }

    private func fireClosed() {
        handlers.takeCloseCallback()?()
    }
}
