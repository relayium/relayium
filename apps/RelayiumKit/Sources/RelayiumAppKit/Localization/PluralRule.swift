import Foundation

/// CLDR plural categories, restricted to the ones integer counts can produce.
public enum PluralCategory: String, CaseIterable, Sendable {
    case zero, one, two, few, many, other
}

/// Which plural form a count takes, per language, decided in Swift.
///
/// Foundation can do this through `.stringsdict`, and that was the first choice.
/// It was dropped for one reason: `.stringsdict` expansion runs through
/// `String.localizedStringWithFormat`, which reads `Locale.current` — so the form
/// chosen would depend on the machine running the code rather than on the
/// language actually being rendered. This layer's whole contract is that a
/// lookup is deterministic given an explicit `AppLanguage`, and a plural that
/// quietly consults the host locale breaks it in exactly the case (Arabic, six
/// forms) where it matters most.
///
/// Rules are CLDR's integer rules for the nine shipped languages. Only integers
/// are ever passed here — every plural in the product counts files, folders,
/// devices, downloads or whole days.
public enum PluralRule {
    /// The categories a language can actually produce. Used by the integrity
    /// tests to require exactly these forms in every catalog: a missing `few` in
    /// Arabic is a bug the `other` fallback would otherwise hide.
    public static func categories(for language: AppLanguage) -> [PluralCategory] {
        switch language {
        case .zh, .ja, .ko:
            // No grammatical number. One form, always.
            return [.other]
        case .en, .de, .es:
            return [.one, .other]
        case .fr, .pt:
            // CLDR: `one` covers 0 and 1 — "0 fichier", "0 ficheiro".
            return [.one, .other]
        case .ar:
            return [.zero, .one, .two, .few, .many, .other]
        }
    }

    public static func category(for count: Int, language: AppLanguage) -> PluralCategory {
        switch language {
        case .zh, .ja, .ko:
            return .other
        case .en, .de, .es:
            return count == 1 ? .one : .other
        case .fr, .pt:
            return (count == 0 || count == 1) ? .one : .other
        case .ar:
            let magnitude = abs(count)
            if magnitude == 0 { return .zero }
            if magnitude == 1 { return .one }
            if magnitude == 2 { return .two }
            let mod100 = magnitude % 100
            if (3...10).contains(mod100) { return .few }
            if (11...99).contains(mod100) { return .many }
            return .other
        }
    }
}
