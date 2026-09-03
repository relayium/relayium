import XCTest

/// How an App Store archive of the iOS project is signed.
///
/// These repository-level invariants keep distribution signing reproducible
/// across developer and CI machines. They are asserted per configuration rather
/// than across the file:
///
///  - **Which certificate.** Release explicitly names the team's installed
///    distribution-certificate class.
///  - **Which profile, for each of the two bundles.** An app and its appex need
///    two *different* App Store profiles.
///
/// Debug is the other half of the assertion. It stays `Automatic`, because the
/// day-to-day flow is a developer running on their own device with their own
/// team, and pinning a distribution profile there would break that for a signing
/// mode Debug never uses.
///
/// The values live in the `.pbxproj` — no `.xcconfig` and no export-options
/// plist exist for this project — so that is where they are read from, the same
/// way `BundleVersionTests` reads the versions.
final class IOSDistributionSigningTests: XCTestCase {

    /// Every `XCBuildConfiguration` block in the iOS project, as its
    /// configuration name plus its settings.
    ///
    /// Read per block rather than per key: the point of these assertions is that
    /// Debug and Release differ, and a whole-file scan of the kind
    /// `BundleVersionTests` uses — which is right for a value that must be the
    /// same everywhere — cannot see which configuration a value came from.
    ///
    /// Multi-line settings such as `LD_RUNPATH_SEARCH_PATHS` contribute no
    /// ` = ` lines of their own and are skipped; `name = <configuration>;`
    /// closes the block.
    private func configurations() throws -> [(name: String, settings: [String: String])] {
        let project = try RepoRoot.text("apps/ios/Relayium.xcodeproj/project.pbxproj")
        return project
            .components(separatedBy: "isa = XCBuildConfiguration;")
            .dropFirst()
            .map { block in
                var settings: [String: String] = [:]
                var name = ""
                for line in block.components(separatedBy: "\n") {
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    guard let separator = trimmed.range(of: " = ") else { continue }
                    let key = String(trimmed[trimmed.startIndex..<separator.lowerBound])
                    let value = trimmed[separator.upperBound...]
                        .trimmingCharacters(in: CharacterSet(charactersIn: ";\" "))
                    if key == "name" {
                        name = value
                        break
                    }
                    settings[key] = value
                }
                return (name, settings)
            }
    }

    /// The one configuration of `configuration` belonging to `bundleID`.
    ///
    /// Blocks are matched by the bundle identifier they set rather than by their
    /// object id, which also excludes the project-level pair: those configure
    /// neither target and name no bundle. Exactly one match is required, so a
    /// third target — or a configuration that quietly lost the setting — fails
    /// here rather than passing vacuously.
    private func configuration(_ configuration: String,
                               of bundleID: String,
                               file: StaticString = #filePath,
                               line: UInt = #line) throws -> [String: String] {
        let matches = try configurations().filter {
            $0.name == configuration && $0.settings["PRODUCT_BUNDLE_IDENTIFIER"] == bundleID
        }
        XCTAssertEqual(matches.count, 1,
                       "expected one \(configuration) configuration for \(bundleID), "
                       + "found \(matches.count)",
                       file: file, line: line)
        return matches.first?.settings ?? [:]
    }

    /// The app's bundle id, which iOS shares with macOS: Apple requires every
    /// platform in one universal-purchase App Store record to carry the same
    /// Bundle ID, and both platforms live under Apple ID 6801142976.
    private let app = "com.relayium.mac"
    /// The iOS Share Extension. `com.relayium.mac.Share` is the macOS
    /// extension's identifier and a plausible wrong answer here. The portal
    /// settles which one is correct: the target iOS TestFlight build's Build
    /// Metadata under Apple ID 6801142976 names the Share Extension
    /// application identifier `7PVYUG4YQS.com.relayium.mac.ShareIOS`, and this
    /// project must match that already-validated identity.
    private let share = "com.relayium.mac.ShareIOS"

    /// Release names the certificate and the profile, for both bundles.
    ///
    /// The identity is the generic `iPhone Distribution` rather than the full
    /// `iPhone Distribution: <name> (<team>)`: Xcode resolves the generic form
    /// against the keychain, and it keeps a person's name out of the repository.
    /// `DEVELOPMENT_TEAM` is asserted alongside it because the profile names are
    /// only unique within the team that issued them.
    func testReleaseSignsBothBundlesManuallyForTheAppStore() throws {
        for (bundleID, profile) in [(app, "Relayium iOS Universal App Store"),
                                    (share, "Relayium iOS Share Extension App Store")] {
            let settings = try configuration("Release", of: bundleID)
            XCTAssertEqual(settings["CODE_SIGN_STYLE"], "Manual",
                           "\(bundleID) Release does not sign manually")
            XCTAssertEqual(settings["CODE_SIGN_IDENTITY"], "iPhone Distribution",
                           "\(bundleID) Release does not name the distribution certificate")
            XCTAssertEqual(settings["PROVISIONING_PROFILE_SPECIFIER"], profile,
                           "\(bundleID) Release does not name its App Store profile")
            XCTAssertEqual(settings["DEVELOPMENT_TEAM"], "7PVYUG4YQS", bundleID)
        }
    }

    /// And the two profiles are not the same one.
    ///
    /// Asserted separately from the exact names above because this is the
    /// copy-paste error this guard is intended to catch.
    func testTheAppAndItsExtensionUseDifferentProfiles() throws {
        let appProfile = try configuration("Release", of: app)["PROVISIONING_PROFILE_SPECIFIER"]
        let shareProfile = try configuration("Release", of: share)["PROVISIONING_PROFILE_SPECIFIER"]
        XCTAssertNotNil(appProfile)
        XCTAssertNotEqual(appProfile, shareProfile,
                          "the app and its extension name one profile; each bundle id needs its own")
    }

    /// Debug is left alone, and that is deliberate rather than untouched.
    ///
    /// A pinned distribution profile in Debug would fail on any machine that
    /// does not hold it, for a build that is never distributed.
    func testDebugStaysAutomaticForDevelopment() throws {
        for bundleID in [app, share] {
            let settings = try configuration("Debug", of: bundleID)
            XCTAssertEqual(settings["CODE_SIGN_STYLE"], "Automatic",
                           "\(bundleID) Debug no longer signs automatically")
            XCTAssertNil(settings["PROVISIONING_PROFILE_SPECIFIER"],
                         "\(bundleID) Debug pins a provisioning profile")
            XCTAssertNil(settings["CODE_SIGN_IDENTITY"],
                         "\(bundleID) Debug pins a signing certificate")
        }
    }

    /// Neither bundle declares export compliance, and neither should.
    ///
    /// `ITSAppUsesNonExemptEncryption` is a legal statement about this app's use
    /// of encryption, not a build setting. Present and `true` it asks for
    /// documentation the project has not filed; present and `false` it claims an
    /// exemption nobody has assessed — and Relayium encrypts user content, so
    /// the convenient value is the one most likely to be wrong. Absent, App
    /// Store Connect asks a human once per upload, which is where a legal
    /// statement belongs.
    func testNeitherBundleDeclaresExportCompliance() throws {
        for path in ["apps/ios/Relayium/Info.plist", "apps/ios/RelayiumShare/Info.plist"] {
            let data = try RepoRoot.data(path)
            let plist = try XCTUnwrap(
                try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                    as? [String: Any])
            XCTAssertNil(plist["ITSAppUsesNonExemptEncryption"],
                         "\(path) answers the export-compliance question in the build")
        }
    }
}
