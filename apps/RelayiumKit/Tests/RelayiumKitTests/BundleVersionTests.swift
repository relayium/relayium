import XCTest

/// Every target of one app ships one version.
///
/// **This is a real rejection, not tidiness.** An app extension whose
/// `CFBundleShortVersionString` or `CFBundleVersion` differs from its containing
/// app fails App Store validation, and on iOS a mismatched build number can fail
/// installation outright. Both targets build fine, run fine in the Simulator and
/// pass every other test in this repository while disagreeing — the first thing
/// that notices is an upload or an install.
///
/// It is also the failure a version bump creates most easily: bumping the app
/// and forgetting the appex is one edit away at all times, and each project now
/// has two targets that must move together.
///
/// The values live in the `.pbxproj` rather than in the `Info.plist`s, which
/// carry `$(MARKETING_VERSION)` and `$(CURRENT_PROJECT_VERSION)`, so that is
/// where they are read from.
final class BundleVersionTests: XCTestCase {
    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
    }

    private func settings(_ platform: String, _ key: String) throws -> [String] {
        let project = try String(
            contentsOf: repoRoot.appendingPathComponent(
                "apps/\(platform)/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)
        return project
            .components(separatedBy: "\n")
            .compactMap { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("\(key) = ") else { return nil }
                return trimmed
                    .dropFirst("\(key) = ".count)
                    .trimmingCharacters(in: CharacterSet(charactersIn: ";\" "))
            }
    }

    /// Four occurrences per key on each platform: two targets × Debug and
    /// Release. The count is asserted as well as the value, so a third target —
    /// or a configuration that quietly lost the setting — is a failure rather
    /// than something the `Set` collapses out of sight.
    private func assertOneVersion(_ platform: String,
                                  key: String,
                                  expected: String,
                                  occurrences: Int,
                                  file: StaticString = #filePath,
                                  line: UInt = #line) throws {
        let values = try settings(platform, key)
        XCTAssertEqual(values.count, occurrences,
                       "\(platform): expected \(occurrences) \(key) settings, found \(values.count)",
                       file: file, line: line)
        XCTAssertEqual(Set(values), [expected],
                       "\(platform): \(key) disagrees between targets or configurations: \(values)",
                       file: file, line: line)
    }

    /// macOS: the app and its Share extension.
    func testTheMacAppAndItsExtensionShipOneVersion() throws {
        // Eight: the app, the Share extension, the UI test bundle, and the
        // project-level Debug/Release pair each carry the settings.
        let marketing = try settings("mac", "MARKETING_VERSION")
        XCTAssertEqual(Set(marketing), ["1.0"],
                       "a macOS target disagrees about the version: \(marketing)")
        let build = try settings("mac", "CURRENT_PROJECT_VERSION")
        XCTAssertEqual(Set(build), ["1"],
                       "a macOS target disagrees about the build number: \(build)")
    }

    /// iOS: the app and its Share extension, both Debug and Release.
    func testTheIOSAppAndItsExtensionShipOneVersion() throws {
        try assertOneVersion("ios", key: "MARKETING_VERSION", expected: "1.0", occurrences: 4)
        try assertOneVersion("ios", key: "CURRENT_PROJECT_VERSION", expected: "1", occurrences: 4)
    }

    /// And the two platforms agree with each other, because they are one product
    /// released together. A user comparing the Mac app to the iPhone app should
    /// not find two different 1.x numbers for the same behaviour.
    func testBothPlatformsShipTheSameVersion() throws {
        let mac = Set(try settings("mac", "MARKETING_VERSION"))
        let ios = Set(try settings("ios", "MARKETING_VERSION"))
        XCTAssertEqual(mac, ios, "macOS and iOS disagree about the product version")
    }
}
