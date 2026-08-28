import XCTest
@testable import RelayiumAppKit
@testable import RelayiumStoreKit

/// **Which binary is allowed to contain StoreKit, and which is allowed to
/// contain Sparkle.**
///
/// This file replaces `StoreKitBoundaryTests`, whose central claim was that *no*
/// app target linked the StoreKit adapter. That claim was correct for the batch
/// that built the adapter without shipping it, and it is exactly what the Mac
/// App Store product has to break. Deleting it would have left nothing at all,
/// so what is here instead is the narrower and now two-sided set of claims:
///
///  1. exactly one file imports StoreKit, and it is the isolated target's;
///  2. no other package source names the framework or its types;
///  3. **the direct target links Sparkle and not the adapter; the App Store
///     target links the adapter and not Sparkle** — read out of the project file
///     per target, not by searching it as text;
///  4. the App Store entitlements carry no Sparkle Mach-lookup exception, and
///     its Info.plist carries no Sparkle keys;
///  5. iOS links the adapter in the app target and never in its Share extension;
///  6. the shared source really is shared — one copy of the scene, the settings
///     window and the account screen, compiled by both targets through a
///     target-specific seam rather than duplicated;
///  7. no product identifier is compiled into anything shippable: the catalog
///     comes from the server;
///  8. the direct build keeps the web plan hand-off it has always had;
///  9. **the purchase surface carries a working privacy policy and terms link**,
///     unconditionally, through the same environment boundary every other URL
///     goes through;
/// 10. **the adapter resolves the product before it asks the app to arm a
///     sheet, and charges immediately after** — the one ordering that decides
///     whether a routine lookup failure is retryable or locks the account.
///
/// Absences have no runtime to observe, which is why these are read out of the
/// sources and the project files that decide what a binary contains.
final class StoreKitLinkageTests: XCTestCase {

    /// `apps/` and the trees under it, discovered rather than counted, and each
    /// checked for existing.
    private var appsRoot: URL { get throws { try RepoRoot.apps() } }
    private var packageRoot: URL { get throws { try RepoRoot.package() } }
    private var sourcesRoot: URL {
        get throws { try RepoRoot.directory("apps/RelayiumKit/Sources") }
    }
    private var adapterRoot: URL {
        get throws { try RepoRoot.directory("apps/RelayiumKit/Sources/RelayiumStoreKit") }
    }
    private var iosRoot: URL { get throws { try RepoRoot.directory("apps/ios") } }
    private var macRoot: URL { get throws { try RepoRoot.directory("apps/mac") } }

