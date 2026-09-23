import XCTest
@testable import RelayiumAppKit

/// A19: the iOS version-support mechanism — the served document, the channel
/// split between the public App Store and TestFlight, the cache, and the rule
/// that nothing here can raise a floor, offer an unobtainable build, or lock
/// anybody out.
@MainActor
final class IOSVersionSupportTests: XCTestCase {
    private func v(_ s: String) -> AppVersion { AppVersion(s)! }

    private func doc(revision: Int = 2, minimum: String = "0.0.0", recommended: String = "0.0.0",
                     appStore: String = "", testFlight: String = "") -> Data {
        Data("""
        {"schema":1,"ios":{"policyRevision":\(revision),"minimumSupportedVersion":"\(minimum)",
         "recommendedVersion":"\(recommended)","appStoreVersion":"\(appStore)",
         "testFlightVersion":"\(testFlight)"}}
        """.utf8)
    }

    private struct StubSource: IOSVersionPolicySource {
        let result: Result<Data, Error>
        func fetch() async throws -> Data { try result.get() }
    }
    private struct Outage: Error {}

    private func model(current: String?, channel: IOSDistributionChannel,
                       store: InMemorySupportedVersionPolicyStore = .init(),
                       serve: Result<Data, Error>,
                       now: Date = Date(timeIntervalSince1970: 2_000_000_000)) -> IOSVersionSupportModel {
        IOSVersionSupportModel(currentVersion: current.flatMap(AppVersion.init), currentBuild: "10",
                               channel: channel, store: store, source: StubSource(result: serve),
                               now: { now })
    }

    // MARK: - the server contract

