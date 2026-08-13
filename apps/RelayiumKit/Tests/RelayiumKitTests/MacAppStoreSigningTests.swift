import XCTest

/// **How each macOS distribution channel decides which certificate signs it —
/// and the one combination Xcode refuses to build.**
///
/// The two channels answer that question in opposite, deliberate ways:
///
///  - **Direct download** signs *manually*. The project names the certificate
///    class (`Developer ID Application`) and the exact provisioning profile,
///    because that channel's assets exist, are stable, and are what the release
///    script and notarization expect.
///  - **Mac App Store** signs *automatically*. The project names the team and
///    nothing else; Xcode resolves the certificate and profile against the
///    signed-in account when the archive is produced and exported.
///
/// **The invariant, and why it is not a matter of taste.** Those two are
/// mutually exclusive per configuration. `CODE_SIGN_STYLE = Automatic` means
/// Xcode chooses the identity; an explicit `CODE_SIGN_IDENTITY` alongside it
/// means the project has already chosen a different one, and Xcode rejects the
/// pair outright rather than picking a winner:
///
/// ```
/// error: RelayiumAppStore has conflicting provisioning settings.
/// RelayiumAppStore is automatically signed for development, but a conflicting
/// code signing identity Apple Distribution has been manually specified.
/// ```
///
/// That is the exact text a real `xcodebuild … -scheme RelayiumAppStore archive`
/// produced for **both** App Store targets, and it is the reason this file
/// exists. The failure is invisible to everything the project already runs:
/// `CODE_SIGNING_ALLOWED=NO` unsigned Release builds — the compilation gate both
/// App Store targets are covered by — never consult a signing identity at all,
/// so all four configurations built clean while no archive could be produced.
///
/// **What is deliberately not claimed here.** Nothing in this file asserts that
/// Apple *requires* automatic signing for a Mac App Store submission; it does
/// not. Manual signing with an explicit `Apple Distribution` identity and a
/// matching App Store profile is equally valid, and is exactly what the iOS
/// project does (`IOSDistributionSigningTests`). The claim is narrower and
/// purely mechanical: **whichever** style a configuration picks, it must pick
/// only one. macOS chose automatic because, unlike iOS, its App Store
/// certificate and profiles are not yet issued — pinning names for assets that
/// do not exist would replace one hard failure with another.
///
/// The correct fix therefore removes the pinned identity rather than adding to
/// it. Xcode's own error text suggests the other repair — setting the identity
/// to `Apple Development` — and this project declines it: hard-coding a
/// *development* certificate into the configuration whose only purpose is store
/// distribution reintroduces the same contradiction with a value that happens
/// not to trip the check.
///
/// Read per target and per configuration through `MacProjectFile`, because the
/// App Store app and the direct app share a bundle identifier and cannot be told
/// apart any other way.
final class MacAppStoreSigningTests: XCTestCase {

    private let appStoreTargets = ["RelayiumAppStore", "RelayiumShareAppStore"]
    private let directTargets = ["Relayium", "RelayiumShare"]
    private let team = "7PVYUG4YQS"

    /// Ad-hoc signing. Legal next to `Automatic` — it is not a claim about
    /// *which* account's certificate to use, so there is nothing for automatic
    /// resolution to conflict with. `RelayiumUITests` uses exactly this pair.
    private let adHoc = "-"

    // MARK: - The regression

    /// **Neither App Store target pins a signing certificate.**
    ///
    /// This is the assertion that fails on the configuration that could not
    /// archive: all four App Store configurations carried
    /// `CODE_SIGN_IDENTITY = "Apple Distribution"` beside
    /// `CODE_SIGN_STYLE = Automatic`.
    ///
    /// Absence is the whole point, so it is asserted as absence. With the key
    /// gone, `xcodebuild -showBuildSettings` resolves the identity from the
    /// automatic-signing machinery instead of the project file — on a machine
    /// holding no distribution certificate it resolves `Apple Development`,
    /// which is the honest answer for that machine and is a value no source file
    /// here has stated.
    func testNeitherAppStoreTargetPinsASigningIdentity() throws {
        let project = try MacProjectFile()
        for target in appStoreTargets {
            let configurations = try project.configurations(ofTarget: target)
            for (name, settings) in configurations {
                XCTAssertEqual(settings["CODE_SIGN_STYLE"], "Automatic",
                               "\(target) \(name) no longer signs automatically")
                XCTAssertNil(settings["CODE_SIGN_IDENTITY"],
                             "\(target) \(name) pins a signing certificate beside automatic "
                             + "signing; Xcode refuses that pair as conflicting provisioning "
                             + "settings and the archive fails before it starts")
                XCTAssertNil(settings["PROVISIONING_PROFILE_SPECIFIER"],
                             "\(target) \(name) pins a provisioning profile beside automatic "
                             + "signing; automatic signing resolves the profile itself")
            }
        }
    }

