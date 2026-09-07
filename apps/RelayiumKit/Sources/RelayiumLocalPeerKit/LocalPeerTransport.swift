import Foundation

/// The intentionally small stream surface used by local signalling. Handlers
/// may be installed or cleared from a queue different from the one delivering
/// bytes, so implementations must synchronize those properties.
public protocol LocalPeerConnection: AnyObject {
    var onBytes: ((Data) -> Void)? { get set }
    var onClosed: (() -> Void)? { get set }
    func start()
    func send(_ bytes: Data)
    func cancel()
}

public protocol LocalPeerTransportDelegate: AnyObject {
    func localPeerTransportDidStart()
    func localPeerTransportDidFail()
    func localPeerTransport(didDiscover peers: [LocalPeerAdvertisement])
    func localPeerTransport(didAccept connection: LocalPeerConnection)
}

/// Browsing only reports advertisements. `connect` is the sole dial path and
/// is called only for an explicitly addressed peer.
public protocol LocalPeerTransport: AnyObject {
    func start(advertising advertisement: LocalPeerAdvertisement,
               delegate: LocalPeerTransportDelegate)
    func connect(to peer: LocalPeerAdvertisement) -> LocalPeerConnection
    func stop()
}