    /// The bytes the server embeds and serves decode here, and they are
    /// exactly the embedded floor: inert, offering and requiring nothing.
    func testTheServedDocumentDecodesAndIsInert() throws {
        let served = try RepoRoot.data("server/account/ios_client_policy.json")
        let policy = try IOSVersionPolicy.decode(served)
        XCTAssertEqual(policy, .embeddedFloor)
        XCTAssertNoThrow(try IOSVersionPolicy.admit(policy, over: nil))
        for channel in [IOSDistributionChannel.appStore, .testFlight, .development] {
            XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.4.1"), channel: channel,
                                                           policy: policy), .current)
        }
    }

    // MARK: - channel

    func testTheChannelIsReadFromTheReceiptAndTheProfile() {
        typealias C = IOSDistributionChannel
        XCTAssertEqual(C.classify(receiptFileName: "receipt", hasEmbeddedProvisioningProfile: false,
                                  isSimulator: false), .appStore)
        XCTAssertEqual(C.classify(receiptFileName: "sandboxReceipt", hasEmbeddedProvisioningProfile: false,
                                  isSimulator: false), .testFlight)
        // Xcode installs also name a sandbox receipt; the profile gives them away.
        XCTAssertEqual(C.classify(receiptFileName: "sandboxReceipt", hasEmbeddedProvisioningProfile: true,
                                  isSimulator: false), .development)
        XCTAssertEqual(C.classify(receiptFileName: "receipt", hasEmbeddedProvisioningProfile: false,
                                  isSimulator: true), .development)
        XCTAssertEqual(C.classify(receiptFileName: nil, hasEmbeddedProvisioningProfile: false,
                                  isSimulator: false), .development)
        XCTAssertEqual(C.classify(receiptFileName: "somethingNew", hasEmbeddedProvisioningProfile: false,
                                  isSimulator: false), .development)
    }

    // MARK: - decode

    func testMalformedDocumentsAreRefusedWhole() {
        let bad: [(String, IOSVersionPolicyError)] = [
            ("not json", .malformed),
            (#"{"schema":2,"ios":{}}"#, .unsupportedSchema(2)),
            (#"{"schema":1}"#, .malformed),
            // A missing availability key is malformed, not "empty".
            (#"{"schema":1,"ios":{"policyRevision":2,"minimumSupportedVersion":"0","recommendedVersion":"0","appStoreVersion":""}}"#, .malformed),
            (#"{"schema":1,"ios":{"policyRevision":true,"minimumSupportedVersion":"0","recommendedVersion":"0","appStoreVersion":"","testFlightVersion":""}}"#, .malformed),
            (#"{"schema":1,"ios":{"policyRevision":0,"minimumSupportedVersion":"0","recommendedVersion":"0","appStoreVersion":"","testFlightVersion":""}}"#, .invalidRevision(0)),
            (#"{"schema":1,"ios":{"policyRevision":2,"minimumSupportedVersion":"1.0-beta","recommendedVersion":"1","appStoreVersion":"","testFlightVersion":""}}"#, .unreadableVersion("1.0-beta")),
        ]
        for (text, expected) in bad {
            XCTAssertThrowsError(try IOSVersionPolicy.decode(Data(text.utf8)), text) {
                XCTAssertEqual($0 as? IOSVersionPolicyError, expected, text)
            }
        }
        XCTAssertThrowsError(try IOSVersionPolicy.decode(Data(count: IOSVersionPolicy.maxDocumentBytes + 1))) {
            XCTAssertEqual($0 as? IOSVersionPolicyError, .tooLarge)
        }
    }

    /// **No floor out of nothing.** A requirement above every version any
    /// channel can deliver is refused whole, and so is minimum > recommended.
    func testARequirementNoChannelCanDeliverIsRefused() {
        for data in [doc(minimum: "0.5.0", recommended: "0.5.0"),                       // nothing available
                     doc(minimum: "0.5.0", recommended: "0.5.0", appStore: "0.4.0"),    // above availability
                     doc(minimum: "0.6.0", recommended: "0.5.0", testFlight: "0.6.0")] { // min > rec
            XCTAssertThrowsError(try IOSVersionPolicy.decode(data)) {
                XCTAssertEqual($0 as? IOSVersionPolicyError, .inconsistent)
            }
        }
        XCTAssertNoThrow(try IOSVersionPolicy.decode(doc(minimum: "0.5.0", recommended: "0.5.0",
                                                         testFlight: "0.5.0")))
    }

    // MARK: - evaluate

    /// older / equal / newer, per channel.
    func testOlderEqualAndNewerBuilds() throws {
        let p = try IOSVersionPolicy.decode(doc(minimum: "0.4.0", recommended: "0.4.1",
                                                appStore: "0.4.2", testFlight: "0.4.2"))
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.3.9"), channel: .appStore, policy: p),
                       .updateRequired(target: v("0.4.2")))
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.4.0"), channel: .appStore, policy: p),
                       .updateRecommended(target: v("0.4.2")))
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.4.1"), channel: .appStore, policy: p),
                       .updateAvailable(target: v("0.4.2")))
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.4.2"), channel: .appStore, policy: p),
                       .current)
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.5.0"), channel: .appStore, policy: p),
                       .current, "a build ahead of the store is not asked to go back")
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: nil, channel: .appStore, policy: p),
                       .unknown)
    }

    /// **The public is never sent to a TestFlight-only build.** A version only
    /// testers can install is offered to testers, and the App Store build
    /// hears nothing — not even the requirement, because it has nowhere to go.
    func testATestFlightOnlyVersionIsNeverOfferedToAppStoreUsers() throws {
        let p = try IOSVersionPolicy.decode(doc(minimum: "0.5.0", recommended: "0.5.0",
                                                appStore: "0.4.1", testFlight: "0.5.0"))
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.4.1"), channel: .appStore, policy: p),
                       .current)
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.4.0"), channel: .appStore, policy: p),
                       .updateAvailable(target: v("0.4.1")),
                       "the App Store build may still be told about the App Store version")
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.4.1"), channel: .testFlight, policy: p),
                       .updateRequired(target: v("0.5.0")))
        XCTAssertEqual(IOSVersionSupportState.evaluate(current: v("0.1.0"), channel: .development, policy: p),
                       .current, "a development build is offered nothing")
    }

    // MARK: - the model: failure, cache, replay

    func testAnOutageAtFirstLaunchOffersNothingAndCachesNothing() async {
        let store = InMemorySupportedVersionPolicyStore()
        let m = model(current: "0.1.0", channel: .appStore, store: store, serve: .failure(Outage()))
        XCTAssertEqual(m.state, .current)
        await m.refresh()
        XCTAssertEqual(m.state, .current)
        XCTAssertTrue(m.lastRefreshFailed)
        XCTAssertNil(store.load())
    }

    func testAFailedRefreshKeepsTheLastAnswer() async {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let store = InMemorySupportedVersionPolicyStore(
            entry: .init(document: doc(recommended: "0.4.2", appStore: "0.4.2"), fetchedAt: now))
        let m = model(current: "0.4.0", channel: .appStore, store: store,
                      serve: .success(Data("garbage".utf8)), now: now)
        XCTAssertEqual(m.state, .updateRecommended(target: v("0.4.2")), "decided from cache at init")
        await m.refresh()
        XCTAssertEqual(m.state, .updateRecommended(target: v("0.4.2")))
        XCTAssertTrue(m.lastRefreshFailed)
    }

    func testAnExpiredOrFutureCacheFallsBackToTheFloor() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        for stamp in [now.addingTimeInterval(-IOSVersionSupportModel.maxCacheAge - 1),
                      now.addingTimeInterval(60)] {
            let store = InMemorySupportedVersionPolicyStore(
                entry: .init(document: doc(recommended: "0.4.2", appStore: "0.4.2"), fetchedAt: stamp))
            let m = model(current: "0.4.0", channel: .appStore, store: store,
                          serve: .failure(Outage()), now: now)
            XCTAssertEqual(m.state, .current)
        }
    }

    func testAnOlderRevisionIsARefusedReplayAndIsNotCached() async {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let held = doc(revision: 5, appStore: "0.4.2")
        let store = InMemorySupportedVersionPolicyStore(entry: .init(document: held, fetchedAt: now))
        let m = model(current: "0.4.0", channel: .appStore, store: store,
                      serve: .success(doc(revision: 4, appStore: "0.4.3")), now: now)
        await m.refresh()
        XCTAssertTrue(m.lastRefreshFailed)
        XCTAssertEqual(store.load()?.document, held)
        XCTAssertEqual(m.state, .updateAvailable(target: v("0.4.2")))
    }

    func testTheSameRevisionWithDifferentContentIsRefused() async {
        // Revision 1 is the floor's: a served revision 1 that says anything
        // else is equivocation, even on a fresh install.
        let m = model(current: "0.4.0", channel: .appStore,
                      serve: .success(doc(revision: 1, appStore: "0.4.2")))
        await m.refresh()
        XCTAssertTrue(m.lastRefreshFailed)
        XCTAssertEqual(m.state, .current)
    }

    func testAHigherRevisionIsAdmittedCachedAndApplied() async {
        let store = InMemorySupportedVersionPolicyStore()
        let served = doc(revision: 3, testFlight: "0.4.2")
        let m = model(current: "0.4.1", channel: .testFlight, store: store, serve: .success(served))
        await m.refresh()
        XCTAssertFalse(m.lastRefreshFailed)
        XCTAssertEqual(store.load()?.document, served)
        XCTAssertEqual(m.state, .updateAvailable(target: v("0.4.2")))
    }

    // MARK: - the wire and the destinations

    /// Anonymous: no bearer, no cookie, the one path, and the cache bypassed.
    func testTheSourceFetchesTheIOSPathWithNoCredential() async throws {
        StubURLProtocol.reset()
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.stub = .init(status: 200, body: doc())
        _ = try await HTTPIOSVersionPolicySource(baseURL: URL(string: "https://relayium.test")!,
                                                 session: StubURLProtocol.session()).fetch()
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/api/client-policy/ios")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
    }

    func testANon200IsAFailureNotAPolicy() async {
        defer { StubURLProtocol.stub = nil; StubURLProtocol.reset() }
        StubURLProtocol.stub = .init(status: 503, body: doc(revision: 9, appStore: "9.0"))
        do {
            _ = try await HTTPIOSVersionPolicySource(baseURL: URL(string: "https://relayium.test")!,
                                                     session: StubURLProtocol.session()).fetch()
            XCTFail("a 503 body was read as a policy")
        } catch {}
    }

    /// The destinations are compiled in: the verified App Store record for
    /// `com.relayium.app` (OA-009) and the TestFlight app.
    func testTheUpdateDestinationsAreTheVerifiedOnes() {
        XCTAssertEqual(AppEnvironment.iosAppStoreURL.absoluteString, "https://apps.apple.com/app/id6791918822")
        XCTAssertEqual(AppEnvironment.iosTestFlightURL.scheme, "itms-beta")
    }
}
