import Foundation
import RelayiumKit

/// Wiring: the few constants and factory calls the SwiftUI layer would otherwise
/// hard-code, kept here so tests and the iOS app in R3 can point elsewhere.
public enum AppEnvironment {
    public static let productionBaseURL = URL(string: "https://relayium.com")!
    public static let keychainService = "com.relayium.mac"
    public static let keychainAccount = "bearer-token"
    public static let keychainAccessGroup = "7PVYUG4YQS.com.relayium.shared"

    /// The iOS credential identity: this app's own bundle id, and NO access
    /// group. See `KeychainConfiguration.accessGroup`.
    public static let iosKeychainService = "com.relayium.app"

    public static func keychainConfiguration(for platform: KeychainPlatform) -> KeychainConfiguration {
        switch platform {
        case .macOS:
            return KeychainConfiguration(service: keychainService,
                                         account: keychainAccount,
                                         accessGroup: keychainAccessGroup)
        case .iOS:
            return KeychainConfiguration(service: iosKeychainService,
                                         account: keychainAccount,
                                         accessGroup: nil)
        }
    }

    /// The one compile-time conditional in the keychain policy.
    public static var currentKeychainPlatform: KeychainPlatform {
        #if os(iOS)
        return .iOS
        #else
        return .macOS
        #endif
    }

    public static var keychainConfiguration: KeychainConfiguration {
        keychainConfiguration(for: currentKeychainPlatform)
    }

    /// Built through the configuration so a test can assert the keychain query
    /// for a platform it is not running on.
    public static func makeTokenStore(
        _ configuration: KeychainConfiguration = keychainConfiguration
    ) -> KeychainTokenStore {
        KeychainTokenStore(service: configuration.service,
                           account: configuration.account,
                           accessGroup: configuration.accessGroup)
    }

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
            tokenStore: makeTokenStore(),
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

    // MARK: - realtime, for a client with no nearby half
    //
    // Separate factories rather than nil defaults on the two below, and the
    // difference is a claim about capability.
    //
    // The nearby factories need a `LanDiscoveryModel` and an `InboundRoom`
    // because both same-network paths reach through the one room socket that
    // model owns. A client that constructed those two objects to satisfy a
    // signature, without a surface that reads the roster or a listener that
    // answers, would open a socket nothing reads.
    //
    // What these produce is a model whose nearby entry points refuse — the
    // initializers' own `NearbyError.notScanning` defaults, reached because
    // nothing overrides them. Making that a defaulted argument on the existing
    // signature would have been the same code with a worse failure mode: a call
    // site that dropped its discovery model would silently lose the whole
    // nearby feature and still compile.
    //
    // **These are not a permission boundary, and R3-E's comment here wrongly
    // implied they were.** `LanDiscoveryModel` is not Bonjour and does not scan:
    // it joins the hub's code-less room over the same origin as everything else,
    // and the server groups that room by the public IP it observes. Nearby
    // therefore needs ordinary internet access on every platform — no
    // local-network prompt and no multicast entitlement — which is why iOS could
    // take it in R3-F without acquiring a capability. What these code-only
    // factories express is the absence of a FEATURE, not of a permission.

    @MainActor
    public static func makeRealtimeModel(baseURL: URL = productionBaseURL,
                                         verification: VerificationPreference) -> RealtimeSessionModel {
        RealtimeSessionModel(
            pairClient: HTTPPairClient(baseURL: baseURL),
            iceClient: HTTPICEClient(baseURL: baseURL),
            // Read per session rather than captured, for the reason the nearby
            // factory records: flipping the preference must take effect on the
            // next connection, not the next launch.
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { code, role, servers in
                try await RealtimeConnectionFactory.make(
                    code: code, role: role, config: servers,
                    baseURL: baseURL, deviceName: deviceName())
            })
    }

