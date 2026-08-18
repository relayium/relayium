// For `ObservableObject`/`@Published` on the Debug-only update-action witness
// below, which the blocking surface observes.
import Combine
import Foundation
import RelayiumAppKit
import RelayiumKit

/// Whether this process was launched by the UI test suite.
///
/// **It does not exist in a Release build.** The whole type is inside
/// `#if DEBUG`, so the shipped binary contains neither the flag nor the check —
/// this is not a runtime switch a user, a deep link or a relay could reach, it
/// is a compile-time absence. That is deliberate: the one thing it turns off is
/// residency, and an app that silently stops being reachable is the worst bug
/// this product can have.
///
/// **Why UI tests need it at all**, rather than simply running the app as
/// shipped: launching Relayium opens a persistent room socket, and every device
/// reaching the internet from the same public address sees the others on its
/// nearby list. CI runners share public addresses. A UI test with residency on
/// would put a GitHub runner into strangers' device lists for the length of the
/// run — a privacy consequence, not a tidiness one, and not something a
/// `--dry-run` flag on the test would fix.
///
/// The six destinations, the settings scene and all nine languages are the real
/// UI. Residency and notification registration are skipped because they reach
/// outward; the generated-text-code test additionally injects the deterministic
/// model below so it can hold a handoff screen without contacting production.
enum UITestMode {
    #if DEBUG
    /// The argument the UI test target passes. Read once: `ProcessInfo`'s
    /// arguments cannot change after launch, and a stored answer keeps every
    /// call site cheap and identical.
    // nonlocalized: a launch argument, never displayed
    static let argument = "--relayium-ui-testing"
    static let isActive = ProcessInfo.processInfo.arguments.contains(argument)

    /// Whether this acceptance launch may become reachable.
    ///
    /// **Gated on the resolved origin, not on a flag of its own.** The reason
    /// acceptance skips residency is that the production hub keys its code-less
    /// room by the public address it observes, so a resident test build joins a
    /// room with whatever strangers share that address — a privacy consequence,
    /// which is why no `--please-be-resident` argument would be an acceptable
    /// way to turn it back on. A loopback origin removes the consequence rather
    /// than accepting it: the room lives on a server bound to `127.0.0.0/8`,
    /// nothing off this machine can open a socket to it, and there is no
    /// stranger for the roster to contain.
    ///
    /// So the seam and the permission are the same fact, read once. A launch
    /// that fails to resolve a loopback origin — including every launch that
    /// passes no origin at all — resolves production and is refused here, which
    /// is the behaviour that shipped before this existed.
    static let allowsResidency = isActive && AppEnvironment.isLoopbackTransferOrigin
    /// Whether this launch substitutes the OFFLINE transfer models.
    ///
    /// **The exact complement of `allowsResidency`, and it has to be.** The
    /// substitutions below — a pair client that mints `483920`, an ICE client
    /// that sleeps for five minutes, a pairing socket factory that is a
    /// `preconditionFailure` — exist so the offline suite can hold a handoff
    /// screen without contacting production. They were applied on `isActive`
    /// alone, which quietly made them apply to the LOOPBACK acceptance launch as
    /// well, and that is not a slower version of the product: it is a different
    /// one. `LinkWorkspaceModel.watchPairingCode` awaits its ICE read BEFORE it
    /// opens the room, so a fixture ICE client leaves the app in `.watching`
    /// for the whole run and no pairing socket is ever opened. Measured exactly
    /// that way: two native ends both waiting, neither asking, and the cause
    /// written up as a product defect in the pairing wire.
    ///
    /// So the rule is the one iOS already applies — its fixtures answer `nil`
    /// unless their own flag is passed, and a plain acceptance launch there gets
    /// the real models. A loopback origin is a real server on this machine, and
    /// a launch pointed at one must exercise the real transfer graph or it is
    /// evidence about the fixtures.
    ///
    /// The per-fixture flags (`--relayium-ui-testing-file-code`,
    /// `--relayium-ui-testing-terminal-nearby`, `--relayium-ui-testing-text-code`)
    /// keep their own guards and are unaffected: they are only ever passed by
    /// the offline suite, which resolves production and is refused residency.
    static let usesOfflineTransfer = isActive && !allowsResidency
    /// Holds the text pairing model on a deterministic terminal failure so the
    /// UI suite can verify that cleanup, not a second start path, owns the page.
    // nonlocalized: a test-only launch argument, absent from Release
    static let terminalTextArgument = "--relayium-ui-testing-terminal-text"
    static let showsTerminalText = ProcessInfo.processInfo.arguments.contains(terminalTextArgument)
    /// Builds a deterministic failed Nearby file task so the UI suite can prove
    /// its retained terminal surface still exposes the route back to the roster.
    // nonlocalized: a test-only launch argument, absent from Release
    static let terminalNearbyArgument = "--relayium-ui-testing-terminal-nearby"
    static let showsTerminalNearby = ProcessInfo.processInfo.arguments.contains(terminalNearbyArgument)
    /// Whether this launch already holds an account.
    ///
    /// Every signed-in surface — Send a link, the device and stored-file
    /// sections, and every completion that follows them — was unreachable from
    /// acceptance, because the suite could only ever be signed out. The account
    /// below is answered entirely in process: no request leaves the device, no
    /// real credential exists, and the bearer is a literal that no server would
    /// accept.
    /// Fails a chunk upload, so the recoverable-failure surface can be driven.
    // nonlocalized: a test-only launch argument, absent from Release
    static let failUploadArgument = "--relayium-ui-testing-fail-upload"
    static let failsUpload = ProcessInfo.processInfo.arguments.contains(failUploadArgument)

