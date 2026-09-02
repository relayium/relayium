import XCTest
@testable import RelayiumAppKit

/// **The local-network declaration this iOS build owes, checked as artifacts
/// rather than as prose.**
///
/// It is no longer the app's only protected resource: the pairing QR scanner
/// added `NSCameraUsageDescription`, and everything specific to that key —
/// the copy bounds, the feature that earns it, the tap that precedes the
/// request — lives in `IOSPairingScannerTests`. What stays here is the
/// local-network key itself plus the two claims that are about the SET rather
/// than about either member: each catalog declares exactly the declared keys
/// and nothing else, and the Share extension declares none of them.
///
/// The defect this file exists for was an assertion pointing the wrong way. The
/// app connects to the device the user picks with `iceTransportPolicy = .all`,
/// so the candidate pair that wins between two devices in one building is a
/// unicast socket to the peer's address on this subnet — Local Network access on
/// iOS 14 and later. The bundle declared no `NSLocalNetworkUsageDescription`,
/// and `IOSSurfaceGuardTests` asserted that absence was correct, on an argument
/// that is true of the ROSTER (server-grouped, no Bonjour, no scan) and simply
/// does not reach the transfer.
///
/// The failure mode is the reason every check below reads a file instead of a
/// sentence. Retained physical runs `0af36138` and `56e78dbf` recorded it:
/// iOS/iPadOS 26 withheld the prompt entirely and the local path never
/// connected — no alert, no error the user could act on, nothing in a diff —
/// while iPadOS 18 masked the omission and made the same build look correct. A
/// missing purpose string is not one fewer permission; it is a feature that
/// fails without ever asking.
///
/// So: the plists and `.strings` are parsed, the `.lproj` set is read off the
/// file system, the English fallback is compared byte for byte against the
/// English catalog, and the project is checked for the one thing a
/// file-system-synchronized group can still get wrong. Nothing here asserts that
/// a comment says the right thing.
///
/// **What this file cannot prove.** No test may accept a system privacy alert,
/// and none here tries. That the prompt is offered and that allowing it makes a
/// real transfer succeed is a physical gate on an iOS/iPadOS 26 device, recorded
/// in `docs/ios-app-store-submission.md`. These tests establish that the
/// declaration the OS reads is present, correct, localized and reaching the
/// bundle — which is the half that can be established without a device, and the
/// half that was wrong.
final class IOSLocalNetworkPermissionTests: XCTestCase {

    // MARK: - paths and readers

    private static let appRoot = "apps/ios/Relayium"
    private static let extensionRoot = "apps/ios/RelayiumShare"
    private static let purposeKey = "NSLocalNetworkUsageDescription"
    /// Declared since the pairing QR scanner shipped, and owned by
    /// `IOSPairingScannerTests`. Named here only so the SET assertions below
    /// know what belongs in it.
    private static let cameraKey = "NSCameraUsageDescription"
    /// Exactly the protected resources this app declares. A key added to the
    /// plist and not to this list fails the catalog check below rather than
    /// shipping an unlocalized system alert.
    private static let declaredPurposeKeys = [cameraKey, purposeKey].sorted()

