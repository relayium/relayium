import Foundation
import RelayiumAppKit
import RelayiumKit

/// Keeps simulator UI acceptance from joining the public Nearby rendezvous.
///
/// The launch argument is absent from Release builds: the shipped binary folds
/// this to `false`, so reachability cannot be disabled by a user or a link.
enum UITestMode {
    #if DEBUG
    static let isActive = ProcessInfo.processInfo.arguments.contains(
        "--relayium-ui-testing") // nonlocalized: test-only launch argument

    /// Whether this launch should leave one deterministic file where the system
    /// document browser can reach it.
    ///
    /// It stages a file and nothing else. The picker the test then drives, the
    /// security scope it hands back, the expansion, the limits and the rendered
    /// pending row are all production code — the alternative, injecting a
    /// selection directly, would prove only that a list renders what it is
    /// given. A separate argument from `isActive` so the ordinary acceptance
    /// paths never write into the container at all.
    // nonlocalized: a test-only launch argument, absent from Release
    static let pendingFixtureArgument = "--relayium-ui-testing-pending-fixture"
    static let stagesPendingFixture = ProcessInfo.processInfo.arguments.contains(
        pendingFixtureArgument)


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

    /// Holds Nearby in the state a destination failure leaves behind: off,
    /// with no pause anywhere.
    ///
    /// It asks the launch to skip both the pause the other acceptance paths
    /// take and the residency a shipped launch starts — which is not a fourth
    /// state invented for a test, but exactly the one a model that never became
    /// resident is already in.
    // nonlocalized: a test-only launch argument, absent from Release
    static let offReceivingArgument = "--relayium-ui-testing-off-receiving"
    static let showsOffReceiving = ProcessInfo.processInfo.arguments.contains(
        offReceivingArgument)

    /// 1,536 bytes, so the size the row must render is an exact, unambiguous
    /// `1.5 KB` rather than a value that depends on rounding.
    static let pendingFixtureName = "Relayium product brief.txt" // nonlocalized: a test fixture
    private static let pendingFixtureByteCount = 1_536

    /// The keychain an acceptance launch may use — never the item the installed
    /// product wrote, and emptied before the session restores.
    ///
    /// Without this the suite reads whatever account this machine is in, so a
    /// signed-out assertion passes or fails by the workstation rather than by
    /// the product. Emptied on every launch as well as isolated, so one path
    /// cannot inherit an account another path established.
    static func makeTokenStore() -> TokenStore? {
        guard isActive else { return nil }
        if isSignedIn { return makeSignedInTokenStore() }
        let store = AppEnvironment.makeTokenStore(
            AppEnvironment.isolatedKeychainConfiguration())
        try? store.clear()
        return store
    }

    /// Rewritten on every launch that asks for it, so a container surviving
    /// from an earlier run cannot leave a stale name or length behind.
    static func stagePendingFixture() {
        guard stagesPendingFixture,
              let documents = try? FileManager.default.url(
                for: .documentDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true) else { return }
        try? Data(repeating: 0x52, count: pendingFixtureByteCount).write(
            to: documents.appendingPathComponent(pendingFixtureName), options: .atomic)
    }
    #else
    static let isActive = false
    /// Folded to a constant, so a shipped launch always takes the residency
    /// branch and no argument can hold this device out of the room.
    static let showsOffReceiving = false

    /// In Release the whole idea is absent: the optimiser folds this to an
    /// empty call, and no argument can reach the container.
    static func stagePendingFixture() {}

    /// nil, so a shipped launch always resolves the product's own keychain
    /// identity and cannot be pointed at a test one.
    static func makeTokenStore() -> TokenStore? { nil }

    /// false, so a shipped launch can never be told it already holds an account.
    static let isSignedIn = false
    static func makeAccountTransport() -> URLSession? { nil }

    #endif
}

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