    @MainActor
    public static func makeRealtimeTextModel(baseURL: URL = productionBaseURL,
                                             verification: VerificationPreference) -> RealtimeTextSessionModel {
        RealtimeTextSessionModel(
            pairClient: HTTPPairClient(baseURL: baseURL),
            iceClient: HTTPICEClient(baseURL: baseURL),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { code, role, servers in
                try await RealtimeConnectionFactory.make(
                    code: code, role: role, config: servers,
                    baseURL: baseURL, deviceName: deviceName(), mode: .text)
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
    ///
    /// Takes a configuration for the same reason `makeTokenStore` does: both
    /// platforms' Security dictionaries have to be assertable from one host.
    /// The default is this platform's, so the app's call site does not change.
    public static func makeStoredLinkKeyStore(
        _ configuration: KeychainConfiguration = keychainConfiguration
    ) -> KeychainStoredLinkKeyStore {
        KeychainStoredLinkKeyStore(service: configuration.service,
                                   accessGroup: configuration.accessGroup)
    }

    /// The keychain store for the content key of an upload that has not
    /// finished yet, in its own namespace beside the stored-link keys.
    ///
    /// Same service and access group as every other credential this app keeps —
    /// what differs is the account prefix, so a pending job and a finished
    /// object can never name each other's item.
    public static func makePendingUploadKeyStore(
        _ configuration: KeychainConfiguration = keychainConfiguration
    ) -> KeychainStoredLinkKeyStore {
        KeychainStoredLinkKeyStore(service: configuration.service,
                                   accessGroup: configuration.accessGroup,
                                   accountPrefix: KeychainStoredLinkKeyStore.pendingUploadPrefix)
    }

    /// Durable recovery for stored uploads.
    ///
    /// iOS only, and deliberately: the process there is suspended and killed by
    /// the system while a send is in flight, which is the whole reason a staged
    /// copy exists. macOS keeps the original single-process path rather than
    /// gaining a recovery surface nobody there has asked for and nothing there
    /// has tested.
    public static func makePendingUploadSupport() -> PendingUploadSupport {
        PendingUploadSupport(store: PendingUploadStore(root: PendingUploadStore.defaultRoot()),
                             keys: makePendingUploadKeyStore())
    }

    @MainActor
    public static func makeUploadModel(baseURL: URL = productionBaseURL,
                                       keyStore: StoredLinkKeyStore,
                                       pending: PendingUploadSupport? = nil) -> CloudUploadModel {
        CloudUploadModel(
            uploader: CloudUploader(transport: HTTPResumableTransport(baseURL: baseURL)),
            keyStore: keyStore,
            // The origin the link is built from, so a self-hosted build produces
            // links pointing at its own deployment rather than relayium.com.
            origin: baseURL.absoluteString,
            pending: pending
        )
    }

    /// The send flow's app-scoped owner: selection, security scopes, photo
    /// staging, account isolation and the advisory size hint.
    ///
    /// The per-file size hint comes from the PUBLIC `GET /api/config` that
    /// `CloudClient.fetchConfig()` has always spoken and nothing had called yet.
    /// It is injected as a closure rather than taken as a client so the staleness
    /// tests can gate the response and land it at a chosen moment — the case that
    /// matters is a response arriving after the account that asked for it is
    /// gone, and that cannot be staged against a real `URLSession`.
    @MainActor
    public static func makeSendSelectionModel(baseURL: URL = productionBaseURL,
                                              upload: CloudUploadModel) -> SendSelectionModel {
        let client = CloudClient(baseURL: baseURL)
        return SendSelectionModel(upload: upload,
                                  fetchConfig: { try await client.fetchConfig() })
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
        #if os(iOS)
        // Here rather than at the iOS call site so no future iOS surface can
        // construct a download model that tells the user to choose a folder it
        // never offers. `ReceiveDestinationCopy` re-words the five destination
        // errors whose shared wording assumes a folder picker — the two
        // collisions, an unsafe name, and the two write failures that are not
        // ENOSPC — and defers to `ErrorCopy` for everything else, including the
        // destination errors whose advice really is platform-neutral. See its
        // comment for the case-by-case list.
        CloudDownloadModel(client: CloudClient(baseURL: baseURL),
                           errorCopy: { ReceiveDestinationCopy.message(for: $0) })
        #else
        CloudDownloadModel(client: CloudClient(baseURL: baseURL))
        #endif
    }
}