    /// Holds a chunk upload open so the in-flight surface can be driven.
    // nonlocalized: a test-only launch argument, absent from Release
    static let stallUploadArgument = "--relayium-ui-testing-stall-upload"
    static let stallsUpload = ProcessInfo.processInfo.arguments.contains(stallUploadArgument)

    /// A signed-in launch whose account id the Device Inbox refuses to use.
    ///
    /// **The one state where "there is an account" and "the receiver adopted it"
    /// disagree permanently.** `InboxController.session(_:)` fails closed on an
    /// id this build will not use as a keychain item name or a defaults key: it
    /// stops the loop, drops the generation and reports `.failed(.identity)`
    /// while the session beside it stays perfectly `ready`. Every other
    /// disagreement between those two facts is one main-actor turn long.
    ///
    /// It exists because the Device Inbox surface renders a THIRD branch for it,
    /// and a branch inferred from a neighbouring state is a branch whose first
    /// execution is in front of a user. Rendered the obvious ways it is either a
    /// pane of controls whose setters return immediately, or a capability gate
    /// handed an `.allowed` it asserts on and draws nothing for.
    ///
    /// Nothing is substituted except the account id in the fixture's own
    /// `/api/me`: the real session, the real bridge, the real controller and the
    /// real identifier check all run, and the check refuses before any store,
    /// keychain item or network call is reached.
    // nonlocalized: a test-only launch argument, absent from Release
    static let unusableAccountArgument = "--relayium-ui-testing-unusable-account"
    static let hasUnusableAccount = ProcessInfo.processInfo.arguments
        .contains(unusableAccountArgument)

    // nonlocalized: a test-only launch argument, absent from Release
    static let signedInArgument = "--relayium-ui-testing-signed-in"
    /// Signed OUT, but with the account API answered — so the sign-in form can be
    /// filled in and succeed. `isSignedIn` seeds a bearer; this one does not.
    // nonlocalized: a test-only launch argument, absent from Release
    static let signInArgument = "--relayium-ui-testing-sign-in"
    static let answersAccountAPI = ProcessInfo.processInfo.arguments.contains(signInArgument)
    static let isSignedIn = ProcessInfo.processInfo.arguments.contains(signedInArgument)

    /// A token store already holding the acceptance bearer, so `restore()` takes
    /// its normal “found a credential” path rather than a special one.
    static func makeSignedInTokenStore() -> TokenStore {
        let store = InMemoryTokenStore()
        try? store.save(UITestAccountTransport.bearer)
        return store
    }

