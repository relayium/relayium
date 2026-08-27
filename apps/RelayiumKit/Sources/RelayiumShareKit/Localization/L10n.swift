import Foundation

/// The one way anything in Relayium turns a key into words.
///
/// Views, view models and `ErrorCopy` all come through here. Nothing else in the
/// package or in the macOS app calls `NSLocalizedString`, reads `Bundle.module`
/// directly, or writes a user-facing English literal — `LocalizationSourceGuardTests`
/// fails the build if that changes.
///
/// Every entry point takes an optional explicit `language`. That is not a
/// convenience: it is what makes the localization testable at all. With it, a
/// test can assert the Simplified Chinese wording of a transfer failure on a
/// machine set to English. Without it, every assertion would be a statement
/// about the CI runner's settings.
///
/// ## Numbers, percentages, bytes, dates
///
/// Counts and byte figures render with **Latin digits and a locale-appropriate
/// decimal separator**, which is what the web client already produces and what a
/// technical transfer UI wants — a size next to a `KB` symbol reads worse in
/// non-Latin digits than it does in Latin ones. Dates are the exception and
/// go through `DateFormatter` with the language's own `Locale`, because a date
/// is prose, not a measurement, and Foundation's formats for it are correct in a
/// way a hand-rolled one would not be.
public enum L10n {

    // MARK: - The active language

    private static let lock = NSLock()
    nonisolated(unsafe) private static var override: AppLanguage?
    nonisolated(unsafe) private static var resolved: AppLanguage?

    /// What a call with no explicit `language:` renders in.
    ///
    /// Resolved once from `Locale.preferredLanguages`, and settable so a preview,
    /// a harness or a future in-app language picker can drive it. Reading it is
    /// cheap after the first call.
    public static var current: AppLanguage {
        get {
            lock.lock()
            defer { lock.unlock() }
            if let override { return override }
            if let resolved { return resolved }
            let value = AppLanguage.systemPreferred()
            resolved = value
            return value
        }
        set {
            lock.lock()
            override = newValue
            lock.unlock()
        }
    }

    /// Drop an override and go back to what the OS asks for.
    public static func resetCurrent() {
        lock.lock()
        override = nil
        resolved = nil
        lock.unlock()
    }

    // MARK: - Lookup

    /// A string with no substitutions.
    public static func t(_ key: L10nKey, language: AppLanguage? = nil) -> String {
        LocalizationCatalog.shared.string(key.rawValue, language: language ?? current)
    }

    /// A string with substitutions.
    ///
    /// Arguments are always `String`s, already formatted by the helpers below.
    /// One placeholder type across the whole catalog means a translator cannot
    /// turn `%lld` into `%@` and crash the app, and it makes the
    /// placeholder-signature check in the integrity tests exact rather than
    /// approximate.
    ///
    /// Substituted values that are technical (a file name, a path, a pairing
    /// code, an HTTP status) should be wrapped in `token(_:language:)` by the
    /// caller so they keep their reading order inside a right-to-left sentence.
    /// No shipped language is right-to-left today, so that wrapper is currently
    /// a no-op — keep using it anyway; see `token(_:language:)`.
    public static func t(_ key: L10nKey,
                         _ args: [String],
                         language: AppLanguage? = nil) -> String {
        let lang = language ?? current
        let template = LocalizationCatalog.shared.string(key.rawValue, language: lang)
        return String(format: template, arguments: args.map { $0 as CVarArg })
    }

    /// A count-dependent string. The count is substituted for `%@` already
    /// formatted, so a catalog entry never has to know how digits are written.
    public static func plural(_ key: PluralKey,
                              _ count: Int,
                              language: AppLanguage? = nil) -> String {
        let lang = language ?? current
        let category = PluralRule.category(for: count, language: lang)
        let catalog = LocalizationCatalog.shared
        // Asked language's own form, then its `other`, then English's form, then
        // English's `other`. A translator who omitted a category gets a
        // grammatically imperfect string rather than a raw key on screen. With
        // only `en` and `zh` shipped the chain rarely goes past its first step,
        // but it is what keeps a restored language safe while it is incomplete.
        let template = catalog.rawValue(key.key(category), language: lang)
            ?? catalog.rawValue(key.key(.other), language: lang)
            ?? catalog.rawValue(key.key(PluralRule.category(for: count, language: .fallback)),
                                language: .fallback)
            ?? catalog.rawValue(key.key(.other), language: .fallback)
            ?? key.rawValue
        return String(format: template, number(count, language: lang) as CVarArg)
    }

    // MARK: - Technical values inside localized prose

