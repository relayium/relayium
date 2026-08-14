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
    /// A guide under `/guides/<slug>`. English lives at the root; a MAINTAINED
    /// translation lives under `/<language>/`.
    ///
    /// The seven frozen locales deliberately do not get their own prefix — see
    /// `HelpPresentation.url`.
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

    /// **The languages this app will send a reader to a guide in.**
    ///
    /// English is the source and the fallback; Simplified Chinese is maintained
    /// beside it. That is the owner's supported-language decision (2026-08-14),
    /// and `LocalizationIntegrityTests` holds the same pair for the catalogs.
    ///
    /// It is repeated here rather than imported because it decides a different
    /// thing — where a link POINTS, not which words render — and the two could
    /// legitimately diverge if a locale were restored one half at a time.
    static let maintainedGuideLanguages: Set<AppLanguage> = [.en, .zh]

    /// The URL a guide link opens, in the language the app can honestly offer.
    ///
    /// Mirrors the site's own rule (`web/src/lib/OfflinePage.svelte`): English
    /// lives at the root and a translation under its own prefix. The prefix is
    /// the *Relayium* language id — `zh`, not the `zh-Hans` that names the Apple
    /// resource directory — which is why it comes from `rawValue` rather than
    /// from `lproj`.
    ///
    /// **A frozen locale gets the English guide, deliberately.** Those seven
    /// translations are still published and still reachable, but they are
    /// archives: they describe the product as it was when the locale was frozen,
    /// and the site labels them as archived translations rather than removing
    /// them. An app running in one of them is already rendering new copy in
    /// English through the catalog fallback, so a "read the guide" link that
    /// silently swapped in a page nobody is updating would be the one place this
    /// app promised current documentation it does not have. Linking the
    /// maintained page instead is the same promise the rest of the screen makes.
    ///
    /// Restoring a locale is one edit here and one in the catalogs, in that
    /// order or either, and neither is a code change anywhere else.
    public static func url(for guide: HelpGuide,
                           language: AppLanguage,
                           baseURL: URL = AppEnvironment.productionBaseURL) -> URL {
        switch guide {
        case let .localizedGuide(slug):
            let maintained = maintainedGuideLanguages.contains(language) ? language : .en
            let prefix = maintained == .en ? "" : maintained.rawValue + "/"
            // nonlocalized: a URL path, not user copy
            return baseURL.appendingPathComponent(prefix + "guides/" + slug)
        case let .englishPage(path):
            return baseURL.appendingPathComponent(path)
        }
    }
}
