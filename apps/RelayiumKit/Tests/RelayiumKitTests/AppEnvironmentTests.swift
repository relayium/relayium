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

    /// The address a person is shown, for the screens that ask them to open it
    /// on another device.
    ///
    /// Asserted against the URL rather than only against the literal: the point
    /// of deriving it is that a build pointed elsewhere cannot print one host
    /// and open another, and a test comparing both to the same hard-coded
    /// string would pass while that promise was broken.
    func testTheShownHostIsTheHostOfTheURLItOpens() {
        XCTAssertEqual(AppEnvironment.productionHost, "relayium.com")
        XCTAssertEqual(AppEnvironment.productionHost, AppEnvironment.productionBaseURL.host())
        XCTAssertFalse(AppEnvironment.productionHost.contains("/"),
                       "the shown address carries a path, so it is not an address to type")
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
        // Whole-line comments dropped: the file explains the absence and names
        // the call in doing so.
        let code = try RepoRoot
            .text("apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift")
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

    // The two legal pages a subscription is sold under, at the addresses the
    // site actually publishes. `web/scripts/pages/build-pages.mjs` writes them as
    // `privacy/index.html` and `terms/index.html`, and the sitemap's own `<loc>`
    // carries the trailing slash — the slashless form is a redirect, and a
    // redirect is what a reviewer would watch happen on the purchase screen.
    func testTheLegalPagesAreTheSitesOwnPublishedAddresses() {
        XCTAssertEqual(AppEnvironment.privacyWebURL.absoluteString,
                       "https://relayium.com/privacy/")
        XCTAssertEqual(AppEnvironment.termsWebURL.absoluteString,
                       "https://relayium.com/terms/")
    }

    // Both are Relayium's own pages over TLS. An `http` link on a purchase
    // surface is refused by ATS before anybody reads it, and a legal page on
    // somebody else's host is not this product's policy.
    func testTheLegalPagesAreRelayiumsOwnOverHTTPS() {
        for url in [AppEnvironment.privacyWebURL, AppEnvironment.termsWebURL] {
            XCTAssertEqual(url.scheme, "https", "\(url) is not over TLS")
            XCTAssertEqual(url.host, AppEnvironment.productionBaseURL.host,
                           "\(url) does not point at Relayium")
            // No query and no fragment: nothing about which account is reading a
            // policy belongs in a URL that leaves the app for a browser.
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            XCTAssertNil(components?.query)
            XCTAssertNil(components?.fragment)
        }
        // And they are two different documents. One constant copied over the
        // other would still satisfy every check above.
        XCTAssertNotEqual(AppEnvironment.privacyWebURL, AppEnvironment.termsWebURL)
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
    /// The nearby-capable factories need a `LanDiscoveryModel` and an
    /// `InboundRoom` because both nearby paths reach through the one room socket
    /// that model owns. A caller with no roster — which iOS was when these
    /// overloads were written, and which any future code-only host would be —
    /// would have had to construct those two objects purely to satisfy a
    /// signature, and would then be holding a live room socket nothing reads.
    ///
    /// iOS is no longer that caller: `RelayiumApp` passes a real
    /// `LanDiscoveryModel` and `InboundRoom`. These overloads therefore have no
    /// production call site today, and the two tests below are what keeps them
    /// honest — a refusing model rather than a half-working one — for the next
    /// host that needs them.
    ///
    /// **These were never a permission boundary, and an earlier version of this
    /// comment said they were.** It read "no local-network entitlement", which
    /// is true only in the pedantic sense that Local Network is not an
    /// entitlement at all: it is a user-consented protected resource declared as
    /// `NSLocalNetworkUsageDescription` in the app's `Info.plist`, which the iOS
    /// app now does declare, because the transfer connects with
    /// `iceTransportPolicy = .all` and reaches the peer over the local subnet.
    /// Nothing about that is expressed here. What these overloads express is the
    /// absence of a FEATURE — no roster to read, no socket to answer on — and
    /// `IOSLocalNetworkPermissionTests` owns the declaration itself.
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

    // MARK: - the answer-timeout recovery, per composition

    // `error.nearby.noAnswer` tells the user to open relayium.com on the device
    // that went quiet. That is a working instruction against the hub-backed
    // code-less room — a browser there IS a listening peer — and an impossible
    // one against `_relayium._tcp`, where a browser publishes no service and
    // can never answer. So the sentence is a property of the COMPOSITION, not
    // of the error, and these prove which sentence each factory chose.
    //
    // `NearbySessionModelTests` drives both real timeout paths and proves the
    // chosen key becomes the rendered message; this proves the choice. Neither
    // is sufficient alone: a factory could pick the right key for a model that
    // ignored it, and a model could honour a key no factory ever passes.

    /// Every factory this package compiles on the test host leaves the recovery
    /// on the shared sentence.
    ///
    /// Listed as a table rather than as one assertion per factory, because the
    /// claim is about the SET: `makeRealtimeModel`'s iOS overload is the only
    /// exception in the file, and an exception that grew a second member
    /// without anybody noticing is the failure this catches.
    @MainActor
    func testEveryHostCompiledFactoryLeavesTheRecoveryOnTheSharedWebSentence() {
        let defaults = VerificationPreference(
            defaults: UserDefaults(suiteName: "noanswer-\(UUID().uuidString)")!)
        let nearby = AppEnvironment.makeLanDiscoveryModel()
        let room = InboundRoom()
        let pairing = LinkRoomHandle()

        let files: [(String, RealtimeSessionModel)] = [
            ("makeRealtimeModel(code-only)",
             AppEnvironment.makeRealtimeModel(verification: defaults)),
            ("makeRealtimeModel(nearby)",
             AppEnvironment.makeRealtimeModel(verification: defaults, nearby: nearby,
                                              inboundRoom: room, pairingRoom: pairing)),
            ("makeNearbyRealtimeModel",
             AppEnvironment.makeNearbyRealtimeModel(verification: defaults, nearby: nearby,
                                                    inboundRoom: room)),
            ("makeDirectRealtimeModel",
             AppEnvironment.makeDirectRealtimeModel(verification: defaults,
                                                    pairingRoom: pairing)),
        ]
        let texts: [(String, RealtimeTextSessionModel)] = [
            ("makeRealtimeTextModel(code-only)",
             AppEnvironment.makeRealtimeTextModel(verification: defaults)),
            ("makeRealtimeTextModel(nearby)",
             AppEnvironment.makeRealtimeTextModel(verification: defaults, nearby: nearby,
                                                  inboundRoom: room, pairingRoom: pairing)),
            ("makeNearbyRealtimeTextModel",
             AppEnvironment.makeNearbyRealtimeTextModel(verification: defaults, nearby: nearby,
                                                        inboundRoom: room)),
            ("makeDirectRealtimeTextModel",
             AppEnvironment.makeDirectRealtimeTextModel(verification: defaults,
                                                        pairingRoom: pairing)),
        ]
        for (name, model) in files {
            XCTAssertEqual(model.nearbyNoAnswerCopy, .errorNearbyNoAnswer,
                           "\(name) moved macOS off the recovery that works for it")
        }
        for (name, model) in texts {
            XCTAssertEqual(model.nearbyNoAnswerCopy, .errorNearbyNoAnswer,
                           "\(name) moved macOS off the recovery that works for it")
        }
        XCTAssertEqual(files.count + texts.count, 8)
    }

    /// The value the iOS boundary substitutes, asserted here because the
    /// overloads that use it are inside `#if os(iOS)` and a Mac-hosted run
    /// compiles neither them nor anything declared beside them. That is exactly
    /// why the constant is declared outside the conditional.
    func testTheLocalNearbyRecoveryKeyIsTheLocalLinkOne() {
        XCTAssertEqual(AppEnvironment.localNearbyNoAnswerCopy, .errorNearbyIOSNoAnswer)
        XCTAssertNotEqual(AppEnvironment.localNearbyNoAnswerCopy, .errorNearbyNoAnswer)
    }

    /// **And the substitution happens only inside the iOS block.**
    ///
    /// The one claim a Mac-hosted run cannot make executably: whether the two
    /// `#if os(iOS)` overloads still pass the key, and whether anything outside
    /// them started to. Read as text, with comments stripped, because a comment
    /// mentioning the identifier is not a call site.
    func testTheOnlyOverrideOfTheRecoveryKeyIsTheIOSCompositionBoundary() throws {
        let code = try RepoRoot
            .text("apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")

        let overrides = code.components(separatedBy: "nearbyNoAnswerCopy: localNearbyNoAnswerCopy")
            .count - 1
        XCTAssertEqual(overrides, 2,
                       "the file model and the text model must both be composed with the "
                       + "local-link recovery, and nothing else may be")

        // Anchored on the constant, not on the first `#if os(iOS)` in the
        // file: this file has several, and the block that matters is the one
        // that follows the value it substitutes.
        let constant = try XCTUnwrap(code.range(of: "public static let localNearbyNoAnswerCopy"))
        let start = try XCTUnwrap(
            code.range(of: "#if os(iOS)", range: constant.upperBound..<code.endIndex))
        let end = try XCTUnwrap(code.range(of: "#endif", range: start.upperBound..<code.endIndex))
        let iosBlock = code[start.upperBound..<end.lowerBound]
        XCTAssertEqual(
            iosBlock.components(separatedBy: "nearbyNoAnswerCopy: localNearbyNoAnswerCopy").count - 1,
            2, "the substitution moved out of the iOS composition boundary")

        // The shared factories still DECLARE the parameter and still default it
        // to the shared sentence. A default flipped to the iOS key is the
        // mutation that would put a Bonjour sentence on a Mac.
        XCTAssertEqual(
            code.components(separatedBy: "nearbyNoAnswerCopy: L10nKey = .errorNearbyNoAnswer").count - 1,
            2, "a shared factory's default moved off the Web recovery")
        XCTAssertFalse(code.contains("nearbyNoAnswerCopy: L10nKey = .errorNearbyIOSNoAnswer"),
                       "a shared factory now defaults every platform to the local-link recovery")
        XCTAssertEqual(code.components(separatedBy: ".errorNearbyIOSNoAnswer").count - 1, 1,
                       "the local-link key must be named exactly once, at the constant")
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
