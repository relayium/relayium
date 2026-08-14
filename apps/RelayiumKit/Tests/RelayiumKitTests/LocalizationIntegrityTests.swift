import XCTest
@testable import RelayiumAppKit

/// Structural guarantees about the nine catalogs.
///
/// Every assertion here is about the FILES, read directly, rather than about
/// what `L10n` renders. That is the point: `L10n` falls back to English and then
/// to the key, so a missing Arabic string produces English on screen and no
/// crash — a bug that ships silently and is only visible to the people who
/// cannot read the fallback.
///
/// Nothing in this file depends on the language the test runner happens to be
/// in. Every lookup names its `AppLanguage`.
final class LocalizationIntegrityTests: XCTestCase {

    // MARK: - exactly nine

    /// The product contract is these nine, matching the web client's `LANGS`.
    func testExactlyTheNineSupportedLanguages() {
        XCTAssertEqual(AppLanguage.allCases.map(\.rawValue),
                       ["en", "zh", "ja", "ko", "de", "fr", "ar", "es", "pt"])
    }

    /// A tenth `.lproj` in the bundle would be a language the app claims to
    /// support and this enum cannot select, and a missing one is a language the
    /// enum offers and the bundle cannot answer for. Both are failures.
    ///
    /// Compared case-insensitively: SwiftPM lowercases `zh-Hans` on its way into
    /// the built bundle while Xcode preserves it, and which build produced the
    /// bundle is not something this contract should depend on.
    func testResourceBundleShipsExactlyTheNineCatalogs() {
        let shipped = Set(StringsCatalog.shippedLocalizations.map { $0.lowercased() })
        let expected = Set(AppLanguage.allCases.map { $0.lproj.lowercased() })
        XCTAssertEqual(shipped, expected,
                       "shipped .lproj set does not match AppLanguage")
    }

    /// Each language's catalog has to be readable through the bundle machinery
    /// too, not merely present on disk — that is what a lookup actually uses.
    func testEveryLanguageResolvesAnLprojBundle() {
        for language in AppLanguage.allCases {
            XCTAssertNotNil(LocalizationCatalog.shared.bundle(for: language),
                            "no .lproj bundle for \(language.rawValue)")
        }
    }

    // MARK: - maintained and frozen

    /// The owner's supported-language decision (2026-08-14), as a value the
    /// tests below are written against rather than a rule in a document.
    ///
    /// English is the source and the fallback; Simplified Chinese is maintained
    /// beside it. The other seven are FROZEN: their existing translations stay
    /// shipped and stay correct, and new or changed product copy is not added to
    /// them. That is a deliberate product decision, not neglect — a locale
    /// updated only sometimes produces a screen that is half one language and
    /// half another, which is worse than a screen that is consistently English.
    ///
    /// Restoring one is an explicit decision, made one locale at a time with a
    /// complete translation of the CURRENT copy. Nothing here makes that easier
    /// or harder; it only stops a frozen locale being mistaken for a maintained
    /// one by a test that cannot tell the difference.
    private static let maintained: Set<AppLanguage> = [.en, .zh]
    private static var frozen: [AppLanguage] {
        AppLanguage.allCases.filter { !maintained.contains($0) }
    }

    // MARK: - coverage

    /// Every canonical key present and non-empty in both maintained languages.
    ///
    /// This is the gate new copy has to pass. It is the whole of the
    /// localization acceptance requirement for a product change now, and it is
    /// strictly stronger for these two than the old nine-language rule was in
    /// practice: it is checked rather than approximated by whoever remembered.
    func testEveryKeyIsDefinedAndNonEmptyInEveryMaintainedLanguage() {
        for language in AppLanguage.allCases where Self.maintained.contains(language) {
            let catalog = try? XCTUnwrap(StringsCatalog.load(language))
            guard let catalog else {
                XCTFail("catalog for \(language.rawValue) is missing or unparseable")
                continue
            }
            for key in L10nKey.allCases {
                guard let value = catalog[key.rawValue] else {
                    XCTFail("\(language.rawValue) is missing \(key.rawValue)")
                    continue
                }
                XCTAssertFalse(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                               "\(language.rawValue) has an empty \(key.rawValue)")
            }
        }
        XCTAssertEqual(Self.maintained, [.en, .zh],
                       "the maintained set is a product decision, not a convenience")
    }

