import Foundation
import WebRTC

extension WebRTCLinkReplacementTransport: LinkReplacementTransport {}

extension WebRTCLinkTransport: LinkTransportHandle {}

public func webRTCLinkReplacementFactory(
    signaling: SignalingClient,
    iceServers: [RTCIceServer],
    iceTransportPolicy: RTCIceTransportPolicy = .all,
    deadlines: LinkDeadlines = LinkDeadlines()
) -> LinkReplacementFactory {
    { held in
        WebRTCLinkReplacementTransport(signaling: signaling,
                                       identity: held,
                                       iceServers: iceServers,
                                       iceTransportPolicy: iceTransportPolicy,
                                       deadlines: deadlines)
    }
}