    static func makeAccountTransport() -> URLSession? {
        guard isSignedIn || answersAccountAPI else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UITestAccountTransport.self]
        return URLSession(configuration: configuration)
    }



    /// A staging root of this launch's own, emptied before use.
    ///
    /// A cancelled upload stays resumable by design, so its staged bytes outlive
    /// the process — and therefore outlive the run. Without a root of its own an
    /// acceptance launch inherits the interrupted job the previous run left, and
    /// opens on Resume upload instead of a fresh selection. Same rule as the
    /// keychain: isolating one store is not isolating the app.
    static func pendingUploadRoot() -> URL? {
        // Application Support, deliberately. `IOSSurfaceGuardTests` refuses
        // temporaryDirectory, downloadsDirectory and cachesDirectory anywhere in
        // these sources, because a received file must never land somewhere the
        // system can purge or the user cannot find — and that guard reads the
        // whole file, not just the receive path. A staging root has no business
        // being an exception to it.
        guard isActive,
              let support = try? FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true) else { return nil }
        let root = support.appendingPathComponent("uitest-pending", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
        return root
    }

    /// The stored-link key store an acceptance launch may use.
    ///
    /// **This is the more consequential half of the keychain isolation.**
    /// `AppEnvironment.makeStoredLinkKeyStore()` resolves the product's own
    /// keychain identity, so before this an acceptance launch could READ the
    /// installed app's stored-link keys — and a delete path calls `remove`,
    /// which would have destroyed real ones. In memory, so it also cannot
    /// outlive the process.
    ///
    /// Seeded only for a signed-in launch, and only for the object the account
    /// fixture describes, so the rebuildable arm of a stored row has something
    /// to rebuild from.
    static func makeStoredLinkKeyStore() -> StoredLinkKeyStore? {
        guard isActive else { return nil }
        let store = InMemoryStoredLinkKeyStore()
        guard isSignedIn else { return store }
        // nonlocalized: 32 zero bytes, base64url — an acceptance key, never real
        let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        Task { try? await store.save(id: "obj_uitest", keyB64url: key) }
        return store
    }
    /// The keychain an acceptance launch may use — never the item the installed
    /// product wrote, and emptied before the session restores.
    ///
    /// This Mac has Relayium installed, and the test build resolved the same
    /// keychain item, so the suite ran signed in and three signed-out paths
    /// failed here while passing on a runner that happened to have no account.
    /// Both results measured the machine. Emptied on every launch as well as
    /// isolated, so one path cannot inherit an account another path established.
    static func makeTokenStore() -> TokenStore? {
        guard isActive else { return nil }
        if isSignedIn { return makeSignedInTokenStore() }
        let store = AppEnvironment.makeTokenStore(
            AppEnvironment.isolatedKeychainConfiguration())
        try? store.clear()
        return store
    }

    /// The installation identity an acceptance launch may use.
    ///
    /// Isolating the bearer is not isolating the app: this Mac has Relayium
    /// installed, and a test build resolving the product's own item would READ
    /// the installed app's installation identity and, on first launch, WRITE
    /// one there. The first would make an acceptance run present the owner's
    /// real identity to the server; the second would silently create the
    /// identity the product then keeps forever.
    ///
    /// Cleared on every launch as well as isolated, so one acceptance path
    /// cannot inherit an identity another established.
    static func makeInstallationIdentityStore() -> InstallationIdentityStoring? {
        guard isActive else { return nil }
        let store = AppEnvironment.makeInstallationIdentityStore(
            AppEnvironment.isolatedKeychainConfiguration())
        try? store.clear()
        return store
    }

    /// Holds the pairing surface on its generated code with a batch staged.
    ///
    /// It was the FILE half of a two-button create, which was the half with no
    /// runtime evidence. There is one Create action now and no lane to choose,
    /// so what this launch still buys is the other variable it always carried:
    /// a code minted with a batch already staged. Minting succeeds locally and
    /// the ICE lookup then waits, so the handoff screen holds without a network
    /// call.
    // nonlocalized: a test-only launch argument, absent from Release
    static let fileCodeArgument = "--relayium-ui-testing-file-code"
    static let showsGeneratedFileCode = ProcessInfo.processInfo.arguments.contains(
        fileCodeArgument)

    /// A generated code whose deadline is seconds away, so the countdown, the
    /// expiry and the regeneration path can all be driven in one launch.
    ///
    /// Additive to `--relayium-ui-testing-file-code` rather than a mode of its
    /// own: what is being checked is the ordinary minted-code surface reaching
    /// its own deadline, not a separate screen.
    // nonlocalized: a test-only launch argument, absent from Release
    static let expiringCodeArgument = "--relayium-ui-testing-expiring-code"
    static let showsExpiringCode = ProcessInfo.processInfo.arguments
        .contains(expiringCodeArgument)

    /// A `relayium.com` link this launch should be handed at startup.
    ///
    /// **The only way the suite can reach Open a link, and deliberately so.**
    /// That destination has no sidebar row: it is where a link the OS hands this
    /// app is opened, not somewhere a person browses to. A test-only "select
    /// this destination" switch would prove the screen renders while proving
    /// nothing about the route that actually reaches it — so this hands the URL
    /// to `AppDeepLinkRouter.open`, the same entry point `onOpenURL` uses, and
    /// everything after it is production: the parser, the coordinator, the
    /// routing decision and the shell arm.
    ///
    /// The value follows the flag as the next argument. A URL the parser refuses
    /// is simply refused, exactly as it would be from the OS.
    // nonlocalized: a test-only launch argument, absent from Release
    static let openLinkArgument = "--relayium-ui-testing-open-link"
    static var launchDeepLink: URL? {
        let arguments = ProcessInfo.processInfo.arguments
        guard isActive,
              let flag = arguments.firstIndex(of: openLinkArgument),
              arguments.index(after: flag) < arguments.endIndex else { return nil }
        return URL(string: arguments[arguments.index(after: flag)])
    }

    /// **The marketing version this launch's SUPPORT POLICY is evaluated
    /// against**, when the acceptance suite names one.
    ///
    /// The one input a built-App run cannot otherwise vary. Whether the blocking
    /// surface really replaces the product is a runtime fact about a build below
    /// the minimum, and every candidate this suite can build is above it by the
    /// release guard's own rule — `SupportedVersionSurfaceTests` refuses a
    /// candidate that ships below its own published minimum, because such a
    /// build would block on first launch and the only way out of it would be an
    /// update to itself. The alternatives were to sign and notarize a
    /// below-minimum app, or to raise the published minimum above the shipping
    /// version, which would block every installed copy.
    ///
    /// **It changes the number and nothing else.** The floor compiled into this
    /// binary, the decoder, the model, the gate, the menu bar and the update
    /// action are all production, and `CFBundleShortVersionString` is untouched
    /// — so the About box, the device list and Sparkle's own build comparison
    /// still read the build that is really running. This value reaches exactly
    /// one call: the `currentVersion` the scene hands `SupportedVersionModel`.
    ///
    /// The value follows the flag as the next argument. A string `AppVersion`
    /// refuses is simply refused, and the launch falls back to the bundle's own
    /// version — which is the shipped behaviour.
    // nonlocalized: a test-only launch argument, absent from Release
    static let appVersionArgument = "--relayium-ui-testing-app-version"
    static var appVersionOverride: AppVersion? {
        let arguments = ProcessInfo.processInfo.arguments
        guard isActive,
              let flag = arguments.firstIndex(of: appVersionArgument),
              arguments.index(after: flag) < arguments.endIndex else { return nil }
        return AppVersion(arguments[arguments.index(after: flag)])
    }

    /// The Device Inbox controller an acceptance launch may use, or nil.
    ///
    /// Delegated to `UITestInbox`, which owns the stub transport and the
    /// launch-isolated stores. Kept as a call here so every acceptance
    /// substitution is reachable from one type.
    @MainActor
    static func makeInboxController() -> InboxController? { UITestInbox.makeController() }

    /// A launch that renders the App Store build's purchase surface.
    ///
    /// **Why it can be driven from the direct build at all.** The purchase
    /// surface is one card, injected as an app-scoped model; whether a build HAS
    /// one is decided by target membership (`AppDistribution`), and whether the
    /// account screen shows the web hand-off is decided by that model's presence
    /// as well as by the channel. So injecting a model here reaches exactly the
    /// shared source the App Store target compiles — the card, the rows, the
    /// copy layer, the orchestration and the real `AccountClient` — without a
    /// second UI-test target, a signed App Store build, a sandbox Apple ID or a
    /// product record in App Store Connect, none of which acceptance can have.
    ///
    /// What it does NOT prove, and is not claimed to: that the App Store target
    /// links StoreKit and the direct one does not. That is a linkage fact, and
    /// `StoreKitLinkageTests` reads the project file for it.
    // nonlocalized: a test-only launch argument, absent from Release
    static let subscriptionsArgument = "--relayium-ui-testing-subscriptions"
    static let showsSubscriptions = ProcessInfo.processInfo.arguments
        .contains(subscriptionsArgument)
    /// Blocks the purchase, so the "managed on the web" refusal has a runtime.
    // nonlocalized: a test-only launch argument, absent from Release
    static let blockedSubscriptionArgument = "--relayium-ui-testing-subscription-blocked"
    static let blocksSubscription = ProcessInfo.processInfo.arguments
        .contains(blockedSubscriptionArgument)

    /// The purchase model an acceptance launch renders, or nil for every other
    /// launch — including every Release one, where this whole type is absent.
    ///
    /// The billing half is the REAL `AccountClient` over the in-process
    /// transport, so the catalog request, its query parameter, its status
    /// mapping and its decoding are all production code. Only the store is a
    /// fake, because a real one needs a signed build and an App Store account.
    @MainActor
    static func makeSubscriptionModel(
        bearer: @escaping @MainActor () -> String?,
        refreshAccount: @escaping @MainActor () async -> Void
    ) -> AppleSubscriptionModel? {
        guard showsSubscriptions, let transport = makeAccountTransport() else { return nil }
        return AppleSubscriptionModel(
            store: UITestSubscriptionStore(),
            billing: AppEnvironment.makeAppleBillingService(transport: transport),
            bundleID: UITestAccountTransport.bundleID,
            bearer: bearer,
            refreshAccount: refreshAccount)
    }

    @MainActor
    static func makeWaitingFileModel(verification: VerificationPreference) -> RealtimeSessionModel? {
        guard showsGeneratedFileCode else { return nil }
        return RealtimeSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestWaitingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }

    /// Keeps the unified pairing-room watcher deterministic and offline.
    ///
    /// The legacy models already use `UITestWaitingICEClient`, but `link/1`
    /// owns a separate ICE read before it opens the room. Leaving that client
    /// live makes an offline acceptance launch replace a valid generated code
    /// with `roomUnavailable` according to runner network timing.
    ///
    /// **Two factories, because the product has two modules.** They mirror
    /// `AppEnvironment.makeNearbyLinkWorkspaceModel` and
    /// `makeDirectLinkWorkspaceModel` exactly: the nearby one observes the room
    /// and can open no code, the direct one watches a code and observes no
    /// roster. A single acceptance model registered for both would be the shared
    /// graph the product no longer has, which is the one thing an acceptance
    /// substitution must never quietly restore.
    @MainActor
    static func makeNearbyLinkWorkspaceModel(verification: VerificationPreference,
                                             nearby: LanDiscoveryModel) -> LinkWorkspaceModel {
        let model = LinkWorkspaceModel(
            capabilities: nearby.capabilities,
            receiveDirectory: { FileManager.default.temporaryDirectory },
            requiresVerification: { verification.requiresSASConfirmation },
            iceClient: UITestWaitingICEClient())
        nearby.addRoomObserver(model)
        return model
    }

    @MainActor
    static func makeDirectLinkWorkspaceModel(verification: VerificationPreference,
                                             pairingRoom: LinkRoomHandle) -> LinkWorkspaceModel {
        LinkWorkspaceModel(
            capabilities: PeerCapabilityRegistry(
                linkRoomActive: { linkRoomActive(isCodelessRoom: false) }),
            receiveDirectory: { FileManager.default.temporaryDirectory },
            requiresVerification: { verification.requiresSASConfirmation },
            iceClient: UITestWaitingICEClient(),
            connectPairingSocket: { _ in
                // nonlocalized: test-only invariant failure, never rendered
                preconditionFailure("the waiting UI-test ICE client cannot open a socket")
            },
            pairingRoomHandle: pairingRoom)
    }

    #else
    /// In Release the answer is a constant the optimiser folds away, so the
    /// guarded work is unconditional and the argument means nothing.
    static let isActive = false

    /// false, and unreachable: a shipped launch never takes the acceptance arm
    /// of the residency gate, because `isActive` is already false beside it.
    static let allowsResidency = false

    /// nil, so a shipped launch always resolves the product's own keychain
    /// identity and cannot be pointed at a test one.
    static func makeTokenStore() -> TokenStore? { nil }

    /// nil, so a shipped launch always keeps its installation identity where
    /// the product keeps it, and cannot be pointed at a test one.
    static func makeInstallationIdentityStore() -> InstallationIdentityStoring? { nil }

    /// nil, so a shipped launch always keeps its stored-link keys where the
    /// product keeps them.
    static func makeStoredLinkKeyStore() -> StoredLinkKeyStore? { nil }

    /// nil, so a shipped launch always stages where the product stages.
    static func pendingUploadRoot() -> URL? { nil }

    /// nil, so a shipped launch always builds the real Device Inbox against the
    /// real keychain, defaults, journal directory and transport.
    @MainActor
    static func makeInboxController() -> InboxController? { nil }
    static let showsSubscriptions = false
    @MainActor
    static func makeSubscriptionModel(
        bearer: @escaping @MainActor () -> String?,
        refreshAccount: @escaping @MainActor () async -> Void
    ) -> AppleSubscriptionModel? { nil }

    /// nil, so a shipped launch can never be handed a link by its own arguments.
    static var launchDeepLink: URL? { nil }

    /// nil, so a shipped launch always evaluates the version policy against the
    /// version this bundle actually is, and cannot be told it is another one.
    static var appVersionOverride: AppVersion? { nil }

    /// false, so a shipped launch can never be told it already holds an account.
    static let isSignedIn = false
    static let answersAccountAPI = false
    static let stallsUpload = false
    static let failsUpload = false
    static func makeAccountTransport() -> URLSession? { nil }
    #endif

    #if DEBUG
    /// A deterministic code-creation path for UI tests. It changes no Release
    /// behavior and never opens a network connection: mint succeeds locally,
    /// then ICE lookup waits until the test process ends so the screen remains
    /// on the handoff state a person needs time to read and share.
    @MainActor
    static func makeRealtimeTextModel(verification: VerificationPreference) -> RealtimeTextSessionModel {
        RealtimeTextSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestWaitingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }

    @MainActor
    static func makeTerminalNearbyFileModel(
        verification: VerificationPreference
    ) -> RealtimeSessionModel? {
        guard showsTerminalNearby else { return nil }
        return RealtimeSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestFailingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }
    #endif
}

