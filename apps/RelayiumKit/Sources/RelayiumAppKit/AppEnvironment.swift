import Foundation
import RelayiumKit
import RelayiumShareKit

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

    /// A keychain identity that shares nothing with the installed product.
    ///
    /// UI acceptance runs against a build that resolves the same keychain item
    /// as the shipped app, so on a workstation with Relayium installed the suite
    /// launched signed in and its signed-out assertions failed — while the same
    /// assertions passed on a runner that happened to have no account. Both
    /// results measured the machine rather than the product.
    ///
    /// The service is suffixed rather than replaced, so the item is still
    /// recognisably this app's when someone finds it in Keychain Access. The
    /// access group is dropped: a group is a SHARE, and a test identity that
    /// joined it would be reachable from the extensions the product ships.
    public static func isolatedKeychainConfiguration(
        _ base: KeychainConfiguration = keychainConfiguration
    ) -> KeychainConfiguration {
        KeychainConfiguration(service: base.service + ".uitest", // nonlocalized: a keychain service id
                              account: base.account,
                              accessGroup: nil)
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
    /// answer comes from the local hardware identifier instead.
    ///
    /// **iOS must never ask for a host name here, and this function used to.**
    /// `ProcessInfo.processInfo.hostName` on iOS goes through `NSHost`'s
    /// *blocking* resolver, and this is called from `makeSession()`, which
    /// `RelayiumApp.init()` calls — so on a device whose network could not
    /// answer, app launch sat in `blockingResolveUntil:` on the main thread
    /// until the launch watchdog killed the process (`0x8BADF00D`, 20s). It is
    /// also the wrong *answer*: a resolver name is not something the user chose.
    ///
    /// Nothing below can block, resolve, or touch the network — and nothing
    /// below needs the main actor, which matters because the realtime factories
    /// call this from their own connection closures.
    public static func deviceName() -> String {
        #if os(macOS)
        // Local, from the dynamic store: the name in Sharing preferences, which
        // IS the one the person chose. Unlike `Host.current().name`, it does not
        // resolve anything.
        let name = Host.current().localizedName ?? ""
        return name.isEmpty ? "Mac" : name
        #else
        return deviceFamilyName(forModelIdentifier: hardwareModelIdentifier())
        #endif
    }

    /// `iPad7,11` → `iPad`. The device family, from the hardware identifier.
    ///
    /// Not `UIDevice.current.name`: that is `@MainActor` in the iOS SDK, and the
    /// callers above are not — and since iOS 16 it returns the device *model*
    /// to an unentitled app anyway, which is what this computes without needing
    /// the main thread or UIKit at all.
    ///
    /// Compiled on every platform, and deliberately: it is the whole of the iOS
    /// decision, and a `#if os(iOS)` body is a body the package's own test suite
    /// (which runs on macOS) can never drive.
    static func deviceFamilyName(forModelIdentifier model: String) -> String {
        // The three families an iOS identifier can name. No one of them is a
        // prefix of another, so this reads the same in any order.
        for family in ["iPhone", "iPad", "iPod"] where model.hasPrefix(family) {
            // `iPod` is the identifier; `iPod touch` is what the device is
            // called, and this string is read by a person in their device list.
            return family == "iPod" ? "iPod touch" : family // nonlocalized: an Apple product name
        }
        // A model this build has never heard of — including the Simulator's own
        // `arm64`, when it reports no simulated model. Never empty: the web
        // device list renders this, and a blank row names no device at all.
        return "iPhone"
    }

    /// `hw.machine`, or the model the Simulator says it is simulating.
    ///
    /// A `sysctl` read of this process's own hardware: no network, no resolver,
    /// no daemon round-trip.
    private static func hardwareModelIdentifier() -> String {
        // Under the Simulator `hw.machine` is the Mac's architecture, so the
        // device being simulated comes from the environment it sets instead.
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"],
           !simulated.isEmpty {
            return simulated
        }
        var size = 0
        guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var value = [UInt8](repeating: 0, count: size)
        guard sysctlbyname("hw.machine", &value, &size, nil, 0) == 0 else { return "" }
        return String(decoding: value.prefix { $0 != 0 }, as: UTF8.self)
    }

    /// `tokenStore` is nil for every shipped launch, which resolves the product's
    /// own keychain identity. It exists so a Debug acceptance launch can hand in
    /// an isolated one rather than reading whatever account the machine is in.
    @MainActor
    public static func makeSession(baseURL: URL = productionBaseURL,
                                   tokenStore: TokenStore? = nil,
                                   transport: URLSession? = nil) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: baseURL, session: transport ?? .shared),
            tokenStore: tokenStore ?? makeTokenStore(),
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

    // MARK: - Device Inbox
    //
    // Four production stores and one transport, built here rather than in the
    // scene, for the reason the whole file exists: the acceptance suite has to be
    // able to point every one of them somewhere else, and a `#if DEBUG` in a view
    // would leave the shipped app depending on a branch nobody runs.

    /// This account's X25519 private-key history.
    ///
    /// The SAME service and access group as every other credential this app
    /// keeps; what separates it is `KeychainInboxDeviceKeyStore.accountPrefix`,
    /// so a device key and a stored-object key can never name each other's item.
    /// Data-protection accessibility and account scoping are decisions of that
    /// type, asserted in `InboxKeyStoreTests`.
    public static func makeInboxKeyStore(
        _ configuration: KeychainConfiguration = keychainConfiguration
    ) -> KeychainInboxDeviceKeyStore {
        KeychainInboxDeviceKeyStore(service: configuration.service,
                                    accessGroup: configuration.accessGroup)
    }

    /// The receive-folder bookmark and the off/ask/auto policy.
    ///
    /// `UserDefaults` and nothing else. Note what is deliberately NOT stored
    /// here: no bearer, no claim token, no content or private key, no plaintext
    /// manifest and no file name. A security-scoped bookmark is an authorization
    /// the user granted this app, and the policy is their own answer; both are
    /// account-scoped inside the store.
    public static func makeInboxFolderStore(
        defaults: UserDefaults = .standard
    ) -> UserDefaultsInboxFolderStore {
        UserDefaultsInboxFolderStore(defaults: defaults)
    }

    /// Where per-task delivery journals live.
    ///
    /// Application Support, deliberately: a journal is what makes a crashed
    /// delivery recoverable and what stops a task being delivered twice, so it
    /// must not sit anywhere the system may purge. `IOSSurfaceGuardTests` refuses
    /// `temporaryDirectory`, `cachesDirectory` and `downloadsDirectory` across
    /// these sources for the same reason.
    ///
    /// Returns `nil` when Application Support cannot be created at all, which is
    /// a broken container rather than a condition to work around — the caller
    /// fails closed rather than journalling somewhere temporary.
    public static func makeInboxJournalStore(subdirectory: String = "device-inbox")
        -> InboxJournalStore? {
        guard let support = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true) else { return nil }
        let directory = support.appendingPathComponent(subdirectory, isDirectory: true)
        return InboxJournalStore(directory: directory)
    }

    /// Journals are account-scoped even though central task ids are random.
    /// Relying on global uniqueness would still let account B inspect or replay
    /// account A's durable local receipt if a server defect or restored database
    /// ever reused an id. `InboxAccountID` is already path-safe by construction.
    static func inboxJournalSubdirectory(base: String, account: InboxAccountID) -> String {
        base + "/accounts/" + account.value
    }

    /// The id the ONE bootstrap call is made under.
    ///
    /// `InboxClient.currentDevice` deliberately does not use the client's device
    /// id — it asks which row the CREDENTIAL authenticates as — but the client
    /// still checks its id at construction, because every other call composes it
    /// into a URL path. So the bootstrap client is built with a path-safe
    /// placeholder and thrown away: the real row id is what the working client is
    /// built with, and there is no window in which a device-scoped request could
    /// go out under this value.
    // nonlocalized: a path-safe placeholder identifier, never displayed
    static let inboxBootstrapDeviceID = "bootstrap"

    /// The device half of `inbox/1`, bound to one credential and one device row.
    public static func makeInboxTransport(baseURL: URL = productionBaseURL,
                                          deviceID: String, token: String,
                                          session: URLSession = .shared) throws
        -> InboxClient {
        try InboxClient(baseURL: baseURL, deviceID: deviceID, token: token, session: session)
    }

    /// The engine factory the controller drives.
    ///
    /// The device id is ASKED FOR rather than assumed: it is minted server-side
    /// when a login is approved, so the only honest way to learn it is to ask
    /// which row this credential authenticates as. That is also why the factory
    /// is `async` — and why a credential that no longer maps to a row surfaces as
    /// `InboxError.noCurrentDevice` here, at generation start, instead of as a
    /// mysterious claim failure later.
    public static func makeInboxEngineFactory(
        baseURL: URL = productionBaseURL,
        keys: InboxDeviceKeyStoring,
        journalStore: @escaping @Sendable (InboxAccountID) -> InboxJournalStore?,
        folderStore: InboxFolderStoring,
        session: URLSession = .shared
    ) -> @Sendable (InboxAccountID, String) async throws -> InboxReceiveEngine {
        let folder = InboxReceiveFolder(store: folderStore)
        return { account, bearer in
            guard let journals = journalStore(account) else {
                throw InboxSupportError.noJournalDirectory
            }
            // Resolved with the bearer it was handed and never retained: the
            // client owns the credential for the life of the generation, and
            // nothing above it keeps a second copy.
            let discovery = try InboxClient(baseURL: baseURL, deviceID: inboxBootstrapDeviceID,
                                            token: bearer, session: session)
            let row = try await discovery.currentDevice()
            let client = try InboxClient(baseURL: baseURL, deviceID: row.id,
                                         token: bearer, session: session)
            return InboxReceiveEngine(transport: client, keys: keys, journals: journals,
                                      folder: folder, account: account)
        }
    }

    /// What this build calls itself when it enrols.
    ///
    /// `macos`, not `darwin`: the CLI receiver on the same Mac already reports
    /// `runtime.GOOS`, and a person looking at their device list needs to be able
    /// to tell the two apart. Central bounds this to printable ASCII and does not
    /// interpret it, so it is a label rather than a protocol value.
    // nonlocalized: a protocol platform token, never displayed as prose
    public static let inboxPlatform = "macos"

    /// Assemble the whole resident receiver.
    ///
    /// One factory rather than five call sites in the scene, so an acceptance
    /// launch substitutes ONE thing and cannot half-wire it — the failure
    /// `WORKFLOW-LEARNINGS` records from the signed-in fixture that replaced the
    /// session's transport and left the account model talking to production.
    ///
    /// A missing journal directory produces a controller that fails closed rather
    /// than one that receives without a journal: the journal is what makes a
    /// crashed delivery recoverable and what stops one being delivered twice, so
    /// receiving without it would trade a visible failure for a silent one.
    @MainActor
    public static func makeInboxController(
        baseURL: URL = productionBaseURL,
        keychain: KeychainConfiguration = keychainConfiguration,
        defaults: UserDefaults = .standard,
        journalSubdirectory: String = "device-inbox",
        notifier: InboxNotifying? = nil,
        reveal: @escaping @Sendable ([URL]) -> Void = { _ in },
        // Defaulted so no existing caller changes, and defaulted to the HONEST
        // answers rather than the convenient ones: a build that forgets to wire
        // these leaves the permission `unmeasured`, which renders nothing, and
        // makes the recovery button report that it could not open System
        // Settings. Neither default can produce a false claim.
        refreshNotificationPermission: @escaping @Sendable () -> Void = {},
        openNotificationSettings: @escaping @Sendable () -> Bool = { false },
        appVersion: String,
        session: URLSession = .shared
    ) -> InboxController {
        let folderStore = makeInboxFolderStore(defaults: defaults)
        let folder = InboxReceiveFolder(store: folderStore)
        let keys = makeInboxKeyStore(keychain)
        let makeEngine = makeInboxEngineFactory(
            baseURL: baseURL, keys: keys,
            journalStore: { account in
                makeInboxJournalStore(subdirectory: inboxJournalSubdirectory(
                    base: journalSubdirectory, account: account))
            },
            folderStore: folderStore, session: session)
        return InboxController(runtime: InboxRuntime(
            folder: folder, makeEngine: makeEngine, notifier: notifier,
            reveal: reveal,
            refreshNotificationPermission: refreshNotificationPermission,
            openNotificationSettings: openNotificationSettings,
            platform: inboxPlatform, appVersion: appVersion))
    }

    /// A local precondition the Device Inbox cannot run without.
    public enum InboxSupportError: Error, Equatable, Sendable {
        /// Application Support could not be created, so there is nowhere durable
        /// to journal a delivery.
        case noJournalDirectory
    }

    /// Durable recovery for stored uploads.
    ///
    /// iOS only, and deliberately: the process there is suspended and killed by
    /// the system while a send is in flight, which is the whole reason a staged
    /// copy exists. macOS keeps the original single-process path rather than
    /// gaining a recovery surface nobody there has asked for and nothing there
    /// has tested.
    /// `drafts` has no default on purpose. The upload model and the send model
    /// must share ONE `SharedDraftStore`, and a defaulted argument here is
    /// exactly how they would silently end up with two — which would still work
    /// (both address the same directory) right up until one gained an injected
    /// root and the other did not.
    /// `root` exists so acceptance can stage into a directory of its own. The
    /// staged job survives a launch by design — that is what makes a cancelled
    /// upload resumable — which also means it survives from one acceptance run
    /// into the next unless the runs are given separate roots.
    public static func makePendingUploadSupport(drafts: SharedDraftStore?,
                                                root: URL? = nil) -> PendingUploadSupport {
        PendingUploadSupport(store: PendingUploadStore(root: root ?? PendingUploadStore.defaultRoot()),
                             keys: makePendingUploadKeyStore(),
                             drafts: drafts)
    }

    /// The App Group inbox the iOS share extension writes into, or nil.
    ///
    /// Nil in exactly two situations, and neither is a bug this should paper
    /// over: on macOS, where there is no share extension at all, and in an iOS
    /// build whose provisioning does not carry
    /// `com.apple.security.application-groups`. `AppGroup.containerURL` fails
    /// closed rather than substituting a directory the app could write and the
    /// extension could not read, so the surface simply never appears and every
    /// other way of sending goes on working.
    public static func makeSharedDraftStore() -> SharedDraftStore? {
        try? SharedDraftStore.shared()
    }

    @MainActor
    /// `transport` exists for the same reason as `makeSession`'s: a stored send's
    /// completion surface cannot be reached without a server saying yes, and
    /// acceptance must reach it without one. A shipped launch passes nil.
    public static func makeUploadModel(baseURL: URL = productionBaseURL,
                                       keyStore: StoredLinkKeyStore,
                                       pending: PendingUploadSupport? = nil,
                                       transport: URLSession? = nil) -> CloudUploadModel {
        CloudUploadModel(
            uploader: CloudUploader(transport: HTTPResumableTransport(
                baseURL: baseURL, session: transport ?? .shared)),
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
                                              upload: CloudUploadModel,
                                              drafts: SharedDraftStore? = nil) -> SendSelectionModel {
        let client = CloudClient(baseURL: baseURL)
        return SendSelectionModel(upload: upload,
                                  drafts: drafts,
                                  fetchConfig: { try await client.fetchConfig() })
    }

    /// `transport` exists for the same reason as `makeSession`'s: this model
    /// reads the account's devices and stored objects, and acceptance needs
    /// those answered without a server. A shipped launch passes nil.
    @MainActor
    public static func makeAccountManagementModel(baseURL: URL = productionBaseURL,
                                                  keyStore: StoredLinkKeyStore,
                                                  transport: URLSession? = nil) -> AccountManagementModel {
        AccountManagementModel(
            service: AccountClient(baseURL: baseURL, session: transport ?? .shared),
            keyStore: keyStore,
            // Same origin rule as the upload model's: a rebuilt link has to point
            // at the deployment the object actually lives on.
            origin: baseURL.absoluteString
        )
    }

    @MainActor
    /// `transport` exists for the same reason as the other factories': a stored
    /// receive cannot reach a result without a server, and acceptance must reach
    /// one without one. A shipped launch passes nil.
    public static func makeDownloadModel(baseURL: URL = productionBaseURL,
                                         transport: URLSession? = nil) -> CloudDownloadModel {
        #if os(iOS)
        // Here rather than at the iOS call site so no future iOS surface can
        // construct a download model that tells the user to choose a folder it
        // never offers. `ReceiveDestinationCopy` re-words the five destination
        // errors whose shared wording assumes a folder picker — the two
        // collisions, an unsafe name, and the two write failures that are not
        // ENOSPC — and defers to `ErrorCopy` for everything else, including the
        // destination errors whose advice really is platform-neutral. See its
        // comment for the case-by-case list.
        CloudDownloadModel(client: CloudClient(baseURL: baseURL,
                                               session: transport ?? .shared),
                           errorCopy: { ReceiveDestinationCopy.message(for: $0) })
        #else
        CloudDownloadModel(client: CloudClient(baseURL: baseURL,
                                               session: transport ?? .shared))
        #endif
    }
}
