import XCTest
import Security
@testable import RelayiumAppKit
// `baseQuery` and `query(for:)` are internal seams in RelayiumKit, kept internal
// precisely so a host with no keychain entitlement can still assert the
// dictionary the Security framework would receive.
@testable import RelayiumKit

final class AppEnvironmentTests: XCTestCase {
    func testProductionBaseURLIsTheServiceOrigin() {
        XCTAssertEqual(AppEnvironment.productionBaseURL.absoluteString, "https://relayium.com")
    }
    // Never empty: it becomes the device name in the user's device list on the web.
    func testDeviceNameIsNeverEmpty() {
        XCTAssertFalse(AppEnvironment.deviceName().isEmpty)
    }

    // MARK: - the iOS device name, which used to kill the app at launch

    /// `iPad7,11` → `iPad`, and every unknown identifier → something a person
    /// can read.
    ///
    /// This runs on macOS, which is exactly why the mapping is a separate
    /// function rather than the body of a `#if os(iOS)` branch: a branch this
    /// suite cannot compile is a branch it cannot check, and the branch it could
    /// not check is the one that shipped `ProcessInfo.hostName` to a device.
    func testTheDeviceFamilyComesFromTheHardwareIdentifier() {
        XCTAssertEqual(AppEnvironment.deviceFamilyName(forModelIdentifier: "iPad7,11"), "iPad")
        XCTAssertEqual(AppEnvironment.deviceFamilyName(forModelIdentifier: "iPhone14,2"), "iPhone")
        XCTAssertEqual(AppEnvironment.deviceFamilyName(forModelIdentifier: "iPod9,1"), "iPod touch")
    }

    /// Never empty, whatever the hardware says — including the Simulator's own
    /// `arm64` and a model identifier this build has never heard of. A blank
    /// device name is a row in the user's device list that names no device.
    func testTheDeviceFamilyIsNeverEmptyForAnyIdentifier() {
        for model in ["", "arm64", "x86_64", "RealityDevice14,1", "iPa", "MacBookPro18,3"] {
            XCTAssertFalse(AppEnvironment.deviceFamilyName(forModelIdentifier: model).isEmpty,
                           "\(model) produced an unnamed device")
        }
    }

    /// **The launch watchdog crash, as a guard.**
    ///
    /// `ProcessInfo.processInfo.hostName` on iOS goes through `NSHost`'s
    /// blocking resolver. `deviceName()` is called by `makeSession()`, which
    /// `RelayiumApp.init()` calls — so on a real iPad that call sat on the main
    /// thread in `blockingResolveUntil:` until FrontBoard killed the launch
    /// (`0x8BADF00D`, 20 seconds). Nothing in this file may resolve a name
    /// again, and an absence has no runtime to observe.
    ///
    /// `UIDevice` is refused for a second reason: it is `@MainActor` in the iOS
    /// SDK, and the realtime factories here call `deviceName()` from connection
    /// closures that are not.
    func testNothingInTheEnvironmentResolvesAHostName() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .appendingPathComponent("Sources/RelayiumAppKit/AppEnvironment.swift")
        // Whole-line comments dropped: the file explains the absence and names
        // the call in doing so.
        let code = try String(contentsOf: source, encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")

        for resolving in ["hostName", "NSHost", "Host.current().name",
                          "gethostname", "getaddrinfo", "UIDevice"] {
            XCTAssertFalse(code.contains(resolving),
                           "AppEnvironment reaches for \(resolving) on a launch path")
        }
        // And the macOS answer stays what it was: the local computer name from
        // the dynamic store, which resolves nothing.
        XCTAssertTrue(code.contains("Host.current().localizedName"))
    }
    // The site root is the LAN transfer page, not an account page. Paths mirror
    // web/src/lib/router.svelte.ts (ME_PATH, PRICING_PATH).
    func testWebHandOffPathsAreTheAccountPagesNotTheHomepage() {
        XCTAssertEqual(AppEnvironment.accountWebURL.absoluteString, "https://relayium.com/me")
        XCTAssertEqual(AppEnvironment.plansWebURL.absoluteString, "https://relayium.com/pricing")
    }