#if DEBUG
/// **That the shipped update action ran. Nothing about what it then did.**
///
/// The blocked screen's Update button calls the distribution seam's
/// `startUpdate()`, which in this build is Sparkle's own check. A UI test cannot
/// assert on what that check produces: the answer is an appcast fetch over the
/// public network, a signature verification and — on a machine where a newer
/// release exists — a download. All three are outside the product change under
/// test and any of them can fail for reasons that are not a defect.
///
/// So this observes the one fact that IS the claim: the button reached the
/// shipped action. It is written from inside `startUpdate()` after Sparkle's
/// check has been started, so a version of that function that stopped calling
/// Sparkle would still have to keep this line — which is why
/// `SupportedVersionSurfaceTests` also reads the function's body and requires
/// `updater.checkForUpdates()` to be there, unconditionally and outside every
/// compilation gate. Runtime evidence that the seam is reached; source evidence
/// that the seam is Sparkle.
///
/// **Absent from Release**, like every other type in this file: it is inside
/// `#if DEBUG`, so the shipped binary contains neither the object nor the call.
/// And inside a Debug build it publishes nothing unless `UITestMode.isActive`,
/// so a developer running the app from Xcode never renders the marker either.
@MainActor
final class UITestUpdateActionWitness: ObservableObject {
    static let shared = UITestUpdateActionWitness()

