import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// The help table, checked for the three things a hand-written set of five
/// SwiftUI blocks could not be checked for: that every browseable destination
/// has help, that the hidden one does not pretend to, and that no guide link
/// points somewhere the site does not publish.
final class HelpPresentationTests: XCTestCase {

    /// The site's own guide slugs, taken from what `web/public` actually
    /// publishes. A link to a slug that is not here is a 404 shipped in every
    /// language.
    private let publishedGuides: Set<String> = [
        "back-up-a-server-over-ssh",
        "bring-your-own-node",
        "device-inbox-server",
        "how-relayium-encrypts-your-files",
        "is-it-safe-to-send-files-over-the-internet",
        "push-to-cloud-pull-on-another-computer",
        "receive-files-from-the-command-line",
        "run-relayium-as-an-always-on-service",
        "self-host-relayium",
        "send-a-file-to-someone",
        "server-to-server-transfers",
        "sync-a-large-folder-between-servers",
        "transfer-files-from-terminal",
        "what-is-peer-to-peer-file-transfer",
    ]

    // MARK: - coverage

    func testEveryBrowseableDestinationOffersHelp() {
        for surface in MacSurface.browseable {
            XCTAssertNotNil(HelpPresentation.topic(for: surface),
                            "\(surface.rawValue) is a browseable screen with no help under it")
        }
    }

    /// The hidden one, asserted as an absence. Stored receive is reached only
    /// when the OS or an account row hands this app a link the user already has,
    /// so a tutorial explaining how to get there would be read only by somebody
    /// who had already done it.
    func testTheHiddenDeepLinkOnlyDestinationOffersNone() {
        XCTAssertNil(HelpPresentation.topic(for: .storedReceive))
        XCTAssertFalse(MacSurface.storedReceive.isBrowseable,
                       "this test is only meaningful while that surface stays hidden")
    }

    /// Three steps everywhere, and no two destinations sharing a string. A
    /// copy-pasted topic is the failure this catches: it compiles, it renders,
    /// and it tells the user about the wrong screen.
    func testEveryTopicHasThreeStepsAndKeysNoOtherTopicUses() {
        var seen = Set<String>()
        for surface in MacSurface.allCases {
            guard let topic = HelpPresentation.topic(for: surface) else { continue }
            XCTAssertEqual(topic.steps.count, 3, "\(surface.rawValue)")
            for key in Self.allKeys(of: topic) {
                XCTAssertTrue(seen.insert(key.rawValue).inserted,
                              "\(key.rawValue) is used by two destinations")
            }
        }
    }

    /// **Every screen answers all six, and none of them is a copy of another.**
    ///
    /// The shape is the whole point of `HelpTopic` being a struct with named
    /// fields rather than a bag of paragraphs: a topic that answers what the
    /// screen is for and how to use it, and then says nothing about the
    /// boundary, the destination or the dead end, is exactly the help this batch
    /// replaced — and it would compile.
    func testEveryTopicAnswersAllSixQuestions() {
        for surface in MacSurface.browseable {
            guard let topic = HelpPresentation.topic(for: surface) else {
                return XCTFail("\(surface.rawValue) has no topic at all")
            }
            // Distinct KEYS, not merely non-empty ones: the way this degrades is
            // one paragraph doing duty for two questions.
            let keys = Self.allKeys(of: topic).map(\.rawValue)
            XCTAssertEqual(Set(keys).count, keys.count,
                           "\(surface.rawValue) answers two questions with one string")
            // Six answers, one of which — the path — is three numbered steps.
            XCTAssertEqual(keys.count, 8, "\(surface.rawValue) is not the six-answer shape")
            // And each one is real English rather than a placeholder somebody
            // meant to come back to.
            for key in Self.allKeys(of: topic) {
                let text = L10n.t(key, language: .en)
                XCTAssertGreaterThan(text.count, 20,
                                     "\(key.rawValue) is too short to be an answer: \(text)")
            }
        }
    }

