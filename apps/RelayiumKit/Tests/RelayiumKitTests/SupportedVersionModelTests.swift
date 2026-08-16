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

    private func document(revision: Int = 1,
                          minimum: String = "1.2.4",
                          build: Int = 11,
                          recommended: String = "1.2.5",
                          latest: String = "1.2.7") -> Data {
        Data("""
            {"schema":1,"macos":{"policyRevision":\(revision),
            "minimumSupportedVersion":"\(minimum)",
            "minimumSupportedBuild":\(build),"recommendedVersion":"\(recommended)",
            "latestVersion":"\(latest)"}}
            """.utf8)
    }

    /// A store already holding one accepted document, at a given age.
    private func store(_ document: Data, age: TimeInterval = 0) -> InMemorySupportedVersionPolicyStore {
        InMemorySupportedVersionPolicyStore(
            entry: SupportedVersionCacheEntry(document: document,
                                              fetchedAt: epoch.addingTimeInterval(-age)))
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

    // MARK: - the replay barrier

    /// The strict policy a device has already been told, and the older one an
    /// attacker would serve back to it. Both are valid, both clear the embedded
    /// floor, and `decode` has no reason to prefer either — the revision is the
    /// only thing that distinguishes them.
    private func strict(revision: Int) -> Data {
        document(revision: revision, minimum: "1.3.0", build: 20,
                 recommended: "1.3.0", latest: "1.3.0")
    }

    /// **The defect this barrier exists for.**
    ///
    /// A client cached a policy requiring 1.3.0 and is blocked. Somebody replays
    /// the older document — the real one, served from the real origin, above the
    /// embedded 1.2.4 floor in every field — and without a revision the client
    /// reads it as the policy in force and unblocks itself. Comparing to the
    /// floor cannot catch this: the floor is a constant, and the client has
    /// moved past it.
    ///
    /// The refusal has to be total. Not merely "does not unblock": a replay that
    /// reached the cache would overwrite the very memory that identified it, and
    /// the next launch would have nothing left to compare against.
    func testALowerRevisionCannotUnblockAClientThatHasSeenAStricterPolicy() async {
        let cache = store(strict(revision: 5))
        let subject = model(version: "1.2.7", store: cache, result: .success(document(revision: 4)))
        XCTAssertTrue(subject.isBlocked, "the strict cached policy did not block 1.2.7")

        await subject.refresh()

        XCTAssertTrue(subject.isBlocked, "a replayed older policy unblocked the client")
        XCTAssertEqual(subject.state.policy?.minimumSupported, AppVersion("1.3.0")!)
        XCTAssertTrue(subject.lastRefreshFailed)
        // Nothing about the cache moved: not the document, not the timestamp.
        XCTAssertEqual(cache.load()?.document, strict(revision: 5))
        XCTAssertEqual(cache.load()?.fetchedAt, epoch)
    }

    /// One revision, one document. A second document under a revision this
    /// device already holds is refused whichever direction it differs in — an
    /// origin telling two clients two things, and a hand edit that changed a
    /// requirement without advancing the number, are the same event from here.
    ///
    /// **This is what makes "a manual requirement change must bump
    /// `policyRevision`" a rule rather than a note.** An un-bumped edit is not
    /// merely undocumented: it is silently declined by exactly the clients that
    /// already fetched the previous copy.
    func testTheSameRevisionCarryingDifferentContentIsRefused() async {
        for (label, served) in [
            ("a stricter requirement", document(revision: 5, minimum: "1.2.6",
                                                build: 12, recommended: "1.2.6")),
            ("a relaxed requirement", document(revision: 5)),
            ("a different published version", document(revision: 5, minimum: "1.3.0",
                                                       build: 20, recommended: "1.3.0",
                                                       latest: "1.4.0")),
        ] {
            let cache = store(strict(revision: 5))
            let subject = model(version: "1.2.7", store: cache, result: .success(served))
            await subject.refresh()

            XCTAssertTrue(subject.isBlocked, label)
            XCTAssertEqual(subject.state.policy?.minimumSupported, AppVersion("1.3.0")!, label)
            XCTAssertTrue(subject.lastRefreshFailed, label)
            XCTAssertEqual(cache.load()?.document, strict(revision: 5), label)
        }
    }

    /// **The emergency rollback, end to end.** A minimum published in error is
    /// undone by publishing a HIGHER revision that relaxes it: no new binary, no
    /// waiting for an update the blocked client cannot install. Every blocked
    /// client takes it on its next refresh.
    func testAHigherRevisionMayRelaxTheRequirementAndUnblockTheClient() async {
        let cache = store(strict(revision: 5))
        let subject = model(version: "1.2.7", store: cache, result: .success(document(revision: 6)))
        XCTAssertTrue(subject.isBlocked)

        await subject.refresh()

        XCTAssertFalse(subject.isBlocked, "the emergency relaxation did not reach the client")
        XCTAssertEqual(subject.state, .supported)
        XCTAssertFalse(subject.lastRefreshFailed)
        XCTAssertEqual(cache.load()?.document, document(revision: 6))
        // And the relaxation still cannot go below the binary's own floor: the
        // same higher revision carrying a weaker requirement is refused.
        let below = store(strict(revision: 5))
        let refused = model(version: "1.2.7", store: below,
                            result: .success(document(revision: 7, minimum: "1.0",
                                                      build: 1, recommended: "1.0")))
        await refused.refresh()
        XCTAssertTrue(refused.isBlocked)
        XCTAssertEqual(below.load()?.document, strict(revision: 5))
    }

    /// **The memory outlives the enforcement window, and it has to.**
    ///
    /// Past seven days the cached policy stops deciding whether the app runs —
    /// that is the fail-open bound, and the app becomes usable again under the
    /// embedded floor. What must NOT expire is the device's knowledge that it
    /// once accepted revision 5: an expiring high-water mark would hand the
    /// replay back to anyone who can keep a client offline for a week, which is
    /// not an obstacle but the ordinary state of a laptop nobody opened.
    func testAnExpiredCacheStopsEnforcingAndKeepsRefusingAReplay() async {
        let cache = store(strict(revision: 5),
                          age: SupportedVersionModel.maxCacheAge + 60 * 60 * 24 * 30)
        let subject = model(version: "1.2.7", store: cache, result: .success(document(revision: 4)))
        // Expired, so the floor decides and 1.2.7 is usable again.
        XCTAssertFalse(subject.isBlocked)

        await subject.refresh()

        // And the replay is still a replay a month after the entry lapsed.
        XCTAssertTrue(subject.lastRefreshFailed, "an expired cache admitted an older revision")
        XCTAssertEqual(cache.load()?.document, strict(revision: 5))
        XCTAssertEqual(cache.load()?.fetchedAt,
                       epoch.addingTimeInterval(-(SupportedVersionModel.maxCacheAge
                                                  + 60 * 60 * 24 * 30)))
        // A higher revision is still admitted, so an expired barrier refuses
        // replays without freezing the device out of legitimate policy.
        let moved = model(version: "1.2.7", store: cache, result: .success(document(revision: 6)))
        await moved.refresh()
        XCTAssertFalse(moved.lastRefreshFailed)
        XCTAssertEqual(cache.load()?.document, document(revision: 6))
    }

    /// The same revision, the same policy — admitted, and the timestamp moves.
    /// This is the ordinary case for a client that refreshes daily against an
    /// unchanged policy, and it is the reason "equal" is not simply refused: an
    /// expired entry would otherwise never come back into enforcement while the
    /// product had nothing new to say.
    func testAnIdenticalDocumentAtTheSameRevisionRefreshesTheTimestamp() async {
        let cache = store(strict(revision: 5), age: SupportedVersionModel.maxCacheAge + 1)
        let subject = model(version: "1.2.7", store: cache, result: .success(strict(revision: 5)))
        XCTAssertFalse(subject.isBlocked, "the expired entry was still enforcing")

        await subject.refresh()

        XCTAssertFalse(subject.lastRefreshFailed)
        XCTAssertEqual(cache.load()?.fetchedAt, epoch)
        XCTAssertTrue(subject.isBlocked, "the re-confirmed policy did not take effect")
        // Identity is the DECODED policy, not the bytes: a re-serialization that
        // says the same thing is the same policy, and an unknown field is still
        // ignored. Nothing here can change what the document requires — that
        // would be a different policy and would need a revision.
        let respelled = Data("""
            {"macos":{"latestVersion":"1.3.0","recommendedVersion":"1.3.0",
            "minimumSupportedBuild":20,"minimumSupportedVersion":"1.3.0",
            "policyRevision":5,"note":"re-published"},"schema":1}
            """.utf8)
        let again = model(version: "1.2.7", store: cache, result: .success(respelled))
        await again.refresh()
        XCTAssertFalse(again.lastRefreshFailed, "a re-spelled identical policy was refused")
        XCTAssertTrue(again.isBlocked)
    }

    /// A revision the client will not read leaves everything where it was. The
    /// ceiling matters most: one document carrying `Int.max`, if it were stored,
    /// would sit above every revision the product can ever publish and this
    /// install would refuse legitimate policy forever — including the emergency
    /// one. It is refused at decode, before it can be remembered.
    func testARevisionOutsideTheBoundIsNeverRemembered() async {
        for (label, revision) in [("zero", 0),
                                  ("negative", -1),
                                  ("above the ceiling",
                                   SupportedVersionPolicy.maxPolicyRevision + 1),
                                  ("Int.max", Int.max)] {
            let cache = store(strict(revision: 5))
            let subject = model(version: "1.2.7", store: cache,
                                result: .success(document(revision: revision)))
            await subject.refresh()
            XCTAssertTrue(subject.lastRefreshFailed, label)
            XCTAssertTrue(subject.isBlocked, label)
            XCTAssertEqual(cache.load()?.document, strict(revision: 5), label)
        }
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
