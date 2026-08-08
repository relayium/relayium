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
    /// Holds a chunk upload open so the in-flight surface can be driven.
    // nonlocalized: a test-only launch argument, absent from Release
    static let stallUploadArgument = "--relayium-ui-testing-stall-upload"
    static let stallsUpload = ProcessInfo.processInfo.arguments.contains(stallUploadArgument)

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





    /// Builds a deterministic failed Nearby file task, so the suite can prove the
    /// retained terminal surface still exposes the route back to the roster.
    // nonlocalized: a test-only launch argument, absent from Release
    static let terminalNearbyArgument = "--relayium-ui-testing-terminal-nearby"
    static let showsTerminalNearby = ProcessInfo.processInfo.arguments.contains(
        terminalNearbyArgument)

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

    /// Holds the text pairing model on a deterministic terminal failure, so the
    /// suite can verify that cleanup — not a second start path — owns the page.
    // nonlocalized: a test-only launch argument, absent from Release
    static let terminalTextArgument = "--relayium-ui-testing-terminal-text"
    static let showsTerminalText = ProcessInfo.processInfo.arguments.contains(
        terminalTextArgument)

    /// Holds the text pairing surface on its generated code.
    ///
    /// The pairing-code handoff is the flow the owner's 2026-08-07 review found
    /// broken — creating a text code jumped to Nearby and produced no visible
    /// join link — and iOS had no runtime evidence for it at all while macOS
    /// did. Minting succeeds locally and the ICE lookup then waits for the rest
    /// of the process, so the screen stays on the handoff state a person needs
    /// time to read and share. No network call is made.
    // nonlocalized: a test-only launch argument, absent from Release
    static let generatedTextCodeArgument = "--relayium-ui-testing-text-code"
    static let showsGeneratedTextCode = ProcessInfo.processInfo.arguments.contains(
        generatedTextCodeArgument)

    @MainActor
    static func makeRealtimeTextModel(
        verification: VerificationPreference
    ) -> RealtimeTextSessionModel? {
        guard showsGeneratedTextCode || showsTerminalText else { return nil }
        return RealtimeTextSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestWaitingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
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

    /// nil, so a shipped launch always keeps its stored-link keys where the
    /// product keeps them.
    static func makeStoredLinkKeyStore() -> StoredLinkKeyStore? { nil }

    /// nil, so a shipped launch always stages where the product stages.
    static func pendingUploadRoot() -> URL? { nil }

    /// false, so a shipped launch can never be told it already holds an account.
    static let isSignedIn = false
    static let stallsUpload = false
    /// false, so a shipped launch always mints a real code over the network.
    static let showsGeneratedTextCode = false
    static let showsTerminalText = false
    static let showsTerminalNearby = false
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

#if DEBUG
/// Mints deterministically and never opens a connection.
private struct UITestPairClient: PairCodeClient {
    func mint(token: String) async throws -> MintedCode {
        if UITestMode.showsTerminalText { throw AccountError.network }
        return MintedCode(code: "483920", expiresAt: 4_102_444_800)
    }
}

/// Fails immediately, so a Nearby task reaches its terminal state at once.
private struct UITestFailingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig { throw AccountError.network }
}

/// Waits for the rest of the process, so the generated-code screen holds.
private struct UITestWaitingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig {
        try await Task.sleep(nanoseconds: 300_000_000_000)
        throw AccountError.network
    }
}
#endif