    /// The purpose is the only part that renders collapsed, so it is the only
    /// part that has to work as a standalone line — short enough for a button
    /// row, and a sentence rather than a fragment.
    func testThePurposeIsALineAButtonRowCanCarry() {
        for surface in MacSurface.browseable {
            guard let purpose = HelpPresentation.topic(for: surface)?.purpose else { continue }
            for language in [AppLanguage.en, .zh] {
                let text = L10n.t(purpose, language: language)
                XCTAssertLessThanOrEqual(text.count, 160,
                                         "\(purpose.rawValue) [\(language.rawValue)] is a "
                                         + "paragraph, and it renders on a collapsed row: \(text)")
                XCTAssertFalse(text.hasSuffix(":"),
                               "\(purpose.rawValue) [\(language.rawValue)] is a lead-in rather "
                               + "than an answer")
            }
        }
    }

    /// Every key resolves to real copy in both shipped languages, and none of it
    /// is the raw key falling through.
    ///
    /// **Scope: the two shipped catalogs, and only those.** The loop below walks
    /// `AppLanguage.allCases`, which is `en` and `zh` — so what this proves is
    /// that every help key exists and is translated in both, and that no raw
    /// `help.lan.boundary` reaches somebody's screen in either.
    ///
    /// It says nothing about the seven archived languages, because it cannot:
    /// they are no longer `AppLanguage` values and this loop never asks for one.
    /// That an archived preference renders COMPLETE English rather than a raw
    /// key is a real guarantee, and it is pinned where it can actually be
    /// exercised — `LocalizationIntegrityTests.testEveryArchivedPreferenceRendersCompleteEnglish`,
    /// which resolves each archived tag and compares every canonical key against
    /// the English catalog.
    func testEveryHelpStringExistsInEveryLanguage() {
        for surface in MacSurface.allCases {
            guard let topic = HelpPresentation.topic(for: surface) else { continue }
            for key in Self.allKeys(of: topic) {
                for language in AppLanguage.allCases {
                    let text = L10n.t(key, language: language)
                    XCTAssertFalse(text.isEmpty, "\(key.rawValue) is empty in \(language)")
                    XCTAssertNotEqual(text, key.rawValue,
                                      "\(key.rawValue) falls through to its key in \(language)")
                }
            }
        }
        for shared in [L10nKey.helpHeading, .helpStepsHeading, .helpBoundaryHeading,
                       .helpWhereHeading, .helpTroubleHeading, .helpGuideLink,
                       .helpCollapsedValue, .helpExpandedValue,
                       .helpExpandHint, .helpCollapseHint] {
            for language in AppLanguage.allCases {
                XCTAssertNotEqual(L10n.t(shared, language: language), shared.rawValue,
                                  "\(shared.rawValue) is missing in \(language)")
            }
        }
    }

    /// Both maintained languages carry every help string as their OWN copy
    /// rather than through the English fallback. This is the localization gate
    /// for this batch's new copy, asserted against the catalogs rather than
    /// against what renders.
    func testBothMaintainedLanguagesDefineEveryHelpStringThemselves() throws {
        for language in [AppLanguage.en, .zh] {
            let catalog = try XCTUnwrap(StringsCatalog.load(language),
                                        "catalog for \(language.rawValue) is missing")
            for surface in MacSurface.allCases {
                guard let topic = HelpPresentation.topic(for: surface) else { continue }
                for key in Self.allKeys(of: topic) {
                    XCTAssertNotNil(catalog[key.rawValue],
                                    "\(language.rawValue) does not define \(key.rawValue)")
                }
            }
        }
    }

    /// Every string one topic owns, in the order the screen renders them.
    private static func allKeys(of topic: HelpTopic) -> [L10nKey] {
        [topic.purpose] + topic.steps
            + [topic.boundary, topic.destination, topic.failure, topic.recovery]
    }

    /// The numbered-step format positions the numeral and its separator in the
    /// catalog rather than in the view, so it must actually take both arguments.
    func testTheStepFormatCarriesBothTheNumberAndTheStep() {
        for language in AppLanguage.allCases {
            let rendered = L10n.t(.formatHelpStep, ["2", "Pick a device"], language: language)
            XCTAssertTrue(rendered.contains("2"), "\(language) drops the step number")
            XCTAssertTrue(rendered.contains("Pick a device"), "\(language) drops the step")
        }
    }

    // MARK: - the links are real

