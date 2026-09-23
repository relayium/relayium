import Combine
import Foundation

/// How this iOS build reached the device.
///
/// It decides the ONE update destination the app may offer, and that is the
/// whole point of distinguishing them: a TestFlight tester and a public App
/// Store customer can obtain different builds, and telling the public to
/// update to a build only internal testers can install is a sentence nobody
/// can act on.
public enum IOSDistributionChannel: String, Equatable, Sendable {
    /// Installed from the public App Store.
    case appStore
    /// Installed through TestFlight.
    case testFlight
    /// Xcode, the Simulator, an ad-hoc or development-signed install, or
    /// anything this build cannot identify. Offers no update, ever: there is
    /// no store this build could be updated from.
    case development

    /// Classify from the three facts an iOS app can read about itself without
    /// StoreKit, without a network request and without prompting the user.
    ///
    ///  - A development, ad-hoc or enterprise install carries
    ///    `embedded.mobileprovision`; App Store and TestFlight installs are
    ///    re-signed by Apple and carry none.
    ///  - Of the two Apple-signed kinds, TestFlight's receipt is named
    ///    `sandboxReceipt` and the App Store's `receipt`.
    ///
    /// Anything else — no receipt URL, an unfamiliar name, the Simulator — is
    /// `.development`, which is the direction that offers nothing. Misreading a
    /// TestFlight build as the App Store would offer a public build a tester
    /// may already be ahead of; misreading anything as `.development` only
    /// withholds an offer.
    public static func classify(receiptFileName: String?,
                                hasEmbeddedProvisioningProfile: Bool,
                                isSimulator: Bool) -> IOSDistributionChannel {
        if isSimulator || hasEmbeddedProvisioningProfile { return .development }
        switch receiptFileName {
        case "sandboxReceipt": return .testFlight
        case "receipt": return .appStore
        default: return .development
        }
    }
}

/// **What the product says about iOS builds, as served at
/// `/api/client-policy/ios`.**
///
/// Two requirement fields and two AVAILABILITY fields, and — like the macOS
/// document — no URL of any kind. Where an update comes from is compiled into
/// the app (`AppEnvironment.iosAppStoreURL` / `iosTestFlightURL`); a document
/// fetched over the network can only decide whether the app mentions one.
///
/// The availability fields are what keep the mechanism honest. A version is
/// offered on a channel only when the document says that channel can deliver
/// it, and a requirement is never presented on a channel that cannot deliver a
/// build satisfying it. An empty availability field means "nothing verified
/// for this channel", which offers nothing.
public struct IOSVersionPolicy: Equatable, Sendable {
    public let revision: Int
    /// Below this, the app says an update is required — only where one can be
    /// obtained. Never a lockout: see `IOSVersionSupportState`.
    public let minimumSupported: AppVersion
    /// Below this, the app recommends an update — only where one can be obtained.
    public let recommended: AppVersion
    /// The newest version publicly available on the App Store, or nil.
    public let appStore: AppVersion?
    /// The newest version available to this app's TestFlight testers, or nil.
    public let testFlight: AppVersion?

    public init(revision: Int, minimumSupported: AppVersion, recommended: AppVersion,
                appStore: AppVersion?, testFlight: AppVersion?) {
        self.revision = revision
        self.minimumSupported = minimumSupported
        self.recommended = recommended
        self.appStore = appStore
        self.testFlight = testFlight
    }

    public static let schema = 1
    public static let maxDocumentBytes = 8 * 1024
    public static let maxPolicyRevision = 1_000_000_000

    /// **The policy in force with no valid served or cached document.**
    ///
    /// It requires nothing, recommends nothing and offers nothing. So an
    /// outage, a malformed document or a cold start can never produce a
    /// requirement, a recommendation or an update button — failing open is
    /// not a rule the code has to remember, it is what this value says.
    ///
    /// Its revision is the replay barrier a fresh install starts from.
    public static let embeddedFloor = IOSVersionPolicy(
        revision: 1,
        minimumSupported: AppVersion("0.0.0")!,
        recommended: AppVersion("0.0.0")!,
        appStore: nil,
        testFlight: nil)

    public func available(on channel: IOSDistributionChannel) -> AppVersion? {
        switch channel {
        case .appStore: return appStore
        case .testFlight: return testFlight
        case .development: return nil
        }
    }
}

public enum IOSVersionPolicyError: Error, Equatable, Sendable {
    case malformed
    case tooLarge
    case unsupportedSchema(Int)
    case unreadableVersion(String)
    /// `minimum > recommended`, or a requirement above every build any
    /// channel can deliver — a document that would raise a floor nobody can
    /// meet.
    case inconsistent
    case invalidRevision(Int)
    case replayedRevision(served: Int, known: Int)
    case equivocatingRevision(Int)
}

