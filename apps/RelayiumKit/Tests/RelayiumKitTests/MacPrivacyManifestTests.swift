import XCTest

/// The macOS privacy manifests, checked against the source they describe.
///
/// A manifest is a **public statement** rather than an implementation detail,
/// and nothing else can contradict it: the app builds, tests and runs
/// identically whether it is accurate, wrong or absent, and the first thing that
/// notices is an upload rejection or a false label.
///
/// Two things are macOS's own:
///
///  1. **Two channels, one statement.** `Relayium` and `RelayiumAppStore` build
///     from the same synchronized folder, so one file declares for both. Only
///     the App Store product is submitted.
///  2. **Membership is decided by the filesystem.** The folder is synchronized,
///     so a file is in every target it feeds *unless a `membershipExceptions`
///     list names it* — an omission no diff would show, which is why those
///     lists are read here.
final class MacPrivacyManifestTests: XCTestCase {
    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
    }
    /// Any plist in the repo — the manifests, and the entitlements read beside
    /// them. Parsed rather than searched as text: these files explain their own
    /// absences at length, so a substring check answers the prose.
    private func parsedPlist(_ path: String) throws -> [String: Any] {
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
    private func text(_ relative: String) throws -> String {
        try String(contentsOf: repoRoot.appendingPathComponent(relative), encoding: .utf8)
    }
    /// The declared types, in file order, with the three flags Apple requires of
    /// each entry.
    private func collected(_ plist: [String: Any]) throws -> [(type: String, entry: [String: Any])] {
        let entries = try XCTUnwrap(plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        return try entries.map { (try XCTUnwrap($0["NSPrivacyCollectedDataType"] as? String), $0) }
    }

    private let appManifest = "apps/mac/Relayium/PrivacyInfo.xcprivacy"
    private let shareManifest = "apps/mac/RelayiumShare/PrivacyInfo.xcprivacy"

    /// Both bundles have one. An appex is a separate bundle and Apple reads a
    /// separate file for it; shipping only the app's would leave the extension
    /// undeclared.
    ///
    /// The key sets are asserted exactly, in both directions: a manifest missing
    /// `NSPrivacyTrackingDomains` and a manifest carrying a fifth key Apple does
    /// not define are both wrong, and neither has a runtime.
    func testBothBundlesDeclareOne() throws {
        for path in [appManifest, shareManifest] {
            let plist = try parsedPlist(path)
            XCTAssertEqual(plist["NSPrivacyTracking"] as? Bool, false, path)
            XCTAssertEqual((plist["NSPrivacyTrackingDomains"] as? [String])?.isEmpty, true,
                           "\(path) names a tracking domain")
            XCTAssertEqual(Set(plist.keys),
                           ["NSPrivacyTracking", "NSPrivacyTrackingDomains",
                            "NSPrivacyCollectedDataTypes", "NSPrivacyAccessedAPITypes"],
                           "\(path) declares a key outside Apple's four")
        }
    }

    /// The app's three required-reason APIs, each traceable to a call site.
    ///
    /// The source scan is the point: if someone adds a `UserDefaults` read to a
    /// module either macOS target links, or removes the last one, this test moves
    /// before anybody remembers the manifest exists.
    func testTheAppDeclaresExactlyTheRequiredReasonAPIsItsSourceUses() throws {
        let linked = try swiftSources(under: "apps/RelayiumKit/Sources/RelayiumAppKit")
            + swiftSources(under: "apps/RelayiumKit/Sources/RelayiumShareKit")
            + swiftSources(under: "apps/RelayiumKit/Sources/RelayiumKit")
            + swiftSources(under: "apps/mac/Relayium")
        let declared = apiTypes(try parsedPlist(appManifest))

        // UserDefaults — VerificationPreference, SharedDraftInbox and the Device
        // Inbox folder store.
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

    /// **The extension is not the app.** It links only `RelayiumShareKit`, so
    /// its API list is ONE entry and it collects nothing — copying the app's
    /// collected-data types and three APIs here would describe a process that
    /// never reaches the network. The absences are read from the appex's own
    /// sources as well as the module, since either can acquire the call.
    func testTheExtensionDeclaresOnlyWhatItsOwnModuleUses() throws {
        let shareKit = try swiftSources(under: "apps/RelayiumKit/Sources/RelayiumShareKit")
        let appex = shareKit + (try swiftSources(under: "apps/mac/RelayiumShare"))
        let declared = apiTypes(try parsedPlist(shareManifest))

        XCTAssertTrue(shareKit.contains(".modificationDate"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryFileTimestamp"], ["DDA9.1"])
        XCTAssertEqual(declared.count, 1,
                       "the extension declares more than its module uses: \(declared.keys)")

        XCTAssertFalse(appex.contains("UserDefaults"),
                       "the Share extension gained UserDefaults; its manifest must say so")
        XCTAssertFalse(appex.contains("systemUptime"),
                       "the Share extension gained systemUptime; its manifest must say so")

        // It reaches no network, so it collects nothing — everything the app
        // sends is declared in the app's own manifest.
        XCTAssertEqual(try collected(try parsedPlist(shareManifest)).map(\.type), [],
                       "the Share extension's manifest claims to collect something")
        // And the sandbox is why: no network entitlement, so there is no
        // transmission for a collected-data entry to describe.
        let entitlements = try parsedPlist("apps/mac/RelayiumShare/RelayiumShare.entitlements")
        XCTAssertNil(entitlements["com.apple.security.network.client"],
                     "the Share extension gained network access; re-audit its manifest")
    }

    /// **The app's collected-data set, exactly.**
    ///
    /// Apple's definition of collection is "transmitted off device and retained
    /// beyond servicing the request", so each entry needs both halves. Every
    /// type below is a distinct macOS call site, and the files are absent
    /// because the server holds only ciphertext — the product's central promise,
    /// stated where Apple publishes it.
    func testTheAppDeclaresExactlyTheDataItSendsAndRetains() throws {
        let declared = try collected(try parsedPlist(appManifest))
        XCTAssertEqual(declared.map(\.type),
                       ["NSPrivacyCollectedDataTypeName",
                        "NSPrivacyCollectedDataTypeEmailAddress",
                        "NSPrivacyCollectedDataTypePurchaseHistory",
                        "NSPrivacyCollectedDataTypeUserID",
                        "NSPrivacyCollectedDataTypeDeviceID",
                        "NSPrivacyCollectedDataTypeOtherUsageData"],
                       "the app's collected-data set is not the audited one")
        // Every entry is the shape Apple defines, and says the same three things:
        // linked to the account, not tracking, app functionality.
        for (type, entry) in declared {
            XCTAssertEqual(entry.keys.sorted(),
                           ["NSPrivacyCollectedDataType", "NSPrivacyCollectedDataTypeLinked",
                            "NSPrivacyCollectedDataTypePurposes",
                            "NSPrivacyCollectedDataTypeTracking"],
                           "\(type) is not the shape Apple defines")
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, true, type)
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeTracking"] as? Bool, false, type)
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypePurposes"] as? [String],
                           ["NSPrivacyCollectedDataTypePurposeAppFunctionality"], type)
        }
    }

    /// **Each declaration against the call site that sends it and the column
    /// that keeps it.** A declaration nothing sends is as false as a missing
    /// one, so both ends are read here rather than asserted in a comment.
    func testEachDeclaredTypeHasASendingCallSiteAndRetainedStorage() throws {
        let account = try text("apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift")
        let billing = try text("apps/RelayiumKit/Sources/RelayiumKit/Account/AppleBillingClient.swift")
        let storeKit = try text(
            "apps/RelayiumKit/Sources/RelayiumStoreKit/StoreKitSubscriptionStore.swift")
        let login = try text("apps/mac/Relayium/LoginView.swift")
        let schema = try text("server/account/sqlite.go")

        // Name — the create-account form's own field, plus the Mac's computer
        // name, which macOS seeds from the owner's full name.
        XCTAssertTrue(login.contains("$draft.displayName"), "the account form lost its name field")
        XCTAssertTrue(account.contains("\"displayName\": displayName"))
        XCTAssertTrue(account.contains("\"deviceName\": deviceName"))
        XCTAssertTrue(try text("apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift")
            .contains("Host.current().localizedName"))
        XCTAssertTrue(schema.contains("display_name TEXT"))

        // Email address — the account identifier itself.
        XCTAssertTrue(account.contains("\"email\": email"))
        XCTAssertTrue(schema.contains("email        TEXT UNIQUE NOT NULL"))

        // Purchase history — the signed transaction goes up verbatim, and the
        // server keeps the product, period and Apple subscription id it proves.
        XCTAssertTrue(billing.contains("api/billing/apple/transaction"))
        XCTAssertTrue(storeKit.contains("jwsRepresentation"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS subscription_sources"))
        let appleBilling = try text("server/account/billing_apple_transaction.go")
        let flatAppleBilling = appleBilling.split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        let appleIdentity = try text("server/account/apple_identity.go")
        XCTAssertTrue(flatAppleBilling.contains("ExternalID: externalID"))
        XCTAssertTrue(appleBilling.contains("appleSubscriptionKeyOf(tx).externalID()"))
        XCTAssertTrue(appleIdentity.contains("OriginalTransactionID: tx.OriginalTransactionID"))

        // User ID — the appAccountToken, minted per account, sent off device to
        // Apple with the purchase and kept on the users row.
        XCTAssertTrue(billing.contains("api/billing/apple/purchase-dispatch"))
        XCTAssertTrue(storeKit.contains(".appAccountToken(appAccountToken)"))
        XCTAssertTrue(schema.contains("ADD COLUMN apple_account_token"))

        // Device ID — the installation identity, posted when browser sign-in
        // begins and kept, unique per account, on the device row.
        XCTAssertTrue(login.contains("makeBrowserLoginModel"))
        XCTAssertTrue(try text("apps/RelayiumKit/Sources/RelayiumKit/Account/DeviceAuthClient.swift")
            .contains("[\"install_id\": installationID]"))
        XCTAssertTrue(schema.contains("ADD COLUMN install_id"))

        // Other usage data — the metering counters. Three transports produce
        // them and each has a table that outlives the transfer: uploads and
        // stored downloads are metered into usage_monthly (and the ciphertext's
        // size into stored_files), while relayed bytes reach the account through
        // the TURN username's `<owner>.<code>` and a node's heartbeat.
        let files = try text("server/account/files.go")
        XCTAssertTrue(try text("apps/RelayiumKit/Sources/RelayiumKit/Cloud/ResumableTransport.swift")
            .contains("api/uploads"))
        XCTAssertTrue(try text("apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift")
            .contains("api/files/"))
        XCTAssertTrue(files.contains("MeterUpload") && files.contains("MeterDownload"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS usage_monthly"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS stored_files"))

        XCTAssertTrue(try text("apps/RelayiumKit/Sources/RelayiumKit/Account/ICEClient.swift")
            .contains("api/ice"))
        XCTAssertTrue(try text("server/account/turn.go").contains("owner + \".\" + code"))
        XCTAssertTrue(try text("server/account/nodes.go").contains("RecordUsage"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS usage_events"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS usage_periods"))

        // And the app reads its own totals back, which is where the user sees
        // what is being kept.
        XCTAssertTrue(account.contains("api/me/usage"))
    }

    /// **The absences, asserted from the source.** These are the categories the
    /// audit ruled out, and each would become a false statement the moment the
    /// named symbol appeared. Product Interaction is the one to keep an eye on:
    /// the app declares Other Usage Data for byte metering, and the two are
    /// easily confused — but nothing here records a tap or a screen.
    func testTheAppDeclaresNoAnalyticsOrDiagnosticsItDoesNotCollect() throws {
        let linked = try swiftSources(under: "apps/RelayiumKit/Sources")
            + swiftSources(under: "apps/mac/Relayium")
        for absent in ["import MetricKit", "Crashlytics", "FirebaseAnalytics", "SentrySDK"] {
            XCTAssertFalse(linked.contains(absent),
                           "\(absent) collects diagnostics; the manifest must say so")
        }
        let types = try collected(try parsedPlist(appManifest)).map(\.type)
        for banned in ["NSPrivacyCollectedDataTypeProductInteraction",
                       "NSPrivacyCollectedDataTypeCrashData",
                       "NSPrivacyCollectedDataTypePerformanceData",
                       "NSPrivacyCollectedDataTypeOtherDiagnosticData",
                       "NSPrivacyCollectedDataTypePaymentInfo",
                       "NSPrivacyCollectedDataTypePreciseLocation",
                       "NSPrivacyCollectedDataTypeCoarseLocation"] {
            XCTAssertFalse(types.contains(banned), "\(banned) is declared but nothing collects it")
        }
    }

    // MARK: - membership, which the filesystem decides

    /// Every `PBXFileSystemSynchronizedBuildFileExceptionSet` in the macOS
    /// project, as (target name, the paths it removes from that target).
    ///
    /// Read structurally rather than as text, for the reason
    /// `StoreKitLinkageTests` reads linkage structurally: the whole question is
    /// WHICH target a name is excluded from, and a substring search over the
    /// project answers a different one.
    private func membershipExceptions() throws -> [(target: String, excluded: [String])] {
        let project = try String(
            contentsOf: repoRoot.appendingPathComponent(
                "apps/mac/Relayium.xcodeproj/project.pbxproj"), encoding: .utf8)
        let marker = "isa = PBXFileSystemSynchronizedBuildFileExceptionSet;"
        return try project.components(separatedBy: marker).dropFirst().map { chunk in
            // The exception set's own object block: it holds no nested braces,
            // so it ends at the first one.
            let block = String(chunk.prefix { $0 != "}" })
            let listStart = try XCTUnwrap(block.range(of: "membershipExceptions = ("),
                                          "an exception set declares no membershipExceptions")
            let listEnd = try XCTUnwrap(
                block.range(of: ");", range: listStart.upperBound..<block.endIndex),
                "unterminated membershipExceptions list")
            let excluded = block[listStart.upperBound..<listEnd.lowerBound]
                .components(separatedBy: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            // `target = <id> /* Name */;` — the name lives in the comment, which
            // is the only human-readable form of the object reference.
            let assignment = try XCTUnwrap(block.components(separatedBy: "target = ")
                                            .dropFirst().first,
                                           "an exception set names no target")
            let target = try XCTUnwrap(assignment.components(separatedBy: "/* ")
                                        .dropFirst().first?
                                        .components(separatedBy: " */").first,
                                       "an exception set's target has no name")
            return (String(target), excluded)
        }
    }

    /// **Neither manifest may be excluded from any target it belongs in.**
    ///
    /// This is the assertion the batch actually turns on. Both folders are
    /// synchronized root groups feeding two targets each — the direct product and
    /// the App Store product — so dropping a manifest from a bundle is not an
    /// edit anybody would review: it is one filename appearing in a list that
    /// already contains `Info.plist` for perfectly good reasons. The result
    /// builds, signs, and ships without the file Apple requires.
    func testNeitherPrivacyManifestIsExcludedFromAnyTarget() throws {
        let sets = try membershipExceptions()
        XCTAssertEqual(sets.map(\.target).sorted(),
                       ["Relayium", "RelayiumAppStore", "RelayiumShare",
                        "RelayiumShareAppStore"],
                       "the four macOS targets no longer each have an exception set")
        for (target, excluded) in sets {
            XCTAssertFalse(excluded.contains { $0.contains("PrivacyInfo.xcprivacy") },
                           "\(target) excludes its privacy manifest: \(excluded)")
            // The lists really are being read — every one of them removes the
            // per-channel `Info.plist`, so an empty parse would be a bug here
            // rather than a clean bill of health.
            XCTAssertTrue(excluded.contains("Info.plist"),
                          "\(target)'s exception list did not parse: \(excluded)")
        }
    }

    /// And the folders those exceptions apply to are the ones the manifests are
    /// in — otherwise the guard above is checking lists that govern nothing.
    func testEachManifestSitsInASynchronizedFolderBothChannelsBuildFrom() throws {
        let project = try String(
            contentsOf: repoRoot.appendingPathComponent(
                "apps/mac/Relayium.xcodeproj/project.pbxproj"), encoding: .utf8)
        for (folder, targets) in [("Relayium", ["Relayium", "RelayiumAppStore"]),
                                  ("RelayiumShare", ["RelayiumShare", "RelayiumShareAppStore"])] {
            XCTAssertTrue(project.contains("isa = PBXFileSystemSynchronizedRootGroup;"),
                          "the macOS project no longer synchronizes its folders")
            for target in targets {
                XCTAssertTrue(project.contains(
                    "Exceptions for \"\(folder)\" folder in \"\(target)\" target"),
                    "\(target) no longer builds from the \(folder) folder")
            }
            let manifest = repoRoot.appendingPathComponent("apps/mac/\(folder)/PrivacyInfo.xcprivacy")
            XCTAssertTrue(FileManager.default.fileExists(atPath: manifest.path),
                          "\(folder) has no privacy manifest to synchronize")
        }
    }

    /// **CI reads the built bundles**, because everything above reads the source.
    ///
    /// A manifest correct in the repository and absent from the product is the
    /// failure the synchronized folder makes possible, and no test in this
    /// package can see inside a `.app`. Both channels run the same script, so
    /// all four bundles get the same exact check.
    func testCIVerifiesTheBuiltManifestsOnBothChannels() throws {
        let workflow = try text(".github/workflows/macos.yml")
        let script = "bash apps/mac/scripts/verify-privacy-manifests.sh"
        XCTAssertEqual(workflow.components(separatedBy: script).count - 1, 2,
                       "the manifest verifier is not run once per macOS channel")
        // `dd-mas` is the App Store product, `dd` the direct download.
        for derivedData in ["dd-mas", "dd"] {
            XCTAssertTrue(workflow.contains(
                "\"$RUNNER_TEMP/\(derivedData)/Build/Products/Release/Relayium.app\" \""),
                "CI no longer verifies the manifests built into \(derivedData)")
        }
    }

    /// And the script CI runs makes the claims this file makes about the source:
    /// the app's exact set in order, the extension's emptiness, and both bundles
    /// linted.
    func testTheCIScriptEnforcesTheSameSetsThisFileDoes() throws {
        let script = try text("apps/mac/scripts/verify-privacy-manifests.sh")
        for type in try collected(try parsedPlist(appManifest)).map(\.type) {
            XCTAssertTrue(script.contains(type), "the CI script does not require \(type)")
        }
        for path in ["$app/Contents/Resources/PrivacyInfo.xcprivacy",
                     "$appex/Contents/Resources/PrivacyInfo.xcprivacy"] {
            XCTAssertTrue(script.contains(path), "the CI script does not read \(path)")
        }
        XCTAssertTrue(script.contains("plutil -lint \"$manifest\""),
                      "the CI script accepts shipped manifests without proving they are valid plists")
        // The extension's own two numbers, which are what tell the appex's
        // manifest from the app's when both are present and valid.
        XCTAssertTrue(script.contains("the Share extension's manifest claims to collect something"))
        XCTAssertTrue(script.contains("the Share extension ships the app's manifest, not its own"))
    }
}