    /// Every Swift source under a root, as (path relative to `apps/`, code).
    ///
    /// Whole-line comments are dropped, the same loader the other guards use and
    /// for the same reason: these files explain at length what they deliberately
    /// do NOT do, so scanning raw text would fail on the very prose documenting
    /// the absence being checked. Trailing comments are NOT stripped, so a
    /// banned symbol mentioned after code on the same line still fails — the
    /// wanted direction, since the fix is to move the comment.
    private func sources(under root: URL, atLeast minimum: Int) throws
        -> [(path: String, code: String)] {
        let names = try FileManager.default.subpathsOfDirectory(atPath: root.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
        XCTAssertGreaterThanOrEqual(names.count, minimum,
                                    "found \(names.count) sources at \(root.path)")
        let appsPrefix = try appsRoot.path + "/"
        return try names.map { name in
            let raw = try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
            let code = raw.components(separatedBy: "\n")
                .filter { line in
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("*")
                        && !trimmed.hasPrefix("/*")
                }
                .joined(separator: "\n")
            let relative = root.appendingPathComponent(name).path
                .replacingOccurrences(of: appsPrefix, with: "")
            return (relative, code)
        }
    }

    /// Everything a shipped binary could be built from: both app trees and every
    /// package source. Deliberately not the tests — a test naming StoreKit is a
    /// test, not a product.
    private func everyShippableSource() throws -> [(path: String, code: String)] {
        try sources(under: try sourcesRoot, atLeast: 60)
            + sources(under: try iosRoot, atLeast: 12)
            + sources(under: try macRoot, atLeast: 30)
    }

    private func projectText(_ platform: String) throws -> String {
        try String(contentsOf: try appsRoot.appendingPathComponent(
            "\(platform)/Relayium.xcodeproj/project.pbxproj"), encoding: .utf8)
    }

    // MARK: - 1 & 2: one import, in one target

    /// **The framework is named in exactly one file.**
    ///
    /// Not "the iOS app does not import it" — that would leave `RelayiumAppKit`,
    /// which both apps link, free to acquire the dependency and drag it into
    /// every binary. The claim is the whole tree.
    func testStoreKitIsImportedByExactlyOneSourceAndItIsTheAdapters() throws {
        let importers = try everyShippableSource()
            .filter { $0.code.contains("import StoreKit") }
            .map(\.path)
        XCTAssertEqual(importers,
                       ["RelayiumKit/Sources/RelayiumStoreKit/StoreKitSubscriptionStore.swift"],
                       "StoreKit is imported somewhere other than the isolated adapter")
    }

    /// And nothing else NAMES it, in any form — not the module, not the types
    /// only it can provide.
    ///
    /// **One file is exempt, by name**: the App Store target's half of the
    /// distribution seam, which is the single place an app is allowed to say
    /// `import RelayiumStoreKit` and construct the adapter. Exempting it by an
    /// exact path rather than by a pattern is what keeps a second such file from
    /// appearing unnoticed. Everything StoreKit's OWN API surface can name stays
    /// banned there too: the adapter is still the only thing that touches it,
    /// and a type crossing the seam would make the isolation decorative.
    func testNoSourceOutsideTheAdapterNamesStoreKitOrItsTypes() throws {
        let storeKitAPI = ["import StoreKit", "Transaction.updates",
                           "Transaction.currentEntitlements", "Product.products",
                           "AppStore.sync", "VerificationResult", "jwsRepresentation",
                           "Product.PurchaseResult", "Product.PurchaseOption"]
        // The adapter's MODULE name is a link-level fact, allowed only where the
        // App Store target assembles its store.
        let moduleImporters: Set<String> = [
            "mac/Relayium/Distribution/AppStoreDistribution.swift",
            "ios/Relayium/AppleSubscriptions.swift",
        ]
        for (path, code) in try everyShippableSource() {
            guard !path.hasPrefix("RelayiumKit/Sources/RelayiumStoreKit/") else { continue }
            for symbol in storeKitAPI {
                XCTAssertFalse(code.contains(symbol),
                               "\(path) names \(symbol) outside the isolated adapter")
            }
            if !moduleImporters.contains(path) {
                XCTAssertFalse(code.contains("RelayiumStoreKit"),
                               "\(path) names the adapter module outside an App Store app seam")
            }
        }
        // And both exempt files really assemble the real adapter. AppKit must
        // provide a confirmation window; iOS keeps the platform-default path.
        let shippable = try everyShippableSource()
        for moduleImporter in moduleImporters {
            let seam = try XCTUnwrap(shippable.first { $0.path == moduleImporter },
                                     "the App Store app seam is gone: \(moduleImporter)")
            XCTAssertTrue(seam.code.contains("import RelayiumStoreKit"))
        }
        let mac = try XCTUnwrap(shippable.first {
            $0.path == "mac/Relayium/Distribution/AppStoreDistribution.swift"
        })
        XCTAssertTrue(mac.code.contains("StoreKitSubscriptionStore(purchaseWindow:"),
                      "the AppKit store is not given a confirmation window")
        let ios = try XCTUnwrap(shippable.first {
            $0.path == "ios/Relayium/AppleSubscriptions.swift"
        })
        XCTAssertTrue(ios.code.contains("StoreKitSubscriptionStore()"),
                      "the iOS app no longer builds the platform-default store")
    }

    func testMacOSPurchasesUseTheWindowBoundStoreKitAPI() throws {
        let adapter = try String(contentsOf: try adapterRoot.appendingPathComponent(
            "StoreKitSubscriptionStore.swift"), encoding: .utf8)
        XCTAssertTrue(adapter.contains("#available(macOS 15.2, *)"),
                      "the window-bound API lacks its deployment-target fallback")
        XCTAssertTrue(adapter.contains("product.purchase(confirmIn: window, options: options)"),
                      "the AppKit purchase is no longer confirmed in its window")
        XCTAssertTrue(adapter.contains("product.purchase(options: options)"),
                      "macOS 13–15.1 or another supported platform has no fallback")
        XCTAssertTrue(adapter.contains("Self.normalizedPurchaseResult"),
                      "the production purchase path bypasses typed StoreKit cancellation normalization")

        let mac = try String(contentsOf: try macRoot.appendingPathComponent(
            "Relayium/Distribution/AppStoreDistribution.swift"), encoding: .utf8)
        for anchor in ["NSApp.keyWindow", "NSApp.mainWindow", "NSApp.orderedWindows"] {
            XCTAssertTrue(mac.contains(anchor), "the AppKit window provider lost \(anchor)")
        }
        let ios = try String(contentsOf: try iosRoot.appendingPathComponent(
            "Relayium/AppleSubscriptions.swift"), encoding: .utf8)
        XCTAssertFalse(ios.contains("purchaseWindow"),
                       "the AppKit presentation contract leaked into iOS")
        XCTAssertFalse(ios.contains("NSWindow"),
                       "the iOS purchase path names an AppKit window")
    }

    /// The seam the rest of the app talks to names no store type at all — which
    /// is what lets the whole purchase policy run under `swift test` with no
    /// store, and what lets `RelayiumAppKit` stay linkable by a binary that has
    /// never heard of in-app purchase.
    func testTheSeamAndTheModelAreExpressedInPlainValues() throws {
        for name in ["SubscriptionStore.swift", "AppleSubscriptionModel.swift"] {
            let code = try sources(under: try sourcesRoot.appendingPathComponent("RelayiumAppKit"),
                                   atLeast: 40).first { $0.path.hasSuffix(name) }?.code
            let source = try XCTUnwrap(code, "\(name) is gone from RelayiumAppKit")
            XCTAssertFalse(source.contains("import StoreKit"))
            XCTAssertTrue(source.contains("import Foundation"),
                          "\(name) should need nothing but Foundation and the package")
        }
    }

    // MARK: - 3: which target links what

    /// The package products one macOS target links, resolved through the project
    /// file's own indirection.
    ///
    /// Searching the project as TEXT is what this replaces, and the difference
    /// matters now that one project holds two products: `text.contains(
    /// "RelayiumStoreKit")` is true for a project where the WRONG target links
    /// it. So the target's `packageProductDependencies` object ids are read,
    /// then resolved through `XCSwiftPackageProductDependency` to product names.
    private func linkedPackageProducts(ofTarget target: String,
                                       in project: String) throws -> Set<String> {
        // The target's own object block, from its name to the end of that block.
        let marker = "/* \(target) */ = {\n\t\t\tisa = PBXNativeTarget;"
        let start = try XCTUnwrap(project.range(of: marker),
                                  "no PBXNativeTarget named \(target)")
        let rest = project[start.upperBound...]
        let end = try XCTUnwrap(rest.range(of: "\n\t\t};"), "unterminated target \(target)")
        let block = String(rest[..<end.lowerBound])

        let depsMarker = "packageProductDependencies = ("
        guard let depsStart = block.range(of: depsMarker) else { return [] }
        let depsRest = block[depsStart.upperBound...]
        let depsEnd = try XCTUnwrap(depsRest.range(of: ");"))
        let ids = depsRest[..<depsEnd.lowerBound]
            .components(separatedBy: "\n")
            .compactMap { line -> String? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard let space = trimmed.firstIndex(of: " ") else { return nil }
                return String(trimmed[..<space])
            }

        return Set(try ids.map { id in
            let declaration = "\(id) /* "
            let at = try XCTUnwrap(project.range(of: declaration + ""),
                                   "unresolvable package product \(id)")
            let tail = project[at.upperBound...]
            let close = try XCTUnwrap(tail.range(of: " */"))
            return String(tail[..<close.lowerBound])
        })
    }

    /// **The two macOS products, and the one thing each may not contain.**
    ///
    /// Sparkle in an App Store build is a second update mechanism and grounds
    /// for rejection; StoreKit in the direct build is a claim to sell something
    /// that build cannot sell, on a channel where Apple takes no payment.
    /// Neither absence has a runtime, and both are decided here.
    func testEachMacTargetLinksItsOwnDistributionMechanismAndNotTheOthers() throws {
        let project = try projectText("mac")

        let direct = try linkedPackageProducts(ofTarget: "Relayium", in: project)
        XCTAssertTrue(direct.contains("Sparkle"),
                      "the direct download lost its updater: \(direct)")
        XCTAssertFalse(direct.contains("RelayiumStoreKit"),
                       "the direct download links the purchase adapter: \(direct)")
        XCTAssertTrue(direct.contains("RelayiumKit"), "the direct target links no package at all")

        let appStore = try linkedPackageProducts(ofTarget: "RelayiumAppStore", in: project)
        XCTAssertTrue(appStore.contains("RelayiumStoreKit"),
                      "the App Store build cannot sell anything: \(appStore)")
        XCTAssertFalse(appStore.contains("Sparkle"),
                       "the App Store build ships a second update mechanism: \(appStore)")
        XCTAssertTrue(appStore.contains("RelayiumKit"), "the App Store target links no package at all")

        // The extension embedded in each is the one signed for that channel.
        // One shared extension target would put a Developer ID signature inside
        // an App Store submission, which fails validation rather than review.
        //
        // The two channels say that in opposite ways, so each half is asserted
        // as what is actually true of it. The direct extension *names* its
        // certificate, because manual signing is what the notarized channel
        // needs. The App Store extension names none: it signs automatically, and
        // an identity pinned beside automatic signing is the conflicting
        // provisioning setting that made the archive fail before it began.
        // `MacAppStoreSigningTests` owns that half in full; what belongs here is
        // the risk this check was written for — that no Developer ID identity
        // reaches the App Store extension.
        XCTAssertTrue(try signingIdentity(ofTarget: "RelayiumShare", in: project)
                        .contains("Developer ID Application"),
                      "RelayiumShare is not signed for the direct channel")

        let appStoreShare = try signingIdentity(ofTarget: "RelayiumShareAppStore", in: project)
        XCTAssertFalse(appStoreShare.contains("Developer ID Application"),
                       "RelayiumShareAppStore carries a Developer ID identity; a Developer ID "
                       + "signature inside an App Store submission fails validation")
        XCTAssertTrue(appStoreShare.isEmpty,
                      "RelayiumShareAppStore pins a signing identity beside automatic signing, "
                      + "which Xcode refuses to archive: \(appStoreShare)")
    }

    /// The `CODE_SIGN_IDENTITY` values a target's configurations declare.
    private func signingIdentity(ofTarget target: String, in project: String) throws -> Set<String> {
        let listMarker = "Build configuration list for PBXNativeTarget \"\(target)\" */ = {"
        let start = try XCTUnwrap(project.range(of: listMarker), "no configuration list for \(target)")
        let rest = project[start.upperBound...]
        let end = try XCTUnwrap(rest.range(of: "\n\t\t};"))
        let ids = rest[..<end.lowerBound].components(separatedBy: "\n")
            .compactMap { line -> String? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("A1"), let space = trimmed.firstIndex(of: " ") else { return nil }
                return String(trimmed[..<space])
            }
        var identities: Set<String> = []
        for id in ids {
            let marker = "\(id) /* "
            guard let at = project.range(of: marker) else { continue }
            let tail = project[at.upperBound...]
            guard let blockEnd = tail.range(of: "\n\t\t};") else { continue }
            let block = String(tail[..<blockEnd.lowerBound])
            for line in block.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("CODE_SIGN_IDENTITY = ") else { continue }
                identities.insert(trimmed
                    .dropFirst("CODE_SIGN_IDENTITY = ".count)
                    .trimmingCharacters(in: CharacterSet(charactersIn: ";\" ")))
            }
        }
        return identities
    }

