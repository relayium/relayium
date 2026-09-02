import XCTest
@testable import RelayiumAppKit

/// **The one protected resource this iOS build declares, checked as artifacts
/// rather than as prose.**
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
    /// Deliberately not declared, and deliberately named here. See
    /// `testNoCameraPurposeStringHasAppearedWhileThatBlockerIsStillOpen`.
    private static let cameraKey = "NSCameraUsageDescription"

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

    /// The purpose string a given language actually renders.
    private func purpose(_ language: AppLanguage,
                         file: StaticString = #filePath,
                         line: UInt = #line) throws -> String {
        try XCTUnwrap(try catalog(lprojName(language))[Self.purposeKey],
                      "\(language.lproj) declares no \(Self.purposeKey)",
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

    /// Each catalog declares exactly the one key currently declared — no more.
    ///
    /// "No more" is the load-bearing half. A localized purpose string for a key
    /// the `Info.plist` does not declare is invisible: it ships, it is never
    /// read, and it reads in review as coverage for a permission the app has not
    /// actually asked for.
    func testEachCatalogDeclaresExactlyTheOneDeclaredPurposeKey() throws {
        let infoKeys = Set(try plist("\(Self.appRoot)/Info.plist").keys)
        for language in AppLanguage.allCases {
            let catalog = try catalog(lprojName(language))
            XCTAssertEqual(catalog.keys.sorted(), [Self.purposeKey],
                           "\(language.lproj) declares \(catalog.keys.sorted())")
            for key in catalog.keys {
                XCTAssertTrue(infoKeys.contains(key),
                              "\(language.lproj) localizes \(key), which Info.plist does not "
                                  + "declare, so nothing ever renders it")
            }
            XCTAssertFalse(
                try purpose(language).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                "\(language.lproj) declares the key with no sentence behind it")
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

    /// **The camera blocker is still open, and this batch did not paper over
    /// it.**
    ///
    /// The embedded WebRTC framework references `AVCapture*` symbols the app's
    /// own binary never calls, and `0.1.0` build 3 was rejected for the missing
    /// `NSCameraUsageDescription`. Adding one now would be the cheapest way to
    /// make an upload check pass and a false statement to Apple and to the user:
    /// there is no camera feature. The two honest resolutions — ship a real
    /// scanner, or ship a data-channel-only framework — are separately scoped in
    /// `docs/ios-app-store-submission.md`.
    ///
    /// This guard fails if a camera string appears without that decision. It is
    /// meant to be deleted BY the batch that resolves the blocker, and the
    /// failure message is where the next author is told which one they are in.
    func testNoCameraPurposeStringHasAppearedWhileThatBlockerIsStillOpen() throws {
        for path in ["\(Self.appRoot)/Info.plist", "\(Self.extensionRoot)/Info.plist"] {
            XCTAssertNil(try plist(path)[Self.cameraKey],
                         "\(path) declares \(Self.cameraKey). If a real camera feature now "
                             + "exists, resolve the blocker in "
                             + "docs/ios-app-store-submission.md and retire this guard; if "
                             + "it does not, this string is a false statement to Apple.")
        }
        for language in AppLanguage.allCases {
            XCTAssertNil(try catalog(lprojName(language))[Self.cameraKey],
                         "\(language.lproj) localizes a camera purpose string")
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
