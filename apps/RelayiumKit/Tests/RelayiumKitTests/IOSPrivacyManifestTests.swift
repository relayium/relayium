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

    // MARK: - the collected-data set

    /// The declared types, in FILE ORDER, with the whole entry alongside each.
    /// Order is preserved rather than folded into a set because the two shapes
    /// below are distinguished positionally, and because a duplicated type is a
    /// thing a set cannot report.
    private func collected(_ plist: [String: Any]) throws -> [(type: String,
                                                               entry: [String: Any])] {
        let entries = try XCTUnwrap(plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]],
                                    "the manifest declares no readable collected-data list")
        return try entries.map {
            (try XCTUnwrap($0["NSPrivacyCollectedDataType"] as? String,
                           "a collected-data entry names no type"), $0)
        }
    }

    /// The four keys Apple defines for a collected-data entry. Asserted as an
    /// exact sorted set on every entry: a fifth key is as wrong as a missing
    /// one, and neither has a runtime that would notice.
    private let collectedEntryKeys = ["NSPrivacyCollectedDataType",
                                      "NSPrivacyCollectedDataTypeLinked",
                                      "NSPrivacyCollectedDataTypePurposes",
                                      "NSPrivacyCollectedDataTypeTracking"]

    /// **The app's set is not homogeneous, and the split is the point.**
    ///
    /// Five entries describe data an account sends and the server keeps against
    /// that account: linked, non-tracking, App Functionality. The sixth is
    /// categorically different — a first-party monthly aggregate with no
    /// identifier in it at all — so it is unlinked and Analytics. Reading them
    /// as one list is what made the macOS twin of this file wrong.
    private let linkedFunctionalityTypes = ["NSPrivacyCollectedDataTypeName",
                                            "NSPrivacyCollectedDataTypeEmailAddress",
                                            "NSPrivacyCollectedDataTypePurchaseHistory",
                                            "NSPrivacyCollectedDataTypeUserID",
                                            "NSPrivacyCollectedDataTypeOtherUsageData"]
    private let aggregateAnalyticsType = "NSPrivacyCollectedDataTypeProductInteraction"

    /// **The entry this platform must NOT declare.** macOS declares it; iOS
    /// reaches neither producer. Named once so the absence assertions and the
    /// source scan below cannot drift apart.
    private let absentDeviceIDType = "NSPrivacyCollectedDataTypeDeviceID"

    /// The three server-owned milestones the aggregate may count.
    private let activationStages = ["code_minted", "room_opened", "room_paired"]

    /// **The app's collected-data set, exactly.**
    ///
    /// Apple's definition of collection is "transmitted off device and retained
    /// beyond servicing the request", so every entry needs both halves — which
    /// is what `testEachDeclaredTypeHasAnIOSSendingCallSiteAndRetainedStorage`
    /// reads. This test owns the SHAPE: which types, in which order, and the
    /// three answers each one gives.
    ///
    /// The order is asserted exactly because the candidate script indexes the
    /// built manifest positionally — it checks the first five against one shape
    /// and the sixth against another, so a reordering here would silently change
    /// which entry that script audits as which.
    ///
    /// The files themselves are deliberately absent and that is not an omission:
    /// they are encrypted on the device and the server sees ciphertext, so no
    /// file content or file metadata is collected in Apple's sense.
    func testTheAppDeclaresExactlyTheDataItSendsAndRetains() throws {
        let declared = try collected(try manifest(appManifest))
        XCTAssertEqual(declared.map(\.type), linkedFunctionalityTypes + [aggregateAnalyticsType],
                       "the app's collected-data set is not the audited one")

        // The first five are the shape Apple defines and say the same three
        // things: linked to the account, not tracking, app functionality.
        for (type, entry) in declared.prefix(linkedFunctionalityTypes.count) {
            XCTAssertEqual(entry.keys.sorted(), collectedEntryKeys,
                           "\(type) is not the shape Apple defines")
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, true, type)
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeTracking"] as? Bool, false, type)
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypePurposes"] as? [String],
                           ["NSPrivacyCollectedDataTypePurposeAppFunctionality"], type)
            XCTAssertNotEqual(type, aggregateAnalyticsType,
                              "the aggregate entry moved into the linked block")
        }

        // The sixth is the same four keys and three different answers. Each is
        // asserted on its own: unlinked is what makes it truthful, non-tracking
        // is the promise the whole file rests on, and Analytics — exactly one
        // purpose, not App Functionality alongside it — is what it is for.
        let aggregate = try XCTUnwrap(declared.last, "the app's manifest declares nothing")
        XCTAssertEqual(aggregate.type, aggregateAnalyticsType,
                       "the last entry is not the identifier-free aggregate")
        XCTAssertEqual(aggregate.entry.keys.sorted(), collectedEntryKeys,
                       "\(aggregate.type) is not the shape Apple defines")
        XCTAssertEqual(aggregate.entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, false,
                       "\(aggregate.type) claims to be linked to the user; nothing links it")
        XCTAssertEqual(aggregate.entry["NSPrivacyCollectedDataTypeTracking"] as? Bool, false,
                       aggregate.type)
        XCTAssertEqual(aggregate.entry["NSPrivacyCollectedDataTypePurposes"] as? [String],
                       ["NSPrivacyCollectedDataTypePurposeAnalytics"],
                       "\(aggregate.type) is not declared for exactly Analytics")

        // The whole list is distinct. A type declared twice would satisfy every
        // per-entry assertion above and publish two labels for one thing.
        XCTAssertEqual(Set(declared.map(\.type)).count, declared.count,
                       "a collected-data type is declared more than once: \(declared.map(\.type))")
    }

    /// **Each declaration against the iOS call site that sends it and the server
    /// column that keeps it.** A declaration nothing sends is as false as a
    /// missing one, so both ends are read here rather than asserted in a comment.
    ///
    /// Every send site named below is reached from `apps/ios/Relayium` or from a
    /// module this target links — deliberately NOT from `apps/mac`, because the
    /// macOS twin of this file already covers that platform and the two apps do
    /// not send the same set.
    func testEachDeclaredTypeHasAnIOSSendingCallSiteAndRetainedStorage() throws {
        let account = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift")
        let billing = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Account/AppleBillingClient.swift")
        let storeKit = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumStoreKit/StoreKitSubscriptionStore.swift")
        let signIn = try RepoRoot.text("apps/ios/Relayium/SignInView.swift")
        let schema = try RepoRoot.text("server/account/sqlite.go")

        // Name — the create-account form's own field, plus the name Apple hands
        // over on a first Sign in with Apple authorization. NOT the device
        // label: `testTheDeviceLabelThisAppSendsIsNotAName` owns that boundary.
        XCTAssertTrue(signIn.contains("text: $draft.displayName"),
                      "the iOS account form lost its name field")
        XCTAssertTrue(account.contains("\"displayName\": displayName"),
                      "registration no longer sends the typed name")
        XCTAssertTrue(signIn.contains("credential.fullName?.givenName"),
                      "Sign in with Apple no longer reads the name Apple provides")
        XCTAssertTrue(account.contains("\"nonce\": nonce, \"name\": name"),
                      "the native Apple sign-in no longer sends a name")
        XCTAssertTrue(schema.contains("display_name TEXT"),
                      "the server no longer retains the name this manifest declares")

        // Email address — the account identifier itself.
        XCTAssertTrue(account.contains("\"email\": email"),
                      "if the app stopped sending an email, this declaration would be wrong")
        XCTAssertTrue(schema.contains("email        TEXT UNIQUE NOT NULL"))

        // Purchase history — the signed transaction goes up verbatim, and the
        // server keeps the product, period and Apple subscription id it proves.
        XCTAssertTrue(billing.contains("submitAppleTransaction"),
                      "the app no longer sends a transaction whose history it declares")
        XCTAssertTrue(billing.contains("api/billing/apple/transaction"))
        XCTAssertTrue(storeKit.contains("jwsRepresentation"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS subscription_sources"))

        // User ID — the appAccountToken, minted per account, sent off device to
        // Apple with the purchase and kept on the users row.
        XCTAssertTrue(storeKit.contains(".appAccountToken(appAccountToken)"),
                      "the app no longer sends the declared per-account identifier to Apple")
        XCTAssertTrue(schema.contains("ADD COLUMN apple_account_token"))

        // Other usage data — the metering counters. Four transports produce them
        // on iOS and each has a table that outlives the transfer.
        XCTAssertTrue(try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Cloud/ResumableTransport.swift")
            .contains("api/uploads"))
        XCTAssertTrue(try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Cloud/CloudClient.swift")
            .contains("api/files/"))
        let files = try RepoRoot.text("server/account/files.go")
        XCTAssertTrue(files.contains("MeterUpload") && files.contains("MeterDownload"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS usage_monthly"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS stored_files"))

        XCTAssertTrue(try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Account/ICEClient.swift").contains("api/ice"))
        XCTAssertTrue(try RepoRoot.text("server/account/turn.go").contains("owner + \".\" + code"))
        XCTAssertTrue(try RepoRoot.text("server/account/nodes.go").contains("RecordUsage"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS usage_events"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS usage_periods"))

        // And the Device Inbox delivery this release adds, which is the reason
        // Other Usage Data is declared on iOS at all rather than inherited from
        // the macOS audit: receiving a file here is metered to the account.
        XCTAssertTrue(try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/DeviceInbox/InboxClient.swift")
            .contains("try taskPath(taskID, \"blob\")"),
                      "the Device Inbox no longer fetches a delivery's blob")
        let inboxTask = try RepoRoot.text("server/account/deviceinbox_task.go")
        XCTAssertTrue(inboxTask.contains("inbox/tasks/{taskId}/blob"),
                      "the metered Device Inbox blob route is gone")
        XCTAssertTrue(inboxTask.contains("RecordMeter(ctx, sf.UserID, MeterDownload, n"),
                      "a Device Inbox delivery is no longer metered to the account, so Other "
                       + "Usage Data may no longer describe what receiving costs")

        // And the app reads its own totals back, which is where the user sees
        // what is being kept.
        XCTAssertTrue(account.contains("api/me/usage"))

        // Product interaction — showing a cross-network code from this app is
        // what mints the code the aggregate counts.
        XCTAssertTrue(try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Account/PairClient.swift").contains("api/pair"))
        XCTAssertTrue(schema.contains("CREATE TABLE IF NOT EXISTS activation_funnel_monthly"))
    }

    /// **The device label this app sends is a hardware family, not a name.**
    ///
    /// This is the single most tempting entry to copy across from macOS, where
    /// `Host.current().localizedName` IS a name — macOS seeds the computer name
    /// from the owner's full name, which is exactly why the macOS manifest
    /// counts it under Name. iOS resolves the same function to a device family
    /// string, so the same declaration would describe a personal detail this
    /// build never sends.
    ///
    /// Read from the source rather than promised, in both directions: the macOS
    /// call must stay behind `#if os(macOS)`, and the iOS branch must stay the
    /// family-name computation.
    func testTheDeviceLabelThisAppSendsIsNotAName() throws {
        let environment = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift")

        // `deviceName()`'s own body, not the whole file. The file carries two
        // `#if os(macOS)` blocks, so "the source contains a macOS branch and a
        // Host reading somewhere" would be satisfied by the other one.
        let signature = "public static func deviceName() -> String {"
        let bodyStart = try XCTUnwrap(environment.range(of: signature),
                                      "AppEnvironment no longer declares deviceName()")
        var depth = 1
        var body = ""
        var index = bodyStart.upperBound
        while index < environment.endIndex, depth > 0 {
            let character = environment[index]
            index = environment.index(after: index)
            if character == "{" { depth += 1 }
            if character == "}" {
                depth -= 1
                if depth == 0 { break }
            }
            body.append(character)
        }
        XCTAssertEqual(depth, 0, "deviceName()'s body is unterminated")

        // The two branches, in order, inside that body. The macOS reading must
        // stay behind the platform condition: moved out, iOS would begin sending
        // a personal computer name and Name would mean something else here.
        let macOSBranch = try XCTUnwrap(body.range(of: "#if os(macOS)"),
                                        "deviceName() no longer distinguishes macOS from iOS")
        let hostReading = try XCTUnwrap(body.range(of: "Host.current().localizedName"),
                                        "the macOS device-name reading is gone; re-audit both "
                                         + "manifests rather than only this one")
        let elseBranch = try XCTUnwrap(body.range(of: "#else"),
                                       "deviceName() has no non-macOS branch")
        XCTAssertTrue(macOSBranch.upperBound <= hostReading.lowerBound,
                      "the computer-name reading is no longer inside the macOS branch")
        XCTAssertTrue(hostReading.upperBound <= elseBranch.lowerBound,
                      "the computer-name reading is no longer macOS-only")

        // And the iOS answer, in the branch iOS actually compiles: a hardware
        // family, computed from the model identifier.
        let iosBranch = body[elseBranch.upperBound...]
        XCTAssertTrue(iosBranch.contains("return deviceFamilyName(forModelIdentifier:"),
                      "iOS no longer answers with a device family; if it now sends a personal "
                       + "device name, Name's justification changes and this manifest must say so")
        XCTAssertTrue(environment.contains("for family in [\"iPhone\", \"iPad\", \"iPod\"]"),
                      "the device-family computation is no longer the bounded three-family one")

        // `UIDevice.current.name` is the API that would make this personal
        // again, and it is absent by design. Scanned with line comments stripped:
        // `deviceFamilyName`'s own documentation names the API in order to reject
        // it, and a raw substring search would read that sentence as a call site.
        let iosSources = try swiftSources(under: "apps/ios/Relayium")
            + swiftSources(under: "apps/RelayiumKit/Sources/RelayiumAppKit")
        XCTAssertFalse(withoutLineComments(iosSources).contains("UIDevice.current.name"),
                       "the app reads UIDevice.current.name; that is a user-chosen device name "
                        + "and would change what Name means in this manifest")
        // The prose that rejects it is still there, so the scan above is looking
        // at a file that still discusses the decision rather than one that forgot it.
        XCTAssertTrue(environment.contains("Not `UIDevice.current.name`"),
                      "AppEnvironment no longer records why the personal device name is refused")
    }

    /// Source with `//` line comments removed, so an absence scan cannot be
    /// defeated — or satisfied — by prose. Deliberately line-oriented: it does
    /// not try to understand block comments or string literals, and every caller
    /// uses it only to ask "is this symbol CALLED anywhere".
    private func withoutLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let marker = line.range(of: "//") else { return line }
                return line[line.startIndex..<marker.lowerBound]
            }
            .joined(separator: "\n")
    }

    /// **`DeviceID` is absent, and that absence is asserted from the iOS source
    /// rather than from the module list.**
    ///
    /// The macOS manifest declares Device ID for two producers. Both are
    /// reachable from modules this target LINKS, and neither is reached from
    /// iOS — so "we do not link it" would be the wrong proof and would go quiet
    /// the moment somebody wired one of them up from an iOS screen.
    ///
    ///  1. `HTTPDeviceAuthClient.start` posts `install_id` when a BROWSER
    ///     sign-in begins. There is no browser sign-in on iOS.
    ///  2. `purchase-dispatch`/`purchase-outcome` can carry an `appInstanceId`.
    ///     **This app does reach `purchase-dispatch`**, so "iOS never calls it"
    ///     would be the wrong proof and would fail on a correct build. The
    ///     identifier is absent for a narrower and checkable reason: the field is
    ///     supplied from a purchase CONTINUATION, only the
    ///     `.durableContinuationRequired` policy creates one, macOS selects that
    ///     policy explicitly and iOS does not — so `continuation` is nil here and
    ///     the encoder omits `appInstanceId` entirely rather than sending it
    ///     empty.
    ///
    /// Over-declaring would be the "safe" direction and is not: it would publish
    /// a label saying this app sends a device identifier that it does not.
    func testTheAppDeclaresNoDeviceIDBecauseNoIOSSourceSendsOne() throws {
        let declared = try collected(try manifest(appManifest))
        XCTAssertFalse(declared.map(\.type).contains(absentDeviceIDType),
                       "the app declares \(absentDeviceIDType); no iOS call site sends one")

        // The iOS app's OWN source — the app target plus its `.swift` files, not
        // the modules it links, because linking is not calling. Comments are
        // stripped: a file explaining WHY it does not send an installation
        // identifier is the opposite of a violation, and must not read as one.
        let iosApp = withoutLineComments(try swiftSources(under: "apps/ios/Relayium"))
        for producer in ["DeviceAuthClient", "install_id", "installationID",
                         "appInstanceID", "appInstanceId", "ApplePurchaseContinuation",
                         "ApplePurchaseCapability", "durableContinuationRequired"] {
            XCTAssertFalse(iosApp.contains(producer),
                           "apps/ios/Relayium now reaches \(producer); this app may send a "
                            + "device identifier and the manifest must declare "
                            + "\(absentDeviceIDType) — see the revisit trigger in "
                            + "docs/ios-app-store-submission.md")
        }

        // The positive half of the same fact: iOS builds its subscription model
        // WITHOUT naming a dispatch policy, so it takes the default. macOS names
        // the durable one. If the iOS construction ever gains that argument, the
        // loop above catches it and this pair explains why it matters.
        let iosSubscriptions = try RepoRoot.text("apps/ios/Relayium/AppleSubscriptions.swift")
        XCTAssertTrue(iosSubscriptions.contains("return AppleSubscriptionModel("),
                      "iOS no longer builds the subscription model here")
        let model = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumAppKit/AppleSubscriptionModel.swift")
        XCTAssertTrue(
            model.contains("purchaseDispatchPolicy: ApplePurchaseDispatchPolicy = .legacyOneShot"),
            "the default dispatch policy is no longer the legacy one-shot; iOS names no policy, "
             + "so this default is what decides whether it sends an appInstanceID")
        XCTAssertTrue(try RepoRoot.text("apps/mac/Relayium/Distribution/AppStoreDistribution.swift")
            .contains("purchaseDispatchPolicy: .durableContinuationRequired"),
                      "macOS no longer selects the durable policy; the platform difference this "
                       + "declaration rests on is gone and both manifests need re-auditing")

        // And the encoder's own behaviour: no continuation means the field is
        // OMITTED, not sent empty. A `""` would still be a transmitted device
        // identifier as far as a privacy label is concerned.
        let billing = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Account/AppleBillingClient.swift")
        XCTAssertTrue(billing.contains("appInstanceId: continuation?.appInstanceID"),
                      "purchase-dispatch no longer derives appInstanceId from an optional "
                       + "continuation; iOS may now send one unconditionally")
        XCTAssertTrue(billing.contains("continuationProtocol: continuation == nil ? nil :"),
                      "the continuation fields are no longer omitted when there is no capability")

        // The install_id producer still exists in the module that owns it. If it
        // were deleted outright, the loop above would keep passing over source
        // that could no longer send anything, and this file would be asserting
        // an absence nobody could violate.
        XCTAssertTrue(try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Account/DeviceAuthClient.swift")
            .contains("[\"install_id\": installationID]"),
                      "the install_id producer is gone; this absence proof is now vacuous")
    }

    /// **Nothing here tracks, and the one Analytics purpose is not a
    /// contradiction.**
    ///
    /// Apple's "tracking" is linking this app's data to third-party data for
    /// advertising or brokered measurement. The aggregate is first-party,
    /// identifier-free and reaches nobody else — so Analytics is the right
    /// purpose and `NSPrivacyTracking` is still false. What would make that
    /// pair false is an SDK, and their absence is read from the source.
    func testTheAppDeclaresNoAnalyticsSDKOrTrackingItDoesNotHave() throws {
        let linked = try swiftSources(under: "apps/RelayiumKit/Sources")
            + swiftSources(under: "apps/ios/Relayium")
        for absent in ["import MetricKit", "Crashlytics", "FirebaseAnalytics", "SentrySDK",
                       "AppTrackingTransparency", "ASIdentifierManager"] {
            XCTAssertFalse(linked.contains(absent),
                           "\(absent) is now linked; NSPrivacyTracking and the tracking-domain "
                            + "list must be re-audited before this manifest ships")
        }

        // Exactly one entry may carry Analytics, and it must be the aggregate.
        // An Analytics purpose appearing on anything linked to the account is
        // the shape this assertion exists to catch.
        let declared = try collected(try manifest(appManifest))
        let analytics = declared.filter {
            ($0.entry["NSPrivacyCollectedDataTypePurposes"] as? [String])?
                .contains("NSPrivacyCollectedDataTypePurposeAnalytics") == true
        }
        XCTAssertEqual(analytics.map(\.type), [aggregateAnalyticsType],
                       "Analytics is declared for something other than the aggregate")
        XCTAssertEqual(analytics.first?.entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, false,
                       "an Analytics purpose is attached to a linked entry")
    }

    /// **The aggregate's shape, read out of the schema that keeps it.**
    ///
    /// The Product Interaction entry is declared UNLINKED, and that claim rests
    /// entirely on the table carrying no identifier. A column added there would
    /// make the manifest false without touching a line of Swift, so the DDL is
    /// parsed rather than grepped: exactly three columns, the three closed
    /// stages, and none of the identifier columns a funnel table drifts toward.
    func testTheActivationAggregateCarriesNoIdentifier() throws {
        let schema = try RepoRoot.text("server/account/sqlite.go")
        let head = "CREATE TABLE IF NOT EXISTS activation_funnel_monthly ("
        let start = try XCTUnwrap(schema.range(of: head),
                                  "the activation aggregate's table is no longer created here")

        // Read by matching parentheses rather than by searching for `);`: every
        // column carries a CHECK, and the first `)` after the head belongs to
        // `CAST(substr(period, 1, 4) AS INTEGER)`. A substring parse would
        // return a prefix that still contains the three columns this test wants
        // to see, and would therefore keep passing after a fourth was appended.
        var depth = 1
        var columnList = ""
        var index = start.upperBound
        while index < schema.endIndex {
            let character = schema[index]
            index = schema.index(after: index)
            if character == "(" { depth += 1 }
            if character == ")" {
                depth -= 1
                if depth == 0 { break }
            }
            columnList.append(character)
        }
        XCTAssertEqual(depth, 0, "the activation table's column list is unterminated")

        // Split on the commas that are NOT inside a CHECK, then drop the table
        // constraints — `PRIMARY KEY (...)` is not a column called `PRIMARY`.
        var entryDepth = 0
        var entries: [String] = [""]
        for character in columnList {
            if character == "," && entryDepth == 0 { entries.append(""); continue }
            if character == "(" { entryDepth += 1 }
            if character == ")" { entryDepth -= 1 }
            entries[entries.count - 1].append(character)
        }
        let columns = entries
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .filter { !["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"]
                .contains(($0.split(separator: " ").first.map(String.init) ?? "").uppercased()) }
        XCTAssertEqual(columns.map { $0.split(separator: " ").first.map(String.init) ?? "" },
                       ["period", "stage", "count"],
                       "the activation aggregate no longer has exactly three columns; an "
                        + "identifier here would make the unlinked Product Interaction "
                        + "declaration false")

        // The stage vocabulary is closed, and it is the same three the manifest
        // comment names. Read as the COMPLETE list of quoted literals in the
        // `stage` column's own entry, so a fourth stage cannot be appended
        // alongside the three — and scoped to that entry rather than the whole
        // column list, because `period`'s CHECK carries a `'*[^0-9]*'` GLOB
        // pattern that is a quoted literal and is not a stage.
        let stageColumn = try XCTUnwrap(columns.first { $0.hasPrefix("stage ") },
                                        "the aggregate has no stage column")
        var literals: [String] = []
        var rest = Substring(stageColumn)
        while let open = rest.range(of: "'"),
              let close = rest.range(of: "'", range: open.upperBound..<rest.endIndex) {
            literals.append(String(rest[open.upperBound..<close.lowerBound]))
            rest = rest[close.upperBound...]
        }
        XCTAssertEqual(literals, activationStages,
                       "the aggregate's stage vocabulary is no longer exactly the closed three")
        XCTAssertTrue(columnList.contains(
            "stage IN ('code_minted','room_opened','room_paired')"),
                      "the three stages are no longer enforced by a CHECK")

        // And the identifiers a funnel table drifts toward, checked against the
        // COLUMN NAMES rather than the raw DDL text. The raw text cannot be
        // searched for these: `code` and `room` are substrings of the stage
        // literals `code_minted` and `room_opened`, so a text scan reports the
        // correct table as carrying a `code` column and a `room` column. That
        // false positive is worth naming — it is the version of this check that
        // was written first, and it fails on a table that is exactly right.
        let names = columns.map { $0.split(separator: " ").first.map(String.init) ?? "" }
        for identifier in ["user_id", "account_id", "install_id", "device_id", "ip",
                           "code", "room", "session", "token", "locale", "platform"] {
            XCTAssertFalse(names.contains(identifier),
                           "the activation aggregate gained a \(identifier) column; it is "
                            + "declared UNLINKED and that is now false")
        }
    }

    /// **The extension collects nothing, and the code is why.**
    ///
    /// An empty list is the easiest thing in this file to leave stale: it needs
    /// no maintenance and it passes forever. So the emptiness is asserted
    /// alongside what actually makes it true.
    ///
    /// **What does NOT make it true is the sandbox.** This test used to say the
    /// proof was "the absence of a network-capable entitlement", and that
    /// reasoning is macOS reasoning applied to an iOS target. On macOS an App
    /// Sandbox process needs `com.apple.security.network.client` to open an
    /// outbound socket, so its absence is a real capability denial. **iOS has no
    /// such entitlement.** Every iOS app and app extension may open a socket,
    /// and nothing in an `.entitlements` file changes that — so an entitlement
    /// list that happens not to name one proves precisely nothing about network
    /// reach. The assertion is kept below because it is still worth having, but
    /// for the other reason: it is a SCOPE-CHANGE GUARD. The extension's whole
    /// safety argument is that it stages plaintext into the App Group and stops,
    /// and a keychain group, an associated domain or a background mode appearing
    /// here means somebody widened that scope and this manifest needs re-auditing.
    ///
    /// What the emptiness actually rests on is code and dependencies, and both
    /// are asserted:
    ///
    ///  1. **Dependencies.** `RelayiumShareKit` is the one package module the
    ///     appex links, and `Package.swift` declares it with NO dependencies —
    ///     so `RelayiumKit`'s account/cloud clients and WebRTC are not reachable
    ///     from it even transitively. A dependency list appearing there is the
    ///     one edit that would make every source scan below insufficient without
    ///     changing a single line of extension source.
    ///  2. **Source.** No transport symbol in either half of what the appex
    ///     compiles: its own target directory and that module.
    ///
    /// `IOSSurfaceGuardTests.testTheExtensionContainsNoNetworkAccountOrKeyCode`
    /// owns the wider version of the source half — it scans the three app files
    /// the appex's Sources phase also compiles, and bans credentials, key
    /// material and logging as well. This is the manifest-facing subset, stated
    /// here so that this file's claim does not depend on another suite running.
    func testTheExtensionCollectsNothingAndCannotReachTheNetwork() throws {
        XCTAssertEqual(try collected(try manifest(shareManifest)).map(\.type), [],
                       "the Share extension's manifest claims to collect something")

        // The scope-change guard. NOT a network proof — see the note above.
        let entitlements = try manifest("apps/ios/RelayiumShare/RelayiumShare.entitlements")
        XCTAssertEqual(entitlements.keys.sorted(), ["com.apple.security.application-groups"],
                       "the Share extension's entitlements changed; re-audit its manifest "
                        + "before assuming it still collects nothing")

        // The dependency boundary, read from the manifest with comment lines
        // removed — the declaration is preceded by a long comment that names
        // `RelayiumAppKit` and WebRTC while explaining why they are absent.
        //
        // The segment is cut at the NEXT `.target(` rather than at a fixed
        // prefix or the first `)`: `resources: [.process("Resources")])` closes
        // three parentheses of its own, so a first-`)` cut would end before the
        // place a `dependencies:` argument could be written.
        let package = try RepoRoot.text("apps/RelayiumKit/Package.swift")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        let shareKitTarget = try XCTUnwrap(
            package.components(separatedBy: #".target(name: "RelayiumShareKit","#)
                .dropFirst().first,
            "RelayiumShareKit has no target declaration in Package.swift")
        let shareKitDeclaration = shareKitTarget.components(separatedBy: ".target(")[0]
        XCTAssertTrue(shareKitDeclaration.contains(#"resources: [.process("Resources")])"#),
                      "RelayiumShareKit's target declaration changed shape; re-read it before "
                       + "trusting the dependency assertion below")
        XCTAssertFalse(shareKitDeclaration.contains("dependencies"),
                       "RelayiumShareKit gained a package dependency. The extension's manifest "
                        + "declares that it collects nothing, and that rests on this module "
                        + "reaching no account client, no uploader and no transport: "
                        + "\(shareKitDeclaration.trimmingCharacters(in: .whitespacesAndNewlines))")

        // And no transport symbol in either half of what the appex compiles.
        // Comments stripped: both halves DISCUSS `URLSession` and `AccountSession`
        // in prose — explaining what the extension deliberately does not do — and
        // a raw scan reads that explanation as a call site.
        //
        // `Keychain` and `SecItem` are deliberately not in this list even though
        // the surface guard bans them: `L10nKey` carries `errorKeychainSignIn`
        // and three stored-key cases, which are message KEYS for words the app
        // shows, not a keychain query. Banning the substring here would fail on
        // a correct module. The credential half is the surface guard's, where the
        // scan is scoped to the extension's own compiled files.
        let compiled = [
            ("apps/ios/RelayiumShare", "the extension target"),
            ("apps/RelayiumKit/Sources/RelayiumShareKit", "RelayiumShareKit"),
        ]
        for (path, what) in compiled {
            let source = withoutLineComments(try swiftSources(under: path))
            for transport in ["URLSession", "URLRequest", "NWConnection", "WebSocket",
                              "bearerToken", "AccountSession", "AccountClient", "CloudClient"] {
                XCTAssertFalse(source.contains(transport),
                               "\(what) gained \(transport); the extension may now collect "
                                + "something and its manifest says it collects nothing")
            }
        }
    }
}
