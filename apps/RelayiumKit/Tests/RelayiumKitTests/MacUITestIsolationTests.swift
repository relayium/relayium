import XCTest

/// Package tests cannot instantiate the macOS App. Guard its two production
/// side-effect seams alongside SharedDraftInboxTests' real no-store behavior.
final class MacUITestIsolationTests: XCTestCase {
    private func code(_ path: String) throws -> String {
        try RepoRoot.text(path).components(separatedBy: "\n")
            .map { String($0.components(separatedBy: "//")[0]) }
            .joined().filter { !$0.isWhitespace }
    }

    func testUITestLaunchDoesNotOpenTheProductionSharedDraftStore() throws {
        let app = try code("apps/mac/Relayium/RelayiumApp.swift")
        XCTAssertTrue(app.contains(
            "privateletsharedDrafts=SharedDraftInbox(store:UITestMode.isActive?nil:AppEnvironment.makeSharedDraftStore())"))
    }

    func testUITestLaunchDoesNotStartSparkleOrPersistItsConsent() throws {
        let distribution = try code("apps/mac/Relayium/Distribution/DirectDistribution.swift")
        XCTAssertTrue(distribution.contains(
            "startingUpdater:!AppEnvironment.isEngineeringCandidate&&!UITestMode.isActive,"))
    }

    func testReleaseNeverEntersTheUITestIsolationBranch() throws {
        let mode = try RepoRoot.text("apps/mac/Relayium/UITestMode.swift")
        let release = try XCTUnwrap(mode.components(separatedBy: "#else").last)
        let code = release.components(separatedBy: "\n")
            .map { String($0.components(separatedBy: "//")[0]) }
            .joined().filter { !$0.isWhitespace }
        XCTAssertTrue(code.contains("staticletisActive=false"))
    }
}