    /// A frozen catalog may lack a key. What it may NOT do is define one badly.
    ///
    /// Freezing a locale removes the obligation to translate new copy. It does
    /// not remove the obligation that what is still shipped there works: an
    /// empty value renders as a blank label rather than falling back, because
    /// the key IS present — which is the one failure a frozen locale can still
    /// introduce and the reason this is not simply skipped.
    func testEveryFrozenCatalogEntryThatExistsIsStillUsable() {
        for language in Self.frozen {
            guard let catalog = StringsCatalog.load(language) else {
                XCTFail("catalog for \(language.rawValue) is missing or unparseable")
                continue
            }
            XCTAssertFalse(catalog.isEmpty,
                           "\(language.rawValue) lost its existing translations")
            for key in L10nKey.allCases {
                guard let value = catalog[key.rawValue] else { continue }
                XCTAssertFalse(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                               "\(language.rawValue) has an empty \(key.rawValue)")
            }
        }
    }

    /// And a key a frozen catalog lacks renders ENGLISH, not the raw key.
    ///
    /// This is the whole safety argument for freezing. It is asserted against a
    /// key that genuinely is absent from the frozen catalogs rather than against
    /// an invented one, so it fails if the fallback chain is ever shortened.
    func testAKeyAFrozenCatalogLacksFallsBackToEnglish() throws {
        let english = try XCTUnwrap(StringsCatalog.load(.en))
        for language in Self.frozen {
            guard let catalog = StringsCatalog.load(language) else { continue }
            let absent = L10nKey.allCases.filter { catalog[$0.rawValue] == nil }
            guard let key = absent.first else { continue }
            XCTAssertEqual(L10n.t(key, language: language), english[key.rawValue],
                           "\(language.rawValue) \(key.rawValue) did not fall back to English")
            XCTAssertNotEqual(L10n.t(key, language: language), key.rawValue,
                              "a frozen locale rendered a raw key at the user")
        }
    }

    /// No key in a catalog that nothing in the app names. A leftover entry is a
    /// string somebody translated and nobody renders — and, more often, the
    /// residue of a rename that left the old spelling behind in eight files.
    func testNoCatalogDefinesAKeyTheAppDoesNotUse() {
        let canonical = Set(L10nKey.allCases.map(\.rawValue))
            .union(PluralKey.allCases.flatMap { key in
                PluralCategory.allCases.map { key.key($0) }
            })
        for language in AppLanguage.allCases {
            guard let catalog = StringsCatalog.load(language) else {
                XCTFail("catalog for \(language.rawValue) is missing or unparseable")
                continue
            }
            let extra = Set(catalog.keys).subtracting(canonical).sorted()
            XCTAssertTrue(extra.isEmpty,
                          "\(language.rawValue) defines unused keys: \(extra)")
        }
    }

    // MARK: - plurals

    /// Exactly the categories CLDR says the language can produce — no more, no
    /// fewer.
    ///
    /// "No fewer" is the part that matters: `L10n.plural` falls back to `other`,
    /// so an Arabic catalog missing `few` renders grammatically wrong Arabic for
    /// every count from 3 to 10 and never fails at runtime. "No more" catches
    /// the opposite mistake — a `zero` form in German that will never be
    /// selected and therefore never reviewed.
    func testEveryPluralHasExactlyItsLanguagesCategories() {
        for language in AppLanguage.allCases {
            guard let catalog = StringsCatalog.load(language) else {
                XCTFail("catalog for \(language.rawValue) is missing")
                continue
            }
            let expected = Set(PluralRule.categories(for: language))
            for key in PluralKey.allCases {
                let present = Set(PluralCategory.allCases.filter {
                    catalog[key.key($0)] != nil
                })
                XCTAssertEqual(present, expected,
                               "\(language.rawValue) \(key.rawValue): "
                               + "has \(present.map(\.rawValue).sorted()), "
                               + "needs \(expected.map(\.rawValue).sorted())")
            }
        }
    }

