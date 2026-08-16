import XCTest
@testable import RelayiumAppKit

/// **What this model does when the network, the clock or the origin misbehaves.**
///
/// The decision itself is `SupportedVersionTests`'. This file is about the ways
/// the decision can be reached WRONGLY at runtime — a cache that outlived its
/// usefulness, a clock that moved, an outage, a 500, an origin serving last
/// year's policy — and about the direction each failure is required to fail in.
///
/// One rule sits under all of them: **nothing that fails may block.** A blocked
/// state is only ever reached from a document that decoded, validated and
/// cleared the embedded floor. Everything else leaves the app usable, because
/// the alternative is a dropped Wi-Fi connection taking a paying user's Mac out
/// of service with no way back.
@MainActor
final class SupportedVersionModelTests: XCTestCase {

    // MARK: - fixtures

    private struct StubSource: SupportedVersionPolicySource {
        let result: Result<Data, Error>
        func fetch() async throws -> Data { try result.get() }
    }

    private struct Outage: Error {}

    private func document(minimum: String = "1.2.4",
                          build: Int = 11,
                          recommended: String = "1.2.5",
                          latest: String = "1.2.7") -> Data {
        Data("""
            {"schema":1,"macos":{"minimumSupportedVersion":"\(minimum)",
            "minimumSupportedBuild":\(build),"recommendedVersion":"\(recommended)",
            "latestVersion":"\(latest)"}}
            """.utf8)
    }

    private let epoch = Date(timeIntervalSince1970: 1_800_000_000)

    private func model(version: String?,
                       store: SupportedVersionPolicyStore,
                       result: Result<Data, Error> = .failure(Outage()),
                       now: Date? = nil) -> SupportedVersionModel {
        let stamp = now ?? epoch
        return SupportedVersionModel(currentVersion: version.flatMap(AppVersion.init),
                                     store: store,
                                     source: StubSource(result: result),
                                     now: { stamp })
    }

    // MARK: - the first frame

    /// **Correct before the first request, not after it.** A model that started
    /// `.supported` and turned blocking when a response landed would show a
    /// below-minimum build its whole product surface for the length of a network
    /// round trip — which is exactly the interval that matters.
    func testABlockedBuildIsBlockedFromTheFirstFrameFromCacheAlone() {
        let store = InMemorySupportedVersionPolicyStore(
            entry: SupportedVersionCacheEntry(document: document(minimum: "1.2.6", build: 12, recommended: "1.2.6"),
                                              fetchedAt: epoch))
        let subject = model(version: "1.2.5", store: store)
        XCTAssertTrue(subject.isBlocked)
        XCTAssertEqual(subject.state.policy?.minimumSupported, AppVersion("1.2.6")!)
    }

    /// With no cache at all — a first launch, offline — the embedded floor is
    /// the policy, and the floor cannot block the build that ships it.
    func testAFirstLaunchWithNoCacheAndNoNetworkIsUsable() async {
        let subject = model(version: "1.2.8", store: InMemorySupportedVersionPolicyStore())
        XCTAssertEqual(subject.state, .supported)
        await subject.refresh()
        XCTAssertEqual(subject.state, .supported)
        XCTAssertTrue(subject.lastRefreshFailed)
    }

    /// The product claim this whole round is built on: under the policy as
    /// published, the shipped 1.2.7 and the 1.2.8 candidate both run normally.
    func testTheShippedPolicyLeavesTheCurrentReleasesUsable() async {
        for version in ["1.2.5", "1.2.7", "1.2.8"] {
            let subject = model(version: version,
                                store: InMemorySupportedVersionPolicyStore(),
                                result: .success(document()))
            await subject.refresh()
            XCTAssertEqual(subject.state, .supported, "\(version) was not left usable")
        }
        // And the two states below it are reached, so "supported" above is not
        // simply a policy that never says anything.
        let recommended = model(version: "1.2.4",
                                store: InMemorySupportedVersionPolicyStore(),
                                result: .success(document()))
        await recommended.refresh()
        XCTAssertTrue(recommended.showsRecommendation)
        XCTAssertFalse(recommended.isBlocked)

        let blocked = model(version: "1.2.3",
                            store: InMemorySupportedVersionPolicyStore(),
                            result: .success(document()))
        await blocked.refresh()
        XCTAssertTrue(blocked.isBlocked)
        // Never both surfaces at once.
        XCTAssertFalse(blocked.showsRecommendation)
    }

    // MARK: - the cache bound

    func testACachedPolicyOlderThanTheBoundIsNotUsed() {
        let store = InMemorySupportedVersionPolicyStore(
            entry: SupportedVersionCacheEntry(
                document: document(minimum: "1.2.6", build: 12, recommended: "1.2.6"),
                fetchedAt: epoch.addingTimeInterval(-SupportedVersionModel.maxCacheAge - 1)))
        XCTAssertFalse(model(version: "1.2.5", store: store).isBlocked,
                       "an expired cache still decided the policy")
    }

