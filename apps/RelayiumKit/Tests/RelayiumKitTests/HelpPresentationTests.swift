import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// The help table, checked for the three things a hand-written set of five
/// SwiftUI blocks could not be checked for: that every browseable destination
/// has help, that the hidden one does not pretend to, and that no guide link
/// points somewhere the site does not publish.
final class HelpPresentationTests: XCTestCase {

    /// The site's own guide slugs, taken from what `web/public` actually
    /// publishes. A link to a slug that is not here is a 404 shipped in nine
    /// languages.
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

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { url, _ in
            url.deletingLastPathComponent()
        }
    }

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
            for key in topic.steps + [topic.question, topic.answer] {
                XCTAssertTrue(seen.insert(key.rawValue).inserted,
                              "\(key.rawValue) is used by two destinations")
            }
        }
    }

    /// Every key resolves to real copy in every one of the nine languages, and
    /// none of it is the raw key falling through.
    func testEveryHelpStringExistsInEveryLanguage() {
        for surface in MacSurface.allCases {
            guard let topic = HelpPresentation.topic(for: surface) else { continue }
            for key in topic.steps + [topic.question, topic.answer] {
                for language in AppLanguage.allCases {
                    let text = L10n.t(key, language: language)
                    XCTAssertFalse(text.isEmpty, "\(key.rawValue) is empty in \(language)")
                    XCTAssertNotEqual(text, key.rawValue,
                                      "\(key.rawValue) falls through to its key in \(language)")
                }
            }
        }
        for shared in [L10nKey.helpHeading, .helpStepsHeading, .helpGuideLink] {
            for language in AppLanguage.allCases {
                XCTAssertNotEqual(L10n.t(shared, language: language), shared.rawValue,
                                  "\(shared.rawValue) is missing in \(language)")
            }
        }
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

    /// …and it is on disk in all nine languages, checked against the repository
    /// rather than against the list above — a slug can be published in English
    /// and missing in Arabic, which is exactly the failure a per-language URL
    /// creates and a hard-coded list would not notice.
    func testEveryLinkedGuideExistsOnDiskInAllNineLanguages() throws {
        for surface in MacSurface.allCases {
            guard case let .localizedGuide(slug)? = HelpPresentation.topic(for: surface)?.guide
            else { continue }
            for language in AppLanguage.allCases {
                let prefix = language == .en ? "" : language.rawValue + "/"
                let page = repoRoot.appendingPathComponent(
                    "web/public/" + prefix + "guides/" + slug + "/index.html")
                XCTAssertTrue(FileManager.default.fileExists(atPath: page.path),
                              "\(slug) is not published in \(language.rawValue): \(page.path)")
            }
        }
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

    /// English lives at the root and every other language under its own prefix —
    /// the site's rule, mirrored. The prefix is the Relayium language id, so
    /// Chinese is `zh` and never the `zh-Hans` that names the resource bundle.
    func testALocalizedGuideURLMatchesTheSitesOwnLayout() {
        XCTAssertEqual(HelpPresentation.url(for: .localizedGuide(slug: "send-a-file-to-someone"),
                                            language: .en).absoluteString,
                       "https://relayium.com/guides/send-a-file-to-someone")
        XCTAssertEqual(HelpPresentation.url(for: .localizedGuide(slug: "send-a-file-to-someone"),
                                            language: .zh).absoluteString,
                       "https://relayium.com/zh/guides/send-a-file-to-someone")
        XCTAssertEqual(HelpPresentation.url(for: .localizedGuide(slug: "send-a-file-to-someone"),
                                            language: .ar).absoluteString,
                       "https://relayium.com/ar/guides/send-a-file-to-someone")
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
                                            language: .de, baseURL: hosted).absoluteString,
                       "https://files.example.org/de/guides/x")
        XCTAssertEqual(HelpPresentation.url(for: .englishPage(path: "cli"),
                                            language: .de, baseURL: hosted).absoluteString,
                       "https://files.example.org/cli")
    }

    /// The CLI page the stored-send result links to is a real route, and one the
    /// site keeps English-only beside `/pricing`.
    func testTheCLIPageIsTheSiteRoute() throws {
        XCTAssertEqual(AppEnvironment.cliWebURL.absoluteString, "https://relayium.com/cli")
        let router = try String(
            contentsOf: repoRoot.appendingPathComponent("web/src/lib/router.svelte.ts"),
            encoding: .utf8)
        XCTAssertTrue(router.contains("CLI_PATH = \"/cli\""),
                      "the app links to a path the web router no longer serves")
    }
}
