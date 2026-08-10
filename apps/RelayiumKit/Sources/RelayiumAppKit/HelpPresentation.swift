import Foundation
import RelayiumShareKit

/// **What each browseable macOS destination teaches, below the thing it does.**
///
/// The owner's report was that a screen tells you what it is and gives you the
/// controls, and then stops: someone who does not already know what a pairing
/// code is, or what happens to a file after it is sent, has nowhere to find out
/// without leaving the app. Every destination now ends with a short tutorial and
/// one common question, and — where a maintained document actually exists — a
/// link to it.
///
/// ## Why this is a table and not five views
///
/// Three properties are worth being able to check rather than eyeball: that
/// every browseable surface has help, that the hidden one does not pretend to,
/// and that no destination links to a page that is not there. A table of keys is
/// checkable; five hand-written SwiftUI blocks are not.
///
/// ## Why the guide link is optional
///
/// Because it is a promise. `relayium.com/guides/…` is generated and maintained
/// in nine languages; `/device-inbox` is a real product page. The Account screen
/// has neither, so it gets none — an invented "learn more" pointing at a page
/// that does not answer the question is worse than the honest absence of one.

/// Something a reader can go and read.
public enum HelpGuide: Equatable, Sendable {
    /// A guide under `/guides/<slug>`, which the site publishes in all nine
    /// languages: English at the root, everything else under `/<language>/`.
    case localizedGuide(slug: String)
    /// A product page that exists in English only — the site's own decision, and
    /// one this app must not paper over by generating a URL that 404s.
    case englishPage(path: String)
}

/// One destination's help: a compact tutorial, one question, and maybe a guide.
public struct HelpTopic: Equatable, Sendable {
    /// Ordered steps. Three, everywhere, because the point is to be readable at
    /// a glance under the controls rather than to be a manual — and because
    /// every string here is nine translations.
    public let steps: [L10nKey]
    public let question: L10nKey
    public let answer: L10nKey
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
                steps: [.helpLanStep1, .helpLanStep2, .helpLanStep3],
                question: .helpLanQuestion, answer: .helpLanAnswer,
                // nonlocalized: a URL path slug, generated per language by the site
                guide: .localizedGuide(slug: "what-is-peer-to-peer-file-transfer"))
        case .crossNetworkTransfer:
            return HelpTopic(
                steps: [.helpCrossStep1, .helpCrossStep2, .helpCrossStep3],
                question: .helpCrossQuestion, answer: .helpCrossAnswer,
                // nonlocalized: a URL path slug, generated per language by the site
                guide: .localizedGuide(slug: "send-a-file-to-someone"))
        case .storedSend:
            return HelpTopic(
                steps: [.helpStoredSendStep1, .helpStoredSendStep2, .helpStoredSendStep3],
                question: .helpStoredSendQuestion, answer: .helpStoredSendAnswer,
                // nonlocalized: a URL path slug, generated per language by the site
                guide: .localizedGuide(slug: "push-to-cloud-pull-on-another-computer"))
        case .deviceInbox:
            return HelpTopic(
                steps: [.helpInboxStep1, .helpInboxStep2, .helpInboxStep3],
                question: .helpInboxQuestion, answer: .helpInboxAnswer,
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
                steps: [.helpAccountStep1, .helpAccountStep2, .helpAccountStep3],
                question: .helpAccountQuestion, answer: .helpAccountAnswer,
                guide: nil)
        case .storedReceive:
            return nil
        }
    }

    /// The URL a guide link opens, in the language the app is rendering.
    ///
    /// Mirrors the site's own rule (`web/src/lib/OfflinePage.svelte`): English
    /// lives at the root and every other language under its own prefix. The
    /// prefix is the *Relayium* language id — `zh`, not the `zh-Hans` that names
    /// the Apple resource directory — which is why it comes from `rawValue`
    /// rather than from `lproj`.
    public static func url(for guide: HelpGuide,
                           language: AppLanguage,
                           baseURL: URL = AppEnvironment.productionBaseURL) -> URL {
        switch guide {
        case let .localizedGuide(slug):
            let prefix = language == .en ? "" : language.rawValue + "/"
            // nonlocalized: a URL path, not user copy
            return baseURL.appendingPathComponent(prefix + "guides/" + slug)
        case let .englishPage(path):
            return baseURL.appendingPathComponent(path)
        }
    }
}
