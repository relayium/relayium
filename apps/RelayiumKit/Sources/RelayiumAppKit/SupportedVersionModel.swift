import Combine
import Foundation

/// Where the served policy document comes from.
///
/// A protocol so the model's failure behaviour — an outage, a 500, a body that
/// is not JSON, a body that is too large — is drivable from a test without a
/// network, and so nothing but the shipped implementation can decide the URL.
public protocol SupportedVersionPolicySource: Sendable {
    func fetch() async throws -> Data
}

/// The one URL this product reads its policy from, built from the app's own
/// production origin rather than from anything the document says.
public struct HTTPSupportedVersionPolicySource: SupportedVersionPolicySource {
    /// `https://relayium.com/apps/macos/client-policy.json`, published from
    /// `web/native-client-policy.json`.
    public static let productionURL = AppEnvironment.productionBaseURL
        .appendingPathComponent("apps")
        .appendingPathComponent("macos")
        .appendingPathComponent("client-policy.json")

    let url: URL
    let session: URLSession

    public init(url: URL = HTTPSupportedVersionPolicySource.productionURL,
                session: URLSession = .shared) {
        self.url = url
        self.session = session
    }

    public func fetch() async throws -> Data {
        var request = URLRequest(url: url)
        // Never the URL cache. This document decides whether the app runs, and
        // a stale entry served by the system cache would be a second, invisible
        // cache with none of the bounds the one below has.
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw SupportedVersionPolicyError.malformed
        }
        guard data.count <= SupportedVersionPolicy.maxDocumentBytes else {
            throw SupportedVersionPolicyError.tooLarge
        }
        return data
    }
}

/// The last document this device successfully read, and when it read it.
///
/// The RAW document is cached rather than the decoded policy, and that is
/// deliberate: a cached entry is re-decoded against the CURRENT build's floor
/// every time it is read, so a document that was acceptable to an older build
/// cannot survive into one that refuses it.
public struct SupportedVersionCacheEntry: Equatable, Sendable {
    public let document: Data
    public let fetchedAt: Date

    public init(document: Data, fetchedAt: Date) {
        self.document = document
        self.fetchedAt = fetchedAt
    }
}

public protocol SupportedVersionPolicyStore: Sendable {
    func load() -> SupportedVersionCacheEntry?
    func save(_ entry: SupportedVersionCacheEntry)
}

/// The shipped cache: two `UserDefaults` values in the app's own domain.
public struct UserDefaultsSupportedVersionPolicyStore: SupportedVersionPolicyStore {
    // nonlocalized: defaults keys, never displayed
    static let documentKey = "supportedVersionPolicy.document"
    // nonlocalized: defaults keys, never displayed
    static let fetchedAtKey = "supportedVersionPolicy.fetchedAt"

    let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> SupportedVersionCacheEntry? {
        guard let document = defaults.data(forKey: Self.documentKey) else { return nil }
        // `object(forKey:)` rather than `double(forKey:)`: an absent key reads as
        // 0.0, which is 1970 — an entry the age bound would then reject as
        // ancient rather than as missing. The distinction matters because one is
        // a first launch and the other is a corrupt cache.
        guard let stamp = defaults.object(forKey: Self.fetchedAtKey) as? Double else { return nil }
        return SupportedVersionCacheEntry(document: document,
                                          fetchedAt: Date(timeIntervalSince1970: stamp))
    }

    public func save(_ entry: SupportedVersionCacheEntry) {
        defaults.set(entry.document, forKey: Self.documentKey)
        defaults.set(entry.fetchedAt.timeIntervalSince1970, forKey: Self.fetchedAtKey)
    }
}

/// A store that lives and dies with the process. For tests and for a launch that
/// must not write to the product's defaults.
public final class InMemorySupportedVersionPolicyStore: SupportedVersionPolicyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var entry: SupportedVersionCacheEntry?

    public init(entry: SupportedVersionCacheEntry? = nil) {
        self.entry = entry
    }

    public func load() -> SupportedVersionCacheEntry? {
        lock.lock(); defer { lock.unlock() }
        return entry
    }

    public func save(_ entry: SupportedVersionCacheEntry) {
        lock.lock(); defer { lock.unlock() }
        self.entry = entry
    }
}

