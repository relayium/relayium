import XCTest

/// **Hardened Runtime is on for every shipping macOS bundle, in both
/// configurations, on both distribution channels.**
///
/// This is a project-file invariant with no runtime an ordinary test can
/// observe: `ENABLE_HARDENED_RUNTIME` is off by default, so a target that never
/// sets it builds, links, runs and tests exactly like one that does.
///
/// **What Apple actually requires, kept straight, because the two channels are
/// not symmetric.** Hardened Runtime is mandatory for *notarization*, which the
/// direct download goes through: an unhardened build is refused there, and that
/// refusal looks nothing like a code change. App Sandbox is what Apple requires
/// of a *Mac App Store* submission; Apple does not document Hardened Runtime as
/// a condition of App Store review, so nothing here should be read as claiming
/// a submission would be rejected without it.
///
/// **Why the App Store targets carry it anyway**, and why that is asserted
/// rather than left to habit: it is this project's secure default, and it keeps
/// the two channels the same app. The protections are worth having on their own
/// terms — the App Store binary is the same code as the notarized one — and a
/// setting that differs per channel is a difference that has to be remembered
/// every time either build is touched. Parity means the answer is the same
/// everywhere.
///
/// The two App Store targets are the reason this file exists: they were added
/// with the App Sandbox entitlements the store does require and *without* this
/// setting, so `xcodebuild -showBuildSettings` resolved
/// `ENABLE_HARDENED_RUNTIME = NO` for all four of their configurations while
/// the direct pair resolved `YES`.
///
/// **Read per target and per configuration, not as a whole-file scan.** The
/// point of the claim is that no *individual* configuration is missing the
/// setting; counting occurrences across the file would pass on a project where
/// one target carries it twice and another not at all. Targets are reached
/// through their `XCConfigurationList`, because the four app/extension
/// configurations cannot be told apart by bundle identifier — the App Store app
/// and the direct app deliberately share `com.relayium.mac`, and both Share
/// extensions share `com.relayium.mac.Share` (`StoreKitLinkageTests`).
final class MacHardenedRuntimeTests: XCTestCase {
    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
    }

    private func projectText() throws -> String {
        try String(
            contentsOf: repoRoot.appendingPathComponent(
                "apps/mac/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)
    }

    /// Every `XCBuildConfiguration` in the macOS project, keyed by its object id.
    ///
    /// Split on the `isa` line the way `IOSDistributionSigningTests` does, with
    /// one addition: the object id is recovered from the *preceding* component's
    /// last `A1…` token, because a configuration is only useful here once it can
    /// be attributed to the target whose list names it.
    ///
    /// Multi-line settings such as `LD_RUNPATH_SEARCH_PATHS` contribute no
    /// ` = ` lines of their own and are skipped; `name = <configuration>;`
    /// closes the block.
    private func configurationsByID() throws
        -> [String: (name: String, settings: [String: String])] {
        let parts = try projectText().components(separatedBy: "isa = XCBuildConfiguration;")
        var blocks: [String: (name: String, settings: [String: String])] = [:]
        for index in 1..<parts.count {
            guard let id = parts[index - 1]
                .components(separatedBy: .whitespacesAndNewlines)
                .last(where: { $0.hasPrefix("A1") })
            else { continue }
            var settings: [String: String] = [:]
            var name = ""
            for line in parts[index].components(separatedBy: "\n") {
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
            blocks[id] = (name, settings)
        }
        XCTAssertGreaterThanOrEqual(blocks.count, 10,
                                    "read \(blocks.count) build configurations; the parser "
                                    + "no longer matches the project file")
        return blocks
    }

    /// The configurations a named native target builds with, by configuration name.
    ///
    /// Exactly `Debug` and `Release` are required. A target that grew a third
    /// configuration, or lost one, fails here rather than passing on the two
    /// this file happens to name.
    private func configurations(ofTarget target: String,
                                file: StaticString = #filePath,
                                line: UInt = #line) throws -> [String: [String: String]] {
        let project = try projectText()
        let marker = "Build configuration list for PBXNativeTarget \"\(target)\" */ = {"
        let start = try XCTUnwrap(project.range(of: marker),
                                  "no configuration list for \(target)", file: file, line: line)
        let rest = project[start.upperBound...]
        let end = try XCTUnwrap(rest.range(of: "\n\t\t};"), file: file, line: line)
        let ids = rest[..<end.lowerBound].components(separatedBy: "\n")
            .compactMap { line -> String? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("A1"), let space = trimmed.firstIndex(of: " ") else {
                    return nil
                }
                return String(trimmed[..<space])
            }

        let blocks = try configurationsByID()
        var byName: [String: [String: String]] = [:]
        for id in ids {
            let block = try XCTUnwrap(blocks[id],
                                      "\(target) names configuration \(id), which has no block",
                                      file: file, line: line)
            byName[block.name] = block.settings
        }
        XCTAssertEqual(Set(byName.keys), ["Debug", "Release"],
                       "\(target) no longer has exactly a Debug and a Release configuration",
                       file: file, line: line)
        return byName
    }

    /// The four bundles that are actually distributed, on both channels.
    ///
    /// `RelayiumUITests` is absent on purpose: a test bundle is never submitted
    /// or notarized, and hardening it would only constrain the debugger.
    private let shippingTargets = ["Relayium", "RelayiumShare",
                                   "RelayiumAppStore", "RelayiumShareAppStore"]

    /// Every shipping target hardens both of its configurations, and says so
    /// itself.
    ///
    /// The value is read out of the target's own configuration block rather than
    /// resolved, so "inherited from somewhere" cannot satisfy it: the project
    /// level does not set it, and Xcode's default is `NO`, so an absent key here
    /// is a build that ships unhardened.
    func testEveryShippingMacBundleEnablesTheHardenedRuntime() throws {
        for target in shippingTargets {
            let configurations = try configurations(ofTarget: target)
            for name in ["Debug", "Release"] {
                let settings = configurations[name] ?? [:]
                XCTAssertEqual(settings["ENABLE_HARDENED_RUNTIME"], "YES",
                               "\(target) \(name) does not enable the hardened runtime; "
                               + "the default is NO, so an absent key ships unhardened")
            }
        }
    }

    /// Hardening is an *addition* to the sandbox, not a substitute for it.
    ///
    /// The sandbox is the half Apple requires of a Mac App Store submission;
    /// hardening is the half this project adds for parity with the notarized
    /// channel. They are separate switches — the entitlement is a file, the
    /// runtime is a build setting — so a change that satisfied one by dropping
    /// the other would be a regression this file's subject makes easy to miss.
    /// The entitlements files themselves are asserted in full by
    /// `StoreKitLinkageTests` and `MacSurfaceGuardTests`; this only pins the
    /// pairing.
    func testTheAppStoreBundlesAreBothSandboxedAndHardened() throws {
        for (target, entitlements) in [
            ("RelayiumAppStore", "apps/mac/RelayiumAppStore/Relayium.entitlements"),
            ("RelayiumShareAppStore", "apps/mac/RelayiumShare/RelayiumShare.entitlements"),
        ] {
            let data = try Data(contentsOf: repoRoot.appendingPathComponent(entitlements))
            let plist = try XCTUnwrap(
                try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                    as? [String: Any])
            XCTAssertEqual(plist["com.apple.security.app-sandbox"] as? Bool, true,
                           "\(target) is not sandboxed")
            for name in ["Debug", "Release"] {
                XCTAssertEqual(try configurations(ofTarget: target)[name]?["ENABLE_HARDENED_RUNTIME"],
                               "YES",
                               "\(target) \(name) is sandboxed but not hardened")
            }
        }
    }
}