extension IOSVersionPolicy {
    /// Read a served or cached document, refusing everything the app must not
    /// act on. Unknown keys are ignored; nothing here reads a URL.
    public static func decode(_ data: Data) throws -> IOSVersionPolicy {
        guard data.count <= maxDocumentBytes else { throw IOSVersionPolicyError.tooLarge }
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw IOSVersionPolicyError.malformed
        }
        guard let announced = integer(root["schema"]) else { throw IOSVersionPolicyError.malformed }
        guard announced == schema else { throw IOSVersionPolicyError.unsupportedSchema(announced) }
        guard let ios = root["ios"] as? [String: Any] else { throw IOSVersionPolicyError.malformed }

        func version(_ key: String) throws -> AppVersion {
            guard let text = ios[key] as? String else { throw IOSVersionPolicyError.malformed }
            guard let value = AppVersion(text) else { throw IOSVersionPolicyError.unreadableVersion(text) }
            return value
        }
        /// Required as a key, empty meaning "nothing verified". A missing key
        /// is malformed rather than read as empty, so a truncated document
        /// cannot quietly withdraw an availability.
        func availability(_ key: String) throws -> AppVersion? {
            guard let text = ios[key] as? String else { throw IOSVersionPolicyError.malformed }
            if text.isEmpty { return nil }
            guard let value = AppVersion(text) else { throw IOSVersionPolicyError.unreadableVersion(text) }
            return value
        }

        guard let revision = integer(ios["policyRevision"]) else { throw IOSVersionPolicyError.malformed }
        guard revision >= 1, revision <= maxPolicyRevision else {
            throw IOSVersionPolicyError.invalidRevision(revision)
        }
        let minimum = try version("minimumSupportedVersion")
        let recommended = try version("recommendedVersion")
        let appStore = try availability("appStoreVersion")
        let testFlight = try availability("testFlightVersion")
        guard minimum <= recommended else { throw IOSVersionPolicyError.inconsistent }

        // **No requirement above what can be obtained.** A requirement that
        // no channel can deliver is a floor raised out of nothing; the whole
        // document is refused and the device stays where it was.
        let zero = AppVersion("0")!
        let newestObtainable = [appStore, testFlight].compactMap { $0 }.max()
        if recommended > zero {
            guard let newestObtainable, recommended <= newestObtainable else {
                throw IOSVersionPolicyError.inconsistent
            }
        }
        return IOSVersionPolicy(revision: revision, minimumSupported: minimum,
                                recommended: recommended, appStore: appStore,
                                testFlight: testFlight)
    }

    /// May `served` replace the policy this device already holds?
    ///
    /// Same three rules as the macOS policy: a lower revision is a replay; the
    /// same revision must be the same document; a higher one may tighten or
    /// relax.
    public static func admit(_ served: IOSVersionPolicy, over known: IOSVersionPolicy?,
                             floor: IOSVersionPolicy = .embeddedFloor) throws {
        let effective: IOSVersionPolicy
        if let known, known.revision > floor.revision {
            effective = known
        } else if let known, known.revision == floor.revision, known != floor {
            // One revision naming two documents before anything was served.
            // Nothing at that revision is admitted; a higher one still is.
            guard served.revision > floor.revision else {
                throw IOSVersionPolicyError.equivocatingRevision(served.revision)
            }
            return
        } else {
            effective = floor
        }
        guard served.revision >= effective.revision else {
            throw IOSVersionPolicyError.replayedRevision(served: served.revision,
                                                         known: effective.revision)
        }
        if served.revision == effective.revision, served != effective {
            throw IOSVersionPolicyError.equivocatingRevision(served.revision)
        }
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number as? Int
    }
}

/// What this build is, against the policy in force, on the channel it came from.
///
/// **There is no blocking state.** `.updateRequired` is a persistent notice
/// with an update action, not a lockout: whether a below-minimum iOS build
/// should stop working is the owner's decision (C02), and until it is made the
/// mechanism must not be able to take the product away from anybody.
public enum IOSVersionSupportState: Equatable, Sendable {
    /// Nothing to offer: current, or no newer build on this channel.
    case current
    /// A newer build is available on this channel; nothing is required of it.
    case updateAvailable(target: AppVersion)
    case updateRecommended(target: AppVersion)
    case updateRequired(target: AppVersion)
    /// This build could not read its own version. Nothing is compared.
    case unknown

    public var target: AppVersion? {
        switch self {
        case let .updateAvailable(t), let .updateRecommended(t), let .updateRequired(t): return t
        case .current, .unknown: return nil
        }
    }

    /// **The whole decision.**
    ///
    /// Ordering: marketing versions only, component-wise (`AppVersion`). The
    /// build number is shown, never compared — every distributed iOS candidate
    /// takes a new marketing version, so two builds of one marketing version
    /// are not a case the policy speaks about.
    ///
    /// Every non-`current` answer names a target that THIS channel can deliver
    /// and that is newer than this build. A requirement or recommendation with
    /// no such target degrades to `.current`: a sentence without an action
    /// would ask the user to do something they cannot.
    public static func evaluate(current: AppVersion?, channel: IOSDistributionChannel,
                                policy: IOSVersionPolicy) -> IOSVersionSupportState {
        guard let current else { return .unknown }
        guard let available = policy.available(on: channel), available > current else {
            return .current
        }
        if current < policy.minimumSupported, available >= policy.minimumSupported {
            return .updateRequired(target: available)
        }
        if current < policy.recommended, available >= policy.recommended {
            return .updateRecommended(target: available)
        }
        return .updateAvailable(target: available)
    }
}