    @Published private(set) var wasReached = false

    private init() {}

    static func record() {
        guard UITestMode.isActive else { return }
        shared.wasReached = true
    }
}
#endif

#if DEBUG
/// Mints deterministically, and — for the expiry launch — mints a code that
/// really does run out while the suite is watching.
///
/// **The deadline is a real one, not a rendered string.** The countdown, the
/// moment the handoff is withdrawn and the moment the code becomes unusable are
/// all `PairingCodeExpiry`'s answer about `MintedCode.expiresAt`, so a fixture
/// that faked the expired STATE would prove the branch renders and nothing about
/// whether the product can reach it. This one hands over a genuine
/// seconds-from-now deadline and lets the real code path arrive there.
///
/// The replacement is long-lived and carries DIFFERENT digits, which is what
/// makes "regeneration produced a fresh code and a fresh deadline" an assertion
/// rather than a hope: a second mint that answered the same six digits would be
/// indistinguishable from no mint at all.
private final class UITestPairClient: PairCodeClient, @unchecked Sendable {
    private let lock = NSLock()
    private var minted = 0

    /// How long the FIRST code of an expiry launch lives.
    ///
    /// Long enough for the suite to read a counting-down clock and short enough
    /// that waiting it out is not what makes the run slow. It is also the only
    /// number here a person has to reason about, so it is named rather than
    /// spelled inline in an arithmetic expression.
    static let expiringCodeLifetime: TimeInterval = 12