    func testACachedPolicyExactlyAtTheBoundStillDecides() {
        let store = InMemorySupportedVersionPolicyStore(
            entry: SupportedVersionCacheEntry(
                document: document(minimum: "1.2.6", build: 12, recommended: "1.2.6"),
                fetchedAt: epoch.addingTimeInterval(-SupportedVersionModel.maxCacheAge)))
        XCTAssertTrue(model(version: "1.2.5", store: store).isBlocked)
    }

    /// A clock that moved backwards, or an entry written by a device whose time
    /// was wrong. Trusting a negative age would make the bound unenforceable —
    /// an entry stamped in 2099 would never expire.
    func testACachedPolicyStampedInTheFutureIsNotUsed() {
        let store = InMemorySupportedVersionPolicyStore(
            entry: SupportedVersionCacheEntry(document: document(minimum: "1.2.6", build: 12, recommended: "1.2.6"),
                                              fetchedAt: epoch.addingTimeInterval(60)))
        XCTAssertFalse(model(version: "1.2.5", store: store).isBlocked)
    }

    /// **A cache entry is re-validated, not merely re-read.** The raw document
    /// is stored, so an entry that a previous build accepted is put through the
    /// CURRENT build's floor every time — a rollback cannot be laundered through
    /// the cache.
    func testACachedDocumentBelowThisBuildSFloorIsRefusedOnRead() {
        let store = InMemorySupportedVersionPolicyStore(
            entry: SupportedVersionCacheEntry(document: document(minimum: "1.0", build: 1),
                                              fetchedAt: epoch))
        let subject = model(version: "1.1", store: store)
        // The floor, not the cached document: 1.1 is below the embedded 1.2.4.
        XCTAssertTrue(subject.isBlocked)
        XCTAssertEqual(subject.state.policy?.minimumSupported,
                       SupportedVersionPolicy.embeddedFloor.minimumSupported)
    }

    func testACorruptCacheEntryIsIgnoredRatherThanFatal() {
        let store = InMemorySupportedVersionPolicyStore(
            entry: SupportedVersionCacheEntry(document: Data("{".utf8), fetchedAt: epoch))
        XCTAssertEqual(model(version: "1.2.8", store: store).state, .supported)
    }

    // MARK: - refreshing

    func testASuccessfulRefreshCachesTheDocumentItActedOn() async {
        let store = InMemorySupportedVersionPolicyStore()
        let subject = model(version: "1.2.5",
                            store: store,
                            result: .success(document(minimum: "1.2.6", build: 12, recommended: "1.2.6")))
        await subject.refresh()

        XCTAssertTrue(subject.isBlocked)
        XCTAssertFalse(subject.lastRefreshFailed)
        XCTAssertEqual(store.load()?.fetchedAt, epoch)
        // The RAW document, so the next launch re-validates it rather than
        // trusting a decode this build performed.
        XCTAssertEqual(store.load()?.document, document(minimum: "1.2.6", build: 12, recommended: "1.2.6"))
    }

