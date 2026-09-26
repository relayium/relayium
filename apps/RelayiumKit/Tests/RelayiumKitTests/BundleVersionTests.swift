import XCTest

/// Every target of one platform app ships one version. macOS and iOS release
/// independently, so this guard deliberately does not couple their version
/// numbers.
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
    private func settings(_ platform: String, _ key: String) throws -> [String] {
        let project = try RepoRoot.text("apps/\(platform)/Relayium.xcodeproj/project.pbxproj")
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

    /// macOS: two products, each with its Share extension.
    func testTheMacAppAndItsExtensionShipOneVersion() throws {
        // Ten: five targets — the direct app and its Share extension, the App
        // Store app and ITS Share extension, and the UI test bundle — each in
        // Debug and Release. Every extension must match its containing app, and
        // the two products must not drift apart either: they are the same
        // release of the same app through two channels, and a user who installs
        // one after the other must not see the version go backwards.
        //
        // Fresh provider readback on 2026-09-26 confirms build39 was consumed.
        // The owner selected 1.4.3 (40) for the next candidate. This assertion
        // does not advance either channel's published version.
        try assertOneVersion("mac", key: "MARKETING_VERSION", expected: "1.4.3", occurrences: 10)
        try assertOneVersion("mac", key: "CURRENT_PROJECT_VERSION", expected: "40", occurrences: 10)
    }

    /// macOS: both shipped products and both Share extensions are Apple Silicon
    /// only, from `1.4.0 (37)`.
    ///
    /// Eight settings: four product targets (direct app, direct Share, App Store
    /// app, App Store Share) in Debug and Release, each exactly `arm64`. The UI
    /// test bundle keeps the default, so it still builds for whatever host runs
    /// it — an arm64 hosted runner, which the workflows assert before launching.
    /// A release whose executable is fat or Intel-only is rejected again, from
    /// the built bytes, by `macos.yml` and `macos-release.yml`; this is the
    /// source half, so a target that silently reverts to the standard
    /// architectures fails here before anything is signed.
    func testTheMacProductsAreAppleSiliconOnly() throws {
        let values = try settings("mac", "ARCHS")
        XCTAssertEqual(values.count, 8, "expected ARCHS on the four product targets × 2 configurations: \(values)")
        XCTAssertEqual(Set(values), ["arm64"], "a macOS product target builds a non-arm64 slice: \(values)")
    }

    /// iOS: the app and its Share extension, both Debug and Release.
    func testTheIOSAppAndItsExtensionShipOneVersion() throws {
        // `0.3.1 (7)`. **Builds 5 and 6 are both spent.** Build 5 was archived,
        // uploaded to the universal-purchase record on 2026-09-05, processed,
        // and reached `Ready to Submit` — and was then rejected before any
        // submission, because a Release capture of its Nearby tab rendered the
        // hub-backed room's public-address copy over the Bonjour transport iOS
        // actually ships. Build 6 was uploaded to the same record later that
        // day and read back `VALID` on 2026-09-07. A build number is consumed
        // by the upload, not by the release, so this candidate takes 7.
        //
        // `1.2.10 (2)` was a never-delivered candidate that deliberately matched
        // the then-current macOS numbers, so it is not a floor this line has to
        // clear. Builds are what App Store Connect requires to be strictly
        // monotonic per record; the marketing version is not.
        //
        // The build does NOT move with the marketing version. `0.3.0 (5)` was a
        // development baseline that was never archived, and 0.3.1 keeps its
        // marketing version across every correction: 5, 6 and 7 are three
        // candidates of the same unreleased version, not three versions.
        // Nothing under `0.3.1` has ever been submitted or released, so unlike
        // macOS above there is no published artifact for the number to collide
        // with — the iOS App Store version record still reads `0.3.1` in
        // `PREPARE_FOR_SUBMISSION`.
        //
        // That reuse ended with 0.3.1 (7). The 2026-09-17 App Store Connect
        // read-back showed the 0.3.1 App Store version WAITING_FOR_REVIEW with
        // build 7 selected, so the "never submitted" sentence above describes an
        // earlier reading, and 0.3.1 now names a submission in review that no
        // later candidate may be confused with. The next distributed candidate
        // therefore takes a new visible version, `0.3.2`, per the owner's
        // 2026-09-17 preference for a distinct marketing version on every newly
        // distributed test or public candidate. 0.3.2 is a new TestFlight
        // train for internal testing only; it is not an App Store version on
        // the record and does not touch the 0.3.1 submission or its build.
        //
        // 0.3.2 (8) was delivered to internal TestFlight on 2026-09-17 and the
        // owner's first cross-network test of it against macOS 1.4.0 failed:
        // that build announced only `text/1` in a pairing-code room, and macOS
        // and the Web refuse a pairing peer that does not announce `link/1`.
        // The correction replaces the whole Cross-network surface with the
        // connect-first unified workspace, which is a visible product change
        // rather than a rebuild, and the owner directed that it take a new
        // version rather than reuse the old one: `0.4.0`. It is still not an
        // App Store version on the record and does not touch the 0.3.1
        // submission or its build.
        //
        // Fresh provider readback on 2026-09-26 confirms 0.4.1 (10) VALID.
        // New user workflows take 0.5.0 (11), independent of the Mac sequence.
        // This is source preparation, not an upload or a public release.
        try assertOneVersion("ios", key: "MARKETING_VERSION", expected: "0.5.0", occurrences: 4)
        try assertOneVersion("ios", key: "CURRENT_PROJECT_VERSION", expected: "11", occurrences: 4)
    }
}