    func mint(token: String) async throws -> MintedCode {
        if UITestMode.showsTerminalText { throw AccountError.network }
        lock.lock()
        minted += 1
        let attempt = minted
        lock.unlock()
        // nonlocalized: deterministic UI-test fixtures, never real codes
        let code = attempt == 1 ? "483920" : "517341"
        guard UITestMode.showsExpiringCode, attempt == 1 else {
            return MintedCode(code: code, expiresAt: 4_102_444_800)
        }
        let deadline = Date().addingTimeInterval(Self.expiringCodeLifetime)
        return MintedCode(code: code, expiresAt: Int64(deadline.timeIntervalSince1970))
    }
}

private struct UITestWaitingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig {
        try await Task.sleep(nanoseconds: 300_000_000_000)
        throw AccountError.network
    }
}

private struct UITestFailingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig { throw AccountError.network }
}
#endif

#if DEBUG
/// Answers the four account reads in process, for acceptance only.
///
/// The bodies are JSON literals, each VALIDATED by decoding it through the very
/// model the app will decode it into. The models carry no public memberwise
/// initializer, so this cannot construct them directly — but validating keeps
/// the property that matters: a required field added to `NativeUser` or
/// `UsageResponse` drops the entry, refuses the endpoint and fails the path
/// loudly, which is exactly how the two fields missing from the first version
/// were found. Everything else on the path is production —
/// the same `AccountClient`, the same decoding, the same `AccountSession`
/// states, the same views.
///
/// An `/api/` path this does not model is REFUSED rather than answered with an
/// empty 200, so a surface that reaches an endpoint the fixture does not
/// describe fails loudly instead of rendering a plausible blank.
final class UITestAccountTransport: URLProtocol {
    // nonlocalized: a bearer no server would accept
    static let bearer = "uitest-bearer"
    /// The account this fixture is signed in as.
    ///
    /// The second spelling carries a `/`, which `StoredObjectID.checked` refuses
    /// — so the Device Inbox cannot bind a keychain item, a defaults key or a
    /// journal directory to it and fails closed. It is a legal `NativeUser.id` as
    /// far as every other surface is concerned, which is the point: the account
    /// screen, the device list and the usage meters go on working, and only the
    /// receiver stops.
    // nonlocalized: acceptance fixture account ids, absent from Release
    static var accountID: String { UITestMode.hasUnusableAccount ? "acct/uitest" : "acct_uitest" }
    // nonlocalized: an acceptance fixture, not a real address
    static let email = "person@example.com"
    // nonlocalized: an acceptance fixture row, absent from Release
    static let thisDeviceName = "Studio Mac"
    // nonlocalized: an acceptance fixture row, absent from Release
    static let otherDeviceName = "Kitchen laptop"
    /// The bundle identity the purchase fixture answers for, and the two product
    /// identifiers it names.
    ///
    /// **They exist only inside `#if DEBUG`.** No shipped binary carries a
    /// product identifier: the App Store build learns them from the server, and
    /// `StoreKitLinkageTests` reads every shippable source to keep that true.
    // nonlocalized: acceptance fixture identifiers, absent from Release
    static let bundleID = "com.relayium.mac"
    // nonlocalized: acceptance fixture identifiers, absent from Release
    static let monthlyProductID = "uitest.subscription.month"
    // nonlocalized: acceptance fixture identifiers, absent from Release
    static let yearlyProductID = "uitest.subscription.year"

