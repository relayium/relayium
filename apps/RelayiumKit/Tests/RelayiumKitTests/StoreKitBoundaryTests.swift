import XCTest
@testable import RelayiumAppKit
@testable import RelayiumStoreKit

/// **Where StoreKit is allowed to be, and where the purchase path is allowed to
/// be reachable from.**
///
/// This batch builds a complete in-app purchase path and ships none of it. That
/// is a claim about absences, and an absence has no runtime to observe — so it
/// is checked the way `IOSSurfaceGuardTests` and `InboxSurfaceGuardTests` check
/// theirs: by reading the sources and the project files that decide what a
/// binary contains.
///
/// It replaces a blanket `"StoreKit"` ban that used to live in the iOS deferred
/// list. That ban could not survive this batch — the adapter has to import the
/// framework to exist — and deleting it would have left nothing at all. What is
/// here instead is the narrower and stronger set of claims:
///
///  1. exactly one file imports StoreKit, and it is the isolated target's;
///  2. no other source under `apps/` names the framework in code;
///  3. neither Xcode project links the product or the framework;
///  4. no app source can even name the purchase model or the store seam;
///  5. the manifest keeps the adapter a leaf that nothing shipping depends on;
///  6. there is no `.storekit` configuration file and no product identifier;
///  7. the plan handoff both apps ship today — a button to the website — is
///     untouched.
final class StoreKitBoundaryTests: XCTestCase {

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
    }

    private var packageRoot: URL { appsRoot.appendingPathComponent("RelayiumKit") }
    private var sourcesRoot: URL { packageRoot.appendingPathComponent("Sources") }
    private var adapterRoot: URL { sourcesRoot.appendingPathComponent("RelayiumStoreKit") }
    private var iosRoot: URL { appsRoot.appendingPathComponent("ios") }
    private var macRoot: URL { appsRoot.appendingPathComponent("mac") }

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
                .replacingOccurrences(of: appsRoot.path + "/", with: "")
            return (relative, code)
        }
    }

    /// Everything a shipped binary could be built from: both app trees and every
    /// package source. Deliberately not the tests — a test naming StoreKit is a
    /// test, not a product.
    private func everyShippableSource() throws -> [(path: String, code: String)] {
        try sources(under: sourcesRoot, atLeast: 60)
            + sources(under: iosRoot, atLeast: 12)
            + sources(under: macRoot, atLeast: 30)
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
    /// only it can provide. A type that crossed the seam would make the
    /// isolation decorative: every consumer would need the framework to say the
    /// value's name.
    func testNoSourceOutsideTheAdapterNamesStoreKitOrItsTypes() throws {
        let banned = ["StoreKit", "Transaction.updates", "Transaction.currentEntitlements",
                      "Product.products", "AppStore.sync", "VerificationResult",
                      "jwsRepresentation", "appAccountToken(",
                      "Product.PurchaseResult", "Product.PurchaseOption"]
        for (path, code) in try everyShippableSource() {
            guard !path.hasPrefix("RelayiumKit/Sources/RelayiumStoreKit/") else { continue }
            for symbol in banned {
                XCTAssertFalse(code.contains(symbol),
                               "\(path) names \(symbol) outside the isolated adapter")
            }
        }
    }

    /// The seam the rest of the app talks to names no store type at all — which
    /// is what lets the whole purchase policy run under `swift test` with no
    /// store, and what lets `RelayiumAppKit` stay linkable by a binary that has
    /// never heard of in-app purchase.
    func testTheSeamAndTheModelAreExpressedInPlainValues() throws {
        for name in ["SubscriptionStore.swift", "AppleSubscriptionModel.swift"] {
            let code = try sources(under: sourcesRoot.appendingPathComponent("RelayiumAppKit"),
                                   atLeast: 40).first { $0.path.hasSuffix(name) }?.code
            let source = try XCTUnwrap(code, "\(name) is gone from RelayiumAppKit")
            XCTAssertFalse(source.contains("import StoreKit"))
            XCTAssertTrue(source.contains("import Foundation"),
                          "\(name) should need nothing but Foundation and the package")
        }
    }

    // MARK: - 3: no Xcode target links it

    /// **Neither shipping app links the product or the framework.**
    ///
    /// Linking StoreKit is a claim: it is what the system's purchase machinery
    /// and App Store review look for, and an app that links it is an app that
    /// sells something. This batch does not make that claim, and the project
    /// files are where that is decided rather than where it is described.
    func testNeitherXcodeProjectLinksTheStoreKitProductOrFramework() throws {
        for project in ["ios/Relayium.xcodeproj/project.pbxproj",
                        "mac/Relayium.xcodeproj/project.pbxproj"] {
            let text = try String(contentsOf: appsRoot.appendingPathComponent(project),
                                  encoding: .utf8)
            for banned in ["RelayiumStoreKit", "StoreKit.framework", "StoreKitTest",
                           "libStoreKit"] {
                XCTAssertFalse(text.contains(banned), "\(project) links \(banned)")
            }
            // The two package products they DO link, named explicitly: a project
            // that lost them would pass every ban above while shipping nothing.
            XCTAssertTrue(text.contains("productName = RelayiumKit;"),
                          "\(project) no longer links the package at all")
        }
    }

    // MARK: - 4: no app source can reach the purchase path

    /// The purchase model, the seam and the adapter are unnameable from either
    /// app. This is the reachability half: an app that cannot name the model
    /// cannot construct one, cannot inject a catalog into one, and cannot render
    /// anything it publishes.
    func testNoAppSourceNamesThePurchasePath() throws {
        let unreachable = ["AppleSubscriptionModel", "SubscriptionStore", "SubscriptionOffer",
                           "SignedStoreTransaction", "StorePurchaseOutcome", "StoreTransactionID",
                           "AppleSubmission", "AppleBillingService", "AppleTransactionResult",
                           "AppleBillingError", "RelayiumStoreKit",
                           "submitAppleTransaction", "appleAccountToken"]
        let appSources = try sources(under: iosRoot, atLeast: 12)
            + sources(under: macRoot, atLeast: 30)
        for (path, code) in appSources {
            for symbol in unreachable {
                XCTAssertFalse(code.contains(symbol), "\(path) reaches the purchase path via \(symbol)")
            }
        }
    }

    /// And nothing in the shipping view-model layer builds one either. The model
    /// is referenced by its own file and by the tests, and by nothing that a
    /// binary is assembled from — which is what makes "unreachable" a property
    /// of the tree rather than of what the app happens to render today.
    func testNothingShippableConstructsThePurchaseModel() throws {
        let builders = try everyShippableSource()
            .filter { $0.code.contains("AppleSubscriptionModel(") }
            .map(\.path)
        XCTAssertEqual(builders, [], "something assembles the purchase model: \(builders)")
    }

    // MARK: - 5: the manifest keeps the adapter a leaf

    /// **The adapter is named in the manifest exactly four times, and each one
    /// is accounted for.**
    ///
    /// Counting rather than spot-checking is what makes this catch the edit that
    /// matters. Every source-level ban above would still pass if
    /// `RelayiumAppKit` — which both apps link — simply gained `RelayiumStoreKit`
    /// as a dependency: no app source would name the framework, and StoreKit
    /// would be in every shipped binary anyway. A fifth mention is that edit.
    ///
    /// The manifest is read with whole-line comments dropped, like every other
    /// guard here: it explains this boundary at length, and the prose must not
    /// be what the count is measuring.
    func testTheManifestNamesTheAdapterOnlyWhereItIsMeantTo() throws {
        let raw = try String(contentsOf: packageRoot.appendingPathComponent("Package.swift"),
                             encoding: .utf8)
        let manifest = raw.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")

        XCTAssertEqual(manifest.components(separatedBy: "RelayiumStoreKit").count - 1, 4,
                       "the adapter is named somewhere new in the manifest")
        // 1 & 2 — its own product, over its own target.
        XCTAssertTrue(manifest.contains(
            #".library(name: "RelayiumStoreKit", targets: ["RelayiumStoreKit"])"#),
            "the adapter is no longer its own product")
        // 3 — the target, depending on the seam's module and nothing else. A
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
        // 4 — the tests, which are the only thing that links it.
        let testTarget = try XCTUnwrap(
            manifest.components(separatedBy: #".testTarget("#).dropFirst().first)
        XCTAssertTrue(String(testTarget.prefix(400)).contains(#""RelayiumStoreKit"]"#),
                      "the adapter is linked by something other than the test target")
        // And the product both apps DO link is unchanged.
        XCTAssertTrue(manifest.contains(
            #".library(name: "RelayiumKit", targets: ["RelayiumKit", "RelayiumAppKit"])"#),
            "the product the apps link changed shape")
    }

    // MARK: - 6: no configuration and no product identifiers

    /// A `.storekit` file is a local test configuration that Xcode wires into a
    /// scheme; adding one is how a build starts transacting against a fake store
    /// without anybody deciding to.
    func testThereIsNoStoreKitConfigurationFile() throws {
        let found = try FileManager.default
            .subpathsOfDirectory(atPath: appsRoot.path)
            .filter { $0.hasSuffix(".storekit") }
        XCTAssertEqual(found, [], "a StoreKit configuration file appeared: \(found)")
    }

    /// **No product identifier exists anywhere yet**, so nothing can be sold
    /// even by a build that linked everything. The catalog is a constructor
    /// parameter precisely so that this is checkable: there is no default, no
    /// constant, and no plist entry to find.
    func testNoProductIdentifierIsConfiguredAnywhere() throws {
        for (path, code) in try everyShippableSource() {
            for shape in ["com.relayium.plus", "com.relayium.pro", "com.relayium.max",
                          ".monthly\"", ".yearly\"", "subscription.group"] {
                XCTAssertFalse(code.contains(shape),
                               "\(path) carries what looks like a product identifier: \(shape)")
            }
        }
    }

    // MARK: - 7: the shipping plan handoff is untouched

    /// **What the apps ship today for changing a plan is a link to the website,
    /// and it stays that way in this batch.**
    ///
    /// This is the half a ban cannot make. Every assertion above says the
    /// purchase path is absent; without this one, a batch that deleted the
    /// existing button would satisfy all of them and leave users with no way to
    /// change a plan at all.
    func testThePlanHandoffStillGoesToTheWebsiteOnBothPlatforms() throws {
        let surfaces = ["ios/Relayium/AccountSummaryView.swift",
                        "mac/Relayium/AccountView.swift"]
        for surface in surfaces {
            let text = try String(contentsOf: appsRoot.appendingPathComponent(surface),
                                  encoding: .utf8)
            XCTAssertTrue(text.contains("Button(L10n.t(.accountManagePlan))"),
                          "\(surface) lost the plan handoff control")
            XCTAssertTrue(text.contains("AppEnvironment.plansWebURL"),
                          "\(surface) no longer sends a plan change to the website")
        }
        // The macOS build is a direct download and opens the page in a browser;
        // iOS opens it through the environment's URL action. Both are unchanged.
        let mac = try String(contentsOf: appsRoot.appendingPathComponent(surfaces[1]),
                             encoding: .utf8)
        XCTAssertTrue(mac.contains("NSWorkspace.shared.open(AppEnvironment.plansWebURL)"))
        let ios = try String(contentsOf: appsRoot.appendingPathComponent(surfaces[0]),
                             encoding: .utf8)
        XCTAssertTrue(ios.contains("openURL(AppEnvironment.plansWebURL)"))
    }

    // MARK: - the adapter itself

    /// The adapter exists, is one file, and is buildable — the test target links
    /// it, so this test file compiling at all is most of the claim. What is
    /// asserted here is the part a compile cannot: that it stayed a single
    /// translation unit with nothing else smuggled beside it.
    func testTheAdapterIsOneFileAndTypeChecksAgainstTheSeam() throws {
        let files = try FileManager.default.subpathsOfDirectory(atPath: adapterRoot.path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertEqual(files, ["StoreKitSubscriptionStore.swift"])
        // Named through the seam's type, so a signature that drifted from
        // `SubscriptionStore` fails to compile here rather than at the batch
        // that finally wires a purchase up.
        let store: any SubscriptionStore = StoreKitSubscriptionStore()
        XCTAssertTrue(store is StoreKitSubscriptionStore)
    }
}
