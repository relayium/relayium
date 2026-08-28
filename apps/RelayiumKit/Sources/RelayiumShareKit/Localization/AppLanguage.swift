import Foundation

/// The languages the Relayium clients ship, and nothing else.
///
/// Deliberately a closed enum rather than a `Locale`: the product contract is
/// "these two, with English as the fallback", and a type that can hold `fr-CA`
/// or `xh` invites a lookup that silently resolves to nothing. The two match the
/// web client's `LANGS` (`web/src/lib/i18n/types.ts`) one for one — adding a
/// language means adding it in both places, and `LocalizationIntegrityTests`
/// fails if the catalogs and this enum disagree.
///
/// The clients used to ship nine. Arabic, German, Spanish, French, Japanese,
/// Korean and Portuguese are no longer offered: their catalogs are frozen under
/// `apps/RelayiumKit/LocalizationArchive/frozen-locales/`, outside every build
/// target. That move is what removes them from the packaged bundle — `Package.swift` uses
/// `.process("Resources")`, so a catalog left beside `en.lproj` would ship no
/// matter what this enum said. Dropping the cases here is the other half: it is
/// what makes a user who asks for Japanese get English rather than a language
/// the app can name but has no words for.
///
/// The raw value is the *Relayium* language id, the same token the web uses, so
/// `zh` is Simplified Chinese. The Apple resource directory is `lproj`, which is
/// where that token becomes `zh-Hans` — the only place the two spellings differ,
/// and the reason both exist rather than one being derived at every call site.
public enum AppLanguage: String, CaseIterable, Sendable, Hashable {
    case en
    case zh

    /// The deterministic fallback. Every lookup that finds nothing in the asked
    /// language tries this one before it gives up, and `Package.swift` names the
    /// same language as `defaultLocalization`.
    public static let fallback: AppLanguage = .en

    /// The `.lproj` directory this language's catalog lives in.
    ///
    /// `zh` is `zh-Hans` because Apple's bundle machinery matches a user asking
    /// for `zh-Hans-CN` against `zh-Hans` and NOT against a bare `zh`.
    public var lproj: String {
        switch self {
        case .zh: return "zh-Hans"
        default:  return rawValue
        }
    }

    /// Written right-to-left. No shipped language is, since Arabic was frozen —
    /// English and Simplified Chinese both read left to right.
    ///
    /// Kept as a property rather than deleted, and kept load-bearing at its call
    /// sites, because it is the one home of the RTL rule. `RelayiumApp` and
    /// `ShareViewController` still derive each scene's `layoutDirection` from it
    /// and `L10n.token` still consults it before adding isolation markers; with
    /// this answering `false` those paths resolve to a left-to-right shell and a
    /// verbatim token, which is the required behaviour for both shipped
    /// languages *and* for every archived preference that now falls back to
    /// English. Restoring Arabic means restoring a `true` here, not rebuilding
    /// the plumbing that reads it.
    public var isRightToLeft: Bool { false }

    /// The locale used for number, percent, date and byte formatting.
    ///
    /// Regionless on purpose: the app localizes *language*, and pinning a region
    /// (`de-DE`) would be a claim about where the user is that nothing here
    /// knows. Foundation resolves a language-only identifier to that language's
    /// default region conventions, which is exactly the intent.
    public var locale: Locale { Locale(identifier: lproj) }

    /// Pick a language from an ordered list of BCP-47 preferences — the shape
    /// `Locale.preferredLanguages` and `Bundle.preferredLocalizations` hand back.
    ///
    /// Prefix matching on the language subtag, in the caller's order, so
    /// `zh-Hant-TW` and `zh-Hans-CN` both land on Simplified Chinese rather than
    /// falling through to English. A user who reads any Chinese is better served
    /// by the Chinese catalog than by English; a separate Traditional catalog is
    /// a product decision the web has not made either.
    ///
    /// Every other preference now reaches `fallback`, including the seven
    /// archived languages: `AppLanguage(rawValue: "ja")` is `nil` once the case
    /// is gone, so a Japanese-first Mac walks the rest of its preference list and
    /// otherwise renders English. That is the intended outcome and not a hole —
    /// English is complete, and there is no Japanese catalog in the bundle for a
    /// partial resolution to half-succeed against. The regional forms behave the
    /// same way: `de-AT` and `pt-BR` are English, `zh-Hant-HK` is Simplified
    /// Chinese.
    public static func resolve(preferred: [String]) -> AppLanguage {
        for tag in preferred {
            let subtag = tag.split(separator: "-").first.map { $0.lowercased() } ?? tag.lowercased()
            if let match = AppLanguage(rawValue: subtag) { return match }
        }
        return fallback
    }

    /// What this process should render in, resolved once from the OS.
    ///
    /// `Locale.preferredLanguages` rather than `Bundle.main.preferredLocalizations`:
    /// the copy lives in the package bundle, so the main bundle's localization
    /// list is the wrong question to ask — and under `swift test` there is no app
    /// bundle to ask at all.
    public static func systemPreferred() -> AppLanguage {
        resolve(preferred: Locale.preferredLanguages)
    }
}