    /// JSON literals, each VALIDATED by decoding it through the very model the
    /// app will decode it into.
    ///
    /// The models carry no public memberwise initializer, so this cannot build
    /// them directly — but validating here keeps the property that matters: if a
    /// required field is added to `NativeUser` or `UsageResponse`, the decode
    /// below fails, the entry is dropped, the endpoint is refused, and the
    /// acceptance path fails loudly. A literal that merely looked plausible
    /// would instead render a stale account forever.
    private static var bodies: [String: Data] {
        var out: [String: Data] = [:]
        func offer<T: Decodable>(_ path: String, _ json: String, as type: T.Type) {
            let data = Data(json.utf8)
            guard (try? JSONDecoder().decode(type, from: data)) != nil else { return }
            out[path] = data
        }
        // Sign-in. Modelled so the ONE transition acceptance never drove — an
        // empty session becoming a real one through the form a person fills in —
        // can be driven without a server. Returns the 6-field login user shape,
        // not /api/me's 14-field one: a fixture that returned the wrong shape
        // here would prove the app tolerates a body no server sends.
        offer("/api/auth/native/login", """
            {"token":"\(bearer)","user":{"id":"\(accountID)","email":"\(email)",
            "displayName":"","hasPassword":true,"emailVerified":true,
            "linkedMethods":["password"]}}
            """, as: LoginSuccessBody.self)
        offer("/api/me", """
            {"user":{"id":"\(accountID)","email":"\(email)","displayName":"",
            "hasPassword":true,"emailVerified":true,"linkedMethods":["password"],
            "onlyOwnNodes":false,"planId":"free","subscriptionStatus":"none",
            "subscriptionEnd":0,"hasBilling":false,"scheduledPlanId":"","scheduledCycle":"","billingCycle":""}}
            """, as: MeResponse.self)
        offer("/api/me/usage", """
            {"period":"202608","resetsAt":0,
            "traffic":{"used":0,"cap":5368709120},
            "storage":{"used":0,"cap":1073741824},
            "plan":{"id":"free","name":"Free","storageBytes":1073741824,
            "trafficBytes":5368709120,"retentionSecs":604800,"priceMonthly":0,
            "priceYearly":0,"isTop":false,"subscriptionStatus":"none",
            "subscriptionEnd":0,"billingCycle":"","scheduledPlanId":"",
            "scheduledPlanName":"","scheduledCycle":""}}
            """, as: UsageResponse.self)
        // Two rows, one of them this app's own: a list with a single anonymous
        // entry cannot show that Revoke is per-row, and "Revoke" alone is the
        // same word on every row — which is right to look at and useless to
        // hear. `AccountDevice` decodes the server's PascalCase keys.
        // Both arms of the server-observed address, side by side: the server has
        // one for this device and none for the other. A fixture that gave every
        // row an address would leave the "no address, no sentence" half of the
        // contract with no runtime evidence at all, which is the half that would
        // otherwise ship as an empty "last address" on a row nobody has used.
        offer("/api/devices", """
            {"devices":[
            {"ID":"dev_this","Name":"\(thisDeviceName)","CreatedAt":1750000000,
            "LastSeenAt":1754600000,"Kind":"app","Current":true,"LastIP":"203.0.113.9"},
            {"ID":"dev_other","Name":"\(otherDeviceName)","CreatedAt":1740000000,
            "LastSeenAt":1754000000,"Kind":"cli","Current":false,"LastIP":""}]}
            """, as: DeviceListResponse.self)
        // One row, in the state a fresh launch is genuinely in: the key for an
        // object uploaded from somewhere else was never on this device, so the
        // link cannot be rebuilt here. That is the row's honest arm, and the one
        // where no hand-off may be offered at all.
        // The purchase catalog, in the shape the server answers with: two live
        // products for THIS bundle, ordered by the deployment's own tier rank.
        // Validated through the very model the app decodes it into, like every
        // entry here, so a required field added to `AppleProductCatalog` drops
        // the entry and fails the path loudly.
        offer("/api/billing/apple/catalog", """
            {"bundleId":"\(bundleID)",
            "products":[
            {"productId":"\(monthlyProductID)","planId":"pro","planName":"Pro",
            "cycle":"monthly","sortOrder":20,
            "storageBytes":5368709120,"trafficBytes":107374182400},
            {"productId":"\(yearlyProductID)","planId":"pro","planName":"Pro",
            "cycle":"yearly","sortOrder":20,
            "storageBytes":5368709120,"trafficBytes":107374182400}],
            "purchase":{"allowed":\(UITestMode.blocksSubscription ? "false" : "true"),
            "blockedBy":"\(UITestMode.blocksSubscription ? "stripe" : "")"},
            "purchases":{"enabled":true,"reason":""}}
            """, as: AppleProductCatalog.self)
        // A purchase token exists only after the server has durably acquired
        // billing authority and created its attempt. The StoreKit fixture must
        // therefore cross the same dispatch boundary as the shipping model.
        offer("/api/billing/apple/purchase-dispatch", """
            {"appAccountToken":"9b64af11-82b1-4fd5-bcc8-7e909465b45a",
            "attemptId":"attempt_uitest"}
            """, as: ApplePurchaseDispatch.self)
        // The transaction intake completes a purchase dispatched by the
        // server-authorized orchestration above.
        offer("/api/billing/apple/transaction", """
            {"applied":true,"planId":"pro","status":"active",
            "expiresAt":4102444800,"provider":"apple",
            "currentProductId":"\(monthlyProductID)",
            "autoRenewProductId":"\(monthlyProductID)","renewalAt":4102444800,
            "dispatchPending":false,"dispatchResolved":true}
            """, as: AppleTransactionResult.self)
        // Sign-out is a POST with no body. Modelled because it is the one way
        // out of a signed-in launch, and an unmodelled endpoint is refused —
        // which would have made a failed sign-out look like a product defect.
        out["/api/auth/logout"] = Data("{}".utf8)
        // Two objects, one of each arm. A row whose key is on this device can be
        // handed on; a row whose key never arrived cannot, and must say so. One
        // row alone would prove only whichever arm it happened to be in.
        offer("/api/files", """
            {"files":[
            {"id":"obj_uitest","size":1536,"createdAt":1754000000,
            "expiresAt":0,"burnAfterRead":false,"downloaded":false,
            "downloadCount":0},
            {"id":"obj_nokey","size":4096,"createdAt":1753000000,
            "expiresAt":0,"burnAfterRead":false,"downloaded":false,
            "downloadCount":0}]}
            """, as: StoredFileListResponse.self)
        return out
    }