    /// **No configuration anywhere in the macOS project combines automatic
    /// signing with a named certificate.**
    ///
    /// The test above names the two targets that had the defect. This one is the
    /// general form, swept across every configuration in the file, so a third
    /// target added later — or a configuration this file forgot — cannot
    /// reintroduce the same conflict somewhere the named list does not reach.
    ///
    /// Ad-hoc `-` is exempt and that exemption is narrow: it names no account,
    /// so it is not the kind of choice automatic resolution can contradict.
    func testNoConfigurationCombinesAutomaticSigningWithANamedCertificate() throws {
        let blocks = try MacProjectFile().configurationsByID()
        for (id, block) in blocks {
            guard block.settings["CODE_SIGN_STYLE"] == "Automatic",
                  let identity = block.settings["CODE_SIGN_IDENTITY"],
                  identity != adHoc
            else { continue }
            XCTFail("configuration \(id) (\(block.name)) signs automatically but also names "
                    + "the certificate \"\(identity)\"; Xcode rejects that pair as conflicting "
                    + "provisioning settings. Drop the identity, or switch this configuration "
                    + "to CODE_SIGN_STYLE = Manual and name its profile too")
        }
    }

    /// Automatic signing still has an account to resolve *against*.
    ///
    /// Removing the identity moves the choice to Xcode; `DEVELOPMENT_TEAM` is
    /// what tells Xcode whose certificates to choose among. Without it the
    /// targets would fail differently and just as fatally, so it is asserted
    /// here rather than assumed — this is the setting the repair depends on.
    func testBothAppStoreTargetsNameTheTeamAutomaticSigningResolvesAgainst() throws {
        let project = try MacProjectFile()
        for target in appStoreTargets {
            for (name, settings) in try project.configurations(ofTarget: target) {
                XCTAssertEqual(settings["DEVELOPMENT_TEAM"], team,
                               "\(target) \(name) does not name the team; automatic signing has "
                               + "no account whose certificates it can resolve")
            }
        }
    }

    // MARK: - The other channel, which must not be repaired by accident

    /// **The direct download still signs manually, with its own certificate and
    /// its own profiles.**
    ///
    /// This is the guard against the wrong repair. "Make the conflict go away"
    /// has a second solution — turn the whole project automatic — and it would
    /// silently break the notarized channel, whose release script, stapling and
    /// Gatekeeper gates all expect a `Developer ID Application` signature that
    /// only manual signing guarantees. The direct pair is untouched by the App
    /// Store change and this asserts that it stayed that way.
    func testTheDirectChannelStillSignsManuallyWithDeveloperID() throws {
        let project = try MacProjectFile()
        for target in directTargets {
            for (name, settings) in try project.configurations(ofTarget: target) {
                XCTAssertEqual(settings["CODE_SIGN_STYLE"], "Manual",
                               "\(target) \(name) no longer signs manually")
                XCTAssertEqual(settings["CODE_SIGN_IDENTITY"], "Developer ID Application",
                               "\(target) \(name) does not name the Developer ID certificate")
                XCTAssertEqual(settings["DEVELOPMENT_TEAM"], team, "\(target) \(name)")
                XCTAssertNotNil(settings["PROVISIONING_PROFILE_SPECIFIER"],
                                "\(target) \(name) signs manually but names no profile")
            }
        }
    }

    /// The direct app and its extension name two *different* profiles.
    ///
    /// Two bundle identifiers need two profiles; one name in both places is the
    /// copy-paste error, and it is the same one `IOSDistributionSigningTests`
    /// checks for on iOS. Only the manual channel can have this defect — the App
    /// Store targets name no profile at all.
    func testTheDirectAppAndItsExtensionUseDifferentProfiles() throws {
        let project = try MacProjectFile()
        let profile = "PROVISIONING_PROFILE_SPECIFIER"
        let appConfigurations = try project.configurations(ofTarget: "Relayium")
        let shareConfigurations = try project.configurations(ofTarget: "RelayiumShare")
        for configuration in ["Debug", "Release"] {
            let app = appConfigurations[configuration]?[profile]
            let share = shareConfigurations[configuration]?[profile]
            XCTAssertNotNil(app, configuration)
            XCTAssertNotEqual(app, share,
                              "the direct app and its extension name one profile in "
                              + "\(configuration); each bundle identifier needs its own")
        }
    }

    // MARK: - What the change was not allowed to move

    /// The settings that decide *what is signed* are untouched by the change to
    /// *who signs it*.
    ///
    /// Removing a key from four configuration blocks is a small enough edit to
    /// be made by hand in the wrong block, and `project.pbxproj` gives no help
    /// distinguishing them. These are the neighbouring values in exactly those
    /// blocks: the entitlements file that makes the bundle a store bundle, the
    /// bundle identifier, and the hardened runtime. Their own reasons are argued
    /// in `MacHardenedRuntimeTests` and `StoreKitLinkageTests`; this pins them as
    /// the blast radius of this edit.
    func testTheAppStoreBundlesKeepTheirEntitlementsIdentifiersAndHardening() throws {
        let project = try MacProjectFile()
        for (target, entitlements, bundleID) in [
            ("RelayiumAppStore", "RelayiumAppStore/Relayium.entitlements", "com.relayium.mac"),
            ("RelayiumShareAppStore", "RelayiumShare/RelayiumShare.entitlements",
             "com.relayium.mac.Share"),
        ] {
            for (name, settings) in try project.configurations(ofTarget: target) {
                XCTAssertEqual(settings["CODE_SIGN_ENTITLEMENTS"], entitlements,
                               "\(target) \(name) lost its entitlements file")
                XCTAssertEqual(settings["PRODUCT_BUNDLE_IDENTIFIER"], bundleID,
                               "\(target) \(name) lost its bundle identifier")
                XCTAssertEqual(settings["ENABLE_HARDENED_RUNTIME"], "YES",
                               "\(target) \(name) lost the hardened runtime")
            }
        }
    }
}
