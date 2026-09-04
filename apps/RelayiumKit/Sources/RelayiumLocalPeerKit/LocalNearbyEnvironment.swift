import RelayiumAppKit
import RelayiumKit

/// The iOS-only composition seam. macOS continues to construct its existing
/// hub-backed `LanDiscoveryModel` through `AppEnvironment`.
public enum LocalNearbyEnvironment {
    /// What this build advertises on the local link, read from the SAME function
    /// that composes the roster hello and the SDP confirmation
    /// (`advertisedLinkCapabilities`). One source, so the TXT record cannot
    /// promise a wire the routing predicate would then refuse — the drift the
    /// shared announcer exists to prevent, one transport further out.
    ///
    /// The local link is the code-less room by construction: there is no pairing
    /// code on this path, so the room half of the predicate is constant here.
    public static var advertisedCapabilities: [String] {
        advertisedLinkCapabilities(linkRoomActive: linkRoomActive(isCodelessRoom: true))
    }

    @MainActor
    public static func makeDiscoveryModel(
        transport: @escaping () -> LocalPeerTransport = { NetworkLocalPeerTransport() }
    ) -> LanDiscoveryModel {
        LanDiscoveryModel(connect: {
            let advertisement = LocalPeerAdvertisement(
                identity: LocalPeerAdvertisement.mintIdentity(),
                name: AppEnvironment.deviceName(),
                capabilities: advertisedCapabilities)
            let channel = LocalPeerSignalingChannel(advertisement: advertisement,
                                                    transport: transport())
            // Built first, so `onOpen`/`onText`/`onClose` are installed before
            // `begin()` arms anything that could announce an edge into them.
            let client = SignalingClient(channel: channel, name: advertisement.name)
            channel.begin()
            return client
        })
    }
}