    /// The three-step resumable upload, answered in process.
    ///
    /// A stored send is the one flow whose completion surface — the generated
    /// link, its Copy and Share, and Send another — cannot be reached without a
    /// server saying yes. Modelling it keeps the encryption, chunking, manifest
    /// and link construction as production code; only the transport is local.
    /// `received` is derived from the request's own `Content-Range`, so the
    /// uploader's resume arithmetic is exercised rather than short-circuited.
    private func uploadResponse(for url: URL, method: String) -> (Int, Data)? {
        let path = url.path
        if path == "/api/files/obj_uitest/meta", let body = Self.downloadMeta() {
            return (200, body)
        }
        if path == "/api/files/obj_uitest/blob", let body = Self.downloadBlob() {
            return (200, body)
        }
        if path == "/api/uploads", method == "POST" {
            return (200, Data(#"{"uploadId":"up_uitest","chunkSize":1048576}"#.utf8))
        }
        guard path.hasPrefix("/api/uploads/up_uitest") else { return nil }
        if path.hasSuffix("/finalize"), method == "POST" {
            // A far-future expiry, so the completion surface never renders an
            // already-expired link.
            return (200, Data(#"{"id":"obj_uitest","expiresAt":4102444800}"#.utf8))
        }
        if method == "PATCH" {
            // Held open, never answered, so the task stays in flight long enough
            // for a person to press Cancel. `stopLoading` is what ends it, which
            // is exactly what cancelling the upload triggers — so the product
            // path under test is the real one.
            if UITestMode.stallsUpload { Thread.sleep(forTimeInterval: 600) }
            // A server-side failure mid-transfer, which is the one an upload can
            // actually recover from: the staged bytes are still here, so the
            // product should offer to carry on rather than start over.
            if UITestMode.failsUpload { return (500, Data(#"{"error":"server"}"#.utf8)) }
            let range = request.value(forHTTPHeaderField: "Content-Range") ?? ""
            let received = Self.receivedAfter(contentRange: range)
            return (200, Data("{\"received\":\(received)}".utf8))
        }
        if method == "GET" { return (200, Data(#"{"received":0}"#.utf8)) }
        return nil
    }

    /// `bytes from-to/total` → `to + 1`, the byte count the server would hold
    /// after committing exactly what this request carried.
    static func receivedAfter(contentRange: String) -> Int {
        guard let slash = contentRange.firstIndex(of: "/"),
              let dash = contentRange.firstIndex(of: "-") else { return 0 }
        let to = contentRange[contentRange.index(after: dash)..<slash]
        return (Int(to) ?? -1) + 1
    }


    /// A stored object this device can actually decrypt.
    ///
    /// The meta and blob below are produced by the PRODUCTION encryptor from a
    /// fixed key, so the app's own decryptor has to accept them: if the manifest
    /// serialization, frame format or key derivation drifts, the download fails
    /// loudly instead of a fixture quietly agreeing with itself. The key is a
    /// literal 32 bytes and the link that carries it is built from the same
    /// value, which is what makes the received result verifiable.
    // nonlocalized: 32 bytes of 0x11, base64url — an acceptance key, never real
    static let downloadKeyB64url = "ERERERERERERERERERERERERERERERERERERERERERE"
    static let downloadFileName = "brief.txt" // nonlocalized: an acceptance fixture
    private static let downloadPlaintext = [UInt8](repeating: 0x52, count: 1_536)

    private static var downloadKey: [UInt8] {
        // base64url → bytes, the same decoding the link parser performs.
        var s = downloadKeyB64url.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return [UInt8](Data(base64Encoded: s) ?? Data())
    }

    private static func downloadMeta() -> Data? {
        let manifest = StoredManifest(files: [
            ManifestFile(name: downloadFileName, size: downloadPlaintext.count),
        ])
        guard let ct = try? encryptManifest(key: downloadKey, manifest) else { return nil }
        // Hand-written, like the other fixture bodies: `StoredFileMeta` carries
        // no public memberwise initializer, and validating by decoding through
        // it keeps the drift check the literals elsewhere rely on.
        let json = """
            {"encManifest":"\(Data(ct).base64EncodedString())",
            "size":\(downloadPlaintext.count),"burnAfterRead":false,
            "expiresAt":4102444800}
            """
        let data = Data(json.utf8)
        guard (try? JSONDecoder().decode(StoredFileMeta.self, from: data)) != nil else {
            return nil
        }
        return data
    }

    private static func downloadBlob() -> Data? {
        let encryptor = ChunkEncryptor(
            key: downloadKey,
            sources: [DataSource(name: downloadFileName, bytes: downloadPlaintext)])
        var out = Data()
        while let frame = ((try? encryptor.next()) ?? nil) { out.append(frame) }
        return out.isEmpty ? nil : out
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.path.hasPrefix("/api/") ?? false
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let url = request.url,
           let (status, body) = uploadResponse(for: url, method: request.httpMethod ?? "GET") {
            return respond(url: url, status: status, body: body)
        }
        guard let url = request.url, let body = Self.bodies[url.path] else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        respond(url: url, status: 200, body: body)
    }

    private func respond(url: URL, status: Int, body: Data) {
        let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