    /// Every localized guide is one the site actually publishes.
    func testEveryLinkedGuideSlugIsOneTheSitePublishes() {
        for surface in MacSurface.allCases {
            guard case let .localizedGuide(slug)? = HelpPresentation.topic(for: surface)?.guide
            else { continue }
            XCTAssertTrue(publishedGuides.contains(slug),
                          "\(surface.rawValue) links to a guide that is not published: \(slug)")
        }
    }

    /// …and the page each LINK actually resolves to is on disk, checked against
    /// the repository rather than against the list above.
    ///
    /// It walks both shipped app languages and asserts on the URL the app would
    /// build for each, which is the thing that can 404. So exactly two URL forms
    /// are checked here: the unprefixed English page, and the `/zh/` one.
    ///
    /// **No archived locale reaches this API to be checked.** An archived
    /// preference has already become `.en` in `AppLanguage.resolve(preferred:)`,
    /// before any caller gets as far as building a help URL — so there is no
    /// frozen-locale case for this loop to pass or fail. That resolution is
    /// pinned in `LocalizationIntegrityTests`
    /// (`testRegionalVariantsResolveTheSameWayAsTheirLanguage`), and the rule
    /// that a restored locale must not be sent to an archived translation is
    /// pinned directly below in
    /// `testEveryShippedLanguageLinksToItsOwnGuideAndArchivedPreferencesGetEnglish`.
    /// What this test still catches is the maintained-language rule generating a
    /// prefix the site does not publish.
    func testEveryGuideLinkResolvesToAPageOnDisk() throws {
        for surface in MacSurface.allCases {
            guard case let .localizedGuide(slug)? = HelpPresentation.topic(for: surface)?.guide
            else { continue }
            for language in AppLanguage.allCases {
                let url = HelpPresentation.url(for: .localizedGuide(slug: slug),
                                               language: language)
                let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                let page = "web/public/" + path + "/index.html"
                XCTAssertNoThrow(try RepoRoot.url(page),
                                 "\(slug) link for \(language.rawValue) points at nothing: "
                                 + page)
            }
        }
    }

    /// **Every shipped language gets its own guide, and an archived preference
    /// gets the English one.**
    ///
    /// Two halves, and they are reached by different routes, which is the whole
    /// point of asserting both here.
    ///
    /// The first half is direct: each `AppLanguage` maps to one URL — English at
    /// the root, every other shipped language under its `rawValue` prefix. There
    /// is no second language list any more. `HelpPresentation` used to keep a
    /// `maintainedGuideLanguages` pair and send anything outside it to English;
    /// once `AppLanguage` contracted to the shipped set those became the same
    /// set, so the membership test was always true and that branch was
    /// unreachable. It is gone, and this asserts what replaced it.
    ///
    /// The second half is the one that branch was *for*, and it still has to
    /// hold — it just happens earlier now. A Mac set to Japanese or Arabic
    /// resolves to `.en` in `AppLanguage.resolve(preferred:)` before any caller
    /// builds a URL, so those tags are exercised here through the resolver
    /// rather than through a language value that no longer exists. The claim is
    /// unchanged: an app already rendering English copy must not be the one
    /// place that links to a translation nobody is updating.
    ///
    /// **Fail-closed.** The switch below is exhaustive with no `default`, so
    /// adding an `AppLanguage` case without stating its URL here does not
    /// compile. That is deliberate — a new case silently inheriting a default
    /// would generate `/<lang>/guides/…` against a prefix the site may not
    /// publish, which is a 404 shipped to exactly the readers the new language
    /// was added for.
    func testEveryShippedLanguageLinksToItsOwnGuideAndArchivedPreferencesGetEnglish() {
        let slug = "send-a-file-to-someone"
        let english = "https://relayium.com/guides/\(slug)"

        for language in AppLanguage.allCases {
            let url = HelpPresentation.url(for: .localizedGuide(slug: slug),
                                           language: language).absoluteString
            // No `default`: a new case must state its URL here or fail to build.
            switch language {
            case .en:
                XCTAssertEqual(url, english)
            case .zh:
                XCTAssertEqual(url, "https://relayium.com/zh/guides/\(slug)")
            }
        }

        // The archived tags, driven through the real resolver. Regional forms
        // included because that is what `Locale.preferredLanguages` hands back.
        for tag in ["ja", "ko", "de", "fr", "ar", "es", "pt",
                    "ja-JP", "ar-EG", "de-AT", "fr-CA", "pt-BR"] {
            let resolved = AppLanguage.resolve(preferred: [tag])
            XCTAssertEqual(resolved, .en, "\(tag) no longer resolves to English")
            XCTAssertEqual(HelpPresentation.url(for: .localizedGuide(slug: slug),
                                                language: resolved).absoluteString,
                           english,
                           "\(tag) was sent to an archived translation as though it were "
                           + "current")
        }

        // And a Chinese preference is NOT swept into English by the above: the
        // archived assertion would still pass if everything resolved to `.en`.
        XCTAssertEqual(HelpPresentation.url(
            for: .localizedGuide(slug: slug),
            language: AppLanguage.resolve(preferred: ["zh-Hant-TW"])).absoluteString,
                       "https://relayium.com/zh/guides/\(slug)")
    }