    /// The rules themselves, at the boundaries that distinguish them.
    func testPluralRulesAtTheirBoundaries() {
        XCTAssertEqual(PluralRule.category(for: 1, language: .en), .one)
        XCTAssertEqual(PluralRule.category(for: 0, language: .en), .other)
        XCTAssertEqual(PluralRule.category(for: 2, language: .en), .other)
        // French and Portuguese put zero in `one`.
        XCTAssertEqual(PluralRule.category(for: 0, language: .fr), .one)
        XCTAssertEqual(PluralRule.category(for: 0, language: .pt), .one)
        XCTAssertEqual(PluralRule.category(for: 2, language: .fr), .other)
        // No grammatical number at all.
        for count in [0, 1, 2, 11, 100] {
            XCTAssertEqual(PluralRule.category(for: count, language: .zh), .other)
            XCTAssertEqual(PluralRule.category(for: count, language: .ja), .other)
            XCTAssertEqual(PluralRule.category(for: count, language: .ko), .other)
        }
        // Arabic, all six.
        XCTAssertEqual(PluralRule.category(for: 0, language: .ar), .zero)
        XCTAssertEqual(PluralRule.category(for: 1, language: .ar), .one)
        XCTAssertEqual(PluralRule.category(for: 2, language: .ar), .two)
        XCTAssertEqual(PluralRule.category(for: 3, language: .ar), .few)
        XCTAssertEqual(PluralRule.category(for: 10, language: .ar), .few)
        XCTAssertEqual(PluralRule.category(for: 11, language: .ar), .many)
        XCTAssertEqual(PluralRule.category(for: 99, language: .ar), .many)
        XCTAssertEqual(PluralRule.category(for: 100, language: .ar), .other)
        XCTAssertEqual(PluralRule.category(for: 103, language: .ar), .few)
    }

    // MARK: - placeholders

    /// A translation that drops `%@`, adds one, or renumbers `%1$@`/`%2$@` is
    /// the one localization mistake that is not merely wrong words: with a
    /// mismatched count `String(format:)` reads an argument that was never
    /// passed. Compare every catalog's specifier set against English.
    func testPlaceholderSignaturesMatchEnglish() {
        guard let english = StringsCatalog.load(.en) else {
            return XCTFail("English catalog is missing")
        }
        for language in AppLanguage.allCases where language != .en {
            guard let catalog = StringsCatalog.load(language) else {
                XCTFail("catalog for \(language.rawValue) is missing")
                continue
            }
            for key in L10nKey.allCases {
                guard let source = english[key.rawValue],
                      let translated = catalog[key.rawValue] else { continue }
                XCTAssertEqual(formatSpecifiers(translated), formatSpecifiers(source),
                               "\(language.rawValue) \(key.rawValue) placeholders differ "
                               + "from English")
            }
        }
    }

    /// Plural forms take exactly one count argument, in every category and every
    /// language — including Arabic's `zero`, which reads naturally without a
    /// number and would be tempting to write that way.
    func testEveryPluralFormTakesExactlyTheCountArgument() {
        for language in AppLanguage.allCases {
            guard let catalog = StringsCatalog.load(language) else { continue }
            for key in PluralKey.allCases {
                for category in PluralRule.categories(for: language) {
                    guard let value = catalog[key.key(category)] else { continue }
                    XCTAssertEqual(formatSpecifiers(value),
                                   [FormatSpecifier(index: 1, conversion: "@")],
                                   "\(language.rawValue) \(key.key(category))")
                }
            }
        }
    }

    /// The extractor itself, since every placeholder assertion rests on it.
    func testFormatSpecifierExtraction() {
        XCTAssertEqual(formatSpecifiers("no arguments"), [])
        XCTAssertEqual(formatSpecifiers("%@ file"), [FormatSpecifier(index: 1, conversion: "@")])
        XCTAssertEqual(formatSpecifiers("%@%%"), [FormatSpecifier(index: 1, conversion: "@")])
        XCTAssertEqual(formatSpecifiers("100%% done"), [])
        XCTAssertEqual(formatSpecifiers("%2$@ then %1$@"),
                       [FormatSpecifier(index: 1, conversion: "@"),
                        FormatSpecifier(index: 2, conversion: "@")])
    }

    // MARK: - deterministic lookup and fallback