/// **Whether this build may run, and what it says about it.**
///
/// The object the UI observes. Everything consequential about it is a rule, and
/// each rule exists because of a specific way this feature can go wrong:
///
///  - **It starts from the cache, synchronously.** A model that began
///    `.supported` and became `.updateRequired` when a request came back would
///    show a below-minimum build its full product surface for as long as the
///    network took, which is exactly the interval a blocked build is dangerous in.
///  - **A failed refresh never escalates.** An outage, a 500, a truncated body
///    or a hostile one leaves the state exactly as it was. Nothing about a
///    network failure is evidence that this build is unsupported, and treating
///    it as such would let a dropped Wi-Fi connection block a paying user's Mac.
///  - **A cache entry is bounded and re-validated.** Older than `maxCacheAge`,
///    or stamped in the future by a clock that moved, and it is not used — the
///    policy falls back to the embedded floor, which cannot block this build.
///  - **The blocking state is derived, never set.** There is no `block()` and no
///    setter: the only inputs are the bundle's version, the embedded floor, and
///    a document that has already been through `SupportedVersionPolicy.decode`.
@MainActor
public final class SupportedVersionModel: ObservableObject {
    /// How long a cached document may decide the policy.
    ///
    /// Seven days: long enough that a Mac that is offline for a holiday keeps
    /// the requirement it was last told, short enough that a policy the owner
    /// relaxes is not held against a client for a season. Past it the floor
    /// takes over, which is the fail-open direction.
    public static let maxCacheAge: TimeInterval = 7 * 24 * 60 * 60

    @Published public private(set) var state: SupportedVersionState
    /// Whether the user has dismissed the recommendation in THIS session.
    ///
    /// Session-scoped on purpose. A recommendation is a sentence about a version
    /// that is out of date and getting more so; persisting the dismissal would
    /// silence it permanently for the one build that most needs to hear it
    /// again. Blocking is unaffected — `isBlocked` reads the state, not this.
    @Published public private(set) var hasDismissedRecommendation = false
    /// The last refresh's outcome, for diagnostics. Never a UI state: nothing
    /// renders differently because a refresh failed.
    @Published public private(set) var lastRefreshFailed = false

    public let currentVersion: AppVersion?
    private let floor: SupportedVersionPolicy
    private let store: SupportedVersionPolicyStore
    private let source: SupportedVersionPolicySource
    private let now: @Sendable () -> Date

    /// The marketing version of the running bundle, or nil if it cannot be read.
    public static func bundleVersion(_ bundle: Bundle = .main) -> AppVersion? {
        guard let text = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        else { return nil }
        return AppVersion(text)
    }

    public init(currentVersion: AppVersion?,
                floor: SupportedVersionPolicy = .embeddedFloor,
                store: SupportedVersionPolicyStore,
                source: SupportedVersionPolicySource,
                now: @escaping @Sendable () -> Date = Date.init) {
        self.currentVersion = currentVersion
        self.floor = floor
        self.store = store
        self.source = source
        self.now = now
        state = SupportedVersionState.evaluate(
            current: currentVersion,
            policy: Self.cachedPolicy(store: store, floor: floor, now: now()) ?? floor)
    }

    public var isBlocked: Bool { state.isBlocking }

    /// A recommendation the user has not dismissed. Blocking is a separate
    /// question and this is deliberately false while blocked: the two surfaces
    /// must never be on screen together.
    public var showsRecommendation: Bool {
        if case .updateRecommended = state { return !hasDismissedRecommendation }
        return false
    }

    public func dismissRecommendation() {
        hasDismissedRecommendation = true
    }

    /// Fetch, validate, cache, re-evaluate. Every failure is absorbed.
    public func refresh() async {
        do {
            let document = try await source.fetch()
            let policy = try SupportedVersionPolicy.decode(document, floor: floor)
            store.save(SupportedVersionCacheEntry(document: document, fetchedAt: now()))
            lastRefreshFailed = false
            apply(policy)
        } catch {
            // Deliberately terminal. The previous state — cache-derived or the
            // floor — stays, and no failure path here can reach `updateRequired`.
            lastRefreshFailed = true
        }
    }

    private func apply(_ policy: SupportedVersionPolicy) {
        let next = SupportedVersionState.evaluate(current: currentVersion, policy: policy)
        guard next != state else { return }
        // A newly recommended version is a new sentence, so an earlier dismissal
        // of a different one does not silence it.
        if case .updateRecommended = next { hasDismissedRecommendation = false }
        state = next
    }

    /// The cached policy, if there is one and it is still allowed to decide.
    ///
    /// `static` and pure so `init` can use it before `self` exists, which is what
    /// makes the first render already correct.
    private static func cachedPolicy(store: SupportedVersionPolicyStore,
                                     floor: SupportedVersionPolicy,
                                     now: Date) -> SupportedVersionPolicy? {
        guard let entry = store.load() else { return nil }
        let age = now.timeIntervalSince(entry.fetchedAt)
        // Both bounds. A negative age is a clock that moved backwards or an
        // entry written by a device whose time was wrong, and trusting it would
        // make the seven-day bound unenforceable.
        guard age >= 0, age <= maxCacheAge else { return nil }
        return try? SupportedVersionPolicy.decode(entry.document, floor: floor)
    }
}
