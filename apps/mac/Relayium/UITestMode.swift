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
/// The five destinations, the settings scene and all nine languages are the real
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
    // nonlocalized: a test-only launch argument, absent from Release
    static let signedInArgument = "--relayium-ui-testing-signed-in"
    static let isSignedIn = ProcessInfo.processInfo.arguments.contains(signedInArgument)

    /// A token store already holding the acceptance bearer, so `restore()` takes
    /// its normal “found a credential” path rather than a special one.
    static func makeSignedInTokenStore() -> TokenStore {
        let store = InMemoryTokenStore()
        try? store.save(UITestAccountTransport.bearer)
        return store
    }

    static func makeAccountTransport() -> URLSession? {
        guard isSignedIn else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UITestAccountTransport.self]
        return URLSession(configuration: configuration)
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
    #else
    /// In Release the answer is a constant the optimiser folds away, so the
    /// guarded work is unconditional and the argument means nothing.
    static let isActive = false

    /// nil, so a shipped launch always resolves the product's own keychain
    /// identity and cannot be pointed at a test one.
    static func makeTokenStore() -> TokenStore? { nil }

    /// false, so a shipped launch can never be told it already holds an account.
    static let isSignedIn = false
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
    static func makeTerminalNearbyFileModel(verification: VerificationPreference) -> RealtimeSessionModel {
        RealtimeSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestFailingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }
    #endif
}

#if DEBUG
private struct UITestPairClient: PairCodeClient {
    func mint(token: String) async throws -> MintedCode {
        if UITestMode.showsTerminalText { throw AccountError.network }
        return MintedCode(code: "483920", expiresAt: 4_102_444_800)
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
    // nonlocalized: an acceptance fixture, not a real address
    static let email = "person@example.com"
    // nonlocalized: an acceptance fixture row, absent from Release
    static let thisDeviceName = "Studio Mac"
    // nonlocalized: an acceptance fixture row, absent from Release
    static let otherDeviceName = "Kitchen laptop"

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
        offer("/api/me", """
            {"user":{"id":"acct_uitest","email":"\(email)","displayName":"",
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
        offer("/api/devices", """
            {"devices":[
            {"ID":"dev_this","Name":"\(thisDeviceName)","CreatedAt":1750000000,
            "LastSeenAt":1754600000,"Kind":"app","Current":true},
            {"ID":"dev_other","Name":"\(otherDeviceName)","CreatedAt":1740000000,
            "LastSeenAt":1754000000,"Kind":"cli","Current":false}]}
            """, as: DeviceListResponse.self)
        // One row, in the state a fresh launch is genuinely in: the key for an
        // object uploaded from somewhere else was never on this device, so the
        // link cannot be rebuilt here. That is the row's honest arm, and the one
        // where no hand-off may be offered at all.
        // Sign-out is a POST with no body. Modelled because it is the one way
        // out of a signed-in launch, and an unmodelled endpoint is refused —
        // which would have made a failed sign-out look like a product defect.
        out["/api/auth/logout"] = Data("{}".utf8)
        offer("/api/files", """
            {"files":[{"id":"obj_uitest","size":1536,"createdAt":1754000000,
            "expiresAt":0,"burnAfterRead":false,"downloaded":false,
            "downloadCount":0}]}
            """, as: StoredFileListResponse.self)
        return out
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.path.hasPrefix("/api/") ?? false
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let body = Self.bodies[url.path] else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif
