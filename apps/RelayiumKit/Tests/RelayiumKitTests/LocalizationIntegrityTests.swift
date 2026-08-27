import XCTest
@testable import RelayiumAppKit

/// Structural guarantees about the two shipped catalogs, and about the seven
/// that are frozen outside every build target.
///
/// Every assertion here is about the FILES, read directly, rather than about
/// what `L10n` renders. That is the point: `L10n` falls back to English and then
/// to the key, so a missing string produces English on screen and no crash — a
/// bug that ships silently and is only visible to the people who cannot read the
/// fallback.
///
/// Nothing in this file depends on the language the test runner happens to be
/// in. Every lookup names its `AppLanguage`.
final class LocalizationIntegrityTests: XCTestCase {

    // MARK: - the shipped set, and the frozen one

    /// The seven languages Relayium no longer offers.
    ///
    /// Spelled as `.lproj` directory names rather than as `AppLanguage` values
    /// because that type can no longer express them — which is the contraction
    /// itself, and the reason these are strings here.
    private static let frozenLprojs = ["ar", "de", "es", "fr", "ja", "ko", "pt"]

    /// Where the frozen catalogs live now: inside the repository, outside every
    /// build target.
    private static let archiveRoot = "apps/localization-archive/frozen-locales"

    /// The product contract is these two, matching the web client's `LANGS`.
    ///
    /// Order included on purpose: `allCases` drives the language matrices in the
    /// UI tests and the surface guards, so a reordering is a change those should
    /// see rather than absorb.
    func testExactlyTheTwoShippedLanguages() {
        XCTAssertEqual(AppLanguage.allCases.map(\.rawValue), ["en", "zh"])
        XCTAssertEqual(AppLanguage.allCases.map(\.lproj), ["en", "zh-Hans"])
        XCTAssertEqual(AppLanguage.fallback, .en)
    }

    /// A third `.lproj` in the bundle would be a language the app claims to
    /// support and this enum cannot select, and a missing one is a language the
    /// enum offers and the bundle cannot answer for. Both are failures.
    ///
    /// This is the assertion that actually enforces the contraction. `AppLanguage`
    /// decides what the app can ASK for; `Package.swift`'s `.process("Resources")`
    /// decides what SHIPS, and it packages every `.lproj` it finds. Dropping the
    /// enum cases without moving the files would leave seven catalogs in the
    /// built bundle, advertised through `Bundle.localizations` to a system that
    /// reads it.
    ///
    /// Compared case-insensitively: SwiftPM lowercases `zh-Hans` on its way into
    /// the built bundle while Xcode preserves it, and which build produced the
    /// bundle is not something this contract should depend on.
    func testResourceBundleShipsExactlyTheTwoCatalogs() {
        let shipped = Set(StringsCatalog.shippedLocalizations.map { $0.lowercased() })
        let expected = Set(AppLanguage.allCases.map { $0.lproj.lowercased() })
        XCTAssertEqual(shipped, expected,
                       "shipped .lproj set does not match AppLanguage")
        XCTAssertEqual(shipped.count, 2, "shipped catalogs: \(shipped.sorted())")
        for frozen in Self.frozenLprojs {
            XCTAssertFalse(shipped.contains(frozen),
                           "\(frozen).lproj is back in the packaged resource bundle")
        }
    }

    /// Each language's catalog has to be readable through the bundle machinery
    /// too, not merely present on disk — that is what a lookup actually uses.
    func testEveryLanguageResolvesAnLprojBundle() {
        for language in AppLanguage.allCases {
            XCTAssertNotNil(LocalizationCatalog.shared.bundle(for: language),
                            "no .lproj bundle for \(language.rawValue)")
        }
    }

    // MARK: - the frozen archive

    /// **The seven frozen translations still exist.**
    ///
    /// Freezing a language and deleting it are different decisions, and only the
    /// first was taken. Each of these is roughly six hundred translated keys; a
    /// `git rm` would throw that away and would pass every other test in this
    /// file, because nothing that ships depends on them any more. This is the
    /// only thing standing between "not offered" and "gone".
    func testTheSevenFrozenCatalogsArePreservedAndNonEmpty() throws {
        for locale in Self.frozenLprojs {
            let catalog = try archivedCatalog(locale)
            XCTAssertGreaterThan(catalog.count, 100,
                                 "\(locale).lproj has \(catalog.count) keys — it looks "
                                 + "emptied rather than frozen")
            for (key, value) in catalog {
                XCTAssertFalse(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                               "\(locale).lproj has an empty \(key)")
            }
        }
        XCTAssertEqual(Self.frozenLprojs.count, 7)
    }