    /// The two products are one release of one app: same bundle identity, same
    /// version. A divergence here is two apps wearing the same name.
    func testBothMacProductsAreTheSameAppThroughTwoChannels() throws {
        let project = try projectText("mac")
        let identifiers = project.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("PRODUCT_BUNDLE_IDENTIFIER = ") }
            .map { $0.dropFirst("PRODUCT_BUNDLE_IDENTIFIER = ".count)
                     .trimmingCharacters(in: CharacterSet(charactersIn: ";\" ")) }
        // The App Store app and the direct app share `com.relayium.mac`, and
        // both extensions share `com.relayium.mac.Share`. An extension's bundle
        // id must be prefixed by its host's, so a diverging host id would break
        // the App Group hand-off on one channel only.
        XCTAssertEqual(identifiers.filter { $0 == "com.relayium.mac" }.count, 4,
                       "the two macOS apps no longer share one bundle identity: \(identifiers)")
        XCTAssertEqual(identifiers.filter { $0 == "com.relayium.mac.Share" }.count, 4,
                       "the two Share extensions no longer share one bundle identity")
    }

    // MARK: - 4: the App Store build claims no Sparkle capability

    /// **The entitlement is the half a link check cannot make.**
    ///
    /// `temporary-exception.mach-lookup.global-name` is a hole in the sandbox,
    /// and its two Sparkle service names are what App Store review refuses.
    /// A build that dropped the framework but kept the exception would link
    /// nothing and still claim it.
    func testTheAppStoreEntitlementsCarryNoSparkleException() throws {
        let data = try Data(contentsOf: try macRoot
            .appendingPathComponent("RelayiumAppStore/Relayium.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        for key in plist.keys {
            XCTAssertFalse(key.contains("temporary-exception"),
                           "the App Store build claims a sandbox exception: \(key)")
        }
        XCTAssertNil(plist["com.apple.security.temporary-exception.mach-lookup.global-name"])

        // And the direct build still has it, so this is a difference between the
        // two rather than a capability quietly removed from both.
        let direct = try Data(contentsOf: try macRoot
            .appendingPathComponent("Relayium/Relayium.entitlements"))
        let directPlist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: direct, options: [], format: nil)
                as? [String: Any])
        XCTAssertNotNil(
            directPlist["com.apple.security.temporary-exception.mach-lookup.global-name"],
            "the direct download lost the exception its updater needs")

        // Everything the product actually needs is the same on both, so the App
        // Store build is not a quietly reduced app.
        //
        // **Exactly two keys are allowed to differ, one in each direction, and
        // both are deliberate.** The set is written out rather than the
        // comparison loosened to a subset, so a THIRD divergence — a capability
        // quietly dropped from one build, or claimed by one and not the other —
        // still fails here.
        //
        //  * Sparkle's Mach-lookup exception is direct-only: the App Store is
        //    that build's update mechanism and review does not grant a second one.
        //  * `com.apple.developer.applesignin` is App Store-only: Apple grants it
        //    per provisioning profile and the Developer ID profile does not carry
        //    it, so claiming it there would fail to sign. The direct build keeps
        //    browser sign-in, which is unchanged and present in BOTH.
        let directOnly = ["com.apple.security.temporary-exception.mach-lookup.global-name"]
        let appStoreOnly = ["com.apple.developer.applesignin"]
        XCTAssertEqual(Set(plist.keys).subtracting(appStoreOnly),
                       Set(directPlist.keys).subtracting(directOnly),
                       "the two builds claim different capabilities: "
                       + "\(Set(plist.keys)) vs \(Set(directPlist.keys))")
        // Each exclusive key really is exclusive, in the direction claimed.
        XCTAssertNotNil(plist["com.apple.developer.applesignin"],
                        "the Mac App Store build lost its Apple sign-in entitlement")
        XCTAssertNil(directPlist["com.apple.developer.applesignin"],
                     "the Developer ID build claims an entitlement its profile cannot grant")
    }

    /// A feed URL in an App Store build is a promise to download and run code
    /// Apple did not review. The three Sparkle keys go with the framework.
    func testTheAppStoreInfoPlistCarriesNoSparkleKeysAndIsOtherwiseTheSame() throws {
        func plist(_ path: String) throws -> [String: Any] {
            let data = try Data(contentsOf: try macRoot.appendingPathComponent(path))
            return try XCTUnwrap(
                try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                    as? [String: Any])
        }
        let appStore = try plist("RelayiumAppStore/Info.plist")
        let direct = try plist("Relayium/Info.plist")

        let sparkleKeys = ["SUFeedURL", "SUPublicEDKey", "SUEnableInstallerLauncherService"]
        for key in sparkleKeys {
            XCTAssertNil(appStore[key], "the App Store Info.plist carries \(key)")
            XCTAssertNotNil(direct[key], "the direct Info.plist lost \(key)")
        }
        // Same app otherwise: same declared languages, same document types, same
        // category. A user installing one after the other must not find a
        // different product.
        XCTAssertEqual(Set(appStore.keys), Set(direct.keys).subtracting(sparkleKeys),
                       "the two Info.plists differ by more than Sparkle")
        XCTAssertEqual(appStore["CFBundleLocalizations"] as? [String],
                       direct["CFBundleLocalizations"] as? [String])
        XCTAssertEqual(appStore["LSApplicationCategoryType"] as? String,
                       direct["LSApplicationCategoryType"] as? String)
    }

    // MARK: - 5: iOS contains StoreKit only in the app

    /// iOS is an App Store-only product, so its app links the adapter while its
    /// Share extension remains a staging process with no account or network.
    func testStoreKitReachesTheIOSAppButNotItsShareExtension() throws {
        let project = try projectText("ios")
        for banned in ["StoreKit.framework", "StoreKitTest", "libStoreKit"] {
            XCTAssertFalse(project.contains(banned), "the iOS project links \(banned)")
        }
        let app = try linkedPackageProducts(ofTarget: "Relayium", in: project)
        XCTAssertTrue(app.contains("RelayiumKit"))
        XCTAssertTrue(app.contains("RelayiumStoreKit"),
                      "the iOS app cannot sell subscriptions: \(app)")
        let share = try linkedPackageProducts(ofTarget: "RelayiumShare", in: project)
        XCTAssertEqual(share, ["RelayiumShareKit"],
                       "the Share extension reached account or purchase code: \(share)")

        let sources = try sources(under: try iosRoot, atLeast: 14)
        XCTAssertEqual(sources.filter { $0.code.contains("import RelayiumStoreKit") }.map(\.path),
                       ["ios/Relayium/AppleSubscriptions.swift"])
        XCTAssertTrue(sources.first { $0.path.hasSuffix("RelayiumApp.swift") }?.code
            .contains("startObservingUpdates()") == true,
                      "the iOS app does not drain StoreKit updates at app scope")
    }

    // MARK: - 6: the source really is shared

    /// **One copy of the scene, the settings window and the account screen**,
    /// compiled by both macOS targets. The alternative — a second folder of
    /// near-identical files — is how the two products drift into being different
    /// apps, and it is what the synchronized folder plus a target-specific seam
    /// exists to avoid.
    func testTheTwoMacTargetsShareTheirSourceRatherThanDuplicatingIt() throws {
        let project = try projectText("mac")
        // Both app targets list the SAME synchronized folder object.
        let folderReferences = project.components(separatedBy:
            "A100000000000000000000AF /* Relayium */,").count - 1
        XCTAssertGreaterThanOrEqual(folderReferences, 2,
                                    "the App Store target no longer shares the app's source folder")
        // And the only per-target divergence is the seam: exactly two files, one
        // per target, excluded from the other.
        for (target, excluded) in [("Relayium", "Distribution/AppStoreDistribution.swift"),
                                   ("RelayiumAppStore", "Distribution/DirectDistribution.swift")] {
            XCTAssertTrue(project.contains("in \"\(target)\" target */ = {"),
                          "\(target) has no membership exception set")
            XCTAssertTrue(project.contains(excluded),
                          "\(target) does not exclude \(excluded)")
        }
        // The shared files really are shared: neither names the other build's
        // mechanism, and both go through the seam. Read through the
        // comment-stripping loader, because each of these files EXPLAINS that it
        // does not import Sparkle — and a raw scan would fail on the prose
        // documenting the absence it is checking.
        let macSources = try sources(under: try macRoot, atLeast: 30)
        for name in ["mac/Relayium/RelayiumApp.swift",
                     "mac/Relayium/Settings/SettingsView.swift",
                     "mac/Relayium/AccountView.swift"] {
            let code = try XCTUnwrap(macSources.first { $0.path == name }?.code,
                                     "\(name) is gone from the shared folder")
            XCTAssertFalse(code.contains("import Sparkle"),
                           "shared file \(name) imports the direct build's updater")
            XCTAssertFalse(code.contains("import RelayiumStoreKit"),
                           "shared file \(name) imports the App Store build's adapter")
        }
        // And there is exactly one implementation of each seam name per target.
        for name in ["enum AppDistribution", "final class AppUpdates",
                     "struct AppUpdatesMenuItem", "struct AppUpdatesSettingsTab"] {
            let declaring = try sources(under: try macRoot, atLeast: 30)
                .filter { $0.code.contains(name) }.map(\.path).sorted()
            XCTAssertEqual(declaring,
                           ["mac/Relayium/Distribution/AppStoreDistribution.swift",
                            "mac/Relayium/Distribution/DirectDistribution.swift"],
                           "\(name) is not declared exactly once per target: \(declaring)")
        }
    }

    /// The manifest still keeps the adapter a leaf that only the App Store
    /// target and the tests depend on.
    ///
    /// Counting is what makes this catch the edit that matters: every check
    /// above would still pass if `RelayiumAppKit` — which BOTH apps link — simply
    /// gained `RelayiumStoreKit` as a dependency. StoreKit would then be in the
    /// direct binary too, with no source naming it.
    func testTheManifestKeepsTheAdapterALeaf() throws {
        let raw = try String(contentsOf: try packageRoot.appendingPathComponent("Package.swift"),
                             encoding: .utf8)
        let manifest = raw.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")

        XCTAssertEqual(manifest.components(separatedBy: "RelayiumStoreKit").count - 1, 4,
                       "the adapter is named somewhere new in the manifest")
        XCTAssertTrue(manifest.contains(
            #".library(name: "RelayiumStoreKit", targets: ["RelayiumStoreKit"])"#),
            "the adapter is no longer its own product")
        // The target, depending on the seam's module and nothing else. A
        // dependency on `RelayiumKit` would put the account client one import
        // away from the layer whose whole safety argument is that the only thing
        // it can do with a purchase is hand it up.
        let declaration = try XCTUnwrap(
            manifest.components(separatedBy: #".target(name: "RelayiumStoreKit","#)
                .dropFirst().first,
            "the adapter has no target declaration")
        XCTAssertTrue(String(declaration.prefix(120))
            .contains(#"dependencies: ["RelayiumAppKit"])"#),
                      "the adapter's dependency set changed")
        let testTarget = try XCTUnwrap(
            manifest.components(separatedBy: #".testTarget("#).dropFirst().first)
        XCTAssertTrue(String(testTarget.prefix(400)).contains(#""RelayiumStoreKit"]"#),
                      "the adapter is linked by something other than the test target")
        // And the product both apps link is unchanged: `RelayiumAppKit` must not
        // acquire the adapter, which would put StoreKit in every binary.
        XCTAssertTrue(manifest.contains(
            #".library(name: "RelayiumKit", targets: ["RelayiumKit", "RelayiumAppKit"])"#),
            "the product the apps link changed shape")
        let appKit = try XCTUnwrap(
            manifest.components(separatedBy: #".target(name: "RelayiumAppKit","#)
                .dropFirst().first)
        // Its OWN dependency list, up to the closing bracket — not a fixed
        // prefix, which would run into the adapter's target declaration below it
        // and fail on a manifest that is perfectly correct.
        let appKitDependencies = try XCTUnwrap(
            appKit.components(separatedBy: "]").first,
            "RelayiumAppKit has no dependency list")
        XCTAssertFalse(appKitDependencies.contains("RelayiumStoreKit"),
                       "the shared view-model layer gained the adapter as a dependency")
    }

    // MARK: - 7: no product identifier is compiled in

    /// A `.storekit` file is a local test configuration Xcode wires into a
    /// scheme; adding one is how a build starts transacting against a fake store
    /// without anybody deciding to.
    func testThereIsNoStoreKitConfigurationFile() throws {
        let found = try FileManager.default
            .subpathsOfDirectory(atPath: try appsRoot.path)
            .filter { $0.hasSuffix(".storekit") }
        XCTAssertEqual(found, [], "a StoreKit configuration file appeared: \(found)")
    }

    /// **No product identifier is compiled into anything shippable**, and that
    /// is now a positive claim rather than a placeholder: the App Store build
    /// reads its catalog from the server, keyed by its own bundle identity, so a
    /// product it may sell is a database row rather than a released binary.
    ///
    /// The acceptance fixture's identifiers are exempt by being inside
    /// `#if DEBUG` — which this loader cannot see — so they are checked
    /// separately below.
    func testNoProductIdentifierIsConfiguredAnywhereShippable() throws {
        for (path, code) in try everyShippableSource() {
            // The acceptance fixtures name identifiers, and are compiled out of
            // Release entirely. Checked below rather than skipped silently.
            guard !path.hasSuffix("mac/Relayium/UITestMode.swift"),
                  !path.hasSuffix("mac/Relayium/UITestSubscriptions.swift"),
                  !path.hasSuffix("ios/Relayium/UITestMode.swift"),
                  !path.hasSuffix("ios/Relayium/UITestSubscriptions.swift") else { continue }
            for shape in ["com.relayium.plus", "com.relayium.pro", "com.relayium.max",
                          ".monthly\"", ".yearly\"", "subscription.group"] {
                XCTAssertFalse(code.contains(shape),
                               "\(path) carries what looks like a product identifier: \(shape)")
            }
        }
        // The two exempt files are entirely inside `#if DEBUG`, so nothing they
        // name reaches a shipped binary.
        for root in [try macRoot, try iosRoot] {
            for name in ["UITestMode.swift", "UITestSubscriptions.swift"] {
                let text = try String(contentsOf: root.appendingPathComponent("Relayium/\(name)"),
                                      encoding: .utf8)
                XCTAssertTrue(text.contains("#if DEBUG"),
                              "\(root.lastPathComponent)/\(name) lacks a DEBUG guard")
            }
        }
        // And the model takes its bundle identity rather than a catalog: there
        // is no default, no constant and no plist entry to find.
        let model = try String(
            contentsOf: try sourcesRoot.appendingPathComponent(
                "RelayiumAppKit/AppleSubscriptionModel.swift"), encoding: .utf8)
        XCTAssertTrue(model.contains("private let bundleID: String"),
                      "the purchase model no longer takes its identity from the build")
        XCTAssertTrue(model.contains("billing.appleCatalog(bundleID: bundleID"),
                      "the purchase model no longer reads the server's catalog")
    }

    // MARK: - 8: the direct build keeps its web hand-off

    /// **What the direct download ships for changing a plan is a link to the
    /// website, and it stays that way.**
    ///
    /// This is the half a ban cannot make. Everything above says where a
    /// purchase surface may exist; without this, a batch that deleted the
    /// existing button would satisfy all of them and leave direct-download users
    /// with no way to change a plan at all.
    func testOnlyTheDirectMacBuildKeepsTheWebsitePlanHandoff() throws {
        let mac = try String(contentsOf: try appsRoot.appendingPathComponent(
            "mac/Relayium/AccountView.swift"),
                             encoding: .utf8)
        XCTAssertTrue(mac.contains("Button(L10n.t(.accountManagePlan))"))
        XCTAssertTrue(mac.contains("AppEnvironment.plansWebURL"))
        XCTAssertTrue(mac.contains("NSWorkspace.shared.open(AppEnvironment.plansWebURL)"))
        // …and the App Store build does NOT show it. Both terms of the rule are
        // required — see the call site — so both are pinned here.
        XCTAssertTrue(mac.contains("AppDistribution.channel.showsWebPlanHandoff && subscription == nil"),
                      "the web hand-off is no longer gated on the distribution channel")
        let ios = try String(contentsOf: try appsRoot.appendingPathComponent(
            "ios/Relayium/AccountSummaryView.swift"),
                             encoding: .utf8)
        XCTAssertTrue(ios.contains("IOSAppleSubscriptions.channel.showsWebPlanHandoff"),
                      "the iOS web hand-off is no longer gated on the distribution channel")
        XCTAssertTrue(ios.contains("Button(L10n.t(.accountManagePlan))"))
        XCTAssertTrue(ios.contains("AppEnvironment.plansWebURL"))
        XCTAssertTrue(ios.contains("IOSAppleSubscriptions.channel.offersInAppPurchase"),
                      "the iOS StoreKit surface is no longer gated on the distribution channel")
        XCTAssertTrue(ios.contains("AppleSubscriptionCard("))
        let subscriptions = try String(contentsOf: try iosRoot.appendingPathComponent(
            "Relayium/AppleSubscriptions.swift"), encoding: .utf8)
        XCTAssertTrue(subscriptions.contains("channel: AppDistributionChannel = .iosAppStore"),
                      "the iOS purchase boundary does not declare its distribution channel")
    }

    // MARK: - 9: the purchase surface carries its legal links

    /// **The privacy policy and the terms, on the screen that sells the
    /// subscription.**
    ///
    /// This is a release blocker rather than a nicety: an app offering an
    /// auto-renewing subscription must show a functional link to both from its
    /// purchase surface, and a submission without them is refused before anybody
    /// runs the product. Neither `AppleSubscriptionPresentationTests` (which
    /// reads the copy layer) nor the acceptance suite (which needs a built app)
    /// can say the card still renders them, so the card's own source is read.
    ///
    /// `SwiftUI.Link`, not a `Button` that opens a URL: these are ordinary
    /// external web pages, and `Link` is what gives them a web link's behaviour
    /// — including the context menu that copies the address, which is how a
    /// reviewer checks a destination without leaving the app.
    func testThePurchaseSurfaceLinksThePrivacyPolicyAndTheTerms() throws {
        let card = try XCTUnwrap(
            try sources(under: try macRoot, atLeast: 30)
                .first { $0.path == "mac/Relayium/Subscription/AppleSubscriptionCard.swift" }?.code,
            "the purchase card is gone")
        // Whitespace-normalised: how the call is wrapped is nobody's contract.
        let flat = card.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        for (label, url) in [(".subscriptionPrivacy", "AppEnvironment.privacyWebURL"),
                             (".subscriptionTerms", "AppEnvironment.termsWebURL")] {
            XCTAssertTrue(flat.contains("Link(L10n.t(\(label)), destination: \(url))"),
                          "the purchase surface no longer links \(label) to \(url)")
        }
        // The identifiers acceptance addresses them by, exactly once each.
        for identifier in ["subscription-privacy", "subscription-terms"] {
            XCTAssertEqual(card.components(separatedBy: "\"\(identifier)\"").count - 1, 1,
                           "\(identifier) is not on the card exactly once")
        }
        // Every URL through the environment boundary, so there is one place the
        // address is written and one place a test can read it.
        XCTAssertFalse(card.contains("https://"),
                       "the purchase card hard-codes a URL instead of using AppEnvironment")
        XCTAssertTrue(flat.contains("destination: AppEnvironment.appleSubscriptionsURL"),
                      "the Apple subscription-management destination bypasses AppEnvironment")

        // **Unconditional.** Everything else on this card is gated on a state —
        // what is on sale, what the server allows, who bills the account — and a
        // legal link that vanished when the catalog failed to load would be
        // missing at exactly the moment somebody went looking for it. Asserted
        // as nesting depth against the card's own ungated body copy, which is
        // the property "not inside an `if`" actually has in the source.
        let lines = card.components(separatedBy: "\n")
        func indentation(ofLineWhere matches: (String) -> Bool,
                         _ what: String) throws -> Int {
            let line = try XCTUnwrap(lines.first(where: matches), "\(what) is gone from the card")
            return line.prefix { $0 == " " }.count
        }
        let callSite = try indentation(
            ofLineWhere: { $0.trimmingCharacters(in: .whitespaces) == "legalLinks" },
            "the legal links' call site")
        let ungated = try indentation(
            ofLineWhere: { $0.contains("Text(L10n.t(.subscriptionBody))") },
            "the card's body copy")
        XCTAssertEqual(callSite, ungated,
                       "the legal links are nested inside a condition; they must always render")
        // And the links themselves are not conditional within their own view.
        // `components(separatedBy:)` always yields something, so the separator's
        // presence is asserted first — otherwise a rename would silently hand
        // the check the whole file.
        let declaration = "private var legalLinks: some View {"
        XCTAssertTrue(card.contains(declaration),
                      "the legal links are no longer their own view")
        let property = try XCTUnwrap(card.components(separatedBy: declaration).last)
        let bodyOfProperty = String(property.prefix(while: { $0 != "}" }))
        XCTAssertFalse(bodyOfProperty.contains("if "),
                       "a legal link is rendered conditionally")
    }

    func testTheIOSPurchaseSurfaceCarriesUnconditionalLegalLinks() throws {
        let card = try String(contentsOf: try iosRoot.appendingPathComponent(
            "Relayium/AppleSubscriptions.swift"), encoding: .utf8)
        let flat = card.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        for (label, url) in [(".subscriptionPrivacy", "AppEnvironment.privacyWebURL"),
                             (".subscriptionTerms", "AppEnvironment.termsWebURL")] {
            XCTAssertTrue(flat.contains("Link(L10n.t(\(label)), destination: \(url))"),
                          "the iOS purchase surface no longer links \(label) to \(url)")
        }
        for identifier in ["subscription-privacy", "subscription-terms"] {
            XCTAssertEqual(card.components(separatedBy: "\"\(identifier)\"").count - 1, 1,
                           "\(identifier) is not on the iOS card exactly once")
        }
        XCTAssertFalse(card.contains("https://"),
                       "the iOS purchase card hard-codes a URL")
        XCTAssertTrue(flat.contains("destination: AppEnvironment.appleSubscriptionsURL"),
                      "the iOS subscription-management destination bypasses AppEnvironment")

        let marker = "HStack(spacing: 16) {"
        let links = try XCTUnwrap(card.components(separatedBy: marker).dropFirst().first)
        let block = try XCTUnwrap(links.components(separatedBy: "\n            .font(.caption)").first)
        XCTAssertFalse(block.contains("if "), "an iOS legal link is rendered conditionally")
    }

    /// The addresses are written once, in `AppEnvironment`, like every other
    /// hand-off. A second copy in a view is how the two drift and one of them
    /// starts pointing at a page that no longer exists.
    func testTheLegalAddressesAreWrittenOnlyInTheEnvironment() throws {
        for (path, code) in try everyShippableSource() {
            guard !path.hasSuffix("RelayiumAppKit/AppEnvironment.swift") else { continue }
            for address in ["relayium.com/privacy", "relayium.com/terms"] {
                XCTAssertFalse(code.contains(address),
                               "\(path) writes \(address) instead of asking AppEnvironment")
            }
        }
    }

    // MARK: - the adapter itself

    /// The adapter exists, is one file, and is buildable — the test target links
    /// it, so this test file compiling at all is most of the claim.
    func testTheAdapterIsOneFileAndTypeChecksAgainstTheSeam() throws {
        let files = try FileManager.default.subpathsOfDirectory(atPath: try adapterRoot.path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertEqual(files, ["StoreKitSubscriptionStore.swift"])
        // Named through the seam's type, so a signature that drifted from
        // `SubscriptionStore` fails to compile here rather than in the App Store
        // target's build.
        let store: any SubscriptionStore = StoreKitSubscriptionStore()
        XCTAssertTrue(store is StoreKitSubscriptionStore)
    }

    // MARK: - 10: the arm is asked for after the lookup, and nothing follows it

    /// The adapter's own source, whole-line comments removed by the same loader
    /// every other guard here uses.
    private func adapterSource() throws -> String {
        try XCTUnwrap(try sources(under: try adapterRoot, atLeast: 1).first,
                      "the adapter source is missing").code
    }

    /// The store seam every purchase crosses, loaded the same way.
    private func seamSource() throws -> String {
        try XCTUnwrap(
            try sources(under: try sourcesRoot, atLeast: 60)
                .first { $0.path.hasSuffix("RelayiumAppKit/SubscriptionStore.swift") },
            "the store seam is missing").code
    }

    /// The statements of a function body, trimmed, from a source whose
    /// whole-line comments are already gone.
    ///
    /// Deliberately line-based. "Nothing may be inserted between the arm and the
    /// charge" is a claim about how many statements there are, and a guard that
    /// only searched for substrings could not make it: every substring it looked
    /// for would still be present with a fourth statement wedged between them. A
    /// reformat that splits one of these statements across lines fails here, and
    /// is meant to — the shape is the contract.
    private func statements(ofFunction name: String, in code: String) throws -> [String] {
        let lines = code.components(separatedBy: "\n")
        let declaration = try XCTUnwrap(lines.firstIndex { $0.contains("func \(name)") },
                                        "\(name) is no longer declared in this source")
        // The signature may span lines; the body opens at the first one ending
        // in `{`, and closes at the first `}` back at the declaration's indent.
        let indent = String(lines[declaration].prefix { $0 == " " })
        var open = declaration
        while open < lines.count,
              !lines[open].trimmingCharacters(in: .whitespaces).hasSuffix("{") {
            open += 1
        }
        guard open < lines.count else {
            XCTFail("\(name) has no body")
            return []
        }
        var close = open + 1
        while close < lines.count, lines[close] != indent + "}" { close += 1 }
        guard close < lines.count else {
            XCTFail("\(name)'s body does not close at its own indentation")
            return []
        }
        return lines[(open + 1)..<close]
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// **The reader above counts statements, rather than finding the ones it
    /// was told to look for.**
    ///
    /// It is the load-bearing part of the two guards below, and its failure mode
    /// is the one this target worries about most: a scan that quietly reads
    /// nothing passes every claim it makes. So it is checked here against a
    /// shipped shape and against the same shape with one statement wedged in
    /// after the arm — which is precisely the edit the guards exist to catch,
    /// stated over a literal rather than by editing the adapter.
    func testTheStatementReaderSeesAStatementWedgedInAfterTheArm() throws {
        let shipped = """
            actor Example {
                static func order() async throws -> Int {
                    guard let resolved = try await resolve() else { throw unresolved }
                    let appAccountToken = try await authorize()
                    return try await charge(resolved, appAccountToken)
                }
            }
            """
        XCTAssertEqual(try statements(ofFunction: "order", in: shipped).count, 3,
                       "the reader miscounted a body it should read exactly")

        let wedged = shipped.replacingOccurrences(
            of: "        return try await charge",
            with: "        try await somethingThatCanFailAfterTheArm()\n"
                + "        return try await charge")
        XCTAssertEqual(try statements(ofFunction: "order", in: wedged).count, 4,
                       "a statement inserted between the arm and the charge was not seen")
    }

    /// **The ordering claim, read out of the source that ships.**
    ///
    /// `StoreKitSubscriptionStoreTests` proves the helper *behaves* this way, by
    /// running it over three recording closures. This proves the helper is still
    /// the three statements that behaviour is a consequence of. Neither guard
    /// replaces the other: a source scan cannot see what code does, and the
    /// executable one cannot see a fourth statement that has not been given a
    /// closure to call.
    func testTheAdapterResolvesBeforeArmingAndChargesImmediatelyAfterwards() throws {
        let body = try statements(ofFunction: "resolveAuthorizeThenPurchase",
                                  in: try adapterSource())

        XCTAssertEqual(body.count, 3, """
            the ordering helper is no longer exactly three statements: \(body). \
            Anything inserted here is work that can fail AFTER Relayium's server \
            armed a sheet, and a failure on that side of the line is ambiguous \
            about whether Apple charged — so it locks the account's attempt \
            instead of leaving it retryable.
            """)
        guard body.count == 3 else { return }
        XCTAssertTrue(body[0].contains("resolve()") && body[0].contains("throw unresolved"),
                      "the product lookup is no longer what happens first: \(body[0])")
        XCTAssertTrue(body[1].contains("authorize()"),
                      "the sheet is no longer armed second: \(body[1])")
        XCTAssertTrue(body[2].hasPrefix("return") && body[2].contains("charge("),
                      "charging is no longer the last thing that happens: \(body[2])")
    }

    /// **The shipped purchase goes through that helper, and hands the callback
    /// over rather than calling it.**
    ///
    /// The helper's ordering is worth nothing if production reaches
    /// `Product.purchase` some other way, so this reads the real method: the
    /// lookup is its `resolve:` step, the app's callback is passed straight
    /// through, and Apple's charge sits inside `charge:`.
    func testTheProductionPurchaseIsWiredThroughTheOrderingHelper() throws {
        let body = try statements(ofFunction: "purchase(productID:", in: try adapterSource())
        let joined = body.joined(separator: "\n")

        XCTAssertTrue(joined.contains("Self.resolveAuthorizeThenPurchase("),
                      "the shipped purchase no longer states its ordering through the helper")
        let resolveStep = try XCTUnwrap(body.first { $0.hasPrefix("resolve:") },
                                        "the helper is no longer given a resolve step")
        XCTAssertTrue(resolveStep.contains("Product.products("), """
            the product lookup is no longer the pre-authorization step: \
            \(resolveStep). It is the call that fails routinely and provably \
            without charging anybody, so it is what has to happen before the arm.
            """)
        // Handed over, never invoked here: at-most-once, the account re-check and
        // the refusal are the model's to enforce, and a second call site is how
        // one sheet acquires two dispatches.
        XCTAssertTrue(body.contains("authorize: authorize,"),
                      "the app's authorization callback is no longer passed straight through")
        XCTAssertFalse(joined.contains("authorize()"),
                       "the adapter now invokes the authorization callback itself")

        let chargeStep = try XCTUnwrap(body.firstIndex { $0.hasPrefix("charge:") },
                                       "the helper is no longer given a charge step")
        let normalized = try XCTUnwrap(body.firstIndex { $0.contains("normalizedPurchaseResult") },
                                       "the purchase no longer normalizes Apple's typed cancellation")
        XCTAssertGreaterThan(normalized, chargeStep, """
            `normalizedPurchaseResult` no longer sits inside the charge step. It \
            turns Apple's typed cancellation into a cancelled RESULT, so an \
            authorization refused above this seam must stay outside it: a refusal \
            is not a user cancelling a sheet that was never opened.
            """)
    }

    /// **The seam carries no pre-minted attribution token.**
    ///
    /// A token that crosses this boundary as a value has already been minted,
    /// and minting is what arms one sheet on Relayium's server. That is what put
    /// the adapter's own product lookup on the ambiguous side of the arm, where
    /// a storefront that does not carry the identifier locked the account out of
    /// buying anything at all.
    func testTheStoreSeamAsksForAuthorizationRatherThanTakingAToken() throws {
        let seam = try seamSource()

        XCTAssertTrue(seam.contains("authorize: @escaping StorePurchaseAuthorization)"),
                      "the store seam no longer takes an authorization callback")
        XCTAssertTrue(seam.contains("public typealias StorePurchaseAuthorization"),
                      "the authorization callback is no longer declared at the seam")
        XCTAssertFalse(seam.contains("appAccountToken"),
                       "the store seam names a pre-minted attribution token again")
    }
}