    // The token *is* the button: a frozen account cannot sign in, so without it
    // the "Reactivate" hand-off lands on a page that cannot help. The fragment
    // shape is what web/src/lib/Account.svelte reads on mount.
    func testReactivateURLCarriesTheTokenInTheFragment() {
        let url = AppEnvironment.reactivateWebURL(token: "react_abc")
        XCTAssertEqual(url.absoluteString,
                       "https://relayium.com/me#account=pending_deletion&token=react_abc")
    }

    // Percent-encoded like the web's encodeURIComponent, so a token containing
    // `&` or `#` cannot forge another fragment parameter.
    func testReactivateURLPercentEncodesTheToken() {
        let url = AppEnvironment.reactivateWebURL(token: "a b&account=x#y")
        XCTAssertEqual(url.absoluteString,
                       "https://relayium.com/me#account=pending_deletion&token=a%20b%26account%3Dx%23y")
    }

    func testKeychainIdentityMatchesTheBundle() {
        XCTAssertEqual(AppEnvironment.keychainService, "com.relayium.mac")
        XCTAssertEqual(AppEnvironment.keychainAccount, "bearer-token")
    }

    func testKeychainAccessGroupIsTheSharedTeamGroup() {
        // Shared, not the default per-app group — a macOS-only decision. The
        // iOS app does NOT read this credential: it carries no
        // keychain-access-groups entitlement and keeps its own bearer under
        // `com.relayium.app` with no group. Changing this value would cost every
        // existing macOS installation a data migration.
        XCTAssertEqual(AppEnvironment.keychainAccessGroup,
                       "7PVYUG4YQS.com.relayium.shared")
    }

    // The macOS row cannot move: every existing installation's bearer token and
    // every stored-link key it saved lives under exactly these values.
    func testMacKeychainConfigurationIsTheHistoricalIdentity() {
        let c = AppEnvironment.keychainConfiguration(for: .macOS)
        XCTAssertEqual(c.service, "com.relayium.mac")
        XCTAssertEqual(c.account, "bearer-token")
        XCTAssertEqual(c.accessGroup, "7PVYUG4YQS.com.relayium.shared")
    }

    // iOS carries no keychain-access-groups entitlement, so naming a group
    // would be refused on a signed device build — and would claim a cross-app
    // credential share that does not exist.
    func testIOSKeychainConfigurationNamesTheAppAndNoAccessGroup() {
        let c = AppEnvironment.keychainConfiguration(for: .iOS)
        XCTAssertEqual(c.service, "com.relayium.app")
        XCTAssertEqual(c.account, "bearer-token")
        XCTAssertNil(c.accessGroup)
    }

    func testThePlatformsShareTheAccountAndDifferInService() {
        let mac = AppEnvironment.keychainConfiguration(for: .macOS)
        let ios = AppEnvironment.keychainConfiguration(for: .iOS)
        XCTAssertEqual(mac.account, ios.account)
        XCTAssertNotEqual(mac.service, ios.service)
    }

    // Every platform has a decision, and only the entitled one names a group.
    // Iterating allCases is what stops a future platform from being added
    // without one.
    func testEveryPlatformHasACompleteConfiguration() {
        for platform in KeychainPlatform.allCases {
            let c = AppEnvironment.keychainConfiguration(for: platform)
            XCTAssertFalse(c.service.isEmpty, "\(platform)")
            XCTAssertFalse(c.account.isEmpty, "\(platform)")
            if platform != .macOS {
                XCTAssertNil(c.accessGroup, "\(platform) must not name an access group")
            }
        }
    }

    // The dictionary the Security framework actually receives, for a platform
    // this host is not running.
    func testTokenStoreQueryOmitsTheAccessGroupOnIOS() {
        let store = AppEnvironment.makeTokenStore(AppEnvironment.keychainConfiguration(for: .iOS))
        XCTAssertEqual(store.baseQuery[kSecAttrService as String] as? String, "com.relayium.app")
        XCTAssertEqual(store.baseQuery[kSecAttrAccount as String] as? String, "bearer-token")
        XCTAssertNil(store.baseQuery[kSecAttrAccessGroup as String])
    }

