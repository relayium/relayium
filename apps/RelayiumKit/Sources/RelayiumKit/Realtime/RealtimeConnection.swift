import Foundation
import WebRTC

/// True once the WebRTC framework is linked and a peer-connection factory can be
/// constructed. A link-time smoke check; the real connection logic is added below.
public func webrtcAvailable() -> Bool {
    RTCInitializeSSL()
    let factory = RTCPeerConnectionFactory()
    let ok = String(describing: type(of: factory)) == "RTCPeerConnectionFactory"
    RTCCleanupSSL()
    return ok
}
