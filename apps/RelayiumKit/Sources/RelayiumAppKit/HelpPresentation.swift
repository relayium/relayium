import Foundation
import RelayiumShareKit

/// **What each browseable macOS destination teaches, below the thing it does.**
///
/// The owner's report was that a screen tells you what it is and gives you the
/// controls, and then stops: someone who does not already know what a pairing
/// code is, or what happens to a file after it is sent, has nowhere to find out
/// without leaving the app. Every destination now answers the same six questions
/// — see `HelpTopic` — and, where a maintained document actually exists, links
/// to it.
///
/// ## Why this is a table and not five views
///
/// Three properties are worth being able to check rather than eyeball: that
/// every browseable surface has help, that the hidden one does not pretend to,
/// and that no destination links to a page that is not there. A table of keys is
/// checkable; five hand-written SwiftUI blocks are not. The fixed `HelpTopic`
/// shape adds a fourth: a screen cannot quietly answer four of the six.
///
/// ## Why the guide link is optional
///
/// Because it is a promise. `relayium.com/guides/…` is a maintained document and
/// `/device-inbox` is a real product page. The Account screen has neither, so it
/// gets none — an invented "learn more" pointing at a page that does not answer
/// the question is worse than the honest absence of one. Which LANGUAGE of a
/// guide may be promised is the same question one level down, and `url` answers
/// it.

/// Something a reader can go and read.
public enum HelpGuide: Equatable, Sendable {
    /// A guide under `/guides/<slug>`. English lives at the root; every other
    /// shipped language lives under `/<language>/`.
    ///
    /// The seven archived locales never reach this: an archived OS preference
    /// resolves to `.en` before a URL is built — see `HelpPresentation.url`.
    case localizedGuide(slug: String)
    /// A product page that exists in English only — the site's own decision, and
    /// one this app must not paper over by generating a URL that 404s.
    case englishPage(path: String)
}

/// **One destination's help: six answers, in the order somebody needs them.**
///
/// It was three steps and one question, which is enough to be a caption and not
/// enough to be help. Somebody who does not already know what this screen does
/// reads the steps, follows them, and then has nowhere to go for the three
/// questions that actually stop them — what can Relayium see, where did my file
/// end up, and why did nothing happen. Those are not advanced questions; they
/// are the first three.
///
/// So a topic is a fixed shape rather than free prose, and the shape is the
/// checklist:
///
///  1. `purpose` — what this screen is for, in one sentence. It is the ONLY part
///     that is always on screen, so it is the one that has to earn its line.
///  2. `steps` — the shortest path that actually works. Still three, everywhere,
///     because a fourth step is nearly always a branch and a branch belongs in a
///     guide.
///  3. `boundary` — what Relayium can and cannot see. Every screen has an
///     answer and none of them is "trust us".
///  4. `destination` — where the files or the messages end up, or where they
///     stay, or when they stop existing.
///  5. `failure` — the thing that actually goes wrong. Named plainly, including
///     when the cause is somebody's router or somebody's spent allowance.
///  6. `recovery` — and what to do about it, which is the part a screen full of
///     disabled controls cannot say for itself.
///
/// The `question`/`answer` pair this replaces is not lost: each one became the
/// `boundary` of its own screen, which is where readers were looking for it.
public struct HelpTopic: Equatable, Sendable {
    public let purpose: L10nKey
    public let steps: [L10nKey]
    public let boundary: L10nKey
    public let destination: L10nKey
    public let failure: L10nKey
    public let recovery: L10nKey
    public let guide: HelpGuide?
}

public enum HelpPresentation {