    func testTokenStoreQueryCarriesTheTeamGroupOnMac() {
        let store = AppEnvironment.makeTokenStore(AppEnvironment.keychainConfiguration(for: .macOS))
        XCTAssertEqual(store.baseQuery[kSecAttrService as String] as? String, "com.relayium.mac")
        XCTAssertEqual(store.baseQuery[kSecAttrAccessGroup as String] as? String,
                       "7PVYUG4YQS.com.relayium.shared")
    }

    // The one host-dependent fact in the whole policy, kept to one assertion.
    func testCurrentPlatformMatchesTheCompiledPlatform() {
        #if os(iOS)
        XCTAssertEqual(AppEnvironment.currentKeychainPlatform, .iOS)
        #else
        XCTAssertEqual(AppEnvironment.currentKeychainPlatform, .macOS)
        #endif
    }

    // The stored-link keys share the bearer's service — the id charset refuses
    // separators specifically so no id can compose the bearer's account name.
    // One configuration is what keeps that relationship true on both platforms
    // instead of a future iOS upload slice inventing a second service.
    //
    // Both rows are asserted from THIS host, like the bearer's: a stored-link
    // query reachable only from the platform that runs it is exactly the half of
    // the policy that would go unchecked until someone shipped it.
    func testStoredLinkKeyQueryOnMacIsTheHistoricalIdentity() throws {
        let q = try AppEnvironment
            .makeStoredLinkKeyStore(AppEnvironment.keychainConfiguration(for: .macOS))
            .query(for: "0123456789abcdef0123456789abcdef")
        XCTAssertEqual(q[kSecAttrService as String] as? String, "com.relayium.mac")
        XCTAssertEqual(q[kSecAttrAccessGroup as String] as? String,
                       "7PVYUG4YQS.com.relayium.shared")
    }

    func testStoredLinkKeyQueryOnIOSOmitsTheAccessGroup() throws {
        let q = try AppEnvironment
            .makeStoredLinkKeyStore(AppEnvironment.keychainConfiguration(for: .iOS))
            .query(for: "0123456789abcdef0123456789abcdef")
        XCTAssertEqual(q[kSecAttrService as String] as? String, "com.relayium.app")
        XCTAssertNil(q[kSecAttrAccessGroup as String])
    }

    // And the no-argument call the app actually makes resolves to this host's
    // row, so the wiring is covered and not just the table.
    func testStoredLinkKeyStoreDefaultsToTheCurrentPlatform() throws {
        let q = try AppEnvironment.makeStoredLinkKeyStore()
            .query(for: "0123456789abcdef0123456789abcdef")
        XCTAssertEqual(q[kSecAttrService as String] as? String,
                       AppEnvironment.keychainConfiguration.service)
        XCTAssertEqual(q[kSecAttrAccessGroup as String] as? String,
                       AppEnvironment.keychainConfiguration.accessGroup)
    }

    // MARK: - R3-E: realtime wiring for a client with no LAN half

    /// The code-only factories, and why they are separate functions rather than
    /// nil defaults on the existing ones.
    ///
    /// The macOS factories need a `LanDiscoveryModel` and an `InboundRoom`
    /// because both nearby paths reach through the one room socket that model
    /// owns. iOS has no nearby feature, no local-network entitlement and no
    /// roster — so an iOS app that constructed those two objects to satisfy a
    /// signature would be claiming a capability it does not have, and would open
    /// a socket nothing reads.
    ///
    /// What the code-only wiring produces instead is a model whose two nearby
    /// entry points refuse. That is the assertion below: not "the closure is
    /// nil", which is unobservable, but that the model reached through them
    /// fails rather than half-working.
    @MainActor
    func testTheCodeOnlyFileModelRefusesEveryNearbyPath() async {
        let model = AppEnvironment.makeRealtimeModel(verification: VerificationPreference(
            defaults: UserDefaults(suiteName: "r3e-\(UUID().uuidString)")!))
        await model.connectNearby(peerId: "peer-1")
        guard case .failed = model.state else {
            return XCTFail("an iOS-wired model dialled a nearby peer: \(model.state)")
        }
        let accepted = await model.acceptNearby(peerId: "peer-2")
        XCTAssertFalse(accepted, "an iOS-wired model answered an unsolicited offer")
    }

