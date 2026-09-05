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
    /// Any plist in the repo — the manifests, and the entitlements read beside
    /// them. Parsed rather than searched as text: these files explain their own
    /// absences at length, so a substring check answers the prose.
    private func parsedPlist(_ path: String) throws -> [String: Any] {
        let data = try RepoRoot.data(path)
        return try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
    }
    /// The declared required-reason entries, in FILE ORDER, as
    /// (category, reasons).
    private func apiEntries(_ plist: [String: Any]) -> [(category: String, reasons: [String])] {
        let entries = plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]] ?? []
        return entries.compactMap { entry in
            (entry["NSPrivacyAccessedAPIType"] as? String).map {
                (category: $0, reasons: entry["NSPrivacyAccessedAPITypeReasons"] as? [String] ?? [])
            }
        }
    }
    /// The same entries keyed by category.
    ///
    /// `uniquingKeysWith` rather than `uniqueKeysWithValues`, which TRAPS on a
    /// manifest declaring one category twice. That is not a theoretical
    /// difference: a trap takes down the whole `xctest` process with signal 5,
    /// so a duplicate in ANY manifest this file reads — including the iOS one
    /// the platform-distinction test below cross-checks — would abort every
    /// other test in the target instead of failing one and reporting the rest.
    /// Duplicates are asserted explicitly, by `apiEntries`, where they matter.
    private func apiTypes(_ plist: [String: Any]) -> [String: [String]] {
        Dictionary(apiEntries(plist).map { ($0.category, $0.reasons) },
                   uniquingKeysWith: { first, _ in first })
    }

    /// The two keys Apple defines for a required-reason entry.
    private let apiEntryKeys = ["NSPrivacyAccessedAPIType",
                                "NSPrivacyAccessedAPITypeReasons"]

    /// **Every raw `NSPrivacyAccessedAPITypes` element, accounted for** — run at
    /// every call site before `apiTypes` is trusted, because both readers above
    /// are lossy and every graph assertion in this file is a comparison against
    /// what they returned.
    ///
    /// This file previously checked the app's list by comparing the parsed entry
    /// count against the DICTIONARY count, and the extension's by asserting the
    /// dictionary holds one key. Neither is a check:
    ///
    ///  - the two counts are produced by discarding the same elements, so they
    ///    agree *precisely when* something has gone missing;
    ///  - folding a category declared twice yields one key, so a duplicated
    ///    `FileTimestamp` entry carrying a second reason list passes a
    ///    `count == 1` assertion with the second list never read.
    ///
    /// The raw element count is the only number a malformed entry cannot move,
    /// so each way an element can vanish fails here, closed:
    ///
    ///  1. the key is absent or is not an array — the list reads as nothing and
    ///     every graph assertion passes over an empty set;
    ///  2. an element is not a dictionary — Swift's array cast is all-or-nothing,
    ///     so the typed read of the WHOLE list becomes `nil` and every
    ///     well-formed entry disappears alongside the bad one;
    ///  3. an element names no `NSPrivacyAccessedAPIType`, or names one that is
    ///     not a string — it drops out of `apiEntries`, and what remains can
    ///     equal the audited graph exactly while the shipped file carries an
    ///     entry Apple reads and this file never saw;
    ///  4. an element carries a key outside Apple's two;
    ///  5. its reasons are missing, not an array of strings, or empty — `?? []`
    ///     turns the first two into "declared with no reason", which is a
    ///     rejected upload rather than something to describe;
    ///  6. two elements declare the same category — `apiTypes` keeps the first,
    ///     so the second's reason list is invisible to everything that follows.
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
                       "\(path): an NSPrivacyAccessedAPITypes element names no string "
                        + "NSPrivacyAccessedAPIType and would be discarded unread",
                       file: file, line: line)

        for (index, entry) in dictionaries.enumerated() {
            XCTAssertEqual(entry.keys.sorted(), apiEntryKeys,
                           "\(path) entry \(index) is not the shape Apple defines: "
                            + "\(entry.keys.sorted())", file: file, line: line)
            // One assertion for three failures the reader spells the same way:
            // no reason key, a reason list that is not strings, and an empty one.
            XCTAssertEqual((entry["NSPrivacyAccessedAPITypeReasons"] as? [String])?.isEmpty, false,
                           "\(path) entry \(index) declares a category with no string reason code",
                           file: file, line: line)
        }

        XCTAssertEqual(entries.count, apiTypes(plist).count,
                       "\(path) declares a category more than once: \(entries.map(\.category))",
                       file: file, line: line)
    }
    private func swiftSources(under relative: String) throws -> String {
        // Throws on a missing root AND on a root with no Swift in it: both make
        // an "this API is never called" assertion pass over nothing.
        return try RepoRoot.swiftFiles(under: relative)
            .map { try RepoRoot.text(of: $0) }
            .joined(separator: "\n")
    }
    private func text(_ relative: String) throws -> String { try RepoRoot.text(relative) }
    /// The declared types, in file order, with the three flags Apple requires of
    /// each entry.
    private func collected(_ plist: [String: Any]) throws -> [(type: String, entry: [String: Any])] {
        let entries = try XCTUnwrap(plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        return try entries.map { (try XCTUnwrap($0["NSPrivacyCollectedDataType"] as? String), $0) }
    }

    private let appManifest = "apps/mac/Relayium/PrivacyInfo.xcprivacy"
    private let shareManifest = "apps/mac/RelayiumShare/PrivacyInfo.xcprivacy"

    /// The four keys Apple defines for a collected-data entry. Asserted as an
    /// exact sorted set on every entry: a fifth key is as wrong as a missing
    /// one, and neither has a runtime that would notice.
    private let collectedEntryKeys = ["NSPrivacyCollectedDataType",
                                      "NSPrivacyCollectedDataTypeLinked",
                                      "NSPrivacyCollectedDataTypePurposes",
                                      "NSPrivacyCollectedDataTypeTracking"]

    /// **The app's set is not homogeneous, and the split is the point.**
    ///
    /// Six entries describe data an account sends and the server keeps against
    /// that account: linked, non-tracking, App Functionality. The seventh
    /// describes something categorically different — a first-party monthly
    /// aggregate with no identifier in it at all — so it is unlinked and
    /// Analytics. Reading them as one list is what made this file wrong.
    private let linkedFunctionalityTypes = ["NSPrivacyCollectedDataTypeName",
                                            "NSPrivacyCollectedDataTypeEmailAddress",
                                            "NSPrivacyCollectedDataTypePurchaseHistory",
                                            "NSPrivacyCollectedDataTypeUserID",
                                            "NSPrivacyCollectedDataTypeDeviceID",
                                            "NSPrivacyCollectedDataTypeOtherUsageData"]
    private let aggregateAnalyticsType = "NSPrivacyCollectedDataTypeProductInteraction"

    /// The three server-owned milestones the aggregate may count, named once.
    /// Both the Go constants and the SQLite CHECK are compared against this and
    /// against each other, so a fourth stage cannot be added on one side only.
    private let activationStages = ["code_minted", "room_opened", "room_paired"]

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

    /// **The proof that the two guards this file used to have were not guards.**
    ///
    /// Both have been replaced by `assertAPIEntriesAreCompleteAndDistinct`, and
    /// both are written out here against synthetic manifests rather than
    /// described, because each reads as a check, passes on the real files, and
    /// is satisfied by precisely the manifest it was supposed to reject. Neither
    /// macOS manifest is touched by any of this.
    func testTheEntryCheckSeesWhatTheFoldedCountsCannot() {
        func plist(_ entries: [Any]) -> [String: Any] { ["NSPrivacyAccessedAPITypes": entries] }
        let fileTimestamp: [String: Any] = [
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
            "NSPrivacyAccessedAPITypeReasons": ["DDA9.1"]]

        // The shape both macOS manifests have parses whole, and passes.
        assertAPIEntriesAreCompleteAndDistinct(plist([fileTimestamp]), "<synthetic>")
        XCTAssertEqual(apiEntries(plist([fileTimestamp])).map(\.category),
                       ["NSPrivacyAccessedAPICategoryFileTimestamp"],
                       "the reader no longer recognises a well-formed entry")

        // 1. The app's old guard: parsed entries against the FOLDED dictionary.
        //    An element naming no category is discarded by both, so the two
        //    numbers agree — while the raw element count, which nothing can
        //    move, does not.
        let orphanReasons: [String: Any] = ["NSPrivacyAccessedAPITypeReasons": ["CA92.1"]]
        let missingCategory = plist([fileTimestamp, orphanReasons])
        XCTAssertEqual(apiEntries(missingCategory).map(\.category),
                       ["NSPrivacyAccessedAPICategoryFileTimestamp"],
                       "the malformed element is no longer discarded; this proof is stale")
        XCTAssertEqual(apiEntries(missingCategory).count, apiTypes(missingCategory).count,
                       "the old entries-vs-dictionary comparison rejects this, so the raw-count "
                        + "check is no longer the only thing standing between a malformed element "
                        + "and a passing graph assertion")
        XCTAssertNotEqual(apiEntries(missingCategory).count,
                          (missingCategory["NSPrivacyAccessedAPITypes"] as? [Any])?.count,
                          "the raw element count no longer sees the discarded element")

        // The loss is bigger than one element when an element is not a
        // dictionary: Swift's array cast is all-or-nothing, so the typed read of
        // the whole list becomes `nil`, every good entry goes with it, and
        // `?? []` presents that as a manifest declaring nothing.
        let notADictionary = plist([fileTimestamp, "NSPrivacyAccessedAPICategoryUserDefaults"])
        XCTAssertNil(notADictionary["NSPrivacyAccessedAPITypes"] as? [[String: Any]],
                     "one non-dictionary element no longer voids the typed read of the list")
        XCTAssertTrue(apiEntries(notADictionary).isEmpty,
                      "the reader no longer loses the whole list to a single bad element")
        XCTAssertEqual((notADictionary["NSPrivacyAccessedAPITypes"] as? [Any])?.count, 2,
                       "the raw read no longer sees every element")

        // 2. The extension's old guard: `declared.count == 1`. A category
        //    declared TWICE folds to one key, so a second entry — carrying a
        //    reason list that may say anything — passes both that count and an
        //    exact-graph comparison, unread. The raw count cannot see this one
        //    either, since both elements parse; distinctness is why the helper
        //    asserts it separately.
        let secondFileTimestamp: [String: Any] = [
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
            "NSPrivacyAccessedAPITypeReasons": ["C617.1"]]
        let duplicated = plist([fileTimestamp, secondFileTimestamp])
        XCTAssertEqual(apiTypes(duplicated).count, 1,
                       "a duplicated category no longer folds to one key; the extension's old "
                        + "count check would have caught it")
        XCTAssertEqual(apiTypes(duplicated),
                       ["NSPrivacyAccessedAPICategoryFileTimestamp": ["DDA9.1"]],
                       "the folded graph no longer equals the audited one, so the exact-graph "
                        + "assertion would have caught the duplicate without the helper")
        XCTAssertEqual(apiEntries(duplicated).count,
                       (duplicated["NSPrivacyAccessedAPITypes"] as? [Any])?.count,
                       "a duplicate no longer parses whole; the raw-count check would catch it "
                        + "and the distinctness assertion would be untested")
        XCTAssertNotEqual(apiEntries(duplicated).count, apiTypes(duplicated).count,
                          "a category declared twice would pass the distinctness check")

        // And a category declared with no reason code at all, which every count
        // above reads as perfectly well-formed — only the per-entry check sees
        // it, and Apple rejects the upload.
        let reasonless: [String: Any] = [
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryDiskSpace",
            "NSPrivacyAccessedAPITypeReasons": [String]()]
        let noReasons = plist([reasonless])
        XCTAssertEqual(apiEntries(noReasons).count, apiTypes(noReasons).count,
                       "the reasonless entry no longer parses whole; this proof is stale")
        XCTAssertEqual(apiEntries(noReasons).count,
                       (noReasons["NSPrivacyAccessedAPITypes"] as? [Any])?.count,
                       "the reasonless entry is no longer counted; only the per-entry reason "
                        + "check stands between it and a passing graph assertion")
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
        let plist = try parsedPlist(appManifest)
        let declared = apiTypes(plist)

        // Every raw element parses, is Apple's shape, carries a reason code and
        // names a category no other element names. Asserted against the RAW
        // list before the dictionary below is trusted: a duplicate's second
        // reason list and a malformed element alike are invisible to every graph
        // comparison that follows, and a parsed-vs-folded count comparison —
        // which is what stood here — cannot see either.
        assertAPIEntriesAreCompleteAndDistinct(plist, appManifest)

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

        // Active keyboard is absent because nothing calls it, asserted from the
        // source so a future call site cannot make the manifest wrong in
        // silence. Disk space is a DIFFERENT kind of absence and is read by the
        // test below rather than here — see it before adding a scan for it.
        XCTAssertFalse(linked.contains("activeInputModes"),
                       "active keyboard is now used and must be declared")
        XCTAssertNil(declared["NSPrivacyAccessedAPICategoryActiveKeyboards"])
    }

    /// **Disk space is absent from the macOS manifest because macOS has no
    /// required-reason rule — NOT because nothing reads free space.**
    ///
    /// This file used to assert the absence from the source, scanning for
    /// `volumeAvailableCapacity`. That scan passed, and the claim it appeared to
    /// support was false: `InboxSpace.freeBytes` in `RelayiumAppKit` — which both
    /// macOS targets link — calls `statfs` on the receive folder before a Device
    /// Inbox delivery is written. The assertion held only by asking about a
    /// symbol this product never used, which is precisely the shape a
    /// source-derived manifest test is supposed to make impossible.
    ///
    /// The real reason is platform, and it is worth stating where somebody
    /// comparing the two manifests will look. Apple's required-reason API rule
    /// names iOS, iPadOS, tvOS, visionOS and watchOS. macOS is not in that set,
    /// so `apps/mac/Relayium/PrivacyInfo.xcprivacy` declares no Disk Space entry
    /// while `apps/ios/Relayium/PrivacyInfo.xcprivacy` declares E174.1 for the
    /// same call in the same module. That difference is correct, and a reader who
    /// finds it by diffing the two files should find this test rather than
    /// conclude one of them is stale.
    func testDiskSpaceIsAbsentFromMacOSByPlatformRuleRatherThanByAbsentCallSite() throws {
        // The call really is there, in a module both macOS targets link. If this
        // ever stops being true the absence becomes source-derived after all,
        // and this test — not a silent pass — is what says so.
        let linked = try swiftSources(under: "apps/RelayiumKit/Sources/RelayiumAppKit")
        XCTAssertTrue(["statfs", "fstatfs", "statvfs", "fstatvfs",
                       "volumeAvailableCapacity", "systemFreeSize"]
                        .contains { linked.contains($0) },
                      "nothing in RelayiumAppKit reads free space any more; this test's premise "
                       + "is gone and the iOS Disk Space declaration needs re-reading too")

        // And it is deliberately not declared here. Both manifests are checked
        // whole first, because this is an ABSENCE read through a lossy reader:
        // a malformed Disk Space entry drops out of `apiTypes` and satisfies the
        // two assertions below while Apple still reads it out of the file.
        let app = try parsedPlist(appManifest)
        assertAPIEntriesAreCompleteAndDistinct(app, appManifest)
        XCTAssertNil(apiTypes(app)["NSPrivacyAccessedAPICategoryDiskSpace"],
                     "macOS declared a required-reason API; Apple's rule does not cover macOS, "
                      + "and an unnecessary declaration is still a public statement")
        let share = try parsedPlist(shareManifest)
        assertAPIEntriesAreCompleteAndDistinct(share, shareManifest)
        XCTAssertNil(apiTypes(share)["NSPrivacyAccessedAPICategoryDiskSpace"])

        // The iOS side of the same call, asserted from here so the two manifests
        // cannot drift apart unnoticed in the direction that matters: iOS IS
        // covered by the rule, so a missing declaration there is an upload
        // rejection rather than a stylistic difference.
        //
        // Read from the raw elements rather than through `apiTypes`, which folds
        // duplicates by keeping the first: a second Disk Space entry carrying a
        // different reason list would answer this cross-platform question with
        // the entry that happens to be right. `IOSPrivacyManifestTests` is what
        // audits that file whole; this asserts only its one shared declaration,
        // and asserts it about the only entry that may make it.
        let iosEntries = try XCTUnwrap(
            parsedPlist("apps/ios/Relayium/PrivacyInfo.xcprivacy")["NSPrivacyAccessedAPITypes"]
                as? [[String: Any]],
            "the iOS manifest declares no readable required-reason API list")
        let iosDiskSpace = iosEntries.filter {
            $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryDiskSpace"
        }
        XCTAssertEqual(iosDiskSpace.count, 1,
                       "the iOS app declares Disk Space \(iosDiskSpace.count) times")
        XCTAssertEqual(iosDiskSpace.first?["NSPrivacyAccessedAPITypeReasons"] as? [String],
                       ["E174.1"],
                       "the iOS app no longer declares E174.1 for the free-space call macOS shares")
    }

    /// **The extension is not the app.** It links only `RelayiumShareKit`, so
    /// its API list is ONE entry and it collects nothing — copying the app's
    /// collected-data types and three APIs here would describe a process that
    /// never reaches the network. The absences are read from the appex's own
    /// sources as well as the module, since either can acquire the call.
    func testTheExtensionDeclaresOnlyWhatItsOwnModuleUses() throws {
        let shareKit = try swiftSources(under: "apps/RelayiumKit/Sources/RelayiumShareKit")
        let appex = shareKit + (try swiftSources(under: "apps/mac/RelayiumShare"))
        let plist = try parsedPlist(shareManifest)
        let declared = apiTypes(plist)

        // Before the one-entry claim below means anything: `count == 1` is what
        // a manifest declaring `FileTimestamp` TWICE also folds to, and the
        // second entry's reason list would never be read.
        assertAPIEntriesAreCompleteAndDistinct(plist, shareManifest)

        XCTAssertTrue(shareKit.contains(".modificationDate"))
        XCTAssertEqual(declared["NSPrivacyAccessedAPICategoryFileTimestamp"], ["DDA9.1"])
        XCTAssertEqual(declared, ["NSPrivacyAccessedAPICategoryFileTimestamp": ["DDA9.1"]],
                       "the extension's required-reason graph is not its own smaller one")
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
    ///
    /// **Seven entries, in two shapes.** The order is asserted exactly because
    /// the CI script indexes the built manifest positionally: it checks the
    /// first six against one shape and the seventh against another, so a
    /// reordering here silently changes which entry that script audits as which.
    func testTheAppDeclaresExactlyTheDataItSendsAndRetains() throws {
        let declared = try collected(try parsedPlist(appManifest))
        XCTAssertEqual(declared.map(\.type), linkedFunctionalityTypes + [aggregateAnalyticsType],
                       "the app's collected-data set is not the audited one")

        // The first six are the shape Apple defines, and say the same three
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

        // The seventh is the same four keys and three different answers. Each is
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

    // MARK: - the seventh entry, which no call site sends

    /// The `activation_funnel_monthly` definition as it is actually written,
    /// split into its column list and the table options that follow it.
    ///
    /// Read by matching parentheses rather than by searching for `);`, because
    /// every column carries a `CHECK` and the first `)` after the head belongs
    /// to `CAST(substr(period, 1, 4) AS INTEGER)`. A substring parse would
    /// return a prefix that still contains the three columns this test wants to
    /// see — and would therefore keep passing after a fourth was appended.
    ///
    /// Takes the schema as text rather than reading it, so the widened variants
    /// below can be pushed through the same parser.
    private func activationTable(in schema: String) throws -> (columnList: String,
                                                               options: String) {
        let head = "CREATE TABLE IF NOT EXISTS activation_funnel_monthly ("
        let start = try XCTUnwrap(schema.range(of: head),
                                  "the activation aggregate's table is no longer created here")
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
        let end = try XCTUnwrap(schema.range(of: ";", range: index..<schema.endIndex),
                                "the activation table's definition is unterminated")
        return (columnList, String(schema[index..<end.lowerBound]))
    }

    /// A SQLite column list split on the commas that are NOT inside a `CHECK`.
    private func topLevelEntries(_ columnList: String) -> [String] {
        var depth = 0
        var entries: [String] = [""]
        for character in columnList {
            if character == "," && depth == 0 {
                entries.append("")
                continue
            }
            if character == "(" { depth += 1 }
            if character == ")" { depth -= 1 }
            entries[entries.count - 1].append(character)
        }
        return entries
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// The entries that declare a COLUMN, in order — table constraints dropped,
    /// since `PRIMARY KEY (...)` is not a column called `PRIMARY`.
    private func columnEntries(_ entries: [String]) -> [String] {
        let constraints = ["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"]
        return entries.filter { entry in
            !constraints.contains(firstToken(entry).uppercased())
        }
    }

    /// Their names, in the same order.
    private func columnNames(_ entries: [String]) -> [String] {
        columnEntries(entries).map(firstToken)
    }

    private func firstToken(_ text: String) -> String {
        String(text.split(whereSeparator: \.isWhitespace).first ?? "")
    }

    /// The values a `stage IN (...)` CHECK admits, or `nil` when the column
    /// enumerates nothing — which is itself the failure, not a pass.
    private func enumeratedStages(in stageColumn: String) -> [String]? {
        guard let listStart = stageColumn.range(of: "stage IN ("),
              let listEnd = stageColumn.range(of: ")",
                                              range: listStart.upperBound..<stageColumn.endIndex)
        else { return nil }
        return stageColumn[listStart.upperBound..<listEnd.lowerBound]
            .components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " '\n\t")) }
    }

    /// The field names of a Go struct, in order, or `nil` if it is not declared.
    private func goStructFields(_ typeName: String, in source: String) -> [String]? {
        guard let body = source.components(separatedBy: "type \(typeName) struct {")
            .dropFirst().first else { return nil }
        return String(body.prefix { $0 != "}" })
            .components(separatedBy: "\n")
            .map(firstToken)
            .filter { !$0.isEmpty }
    }

    /// Every argument the activation recorder is asked to record.
    private func recordedStages(in source: String) -> Set<String> {
        Set(source.components(separatedBy: "recorder.Record(").dropFirst()
            .map { String($0.prefix { $0 != ")" }) })
    }

    /// **The seventh entry, read against the aggregate it describes.**
    ///
    /// It is the one declaration with no macOS call site: the server counts
    /// three pairing milestones *it* observes, precisely so the count cannot
    /// carry anything a client chose. The claim being made is therefore about a
    /// SCHEMA — one row per UTC month and server-owned stage, holding a count —
    /// and a schema is the kind of thing that widens one column at a time.
    ///
    /// So the three ways this entry could stop being true are each asserted
    /// from the source, and each fails closed:
    ///
    ///  1. **An identifier.** The column list is parsed and compared exactly, so
    ///     a `user_id`, `install_id`, `ip` or `code` column fails here before it
    ///     reaches a manifest that says there is none.
    ///  2. **An arbitrary event name.** The stage vocabulary is closed in three
    ///     places — the Go constants, the `Valid()` switch and the SQLite
    ///     `CHECK` — and all three are compared against each other, so widening
    ///     one is not enough to make a client-supplied name persist.
    ///  3. **An exact timestamp.** The only time value written is a `200601`
    ///     UTC month, and the period column is constrained to six digits.
    ///
    /// That each of those actually fires is proved separately, below.
    func testTheAggregateEntryIsAMonthlyCountOfServerOwnedStagesAndNothingElse() throws {
        // It is declared. The rest of this test is what makes that honest.
        XCTAssertEqual(try collected(try parsedPlist(appManifest)).map(\.type).last,
                       aggregateAnalyticsType)

        // 1. Three columns, keyed by month and stage. Nothing identifies anyone,
        //    and there is no event row for an identifier to hang off.
        let table = try activationTable(in: try text("server/account/sqlite.go"))
        let entries = topLevelEntries(table.columnList)
        let columns = columnNames(entries)
        XCTAssertEqual(columns, ["period", "stage", "count"],
                       "the activation aggregate's columns are no longer month/stage/count: "
                        + "\(entries)")
        XCTAssertTrue(entries.contains { $0.hasPrefix("PRIMARY KEY (period, stage)") },
                      "the aggregate is no longer one row per month and stage: \(entries)")
        XCTAssertTrue(table.options.contains("STRICT"),
                      "the aggregate's table is not STRICT; its column types stop being enforced")
        XCTAssertTrue(table.options.contains("WITHOUT ROWID"),
                      "the aggregate's table gained a rowid, which orders rows by insertion")

        // Zipped against the column entries themselves rather than a prefix of
        // `entries`: a table constraint written BEFORE a column would otherwise
        // shift every name onto the wrong definition. `uniquingKeysWith` because
        // a duplicated name is a failure to report, not a reason to trap.
        let byName = Dictionary(zip(columns, columnEntries(entries)),
                                uniquingKeysWith: { first, _ in first })
        XCTAssertEqual(byName["count"], "count INTEGER NOT NULL CHECK (count >= 0)",
                       "the count column is not a plain nonnegative integer")

        // 2. The stage vocabulary is closed, and closed to the SAME three names
        //    on both sides of the boundary. A client cannot name a fourth.
        let stageColumn = try XCTUnwrap(byName["stage"], "the aggregate has no stage column")
        XCTAssertEqual(enumeratedStages(in: stageColumn), activationStages,
                       "the database accepts a stage outside the three server-owned milestones")

        let store = try text("server/account/store.go")
        let constants = store.components(separatedBy: "ActivationStage = \"").dropFirst()
            .map { String($0.prefix { $0 != "\"" }) }
        XCTAssertEqual(constants, activationStages,
                       "the Go stage vocabulary is no longer the three the schema accepts")
        XCTAssertTrue(store.contains(
            "case ActivationCodeMinted, ActivationRoomOpened, ActivationRoomPaired:"),
            "ActivationStage.Valid no longer closes over exactly the three milestones")

        // 3. A UTC month, and only a UTC month. The write boundary carries a
        //    period and a stage — adding an identifier or an instant to it would
        //    have to be typed here, where this fails.
        let main = try text("server/main.go")
        XCTAssertTrue(main.contains(
            "IncrementActivationFunnel(context.Context, string, account.ActivationStage) error"),
            "the aggregate's write boundary accepts something beyond a period and a stage")
        XCTAssertEqual(goStructFields("activationWrite", in: main), ["period", "stage"],
                       "the queued aggregate write carries a third value")
        XCTAssertTrue(main.contains("period: r.now().UTC().Format(\"200601\")"),
                      "the recorder no longer stamps a UTC month; an exact time would be kept")
        let periodColumn = try XCTUnwrap(byName["period"], "the aggregate has no period column")
        XCTAssertTrue(periodColumn.contains("length(period) = 6"),
                      "the period column no longer holds exactly six digits: \(periodColumn)")

        // The recorder emits those three milestones and nothing else, from the
        // server's own view of a pairing: the mint handler and the signaling
        // hub's admission observer.
        XCTAssertEqual(recordedStages(in: main), ["account.ActivationCodeMinted",
                                                  "account.ActivationRoomOpened",
                                                  "account.ActivationRoomPaired"],
                       "the recorder emits a stage that is not one of the three")
        XCTAssertTrue(main.contains("activationHook.afterMint"),
                      "the mint milestone is no longer counted at POST /api/pair")
        XCTAssertTrue(main.contains(
            "func (h activationHooks) admitted(activity signal.PairActivity)"),
            "the two admission milestones no longer come from the hub's own observer")
        XCTAssertTrue(try text("apps/RelayiumKit/Sources/RelayiumKit/Account/PairClient.swift")
            .contains("api/pair"), "the Mac no longer mints through the counted endpoint")

        // And the Mac is not a participant. It names no stage, no aggregate and
        // no event: if it ever did, the count would be client-supplied and the
        // "identifier-free, server-observed" half of the declaration would be a
        // claim about the app rather than about the server.
        let appSource = try swiftSources(under: "apps/RelayiumKit/Sources")
            + swiftSources(under: "apps/mac/Relayium")
        for token in activationStages + ["activation_funnel", "ActivationStage"] {
            XCTAssertFalse(appSource.contains(token),
                           "the macOS app names \(token); the aggregate is no longer "
                            + "server-authoritative")
        }
    }

    /// **The proof that the guard above can fail.**
    ///
    /// Everything it asserts is a comparison against text, and text guards are
    /// the ones that go quiet: a parser that stopped finding the column list
    /// would return a prefix, an empty set or `nil`, and several of those
    /// compare equal to nothing in particular. So each widening is written out
    /// here and pushed through the same functions, and the accepted answer is
    /// required to be reachable as well — otherwise this file would be
    /// rejecting the widened aggregate and the real one alike.
    func testTheAggregateGuardRejectsEveryWideningItClaimsToCatch() throws {
        let accepted = ["period", "stage", "count"]
        func columns(_ ddl: String) throws -> [String] {
            columnNames(topLevelEntries(try activationTable(in: ddl).columnList))
        }
        let realStages = "'code_minted','room_opened','room_paired'"
        func table(_ extraColumns: String, stages: String? = nil) -> String {
            """
            CREATE TABLE IF NOT EXISTS activation_funnel_monthly (
              period TEXT NOT NULL CHECK (
                length(period) = 6 AND period NOT GLOB '*[^0-9]*' AND
                CAST(substr(period, 1, 4) AS INTEGER) BETWEEN 1 AND 9999
              ),
              stage TEXT NOT NULL CHECK (stage IN (\(stages ?? realStages))),
              count INTEGER NOT NULL CHECK (count >= 0),\(extraColumns)
              PRIMARY KEY (period, stage)
            ) STRICT, WITHOUT ROWID;
            """
        }
        // The shape of the real thing parses to the accepted answer, nested
        // CHECK parentheses and the table constraint included.
        XCTAssertEqual(try columns(table("")), accepted,
                       "the parser no longer recognises the aggregate it is meant to accept")

        // 1. An identifier, and 2. an exact timestamp — both are one more column.
        for identifier in ["user_id TEXT", "install_id TEXT", "ip TEXT", "code TEXT",
                           "recorded_at INTEGER", "created_at INTEGER"] {
            XCTAssertNotEqual(try columns(table("\n  \(identifier) NOT NULL,")), accepted,
                              "a \(identifier) column would pass the aggregate guard")
        }

        // 3. An arbitrary event name — the enumeration widened, or removed.
        let widened = try activationTable(in: table("", stages: realStages + ",'button_tapped'"))
        let widenedStage = try XCTUnwrap(
            topLevelEntries(widened.columnList).first { $0.hasPrefix("stage ") })
        XCTAssertNotEqual(enumeratedStages(in: widenedStage), activationStages,
                          "a fourth stage would pass the aggregate guard")
        XCTAssertNil(enumeratedStages(in: "stage TEXT NOT NULL"),
                     "a stage column that enumerates nothing reads as the closed vocabulary")
        XCTAssertEqual(enumeratedStages(in: "stage TEXT NOT NULL CHECK "
                                        + "(stage IN ('code_minted','room_opened','room_paired'))"),
                       activationStages,
                       "the stage reader no longer recognises the closed vocabulary")

        // The Go halves: a third value threaded through the write, and a stage
        // the recorder was never supposed to be able to name.
        XCTAssertEqual(goStructFields("activationWrite",
                                      in: "type activationWrite struct {\n\tperiod string\n"
                                        + "\tstage  account.ActivationStage\n}"),
                       ["period", "stage"],
                       "the struct reader no longer recognises the real write")
        XCTAssertEqual(goStructFields("activationWrite",
                                      in: "type activationWrite struct {\n\tperiod string\n"
                                        + "\tstage  account.ActivationStage\n\tuserID string\n}"),
                       ["period", "stage", "userID"],
                       "a userID on the write would pass the aggregate guard")
        XCTAssertNil(goStructFields("activationWrite", in: "// nothing declares it"),
                     "a removed write struct reads as the two-field one")
        XCTAssertEqual(recordedStages(in: "h.recorder.Record(account.ActivationCodeMinted)\n"
                                       + "h.recorder.Record(clientSuppliedEvent)"),
                       ["account.ActivationCodeMinted", "clientSuppliedEvent"],
                       "a client-supplied event name would pass the aggregate guard")
        XCTAssertEqual(recordedStages(in: "nothing records here"), [],
                       "the recorder scan matches something it should not")
    }

    /// **The absences, asserted from the source.** These are the categories the
    /// audit ruled out, and each would become a false statement the moment the
    /// named symbol appeared. No diagnostics SDK is linked, nothing reports a
    /// crash or a frame time, no payment instrument leaves the device and no
    /// location is read.
    ///
    /// Product Interaction is NOT among them. It is declared, deliberately, for
    /// the identifier-free monthly aggregate — and the test below reads that
    /// aggregate's schema rather than taking the declaration's word for it. What
    /// is banned here instead is the shape that declaration must never take: a
    /// second Analytics entry, or an Analytics purpose on anything linked, which
    /// is what "we only count, we do not profile" would stop meaning.
    func testTheAppDeclaresNoAnalyticsOrDiagnosticsItDoesNotCollect() throws {
        let linked = try swiftSources(under: "apps/RelayiumKit/Sources")
            + swiftSources(under: "apps/mac/Relayium")
        for absent in ["import MetricKit", "Crashlytics", "FirebaseAnalytics", "SentrySDK"] {
            XCTAssertFalse(linked.contains(absent),
                           "\(absent) collects diagnostics; the manifest must say so")
        }
        let declared = try collected(try parsedPlist(appManifest))
        let types = declared.map(\.type)
        for banned in ["NSPrivacyCollectedDataTypeCrashData",
                       "NSPrivacyCollectedDataTypePerformanceData",
                       "NSPrivacyCollectedDataTypeOtherDiagnosticData",
                       "NSPrivacyCollectedDataTypePaymentInfo",
                       "NSPrivacyCollectedDataTypePreciseLocation",
                       "NSPrivacyCollectedDataTypeCoarseLocation"] {
            XCTAssertFalse(types.contains(banned), "\(banned) is declared but nothing collects it")
        }

        let analytics = declared.filter {
            ($0.entry["NSPrivacyCollectedDataTypePurposes"] as? [String] ?? [])
                .contains("NSPrivacyCollectedDataTypePurposeAnalytics")
        }
        XCTAssertEqual(analytics.map(\.type), [aggregateAnalyticsType],
                       "Analytics is declared for something other than the aggregate")
        for (type, entry) in analytics {
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, false,
                           "\(type) is analytics linked to the user")
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
        let project = try RepoRoot.text("apps/mac/Relayium.xcodeproj/project.pbxproj")
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
        let project = try RepoRoot.text("apps/mac/Relayium.xcodeproj/project.pbxproj")
        for (folder, targets) in [("Relayium", ["Relayium", "RelayiumAppStore"]),
                                  ("RelayiumShare", ["RelayiumShare", "RelayiumShareAppStore"])] {
            XCTAssertTrue(project.contains("isa = PBXFileSystemSynchronizedRootGroup;"),
                          "the macOS project no longer synchronizes its folders")
            for target in targets {
                XCTAssertTrue(project.contains(
                    "Exceptions for \"\(folder)\" folder in \"\(target)\" target"),
                    "\(target) no longer builds from the \(folder) folder")
            }
            XCTAssertNoThrow(try RepoRoot.url("apps/mac/\(folder)/PrivacyInfo.xcprivacy"),
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
