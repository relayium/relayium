import XCTest

/// The privacy manifests, checked against the source they describe.
///
/// A manifest is the one file in this repository that is a **public statement**
/// rather than an implementation detail: it becomes the App Store's privacy
/// label. It is also the one file nothing else can contradict — the app builds,
/// tests and runs identically whether it is accurate, wrong, or absent, and the
/// first thing that notices is an upload rejection or a false label.
///
/// So these tests re-derive the required-reason list from the source rather than
/// restating the plist. Both directions matter:
///
///  - **Under-declaring** is an upload rejection.
///  - **Over-declaring** is a false statement in the direction people assume is
///    safe, and it is why the extension's manifest is shorter than the app's
///    rather than a copy of it.
final class IOSPrivacyManifestTests: XCTestCase {
    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
    }
    private func manifest(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: repoRoot.appendingPathComponent(path))
        return try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
    }
    private func apiTypes(_ plist: [String: Any]) -> [String: [String]] {
        let entries = plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]] ?? []
        return Dictionary(uniqueKeysWithValues: entries.compactMap { entry in
            (entry["NSPrivacyAccessedAPIType"] as? String).map {
                ($0, entry["NSPrivacyAccessedAPITypeReasons"] as? [String] ?? [])
            }
        })
    }
    private func swiftSources(under relative: String) throws -> String {
        let root = repoRoot.appendingPathComponent(relative)
        let names = try FileManager.default.subpathsOfDirectory(atPath: root.path)
            .filter { $0.hasSuffix(".swift") }
        XCTAssertFalse(names.isEmpty, "no sources under \(relative)")
        return try names.map {
            try String(contentsOf: root.appendingPathComponent($0), encoding: .utf8)
        }.joined(separator: "\n")
    }

    private let appManifest = "apps/ios/Relayium/PrivacyInfo.xcprivacy"
    private let shareManifest = "apps/ios/RelayiumShare/PrivacyInfo.xcprivacy"

    /// Both bundles have one. An appex is a separate bundle and Apple reads a
    /// separate file for it; shipping only the app's would leave the extension
    /// undeclared.
    func testBothBundlesDeclareOne() throws {
        for path in [appManifest, shareManifest] {
            let plist = try manifest(path)
            XCTAssertEqual(plist["NSPrivacyTracking"] as? Bool, false, path)
            XCTAssertEqual((plist["NSPrivacyTrackingDomains"] as? [String])?.isEmpty, true,
                           "\(path) names a tracking domain")
        }
    }

    /// The app's three required-reason APIs, each traceable to a call site.
    ///
    /// The source scan is the point: if someone adds a `UserDefaults` read to a
    /// module the app links, or removes the last one, this test moves before
    /// anybody remembers the manifest exists.
    func testTheAppDeclaresExactlyTheRequiredReasonAPIsItsSourceUses() throws {
        let linked = try swiftSources(under: "apps/RelayiumKit/Sources/RelayiumAppKit")
            + swiftSources(under: "apps/RelayiumKit/Sources/RelayiumShareKit")
            + swiftSources(under: "apps/RelayiumKit/Sources/RelayiumKit")
            + swiftSources(under: "apps/ios/Relayium")
        let declared = apiTypes(try manifest(appManifest))

        // UserDefaults — VerificationPreference and SharedDraftInbox.
        XCTAssertTrue(linked.contains("UserDefaults"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryUserDefaults"], ["CA92.1"])

        // File timestamps — SharedDraftStore.stale, inside the group container.
        XCTAssertTrue(linked.contains(".modificationDate"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryFileTimestamp"], ["DDA9.1"])

        // System boot time — WebRTCLinkTransport's monotonic deadlines.
        XCTAssertTrue(linked.contains("systemUptime"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategorySystemBootTime"], ["35F9.1"])

        XCTAssertEqual(declared.count, 3,
                       "the manifest declares an API the source does not use: \(declared.keys)")

        // The two categories deliberately absent, asserted from the source so a
        // future call site cannot make the manifest wrong in silence.
        XCTAssertFalse(linked.contains("volumeAvailableCapacity"),
                       "disk space is now used and must be declared")
        XCTAssertFalse(linked.contains("activeInputModes"),
                       "active keyboard is now used and must be declared")
        XCTAssertNil(declared["NSPrivacyAccessedAPICategoryDiskSpace"])
        XCTAssertNil(declared["NSPrivacyAccessedAPICategoryActiveKeyboards"])
    }

    /// The extension links only `RelayiumShareKit`, so its list is ONE entry.
    /// Copying the app's three here would declare APIs this process cannot call.
    func testTheExtensionDeclaresOnlyWhatItsOwnModuleUses() throws {
        let shareKit = try swiftSources(under: "apps/RelayiumKit/Sources/RelayiumShareKit")
        let declared = apiTypes(try manifest(shareManifest))

        XCTAssertTrue(shareKit.contains(".modificationDate"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryFileTimestamp"], ["DDA9.1"])
        XCTAssertEqual(declared.count, 1,
                       "the extension declares more than its module uses: \(declared.keys)")

        XCTAssertFalse(shareKit.contains("UserDefaults"),
                       "RelayiumShareKit gained UserDefaults; the extension manifest must say so")
        XCTAssertFalse(shareKit.contains("systemUptime"),
                       "RelayiumShareKit gained systemUptime; the extension manifest must say so")

        // It reaches no network, so it collects nothing. The app collects the
        // email address and declares it there.
        XCTAssertEqual((try manifest(shareManifest)["NSPrivacyCollectedDataTypes"]
                        as? [[String: Any]])?.isEmpty, true)
    }

    /// The account identifier and Apple billing records are declared, and the
    /// encrypted files are not — the product promise stated where Apple
    /// publishes it.
    func testTheAppDeclaresAccountAndPurchaseDataButNoFileContent() throws {
        let collected = try XCTUnwrap(
            try manifest(appManifest)["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        let types = collected.compactMap { $0["NSPrivacyCollectedDataType"] as? String }
        XCTAssertEqual(types, [
            "NSPrivacyCollectedDataTypeEmailAddress",
            "NSPrivacyCollectedDataTypePurchaseHistory",
            "NSPrivacyCollectedDataTypeUserID",
        ])

        for item in collected {
            XCTAssertEqual(item["NSPrivacyCollectedDataTypeLinked"] as? Bool, true)
            XCTAssertEqual(item["NSPrivacyCollectedDataTypeTracking"] as? Bool, false)
            XCTAssertEqual(item["NSPrivacyCollectedDataTypePurposes"] as? [String],
                           ["NSPrivacyCollectedDataTypePurposeAppFunctionality"])
        }

        // The app really does send it — the declaration is not defensive.
        let client = try String(
            contentsOf: repoRoot.appendingPathComponent(
                "apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift"),
            encoding: .utf8)
        XCTAssertTrue(client.contains("\"email\": email"),
                      "if the app stopped sending an email, this declaration would be wrong")
        let billing = try String(
            contentsOf: repoRoot.appendingPathComponent(
                "apps/RelayiumKit/Sources/RelayiumKit/Account/AppleBillingClient.swift"),
            encoding: .utf8)
        XCTAssertTrue(billing.contains("submitAppleTransaction"),
                      "the app no longer sends a transaction whose history it declares")
        let store = try String(
            contentsOf: repoRoot.appendingPathComponent(
                "apps/RelayiumKit/Sources/RelayiumStoreKit/StoreKitSubscriptionStore.swift"),
            encoding: .utf8)
        XCTAssertTrue(store.contains(".appAccountToken(appAccountToken)"),
                      "the app no longer sends the declared per-account identifier to Apple")
    }
}