    @MainActor
    func testTheCodeOnlyTextModelRefusesEveryNearbyPath() async {
        let model = AppEnvironment.makeRealtimeTextModel(verification: VerificationPreference(
            defaults: UserDefaults(suiteName: "r3e-\(UUID().uuidString)")!))
        await model.connectNearby(peerId: "peer-1")
        guard case .failed = model.state else {
            return XCTFail("an iOS-wired model dialled a nearby peer: \(model.state)")
        }
        let accepted = await model.acceptNearby(peerId: "peer-2")
        XCTAssertFalse(accepted, "an iOS-wired model answered an unsolicited offer")
    }

    /// The Mac's factories still take — and still use — the nearby dependencies.
    /// The code-only overloads are an addition, not a relaxation: a default
    /// argument on the existing signature would have let a macOS call site drop
    /// its discovery model silently and lose the whole nearby feature.
    @MainActor
    func testTheNearbyFactoriesStillRequireTheirDiscoveryDependencies() async {
        let defaults = UserDefaults(suiteName: "r3e-\(UUID().uuidString)")!
        let nearby = AppEnvironment.makeLanDiscoveryModel()
        let room = InboundRoom()
        let model = AppEnvironment.makeRealtimeModel(
            verification: VerificationPreference(defaults: defaults),
            nearby: nearby, inboundRoom: room, pairingRoom: LinkRoomHandle())
        // Not scanning, so this still fails — but through the discovery model's
        // own refusal, which is the path that exists only on macOS.
        await model.connectNearby(peerId: "peer-1")
        guard case .failed = model.state else { return XCTFail("got \(model.state)") }
    }

    // MARK: - R3-F: the nearby graph, wired the way both platforms use it

    /// One room socket, and the receive model is subscribed to it.
    ///
    /// `makeNearbyReceiveModel` is the only place that relationship is
    /// established, and it is three separate wirings that have to all be there:
    /// the observer slot (re-subscribed on every socket, because a reconnect
    /// mints a new one), the state mirror (so what the user is told cannot drift
    /// from the room), and the immediate seed (so a model built after residency
    /// started does not report `off` over a joined room). Any one of them
    /// missing looks like working code.
    @MainActor
    func testTheNearbyReceiveModelIsSubscribedToTheOneRoomAndFollowsItsState() async {
        let opened = SocketLog()
        let discovery = LanDiscoveryModel(connect: {
            let channel = opened.open()
            let client = SignalingClient(channel: channel, name: "iPhone")
            channel.fireOpen()
            return client
        })
        let defaults = VerificationPreference(
            defaults: UserDefaults(suiteName: "r3f-\(UUID().uuidString)")!)
        let room = InboundRoom()
        // This test drives residency and the same-network path; no code is
        // joined, so the pairing room stays empty and its fallback builder
        // simply refuses.
        let pairing = LinkRoomHandle()
        let file = AppEnvironment.makeRealtimeModel(verification: defaults,
                                                    nearby: discovery, inboundRoom: room,
                                                    pairingRoom: pairing)
        let text = AppEnvironment.makeRealtimeTextModel(verification: defaults,
                                                        nearby: discovery, inboundRoom: room,
                                                        pairingRoom: pairing)
        let receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: file, textModel: text, discovery: discovery, inboundRoom: room)

        XCTAssertTrue(discovery.observer === receive,
                      "nothing re-subscribes the listener when the socket is replaced")
        XCTAssertEqual(receive.state, .off)

        discovery.startResident()
        for _ in 0..<8 { await Task.yield() }
        XCTAssertEqual(receive.state, .connecting,
                       "a room with no welcome yet is not reachable and must not say ready")

        opened.channels[0].fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        for _ in 0..<8 { await Task.yield() }
        XCTAssertEqual(receive.state, .ready)

        discovery.startResident()
        for _ in 0..<8 { await Task.yield() }
        XCTAssertEqual(opened.channels.count, 1,
                       "a second residency call put this device in the room twice")

