import Foundation
import RelayiumKit

/// Wiring: the few constants and factory calls the SwiftUI layer would otherwise
/// hard-code, kept here so tests and the iOS app in R3 can point elsewhere.
public enum AppEnvironment {
    public static let productionBaseURL = URL(string: "https://relayium.com")!
    public static let keychainService = "com.relayium.mac"
    public static let keychainAccount = "bearer-token"
    public static let keychainAccessGroup = "7PVYUG4YQS.com.relayium.shared"

    // MARK: - Web hand-off
    //
    // The native app renders account state read-only and sends the user to the web
    // for anything that writes — billing above all, which stays on the web because
    // the Mac app ships as a direct download. These live here rather than in a view
    // so G2/G4 (and R3's iOS app) hand off to the same places, and so the URL
    // construction — the reactivate token in particular — is unit-testable.
    // Paths mirror `web/src/lib/router.svelte.ts`.

    /// Personal center: plan, devices, stored files. `ME_PATH` on the web.
    public static var accountWebURL: URL { productionBaseURL.appendingPathComponent("me") }

    /// Plans page — where an upgrade/downgrade is actually performed.
    /// `PRICING_PATH` on the web.
    public static var plansWebURL: URL { productionBaseURL.appendingPathComponent("pricing") }

    /// One-click reactivation for a pending-deletion account.
    ///
    /// The token rides in the URL *fragment*, never the query: that keeps it out of
    /// server access logs and out of any `Referer`. `Account.svelte` (mounted
    /// globally in `Nav.svelte`) reads `account=pending_deletion` + `token` from the
    /// fragment on mount, scrubs it from history, and posts it to
    /// `/api/account/reactivate` — which needs no session, which is the whole point:
    /// a frozen account cannot log in. Dropping the token turns one click into a
    /// support ticket, so this is the one hand-off URL that carries data.
    public static func reactivateWebURL(token: String) -> URL {
        var components = URLComponents(url: accountWebURL, resolvingAgainstBaseURL: false)!
        // Matches the web's `encodeURIComponent`: escape everything outside the
        // URI unreserved set, so a token containing `&` or `#` cannot forge
        // another fragment parameter.
        let encoded = token.addingPercentEncoding(
            withAllowedCharacters: CharacterSet(charactersIn:
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        ) ?? token
        components.percentEncodedFragment = "account=pending_deletion&token=\(encoded)"
        return components.url!
    }

    /// The user-visible computer name, so the web device list reads the way the
    /// person expects rather than showing a hostname they never chose.
    ///
    /// `Host` is a macOS API; this target also builds for iOS 16 (R3), where the
    /// device's own name is the right answer.
    public static func deviceName() -> String {
        #if os(macOS)
        let name = Host.current().localizedName ?? ""
        return name.isEmpty ? "Mac" : name
        #else
        let name = ProcessInfo.processInfo.hostName
        return name.isEmpty ? "iPhone" : name
        #endif
    }

    @MainActor
    public static func makeSession(baseURL: URL = productionBaseURL) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: baseURL),
            tokenStore: KeychainTokenStore(service: keychainService,
                                           account: keychainAccount,
                                           accessGroup: keychainAccessGroup),
            deviceName: deviceName()
        )
    }

    /// The same-network room: the hub's code-less room, which it keys by the
    /// public IP it observes. No code is minted and none is sent — the empty
    /// `code` IS the mechanism (`SignalingClient.connect` omits the query item).
    @MainActor
    public static func makeLanDiscoveryModel(baseURL: URL = productionBaseURL) -> LanDiscoveryModel {
        LanDiscoveryModel(connect: {
            SignalingClient.connect(wsBase: RealtimeConnectionFactory.signalingBase(baseURL),
                                    code: "",
                                    name: deviceName())
        })
    }

    @MainActor
    public static func makeRealtimeModel(baseURL: URL = productionBaseURL,
                                        verification: VerificationPreference,
                                        nearby: LanDiscoveryModel,
                                        inboundRoom: InboundRoom) -> RealtimeSessionModel {
        RealtimeSessionModel(
            pairClient: HTTPPairClient(baseURL: baseURL),
            iceClient: HTTPICEClient(baseURL: baseURL),
            // Read per session rather than captured as a value: flipping the
            // preference must take effect on the next connection, not the next
            // app launch.
            requiresVerification: { verification.requiresSASConfirmation },
            // Reuses the socket the roster came from: reconnecting would earn a
            // new peer id and a room the user never saw. Read at call time, so
            // a device picked before discovery stopped fails cleanly instead of
            // dialling through a dead socket.
            makeNearbyConnection: { peerId, role, servers in
                guard let signaling = nearby.client else { throw NearbyError.notScanning }
                return try await RealtimeConnectionFactory.connectNearby(
                    signaling: signaling, peerId: peerId, role: role, config: servers)
            },
            // Inbound: the peer id came from an offer, and `InboundRoom` holds
            // the exact socket it arrived on — never "the current room", which
            // is a different socket, with different peer ids, the moment a drop
            // and a reconnect land inside the setup window. Same STUN-only
            // rules, no code, no mint.
            makeInboundConnection: { peerId, servers in
                guard let signaling = inboundRoom.signaling else { throw NearbyError.notScanning }
                return try RealtimeConnectionFactory.acceptNearby(
                    signaling: signaling, peerId: peerId, config: servers)
            },
            makeConnection: { code, role, servers in
                try await RealtimeConnectionFactory.make(
                    code: code, role: role, config: servers,
                    baseURL: baseURL, deviceName: deviceName())
            })
    }

    @MainActor
    public static func makeRealtimeTextModel(baseURL: URL = productionBaseURL,
                                            verification: VerificationPreference,
                                            nearby: LanDiscoveryModel,
                                            inboundRoom: InboundRoom) -> RealtimeTextSessionModel {
        RealtimeTextSessionModel(
            pairClient: HTTPPairClient(baseURL: baseURL),
            iceClient: HTTPICEClient(baseURL: baseURL),
            requiresVerification: { verification.requiresSASConfirmation },
            makeNearbyConnection: { peerId, role, servers in
                guard let signaling = nearby.client else { throw NearbyError.notScanning }
                return try await RealtimeConnectionFactory.connectNearby(
                    signaling: signaling, peerId: peerId, role: role, config: servers,
                    mode: .text)
            },
            makeInboundConnection: { peerId, servers in
                guard let signaling = inboundRoom.signaling else { throw NearbyError.notScanning }
                return try RealtimeConnectionFactory.acceptNearby(
                    signaling: signaling, peerId: peerId, config: servers, mode: .text)
            },
            makeConnection: { code, role, servers in
                try await RealtimeConnectionFactory.make(
                    code: code,
                    role: role,
                    config: servers,
                    baseURL: baseURL,
                    deviceName: deviceName(),
                    mode: .text
                )
            }
        )
    }

    /// Background receive, wired to the one room socket the discovery model
    /// owns. Registering itself as the observer is what makes the listener
    /// survive a reconnect: every new socket needs a new subscription.
    @MainActor
    public static func makeNearbyReceiveModel(fileModel: RealtimeSessionModel,
                                              textModel: RealtimeTextSessionModel,
                                              discovery: LanDiscoveryModel,
                                              inboundRoom: InboundRoom) -> NearbyReceiveModel {
        let receive = NearbyReceiveModel(fileModel: fileModel, textModel: textModel,
                                         room: inboundRoom)
        discovery.observer = receive
        receive.observe(discovery)
        receive.roomStateChanged(discovery.state)
        return receive
    }

    @MainActor
    public static func makeBrowserLoginModel(baseURL: URL = productionBaseURL) -> BrowserLoginModel {
        BrowserLoginModel(client: HTTPDeviceAuthClient(baseURL: baseURL))
    }

    /// The keys of stored uploads made from this installation.
    ///
    /// Built once by the app and handed to BOTH the upload model (which writes
    /// them) and the account management model (which reads them and removes them
    /// with the object they belong to). Two stores would mean an upload whose
    /// link the Account tab cannot rebuild, which is exactly the failure this
    /// capability exists to remove.
    public static func makeStoredLinkKeyStore() -> StoredLinkKeyStore {
        KeychainStoredLinkKeyStore(service: keychainService, accessGroup: keychainAccessGroup)
    }

    @MainActor
    public static func makeUploadModel(baseURL: URL = productionBaseURL,
                                       keyStore: StoredLinkKeyStore) -> CloudUploadModel {
        CloudUploadModel(
            uploader: CloudUploader(transport: HTTPResumableTransport(baseURL: baseURL)),
            keyStore: keyStore,
            // The origin the link is built from, so a self-hosted build produces
            // links pointing at its own deployment rather than relayium.com.
            origin: baseURL.absoluteString
        )
    }

    @MainActor
    public static func makeAccountManagementModel(baseURL: URL = productionBaseURL,
                                                  keyStore: StoredLinkKeyStore) -> AccountManagementModel {
        AccountManagementModel(
            service: AccountClient(baseURL: baseURL),
            keyStore: keyStore,
            // Same origin rule as the upload model's: a rebuilt link has to point
            // at the deployment the object actually lives on.
            origin: baseURL.absoluteString
        )
    }

    @MainActor
    public static func makeDownloadModel(baseURL: URL = productionBaseURL) -> CloudDownloadModel {
        CloudDownloadModel(client: CloudClient(baseURL: baseURL))
    }
}
