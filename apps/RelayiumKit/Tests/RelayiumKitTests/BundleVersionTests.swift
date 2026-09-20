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
        // `1.4.1 (39)`: the relay-credential renewal release. A cross-network
        // link that has carried real user activity can now ask for a fresh
        // relay credential before its deadline, and the deadline moves only
        // once the connection has verifiably migrated onto the new credential;
        // the pairing and negotiated-transfer bounds hardening rides with it.
        // **Build `38` is spent twice over**: it is the build number of the
        // public Developer ID/GitHub `macos-v1.4.0` DMG AND of the App Store
        // Connect upload that went to internal TestFlight on 2026-09-16 and
        // that Apple has since published as the Mac App Store `1.4.0` release
        // (public 2026-09-17). Newly signed distribution artifacts cannot
        // answer to a number two public artifacts already answer to, so
        // this candidate takes `39` and, per the owner's 2026-09-17 preference
        // for a distinct visible version on every newly distributed candidate,
        // its own marketing version.
        //
        // `1.4.0 (38)`: the same release, with the window chrome fix for the
        // opaque title bar that covered the toolbar on macOS 15. **Build `37`
        // is spent**: its Mac App Store package was archived, exported and
        // validated by Apple but never uploaded, and a changed product cannot
        // answer to a signed artifact's number.
        //
        // `1.4.0 (37)`: the same release, Apple Silicon only. The owner dropped
        // Intel for both GitHub and TestFlight on 2026-09-16, after build `36`
        // had already been archived universal for the Mac App Store. That archive
        // was never exported or uploaded, but it is a signed artifact answering to
        // `1.4.0 (36)`, so it is abandoned and **build `36` is spent**; the arm64
        // artifacts take `37`.
        //
        // `1.4.0 (36)`: the public release of that preview — universal Developer
        // ID/GitHub and internal TestFlight. **Build `35` is spent** as the
        // private arm64 owner-preview package the owner accepted, and newly
        // signed distribution artifacts cannot answer to it, so the release
        // takes the next build and keeps the accepted marketing version. The
        // App Store Connect macOS floor read back on 2026-09-16 was `29`.
        //
        // `1.4.0 (35)`: the preview that removes the sidebar's destination
        // search. `1.3.14 (34)` was the private Device Inbox check-now preview,
        // so this candidate takes the next build and its own marketing version.
        //
        // `1.3.14 (34)`: the Device Inbox check-now preview. `1.3.13 (33)` was
        // the private all-surface alignment preview, so this candidate takes the
        // next build and its own marketing version.
        //
        // `1.3.13 (33)`: the all-surface alignment preview. Builds `31` and
        // `32` were the private 1.3.12 UI previews, so the next candidate takes
        // the next build and its own marketing version rather than a third
        // artifact answering to `1.3.12`.
        //
        // **Build `30` is spent**: it was signed and packaged at
        // `1.3.11` as a private owner-preview candidate on 2026-09-16, so the
        // interaction follow-up after it takes the next build and its own
        // marketing version rather than a second artifact answering to `1.3.11`.
        //
        // **`1.3.10 (28)` is spent**, and the marketing version
        // moves with it rather than only the build. An authenticated App Store
        // Connect read-back on 2026-09-07 shows build `28` uploaded and `VALID`
        // on the universal-purchase record, with the `1.3.10` macOS version in
        // `PENDING_DEVELOPER_RELEASE` — approved and awaiting a manual release.
        // The Developer ID/GitHub `1.3.10` is separately public. Two artifacts
        // therefore already answer to `1.3.10` — one public on that channel, one
        // approved and awaiting release on the App Store — so a candidate that
        // carries the newer cross-platform navigation work cannot reuse that
        // number without making the version string stop identifying a build.
        try assertOneVersion("mac", key: "MARKETING_VERSION", expected: "1.4.1", occurrences: 10)
        try assertOneVersion("mac", key: "CURRENT_PROJECT_VERSION", expected: "39", occurrences: 10)
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
        // 0.4.1 carries the relay-credential renewal that 0.4.0 (9) predates:
        // build 9 was archived from `4d694a9e`, an ancestor of the renewal
        // commit, so a build from this tree is a product change rather than a
        // rebuild and takes its own visible version under the same 2026-09-17
        // preference. It is still not an App Store version on the record. The
        // 0.3.1 App Store version is separate and, on a 2026-09-20 read-back,
        // DEVELOPER_REJECTED and still manual; nothing here touches it.
        try assertOneVersion("ios", key: "MARKETING_VERSION", expected: "0.4.1", occurrences: 4)
        //
        // 9 is consumed: 0.4.0 (9) was archived, exported and uploaded to
        // internal TestFlight on 2026-09-18 from `4d694a9e` and read back
        // VALID, so this candidate takes 10. The build number stays monotonic
        // across version changes — it did not restart for 0.3.2 or 0.4.0 and
        // does not restart for 0.4.1 — and iOS carries its own pre-release
        // sequence on the universal-purchase record, independent of macOS,
        // whose builds reached 39. 10 is a project value here: nothing has
        // been archived or uploaded under it, and the highest consumed build
        // must be read back again before it is.
        try assertOneVersion("ios", key: "CURRENT_PROJECT_VERSION", expected: "10", occurrences: 4)
    }
}
