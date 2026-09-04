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
        LanDiscoveryModel(prepare: {
            let advertisement = LocalPeerAdvertisement(
                identity: LocalPeerAdvertisement.mintIdentity(),
                name: AppEnvironment.deviceName(),
                capabilities: advertisedCapabilities)
            let channel = LocalPeerSignalingChannel(advertisement: advertisement,
                                                    transport: transport())
            // Nothing is armed here. `SignalingClient` installs the channel's
            // `onOpen`/`onText`/`onClose`, but the DISCOVERY MODEL's own
            // callbacks and capability listener go onto the client after this
            // closure returns — so `begin()` is handed back as the activation
            // and runs only once that installation is complete. A transport
            // that is ready synchronously (a peer already on the link) would
            // otherwise announce the roster into handlers not yet installed.
            let client = SignalingClient(channel: channel, name: advertisement.name)
            return PreparedNearbyConnection(client: client,
                                            activate: { channel.begin() })
        })
    }
}
