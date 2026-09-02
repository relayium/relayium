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
    private func manifest(_ path: String) throws -> [String: Any] {
        let data = try RepoRoot.data(path)
        return try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
    }
    /// The declared required-reason entries, in FILE ORDER, as
    /// (category, reasons). Read as a list rather than folded straight into a
    /// dictionary because a manifest can declare the same category twice, and
    /// the two obvious readers both answer the wrong question about it:
    /// `Dictionary(uniqueKeysWithValues:)` traps, which is a crashed test rather
    /// than a reported finding, and a set-shaped reader collapses the duplicate
    /// into a graph that compares equal to the correct one.
    ///
    /// It is LOSSY: an element it cannot read is discarded, and both the
    /// discarded element and the `?? []` below are only safe because
    /// `assertAPIEntriesAreCompleteAndDistinct` runs at every call site.
    private func apiEntries(_ plist: [String: Any]) -> [(category: String, reasons: [String])] {
        let entries = plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]] ?? []
        return entries.compactMap { entry in
            (entry["NSPrivacyAccessedAPIType"] as? String).map {
                (category: $0, reasons: entry["NSPrivacyAccessedAPITypeReasons"] as? [String] ?? [])
            }
        }
    }
    /// The same entries keyed by category. Safe to build only alongside the
    /// completeness and duplicate checks, which is why every caller asserts them.
    private func apiTypes(_ plist: [String: Any]) -> [String: [String]] {
        Dictionary(apiEntries(plist).map { ($0.category, $0.reasons) },
                   uniquingKeysWith: { first, _ in first })
    }

    /// The two keys Apple defines for a required-reason entry.
    private let apiEntryKeys = ["NSPrivacyAccessedAPIType",
                                "NSPrivacyAccessedAPITypeReasons"]

    /// **Every raw `NSPrivacyAccessedAPITypes` element, accounted for.**
    ///
    /// The readers above are lossy, so this is what makes the graph assertions
    /// honest. Comparing the parsed entry count against the DICTIONARY count
    /// would not: both are produced by discarding the same elements, so they
    /// agree precisely when something has gone missing. The raw element count is
    /// the only number a malformed entry cannot move.
    ///
    /// Each way an element can vanish fails here, closed:
    ///
    ///  1. the key is absent, or is not an array — the whole list reads as
    ///     nothing and every graph assertion below passes over an empty set;
    ///  2. an element is not a dictionary — Swift's array cast is
    ///     all-or-nothing, so the typed read of the WHOLE list becomes `nil` and
    ///     every well-formed entry disappears alongside the bad one;
    ///  3. an element declares no `NSPrivacyAccessedAPIType` — it drops out of
    ///     `apiEntries`, and the entries that remain can still equal the audited
    ///     graph exactly while the shipped file carries an entry Apple reads and
    ///     this file never saw;
    ///  4. an element's reasons are missing, not an array of strings, or empty —
    ///     `?? []` turns the first two into "declared with no reason", which is
    ///     an upload rejection rather than something to describe;
    ///  5. an element carries a key outside Apple's two;
    ///  6. two elements declare the same category — `apiTypes` keeps the first,
    ///     so the second's reason list is invisible to every check that follows.
    private func assertAPIEntriesAreCompleteAndDistinct(
        _ plist: [String: Any], _ path: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let raw = plist["NSPrivacyAccessedAPITypes"] as? [Any] ?? []
        XCTAssertFalse(raw.isEmpty,
                       "\(path) declares no required-reason API list to check",
                       file: file, line: line)
        let dictionaries = plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]] ?? []
        XCTAssertEqual(dictionaries.count, raw.count,
                       "\(path): an NSPrivacyAccessedAPITypes element is not a dictionary and "
                        + "would be read as absent", file: file, line: line)
        let entries = apiEntries(plist)
        XCTAssertEqual(entries.count, raw.count,
                       "\(path): an NSPrivacyAccessedAPITypes element declares no "
                        + "NSPrivacyAccessedAPIType and would be discarded unread",
                       file: file, line: line)

        for (index, entry) in dictionaries.enumerated() {
            XCTAssertEqual(entry.keys.sorted(), apiEntryKeys,
                           "\(path) entry \(index) is not the shape Apple defines: "
                            + "\(entry.keys.sorted())", file: file, line: line)
            XCTAssertNotNil(entry["NSPrivacyAccessedAPIType"] as? String,
                            "\(path) entry \(index) names no category", file: file, line: line)
            let reasons = entry["NSPrivacyAccessedAPITypeReasons"] as? [String]
            XCTAssertNotNil(reasons,
                            "\(path) entry \(index) has no string reason array; the reader "
                             + "turns that into an empty one", file: file, line: line)
            XCTAssertEqual(reasons?.isEmpty, false,
                           "\(path) entry \(index) declares a category with no reason code",
                           file: file, line: line)
        }

        XCTAssertEqual(entries.count, apiTypes(plist).count,
                       "\(path) declares a category more than once: \(entries.map(\.category))",
                       file: file, line: line)
    }
    private func swiftSources(under relative: String) throws -> String {
        // `RepoRoot.swiftFiles(under:)` throws on a missing root AND on a root
        // that contains no Swift at all: both would make every "the app does not
        // call X" assertion below pass over nothing.
        return try RepoRoot.swiftFiles(under: relative)
            .map { try RepoRoot.text(of: $0) }
            .joined(separator: "\n")
    }

    private let appManifest = "apps/ios/Relayium/PrivacyInfo.xcprivacy"
    private let shareManifest = "apps/ios/RelayiumShare/PrivacyInfo.xcprivacy"

    /// **The spellings that mean free space and nothing else.** Used where the
    /// scan must prove a free-space read is PRESENT.
    ///
    /// `InboxSpace.freeBytes` calls `statfs`, and a scan that knew only
    /// `volumeAvailableCapacity` — which is what this file used to look for —
    /// reported "disk space is not used" over source that had been reading it
    /// since Device Inbox landed. The absence assertion passed by asking about
    /// the wrong symbol, which is the exact failure mode a source-derived
    /// manifest test exists to prevent.
    ///
    /// This is NOT Apple's full Disk Space list, and it deliberately stops short
    /// of it: `getattrlist` and friends are in Apple's list but read whatever
    /// attribute they are asked for, so a presence scan that accepted one would
    /// report "the free-space call is still there" over a call that reads a file
    /// date. Over-declaring E174.1 is the thing this direction exists to catch,
    /// so the presence set admits only unambiguous readings. The `f`-prefixed
    /// variants are spelled out rather than left to substring luck:
    /// `contains("statfs")` does match `fstatfs`, but relying on that would make
    /// the list read as complete when it was only accidentally sufficient.
    private let freeSpaceAPIs = ["statfs", "fstatfs", "statvfs", "fstatvfs",
                                 "volumeAvailableCapacity", "systemFreeSize"]

    /// **Apple's Disk Space category, as completely as a source scan can name
    /// it.** Used where the scan must prove NO such call exists, which is the
    /// direction where a missing spelling is the dangerous one: an under-declared
    /// required-reason API is an upload rejection, while a false positive here is
    /// only a failing test that a human then reads.
    ///
    /// So this adds the ambiguous members the presence set above excludes — the
    /// `getattrlist` family, and the volume/filesystem capacity keys in both
    /// their Swift and Objective-C spellings. Matched lowercased, which is what
    /// lets one needle cover a family: `statfs` covers `fstatfs`, `getattrlist`
    /// covers `fgetattrlist` and `getattrlistbulk`, and `systemfreesize` covers
    /// both `.systemFreeSize` and `NSFileSystemFreeSize`.
    ///
    /// `systemsize` rather than `filesystemsize` for the total-size key, because
    /// the two spellings are not the same needle: `NSFileSystemSize` contains
    /// both, but `FileAttributeKey.systemSize` — the Swift name, and the one
    /// this codebase would actually be written with — contains only the shorter.
    /// The longer needle read as covering "both spellings" while matching just
    /// the Objective-C one, which is the same way this list's presence-side twin
    /// once passed over a call it could not spell.
    private let diskSpaceAPIsLowercased = ["statfs", "statvfs", "getattrlist",
                                           "volumeavailablecapacity", "volumetotalcapacity",
                                           "systemfreesize", "systemsize"]

    /// The app's exact required-reason graph. Asserted as a whole, in addition
    /// to each entry being traced to a call site below, because the three ways
    /// this file goes wrong are all invisible one entry at a time: a category
    /// nothing calls, a category declared twice, and a reason list carrying a
    /// second code nobody justified.
    private let expectedAppGraph = [
        "NSPrivacyAccessedAPICategoryUserDefaults": ["CA92.1"],
        "NSPrivacyAccessedAPICategoryFileTimestamp": ["DDA9.1"],
        "NSPrivacyAccessedAPICategorySystemBootTime": ["35F9.1"],
        "NSPrivacyAccessedAPICategoryDiskSpace": ["E174.1"],
    ]

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

    /// **The proof that the completeness check catches what the reader drops.**
    ///
    /// Everything the graph assertions conclude rests on `apiEntries` having
    /// seen the whole file, and the obvious way to assert that does not work:
    /// comparing the parsed entry count against the dictionary count compares
    /// two numbers a discarded element moves together, so it agrees exactly when
    /// it should not. That is written out here against a synthetic manifest,
    /// because it is the shape of mistake that reads as a check and is not one.
    func testTheEntryCheckSeesAnElementTheReaderWouldSilentlyDiscard() {
        func plist(_ entries: [Any]) -> [String: Any] { ["NSPrivacyAccessedAPITypes": entries] }
        let diskSpace: [String: Any] = [
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryDiskSpace",
            "NSPrivacyAccessedAPITypeReasons": ["E174.1"]]

        // The real shape parses whole, and passes the check the manifests use.
        assertAPIEntriesAreCompleteAndDistinct(plist([diskSpace]), "<synthetic>")
        XCTAssertEqual(apiEntries(plist([diskSpace])).map(\.category),
                       ["NSPrivacyAccessedAPICategoryDiskSpace"],
                       "the reader no longer recognises a well-formed entry")

        // An element declaring no category. The reader discards it, so the
        // entries that remain are exactly the audited graph — and the count it
        // would have been compared against has moved by the same one.
        let missingCategory = plist([diskSpace, ["NSPrivacyAccessedAPITypeReasons": ["CA92.1"]]])
        XCTAssertEqual(apiEntries(missingCategory).map(\.category),
                       ["NSPrivacyAccessedAPICategoryDiskSpace"],
                       "the malformed element is no longer discarded; this proof is stale")
        XCTAssertEqual(apiEntries(missingCategory).count, apiTypes(missingCategory).count,
                       "the entry-vs-dictionary comparison rejects this, so the raw-count check "
                        + "below is no longer the only thing standing between a malformed "
                        + "element and a passing graph assertion")
        XCTAssertNotEqual(apiEntries(missingCategory).count,
                          (missingCategory["NSPrivacyAccessedAPITypes"] as? [Any])?.count,
                          "the raw element count no longer sees the discarded element")

        // An element that is not a dictionary at all. The loss is bigger than it
        // looks: Swift's array cast is all-or-nothing, so ONE bad element makes
        // the typed read of the whole list `nil`, every good entry disappears
        // with it, and `?? []` presents the result as a manifest that declares
        // nothing. The raw `[Any]` read is what still counts them.
        let notADictionary = plist([diskSpace, "NSPrivacyAccessedAPICategoryUserDefaults"])
        XCTAssertNil(notADictionary["NSPrivacyAccessedAPITypes"] as? [[String: Any]],
                     "one non-dictionary element no longer voids the typed read of the list")
        XCTAssertTrue(apiEntries(notADictionary).isEmpty,
                      "the reader no longer loses the whole list to a single bad element")
        XCTAssertEqual((notADictionary["NSPrivacyAccessedAPITypes"] as? [Any])?.count, 2,
                       "the raw read no longer sees every element")

        // And a duplicated category, which the raw count CANNOT see — both
        // elements parse — so the distinctness check is a separate assertion
        // rather than a consequence of this one.
        let duplicated = plist([diskSpace, diskSpace])
        XCTAssertEqual(apiEntries(duplicated).count,
                       (duplicated["NSPrivacyAccessedAPITypes"] as? [Any])?.count,
                       "a duplicate no longer parses whole; the raw-count check would catch it "
                        + "and the distinctness assertion would be untested")
        XCTAssertNotEqual(apiEntries(duplicated).count, apiTypes(duplicated).count,
                          "a category declared twice would pass the distinctness check")
    }

    /// The app's four required-reason APIs, each traceable to a call site.
    ///
    /// The source scan is the point: if someone adds a `UserDefaults` read to a
    /// module the app links, or removes the last one, this test moves before
    /// anybody remembers the manifest exists.
    func testTheAppDeclaresExactlyTheRequiredReasonAPIsItsSourceUses() throws {
        let linked = try swiftSources(under: "apps/RelayiumKit/Sources/RelayiumAppKit")
            + swiftSources(under: "apps/RelayiumKit/Sources/RelayiumShareKit")
            + swiftSources(under: "apps/RelayiumKit/Sources/RelayiumKit")
            + swiftSources(under: "apps/ios/Relayium")
        let plist = try manifest(appManifest)
        let declared = apiTypes(plist)

        // Every raw element parses, is Apple's shape, and names a category no
        // other element names. Asserted before the dictionary below is trusted:
        // a duplicate's second reason list and a malformed element alike are
        // invisible to every graph comparison that follows.
        assertAPIEntriesAreCompleteAndDistinct(plist, appManifest)

        // UserDefaults — VerificationPreference and SharedDraftInbox.
        XCTAssertTrue(linked.contains("UserDefaults"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryUserDefaults"], ["CA92.1"])

        // File timestamps — SharedDraftStore.stale, inside the group container.
        XCTAssertTrue(linked.contains(".modificationDate"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryFileTimestamp"], ["DDA9.1"])

        // System boot time — WebRTCLinkTransport's monotonic deadlines.
        XCTAssertTrue(linked.contains("systemUptime"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategorySystemBootTime"], ["35F9.1"])

        // Disk space — `InboxSpace.freeBytes` calls `statfs` on the receive
        // folder to refuse a Device Inbox delivery BEFORE writing it. E174.1 is
        // the reason for checking that there is room to write files, and it
        // holds only while nothing derived from the reading leaves the device:
        // the count is compared against the delivery's size and decides a local
        // refusal. `testTheAppSendsNothingDerivedFromTheFreeSpaceReading` below
        // is what keeps that half honest.
        XCTAssertTrue(freeSpaceAPIs.contains { linked.contains($0) },
                      "no free-space call remains in the app's linked source, so E174.1 is "
                       + "now over-declared; the scan looked for \(freeSpaceAPIs)")
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryDiskSpace"], ["E174.1"])

        // The whole graph, exactly — categories AND reasons, in both
        // directions. An entry the source does not justify, and a second reason
        // code appended to an entry that does, are the same kind of false
        // public statement and neither is visible in the per-entry checks above.
        XCTAssertEqual(declared, expectedAppGraph,
                       "the app's required-reason graph is not the audited one")
        XCTAssertEqual(declared.count, expectedAppGraph.count,
                       "the manifest declares an API the source does not use: \(declared.keys)")

        // The category still deliberately absent, asserted from the source so a
        // future call site cannot make the manifest wrong in silence.
        XCTAssertFalse(linked.contains("activeInputModes"),
                       "active keyboard is now used and must be declared")
        XCTAssertNil(declared["NSPrivacyAccessedAPICategoryActiveKeyboards"])
    }

    /// **E174.1's condition, read from the source rather than promised.**
    ///
    /// Apple permits `statfs` under Disk Space for checking that there is
    /// sufficient room to write files, *provided the information is not sent off
    /// device*. That proviso is the only part of the declaration that a later
    /// change could quietly break — adding the free byte count to a telemetry
    /// body or an error report would leave the category and reason code correct
    /// and the declaration false.
    ///
    /// So the reading's one producer is pinned: `InboxSpace.freeBytes` returns
    /// it, `InboxSpace.hasRoom` compares it, and the comparison's Bool is what
    /// the rest of the app sees.
    func testTheAppSendsNothingDerivedFromTheFreeSpaceReading() throws {
        let failure = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumAppKit/DeviceInbox/InboxFailure.swift")
        XCTAssertTrue(failure.contains("public static func freeBytes(_ url: URL) -> Int64?"),
                      "the free-space reading is no longer produced where this test can see it")
        XCTAssertTrue(failure.contains("for need: Int64,"),
                      "the free-space reading is no longer compared against a required size")

        // `hasRoom` returns a Bool. That is the whole reason the byte count is
        // safe to read: the count itself does not leave `InboxSpace`, only the
        // answer to "does this fit" does.
        XCTAssertTrue(failure.contains("freeBytes: (URL) -> Int64?) -> Bool {"),
                      "the free-space preflight no longer reduces the reading to a Bool")

        // And the raw `statfs` fields are read in exactly ONE file. A second
        // reader is not necessarily wrong, but it is the change that would put
        // the byte count somewhere this test is not looking — a log line, an
        // error body, a diagnostic — so it must be seen rather than absorbed.
        let files = try RepoRoot.swiftFiles(under: "apps/RelayiumKit/Sources")
            + RepoRoot.swiftFiles(under: "apps/ios/Relayium")
        let readers = try files.filter { try RepoRoot.text(of: $0).contains("f_bavail") }
        XCTAssertEqual(readers.map(\.lastPathComponent), ["InboxFailure.swift"],
                       "the free-space reading is derived somewhere new; re-read E174.1's "
                        + "off-device proviso before leaving the declaration as it is")

        // Nothing in that file reaches the network, so there is no transmission
        // for the proviso to be broken by.
        for offDevice in ["URLSession", "URLRequest", "httpBody"] {
            XCTAssertFalse(failure.contains(offDevice),
                           "InboxFailure.swift gained \(offDevice); a free-space reading that "
                            + "leaves the device is not what E174.1 permits")
        }
    }

    /// The extension links only `RelayiumShareKit`, so its list is ONE entry.
    /// Copying the app's four here would declare APIs this process cannot call.
    func testTheExtensionDeclaresOnlyWhatItsOwnModuleUses() throws {
        let shareKit = try swiftSources(under: "apps/RelayiumKit/Sources/RelayiumShareKit")
        let plist = try manifest(shareManifest)
        let declared = apiTypes(plist)

        assertAPIEntriesAreCompleteAndDistinct(plist, shareManifest)
        XCTAssertTrue(shareKit.contains(".modificationDate"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryFileTimestamp"], ["DDA9.1"])
        XCTAssertEqual(declared, ["NSPrivacyAccessedAPICategoryFileTimestamp": ["DDA9.1"]],
                       "the extension's required-reason graph is not its own smaller one")
        XCTAssertEqual(declared.count, 1,
                       "the extension declares more than its module uses: \(declared.keys)")

        XCTAssertFalse(shareKit.contains("UserDefaults"),
                       "RelayiumShareKit gained UserDefaults; the extension manifest must say so")
        XCTAssertFalse(shareKit.contains("systemUptime"),
                       "RelayiumShareKit gained systemUptime; the extension manifest must say so")

        // Disk space is the app's, not the extension's. `InboxSpace` lives in
        // `RelayiumAppKit`, which this target does not link — so the absence is
        // read from the module rather than assumed from the module list, over
        // the wider set: this is the direction where a spelling the scan does
        // not know is an undeclared required-reason API rather than a noisy test.
        let lowercasedShareKit = shareKit.lowercased()
        for api in diskSpaceAPIsLowercased {
            XCTAssertFalse(lowercasedShareKit.contains(api),
                           "RelayiumShareKit gained \(api); the extension manifest must declare "
                            + "Disk Space or the call must go")
        }
        XCTAssertNil(declared["NSPrivacyAccessedAPICategoryDiskSpace"])

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
        let client = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift")
        XCTAssertTrue(client.contains("\"email\": email"),
                      "if the app stopped sending an email, this declaration would be wrong")
        let billing = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Account/AppleBillingClient.swift")
        XCTAssertTrue(billing.contains("submitAppleTransaction"),
                      "the app no longer sends a transaction whose history it declares")
        let store = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumStoreKit/StoreKitSubscriptionStore.swift")
        XCTAssertTrue(store.contains(".appAccountToken(appAccountToken)"),
                      "the app no longer sends the declared per-account identifier to Apple")
    }
}