public protocol IOSVersionPolicySource: Sendable {
    func fetch() async throws -> Data
}

/// `GET /api/client-policy/ios`, from the app's own origin. Needs no account:
/// the request carries no bearer, no cookie and no identifier.
public struct HTTPIOSVersionPolicySource: IOSVersionPolicySource {
    let url: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        url = baseURL.appendingPathComponent("api")
            .appendingPathComponent("client-policy")
            .appendingPathComponent("ios")
        self.session = session
    }

    public func fetch() async throws -> Data {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = false
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw IOSVersionPolicyError.malformed
        }
        guard data.count <= IOSVersionPolicy.maxDocumentBytes else { throw IOSVersionPolicyError.tooLarge }
        return data
    }
}

/// The version support card's model.
///
/// Rules, each one a way this could go wrong:
///  - **It starts from the cache, synchronously**, so the first render is
///    already the last known answer.
///  - **A failed refresh changes nothing.** Offline, a 500, a malformed or a
///    replayed document: the state stays where it was, and since no state
///    blocks anything, the worst a failure can do is keep an old sentence.
///  - **A cached document decides for at most `maxCacheAge`**; past it, or
///    stamped in the future, the embedded floor — which offers nothing — decides.
///  - **The cached document is the replay barrier at any age.**
@MainActor
public final class IOSVersionSupportModel: ObservableObject {
    public static let maxCacheAge: TimeInterval = 7 * 24 * 60 * 60

    @Published public private(set) var state: IOSVersionSupportState
    @Published public private(set) var lastRefreshFailed = false

    public let currentVersion: AppVersion?
    public let currentBuild: String?
    public let channel: IOSDistributionChannel
    private let store: SupportedVersionPolicyStore
    private let source: IOSVersionPolicySource
    private let now: @Sendable () -> Date
    private var refreshing = false

    public init(currentVersion: AppVersion?, currentBuild: String?,
                channel: IOSDistributionChannel,
                store: SupportedVersionPolicyStore,
                source: IOSVersionPolicySource,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.currentVersion = currentVersion
        self.currentBuild = currentBuild
        self.channel = channel
        self.store = store
        self.source = source
        self.now = now
        let cached = Self.cachedPolicy(store: store, now: now())
        state = IOSVersionSupportState.evaluate(current: currentVersion, channel: channel,
                                                policy: cached ?? .embeddedFloor)
    }

    /// Fetch, validate, admit, cache, re-evaluate. Every failure is absorbed.
    /// Overlapping calls collapse into the one already running.
    public func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            let document = try await source.fetch()
            let policy = try IOSVersionPolicy.decode(document)
            try IOSVersionPolicy.admit(policy, over: Self.acceptedPolicy(store: store))
            store.save(SupportedVersionCacheEntry(document: document, fetchedAt: now()))
            lastRefreshFailed = false
            state = IOSVersionSupportState.evaluate(current: currentVersion, channel: channel,
                                                    policy: policy)
        } catch {
            lastRefreshFailed = true
        }
    }

    private static func cachedPolicy(store: SupportedVersionPolicyStore, now: Date) -> IOSVersionPolicy? {
        guard let entry = store.load() else { return nil }
        let age = now.timeIntervalSince(entry.fetchedAt)
        guard age >= 0, age <= maxCacheAge else { return nil }
        return try? IOSVersionPolicy.decode(entry.document)
    }

    private static func acceptedPolicy(store: SupportedVersionPolicyStore) -> IOSVersionPolicy? {
        guard let entry = store.load() else { return nil }
        return try? IOSVersionPolicy.decode(entry.document)
    }
}

/// The iOS policy cache, in its own `UserDefaults` keys — never the macOS
/// policy's, so the two documents can never be read as each other.
public struct UserDefaultsIOSVersionPolicyStore: SupportedVersionPolicyStore {
    // nonlocalized: defaults keys, never displayed
    static let documentKey = "iosVersionPolicy.document"
    // nonlocalized: defaults keys, never displayed
    static let fetchedAtKey = "iosVersionPolicy.fetchedAt"

    let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func load() -> SupportedVersionCacheEntry? {
        guard let document = defaults.data(forKey: Self.documentKey),
              let stamp = defaults.object(forKey: Self.fetchedAtKey) as? Double else { return nil }
        return SupportedVersionCacheEntry(document: document,
                                          fetchedAt: Date(timeIntervalSince1970: stamp))
    }

    public func save(_ entry: SupportedVersionCacheEntry) {
        defaults.set(entry.document, forKey: Self.documentKey)
        defaults.set(entry.fetchedAt.timeIntervalSince1970, forKey: Self.fetchedAtKey)
    }
}