    /// Every refusal, and the same answer to all of them: the state does not
    /// move and nothing is cached.
    func testNoFailureEscalatesTheStateOrPoisonsTheCache() async {
        for (label, result) in [
            ("an outage", Result<Data, Error>.failure(Outage())),
            ("a body that is not JSON", .success(Data("<html>503</html>".utf8))),
            ("a truncated document", .success(Data(#"{"schema":1,"macos":{"#.utf8))),
            ("a future schema", .success(Data(#"{"schema":9,"macos":{}}"#.utf8))),
            ("a rolled-back policy", .success(document(minimum: "1.0", build: 1))),
            ("a self-contradicting policy", .success(document(minimum: "1.9", recommended: "1.3"))),
        ] {
            let store = InMemorySupportedVersionPolicyStore()
            let subject = model(version: "1.2.3", store: store, result: result)
            // Below the embedded floor, so this build starts blocked — and the
            // interesting half is that a bad response does not UNBLOCK it either.
            XCTAssertTrue(subject.isBlocked, label)
            await subject.refresh()
            XCTAssertTrue(subject.isBlocked, label)
            XCTAssertEqual(subject.state.policy?.minimumSupported,
                           SupportedVersionPolicy.embeddedFloor.minimumSupported, label)
            XCTAssertTrue(subject.lastRefreshFailed, label)
            XCTAssertNil(store.load(), "\(label) was written to the cache")
        }
    }

    /// The other direction of the same rule: a build that is FINE stays fine
    /// through every one of those failures. Nothing about a network failure is
    /// evidence that a build is unsupported.
    func testAFailedRefreshCannotBlockAWorkingBuild() async {
        let subject = model(version: "1.2.8",
                            store: InMemorySupportedVersionPolicyStore(),
                            result: .success(Data("not json".utf8)))
        await subject.refresh()
        XCTAssertFalse(subject.isBlocked)
        XCTAssertEqual(subject.state, .supported)
    }

    // MARK: - the recommendation

    func testDismissingTheRecommendationHidesItWithoutChangingTheState() async {
        let subject = model(version: "1.2.4",
                            store: InMemorySupportedVersionPolicyStore(),
                            result: .success(document()))
        await subject.refresh()
        XCTAssertTrue(subject.showsRecommendation)
        subject.dismissRecommendation()
        XCTAssertFalse(subject.showsRecommendation)
        XCTAssertEqual(subject.state, .updateRecommended(policy: subject.state.policy!))
        XCTAssertFalse(subject.isBlocked)
    }

    /// A dismissal silences the sentence it was given, not the next one. A newer
    /// recommended version is a different fact.
    func testANewRecommendationIsNotSilencedByAnEarlierDismissal() async {
        let subject = model(version: "1.2.4",
                            store: InMemorySupportedVersionPolicyStore(),
                            result: .success(document(recommended: "1.2.5")))
        await subject.refresh()
        subject.dismissRecommendation()
        XCTAssertFalse(subject.showsRecommendation)

        let raised = SupportedVersionModel(
            currentVersion: AppVersion("1.2.4"),
            store: InMemorySupportedVersionPolicyStore(),
            source: StubSource(result: .success(document(recommended: "1.2.6", latest: "1.2.7"))),
            now: { self.epoch })
        await raised.refresh()
        XCTAssertTrue(raised.showsRecommendation)
    }

    // MARK: - a bundle with no version

    /// The one input no update can repair. It is never blocked, and it does not
    /// stop the model working either.
    func testABundleWithNoReadableVersionIsNeverBlocked() async {
        let store = InMemorySupportedVersionPolicyStore()
        let subject = model(version: nil, store: store, result: .success(document(minimum: "1.9",
                                                                                 build: 99,
                                                                                 recommended: "1.9",
                                                                                 latest: "1.9")))
        await subject.refresh()
        XCTAssertEqual(subject.state, .supported)
        XCTAssertFalse(subject.isBlocked)
    }

    // MARK: - the defaults-backed store

    func testTheDefaultsStoreRoundTripsAndReportsAMissingEntryAsMissing() throws {
        // nonlocalized: a test-only defaults suite name
        let suite = try XCTUnwrap(UserDefaults(suiteName: "SupportedVersionModelTests"))
        suite.removePersistentDomain(forName: "SupportedVersionModelTests")
        let store = UserDefaultsSupportedVersionPolicyStore(defaults: suite)
        XCTAssertNil(store.load(), "an empty domain must read as no entry, not as 1970")

        store.save(SupportedVersionCacheEntry(document: document(), fetchedAt: epoch))
        XCTAssertEqual(store.load()?.document, document())
        XCTAssertEqual(try XCTUnwrap(store.load()).fetchedAt.timeIntervalSince1970,
                       epoch.timeIntervalSince1970, accuracy: 0.001)
        suite.removePersistentDomain(forName: "SupportedVersionModelTests")
    }

    // MARK: - the HTTP source

    /// The URL is the app's own production origin and is built from nothing the
    /// document says. Asserted as a whole address rather than by host alone: a
    /// path this test does not name is a path nobody reviewed.
    func testThePolicyIsFetchedFromOneCompiledInAddress() {
        XCTAssertEqual(HTTPSupportedVersionPolicySource.productionURL.absoluteString,
                       "https://relayium.com/apps/macos/client-policy.json")
    }

    func testTheHTTPSourceRefusesANonSuccessStatusAndAnOversizedBody() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubPolicyProtocol.self]
        let session = URLSession(configuration: configuration)
        let url = try XCTUnwrap(URL(string: "https://relayium.test/client-policy.json"))
        let source = HTTPSupportedVersionPolicySource(url: url, session: session)

        StubPolicyProtocol.status = 503
        StubPolicyProtocol.body = document()
        await XCTAssertThrowsErrorAsync(try await source.fetch(), "a 503 was accepted")

        StubPolicyProtocol.status = 200
        StubPolicyProtocol.body = Data(
            repeating: 0x20, count: SupportedVersionPolicy.maxDocumentBytes + 1)
        await XCTAssertThrowsErrorAsync(try await source.fetch(), "an oversized body was accepted")

        StubPolicyProtocol.status = 200
        StubPolicyProtocol.body = document()
        let data = try await source.fetch()
        XCTAssertEqual(data, document())
    }
}

/// `XCTAssertThrowsError` has no async form on this toolchain.
private func XCTAssertThrowsErrorAsync(_ expression: @autoclosure () async throws -> some Any,
                                       _ message: String,
                                       file: StaticString = #filePath,
                                       line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail(message, file: file, line: line)
    } catch {}
}

/// Answers one request with whatever the test set, so the source's own refusals
/// run rather than being asserted about in the abstract.
private final class StubPolicyProtocol: URLProtocol {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var body = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!,
                                       statusCode: Self.status,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