    /// The English-only pages get no language prefix, because the site does not
    /// publish one — generating `/ar/device-inbox` would be a 404.
    func testAnEnglishOnlyPageNeverGainsALanguagePrefix() {
        for language in AppLanguage.allCases {
            let url = HelpPresentation.url(for: .englishPage(path: "device-inbox"),
                                           language: language)
            XCTAssertEqual(url.absoluteString, "https://relayium.com/device-inbox",
                           "\(language) invented a localized path for an English-only page")
        }
    }

    /// English lives at the root and a maintained translation under its own
    /// prefix — the site's rule, mirrored. The prefix is the Relayium language
    /// id, so Chinese is `zh` and never the `zh-Hans` that names the resource
    /// bundle.
    func testALocalizedGuideURLMatchesTheSitesOwnLayout() {
        XCTAssertEqual(HelpPresentation.url(for: .localizedGuide(slug: "send-a-file-to-someone"),
                                            language: .en).absoluteString,
                       "https://relayium.com/guides/send-a-file-to-someone")
        XCTAssertEqual(HelpPresentation.url(for: .localizedGuide(slug: "send-a-file-to-someone"),
                                            language: .zh).absoluteString,
                       "https://relayium.com/zh/guides/send-a-file-to-someone")
    }

    /// A guide link is a promise, so the Account screen — which has no document
    /// answering its question — makes none. Asserted rather than left implicit,
    /// because "add a learn-more to every screen" is the obvious tidy-up and the
    /// only page it could point at is the web account page this app deliberately
    /// does not send people to.
    func testTheAccountScreenLinksNoGuideBecauseNoneExists() {
        XCTAssertNil(HelpPresentation.topic(for: .account)?.guide)
    }

    /// Every guide link resolves against the injected origin, so a self-hosted
    /// build does not send its users to relayium.com.
    func testGuideURLsAreBuiltFromTheGivenOrigin() {
        let hosted = URL(string: "https://files.example.org")!
        XCTAssertEqual(HelpPresentation.url(for: .localizedGuide(slug: "x"),
                                            language: .zh, baseURL: hosted).absoluteString,
                       "https://files.example.org/zh/guides/x")
        // An English-only page ignores the language entirely, so it is asserted
        // with a language that is NOT English — otherwise the test would pass on
        // a `.localizedGuide` regression that simply happened to produce `/cli`.
        XCTAssertEqual(HelpPresentation.url(for: .englishPage(path: "cli"),
                                            language: .zh, baseURL: hosted).absoluteString,
                       "https://files.example.org/cli")
    }

    /// The CLI page the stored-send result links to is a real route, and one the
    /// site keeps English-only beside `/pricing`.
    func testTheCLIPageIsTheSiteRoute() throws {
        XCTAssertEqual(AppEnvironment.cliWebURL.absoluteString, "https://relayium.com/cli")
        let router = try RepoRoot.text("web/src/lib/router.svelte.ts")
        XCTAssertTrue(router.contains("CLI_PATH = \"/cli\""),
                      "the app links to a path the web router no longer serves")
    }
}