        discovery.pause()
        for _ in 0..<8 { await Task.yield() }
        XCTAssertEqual(receive.state, .paused)
    }

    /// The socket an inbound attempt builds on is the one the offer arrived on,
    /// and it is nil at every other moment.
    ///
    /// A peer id only means something inside the room that issued it, so a
    /// builder that read "the current room" would, in the one case that matters
    /// — a drop mid-setup — reach a room where that id belongs to nobody, or to
    /// somebody else.
    @MainActor
    func testTheInboundRoomIsEmptyOutsideAnAttemptAndIsClearedWhenTheSocketGoes() async {
        let opened = SocketLog()
        let discovery = LanDiscoveryModel(connect: {
            let channel = opened.open()
            let client = SignalingClient(channel: channel, name: "iPhone")
            channel.fireOpen()
            return client
        })
        let defaults = VerificationPreference(
            defaults: UserDefaults(suiteName: "r3f-\(UUID().uuidString)")!)
        let room = InboundRoom()
        let pairing = LinkRoomHandle()
        let file = AppEnvironment.makeRealtimeModel(verification: defaults,
                                                    nearby: discovery, inboundRoom: room,
                                                    pairingRoom: pairing)
        let text = AppEnvironment.makeRealtimeTextModel(verification: defaults,
                                                        nearby: discovery, inboundRoom: room,
                                                        pairingRoom: pairing)
        let receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: file, textModel: text, discovery: discovery, inboundRoom: room)

        discovery.startResident()
        for _ in 0..<8 { await Task.yield() }
        XCTAssertNil(room.signaling, "a builder could reach a room with no offer in flight")

        discovery.stop()
        for _ in 0..<8 { await Task.yield() }
        XCTAssertNil(room.signaling)
        XCTAssertEqual(receive.state, .off)
    }

    // "In the fragment" and "not in the query" are different claims, and only
    // the second one keeps the token out of the server's access log.
    func testReactivateURLPutsNothingInTheQuery() {
        let url = AppEnvironment.reactivateWebURL(token: "react_abc")
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        XCTAssertNil(components?.query)
        XCTAssertEqual(components?.fragment?.contains("react_abc"), true)
    }
    /// A UI-test launch must not be able to read, keep or destroy the credential
    /// the installed product wrote.
    ///
    /// The macOS suite ran signed in on a workstation with Relayium installed —
    /// the test build and the product build resolve the same keychain item — so
    /// three signed-out paths failed locally and passed on a runner that happened
    /// to have no account. Either outcome is the suite measuring the machine.
    func testTheIsolatedKeychainIdentitySharesNothingWithTheProduct() {
        let product = AppEnvironment.keychainConfiguration
        let isolated = AppEnvironment.isolatedKeychainConfiguration(product)

        XCTAssertNotEqual(isolated.service, product.service,
                          "an isolated launch resolves the product's own keychain item")
        XCTAssertTrue(isolated.service.hasPrefix(product.service),
                      "the isolated identity is unrecognisable as this app's")
        XCTAssertEqual(isolated.account, product.account,
                       "the account field is the item's shape, not its owner")
        // An access group is a SHARE. A test identity that joined it would be
        // reachable from the extensions the product ships.
        XCTAssertNil(isolated.accessGroup,
                     "the isolated identity joined the product's access group")
    }

    func testTheIsolatedIdentityIsStableAndPlatformIndependent() {
        for platform in [KeychainPlatform.macOS, .iOS] {
            let product = AppEnvironment.keychainConfiguration(for: platform)
            let isolated = AppEnvironment.isolatedKeychainConfiguration(product)
            XCTAssertEqual(isolated, AppEnvironment.isolatedKeychainConfiguration(product),
                           "the isolated identity is not stable across calls")
            XCTAssertNotEqual(isolated.service, product.service)
        }
    }

    func testInboxJournalsAreSeparatedByAccount() throws {
        let first = try InboxAccountID("accountjournal01")
        let second = try InboxAccountID("accountjournal02")
        let a = AppEnvironment.inboxJournalSubdirectory(base: "device-inbox", account: first)
        let b = AppEnvironment.inboxJournalSubdirectory(base: "device-inbox", account: second)
        XCTAssertEqual(a, "device-inbox/accounts/accountjournal01")
        XCTAssertEqual(b, "device-inbox/accounts/accountjournal02")
        XCTAssertNotEqual(a, b, "two accounts share one durable journal namespace")
    }

}