    /// A lookup is a function of its language argument and of nothing else.
    /// Asserted by fixing the process language to each of the other eight and
    /// checking the answer for a ninth does not move.
    func testExplicitLanguageLookupIgnoresTheProcessLanguage() {
        defer { L10n.resetCurrent() }
        let expected = L10n.t(.tabAccount, language: .ja)
        for language in AppLanguage.allCases {
            L10n.current = language
            XCTAssertEqual(L10n.t(.tabAccount, language: .ja), expected,
                           "explicit .ja lookup moved while current was \(language.rawValue)")
        }
    }

    /// And every lookup returns THAT language's own catalog entry, key by key.
    ///
    /// Deliberately not "all nine answers differ": Spanish and Portuguese
    /// genuinely share words (`Cancelar`), so a uniqueness check would be a
    /// false alarm on correct translations while still missing a subtler
    /// resolution bug. Comparing against the file contents catches a whole
    /// language quietly falling through to English — which is exactly what a
    /// case-sensitive `.lproj` lookup did before `lprojPath` tolerated case.
    func testEveryLookupReturnsThatLanguagesOwnCatalogEntry() {
        for language in AppLanguage.allCases {
            guard let catalog = StringsCatalog.load(language) else {
                XCTFail("catalog for \(language.rawValue) is missing")
                continue
            }
            for key in L10nKey.allCases {
                // A key a frozen catalog does not define is English by design,
                // and `testAKeyAFrozenCatalogLacksFallsBackToEnglish` owns that
                // half. What is asserted here is the half a freeze must not
                // weaken: every entry a catalog DOES define is the one that
                // renders, so a whole language cannot quietly fall through.
                guard let own = catalog[key.rawValue] else { continue }
                XCTAssertEqual(L10n.t(key, language: language), own,
                               "\(language.rawValue) \(key.rawValue) did not come from "
                               + "its own catalog")
            }
        }
    }

    /// English is the fallback, and it is reached rather than the raw key.
    func testUnknownKeyFallsBackThroughEnglishToTheKey() {
        let catalog = LocalizationCatalog.shared
        // A key no catalog defines: the last resort is the key itself, visible
        // on screen, which is a bug report rather than a blank label.
        XCTAssertEqual(catalog.string("relayium.no.such.key", language: .ar),
                       "relayium.no.such.key")
        // A key every catalog defines resolves in the asked language, so the
        // fallback above is not simply "everything falls through".
        XCTAssertNotEqual(catalog.string(L10nKey.commonCancel.rawValue, language: .ar),
                          catalog.string(L10nKey.commonCancel.rawValue, language: .en))
    }

    /// The plural fallback chain lands on English rather than on a raw key when
    /// a category is absent — proved with a catalog that has holes on purpose.
    func testPluralFallsBackToEnglishRatherThanTheKey() {
        // `zero` exists only in Arabic. Asking German for a count of 0 must
        // therefore go through German's `other`, not through the key.
        let german = L10n.plural(.selectionFiles, 0, language: .de)
        XCTAssertFalse(german.contains("selection.files"), german)
        XCTAssertTrue(german.contains("0"), german)
    }

    // MARK: - right-to-left

    /// Arabic is the only RTL language shipped, and the platform's character
    /// direction agrees. The macOS scene root consumes this same app-language
    /// fact explicitly; package-backed catalogs did not make macOS propagate it
    /// into SwiftUI's environment on their own.
    func testArabicIsRightToLeftAndNothingElseIs() {
        for language in AppLanguage.allCases {
            let platform = NSLocale.characterDirection(forLanguage: language.lproj)
            XCTAssertEqual(language.isRightToLeft, platform == .rightToLeft,
                           "\(language.rawValue): app says isRightToLeft="
                           + "\(language.isRightToLeft), platform says \(platform.rawValue)")
        }
        XCTAssertEqual(AppLanguage.allCases.filter(\.isRightToLeft), [.ar])
    }

    /// The Arabic catalog is a real localization of the bundle, which is what
    /// makes the platform treat the app as Arabic-capable at all.
    func testArabicIsAShippedLocalizationOfTheResourceBundle() {
        XCTAssertTrue(StringsCatalog.shippedLocalizations.contains { $0.lowercased() == "ar" })
    }