    /// U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE.
    private static let isolateStart = "\u{2068}"
    private static let isolateEnd = "\u{2069}"

    /// Wrap a value that must keep its own reading order.
    ///
    /// A file name, a path, an HTTP status, a pairing code or a URL dropped into
    /// an Arabic sentence is laid out by the Unicode bidi algorithm against the
    /// surrounding right-to-left text, which can move a leading `../` to the far
    /// end of the name or split `error (503)` across the sentence. An isolate
    /// tells the algorithm to resolve the run on its own and place it as a single
    /// neutral unit, which is exactly the guarantee wanted: the returned string
    /// carries the two isolate markers around the value, and the value itself is
    /// reproduced verbatim between them, so what is displayed is still the value
    /// the user can act on.
    ///
    /// A no-op for left-to-right languages, so English output is byte-identical
    /// to what it was before localization.
    ///
    /// **Every shipped language now takes that no-op branch.** Arabic was the
    /// only right-to-left catalog and it is frozen, so `isRightToLeft` answers
    /// `false` throughout and this returns the value unchanged for `en` and `zh`
    /// alike. The wrapping branch is deliberately kept rather than deleted: it is
    /// the correct behaviour the moment an RTL language returns, and the call
    /// sites that already route technical values through here — file names,
    /// paths, statuses, pairing codes, the SAS — are what make that restoration a
    /// one-line change instead of an audit. Its cost while dormant is one boolean
    /// check per token, and `LocalizedCopyTests` still pins the verbatim result.
    public static func token(_ value: String, language: AppLanguage? = nil) -> String {
        guard (language ?? current).isRightToLeft else { return value }
        return isolateStart + value + isolateEnd
    }

    // MARK: - Number, percent, byte and date presentation

    /// The decimal separator, by language.
    ///
    /// An explicit table rather than `Locale.decimalSeparator` on purpose: this
    /// layer's contract is that output depends on the `AppLanguage` argument and
    /// on nothing else, and ICU data can differ between OS versions. Two
    /// languages is a table small enough to read.
    ///
    /// Both shipped languages use a dot. The comma branch left with the seven
    /// frozen European catalogs; restoring one means restoring its row here, and
    /// the switch is exhaustive so the compiler will say so.
    static func decimalSeparator(for language: AppLanguage) -> String {
        switch language {
        case .en, .zh: return "."
        }
    }

    /// An integer, in Latin digits and without grouping.
    ///
    /// Ungrouped deliberately: every number this renders is a count of files,
    /// folders, downloads or days, and the grouped form of a three-digit count
    /// is noise. Byte figures carry their own unit and never reach four digits.
    public static func number(_ value: Int, language: AppLanguage? = nil) -> String {
        String(value)
    }

    /// A whole-number percentage, positioned by the catalog.
    public static func percent(_ value: Int, language: AppLanguage? = nil) -> String {
        t(.formatPercent, [number(value, language: language)], language: language)
    }

    /// Progress as a percentage, or `nil` while the total is unknown.
    public static func percent(done: Int, total: Int, language: AppLanguage? = nil) -> String? {
        guard total > 0 else { return nil }
        return percent(done * 100 / total, language: language)
    }

    /// Binary byte units. The unit symbols are technical and never translated;
    /// the separator and the number/unit order come from the catalog.
    public static func bytes(_ n: Int64, language: AppLanguage? = nil) -> String {
        let lang = language ?? current
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = Double(n)
        var unit = 0
        while value >= 1024 && unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        let text: String
        if unit == 0 {
            text = String(n)
        } else {
            // `%.1f` in the C locale, then the separator this language writes.
            text = String(format: "%.1f", value)
                .replacingOccurrences(of: ".", with: decimalSeparator(for: lang))
        }
        return t(.formatBytes, [text, units[unit]], language: lang)
    }

    /// A date, formatted by Foundation in the rendered language.
    public static func date(_ date: Date,
                            dateStyle: DateFormatter.Style,
                            timeStyle: DateFormatter.Style,
                            language: AppLanguage? = nil) -> String {
        let lang = language ?? current
        let formatter = DateFormatter()
        formatter.locale = lang.locale
        formatter.dateStyle = dateStyle
        formatter.timeStyle = timeStyle
        return formatter.string(from: date)
    }

    /// Two detail fragments joined the way the whole product joins them.
    public static func detail(_ parts: [String], language: AppLanguage? = nil) -> String {
        guard var joined = parts.first else { return "" }
        for part in parts.dropFirst() {
            joined = t(.formatDetailPair, [joined, part], language: language)
        }
        return joined
    }
}