    /// A repository plist or `.strings` file, parsed as what it is.
    ///
    /// `RepoRoot.data` throws on a missing file rather than yielding nothing:
    /// an empty dictionary satisfies every "declares no X" assertion below, so a
    /// moved file must fail loudly instead of reading as a clean bundle.
    private func plist(_ relativePath: String,
                       file: StaticString = #filePath,
                       line: UInt = #line) throws -> [String: Any] {
        let data = try RepoRoot.data(relativePath)
        return try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any],
            "\(relativePath) is not a parseable property list",
            file: file, line: line)
    }

    /// The `.lproj` folder name for a language.
    ///
    /// `AppLanguage.lproj` is the *region* token (`zh-Hans`), which is what
    /// `CFBundleLocalizations` and `knownRegions` carry; the directory on disk
    /// is that token plus the extension. Derived here rather than written out,
    /// so restoring a language cannot leave this file naming a folder that does
    /// not exist.
    private func lprojName(_ language: AppLanguage) -> String { "\(language.lproj).lproj" }

    /// One language's `InfoPlist.strings`, as key/value pairs.
    ///
    /// Old-style `.strings` is a property-list dialect, so it goes through the
    /// same parser — which also means a syntax error (a missing semicolon, an
    /// unbalanced quote) fails here rather than shipping a bundle where iOS
    /// silently falls back to the key name.
    private func catalog(_ lproj: String,
                         file: StaticString = #filePath,
                         line: UInt = #line) throws -> [String: String] {
        let path = "\(Self.appRoot)/\(lproj)/InfoPlist.strings"
        let data = try RepoRoot.data(path)
        return try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: String],
            "\(path) is not a parseable strings file",
            file: file, line: line)
    }

    /// The local-network purpose string a given language actually renders.
    private func purpose(_ language: AppLanguage,
                         file: StaticString = #filePath,
                         line: UInt = #line) throws -> String {
        try purpose(Self.purposeKey, language, file: file, line: line)
    }

    /// Any declared purpose string, in a given language.
    private func purpose(_ key: String,
                         _ language: AppLanguage,
                         file: StaticString = #filePath,
                         line: UInt = #line) throws -> String {
        try XCTUnwrap(try catalog(lprojName(language))[key],
                      "\(language.lproj) declares no \(key)",
                      file: file, line: line)
    }

    /// Every `.lproj` directory that actually exists in the app source tree.
    private func lprojDirectories(under relativePath: String) throws -> [String] {
        let root = try RepoRoot.directory(relativePath)
        return try FileManager.default
            .contentsOfDirectory(atPath: root.path)
            .filter { $0.hasSuffix(".lproj") }
            .sorted()
    }

    // MARK: - the declaration exists, and the behaviour that owes it still does

    /// The key is present and says something.
    ///
    /// Paired with the source fact that makes it necessary, in the same test on
    /// purpose. A future change that made every lane relay-only would retire the
    /// requirement, and this pairing is what would make that visible instead of
    /// leaving a permission the app no longer needs — the failure this file's
    /// predecessor was trying to prevent, and the one direction it was right
    /// about.
    func testTheAppDeclaresTheLocalNetworkPurposeStringItsTransferActuallyNeeds() throws {
        let declared = try XCTUnwrap(
            try plist("\(Self.appRoot)/Info.plist")[Self.purposeKey] as? String,
            "the app has no \(Self.purposeKey), so iOS 26 fails a local transfer "
                + "without offering the prompt")
        XCTAssertFalse(declared.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                       "the purpose string is declared and empty, which is what iOS shows")

        // The reason, read from the code rather than restated. Both are the
        // shipped decision: the nearby/roster lane and the unified link lane.
        for (source, needle) in [
            ("apps/RelayiumKit/Sources/RelayiumAppKit/RealtimeConnectionFactory.swift",
             "iceTransportPolicy: relayOnly ? .relay : .all"),
            ("apps/RelayiumKit/Sources/RelayiumAppKit/LinkWorkspaceModel.swift",
             "iceTransportPolicy: relayOnly ? .relay : .all"),
        ] {
            XCTAssertTrue(try RepoRoot.text(source).contains(needle),
                          "\(source) no longer offers non-relay candidates. If every lane "
                              + "became relay-only, this purpose string is no longer owed "
                              + "and should be removed rather than left as an unused "
                              + "permission.")
        }
    }

    // MARK: - exactly two languages, and they are the supported ones

    /// The app bundle carries exactly the shipped set of `.lproj` folders.
    ///
    /// Read off the file system, not off `CFBundleLocalizations`: those are two
    /// different claims, and the failure worth catching is the one where they
    /// disagree. A third folder would ship a purpose string in a language the
    /// product does not maintain; a missing one would make that language fall
    /// back to English for the single sentence a user reads before deciding
    /// whether to trust the app with their network.
    func testTheAppShipsExactlyTheSupportedLprojFoldersAndNothingElse() throws {
        XCTAssertEqual(try lprojDirectories(under: Self.appRoot),
                       AppLanguage.allCases.map(lprojName).sorted(),
                       "the app's .lproj set is not the supported-language set")
        XCTAssertEqual(AppLanguage.allCases.map(lprojName).sorted(),
                       ["en.lproj", "zh-Hans.lproj"],
                       "the supported set changed; this declaration must follow it")

        // And each holds exactly the one file this batch adds. A stray
        // `Localizable.strings` here would be a second, unmanaged catalog
        // shadowing the package's.
        for language in AppLanguage.allCases {
            let directory = try RepoRoot.directory("\(Self.appRoot)/\(lprojName(language))")
            XCTAssertEqual(try FileManager.default
                            .contentsOfDirectory(atPath: directory.path)
                            .filter { !$0.hasPrefix(".") }
                            .sorted(),
                           ["InfoPlist.strings"],
                           "\(lprojName(language)) holds something other than "
                               + "InfoPlist.strings")
        }
    }

    /// Each catalog declares exactly the keys currently declared — no more.
    ///
    /// "No more" is the load-bearing half. A localized purpose string for a key
    /// the `Info.plist` does not declare is invisible: it ships, it is never
    /// read, and it reads in review as coverage for a permission the app has not
    /// actually asked for.
    ///
    /// "No fewer" is what the camera key added: two protected resources now
    /// draw a system alert, and a language that localizes one but not the other
    /// renders an English sentence at the exact moment the reader is deciding.
    func testEachCatalogDeclaresExactlyTheDeclaredPurposeKeys() throws {
        let infoPlist = try plist("\(Self.appRoot)/Info.plist")
        let infoKeys = Set(infoPlist.keys)
        // The plist and this list must be the same set, in both directions: a
        // third purpose string added to the bundle without being named here
        // would otherwise ship with no localization check at all.
        XCTAssertEqual(infoKeys.filter { $0.hasPrefix("NS") && $0.hasSuffix("UsageDescription") }
                        .sorted(),
                       Self.declaredPurposeKeys,
                       "the app declares a purpose string this file does not know about")
        for language in AppLanguage.allCases {
            let catalog = try catalog(lprojName(language))
            XCTAssertEqual(catalog.keys.sorted(), Self.declaredPurposeKeys,
                           "\(language.lproj) declares \(catalog.keys.sorted())")
            for key in catalog.keys {
                XCTAssertTrue(infoKeys.contains(key),
                              "\(language.lproj) localizes \(key), which Info.plist does not "
                                  + "declare, so nothing ever renders it")
            }
            for key in Self.declaredPurposeKeys {
                XCTAssertFalse(
                    try purpose(key, language)
                        .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    "\(language.lproj) declares \(key) with no sentence behind it")
            }
        }
    }

    /// The `Info.plist` value and the English catalog are the same sentence.
    ///
    /// They are two strings that must never diverge, and only one of them is
    /// read on any given device: iOS resolves the catalog when the user's
    /// language matches and falls back to the plist when it does not. Letting
    /// them drift means two different promises about the same permission, and
    /// the one nobody proof-reads is the one an unmatched language gets.
    func testTheEnglishCatalogAndTheInfoPlistFallbackAreTheSameSentence() throws {
        let fallback = try XCTUnwrap(
            try plist("\(Self.appRoot)/Info.plist")[Self.purposeKey] as? String)
        XCTAssertEqual(try purpose(.en), fallback,
                       "the English catalog and the Info.plist fallback say different things")
    }

    /// Simplified Chinese is a translation, not a copy and not a placeholder.
    ///
    /// The two failures this catches look identical in a bundle and opposite in
    /// intent: a file created by duplicating the English one and never
    /// translated, and one filled with a marker that was meant to be replaced.
    /// Both ship a Chinese-language user an English or nonsense sentence at the
    /// exact moment they are being asked to grant network access.
    func testTheChineseCopyIsARealTranslationRatherThanACopyOrAPlaceholder() throws {
        let english = try purpose(.en)
        let chinese = try purpose(.zh)

        XCTAssertNotEqual(chinese, english,
                          "zh-Hans repeats the English sentence verbatim")
        XCTAssertTrue(chinese.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) },
                      "zh-Hans carries no Han characters, so it is not Chinese copy")
        XCTAssertFalse(english.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) },
                       "the English catalog carries Han characters")

        for language in AppLanguage.allCases {
            let text = try purpose(language)
            XCTAssertNotEqual(text, Self.purposeKey,
                              "\(language.lproj) renders the key name")
            for marker in ["TODO", "FIXME", "XXX", "TBD", "PLACEHOLDER",
                           "Lorem", "translate me", "待翻译", "占位"] {
                XCTAssertFalse(text.localizedCaseInsensitiveContains(marker),
                               "\(language.lproj) still carries the \(marker) placeholder")
            }
            // The product is named in both, because an alert is attributed to an
            // app by name and an unnamed sentence reads as the system's own.
            XCTAssertTrue(text.contains("Relayium"),
                          "\(language.lproj) does not name the app asking")
        }
    }

    // MARK: - what the copy may and may not say

    /// The sentence describes the transfer, and claims nothing about discovery.
    ///
    /// This is the product invariant the whole repair turns on. Relayium does
    /// not scan, browse, or enumerate the local network: the roster comes from
    /// its own server, keyed by the public address it observes. A purpose string
    /// that said otherwise would be asking for consent to something that does
    /// not happen — the exact overclaim Apple's guidance is about, and the one
    /// the previous (wrong) guard was trying to prevent by removing the key
    /// altogether.
    ///
    /// The transport vocabulary is banned for a different reason: `ICE`,
    /// `WebRTC` and `STUN` are accurate and mean nothing to the person reading
    /// a system alert, and a purpose string is read once, under time pressure,
    /// by someone deciding whether to trust the app.
    func testNeitherPurposeStringClaimsDiscoveryOrExposesTransportJargon() throws {
        // Word-bounded so a future sentence is judged on the word it uses and
        // not on a substring inside an unrelated one.
        let bannedWords = ["scan", "scans", "scanning", "discover", "discovers",
                           "discovery", "browse", "browses", "browsing",
                           "bonjour", "mdns", "multicast", "broadcast",
                           "webrtc", "ice", "stun", "turn", "udp", "socket",
                           "subnet", "wi-fi", "wifi"]
        // Chinese has no word boundaries a regex can use, so these are plain
        // substrings — which is the stricter direction and the safe one here.
        let bannedSubstrings = ["扫描", "发现", "浏览", "搜索", "枚举",
                                "组播", "广播", "子网", "套接字",
                                "Bonjour", "WebRTC", "STUN", "TURN", "Wi-Fi", "无线"]

        for language in AppLanguage.allCases {
            let text = try purpose(language)
            for word in bannedWords {
                let pattern = "\\b\(NSRegularExpression.escapedPattern(for: word))\\b"
                XCTAssertNil(text.range(of: pattern,
                                        options: [.regularExpression, .caseInsensitive]),
                             "\(language.lproj) says \"\(word)\", which either claims a "
                                 + "capability this app does not use or is transport "
                                 + "vocabulary in a sentence a person has to act on")
            }
            for substring in bannedSubstrings {
                XCTAssertFalse(text.localizedCaseInsensitiveContains(substring),
                               "\(language.lproj) says \"\(substring)\"")
            }
        }

        // And it says the thing it is FOR. A sentence that avoided every banned
        // word by describing nothing would pass the half above.
        let english = try purpose(.en).lowercased()
        for required in ["send", "device"] {
            XCTAssertTrue(english.contains(required),
                          "the English purpose string never mentions \(required)ing")
        }
        let chinese = try purpose(.zh)
        for required in ["发送", "设备"] {
            XCTAssertTrue(chinese.contains(required),
                          "the Chinese purpose string never mentions \(required)")
        }
    }

    // MARK: - the app/extension boundary

    /// The Share extension declares none of this, and is not localized for it.
    ///
    /// Two bundles, two `Info.plist` files, and the extension's reach is
    /// deliberately smaller: it copies what the user shared into the App Group
    /// and stops. It opens no connection at all, so a local-network declaration
    /// there would be a permission claim by a process that makes no request —
    /// and, because iOS attributes an extension's prompt to the host app, a
    /// prompt the user could not explain.
    func testTheShareExtensionDeclaresNoLocalNetworkAccessAndIsNotLocalizedForIt() throws {
        let extensionPlist = try plist("\(Self.extensionRoot)/Info.plist")
        XCTAssertNil(extensionPlist[Self.purposeKey],
                     "the share extension asks for local-network access it never uses")
        XCTAssertNil(extensionPlist["NSBonjourServices"])
        XCTAssertEqual(try lprojDirectories(under: Self.extensionRoot), [],
                       "the share extension grew an .lproj folder this batch did not add")

        // Its entitlements stay exactly the one App Group — no networking key
        // arrived alongside the app's purpose string.
        let entitlements = try plist("\(Self.extensionRoot)/RelayiumShare.entitlements")
        XCTAssertEqual(entitlements.keys.sorted(),
                       ["com.apple.security.application-groups"],
                       "the extension claims \(entitlements.keys.sorted())")
    }

    /// **The camera declaration is the APP's, and only the app's.**
    ///
    /// This replaces `testNoCameraPurposeStringHasAppearedWhileThatBlockerIsStillOpen`,
    /// which existed because the opposite was true: the embedded WebRTC
    /// framework referenced `AVCapture*` symbols the app's own binary never
    /// called, `0.1.0` build 3 was rejected for the missing key, and adding one
    /// then would have been the cheapest way to pass an upload check and a
    /// false statement to Apple — there was no camera feature to describe. The
    /// old guard was written to be deleted by the batch that resolved that, and
    /// this is that batch: `PairingScannerView` is a real feature, so the
    /// declaration is now owed rather than invented. The copy bounds and the
    /// feature/request wiring behind it are `IOSPairingScannerTests`.
    ///
    /// What is asserted here is the half about the two bundles. The Share
    /// extension copies what the user shared into the App Group and stops; it
    /// opens no camera, and because iOS attributes an extension's prompt to the
    /// host app, a purpose string there would be a prompt the user could not
    /// explain and nothing would ever trigger.
    func testTheCameraDeclarationIsTheAppsAloneAndTheExtensionStillDeclaresNothing() throws {
        let app = try XCTUnwrap(
            try plist("\(Self.appRoot)/Info.plist")[Self.cameraKey] as? String,
            "the app scans a pairing QR code with no \(Self.cameraKey), which App Review "
                + "rejects and which leaves the scanner unable to open the camera at all")
        XCTAssertFalse(app.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

        XCTAssertNil(try plist("\(Self.extensionRoot)/Info.plist")[Self.cameraKey],
                     "the share extension asks for camera access it never uses; iOS would "
                         + "attribute that prompt to the host app")
        // And the extension has no source that could want one. A capture class
        // appearing there would be the diff this assertion is about.
        for symbol in ["AVCaptureSession", "AVCaptureDevice", "AVCaptureMetadataOutput"] {
            for file in try RepoRoot.swiftFiles(under: Self.extensionRoot) {
                XCTAssertFalse(try RepoRoot.text(of: file).contains(symbol),
                               "\(file.lastPathComponent) reaches for \(symbol)")
            }
        }
    }

    // MARK: - the files actually reach the bundle

    /// **A `.strings` file that the target does not copy is a file iOS never
    /// reads.**
    ///
    /// `apps/ios/Relayium.xcodeproj` uses Xcode 16 file-system-synchronized
    /// groups, so adding the two folders on disk is what adds them to the
    /// target — there is no reference to write, which is the whole reason this
    /// batch touches no `project.pbxproj`. But synchronization has one escape
    /// hatch, `membershipExceptions`, and a path listed there is silently
    /// dropped from the build. `Info.plist` is on that list legitimately (it is
    /// consumed by `INFOPLIST_FILE`, not copied as a resource); anything else
    /// appearing there would remove a resource with no diff in any build phase.
    ///
    /// Asserted from the project file because target membership is not
    /// observable any other way without building, and the failure it guards
    /// against — a correct, localized, unshipped string — looks exactly like
    /// success in the source tree.
    func testTheLocalizedStringsReachTheAppTargetThroughTheSynchronizedGroup() throws {
        let project = try RepoRoot.text("apps/ios/Relayium.xcodeproj/project.pbxproj")

        XCTAssertTrue(project.contains("isa = PBXFileSystemSynchronizedRootGroup;")
                        && project.contains("path = Relayium; sourceTree = \"<group>\";"),
                      "the app's sources are no longer a synchronized root group, so these "
                          + "files need explicit project references this batch did not add")

        // Every exception set, and the exact list each one carries.
        let sets = project
            .components(separatedBy: "isa = PBXFileSystemSynchronizedBuildFileExceptionSet;")
            .dropFirst()
        XCTAssertFalse(sets.isEmpty, "no synchronized exception sets found to inspect")
        for block in sets {
            guard let body = block.components(separatedBy: "membershipExceptions = (")
                    .dropFirst().first?
                    .components(separatedBy: ");").first else {
                continue
            }
            let excluded = body
                .components(separatedBy: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            XCTAssertEqual(excluded, ["Info.plist"],
                           "a synchronized group excludes \(excluded) from its target; a "
                               + "localized .strings file listed here would be built out of "
                               + "the bundle without changing any build phase")
        }

        // And nothing hand-added a second, competing reference to the same
        // files: a synchronized group plus an explicit variant group is how one
        // resource gets copied twice.
        XCTAssertFalse(project.contains("InfoPlist.strings"),
                       "the project names InfoPlist.strings explicitly, which duplicates "
                           + "what the synchronized group already contributes")
        XCTAssertFalse(project.contains("PBXVariantGroup"),
                       "a variant group appeared; localization here is by synchronized "
                           + "folder, not by explicit variant references")

        // `knownRegions` is what Xcode resolves a localized folder against.
        // `LocalizationIntegrityTests` asserts the exact list; this asserts the
        // two these files need are in it, which is the half that would break
        // them.
        for language in AppLanguage.allCases {
            XCTAssertTrue(project.contains("knownRegions"), "no knownRegions block")
            XCTAssertTrue(project.contains(language.lproj)
                            || project.contains("\"\(language.lproj)\""),
                          "knownRegions does not carry \(language.lproj)")
        }
    }
}