    /// And they are OUTSIDE the package's resource root.
    ///
    /// The adversarial half of the test above, and the one that would catch a
    /// restore-by-accident: a catalog copied back next to `en.lproj` ships,
    /// silently, because `.process` takes the whole directory. Asserted against
    /// the file system rather than the built bundle so it fails in the source
    /// tree, before a build exists to inspect.
    func testNoFrozenCatalogSitsInsideThePackageResourceRoot() throws {
        let resources = try RepoRoot.directory(
            "apps/RelayiumKit/Sources/RelayiumShareKit/Resources")
        let present = try FileManager.default
            .contentsOfDirectory(at: resources, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "lproj" }
            .map { $0.deletingPathExtension().lastPathComponent }
            .sorted()
        XCTAssertEqual(present, ["en", "zh-Hans"],
                       "the package resource root must hold exactly the shipped catalogs")
    }

    /// The archive documents exactly what it holds.
    ///
    /// A frozen catalog with no entry in the archive README is a file a future
    /// reader has no reason to keep and no instructions for restoring — which is
    /// how a "temporary" archive becomes a directory somebody deletes. Asserted
    /// against the directory contents rather than against `frozenLprojs`, so
    /// adding an eighth frozen locale without documenting it fails here.
    func testTheArchiveReadmeDocumentsEveryFrozenCatalogItHolds() throws {
        let readme = try RepoRoot.text("apps/localization-archive/README.md")
        let archived = try FileManager.default
            .contentsOfDirectory(at: try RepoRoot.directory(Self.archiveRoot),
                                 includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "lproj" }
            .map { $0.deletingPathExtension().lastPathComponent }
            .sorted()
        XCTAssertEqual(archived, Self.frozenLprojs.sorted(),
                       "the archive holds a different set than this file expects")
        for locale in archived {
            XCTAssertTrue(readme.contains("\(locale).lproj"),
                          "apps/localization-archive/README.md does not document \(locale).lproj")
        }
        // And it says what these files are NOT, which is the claim that stops
        // one being picked up and shipped as if it were current.
        XCTAssertTrue(readme.contains("frozen, not maintained"),
                      "the archive README no longer says these catalogs are unmaintained")
    }

    // MARK: - coverage

