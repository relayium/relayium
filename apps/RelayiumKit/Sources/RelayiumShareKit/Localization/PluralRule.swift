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
/// Rules are CLDR's integer rules for the two shipped languages. Only integers
/// are ever passed here — every plural in the product counts files, folders,
/// devices, downloads or whole days.
///
/// This used to carry rules for nine, and the reasoning above was written when
/// Arabic's six forms were the hard case. The seven frozen languages took their
/// rules with them to `apps/localization-archive/frozen-locales/`; restoring one
/// means restoring its `case` here as well as its catalog, because a language
/// with no rule would not compile rather than silently rendering `other`. The
/// deterministic-given-`AppLanguage` contract is unchanged and still the reason
/// this is Swift rather than a `.stringsdict`.
public enum PluralRule {
    /// The categories a language can actually produce. Used by the integrity
    /// tests to require exactly these forms in every catalog: an English catalog
    /// missing `one` is a bug the `other` fallback would otherwise hide.
    public static func categories(for language: AppLanguage) -> [PluralCategory] {
        switch language {
        case .zh:
            // No grammatical number. One form, always.
            return [.other]
        case .en:
            return [.one, .other]
        }
    }

    public static func category(for count: Int, language: AppLanguage) -> PluralCategory {
        switch language {
        case .zh:
            return .other
        case .en:
            return count == 1 ? .one : .other
        }
    }
}