    /// The help a surface offers, or nil for one that offers none.
    ///
    /// `storedReceive` is the nil, and deliberately: it is not browseable. It is
    /// reached only when the OS or an account row hands this app a link the user
    /// already has, so a tutorial explaining how to get there would be read only
    /// by somebody who had already done it.
    public static func topic(for surface: MacSurface) -> HelpTopic? {
        switch surface {
        case .lanTransfer:
            return HelpTopic(
                purpose: .helpLanPurpose,
                steps: [.helpLanStep1, .helpLanStep2, .helpLanStep3],
                boundary: .helpLanBoundary,
                destination: .helpLanWhere,
                failure: .helpLanFailure,
                recovery: .helpLanRecovery,
                // nonlocalized: a URL path slug, generated per language by the site
                guide: .localizedGuide(slug: "what-is-peer-to-peer-file-transfer"))
        case .crossNetworkTransfer:
            return HelpTopic(
                purpose: .helpCrossPurpose,
                steps: [.helpCrossStep1, .helpCrossStep2, .helpCrossStep3],
                boundary: .helpCrossBoundary,
                destination: .helpCrossWhere,
                failure: .helpCrossFailure,
                recovery: .helpCrossRecovery,
                // nonlocalized: a URL path slug, generated per language by the site
                guide: .localizedGuide(slug: "send-a-file-to-someone"))
        case .storedSend:
            return HelpTopic(
                purpose: .helpStoredSendPurpose,
                steps: [.helpStoredSendStep1, .helpStoredSendStep2, .helpStoredSendStep3],
                boundary: .helpStoredSendBoundary,
                destination: .helpStoredSendWhere,
                failure: .helpStoredSendFailure,
                recovery: .helpStoredSendRecovery,
                // nonlocalized: a URL path slug, generated per language by the site
                guide: .localizedGuide(slug: "push-to-cloud-pull-on-another-computer"))
        case .deviceInbox:
            return HelpTopic(
                purpose: .helpInboxPurpose,
                steps: [.helpInboxStep1, .helpInboxStep2, .helpInboxStep3],
                boundary: .helpInboxBoundary,
                destination: .helpInboxWhere,
                failure: .helpInboxFailure,
                recovery: .helpInboxRecovery,
                // The feature's own page, which the site publishes in English
                // only. See `HelpGuide.englishPage`.
                // nonlocalized: a URL path, not user copy
                guide: .englishPage(path: "device-inbox"))
        case .account:
            // No guide. Plans, devices and stored files are account state rather
            // than a workflow with a document behind it, and the one page that
            // could be linked here is the web account page this app deliberately
            // does not send people to.
            return HelpTopic(
                purpose: .helpAccountPurpose,
                steps: [.helpAccountStep1, .helpAccountStep2, .helpAccountStep3],
                boundary: .helpAccountBoundary,
                destination: .helpAccountWhere,
                failure: .helpAccountFailure,
                recovery: .helpAccountRecovery,
                guide: nil)
        case .storedReceive:
            return nil
        }
    }

    /// The URL a guide link opens.
    ///
    /// Mirrors the site's own rule (`web/src/lib/OfflinePage.svelte`): English
    /// lives at the root and every other language under its own prefix. The
    /// prefix is the *Relayium* language id — `zh`, not the `zh-Hans` that names
    /// the Apple resource directory — which is why it comes from `rawValue`
    /// rather than from `lproj`.
    ///
    /// **`AppLanguage` is the only language set consulted, and every case gets a
    /// direct answer.** There used to be a second one here — a
    /// `maintainedGuideLanguages` pair, plus a branch sending anything outside it
    /// to English — from when the app shipped nine languages and linked guides in
    /// two. Once `AppLanguage` contracted to the shipped set those became the
    /// same set, the membership test was always true, and the fallback was
    /// unreachable code asserting a distinction that no longer existed. A second
    /// en/zh list is drift, not policy: it can only ever disagree with
    /// `AppLanguage` by being stale.
    ///
    /// **An archived locale still gets the English guide** — it just gets there
    /// earlier, and once. Those seven translations are still published and still
    /// reachable, but they are archives: they describe the product as it was when
    /// the locale was frozen, and the site labels them as archived rather than
    /// removing them. A Mac set to one of them has already resolved to `.en` in
    /// `AppLanguage.resolve(preferred:)` before any caller reaches this function,
    /// so it is rendering English copy AND opening the maintained English guide.
    /// A link that silently swapped in a page nobody is updating would be the one
    /// place this app promised current documentation it does not have.
    ///
    /// What removing the second list buys is narrow, and worth stating exactly:
    /// **this function needs no language-list edit of its own.** Once a case is
    /// back in `AppLanguage` it immediately gets `/<rawValue>/` here, with no
    /// parallel set to remember to update — which was the whole failure mode of
    /// the pair this replaced.
    ///
    /// That is not the same as restoring a locale being cheap. Full restoration
    /// follows the checklist in `apps/RelayiumKit/LocalizationArchive/README.md`:
    /// re-translating the catalog to the current `L10nKey` set, restoring the
    /// language's CLDR plural rules, declaring it in the Mac bundles and
    /// `knownRegions`, RTL support where the language needs it, and
    /// native-speaker review with layout, accessibility and regression passes.
    ///
    /// One requirement is this function's alone, and it is not on that list:
    /// **the site must publish a maintained guide at that prefix.** The URL is
    /// generated unconditionally, so a locale restored in the app while the site
    /// still has only an archived translation — or none — turns every guide link
    /// into a stale page or a 404. `HelpPresentationTests` is what catches it:
    /// it checks every generated URL against a page that actually exists on
    /// disk.
    public static func url(for guide: HelpGuide,
                           language: AppLanguage,
                           baseURL: URL = AppEnvironment.productionBaseURL) -> URL {
        switch guide {
        case let .localizedGuide(slug):
            // English at the root, every other shipped language under its id.
            let prefix = language == .en ? "" : language.rawValue + "/"
            // nonlocalized: a URL path, not user copy
            return baseURL.appendingPathComponent(prefix + "guides/" + slug)
        case let .englishPage(path):
            return baseURL.appendingPathComponent(path)
        }
    }
}