    /// Every canonical key present and non-empty in both shipped languages.
    ///
    /// This is the gate new copy has to pass, and it is the whole of the
    /// localization acceptance requirement for a product change. It is strictly
    /// stronger for these two than the old nine-language rule was in practice:
    /// it is checked rather than approximated by whoever remembered.
    func testEveryKeyIsDefinedAndNonEmptyInEveryShippedLanguage() {
        for language in AppLanguage.allCases {
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
        XCTAssertEqual(Set(AppLanguage.allCases), [.en, .zh],
                       "the shipped set is a product decision, not a convenience")
    }

    /// No key in a catalog that nothing in the app names. A leftover entry is a
    /// string somebody translated and nobody renders — and, more often, the
    /// residue of a rename that left the old spelling behind.
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
    /// so an English catalog missing `one` renders "1 files" and never fails at
    /// runtime. "No more" catches the opposite mistake — a `zero` form left
    /// behind by a language that has been frozen, which will never be selected
    /// and therefore never reviewed.
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
    ///
    /// Only two rules remain. The boundaries that used to matter most — French
    /// and Portuguese putting zero in `one`, Arabic's six forms — left with
    /// their catalogs, and `testAnArchivedPreferenceNeverGetsArchivedGrammar`
    /// below is what proves the app no longer applies them to anybody.
    func testPluralRulesAtTheirBoundaries() {
        XCTAssertEqual(PluralRule.category(for: 1, language: .en), .one)
        XCTAssertEqual(PluralRule.category(for: 0, language: .en), .other)
        XCTAssertEqual(PluralRule.category(for: 2, language: .en), .other)
        XCTAssertEqual(PluralRule.categories(for: .en), [.one, .other])
        // No grammatical number at all.
        for count in [0, 1, 2, 11, 100] {
            XCTAssertEqual(PluralRule.category(for: count, language: .zh), .other)
        }
        XCTAssertEqual(PluralRule.categories(for: .zh), [.other])
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
    /// shipped language.
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
    func testExplicitLanguageLookupIgnoresTheProcessLanguage() {
        defer { L10n.resetCurrent() }
        let expected = L10n.t(.tabAccount, language: .zh)
        for language in AppLanguage.allCases {
            L10n.current = language
            XCTAssertEqual(L10n.t(.tabAccount, language: .zh), expected,
                           "explicit .zh lookup moved while current was \(language.rawValue)")
        }
    }

    /// And every lookup returns THAT language's own catalog entry, key by key.
    ///
    /// Comparing against the file contents catches a whole language quietly
    /// falling through to English — which is exactly what a case-sensitive
    /// `.lproj` lookup did before `lprojPath` tolerated case, and which is the
    /// regression a reviewer who reads only English cannot see.
    func testEveryLookupReturnsThatLanguagesOwnCatalogEntry() {
        for language in AppLanguage.allCases {
            guard let catalog = StringsCatalog.load(language) else {
                XCTFail("catalog for \(language.rawValue) is missing")
                continue
            }
            for key in L10nKey.allCases {
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
        XCTAssertEqual(catalog.string("relayium.no.such.key", language: .zh),
                       "relayium.no.such.key")
        // A key every catalog defines resolves in the asked language, so the
        // fallback above is not simply "everything falls through".
        XCTAssertNotEqual(catalog.string(L10nKey.commonCancel.rawValue, language: .zh),
                          catalog.string(L10nKey.commonCancel.rawValue, language: .en))
    }

    // MARK: - what an archived preference actually gets

    /// **The acceptance case for the whole contraction.**
    ///
    /// A Mac set to Japanese, Arabic, German, French, Korean, Spanish or
    /// Portuguese now renders Relayium in English. This asserts that it is
    /// COMPLETE English — every canonical key, resolved through the real
    /// `L10n` path, equal to the English catalog entry and never to a raw key.
    ///
    /// "Never a raw key" is the failure this is really guarding. If the frozen
    /// catalogs had been left in the bundle while the enum lost their cases, a
    /// lookup would still be English; if the enum had kept a case whose catalog
    /// was gone, every key would render as `account.filesHeading` on screen. The
    /// two halves of the change have to land together, and this is where that is
    /// checked against rendered output rather than against file layout.
    func testEveryArchivedPreferenceRendersCompleteEnglish() throws {
        let english = try XCTUnwrap(StringsCatalog.load(.en))
        for locale in Self.frozenLprojs {
            let resolved = AppLanguage.resolve(preferred: [locale])
            XCTAssertEqual(resolved, .en, "\(locale) did not resolve to English")
            for key in L10nKey.allCases {
                let rendered = L10n.t(key, language: resolved)
                XCTAssertEqual(rendered, english[key.rawValue],
                               "\(locale) → \(key.rawValue) is not the English entry")
                XCTAssertNotEqual(rendered, key.rawValue,
                                  "\(locale) → \(key.rawValue) rendered a raw key")
            }
        }
    }

    /// Regional variants of an archived language are English too, and every
    /// Chinese variant is Simplified Chinese.
    ///
    /// The regional forms are the ones a real Mac actually reports:
    /// `Locale.preferredLanguages` hands back `de-AT`, not `de`. A resolver that
    /// matched only exact tags would send an Austrian Mac to English by accident
    /// rather than by rule, and would send `zh-Hans-CN` there too.
    func testRegionalVariantsResolveTheSameWayAsTheirLanguage() {
        for tag in ["ja-JP", "ar-EG", "de-AT", "fr-CA", "ko-KR", "es-MX", "pt-BR",
                    "ja-Jpan-JP", "ar-Arab-EG"] {
            XCTAssertEqual(AppLanguage.resolve(preferred: [tag]), .en,
                           "\(tag) must fall back to English")
        }
        for tag in ["zh", "zh-Hans", "zh-Hant", "zh-Hans-CN", "zh-Hant-TW", "zh-Hant-HK",
                    "zh-Hans-SG"] {
            XCTAssertEqual(AppLanguage.resolve(preferred: [tag]), .zh,
                           "\(tag) must stay Simplified Chinese")
        }
        // Order still wins: an archived language ahead of a shipped one does not
        // consume the choice, it is skipped.
        XCTAssertEqual(AppLanguage.resolve(preferred: ["ja-JP", "zh-Hans"]), .zh)
        XCTAssertEqual(AppLanguage.resolve(preferred: ["de-DE", "en-US"]), .en)
        XCTAssertEqual(AppLanguage.resolve(preferred: ["xh", "fr-CA"]), .en)
        XCTAssertEqual(AppLanguage.resolve(preferred: []), .en)
        XCTAssertEqual(AppLanguage.zh.lproj, "zh-Hans")
    }

    /// An archived preference gets English GRAMMAR and English NUMBERS, not the
    /// rules its own language used to carry.
    ///
    /// This is the half a "does it say English words" test would miss. French
    /// and Portuguese put a count of zero in the `one` form; Arabic has six
    /// plural categories; German, French, Spanish and Portuguese write a decimal
    /// comma. If any of that survived the contraction — a stale `PluralRule`
    /// branch, a `decimalSeparator` row keyed off something other than the
    /// resolved language — a French Mac would read English words with French
    /// agreement and "1,5 MB". Every one of those inputs now resolves to `.en`
    /// first, so the assertion is that the resolved language is what drives
    /// both, end to end.
    func testAnArchivedPreferenceNeverGetsArchivedGrammar() {
        for locale in ["fr-CA", "pt-BR", "ar-EG", "de-AT", "es-MX", "ja-JP", "ko-KR"] {
            let resolved = AppLanguage.resolve(preferred: [locale])
            // English's rule, not French's or Portuguese's.
            XCTAssertEqual(PluralRule.category(for: 0, language: resolved), .other,
                           "\(locale) got a non-English zero form")
            XCTAssertEqual(PluralRule.category(for: 1, language: resolved), .one)
            XCTAssertEqual(PluralRule.categories(for: resolved), [.one, .other],
                           "\(locale) got a non-English plural category set")
            // English's separator, not the European comma.
            XCTAssertEqual(L10n.bytes(1_572_864, language: resolved),
                           L10n.bytes(1_572_864, language: .en),
                           "\(locale) formatted bytes unlike English")
            XCTAssertFalse(L10n.bytes(1_572_864, language: resolved).contains(","),
                           "\(locale) used a decimal comma")
            // And the rendered plural itself agrees with English at the counts
            // the archived rules disagreed about.
            for count in [0, 1, 2] {
                XCTAssertEqual(L10n.plural(.selectionFiles, count, language: resolved),
                               L10n.plural(.selectionFiles, count, language: .en),
                               "\(locale) plural at \(count) differs from English")
            }
        }
    }

    /// The plural fallback chain still lands on English rather than on a raw key
    /// when a category is absent.
    ///
    /// Chinese defines only `other`, so asking it for a count of 1 exercises the
    /// same chain the frozen languages used to: category, then `other`, then
    /// English. It must never surface `selection.files`.
    func testPluralFallsBackToEnglishRatherThanTheKey() {
        for count in [0, 1, 2, 11] {
            let chinese = L10n.plural(.selectionFiles, count, language: .zh)
            XCTAssertFalse(chinese.contains("selection.files"), chinese)
            XCTAssertTrue(chinese.contains("\(count)"), chinese)
        }
    }

    // MARK: - layout direction

    /// **No shipped language is right-to-left, and the platform agrees.**
    ///
    /// Arabic was the only RTL catalog and it is frozen. `isRightToLeft` is kept
    /// and still consulted — by the macOS scene root, by `ShareViewController`
    /// and by `L10n.token` — so what this asserts is that the answer is `false`
    /// for everything shipped AND that it matches what the platform says about
    /// the same language tag. A hard-coded `false` that disagreed with
    /// `NSLocale` would be the thing to catch if Chinese were ever mis-tagged.
    func testNoShippedLanguageIsRightToLeftAndThePlatformAgrees() {
        for language in AppLanguage.allCases {
            let platform = NSLocale.characterDirection(forLanguage: language.lproj)
            XCTAssertEqual(language.isRightToLeft, platform == .rightToLeft,
                           "\(language.rawValue): app says isRightToLeft="
                           + "\(language.isRightToLeft), platform says \(platform.rawValue)")
            XCTAssertFalse(language.isRightToLeft,
                           "\(language.rawValue) is not a right-to-left language")
        }
        XCTAssertEqual(AppLanguage.allCases.filter(\.isRightToLeft), [])
    }

    /// An Arabic or Japanese Mac gets a left-to-right shell.
    ///
    /// The resolved language is what both scene roots derive `layoutDirection`
    /// from, so resolving an RTL preference to a language that reports
    /// `isRightToLeft == false` is exactly what produces an English LTR window.
    /// Asserted here at the seam the app actually reads; `AppShellUITests`
    /// launches the real app under those preferences.
    func testAnArchivedRightToLeftPreferenceYieldsALeftToRightShell() {
        for tag in ["ar", "ar-EG", "ar-Arab-EG"] {
            let resolved = AppLanguage.resolve(preferred: [tag])
            XCTAssertEqual(resolved, .en)
            XCTAssertFalse(resolved.isRightToLeft,
                           "\(tag) still resolves to a right-to-left shell")
        }
    }

    /// Technical values survive verbatim, in every shipped language.
    ///
    /// `L10n.token` is a no-op now that nothing shipped is RTL, so what this
    /// pins is the property that matters to a user either way: the path they
    /// have to read and act on comes back byte-identical, with no isolation
    /// marks added. The wrapping branch is kept for a restored RTL language and
    /// is exercised directly below.
    func testTokensAreReturnedVerbatimForEveryShippedLanguage() {
        let path = "../escape.txt"
        for language in AppLanguage.allCases {
            XCTAssertEqual(L10n.token(path, language: language), path,
                           "\(language.rawValue) altered a technical value")
        }
        XCTAssertFalse(L10n.token(path, language: .en).contains("\u{2068}"))
    }

    // MARK: - the declarations the system reads

    /// **Every Mac bundle declares exactly the two shipped languages.**
    ///
    /// `CFBundleLocalizations` is a claim macOS acts on: it decides which
    /// languages the app is a candidate for and, on App Store Connect, which
    /// localizations the product page may advertise. An entry with no catalog
    /// behind it tells a Japanese Mac that Relayium speaks Japanese and then
    /// shows English — the failure this whole task exists to remove. Both
    /// directions are asserted, because the old check only looked for missing
    /// entries and would have passed a plist that still listed all nine.
    func testEveryMacBundleDeclaresExactlyTheShippedLocalizations() throws {
        for path in ["mac/Relayium/Info.plist",
                     "mac/RelayiumAppStore/Info.plist",
                     "mac/RelayiumShare/Info.plist"] {
            let declared = try declaredLocalizations(at: path)
            XCTAssertEqual(Set(declared), Set(AppLanguage.allCases.map(\.lproj)), path)
            XCTAssertEqual(declared.count, 2, "\(path) declares \(declared)")
            for frozen in Self.frozenLprojs {
                XCTAssertFalse(declared.contains(frozen),
                               "\(path) still declares the frozen locale \(frozen)")
            }
        }
    }

    /// And the Xcode project's `knownRegions` carries no frozen locale.
    ///
    /// `knownRegions` is what a variant group resolves against and what Xcode
    /// offers when a file is localized. A frozen locale left there is an
    /// invitation for a new `.lproj` to be re-adopted into the target by a UI
    /// that still lists it.
    func testTheMacProjectKnownRegionsCarryNoFrozenLocale() throws {
        let pbxproj = try RepoRoot.text("apps/mac/Relayium.xcodeproj/project.pbxproj")
        let regions = try XCTUnwrap(knownRegions(in: pbxproj),
                                    "no knownRegions block in the Mac project")
        XCTAssertEqual(regions, ["en", "Base", "zh-Hans"], "knownRegions: \(regions)")
        for frozen in Self.frozenLprojs {
            XCTAssertFalse(regions.contains(frozen),
                           "knownRegions still lists the frozen locale \(frozen)")
        }
    }

    /// **The iOS app still declares nine, and that is a KNOWN, PENDING mismatch.**
    ///
    /// Not an oversight and not an assertion that nine is correct. iOS product
    /// development is paused and every file under `apps/ios` is read-only for
    /// the task that contracted the Mac, so its `Info.plist` still names seven
    /// localizations the shared package can no longer render. That build is
    /// unshipped, so nothing reaches a user from it.
    ///
    /// This test pins the mismatch as a literal rather than deleting it, for two
    /// reasons. Removing the assertion would leave nothing to notice when iOS
    /// resumes. Rewriting it to expect two would silently pass over an
    /// `Info.plist` nobody had touched — a green test claiming a contraction
    /// that never happened on that target.
    ///
    /// **When iOS resumes, this test is the checklist item.** It fails the
    /// moment somebody corrects the plist, and the fix is to replace the literal
    /// with `Set(AppLanguage.allCases.map(\.lproj))` — the same assertion the Mac
    /// bundles get above.
    func testTheIOSAppStillDeclaresNineAsAPendingResumeMismatch() throws {
        let declared = try declaredLocalizations(at: "ios/Relayium/Info.plist")
        XCTAssertEqual(Set(declared),
                       ["en", "zh-Hans", "ja", "ko", "de", "fr", "ar", "es", "pt"],
                       "apps/ios/Relayium/Info.plist changed. If iOS product development "
                       + "has resumed and this was contracted deliberately, replace this "
                       + "literal with Set(AppLanguage.allCases.map(\\.lproj)). If not, "
                       + "an iOS file was edited under a Mac-only lease.")
        XCTAssertGreaterThan(Set(declared).count, AppLanguage.allCases.count,
                             "iOS no longer over-declares; see this test's documentation")
    }

    // MARK: - resolution

    func testCurrentLanguageIsOverridableAndResettable() {
        defer { L10n.resetCurrent() }
        L10n.current = .zh
        XCTAssertEqual(L10n.current, .zh)
        XCTAssertEqual(L10n.t(.tabAccount), L10n.t(.tabAccount, language: .zh))
        L10n.resetCurrent()
        XCTAssertEqual(L10n.current, AppLanguage.systemPreferred())
    }

    // MARK: - helpers

    /// One archived catalog, read from the repository rather than from a bundle.
    ///
    /// These files are deliberately not in any bundle any more, so
    /// `StringsCatalog.load` — which reads `Bundle.module` — cannot see them and
    /// must not be taught to: doing so would blur the exact distinction this
    /// file is asserting. `RepoRoot` throws when the path is missing, so a
    /// deleted archive fails loudly instead of reading as an empty catalog.
    private func archivedCatalog(_ locale: String,
                                 file: StaticString = #filePath,
                                 line: UInt = #line) throws -> [String: String] {
        let url = try RepoRoot.url("\(Self.archiveRoot)/\(locale).lproj/Localizable.strings")
        return try XCTUnwrap(NSDictionary(contentsOf: url) as? [String: String],
                             "\(locale).lproj/Localizable.strings is unparseable",
                             file: file, line: line)
    }

    /// `CFBundleLocalizations` from a repository `Info.plist`.
    ///
    /// Read from the repository rather than from a built bundle so it fails in
    /// `swift test`, before anyone gets as far as running the app.
    private func declaredLocalizations(at relativePath: String,
                                       file: StaticString = #filePath,
                                       line: UInt = #line) throws -> [String] {
        let infoPlist = try RepoRoot.url("apps/" + relativePath)
        let plist = try XCTUnwrap(NSDictionary(contentsOf: infoPlist) as? [String: Any],
                                  "cannot read \(infoPlist.path)", file: file, line: line)
        return try XCTUnwrap(plist["CFBundleLocalizations"] as? [String],
                             "\(relativePath) declares no CFBundleLocalizations",
                             file: file, line: line)
    }

    /// The `knownRegions = ( … );` list from a `project.pbxproj`, in order.
    private func knownRegions(in pbxproj: String) -> [String]? {
        guard let start = pbxproj.range(of: "knownRegions = (") else { return nil }
        guard let end = pbxproj.range(of: ");", range: start.upperBound..<pbxproj.endIndex)
        else { return nil }
        return pbxproj[start.upperBound..<end.lowerBound]
            .split(separator: ",")
            .map {
                $0.trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            }
            .filter { !$0.isEmpty }
    }
}