    /// The macOS app declares the same nine in `CFBundleLocalizations`.
    ///
    /// This list advertises every supported localization from the app bundle.
    /// On macOS the package catalogs still did not propagate Arabic direction
    /// into the scene, so `RelayiumApp` additionally derives the scene-root
    /// direction from the same `AppLanguage` resolver.
    func testTheMacAppDeclaresTheSameNineLocalizations() throws {
        try assertAppDeclaresTheNine(at: "mac/Relayium/Info.plist")
    }

    /// And the iOS app, for the identical reason.
    ///
    /// Not a copy for symmetry's sake: `UIApplication.userInterfaceLayoutDirection`
    /// is decided from the app bundle's own localization list exactly as
    /// `NSApplication`'s is, so an iOS build that omitted this would render the
    /// package's correct Arabic strings in a left-to-right layout — the failure
    /// that is hardest to notice, because nothing about it is empty or blank.
    func testTheIOSAppDeclaresTheSameNineLocalizations() throws {
        try assertAppDeclaresTheNine(at: "ios/Relayium/Info.plist")
    }

    /// Read from the repository rather than from a built bundle so both fail in
    /// `swift test`, before anyone gets as far as running either app.
    private func assertAppDeclaresTheNine(at relativePath: String,
                                          file: StaticString = #filePath,
                                          line: UInt = #line) throws {
        let infoPlist = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
            .appendingPathComponent(relativePath)
        let plist = try XCTUnwrap(NSDictionary(contentsOf: infoPlist) as? [String: Any],
                                  "cannot read \(infoPlist.path)", file: file, line: line)
        let declared = try XCTUnwrap(plist["CFBundleLocalizations"] as? [String],
                                     "\(relativePath) declares no CFBundleLocalizations",
                                     file: file, line: line)
        XCTAssertEqual(Set(declared), Set(AppLanguage.allCases.map(\.lproj)),
                       relativePath, file: file, line: line)
        XCTAssertTrue(declared.contains("ar"),
                      "Arabic must be an app localization for RTL: \(relativePath)",
                      file: file, line: line)
    }

    /// Technical values are isolated under RTL and untouched otherwise.
    ///
    /// The isolate is what keeps `../escape.txt` reading as one unit inside an
    /// Arabic sentence instead of being reordered around it by the bidi
    /// algorithm. The bytes between the marks are unchanged, so what the user
    /// can copy out is still exactly the value.
    func testTokensAreBidiIsolatedOnlyForArabic() {
        let path = "../escape.txt"
        let isolated = L10n.token(path, language: .ar)
        XCTAssertEqual(isolated, "\u{2068}" + path + "\u{2069}")
        XCTAssertTrue(isolated.contains(path), "the value itself must survive verbatim")
        for language in AppLanguage.allCases where language != .ar {
            XCTAssertEqual(L10n.token(path, language: language), path,
                           "\(language.rawValue) must not wrap technical values")
        }
    }

    // MARK: - resolution

    func testLanguageResolutionPrefersTheFirstMatchAndFallsBackToEnglish() {
        XCTAssertEqual(AppLanguage.resolve(preferred: ["de-DE", "en-US"]), .de)
        XCTAssertEqual(AppLanguage.resolve(preferred: ["xh", "fr-CA"]), .fr)
        XCTAssertEqual(AppLanguage.resolve(preferred: []), .en)
        XCTAssertEqual(AppLanguage.resolve(preferred: ["xh", "yo"]), .en)
        // Any Chinese lands on the Simplified catalog rather than on English:
        // a reader of Chinese is better served by it than by a language they
        // may not read at all.
        XCTAssertEqual(AppLanguage.resolve(preferred: ["zh-Hans-CN"]), .zh)
        XCTAssertEqual(AppLanguage.resolve(preferred: ["zh-Hant-TW"]), .zh)
        XCTAssertEqual(AppLanguage.zh.lproj, "zh-Hans")
    }

    func testCurrentLanguageIsOverridableAndResettable() {
        defer { L10n.resetCurrent() }
        L10n.current = .ko
        XCTAssertEqual(L10n.current, .ko)
        XCTAssertEqual(L10n.t(.tabAccount), L10n.t(.tabAccount, language: .ko))
        L10n.resetCurrent()
        XCTAssertEqual(L10n.current, AppLanguage.systemPreferred())
    }
}
